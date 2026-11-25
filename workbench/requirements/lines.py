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
from ..materials.variants import load_variants, resolve_variant

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


def _optional_unit(cells: Any) -> list[str] | None:
    """单位列可选：未映射或单元格非文本时按空串处理，不猜测单位。"""
    if cells is None:
        return None
    if not isinstance(cells, list):
        raise RequirementLineError("row_shape_mismatch")
    values = []
    for cell in cells:
        if not isinstance(cell, dict):
            raise RequirementLineError("row_shape_mismatch")
        if cell.get("state") == "present":
            value = cell.get("value")
            values.append(value if isinstance(value, str) else ("" if value is None else str(value)))
        else:
            values.append("")
    return values


def _row_payloads(candidate: IntakeCandidate) -> list[dict[str, Any]]:
    fields = candidate.typed_payload.get("fields", {})
    columns = {name: _present_text(fields.get(name)) for name in ("material", "quantity")}
    unit_values = _optional_unit(fields.get("unit"))
    lengths = {len(values) for values in columns.values()}
    if len(lengths) != 1:
        raise RequirementLineError("row_shape_mismatch")
    count = lengths.pop()
    if unit_values is not None and len(unit_values) != count:
        raise RequirementLineError("row_shape_mismatch")
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
            "unit": (unit_values[index] if unit_values else "").strip(),
            "source": source if isinstance(source, dict) else {},
        })
    return rows


def _line_payload(row: ProductionRequirementLine) -> dict[str, Any]:
    questions = [issue.get("question") for issue in (row.issues or []) if isinstance(issue, dict)]
    return {
        "position": row.position,
        "material": row.material,
        "variant_ref": row.variant_ref,
        "variant_status": row.variant_status,
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
    variants = load_variants()
    result = []
    for row in rows:
        variant = resolve_variant(row["material"], variants)
        if variant is not None:
            # 机型优先：真实生产单的行是"成品×数量"；组件清单未录入时
            # 只提示补录，不猜测组件；组件物料缺失按阻断处理。
            variant_issues: list[dict[str, Any]] = []
            if variant.disabled:
                variant_issues.append({
                    "issue_key": "disabled_variant", "item_ref": variant.variant_code,
                    "question": "该机型已停用，请确认是否改用其他机型。", "severity": BLOCKING,
                    "detail": {"variant_code": variant.variant_code, "name": variant.name}, "options": [],
                })
            if not variant.components:
                variant_issues.append({
                    "issue_key": "variant_components_missing", "item_ref": variant.variant_code,
                    "question": "该机型尚未录入组件配置清单，请补录 BOM 后再核对。",
                    "severity": "confirm", "detail": {"variant_code": variant.variant_code}, "options": [],
                })
            for component in variant.components:
                check = evaluate_line(
                    ref=f"line:{row['position']}:component:{component.position}",
                    reference=component.item_ref,
                    quantity=component.quantity, unit=None, items=items,
                )
                variant_issues.extend(issue.to_dict() for issue in check.issues)
            defaults = {
                "material": row["material"],
                "variant_ref": {"doctype": "Product Variant", "name": variant.variant_code},
                "variant_status": "resolved",
                "item_ref": None,
                "item_status": "unresolved",
                "quantity": row["quantity"],
                "unit": row["unit"],
                "issues": variant_issues,
                "source_refs": {"candidate_id": candidate.pk, "cell": row["source"]},
            }
        else:
            check = evaluate_line(
                ref=f"line:{row['position']}", reference=row["material"],
                quantity=row["quantity"] or None, unit=row["unit"] or None, items=items,
            )
            resolved = check.resolution.item
            defaults = {
                "material": row["material"],
                "variant_ref": None,
                "variant_status": "unresolved",
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
