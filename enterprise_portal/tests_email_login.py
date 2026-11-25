import re
from concurrent.futures import ThreadPoolExecutor
from datetime import timedelta
from unittest.mock import patch
from django.contrib.auth import get_user_model
from django.core import mail
from django.db import connection, close_old_connections
from django.test import Client, TestCase, TransactionTestCase, override_settings
from django.utils import timezone
from .email_login import VERIFIED, fingerprint
from .models import EmailLoginChallenge


@override_settings(ENTERPRISE_LOGIN_MAIL_TEST_BACKEND="django.core.mail.backends.locmem.EmailBackend")
class EmailLoginTests(TestCase):
    def setUp(self):
        self.user = get_user_model().objects.create_user("synthetic", email="synthetic@example.invalid", password="Synthetic-password-918!")
        self.client = Client()

    def password(self, client=None):
        return (client or self.client).post("/accounts/login/?next=/enterprise/", {"username": self.user.username, "password": "Synthetic-password-918!"}, HTTP_ACCEPT="application/json")

    def code(self):
        return re.search(r"\b([0-9]{6})\b", mail.outbox[-1].body).group(1)

    def verify(self, code=None, client=None):
        return (client or self.client).post("/accounts/login/", {"action": "verify", "code": code or self.code()}, HTTP_ACCEPT="application/json")

    def verified_session(self, user=None, client=None):
        user = user or self.user
        client = client or self.client
        client.force_login(user)
        session = client.session; session[VERIFIED] = fingerprint(user); session.save()

    def test_password_never_mints_session_and_only_bound_recipient_is_used(self):
        wrong = self.client.post("/accounts/login/", {"username": self.user.username, "password": "wrong"}, HTTP_ACCEPT="application/json")
        self.assertEqual(wrong.status_code, 400)
        self.assertFalse(getattr(mail, "outbox", []))
        self.assertEqual(self.password().status_code, 202)
        self.assertNotIn("_auth_user_id", self.client.session)
        self.assertEqual(mail.outbox[-1].to, [self.user.email])
        self.assertEqual(self.client.get("/enterprise/capabilities/").status_code, 302)
        row = EmailLoginChallenge.objects.get(user=self.user)
        self.assertNotIn(self.code(), row.code_digest)
        self.assertEqual(self.verify().status_code, 302)
        self.assertEqual(self.client.get("/enterprise/capabilities/").json()["authentication"], {"email_verified": True})
        self.assertEqual(self.verify().status_code, 400)

    def test_recipient_override_is_rejected_without_sending(self):
        response = self.client.post("/accounts/login/", {"username": self.user.username, "password": "Synthetic-password-918!", "email": "other@example.invalid"}, HTTP_ACCEPT="application/json")
        self.assertEqual(response.status_code, 400)
        self.assertFalse(getattr(mail, "outbox", []))

    def test_old_session_and_admin_password_bypass_denied(self):
        self.client.force_login(self.user)
        self.assertEqual(self.client.get("/enterprise/capabilities/").status_code, 302)
        self.assertNotIn("_auth_user_id", self.client.session)
        response = self.client.post("/admin/login/", {"username": self.user.username, "password": "Synthetic-password-918!"})
        self.assertEqual(response.status_code, 302)
        self.assertTrue(response.url.startswith("/accounts/login/"))
        self.assertNotIn("_auth_user_id", self.client.session)

    def test_five_attempts_expiry_and_cross_session_replay(self):
        self.password(); correct = self.code()
        self.assertEqual(self.verify(correct, Client()).status_code, 400)
        wrong = "000000" if correct != "000000" else "111111"
        for _ in range(5): self.assertEqual(self.verify(wrong).status_code, 400)
        self.assertEqual(EmailLoginChallenge.objects.get(user=self.user).attempts_left, 0)
        self.assertEqual(self.verify(correct).status_code, 400)
        EmailLoginChallenge.objects.filter(user=self.user).update(attempts_left=5, expires_at=timezone.now()-timedelta(seconds=1))
        self.assertEqual(self.verify(correct).status_code, 400)

    def test_mail_failure_rolls_back_and_missing_email_does_not_lock_admin_maintenance(self):
        with patch("enterprise_portal.login_mail.send_code", side_effect=RuntimeError("private smtp failure")):
            result = self.password()
        self.assertEqual(result.status_code, 400)
        self.assertNotContains(result, "private smtp failure", status_code=400)
        self.assertFalse(EmailLoginChallenge.objects.exists())
        self.user.email = ""; self.user.save()
        self.assertIn("绑定", self.password().json()["error"])
        self.assertNotIn("_auth_user_id", self.client.session)

    def test_resend_cooldown_hourly_limit_and_old_code_invalidated(self):
        self.password(); first = self.code()
        self.assertEqual(self.client.post("/accounts/login/", {"action": "resend"}, HTTP_ACCEPT="application/json").status_code, 400)
        EmailLoginChallenge.objects.filter(user=self.user).update(last_sent_at=timezone.now()-timedelta(seconds=61))
        self.assertEqual(self.client.post("/accounts/login/", {"action": "resend"}, HTTP_ACCEPT="application/json").status_code, 202)
        self.assertEqual(len(mail.outbox), 2)
        if first != self.code(): self.assertEqual(self.verify(first).status_code, 400)
        EmailLoginChallenge.objects.filter(user=self.user).update(last_sent_at=timezone.now()-timedelta(seconds=61), sends_in_window=5)
        self.assertEqual(self.password().status_code, 400)
        self.assertEqual(len(mail.outbox), 2)

    def test_account_changes_invalidate_pending_code_and_verified_session(self):
        for field, value in [("email", "changed@example.invalid"), ("is_active", False), ("password", "changed")]:
            with self.subTest(field=field):
                self.user.email = "synthetic@example.invalid"; self.user.is_active = True
                self.user.set_password("Synthetic-password-918!"); self.user.save()
                EmailLoginChallenge.objects.all().delete(); self.client = Client(); self.password(); correct = self.code()
                setattr(self.user, field, value); self.user.save()
                self.assertEqual(self.verify(correct).status_code, 400)
        self.user.is_active = True; self.user.save(); self.verified_session()
        self.user.email = "again@example.invalid"; self.user.save()
        self.assertEqual(self.client.get("/enterprise/capabilities/").status_code, 302)

    def test_failed_new_password_keeps_existing_verified_session(self):
        self.password(); self.verify()
        self.client.post("/accounts/login/", {"username": self.user.username, "password": "wrong"}, HTTP_ACCEPT="application/json")
        self.assertEqual(self.client.get("/enterprise/capabilities/").status_code, 200)

    def test_only_admin_can_bind_email_without_changing_roles(self):
        self.verified_session()
        self.assertEqual(self.client.get("/enterprise/console/login-security/").status_code, 403)
        admin = get_user_model().objects.create_superuser("synthetic-admin", "admin@example.invalid", "Synthetic-admin-password-918!")
        self.verified_session(admin)
        before = (self.user.password, self.user.is_staff, self.user.is_superuser, self.user.is_active)
        response = self.client.post("/enterprise/console/login-security/", {"action": "email", "username": self.user.username, "email": "new@example.invalid"})
        self.assertEqual(response.status_code, 200)
        self.user.refresh_from_db()
        self.assertEqual(self.user.email, "synthetic@example.invalid")
        code = re.search(r"：([0-9]{8})", mail.outbox[-1].body).group(1)
        verified = self.client.post("/enterprise/console/login-security/", {"action": "email-verify", "username": self.user.username, "code": code})
        self.assertEqual(verified.status_code, 302)
        self.user.refresh_from_db()
        self.assertEqual(self.user.email, "new@example.invalid")
        self.assertEqual(before, (self.user.password, self.user.is_staff, self.user.is_superuser, self.user.is_active))

    def test_smtp_password_is_never_echoed(self):
        admin = get_user_model().objects.create_superuser("smtp-admin", "admin@example.invalid", "Synthetic-admin-password-918!")
        self.verified_session(admin)
        secret = "SYNTHETIC-SMTP-SECRET-918"
        payload = {"action": "smtp", "host": "smtp.example.invalid", "port": 465, "security": "ssl", "username": "sender@example.invalid", "password": secret, "from_email": "sender@example.invalid"}
        with patch("enterprise_portal.login_mail.configure", side_effect=RuntimeError(secret)), patch("enterprise_portal.login_mail.configured", return_value=False):
            response = self.client.post("/enterprise/console/login-security/", payload)
        self.assertEqual(response.status_code, 200)
        self.assertNotContains(response, secret)


    def test_smtp_locked_view_and_replacement_flow(self):
        admin = get_user_model().objects.create_superuser(
            "smtp-reset-admin", "admin@example.invalid", "Synthetic-admin-password-918!",
        )
        self.verified_session(admin)
        url = "/enterprise/console/login-security/"
        old = {"smtp_configured": True, "smtp_from_email": "first@example.invalid"}
        new = {"smtp_configured": True, "smtp_from_email": "second@example.invalid"}
        state = dict(old)
        fields = {"host": "smtp.example.invalid", "port": 465, "security": "ssl",
                  "username": "synthetic-user", "password": "synthetic-secret",
                  "from_email": new["smtp_from_email"]}

        def save(config, *, replace=False):
            if not replace:
                raise ValueError("explicit replacement required")
            state["smtp_from_email"] = config["from_email"]

        with patch("enterprise_portal.login_mail.configuration_status", side_effect=lambda: dict(state)), \
                patch("enterprise_portal.login_mail.configure", side_effect=save):
            response = self.client.get(url)
            self.assertContains(response, "<fieldset disabled>")
            self.assertContains(response, old["smtp_from_email"])
            self.assertContains(response, "已填写", count=5)
            self.assertNotContains(response, 'name="password"')

            response = self.client.get(url, {"smtp": "reset"})
            self.assertContains(response, 'value="smtp-replace"')
            self.assertNotContains(response, old["smtp_from_email"])
            self.assertEqual(state, old)

            response = self.client.post(url, {"action": "smtp", **fields})
            self.assertContains(response, old["smtp_from_email"])
            self.assertNotContains(response, fields["username"])
            self.assertNotContains(response, fields["password"])
            self.assertEqual(state, old)

            response = self.client.post(url, {"action": "smtp-replace", **fields, "port": 0})
            self.assertContains(response, 'value="smtp-replace"')
            self.assertNotContains(response, fields["host"])
            self.assertNotContains(response, fields["username"])
            self.assertNotContains(response, fields["password"])
            self.assertEqual(state, old)

            response = self.client.post(url, {"action": "smtp-replace", **fields}, follow=True)
            self.assertContains(response, new["smtp_from_email"])
            self.assertContains(response, "<fieldset disabled>")
            self.assertEqual(state, new)


@override_settings(ENTERPRISE_LOGIN_MAIL_TEST_BACKEND="django.core.mail.backends.locmem.EmailBackend")
class ConcurrentEmailLoginTests(TransactionTestCase):
    def test_only_one_concurrent_issue_and_consume(self):
        if connection.vendor != "postgresql": self.skipTest("Row-lock concurrency requires PostgreSQL")
        from .email_login import start_challenge, consume
        user = get_user_model().objects.create_user("concurrent", email="concurrent@example.invalid", password="Synthetic-password-918!")
        def issue(_):
            close_old_connections()
            try: return start_challenge(get_user_model().objects.get(pk=user.pk))
            except ValueError: return None
            finally: close_old_connections()
        with ThreadPoolExecutor(2) as pool: tokens = list(pool.map(issue, range(2)))
        self.assertEqual(sum(bool(x) for x in tokens), 1)
        token = next(x for x in tokens if x)
        code = re.search(r"\b([0-9]{6})\b", mail.outbox[-1].body).group(1)
        def verify(_):
            close_old_connections()
            try: consume(token, code); return True
            except ValueError: return False
            finally: close_old_connections()
        with ThreadPoolExecutor(2) as pool: results = list(pool.map(verify, range(2)))
        self.assertEqual(sum(results), 1)
