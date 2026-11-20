from __future__ import annotations

import re
from typing import Any

from django.conf import settings
from django.http import HttpRequest, JsonResponse
from django.views.decorators.http import require_GET, require_http_methods, require_POST

from workbench.intake.api import _error, _json_object

from .catalog import CATALOG_DISCLAIMER, CATALOG_SOURCE, CATALOG_VERSION, MaterialItem
from .resolver import normalize_reference
from .rules import BLOCKING, MaterialIssue, evaluate_lines
from .intake_apply import MaterialApplyError, apply_material_candidate
from .store import (
    MaterialStoreError,
    create_item,
    load_items,
    update_item,
)

MAX_QUERY_CHARS = 80
MAX_LINES = 50
MAX_REF_CHARS = 200
MAX_TEXT_CHARS = 500
MAX_UNIT_CHARS = 64
MAX_REFERENCE_CHARS = 140
_MAX_LIMIT = 50

_MAINTENANCE_ERROR_STATUS = {"item_exists": 409, "item_not_found": 404}
_APPLY_ERROR_STATUS = {
    "candidate_not_found": 404, "unsupported_candidate_type": 422,
    "missing_field_values": 422, "invalid_material": 422,
    "item_exists": 409, "idempotency_conflict": 409, "unavailable": 503,
}


def _item_summary(item: MaterialItem) -> dict[str, Any]:
    return {
        "item_code": item.item_code,
        "item_name": item.item_name,
        "item_group": item.item_group,
        "stock_uom": item.stock_uom,
        "disabled": item.disabled,
    }


def _erpnext_configured() -> bool:
    names = (
        "TRADELOOM_ERPNEXT_BASE_URL",
        "TRADELOOM_ERPNEXT_INSTANCE_ID",
        "TRADELOOM_ERPNEXT_API_KEY",
        "TRADELOOM_ERPNEXT_API_SECRET",
    )
    values = [getattr(settings, name, "") for name in names]
    return all(isinstance(value, str) and value.strip() for value in values)


@require_GET
def status(request: HttpRequest) -> JsonResponse:
    if request.GET:
        return _error("invalid_arguments")
    items = load_items()
    return JsonResponse({
        "ok": True,
        "source": CATALOG_SOURCE,
        "version": CATALOG_VERSION,
        "item_count": len(items),
        "disabled_count": sum(1 for item in items if item.disabled),
        "erpnext_configured": _erpnext_configured(),
        "disclaimer": CATALOG_DISCLAIMER,
    })


@require_http_methods(["GET", "POST"])
def items(request: HttpRequest) -> JsonResponse:
    if request.method == "POST":
        return _create_item(request)
    if set(request.GET) - {"q", "limit"} or any(len(request.GET.getlist(key)) != 1 for key in request.GET):
        return _error("invalid_arguments")
    query = request.GET.get("q", "")
    if len(query) > MAX_QUERY_CHARS:
        return _error("invalid_arguments")
    raw_limit = request.GET.get("limit", "20")
    if not re.fullmatch(r"(?:0|[1-9][0-9]*)", raw_limit) or not 1 <= int(raw_limit) <= _MAX_LIMIT:
        return _error("invalid_arguments")

    key = normalize_reference(query)
    matched = []
    for item in load_items():
        names = (item.item_code, item.item_name, *item.aliases)
        if not key or any(key in normalize_reference(name) for name in names):
            matched.append(item)
    matched.sort(key=lambda item: item.item_code)
    page = matched[: int(raw_limit)]
    return JsonResponse({
        "ok": True,
        "source": CATALOG_SOURCE,
        "version": CATALOG_VERSION,
        "items": [_item_summary(item) for item in page],
        "total": len(matched),
    })


def _create_item(request: HttpRequest) -> JsonResponse:
    if request.content_type != "application/json":
        return _error("invalid_arguments")
    try:
        body = _json_object(request)
    except ValueError:
        return _error("invalid_arguments")
    if set(body) - {"item_code", "item_name", "item_group", "stock_uom", "aliases"} or \
            not {"item_code", "item_name", "item_group", "stock_uom"}.issubset(body):
        return _error("invalid_arguments")
    try:
        row = create_item(
            item_code=body["item_code"], item_name=body["item_name"], item_group=body["item_group"],
            stock_uom=body["stock_uom"], aliases=body.get("aliases"),
        )
    except MaterialStoreError as exc:
        return JsonResponse({"ok": False, "error_code": exc.code},
                            status=_MAINTENANCE_ERROR_STATUS.get(exc.code, 422))
    return JsonResponse({"ok": True, "item": _store_summary(row)}, status=201)


def _store_summary(row) -> dict[str, Any]:
    return {
        "item_code": row.item_code,
        "item_name": row.item_name,
        "item_group": row.item_group,
        "stock_uom": row.stock_uom,
        "aliases": list(row.aliases or ()),
        "disabled": row.disabled,
        "source": row.source,
    }


@require_POST
def item_update(request: HttpRequest, item_code: str) -> JsonResponse:
    if request.content_type != "application/json" or not item_code or len(item_code) > MAX_REFERENCE_CHARS:
        return _error("invalid_arguments")
    try:
        body = _json_object(request)
    except ValueError:
        return _error("invalid_arguments")
    if not body:
        return _error("invalid_arguments")
    try:
        row = update_item(item_code, patch=body)
    except MaterialStoreError as exc:
        return JsonResponse({"ok": False, "error_code": exc.code},
                            status=_MAINTENANCE_ERROR_STATUS.get(exc.code, 422))
    return JsonResponse({"ok": True, "item": _store_summary(row)})


@require_POST
def apply_material(request: HttpRequest, candidate_id: str) -> JsonResponse:
    try:
        key = _key_from_request(request)
        application, created = apply_material_candidate(candidate_id, key)
        status = 201 if created else 200
        return JsonResponse({"ok": True, **application}, status=status)
    except MaterialApplyError as exc:
        return JsonResponse({"ok": False, "error_code": exc.code},
                            status=_APPLY_ERROR_STATUS.get(exc.code, 422))
    except ValueError as exc:
        if str(exc) == "invalid_idempotency_key":
            return _error("invalid_idempotency_key")
        return _error("invalid_json")
    except Exception:
        return _error("unavailable", 503)


def _key_from_request(request: HttpRequest) -> str:
    from workbench.intake.api import _key
    return _key(request)


def _valid_line(line: Any) -> dict[str, Any] | None:
    if not isinstance(line, dict) or set(line) - {"ref", "item", "description", "quantity", "unit"}:
        return None
    normalized: dict[str, Any] = {}
    ref = line.get("ref")
    if ref is not None:
        if not isinstance(ref, str) or not ref.strip() or len(ref) > MAX_REF_CHARS:
            return None
        normalized["ref"] = ref.strip()
    description = line.get("description")
    if description is not None:
        if not isinstance(description, str) or len(description) > MAX_TEXT_CHARS:
            return None
        normalized["description"] = description
    item = line.get("item")
    if item is not None:
        if (not isinstance(item, dict) or set(item) != {"doctype", "name"}
                or not isinstance(item["name"], str) or len(item["name"]) > MAX_REFERENCE_CHARS):
            return None
        normalized["item"] = {"doctype": item["doctype"], "name": item["name"]}
    quantity = line.get("quantity")
    if quantity is not None and (not isinstance(quantity, str) or len(quantity) > 40):
        return None
    # 数量格式交给核对规则判断，接口只约束类型与长度，便于把 invalid_quantity 作为业务问题返回。
    normalized["quantity"] = quantity
    unit = line.get("unit")
    if unit is not None and (not isinstance(unit, str) or len(unit) > MAX_UNIT_CHARS):
        return None
    normalized["unit"] = unit
    return normalized


@require_POST
def check(request: HttpRequest) -> JsonResponse:
    if request.content_type != "application/json":
        return _error("invalid_arguments")
    try:
        body = _json_object(request)
    except ValueError:
        return _error("invalid_arguments")
    if set(body) != {"lines"}:
        return _error("invalid_arguments")
    lines = body["lines"]
    if not isinstance(lines, list) or len(lines) > MAX_LINES:
        return _error("invalid_arguments")
    normalized = []
    for line in lines:
        value = _valid_line(line)
        if value is None:
            return _error("invalid_arguments")
        normalized.append(value)

    results = evaluate_lines(normalized)
    issues: list[MaterialIssue] = [issue for result in results for issue in result.issues]
    return JsonResponse({
        "ok": True,
        "source": CATALOG_SOURCE,
        "version": CATALOG_VERSION,
        "disclaimer": CATALOG_DISCLAIMER,
        "lines": [result.to_dict() for result in results],
        "issues": [issue.to_dict() for issue in issues],
        "summary": {
            "checked": len(results),
            "resolved": sum(1 for result in results if result.resolution.status == "resolved"),
            "ambiguous": sum(1 for result in results if result.resolution.status == "ambiguous"),
            "unresolved": sum(1 for result in results if result.resolution.status == "unresolved"),
            "issues": len(issues),
            "blocking": sum(1 for issue in issues if issue.severity == BLOCKING),
        },
    })


__all__ = ["apply_material", "check", "item_update", "items", "status"]
