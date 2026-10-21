from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
from threading import Event
from unittest.mock import Mock

from django.db import connections
from django.test import TransactionTestCase
from django.utils import timezone

from workbench.models import EventLog, SubTask, Task, WorkflowStep, WorkflowTask
from workbench.workflows.orchestrator import (
    RetryNotAllowed,
    RetryableExecutionError,
    StepInProgress,
    StaleAttemptResult,
    WorkflowOrchestrator,
)


def valid_result(workflow):
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


class Runtime:
    supports_safe_retry = True

    def __init__(self, callback):
        self.callback = callback

    def run_subtask(self, subtask_id):
        return self.callback(subtask_id)


class WorkflowRecoveryTests(TransactionTestCase):
    reset_sequences = True

    def setUp(self):
        now = timezone.now()
        batch = Task.objects.create(
            title="Recovery fixture", mode="demo", status="confirmed",
            created_at=now, updated_at=now,
        )
        self.workflow = WorkflowTask.objects.create(
            batch=batch, user_goal="Recover one role",
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

    def test_process_loss_leaves_running_until_explicit_takeover_then_retry(self):
        def crashed(_subtask_id):
            raise BaseException("simulated process loss")

        first_engine = WorkflowOrchestrator(Runtime(crashed))
        with self.assertRaises(BaseException):
            first_engine.dispatch_subtask(self.subtask.id, "attempt-1")
        first = WorkflowStep.objects.get(task=self.workflow, attempt=1)
        self.assertEqual(first.status, "running")

        replacement = WorkflowOrchestrator(Runtime(lambda _id: valid_result(self.workflow)))
        recovered = WorkflowStep.objects.get(task=self.workflow, attempt=1)
        self.assertEqual(recovered.status, "running")
        replacement.interrupt_subtask(
            self.subtask.id,
            expected_step_id=first.id,
            operator_label="local operator",
            note="server restarted",
        )
        self.workflow.refresh_from_db()
        self.assertEqual(self.workflow.status, "failed")
        self.assertIn("结果未知", self.workflow.error_summary)
        second = replacement.retry_subtask(
            self.subtask.id, "attempt-2", expected_step_id=first.id
        )
        second_step = WorkflowStep.objects.get(task=self.workflow, attempt=2)
        self.assertEqual(second.status, "completed")
        self.assertEqual(second_step.status, "completed")
        first.refresh_from_db()
        self.assertTrue(first.output_refs["result_snapshot"]["outcome_unknown"])

    def _run_blocked_attempt(self, callback, key, entered, release):
        connections.close_all()
        try:
            return WorkflowOrchestrator(Runtime(callback)).dispatch_subtask(
                self.subtask.id, key
            )
        finally:
            connections.close_all()

    def _start_and_take_over(self, stale_outcome):
        entered = Event()
        release = Event()
        if stale_outcome == "success":
            def blocked(_subtask_id):
                entered.set()
                if not release.wait(5):
                    raise TimeoutError("test handler timed out")
                return valid_result(self.workflow)
        else:
            def blocked(_subtask_id):
                entered.set()
                if not release.wait(5):
                    raise TimeoutError("test handler timed out")
                raise RuntimeError("late private failure")

        with ThreadPoolExecutor(max_workers=1) as pool:
            pending = pool.submit(
                self._run_blocked_attempt,
                blocked,
                "attempt-1",
                entered,
                release,
            )
            try:
                self.assertTrue(entered.wait(5))
                first = WorkflowStep.objects.get(task=self.workflow, attempt=1)
                engine = WorkflowOrchestrator(Runtime(lambda _id: valid_result(self.workflow)))
                engine.interrupt_subtask(
                    self.subtask.id,
                    expected_step_id=first.id,
                    operator_label="operator",
                    note="take over after timeout",
                )
                engine.retry_subtask(
                    self.subtask.id, "attempt-2", expected_step_id=first.id
                )
            finally:
                release.set()
            try:
                pending.result(timeout=6)
                self.fail("late handler result unexpectedly persisted")
            except StaleAttemptResult:
                pass
            except Exception as exc:
                if isinstance(exc, TimeoutError):
                    raise
                self.fail(f"unexpected stale handler exception: {type(exc).__name__}")

        latest = WorkflowStep.objects.get(task=self.workflow, attempt=2)
        self.assertEqual(latest.status, "completed")
        self.subtask.refresh_from_db()
        self.assertEqual(self.subtask.status, "completed")
        self.assertEqual(
            EventLog.objects.filter(task=self.workflow, event_type="subtask_interrupted").count(),
            1,
        )

    def test_late_success_is_fenced_after_takeover_and_retry(self):
        self._start_and_take_over("success")

    def test_late_failure_is_fenced_after_takeover_and_retry(self):
        self._start_and_take_over("failure")

    def test_two_retry_keys_competing_for_same_expected_step_create_one_attempt(self):
        initial_engine = WorkflowOrchestrator(
            Runtime(lambda _id: (_ for _ in ()).throw(RetryableExecutionError()))
        )
        with self.assertRaises(RetryableExecutionError):
            initial_engine.dispatch_subtask(self.subtask.id, "attempt-1")
        first = WorkflowStep.objects.get(task=self.workflow, attempt=1)
        entered = Event()
        release = Event()

        def blocked(_subtask_id):
            entered.set()
            if not release.wait(5):
                raise TimeoutError("test handler timed out")
            return valid_result(self.workflow)

        with ThreadPoolExecutor(max_workers=1) as pool:
            pending = pool.submit(
                lambda: WorkflowOrchestrator(Runtime(blocked)).retry_subtask(
                    self.subtask.id, "retry-A", expected_step_id=first.id
                )
            )
            try:
                self.assertTrue(entered.wait(5))
                with self.assertRaises(StepInProgress):
                    WorkflowOrchestrator(Runtime(Mock())).retry_subtask(
                        self.subtask.id, "retry-A", expected_step_id=first.id
                    )
                with self.assertRaises(RetryNotAllowed):
                    WorkflowOrchestrator(Runtime(Mock())).retry_subtask(
                        self.subtask.id, "retry-B", expected_step_id=first.id
                    )
            finally:
                release.set()
            pending.result(timeout=6)
        self.assertEqual(
            WorkflowStep.objects.filter(
                task=self.workflow, step_key=f"subtask:{self.subtask.id}"
            ).count(),
            2,
        )
