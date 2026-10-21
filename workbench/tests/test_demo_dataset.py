from __future__ import annotations

import csv
import json
from collections import Counter
from pathlib import Path

from django.conf import settings
from django.test import TestCase

from workbench.services import CSV_FIELDS, WorkbenchService


class DemoDatasetTests(TestCase):
    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls.samples_root = Path(settings.BASE_DIR) / "data" / "samples"
        cls.root = cls.samples_root / "phase1"
        cls.csv_path = cls.root / "products.csv"
        cls.images_dir = cls.root / "images"
        cls.manifest_path = cls.images_dir / "manifest.json"

    def read_rows(self) -> list[dict[str, str]]:
        with self.csv_path.open(encoding="utf-8-sig", newline="") as handle:
            return list(csv.DictReader(handle))

    def read_manifest(self) -> dict:
        return json.loads(self.manifest_path.read_text(encoding="utf-8"))

    def test_csv_has_ten_obvious_demo_rows_and_required_coverage(self):
        rows = self.read_rows()

        self.assertEqual(len(rows), 10)
        self.assertIn("data_mode", rows[0])
        self.assertEqual(
            {row["data_mode"] for row in rows},
            {"demo"},
        )
        self.assertTrue(all(row["name"].startswith("[演示]") for row in rows))
        self.assertTrue(all(row["sku"].startswith("P1-DEMO-") for row in rows))

        self.assertTrue(
            any(
                all(row[field].strip() for field in CSV_FIELDS)
                for row in rows
            )
        )
        self.assertTrue(any(not row["image_filename"] for row in rows))
        self.assertTrue(any(not row["material"] for row in rows))
        self.assertTrue(any(not row["size"] for row in rows))

        counts = Counter(row["sku"] for row in rows)
        duplicates = [sku for sku, count in counts.items() if count > 1]
        self.assertTrue(duplicates)
        for sku in duplicates:
            sizes = {row["size"] for row in rows if row["sku"] == sku}
            self.assertGreater(len(sizes), 1)

    def test_manifest_matches_files_and_detects_number_conflict(self):
        rows = self.read_rows()
        manifest = self.read_manifest()

        self.assertEqual(manifest["source"], "demo_fixture")
        self.assertTrue(manifest["demo"])
        images = manifest["images"]
        missing = manifest["missing_references"]
        self.assertTrue(images)
        self.assertTrue(missing)
        self.assertEqual(
            len({entry["filename"] for entry in images}),
            len(images),
        )

        for entry in images:
            self.assertTrue(entry["filename"])
            self.assertTrue(entry["declared_sku"])
            self.assertEqual(entry["source"], "demo_fixture")
            self.assertTrue(entry["demo"])
            self.assertTrue((self.images_dir / entry["filename"]).is_file())

        by_filename = {entry["filename"]: entry for entry in images}
        missing_skus = {entry["sku"] for entry in missing}
        for row in rows:
            if row["image_filename"]:
                self.assertIn(row["image_filename"], by_filename)
                self.assertTrue(
                    (self.images_dir / row["image_filename"]).is_file()
                )
            else:
                self.assertIn(row["sku"], missing_skus)

        conflicts = []
        for row in rows:
            entry = by_filename.get(row["image_filename"])
            if entry and entry["declared_sku"] != row["sku"]:
                conflicts.append((row["sku"], entry["declared_sku"]))
        self.assertTrue(conflicts)

    def test_legacy_csv_behavior_is_unchanged(self):
        service = WorkbenchService()
        legacy_rows = service.parse_csv(
            (self.samples_root / "products.csv").read_bytes()
        )
        new_rows = service.parse_csv(self.csv_path.read_bytes())

        self.assertEqual(len(legacy_rows), 2)
        self.assertEqual(len(new_rows), 10)
        self.assertEqual(set(legacy_rows[0]), set(CSV_FIELDS))
        self.assertEqual(set(new_rows[0]), set(CSV_FIELDS))
