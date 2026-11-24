"""Password first, email second. Only a consumed challenge can mint a web session."""
import secrets
from datetime import timedelta
from django import forms
from django.contrib.auth import authenticate, get_user_model, login, logout
from django.contrib.auth.forms import AuthenticationForm
from django.core.exceptions import ValidationError
from django.core.validators import validate_email
from django.db import transaction
from django.http import JsonResponse, HttpResponseRedirect
from django.shortcuts import render
from django.urls import reverse
from django.utils import timezone
from django.utils.crypto import constant_time_compare, salted_hmac
from django.utils.http import url_has_allowed_host_and_scheme
from django.views.decorators.cache import never_cache
from django.views.decorators.csrf import csrf_protect, ensure_csrf_cookie
from django.views.decorators.debug import sensitive_post_parameters
from django.views.decorators.http import require_http_methods
from .models import EmailLoginChallenge
from . import login_mail

PENDING = "enterprise_email_pending"
VERIFIED = "enterprise_email_verified_v1"


def fingerprint(user):
    return salted_hmac("enterprise-email-binding", f"{user.pk}:{user.email.strip().lower()}:{user.get_session_auth_hash()}").hexdigest()


def digest(token, code):
    return salted_hmac("enterprise-email-code", f"{token}:{code}").hexdigest()


def valid_user(challenge, user):
    return user.is_active and user.has_usable_password() and challenge.email == user.email.strip().lower() and constant_time_compare(challenge.credential_version, fingerprint(user))


def start_challenge(user, previous_token=None):
    now = timezone.now()
    expected = fingerprint(user)
    with transaction.atomic():
        user = get_user_model().objects.select_for_update().get(pk=user.pk)
        if not user.is_active or not user.has_usable_password() or not constant_time_compare(expected, fingerprint(user)):
            raise ValueError("账号状态已变化，请重新登录。")
        email = user.email.strip().lower()
        try:
            validate_email(email)
        except ValidationError:
            raise ValueError("账号尚未绑定有效邮箱，请联系服务器管理员在“登录安全”中补绑。") from None
        old = EmailLoginChallenge.objects.filter(user=user).first()
        if previous_token is not None and (not old or old.token != previous_token or not valid_user(old, user) or old.expires_at <= now or old.attempts_left == 0 or not old.code_digest):
            raise ValueError("验证请求已失效，请重新输入账号密码。")
        if old and now - old.last_sent_at < timedelta(seconds=60):
            raise ValueError("发送过于频繁，请 60 秒后重新操作。")
        window = old.window_started_at if old and now - old.window_started_at < timedelta(hours=1) else now
        sends = old.sends_in_window if old and window == old.window_started_at else 0
        if sends >= 5:
            raise ValueError("该账号本小时发送次数已达上限，请稍后再试。")
        token = secrets.token_urlsafe(32)
        code = f"{secrets.randbelow(1000000):06d}"
        try:
            login_mail.send_code(email, code)
        except Exception:
            raise ValueError("验证码暂时无法发送，请联系服务器管理员检查邮件配置，稍后重试。") from None
        EmailLoginChallenge.objects.update_or_create(user=user, defaults={
            "token": token, "code_digest": digest(token, code), "email": email,
            "credential_version": fingerprint(user), "expires_at": now + timedelta(minutes=5),
            "last_sent_at": now, "window_started_at": window, "sends_in_window": sends + 1, "attempts_left": 5,
        })
        return token


def consume(token, code):
    # Always lock user first, the same ordering as issue/resend and email maintenance.
    row = EmailLoginChallenge.objects.filter(token=token).values("user_id").first()
    if not row:
        raise ValueError("验证请求已失效，请重新输入账号密码。")
    with transaction.atomic():
        user = get_user_model().objects.select_for_update().get(pk=row["user_id"])
        challenge = EmailLoginChallenge.objects.select_for_update().filter(user=user, token=token).first()
        if not challenge or not valid_user(challenge, user) or challenge.expires_at <= timezone.now() or not challenge.code_digest or challenge.attempts_left == 0:
            error = "验证码已失效，请重新输入账号密码获取验证码。"
        elif not isinstance(code, str) or len(code) != 6 or not code.isascii() or not code.isdigit() or not constant_time_compare(challenge.code_digest, digest(token, code)):
            challenge.attempts_left -= 1
            challenge.save(update_fields=["attempts_left"])
            error = "验证码不正确，请重试；连续错误 5 次后需要重新登录。"
        else:
            challenge.code_digest = ""
            challenge.attempts_left = 0
            challenge.save(update_fields=["code_digest", "attempts_left"])
            return user
    # Raise after the transaction so failed-attempt counters are committed.
    raise ValueError(error)


def target(request):
    value = request.POST.get("next") or request.GET.get("next") or "/enterprise/"
    return value if value.startswith("/") and url_has_allowed_host_and_scheme(value, {request.get_host()}, require_https=request.is_secure()) else "/enterprise/"


@never_cache
@ensure_csrf_cookie
@csrf_protect
@sensitive_post_parameters("password", "code")
@require_http_methods(["GET", "POST"])
def sign_in(request):
    form = AuthenticationForm(request)
    error = ""
    next_url = target(request)
    if request.method == "POST":
        action = request.POST.get("action", "password")
        try:
            allowed = {"password": {"username", "password"}, "verify": {"code"}, "resend": set(), "restart": set()}
            if action not in allowed or set(request.POST) - allowed[action] - {"action", "next", "csrfmiddlewaretoken"}:
                raise ValueError("登录参数无效。")
            if action == "password":
                form = AuthenticationForm(request, data=request.POST)
                if not form.is_valid():
                    raise ValueError("账号或密码不正确，或账号已停用。")
                user = form.get_user()
                token = start_challenge(user)
                request.session[PENDING] = token
                request.session["enterprise_email_next"] = next_url
            elif action == "resend":
                token = request.session.get(PENDING, "")
                challenge = EmailLoginChallenge.objects.select_related("user").filter(token=token).first()
                if not challenge:
                    raise ValueError("验证请求已失效，请重新输入账号密码。")
                request.session[PENDING] = start_challenge(challenge.user, token)
            elif action == "restart":
                request.session.pop(PENDING, None)
            else:
                user = consume(request.session.get(PENDING, ""), request.POST.get("code", ""))
                next_url = request.session.pop("enterprise_email_next", "/enterprise/")
                login(request, user, backend="django.contrib.auth.backends.ModelBackend")
                request.session[VERIFIED] = fingerprint(user)
                request.session.pop(PENDING, None)
                return HttpResponseRedirect(next_url)
        except ValueError as exc:
            error = str(exc)
        if request.headers.get("Accept") == "application/json":
            if error:
                return JsonResponse({"error": error}, status=400)
            return JsonResponse({"step": "email_code" if request.session.get(PENDING) else "password", "message": "验证码已发送至账号绑定邮箱，5 分钟内有效。"}, status=202)
    return render(request, "enterprise_portal/login.html", {"form": form, "login_error": error,
        "email_step": bool(request.session.get(PENDING)), "next": request.session.get("enterprise_email_next", next_url)})


class EmailVerificationMiddleware:
    def __init__(self, get_response):
        self.get_response = get_response

    def __call__(self, request):
        if request.user.is_authenticated and request.session.get("_tradeloom_local_console") is None:
            if not constant_time_compare(str(request.session.get(VERIFIED, "")), fingerprint(request.user)):
                logout(request)
        return self.get_response(request)
