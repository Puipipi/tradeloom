from __future__ import annotations

from typing import Any

from workbench.models import SubTask, WorkflowTask

from .center import CenterAgent
from .context import WorkflowContext
from .registry import build_workflow_role_registry
from .runtime import (
    UnknownSubTaskError,
    UnknownWorkflowTaskError,
)
from .workflow_contracts import SIMULATED_MARKERS, InputContractError


MARKERS = SIMULATED_MARKERS


class MockAgentRuntime:
    # Both registered local roles currently perform deterministic, read-only
    # calculations; future adapters must opt in explicitly on their own.
    supports_safe_retry = True
    execution_mode = MARKERS["execution_mode"]
    planning_mode = MARKERS["planning_mode"]
    agentarts = MARKERS["agentarts"]

    def plan_task(self, task_id: str, confirmed_intent: dict[str, Any] | None = None) -> dict[str, Any]:
        task = self._get_task(task_id)
        registry = build_workflow_role_registry()
        return CenterAgent().plan(
            WorkflowContext.from_workflow(task), registry=registry,
            confirmed_intent=confirmed_intent,
        )

    def run_subtask(self, subtask_id: str) -> dict[str, Any]:
        try:
            subtask = SubTask.objects.select_related("task__batch").get(
                pk=subtask_id
            )
        except SubTask.DoesNotExist as exc:
            raise UnknownSubTaskError(subtask_id) from exc

        if subtask.agent_role == "center":
            raise InputContractError(
                "中心规划记录为 WorkflowStep，不能作为业务 SubTask 执行",
                role_id="center",
            )

        registry = build_workflow_role_registry()
        role = registry.get(subtask.agent_role)
        task = self._get_task(subtask.task_id)
        context = WorkflowContext.from_workflow(task)
        if getattr(role, "available", False):
            from .schema_validation import validate_json_contract

            try:
                validate_json_contract(subtask.input_refs, role.input_schema())
            except Exception as exc:
                raise InputContractError(
                    "角色输入不符合已声明契约",
                    role_id=role.role_id,
                ) from exc
        result = role.execute(context, subtask.input_refs)
        return {**SIMULATED_MARKERS, **result}

    def resume_task(self, task_id: str) -> dict[str, Any]:
        self._get_task(task_id)
        from workbench.workflows.orchestrator import WorkflowOrchestrator

        return WorkflowOrchestrator(self).resume_task(task_id)

    def health_check(self) -> dict[str, Any]:
        registry = build_workflow_role_registry()
        roles = {}
        for role_id in registry.role_ids():
            role = registry.get(role_id)
            available = bool(getattr(role, "available", False))
            entry = {"available": available}
            if role_id == "center":
                entry["scope"] = "plan"
            if not available:
                entry["code"] = 409
                entry["reason"] = "尚未接入"
            roles[role_id] = entry

        return {
            **SIMULATED_MARKERS,
            "status": "partial",
            "implemented_capabilities": [
                "plan_task",
                "run_subtask",
                "resume_task",
                "health_check",
            ],
            "not_ready_capabilities": [],
            "task9_bound": True,
            "task10_bound": True,
            "roles": roles,
            "capabilities": {
                "plan_task": {
                    "available": True,
                    "mode": "simulated_rules",
                },
                "run_subtask": {
                    "available": True,
                    "mode": "local_deterministic_roles",
                },
                "resume_task": {
                    "available": True,
                    "mode": "persisted_workflow_steps",
                },
                "safe_retry": {
                    "available": self.supports_safe_retry,
                    "mode": "local_read_only_roles",
                },
                "health_check": {
                    "available": True,
                    "mode": "local",
                },
            },
        }

    def _get_task(self, task_id: str) -> WorkflowTask:
        try:
            return WorkflowTask.objects.select_related("batch").get(pk=task_id)
        except WorkflowTask.DoesNotExist as exc:
            raise UnknownWorkflowTaskError(task_id) from exc


MockRuntime = MockAgentRuntime
