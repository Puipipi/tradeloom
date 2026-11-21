from django.test import TestCase
from unittest.mock import patch

from workbench.models import (
    IntakeCandidate, IntakeCandidateLink, IntakeMappingRevision, IntakeSourceVersion, WorkbookSnapshot,
)
from workbench.erpnext.dto import ErpNextRecord
from workbench.orders_api import _erpnext_exact_records, _state


class OrderFollowupApiTests(TestCase):
    def test_section_status_requires_every_record_to_be_confirmed(self):
        self.assertEqual(_state([])["status"], "missing")
        self.assertEqual(_state([{"status": "confirmed"}, {"status": "draft"}])["status"], "needs_confirmation")
        self.assertEqual(_state([{"status": "confirmed"}, {"status": "confirmed"}])["status"], "confirmed")

    def _candidate(self, kind, values, suffix):
        source = IntakeSourceVersion.objects.create(
            sha256=(suffix * 64)[:64], storage_key=f"test-{suffix}",
            original_name=f"{suffix}.xlsx", byte_size=1, mime_type="application/octet-stream",
        )
        snapshot = WorkbookSnapshot.objects.create(
            source=source, parser_version="test", status="succeeded",
        )
        mapping = IntakeMappingRevision.objects.create(
            snapshot=snapshot, source_sha256=source.sha256, candidate_type=kind,
            schema_version=1, revision=1, mapping={}, mapping_sha256=suffix * 64,
            idempotency_key=f"order-test-mapping-{suffix}",
        )
        fields = {key: [{"state": "present", "value": value}] for key, value in values.items()}
        return IntakeCandidate.objects.create(
            mapping_revision=mapping, source_sha256=source.sha256, candidate_type=kind,
            schema_version=1, typed_payload={"fields": fields}, provenance={},
            idempotency_key=f"order-test-candidate-{suffix}",
        )

    def test_exact_order_reference_matches_existing_sources_and_keeps_other_references_separate(self):
        exact_commercial = self._candidate("commercial_source", {"document_reference": "SO-100"}, "a")
        exact_instruction = self._candidate("production_instruction", {"source_order_reference": "SO-100"}, "b")
        near_instruction = self._candidate("production_instruction", {"source_order_reference": "SO-1000"}, "c")
        counts = (IntakeCandidate.objects.count(),)

        response = self.client.get("/api/orders", {"order_key": "SO-100"})

        self.assertEqual(response.status_code, 200)
        order = response.json()["order"]
        self.assertEqual(order["match_status"], "exact_match")
        self.assertEqual(order["order_key"], "SO-100")
        self.assertEqual({row["id"] for row in order["candidates"]}, {exact_commercial.pk, exact_instruction.pk})
        self.assertNotIn(near_instruction.pk, {row["id"] for row in order["candidates"]})
        self.assertEqual(order["requirements"]["status"], "missing")
        self.assertEqual(order["purchase_plans"]["status"], "missing")
        self.assertEqual(order["material_receipts"]["status"], "missing")
        self.assertEqual(order["production_handoff"]["status"], "missing")
        self.assertEqual(order["shipment_payments"]["status"], "missing")
        self.assertEqual(IntakeCandidate.objects.count(), counts[0])

    def test_query_must_be_single_exact_unpadded_reference(self):
        self.assertEqual(self.client.get("/api/orders").status_code, 422)
        self.assertEqual(self.client.get("/api/orders", {"order_key": " SO-100"}).status_code, 422)

    def test_same_named_purchase_order_is_not_treated_as_linked_sales_order(self):
        class FakeClient:
            site_url = "https://erp.example.test"

            def get_record(self, doctype, name):
                self.assertions.append((doctype, name))
                return ErpNextRecord(doctype, {"name": name}, {
                    "system": "erpnext", "instance_id": "fixture", "doctype": doctype,
                    "name": name, "modified": None,
                })

            assertions = []

        fake = FakeClient()
        with patch("workbench.orders_api._client_from_settings", return_value=fake):
            result = _erpnext_exact_records("SO-100")
        self.assertEqual(result["status"], "matched")
        self.assertEqual([row["doctype"] for row in result["records"]], ["Sales Order"])
        self.assertEqual(result["records"][0]["url"], "https://erp.example.test/app/sales-order/SO-100")
        self.assertEqual(fake.assertions, [("Sales Order", "SO-100")])

    def test_manual_links_are_shown_with_their_decision_without_transitive_expansion(self):
        seed = self._candidate("commercial_source", {"document_reference": "SO-200"}, "d")
        suggested = self._candidate("production_instruction", {"source_order_reference": "OTHER-1"}, "e")
        transitive = self._candidate("production_instruction", {"source_order_reference": "OTHER-2"}, "f")
        IntakeCandidateLink.objects.create(
            left_candidate=seed, right_candidate=suggested,
            decision=IntakeCandidateLink.Decision.SUGGESTED, evidence={}, idempotency_key="order-link-suggested",
        )
        IntakeCandidateLink.objects.create(
            left_candidate=suggested, right_candidate=transitive,
            decision=IntakeCandidateLink.Decision.CONFIRMED, evidence={}, idempotency_key="order-link-transitive",
        )

        order = self.client.get("/api/orders", {"order_key": "SO-200"}).json()["order"]

        candidates = {row["id"]: row for row in order["candidates"]}
        self.assertEqual(candidates[suggested.pk]["relation"], "suggested")
        self.assertEqual(candidates[suggested.pk]["review_status"], "needs_confirmation")
        self.assertNotIn(transitive.pk, candidates)

    def test_orders_page_renders_search_entry(self):
        response = self.client.get("/orders")
        self.assertEqual(response.status_code, 200)
        self.assertContains(response, 'data-testid="order-key-input"')
        self.assertContains(response, 'data-testid="order-followup-results"')
