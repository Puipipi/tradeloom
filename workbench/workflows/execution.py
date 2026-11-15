from __future__ import annotations

from typing import Any

from workbench.agents.runtime import UnknownSubTaskError
from workbench.agents.workflow_contracts import workflow_markers
from workbench.models import SubTask, WorkflowStep, WorkflowTask

from .orchestrator import NativeAssignmentRequired, WorkflowOrchestrator


class DispatchTargetNotFound(LookupError):
    pass


def dispatch_saved_subtask(
    workflow_id: str,
    subtask_id: str,
    idempotency_key: str,
    *,
    orchestrator: WorkflowOrchestrator | None = None,
) -> dict[str, Any]:
    """Dispatch only the explicitly saved subtask and return persisted metadata."""
    workflow = WorkflowTask.objects.filter(pk=workflow_id).first()
    if workflow is None:
        raise DispatchTargetNotFound(workflow_id)
    subtask = SubTask.objects.filter(pk=subtask_id, task_id=workflow.id).first()
    if subtask is None:
        raise DispatchTargetNotFound(subtask_id)

    center_step = WorkflowStep.objects.filter(
        task=workflow, step_key="center_plan", status="completed"
    ).order_by("-attempt", "-created_at", "-id").first()
    if (
        center_step
        and isinstance(center_step.input_refs, dict)
        and center_step.input_refs.get("execution_mode") == "native_dsh"
    ):
        raise NativeAssignmentRequired("原生工作流必须先创建Host绑定的native assignment")

    engine = orchestrator or WorkflowOrchestrator()
    subtask = engine.dispatch_subtask(subtask.id, idempotency_key)
    step = WorkflowStep.objects.get(task_id=workflow.id, idempotency_key=idempotency_key)
    return _serialize_attempt(workflow, subtask, step)


def retry_saved_subtask(
    workflow_id: str,
    subtask_id: str,
    idempotency_key: str,
    expected_step_id: str,
    *,
    orchestrator: WorkflowOrchestrator | None = None,
) -> dict[str, Any]:
    workflow = WorkflowTask.objects.filter(pk=workflow_id).first()
    subtask = SubTask.objects.filter(pk=subtask_id, task_id=workflow_id).first()
    if workflow is None or subtask is None:
        raise DispatchTargetNotFound(subtask_id)
    engine = orchestrator or WorkflowOrchestrator()
    subtask = engine.retry_subtask(
        subtask.id, idempotency_key, expected_step_id=expected_step_id
    )
    step = WorkflowStep.objects.get(task_id=workflow_id, idempotency_key=idempotency_key)
    return _serialize_attempt(workflow, subtask, step)


def interrupt_saved_subtask(
    workflow_id: str,
    subtask_id: str,
    expected_step_id: str,
    operator_label: str,
    note: str,
    *,
    orchestrator: WorkflowOrchestrator | None = None,
) -> dict[str, Any]:
    workflow = WorkflowTask.objects.filter(pk=workflow_id).first()
    subtask = SubTask.objects.filter(pk=subtask_id, task_id=workflow_id).first()
    if workflow is None or subtask is None:
        raise DispatchTargetNotFound(subtask_id)
    engine = orchestrator or WorkflowOrchestrator()
    step = engine.interrupt_subtask(
        subtask.id,
        expected_step_id=expected_step_id,
        operator_label=operator_label,
        note=note,
    )
    subtask.refresh_from_db()
    return _serialize_attempt(workflow, subtask, step)


def _serialize_attempt(
    workflow: WorkflowTask, subtask: SubTask, step: WorkflowStep
) -> dict[str, Any]:
    subtask.refresh_from_db()
    workflow.refresh_from_db(fields=["status"])
    center_step = WorkflowStep.objects.filter(
        task=workflow, step_key="center_plan", status="completed"
    ).order_by("-attempt", "-created_at", "-id").first()
    execution_mode = (
        center_step.input_refs.get("execution_mode", "local_mock")
        if center_step and isinstance(center_step.input_refs, dict)
        else "local_mock"
    )
    snapshot = step.output_refs.get("result_snapshot")
    historical_status = (
        snapshot.get("subtask_status")
        if isinstance(snapshot, dict)
        else subtask.status
    )
    result_ref = step.output_refs.get("canonical_result_ref")
    if not isinstance(result_ref, str):
        result_ref = f"subtask:{subtask.id}:output_refs.result" if step.status == "completed" else None
    return {
        "workflow_id": workflow.id,
        "subtask_id": subtask.id,
        "workflow_status": workflow.status,
        "subtask_status": historical_status,
        "current_subtask_status": subtask.status,
        "step": {
            "id": step.id,
            "key": step.idempotency_key,
            "status": step.status,
            "attempt": step.attempt,
            "started_at": step.started_at.isoformat() if step.started_at else None,
            "finished_at": step.finished_at.isoformat() if step.finished_at else None,
        },
        "result_ref": result_ref,
        **workflow_markers(execution_mode),
    }
