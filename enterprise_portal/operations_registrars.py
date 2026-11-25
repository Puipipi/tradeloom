"""Narrow, same-session registrar status proposals; no model or credentials."""
from datetime import timedelta
import hashlib
import json
import logging
import re
import secrets

from django.contrib.auth import get_user_model
from django.db import transaction
from django.utils import timezone


audit = logging.getLogger("tradeloom.operations.audit")


class Rejected(Exception):
    def __init__(self, detail, status=400, current=None):
        self.detail, self.status, self.current = detail, status, current


def parse(message):
    """Only explicit account commands. Unmatched registrar requests stay local."""
    if not isinstance(message, str):
        return None
    text = message.strip().rstrip("。！？!? ")
    patterns = (
        (r"(?:查询|查看|检查)(?:工厂)?登记员\s*[:：]?\s*(.+?)(?:的状态|状态)?", "check"),
        (r"(?:启用|恢复)(?:工厂)?登记员\s*[:：]?\s*(.+)", "enable"),
        (r"(?:停用|禁用)(?:工厂)?登记员\s*[:：]?\s*(.+)", "disable"),
        (r"(?:把|将)?(?:工厂)?登记员\s*(.+?)\s*(?:的状态)?(?:设为|设置为)?\s*(启用|恢复|停用|禁用)", None),
        (r"(?:工厂)?登记员\s*(.+?)\s*(?:的状态|状态)", "check"),
    )
    for pattern, operation in patterns:
        match = re.fullmatch(pattern, text)
        if match:
            return {"operation": operation or ("enable" if match[2] in {"启用", "恢复"} else "disable"),
                    "username": match[1].strip().strip('"“”')}
    if "登记员" in text:
        raise Rejected("请使用完整内部用户名，例如：查询登记员 用户名、启用登记员 用户名、停用登记员 用户名。此类请求不会发送模型。")
    return None


def actor(request):
    from .registrar_setup import can_manage_registrars
    user = get_user_model().objects.filter(pk=request.user.pk).first()
    if user is None or not can_manage_registrars(user):
        raise Rejected("仅有工厂与登记员设置权限的安装管理员可查询或启停登记员。", 403)
    return user


def describe(user):
    return {"id": user.pk, "username": user.username,
            "factories": sorted(user.groups.filter(name__startswith="工厂:").values_list("name", flat=True)),
            "active": user.is_active}


def snapshot(user):
    value = {**describe(user), "staff": user.is_staff, "superuser": user.is_superuser,
             "direct": sorted(user.user_permissions.values_list("pk", flat=True)),
             "groups": [(g.pk, g.name, sorted(g.permissions.values_list("pk", flat=True)))
                        for g in user.groups.order_by("pk")]}
    return hashlib.sha256(json.dumps(value, sort_keys=True, ensure_ascii=True).encode()).hexdigest()


def binding(request):
    if not request.session.session_key:
        raise Rejected("登录会话已失效，请重新登录。", 403)
    return hashlib.sha256(request.session.session_key.encode()).hexdigest()


def key(token):
    return hashlib.sha256(("registrar-proposal:" + token).encode()).hexdigest()[:40]


def prepare(request, command):
    from django.contrib.sessions.backends.db import SessionStore
    from django.contrib.sessions.models import Session
    from .registrar_setup import manageable_target
    manager = actor(request)  # Check before looking up any target.
    if (not isinstance(command, dict) or set(command) != {"operation", "username"}
            or command["operation"] not in {"check", "enable", "disable"}
            or not isinstance(command["username"], str)
            or not re.fullmatch(r"[\w.@+-]{1,150}", command["username"])):
        raise Rejected("请选择查询、启用或停用，并填写完整内部用户名；不接受昵称或账号列表。")
    users = get_user_model().objects.filter(username=command["username"])
    target = users.first()
    if target is None:
        matches = list(get_user_model().objects.filter(username__iexact=command["username"])[:2])
        if len(matches) != 1:
            raise Rejected("账号不存在或不明确，请使用完整内部用户名（区分大小写）。")
        target = matches[0]
    if not manageable_target(target, manager):
        raise Rejected("该账号不是可管理的普通工厂登记员；请在原账号后台核对，未更改账号。", 403)
    current = describe(target)
    desired = command["operation"] == "enable"
    if command["operation"] == "check" or desired == target.is_active:
        detail = "已读取登记员当前状态。" if command["operation"] == "check" else "当前已是所请求状态，无需更改。"
        return {"effect": "read", "proposal": None, "result": {"detail": detail, "registrar": current}}
    token = secrets.token_urlsafe(32)
    payload = {"actor": manager.pk, "session": binding(request), "target": target.pk,
               "snapshot": snapshot(target), "desired": desired}
    Session.objects.create(session_key=key(token), session_data=SessionStore().encode(payload),
                           expire_date=timezone.now() + timedelta(seconds=120))
    audit.info("registrar_proposal_prepared actor_id=%s target_id=%s active=%s", manager.pk, target.pk, desired)
    return {"effect": "proposal", "result": {"detail": "尚未更改。请核对账号、工厂和状态后确认，或取消。"},
            "proposal": {"action": "registrar_status", "token": token, "registrar": current,
                         "requested_active": desired, "expires_in": 120}}


def resolve(request, token, decision):
    from django.contrib.sessions.models import Session
    from .registrar_setup import can_manage_registrars, manageable_target
    if not isinstance(token, str) or not re.fullmatch(r"[A-Za-z0-9_-]{43}", token) or decision not in {"confirm", "cancel"}:
        raise Rejected("提案参数无效。")
    rejected = None
    result = None
    with transaction.atomic():
        row = Session.objects.select_for_update().filter(session_key=key(token)).first()
        if row is None:
            raise Rejected("提案已使用、取消或失效，请重新查询并准备。", 409)
        value = row.get_decoded()
        if value.get("actor") != request.user.pk or value.get("session") != binding(request):
            raise Rejected("此提案不属于当前登录会话。", 403)
        row.delete()  # Failed/stale confirmation also consumes this proposal.
        if row.expire_date <= timezone.now():
            rejected = Rejected("提案已过期，请重新查询并准备。", 409)
        elif decision == "cancel":
            result = {"effect": "cancelled", "proposal": None, "result": {"detail": "提案已取消，账号状态未改变。"}}
        else:
            manager = get_user_model().objects.select_for_update().filter(pk=request.user.pk).first()
            target = get_user_model().objects.select_for_update().filter(pk=value.get("target")).first()
            if manager is None or not can_manage_registrars(manager):
                rejected = Rejected("管理权限已变化；提案已作废，未更改账号。", 403)
            elif target is None:
                rejected = Rejected("目标账号已不存在；请重新查询。", 409)
            elif not manageable_target(target, manager):
                rejected = Rejected("目标角色或授权已变化；提案已作废，未更改账号。", 403)
            elif snapshot(target) != value.get("snapshot"):
                rejected = Rejected("账号状态或工厂已变化；提案已作废，请核对当前状态后重新准备。", 409, describe(target))
            else:
                target.is_active = value["desired"]
                target.save(update_fields=["is_active"])
                result = {"effect": "applied", "proposal": None, "result": {"detail": "已保存；后续请求按新状态检查权限。", "registrar": describe(target)}}
        audit.info("registrar_proposal_resolved actor_id=%s target_id=%s decision=%s outcome=%s", request.user.pk,
                   value.get("target"), decision, "rejected" if rejected else result["effect"])
    if rejected:
        raise rejected
    return result
