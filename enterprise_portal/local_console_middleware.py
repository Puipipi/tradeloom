"""Place after AuthenticationMiddleware; restrict only locally minted sessions."""
import time
from django.contrib.auth import logout
from django.http import HttpResponseForbidden
from . import local_console
from .local_console_views import allowed


class LocalConsoleSessionMiddleware:
    def __init__(self, get_response):
        self.get_response = get_response

    def __call__(self, request):
        expires = request.session.get("_tradeloom_local_console")
        if expires is not None:
            if not (request.path.startswith(("/enterprise/console/", "/api/enterprise/operations/", "/enterprise/local-console/", "/static/")) or request.path == "/accounts/logout/"):
                return HttpResponseForbidden("本机授权仅用于服务器管理，不能用于业务或个人端登录。")
            valid = isinstance(expires, (int, float)) and expires > time.time() and allowed(request)
            if valid:
                try:
                    value, _ = local_console.issuer()
                    valid = local_console.technician(value).pk == request.user.pk
                except (local_console.LocalConsoleUnavailable, OSError, ValueError, KeyError):
                    valid = False
            if not valid:
                logout(request)
                return HttpResponseForbidden("本机授权会话不可用于此入口，请使用正常登录。")
        return self.get_response(request)
