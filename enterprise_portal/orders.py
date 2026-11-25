"""Read-only enterprise portal entry to the existing order follow-up contract."""
from urllib.parse import urlencode

from django.contrib.auth import REDIRECT_FIELD_NAME
from django.core.exceptions import PermissionDenied
from django.http import JsonResponse
from django.shortcuts import redirect, render
from django.urls import reverse
from django.views.decorators.cache import never_cache
from django.views.decorators.http import require_GET

from workbench import orders_api

from .email_login import is_verified_enterprise_session
from .policy import capability_policy


@require_GET
@never_cache
def order_search(request):
    if not is_verified_enterprise_session(request):
        target = reverse("login")
        next_url = urlencode({REDIRECT_FIELD_NAME: request.get_full_path()})
        return redirect(f"{target}?{next_url}")
    caps = capability_policy(request.user)
    if not caps["order_followup"]:
        raise PermissionDenied
    return render(request, "enterprise_portal/orders.html", {"caps": caps})


@require_GET
@never_cache
def order_api(request):
    if not is_verified_enterprise_session(request):
        response = JsonResponse({"ok": False, "error_code": "enterprise_session_required"}, status=401)
        response["Cache-Control"] = "no-store"
        return response
    if not capability_policy(request.user)["order_followup"]:
        response = JsonResponse({"ok": False, "error_code": "permission_denied"}, status=403)
        response["Cache-Control"] = "no-store"
        return response
    # Delegate the exact same query contract and projections used by the desktop
    # order screen. This portal route is the only enterprise URL exposing it.
    response = orders_api.order_followup(request)
    response["Cache-Control"] = "no-store"
    return response
