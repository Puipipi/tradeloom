from __future__ import annotations

import json
from concurrent.futures import ThreadPoolExecutor
from threading import Barrier

from django.db import close_old_connections, connection
from django.test import Client, TestCase, TransactionTestCase
from django.utils import timezone

from workbench.models import HumanReview
from workbench.tests.test_review_submission import create_pending_review


class DuplicateSkuCompatibilityRegressionTests(TestCase):
    def test_generic_note_review_without_signal_keeps_legacy_submission_contract(self):
        _, _, _, _, workflow, _, _, review = create_pending_review()
        metadata = dict(review.source_conflict)
        refs = dict(metadata["source_refs"])
        refs.pop("signal", None)
        refs.pop("duplicate_sku_group", None)
        metadata["source_refs"] = refs
        review.source_conflict = metadata
        review.save(update_fields=["source_conflict"])

        response = self.client.post(
            f"/api/workflow-tasks/{workflow.id}/reviews/{review.id}/submit",
            data=json.dumps({
                "review_key": review.review_key,
                "answer": {"note": "legacy generic note"},
                "reviewer": "operator-one",
            }),
            content_type="application/json",
        )

        self.assertEqual(response.status_code, 200, response.content)
        review.refresh_from_db()
        self.assertEqual(review.status, "submitted")
        self.assertEqual(review.answer["response"], {"note": "legacy generic note"})

    def test_existing_missing_sku_literal_rejects_raw_value_over_model_limit(self):
        _, _, _, _, workflow, _, _, review = create_pending_review()
        metadata = dict(review.source_conflict)
        refs = dict(metadata["source_refs"])
        refs["signal"] = {"missing_field": "sku"}
        metadata["source_refs"] = refs
        review.source_conflict = metadata
        review.save(update_fields=["source_conflict"])

        response = self.client.post(
            f"/api/workflow-tasks/{workflow.id}/reviews/{review.id}/submit",
            data=json.dumps({
                "review_key": review.review_key,
                "answer": {
                    "type": "set_literal_field",
                    "field": "sku",
                    "value": ("S" * 120) + " ",
                },
                "reviewer": "operator-one",
            }),
            content_type="application/json",
        )

        self.assertEqual(response.status_code, 409, response.content)
        review.refresh_from_db()
        self.assertEqual(review.status, "pending")

class DuplicateSkuWorkflowIntegrationTests(TransactionTestCase):
    """Run duplicate decisions through persisted workflow sources and public APIs."""

    def setUp(self):
        from pathlib import Path
        import tempfile
        from django.test import override_settings

        self.temp = tempfile.TemporaryDirectory(prefix="phase3-duplicate-sku-")
        root = Path(self.temp.name)
        (root / "media").mkdir()
        (root / "artifacts").mkdir()
        self._settings = override_settings(
            MEDIA_ROOT=root / "media",
            TRADELOOM_ARTIFACT_ROOT=root / "artifacts",
        )
        self._settings.enable()
        demo = self.client.post("/api/tasks/demo")
        self.assertEqual(demo.status_code, 200, demo.content)
        self.batch_id = demo.json()["id"]
        from workbench.models import Product

        self.products = list(Product.objects.filter(task_id=self.batch_id).order_by("position", "id"))
        self.assertGreaterEqual(len(self.products), 2)
        first, second = self.products[:2]
        changed = self.client.patch(
            f"/api/products/{second.id}",
            data=json.dumps({"sku": first.sku}),
            content_type="application/json",
        )
        self.assertEqual(changed.status_code, 200, changed.content)
        from workbench.workflows.prepare import create_prepared_workflow

        self.workflow = create_prepared_workflow(
            batch_id=self.batch_id,
            user_goal="核对重复货号并生成交付",
        )
        self._dispatch_visible_target()
        self.reviews = list(HumanReview.objects.filter(task=self.workflow).order_by("created_at", "id"))
        self.duplicate_reviews = [
            review for review in self.reviews
            if review.source_conflict.get("source_refs", {}).get("signal", {}).get("uncertainty") == "duplicate_sku"
        ]
        self.assertEqual(len(self.duplicate_reviews), 2)

    def tearDown(self):
        self._settings.disable()
        self.temp.cleanup()

    def _dispatch_visible_target(self):
        page = self.client.get(f"/workflow-tasks/{self.workflow.id}")
        self.assertEqual(page.status_code, 200, page.content)
        target = page.context["dispatch_target"]
        self.assertIsNotNone(target)
        response = self.client.post(
            target["url"],
            data=json.dumps({"idempotency_key": target["idempotency_key"]}),
            content_type="application/json",
        )
        self.assertEqual(response.status_code, 200, response.content)
        return response

    def _submit(self, review, answer, *, client=None, workflow_id=None):
        workflow_id = workflow_id or self.workflow.id
        return (client or self.client).post(
            f"/api/workflow-tasks/{workflow_id}/reviews/{review.id}/submit",
            data=json.dumps({
                "review_key": review.review_key,
                "answer": answer,
                "reviewer": "phase3-human",
            }),
            content_type="application/json",
        )

    def _answer_review(self, review):
        refs = review.source_conflict["source_refs"]
        signal = refs["signal"]
        if signal.get("uncertainty") == "duplicate_sku":
            value = "ITEM-REASSIGNED" if review.id == self.duplicate_reviews[-1].id else refs["duplicate_sku_group"]["sku"]
            return {"type": "resolve_duplicate_sku", "value": value}
        if signal.get("uncertainty") == "current_revision_not_confirmed":
            return {"type": "confirm_current_revision", "revision_id": refs["revision_id"]}
        if signal.get("missing_field"):
            field = signal["missing_field"]
            return {"type": "set_literal_field", "field": field, "value": {
                "material": "Phase3 synthetic material",
                "english_name": "Phase3 Item",
                "sku": "ITEM-MISSING",
            }.get(field, "Phase3 value")}
        return {"type": "confirm_current_revision", "revision_id": refs["revision_id"]}

    def test_real_source_duplicate_partial_rejection_apply_resume_delivery_and_replay(self):
        from workbench.models import Product, ProductRevision, SubTask, WorkflowStep

        self.assertEqual(len(self.reviews), 7)
        original_source = [json.loads(json.dumps(review.source_conflict)) for review in self.reviews]
        subtask_ids = list(SubTask.objects.filter(task=self.workflow).order_by("agent_role").values_list("id", flat=True))
        original_image_ids = {
            item["source_refs"]["product_id"]: item["source_refs"].get("task_file_ids", [])
            for item in original_source
            if item.get("source_refs", {}).get("product_id")
        }
        first, last = self.duplicate_reviews
        original_sku = first.source_conflict["source_refs"]["duplicate_sku_group"]["sku"]
        first_response = self._submit(first, {"type": "resolve_duplicate_sku", "value": original_sku})
        self.assertEqual(first_response.status_code, 200, first_response.content)
        first.refresh_from_db()
        first_receipt = json.loads(json.dumps(first.answer))
        rejected = self._submit(last, {"type": "resolve_duplicate_sku", "value": original_sku})
        self.assertEqual(rejected.status_code, 409, rejected.content)
        last.refresh_from_db()
        self.assertEqual(last.status, "pending")
        corrected = self._submit(last, {"type": "resolve_duplicate_sku", "value": " ITEM-REASSIGNED "})
        self.assertEqual(corrected.status_code, 200, corrected.content)
        last.refresh_from_db()
        self.assertEqual(last.answer["response"]["value"], " ITEM-REASSIGNED ")
        for review in self.reviews:
            if review.id in {first.id, last.id}:
                continue
            submitted = self._submit(review, self._answer_review(review))
            self.assertEqual(submitted.status_code, 200, submitted.content)

        apply_response = self.client.post(
            f"/api/workflow-tasks/{self.workflow.id}/reviews/apply",
            data=json.dumps({
                "review_ids": [review.id for review in self.reviews],
                "idempotency_key": "phase3-duplicate-apply",
                "decision": "apply_and_confirm",
                "reviewer": "phase3-human",
            }),
            content_type="application/json",
        )
        self.assertEqual(apply_response.status_code, 200, apply_response.content)
        self.assertEqual(list(SubTask.objects.filter(task=self.workflow).order_by("agent_role").values_list("id", flat=True)), subtask_ids)
        self.assertEqual(list(SubTask.objects.filter(task=self.workflow).order_by("agent_role").values_list("agent_role", flat=True)), ["delivery_quality", "product_profile"])
        for review, source in zip(self.reviews, original_source):
            review.refresh_from_db()
            self.assertEqual(review.source_conflict, source)
        first.refresh_from_db()
        self.assertEqual(first.answer, first_receipt)
        first_product_id = first.source_conflict["source_refs"]["product_id"]
        last_product_id = last.source_conflict["source_refs"]["product_id"]
        self.assertEqual(Product.objects.get(pk=first_product_id).sku.strip(), original_sku)
        self.assertEqual(Product.objects.get(pk=last_product_id).sku, "ITEM-REASSIGNED")
        for product in self.products[:2]:
            product.refresh_from_db()
            latest = ProductRevision.objects.filter(product=product).order_by("-version").first()
            self.assertIn(latest.source_refs["image"]["task_file_id"], original_image_ids[product.id])
        applied_page = self.client.get(f"/workflow-tasks/{self.workflow.id}")
        self.assertEqual(applied_page.status_code, 200)
        self.assertContains(applied_page, "人工货号裁决（已应用）")
        self.assertContains(applied_page, " ITEM-REASSIGNED ")

        # Exact same-key receipt replay remains stable after application.
        replay = self._submit(first, {"type": "resolve_duplicate_sku", "value": original_sku})
        self.assertEqual(replay.status_code, 200, replay.content)
        self.assertEqual(replay.json()["answer"], first_receipt)
        self._dispatch_visible_target()  # resumed product_profile
        self._dispatch_visible_target()  # delivery_quality
        completed = self.client.post(
            f"/api/workflow-tasks/{self.workflow.id}/deliverables",
            data=json.dumps({"idempotency_key": "phase3-duplicate-delivery"}),
            content_type="application/json",
        )
        self.assertEqual(completed.status_code, 200, completed.content)
        self.assertEqual(completed.json()["status"], "completed")
        self.assertEqual(completed.json()["quality_status"], "passed")
        steps = list(WorkflowStep.objects.filter(task=self.workflow, step_key__startswith="subtask:"))
        self.assertEqual(len(steps), 3)
        self.assertTrue(all(step.status == "completed" for step in steps))

    def test_nonreviewed_third_product_collision_rejected_before_receipt(self):
        from workbench.models import Product, ProductRevision

        third = Product.objects.create(
            task_id=self.batch_id, position=99, sku="THIRD-KEEP", name="Third", category="accessory",
            material="cotton", size="25mm", color="blue", image_filename="third.png",
            image_stored_name="third.png", missing_fields=[], created_at=timezone.now(), updated_at=timezone.now(),
        )
        ProductRevision.objects.create(product=third, version=1, snapshot={
            "sku": third.sku, "name": third.name, "category": third.category, "material": third.material,
            "size": third.size, "color": third.color, "image_filename": third.image_filename,
            "image_stored_name": third.image_stored_name, "english_name": "Third",
        }, status="confirmed")
        review = self.duplicate_reviews[0]
        response = self._submit(review, {"type": "resolve_duplicate_sku", "value": "THIRD-KEEP"})
        self.assertEqual(response.status_code, 409, response.content)
        self.assertIn("重复", response.json().get("detail", ""))
        review.refresh_from_db()
        self.assertEqual(review.status, "pending")

    def test_duplicate_review_page_shows_frozen_group_and_apply_target_only_for_current_cycle(self):
        review = self.duplicate_reviews[0]
        refs = review.source_conflict["source_refs"]
        group = refs["duplicate_sku_group"]
        response = self.client.get(f"/workflow-tasks/{self.workflow.id}")
        self.assertEqual(response.status_code, 200)
        self.assertContains(response, 'data-answer-type="resolve_duplicate_sku"')
        self.assertContains(response, 'maxlength="120"')
        self.assertContains(response, group["sku"])
        self.assertContains(response, "应用资料时去除货号首尾空白；原始回执保留输入原文。保留原货号时，请重新输入。")
        for member in group["members"]:
            self.assertContains(response, member["product_id"])
            self.assertContains(response, member["revision_id"])
        self.assertIsNone(response.context["apply_review_target"])

        for item in self.reviews:
            submitted = self._submit(item, self._answer_review(item))
            self.assertEqual(submitted.status_code, 200, submitted.content)
        page = self.client.get(f"/workflow-tasks/{self.workflow.id}")
        target = page.context["apply_review_target"]
        self.assertIsNotNone(target)
        self.assertEqual(target["review_ids"], sorted(item.id for item in self.reviews))
        second_page = self.client.get(f"/workflow-tasks/{self.workflow.id}")
        self.assertEqual(
            second_page.context["apply_review_target"]["idempotency_key"],
            target["idempotency_key"],
        )

    def test_two_workflows_cannot_reuse_other_cycle_answers_after_fullbatch_apply(self):
        from workbench.models import ProductRevision
        from workbench.workflows.prepare import create_prepared_workflow

        second_workflow = create_prepared_workflow(batch_id=self.batch_id, user_goal="second workflow stale source")
        page = self.client.get(f"/workflow-tasks/{second_workflow.id}")
        target = page.context["dispatch_target"]
        dispatched = self.client.post(target["url"], data=json.dumps({"idempotency_key": target["idempotency_key"]}), content_type="application/json")
        self.assertEqual(dispatched.status_code, 200, dispatched.content)
        second_reviews = list(HumanReview.objects.filter(task=second_workflow).order_by("created_at", "id"))
        self.assertEqual(len(second_reviews), 7)
        # The first workflow completes all answers and advances the complete source batch.
        for review in self.reviews:
            response = self._submit(review, self._answer_review(review))
            self.assertEqual(response.status_code, 200, response.content)
        applied = self.client.post(f"/api/workflow-tasks/{self.workflow.id}/reviews/apply", data=json.dumps({
            "review_ids": [r.id for r in self.reviews], "idempotency_key": "phase3-first-wf-apply",
            "decision": "apply_and_confirm", "reviewer": "phase3-human",
        }), content_type="application/json")
        self.assertEqual(applied.status_code, 200, applied.content)
        pending = second_reviews[0]
        stale = self._submit(pending, self._answer_review(pending), workflow_id=second_workflow.id)
        self.assertEqual(stale.status_code, 409, stale.content)
        pending.refresh_from_db()
        self.assertEqual(pending.status, "pending")



    def test_concurrent_duplicate_reviews_for_same_candidate_save_only_one(self):
        if connection.vendor != "postgresql":
            self.skipTest("并发 SKU 预检要求 PostgreSQL 行锁")
        barrier = Barrier(2)
        target = "SAME-CONCURRENT-SKU"

        def submit(review):
            close_old_connections()
            try:
                client = Client()
                barrier.wait(timeout=10)
                return self._submit(
                    review,
                    {"type": "resolve_duplicate_sku", "value": target},
                    client=client,
                ).status_code
            finally:
                connection.close()

        with ThreadPoolExecutor(max_workers=2) as pool:
            statuses = list(pool.map(submit, self.duplicate_reviews))
        self.assertEqual(sorted(statuses), [200, 409])
        persisted = list(HumanReview.objects.filter(id__in=[r.id for r in self.duplicate_reviews]).order_by("id"))
        self.assertEqual(sum(review.status == "submitted" for review in persisted), 1)
        self.assertEqual(sum(review.status == "pending" for review in persisted), 1)
