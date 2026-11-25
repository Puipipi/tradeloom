from __future__ import annotations

import json
import urllib.error
import urllib.request
from http.cookiejar import CookieJar
from io import BytesIO
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import patch
from datetime import timedelta

from django.core.files.uploadedfile import SimpleUploadedFile
from django.db import connection
from django.db.models import QuerySet
from django.test import Client, LiveServerTestCase, TransactionTestCase, override_settings
from django.db.migrations.executor import MigrationExecutor
from django.utils import timezone
from openpyxl import Workbook

from workbench.intake.mapping import fingerprint
from workbench.intake.storage import INTAKE_MARKER, INTAKE_MARKER_CONTENT
from workbench.models import (
    IntakeCandidate, IntakeCandidateLink, IntakeMappingRevision, IntakeOperationReceipt,
    IntakeSourceVersion, ProductionRequirementDraft,
    ProductionRequirementRevision, Task, WorkbookSnapshot,
)


class IntakeCandidateLinksTests(TransactionTestCase):
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
    def _workbook(description):
        workbook = Workbook()
        workbook.active["A1"] = description
        output = BytesIO()
        workbook.save(output)
        workbook.close()
        return output.getvalue()

    def create_candidate(self, suffix):
        source_response = self.client.post(
            "/api/intake/sources",
            {"file": SimpleUploadedFile(f"{suffix}.xlsx", self._workbook(f"Synthetic {suffix}"), "application/octet-stream")},
            HTTP_IDEMPOTENCY_KEY=f"links-source-{suffix}",
        )
        self.assertEqual(source_response.status_code, 201, source_response.content)
        source = source_response.json()["source"]
        preview_response = self.client.post(
            f"/api/intake/sources/{source['id']}/previews", data="{}", content_type="application/json",
            HTTP_IDEMPOTENCY_KEY=f"links-preview-{suffix}",
        )
        self.assertEqual(preview_response.status_code, 201, preview_response.content)
        preview = preview_response.json()["preview"]
        mapping_body = {
            "schema_version": 1, "candidate_type": "product_identity", "source_sha256": source["sha256"],
            "expected_revision": 0, "fields": {"description": {"cells": [{"sheet_index": 1, "coordinate": "A1"}]}},
        }
        mapping_response = self.client.post(
            f"/api/intake/previews/{preview['id']}/mappings", data=json.dumps(mapping_body),
            content_type="application/json", HTTP_IDEMPOTENCY_KEY=f"links-mapping-{suffix}",
        )
        self.assertEqual(mapping_response.status_code, 201, mapping_response.content)
        candidate_response = self.client.post(
            f"/api/intake/mappings/{mapping_response.json()['mapping']['id']}/candidates", data="{}",
            content_type="application/json", HTTP_IDEMPOTENCY_KEY=f"links-candidate-{suffix}",
        )
        self.assertEqual(candidate_response.status_code, 201, candidate_response.content)
        return source, candidate_response.json()["candidate"]

    def test_repeated_pair_records_readable_append_only_decision_history_on_both_sides(self):
        _source_a, candidate_a = self.create_candidate("history-a")
        _source_b, candidate_b = self.create_candidate("history-b")
        path = f"/api/intake/candidates/{candidate_a['id']}/links"
        original_a = IntakeCandidate.objects.get(pk=candidate_a["id"])
        original_b = IntakeCandidate.objects.get(pk=candidate_b["id"])

        first = self.client.post(path, data=json.dumps({
            "other_candidate_id": candidate_b["id"], "decision": "suggested", "reason": "Possible match",
        }), content_type="application/json", HTTP_IDEMPOTENCY_KEY="links-history-suggested-001")
        self.assertEqual(first.status_code, 201, first.content)
        second = self.client.post(path, data=json.dumps({
            "other_candidate_id": candidate_b["id"], "decision": "confirmed", "reason": "Checked source cells",
        }), content_type="application/json", HTTP_IDEMPOTENCY_KEY="links-history-confirmed-001")
        self.assertEqual(second.status_code, 201, second.content)

        self.assertEqual(IntakeCandidateLink.objects.count(), 2)
        first_row = IntakeCandidateLink.objects.get(pk=first.json()["link"]["id"])
        self.assertEqual(first_row.evidence, {"reason": "Possible match"})
        left_detail = self.client.get(f"/api/intake/candidates/{candidate_a['id']}").json()
        right_detail = self.client.get(f"/api/intake/candidates/{candidate_b['id']}").json()
        for detail in (left_detail, right_detail):
            self.assertEqual([item["decision"] for item in detail["links"]], ["confirmed", "suggested"])
            self.assertEqual([item["evidence"].get("reason", "") for item in detail["links"]],
                             ["Checked source cells", "Possible match"])
            self.assertTrue(all(item["actor"] == "local_workbench" and item["created_at"] for item in detail["links"]))
        first_page = self.client.get(f"/api/intake/candidates/{candidate_a['id']}/links?limit=1")
        self.assertEqual([item["id"] for item in first_page.json()["links"]], [second.json()["link"]["id"]])
        self.assertEqual(first_page.json()["next_offset"], 1)
        second_page = self.client.get(f"/api/intake/candidates/{candidate_a['id']}/links?offset=1&limit=1")
        self.assertEqual([item["id"] for item in second_page.json()["links"]], [first.json()["link"]["id"]])
        self.assertIsNone(second_page.json()["next_offset"])
        self.assertEqual(IntakeCandidate.objects.get(pk=candidate_a["id"]).status, original_a.status)
        self.assertEqual(IntakeCandidate.objects.get(pk=candidate_b["id"]).status, original_b.status)

    def test_legacy_receipt_replays_without_reason_and_keeps_old_fingerprint(self):
        _source_a, candidate_a = self.create_candidate("legacy-a")
        _source_b, candidate_b = self.create_candidate("legacy-b")
        pair = sorted([candidate_a["id"], candidate_b["id"]])
        legacy_body = {"other_candidate_id": candidate_b["id"], "decision": "suggested"}
        link = IntakeCandidateLink.objects.create(
            left_candidate_id=pair[0], right_candidate_id=pair[1], decision="suggested",
            evidence={}, idempotency_key="legacy-link-result-001",
        )
        key = "legacy-link-receipt-001"
        IntakeOperationReceipt.objects.create(
            idempotency_key=key, action="candidate_link",
            fingerprint=fingerprint({"action": "candidate_link", "pair": pair, "decision": "suggested"}),
            state=IntakeOperationReceipt.State.SUCCEEDED, result_type="link", result_id=link.pk,
        )
        replay = self.client.post(
            f"/api/intake/candidates/{candidate_a['id']}/links", data=json.dumps(legacy_body),
            content_type="application/json", HTTP_IDEMPOTENCY_KEY=key,
        )
        self.assertEqual(replay.status_code, 200, replay.content)
        self.assertEqual(replay.json()["link"]["id"], link.pk)
        self.assertEqual(IntakeCandidateLink.objects.count(), 1)

    def test_reason_and_arguments_are_validated_and_payload_changes_conflict(self):
        _source_a, candidate_a = self.create_candidate("validation-a")
        _source_b, candidate_b = self.create_candidate("validation-b")
        path = f"/api/intake/candidates/{candidate_a['id']}/links"
        for body in (
            {"other_candidate_id": None, "decision": "suggested"},
            {"other_candidate_id": [candidate_b["id"]], "decision": "suggested"},
            {"other_candidate_id": "bad", "decision": "suggested"},
            {"other_candidate_id": candidate_b["id"], "decision": ["confirmed"]},
            {"other_candidate_id": candidate_b["id"], "decision": "suggested", "reason": 12},
            {"other_candidate_id": candidate_b["id"], "decision": "suggested", "reason": "x" * 1001},
            {"other_candidate_id": candidate_b["id"], "decision": "suggested", "extra": "x"},
        ):
            response = self.client.post(path, data=json.dumps(body), content_type="application/json",
                                        HTTP_IDEMPOTENCY_KEY=f"invalid-link-{len(IntakeOperationReceipt.objects.all())}-{len(str(body))}")
            self.assertEqual(response.status_code, 422, response.content)
            self.assertEqual(response.json(), {"ok": False, "error_code": "invalid_arguments"})

        payload = {"other_candidate_id": candidate_b["id"], "decision": "suggested", "reason": "same key"}
        first = self.client.post(path, data=json.dumps(payload), content_type="application/json",
                                 HTTP_IDEMPOTENCY_KEY="link-reason-conflict-001")
        self.assertEqual(first.status_code, 201, first.content)
        conflicting = self.client.post(path, data=json.dumps({**payload, "reason": "changed"}),
                                       content_type="application/json", HTTP_IDEMPOTENCY_KEY="link-reason-conflict-001")
        self.assertEqual(conflicting.status_code, 409)
        self.assertEqual(conflicting.json()["error_code"], "idempotency_conflict")

    def test_unexpected_storage_failure_returns_safe_error_and_rolls_back_receipt(self):
        _source_a, candidate_a = self.create_candidate("storage-a")
        _source_b, candidate_b = self.create_candidate("storage-b")
        key = "link-storage-failure-001"
        with patch("workbench.intake.api._complete", side_effect=RuntimeError("synthetic private failure")):
            response = self.client.post(
                f"/api/intake/candidates/{candidate_a['id']}/links",
                data=json.dumps({"other_candidate_id": candidate_b["id"], "decision": "suggested"}),
                content_type="application/json", HTTP_IDEMPOTENCY_KEY=key,
            )
        self.assertEqual(response.status_code, 503)
        self.assertEqual(response.json(), {"ok": False, "error_code": "unavailable"})
        self.assertFalse(IntakeOperationReceipt.objects.filter(idempotency_key=key).exists())
        self.assertEqual(IntakeCandidateLink.objects.count(), 0)

    def test_0010_preserves_existing_0009_link_then_allows_next_decision(self):
        _source_a, candidate_a = self.create_candidate("migration-a")
        _source_b, candidate_b = self.create_candidate("migration-b")
        path = f"/api/intake/candidates/{candidate_a['id']}/links"
        existing = self.client.post(
            path, data=json.dumps({"other_candidate_id": candidate_b["id"], "decision": "suggested"}),
            content_type="application/json", HTTP_IDEMPOTENCY_KEY="migration-existing-link-001",
        )
        self.assertEqual(existing.status_code, 201, existing.content)
        link_id = existing.json()["link"]["id"]
        executor = MigrationExecutor(connection)
        restore_targets = executor.loader.graph.leaf_nodes("workbench")
        try:
            executor.migrate([("workbench", "0009_execution_plan_revision")])
            executor = MigrationExecutor(connection)
            executor.migrate([("workbench", "0010_intake_candidate_link_history")])
            self.assertEqual(IntakeCandidateLink.objects.filter(pk=link_id).count(), 1)
            follow_up = self.client.post(
                path, data=json.dumps({"other_candidate_id": candidate_b["id"], "decision": "confirmed", "reason": "second judgment"}),
                content_type="application/json", HTTP_IDEMPOTENCY_KEY="migration-follow-up-link-001",
            )
            self.assertEqual(follow_up.status_code, 201, follow_up.content)
            self.assertEqual(list(IntakeCandidateLink.objects.filter(
                left_candidate_id=min(candidate_a["id"], candidate_b["id"]),
                right_candidate_id=max(candidate_a["id"], candidate_b["id"]),
            ).order_by("-created_at", "-id").values_list("decision", flat=True)), ["confirmed", "suggested"])
        finally:
            MigrationExecutor(connection).migrate(restore_targets)

    def test_recent_history_stays_first_when_history_exceeds_projection_window(self):
        _source_a, candidate_a = self.create_candidate("large-history-a")
        _source_b, candidate_b = self.create_candidate("large-history-b")
        pair = sorted([candidate_a["id"], candidate_b["id"]])
        base_time = timezone.now()
        rows = []
        for index in range(25):
            rows.append(IntakeCandidateLink.objects.create(
                left_candidate_id=pair[0], right_candidate_id=pair[1],
                decision="confirmed" if index == 24 else "suggested",
                evidence={"reason": f"history {index}"}, idempotency_key=f"large-history-{index:02}-001",
            ))
        for index, row in enumerate(rows):
            QuerySet.update(IntakeCandidateLink.objects.filter(pk=row.pk), created_at=base_time + timedelta(seconds=index))
        candidate_detail = self.client.get(f"/api/intake/candidates/{candidate_a['id']}").json()
        self.assertEqual(candidate_detail["links"][0]["id"], rows[-1].pk)
        self.assertEqual(candidate_detail["links"][0]["decision"], "confirmed")
        page = self.client.get(f"/api/intake/candidates/{candidate_a['id']}/links?limit=50").json()
        self.assertEqual(page["links"][0]["id"], rows[-1].pk)
        self.assertIsNone(page["next_offset"])


class IntakeCandidateLinksLiveHttpTests(LiveServerTestCase):
    host = "127.0.0.1"

    def setUp(self):
        self.temp = TemporaryDirectory()
        self.data_root = Path(self.temp.name) / "data"
        self.intake_root = self.data_root / "private" / "intake"
        self.intake_root.mkdir(parents=True)
        (self.intake_root / INTAKE_MARKER).write_text(INTAKE_MARKER_CONTENT, encoding="utf-8")
        self.settings_override = override_settings(
            TRADELOOM_DATA_ROOT=self.data_root,
            TRADELOOM_INTAKE_ROOT=self.intake_root,
            ALLOWED_HOSTS=["127.0.0.1", "localhost", "testserver"],
            CSRF_TRUSTED_ORIGINS=[self.live_server_url],
        )
        self.settings_override.enable()
        self.client = Client()
        self.cookies = CookieJar()
        self.opener = urllib.request.build_opener(
            urllib.request.ProxyHandler({}), urllib.request.HTTPCookieProcessor(self.cookies),
        )
        self.http("GET", "/artifacts")
        self.csrf = next((cookie.value for cookie in self.cookies if cookie.name == "csrftoken"), None)
        self.assertTrue(self.csrf, "artifacts page must provide a CSRF cookie for the real HTTP mutation")

    def tearDown(self):
        self.settings_override.disable()
        self.temp.cleanup()

    def http(self, method, path, body=None, key=None):
        headers = {"Accept": "application/json"}
        if method in {"POST", "PUT", "PATCH", "DELETE"}:
            headers["Origin"] = self.live_server_url
            headers["X-CSRFToken"] = getattr(self, "csrf", "") or ""
            headers["Content-Type"] = "application/json"
        if key:
            headers["Idempotency-Key"] = key
        request = urllib.request.Request(
            f"{self.live_server_url}{path}", data=body.encode("utf-8") if body is not None else None,
            headers=headers, method=method,
        )
        try:
            with self.opener.open(request, timeout=10) as response:
                return response.status, response.read()
        except urllib.error.HTTPError as error:
            return error.code, error.read()

    def create_candidate(self, suffix):
        workbook = Workbook()
        workbook.active["A1"] = f"Synthetic {suffix}"
        data = BytesIO()
        workbook.save(data)
        workbook.close()
        source_response = self.client.post(
            "/api/intake/sources",
            {"file": SimpleUploadedFile(f"{suffix}.xlsx", data.getvalue(), "application/octet-stream")},
            HTTP_IDEMPOTENCY_KEY=f"live-links-source-{suffix}",
        )
        self.assertEqual(source_response.status_code, 201, source_response.content)
        source = source_response.json()["source"]
        preview = self.client.post(
            f"/api/intake/sources/{source['id']}/previews", data="{}", content_type="application/json",
            HTTP_IDEMPOTENCY_KEY=f"live-links-preview-{suffix}",
        )
        self.assertEqual(preview.status_code, 201, preview.content)
        mapping = self.client.post(
            f"/api/intake/previews/{preview.json()['preview']['id']}/mappings",
            data=json.dumps({
                "schema_version": 1, "candidate_type": "product_identity", "source_sha256": source["sha256"],
                "expected_revision": 0, "fields": {"description": {"cells": [{"sheet_index": 1, "coordinate": "A1"}]}},
            }), content_type="application/json", HTTP_IDEMPOTENCY_KEY=f"live-links-mapping-{suffix}",
        )
        self.assertEqual(mapping.status_code, 201, mapping.content)
        candidate = self.client.post(
            f"/api/intake/mappings/{mapping.json()['mapping']['id']}/candidates", data="{}",
            content_type="application/json", HTTP_IDEMPOTENCY_KEY=f"live-links-candidate-{suffix}",
        )
        self.assertEqual(candidate.status_code, 201, candidate.content)
        return source, candidate.json()["candidate"]

    def test_real_http_creates_and_reads_link_decision_history_without_business_mutation(self):
        source_a, candidate_a = self.create_candidate("http-a")
        _source_b, candidate_b = self.create_candidate("http-b")
        stable_models = (Task, IntakeSourceVersion, WorkbookSnapshot,
                         IntakeMappingRevision, IntakeCandidate, ProductionRequirementDraft, ProductionRequirementRevision)
        initial_counts = {model: model.objects.count() for model in stable_models}
        initial_statuses = [IntakeCandidate.objects.get(pk=item["id"]).status for item in (candidate_a, candidate_b)]
        initial_candidate_payloads = [self.client.get(f"/api/intake/candidates/{item['id']}").json()["candidate"]
                                      for item in (candidate_a, candidate_b)]
        path = f"/api/intake/candidates/{candidate_a['id']}/links"
        suggested = {"other_candidate_id": candidate_b["id"], "decision": "suggested", "reason": "Possible relation"}
        confirmed = {"other_candidate_id": candidate_b["id"], "decision": "confirmed", "reason": "Compared both source records"}
        first_status, first_body = self.http("POST", path, json.dumps(suggested), "live-http-suggested-001")
        self.assertEqual(first_status, 201, first_body)
        second_status, second_body = self.http("POST", path, json.dumps(confirmed), "live-http-confirmed-001")
        self.assertEqual(second_status, 201, second_body)
        first_link = json.loads(first_body)["link"]
        second_link = json.loads(second_body)["link"]
        self.assertEqual(first_link["actor"], "local_workbench")
        self.assertTrue(first_link["created_at"])

        for candidate in (candidate_a, candidate_b):
            status, body = self.http("GET", f"/api/intake/candidates/{candidate['id']}/links?limit=50")
            self.assertEqual(status, 200, body)
            history = json.loads(body)["links"]
            self.assertEqual([item["decision"] for item in history], ["confirmed", "suggested"])
            self.assertEqual([item["id"] for item in history], [second_link["id"], first_link["id"]])
        filtered_status, filtered_body = self.http(
            "GET", f"/api/intake/candidates?source_id={source_a['id']}&limit=10",
        )
        self.assertEqual(filtered_status, 200, filtered_body)
        self.assertEqual([item["id"] for item in json.loads(filtered_body)["candidates"]], [candidate_a["id"]])

        replay_status, replay_body = self.http("POST", path, json.dumps(confirmed), "live-http-confirmed-001")
        self.assertEqual(replay_status, 200, replay_body)
        self.assertEqual(json.loads(replay_body)["link"]["id"], second_link["id"])
        conflict_status, conflict_body = self.http(
            "POST", path, json.dumps({**confirmed, "reason": "changed"}), "live-http-confirmed-001",
        )
        self.assertEqual(conflict_status, 409, conflict_body)
        self.assertEqual(IntakeCandidateLink.objects.count(), 2)
        self.assertEqual({model: model.objects.count() for model in stable_models}, initial_counts)
        self.assertEqual([IntakeCandidate.objects.get(pk=item["id"]).status for item in (candidate_a, candidate_b)], initial_statuses)
        self.assertEqual([self.client.get(f"/api/intake/candidates/{item['id']}").json()["candidate"]
                          for item in (candidate_a, candidate_b)], initial_candidate_payloads)

    def test_candidate_detail_returns_bounded_latest_preview_and_same_source_links_are_allowed(self):
        source, first = self.create_candidate("same-source-a")
        preview = self.client.post(
            f"/api/intake/sources/{source['id']}/previews", data="{}", content_type="application/json",
            HTTP_IDEMPOTENCY_KEY="live-links-same-source-preview-extra",
        )
        self.assertEqual(preview.status_code, 200, preview.content)
        mapping = self.client.post(
            f"/api/intake/previews/{preview.json()['preview']['id']}/mappings",
            data=json.dumps({"schema_version": 1, "candidate_type": "commercial_source",
                "source_sha256": source["sha256"], "expected_revision": 0,
                "fields": {"item_description": {"cells": [{"sheet_index": 1, "coordinate": "A1"}]}}}),
            content_type="application/json", HTTP_IDEMPOTENCY_KEY="live-links-same-source-mapping-extra",
        )
        self.assertEqual(mapping.status_code, 201, mapping.content)
        second_response = self.client.post(
            f"/api/intake/mappings/{mapping.json()['mapping']['id']}/candidates", data="{}",
            content_type="application/json", HTTP_IDEMPOTENCY_KEY="live-links-same-source-candidate-extra",
        )
        self.assertEqual(second_response.status_code, 201, second_response.content)
        second = second_response.json()["candidate"]
        self.assertNotEqual(first["id"], second["id"])
        create_status, create_body = self.http("POST", f"/api/intake/candidates/{first['id']}/links",
            json.dumps({"other_candidate_id": second["id"], "decision": "suggested", "reason": "Same file, separate extracted objects"}),
            "live-links-same-source-link")
        self.assertEqual(create_status, 201, create_body)

        for index in range(20):
            status, body = self.http("POST", f"/api/intake/candidates/{first['id']}/links",
                json.dumps({"other_candidate_id": second["id"], "decision": "confirmed" if index == 19 else "suggested"}),
                f"live-links-preview-history-{index:02d}")
            self.assertEqual(status, 201, body)

        detail = self.client.get(f"/api/intake/candidates/{first['id']}").json()
        self.assertEqual(len(detail["links"]), 20)
        self.assertEqual(detail["links"][0]["decision"], "confirmed")
        self.assertEqual(detail["links_next_offset"], 20)
        history = self.client.get(f"/api/intake/candidates/{first['id']}/links?offset=20&limit=50").json()
        self.assertEqual(len(history["links"]), 1)
        self.assertIsNone(history["next_offset"])

    def test_candidate_collection_filters_by_source_and_paginates(self):
        source_a, candidate_a = self.create_candidate("source-a")
        self.create_candidate("source-b")
        page = self.client.get(f"/api/intake/candidates?source_id={source_a['id']}&limit=1")
        self.assertEqual(page.status_code, 200, page.content)
        self.assertEqual([row["id"] for row in page.json()["candidates"]], [candidate_a["id"]])
        self.assertIsNone(page.json()["next_offset"])
        self.assertEqual(self.client.get("/api/intake/candidates?source_id=bad").status_code, 422)
        self.assertEqual(self.client.get(f"/api/intake/candidates?source_id={source_a['id']}&extra=x").status_code, 422)
