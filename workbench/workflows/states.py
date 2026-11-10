from __future__ import annotations

from django.db import transaction

from workbench.models import EventLog, WorkflowTask


class InvalidTransition(Exception):
    """Raised when a workflow status transition is not allowed."""


WORKFLOW_STATUSES = frozenset(
    {
        "queued",
        "running",
        "waiting_human",
        "failed",
        "completed",
        "cancelled",
    }
)

TRANSITIONS = {
    "queued": frozenset({"running"}),
    "running": frozenset({"waiting_human", "failed", "completed", "cancelled"}),
    "waiting_human": frozenset({"running", "cancelled"}),
    "failed": frozenset({"queued", "cancelled"}),
    "completed": frozenset(),
    "cancelled": frozenset(),
}

WORKFLOW_STATUS_CHANGED = "workflow_status_changed"


def transition_workflow(
    task: WorkflowTask,
    to_status: str,
    actor: str,
) -> WorkflowTask:
    """Move a workflow task to ``to_status`` and record the actual transition.

    The current status is always read from the database under a row lock, so a
    stale caller model cannot bypass terminal states. Repeating the current
    status is an idempotent no-op and does not write an event.
    """

    with transaction.atomic():
        current = WorkflowTask.objects.select_for_update().get(pk=task.pk)
        from_status = current.status

        if from_status not in WORKFLOW_STATUSES:
            raise InvalidTransition(f"Unknown workflow status: {from_status!r}")
        if to_status not in WORKFLOW_STATUSES:
            raise InvalidTransition(f"Unknown workflow status: {to_status!r}")
        if from_status == to_status:
            return current
        if to_status not in TRANSITIONS[from_status]:
            raise InvalidTransition(
                f"WorkflowTask {current.pk}: {from_status} -> {to_status} is not allowed"
            )

        current.status = to_status
        current.save(update_fields=["status", "updated_at"])
        EventLog.objects.create(
            task=current,
            event_type=WORKFLOW_STATUS_CHANGED,
            actor=actor,
            payload_summary={
                "from_status": from_status,
                "to_status": to_status,
            },
        )
        return current
