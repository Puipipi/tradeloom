from __future__ import annotations

import re
from datetime import date

from django.http import HttpRequest, JsonResponse
from django.views.decorators.http import require_GET, require_POST

from workbench.intake.api import _json_object
from workbench.models import Customer

from .service import (
    CustomerError,
    action_payload,
    alias_payload,
    analyze_customer,
    backtest_silence_followup,
    customer_detail_payload,
    customer_payload,
    decide_action,
    decide_alias,
    evaluate_silence_followup,
    merge_customers,
    merge_payload,
    reassign_alias,
    reconcile_prediction_outcomes,
    event_payload,
    metric_payload,
    prediction_payload,
    record_event_from_candidate,
)


_OPAQUE_ID = re.compile(r"[a-f0-9]{32}\Z")
_DATE = re.compile(r"[0-9]{4}-[0-9]{2}-[0-9]{2}\Z")


def _error(error: CustomerError) -> JsonResponse:
    return JsonResponse({"ok": False, "error_code": error.code}, status=error.status)


def _body(request: HttpRequest, required: set[str], optional: set[str] | None = None) -> dict:
    try:
        body = _json_object(request)
    except ValueError as exc:
        code = str(exc) if str(exc) in {"invalid_json", "duplicate_json_key"} else "invalid_json"
        raise CustomerError(code) from None
    optional = optional or set()
    if not required <= set(body) or set(body) - required - optional:
        raise CustomerError("invalid_arguments")
    return body


def _opaque_id(value: object, code: str = "invalid_arguments") -> str:
    if not isinstance(value, str) or not _OPAQUE_ID.fullmatch(value):
        raise CustomerError(code)
    return value


def _date(value: object) -> date:
    if not isinstance(value, str) or not _DATE.fullmatch(value):
        raise CustomerError("invalid_arguments")
    try:
        return date.fromisoformat(value)
    except ValueError:
        raise CustomerError("invalid_arguments") from None


@require_GET
def customer_collection(request: HttpRequest) -> JsonResponse:
    if request.GET:
        return _error(CustomerError("invalid_arguments"))
    rows = Customer.objects.filter(merged_into__isnull=True)[:100]
    return JsonResponse({"ok": True, "customers": [customer_payload(row) for row in rows]})


@require_GET
def customer_detail(request: HttpRequest, customer_id: str) -> JsonResponse:
    if request.GET:
        return _error(CustomerError("invalid_arguments"))
    customer = Customer.objects.filter(pk=customer_id).first()
    if customer is None:
        return _error(CustomerError("customer_not_found", 404))
    return JsonResponse({"ok": True, "customer": customer_detail_payload(customer)})


@require_GET
def customer_analysis(request: HttpRequest, customer_id: str) -> JsonResponse:
    if set(request.GET.keys()) != {"as_of"} or len(request.GET.getlist("as_of")) != 1:
        return _error(CustomerError("invalid_arguments"))
    try:
        result = analyze_customer(customer_id, _date(request.GET["as_of"]))
    except CustomerError as exc:
        return _error(exc)
    return JsonResponse({"ok": True, "analysis": result})


@require_POST
def customer_backtest(request: HttpRequest, customer_id: str) -> JsonResponse:
    try:
        body = _body(request, {"start", "end"}, {"step_days"})
        result = backtest_silence_followup(
            customer_id,
            _date(body["start"]),
            _date(body["end"]),
            body.get("step_days", 30),
        )
    except CustomerError as exc:
        return _error(exc)
    return JsonResponse({"ok": True, "backtest": result})


@require_POST
def customer_reconcile(request: HttpRequest, customer_id: str) -> JsonResponse:
    try:
        body = _body(request, {"as_of"})
        result = reconcile_prediction_outcomes(customer_id, _date(body["as_of"]))
    except CustomerError as exc:
        return _error(exc)
    return JsonResponse({"ok": True, "reconciliation": result})


@require_POST
def customer_merge(request: HttpRequest, customer_id: str) -> JsonResponse:
    try:
        body = _body(request, {"source_customer_id"}, {"note"})
        source_customer_id = _opaque_id(body["source_customer_id"])
        note = body.get("note", "")
        if not isinstance(note, str):
            raise CustomerError("invalid_identity_note")
        merge = merge_customers(source_customer_id, customer_id, note)
    except CustomerError as exc:
        return _error(exc)
    return JsonResponse({"ok": True, "merge": merge_payload(merge)})


@require_POST
def event_from_candidate(request: HttpRequest) -> JsonResponse:
    try:
        body = _body(request, {"candidate_id", "event_type", "occurred_on"})
        candidate_id = _opaque_id(body["candidate_id"])
        event_type = body["event_type"]
        if not isinstance(event_type, str):
            raise CustomerError("invalid_customer_event")
        occurred_on = _date(body["occurred_on"])
        event, alias, created = record_event_from_candidate(candidate_id, event_type, occurred_on)
    except CustomerError as exc:
        return _error(exc)
    if event is None:
        return JsonResponse(
            {"ok": True, "status": "needs_confirmation", "alias": alias_payload(alias)},
            status=202,
        )
    return JsonResponse(
        {
            "ok": True,
            "status": "recorded",
            "alias": alias_payload(alias),
            "event": event_payload(event),
        },
        status=201 if created else 200,
    )


@require_POST
def alias_decision(request: HttpRequest, alias_id: str) -> JsonResponse:
    try:
        body = _body(request, {"decision"}, {"customer_id", "display_name"})
        decision = body["decision"]
        if not isinstance(decision, str):
            raise CustomerError("invalid_alias_decision")
        customer_id = body.get("customer_id")
        if customer_id is not None:
            customer_id = _opaque_id(customer_id)
        display_name = body.get("display_name")
        if display_name is not None and not isinstance(display_name, str):
            raise CustomerError("invalid_alias_decision")
        alias = decide_alias(
            alias_id,
            decision,
            customer_id=customer_id,
            display_name=display_name,
        )
    except CustomerError as exc:
        return _error(exc)
    return JsonResponse({"ok": True, "alias": alias_payload(alias)})


@require_POST
def alias_reassignment(request: HttpRequest, alias_id: str) -> JsonResponse:
    try:
        body = _body(request, {"customer_id"}, {"note"})
        customer_id = _opaque_id(body["customer_id"])
        note = body.get("note", "")
        if not isinstance(note, str):
            raise CustomerError("invalid_identity_note")
        alias = reassign_alias(alias_id, customer_id, note)
    except CustomerError as exc:
        return _error(exc)
    return JsonResponse({"ok": True, "alias": alias_payload(alias)})


@require_POST
def evaluate_customer(request: HttpRequest, customer_id: str) -> JsonResponse:
    try:
        body = _body(request, {"as_of"})
        as_of = _date(body["as_of"])
        metrics, prediction, action = evaluate_silence_followup(customer_id, as_of)
    except CustomerError as exc:
        return _error(exc)
    return JsonResponse({
        "ok": True,
        "metrics": [metric_payload(row) for row in metrics],
        "prediction": prediction_payload(prediction),
        "action": action_payload(action) if action is not None else None,
    })


@require_POST
def action_decision(request: HttpRequest, action_id: str) -> JsonResponse:
    try:
        body = _body(request, {"decision"}, {"note"})
        decision = body["decision"]
        note = body.get("note", "")
        if not isinstance(decision, str) or not isinstance(note, str):
            raise CustomerError("invalid_action_decision")
        action = decide_action(action_id, decision, note)
    except CustomerError as exc:
        return _error(exc)
    return JsonResponse({"ok": True, "action": action_payload(action)})
