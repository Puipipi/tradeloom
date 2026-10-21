from __future__ import annotations

import hashlib
import json
from typing import Any

from django.db import transaction
from django.utils import timezone

from workbench.agents.mock_runtime import MockAgentRuntime
from workbench.agents.runtime import RetryableExecutionError, UnknownWorkflowTaskError
from workbench.agents.result_contracts import (
    RoleResultContractError,
    validate_role_result,
)
from workbench.models import (
    EventLog,
    HumanReview,
    SubTask,
    WorkflowStep,
    WorkflowTask,
)

from .events import record_workflow_event
from .states import InvalidTransition, transition_workflow


class WorkflowOrchestrationError(RuntimeError):
    pass


class DependencyNotReady(WorkflowOrchestrationError):
    pass


class StepInProgress(WorkflowOrchestrationError):
    pass


class IdempotencyConflict(WorkflowOrchestrationError):
    pass


class CompletionGateError(WorkflowOrchestrationError):
    pass


class InvalidAgentResult(WorkflowOrchestrationError):
    pass


class SubTaskNotDispatchable(WorkflowOrchestrationError):
    pass


class RetryNotAllowed(WorkflowOrchestrationError):
    pass


class RetryLimitReached(RetryNotAllowed):
    pass


class StaleAttemptResult(WorkflowOrchestrationError):
    pass


MAX_SUBTASK_ATTEMPTS = 3


def _validate_agent_result(
    agent_role: str,
    result: Any,
    *,
    task_id: str,
    batch_id: str,
) -> dict[str, Any]:
    try:
        return validate_role_result(
            agent_role, result, task_id=task_id, batch_id=batch_id
        )
    except RoleResultContractError as exc:
        raise InvalidAgentResult("角色返回结果不符合契约") from exc


def _validate_plan(plan: dict[str, Any]) -> list[dict[str, Any]]:
    rows = plan.get("subtasks")
    if not isinstance(rows, list):
        raise ValueError("计划必须包含 subtasks 列表")
    keys = [row.get("key") for row in rows if isinstance(row, dict)]
    if len(keys) != len(rows) or len(keys) != len(set(keys)) or not keys:
        raise ValueError("子任务计划包含空项或重复 key")
    if set(keys) != {"product_profile", "delivery_quality"}:
        raise ValueError("计划必须包含 product_profile 与 delivery_quality 两个业务步骤")
    by_key = {row["key"]: row for row in rows}
    allowed_roles = {"product_profile", "delivery_quality"}
    for row in rows:
        if row.get("agent_role") not in allowed_roles:
            raise ValueError(f"计划包含未授权角色：{row.get('agent_role')}")
        if row["agent_role"] != row["key"]:
            raise ValueError("子任务 key 必须与业务 agent_role 一致")
        dependencies = row.get("depends_on", [])
        if not isinstance(dependencies, list):
            raise ValueError("depends_on 必须为列表")
        if any(dependency not in by_key for dependency in dependencies):
            raise ValueError(f"子任务 {row['key']} 引用了不存在的依赖")

    visiting: set[str] = set()
    visited: set[str] = set()

    def visit(key: str) -> None:
        if key in visiting:
            raise ValueError("子任务依赖图包含循环")
        if key in visited:
            return
        visiting.add(key)
        for dependency in by_key[key].get("depends_on", []):
            visit(dependency)
        visiting.remove(key)
        visited.add(key)

    for key in keys:
        visit(key)
    if by_key["product_profile"].get("depends_on", []):
        raise ValueError("product_profile 不得依赖其他业务子任务")
    if "product_profile" not in by_key["delivery_quality"].get("depends_on", []):
        raise ValueError("delivery_quality 必须依赖 product_profile")
    return rows


class WorkflowOrchestrator:
    """Persist and run the two bounded Phase 2 business roles."""

    def __init__(self, runtime=None) -> None:
        self.runtime = runtime or MockAgentRuntime()

    def plan_task(
        self, task_id: str, confirmed_intent: dict[str, Any] | None = None
    ) -> dict[str, Any]:
        with transaction.atomic():
            try:
                workflow = WorkflowTask.objects.select_for_update().get(pk=task_id)
            except WorkflowTask.DoesNotExist as exc:
                raise UnknownWorkflowTaskError(task_id) from exc
            saved = WorkflowStep.objects.filter(
                task=workflow,
                step_key="center_plan",
                status="completed",
            ).order_by("-attempt", "-created_at", "-id").first()
            if saved:
                return saved.output_refs["plan"]
            if workflow.status not in {"queued", "running"}:
                raise WorkflowOrchestrationError(
                    f"当前工作流状态不能规划：{workflow.status}"
                )

            if confirmed_intent is None:
                plan = self.runtime.plan_task(workflow.id)
            else:
                plan = self.runtime.plan_task(
                    workflow.id, confirmed_intent=confirmed_intent
                )
            rows = _validate_plan(plan)
            now = timezone.now()
            step = WorkflowStep.objects.create(
                task=workflow,
                step_key="center_plan",
                status="running",
                attempt=1,
                idempotency_key=f"workflow:{workflow.id}:center_plan",
                input_refs={"workflow_task_id": workflow.id},
                started_at=now,
            )
            record_workflow_event(
                workflow=workflow,
                event_type="workflow_step_started",
                actor="center",
                from_status="created",
                to_status="running",
                refs={"workflow_step_id": step.id, "step_key": step.step_key},
            )
            by_key: dict[str, SubTask] = {}
            for row in rows:
                subtask = SubTask.objects.create(
                    task=workflow,
                    agent_role=row["agent_role"],
                    input_refs=row.get("input_refs", {}),
                    status="queued",
                )
                by_key[row["key"]] = subtask
                record_workflow_event(
                    workflow=workflow,
                    subtask=subtask,
                    event_type="subtask_created",
                    actor="center",
                    to_status="queued",
                    refs={"role": subtask.agent_role},
                )
            for row in rows:
                by_key[row["key"]].depends_on.add(
                    *(by_key[key] for key in row.get("depends_on", []))
                )

            step.status = "completed"
            step.finished_at = now
            step.output_refs = {
                "plan": plan,
                "subtask_ids": [by_key[row["key"]].id for row in rows],
            }
            step.save(update_fields=["status", "finished_at", "output_refs", "updated_at"])
            record_workflow_event(
                workflow=workflow,
                event_type="workflow_plan_completed",
                actor="center",
                from_status="running",
                to_status="completed",
                refs={"workflow_step_id": step.id},
            )
            workflow.current_step = rows[0]["key"]
            workflow.result_refs = {
                **workflow.result_refs,
                "plan_step_id": step.id,
                "subtasks": {},
            }
            workflow.save(update_fields=["current_step", "result_refs", "updated_at"])
            return plan

    def dispatch_subtask(self, subtask_id: str, idempotency_key: str) -> SubTask:
        if not idempotency_key or not idempotency_key.strip():
            raise IdempotencyConflict("幂等键不能为空")
        with transaction.atomic():
            try:
                initial = SubTask.objects.only("task_id").get(pk=subtask_id)
            except SubTask.DoesNotExist as exc:
                from workbench.agents.runtime import UnknownSubTaskError

                raise UnknownSubTaskError(subtask_id) from exc
            workflow = WorkflowTask.objects.select_for_update().get(pk=initial.task_id)
            subtask = SubTask.objects.select_for_update().get(pk=subtask_id)
            keyed = WorkflowStep.objects.filter(
                task=workflow,
                idempotency_key=idempotency_key,
            ).first()
            if keyed:
                if keyed.step_key != f"subtask:{subtask.id}":
                    raise IdempotencyConflict("幂等键已绑定到另一个逻辑步骤")
                if keyed.status == "running":
                    raise StepInProgress(f"步骤仍在运行：{subtask.id}")
                return subtask

            prior = WorkflowStep.objects.filter(
                task=workflow,
                step_key=f"subtask:{subtask.id}",
            ).order_by("-attempt", "-created_at", "-id").first()
            if prior:
                if prior.status == "running":
                    raise StepInProgress(f"步骤仍在运行：{subtask.id}")
                if prior.idempotency_key == idempotency_key:
                    return subtask
                apply_step = WorkflowStep.objects.filter(
                    task=workflow, step_key="apply_review_cycle", status="completed"
                ).order_by("-created_at", "-id").first()
                authority = (
                    apply_step.output_refs.get("resume_authority", {}).get(subtask.id)
                    if apply_step and isinstance(apply_step.output_refs, dict)
                    else None
                )
                latest_plan = WorkflowStep.objects.filter(
                    task=workflow, step_key="center_plan", status="completed"
                ).order_by("-attempt", "-created_at", "-id").first()
                expected = {
                    "role": subtask.agent_role,
                    "expected_prior_step_id": prior.id,
                    "next_attempt": prior.attempt + 1,
                    "input_fingerprint": hashlib.sha256(
                        json.dumps(subtask.input_refs, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
                    ).hexdigest(),
                    "plan_step_id": latest_plan.id if latest_plan else None,
                }
                if (
                    not isinstance(authority, dict)
                    or any(authority.get(key) != value for key, value in expected.items())
                    or workflow.status != "running"
                    or workflow.current_step != subtask.agent_role
                    or subtask.status != "queued"
                    or HumanReview.objects.filter(task=workflow, status__in=["pending", "submitted"]).exists()
                ):
                    raise IdempotencyConflict("该子任务已绑定其他幂等键")
                expected_key = (
                    f"workflow:{workflow.id}:subtask:{subtask.id}:resume:"
                    f"{apply_step.id}:prior:{prior.id}:attempt:{prior.attempt + 1}"
                )
                if idempotency_key != expected_key:
                    raise IdempotencyConflict("恢复幂等键与审核授权不匹配")
                resume_apply_step_id = apply_step.id
                resume_plan_step_id = authority.get("plan_step_id")
                attempt = prior.attempt + 1
            else:
                resume_apply_step_id = None
                resume_plan_step_id = None
                attempt = 1
                apply_step = WorkflowStep.objects.filter(
                    task=workflow, step_key="apply_review_cycle", status="completed"
                ).order_by("-created_at", "-id").first()
                authority = (
                    apply_step.output_refs.get("resume_authority", {}).get(subtask.id)
                    if apply_step and isinstance(apply_step.output_refs, dict)
                    else None
                )
                if isinstance(authority, dict) and authority.get("expected_prior_step_id") is None:
                    latest_plan = WorkflowStep.objects.filter(
                        task=workflow, step_key="center_plan", status="completed"
                    ).order_by("-attempt", "-created_at", "-id").first()
                    expected_key = (
                        f"workflow:{workflow.id}:subtask:{subtask.id}:resume:"
                        f"{apply_step.id if apply_step else ''}:prior:none:attempt:1"
                    )
                    if (
                        not isinstance(authority, dict)
                        or authority.get("expected_prior_step_id") is not None
                        or authority.get("next_attempt") != 1
                        or authority.get("plan_step_id") != (latest_plan.id if latest_plan else None)
                        or authority.get("input_fingerprint") != hashlib.sha256(
                            json.dumps(subtask.input_refs, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
                        ).hexdigest()
                        or workflow.status != "running"
                        or workflow.current_step != subtask.agent_role
                        or idempotency_key != expected_key
                    ):
                        raise IdempotencyConflict("首次恢复幂等键与审核授权不匹配")
                    resume_apply_step_id = apply_step.id
                    resume_plan_step_id = authority.get("plan_step_id")
            if HumanReview.objects.filter(
                task=workflow, status__in=["pending", "submitted"]
            ).exists():
                raise DependencyNotReady("存在未解决人工审核，不能派发")
            if workflow.status not in {"queued", "running"}:
                raise SubTaskNotDispatchable(
                    f"当前工作流状态不能派发：{workflow.status}"
                )
            if subtask.status != "queued":
                raise SubTaskNotDispatchable(
                    f"当前子任务状态不能派发：{subtask.status}"
                )

            dependencies = list(subtask.depends_on.select_for_update().all())
            for dependency in dependencies:
                if dependency.task_id != workflow.id:
                    raise DependencyNotReady("不能依赖其他工作流的子任务")
                if dependency.status != "completed":
                    raise DependencyNotReady(
                        f"依赖尚未完成：{dependency.agent_role} ({dependency.status})"
                    )
            if workflow.status in {"queued", "waiting_human"}:
                workflow = transition_workflow(workflow, "running", actor="orchestrator")
            now = timezone.now()
            step = WorkflowStep.objects.create(
                task=workflow,
                step_key=f"subtask:{subtask.id}",
                status="running",
                attempt=attempt,
                idempotency_key=idempotency_key,
                input_refs={
                    "subtask_id": subtask.id,
                    "agent_role": subtask.agent_role,
                    "source_refs": subtask.input_refs,
                    **({
                        "review_resume_apply_step_id": resume_apply_step_id,
                        "resume_expected_prior_step_id": prior.id if prior else None,
                        "resume_plan_step_id": resume_plan_step_id,
                        "resume_input_fingerprint": authority["input_fingerprint"],
                    } if resume_apply_step_id else {}),
                },
                started_at=now,
            )
            old_status = subtask.status
            subtask.status = "running"
            subtask.error_summary = ""
            subtask.save(update_fields=["status", "error_summary", "updated_at"])
            workflow.current_step = subtask.agent_role
            workflow.save(update_fields=["current_step", "updated_at"])
            record_workflow_event(
                workflow=workflow,
                subtask=subtask,
                event_type="subtask_started",
                actor=subtask.agent_role,
                from_status=old_status,
                to_status="running",
                refs={"workflow_step_id": step.id},
            )

        try:
            result = self.runtime.run_subtask(subtask.id)
            result = _validate_agent_result(
                subtask.agent_role,
                result,
                task_id=workflow.id,
                batch_id=workflow.batch_id,
            )
        except Exception as exc:
            self._record_failure(workflow.id, subtask.id, step.id, exc)
            raise
        try:
            return self._record_result(workflow.id, subtask.id, step.id, result)
        except StaleAttemptResult:
            raise
        except Exception as exc:
            self._record_failure(workflow.id, subtask.id, step.id, exc)
            raise

    def retry_subtask(
        self, subtask_id: str, idempotency_key: str, *, expected_step_id: str
    ) -> SubTask:
        if not idempotency_key or not idempotency_key.strip():
            raise IdempotencyConflict("幂等键不能为空")
        if not expected_step_id or not expected_step_id.strip():
            raise RetryNotAllowed("必须提供预期的失败步骤")

        step: WorkflowStep
        limit_reached = False
        with transaction.atomic():
            try:
                initial = SubTask.objects.only("task_id").get(pk=subtask_id)
            except SubTask.DoesNotExist as exc:
                from workbench.agents.runtime import UnknownSubTaskError

                raise UnknownSubTaskError(subtask_id) from exc
            workflow = WorkflowTask.objects.select_for_update().get(pk=initial.task_id)
            subtask = SubTask.objects.select_for_update().get(pk=subtask_id)

            keyed = WorkflowStep.objects.filter(
                task=workflow, idempotency_key=idempotency_key
            ).first()
            if keyed:
                if keyed.step_key != f"subtask:{subtask.id}":
                    raise IdempotencyConflict("幂等键已绑定到另一个逻辑步骤")
                if keyed.input_refs.get("retry_of_step_id") != expected_step_id:
                    raise IdempotencyConflict("幂等键已绑定其他预期步骤")
                if keyed.status == "running":
                    raise StepInProgress(f"步骤仍在运行：{subtask.id}")
                return subtask

            latest = WorkflowStep.objects.select_for_update().filter(
                task=workflow, step_key=f"subtask:{subtask.id}"
            ).order_by("-attempt", "-created_at", "-id").first()
            if latest is None or latest.id != expected_step_id:
                raise RetryNotAllowed("失败步骤已变化，请刷新后重试")
            if latest.status != "failed" or subtask.status != "failed":
                raise RetryNotAllowed("只有最新失败步骤可以重试")
            if not latest.output_refs.get("retryable"):
                raise RetryNotAllowed("该失败类型不支持重试")
            if getattr(self.runtime, "supports_safe_retry", False) is not True:
                raise RetryNotAllowed("当前执行器未声明可安全重试")
            if workflow.status not in {"failed", "running"}:
                raise RetryNotAllowed("当前工作流状态不允许重试")
            if HumanReview.objects.filter(
                task=workflow, status__in=["pending", "submitted"]
            ).exists():
                raise DependencyNotReady("存在未解决人工审核，不能重试")
            dependencies = list(subtask.depends_on.select_for_update().all())
            if any(
                dependency.task_id != workflow.id or dependency.status != "completed"
                for dependency in dependencies
            ):
                raise DependencyNotReady("子任务依赖尚未完成，不能重试")
            if subtask.retry_count >= MAX_SUBTASK_ATTEMPTS - 1:
                if not EventLog.objects.filter(
                    task=workflow,
                    event_type="subtask_retry_exhausted",
                    payload_summary__refs__workflow_step_id=latest.id,
                ).exists():
                    record_workflow_event(
                        workflow=workflow,
                        subtask=subtask,
                        event_type="subtask_retry_exhausted",
                        actor="orchestrator",
                        from_status="failed",
                        to_status="failed",
                        refs={"workflow_step_id": latest.id},
                        summary="已达到本地模拟执行重试上限",
                    )
                limit_reached = True
            else:
                if workflow.status == "failed":
                    workflow = transition_workflow(workflow, "queued", actor="orchestrator")
                workflow = transition_workflow(workflow, "running", actor="orchestrator")
                now = timezone.now()
                attempt = latest.attempt + 1
                step = WorkflowStep.objects.create(
                    task=workflow,
                    step_key=f"subtask:{subtask.id}",
                    status="running",
                    attempt=attempt,
                    idempotency_key=idempotency_key,
                    input_refs={
                        "subtask_id": subtask.id,
                        "agent_role": subtask.agent_role,
                        "source_refs": subtask.input_refs,
                        "retry_of_step_id": latest.id,
                    },
                    started_at=now,
                )
                subtask.status = "running"
                subtask.retry_count += 1
                subtask.error_summary = ""
                subtask.save(update_fields=["status", "retry_count", "error_summary", "updated_at"])
                workflow.current_step = subtask.agent_role
                workflow.error_summary = ""
                workflow.save(update_fields=["current_step", "error_summary", "updated_at"])
                record_workflow_event(
                    workflow=workflow,
                    subtask=subtask,
                    event_type="subtask_retry_started",
                    actor="orchestrator",
                    from_status="failed",
                    to_status="running",
                    refs={"workflow_step_id": step.id, "attempt": attempt},
                )

        if limit_reached:
            raise RetryLimitReached("该子任务已达到最多三次执行尝试")

        try:
            result = self.runtime.run_subtask(subtask.id)
            result = _validate_agent_result(
                subtask.agent_role,
                result,
                task_id=workflow.id,
                batch_id=workflow.batch_id,
            )
        except Exception as exc:
            self._record_failure(workflow.id, subtask.id, step.id, exc)
            raise
        try:
            return self._record_result(workflow.id, subtask.id, step.id, result)
        except StaleAttemptResult:
            raise
        except Exception as exc:
            self._record_failure(workflow.id, subtask.id, step.id, exc)
            raise

    def interrupt_subtask(
        self,
        subtask_id: str,
        *,
        expected_step_id: str,
        operator_label: str,
        note: str,
    ) -> WorkflowStep:
        with transaction.atomic():
            try:
                initial = SubTask.objects.only("task_id").get(pk=subtask_id)
            except SubTask.DoesNotExist as exc:
                from workbench.agents.runtime import UnknownSubTaskError

                raise UnknownSubTaskError(subtask_id) from exc
            workflow = WorkflowTask.objects.select_for_update().get(pk=initial.task_id)
            subtask = SubTask.objects.select_for_update().get(pk=subtask_id)
            step = WorkflowStep.objects.select_for_update().filter(
                task=workflow, step_key=f"subtask:{subtask.id}"
            ).order_by("-attempt", "-created_at", "-id").first()
            if (
                step is None
                or step.id != expected_step_id
                or step.status != "running"
                or subtask.status != "running"
                or workflow.status != "running"
            ):
                raise StaleAttemptResult("当前执行已变化，不能接管")
            safe_retry = getattr(self.runtime, "supports_safe_retry", False) is True
            summary = "执行已标记中断并接管；原进程及副作用结果未知"
            step.status = "failed"
            step.finished_at = timezone.now()
            step.error_summary = summary
            step.output_refs = {
                "canonical_result_ref": f"workflow_step:{step.id}:output_refs.result_snapshot",
                "retryable": safe_retry,
                "outcome_unknown": True,
                "result_snapshot": {
                    "subtask_status": "failed",
                    "retryable": safe_retry,
                    "outcome_unknown": True,
                    "operator_label": operator_label,
                    "note": note[:1000],
                },
            }
            step.save(update_fields=["status", "finished_at", "error_summary", "output_refs", "updated_at"])
            subtask.status = "failed"
            subtask.error_summary = summary
            subtask.save(update_fields=["status", "retry_count", "error_summary", "updated_at"])
            record_workflow_event(
                workflow=workflow,
                subtask=subtask,
                event_type="subtask_interrupted",
                actor="orchestrator",
                from_status="running",
                to_status="failed",
                refs={"workflow_step_id": step.id, "operator_label": operator_label, "outcome_unknown": True},
                summary=summary,
            )
            workflow.error_summary = summary
            workflow.current_step = subtask.agent_role
            workflow.save(update_fields=["error_summary", "current_step", "updated_at"])
            transition_workflow(workflow, "failed", actor="orchestrator")
            return step

    def _record_failure(self, task_id: str, subtask_id: str, step_id: str, exc: Exception) -> None:
        now = timezone.now()
        with transaction.atomic():
            workflow = WorkflowTask.objects.select_for_update().get(pk=task_id)
            subtask = SubTask.objects.select_for_update().get(pk=subtask_id)
            step = WorkflowStep.objects.select_for_update().get(pk=step_id)
            self._assert_current_running_attempt(workflow, subtask, step)
            message = (
                "角色返回结果不符合契约"
                if isinstance(exc, InvalidAgentResult)
                else RetryableExecutionError.safe_summary
                if isinstance(exc, RetryableExecutionError)
                else "子任务执行失败，请检查输入与运行环境"
            )
            retryable = (
                isinstance(exc, RetryableExecutionError)
                and getattr(self.runtime, "supports_safe_retry", False) is True
            )
            old_status = subtask.status
            subtask.status = "failed"
            subtask.error_summary = message
            subtask.save(update_fields=["status", "retry_count", "error_summary", "updated_at"])
            step.status = "failed"
            step.finished_at = now
            step.error_summary = message
            step.output_refs = {
                "canonical_result_ref": f"workflow_step:{step.id}:output_refs.result_snapshot",
                "retryable": retryable,
                "outcome_unknown": False,
                "result_snapshot": {
                    "subtask_status": "failed",
                    "retryable": retryable,
                    "outcome_unknown": False,
                },
            }
            step.save(update_fields=["status", "finished_at", "error_summary", "output_refs", "updated_at"])
            current = WorkflowTask.objects.get(pk=task_id).status
            workflow.error_summary = message
            workflow.save(update_fields=["error_summary", "updated_at"])
            if current == "running":
                workflow = transition_workflow(workflow, "failed", actor="orchestrator")
            record_workflow_event(
                workflow=workflow,
                subtask=subtask,
                event_type="subtask_failed",
                actor=subtask.agent_role,
                from_status=old_status,
                to_status="failed",
                refs={"workflow_step_id": step.id},
                summary=message,
            )

    def _record_result(
        self, task_id: str, subtask_id: str, step_id: str, result: dict[str, Any]
    ) -> SubTask:
        now = timezone.now()
        with transaction.atomic():
            workflow = WorkflowTask.objects.select_for_update().get(pk=task_id)
            subtask = SubTask.objects.select_for_update().get(pk=subtask_id)
            step = WorkflowStep.objects.select_for_update().get(pk=step_id)
            self._assert_current_running_attempt(workflow, subtask, step)
            result_status = result.get("status")
            if result_status == "needs_human":
                target_status = "waiting_human"
            elif result_status == "blocked":
                target_status = "failed"
            else:
                target_status = "completed"
            old_status = subtask.status
            subtask.status = target_status
            subtask.output_refs = {
                "result": result,
                "source_refs": result.get("source_refs", {}),
            }
            if target_status == "failed":
                subtask.error_summary = "角色结果报告 blocked"
            subtask.save(
                update_fields=["status", "output_refs", "error_summary", "updated_at"]
            )
            if target_status == "waiting_human":
                from .validation import persist_review_candidates

                persist_review_candidates(workflow.id, subtask.id, result, origin_step=step)
            step.status = "failed" if target_status == "failed" else "completed"
            step.finished_at = now
            step.output_refs = {
                "subtask_id": subtask.id,
                "source_refs": result.get("source_refs", {}),
                "canonical_result_ref": f"workflow_step:{step.id}:output_refs.result_snapshot",
                "subtask_status": target_status,
                "retryable": False,
                "outcome_unknown": False,
                "result_snapshot": {
                    "subtask_status": target_status,
                    "retryable": False,
                    "outcome_unknown": False,
                    "result": result,
                },
            }
            if target_status == "failed":
                step.error_summary = subtask.error_summary
            step.save(
                update_fields=["status", "finished_at", "output_refs", "error_summary", "updated_at"]
            )
            refs = {"workflow_step_id": step.id, "result_ref": step.output_refs["canonical_result_ref"]}
            record_workflow_event(
                workflow=workflow,
                subtask=subtask,
                event_type=("subtask_waiting_human" if target_status == "waiting_human" else "subtask_failed" if target_status == "failed" else "subtask_completed"),
                actor=subtask.agent_role,
                from_status=old_status,
                to_status=target_status,
                refs=refs,
                summary=result.get("status"),
            )
            workflow = WorkflowTask.objects.select_for_update().get(pk=task_id)
            old_workflow_status = workflow.status
            if target_status == "waiting_human":
                next_step = "human_review"
            elif target_status == "failed":
                next_step = "failed"
            elif subtask.agent_role == "delivery_quality" and result.get("quality_scope") == "data_readiness":
                next_step = "generate_deliverables"
            elif subtask.agent_role == "product_profile":
                next_step = "delivery_quality"
            else:
                next_step = workflow.current_step
            workflow.result_refs = {
                **workflow.result_refs,
                "subtasks": {
                    **workflow.result_refs.get("subtasks", {}),
                    subtask.agent_role: {
                        "subtask_id": subtask.id,
                        "result_ref": refs["result_ref"],
                    },
                },
                "next_step": next_step,
            }
            workflow.current_step = next_step
            workflow.save(update_fields=["result_refs", "current_step", "updated_at"])
            if target_status == "failed":
                workflow.error_summary = subtask.error_summary
                workflow.save(update_fields=["error_summary", "updated_at"])
            if target_status == "waiting_human" and workflow.status == "running":
                workflow = transition_workflow(workflow, "waiting_human", actor="orchestrator")
            elif target_status == "failed" and workflow.status == "running":
                workflow = transition_workflow(workflow, "failed", actor="orchestrator")
            if old_workflow_status != workflow.status:
                record_workflow_event(
                    workflow=workflow,
                    event_type="workflow_execution_paused" if workflow.status == "waiting_human" else "workflow_execution_failed",
                    actor="orchestrator",
                    from_status=old_workflow_status,
                    to_status=workflow.status,
                    refs={"subtask_id": subtask.id},
                )
            return subtask

    def resume_task(self, task_id: str) -> dict[str, Any]:
        try:
            workflow = WorkflowTask.objects.get(pk=task_id)
        except WorkflowTask.DoesNotExist as exc:
            raise UnknownWorkflowTaskError(task_id) from exc
        if HumanReview.objects.filter(
            task=workflow, status__in=["pending", "submitted"]
        ).exists():
            raise DependencyNotReady("存在未解决人工审核，不能恢复工作流")
        if workflow.status == "waiting_human":
            raise DependencyNotReady("工作流等待人工处理，不能自动恢复")
        if workflow.status in {"failed", "cancelled"}:
            raise WorkflowOrchestrationError(f"工作流处于终态：{workflow.status}")
        if not WorkflowStep.objects.filter(task=workflow, step_key="center_plan", status="completed").exists():
            self.plan_task(workflow.id)
        workflow.refresh_from_db()
        for subtask in SubTask.objects.filter(task=workflow).prefetch_related("depends_on"):
            if subtask.status in {"completed", "waiting_human", "failed"}:
                continue
            if all(dep.status == "completed" and dep.task_id == workflow.id for dep in subtask.depends_on.all()):
                prior = WorkflowStep.objects.filter(
                    task=workflow, step_key=f"subtask:{subtask.id}"
                ).order_by("-attempt", "-created_at", "-id").first()
                apply_step = WorkflowStep.objects.filter(
                    task=workflow, step_key="apply_review_cycle", status="completed"
                ).order_by("-created_at", "-id").first()
                authority = (
                    apply_step.output_refs.get("resume_authority", {}).get(subtask.id)
                    if apply_step and isinstance(apply_step.output_refs, dict)
                    else None
                )
                if isinstance(authority, dict) and authority.get("expected_prior_step_id") == (prior.id if prior else None):
                    key = (
                        f"workflow:{workflow.id}:subtask:{subtask.id}:resume:"
                        f"{apply_step.id}:prior:{authority.get('expected_prior_step_id') or 'none'}:"
                        f"attempt:{authority.get('next_attempt')}"
                    )
                else:
                    key = f"workflow:{workflow.id}:subtask:{subtask.id}"
                subtask = self.dispatch_subtask(subtask.id, key)
                workflow.refresh_from_db()
                return {"task_id": workflow.id, "status": workflow.status, "current_step": workflow.current_step, "subtask_id": subtask.id, "subtask_status": subtask.status}
        workflow.refresh_from_db()
        return {"task_id": workflow.id, "status": workflow.status, "current_step": workflow.current_step}

    @staticmethod
    def _assert_current_running_attempt(
        workflow: WorkflowTask, subtask: SubTask, step: WorkflowStep
    ) -> None:
        latest = WorkflowStep.objects.filter(
            task=workflow, step_key=f"subtask:{subtask.id}"
        ).order_by("-attempt", "-created_at", "-id").first()
        if (
            latest is None
            or latest.id != step.id
            or step.status != "running"
            or subtask.status != "running"
        ):
            raise StaleAttemptResult("执行结果已过期，未覆盖当前状态")

    def complete_workflow(self, task_id: str) -> WorkflowTask:
        from workbench.delivery.service import (
            DeliveryConflict,
            DeliveryNotFound,
            complete_workflow_with_deliverables,
        )

        try:
            complete_workflow_with_deliverables(task_id)
        except DeliveryNotFound as exc:
            raise UnknownWorkflowTaskError(task_id) from exc
        except DeliveryConflict as exc:
            raise CompletionGateError(str(exc)) from exc
        return WorkflowTask.objects.get(pk=task_id)


def dispatch_subtask(subtask_id: str, idempotency_key: str) -> SubTask:
    """Convenience entry point backed by the default local mock runtime."""

    return WorkflowOrchestrator().dispatch_subtask(subtask_id, idempotency_key)
