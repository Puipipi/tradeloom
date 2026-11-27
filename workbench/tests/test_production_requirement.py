from __future__ import annotations

import json
from io import BytesIO
from pathlib import Path
from tempfile import TemporaryDirectory
from threading import Barrier, Thread
from queue import Queue
from types import SimpleNamespace

from django.core.files.uploadedfile import SimpleUploadedFile
from django.core.exceptions import ValidationError
from django.db import IntegrityError, transaction, close_old_connections
from django.test import Client, TransactionTestCase, override_settings
from openpyxl import Workbook

from workbench.intake.storage import INTAKE_MARKER, INTAKE_MARKER_CONTENT
from workbench.models import (BatchItem, EvidenceRecord, ErpNextDraftOperation, IntakeCandidate,
                              ProductionRequirementDraft, ProductionRequirementRevision)
from workbench.requirements.calculations import packaging_check, source_arithmetic_check


class ProductionRequirementApiTests(TransactionTestCase):
    def setUp(self):
        self.temp = TemporaryDirectory()
        self.data_root = Path(self.temp.name) / "data"
        self.intake_root = self.data_root / "private" / "intake"
        self.intake_root.mkdir(parents=True)
        (self.intake_root / INTAKE_MARKER).write_text(INTAKE_MARKER_CONTENT, encoding="utf-8")
        self.settings_override = override_settings(
            TRADELOOM_DATA_ROOT=self.data_root,
            TRADELOOM_INTAKE_ROOT=self.intake_root,
        )
        self.settings_override.enable()
        self.client = Client()

    def tearDown(self):
        self.settings_override.disable()
        self.temp.cleanup()

    @staticmethod
    def _synthetic_xlsx(quantity="10", description="Synthetic requirement description", marker="fixture"):
        workbook = Workbook()
        sheet = workbook.active
        sheet["A1"] = description
        sheet["A2"] = int(quantity) if quantity.isdigit() else float(quantity)
        sheet["A3"] = 4
        sheet["A4"] = 2
        sheet["A5"] = "unit-x"
        sheet["A6"] = "pack-x"
        sheet["A7"] = "Synthetic source requirement"
        sheet["Z1"] = marker
        output = BytesIO()
        workbook.save(output)
        workbook.close()
        return output.getvalue()

    def create_production_candidate(self, suffix="one", *, quantity_cells=None, quantity="10",
                                    description="Synthetic requirement description"):
        source_response = self.client.post(
            "/api/intake/sources",
            {"file": SimpleUploadedFile(f"{suffix}.xlsx", self._synthetic_xlsx(quantity, description, suffix), "application/octet-stream")},
            HTTP_IDEMPOTENCY_KEY=f"requirement-source-{suffix}",
        )
        self.assertEqual(source_response.status_code, 201, source_response.content)
        source = source_response.json()["source"]
        preview_response = self.client.post(
            f"/api/intake/sources/{source['id']}/previews", data="{}", content_type="application/json",
            HTTP_IDEMPOTENCY_KEY=f"requirement-preview-{suffix}",
        )
        self.assertEqual(preview_response.status_code, 201, preview_response.content)
        preview = preview_response.json()["preview"]
        fields = {
            "description": {"cells": [{"sheet_index": 1, "coordinate": "A1"}]},
            "quantity": {"cells": quantity_cells or [{"sheet_index": 1, "coordinate": "A2"}]},
            "unit": {"cells": [{"sheet_index": 1, "coordinate": "A5"}]},
            "carton_count": {"cells": [{"sheet_index": 1, "coordinate": "A4"}]},
            "requirement_text": {"cells": [{"sheet_index": 1, "coordinate": "A7"}]},
            "pack_quantity": {"cells": [{"sheet_index": 1, "coordinate": "A3"}]},
            "pack_unit": {"cells": [{"sheet_index": 1, "coordinate": "A6"}]},
        }
        mapping = {
            "schema_version": 1,
            "candidate_type": "production_instruction",
            "source_sha256": source["sha256"],
            "expected_revision": 0,
            "fields": fields,
        }
        mapping_response = self.client.post(
            f"/api/intake/previews/{preview['id']}/mappings", data=json.dumps(mapping),
            content_type="application/json", HTTP_IDEMPOTENCY_KEY=f"requirement-mapping-{suffix}",
        )
        self.assertEqual(mapping_response.status_code, 201, mapping_response.content)
        candidate_response = self.client.post(
            f"/api/intake/mappings/{mapping_response.json()['mapping']['id']}/candidates", data="{}",
            content_type="application/json", HTTP_IDEMPOTENCY_KEY=f"requirement-candidate-{suffix}",
        )
        self.assertEqual(candidate_response.status_code, 201, candidate_response.content)
        return source, preview, candidate_response.json()["candidate"]

    def test_explicit_historical_reference_draft_is_idempotent_and_keeps_source_arithmetic_unverified(self):
        _source, _preview, candidate = self.create_production_candidate("historical")
        products_before = BatchItem.objects.count()
        erp_operations_before = ErpNextDraftOperation.objects.count()
        path = f"/api/intake/candidates/{candidate['id']}/requirement-drafts"
        body = {"record_kind": "historical_reference"}

        created = self.client.post(
            path, data=json.dumps(body), content_type="application/json",
            HTTP_IDEMPOTENCY_KEY="requirement-create-historical-001",
        )
        self.assertEqual(created.status_code, 201, created.content)
        payload = created.json()
        self.assertEqual(payload["status"], "succeeded")
        draft = payload["draft"]
        revision = payload["revision"]
        self.assertEqual(draft["record_kind"], "historical_reference")
        self.assertEqual(draft["status"], "needs_confirmation")
        self.assertEqual(revision["revision"], 1)
        self.assertEqual(revision["fields"]["quantity"], "10")
        self.assertEqual(revision["fields"]["pack_quantity"], "4")
        self.assertEqual(revision["fields"]["carton_count"], "2")
        self.assertEqual(payload["source_arithmetic_check"], {
            "state": "calculated", "whole_packages": "2", "remainder": "2", "source_carton_count": "2",
        })
        self.assertEqual(payload["packaging_check"], "needs_confirmation")

        replay = self.client.post(
            path, data=json.dumps(body), content_type="application/json",
            HTTP_IDEMPOTENCY_KEY="requirement-create-historical-001",
        )
        self.assertEqual(replay.status_code, 200, replay.content)
        self.assertEqual(replay.json()["draft"]["id"], draft["id"])
        self.assertEqual(replay.json()["revision"]["id"], revision["id"])
        different_payload = self.client.post(
            path, data=json.dumps({"record_kind": "new_demand"}), content_type="application/json",
            HTTP_IDEMPOTENCY_KEY="requirement-create-historical-001",
        )
        self.assertEqual(different_payload.status_code, 409, different_payload.content)
        self.assertEqual(BatchItem.objects.count(), products_before)
        self.assertEqual(ErpNextDraftOperation.objects.count(), erp_operations_before)

    def test_draft_lookup_and_bounded_revision_history_are_read_only(self):
        candidate, created = self._create_draft("ui-history")
        requirement_id = created["draft"]["id"]
        candidate_path = f"/api/intake/candidates/{candidate['id']}/requirement-drafts"
        lookup = self.client.get(candidate_path)
        self.assertEqual(lookup.status_code, 200, lookup.content)
        self.assertEqual(lookup.json()["requirement"]["draft"]["id"], requirement_id)
        self.assertEqual(lookup.json()["requirement"]["revision"]["revision"], 1)

        changed = self.client.post(
            f"/api/production-requirements/{requirement_id}/revisions",
            data=json.dumps({"expected_revision": 1, "fields": {"description": "Synthetic revised description", "quantity": "32"}, "field_sources": {}}),
            content_type="application/json", HTTP_IDEMPOTENCY_KEY="requirement-ui-history-revision-001",
        )
        self.assertEqual(changed.status_code, 201, changed.content)

        history_path = f"/api/production-requirements/{requirement_id}/revisions"
        first = self.client.get(f"{history_path}?offset=0&limit=1")
        self.assertEqual(first.status_code, 200, first.content)
        self.assertEqual(first.json()["current_revision"], 2)
        self.assertEqual(first.json()["revisions"][0]["revision"], 2)
        self.assertEqual(first.json()["revisions"][0]["source_arithmetic_check"]["whole_packages"], "8")
        self.assertEqual(first.json()["next_offset"], 1)
        second = self.client.get(f"{history_path}?offset=1&limit=1")
        self.assertEqual(second.json()["revisions"][0]["revision"], 1)
        self.assertEqual(second.json()["revisions"][0]["source_arithmetic_check"]["whole_packages"], "2")
        self.assertIsNone(second.json()["next_offset"])
        invalid = self.client.get(f"{history_path}?offset=0&limit=21")
        self.assertEqual(invalid.status_code, 422)
        self.assertEqual(self.client.get(f"{history_path}?limit=1&extra=x").status_code, 422)
        for query in ("limit=0", "offset=-1", "limit=1&limit=2", "offset=01", "offset=100001"):
            self.assertEqual(self.client.get(f"{history_path}?{query}").status_code, 422)

        empty_candidate = self.create_production_candidate("ui-history-empty")[2]
        empty = self.client.get(f"/api/intake/candidates/{empty_candidate['id']}/requirement-drafts")
        self.assertEqual(empty.status_code, 200, empty.content)
        self.assertIsNone(empty.json()["requirement"])

    def _create_draft(self, suffix="draft", *, quantity="10"):
        _source, _preview, candidate = self.create_production_candidate(suffix, quantity=quantity)
        response = self.client.post(
            f"/api/intake/candidates/{candidate['id']}/requirement-drafts",
            data=json.dumps({"record_kind": "new_demand"}), content_type="application/json",
            HTTP_IDEMPOTENCY_KEY=f"requirement-create-{suffix}",
        )
        self.assertEqual(response.status_code, 201, response.content)
        return candidate, response.json()

    def test_revision_is_append_only_requires_evidence_and_uses_receipt_idempotency(self):
        _candidate, created = self._create_draft("revision")
        draft_id = created["draft"]["id"]
        original_revision = created["revision"]
        body = {"expected_revision": 1, "fields": {"quantity": "11"}, "field_sources": {}}
        path = f"/api/production-requirements/{draft_id}/revisions"
        response = self.client.post(path, data=json.dumps(body), content_type="application/json",
                                    HTTP_IDEMPOTENCY_KEY="requirement-revision-001")
        self.assertEqual(response.status_code, 201, response.content)
        changed = response.json()
        self.assertEqual(changed["revision"]["revision"], 2)
        self.assertEqual(changed["revision"]["fields"]["quantity"], "11")
        self.assertIn("quantity", changed["revision"]["unresolved_fields"])
        self.assertEqual(original_revision["fields"]["quantity"], "10")

        replay = self.client.post(path, data=json.dumps(body), content_type="application/json",
                                  HTTP_IDEMPOTENCY_KEY="requirement-revision-001")
        self.assertEqual(replay.status_code, 200, replay.content)
        self.assertEqual(replay.json()["revision"]["id"], changed["revision"]["id"])
        changed_body = {**body, "fields": {"quantity": "12"}}
        conflict = self.client.post(path, data=json.dumps(changed_body), content_type="application/json",
                                    HTTP_IDEMPOTENCY_KEY="requirement-revision-001")
        self.assertEqual(conflict.status_code, 409, conflict.content)

        stale = self.client.post(path, data=json.dumps(body), content_type="application/json",
                                 HTTP_IDEMPOTENCY_KEY="requirement-revision-stale-001")
        self.assertEqual(stale.status_code, 409, stale.content)
        latest = self.client.get(f"/api/production-requirements/{draft_id}")
        self.assertEqual(latest.status_code, 200, latest.content)
        self.assertEqual(latest.json()["revision"]["revision"], 2)

        rejected = self.client.post(
            f"/api/production-requirements/{draft_id}/confirm",
            data=json.dumps({"expected_revision": 2}), content_type="application/json",
            HTTP_IDEMPOTENCY_KEY="requirement-confirm-unresolved-001",
        )
        self.assertEqual(rejected.status_code, 409, rejected.content)
        self.assertIn("quantity", self.client.get(f"/api/production-requirements/{draft_id}").json()
                      ["revision"]["unresolved_fields"])

    def test_source_record_revision_must_match_exact_candidate_field_value(self):
        _candidate, created = self._create_draft("source-mismatch")
        draft_id = created["draft"]["id"]
        source_id = created["revision"]["source_refs"]["quantity"][0]["snapshot_id"]
        body = {
            "expected_revision": 1,
            "fields": {"quantity": "11"},
            "field_sources": {"quantity": [{"kind": "source_record", "field_key": "quantity",
                "snapshot_id": source_id, "sheet_index": 1, "coordinate": "A2"}]},
        }
        response = self.client.post(
            f"/api/production-requirements/{draft_id}/revisions", data=json.dumps(body),
            content_type="application/json", HTTP_IDEMPOTENCY_KEY="requirement-revision-source-mismatch-001",
        )
        self.assertEqual(response.status_code, 422, response.content)
        self.assertEqual(self.client.get(f"/api/production-requirements/{draft_id}").json()
                         ["revision"]["revision"], 1)

    def test_source_record_must_match_the_field_provenance_not_just_the_snapshot(self):
        _candidate, created = self._create_draft("wrong-field-source")
        draft_id = created["draft"]["id"]
        snapshot_id = created["revision"]["source_refs"]["quantity"][0]["snapshot_id"]
        body = {
            "expected_revision": 1, "fields": {"quantity": "10"},
            "field_sources": {"quantity": [{"kind": "source_record", "field_key": "quantity",
                "snapshot_id": snapshot_id, "sheet_index": 1, "coordinate": "A1"}]},
        }
        response = self.client.post(
            f"/api/production-requirements/{draft_id}/revisions", data=json.dumps(body),
            content_type="application/json", HTTP_IDEMPOTENCY_KEY="requirement-revision-wrong-field-001",
        )
        self.assertEqual(response.status_code, 422, response.content)
        self.assertEqual(self.client.get(f"/api/production-requirements/{draft_id}").json()
                         ["revision"]["revision"], 1)

    def test_evidence_descriptor_field_key_must_match_outer_field_source_key(self):
        _candidate, created = self._create_draft("descriptor-field-key-mismatch")
        draft_id = created["draft"]["id"]
        before_revision_count = ProductionRequirementRevision.objects.filter(draft_id=draft_id).count()
        before_evidence_count = EvidenceRecord.objects.filter(requirement_revision__draft_id=draft_id).count()
        body = {
            "expected_revision": 1,
            "fields": {"description": "Changed synthetic description"},
            "field_sources": {"description": [{
                "kind": "team_hypothesis", "field_key": "quantity",
                "summary": "Synthetic mismatched field descriptor", "input_record_ids": [],
            }]},
        }
        response = self.client.post(
            f"/api/production-requirements/{draft_id}/revisions",
            data=json.dumps(body), content_type="application/json",
            HTTP_IDEMPOTENCY_KEY="requirement-revision-descriptor-field-mismatch-001",
        )
        self.assertEqual(response.status_code, 422, response.content)
        self.assertEqual(ProductionRequirementRevision.objects.filter(draft_id=draft_id).count(),
                         before_revision_count)
        self.assertEqual(EvidenceRecord.objects.filter(requirement_revision__draft_id=draft_id).count(),
                         before_evidence_count)
        self.assertEqual(self.client.get(f"/api/production-requirements/{draft_id}").json()
                         ["revision"]["revision"], 1)

    def test_unknown_quantity_remains_unresolved_while_explicit_zero_is_preserved(self):
        _candidate, created = self._create_draft("explicit-zero", quantity="0")
        fields = created["revision"]["fields"]
        self.assertEqual(fields["quantity"], "0")
        self.assertNotIn("quantity", created["revision"]["unresolved_fields"])
        arithmetic = created["source_arithmetic_check"]
        self.assertEqual(arithmetic, {
            "state": "calculated", "whole_packages": "0", "remainder": "0", "source_carton_count": "2",
        })
        self.assertIn("source_order_reference", created["revision"]["unresolved_fields"])

    def test_source_value_outside_requirement_schema_stays_unresolved_with_locator(self):
        _source, _preview, candidate = self.create_production_candidate(
            "overlong-description", description="x" * 501,
        )
        self.assertEqual(candidate["fields"]["description"][0]["state"], "present")
        response = self.client.post(
            f"/api/intake/candidates/{candidate['id']}/requirement-drafts",
            data=json.dumps({"record_kind": "historical_reference"}), content_type="application/json",
            HTTP_IDEMPOTENCY_KEY="requirement-create-overlong-description-001",
        )
        self.assertEqual(response.status_code, 201, response.content)
        revision = response.json()["revision"]
        self.assertIsNone(revision["fields"]["description"])
        unresolved = revision["unresolved_fields"]["description"]
        self.assertEqual(unresolved["states"], ["source_value_unresolved"])
        self.assertEqual(unresolved["source_refs"], [{"sheet_index": 1, "coordinate": "A1"}])

    def test_multiple_source_values_are_not_selected_or_aggregated(self):
        _source, _preview, candidate = self.create_production_candidate(
            "multiple-quantity-values", quantity_cells=[
                {"sheet_index": 1, "coordinate": "A2"},
                {"sheet_index": 1, "coordinate": "A4"},
            ],
        )
        self.assertEqual(len(candidate["fields"]["quantity"]), 2)
        response = self.client.post(
            f"/api/intake/candidates/{candidate['id']}/requirement-drafts",
            data=json.dumps({"record_kind": "historical_reference"}), content_type="application/json",
            HTTP_IDEMPOTENCY_KEY="requirement-create-multiple-values-001",
        )
        self.assertEqual(response.status_code, 201, response.content)
        revision = response.json()["revision"]
        self.assertIsNone(revision["fields"]["quantity"])
        self.assertEqual(revision["unresolved_fields"]["quantity"]["states"], ["present", "present"])
        self.assertEqual(revision["unresolved_fields"]["quantity"]["source_refs"], [
            {"sheet_index": 1, "coordinate": "A2"}, {"sheet_index": 1, "coordinate": "A4"},
        ])

    def test_operator_reference_cannot_resolve_a_missing_canonical_value(self):
        _candidate, created = self._create_draft("missing-with-reference")
        draft_id = created["draft"]["id"]
        note = self.client.post(
            "/api/intake/narratives",
            {"file": SimpleUploadedFile("synthetic-missing.txt", b"Synthetic reference only.\n", "text/plain")},
            HTTP_IDEMPOTENCY_KEY="requirement-narrative-missing-001",
        )
        self.assertEqual(note.status_code, 201, note.content)
        narrative_id = note.json()["narrative"]["id"]
        body = {
            "expected_revision": 1, "fields": {"description": None},
            "field_sources": {"description": [{"kind": "operator_statement", "field_key": "description",
                "narrative_source_id": narrative_id, "line_start": 1, "line_end": 1}]},
        }
        revision = self.client.post(
            f"/api/production-requirements/{draft_id}/revisions", data=json.dumps(body),
            content_type="application/json", HTTP_IDEMPOTENCY_KEY="requirement-revision-missing-001",
        )
        self.assertEqual(revision.status_code, 201, revision.content)
        self.assertEqual(revision.json()["revision"]["unresolved_fields"]["description"]["states"], ["missing_value"])
        rejected = self.client.post(
            f"/api/production-requirements/{draft_id}/confirm", data=json.dumps({"expected_revision": 2}),
            content_type="application/json", HTTP_IDEMPOTENCY_KEY="requirement-confirm-missing-001",
        )
        self.assertEqual(rejected.status_code, 409, rejected.content)

    def test_decimal_package_remainder_uses_numeric_zero(self):
        fields = {"quantity": "12.0", "pack_quantity": "6", "carton_count": "2.0",
                  "unit": "synthetic-unit", "pack_unit": "synthetic-pack"}
        revision = SimpleNamespace(
            fields=fields, status="confirmed",
            confirmed_unit_pair={"unit": "synthetic-unit", "pack_unit": "synthetic-pack"},
            unresolved_fields={},
        )
        self.assertEqual(source_arithmetic_check(fields), {
            "state": "calculated", "whole_packages": "2", "remainder": "0.0", "source_carton_count": "2.0",
        })
        self.assertEqual(packaging_check(revision), "passed")

    def test_revision_cas_serializes_two_concurrent_updates(self):
        _candidate, created = self._create_draft("cas")
        draft_id = created["draft"]["id"]
        path = f"/api/production-requirements/{draft_id}/revisions"
        barrier = Barrier(2)
        results = Queue()

        def submit(index, quantity):
            close_old_connections()
            client = Client()
            body = {"expected_revision": 1, "fields": {"quantity": quantity}, "field_sources": {}}
            try:
                barrier.wait(timeout=5)
                response = client.post(path, data=json.dumps(body), content_type="application/json",
                                       HTTP_IDEMPOTENCY_KEY=f"requirement-cas-{index}")
                results.put((response.status_code, response.json()))
            except Exception as exc:  # surfaced to the test thread
                results.put(exc)
            finally:
                close_old_connections()

        threads = [Thread(target=submit, args=(1, "12")), Thread(target=submit, args=(2, "13"))]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join(timeout=15)
        self.assertTrue(all(not thread.is_alive() for thread in threads), "CAS worker did not finish")
        responses = [results.get(timeout=2), results.get(timeout=2)]
        errors = [item for item in responses if isinstance(item, Exception)]
        self.assertFalse(errors, errors)
        self.assertEqual(sorted(status for status, _ in responses), [201, 409])
        draft = ProductionRequirementDraft.objects.get(pk=draft_id)
        self.assertEqual(draft.current_revision, 2)
        self.assertEqual(draft.revisions.count(), 2)

    def test_evidence_target_xor_and_revision_rows_are_append_only(self):
        candidate, created = self._create_draft("xor")
        draft_id = created["draft"]["id"]
        revision_id = created["revision"]["id"]
        draft = ProductionRequirementDraft.objects.get(pk=draft_id)
        revision = ProductionRequirementRevision.objects.get(pk=revision_id)
        evidence_values = dict(
            field_key="description", kind=EvidenceRecord.Kind.OPERATOR_STATEMENT,
            status=EvidenceRecord.Status.UNVERIFIED, revision=1, input_record_ids=[],
            summary="synthetic", idempotency_key="xor-invalid-no-target", actor="local_workbench",
        )
        with self.assertRaises(IntegrityError), transaction.atomic():
            EvidenceRecord.objects.bulk_create([EvidenceRecord(**evidence_values)])
        both = dict(evidence_values, idempotency_key="xor-invalid-both-targets", candidate=IntakeCandidate.objects.get(pk=candidate["id"]),
                    requirement_revision=revision)
        with self.assertRaises(IntegrityError), transaction.atomic():
            EvidenceRecord.objects.bulk_create([EvidenceRecord(**both)])
        revision.fields = {**revision.fields, "description": "changed"}
        with self.assertRaises(ValidationError):
            revision.save()

    def test_hypothesis_inputs_are_same_draft_scoped_and_never_confirm_automatically(self):
        _candidate_a, created_a = self._create_draft("input-owner-a")
        _candidate_b, created_b = self._create_draft("input-owner-b")
        draft_a = created_a["draft"]["id"]
        draft_b = created_b["draft"]["id"]
        source_id = created_a["revision"]["source_refs"]["quantity"][0]["id"]
        body = {
            "expected_revision": 1, "fields": {"description": "Proposed synthetic description"},
            "field_sources": {"description": [{"kind": "team_hypothesis", "field_key": "description",
                "summary": "Proposed interpretation only", "input_record_ids": [source_id]}]},
        }
        other_draft = self.client.post(
            f"/api/production-requirements/{draft_b}/revisions", data=json.dumps(body),
            content_type="application/json", HTTP_IDEMPOTENCY_KEY="requirement-hypothesis-cross-draft-001",
        )
        self.assertEqual(other_draft.status_code, 422, other_draft.content)

        same_draft = self.client.post(
            f"/api/production-requirements/{draft_a}/revisions", data=json.dumps(body),
            content_type="application/json", HTTP_IDEMPOTENCY_KEY="requirement-hypothesis-same-draft-001",
        )
        self.assertEqual(same_draft.status_code, 201, same_draft.content)
        result = same_draft.json()["revision"]
        self.assertEqual(result["unresolved_fields"]["description"]["states"], ["unverified_proposal"])
        self.assertEqual(result["source_refs"]["description"][0]["input_record_ids"], [source_id])
        confirm = self.client.post(
            f"/api/production-requirements/{draft_a}/confirm", data=json.dumps({"expected_revision": 2}),
            content_type="application/json", HTTP_IDEMPOTENCY_KEY="requirement-confirm-hypothesis-001",
        )
        self.assertEqual(confirm.status_code, 409, confirm.content)

        missing_rule_version = {
            "expected_revision": 2, "fields": {"quantity": "11"},
            "field_sources": {"quantity": [{"kind": "system_derivation", "field_key": "quantity",
                "rule_id": "quantity.proposal", "input_record_ids": [source_id]}]},
        }
        rejected_rule = self.client.post(
            f"/api/production-requirements/{draft_a}/revisions", data=json.dumps(missing_rule_version),
            content_type="application/json", HTTP_IDEMPOTENCY_KEY="requirement-system-derivation-001",
        )
        self.assertEqual(rejected_rule.status_code, 422, rejected_rule.content)
        valid_rule = {**missing_rule_version, "field_sources": {"quantity": [{
            "kind": "system_derivation", "field_key": "quantity", "rule_id": "quantity.proposal",
            "rule_version": "1.0", "input_record_ids": [source_id],
        }]}}
        derived = self.client.post(
            f"/api/production-requirements/{draft_a}/revisions", data=json.dumps(valid_rule),
            content_type="application/json", HTTP_IDEMPOTENCY_KEY="requirement-system-derivation-001",
        )
        self.assertEqual(derived.status_code, 201, derived.content)
        derived_ref = derived.json()["revision"]["source_refs"]["quantity"][-1]
        self.assertEqual(derived_ref["rule_version"], "1.0")
        self.assertEqual(derived.json()["revision"]["unresolved_fields"]["quantity"]["states"],
                         ["unverified_proposal"])

    def test_operator_evidence_can_be_confirmed_without_creating_product_or_erp_records(self):
        _candidate, created = self._create_draft("confirm", quantity="8")
        draft_id = created["draft"]["id"]
        note = self.client.post(
            "/api/intake/narratives",
            {"file": SimpleUploadedFile("synthetic-note.txt", b"Operator supplied synthetic details.\n",
                                         "text/plain")},
            HTTP_IDEMPOTENCY_KEY="requirement-narrative-001",
        )
        self.assertEqual(note.status_code, 201, note.content)
        narrative_id = note.json()["narrative"]["id"]
        fields = {
            "source_order_reference": "synthetic-ref", "specification": "synthetic-spec",
            "color": "synthetic-color", "packing": "synthetic-packing",
            "barcode_requirement": "synthetic-barcode", "due_date": "2026-10-22",
        }
        field_sources = {name: [{"kind": "operator_statement", "field_key": name,
                                "narrative_source_id": narrative_id, "line_start": 1, "line_end": 1}]
                         for name in fields}
        revision = self.client.post(
            f"/api/production-requirements/{draft_id}/revisions",
            data=json.dumps({"expected_revision": 1, "fields": fields, "field_sources": field_sources}),
            content_type="application/json", HTTP_IDEMPOTENCY_KEY="requirement-revision-operator-001",
        )
        self.assertEqual(revision.status_code, 201, revision.content)
        self.assertFalse(revision.json()["revision"]["unresolved_fields"])
        self.assertEqual(revision.json()["packaging_check"], "needs_confirmation")
        confirmed = self.client.post(
            f"/api/production-requirements/{draft_id}/confirm",
            data=json.dumps({"expected_revision": 2, "confirmed_unit_pair": {"unit": "unit-x", "pack_unit": "pack-x"}}),
            content_type="application/json", HTTP_IDEMPOTENCY_KEY="requirement-confirm-001",
        )
        self.assertEqual(confirmed.status_code, 201, confirmed.content)
        self.assertEqual(confirmed.json()["revision"]["status"], "confirmed")
        self.assertEqual(confirmed.json()["source_arithmetic_check"], {
            "state": "calculated", "whole_packages": "2", "remainder": "0", "source_carton_count": "2",
        })
        self.assertEqual(confirmed.json()["packaging_check"], "passed")
        self.assertEqual(BatchItem.objects.count(), 0)
        self.assertEqual(ErpNextDraftOperation.objects.count(), 0)
