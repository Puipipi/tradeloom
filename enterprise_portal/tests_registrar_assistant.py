import json
from datetime import timedelta
from unittest.mock import patch

from django.contrib.auth import get_user_model
from django.contrib.auth.models import Group, Permission
from django.contrib.sessions.models import Session
from django.core.management import call_command
from django.utils import timezone

from . import operations, operations_ai, operations_registrars as actions
from .testing import EmailVerifiedTestCase, EmailVerifiedClient


class RegistrarAssistantTests(EmailVerifiedTestCase):
    url = "/api/enterprise/operations/assistant/"

    @classmethod
    def setUpTestData(cls):
        call_command("configure_enterprise_groups", verbosity=0)
        User = get_user_model()
        cls.admin = User.objects.create_superuser("assistant-admin", "private-admin@example.invalid", "Synthetic-admin-123!")
        cls.owner = User.objects.create_user("assistant-owner")
        cls.owner.groups.add(Group.objects.get(name="企业老板"))
        cls.tech = User.objects.create_user("assistant-tech")
        cls.tech.user_permissions.add(Permission.objects.get(codename="use_server_operations"))
        cls.factory = Group.objects.create(name="工厂:合成甲")
        cls.other = Group.objects.create(name="工厂:合成乙")
        cls.target = User.objects.create_user("factory-alice", "private-recipient@example.invalid", "Synthetic-registrar-456!")
        cls.target.groups.add(Group.objects.get(name="工厂登记员"), cls.factory)

    def setUp(self):
        super().setUp()
        self.client.force_login(self.admin)

    def post(self, data, client=None):
        return (client or self.client).post(self.url, data, content_type="application/json")

    def prepare(self):
        response = self.post({"message": "停用登记员 factory-alice"})
        self.assertEqual(response.status_code, 200)
        return response.json()["proposal"]["token"]

    def resolve(self, token, decision="confirm", client=None):
        return self.post({"proposal": token, "decision": decision}, client)

    def test_local_check_proposal_and_confirmation_never_touch_model_or_credentials(self):
        with patch.object(operations, "vault") as vault, patch.object(operations_ai, "classify") as model:
            check = self.post({"message": "查看工厂登记员 factory-alice的状态"})
            self.assertEqual(check.json()["result"]["registrar"]["username"], "factory-alice")
            token = self.prepare()
            self.target.refresh_from_db()
            self.assertTrue(self.target.is_active)
            before = (self.target.password, set(self.target.groups.values_list("pk", flat=True)))
            response = self.resolve(token)
            self.assertEqual(response.json()["effect"], "applied")
            self.target.refresh_from_db()
            self.assertFalse(self.target.is_active)
            self.assertEqual(before, (self.target.password, set(self.target.groups.values_list("pk", flat=True))))
            for secret in (self.target.email, self.target.password, "Synthetic-registrar-456!"):
                self.assertNotIn(secret, response.content.decode())
            vault.assert_not_called()
            model.assert_not_called()
        self.assertEqual(self.resolve(token).status_code, 409)

    def test_cancel_and_noop_do_not_change_target(self):
        token = self.prepare()
        self.assertEqual(self.resolve(token, "cancel").json()["effect"], "cancelled")
        self.assertEqual(self.resolve(token).status_code, 409)
        result = self.post({"registrar": {"operation": "enable", "username": self.target.username}})
        self.assertIsNone(result.json()["proposal"])
        self.target.refresh_from_db()
        self.assertTrue(self.target.is_active)

    def test_roles_and_unmanageable_accounts_denied(self):
        for user in (self.owner, self.tech, self.target):
            self.client.force_login(user)
            self.assertEqual(self.post({"registrar": {"operation": "check", "username": self.target.username}}).status_code, 403)
        self.client.force_login(self.admin)
        for user in (self.admin, self.owner, self.tech):
            self.assertEqual(self.post({"registrar": {"operation": "disable", "username": user.username}}).status_code, 403)
        self.target.user_permissions.add(Permission.objects.get(codename="view_customer"))
        self.assertEqual(self.post({"message": "查询登记员 factory-alice"}).status_code, 403)

    def test_stale_factory_status_and_target_role_consume_proposal(self):
        token = self.prepare()
        self.target.groups.add(self.other)
        response = self.resolve(token)
        self.assertEqual(response.status_code, 409)
        self.assertEqual(response.json()["current"]["factories"], ["工厂:合成乙", "工厂:合成甲"])
        self.assertEqual(self.resolve(token).status_code, 409)
        token = self.prepare()
        get_user_model().objects.filter(pk=self.target.pk).update(is_active=False)
        self.assertEqual(self.resolve(token).status_code, 409)
        get_user_model().objects.filter(pk=self.target.pk).update(is_active=True)
        token = self.prepare()
        self.target.groups.add(Group.objects.get(name="企业老板"))
        self.assertEqual(self.resolve(token).status_code, 403)

    def test_permission_revoked_confirmation_consumed_even_after_restore(self):
        token = self.prepare()
        get_user_model().objects.filter(pk=self.admin.pk).update(is_superuser=False)
        self.assertEqual(self.resolve(token).status_code, 403)
        get_user_model().objects.filter(pk=self.admin.pk).update(is_superuser=True)
        self.assertEqual(self.resolve(token).status_code, 409)
        self.target.refresh_from_db()
        self.assertTrue(self.target.is_active)

    def test_proposal_bound_to_session_and_expires(self):
        token = self.prepare()
        other = EmailVerifiedClient()
        other.force_login(self.admin)
        self.assertEqual(self.resolve(token, client=other).status_code, 403)
        self.assertEqual(self.resolve(token).status_code, 200)
        get_user_model().objects.filter(pk=self.target.pk).update(is_active=True)
        token = self.prepare()
        Session.objects.filter(session_key=actions.key(token)).update(expire_date=timezone.now() - timedelta(seconds=1))
        self.assertEqual(self.resolve(token).status_code, 409)

    def test_ambiguous_and_malformed_registrar_intents_stay_local(self):
        User = get_user_model()
        User.objects.create_user("CaseName")
        User.objects.create_user("casename")
        with patch.object(operations_ai, "classify") as model:
            self.assertEqual(self.post({"message": "停用登记员 CASENAME", "consent": True}).status_code, 400)
            self.assertEqual(self.post({"message": "帮我随便管理登记员", "consent": True}).status_code, 400)
            model.assert_not_called()

    def test_server_requires_explicit_boolean_consent_before_vault_or_prompt(self):
        with patch.object(operations, "vault") as vault, patch.object(operations_ai, "classify") as model:
            for data in ({"message": "检查健康"}, {"message": "检查健康", "consent": False}, {"message": "检查健康", "consent": "true"}):
                response = self.post(data)
                self.assertEqual(response.json()["effect"], "consent_required")
            vault.assert_not_called()
            model.assert_not_called()
        with patch.object(operations_ai, "classify", return_value="health") as model, patch.object(operations, "vault") as vault:
            vault.return_value.metadata.return_value = {"deepseek_api_key": {"configured": True}}
            vault.return_value._read_for_provider.return_value = "synthetic-provider-key"
            response = self.post({"message": "检查健康", "consent": True})
            self.assertEqual(response.json()["effect"], "read")
            model.assert_called_once_with("检查健康", "synthetic-provider-key")

    def test_csrf_required_and_controls_only_for_existing_registrar_manager(self):
        client = EmailVerifiedClient(enforce_csrf_checks=True)
        client.force_login(self.admin)
        self.assertEqual(self.post({"message": "停用登记员 factory-alice"}, client).status_code, 403)
        self.assertContains(self.client.get("/enterprise/console/"), 'id="registrar-command"')
        self.client.force_login(self.owner)
        self.assertNotContains(self.client.get("/enterprise/console/"), 'id="registrar-command"')

    def test_notice_about_registrars_preserves_existing_local_notice_command(self):
        self.client.force_login(self.owner)
        with patch.object(operations_ai, "classify") as model:
            response = self.post({"message": "发布公告 登记员明天盘点"})
            self.assertEqual(response.status_code, 200)
            self.assertEqual(response.json()["proposal"]["action"], "prepare_website_notice")
            model.assert_not_called()

    def test_permission_overview_matches_existing_manager_boundary(self):
        from .policy import permission_rows
        for user, permitted in ((self.admin, True), (self.owner, False), (self.tech, False), (self.target, False)):
            row = next(row for row in permission_rows(user) if row["key"] == "registrar_assistant")
            self.assertEqual((row["read"], row["write"]), (permitted, permitted))
