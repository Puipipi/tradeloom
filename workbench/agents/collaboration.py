from __future__ import annotations

from typing import Any

from workbench.models import EventLog


MESSAGE_LIMIT = 100
_SAFE_ERROR_SUMMARIES = frozenset(
    {
        "角色返回结果不符合契约",
        "子任务执行遇到可重试的临时错误",
        "子任务执行失败，请检查输入与运行环境",
        "执行已标记中断并接管；原进程及副作用结果未知",
        "角色结果报告 blocked",
        "交付文件生成失败，来源或文件质检未通过。",
        "交付生成尝试已由操作人接管，外部结果未知。",
    }
)
_GENERIC_ERROR_SUMMARY = "工作流执行失败，请查看本地状态。"


def _safe_error(error_summary: Any) -> dict[str, Any] | None:
    summary = error_summary
    if not summary:
        return None
    if summary not in _SAFE_ERROR_SUMMARIES:
        summary = _GENERIC_ERROR_SUMMARY
    return {"code": None, "summary": summary}


def collaboration_event_metadata(task_id: str) -> list[dict[str, Any]]:
    """Load only bounded public event metadata for one workflow task."""
    return list(
        EventLog.objects.filter(task_id=task_id)
        .order_by("created_at", "id")
        .values("id", "event_type", "actor", "created_at")[: MESSAGE_LIMIT + 1]
    )


def project_collaboration_envelope(
    public_payload: dict[str, Any], event_metadata: list[dict[str, Any]]
) -> dict[str, Any]:
    """Project an envelope from the existing public workflow DTO and safe events."""
    events = event_metadata[: MESSAGE_LIMIT + 1]
    messages_truncated = len(events) > MESSAGE_LIMIT
    messages = [
        {
            "id": event["id"],
            "type": event["event_type"],
            "actor": event["actor"],
            "created_at": event["created_at"].isoformat(),
        }
        for event in events[:MESSAGE_LIMIT]
    ]

    return {
        "schema_version": 1,
        "task": {
            "system": "tradeloom",
            "id": public_payload["id"],
            "batch_id": public_payload["batch_id"],
        },
        "status": {
            "workflow": public_payload["status"],
            "current_step": public_payload["current_step"],
            "subtasks": [
                {"id": item["id"], "role": item["agent_role"], "status": item["status"]}
                for item in public_payload["subtasks"]
            ],
            "reviews": [
                {"id": review["id"], "status": review["status"]}
                for review in public_payload["reviews"]
            ],
        },
        "messages": messages,
        "messages_truncated": messages_truncated,
        "result": {"data": None, "refs": public_payload["result_refs"]},
        "error": _safe_error(public_payload.get("error_summary")),
    }
