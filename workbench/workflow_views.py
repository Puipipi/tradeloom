from __future__ import annotations

import hashlib
import json
from typing import Any

from django.http import Http404
from django.shortcuts import render
from django.views.decorators.csrf import ensure_csrf_cookie
from django.views.decorators.http import require_http_methods

from .agents.context import WorkflowContext
from .models import EventLog, WorkflowStep
from .delivery.service import (
    GENERATION_RECOVERY_KEY,
    MAX_GENERATION_ATTEMPTS,
    _consecutive_generation_failures,
    list_workflow_deliverables,
)
from .views import (
    ARTIFACT_TYPE_LABELS,
    AGENT_ROLE_LABELS,
    STATUS_LABELS,
    STEP_LABELS,
    TASK_TYPE_LABELS,
    _page_context,
    _label,
    _short_local_time,
)
from .workflows.prepare import (
    UnknownPreparedWorkflowError,
    get_prepared_workflow,
    serialize_prepared_workflow,
)
from .workflows.orchestrator import MAX_SUBTASK_ATTEMPTS
from .workflows.dispatch_target import resolve_dispatch_target


REFERENCE_KEYS = {
    "workflow_task_id": "工作流 ID",
    "batch_id": "批次 ID",
    "product_id": "产品 ID",
    "product_ids": "产品 ID",
    "all_product_ids": "全批产品 ID",
    "revision_id": "版本 ID",
    "revision_ids": "版本 ID",
    "product_revision_ids": "产品版本 ID",
    "all_revision_ids": "全批版本 ID",
    "confirmed_revision_ids": "已确认版本 ID",
    "task_file_ids": "文件 ID",
    "subtask_id": "子任务 ID",
    "subtask_ids": "子任务 ID",
    "canonical_result_ref": "规范结果引用",
    "result_ref": "结果引用",
    "scope": "数据范围",
}

EVENT_LABELS = {
    "workflow_step_started": "步骤开始",
    "subtask_created": "创建子任务",
    "workflow_plan_completed": "计划保存",
    "delivery_generation_started": "交付文件生成开始",
    "delivery_generation_completed": "交付文件已生成并通过质检",
    "delivery_generation_failed": "交付文件生成失败",
    "delivery_generation_taken_over": "交付生成结果未知并已接管",
    "delivery_bundle_reviewed": "交付文件审核完成",
    "workflow_delivery_completed": "工作流完成",
    "workflow_status_changed": "工作流状态变化",
    "subtask_started": "子任务开始",
    "subtask_failed": "子任务失败",
    "subtask_retry_started": "开始一次显式重试",
    "subtask_retry_exhausted": "重试次数已达上限",
    "subtask_interrupted": "执行中断并已接管",
    "subtask_waiting_human": "等待人工填写",
    "subtask_completed": "子任务完成",
    "workflow_execution_paused": "工作流暂停等待核验",
    "workflow_execution_failed": "工作流执行失败",
    "human_review_created": "创建人审事项",
    "human_review_submitted": "提交说明回执",
    "human_review_cycle_applied": "应用并确认本批基础资料",
}

ACTOR_LABELS = {
    "center": "中心规划",
    "orchestrator": "工作流协调",
    "human_reviewer": "填写人",
    "product_profile": "产品资料",
    "delivery_quality": "交付质检",
    "operator": "操作人标签",
}

FACT_FIELD_LABELS = {
    "sku": "SKU",
    "name": "中文名称",
    "category": "品类",
    "material": "材质",
    "size": "尺寸",
    "color": "颜色",
    "english_name": "英文名称（人工填写）",
}
PRODUCT_COLUMN_FIELDS = frozenset(FACT_FIELD_LABELS) - {"english_name"}

GRAPH_REF_KEYS = (
    "batch_id",
    "product_id",
    "product_ids",
    "all_product_ids",
    "revision_id",
    "revision_ids",
    "product_revision_ids",
    "all_revision_ids",
    "confirmed_revision_ids",
    "task_file_ids",
    "subtask_id",
    "subtask_ids",
    "scope",
)


def _graph_refs(value: Any, allowed_keys: tuple[str, ...] = GRAPH_REF_KEYS) -> dict[str, Any]:
    """Project reference-only identifiers; never pass arbitrary persisted JSON to the graph."""
    if not isinstance(value, dict):
        return {}
    projected = {}
    for key in allowed_keys:
        item = value.get(key)
        if key == "scope":
            if item == "full_batch":
                projected[key] = item
            continue
        if isinstance(item, str) and len(item) <= 240:
            projected[key] = item
        elif isinstance(item, list):
            projected[key] = [part for part in item if isinstance(part, str) and len(part) <= 240][:200]
    return projected


def _graph_schema(value: Any) -> dict[str, Any]:
    """Keep structural schema facts while excluding examples, defaults, and runtime values."""
    if not isinstance(value, dict):
        return {}
    projected: dict[str, Any] = {}
    for key in ("type", "format", "minItems", "maxItems", "minLength", "maxLength", "minimum", "maximum"):
        item = value.get(key)
        if isinstance(item, (str, int, float)) and not isinstance(item, bool):
            projected[key] = item
    required = value.get("required")
    if isinstance(required, list):
        projected["required"] = [item for item in required if isinstance(item, str)][:200]
    properties = value.get("properties")
    if isinstance(properties, dict):
        projected["properties"] = {
            key: _graph_schema(item)
            for key, item in list(properties.items())[:200]
            if isinstance(key, str) and len(key) <= 120 and isinstance(item, dict)
        }
    items = value.get("items")
    if isinstance(items, dict):
        projected["items"] = _graph_schema(items)
    additional = value.get("additionalProperties")
    if isinstance(additional, bool):
        projected["additionalProperties"] = additional
    elif isinstance(additional, dict):
        projected["additionalProperties"] = _graph_schema(additional)
    return projected


def _graph_result_summary(value: Any) -> dict[str, Any]:
    """Expose only small, stable outcome fields on a graph node."""
    result = value.get("result") if isinstance(value, dict) else None
    if not isinstance(result, dict):
        return {}
    projected = {}
    for key in ("status", "data_readiness", "quality_scope"):
        item = result.get(key)
        if isinstance(item, str) and len(item) <= 80:
            projected[key] = item
    generated = result.get("artifacts_generated")
    if isinstance(generated, bool):
        projected["artifacts_generated"] = generated
    for key in ("products", "checks"):
        item = result.get(key)
        if isinstance(item, list):
            projected[f"{key}_count"] = len(item)
    return projected


def _reference_rows(value: Any) -> list[dict[str, str]]:
    if not isinstance(value, dict):
        return []
    rows = []
    sources = [value]
    nested = value.get("source_refs")
    if isinstance(nested, dict):
        sources.append(nested)
    for source in sources:
        for key, label in REFERENCE_KEYS.items():
            item = source.get(key)
            if isinstance(item, str) and item:
                rows.append({"label": label, "value": item})
            elif isinstance(item, list):
                values = [str(part) for part in item if isinstance(part, (str, int))]
                if values:
                    rows.append({"label": label, "value": "、".join(values)})
    return rows


def _native_advice_rows(source_conflict: Any) -> list[dict[str, Any]]:
    if not isinstance(source_conflict, dict):
        return []
    source_refs = source_conflict.get("source_refs")
    if not isinstance(source_refs, dict):
        return []
    observations = source_refs.get("native_expert_advice")
    if not isinstance(observations, list):
        return []
    rows = []
    for item in observations[:20]:
        if not isinstance(item, dict):
            continue
        note = item.get("note")
        if not isinstance(note, str) or not note.strip():
            continue
        field_name = item.get("field")
        check_code = item.get("check_code")
        label = FACT_FIELD_LABELS.get(field_name, "") if isinstance(field_name, str) else ""
        if not label and isinstance(check_code, str):
            label = check_code[:80]
        advice = {"label": label, "note": note[:500], "source_rows": _reference_rows(item.get("source_refs"))}
        suggested_value = item.get("suggested_value")
        if isinstance(suggested_value, str):
            advice["suggested_value"] = suggested_value[:500]
        rows.append(advice)
    return rows


def _result_summary(value: Any) -> list[dict[str, str]]:
    if not isinstance(value, dict):
        return []
    result = value.get("result")
    if not isinstance(result, dict):
        return []
    labels = {
        "status": "结果状态",
        "data_readiness": "资料就绪度",
        "quality_scope": "检查范围",
        "artifacts_generated": "已生成文件",
    }
    rows = []
    for key, label in labels.items():
        item = result.get(key)
        if isinstance(item, (str, int, bool)):
            rows.append({"label": label, "value": str(item)})
    products = result.get("products")
    if isinstance(products, list):
        rows.append({"label": "结构化产品结果", "value": f"{len(products)} 项"})
    checks = result.get("checks")
    if isinstance(checks, list):
        rows.append({"label": "结构化检查结果", "value": f"{len(checks)} 项"})
    return rows


def _event_summary(payload: Any) -> str:
    if not isinstance(payload, dict):
        return ""
    parts = []
    for key in ("from_status", "to_status", "status", "role", "attempt"):
        value = payload.get(key)
        if isinstance(value, (str, int)) and value:
            if key == "role":
                value = _label(AGENT_ROLE_LABELS, str(value))
            elif key in {"from_status", "to_status", "status"}:
                value = _label(STATUS_LABELS, str(value))
            parts.append(str(value))
    return " · ".join(parts)


@ensure_csrf_cookie
@require_http_methods(["GET"])
def workflow_detail(request, workflow_id: str):
    try:
        workflow = get_prepared_workflow(workflow_id)
    except UnknownPreparedWorkflowError as exc:
        raise Http404("工作流不存在") from exc

    data = serialize_prepared_workflow(workflow)
    subtasks = list(workflow.subtasks.all())
    dispatch = resolve_dispatch_target(workflow, status_label=lambda value: _label(STATUS_LABELS, value))
    dispatch_target = (
        {"subtask_id": dispatch["subtask_id"], "idempotency_key": dispatch["idempotency_key"],
         "url": f"/api/workflow-tasks/{workflow.id}/subtasks/{dispatch['subtask_id']}/dispatch"}
        if dispatch["subtask_id"] else None
    )
    dispatch_blocked_reason = dispatch["blocked_reason"]
    plan = data.get("plan") if isinstance(data.get("plan"), dict) else {}
    classification = plan.get("classification")
    classification = classification if isinstance(classification, dict) else {}
    for item in plan.get("subtasks", []):
        if isinstance(item, dict):
            item["role_label"] = _label(
                AGENT_ROLE_LABELS,
                item.get("agent_role"),
            )
    for step in data["steps"]:
        step["step_label"] = _label(STEP_LABELS, step["step_key"])
        step["status_label"] = _label(STATUS_LABELS, step["status"])
        step["started_at_display"] = _short_local_time(step["started_at"])
        step["finished_at_display"] = _short_local_time(step["finished_at"])
        step["input_source_rows"] = _reference_rows(step["input_refs"])
        step["output_source_rows"] = _reference_rows(step["output_refs"])
    latest_attempt_by_subtask = {}
    for step in data["steps"]:
        subtask_id = step.get("input_refs", {}).get("subtask_id")
        if subtask_id and step.get("step_key", "").startswith("subtask:"):
            latest_attempt_by_subtask[subtask_id] = step
    for step in latest_attempt_by_subtask.values():
        subtask = next((item for item in data["subtasks"] if item["id"] == step["input_refs"].get("subtask_id")), None)
        if subtask is None:
            continue
        step["retry_remaining"] = max(0, MAX_SUBTASK_ATTEMPTS - 1 - subtask["retry_count"])
        dependency_status = {item["id"]: item["status"] for item in data["subtasks"]}
        step["retry_available"] = bool(
            step["status"] == "failed"
            and subtask["status"] == "failed"
            and step["output_refs"].get("retryable") is True
            and subtask["retry_count"] < MAX_SUBTASK_ATTEMPTS - 1
            and data["status"] in {"failed", "running"}
            and data["unresolved_review_count"] == 0
            and all(
                dependency_status.get(dependency_id) == "completed"
                for dependency_id in subtask["depends_on"]
            )
        )
        step["interrupt_available"] = bool(
            step["status"] == "running" and subtask["status"] == "running"
        )
        step["retry_url"] = f"/api/workflow-tasks/{workflow.id}/subtasks/{subtask['id']}/retry"
        step["interrupt_url"] = f"/api/workflow-tasks/{workflow.id}/subtasks/{subtask['id']}/interrupt"
        step["retry_key"] = f"workflow:{workflow.id}:subtask:{subtask['id']}:attempt:{step['attempt'] + 1}"
    for subtask in data["subtasks"]:
        subtask["role_label"] = _label(AGENT_ROLE_LABELS, subtask["agent_role"])
        subtask["status_label"] = _label(STATUS_LABELS, subtask["status"])
        subtask["input_source_rows"] = _reference_rows(subtask["input_refs"])
        result_refs = subtask["output_refs"]
        subtask["output_source_rows"] = _reference_rows(
            result_refs.get("source_refs") if isinstance(result_refs, dict) else None
        )
        subtask["result_summary"] = _result_summary(result_refs)
    for review in data["reviews"]:
        review["status_label"] = _label(STATUS_LABELS, review["status"])
        review["created_at_display"] = _short_local_time(review["created_at"])
        answer = review["answer"] if isinstance(review["answer"], dict) else {}
        review["submitted_at_display"] = _short_local_time(answer.get("submitted_at"))
        response = answer.get("response")
        review["note"] = (
            response.get("note")
            if isinstance(response, dict) and isinstance(response.get("note"), str)
            else ""
        )
        review["has_other_answer"] = bool(response) and not review["note"]
        review["source_rows"] = _reference_rows(review["source_refs"])
        options = review["options"] if isinstance(review["options"], list) else []
        review["options_display"] = [
            item for item in options if isinstance(item, str)
        ]

    # 版本/评审链已下线：人审事项不再产生，页面只保留交付审核入口。
    data["reviews"] = []
    data["unresolved_review_count"] = 0
    data["pending_review_count"] = 0
    unresolved_reviews: list[dict[str, Any]] = []
    apply_review_target = None
    facts_cycle_applied = False
    english_name_hints: list[dict[str, Any]] = []

    events = []
    for event in EventLog.objects.filter(task_id=workflow.id).order_by("created_at", "id"):
        events.append(
            {
                "id": event.id,
                "event_type": EVENT_LABELS.get(event.event_type, event.event_type),
                "actor": ACTOR_LABELS.get(event.actor, event.actor),
                "created_at_display": _short_local_time(event.created_at),
                "summary": _event_summary(event.payload_summary),
            }
        )

    latest_generation = WorkflowStep.objects.filter(
        task=workflow, step_key="generate_deliverables"
    ).order_by("-attempt", "-created_at", "-id").first()
    generation_attempt = (latest_generation.attempt + 1) if latest_generation else 1
    generation_steps = list(
        WorkflowStep.objects.filter(task=workflow, step_key="generate_deliverables")
        .order_by("attempt", "created_at", "id")
    )
    generation_failures = _consecutive_generation_failures(generation_steps)
    generation_retry_remaining = max(0, MAX_GENERATION_ATTEMPTS - generation_failures)
    latest_recovery = (
        latest_generation.output_refs.get(GENERATION_RECOVERY_KEY, {})
        if latest_generation and isinstance(latest_generation.output_refs, dict)
        else {}
    )
    generation_outcome_unknown = bool(
        isinstance(latest_recovery, dict) and latest_recovery.get("outcome_unknown") is True
    )
    generation_available = bool(
        (workflow.status == "running" and workflow.current_step == "generate_deliverables" and latest_generation is None)
        or (
            workflow.status == "failed"
            and workflow.current_step == "generate_deliverables_failed"
            and latest_generation
            and latest_generation.status == "failed"
            and generation_failures < MAX_GENERATION_ATTEMPTS
        )
        or (workflow.status == "running" and workflow.current_step == "deliverables_rejected" and latest_generation and latest_generation.status == "completed")
    )
    generation_takeover_available = bool(
        workflow.status == "running"
        and workflow.current_step == "generate_deliverables"
        and latest_generation
        and latest_generation.status == "running"
        and data["unresolved_review_count"] == 0
    )
    review_available = bool(
        workflow.status == "waiting_human"
        and workflow.current_step == "review_deliverables"
        and latest_generation
        and latest_generation.status == "completed"
        and data["unresolved_review_count"] == 0
    )
    deliverables = list_workflow_deliverables(workflow.id)
    for artifact in deliverables["artifacts"]:
        artifact["status_label"] = _label(STATUS_LABELS, artifact.get("status"))
        for version in artifact["versions"]:
            version["status_label"] = _label(STATUS_LABELS, version.get("status"))

    # The graph gets a purpose-built DTO. Persisted JSON fields can contain
    # user data, execution output, or private extensions, so they are never
    # passed through wholesale to client-side node inspectors.
    workflow_graph_plan = []
    for index, item in enumerate(plan.get("subtasks", []) if isinstance(plan.get("subtasks"), list) else []):
        if not isinstance(item, dict):
            continue
        workflow_graph_plan.append({
            "key": item.get("key") if isinstance(item.get("key"), str) else "",
            "agent_role": item.get("agent_role") if isinstance(item.get("agent_role"), str) else "",
            "role_label": item.get("role_label") if isinstance(item.get("role_label"), str) else "",
            "order": item.get("order") if isinstance(item.get("order"), int) else index + 1,
            "depends_on": [value for value in item.get("depends_on", []) if isinstance(value, str)] if isinstance(item.get("depends_on"), list) else [],
            "required_fields": [value for value in item.get("required_fields", []) if isinstance(value, str)] if isinstance(item.get("required_fields"), list) else [],
            "input_schema": _graph_schema(item.get("input_schema")),
            "output_schema": _graph_schema(item.get("output_schema")),
            "input_refs": _graph_refs(item.get("input_refs")),
        })
    workflow_graph_subtasks = []
    for subtask in data["subtasks"]:
        safe_output = _graph_result_summary(subtask.get("output_refs"))
        workflow_graph_subtasks.append({
            "id": subtask["id"],
            "agent_role": subtask["agent_role"],
            "role_label": subtask["role_label"],
            "status": subtask["status"],
            "status_label": subtask["status_label"],
            "depends_on": [value for value in subtask["depends_on"] if isinstance(value, str)],
            "input_refs": _graph_refs(subtask.get("input_refs")),
            "output_refs": {"result": safe_output} if safe_output else {},
        })
    workflow_graph_steps = []
    for step in data["steps"]:
        input_refs = step.get("input_refs") if isinstance(step.get("input_refs"), dict) else {}
        output_refs = step.get("output_refs") if isinstance(step.get("output_refs"), dict) else {}
        workflow_graph_steps.append({
            "id": step["id"],
            "step_key": step["step_key"],
            "step_label": step["step_label"],
            "status": step["status"],
            "status_label": step["status_label"],
            "attempt": step["attempt"],
            "input_refs": _graph_refs(input_refs, ("subtask_id", "review_ids")),
            "output_refs": _graph_refs(output_refs, ("artifact_version_ids", "review_ids")),
        })

    # The graph receives only the persisted review references needed to draw
    # provenance edges. Editable review answers remain in the existing forms.
    workflow_graph_reviews = []
    for review in data["reviews"]:
        metadata = source_conflict_by_id.get(review["id"])
        metadata = metadata if isinstance(metadata, dict) else {}
        subtask_id = metadata.get("subtask_id") if isinstance(metadata.get("subtask_id"), str) else ""
        origin_step_id = metadata.get("origin_step_id") if isinstance(metadata.get("origin_step_id"), str) else ""
        raw_result_ref = metadata.get("result_ref")
        expected_result_ref = (
            f"workflow_step:{origin_step_id}:output_refs.result_snapshot"
            if origin_step_id
            else f"subtask:{subtask_id}:output_refs.result" if subtask_id else ""
        )
        workflow_graph_reviews.append({
            "id": review["id"],
            "item_ref": review["item_ref"],
            "question": review["question"],
            "options": review["options_display"],
            "status": review["status"],
            "status_label": review["status_label"],
            "source_refs": _graph_refs(review.get("source_refs"), ("product_id", "revision_id")),
            "subtask_id": subtask_id,
            "origin_step_id": origin_step_id,
            "result_ref": expected_result_ref if raw_result_ref == expected_result_ref else "",
            "ui_kind": review["ui_kind"],
            "ui_supported": review["ui_supported"],
            "ui_applied": review["ui_applied"],
        })
    workflow_graph_artifacts = []
    for artifact in deliverables["artifacts"]:
        workflow_graph_artifacts.append({
            "id": artifact["id"],
            "artifact_type": artifact["artifact_type"],
            "current_version": artifact["current_version"],
            "status": artifact["status"],
            "status_label": artifact["status_label"],
            "versions": [
                {
                    "id": version["id"],
                    "version": version["version"],
                    "status": version["status"],
                    "status_label": version["status_label"],
                    "sha256": version["sha256"],
                    "preview_url": version["preview_url"],
                    "download_url": version["download_url"],
                }
                for version in artifact["versions"]
            ],
            "artifact_type_label": ARTIFACT_TYPE_LABELS.get(
                artifact.get("artifact_type"), artifact.get("artifact_type", "交付文件")
            ),
        })

    return render(
        request,
        "workbench/workflow_detail.html",
        _page_context(
            "agent_center",
            workflow=data,
            batch=workflow.batch,
            task_type_label=_label(TASK_TYPE_LABELS, data["task_type"]),
            status_label=_label(STATUS_LABELS, data["status"]),
            classification_summary=classification.get("reason", "已保存的计划"),
            events=events,
            dispatch_target=dispatch_target,
            dispatch_blocked_reason=dispatch_blocked_reason,
            native_dsh=data.get("execution_mode") == "native_dsh",
            apply_review_target=apply_review_target,
            facts_cycle_applied=facts_cycle_applied,
            english_name_hints=english_name_hints,
            latest_generation=latest_generation,
            generation_available=generation_available,
            generation_key=f"workflow:{workflow.id}:deliverables:{generation_attempt}",
            generation_takeover_available=generation_takeover_available,
            generation_takeover_key=(
                f"workflow:{workflow.id}:deliverables:{latest_generation.id}:takeover"
                if latest_generation else ""
            ),
            generation_takeover_url=(
                f"/api/workflow-tasks/{workflow.id}/deliverables/{latest_generation.id}/takeover"
                if latest_generation else ""
            ),
            generation_retry_remaining=generation_retry_remaining,
            generation_outcome_unknown=generation_outcome_unknown,
            review_available=review_available,
            complete_available=workflow.status == "running" and workflow.current_step == "complete_workflow",
            deliverables=deliverables,
            workflow_graph_reviews=workflow_graph_reviews,
            workflow_graph_artifacts=workflow_graph_artifacts,
            workflow_graph_plan=workflow_graph_plan,
            workflow_graph_subtasks=workflow_graph_subtasks,
            workflow_graph_steps=workflow_graph_steps,
        ),
    )
