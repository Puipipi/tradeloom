from django.contrib.auth import get_user_model
from django.contrib.auth.models import Group, Permission
from django.contrib.contenttypes.models import ContentType
from django.core.management import call_command
from django.test import override_settings
from .testing import EmailVerifiedTestCase as TestCase
from django.urls import include, path

urlpatterns = [path("enterprise/console/", include("enterprise_portal.console_urls"))]


@override_settings(ROOT_URLCONF=__name__, LOGIN_URL="/accounts/login/")
class EnterpriseConsoleTests(TestCase):
    @classmethod
    def setUpTestData(cls):
        call_command("configure_enterprise_groups", verbosity=0)
        User = get_user_model()
        cls.owner = User.objects.create_user("synthetic-owner")
        cls.owner.groups.add(Group.objects.get(name="企业老板"))
        cls.registrar = User.objects.create_user("synthetic-factory")
        cls.registrar.groups.add(Group.objects.get(name="工厂登记员"))

    def test_console_requires_login_and_owner_policy(self):
        self.assertEqual(self.client.get("/enterprise/console/").status_code, 302)
        self.client.force_login(self.registrar)
        self.assertEqual(self.client.get("/enterprise/console/").status_code, 403)
        self.client.force_login(self.owner)
        self.assertEqual(self.client.post("/enterprise/console/").status_code, 405)

    def test_owner_can_inspect_user_and_group_permissions_without_management_link(self):
        self.client.force_login(self.owner)
        response = self.client.get("/enterprise/console/", {"user": self.registrar.pk})
        self.assertContains(response, "synthetic-factory")
        self.assertContains(response, "Windows 与 SSH 权限")
        self.assertContains(response, "工厂登记员")
        self.assertNotContains(response, 'href="/admin/auth/user/"')
        self.assertNotContains(response, 'value="secret"')
        self.assertEqual(self.client.get("/enterprise/console/", {"user": "invalid"}).status_code, 404)
        self.assertEqual(self.client.get("/enterprise/console/", {"user": 999999}).status_code, 404)

    def test_staff_owner_retains_existing_admin_entry(self):
        self.owner.is_staff = True
        self.owner.save(update_fields=["is_staff"])
        self.client.force_login(self.owner)
        self.assertContains(self.client.get("/enterprise/console/"), 'href="/admin/auth/user/"')

    def test_technician_gets_operations_without_account_inventory_or_credential_form(self):
        technician = get_user_model().objects.create_user("synthetic-technician")
        from enterprise_portal.models import EnterpriseEntry
        permission, _ = Permission.objects.get_or_create(
            codename="use_server_operations",
            content_type=ContentType.objects.get_for_model(EnterpriseEntry),
            defaults={"name": "Synthetic operations permission"},
        )
        technician.user_permissions.add(permission)
        self.client.force_login(technician)
        response = self.client.get("/enterprise/console/")
        self.assertEqual(response.status_code, 200)
        self.assertNotContains(response, "synthetic-owner")
        self.assertNotContains(response, 'id="accounts"')
        self.assertContains(response, 'data-can-manage="false"')

    def test_registrar_cannot_enter_even_with_staff_or_superuser_flag(self):
        self.registrar.is_staff = True
        self.registrar.is_superuser = True
        self.registrar.save(update_fields=["is_staff", "is_superuser"])
        self.client.force_login(self.registrar)
        self.assertEqual(self.client.get("/enterprise/console/").status_code, 403)

    def test_owner_selects_group_matrix_and_sees_real_permission_sources(self):
        factory = Group.objects.create(name="工厂:矩阵合成")
        self.registrar.groups.add(factory)
        self.client.force_login(self.owner)
        response = self.client.get("/enterprise/console/", {"group": factory.pk, "user": self.registrar.pk})
        self.assertContains(response, "用户组权限矩阵")
        self.assertContains(response, "工厂范围组")
        self.assertContains(response, "所选账号的授权来源")
        self.assertContains(response, "enterprise_portal.add_enterpriseentry")
        rows = {row["key"]: row for row in response.context["group_projection"]["rows"]}
        self.assertFalse(rows["records"]["read"])
        self.assertFalse(rows["operations"]["read"])
        self.assertEqual(self.client.get("/enterprise/console/", {"group": "invalid"}).status_code, 404)

    def test_group_projection_reuses_actual_policy_not_group_name(self):
        from .policy import group_permission_projection, permission_rows
        group = Group.objects.create(name="自定义:合成")
        user = get_user_model().objects.create_user("synthetic-projection")
        user.groups.add(group)
        self.assertEqual(group_permission_projection(group)["rows"], permission_rows(user))
        group.permissions.add(Permission.objects.get(codename="use_server_operations"))
        fresh = get_user_model().objects.get(pk=user.pk)
        self.assertEqual(group_permission_projection(group)["rows"], permission_rows(fresh))
        self.assertTrue(next(row for row in permission_rows(fresh) if row["key"] == "operations")["read"])
        # A fixed role whose explicit grants were removed must not regain them by previewing it.
        owner_group = Group.objects.get(name="企业老板")
        owner_group.permissions.clear()
        self.assertFalse(next(row for row in group_permission_projection(owner_group)["rows"] if row["key"] == "operations")["read"])

    def test_owner_scope_does_not_imply_record_read_permission(self):
        from .policy import permission_rows, visible_entries
        group = Group.objects.get(name="企业老板")
        group.permissions.remove(Permission.objects.get(codename="view_enterpriseentry"))
        user = get_user_model().objects.get(pk=self.owner.pk)
        row = next(row for row in permission_rows(user) if row["key"] == "factories")
        self.assertFalse(row["read"])
        self.assertTrue(row["write"])
        self.assertFalse(visible_entries(user).exists())

    def test_technician_cannot_request_or_enumerate_group_projection(self):
        technician = get_user_model().objects.create_user("synthetic-group-tech")
        technician.user_permissions.add(Permission.objects.get(codename="use_server_operations"))
        self.client.force_login(technician)
        response = self.client.get("/enterprise/console/")
        self.assertNotContains(response, 'id="group-permissions"')
        self.assertNotContains(response, "查看用户组与成员")
        self.assertEqual(self.client.get("/enterprise/console/", {"group": Group.objects.first().pk}).status_code, 403)
        self.client.force_login(self.registrar)
        self.assertEqual(self.client.get("/enterprise/console/", {"group": Group.objects.first().pk}).status_code, 403)
