import hashlib
import uuid
from datetime import date

from django.contrib.auth import get_user_model
from django.contrib.auth.models import Group, Permission
from django.core.management import call_command
from django.test import TestCase
from django.utils import timezone

from workbench.models import (Task, Product, Customer, CustomerAlias, CustomerEvent,
    IntakeSourceVersion, WorkbookSnapshot, IntakeMappingRevision, IntakeCandidate)


class EnterpriseBusinessTests(TestCase):
    @classmethod
    def setUpTestData(cls):
        call_command("configure_enterprise_groups", verbosity=0)
        User = get_user_model()
        cls.owner = User.objects.create_user("synthetic-business-owner")
        cls.owner.groups.add(Group.objects.get(name="企业老板"))
        cls.registrar = User.objects.create_user("synthetic-business-factory")
        cls.registrar.groups.add(Group.objects.get(name="工厂登记员"))
        cls.tech = User.objects.create_user("synthetic-business-local-tech", password=None)
        for user in (cls.registrar, cls.tech):
            user.user_permissions.add(*Permission.objects.filter(codename__in=["view_business_data", "view_customer", "view_customerevent", "use_server_operations"]))
        now = timezone.now()
        cls.task = Task.objects.create(title="合成敏感批次", mode="qa", status="ready", created_at=now, updated_at=now)
        Product.objects.create(task=cls.task, position=1, sku="SYNTHETIC-ONLY", name="合成敏感商品", category="QA", material="测试", size="小", color="蓝", image_filename="private-path-never-returned", created_at=now, updated_at=now)

    @staticmethod
    def quote(fields=None, schema=1):
        token = uuid.uuid4().hex
        digest = hashlib.sha256(token.encode()).hexdigest()
        party = "synthetic-party-" + token
        customer = Customer.objects.create(display_name="合成敏感客户")
        source = IntakeSourceVersion.objects.create(sha256=digest, storage_key=token, original_name="private-source", byte_size=1, mime_type="test")
        snapshot = WorkbookSnapshot.objects.create(source=source, parser_version="qa", status="ready")
        mapping = IntakeMappingRevision.objects.create(snapshot=snapshot, source_sha256=digest, candidate_type="commercial_source", schema_version=1, revision=1, mapping={}, mapping_sha256=digest, idempotency_key=token)
        payload = {"schema_version": schema, "candidate_type": "commercial_source", "fields": {
            "party_text": [{"state": "present", "type": "text", "value": party}],
            "unit_price": [{"state": "present", "type": "decimal", "value": "12.50"}],
            "amount": [{"state": "present", "type": "decimal", "value": "125.00"}],
            "currency": [{"state": "present", "type": "text", "value": "USD"}],
            "notes": [{"state": "present", "type": "text", "value": "private-notes-never-returned"}],
            **(fields or {}),
        }}
        candidate = IntakeCandidate.objects.create(mapping_revision=mapping, source_sha256=digest, candidate_type="commercial_source", schema_version=1, typed_payload=payload, provenance={"secret": "private-provenance"}, idempotency_key=token)
        alias = CustomerAlias.objects.create(customer=customer, source_candidate=candidate, raw_text=party, normalized_text=party, decision="confirmed")
        event = CustomerEvent.objects.create(customer=customer, alias=alias, source_candidate=candidate, event_type="quotation", occurred_on=date.today(), payload=payload, source_refs={"secret": "private-source-refs"}, dedupe_key=digest)
        return event, mapping

    def test_owner_real_projection_whitelist_and_no_write_surface(self):
        event, _ = self.quote()
        self.client.force_login(self.owner)
        response = self.client.get("/enterprise/business/products/")
        self.assertContains(response, "SYNTHETIC-ONLY")
        self.assertNotContains(response, "private-path")
        quote = self.client.get("/enterprise/business/quotations/")
        from .business import quotation_rows
        row = quotation_rows()[0]
        self.assertEqual(row["unit_price"], "12.50")
        self.assertEqual(row["amount"], "125.00")
        self.assertEqual(set(row), {"id", "customer_name", "occurred_on", "unit_price", "amount", "currency"})
        self.assertNotContains(quote, "private-")
        self.assertIn("no-store", quote["Cache-Control"])
        self.assertContains(self.client.get("/enterprise/business/customers/"), "合成敏感客户")
        self.assertEqual(self.client.post("/enterprise/business/quotations/", {}).status_code, 405)
        self.assertEqual(self.client.get("/enterprise/business/quotations/?fields=payload").status_code, 400)
        self.assertEqual(CustomerEvent.objects.count(), 1)

    def test_factory_and_ops_deny_even_with_accidental_read_grants(self):
        self.quote()
        for user in (self.registrar, self.tech):
            self.client.force_login(user)
            for kind in ("products", "customers", "quotations"):
                self.assertEqual(self.client.get(f"/enterprise/business/{kind}/").status_code, 403)
                self.assertEqual(self.client.get(f"/api/enterprise/business/{kind}/").status_code, 404)
            self.assertNotContains(self.client.get("/enterprise/"), "合成敏感")
            self.assertEqual(self.client.get("/api/agents/customer").status_code, 404)
        self.client.logout()
        self.assertEqual(self.client.get("/enterprise/business/products/").status_code, 302)
        self.owner.groups.add(Group.objects.get(name="服务运维员"))
        self.client.force_login(self.owner)
        for kind in ("products", "customers", "quotations"):
            self.assertEqual(self.client.get(f"/enterprise/business/{kind}/").status_code, 403)

    def test_explicit_read_grants_are_separate_and_revocable(self):
        reader = get_user_model().objects.create_user("synthetic-business-reader")
        reader.user_permissions.add(Permission.objects.get(codename="view_business_data"))
        self.client.force_login(reader)
        self.assertEqual(self.client.get("/enterprise/business/products/").status_code, 200)
        self.assertEqual(self.client.get("/enterprise/business/customers/").status_code, 403)
        reader.user_permissions.add(Permission.objects.get(codename="view_customer"))
        self.assertEqual(self.client.get("/enterprise/business/customers/").status_code, 200)
        self.assertEqual(self.client.get("/enterprise/business/quotations/").status_code, 403)
        reader.user_permissions.add(Permission.objects.get(codename="view_customerevent"))
        self.assertEqual(self.client.get("/enterprise/business/quotations/").status_code, 200)
        reader.user_permissions.clear()
        self.assertEqual(self.client.get("/enterprise/business/products/").status_code, 403)

    def test_uncertain_stale_or_bad_numeric_snapshots_are_skipped(self):
        for value in ("NaN", "Infinity", "1e3", "1,234", True):
            self.quote({"unit_price": [{"state": "present", "type": "decimal", "value": value}]})
        self.quote({"unit_price": [{"state": "unknown", "type": "decimal", "value": "1"}]})
        self.quote({"amount": [{"state": "present", "type": "decimal", "value": "1"}] * 2})
        self.quote(schema=2)
        _, mapping = self.quote()
        IntakeMappingRevision.objects.create(snapshot=mapping.snapshot, source_sha256=mapping.source_sha256, candidate_type="commercial_source", schema_version=1, revision=2, mapping={}, mapping_sha256=mapping.mapping_sha256, idempotency_key=uuid.uuid4().hex)
        event, _ = self.quote()
        CustomerAlias.objects.filter(pk=event.alias_id).update(decision="rejected", customer=None)
        self.client.force_login(self.owner)
        from .business import quotation_rows
        self.assertEqual(quotation_rows(), [])
