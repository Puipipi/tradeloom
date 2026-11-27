from __future__ import annotations

import hashlib
import csv
import hmac
import io
import json
import os
from pathlib import Path

from django.conf import settings
from django.contrib.staticfiles import finders
from django.http import FileResponse, HttpRequest, JsonResponse, HttpResponse
from django.shortcuts import render
from django.utils.safestring import mark_safe
from django.views.decorators.http import require_http_methods, require_POST

from .business_urls import public_url
from .diagnostics import collect_local_diagnostics
from .agents.workflow_contracts import UnknownTaskIntent
from .agents.collaboration import collaboration_event_metadata, project_collaboration_envelope
from .agents.adapters import safe_adapter_capabilities
from .agents.registry import CapabilityUnavailableError, UnknownCapabilityError
from .agents.runtime import UnknownSubTaskError
from .models import TaskFile
from .services import (
    AgentRunInProgressError,
    AgentRunReplayError,
    UploadValidationError,
    WorkbenchConflictError,
    WorkbenchNotFoundError,
    WorkbenchService,
)
from .workflows.prepare import (
    WorkflowCreationIdempotencyConflict,
    UnknownPreparedWorkflowError,
    UnknownWorkflowBatchError,
    create_idempotent_prepared_workflow,
    create_prepared_workflow,
    get_prepared_workflow,
    serialize_prepared_workflow,
)
from .workflows.dispatch_target import resolve_dispatch_target
from .intent.parser import (
    AVAILABLE_TASK_TYPES,
    EXECUTION_MODES,
    IntentConfigurationError,
    InvalidStructuredProposal,
    InvalidIntentConfirmation,
    preview_intent,
)
from .workflows.execution import (
    DispatchTargetNotFound,
    NativeAssignmentRequired,
    dispatch_saved_subtask,
    interrupt_saved_subtask,
    retry_saved_subtask,
)
from .workflows.orchestrator import (
    DependencyNotReady,
    IdempotencyConflict,
    InvalidAgentResult,
    NativeAdviceContextTooLarge,
    RetryLimitReached,
    RetryNotAllowed,
    StepInProgress,
    StaleAttemptResult,
    SubTaskNotDispatchable,
    WorkflowOrchestrationError,
    WorkflowOrchestrator,
    UnknownWorkflowTaskError,
)
from .delivery.service import (
    DeliveryConflict,
    DeliveryGenerationError,
    DeliveryNotFound,
    complete_workflow_with_deliverables,
    generate_deliverables,
    get_artifact_preview,
    list_workflow_deliverables,
    review_delivery_bundle,
    take_over_generation,
    verify_download_version,
)
from .delivery.checklist import CHECKLIST_FIELDS


def error(detail: str, status: int) -> JsonResponse:
    return JsonResponse({"detail": detail}, status=status)


@require_http_methods(["GET", "POST"])
def workflow_deliverables(request: HttpRequest, workflow_id: str) -> JsonResponse:
    if request.method == "GET":
        try:
            return JsonResponse(list_workflow_deliverables(workflow_id))
        except DeliveryNotFound:
            return error("工作流不存在", 404)
    body, invalid = _parse_standard_json(request)
    if invalid:
        return invalid
    if set(body) != {"idempotency_key"}:
        return error("仅接受 idempotency_key 字段", 422)
    try:
        return JsonResponse(generate_deliverables(workflow_id, body["idempotency_key"]))
    except DeliveryNotFound:
        return error("工作流不存在", 404)
    except DeliveryConflict as exc:
        return JsonResponse({"code": "delivery_conflict", "detail": str(exc)}, status=409)
    except DeliveryGenerationError:
        return JsonResponse({"code": "generation_failed", "detail": "交付文件生成失败，请刷新查看已保存状态"}, status=500)


@require_POST
def take_over_workflow_generation(request: HttpRequest, workflow_id: str, step_id: str) -> JsonResponse:
    body, invalid = _parse_standard_json(request)
    if invalid:
        return invalid
    required = {"expected_step_id", "decision", "idempotency_key", "operator_label", "note"}
    if set(body) != required:
        return error("仅接受 expected_step_id、decision、idempotency_key、operator_label 和 note 字段", 422)
    if body["expected_step_id"] != step_id:
        return JsonResponse({"code": "stale_generation", "detail": "交付生成步骤已变化"}, status=409)
    try:
        return JsonResponse(take_over_generation(workflow_id, **body))
    except DeliveryNotFound:
        return error("工作流不存在", 404)
    except DeliveryConflict as exc:
        return JsonResponse({"code": "generation_takeover_conflict", "detail": str(exc)}, status=409)


@require_POST
def review_workflow_deliverables(request: HttpRequest, workflow_id: str, step_id: str) -> JsonResponse:
    body, invalid = _parse_standard_json(request)
    if invalid:
        return invalid
    if set(body) != {"decision", "reviewer", "note"}:
        return error("仅接受 decision、reviewer 和 note 字段", 422)
    try:
        return JsonResponse(review_delivery_bundle(workflow_id, step_id, **body))
    except DeliveryNotFound:
        return error("交付版本不存在", 404)
    except DeliveryConflict as exc:
        return JsonResponse({"code": "delivery_conflict", "detail": str(exc)}, status=409)


@require_POST
def complete_workflow_deliverables(_request: HttpRequest, workflow_id: str) -> JsonResponse:
    try:
        return JsonResponse(complete_workflow_with_deliverables(workflow_id))
    except DeliveryNotFound:
        return error("工作流不存在", 404)
    except DeliveryConflict as exc:
        return JsonResponse({"code": "completion_blocked", "detail": str(exc)}, status=409)


@require_http_methods(["GET"])
def preview_artifact(_request: HttpRequest, workflow_id: str, version_id: str) -> HttpResponse:
    try:
        version, content, content_type = get_artifact_preview(workflow_id, version_id)
    except DeliveryNotFound:
        return error("交付版本不存在或文件不可用", 404)
    except DeliveryConflict as exc:
        return error(str(exc), 409)
    if version.artifact.artifact_type == "sample_checklist_csv":
        try:
            text = content.decode("utf-8-sig")
            reader = csv.reader(io.StringIO(text, newline=""), strict=True)
            rows = list(reader)
            if not rows or tuple(rows[0]) != CHECKLIST_FIELDS:
                raise ValueError("unexpected checklist header")
            if any(len(row) != len(CHECKLIST_FIELDS) for row in rows[1:]):
                raise ValueError("unexpected checklist row")
        except (UnicodeDecodeError, csv.Error, ValueError):
            return error("登记的样品清单格式不可预览", 409)
        source_versions = version.source_product_versions
        if not isinstance(source_versions, list):
            source_versions = []
        stylesheet_path = finders.find("workbench/styles.css")
        if stylesheet_path is None:
            return error("CSV 预览样式不可用", 500)
        # This fixed app-owned static asset is inlined because the CSP sandbox
        # gives the preview an opaque origin, where style-src 'self' cannot
        # authorize the normal same-origin stylesheet URL.
        preview_stylesheet = mark_safe(Path(stylesheet_path).read_text(encoding="utf-8"))
        response = render(
            _request,
            "workbench/sample_checklist_preview.html",
            {
                "page": "artifacts",
                "business_embed": settings.TRADELOOM_DSH_EMBED,
                "planning_mode": "local_mock",
                "planning_status": "本地规则模拟",
                "agent_orchestration": "中心规划与业务角色采用本地规则模拟，执行记录保存在工作台。",
                "local_executor_mode": "local_demo",
                "agentarts_label": "AgentArts 未配置",
                "version": version,
                "status_label": {
                    "draft": "草稿",
                    "pending_review": "待审核",
                    "approved": "已批准",
                    "rejected": "已驳回",
                }.get(version.status, version.status),
                "columns": rows[0],
                "records": rows[1:],
                "byte_size": len(content),
                "source_versions": source_versions,
                "preview_stylesheet": preview_stylesheet,
                "download_url": public_url(f"/api/workflow-tasks/{workflow_id}/artifact-versions/{version.id}/download"),
            },
        )
        response["Content-Security-Policy"] = "sandbox allow-downloads; default-src 'none'; style-src 'self' 'unsafe-inline'"
        response["X-Content-Type-Options"] = "nosniff"
        return response
    response = HttpResponse(content, content_type=content_type)
    response["Content-Security-Policy"] = "sandbox; default-src 'none'; img-src data:; style-src 'unsafe-inline'"
    response["X-Content-Type-Options"] = "nosniff"
    response["Content-Disposition"] = f'inline; filename="{version.file_path.rsplit("/", 1)[-1]}"'
    return response


@require_http_methods(["GET"])
def download_artifact(_request: HttpRequest, workflow_id: str, version_id: str) -> HttpResponse:
    try:
        version, path, filename = verify_download_version(workflow_id, version_id)
    except DeliveryNotFound:
        return error("交付版本不存在或文件不可用", 404)
    except DeliveryConflict as exc:
        return error(str(exc), 409)
    try:
        handle = path.open("rb")
    except OSError:
        return error("登记的交付文件不可用", 404)
    response = FileResponse(handle, as_attachment=True, filename=filename)
    response["X-Content-Type-Options"] = "nosniff"
    return response


@require_POST
def create_workflow_task(request: HttpRequest) -> JsonResponse:
    try:
        body = json.loads(request.body.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError):
        return error("请求体必须是 JSON", 422)
    if not isinstance(body, dict):
        return error("请求体必须是 JSON 对象", 422)

    allowed = {"batch_id", "user_goal", "task_type", "idempotency_key", "confirmation_token", "execution_mode"}
    if set(body) - allowed:
        return error("请求包含不支持的字段", 422)
    batch_id = body.get("batch_id")
    user_goal = body.get("user_goal")
    task_type = body.get("task_type", "prepare_product_data")
    execution_mode = body.get("execution_mode", "local_mock")
    if (
        not isinstance(batch_id, str)
        or not batch_id.strip()
        or len(batch_id) > 32
    ):
        return error("batch_id 必须是非空且不超过 32 个字符的字符串", 422)
    if not isinstance(user_goal, str) or not user_goal.strip():
        return error("user_goal 必须是非空字符串", 422)
    if (
        not isinstance(task_type, str)
        or not task_type.strip()
        or len(task_type) > 64
    ):
        return error("task_type 必须是非空且不超过 64 个字符的字符串", 422)
    if not isinstance(execution_mode, str) or execution_mode not in EXECUTION_MODES:
        return error("execution_mode 必须是 local_mock 或 native_dsh", 422)

    has_idempotency_key = "idempotency_key" in body
    idempotency_key = body.get("idempotency_key")
    if has_idempotency_key and (
        not isinstance(idempotency_key, str)
        or not idempotency_key.strip()
        or len(idempotency_key) > 200
    ):
        return error("idempotency_key 必须是 1–200 字符的非空字符串", 422)

    has_confirmation_token = "confirmation_token" in body
    confirmation_token = body.get("confirmation_token")
    if has_confirmation_token and (
        not isinstance(confirmation_token, str)
        or not confirmation_token.strip()
        or len(confirmation_token) > 10000
    ):
        return error("confirmation_token 必须是非空字符串", 422)
    if execution_mode == "native_dsh" and not has_confirmation_token:
        return error("原生 DSH 执行必须先预览并确认执行模式", 422)

    try:
        if has_idempotency_key:
            workflow, receipt = create_idempotent_prepared_workflow(
                batch_id=batch_id,
                user_goal=user_goal,
                task_type=task_type,
                idempotency_key=idempotency_key,
                confirmation_token=confirmation_token,
                execution_mode=execution_mode,
            )
        else:
            workflow = create_prepared_workflow(
                batch_id=batch_id,
                user_goal=user_goal,
                task_type=task_type,
                confirmation_token=confirmation_token,
                execution_mode=execution_mode,
            )
    except UnknownWorkflowBatchError as exc:
        return error(str(exc), 404)
    except WorkflowCreationIdempotencyConflict:
        return JsonResponse(
            {"code": "idempotency_conflict", "detail": "幂等键已绑定其他创建请求"},
            status=409,
        )
    except InvalidIntentConfirmation as exc:
        return JsonResponse({"code": "intent_confirmation_invalid", "detail": str(exc)}, status=409)
    except UnknownTaskIntent as exc:
        return JsonResponse(exc.as_dict(), status=exc.code)
    return JsonResponse(
        receipt if has_idempotency_key else serialize_prepared_workflow(workflow),
        status=201,
    )


@require_POST
def preview_workflow_intent(request: HttpRequest) -> JsonResponse:
    body, invalid = _parse_standard_json(request)
    if invalid:
        return invalid
    if set(body) - {"batch_id", "user_goal", "task_type", "execution_mode"} or not {"batch_id", "user_goal"}.issubset(body):
        return error("仅接受 batch_id、user_goal、task_type 和 execution_mode 字段", 422)
    batch_id = body.get("batch_id")
    user_goal = body.get("user_goal")
    task_type = body.get("task_type")
    has_task_type = "task_type" in body
    execution_mode = body.get("execution_mode", "local_mock")
    if not isinstance(batch_id, str) or not batch_id.strip() or len(batch_id) > 32:
        return error("batch_id 必须是非空且不超过 32 个字符的字符串", 422)
    if not isinstance(user_goal, str) or not user_goal.strip() or len(user_goal) > 4000:
        return error("user_goal 必须是非空且不超过 4000 个字符的字符串", 422)
    if has_task_type and (
        not isinstance(task_type, str)
        or task_type not in AVAILABLE_TASK_TYPES
    ):
        return error("task_type 必须是当前支持的工作流类型", 422)
    if not isinstance(execution_mode, str) or execution_mode not in EXECUTION_MODES:
        return error("execution_mode 必须是 local_mock 或 native_dsh", 422)
    from .models import Task

    batch = Task.objects.filter(pk=batch_id).first()
    if batch is None:
        return error("未知批次", 404)
    try:
        return JsonResponse(preview_intent(batch=batch, user_goal=user_goal, task_type=task_type, execution_mode=execution_mode))
    except InvalidStructuredProposal as exc:
        return error(str(exc), 422)
    except IntentConfigurationError:
        return JsonResponse(
            {"code": "intent_config_invalid", "detail": "自然语言解析配置无效，预览已停止"},
            status=503,
        )


@require_http_methods(["GET"])
def get_workflow_task(_request: HttpRequest, workflow_id: str) -> JsonResponse:
    try:
        workflow = get_prepared_workflow(workflow_id)
    except UnknownPreparedWorkflowError as exc:
        return error(str(exc), 404)
    payload = serialize_prepared_workflow(workflow)
    payload["dispatch_target"] = resolve_dispatch_target(workflow)
    payload["collaboration"] = project_collaboration_envelope(
        payload, collaboration_event_metadata(workflow.id)
    )
    return JsonResponse(payload)


@require_POST
def dispatch_workflow_subtask(
    request: HttpRequest, workflow_id: str, subtask_id: str
) -> JsonResponse:
    def reject_constant(value: str):
        raise ValueError(f"非标准 JSON 常量：{value}")

    try:
        body = json.loads(
            request.body.decode("utf-8"),
            parse_constant=reject_constant,
        )
    except (UnicodeDecodeError, json.JSONDecodeError, ValueError):
        return JsonResponse(
            {"code": "invalid_request", "detail": "请求体必须是标准 JSON"},
            status=422,
        )
    if not isinstance(body, dict) or set(body) != {"idempotency_key"}:
        return JsonResponse(
            {
                "code": "invalid_request",
                "detail": "请求仅接受 idempotency_key 字段",
            },
            status=422,
        )
    idempotency_key = body["idempotency_key"]
    if (
        not isinstance(idempotency_key, str)
        or not idempotency_key.strip()
        or len(idempotency_key) > 200
    ):
        return JsonResponse(
            {
                "code": "invalid_request",
                "detail": "idempotency_key 必须是 1–200 字符的非空字符串",
            },
            status=422,
        )

    try:
        result = dispatch_saved_subtask(
            workflow_id=workflow_id,
            subtask_id=subtask_id,
            idempotency_key=idempotency_key,
        )
    except NativeAssignmentRequired:
        return JsonResponse({"code": "native_assignment_required", "detail": "原生工作流不能使用本地模拟派发"}, status=409)
    except (DispatchTargetNotFound, UnknownSubTaskError):
        return JsonResponse(
            {"code": "not_found", "detail": "工作流或所属子任务不存在"},
            status=404,
        )
    except StepInProgress:
        return JsonResponse(
            {"code": "step_in_progress", "detail": "该子任务正在运行"},
            status=409,
        )
    except IdempotencyConflict:
        return JsonResponse(
            {"code": "idempotency_conflict", "detail": "幂等键与已保存步骤冲突"},
            status=409,
        )
    except DependencyNotReady:
        return JsonResponse(
            {
                "code": "dependency_not_ready",
                "detail": "依赖或待处理人工事项尚未解决，当前不能执行",
            },
            status=409,
        )
    except SubTaskNotDispatchable:
        return JsonResponse(
            {"code": "state_conflict", "detail": "当前工作流或子任务状态不允许执行"},
            status=409,
        )
    except (InvalidAgentResult, WorkflowOrchestrationError):
        return JsonResponse(
            {"code": "execution_failed", "detail": "本地角色执行失败，请刷新查看已保存状态"},
            status=500,
        )
    except Exception:
        return JsonResponse(
            {"code": "execution_failed", "detail": "本地角色执行失败，请刷新查看已保存状态"},
            status=500,
        )
    return JsonResponse(result)


@require_POST
def begin_native_workflow_assignment(
    request: HttpRequest, workflow_id: str, subtask_id: str
) -> JsonResponse:
    if not _native_bridge_authorized(request):
        return JsonResponse({"code": "native_bridge_forbidden", "detail": "原生工作流桥接未获授权"}, status=403)
    body, invalid = _parse_standard_json(request)
    if invalid:
        return invalid
    if not isinstance(body, dict) or set(body) != {
        "idempotency_key", "center_identity", "expected_expert_preset"
    }:
        return JsonResponse({"code": "invalid_request", "detail": "原生 assignment 请求字段无效"}, status=422)
    idempotency_key = body.get("idempotency_key")
    expected_preset = body.get("expected_expert_preset")
    if (
        not isinstance(idempotency_key, str)
        or not idempotency_key.strip()
        or len(idempotency_key) > 200
        or not isinstance(expected_preset, str)
    ):
        return JsonResponse({"code": "invalid_request", "detail": "原生 assignment 参数无效"}, status=422)
    try:
        step = WorkflowOrchestrator().begin_native_assignment(
            workflow_id,
            subtask_id,
            idempotency_key,
            center_identity=body["center_identity"],
            expected_expert_preset=expected_preset,
        )
    except UnknownSubTaskError:
        return JsonResponse({"code": "not_found", "detail": "工作流或子任务不存在"}, status=404)
    except (IdempotencyConflict, StepInProgress):
        return JsonResponse({"code": "idempotency_conflict", "detail": "assignment 与已保存步骤冲突"}, status=409)
    except NativeAdviceContextTooLarge:
        return JsonResponse({"code": "advice_context_too_large", "detail": "完整建议来源超出当前支持范围，未保存 assignment"}, status=413)
    except DependencyNotReady:
        return JsonResponse({"code": "dependency_not_ready", "detail": "子任务依赖或人工审核尚未解决"}, status=409)
    except SubTaskNotDispatchable:
        return JsonResponse({"code": "state_conflict", "detail": "当前工作流、执行模式或Host角色不能开始assignment"}, status=409)
    except WorkflowOrchestrationError:
        return JsonResponse({"code": "assignment_failed", "detail": "原生assignment未保存，请读取工作流状态"}, status=500)

    assignment = step.input_refs.get("native_assignment", {})
    return JsonResponse({
        "assignment_id": step.id,
        "step_id": step.id,
        "workflow_id": step.task_id,
        "subtask_id": step.input_refs.get("subtask_id", ""),
        "batch_id": step.input_refs.get("batch_id", ""),
        "agent_role": step.input_refs.get("agent_role", ""),
        "attempt": step.attempt,
        "status": assignment.get("state", "unknown"),
        "expected_expert_preset": assignment.get("expected_expert_preset", ""),
        "advice_context": assignment.get("advice_context", {}),
        "provider": "unknown",
        "model": "unknown",
    })


@require_POST
def bind_native_workflow_assignment(
    request: HttpRequest, workflow_id: str, assignment_id: str
) -> JsonResponse:
    if not _native_bridge_authorized(request):
        return JsonResponse({"code": "native_bridge_forbidden", "detail": "原生工作流桥接未获授权"}, status=403)
    body, invalid = _parse_standard_json(request)
    if invalid:
        return invalid
    if not isinstance(body, dict) or set(body) != {
        "assignment_id", "step_id", "center_identity", "child_identity"
    }:
        return JsonResponse({"code": "invalid_request", "detail": "原生 child 绑定请求字段无效"}, status=422)
    if body.get("assignment_id") != assignment_id or body.get("step_id") != assignment_id:
        return JsonResponse({"code": "assignment_conflict", "detail": "assignment 引用不匹配"}, status=409)
    try:
        step = WorkflowOrchestrator().bind_native_assignment(
            workflow_id,
            assignment_id,
            body["step_id"],
            center_identity=body["center_identity"],
            child_identity=body["child_identity"],
        )
    except UnknownWorkflowTaskError:
        return JsonResponse({"code": "not_found", "detail": "工作流或 assignment 不存在"}, status=404)
    except (IdempotencyConflict, StaleAttemptResult):
        return JsonResponse({"code": "assignment_conflict", "detail": "assignment 已变化或绑定与已保存子代理冲突"}, status=409)
    except SubTaskNotDispatchable:
        return JsonResponse({"code": "host_identity_rejected", "detail": "Host child 身份与 assignment 不匹配"}, status=403)
    except WorkflowOrchestrationError:
        return JsonResponse({"code": "assignment_bind_failed", "detail": "原生 child 绑定未保存，请读取工作流状态"}, status=500)

    assignment = step.input_refs["native_assignment"]
    return JsonResponse({
        "assignment_id": assignment_id,
        "step_id": step.id,
        "child_agent_id": assignment["child_agent_id"],
        "status": "bound",
        "provider": "unknown",
        "model": "unknown",
        "child_lifecycle": "not_observed",
    })


@require_POST
def submit_native_workflow_assignment(
    request: HttpRequest, workflow_id: str, assignment_id: str
) -> JsonResponse:
    if not _native_bridge_authorized(request):
        return JsonResponse({"code": "native_bridge_forbidden", "detail": "原生工作流桥接未获授权"}, status=403)
    body, invalid = _parse_standard_json(request)
    if invalid:
        return invalid
    if not isinstance(body, dict) or set(body) != {
        "assignment_id", "step_id", "child_identity", "advice"
    }:
        return JsonResponse({"code": "invalid_request", "detail": "原生提交请求字段无效"}, status=422)
    if body.get("assignment_id") != assignment_id:
        return JsonResponse({"code": "assignment_conflict", "detail": "assignment引用不匹配"}, status=409)
    try:
        receipt = WorkflowOrchestrator().submit_native_assignment(
            workflow_id,
            assignment_id,
            body.get("step_id"),
            child_identity=body.get("child_identity"),
            advice=body.get("advice"),
        )
    except UnknownWorkflowTaskError:
        return JsonResponse({"code": "not_found", "detail": "工作流或assignment不存在"}, status=404)
    except (IdempotencyConflict, StaleAttemptResult):
        return JsonResponse({"code": "assignment_conflict", "detail": "assignment已变化或提交与已保存结果冲突"}, status=409)
    except DependencyNotReady:
        return JsonResponse({"code": "dependency_not_ready", "detail": "当前来源或工作流门禁不允许提交"}, status=409)
    except SubTaskNotDispatchable:
        return JsonResponse({"code": "host_identity_rejected", "detail": "Host专家身份与assignment不匹配"}, status=403)
    except InvalidAgentResult:
        return JsonResponse({"code": "invalid_native_advice", "detail": "专家建议超出受支持范围或未对应服务端审核项"}, status=422)
    except WorkflowOrchestrationError:
        return JsonResponse({"code": "native_submission_failed", "detail": "原生专家结果未接受，请读取工作流状态"}, status=500)
    return JsonResponse(receipt)


def _native_bridge_authorized(request: HttpRequest) -> bool:
    expected = os.environ.get("TRADELOOM_NATIVE_BRIDGE_KEY", "")
    supplied = request.headers.get("X-TradeLoom-Native-Bridge", "")
    if len(expected) != 64 or len(supplied) != 64:
        return False
    try:
        return hmac.compare_digest(expected.encode("ascii"), supplied.encode("ascii"))
    except UnicodeEncodeError:
        return False


def _parse_standard_json(request: HttpRequest):
    def reject_constant(value: str):
        raise ValueError(value)

    try:
        body = json.loads(request.body.decode("utf-8"), parse_constant=reject_constant)
    except (UnicodeDecodeError, json.JSONDecodeError, ValueError):
        return None, JsonResponse(
            {"code": "invalid_request", "detail": "请求体必须是标准 JSON"},
            status=422,
        )
    if not isinstance(body, dict):
        return None, JsonResponse(
            {"code": "invalid_request", "detail": "请求体必须是 JSON 对象"},
            status=422,
        )
    return body, None


@require_POST
def retry_workflow_subtask(
    request: HttpRequest, workflow_id: str, subtask_id: str
) -> JsonResponse:
    body, invalid = _parse_standard_json(request)
    if invalid:
        return invalid
    if set(body) != {"idempotency_key", "expected_step_id"}:
        return JsonResponse(
            {"code": "invalid_request", "detail": "仅接受 idempotency_key 和 expected_step_id 字段"},
            status=422,
        )
    idempotency_key = body.get("idempotency_key")
    expected_step_id = body.get("expected_step_id")
    if not isinstance(idempotency_key, str) or not idempotency_key.strip() or len(idempotency_key) > 200:
        return JsonResponse(
            {"code": "invalid_request", "detail": "idempotency_key 必须是 1–200 字符的非空字符串"},
            status=422,
        )
    if not isinstance(expected_step_id, str) or not expected_step_id.strip() or len(expected_step_id) > 32:
        return JsonResponse(
            {"code": "invalid_request", "detail": "expected_step_id 必须是非空且不超过 32 个字符的字符串"},
            status=422,
        )
    try:
        result = retry_saved_subtask(
            workflow_id, subtask_id, idempotency_key, expected_step_id
        )
    except (DispatchTargetNotFound, UnknownSubTaskError):
        return JsonResponse({"code": "not_found", "detail": "工作流或所属子任务不存在"}, status=404)
    except StepInProgress:
        return JsonResponse({"code": "step_in_progress", "detail": "该子任务正在运行"}, status=409)
    except IdempotencyConflict:
        return JsonResponse({"code": "idempotency_conflict", "detail": "幂等键已绑定其他请求"}, status=409)
    except RetryLimitReached:
        return JsonResponse({"code": "retry_limit_reached", "detail": "该子任务已达到最多三次执行尝试"}, status=409)
    except DependencyNotReady:
        return JsonResponse({"code": "dependency_not_ready", "detail": "依赖或待处理人工事项尚未解决，当前不能重试"}, status=409)
    except RetryNotAllowed:
        return JsonResponse({"code": "retry_not_allowed", "detail": "当前步骤或执行器不允许安全重试"}, status=409)
    except (InvalidAgentResult, WorkflowOrchestrationError):
        return JsonResponse({"code": "execution_failed", "detail": "本地角色执行失败，请刷新查看已保存状态"}, status=500)
    except Exception:
        return JsonResponse({"code": "execution_failed", "detail": "本地角色执行失败，请刷新查看已保存状态"}, status=500)
    return JsonResponse(result)


@require_POST
def interrupt_workflow_subtask(
    request: HttpRequest, workflow_id: str, subtask_id: str
) -> JsonResponse:
    body, invalid = _parse_standard_json(request)
    if invalid:
        return invalid
    if set(body) != {"expected_step_id", "operator_label", "note"}:
        return JsonResponse(
            {"code": "invalid_request", "detail": "仅接受 expected_step_id、operator_label 和 note 字段"},
            status=422,
        )
    expected_step_id = body.get("expected_step_id")
    operator_label = body.get("operator_label")
    note = body.get("note")
    if not isinstance(expected_step_id, str) or not expected_step_id.strip() or len(expected_step_id) > 32:
        return JsonResponse({"code": "invalid_request", "detail": "expected_step_id 格式无效"}, status=422)
    if not isinstance(operator_label, str) or not operator_label.strip() or len(operator_label) > 120:
        return JsonResponse({"code": "invalid_request", "detail": "operator_label 必须是 1–120 字符的非空标签"}, status=422)
    if not isinstance(note, str) or len(note) > 1000:
        return JsonResponse({"code": "invalid_request", "detail": "note 必须是不超过 1000 字符的字符串"}, status=422)
    try:
        result = interrupt_saved_subtask(
            workflow_id, subtask_id, expected_step_id, operator_label, note
        )
    except (DispatchTargetNotFound, UnknownSubTaskError):
        return JsonResponse({"code": "not_found", "detail": "工作流或所属子任务不存在"}, status=404)
    except StaleAttemptResult:
        return JsonResponse({"code": "state_conflict", "detail": "当前执行已变化，请刷新后再操作"}, status=409)
    return JsonResponse(result)


def _service() -> WorkbenchService:
    return WorkbenchService()


@require_http_methods(["GET"])
def health(_request: HttpRequest) -> JsonResponse:
    diagnostics = collect_local_diagnostics()
    payload = {
        "status": diagnostics["status"],
        "execution_mode": "local_demo",
        "agentarts": "not_configured",
        "agentarts_status": {
            "status": "not_configured",
            "evidence": "documented_not_connected",
        },
        "dependencies": diagnostics["dependencies"],
        "intent": diagnostics["intent"],
        "runtime": {
            "status": diagnostics["dependencies"]["runtime"]["status"],
            "health_status": diagnostics["dependencies"]["runtime"].get("health_status"),
            "execution_mode": diagnostics["dependencies"]["runtime"].get("execution_mode"),
            "planning_mode": diagnostics["dependencies"]["runtime"].get("planning_mode"),
        },
        "adapter_capabilities": safe_adapter_capabilities(),
    }
    return JsonResponse(payload, status=503 if diagnostics["status"] == "degraded" else 200)


@require_http_methods(["GET"])
def list_agents(_request: HttpRequest) -> JsonResponse:
    return JsonResponse(_service().list_capabilities(), safe=False)


@require_http_methods(["GET"])
def list_tasks(_request: HttpRequest) -> JsonResponse:
    return JsonResponse(_service().list_tasks(), safe=False)


@require_http_methods(["GET", "POST"])
def tasks_collection(request: HttpRequest):
    if request.method == "GET":
        return list_tasks(request)
    return create_task(request)


@require_POST
def create_demo_task(_request: HttpRequest) -> JsonResponse:
    try:
        return JsonResponse(_service().create_demo_task())
    except UploadValidationError as exc:
        return error(str(exc), 400)


@require_POST
def create_task(request: HttpRequest) -> JsonResponse:
    title = request.POST.get("title", "")
    csv_file = request.FILES.get("products_csv")
    if csv_file is None:
        return error("缺少商品表 CSV", 400)
    csv_bytes = csv_file.read()
    try:
        service = _service()
        rows = service.parse_csv(csv_bytes)
        images = [
            (image.name, image.read())
            for image in request.FILES.getlist("images")
        ]
        task = service.create_task_from_csv(
            title=title,
            csv_name=csv_file.name,
            csv_bytes=csv_bytes,
            rows=rows,
            images=images,
        )
        return JsonResponse(task)
    except UploadValidationError as exc:
        return error(str(exc), 400)


@require_http_methods(["GET"])
def get_task(_request: HttpRequest, task_id: str) -> JsonResponse:
    try:
        return JsonResponse(_service().get_task(task_id))
    except WorkbenchNotFoundError as exc:
        return error(str(exc), 404)


@require_http_methods(["PATCH", "POST"])
def update_batch_item(request: HttpRequest, item_id: str) -> JsonResponse:
    try:
        body = json.loads(request.body.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError):
        return error("请求体必须是 JSON", 422)
    if not isinstance(body, dict) or not body:
        return error("请求体必须是非空 JSON 对象", 422)
    try:
        payload = _service().update_batch_item(item_id, body)
    except WorkbenchNotFoundError as exc:
        return error(str(exc), 404)
    except WorkbenchConflictError as exc:
        return error(str(exc), 409)
    except UploadValidationError as exc:
        return error(str(exc), 422)
    return JsonResponse(payload)


def confirm_task(_request: HttpRequest, task_id: str) -> JsonResponse:
    try:
        return JsonResponse(_service().confirm_task(task_id))
    except WorkbenchNotFoundError as exc:
        return error(str(exc), 404)
    except WorkbenchConflictError as exc:
        return error(str(exc), 409)


@require_http_methods(["GET"])
def export_csv(_request: HttpRequest, task_id: str) -> HttpResponse:
    try:
        body = _service().export_csv(task_id)
    except WorkbenchNotFoundError as exc:
        return error(str(exc), 404)
    except WorkbenchConflictError as exc:
        return error(str(exc), 409)
    response = HttpResponse(
        body.encode("utf-8"),
        content_type="text/csv; charset=utf-8",
    )
    response["Content-Disposition"] = 'attachment; filename="products.csv"'
    return response


@require_http_methods(["GET"])
def list_runs(_request: HttpRequest, task_id: str) -> JsonResponse:
    try:
        return JsonResponse(_service().list_runs(task_id), safe=False)
    except WorkbenchNotFoundError as exc:
        return error(str(exc), 404)


@require_POST
def dispatch_agent(
    request: HttpRequest,
    task_id: str,
    capability_id: str,
) -> JsonResponse:
    return _dispatch_agent_request(request, task_id, capability_id)


@require_POST
def dispatch_agent_with_receipt(
    request: HttpRequest,
    task_id: str,
    capability_id: str,
) -> JsonResponse:
    return _dispatch_agent_request(request, task_id, capability_id, require_key=True)


def _agent_error(
    detail: str,
    status: int,
    *,
    terminal: bool = True,
) -> JsonResponse:
    return JsonResponse({"detail": detail, "terminal": terminal}, status=status)


def _dispatch_agent_request(
    request: HttpRequest,
    task_id: str,
    capability_id: str,
    *,
    require_key: bool = False,
) -> JsonResponse:
    idempotency_key = request.headers.get("Idempotency-Key")
    if require_key and idempotency_key is None:
        return _agent_error("此运行接口必须提供Idempotency-Key。", 400)
    if idempotency_key is not None and (
        not idempotency_key
        or len(idempotency_key) > 200
        or idempotency_key.strip() != idempotency_key
    ):
        return _agent_error("Idempotency-Key必须为1到200个字符，且不能含首尾空格。", 400)
    try:
        result = _service().dispatch_agent(task_id, capability_id, idempotency_key)
        return JsonResponse(result)
    except WorkbenchNotFoundError as exc:
        return _agent_error(str(exc), 404)
    except UnknownCapabilityError as exc:
        return _agent_error(f"未知 Agent 能力：{exc}", 404)
    except CapabilityUnavailableError as exc:
        return _agent_error(str(exc), 409)
    except AgentRunInProgressError as exc:
        return JsonResponse(
            {"run_id": exc.run_id, "status": "running"},
            status=202,
        )
    except AgentRunReplayError as exc:
        return _agent_error(str(exc), exc.status_code)
    except ValueError as exc:
        return _agent_error(str(exc), 400)
    except Exception:
        if idempotency_key is None:
            raise
        return _agent_error(
            "Agent运行状态暂时无法确认，请使用同一回执重试。",
            500,
            terminal=False,
        )
