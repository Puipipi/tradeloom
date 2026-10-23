"""Closed typed schemas for source-derived intake candidates."""

from __future__ import annotations

import re


SCHEMA_VERSION = 1
_SHA256 = re.compile(r"[a-f0-9]{64}\Z")

# Field names and value types are deliberately finite. Business semantics that
# have not been confirmed remain unknown in the candidate envelope.
FIELD_SCHEMAS = {
    "product_identity": {
        "style_number": "text", "description": "text", "customer_item_code": "text",
        "width": "decimal", "width_unit": "text", "color": "text",
        "roll_length": "decimal", "roll_length_unit": "text", "packing": "text", "barcode": "text",
    },
    "commercial_source": {
        "document_reference": "text", "party_text": "text", "item_description": "text",
        "quantity": "decimal", "unit": "text", "unit_price": "decimal", "amount": "decimal",
        "currency": "text", "notes": "text",
    },
    "production_instruction": {
        "source_order_reference": "text", "description": "text", "specification": "text",
        "color": "text", "quantity": "decimal", "unit": "text", "packing": "text",
        "carton_count": "decimal", "barcode_requirement": "text", "due_date": "date",
        "requirement_text": "text", "pack_quantity": "decimal", "pack_unit": "text",
    },
    "labor_analysis": {
        "process": "text", "observed_seconds": "decimal", "observed_quantity": "decimal",
        "observed_unit": "text", "estimated_hourly_rate": "decimal", "estimated_efficiency": "decimal",
        "estimated_capacity": "decimal", "estimated_piece_rate": "decimal", "notes": "text",
    },
}


class MappingError(ValueError):
    def __init__(self, code: str):
        self.code = code
        super().__init__(code)


def validate_mapping_shape(payload: object) -> tuple[str, dict]:
    if not isinstance(payload, dict) or set(payload) != {"schema_version", "candidate_type", "source_sha256", "expected_revision", "fields"}:
        raise MappingError("invalid_mapping")
    if type(payload["schema_version"]) is not int or payload["schema_version"] != SCHEMA_VERSION:
        raise MappingError("unsupported_schema")
    candidate_type = payload["candidate_type"]
    if not isinstance(candidate_type, str):
        raise MappingError("unsupported_candidate_type")
    schema = FIELD_SCHEMAS.get(candidate_type)
    if schema is None:
        raise MappingError("unsupported_candidate_type")
    expected = payload["expected_revision"]
    if type(expected) is not int or expected < 0:
        raise MappingError("invalid_revision")
    if not isinstance(payload["source_sha256"], str) or not _SHA256.fullmatch(payload["source_sha256"]):
        raise MappingError("invalid_source_hash")
    fields = payload["fields"]
    if not isinstance(fields, dict) or set(fields) - set(schema):
        raise MappingError("unknown_field")
    if not fields:
        raise MappingError("empty_mapping")
    total = 0
    for name, mapping in fields.items():
        if not isinstance(mapping, dict) or set(mapping) != {"cells"}:
            raise MappingError("invalid_field_mapping")
        cells = mapping["cells"]
        if not isinstance(cells, list) or not cells or len(cells) > 10:
            raise MappingError("invalid_source_cells")
        total += len(cells)
        for cell in cells:
            if not isinstance(cell, dict) or set(cell) != {"sheet_index", "coordinate"}:
                raise MappingError("invalid_source_cell")
            if type(cell["sheet_index"]) is not int or cell["sheet_index"] < 1:
                raise MappingError("invalid_source_cell")
            if not isinstance(cell["coordinate"], str) or len(cell["coordinate"]) > 16:
                raise MappingError("invalid_source_cell")
    if total > 100:
        raise MappingError("too_many_source_cells")
    return candidate_type, schema
