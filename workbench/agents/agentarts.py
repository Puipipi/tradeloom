from __future__ import annotations

import json
import re
from urllib.parse import urlsplit
from typing import Any


_NAME_PATTERN = re.compile(r"[A-Za-z0-9_-]{1,64}\Z")


class AgentArtsResponseError(ValueError):
    """A safe, fixed-summary error for an unmapped AgentArts response."""

    def __init__(self, code: str, summary: str) -> None:
        self.code = code
        super().__init__(summary)


class AgentArtsAdapter:
    """Build and map the documented low-code Runtime envelope without I/O."""

    def __init__(
        self,
        endpoint: str,
        runtime_name: str,
        session_id: str,
        authorization: str,
    ) -> None:
        if not isinstance(endpoint, str):
            raise ValueError("AgentArts endpoint 无效")
        parsed = urlsplit(endpoint)
        if (
            parsed.scheme != "https"
            or not parsed.hostname
            or parsed.username is not None
            or parsed.password is not None
            or parsed.query
            or parsed.fragment
        ):
            raise ValueError("AgentArts endpoint 无效")
        if not isinstance(runtime_name, str) or not _NAME_PATTERN.fullmatch(runtime_name):
            raise ValueError("AgentArts runtime_name 无效")
        if not isinstance(session_id, str) or not _NAME_PATTERN.fullmatch(session_id):
            raise ValueError("AgentArts session_id 无效")
        if (
            not isinstance(authorization, str)
            or not authorization.strip()
            or "\r" in authorization
            or "\n" in authorization
        ):
            raise ValueError("AgentArts authorization 无效")

        self._endpoint = endpoint.rstrip("/")
        self._runtime_name = runtime_name
        self._session_id = session_id
        self._authorization = authorization

    def __repr__(self) -> str:
        return (
            f"{type(self).__name__}(endpoint={self._endpoint!r}, "
            f"runtime_name={self._runtime_name!r}, session_id={self._session_id!r}, "
            "authorization=<redacted>)"
        )

    @staticmethod
    def health_check() -> dict[str, str]:
        """Configuration is not evidence of a live account or deployment."""
        return {
            "agentarts": "not_configured",
            "evidence": "documented_not_connected",
            "adapter": "offline_adapter",
        }

    def build_request(
        self,
        body: dict[str, Any],
        *,
        invoke_mode: str = "published",
    ) -> dict[str, Any]:
        """Return an invocation envelope; the caller supplies agent/workflow keys."""
        if not isinstance(body, dict):
            raise ValueError("AgentArts 请求体必须是 JSON 对象")
        if set(body) - {"query", "inputs", "plugin_configs"}:
            raise ValueError("AgentArts 请求体包含不支持的字段")
        if invoke_mode not in {"debug", "published"}:
            raise ValueError("AgentArts invoke_mode 无效")
        has_query = "query" in body
        has_inputs = "inputs" in body
        if has_query == has_inputs:
            raise ValueError("AgentArts 请求体必须只包含 query 或 inputs")
        if has_query and (not isinstance(body["query"], str) or not body["query"].strip()):
            raise ValueError("AgentArts query 必须是非空字符串")
        if has_inputs and not isinstance(body["inputs"], dict):
            raise ValueError("AgentArts inputs 必须是 JSON 对象")
        if "plugin_configs" in body:
            plugin_configs = body["plugin_configs"]
            if not has_inputs or not isinstance(plugin_configs, list) or any(
                not isinstance(plugin, dict)
                or set(plugin) - {"plugin_id", "config"}
                or ("plugin_id" in plugin and not isinstance(plugin["plugin_id"], str))
                or (
                    "config" in plugin
                    and (
                        not isinstance(plugin["config"], dict)
                        or any(
                            not isinstance(key, str) or not isinstance(value, str)
                            for key, value in plugin["config"].items()
                        )
                    )
                )
                for plugin in plugin_configs
            ):
                raise ValueError("AgentArts plugin_configs 格式无效")
        try:
            json.dumps(body, ensure_ascii=False, allow_nan=False)
        except (TypeError, ValueError):
            raise ValueError("AgentArts 请求体必须是 JSON 对象") from None

        return {
            "method": "POST",
            "url": f"{self._endpoint}/runtimes/{self._runtime_name}/invocations",
            "headers": {
                "Authorization": self._authorization,
                "X-Invoke-Mode": invoke_mode,
                "x-hw-agentarts-session-id": self._session_id,
                "Content-Type": "application/json",
            },
            "body": body,
        }

    @staticmethod
    def map_response(
        status_code: int,
        body: Any,
        *,
        content_type: str = "application/json",
    ) -> dict[str, Any]:
        """Map the documented JSON response; returned remote text remains untrusted."""
        if status_code == 401:
            raise AgentArtsResponseError("unauthorized", "AgentArts 拒绝了认证信息")
        if status_code == 404:
            raise AgentArtsResponseError("runtime_not_found", "AgentArts Runtime 不存在或不可用")
        if status_code == 500:
            raise AgentArtsResponseError("remote_error", "AgentArts Runtime 执行失败")
        if status_code != 200:
            raise AgentArtsResponseError("http_error", "AgentArts Runtime 返回了未映射的 HTTP 状态")

        media_type = content_type.lower().split(";", 1)[0].strip() if isinstance(content_type, str) else ""
        if media_type != "application/json":
            raise AgentArtsResponseError("unsupported_response", "AgentArts 响应类型尚未支持")
        if not isinstance(body, dict):
            raise AgentArtsResponseError("invalid_response", "AgentArts Runtime 响应格式无效")

        event = body.get("event")
        data = body.get("data")
        created_time = body.get("createdTime")
        if (
            not isinstance(event, str)
            or not isinstance(data, dict)
            or isinstance(created_time, bool)
            or not isinstance(created_time, int)
            or "text" not in data
            or (data["text"] is not None and not isinstance(data["text"], str))
        ):
            raise AgentArtsResponseError("invalid_response", "AgentArts Runtime 响应格式无效")

        return {"status": "received", "event": event, "text": data["text"]}
