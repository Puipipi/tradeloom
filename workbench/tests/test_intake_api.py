from __future__ import annotations

import json
import hashlib
from io import BytesIO
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import patch

from django.core.files.uploadedfile import SimpleUploadedFile
from django.test import Client, TestCase, override_settings
from openpyxl import Workbook
from openpyxl.drawing.image import Image as WorksheetImage
from PIL import Image
from threading import Event, Lock, Thread
from django.db import close_old_connections
from django.test import TransactionTestCase

from workbench.intake.storage import INTAKE_MARKER, INTAKE_MARKER_CONTENT
from workbench.models import (BatchItem, ErpNextDraftOperation, IntakeOperationReceipt, IntakeSourceVersion)


def synthetic_xlsx() -> bytes:
    workbook = Workbook()
    sheet = workbook.active
    sheet.title = "Synthetic"
    sheet["A1"] = "Synthetic item"
    sheet["B1"] = 0
    sheet["C1"] = "=1+2"
    output = BytesIO()
    workbook.save(output)
    workbook.close()
    return output.getvalue()


def synthetic_image_xlsx() -> bytes:
    workbook = Workbook()
    workbook.active["A1"] = "Synthetic"
    image_bytes = BytesIO()
    image = Image.new("RGB", (2, 2), (12, 34, 56))
    image.save(image_bytes, format="PNG")
    image.close()
    workbook.active.add_image(WorksheetImage(BytesIO(image_bytes.getvalue())), "B2")
    output = BytesIO()
    workbook.save(output)
    workbook.close()
    return output.getvalue()


class IntakeApiTests(TestCase):
    def setUp(self):
        self.temp = TemporaryDirectory()
        self.data_root = Path(self.temp.name) / "data"
        self.intake_root = self.data_root / "private" / "intake"
        self.intake_root.mkdir(parents=True)
        (self.intake_root / INTAKE_MARKER).write_text(INTAKE_MARKER_CONTENT, encoding="utf-8")
        self.settings = override_settings(
            TRADELOOM_DATA_ROOT=self.data_root,
            TRADELOOM_INTAKE_ROOT=self.intake_root,
        )
        self.settings.enable()
        self.client = Client()
        self.workbook = synthetic_xlsx()

    def tearDown(self):
        self.settings.disable()
        self.temp.cleanup()

    def upload(self, key="upload-001", content=None, filename="synthetic.xlsx"):
        return self.client.post(
            "/api/intake/sources",
            {"file": SimpleUploadedFile(filename, content or self.workbook, "application/octet-stream")},
            HTTP_IDEMPOTENCY_KEY=key,
        )

    def test_source_list_supports_bounded_offset_pagination(self):
        for index in range(3):
            workbook = Workbook()
            workbook.active["A1"] = f"synthetic-{index}"
            output = BytesIO()
            workbook.save(output)
            workbook.close()
            response = self.upload(key=f"source-page-{index}", content=output.getvalue())
            self.assertEqual(response.status_code, 201)

        all_sources = self.client.get("/api/intake/sources?limit=3").json()["sources"]
        page = self.client.get("/api/intake/sources?offset=1&limit=1")
        self.assertEqual(page.status_code, 200)
        self.assertEqual([source["id"] for source in page.json()["sources"]], [all_sources[1]["id"]])
        self.assertEqual(page.json()["next_offset"], 2)
        last_page = self.client.get("/api/intake/sources?offset=2&limit=1")
        self.assertEqual([source["id"] for source in last_page.json()["sources"]], [all_sources[2]["id"]])
        self.assertIsNone(last_page.json()["next_offset"])

        invalid = self.client.get("/api/intake/sources?offset=-1&limit=101")
        self.assertEqual(invalid.status_code, 422)
        self.assertEqual(invalid.json(), {"ok": False, "error_code": "invalid_arguments"})

    def test_source_list_has_safe_persisted_display_name_and_duplicate_sha_keeps_first_name(self):
        first = self.upload(filename="incoming-sheet.xlsx")
        self.assertEqual(first.status_code, 201)
        first_source = first.json()["source"]
        self.assertEqual(first_source["display_name"], "incoming-sheet.xlsx")
        self.assertNotIn("original_name", first_source)
        self.assertNotIn("storage_key", first_source)

        duplicate = self.upload(key="upload-name-duplicate", filename="renamed-copy.xlsx")
        self.assertEqual(duplicate.status_code, 200)
        self.assertEqual(duplicate.json()["source"]["id"], first_source["id"])
        self.assertEqual(duplicate.json()["source"]["display_name"], "incoming-sheet.xlsx")

    def test_preview_supports_bounded_sheet_row_column_window_without_lexical_order(self):
        uploaded = self.upload()
        source_id = uploaded.json()["source"]["id"]
        previewed = self.client.post(
            f"/api/intake/sources/{source_id}/previews", data="{}",
            content_type="application/json", HTTP_IDEMPOTENCY_KEY="preview-window-001",
        )
        snapshot_id = previewed.json()["preview"]["id"]

        response = self.client.get(
            f"/api/intake/previews/{snapshot_id}?sheet_index=1&row_start=1&row_count=2&col_start=1&col_count=3"
        )
        self.assertEqual(response.status_code, 200)
        body = response.json()
        self.assertEqual(body["window"], {
            "sheet_index": 1, "row_start": 1, "row_count": 2,
            "col_start": 1, "col_count": 3,
        })
        self.assertEqual(len(body["rows"]), 2)
        self.assertEqual([cell["coordinate"] for cell in body["rows"][0]], ["A1", "B1", "C1"])
        self.assertEqual(body["rows"][0][1]["normalized_value"], 0)
        formula = body["rows"][0][2]
        self.assertEqual(formula["formula"], "1+2")
        self.assertEqual(formula["cached_value"]["state"], "empty")
        self.assertTrue(body["rows"][1][0]["blank"])

    def test_preview_offset_pages_use_all_persisted_cell_references(self):
        from workbench.models import SourceCellSnapshot, WorkbookSnapshot

        workbook = Workbook()
        workbook.active.title = "First"
        workbook.active["A1"] = "one non-empty cell"
        second_sheet = workbook.create_sheet("Second")
        second_sheet["B2"] = "another non-empty cell"
        output = BytesIO()
        workbook.save(output)
        workbook.close()

        uploaded = self.upload(key="preview-refcount-upload", content=output.getvalue())
        self.assertEqual(uploaded.status_code, 201)
        source_id = uploaded.json()["source"]["id"]
        created = self.client.post(
            f"/api/intake/sources/{source_id}/previews", data="{}", content_type="application/json",
            HTTP_IDEMPOTENCY_KEY="preview-refcount-create",
        )
        self.assertEqual(created.status_code, 201)
        snapshot_id = created.json()["preview"]["id"]
        snapshot = WorkbookSnapshot.objects.get(pk=snapshot_id)
        self.assertEqual(snapshot.cell_count, 2)
        first, second = [snapshot.sheets.get(sheet_index=index) for index in (1, 2)]
        for sheet, coordinates in ((first, ("A2", "A3", "B3")), (second, ("A1", "A2", "C2"))):
            SourceCellSnapshot.objects.bulk_create([
                SourceCellSnapshot(sheet=sheet, coordinate=coordinate, source_type="blank")
                for coordinate in coordinates
            ])

        pages = []
        for offset in (0, 3, 6):
            response = self.client.get(f"/api/intake/previews/{snapshot_id}?offset={offset}&limit=3")
            self.assertEqual(response.status_code, 200)
            page = response.json()
            pages.extend((cell["sheet_index"], cell["coordinate"]) for cell in page["cells"])
            expected_next = offset + 3 if offset < 6 else None
            self.assertEqual(page["next_offset"], expected_next)
            self.assertEqual(page["preview"]["cell_count"], 2)
            self.assertEqual(page["preview"]["cell_reference_count"], 8)

        self.assertEqual(len(pages), 8)
        self.assertEqual(len(set(pages)), 8)
        source_list = self.client.get("/api/intake/sources").json()["sources"]
        source_row = next(row for row in source_list if row["id"] == source_id)
        self.assertEqual(source_row["snapshots"][0]["cell_count"], 2)
        self.assertEqual(source_row["snapshots"][0]["cell_reference_count"], 8)

        window = self.client.get(
            f"/api/intake/previews/{snapshot_id}?sheet_index=2&row_start=1&row_count=2&col_start=1&col_count=2"
        )
        self.assertEqual(window.status_code, 200)
        self.assertEqual(window.json()["preview"]["cell_count"], 2)
        self.assertEqual(window.json()["preview"]["cell_reference_count"], 8)
        self.assertEqual(window.json()["rows"][1][1]["coordinate"], "B2")

    def test_preview_window_rejects_invalid_sheet_and_windows_over_500_cells(self):
        uploaded = self.upload()
        source_id = uploaded.json()["source"]["id"]
        previewed = self.client.post(
            f"/api/intake/sources/{source_id}/previews", data="{}",
            content_type="application/json", HTTP_IDEMPOTENCY_KEY="preview-window-invalid-001",
        )
        snapshot_id = previewed.json()["preview"]["id"]

        oversized = self.client.get(
            f"/api/intake/previews/{snapshot_id}?sheet_index=1&row_start=1&row_count=25&col_start=1&col_count=21"
        )
        missing_sheet = self.client.get(
            f"/api/intake/previews/{snapshot_id}?sheet_index=2&row_start=1&row_count=1&col_start=1&col_count=1"
        )
        self.assertEqual(oversized.status_code, 422)
        self.assertEqual(oversized.json(), {"ok": False, "error_code": "invalid_arguments"})
        self.assertEqual(missing_sheet.status_code, 404)
        self.assertEqual(missing_sheet.json(), {"ok": False, "error_code": "preview_not_found"})

    def test_upload_preview_mapping_and_candidate_are_source_bound_and_idempotent(self):
        before = (BatchItem.objects.count(), ErpNextDraftOperation.objects.count())
        uploaded = self.upload()
        self.assertEqual(uploaded.status_code, 201)
        source = uploaded.json()["source"]
        self.assertNotIn("path", uploaded.json())
        self.assertNotIn("original_name", uploaded.json())

        replay = self.upload()
        self.assertEqual(replay.status_code, 200)
        self.assertEqual(replay.json()["source"]["id"], source["id"])
        conflict = self.upload(content=synthetic_xlsx() + b"different")
        self.assertEqual(conflict.status_code, 409)

        previewed = self.client.post(f"/api/intake/sources/{source['id']}/previews", data="{}", content_type="application/json", HTTP_IDEMPOTENCY_KEY="preview-001")
        self.assertEqual(previewed.status_code, 201)
        preview_id = previewed.json()["preview"]["id"]
        preview = self.client.get(f"/api/intake/previews/{preview_id}?offset=0&limit=20")
        self.assertEqual(preview.status_code, 200)
        self.assertEqual(preview.json()["cells"][0]["coordinate"], "A1")
        first_page = self.client.get(f"/api/intake/previews/{preview_id}?offset=0&limit=1")
        self.assertEqual(first_page.json()["next_offset"], 1)

        mapping = {
            "schema_version": 1,
            "candidate_type": "product_identity",
            "source_sha256": preview.json()["preview"]["source_sha256"],
            "expected_revision": 0,
            "fields": {
                "description": {"cells": [{"sheet_index": 1, "coordinate": "A1"}]},
                "width": {"cells": [{"sheet_index": 1, "coordinate": "B1"}]},
                "roll_length": {"cells": [{"sheet_index": 1, "coordinate": "C1"}]},
            },
        }
        mapped = self.client.post(
            f"/api/intake/previews/{preview_id}/mappings",
            data=json.dumps(mapping), content_type="application/json", HTTP_IDEMPOTENCY_KEY="mapping-001",
        )
        self.assertEqual(mapped.status_code, 201)
        mapped_replay = self.client.post(
            f"/api/intake/previews/{preview_id}/mappings",
            data=json.dumps(mapping), content_type="application/json", HTTP_IDEMPOTENCY_KEY="mapping-001",
        )
        self.assertEqual(mapped_replay.status_code, 200)
        stale = {**mapping, "fields": {"description": {"cells": [{"sheet_index": 1, "coordinate": "B1"}]}}}
        stale_result = self.client.post(
            f"/api/intake/previews/{preview_id}/mappings", data=json.dumps(stale),
            content_type="application/json", HTTP_IDEMPOTENCY_KEY="mapping-stale",
        )
        self.assertEqual(stale_result.status_code, 409)
        conflicting_replay = {**mapping, "fields": {"description": {"cells": [{"sheet_index": 1, "coordinate": "B1"}]}}}
        key_conflict = self.client.post(
            f"/api/intake/previews/{preview_id}/mappings", data=json.dumps(conflicting_replay),
            content_type="application/json", HTTP_IDEMPOTENCY_KEY="mapping-001",
        )
        self.assertEqual(key_conflict.status_code, 409)
        candidate = self.client.post(
            f"/api/intake/mappings/{mapped.json()['mapping']['id']}/candidates",
            data="{}", content_type="application/json", HTTP_IDEMPOTENCY_KEY="candidate-001",
        )
        self.assertEqual(candidate.status_code, 201)
        self.assertEqual(candidate.json()["candidate"]["status"], "unconfirmed")
        self.assertEqual(candidate.json()["candidate"]["fields"]["width"][0], {"state": "present", "type": "decimal", "value": "0"})
        self.assertEqual(candidate.json()["candidate"]["fields"]["roll_length"][0], {"state": "formula_cache_empty", "type": "decimal", "value": None})
        self.assertEqual(candidate.json()["candidate"]["provenance"]["width"][0]["coordinate"], "B1")
        self.assertEqual(len(self.client.get("/api/intake/candidates").json()["candidates"]), 1)
        self.assertEqual((BatchItem.objects.count(), ErpNextDraftOperation.objects.count()), before)

    def test_upload_completion_failure_after_receipt_save_rolls_back_source_and_owned_file(self):
        from workbench.intake.api import _complete as real_complete

        def complete_then_interrupt(receipt, result_type, result_id):
            real_complete(receipt, result_type, result_id)
            raise RuntimeError("synthetic completion interruption")

        with patch("workbench.intake.api._complete", side_effect=complete_then_interrupt):
            failed = self.upload(key="source-complete-then-interrupt")

        self.assertEqual(failed.status_code, 503)
        self.assertEqual(IntakeSourceVersion.objects.count(), 0)
        self.assertEqual(list((self.intake_root / "objects").rglob("*.xlsx")), [])
        receipt = IntakeOperationReceipt.objects.get(idempotency_key="source-complete-then-interrupt")
        self.assertEqual(receipt.state, IntakeOperationReceipt.State.FAILED)
        self.assertEqual(receipt.error_code, "unavailable")

        replay = self.upload(key="source-complete-then-interrupt")
        self.assertEqual(replay.status_code, 503)
        self.assertEqual(IntakeSourceVersion.objects.count(), 0)

    def test_duplicate_sha_completion_failure_preserves_preexisting_source_object(self):
        from workbench.intake.api import _complete as real_complete

        first = self.upload(key="source-existing-sha-original")
        self.assertEqual(first.status_code, 201)
        source = IntakeSourceVersion.objects.get(pk=first.json()["source"]["id"])
        original_path = self.intake_root / "objects" / source.storage_key
        original_bytes = original_path.read_bytes()
        source_count = IntakeSourceVersion.objects.count()

        def complete_then_interrupt(receipt, result_type, result_id):
            real_complete(receipt, result_type, result_id)
            raise RuntimeError("synthetic duplicate completion interruption")

        with patch("workbench.intake.api._complete", side_effect=complete_then_interrupt):
            failed = self.upload(key="source-existing-sha-interrupted")

        self.assertEqual(failed.status_code, 503)
        self.assertEqual(IntakeSourceVersion.objects.count(), source_count)
        self.assertTrue(original_path.is_file())
        self.assertEqual(original_path.read_bytes(), original_bytes)
        receipt = IntakeOperationReceipt.objects.get(idempotency_key="source-existing-sha-interrupted")
        self.assertEqual(receipt.state, IntakeOperationReceipt.State.FAILED)

        replay = self.upload(key="source-existing-sha-interrupted")
        self.assertEqual(replay.status_code, 503)
        self.assertEqual(IntakeSourceVersion.objects.count(), source_count)
        self.assertEqual(original_path.read_bytes(), original_bytes)

    def test_upload_keeps_new_object_when_cleanup_reference_check_is_uncertain(self):
        from workbench.intake.api import _complete as real_complete

        def complete_then_interrupt(receipt, result_type, result_id):
            real_complete(receipt, result_type, result_id)
            raise RuntimeError("synthetic completion interruption")

        with (patch("workbench.intake.api._complete", side_effect=complete_then_interrupt),
              patch("workbench.intake.storage.IntakeSourceVersion.objects.filter",
                    side_effect=RuntimeError("synthetic reference lookup failure"))):
            failed = self.upload(key="source-cleanup-uncertain")

        self.assertEqual(failed.status_code, 503)
        self.assertEqual(IntakeSourceVersion.objects.count(), 0)
        owned_files = list((self.intake_root / "objects").rglob("*.xlsx"))
        self.assertEqual(len(owned_files), 1)
        receipt = IntakeOperationReceipt.objects.get(idempotency_key="source-cleanup-uncertain")
        self.assertEqual(receipt.state, IntakeOperationReceipt.State.FAILED)

    def test_reserved_upload_replay_stays_pending_and_payload_change_conflicts(self):
        from workbench.intake.mapping import fingerprint

        key = "source-reserved-pending-001"
        receipt_fingerprint = fingerprint({
            "action": "upload", "sha256": hashlib.sha256(self.workbook).hexdigest(),
        })
        IntakeOperationReceipt.objects.create(
            idempotency_key=key, action="upload", fingerprint=receipt_fingerprint,
            state=IntakeOperationReceipt.State.RESERVED,
        )
        pending = self.upload(key=key)
        self.assertEqual(pending.status_code, 202)
        self.assertEqual(pending.json()["status"], "pending")
        self.assertEqual(IntakeSourceVersion.objects.count(), 0)

        other = Workbook()
        other.active["A1"] = "different synthetic workbook"
        output = BytesIO()
        other.save(output)
        other.close()
        conflict = self.upload(key=key, content=output.getvalue())
        self.assertEqual(conflict.status_code, 409)
        self.assertEqual(IntakeSourceVersion.objects.count(), 0)

    def test_upload_rejects_multiple_files_with_the_same_multipart_field(self):
        from workbench.models import IntakeOperationReceipt, IntakeSourceVersion

        response = self.client.post(
            "/api/intake/sources",
            {"file": [
                SimpleUploadedFile("first.xlsx", self.workbook, "application/octet-stream"),
                SimpleUploadedFile("second.xlsx", self.workbook, "application/octet-stream"),
            ]},
            HTTP_IDEMPOTENCY_KEY="upload-duplicate-file-001",
        )

        self.assertEqual(response.status_code, 422)
        self.assertEqual(response.json(), {"ok": False, "error_code": "invalid_source"})
        self.assertFalse(IntakeOperationReceipt.objects.filter(idempotency_key="upload-duplicate-file-001").exists())
        self.assertFalse(IntakeSourceVersion.objects.exists())

    def test_download_returns_private_source_bytes_without_original_filename_or_path(self):
        uploaded = self.upload()
        source_id = uploaded.json()["source"]["id"]
        response = self.client.get(f"/api/intake/sources/{source_id}/download")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(b"".join(response.streaming_content), self.workbook)
        self.assertIn(f"workbook-{source_id}.xlsx", response["Content-Disposition"])
        self.assertNotIn("synthetic.xlsx", response["Content-Disposition"])

    def test_preview_failure_marks_receipt_failed_and_same_key_replay_does_not_stay_pending(self):
        uploaded = self.upload()
        source_id = uploaded.json()["source"]["id"]
        body = "{}"
        with patch("workbench.intake.api.capture_snapshot", side_effect=RuntimeError("synthetic parser failure")) as capture:
            failed = self.client.post(
                f"/api/intake/sources/{source_id}/previews", data=body,
                content_type="application/json", HTTP_IDEMPOTENCY_KEY="preview-failure-001",
            )
            replay = self.client.post(
                f"/api/intake/sources/{source_id}/previews", data=body,
                content_type="application/json", HTTP_IDEMPOTENCY_KEY="preview-failure-001",
            )
        self.assertEqual(failed.status_code, 503)
        self.assertEqual(failed.json(), {"ok": False, "error_code": "unavailable"})
        self.assertEqual(replay.status_code, 503)
        self.assertEqual(replay.json(), {"ok": False, "error_code": "unavailable"})
        self.assertEqual(capture.call_count, 1)
        from workbench.models import IntakeOperationReceipt
        receipt = IntakeOperationReceipt.objects.get(idempotency_key="preview-failure-001")
        self.assertEqual(receipt.state, IntakeOperationReceipt.State.FAILED)
        self.assertEqual(receipt.error_code, "unavailable")

    def test_image_preview_uses_opaque_reference_and_serves_only_supported_media(self):
        content = synthetic_image_xlsx()
        uploaded = self.upload(content=content)
        source_id = uploaded.json()["source"]["id"]
        previewed = self.client.post(f"/api/intake/sources/{source_id}/previews", data="{}",
            content_type="application/json", HTTP_IDEMPOTENCY_KEY="preview-image-001")
        image_id = previewed.json()["preview"]["id"]
        from workbench.models import WorkbookImageReference
        reference = WorkbookImageReference.objects.get(snapshot_id=image_id, kind="drawing")
        response = self.client.get(f"/api/intake/images/{reference.pk}/preview")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response["Content-Type"], "image/png")
        self.assertTrue(response.content.startswith(b"\x89PNG\r\n\x1a\n"))
        self.assertEqual(self.client.get("/api/intake/images/not-a-path/preview").status_code, 404)

    def test_unknown_fields_and_stale_mapping_revision_fail_closed(self):
        uploaded = self.upload()
        source_id = uploaded.json()["source"]["id"]
        previewed = self.client.post(f"/api/intake/sources/{source_id}/previews", data="{}", content_type="application/json", HTTP_IDEMPOTENCY_KEY="preview-invalid-001")
        preview_id = previewed.json()["preview"]["id"]
        invalid = {
            "schema_version": 1,
            "candidate_type": "product_identity",
            "source_sha256": previewed.json()["preview"]["source_sha256"],
            "expected_revision": 0,
            "fields": {"not_a_business_field": {"cells": [{"sheet_index": 1, "coordinate": "A1"}]}},
        }
        rejected = self.client.post(
            f"/api/intake/previews/{preview_id}/mappings", data=json.dumps(invalid),
            content_type="application/json", HTTP_IDEMPOTENCY_KEY="mapping-invalid",
        )
        self.assertEqual(rejected.status_code, 422)
        stale_source = {**invalid, "fields": {"description": {"cells": [{"sheet_index": 1, "coordinate": "A1"}]}}}
        stale_source["source_sha256"] = "0" * 64
        stale_result = self.client.post(
            f"/api/intake/previews/{preview_id}/mappings", data=json.dumps(stale_source),
            content_type="application/json", HTTP_IDEMPOTENCY_KEY="mapping-stale-source",
        )
        self.assertEqual(stale_result.status_code, 409)

    @override_settings(TRADELOOM_DATA_ROOT=None, TRADELOOM_INTAKE_ROOT=None)
    def test_unconfigured_private_store_is_unavailable_without_reserving_upload(self):
        response = self.upload()
        self.assertEqual(response.status_code, 503)
        self.assertEqual(response.json()["error_code"], "private_store_unavailable")


class IntakeIdempotencyConcurrencyTests(TransactionTestCase):
    reset_sequences = True

    def setUp(self):
        self.temp = TemporaryDirectory()
        self.data_root = Path(self.temp.name) / "data"
        self.intake_root = self.data_root / "private" / "intake"
        self.intake_root.mkdir(parents=True)
        (self.intake_root / INTAKE_MARKER).write_text(INTAKE_MARKER_CONTENT, encoding="utf-8")
        self.settings = override_settings(TRADELOOM_DATA_ROOT=self.data_root, TRADELOOM_INTAKE_ROOT=self.intake_root)
        self.settings.enable()
        self.workbook = synthetic_xlsx()

    def tearDown(self):
        self.settings.disable()
        self.temp.cleanup()

    def test_concurrent_same_key_reserves_once_and_different_payload_conflicts(self):
        from unittest.mock import patch
        from workbench.intake.storage import store_source as real_store_source

        entered, release = Event(), Event()
        count = 0
        lock = Lock()

        def controlled_store(upload):
            nonlocal count
            with lock:
                count += 1
            entered.set()
            if not release.wait(5):
                raise AssertionError("bounded storage barrier timed out")
            return real_store_source(upload)

        result = {}
        def first_request():
            close_old_connections()
            try:
                result["first"] = Client().post("/api/intake/sources", {
                    "file": SimpleUploadedFile("synthetic.xlsx", self.workbook, "application/octet-stream")
                }, HTTP_IDEMPOTENCY_KEY="concurrent-upload-001")
            finally:
                close_old_connections()

        with patch("workbench.intake.api.store_source", side_effect=controlled_store):
            thread = Thread(target=first_request)
            thread.start()
            self.assertTrue(entered.wait(5), "first request did not reach the reserved state")
            replay = Client().post("/api/intake/sources", {
                "file": SimpleUploadedFile("synthetic.xlsx", self.workbook, "application/octet-stream")
            }, HTTP_IDEMPOTENCY_KEY="concurrent-upload-001")
            conflict = Client().post("/api/intake/sources", {
                "file": SimpleUploadedFile("synthetic.xlsx", b"different payload", "application/octet-stream")
            }, HTTP_IDEMPOTENCY_KEY="concurrent-upload-001")
            release.set()
            thread.join(5)
            self.assertFalse(thread.is_alive(), "bounded upload request did not finish")
        self.assertEqual(count, 1)
        self.assertEqual(replay.status_code, 202)
        self.assertEqual(conflict.status_code, 409)
        self.assertEqual(result["first"].status_code, 201)
        final_replay = Client().post("/api/intake/sources", {
            "file": SimpleUploadedFile("synthetic.xlsx", self.workbook, "application/octet-stream")
        }, HTTP_IDEMPOTENCY_KEY="concurrent-upload-001")
        self.assertEqual(final_replay.status_code, 200)
        self.assertEqual(final_replay.json()["source"]["id"], result["first"].json()["source"]["id"])

    def test_mutation_requires_csrf_cookie_and_matching_header(self):
        csrf_client = Client(enforce_csrf_checks=True)
        denied = csrf_client.post(
            "/api/intake/sources",
            {"file": SimpleUploadedFile("synthetic.xlsx", self.workbook)},
            HTTP_IDEMPOTENCY_KEY="csrf-upload",
        )
        self.assertEqual(denied.status_code, 403)
        csrf_client.get("/")
        token = csrf_client.cookies["csrftoken"].value
        allowed = csrf_client.post(
            "/api/intake/sources",
            {"file": SimpleUploadedFile("synthetic.xlsx", self.workbook)},
            HTTP_IDEMPOTENCY_KEY="csrf-upload", HTTP_X_CSRFTOKEN=token,
        )
        self.assertEqual(allowed.status_code, 201)
