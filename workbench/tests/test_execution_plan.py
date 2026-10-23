from __future__ import annotations

import json
import re
import zipfile
from unittest.mock import patch
from io import BytesIO
from pathlib import Path
from tempfile import TemporaryDirectory

from django.test import Client, TransactionTestCase, override_settings
from django.db import connection
from django.core.files.uploadedfile import SimpleUploadedFile
from django.core.management import call_command
from openpyxl import Workbook

from workbench.intake.storage import INTAKE_MARKER, INTAKE_MARKER_CONTENT
from workbench.models import EvidenceRecord, IntakeCandidate, IntakeOperationReceipt, ProductionRequirementDraft, ProductionRequirementRevision
from workbench.intake.mapping import fingerprint
from workbench.requirements.schemas import REQUIREMENT_FIELDS


class ExecutionPlanApiTests(TransactionTestCase):
    def setUp(self):
        self.temp = TemporaryDirectory()
        self.data_root = Path(self.temp.name) / "data"
        intake_root = self.data_root / "private" / "intake"
        intake_root.mkdir(parents=True)
        (intake_root / INTAKE_MARKER).write_text(INTAKE_MARKER_CONTENT, encoding="utf-8")
        self.settings_override = override_settings(TRADELOOM_DATA_ROOT=self.data_root, TRADELOOM_INTAKE_ROOT=intake_root)
        self.settings_override.enable()
        self.client = Client()

    def tearDown(self):
        self.settings_override.disable()
        self.temp.cleanup()

    @staticmethod
    def _synthetic_xlsx(suffix):
        workbook = Workbook()
        sheet = workbook.active
        sheet["A1"] = "Synthetic requirement description"
        sheet["A2"] = 10
        sheet["A3"] = 4
        sheet["A4"] = 2
        sheet["A5"] = "unit-x"
        sheet["A6"] = "pack-x"
        sheet["A7"] = "Synthetic source requirement"
        sheet["Z1"] = suffix
        output = BytesIO()
        workbook.save(output)
        workbook.close()
        return output.getvalue()

    def create_production_candidate(self, suffix="plan"):
        source_response = self.client.post(
            "/api/intake/sources",
            {"file": SimpleUploadedFile(f"{suffix}.xlsx", self._synthetic_xlsx(suffix), "application/octet-stream")},
            HTTP_IDEMPOTENCY_KEY=f"execution-plan-source-{suffix}",
        )
        self.assertEqual(source_response.status_code, 201, source_response.content)
        source = source_response.json()["source"]
        preview_response = self.client.post(
            f"/api/intake/sources/{source['id']}/previews", data="{}", content_type="application/json",
            HTTP_IDEMPOTENCY_KEY=f"execution-plan-preview-{suffix}",
        )
        self.assertEqual(preview_response.status_code, 201, preview_response.content)
        preview = preview_response.json()["preview"]
        fields = {
            "description": {"cells": [{"sheet_index": 1, "coordinate": "A1"}]},
            "quantity": {"cells": [{"sheet_index": 1, "coordinate": "A2"}]},
            "unit": {"cells": [{"sheet_index": 1, "coordinate": "A5"}]},
            "carton_count": {"cells": [{"sheet_index": 1, "coordinate": "A4"}]},
            "requirement_text": {"cells": [{"sheet_index": 1, "coordinate": "A7"}]},
            "pack_quantity": {"cells": [{"sheet_index": 1, "coordinate": "A3"}]},
            "pack_unit": {"cells": [{"sheet_index": 1, "coordinate": "A6"}]},
        }
        mapping = {"schema_version": 1, "candidate_type": "production_instruction",
                   "source_sha256": source["sha256"], "expected_revision": 0, "fields": fields}
        mapped = self.client.post(
            f"/api/intake/previews/{preview['id']}/mappings", data=json.dumps(mapping),
            content_type="application/json", HTTP_IDEMPOTENCY_KEY=f"execution-plan-mapping-{suffix}",
        )
        self.assertEqual(mapped.status_code, 201, mapped.content)
        candidate = self.client.post(
            f"/api/intake/mappings/{mapped.json()['mapping']['id']}/candidates", data="{}",
            content_type="application/json", HTTP_IDEMPOTENCY_KEY=f"execution-plan-candidate-{suffix}",
        )
        self.assertEqual(candidate.status_code, 201, candidate.content)
        return candidate.json()["candidate"]

    def create_source_reference_candidate(self, candidate_type, suffix):
        workbook = Workbook()
        sheet = workbook.active
        sheet["A1"] = "synthetic source label"
        sheet["A2"] = 0
        sheet["A3"] = "=1/0"
        sheet["A4"] = ""
        output = BytesIO()
        workbook.save(output)
        workbook.close()
        rewritten = BytesIO()
        with zipfile.ZipFile(BytesIO(output.getvalue())) as original, zipfile.ZipFile(rewritten, "w") as changed:
            for item in original.infolist():
                content = original.read(item.filename)
                if item.filename == "xl/worksheets/sheet1.xml":
                    content = re.sub(rb'<c r="A3"[^>]*>.*?</c>',
                                     b'<c r="A3" t="e"><f>1/0</f><v>#DIV/0!</v></c>', content)
                changed.writestr(item, content)
        output = rewritten
        source_response = self.client.post(
            "/api/intake/sources",
            {"file": SimpleUploadedFile(f"{suffix}.xlsx", output.getvalue(), "application/octet-stream")},
            HTTP_IDEMPOTENCY_KEY=f"plan-source-ref-source-{suffix}",
        )
        self.assertIn(source_response.status_code, (200, 201), source_response.content)
        source = source_response.json()["source"]
        preview = self.client.post(
            f"/api/intake/sources/{source['id']}/previews", data="{}", content_type="application/json",
            HTTP_IDEMPOTENCY_KEY=f"plan-source-ref-preview-{suffix}",
        )
        self.assertIn(preview.status_code, (200, 201), preview.content)
        field = "unit_price" if candidate_type == "commercial_source" else "observed_seconds"
        empty_field = "currency" if candidate_type == "commercial_source" else "observed_unit"
        mapping = {"schema_version": 1, "candidate_type": candidate_type, "source_sha256": source["sha256"],
                   "expected_revision": 0, "fields": {
                       field: {"cells": [{"sheet_index": 1, "coordinate": "A2"}]},
                       "notes": {"cells": [{"sheet_index": 1, "coordinate": "A3"}]},
                       empty_field: {"cells": [{"sheet_index": 1, "coordinate": "A4"}]}}}
        mapped = self.client.post(
            f"/api/intake/previews/{preview.json()['preview']['id']}/mappings", data=json.dumps(mapping),
            content_type="application/json", HTTP_IDEMPOTENCY_KEY=f"plan-source-ref-mapping-{suffix}",
        )
        self.assertIn(mapped.status_code, (200, 201), mapped.content)
        created = self.client.post(
            f"/api/intake/mappings/{mapped.json()['mapping']['id']}/candidates", data="{}",
            content_type="application/json", HTTP_IDEMPOTENCY_KEY=f"plan-source-ref-candidate-{suffix}",
        )
        self.assertIn(created.status_code, (200, 201), created.content)
        candidate = created.json()["candidate"]
        evidence_ids = {}
        for field_key, coordinate in ((field, "A2"), ("notes", "A3"), (empty_field, "A4")):
            evidence = self.client.post(
                f"/api/intake/candidates/{candidate['id']}/evidence",
                data=json.dumps({"schema_version": 1, "kind": "source_record", "field_key": field_key,
                                 "snapshot_id": preview.json()["preview"]["id"], "sheet_index": 1, "coordinate": coordinate}),
                content_type="application/json", HTTP_IDEMPOTENCY_KEY=f"plan-source-ref-evidence-{suffix}-{field_key}",
            )
            self.assertIn(evidence.status_code, (200, 201), evidence.content)
            evidence_ids[field_key] = evidence.json()["evidence"]["id"]
        return candidate, field, evidence_ids[field], evidence_ids["notes"], empty_field, evidence_ids[empty_field], preview.json()["preview"]["id"]

    def confirmed_requirement(self, suffix="plan"):
        candidate = self.create_production_candidate(suffix)
        created_response = self.client.post(
            f"/api/intake/candidates/{candidate['id']}/requirement-drafts",
            data=json.dumps({"record_kind": "new_demand"}), content_type="application/json",
            HTTP_IDEMPOTENCY_KEY=f"execution-plan-requirement-{suffix}",
        )
        self.assertEqual(created_response.status_code, 201, created_response.content)
        created = created_response.json()
        draft = ProductionRequirementDraft.objects.get(pk=created["draft"]["id"])
        confirmed = ProductionRequirementRevision.objects.create(
            draft=draft, revision=2, fields=created["revision"]["fields"], unresolved_fields={},
            status=ProductionRequirementRevision.Status.CONFIRMED,
        )
        from workbench.requirements.api import _copy_revision_evidence
        _copy_revision_evidence(draft.revisions.get(revision=1), confirmed)
        draft.current_revision = 2
        draft.status = ProductionRequirementDraft.Status.CONFIRMED
        draft.save(update_fields=["current_revision", "status", "updated_at"])
        return draft, confirmed

    def public_confirmed_requirement(self, suffix="public-flow"):
        candidate = self.create_production_candidate(suffix)
        created = self.client.post(
            f"/api/intake/candidates/{candidate['id']}/requirement-drafts",
            data=json.dumps({"record_kind": "new_demand"}), content_type="application/json",
            HTTP_IDEMPOTENCY_KEY=f"execution-plan-public-requirement-{suffix}",
        )
        self.assertEqual(created.status_code, 201, created.content)
        draft_id = created.json()["draft"]["id"]
        narrative = self.client.post(
            "/api/intake/narratives",
            {"file": SimpleUploadedFile(f"{suffix}.txt", b"Synthetic operator details.\n", "text/plain")},
            HTTP_IDEMPOTENCY_KEY=f"execution-plan-public-narrative-{suffix}",
        )
        self.assertEqual(narrative.status_code, 201, narrative.content)
        narrative_id = narrative.json()["narrative"]["id"]
        fields = {}
        field_sources = {}
        unresolved = created.json()["revision"]["unresolved_fields"]
        for field_key in unresolved:
            field_type = REQUIREMENT_FIELDS[field_key]
            if field_type == "text":
                fields[field_key] = f"Synthetic {field_key}"
            elif field_type == "decimal":
                fields[field_key] = "10"
            elif field_type == "date":
                fields[field_key] = "2026-10-25"
            else:
                fields[field_key] = None
            field_sources[field_key] = [{
                "kind": "operator_statement", "field_key": field_key,
                "narrative_source_id": narrative_id, "line_start": 1, "line_end": 1,
            }]
        full_fields = dict(created.json()["revision"]["fields"])
        full_fields.update(fields)
        changed = self.client.post(
            f"/api/production-requirements/{draft_id}/revisions",
            data=json.dumps({"expected_revision": 1, "fields": fields, "field_sources": field_sources}),
            content_type="application/json", HTTP_IDEMPOTENCY_KEY=f"execution-plan-public-revision-{suffix}",
        )
        self.assertEqual(changed.status_code, 201, changed.content)
        confirmed = self.client.post(
            f"/api/production-requirements/{draft_id}/confirm",
            data=json.dumps({"expected_revision": 2,
                             "confirmed_unit_pair": {"unit": full_fields["unit"], "pack_unit": full_fields["pack_unit"]}}),
            content_type="application/json", HTTP_IDEMPOTENCY_KEY=f"execution-plan-public-confirm-{suffix}",
        )
        self.assertEqual(confirmed.status_code, 201, confirmed.content)
        return draft_id, confirmed.json()["revision"], candidate

    @staticmethod
    def empty_plan(requirement_id, expected=0):
        return {"requirement_revision_id": requirement_id, "expected_revision": expected,
                "requirement_refs": [], "materials": [], "operations": []}

    def post_plan(self, draft_id, body, key="execution-plan-test-key"):
        return self.client.post(
            f"/api/production-requirements/{draft_id}/execution-plan-revisions",
            data=json.dumps(body), content_type="application/json", HTTP_IDEMPOTENCY_KEY=key,
        )

    def test_confirmed_revision_accepts_plan_and_exact_revision_is_readable(self):
        draft, requirement = self.confirmed_requirement()
        evidence = requirement.evidence_records.filter(field_key="description").first()
        body = {"requirement_revision_id": requirement.pk, "expected_revision": 0,
                "requirement_refs": [{"field_key": "description", "evidence_ids": [evidence.pk]}],
                "materials": [], "operations": []}
        path = f"/api/production-requirements/{draft.pk}/execution-plan-revisions"
        response = self.client.post(path, data=json.dumps(body), content_type="application/json",
                                    HTTP_IDEMPOTENCY_KEY="execution-plan-first-001")
        self.assertEqual(response.status_code, 201, response.content)
        payload = response.json()
        self.assertEqual(payload["plan"]["revision"], 1)
        self.assertEqual(payload["requirement_revision"]["id"], requirement.pk)
        self.assertEqual(payload["requirement_revision"]["fields"], requirement.fields)
        self.assertEqual(payload["plan"]["requirement"]["source_candidate_id"], draft.source_candidate_id)
        self.assertTrue(payload["is_latest"])
        self.assertEqual(payload["actual"], {"status": "missing"})

        detail = self.client.get(f"/api/execution-plans/{payload['plan']['id']}")
        self.assertEqual(detail.status_code, 200, detail.content)
        self.assertEqual(detail.json()["requirement_revision"]["id"], requirement.pk)
        self.assertEqual(detail.json()["requirement_revision"]["fields"], requirement.fields)
        self.assertEqual(detail.json()["requirement_revision"]["source_refs"]["description"][0]["id"], evidence.pk)
        self.assertTrue(detail.json()["is_latest"])

        # A later requirement revision must not rebind this plan's source DTO.
        from workbench.models import ProductionRequirementRevision
        newer = ProductionRequirementRevision.objects.create(
            draft=draft, revision=requirement.revision + 1,
            fields={**requirement.fields, "description": "Later requirement version"}, unresolved_fields={},
            status=ProductionRequirementRevision.Status.CONFIRMED,
        )
        draft.current_revision = newer.revision
        draft.status = ProductionRequirementDraft.Status.CONFIRMED
        draft.save(update_fields=["current_revision", "status", "updated_at"])
        old_detail = self.client.get(f"/api/execution-plans/{payload['plan']['id']}")
        self.assertEqual(old_detail.status_code, 200, old_detail.content)
        self.assertEqual(old_detail.json()["requirement_revision"]["id"], requirement.pk)
        self.assertEqual(old_detail.json()["requirement_revision"]["fields"]["description"], requirement.fields["description"])
        self.assertEqual(old_detail.json()["requirement_revision"]["source_refs"]["description"][0]["id"], evidence.pk)

    def test_source_reference_is_bound_and_frozen_for_commercial_and_labor_candidates(self):
        draft, requirement = self.confirmed_requirement("source-reference")
        references = [self.create_source_reference_candidate(candidate_type, f"source-reference-{index}")
                      for index, candidate_type in enumerate(("commercial_source", "labor_analysis"))]
        for index, candidate_type in enumerate(("commercial_source", "labor_analysis")):
            candidate, field, evidence_id, error_evidence_id, empty_field, empty_evidence_id, snapshot_id = references[index]
            body = self.empty_plan(requirement.pk, expected=index)
            body["materials"] = [{"item_ref": None, "resolution": "unresolved",
                "proposal": {"description": "synthetic reference", "quantity": None, "unit": None, "expected_date": None},
                "supporting_requirement_inputs": [],
                "supporting_source_inputs": [{"candidate_id": candidate["id"], "field_key": field, "evidence_ids": [evidence_id]},
                    {"candidate_id": candidate["id"], "field_key": "notes", "evidence_ids": [error_evidence_id]},
                    {"candidate_id": candidate["id"], "field_key": empty_field, "evidence_ids": [empty_evidence_id]}]}]
            wrong_binding = json.loads(json.dumps(body))
            wrong_binding["materials"][0]["supporting_source_inputs"][0]["candidate_id"] = references[1 - index][0]["id"]
            self.assertEqual(self.post_plan(draft.pk, wrong_binding, f"plan-source-reference-wrong-{index}").status_code, 422)
            wrong_field = json.loads(json.dumps(body))
            wrong_field["materials"][0]["supporting_source_inputs"][0]["field_key"] = empty_field
            self.assertEqual(self.post_plan(draft.pk, wrong_field, f"plan-source-reference-field-{index}").status_code, 422)
            response = self.post_plan(draft.pk, body, f"plan-source-reference-{index}")
            self.assertEqual(response.status_code, 201, response.content)
            plan = response.json()["plan"]
            frozen = plan["materials"][0]["supporting_sources"][0]
            self.assertEqual(frozen["candidate_id"], candidate["id"])
            self.assertEqual(frozen["candidate_type"], candidate_type)
            self.assertEqual(frozen["field_key"], field)
            self.assertEqual(frozen["evidence_id"], evidence_id)
            self.assertEqual(frozen["typed_value"]["state"], "present")
            self.assertEqual(frozen["typed_value"]["value"], "0")
            self.assertEqual(frozen["value_refs"][0]["coordinate"], "A2")
            formula_error = plan["materials"][0]["supporting_sources"][1]
            self.assertEqual(formula_error["typed_value"]["state"], "formula_error")
            self.assertIsNone(formula_error["typed_value"]["value"])
            empty_value = plan["materials"][0]["supporting_sources"][2]
            self.assertEqual(empty_value["typed_value"]["state"], "empty")
            self.assertIsNone(empty_value["typed_value"]["value"])
            self.assertNotIn("price_nature", frozen)
            self.assertNotIn("labor_basis", frozen)
            replay = self.post_plan(draft.pk, body, f"plan-source-reference-{index}")
            self.assertEqual(replay.status_code, 200, replay.content)
            self.assertEqual(replay.json()["plan"]["materials"][0]["supporting_sources"], plan["materials"][0]["supporting_sources"])
            changed = json.loads(json.dumps(body))
            changed["materials"][0]["proposal"]["description"] = "different valid request"
            conflict = self.post_plan(draft.pk, changed, f"plan-source-reference-{index}")
            self.assertEqual(conflict.status_code, 409, conflict.content)
            detail = self.client.get(f"/api/execution-plans/{plan['id']}")
            self.assertEqual(detail.status_code, 200, detail.content)
            self.assertEqual(detail.json()["plan"]["materials"][0]["supporting_sources"], plan["materials"][0]["supporting_sources"])
            later_evidence = self.client.post(
                f"/api/intake/candidates/{candidate['id']}/evidence",
                data=json.dumps({"schema_version": 1, "kind": "source_record", "field_key": field,
                                 "snapshot_id": snapshot_id, "sheet_index": 1, "coordinate": "A2"}),
                content_type="application/json", HTTP_IDEMPOTENCY_KEY=f"plan-source-ref-later-{index}",
            )
            self.assertEqual(later_evidence.status_code, 201, later_evidence.content)
            old_after_new_source = self.client.get(f"/api/execution-plans/{plan['id']}").json()["plan"]
            self.assertEqual(old_after_new_source["materials"][0]["supporting_sources"], plan["materials"][0]["supporting_sources"])
            corrupted_provenance = json.loads(json.dumps(candidate["provenance"]))
            corrupted_provenance[field][0]["source_sha256"] = "0" * 64
            with connection.cursor() as cursor:
                cursor.execute("UPDATE workbench_intakecandidate SET provenance = %s::jsonb WHERE id = %s",
                               [json.dumps(corrupted_provenance), candidate["id"]])
            next_body = json.loads(json.dumps(body))
            next_body["expected_revision"] = index + 1
            mismatch = self.post_plan(draft.pk, next_body, f"plan-source-reference-provenance-{index}")
            self.assertEqual(mismatch.status_code, 422, mismatch.content)
            self.assertEqual(mismatch.json()["error_code"], "invalid_execution_evidence")

    def test_synthetic_public_import_confirm_then_plan_readback(self):
        draft_id, requirement, candidate = self.public_confirmed_requirement()
        evidence_id = requirement["source_refs"]["description"][0]["id"]
        source_locator = candidate["provenance"]["description"][0]
        self.assertEqual(requirement["source_refs"]["description"][0]["kind"], "source_record")
        source_evidence = EvidenceRecord.objects.get(pk=evidence_id, requirement_revision_id=requirement["id"])
        self.assertEqual(source_evidence.source_snapshot_id, source_locator["snapshot_id"])
        self.assertEqual(source_evidence.source_sheet.sheet_index, source_locator["sheet_index"])
        self.assertEqual(source_evidence.coordinate, source_locator["coordinate"])
        body = {
            "requirement_revision_id": requirement["id"], "expected_revision": 0,
            "requirement_refs": [{"field_key": "description", "evidence_ids": [evidence_id]}],
            "materials": [{"item_ref": None, "resolution": "unresolved",
                           "proposal": {"description": "Explicit synthetic proposal", "quantity": "0.5",
                                        "unit": "box", "expected_date": "2026-10-30"},
                           "supporting_requirement_inputs": []}],
            "operations": [{"operation_ref": None, "resolution": "unresolved",
                            "proposal": {"description": "Synthetic proposal only", "sequence": 1},
                            "supporting_requirement_inputs": []}],
        }
        path = f"/api/production-requirements/{draft_id}/execution-plan-revisions"
        created = self.client.post(path, data=json.dumps(body), content_type="application/json",
                                  HTTP_IDEMPOTENCY_KEY="execution-plan-public-flow-001")
        self.assertEqual(created.status_code, 201, created.content)
        plan = created.json()["plan"]
        self.assertEqual(plan["materials"][0]["proposal"]["quantity"], "0.5")
        self.assertEqual(plan["materials"][0]["resolution"], "unresolved")
        self.assertEqual(plan["operations"][0]["resolution"], "unresolved")
        self.assertEqual(plan["actual"], {"status": "missing"})
        detail = self.client.get(f"/api/execution-plans/{plan['id']}")
        self.assertEqual(detail.status_code, 200, detail.content)
        self.assertEqual(detail.json()["requirement_revision"]["id"], requirement["id"])
        self.assertEqual(detail.json()["plan"]["materials"][0]["proposal"]["quantity"], "0.5")
        self.assertEqual(detail.json()["plan"]["requirement_refs"][0]["evidence_ids"], [evidence_id])

    def test_unconfirmed_requirement_and_invalid_evidence_or_closed_schema_are_rejected(self):
        candidate = self.create_production_candidate("reject-unconfirmed")
        created = self.client.post(
            f"/api/intake/candidates/{candidate['id']}/requirement-drafts",
            data=json.dumps({"record_kind": "new_demand"}), content_type="application/json",
            HTTP_IDEMPOTENCY_KEY="execution-plan-unconfirmed-draft-001",
        )
        self.assertEqual(created.status_code, 201, created.content)
        draft_id, requirement_id = created.json()["draft"]["id"], created.json()["revision"]["id"]
        response = self.post_plan(draft_id, self.empty_plan(requirement_id), "execution-plan-unconfirmed-001")
        self.assertEqual(response.status_code, 409, response.content)

        draft, requirement = self.confirmed_requirement("reject-invalid")
        fake = self.empty_plan(requirement.pk)
        fake["requirement_refs"] = [{"field_key": "description", "evidence_ids": ["0" * 32]}]
        invalid_evidence = self.post_plan(draft.pk, fake, "execution-plan-fake-evidence-001")
        self.assertEqual(invalid_evidence.status_code, 422, invalid_evidence.content)

        wrong_field = self.empty_plan(requirement.pk)
        description_evidence = requirement.evidence_records.filter(field_key="description").first()
        wrong_field["requirement_refs"] = [{"field_key": "specification", "evidence_ids": [description_evidence.pk]}]
        wrong_field_response = self.post_plan(draft.pk, wrong_field, "execution-plan-wrong-field-evidence-001")
        self.assertEqual(wrong_field_response.status_code, 422, wrong_field_response.content)

        other_draft, other_requirement = self.confirmed_requirement("wrong-route-owner")
        wrong_owner = self.post_plan(draft.pk, self.empty_plan(other_requirement.pk), "execution-plan-wrong-draft-001")
        self.assertEqual(wrong_owner.status_code, 404, wrong_owner.content)

        unknown = self.empty_plan(requirement.pk)
        unknown["unexpected"] = True
        invalid_schema = self.post_plan(draft.pk, unknown, "execution-plan-unknown-key-001")
        self.assertEqual(invalid_schema.status_code, 422, invalid_schema.content)

        foreign = self.empty_plan(requirement.pk)
        foreign["materials"] = [{"item_ref": {"doctype": "Item", "name": "FAKE"},
                                 "resolution": "unresolved",
                                 "proposal": {"description": None, "quantity": None, "unit": None, "expected_date": None},
                                 "supporting_requirement_inputs": []}]
        invalid_typed_ref = self.post_plan(draft.pk, foreign, "execution-plan-external-item-001")
        self.assertEqual(invalid_typed_ref.status_code, 422, invalid_typed_ref.content)

        bounded = self.empty_plan(requirement.pk)
        evidence = requirement.evidence_records.filter(field_key="description").first()
        bounded["requirement_refs"] = [{"field_key": "description", "evidence_ids": [evidence.pk]}] * 101
        too_many_refs = self.post_plan(draft.pk, bounded, "execution-plan-too-many-refs-001")
        self.assertEqual(too_many_refs.status_code, 422, too_many_refs.content)

        oversized = self.client.post(
            f"/api/production-requirements/{draft.pk}/execution-plan-revisions",
            data=b" " * (256 * 1024 + 1), content_type="application/json",
            HTTP_IDEMPOTENCY_KEY="execution-plan-over-256kib-001",
        )
        self.assertEqual(oversized.status_code, 400, oversized.content)

        bad_type = self.empty_plan(requirement.pk)
        bad_type["materials"] = [{"item_ref": None, "resolution": "unresolved",
                                  "proposal": {"description": None, "quantity": 0,
                                               "unit": None, "expected_date": None},
                                  "supporting_requirement_inputs": []}]
        invalid_type = self.post_plan(draft.pk, bad_type, "execution-plan-wrong-type-001")
        self.assertEqual(invalid_type.status_code, 422, invalid_type.content)

    def test_idempotency_replays_original_plan_and_latest_is_independent(self):
        draft, requirement = self.confirmed_requirement("idempotency")
        body = self.empty_plan(requirement.pk)
        created = self.post_plan(draft.pk, body, "execution-plan-replay-001")
        self.assertEqual(created.status_code, 201, created.content)
        original_id = created.json()["plan"]["id"]
        replay = self.post_plan(draft.pk, body, "execution-plan-replay-001")
        self.assertEqual(replay.status_code, 200, replay.content)
        self.assertEqual(replay.json()["plan"]["id"], original_id)
        self.assertEqual(replay.json()["requirement_revision"]["id"], requirement.pk)
        conflict_body = self.empty_plan(requirement.pk)
        conflict_body["materials"] = [{"item_ref": None, "resolution": "unresolved",
                                        "proposal": {"description": "changed", "quantity": None,
                                                     "unit": None, "expected_date": None},
                                        "supporting_requirement_inputs": []}]
        conflict = self.post_plan(draft.pk, conflict_body, "execution-plan-replay-001")
        self.assertEqual(conflict.status_code, 409, conflict.content)

        second_body = self.empty_plan(requirement.pk, expected=1)
        second = self.post_plan(draft.pk, second_body, "execution-plan-revision-2-001")
        self.assertEqual(second.status_code, 201, second.content)
        old = self.client.get(f"/api/execution-plans/{original_id}")
        self.assertFalse(old.json()["is_latest"])
        self.assertEqual(old.json()["latest_revision"], 2)
        replay_v1 = self.post_plan(draft.pk, body, "execution-plan-replay-001")
        self.assertEqual(replay_v1.status_code, 200, replay_v1.content)
        self.assertEqual(replay_v1.json()["plan"]["id"], original_id)
        self.assertEqual(replay_v1.json()["latest_revision"], 2)
        self.assertFalse(replay_v1.json()["is_latest"])
        history = self.client.get(f"/api/production-requirements/{draft.pk}/execution-plan-revisions?offset=0&limit=1")
        self.assertEqual(history.status_code, 200, history.content)
        self.assertEqual(len(history.json()["revisions"]), 1)
        self.assertEqual(history.json()["next_offset"], 1)

    def test_legacy_material_and_operation_receipt_replays_without_new_source_keys(self):
        draft, requirement = self.confirmed_requirement("legacy-source-idempotency")
        body = self.empty_plan(requirement.pk)
        body["materials"] = [{"item_ref": None, "resolution": "unresolved",
            "proposal": {"description": "legacy material", "quantity": None, "unit": None, "expected_date": None},
            "supporting_requirement_inputs": []}]
        body["operations"] = [{"operation_ref": None, "resolution": "unresolved",
            "proposal": {"description": "legacy operation", "sequence": None},
            "supporting_requirement_inputs": []}]
        key = "execution-plan-legacy-source-replay-001"
        created = self.post_plan(draft.pk, body, key)
        self.assertEqual(created.status_code, 201, created.content)
        legacy_canonical_plan = {
            "requirement_revision_id": requirement.pk, "expected_revision": 0, "requirement_refs": [],
            "materials": [{"item_ref": None, "resolution": "unresolved", "proposal": body["materials"][0]["proposal"],
                           "supporting_requirement_inputs": []}],
            "operations": [{"operation_ref": None, "resolution": "unresolved", "proposal": body["operations"][0]["proposal"],
                            "supporting_requirement_inputs": []}],
        }
        receipt = IntakeOperationReceipt.objects.get(idempotency_key=key)
        receipt.fingerprint = fingerprint({"action": "execution_plan_revision", "draft_id": draft.pk, **legacy_canonical_plan})
        receipt.save(update_fields=["fingerprint"])

        replay = self.post_plan(draft.pk, body, key)

        self.assertEqual(replay.status_code, 200, replay.content)
        self.assertEqual(replay.json()["plan"]["id"], created.json()["plan"]["id"])
        self.assertEqual(replay.json()["plan"], created.json()["plan"])
        explicit_empty = json.loads(json.dumps(body))
        explicit_empty["materials"][0]["supporting_source_inputs"] = []
        explicit_empty["operations"][0]["supporting_source_inputs"] = []
        same_empty = self.post_plan(draft.pk, explicit_empty, key)
        self.assertEqual(same_empty.status_code, 200, same_empty.content)
        self.assertEqual(same_empty.json()["plan"], created.json()["plan"])
        changed = json.loads(json.dumps(body))
        changed["materials"][0]["proposal"]["description"] = "changed after legacy receipt"
        conflict = self.post_plan(draft.pk, changed, key)
        self.assertEqual(conflict.status_code, 409, conflict.content)

    def test_history_can_filter_one_requirement_lineage_and_reports_empty_latest(self):
        draft, requirement = self.confirmed_requirement("history-filter")
        first = self.post_plan(draft.pk, self.empty_plan(requirement.pk), "execution-plan-filter-a-1")
        second = self.post_plan(draft.pk, self.empty_plan(requirement.pk, expected=1), "execution-plan-filter-a-2")
        self.assertEqual(first.status_code, 201, first.content)
        self.assertEqual(second.status_code, 201, second.content)

        empty_requirement = ProductionRequirementRevision.objects.create(
            draft=draft, revision=3, fields=dict(requirement.fields), unresolved_fields={},
            status=ProductionRequirementRevision.Status.CONFIRMED,
        )
        from workbench.requirements.api import _copy_revision_evidence
        _copy_revision_evidence(requirement, empty_requirement)
        draft.current_revision = 3
        draft.save(update_fields=["current_revision", "updated_at"])
        history_url = f"/api/production-requirements/{draft.pk}/execution-plan-revisions"
        selected = self.client.get(f"{history_url}?requirement_revision_id={requirement.pk}")
        self.assertEqual(selected.status_code, 200, selected.content)
        self.assertEqual(selected.json()["requirement_revision_id"], requirement.pk)
        self.assertEqual(selected.json()["latest_revision"], 2)
        self.assertEqual({row["requirement_revision_id"] for row in selected.json()["revisions"]}, {requirement.pk})
        empty = self.client.get(f"{history_url}?requirement_revision_id={empty_requirement.pk}")
        self.assertEqual(empty.status_code, 200, empty.content)
        self.assertEqual(empty.json()["revisions"], [])
        self.assertEqual(empty.json()["latest_revision"], 0)

        _other_draft, other_requirement = self.confirmed_requirement("history-filter-foreign")
        wrong_draft = self.client.get(f"{history_url}?requirement_revision_id={other_requirement.pk}")
        self.assertEqual(wrong_draft.status_code, 422, wrong_draft.content)
        malformed = self.client.get(f"{history_url}?requirement_revision_id=not-an-id")
        self.assertEqual(malformed.status_code, 422, malformed.content)
        huge_offset = self.client.get(f"{history_url}?offset={'9' * 4301}&limit=20")
        self.assertEqual(huge_offset.status_code, 422, huge_offset.content)

    def test_same_field_evidence_can_support_plan_and_multiple_items(self):
        draft, requirement = self.confirmed_requirement("shared-evidence")
        evidence = requirement.evidence_records.filter(field_key="description").first()
        body = self.empty_plan(requirement.pk)
        body["requirement_refs"] = [{"field_key": "description", "evidence_ids": [evidence.pk]}]
        support = [{"field_key": "description", "evidence_ids": [evidence.pk]}]
        body["materials"] = [{"item_ref": None, "resolution": "unresolved",
                               "proposal": {"description": None, "quantity": None, "unit": None, "expected_date": None},
                               "supporting_requirement_inputs": support}]
        body["operations"] = [{"operation_ref": None, "resolution": "unresolved",
                               "proposal": {"description": "Step A", "sequence": 1},
                               "supporting_requirement_inputs": support},
                              {"operation_ref": None, "resolution": "unresolved",
                               "proposal": {"description": "Step B", "sequence": 2},
                               "supporting_requirement_inputs": support}]
        response = self.post_plan(draft.pk, body, "execution-plan-shared-evidence-001")
        self.assertEqual(response.status_code, 201, response.content)

    def test_requirement_evidence_must_match_exact_revision_and_each_revision_has_own_lineage(self):
        draft, first_requirement = self.confirmed_requirement("separate-lineage")
        _foreign_draft, foreign_requirement = self.confirmed_requirement("foreign-evidence")
        foreign_evidence = foreign_requirement.evidence_records.filter(field_key="description").first()
        foreign_ref = self.empty_plan(first_requirement.pk)
        foreign_ref["requirement_refs"] = [{"field_key": "description", "evidence_ids": [foreign_evidence.pk]}]
        rejected = self.post_plan(draft.pk, foreign_ref, "execution-plan-cross-revision-ref-001")
        self.assertEqual(rejected.status_code, 422, rejected.content)

        first = self.post_plan(draft.pk, self.empty_plan(first_requirement.pk), "execution-plan-lineage-a-001")
        self.assertEqual(first.status_code, 201, first.content)
        second_requirement = ProductionRequirementRevision.objects.create(
            draft=draft, revision=3, fields=dict(first_requirement.fields), unresolved_fields={},
            status=ProductionRequirementRevision.Status.CONFIRMED,
        )
        from workbench.requirements.api import _copy_revision_evidence
        _copy_revision_evidence(first_requirement, second_requirement)
        draft.current_revision = 3
        draft.save(update_fields=["current_revision", "updated_at"])
        second = self.post_plan(draft.pk, self.empty_plan(second_requirement.pk), "execution-plan-lineage-b-001")
        self.assertEqual(second.status_code, 201, second.content)
        self.assertEqual(second.json()["plan"]["revision"], 1)
        self.assertEqual(second.json()["latest_revision"], 1)
        self.assertEqual(first.json()["plan"]["revision"], 1)
        self.assertTrue(self.client.get(f"/api/execution-plans/{first.json()['plan']['id']}").json()["is_latest"])

    def test_plan_rows_are_append_only_and_first_revision_cas_is_serialized(self):
        from queue import Queue
        from threading import Barrier, Thread

        from django.db import close_old_connections, IntegrityError, transaction
        from django.core.exceptions import ValidationError

        from workbench.models import ExecutionPlanRevision

        draft, requirement = self.confirmed_requirement("concurrency")
        path = f"/api/production-requirements/{draft.pk}/execution-plan-revisions"
        barrier, results = Barrier(2), Queue()

        def submit(index):
            close_old_connections()
            client = Client()
            try:
                barrier.wait(timeout=5)
                response = client.post(path, data=json.dumps(self.empty_plan(requirement.pk)),
                                       content_type="application/json",
                                       HTTP_IDEMPOTENCY_KEY=f"execution-plan-cas-{index}")
                results.put((response.status_code, response.content))
            except Exception as exc:
                results.put(exc)
            finally:
                close_old_connections()

        threads = [Thread(target=submit, args=(index,)) for index in (1, 2)]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join(timeout=15)
        self.assertTrue(all(not thread.is_alive() for thread in threads))
        outcomes = [results.get(timeout=2), results.get(timeout=2)]
        self.assertFalse([item for item in outcomes if isinstance(item, Exception)], outcomes)
        self.assertEqual(sorted(code for code, _ in outcomes), [201, 409])
        self.assertEqual(requirement.execution_plan_revisions.count(), 1)
        plan = requirement.execution_plan_revisions.get()
        plan.materials = [{"tampered": True}]
        with self.assertRaises(ValidationError):
            plan.save()
        with self.assertRaises(ValidationError):
            plan.delete()
        with self.assertRaises(IntegrityError), transaction.atomic():
            ExecutionPlanRevision.objects.create(requirement_revision=requirement, revision=1)
        with self.assertRaises(IntegrityError), transaction.atomic():
            ExecutionPlanRevision.objects.create(requirement_revision=requirement, revision=0)
        with self.assertRaises(IntegrityError), transaction.atomic():
            ExecutionPlanRevision.objects.create(requirement_revision=requirement, revision=2, status="submitted")

    def test_receipt_completion_failure_rolls_back_plan_and_hides_private_exception(self):
        from workbench.models import ExecutionPlanRevision, IntakeOperationReceipt

        draft, requirement = self.confirmed_requirement("receipt-rollback")
        key = "execution-plan-private-failure-001"

        def complete_then_fail(receipt, result_type, result_id):
            from workbench.intake.api import _complete as complete
            complete(receipt, result_type, result_id)
            raise RuntimeError("PRIVATE_EXECUTION_PLAN_SENTINEL")

        with patch("workbench.execution_plans.api._complete", side_effect=complete_then_fail):
            response = self.post_plan(draft.pk, self.empty_plan(requirement.pk), key)
        self.assertEqual(response.status_code, 503, response.content)
        self.assertNotIn(b"PRIVATE_EXECUTION_PLAN_SENTINEL", response.content)
        self.assertFalse(IntakeOperationReceipt.objects.filter(idempotency_key=key).exists())
        self.assertFalse(ExecutionPlanRevision.objects.filter(requirement_revision=requirement).exists())

    def test_unknown_value_error_returns_generic_error_without_private_message(self):
        from workbench.models import ExecutionPlanRevision, IntakeOperationReceipt

        draft, requirement = self.confirmed_requirement("value-error-rollback")
        key = "execution-plan-private-value-error-001"
        with patch("workbench.execution_plans.api._complete", side_effect=ValueError("PRIVATE_VALUE_ERROR_SENTINEL")):
            response = self.post_plan(draft.pk, self.empty_plan(requirement.pk), key)
        self.assertEqual(response.status_code, 503, response.content)
        self.assertNotIn(b"PRIVATE_VALUE_ERROR_SENTINEL", response.content)
        self.assertEqual(response.json()["error_code"], "unavailable")
        self.assertFalse(IntakeOperationReceipt.objects.filter(idempotency_key=key).exists())
        self.assertFalse(ExecutionPlanRevision.objects.filter(requirement_revision=requirement).exists())

    def test_makemigrations_check_has_no_drift_in_managed_postgres_context(self):
        call_command("makemigrations", "workbench", check=True, dry_run=True,
                     interactive=False, verbosity=0)
