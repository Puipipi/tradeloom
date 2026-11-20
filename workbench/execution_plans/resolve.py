from __future__ import annotations

from typing import Any

from django.db import transaction

from workbench.intake.api import _complete, _fail, _key, _reserve
from workbench.intake.mapping import MappingError, fingerprint
from workbench.models import ExecutionPlanRevision, IntakeOperationReceipt

from ..materials.rules import evaluate_line
from ..materials.store import load_items

_RESOLVED = "resolved"


class PlanResolveError(ValueError):
    def __init__(self, code: str) -> None:
        self.code = code
        super().__init__(code)


def resolve_plan_materials(plan_revision_id: str, key: str) -> tuple[dict[str, Any], bool]:
    """以最新计划为基追加新 revision：核对通过的物料行解冻为 resolved。

    AppendOnly 语义下不改动旧行；未解冻行保持原样继续走未解析投影。
    """
    plan = (ExecutionPlanRevision.objects
            .select_related("requirement_revision__draft")
            .filter(pk=plan_revision_id).first())
    if plan is None:
        raise PlanResolveError("execution_plan_requirement_not_found")

    request_fingerprint = fingerprint({
        "action": "plan_material_resolve", "plan_revision_id": plan.pk,
    })
    receipt = None
    try:
        with transaction.atomic():
            receipt, created = _reserve(key, "plan_material_resolve", request_fingerprint)
            if not created:
                if receipt.fingerprint != request_fingerprint:
                    raise MappingError("idempotency_conflict")
                if receipt.state == IntakeOperationReceipt.State.FAILED:
                    raise PlanResolveError(receipt.error_code or "unavailable")
                replay = ExecutionPlanRevision.objects.filter(pk=receipt.result_id or "").first()
                if replay is None:
                    raise PlanResolveError("unavailable")
                return _payload(replay, resolved=0, applied=False), False
            # 幂等重放优先于过期判断：同一 key 对旧 revision 重放时返回已生成的结果。
            from .service import latest_revision
            if plan.revision != latest_revision(plan.requirement_revision):
                _fail(receipt, "stale_execution_plan")
                raise PlanResolveError("stale_execution_plan")

            items = load_items()
            resolved_rows: list[dict[str, Any]] = []
            resolved_count = 0
            for row in plan.materials:
                if (row.get("resolution") == "unresolved" and row.get("item_ref") is None
                        and isinstance(row.get("proposal"), dict)):
                    proposal = row["proposal"]
                    check = evaluate_line(
                        ref=f"plan:{plan.pk}", reference=proposal.get("description"),
                        quantity=proposal.get("quantity"), unit=proposal.get("unit"), items=items,
                    )
                    if check.resolution.status == "resolved" and check.resolution.item is not None:
                        new_row = dict(row)
                        new_row["resolution"] = _RESOLVED
                        new_row["item_ref"] = {"doctype": "Item", "name": check.resolution.item.item_code}
                        resolved_rows.append(new_row)
                        resolved_count += 1
                        continue
                resolved_rows.append(dict(row))

            if resolved_count == 0:
                _fail(receipt, "nothing_resolved")
                raise PlanResolveError("nothing_resolved")

            next_revision = plan.revision + 1
            new_plan = ExecutionPlanRevision.objects.create(
                requirement_revision=plan.requirement_revision, revision=next_revision,
                requirement_refs=plan.requirement_refs, materials=resolved_rows,
                operations=plan.operations, status=ExecutionPlanRevision.Status.DRAFT,
            )
            _complete(receipt, "execution_plan_revision", new_plan.pk)
            return _payload(new_plan, resolved=resolved_count, applied=True), True
    except PlanResolveError:
        raise
    except MappingError:
        raise
    except Exception:
        if receipt is not None and receipt.state == IntakeOperationReceipt.State.RESERVED:
            _fail(receipt, "unavailable")
        raise


def _payload(plan: ExecutionPlanRevision, *, resolved: int, applied: bool) -> dict[str, Any]:
    from .service import plan_payload

    return {
        "status": "succeeded", "applied": applied, "resolved_materials": resolved,
        "plan": plan_payload(plan),
    }


__all__ = ["PlanResolveError", "resolve_plan_materials"]
