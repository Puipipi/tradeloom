from __future__ import annotations

from django.http import HttpRequest, JsonResponse
from django.views.decorators.http import require_GET
from urllib.parse import quote
from django.db.models import Q

from .materials.rules import material_check
from .models import (
    IntakeCandidate, IntakeCandidateLink, ProductionRequirementDraft,
    ProductionRequirementRevision, PurchasePlan, ShipmentPayment, StockReceipt,
)
from .erpnext.api import _client_from_settings
from .erpnext.client import ErpNextError


MAX_ORDER_REFERENCE = 140


def _field_value(candidate: IntakeCandidate, field: str):
    payload = candidate.typed_payload
    fields = payload.get("fields") if isinstance(payload, dict) else None
    values = fields.get(field) if isinstance(fields, dict) else None
    if not isinstance(values, list) or len(values) != 1 or not isinstance(values[0], dict):
        return None
    item = values[0]
    return item.get("value") if item.get("state") == "present" else None


def _state(records, *, is_confirmed=lambda row: row.get("status") == "confirmed"):
    values = list(records)
    status = "missing" if not values else "confirmed" if all(is_confirmed(row) for row in values) else "needs_confirmation"
    return {"status": status, "records": values}


def _candidate_payload(candidate, relation):
    if relation == IntakeCandidateLink.Decision.SUGGESTED:
        review_status = "needs_confirmation"
    elif relation == IntakeCandidateLink.Decision.CONFIRMED:
        review_status = "confirmed"
    else:
        review_status = "needs_confirmation" if candidate.status != "confirmed" else "confirmed"
    return {
        "id": candidate.pk,
        "candidate_type": candidate.candidate_type,
        "created_at": candidate.created_at.isoformat(),
        "relation": relation,
        "review_status": review_status,
    }


def _erpnext_exact_records(order_key):
    supported = ["Item", "Customer", "Supplier", "Warehouse", "Bin", "Sales Order", "Purchase Order"]
    unsupported = ["Work Order", "Delivery Note", "Payment Entry"]
    try:
        client = _client_from_settings()
    except ErpNextError as exc:
        return {"status": "invalid_configuration", "error_code": exc.code,
                "supported_doctypes": supported, "unsupported_doctypes": unsupported, "records": []}
    if client is None:
        return {"status": "not_configured", "error_code": "",
                "supported_doctypes": supported, "unsupported_doctypes": unsupported, "records": []}
    records = []
    try:
        # The source order reference can identify a Sales Order by its exact
        # primary name. A same-named Purchase Order is not evidence that it is
        # linked to that Sales Order, so this reader never links it by name alone.
        for doctype, route in (("Sales Order", "sales-order"),):
            try:
                record = client.get_record(doctype, order_key)
            except ErpNextError as exc:
                if exc.code == "not_found":
                    continue
                raise
            external_ref = record.external_ref
            if (record.doctype != doctype or record.data.get("name") != order_key
                    or not isinstance(external_ref, dict)
                    or external_ref.get("doctype") != doctype or external_ref.get("name") != order_key):
                continue
            records.append({
                "doctype": doctype, "name": order_key,
                "external_ref": external_ref,
                "url": f"{client.site_url}/app/{route}/{quote(order_key, safe='')}",
            })
    except ErpNextError as exc:
        return {"status": "unavailable", "error_code": exc.code,
                "supported_doctypes": supported, "unsupported_doctypes": unsupported, "records": []}
    return {"status": "matched" if records else "no_exact_record", "error_code": "",
            "supported_doctypes": supported, "unsupported_doctypes": unsupported, "records": records}


@require_GET
def order_followup(request: HttpRequest) -> JsonResponse:
    if set(request.GET.keys()) != {"order_key"} or len(request.GET.getlist("order_key")) != 1:
        return JsonResponse({"ok": False, "error_code": "invalid_arguments"}, status=422)
    order_key = request.GET.get("order_key", "")
    if not order_key or len(order_key) > MAX_ORDER_REFERENCE or order_key != order_key.strip():
        return JsonResponse({"ok": False, "error_code": "invalid_arguments"}, status=422)

    commercial = list(IntakeCandidate.objects.filter(
        candidate_type="commercial_source",
        typed_payload__fields__document_reference__0__state="present",
        typed_payload__fields__document_reference__0__value=order_key,
    ).select_related("mapping_revision__snapshot"))
    instructions = list(IntakeCandidate.objects.filter(
        candidate_type="production_instruction",
        typed_payload__fields__source_order_reference__0__state="present",
        typed_payload__fields__source_order_reference__0__value=order_key,
    ).select_related("mapping_revision__snapshot"))
    seed_ids = {candidate.pk for candidate in [*commercial, *instructions]}
    relations = {candidate.pk: "exact_match" for candidate in [*commercial, *instructions]}

    # Existing manual candidate links are the only way to bring in records whose
    # own order reference differs. Suggested links stay visibly pending; rejected
    # links never add a record to this read view.
    link_rows = list(IntakeCandidateLink.objects.filter(
        Q(left_candidate_id__in=seed_ids) | Q(right_candidate_id__in=seed_ids)
    ).select_related("left_candidate", "right_candidate").order_by("created_at", "id")) if seed_ids else []
    latest_links = {}
    for link in link_rows:
        pair = tuple(sorted((link.left_candidate_id, link.right_candidate_id)))
        latest_links.setdefault(pair, []).append(link)
    # Expand one explicit edge from the exact-reference seeds. Do not follow
    # transitive links into unrelated orders.
    for link_versions in latest_links.values():
        latest_created_at = max(link.created_at for link in link_versions)
        current = [link for link in link_versions if link.created_at == latest_created_at]
        decisions = {link.decision for link in current}
        if IntakeCandidateLink.Decision.REJECTED in decisions:
            continue
        decision = (IntakeCandidateLink.Decision.CONFIRMED
                    if IntakeCandidateLink.Decision.CONFIRMED in decisions
                    else IntakeCandidateLink.Decision.SUGGESTED)
        link = current[-1]
        linked_id = None
        if link.left_candidate_id in seed_ids:
            linked_id = link.right_candidate_id
        elif link.right_candidate_id in seed_ids:
            linked_id = link.left_candidate_id
        if linked_id is None or linked_id in seed_ids:
            continue
        if relations.get(linked_id) != IntakeCandidateLink.Decision.CONFIRMED:
            relations[linked_id] = decision
    candidates = list(IntakeCandidate.objects.filter(pk__in=relations).order_by("created_at", "id"))
    candidate_ids = [candidate.pk for candidate in candidates]
    inquiries = [{
        "candidate_id": candidate.pk,
        "relation": relations[candidate.pk],
        "review_status": _candidate_payload(candidate, relations[candidate.pk])["review_status"],
        "document_reference": _field_value(candidate, "document_reference"),
        "party": _field_value(candidate, "party_text"),
        "item_description": _field_value(candidate, "item_description"),
        "quantity": _field_value(candidate, "quantity"),
        "unit": _field_value(candidate, "unit"),
        "unit_price": _field_value(candidate, "unit_price"),
        "currency": _field_value(candidate, "currency"),
    } for candidate in candidates if candidate.candidate_type == "commercial_source"]
    drafts = list(ProductionRequirementDraft.objects.filter(source_candidate_id__in=candidate_ids).order_by("created_at", "id"))
    revisions = []
    for draft in drafts:
        revision = ProductionRequirementRevision.objects.filter(draft=draft, revision=draft.current_revision).first()
        if revision:
            revisions.append({
                "draft_id": draft.pk, "candidate_id": draft.source_candidate_id,
                "revision": revision.revision, "status": revision.status,
                "fields": revision.fields, "unresolved_fields": revision.unresolved_fields,
                "pmc_material_check": material_check(revision.fields),
            })
    draft_ids = [draft.pk for draft in drafts]
    plan_rows = list(PurchasePlan.objects.filter(
        requirement_draft_id__in=draft_ids
    ).order_by("created_at", "id"))
    plan_rows += list(PurchasePlan.objects.filter(
        source_candidate_id__in=candidate_ids
    ).exclude(pk__in=[row.pk for row in plan_rows]).order_by("created_at", "id"))
    plans = [{
        "id": row.pk, "candidate_id": row.source_candidate_id,
        "requirement_draft_id": row.requirement_draft_id,
        "material": row.material, "quantity": row.quantity, "unit": row.unit,
        "expected_on": row.expected_on.isoformat() if row.expected_on else None,
        "status": row.status,
    } for row in plan_rows]
    plan_ids = [row.pk for row in plan_rows]
    receipts_qs = StockReceipt.objects.filter(purchase_plan_id__in=plan_ids) | StockReceipt.objects.filter(source_candidate_id__in=candidate_ids)
    receipts = [{
        "id": row.pk, "candidate_id": row.source_candidate_id, "purchase_plan_id": row.purchase_plan_id,
        "material": row.material, "quantity": row.quantity, "unit": row.unit,
        "received_on": row.received_on.isoformat() if row.received_on else None,
        "status": row.status,
    } for row in receipts_qs.order_by("created_at", "id").distinct()]
    shipment_payments = [{
        "id": row.pk, "candidate_id": row.source_candidate_id, "kind": row.kind,
        "reference": row.reference, "amount": row.amount, "currency": row.currency,
        "occurred_on": row.occurred_on.isoformat() if row.occurred_on else None,
        "status": row.status,
    } for row in ShipmentPayment.objects.filter(source_candidate_id__in=candidate_ids).order_by("created_at", "id")]

    return JsonResponse({
        "ok": True,
        "order": {
            "schema_version": "order-followup.v1", "order_key": order_key,
            "match_status": "exact_match" if seed_ids else "missing",
            "candidates": [_candidate_payload(candidate, relations[candidate.pk]) for candidate in candidates],
            "inquiries": inquiries,
            "requirements": _state(revisions, is_confirmed=lambda row: row["status"] == "confirmed" and row["pmc_material_check"]["state"] == "passed"),
            "purchase_plans": _state(plans),
            "material_receipts": _state(receipts),
            "production_handoff": {"status": "missing", "records": []},
            "shipment_payments": _state(shipment_payments),
            "erpnext": _erpnext_exact_records(order_key),
        },
    })
