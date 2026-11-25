from __future__ import annotations

import hashlib
import json
import re
from decimal import Decimal, InvalidOperation

from .schemas import MappingError, validate_mapping_shape

_COORDINATE = re.compile(r"[A-Z]{1,3}[1-9][0-9]{0,6}\Z")


def canonical_json(value: object) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False)


def fingerprint(value: object) -> str:
    return hashlib.sha256(canonical_json(value).encode("utf-8")).hexdigest()


def _cell_value(cell, expected_type: str, *, is_cell_image: bool = False) -> dict:
    raw = cell.raw_value if isinstance(cell.raw_value, dict) else {}
    if cell.error_code:
        return {"state": "formula_error", "type": expected_type, "value": None}
    if raw.get("formula_present"):
        cache = cell.cached_value if isinstance(cell.cached_value, dict) else {"state": "missing"}
        cache_state = cache.get("state")
        if cache_state == "missing":
            return {"state": "formula_cache_missing", "type": expected_type, "value": None}
        if cache_state == "empty":
            return {"state": "formula_cache_empty", "type": expected_type, "value": None}
        value = cache.get("value")
    else:
        value = cell.normalized_value
        if value is None and raw.get("v_lexeme") is None and raw.get("inline_string") is None and raw.get("shared_string") is None:
            return {"state": "empty", "type": expected_type, "value": None}

    if is_cell_image and not raw.get("formula_present"):
        return {"state": "type_mismatch", "type": expected_type, "value": None}

    if expected_type == "text":
        if isinstance(value, str):
            return {"state": "present", "type": "text", "value": value}
        # 真实打表常把编号录成数字单元格：按存储词素原样转十进制文本，不做语义猜测。
        if isinstance(value, (int, float)) and not isinstance(value, bool) and raw.get("xml_type", "") in {"", "n"}:
            lexeme = raw.get("v_lexeme")
            if raw.get("formula_present") and isinstance(cell.cached_value, dict):
                lexeme = cell.cached_value.get("lexeme")
            if not isinstance(lexeme, str) and isinstance(value, int):
                lexeme = str(value)
            if isinstance(lexeme, str):
                try:
                    number = Decimal(lexeme)
                except InvalidOperation:
                    number = None
                if number is not None and number.is_finite():
                    return {"state": "present", "type": "text", "value": format(number, "f")}
        return {"state": "type_mismatch", "type": "text", "value": value}
    if expected_type == "date":
        if isinstance(value, dict) and value.get("type") in {"date", "datetime"} and isinstance(value.get("iso"), str):
            return {"state": "present", "type": "date", "value": value["iso"]}
        return {"state": "type_mismatch", "type": "date", "value": value}
    if expected_type == "decimal":
        numeric_source = raw.get("xml_type", "") in {"", "n"}
        lexeme = raw.get("v_lexeme") if numeric_source else None
        if raw.get("formula_present") and isinstance(cell.cached_value, dict):
            lexeme = cell.cached_value.get("lexeme") if numeric_source else None
        if lexeme is None and numeric_source and isinstance(value, (int, float)) and not isinstance(value, bool):
            lexeme = str(value)
        if isinstance(lexeme, str):
            try:
                decimal_value = Decimal(lexeme)
                if decimal_value.is_finite():
                    return {"state": "present", "type": "decimal", "value": format(decimal_value, "f")}
            except InvalidOperation:
                pass
        return {"state": "type_mismatch", "type": "decimal", "value": value}
    raise MappingError("unsupported_value_type")


def build_mapping(snapshot, payload: object) -> tuple[dict, dict]:
    candidate_type, schema = validate_mapping_shape(payload)
    if snapshot.status != "ready":
        raise MappingError("snapshot_not_ready")
    if payload["source_sha256"] != snapshot.source.sha256:
        raise MappingError("stale_mapping")
    mapped = {}
    provenance = {}
    sheets = {sheet.sheet_index: sheet for sheet in snapshot.sheets.all()}
    cell_image_coordinates = {
        sheet.pk: set(snapshot.image_references.filter(sheet=sheet, kind="rich_data").values_list("coordinate", flat=True))
        for sheet in sheets.values()
    }
    for field_name, field_mapping in payload["fields"].items():
        value_type = schema[field_name]
        values = []
        sources = []
        for requested in field_mapping["cells"]:
            coordinate = requested["coordinate"].upper()
            if not _COORDINATE.fullmatch(coordinate):
                raise MappingError("invalid_source_cell")
            sheet = sheets.get(requested["sheet_index"])
            if sheet is None:
                raise MappingError("source_cell_not_found")
            cell = sheet.cells.filter(coordinate=coordinate).first()
            if cell is None:
                raise MappingError("source_cell_not_found")
            values.append(_cell_value(
                cell,
                value_type,
                is_cell_image=coordinate in cell_image_coordinates.get(sheet.pk, set()),
            ))
            sources.append({
                "source_id": snapshot.source_id,
                "source_sha256": snapshot.source.sha256,
                "snapshot_id": snapshot.pk,
                "sheet_index": sheet.sheet_index,
                "sheet_title": sheet.title,
                "coordinate": coordinate,
                "formula_status": cell.formula_status,
                "error_code": cell.error_code,
            })
        mapped[field_name] = values
        provenance[field_name] = sources
    return {
        "schema_version": payload["schema_version"],
        "candidate_type": candidate_type,
        "semantics": {
            "commercial_role": "unknown" if candidate_type == "commercial_source" else None,
            "price_nature": "unknown" if candidate_type == "commercial_source" else None,
            "historical_or_reference": "unconfirmed" if candidate_type == "production_instruction" else None,
            "labor_basis": "unconfirmed" if candidate_type == "labor_analysis" else None,
            "product_identity": "candidate_only" if candidate_type == "product_identity" else None,
        },
        "fields": mapped,
    }, provenance
