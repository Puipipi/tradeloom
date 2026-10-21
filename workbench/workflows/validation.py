from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass, field
from typing import Any

from django.db import transaction

from workbench.agents.context import WorkflowContext
from workbench.agents.workflow_contracts import WorkflowRoleError
from workbench.models import (
    HumanReview,
    ProductRevision,
    SubTask,
    TaskFile,
    WorkflowStep,
    WorkflowTask,
)

from .events import record_workflow_event


@dataclass(frozen=True)
class ReviewCandidate:
    issue_key: str
    item_ref: str
    question: str
    source_refs: dict[str, Any]
    options: list[Any] = field(default_factory=list)


def validate_task_file_refs(
    context: WorkflowContext,
    file_ids: Any,
    *,
    lock: bool = False,
) -> list[str]:
    if not isinstance(file_ids, list) or any(
        not isinstance(file_id, str) or not file_id.strip() for file_id in file_ids
    ):
        raise ValueError("待确认来源中的 task_file_ids 必须是非空字符串 ID 列表")
    unique_ids = sorted(set(file_ids))
    queryset = TaskFile.objects.filter(id__in=unique_ids)
    if lock:
        queryset = queryset.select_for_update()
    files = list(queryset.order_by("id"))
    if len(files) != len(unique_ids) or any(
        item.task_id != context.batch.id for item in files
    ):
        raise ValueError("待确认来源包含不存在或不属于当前批次的文件")
    return unique_ids


def _validated_product_sources(
    context: WorkflowContext,
    *,
    product_id: Any,
    item_source_refs: Any,
    image_candidates: Any = None,
) -> dict[str, Any]:
    if not isinstance(product_id, str) or not product_id:
        raise ValueError("待确认事项缺少有效 product_id")
    context.validate_refs(
        {
            "workflow_task_id": context.workflow.id,
            "batch_id": context.batch.id,
            "product_ids": [product_id],
        }
    )
    if item_source_refs is not None and not isinstance(item_source_refs, dict):
        raise ValueError("待确认事项的 source_refs 必须是对象")
    refs = item_source_refs or {}
    referenced_product = refs.get("product_id")
    if referenced_product is not None and referenced_product != product_id:
        raise ValueError("待确认事项的 source_refs.product_id 与产品 ID 不一致")

    revision_id = refs.get("revision_id")
    if revision_id is not None:
        if not isinstance(revision_id, str) or not revision_id:
            raise ValueError("revision_id 必须是非空字符串 ID")
        context.validate_refs(
            {
                "workflow_task_id": context.workflow.id,
                "batch_id": context.batch.id,
                "product_revision_ids": [revision_id],
            }
        )
        current_revision = context.current_revisions.get(product_id)
        if current_revision is None or current_revision.id != revision_id:
            raise ValueError("待确认事项的 revision_id 不属于对应产品的当前版本")
    else:
        revision = context.current_revisions.get(product_id)
        revision_id = revision.id if revision else None

    raw_file_ids = refs.get("task_file_ids", [])
    if not isinstance(raw_file_ids, list):
        raise ValueError("待确认来源中的 task_file_ids 必须是 ID 列表")
    file_ids = list(raw_file_ids)
    if image_candidates is not None:
        if not isinstance(image_candidates, list):
            raise ValueError("image_candidates 必须是列表")
        for candidate in image_candidates:
            if not isinstance(candidate, dict):
                raise ValueError("image_candidates 项必须是对象")
            file_id = candidate.get("task_file_id")
            if file_id is not None:
                file_ids.append(file_id)
    file_ids = validate_task_file_refs(context, file_ids)
    return {
        "workflow_task_id": context.workflow.id,
        "batch_id": context.batch.id,
        "product_id": product_id,
        "revision_id": revision_id,
        "task_file_ids": file_ids,
    }


def _validated_duplicate_sku_group(
    context: WorkflowContext,
    *,
    product_id: str,
    item_source_refs: Any,
) -> dict[str, Any]:
    if not isinstance(item_source_refs, dict):
        raise ValueError("重复 SKU 来源缺少产品来源引用")
    group = item_source_refs.get("duplicate_sku_group")
    if not isinstance(group, dict) or set(group) != {"sku", "members"}:
        raise ValueError("重复 SKU 来源组无效")
    sku = group.get("sku")
    members = group.get("members")
    if not isinstance(sku, str) or not sku or sku != sku.strip():
        raise ValueError("重复 SKU 来源值无效")
    if not isinstance(members, list) or len(members) < 2:
        raise ValueError("重复 SKU 来源成员无效")

    expected_members = []
    for product in context.products:
        revision = context.current_revisions.get(product.id)
        snapshot = revision.snapshot if revision and isinstance(revision.snapshot, dict) else {}
        current_sku = snapshot.get("sku", product.sku)
        normalized_sku = current_sku.strip() if isinstance(current_sku, str) else ""
        if normalized_sku == sku:
            expected_members.append(
                {
                    "product_id": product.id,
                    "revision_id": revision.id if revision else None,
                }
            )
    if members != expected_members or product_id not in {
        item.get("product_id") for item in members if isinstance(item, dict)
    }:
        raise ValueError("重复 SKU 来源组与当前全批产品版本不匹配")
    member = next(item for item in members if item["product_id"] == product_id)
    if member["revision_id"] != item_source_refs.get("revision_id"):
        raise ValueError("重复 SKU 来源组版本与产品引用不匹配")
    return group


def _baseline_sources(context: WorkflowContext) -> dict[str, Any]:
    context.validate_refs(
        {
            "workflow_task_id": context.workflow.id,
            "batch_id": context.batch.id,
            "product_ids": context.product_ids,
            "product_revision_ids": context.current_revision_ids,
        }
    )
    return {
        "workflow_task_id": context.workflow.id,
        "batch_id": context.batch.id,
        "product_ids": list(context.product_ids),
        "revision_ids": list(context.current_revision_ids),
        "task_file_ids": sorted(item.id for item in context.files),
    }


def _candidate(issue_key: str, item_ref: str, source_refs: dict[str, Any]) -> ReviewCandidate:
    return ReviewCandidate(
        issue_key=issue_key,
        item_ref=item_ref,
        question=f"请核对或补充此事项（{issue_key}），并确认关联来源。",
        source_refs=source_refs,
    )


def frozen_image_candidates_for_review(
    workflow: WorkflowTask,
    review: HumanReview,
) -> list[dict[str, str]]:
    """Read image identities from the immutable role-result snapshot for a review."""
    metadata = review.source_conflict if isinstance(review.source_conflict, dict) else {}
    refs = metadata.get("source_refs") if isinstance(metadata.get("source_refs"), dict) else {}
    signal = refs.get("signal") if isinstance(refs.get("signal"), dict) else {}
    product_id = refs.get("product_id")
    origin_step_id = metadata.get("origin_step_id")
    subtask_id = metadata.get("subtask_id")
    if (
        review.task_id != workflow.id
        or signal.get("uncertainty") != "ambiguous_image_candidate"
        or not isinstance(product_id, str)
        or not isinstance(origin_step_id, str)
        or not isinstance(subtask_id, str)
        or metadata.get("result_ref")
        != f"workflow_step:{origin_step_id}:output_refs.result_snapshot"
    ):
        raise ValueError("审核事项不是可选图的人审来源")
    origin = WorkflowStep.objects.filter(
        pk=origin_step_id,
        task=workflow,
        step_key=f"subtask:{subtask_id}",
        status="completed",
    ).first()
    snapshot = origin.output_refs.get("result_snapshot") if origin and isinstance(origin.output_refs, dict) else None
    result = snapshot.get("result") if isinstance(snapshot, dict) else None
    if (
        not isinstance(snapshot, dict)
        or snapshot.get("subtask_status") != "waiting_human"
        or not isinstance(result, dict)
        or result.get("status") != "needs_human"
        or result.get("task_id") not in (None, workflow.id)
        or result.get("batch_id") not in (None, workflow.batch_id)
    ):
        raise ValueError("不可变来源步骤无法证明图片候选")
    products = result.get("products")
    source_product = next(
        (
            item
            for item in products
            if isinstance(item, dict) and item.get("product_id") == product_id
        ),
        None,
    ) if isinstance(products, list) else None
    raw_candidates = source_product.get("image_candidates") if isinstance(source_product, dict) else None
    if (
        not isinstance(source_product, dict)
        or source_product.get("status") != "needs_human"
        or not isinstance(raw_candidates, list)
        or len(raw_candidates) < 2
    ):
        raise ValueError("不可变产品结果没有多个图片候选")
    candidate_ids: list[str] = []
    candidates: list[dict[str, str]] = []
    for item in raw_candidates:
        if not isinstance(item, dict):
            raise ValueError("不可变图片候选格式无效")
        task_file_id = item.get("task_file_id")
        original_name = item.get("original_name")
        stored_name = item.get("stored_name")
        if not all(isinstance(value, str) and value for value in (task_file_id, original_name, stored_name)):
            raise ValueError("不可变图片候选缺少文件身份")
        candidate_ids.append(task_file_id)
        candidates.append(
            {
                "task_file_id": task_file_id,
                "original_name": original_name,
                "stored_name": stored_name,
            }
        )
    if len(candidate_ids) != len(set(candidate_ids)):
        raise ValueError("不可变图片候选包含重复文件")
    saved_file_ids = refs.get("task_file_ids")
    if not isinstance(saved_file_ids, list) or set(saved_file_ids) != set(candidate_ids):
        raise ValueError("审核文件引用与不可变图片候选不一致")
    files = {
        item.id: item
        for item in TaskFile.objects.filter(
            pk__in=candidate_ids,
            task_id=workflow.batch_id,
            kind="image",
        )
    }
    if len(files) != len(candidate_ids):
        raise ValueError("图片候选文件不存在或不属于当前批次")
    for item in candidates:
        task_file = files[item["task_file_id"]]
        if (
            task_file.original_name != item["original_name"]
            or task_file.stored_name != item["stored_name"]
        ):
            raise ValueError("图片候选文件元数据与不可变结果不一致")
    return candidates


def validate_image_selection_response(
    workflow: WorkflowTask,
    review: HumanReview,
    response: Any,
) -> dict[str, str]:
    if not isinstance(response, dict) or set(response) != {"type", "task_file_id"} or response.get("type") != "select_image_candidate":
        raise ValueError("图片回答必须精确选择一张冻结候选")
    candidates = frozen_image_candidates_for_review(workflow, review)
    selected = [
        item for item in candidates if item["task_file_id"] == response.get("task_file_id")
    ]
    if len(selected) != 1:
        raise ValueError("所选文件不属于此审核事项的冻结图片候选")
    return selected[0]


def build_review_candidates(
    workflow: WorkflowTask,
    subtask: SubTask,
    result: dict[str, Any],
) -> list[ReviewCandidate]:
    if subtask.task_id != workflow.id:
        raise ValueError("SubTask 不属于当前 WorkflowTask")
    if not isinstance(result, dict) or result.get("status") != "needs_human":
        return []
    if result.get("task_id") not in (None, workflow.id):
        raise ValueError("待确认结果引用了其他 WorkflowTask")
    if result.get("batch_id") not in (None, workflow.batch_id):
        raise ValueError("待确认结果引用了其他批次")

    context = WorkflowContext.from_workflow(workflow)
    result_source_refs = result.get("source_refs")
    if result_source_refs is not None:
        if not isinstance(result_source_refs, dict):
            raise ValueError("待确认结果的 source_refs 必须是对象")
        context.validate_refs(result_source_refs)
        if "task_file_ids" in result_source_refs:
            validate_task_file_refs(context, result_source_refs["task_file_ids"])

    candidates: list[ReviewCandidate] = []
    if subtask.agent_role == "product_profile":
        products = result.get("products")
        if isinstance(products, list):
            for item in products:
                if not isinstance(item, dict) or item.get("status") != "needs_human":
                    continue
                product_id = item.get("product_id")
                source_refs = _validated_product_sources(
                    context,
                    product_id=product_id,
                    item_source_refs=item.get("source_refs"),
                    image_candidates=item.get("image_candidates", []),
                )
                missing = item.get("missing_fields", [])
                uncertainties = item.get("uncertainties", [])
                if not isinstance(missing, list) or any(not isinstance(value, str) for value in missing):
                    raise ValueError("missing_fields 必须是字符串列表")
                if not isinstance(uncertainties, list) or any(
                    not isinstance(value, str) for value in uncertainties
                ):
                    raise ValueError("uncertainties 必须是字符串列表")
                for field_name in dict.fromkeys(missing):
                    candidates.append(
                        _candidate(
                            f"missing_field:{field_name}",
                            f"product:{product_id}",
                            {
                                **source_refs,
                                "signal": {
                                    "missing_field": field_name,
                                    "uncertainties": uncertainties,
                                },
                            },
                        )
                    )
                represented_uncertainties = set()
                if "english_name" in missing:
                    represented_uncertainties.add("missing_english_name")
                if "图片" in missing:
                    represented_uncertainties.add("no_image_candidate")
                for uncertainty in dict.fromkeys(uncertainties):
                    if uncertainty in represented_uncertainties:
                        continue
                    candidate_refs = dict(source_refs)
                    if uncertainty == "duplicate_sku":
                        candidate_refs["duplicate_sku_group"] = (
                            _validated_duplicate_sku_group(
                                context,
                                product_id=product_id,
                                item_source_refs=item.get("source_refs"),
                            )
                        )
                    candidates.append(
                        _candidate(
                            f"uncertainty:{uncertainty}",
                            f"product:{product_id}",
                            {
                                **candidate_refs,
                                "signal": {"uncertainty": uncertainty},
                            },
                        )
                    )
                if not missing and not uncertainties:
                    candidates.append(
                        _candidate(
                            "role_needs_human",
                            f"product:{product_id}",
                            {**source_refs, "signal": {"status": "needs_human"}},
                        )
                    )

    elif subtask.agent_role == "delivery_quality":
        checks = result.get("checks")
        products = result.get("products")
        product_by_id = {
            item.get("product_id"): item
            for item in products
            if isinstance(item, dict) and item.get("product_id")
        } if isinstance(products, list) else {}
        if isinstance(checks, list):
            for check in checks:
                if not isinstance(check, dict) or check.get("status") != "needs_human":
                    continue
                code = check.get("code")
                if not isinstance(code, str) or not code:
                    raise ValueError("DeliveryQuality needs_human check 缺少 code")
                product_id = check.get("product_id")
                signal = {key: check[key] for key in ("code", "missing_fields") if key in check}
                if product_id is None:
                    refs = _baseline_sources(context)
                    item_ref = f"subtask:{subtask.id}"
                else:
                    product_item = product_by_id.get(product_id, {})
                    refs = _validated_product_sources(
                        context,
                        product_id=product_id,
                        item_source_refs=product_item.get("source_refs"),
                        image_candidates=product_item.get("image_candidates", []),
                    )
                    item_ref = f"product:{product_id}"
                candidates.append(
                    _candidate(
                        f"delivery_check:{code}",
                        item_ref,
                        {**refs, "signal": signal},
                    )
                )

    if not candidates:
        candidates.append(
            _candidate(
                "role_needs_human",
                f"subtask:{subtask.id}",
                {
                    **_baseline_sources(context),
                    "signal": {"status": "needs_human"},
                },
            )
        )
    return candidates


def _review_key(
    subtask: SubTask,
    candidate: ReviewCandidate,
    *,
    origin_step_id: str | None = None,
) -> str:
    material = json.dumps(
        {
            "subtask_id": subtask.id,
            "origin_step_id": origin_step_id,
            "issue_key": candidate.issue_key,
            "item_ref": candidate.item_ref,
            "source_refs": candidate.source_refs,
        },
        sort_keys=True,
        separators=(",", ":"),
        ensure_ascii=False,
    )
    digest = hashlib.sha256(material.encode("utf-8")).hexdigest()
    return f"task12a:{subtask.id}:{digest}"


@transaction.atomic
def persist_review_candidates(
    workflow_id: str,
    subtask_id: str,
    result: dict[str, Any],
    *,
    origin_step: WorkflowStep | None = None,
) -> list[HumanReview]:
    try:
        workflow = WorkflowTask.objects.select_for_update().select_related("batch").get(
            pk=workflow_id
        )
    except WorkflowTask.DoesNotExist as exc:
        raise ValueError(f"未知 WorkflowTask：{workflow_id}") from exc
    try:
        subtask = SubTask.objects.select_for_update().get(pk=subtask_id)
    except SubTask.DoesNotExist as exc:
        raise ValueError(f"未知 SubTask：{subtask_id}") from exc
    if subtask.task_id != workflow.id:
        raise ValueError("SubTask 不属于当前 WorkflowTask")
    if origin_step is not None:
        if (
            origin_step.task_id != workflow.id
            or origin_step.step_key != f"subtask:{subtask.id}"
            or origin_step.status not in {"running", "completed"}
        ):
            raise ValueError("审核候选的来源步骤与当前 SubTask 不匹配")
        latest = WorkflowStep.objects.filter(
            task=workflow,
            step_key=f"subtask:{subtask.id}",
        ).order_by("-attempt", "-created_at", "-id").first()
        if latest is None or latest.id != origin_step.id:
            raise ValueError("审核候选必须绑定当前最新的 SubTask 步骤")
        if origin_step.status == "completed":
            snapshot = origin_step.output_refs.get("result_snapshot") if isinstance(origin_step.output_refs, dict) else None
            if not isinstance(snapshot, dict) or snapshot.get("result") != result:
                raise ValueError("已完成来源步骤的结果与候选不一致")

    candidates = build_review_candidates(workflow, subtask, result)
    reviews = []
    result_ref = (
        f"workflow_step:{origin_step.id}:output_refs.result_snapshot"
        if origin_step is not None
        else f"subtask:{subtask.id}:output_refs.result"
    )
    for candidate in candidates:
        key = _review_key(
            subtask,
            candidate,
            origin_step_id=origin_step.id if origin_step is not None else None,
        )
        review = HumanReview.objects.select_for_update().filter(
            task=workflow,
            review_key=key,
        ).first()
        if review is None:
            review = HumanReview.objects.create(
                task=workflow,
                item_ref=candidate.item_ref,
                question=candidate.question,
                options=candidate.options,
                source_conflict={
                    "kind": candidate.issue_key,
                    "issue_key": candidate.issue_key,
                    "subtask_id": subtask.id,
                    "result_ref": result_ref,
                    "source_refs": candidate.source_refs,
                    **(
                        {"origin_step_id": origin_step.id}
                        if origin_step is not None
                        else {}
                    ),
                },
                status="pending",
                review_key=key,
            )
            record_workflow_event(
                workflow=workflow,
                subtask=subtask,
                event_type="human_review_created",
                actor="orchestrator",
                to_status="pending",
                refs={
                    "human_review_id": review.id,
                    "issue_key": candidate.issue_key,
                    "result_ref": result_ref,
                },
                summary=candidate.issue_key,
            )
        reviews.append(review)
    return reviews


def validate_current_review_source_refs(
    workflow: WorkflowTask,
    source_refs: Any,
) -> dict[str, Any]:
    """Validate persisted review provenance against the workflow's live sources.

    Callers that need race safety must first lock the WorkflowTask, batch Task,
    referenced Product rows, and HumanReview in the established order. This
    helper then locks the referenced revisions/files inside that transaction.
    """
    if not isinstance(source_refs, dict):
        raise ValueError("审核来源引用必须是对象")
    if (
        source_refs.get("workflow_task_id") != workflow.id
        or source_refs.get("batch_id") != workflow.batch_id
    ):
        raise ValueError("审核来源引用与当前工作流或批次不一致")

    product_ids = source_refs.get("product_ids", [])
    all_product_ids = source_refs.get("all_product_ids", [])
    if not isinstance(product_ids, list) or not isinstance(all_product_ids, list):
        raise ValueError("审核来源中的产品引用必须是 ID 列表")
    if any(not isinstance(item, str) or not item for item in [*product_ids, *all_product_ids]):
        raise ValueError("审核来源中的产品引用必须是非空字符串 ID 列表")
    direct_product_id = source_refs.get("product_id")
    if direct_product_id is not None and (
        not isinstance(direct_product_id, str) or not direct_product_id
    ):
        raise ValueError("审核来源的 product_id 无效")

    normalized_refs = dict(source_refs)
    if direct_product_id is not None:
        normalized_refs["product_ids"] = list(dict.fromkeys([*product_ids, direct_product_id]))
    signal = source_refs.get("signal")
    duplicate_group = source_refs.get("duplicate_sku_group")
    duplicate_member_product_ids: list[str] = []
    duplicate_member_revision_ids: list[str] = []
    if isinstance(signal, dict) and signal.get("uncertainty") == "duplicate_sku":
        if not isinstance(duplicate_group, dict) or not isinstance(duplicate_group.get("members"), list):
            raise ValueError("审核来源中的重复 SKU 成员无效")
        for member in duplicate_group["members"]:
            if not isinstance(member, dict):
                raise ValueError("审核来源中的重复 SKU 成员无效")
            member_product_id = member.get("product_id")
            member_revision_id = member.get("revision_id")
            if not isinstance(member_product_id, str) or not member_product_id:
                raise ValueError("审核来源中的重复 SKU 产品 ID 无效")
            if member_revision_id is not None and (
                not isinstance(member_revision_id, str) or not member_revision_id
            ):
                raise ValueError("审核来源中的重复 SKU 版本 ID 无效")
            duplicate_member_product_ids.append(member_product_id)
            if isinstance(member_revision_id, str):
                duplicate_member_revision_ids.append(member_revision_id)
        normalized_refs["product_ids"] = list(
            dict.fromkeys([*normalized_refs.get("product_ids", []), *duplicate_member_product_ids])
        )
    revision_ids = source_refs.get("revision_ids", [])
    if not isinstance(revision_ids, list) or any(
        not isinstance(item, str) or not item for item in revision_ids
    ):
        raise ValueError("审核来源中的 revision_ids 必须是 ID 列表")
    scalar_revision_id = source_refs.get("revision_id")
    if scalar_revision_id is not None and (
        not isinstance(scalar_revision_id, str) or not scalar_revision_id
    ):
        raise ValueError("审核来源的 revision_id 无效")
    for field_name in ("product_revision_ids", "all_revision_ids", "confirmed_revision_ids"):
        values = source_refs.get(field_name, [])
        if not isinstance(values, list) or any(
            not isinstance(item, str) or not item for item in values
        ):
            raise ValueError(f"审核来源中的 {field_name} 必须是 ID 列表")
    if revision_ids or scalar_revision_id:
        current = normalized_refs.get("product_revision_ids", [])
        if not isinstance(current, list):
            raise ValueError("审核来源中的 product_revision_ids 必须是 ID 列表")
        normalized_refs["product_revision_ids"] = list(
            dict.fromkeys(
                [*current, *revision_ids]
                + ([scalar_revision_id] if scalar_revision_id else [])
                + duplicate_member_revision_ids
            )
        )
    elif duplicate_member_revision_ids:
        normalized_refs["product_revision_ids"] = list(dict.fromkeys(duplicate_member_revision_ids))

    revisions_to_lock = set(revision_ids)
    if scalar_revision_id:
        revisions_to_lock.add(scalar_revision_id)
    revisions_to_lock.update(duplicate_member_revision_ids)
    for field_name in ("product_revision_ids", "all_revision_ids", "confirmed_revision_ids"):
        revisions_to_lock.update(source_refs.get(field_name, []))
    if revisions_to_lock:
        list(
            ProductRevision.objects.select_for_update()
            .filter(pk__in=sorted(revisions_to_lock))
            .order_by("id")
        )
    context = WorkflowContext.from_workflow(workflow)
    try:
        context.validate_refs(normalized_refs)
    except WorkflowRoleError as exc:
        raise ValueError(f"审核来源已失效：{exc}") from exc

    if direct_product_id is not None and scalar_revision_id is not None:
        revision = context.current_revisions.get(direct_product_id)
        if revision is None or revision.id != scalar_revision_id:
            raise ValueError("revision_id 不属于审核事项对应产品的当前版本")

    file_ids = source_refs.get("task_file_ids", [])
    validate_task_file_refs(context, file_ids, lock=True)
    return source_refs


def validate_duplicate_sku_review_source_refs(
    workflow: WorkflowTask,
    source_refs: Any,
    origin_result: Any,
) -> None:
    if not isinstance(source_refs, dict):
        raise ValueError("审核来源引用必须是对象")
    signal = source_refs.get("signal")
    if not isinstance(signal, dict):
        if "duplicate_sku_group" in source_refs:
            raise ValueError("重复 SKU 来源缺少有效信号")
        return
    if signal.get("uncertainty") != "duplicate_sku":
        if "duplicate_sku_group" in source_refs:
            raise ValueError("非重复 SKU 信号包含重复组来源")
        return
    if not isinstance(origin_result, dict) or origin_result.get("status") != "needs_human":
        raise ValueError("重复 SKU 来源结果无效")
    product_id = source_refs.get("product_id")
    revision_id = source_refs.get("revision_id")
    group = source_refs.get("duplicate_sku_group")
    products = origin_result.get("products")
    if not isinstance(product_id, str) or (
        revision_id is not None
        and (not isinstance(revision_id, str) or not revision_id)
    ):
        raise ValueError("重复 SKU 来源缺少有效产品或版本 ID")
    if not isinstance(products, list):
        raise ValueError("重复 SKU 来源结果缺少产品快照")
    source_item = next(
        (
            item
            for item in products
            if isinstance(item, dict) and item.get("product_id") == product_id
        ),
        None,
    )
    if not isinstance(source_item, dict):
        raise ValueError("重复 SKU 来源产品不在不可变结果快照中")
    item_refs = source_item.get("source_refs")
    uncertainties = source_item.get("uncertainties")
    if (
        not isinstance(item_refs, dict)
        or item_refs.get("revision_id") != revision_id
        or item_refs.get("duplicate_sku_group") != group
        or not isinstance(uncertainties, list)
        or "duplicate_sku" not in uncertainties
    ):
        raise ValueError("重复 SKU 来源组与不可变产品快照不匹配")
    context = WorkflowContext.from_workflow(workflow)
    expected_group = _validated_duplicate_sku_group(
        context,
        product_id=product_id,
        item_source_refs=item_refs,
    )
    if expected_group != group:
        raise ValueError("重复 SKU 来源组与当前全批产品版本不匹配")
