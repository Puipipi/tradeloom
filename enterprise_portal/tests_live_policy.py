from django.contrib.auth import get_user_model
from django.contrib.auth.models import Group, Permission
from django.db import connection
from django.test import RequestFactory
from django.test.utils import CaptureQueriesContext
from .testing import EmailVerifiedTestCase
from .policy import ui_policy_snapshot, live_policy_context


class LivePolicyTests(EmailVerifiedTestCase):
    def setUp(self):
        super().setUp()
        from django.core.management import call_command
        call_command("configure_enterprise_groups", verbosity=0)
        self.user = get_user_model().objects.create_user("live-owner", password="synthetic-password", email="live@example.invalid")
        self.user.groups.add(Group.objects.get(name="企业老板"))
        self.client.force_login(self.user)

    def test_minimal_same_origin_policy_has_no_business_or_credentials_and_stable_revision(self):
        first = self.client.get("/enterprise/capabilities/?ui=1").json()
        self.assertEqual(len(first["ui_revision"]), 64)
        self.assertEqual(first, self.client.get("/enterprise/capabilities/?ui=1").json())
        self.assertNotIn("permission_rows", first)
        self.assertNotIn("credentials", first)
        self.assertTrue(first["authentication"]["email_verified"])
        self.assertIn("permission_rows", self.client.get("/enterprise/capabilities/").json())
        self.assertEqual(self.client.get("/enterprise/capabilities/?ui=2").status_code, 400)
        with CaptureQueriesContext(connection) as queries:
            self.client.get("/enterprise/capabilities/?ui=1")
        for query in queries:
            self.assertNotIn('"workbench_product"', query["sql"])
            self.assertNotIn('"workbench_customer"', query["sql"])

    def test_role_and_factory_scope_changes_are_detected_without_changing_credentials(self):
        original = ui_policy_snapshot(get_user_model().objects.get(pk=self.user.pk))
        self.user.groups.add(Group.objects.get(name="工厂登记员"))
        revoked = self.client.get("/enterprise/capabilities/?ui=1").json()
        self.assertNotEqual(original["ui_revision"], revoked["ui_revision"])
        self.assertFalse(revoked["capabilities"]["local_workbench"])
        self.assertFalse(revoked["console_access"])
        group = Group.objects.create(name="工厂:Live-A")
        self.user.groups.add(group)
        scoped = self.client.get("/enterprise/capabilities/?ui=1").json()
        self.assertNotEqual(revoked["ui_revision"], scoped["ui_revision"])
        self.assertEqual(revoked["capabilities"], scoped["capabilities"])
        self.user.groups.remove(group, Group.objects.get(name="工厂登记员"))
        restored = self.client.get("/enterprise/capabilities/?ui=1").json()
        self.assertEqual(original["ui_revision"], restored["ui_revision"])

    def test_server_pages_embed_current_snapshot_and_local_scope_is_not_expanded(self):
        revision = self.client.get("/enterprise/capabilities/?ui=1").json()["ui_revision"]
        for url in ["/enterprise/", "/enterprise/console/", "/enterprise/business/products/"]:
            response = self.client.get(url)
            self.assertContains(response, revision)
            self.assertContains(response, "live-permissions.js")
        request = RequestFactory().get("/enterprise/console/")
        request.user = self.user
        request.session = {"_tradeloom_local_console": 1}
        self.assertEqual(live_policy_context(request), {})

    def test_html_revision_is_captured_before_view_data_decisions(self):
        from .middleware import LivePolicySnapshotMiddleware
        request = RequestFactory().get("/enterprise/")
        request.user = get_user_model().objects.get(pk=self.user.pk)
        request.session = {}
        original = ui_policy_snapshot(request.user)["ui_revision"]
        def view(req):
            self.user.groups.add(Group.objects.get(name="工厂登记员"))
            return live_policy_context(req)
        context = LivePolicySnapshotMiddleware(view)(request)
        self.assertEqual(context["enterprise_policy_revision"], original)
        self.assertNotEqual(original, ui_policy_snapshot(get_user_model().objects.get(pk=self.user.pk))["ui_revision"])
