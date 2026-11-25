"""Owner-scoped access to sources shared with the existing desktop intake data layer."""

import re
from pathlib import PureWindowsPath

from django.contrib.auth.decorators import login_required
from django.core.exceptions import PermissionDenied, ValidationError
from django.core.paginator import Paginator
from django.db import DatabaseError, transaction
from django.http import FileResponse, HttpResponseBadRequest
from django.shortcuts import get_object_or_404, redirect, render
from django.views.decorators.cache import never_cache
from django.views.decorators.csrf import csrf_protect
from django.views.decorators.http import require_GET, require_http_methods

from workbench.intake.limits import MAX_SOURCE_BYTES
from workbench.intake.storage import cleanup_unreferenced_source, open_source, store_source, verify_source_root

from .email_login import is_verified_enterprise_session
from .models import WorkbookImport
from .policy import can_view_business_workflows

COLUMNS = tuple("ABCDEFGHIJKL")
ROWS = range(1, 21)
UNAVAILABLE = "私有工作簿存储不可用，请联系企业服务器管理员。"
INVALID = "无法导入。请选择 20 MB 以内且可解析的 .xlsx 工作簿。"


def own_imports(request):
    if not is_verified_enterprise_session(request) or not can_view_business_workflows(request.user):
        raise PermissionDenied
    return WorkbookImport.objects.filter(owner=request.user)


def register_upload(owner, upload):
    from workbench.intake.snapshots import capture_snapshot

    display_name = PureWindowsPath(upload.name).name
    if not display_name.lower().endswith(".xlsx") or any(ord(char) < 32 for char in display_name):
        raise ValidationError(INVALID)
    upload.name = display_name
    storage_key = None
    try:
        with transaction.atomic():
            source, created = store_source(upload)
            if created:
                storage_key = source.storage_key
            else:
                # Deduplication never grants access to absent or altered bytes.
                with open_source(source.pk):
                    pass
            snapshot, _ = capture_snapshot(source)
            if snapshot.status != "ready":
                raise ValidationError(INVALID)
            record, _ = WorkbookImport.objects.get_or_create(
                owner=owner, source=source,
                defaults={"display_name": display_name},
            )
    except Exception:
        if storage_key:
            cleanup_unreferenced_source(storage_key)
        raise
    return record


@login_required
@require_http_methods(["GET", "POST"])
@csrf_protect
@never_cache
def workbook_list(request):
    imports = own_imports(request)
    error, status = None, 200
    try:
        verify_source_root()
    except ValidationError:
        ready = False
        error = UNAVAILABLE
        if request.method == "POST":
            status = 503
    else:
        ready = True
        if request.method == "POST":
            files = request.FILES.getlist("workbook")
            if (len(files) != 1 or set(request.FILES) != {"workbook"}
                    or not 0 < files[0].size <= MAX_SOURCE_BYTES):
                error, status = INVALID, 400
            else:
                try:
                    record = register_upload(request.user, files[0])
                except ValidationError:
                    error, status = INVALID, 400
                except (DatabaseError, ImportError, OSError):
                    error, status = UNAVAILABLE, 503
                else:
                    return redirect("enterprise-workbook-detail", import_id=record.pk)
    page = Paginator(imports.order_by("-created_at", "id"), 25).get_page(request.GET.get("page"))
    return render(request, "enterprise_portal/workbooks.html", {
        "page": page, "storage_ready": ready, "error": error,
    }, status=status)


def cell_label(value, formula_status):
    if formula_status != "not_formula":
        return "公式"
    if isinstance(value, dict):
        value = value.get("iso") if value.get("type") in {"date", "datetime", "time"} else None
    if value is None:
        return ""
    text = str(value)
    return text if len(text) <= 120 else text[:120] + "…"


@login_required
@require_GET
@never_cache
def workbook_detail(request, import_id):
    record = get_object_or_404(own_imports(request), pk=import_id)
    if set(request.GET) - {"sheet"} or len(request.GET.getlist("sheet")) > 1:
        return HttpResponseBadRequest("工作表参数无效。")
    sheet_index = request.GET.get("sheet", "1")
    if not re.fullmatch(r"[1-9][0-9]?", sheet_index):
        return HttpResponseBadRequest("工作表参数无效。")
    try:
        with open_source(record.source_id):
            pass
    except (ValidationError, OSError):
        return render(request, "enterprise_portal/workbooks.html", {"record": record, "error": UNAVAILABLE}, status=503)
    snapshot = record.source.snapshots.filter(status="ready").first()
    if snapshot is None:
        return render(request, "enterprise_portal/workbooks.html", {
            "record": record, "error": "工作簿预览不可用。",
        }, status=503)
    sheets = list(snapshot.sheets.values("sheet_index", "title"))
    sheet = get_object_or_404(snapshot.sheets, sheet_index=int(sheet_index))
    coordinates = [[f"{column}{row}" for column in COLUMNS] for row in ROWS]
    labels = {
        name: cell_label(value, formula)
        for name, value, formula in sheet.cells.filter(coordinate__in=[
            name for row in coordinates for name in row
        ]).values_list("coordinate", "normalized_value", "formula_status")
    }
    rows = [[labels.get(name, "") for name in row] for row in coordinates]
    return render(request, "enterprise_portal/workbooks.html", {
        "record": record, "sheets": sheets, "sheet": sheet, "rows": rows, "columns": COLUMNS,
    })


@login_required
@require_GET
@never_cache
def workbook_download(request, import_id):
    record = get_object_or_404(own_imports(request), pk=import_id)
    try:
        stream = open_source(record.source_id)
    except (ValidationError, OSError):
        return render(request, "enterprise_portal/workbooks.html", {"record": record, "error": UNAVAILABLE}, status=503)
    response = FileResponse(stream, as_attachment=True, filename=record.display_name,
                            content_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")
    response["X-Content-Type-Options"] = "nosniff"
    return response
