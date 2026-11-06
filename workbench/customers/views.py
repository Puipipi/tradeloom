from __future__ import annotations

from datetime import date, timedelta

from django.db.models import Max, Q
from django.http import Http404
from django.shortcuts import redirect, render
from django.utils import timezone
from django.views.decorators.csrf import ensure_csrf_cookie

from workbench.business_urls import public_url
from workbench.models import (
    Customer,
    CustomerAction,
    CustomerAlias,
    CustomerEvent,
    CustomerMerge,
    CustomerPrediction,
    IntakeCandidate,
)
from workbench.views import _page_context

from .service import (
    CustomerError,
    analyze_customer,
    customer_family_ids,
    resolve_customer,
)


EVENT_LABELS = {
    CustomerEvent.Kind.INQUIRY: "询盘",
    CustomerEvent.Kind.QUOTATION: "报价",
    CustomerEvent.Kind.ORDER: "下单",
    CustomerEvent.Kind.ISSUE: "异常",
    CustomerEvent.Kind.REPLY: "回复",
}
PREDICTION_LABELS = {
    CustomerPrediction.Result.INSUFFICIENT_DATA: "数据不足",
    CustomerPrediction.Result.NOT_RECOMMENDED: "暂不建议",
    CustomerPrediction.Result.RECOMMENDED: "建议跟进",
}
OUTCOME_LABELS = {
    CustomerPrediction.Outcome.PENDING: "等待观察",
    CustomerPrediction.Outcome.ORDER_PLACED: "观察期内下单",
    CustomerPrediction.Outcome.NO_ORDER: "观察期内未下单",
}
ACTION_LABELS = {
    CustomerAction.Status.SUGGESTED: "待处理",
    CustomerAction.Status.ACCEPTED: "已采纳",
    CustomerAction.Status.COMPLETED: "已完成",
    CustomerAction.Status.DISMISSED: "已放弃",
}


def _event_source_summary(event: CustomerEvent) -> str:
    refs = event.source_refs if isinstance(event.source_refs, dict) else {}
    provenance = refs.get("provenance") if isinstance(refs.get("provenance"), dict) else {}
    locators = provenance.get("party_text")
    locator = locators[0] if isinstance(locators, list) and locators else {}
    sheet = locator.get("sheet_index") if isinstance(locator, dict) else None
    coordinate = locator.get("coordinate") if isinstance(locator, dict) else None
    snapshot_id = refs.get("snapshot_id", "")
    location = f"工作表 {sheet} · {coordinate}" if sheet and coordinate else "来源位置待补"
    return f"{location} · 快照 {str(snapshot_id)[:8]}"


def _candidate_value(candidate: IntakeCandidate, field: str) -> str:
    fields = candidate.typed_payload.get("fields") if isinstance(candidate.typed_payload, dict) else {}
    values = fields.get(field) if isinstance(fields, dict) else None
    if not isinstance(values, list):
        return ""
    for item in values:
        if isinstance(item, dict) and item.get("state") == "present" and isinstance(item.get("value"), str):
            return item["value"].strip()
    return ""


def _commercial_candidates() -> list[IntakeCandidate]:
    rows = []
    candidates = IntakeCandidate.objects.filter(candidate_type="commercial_source").order_by(
        "-created_at", "-id"
    )[:50]
    for candidate in candidates:
        party_text = _candidate_value(candidate, "party_text")
        if not party_text:
            continue
        candidate.party_text = party_text
        candidate.document_reference = _candidate_value(candidate, "document_reference") or "无单据号"
        candidate.event_count = candidate.customer_events.count()
        rows.append(candidate)
        if len(rows) >= 20:
            break
    return rows


@ensure_csrf_cookie
def customer_list(request):
    query = request.GET.get("q", "").strip()
    customers = Customer.objects.filter(merged_into__isnull=True)
    if query:
        customers = customers.filter(
            Q(display_name__icontains=query) | Q(aliases__raw_text__icontains=query)
        ).distinct()
    customers = list(customers[:100])
    for customer in customers:
        family_ids = customer_family_ids(customer)
        customer.event_count = CustomerEvent.objects.filter(customer_id__in=family_ids).count()
        customer.open_action_count = CustomerAction.objects.filter(
            customer_id__in=family_ids,
            status__in=["suggested", "accepted"],
        ).count()
        customer.last_order_on = CustomerEvent.objects.filter(
            customer_id__in=family_ids,
            event_type=CustomerEvent.Kind.ORDER,
        ).aggregate(value=Max("occurred_on"))["value"]
    pending_aliases = CustomerAlias.objects.filter(
        decision=CustomerAlias.Decision.SUGGESTED
    ).select_related("source_candidate").order_by("created_at", "id")[:50]
    return render(
        request,
        "workbench/customers.html",
        _page_context(
            "customers",
            customers=customers,
            pending_aliases=pending_aliases,
            pending_alias_total=CustomerAlias.objects.filter(
                decision=CustomerAlias.Decision.SUGGESTED
            ).count(),
            commercial_candidates=_commercial_candidates(),
            customer_options=Customer.objects.filter(merged_into__isnull=True),
            filters={"q": query},
            customer_total=Customer.objects.filter(merged_into__isnull=True).count(),
            open_action_total=CustomerAction.objects.filter(
                status__in=["suggested", "accepted"]
            ).count(),
            event_type_choices=CustomerEvent.Kind.choices,
            event_labels=EVENT_LABELS,
            today=timezone.localdate().isoformat(),
        ),
    )


@ensure_csrf_cookie
def customer_detail(request, customer_id: str):
    try:
        customer = resolve_customer(customer_id)
    except CustomerError as exc:
        raise Http404("客户不存在") from exc
    if customer.pk != customer_id:
        query = request.GET.urlencode()
        target = public_url(f"/customers/{customer.pk}")
        return redirect(f"{target}?{query}" if query else target)
    family_ids = customer_family_ids(customer)
    date_error = ""
    raw_as_of = request.GET.get("as_of", "")
    if raw_as_of:
        try:
            as_of = date.fromisoformat(raw_as_of)
        except ValueError:
            as_of = timezone.localdate()
            date_error = "评估日期无效，已改用今天。"
    else:
        as_of = timezone.localdate()
    analysis = analyze_customer(customer_id, as_of)
    max_monthly = max((row["event_count"] for row in analysis["monthly_activity"]), default=0)
    for row in analysis["monthly_activity"]:
        row["bar_height"] = round(row["event_count"] * 100 / max_monthly) if max_monthly else 0
    event_breakdown = [
        {"key": kind, "label": EVENT_LABELS[kind], "count": analysis["event_counts"][kind]}
        for kind in CustomerEvent.Kind.values
    ]
    events = list(CustomerEvent.objects.filter(customer_id__in=family_ids).order_by(
        "-occurred_on", "-created_at", "-id"
    )[:50])
    for event in events:
        event.type_label = EVENT_LABELS[event.event_type]
        event.source_summary = _event_source_summary(event)
    predictions = list(CustomerPrediction.objects.filter(customer_id__in=family_ids).order_by(
        "-predicted_on", "-created_at", "id"
    )[:30])
    for prediction in predictions:
        prediction.result_label = PREDICTION_LABELS[prediction.result]
        prediction.outcome_label = OUTCOME_LABELS[prediction.outcome]
    actions = list(CustomerAction.objects.filter(customer_id__in=family_ids).select_related(
        "prediction"
    ).order_by("-created_at", "id")[:30])
    for action in actions:
        action.status_label = ACTION_LABELS[action.status]
        action.can_accept = action.status == CustomerAction.Status.SUGGESTED
        action.can_complete = action.status == CustomerAction.Status.ACCEPTED
        action.can_dismiss = action.status in {
            CustomerAction.Status.SUGGESTED,
            CustomerAction.Status.ACCEPTED,
        }
    return render(
        request,
        "workbench/customer_detail.html",
        _page_context(
            "customers",
            customer=customer,
            analysis=analysis,
            event_breakdown=event_breakdown,
            events=events,
            predictions=predictions,
            actions=actions,
            aliases=CustomerAlias.objects.filter(customer_id__in=family_ids),
            customer_options=Customer.objects.filter(merged_into__isnull=True).exclude(pk=customer.pk),
            merge_history=CustomerMerge.objects.filter(target_customer=customer),
            merged_sources=customer.merged_sources.all(),
            as_of=as_of.isoformat(),
            date_error=date_error,
            backtest_start=(as_of - timedelta(days=180)).isoformat(),
            outcome_labels=OUTCOME_LABELS,
        ),
    )
