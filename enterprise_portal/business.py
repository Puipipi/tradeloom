"""Fixed, read-only projections of this enterprise database; no external clients."""
from decimal import Decimal
import re

from django.contrib.auth.decorators import login_required
from django.core.exceptions import PermissionDenied
from django.db.models import F, OuterRef, Subquery
from django.http import JsonResponse
from django.shortcuts import render
from django.views.decorators.http import require_GET
from django.views.decorators.cache import never_cache
from workbench.customers.service import normalize_party_text, CustomerError

from workbench.models import Customer, CustomerEvent, IntakeMappingRevision, Product, Task
from .policy import capability_policy

LIMIT = 100
COLUMNS = {
    "products": [("sku", "SKU"), ("name", "商品名称"), ("category", "分类"), ("material", "材料"), ("size", "尺寸"), ("color", "颜色"), ("task__title", "批次")],
    "customers": [("display_name", "客户名称"), ("created_at", "创建时间"), ("updated_at", "更新时间")],
    "quotations": [("customer_name", "客户"), ("occurred_on", "报价记录日期"), ("unit_price", "来源单价数值"), ("amount", "来源金额"), ("currency", "来源币种")],
}
TITLES = {"products": "服务端批次与商品资料", "customers": "服务端客户名录", "quotations": "来源报价记录数值"}
CAPS = {"products": "business_data", "customers": "customer_data", "quotations": "quotation_data"}


def single_value(values, value_type):
    if not isinstance(values, list) or len(values) != 1:
        return None
    item = values[0]
    if not isinstance(item, dict) or set(item) != {"state", "type", "value"} or item["state"] != "present" or item["type"] != value_type or not isinstance(item["value"], str):
        return None
    value = item["value"]
    if value_type == "decimal":
        if not re.fullmatch(r"-?(?:0|[1-9]\d{0,17})(?:\.\d{1,8})?", value):
            return None
        return format(Decimal(value), "f")
    return value if re.fullmatch(r"[A-Z]{3}", value) else None


def quotation_rows():
    latest = IntakeMappingRevision.objects.filter(
        snapshot_id=OuterRef("source_candidate__mapping_revision__snapshot_id"), candidate_type="commercial_source"
    ).order_by("-revision").values("revision")[:1]
    source = CustomerEvent.objects.filter(
        event_type="quotation", customer__merged_into__isnull=True, alias__decision="confirmed",
        alias__customer_id=F("customer_id"), source_candidate__candidate_type="commercial_source",
        source_candidate__schema_version=1, source_candidate__mapping_revision__schema_version=1,
        source_candidate__mapping_revision__candidate_type="commercial_source",
        source_candidate__mapping_revision__snapshot__status="ready",
        source_candidate__source_sha256=F("source_candidate__mapping_revision__source_sha256"),
        source_candidate__source_sha256__regex=r"^[a-f0-9]{64}$",
        source_candidate__mapping_revision__revision=Subquery(latest),
        payload=F("source_candidate__typed_payload"), payload__schema_version=1, payload__candidate_type="commercial_source",
    ).filter(source_candidate__source_sha256=F("source_candidate__mapping_revision__snapshot__source__sha256")
    ).order_by("-occurred_on", "-id").values("id", "occurred_on", customer_name=F("customer__display_name"),
        price_values=F("payload__fields__unit_price"), amount_values=F("payload__fields__amount"), currency_values=F("payload__fields__currency"),
        party_values=F("payload__fields__party_text"), alias_norm=F("alias__normalized_text"))[:LIMIT]
    rows = []
    for row in source:
        party = row["party_values"]
        if not isinstance(party, list) or len(party) != 1 or not isinstance(party[0], dict) or set(party[0]) != {"state", "type", "value"} or party[0].get("state") != "present" or party[0].get("type") != "text":
            continue
        try:
            if normalize_party_text(party[0].get("value"))[1] != row["alias_norm"]:
                continue
        except CustomerError:
            continue
        price = single_value(row["price_values"], "decimal")
        amount = single_value(row["amount_values"], "decimal")
        currency = single_value(row["currency_values"], "text")
        if not currency or (price is None and amount is None):
            continue
        if (row["price_values"] is not None and price is None) or (row["amount_values"] is not None and amount is None):
            continue
        rows.append({"id": row["id"], "customer_name": row["customer_name"], "occurred_on": row["occurred_on"],
                     "unit_price": price, "amount": amount, "currency": currency})
    return rows


@login_required
@require_GET
@never_cache
def read(request, kind):
    caps = capability_policy(request.user)
    if not caps[CAPS[kind]]:
        raise PermissionDenied
    if request.GET:
        return JsonResponse({"detail": "此入口只接受固定只读查询。"}, status=400)
    if kind == "products":
        rows = list(Product.objects.order_by("-updated_at", "id").values("id", *[key for key, _ in COLUMNS[kind]])[:LIMIT])
        batches = list(Task.objects.order_by("-created_at", "id").values("id", "title", "mode", "status", "created_at")[:LIMIT])
    elif kind == "customers":
        rows = list(Customer.objects.filter(merged_into__isnull=True).order_by("display_name", "id").values("id", *[key for key, _ in COLUMNS[kind]])[:LIMIT])
        batches = []
    else:
        rows, batches = quotation_rows(), []
    return render(request, "enterprise_portal/business.html", {"title": TITLES[kind], "kind": kind, "caps": caps,
        "columns": [label for _, label in COLUMNS[kind]], "rows": [[row.get(key) for key, _ in COLUMNS[kind]] for row in rows],
        "batches": batches, "limit": LIMIT})
