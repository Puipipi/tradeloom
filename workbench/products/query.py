from __future__ import annotations

from django.db.models import OuterRef, Q, Subquery

from workbench.models import Product, ProductRevision


PRODUCT_LIBRARY_STATUSES = ("draft", "needs_review", "confirmed")


class InvalidProductFilter(ValueError):
    pass


def _revision_payload(revision: ProductRevision) -> dict:
    source_refs = revision.source_refs or {}
    return {
        "id": revision.pk,
        "version": revision.version,
        "status": revision.status,
        "source": source_refs.get("source", ""),
        "snapshot": revision.snapshot,
        "updated_at": revision.updated_at,
        "image": source_refs.get("image"),
    }


def _serialize_product(
    product: Product,
    *,
    include_revisions: bool = False,
) -> dict:
    revisions = sorted(
        product.revisions.all(),
        key=lambda revision: revision.version,
        reverse=True,
    )
    latest = revisions[0] if revisions else None
    payload = {
        "id": product.id,
        "task_id": product.task_id,
        "sku": product.sku,
        "name": product.name,
        "category": product.category,
        "material": product.material,
        "size": product.size,
        "color": product.color,
        "image_filename": product.image_filename,
        "missing_fields": product.missing_fields,
        "batch": {
            "id": product.task_id,
            "title": product.task.title,
            "status": product.task.status,
        },
        "current_version": latest.version if latest else None,
        "revision_status": latest.status if latest else None,
        "revision_state": "versioned" if latest else "unbuilt",
        "latest_revision": _revision_payload(latest) if latest else None,
    }
    if include_revisions:
        payload["revisions"] = [
            _revision_payload(revision) for revision in revisions
        ]
    return payload


def query_product_library(
    *,
    q: str = "",
    status: str = "",
    batch_id: str = "",
    include_revisions: bool = False,
) -> list[dict]:
    clean_status = (status or "").strip()
    if clean_status and clean_status not in PRODUCT_LIBRARY_STATUSES:
        raise InvalidProductFilter("未知状态筛选")

    latest = (
        ProductRevision.objects.filter(product=OuterRef("pk"))
        .order_by("-version")
    )
    queryset = (
        Product.objects.select_related("task")
        .prefetch_related("revisions")
        .annotate(
            latest_version=Subquery(latest.values("version")[:1]),
            latest_status=Subquery(latest.values("status")[:1]),
        )
    )
    search = (q or "").strip()
    if search:
        queryset = queryset.filter(
            Q(sku__icontains=search) | Q(name__icontains=search)
        )
    if clean_status:
        queryset = queryset.filter(latest_status=clean_status)
    if batch_id:
        queryset = queryset.filter(task_id=batch_id)

    return [
        _serialize_product(product, include_revisions=include_revisions)
        for product in queryset.order_by("task_id", "position", "id")
    ]


def get_product_with_revisions(product_id: str) -> dict:
    product = (
        Product.objects.select_related("task")
        .prefetch_related("revisions")
        .get(id=product_id)
    )
    return _serialize_product(product, include_revisions=True)
