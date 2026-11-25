from __future__ import annotations

import hashlib
import json
from concurrent.futures import ThreadPoolExecutor
from io import BytesIO
from pathlib import Path
from threading import Barrier
from tempfile import TemporaryDirectory
from unittest.mock import patch

from django.core.files.uploadedfile import SimpleUploadedFile
from django.core.exceptions import ValidationError
from django.db import close_old_connections, connection
from django.test import Client, TransactionTestCase, override_settings
from openpyxl import Workbook

from workbench.models import EvidenceRecord, IntakeOperationReceipt, NarrativeSourceVersion
from workbench.intake.narrative_storage import open_narrative
from workbench.intake.storage import INTAKE_MARKER, INTAKE_MARKER_CONTENT


class IntakeEvidenceApiTests(TransactionTestCase):
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
        self.workbook = self._synthetic_xlsx()

    @staticmethod
    def _synthetic_xlsx(description="Synthetic description"):
        workbook = Workbook()
        workbook.active["A1"] = description
        workbook.active["B1"] = "Synthetic style code"
        output = BytesIO()
        workbook.save(output)
        workbook.close()
        return output.getvalue()

    def tearDown(self):
        self.settings_override.disable()
        self.temp.cleanup()

    def create_candidate(self, suffix="one", *, include_style_number=False):
        source_response = self.client.post(
            "/api/intake/sources",
            {"file": SimpleUploadedFile(f"{suffix}.xlsx", self._synthetic_xlsx(f"Synthetic description {suffix}"), "application/octet-stream")},
            HTTP_IDEMPOTENCY_KEY=f"evidence-source-{suffix}",
        )
        self.assertEqual(source_response.status_code, 201, source_response.content)
        source = source_response.json()["source"]
        preview_response = self.client.post(
            f"/api/intake/sources/{source['id']}/previews", data="{}", content_type="application/json",
            HTTP_IDEMPOTENCY_KEY=f"evidence-preview-{suffix}",
        )
        self.assertEqual(preview_response.status_code, 201, preview_response.content)
        preview = preview_response.json()["preview"]
        fields = {"description": {"cells": [{"sheet_index": 1, "coordinate": "A1"}]}}
        if include_style_number:
            fields["style_number"] = {"cells": [{"sheet_index": 1, "coordinate": "B1"}]}
        mapping = {
            "schema_version": 1,
            "candidate_type": "product_identity",
            "source_sha256": source["sha256"],
            "expected_revision": 0,
            "fields": fields,
        }
        mapping_response = self.client.post(
            f"/api/intake/previews/{preview['id']}/mappings", data=json.dumps(mapping),
            content_type="application/json", HTTP_IDEMPOTENCY_KEY=f"evidence-mapping-{suffix}",
        )
        self.assertEqual(mapping_response.status_code, 201, mapping_response.content)
        candidate_response = self.client.post(
            f"/api/intake/mappings/{mapping_response.json()['mapping']['id']}/candidates", data="{}",
            content_type="application/json", HTTP_IDEMPOTENCY_KEY=f"evidence-candidate-{suffix}",
        )
        self.assertEqual(candidate_response.status_code, 201, candidate_response.content)
        return source, preview, candidate_response.json()["candidate"]

    def test_narrative_upload_is_private_and_idempotent(self):
        content = "合成访谈片段：仅用于接口测试。\n第二行。".encode("utf-8")

        def upload(filename):
            return self.client.post(
                "/api/intake/narratives",
                {"file": SimpleUploadedFile(filename, content, "text/plain")},
                HTTP_IDEMPOTENCY_KEY="narrative-upload-001",
            )

        first = upload("notes.txt")
        self.assertEqual(first.status_code, 201, first.content)
        payload = first.json()
        self.assertEqual(payload["status"], "succeeded")
        narrative = payload["narrative"]
        self.assertEqual(narrative["sha256"], hashlib.sha256(content).hexdigest())
        self.assertEqual(narrative["byte_size"], len(content))
        self.assertEqual(narrative["display_name"], "notes.txt")
        self.assertNotIn("storage_key", narrative)
        self.assertNotIn("path", json.dumps(payload))
        self.assertNotIn(content.decode("utf-8"), json.dumps(payload, ensure_ascii=False))
        stored = NarrativeSourceVersion.objects.get(pk=narrative["id"])
        with open_narrative(stored.pk) as stream:
            self.assertEqual(stream.read(), content)
        stored.display_name = "renamed.txt"
        with self.assertRaises(ValidationError):
            stored.save()

        replay = upload("renamed.txt")
        self.assertEqual(replay.status_code, 200, replay.content)
        self.assertEqual(replay.json()["narrative"]["id"], narrative["id"])
        self.assertEqual(replay.json()["narrative"]["display_name"], "notes.txt")
        cross_key = self.client.post(
            "/api/intake/narratives",
            {"file": SimpleUploadedFile("third-name.txt", content, "text/plain")},
            HTTP_IDEMPOTENCY_KEY="narrative-cross-key-duplicate-001",
        )
        self.assertEqual(cross_key.status_code, 200, cross_key.content)
        self.assertEqual(cross_key.json()["narrative"]["id"], narrative["id"])
        self.assertEqual(NarrativeSourceVersion.objects.count(), 1)

    def test_narrative_lines_are_bounded_and_addressed_by_opaque_id(self):
        content = ("Synthetic 中文 one\r\nSynthetic line two\u2028" + "x" * 2_001 + "\n").encode("utf-8")
        uploaded = self.client.post(
            "/api/intake/narratives",
            {"file": SimpleUploadedFile("synthetic-lines.txt", content, "text/plain")},
            HTTP_IDEMPOTENCY_KEY="narrative-lines-upload-001",
        )
        self.assertEqual(uploaded.status_code, 201, uploaded.content)
        narrative_id = uploaded.json()["narrative"]["id"]
        first = self.client.get(f"/api/intake/narratives/{narrative_id}/lines?offset=0&limit=2")
        self.assertEqual(first.status_code, 200, first.content)
        self.assertEqual([(row["line_number"], row["text"], row["truncated"]) for row in first.json()["lines"]], [
            (1, "Synthetic 中文 one", False), (2, "Synthetic line two", False),
        ])
        self.assertEqual(first.json()["next_offset"], 2)
        second = self.client.get(f"/api/intake/narratives/{narrative_id}/lines?offset=2&limit=2")
        self.assertEqual([(row["line_number"], row["text"], row["truncated"]) for row in second.json()["lines"]],
                         [(3, "x" * 2_000, True)])
        self.assertIsNone(second.json()["next_offset"])
        self.assertEqual(self.client.get(f"/api/intake/narratives/{narrative_id}/lines?limit=101").status_code, 422)
        for query in ("offset=-1", "limit=0", "limit=1&limit=2", "extra=path", "offset=4"):
            self.assertEqual(self.client.get(f"/api/intake/narratives/{narrative_id}/lines?{query}").status_code, 422)
        self.assertNotIn("storage_key", first.json()["source"])
        source = NarrativeSourceVersion.objects.get(pk=narrative_id)
        with open_narrative(narrative_id) as stream:
            source_path = Path(stream.name)
        source_path.write_bytes(b"x" * source.byte_size)
        self.assertEqual(self.client.get(f"/api/intake/narratives/{narrative_id}/lines").status_code, 503)

    def test_narrative_upload_rolls_back_source_and_receipt_together(self):
        content = "原子回滚合成文本".encode("utf-8")
        request = lambda: self.client.post(
            "/api/intake/narratives",
            {"file": SimpleUploadedFile("atomic.txt", content, "text/plain")},
            HTTP_IDEMPOTENCY_KEY="narrative-atomic-rollback-001",
        )
        with patch("workbench.intake.api._complete", side_effect=RuntimeError("synthetic failure")):
            failed = request()
        self.assertEqual(failed.status_code, 503)
        self.assertFalse(NarrativeSourceVersion.objects.exists())
        self.assertFalse(IntakeOperationReceipt.objects.filter(idempotency_key="narrative-atomic-rollback-001").exists())
        object_files = list((self.intake_root / "narratives" / "objects").glob("*/*.txt"))
        self.assertEqual(object_files, [])

        retried = request()
        self.assertEqual(retried.status_code, 201, retried.content)
        self.assertEqual(NarrativeSourceVersion.objects.count(), 1)
        with open_narrative(retried.json()["narrative"]["id"]) as stream:
            self.assertEqual(stream.read(), content)

    def test_failed_replay_for_existing_narrative_does_not_remove_source_blob(self):
        content = "已有来源不应被失败回滚删除".encode("utf-8")
        first = self.client.post(
            "/api/intake/narratives",
            {"file": SimpleUploadedFile("first.txt", content, "text/plain")},
            HTTP_IDEMPOTENCY_KEY="narrative-existing-blob-001",
        )
        self.assertEqual(first.status_code, 201, first.content)
        source_id = first.json()["narrative"]["id"]
        original_key = NarrativeSourceVersion.objects.get(pk=source_id).storage_key
        with patch("workbench.intake.api._complete", side_effect=RuntimeError("synthetic failure")):
            failed = self.client.post(
                "/api/intake/narratives",
                {"file": SimpleUploadedFile("second.txt", content, "text/plain")},
                HTTP_IDEMPOTENCY_KEY="narrative-existing-blob-rollback-001",
            )
        self.assertEqual(failed.status_code, 503)
        self.assertEqual(NarrativeSourceVersion.objects.count(), 1)
        self.assertEqual(NarrativeSourceVersion.objects.get(pk=source_id).storage_key, original_key)
        with open_narrative(source_id) as stream:
            self.assertEqual(stream.read(), content)

    def test_narrative_collection_is_bounded_and_rejects_unknown_or_repeated_query(self):
        for index in range(3):
            response = self.client.post(
                "/api/intake/narratives",
                {"file": SimpleUploadedFile(f"note-{index}.txt", f"synthetic {index}".encode(), "text/plain")},
                HTTP_IDEMPOTENCY_KEY=f"narrative-list-{index}-001",
            )
            self.assertIn(response.status_code, (200, 201), response.content)

        first = self.client.get("/api/intake/narratives?limit=2")
        self.assertEqual(first.status_code, 200, first.content)
        self.assertEqual(len(first.json()["narratives"]), 2)
        next_offset = first.json()["next_offset"]
        self.assertIsNotNone(next_offset)
        second = self.client.get(f"/api/intake/narratives?offset={next_offset}&limit=2")
        self.assertEqual(second.status_code, 200, second.content)
        self.assertEqual(len(second.json()["narratives"]), 1)
        self.assertIsNone(second.json()["next_offset"])
        ids = [row["id"] for row in first.json()["narratives"] + second.json()["narratives"]]
        self.assertEqual(len(ids), len(set(ids)))
        self.assertEqual(self.client.get("/api/intake/narratives?path=x").status_code, 422)
        self.assertEqual(self.client.get("/api/intake/narratives?limit=1&limit=2").status_code, 422)
        self.assertNotIn("synthetic 0", json.dumps(first.json()))

    def test_evidence_cell_locator_must_belong_to_candidate_and_field_schema(self):
        _source, preview, candidate = self.create_candidate(include_style_number=True)
        _foreign_source, foreign_preview, _foreign_candidate = self.create_candidate("two")
        valid = {
            "schema_version": 1,
            "kind": "source_record",
            "field_key": "description",
            "snapshot_id": preview["id"],
            "sheet_index": 1,
            "coordinate": "A1",
        }
        endpoint = f"/api/intake/candidates/{candidate['id']}/evidence"
        accepted = self.client.post(endpoint, data=json.dumps(valid), content_type="application/json",
            HTTP_IDEMPOTENCY_KEY="evidence-source-record-001")
        self.assertEqual(accepted.status_code, 201, accepted.content)

        cross_snapshot = {**valid, "snapshot_id": foreign_preview["id"]}
        rejected_source = self.client.post(endpoint, data=json.dumps(cross_snapshot), content_type="application/json",
            HTTP_IDEMPOTENCY_KEY="evidence-cross-source-001")
        self.assertEqual(rejected_source.status_code, 422)

        unknown_field = {**valid, "field_key": "unregistered_field"}
        rejected_field = self.client.post(endpoint, data=json.dumps(unknown_field), content_type="application/json",
            HTTP_IDEMPOTENCY_KEY="evidence-unknown-field-001")
        self.assertEqual(rejected_field.status_code, 422)

        same_snapshot_unmapped_cell = {**valid, "coordinate": "B1"}
        rejected_unmapped_cell = self.client.post(
            endpoint, data=json.dumps(same_snapshot_unmapped_cell), content_type="application/json",
            HTTP_IDEMPOTENCY_KEY="evidence-same-snapshot-wrong-field-001",
        )
        self.assertEqual(rejected_unmapped_cell.status_code, 422)

    def test_evidence_status_and_summary_are_server_controlled(self):
        content = "合成逐字稿第一行。\n合成逐字稿第二行。".encode("utf-8")
        upload = self.client.post(
            "/api/intake/narratives",
            {"file": SimpleUploadedFile("interview.txt", content, "text/plain")},
            HTTP_IDEMPOTENCY_KEY="narrative-for-evidence-001",
        )
        self.assertEqual(upload.status_code, 201, upload.content)
        narrative_id = upload.json()["narrative"]["id"]
        _source, _preview, candidate = self.create_candidate()
        endpoint = f"/api/intake/candidates/{candidate['id']}/evidence"
        body = {
            "schema_version": 1,
            "kind": "operator_statement",
            "field_key": "description",
            "narrative_source_id": narrative_id,
            "line_start": 1,
            "line_end": 2,
            "status": "confirmed",
            "summary": "caller supplied transcript text",
        }
        rejected = self.client.post(endpoint, data=json.dumps(body), content_type="application/json",
            HTTP_IDEMPOTENCY_KEY="evidence-operator-untrusted-status-001")
        self.assertEqual(rejected.status_code, 422)

        del body["status"]
        del body["summary"]
        accepted = self.client.post(endpoint, data=json.dumps(body), content_type="application/json",
            HTTP_IDEMPOTENCY_KEY="evidence-operator-statement-001")
        self.assertEqual(accepted.status_code, 201, accepted.content)
        record = accepted.json()["evidence"]
        self.assertEqual(record["status"], "unverified")
        self.assertEqual(record["summary"], "summary_only")
        self.assertNotIn(content.decode("utf-8"), json.dumps(accepted.json(), ensure_ascii=False))
        detail = self.client.get(f"/api/intake/candidates/{candidate['id']}")
        self.assertEqual(detail.status_code, 200)
        self.assertEqual(set(detail.json()), {"ok", "candidate", "links", "links_next_offset",
                                             "applications", "applications_next_offset"})
        self.assertIsNone(detail.json()["links_next_offset"])
        self.assertEqual(detail.json()["applications"], [])
        self.assertIsNone(detail.json()["applications_next_offset"])
        listing = self.client.get(f"/api/intake/candidates/{candidate['id']}/evidence")
        self.assertEqual(listing.status_code, 200, listing.content)
        self.assertEqual([item["id"] for item in listing.json()["evidence"]], [record["id"]])
        self.assertNotIn(content.decode("utf-8"), listing.content.decode("utf-8"))

    def test_narrative_same_key_with_different_bytes_conflicts(self):
        def upload(content):
            return self.client.post(
                "/api/intake/narratives",
                {"file": SimpleUploadedFile("notes.txt", content, "text/plain")},
                HTTP_IDEMPOTENCY_KEY="narrative-same-key-conflict-001",
            )

        first = upload("合成访谈片段 A".encode("utf-8"))
        self.assertEqual(first.status_code, 201, first.content)
        second = upload("合成访谈片段 B".encode("utf-8"))
        self.assertEqual(second.status_code, 409)
        self.assertEqual(second.json()["error_code"], "idempotency_conflict")
        self.assertNotIn("合成访谈片段", second.content.decode("utf-8"))

    def test_narrative_requires_utf8_and_does_not_echo_invalid_bytes(self):
        response = self.client.post(
            "/api/intake/narratives",
            {"file": SimpleUploadedFile("bad.txt", b"\xff\xfeSECRET", "text/plain")},
            HTTP_IDEMPOTENCY_KEY="narrative-invalid-utf8-001",
        )
        self.assertEqual(response.status_code, 422)
        self.assertNotIn("SECRET", response.content.decode("utf-8"))

    def test_evidence_line_range_is_bounded_and_receipt_is_replayed(self):
        narrative_text = "第一行\n第二行\n第三行\n"
        upload = self.client.post(
            "/api/intake/narratives",
            {"file": SimpleUploadedFile("lines.txt", narrative_text.encode("utf-8"), "text/plain")},
            HTTP_IDEMPOTENCY_KEY="narrative-lines-001",
        )
        self.assertEqual(upload.status_code, 201, upload.content)
        _source, _preview, candidate = self.create_candidate()
        narrative_id = upload.json()["narrative"]["id"]
        body = {
            "schema_version": 1,
            "kind": "operator_statement",
            "field_key": "description",
            "narrative_source_id": narrative_id,
            "line_start": 2,
            "line_end": 3,
        }
        endpoint = f"/api/intake/candidates/{candidate['id']}/evidence"
        first = self.client.post(endpoint, data=json.dumps(body), content_type="application/json",
            HTTP_IDEMPOTENCY_KEY="operator-lines-receipt-001")
        self.assertEqual(first.status_code, 201, first.content)
        replay = self.client.post(endpoint, data=json.dumps(body), content_type="application/json",
            HTTP_IDEMPOTENCY_KEY="operator-lines-receipt-001")
        self.assertEqual(replay.status_code, 200, replay.content)
        self.assertEqual(replay.json()["evidence"]["id"], first.json()["evidence"]["id"])
        self.assertEqual(replay.json()["evidence"]["line_start"], 2)
        self.assertEqual(replay.json()["evidence"]["line_end"], 3)
        self.assertEqual(replay.json()["evidence"]["status"], "unverified")
        self.assertNotIn(narrative_text, replay.content.decode("utf-8"))

        changed = {**body, "line_start": 1}
        conflict = self.client.post(endpoint, data=json.dumps(changed), content_type="application/json",
            HTTP_IDEMPOTENCY_KEY="operator-lines-receipt-001")
        self.assertEqual(conflict.status_code, 409)

        out_of_range = {**body, "line_end": 4}
        invalid = self.client.post(endpoint, data=json.dumps(out_of_range), content_type="application/json",
            HTTP_IDEMPOTENCY_KEY="operator-lines-invalid-001")
        self.assertEqual(invalid.status_code, 422)

    def test_evidence_source_record_must_be_in_candidate_snapshot(self):
        _source, preview, candidate = self.create_candidate()
        _foreign_source, foreign_preview, _foreign_candidate = self.create_candidate("foreign")
        body = {
            "schema_version": 1,
            "kind": "source_record",
            "field_key": "description",
            "snapshot_id": preview["id"],
            "sheet_index": 1,
            "coordinate": "A1",
        }
        endpoint = f"/api/intake/candidates/{candidate['id']}/evidence"
        accepted = self.client.post(endpoint, data=json.dumps(body), content_type="application/json",
            HTTP_IDEMPOTENCY_KEY="source-record-same-snapshot-001")
        self.assertEqual(accepted.status_code, 201, accepted.content)
        self.assertEqual(accepted.json()["evidence"]["snapshot_id"], preview["id"])

        foreign = {**body, "snapshot_id": foreign_preview["id"]}
        rejected = self.client.post(endpoint, data=json.dumps(foreign), content_type="application/json",
            HTTP_IDEMPOTENCY_KEY="source-record-foreign-snapshot-001")
        self.assertEqual(rejected.status_code, 422)

        absent_cell = {**body, "coordinate": "Z999"}
        rejected_cell = self.client.post(endpoint, data=json.dumps(absent_cell), content_type="application/json",
            HTTP_IDEMPOTENCY_KEY="source-record-absent-cell-001")
        self.assertEqual(rejected_cell.status_code, 422)

    def test_team_hypothesis_and_unregistered_derivation_stay_unverified(self):
        _source, preview, candidate = self.create_candidate(include_style_number=True)
        endpoint = f"/api/intake/candidates/{candidate['id']}/evidence"
        source_record_body = {
            "schema_version": 1,
            "kind": "source_record",
            "field_key": "style_number",
            "snapshot_id": preview["id"],
            "sheet_index": 1,
            "coordinate": "B1",
        }
        source_record = self.client.post(
            endpoint, data=json.dumps(source_record_body), content_type="application/json",
            HTTP_IDEMPOTENCY_KEY="team-hypothesis-source-input-001",
        )
        self.assertEqual(source_record.status_code, 201, source_record.content)
        team_body = {
            "schema_version": 1,
            "kind": "team_hypothesis",
            "field_key": "description",
            "snapshot_id": preview["id"],
            "sheet_index": 1,
            "coordinate": "A1",
            "summary": "合成假设，尚未确认",
            "input_record_ids": [source_record.json()["evidence"]["id"]],
        }
        team = self.client.post(endpoint, data=json.dumps(team_body), content_type="application/json",
            HTTP_IDEMPOTENCY_KEY="team-hypothesis-001")
        self.assertEqual(team.status_code, 201, team.content)
        self.assertEqual(team.json()["evidence"]["status"], "unverified")
        self.assertEqual(team.json()["evidence"]["summary"], team_body["summary"])
        self.assertEqual(team.json()["evidence"]["input_record_ids"], team_body["input_record_ids"])

        missing_inputs = {key: value for key, value in team_body.items() if key != "input_record_ids"}
        missing = self.client.post(endpoint, data=json.dumps(missing_inputs), content_type="application/json",
            HTTP_IDEMPOTENCY_KEY="team-hypothesis-missing-input-001")
        self.assertEqual(missing.status_code, 422)
        too_many_inputs = {**team_body, "input_record_ids": [f"{index:032x}" for index in range(21)]}
        too_many = self.client.post(endpoint, data=json.dumps(too_many_inputs), content_type="application/json",
            HTTP_IDEMPOTENCY_KEY="team-hypothesis-too-many-inputs-001")
        self.assertEqual(too_many.status_code, 422)

        _other_source, _other_preview, other_candidate = self.create_candidate(
            "other-team-input", include_style_number=True,
        )
        other_record = self.client.post(
            f"/api/intake/candidates/{other_candidate['id']}/evidence",
            data=json.dumps({**source_record_body, "snapshot_id": _other_preview["id"]}),
            content_type="application/json", HTTP_IDEMPOTENCY_KEY="foreign-team-source-record-001",
        )
        self.assertEqual(other_record.status_code, 201, other_record.content)
        foreign_input = {**team_body, "input_record_ids": [other_record.json()["evidence"]["id"]]}
        rejected_foreign_input = self.client.post(
            endpoint, data=json.dumps(foreign_input), content_type="application/json",
            HTTP_IDEMPOTENCY_KEY="team-hypothesis-foreign-input-001",
        )
        self.assertEqual(rejected_foreign_input.status_code, 422)

        derivation_body = {
            "schema_version": 1,
            "kind": "system_derivation",
            "field_key": "description",
            "snapshot_id": preview["id"],
            "sheet_index": 1,
            "coordinate": "A1",
            "rule_id": "not-registered",
            "rule_version": "1.0",
            "input_record_ids": [source_record.json()["evidence"]["id"]],
            "status": "succeeded",
        }
        derivation = self.client.post(endpoint, data=json.dumps(derivation_body), content_type="application/json",
            HTTP_IDEMPOTENCY_KEY="system-derivation-unverified-001")
        self.assertEqual(derivation.status_code, 422)
        del derivation_body["status"]
        accepted = self.client.post(endpoint, data=json.dumps(derivation_body), content_type="application/json",
            HTTP_IDEMPOTENCY_KEY="system-derivation-unverified-002")
        self.assertEqual(accepted.status_code, 201, accepted.content)
        self.assertEqual(accepted.json()["evidence"]["status"], "unverified")
        self.assertEqual(accepted.json()["evidence"]["rule_version"], "1.0")
        self.assertEqual(accepted.json()["evidence"]["input_record_ids"], derivation_body["input_record_ids"])

    def test_evidence_revisions_are_unique_append_only_and_listed_with_bounded_pagination(self):
        _source, preview, candidate = self.create_candidate()
        endpoint = f"/api/intake/candidates/{candidate['id']}/evidence"
        body = {
            "schema_version": 1,
            "kind": "source_record",
            "field_key": "description",
            "snapshot_id": preview["id"],
            "sheet_index": 1,
            "coordinate": "A1",
        }
        records = []
        for index in range(3):
            response = self.client.post(endpoint, data=json.dumps(body), content_type="application/json",
                HTTP_IDEMPOTENCY_KEY=f"evidence-revision-list-{index}-001")
            self.assertEqual(response.status_code, 201, response.content)
            records.append(response.json()["evidence"])
        self.assertEqual([row["revision"] for row in records], [1, 2, 3])

        first = self.client.get(f"{endpoint}?limit=2")
        self.assertEqual(first.status_code, 200, first.content)
        self.assertEqual([row["revision"] for row in first.json()["evidence"]], [1, 2])
        self.assertEqual(first.json()["next_offset"], 2)
        second = self.client.get(f"{endpoint}?offset=2&limit=2")
        self.assertEqual(second.status_code, 200, second.content)
        self.assertEqual([row["revision"] for row in second.json()["evidence"]], [3])
        self.assertIsNone(second.json()["next_offset"])
        self.assertEqual(self.client.get(f"{endpoint}?debug=1").status_code, 422)
        self.assertEqual(self.client.get(f"{endpoint}?limit=1&limit=2").status_code, 422)
        self.assertEqual(self.client.get(f"/api/intake/candidates/{'0' * 32}/evidence").status_code, 404)

    def test_evidence_and_receipt_roll_back_together_when_completion_fails(self):
        _source, preview, candidate = self.create_candidate()
        endpoint = f"/api/intake/candidates/{candidate['id']}/evidence"
        body = {
            "schema_version": 1,
            "kind": "source_record",
            "field_key": "description",
            "snapshot_id": preview["id"],
            "sheet_index": 1,
            "coordinate": "A1",
        }
        key = "evidence-atomic-completion-failure-001"
        with patch("workbench.intake.api._complete", side_effect=RuntimeError("synthetic failure")):
            failed = self.client.post(endpoint, data=json.dumps(body), content_type="application/json",
                                      HTTP_IDEMPOTENCY_KEY=key)
        self.assertEqual(failed.status_code, 503)
        self.assertFalse(EvidenceRecord.objects.filter(idempotency_key=key).exists())
        self.assertFalse(IntakeOperationReceipt.objects.filter(idempotency_key=key).exists())

        retried = self.client.post(endpoint, data=json.dumps(body), content_type="application/json",
                                   HTTP_IDEMPOTENCY_KEY=key)
        self.assertEqual(retried.status_code, 201, retried.content)
        replay = self.client.post(endpoint, data=json.dumps(body), content_type="application/json",
                                  HTTP_IDEMPOTENCY_KEY=key)
        self.assertEqual(replay.status_code, 200, replay.content)
        self.assertEqual(replay.json()["evidence"]["id"], retried.json()["evidence"]["id"])
        self.assertEqual(EvidenceRecord.objects.filter(idempotency_key=key).count(), 1)

    def test_concurrent_evidence_creates_allocate_distinct_revisions(self):
        _source, preview, candidate = self.create_candidate()
        endpoint = f"/api/intake/candidates/{candidate['id']}/evidence"
        body = {
            "schema_version": 1,
            "kind": "source_record",
            "field_key": "description",
            "snapshot_id": preview["id"],
            "sheet_index": 1,
            "coordinate": "A1",
        }
        barrier = Barrier(2)

        def submit(key):
            close_old_connections()
            try:
                barrier.wait(timeout=5)
                response = Client().post(endpoint, data=json.dumps(body), content_type="application/json",
                                         HTTP_IDEMPOTENCY_KEY=key)
                return response.status_code, response.json()
            finally:
                connection.close()

        with ThreadPoolExecutor(max_workers=2) as pool:
            results = list(pool.map(submit, ("evidence-concurrent-a-001", "evidence-concurrent-b-001"), timeout=15))
        self.assertEqual([status for status, _body in results], [201, 201])
        self.assertEqual(sorted(body["evidence"]["revision"] for _status, body in results), [1, 2])
        self.assertEqual(EvidenceRecord.objects.filter(candidate_id=candidate["id"]).count(), 2)

    def test_existing_five_receipt_result_types_keep_their_replay_dtos(self):
        content = self._synthetic_xlsx("Legacy receipt contract")
        uploaded = self.client.post("/api/intake/sources", {
            "file": SimpleUploadedFile("legacy.xlsx", content, "application/octet-stream")},
            HTTP_IDEMPOTENCY_KEY="legacy-source-replay-001")
        source = uploaded.json()["source"]
        source_replay = self.client.post("/api/intake/sources", {
            "file": SimpleUploadedFile("legacy.xlsx", content, "application/octet-stream")},
            HTTP_IDEMPOTENCY_KEY="legacy-source-replay-001")
        self.assertEqual(source_replay.status_code, 200)
        self.assertEqual(set(source_replay.json()), {"ok", "status", "source"})
        self.assertEqual(source_replay.json()["source"]["id"], source["id"])

        preview_request = self.client.post(f"/api/intake/sources/{source['id']}/previews", data="{}",
            content_type="application/json", HTTP_IDEMPOTENCY_KEY="legacy-preview-replay-001")
        preview = preview_request.json()["preview"]
        preview_replay = self.client.post(f"/api/intake/sources/{source['id']}/previews", data="{}",
            content_type="application/json", HTTP_IDEMPOTENCY_KEY="legacy-preview-replay-001")
        self.assertEqual(preview_replay.status_code, 200)
        self.assertEqual(set(preview_replay.json()), {"ok", "status", "preview"})

        mapping_body = {
            "schema_version": 1, "candidate_type": "product_identity", "source_sha256": source["sha256"],
            "expected_revision": 0, "fields": {"description": {"cells": [{"sheet_index": 1, "coordinate": "A1"}]}},
        }
        mapping_path = f"/api/intake/previews/{preview['id']}/mappings"
        mapping = self.client.post(mapping_path, data=json.dumps(mapping_body), content_type="application/json",
            HTTP_IDEMPOTENCY_KEY="legacy-mapping-replay-001")
        mapping_replay = self.client.post(mapping_path, data=json.dumps(mapping_body), content_type="application/json",
            HTTP_IDEMPOTENCY_KEY="legacy-mapping-replay-001")
        self.assertEqual(mapping_replay.status_code, 200)
        self.assertEqual(set(mapping_replay.json()), {"ok", "status", "mapping"})
        mapping_id = mapping.json()["mapping"]["id"]

        candidate_path = f"/api/intake/mappings/{mapping_id}/candidates"
        candidate = self.client.post(candidate_path, data="{}", content_type="application/json",
            HTTP_IDEMPOTENCY_KEY="legacy-candidate-replay-001")
        candidate_replay = self.client.post(candidate_path, data="{}", content_type="application/json",
            HTTP_IDEMPOTENCY_KEY="legacy-candidate-replay-001")
        self.assertEqual(candidate_replay.status_code, 200)
        self.assertEqual(set(candidate_replay.json()), {"ok", "status", "candidate"})

        _other_source, _other_preview, other_candidate = self.create_candidate("legacy-link-other")
        candidate_id = candidate.json()["candidate"]["id"]
        link_path = f"/api/intake/candidates/{candidate_id}/links"
        link_body = {"other_candidate_id": other_candidate["id"], "decision": "suggested"}
        link = self.client.post(link_path, data=json.dumps(link_body), content_type="application/json",
            HTTP_IDEMPOTENCY_KEY="legacy-link-replay-001")
        link_replay = self.client.post(link_path, data=json.dumps(link_body), content_type="application/json",
            HTTP_IDEMPOTENCY_KEY="legacy-link-replay-001")
        self.assertEqual(link_replay.status_code, 200)
        self.assertEqual(set(link_replay.json()), {"ok", "status", "link"})
        self.assertEqual(link_replay.json()["link"]["id"], link.json()["link"]["id"])

    def test_concurrent_same_key_narrative_upload_returns_one_source_and_receipt(self):
        content = "并发合成文本\n仅用于测试".encode("utf-8")
        barrier = Barrier(2)

        def submit():
            close_old_connections()
            try:
                barrier.wait(timeout=5)
                client = Client()
                response = client.post(
                    "/api/intake/narratives",
                    {"file": SimpleUploadedFile("parallel.txt", content, "text/plain")},
                    HTTP_IDEMPOTENCY_KEY="narrative-concurrent-001",
                )
                body = response.json() if response.get("Content-Type", "").startswith("application/json") else {}
                return response.status_code, body
            finally:
                connection.close()

        with ThreadPoolExecutor(max_workers=2) as pool:
            results = list(pool.map(lambda _index: submit(), range(2), timeout=15))

        self.assertCountEqual([status for status, _body in results], [200, 201])
        ids = {body["narrative"]["id"] for _status, body in results}
        self.assertEqual(len(ids), 1)
        self.assertEqual(NarrativeSourceVersion.objects.count(), 1)
        self.assertEqual(IntakeOperationReceipt.objects.filter(idempotency_key="narrative-concurrent-001").count(), 1)

    def test_new_evidence_records_are_append_only(self):
        _source, preview, candidate = self.create_candidate()
        body = {
            "schema_version": 1,
            "kind": "source_record",
            "field_key": "description",
            "snapshot_id": preview["id"],
            "sheet_index": 1,
            "coordinate": "A1",
        }
        response = self.client.post(f"/api/intake/candidates/{candidate['id']}/evidence",
            data=json.dumps(body), content_type="application/json",
            HTTP_IDEMPOTENCY_KEY="evidence-append-only-001")
        self.assertEqual(response.status_code, 201, response.content)
        record = EvidenceRecord.objects.get(pk=response.json()["evidence"]["id"])
        record.summary = "changed"
        with self.assertRaises(ValidationError):
            record.save()
