from __future__ import annotations

import re
from datetime import date
from decimal import Decimal, InvalidOperation

from workbench.intake.schemas import FIELD_SCHEMAS, MappingError


REQUIREMENT_SCHEMA_VERSION = 1
REQUIREMENT_FIELDS = {
    **FIELD_SCHEMAS["production_instruction"],
    "customer_ref": "customer_ref",
    "item_ref": "item_ref",
}

# 多产品订单的这些字段只存在于行级（每行一个产品），表头层无法诚实取值；
# 确认门禁对它们豁免（delegated_to_lines），其余字段仍须全部落定才能确认。
# 见 docs/05-业务闭环补齐方案.md「真实数据回归发现④」。
LINE_DELEGATED_FIELDS = frozenset({
    "description", "specification", "color", "unit",
    "packing", "pack_quantity", "pack_unit", "barcode_requirement",
})
_DECIMAL = re.compile(r"(?:0|[1-9][0-9]{0,11})(?:\.[0-9]{1,8})?\Z")
_MAX_TEXT = {
    "source_order_reference": 140,
    "description": 500,
    "specification": 1000,
    "color": 255,
    "unit": 64,
    "packing": 1000,
    "barcode_requirement": 1000,
    "requirement_text": 4000,
    "pack_unit": 64,
}


def _typed_reference(value: object, doctype: str) -> bool:
    if value is None:
        return True
    if not isinstance(value, dict) or set(value) != {"doctype", "name"}:
        return False
    name = value.get("name")
    return value.get("doctype") == doctype and isinstance(name, str) and 1 <= len(name) <= 140 and not any(
        ord(char) < 32 or ord(char) == 127 for char in name
    )


def validate_requirement_fields(value: object, *, allow_partial: bool) -> dict:
    if not isinstance(value, dict) or set(value) - set(REQUIREMENT_FIELDS):
        raise MappingError("invalid_requirement_fields")
    if not allow_partial and set(value) != set(REQUIREMENT_FIELDS):
        raise MappingError("invalid_requirement_fields")
    validated = {}
    for field, item in value.items():
        field_type = REQUIREMENT_FIELDS[field]
        if item is None:
            validated[field] = None
            continue
        if field_type == "text":
            if (not isinstance(item, str) or len(item) > _MAX_TEXT.get(field, 1000) or
                    any(ord(char) < 32 and char not in "\t\n\r" for char in item) or "\x7f" in item):
                raise MappingError("invalid_requirement_fields")
            validated[field] = item
        elif field_type == "decimal":
            if not isinstance(item, str) or not _DECIMAL.fullmatch(item):
                raise MappingError("invalid_requirement_fields")
            try:
                number = Decimal(item)
            except InvalidOperation:
                raise MappingError("invalid_requirement_fields") from None
            if not number.is_finite():
                raise MappingError("invalid_requirement_fields")
            validated[field] = format(number, "f")
        elif field_type == "date":
            if not isinstance(item, str) or len(item) != 10:
                raise MappingError("invalid_requirement_fields")
            try:
                parsed = date.fromisoformat(item)
            except ValueError:
                raise MappingError("invalid_requirement_fields") from None
            if parsed.isoformat() != item:
                raise MappingError("invalid_requirement_fields")
            validated[field] = item
        elif field_type == "customer_ref":
            if not _typed_reference(item, "Customer"):
                raise MappingError("invalid_requirement_fields")
            validated[field] = item
        elif field_type == "item_ref":
            if not _typed_reference(item, "Item"):
                raise MappingError("invalid_requirement_fields")
            validated[field] = item
        else:
            raise MappingError("invalid_requirement_fields")
    return validated
