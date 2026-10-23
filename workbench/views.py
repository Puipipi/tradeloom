from __future__ import annotations

from datetime import datetime

from django.db.models import Count
from django.conf import settings
from django.http import Http404
from django.shortcuts import render
from django.utils import timezone
from django.utils.dateparse import parse_datetime
from django.views.decorators.csrf import ensure_csrf_cookie

from .diagnostics import collect_local_diagnostics, safe_run_error_summary
from .models import (
    AgentRun,
    Artifact,
    ArtifactVersion,
    EventLog,
    HumanReview,
    Product,
    SubTask,
    Task,
    WorkflowTask,
)
from .intake.schemas import FIELD_SCHEMAS
from .products.query import (
    PRODUCT_LIBRARY_STATUSES,
    InvalidProductFilter,
    query_product_library,
)
from .services import WorkbenchNotFoundError, WorkbenchService


PLATFORM_CONTEXT = {
    "planning_mode": "local_mock",
    "planning_status": "本地规则模拟",
    "agent_orchestration": "中心规划与业务角色采用本地规则模拟，执行记录保存在工作台。",
    "local_executor_mode": "local_demo",
    "agentarts_status": "not_configured",
    "agentarts_label": "AgentArts 未配置",
}

SOURCE_LABELS = {
    "legacy_backfill": "历史数据补录",
    "legacy_product": "产品资料更新",
    "legacy_csv": "CSV 导入",
    "legacy_confirm": "确认记录",
    "human_review": "人工审核",
}

STATUS_LABELS = {
    "awaiting_confirmation": "待确认",
    "confirmed": "已确认",
    "created": "已创建",
    "needs_review": "待确认",
    "draft": "草稿",
    "queued": "排队中",
    "running": "进行中",
    "waiting_human": "等待人工处理",
    "pending": "待处理",
    "submitted": "已提交，待核验",
    "pending_review": "待交付审核",
    "rejected": "已驳回",
    "failed": "失败",
    "completed": "已完成",
    "cancelled": "已取消",
    "succeeded": "成功",
    "unavailable": "不可用",
}

TASK_TYPE_LABELS = {
    "prepare_product_data": "产品资料准备",
    "generate_catalog": "目录生成",
    "quality_check": "质量检查",
}

STEP_LABELS = {
    "plan": "任务规划",
    "center_plan": "中心规划",
    "product_profile": "产品资料",
    "delivery_quality": "交付资料就绪检查",
    "generate_deliverables": "生成交付文件",
    "generate_deliverables_failed": "交付文件生成失败",
    "review_deliverables": "交付文件审核",
    "complete_workflow": "完成工作流",
    "deliverables_rejected": "交付文件已驳回",
    "human_review": "待后续人工处理",
    "apply_review_cycle": "应用并确认本批基础资料",
}

AGENT_ROLE_LABELS = {
    "product_profile": "产品资料",
    "delivery_quality": "交付质检",
    "center": "中心协调",
    "product_profile": "产品资料",
    "quotation": "询报价",
    "catalog_package": "目录备样",
    "shared_task_data": "共享资料",
}

EVENT_TYPE_LABELS = {
    "workflow_status_changed": "状态变化",
    "health_check": "健康检查",
    "human_review_cycle_applied": "已应用并确认本批基础资料",
}

ARTIFACT_TYPE_LABELS = {
    "catalog_html": "英文目录 HTML",
    "catalog_markdown": "英文目录 Markdown",
    "sample_checklist_csv": "样品清单 CSV",
    "sample_checklist_json": "样品清单 JSON",
    "quality_report_json": "真实文件质检报告",
}

AGENT_LIST_LIMIT = 6
RUN_LIST_LIMIT = 50
EVENT_LIST_LIMIT = 20


def _page_context(page: str, **extra) -> dict:
    return {**PLATFORM_CONTEXT, "page": page, "business_embed": settings.TRADELOOM_DSH_EMBED, **extra}


def _label(mapping: dict[str, str], value: str | None) -> str:
    return mapping.get(value, value or "未知")


def _short_local_time(value) -> str:
    if value is None:
        return "—"
    if isinstance(value, str):
        parsed = parse_datetime(value)
        if parsed is None:
            return value
        value = parsed
    if isinstance(value, datetime):
        if timezone.is_naive(value):
            value = timezone.make_aware(value)
        return timezone.localtime(value).strftime("%Y-%m-%d %H:%M")
    return str(value)


@ensure_csrf_cookie
def task_list(request):
    service = WorkbenchService()
    return render(
        request,
        "workbench/task_list.html",
        _page_context("tasks", tasks=service.list_tasks()),
    )


@ensure_csrf_cookie
def new_task(request):
    return render(request, "workbench/new_task.html", _page_context("new"))


@ensure_csrf_cookie
def task_detail(request, task_id: str):
    service = WorkbenchService()
    try:
        task = service.get_task(task_id)
    except WorkbenchNotFoundError as exc:
        raise Http404("任务不存在") from exc
    return render(
        request,
        "workbench/task_detail.html",
        _page_context("tasks", task=task),
    )


@ensure_csrf_cookie
def agents(request):
    service = WorkbenchService()
    return render(
        request,
        "workbench/agents.html",
        _page_context(
            "agents",
            tasks=service.list_tasks(),
            capabilities=service.list_capabilities(),
        ),
    )


@ensure_csrf_cookie
def home(request):
    service = WorkbenchService()
    tasks = service.list_tasks()
    pending_batches = [
        {
            **task,
            "updated_at_display": _short_local_time(task["updated_at"]),
            "can_confirm": task["product_count"] > 0
            and task["missing_count"] == 0,
        }
        for task in tasks
        if task["status"] == "awaiting_confirmation"
    ]
    actionable_batches = [
        task for task in pending_batches if task["can_confirm"]
    ]
    return render(
        request,
        "workbench/home.html",
        _page_context(
            "home",
            batch_count=len(tasks),
            product_count=Product.objects.count(),
            pending_count=len(pending_batches),
            workflow_count=WorkflowTask.objects.count(),
            actionable_count=len(actionable_batches),
            pending_batches=pending_batches[:8],
            pending_more=max(0, len(pending_batches) - 8),
            actionable_batches=actionable_batches[:5],
        ),
    )


@ensure_csrf_cookie
def products(request):
    q = request.GET.get("q", "").strip()
    state = request.GET.get("state", "").strip()
    batch = request.GET.get("batch", "").strip()
    filter_error = ""
    try:
        rows = query_product_library(
            q=q,
            status=state,
            batch_id=batch,
            include_revisions=True,
        )
    except InvalidProductFilter as exc:
        rows = []
        filter_error = str(exc)

    for product in rows:
        latest = product["latest_revision"]
        raw_status = product["revision_status"]
        product["batch_id"] = product["batch"]["id"]
        product["batch_title"] = product["batch"]["title"]
        product["batch_status_raw"] = product["batch"]["status"]
        product["batch_status"] = _label(
            STATUS_LABELS,
            product["batch"]["status"],
        )
        product["version"] = product["current_version"]
        product["revision_status_raw"] = raw_status or "draft"
        product["revision_status"] = (
            _label(STATUS_LABELS, raw_status) if raw_status else "无版本"
        )
        raw_source = latest["source"] if latest else ""
        product["source"] = (
            _label(SOURCE_LABELS, raw_source) if raw_source else "—"
        )
        product["revision_updated_at"] = (
            latest["updated_at"] if latest else None
        )
        for revision in product["revisions"]:
            revision["status_raw"] = revision["status"]
            revision["status_label"] = _label(
                STATUS_LABELS,
                revision["status"],
            )
            revision["source_label"] = _label(
                SOURCE_LABELS,
                revision["source"],
            )

    batch_options = []
    for batch_obj in (
        Task.objects.filter(products__isnull=False)
        .annotate(product_total=Count("products"))
        .order_by("-created_at")
    ):
        batch_options.append(
            {
                "id": batch_obj.id,
                "label": (
                    f"{batch_obj.title} · {batch_obj.id[:8]} · "
                    f"{timezone.localtime(batch_obj.updated_at).strftime('%m-%d %H:%M')}"
                ),
                "product_total": batch_obj.product_total,
            }
        )

    status_options = [
        {"value": value, "label": STATUS_LABELS[value]}
        for value in PRODUCT_LIBRARY_STATUSES
    ]
    product_total = Product.objects.count()
    empty_library = not (q or state or batch) and product_total == 0
    return render(
        request,
        "workbench/products.html",
        _page_context(
            "products",
            products=rows,
            result_count=len(rows),
            product_total=product_total,
            empty_library=empty_library,
            revision_count=sum(row["version"] is not None for row in rows),
            missing_count=sum(bool(row["missing_fields"]) for row in rows),
            batch_count=len({row["batch_id"] for row in rows}),
            filters={"q": q, "state": state, "batch": batch},
            status_options=status_options,
            batch_options=batch_options,
            filter_error=filter_error,
        ),
    )


@ensure_csrf_cookie
def agent_center(request):
    workflow_tasks = list(
        WorkflowTask.objects.select_related("batch").order_by("-created_at")[
            :AGENT_LIST_LIMIT
        ]
    )
    subtasks = list(
        SubTask.objects.select_related("task__batch").order_by("-created_at")[
            :AGENT_LIST_LIMIT
        ]
    )
    workflow_reviews = list(
        HumanReview.objects.filter(status__in=("pending", "submitted"))
        .select_related("task__batch")
        .order_by("-created_at")[:AGENT_LIST_LIMIT]
    )
    batch_options = [
        {
            "id": batch.id,
            "label": (
                f"{batch.title} · {batch.id[:8]} · "
                f"{timezone.localtime(batch.updated_at).strftime('%m-%d %H:%M')}"
            ),
        }
        for batch in (
            Task.objects.filter(products__isnull=False)
            .distinct()
            .order_by("-created_at")
        )
    ]
    for workflow in workflow_tasks:
        workflow.task_type_label = _label(TASK_TYPE_LABELS, workflow.task_type)
        workflow.status_label = _label(STATUS_LABELS, workflow.status)
        workflow.current_step_label = (
            _label(STEP_LABELS, workflow.current_step)
            if workflow.current_step
            else "未设置步骤"
        )
        workflow.execution_summary = ""
        next_step = workflow.result_refs.get("next_step")
        if workflow.status != "completed" and next_step:
            workflow.execution_summary = (
                "下一步：" + _label(STEP_LABELS, next_step)
            )
    for subtask in subtasks:
        subtask.agent_role_label = _label(
            AGENT_ROLE_LABELS,
            subtask.agent_role,
        )
        subtask.status_label = _label(STATUS_LABELS, subtask.status)
        subtask.source_summary = _label(
            STEP_LABELS,
            subtask.agent_role,
        )
        scope = subtask.input_refs.get("scope")
        if scope:
            subtask.source_summary += " · " + (
                "全批次" if scope == "full_batch" else str(scope)
            )
        product_ids = subtask.input_refs.get("product_ids") or subtask.input_refs.get("all_product_ids")
        if isinstance(product_ids, list):
            subtask.source_summary += f" · 来源 {len(product_ids)} 个产品"
        result = subtask.output_refs.get("result", {})
        if subtask.agent_role == "product_profile" and isinstance(result.get("products"), list):
            needing_human = sum(item.get("status") == "needs_human" for item in result["products"])
            subtask.result_summary = f"资料候选 {len(result['products'])} 项；需人工处理 {needing_human} 项"
        elif subtask.agent_role == "delivery_quality" and result:
            readiness = "资料就绪" if result.get("data_readiness") == "ready" else "资料未就绪"
            subtask.result_summary = readiness + "；文件质检未执行"
        else:
            subtask.result_summary = "执行结果待生成" if not result else str(result.get("status", "已记录"))
    for workflow in workflow_tasks:
        workflow.detail_url = f"/workflow-tasks/{workflow.id}"
    for subtask in subtasks:
        subtask.detail_url = f"/workflow-tasks/{subtask.task_id}"
    for review in workflow_reviews:
        review.status_label = _label(STATUS_LABELS, review.status)
        review.workflow_url = f"/workflow-tasks/{review.task_id}#review-{review.id}"
    return render(
        request,
        "workbench/agent_center.html",
        _page_context(
            "agent_center",
            workflow_tasks=workflow_tasks,
            subtasks=subtasks,
            workflow_reviews=workflow_reviews,
            batch_options=batch_options,
            workflow_count=WorkflowTask.objects.count(),
            subtask_count=SubTask.objects.count(),
            pending_review_count=HumanReview.objects.filter(
                status="pending"
            ).count(),
            workflow_review_list_count=HumanReview.objects.filter(
                status__in=("pending", "submitted")
            ).count(),
            agent_list_limit=AGENT_LIST_LIMIT,
        ),
    )


@ensure_csrf_cookie
def artifacts(request):
    artifact_rows = list(
        Artifact.objects.select_related("task__batch").order_by("-created_at")
    )
    for artifact in artifact_rows:
        artifact.artifact_type_label = _label(
            ARTIFACT_TYPE_LABELS,
            artifact.artifact_type,
        )
        artifact.status_label = _label(STATUS_LABELS, artifact.status)
        artifact.version_rows = []
        for version in artifact.versions.order_by("-version"):
            version.artifact_type_label = artifact.artifact_type_label
            version.download_url = f"/api/workflow-tasks/{artifact.task_id}/artifact-versions/{version.id}/download"
            if artifact.artifact_type in {"catalog_html", "catalog_markdown", "sample_checklist_csv"}:
                version.preview_url = f"/api/workflow-tasks/{artifact.task_id}/artifact-versions/{version.id}/preview"
            else:
                version.preview_url = None
            artifact.version_rows.append(version)
    return render(
        request,
        "workbench/artifacts.html",
        _page_context(
            "artifacts",
            artifacts=artifact_rows,
            artifact_count=len(artifact_rows),
            version_count=ArtifactVersion.objects.count(),
            intake_field_schemas=FIELD_SCHEMAS,
        ),
    )


@ensure_csrf_cookie
def runs(request):
    run_rows = list(
        AgentRun.objects.select_related("task").order_by("-started_at")[
            :RUN_LIST_LIMIT
        ]
    )
    event_rows = list(
        EventLog.objects.select_related("task__batch").order_by("-created_at")[
            :EVENT_LIST_LIMIT
        ]
    )
    for run in run_rows:
        run.capability_label = _label(AGENT_ROLE_LABELS, run.capability_id)
        run.status_label = _label(STATUS_LABELS, run.status)
        run.safe_error_summary = safe_run_error_summary(run)
    for event in event_rows:
        event.event_type_label = _label(
            EVENT_TYPE_LABELS,
            event.event_type,
        )
        event.safe_actor_label = "system" if event.actor == "system" else "操作者"
    diagnostics = collect_local_diagnostics()
    runtime_health = diagnostics["runtime_health"] or {}
    intent = diagnostics["intent"]
    return render(
        request,
        "workbench/runs.html",
        _page_context(
            "runs",
            runs=run_rows,
            events=event_rows,
            run_count=AgentRun.objects.count(),
            event_count=EventLog.objects.count(),
            run_list_limit=RUN_LIST_LIMIT,
            event_list_limit=EVENT_LIST_LIMIT,
            diagnostics=diagnostics,
            intent=intent,
            runtime_health=runtime_health,
        ),
    )
