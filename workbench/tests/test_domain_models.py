from __future__ import annotations

from django.core.exceptions import ValidationError
from django.db import IntegrityError, transaction
from django.db.models.deletion import ProtectedError
from django.test import TestCase
from django.utils import timezone

from workbench.models import (
    Artifact,
    ArtifactVersion,
    EventLog,
    HumanReview,
    BatchItem,
    SubTask,
    Task,
    WorkflowStep,
    WorkflowTask,
)


def make_batch(title: str = "批次", status: str = "awaiting_confirmation") -> Task:
    now = timezone.now()
    return Task.objects.create(
        title=title,
        mode="demo",
        status=status,
        created_at=now,
        updated_at=now,
    )


def make_product(
    batch: Task,
    *,
    sku: str = "SKU-001",
    position: int = 0,
) -> BatchItem:
    now = timezone.now()
    return BatchItem.objects.create(
        task=batch,
        position=position,
        sku=sku,
        name="样品",
        category="丝带",
        material="涤纶",
        size="25mm",
        color="红色",
        image_filename=f"{sku}.svg",
        missing_fields=[],
        created_at=now,
        updated_at=now,
    )


def make_workflow_task(batch: Task) -> WorkflowTask:
    return WorkflowTask.objects.create(
        batch=batch,
        user_goal="生成英文目录",
        task_type="prepare_product_data",
        status="queued",
        current_step="plan",
    )


class DomainModelTests(TestCase):

    def test_workflow_task_and_step_get_default_timestamps(self):
        batch = make_batch()
        task = make_workflow_task(batch)
        step = WorkflowStep.objects.create(
            task=task,
            step_key="plan",
            status="running",
            idempotency_key="plan-1",
        )

        self.assertIsNotNone(task.created_at)
        self.assertIsNotNone(task.updated_at)
        self.assertEqual(task.result_refs, {})
        self.assertEqual(step.attempt, 1)
        self.assertIsNotNone(step.created_at)
        self.assertIsNotNone(step.updated_at)
        self.assertEqual(step.task_id, task.id)


    def test_artifact_version_is_unique_per_artifact(self):
        batch = make_batch()
        task = make_workflow_task(batch)
        artifact = Artifact.objects.create(
            task=task,
            artifact_type="catalog",
            storage_key="catalog/v1",
        )
        ArtifactVersion.objects.create(
            artifact=artifact,
            version=1,
            file_path="data/runtime/artifacts/catalog-1.html",
            sha256="a" * 64,
            source_product_versions=[{"revision_id": "r1", "version": 1}],
            snapshot={"sku": "SKU-001"},
        )

        with self.assertRaises(IntegrityError), transaction.atomic():
            ArtifactVersion.objects.create(
                artifact=artifact,
                version=1,
                file_path="data/runtime/artifacts/catalog-1-copy.html",
                sha256="b" * 64,
            )

    def test_workflow_step_idempotency_key_is_unique_only_when_nonempty(self):
        batch = make_batch()
        task = make_workflow_task(batch)
        other_task = make_workflow_task(make_batch(title="另一批次"))

        WorkflowStep.objects.create(task=task, step_key="empty-1", idempotency_key="")
        WorkflowStep.objects.create(task=task, step_key="empty-2", idempotency_key="")
        WorkflowStep.objects.create(task=task, step_key="run", idempotency_key="run-1")
        WorkflowStep.objects.create(
            task=other_task,
            step_key="run",
            idempotency_key="run-1",
        )

        with self.assertRaises(IntegrityError), transaction.atomic():
            WorkflowStep.objects.create(
                task=task,
                step_key="run-retry",
                idempotency_key="run-1",
            )

    def test_human_review_key_is_unique_only_for_pending_nonempty_keys(self):
        batch = make_batch()
        task = make_workflow_task(batch)
        review = HumanReview.objects.create(
            task=task,
            item_ref="product:1",
            question="请补充英文名",
            review_key="english-name-1",
        )
        HumanReview.objects.create(task=task, item_ref="product:2", question="空 key 一")
        HumanReview.objects.create(task=task, item_ref="product:3", question="空 key 二")

        with self.assertRaises(IntegrityError), transaction.atomic():
            HumanReview.objects.create(
                task=task,
                item_ref="product:4",
                question="重复 pending key",
                review_key="english-name-1",
            )

        review.status = "answered"
        review.answer = {"english_name": "Sample Ribbon"}
        review.reviewer = "reviewer"
        review.save(update_fields=["status", "answer", "reviewer", "updated_at"])
        HumanReview.objects.create(
            task=task,
            item_ref="product:5",
            question="已解决后可再次使用 key",
            review_key="english-name-1",
        )



    def test_new_foreign_keys_protect_audit_evidence(self):
        batch = make_batch()
        product = make_product(batch)
        make_workflow_task(batch)

        with self.assertRaises(ProtectedError):
            batch.delete()

    def test_subtask_dependencies_are_asymmetric(self):
        batch = make_batch()
        task = make_workflow_task(batch)
        upstream = SubTask.objects.create(task=task, agent_role="product")
        downstream = SubTask.objects.create(task=task, agent_role="delivery")

        downstream.depends_on.add(upstream)

        self.assertEqual(list(downstream.depends_on.all()), [upstream])
        self.assertFalse(upstream.depends_on.exists())
        self.assertEqual(list(upstream.dependents.all()), [downstream])

    def test_event_log_allows_taskless_runtime_event(self):
        event = EventLog.objects.create(
            event_type="health_check",
            actor="system",
            payload_summary={"status": "ok"},
        )

        self.assertIsNone(event.task_id)
        self.assertIsNone(event.subtask_id)
        self.assertIsNotNone(event.created_at)

