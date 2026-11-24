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
            "task_id": self.task.pk,
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
