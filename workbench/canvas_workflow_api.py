"""Internal Host-to-Django persistence; never accepts browser identity claims."""

import re
import uuid

from django.db import IntegrityError
from django.http import JsonResponse
from django.views.decorators.csrf import csrf_exempt
from django.views.decorators.http import require_http_methods

from .api import _native_bridge_authorized, _parse_standard_json
from .models import CanvasWorkflowRun
from .canvas_workflow_ownership import (
    MAX_OWNERSHIP_BODY_BYTES,
    OwnershipError,
    dispatch_owner_action,
    namespace_descriptor,
    ownership_state,
)

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
    using = getattr(request, "db", None) or "default"
    if request.method == "GET":
        if request.GET.get("action") == "owner_run":
            try:
                payload, status = ownership_state(request.GET.get("id"), request.GET.get("namespaceId"), using=using)
            except OwnershipError as error:
                return JsonResponse({"error_code": error.code}, status=error.status,
                                    json_dumps_params={"ensure_ascii": False, "separators": (",", ":")})
            return JsonResponse(payload, status=status,
                                json_dumps_params={"ensure_ascii": False, "separators": (",", ":")})
        if request.GET.get("action") == "owner_namespace":
            try:
                payload, status = namespace_descriptor(using=using)
            except OwnershipError as error:
                return JsonResponse({"error_code": error.code}, status=error.status)
            return JsonResponse(payload, status=status, json_dumps_params={"ensure_ascii": False, "separators": (",", ":")})
        run_id = request.GET.get("id")
        if run_id:
            try:
                row = CanvasWorkflowRun.objects.filter(pk=uuid.UUID(run_id)).first()
            except ValueError:
                return JsonResponse({"error": "invalid_run_id"}, status=400)
            if row is None:
                return JsonResponse({"error": "run_not_found"}, status=404)
            try:
                from .canvas_workflow_ownership import checked_response

                payload = checked_response({"snapshot": row.snapshot})
            except OwnershipError as error:
                return JsonResponse({"error_code": error.code}, status=error.status,
                                    json_dumps_params={"ensure_ascii": False, "separators": (",", ":")})
            return JsonResponse(payload, json_dumps_params={"ensure_ascii": False, "separators": (",", ":")})
        rows = CanvasWorkflowRun.objects.all()
        workflow_id = request.GET.get("workflow")
        if workflow_id:
            if not WORKFLOW_ID.fullmatch(workflow_id):
                return JsonResponse({"error": "invalid_workflow_id"}, status=400)
            rows = rows.filter(workflow_id=workflow_id)
        if request.GET.get("active") == "1":
            rows = rows.filter(status__in=["running", "waiting", "interrupted"])
        payload = {"runs": [
            {"id": str(row.id), "workflowId": row.workflow_id, "title": row.snapshot.get("title", ""),
             "status": row.status, "executionMode": row.execution_mode,
             "startedAt": row.snapshot.get("startedAt"), "finishedAt": row.snapshot.get("finishedAt"),
             "revision": row.revision}
            for row in rows[:100]
        ]}
        try:
            from .canvas_workflow_ownership import checked_response

            payload = checked_response(payload)
        except OwnershipError as error:
            return JsonResponse({"error_code": error.code}, status=error.status,
                                json_dumps_params={"ensure_ascii": False, "separators": (",", ":")})
        return JsonResponse(payload, json_dumps_params={"ensure_ascii": False, "separators": (",", ":")})
    if len(request.body) > MAX_OWNERSHIP_BODY_BYTES:
        return JsonResponse({"error_code": "recovery_response_too_large"}, status=413)
    body, invalid = _parse_standard_json(request)
    if invalid is not None:
        return invalid
    if isinstance(body, dict) and body.get("protocol") == "canvas-run-owner/v1":
        try:
            payload, status = dispatch_owner_action(body, using=using)
        except OwnershipError as error:
            return JsonResponse({"error_code": error.code}, status=error.status,
                                json_dumps_params={"ensure_ascii": False, "separators": (",", ":")})
        except IntegrityError:
            return JsonResponse({"error_code": "active_workflow_conflict"}, status=409)
        return JsonResponse(payload, status=status, json_dumps_params={"ensure_ascii": False, "separators": (",", ":")})
    # Upgraded writers must present owner proof. Old snapshots remain readable, but
    # proofless POSTs can no longer mutate either legacy or owned rows.
    return JsonResponse({"error_code": "legacy_unmanaged"}, status=409)
