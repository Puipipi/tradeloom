from __future__ import annotations

from django.contrib.auth.decorators import login_required, permission_required
from django.contrib.auth.models import Group
from django.db import connection
from django.http import HttpRequest, HttpResponse, JsonResponse
from django.shortcuts import redirect, render
from django.views.decorators.csrf import csrf_protect
from django.views.decorators.http import require_GET, require_POST

from workbench.models import Product, Task

from .models import EnterpriseEntry
from .website_notice import current as current_website_notice


from .policy import capability_policy, is_enterprise_owner, policy_payload, visible_entries


def _can_view_all(user):
    return is_enterprise_owner(user)


def _visible_entries(user):
    return visible_entries(user)


@login_required
@require_GET
def capabilities(request):
    response = JsonResponse(policy_payload(request.user))
    response["Cache-Control"] = "no-store"
    return response


@require_GET
def health(request: HttpRequest) -> JsonResponse:
    with connection.cursor() as cursor:
        cursor.execute("SELECT 1")
        database_ok = cursor.fetchone()[0] == 1
    return JsonResponse({"status": "ok", "database": "postgresql", "database_ok": database_ok})


@login_required
@require_GET
def home(request: HttpRequest) -> HttpResponse:
    caps = capability_policy(request.user)
    can_view_business = caps["business_data"]
    tasks = Task.objects.all()[:20] if can_view_business else Task.objects.none()
    products = Product.objects.select_related("task")[:50] if can_view_business else Product.objects.none()
    entries = _visible_entries(request.user)
    can_add = caps["records_create"]
    groups = Group.objects.all() if caps["records_all_factories"] else request.user.groups.all()
    return render(request, "enterprise_portal/home.html", {
        "website_notice": current_website_notice(),
        "tasks": tasks,
        "products": products,
        "entries": entries[:100],
        "can_add": can_add,
        "can_view_business": can_view_business,
        "can_view_customers": caps["customer_data"],
        "can_view_quotations": caps["quotation_data"],
        "can_use_console": caps["server_ops"] or (
            not request.user.groups.filter(name="工厂登记员").exists()
            and request.user.is_staff and request.user.has_perm("auth.view_user")
        ),
        "factory_groups": groups.filter(name__startswith="工厂:"),
    })


@login_required
@require_GET
def records_api(request: HttpRequest) -> JsonResponse:
    caps = capability_policy(request.user)
    if not caps["records_read"]:
        return JsonResponse({"detail": "无权读取登记记录。"}, status=403)
    fields = ["id", "created_by__username", "factory_group__name", "body", "created_at"]
    if caps["business_data"]:
        fields.extend(["task_id", "task__title"])
    entries = _visible_entries(request.user).values(*fields)
    return JsonResponse({"results": list(entries[:100])})


@login_required
@permission_required("enterprise_portal.add_enterpriseentry", raise_exception=True)
@csrf_protect
@require_POST
def create_entry(request: HttpRequest) -> HttpResponse:
    body = request.POST.get("body", "").strip()
    if not body or len(body) > 500:
        return JsonResponse({"detail": "内容须为 1 至 500 个字符。"}, status=400)
    task_id = request.POST.get("task_id", "").strip()
    task = None
    if task_id and not capability_policy(request.user)["business_data"]:
        return JsonResponse({"detail": "无权关联业务批次。"}, status=403)
    if task_id:
        task = Task.objects.filter(pk=task_id).first()
        if task is None:
            return JsonResponse({"detail": "所选业务记录不存在。"}, status=404)
    group_id = request.POST.get("factory_group", "").strip()
    factory_group = None
    if group_id:
        allowed = Group.objects.filter(pk=group_id, name__startswith="工厂:")
        if not _can_view_all(request.user):
            allowed = allowed.filter(pk__in=request.user.groups.values("pk"))
        factory_group = allowed.first()
        if factory_group is None:
            return JsonResponse({"detail": "无权将记录分配到该工厂组。"}, status=403)
    EnterpriseEntry.objects.create(task=task, created_by=request.user, factory_group=factory_group, body=body)
    return redirect("enterprise-home")
