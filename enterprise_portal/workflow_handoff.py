"""One-time continuation of a server-side workflow in another verified session."""
import re
import secrets
from datetime import timedelta

from django.shortcuts import get_object_or_404, redirect, render
from django.utils import timezone
from django.utils.crypto import salted_hmac
from django.views.decorators.cache import never_cache
from django.views.decorators.csrf import csrf_protect
from django.views.decorators.debug import sensitive_post_parameters
from django.views.decorators.http import require_http_methods, require_POST

from workbench.models import WorkflowTask

from .business_workflows import workflow_access_denial
from .email_login import fingerprint
from .models import WorkflowHandoff


HANDOFF_LIFETIME = timedelta(minutes=5)
CODE_PATTERN = re.compile(r"[A-Za-z0-9_-]{22}")


def _code_digest(user, code):
    return salted_hmac("enterprise-workflow-handoff", f"{fingerprint(user)}:{code}").hexdigest()


def _session_digest(request):
    return salted_hmac("enterprise-workflow-handoff-origin", request.session.session_key).hexdigest()


@never_cache
@require_POST
@csrf_protect
def start(request, workflow_id):
    denied = workflow_access_denial(request)
    if denied is not None:
        return denied

    workflow = get_object_or_404(WorkflowTask.objects.only("id"), pk=workflow_id)
    code = secrets.token_urlsafe(16)
    WorkflowHandoff.objects.update_or_create(user=request.user, defaults={
        "workflow": workflow,
        "code_digest": _code_digest(request.user, code),
        "source_session_digest": _session_digest(request),
        "expires_at": timezone.now() + HANDOFF_LIFETIME,
    })
    return render(request, "enterprise_portal/workflow_handoff.html", {
        "code": code, "workflow_id": workflow.pk,
    })


@never_cache
@require_http_methods(["GET", "POST"])
@csrf_protect
@sensitive_post_parameters("code")
def receive(request):
    denied = workflow_access_denial(request)
    if denied is not None:
        return denied

    template = "enterprise_portal/workflow_handoff.html"
    if request.method == "GET":
        return render(request, template)

    code = request.POST.get("code", "").strip()
    if CODE_PATTERN.fullmatch(code):
        pending = WorkflowHandoff.objects.filter(
            user=request.user, code_digest=_code_digest(request.user, code),
        ).exclude(source_session_digest=_session_digest(request))
        workflow_id = pending.values_list("workflow_id", flat=True).first()
        now = timezone.now()
        if workflow_id is not None and pending.filter(expires_at__gt=now).update(expires_at=now):
            return redirect("enterprise-workflow-detail", workflow_id=workflow_id)

    return render(request, template, {"invalid": True}, status=400)
