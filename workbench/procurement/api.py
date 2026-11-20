from __future__ import annotations

import re
from typing import Any

from django.http import HttpRequest, JsonResponse
from django.views.decorators.http import require_GET, require_POST

from workbench.intake.api import _error, _json_object, _key

from .service import (
    DocumentError,
    apply_documents,
    confirm_document,
    list_documents,
)

_DOC_TYPES = ("purchase_plan", "stock_receipt", "shipment_payment")
_CANDIDATE_BY_TYPE = {
    "purchase_plan": "purchase_plan_line",
    "stock_receipt": "stock_receipt_line",
    "shipment_payment": "shipment_payment_line",
}
_ERROR_STATUS = {
    "candidate_not_found": 404, "requirement_not_found": 404,
    "purchase_plan_not_found": 404, "document_not_found": 404,
    "unsupported_candidate_type": 422, "row_shape_mismatch": 422,
    "empty_rows": 422, "invalid_amount": 422, "invalid_currency": 422,
    "invalid_date": 422, "document_blocked": 409, "requirement_required": 422,
    "idempotency_conflict": 409, "unavailable": 503,
}
_OPAQUE_ID = re.compile(r"[a-f0-9]{32}\Z")
_INTEGER = re.compile(r"(?:0|[1-9][0-9]*)\Z")


def _error(code: str, status: int | None = None) -> JsonResponse:
    return JsonResponse({"ok": False, "error_code": code}, status=status or _ERROR_STATUS.get(code, 400))


@require_POST
def apply_documents_view(request: HttpRequest, candidate_id: str) -> JsonResponse:
    try:
        key = _key(request)
        body = _json_object(request)
        if not isinstance(body, dict) or set(body) - {"doc_type", "requirement_id", "purchase_plan_id", "kind"}:
            return _error("invalid_arguments")
        doc_type = body.get("doc_type")
        if doc_type not in _DOC_TYPES:
            return _error("unsupported_candidate_type")
        requirement_id = body.get("requirement_id")
        if requirement_id is not None and (not isinstance(requirement_id, str) or not _OPAQUE_ID.fullmatch(requirement_id)):
            return _error("invalid_arguments")
        purchase_plan_id = body.get("purchase_plan_id")
        if purchase_plan_id is not None and (not isinstance(purchase_plan_id, str) or not _OPAQUE_ID.fullmatch(purchase_plan_id)):
            return _error("invalid_arguments")
        kind = body.get("kind", "shipment")
        if kind not in {"shipment", "payment"}:
            return _error("invalid_arguments")
        result, created = apply_documents(
            candidate_id, key, doc_type=doc_type, requirement_id=requirement_id,
            purchase_plan_id=purchase_plan_id, kind=kind,
        )
        return JsonResponse({"ok": True, **result}, status=201 if created else 200)
    except DocumentError as exc:
        return _error(exc.code)
    except ValueError as exc:
        if str(exc) == "invalid_idempotency_key":
            return _error("invalid_idempotency_key")
        return _error("invalid_json")
    except Exception:
        return _error("unavailable", 503)


@require_POST
def confirm_document_view(request: HttpRequest, doc_type: str, document_id: str) -> JsonResponse:
    if doc_type not in _DOC_TYPES or not _OPAQUE_ID.fullmatch(document_id or ""):
        return _error("invalid_arguments")
    try:
        result = confirm_document(doc_type, document_id)
        return JsonResponse({"ok": True, **result})
    except DocumentError as exc:
        return _error(exc.code)
    except Exception:
        return _error("unavailable", 503)


@require_GET
def list_documents_view(request: HttpRequest, doc_type: str) -> JsonResponse:
    if doc_type not in _DOC_TYPES or set(request.GET) - {"limit"}:
        return _error("invalid_arguments")
    raw_limit = request.GET.get("limit", "50")
    if not _INTEGER.fullmatch(raw_limit) or not 1 <= int(raw_limit) <= 200:
        return _error("invalid_arguments")
    return JsonResponse(list_documents(doc_type, limit=int(raw_limit)))


__all__ = ["apply_documents_view", "confirm_document_view", "list_documents_view"]
