from __future__ import annotations

import json
import ipaddress
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
    def __init__(self, code: str, message: str) -> None:
        self.code = code
        super().__init__(message)


Transport = Callable[[str, str, dict[str, str], bytes | None, float], tuple[int, dict[str, str], bytes]]


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

    def _request_json(self, method: str, resource_url: str, *, params: dict[str, str] | None = None) -> dict[str, Any]:
        if self._config is None:
            raise ErpNextError("not_configured", "ERPNext 尚未配置")
        url = resource_url
        if params:
            url += "?" + urllib.parse.urlencode(params)
        headers = {
            "Accept": "application/json",
            "Authorization": f"token {self._config.api_key}:{self._config.api_secret}",
        }
        try:
            status, response_headers, body = self._transport(
                method, url, headers, None, self._config.timeout_seconds
            )
        except Exception:
            raise ErpNextError("unavailable", "ERPNext 暂时无法访问") from None

        if status == 401:
            raise ErpNextError("unauthorized", "ERPNext 拒绝了认证信息")
        if status == 403:
            raise ErpNextError("forbidden", "ERPNext 不允许读取此资源")
        if status == 404:
            raise ErpNextError("not_found", "ERPNext 记录不存在")
        if status == 429:
            raise ErpNextError("rate_limited", "ERPNext 请求过于频繁")
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
