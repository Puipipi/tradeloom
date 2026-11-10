from __future__ import annotations

import json
import re
from typing import Any

from django.conf import settings
from django.http import HttpRequest, JsonResponse
from django.views.decorators.http import require_GET, require_http_methods, require_POST
from workbench.models import ErpNextDraftOperation

from .client import ErpNextClient, ErpNextConfig, ErpNextError
from .dto import ErpNextPage, ErpNextRecord
from .service import SUPPORTED_DOCTYPES
from .drafts import (
    DraftOperationError,
    create_quotation_draft,
    get_quotation_draft_operation,
    update_quotation_draft,
)


_FILTER_FIELDS = {"doctype", "fields", "filters", "limit", "offset"}
_DETAIL_FIELDS = {"doctype", "name"}
_INTEGER = re.compile(r"(?:0|[1-9][0-9]*)\Z")
_ERROR_STATUSES = {
    "not_found": 404,
    "invalid_arguments": 422,
    "idempotency_conflict": 409,
    "conflict": 409,
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
            "status": "invalid_configuration", "error_code": exc.code, "site_url": "",
        })
    if client is None:
        return JsonResponse({
            "configured": False, "connected": False,
            "status": "not_configured", "error_code": "", "site_url": "",
        })
    try:
        connected = client.check_connection()
    except ErpNextError as exc:
        return JsonResponse({
            "configured": True, "connected": False,
            "status": "unavailable", "error_code": exc.code, "site_url": client.site_url,
        })
    if not connected:
        return JsonResponse({
            "configured": True, "connected": False,
            "status": "unavailable", "error_code": "unavailable", "site_url": client.site_url,
        })
    return JsonResponse({
        "configured": True, "connected": True,
        "status": "connected", "error_code": "", "site_url": client.site_url,
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


def _draft_operation_payload(result) -> dict[str, Any]:
    operation = result.operation
    return {
        "ok": operation.status != ErpNextDraftOperation.Status.CONFLICT,
        "operation_id": operation.id,
        "action": operation.action,
        "doctype": "Quotation",
        "status": operation.status,
        "source": operation.source,
        "workflow_id": operation.workflow_id,
        "target_operation_id": operation.target_operation_id,
        "remote_name": operation.remote_name or None,
        "remote_modified": operation.remote_modified or None,
        "payload_sha256": operation.payload_sha256,
        "error_code": operation.error_code,
        "receipt": operation.receipt,
        "remote_current": result.remote_current,
        "remote_error_code": result.remote_error,
    }


def _strict_json_object(request: HttpRequest) -> dict[str, Any]:
    if request.content_type != "application/json":
        raise ValueError("请求类型无效")
    if len(request.body) > 65536:
        raise ValueError("请求内容过大")

    def unique_pairs(pairs):
        value = {}
        for key, item in pairs:
            if key in value:
                raise ValueError("JSON 字段重复")
            value[key] = item
        return value

    try:
        parsed = json.loads(request.body.decode("utf-8"), object_pairs_hook=unique_pairs)
    except (UnicodeDecodeError, json.JSONDecodeError, ValueError):
        raise ValueError("请求内容格式无效") from None
    if not isinstance(parsed, dict):
        raise ValueError("请求内容格式无效")
    return parsed


@require_POST
def quotation_drafts(request: HttpRequest) -> JsonResponse:
    try:
        body = _strict_json_object(request)
        if set(body) - {"idempotency_key", "payload", "workflow_id"}:
            raise ValueError("请求字段无效")
        if "idempotency_key" not in body or "payload" not in body:
            raise ValueError("请求字段缺失")
    except ValueError:
        return _error("invalid_arguments", "报价草稿请求无效", 422)

    try:
        client = _client_from_settings()
        if client is None:
            raise ErpNextError("not_configured", "ERPNext 尚未配置")
        result = create_quotation_draft(
            client,
            idempotency_key=body["idempotency_key"],
            payload=body["payload"],
            workflow_id=body.get("workflow_id"),
        )
        if result.operation.status == ErpNextDraftOperation.Status.SUCCEEDED:
            status_code = 201 if result.created else 200
        else:
            status_code = 202
        return JsonResponse(_draft_operation_payload(result), status=status_code)
    except DraftOperationError as exc:
        return _error(exc.code, str(exc), exc.status)
    except ErpNextError as exc:
        return _error(exc.code, str(exc))


@require_http_methods(["GET", "PUT"])
def quotation_draft_operation(request: HttpRequest, operation_id: str) -> JsonResponse:
    if request.method == "PUT":
        try:
            body = _strict_json_object(request)
            if set(body) - {"idempotency_key", "expected_modified", "payload", "workflow_id"}:
                raise ValueError("请求字段无效")
            if not {"idempotency_key", "expected_modified", "payload"} <= set(body):
                raise ValueError("请求字段缺失")
        except ValueError:
            return _error("invalid_arguments", "报价草稿更新请求无效", 422)
        try:
            client = _client_from_settings()
            if client is None:
                raise ErpNextError("not_configured", "ERPNext 尚未配置")
            result = update_quotation_draft(
                client,
                target_operation_id=operation_id,
                idempotency_key=body["idempotency_key"],
                expected_modified=body["expected_modified"],
                payload=body["payload"],
                workflow_id=body.get("workflow_id"),
            )
            status_code = {
                ErpNextDraftOperation.Status.SUCCEEDED: 200,
                ErpNextDraftOperation.Status.CONFLICT: 409,
            }.get(result.operation.status, 202)
            return JsonResponse(_draft_operation_payload(result), status=status_code)
        except DraftOperationError as exc:
            return _error(exc.code, str(exc), exc.status)
        except ErpNextError as exc:
            return _error(exc.code, str(exc))

    try:
        client = _client_from_settings()
    except ErpNextError:
        client = None
    try:
        result = get_quotation_draft_operation(client, operation_id)
        return JsonResponse(_draft_operation_payload(result))
    except DraftOperationError as exc:
        return _error(exc.code, str(exc), exc.status)
