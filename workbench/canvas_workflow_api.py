"""Internal Host-to-Django persistence; never accepts browser identity claims."""

import re
import uuid

from django.db import IntegrityError, transaction
from django.http import JsonResponse
from django.views.decorators.csrf import csrf_exempt
from django.views.decorators.http import require_http_methods

from .api import _native_bridge_authorized, _parse_standard_json
from .models import CanvasWorkflowRun

WORKFLOW_ID = re.compile(r"[a-z0-9][a-z0-9_-]{0,47}\Z")
STATUSES = {"running", "waiting", "done", "failed", "cancelled", "interrupted"}
MODES = {"native_dsh", "local_mock", "custom"}


def _valid(snapshot, expected):
    if not isinstance(snapshot, dict) or type(expected) is not int or expected < 0:
        return False
    try:
        if str(uuid.UUID(snapshot.get("id", ""))) != snapshot["id"]:
            return False
    except (ValueError, TypeError, AttributeError):
        return False
    return (
        isinstance(snapshot.get("workflowId"), str)
        and WORKFLOW_ID.fullmatch(snapshot["workflowId"]) is not None
        and snapshot.get("status") in STATUSES
        and snapshot.get("executionMode") in MODES
        and type(snapshot.get("revision")) is int
        and snapshot["revision"] == expected + 1
        and isinstance(snapshot.get("title"), str) and len(snapshot["title"]) <= 100
        and isinstance(snapshot.get("nodes"), dict) and len(snapshot["nodes"]) <= 40
        and isinstance(snapshot.get("document"), dict)
        and snapshot["document"].get("id") == snapshot["workflowId"]
    )


@csrf_exempt  # A paired-process bearer key is required even for reads; browser cookies grant no access.
@require_http_methods(["GET", "POST"])
def runs(request):
    if not _native_bridge_authorized(request):
        return JsonResponse({"error": "native_bridge_required"}, status=403)
    if request.method == "GET":
        run_id = request.GET.get("id")
        if run_id:
            try:
                row = CanvasWorkflowRun.objects.filter(pk=uuid.UUID(run_id)).first()
            except ValueError:
                return JsonResponse({"error": "invalid_run_id"}, status=400)
            return (JsonResponse({"snapshot": row.snapshot}) if row else
                    JsonResponse({"error": "run_not_found"}, status=404))
        rows = CanvasWorkflowRun.objects.all()
        workflow_id = request.GET.get("workflow")
        if workflow_id:
            if not WORKFLOW_ID.fullmatch(workflow_id):
                return JsonResponse({"error": "invalid_workflow_id"}, status=400)
            rows = rows.filter(workflow_id=workflow_id)
        if request.GET.get("active") == "1":
            rows = rows.filter(status__in=["running", "waiting", "interrupted"])
        return JsonResponse({"runs": [
            {"id": str(row.id), "workflowId": row.workflow_id, "title": row.snapshot.get("title", ""),
             "status": row.status, "executionMode": row.execution_mode,
             "startedAt": row.snapshot.get("startedAt"), "finishedAt": row.snapshot.get("finishedAt"),
             "revision": row.revision}
            for row in rows[:100]
        ]})
    if len(request.body) > 2 * 1024 * 1024:
        return JsonResponse({"error": "snapshot_too_large"}, status=413)
    body, invalid = _parse_standard_json(request)
    if invalid is not None:
        return invalid
    snapshot, expected = body.get("snapshot"), body.get("expectedRevision")
    if not _valid(snapshot, expected):
        return JsonResponse({"error": "invalid_snapshot"}, status=400)
    try:
        with transaction.atomic():
            row = CanvasWorkflowRun.objects.select_for_update().filter(pk=snapshot["id"]).first()
            if row is None:
                if expected != 0:
                    return JsonResponse({"error": "revision_conflict"}, status=409)
                row = CanvasWorkflowRun(id=snapshot["id"], workflow_id=snapshot["workflowId"])
                status = 201
            else:
                if (row.revision != expected or row.workflow_id != snapshot["workflowId"]
                        or row.execution_mode != snapshot["executionMode"]
                        or row.snapshot.get("document") != snapshot["document"]
                        or row.snapshot.get("startedAt") != snapshot.get("startedAt")
                        or row.status in {"done", "failed", "cancelled"}):
                    return JsonResponse({"error": "revision_conflict"}, status=409)
                status = 200
            row.revision = snapshot["revision"]
            row.status = snapshot["status"]
            row.execution_mode = snapshot["executionMode"]
            row.snapshot = snapshot
            row.save()
    except IntegrityError:
        return JsonResponse({"error": "active_run_or_revision_conflict"}, status=409)
    return JsonResponse({"snapshot": row.snapshot}, status=status)
