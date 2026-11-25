import re
from concurrent.futures import ThreadPoolExecutor
from datetime import timedelta
from unittest.mock import patch

from django.contrib.auth import get_user_model
from django.core import mail
from django.db import close_old_connections, connection
from django.test import Client, TransactionTestCase, override_settings
from django.utils import timezone

from .email_binding import confirm_binding, prepare_initial_binding, start_binding
from .models import EmailBindingChallenge, EmailLoginChallenge
from .testing import EmailVerifiedTestCase


LOCAL_MAIL = "django.core.mail.backends.locmem.EmailBackend"
SECURITY = "/enterprise/console/login-security/"
LOGIN = "/accounts/login/"


def binding_code():
    return re.search(r"：([0-9]{8})", mail.outbox[-1].body).group(1)


@override_settings(ENTERPRISE_LOGIN_MAIL_TEST_BACKEND=LOCAL_MAIL)
class EmailBindingTests(EmailVerifiedTestCase):
    def setUp(self):
        super().setUp()
        self.password = "Synthetic-login-918!"
        users = get_user_model()
        self.user = users.objects.create_user("binding-target", "old@example.invalid", self.password)
        self.admin = users.objects.create_superuser("binding-admin", "admin@example.invalid", self.password)
        self.client.force_login(self.admin)

    def test_legacy_login_stays_valid_until_atomic_verified_replacement(self):
        old_login = Client()
        response = old_login.post(LOGIN, {"username": self.user.username, "password": self.password})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(mail.outbox[-1].to, ["old@example.invalid"])
        login_code = re.search(r"：([0-9]{6})", mail.outbox[-1].body).group(1)

        data = {"username": self.user.username, "email": "new@example.invalid"}
        response = self.client.post(SECURITY, {"action": "email-start", **data})
        self.assertContains(response, "已发送绑定验证码")
        self.assertEqual(mail.outbox[-1].to, ["new@example.invalid"])
        code = binding_code()
        self.assertNotIn(code, EmailBindingChallenge.objects.get(user=self.user).code_digest)
        self.user.refresh_from_db()
        self.assertEqual(self.user.email, "old@example.invalid")
        self.assertEqual(old_login.post(LOGIN, {"action": "verify", "code": login_code}).status_code, 302)
        self.assertEqual(old_login.get("/enterprise/").status_code, 200)
        with self.assertRaises(ValueError):
            confirm_binding(self.user.username, login_code)

        response = self.client.post(SECURITY, {"action": "email-verify", "username": self.user.username, "code": code})
        self.assertEqual(response.status_code, 302)
        self.assertNotContains(self.client.get(SECURITY), code)
        self.user.refresh_from_db()
        self.assertEqual(self.user.email, "new@example.invalid")
        self.assertEqual(old_login.get("/enterprise/").status_code, 302)
        self.assertFalse(EmailLoginChallenge.objects.get(user=self.user).code_digest)
        with self.assertRaises(ValueError):
            confirm_binding(self.user.username, code)

    def test_first_address_is_pending_until_verified_and_still_needs_login_otp(self):
        user = get_user_model().objects.create_user("binding-first", "", self.password)
        prepare_initial_binding(user, "first@example.invalid")
        client = Client()
        self.assertContains(client.post(LOGIN, {"username": user.username, "password": self.password}),
                            "尚未绑定有效邮箱")
        self.assertFalse(getattr(mail, "outbox", []))
        start_binding(user.username)
        confirm_binding(user.username, binding_code())
        self.assertEqual(client.get("/enterprise/").status_code, 302)
        client.post(LOGIN, {"username": user.username, "password": self.password})
        self.assertEqual(mail.outbox[-1].to, ["first@example.invalid"])
        login_code = re.search(r"：([0-9]{6})", mail.outbox[-1].body).group(1)
        self.assertEqual(client.post(LOGIN, {"action": "verify", "code": login_code}).status_code, 302)
        self.assertEqual(client.get("/enterprise/").status_code, 200)

    def test_attempt_limit_expiration_resend_and_smtp_failure_preserve_old_email(self):
        start_binding(self.user.username, "new@example.invalid")
        first_code = binding_code()
        with self.assertRaisesMessage(ValueError, "60 秒"):
            start_binding(self.user.username)
        invalid = "00000000" if first_code != "00000000" else "99999999"
        for _ in range(5):
            with self.assertRaisesMessage(ValueError, "不正确"):
                confirm_binding(self.user.username, invalid)
        with self.assertRaisesMessage(ValueError, "失效"):
            confirm_binding(self.user.username, first_code)
        row = EmailBindingChallenge.objects.get(user=self.user)
        self.assertEqual(row.attempts_left, 0)
        row.last_sent_at = timezone.now() - timedelta(seconds=61)
        row.save(update_fields=["last_sent_at"])
        with patch("enterprise_portal.login_mail.send_binding_code", side_effect=OSError("private-details")):
            with self.assertRaisesMessage(ValueError, "暂时无法发送"):
                start_binding(self.user.username, "other@example.invalid")
        row.refresh_from_db()
        self.assertEqual(row.email, "new@example.invalid")
        self.assertEqual(row.sends_in_window, 1)
        start_binding(self.user.username)
        row.refresh_from_db()
        row.expires_at = timezone.now() - timedelta(seconds=1)
        row.save(update_fields=["expires_at"])
        with self.assertRaisesMessage(ValueError, "失效"):
            confirm_binding(self.user.username, binding_code())
        self.user.refresh_from_db()
        self.assertEqual(self.user.email, "old@example.invalid")

    def test_ordinary_account_cannot_send_or_consume_binding_codes(self):
        self.client.force_login(self.user)
        for action, data in (
            ("email-start", {"email": "new@example.invalid"}),
            ("email-resend", {}),
            ("email-verify", {"code": "12345678"}),
        ):
            self.assertEqual(self.client.post(SECURITY, {
                "action": action, "username": self.user.username, **data,
            }).status_code, 403)
        self.assertFalse(EmailBindingChallenge.objects.filter(user=self.user).exists())

    def test_django_admin_email_field_is_readonly(self):
        from django.contrib import admin
        fields = admin.site.get_model_admin(get_user_model()).readonly_fields
        self.assertIn("email", fields)


@override_settings(ENTERPRISE_LOGIN_MAIL_TEST_BACKEND=LOCAL_MAIL)
class ConcurrentEmailBindingTests(TransactionTestCase):
    def test_postgres_concurrent_issuance_and_consumption_each_succeed_once(self):
        if connection.vendor != "postgresql":
            self.skipTest("PostgreSQL row locks required.")
        user = get_user_model().objects.create_user("concurrent-binding", "old@example.invalid", "Synthetic-binding-918!")

        def twice(operation):
            def run(_):
                close_old_connections()
                try:
                    operation()
                    return True
                except ValueError:
                    return False
                finally:
                    close_old_connections()
            with ThreadPoolExecutor(max_workers=2) as pool:
                return list(pool.map(run, range(2)))

        self.assertEqual(twice(lambda: start_binding(user.username, "new@example.invalid")).count(True), 1)
        code = binding_code()
        self.assertEqual(twice(lambda: confirm_binding(user.username, code)).count(True), 1)
        user.refresh_from_db()
        self.assertEqual(user.email, "new@example.invalid")
