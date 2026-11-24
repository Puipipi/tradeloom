"""Synthetic-only tests; runnable without a database via unittest."""
import json
import os
from pathlib import Path
import tempfile
import types
import unittest
from unittest.mock import Mock, patch

from django.conf import settings
if not settings.configured:
    settings.configure(SECRET_KEY="synthetic-operations-test-only", DEFAULT_CHARSET="utf-8", LOGIN_URL="/login/", USE_I18N=False,
                       DATABASES={"default": {"ENGINE": "django.db.backends.sqlite3", "NAME": ":memory:"}})
    import django
    django.setup()

from django.test import RequestFactory
from . import operations, operations_views
from .operations_store import CredentialStore, StoreUnavailable, SLOTS


class OperationsTests(unittest.TestCase):
    def setUp(self):
        self.factory = RequestFactory()
        self.user = Mock(is_authenticated=True, is_active=True, pk=7)
        self.user.has_perm.return_value = False
        self.policy = types.ModuleType("enterprise_portal.policy")
        self.policy.is_enterprise_owner = lambda user: False
        self.policy.capability_policy = lambda user: {"server_ops": bool(user.is_active and user.has_perm("enterprise_portal.use_server_operations"))}
        self.policy_patch = patch.dict("sys.modules", {"enterprise_portal.policy": self.policy})
        self.policy_patch.start()
        self.addCleanup(self.policy_patch.stop)

    def request(self, body, bypass_csrf=True):
        request = self.factory.post("/credentials/", json.dumps(body), content_type="application/json")
        request.user = self.user
        request._dont_enforce_csrf_checks = bypass_csrf
        return request

    def test_permission_is_explicit_and_inactive_denied(self):
        self.assertFalse(operations.can_operate(self.user))
        self.user.has_perm.return_value = True
        self.assertTrue(operations.can_operate(self.user))
        self.user.is_active = False
        self.assertFalse(operations.can_operate(self.user))

    def test_denied_never_opens_vault(self):
        with patch.object(operations, "vault") as vault:
            response = operations_views.credentials(self.request({"action": "set", "secret": "synthetic"}))
        self.assertEqual(response.status_code, 403)
        vault.assert_not_called()

    def test_technician_cannot_change_credentials(self):
        self.user.has_perm.return_value = True
        with patch.object(operations, "vault") as vault:
            response = operations_views.credentials(self.request({"action": "delete", "slot": SLOTS[0]}))
        self.assertEqual(response.status_code, 403)
        vault.assert_not_called()

    def test_health_checks_actual_test_database(self):
        self.user.has_perm.return_value = True
        self.assertEqual(operations.execute("health", self.user), {"service": "running", "database": "ok"})

    def test_csrf_enforced(self):
        self.user.has_perm.return_value = True
        response = operations_views.credentials(self.request({"action": "delete", "slot": SLOTS[0]}, False))
        self.assertEqual(response.status_code, 403)

    def test_secret_never_returned_or_audited(self):
        self.user.has_perm.return_value = True
        self.policy.is_enterprise_owner = lambda user: True
        secret = "synthetic-only-secret-123"
        store = Mock()
        with patch.object(operations, "vault", return_value=store), patch.object(operations_views, "audit") as audit:
            response = operations_views.credentials(self.request({"action": "set", "slot": SLOTS[0], "secret": secret}))
        self.assertEqual(response.status_code, 200)
        self.assertNotIn(secret, response.content.decode())
        self.assertNotIn(secret, str(audit.mock_calls))
        store.set.assert_called_once_with(SLOTS[0], secret)

    def test_invalid_inputs_and_commands_fail_closed(self):
        self.user.has_perm.return_value = True
        self.policy.is_enterprise_owner = lambda user: True
        for body in ({"action": "get", "slot": SLOTS[0]}, {"action": "set", "slot": "../../x"},
                     {"action": "delete", "slot": SLOTS[0], "secret": "synthetic"}):
            self.assertEqual(operations_views.credentials(self.request(body)).status_code, 400)
        for command in ("ssh", "curl https://example.invalid", "shell"):
            with self.assertRaises(ValueError):
                operations.execute(command, self.user)

    def test_storage_unavailable_is_honest(self):
        with patch.object(operations, "vault", side_effect=StoreUnavailable("test")):
            status = operations.capabilities()
        self.assertEqual(status["credential_storage"], "unavailable")
        self.assertEqual(status["ssh"], "read_only_policy")
        self.assertEqual(status["websites"]["targets"][0]["id"], "enterprise_portal")

    @unittest.skipUnless(os.name == "nt", "DPAPI is Windows-only")
    def test_existing_inherited_directory_is_rejected_without_repair(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary) / "inherited-vault"
            root.mkdir()
            with self.assertRaises(StoreUnavailable):
                CredentialStore(root)
            self.assertTrue(root.is_dir())

    @unittest.skipUnless(os.name == "nt", "DPAPI is Windows-only")
    def test_real_dpapi_synthetic_lifecycle(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary) / "vault"
            store = CredentialStore(root)
            secret = "synthetic-dpapi-test-only-456"
            store.set(SLOTS[0], secret)
            self.assertEqual(store._read_for_provider(SLOTS[0]), secret)
            self.assertTrue(store.metadata()[SLOTS[0]]["configured"])
            encrypted = (root / (SLOTS[0] + ".dpapi")).read_bytes()
            self.assertNotIn(secret.encode(), encrypted)
            # Verify DPAPI ciphertext is genuine and decryptable by this identity.
            import ctypes
            class Blob(ctypes.Structure):
                _fields_ = [("size", ctypes.c_uint32), ("data", ctypes.POINTER(ctypes.c_ubyte))]
            source_buffer = (ctypes.c_ubyte * len(encrypted)).from_buffer_copy(encrypted)
            source, result = Blob(len(encrypted), source_buffer), Blob()
            crypt = ctypes.WinDLL("crypt32")
            self.assertTrue(crypt.CryptUnprotectData(ctypes.byref(source), None, None, None, None, 1, ctypes.byref(result)))
            try:
                self.assertEqual(ctypes.string_at(result.data, result.size).decode(), secret)
            finally:
                kernel = ctypes.WinDLL("kernel32")
                kernel.LocalFree.argtypes = [ctypes.c_void_p]
                kernel.LocalFree(ctypes.cast(result.data, ctypes.c_void_p))
            store.delete(SLOTS[0])
            self.assertFalse(store.metadata()[SLOTS[0]]["configured"])


if __name__ == "__main__":
    unittest.main()
