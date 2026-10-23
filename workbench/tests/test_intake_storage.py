from __future__ import annotations

from io import BytesIO
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import patch
import zipfile
from xml.etree import ElementTree as ET

from django.core.exceptions import ValidationError
from django.core.files.uploadedfile import SimpleUploadedFile
from django.db import IntegrityError
from django.test import TestCase, override_settings
from openpyxl import Workbook
from openpyxl.drawing.image import Image as WorksheetImage
from PIL import Image

from workbench.intake.storage import (cleanup_unreferenced_source, store_source, open_source,
                                      INTAKE_MARKER, INTAKE_MARKER_CONTENT)
from workbench.intake.snapshots import capture_snapshot
from workbench.models import IntakeSourceVersion, WorkbookImageReference, WorkbookSheetSnapshot, WorkbookSnapshot

SHEET_NS = "http://schemas.openxmlformats.org/spreadsheetml/2006/main"


def synthetic_xlsx() -> bytes:
    book = Workbook()
    sheet = book.active
    sheet["A1"] = "synthetic"
    output = BytesIO()
    book.save(output)
    book.close()
    return output.getvalue()


def add_package_part(data: bytes, name: str, body: bytes) -> bytes:
    output = BytesIO()
    with zipfile.ZipFile(BytesIO(data)) as source, zipfile.ZipFile(output, "w", zipfile.ZIP_DEFLATED) as target:
        for entry in source.infolist():
            target.writestr(entry.filename, source.read(entry.filename))
        target.writestr(name, body)
    return output.getvalue()


def shared_formula_workbook() -> bytes:
    book = Workbook()
    sheet = book.active
    sheet["A1"] = "synthetic"
    sheet["C1"] = "=1+2"
    sheet["D1"] = "=1+2"
    output = BytesIO()
    book.save(output)
    book.close()
    transformed = BytesIO()
    with zipfile.ZipFile(BytesIO(output.getvalue())) as source, zipfile.ZipFile(transformed, "w", zipfile.ZIP_DEFLATED) as target:
        for entry in source.infolist():
            data = source.read(entry.filename)
            if entry.filename == "xl/worksheets/sheet1.xml":
                root = ET.fromstring(data)
                master = root.find(f".//{{{SHEET_NS}}}c[@r='C1']/{{{SHEET_NS}}}f")
                follower = root.find(f".//{{{SHEET_NS}}}c[@r='D1']/{{{SHEET_NS}}}f")
                master.attrib.update({"t": "shared", "si": "0", "ref": "C1:D1"})
                follower.attrib.update({"t": "shared", "si": "0"})
                follower.text = None
                data = ET.tostring(root, encoding="utf-8", xml_declaration=True)
            target.writestr(entry.filename, data)
    return transformed.getvalue()


def invalid_coordinate_workbook() -> bytes:
    data = synthetic_xlsx()
    output = BytesIO()
    with zipfile.ZipFile(BytesIO(data)) as source, zipfile.ZipFile(output, "w", zipfile.ZIP_DEFLATED) as target:
        for entry in source.infolist():
            body = source.read(entry.filename)
            if entry.filename == "xl/worksheets/sheet1.xml":
                root = ET.fromstring(body)
                root.find(f".//{{{SHEET_NS}}}c").set("r", "A0")
                body = ET.tostring(root, encoding="utf-8", xml_declaration=True)
            target.writestr(entry.filename, body)
    return output.getvalue()


def invalid_anchor_workbook() -> bytes:
    image_bytes = BytesIO()
    image = Image.new("RGB", (2, 2), (20, 40, 60))
    image.save(image_bytes, format="PNG")
    image.close()
    book = Workbook()
    sheet = book.active
    sheet["A1"] = "synthetic"
    sheet.add_image(WorksheetImage(BytesIO(image_bytes.getvalue())), "B2")
    workbook_bytes = BytesIO()
    book.save(workbook_bytes)
    book.close()

    output = BytesIO()
    with zipfile.ZipFile(BytesIO(workbook_bytes.getvalue())) as source, zipfile.ZipFile(output, "w", zipfile.ZIP_DEFLATED) as target:
        for entry in source.infolist():
            body = source.read(entry.filename)
            if entry.filename == "xl/drawings/drawing1.xml":
                root = ET.fromstring(body)
                root.find(f".//{{http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing}}from/{{http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing}}row").text = "not-an-int"
                body = ET.tostring(root, encoding="utf-8", xml_declaration=True)
            target.writestr(entry.filename, body)
    return output.getvalue()


class IntakeSourceModelContractTests(TestCase):
    def test_source_version_is_registered_with_immutable_identity_fields(self):
        model = IntakeSourceVersion
        field_names = {field.name for field in model._meta.get_fields()}
        self.assertTrue({"id", "sha256", "storage_key", "original_name", "byte_size", "mime_type", "received_at"} <= field_names)
        self.assertTrue(model._meta.get_field("sha256").unique)


class IntakeStorageTests(TestCase):
    def setUp(self):
        self.temp = TemporaryDirectory()
        data_root = Path(self.temp.name) / "data"
        intake_root = data_root / "private" / "intake"
        intake_root.mkdir(parents=True)
        (intake_root / INTAKE_MARKER).write_text(INTAKE_MARKER_CONTENT, encoding="utf-8")
        self.settings = override_settings(TRADELOOM_DATA_ROOT=data_root, TRADELOOM_INTAKE_ROOT=intake_root)
        self.settings.enable()
        self.data = synthetic_xlsx()

    def tearDown(self):
        self.settings.disable()
        self.temp.cleanup()

    def upload(self, name="synthetic.xlsx", content_type="application/octet-stream", data=None):
        return SimpleUploadedFile(name, data if data is not None else self.data, content_type=content_type)

    def test_generic_mime_valid_xlsx_is_private_immutable_and_idempotent(self):
        source, created = store_source(self.upload())
        self.assertTrue(created)
        self.assertEqual(source.byte_size, len(self.data))
        self.assertEqual(source.mime_type, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")
        with open_source(source.pk) as stored:
            self.assertEqual(stored.read(), self.data)
        duplicate, duplicate_created = store_source(self.upload())
        self.assertFalse(duplicate_created)
        self.assertEqual(duplicate.pk, source.pk)
        with self.assertRaises(ValidationError):
            IntakeSourceVersion.objects.filter(pk=source.pk).update(original_name="changed.xlsx")
        with self.assertRaises(ValidationError):
            source.delete()

    def test_open_source_detects_modified_archived_bytes(self):
        source, _ = store_source(self.upload())
        with override_settings(TRADELOOM_DATA_ROOT=Path(self.temp.name) / "data"):
            path = Path(self.temp.name) / "data" / "private" / "intake" / "objects" / source.storage_key
            path.write_bytes(b"tampered")
            with self.assertRaises(ValidationError):
                open_source(source.pk)

    def test_database_failure_after_move_removes_only_unreferenced_object(self):
        with patch("workbench.intake.storage.IntakeSourceVersion.objects.create", side_effect=RuntimeError("synthetic database failure")):
            with self.assertRaises(RuntimeError):
                store_source(self.upload())
        intake_root = Path(self.temp.name) / "data" / "private" / "intake"
        self.assertEqual(list((intake_root / "objects").rglob("*.xlsx")), [])

    def test_cleanup_does_not_remove_an_object_referenced_by_an_existing_source(self):
        source, created = store_source(self.upload())
        self.assertTrue(created)
        path = Path(self.temp.name) / "data" / "private" / "intake" / "objects" / source.storage_key
        original = path.read_bytes()

        self.assertFalse(cleanup_unreferenced_source(source.storage_key))
        self.assertTrue(path.is_file())
        self.assertEqual(path.read_bytes(), original)
        self.assertFalse(cleanup_unreferenced_source("../outside.xlsx"))

    def test_image_reference_must_match_its_sheet_snapshot(self):
        source, _ = store_source(self.upload())
        first = WorkbookSnapshot.objects.create(source=source, parser_version="test-a", status="ready")
        second = WorkbookSnapshot.objects.create(source=source, parser_version="test-b", status="ready")
        sheet = WorkbookSheetSnapshot.objects.create(snapshot=first, sheet_index=1, title="synthetic", source_part="xl/worksheets/sheet1.xml")
        same_snapshot = WorkbookImageReference(snapshot=first, sheet=sheet, kind="drawing", source_part="xl/drawings/drawing1.xml")
        same_snapshot.save()
        wrong_snapshot = WorkbookImageReference(snapshot=second, sheet=sheet, kind="drawing", source_part="xl/drawings/drawing1.xml")
        with self.assertRaises(ValidationError):
            wrong_snapshot.save()

    def test_rejects_non_xlsx_extension_bad_zip_and_size_limit(self):
        with self.assertRaises(ValidationError):
            store_source(self.upload(name="synthetic.xlsm"))
        with self.assertRaises(ValidationError):
            store_source(self.upload(data=b"not a zip"))
        with patch("workbench.intake.storage.MAX_SOURCE_BYTES", 10):
            with self.assertRaises(ValidationError):
                store_source(self.upload())
        with patch("workbench.intake.storage.MAX_ZIP_PARTS", 2):
            with self.assertRaises(ValidationError):
                store_source(self.upload())
        with patch("workbench.intake.storage.MAX_UNCOMPRESSED_BYTES", 10):
            with self.assertRaises(ValidationError):
                store_source(self.upload())
        with self.assertRaises(ValidationError):
            store_source(self.upload(data=add_package_part(self.data, "xl/externalLinks/externalLink1.xml", b"<externalLink/>")))
        with self.assertRaises(ValidationError):
            store_source(self.upload(data=add_package_part(self.data, "xl/vbaProject.bin", b"synthetic macro")))

    def test_unconfigured_private_root_fails_closed(self):
        with override_settings(TRADELOOM_INTAKE_ROOT=None, TRADELOOM_DATA_ROOT=None):
            with self.assertRaises(ValidationError):
                store_source(self.upload())

    def test_private_root_cannot_overlap_public_media_root(self):
        data_root = Path(self.temp.name) / "data"
        with override_settings(MEDIA_ROOT=data_root):
            with self.assertRaises(ValidationError):
                store_source(self.upload())

    def test_snapshot_persists_typed_cell_evidence_once_without_changing_source(self):
        source, _ = store_source(self.upload())
        snapshot, created = capture_snapshot(source)
        self.assertTrue(created)
        self.assertEqual(snapshot.status, "ready")
        cell = snapshot.sheets.get(sheet_index=1).cells.get(coordinate="A1")
        self.assertEqual(cell.normalized_value, "synthetic")
        self.assertIn(cell.raw_value["inline_string"] or cell.raw_value["shared_string"], {"synthetic"})
        replay, replay_created = capture_snapshot(source)
        self.assertFalse(replay_created)
        self.assertEqual(replay.pk, snapshot.pk)
        with open_source(source.pk) as stored:
            self.assertEqual(stored.read(), self.data)

    def test_shared_formula_follower_persists_as_ready_snapshot_with_original_bytes_intact(self):
        data = shared_formula_workbook()
        source, created = store_source(self.upload(data=data))
        self.assertTrue(created)
        snapshot, snapshot_created = capture_snapshot(source)
        self.assertTrue(snapshot_created)
        self.assertEqual(snapshot.status, "ready")
        cells = {cell.coordinate: cell for cell in snapshot.sheets.get(sheet_index=1).cells.all()}
        self.assertIn("C1", cells)
        self.assertIn("D1", cells)
        master = cells["C1"]
        follower = cells["D1"]
        self.assertEqual(master.formula, "1+2")
        self.assertEqual(follower.formula, "")
        self.assertTrue(follower.raw_value["formula_present"])
        self.assertEqual(follower.raw_value["formula_attrs"], {"t": "shared", "si": "0"})
        with open_source(source.pk) as stored:
            self.assertEqual(stored.read(), data)

    def test_invalid_cell_coordinate_creates_safe_failed_snapshot_and_preserves_source(self):
        data = invalid_coordinate_workbook()
        source, _ = store_source(self.upload(data=data))
        snapshot, created = capture_snapshot(source)
        self.assertTrue(created)
        self.assertEqual(snapshot.status, "failed")
        self.assertEqual(snapshot.error_code, "workbook_parse_failed")
        with open_source(source.pk) as stored:
            self.assertEqual(stored.read(), data)

    def test_invalid_drawing_anchor_creates_safe_failed_snapshot_and_preserves_source(self):
        data = invalid_anchor_workbook()
        source, _ = store_source(self.upload(data=data))
        snapshot, created = capture_snapshot(source)
        self.assertTrue(created)
        self.assertEqual(snapshot.status, "failed")
        self.assertEqual(snapshot.error_code, "workbook_parse_failed")
        with open_source(source.pk) as stored:
            self.assertEqual(stored.read(), data)

    def test_snapshot_integrity_error_without_matching_snapshot_is_not_reported_as_replay(self):
        source, _ = store_source(self.upload())
        with patch("workbench.intake.snapshots.WorkbookSnapshot.objects.create", side_effect=IntegrityError("synthetic unrelated constraint")):
            with self.assertRaises(IntegrityError):
                capture_snapshot(source)
