"""Owner-only read access to registered desktop ArtifactVersion records."""
from urllib.parse import urlencode

from django.db.models import F
from django.http import FileResponse, HttpResponse, HttpResponseForbidden, JsonResponse
from django.shortcuts import redirect, render
from django.urls import reverse
from django.views.decorators.cache import never_cache
from django.views.decorators.http import require_GET

from workbench.delivery.service import (
    DeliveryConflict,
    DeliveryNotFound,
    get_artifact_preview,
    verify_download_version,
)
from workbench.delivery.storage import DELIVERY_FILES, DeliveryStorageError, resolve_artifact_file
from workbench.models import ArtifactVersion, EventLog, HumanReview, WorkflowStep

from .email_login import is_verified_enterprise_session
from .policy import is_enterprise_owner

_TYPE_LABELS = {
    "catalog_html": "商品目录 HTML",
    "catalog_markdown": "商品目录 Markdown",
    "sample_checklist_csv": "样品清单 CSV",
    "sample_checklist_json": "样品清单 JSON",
    "quality_report_json": "质量报告 JSON",
}
_STATUS_LABELS = {
    "draft": "草稿",
    "pending_review": "待审核",
    "approved": "已批准",
    "rejected": "已驳回",
}
_PREVIEW_TYPES = {"catalog_html", "catalog_markdown", "sample_checklist_csv"}
_LIST_LIMIT = 100


def _authorization_response(request):
    if not is_verified_enterprise_session(request):
        next_value = urlencode({"next": request.get_full_path()})
        return redirect(f"{reverse('login')}?{next_value}")
    if not is_enterprise_owner(request.user):
        response = HttpResponseForbidden("无权读取交付版本。")
        response["Cache-Control"] = "no-store"
        return response
    return None


@require_GET
@never_cache
def version_list(request):
    denied = _authorization_response(request)
    if denied is not None:
        return denied
    if request.GET:
        return JsonResponse({"detail": "此入口不接受查询参数。"}, status=400)

    versions = ArtifactVersion.objects.select_related(
        "artifact", "artifact__task", "artifact__task__batch"
    ).filter(artifact__artifact_type__in=DELIVERY_FILES).order_by(
        "-created_at", "id"
    )[:_LIST_LIMIT]
    rows = []
    for version in versions:
        workflow_id = version.artifact.task_id
        try:
            # Listing performs only the private-root containment and file
            # existence checks. Full content hashing belongs to preview and
            # download, so the index never reads up to 100 whole files.
            path = resolve_artifact_file(version.file_path)
            byte_size = path.stat().st_size
        except (FileNotFoundError, DeliveryStorageError, OSError):
            # An absent or outside-root file is not a usable delivery.
            continue
        artifact_type = version.artifact.artifact_type
        rows.append({
            "workflow_id": workflow_id,
            "version_id": version.id,
            "batch_title": version.artifact.task.batch.title,
            "artifact_type_label": _TYPE_LABELS[artifact_type],
            "filename": DELIVERY_FILES[artifact_type],
            "version_number": version.version,
            "status_label": _STATUS_LABELS.get(version.status, version.status),
            "created_at": version.created_at,
            "byte_size": byte_size,
            "preview_url": (
                reverse("enterprise-delivery-preview", args=[workflow_id, version.id])
                if artifact_type in _PREVIEW_TYPES else None
            ),
            "download_url": reverse(
                "enterprise-delivery-download", args=[workflow_id, version.id]
            ),
        })
    return render(request, "enterprise_portal/delivery_versions.html", {
        "rows": rows,
        "limit": _LIST_LIMIT,
        "workflow_home": reverse("enterprise-home"),
    })


@require_GET
@never_cache
def preview_version(request, workflow_id, version_id):
    denied = _authorization_response(request)
    if denied is not None:
        return denied
    if request.GET:
        return JsonResponse({"detail": "此入口不接受查询参数。"}, status=400)
    try:
        version, content, mime_type = get_artifact_preview(workflow_id, version_id)
    except DeliveryNotFound:
        return HttpResponse("交付版本不存在或文件不可用。", status=404)
    except DeliveryConflict as exc:
        return HttpResponse(str(exc), status=409)

    response = HttpResponse(content, content_type=mime_type)
    response["Content-Security-Policy"] = (
        "sandbox; default-src 'none'; img-src data:; style-src 'unsafe-inline'"
    )
    response["X-Content-Type-Options"] = "nosniff"
    response["Content-Disposition"] = (
        f'inline; filename="{DELIVERY_FILES[version.artifact.artifact_type]}"'
    )
    return response


@require_GET
@never_cache
def download_version(request, workflow_id, version_id):
    denied = _authorization_response(request)
    if denied is not None:
        return denied
    if request.GET:
        return JsonResponse({"detail": "此入口不接受查询参数。"}, status=400)
    try:
        _, path, filename = verify_download_version(workflow_id, version_id)
    except DeliveryNotFound:
        return HttpResponse("交付版本不存在或文件不可用。", status=404)
    except DeliveryConflict as exc:
        return HttpResponse(str(exc), status=409)
    try:
        handle = path.open("rb")
    except OSError:
        return HttpResponse("登记的交付文件不可用。", status=404)
    response = FileResponse(handle, as_attachment=True, filename=filename)
    response["X-Content-Type-Options"] = "nosniff"
    return response

def workflow_delivery_review(workflow_id, status, current_step):
    """Project the current desktop bundle and the persisted review decision."""
    step = WorkflowStep.objects.filter(task_id=workflow_id, step_key="generate_deliverables").order_by(
        "-attempt", "-created_at", "-id"
    ).values("id", "status", "output_refs").first()
    if step is None or step["status"] != "completed":
        return None
    decisions = {"approve": "已批准", "reject": "已驳回"}
    decision = EventLog.objects.filter(
        task_id=workflow_id, event_type="delivery_bundle_reviewed",
        payload_summary__refs__generation_step_id=step["id"],
    ).order_by("created_at", "id").values_list("payload_summary__refs__decision", flat=True).first()
    if isinstance(decision, str) and decision in decisions:
        return {"result": decisions[decision], "approved": decision == "approve"}
    if status != "waiting_human" or current_step != "review_deliverables":
        return None
    if HumanReview.objects.filter(task_id=workflow_id, status__in=["pending", "submitted"]).exists():
        return None
    refs = step["output_refs"]
    ids = refs.get("artifact_version_ids") if isinstance(refs, dict) else None
    if (not isinstance(ids, list) or len(ids) != len(DELIVERY_FILES)
            or any(not isinstance(item, str) for item in ids) or refs.get("quality_status") != "passed"):
        return None
    versions = list(ArtifactVersion.objects.filter(
        pk__in=ids, status="pending_review", artifact__task_id=workflow_id,
        artifact__status="pending_review", artifact__current_version=F("version"),
    ).order_by("artifact__artifact_type").values("id", "version", "artifact__artifact_type"))
    if {version["artifact__artifact_type"] for version in versions} != set(DELIVERY_FILES):
        return None
    return {
        "step_id": step["id"],
        "versions": [
            {"id": version["id"], "number": version["version"], "label": _TYPE_LABELS[version["artifact__artifact_type"]],
             "preview": version["artifact__artifact_type"] in _PREVIEW_TYPES}
            for version in versions
        ],
    }
