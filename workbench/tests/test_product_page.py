from __future__ import annotations

from django.test import TestCase
from django.utils import timezone

from workbench.models import Product, ProductRevision, Task


class ProductPageTests(TestCase):
    def make_batch(self, *, title: str = "同名演示批次") -> Task:
        now = timezone.now()
        return Task.objects.create(
            title=title,
            mode="demo",
            status="awaiting_confirmation",
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
        source: str,
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
            source_refs={"source": source},
        )

    def test_filters_retain_params_and_use_latest_status(self):
        batch_one = self.make_batch()
        batch_two = self.make_batch()
        product_a = self.make_product(
            batch_one,
            sku="PAGE-001",
            name="缎带页面",
        )
        self.make_revision(
            product_a,
            version=1,
            status="draft",
            source="legacy_backfill",
        )
        self.make_revision(
            product_a,
            version=2,
            status="needs_review",
            source="legacy_product",
        )
        product_b = self.make_product(
            batch_two,
            sku="PAGE-002",
            name="蝴蝶结页面",
        )
        self.make_revision(
            product_b,
            version=1,
            status="confirmed",
            source="legacy_product",
        )

        response = self.client.get(
            f"/products?q=PAGE-001&state=needs_review&batch={batch_one.id}"
        )

        self.assertEqual(response.status_code, 200)
        self.assertContains(response, "PAGE-001")
        self.assertNotContains(response, "PAGE-002")
        self.assertContains(response, 'value="PAGE-001"')
        self.assertContains(response, 'value="needs_review" selected')
        self.assertContains(response, f'value="{batch_one.id}" selected')
        self.assertContains(response, 'data-testid="product-result-count"')
        self.assertContains(response, "1 个产品匹配当前筛选")
        self.assertContains(response, batch_one.id[:8])
        self.assertContains(response, "待确认")
        self.assertContains(response, 'data-testid="clear-product-filter"')

    def test_clear_and_zero_results(self):
        batch = self.make_batch()
        product = self.make_product(batch, sku="PAGE-010", name="清空筛选产品")
        self.make_revision(
            product,
            version=1,
            status="confirmed",
            source="legacy_backfill",
        )

        empty = self.client.get("/products?q=NO-MATCH")
        self.assertEqual(empty.status_code, 200)
        self.assertContains(empty, "没有符合筛选条件的产品")
        self.assertContains(empty, 'data-testid="clear-product-filter"')

        all_products = self.client.get("/products")
        self.assertEqual(all_products.status_code, 200)
        self.assertContains(all_products, "PAGE-010")

    def test_version_history_renders_real_revisions(self):
        batch = self.make_batch()
        product = self.make_product(
            batch,
            sku="HIST-001",
            name="版本历史产品",
        )
        self.make_revision(
            product,
            version=1,
            status="draft",
            source="legacy_backfill",
        )
        self.make_revision(
            product,
            version=2,
            status="confirmed",
            source="legacy_product",
        )

        response = self.client.get("/products?q=HIST-001")

        self.assertContains(
            response,
            f'data-testid="version-history-{product.id}"',
        )
        self.assertContains(response, "版本历史（2）")
        self.assertContains(response, "v2")
        self.assertContains(response, "v1")
        self.assertContains(response, "已确认")
        self.assertContains(response, "草稿")
        self.assertContains(response, "产品资料更新")
        self.assertContains(response, "历史数据补录")
        self.assertContains(response, "版本历史产品")
        self.assertNotContains(response, "download")

    def test_product_html_is_escaped(self):
        batch = self.make_batch()
        product = self.make_product(
            batch,
            sku="ESC-001",
            name="<script>alert(1)</script>",
        )
        self.make_revision(
            product,
            version=1,
            status="confirmed",
            source="legacy_backfill",
        )

        response = self.client.get("/products?q=ESC-001")

        self.assertContains(response, "&lt;script&gt;alert(1)&lt;/script&gt;")
        self.assertNotContains(response, "<script>alert(1)</script>")

    def test_unknown_state_is_empty_not_500(self):
        response = self.client.get("/products?state=unexpected")

        self.assertEqual(response.status_code, 200)
        self.assertContains(response, "未知状态筛选")
        self.assertContains(response, "没有符合筛选条件的产品")


class EmptyLibraryPageTests(TestCase):
    def test_empty_library_prompts_import_not_filter_reset(self):
        response = self.client.get("/products")

        self.assertEqual(response.status_code, 200)
        self.assertContains(response, "尚未导入产品资料")
        self.assertContains(response, 'data-testid="import-products-link"')
        self.assertContains(response, 'href="/tasks/new"')
        self.assertContains(response, "新建任务 / 导入产品")
        self.assertNotContains(response, "没有符合筛选条件的产品")
        self.assertNotContains(response, "清空筛选")
        self.assertNotContains(response, 'data-testid="clear-product-filter"')
