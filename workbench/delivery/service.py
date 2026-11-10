from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from django.db import transaction
from django.utils import timezone

from workbench.business_urls import public_url
from workbench.models import (
    Artifact,
    ArtifactVersion,
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
from workbench.workflows.events import record_workflow_event
from workbench.workflows.states import transition_workflow

from .catalog import EnglishNameRequired, build_catalog_html, build_catalog_markdown
from .checklist import build_checklist_csv, build_checklist_json
from .quality import (
    DeliveryQualityError,
    check_delivery_files,
    read_quality_report,
    write_quality_report,
)
from .storage import (
    DELIVERY_FILES,
    DeliveryStorageError,
    artifact_root,
    create_staging_directory,
    publish_staging_directory,
    read_task_image,
    resolve_artifact_file,
    stored_file_path,
    write_staging_files,
)


class DeliveryConflict(ValueError):
    pass


class DeliveryNotFound(LookupError):
    pass


class DeliveryGenerationError(RuntimeError):
    pass


MAX_GENERATION_ATTEMPTS = 3
GENERATION_RECOVERY_KEY = "generation_recovery"


@dataclass(frozen=True)
class SourceBundle:
    products: tuple[dict[str, Any], ...]
    revisions: tuple[dict[str, Any], ...]
    files: tuple[dict[str, Any], ...]

    def snapshot(self) -> dict[str, Any]:
        return {
            "workflow_task_id": self.products[0]["workflow_task_id"],
            "batch_id": self.products[0]["batch_id"],
            "product_ids": [item["product_id"] for item in self.products],
            "revisions": list(self.revisions),
            "task_files": list(self.files),
            "products": [
                {
                    "product_id": item["product_id"],
                    "revision_id": item["revision_id"],
                    "version": item["version"],
                    "snapshot": item["snapshot"],
                    "task_file_id": item["task_file_id"],
                    "filename": item["filename"],
                    "stored_name": item["stored_name"],
                }
                for item in self.products
            ],
        }


def _canonical_json(value: Any) -> str:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def _fingerprint(value: Any) -> str:
    return hashlib.sha256(_canonical_json(value).encode("utf-8")).hexdigest()


def _latest_step(workflow: WorkflowTask) -> WorkflowStep | None:
    return (
        WorkflowStep.objects.filter(task=workflow, step_key="generate_deliverables")
        .order_by("-attempt", "-created_at", "-id")
        .first()
    )


def _step_source_ids(step: WorkflowStep, key: str) -> list[str]:
    raw = step.input_refs.get(key, []) if isinstance(step.input_refs, dict) else []
    if not isinstance(raw, list) or any(not isinstance(item, str) for item in raw):
        raise DeliveryConflict("生成步骤来源引用无效")
    return raw


def _lock_sources(workflow: WorkflowTask) -> SourceBundle:
    """Lock source rows in Workflow → Task → Product → Revision → TaskFile order."""
    batch = Task.objects.select_for_update().get(pk=workflow.batch_id)
    if batch.status != "confirmed":
        raise DeliveryConflict("批次尚未确认")
    products = list(
        Product.objects.select_for_update()
        .filter(task_id=batch.id)
        .order_by("id")
    )
    if not products:
        raise DeliveryConflict("空批次不能生成交付物")

    revisions: dict[str, ProductRevision] = {}
    for product in products:
        revision = (
            ProductRevision.objects.select_for_update()
            .filter(product_id=product.id)
            .order_by("-version")
            .first()
        )
        if revision is None or revision.status != "confirmed":
            raise DeliveryConflict("全批次必须拥有当前已确认产品版本")
        revisions[product.id] = revision

    task_file_ids = []
    for revision in revisions.values():
        image = revision.source_refs.get("image") if isinstance(revision.source_refs, dict) else None
        file_id = image.get("task_file_id") if isinstance(image, dict) else None
        if not isinstance(file_id, str) or not file_id:
            raise DeliveryConflict("已确认版本缺少图片来源引用")
        task_file_ids.append(file_id)
    task_file_ids = sorted(set(task_file_ids))
    files_by_id = {
        item.id: item
        for item in TaskFile.objects.select_for_update()
        .filter(id__in=task_file_ids)
        .order_by("id")
    }
    if len(files_by_id) != len(task_file_ids):
        raise DeliveryConflict("已确认图片来源不存在")

    subtasks = {
        item.agent_role: item
        for item in SubTask.objects.select_for_update()
        .filter(task=workflow)
        .order_by("id")
    }
    if set(subtasks) != {"product_profile", "delivery_quality"} or any(
        item.status != "completed" for item in subtasks.values()
    ):
        raise DeliveryConflict("产品资料与交付就绪子任务必须先完成")
    if HumanReview.objects.filter(task=workflow, status__in=["pending", "submitted"]).exists():
        raise DeliveryConflict("存在未解决的人审事项，不能生成交付文件")

    ids = [item.id for item in products]
    revision_ids = [revisions[item.id].id for item in products]
    revision_versions = [revisions[item.id].version for item in products]
    if len(set(ids)) != len(ids) or len(set(revision_ids)) != len(revision_ids):
        raise DeliveryConflict("批次产品或版本引用不唯一")

    plan_step = WorkflowStep.objects.filter(
        task=workflow, step_key="center_plan", status="completed"
    ).order_by("-created_at", "-id").first()
    plan = plan_step.output_refs.get("plan") if plan_step and isinstance(plan_step.output_refs, dict) else None
    plan_refs = plan.get("source_refs", {}).get("product_revisions") if isinstance(plan, dict) else None
    if not isinstance(plan_refs, list):
        raise DeliveryConflict("已保存计划缺少产品版本来源")
    plan_map = {row.get("product_id"): row for row in plan_refs if isinstance(row, dict)}
    if set(plan_map) != set(ids) or any(
        plan_map[item.id].get("revision_id") != revisions[item.id].id
        or plan_map[item.id].get("revision_version") != revisions[item.id].version
        or plan_map[item.id].get("revision_status") != "confirmed"
        for item in products
    ):
        raise DeliveryConflict("产品版本已不同于工作流计划来源，请新建计划")

    product_subtask = subtasks["product_profile"]
    delivery_subtask = subtasks["delivery_quality"]
    product_inputs = product_subtask.input_refs if isinstance(product_subtask.input_refs, dict) else {}
    delivery_inputs = delivery_subtask.input_refs if isinstance(delivery_subtask.input_refs, dict) else {}
    if (
        product_inputs.get("scope") != "full_batch"
        or set(product_inputs.get("product_ids", [])) != set(ids)
        or set(product_inputs.get("product_revision_ids", [])) != set(revision_ids)
        or delivery_inputs.get("scope") != "full_batch"
        or set(delivery_inputs.get("all_product_ids", [])) != set(ids)
        or set(delivery_inputs.get("all_revision_ids", [])) != set(revision_ids)
        or set(delivery_inputs.get("confirmed_revision_ids", [])) != set(revision_ids)
        or delivery_inputs.get("unconfirmed_product_ids") != []
        or delivery_inputs.get("requires_all_products_confirmed") is not True
    ):
        raise DeliveryConflict("角色输入来源与当前全批次版本不一致")

    product_output = product_subtask.output_refs if isinstance(product_subtask.output_refs, dict) else {}
    product_result = product_output.get("result")
    product_rows = product_result.get("products") if isinstance(product_result, dict) else None
    if not isinstance(product_rows, list) or len(product_rows) != len(products):
        raise DeliveryConflict("产品资料结果没有覆盖完整批次")
    product_result_map = {row.get("product_id"): row for row in product_rows if isinstance(row, dict)}
    if set(product_result_map) != set(ids):
        raise DeliveryConflict("产品资料结果产品范围不一致")

    delivery_output = delivery_subtask.output_refs if isinstance(delivery_subtask.output_refs, dict) else {}
    delivery_result = delivery_output.get("result")
    scope = delivery_result.get("scope") if isinstance(delivery_result, dict) else None
    if (
        not isinstance(delivery_result, dict)
        or delivery_result.get("status") != "ready_for_generation"
        or delivery_result.get("data_readiness") != "ready"
        or delivery_result.get("quality_scope") != "data_readiness"
        or delivery_result.get("artifacts_generated") is not False
        or not isinstance(scope, dict)
        or set(scope.get("all_product_ids", [])) != set(ids)
        or set(scope.get("confirmed_revision_ids", [])) != set(revision_ids)
        or scope.get("unconfirmed_product_ids") != []
    ):
        raise DeliveryConflict("交付角色没有为当前来源报告 ready_for_generation")

    file_snapshots = []
    products_snapshot = []
    for product in sorted(products, key=lambda item: (item.position, item.id)):
        revision = revisions[product.id]
        source_snapshot = revision.snapshot if isinstance(revision.snapshot, dict) else {}
        english_name = source_snapshot.get("english_name")
        if not isinstance(english_name, str) or not english_name.strip():
            raise DeliveryConflict("当前已确认版本缺少英文名；请先完成现有交付就绪人审")
        product_result_row = product_result_map[product.id]
        result_revision = product_result_row.get("current_revision")
        if (
            not isinstance(result_revision, dict)
            or result_revision.get("revision_id") != revision.id
            or result_revision.get("version") != revision.version
            or result_revision.get("snapshot") != source_snapshot
            or product_result_row.get("status") != "candidate"
        ):
            raise DeliveryConflict("产品资料结果与当前已确认版本不一致")

        image_ref = revision.source_refs.get("image")
        task_file = files_by_id[image_ref["task_file_id"]]
        if task_file.task_id != batch.id or task_file.kind != "image":
            raise DeliveryConflict("图片 TaskFile 不属于当前批次")
        if task_file.stored_name != image_ref.get("stored_name"):
            raise DeliveryConflict("图片 TaskFile 存储引用已变化")
        if task_file.original_name != source_snapshot.get("image_filename"):
            raise DeliveryConflict("图片原名与已确认版本不一致")

        readiness_products = delivery_result.get("products")
        readiness_row = next(
            (item for item in readiness_products if isinstance(item, dict) and item.get("product_id") == product.id),
            None,
        ) if isinstance(readiness_products, list) else None
        candidate_ids = {
            item.get("task_file_id")
            for item in (readiness_row or {}).get("image_candidates", [])
            if isinstance(item, dict)
        }
        if candidate_ids != {task_file.id}:
            raise DeliveryConflict("交付就绪图片来源与已确认图片不一致")

        file_snapshots.append(
            {
                "task_file_id": task_file.id,
                "kind": task_file.kind,
                "original_name": task_file.original_name,
                "stored_name": task_file.stored_name,
            }
        )
        products_snapshot.append(
            {
                "workflow_task_id": workflow.id,
                "batch_id": batch.id,
                "product_id": product.id,
                "revision_id": revision.id,
                "version": revision.version,
                "snapshot": source_snapshot,
                "task_file_id": task_file.id,
                "filename": task_file.original_name,
                "stored_name": task_file.stored_name,
            }
        )

    return SourceBundle(
        products=tuple(products_snapshot),
        revisions=tuple(
            {
                "product_id": product.id,
                "revision_id": revisions[product.id].id,
                "version": revisions[product.id].version,
                "snapshot": revisions[product.id].snapshot,
            }
            for product in sorted(products, key=lambda item: (item.position, item.id))
        ),
        files=tuple(file_snapshots),
    )


def _load_product_images(source: SourceBundle) -> list[dict[str, Any]]:
    result = []
    for item in source.products:
        try:
            content, mime_type, sha256 = read_task_image(item["stored_name"], item["filename"])
        except (OSError, DeliveryStorageError) as exc:
            raise DeliveryGenerationError("已确认图片缺失或格式不受支持") from exc
        result.append(
            {
                "product_id": item["product_id"],
                "revision_id": item["revision_id"],
                "version": item["version"],
                "snapshot": item["snapshot"],
                "image": {
                    "task_file_id": item["task_file_id"],
                    "filename": item["filename"],
                    "stored_name": item["stored_name"],
                    "sha256": sha256,
                    "mime_type": mime_type,
                    "content": content,
                },
            }
        )
    return result


def _source_image_hashes(products: list[dict[str, Any]]) -> list[dict[str, str]]:
    return [
        {
            "task_file_id": row["image"]["task_file_id"],
            "stored_name": row["image"]["stored_name"],
            "sha256": row["image"]["sha256"],
        }
        for row in products
    ]


def _source_matches(first: dict[str, Any], current: SourceBundle) -> bool:
    original = {key: first.get(key) for key in ("workflow_task_id", "batch_id", "product_ids", "revisions", "task_files", "products")}
    return original == current.snapshot()


def _generation_request_key(value: Any) -> str:
    if not isinstance(value, str) or not value.strip() or len(value) > 200:
        raise DeliveryConflict("idempotency_key 必须是 1–200 字符的非空字符串")
    return value.strip()


def _version_snapshot(
    *, workflow: WorkflowTask, step: WorkflowStep, source: SourceBundle,
    quality_report: dict[str, Any], image_hashes: list[dict[str, str]],
) -> dict[str, Any]:
    frozen = source.snapshot()
    image_hashes_by_id = {
        item["task_file_id"]: item["sha256"] for item in image_hashes
    }
    frozen["task_files"] = [
        {**item, "sha256": image_hashes_by_id[item["task_file_id"]]}
        for item in frozen["task_files"]
    ]
    frozen["products"] = [
        {**item, "image_sha256": image_hashes_by_id[item["task_file_id"]]}
        for item in frozen["products"]
    ]
    frozen.update(
        {
            "generation_step_id": step.id,
            "quality_report": quality_report,
        }
    )
    return frozen


def _record_generation_failure(workflow_id: str, step_id: str, code: str) -> None:
    with transaction.atomic():
        workflow = WorkflowTask.objects.select_for_update().filter(pk=workflow_id).first()
        step = WorkflowStep.objects.select_for_update().filter(pk=step_id, task_id=workflow_id).first()
        if workflow is None or step is None or step.status != "running":
            return
        step.status = "failed"
        step.finished_at = timezone.now()
        step.error_summary = "交付文件生成失败，来源或文件质检未通过。"
        step.output_refs = {"failure_code": code, "outcome_unknown": False}
        step.save(update_fields=["status", "finished_at", "error_summary", "output_refs", "updated_at"])
        workflow.error_summary = step.error_summary
        workflow.current_step = "generate_deliverables_failed"
        workflow.save(update_fields=["error_summary", "current_step", "updated_at"])
        if workflow.status == "running":
            transition_workflow(workflow, "failed", actor="delivery")
        record_workflow_event(
            workflow=workflow,
            event_type="delivery_generation_failed",
            actor="delivery",
            refs={"workflow_step_id": step.id, "failure_code": code},
            summary="delivery generation failed",
        )


def _takeover_payload(
    *, expected_step_id: Any, decision: Any, idempotency_key: Any,
    operator_label: Any, note: Any,
) -> dict[str, str]:
    values = {
        "expected_step_id": expected_step_id,
        "decision": decision,
        "idempotency_key": idempotency_key,
        "operator_label": operator_label,
        "note": note,
    }
    if (
        not all(isinstance(value, str) for value in values.values())
        or not expected_step_id
        or len(expected_step_id) > 32
        or decision != "outcome_unknown"
        or not idempotency_key.strip()
        or len(idempotency_key) > 200
        or not operator_label.strip()
        or len(operator_label) > 120
        or len(note) > 1000
    ):
        raise DeliveryConflict("接管请求字段无效")
    return values


def take_over_generation(
    workflow_id: str, *, expected_step_id: Any, decision: Any,
    idempotency_key: Any, operator_label: Any, note: Any,
) -> dict[str, Any]:
    payload = _takeover_payload(
        expected_step_id=expected_step_id,
        decision=decision,
        idempotency_key=idempotency_key,
        operator_label=operator_label,
        note=note,
    )
    with transaction.atomic():
        try:
            workflow = WorkflowTask.objects.select_for_update().get(pk=workflow_id)
        except WorkflowTask.DoesNotExist as exc:
            raise DeliveryNotFound("工作流不存在") from exc

        # Receipt replay is checked before current-state eligibility so a lost
        # response remains resolvable after later attempts have started.
        steps = list(
            WorkflowStep.objects.select_for_update()
            .filter(task=workflow, step_key="generate_deliverables")
            .order_by("attempt", "created_at", "id")
        )
        for prior in steps:
            prior_refs = prior.output_refs if isinstance(prior.output_refs, dict) else {}
            recovery = prior_refs.get(GENERATION_RECOVERY_KEY, {})
            receipts = recovery.get("takeover_receipts", {}) if isinstance(recovery, dict) else {}
            saved = receipts.get(idempotency_key) if isinstance(receipts, dict) else None
            if saved is None:
                continue
            if not isinstance(saved, dict) or saved.get("payload") != payload:
                raise DeliveryConflict("接管幂等键已用于不同请求")
            return {**saved["response"], "replayed": True}

        latest = steps[-1] if steps else None
        unresolved = HumanReview.objects.filter(task=workflow, status__in=["pending", "submitted"]).exists()
        if (
            latest is None
            or latest.id != expected_step_id
            or latest.status != "running"
            or workflow.status != "running"
            or workflow.current_step != "generate_deliverables"
            or unresolved
        ):
            raise DeliveryConflict("当前没有可接管的交付生成尝试")

        now = timezone.now()
        response = {
            "workflow_task_id": workflow.id,
            "step_id": latest.id,
            "status": "failed",
            "outcome_unknown": True,
            "replayed": False,
        }
        current_refs = latest.output_refs if isinstance(latest.output_refs, dict) else {}
        recovery = current_refs.get(GENERATION_RECOVERY_KEY, {})
        recovery = recovery if isinstance(recovery, dict) else {}
        receipts = recovery.get("takeover_receipts", {})
        receipts = receipts if isinstance(receipts, dict) else {}
        receipts[idempotency_key] = {"payload": payload, "response": response}
        latest.output_refs = {
            **current_refs,
            GENERATION_RECOVERY_KEY: {
                **recovery,
                "outcome_unknown": True,
                "decision": decision,
                "operator_label": operator_label,
                "note": note,
                "takeover_receipts": receipts,
            },
        }
        latest.status = "failed"
        latest.finished_at = now
        latest.error_summary = "交付生成尝试已由操作人接管，外部结果未知。"
        latest.save(update_fields=["status", "finished_at", "error_summary", "output_refs", "updated_at"])
        workflow.error_summary = latest.error_summary
        workflow.current_step = "generate_deliverables_failed"
        workflow.save(update_fields=["error_summary", "current_step", "updated_at"])
        transition_workflow(workflow, "failed", actor="delivery")
        record_workflow_event(
            workflow=workflow,
            event_type="delivery_generation_taken_over",
            actor="operator",
            from_status="running",
            to_status="failed",
            refs={
                "workflow_step_id": latest.id,
                "decision": decision,
                "idempotency_key": idempotency_key,
                "operator_label": operator_label,
                "outcome_unknown": True,
            },
            summary="delivery generation outcome marked unknown and attempt sealed",
        )
        return response


def _consecutive_generation_failures(steps: list[WorkflowStep]) -> int:
    failures = 0
    for step in reversed(steps):
        if step.status != "failed":
            break
        failures += 1
    return failures


def _claim_generation(workflow_id: str, idempotency_key: str) -> tuple[WorkflowStep, SourceBundle, bool]:
    with transaction.atomic():
        try:
            workflow = WorkflowTask.objects.select_for_update().get(pk=workflow_id)
        except WorkflowTask.DoesNotExist as exc:
            raise DeliveryNotFound("工作流不存在") from exc
        keyed = WorkflowStep.objects.filter(task=workflow, idempotency_key=idempotency_key).first()
        if keyed:
            if keyed.step_key != "generate_deliverables":
                raise DeliveryConflict("幂等键已用于其他步骤")
            if keyed.status == "running":
                raise DeliveryConflict("交付文件仍在生成，请稍后刷新")
            if keyed.status == "completed" and keyed.output_refs.get("quality_status") == "passed":
                return keyed, SourceBundle((), (), ()), True
            raise DeliveryConflict("相同幂等键对应的生成步骤已失败，需使用新幂等键")

        previous = _latest_step(workflow)
        unresolved = HumanReview.objects.filter(task=workflow, status__in=["pending", "submitted"]).exists()
        if unresolved:
            raise DeliveryConflict("存在未解决的业务审核，不能生成交付文件")
        if previous and previous.status == "running":
            raise DeliveryConflict("上一交付生成步骤状态仍在运行，不能自动接管")
        if workflow.status == "waiting_human":
            raise DeliveryConflict("当前工作流正在等待审核")
        if previous is None:
            if workflow.status != "running" or workflow.current_step != "generate_deliverables":
                raise DeliveryConflict("工作流尚未到达交付生成步骤")
        elif previous.status == "failed":
            if workflow.status != "failed" or workflow.current_step != "generate_deliverables_failed":
                raise DeliveryConflict("只有交付生成失败可由交付步骤恢复")
            recent_generation_steps = list(
                WorkflowStep.objects.filter(task=workflow, step_key="generate_deliverables")
                .order_by("attempt", "created_at", "id")
            )
            if _consecutive_generation_failures(recent_generation_steps) >= MAX_GENERATION_ATTEMPTS:
                raise DeliveryConflict("交付生成错误重试额度已用完，请人工处理")
            if any(item.status != "completed" for item in workflow.subtasks.all()):
                raise DeliveryConflict("业务子任务状态已变化，不能恢复生成")
            transition_workflow(workflow, "queued", actor="delivery")
            transition_workflow(workflow, "running", actor="delivery")
        elif previous.status == "completed":
            if workflow.status != "running" or workflow.current_step != "deliverables_rejected":
                raise DeliveryConflict("仅被驳回的当前交付版本允许重新生成")
            rejected = EventLog.objects.filter(
                task=workflow,
                event_type="delivery_bundle_reviewed",
                payload_summary__refs__generation_step_id=previous.id,
                payload_summary__refs__decision="reject",
            ).exists()
            if not rejected:
                raise DeliveryConflict("当前交付版本尚未被驳回")
        else:
            raise DeliveryConflict("工作流当前状态不能生成新的交付版本")

        source = _lock_sources(workflow)
        attempt = (previous.attempt + 1) if previous else 1
        step = WorkflowStep.objects.create(
            task=workflow,
            step_key="generate_deliverables",
            status="running",
            attempt=attempt,
            idempotency_key=idempotency_key,
            input_refs={"source_snapshot": source.snapshot()},
            started_at=timezone.now(),
        )
        workflow.current_step = "generate_deliverables"
        workflow.error_summary = ""
        workflow.save(update_fields=["current_step", "error_summary", "updated_at"])
        record_workflow_event(
            workflow=workflow,
            event_type="delivery_generation_started",
            actor="delivery",
            refs={"workflow_step_id": step.id, "attempt": attempt},
            summary="delivery generation started",
        )
        return step, source, False


def generate_deliverables(workflow_id: str, idempotency_key: str) -> dict[str, Any]:
    key = _generation_request_key(idempotency_key)
    step, claimed_source, replay = _claim_generation(workflow_id, key)
    if replay:
        return _generation_result(step, replayed=True)
    staging: Path | None = None
    published = False
    try:
        products = _load_product_images(claimed_source)
        image_hashes = _source_image_hashes(products)
        with transaction.atomic():
            workflow = WorkflowTask.objects.select_for_update().get(pk=workflow_id)
            current_step = WorkflowStep.objects.select_for_update().get(pk=step.id)
            if current_step.status != "running" or current_step.idempotency_key != key:
                raise DeliveryConflict("交付生成 claim 已变化")
            current_step.input_refs = {
                **current_step.input_refs,
                "image_sources": image_hashes,
            }
            current_step.save(update_fields=["input_refs", "updated_at"])

        data = {
            "catalog_html": build_catalog_html(products).encode("utf-8"),
            "catalog_markdown": build_catalog_markdown(products).encode("utf-8"),
            "sample_checklist_csv": build_checklist_csv(products).encode("utf-8"),
            "sample_checklist_json": build_checklist_json(products).encode("utf-8"),
        }
        staging, final = create_staging_directory(workflow_id, step.id)
        # quality.json is created after checks so it never hashes itself.
        write_staging_files(staging, data)
        quality_report = check_delivery_files(products, staging)
        write_quality_report(staging, quality_report)
        read_quality_report(staging)

        fresh_products = _load_product_images(claimed_source)
        if _source_image_hashes(fresh_products) != image_hashes:
            raise DeliveryConflict("图片来源字节在生成期间发生变化")
        # File publication is atomic within the configured filesystem. The DB
        # registration below is a separate transaction and is not claimed to
        # be atomic with this rename.
        publish_staging_directory(staging, final)
        published = True

        files_on_disk: dict[str, tuple[str, str]] = {}
        for artifact_type, filename in DELIVERY_FILES.items():
            path = final / filename
            content = path.read_bytes()
            files_on_disk[artifact_type] = (
                stored_file_path(workflow_id, step.id, filename),
                hashlib.sha256(content).hexdigest(),
            )

        with transaction.atomic():
            workflow = WorkflowTask.objects.select_for_update().get(pk=workflow_id)
            current_step = WorkflowStep.objects.select_for_update().get(pk=step.id)
            if (
                current_step.status != "running"
                or current_step.idempotency_key != key
                or _latest_step(workflow).id != step.id
            ):
                raise DeliveryConflict("交付生成 claim 已变化")
            current_source = _lock_sources(workflow)
            if not _source_matches(current_step.input_refs["source_snapshot"], current_source):
                raise DeliveryConflict("产品、版本或文件引用在生成期间发生变化")
            if current_step.input_refs.get("image_sources") != image_hashes:
                raise DeliveryConflict("生成步骤图片来源哈希不一致")
            version_snapshot = _version_snapshot(
                workflow=workflow,
                step=current_step,
                source=current_source,
                quality_report=quality_report,
                image_hashes=image_hashes,
            )
            versions = []
            by_type = {}
            for artifact_type, filename in DELIVERY_FILES.items():
                artifact = (
                    Artifact.objects.select_for_update()
                    .filter(task=workflow, artifact_type=artifact_type)
                    .first()
                )
                if artifact is None:
                    artifact = Artifact.objects.create(
                        task=workflow,
                        artifact_type=artifact_type,
                        storage_key=f"{workflow.id}/{artifact_type}",
                        current_version=0,
                        status="pending_review",
                    )
                version_number = artifact.current_version + 1
                path, digest = files_on_disk[artifact_type]
                version = ArtifactVersion.objects.create(
                    artifact=artifact,
                    version=version_number,
                    file_path=path,
                    sha256=digest,
                    source_product_versions=list(current_source.revisions),
                    snapshot=version_snapshot,
                    status="pending_review",
                )
                artifact.current_version = version_number
                artifact.status = "pending_review"
                artifact.save(update_fields=["current_version", "status", "updated_at"])
                versions.append(version)
                by_type[artifact_type] = version

            current_step.status = "completed"
            current_step.finished_at = timezone.now()
            current_step.output_refs = {
                "quality_status": "passed",
                "artifact_version_ids": [version.id for version in versions],
                "artifact_versions": {
                    artifact_type: version.id for artifact_type, version in by_type.items()
                },
                "quality_report": quality_report,
                "source_product_versions": list(current_source.revisions),
                "source_task_file_ids": [item["task_file_id"] for item in image_hashes],
            }
            current_step.save(update_fields=["status", "finished_at", "output_refs", "updated_at"])
            workflow.result_refs = {
                **workflow.result_refs,
                "delivery_bundle_step_id": current_step.id,
                "delivery_version_ids": [version.id for version in versions],
                "delivery_quality_status": "passed",
            }
            workflow.current_step = "review_deliverables"
            workflow.save(update_fields=["result_refs", "current_step", "updated_at"])
            transition_workflow(workflow, "waiting_human", actor="delivery")
            record_workflow_event(
                workflow=workflow,
                event_type="delivery_generation_completed",
                actor="delivery",
                from_status="running",
                to_status="waiting_human",
                refs={
                    "workflow_step_id": current_step.id,
                    "artifact_version_ids": [version.id for version in versions],
                    "quality_status": "passed",
                },
                summary="delivery bundle ready for review",
            )
        return _generation_result(current_step, replayed=False)
    except EnglishNameRequired as exc:
        _record_generation_failure(workflow_id, step.id, "english_name_missing")
        raise DeliveryConflict("已确认版本与交付就绪结果不一致；请处理现有英文名审核") from exc
    except DeliveryConflict as exc:
        _record_generation_failure(workflow_id, step.id, type(exc).__name__)
        raise
    except (DeliveryStorageError, DeliveryQualityError) as exc:
        _record_generation_failure(workflow_id, step.id, type(exc).__name__)
        raise DeliveryGenerationError("交付文件生成或质检失败") from exc
    except Exception as exc:
        if not published:
            _record_generation_failure(workflow_id, step.id, type(exc).__name__)
            raise DeliveryGenerationError("交付文件生成失败") from exc
        # A database failure after publication may have committed or rolled
        # back. Keep the running claim and files for reconciliation; never
        # delete files which might already be registered.
        raise DeliveryConflict("交付文件已生成，登记结果待核对；请勿自动重试") from exc


def _generation_result(step: WorkflowStep, *, replayed: bool) -> dict[str, Any]:
    return {
        "workflow_task_id": step.task_id,
        "step_id": step.id,
        "status": step.status,
        "quality_status": step.output_refs.get("quality_status"),
        "artifact_version_ids": step.output_refs.get("artifact_version_ids", []),
        "replayed": replayed,
    }


def _step_versions(workflow: WorkflowTask, step_id: str) -> dict[str, ArtifactVersion]:
    try:
        step = WorkflowStep.objects.get(pk=step_id, task=workflow, step_key="generate_deliverables")
    except WorkflowStep.DoesNotExist as exc:
        raise DeliveryNotFound("交付版本不存在") from exc
    ids = step.output_refs.get("artifact_version_ids", []) if isinstance(step.output_refs, dict) else []
    versions = list(
        ArtifactVersion.objects.select_related("artifact")
        .filter(id__in=ids, artifact__task=workflow)
        .order_by("artifact__artifact_type")
    )
    result = {item.artifact.artifact_type: item for item in versions}
    if step.status != "completed" or len(result) != len(DELIVERY_FILES) or set(result) != set(DELIVERY_FILES):
        raise DeliveryConflict("交付版本未完整登记")
    return result


def _current_source_and_images(workflow_id: str) -> tuple[WorkflowTask, SourceBundle, list[dict[str, Any]]]:
    try:
        workflow = WorkflowTask.objects.select_related("batch").get(pk=workflow_id)
    except WorkflowTask.DoesNotExist as exc:
        raise DeliveryNotFound("工作流不存在") from exc
    with transaction.atomic():
        locked_workflow = WorkflowTask.objects.select_for_update().get(pk=workflow.id)
        source = _lock_sources(locked_workflow)
    return workflow, source, _load_product_images(source)


def _step_for_bundle(workflow: WorkflowTask, step_id: str | None = None) -> WorkflowStep:
    step = (
        WorkflowStep.objects.filter(task=workflow, step_key="generate_deliverables")
        .order_by("-attempt", "-created_at", "-id")
        .first()
    )
    if step is None or (step_id is not None and step.id != step_id):
        raise DeliveryConflict("指定的交付包不是当前版本")
    return step


def _verify_bundle_files(workflow: WorkflowTask, step: WorkflowStep, products: list[dict[str, Any]], expected_status: str | None = None) -> tuple[dict[str, ArtifactVersion], dict[str, Any]]:
    versions = _step_versions(workflow, step.id)
    if expected_status and any(item.status != expected_status for item in versions.values()):
        raise DeliveryConflict("交付包状态不符合当前操作")
    directories = {Path(item.file_path).parent.as_posix() for item in versions.values()}
    if len(directories) != 1:
        raise DeliveryConflict("交付版本文件不属于同一生成批次")
    try:
        directory = resolve_artifact_file(next(iter(versions.values())).file_path).parent
    except (FileNotFoundError, DeliveryStorageError) as exc:
        raise DeliveryConflict("交付文件缺失或路径不可用") from exc
    expected_source_versions = step.output_refs.get("source_product_versions", [])
    for artifact_type, filename in DELIVERY_FILES.items():
        version = versions[artifact_type]
        if Path(version.file_path).name != filename:
            raise DeliveryConflict("ArtifactVersion 文件名不符合固定格式")
        if version.source_product_versions != expected_source_versions:
            raise DeliveryConflict("ArtifactVersion 来源版本不一致")
        try:
            path = resolve_artifact_file(version.file_path)
            content = path.read_bytes()
        except (OSError, DeliveryStorageError) as exc:
            raise DeliveryConflict("交付文件缺失或路径不可用") from exc
        if hashlib.sha256(content).hexdigest() != version.sha256:
            raise DeliveryConflict("交付文件缺失或内容哈希已变化")
    try:
        report = check_delivery_files(products, directory)
        saved_report = read_quality_report(directory)
    except (DeliveryQualityError, OSError, DeliveryStorageError) as exc:
        raise DeliveryConflict("交付文件或质检报告不可用") from exc
    if saved_report != report or step.output_refs.get("quality_report") != report:
        raise DeliveryConflict("交付质检报告与当前文件不一致")
    try:
        report_bytes = (directory / DELIVERY_FILES["quality_report_json"]).read_bytes()
    except OSError as exc:
        raise DeliveryConflict("质检报告缺失或不可用") from exc
    if versions["quality_report_json"].sha256 != hashlib.sha256(report_bytes).hexdigest():
        raise DeliveryConflict("质检报告哈希不一致")
    return versions, report


def verify_current_bundle(workflow_id: str, expected_status: str | None = None) -> tuple[WorkflowTask, WorkflowStep, dict[str, ArtifactVersion], dict[str, Any]]:
    try:
        workflow, source, products = _current_source_and_images(workflow_id)
    except DeliveryGenerationError as exc:
        raise DeliveryConflict("当前图片来源文件不可用") from exc
    step = _step_for_bundle(workflow)
    if not _source_matches(step.input_refs.get("source_snapshot", {}), source):
        raise DeliveryConflict("当前产品版本与交付包来源不同")
    if step.input_refs.get("image_sources") != _source_image_hashes(products):
        raise DeliveryConflict("当前图片字节与交付包来源不同")
    versions, report = _verify_bundle_files(workflow, step, products, expected_status)
    return workflow, step, versions, report


def _bundle_decision_event(workflow: WorkflowTask, step_id: str) -> EventLog | None:
    return EventLog.objects.filter(
        task=workflow,
        event_type="delivery_bundle_reviewed",
        payload_summary__refs__generation_step_id=step_id,
    ).order_by("created_at", "id").first()


def _delivery_review_summary(workflow: WorkflowTask, step: WorkflowStep | None) -> dict[str, Any] | None:
    if step is None or step.status != "completed":
        return None
    event = _bundle_decision_event(workflow, step.id)
    if event is None:
        return None
    payload = event.payload_summary if isinstance(event.payload_summary, dict) else {}
    refs = payload.get("refs") if isinstance(payload.get("refs"), dict) else {}
    version_ids = refs.get("artifact_version_ids")
    decision = refs.get("decision")
    reviewer = refs.get("reviewer")
    if (
        decision not in {"approve", "reject"}
        or not isinstance(reviewer, str)
        or not isinstance(version_ids, list)
        or any(not isinstance(version_id, str) for version_id in version_ids)
    ):
        return None
    return {
        "scope": "delivery_bundle",
        "generation_step_id": step.id,
        "event_id": event.id,
        "decision": decision,
        "reviewer": reviewer,
        "reviewed_at": event.created_at.isoformat(),
        "artifact_version_ids": version_ids,
    }


def review_delivery_bundle(
    workflow_id: str,
    step_id: str,
    *,
    decision: str,
    reviewer: str,
    note: str = "",
) -> dict[str, Any]:
    if not isinstance(decision, str) or decision not in {"approve", "reject"}:
        raise DeliveryConflict("decision 只能为 approve 或 reject")
    if not isinstance(reviewer, str) or not reviewer.strip() or len(reviewer) > 120:
        raise DeliveryConflict("reviewer 必须为 1–120 字符的本地标签")
    if not isinstance(note, str) or len(note) > 1000:
        raise DeliveryConflict("note 最多 1000 个字符")
    payload = {"decision": decision, "reviewer": reviewer.strip(), "note": note.strip()}
    fingerprint = _fingerprint(payload)

    try:
        prior_workflow = WorkflowTask.objects.get(pk=workflow_id)
    except WorkflowTask.DoesNotExist as exc:
        raise DeliveryNotFound("工作流不存在") from exc
    prior_event = _bundle_decision_event(prior_workflow, step_id)
    if prior_event:
        refs = prior_event.payload_summary.get("refs", {})
        if refs.get("request_fingerprint") == fingerprint:
            return {
                "workflow_task_id": workflow_id,
                "step_id": step_id,
                "decision": refs.get("decision"),
                "replayed": True,
            }
        raise DeliveryConflict("交付包已审核，不能覆盖原决定")

    workflow, step, versions, _report = verify_current_bundle(
        workflow_id, expected_status="pending_review"
    )
    if step.id != step_id:
        raise DeliveryConflict("交付包已变化")

    with transaction.atomic():
        locked_workflow = WorkflowTask.objects.select_for_update().get(pk=workflow_id)
        prior = _bundle_decision_event(locked_workflow, step_id)
        if prior:
            refs = prior.payload_summary.get("refs", {})
            if refs.get("request_fingerprint") == fingerprint:
                return {"workflow_task_id": workflow_id, "step_id": step_id, "decision": refs.get("decision"), "replayed": True}
            raise DeliveryConflict("交付包已审核，不能覆盖原决定")
        if locked_workflow.status != "waiting_human" or locked_workflow.current_step != "review_deliverables":
            raise DeliveryConflict("工作流当前不处于交付审核阶段")
        if HumanReview.objects.filter(task=locked_workflow, status__in=["pending", "submitted"]).exists():
            raise DeliveryConflict("存在业务审核事项，交付审核不能批准事实或恢复该阶段")
        current_step = _step_for_bundle(locked_workflow, step_id)
        _assert_current_sources_locked(locked_workflow, current_step)
        locked_versions = list(
            ArtifactVersion.objects.select_for_update()
            .filter(id__in=current_step.output_refs.get("artifact_version_ids", []), artifact__task=locked_workflow)
            .select_related("artifact")
            .order_by("artifact__artifact_type", "id")
        )
        if len(locked_versions) != len(DELIVERY_FILES) or any(item.status != "pending_review" for item in locked_versions):
            raise DeliveryConflict("交付包版本状态已变化")
        for version in locked_versions:
            if version.artifact.current_version != version.version or version.artifact.status != "pending_review":
                raise DeliveryConflict("交付包不再是当前版本")
            version.status = "approved" if decision == "approve" else "rejected"
            version.save(update_fields=["status", "updated_at"])
            version.artifact.status = version.status
            version.artifact.save(update_fields=["status", "updated_at"])
        transition_workflow(locked_workflow, "running", actor="delivery_reviewer")
        locked_workflow.current_step = "complete_workflow" if decision == "approve" else "deliverables_rejected"
        locked_workflow.save(update_fields=["current_step", "updated_at"])
        EventLog.objects.create(
            task=locked_workflow,
            event_type="delivery_bundle_reviewed",
            actor="delivery_reviewer",
            payload_summary={
                "from_status": "pending_review",
                "to_status": "approved" if decision == "approve" else "rejected",
                "refs": {
                    "generation_step_id": step_id,
                    "artifact_version_ids": sorted(item.id for item in locked_versions),
                    "decision": decision,
                    "reviewer": payload["reviewer"],
                    "note": payload["note"],
                    "request_fingerprint": fingerprint,
                },
            },
        )
    return {"workflow_task_id": workflow_id, "step_id": step_id, "decision": decision, "replayed": False}


def _assert_current_sources_locked(workflow: WorkflowTask, step: WorkflowStep) -> None:
    source = _lock_sources(workflow)
    if not _source_matches(step.input_refs.get("source_snapshot", {}), source):
        raise DeliveryConflict("当前产品版本与批准交付包来源不同")
    if not WorkflowStep.objects.filter(
        task=workflow,
        step_key="generate_deliverables",
        id=step.id,
        status="completed",
        output_refs__quality_status="passed",
    ).exists():
        raise DeliveryConflict("真实交付 QA 证据不存在")


def completion_bundle_is_current(workflow: WorkflowTask, step_id: str) -> None:
    """Database-only confirmation used inside the explicit completion transaction."""
    step = WorkflowStep.objects.select_for_update().filter(
        pk=step_id, task=workflow, step_key="generate_deliverables", status="completed"
    ).first()
    if step is None:
        raise DeliveryConflict("当前交付 QA 证据不存在")
    _assert_current_sources_locked(workflow, step)
    versions = list(
        ArtifactVersion.objects.select_for_update()
        .filter(id__in=step.output_refs.get("artifact_version_ids", []), artifact__task=workflow)
        .select_related("artifact")
        .order_by("artifact__artifact_type", "id")
    )
    if len(versions) != len(DELIVERY_FILES) or any(
        version.status != "approved" or version.artifact.status != "approved"
        or version.artifact.current_version != version.version
        for version in versions
    ):
        raise DeliveryConflict("当前交付包必须完整批准")
    receipt = _bundle_decision_event(workflow, step.id)
    expected_ids = sorted(item.id for item in versions)
    refs = receipt.payload_summary.get("refs", {}) if receipt else {}
    if (
        receipt is None
        or refs.get("decision") != "approve"
        or refs.get("artifact_version_ids") != expected_ids
        or set(step.output_refs.get("artifact_version_ids", [])) != set(expected_ids)
    ):
        raise DeliveryConflict("当前交付包缺少绑定精确版本的批准回执")


def complete_workflow_with_deliverables(workflow_id: str) -> dict[str, Any]:
    try:
        historical = WorkflowTask.objects.get(pk=workflow_id)
    except WorkflowTask.DoesNotExist as exc:
        raise DeliveryNotFound("工作流不存在") from exc
    if historical.status == "completed":
        receipt = EventLog.objects.filter(
            task=historical,
            event_type="workflow_delivery_completed",
        ).first()
        if receipt:
            return {"workflow_task_id": historical.id, "status": historical.status, "replayed": True}
        raise DeliveryConflict("工作流已完成，但缺少交付完成回执")
    if historical.status != "running":
        raise DeliveryConflict(f"完成前要求 running 状态，当前为 {historical.status}")
    if historical.subtasks.exclude(status="completed").exists():
        raise DeliveryConflict("仍有未完成的业务子任务")
    if HumanReview.objects.filter(task=historical, status__in=["pending", "submitted"]).exists():
        raise DeliveryConflict("仍有未解决人工审核")
    if not WorkflowStep.objects.filter(
        task=historical,
        step_key="generate_deliverables",
        status="completed",
        output_refs__quality_status="passed",
    ).exists():
        raise DeliveryConflict("未实现真实交付文件生成与文件 QA")
    workflow, step, versions, _report = verify_current_bundle(workflow_id, expected_status="approved")
    with transaction.atomic():
        locked = WorkflowTask.objects.select_for_update().get(pk=workflow_id)
        if locked.status == "completed":
            receipt = EventLog.objects.filter(task=locked, event_type="workflow_delivery_completed").first()
            if receipt:
                return {"workflow_task_id": locked.id, "status": locked.status, "replayed": True}
            raise DeliveryConflict("工作流已完成，但缺少交付完成回执")
        if locked.status != "running" or locked.current_step != "complete_workflow":
            raise DeliveryConflict("工作流尚未获准显式完成")
        if locked.subtasks.exclude(status="completed").exists():
            raise DeliveryConflict("仍有未完成的业务子任务")
        if HumanReview.objects.filter(task=locked, status__in=["pending", "submitted"]).exists():
            raise DeliveryConflict("仍有未解决的人审事项")
        completion_bundle_is_current(locked, step.id)
        transition_workflow(locked, "completed", actor="orchestrator")
        locked.current_step = "completed"
        locked.save(update_fields=["current_step", "updated_at"])
        record_workflow_event(
            workflow=locked,
            event_type="workflow_delivery_completed",
            actor="orchestrator",
            from_status="running",
            to_status="completed",
            refs={"workflow_step_id": step.id, "artifact_version_ids": [item.id for item in versions.values()]},
            summary="approved delivery bundle completed",
        )
    return {"workflow_task_id": workflow_id, "status": "completed", "replayed": False}


def list_workflow_deliverables(workflow_id: str) -> dict[str, Any]:
    try:
        workflow = WorkflowTask.objects.get(pk=workflow_id)
    except WorkflowTask.DoesNotExist as exc:
        raise DeliveryNotFound("工作流不存在") from exc
    rows = []
    for artifact in Artifact.objects.filter(task=workflow).order_by("artifact_type", "id"):
        versions = []
        for version in artifact.versions.order_by("-version"):
            versions.append(
                {
                    "id": version.id,
                    "artifact_type": artifact.artifact_type,
                    "version": version.version,
                    "status": version.status,
                    "sha256": version.sha256,
                    "byte_size": get_artifact_byte_size(version),
                    "source_product_versions": version.source_product_versions,
                    "created_at": version.created_at.isoformat(),
                    "preview_url": (
                        public_url(f"/api/workflow-tasks/{workflow.id}/artifact-versions/{version.id}/preview")
                        if artifact.artifact_type in {"catalog_html", "catalog_markdown", "sample_checklist_csv"}
                        else None
                    ),
                    "download_url": public_url(f"/api/workflow-tasks/{workflow.id}/artifact-versions/{version.id}/download"),
                }
            )
        rows.append(
            {
                "id": artifact.id,
                "artifact_type": artifact.artifact_type,
                "current_version": artifact.current_version,
                "status": artifact.status,
                "versions": versions,
            }
        )
    step = _latest_step(workflow)
    quality_report = step.output_refs.get("quality_report") if step and step.status == "completed" else None
    quality_checks = []
    if isinstance(quality_report, dict):
        for filename, check in quality_report.get("checks", {}).items():
            quality_checks.append(
                {
                    "filename": filename,
                    "passed": check.get("passed"),
                    "bytes": check.get("bytes"),
                    "sha256": quality_report.get("hashes", {}).get(filename),
                }
            )
    return {
        "workflow_task_id": workflow.id,
        "workflow_status": workflow.status,
        "current_step": workflow.current_step,
        "generation_step_id": step.id if step and step.status == "completed" else None,
        "delivery_review_summary": _delivery_review_summary(workflow, step),
        "quality_report": quality_report,
        "quality_checks": quality_checks,
        "artifacts": rows,
    }


def get_artifact_version(workflow_id: str, version_id: str) -> tuple[ArtifactVersion, Path]:
    try:
        version = ArtifactVersion.objects.select_related("artifact").get(
            pk=version_id, artifact__task_id=workflow_id
        )
    except ArtifactVersion.DoesNotExist as exc:
        raise DeliveryNotFound("交付版本不存在") from exc
    path, _ = _verified_artifact_file(version)
    return version, path


def _verified_artifact_file(version: ArtifactVersion) -> tuple[Path, bytes]:
    try:
        path = resolve_artifact_file(version.file_path)
    except (FileNotFoundError, DeliveryStorageError) as exc:
        raise DeliveryNotFound("登记的交付文件不可用") from exc
    try:
        content = path.read_bytes()
    except OSError as exc:
        raise DeliveryNotFound("登记的交付文件不可用") from exc
    digest = hashlib.sha256(content).hexdigest()
    if digest != version.sha256:
        raise DeliveryConflict("登记的交付文件哈希不匹配")
    return path, content


def get_artifact_byte_size(version: ArtifactVersion) -> int | None:
    """Size of this registered, readable download object; unavailable is unknown."""
    if version.artifact.artifact_type not in DELIVERY_FILES:
        return None
    try:
        _, content = _verified_artifact_file(version)
    except (DeliveryNotFound, DeliveryConflict, DeliveryStorageError, OSError):
        return None
    return len(content)


def get_artifact_preview(workflow_id: str, version_id: str) -> tuple[ArtifactVersion, bytes, str]:
    version, path = get_artifact_version(workflow_id, version_id)
    mime_type = {
        "catalog_html": "text/html; charset=utf-8",
        "catalog_markdown": "text/markdown; charset=utf-8",
        "sample_checklist_csv": "text/csv; charset=utf-8",
    }.get(version.artifact.artifact_type)
    if mime_type is None:
        raise DeliveryConflict("此交付格式不提供在线预览")
    try:
        content = path.read_bytes()
    except OSError as exc:
        raise DeliveryNotFound("登记的交付文件不可用") from exc
    if hashlib.sha256(content).hexdigest() != version.sha256:
        raise DeliveryConflict("登记的交付文件哈希不匹配")
    return version, content, mime_type


def verify_download_version(workflow_id: str, version_id: str) -> tuple[ArtifactVersion, Path, str]:
    version, path = get_artifact_version(workflow_id, version_id)
    extension = DELIVERY_FILES.get(version.artifact.artifact_type)
    if extension is None:
        raise DeliveryNotFound("交付版本格式不存在")
    return version, path, extension
