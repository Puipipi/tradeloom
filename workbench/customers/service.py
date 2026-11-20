from __future__ import annotations

import hashlib
import json
import statistics
import unicodedata
from datetime import date, timedelta
from decimal import Decimal

from django.db import IntegrityError, transaction
from django.utils import timezone

from workbench.models import (
    Customer,
    CustomerAction,
    CustomerAlias,
    CustomerAliasDecision,
    CustomerEvent,
    CustomerMerge,
    CustomerMetricSnapshot,
    CustomerPrediction,
    IntakeCandidate,
)


FOLLOWUP_RULE_ID = "customer_silence_followup"
FOLLOWUP_RULE_VERSION = "v1"
FOLLOWUP_MIN_ORDER_COUNT = 3
FOLLOWUP_THRESHOLD_MULTIPLIER = Decimal("1.5")

METRIC_DEFINITIONS = {
    CustomerMetricSnapshot.Kind.ORDER_INTERVAL_MEDIAN_DAYS: {
        "version": "v1",
        "unit": "days",
        "formula": "median(diff(order.occurred_on))",
    },
    CustomerMetricSnapshot.Kind.SILENCE_DAYS: {
        "version": "v1",
        "unit": "days",
        "formula": "as_of - max(order.occurred_on)",
    },
}


class CustomerError(ValueError):
    def __init__(self, code: str, status: int = 422):
        self.code = code
        self.status = status
        super().__init__(code)


def resolve_customer(value: Customer | str) -> Customer:
    customer = Customer.objects.filter(pk=value).first() if isinstance(value, str) else value
    if customer is None:
        raise CustomerError("customer_not_found", 404)
    seen = set()
    while customer.merged_into_id is not None:
        if customer.pk in seen:
            raise CustomerError("customer_merge_cycle", 409)
        seen.add(customer.pk)
        customer = customer.merged_into
    return customer


def customer_family_ids(value: Customer | str) -> list[str]:
    canonical = resolve_customer(value)
    family = [canonical]
    seen = {canonical.pk}
    index = 0
    while index < len(family):
        for child in family[index].merged_sources.all():
            if child.pk in seen:
                raise CustomerError("customer_merge_cycle", 409)
            seen.add(child.pk)
            family.append(child)
        index += 1
    return [customer.pk for customer in family]


def _validate_identity_note(note: object) -> str:
    if not isinstance(note, str) or len(note) > 500:
        raise CustomerError("invalid_identity_note")
    return note.strip()


def _record_alias_decision(
    alias: CustomerAlias,
    decision: str,
    *,
    from_customer: Customer | None,
    to_customer: Customer | None,
    note: str = "",
) -> None:
    CustomerAliasDecision.objects.create(
        alias=alias,
        from_customer=from_customer,
        to_customer=to_customer,
        decision=decision,
        note=note,
    )


def _hash(value: object) -> str:
    serialized = json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(serialized.encode("utf-8")).hexdigest()


def _decimal_text(value: Decimal | None) -> str | None:
    return str(value) if value is not None else None


def _days_text(value: Decimal) -> str:
    return format(value.normalize(), "f")


def normalize_party_text(value: object) -> tuple[str, str]:
    if not isinstance(value, str) or not value.strip() or len(value) > 200:
        raise CustomerError("invalid_party_text")
    raw = value.strip()
    normalized = " ".join(unicodedata.normalize("NFKC", raw).casefold().split())
    if not normalized or len(normalized) > 200:
        raise CustomerError("invalid_party_text")
    return raw, normalized


def _candidate_party_text(candidate: IntakeCandidate) -> str:
    if candidate.candidate_type != "commercial_source":
        raise CustomerError("unsupported_customer_candidate")
    fields = candidate.typed_payload.get("fields")
    values = fields.get("party_text") if isinstance(fields, dict) else None
    if not isinstance(values, list) or len(values) != 1 or not isinstance(values[0], dict):
        raise CustomerError("invalid_party_text")
    item = values[0]
    if item.get("state") != "present":
        raise CustomerError("invalid_party_text")
    raw, _ = normalize_party_text(item.get("value"))
    return raw


def alias_payload(alias: CustomerAlias) -> dict:
    return {
        "id": alias.pk,
        "customer_id": alias.customer_id,
        "source_candidate_id": alias.source_candidate_id,
        "raw_text": alias.raw_text,
        "normalized_text": alias.normalized_text,
        "decision": alias.decision,
        "created_at": alias.created_at.isoformat(),
        "updated_at": alias.updated_at.isoformat(),
    }


def event_payload(event: CustomerEvent) -> dict:
    return {
        "id": event.pk,
        "customer_id": event.customer_id,
        "alias_id": event.alias_id,
        "source_candidate_id": event.source_candidate_id,
        "event_type": event.event_type,
        "occurred_on": event.occurred_on.isoformat(),
        "payload": event.payload,
        "source_refs": event.source_refs,
        "created_at": event.created_at.isoformat(),
    }


def metric_payload(metric: CustomerMetricSnapshot) -> dict:
    definition = METRIC_DEFINITIONS[metric.metric_key]
    return {
        "id": metric.pk,
        "customer_id": metric.customer_id,
        "metric_key": metric.metric_key,
        "metric_version": metric.metric_version,
        "as_of": metric.as_of.isoformat(),
        "window_start": metric.window_start.isoformat(),
        "window_end": metric.window_end.isoformat(),
        "value": _decimal_text(metric.value),
        "unit": metric.unit,
        "formula": definition["formula"],
        "coverage": metric.coverage,
        "input_event_ids": metric.input_event_ids,
        "inputs_hash": metric.inputs_hash,
        "created_at": metric.created_at.isoformat(),
    }


def prediction_payload(prediction: CustomerPrediction) -> dict:
    return {
        "id": prediction.pk,
        "customer_id": prediction.customer_id,
        "prediction_type": prediction.prediction_type,
        "predicted_on": prediction.predicted_on.isoformat(),
        "horizon_days": prediction.horizon_days,
        "result": prediction.result,
        "rule_id": prediction.rule_id,
        "rule_version": prediction.rule_version,
        "input_snapshot": prediction.input_snapshot,
        "inputs_hash": prediction.inputs_hash,
        "outcome": prediction.outcome,
        "resolved_at": prediction.resolved_at.isoformat() if prediction.resolved_at else None,
        "created_at": prediction.created_at.isoformat(),
    }


def action_payload(action: CustomerAction) -> dict:
    return {
        "id": action.pk,
        "customer_id": action.customer_id,
        "prediction_id": action.prediction_id,
        "action_type": action.action_type,
        "suggestion": action.suggestion,
        "due_on": action.due_on.isoformat() if action.due_on else None,
        "status": action.status,
        "note": action.note,
        "decided_at": action.decided_at.isoformat() if action.decided_at else None,
        "created_at": action.created_at.isoformat(),
        "updated_at": action.updated_at.isoformat(),
    }


def customer_payload(customer: Customer) -> dict:
    return {
        "id": customer.pk,
        "display_name": customer.display_name,
        "merged_into_id": customer.merged_into_id,
        "merged_at": customer.merged_at.isoformat() if customer.merged_at else None,
        "created_at": customer.created_at.isoformat(),
        "updated_at": customer.updated_at.isoformat(),
    }


def merge_payload(merge: CustomerMerge) -> dict:
    return {
        "id": merge.pk,
        "source_customer_id": merge.source_customer_id,
        "target_customer_id": merge.target_customer_id,
        "note": merge.note,
        "created_at": merge.created_at.isoformat(),
    }


def customer_detail_payload(customer: Customer) -> dict:
    customer = resolve_customer(customer)
    family_ids = customer_family_ids(customer)
    return {
        **customer_payload(customer),
        "customer_family_ids": family_ids,
        "aliases": [alias_payload(row) for row in CustomerAlias.objects.filter(customer_id__in=family_ids)[:100]],
        "events": [event_payload(row) for row in CustomerEvent.objects.filter(customer_id__in=family_ids)[:100]],
        "metric_snapshots": [
            metric_payload(row)
            for row in CustomerMetricSnapshot.objects.filter(customer_id__in=family_ids)[:100]
        ],
        "predictions": [
            prediction_payload(row)
            for row in CustomerPrediction.objects.filter(customer_id__in=family_ids)[:100]
        ],
        "actions": [action_payload(row) for row in CustomerAction.objects.filter(customer_id__in=family_ids)[:100]],
    }


def resolve_party_alias(candidate: IntakeCandidate) -> CustomerAlias:
    raw = _candidate_party_text(candidate)
    _, normalized = normalize_party_text(raw)
    alias, _ = CustomerAlias.objects.get_or_create(
        normalized_text=normalized,
        defaults={"raw_text": raw, "source_candidate": candidate},
    )
    return alias


def record_event_from_candidate(
    candidate_id: str, event_type: str, occurred_on: date
) -> tuple[CustomerEvent | None, CustomerAlias, bool]:
    if event_type not in CustomerEvent.Kind.values or type(occurred_on) is not date:
        raise CustomerError("invalid_customer_event")
    candidate = (
        IntakeCandidate.objects.select_related("mapping_revision__snapshot")
        .filter(pk=candidate_id)
        .first()
    )
    if candidate is None:
        raise CustomerError("candidate_not_found", 404)
    _candidate_party_text(candidate)
    dedupe_key = _hash({"candidate_id": candidate.pk, "event_type": event_type})
    existing = CustomerEvent.objects.filter(dedupe_key=dedupe_key).first()
    if existing is not None:
        if existing.occurred_on != occurred_on:
            raise CustomerError("idempotency_conflict", 409)
        return existing, existing.alias, False

    alias = resolve_party_alias(candidate)
    if alias.decision == CustomerAlias.Decision.REJECTED:
        raise CustomerError("party_rejected", 409)
    if alias.decision != CustomerAlias.Decision.CONFIRMED or alias.customer_id is None:
        return None, alias, False

    source_refs = {
        "candidate_id": candidate.pk,
        "snapshot_id": candidate.mapping_revision.snapshot_id,
        "source_sha256": candidate.source_sha256,
        "provenance": candidate.provenance,
        "event_type_source": "operator_classification",
        "occurred_on_source": "operator_supplement",
    }
    try:
        with transaction.atomic():
            event = CustomerEvent.objects.create(
                customer_id=resolve_customer(alias.customer_id).pk,
                alias=alias,
                source_candidate=candidate,
                event_type=event_type,
                occurred_on=occurred_on,
                payload=candidate.typed_payload,
                source_refs=source_refs,
                dedupe_key=dedupe_key,
            )
    except IntegrityError:
        event = CustomerEvent.objects.filter(dedupe_key=dedupe_key).first()
        if event is None:
            raise
        if event.occurred_on != occurred_on:
            raise CustomerError("idempotency_conflict", 409) from None
        return event, alias, False
    return event, alias, True


def decide_alias(
    alias_id: str,
    decision: str,
    *,
    customer_id: str | None = None,
    display_name: str | None = None,
) -> CustomerAlias:
    if decision not in {"confirm", "reject"}:
        raise CustomerError("invalid_alias_decision")
    with transaction.atomic():
        alias = CustomerAlias.objects.select_for_update().filter(pk=alias_id).first()
        if alias is None:
            raise CustomerError("alias_not_found", 404)
        if alias.decision == CustomerAlias.Decision.CONFIRMED:
            same_customer = (
                customer_id is not None
                and alias.customer_id == resolve_customer(customer_id).pk
            )
            same_name = (
                display_name is not None
                and alias.customer is not None
                and alias.customer.display_name == display_name.strip()
            )
            if decision == "confirm" and (same_customer or same_name):
                return alias
            raise CustomerError("alias_already_confirmed", 409)
        if decision == "reject":
            if alias.decision == CustomerAlias.Decision.SUGGESTED:
                previous_customer = alias.customer
                alias.decision = CustomerAlias.Decision.REJECTED
                alias.save(update_fields=["decision", "updated_at"])
                _record_alias_decision(
                    alias,
                    CustomerAliasDecision.Kind.REJECTED,
                    from_customer=previous_customer,
                    to_customer=None,
                )
            return alias

        if (customer_id is None) == (display_name is None):
            raise CustomerError("invalid_alias_decision")
        if customer_id is not None:
            customer = resolve_customer(customer_id)
        else:
            if not isinstance(display_name, str) or not display_name.strip() or len(display_name.strip()) > 200:
                raise CustomerError("invalid_alias_decision")
            customer = Customer.objects.create(display_name=display_name.strip())
        previous_customer = alias.customer
        alias.customer = customer
        alias.decision = CustomerAlias.Decision.CONFIRMED
        alias.save(update_fields=["customer", "decision", "updated_at"])
        _record_alias_decision(
            alias,
            CustomerAliasDecision.Kind.CONFIRMED,
            from_customer=previous_customer,
            to_customer=customer,
        )
        return alias


def reassign_alias(alias_id: str, customer_id: str, note: str = "") -> CustomerAlias:
    note = _validate_identity_note(note)
    target = resolve_customer(customer_id)
    with transaction.atomic():
        alias = CustomerAlias.objects.select_for_update().filter(pk=alias_id).first()
        if alias is None:
            raise CustomerError("alias_not_found", 404)
        if alias.decision != CustomerAlias.Decision.CONFIRMED:
            raise CustomerError("alias_not_confirmed", 409)
        if alias.customer_id == target.pk:
            return alias
        previous = alias.customer
        alias.customer = target
        alias.save(update_fields=["customer", "updated_at"])
        _record_alias_decision(
            alias,
            CustomerAliasDecision.Kind.REASSIGNED,
            from_customer=previous,
            to_customer=target,
            note=note,
        )
        return alias


def merge_customers(source_customer_id: str, target_customer_id: str, note: str = "") -> CustomerMerge:
    note = _validate_identity_note(note)
    target = resolve_customer(target_customer_id)
    source = Customer.objects.filter(pk=source_customer_id).first()
    if source is None:
        raise CustomerError("customer_not_found", 404)
    if source.merged_into_id is not None:
        if resolve_customer(source).pk == target.pk:
            merge = CustomerMerge.objects.filter(source_customer=source).first()
            if merge is not None:
                return merge
        raise CustomerError("customer_already_merged", 409)
    if source.pk == target.pk:
        raise CustomerError("invalid_customer_merge")
    with transaction.atomic():
        locked = {
            row.pk: row
            for row in Customer.objects.select_for_update().filter(pk__in=[source.pk, target.pk]).order_by("id")
        }
        source = locked[source.pk]
        target = locked[target.pk]
        if source.merged_into_id is not None or target.merged_into_id is not None:
            raise CustomerError("customer_already_merged", 409)
        merge = CustomerMerge.objects.create(
            source_customer=source,
            target_customer=target,
            note=note,
        )
        for alias in source.aliases.all():
            alias.customer = target
            alias.save(update_fields=["customer", "updated_at"])
            _record_alias_decision(
                alias,
                CustomerAliasDecision.Kind.MERGED,
                from_customer=source,
                to_customer=target,
                note=note,
            )
        source.merged_into = target
        source.merged_at = timezone.now()
        source.save(update_fields=["merged_into", "merged_at", "updated_at"])
        return merge


def _store_metric(
    customer: Customer,
    metric_key: str,
    as_of: date,
    window_start: date,
    value: Decimal | None,
    coverage: dict,
    input_event_ids: list[str],
) -> CustomerMetricSnapshot:
    definition = METRIC_DEFINITIONS[metric_key]
    inputs_hash = _hash({
        "customer_id": customer.pk,
        "metric_key": metric_key,
        "metric_version": definition["version"],
        "as_of": as_of.isoformat(),
        "window_start": window_start.isoformat(),
        "input_event_ids": input_event_ids,
    })
    metric, _ = CustomerMetricSnapshot.objects.get_or_create(
        customer=customer,
        metric_key=metric_key,
        metric_version=definition["version"],
        as_of=as_of,
        inputs_hash=inputs_hash,
        defaults={
            "window_start": window_start,
            "window_end": as_of,
            "value": value,
            "unit": definition["unit"],
            "coverage": coverage,
            "input_event_ids": input_event_ids,
        },
    )
    return metric


def _order_facts(orders: list[CustomerEvent], as_of: date) -> dict:
    intervals = [
        (current.occurred_on - previous.occurred_on).days
        for previous, current in zip(orders, orders[1:])
    ]
    return {
        "order_count": len(orders),
        "order_ids": [row.pk for row in orders],
        "window_start": orders[0].occurred_on if orders else as_of,
        "intervals": intervals,
        "interval_value": Decimal(str(statistics.median(intervals))) if intervals else None,
        "silence_value": Decimal((as_of - orders[-1].occurred_on).days) if orders else None,
        "last_order_event_id": orders[-1].pk if orders else None,
    }


def _followup_result(
    order_count: int,
    interval_value: Decimal | None,
    silence_value: Decimal | None,
) -> tuple[str, Decimal | None]:
    if (
        order_count < FOLLOWUP_MIN_ORDER_COUNT
        or interval_value is None
        or silence_value is None
    ):
        return CustomerPrediction.Result.INSUFFICIENT_DATA, None
    threshold = (interval_value * FOLLOWUP_THRESHOLD_MULTIPLIER).quantize(Decimal("0.000001"))
    result = (
        CustomerPrediction.Result.RECOMMENDED
        if silence_value > threshold
        else CustomerPrediction.Result.NOT_RECOMMENDED
    )
    return result, threshold


def compute_customer_metrics(customer_id: str, as_of: date) -> dict[str, CustomerMetricSnapshot]:
    if type(as_of) is not date:
        raise CustomerError("invalid_metric_date")
    customer = resolve_customer(customer_id)
    family_ids = customer_family_ids(customer)
    events = list(CustomerEvent.objects.filter(
        customer_id__in=family_ids,
        occurred_on__lte=as_of,
    ).order_by("occurred_on", "created_at", "id"))
    orders = [row for row in events if row.event_type == CustomerEvent.Kind.ORDER]
    facts = _order_facts(orders, as_of)
    interval = _store_metric(
        customer,
        CustomerMetricSnapshot.Kind.ORDER_INTERVAL_MEDIAN_DAYS,
        as_of,
        facts["window_start"],
        facts["interval_value"],
        {
            "order_count": facts["order_count"],
            "interval_count": len(facts["intervals"]),
            "sufficient": bool(facts["intervals"]),
        },
        facts["order_ids"],
    )
    silence = _store_metric(
        customer,
        CustomerMetricSnapshot.Kind.SILENCE_DAYS,
        as_of,
        facts["window_start"],
        facts["silence_value"],
        {
            "order_count": facts["order_count"],
            "last_order_event_id": facts["last_order_event_id"],
        },
        facts["order_ids"],
    )
    return {
        CustomerMetricSnapshot.Kind.ORDER_INTERVAL_MEDIAN_DAYS: interval,
        CustomerMetricSnapshot.Kind.SILENCE_DAYS: silence,
    }


def evaluate_silence_followup(customer_id: str, as_of: date):
    metrics = compute_customer_metrics(customer_id, as_of)
    interval = metrics[CustomerMetricSnapshot.Kind.ORDER_INTERVAL_MEDIAN_DAYS]
    silence = metrics[CustomerMetricSnapshot.Kind.SILENCE_DAYS]
    order_count = silence.coverage.get("order_count", 0)
    result, threshold = _followup_result(order_count, interval.value, silence.value)
    input_snapshot = {
        "metrics": {
            key: {
                "snapshot_id": metric.pk,
                "value": _decimal_text(metric.value),
                "coverage": metric.coverage,
                "input_event_ids": metric.input_event_ids,
            }
            for key, metric in metrics.items()
        },
        "rule": {
            "minimum_order_count": FOLLOWUP_MIN_ORDER_COUNT,
            "threshold_multiplier": str(FOLLOWUP_THRESHOLD_MULTIPLIER),
            "threshold_days": _decimal_text(threshold),
            "comparison": "silence_days > order_interval_median_days * threshold_multiplier",
        },
    }
    inputs_hash = _hash({
        "customer_id": customer_id,
        "predicted_on": as_of.isoformat(),
        "rule_id": FOLLOWUP_RULE_ID,
        "rule_version": FOLLOWUP_RULE_VERSION,
        "metric_snapshot_ids": {key: metric.pk for key, metric in metrics.items()},
    })
    prediction, _ = CustomerPrediction.objects.get_or_create(
        customer_id=customer_id,
        prediction_type=CustomerPrediction.Kind.SILENCE_FOLLOWUP,
        rule_version=FOLLOWUP_RULE_VERSION,
        predicted_on=as_of,
        inputs_hash=inputs_hash,
        defaults={
            "horizon_days": 30,
            "result": result,
            "rule_id": FOLLOWUP_RULE_ID,
            "input_snapshot": input_snapshot,
        },
    )
    action = None
    if result == CustomerPrediction.Result.RECOMMENDED:
        suggestion = (
            f"建议跟进：已沉默 {_days_text(silence.value)} 天，"
            f"历史下单间隔中位数 {_days_text(interval.value)} 天，覆盖 {order_count} 笔订单。"
        )
        action, _ = CustomerAction.objects.get_or_create(
            prediction=prediction,
            action_type=CustomerAction.Kind.FOLLOW_UP,
            defaults={
                "customer_id": customer_id,
                "suggestion": suggestion,
                "due_on": as_of + timedelta(days=7),
            },
        )
    return list(metrics.values()), prediction, action


def decide_action(action_id: str, decision: str, note: str = "") -> CustomerAction:
    targets = {
        "accept": CustomerAction.Status.ACCEPTED,
        "complete": CustomerAction.Status.COMPLETED,
        "dismiss": CustomerAction.Status.DISMISSED,
    }
    target = targets.get(decision)
    if target is None or not isinstance(note, str) or len(note) > 1000:
        raise CustomerError("invalid_action_decision")
    allowed = {
        CustomerAction.Status.ACCEPTED: {CustomerAction.Status.SUGGESTED},
        CustomerAction.Status.COMPLETED: {CustomerAction.Status.ACCEPTED},
        CustomerAction.Status.DISMISSED: {
            CustomerAction.Status.SUGGESTED,
            CustomerAction.Status.ACCEPTED,
        },
    }
    with transaction.atomic():
        action = CustomerAction.objects.select_for_update().filter(pk=action_id).first()
        if action is None:
            raise CustomerError("action_not_found", 404)
        if action.status == target:
            if note and note != action.note:
                raise CustomerError("idempotency_conflict", 409)
            return action
        if action.status not in allowed[target]:
            raise CustomerError("invalid_action_transition", 409)
        action.status = target
        action.note = note
        action.decided_at = timezone.now()
        action.save(update_fields=["status", "note", "decided_at", "updated_at"])
        return action


def _month_shift(month: date, offset: int) -> date:
    value = month.year * 12 + month.month - 1 + offset
    return date(value // 12, value % 12 + 1, 1)


def analyze_customer(customer_id: str, as_of: date) -> dict:
    if type(as_of) is not date:
        raise CustomerError("invalid_analysis_date")
    customer = resolve_customer(customer_id)
    family_ids = customer_family_ids(customer)
    events = list(CustomerEvent.objects.filter(
        customer_id__in=family_ids,
        occurred_on__lte=as_of,
    ).order_by("occurred_on", "created_at", "id"))
    orders = [row for row in events if row.event_type == CustomerEvent.Kind.ORDER]
    facts = _order_facts(orders, as_of)
    event_counts = {kind: 0 for kind in CustomerEvent.Kind.values}
    monthly = {}
    document_reference_count = 0
    supplemented_date_count = 0
    snapshot_ids = set()
    for event in events:
        event_counts[event.event_type] += 1
        month = event.occurred_on.replace(day=1)
        bucket = monthly.setdefault(month, {
            "month": month.strftime("%Y-%m"),
            "event_count": 0,
            "order_count": 0,
            "quotation_count": 0,
            "inquiry_count": 0,
        })
        bucket["event_count"] += 1
        if event.event_type == CustomerEvent.Kind.ORDER:
            bucket["order_count"] += 1
        elif event.event_type == CustomerEvent.Kind.QUOTATION:
            bucket["quotation_count"] += 1
        elif event.event_type == CustomerEvent.Kind.INQUIRY:
            bucket["inquiry_count"] += 1
        fields = event.payload.get("fields") if isinstance(event.payload, dict) else {}
        references = fields.get("document_reference") if isinstance(fields, dict) else None
        if any(
            isinstance(item, dict) and item.get("state") == "present" and item.get("value")
            for item in references or []
        ):
            document_reference_count += 1
        if event.source_refs.get("occurred_on_source") == "operator_supplement":
            supplemented_date_count += 1
        snapshot_id = event.source_refs.get("snapshot_id")
        if isinstance(snapshot_id, str) and snapshot_id:
            snapshot_ids.add(snapshot_id)
    this_month = as_of.replace(day=1)
    monthly_activity = [
        monthly.get(_month_shift(this_month, offset), {
            "month": _month_shift(this_month, offset).strftime("%Y-%m"),
            "event_count": 0,
            "order_count": 0,
            "quotation_count": 0,
            "inquiry_count": 0,
        })
        for offset in range(-11, 1)
    ]
    prediction_outcomes = {kind: 0 for kind in CustomerPrediction.Outcome.values}
    for outcome in CustomerPrediction.objects.filter(customer_id__in=family_ids).values_list("outcome", flat=True):
        prediction_outcomes[outcome] += 1
    action_statuses = {kind: 0 for kind in CustomerAction.Status.values}
    for status in CustomerAction.objects.filter(customer_id__in=family_ids).values_list("status", flat=True):
        action_statuses[status] += 1
    intervals = facts["intervals"]
    return {
        "customer_id": customer.pk,
        "as_of": as_of.isoformat(),
        "analysis_boundary": "descriptive_only",
        "activity": {
            "event_count": len(events),
            "order_count": len(orders),
            "first_event_on": events[0].occurred_on.isoformat() if events else None,
            "last_event_on": events[-1].occurred_on.isoformat() if events else None,
            "last_order_on": orders[-1].occurred_on.isoformat() if orders else None,
            "silence_days": _decimal_text(facts["silence_value"]),
        },
        "event_counts": event_counts,
        "monthly_activity": monthly_activity,
        "order_intervals": {
            "interval_count": len(intervals),
            "median_days": _decimal_text(facts["interval_value"]),
            "min_days": min(intervals) if intervals else None,
            "max_days": max(intervals) if intervals else None,
            "input_event_ids": facts["order_ids"],
        },
        "source_coverage": {
            "source_snapshot_count": len(snapshot_ids),
            "document_reference_event_count": document_reference_count,
            "document_reference_coverage": (
                _decimal_text(Decimal(document_reference_count) / Decimal(len(events)))
                if events else None
            ),
            "operator_supplemented_date_count": supplemented_date_count,
            "event_count": len(events),
        },
        "prediction_outcomes": prediction_outcomes,
        "action_statuses": action_statuses,
    }


def backtest_silence_followup(
    customer_id: str,
    start: date,
    end: date,
    step_days: int = 30,
) -> dict:
    if (
        type(start) is not date
        or type(end) is not date
        or start > end
        or type(step_days) is not int
        or not 1 <= step_days <= 366
        or (end - start).days // step_days + 2 > 100
    ):
        raise CustomerError("invalid_backtest_range")
    customer = resolve_customer(customer_id)
    family_ids = customer_family_ids(customer)
    events = list(CustomerEvent.objects.filter(customer_id__in=family_ids).order_by(
        "occurred_on", "created_at", "id"
    ))
    orders = [row for row in events if row.event_type == CustomerEvent.Kind.ORDER]
    observation_end = max((row.occurred_on for row in events), default=None)
    evaluation_dates = []
    cursor = start
    while cursor <= end:
        evaluation_dates.append(cursor)
        cursor += timedelta(days=step_days)
    if evaluation_dates[-1] != end:
        evaluation_dates.append(end)

    rows = []
    for as_of in evaluation_dates:
        input_orders = [row for row in orders if row.occurred_on <= as_of]
        facts = _order_facts(input_orders, as_of)
        result, threshold = _followup_result(
            facts["order_count"], facts["interval_value"], facts["silence_value"]
        )
        horizon_end = as_of + timedelta(days=30)
        next_order = next(
            (row for row in orders if as_of < row.occurred_on <= horizon_end),
            None,
        )
        if next_order is not None:
            outcome = CustomerPrediction.Outcome.ORDER_PLACED
        elif observation_end is not None and observation_end >= horizon_end:
            outcome = CustomerPrediction.Outcome.NO_ORDER
        else:
            outcome = "censored"
        rows.append({
            "as_of": as_of.isoformat(),
            "result": result,
            "order_count": facts["order_count"],
            "median_interval_days": _decimal_text(facts["interval_value"]),
            "silence_days": _decimal_text(facts["silence_value"]),
            "threshold_days": _decimal_text(threshold),
            "horizon_end": horizon_end.isoformat(),
            "outcome": outcome,
            "next_order_event_id": next_order.pk if next_order else None,
            "input_event_ids": facts["order_ids"],
        })
    recommended = [row for row in rows if row["result"] == CustomerPrediction.Result.RECOMMENDED]
    resolved = [row for row in recommended if row["outcome"] != "censored"]
    hits = [row for row in resolved if row["outcome"] == CustomerPrediction.Outcome.ORDER_PLACED]
    return {
        "customer_id": customer.pk,
        "rule_id": FOLLOWUP_RULE_ID,
        "rule_version": FOLLOWUP_RULE_VERSION,
        "horizon_days": 30,
        "analysis_boundary": "descriptive_backtest_not_causal",
        "rows": rows,
        "summary": {
            "evaluation_count": len(rows),
            "recommended_count": len(recommended),
            "resolved_recommendation_count": len(resolved),
            "order_placed_count": len(hits),
            "hit_rate": _decimal_text(Decimal(len(hits)) / Decimal(len(resolved))) if resolved else None,
            "censored_count": sum(row["outcome"] == "censored" for row in rows),
            "insufficient_data_count": sum(
                row["result"] == CustomerPrediction.Result.INSUFFICIENT_DATA for row in rows
            ),
        },
    }


def reconcile_prediction_outcomes(customer_id: str, as_of: date) -> dict:
    if type(as_of) is not date:
        raise CustomerError("invalid_reconciliation_date")
    customer = resolve_customer(customer_id)
    family_ids = customer_family_ids(customer)
    orders = list(CustomerEvent.objects.filter(
        customer_id__in=family_ids,
        event_type=CustomerEvent.Kind.ORDER,
        occurred_on__lte=as_of,
    ).order_by("occurred_on", "created_at", "id"))
    resolved = []
    with transaction.atomic():
        pending = CustomerPrediction.objects.select_for_update().filter(
            customer_id__in=family_ids,
            outcome=CustomerPrediction.Outcome.PENDING,
            prediction_type=CustomerPrediction.Kind.SILENCE_FOLLOWUP,
        ).order_by("predicted_on", "created_at", "id")
        for prediction in pending:
            horizon_end = prediction.predicted_on + timedelta(days=prediction.horizon_days)
            next_order = next(
                (
                    row for row in orders
                    if prediction.predicted_on < row.occurred_on <= horizon_end
                ),
                None,
            )
            if next_order is not None:
                outcome = CustomerPrediction.Outcome.ORDER_PLACED
            elif as_of >= horizon_end:
                outcome = CustomerPrediction.Outcome.NO_ORDER
            else:
                continue
            prediction.outcome = outcome
            prediction.resolved_at = timezone.now()
            prediction.save(update_fields=["outcome", "resolved_at", "updated_at"])
            resolved.append(prediction)
    return {
        "resolved_count": len(resolved),
        "pending_count": CustomerPrediction.objects.filter(
            customer_id__in=family_ids,
            outcome=CustomerPrediction.Outcome.PENDING,
        ).count(),
        "resolved_predictions": [prediction_payload(row) for row in resolved],
    }
