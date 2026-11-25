import os
import tempfile
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from unittest import TestCase, skipUnless
from unittest.mock import patch

from . import login_mail
from .operations_store import CredentialStore


@skipUnless(os.name == "nt", "Requires the Windows DPAPI vault")
class SmtpConfigurationTests(TestCase):
    def setUp(self):
        root = self.enterContext(tempfile.TemporaryDirectory())
        vault = CredentialStore(str(Path(root, "vault")))
        self.enterContext(patch.object(login_mail, "store", return_value=vault))
        self.config = dict(host="smtp.example.invalid", port=465, security="ssl",
                           username="example-user", password="synthetic-secret",
                           from_email="first@example.invalid")

    def test_first_save_locks_and_status_only_discloses_sender(self):
        self.assertEqual(login_mail.configuration_status(), {
            "smtp_configured": False, "smtp_from_email": "",
        })
        with self.assertRaisesRegex(ValueError, "尚未配置"):
            login_mail.configure(self.config, replace=True)
        login_mail.configure(self.config)
        with self.assertRaisesRegex(ValueError, "请使用重置"):
            login_mail.configure(dict(self.config, from_email="other@example.invalid"))
        self.assertEqual(login_mail.configuration_status(), {
            "smtp_configured": True, "smtp_from_email": "first@example.invalid",
        })

    def test_failed_and_successful_replacement(self):
        login_mail.configure(self.config)
        with patch.object(CredentialStore, "_unprotect", return_value="invalid"):
            with self.assertRaisesRegex(ValueError, "原配置已保留"):
                login_mail.configure(dict(self.config, from_email="second@example.invalid"), replace=True)
        self.assertEqual(login_mail.configuration_status()["smtp_from_email"], "first@example.invalid")
        login_mail.configure(dict(self.config, from_email="second@example.invalid"), replace=True)
        self.assertEqual(login_mail.configuration_status()["smtp_from_email"], "second@example.invalid")

    def test_competing_first_writes_only_one_succeeds(self):
        def save(sender):
            try:
                login_mail.configure(dict(self.config, from_email=sender))
            except ValueError:
                return None
            return sender

        with ThreadPoolExecutor(max_workers=2) as pool:
            results = list(pool.map(save, ["first@example.invalid", "second@example.invalid"]))
        self.assertEqual(results.count(None), 1)
        self.assertIn(login_mail.configuration_status()["smtp_from_email"], results)
