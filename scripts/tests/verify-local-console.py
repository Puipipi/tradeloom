"""Isolated real-DPAPI + SQLite protocol checks; never uses installed accounts."""
import json
import os
import tempfile
import unittest
from datetime import timedelta
from pathlib import Path

os.environ["DJANGO_SETTINGS_MODULE"] = "config.enterprise_settings"
temporary = tempfile.TemporaryDirectory(prefix="tl-local-console-")
root = Path(temporary.name)
(root / "secrets").mkdir()
(root / "app").mkdir()
os.environ["TRADELOOM_ENTERPRISE_DATA_ROOT"] = str(root)
(root / "server-config.json").write_text(json.dumps({"app_root": str(root / "app"), "http_port": 27417}))

from django.conf import settings
settings.configure(
    SECRET_KEY="synthetic-local-console-test-key-123456789", BASE_DIR=root / "app",
    INSTALLED_APPS=["django.contrib.auth", "django.contrib.contenttypes", "django.contrib.sessions", "enterprise_portal", "workbench"],
    DATABASES={"default": {"ENGINE": "django.db.backends.sqlite3", "NAME": str(root / "qa.sqlite3")}},
    ROOT_URLCONF="enterprise_portal.local_console_urls", ALLOWED_HOSTS=["127.0.0.1"],
    MIDDLEWARE=["django.contrib.sessions.middleware.SessionMiddleware", "django.middleware.csrf.CsrfViewMiddleware", "django.contrib.auth.middleware.AuthenticationMiddleware", "enterprise_portal.local_console_middleware.LocalConsoleSessionMiddleware"],
    TEMPLATES=[{"BACKEND": "django.template.backends.django.DjangoTemplates", "APP_DIRS": True}],
    USE_TZ=True, CSRF_COOKIE_HTTPONLY=True,
)
import django
django.setup()
from django.contrib.auth.models import User, Group, Permission
from django.contrib.contenttypes.models import ContentType
from django.contrib.sessions.models import Session
from django.db import connection
from django.test import Client, override_settings
from django.utils import timezone
from enterprise_portal import local_console as lc

with connection.schema_editor() as schema:
    for model in (ContentType, Permission, Group, User, Session):
        schema.create_model(model)
content = ContentType.objects.create(app_label="enterprise_portal", model="enterpriseentry")
Permission.objects.create(content_type=content, codename="use_server_operations", name="Synthetic operations")


class LocalConsoleChecks(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        lc.enable()

    def test_dpapi_roundtrip_and_reject_plaintext(self):
        raw = b"synthetic-not-a-production-secret"
        protected = lc.dpapi(raw, protect=True)
        self.assertNotIn(raw, protected)
        self.assertEqual(lc.dpapi(protected, protect=False), raw)
        with self.assertRaises(lc.LocalConsoleUnavailable):
            lc.dpapi(raw, protect=False)

    def test_nonce_hash_single_use_and_tech_scope(self):
        token, _ = lc.issue()
        row = Session.objects.get(session_key=lc.grant_key(token))
        self.assertNotIn(token, row.session_data)
        self.assertLessEqual((row.expire_date - timezone.now()).total_seconds(), 60)
        user = lc.consume(token)
        self.assertFalse(user.has_usable_password())
        self.assertFalse(user.is_staff or user.is_superuser)
        self.assertEqual(user.get_all_permissions(), {"enterprise_portal.use_server_operations"})
        with self.assertRaises(lc.LocalConsoleUnavailable): lc.consume(token)

    def test_expired_grant_rejected(self):
        token, _ = lc.issue()
        Session.objects.filter(session_key=lc.grant_key(token)).update(expire_date=timezone.now() - timedelta(seconds=1))
        with self.assertRaises(lc.LocalConsoleUnavailable): lc.consume(token)

    def test_https_never_issues_or_redeems(self):
        with override_settings(SESSION_COOKIE_SECURE=True, SECURE_SSL_REDIRECT=True):
            with self.assertRaises(lc.LocalConsoleUnavailable): lc.issue()
            self.assertEqual(self.client().get("/enterprise/local-console/").status_code, 403)

    def client(self):
        return Client(enforce_csrf_checks=True, HTTP_HOST="127.0.0.1:27417", REMOTE_ADDR="127.0.0.1")

    def test_csrf_cookie_session_and_replay(self):
        client = self.client()
        token, _ = lc.issue()
        self.assertEqual(client.post("/enterprise/local-console/redeem/", {"grant": token}, HTTP_ORIGIN="http://127.0.0.1:27417").status_code, 403)
        response = client.get("/enterprise/local-console/")
        self.assertEqual(response.status_code, 200)
        self.assertIn("no-store", response["Cache-Control"])
        self.assertEqual(response["Referrer-Policy"], "no-referrer")
        self.assertLess(response.content.index(b"history.replaceState"), response.content.index(b"fetch("))
        csrf = client.cookies["csrftoken"].value
        data = {"grant": token, "csrfmiddlewaretoken": csrf}
        response = client.post("/enterprise/local-console/redeem/", data, HTTP_ORIGIN="http://127.0.0.1:27417")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(client.session["_auth_user_backend"], "django.contrib.auth.backends.ModelBackend")
        self.assertIn("_tradeloom_local_console", client.session)
        self.assertEqual(client.session.get_expiry_age(), 900)
        self.assertEqual(client.get("/enterprise/local-console/", HTTP_X_FORWARDED_FOR="192.0.2.1").status_code, 403)
        self.assertNotIn("_auth_user_id", client.session)
        self.assertNotIn("_tradeloom_local_console", client.session)
        self.assertEqual(client.get("/enterprise/local-console/").status_code, 200)
        self.assertEqual(client.get("/enterprise/local-console/", REMOTE_ADDR="192.0.2.1").status_code, 403)
        self.assertEqual(client.post("/enterprise/local-console/redeem/", {"grant": token, "csrfmiddlewaretoken": client.cookies["csrftoken"].value}, HTTP_ORIGIN="http://127.0.0.1:27417").status_code, 403)

    def test_remote_forwarded_and_cross_origin_rejected(self):
        for headers in ({"REMOTE_ADDR": "192.0.2.1"}, {"HTTP_X_FORWARDED_FOR": "192.0.2.1"},
                        {"HTTP_FORWARDED": "for=192.0.2.1"}, {"HTTP_HOST": "evil.example"},
                        {"HTTP_SEC_FETCH_SITE": "cross-site"}):
            self.assertIn(self.client().get("/enterprise/local-console/", **headers).status_code, (400, 403))

    def test_changed_technician_rejected(self):
        value, _ = lc.issuer()
        user = User.objects.get(pk=value["user_id"])
        user.is_staff = True
        user.save()
        try:
            with self.assertRaises(lc.LocalConsoleUnavailable): lc.issue()
        finally:
            user.is_staff = False
            user.save()

    def test_normal_session_unaffected_and_deleted_identity_graceful(self):
        # The boundary applies only to locally minted sessions.
        from django.test import RequestFactory
        from django.http import HttpResponse
        from enterprise_portal.local_console_middleware import LocalConsoleSessionMiddleware
        request = RequestFactory().get("/", REMOTE_ADDR="192.0.2.1")
        request.session = {}
        self.assertEqual(LocalConsoleSessionMiddleware(lambda _: HttpResponse("ok"))(request).status_code, 200)
        with self.assertRaises(lc.LocalConsoleUnavailable):
            lc.technician({"user_id": -1, "username": "missing-synthetic-user"})


try:
    result = unittest.TextTestRunner(verbosity=2).run(unittest.defaultTestLoader.loadTestsFromTestCase(LocalConsoleChecks))
finally:
    connection.close()
    temporary.cleanup()
raise SystemExit(0 if result.wasSuccessful() else 1)
