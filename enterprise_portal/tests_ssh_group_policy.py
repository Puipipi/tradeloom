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
        self.assertNotIn("other-ssh-users", str(result))

    def test_partial_wildcard_duplicate_and_custom_service_are_not_manageable(self):
        for raw in (b"AllowGroups *\n", b"AllowGroups tradeloom-ssh-users tradeloom-ssh-users\n",
                    b"AllowGroups tradeloom-ssh-users\nMatch Group administrators\n",
                    b"AllowGroups tradeloom-ssh-users\nInclude extra.conf\n",
                    b"AllowGroups tradeloom-ssh-users\nDenyUsers example\n"):
            self.assertFalse(self.inspect(raw)["eligible"])
        self.assertFalse(self.inspect(b"AllowGroups tradeloom-ssh-users\n", "customized")["eligible"])
