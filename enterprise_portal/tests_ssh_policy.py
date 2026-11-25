"""Synthetic declarations and access tests; never modifies real SSH configuration."""
import json
import types
import unittest
from unittest.mock import Mock, patch

# Reuse the standalone Django setup without creating accounts or a database.
from . import tests_operations
from . import operations, operations_ssh as ssh, operations_views


class ParserTests(unittest.TestCase):
    def test_global_declarations_and_first_auth_flag(self):
        data = ssh.parse_config(b'AllowUsers alpha beta # note\nDenyGroups "group one"\nPasswordAuthentication no\nPubkeyAuthentication yes', True)
        self.assertEqual(data["directive_counts"]["allowusers"], 2)
        self.assertEqual(data["declared_names"]["denygroups"], ["group one"])
        self.assertEqual(data["auth_flags"]["passwordauthentication"], "no")
        self.assertFalse(data["partial"])

    def test_scope_include_and_ignored_secret_targets(self):
        raw = b'AllowUsers alpha\nInclude secret_path\nHostKey PRIVATE_SECRET\nAuthorizedKeysFile KEY_SECRET\nForceCommand COMMAND_SECRET\nMatch User hidden\nAllowUsers hidden\nPasswordAuthentication no'
        data = ssh.parse_config(raw)
        self.assertEqual(data["directive_counts"]["allowusers"], 1)
        self.assertEqual(data["auth_flags"]["passwordauthentication"], "unspecified")
        self.assertEqual(data["reasons"], ["include_not_followed", "match_not_evaluated"])
        for text in ("alpha", "hidden", "SECRET", "secret_path"):
            self.assertNotIn(text, json.dumps(data))

    def test_malformed_and_bounds(self):
        for raw in (b'AllowUsers "oops', b'AllowGroups', b'PasswordAuthentication maybe', b'PubkeyAuthentication yes no', b'AllowUsers a\x00b'):
            self.assertIn("malformed", ssh.parse_config(raw)["reasons"])
        self.assertEqual(ssh.parse_config(b'x' * (ssh.MAX_BYTES + 1))["state"], "too_large")
        self.assertEqual(ssh.parse_config(b'\n' * (ssh.MAX_LINES + 1))["state"], "too_large")
        self.assertTrue(ssh.parse_config(b'AllowUsers ' + b'a ' * 129)["partial"])
        self.assertTrue(ssh.parse_config(b'PasswordAuthentication yes\nPasswordAuthentication no')["partial"])
        self.assertEqual(ssh.parse_config(b'\xff')["state"], "unavailable")

    def test_unsupported_equals_cannot_hide_scope(self):
        for declaration in (b'Match=User alpha', b'Match = User alpha', b'Match"User" alpha'):
            data = ssh.parse_config(declaration + b'\nAllowUsers hidden')
            self.assertTrue(data["partial"])
            self.assertEqual(data["directive_counts"]["allowusers"], 0)
        for raw in (b'Include=other', b'AllowUsers=alpha', b'PasswordAuthentication = no'):
            self.assertIn("malformed", ssh.parse_config(raw)["reasons"])

    @patch.object(ssh, "_windows_directory", return_value=r'C:\Windows')
    def test_service_command_no_customization_assumed(self, root):
        self.assertEqual(ssh._configuration_source(r'"C:\Windows\System32\OpenSSH\sshd.exe"'), "default")
        for command in (r'C:\Windows\System32\OpenSSH\sshd.exe -f C:\other',
                        r'"C:\Windows\System32\OpenSSH\sshd.exe" -o PasswordAuthentication=yes',
                        r'C:\other\sshd.exe', r'powershell.exe -File other.ps1'):
            self.assertEqual(ssh._configuration_source(command), "customized")
        self.assertEqual(ssh._configuration_source('"broken'), "unknown")

    def test_unverified_service_never_reads_config(self):
        for state, source in (("denied", "unknown"), ("not_installed", "unknown"), ("ok", "customized"), ("ok", "unknown")):
            with patch.object(ssh, "query_service", return_value={"query_state": state, "configuration_source": source}), patch.object(ssh, "read_default_config") as read:
                self.assertEqual(ssh.inspect()["config"]["state"], "not_inspected")
                read.assert_not_called()

    @unittest.skipUnless(ssh.os.name == "nt", "Windows SCM branch")
    def test_scm_denied_and_absent(self):
        api = Mock()
        api.OpenSCManagerW.return_value = 0
        with patch.object(ssh.ctypes, "WinDLL", return_value=api), patch.object(ssh.ctypes, "get_last_error", return_value=5):
            self.assertEqual(ssh.query_service()["query_state"], "denied")
        api.OpenSCManagerW.return_value = 123
        api.OpenServiceW.return_value = 0
        with patch.object(ssh.ctypes, "WinDLL", return_value=api), patch.object(ssh.ctypes, "get_last_error", return_value=1060):
            self.assertEqual(ssh.query_service()["query_state"], "not_installed")
        api.CloseServiceHandle.assert_called_once_with(123)

    def test_inspect_failures_and_name_authority(self):
        service = {"query_state": "ok", "configuration_source": "default"}
        with patch.object(ssh, "query_service", return_value=service):
            for reason in ("unsafe", "too_large"):
                with patch.object(ssh, "read_default_config", side_effect=ValueError(reason)):
                    self.assertEqual(ssh.inspect()["config"]["state"], reason)
            with patch.object(ssh, "read_default_config", return_value=b'AllowUsers alpha'):
                self.assertFalse(ssh.inspect(True, False)["names_included"])
                self.assertTrue(ssh.inspect(True, True)["names_included"])


class AccessTests(unittest.TestCase):
    setUp = tests_operations.OperationsTests.setUp

    def get(self, query=""):
        request = self.factory.get("/api/enterprise/operations/ssh-policy/" + query)
        request.user = self.user
        return request

    def test_denied_and_inactive_no_probe(self):
        with patch.object(ssh, "inspect") as probe:
            self.assertEqual(operations_views.ssh_policy(self.get()).status_code, 403)
            self.user.has_perm.return_value = True
            self.user.is_active = False
            self.assertEqual(operations_views.ssh_policy(self.get()).status_code, 403)
            probe.assert_not_called()

    def test_minimal_technician_and_explicit_owner_names(self):
        self.user.has_perm.return_value = True
        with patch.object(ssh, "inspect", return_value={}) as probe:
            response = operations_views.ssh_policy(self.get())
            self.assertEqual(response.status_code, 200)
            self.assertEqual(response["Cache-Control"], "no-store")
            probe.assert_called_once_with(include_names=False, can_view_names=False)
            probe.reset_mock()
            self.assertEqual(operations_views.ssh_policy(self.get("?include_names=1")).status_code, 403)
            probe.assert_not_called()
            self.policy.is_enterprise_owner = lambda user: True
            self.assertEqual(operations_views.ssh_policy(self.get("?include_names=1")).status_code, 200)
            probe.assert_called_once_with(include_names=True, can_view_names=True)

    def test_invalid_options_no_probe(self):
        self.user.has_perm.return_value = True
        with patch.object(ssh, "inspect") as probe:
            for query in ("?path=other", "?include_names=true", "?include_names=1&include_names=0"):
                self.assertEqual(operations_views.ssh_policy(self.get(query)).status_code, 400)
            probe.assert_not_called()

    def test_metadata_no_os_probe_and_assistant_never_names(self):
        self.user.has_perm.return_value = True
        with patch.object(ssh, "inspect", return_value={}) as probe, patch.object(operations, "vault", side_effect=OSError()):
            operations.capabilities()
            operations.execute("permissions", self.user)
            probe.assert_not_called()
            operations.execute("ssh_policy", self.user)
            probe.assert_called_once_with()
