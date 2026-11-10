from __future__ import annotations

import re

from django.db import IntegrityError, transaction
from django.http import HttpRequest, JsonResponse
from django.views.decorators.http import require_GET, require_http_methods

from workbench.intake.api import _complete, _error, _json_object, _key, _reserve
from workbench.intake.mapping import MappingError, fingerprint
from workbench.models import (
    ExecutionPlanRevision,
    IntakeOperationReceipt,
    ProductionRequirementDraft,
    ProductionRequirementRevision,
)

from .schemas import MAX_REQUEST_BYTES, validate_plan_body
from .service import create_plan_payload, latest_revision, plan_payload


_INTEGER = re.compile(r"(?:0|[1-9][0-9]*)\Z")
_ERROR_STATUS = {
    "invalid_execution_plan": 422,
    "execution_plan_requirement_not_found": 404,
    "unconfirmed_requirement": 409,
    "stale_execution_plan": 409,
    "execution_plan_idempotency_conflict": 409,
    "invalid_execution_evidence": 422,
    "unavailable": 503,
}


def _safe_error(code: str, status: int | None = None) -> JsonResponse:
    return _error(code, status=_ERROR_STATUS.get(code, 400) if status is None else status)


def _result(receipt: IntakeOperationReceipt, *, replay: bool) -> JsonResponse:
    if receipt.state == IntakeOperationReceipt.State.FAILED:
        return _safe_error(receipt.error_code or "unavailable")
    if receipt.state != IntakeOperationReceipt.State.SUCCEEDED:
        return JsonResponse({"ok": True, "status": "pending", "operation_id": receipt.pk}, status=202)
    plan = ExecutionPlanRevision.objects.select_related("requirement_revision__draft").filter(pk=receipt.result_id).first()
    if plan is None or receipt.result_type != "execution_plan_revision":
        return _safe_error("unavailable", 503)
    payload = plan_payload(plan)
    return JsonResponse({"ok": True, "status": "succeeded", "plan": payload,
                         "requirement_revision": payload["requirement_revision"],
                         "latest_revision": payload["latest_revision"], "is_latest": payload["is_latest"],
                         "actual": {"status": "missing"}}, status=200 if replay else 201)


def _history_page(request: HttpRequest, requirement_id: str) -> JsonResponse:
    if (set(request.GET.keys()) - {"offset", "limit", "requirement_revision_id"} or
            any(len(request.GET.getlist(key)) != 1 for key in request.GET.keys())):
        return _safe_error("invalid_execution_plan")
    offset_text, limit_text = request.GET.get("offset", "0"), request.GET.get("limit", "10")
    if not _INTEGER.fullmatch(offset_text) or not _INTEGER.fullmatch(limit_text):
        return _safe_error("invalid_execution_plan")
    if len(offset_text) > 6 or len(limit_text) > 2:
        return _safe_error("invalid_execution_plan")
    offset, limit = int(offset_text), int(limit_text)
    if offset > 100_000 or not 1 <= limit <= 20:
        return _safe_error("invalid_execution_plan")
    draft = ProductionRequirementDraft.objects.filter(pk=requirement_id).first()
    if draft is None:
        return _safe_error("execution_plan_requirement_not_found")
    selected_id = request.GET.get("requirement_revision_id")
    selected_requirement = None
    plans = ExecutionPlanRevision.objects.select_related("requirement_revision__draft").filter(
        requirement_revision__draft=draft
    )
    if selected_id is not None:
        if not re.fullmatch(r"[a-f0-9]{32}", selected_id):
            return _safe_error("invalid_execution_plan")
        selected_requirement = ProductionRequirementRevision.objects.filter(pk=selected_id, draft=draft).first()
        if selected_requirement is None:
            return _safe_error("invalid_execution_plan")
        plans = plans.filter(requirement_revision=selected_requirement)
    rows = list(plans.order_by("-created_at", "-id")[offset:offset + limit + 1])
    latest = latest_revision(selected_requirement) if selected_requirement is not None else None
    return JsonResponse({"ok": True, "requirement_revision_id": selected_id,
                         "latest_revision": latest, "revisions": [plan_payload(row) for row in rows[:limit]],
                         "next_offset": offset + limit if len(rows) > limit else None})


@require_http_methods(["GET", "POST"])
def plan_revision_collection(request: HttpRequest, requirement_id: str) -> JsonResponse:
    if request.method == "GET":
        return _history_page(request, requirement_id)
    receipt_id = None
    try:
        key = _key(request)
        body = _json_object(request, max_bytes=MAX_REQUEST_BYTES)
        plan = validate_plan_body(body)
        with transaction.atomic():
            draft = ProductionRequirementDraft.objects.select_for_update().filter(pk=requirement_id).first()
            if draft is None:
                return _safe_error("execution_plan_requirement_not_found")
            requirement = ProductionRequirementRevision.objects.select_related("draft").filter(
                pk=plan["requirement_revision_id"], draft=draft,
            ).first()
            if requirement is None:
                return _safe_error("execution_plan_requirement_not_found")
            if requirement.status != ProductionRequirementRevision.Status.CONFIRMED:
                return _safe_error("unconfirmed_requirement")
            plan = create_plan_payload(requirement, plan)
            request_fingerprint = fingerprint({"action": "execution_plan_revision", "draft_id": draft.pk, **plan})
            receipt, created = _reserve(key, "execution_plan_revision", request_fingerprint)
            receipt_id = receipt.pk
            if not created:
                if receipt.action != "execution_plan_revision" or receipt.fingerprint != request_fingerprint:
                    raise MappingError("execution_plan_idempotency_conflict")
                return _result(receipt, replay=True)
            current = latest_revision(requirement)
            if plan["expected_revision"] != current:
                receipt.state = IntakeOperationReceipt.State.FAILED
                receipt.error_code = "stale_execution_plan"
                receipt.save(update_fields=["state", "error_code", "updated_at"])
                return _safe_error("stale_execution_plan")
            revision = ExecutionPlanRevision.objects.create(
                requirement_revision=requirement,
                revision=current + 1,
                requirement_refs=plan["requirement_refs"], materials=plan["materials"],
                operations=plan["operations"], status=ExecutionPlanRevision.Status.DRAFT,
            )
            _complete(receipt, "execution_plan_revision", revision.pk)
        return _result(receipt, replay=False)
    except MappingError as exc:
        if exc.code == "idempotency_conflict":
            return _safe_error("execution_plan_idempotency_conflict")
        return _safe_error(exc.code)
    except ValueError as exc:
        code = str(exc)
        if code in {"invalid_json", "invalid_idempotency_key", "invalid_execution_evidence"}:
            return _safe_error(code)
        return _safe_error("unavailable", 503)
    except IntegrityError:
        return _safe_error("stale_execution_plan")
    except Exception:
        return _safe_error("unavailable", 503)


@require_GET
def execution_plan_detail(_request: HttpRequest, plan_revision_id: str) -> JsonResponse:
    if not re.fullmatch(r"[a-f0-9]{32}", plan_revision_id):
        return _safe_error("execution_plan_requirement_not_found")
    plan = ExecutionPlanRevision.objects.select_related("requirement_revision__draft").filter(pk=plan_revision_id).first()
    if plan is None:
        return _safe_error("execution_plan_requirement_not_found")
    payload = plan_payload(plan)
    return JsonResponse({"ok": True, "plan": payload,
                         "requirement_revision": payload["requirement_revision"],
                         "latest_revision": payload["latest_revision"],
                         "is_latest": payload["is_latest"],
                         "actual": {"status": "missing"}})
