from __future__ import annotations

from dataclasses import dataclass, field

from django.db import transaction

from workbench.models import Product, ProductRevision, Task, TaskFile


LEGACY_FACT_FIELDS = (
    "sku",
    "name",
    "category",
    "material",
    "size",
    "color",
    "image_filename",
)

REVISION_STATUS_BY_TASK_STATUS = {
    "confirmed": "confirmed",
    "awaiting_confirmation": "needs_review",
}

DEFAULT_REVISION_STATUS = "draft"
LEGACY_CSV_ACTOR = "legacy_csv"
LEGACY_API_ACTOR = "legacy_api"


@dataclass
class BackfillReport:
    dry_run: bool
    scanned: int
    created: int
    skipped: int
    by_status: dict[str, int] = field(default_factory=dict)


def snapshot_from_product(product: Product) -> dict[str, str]:
    return {field_name: getattr(product, field_name) for field_name in LEGACY_FACT_FIELDS}


def revision_status_for_task_status(task_status: str) -> str:
    return REVISION_STATUS_BY_TASK_STATUS.get(task_status, DEFAULT_REVISION_STATUS)


def field_sources_from_product(product: Product) -> dict[str, str]:
    sources = {field_name: "legacy_product" for field_name in LEGACY_FACT_FIELDS}
    if product.image_stored_name:
        sources["image_filename"] = "legacy_task_file"
    return sources


def image_source_ref(product: Product) -> dict[str, str | None] | None:
    if not product.image_stored_name:
        return None
    task_file = TaskFile.objects.filter(
        task_id=product.task_id,
        kind="image",
        stored_name=product.image_stored_name,
    ).first()
    return {
        "task_file_id": task_file.id if task_file else None,
        "original_name": task_file.original_name if task_file else product.image_filename,
        "stored_name": product.image_stored_name,
    }


def _source_refs(
    product: Product,
    *,
    source: str,
    actor: str | None = None,
    legacy_task_id: str | None = None,
) -> dict:
    refs: dict = {"source": source}
    if actor is not None:
        refs["actor"] = actor
    if legacy_task_id is not None:
        refs["legacy_task_id"] = legacy_task_id
    image = image_source_ref(product)
    if image is not None:
        refs["image"] = image
    return refs


def _facts_match(latest: ProductRevision, snapshot: dict[str, str]) -> bool:
    return all(
        latest.snapshot.get(field_name) == value
        for field_name, value in snapshot.items()
    )


def _image_identity(image_ref: dict | None) -> tuple[str | None, str | None] | None:
    if not image_ref:
        return None
    return (image_ref.get("task_file_id"), image_ref.get("stored_name"))


def sync_revision_from_product(
    product: Product,
    actor: str,
) -> ProductRevision:
    """Synchronize one product's current legacy facts into its revision chain.

    The product row is locked before reading the latest version, so concurrent
    writers allocate versions in order. Extra approved fields such as
    ``english_name`` are preserved when the seven legacy facts are unchanged;
    a real fact change creates a new revision without those stale approvals.
    """

    with transaction.atomic():
        locked_product = Product.objects.select_for_update().get(pk=product.pk)
        snapshot = snapshot_from_product(locked_product)
        latest = (
            ProductRevision.objects.filter(product=locked_product)
            .order_by("-version")
            .first()
        )
        desired_status = revision_status_for_task_status(locked_product.task.status)
        current_image = image_source_ref(locked_product)

        if (
            latest is not None
            and _facts_match(latest, snapshot)
            and _image_identity(latest.source_refs.get("image"))
            == _image_identity(current_image)
        ):
            changed_fields = []
            if latest.status != desired_status:
                latest.status = desired_status
                changed_fields.append("status")
            if desired_status != "confirmed" and latest.reviewer:
                latest.reviewer = ""
                changed_fields.append("reviewer")
            if changed_fields:
                latest.save(update_fields=changed_fields + ["updated_at"])
            return latest

        source = "legacy_csv" if actor == LEGACY_CSV_ACTOR else "legacy_product"
        return ProductRevision.objects.create(
            product=locked_product,
            version=(latest.version + 1) if latest is not None else 1,
            snapshot=snapshot,
            field_sources=field_sources_from_product(locked_product),
            status="needs_review" if latest is not None else desired_status,
            source_refs=_source_refs(
                locked_product,
                source=source,
                actor=actor,
            ),
            reviewer="",
        )


def confirm_batch_revisions(
    task_id: str,
    reviewer: str,
) -> list[ProductRevision]:
    """Confirm the latest revision of every product in a batch.

    The task row is locked before products, and products are locked in id order,
    matching the update path. Existing snapshots are never rewritten.
    """

    with transaction.atomic():
        task = Task.objects.select_for_update().get(id=task_id)
        products = list(
            Product.objects.select_for_update()
            .filter(task_id=task.id)
            .order_by("id")
        )
        revisions = []
        for product in products:
            latest = (
                ProductRevision.objects.filter(product=product)
                .order_by("-version")
                .first()
            )
            if latest is None:
                latest = ProductRevision.objects.create(
                    product=product,
                    version=1,
                    snapshot=snapshot_from_product(product),
                    field_sources=field_sources_from_product(product),
                    status="confirmed",
                    source_refs=_source_refs(
                        product,
                        source="legacy_confirm",
                        actor=reviewer,
                    ),
                    reviewer=reviewer,
                )
            else:
                changed_fields = []
                if latest.status != "confirmed":
                    latest.status = "confirmed"
                    changed_fields.append("status")
                if latest.reviewer != reviewer:
                    latest.reviewer = reviewer
                    changed_fields.append("reviewer")
                if changed_fields:
                    latest.save(update_fields=changed_fields + ["updated_at"])
            revisions.append(latest)
        return revisions


def backfill_legacy_product_revisions(
    dry_run: bool = True,
) -> BackfillReport:
    """Create v1 revisions for legacy products that have none.

    Existing revisions are never modified or replaced. Dry-run reports the
    planned status distribution without writing.
    """

    with transaction.atomic():
        missing_products = (
            Product.objects.filter(revisions__isnull=True)
            .select_related("task")
            .order_by("task_id", "id")
        )
        if dry_run:
            by_status: dict[str, int] = {}
            scanned = 0
            for product in missing_products:
                status = revision_status_for_task_status(product.task.status)
                by_status[status] = by_status.get(status, 0) + 1
                scanned += 1
            return BackfillReport(
                dry_run=True,
                scanned=scanned,
                created=0,
                skipped=0,
                by_status=by_status,
            )

        scanned = missing_products.count()
        task_ids = list(
            missing_products.values_list("task_id", flat=True)
            .distinct()
            .order_by("task_id")
        )
        by_status = {}
        created = 0
        for task_id in task_ids:
            task = Task.objects.select_for_update().get(id=task_id)
            products = list(
                Product.objects.select_for_update()
                .filter(task_id=task_id)
                .order_by("id")
            )
            for product in products:
                if ProductRevision.objects.filter(product=product).exists():
                    continue
                status = revision_status_for_task_status(task.status)
                ProductRevision.objects.create(
                    product=product,
                    version=1,
                    snapshot=snapshot_from_product(product),
                    field_sources=field_sources_from_product(product),
                    status=status,
                    source_refs=_source_refs(
                        product,
                        source="legacy_backfill",
                        legacy_task_id=task.id,
                    ),
                    reviewer="",
                )
                by_status[status] = by_status.get(status, 0) + 1
                created += 1

        return BackfillReport(
            dry_run=False,
            scanned=scanned,
            created=created,
            skipped=scanned - created,
            by_status=by_status,
        )
