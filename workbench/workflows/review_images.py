from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
from typing import Any

from django.conf import settings
from django.db import transaction
from django.utils import timezone

from workbench.delivery.storage import DeliveryStorageError, image_mime_type
from workbench.models import (
    HumanReview,
    Product,
    ProductRevision,
    Task,
    TaskFile,
    WorkflowStep,
    WorkflowTask,
)

from .events import record_workflow_event
from .reviews import (
    ReviewNotFound,
    ReviewSubmissionConflict,
    validate_saved_review_sources,
)


IMAGE_EXTENSIONS = {".png", ".jpg", ".jpeg", ".webp", ".gif", ".svg"}
MAX_IMAGE_BYTES = 5 * 1024 * 1024


class ReviewImageConflict(ValueError):
    pass


def is_missing_image_signal(source_refs: Any) -> bool:
    if not isinstance(source_refs, dict):
        return False
    signal = source_refs.get("signal")
    if not isinstance(signal, dict):
        return False
    if signal.get("missing_field") == "图片":
        uncertainties = signal.get("uncertainties")
        return isinstance(uncertainties, list) and "no_image_candidate" in uncertainties
    return False


def _canonical_json(value: Any) -> str:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def _upload_key(workflow_id: str, review_id: str, idempotency_key: str) -> str:
    digest = hashlib.sha256(
        f"{workflow_id}\0{review_id}\0{idempotency_key}".encode("utf-8")
    ).hexdigest()
    return f"workflow:{workflow_id}:review-image:{digest}"


def _owned_prefix(workflow_id: str, review_id: str, idempotency_key: str) -> str:
    digest = hashlib.sha256(
        f"{workflow_id}\0{review_id}\0{idempotency_key}".encode("utf-8")
    ).hexdigest()
    return f"review-upload-{digest}"


def _safe_media_file(stored_name: str) -> Path:
    if not isinstance(stored_name, str) or Path(stored_name).name != stored_name:
        raise ReviewImageConflict("补图存储引用无效")
    root = Path(settings.MEDIA_ROOT).resolve()
    path = (root / stored_name).resolve()
    try:
        path.relative_to(root)
    except ValueError as exc:
        raise ReviewImageConflict("补图路径超出媒体目录") from exc
    return path


def _validate_file(task_file: TaskFile, *, expected_sha256: str | None = None) -> dict[str, Any]:
    if task_file.kind != "image":
        raise ReviewImageConflict("补图凭据引用的文件类型无效")
    suffix = Path(task_file.original_name).suffix.lower()
    if suffix not in IMAGE_EXTENSIONS:
        raise ReviewImageConflict("图片格式不受支持")
    path = _safe_media_file(task_file.stored_name)
    try:
        content = path.read_bytes()
    except OSError as exc:
        raise ReviewImageConflict("补图文件不可用") from exc
    if not content or len(content) > MAX_IMAGE_BYTES:
        raise ReviewImageConflict("补图文件大小无效")
    digest = hashlib.sha256(content).hexdigest()
    if expected_sha256 is not None and digest != expected_sha256:
        raise ReviewImageConflict("补图文件哈希与上传凭据不一致")
    try:
        mime_type = image_mime_type(task_file.original_name, content)
    except DeliveryStorageError as exc:
        raise ReviewImageConflict("补图文件格式校验失败") from exc
    return {"content": content, "sha256": digest, "mime_type": mime_type, "path": path}


def _validate_original_no_image_source(
    workflow: WorkflowTask,
    review: HumanReview,
    metadata: dict[str, Any],
    refs: dict[str, Any],
) -> None:
    origin_step_id = metadata.get("origin_step_id")
    subtask_id = metadata.get("subtask_id")
    if not isinstance(origin_step_id, str) or not isinstance(subtask_id, str):
        raise ReviewImageConflict("无图审核缺少不可变来源步骤")
    if metadata.get("result_ref") != f"workflow_step:{origin_step_id}:output_refs.result_snapshot":
        raise ReviewImageConflict("无图审核来源引用无法验证")
    origin = WorkflowStep.objects.filter(
        pk=origin_step_id, task=workflow, step_key=f"subtask:{subtask_id}", status="completed"
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
        raise ReviewImageConflict("不可变来源步骤不能证明此无图审核")
    product_id = refs.get("product_id")
    revision_id = refs.get("revision_id")
    products = result.get("products")
    row = next(
        (item for item in products if isinstance(item, dict) and item.get("product_id") == product_id),
        None,
    ) if isinstance(products, list) else None
    result_refs = row.get("source_refs") if isinstance(row, dict) and isinstance(row.get("source_refs"), dict) else {}
    if (
        not isinstance(product_id, str)
        or not isinstance(revision_id, str)
        or row is None
        or row.get("status") != "needs_human"
        or row.get("image_candidates") != []
        or "图片" not in row.get("missing_fields", [])
        or "no_image_candidate" not in row.get("uncertainties", [])
        or result_refs.get("product_id") != product_id
        or result_refs.get("revision_id") != revision_id
        or not ProductRevision.objects.filter(pk=revision_id, product_id=product_id).exists()
    ):
        raise ReviewImageConflict("不可变产品结果不能证明该产品当时没有图片")
    if (
        refs.get("workflow_task_id") != workflow.id
        or refs.get("batch_id") != workflow.batch_id
        or refs.get("signal", {}).get("missing_field") != "图片"
        or "no_image_candidate" not in refs.get("signal", {}).get("uncertainties", [])
    ):
        raise ReviewImageConflict("审核信号与不可变无图产品结果不一致")


def validate_upload_credential(
    workflow: WorkflowTask,
    review: HumanReview,
    upload_step_id: Any,
    *,
    allowed_review_statuses: tuple[str, ...] = ("pending", "submitted", "approved"),
) -> tuple[WorkflowStep, TaskFile, dict[str, Any]]:
    """Validate immutable upload provenance without requiring the old revision to be current."""
    if review.task_id != workflow.id or review.status not in allowed_review_statuses:
        raise ReviewImageConflict("补图凭据与当前审核事项状态不匹配")
    metadata = review.source_conflict if isinstance(review.source_conflict, dict) else {}
    refs = metadata.get("source_refs") if isinstance(metadata.get("source_refs"), dict) else {}
    if not is_missing_image_signal(refs):
        raise ReviewImageConflict("该审核事项没有可补图的无图来源")
    _validate_original_no_image_source(workflow, review, metadata, refs)
    try:
        step = WorkflowStep.objects.get(pk=upload_step_id, task=workflow)
    except (WorkflowStep.DoesNotExist, TypeError, ValueError) as exc:
        raise ReviewImageConflict("补图上传步骤不存在") from exc
    if step.status != "completed" or not step.step_key.startswith(f"review_image_upload:{review.id}:"):
        raise ReviewImageConflict("补图上传步骤不属于该审核事项")
    output = step.output_refs if isinstance(step.output_refs, dict) else {}
    input_refs = step.input_refs if isinstance(step.input_refs, dict) else {}
    expected = {
        "workflow_id": workflow.id,
        "batch_id": workflow.batch_id,
        "review_id": review.id,
        "review_key": review.review_key,
        "product_id": refs.get("product_id"),
        "revision_id": refs.get("revision_id"),
        "origin_step_id": metadata.get("origin_step_id"),
    }
    if any(output.get(key) != value or input_refs.get(key) != value for key, value in expected.items()):
        raise ReviewImageConflict("补图凭据与审核来源的工作流、产品或版本不匹配")
    original_key = input_refs.get("idempotency_key")
    request_fingerprint = input_refs.get("request_fingerprint")
    if (
        not isinstance(original_key, str)
        or step.idempotency_key != _upload_key(workflow.id, review.id, original_key)
        or not isinstance(request_fingerprint, str)
        or output.get("request_fingerprint") != request_fingerprint
        or output.get("idempotency_key") != original_key
        or input_refs.get("reviewer") != output.get("reviewer")
        or input_refs.get("original_name") != output.get("original_name")
        or input_refs.get("sha256") != output.get("sha256")
    ):
        raise ReviewImageConflict("补图上传步骤的身份或幂等证明无效")
    task_file_id = output.get("task_file_id")
    if not isinstance(task_file_id, str) or not task_file_id:
        raise ReviewImageConflict("补图凭据缺少文件 ID")
    try:
        task_file = TaskFile.objects.get(pk=task_file_id, task_id=workflow.batch_id, kind="image")
    except TaskFile.DoesNotExist as exc:
        raise ReviewImageConflict("补图文件不存在或不属于当前批次") from exc
    if task_file.original_name != output.get("original_name") or task_file.stored_name != output.get("stored_name"):
        raise ReviewImageConflict("补图文件身份与上传凭据不一致")
    file_info = _validate_file(task_file, expected_sha256=output.get("sha256"))
    if output.get("mime_type") != file_info["mime_type"]:
        raise ReviewImageConflict("补图文件类型与上传凭据不一致")
    return step, task_file, {**file_info, "proof": output}


@transaction.atomic
def upload_review_image(
    *,
    workflow_id: str,
    review_id: str,
    review_key: str,
    idempotency_key: str,
    reviewer: str,
    original_name: str,
    content: bytes,
) -> dict[str, Any]:
    if not isinstance(idempotency_key, str) or not idempotency_key.strip() or len(idempotency_key) > 200:
        raise ReviewImageConflict("idempotency_key 必须是 1–200 字符的非空字符串")
    if not isinstance(reviewer, str) or not reviewer.strip() or len(reviewer) > 120:
        raise ReviewImageConflict("操作人标签必须是 1–120 字符的非空字符串")
    if not isinstance(review_key, str) or not review_key:
        raise ReviewImageConflict("review_key 无效")
    clean_name = Path(original_name).name
    suffix = Path(clean_name).suffix.lower()
    if not clean_name or len(clean_name) > 255 or suffix not in IMAGE_EXTENSIONS:
        raise ReviewImageConflict("图片格式或文件名无效")
    if not isinstance(content, bytes) or not content or len(content) > MAX_IMAGE_BYTES:
        raise ReviewImageConflict("图片必须在 5MB 以内")
    try:
        mime_type = image_mime_type(clean_name, content)
    except DeliveryStorageError as exc:
        raise ReviewImageConflict("图片内容未通过真实格式校验") from exc
    file_hash = hashlib.sha256(content).hexdigest()
    fingerprint = hashlib.sha256(
        _canonical_json(
            {
                "workflow_id": workflow_id,
                "review_id": review_id,
                "review_key": review_key,
                "idempotency_key": idempotency_key,
                "original_name": clean_name,
                "sha256": file_hash,
                "reviewer": reviewer.strip(),
            }
        ).encode("utf-8")
    ).hexdigest()

    try:
        workflow = WorkflowTask.objects.select_for_update().get(pk=workflow_id)
    except WorkflowTask.DoesNotExist as exc:
        raise ReviewNotFound("未知工作流或审核事项") from exc
    try:
        batch = Task.objects.select_for_update().get(pk=workflow.batch_id)
        initial_review = HumanReview.objects.get(pk=review_id, task=workflow)
    except (Task.DoesNotExist, HumanReview.DoesNotExist) as exc:
        raise ReviewNotFound("未知工作流或审核事项") from exc
    if initial_review.review_key != review_key:
        raise ReviewImageConflict("review_key 与待审核事项不匹配")
    key = _upload_key(workflow.id, initial_review.id, idempotency_key)
    refs = initial_review.source_conflict.get("source_refs", {}) if isinstance(initial_review.source_conflict, dict) else {}
    product_id = refs.get("product_id") if isinstance(refs, dict) else None
    try:
        product = Product.objects.select_for_update().get(pk=product_id, task=batch)
        review = HumanReview.objects.select_for_update().get(pk=review_id, task=workflow)
    except (Product.DoesNotExist, HumanReview.DoesNotExist) as exc:
        raise ReviewImageConflict("补图产品或审核事项不属于当前批次") from exc
    prior = WorkflowStep.objects.select_for_update().filter(task=workflow, idempotency_key=key).first()
    if prior is not None:
        prior_input = prior.input_refs if isinstance(prior.input_refs, dict) else {}
        if prior_input.get("request_fingerprint") != fingerprint:
            raise ReviewImageConflict("同一上传幂等键不能用于不同文件或操作人")
        _, task_file, file_info = validate_upload_credential(workflow, review, prior.id)
        return _upload_receipt(workflow, review, prior, task_file, file_info)

    if workflow.status != "waiting_human" or review.status != "pending":
        raise ReviewImageConflict("只能为 waiting_human 工作流中的待确认审核事项上传补图")
    try:
        validated_refs = validate_saved_review_sources(workflow, review)
    except (ReviewSubmissionConflict, ValueError) as exc:
        raise ReviewImageConflict(f"审核来源已过期：{exc}") from exc
    if not is_missing_image_signal(validated_refs):
        raise ReviewImageConflict("该审核事项不是经过验证的无图来源")
    revision_id = validated_refs.get("revision_id")
    if not isinstance(revision_id, str):
        raise ReviewImageConflict("审核事项没有可证明的当前产品版本")
    revision = ProductRevision.objects.select_for_update().filter(pk=revision_id, product=product).first()
    latest = ProductRevision.objects.filter(product=product).order_by("-version").first()
    if revision is None or latest is None or revision.id != latest.id:
        raise ReviewImageConflict("审核引用的产品版本已过期")
    if product.image_stored_name or revision.snapshot.get("image_stored_name", ""):
        raise ReviewImageConflict("当前产品已存在图片，不能按无图事项补图")

    token = _owned_prefix(workflow.id, review.id, idempotency_key)
    media_root = Path(settings.MEDIA_ROOT).resolve()
    media_root.mkdir(parents=True, exist_ok=True)
    stored_name = f"{token}{suffix}"
    file_path = _safe_media_file(stored_name)
    manifest_path = _safe_media_file(f"{token}.manifest")
    manifest = {
        "request_fingerprint": fingerprint,
        "original_name": clean_name,
        "sha256": file_hash,
        "mime_type": mime_type,
        "stored_name": stored_name,
    }
    if manifest_path.exists():
        try:
            previous_manifest = json.loads(manifest_path.read_text("utf-8"))
        except (OSError, UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise ReviewImageConflict("上传暂存凭据损坏，不能覆盖") from exc
        if previous_manifest != manifest:
            raise ReviewImageConflict("同一上传幂等键已有不同文件内容")
    else:
        for existing in media_root.glob(f"{token}.*"):
            if existing != manifest_path:
                raise ReviewImageConflict("同一上传幂等键已有未完成的其他文件")
        try:
            with manifest_path.open("xb") as handle:
                handle.write(_canonical_json(manifest).encode("utf-8"))
                handle.flush()
                os.fsync(handle.fileno())
        except FileExistsError:
            raise ReviewImageConflict("上传幂等键正在写入，请重试")
    if file_path.exists():
        try:
            existing_bytes = file_path.read_bytes()
        except OSError as exc:
            raise ReviewImageConflict("已占用的补图路径不可读") from exc
        if hashlib.sha256(existing_bytes).hexdigest() != file_hash or existing_bytes != content:
            raise ReviewImageConflict("已占用的补图路径内容不同，拒绝覆盖")
        try:
            image_mime_type(clean_name, existing_bytes)
        except DeliveryStorageError as exc:
            raise ReviewImageConflict("已写入的补图文件损坏") from exc
    else:
        staging = _safe_media_file(f"{token}.staging")
        if staging.exists():
            if staging.read_bytes() != content:
                raise ReviewImageConflict("补图暂存路径内容不同，拒绝覆盖")
        else:
            try:
                with staging.open("xb") as handle:
                    handle.write(content)
                    handle.flush()
                    os.fsync(handle.fileno())
            except FileExistsError:
                raise ReviewImageConflict("补图正在写入，请重试")
        try:
            staging.replace(file_path)
        except OSError as exc:
            raise ReviewImageConflict("补图文件落盘失败") from exc

    now = timezone.now()
    step = WorkflowStep.objects.create(
        task=workflow,
        step_key=f"review_image_upload:{review.id}:{token[-16:]}",
        status="completed",
        attempt=1,
        idempotency_key=key,
        input_refs={
            "request_fingerprint": fingerprint,
            "idempotency_key": idempotency_key,
            "workflow_id": workflow.id,
            "batch_id": workflow.batch_id,
            "review_id": review.id,
            "review_key": review.review_key,
            "product_id": product.id,
            "revision_id": revision.id,
            "origin_step_id": review.source_conflict.get("origin_step_id"),
            "reviewer": reviewer.strip(),
            "original_name": clean_name,
            "sha256": file_hash,
        },
        started_at=now,
        finished_at=now,
    )
    task_file = TaskFile.objects.create(
        task=batch,
        kind="image",
        original_name=clean_name,
        stored_name=stored_name,
        created_at=now,
    )
    step.output_refs = {
        "workflow_id": workflow.id,
        "batch_id": workflow.batch_id,
        "review_id": review.id,
        "review_key": review.review_key,
        "idempotency_key": idempotency_key,
        "product_id": product.id,
        "revision_id": revision.id,
        "origin_step_id": review.source_conflict.get("origin_step_id"),
        "task_file_id": task_file.id,
        "original_name": clean_name,
        "stored_name": stored_name,
        "sha256": file_hash,
        "mime_type": mime_type,
        "reviewer": reviewer.strip(),
        "request_fingerprint": fingerprint,
    }
    step.save(update_fields=["output_refs", "updated_at"])
    record_workflow_event(
        workflow=workflow,
        event_type="human_review_image_uploaded",
        actor=reviewer.strip(),
        refs={"human_review_id": review.id, "upload_step_id": step.id, "task_file_id": task_file.id},
        summary="human review image uploaded",
    )
    return _upload_receipt(workflow, review, step, task_file, {"sha256": file_hash, "mime_type": mime_type})


def _upload_receipt(
    workflow: WorkflowTask,
    review: HumanReview,
    step: WorkflowStep,
    task_file: TaskFile,
    file_info: dict[str, Any],
) -> dict[str, Any]:
    return {
        "workflow_id": workflow.id,
        "review_id": review.id,
        "upload_step_id": step.id,
        "task_file_id": task_file.id,
        "original_name": task_file.original_name,
        "sha256": file_info["sha256"],
        "mime_type": file_info["mime_type"],
        "status": "uploaded_pending_confirmation",
    }
