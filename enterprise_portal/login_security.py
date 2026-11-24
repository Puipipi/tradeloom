"""Narrow account-email and SMTP maintenance; never grants roles or sessions."""
from django import forms
from django.contrib import messages
from django.contrib.auth import get_user_model
from django.contrib.auth.decorators import login_required
from django.core.exceptions import PermissionDenied
from django.db import transaction
from django.shortcuts import render, redirect
from django.views.decorators.csrf import csrf_protect
from django.views.decorators.debug import sensitive_post_parameters
from django.views.decorators.http import require_http_methods
from . import login_mail
from .models import EmailLoginChallenge
from .local_console_views import allowed


def can_maintain(request):
    local = request.session.get("_tradeloom_local_console") is not None and allowed(request)
    return request.user.is_authenticated and request.user.is_active and (request.user.is_superuser or local)


class EmailBindingForm(forms.Form):
    username = forms.CharField(label="织贸内部账号", max_length=150)
    email = forms.EmailField(label="绑定邮箱", max_length=254)


class SmtpForm(forms.Form):
    host = forms.CharField(label="SMTP 主机", max_length=253)
    port = forms.IntegerField(label="SMTP 端口", min_value=1, max_value=65535)
    security = forms.ChoiceField(label="加密方式", choices=[("ssl", "SSL"), ("starttls", "STARTTLS")])
    username = forms.CharField(label="SMTP 账号", max_length=150)
    password = forms.CharField(label="SMTP 授权密码", widget=forms.PasswordInput(render_value=False), max_length=4096)
    from_email = forms.EmailField(label="发件邮箱")


def bind_email(username, email):
    form = EmailBindingForm({"username": username, "email": email})
    if not form.is_valid():
        raise ValueError("请填写已有内部账号和有效邮箱。")
    with transaction.atomic():
        user = get_user_model().objects.select_for_update().filter(username=form.cleaned_data["username"]).first()
        if not user or not user.has_usable_password():
            raise ValueError("请选择具有密码的已有内部账号；不修改本机运维专用身份。")
        user.email = form.cleaned_data["email"].strip().lower()
        user.save(update_fields=["email"])
        EmailLoginChallenge.objects.filter(user=user).update(code_digest="", attempts_left=0)


@login_required
@require_http_methods(["GET", "POST"])
@csrf_protect
@sensitive_post_parameters("password")
def settings_page(request):
    if not can_maintain(request):
        raise PermissionDenied
    error = ""
    binding = EmailBindingForm()
    smtp = SmtpForm()
    if request.method == "POST":
        action = request.POST.get("action")
        try:
            if action == "email":
                binding = EmailBindingForm(request.POST)
                if not binding.is_valid():
                    raise ValueError("请填写已有内部账号和有效邮箱。")
                bind_email(**binding.cleaned_data)
            elif action == "smtp":
                smtp = SmtpForm(request.POST)
                if not smtp.is_valid():
                    raise ValueError("请填写完整有效的 SMTP 配置。")
                login_mail.configure(smtp.cleaned_data)
            else:
                raise ValueError("不支持的设置操作。")
            messages.success(request, "设置已保存；账号权限和已有业务数据保持不变。")
            return redirect("enterprise-login-security")
        except Exception:
            error = "设置未保存，请核对账号、邮箱与 SMTP 配置，或本机密钥存储权限。"
            smtp = SmtpForm()  # Never echo a submitted SMTP password, even on errors.
    return render(request, "enterprise_portal/login_security.html", {"binding": binding, "smtp": smtp,
        "smtp_configured": login_mail.configured(), "error": error,
        "accounts": get_user_model().objects.exclude(password__startswith="!").order_by("username").only("username", "email", "is_active")})
