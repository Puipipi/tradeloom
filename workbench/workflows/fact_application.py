from __future__ import annotations

import hashlib
import json
from typing import Any

from django.db import transaction
from django.utils import timezone

from workbench.agents.center import CenterAgent
from workbench.agents.context import WorkflowContext
from workbench.models import (
    EventLog,
    HumanReview,
    Product,
    ProductRevision,
    SubTask,
    Task,
    TaskFile,
    WorkflowStep,
    WorkflowTask,
)
from workbench.services import FIELD_LABELS

from .reviews import ReviewSubmissionConflict, validate_saved_review_sources
from .review_images import (
    ReviewImageConflict,
    is_missing_image_signal,
    validate_upload_credential,
)
from .states import transition_workflow
from .validation import validate_image_selection_response


LEGACY_LITERAL_FIELDS = frozenset(
    {"sku", "name", "category", "material", "size", "color"}
)
REVISION_LITERAL_FIELDS = LEGACY_LITERAL_FIELDS | {"english_name"}
REVISION_REQUIRED_FIELDS = REVISION_LITERAL_FIELDS | {"image_filename"}


class FactApplicationNotFound(LookupError):
    pass


class FactApplicationConflict(ValueError):
    pass


class InvalidFactApplication(ValueError):
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
        raise InvalidFactApplication("申请内容必须是标准 JSON") from exc


def _fingerprint(value: Any) -> str:
    return hashlib.sha256(_canonical_json(value).encode("utf-8")).hexdigest()


def _source_metadata(review: HumanReview) -> tuple[dict[str, Any], dict[str, Any]]:
    metadata = review.source_conflict
    if not isinstance(metadata, dict):
        raise FactApplicationConflict("审核事项来源无效")
    refs = metadata.get("source_refs")
    if not isinstance(refs, dict):
        raise FactApplicationConflict("审核事项缺少来源引用")
    if not metadata.get("origin_step_id"):
        raise FactApplicationConflict("旧审核事项缺少可证明的来源步骤，不能应用事实")
    return metadata, refs


def _typed_literal(review: HumanReview, refs: dict[str, Any]) -> tuple[str, str, str] | None:
    envelope = review.answer if isinstance(review.answer, dict) else {}
    response = envelope.get("response")
    if not isinstance(response, dict):
        raise FactApplicationConflict("该审核回答不是受支持的结构化事实")
    signal = refs.get("signal")
    if not isinstance(signal, dict):
        raise FactApplicationConflict("审核事项不包含可应用的事实信号")

    if response.get("type") == "set_literal_field":
        if set(response) != {"type", "field", "value"}:
            raise FactApplicationConflict("字面字段回答包含未知字段")
        field_name = response.get("field")
        value = response.get("value")
        if (
            not isinstance(field_name, str)
            or field_name not in REVISION_LITERAL_FIELDS
            or signal.get("missing_field") != field_name
        ):
            raise FactApplicationConflict("回答字段与保存的审核信号不匹配")
        if not isinstance(value, str) or not value.strip():
            raise FactApplicationConflict("事实值必须是非空字符串")
        product_id = refs.get("product_id")
        if not isinstance(product_id, str) or not product_id:
            raise FactApplicationConflict("字面事实没有唯一产品来源")
        return product_id, field_name, value

    if response.get("type") == "resolve_duplicate_sku":
        if set(response) != {"type", "value"}:
            raise FactApplicationConflict("重复 SKU 回答包含未知字段")
        group = refs.get("duplicate_sku_group")
        members = group.get("members") if isinstance(group, dict) else None
        value = response.get("value")
        product_id = refs.get("product_id")
        if (
            signal.get("uncertainty") != "duplicate_sku"
            or not isinstance(group, dict)
            or not isinstance(members, list)
            or not isinstance(product_id, str)
            or product_id not in {
                member.get("product_id")
                for member in members
                if isinstance(member, dict)
            }
        ):
            raise FactApplicationConflict("重复 SKU 回答与保存的来源信号不匹配")
        if not isinstance(value, str) or not value.strip():
            raise FactApplicationConflict("SKU 必须是非空字符串")
        value = value.strip()
        max_length = Product._meta.get_field("sku").max_length
        if len(value) > max_length:
            raise FactApplicationConflict("SKU 超过现有产品字段长度限制")
        return product_id, "sku", value

    if response.get("type") == "confirm_current_revision":
        if set(response) != {"type", "revision_id"}:
            raise FactApplicationConflict("版本确认回答包含未知字段")
        if signal.get("uncertainty") != "current_revision_not_confirmed":
            raise FactApplicationConflict("版本确认与保存的审核信号不匹配")
        revision_id = refs.get("revision_id")
        if not isinstance(revision_id, str) or response.get("revision_id") != revision_id:
            raise FactApplicationConflict("确认版本与审核引用的当前版本不匹配")
        if not isinstance(refs.get("product_id"), str):
            raise FactApplicationConflict("版本确认没有唯一产品来源")
        return None

    raise FactApplicationConflict("该审核回答类型暂不支持事实应用")


def _cycle_request_fingerprint(
    *,
    review_ids: list[str],
    decision: str,
    reviewer: str,
    reviews: list[HumanReview],
) -> str:
    answers = {
        review.id: {
            "request_fingerprint": (
                review.answer.get("request_fingerprint")
                if isinstance(review.answer, dict)
                else None
            ),
            "response": (
                review.answer.get("response")
                if isinstance(review.answer, dict)
                else None
            ),
        }
        for review in reviews
    }
    return _fingerprint(
        {
            "review_ids": sorted(review_ids),
            "decision": decision,
            "reviewer": reviewer,
            "answers": answers,
        }
    )


def _product_ids_from_reviews(reviews: list[HumanReview]) -> set[str]:
    product_ids: set[str] = set()
    revision_ids: set[str] = set()
    for review in reviews:
        metadata, refs = _source_metadata(review)
        direct = refs.get("product_id")
        if isinstance(direct, str) and direct:
            product_ids.add(direct)
        for key in ("product_ids", "all_product_ids"):
            values = refs.get(key, [])
            if not isinstance(values, list):
                raise FactApplicationConflict(f"审核来源的 {key} 无效")
            product_ids.update(value for value in values if isinstance(value, str))
        for key in (
            "revision_ids",
            "product_revision_ids",
            "all_revision_ids",
            "confirmed_revision_ids",
        ):
            values = refs.get(key, [])
            if not isinstance(values, list):
                raise FactApplicationConflict(f"审核来源的 {key} 无效")
            revision_ids.update(value for value in values if isinstance(value, str))
        revision_id = refs.get("revision_id")
        if isinstance(revision_id, str) and revision_id:
            revision_ids.add(revision_id)
    if revision_ids:
        product_ids.update(
            ProductRevision.objects.filter(pk__in=sorted(revision_ids)).values_list(
                "product_id", flat=True
            )
        )
    return product_ids


def _prospective_sku_assignments(
    products: list[Product],
    current_revisions: dict[str, ProductRevision],
    merged: dict[str, dict[str, str]],
) -> dict[str, str]:
    sku_owners: dict[str, str] = {}
    assignments: dict[str, str] = {}
    max_length = Product._meta.get_field("sku").max_length
    for product in products:
        current = current_revisions.get(product.id)
        snapshot = current.snapshot if current and isinstance(current.snapshot, dict) else {}
        sku = merged.get(product.id, {}).get("sku", snapshot.get("sku", product.sku))
        if not isinstance(sku, str) or not sku.strip():
            raise FactApplicationConflict("本批产品 SKU 不能为空")
        normalized_sku = sku.strip()
        if len(normalized_sku) > max_length:
            raise FactApplicationConflict("SKU 超过现有产品字段长度限制")
        prior_product_id = sku_owners.get(normalized_sku)
        if prior_product_id is not None and prior_product_id != product.id:
            raise FactApplicationConflict("本批应用后的 SKU 仍有重复")
        sku_owners[normalized_sku] = product.id
        assignments[product.id] = normalized_sku
    return assignments


def _validate_fixed_plan(plan: dict[str, Any], subtasks: list[SubTask]) -> dict[str, dict[str, Any]]:
    rows = plan.get("subtasks")
    if not isinstance(rows, list) or len(rows) != 2:
        raise FactApplicationConflict("新计划不再是固定双步骤计划")
    by_key = {row.get("key"): row for row in rows if isinstance(row, dict)}
    if set(by_key) != {"product_profile", "delivery_quality"}:
        raise FactApplicationConflict("新计划必须保留产品资料与交付质检两个角色")
    saved = {subtask.agent_role: subtask for subtask in subtasks}
    if set(saved) != set(by_key):
        raise FactApplicationConflict("工作流中的既有角色记录与固定计划不匹配")
    for role, row in by_key.items():
        expected = {
            saved[dependency].id
            for dependency in row.get("depends_on", [])
            if dependency in saved
        }
        actual = set(saved[role].depends_on.values_list("id", flat=True))
        if expected != actual:
            raise FactApplicationConflict("固定角色依赖已变化，不能恢复")
    return by_key


@transaction.atomic
def apply_fact_review_cycle(
    *,
    workflow_id: str,
    review_ids: list[str],
    idempotency_key: str,
    decision: str,
    reviewer: str,
) -> dict[str, Any]:
    if decision != "apply_and_confirm":
        raise InvalidFactApplication("decision 必须是 apply_and_confirm")
    if not idempotency_key or not idempotency_key.strip() or len(idempotency_key) > 200:
        raise InvalidFactApplication("幂等键必须是非空且不超过 200 个字符")
    if not reviewer or not reviewer.strip() or len(reviewer) > 120:
        raise InvalidFactApplication("reviewer 必须是有效的操作者标签")
    if not isinstance(review_ids, list) or not review_ids or any(
        not isinstance(item, str) or not item.strip() for item in review_ids
    ) or len(review_ids) != len(set(review_ids)):
        raise InvalidFactApplication("review_ids 必须是非空且无重复的 ID 列表")

    try:
        workflow = WorkflowTask.objects.select_for_update().select_related("batch").get(
            pk=workflow_id
        )
    except WorkflowTask.DoesNotExist as exc:
        raise FactApplicationNotFound("工作流不存在") from exc

    keyed_step = WorkflowStep.objects.select_for_update().filter(
        task=workflow,
        idempotency_key=idempotency_key,
    ).first()
    if keyed_step is not None:
        if keyed_step.step_key != "apply_review_cycle":
            raise FactApplicationConflict("幂等键已用于其他工作流步骤")
        saved_fingerprint = keyed_step.input_refs.get("request_fingerprint")
        all_reviews = list(
            HumanReview.objects.filter(pk__in=sorted(review_ids), task=workflow).order_by("id")
        )
        fingerprint = _cycle_request_fingerprint(
            review_ids=review_ids,
            decision=decision,
            reviewer=reviewer,
            reviews=all_reviews,
        )
        if saved_fingerprint != fingerprint:
            raise FactApplicationConflict("幂等键已绑定不同的事实应用请求")
        return keyed_step.output_refs["receipt"]

    if workflow.status != "waiting_human":
        raise FactApplicationConflict("工作流当前不处于待人工确认状态")

    try:
        batch = Task.objects.select_for_update().get(pk=workflow.batch_id)
    except Task.DoesNotExist as exc:
        raise FactApplicationConflict("审核批次不存在") from exc
    workflow.batch = batch

    preliminary = list(
        HumanReview.objects.filter(
            task=workflow,
            status__in=["pending", "submitted"],
        ).order_by("id")
    )
    if sorted(review_ids) != sorted(review.id for review in preliminary):
        raise FactApplicationConflict("review_ids 必须精确匹配全部当前未解决事项")

    product_ids = _product_ids_from_reviews(preliminary)
    products = list(
        Product.objects.select_for_update()
        .filter(task_id=batch.id)
        .order_by("id")
    )
    product_by_id = {product.id: product for product in products}
    if not product_ids.issubset(product_by_id):
        raise FactApplicationConflict("审核产品不存在或不属于当前批次")

    reviews = list(
        HumanReview.objects.select_for_update()
        .filter(task=workflow, pk__in=sorted(review_ids))
        .order_by("id")
    )
    if len(reviews) != len(review_ids):
        raise FactApplicationNotFound("审核事项不存在")
    if any(review.status != "submitted" for review in reviews):
        raise FactApplicationConflict("全部未解决事项都必须先提交回答")

    fingerprint = _cycle_request_fingerprint(
        review_ids=review_ids,
        decision=decision,
        reviewer=reviewer,
        reviews=reviews,
    )
    origin_step_ids: set[str] = set()
    merged: dict[str, dict[str, str]] = {}
    product_review_ids: dict[str, list[str]] = {}
    field_review_ids: dict[str, dict[str, str]] = {}
    selected_images: dict[str, tuple[dict[str, str], str]] = {}
    provided_images: dict[str, tuple[dict[str, Any], str]] = {}
    prior_revisions: dict[str, ProductRevision] = {}
    for review in reviews:
        metadata, refs = _source_metadata(review)
        origin_step_ids.add(metadata["origin_step_id"])
        try:
            validated = validate_saved_review_sources(workflow, review)
        except (ReviewSubmissionConflict, ValueError) as exc:
            raise FactApplicationConflict(f"审核来源已失效：{exc}") from exc
        if validated != refs:
            raise FactApplicationConflict("审核来源在提交后发生变化")
        envelope = review.answer if isinstance(review.answer, dict) else {}
        response = envelope.get("response")
        image_selection = None
        uploaded_image = None
        if isinstance(response, dict) and response.get("type") == "select_image_candidate":
            try:
                image_selection = validate_image_selection_response(workflow, review, response)
            except ValueError as exc:
                raise FactApplicationConflict(str(exc)) from exc
            typed = None
        elif isinstance(response, dict) and response.get("type") == "provide_image":
            if set(response) != {"type", "upload_step_id"} or not is_missing_image_signal(refs):
                raise FactApplicationConflict("补图回答与保存的无图审核来源不匹配")
            try:
                upload_step, upload_file, file_info = validate_upload_credential(
                    workflow, review, response.get("upload_step_id"),
                    allowed_review_statuses=("submitted",),
                )
            except ReviewImageConflict as exc:
                raise FactApplicationConflict(str(exc)) from exc
            uploaded_image = {
                "task_file_id": upload_file.id,
                "original_name": upload_file.original_name,
                "stored_name": upload_file.stored_name,
                "sha256": file_info["sha256"],
                "mime_type": file_info["mime_type"],
                "upload_step_id": upload_step.id,
                "origin_step_id": upload_step.output_refs.get("origin_step_id"),
                "revision_id": upload_step.output_refs.get("revision_id"),
                "human_review_id": review.id,
            }
            typed = None
        else:
            typed = _typed_literal(review, refs)
        product_id = refs.get("product_id")
        if not isinstance(product_id, str) or product_id not in product_by_id:
            raise FactApplicationConflict("该审核事项不是受支持的单产品事实")
        revision_id = refs.get("revision_id")
        if not isinstance(revision_id, str) or not revision_id:
            raise FactApplicationConflict("审核事项没有可证明的当前产品版本")
        revision = ProductRevision.objects.select_for_update().get(pk=revision_id)
        latest = ProductRevision.objects.filter(product_id=product_id).order_by("-version").first()
        if revision.product_id != product_id or latest is None or latest.id != revision.id:
            raise FactApplicationConflict("审核引用的产品版本已不是当前版本")
        product = product_by_id[product_id]
        revision_snapshot = revision.snapshot if isinstance(revision.snapshot, dict) else {}
        if revision_snapshot.get("image_stored_name", product.image_stored_name) != product.image_stored_name:
            raise FactApplicationConflict("产品图片存储名与当前版本不一致")
        task_file_ids = refs.get("task_file_ids", [])
        if not isinstance(task_file_ids, list):
            raise FactApplicationConflict("审核来源的文件引用无效")
        if task_file_ids:
            files = list(
                TaskFile.objects.select_for_update()
                .filter(pk__in=sorted(set(task_file_ids)), task_id=batch.id)
                .order_by("id")
            )
            if len(files) != len(set(task_file_ids)):
                raise FactApplicationConflict("审核引用的批次文件不存在")
        prior_revisions[product_id] = revision
        product_review_ids.setdefault(product_id, []).append(review.id)
        if image_selection is not None:
            if product_id in selected_images:
                raise FactApplicationConflict("同一产品不能在一个审核周期选择多张图片")
            selected_images[product_id] = (image_selection, review.id)
        if uploaded_image is not None:
            if product_id in provided_images:
                raise FactApplicationConflict("同一产品不能在一个审核周期提交多张补图")
            provided_images[product_id] = (uploaded_image, review.id)
        if typed is not None:
            typed_product_id, field_name, value = typed
            if typed_product_id != product_id:
                raise FactApplicationConflict("回答产品与审核来源不匹配")
            if field_name in LEGACY_LITERAL_FIELDS:
                max_length = Product._meta.get_field(field_name).max_length
                if max_length is not None and len(value) > max_length:
                    raise FactApplicationConflict(
                        f"字段 {field_name} 超过现有产品字段长度限制"
                    )
            merged.setdefault(product_id, {})[field_name] = value
            field_review_ids.setdefault(product_id, {})[field_name] = review.id

    if len(origin_step_ids) != 1:
        raise FactApplicationConflict("当前未解决事项不属于同一个来源步骤")
    origin_step_id = next(iter(origin_step_ids))
    origin_step = WorkflowStep.objects.select_for_update().filter(
        pk=origin_step_id,
        task=workflow,
        step_key=f"subtask:{reviews[0].source_conflict.get('subtask_id')}",
        status="completed",
    ).first()
    if origin_step is None:
        raise FactApplicationConflict("来源步骤不属于当前待确认角色")
    origin_snapshot = origin_step.output_refs.get("result_snapshot") if isinstance(origin_step.output_refs, dict) else None
    origin_result = origin_snapshot.get("result") if isinstance(origin_snapshot, dict) else None
    origin_refs = origin_result.get("source_refs") if isinstance(origin_result, dict) else None
    if not isinstance(origin_refs, dict) or not isinstance(origin_refs.get("product_ids"), list):
        raise FactApplicationConflict("来源步骤未保存完整批次产品清单")
    saved_product_ids = origin_refs["product_ids"]
    current_product_ids = [product.id for product in products]
    if (
        any(not isinstance(product_id, str) or not product_id for product_id in saved_product_ids)
        or len(saved_product_ids) != len(set(saved_product_ids))
        or sorted(saved_product_ids) != current_product_ids
    ):
        raise FactApplicationConflict("审核期间批次产品集合已变化")

    source_products = origin_result.get("products")
    if not isinstance(source_products, list) or len(source_products) != len(products):
        raise FactApplicationConflict("不可变来源步骤缺少全批产品版本快照")
    source_by_product: dict[str, dict[str, Any]] = {}
    source_item_by_product: dict[str, dict[str, Any]] = {}
    for item in source_products:
        if not isinstance(item, dict):
            raise FactApplicationConflict("不可变来源步骤包含无效产品版本快照")
        product_id = item.get("product_id")
        revision = item.get("current_revision")
        if not isinstance(product_id, str) or product_id in source_by_product:
            raise FactApplicationConflict("来源产品版本快照存在缺失或重复产品")
        if not isinstance(revision, dict):
            raise FactApplicationConflict("来源步骤未证明每个产品的当前版本")
        source_by_product[product_id] = revision
        source_item_by_product[product_id] = item
    if set(source_by_product) != set(current_product_ids):
        raise FactApplicationConflict("来源步骤版本快照与当前批次产品集合不一致")

    current_revision_rows = list(
        ProductRevision.objects.select_for_update()
        .filter(product_id__in=current_product_ids)
        .order_by("product_id", "version", "id")
    )
    current_revisions: dict[str, ProductRevision] = {}
    for revision in current_revision_rows:
        current_revisions[revision.product_id] = revision
    for product_id in current_product_ids:
        saved = source_by_product[product_id]
        current = current_revisions.get(product_id)
        if current is None or not isinstance(current.snapshot, dict):
            raise FactApplicationConflict("批次产品缺少可证明的当前版本")
        if (
            saved.get("revision_id") != current.id
            or saved.get("version") != current.version
            or saved.get("status") != current.status
            or saved.get("snapshot") != current.snapshot
        ):
            raise FactApplicationConflict("审核期间批次产品版本已变化")
        product = product_by_id[product_id]
        candidates = source_item_by_product[product_id].get("image_candidates")
        provided = provided_images.get(product_id)
        if provided is not None and candidates == []:
            upload_proof, _image_review_id = provided
            revision_image = current.source_refs.get("image") if isinstance(current.source_refs, dict) else None
            if product.image_stored_name or current.snapshot.get("image_filename") or revision_image:
                raise FactApplicationConflict("无图审核引用的产品当前版本已有图片")
            stored_upload = TaskFile.objects.select_for_update().filter(
                pk=upload_proof["task_file_id"], task_id=batch.id, kind="image"
            ).first()
            if (
                stored_upload is None
                or stored_upload.original_name != upload_proof["original_name"]
                or stored_upload.stored_name != upload_proof["stored_name"]
            ):
                raise FactApplicationConflict("人审补图文件身份已变化")
            continue
        if not isinstance(candidates, list) or not candidates or any(not isinstance(item, dict) for item in candidates):
            raise FactApplicationConflict("当前来源缺少可证明的产品图片候选")
        candidate_ids = [item.get("task_file_id") for item in candidates]
        if (
            any(not isinstance(item, str) or not item for item in candidate_ids)
            or len(candidate_ids) != len(set(candidate_ids))
            or any(
                not isinstance(item.get("original_name"), str)
                or not item.get("original_name")
                or not isinstance(item.get("stored_name"), str)
                or not item.get("stored_name")
                for item in candidates
            )
        ):
            raise FactApplicationConflict("不可变图片候选身份无效")
        candidate_files = {
            item.id: item
            for item in TaskFile.objects.select_for_update()
            .filter(pk__in=sorted(candidate_ids), task_id=batch.id, kind="image")
            .order_by("id")
        }
        if len(candidate_files) != len(candidate_ids) or any(
            candidate_files[item["task_file_id"]].original_name != item["original_name"]
            or candidate_files[item["task_file_id"]].stored_name != item["stored_name"]
            for item in candidates
        ):
            raise FactApplicationConflict("不可变图片候选文件身份已变化")
        product = product_by_id[product_id]
        revision_image = current.source_refs.get("image") if isinstance(current.source_refs, dict) else None
        baseline_candidate = next(
            (
                item for item in candidates
                if isinstance(revision_image, dict)
                and item.get("task_file_id") == revision_image.get("task_file_id")
                and item.get("original_name") == revision_image.get("original_name")
                and item.get("stored_name") == revision_image.get("stored_name")
            ),
            None,
        )
        if baseline_candidate is None:
            raise FactApplicationConflict("当前产品图片不属于不可变来源候选")
        baseline_file = candidate_files.get(baseline_candidate.get("task_file_id"))
        if (
            baseline_file is None
            or baseline_file.original_name != baseline_candidate.get("original_name")
            or baseline_file.stored_name != baseline_candidate.get("stored_name")
            or product.image_stored_name != baseline_candidate.get("stored_name")
            or current.snapshot.get("image_filename") != baseline_candidate.get("original_name")
        ):
            raise FactApplicationConflict("审核来源图片与当前产品版本的文件元数据不一致")
        selected = selected_images.get(product_id)
        if selected is None:
            if len(candidates) != 1:
                raise FactApplicationConflict("当前来源图片存在歧义，必须先提交明确选图")
        else:
            chosen_candidate, _ = selected
            if not any(
                item.get("task_file_id") == chosen_candidate["task_file_id"]
                and item.get("original_name") == chosen_candidate["original_name"]
                and item.get("stored_name") == chosen_candidate["stored_name"]
                for item in candidates
            ):
                raise FactApplicationConflict("人工选择不属于不可变来源图片候选")

    _prospective_sku_assignments(products, current_revisions, merged)

    if len(subtasks := list(SubTask.objects.select_for_update().filter(task=workflow).order_by("agent_role", "id"))) != 2:
        raise FactApplicationConflict("工作流角色集合已变化，不能恢复")
    if {subtask.agent_role for subtask in subtasks} != {"product_profile", "delivery_quality"}:
        raise FactApplicationConflict("工作流缺少固定双角色")

    now = timezone.now()
    new_revisions: dict[str, ProductRevision] = {}
    for product_id in sorted(prior_revisions):
        product = product_by_id[product_id]
        prior = prior_revisions[product_id]
        snapshot = dict(prior.snapshot) if isinstance(prior.snapshot, dict) else {}
        field_sources = dict(prior.field_sources) if isinstance(prior.field_sources, dict) else {}
        changed_product_fields = []
        for field_name, value in merged.get(product_id, {}).items():
            snapshot[field_name] = value
            field_sources[field_name] = f"human_review:{field_review_ids[product_id][field_name]}"
            if field_name in LEGACY_LITERAL_FIELDS and getattr(product, field_name) != value:
                setattr(product, field_name, value)
                changed_product_fields.append(field_name)
        selected = selected_images.get(product_id)
        if selected is not None:
            candidate, image_review_id = selected
            product.image_filename = candidate["original_name"]
            product.image_stored_name = candidate["stored_name"]
            changed_product_fields.extend(["image_filename", "image_stored_name"])
            snapshot["image_filename"] = candidate["original_name"]
            field_sources["image_filename"] = f"human_review:{image_review_id}"
        provided = provided_images.get(product_id)
        if provided is not None:
            proof, image_review_id = provided
            product.image_filename = proof["original_name"]
            product.image_stored_name = proof["stored_name"]
            changed_product_fields.extend(["image_filename", "image_stored_name"])
            snapshot["image_filename"] = proof["original_name"]
            field_sources["image_filename"] = f"human_review:{image_review_id}"
        incomplete = [
            field_name
            for field_name in REVISION_REQUIRED_FIELDS
            if not isinstance(snapshot.get(field_name), str)
            or not snapshot[field_name].strip()
        ]
        if incomplete:
            raise FactApplicationConflict(
                "产品版本仍缺少必需字面资料：" + ", ".join(sorted(incomplete))
            )
        product.missing_fields = [
            label
            for field_name, label in FIELD_LABELS.items()
            if not str(getattr(product, field_name, "") or "").strip()
        ]
        if not product.image_stored_name:
            product.missing_fields.append("图片")
        product.updated_at = now
        product.save(
            update_fields=list(dict.fromkeys(changed_product_fields + ["missing_fields", "updated_at"]))
        )
        source_refs = dict(prior.source_refs) if isinstance(prior.source_refs, dict) else {}
        source_refs.update(
            {
                "source": "human_review",
                "actor": reviewer,
                "workflow_task_id": workflow.id,
                "origin_step_id": origin_step_id,
                "human_review_ids": sorted(product_review_ids[product_id]),
                "cycle_review_ids": sorted(review_ids),
                "cycle_review_sources": {
                    review.id: review.source_conflict["source_refs"]
                    for review in reviews
                },
                "prior_revision_id": prior.id,
            }
        )
        if selected is not None:
            candidate, image_review_id = selected
            source_refs["image"] = {
                "task_file_id": candidate["task_file_id"],
                "original_name": candidate["original_name"],
                "stored_name": candidate["stored_name"],
            }
            source_refs["human_image_selection"] = {
                "human_review_id": image_review_id,
                "task_file_id": candidate["task_file_id"],
                "original_name": candidate["original_name"],
                "stored_name": candidate["stored_name"],
            }
        if provided is not None:
            proof, image_review_id = provided
            source_refs["image"] = {
                "task_file_id": proof["task_file_id"],
                "original_name": proof["original_name"],
                "stored_name": proof["stored_name"],
            }
            source_refs["human_image_upload"] = {
                key: proof[key]
                for key in (
                    "human_review_id",
                    "upload_step_id",
                    "task_file_id",
                    "original_name",
                    "stored_name",
                    "sha256",
                    "mime_type",
                    "origin_step_id",
                    "revision_id",
                )
            }
        new_revisions[product_id] = ProductRevision.objects.create(
            product=product,
            version=prior.version + 1,
            snapshot=snapshot,
            field_sources=field_sources,
            status="confirmed",
            source_refs=source_refs,
            reviewer=reviewer,
        )

    all_products = products
    current_revisions = {
        revision.product_id: revision
        for revision in ProductRevision.objects.filter(
            product_id__in=[product.id for product in all_products]
        ).order_by("product_id", "version")
    }
    if not all_products or any(
        product.id not in current_revisions
        or current_revisions[product.id].status != "confirmed"
        or not isinstance(current_revisions[product.id].snapshot, dict)
        or any(
            not isinstance(current_revisions[product.id].snapshot.get(field_name), str)
            or not current_revisions[product.id].snapshot[field_name].strip()
            for field_name in REVISION_REQUIRED_FIELDS
        )
        for product in all_products
    ):
        raise FactApplicationConflict("本批仍有产品缺少已确认的当前版本")
    if batch.status != "confirmed":
        batch.status = "confirmed"
        batch.updated_at = now
        batch.save(update_fields=["status", "updated_at"])

    context = WorkflowContext.from_workflow(workflow)
    plan = CenterAgent().plan(context)
    plan_rows = _validate_fixed_plan(plan, subtasks)
    subtask_by_role = {subtask.agent_role: subtask for subtask in subtasks}
    latest_plan = WorkflowStep.objects.select_for_update().filter(
        task=workflow,
        step_key="center_plan",
    ).order_by("-attempt", "-created_at", "-id").first()
    if latest_plan is None or latest_plan.status != "completed":
        raise FactApplicationConflict("没有可追加的已完成固定计划")
    plan_step = WorkflowStep.objects.create(
        task=workflow,
        step_key="center_plan",
        status="completed",
        attempt=latest_plan.attempt + 1,
        idempotency_key=(
            f"workflow:{workflow.id}:center_plan:review:{hashlib.sha256(idempotency_key.encode('utf-8')).hexdigest()}"
        ),
        input_refs={
            "workflow_task_id": workflow.id,
            "applied_review_ids": sorted(review_ids),
            "prior_plan_step_id": latest_plan.id,
            "execution_mode": latest_plan.input_refs.get("execution_mode", "local_mock"),
            **({
                "execution_confirmation_fingerprint": latest_plan.input_refs["execution_confirmation_fingerprint"]
            } if isinstance(latest_plan.input_refs, dict)
                and isinstance(latest_plan.input_refs.get("execution_confirmation_fingerprint"), str)
                else {}),
        },
        output_refs={
            "plan": plan,
            "subtask_ids": [subtask_by_role[row["key"]].id for row in plan["subtasks"]],
            "source_refs": plan.get("source_refs", {}),
        },
        started_at=now,
        finished_at=now,
    )
    resume_authority: dict[str, dict[str, Any]] = {}
    for role in ("product_profile", "delivery_quality"):
        subtask = subtask_by_role[role]
        prior_step = WorkflowStep.objects.select_for_update().filter(
            task=workflow,
            step_key=f"subtask:{subtask.id}",
        ).order_by("-attempt", "-created_at", "-id").first()
        row = plan_rows[role]
        subtask.input_refs = row.get("input_refs", {})
        subtask.status = "queued"
        subtask.output_refs = {}
        subtask.error_summary = ""
        subtask.save(update_fields=["input_refs", "status", "output_refs", "error_summary", "updated_at"])
        resume_authority[subtask.id] = {
            "role": role,
            "expected_prior_step_id": prior_step.id if prior_step else None,
            "next_attempt": prior_step.attempt + 1 if prior_step else 1,
            "input_fingerprint": _fingerprint(subtask.input_refs),
            "plan_step_id": plan_step.id,
        }

    review_ids_sorted = sorted(review_ids)
    for review in reviews:
        review.status = "approved"
        review.save(update_fields=["status", "updated_at"])

    old_workflow_status = workflow.status
    workflow = transition_workflow(workflow, "running", actor="human_reviewer")
    workflow.current_step = "product_profile"
    workflow.result_refs = {
        **workflow.result_refs,
        "subtasks": {},
        "plan_step_id": plan_step.id,
        "next_step": "product_profile",
        "review_apply_step_key": idempotency_key,
    }
    workflow.save(update_fields=["current_step", "result_refs", "updated_at"])

    receipt = {
        "workflow_id": workflow.id,
        "status": "applied",
        "decision": decision,
        "review_ids": review_ids_sorted,
        "revision_ids": {
            product_id: revision.id
            for product_id, revision in sorted(new_revisions.items())
        },
        "center_plan_step_id": plan_step.id,
        "workflow_status": workflow.status,
        "current_step": workflow.current_step,
    }
    apply_step = WorkflowStep.objects.create(
        task=workflow,
        step_key="apply_review_cycle",
        status="completed",
        attempt=1,
        idempotency_key=idempotency_key,
        input_refs={
            "request_fingerprint": fingerprint,
            "review_ids": review_ids_sorted,
            "decision": decision,
            "reviewer": reviewer,
            "origin_step_id": origin_step_id,
        },
        output_refs={
            "receipt": receipt,
            "origin_step_id": origin_step_id,
            "review_ids": review_ids_sorted,
            "answer_fingerprints": {
                review.id: review.answer.get("request_fingerprint")
                for review in reviews
            },
            "revision_ids": receipt["revision_ids"],
            "center_plan_step_id": plan_step.id,
            "resume_authority": resume_authority,
        },
        started_at=now,
        finished_at=now,
    )
    record_payload = {
        "apply_step_id": apply_step.id,
        "origin_step_id": origin_step_id,
        "review_ids": review_ids_sorted,
        "center_plan_step_id": plan_step.id,
        "revision_ids": receipt["revision_ids"],
    }
    EventLog.objects.create(
        task=workflow,
        event_type="human_review_cycle_applied",
        actor="human_reviewer",
        payload_summary={
            "from_status": old_workflow_status,
            "to_status": workflow.status,
            "refs": record_payload,
        },
    )
    return receipt
