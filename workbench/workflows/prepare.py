from __future__ import annotations

import hashlib
import json
from typing import Any

from django.db import transaction
from django.db.models import Prefetch

from workbench.agents.workflow_contracts import workflow_markers
from workbench.intent.parser import verify_confirmation_token
from workbench.models import HumanReview, SubTask, Task, WorkflowStep, WorkflowTask
from workbench.workflows.orchestrator import WorkflowOrchestrator


class UnknownWorkflowBatchError(LookupError):
    def __init__(self, batch_id: str) -> None:
        self.batch_id = batch_id
        super().__init__(f"未知批次：{batch_id}")


class UnknownPreparedWorkflowError(LookupError):
    def __init__(self, workflow_id: str) -> None:
        self.workflow_id = workflow_id
        super().__init__(f"未知工作流：{workflow_id}")


class WorkflowCreationIdempotencyConflict(ValueError):
    pass


@transaction.atomic
def create_prepared_workflow(
    *, batch_id: str, user_goal: str, task_type: str = "prepare_product_data",
    confirmation_token: str | None = None, execution_mode: str = "local_mock",
) -> WorkflowTask:
    try:
        batch = Task.objects.get(pk=batch_id)
    except Task.DoesNotExist as exc:
        raise UnknownWorkflowBatchError(batch_id) from exc

    confirmed_intent = (
        verify_confirmation_token(
            token=confirmation_token,
            batch_id=batch_id,
            user_goal=user_goal,
            task_type=task_type,
            execution_mode=execution_mode,
        )
        if confirmation_token is not None
        else None
    )
    if execution_mode == "native_dsh" and confirmed_intent is None:
        raise ValueError("原生 DSH 执行必须先确认绑定执行模式的意图")

    workflow = WorkflowTask.objects.create(
        batch=batch,
        user_goal=user_goal,
        task_type=task_type,
        status="queued",
    )
    # plan_task persists the center step and its two queued roles; the outer
    # transaction makes the workflow and complete plan an all-or-nothing unit.
    if confirmed_intent is None:
        WorkflowOrchestrator().plan_task(workflow.id, execution_mode=execution_mode)
    else:
        WorkflowOrchestrator().plan_task(
            workflow.id,
            confirmed_intent=confirmed_intent,
            execution_mode=execution_mode,
            execution_confirmation_fingerprint=hashlib.sha256(confirmation_token.encode("utf-8")).hexdigest(),
        )
    return get_prepared_workflow(workflow.id)


@transaction.atomic
def create_idempotent_prepared_workflow(
    *,
    batch_id: str,
    user_goal: str,
    task_type: str,
    idempotency_key: str,
    confirmation_token: str | None = None,
    execution_mode: str = "local_mock",
) -> tuple[WorkflowTask, dict[str, Any]]:
    request_components = [batch_id, user_goal, task_type]
    if execution_mode != "local_mock":
        request_components.append(execution_mode)
    if confirmation_token is not None:
        request_components.append(confirmation_token)
    fingerprint = hashlib.sha256(
        json.dumps(
            request_components,
            ensure_ascii=False,
            separators=(",", ":"),
        ).encode("utf-8")
    ).hexdigest()

    existing = WorkflowTask.objects.filter(
        creation_idempotency_key=idempotency_key
    ).first()
    if existing is not None:
        if existing.creation_request_fingerprint != fingerprint:
            raise WorkflowCreationIdempotencyConflict
        if not isinstance(existing.creation_receipt, dict):
            raise RuntimeError("工作流创建回执缺失")
        return existing, existing.creation_receipt

    try:
        batch = Task.objects.get(pk=batch_id)
    except Task.DoesNotExist as exc:
        raise UnknownWorkflowBatchError(batch_id) from exc

    workflow, created = WorkflowTask.objects.get_or_create(
        creation_idempotency_key=idempotency_key,
        defaults={
            "batch": batch,
            "user_goal": user_goal,
            "task_type": task_type,
            "creation_request_fingerprint": fingerprint,
            "status": "queued",
        },
    )
    if not created:
        if workflow.creation_request_fingerprint != fingerprint:
            raise WorkflowCreationIdempotencyConflict
        if not isinstance(workflow.creation_receipt, dict):
            raise RuntimeError("工作流创建回执缺失")
        return workflow, workflow.creation_receipt

    # Verify only after this transaction has won the unique-key insert. A
    # competing request that loses must replay the winner's frozen receipt
    # without depending on policy files that may have changed while it waited.
    confirmed_intent = (
        verify_confirmation_token(
            token=confirmation_token,
            batch_id=batch_id,
            user_goal=user_goal,
            task_type=task_type,
            execution_mode=execution_mode,
        )
        if confirmation_token is not None
        else None
    )
    if execution_mode == "native_dsh" and confirmed_intent is None:
        raise ValueError("原生 DSH 执行必须先确认绑定执行模式的意图")

    # The unique key, plan and frozen public receipt commit as one unit. The
    # get_or_create savepoint handles a competing insert without poisoning this
    # outer transaction.
    if confirmed_intent is None:
        WorkflowOrchestrator().plan_task(workflow.id, execution_mode=execution_mode)
    else:
        WorkflowOrchestrator().plan_task(
            workflow.id,
            confirmed_intent=confirmed_intent,
            execution_mode=execution_mode,
            execution_confirmation_fingerprint=hashlib.sha256(confirmation_token.encode("utf-8")).hexdigest(),
        )
    workflow = get_prepared_workflow(workflow.id)
    receipt = serialize_prepared_workflow(workflow)
    workflow.creation_receipt = receipt
    workflow.save(update_fields=["creation_receipt", "updated_at"])
    return workflow, receipt


def get_prepared_workflow(workflow_id: str) -> WorkflowTask:
    try:
        return (
            WorkflowTask.objects.select_related("batch")
            .prefetch_related(
                Prefetch(
                    "steps",
                    queryset=WorkflowStep.objects.order_by("created_at", "id"),
                ),
                Prefetch(
                    "subtasks",
                    queryset=SubTask.objects.order_by("created_at", "id").prefetch_related(
                        "depends_on"
                    ),
                ),
            )
            .get(pk=workflow_id)
        )
    except WorkflowTask.DoesNotExist as exc:
        raise UnknownPreparedWorkflowError(workflow_id) from exc


def serialize_prepared_workflow(workflow: WorkflowTask) -> dict[str, Any]:
    steps = list(workflow.steps.all())
    subtasks = list(workflow.subtasks.all())
    center_step = max(
        (step for step in steps if step.step_key == "center_plan"),
        key=lambda step: (step.attempt, step.created_at, step.id),
        default=None,
    )
    plan = (
        center_step.output_refs.get("plan")
        if center_step and isinstance(center_step.output_refs, dict)
        else None
    )
    execution_mode = (
        center_step.input_refs.get("execution_mode", "local_mock")
        if center_step and isinstance(center_step.input_refs, dict)
        else "local_mock"
    )
    reviews = list(
        HumanReview.objects.filter(task_id=workflow.id).order_by("created_at", "id")
    )
    pending_review_count = sum(review.status == "pending" for review in reviews)
    unresolved_review_count = sum(
        review.status in {"pending", "submitted"} for review in reviews
    )

    return {
        "id": workflow.id,
        "batch_id": workflow.batch_id,
        "user_goal": workflow.user_goal,
        "task_type": workflow.task_type,
        "status": workflow.status,
        "current_step": workflow.current_step,
        "result_refs": workflow.result_refs,
        "error_summary": workflow.error_summary,
        **workflow_markers(execution_mode),
        "plan": plan,
        "steps": [
            {
                "id": step.id,
                "step_key": step.step_key,
                "status": step.status,
                "attempt": step.attempt,
                "started_at": step.started_at.isoformat() if step.started_at else None,
                "finished_at": step.finished_at.isoformat() if step.finished_at else None,
                "input_refs": step.input_refs,
                "output_refs": _public_step_output_refs(step),
                "error_summary": step.error_summary,
            }
            for step in steps
        ],
        "subtasks": [
            {
                "id": subtask.id,
                "agent_role": subtask.agent_role,
                "status": subtask.status,
                "retry_count": subtask.retry_count,
                "depends_on": sorted(
                    dependency.id for dependency in subtask.depends_on.all()
                ),
                "input_refs": subtask.input_refs,
                "output_refs": subtask.output_refs,
                "error_summary": subtask.error_summary,
            }
            for subtask in subtasks
        ],
        "reviews": [
            {
                "id": review.id,
                "review_key": review.review_key,
                "item_ref": review.item_ref,
                "question": review.question,
                "options": review.options,
                "status": review.status,
                "answer": review.answer,
                "reviewer": review.reviewer,
                "created_at": review.created_at.isoformat(),
                "updated_at": review.updated_at.isoformat(),
                "source_refs": (
                    review.source_conflict.get("source_refs", {})
                    if isinstance(review.source_conflict, dict)
                    else {}
                ),
            }
            for review in reviews
        ],
        "reviews_scope": "business_facts",
        "pending_review_count": pending_review_count,
        "unresolved_review_count": unresolved_review_count,
    }


def _public_step_output_refs(step: WorkflowStep) -> dict[str, Any]:
    refs = step.output_refs if isinstance(step.output_refs, dict) else {}
    if step.step_key == "center_plan":
        return {
            key: refs[key]
            for key in ("plan", "subtask_ids", "canonical_result_ref", "source_refs")
            if key in refs
        }
    # Attempt snapshots are internal history. Public step DTOs expose only
    # stable references and the explicit operational metadata allowlist.
    allowed = {
        "canonical_result_ref",
        "subtask_status",
        "retryable",
        "outcome_unknown",
    }
    return {key: refs[key] for key in allowed if key in refs}
