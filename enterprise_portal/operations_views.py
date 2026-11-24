import json
import logging

from django.contrib.auth.decorators import login_required
from django.http import JsonResponse
from django.views.decorators.csrf import csrf_protect
from django.views.decorators.debug import sensitive_variables, sensitive_post_parameters
from django.views.decorators.http import require_GET, require_POST, require_http_methods

from . import operations
from .operations_store import StoreUnavailable

audit = logging.getLogger("tradeloom.operations.audit")


def _denied(request):
    return not operations.can_operate(request.user)


@login_required
@require_GET
def status(request):
    if _denied(request):
        return JsonResponse({"detail": "无服务器运维权限。"}, status=403)
    response = JsonResponse(operations.capabilities())
    response["Cache-Control"] = "no-store"
    return response


def _payload(request, allowed):
    if request.content_type != "application/json" or len(request.body) > 100000:
        raise ValueError()
    data = json.loads(request.body)
    if not isinstance(data, dict) or set(data) - set(allowed):
        raise ValueError()
    return data


@login_required
@require_GET
def ssh_policy(request):
    from .policy import is_enterprise_owner
    from . import operations_ssh
    if _denied(request):
        return JsonResponse({"detail": "无服务器运维权限。"}, status=403)
    if set(request.GET) - {"include_names"} or request.GET.getlist("include_names") not in ([], ["0"], ["1"]):
        return JsonResponse({"detail": "检查参数无效。"}, status=400)
    owner = is_enterprise_owner(request.user)
    include_names = request.GET.get("include_names") == "1"
    if include_names and not owner:
        return JsonResponse({"detail": "仅企业老板可显式查看磁盘声明的名称。"}, status=403)
    response = JsonResponse(operations_ssh.inspect(include_names=include_names, can_view_names=owner))
    response["Cache-Control"] = "no-store"
    return response


@login_required
@csrf_protect
@require_POST
def assistant(request):
    from . import operations_registrars as registrars
    try:
        data = _payload(request, ("command", "message", "consent", "registrar", "proposal", "decision"))
        # Resolve bound proposals even after management permission is revoked:
        # the service consumes failed confirmations rather than reviving them.
        if set(data) == {"proposal", "decision"}:
            result = registrars.resolve(request, data["proposal"], data["decision"])
        else:
            if _denied(request):
                return JsonResponse({"detail": "无服务器运维权限。"}, status=403)
            if set(data) == {"registrar"}:
                result = registrars.prepare(request, data["registrar"])
            elif set(data) == {"command"}:
                result = {"result": operations.execute(data["command"], request.user), "effect": "read", "proposal": None}
            elif "message" in data and set(data) <= {"message", "consent"}:
                message = data["message"]
                notice = isinstance(message, str) and (message.strip().startswith(("发布公告", "替换公告")) or message.strip() == "撤下公告")
                command = None if notice else registrars.parse(message)
                if command is not None:
                    result = registrars.prepare(request, command)
                else:
                    from .operations_ai import route
                    result = route(data["message"], request.user, consent=data.get("consent") is True)
            else:
                raise ValueError()
    except registrars.Rejected as error:
        payload = {"detail": error.detail, "proposal": None}
        if error.current is not None:
            payload["current"] = error.current
        response = JsonResponse(payload, status=error.status)
        response["Cache-Control"] = "no-store"
        return response
    except PermissionError:
        return JsonResponse({"detail": "当前角色无权准备此管理变更。"}, status=403)
    except (ValueError, TypeError):
        return JsonResponse({"detail": "请选择受支持的助手命令。"}, status=400)
    response = JsonResponse(result)
    response["Cache-Control"] = "no-store"
    return response


@login_required
@csrf_protect
@require_http_methods(["GET", "POST"])
def website(request):
    from .policy import is_enterprise_owner
    from . import website_notice
    if _denied(request):
        return JsonResponse({"detail": "无服务器运维权限。"}, status=403)
    can_write = is_enterprise_owner(request.user)
    status_code = 200
    detail = None
    if request.method == "POST":
        if not can_write:
            return JsonResponse({"detail": "仅企业老板可发布或撤下公告。"}, status=403)
        try:
            data = _payload(request, ("text", "revision"))
            if set(data) != {"text", "revision"}:
                raise ValueError()
            if not website_notice.replace(data["text"], data["revision"]):
                status_code, detail = 409, "公告已更新，请重新查看后确认。"
            else:
                audit.info("website_notice_changed actor_id=%s", request.user.pk)
        except (ValueError, TypeError):
            return JsonResponse({"detail": "公告须为至多500个字符，并提供当前版本。"}, status=400)
    payload = {"notice": website_notice.current(), "can_write": can_write}
    if detail:
        payload["detail"] = detail
    response = JsonResponse(payload, status=status_code)
    response["Cache-Control"] = "no-store"
    return response


@login_required
@csrf_protect
@sensitive_variables()
@require_http_methods(["GET", "POST"])
def cloudflare(request):
    from .policy import is_enterprise_owner
    from . import operations_cloudflare as provider
    if _denied(request):
        return JsonResponse({"detail": "无服务器运维权限。"}, status=403)
    owner = is_enterprise_owner(request.user)
    if request.method == "POST" and not owner:
        return JsonResponse({"detail": "仅企业老板可确认清理单个 URL 缓存。"}, status=403)
    try:
        if request.method == "POST":
            data = _payload(request, ("path", "expected_domain", "confirm"))
            payload = provider.purge(operations.vault(), data)
            audit.info("cloudflare_single_url_purged actor_id=%s", request.user.pk)
        else:
            payload = provider.inspect(operations.vault(), owner)
        status_code = 503 if payload["status"] == "not_configured" else 200
    except (ValueError, TypeError, UnicodeError):
        payload, status_code = {"detail": "请确认已核实域名与单个规范路径。"}, 400
    except provider.TargetChanged:
        payload, status_code = {"detail": "站点已变化或未激活，请重新核实再确认。"}, 409
    except (StoreUnavailable, OSError):
        payload, status_code = {"status": "unavailable", "domain": None, "zone_status": None,
                                "can_purge": False, "detail": "服务器安全凭据存储不可用。"}, 503
    except provider.ProviderUnavailable:
        payload, status_code = {"status": "unavailable", "domain": None, "zone_status": None,
                                "can_purge": False, "detail": "Cloudflare 站点核验暂不可用。"}, 502
    response = JsonResponse(payload, status=status_code)
    response["Cache-Control"] = "no-store"
    return response


@login_required
@csrf_protect
@sensitive_post_parameters()
@sensitive_variables()
@require_POST
def credentials(request):
    from .policy import is_enterprise_owner
    if not is_enterprise_owner(request.user):
        return JsonResponse({"detail": "无服务器运维权限。"}, status=403)
    try:
        data = _payload(request, ("action", "slot", "secret"))
        action, slot = data.get("action"), data.get("slot")
        if action not in ("set", "delete") or slot not in operations.SLOTS:
            raise ValueError()
        if action == "delete" and "secret" in data:
            raise ValueError()
        store = operations.vault()
        if action == "set":
            store.set(slot, data.get("secret"))
        else:
            store.delete(slot)
        # No request bodies, secret hashes, values or user-controlled text in audit.
        audit.info("credential_lifecycle actor_id=%s action=%s slot=%s", request.user.pk, action, slot)
    except (ValueError, TypeError):
        return JsonResponse({"detail": "凭据槽或请求格式无效。"}, status=400)
    except (StoreUnavailable, OSError):
        return JsonResponse({"detail": "服务器安全凭据存储不可用。"}, status=503)
    response = JsonResponse({"ok": True})
    response["Cache-Control"] = "no-store"
    return response
