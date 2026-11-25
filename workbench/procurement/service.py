"""采购 / 入库 / 出货回款：手动打表与手工录入的单据层。

三种单据共用同一套"列 zip 成行 → 逐行校验 → 按 (候选, 位置) 刷新"的引擎；
确认是显式人工动作，阻断问题未清的物料行不能确认。
"""
from __future__ import annotations

import re
from datetime import date
from typing import Any

from django.db import transaction

from workbench.intake.api import _complete, _fail, _reserve
from workbench.intake.mapping import MappingError, fingerprint
from workbench.models import (
    IntakeCandidate,
    IntakeOperationReceipt,
    ProductionRequirementDraft,
    PurchasePlan,
    ShipmentPayment,
    StockReceipt,
)

from ..materials.rules import BLOCKING, evaluate_line
from ..materials.store import load_items

_COLUMNS = {
    "purchase_plan": ("material", "quantity", "unit"),
    "stock_receipt": ("material", "quantity", "unit"),
    "shipment_payment": ("reference", "amount", "currency"),
}
_MODEL_BY_TYPE = {
    "purchase_plan": PurchasePlan,
    "stock_receipt": StockReceipt,
    "shipment_payment": ShipmentPayment,
}
_CANDIDATE_TO_DOC = {f"{name}_line": name for name in _MODEL_BY_TYPE}
_DECIMAL = re.compile(r"(?:0|[1-9][0-9]{0,11})(?:\.[0-9]{1,8})?\Z")
_CURRENCY = re.compile(r"[A-Za-z]{3}\Z")


class DocumentError(ValueError):
    def __init__(self, code: str) -> None:
        self.code = code
        super().__init__(code)


def _present_text(cells: Any) -> list[str]:
    if not isinstance(cells, list) or not cells:
        raise DocumentError("row_shape_mismatch")
    values = []
    for cell in cells:
        if not isinstance(cell, dict) or cell.get("state") != "present":
            raise DocumentError("row_shape_mismatch")
        value = cell.get("value")
        values.append(value if isinstance(value, str) else ("" if value is None else str(value)))
    return values


def _optional_text(cells: Any) -> list[str] | None:
    """可选列：未映射或单元格非文本时按空串处理，不猜测（真实单据常缺物料/单位列）。"""
    if cells is None:
        return None
    if not isinstance(cells, list):
        raise DocumentError("row_shape_mismatch")
    values = []
    for cell in cells:
        if not isinstance(cell, dict):
            raise DocumentError("row_shape_mismatch")
        if cell.get("state") == "present":
            value = cell.get("value")
            values.append(value if isinstance(value, str) else ("" if value is None else str(value)))
        else:
            values.append("")
    return values


def _rows(candidate: IntakeCandidate, doc_type: str) -> list[dict[str, Any]]:
    if doc_type == "shipment_payment":
        columns = {name: _present_text(candidate.typed_payload.get("fields", {}).get(name))
                   for name in _COLUMNS[doc_type]}
        lengths = {len(values) for values in columns.values()}
        if len(lengths) != 1:
            raise DocumentError("row_shape_mismatch")
        count = lengths.pop()
        if count == 0:
            raise DocumentError("empty_rows")
        provenance = candidate.provenance.get("reference", [])
        rows = []
        for index in range(count):
            source = provenance[index] if isinstance(provenance, list) and index < len(provenance) else {}
            rows.append({
                "position": index + 1,
                "values": {name: columns[name][index].strip() for name in columns},
                "source": source if isinstance(source, dict) else {},
            })
        return rows
    # 物料类单据：数量列必填；物料/单位列可选（真实采购合同把产品身份放在图片列，
    # 编码由人工补齐后重新打表），缺物料引用的行落库并阻断确认。
    fields = candidate.typed_payload.get("fields", {})
    columns = {
        "quantity": _present_text(fields.get("quantity")),
        "material": _optional_text(fields.get("material")),
        "unit": _optional_text(fields.get("unit")),
    }
    lengths = {len(columns["quantity"])}
    for name in ("material", "unit"):
        if columns[name] is not None:
            lengths.add(len(columns[name]))
    if len(lengths) != 1:
        raise DocumentError("row_shape_mismatch")
    count = lengths.pop()
    if count == 0:
        raise DocumentError("empty_rows")
    source_column = "material" if columns["material"] is not None else "quantity"
    provenance = candidate.provenance.get(source_column, [])
    rows = []
    for index in range(count):
        source = provenance[index] if isinstance(provenance, list) and index < len(provenance) else {}
        rows.append({
            "position": index + 1,
            "values": {
                "material": (columns["material"][index] if columns["material"] is not None else "").strip(),
                "quantity": columns["quantity"][index].strip(),
                "unit": (columns["unit"][index] if columns["unit"] is not None else "").strip(),
            },
            "source": source if isinstance(source, dict) else {},
        })
    return rows


def _material_line(row: dict[str, Any], items: tuple) -> dict[str, Any]:
    values = row["values"]
    check = evaluate_line(
        ref=f"doc:{row['position']}", reference=values["material"],
        quantity=values["quantity"] or None, unit=values["unit"] or None, items=items,
    )
    resolved = check.resolution.item
    issues = [issue.to_dict() for issue in check.issues]
    if not values["material"].strip():
        issues.append({
            "issue_key": "missing_material_reference", "item_ref": "",
            "question": "该行缺少物料引用，请在来源表格补齐物料编码后重新打表。",
            "severity": BLOCKING, "detail": {"position": row["position"]}, "options": [],
        })
    return {
        "material": values["material"],
        "item_ref": ({"doctype": "Item", "name": resolved.item_code} if resolved else None),
        "item_status": check.resolution.status,
        "quantity": values["quantity"],
        "unit": values["unit"],
        "issues": issues,
    }


def _shipment_line(row: dict[str, Any]) -> dict[str, Any]:
    values = row["values"]
    if not _DECIMAL.fullmatch(values["amount"]) or values["amount"] == "0":
        raise DocumentError("invalid_amount")
    if not _CURRENCY.fullmatch(values["currency"]):
        raise DocumentError("invalid_currency")
    return {
        "reference": values["reference"][:200],
        "amount": values["amount"],
        "currency": values["currency"].upper(),
    }


def _parse_date(value: Any) -> date | None:
    if value in (None, ""):
        return None
    if not isinstance(value, str) or len(value) != 10:
        raise DocumentError("invalid_date")
    parsed = date.fromisoformat(value)
    if parsed.isoformat() != value:
        raise DocumentError("invalid_date")
    return parsed


def _doc_payload(row) -> dict[str, Any]:
    data = {
        "id": row.pk, "position": row.position, "status": row.status, "source": row.source,
        "created_at": row.created_at.isoformat(),
    }
    if isinstance(row, ShipmentPayment):
        data.update(kind=row.kind, reference=row.reference, amount=row.amount,
                    currency=row.currency, occurred_on=row.occurred_on.isoformat() if row.occurred_on else None)
    else:
        data.update(material=row.material, item_ref=row.item_ref, item_status=row.item_status,
                    quantity=row.quantity, unit=row.unit, issues=list(row.issues or []))
        data["blocked"] = any(isinstance(issue, dict) and issue.get("severity") == BLOCKING
                              for issue in (row.issues or []))
        if isinstance(row, PurchasePlan):
            data["expected_on"] = row.expected_on.isoformat() if row.expected_on else None
            data["requirement_id"] = row.requirement_draft_id
        else:
            data["received_on"] = row.received_on.isoformat() if row.received_on else None
            data["purchase_plan_id"] = row.purchase_plan_id
    return data


def apply_documents(candidate_id: str, key: str, *, doc_type: str | None = None,
                    requirement_id: str | None = None,
                    purchase_plan_id: str | None = None, kind: str = "shipment") -> tuple[dict[str, Any], bool]:
    try:
        candidate = IntakeCandidate.objects.select_related("mapping_revision").get(pk=candidate_id)
    except IntakeCandidate.DoesNotExist:
        raise DocumentError("candidate_not_found") from None
    resolved_type = _CANDIDATE_TO_DOC.get(candidate.candidate_type)
    if resolved_type is None or (doc_type is not None and doc_type != resolved_type):
        raise DocumentError("unsupported_candidate_type")
    doc_type = resolved_type

    requirement = None
    if doc_type == "purchase_plan":
        if not requirement_id:
            raise DocumentError("requirement_required")
        requirement = ProductionRequirementDraft.objects.filter(pk=requirement_id).first()
        if requirement is None:
            raise DocumentError("requirement_not_found")
    plan = None
    if doc_type == "stock_receipt" and purchase_plan_id:
        plan = PurchasePlan.objects.filter(pk=purchase_plan_id).first()
        if plan is None:
            raise DocumentError("purchase_plan_not_found")

    request_fingerprint = fingerprint({"action": f"documents_{doc_type}", "candidate_id": candidate.pk,
                                       "requirement_id": requirement_id, "purchase_plan_id": purchase_plan_id,
                                       "kind": kind if doc_type == "shipment_payment" else ""})
    receipt = None
    try:
        with transaction.atomic():
            receipt, created = _reserve(key, f"documents_{doc_type}", request_fingerprint)
            if not created:
                if receipt.fingerprint != request_fingerprint:
                    raise MappingError("idempotency_conflict")
                if receipt.state == IntakeOperationReceipt.State.FAILED:
                    raise DocumentError(receipt.error_code or "unavailable")
                return _summary(doc_type, candidate, applied=False), False
            rows = _rows(candidate, doc_type)
            items = load_items() if doc_type in {"purchase_plan", "stock_receipt"} else ()
            model = _MODEL_BY_TYPE[doc_type]
            for row in rows:
                defaults: dict[str, Any] = {
                    "source_candidate": candidate, "position": row["position"],
                    "status": "draft", "source": f"intake:{candidate.pk}",
                }
                if doc_type == "shipment_payment":
                    line = _shipment_line(row)
                    defaults.update(kind=kind, **line)
                else:
                    line = _material_line(row, items)
                    defaults.update(**line)
                    if doc_type == "purchase_plan":
                        defaults["requirement_draft"] = requirement
                    else:
                        defaults["purchase_plan"] = plan
                model.objects.update_or_create(source_candidate=candidate, position=row["position"],
                                               defaults=defaults)
            model.objects.filter(source_candidate=candidate, position__gt=len(rows)).delete()
            _complete(receipt, f"{doc_type}_batch", candidate.pk)
            return _summary(doc_type, candidate, applied=True), True
    except DocumentError:
        raise
    except MappingError:
        raise
    except Exception:
        if receipt is not None and receipt.state == IntakeOperationReceipt.State.RESERVED:
            _fail(receipt, "unavailable")
        raise


def _summary(doc_type: str, candidate: IntakeCandidate, *, applied: bool) -> dict[str, Any]:
    rows = [_doc_payload(row) for row in
            _MODEL_BY_TYPE[doc_type].objects.filter(source_candidate=candidate).order_by("position")]
    return {"status": "succeeded", "doc_type": doc_type, "applied": applied,
            "total": len(rows), "blocked": sum(1 for row in rows if row.get("blocked")),
            "documents": rows}


def confirm_document(doc_type: str, doc_id: str) -> dict[str, Any]:
    model = _MODEL_BY_TYPE[doc_type]
    with transaction.atomic():
        row = model.objects.select_for_update().filter(pk=doc_id).first()
        if row is None:
            raise DocumentError("document_not_found")
        if row.status == "confirmed":
            return {"status": "succeeded", "document": _doc_payload(row), "confirmed": False}
        payload = _doc_payload(row)
        if payload.get("blocked"):
            raise DocumentError("document_blocked")
        row.status = "confirmed"
        row.save(update_fields=["status", "updated_at"])
        return {"status": "succeeded", "document": _doc_payload(row), "confirmed": True}


def list_documents(doc_type: str, *, limit: int = 50) -> dict[str, Any]:
    rows = _MODEL_BY_TYPE[doc_type].objects.all().order_by("-created_at", "id")[:limit]
    return {"ok": True, "doc_type": doc_type, "documents": [_doc_payload(row) for row in rows]}


__all__ = ["DocumentError", "apply_documents", "confirm_document", "list_documents"]
