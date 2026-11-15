from __future__ import annotations

import re
from datetime import date

from workbench.intake.mapping import MappingError
from workbench.requirements.schemas import REQUIREMENT_FIELDS


MAX_REQUIREMENT_REFS = 100
MAX_MATERIALS = 200
MAX_OPERATIONS = 100
MAX_ITEM_REFS = 20
MAX_SOURCE_INPUTS = 10
MAX_SOURCE_VALUE_CHARS = 2_000
MAX_REQUEST_BYTES = 256 * 1024
_DECIMAL = re.compile(r"(?:0|[1-9][0-9]{0,11})(?:\.[0-9]{1,8})?\Z")
_TEXT_CONTROL = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]")


def _text(value: object, limit: int) -> bool:
    return isinstance(value, str) and len(value) <= limit and not _TEXT_CONTROL.search(value)


def _evidence_ids(value: object, *, allow_empty: bool = False) -> list[str]:
    if (not isinstance(value, list) or len(value) > MAX_ITEM_REFS or
            (not allow_empty and not value) or
            any(not isinstance(item, str) or not re.fullmatch(r"[a-f0-9]{32}", item) for item in value) or
            len(set(value)) != len(value)):
        raise MappingError("invalid_execution_plan")
    return value


def validate_requirement_refs(value: object, *, allow_empty: bool = False) -> list[dict]:
    if (not isinstance(value, list) or len(value) > MAX_REQUIREMENT_REFS or
            (not allow_empty and not value)):
        raise MappingError("invalid_execution_plan")
    result = []
    seen_fields = set()
    for item in value:
        if not isinstance(item, dict) or set(item) != {"field_key", "evidence_ids"}:
            raise MappingError("invalid_execution_plan")
        field_key = item["field_key"]
        if not isinstance(field_key, str) or field_key not in REQUIREMENT_FIELDS or field_key in seen_fields:
            raise MappingError("invalid_execution_plan")
        seen_fields.add(field_key)
        result.append({"field_key": field_key, "evidence_ids": _evidence_ids(item["evidence_ids"])})
    return result


def _supporting_inputs(value: object) -> list[dict]:
    if not isinstance(value, list) or len(value) > MAX_ITEM_REFS:
        raise MappingError("invalid_execution_plan")
    return validate_requirement_refs(value, allow_empty=True)


def _supporting_source_inputs(value: object) -> list[dict]:
    if not isinstance(value, list) or len(value) > MAX_SOURCE_INPUTS:
        raise MappingError("invalid_execution_plan")
    result = []
    seen = set()
    for item in value:
        if not isinstance(item, dict) or set(item) != {"candidate_id", "field_key", "evidence_ids"}:
            raise MappingError("invalid_execution_plan")
        candidate_id, field_key = item["candidate_id"], item["field_key"]
        if (not isinstance(candidate_id, str) or not re.fullmatch(r"[a-f0-9]{32}", candidate_id) or
                not isinstance(field_key, str) or not re.fullmatch(r"[a-z][a-z0-9_]{0,63}", field_key) or
                (candidate_id, field_key) in seen):
            raise MappingError("invalid_execution_plan")
        seen.add((candidate_id, field_key))
        result.append({"candidate_id": candidate_id, "field_key": field_key,
                       "evidence_ids": _evidence_ids(item["evidence_ids"])})
    return result


def _proposal_text(value: object, limit: int) -> str | None:
    if value is not None and not _text(value, limit):
        raise MappingError("invalid_execution_plan")
    return value


def validate_materials(value: object) -> list[dict]:
    if not isinstance(value, list) or len(value) > MAX_MATERIALS:
        raise MappingError("invalid_execution_plan")
    result = []
    for item in value:
        if (not isinstance(item, dict) or set(item) - {"item_ref", "resolution", "proposal", "supporting_requirement_inputs", "supporting_source_inputs"} or
                not {"item_ref", "resolution", "proposal", "supporting_requirement_inputs"}.issubset(item)):
            raise MappingError("invalid_execution_plan")
        if item["item_ref"] is not None or item["resolution"] != "unresolved":
            raise MappingError("invalid_execution_plan")
        proposal = item["proposal"]
        keys = {"description", "quantity", "unit", "expected_date"}
        if not isinstance(proposal, dict) or set(proposal) != keys:
            raise MappingError("invalid_execution_plan")
        description = _proposal_text(proposal["description"], 500)
        quantity = proposal["quantity"]
        if quantity is not None and (not isinstance(quantity, str) or not _DECIMAL.fullmatch(quantity)):
            raise MappingError("invalid_execution_plan")
        unit = _proposal_text(proposal["unit"], 64)
        expected_date = proposal["expected_date"]
        if expected_date is not None:
            if not isinstance(expected_date, str) or len(expected_date) != 10:
                raise MappingError("invalid_execution_plan")
            try:
                parsed = date.fromisoformat(expected_date)
            except ValueError:
                raise MappingError("invalid_execution_plan") from None
            if parsed.isoformat() != expected_date:
                raise MappingError("invalid_execution_plan")
        normalized = {
            "item_ref": None, "resolution": "unresolved",
            "proposal": {"description": description, "quantity": quantity,
                         "unit": unit, "expected_date": expected_date},
            "supporting_requirement_inputs": _supporting_inputs(item["supporting_requirement_inputs"]),
        }
        source_inputs = _supporting_source_inputs(item.get("supporting_source_inputs", []))
        if source_inputs:
            normalized["supporting_source_inputs"] = source_inputs
        result.append(normalized)
    return result


def validate_operations(value: object) -> list[dict]:
    if not isinstance(value, list) or len(value) > MAX_OPERATIONS:
        raise MappingError("invalid_execution_plan")
    result = []
    for item in value:
        if (not isinstance(item, dict) or set(item) - {"operation_ref", "resolution", "proposal", "supporting_requirement_inputs", "supporting_source_inputs"} or
                not {"operation_ref", "resolution", "proposal", "supporting_requirement_inputs"}.issubset(item)):
            raise MappingError("invalid_execution_plan")
        if item["operation_ref"] is not None or item["resolution"] != "unresolved":
            raise MappingError("invalid_execution_plan")
        proposal = item["proposal"]
        if not isinstance(proposal, dict) or set(proposal) != {"description", "sequence"}:
            raise MappingError("invalid_execution_plan")
        description = _proposal_text(proposal["description"], 500)
        sequence = proposal["sequence"]
        if sequence is not None and (type(sequence) is not int or sequence < 1):
            raise MappingError("invalid_execution_plan")
        normalized = {
            "operation_ref": None, "resolution": "unresolved",
            "proposal": {"description": description, "sequence": sequence},
            "supporting_requirement_inputs": _supporting_inputs(item["supporting_requirement_inputs"]),
        }
        source_inputs = _supporting_source_inputs(item.get("supporting_source_inputs", []))
        if source_inputs:
            normalized["supporting_source_inputs"] = source_inputs
        result.append(normalized)
    return result


def validate_plan_body(body: dict) -> dict:
    if set(body) != {"requirement_revision_id", "expected_revision", "requirement_refs", "materials", "operations"}:
        raise MappingError("invalid_execution_plan")
    revision_id = body["requirement_revision_id"]
    expected = body["expected_revision"]
    if not isinstance(revision_id, str) or not re.fullmatch(r"[a-f0-9]{32}", revision_id):
        raise MappingError("invalid_execution_plan")
    if type(expected) is not int or expected < 0:
        raise MappingError("invalid_execution_plan")
    return {
        "requirement_revision_id": revision_id,
        "expected_revision": expected,
        "requirement_refs": validate_requirement_refs(body["requirement_refs"], allow_empty=True),
        "materials": validate_materials(body["materials"]),
        "operations": validate_operations(body["operations"]),
    }
