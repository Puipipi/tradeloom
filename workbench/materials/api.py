from __future__ import annotations

import re
from typing import Any

from django.conf import settings
from django.http import HttpRequest, JsonResponse
from django.views.decorators.http import require_GET, require_POST

from workbench.intake.api import _error, _json_object

from .catalog import CATALOG_DISCLAIMER, CATALOG_SOURCE, CATALOG_VERSION, MaterialItem, material_items
from .resolver import normalize_reference
from .rules import BLOCKING, MaterialIssue, evaluate_lines

MAX_QUERY_CHARS = 80
MAX_LINES = 50
MAX_REF_CHARS = 200
MAX_TEXT_CHARS = 500
MAX_UNIT_CHARS = 64
MAX_REFERENCE_CHARS = 140
_MAX_LIMIT = 50


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
    items = material_items()
    return JsonResponse({
        "ok": True,
        "source": CATALOG_SOURCE,
        "version": CATALOG_VERSION,
        "item_count": len(items),
        "disabled_count": sum(1 for item in items if item.disabled),
        "erpnext_configured": _erpnext_configured(),
        "disclaimer": CATALOG_DISCLAIMER,
    })


@require_GET
def items(request: HttpRequest) -> JsonResponse:
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
    for item in material_items():
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


__all__ = ["check", "items", "status"]
