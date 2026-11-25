"""Read-only account and effective-access overview for enterprise owners."""
from django.contrib.auth import get_user_model
from django.contrib.auth.decorators import login_required
from django.contrib.auth.models import Group
from django.core.exceptions import PermissionDenied
from django.http import Http404
from django.shortcuts import render
from django.views.decorators.http import require_GET

from .policy import is_enterprise_owner, permission_rows, group_permission_projection
from .registrar_setup import can_manage_registrars


@login_required
@require_GET
def console(request):
    from .operations import can_use_server_operations
    if request.user.groups.filter(name="工厂登记员").exists():
        raise PermissionDenied
    owner = is_enterprise_owner(request.user)
    can_view_accounts = owner or (request.user.is_staff and request.user.has_perm("auth.view_user"))
    if not can_view_accounts and not can_use_server_operations(request.user):
        raise PermissionDenied
    if "group" in request.GET and not owner:
        raise PermissionDenied
    users = get_user_model().objects.prefetch_related("groups").order_by("username") if can_view_accounts else get_user_model().objects.none()
    selected = request.user
    selected_id = request.GET.get("user")
    if selected_id and can_view_accounts:
        try:
            selected = users.get(pk=int(selected_id))
        except (ValueError, get_user_model().DoesNotExist):
            raise Http404("账号不存在")
    groups = Group.objects.prefetch_related("user_set", "permissions__content_type").order_by("name") if owner else Group.objects.none()
    selected_group = groups.first() if owner else None
    if owner and "group" in request.GET:
        try:
            selected_group = groups.get(pk=int(request.GET["group"]))
        except (ValueError, Group.DoesNotExist):
            raise Http404("用户组不存在")
    sources = []
    if owner:
        sources = [{"name": group.name, "permissions": sorted(
            f"{p.content_type.app_label}.{p.codename}" for p in group.permissions.select_related("content_type").all())}
            for group in selected.groups.all()]
    return render(request, "enterprise_portal/console.html", {
        "can_manage_registrars": can_manage_registrars(request.user),
        "accounts": users,
        "can_view_accounts": can_view_accounts,
        "can_manage_credentials": owner,
        "selected_account": selected,
        "permission_rows": permission_rows(selected) if can_view_accounts else [],
        "account_groups": groups,
        "can_view_groups": owner,
        "group_projection": group_permission_projection(selected_group) if selected_group else None,
        "permission_sources": sources,
        "direct_permissions": sorted(f"{p.content_type.app_label}.{p.codename}"
            for p in selected.user_permissions.select_related("content_type").all()) if owner else [],
    })
