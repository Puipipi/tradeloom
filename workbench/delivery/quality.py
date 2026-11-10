from __future__ import annotations

import csv
import hashlib
import io
import json
from pathlib import Path
from typing import Any

from .catalog import build_catalog_html, build_catalog_markdown
from .checklist import build_checklist_csv, build_checklist_json
from .storage import DELIVERY_FILES, image_mime_type


class DeliveryQualityError(ValueError):
    pass


def _expected_files(products: list[dict[str, Any]]) -> dict[str, bytes]:
    return {
        "catalog_html": build_catalog_html(products).encode("utf-8"),
        "catalog_markdown": build_catalog_markdown(products).encode("utf-8"),
        "sample_checklist_csv": build_checklist_csv(products).encode("utf-8"),
        "sample_checklist_json": build_checklist_json(products).encode("utf-8"),
    }


def check_delivery_files(products: list[dict[str, Any]], directory: Path) -> dict[str, Any]:
    if not products:
        raise DeliveryQualityError("Cannot quality-check an empty batch")
    product_ids = [row.get("product_id") for row in products]
    revision_ids = [row.get("revision_id") for row in products]
    if len(set(product_ids)) != len(product_ids) or len(set(revision_ids)) != len(revision_ids):
        raise DeliveryQualityError("Product or revision coverage contains duplicates")

    expected = _expected_files(products)
    hashes: dict[str, str] = {}
    checks: dict[str, dict[str, Any]] = {}
    for artifact_type, expected_bytes in expected.items():
        filename = DELIVERY_FILES[artifact_type]
        path = directory / filename
        try:
            actual = path.read_bytes()
        except OSError as exc:
            raise DeliveryQualityError(f"Delivery file could not be read: {filename}") from exc
        if actual != expected_bytes:
            raise DeliveryQualityError(f"Delivery file does not match its frozen sources: {filename}")
        hashes[filename] = hashlib.sha256(actual).hexdigest()
        checks[filename] = {"passed": True, "bytes": len(actual)}

    try:
        records = list(csv.DictReader(io.StringIO((directory / DELIVERY_FILES["sample_checklist_csv"]).read_text("utf-8"), newline="")))
        json_payload = json.loads((directory / DELIVERY_FILES["sample_checklist_json"]).read_text("utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError, csv.Error) as exc:
        raise DeliveryQualityError("Checklist output format is invalid") from exc
    if len(records) != len(products) or len(json_payload.get("products", [])) != len(products):
        raise DeliveryQualityError("Checklist does not cover the full batch")
    if [item.get("product_id") for item in records] != product_ids:
        raise DeliveryQualityError("CSV product coverage or ordering is invalid")
    if [item.get("product_id") for item in json_payload["products"]] != product_ids:
        raise DeliveryQualityError("JSON product coverage or ordering is invalid")

    for row in products:
        image = row.get("image")
        if not image:
            raise DeliveryQualityError("Product image source is missing")
        if hashlib.sha256(image["content"]).hexdigest() != image["sha256"]:
            raise DeliveryQualityError("Frozen TaskFile image hash does not match its bytes")
        try:
            mime_type = image_mime_type(image["filename"], image["content"])
        except ValueError as exc:
            raise DeliveryQualityError("TaskFile image failed format verification") from exc
        if mime_type != image["mime_type"]:
            raise DeliveryQualityError("TaskFile image MIME type changed")

    return {
        "schema_version": "delivery-quality.v1",
        "status": "passed",
        "product_count": len(products),
        "revision_ids": revision_ids,
        "checks": checks,
        "hashes": hashes,
    }


def write_quality_report(directory: Path, report: dict[str, Any]) -> bytes:
    report_bytes = (json.dumps(report, ensure_ascii=False, indent=2, sort_keys=True) + "\n").encode("utf-8")
    path = directory / DELIVERY_FILES["quality_report_json"]
    with path.open("xb") as handle:
        handle.write(report_bytes)
        handle.flush()
    if path.read_bytes() != report_bytes:
        raise DeliveryQualityError("Quality report read-back does not match the written report")
    return report_bytes


def read_quality_report(directory: Path) -> dict[str, Any]:
    path = directory / DELIVERY_FILES["quality_report_json"]
    try:
        report = json.loads(path.read_text("utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise DeliveryQualityError("Quality report is missing or invalid") from exc
    hashes = report.get("hashes") if isinstance(report, dict) else None
    if not isinstance(hashes, dict) or report.get("status") != "passed" or set(hashes) != {
        DELIVERY_FILES[name] for name in (
            "catalog_html",
            "catalog_markdown",
            "sample_checklist_csv",
            "sample_checklist_json",
        )
    }:
        raise DeliveryQualityError("Quality report does not certify the four delivery files")
    return report
