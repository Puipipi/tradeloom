from __future__ import annotations

import json
from concurrent.futures import ThreadPoolExecutor
from threading import Barrier
from unittest.mock import patch

from django.db import close_old_connections, connection
from django.test import Client, TestCase, TransactionTestCase
from django.utils import timezone
from django.middleware.csrf import _get_new_csrf_string

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
from workbench.workflows.orchestrator import (
    CompletionGateError,
    DependencyNotReady,
    WorkflowOrchestrator,
)


def create_pending_review():
    now = timezone.now()
    batch = Task.objects.create(
        title="Task13a review fixture",
        mode="demo",
        status="confirmed",
        created_at=now,
        updated_at=now,
    )
    product = Product.objects.create(
        task=batch,
        position=0,
        sku="TL-13A",
        name="演示商品",
        category="配件",
        material="",
        size="25mm",
        color="蓝色",
        image_filename="TL-13A.png",
        image_stored_name="TL-13A.png",
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
            "material": "",
            "size": product.size,
            "color": product.color,
            "image_filename": product.image_filename,
            "english_name": "",
        },
        status="confirmed",
    )
    file = TaskFile.objects.create(
        task=batch,
        kind="image",
        original_name="TL-13A.png",
        stored_name="TL-13A.png",
        created_at=now,
    )
    workflow = WorkflowTask.objects.create(
        batch=batch,
        user_goal="核对演示资料",
        task_type="prepare_product_data",
        status="queued",
    )
    engine = WorkflowOrchestrator()
    engine.plan_task(workflow.id)
    subtask = SubTask.objects.get(task=workflow, agent_role="product_profile")
    engine.dispatch_subtask(subtask.id, "task13a-product-dispatch")
    review = HumanReview.objects.filter(task=workflow, status="pending").first()
    assert review is not None
    return batch, product, revision, file, workflow, engine, subtask, review


class ReviewSubmissionTests(TestCase):
    def setUp(self):
        (
            self.batch,
            self.product,
            self.revision,
            self.file,
            self.workflow,
            self.engine,
            self.subtask,
            self.review,
        ) = create_pending_review()
        self.url = (
            f"/api/workflow-tasks/{self.workflow.id}/reviews/"
            f"{self.review.id}/submit"
        )
        self.payload = {
            "review_key": self.review.review_key,
            "answer": {"response": "资料已核实"},
            "reviewer": "local-operator",
        }

    def post(self, payload=None, *, client=None):
        return (client or self.client).post(
            self.url,
            data=json.dumps(self.payload if payload is None else payload),
            content_type="application/json",
        )

    def test_real_pending_review_submission_returns_and_replays_receipt(self):
        response = self.post()
        self.assertEqual(response.status_code, 200)
        receipt = response.json()
        self.review.refresh_from_db()
        self.assertEqual(self.review.status, "submitted")
        self.assertEqual(self.review.reviewer, "local-operator")
        self.assertEqual(receipt["answer"]["response"]["response"], "资料已核实")
        self.assertEqual(receipt["answer"]["source_refs"]["revision_id"], self.revision.id)
        self.assertEqual(receipt["answer"]["source_refs"]["task_file_ids"], [self.file.id])
        self.assertEqual(receipt["answer"]["request_fingerprint"], self.review.answer["request_fingerprint"])
        submitted_at = receipt["answer"]["submitted_at"]
        self.assertTrue(submitted_at)
        self.assertEqual(EventLog.objects.filter(task=self.workflow, event_type="human_review_submitted").count(), 1)

        ProductRevision.objects.create(
            product=self.product,
            version=2,
            snapshot={"sku": self.product.sku, "material": "已变化"},
            status="draft",
        )

        response = self.post()
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["answer"], receipt["answer"])
        self.assertEqual(response.json()["answer"]["submitted_at"], submitted_at)
        self.assertEqual(EventLog.objects.filter(task=self.workflow, event_type="human_review_submitted").count(), 1)
        detail = self.client.get(f"/api/workflow-tasks/{self.workflow.id}").json()
        self.assertEqual(detail["pending_review_count"], HumanReview.objects.filter(task=self.workflow, status="pending").count())
        self.assertEqual(detail["unresolved_review_count"], HumanReview.objects.filter(task=self.workflow, status__in=["pending", "submitted"]).count())

    def test_different_submission_cannot_overwrite_receipt(self):
        self.assertEqual(self.post().status_code, 200)
        changed = {**self.payload, "answer": {"response": "另一答案"}}
        self.assertEqual(self.post(changed).status_code, 409)
        changed_reviewer = {**self.payload, "reviewer": "another-operator"}
        self.assertEqual(self.post(changed_reviewer).status_code, 409)
        self.review.refresh_from_db()
        self.assertEqual(self.review.answer["response"]["response"], "资料已核实")
        self.assertEqual(EventLog.objects.filter(task=self.workflow, event_type="human_review_submitted").count(), 1)

    def test_submission_does_not_apply_facts_or_resume_workflow(self):
        self.subtask.refresh_from_db()
        product_before = (self.product.material, self.product.updated_at)
        revision_before = (self.revision.snapshot, self.revision.status)
        subtask_before = (self.subtask.status, self.subtask.output_refs)
        steps_before = list(WorkflowStep.objects.filter(task=self.workflow).values_list("id", "status", "attempt"))
        self.assertEqual(self.post().status_code, 200)
        self.product.refresh_from_db()
        self.revision.refresh_from_db()
        self.subtask.refresh_from_db()
        self.workflow.refresh_from_db()
        self.assertEqual((self.product.material, self.product.updated_at), product_before)
        self.assertEqual((self.revision.snapshot, self.revision.status), revision_before)
        self.assertEqual((self.subtask.status, self.subtask.output_refs), subtask_before)
        self.assertEqual(self.workflow.status, "waiting_human")
        self.assertEqual(list(WorkflowStep.objects.filter(task=self.workflow).values_list("id", "status", "attempt")), steps_before)
        with self.assertRaises(DependencyNotReady):
            self.engine.resume_task(self.workflow.id)
        delivery = SubTask.objects.get(task=self.workflow, agent_role="delivery_quality")
        with self.assertRaises(DependencyNotReady):
            self.engine.dispatch_subtask(delivery.id, "task13a-must-remain-blocked")
        with self.assertRaises(CompletionGateError):
            self.engine.complete_workflow(self.workflow.id)

    def test_unknown_review_and_foreign_workflow_are_not_found(self):
        other_batch, *_ = create_pending_review()
        other_workflow = WorkflowTask.objects.filter(batch=other_batch).first()
        foreign = self.client.post(
            f"/api/workflow-tasks/{other_workflow.id}/reviews/{self.review.id}/submit",
            data=json.dumps(self.payload),
            content_type="application/json",
        )
        missing = self.client.post(
            f"/api/workflow-tasks/{self.workflow.id}/reviews/unknown-review/submit",
            data=json.dumps(self.payload),
            content_type="application/json",
        )
        self.assertEqual(foreign.status_code, 404)
        self.assertEqual(missing.status_code, 404)

    def test_submission_rejects_invalid_json_shape_and_readonly_fields(self):
        cases = [
            (b"{", "application/json"),
            (json.dumps([]), "application/json"),
            (json.dumps({**self.payload, "extra": "x"}), "application/json"),
            (json.dumps({**self.payload, "answer": {}}), "application/json"),
            (json.dumps({**self.payload, "answer": []}), "application/json"),
            (json.dumps({**self.payload, "review_key": " "}), "application/json"),
            (json.dumps({**self.payload, "reviewer": "x" * 121}), "application/json"),
            (json.dumps({**self.payload, "status": "approved"}), "application/json"),
            ('{"review_key":"x","answer":{"n":NaN},"reviewer":"x"}', "application/json"),
            ('{"review_key":"x","answer":{"n":Infinity},"reviewer":"x"}', "application/json"),
            (json.dumps({**self.payload, "reviewer": " "}), "application/json"),
        ]
        for body, content_type in cases:
            with self.subTest(body=str(body)[:50]):
                response = self.client.post(self.url, data=body, content_type=content_type)
                self.assertEqual(response.status_code, 422)
        self.review.refresh_from_db()
        self.assertEqual(self.review.status, "pending")
        self.assertFalse(EventLog.objects.filter(task=self.workflow, event_type="human_review_submitted").exists())

    def test_review_key_mismatch_and_stale_sources_conflict_without_partial_write(self):
        wrong_key = {**self.payload, "review_key": "another-key"}
        self.assertEqual(self.post(wrong_key).status_code, 409)
        ProductRevision.objects.create(
            product=self.product,
            version=2,
            snapshot={"sku": self.product.sku},
            status="draft",
        )
        response = self.post()
        self.assertEqual(response.status_code, 409)
        self.review.refresh_from_db()
        self.assertEqual(self.review.status, "pending")
        self.assertEqual(self.review.answer, {})
        self.assertFalse(EventLog.objects.filter(task=self.workflow, event_type="human_review_submitted").exists())

    def test_pending_review_only_accepts_waiting_human_workflow(self):
        self.workflow.status = "running"
        self.workflow.save(update_fields=["status"])
        response = self.post()
        self.assertEqual(response.status_code, 409)
        self.review.refresh_from_db()
        self.assertEqual(self.review.status, "pending")
        self.assertFalse(EventLog.objects.filter(task=self.workflow, event_type="human_review_submitted").exists())

    def test_foreign_file_and_unproven_result_source_are_rejected(self):
        foreign_batch = Task.objects.create(
            title="外批次", mode="demo", status="confirmed",
            created_at=timezone.now(), updated_at=timezone.now(),
        )
        foreign_file = TaskFile.objects.create(
            task=foreign_batch, kind="image", original_name="foreign.png",
            stored_name="foreign.png", created_at=timezone.now(),
        )
        foreign_product = Product.objects.create(
            task=foreign_batch,
            position=0,
            sku="FOREIGN-13A",
            name="外批次商品",
            category="配件",
            material="涤纶",
            size="10mm",
            color="红色",
            image_filename="FOREIGN-13A.png",
            created_at=timezone.now(),
            updated_at=timezone.now(),
        )
        foreign_revision = ProductRevision.objects.create(
            product=foreign_product,
            version=1,
            snapshot={"sku": foreign_product.sku},
            status="confirmed",
        )
        metadata = dict(self.review.source_conflict)
        refs = dict(metadata["source_refs"])
        refs["task_file_ids"] = [foreign_file.id]
        metadata["source_refs"] = refs
        self.review.source_conflict = metadata
        self.review.save(update_fields=["source_conflict"])
        self.assertEqual(self.post().status_code, 409)
        refs["product_id"] = foreign_product.id
        refs["revision_id"] = foreign_revision.id
        refs["task_file_ids"] = []
        metadata["source_refs"] = refs
        self.review.source_conflict = metadata
        self.review.save(update_fields=["source_conflict"])
        self.assertEqual(self.post().status_code, 409)
        metadata["source_refs"] = {
            "workflow_task_id": self.workflow.id,
            "batch_id": self.batch.id,
            "product_ids": [self.product.id],
            "revision_ids": [self.revision.id],
            "task_file_ids": [self.file.id],
        }
        self.file.delete()
        self.review.source_conflict = metadata
        self.review.save(update_fields=["source_conflict"])
        self.assertEqual(self.post().status_code, 409)
        metadata["result_ref"] = "subtask:unknown:output_refs.result"
        self.review.source_conflict = metadata
        self.review.save(update_fields=["source_conflict"])
        self.assertEqual(self.post().status_code, 409)
        self.review.refresh_from_db()
        self.assertEqual(self.review.status, "pending")
        self.assertFalse(EventLog.objects.filter(task=self.workflow, event_type="human_review_submitted").exists())

    def test_baseline_revision_ids_are_rechecked(self):
        metadata = dict(self.review.source_conflict)
        metadata["source_refs"] = {
            "workflow_task_id": self.workflow.id,
            "batch_id": self.batch.id,
            "product_ids": [self.product.id],
            "revision_ids": [self.revision.id],
            "task_file_ids": [self.file.id],
        }
        self.review.source_conflict = metadata
        self.review.save(update_fields=["source_conflict"])
        self.assertEqual(self.post().status_code, 200)
        receipt = self.review.__class__.objects.get(pk=self.review.id).answer
        self.assertEqual(receipt["source_refs"]["revision_ids"], [self.revision.id])

        stale_batch, stale_product, stale_revision, stale_file, stale_wf, _engine, _subtask, stale_review = create_pending_review()
        ProductRevision.objects.create(
            product=stale_product, version=2, snapshot={"sku": stale_product.sku}, status="draft"
        )
        source = dict(stale_review.source_conflict)
        source["source_refs"] = {
            "workflow_task_id": stale_wf.id,
            "batch_id": stale_batch.id,
            "product_ids": [stale_product.id],
            "revision_ids": [stale_revision.id],
            "task_file_ids": [stale_file.id],
        }
        stale_review.source_conflict = source
        stale_review.save(update_fields=["source_conflict"])
        response = self.client.post(
            f"/api/workflow-tasks/{stale_wf.id}/reviews/{stale_review.id}/submit",
            data=json.dumps({"review_key": stale_review.review_key, "answer": {"x": 1}, "reviewer": "op"}),
            content_type="application/json",
        )
        self.assertEqual(response.status_code, 409)

    def test_same_batch_revision_for_another_product_is_rejected(self):
        other = Product.objects.create(
            task=self.batch,
            position=2,
            sku="OTHER-13A",
            name="另一商品",
            category="配件",
            material="涤纶",
            size="10mm",
            color="红色",
            image_filename="OTHER-13A.png",
            created_at=timezone.now(),
            updated_at=timezone.now(),
        )
        wrong_revision = ProductRevision.objects.create(
            product=other,
            version=1,
            snapshot={"sku": other.sku},
            status="confirmed",
        )
        metadata = dict(self.review.source_conflict)
        refs = dict(metadata["source_refs"])
        refs["revision_id"] = wrong_revision.id
        metadata["source_refs"] = refs
        self.review.source_conflict = metadata
        self.review.save(update_fields=["source_conflict"])
        response = self.post()
        self.assertEqual(response.status_code, 409)
        self.review.refresh_from_db()
        self.assertEqual(self.review.status, "pending")

    def test_csrf_method_and_event_failure_rollback(self):
        self.assertEqual(self.client.get(self.url).status_code, 405)
        csrf_client = Client(enforce_csrf_checks=True)
        self.assertEqual(
            csrf_client.post(self.url, data=json.dumps(self.payload), content_type="application/json").status_code,
            403,
        )
        token = _get_new_csrf_string()
        csrf_client.cookies["csrftoken"] = token
        allowed = csrf_client.post(
            self.url,
            data=json.dumps(self.payload),
            content_type="application/json",
            HTTP_X_CSRFTOKEN=token,
        )
        self.assertEqual(allowed.status_code, 200)

        _batch, _product, _revision, _file, wf, _engine, _subtask, review = create_pending_review()
        url = f"/api/workflow-tasks/{wf.id}/reviews/{review.id}/submit"
        with patch("workbench.workflows.reviews.record_workflow_event", side_effect=RuntimeError("event write failed")):
            with self.assertRaisesRegex(RuntimeError, "event write failed"):
                self.client.post(url, data=json.dumps({"review_key": review.review_key, "answer": {"x": 1}, "reviewer": "op"}), content_type="application/json")
        review.refresh_from_db()
        self.assertEqual(review.status, "pending")
        self.assertEqual(review.answer, {})
        self.assertFalse(EventLog.objects.filter(task=wf, event_type="human_review_submitted").exists())

    def test_get_includes_reviews_and_counts_without_writing(self):
        before_events = EventLog.objects.filter(task=self.workflow).count()
        before_updated_at = self.review.updated_at
        review_count = HumanReview.objects.filter(task=self.workflow).count()
        response = self.client.get(f"/api/workflow-tasks/{self.workflow.id}")
        self.assertEqual(response.status_code, 200)
        payload = response.json()
        self.assertEqual(payload["pending_review_count"], review_count)
        self.assertEqual(payload["unresolved_review_count"], review_count)
        self.assertEqual(payload["reviews"][0]["id"], self.review.id)
        self.assertEqual(payload["reviews"][0]["status"], "pending")
        self.assertEqual(payload["reviews_scope"], "business_facts")
        self.assertEqual(
            set(payload["reviews"][0]),
            {
                "id", "review_key", "item_ref", "question", "options", "status",
                "answer", "reviewer", "created_at", "updated_at", "source_refs",
            },
        )
        self.assertEqual(payload["reviews"][0]["source_refs"]["revision_id"], self.revision.id)
        self.review.refresh_from_db()
        self.assertEqual(self.review.updated_at, before_updated_at)
        self.assertEqual(EventLog.objects.filter(task=self.workflow).count(), before_events)

    def test_submitted_review_blocks_dispatch_resume_and_complete_gates(self):
        self.assertEqual(self.post().status_code, 200)
        HumanReview.objects.filter(task=self.workflow, status="pending").update(status="resolved")
        self.workflow.status = "running"
        self.workflow.save(update_fields=["status"])
        self.subtask.status = "completed"
        self.subtask.save(update_fields=["status"])
        delivery = SubTask.objects.get(task=self.workflow, agent_role="delivery_quality")
        with self.assertRaisesRegex(DependencyNotReady, "未解决"):
            self.engine.dispatch_subtask(delivery.id, "task13a-submitted-dispatch-gate")
        with self.assertRaisesRegex(DependencyNotReady, "未解决"):
            self.engine.resume_task(self.workflow.id)
        delivery.status = "completed"
        delivery.save(update_fields=["status"])
        with self.assertRaisesRegex(CompletionGateError, "未解决"):
            self.engine.complete_workflow(self.workflow.id)


class ReviewSubmissionConcurrencyTests(TransactionTestCase):
    reset_sequences = True

    def test_two_postgres_connections_create_one_receipt_and_event(self):
        if connection.vendor != "postgresql":
            self.skipTest("此并发验收要求 PostgreSQL 行锁")
        batch, _product, _revision, _file, workflow, _engine, _subtask, review = create_pending_review()
        url = f"/api/workflow-tasks/{workflow.id}/reviews/{review.id}/submit"
        payload = json.dumps({
            "review_key": review.review_key,
            "answer": {"response": "并发核实"},
            "reviewer": "local-operator",
        })
        barrier = Barrier(2)

        def submit_once(_index):
            close_old_connections()
            try:
                client = Client()
                barrier.wait(timeout=10)
                response = client.post(url, data=payload, content_type="application/json")
                return response.status_code
            finally:
                connection.close()

        with ThreadPoolExecutor(max_workers=2) as pool:
            statuses = list(pool.map(submit_once, range(2)))
        self.assertEqual(statuses, [200, 200])
        self.assertEqual(HumanReview.objects.get(pk=review.id).status, "submitted")
        self.assertEqual(EventLog.objects.filter(task=workflow, event_type="human_review_submitted").count(), 1)
