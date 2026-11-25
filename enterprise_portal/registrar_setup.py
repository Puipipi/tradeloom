"""Small-company setup; no arbitrary group, privilege or existing-record edits."""
import logging
from django import forms
from django.contrib import messages
from django.contrib.auth import get_user_model
from django.contrib.auth.decorators import login_required
from django.contrib.auth.forms import UserCreationForm
from django.contrib.auth.models import Group
from django.core.exceptions import PermissionDenied, ValidationError
from django.db import IntegrityError, transaction
from django.shortcuts import redirect, render
from django.views.decorators.csrf import csrf_protect
from django.views.decorators.debug import sensitive_post_parameters
from django.views.decorators.http import require_http_methods

from .policy import is_enterprise_owner

REGISTRAR = "工厂登记员"
REGISTRAR_GRANTS = {"enterprise_portal.view_enterpriseentry", "enterprise_portal.add_enterpriseentry"}
audit = logging.getLogger("tradeloom.operations.audit")


def can_manage_registrars(user):
    return bool(user.is_authenticated and user.is_active and user.is_superuser and is_enterprise_owner(user))


def grants(group):
    return {f"{app}.{code}" for app, code in group.permissions.values_list("content_type__app_label", "codename")}


def registrar_group():
    group = Group.objects.filter(name=REGISTRAR).first()
    if group is None or grants(group) != REGISTRAR_GRANTS:
        raise ValidationError("登记员固定组权限与标准读取/新增权限不一致，请在原管理后台核对；此入口不会重写它。")
    return group


def manageable_target(user, actor):
    if user.pk == actor.pk or user.is_staff or user.is_superuser or user.user_permissions.exists():
        return False
    groups = list(user.groups.all())
    return any(g.name == REGISTRAR for g in groups) and all(
        grants(g) == REGISTRAR_GRANTS if g.name == REGISTRAR
        else g.name.startswith("工厂:") and not g.permissions.exists() for g in groups)


def factory_choices():
    return Group.objects.filter(name__startswith="工厂:", permissions__isnull=True).distinct().order_by("name")


class FactoryForm(forms.Form):
    factory_name = forms.CharField(label="工厂名称", max_length=80)

    def clean_factory_name(self):
        name = self.cleaned_data["factory_name"].strip()
        if name.startswith("工厂:"):
            name = name[3:].strip()
        if not name or any(not (char.isalnum() or char in " _-.") for char in name):
            raise ValidationError("请输入工厂简称，只使用文字、数字、空格、下划线、点或短横线。")
        name = "工厂:" + name
        if Group.objects.filter(name=name).exists():
            raise ValidationError("该工厂组已存在，请选择已有组，不会覆盖原组。")
        return name


class RegistrarCreateForm(UserCreationForm):
    factory_groups = forms.ModelMultipleChoiceField(queryset=Group.objects.none(), label="所属工厂", required=True,
        widget=forms.CheckboxSelectMultiple(attrs={"class": "factory-choices"}))

    class Meta(UserCreationForm.Meta):
        model = get_user_model()
        fields = ("username",)

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self.fields["factory_groups"].queryset = factory_choices()


class RegistrarUpdateForm(forms.Form):
    factory_groups = forms.ModelMultipleChoiceField(queryset=Group.objects.none(), label="所属工厂", required=False,
        widget=forms.CheckboxSelectMultiple(attrs={"class": "factory-choices"}))
    is_active = forms.BooleanField(label="允许登录", required=False)

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self.fields["factory_groups"].queryset = factory_choices()


def checked_factories(selected):
    groups = list(Group.objects.select_for_update().filter(pk__in=[g.pk for g in selected]))
    if len(groups) != len(selected) or any(not g.name.startswith("工厂:") or g.permissions.exists() for g in groups):
        raise ValidationError("工厂组已变化或带有额外权限，请在管理后台核对。")
    return groups


@login_required
@require_http_methods(["GET", "POST"])
@csrf_protect
@sensitive_post_parameters("password1", "password2")
def setup(request):
    if not can_manage_registrars(request.user):
        raise PermissionDenied
    factory_form = FactoryForm(auto_id="factory_%s")
    create_form = RegistrarCreateForm(auto_id="create_%s")
    bound_update = None
    target_id = None
    if request.method == "POST":
        action = request.POST.get("action")
        allowed = {
            "factory": {"factory_name"},
            "create": {"username", "password1", "password2", "factory_groups"},
            "update": {"user_id", "factory_groups", "is_active"},
        }
        if action not in allowed or set(request.POST) - allowed[action] - {"action", "csrfmiddlewaretoken"}:
            return render(request, "enterprise_portal/setup_error.html", status=400)
        if action == "factory":
            form = factory_form = FactoryForm(request.POST, auto_id="factory_%s")
        elif action == "create":
            form = create_form = RegistrarCreateForm(request.POST, auto_id="create_%s")
        else:
            target_id = request.POST.get("user_id", "")
            form = bound_update = RegistrarUpdateForm(request.POST, auto_id="edit_%s")
        if form.is_valid():
            try:
                with transaction.atomic():
                    actor = get_user_model().objects.select_for_update().get(pk=request.user.pk)
                    if not can_manage_registrars(actor):
                        raise PermissionDenied
                    if action == "factory":
                        target_pk = Group.objects.create(name=form.cleaned_data["factory_name"]).pk
                    else:
                        role = registrar_group()
                        factories = checked_factories(form.cleaned_data["factory_groups"])
                        if action == "create":
                            user = form.save()
                        else:
                            try:
                                user = get_user_model().objects.select_for_update().get(pk=target_id)
                            except (ValueError, get_user_model().DoesNotExist):
                                raise ValidationError("请选择可由此入口管理的登记员。")
                            if not manageable_target(user, actor):
                                raise ValidationError("此账号含其他角色、授权或管理身份，请使用原管理后台；未修改账号。")
                            user.is_active = form.cleaned_data["is_active"]
                            user.save(update_fields=["is_active"])
                        user.groups.set([role, *factories])
                        target_pk = user.pk
                audit.info("registrar_setup actor_id=%s target_id=%s action=%s", request.user.pk, target_pk, action)
                messages.success(request, "设置已保存；既有登记记录的工厂归属保持不变。")
                return redirect("enterprise-registrar-setup")
            except ValidationError as exc:
                form.add_error(None, exc)
            except IntegrityError:
                form.add_error(None, "用户名或工厂组已存在或刚被更新，未覆盖已有设置。")
    rows = []
    for user in get_user_model().objects.filter(groups__name=REGISTRAR, is_staff=False, is_superuser=False).distinct().prefetch_related("groups").order_by("username"):
        if manageable_target(user, request.user):
            edit = bound_update if str(user.pk) == target_id else RegistrarUpdateForm(
                initial={"factory_groups": list(user.groups.filter(name__startswith="工厂:").values_list("pk", flat=True)), "is_active": user.is_active}, auto_id=f"edit_{user.pk}_%s")
            rows.append({"user": user, "form": edit})
    return render(request, "enterprise_portal/registrar_setup.html", {
        "factory_form": factory_form, "create_form": create_form, "registrars": rows,
        "unlisted_update_form": bound_update if bound_update is not None and not any(str(row["user"].pk) == target_id for row in rows) else None,
    })
