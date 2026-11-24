from __future__ import annotations

import re

from django.contrib.auth import get_user_model
from django.contrib.auth.models import Group, Permission
from django.test import Client, TestCase
from django.utils import timezone

from enterprise_portal.management.commands.configure_enterprise_groups import Command
from enterprise_portal.models import EnterpriseEntry
from workbench.models import Product, Task


class EnterprisePortalAccessTests(TestCase):
    @classmethod
    def setUpTestData(cls):
        Command().handle()
        cls.owner_group = Group.objects.get(name="企业老板")
        cls.registrar_group = Group.objects.get(name="工厂登记员")
        User = get_user_model()
        cls.owner = User.objects.create_user("owner", password="Owner-test-pass-123")
        cls.owner.groups.add(cls.owner_group)
        cls.registrar = User.objects.create_user("registrar", password="Registrar-test-pass-123")
        cls.registrar.groups.add(cls.registrar_group)
        cls.registrar2 = User.objects.create_user("registrar2", password="Registrar2-test-pass-123")
        cls.registrar2.groups.add(cls.registrar_group)
        cls.admin = User.objects.create_superuser("admin", "admin@example.invalid", "Admin-test-pass-123")
        cls.task = Task.objects.create(
            title="可见合成批次", mode="qa", status="ready",
            created_at=timezone.now(), updated_at=timezone.now(),
        )
        cls.product = Product.objects.create(
            task=cls.task, position=1, sku="QA-P-1", name="合成产品", category="QA",
            material="合成材料", size="样品", color="蓝", image_filename="", image_stored_name="",
            missing_fields=[], created_at=timezone.now(), updated_at=timezone.now(),
        )
        cls.private_entry = EnterpriseEntry.objects.create(
            task=cls.task, created_by=cls.registrar, body="registrar-one-private",
        )

    def test_anonymous_redirect_and_old_business_surface_is_not_mounted(self):
        response = self.client.get("/enterprise/")
        self.assertRedirects(response, "/accounts/login/?next=/enterprise/")
        self.assertEqual(self.client.get("/home").status_code, 404)
        self.assertEqual(self.client.get("/products").status_code, 404)
        self.assertEqual(self.client.get("/api/products/QA-P-1").status_code, 404)

    def test_employee_writes_are_isolated_and_owner_reads_business_data(self):
        registrar = Client()
        self.assertTrue(registrar.login(username="registrar", password="Registrar-test-pass-123"))
        page = registrar.get("/enterprise/")
        self.assertEqual(page.status_code, 200)
        csrf = re.search(rb'name="csrfmiddlewaretoken" value="([^"]+)"', page.content).group(1).decode()
        created = registrar.post("/enterprise/entries", {
            "csrfmiddlewaretoken": csrf,
            "body": "registrar-new-private",
        })
        self.assertEqual(created.status_code, 302)

        other = Client()
        self.assertTrue(other.login(username="registrar2", password="Registrar2-test-pass-123"))
        other_html = other.get("/enterprise/").content.decode()
        self.assertNotIn("registrar-one-private", other_html)
        self.assertNotIn("registrar-new-private", other_html)
        other_records = other.get("/api/enterprise/records").json()["results"]
        self.assertEqual(other_records, [])

        owner = Client()
        self.assertTrue(owner.login(username="owner", password="Owner-test-pass-123"))
        owner_page = owner.get("/enterprise/")
        owner_html = owner_page.content.decode()
        self.assertIn("可见合成批次", owner_html)
        self.assertIn("合成产品", owner_html)
        self.assertIn("registrar-one-private", owner_html)
        self.assertIn("registrar-new-private", owner_html)
        csrf = re.search(rb'name="csrfmiddlewaretoken" value="([^"]+)"', owner_page.content).group(1).decode()
        owner_write = owner.post("/enterprise/entries", {
            "csrfmiddlewaretoken": csrf, "task_id": self.task.pk, "body": "owner-can-write",
        })
        self.assertEqual(owner_write.status_code, 302)
        self.assertContains(owner.get("/enterprise/"), "owner-can-write")

    def test_factory_group_shares_only_with_group_members(self):
        factory = Group.objects.create(name="工厂:苏州")
        self.registrar.groups.add(factory)
        entry = EnterpriseEntry.objects.create(
            task=self.task, created_by=self.registrar, factory_group=factory, body="factory-shared",
        )
        self.registrar2.groups.add(factory)
        for user in (self.registrar, self.registrar2):
            client = Client()
            client.force_login(user)
            self.assertContains(client.get("/enterprise/"), "factory-shared")

        outsider = Client()
        outsider.force_login(self.owner)
        self.assertContains(outsider.get("/enterprise/"), "factory-shared")
        self.assertIsNotNone(entry.pk)

    def test_registrar_cannot_assign_entry_to_an_unrelated_factory(self):
        secret_factory = Group.objects.create(name="工厂:未授权")
        registrar = Client()
        registrar.force_login(self.registrar)
        page = registrar.get("/enterprise/")
        csrf = re.search(rb'name="csrfmiddlewaretoken" value="([^"]+)"', page.content).group(1).decode()
        response = registrar.post("/enterprise/entries", {
            "csrfmiddlewaretoken": csrf,
            "factory_group": secret_factory.pk,
            "body": "not-shared-to-unapproved-factory",
        })
        self.assertEqual(response.status_code, 403)
        self.assertFalse(EnterpriseEntry.objects.filter(body="not-shared-to-unapproved-factory").exists())

    def test_owner_factory_picker_and_two_factory_registration_scope(self):
        first = Group.objects.create(name="工厂:合成甲")
        second = Group.objects.create(name="工厂:合成乙")
        self.registrar.groups.add(first)
        self.registrar2.groups.add(second)
        self.client.force_login(self.owner)
        self.assertSetEqual(set(self.client.get("/enterprise/").context["factory_groups"]), {first, second})
        self.assertEqual(self.client.post("/enterprise/entries", {"factory_group": second.pk, "body": "owner-to-second"}).status_code, 302)
        self.client.force_login(self.registrar)
        self.assertEqual(list(self.client.get("/enterprise/").context["factory_groups"]), [first])
        self.assertEqual(self.client.post("/enterprise/entries", {"factory_group": first.pk, "body": "first-factory"}).status_code, 302)
        self.assertEqual(self.client.post("/enterprise/entries", {"factory_group": second.pk, "body": "cross-factory-denied"}).status_code, 403)
        self.client.force_login(self.registrar2)
        page = self.client.get("/enterprise/")
        self.assertContains(page, "owner-to-second")
        self.assertNotContains(page, "first-factory")
        self.assertEqual(self.client.post("/enterprise/entries", {"factory_group": second.pk, "body": "second-factory"}).status_code, 302)
        self.assertEqual(self.client.post("/enterprise/entries", {"factory_group": first.pk, "body": "reverse-cross-denied"}).status_code, 403)

    def test_admin_can_manage_auth_accounts_and_groups(self):
        admin = Client()
        admin.force_login(self.admin)
        self.assertEqual(admin.get("/admin/auth/user/add/").status_code, 200)
        user_change = admin.get(f"/admin/auth/user/{self.registrar.pk}/change/")
        self.assertEqual(user_change.status_code, 200)
        self.assertContains(user_change, 'name="groups"')
        self.assertContains(user_change, 'name="is_active"')
        self.assertEqual(admin.get("/admin/auth/group/").status_code, 200)
        self.assertEqual(admin.get("/admin/auth/group/add/").status_code, 200)

    def test_default_group_setup_does_not_overwrite_admin_permissions(self):
        extra = Permission.objects.get(codename="change_group")
        self.registrar_group.permissions.add(extra)
        Command().handle()
        self.assertTrue(self.registrar_group.permissions.filter(pk=extra.pk).exists())

    def test_csrf_logout_and_disabled_account(self):
        client = Client(enforce_csrf_checks=True)
        page = client.get("/accounts/login/")
        csrf = re.search(rb'name="csrfmiddlewaretoken" value="([^"]+)"', page.content).group(1).decode()
        response = client.post("/accounts/login/", {
            "username": "registrar", "password": "Registrar-test-pass-123", "csrfmiddlewaretoken": csrf,
        })
        self.assertEqual(response.status_code, 302)
        self.assertEqual(client.post("/enterprise/entries", {"body": "csrf-required"}).status_code, 403)
        page = client.get("/enterprise/")
        csrf = re.search(rb'name="csrfmiddlewaretoken" value="([^"]+)"', page.content).group(1).decode()
        logout_response = client.post("/accounts/logout/", {"csrfmiddlewaretoken": csrf})
        self.assertEqual(logout_response.status_code, 302)
        self.assertRedirects(client.get("/enterprise/"), "/accounts/login/?next=/enterprise/")

        inactive = get_user_model().objects.create_user("inactive", password="Inactive-test-pass-123", is_active=False)
        login = self.client.get("/accounts/login/")
        login_csrf = re.search(rb'name="csrfmiddlewaretoken" value="([^"]+)"', login.content).group(1).decode()
        denied = self.client.post("/accounts/login/", {
            "username": inactive.username, "password": "Inactive-test-pass-123", "csrfmiddlewaretoken": login_csrf,
        })
        self.assertEqual(denied.status_code, 200)
        self.assertContains(denied, "用户名或密码不正确")


class EnterprisePolicyBoundaryTests(TestCase):
    setUpTestData = classmethod(EnterprisePortalAccessTests.setUpTestData.__func__)
    def test_capability_roles_and_no_sensitive_records(self):
        from enterprise_portal.policy import policy_payload, is_enterprise_owner
        from django.contrib.auth.models import AnonymousUser
        self.assertFalse(is_enterprise_owner(AnonymousUser()))
        for user, owner in [(self.owner, True), (self.registrar, False), (self.admin, True)]:
            data = policy_payload(user)
            self.assertEqual(data["capabilities"]["local_workbench"], owner)
            self.assertEqual(data["capabilities"]["owner_tools"], owner)
            self.assertNotIn(self.task.title, str(data))
            ssh = next(row for row in data["permission_rows"] if row["key"] == "ssh")
            self.assertEqual(ssh["read"], data["capabilities"]["server_ops"])
            self.assertFalse(ssh["write"])
            self.assertIn("不代表登录授权", ssh["scope"])
        self.registrar.user_permissions.add(Permission.objects.get(codename="view_business_data"))
        user = get_user_model().objects.get(pk=self.registrar.pk)
        self.assertFalse(policy_payload(user)["capabilities"]["business_data"])
        self.assertFalse(is_enterprise_owner(user))

    def test_registrar_cannot_probe_task_or_receive_linked_title(self):
        client = Client()
        client.force_login(self.registrar)
        for task_id in [str(self.task.pk), "999999999"]:
            response = client.post("/enterprise/entries", {"task_id": task_id, "body": "blocked-probe"})
            self.assertEqual(response.status_code, 403)
        data = client.get("/api/enterprise/records").json()
        self.assertNotIn("task_id", str(data))
        self.assertNotIn(self.task.title, str(data))
        self.assertFalse(EnterpriseEntry.objects.filter(body="blocked-probe").exists())

    def test_other_factory_and_non_factory_groups_do_not_share(self):
        from enterprise_portal.policy import visible_entries
        other_factory = Group.objects.create(name="工厂:other")
        generic = self.registrar_group
        own_elsewhere = EnterpriseEntry.objects.create(created_by=self.registrar, factory_group=other_factory, body="other-factory")
        generic_entry = EnterpriseEntry.objects.create(created_by=self.registrar2, factory_group=generic, body="not-a-factory")
        ids = set(visible_entries(self.registrar).values_list("pk", flat=True))
        self.assertNotIn(own_elsewhere.pk, ids)
        self.assertNotIn(generic_entry.pk, ids)

    def test_no_permission_account_denied_api_and_disabled_owner(self):
        from enterprise_portal.policy import is_enterprise_owner
        user = get_user_model().objects.create_user("no-permissions")
        client = Client(); client.force_login(user)
        self.assertEqual(client.get("/api/enterprise/records").status_code, 403)
        self.owner.is_active = False
        self.assertFalse(is_enterprise_owner(self.owner))

    def test_explicit_technician_and_conflicting_factory_roles(self):
        from enterprise_portal.policy import capability_policy, is_enterprise_owner
        tech = get_user_model().objects.create_user("technician")
        tech.user_permissions.add(Permission.objects.get(codename="use_server_operations"))
        self.assertTrue(capability_policy(tech)["server_ops"])
        self.assertFalse(capability_policy(tech)["owner_tools"])
        self.assertFalse(capability_policy(tech)["local_workbench"])
        self.owner.groups.add(self.registrar_group)
        self.owner.user_permissions.add(Permission.objects.get(codename="use_server_operations"))
        self.assertFalse(is_enterprise_owner(self.owner))
        self.assertFalse(capability_policy(self.owner)["server_ops"])
        self.assertFalse(capability_policy(self.owner)["business_data"])

    def test_capabilities_endpoint_and_factory_admin_hard_deny(self):
        response = self.client.get("/enterprise/capabilities/")
        self.assertEqual(response.status_code, 302)
        self.client.force_login(self.registrar)
        response = self.client.get("/enterprise/capabilities/")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response["Cache-Control"], "no-store")
        self.assertFalse(response.json()["capabilities"]["server_ops"])
        self.registrar.is_staff = True
        self.registrar.is_superuser = True
        self.registrar.save()
        self.client.force_login(self.registrar)
        self.assertEqual(self.client.get("/admin/").status_code, 403)
        self.assertEqual(self.client.get("/admin/enterprise_portal/enterpriseentry/").status_code, 403)
