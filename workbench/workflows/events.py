from __future__ import annotations

from typing import Any

from workbench.models import EventLog, SubTask, WorkflowTask


def record_workflow_event(
    *,
    workflow: WorkflowTask,
    event_type: str,
    actor: str,
    subtask: SubTask | None = None,
    from_status: str | None = None,
    to_status: str | None = None,
    refs: dict[str, Any] | None = None,
    summary: str | None = None,
) -> EventLog:
    """Store a short operational event with source references, never agent reasoning."""

    payload: dict[str, Any] = {}
    if from_status is not None:
        payload["from_status"] = from_status
    if to_status is not None:
        payload["to_status"] = to_status
    if refs:
        payload["refs"] = refs
    if summary:
        payload["summary"] = summary[:240]
    return EventLog.objects.create(
        task=workflow,
        subtask=subtask,
        event_type=event_type,
        actor=actor,
        payload_summary=payload,
    )
