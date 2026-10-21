from __future__ import annotations

from typing import Callable

from workbench.models import WorkflowStep


def resolve_dispatch_target(workflow, *, status_label: Callable[[str], str] | None = None) -> dict:
    """Return the server-selected next dispatch key without exposing resume authority."""
    label = status_label or (lambda value: value)
    subtasks = list(workflow.subtasks.all())
    running = [item for item in subtasks if item.status == "running"]
    queued = [item for item in subtasks if item.status == "queued"]
    unresolved_reviews = workflow.human_reviews.filter(status__in=["pending", "submitted"]).exists()
    target = None
    blocked_reason = ""

    if unresolved_reviews:
        blocked_reason = "存在待填写或待核验的人审事项，当前不能执行。"
    elif running:
        blocked_reason = "已有子任务正在运行，请刷新查看保存状态。"
    elif workflow.status not in {"queued", "running"}:
        if workflow.status == "waiting_human":
            blocked_reason = "工作流等待人工处理，当前不能执行子任务。"
        elif workflow.status in {"failed", "completed", "cancelled"}:
            blocked_reason = f"工作流处于{label(workflow.status)}状态，当前不能执行子任务。"
        else:
            blocked_reason = "当前工作流状态不能执行子任务。"
    else:
        for candidate in queued:
            dependencies = list(candidate.depends_on.all())
            if not all(dependency.task_id == workflow.id and dependency.status == "completed" for dependency in dependencies):
                continue
            latest_attempt = WorkflowStep.objects.filter(
                task=workflow, step_key=f"subtask:{candidate.id}"
            ).order_by("-attempt", "-created_at", "-id").first()
            latest_apply = WorkflowStep.objects.filter(
                task=workflow, step_key="apply_review_cycle", status="completed"
            ).order_by("-created_at", "-id").first()
            authority = (
                latest_apply.output_refs.get("resume_authority", {}).get(candidate.id)
                if latest_apply and isinstance(latest_apply.output_refs, dict)
                else None
            )
            if isinstance(authority, dict) and authority.get("expected_prior_step_id") == (latest_attempt.id if latest_attempt else None):
                key = (
                    f"workflow:{workflow.id}:subtask:{candidate.id}:resume:"
                    f"{latest_apply.id}:prior:{authority.get('expected_prior_step_id') or 'none'}:"
                    f"attempt:{authority.get('next_attempt')}"
                )
            else:
                key = f"workflow:{workflow.id}:subtask:{candidate.id}"
            target = {"subtask_id": candidate.id, "idempotency_key": key}
            break

        if target is None:
            if queued:
                blocked_reason = "排队中的子任务仍在等待同一工作流的依赖完成。"
            elif any(item.status == "failed" for item in subtasks):
                blocked_reason = "存在失败子任务，当前没有可执行的下一步。"
            elif any(item.status == "waiting_human" for item in subtasks):
                blocked_reason = "子任务正在等待人工处理，当前没有可执行的下一步。"
            else:
                blocked_reason = "当前没有排队中的子任务可执行。"

    return {
        "subtask_id": target["subtask_id"] if target else "",
        "idempotency_key": target["idempotency_key"] if target else "",
        "blocked_reason": blocked_reason,
    }
