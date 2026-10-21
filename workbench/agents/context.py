from __future__ import annotations

import json
from collections import defaultdict
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from workbench.models import HumanReview, Product, ProductRevision, Task, TaskFile, WorkflowStep, WorkflowTask

from .workflow_contracts import (
    CrossBatchReferenceError,
    InputContractError,
    RolePermissionError,
    StaleRevisionReferenceError,
    ToolInputContractError,
    ToolOutputContractError,
    UnknownToolError,
    UnknownWorkflowRole,
)
from .tool_contracts import ToolDefinition, make_tool_definition, validate_json_contract


REQUIRED_PRODUCT_FIELDS = (
    "sku",
    "name",
    "category",
    "material",
    "size",
    "color",
    "image_filename",
)

TOOL_ALLOWLIST = {
    "center": frozenset(
        {
            "read_workflow_task",
            "read_batch_products",
            "read_current_revisions",
        }
    ),
    "product_profile": frozenset(
        {
            "read_batch_products",
            "read_current_revisions",
            "read_task_files",
            "match_image_candidates",
            "validate_product_data",
        }
    ),
    "delivery_quality": frozenset(
        {
            "read_batch_products",
            "read_confirmed_revisions",
            "read_task_files",
            "check_data_readiness",
            "compose_generation_intent",
        }
    ),
    "market_customer": frozenset(),
    "quotation": frozenset(),
}


def _id_list(value: Any, field_name: str) -> list[str]:
    if value is None:
        return []
    if not isinstance(value, (list, tuple, set)):
        raise InputContractError(f"{field_name} 必须是 ID 列表")
    result = []
    for item in value:
        if not isinstance(item, str) or not item.strip():
            raise InputContractError(f"{field_name} 必须是非空字符串 ID 列表")
        result.append(item)
    return result


@dataclass(frozen=True)
class WorkflowContext:
    workflow: WorkflowTask
    products: tuple[Product, ...]
    files: tuple[TaskFile, ...]
    current_revisions: dict[str, ProductRevision]

    @classmethod
    def from_workflow(cls, workflow: WorkflowTask) -> WorkflowContext:
        products = tuple(
            Product.objects.filter(task_id=workflow.batch_id).order_by("position", "id")
        )
        files = tuple(
            TaskFile.objects.filter(task_id=workflow.batch_id).order_by(
                "created_at",
                "id",
            )
        )
        product_ids = [product.id for product in products]
        current_revisions: dict[str, ProductRevision] = {}
        if product_ids:
            for revision in ProductRevision.objects.filter(
                product_id__in=product_ids
            ).order_by("product_id", "version"):
                current_revisions[revision.product_id] = revision
        return cls(
            workflow=workflow,
            products=products,
            files=files,
            current_revisions=current_revisions,
        )

    @property
    def batch(self) -> Task:
        return self.workflow.batch

    @property
    def product_ids(self) -> list[str]:
        return [product.id for product in self.products]

    @property
    def current_revision_ids(self) -> list[str]:
        return [
            self.current_revisions[product.id].id
            for product in self.products
            if product.id in self.current_revisions
        ]

    @property
    def confirmed_revision_ids(self) -> list[str]:
        return [
            self.current_revisions[product.id].id
            for product in self.products
            if product.id in self.current_revisions
            and self.current_revisions[product.id].status == "confirmed"
        ]

    @property
    def unconfirmed_product_ids(self) -> list[str]:
        return [
            product.id
            for product in self.products
            if product.id not in self.current_revisions
            or self.current_revisions[product.id].status != "confirmed"
        ]

    def validate_refs(self, input_refs: dict[str, Any] | None) -> None:
        refs = input_refs or {}
        if not isinstance(refs, dict):
            raise InputContractError("input_refs 必须是对象")

        workflow_task_id = refs.get("workflow_task_id")
        if workflow_task_id is not None and workflow_task_id != self.workflow.id:
            raise CrossBatchReferenceError("workflow_task_id 不属于当前业务任务")

        batch_id = refs.get("batch_id")
        if batch_id is not None and batch_id != self.batch.id:
            raise CrossBatchReferenceError("batch_id 不属于当前批次")

        context_product_ids = set(self.product_ids)
        for key in ("product_ids", "all_product_ids"):
            for product_id in _id_list(refs.get(key), key):
                if product_id not in context_product_ids:
                    raise CrossBatchReferenceError(
                        f"产品引用不属于当前批次：{product_id}"
                    )

        referenced_revision_ids: list[str] = []
        for key in (
            "product_revision_ids",
            "all_revision_ids",
            "confirmed_revision_ids",
        ):
            referenced_revision_ids.extend(_id_list(refs.get(key), key))
        referenced_revision_ids = list(dict.fromkeys(referenced_revision_ids))
        if not referenced_revision_ids:
            return

        found = {
            revision.id: revision
            for revision in ProductRevision.objects.filter(
                id__in=referenced_revision_ids
            ).select_related("product")
        }
        current_ids = set(self.current_revision_ids)
        for revision_id in referenced_revision_ids:
            revision = found.get(revision_id)
            if revision is None:
                raise StaleRevisionReferenceError(
                    f"修订不存在或已过期：{revision_id}"
                )
            if revision.product.task_id != self.batch.id:
                raise CrossBatchReferenceError(
                    f"修订不属于当前批次：{revision_id}"
                )
            if revision.id not in current_ids:
                raise StaleRevisionReferenceError(
                    f"修订不是当前版本：{revision_id}"
                )


class RoleToolbox:
    def __init__(
        self,
        context: WorkflowContext,
        role_id: str,
        input_refs: dict[str, Any] | None,
    ) -> None:
        if role_id not in TOOL_ALLOWLIST:
            raise UnknownWorkflowRole(
                f"未知角色：{role_id}",
                role_id=role_id,
            )
        self.context = context
        self.role_id = role_id
        self.input_refs = input_refs or {}
        self.allowed_tools = TOOL_ALLOWLIST[role_id]
        context.validate_refs(self.input_refs)

    def call(self, tool_name: str, **kwargs: Any) -> Any:
        definition = _TOOL_DEFINITIONS.get(tool_name)
        if definition is None:
            raise UnknownToolError(
                f"未知工具：{tool_name}",
                role_id=self.role_id,
                tool_name=tool_name,
            )
        if tool_name not in self.allowed_tools:
            raise RolePermissionError(
                f"角色 {self.role_id} 无权调用工具：{tool_name}",
                role_id=self.role_id,
                tool_name=tool_name,
            )
        try:
            validate_json_contract(kwargs, definition.input_schema)
        except Exception as exc:
            raise ToolInputContractError(
                "工具输入不符合已注册契约",
                role_id=self.role_id,
                tool_name=tool_name,
            ) from exc
        result = definition.handler(self.context, **kwargs)
        try:
            validate_json_contract(result, definition.output_schema)
        except Exception as exc:
            raise ToolOutputContractError(
                "工具输出不符合已注册契约",
                role_id=self.role_id,
                tool_name=tool_name,
            ) from exc
        return result

    def describe_tools(self) -> list[dict[str, Any]]:
        """Return this role's permitted tool contracts without executable state."""
        return [
            json.loads(
                json.dumps(
                    {
                        "name": name,
                        "description": _TOOL_DEFINITIONS[name].description,
                        "input_schema": _TOOL_DEFINITIONS[name].input_schema,
                        "output_schema": _TOOL_DEFINITIONS[name].output_schema,
                    },
                    ensure_ascii=False,
                    allow_nan=False,
                )
            )
            for name in sorted(self.allowed_tools)
            if name in _TOOL_DEFINITIONS
        ]


def _read_workflow_task(context: WorkflowContext) -> dict[str, Any]:
    task = context.workflow
    return {
        "id": task.id,
        "status": task.status,
        "current_step": task.current_step,
        "task_type": task.task_type,
        "user_goal": task.user_goal,
        "batch_id": task.batch_id,
        "batch_title": task.batch.title,
        "batch_status": task.batch.status,
    }


def _read_batch_products(context: WorkflowContext) -> list[dict[str, Any]]:
    return [
        {
            "product_id": product.id,
            "sku": product.sku,
            "position": product.position,
            "name": product.name,
            "category": product.category,
            "material": product.material,
            "size": product.size,
            "color": product.color,
            "image_filename": product.image_filename,
            "image_stored_name": product.image_stored_name,
            "missing_fields": list(product.missing_fields),
        }
        for product in context.products
    ]


def _revision_payload(revision: ProductRevision) -> dict[str, Any]:
    snapshot = revision.snapshot if isinstance(revision.snapshot, dict) else {}
    return {
        "revision_id": revision.id,
        "product_id": revision.product_id,
        "version": revision.version,
        "status": revision.status,
        "english_name_present": bool(str(snapshot.get("english_name", "")).strip()),
        "snapshot": snapshot,
    }


def _read_current_revisions(context: WorkflowContext) -> list[dict[str, Any]]:
    return [
        _revision_payload(context.current_revisions[product.id])
        for product in context.products
        if product.id in context.current_revisions
    ]


def _read_confirmed_revisions(context: WorkflowContext) -> list[dict[str, Any]]:
    return [
        _revision_payload(context.current_revisions[product.id])
        for product in context.products
        if product.id in context.current_revisions
        and context.current_revisions[product.id].status == "confirmed"
    ]


def _read_task_files(context: WorkflowContext) -> list[dict[str, Any]]:
    return [
        {
            "task_file_id": task_file.id,
            "kind": task_file.kind,
            "original_name": task_file.original_name,
            "stored_name": task_file.stored_name,
        }
        for task_file in context.files
    ]


def _match_image_candidates(
    context: WorkflowContext,
    *,
    product_ids: list[str] | None = None,
) -> dict[str, list[dict[str, Any]]]:
    selected = (
        set(context.product_ids)
        if product_ids is None
        else set(product_ids)
    )
    batch = getattr(context, "batch", None)
    upload_steps = (
        WorkflowStep.objects.filter(
            task__batch_id=batch.id,
            step_key__startswith="review_image_upload:",
            status="completed",
        )
        if batch is not None
        else WorkflowStep.objects.none()
    )
    upload_step_ids = list(upload_steps.values_list("id", flat=True))
    upload_file_ids = {
        step.output_refs.get("task_file_id")
        for step in WorkflowStep.objects.filter(pk__in=upload_step_ids)
        if isinstance(step.output_refs, dict)
        and isinstance(step.output_refs.get("task_file_id"), str)
    }
    image_files = [
        item for item in context.files
        if item.kind == "image" and item.id not in upload_file_ids
    ]
    result: dict[str, list[dict[str, Any]]] = {}
    for product in context.products:
        if product.id not in selected:
            continue
        revision = context.current_revisions.get(product.id)
        revision_sources = (
            getattr(revision, "source_refs", None)
            if revision and isinstance(getattr(revision, "source_refs", None), dict)
            else {}
        )
        manual_selection = revision_sources.get("human_image_selection")
        if manual_selection is not None:
            required_keys = {
                "human_review_id",
                "task_file_id",
                "original_name",
                "stored_name",
            }
            if not isinstance(manual_selection, dict) or set(manual_selection) != required_keys:
                raise InputContractError("当前产品的人工作图来源无效")
            task_file = next(
                (item for item in image_files if item.id == manual_selection.get("task_file_id")),
                None,
            )
            image_ref = revision_sources.get("image")
            if (
                revision_sources.get("source") != "human_review"
                or not isinstance(revision_sources.get("human_review_ids"), list)
                or task_file is None
                or task_file.original_name != manual_selection["original_name"]
                or task_file.stored_name != manual_selection["stored_name"]
                or product.image_filename != task_file.original_name
                or product.image_stored_name != task_file.stored_name
                or not isinstance(revision.snapshot, dict)
                or revision.snapshot.get("image_filename") != task_file.original_name
                or not isinstance(image_ref, dict)
                or image_ref.get("task_file_id") != task_file.id
                or image_ref.get("original_name") != task_file.original_name
                or image_ref.get("stored_name") != task_file.stored_name
            ):
                raise InputContractError("当前产品的人工作图与产品版本或批次文件不一致")
            from workbench.workflows.validation import frozen_image_candidates_for_review

            review = HumanReview.objects.filter(
                pk=manual_selection["human_review_id"],
                task__batch_id=context.batch.id,
                status="approved",
            ).select_related("task").first()
            answer = review.answer if review and isinstance(review.answer, dict) else {}
            response = answer.get("response") if isinstance(answer, dict) else None
            source_refs = (
                review.source_conflict.get("source_refs")
                if review and isinstance(review.source_conflict, dict)
                else None
            )
            frozen_candidates = []
            if review and isinstance(source_refs, dict) and source_refs.get("product_id") == product.id:
                try:
                    frozen_candidates = frozen_image_candidates_for_review(review.task, review)
                except ValueError:
                    frozen_candidates = []
            chosen_candidate = next(
                (item for item in frozen_candidates if item["task_file_id"] == task_file.id),
                None,
            )
            if (
                not isinstance(response, dict)
                or response != {
                    "type": "select_image_candidate",
                    "task_file_id": task_file.id,
                }
                or chosen_candidate is None
                or chosen_candidate["original_name"] != task_file.original_name
                or chosen_candidate["stored_name"] != task_file.stored_name
            ):
                raise InputContractError("当前产品的人工作图没有对应的同批已应用审核回执")
            result[product.id] = [
                {
                    "task_file_id": task_file.id,
                    "original_name": task_file.original_name,
                    "stored_name": task_file.stored_name,
                    "match_types": ["human_review"],
                }
            ]
            continue
        manual_upload = revision_sources.get("human_image_upload")
        if manual_upload is not None:
            required_keys = {
                "human_review_id", "upload_step_id", "task_file_id", "original_name",
                "stored_name", "sha256", "mime_type", "origin_step_id", "revision_id",
            }
            if not isinstance(manual_upload, dict) or set(manual_upload) != required_keys:
                raise InputContractError("当前产品的人审补图来源无效")
            review = HumanReview.objects.filter(
                pk=manual_upload.get("human_review_id"), task__batch_id=context.batch.id,
                status="approved",
            ).select_related("task").first()
            if review is None:
                raise InputContractError("当前产品的人审补图没有同批已批准回执")
            answer = review.answer if isinstance(review.answer, dict) else {}
            response = answer.get("response") if isinstance(answer, dict) else None
            if not isinstance(response, dict) or response != {
                "type": "provide_image", "upload_step_id": manual_upload["upload_step_id"]
            }:
                raise InputContractError("当前产品的人审补图回答与凭据不匹配")
            from workbench.workflows.review_images import ReviewImageConflict, validate_upload_credential

            try:
                upload_step, task_file, file_info = validate_upload_credential(
                    review.task, review, manual_upload["upload_step_id"],
                    allowed_review_statuses=("approved",),
                )
            except ReviewImageConflict as exc:
                raise InputContractError(f"当前产品的人审补图凭据无效：{exc}") from exc
            proof = upload_step.output_refs
            if (
                task_file.id != manual_upload["task_file_id"]
                or task_file.original_name != manual_upload["original_name"]
                or task_file.stored_name != manual_upload["stored_name"]
                or file_info["sha256"] != manual_upload["sha256"]
                or file_info["mime_type"] != manual_upload["mime_type"]
                or proof.get("origin_step_id") != manual_upload["origin_step_id"]
                or proof.get("revision_id") != manual_upload["revision_id"]
                or proof.get("product_id") != product.id
                or product.image_filename != task_file.original_name
                or product.image_stored_name != task_file.stored_name
                or not isinstance(revision.snapshot, dict)
                or revision.snapshot.get("image_filename") != task_file.original_name
                or not isinstance(revision_sources.get("image"), dict)
                or revision_sources["image"].get("task_file_id") != task_file.id
                or revision_sources["image"].get("original_name") != task_file.original_name
                or revision_sources["image"].get("stored_name") != task_file.stored_name
            ):
                raise InputContractError("当前产品的人审补图与已确认产品版本不一致")
            result[product.id] = [{
                "task_file_id": task_file.id,
                "original_name": task_file.original_name,
                "stored_name": task_file.stored_name,
                "match_types": ["human_review_upload"],
            }]
            continue
        candidates = []
        for task_file in image_files:
            match_types = []
            if (
                product.image_stored_name
                and task_file.stored_name == product.image_stored_name
            ):
                match_types.append("stored_name")
            if (
                product.image_filename
                and task_file.original_name == product.image_filename
            ):
                match_types.append("filename")
            if Path(task_file.original_name).stem == product.sku:
                match_types.append("sku_stem")
            if match_types:
                candidates.append(
                    {
                        "task_file_id": task_file.id,
                        "original_name": task_file.original_name,
                        "stored_name": task_file.stored_name,
                        "match_types": match_types,
                    }
                )
        result[product.id] = candidates
    return result


def _validate_product_data(
    context: WorkflowContext,
    *,
    product_ids: list[str] | None = None,
) -> dict[str, dict[str, Any]]:
    selected = (
        set(context.product_ids)
        if product_ids is None
        else set(product_ids)
    )
    image_candidates = _match_image_candidates(
        context,
        product_ids=list(selected),
    )
    sku_groups: dict[str, list[dict[str, str | None]]] = defaultdict(list)
    for product in context.products:
        revision = context.current_revisions.get(product.id)
        snapshot = revision.snapshot if revision and isinstance(revision.snapshot, dict) else {}
        sku = snapshot.get("sku", product.sku)
        normalized_sku = sku.strip() if isinstance(sku, str) else ""
        if normalized_sku:
            sku_groups[normalized_sku].append(
                {
                    "product_id": product.id,
                    "revision_id": revision.id if revision else None,
                }
            )
    result: dict[str, dict[str, Any]] = {}
    for product in context.products:
        if product.id not in selected:
            continue
        revision = context.current_revisions.get(product.id)
        snapshot = revision.snapshot if revision and isinstance(revision.snapshot, dict) else {}
        candidates = image_candidates[product.id]

        missing_fields: list[str] = (
            [] if revision is not None else list(product.missing_fields)
        )
        for field in REQUIRED_PRODUCT_FIELDS:
            if field == "image_filename":
                continue
            value = snapshot.get(field)
            if value is None:
                value = getattr(product, field)
            if not str(value or "").strip() and field not in missing_fields:
                missing_fields.append(field)
        if not str(snapshot.get("english_name", "")).strip() and "english_name" not in missing_fields:
            missing_fields.append("english_name")
        if not candidates and "图片" not in missing_fields:
            missing_fields.append("图片")

        uncertainties: list[str] = []
        if revision is None:
            uncertainties.append("missing_current_revision")
        elif revision.status != "confirmed":
            uncertainties.append("current_revision_not_confirmed")
        if not str(snapshot.get("english_name", "")).strip():
            uncertainties.append("missing_english_name")
        if not candidates:
            uncertainties.append("no_image_candidate")
        elif len(candidates) > 1:
            uncertainties.append("ambiguous_image_candidate")

        duplicate_sku_group = None
        current_sku = snapshot.get("sku", product.sku)
        normalized_sku = current_sku.strip() if isinstance(current_sku, str) else ""
        members = sku_groups.get(normalized_sku, []) if normalized_sku else []
        if len(members) > 1:
            uncertainties.append("duplicate_sku")
            duplicate_sku_group = {
                "sku": normalized_sku,
                "members": members,
            }

        source_refs = {
            "product": "workbench.Product",
            "product_id": product.id,
            "revision": "workbench.ProductRevision" if revision else None,
            "revision_id": revision.id if revision else None,
            "task_file_ids": [item["task_file_id"] for item in candidates],
        }
        if duplicate_sku_group is not None:
            source_refs["duplicate_sku_group"] = duplicate_sku_group
        result[product.id] = {
            "product_id": product.id,
            "sku": product.sku,
            "position": product.position,
            "current_revision": _revision_payload(revision) if revision else None,
            "image_candidates": candidates,
            "missing_fields": missing_fields,
            "uncertainties": uncertainties,
            "source_refs": source_refs,
        }
    return result


def _check_data_readiness(context: WorkflowContext) -> dict[str, Any]:
    all_product_ids = context.product_ids
    confirmed_revision_ids = context.confirmed_revision_ids
    unconfirmed_product_ids = context.unconfirmed_product_ids
    all_products_confirmed = bool(all_product_ids) and not unconfirmed_product_ids
    scope = {
        "kind": "full_batch",
        "all_product_ids": all_product_ids,
        "confirmed_revision_ids": confirmed_revision_ids,
        "unconfirmed_product_ids": unconfirmed_product_ids,
        "requires_all_products_confirmed": True,
        "all_products_confirmed": all_products_confirmed,
    }
    checks: list[dict[str, Any]] = [
        {
            "code": "batch_scope",
            "status": "passed",
            "all_product_count": len(all_product_ids),
        }
    ]

    if not all_products_confirmed:
        for product in context.products:
            revision = context.current_revisions.get(product.id)
            if revision is not None and revision.status == "confirmed":
                continue
            checks.append(
                {
                    "code": "confirmed_revision",
                    "status": "blocked",
                    "product_id": product.id,
                    "revision_status": revision.status if revision else None,
                }
            )
        return {
            "status": "blocked",
            "quality_scope": "data_readiness",
            "data_readiness": "not_ready",
            "artifacts_generated": False,
            "scope": scope,
            "checks": checks,
            "products": [],
        }

    validations = _validate_product_data(context)
    products = []
    needs_human = False
    for product in context.products:
        validation = validations[product.id]
        field_gaps = [
            item
            for item in validation["missing_fields"]
            if item not in {"图片", "english_name"}
        ]
        has_image = bool(validation["image_candidates"])
        has_english_name = "missing_english_name" not in validation["uncertainties"]
        if field_gaps:
            checks.append(
                {
                    "code": "fields",
                    "status": "needs_human",
                    "product_id": product.id,
                    "missing_fields": field_gaps,
                }
            )
        if not has_image:
            checks.append(
                {
                    "code": "image",
                    "status": "needs_human",
                    "product_id": product.id,
                }
            )
        if not has_english_name:
            checks.append(
                {
                    "code": "english_name",
                    "status": "needs_human",
                    "product_id": product.id,
                }
            )
        product_ready = not field_gaps and has_image and has_english_name
        needs_human = needs_human or not product_ready
        products.append(
            {
                **validation,
                "status": "ready" if product_ready else "needs_human",
            }
        )

    data_readiness = "not_ready" if needs_human else "ready"
    return {
        "status": "needs_human" if needs_human else "ready_for_generation",
        "quality_scope": "data_readiness",
        "data_readiness": data_readiness,
        "artifacts_generated": False,
        "scope": scope,
        "checks": checks,
        "products": products,
    }


def _compose_generation_intent(
    _context: WorkflowContext,
) -> list[dict[str, Any]]:
    return [
        {
            "artifact_type": "english_catalog",
            "format": "html",
            "status": "planned",
            "artifacts_generated": False,
        },
        {
            "artifact_type": "sample_checklist",
            "format": "csv",
            "status": "planned",
            "artifacts_generated": False,
        },
    ]


_TOOL_DEFINITIONS: dict[str, ToolDefinition] = {
    "read_workflow_task": make_tool_definition("read_workflow_task", _read_workflow_task),
    "read_batch_products": make_tool_definition("read_batch_products", _read_batch_products),
    "read_current_revisions": make_tool_definition("read_current_revisions", _read_current_revisions),
    "read_confirmed_revisions": make_tool_definition("read_confirmed_revisions", _read_confirmed_revisions),
    "read_task_files": make_tool_definition("read_task_files", _read_task_files),
    "match_image_candidates": make_tool_definition("match_image_candidates", _match_image_candidates),
    "validate_product_data": make_tool_definition("validate_product_data", _validate_product_data),
    "check_data_readiness": make_tool_definition("check_data_readiness", _check_data_readiness),
    "compose_generation_intent": make_tool_definition("compose_generation_intent", _compose_generation_intent),
}
