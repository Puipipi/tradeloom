from __future__ import annotations

import json
import copy
from concurrent.futures import ThreadPoolExecutor
from threading import Barrier

from django.db import close_old_connections
from django.test import Client, TestCase, TransactionTestCase
from django.utils import timezone
from unittest.mock import patch

from workbench.models import (
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
from workbench.workflows.orchestrator import WorkflowOrchestrator
from workbench.agents.runtime import RetryableExecutionError
from workbench.workflows.orchestrator import RetryLimitReached


class ReviewApplicationTests(TestCase):
    def setUp(self):
        now = timezone.now()
        self.batch = Task.objects.create(
            title="Task13b facts fixture",
            mode="demo",
            status="confirmed",
            created_at=now,
            updated_at=now,
        )
        self.product = Product.objects.create(
            task=self.batch,
            position=0,
            sku="TL-13B",
            name="演示商品",
            category="配件",
            material="",
            size="25mm",
            color="蓝色",
            image_filename="TL-13B.png",
            image_stored_name="TL-13B.png",
            missing_fields=["材质"],
            created_at=now,
            updated_at=now,
        )
        self.revision = ProductRevision.objects.create(
            product=self.product,
            version=1,
            snapshot={
                "sku": self.product.sku,
                "name": self.product.name,
                "category": self.product.category,
                "material": "",
                "size": self.product.size,
                "color": self.product.color,
                "image_filename": self.product.image_filename,
                "english_name": "",
                "custom_note": "retain-this",
            },
            status="confirmed",
        )
        self.image = TaskFile.objects.create(
            task=self.batch,
            kind="image",
            original_name="TL-13B.png",
            stored_name="TL-13B.png",
            created_at=now,
        )
        self.revision.source_refs = {
            "image": {
                "task_file_id": self.image.id,
                "original_name": self.image.original_name,
                "stored_name": self.image.stored_name,
            }
        }
        self.revision.save(update_fields=["source_refs"])
        self.workflow = WorkflowTask.objects.create(
            batch=self.batch,
            user_goal="补齐演示商品基础资料",
            task_type="prepare_product_data",
            status="queued",
        )
        self.engine = WorkflowOrchestrator()
        self.engine.plan_task(self.workflow.id)
        self.product_subtask = SubTask.objects.get(
            task=self.workflow,
            agent_role="product_profile",
        )
        self.engine.dispatch_subtask(self.product_subtask.id, "task13b-product-first")
        self.reviews = list(
            HumanReview.objects.filter(task=self.workflow).order_by("id")
        )
        for review in self.reviews:
            signal = review.source_conflict["source_refs"]["signal"]
            field_name = signal["missing_field"]
            value = {
                "material": "cotton",
                "english_name": "Ribbon",
            }[field_name]
            response = self.client.post(
                f"/api/workflow-tasks/{self.workflow.id}/reviews/{review.id}/submit",
                data=json.dumps(
                    {
                        "review_key": review.review_key,
                        "answer": {
                            "type": "set_literal_field",
                            "field": field_name,
                            "value": value,
                        },
                        "reviewer": "operator-one",
                    }
                ),
                content_type="application/json",
            )
            self.assertEqual(response.status_code, 200, response.content)

    def test_apply_typed_facts_creates_confirmed_revision_and_prepares_resume(self):
        before_revision_id = self.revision.id
        response = self.client.post(
            f"/api/workflow-tasks/{self.workflow.id}/reviews/apply",
            data=json.dumps(
                {
                    "review_ids": [review.id for review in self.reviews],
                    "idempotency_key": "task13b-apply-once",
                    "decision": "apply_and_confirm",
                    "reviewer": "operator-one",
                }
            ),
            content_type="application/json",
        )

        self.assertEqual(response.status_code, 200, response.content)
        self.product.refresh_from_db()
        self.workflow.refresh_from_db()
        self.product_subtask.refresh_from_db()
        revisions = list(
            ProductRevision.objects.filter(product=self.product).order_by("version")
        )
        self.assertEqual(self.product.material, "cotton")
        self.assertEqual(len(revisions), 2)
        self.assertEqual(revisions[0].id, before_revision_id)
        self.assertEqual(revisions[1].snapshot["english_name"], "Ribbon")
        self.assertEqual(revisions[1].snapshot["custom_note"], "retain-this")
        self.assertEqual(revisions[1].status, "confirmed")
        self.assertEqual(revisions[1].reviewer, "operator-one")
        self.product.refresh_from_db()
        self.assertEqual(self.product.missing_fields, [])
        for review in self.reviews:
            field_name = review.source_conflict["source_refs"]["signal"]["missing_field"]
            self.assertEqual(
                revisions[1].field_sources[field_name],
                f"human_review:{review.id}",
            )
        self.assertEqual(
            revisions[1].source_refs["cycle_review_ids"],
            sorted(review.id for review in self.reviews),
        )
        self.assertTrue(
            all(
                review.status == "approved"
                for review in HumanReview.objects.filter(task=self.workflow)
            )
        )
        self.assertEqual(self.workflow.status, "running")
        self.assertEqual(self.workflow.current_step, "product_profile")
        self.assertEqual(self.product_subtask.status, "queued")
        self.assertEqual(self.product_subtask.output_refs, {})
        self.assertEqual(self.workflow.result_refs["subtasks"], {})
        self.assertEqual(
            WorkflowStep.objects.get(
                task=self.workflow,
                step_key=f"subtask:{self.product_subtask.id}",
                attempt=1,
            ).output_refs["result_snapshot"]["result"]["status"],
            "needs_human",
        )
        for review in HumanReview.objects.filter(task=self.workflow):
            replay = self.client.post(
                f"/api/workflow-tasks/{self.workflow.id}/reviews/{review.id}/submit",
                data=json.dumps(
                    {
                        "review_key": review.review_key,
                        "answer": review.answer["response"],
                        "reviewer": review.reviewer,
                    }
                ),
                content_type="application/json",
            )
            self.assertEqual(replay.status_code, 200, replay.content)
            self.assertEqual(replay.json()["status"], "submitted")
        self.assertEqual(
            WorkflowStep.objects.filter(
                task=self.workflow,
                step_key="center_plan",
            ).count(),
            2,
        )
        self.assertEqual(
            EventLog.objects.filter(
                task=self.workflow,
                event_type="human_review_cycle_applied",
            ).count(),
            1,
        )

        detail = self.client.get(f"/workflow-tasks/{self.workflow.id}")
        self.assertContains(detail, "本批基础资料已由操作人明确确认并应用")
        self.assertContains(detail, "执行下一步（本地模拟）")
        target = detail.context["dispatch_target"]
        self.assertIsNotNone(target)
        self.assertIn(":resume:", target["idempotency_key"])
        product_attempt_count = WorkflowStep.objects.filter(
            task=self.workflow,
            step_key=f"subtask:{self.product_subtask.id}",
        ).count()
        dispatched = self.client.post(
            target["url"],
            data=json.dumps({"idempotency_key": target["idempotency_key"]}),
            content_type="application/json",
        )
        self.assertEqual(dispatched.status_code, 200, dispatched.content)
        self.assertEqual(
            WorkflowStep.objects.filter(
                task=self.workflow,
                step_key=f"subtask:{self.product_subtask.id}",
            ).count(),
            product_attempt_count + 1,
        )
        detail = self.client.get(f"/workflow-tasks/{self.workflow.id}")
        delivery_target = detail.context["dispatch_target"]
        self.assertIsNotNone(delivery_target)
        self.assertIn(":prior:none:attempt:1", delivery_target["idempotency_key"])
        delivery = SubTask.objects.get(task=self.workflow, agent_role="delivery_quality")
        dispatched_delivery = self.client.post(
            delivery_target["url"],
            data=json.dumps({"idempotency_key": delivery_target["idempotency_key"]}),
            content_type="application/json",
        )
        self.assertEqual(dispatched_delivery.status_code, 200, dispatched_delivery.content)
        self.assertEqual(
            WorkflowStep.objects.filter(task=self.workflow, step_key=f"subtask:{delivery.id}").count(),
            1,
        )
        replay = self.client.post(
            target["url"],
            data=json.dumps({"idempotency_key": target["idempotency_key"]}),
            content_type="application/json",
        )
        self.assertEqual(replay.status_code, 200, replay.content)
        self.assertEqual(
            WorkflowStep.objects.filter(
                task=self.workflow,
                step_key=f"subtask:{self.product_subtask.id}",
            ).count(),
            product_attempt_count + 1,
        )

    def test_review_detail_shows_typed_receipts_and_explicit_apply_control(self):
        historical_refs = dict(self.reviews[0].source_conflict["source_refs"])
        historical_refs["signal"] = {"missing_field": "material"}
        HumanReview.objects.create(
            task=self.workflow,
            item_ref=f"product:{self.product.id}",
            question="历史周期已提交材质",
            status="approved",
            review_key="historical-approved-other-origin",
            reviewer="previous-operator",
            answer={
                "response": {
                    "type": "set_literal_field",
                    "field": "material",
                    "value": "previous material",
                },
                "request_fingerprint": "historical-answer-fingerprint",
            },
            source_conflict={
                "kind": "missing_field:material",
                "issue_key": "missing_field:material",
                "origin_step_id": "historical-origin-step-not-current-cycle",
                "source_refs": historical_refs,
            },
        )
        response = self.client.get(f"/workflow-tasks/{self.workflow.id}")

        self.assertEqual(response.status_code, 200)
        self.assertContains(response, 'data-testid="review-typed-form"', count=0)
        self.assertContains(response, 'data-testid="review-cycle-apply"')
        self.assertContains(response, "应用并确认本批基础资料")
        self.assertContains(response, "待应用")
        self.assertContains(response, "cotton")
        self.assertContains(response, "Ribbon")
        self.assertContains(response, self.revision.id)
        self.assertContains(response, 'name="reviewer"')
        self.assertContains(response, 'data-apply-refresh')
        target = response.context["apply_review_target"]
        self.assertEqual(target["review_ids"], sorted(review.id for review in self.reviews))
        self.assertLessEqual(len(target["idempotency_key"]), 200)
        self.assertIn(target["idempotency_key"], response.content.decode())
        replay_view = self.client.get(f"/workflow-tasks/{self.workflow.id}")
        self.assertEqual(
            target["idempotency_key"],
            replay_view.context["apply_review_target"]["idempotency_key"],
        )

    def test_pending_typed_reviews_render_literal_and_revision_confirmation_forms(self):
        for review in self.reviews:
            review.status = "pending"
            review.answer = {}
            review.reviewer = ""
            review.save(update_fields=["status", "answer", "reviewer"])
        confirm_review = HumanReview.objects.create(
            task=self.workflow,
            item_ref=f"product:{self.product.id}",
            question="确认当前基础资料版本",
            status="pending",
            review_key="revision-confirm-ui",
            source_conflict={
                "kind": "uncertainty:current_revision_not_confirmed",
                "issue_key": "uncertainty:current_revision_not_confirmed",
                "subtask_id": self.product_subtask.id,
                "origin_step_id": WorkflowStep.objects.get(
                    task=self.workflow, step_key=f"subtask:{self.product_subtask.id}"
                ).id,
                "result_ref": "workflow_step:origin:output_refs.result_snapshot",
                "source_refs": {
                    **self.reviews[0].source_conflict["source_refs"],
                    "signal": {"uncertainty": "current_revision_not_confirmed"},
                },
            },
        )

        response = self.client.get(f"/workflow-tasks/{self.workflow.id}")

        self.assertEqual(response.status_code, 200)
        self.assertContains(response, 'data-testid="review-typed-form"', count=3)
        self.assertContains(response, 'name="value" value=""')
        self.assertContains(response, 'name="value" value="" maxlength="200"')
        self.assertContains(response, 'type="checkbox" name="confirmed" value="yes" required')
        self.assertContains(response, "确认此冻结版本中的基础资料")
        self.assertContains(response, 'data-review-refresh')
        self.assertContains(response, self.product.id)
        self.assertContains(response, self.revision.id)
        self.assertNotContains(response, 'data-testid="review-cycle-apply"')
        html = response.content.decode()
        english_form = html.split('data-field="english_name"', 1)[1].split("</form>", 1)[0]
        english_value_input = english_form.split('name="value"', 1)[1].split(">", 1)[0]
        self.assertNotIn('maxlength="', english_value_input)
        self.assertIsNotNone(confirm_review)

    def test_human_resume_attempt_does_not_consume_retry_budget(self):
        apply = self._apply_request("task13b-retry-budget-apply")
        self.assertEqual(apply.status_code, 200, apply.content)
        apply_step = WorkflowStep.objects.get(
            task=self.workflow, step_key="apply_review_cycle"
        )
        authority = apply_step.output_refs["resume_authority"][self.product_subtask.id]
        resume_key = (
            f"workflow:{self.workflow.id}:subtask:{self.product_subtask.id}:resume:"
            f"{apply_step.id}:prior:{authority['expected_prior_step_id']}:"
            f"attempt:{authority['next_attempt']}"
        )

        class FailingRuntime:
            supports_safe_retry = True

            def __init__(inner_self):
                inner_self.calls = 0

            def run_subtask(inner_self, _subtask_id):
                inner_self.calls += 1
                raise RetryableExecutionError()

        runtime = FailingRuntime()
        engine = WorkflowOrchestrator(runtime)
        prior = WorkflowStep.objects.get(pk=authority["expected_prior_step_id"])
        with self.assertRaises(RetryableExecutionError):
            engine.dispatch_subtask(self.product_subtask.id, resume_key)
        latest = WorkflowStep.objects.filter(
            task=self.workflow, step_key=f"subtask:{self.product_subtask.id}"
        ).order_by("-attempt").first()
        self.product_subtask.refresh_from_db()
        self.assertEqual(latest.attempt, prior.attempt + 1)
        self.assertEqual(self.product_subtask.retry_count, 0)

        with self.assertRaises(RetryableExecutionError):
            engine.retry_subtask(
                self.product_subtask.id,
                "task13b-retry-budget-1",
                expected_step_id=latest.id,
            )
        step_three = WorkflowStep.objects.filter(
            task=self.workflow, step_key=f"subtask:{self.product_subtask.id}"
        ).order_by("-attempt").first()
        self.product_subtask.refresh_from_db()
        self.assertEqual(step_three.attempt, 3)
        self.assertEqual(self.product_subtask.retry_count, 1)
        calls_after_first_retry = runtime.calls

        with self.assertRaises(RetryableExecutionError):
            engine.retry_subtask(
                self.product_subtask.id,
                "task13b-retry-budget-2",
                expected_step_id=step_three.id,
            )
        step_four = WorkflowStep.objects.filter(
            task=self.workflow, step_key=f"subtask:{self.product_subtask.id}"
        ).order_by("-attempt").first()
        self.product_subtask.refresh_from_db()
        self.assertEqual(step_four.attempt, 4)
        self.assertEqual(self.product_subtask.retry_count, 2)
        calls_after_second_retry = runtime.calls

        replay = engine.retry_subtask(
            self.product_subtask.id,
            "task13b-retry-budget-1",
            expected_step_id=latest.id,
        )
        self.assertEqual(replay.id, self.product_subtask.id)
        self.assertEqual(runtime.calls, calls_after_second_retry)
        self.assertGreater(calls_after_second_retry, calls_after_first_retry)
        with self.assertRaises(RetryLimitReached):
            engine.retry_subtask(
                self.product_subtask.id,
                "task13b-retry-budget-3",
                expected_step_id=step_four.id,
            )
        self.assertEqual(
            WorkflowStep.objects.filter(
                task=self.workflow,
                step_key=f"subtask:{self.product_subtask.id}",
            ).count(),
            4,
        )

    def _apply_request(self, key):
        return self.client.post(
            f"/api/workflow-tasks/{self.workflow.id}/reviews/apply",
            data=json.dumps(
                {
                    "review_ids": [review.id for review in self.reviews],
                    "idempotency_key": key,
                    "decision": "apply_and_confirm",
                    "reviewer": "operator-one",
                }
            ),
            content_type="application/json",
        )

    def test_note_only_answer_blocks_entire_cycle_without_approving_siblings(self):
        note_review = self.reviews[0]
        note_review.answer = {
            **note_review.answer,
            "response": {"note": "请人工核对"},
        }
        note_review.save(update_fields=["answer"])

        response = self._apply_request("task13b-note-block")

        self.assertEqual(response.status_code, 409, response.content)
        self.assertEqual(
            ProductRevision.objects.filter(product=self.product).count(),
            1,
        )
        self.assertTrue(
            all(review.status == "submitted" for review in HumanReview.objects.filter(task=self.workflow))
        )
        self.workflow.refresh_from_db()
        self.assertEqual(self.workflow.status, "waiting_human")

    def test_changed_image_metadata_blocks_apply(self):
        self.image.stored_name = "unexpected.png"
        self.image.save(update_fields=["stored_name"])

        response = self._apply_request("task13b-image-metadata-change")

        self.assertEqual(response.status_code, 409, response.content)
        self.assertEqual(ProductRevision.objects.filter(product=self.product).count(), 1)
        self.assertTrue(
            all(review.status == "submitted" for review in HumanReview.objects.filter(task=self.workflow))
        )

    def test_changed_reviewed_revision_status_blocks_apply(self):
        revision = ProductRevision.objects.get(pk=self.revision.id)
        revision.status = "needs_review"
        revision.save(update_fields=["status"])

        response = self._apply_request("task13b-reviewed-status-change")

        self.assertEqual(response.status_code, 409, response.content)
        self.assertEqual(ProductRevision.objects.filter(product=self.product).count(), 1)
        self.assertTrue(
            all(review.status == "submitted" for review in HumanReview.objects.filter(task=self.workflow))
        )

    def test_changed_reviewed_revision_image_source_blocks_apply(self):
        revision = ProductRevision.objects.get(pk=self.revision.id)
        revision.source_refs = {
            **revision.source_refs,
            "image": {
                **revision.source_refs["image"],
                "stored_name": "different-source.png",
            },
        }
        revision.save(update_fields=["source_refs"])

        response = self._apply_request("task13b-reviewed-source-change")

        self.assertEqual(response.status_code, 409, response.content)
        self.assertEqual(ProductRevision.objects.filter(product=self.product).count(), 1)

    def test_200_character_apply_key_does_not_overflow_appended_plan_key(self):
        key = "k" * 200
        response = self._apply_request(key)

        self.assertEqual(response.status_code, 200, response.content)
        plan = WorkflowStep.objects.get(task=self.workflow, step_key="center_plan", attempt=2)
        self.assertLessEqual(len(plan.idempotency_key), 200)
        self.assertEqual(
            WorkflowStep.objects.get(task=self.workflow, step_key="apply_review_cycle").idempotency_key,
            key,
        )

    def test_invalid_typed_shapes_and_overlength_legacy_value_are_rejected_without_writes(self):
        material_review = next(
            review
            for review in self.reviews
            if review.source_conflict["source_refs"]["signal"].get("missing_field") == "material"
        )
        original_answer = copy.deepcopy(material_review.answer)
        invalid_responses = [
            {"type": "set_literal_field", "field": "english_name", "value": "Wrong signal"},
            {"type": "set_literal_field", "field": "material", "value": "cotton", "extra": True},
            {"type": "set_literal_field", "field": "unsupported_business_rule", "value": "x"},
            {"type": "set_literal_field", "field": "material", "value": 42},
            {"type": "confirm_current_revision", "revision_id": self.revision.id},
        ]
        for index, invalid_response in enumerate(invalid_responses):
            with self.subTest(response=invalid_response):
                material_review.answer = {
                    **original_answer,
                    "response": invalid_response,
                }
                material_review.save(update_fields=["answer"])
                response = self._apply_request(f"task13b-invalid-shape-{index}")
                self.assertEqual(response.status_code, 409, response.content)
                self.assertEqual(ProductRevision.objects.filter(product=self.product).count(), 1)
                self.assertTrue(
                    all(review.status == "submitted" for review in HumanReview.objects.filter(task=self.workflow))
                )
        material_review.answer = original_answer
        material_review.save(update_fields=["answer"])
        material_field = Product._meta.get_field("material")
        material_review.answer = {
            **original_answer,
            "response": {
                "type": "set_literal_field",
                "field": "material",
                "value": "x" * (material_field.max_length + 1),
            },
        }
        material_review.save(update_fields=["answer"])
        response = self._apply_request("task13b-overlength-field")
        self.assertEqual(response.status_code, 409, response.content)
        self.assertEqual(ProductRevision.objects.filter(product=self.product).count(), 1)

    def test_batch_product_set_change_blocks_cycle_before_mutation(self):
        Product.objects.create(
            task=self.batch,
            position=1,
            sku="TL-13B-2",
            name="新增商品",
            category="配件",
            material="cotton",
            size="25mm",
            color="蓝色",
            image_filename="TL-13B-2.png",
            image_stored_name="TL-13B-2.png",
            missing_fields=[],
            created_at=timezone.now(),
            updated_at=timezone.now(),
        )

        response = self._apply_request("task13b-stale-batch")

        self.assertEqual(response.status_code, 409, response.content)
        self.assertEqual(
            ProductRevision.objects.filter(product=self.product).count(),
            1,
        )
        self.workflow.refresh_from_db()
        self.assertEqual(self.workflow.status, "waiting_human")

    def test_unreviewed_product_revision_change_blocks_apply(self):
        now = timezone.now()
        batch = Task.objects.create(
            title="Two product revision CAS fixture",
            mode="demo",
            status="confirmed",
            created_at=now,
            updated_at=now,
        )
        products = []
        for position, sku, english_name in (
            (0, "CAS-A", ""),
            (1, "CAS-B", "Second Item"),
        ):
            product = Product.objects.create(
                task=batch,
                position=position,
                sku=sku,
                name=f"商品 {sku}",
                category="配件",
                material="cotton",
                size="25mm",
                color="蓝色",
                image_filename=f"{sku}.png",
                image_stored_name=f"{sku}.png",
                missing_fields=[],
                created_at=now,
                updated_at=now,
            )
            revision = ProductRevision.objects.create(
                product=product,
                version=1,
                snapshot={
                    "sku": product.sku,
                    "name": product.name,
                    "category": product.category,
                    "material": product.material,
                    "size": product.size,
                    "color": product.color,
                    "image_filename": product.image_filename,
                    "image_stored_name": product.image_stored_name,
                    "english_name": english_name,
                },
                status="confirmed",
            )
            image_file = TaskFile.objects.create(
                task=batch,
                kind="image",
                original_name=f"{sku}.png",
                stored_name=f"{sku}.png",
                created_at=now,
            )
            revision.source_refs = {
                "image": {
                    "task_file_id": image_file.id,
                    "original_name": image_file.original_name,
                    "stored_name": image_file.stored_name,
                }
            }
            revision.save(update_fields=["source_refs"])
            products.append(product)

        workflow = WorkflowTask.objects.create(
            batch=batch,
            user_goal="核实英文名",
            task_type="prepare_product_data",
            status="queued",
        )
        engine = WorkflowOrchestrator()
        engine.plan_task(workflow.id)
        product_subtask = SubTask.objects.get(task=workflow, agent_role="product_profile")
        engine.dispatch_subtask(product_subtask.id, "revision-cas-first")
        reviews = list(HumanReview.objects.filter(task=workflow))
        self.assertEqual(len(reviews), 1)
        self.assertEqual(reviews[0].source_conflict["source_refs"]["product_id"], products[0].id)
        submitted = self.client.post(
            f"/api/workflow-tasks/{workflow.id}/reviews/{reviews[0].id}/submit",
            data=json.dumps(
                {
                    "review_key": reviews[0].review_key,
                    "answer": {
                        "type": "set_literal_field",
                        "field": "english_name",
                        "value": "First Item",
                    },
                    "reviewer": "operator-one",
                }
            ),
            content_type="application/json",
        )
        self.assertEqual(submitted.status_code, 200, submitted.content)
        submitted_review = HumanReview.objects.get(pk=reviews[0].pk)

        changed = self.client.patch(
            f"/api/products/{products[1].id}",
            data=json.dumps({"name": "商品 CAS-B 已修改"}),
            content_type="application/json",
        )
        self.assertEqual(changed.status_code, 200, changed.content)
        confirmed = self.client.post(f"/api/tasks/{batch.id}/confirm")
        self.assertEqual(confirmed.status_code, 200, confirmed.content)
        self.assertEqual(
            ProductRevision.objects.filter(product=products[0]).order_by("-version").first().id,
            submitted_review.answer["source_refs"]["revision_id"],
        )
        latest_b = ProductRevision.objects.filter(product=products[1]).order_by("-version").first()
        self.assertEqual(latest_b.status, "confirmed")
        # The legacy PATCH/confirm path above creates a new confirmed revision.
        # Preserve a complete human-confirmed snapshot while advancing that
        # unreviewed product's version to isolate full-batch revision CAS.
        refreshed_snapshot = dict(latest_b.snapshot)
        refreshed_snapshot["english_name"] = "Second Item"
        latest_b = ProductRevision.objects.create(
            product=products[1],
            version=latest_b.version + 1,
            snapshot=refreshed_snapshot,
            field_sources=latest_b.field_sources,
            status="confirmed",
            source_refs=latest_b.source_refs,
            reviewer="operator-two",
        )
        self.assertTrue(all(latest_b.snapshot.get(key) for key in ("sku", "name", "category", "material", "size", "color", "image_filename", "english_name")))
        before_apply_revision = ProductRevision.objects.filter(product=products[1]).order_by("-version").first()

        response = self.client.post(
            f"/api/workflow-tasks/{workflow.id}/reviews/apply",
            data=json.dumps(
                {
                    "review_ids": [reviews[0].id],
                    "idempotency_key": "revision-cas-apply",
                    "decision": "apply_and_confirm",
                    "reviewer": "operator-one",
                }
            ),
            content_type="application/json",
        )

        self.assertEqual(response.status_code, 409, response.content)
        after_apply_revision = ProductRevision.objects.filter(product=products[1]).order_by("-version").first()
        self.assertEqual(after_apply_revision.id, before_apply_revision.id)
        workflow.refresh_from_db()
        self.assertEqual(workflow.status, "waiting_human")

    def test_late_event_failure_rolls_back_the_entire_application_and_hides_exception(self):
        self.product.refresh_from_db()
        self.workflow.refresh_from_db()
        self.batch.refresh_from_db()
        before_event_count = EventLog.objects.filter(task=self.workflow).count()
        before_step_ids = list(
            WorkflowStep.objects.filter(task=self.workflow).order_by("id").values_list("id", flat=True)
        )
        before_plan_ids = list(
            WorkflowStep.objects.filter(task=self.workflow, step_key="center_plan").values_list("id", flat=True)
        )
        before_review_answers = {
            review.id: copy.deepcopy(review.answer)
            for review in HumanReview.objects.filter(task=self.workflow)
        }
        before_batch_status = self.batch.status
        before_revision = ProductRevision.objects.get(pk=self.revision.id)
        self.product_subtask.refresh_from_db()
        before_subtask_refs = copy.deepcopy(self.product_subtask.output_refs)
        with patch(
            "workbench.workflows.fact_application.EventLog.objects.create",
            side_effect=RuntimeError("private-transaction-marker"),
        ):
            response = self._apply_request("task13b-atomic-failure")

        self.assertEqual(response.status_code, 500, response.content)
        self.assertNotIn(b"private-transaction-marker", response.content)
        self.product.refresh_from_db()
        self.workflow.refresh_from_db()
        self.batch.refresh_from_db()
        self.product_subtask.refresh_from_db()
        self.assertEqual(self.product.material, "")
        self.assertEqual(ProductRevision.objects.filter(product=self.product).count(), 1)
        self.assertTrue(
            all(review.status == "submitted" for review in HumanReview.objects.filter(task=self.workflow))
        )
        self.assertEqual(self.workflow.status, "waiting_human")
        self.assertEqual(self.batch.status, before_batch_status)
        self.assertEqual(self.product_subtask.status, "waiting_human")
        self.assertEqual(self.product_subtask.output_refs, before_subtask_refs)
        self.assertEqual(
            list(WorkflowStep.objects.filter(task=self.workflow).order_by("id").values_list("id", flat=True)),
            before_step_ids,
        )
        self.assertEqual(
            list(WorkflowStep.objects.filter(task=self.workflow, step_key="center_plan").values_list("id", flat=True)),
            before_plan_ids,
        )
        self.assertEqual(
            {review.id: review.answer for review in HumanReview.objects.filter(task=self.workflow)},
            before_review_answers,
        )
        before_revision.refresh_from_db()
        self.assertEqual(before_revision.status, "confirmed")
        self.assertEqual(EventLog.objects.filter(task=self.workflow).count(), before_event_count)


class ConcurrentReviewApplicationTests(TransactionTestCase):
    reset_sequences = True

    def setUp(self):
        ReviewApplicationTests.setUp(self)

    def test_same_and_competing_apply_keys_commit_only_one_cycle(self):
        barrier = Barrier(2)
        body_template = {
            "review_ids": [review.id for review in self.reviews],
            "decision": "apply_and_confirm",
            "reviewer": "operator-one",
        }

        def post_apply(key):
            close_old_connections()
            try:
                client = Client()
                body = {**body_template, "idempotency_key": key}
                barrier.wait(timeout=10)
                response = client.post(
                    f"/api/workflow-tasks/{self.workflow.id}/reviews/apply",
                    data=json.dumps(body),
                    content_type="application/json",
                )
                return response.status_code, response.content
            finally:
                close_old_connections()

        with ThreadPoolExecutor(max_workers=2) as executor:
            results = list(
                executor.map(
                    post_apply,
                    ("task13b-concurrent-same", "task13b-concurrent-other"),
                )
            )

        self.assertEqual(sorted(status for status, _ in results), [200, 409])
        self.assertEqual(
            WorkflowStep.objects.filter(task=self.workflow, step_key="apply_review_cycle").count(),
            1,
        )
        self.assertEqual(
            EventLog.objects.filter(
                task=self.workflow,
                event_type="human_review_cycle_applied",
            ).count(),
            1,
        )
        self.assertTrue(
            all(review.status == "approved" for review in HumanReview.objects.filter(task=self.workflow))
        )

    def test_concurrent_same_key_returns_one_committed_receipt(self):
        barrier = Barrier(2)
        body = {
            "review_ids": [review.id for review in self.reviews],
            "idempotency_key": "task13b-concurrent-same-only",
            "decision": "apply_and_confirm",
            "reviewer": "operator-one",
        }

        def post_apply(_index):
            close_old_connections()
            try:
                barrier.wait(timeout=10)
                response = Client().post(
                    f"/api/workflow-tasks/{self.workflow.id}/reviews/apply",
                    data=json.dumps(body),
                    content_type="application/json",
                )
                return response.status_code, response.json()
            finally:
                close_old_connections()

        with ThreadPoolExecutor(max_workers=2) as executor:
            results = list(executor.map(post_apply, (0, 1)))

        self.assertEqual([status for status, _ in results], [200, 200])
        self.assertEqual(results[0][1], results[1][1])
        self.assertEqual(
            WorkflowStep.objects.filter(task=self.workflow, step_key="apply_review_cycle").count(),
            1,
        )
        self.assertEqual(
            EventLog.objects.filter(
                task=self.workflow,
                event_type="human_review_cycle_applied",
            ).count(),
            1,
        )

