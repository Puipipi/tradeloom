from __future__ import annotations

from typing import Any, Literal, Protocol, TypedDict


class RuntimeMarkers(TypedDict):
    execution_mode: Literal["local_mock"]
    planning_mode: Literal["simulated_rules"]
    agentarts: Literal["not_configured"]
    notice: str


class AgentRuntime(Protocol):
    # A runtime must opt in only when its side effects are safe to repeat.
    supports_safe_retry: bool

    def plan_task(
        self,
        task_id: str,
        confirmed_intent: dict[str, Any] | None = None,
    ) -> dict[str, Any]: ...

    def run_subtask(self, subtask_id: str) -> dict[str, Any]: ...

    def resume_task(self, task_id: str) -> dict[str, Any]: ...

    def health_check(self) -> dict[str, Any]: ...


class UnknownWorkflowTaskError(LookupError):
    def __init__(self, task_id: str) -> None:
        self.task_id = task_id
        super().__init__(f"未知业务任务：{task_id}")


class UnknownSubTaskError(LookupError):
    def __init__(self, subtask_id: str) -> None:
        self.subtask_id = subtask_id
        super().__init__(f"未知子任务：{subtask_id}")


class RuntimeNotReady(RuntimeError):
    def __init__(self, *, operation: str, target_id: str, reason: str) -> None:
        self.operation = operation
        self.target_id = target_id
        self.reason = reason
        self.available = False
        super().__init__(f"{operation} 尚未就绪（{target_id}）：{reason}")


class RetryableExecutionError(RuntimeError):
    """An execution failure safe to retry, with a fixed public summary."""

    safe_summary = "子任务执行遇到可重试的临时错误"

    def __init__(self) -> None:
        super().__init__(self.safe_summary)
