from unittest.mock import patch
from django.test import SimpleTestCase
from . import ssh_group_policy as probe


class LocalSshGroupPolicyTests(SimpleTestCase):
    def inspect(self, raw, source="default"):
        with patch.object(probe.operations_ssh, "query_service", return_value={
                "query_state": "ok", "configuration_source": source, "status": "stopped"}), \
                patch.object(probe.operations_ssh, "read_default_config", return_value=raw) as read:
            result = probe.inspect_policy()
        if source != "default":
            read.assert_not_called()
        return result

    def test_literal_target_with_other_literal_groups_and_no_name_disclosure(self):
        result = self.inspect(b"AllowGroups other-ssh-users tradeloom-ssh-users\nPasswordAuthentication yes\n")
        self.assertTrue(result["eligible"])
        self.assertEqual(len(result["fingerprint"]), 64)
        self.assertEqual(result["config_state"], "read")
        self.assertEqual(result["config_reasons"], [])
        self.assertNotIn("other-ssh-users", str(result))

    def test_partial_diagnostics_are_fixed_codes_without_declaration_values(self):
        result = self.inspect(b"Match User private-account\nAllowUsers private-account\n")
        self.assertEqual(result["reason"], "partial_policy_manual_review")
        self.assertEqual(result["config_state"], "read")
        self.assertEqual(result["config_reasons"], ["match_not_evaluated"])
        self.assertNotIn("private-account", str(result))

        result = self.inspect(b"Include private-config-path\n")
        self.assertEqual(result["config_reasons"], ["include_not_followed"])
        self.assertNotIn("private-config-path", str(result))

    def test_unreadable_policy_reports_state_without_path_or_raw_error(self):
        with patch.object(probe.operations_ssh, "query_service", return_value={
                "query_state": "ok", "configuration_source": "default", "status": "stopped"}), \
                patch.object(probe.operations_ssh, "read_default_config", side_effect=OSError("secret-path")):
            result = probe.inspect_policy()
        self.assertEqual(result["reason"], "default_config_unavailable")
        self.assertEqual(result["config_state"], "unavailable")
        self.assertEqual(result["config_reasons"], [])
        self.assertNotIn("secret-path", str(result))

    def test_partial_wildcard_duplicate_and_custom_service_are_not_manageable(self):
        for raw in (b"AllowGroups *\n", b"AllowGroups tradeloom-ssh-users tradeloom-ssh-users\n",
                    b"AllowGroups tradeloom-ssh-users\nMatch Group administrators\n",
                    b"AllowGroups tradeloom-ssh-users\nInclude extra.conf\n",
                    b"AllowGroups tradeloom-ssh-users\nDenyUsers example\n"):
            self.assertFalse(self.inspect(raw)["eligible"])
        self.assertFalse(self.inspect(b"AllowGroups tradeloom-ssh-users\n", "customized")["eligible"])
