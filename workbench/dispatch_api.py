from __future__ import annotations

import hashlib
import json
from datetime import datetime

from django.db import IntegrityError, transaction
from django.http import HttpRequest, JsonResponse
from django.utils import timezone
from django.views.decorators.csrf import csrf_exempt
from django.views.decorators.http import require_POST

from .api import _native_bridge_authorized, _parse_standard_json
from .models import BusinessDispatch


_ACTOR_FIELDS = {"agent_id", "session_id", "agent_preset"}
_SUPPORTED_PRESETS = {"tradeloom-center", "tradeloom-product", "tradeloom-delivery"}
_MAX_PAGE = 100


def _error(code: str, status: int) -> JsonResponse:
    return JsonResponse({"code": code}, status=status)


def _valid_actor(value) -> bool:
    return (
        isinstance(value, dict)
        and set(value) == _ACTOR_FIELDS
        and all(isinstance(value.get(key), str) and 1 <= len(value[key]) <= limit
                and value[key].strip() == value[key]
                for key, limit in (("agent_id", 256), ("session_id", 256), ("agent_preset", 80)))
        and value["agent_preset"] in _SUPPORTED_PRESETS
    )


def _same_actor(dispatch: BusinessDispatch, actor: dict, side: str) -> bool:
    return (
        getattr(dispatch, f"{side}_agent_id") == actor["agent_id"]
        and getattr(dispatch, f"{side}_session_id") == actor["session_id"]
        and getattr(dispatch, f"{side}_preset") == actor["agent_preset"]
    )


def _fingerprint(value: dict) -> str:
    encoded = json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(encoded.encode("utf-8")).hexdigest()


def _project(dispatch: BusinessDispatch) -> dict:
    return {
        "id": dispatch.id,
        "kind": dispatch.kind,
        "status": dispatch.status,
        "sender": {
            "agent_id": dispatch.sender_agent_id,
            "session_id": dispatch.sender_session_id,
            "agent_preset": dispatch.sender_preset,
        },
        "recipient": {
            "agent_id": dispatch.recipient_agent_id,
            "session_id": dispatch.recipient_session_id,
            "agent_preset": dispatch.recipient_preset,
        },
        "source": dispatch.source,
        "requirement": dispatch.requirement,
        "delivery_result": dispatch.delivery_result,
        "receipt": dispatch.receipt,
        "created_at": dispatch.created_at.isoformat(),
        "updated_at": dispatch.updated_at.isoformat(),
        "claimed_at": dispatch.claimed_at.isoformat() if dispatch.claimed_at else None,
        "closed_at": dispatch.closed_at.isoformat() if dispatch.closed_at else None,
    }


def _parse(request: HttpRequest):
    if not _native_bridge_authorized(request):
        return None, _error("native_bridge_forbidden", 403)
    body, invalid = _parse_standard_json(request)
    return (None, invalid) if invalid else (body, None)


def _existing_or_conflict(actor: dict, key: str, fingerprint: str):
    existing = BusinessDispatch.objects.filter(
        sender_session_id=actor["session_id"],
        idempotency_key=key,
    ).first()
    if existing is None:
        return None, None
    if not _same_actor(existing, actor, "sender"):
        return existing, _error("dispatch_sender_conflict", 403)
    if existing.request_fingerprint != fingerprint:
        return existing, _error("idempotency_conflict", 409)
    return existing, JsonResponse({"dispatch": _project(existing), "replayed": True}, status=200)


@csrf_exempt
@require_POST
def create_dispatch(request: HttpRequest) -> JsonResponse:
    body, invalid = _parse(request)
    if invalid:
        return invalid
    allowed = {"actor", "idempotency_key", "kind", "recipient", "source", "requirement"}
    if not isinstance(body, dict) or set(body) != allowed:
        return _error("invalid_request", 422)
    actor = body["actor"]
    recipient = body["recipient"]
    key = body["idempotency_key"]
    kind = body["kind"]
    source = body["source"]
    requirement = body["requirement"]
    if not _valid_actor(actor) or not _valid_actor(recipient):
        return _error("invalid_actor", 422)
    if (not isinstance(key, str) or not 1 <= len(key) <= 200 or key.strip() != key
        or kind not in BusinessDispatch.Kind.values
        or not isinstance(source, str) or not 1 <= len(source) <= 200 or source.strip() != source
        or not isinstance(requirement, str) or not 1 <= len(requirement) <= 4000 or requirement.strip() != requirement):
        return _error("invalid_request", 422)
    request_data = {
        "kind": kind,
        "recipient": recipient,
        "source": source,
        "requirement": requirement,
    }
    fingerprint = _fingerprint(request_data)
    existing, response = _existing_or_conflict(actor, key, fingerprint)
    if existing is not None:
        return response

    try:
        with transaction.atomic():
            with transaction.atomic():
                dispatch = BusinessDispatch.objects.create(
                    kind=kind,
                    status=BusinessDispatch.Status.QUEUED,
                    sender_session_id=actor["session_id"],
                    sender_agent_id=actor["agent_id"],
                    sender_preset=actor["agent_preset"],
                    recipient_session_id=recipient["session_id"],
                    recipient_agent_id=recipient["agent_id"],
                    recipient_preset=recipient["agent_preset"],
                    source=source,
                    requirement=requirement,
                    idempotency_key=key,
                    request_fingerprint=fingerprint,
                    delivery_result={"state": "queued"},
                )
    except IntegrityError:
        existing, response = _existing_or_conflict(actor, key, fingerprint)
        if existing is not None:
            return response
        return _error("dispatch_store_conflict", 409)
    return JsonResponse({"dispatch": _project(dispatch), "replayed": False}, status=202)


@csrf_exempt
@require_POST
def list_dispatches(request: HttpRequest) -> JsonResponse:
    body, invalid = _parse(request)
    if invalid:
        return invalid
    if (not isinstance(body, dict) or set(body) - {"actor", "view", "offset"}
        or not {"actor", "view"}.issubset(body) or not _valid_actor(body.get("actor"))):
        return _error("invalid_request", 422)
    actor = body["actor"]
    view = body["view"]
    offset = body.get("offset", 0)
    if not isinstance(offset, int) or isinstance(offset, bool) or not 0 <= offset <= 1_000_000:
        return _error("invalid_request", 422)
    if view == "inbox":
        records = BusinessDispatch.objects.filter(
            recipient_session_id=actor["session_id"],
            recipient_agent_id=actor["agent_id"],
            recipient_preset=actor["agent_preset"],
            status__in=[BusinessDispatch.Status.QUEUED, BusinessDispatch.Status.CLAIMED],
        )
    elif view == "outbox":
        records = BusinessDispatch.objects.filter(
            sender_session_id=actor["session_id"],
            sender_agent_id=actor["agent_id"],
            sender_preset=actor["agent_preset"],
        )
    else:
        return _error("invalid_request", 422)
    records = list(records[offset:offset + _MAX_PAGE + 1])
    has_more = len(records) > _MAX_PAGE
    return JsonResponse({"view": view, "items": [_project(item) for item in records[:_MAX_PAGE]],
                         "has_more": has_more, "next_offset": offset + _MAX_PAGE if has_more else None})


@csrf_exempt
@require_POST
def claim_dispatch(request: HttpRequest, dispatch_id: str) -> JsonResponse:
    body, invalid = _parse(request)
    if invalid:
        return invalid
    if not isinstance(body, dict) or set(body) != {"actor"} or not _valid_actor(body.get("actor")):
        return _error("invalid_request", 422)
    if len(dispatch_id) != 32 or any(character not in "0123456789abcdef" for character in dispatch_id):
        return _error("dispatch_not_found", 404)
    actor = body["actor"]
    try:
        with transaction.atomic():
            dispatch = BusinessDispatch.objects.select_for_update().filter(pk=dispatch_id).first()
            if dispatch is None:
                return _error("dispatch_not_found", 404)
            if not _same_actor(dispatch, actor, "recipient"):
                return _error("dispatch_recipient_forbidden", 403)
            if dispatch.kind == BusinessDispatch.Kind.NOTIFICATION:
                if dispatch.status == BusinessDispatch.Status.ACKNOWLEDGED:
                    return JsonResponse({"result": "already_acknowledged", "dispatch": _project(dispatch), "replayed": True})
                if dispatch.status != BusinessDispatch.Status.QUEUED:
                    return _error("dispatch_closed", 409)
                now = timezone.now()
                dispatch.status = BusinessDispatch.Status.ACKNOWLEDGED
                dispatch.claimed_at = now
                dispatch.closed_at = now
                dispatch.delivery_result = {"state": "acknowledged"}
                dispatch.receipt = {"status": "acknowledged", "result": "Received"}
                dispatch.receipt_fingerprint = _fingerprint(dispatch.receipt)
                dispatch.save(update_fields=["status", "claimed_at", "closed_at", "delivery_result", "receipt", "receipt_fingerprint", "updated_at"])
                return JsonResponse({"result": "acknowledged", "dispatch": _project(dispatch), "replayed": False})
            if dispatch.kind != BusinessDispatch.Kind.ACTION:
                return _error("dispatch_invalid_kind", 409)
            if dispatch.status == BusinessDispatch.Status.CLAIMED:
                return JsonResponse({"result": "already_claimed", "dispatch": _project(dispatch), "replayed": True})
            if dispatch.status != BusinessDispatch.Status.QUEUED:
                return _error("dispatch_closed", 409)
            if BusinessDispatch.objects.filter(
                recipient_session_id=dispatch.recipient_session_id,
                kind=BusinessDispatch.Kind.ACTION,
                status=BusinessDispatch.Status.CLAIMED,
            ).exclude(pk=dispatch.pk).exists():
                return JsonResponse({"result": "busy", "dispatch": _project(dispatch), "replayed": False})
            dispatch.status = BusinessDispatch.Status.CLAIMED
            dispatch.claimed_at = timezone.now()
            dispatch.delivery_result = {"state": "claimed"}
            try:
                with transaction.atomic():
                    dispatch.save(update_fields=["status", "claimed_at", "delivery_result", "updated_at"])
            except IntegrityError:
                return JsonResponse({"result": "busy", "dispatch": _project(BusinessDispatch.objects.get(pk=dispatch.pk)), "replayed": False})
            return JsonResponse({"result": "claimed", "dispatch": _project(dispatch), "replayed": False})
    except IntegrityError:
        return _error("dispatch_store_conflict", 409)


@csrf_exempt
@require_POST
def receipt_dispatch(request: HttpRequest, dispatch_id: str) -> JsonResponse:
    body, invalid = _parse(request)
    if invalid:
        return invalid
    if (not isinstance(body, dict) or set(body) != {"actor", "status", "result"}
        or not _valid_actor(body.get("actor"))):
        return _error("invalid_request", 422)
    if len(dispatch_id) != 32 or any(character not in "0123456789abcdef" for character in dispatch_id):
        return _error("dispatch_not_found", 404)
    actor = body["actor"]
    status = body["status"]
    result = body["result"]
    if not isinstance(status, str) or status not in {BusinessDispatch.Status.COMPLETED, BusinessDispatch.Status.FAILED}:
        return _error("invalid_receipt", 422)
    if not isinstance(result, str) or not result or len(result) > 2000 or result.strip() != result:
        return _error("invalid_receipt", 422)
    receipt = {"status": status, "result": result}
    fingerprint = _fingerprint(receipt)
    with transaction.atomic():
        dispatch = BusinessDispatch.objects.select_for_update().filter(pk=dispatch_id).first()
        if dispatch is None:
            return _error("dispatch_not_found", 404)
        if not _same_actor(dispatch, actor, "recipient"):
            return _error("dispatch_recipient_forbidden", 403)
        if dispatch.kind != BusinessDispatch.Kind.ACTION:
            return _error("dispatch_kind_conflict", 409)
        if dispatch.status in {BusinessDispatch.Status.COMPLETED, BusinessDispatch.Status.FAILED}:
            if dispatch.receipt_fingerprint == fingerprint:
                return JsonResponse({"dispatch": _project(dispatch), "replayed": True})
            return _error("receipt_conflict", 409)
        if dispatch.status != BusinessDispatch.Status.CLAIMED:
            return _error("dispatch_not_claimed", 409)
        dispatch.status = status
        dispatch.receipt = receipt
        dispatch.receipt_fingerprint = fingerprint
        dispatch.closed_at = timezone.now()
        dispatch.delivery_result = {"state": status}
        dispatch.save(update_fields=["status", "receipt", "receipt_fingerprint", "closed_at", "delivery_result", "updated_at"])
        return JsonResponse({"dispatch": _project(dispatch), "replayed": False})
