from __future__ import annotations

from unittest.mock import Mock

from django.test import TransactionTestCase
from django.utils import timezone

from workbench.models import EventLog, HumanReview, SubTask, Task, WorkflowStep, WorkflowTask
from workbench.workflows.orchestrator import (
    RetryLimitReached,
    RetryableExecutionError,
    DependencyNotReady,
    WorkflowOrchestrator,
)


def valid_product_result(workflow):
    return {
        "schema_version": "workflow-role-result.v1",
        "role": "product_profile",
        "task_id": workflow.id,
        "batch_id": workflow.batch_id,
        "status": "candidate",
        "products": [],
        "source_refs": {},
        "facts_changed": False,
    }


class SequenceRuntime:
    supports_safe_retry = True

    def __init__(self, outcomes):
        self.outcomes = list(outcomes)
        self.calls = 0

    def run_subtask(self, _subtask_id):
        self.calls += 1
        value = self.outcomes.pop(0)
        if isinstance(value, BaseException):
            raise value
        return value


class WorkflowRetryTests(TransactionTestCase):
    def setUp(self):
        now = timezone.now()
        batch = Task.objects.create(
            title="Retry fixture", mode="demo", status="confirmed",
            created_at=now, updated_at=now,
        )
        self.workflow = WorkflowTask.objects.create(
            batch=batch, user_goal="Retry one explicit role",
            task_type="prepare_product_data", status="queued",
        )
        self.subtask = SubTask.objects.create(
            task=self.workflow, agent_role="product_profile",
            status="queued",
            input_refs={
                "workflow_task_id": self.workflow.id,
                "batch_id": batch.id,
                "scope": "full_batch",
                "product_ids": [],
            },
        )

    def test_explicit_retry_saves_independent_attempt_and_old_key_replays_old_step(self):
        runtime = SequenceRuntime([
            RetryableExecutionError(),
            valid_product_result(self.workflow),
        ])
        engine = WorkflowOrchestrator(runtime)
        with self.assertRaises(RetryableExecutionError):
            engine.dispatch_subtask(self.subtask.id, "initial-key")
        first = WorkflowStep.objects.get(task=self.workflow, idempotency_key="initial-key")

        result = engine.retry_subtask(
            self.subtask.id, "retry-key-2", expected_step_id=first.id
        )
        second = WorkflowStep.objects.get(task=self.workflow, idempotency_key="retry-key-2")
        self.assertEqual(result.status, "completed")
        self.assertEqual(second.attempt, 2)
        self.subtask.refresh_from_db()
        self.assertEqual(self.subtask.retry_count, 1)
        self.assertEqual(second.output_refs["result_snapshot"]["subtask_status"], "completed")
        self.assertEqual(second.output_refs["canonical_result_ref"], f"workflow_step:{second.id}:output_refs.result_snapshot")
        self.assertEqual(second.output_refs["subtask_id"], self.subtask.id)
        self.assertEqual(
            second.output_refs["source_refs"],
            second.output_refs["result_snapshot"]["result"]["source_refs"],
        )
        self.assertNotEqual(
            first.output_refs["result_snapshot"],
            second.output_refs["result_snapshot"],
        )
        engine.dispatch_subtask(self.subtask.id, "initial-key")
        self.assertEqual(runtime.calls, 2)
        first.refresh_from_db()
        self.assertEqual(first.status, "failed")
        self.assertEqual(first.output_refs["result_snapshot"]["subtask_status"], "failed")

    def test_retryable_failures_stop_at_three_attempts_and_audit_once(self):
        runtime = SequenceRuntime([
            RetryableExecutionError(), RetryableExecutionError(),
            RetryableExecutionError(),
        ])
        engine = WorkflowOrchestrator(runtime)
        with self.assertRaises(RetryableExecutionError):
            engine.dispatch_subtask(self.subtask.id, "initial-key")
        expected = WorkflowStep.objects.get(idempotency_key="initial-key")
        for n in (2, 3):
            with self.assertRaises(RetryableExecutionError):
                engine.retry_subtask(
                    self.subtask.id, f"retry-key-{n}", expected_step_id=expected.id
                )
            expected = WorkflowStep.objects.get(task=self.workflow, attempt=n)
        before = EventLog.objects.filter(task=self.workflow).count()
        for key in ("retry-key-4a", "retry-key-4b"):
            with self.assertRaises(RetryLimitReached):
                engine.retry_subtask(
                    self.subtask.id, key, expected_step_id=expected.id
                )
        self.assertEqual(
            EventLog.objects.filter(task=self.workflow, event_type="subtask_retry_exhausted").count(),
            1,
        )
        self.assertLessEqual(EventLog.objects.filter(task=self.workflow).count(), before + 1)
        self.assertEqual(runtime.calls, 3)

    def test_unclassified_exception_cannot_be_retried(self):
        runtime = SequenceRuntime([RuntimeError("credential-marker")])
        engine = WorkflowOrchestrator(runtime)
        with self.assertRaises(RuntimeError):
            engine.dispatch_subtask(self.subtask.id, "initial-key")
        first = WorkflowStep.objects.get(idempotency_key="initial-key")
        with self.assertRaises(Exception):
            engine.retry_subtask(
                self.subtask.id, "retry-key-2", expected_step_id=first.id
            )
        self.assertEqual(runtime.calls, 1)
        self.assertEqual(WorkflowStep.objects.filter(task=self.workflow).count(), 1)
        self.assertNotIn(
            "credential-marker",
            str(WorkflowStep.objects.get(pk=first.id).error_summary),
        )

    def test_invalid_contract_result_cannot_be_retried(self):
        runtime = SequenceRuntime([{"status": "blocked", "secret": "marker"}])
        engine = WorkflowOrchestrator(runtime)
        with self.assertRaises(Exception):
            engine.dispatch_subtask(self.subtask.id, "invalid-contract")
        first = WorkflowStep.objects.get(task=self.workflow, attempt=1)
        self.assertFalse(first.output_refs["retryable"])
        with self.assertRaises(Exception):
            engine.retry_subtask(
                self.subtask.id, "retry-contract", expected_step_id=first.id
            )
        self.assertEqual(runtime.calls, 1)
        self.assertEqual(WorkflowStep.objects.filter(task=self.workflow).count(), 1)

    def test_valid_blocked_role_result_is_not_retryable(self):
        delivery = SubTask.objects.create(
            task=self.workflow,
            agent_role="delivery_quality",
            status="queued",
            input_refs={
                "workflow_task_id": self.workflow.id,
                "batch_id": self.workflow.batch_id,
                "scope": "full_batch",
                "all_product_ids": [],
                "confirmed_revision_ids": [],
                "unconfirmed_product_ids": [],
                "requires_all_products_confirmed": True,
            },
        )
        result = {
            "schema_version": "workflow-role-result.v1",
            "role": "delivery_quality",
            "task_id": self.workflow.id,
            "batch_id": self.workflow.batch_id,
            "status": "blocked",
            "quality_scope": "data_readiness",
            "data_readiness": "not_ready",
            "artifacts_generated": False,
            "artifact_quality": "not_evaluated",
            "checks": [],
            "generation_intent": [],
            "scope": {},
            "source_refs": {},
            "facts_changed": False,
        }
        runtime = SequenceRuntime([result])
        engine = WorkflowOrchestrator(runtime)
        completed = engine.dispatch_subtask(delivery.id, "blocked-result")
        step = WorkflowStep.objects.get(task=self.workflow, attempt=1, step_key=f"subtask:{delivery.id}")
        self.assertEqual(completed.status, "failed")
        self.assertFalse(step.output_refs["retryable"])
        with self.assertRaises(Exception):
            engine.retry_subtask(
                delivery.id, "retry-blocked", expected_step_id=step.id
            )
        self.assertEqual(runtime.calls, 1)

    def test_pending_and_submitted_reviews_block_retry(self):
        runtime = SequenceRuntime([RetryableExecutionError()])
        engine = WorkflowOrchestrator(runtime)
        with self.assertRaises(RetryableExecutionError):
            engine.dispatch_subtask(self.subtask.id, "initial-key")
        first = WorkflowStep.objects.get(task=self.workflow, attempt=1)
        review = HumanReview.objects.create(
            task=self.workflow,
            item_ref="product:unknown",
            question="确认来源",
            review_key="review-key",
            status="pending",
        )
        with self.assertRaises(DependencyNotReady):
            engine.retry_subtask(self.subtask.id, "retry-pending", expected_step_id=first.id)
        review.status = "submitted"
        review.save(update_fields=["status", "updated_at"])
        with self.assertRaises(DependencyNotReady):
            engine.retry_subtask(self.subtask.id, "retry-submitted", expected_step_id=first.id)
        self.assertEqual(WorkflowStep.objects.filter(task=self.workflow).count(), 1)
        self.assertEqual(runtime.calls, 1)
