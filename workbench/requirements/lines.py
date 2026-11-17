from __future__ import annotations

import re
from typing import Any

from django.db import transaction

from workbench.intake.api import _complete, _fail, _key, _reserve
from workbench.intake.mapping import fingerprint
from workbench.models import (
    IntakeCandidate,
    IntakeOperationReceipt,
    ProductionRequirementDraft,
    ProductionRequirementLine,
)

from ..materials.rules import BLOCKING, evaluate_line
from ..materials.store import load_items

_LINE_FIELDS = ("material", "quantity", "unit")
_INTEGER = re.compile(r"(?:0|[1-9][0-9]*)\Z")
_ERROR_STATUS = {
    "candidate_not_found": 404, "requirement_not_found": 404,
    "unsupported_candidate_type": 422, "row_shape_mismatch": 422,
    "empty_rows": 422, "requirement_confirmed": 409,
    "idempotency_conflict": 409, "unavailable": 503,
}


class RequirementLineError(ValueError):
    def __init__(self, code: str) -> None:
        self.code = code
        super().__init__(code)


def _present_text(cells: Any) -> list[str]:
    if not isinstance(cells, list) or not cells:
        raise RequirementLineError("row_shape_mismatch")
    values = []
    for cell in cells:
        if not isinstance(cell, dict) or cell.get("state") != "present":
            raise RequirementLineError("row_shape_mismatch")
        value = cell.get("value")
        values.append(value if isinstance(value, str) else ("" if value is None else str(value)))
    return values


def _row_payloads(candidate: IntakeCandidate) -> list[dict[str, Any]]:
    fields = candidate.typed_payload.get("fields", {})
    columns = {name: _present_text(fields.get(name)) for name in _LINE_FIELDS}
    lengths = {len(values) for values in columns.values()}
    if len(lengths) != 1:
        raise RequirementLineError("row_shape_mismatch")
    count = lengths.pop()
    if count == 0:
        raise RequirementLineError("empty_rows")
    provenance = candidate.provenance.get("material", [])
    rows = []
    for index in range(count):
        source = provenance[index] if isinstance(provenance, list) and index < len(provenance) else {}
        rows.append({
            "position": index + 1,
            "material": columns["material"][index].strip(),
            "quantity": columns["quantity"][index].strip(),
            "unit": columns["unit"][index].strip(),
            "source": source if isinstance(source, dict) else {},
        })
    return rows


def _line_payload(row: ProductionRequirementLine) -> dict[str, Any]:
    questions = [issue.get("question") for issue in (row.issues or []) if isinstance(issue, dict)]
    return {
        "position": row.position,
        "material": row.material,
        "item_ref": row.item_ref,
        "item_status": row.item_status,
        "quantity": row.quantity,
        "unit": row.unit,
        "issues": list(row.issues or []),
        "blocked": any(isinstance(issue, dict) and issue.get("severity") == BLOCKING
                       for issue in (row.issues or [])),
        "questions": questions,
        "source": row.source_refs,
    }


def lines_summary(draft: ProductionRequirementDraft) -> dict[str, Any]:
    rows = list(draft.material_lines.all())
    payloads = [_line_payload(row) for row in rows]
    blocked = [item for item in payloads if item["blocked"]]
    return {
        "total": len(payloads),
        "blocked": len(blocked),
        "lines": payloads,
    }


def _refresh_lines(draft: ProductionRequirementDraft, candidate: IntakeCandidate) -> list[ProductionRequirementLine]:
    rows = _row_payloads(candidate)
    items = load_items()
    result = []
    for row in rows:
        check = evaluate_line(
            ref=f"line:{row['position']}", reference=row["material"],
            quantity=row["quantity"] or None, unit=row["unit"] or None, items=items,
        )
        resolved = check.resolution.item
        defaults = {
            "material": row["material"],
            "item_ref": ({"doctype": "Item", "name": resolved.item_code} if resolved else None),
            "item_status": check.resolution.status,
            "quantity": row["quantity"],
            "unit": row["unit"],
            "issues": [issue.to_dict() for issue in check.issues],
            "source_refs": {"candidate_id": candidate.pk, "cell": row["source"]},
        }
        line, _ = ProductionRequirementLine.objects.update_or_create(
            source_candidate=candidate, position=row["position"], defaults={"draft": draft, **defaults},
        )
        result.append(line)
    # 同候选行数变少时清掉多余旧行（行是草稿数据，非追加证据）。
    ProductionRequirementLine.objects.filter(source_candidate=candidate, position__gt=len(rows)).delete()
    return result


def apply_requirement_lines(candidate_id: str, requirement_id: str, key: str) -> tuple[dict[str, Any], bool]:
    try:
        candidate = IntakeCandidate.objects.select_related("mapping_revision").get(pk=candidate_id)
    except IntakeCandidate.DoesNotExist:
        raise RequirementLineError("candidate_not_found") from None
    if candidate.candidate_type != "production_instruction_line":
        raise RequirementLineError("unsupported_candidate_type")
    try:
        draft = ProductionRequirementDraft.objects.get(pk=requirement_id)
    except ProductionRequirementDraft.DoesNotExist:
        raise RequirementLineError("requirement_not_found") from None
    if draft.status == "confirmed":
        raise RequirementLineError("requirement_confirmed")

    request_fingerprint = fingerprint({
        "action": "requirement_lines", "candidate_id": candidate.pk, "requirement_id": draft.pk,
        "mapping_sha256": candidate.mapping_revision.mapping_sha256,
    })
    receipt = None
    try:
        with transaction.atomic():
            receipt, created = _reserve(key, "requirement_lines", request_fingerprint)
            if not created:
                if receipt.fingerprint != request_fingerprint:
                    raise RequirementLineError("idempotency_conflict")
                if receipt.state == IntakeOperationReceipt.State.FAILED:
                    raise RequirementLineError(receipt.error_code or "unavailable")
                return _summary(draft), False
            lines = _refresh_lines(draft, candidate)
            _complete(receipt, "requirement_lines", draft.pk)
            return _summary(draft, lines=lines), True
    except RequirementLineError:
        raise
    except Exception:
        if receipt is not None and receipt.state == IntakeOperationReceipt.State.RESERVED:
            _fail(receipt, "unavailable")
        raise


def _summary(draft: ProductionRequirementDraft, *, lines: list[ProductionRequirementLine] | None = None) -> dict[str, Any]:
    rows = [_line_payload(row) for row in (lines if lines is not None else draft.material_lines.all())]
    return {
        "status": "succeeded",
        "requirement_id": draft.pk,
        "applied": lines is not None,
        "total": len(rows),
        "blocked": sum(1 for row in rows if row["blocked"]),
        "lines": rows,
    }


def parse_positive_int(value: str) -> bool:
    return bool(_INTEGER.fullmatch(value or ""))


def apply_requirement_lines_view(request: Any, candidate_id: str) -> Any:
    """POST /api/intake/candidates/<id>/requirement-lines — body {requirement_id}。"""
    from django.http import JsonResponse

    from workbench.intake.api import _error, _json_object

    try:
        key = _key(request)
        body = _json_object(request)
        if set(body) != {"requirement_id"} or not isinstance(body["requirement_id"], str) or len(body["requirement_id"]) != 32:
            return _error("invalid_arguments")
        result, created = apply_requirement_lines(candidate_id, body["requirement_id"], key)
        return JsonResponse({"ok": True, **result}, status=201 if created else 200)
    except RequirementLineError as exc:
        return JsonResponse({"ok": False, "error_code": exc.code},
                            status=_ERROR_STATUS.get(exc.code, 422))
    except ValueError as exc:
        if str(exc) == "invalid_idempotency_key":
            return _error("invalid_idempotency_key")
        return _error("invalid_json")
    except Exception:
        return _error("unavailable", 503)


__all__ = [
    "RequirementLineError", "apply_requirement_lines", "apply_requirement_lines_view",
    "lines_summary", "parse_positive_int",
]
