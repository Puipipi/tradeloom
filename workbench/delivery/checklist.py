from __future__ import annotations

import csv
import io
import json
from typing import Any


CHECKLIST_FIELDS = (
    "product_id",
    "revision_id",
    "revision_version",
    "sku",
    "english_name",
    "name",
    "category",
    "material",
    "size",
    "color",
    "image_task_file_id",
    "image_filename",
    "image_sha256",
)


def checklist_row(row: dict[str, Any]) -> dict[str, Any]:
    snapshot = row["snapshot"]
    image = row.get("image") or {}
    return {
        "product_id": row["product_id"],
        "revision_id": row["revision_id"],
        "revision_version": row["version"],
        "sku": snapshot.get("sku", ""),
        "english_name": snapshot.get("english_name", ""),
        "name": snapshot.get("name", ""),
        "category": snapshot.get("category", ""),
        "material": snapshot.get("material", ""),
        "size": snapshot.get("size", ""),
        "color": snapshot.get("color", ""),
        "image_task_file_id": image.get("task_file_id", ""),
        "image_filename": image.get("filename", ""),
        "image_sha256": image.get("sha256", ""),
    }


def build_checklist_csv(products: list[dict[str, Any]]) -> str:
    output = io.StringIO(newline="")
    writer = csv.DictWriter(output, fieldnames=CHECKLIST_FIELDS, lineterminator="\n")
    writer.writeheader()
    for product in products:
        writer.writerow(checklist_row(product))
    return output.getvalue()


def build_checklist_json(products: list[dict[str, Any]]) -> str:
    payload = {
        "schema_version": "sample-checklist.v1",
        "products": [checklist_row(product) for product in products],
    }
    return json.dumps(payload, ensure_ascii=False, indent=2, sort_keys=True) + "\n"
