from __future__ import annotations

from datetime import date, timedelta

from django.db.models import Count, Max, Q
from django.http import Http404
from django.shortcuts import render
from django.utils import timezone
from django.views.decorators.csrf import ensure_csrf_cookie

from workbench.models import Customer, CustomerAction, CustomerAlias, CustomerEvent, CustomerPrediction
from workbench.views import _page_context

from .service import analyze_customer


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


@ensure_csrf_cookie
def customer_list(request):
    query = request.GET.get("q", "").strip()
    customers = Customer.objects.annotate(
        event_count=Count("events", distinct=True),
        open_action_count=Count(
            "actions",
            filter=Q(actions__status__in=["suggested", "accepted"]),
            distinct=True,
        ),
        last_order_on=Max(
            "events__occurred_on",
            filter=Q(events__event_type=CustomerEvent.Kind.ORDER),
        ),
    )
    if query:
        customers = customers.filter(
            Q(display_name__icontains=query) | Q(aliases__raw_text__icontains=query)
        ).distinct()
    customers = customers[:100]
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
            filters={"q": query},
            customer_total=Customer.objects.count(),
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
    customer = Customer.objects.filter(pk=customer_id).first()
    if customer is None:
        raise Http404("客户不存在")
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
    events = list(customer.events.order_by("-occurred_on", "-created_at", "-id")[:50])
    for event in events:
        event.type_label = EVENT_LABELS[event.event_type]
        event.source_summary = _event_source_summary(event)
    predictions = list(customer.predictions.all()[:30])
    for prediction in predictions:
        prediction.result_label = PREDICTION_LABELS[prediction.result]
        prediction.outcome_label = OUTCOME_LABELS[prediction.outcome]
    actions = list(customer.actions.select_related("prediction").all()[:30])
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
            aliases=customer.aliases.all(),
            as_of=as_of.isoformat(),
            date_error=date_error,
            backtest_start=(as_of - timedelta(days=180)).isoformat(),
            outcome_labels=OUTCOME_LABELS,
        ),
    )
