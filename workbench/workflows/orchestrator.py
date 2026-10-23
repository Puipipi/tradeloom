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
from workbench.agents.workflow_contracts import workflow_markers
from workbench.models import (
    EventLog,
    HumanReview,
    Product,
    ProductRevision,
    SubTask,
    Task,
    TaskFile,
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


class NativeAssignmentRequired(WorkflowOrchestrationError):
    """Native workflows must use the persisted Host-bound assignment path."""


class NativeAdviceContextTooLarge(WorkflowOrchestrationError):
    """Canonical advice targets exceed the complete-reference limits."""


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

    @staticmethod
    def _assert_mock_execution_mode(workflow: WorkflowTask) -> None:
        plan = WorkflowStep.objects.filter(
            task=workflow, step_key="center_plan", status="completed"
        ).order_by("-attempt", "-created_at", "-id").first()
        if plan is not None and isinstance(plan.input_refs, dict) and plan.input_refs.get("execution_mode") == "native_dsh":
            raise NativeAssignmentRequired("原生工作流必须通过Host绑定的native assignment执行")

    @staticmethod
    def _canonical_native_result(workflow: WorkflowTask, subtask: SubTask) -> tuple[dict[str, Any], str]:
        from workbench.agents.context import WorkflowContext
        from workbench.agents.registry import build_workflow_role_registry
        from workbench.agents.workflow_contracts import WorkflowRoleError

        try:
            context = WorkflowContext.from_workflow(workflow)
            context.validate_refs(subtask.input_refs)
            role = build_workflow_role_registry().get(subtask.agent_role)
            result = role.execute(context, subtask.input_refs)
            result = _validate_agent_result(
                subtask.agent_role,
                result,
                task_id=workflow.id,
                batch_id=workflow.batch_id,
            )
        except WorkflowRoleError as exc:
            raise StaleAttemptResult("assignment来源或角色校验已过期") from exc
        fingerprint = hashlib.sha256(
            json.dumps(result, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
        ).hexdigest()
        return result, fingerprint

    @staticmethod
    def _native_advice_context(role_id: str, result: dict[str, Any]) -> dict[str, Any]:
        """Project only canonical, actionable targets needed to form bounded advice."""
        if role_id == "product_profile":
            fields = {"sku", "name", "category", "material", "size", "color", "english_name"}
            products = []
            canonical_products = result.get("products", [])
            if not isinstance(canonical_products, list):
                raise NativeAdviceContextTooLarge("建议来源超出支持范围")
            for item in canonical_products:
                refs = item.get("source_refs") if isinstance(item, dict) else None
                product_id = item.get("product_id") if isinstance(item, dict) else None
                if (
                    not isinstance(product_id, str)
                    or not product_id
                    or not isinstance(refs, dict)
                    or not isinstance(refs.get("task_file_ids"), list)
                    or any(not isinstance(value, str) or not value for value in refs["task_file_ids"])
                ):
                    continue
                missing = item.get("missing_fields")
                if not isinstance(missing, list):
                    continue
                actionable = [field for field in missing if field in fields]
                if not actionable:
                    continue
                if len(products) >= 100 or len(refs["task_file_ids"]) > 30:
                    raise NativeAdviceContextTooLarge("建议来源超出支持范围")
                revision_id = refs.get("revision_id")
                if revision_id is not None and not isinstance(revision_id, str):
                    continue
                products.append({
                    "product_id": product_id,
                    "fields": actionable,
                    "source_refs": {
                        "product_id": product_id,
                        "revision_id": revision_id,
                        "task_file_ids": refs["task_file_ids"],
                    },
                })
            return {"schema_version": "native-advice-context.v1", "role": role_id, "products": products}
        if role_id == "delivery_quality":
            source_refs = result.get("source_refs")
            if not isinstance(source_refs, dict):
                source_refs = {}
            safe_refs = {
                "workflow_task_id": source_refs.get("workflow_task_id"),
                "batch_id": source_refs.get("batch_id"),
                "product_ids": source_refs.get("product_ids"),
            }
            if (
                not isinstance(safe_refs["workflow_task_id"], str)
                or not isinstance(safe_refs["batch_id"], str)
                or not isinstance(safe_refs["product_ids"], list)
                or any(not isinstance(value, str) or not value for value in safe_refs["product_ids"])
            ):
                safe_refs = None
            checks = []
            canonical_checks = result.get("checks", [])
            if not isinstance(canonical_checks, list):
                raise NativeAdviceContextTooLarge("建议来源超出支持范围")
            if safe_refs is not None and len(safe_refs["product_ids"]) > 1000:
                raise NativeAdviceContextTooLarge("建议来源超出支持范围")
            for item in canonical_checks:
                if not isinstance(item, dict) or item.get("status") != "needs_human" or safe_refs is None:
                    continue
                code = item.get("code")
                if not isinstance(code, str) or not code:
                    continue
                if len(checks) >= 100:
                    raise NativeAdviceContextTooLarge("建议来源超出支持范围")
                check = {"check_code": code, "source_refs": safe_refs}
                product_id = item.get("product_id")
                if isinstance(product_id, str) and product_id:
                    check["product_id"] = product_id
                checks.append(check)
            return {"schema_version": "native-advice-context.v1", "role": role_id, "checks": checks}
        return {"schema_version": "native-advice-context.v1", "role": role_id, "products": [], "checks": []}

    @staticmethod
    def _lock_native_sources(workflow: WorkflowTask) -> None:
        """Serialize source reads against edits while an assignment is begun or submitted."""
        Task.objects.select_for_update().get(pk=workflow.batch_id)
        product_ids = list(
            Product.objects.select_for_update()
            .filter(task_id=workflow.batch_id)
            .order_by("id")
            .values_list("id", flat=True)
        )
        if product_ids:
            list(
                ProductRevision.objects.select_for_update()
                .filter(product_id__in=product_ids)
                .order_by("product_id", "version")
                .values_list("id", flat=True)
            )
        list(
            TaskFile.objects.select_for_update()
            .filter(task_id=workflow.batch_id)
            .order_by("id")
            .values_list("id", flat=True)
        )

    @staticmethod
    def _native_source_fingerprint(workflow: WorkflowTask) -> str:
        """Hash the source facts and file bytes behind deterministic role validation."""
        from pathlib import Path

        from django.conf import settings

        from workbench.agents.context import WorkflowContext

        context = WorkflowContext.from_workflow(workflow)
        batch = context.batch
        source = {
            "batch": {
                "id": batch.id,
                "title": batch.title,
                "mode": batch.mode,
                "status": batch.status,
                "updated_at": batch.updated_at.isoformat(),
            },
            "products": [],
            "task_files": [],
            "image_upload_steps": [],
            "reviews": [],
        }
        for product in context.products:
            revision = context.current_revisions.get(product.id)
            source["products"].append({
                "id": product.id,
                "position": product.position,
                "sku": product.sku,
                "name": product.name,
                "category": product.category,
                "material": product.material,
                "size": product.size,
                "color": product.color,
                "image_filename": product.image_filename,
                "image_stored_name": product.image_stored_name,
                "missing_fields": product.missing_fields,
                "updated_at": product.updated_at.isoformat(),
                "current_revision": ({
                    "id": revision.id,
                    "version": revision.version,
                    "snapshot": revision.snapshot,
                    "field_sources": revision.field_sources,
                    "status": revision.status,
                    "source_refs": revision.source_refs,
                    "updated_at": revision.updated_at.isoformat(),
                } if revision else None),
            })

        media_root = Path(settings.MEDIA_ROOT).resolve()
        for task_file in context.files:
            stored_name = task_file.stored_name
            candidate = (media_root / stored_name).resolve() if isinstance(stored_name, str) else None
            if candidate is None or candidate.name != stored_name:
                raise StaleAttemptResult("assignment来源文件引用无效")
            try:
                candidate.relative_to(media_root)
            except ValueError as exc:
                raise StaleAttemptResult("assignment来源文件引用无效") from exc
            content_sha256 = "missing"
            if candidate.is_file():
                digest = hashlib.sha256()
                try:
                    with candidate.open("rb") as source_file:
                        for chunk in iter(lambda: source_file.read(1024 * 1024), b""):
                            digest.update(chunk)
                except OSError as exc:
                    raise StaleAttemptResult("assignment来源文件无法校验") from exc
                content_sha256 = digest.hexdigest()
            source["task_files"].append({
                "id": task_file.id,
                "kind": task_file.kind,
                "original_name": task_file.original_name,
                "stored_name": stored_name,
                "created_at": task_file.created_at.isoformat(),
                "content_sha256": content_sha256,
            })

        source["image_upload_steps"] = list(
            WorkflowStep.objects.filter(
                task__batch_id=workflow.batch_id,
                step_key__startswith="review_image_upload:",
            ).order_by("id").values("id", "step_key", "status", "input_refs", "output_refs")
        )
        source["reviews"] = list(
            HumanReview.objects.filter(task_id=workflow.id)
            .order_by("id").values("id", "review_key", "item_ref", "status", "answer", "source_conflict", "updated_at")
        )
        for item in source["reviews"]:
            item["updated_at"] = item["updated_at"].isoformat()
        return hashlib.sha256(
            json.dumps(source, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
        ).hexdigest()

    def plan_task(
        self,
        task_id: str,
        confirmed_intent: dict[str, Any] | None = None,
        *,
        execution_mode: str | None = None,
        execution_confirmation_fingerprint: str | None = None,
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
                requested_mode = execution_mode or (
                    confirmed_intent.get("execution_mode")
                    if isinstance(confirmed_intent, dict)
                    else None
                )
                saved_mode = saved.input_refs.get("execution_mode", "local_mock")
                if requested_mode is not None and requested_mode != saved_mode:
                    raise WorkflowOrchestrationError("已保存工作流执行模式不能切换")
                if (
                    requested_mode == "native_dsh"
                    and execution_confirmation_fingerprint is not None
                    and saved.input_refs.get("execution_confirmation_fingerprint")
                    != execution_confirmation_fingerprint
                ):
                    raise WorkflowOrchestrationError("已保存 native_dsh 确认指纹不匹配")
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
            confirmed_mode = confirmed_intent.get("execution_mode") if isinstance(confirmed_intent, dict) else None
            selected_mode = execution_mode or confirmed_mode or "local_mock"
            if selected_mode not in {"local_mock", "native_dsh"} or (confirmed_mode and confirmed_mode != selected_mode):
                raise WorkflowOrchestrationError("执行模式与已确认意图不一致")
            if selected_mode == "native_dsh" and (
                not isinstance(execution_confirmation_fingerprint, str)
                or len(execution_confirmation_fingerprint) != 64
                or any(char not in "0123456789abcdef" for char in execution_confirmation_fingerprint)
            ):
                raise WorkflowOrchestrationError("native_dsh 必须绑定已确认意图指纹")
            rows = _validate_plan(plan)
            now = timezone.now()
            step = WorkflowStep.objects.create(
                task=workflow,
                step_key="center_plan",
                status="running",
                attempt=1,
                idempotency_key=f"workflow:{workflow.id}:center_plan",
                input_refs={
                    "workflow_task_id": workflow.id,
                    "execution_mode": selected_mode,
                    **({"execution_confirmation_fingerprint": execution_confirmation_fingerprint}
                       if execution_confirmation_fingerprint else {}),
                },
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

    @staticmethod
    def _persist_running_subtask_step(
        workflow: WorkflowTask,
        subtask: SubTask,
        *,
        idempotency_key: str,
        attempt: int,
        input_refs: dict[str, Any],
        step_id: str | None = None,
    ) -> WorkflowStep:
        """Persist the shared CAS claim used by mock dispatch and native assignment."""
        if workflow.status in {"queued", "waiting_human"}:
            workflow = transition_workflow(workflow, "running", actor="orchestrator")
        now = timezone.now()
        step = WorkflowStep.objects.create(
            **({"id": step_id} if step_id else {}),
            task=workflow,
            step_key=f"subtask:{subtask.id}",
            status="running",
            attempt=attempt,
            idempotency_key=idempotency_key,
            input_refs=input_refs,
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
        return step

    def begin_native_assignment(
        self,
        workflow_id: str,
        subtask_id: str,
        idempotency_key: str,
        *,
        center_identity: dict[str, Any],
        expected_expert_preset: str,
    ) -> WorkflowStep:
        """Atomically claim a native expert step before the center spawns it."""
        if not idempotency_key or not idempotency_key.strip():
            raise IdempotencyConflict("幂等键不能为空")
        role_presets = {
            "product_profile": "tradeloom-product",
            "delivery_quality": "tradeloom-delivery",
        }
        if expected_expert_preset not in role_presets.values():
            raise SubTaskNotDispatchable("专家角色不在允许范围内")
        identity_keys = {
            "agent_id", "agent_preset", "parent_session", "delegation_depth"
        }
        if (
            not isinstance(center_identity, dict)
            or set(center_identity) != identity_keys
            or not isinstance(center_identity.get("agent_id"), str)
            or not center_identity["agent_id"].strip()
            or center_identity.get("agent_preset") != "tradeloom-center"
            or center_identity.get("parent_session") is not None
            or center_identity.get("delegation_depth") != 0
        ):
            raise SubTaskNotDispatchable("只有根 center 上下文可以开始原生 assignment")

        with transaction.atomic():
            try:
                initial = SubTask.objects.only("task_id").get(pk=subtask_id)
            except SubTask.DoesNotExist as exc:
                from workbench.agents.runtime import UnknownSubTaskError

                raise UnknownSubTaskError(subtask_id) from exc
            workflow = WorkflowTask.objects.select_for_update().get(pk=initial.task_id)
            subtask = SubTask.objects.select_for_update().get(pk=subtask_id)
            if workflow.id != workflow_id:
                from workbench.agents.runtime import UnknownSubTaskError

                raise UnknownSubTaskError(subtask_id)
            plan = WorkflowStep.objects.filter(
                task=workflow, step_key="center_plan", status="completed"
            ).order_by("-attempt", "-created_at", "-id").first()
            if not plan or plan.input_refs.get("execution_mode") != "native_dsh":
                raise SubTaskNotDispatchable("工作流未确认 native_dsh 执行模式")
            confirmation = plan.input_refs.get("execution_confirmation_fingerprint")
            if (
                not isinstance(confirmation, str)
                or len(confirmation) != 64
                or any(char not in "0123456789abcdef" for char in confirmation)
            ):
                raise SubTaskNotDispatchable("native_dsh 缺少已确认意图指纹")
            if role_presets.get(subtask.agent_role) != expected_expert_preset:
                raise SubTaskNotDispatchable("assignment 专家角色与子任务不匹配")

            fingerprint_input = {
                "center": center_identity,
                "expected_expert_preset": expected_expert_preset,
                "subtask_id": subtask.id,
                "source_refs": subtask.input_refs,
            }
            fingerprint = hashlib.sha256(
                json.dumps(
                    fingerprint_input,
                    sort_keys=True,
                    separators=(",", ":"),
                    ensure_ascii=False,
                ).encode("utf-8")
            ).hexdigest()
            keyed = WorkflowStep.objects.select_for_update().filter(
                task=workflow, idempotency_key=idempotency_key
            ).first()
            if keyed:
                assignment = keyed.input_refs.get("native_assignment")
                if (
                    keyed.step_key != f"subtask:{subtask.id}"
                    or keyed.status not in {"running", "completed"}
                    or not isinstance(assignment, dict)
                    or assignment.get("request_fingerprint") != fingerprint
                ):
                    raise IdempotencyConflict("幂等键已绑定其他 assignment")
                return keyed

            prior = WorkflowStep.objects.select_for_update().filter(
                task=workflow, step_key=f"subtask:{subtask.id}"
            ).order_by("-attempt", "-created_at", "-id").first()
            resume_apply_step_id = None
            resume_plan_step_id = None
            attempt = 1
            if prior is not None:
                apply_step = WorkflowStep.objects.select_for_update().filter(
                    task=workflow, step_key="apply_review_cycle", status="completed"
                ).order_by("-created_at", "-id").first()
                authority = (
                    apply_step.output_refs.get("resume_authority", {}).get(subtask.id)
                    if apply_step and isinstance(apply_step.output_refs, dict)
                    else None
                )
                expected_authority = {
                    "role": subtask.agent_role,
                    "expected_prior_step_id": prior.id,
                    "next_attempt": prior.attempt + 1,
                    "input_fingerprint": hashlib.sha256(
                        json.dumps(subtask.input_refs, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
                    ).hexdigest(),
                    "plan_step_id": plan.id,
                }
                expected_key = (
                    f"workflow:{workflow.id}:subtask:{subtask.id}:resume:"
                    f"{apply_step.id if apply_step else ''}:prior:{prior.id}:attempt:{prior.attempt + 1}"
                )
                if (
                    prior.status != "completed"
                    or not isinstance(authority, dict)
                    or any(authority.get(key) != value for key, value in expected_authority.items())
                    or workflow.status != "running"
                    or workflow.current_step != subtask.agent_role
                    or idempotency_key != expected_key
                ):
                    raise IdempotencyConflict("只有最新人工审核授权可以开始新的原生尝试")
                resume_apply_step_id = apply_step.id
                resume_plan_step_id = authority.get("plan_step_id")
                attempt = prior.attempt + 1
            if workflow.status not in {"queued", "running"} or subtask.status != "queued":
                raise SubTaskNotDispatchable("当前工作流或子任务状态不能开始 assignment")
            if HumanReview.objects.filter(
                task=workflow, status__in=["pending", "submitted"]
            ).exists():
                raise DependencyNotReady("存在未解决人工审核，不能开始 assignment")
            dependencies = list(subtask.depends_on.select_for_update().all())
            if any(
                dependency.task_id != workflow.id or dependency.status != "completed"
                for dependency in dependencies
            ):
                raise DependencyNotReady("子任务依赖尚未完成，不能开始 assignment")

            self._lock_native_sources(workflow)
            source_facts_before = self._native_source_fingerprint(workflow)
            canonical_result, source_result_fingerprint = self._canonical_native_result(workflow, subtask)
            advice_context = self._native_advice_context(subtask.agent_role, canonical_result)
            source_facts_fingerprint = self._native_source_fingerprint(workflow)
            if source_facts_before != source_facts_fingerprint:
                raise StaleAttemptResult("assignment来源事实在开始时发生变化")

            from workbench.models import hex_uuid

            step_id = hex_uuid()
            assignment = {
                "assignment_id": step_id,
                "state": "awaiting_expert",
                "center": center_identity,
                "expected_expert_preset": expected_expert_preset,
                "request_fingerprint": fingerprint,
                "source_result_fingerprint": source_result_fingerprint,
                "source_facts_fingerprint": source_facts_fingerprint,
                "advice_context": advice_context,
                "provider": "unknown",
                "model": "unknown",
            }
            step = self._persist_running_subtask_step(
                workflow,
                subtask,
                idempotency_key=idempotency_key,
                attempt=attempt,
                step_id=step_id,
                input_refs={
                    "workflow_task_id": workflow.id,
                    "batch_id": workflow.batch_id,
                    "subtask_id": subtask.id,
                    "agent_role": subtask.agent_role,
                    "source_refs": subtask.input_refs,
                    "execution_mode": "native_dsh",
                    "native_assignment": assignment,
                    **({
                        "review_resume_apply_step_id": resume_apply_step_id,
                        "resume_expected_prior_step_id": prior.id if prior else None,
                        "resume_plan_step_id": resume_plan_step_id,
                        "resume_input_fingerprint": authority["input_fingerprint"],
                    } if resume_apply_step_id else {}),
                },
            )
            return step

    def bind_native_assignment(
        self,
        workflow_id: str,
        assignment_id: str,
        step_id: str,
        *,
        center_identity: dict[str, Any],
        child_identity: dict[str, Any],
    ) -> WorkflowStep:
        """Bind one server-observed direct expert child to a saved assignment."""
        identity_keys = {"agent_id", "agent_preset", "parent_session", "delegation_depth"}
        if (
            not isinstance(center_identity, dict)
            or set(center_identity) != identity_keys
            or not isinstance(center_identity.get("agent_id"), str)
            or center_identity.get("agent_preset") != "tradeloom-center"
            or center_identity.get("parent_session") is not None
            or center_identity.get("delegation_depth") != 0
        ):
            raise SubTaskNotDispatchable("只有根 center 上下文可以绑定原生 assignment")
        if (
            not isinstance(child_identity, dict)
            or set(child_identity) != identity_keys
            or not isinstance(child_identity.get("agent_id"), str)
            or not child_identity["agent_id"].strip()
            or child_identity.get("agent_preset") not in {"tradeloom-product", "tradeloom-delivery"}
            or child_identity.get("parent_session") != center_identity["agent_id"]
            or child_identity.get("delegation_depth") != 1
        ):
            raise SubTaskNotDispatchable("只能绑定 Host 观察到的直接专家子代理")

        with transaction.atomic():
            try:
                workflow = WorkflowTask.objects.select_for_update().get(pk=workflow_id)
                step = WorkflowStep.objects.select_for_update().get(pk=step_id, task=workflow)
                subtask = SubTask.objects.select_for_update().get(
                    pk=step.input_refs.get("subtask_id"), task=workflow
                )
            except (WorkflowTask.DoesNotExist, WorkflowStep.DoesNotExist, SubTask.DoesNotExist) as exc:
                raise UnknownWorkflowTaskError(workflow_id) from exc
            assignment = step.input_refs.get("native_assignment")
            if (
                not isinstance(assignment, dict)
                or assignment.get("assignment_id") != assignment_id
                or step_id != assignment_id
                or step.input_refs.get("execution_mode") != "native_dsh"
            ):
                raise IdempotencyConflict("assignment 不属于原生工作流")
            if assignment.get("center") != center_identity:
                raise SubTaskNotDispatchable("当前 center 与 assignment 不匹配")
            expected_preset = assignment.get("expected_expert_preset")
            role_presets = {
                "product_profile": "tradeloom-product",
                "delivery_quality": "tradeloom-delivery",
            }
            if role_presets.get(subtask.agent_role) != expected_preset:
                raise IdempotencyConflict("assignment 专家角色已变化")
            if child_identity.get("agent_preset") != expected_preset:
                raise SubTaskNotDispatchable("子代理 preset 与 assignment 不匹配")
            if assignment.get("child_agent_id") == child_identity["agent_id"]:
                return step
            if assignment.get("child_agent_id") is not None:
                raise IdempotencyConflict("assignment 已绑定其他子代理")
            if step.status != "running":
                raise StaleAttemptResult("assignment 不再处于可绑定状态")

            assignment["child_agent_id"] = child_identity["agent_id"]
            assignment["child_binding"] = {
                "agent_preset": child_identity["agent_preset"],
                "parent_session": child_identity["parent_session"],
                "delegation_depth": child_identity["delegation_depth"],
            }
            step.input_refs["native_assignment"] = assignment
            step.save(update_fields=["input_refs", "updated_at"])
            return step

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
            self._assert_mock_execution_mode(workflow)
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
            input_refs = {
                    "subtask_id": subtask.id,
                    "agent_role": subtask.agent_role,
                    "source_refs": subtask.input_refs,
                    **({
                        "review_resume_apply_step_id": resume_apply_step_id,
                        "resume_expected_prior_step_id": prior.id if prior else None,
                        "resume_plan_step_id": resume_plan_step_id,
                        "resume_input_fingerprint": authority["input_fingerprint"],
                    } if resume_apply_step_id else {}),
                }
            step = self._persist_running_subtask_step(
                workflow,
                subtask,
                idempotency_key=idempotency_key,
                attempt=attempt,
                input_refs=input_refs,
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
            self._assert_mock_execution_mode(workflow)

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
            execution_mode = step.input_refs.get("execution_mode", "local_mock")
            safe_retry = (
                execution_mode != "native_dsh"
                and getattr(self.runtime, "supports_safe_retry", False) is True
            )
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

    @staticmethod
    def _validate_native_advice(role_id: str, advice: Any) -> dict[str, Any]:
        if not isinstance(advice, dict) or set(advice) != {"schema_version", "observations"}:
            raise InvalidAgentResult("原生专家建议格式无效")
        if advice.get("schema_version") != "native-expert-advice.v1":
            raise InvalidAgentResult("原生专家建议版本不受支持")
        observations = advice.get("observations")
        if not isinstance(observations, list) or len(observations) > 20:
            raise InvalidAgentResult("原生专家建议条目超出范围")
        normalized = []
        if role_id == "product_profile":
            allowed_fields = {"sku", "name", "category", "material", "size", "color", "english_name"}
            for item in observations:
                if (
                    not isinstance(item, dict)
                    or not {"product_id", "field", "note", "source_refs"}.issubset(item)
                    or set(item) - {"product_id", "field", "note", "source_refs", "suggested_value"}
                    or not isinstance(item.get("product_id"), str)
                    or not item["product_id"].strip()
                    or item.get("field") not in allowed_fields
                    or not isinstance(item.get("source_refs"), dict)
                    or set(item["source_refs"]) != {"product_id", "revision_id", "task_file_ids"}
                    or item["source_refs"].get("product_id") != item.get("product_id")
                    or not (item["source_refs"].get("revision_id") is None or (
                        isinstance(item["source_refs"].get("revision_id"), str)
                        and bool(item["source_refs"]["revision_id"].strip())
                    ))
                    or not isinstance(item["source_refs"].get("task_file_ids"), list)
                    or any(not isinstance(value, str) or not value.strip() for value in item["source_refs"]["task_file_ids"])
                    or not isinstance(item.get("note"), str)
                    or not item["note"].strip()
                    or len(item["note"]) > 500
                    or ("suggested_value" in item and (
                        not isinstance(item["suggested_value"], str)
                        or len(item["suggested_value"]) > 500
                    ))
                ):
                    raise InvalidAgentResult("商品专家建议字段无效")
                normalized.append({
                    "product_id": item["product_id"],
                    "field": item["field"],
                    "source_refs": item["source_refs"],
                    "note": item["note"].strip(),
                    **({"suggested_value": item["suggested_value"]} if "suggested_value" in item else {}),
                })
        elif role_id == "delivery_quality":
            for item in observations:
                if (
                    not isinstance(item, dict)
                    or not {"check_code", "note", "source_refs"}.issubset(item)
                    or set(item) - {"check_code", "product_id", "note", "source_refs"}
                    or not isinstance(item.get("check_code"), str)
                    or not item["check_code"].strip()
                    or not isinstance(item.get("note"), str)
                    or not item["note"].strip()
                    or len(item["check_code"]) > 80
                    or len(item["note"]) > 500
                    or not isinstance(item.get("source_refs"), dict)
                    or set(item["source_refs"]) != {"workflow_task_id", "batch_id", "product_ids"}
                    or not isinstance(item["source_refs"].get("workflow_task_id"), str)
                    or not isinstance(item["source_refs"].get("batch_id"), str)
                    or not isinstance(item["source_refs"].get("product_ids"), list)
                    or any(not isinstance(value, str) or not value.strip() for value in item["source_refs"]["product_ids"])
                    or ("product_id" in item and (
                        not isinstance(item["product_id"], str) or not item["product_id"].strip()
                    ))
                ):
                    raise InvalidAgentResult("交付专家建议字段无效")
                normalized.append({
                    "check_code": item["check_code"].strip(),
                    "note": item["note"].strip(),
                    "source_refs": item["source_refs"],
                    **({"product_id": item["product_id"]} if "product_id" in item else {}),
                })
        else:
            raise InvalidAgentResult("原生专家角色不受支持")
        return {"schema_version": "native-expert-advice.v1", "observations": normalized}

    def submit_native_assignment(
        self,
        workflow_id: str,
        assignment_id: str,
        step_id: str,
        *,
        child_identity: dict[str, Any],
        advice: Any,
    ) -> dict[str, Any]:
        if not isinstance(assignment_id, str) or not assignment_id or assignment_id != step_id:
            raise IdempotencyConflict("assignment 与 WorkflowStep 不匹配")
        identity_keys = {"agent_id", "agent_preset", "parent_session", "delegation_depth"}
        if (
            not isinstance(child_identity, dict)
            or set(child_identity) != identity_keys
            or not isinstance(child_identity.get("agent_id"), str)
            or not child_identity["agent_id"].strip()
            or child_identity.get("agent_preset") not in {"tradeloom-product", "tradeloom-delivery"}
            or not isinstance(child_identity.get("parent_session"), str)
            or child_identity.get("delegation_depth") != 1
        ):
            raise SubTaskNotDispatchable("只接受直接专家子代理的Host身份")

        with transaction.atomic():
            try:
                workflow = WorkflowTask.objects.select_for_update().get(pk=workflow_id)
                step = WorkflowStep.objects.select_for_update().get(pk=step_id, task=workflow)
                subtask = SubTask.objects.select_for_update().get(
                    pk=step.input_refs.get("subtask_id"), task=workflow
                )
            except (WorkflowTask.DoesNotExist, WorkflowStep.DoesNotExist, SubTask.DoesNotExist) as exc:
                raise UnknownWorkflowTaskError(workflow_id) from exc
            assignment = step.input_refs.get("native_assignment")
            if (
                not isinstance(assignment, dict)
                or assignment.get("assignment_id") != assignment_id
                or step.input_refs.get("execution_mode") != "native_dsh"
            ):
                raise IdempotencyConflict("assignment 不属于原生工作流")
            expected_preset = assignment.get("expected_expert_preset")
            if child_identity.get("agent_preset") != expected_preset:
                raise SubTaskNotDispatchable("专家preset与assignment不匹配")
            center = assignment.get("center")
            if (
                not isinstance(center, dict)
                or child_identity.get("parent_session") != center.get("agent_id")
                or child_identity.get("agent_id") == center.get("agent_id")
            ):
                raise SubTaskNotDispatchable("专家不是assignment所属center的直接子代理")
            role_for_preset = {
                "tradeloom-product": "product_profile",
                "tradeloom-delivery": "delivery_quality",
            }
            if role_for_preset.get(expected_preset) != subtask.agent_role:
                raise IdempotencyConflict("assignment专家角色已变化")

            normalized_advice = self._validate_native_advice(subtask.agent_role, advice)
            fingerprint = hashlib.sha256(
                json.dumps(
                    {"child_agent_id": child_identity["agent_id"], "advice": normalized_advice},
                    sort_keys=True,
                    separators=(",", ":"),
                    ensure_ascii=False,
                ).encode("utf-8")
            ).hexdigest()
            if step.status == "completed":
                saved = step.output_refs.get("native_submission")
                if (
                    isinstance(saved, dict)
                    and saved.get("child_agent_id") == child_identity["agent_id"]
                    and saved.get("request_fingerprint") == fingerprint
                    and isinstance(saved.get("receipt"), dict)
                ):
                    return saved["receipt"]
                raise IdempotencyConflict("已完成assignment只能重放相同专家结果")
            if step.status != "running":
                raise StaleAttemptResult("assignment不再处于可提交状态")

            bound_agent = assignment.get("child_agent_id")
            if bound_agent != child_identity["agent_id"]:
                raise IdempotencyConflict("提交者不是已绑定到assignment的子代理")
            source_refs = step.input_refs.get("source_refs")
            if source_refs != subtask.input_refs:
                raise StaleAttemptResult("assignment来源引用已变化")

            self._lock_native_sources(workflow)
            source_facts_before = self._native_source_fingerprint(workflow)
            try:
                canonical, source_result_fingerprint = self._canonical_native_result(workflow, subtask)
            except StaleAttemptResult:
                raise
            source_facts_after = self._native_source_fingerprint(workflow)
            if assignment.get("source_result_fingerprint") != source_result_fingerprint:
                raise StaleAttemptResult("assignment来源数据在提交前已变化")
            if source_facts_before != source_facts_after:
                raise StaleAttemptResult("assignment来源事实在复核时发生变化")
            if assignment.get("source_facts_fingerprint") != source_facts_after:
                raise StaleAttemptResult("assignment来源事实或文件字节在提交前已变化")

            self._attach_native_advice(subtask.agent_role, canonical, normalized_advice)
            canonical = {**canonical, **workflow_markers("native_dsh")}
            assignment["child_agent_id"] = child_identity["agent_id"]
            step.input_refs["native_assignment"] = assignment
            step.save(update_fields=["input_refs", "updated_at"])
            target_status = "waiting_human" if canonical.get("status") == "needs_human" else (
                "failed" if canonical.get("status") == "blocked" else "completed"
            )
            receipt = {
                "assignment_id": assignment_id,
                "step_id": step_id,
                "status": "accepted",
                "result_status": canonical.get("status"),
                "subtask_status": target_status,
                "execution_mode": "native_dsh",
                "provider": "unknown",
                "model": "unknown",
                "child_lifecycle": "not_observed",
            }
            submission = {
                "state": "accepted_not_settled",
                "child_agent_id": child_identity["agent_id"],
                "request_fingerprint": fingerprint,
                "advice": normalized_advice,
                "provider": "unknown",
                "model": "unknown",
                "receipt": receipt,
            }
            self._record_result(
                workflow.id,
                subtask.id,
                step.id,
                canonical,
                completion_metadata={"native_submission": submission},
            )
            return receipt

    @staticmethod
    def _attach_native_advice(role_id: str, canonical: dict[str, Any], advice: dict[str, Any]) -> None:
        observations = advice["observations"]
        if not observations:
            return
        if role_id == "product_profile":
            by_id = {
                item.get("product_id"): item
                for item in canonical.get("products", [])
                if isinstance(item, dict) and isinstance(item.get("product_id"), str)
            }
            for observation in observations:
                item = by_id.get(observation["product_id"])
                item_refs = item.get("source_refs") if isinstance(item, dict) else None
                expected_refs = {
                    key: item_refs.get(key)
                    for key in ("product_id", "revision_id", "task_file_ids")
                } if isinstance(item_refs, dict) else None
                if (
                    item is None
                    or observation["field"] not in item.get("missing_fields", [])
                    or expected_refs != observation["source_refs"]
                ):
                    raise InvalidAgentResult("商品建议必须对应服务端确认的待补字段")
                item.setdefault("native_advice", []).append(observation)
            return
        checks = canonical.get("checks", [])
        for observation in observations:
            match = next((
                check for check in checks
                if isinstance(check, dict)
                and check.get("status") == "needs_human"
                and check.get("code") == observation["check_code"]
                and ("product_id" not in observation or check.get("product_id") == observation["product_id"])
                and canonical.get("source_refs") == observation["source_refs"]
            ), None)
            if match is None:
                raise InvalidAgentResult("交付建议必须对应服务端确认的待审核检查")
            match.setdefault("native_advice", []).append(observation)

    def _record_result(
        self,
        task_id: str,
        subtask_id: str,
        step_id: str,
        result: dict[str, Any],
        *,
        completion_metadata: dict[str, Any] | None = None,
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
                **(completion_metadata or {}),
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
