from __future__ import annotations

import csv
import io
import json
import uuid
from pathlib import Path
from typing import Iterable

from django.conf import settings
from django.db import IntegrityError, transaction
from django.utils import timezone

from .agents.contracts import AgentRequest, InputRef
from .agents.registry import (
    CapabilityUnavailableError,
    UnknownCapabilityError,
    build_default_registry,
)
from .business_urls import public_url
from .models import AgentRun, BatchItem, Task, TaskFile


CSV_FIELDS = (
    "sku",
    "name",
    "category",
    "material",
    "size",
    "color",
    "image_filename",
)
FIELD_LABELS = {
    "sku": "货号",
    "name": "名称",
    "category": "品类",
    "material": "材质",
    "size": "尺寸",
    "color": "颜色",
}
IMAGE_EXTENSIONS = {".png", ".jpg", ".jpeg", ".webp", ".gif", ".svg"}
MAX_IMAGE_BYTES = 5 * 1024 * 1024
AGENT_RUN_IDEMPOTENCY_NAMESPACE = uuid.UUID(
    "04f6b85f-6cc4-58ca-a16a-b4718f1893ae"
)


class WorkbenchNotFoundError(Exception):
    pass


class WorkbenchConflictError(Exception):
    pass


class AgentRunInProgressError(Exception):
    def __init__(self, run_id: str):
        super().__init__("Agent运行仍在处理中。")
        self.run_id = run_id


class AgentRunReplayError(Exception):
    def __init__(self, status_code: int, message: str):
        super().__init__(message)
        self.status_code = status_code


class UploadValidationError(Exception):
    pass


def _now():
    return timezone.now()


def _iso(value) -> str | None:
    return value.isoformat() if value is not None else None


class WorkbenchService:
    def __init__(self) -> None:
        self.registry = build_default_registry()
        self.sample_dir = Path(settings.BASE_DIR) / "data" / "samples"

    def list_tasks(self) -> list[dict]:
        return [self._task_summary(task) for task in Task.objects.all()]

    def get_task(self, task_id: str) -> dict:
        try:
            task = Task.objects.prefetch_related("batch_items", "files").get(
                id=task_id
            )
        except Task.DoesNotExist as exc:
            raise WorkbenchNotFoundError("任务不存在") from exc
        return self._task_detail(task)

    def create_demo_task(self) -> dict:
        csv_path = self.sample_dir / "products.csv"
        if not csv_path.is_file():
            raise UploadValidationError(f"缺少演示商品表：{csv_path}")
        csv_bytes = csv_path.read_bytes()
        rows = self.parse_csv(csv_bytes)
        images = []
        for row in rows:
            image_name = row["image_filename"]
            image_path = self.sample_dir / "images" / image_name
            if image_name and image_path.is_file():
                images.append((image_name, image_path.read_bytes()))
        return self.create_task_from_csv(
            title="演示任务｜丝带与蝴蝶结资料整理",
            csv_name=csv_path.name,
            csv_bytes=csv_bytes,
            rows=rows,
            images=images,
            mode="demo",
        )

    def create_task_from_csv(
        self,
        *,
        title: str,
        csv_name: str,
        csv_bytes: bytes,
        rows: list[dict[str, str]],
        images: Iterable[tuple[str, bytes]],
        mode: str = "upload",
    ) -> dict:
        clean_title = title.strip()
        if not clean_title:
            raise UploadValidationError("任务标题不能为空")
        if not rows:
            raise UploadValidationError("CSV 至少需要一行产品")
        now = _now()
        with transaction.atomic():
            task = Task.objects.create(
                title=clean_title,
                mode=mode,
                status="awaiting_confirmation",
                created_at=now,
                updated_at=now,
            )
            source = self._store_file(
                task, "source_csv", csv_name, csv_bytes, ".csv", now
            )
            stored_images: dict[str, TaskFile] = {}
            for original_name, content in images:
                clean_name = Path(original_name).name
                suffix = Path(clean_name).suffix.lower()
                if suffix not in IMAGE_EXTENSIONS:
                    raise UploadValidationError(f"不支持的图片格式：{clean_name}")
                if len(content) > MAX_IMAGE_BYTES:
                    raise UploadValidationError(f"图片超过 5MB：{clean_name}")
                record = self._store_file(
                    task, "image", clean_name, content, suffix, now
                )
                stored_images[Path(clean_name).stem] = record
            for position, row in enumerate(rows):
                matched = stored_images.get(row["sku"])
                image_filename = matched.original_name if matched else ""
                stored_name = matched.stored_name if matched else ""
                missing = self._missing_fields(row, bool(matched))
                BatchItem.objects.create(
                    task=task,
                    position=position,
                    sku=row["sku"],
                    name=row["name"],
                    category=row["category"],
                    material=row["material"],
                    size=row["size"],
                    color=row["color"],
                    image_filename=image_filename,
                    image_stored_name=stored_name,
                    missing_fields=missing,
                    created_at=now,
                    updated_at=now,
                )
        return self.get_task(task.id)

    def update_batch_item(self, item_id: str, changes: dict[str, str]) -> dict:
        allowed = {"sku", "name", "category", "material", "size", "color"}
        unexpected = set(changes) - allowed
        if unexpected:
            raise UploadValidationError(
                "不可写字段：" + "、".join(sorted(unexpected))
            )
        with transaction.atomic():
            task_id = (
                BatchItem.objects.filter(id=item_id)
                .values_list("task_id", flat=True)
                .first()
            )
            if task_id is None:
                raise WorkbenchNotFoundError("产品行不存在")
            try:
                task = Task.objects.select_for_update().get(id=task_id)
            except Task.DoesNotExist as exc:
                raise WorkbenchNotFoundError("任务不存在") from exc
            try:
                item = BatchItem.objects.select_for_update().get(id=item_id)
            except BatchItem.DoesNotExist as exc:
                raise WorkbenchNotFoundError("产品行不存在") from exc
            if item.task_id != task.id:
                raise WorkbenchConflictError("产品行所属任务已变化，请重试")
            item.task = task
            for field, value in changes.items():
                setattr(item, field, str(value).strip())
            if "sku" in changes:
                matched = self._find_task_image(item.task, item.sku)
                if matched is None:
                    item.image_filename = ""
                    item.image_stored_name = ""
                else:
                    item.image_filename = matched.original_name
                    item.image_stored_name = matched.stored_name
            item.missing_fields = self._missing_fields(
                {
                    "sku": item.sku,
                    "name": item.name,
                    "category": item.category,
                    "material": item.material,
                    "size": item.size,
                    "color": item.color,
                },
                bool(item.image_stored_name),
            )
            item.updated_at = _now()
            item.save()
            task.status = "awaiting_confirmation"
            task.updated_at = item.updated_at
            task.save(update_fields=["status", "updated_at"])
        return self._product_dict(item)

    def get_batch_item(self, item_id: str) -> dict:
        try:
            return self._product_dict(BatchItem.objects.get(id=item_id))
        except BatchItem.DoesNotExist as exc:
            raise WorkbenchNotFoundError("产品行不存在") from exc

    def confirm_task(self, task_id: str) -> dict:
        with transaction.atomic():
            try:
                task = Task.objects.select_for_update().get(id=task_id)
            except Task.DoesNotExist as exc:
                raise WorkbenchNotFoundError("任务不存在") from exc
            if task.status != "confirmed":
                items = list(task.batch_items.all())
                if not items:
                    raise WorkbenchConflictError("任务中没有产品，不能确认")
                pending = [item for item in items if item.missing_fields]
                if pending:
                    parts = [
                        f"{item.name}：{'、'.join(item.missing_fields)}"
                        for item in pending
                    ]
                    raise WorkbenchConflictError("存在待确认项：" + "；".join(parts))
                task.status = "confirmed"
                task.updated_at = _now()
                task.save(update_fields=["status", "updated_at"])
        return self.get_task(task_id)

    def export_csv(self, task_id: str) -> str:
        try:
            task = Task.objects.prefetch_related("batch_items").get(id=task_id)
        except Task.DoesNotExist as exc:
            raise WorkbenchNotFoundError("任务不存在") from exc
        if task.status != "confirmed":
            raise WorkbenchConflictError("请先确认全部产品资料，再导出 CSV")
        buffer = io.StringIO(newline="")
        writer = csv.DictWriter(
            buffer,
            fieldnames=CSV_FIELDS,
            lineterminator="\n",
        )
        writer.writeheader()
        for item in task.batch_items.all():
            writer.writerow(
                {
                    "sku": item.sku,
                    "name": item.name,
                    "category": item.category,
                    "material": item.material,
                    "size": item.size,
                    "color": item.color,
                    "image_filename": item.image_filename,
                }
            )
        return buffer.getvalue()

    def parse_csv(self, csv_bytes: bytes) -> list[dict[str, str]]:
        try:
            text = csv_bytes.decode("utf-8-sig")
        except UnicodeDecodeError as exc:
            raise UploadValidationError("CSV 必须使用 UTF-8 编码") from exc
        reader = csv.DictReader(io.StringIO(text))
        if reader.fieldnames is None:
            raise UploadValidationError("CSV 缺少表头")
        missing_headers = [
            field for field in CSV_FIELDS if field not in reader.fieldnames
        ]
        if missing_headers:
            raise UploadValidationError(
                "CSV 缺少表头：" + "、".join(missing_headers)
            )
        rows = [
            {field: (row.get(field) or "").strip() for field in CSV_FIELDS}
            for row in reader
        ]
        if not rows:
            raise UploadValidationError("CSV 至少需要一行产品")
        return rows

    def list_capabilities(self) -> list[dict]:
        return [
            {
                "id": item.id,
                "name": item.name,
                "description": item.description,
                "implemented": item.implemented,
            }
            for item in self.registry.capabilities()
        ]

    def dispatch_agent(
        self,
        task_id: str,
        capability_id: str,
        idempotency_key: str | None = None,
    ) -> dict:
        if idempotency_key is not None:
            if (
                not idempotency_key
                or len(idempotency_key) > 200
                or idempotency_key.strip() != idempotency_key
            ):
                raise ValueError(
                    "Idempotency-Key必须为1到200个字符，且不能含首尾空格。"
                )
            deterministic_id = uuid.uuid5(
                AGENT_RUN_IDEMPOTENCY_NAMESPACE,
                json.dumps(
                    [task_id, capability_id, idempotency_key],
                    ensure_ascii=False,
                    separators=(",", ":"),
                ),
            ).hex
            existing = AgentRun.objects.filter(pk=deterministic_id).first()
            if existing is not None:
                return self._replay_agent_run(existing, task_id, capability_id)
            self.get_task(task_id)
            try:
                with transaction.atomic():
                    run = AgentRun.objects.create(
                        run_id=deterministic_id,
                        task_id=task_id,
                        capability_id=capability_id,
                        status="running",
                        started_at=_now(),
                    )
            except IntegrityError:
                existing = AgentRun.objects.filter(pk=deterministic_id).first()
                if existing is None:
                    raise
                return self._replay_agent_run(existing, task_id, capability_id)
            detail = self.get_task(task_id)
        else:
            detail = self.get_task(task_id)
            run = None
        request = AgentRequest(
            task_id=task_id,
            capability_id=capability_id,
            input_refs=[
                InputRef(
                    file_id=item["id"],
                    kind=item["kind"],
                    name=item["original_name"],
                    url=item["url"],
                )
                for item in detail["files"]
            ],
            payload={
                "demo_mode": detail["mode"] == "demo",
                "products": detail["products"],
            },
        )
        if run is None:
            run = AgentRun.objects.create(
                task_id=task_id,
                capability_id=capability_id,
                status="running",
                started_at=_now(),
            )
        try:
            result = self.registry.dispatch(request)
        except UnknownCapabilityError as exc:
            run.status = "failed"
            run.error = f"未知 Agent 能力：{capability_id}"
            run.finished_at = _now()
            run.save()
            raise
        except CapabilityUnavailableError as exc:
            run.status = "unavailable"
            run.error = str(exc)
            run.finished_at = _now()
            run.save()
            raise
        except Exception as exc:
            run.status = "failed"
            run.error = f"{type(exc).__name__}: {exc}"
            run.finished_at = _now()
            run.save()
            if idempotency_key is not None:
                raise AgentRunReplayError(500, "Agent运行失败，请查看运行记录。") from exc
            raise
        response = {
            "run_id": run.run_id,
            "status": result.status,
            "output": result.output,
            "pending_items": [
                {
                    "product_id": item.product_id,
                    "sku": item.sku,
                    "missing_fields": item.missing_fields,
                }
                for item in result.pending_items
            ],
            "artifact_refs": [
                {
                    "kind": item.kind,
                    "name": item.name,
                    "url": item.url,
                }
                for item in result.artifact_refs
            ],
        }
        run.status = result.status
        run.result = response
        run.finished_at = _now()
        run.save()
        return response

    @staticmethod
    def _replay_agent_run(run: AgentRun, task_id: str, capability_id: str) -> dict:
        if run.task_id != task_id or run.capability_id != capability_id:
            raise RuntimeError("Agent运行幂等键作用域冲突。")
        if run.status == "running":
            raise AgentRunInProgressError(run.run_id)
        if run.status == "unavailable":
            raise AgentRunReplayError(409, run.error or "Agent能力不可用。")
        if run.status == "failed":
            if run.error and run.error.startswith("未知 Agent 能力："):
                raise UnknownCapabilityError(run.error.removeprefix("未知 Agent 能力："))
            raise AgentRunReplayError(500, "Agent运行失败，请查看运行记录。")
        if run.result is None:
            raise RuntimeError("Agent运行已结束，但没有可重放的结果。")
        return run.result

    def list_runs(self, task_id: str) -> list[dict]:
        self.get_task(task_id)
        return [
            {
                "run_id": run.run_id,
                "task_id": run.task_id,
                "capability_id": run.capability_id,
                "status": run.status,
                "started_at": _iso(run.started_at),
                "finished_at": _iso(run.finished_at),
                "result": run.result,
                "error": run.error,
            }
            for run in AgentRun.objects.filter(task_id=task_id)
        ]

    def _store_file(
        self,
        task: Task,
        kind: str,
        original_name: str,
        content: bytes,
        suffix: str,
        now,
    ) -> TaskFile:
        stored_name = f"{task.id}-{uuid.uuid4().hex}{suffix}"
        media_root = Path(settings.MEDIA_ROOT)
        media_root.mkdir(parents=True, exist_ok=True)
        (media_root / stored_name).write_bytes(content)
        return TaskFile.objects.create(
            task=task,
            kind=kind,
            original_name=Path(original_name).name,
            stored_name=stored_name,
            created_at=now,
        )

    def _find_task_image(self, task: Task, sku: str) -> TaskFile | None:
        for record in TaskFile.objects.filter(task=task, kind="image"):
            if Path(record.original_name).stem == sku:
                return record
        return None

    def _missing_fields(self, product: dict, has_image: bool) -> list[str]:
        missing = [
            label
            for field, label in FIELD_LABELS.items()
            if not str(product.get(field, "")).strip()
        ]
        if not has_image:
            missing.append("图片")
        return missing

    def _task_summary(self, task: Task) -> dict:
        products = list(task.batch_items.all())
        return {
            "id": task.id,
            "title": task.title,
            "mode": task.mode,
            "status": task.status,
            "created_at": _iso(task.created_at),
            "updated_at": _iso(task.updated_at),
            "product_count": len(products),
            "missing_count": sum(bool(item.missing_fields) for item in products),
        }

    def _task_detail(self, task: Task) -> dict:
        products = [self._product_dict(item) for item in task.batch_items.all()]
        files = [
            {
                "id": item.id,
                "kind": item.kind,
                "original_name": item.original_name,
                "url": (
                    public_url(f"{settings.MEDIA_URL}{item.stored_name}")
                    if item.kind == "image"
                    else None
                ),
            }
            for item in task.files.all()
        ]
        summary = self._task_summary(task)
        summary.update({"products": products, "files": files})
        return summary

    def _product_dict(self, item: BatchItem) -> dict:
        return {
            "id": item.id,
            "task_id": item.task_id,
            "sku": item.sku,
            "name": item.name,
            "category": item.category,
            "material": item.material,
            "size": item.size,
            "color": item.color,
            "image_filename": item.image_filename,
            "image_url": (
                public_url(f"{settings.MEDIA_URL}{item.image_stored_name}")
                if item.image_stored_name
                else None
            ),
            "missing_fields": item.missing_fields,
            "updated_at": _iso(item.updated_at),
        }
