"""Prepare and confirm the existing desktop business workflow in the enterprise portal."""

from uuid import uuid4

from django.core import signing
from django.http import Http404, HttpResponse, HttpResponseBadRequest
from django.shortcuts import get_object_or_404, render
from django.urls import reverse
from django.views.decorators.cache import never_cache
from django.views.decorators.csrf import csrf_protect
from django.views.decorators.http import require_http_methods

from workbench.agents.workflow_contracts import UnknownTaskIntent
from workbench.intent.parser import IntentConfigurationError, InvalidIntentConfirmation, preview_intent
from workbench.models import Task
from workbench.views import TASK_TYPE_LABELS
from workbench.workflows.orchestrator import WorkflowOrchestrationError
from workbench.workflows.prepare import (
    UnknownWorkflowBatchError,
    WorkflowCreationIdempotencyConflict,
    create_idempotent_prepared_workflow,
)

from .business_workflows import workflow_access_denial

PREVIEW_SALT = "enterprise.workflow-create.v1"
MAX_GOAL = 4000


@require_http_methods(["GET", "POST"])
@csrf_protect
@never_cache
def create_from_batch(request, batch_id):
    denied = workflow_access_denial(request)
    if denied is not None:
        return denied
    batch = get_object_or_404(Task.objects.only("id", "title"), pk=batch_id)
    context = {"batch": batch, "max_goal": MAX_GOAL}
    if request.method == "GET":
        return render(request, "enterprise_portal/workflow_create.html", context)
    action = request.POST.getlist("action")
    if action == ["confirm"]:
        return confirm_creation(request, batch)
    if action != ["preview"]:
        return HttpResponseBadRequest("请选择预览或确认创建。")

    goals = request.POST.getlist("goal")
    goal = goals[0].strip() if len(goals) == 1 else ""
    if not goal or len(goal) > MAX_GOAL or "\0" in goal:
        return render(request, "enterprise_portal/workflow_create.html", {
            **context, "error": "请输入 1 至 4000 个字符的工作流目标。",
        }, status=400)
    try:
        preview = preview_intent(batch=batch, user_goal=goal, execution_mode="local_mock")
    except IntentConfigurationError:
        return HttpResponse("工作流规划暂不可用。", status=503)
    context.update(goal=goal, reason=preview["classification"]["reason"])
    if preview["status"] == "ready":
        task_type = preview["action"]["task_type"]
        context.update(
            task_label=TASK_TYPE_LABELS[task_type],
            sources={item["kind"]: item["count"] for item in preview["sources"] if "count" in item},
            confirmation=signing.dumps({
                "owner": str(request.user.pk), "batch_id": batch.pk,
                "goal": goal, "task_type": task_type, "nonce": uuid4().hex,
                "desktop_confirmation": preview["confirmation_token"],
            }, salt=PREVIEW_SALT, compress=True),
        )
    return render(request, "enterprise_portal/workflow_create.html", context)


def confirm_creation(request, batch):
    tokens = request.POST.getlist("confirmation")
    if len(tokens) != 1 or not 0 < len(tokens[0]) <= 24000:
        return HttpResponseBadRequest("请先预览再确认创建。")
    try:
        frozen = signing.loads(tokens[0], salt=PREVIEW_SALT)
    except signing.BadSignature:
        return HttpResponseBadRequest("确认已失效，请重新预览。")
    if frozen["owner"] != str(request.user.pk) or frozen["batch_id"] != batch.pk:
        raise Http404
    try:
        workflow, _ = create_idempotent_prepared_workflow(
            batch_id=batch.pk, user_goal=frozen["goal"], task_type=frozen["task_type"],
            confirmation_token=frozen["desktop_confirmation"],
            idempotency_key=f"enterprise-create:{frozen['nonce']}", execution_mode="local_mock",
        )
    except UnknownWorkflowBatchError as exc:
        raise Http404 from exc
    except (InvalidIntentConfirmation, UnknownTaskIntent, WorkflowCreationIdempotencyConflict, WorkflowOrchestrationError):
        return HttpResponse("无法按该预览创建工作流。请返回批次重新预览。", status=409)
    return HttpResponse(status=303, headers={
        "Location": reverse("enterprise-workflow-detail", args=[workflow.pk]),
    })
