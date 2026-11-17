from __future__ import annotations

from django.http import HttpRequest, JsonResponse
from django.views.decorators.csrf import csrf_exempt

from .api import _native_bridge_authorized, _parse_standard_json
from .products.restoration import (
    ProductFactRestoreError,
    apply_product_fact_restore,
    preview_product_fact_restore as build_product_fact_restore_preview,
)


def _error(code: str, status: int) -> JsonResponse:
    return JsonResponse({"code": code}, status=status, headers={"Cache-Control": "no-store"})


def _method_not_allowed() -> JsonResponse:
    return _error("method_not_allowed", 405)


@csrf_exempt
def preview(request: HttpRequest, product_id: str) -> JsonResponse:
    if request.method != "POST":
        return _method_not_allowed()
    if not _native_bridge_authorized(request):
        return _error("native_bridge_forbidden", 403)
    body, invalid = _parse_standard_json(request)
    if invalid:
        return JsonResponse({"code": "invalid_request"}, status=422, headers={"Cache-Control": "no-store"})
    if set(body) != {"sourceRevisionId"} or not isinstance(body.get("sourceRevisionId"), str):
        return _error("invalid_request", 422)
    try:
        result = build_product_fact_restore_preview(product_id, body["sourceRevisionId"])
    except ProductFactRestoreError as exc:
        return _error(exc.code, exc.status)
    return JsonResponse(result, headers={"Cache-Control": "no-store"})


@csrf_exempt
def apply(request: HttpRequest, product_id: str) -> JsonResponse:
    if request.method != "POST":
        return _method_not_allowed()
    if not _native_bridge_authorized(request):
        return _error("native_bridge_forbidden", 403)
    body, invalid = _parse_standard_json(request)
    if invalid:
        return JsonResponse({"code": "invalid_request"}, status=422, headers={"Cache-Control": "no-store"})
    required = {
        "sourceRevisionId", "expectedLatestRevisionId", "expectedLiveFingerprint", "previewDigest", "confirm"
    }
    if set(body) != required:
        return _error("invalid_request", 422)
    source_id = body.get("sourceRevisionId")
    latest_id = body.get("expectedLatestRevisionId")
    fingerprint = body.get("expectedLiveFingerprint")
    preview_digest = body.get("previewDigest")
    if (
        not isinstance(source_id, str)
        or (latest_id is not None and not isinstance(latest_id, str))
        or not isinstance(fingerprint, str)
        or not isinstance(preview_digest, str)
        or body.get("confirm") is not True
    ):
        return _error("invalid_request", 422)
    try:
        result = apply_product_fact_restore(
            product_id,
            source_revision_id=source_id,
            expected_latest_revision_id=latest_id,
            expected_live_fingerprint=fingerprint,
            preview_digest=preview_digest,
        )
    except ProductFactRestoreError as exc:
        return _error(exc.code, exc.status)
    return JsonResponse(result, headers={"Cache-Control": "no-store"})
