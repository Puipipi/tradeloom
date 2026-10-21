from __future__ import annotations

from django.test import TestCase
from django.utils import timezone

from workbench.models import Product, ProductRevision, Task


class ProductLibraryApiTests(TestCase):
    def make_batch(self, *, title: str = "产品批次") -> Task:
        now = timezone.now()
        return Task.objects.create(
            title=title,
            mode="demo",
            status="confirmed",
            created_at=now,
            updated_at=now,
        )

    def make_product(
        self,
        batch: Task,
        *,
        sku: str,
        name: str,
        position: int = 0,
        missing_fields: list[str] | None = None,
    ) -> Product:
        now = timezone.now()
        return Product.objects.create(
            task=batch,
            position=position,
            sku=sku,
            name=name,
            category="丝带",
            material="涤纶",
            size="25mm",
            color="酒红",
            image_filename=f"{sku}.svg",
            image_stored_name=f"stored-{sku}.svg",
            missing_fields=[] if missing_fields is None else missing_fields,
            created_at=now,
            updated_at=now,
        )

    def make_revision(
        self,
        product: Product,
        *,
        version: int,
        status: str,
        source: str = "legacy_backfill",
    ) -> ProductRevision:
        return ProductRevision.objects.create(
            product=product,
            version=version,
            snapshot={
                "sku": product.sku,
                "name": product.name,
                "category": product.category,
                "material": product.material,
                "size": product.size,
                "color": product.color,
                "image_filename": product.image_filename,
            },
            status=status,
            source_refs={
                "source": source,
                "image": {
                    "task_file_id": f"file-{version}",
                    "original_name": product.image_filename,
                    "stored_name": f"stored-{product.id}-{version}.svg",
                },
            },
        )

    def test_search_batch_and_latest_status_filters(self):
        batch_one = self.make_batch(title="批次一")
        batch_two = self.make_batch(title="批次二")
        product_a = self.make_product(
            batch_one,
            sku="LIB-001",
            name="缎带 A",
        )
        self.make_revision(product_a, version=1, status="draft")
        self.make_revision(product_a, version=2, status="needs_review")
        product_b = self.make_product(
            batch_one,
            sku="LIB-002",
            name="蝴蝶结 B",
            position=1,
        )
        self.make_revision(product_b, version=1, status="confirmed")
        product_c = self.make_product(
            batch_two,
            sku="LIB-001",
            name="缎带 C",
        )
        self.make_revision(product_c, version=1, status="draft")

        by_sku = self.client.get("/api/product-library?q=LIB-001").json()
        self.assertEqual(
            {item["id"] for item in by_sku},
            {product_a.id, product_c.id},
        )
        by_name = self.client.get("/api/product-library?q=蝴蝶结").json()
        self.assertEqual([item["id"] for item in by_name], [product_b.id])
        by_status = self.client.get(
            "/api/product-library?status=confirmed"
        ).json()
        self.assertEqual([item["id"] for item in by_status], [product_b.id])
        by_batch = self.client.get(
            f"/api/product-library?batch_id={batch_two.id}"
        ).json()
        self.assertEqual([item["id"] for item in by_batch], [product_c.id])
        combined = self.client.get(
            f"/api/product-library?status=needs_review&batch_id={batch_one.id}"
        ).json()
        self.assertEqual([item["id"] for item in combined], [product_a.id])

        latest = next(
            item for item in by_sku if item["id"] == product_a.id
        )
        self.assertEqual(latest["current_version"], 2)
        self.assertEqual(latest["revision_status"], "needs_review")
        self.assertEqual(latest["latest_revision"]["source"], "legacy_backfill")
        self.assertEqual(
            latest["latest_revision"]["snapshot"]["sku"],
            "LIB-001",
        )

    def test_revision_history_is_descending_and_current_is_max(self):
        batch = self.make_batch()
        product = self.make_product(batch, sku="LIB-010", name="版本产品")
        for version, status in (
            (1, "draft"),
            (3, "confirmed"),
            (2, "needs_review"),
        ):
            self.make_revision(product, version=version, status=status)

        response = self.client.get(
            f"/api/products/{product.id}/revisions"
        )

        self.assertEqual(response.status_code, 200)
        data = response.json()
        self.assertEqual(
            [item["version"] for item in data["revisions"]],
            [3, 2, 1],
        )
        self.assertEqual(data["current_version"], 3)
        self.assertEqual(data["revision_status"], "confirmed")
        self.assertEqual(data["revision_state"], "versioned")
        self.assertEqual(
            data["revisions"][0]["snapshot"]["sku"],
            "LIB-010",
        )
        self.assertEqual(
            data["revisions"][0]["source"],
            "legacy_backfill",
        )

    def test_unbuilt_product_and_missing_product(self):
        batch = self.make_batch()
        product = self.make_product(batch, sku="LIB-020", name="无版本产品")

        response = self.client.get(
            f"/api/products/{product.id}/revisions"
        )
        self.assertEqual(response.status_code, 200)
        data = response.json()
        self.assertEqual(data["revisions"], [])
        self.assertIsNone(data["current_version"])
        self.assertIsNone(data["revision_status"])
        self.assertEqual(data["revision_state"], "unbuilt")

        missing = self.client.get(
            "/api/products/does-not-exist/revisions"
        )
        self.assertEqual(missing.status_code, 404)
        self.assertIn("detail", missing.json())

    def test_unknown_status_filter_is_400_not_500(self):
        response = self.client.get(
            "/api/product-library?status=unexpected"
        )

        self.assertEqual(response.status_code, 400)
        self.assertIn("detail", response.json())

    def test_existing_endpoints_remain_available(self):
        self.assertEqual(self.client.get("/api/health").status_code, 200)
        self.assertEqual(self.client.get("/api/tasks").status_code, 200)
        self.assertEqual(self.client.get("/api/agents").status_code, 200)
