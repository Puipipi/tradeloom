from django.contrib.auth import get_user_model
from django.contrib.auth.models import Group, Permission
from django.core.management import call_command
from django.test import Client, TestCase

from .models import EnterpriseEntry


class RegistrarSetupTests(TestCase):
    url = "/enterprise/console/registrars/"

    @classmethod
    def setUpTestData(cls):
        call_command("configure_enterprise_groups", verbosity=0)
        User = get_user_model()
        cls.admin = User.objects.create_superuser("synthetic-setup-admin", "", "Synthetic-admin-pass-123!")
        cls.owner = User.objects.create_user("synthetic-setup-owner")
        cls.owner.groups.add(Group.objects.get(name="企业老板"))
        cls.registrar = User.objects.create_user("synthetic-setup-registrar")
        cls.registrar.groups.add(Group.objects.get(name="工厂登记员"))
        cls.tech = User.objects.create_user("synthetic-setup-tech", password=None)
        cls.tech.user_permissions.add(Permission.objects.get(codename="use_server_operations"))
        cls.first = Group.objects.create(name="工厂:合成甲")
        cls.second = Group.objects.create(name="工厂:合成乙")

    def create_payload(self, **extra):
        return {"action": "create", "username": "synthetic-new-registrar", "password1": "Synthetic-new-pass-587!",
                "password2": "Synthetic-new-pass-587!", "factory_groups": [self.first.pk], **extra}

    def test_only_active_non_conflicted_superuser_can_access(self):
        self.assertEqual(self.client.get(self.url).status_code, 302)
        for user in (self.owner, self.tech, self.registrar):
            self.client.force_login(user)
            self.assertEqual(self.client.get(self.url).status_code, 403)
            self.assertEqual(self.client.post(self.url, self.create_payload()).status_code, 403)
        self.admin.groups.add(Group.objects.get(name="工厂登记员"))
        self.client.force_login(self.admin)
        self.assertEqual(self.client.get(self.url).status_code, 403)

    def test_create_factory_and_hashed_validated_registrar_without_extra_grants(self):
        self.client.force_login(self.admin)
        self.assertContains(self.client.get("/enterprise/console/"), "工厂与登记员设置")
        self.assertEqual(self.client.post(self.url, {"action": "factory", "factory_name": " 新合成厂 "}).status_code, 302)
        factory = Group.objects.get(name="工厂:新合成厂")
        self.assertFalse(factory.permissions.exists())
        self.assertContains(self.client.post(self.url, {"action": "factory", "factory_name": "工厂:新合成厂"}), "该工厂组已存在")
        with self.assertLogs("tradeloom.operations.audit", level="INFO") as logs:
            self.assertEqual(self.client.post(self.url, self.create_payload()).status_code, 302)
        user = get_user_model().objects.get(username="synthetic-new-registrar")
        self.assertTrue(user.check_password("Synthetic-new-pass-587!"))
        self.assertNotEqual(user.password, "Synthetic-new-pass-587!")
        self.assertFalse(user.is_staff or user.is_superuser or user.user_permissions.exists())
        self.assertSetEqual(set(user.groups.values_list("name", flat=True)), {"工厂登记员", self.first.name})
        self.assertNotIn("Synthetic-new-pass", str(logs.output))
        self.assertEqual(self.client.post(self.url, self.create_payload(is_staff="1")).status_code, 400)
        weak = self.client.post(self.url, self.create_payload(username="weak-new", password1="123", password2="123"))
        self.assertFalse(get_user_model().objects.filter(username="weak-new").exists())
        self.assertNotContains(weak, 'value="123"')
        self.assertContains(self.client.post(self.url, self.create_payload()), "已存在")

    def test_dirty_role_or_factory_grants_are_not_overwritten(self):
        self.client.force_login(self.admin)
        permission = Permission.objects.get(codename="use_server_operations")
        self.first.permissions.add(permission)
        self.assertEqual(self.client.post(self.url, self.create_payload()).status_code, 200)
        self.assertFalse(get_user_model().objects.filter(username="synthetic-new-registrar").exists())
        self.first.permissions.clear()
        role = Group.objects.get(name="工厂登记员")
        role.permissions.add(permission)
        response = self.client.post(self.url, self.create_payload())
        self.assertContains(response, "固定组权限")
        self.assertTrue(role.permissions.filter(pk=permission.pk).exists())
        self.assertFalse(get_user_model().objects.filter(username="synthetic-new-registrar").exists())

    def test_transfer_and_disable_rechecks_current_session_without_moving_records(self):
        self.registrar.groups.add(self.first)
        row = EnterpriseEntry.objects.create(created_by=self.registrar, factory_group=self.first, body="old-first-record")
        worker = Client()
        worker.force_login(self.registrar)
        self.assertContains(worker.get("/enterprise/"), "old-first-record")
        self.client.force_login(self.admin)
        update = {"action": "update", "user_id": self.registrar.pk, "factory_groups": [self.second.pk], "is_active": "on"}
        self.assertEqual(self.client.post(self.url, update).status_code, 302)
        self.assertNotContains(worker.get("/enterprise/"), "old-first-record")
        self.assertEqual(worker.post("/enterprise/entries", {"factory_group": self.first.pk, "body": "forbidden-old-factory"}).status_code, 403)
        self.assertEqual(worker.post("/enterprise/entries", {"factory_group": self.second.pk, "body": "new-second-record"}).status_code, 302)
        row.refresh_from_db()
        self.assertEqual(row.factory_group_id, self.first.pk)
        self.assertEqual(self.client.post(self.url, {k: v for k, v in update.items() if k != "is_active"}).status_code, 302)
        self.assertEqual(worker.get("/enterprise/").status_code, 302)
        self.assertEqual(self.client.post(self.url, update).status_code, 302)
        self.assertTrue(get_user_model().objects.get(pk=self.registrar.pk).is_active)

    def test_mixed_legacy_high_privilege_or_direct_grants_not_taken_over(self):
        self.client.force_login(self.admin)
        extra = Group.objects.create(name="自定义旧组")
        self.registrar.groups.add(extra)
        for user in (self.registrar, self.admin, self.owner, self.tech):
            response = self.client.post(self.url, {"action": "update", "user_id": user.pk, "factory_groups": [self.first.pk]})
            self.assertEqual(response.status_code, 200)
            user.refresh_from_db()
            self.assertTrue(user.is_active)
        self.assertTrue(self.registrar.groups.filter(pk=extra.pk).exists())
        self.registrar.groups.remove(extra)
        self.registrar.user_permissions.add(Permission.objects.get(codename="view_user"))
        self.client.post(self.url, {"action": "update", "user_id": self.registrar.pk})
        self.registrar.refresh_from_db()
        self.assertTrue(self.registrar.is_active)
        csrf = Client(enforce_csrf_checks=True)
        csrf.force_login(self.admin)
        self.assertEqual(csrf.post(self.url, {"action": "factory", "factory_name": "未验证"}).status_code, 403)
