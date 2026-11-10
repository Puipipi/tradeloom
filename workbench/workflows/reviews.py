from __future__ import annotations

import hashlib
import json
from typing import Any

from django.db import transaction
from django.utils import timezone

from workbench.models import (
    HumanReview,
    Product,
    ProductRevision,
    SubTask,
    Task,
    WorkflowTask,
)

from .events import record_workflow_event
from .validation import (
    validate_image_selection_response,
    validate_current_review_source_refs,
    validate_duplicate_sku_review_source_refs,
)


class ReviewNotFound(LookupError):
    pass


class ReviewSubmissionConflict(ValueError):
    pass


class InvalidReviewSubmission(ValueError):
    pass


def _canonical_json(value: Any) -> str:
    try:
        return json.dumps(
            value,
            sort_keys=True,
            separators=(",", ":"),
            ensure_ascii=False,
            allow_nan=False,
        )
    except (TypeError, ValueError) as exc:
        raise InvalidReviewSubmission("answer 必须是标准 JSON 对象") from exc


def _request_fingerprint(review_key: str, answer: dict[str, Any], reviewer: str) -> str:
    material = _canonical_json(
        {"review_key": review_key, "answer": answer, "reviewer": reviewer}
    )
    return hashlib.sha256(material.encode("utf-8")).hexdigest()


def validate_saved_review_sources(
    workflow: WorkflowTask,
    review: HumanReview,
) -> dict[str, Any]:
    """Validate persisted provenance against the current workflow and batch facts.

    The caller owns locks for the WorkflowTask, batch Task, relevant Product rows,
    and HumanReview row, in that order. Revision and file rows are locked here.
    """
    metadata = review.source_conflict
    if not isinstance(metadata, dict):
        raise ReviewSubmissionConflict("审核来源元数据无效")
    subtask_id = metadata.get("subtask_id")
    result_ref = metadata.get("result_ref")
    if not isinstance(subtask_id, str) or not subtask_id:
        raise ReviewSubmissionConflict("无法证明审核事项属于当前子任务")
    expected_result_ref = f"subtask:{subtask_id}:output_refs.result"
    try:
        subtask = SubTask.objects.select_for_update().get(pk=subtask_id)
    except SubTask.DoesNotExist as exc:
        raise ReviewSubmissionConflict("审核来源子任务不存在") from exc
    if subtask.task_id != workflow.id or subtask.status != "waiting_human":
        raise ReviewSubmissionConflict("审核来源子任务不属于当前待确认工作流")
    output_refs = subtask.output_refs if isinstance(subtask.output_refs, dict) else {}
    result = output_refs.get("result")
    if not isinstance(result, dict) or result.get("status") != "needs_human":
        raise ReviewSubmissionConflict("保存的子任务结果无法证明此审核事项")
    if result.get("task_id") not in (None, workflow.id):
        raise ReviewSubmissionConflict("保存的审核结果引用了其他工作流")
    if result.get("batch_id") not in (None, workflow.batch_id):
        raise ReviewSubmissionConflict("保存的审核结果引用了其他批次")

    origin_step_id = metadata.get("origin_step_id")
    origin_result = None
    if origin_step_id is not None:
        if result_ref != f"workflow_step:{origin_step_id}:output_refs.result_snapshot":
            raise ReviewSubmissionConflict("审核结果引用无法验证")
        from workbench.models import WorkflowStep

        origin = WorkflowStep.objects.select_for_update().filter(
            pk=origin_step_id, task=workflow, step_key=f"subtask:{subtask_id}"
        ).first()
        latest = WorkflowStep.objects.filter(
            task=workflow, step_key=f"subtask:{subtask_id}"
        ).order_by("-attempt", "-created_at", "-id").first()
        if origin is None or origin.status != "completed" or latest is None or latest.id != origin.id:
            raise ReviewSubmissionConflict("审核事项不再绑定当前最新的来源步骤")
        snapshot = origin.output_refs.get("result_snapshot") if isinstance(origin.output_refs, dict) else None
        if (
            not isinstance(snapshot, dict)
            or snapshot.get("subtask_status") != "waiting_human"
            or not isinstance(snapshot.get("result"), dict)
            or snapshot["result"].get("status") != "needs_human"
            or snapshot["result"] != result
        ):
            raise ReviewSubmissionConflict("不可变来源步骤无法证明当前待确认结果")
        origin_result = snapshot["result"]
    elif result_ref != expected_result_ref:
        raise ReviewSubmissionConflict("审核结果引用无法验证")

    source_refs = metadata.get("source_refs")
    if not isinstance(source_refs, dict):
        raise ReviewSubmissionConflict("审核来源引用必须是对象")
    if (
        source_refs.get("workflow_task_id") != workflow.id
        or source_refs.get("batch_id") != workflow.batch_id
    ):
        raise ReviewSubmissionConflict("审核来源引用与当前工作流或批次不一致")

    product_id = source_refs.get("product_id")
    raw_product_ids = source_refs.get("product_ids", [])
    if not isinstance(raw_product_ids, list):
        raise ReviewSubmissionConflict("审核来源中的 product_ids 必须是 ID 列表")
    if product_id is not None:
        if not isinstance(product_id, str) or not product_id:
            raise ReviewSubmissionConflict("审核来源的 product_id 无效")
    try:
        validated_refs = validate_current_review_source_refs(workflow, source_refs)
        validate_duplicate_sku_review_source_refs(
            workflow,
            validated_refs,
            origin_result,
        )
        return validated_refs
    except ValueError as exc:
        raise ReviewSubmissionConflict(str(exc)) from exc


def _sku_editable_signal(review: HumanReview) -> bool:
    metadata = review.source_conflict if isinstance(review.source_conflict, dict) else {}
    refs = metadata.get("source_refs") if isinstance(metadata.get("source_refs"), dict) else {}
    signal = refs.get("signal") if isinstance(refs.get("signal"), dict) else {}
    return signal.get("uncertainty") == "duplicate_sku" or signal.get("missing_field") == "sku"


def _supported_sku_answer(review: HumanReview, response: Any) -> str | None:
    if not isinstance(response, dict):
        return None
    metadata = review.source_conflict if isinstance(review.source_conflict, dict) else {}
    refs = metadata.get("source_refs") if isinstance(metadata.get("source_refs"), dict) else {}
    signal = refs.get("signal") if isinstance(refs.get("signal"), dict) else {}
    value = response.get("value")
    if (
        response.get("type") == "resolve_duplicate_sku"
        and set(response) == {"type", "value"}
        and signal.get("uncertainty") == "duplicate_sku"
        and isinstance(value, str)
    ):
        return value.strip()
    if (
        response.get("type") == "set_literal_field"
        and set(response) == {"type", "field", "value"}
        and response.get("field") == "sku"
        and signal.get("missing_field") == "sku"
        and isinstance(value, str)
    ):
        return value.strip()
    return None


def _validate_sku_assignment_preflight(
    *,
    workflow: WorkflowTask,
    products: list[Product],
    reviews: list[HumanReview],
    review: HumanReview,
    response: dict[str, Any],
) -> None:
    if not isinstance(response, dict):
        return
    value = _supported_sku_answer(review, response)
    if value is None:
        if response.get("type") == "resolve_duplicate_sku":
            raise ReviewSubmissionConflict("重复 SKU 回答类型或来源信号无效")
        return
    if not value:
        raise ReviewSubmissionConflict("SKU 必须是非空字符串")
    max_length = Product._meta.get_field("sku").max_length
    # Legacy missing-SKU answers are persisted verbatim and apply the raw
    # literal, while duplicate-SKU answers are normalized before persistence.
    submitted_value = response.get("value")
    length_to_validate = (
        len(submitted_value)
        if response.get("type") == "set_literal_field"
        and isinstance(submitted_value, str)
        else len(value)
    )
    if length_to_validate > max_length:
        raise ReviewSubmissionConflict("SKU 超过现有产品字段长度限制")

    metadata = review.source_conflict if isinstance(review.source_conflict, dict) else {}
    origin_step_id = metadata.get("origin_step_id")
    product_by_id = {product.id: product for product in products}
    if not product_by_id:
        raise ReviewSubmissionConflict("当前批次没有产品")

    current_rows = list(
        ProductRevision.objects.select_for_update()
        .filter(product_id__in=sorted(product_by_id))
        .order_by("product_id", "version", "id")
    )
    current_revisions = {}
    for revision in current_rows:
        current_revisions[revision.product_id] = revision
    assigned = {}
    for product_id, product in product_by_id.items():
        revision = current_revisions.get(product_id)
        snapshot = revision.snapshot if revision and isinstance(revision.snapshot, dict) else {}
        sku = snapshot.get("sku", product.sku)
        if not isinstance(sku, str):
            raise ReviewSubmissionConflict("当前产品 SKU 来源无效")
        normalized = sku.strip()
        if normalized:
            assigned[product_id] = normalized

    cycle_reviews = [
        item
        for item in reviews
        if isinstance(item.source_conflict, dict)
        and item.source_conflict.get("origin_step_id") == origin_step_id
    ]
    pending_editable_product_ids = {
        item.source_conflict.get("source_refs", {}).get("product_id")
        for item in cycle_reviews
        if item.status == "pending"
        and _sku_editable_signal(item)
        and isinstance(item.source_conflict.get("source_refs"), dict)
    }
    for product_id in pending_editable_product_ids:
        assigned.pop(product_id, None)

    for item in cycle_reviews:
        if item.status != "submitted":
            continue
        envelope = item.answer if isinstance(item.answer, dict) else {}
        submitted_value = _supported_sku_answer(item, envelope.get("response"))
        refs = item.source_conflict.get("source_refs", {})
        product_id = refs.get("product_id") if isinstance(refs, dict) else None
        if submitted_value and product_id in product_by_id:
            assigned[product_id] = submitted_value

    refs = metadata.get("source_refs", {})
    product_id = refs.get("product_id") if isinstance(refs, dict) else None
    if product_id not in product_by_id:
        raise ReviewSubmissionConflict("审核来源产品不属于当前批次")
    assigned[product_id] = value

    seen: dict[str, str] = {}
    for assigned_product_id, sku in assigned.items():
        prior_product_id = seen.get(sku)
        if prior_product_id is not None and prior_product_id != assigned_product_id:
            raise ReviewSubmissionConflict("提交后 SKU 仍与本批其他产品重复")
        seen[sku] = assigned_product_id


def _submission_payload(review: HumanReview) -> dict[str, Any]:
    answer = review.answer if isinstance(review.answer, dict) else {}
    return {
        "id": review.id,
        "review_key": review.review_key,
        "status": "submitted" if review.status == "approved" else review.status,
        "answer": answer,
        "reviewer": review.reviewer,
        "created_at": review.created_at.isoformat(),
        "updated_at": review.updated_at.isoformat(),
    }


@transaction.atomic
def submit_review(
    *,
    workflow_id: str,
    review_id: str,
    review_key: str,
    answer: dict[str, Any],
    reviewer: str,
) -> dict[str, Any]:
    try:
        workflow = WorkflowTask.objects.select_for_update().get(pk=workflow_id)
    except WorkflowTask.DoesNotExist as exc:
        raise ReviewNotFound("未知工作流或审核事项") from exc

    try:
        preliminary_review = HumanReview.objects.get(pk=review_id, task=workflow)
    except HumanReview.DoesNotExist as exc:
        raise ReviewNotFound("未知工作流或审核事项") from exc
    if preliminary_review.review_key != review_key:
        raise ReviewSubmissionConflict("review_key 与待审核事项不匹配")
    fingerprint = _request_fingerprint(review_key, answer, reviewer)
    if preliminary_review.status in {"submitted", "approved"}:
        # A replay is a read of the immutable historical receipt. It deliberately
        # bypasses current-source validation so later fact changes cannot rewrite
        # or hide an already committed response.
        replay = HumanReview.objects.select_for_update().get(
            pk=review_id,
            task=workflow,
        )
        stored_answer = replay.answer if isinstance(replay.answer, dict) else {}
        if replay.status in {"submitted", "approved"} and stored_answer.get("request_fingerprint") == fingerprint:
            return _submission_payload(replay)
        raise ReviewSubmissionConflict("审核事项已提交，不能覆盖原回执")

    metadata = preliminary_review.source_conflict
    source_refs = metadata.get("source_refs") if isinstance(metadata, dict) else None
    if not isinstance(source_refs, dict):
        source_refs = {}
    raw_product_ids = source_refs.get("product_ids", [])
    raw_revision_ids = source_refs.get("revision_ids", [])
    if not isinstance(raw_product_ids, list) or any(
        not isinstance(item, str) or not item for item in raw_product_ids
    ):
        raise ReviewSubmissionConflict("审核来源中的 product_ids 必须是 ID 列表")
    revision_fields = ("revision_ids", "product_revision_ids", "all_revision_ids", "confirmed_revision_ids")
    for field_name in revision_fields:
        values = source_refs.get(field_name, [])
        if not isinstance(values, list) or any(
            not isinstance(item, str) or not item for item in values
        ):
            raise ReviewSubmissionConflict(f"审核来源中的 {field_name} 必须是 ID 列表")
    all_product_ids = source_refs.get("all_product_ids", [])
    if not isinstance(all_product_ids, list) or any(
        not isinstance(item, str) or not item for item in all_product_ids
    ):
        raise ReviewSubmissionConflict("审核来源中的 all_product_ids 必须是 ID 列表")
    referenced_revision_ids = {
        revision_id
        for field_name in revision_fields
        for revision_id in source_refs.get(field_name, [])
    }
    scalar_revision_id = source_refs.get("revision_id")
    if scalar_revision_id is not None:
        if not isinstance(scalar_revision_id, str) or not scalar_revision_id:
            raise ReviewSubmissionConflict("审核来源的 revision_id 无效")
        referenced_revision_ids.add(scalar_revision_id)
    product_ids = set()
    direct_product_id = source_refs.get("product_id")
    if isinstance(direct_product_id, str) and direct_product_id:
        product_ids.add(direct_product_id)
    product_ids.update(raw_product_ids)
    product_ids.update(all_product_ids)
    if referenced_revision_ids:
        product_ids.update(
            ProductRevision.objects.filter(pk__in=sorted(referenced_revision_ids)).values_list(
                "product_id", flat=True
            )
        )

    # Preserve the established Task -> Product lock order used by the workbench.
    try:
        Task.objects.select_for_update().get(pk=workflow.batch_id)
    except Task.DoesNotExist as exc:
        raise ReviewSubmissionConflict("审核批次不存在") from exc
    batch_product_ids = set(
        Product.objects.filter(task_id=workflow.batch_id).values_list("id", flat=True)
    )
    lock_product_ids = batch_product_ids | product_ids
    locked_products = list(
        Product.objects.select_for_update()
        .filter(pk__in=sorted(lock_product_ids), task_id=workflow.batch_id)
        .order_by("id")
    )
    if len(locked_products) != len(lock_product_ids):
        raise ReviewSubmissionConflict("审核来源产品不存在或不属于当前批次")

    locked_reviews = list(
        HumanReview.objects.select_for_update()
        .filter(task=workflow)
        .order_by("id")
    )
    review = next((item for item in locked_reviews if item.id == review_id), None)
    if review is None:
        raise ReviewNotFound("未知工作流或审核事项")
    if review.review_key != review_key:
        raise ReviewSubmissionConflict("review_key 与待审核事项不匹配")

    if review.status in {"submitted", "approved"}:
        stored_answer = review.answer if isinstance(review.answer, dict) else {}
        if stored_answer.get("request_fingerprint") != fingerprint:
            raise ReviewSubmissionConflict("审核事项已提交，不能覆盖原回执")
        return _submission_payload(review)
    if review.status != "pending":
        raise ReviewSubmissionConflict("审核事项当前状态不能提交")
    if workflow.status != "waiting_human":
        raise ReviewSubmissionConflict("工作流当前不处于待人工确认状态")

    try:
        validated_refs = validate_saved_review_sources(
            workflow,
            review,
        )
    except ReviewSubmissionConflict:
        raise
    except ValueError as exc:
        raise ReviewSubmissionConflict(f"审核来源已失效：{exc}") from exc

    signal = validated_refs.get("signal") if isinstance(validated_refs.get("signal"), dict) else {}
    if (
        signal.get("uncertainty") == "ambiguous_image_candidate"
        or answer.get("type") == "select_image_candidate"
    ):
        if signal.get("uncertainty") != "ambiguous_image_candidate":
            raise ReviewSubmissionConflict("选图回答与保存的审核信号不匹配")
        try:
            validate_image_selection_response(workflow, review, answer)
        except ValueError as exc:
            raise ReviewSubmissionConflict(str(exc)) from exc
    if answer.get("type") == "provide_image":
        if set(answer) != {"type", "upload_step_id"}:
            raise ReviewSubmissionConflict("补图回答必须只包含 type 和 upload_step_id")
        from .review_images import (
            ReviewImageConflict,
            is_missing_image_signal,
            validate_upload_credential,
        )

        if not is_missing_image_signal(validated_refs):
            raise ReviewSubmissionConflict("补图回答与保存的无图审核信号不匹配")
        try:
            validate_upload_credential(
                workflow,
                review,
                answer.get("upload_step_id"),
                allowed_review_statuses=("pending",),
            )
        except ReviewImageConflict as exc:
            raise ReviewSubmissionConflict(str(exc)) from exc

    _validate_sku_assignment_preflight(
        workflow=workflow,
        products=locked_products,
        reviews=locked_reviews,
        review=review,
        response=answer,
    )

    now = timezone.now()
    review.answer = {
        "response": answer,
        "submitted_at": now.isoformat(),
        "request_fingerprint": fingerprint,
        "source_refs": validated_refs,
    }
    review.reviewer = reviewer
    review.status = "submitted"
    review.save(update_fields=["answer", "reviewer", "status", "updated_at"])
    record_workflow_event(
        workflow=workflow,
        event_type="human_review_submitted",
        actor="human_reviewer",
        subtask=SubTask.objects.get(pk=review.source_conflict["subtask_id"]),
        from_status="pending",
        to_status="submitted",
        refs={
            "human_review_id": review.id,
            "review_key": review.review_key,
            "result_ref": review.source_conflict["result_ref"],
            "source_refs": validated_refs,
        },
        summary="human review submitted",
    )
    return _submission_payload(review)
