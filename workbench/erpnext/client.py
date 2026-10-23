from __future__ import annotations

import json
import ipaddress
import logging
import math
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass, field
from typing import Any, Callable
from urllib.parse import urlsplit

from .dto import ErpNextPage, ErpNextRecord
from .service import (
    MAX_PAGE_SIZE,
    SCALAR_FIELDS,
    external_reference,
    normalize_fields,
    normalize_filters,
    normalize_record_data,
    normalize_quotation_payload,
    normalize_quotation_record,
    validate_doctype,
)


@dataclass(frozen=True, repr=False)
class ErpNextConfig:
    base_url: str
    instance_id: str
    api_key: str = field(repr=False)
    api_secret: str = field(repr=False)
    timeout_seconds: float = 10.0

    def __post_init__(self) -> None:
        if not isinstance(self.base_url, str):
            raise ValueError("ERPNext base URL 无效")
        parsed = urlsplit(self.base_url)
        if (
            parsed.scheme not in {"https", "http"}
            or not parsed.hostname
            or parsed.username is not None
            or parsed.password is not None
            or parsed.query
            or parsed.fragment
        ):
            raise ValueError("ERPNext base URL 无效")
        if parsed.scheme == "http":
            hostname = parsed.hostname.lower()
            try:
                loopback = ipaddress.ip_address(hostname).is_loopback
            except ValueError:
                loopback = hostname == "localhost"
            if not loopback:
                raise ValueError("ERPNext base URL 无效")
        if not isinstance(self.instance_id, str) or not self.instance_id.strip() or len(self.instance_id) > 128:
            raise ValueError("ERPNext instance_id 无效")
        if (
            not isinstance(self.api_key, str) or not self.api_key.strip()
            or not isinstance(self.api_secret, str) or not self.api_secret.strip()
            or any(char in self.api_key + self.api_secret for char in "\r\n")
        ):
            raise ValueError("ERPNext API credentials 无效")
        if (
            isinstance(self.timeout_seconds, bool)
            or not isinstance(self.timeout_seconds, (int, float))
            or not math.isfinite(self.timeout_seconds)
            or self.timeout_seconds <= 0
            or self.timeout_seconds > 60
        ):
            raise ValueError("ERPNext timeout 无效")

    def __repr__(self) -> str:
        parsed = urlsplit(self.base_url)
        safe_base = f"{parsed.scheme}://{parsed.netloc}{parsed.path}"
        return (
            f"ErpNextConfig(base_url={safe_base!r}, instance_id={self.instance_id!r}, "
            "api_key=<redacted>, api_secret=<redacted>)"
        )


class ErpNextError(RuntimeError):
    def __init__(self, code: str, message: str, *, remote_name: str = "") -> None:
        self.code = code
        self.remote_name = remote_name if isinstance(remote_name, str) and len(remote_name) <= 255 else ""
        super().__init__(message)


Transport = Callable[[str, str, dict[str, str], bytes | None, float], tuple[int, dict[str, str], bytes]]

_SAFE_403_EXCEPTION_TYPES = frozenset({
    "PermissionError",
    "AuthenticationError",
    "CSRFTokenError",
})


def _urlopen_transport(method: str, url: str, headers: dict[str, str], body: bytes | None, timeout: float):
    request = urllib.request.Request(url, data=body, headers=headers, method=method)
    class RejectRedirectHandler(urllib.request.HTTPRedirectHandler):
        def redirect_request(self, req, fp, code, msg, response_headers, newurl):
            return None

    opener = urllib.request.build_opener(RejectRedirectHandler)
    try:
        with opener.open(request, timeout=timeout) as response:
            return response.status, dict(response.headers.items()), response.read()
    except urllib.error.HTTPError as error:
        try:
            return error.code, dict(error.headers.items()) if error.headers else {}, error.read()
        finally:
            error.close()


class ErpNextClient:
    def __init__(self, config: ErpNextConfig | None, *, transport: Transport | None = None) -> None:
        self._config = config
        self._transport = transport or _urlopen_transport

    @property
    def site_url(self) -> str:
        """A validated, credential-free ERPNext base URL suitable for a user-clicked link."""
        if self._config is None:
            return ""
        parsed = urlsplit(self._config.base_url)
        return urllib.parse.urlunsplit((parsed.scheme, parsed.netloc, parsed.path.rstrip("/"), "", ""))

    @property
    def instance_id(self) -> str | None:
        return self._config.instance_id if self._config is not None else None

    def __repr__(self) -> str:
        if self._config is None:
            return "ErpNextClient(config=not_configured)"
        return f"ErpNextClient(config={self._config!r})"

    def list_records(
        self,
        doctype: str,
        *,
        fields: list[str] | tuple[str, ...] | None = None,
        filters: dict[str, Any] | None = None,
        limit: int = 20,
        offset: int = 0,
    ) -> ErpNextPage:
        validate_doctype(doctype)
        if isinstance(limit, bool) or not isinstance(limit, int) or not 1 <= limit <= MAX_PAGE_SIZE:
            raise ValueError("ERPNext limit 必须是 1 到 100")
        if isinstance(offset, bool) or not isinstance(offset, int) or offset < 0:
            raise ValueError("ERPNext offset 无效")
        selected_fields = normalize_fields(doctype, fields)
        selected_filters = normalize_filters(doctype, filters)
        params = {
            "fields": json.dumps(list(selected_fields), ensure_ascii=False, separators=(",", ":")),
            "limit_start": str(offset),
            "limit_page_length": str(limit),
        }
        if selected_filters:
            params["filters"] = json.dumps(selected_filters, ensure_ascii=False, separators=(",", ":"))
        payload = self._request_json("GET", self._resource_url(doctype), params=params)
        rows = payload.get("data")
        if not isinstance(rows, list):
            raise ErpNextError("invalid_response", "ERPNext 列表响应格式无效")
        records = tuple(
            self._record(doctype, row, fields=frozenset(selected_fields))
            for row in rows
        )
        next_offset = offset + len(records) if len(records) == limit else None
        return ErpNextPage(doctype=doctype, records=records, next_offset=next_offset)

    def get_record(self, doctype: str, name: str) -> ErpNextRecord:
        validate_doctype(doctype)
        if not isinstance(name, str) or not name or len(name) > 256 or "\x00" in name:
            raise ValueError("ERPNext record name 无效")
        encoded_name = urllib.parse.quote(name, safe="")
        payload = self._request_json("GET", f"{self._resource_url(doctype)}/{encoded_name}")
        data = payload.get("data")
        return self._record(doctype, data)

    def create_quotation_draft(self, payload: dict[str, Any]) -> dict[str, Any]:
        if self._config is None:
            raise ErpNextError("not_configured", "ERPNext 尚未配置")
        try:
            normalized = normalize_quotation_payload(payload)
        except ValueError:
            raise ErpNextError("invalid_arguments", "报价草稿内容无效") from None
        remote_payload = {"quotation_to": "Customer", **normalized}
        response = self._request_json(
            "POST", self._quotation_url(), body=json.dumps(
                remote_payload, ensure_ascii=False, separators=(",", ":"), allow_nan=False,
            ).encode("utf-8"),
        )
        try:
            record = normalize_quotation_record(response, self._config.instance_id)
        except ValueError:
            candidate = response.get("data") if isinstance(response, dict) else None
            candidate_name = candidate.get("name", "") if isinstance(candidate, dict) else ""
            safe_name = candidate_name if isinstance(candidate_name, str) and candidate_name and len(candidate_name) <= 255 and not any(ord(ch) < 32 for ch in candidate_name) else ""
            raise ErpNextError("invalid_response", "ERPNext 报价创建响应无效", remote_name=safe_name) from None
        if record["data"].get("docstatus") != 0:
            raise ErpNextError(
                "invalid_response", "ERPNext 报价未保持草稿状态",
                remote_name=record["data"].get("name", ""),
            )
        return record

    def get_quotation_draft(self, name: str) -> dict[str, Any]:
        if self._config is None:
            raise ErpNextError("not_configured", "ERPNext 尚未配置")
        if not isinstance(name, str) or not name or len(name) > 255 or any(ord(ch) < 32 for ch in name):
            raise ValueError("ERPNext quotation name 无效")
        encoded_name = urllib.parse.quote(name, safe="")
        response = self._request_json("GET", self._quotation_url(encoded_name))
        try:
            record = normalize_quotation_record(response, self._config.instance_id)
        except ValueError:
            raise ErpNextError("invalid_response", "ERPNext 报价响应无效") from None
        if record["data"].get("docstatus") != 0 or record["data"].get("name") != name:
            raise ErpNextError("invalid_response", "ERPNext 报价状态或标识无效")
        return record

    def update_quotation_draft(
        self, name: str, payload: dict[str, Any], *, expected_modified: str,
    ) -> dict[str, Any]:
        """Use Frappe's transactional modified check, never a GET-then-write CAS.

        Frappe v16.52.0 update_doc locks the document before applying payload;
        Document.check_if_latest compares the locked modified value with
        _original_modified, which is populated from the incoming ``modified``.
        References: frappe/api/v1.py:update_doc and
        frappe/model/document.py:check_if_latest.
        """
        if self._config is None:
            raise ErpNextError("not_configured", "ERPNext 尚未配置")
        if not isinstance(name, str) or not name or len(name) > 255 or any(ord(ch) < 32 for ch in name):
            raise ValueError("ERPNext quotation name 无效")
        if not isinstance(expected_modified, str) or not expected_modified or len(expected_modified) > 64:
            raise ValueError("ERPNext 预期版本无效")
        try:
            normalized = normalize_quotation_payload(payload)
        except ValueError:
            raise ErpNextError("invalid_arguments", "报价草稿内容无效") from None
        encoded_name = urllib.parse.quote(name, safe="")
        remote_payload = {
            "quotation_to": "Customer",
            "docstatus": 0,
            "modified": expected_modified,
            **normalized,
        }
        response = self._request_json(
            "PUT", self._quotation_url(encoded_name), body=json.dumps(
                remote_payload, ensure_ascii=False, separators=(",", ":"), allow_nan=False,
            ).encode("utf-8"),
        )
        try:
            record = normalize_quotation_record(response, self._config.instance_id)
        except ValueError:
            raise ErpNextError("invalid_response", "ERPNext 报价更新响应无效") from None
        if record["data"].get("docstatus") != 0 or record["data"].get("name") != name:
            raise ErpNextError("invalid_response", "ERPNext 报价状态或标识无效")
        return record

    def check_connection(self) -> bool:
        if self._config is None:
            raise ErpNextError("not_configured", "ERPNext 尚未配置")
        base_url = self._config.base_url.rstrip("/")
        payload = self._request_json("GET", f"{base_url}/api/method/frappe.auth.get_logged_user")
        if not isinstance(payload.get("message"), str) or not payload["message"].strip():
            raise ErpNextError("invalid_response", "ERPNext 连接响应格式无效")
        return True

    def _record(
        self,
        doctype: str,
        payload: Any,
        *,
        fields: frozenset[str] | None = None,
    ) -> ErpNextRecord:
        try:
            data = normalize_record_data(doctype, payload, fields=fields)
        except ValueError:
            raise ErpNextError("invalid_response", "ERPNext 记录响应格式无效") from None
        return ErpNextRecord(
            doctype=doctype,
            data=data,
            external_ref=external_reference(self._config.instance_id, doctype, data),
        )

    def _resource_url(self, doctype: str) -> str:
        validate_doctype(doctype)
        if self._config is None:
            raise ErpNextError("not_configured", "ERPNext 尚未配置")
        base_url = self._config.base_url.rstrip("/")
        encoded_doctype = urllib.parse.quote(doctype, safe="")
        return f"{base_url}/api/resource/{encoded_doctype}"

    def _quotation_url(self, encoded_name: str | None = None) -> str:
        if self._config is None:
            raise ErpNextError("not_configured", "ERPNext 尚未配置")
        path = f"{self._config.base_url.rstrip('/')}/api/resource/Quotation"
        return f"{path}/{encoded_name}" if encoded_name is not None else path

    def _request_json(
        self,
        method: str,
        resource_url: str,
        *,
        params: dict[str, str] | None = None,
        body: bytes | None = None,
    ) -> dict[str, Any]:
        if self._config is None:
            raise ErpNextError("not_configured", "ERPNext 尚未配置")
        url = resource_url
        if params:
            url += "?" + urllib.parse.urlencode(params)
        headers = {
            "Accept": "application/json",
            "Authorization": f"token {self._config.api_key}:{self._config.api_secret}",
        }
        if body is not None:
            headers["Content-Type"] = "application/json"
        try:
            status, response_headers, body = self._transport(
                method, url, headers, body, self._config.timeout_seconds
            )
        except Exception:
            raise ErpNextError("unavailable", "ERPNext 暂时无法访问") from None

        if status == 401:
            raise ErpNextError("unauthorized", "ERPNext 拒绝了认证信息")
        if status == 403:
            content_type = next(
                (value for key, value in response_headers.items() if key.lower() == "content-type"),
                "",
            )
            media_type = content_type.lower().split(";", 1)[0].strip()
            if media_type == "text/html":
                response_format = "html"
            elif media_type == "application/json" or media_type.endswith("+json"):
                response_format = "json"
            else:
                response_format = "other"

            exception_type = "unknown"
            if response_format == "json":
                try:
                    error_payload = json.loads(body.decode("utf-8"))
                except (AttributeError, UnicodeDecodeError, json.JSONDecodeError):
                    error_payload = None
                candidate_type = error_payload.get("exc_type") if isinstance(error_payload, dict) else None
                if isinstance(candidate_type, str) and candidate_type in _SAFE_403_EXCEPTION_TYPES:
                    exception_type = candidate_type

            safe_method = method if method in {"GET", "POST", "PUT"} else "other"
            logging.getLogger(__name__).warning(
                "ERPNext request rejected: status=403 method=%s response_format=%s exception_type=%s",
                safe_method,
                response_format,
                exception_type,
            )
            raise ErpNextError("forbidden", "ERPNext 不允许此操作")
        if status == 404:
            raise ErpNextError("not_found", "ERPNext 记录不存在")
        if status == 429:
            raise ErpNextError("rate_limited", "ERPNext 请求过于频繁")
        if status == 409:
            raise ErpNextError("conflict", "ERPNext 记录与预期状态冲突")
        if status == 417:
            try:
                error_payload = json.loads(body.decode("utf-8"))
            except (AttributeError, UnicodeDecodeError, json.JSONDecodeError):
                error_payload = None
            exception_type = error_payload.get("exc_type") if isinstance(error_payload, dict) else None
            if exception_type is None and isinstance(error_payload, dict):
                errors = error_payload.get("errors")
                if isinstance(errors, list) and errors and isinstance(errors[0], dict):
                    exception_type = errors[0].get("type")
            if exception_type == "TimestampMismatchError":
                raise ErpNextError("conflict", "ERPNext 记录与预期状态冲突")
        if status < 200 or status >= 300:
            raise ErpNextError("http_error", "ERPNext 返回了未映射的 HTTP 状态")

        content_type = next((value for key, value in response_headers.items() if key.lower() == "content-type"), "")
        if content_type.lower().split(";", 1)[0].strip() != "application/json":
            raise ErpNextError("invalid_response", "ERPNext 响应类型无效")
        try:
            payload = json.loads(body.decode("utf-8"))
        except (AttributeError, UnicodeDecodeError, json.JSONDecodeError):
            raise ErpNextError("invalid_response", "ERPNext 响应格式无效") from None
        if not isinstance(payload, dict):
            raise ErpNextError("invalid_response", "ERPNext 响应格式无效")
        return payload
