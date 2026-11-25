"""Mobile projection of the existing sourced product review cycles."""
from hashlib import sha256

from django.core import signing
from django.utils.crypto import get_random_string

from workbench.models import HumanReview, Product, ProductRevision, WorkflowStep
from workbench.workflow_views import FACT_FIELD_LABELS
from workbench.workflows.fact_application import REVISION_LITERAL_FIELDS
from workbench.workflows.review_images import ReviewImageConflict, is_missing_image_signal, validate_upload_credential
from workbench.workflows.validation import frozen_image_candidates_for_review

APPLY_SALT = "enterprise.english-name-review.v1"
FIELDS = {
    field: {
        "label": FACT_FIELD_LABELS[field],
        "limit": 200 if field == "english_name" else Product._meta.get_field(field).max_length,
    }
    for field in REVISION_LITERAL_FIELDS
}
REVIEW_STATUSES = {"pending": "待填写", "submitted": "已提交，待应用", "approved": "已应用"}


IMAGE_FIELD = "task_file_id"
UPLOAD_FIELD = "upload_step_id"
SKU_FIELD = "resolved_sku"
REVISION_FIELD = "confirmed"
UPLOAD_SALT = "enterprise.missing-image-upload.v1"
UNCERTAINTY_FIELDS = {
    "ambiguous_image_candidate": IMAGE_FIELD,
    "duplicate_sku": SKU_FIELD,
    "current_revision_not_confirmed": REVISION_FIELD,
}


def review_source(review, workflow_id, batch_id):
    metadata = review.source_conflict
    refs = metadata.get("source_refs") if isinstance(metadata, dict) else None
    signal = refs.get("signal") if isinstance(refs, dict) else None
    field = signal.get("missing_field") if isinstance(signal, dict) else None
    uncertainty = signal.get("uncertainty") if isinstance(signal, dict) else None
    if isinstance(uncertainty, str) and uncertainty in UNCERTAINTY_FIELDS:
        field = UNCERTAINTY_FIELDS[uncertainty]
    elif is_missing_image_signal(refs):
        field = UPLOAD_FIELD
    if (
        not isinstance(field, str) or (field not in FIELDS and field not in (IMAGE_FIELD, UPLOAD_FIELD, SKU_FIELD, REVISION_FIELD))
        or refs.get("workflow_task_id") != workflow_id or refs.get("batch_id") != batch_id
        or not metadata.get("origin_step_id") or not review.review_key
        or not isinstance(refs.get("revision_id"), str) or not refs["revision_id"]
    ):
        return None
    product_id = refs.get("product_id")
    return (product_id, field) if isinstance(product_id, str) and product_id else None


def review_answer(field, value):
    if field == IMAGE_FIELD:
        return {"type": "select_image_candidate", "task_file_id": value}
    if field == UPLOAD_FIELD:
        return {"type": "provide_image", UPLOAD_FIELD: value}
    if field == SKU_FIELD:
        return {"type": "resolve_duplicate_sku", "value": value}
    if field == REVISION_FIELD:
        return {"type": "confirm_current_revision", "revision_id": value}
    return {"type": "set_literal_field", "field": field, "value": value}


def review_revision_id(review):
    return review.source_conflict["source_refs"]["revision_id"]


def answer_value(review, field):
    response = review.answer.get("response") if isinstance(review.answer, dict) else None
    key = field if field in (IMAGE_FIELD, UPLOAD_FIELD) else "value"
    if field == REVISION_FIELD:
        key = "revision_id"
    value = response.get(key) if isinstance(response, dict) else None
    if isinstance(value, str) and value.strip() and response == review_answer(field, value):
        if field == REVISION_FIELD:
            return value if value == review_revision_id(review) else ""
        if field == SKU_FIELD:
            return value if len(value.strip()) <= FIELDS["sku"]["limit"] else ""
        if field in ("english_name", IMAGE_FIELD, UPLOAD_FIELD) or len(value) <= FIELDS[field]["limit"]:
            return value
    return ""


def upload_rows(review, can_submit, selected_id):
    uploads = WorkflowStep.objects.filter(
        task_id=review.task_id, step_key__startswith=f"review_image_upload:{review.pk}:", status="completed",
    )
    if not can_submit:
        uploads = uploads.filter(pk=selected_id)
    rows = []
    for step_id in uploads.order_by("created_at", "id").values_list("id", flat=True):
        try:
            _, task_file, _ = validate_upload_credential(review.task, review, step_id)
        except ReviewImageConflict:
            continue
        rows.append({"id": step_id, "name": task_file.original_name})
    return rows


def revision_display(review, batch_id, product_id):
    revision = ProductRevision.objects.filter(
        pk=review_revision_id(review), product_id=product_id, product__task_id=batch_id,
    ).values("version", "snapshot").first()
    if not revision or not isinstance(revision["snapshot"], dict):
        return None
    facts = []
    for field, label in FACT_FIELD_LABELS.items():
        value = revision["snapshot"].get(field)
        facts.append({"label": label, "value": value if isinstance(value, str) else ""})
    return {"version": revision["version"], "facts": facts}


def sku_group_display(review, batch_id):
    group = review.source_conflict["source_refs"].get("duplicate_sku_group")
    members = group.get("members") if isinstance(group, dict) else None
    if not isinstance(members, list) or len(members) < 2:
        return None
    pairs = [(member.get("product_id"), member.get("revision_id"))
             for member in members if isinstance(member, dict)]
    if len(pairs) != len(members) or any(
        not isinstance(product_id, str) or not isinstance(revision_id, str) for product_id, revision_id in pairs
    ):
        return None
    revisions = ProductRevision.objects.filter(
        product__task_id=batch_id, pk__in=[revision_id for _, revision_id in pairs],
    ).select_related("product").in_bulk()
    group_rows = []
    for product_id, revision_id in pairs:
        revision = revisions.get(revision_id)
        if revision is None or revision.product_id != product_id or not isinstance(revision.snapshot, dict):
            return None
        name = revision.snapshot.get("name")
        group_rows.append({
            "name": name if isinstance(name, str) else "",
            "position": revision.product.position + 1,
            "version": revision.version,
        })
    return {"sku": group.get("sku", ""), "members": group_rows}


def review_panel(user, workflow_id, batch_id, status):
    reviews = list(HumanReview.objects.filter(task_id=workflow_id, status__in=REVIEW_STATUSES)
                   .select_related("task").order_by("created_at", "id"))
    sources = {item.pk: review_source(item, workflow_id, batch_id) for item in reviews}
    products = Product.objects.filter(
        task_id=batch_id, pk__in={source[0] for source in sources.values() if source},
    ).in_bulk()
    rows = []
    unresolved = []
    submitted = []
    desktop_required = False
    for item in reviews:
        source = sources[item.pk]
        product = products.get(source[0]) if source else None
        if item.status != "approved":
            unresolved.append(item.pk)
        if product is None:
            desktop_required |= item.status != "approved"
            continue
        _, field = source
        value = answer_value(item, field)
        can_submit = status == "waiting_human" and item.status == "pending"
        row = {
            "id": item.pk, "name": product.name, "sku": product.sku,
            "status": REVIEW_STATUSES[item.status], "value": value, "field": field,
            "can_submit": can_submit,
        }
        if field == IMAGE_FIELD:
            row.update(label="选择商品图片", image_choice=True, value="")
            try:
                candidates = frozen_image_candidates_for_review(item.task, item)
            except ValueError:
                candidates = []
            row["candidates"] = [
                {"id": candidate["task_file_id"], "name": candidate["original_name"], "number": index}
                for index, candidate in enumerate(candidates, 1)
                if can_submit or candidate["task_file_id"] == value
            ]
            if not row["candidates"]:
                row.update(can_submit=False, unavailable=item.status != "approved")
                value = ""
                desktop_required |= item.status != "approved"
        elif field == UPLOAD_FIELD:
            uploads = upload_rows(item, can_submit, value)
            row.update(label="补充商品图片", image_upload=True, value="", uploads=uploads)
            if can_submit:
                row["upload_confirmation"] = signing.dumps({
                    "owner": str(user.pk), "workflow": workflow_id, "review": item.pk,
                    "key": get_random_string(32),
                }, salt=UPLOAD_SALT)
            if value and not uploads:
                row["unavailable"] = True
                value = ""
        elif field in (SKU_FIELD, REVISION_FIELD):
            if field == SKU_FIELD:
                details = sku_group_display(item, batch_id)
                row.update(label="重复 SKU 裁决", sku_group=details, limit=FIELDS["sku"]["limit"],
                           product_position=product.position + 1)
            else:
                details = revision_display(item, batch_id, product.pk)
                row.update(label="确认当前商品版本", revision=details, value="")
            if details is None:
                row["can_submit"] = False
                value = ""
                desktop_required |= item.status != "approved"
        else:
            row.update(FIELDS[field])
        rows.append(row)
        if item.status == "submitted":
            if value:
                submitted.append(item)
            else:
                desktop_required = True
    confirmation = None
    if status == "waiting_human" and submitted and len(unresolved) == len(submitted):
        origins = {item.source_conflict["origin_step_id"] for item in submitted}
        if len(origins) == 1:
            confirmation = signing.dumps({
                "owner": str(user.pk), "workflow": workflow_id, "reviews": sorted(unresolved),
            }, salt=APPLY_SALT)
        else:
            desktop_required = True
    if not rows and not desktop_required:
        return None
    return {
        "rows": rows, "confirmation": confirmation,
        "desktop_required": desktop_required,
    }


def can_apply_review(review, workflow_id, batch_id):
    source = review_source(review, workflow_id, batch_id)
    return source is not None and bool(answer_value(review, source[1]))


def apply_key(workflow_id, review_ids):
    return "enterprise:english-review:" + sha256(
        ":".join([workflow_id, *review_ids]).encode("utf-8")
    ).hexdigest()
