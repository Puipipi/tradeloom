"""Verify a new address before changing an existing account's login address."""

import secrets
from datetime import timedelta

from django.contrib.auth import get_user_model
from django.core.exceptions import ValidationError
from django.core.validators import validate_email
from django.db import transaction
from django.utils import timezone
from django.utils.crypto import constant_time_compare, salted_hmac

from . import login_mail
from .email_login import fingerprint
from .models import EmailBindingChallenge, EmailLoginChallenge


def normalize_address(value):
    if not isinstance(value, str):
        raise ValueError("请填写有效的绑定邮箱。")
    email = value.strip().lower()
    try:
        if len(email) > 254:
            raise ValidationError("Email is too long.")
        validate_email(email)
    except ValidationError:
        raise ValueError("请填写有效的绑定邮箱。") from None
    return email


def prepare_initial_binding(user, email):
    """Record the requested first address without issuing a code or enabling login."""
    EmailBindingChallenge.objects.create(user=user, email=normalize_address(email), credential_version=fingerprint(user))


def _locked_account(username):
    if not isinstance(username, str) or not 0 < len(username.strip()) <= 150:
        raise ValueError("请选择已有且启用的内部账号。")
    user = get_user_model().objects.select_for_update().filter(username=username.strip()).first()
    if not user or not user.is_active or not user.has_usable_password():
        raise ValueError("请选择已有且启用的内部密码账号。")
    return user


def _digest(token, code):
    return salted_hmac("enterprise-email-binding-code-v1", f"{token}:{code}").hexdigest()


@transaction.atomic
def start_binding(username, email=None):
    user = _locked_account(username)
    row = EmailBindingChallenge.objects.select_for_update().filter(user=user).first()
    if email is None:
        if not row or not row.email or not constant_time_compare(row.credential_version, fingerprint(user)):
            raise ValueError("没有可重发的邮箱绑定请求，请重新填写绑定邮箱。")
        target = row.email
    else:
        target = normalize_address(email)
    if target == user.email.strip().lower():
        raise ValueError("此邮箱已是当前登录邮箱。")

    now = timezone.now()
    if row and row.last_sent_at and now - row.last_sent_at < timedelta(seconds=60):
        raise ValueError("发送过于频繁，请 60 秒后重新操作。")
    same_window = row and row.window_started_at and now - row.window_started_at < timedelta(hours=1)
    sends_in_window = row.sends_in_window if same_window else 0
    if sends_in_window >= 5:
        raise ValueError("该账号本小时发送次数已达上限，请稍后再试。")

    nonce = secrets.token_urlsafe(32)
    code = f"{secrets.randbelow(100000000):08d}"
    try:
        login_mail.send_binding_code(target, code)
    except Exception:
        raise ValueError("绑定验证码暂时无法发送，请检查服务器发信配置。") from None
    EmailBindingChallenge.objects.update_or_create(user=user, defaults={
        "email": target,
        "token": nonce,
        "code_digest": _digest(nonce, code),
        "credential_version": fingerprint(user),
        "expires_at": now + timedelta(minutes=5),
        "last_sent_at": now,
        "window_started_at": row.window_started_at if same_window else now,
        "sends_in_window": sends_in_window + 1,
        "attempts_left": 5,
    })


def confirm_binding(username, code):
    with transaction.atomic():
        user = _locked_account(username)
        row = EmailBindingChallenge.objects.select_for_update().filter(user=user).first()
        if (not row or not row.email or not row.code_digest or not row.attempts_left
                or not row.expires_at or row.expires_at <= timezone.now()
                or not constant_time_compare(row.credential_version, fingerprint(user))):
            raise ValueError("绑定验证码已失效，请重新获取绑定验证码。")

        valid_code = isinstance(code, str) and len(code) == 8 and code.isascii() and code.isdigit()
        if valid_code and constant_time_compare(row.code_digest, _digest(row.token, code)):
            user.email = row.email
            user.save(update_fields=["email"])
            EmailLoginChallenge.objects.filter(user=user).update(code_digest="", attempts_left=0)
            # Retain the sending budget so binding success cannot reset rate limits.
            row.email = row.token = row.code_digest = row.credential_version = ""
            row.expires_at = None
            row.attempts_left = 0
            row.save(update_fields=["email", "token", "code_digest", "credential_version", "expires_at", "attempts_left"])
            return

        row.attempts_left -= 1
        row.save(update_fields=["attempts_left"])
    # Commit the failure counter before returning an error to the authorized manager.
    raise ValueError("绑定验证码不正确，连续错误 5 次后需重新获取。")
