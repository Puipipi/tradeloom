"""Read the enterprise database's persisted business workflow records."""
from urllib.parse import urlencode

from django.core import signing
from django.core.paginator import Paginator
from django.db.models import Prefetch, Q
from django.db.models.functions import Coalesce
from django.http import Http404, HttpResponse, HttpResponseBadRequest, HttpResponseForbidden
from django.shortcuts import get_object_or_404, redirect, render
from django.urls import reverse
from django.views.decorators.cache import never_cache
from django.views.decorators.csrf import csrf_protect
from django.views.decorators.http import require_GET, require_POST

from workbench.agents.runtime import UnknownSubTaskError
from workbench.delivery.service import (
    DeliveryConflict,
    DeliveryGenerationError,
    DeliveryNotFound,
    MAX_GENERATION_ATTEMPTS,
    _consecutive_generation_failures,
    complete_workflow_with_deliverables,
    generate_deliverables,
    review_delivery_bundle,
)
from workbench.delivery.storage import DeliveryStorageError, read_task_image
from workbench.models import EventLog, HumanReview, Product, SubTask, TaskFile, WorkflowStep, WorkflowTask
from workbench.views import AGENT_ROLE_LABELS, STATUS_LABELS, STEP_LABELS, TASK_TYPE_LABELS
from workbench.workflows.dispatch_target import resolve_dispatch_target
from workbench.workflows.execution import DispatchTargetNotFound, dispatch_saved_subtask
from workbench.workflows.fact_application import (
    FactApplicationConflict, FactApplicationNotFound, InvalidFactApplication, apply_fact_review_cycle,
)
from workbench.workflows.reviews import (
    InvalidReviewSubmission, ReviewNotFound, ReviewSubmissionConflict, submit_review,
)
from workbench.workflows.orchestrator import (
    DependencyNotReady,
    IdempotencyConflict,
    NativeAssignmentRequired,
    StepInProgress,
    SubTaskNotDispatchable,
    WorkflowOrchestrationError,
)
from workbench.workflows.review_images import (
    MAX_IMAGE_BYTES, ReviewImageConflict, upload_review_image, validate_upload_credential,
)
from workbench.workflows.validation import frozen_image_candidates_for_review

from .delivery_versions import workflow_delivery_review
from .email_login import is_verified_enterprise_session
from .policy import can_view_business_workflows
from .workflow_english_review import (
    APPLY_SALT, FIELDS, IMAGE_FIELD, REVISION_FIELD, SKU_FIELD, UPLOAD_FIELD, UPLOAD_SALT,
    apply_key, can_apply_review, review_answer, review_panel, review_revision_id, review_source,
)


DISPATCH_SALT = "enterprise.workflow-dispatch.v1"
GENERATION_SALT = "enterprise.delivery-generate.v1"
GENERATION_CONFLICT = "当前还不能生成交付文件。请刷新工作流，核对批次、已确认产品版本及图片来源。"
DISPATCH_CONFLICT = "当前子任务不可执行。请返回工作流查看状态。"


def workflow_access_denial(request):
    if not is_verified_enterprise_session(request):
        query = urlencode({"next": request.get_full_path()})
        return redirect(f"{reverse('login')}?{query}")
    if not can_view_business_workflows(request.user):
        return HttpResponseForbidden("无权读取业务工作流。")
    return None


def _workflows():
    return WorkflowTask.objects.values(
        "id", "batch_id", "batch__title", "task_type", "status", "current_step", "updated_at",
    ).order_by("-updated_at", "id")


def _summary(row):
    return {
        "id": row["id"],
        "title": row["batch__title"],
        "kind": TASK_TYPE_LABELS.get(row["task_type"], "业务工作流"),
        "status": STATUS_LABELS.get(row["status"], "未知状态"),
        "updated_at": row["updated_at"],
    }


@require_GET
@never_cache
def workflow_list(request):
    denied = workflow_access_denial(request)
    if denied is not None:
        return denied

    page = Paginator(_workflows(), 25).get_page(request.GET.get("page"))
    return render(request, "enterprise_portal/business_workflows.html", {
        "page": page,
        "rows": [_summary(row) for row in page],
    })


def _local_plan(workflow_id):
    mode = WorkflowStep.objects.filter(
        task_id=workflow_id, step_key="center_plan", status="completed",
    ).order_by("-attempt", "-created_at", "-id").values_list("input_refs__execution_mode", flat=True).first()
    return mode == "local_mock"


def _dispatch_confirmation(user, workflow_id, status):
    if status not in {"queued", "running"} or not _local_plan(workflow_id):
        return None
    workflow = WorkflowTask.objects.only("id", "status").filter(pk=workflow_id).first()
    if workflow is None:
        return None
    target = resolve_dispatch_target(workflow)
    if not target["subtask_id"]:
        return None
    return signing.dumps({
        "owner": str(user.pk), "workflow": workflow_id, "subtask": target["subtask_id"],
        "key": target["idempotency_key"],
    }, salt=DISPATCH_SALT)


def _generation_offer(workflow_id, status, current_step):
    stages = {
        ("running", "generate_deliverables"),
        ("running", "deliverables_rejected"),
        ("failed", "generate_deliverables_failed"),
    }
    if (status, current_step) not in stages or not _local_plan(workflow_id):
        return None
    roles = list(SubTask.objects.filter(task_id=workflow_id, status="completed").order_by("agent_role")
                 .values_list("agent_role", flat=True))
    if roles != ["delivery_quality", "product_profile"] or SubTask.objects.filter(
        task_id=workflow_id
    ).exclude(status="completed").exists():
        return None
    if HumanReview.objects.filter(task_id=workflow_id, status__in=["pending", "submitted"]).exists():
        return None

    steps = list(WorkflowStep.objects.filter(task_id=workflow_id, step_key="generate_deliverables")
                 .order_by("attempt", "created_at", "id").only("id", "status"))
    latest = steps[-1] if steps else None
    if latest is None and current_step == "generate_deliverables":
        return f"enterprise:delivery:{workflow_id}:initial", "生成交付草稿"
    if latest and latest.status == "failed" and current_step == "generate_deliverables_failed":
        if _consecutive_generation_failures(steps) < MAX_GENERATION_ATTEMPTS:
            return f"enterprise:delivery:{workflow_id}:after:{latest.pk}", "重试生成交付草稿"
    if latest and latest.status == "completed" and current_step == "deliverables_rejected":
        if EventLog.objects.filter(
            task_id=workflow_id, event_type="delivery_bundle_reviewed",
            payload_summary__refs__generation_step_id=latest.pk, payload_summary__refs__decision="reject",
        ).exists():
            return f"enterprise:delivery:{workflow_id}:after:{latest.pk}", "重新生成交付草稿"
    return None


def _generation_form(user, workflow_id, status, current_step):
    offer = _generation_offer(workflow_id, status, current_step)
    if offer is None:
        return None
    key, label = offer
    return {
        "label": label,
        "confirmation": signing.dumps({
            "owner": str(user.pk), "workflow": workflow_id, "key": key,
        }, salt=GENERATION_SALT),
    }


@require_GET
@never_cache
def workflow_detail(request, workflow_id):
    denied = workflow_access_denial(request)
    if denied is not None:
        return denied

    row = get_object_or_404(_workflows(), pk=workflow_id)
    workflow = _summary(row)
    task_nodes = SubTask.objects.filter(task_id=workflow_id).only(
        "id", "agent_role", "status",
    ).order_by("created_at", "id").prefetch_related(
        Prefetch(
            "depends_on",
            queryset=SubTask.objects.filter(task_id=workflow_id).only("id"),
        ),
    )
    task_nodes = list(task_nodes)
    numbers = {node.pk: index for index, node in enumerate(task_nodes, 1)}
    nodes = [{
        "number": numbers[node.pk],
        "label": AGENT_ROLE_LABELS.get(node.agent_role, "其他任务"),
        "status": STATUS_LABELS.get(node.status, "未知状态"),
        "dependencies": sorted(numbers[dependency.pk] for dependency in node.depends_on.all()),
    } for node in task_nodes]

    steps = []
    saved_steps = WorkflowStep.objects.filter(task_id=workflow_id).order_by(
        "created_at", "id",
    ).values_list("step_key", "status", "attempt")
    for key, status, attempt in saved_steps:
        prefix, _, target = key.partition(":")
        number = numbers.get(target) if prefix == "subtask" else None
        label = STEP_LABELS.get(key, "其他步骤")
        if number is not None:
            label = f"任务 {number} · {nodes[number - 1]['label']}"
        steps.append({
            "label": label,
            "status": STATUS_LABELS.get(status, "未知状态"),
            "attempt": attempt,
        })
    delivery_review = workflow_delivery_review(workflow_id, row["status"], row["current_step"])
    return render(request, "enterprise_portal/business_workflows.html", {
        "workflow": workflow,
        "nodes": nodes,
        "steps": steps,
        "dispatch_confirmation": _dispatch_confirmation(request.user, workflow_id, row["status"]),
        "english_review": (
            review_panel(request.user, workflow_id, row["batch_id"], row["status"])
            if _local_plan(workflow_id) else None
        ),
        "generation_form": _generation_form(request.user, workflow_id, row["status"], row["current_step"]),
        "delivery_review": delivery_review,
        "delivery_completed": row["status"] == "completed" and row["current_step"] == "completed",
        "can_complete_delivery": (
            row["status"] == "running" and row["current_step"] == "complete_workflow"
            and bool(delivery_review and delivery_review.get("approved"))
        ),
    })

@require_GET
@never_cache
def run_list(request):
    denied = workflow_access_denial(request)
    if denied is not None:
        return denied

    # WorkflowStep is directly tied to the same workflow scope as workflow_detail.
    # A batch-level AgentRun or a global EventLog does not establish that relation.
    queryset = WorkflowStep.objects.filter(
        Q(started_at__isnull=False) | Q(finished_at__isnull=False),
        task_id__in=_workflows().order_by().values("id"),
    ).order_by(Coalesce("started_at", "finished_at").desc(), "id").values(
        "task_id", "task__batch__title", "step_key", "status", "attempt", "started_at", "finished_at",
    )
    page = Paginator(queryset, 25).get_page(request.GET.get("page"))
    rows = [{
        "task_id": row["task_id"],
        "title": row["task__batch__title"],
        "label": STEP_LABELS.get(row["step_key"], "其他业务步骤"),
        "status": STATUS_LABELS.get(row["status"], "未知状态"),
        "attempt": row["attempt"],
        "started_at": row["started_at"],
        "finished_at": row["finished_at"],
    } for row in page]
    return render(request, "enterprise_portal/business_workflows.html", {
        "page": page, "runs": rows, "runs_page": True,
    })

@require_POST
@csrf_protect
@never_cache
def review_workflow_delivery(request, workflow_id, step_id):
    denied = workflow_access_denial(request)
    if denied is not None:
        return denied
    get_object_or_404(_workflows(), pk=workflow_id)
    get_object_or_404(WorkflowStep.objects.only("id"), pk=step_id, task_id=workflow_id, step_key="generate_deliverables")
    decision = request.POST.getlist("decision")
    if decision not in (["approve"], ["reject"]):
        return HttpResponseBadRequest("请选择批准或驳回交付包。")
    try:
        review_delivery_bundle(workflow_id, step_id, decision=decision[0], reviewer=f"enterprise:{request.user.pk}")
    except DeliveryNotFound as exc:
        raise Http404 from exc
    except DeliveryConflict:
        return HttpResponse("交付包已变化或尚不可审核。请返回工作流重新查看。", status=409)
    detail = reverse("enterprise-workflow-detail", args=[workflow_id])
    query = urlencode({"review": step_id})
    # A fragment-only destination can leave Android WebView on the pre-review document.
    return HttpResponse(status=303, headers={"Location": f"{detail}?{query}#delivery-review"})


@require_POST
@csrf_protect
@never_cache
def complete_workflow_delivery(request, workflow_id):
    denied = workflow_access_denial(request)
    if denied is not None:
        return denied
    get_object_or_404(_workflows(), pk=workflow_id)
    try:
        complete_workflow_with_deliverables(workflow_id)
    except DeliveryNotFound as exc:
        raise Http404 from exc
    except DeliveryConflict:
        return HttpResponse("当前工作流尚不可完成。请返回工作流重新查看。", status=409)
    detail = reverse("enterprise-workflow-detail", args=[workflow_id])
    return HttpResponse(status=303, headers={"Location": f"{detail}?delivery=completed#delivery-review"})


@require_POST
@csrf_protect
@never_cache
def dispatch_workflow_next(request, workflow_id):
    denied = workflow_access_denial(request)
    if denied is not None:
        return denied
    workflow = get_object_or_404(WorkflowTask.objects.only("id", "status"), pk=workflow_id)
    tokens = request.POST.getlist("confirmation")
    if len(tokens) != 1 or not 0 < len(tokens[0]) <= 4096:
        return HttpResponseBadRequest("请从工作流详情执行下一步。")
    try:
        frozen = signing.loads(tokens[0], salt=DISPATCH_SALT)
    except signing.BadSignature:
        return HttpResponseBadRequest("执行凭据无效，请重新打开工作流。")
    if frozen["owner"] != str(request.user.pk) or frozen["workflow"] != workflow_id:
        raise Http404
    if not _local_plan(workflow_id):
        return HttpResponse(DISPATCH_CONFLICT, status=409)

    subtask_id, key = frozen["subtask"], frozen["key"]
    # Replaying a previous form is allowed only for the exact saved attempt.
    # Recomputing the target for the replay would run the next queued role.
    saved = WorkflowStep.objects.filter(task=workflow, idempotency_key=key).values_list("step_key", flat=True).first()
    if saved is None:
        target = resolve_dispatch_target(workflow)
        applicable = (target["subtask_id"], target["idempotency_key"]) == (subtask_id, key)
    else:
        applicable = saved == f"subtask:{subtask_id}"
    if not applicable:
        return HttpResponse(DISPATCH_CONFLICT, status=409)
    try:
        receipt = dispatch_saved_subtask(workflow_id, subtask_id, key)
    except (DispatchTargetNotFound, UnknownSubTaskError) as exc:
        raise Http404 from exc
    except (DependencyNotReady, IdempotencyConflict, NativeAssignmentRequired, StepInProgress, SubTaskNotDispatchable):
        return HttpResponse(DISPATCH_CONFLICT, status=409)
    except WorkflowOrchestrationError:
        return HttpResponse("本地子任务执行失败，请刷新查看已保存状态。", status=500)
    detail = reverse("enterprise-workflow-detail", args=[workflow_id])
    query = urlencode({"executed": receipt["step"]["id"]})
    return HttpResponse(status=303, headers={"Location": f"{detail}?{query}#workflow-tasks"})


@require_POST
@csrf_protect
@never_cache
def generate_workflow_delivery(request, workflow_id):
    denied = workflow_access_denial(request)
    if denied is not None:
        return denied
    workflow = get_object_or_404(WorkflowTask.objects.only("id", "status", "current_step"), pk=workflow_id)
    tokens = request.POST.getlist("confirmation")
    if len(tokens) != 1 or not 0 < len(tokens[0]) <= 4096:
        return HttpResponseBadRequest("请从工作流详情提交交付生成。")
    try:
        frozen = signing.loads(tokens[0], salt=GENERATION_SALT)
    except signing.BadSignature:
        return HttpResponseBadRequest("生成凭据无效，请重新打开工作流。")
    if frozen["owner"] != str(request.user.pk) or frozen["workflow"] != workflow_id:
        raise Http404
    if not _local_plan(workflow_id):
        return HttpResponse(GENERATION_CONFLICT, status=409)

    key = frozen["key"]
    # A replay goes through the desktop service's saved generation receipt.
    saved = WorkflowStep.objects.filter(task=workflow, idempotency_key=key, step_key="generate_deliverables").exists()
    if not saved:
        offer = _generation_offer(workflow_id, workflow.status, workflow.current_step)
        if (offer is None or offer[0] != key) and not WorkflowStep.objects.filter(
            task=workflow, idempotency_key=key, step_key="generate_deliverables"
        ).exists():
            return HttpResponse(GENERATION_CONFLICT, status=409)
    try:
        receipt = generate_deliverables(workflow_id, key)
    except DeliveryNotFound as exc:
        raise Http404 from exc
    except DeliveryConflict:
        return HttpResponse(GENERATION_CONFLICT, status=409)
    except DeliveryGenerationError:
        return HttpResponse("交付文件生成或质检失败。请刷新工作流查看是否可以重试。", status=500)
    detail = reverse("enterprise-workflow-detail", args=[workflow_id])
    query = urlencode({"generated": receipt["step_id"]})
    return HttpResponse(status=303, headers={"Location": f"{detail}?{query}#delivery-review"})


def _english_review_result(workflow_id, **result):
    detail = reverse("enterprise-workflow-detail", args=[workflow_id])
    return HttpResponse(status=303, headers={"Location": f"{detail}?{urlencode(result)}#english-review"})


def _english_review_conflict():
    return HttpResponse("审核事项状态已变化。请返回工作流核对。", status=409)


@require_POST
@csrf_protect
@never_cache
def submit_workflow_english_review(request, workflow_id, review_id):
    denied = workflow_access_denial(request)
    if denied is not None:
        return denied
    workflow = get_object_or_404(WorkflowTask.objects.only("batch_id"), pk=workflow_id)
    if not _local_plan(workflow_id):
        return HttpResponseForbidden("当前工作流无法在这里处理商品资料审核。")
    review = get_object_or_404(HumanReview, pk=review_id, task_id=workflow_id)
    source = review_source(review, workflow_id, workflow.batch_id)
    if source is None or not Product.objects.filter(pk=source[0], task_id=workflow.batch_id).exists():
        raise Http404
    _, field = source
    if set(request.POST) - {field, "csrfmiddlewaretoken"}:
        return HttpResponseBadRequest("请按当前审核事项填写。")
    value = request.POST.get(field, "")
    if field in (IMAGE_FIELD, UPLOAD_FIELD):
        if len(request.POST.getlist(field)) != 1 or not value.strip() or len(value) > TaskFile._meta.pk.max_length:
            return HttpResponseBadRequest("请选择一张图片。")
    elif field == REVISION_FIELD:
        if request.POST.getlist(field) != ["yes"]:
            return HttpResponseBadRequest("请先核对并确认当前版本。")
        value = review_revision_id(review)
    elif field == SKU_FIELD:
        if len(request.POST.getlist(field)) != 1 or not value.strip():
            return HttpResponseBadRequest("请填写修正后的货号。")
        if len(value.strip()) > FIELDS["sku"]["limit"]:
            return HttpResponseBadRequest("SKU 超过现有产品字段长度限制。")
    else:
        if field == "english_name":
            value = value.strip()  # Preserve receipts from the existing English-name form.
        if not value.strip():
            return HttpResponseBadRequest(f'请填写{FIELDS[field]["label"]}。')
        if len(value) > FIELDS[field]["limit"]:
            return HttpResponseBadRequest(f'字段 {field} 超过现有产品字段长度限制。')
    try:
        submit_review(
            workflow_id=workflow_id, review_id=review.pk, review_key=review.review_key,
            reviewer=f"enterprise:{request.user.pk}", answer=review_answer(field, value),
        )
    except ReviewNotFound as exc:
        raise Http404 from exc
    except (ReviewSubmissionConflict, InvalidReviewSubmission):
        return _english_review_conflict()
    return _english_review_result(workflow_id, answer=review.pk)


@require_POST
@csrf_protect
@never_cache
def apply_workflow_english_review(request, workflow_id):
    denied = workflow_access_denial(request)
    if denied is not None:
        return denied
    workflow = get_object_or_404(WorkflowTask.objects.only("batch_id"), pk=workflow_id)
    if not _local_plan(workflow_id):
        return HttpResponseForbidden("当前工作流无法在这里处理商品资料审核。")
    try:
        confirmation = signing.loads(request.POST.get("confirmation", ""), salt=APPLY_SALT)
    except signing.BadSignature:
        return HttpResponseBadRequest("请从工作流详情重新确认应用本批审核。")
    if confirmation["owner"] != str(request.user.pk) or confirmation["workflow"] != workflow_id:
        return HttpResponseForbidden("无权使用此审核确认。")
    review_ids = confirmation["reviews"]
    reviews = HumanReview.objects.filter(task_id=workflow_id, pk__in=review_ids)
    if len(reviews) != len(review_ids) or any(
        not can_apply_review(review, workflow_id, workflow.batch_id)
        for review in reviews
    ):
        return _english_review_conflict()
    try:
        receipt = apply_fact_review_cycle(
            workflow_id=workflow_id, review_ids=review_ids, decision="apply_and_confirm",
            reviewer=f"enterprise:{request.user.pk}", idempotency_key=apply_key(workflow_id, review_ids),
        )
    except FactApplicationNotFound as exc:
        raise Http404 from exc
    except (FactApplicationConflict, InvalidFactApplication):
        return _english_review_conflict()
    return _english_review_result(workflow_id, applied=receipt["center_plan_step_id"])


@require_GET
@never_cache
def preview_workflow_review_image(request, workflow_id, review_id, task_file_id):
    denied = workflow_access_denial(request)
    if denied is not None:
        return denied
    workflow = get_object_or_404(WorkflowTask.objects.only("batch_id"), pk=workflow_id)
    if not _local_plan(workflow_id):
        return HttpResponseForbidden("当前工作流无法在这里预览审核图片。")
    review = get_object_or_404(HumanReview, pk=review_id, task_id=workflow_id)
    source = review_source(review, workflow_id, workflow.batch_id)
    if source is None or source[1] != IMAGE_FIELD or review.status not in {"pending", "submitted", "approved"}:
        raise Http404
    try:
        candidates = frozen_image_candidates_for_review(workflow, review)
    except ValueError:
        return _english_review_conflict()
    candidate = next((item for item in candidates if item["task_file_id"] == task_file_id), None)
    if candidate is None:
        raise Http404
    try:
        content, mime_type, _ = read_task_image(candidate["stored_name"], candidate["original_name"])
    except (DeliveryStorageError, OSError) as exc:
        raise Http404("审核图片不可用。") from exc
    return _review_image_response(content, mime_type)


def _review_image_response(content, mime_type):
    return HttpResponse(content, content_type=mime_type, headers={
        "Content-Security-Policy": "sandbox; default-src 'none'",
        "X-Content-Type-Options": "nosniff",
    })


def _missing_image_review(workflow_id, review_id):
    review = get_object_or_404(HumanReview.objects.select_related("task"), pk=review_id, task_id=workflow_id)
    source = review_source(review, workflow_id, review.task.batch_id)
    if source is None or source[1] != UPLOAD_FIELD:
        raise Http404
    return review


@require_POST
@csrf_protect
@never_cache
def upload_workflow_review_image(request, workflow_id, review_id):
    denied = workflow_access_denial(request)
    if denied is not None:
        return denied
    review = _missing_image_review(workflow_id, review_id)
    if not _local_plan(workflow_id):
        return HttpResponseForbidden("当前工作流无法在这里补充审核图片。")
    try:
        confirmation = signing.loads(request.POST.get("confirmation", ""), salt=UPLOAD_SALT)
    except signing.BadSignature:
        return HttpResponseBadRequest("请返回审核事项重新选择图片。")
    if (confirmation["owner"] != str(request.user.pk) or confirmation["workflow"] != workflow_id
            or confirmation["review"] != review_id):
        return HttpResponseForbidden("无权使用此上传确认。")
    if set(request.POST) - {"csrfmiddlewaretoken", "confirmation"}:
        return HttpResponseBadRequest("请返回审核事项重新选择图片。")
    images = request.FILES.getlist("image")
    if len(images) != 1 or len(request.FILES) != 1 or not 0 < images[0].size <= MAX_IMAGE_BYTES:
        return HttpResponseBadRequest("请选择一张 5 MB 以内的图片。")
    image = images[0]
    try:
        receipt = upload_review_image(
            workflow_id=workflow_id, review_id=review_id, review_key=review.review_key,
            idempotency_key=confirmation["key"], reviewer=f"enterprise:{request.user.pk}",
            original_name=image.name, content=image.read(MAX_IMAGE_BYTES + 1),
        )
    except ReviewNotFound as exc:
        raise Http404 from exc
    except (ReviewImageConflict, OSError):
        return HttpResponse("补图未上传。请核对图片格式和审核状态后重试。", status=409)
    return _english_review_result(workflow_id, uploaded=receipt["upload_step_id"])


@require_GET
@never_cache
def preview_workflow_review_upload(request, workflow_id, review_id, upload_step_id):
    denied = workflow_access_denial(request)
    if denied is not None:
        return denied
    review = _missing_image_review(workflow_id, review_id)
    if not _local_plan(workflow_id):
        return HttpResponseForbidden("当前工作流无法在这里预览审核图片。")
    try:
        _, _, image = validate_upload_credential(review.task, review, upload_step_id)
    except ReviewImageConflict as exc:
        raise Http404("补图凭据不可用。") from exc
    return _review_image_response(image["content"], image["mime_type"])
