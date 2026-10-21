import base64
import csv
import hashlib
import io
import json
import unittest

from PIL import Image

from workbench.delivery.catalog import build_catalog_html, build_catalog_markdown
from workbench.delivery.checklist import build_checklist_csv, build_checklist_json


def product_row(**overrides):
    image_buffer = io.BytesIO()
    Image.new("RGB", (2, 2), color="red").save(image_buffer, format="PNG")
    image_bytes = image_buffer.getvalue()
    row = {
        "product_id": "product-1",
        "revision_id": "revision-1",
        "version": 3,
        "snapshot": {
            "sku": "SKU-1",
            "english_name": "Ribbon & Bow",
            "name": "原始名称 <试验>",
            "category": "装饰品",
            "material": "Cotton",
            "size": "10 cm",
            "color": "蓝色",
        },
        "image": {
            "task_file_id": "file-1",
            "filename": "SKU-1.png",
            "sha256": hashlib.sha256(image_bytes).hexdigest(),
            "mime_type": "image/png",
            "content": image_bytes,
        },
    }
    row.update(overrides)
    return row


class DeliveryGeneratorTests(unittest.TestCase):
    def test_catalog_embeds_actual_image_bytes_and_escapes_untrusted_text(self):
        row = product_row()
        html = build_catalog_html([row])
        encoded = base64.b64encode(row["image"]["content"]).decode("ascii")

        self.assertIn(f"data:image/png;base64,{encoded}", html)
        self.assertIn("Ribbon &amp; Bow", html)
        self.assertIn("原始名称 &lt;试验&gt;", html)
        self.assertNotIn("<试验>", html)
        self.assertNotIn("C:\\", html)
        self.assertIn("file-1", html)
        self.assertIn("revision-1", html)

    def test_markdown_contains_verifiable_image_source_and_source_ids(self):
        row = product_row()
        markdown = build_catalog_markdown([row])
        encoded = base64.b64encode(row["image"]["content"]).decode("ascii")

        self.assertIn(f"data:image/png;base64,{encoded}", markdown)
        self.assertIn("`file-1`", markdown)
        self.assertIn(r"revision\-1", markdown)
        self.assertIn(row["image"]["sha256"], markdown)
        self.assertIn("原始名称 &lt;试验&gt;", markdown)
        self.assertIn("`SKU-1.png`", markdown)

    def test_markdown_image_source_code_spans_preserve_dots_hyphens_and_backticks(self):
        row = product_row()
        row["image"]["task_file_id"] = "file-1.2"
        row["image"]["filename"] = "`SKU-1.name`part.png"
        markdown = build_catalog_markdown([row])

        self.assertIn("`file-1.2`", markdown)
        self.assertIn("`` `SKU-1.name`part.png ``", markdown)

    def test_checklist_csv_has_stable_english_fields_and_round_trips_values(self):
        row = product_row()
        content = build_checklist_csv([row])
        records = list(csv.DictReader(io.StringIO(content, newline="")))

        self.assertEqual(len(records), 1)
        self.assertEqual(records[0]["product_id"], "product-1")
        self.assertEqual(records[0]["revision_id"], "revision-1")
        self.assertEqual(records[0]["english_name"], "Ribbon & Bow")
        self.assertEqual(records[0]["name"], "原始名称 <试验>")
        self.assertEqual(records[0]["image_task_file_id"], "file-1")

    def test_checklist_json_uses_english_labels_and_does_not_invent_fields(self):
        payload = json.loads(build_checklist_json([product_row()]))
        self.assertEqual(payload["products"][0]["english_name"], "Ribbon & Bow")
        self.assertEqual(payload["products"][0]["name"], "原始名称 <试验>")
        self.assertEqual(payload["products"][0]["revision_id"], "revision-1")
        self.assertNotIn("price", payload["products"][0])
        self.assertNotIn("lead_time", payload["products"][0])

    def test_generator_rejects_missing_english_name_without_translation(self):
        row = product_row()
        row["snapshot"]["english_name"] = "  "
        from workbench.delivery.catalog import EnglishNameRequired

        with self.assertRaises(EnglishNameRequired):
            build_catalog_html([row])


if __name__ == "__main__":
    unittest.main()
