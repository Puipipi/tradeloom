from __future__ import annotations

import json
import re
from typing import Any

from django.conf import settings
from django.http import HttpRequest, JsonResponse
from django.views.decorators.http import require_GET

from .client import ErpNextClient, ErpNextConfig, ErpNextError
from .dto import ErpNextPage, ErpNextRecord
from .service import SUPPORTED_DOCTYPES


_FILTER_FIELDS = {"doctype", "fields", "filters", "limit", "offset"}
_DETAIL_FIELDS = {"doctype", "name"}
_INTEGER = re.compile(r"(?:0|[1-9][0-9]*)\Z")
_ERROR_STATUSES = {
    "not_found": 404,
    "invalid_arguments": 422,
    "not_configured": 503,
    "invalid_configuration": 503,
    "unavailable": 503,
    "rate_limited": 503,
    "unauthorized": 502,
    "forbidden": 502,
    "http_error": 502,
    "invalid_response": 502,
}


def _client_from_settings() -> ErpNextClient | None:
    values = (
        getattr(settings, "TRADELOOM_ERPNEXT_BASE_URL", ""),
        getattr(settings, "TRADELOOM_ERPNEXT_INSTANCE_ID", ""),
        getattr(settings, "TRADELOOM_ERPNEXT_API_KEY", ""),
        getattr(settings, "TRADELOOM_ERPNEXT_API_SECRET", ""),
    )
    if not any(values):
        return None
    if any(not isinstance(value, str) or not value.strip() for value in values):
        raise ErpNextError("invalid_configuration", "ERPNext 配置不完整")
    try:
        config = ErpNextConfig(
            base_url=values[0], instance_id=values[1], api_key=values[2], api_secret=values[3],
        )
    except ValueError:
        raise ErpNextError("invalid_configuration", "ERPNext 配置无效") from None
    return ErpNextClient(config)


def _error(code: str, detail: str, status: int | None = None) -> JsonResponse:
    return JsonResponse(
        {"ok": False, "error_code": code, "detail": detail},
        status=status if status is not None else _ERROR_STATUSES.get(code, 502),
    )


def _query(request: HttpRequest, allowed: set[str]) -> dict[str, str]:
    if set(request.GET.keys()) - allowed:
        raise ValueError("查询参数无效")
    values: dict[str, str] = {}
    for key in allowed:
        items = request.GET.getlist(key)
        if len(items) > 1:
            raise ValueError("查询参数无效")
        if items:
            values[key] = items[0]
    return values


def _required_doctype(values: dict[str, str]) -> str:
    doctype = values.get("doctype", "")
    if doctype not in SUPPORTED_DOCTYPES:
        raise ValueError("不支持的 ERPNext DocType")
    return doctype


def _integer(values: dict[str, str], key: str, default: int) -> int:
    raw = values.get(key)
    if raw is None:
        return default
    if not _INTEGER.fullmatch(raw):
        raise ValueError("分页参数无效")
    return int(raw)


def _filters(values: dict[str, str]) -> dict[str, Any] | None:
    raw = values.get("filters")
    if raw is None:
        return None
    try:
        parsed = json.loads(raw)
    except json.JSONDecodeError:
        raise ValueError("filters 必须是 JSON 对象") from None
    if not isinstance(parsed, dict):
        raise ValueError("filters 必须是 JSON 对象")
    return parsed


def _record_payload(record: ErpNextRecord) -> dict[str, Any]:
    return {"doctype": record.doctype, "data": record.data, "external_ref": record.external_ref}


def _page_payload(page: ErpNextPage) -> dict[str, Any]:
    return {
        "doctype": page.doctype,
        "records": [_record_payload(record) for record in page.records],
        "next_offset": page.next_offset,
    }


@require_GET
def status(_request: HttpRequest) -> JsonResponse:
    try:
        client = _client_from_settings()
    except ErpNextError as exc:
        return JsonResponse({
            "configured": False, "connected": False,
            "status": "invalid_configuration", "error_code": exc.code,
        })
    if client is None:
        return JsonResponse({
            "configured": False, "connected": False,
            "status": "not_configured", "error_code": "",
        })
    try:
        connected = client.check_connection()
    except ErpNextError as exc:
        return JsonResponse({
            "configured": True, "connected": False,
            "status": "unavailable", "error_code": exc.code,
        })
    if not connected:
        return JsonResponse({
            "configured": True, "connected": False,
            "status": "unavailable", "error_code": "unavailable",
        })
    return JsonResponse({
        "configured": True, "connected": True,
        "status": "connected", "error_code": "",
    })


@require_GET
def records(request: HttpRequest) -> JsonResponse:
    try:
        values = _query(request, _FILTER_FIELDS)
        doctype = _required_doctype(values)
        fields_value = values.get("fields")
        fields = None
        if fields_value is not None:
            fields = fields_value.split(",")
            if not fields or any(not field.strip() for field in fields):
                raise ValueError("fields 参数无效")
            fields = [field.strip() for field in fields]
        filters = _filters(values)
        limit = _integer(values, "limit", 20)
        offset = _integer(values, "offset", 0)
    except ValueError:
        return _error("invalid_arguments", "ERPNext 查询参数无效", 422)
    try:
        client = _client_from_settings()
        if client is None:
            raise ErpNextError("not_configured", "ERPNext 尚未配置")
        return JsonResponse(_page_payload(client.list_records(
            doctype, fields=fields, filters=filters, limit=limit, offset=offset,
        )))
    except ErpNextError as exc:
        return _error(exc.code, str(exc))
    except ValueError:
        return _error("invalid_arguments", "ERPNext 查询参数无效", 422)


@require_GET
def record(request: HttpRequest) -> JsonResponse:
    try:
        values = _query(request, _DETAIL_FIELDS)
        doctype = _required_doctype(values)
        name = values.get("name", "")
        if not name:
            raise ValueError("name 参数无效")
    except ValueError:
        return _error("invalid_arguments", "ERPNext 查询参数无效", 422)
    try:
        client = _client_from_settings()
        if client is None:
            raise ErpNextError("not_configured", "ERPNext 尚未配置")
        return JsonResponse(_record_payload(client.get_record(doctype, name)))
    except ErpNextError as exc:
        return _error(exc.code, str(exc))
    except ValueError:
        return _error("invalid_arguments", "ERPNext 查询参数无效", 422)
