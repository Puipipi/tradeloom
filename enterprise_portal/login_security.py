"""Narrow account-email and SMTP maintenance; never grants roles or sessions."""
from django import forms
from django.contrib import messages
from django.contrib.auth import get_user_model
from django.contrib.auth.decorators import login_required
from django.core.exceptions import PermissionDenied
from django.db.models import Exists, OuterRef
from django.shortcuts import render, redirect
from django.views.decorators.csrf import csrf_protect
from django.views.decorators.debug import sensitive_post_parameters
from django.views.decorators.http import require_http_methods
from . import login_mail
from .email_binding import confirm_binding, start_binding
from .models import EmailBindingChallenge
from .local_console_views import allowed


def can_maintain(request):
    local = request.session.get("_tradeloom_local_console") is not None and allowed(request)
    return request.user.is_authenticated and request.user.is_active and (request.user.is_superuser or local)


class EmailAccountForm(forms.Form):
    username = forms.CharField(label="织贸内部账号", max_length=150)


class EmailBindingForm(EmailAccountForm):
    email = forms.EmailField(label="新邮箱", max_length=254)


class EmailBindingConfirmationForm(EmailAccountForm):
    code = forms.CharField(
        label="8 位绑定验证码", max_length=8,
        widget=forms.PasswordInput(attrs={"inputmode": "numeric", "autocomplete": "one-time-code"}),
    )


class SmtpForm(forms.Form):
    host = forms.CharField(label="SMTP 主机", max_length=253)
    port = forms.IntegerField(label="SMTP 端口", min_value=1, max_value=65535)
    security = forms.ChoiceField(label="加密方式", choices=[("ssl", "SSL"), ("starttls", "STARTTLS")])
    username = forms.CharField(label="SMTP 账号", max_length=150)
    password = forms.CharField(label="SMTP 授权密码", widget=forms.PasswordInput(render_value=False), max_length=4096)
    from_email = forms.EmailField(label="发件邮箱")


def _posted_form(form_class, values, fields):
    if set(values) - {"csrfmiddlewaretoken"} != {*fields, "action"} or any(
        len(values.getlist(field)) != 1 for field in (*fields, "action")
    ) or len(values.getlist("csrfmiddlewaretoken")) > 1:
        raise ValueError("登录安全操作参数无效。")
    form = form_class(values)
    if not form.is_valid():
        raise ValueError("请填写完整、有效的登录安全参数。")
    return form.cleaned_data


@login_required
@require_http_methods(["GET", "POST"])
@csrf_protect
@sensitive_post_parameters("password", "code", "email")
def settings_page(request):
    if not can_maintain(request):
        raise PermissionDenied
    error = ""
    account = ""
    smtp_status = login_mail.configuration_status()
    smtp_replacing = smtp_status["smtp_configured"] and request.GET.get("smtp") == "reset"
    if request.method == "POST":
        action = request.POST.get("action")
        try:
            if action in {"email", "email-start"}:
                values = _posted_form(EmailBindingForm, request.POST, ("username", "email"))
                start_binding(**values)
                messages.success(request, "已发送绑定验证码。验证成功后，新邮箱才会用于登录。")
            elif action == "email-resend":
                values = _posted_form(EmailAccountForm, request.POST, ("username",))
                start_binding(**values)
                messages.success(request, "已发送绑定验证码。验证成功后，新邮箱才会用于登录。")
            elif action == "email-verify":
                values = _posted_form(EmailBindingConfirmationForm, request.POST, ("username", "code"))
                confirm_binding(**values)
                messages.success(request, "邮箱绑定已验证。该账号须重新进行两步登录。")
                return redirect("enterprise-login-security")
            elif action in {"smtp", "smtp-replace"}:
                smtp_replacing = action == "smtp-replace" and smtp_status["smtp_configured"]
                values = _posted_form(
                    SmtpForm, request.POST,
                    ("host", "port", "security", "username", "password", "from_email"),
                )
                try:
                    login_mail.configure(values, replace=(action == "smtp-replace"))
                except Exception:
                    raise ValueError("发信设置未保存，请核对 SMTP 配置和本机密钥存储权限。") from None
                messages.success(request, "发信设置已保存。")
                return redirect("enterprise-login-security")
            else:
                raise ValueError("不支持的设置操作。")
            account = values["username"]
        except ValueError as exc:
            error = str(exc)
            if action in {"smtp", "smtp-replace"}:
                smtp_status = login_mail.configuration_status()
            if action in {"email", "email-start", "email-resend", "email-verify"}:
                account = request.POST.get("username", "")[:150]

    pending = EmailBindingChallenge.objects.filter(user_id=OuterRef("pk")).exclude(email="")
    accounts = (get_user_model().objects.exclude(password__startswith="!")
                .order_by("username").only("username", "email", "is_active")
                .annotate(email_binding_pending=Exists(pending)))
    return render(request, "enterprise_portal/login_security.html", {
        "binding": EmailBindingForm(initial={"username": account}, auto_id="binding_%s"),
        "resend": EmailAccountForm(initial={"username": account}, auto_id="resend_%s"),
        "confirm": EmailBindingConfirmationForm(initial={"username": account}, auto_id="confirm_%s"),
        "smtp": SmtpForm(), **smtp_status, "smtp_replacing": smtp_replacing,
        "error": error, "accounts": accounts,
    })
