from django.contrib.auth import login
from django.http import HttpResponse, HttpResponseForbidden, JsonResponse
from django.shortcuts import render
from django.views.decorators.cache import never_cache
from django.views.decorators.csrf import csrf_protect, ensure_csrf_cookie
from django.views.decorators.debug import sensitive_post_parameters
from django.views.decorators.http import require_GET, require_POST
import time

from . import local_console


def allowed(request):
    try:
        _, port = local_console.installation()
        origin = f"http://127.0.0.1:{port}"
        return (request.META.get("REMOTE_ADDR") == "127.0.0.1"
                and request.get_host() == f"127.0.0.1:{port}"
                and not request.is_secure()
                and not any(key == "HTTP_FORWARDED" or key.startswith("HTTP_X_FORWARDED_") or key in {"HTTP_X_REAL_IP", "HTTP_VIA"} for key in request.META)
                and request.META.get("HTTP_SEC_FETCH_SITE", "none") in {"none", "same-origin"}
                and (request.method == "GET" or request.META.get("HTTP_ORIGIN") == origin))
    except (local_console.LocalConsoleUnavailable, OSError, ValueError, KeyError):
        return False


@never_cache
@require_GET
@ensure_csrf_cookie
def bootstrap(request):
    if not allowed(request):
        return HttpResponseForbidden("本机控制台不可用，请使用正常登录入口。")
    response = render(request, "enterprise_portal/local_console_bootstrap.html")
    response["Referrer-Policy"] = "no-referrer"
    response["Cross-Origin-Resource-Policy"] = "same-origin"
    return response


@never_cache
@require_POST
@sensitive_post_parameters("grant")
@csrf_protect
def redeem(request):
    if not allowed(request):
        return HttpResponseForbidden("本机控制台不可用，请使用正常登录入口。")
    try:
        user = local_console.consume(request.POST.get("grant", ""))
    except (local_console.LocalConsoleUnavailable, OSError, ValueError, KeyError):
        return HttpResponseForbidden("本机授权已失效，请重新运行本机入口。")
    login(request, user, backend="django.contrib.auth.backends.ModelBackend")
    request.session["_tradeloom_local_console"] = time.time() + 900
    request.session.set_expiry(900)
    return JsonResponse({"next": "/enterprise/console/"})
