import re

from django.test import TestCase
from django.utils import timezone

from workbench.models import HumanReview, Product, ProductRevision, Task, WorkflowStep
from workbench.workflows.prepare import create_prepared_workflow


class EnglishNameHintTests(TestCase):
    def test_hint_uses_latest_revision_in_workflow_batch_and_escapes_product_values(self):
        now = timezone.now()
        batch = Task.objects.create(
            title="English name hint batch", mode="demo", status="confirmed",
            created_at=now, updated_at=now,
        )
        product = Product.objects.create(
            task=batch, position=0, sku="<script>SKU</script>", name="Ribbon <b>",
            category="trim", material="polyester", size="25mm", color="red",
            image_filename="", missing_fields=[], created_at=now, updated_at=now,
        )
        ProductRevision.objects.create(
            product=product, version=1, status="confirmed",
            snapshot={
                "sku": product.sku, "name": product.name, "category": "trim",
                "material": "polyester", "size": "25mm", "color": "red",
                "english_name": "Old English value",
            },
        )
        workflow = create_prepared_workflow(
            batch_id=batch.id, user_goal="Prepare the product catalog",
        )
        old_revision = ProductRevision.objects.get(product=product, version=1)
        old_review = HumanReview.objects.create(
            task=workflow, item_ref=f"product:{product.id}", question="Confirm English name",
            options=[], status="approved", reviewer="operator",
            answer={"response": {"type": "set_literal_field", "field": "english_name", "value": "Old English value"}},
            source_conflict={
                "origin_step_id": "historical-step",
                "source_refs": {
                    "product_id": product.id, "revision_id": old_revision.id,
                    "signal": {"missing_field": "english_name"},
                },
            },
        )
        WorkflowStep.objects.create(
            task=workflow, step_key="apply_review_cycle", status="completed",
            output_refs={"review_ids": [old_review.id]},
        )
        ProductRevision.objects.create(
            product=product, version=2, status="draft",
            snapshot={
                "sku": product.sku, "name": product.name, "category": "trim",
                "material": "polyester", "size": "25mm", "color": "red",
                "english_name": "  ",
            },
        )
        other_batch = Task.objects.create(
            title="Other English name hint batch", mode="demo", status="confirmed",
            created_at=now, updated_at=now,
        )
        Product.objects.create(
            task=other_batch, position=0, sku="FOREIGN-BATCH-SKU", name="Other batch product",
            category="trim", material="polyester", size="25mm", color="red",
            image_filename="", missing_fields=[], created_at=now, updated_at=now,
        )

        response = self.client.get(f"/workflow-tasks/{workflow.id}")

        self.assertEqual(response.status_code, 200)
        self.assertContains(response, "英文名称待补充")
        self.assertContains(response, "href=\"#reviews-heading\"")
        self.assertIn(b"&lt;script&gt;SKU&lt;/script&gt;", response.content)
        self.assertIn(b"Ribbon &lt;b&gt;", response.content)
        self.assertNotIn(b"<script>SKU</script>", response.content)
        hint = re.search(
            rb'<aside[^>]*data-testid="english-name-hints".*?</aside>',
            response.content,
            re.DOTALL,
        )
        self.assertIsNotNone(hint)
        self.assertNotIn(b"Old English value", hint.group(0))
        self.assertNotContains(response, "FOREIGN-BATCH-SKU")

        for version, english_name in ((3, None), (4, 123), (5, False)):
            with self.subTest(english_name=english_name):
                ProductRevision.objects.create(
                    product=product, version=version, status="draft",
                    snapshot={
                        "sku": product.sku, "name": product.name, "category": "trim",
                        "material": "polyester", "size": "25mm", "color": "red",
                        "english_name": english_name,
                    },
                )
                response = self.client.get(f"/workflow-tasks/{workflow.id}")
                self.assertContains(response, "英文名称待补充")

