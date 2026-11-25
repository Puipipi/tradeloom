from unittest.mock import patch

from django.contrib.auth.models import Group, Permission, User
from django.test import TestCase

from workbench.models import IntakeCandidate, IntakeMappingRevision, IntakeSourceVersion, WorkbookSnapshot

from enterprise_portal.email_login import VERIFIED, fingerprint
from enterprise_portal.models import WebsiteNotice


class MobileOrderPortalTests(TestCase):
    def setUp(self):
        WebsiteNotice.objects.get_or_create(pk=1)
        self.business = Permission.objects.get(content_type__app_label="enterprise_portal", codename="view_business_data")
        self.customer = Permission.objects.get(content_type__app_label="workbench", codename="view_customer")
        self.customer_events = Permission.objects.get(content_type__app_label="workbench", codename="view_customerevent")
        self.server_ops = Permission.objects.get(content_type__app_label="enterprise_portal", codename="use_server_operations")

    def make_user(self, username, permissions=(), groups=()):
        user = User.objects.create_user(username=username, password="test-password", email=f"{username}@example.test")
        if permissions:
            user.user_permissions.add(*permissions)
        for name in groups:
            group, _ = Group.objects.get_or_create(name=name)
            user.groups.add(group)
        return user

    def log_in_verified(self, user):
        self.client.force_login(user)
        session = self.client.session
        session[VERIFIED] = fingerprint(user)
        session.save()

    def add_order_source(self, order_key):
        digest = "a" * 64
        source = IntakeSourceVersion.objects.create(
            sha256=digest, storage_key="synthetic-mobile-order", original_name="synthetic.csv",
            byte_size=1, mime_type="text/csv",
        )
        snapshot = WorkbookSnapshot.objects.create(
            source=source, parser_version="synthetic-test", status="ready", sheet_count=1, cell_count=1,
        )
        mapping = IntakeMappingRevision.objects.create(
            snapshot=snapshot, source_sha256=digest, candidate_type="commercial_source", schema_version=1,
            revision=1, mapping={}, mapping_sha256="b" * 64, idempotency_key="synthetic-mobile-order-mapping",
        )
        fields = {
            "document_reference": ("text", order_key),
            "party_text": ("text", "合成客户"),
            "item_description": ("text", "合成商品"),
            "quantity": ("decimal", "12"),
            "unit": ("text", "件"),
            "unit_price": ("decimal", "21.50"),
            "currency": ("text", "CNY"),
        }
        IntakeCandidate.objects.create(
            mapping_revision=mapping, source_sha256=digest, candidate_type="commercial_source", schema_version=1,
            status="unconfirmed", typed_payload={"fields": {
                name: [{"state": "present", "type": value_type, "value": value}]
                for name, (value_type, value) in fields.items()
            }}, provenance={}, idempotency_key="synthetic-mobile-order-candidate",
        )

    def test_home_link_and_exact_order_query_use_existing_read_contract(self):
        owner_read = Permission.objects.get(content_type__app_label="enterprise_portal", codename="view_all_enterpriseentry")
        user = self.make_user("mobile-owner", [self.business, owner_read], groups=["企业老板"])
        self.log_in_verified(user)
        self.add_order_source("MO-SYNTH-001")

        home = self.client.get("/enterprise/")
        self.assertEqual(home.status_code, 200)
        self.assertContains(home, 'href="/enterprise/business/orders/"')
        self.assertEqual(self.client.get("/enterprise/business/products/").status_code, 200)
        self.assertEqual(self.client.get("/enterprise/business/customers/").status_code, 200)
        self.assertEqual(self.client.get("/enterprise/business/quotations/").status_code, 200)
        page = self.client.get("/enterprise/business/orders/", {"order_key": "MO-SYNTH-001"})
        self.assertEqual(page.status_code, 200)
        self.assertEqual(page["Cache-Control"], "max-age=0, no-cache, no-store, must-revalidate, private")
        self.assertContains(page, "查找一笔订单")

        with patch("workbench.orders_api._client_from_settings", return_value=None) as external_client:
            response = self.client.get("/enterprise/business/api/orders", {"order_key": "MO-SYNTH-001"})
        external_client.assert_called_once_with()
        self.assertEqual(response.status_code, 200)
        self.assertIn("no-store", response["Cache-Control"])
        body = response.json()
        self.assertTrue(body["ok"])
        self.assertEqual(body["order"]["order_key"], "MO-SYNTH-001")
        self.assertEqual(body["order"]["match_status"], "exact_match")
        self.assertEqual(body["order"]["inquiries"][0]["party"], "合成客户")
        self.assertEqual(body["order"]["inquiries"][0]["item_description"], "合成商品")
        self.assertEqual(body["order"]["inquiries"][0]["unit_price"], "21.50")
        self.assertEqual(body["order"]["erpnext"]["status"], "not_configured")

        user.groups.clear()
        self.assertEqual(self.client.get("/enterprise/business/orders/").status_code, 403)
        self.assertEqual(self.client.get("/enterprise/business/api/orders", {"order_key": "MO-SYNTH-001"}).status_code, 403)

    def test_business_and_quotation_permissions_without_owner_role_cannot_read_orders(self):
        user = self.make_user("business-and-quote", [self.business, self.customer, self.customer_events])
        self.log_in_verified(user)
        home = self.client.get("/enterprise/")
        self.assertNotContains(home, 'href="/enterprise/business/orders/"')
        self.assertEqual(self.client.get("/enterprise/business/orders/").status_code, 403)
        self.assertEqual(self.client.get("/enterprise/business/api/orders", {"order_key": "MO-SYNTH-001"}).status_code, 403)

    def test_factory_registrar_is_denied_even_with_direct_business_grants(self):
        user = self.make_user(
            "factory-user", [self.business, self.customer, self.customer_events], groups=["工厂登记员"],
        )
        self.log_in_verified(user)
        self.assertEqual(self.client.get("/enterprise/business/orders/").status_code, 403)
        response = self.client.get("/enterprise/business/api/orders", {"order_key": "MO-SYNTH-001"})
        self.assertEqual(response.status_code, 403)
        self.assertEqual(response.json()["error_code"], "permission_denied")

    def test_operations_role_and_unverified_session_are_denied(self):
        operator = self.make_user(
            "mobile-operator", [self.business, self.customer, self.customer_events, self.server_ops],
        )
        self.log_in_verified(operator)
        self.assertEqual(self.client.get("/enterprise/business/api/orders", {"order_key": "MO-SYNTH-001"}).status_code, 403)

        member = self.make_user("unverified-member", [self.business, self.customer, self.customer_events])
        self.client.force_login(member)
        response = self.client.get("/enterprise/business/api/orders", {"order_key": "MO-SYNTH-001"})
        self.assertEqual(response.status_code, 401)
        self.assertEqual(response.json()["error_code"], "enterprise_session_required")

    def test_direct_page_url_requires_login(self):
        response = self.client.get("/enterprise/business/orders/?order_key=MO-SYNTH-001")
        self.assertEqual(response.status_code, 302)
        self.assertIn("next=%2Fenterprise%2Fbusiness%2Forders%2F%3Forder_key%3DMO-SYNTH-001", response.url)
