from __future__ import annotations

from typing import Any

from django.db import transaction

from workbench.intake.api import _complete, _fail, _key, _reserve
from workbench.intake.mapping import fingerprint
from workbench.models import IntakeCandidate, IntakeOperationReceipt, MaterialItem

from .store import MaterialStoreError, create_item

_APPLY_FIELDS = ("item_code", "item_name", "item_group", "stock_uom")
_ERROR_STATUS = {
    "candidate_not_found": 404, "unsupported_candidate_type": 422,
    "missing_field_values": 422, "invalid_material": 422,
    "item_exists": 409, "unavailable": 503,
}


class MaterialApplyError(ValueError):
    def __init__(self, code: str) -> None:
        self.code = code
        super().__init__(code)


def _present_value(candidate: IntakeCandidate, field_key: str) -> str:
    """行值必须恰好有一个 present 单元格；多值或缺值都退回人工处理。"""
    cells = candidate.typed_payload.get("fields", {}).get(field_key)
    if (not isinstance(cells, list) or len(cells) != 1 or not isinstance(cells[0], dict)
            or cells[0].get("state") != "present" or not isinstance(cells[0].get("value"), str)):
        raise MaterialApplyError("missing_field_values")
    return cells[0]["value"]


def apply_material_candidate(candidate_id: str, key: str) -> tuple[dict[str, Any], bool]:
    """把 material_master 候选应用为物料主数据；幂等键防重放，已存在且一致时按成功重放。"""
    try:
        candidate = IntakeCandidate.objects.select_related("mapping_revision__snapshot__source").get(pk=candidate_id)
    except IntakeCandidate.DoesNotExist:
        raise MaterialApplyError("candidate_not_found") from None
    if candidate.candidate_type != "material_master":
        raise MaterialApplyError("unsupported_candidate_type")

    values = {field: _present_value(candidate, field) for field in _APPLY_FIELDS}
    request_fingerprint = fingerprint({
        "action": "material_apply", "candidate_id": candidate.pk,
        "mapping_sha256": candidate.mapping_revision.mapping_sha256,
    })
    receipt = None
    try:
        with transaction.atomic():
            receipt, created = _reserve(key, "material_apply", request_fingerprint)
            if not created:
                if receipt.fingerprint != request_fingerprint:
                    raise MaterialApplyError("idempotency_conflict")
                if receipt.state == IntakeOperationReceipt.State.FAILED:
                    raise MaterialApplyError(receipt.error_code or "unavailable")
                item = MaterialItem.objects.filter(pk=receipt.result_id or "").first() if receipt.result_id else None
                if item is None:
                    raise MaterialApplyError("unavailable")
                return {"status": "succeeded", "item": _payload(item), "applied": False}, False
            existing = MaterialItem.objects.filter(item_code=values["item_code"]).first()
            if existing is not None:
                identical = (existing.item_name == values["item_name"]
                             and existing.item_group == values["item_group"]
                             and existing.stock_uom == values["stock_uom"])
                if not identical:
                    _fail(receipt, "item_exists")
                    raise MaterialApplyError("item_exists")
                _complete(receipt, "material_apply", existing.pk)
                return {"status": "succeeded", "item": _payload(existing), "applied": False}, False
            try:
                item = create_item(source=f"intake:{candidate.pk}", **values)
            except MaterialStoreError as exc:
                _fail(receipt, exc.code)
                raise MaterialApplyError(exc.code) from None
            _complete(receipt, "material_apply", item.pk)
            return {"status": "succeeded", "item": _payload(item), "applied": True}, True
    except MaterialApplyError:
        raise
    except Exception:
        if receipt is not None and receipt.state == IntakeOperationReceipt.State.RESERVED:
            _fail(receipt, "unavailable")
        raise


def _payload(item: MaterialItem) -> dict[str, Any]:
    return {
        "item_code": item.item_code, "item_name": item.item_name, "item_group": item.item_group,
        "stock_uom": item.stock_uom, "aliases": list(item.aliases or ()),
        "disabled": item.disabled, "source": item.source,
    }


__all__ = ["MaterialApplyError", "apply_material_candidate"]
