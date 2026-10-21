import hashlib
import os
import tempfile
import unittest
from pathlib import Path

from django.test import override_settings

os.environ.setdefault("DJANGO_SETTINGS_MODULE", "config.settings")
import django

django.setup()

from workbench.delivery.catalog import build_catalog_html, build_catalog_markdown
from workbench.delivery.checklist import build_checklist_csv, build_checklist_json
from workbench.delivery.quality import (
    DeliveryQualityError,
    check_delivery_files,
    read_quality_report,
    write_quality_report,
)
from workbench.delivery.storage import DELIVERY_FILES, DeliveryStorageError, image_mime_type
from workbench.tests.test_generators import product_row


def write_four(directory: Path, products):
    payloads = {
        "catalog_html": build_catalog_html(products),
        "catalog_markdown": build_catalog_markdown(products),
        "sample_checklist_csv": build_checklist_csv(products),
        "sample_checklist_json": build_checklist_json(products),
    }
    for artifact_type, text in payloads.items():
        (directory / DELIVERY_FILES[artifact_type]).write_bytes(text.encode("utf-8"))


class DeliveryQualityTests(unittest.TestCase):
    def test_truncated_png_with_valid_signature_is_rejected(self):
        row = product_row()
        row["image"]["content"] = b"\x89PNG\r\n\x1a\ntruncated-png"
        row["image"]["sha256"] = hashlib.sha256(row["image"]["content"]).hexdigest()

        with self.assertRaises(DeliveryStorageError):
            image_mime_type(row["image"]["filename"], row["image"]["content"])

        with tempfile.TemporaryDirectory() as root:
            directory = Path(root)
            write_four(directory, [row])
            with self.assertRaises(DeliveryQualityError):
                check_delivery_files([row], directory)

    def test_quality_reads_files_and_writes_report_for_four_hashes(self):
        products = [product_row()]
        with tempfile.TemporaryDirectory() as root:
            directory = Path(root)
            write_four(directory, products)
            report = check_delivery_files(products, directory)
            report_bytes = write_quality_report(directory, report)
            saved = read_quality_report(directory)

        self.assertEqual(saved["status"], "passed")
        self.assertEqual(set(saved["hashes"]), set(DELIVERY_FILES.values()) - {"quality_report.json"})
        self.assertEqual(hashlib.sha256(report_bytes).hexdigest() != "", True)

    def test_any_corrupted_or_incomplete_delivery_file_fails_quality(self):
        products = [product_row()]
        mutations = {
            "catalog.html": lambda content: content.replace(b"product-1", b"", 1),
            "catalog.md": lambda content: content.replace(b"Product Catalog", b"Product Catalogue", 1),
            "sample_checklist.csv": lambda content: content.replace(b"SKU-1", b"", 1),
            "sample_checklist.json": lambda content: content.replace(b'"SKU-1"', b'"SKU-2"', 1),
        }
        for filename, mutate in mutations.items():
            with self.subTest(filename=filename), tempfile.TemporaryDirectory() as root:
                directory = Path(root)
                write_four(directory, products)
                path = directory / filename
                path.write_bytes(mutate(path.read_bytes()))
                with self.assertRaises(DeliveryQualityError):
                    check_delivery_files(products, directory)

    def test_tampered_image_bytes_do_not_match_frozen_taskfile_hash(self):
        row = product_row()
        row["image"]["content"] = b"changed image bytes"
        with tempfile.TemporaryDirectory() as root:
            directory = Path(root)
            write_four(directory, [row])
            with self.assertRaises(DeliveryQualityError):
                check_delivery_files([row], directory)

    def test_quality_report_does_not_claim_its_own_hash(self):
        products = [product_row()]
        with tempfile.TemporaryDirectory() as root:
            directory = Path(root)
            with override_settings(TRADELOOM_ARTIFACT_ROOT=directory):
                write_four(directory, products)
                report = check_delivery_files(products, directory)
                write_quality_report(directory, report)
                saved = read_quality_report(directory)

        self.assertNotIn("quality_report.json", saved["hashes"])

    def test_malformed_quality_report_is_reported_as_quality_failure(self):
        malformed_reports = ("[]", '{"status":"passed","hashes":null}', '{"status":"passed","hashes":"bad"}')
        for raw_report in malformed_reports:
            with self.subTest(raw_report=raw_report), tempfile.TemporaryDirectory() as root:
                directory = Path(root)
                (directory / DELIVERY_FILES["quality_report_json"]).write_text(raw_report, encoding="utf-8")
                with self.assertRaises(DeliveryQualityError):
                    read_quality_report(directory)


if __name__ == "__main__":
    unittest.main()
