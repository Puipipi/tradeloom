from __future__ import annotations

import hashlib
import json
from typing import Any

from django.core.exceptions import ValidationError
from django.db import transaction
from django.utils import timezone

from workbench.models import Product, ProductRevision, Task
from workbench.products.versions import (
    LEGACY_FACT_FIELDS,
    field_sources_from_product,
    image_source_ref,
    snapshot_from_product,
)
from workbench.services import WorkbenchService


RESTORABLE_PRODUCT_FACTS = ("name", "category", "material", "size", "color")
_REVISION_ID_MAX = 32


class ProductFactRestoreError(Exception):
    def __init__(self, code: str, status: int):
        super().__init__(code)
        self.code = code
        self.status = status


def _canonical_digest(value: Any) -> str:
    encoded = json.dumps(value, ensure_ascii=True, allow_nan=False, sort_keys=True, separators=(",", ":")).encode("ascii")
    return hashlib.sha256(encoded).hexdigest()


def _iso(value) -> str | None:
    return value.isoformat() if value is not None else None


def _snapshot_sha(snapshot: dict) -> str:
    return _canonical_digest(snapshot)


def _revision_identity(revision: ProductRevision | None) -> dict | None:
    if revision is None:
        return None
    refs = revision.source_refs if isinstance(revision.source_refs, dict) else {}
    image = refs.get("image") if isinstance(refs.get("image"), dict) else None
    return {
        "id": revision.pk,
        "version": revision.version,
        "status": revision.status,
        "reviewer": revision.reviewer,
        "createdAt": _iso(revision.created_at),
        "updatedAt": _iso(revision.updated_at),
        "snapshotSha256": _snapshot_sha(revision.snapshot),
        "imageIdentity": _image_identity(image),
    }


def _image_identity(image: dict | None) -> dict | None:
    if not image:
        return None
    return {"taskFileId": image.get("task_file_id"), "storedName": image.get("stored_name")}


def _valid_source_snapshot(revision: ProductRevision) -> dict[str, str]:
    snapshot = revision.snapshot
    if not isinstance(snapshot, dict) or any(not isinstance(snapshot.get(field), str) for field in RESTORABLE_PRODUCT_FACTS):
        raise ProductFactRestoreError("source_revision_invalid", 409)
    result = {field: snapshot[field] for field in RESTORABLE_PRODUCT_FACTS}
    for field, value in result.items():
        try:
            Product._meta.get_field(field).run_validators(value)
        except ValidationError as exc:
            raise ProductFactRestoreError("source_revision_invalid", 409) from exc
    return result


def _current_snapshot(product: Product) -> dict[str, str]:
    return snapshot_from_product(product)


def _revision_matches_live(revision: ProductRevision | None, product: Product, image_ref: dict | None) -> bool:
    if revision is None or not isinstance(revision.snapshot, dict):
        return False
    current = _current_snapshot(product)
    if any(revision.snapshot.get(field) != value for field, value in current.items()):
        return False
    refs = revision.source_refs if isinstance(revision.source_refs, dict) else {}
    return _image_identity(refs.get("image")) == _image_identity(image_ref)


def _preview_baseline(product: Product, task: Task, latest: ProductRevision | None, image_ref: dict | None) -> dict:
    return {
        "task": {"id": task.pk, "status": task.status, "updatedAt": _iso(task.updated_at)},
        "product": {
            "id": product.pk,
            "updatedAt": _iso(product.updated_at),
            "legacyFacts": _current_snapshot(product),
            "imageStoredName": product.image_stored_name,
            "missingFields": product.missing_fields,
            "imageIdentity": _image_identity(image_ref),
        },
        "latestRevision": _revision_identity(latest),
    }


def _build_preview(product: Product, task: Task, source: ProductRevision, latest: ProductRevision | None) -> dict:
    target = _valid_source_snapshot(source)
    current = {field: getattr(product, field) for field in RESTORABLE_PRODUCT_FACTS}
    image_ref = image_source_ref(product)
    baseline = _preview_baseline(product, task, latest, image_ref)
    live_fingerprint = _canonical_digest(baseline)
    source_identity = {
        "id": source.pk,
        "version": source.version,
        "status": source.status,
        "reviewer": source.reviewer,
        "createdAt": _iso(source.created_at),
        "updatedAt": _iso(source.updated_at),
        "snapshotSha256": _snapshot_sha(source.snapshot),
    }
    differences = {
        field: {"current": current[field], "target": target[field]}
        for field in RESTORABLE_PRODUCT_FACTS
        if current[field] != target[field]
    }
    preview_basis = {
        "schema": "tradeloom.product-facts-restore-preview/v1",
        "productId": product.pk,
        "sourceRevision": source_identity,
        "scope": list(RESTORABLE_PRODUCT_FACTS),
        "currentLiveFingerprint": live_fingerprint,
        "latestRevisionId": latest.pk if latest else None,
        "target": target,
    }
    return {
        "code": "preview_ready",
        "productId": product.pk,
        "scope": list(RESTORABLE_PRODUCT_FACTS),
        "sourceRevision": source_identity,
        "taskStatus": task.status,
        "latestRevision": _revision_identity(latest),
        "current": current,
        "target": target,
        "differences": differences,
        "currentLiveFingerprint": live_fingerprint,
        "previewDigest": _canonical_digest(preview_basis),
        "wouldCreateBackup": not _revision_matches_live(latest, product, image_ref),
        "noOp": not differences,
    }


def _revision_dto(revision: ProductRevision) -> dict:
    return {
        "id": revision.pk,
        "version": revision.version,
        "status": revision.status,
        "reviewer": revision.reviewer,
        "snapshot": revision.snapshot,
        "fieldSources": revision.field_sources,
        "sourceRefs": revision.source_refs,
        "createdAt": _iso(revision.created_at),
        "updatedAt": _iso(revision.updated_at),
    }


def _valid_revision_id(value: Any) -> bool:
    return isinstance(value, str) and 1 <= len(value) <= _REVISION_ID_MAX and all(ch.isalnum() or ch in "-_" for ch in value)


def preview_product_fact_restore(product_id: str, source_revision_id: str) -> dict:
    product = Product.objects.select_related("task").filter(pk=product_id).first()
    if product is None:
        raise ProductFactRestoreError("product_not_found", 404)
    source = ProductRevision.objects.filter(pk=source_revision_id, product_id=product.pk).first()
    if source is None:
        raise ProductFactRestoreError("source_revision_not_found", 404)
    latest = ProductRevision.objects.filter(product_id=product.pk).order_by("-version").first()
    return _build_preview(product, product.task, source, latest)


def apply_product_fact_restore(
    product_id: str,
    *,
    source_revision_id: str,
    expected_latest_revision_id: str | None,
    expected_live_fingerprint: str,
    preview_digest: str,
) -> dict:
    try:
        with transaction.atomic():
            task_id = Product.objects.filter(pk=product_id).values_list("task_id", flat=True).first()
            if task_id is None:
                raise ProductFactRestoreError("product_not_found", 404)
            try:
                task = Task.objects.select_for_update().get(pk=task_id)
            except Task.DoesNotExist as exc:
                raise ProductFactRestoreError("product_not_found", 404) from exc
            product = Product.objects.select_for_update().filter(pk=product_id, task_id=task.pk).first()
            if product is None:
                raise ProductFactRestoreError("product_not_found", 404)
            latest = ProductRevision.objects.select_for_update().filter(product_id=product.pk).order_by("-version").first()
            source = ProductRevision.objects.filter(pk=source_revision_id, product_id=product.pk).first()
            if source is None:
                raise ProductFactRestoreError("source_revision_not_found", 404)

            preview = _build_preview(product, task, source, latest)
            if (latest.pk if latest else None) != expected_latest_revision_id:
                raise ProductFactRestoreError("restore_preview_stale", 409)
            if preview["currentLiveFingerprint"] != expected_live_fingerprint or preview["previewDigest"] != preview_digest:
                raise ProductFactRestoreError("restore_preview_stale", 409)
            if preview["noOp"]:
                return {
                    "code": "ok", "status": "no_op", "productId": product.pk,
                    "sourceRevisionId": source.pk, "backupRevisionId": None,
                    "backupCreated": False, "scope": list(RESTORABLE_PRODUCT_FACTS),
                    "revision": _revision_dto(latest) if latest else None,
                }

            live_snapshot = _current_snapshot(product)
            live_image_ref = image_source_ref(product)
            backup_created = not _revision_matches_live(latest, product, live_image_ref)
            backup = latest
            if backup_created:
                backup = ProductRevision.objects.create(
                    product=product,
                    version=(latest.version + 1) if latest else 1,
                    snapshot=live_snapshot,
                    field_sources=field_sources_from_product(product),
                    status="draft",
                    source_refs={
                        "source": "product_facts_restore_backup",
                        "restore": {"source_revision_id": source.pk, "scope": list(RESTORABLE_PRODUCT_FACTS)},
                        **({"image": live_image_ref} if live_image_ref else {}),
                    },
                    reviewer="",
                )
            if backup is None:
                raise ProductFactRestoreError("restore_backup_unavailable", 409)

            for field in RESTORABLE_PRODUCT_FACTS:
                setattr(product, field, preview["target"][field])
            product.missing_fields = WorkbenchService()._missing_fields(
                {field: getattr(product, field) for field in ("sku", *RESTORABLE_PRODUCT_FACTS)},
                bool(product.image_stored_name),
            )
            now = timezone.now()
            product.updated_at = now
            product.save(update_fields=[*RESTORABLE_PRODUCT_FACTS, "missing_fields", "updated_at"])
            task.status = "awaiting_confirmation"
            task.updated_at = now
            task.save(update_fields=["status", "updated_at"])

            restored_snapshot = _current_snapshot(product)
            field_sources = field_sources_from_product(product)
            for field in RESTORABLE_PRODUCT_FACTS:
                field_sources[field] = "product_revision_restore"
            restored = ProductRevision.objects.create(
                product=product,
                version=backup.version + 1,
                snapshot=restored_snapshot,
                field_sources=field_sources,
                status="needs_review",
                source_refs={
                    "source": "product_facts_restore",
                    "source_revision_id": source.pk,
                    "backup_revision_id": backup.pk,
                    "scope": list(RESTORABLE_PRODUCT_FACTS),
                    **({"image": live_image_ref} if live_image_ref else {}),
                },
                reviewer="",
            )
            return {
                "code": "ok", "status": "restored", "productId": product.pk,
                "sourceRevisionId": source.pk, "backupRevisionId": backup.pk,
                "backupCreated": backup_created, "scope": list(RESTORABLE_PRODUCT_FACTS),
                "revision": _revision_dto(restored),
                "product": {"missingFields": product.missing_fields, "taskStatus": task.status},
            }
    except ProductFactRestoreError:
        raise
    except Exception as exc:
        raise ProductFactRestoreError("restore_failed", 500) from exc
