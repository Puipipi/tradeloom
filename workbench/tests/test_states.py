from __future__ import annotations

from django.test import TestCase
from django.utils import timezone

from workbench.models import EventLog, Task, WorkflowTask
from workbench.workflows import InvalidTransition, transition_workflow


def make_workflow_task(*, status: str = "queued") -> WorkflowTask:
    now = timezone.now()
    batch = Task.objects.create(
        title="状态机测试批次",
        mode="demo",
        status="awaiting_confirmation",
        created_at=now,
        updated_at=now,
    )
    return WorkflowTask.objects.create(
        batch=batch,
        user_goal="验证业务状态机",
        task_type="test_state_machine",
        status=status,
    )


class WorkflowStateTests(TestCase):
    def test_all_documented_legal_paths_are_accepted(self):
        legal = {
            "queued": ("running",),
            "running": ("waiting_human", "failed", "completed", "cancelled"),
            "waiting_human": ("running", "cancelled"),
            "failed": ("queued", "cancelled"),
        }

        for start, targets in legal.items():
            for target in targets:
                with self.subTest(start=start, target=target):
                    task = make_workflow_task(status=start)

                    result = transition_workflow(task, target, actor="tester")

                    self.assertEqual(result.pk, task.pk)
                    self.assertEqual(result.status, target)
                    task.refresh_from_db()
                    self.assertEqual(task.status, target)

    def test_transition_persists_and_returns_latest_database_row(self):
        task = make_workflow_task(status="queued")

        result = transition_workflow(task, "running", actor="tester")

        self.assertEqual(result.status, "running")
        task.refresh_from_db()
        self.assertEqual(task.status, "running")
        task.batch.refresh_from_db()
        self.assertEqual(task.batch.status, "awaiting_confirmation")

        transition_workflow(task, "waiting_human", actor="tester")
        task.refresh_from_db()
        self.assertEqual(task.status, "waiting_human")

    def test_queued_to_completed_is_rejected_without_db_change(self):
        task = make_workflow_task(status="queued")

        with self.assertRaises(InvalidTransition):
            transition_workflow(task, "completed", actor="tester")

        task.refresh_from_db()
        self.assertEqual(task.status, "queued")
        self.assertEqual(EventLog.objects.filter(task=task).count(), 0)

    def test_illegal_non_terminal_transitions_are_rejected_without_db_change(self):
        illegal = (
            ("queued", "waiting_human"),
            ("queued", "failed"),
            ("queued", "cancelled"),
            ("running", "queued"),
            ("waiting_human", "failed"),
            ("waiting_human", "completed"),
            ("failed", "running"),
            ("failed", "waiting_human"),
            ("failed", "completed"),
        )

        for start, target in illegal:
            with self.subTest(start=start, target=target):
                task = make_workflow_task(status=start)

                with self.assertRaises(InvalidTransition):
                    transition_workflow(task, target, actor="tester")

                task.refresh_from_db()
                self.assertEqual(task.status, start)
                self.assertEqual(EventLog.objects.filter(task=task).count(), 0)

    def test_terminal_states_reject_outgoing_transitions(self):
        all_statuses = ("queued", "running", "waiting_human", "failed", "completed", "cancelled")

        for terminal in ("completed", "cancelled"):
            for target in all_statuses:
                if target == terminal:
                    continue
                with self.subTest(terminal=terminal, target=target):
                    task = make_workflow_task(status=terminal)

                    with self.assertRaises(InvalidTransition):
                        transition_workflow(task, target, actor="tester")

                    task.refresh_from_db()
                    self.assertEqual(task.status, terminal)
                    self.assertEqual(EventLog.objects.filter(task=task).count(), 0)

    def test_unknown_target_status_is_rejected_without_db_change(self):
        task = make_workflow_task(status="queued")

        with self.assertRaises(InvalidTransition):
            transition_workflow(task, "paused", actor="tester")

        task.refresh_from_db()
        self.assertEqual(task.status, "queued")
        self.assertEqual(EventLog.objects.filter(task=task).count(), 0)

    def test_unknown_stored_status_is_rejected(self):
        task = make_workflow_task(status="mystery")

        with self.assertRaises(InvalidTransition):
            transition_workflow(task, "running", actor="tester")
        with self.assertRaises(InvalidTransition):
            transition_workflow(task, "mystery", actor="tester")

        task.refresh_from_db()
        self.assertEqual(task.status, "mystery")
        self.assertEqual(EventLog.objects.filter(task=task).count(), 0)

    def test_stale_object_cannot_bypass_terminal_state(self):
        task = make_workflow_task(status="queued")
        transition_workflow(task, "running", actor="tester")
        transition_workflow(task, "completed", actor="tester")

        with self.assertRaises(InvalidTransition):
            transition_workflow(task, "running", actor="tester")

        task.refresh_from_db()
        self.assertEqual(task.status, "completed")

    def test_event_log_records_actor_and_actual_from_to(self):
        task = make_workflow_task(status="queued")

        transition_workflow(task, "running", actor="alice")
        transition_workflow(task, "waiting_human", actor="bob")

        events = list(EventLog.objects.filter(task=task))
        self.assertEqual(len(events), 2)
        self.assertEqual(
            {event.event_type for event in events},
            {"workflow_status_changed"},
        )
        events_by_actor = {event.actor: event.payload_summary for event in events}
        self.assertEqual(
            events_by_actor["alice"],
            {"from_status": "queued", "to_status": "running"},
        )
        self.assertEqual(
            events_by_actor["bob"],
            {"from_status": "running", "to_status": "waiting_human"},
        )

    def test_repeated_same_status_is_noop(self):
        task = make_workflow_task(status="queued")
        transition_workflow(task, "running", actor="tester")
        task.refresh_from_db()
        running_updated_at = task.updated_at
        running_event_count = EventLog.objects.filter(task=task).count()

        result = transition_workflow(task, "running", actor="repeater")

        self.assertEqual(result.status, "running")
        task.refresh_from_db()
        self.assertEqual(task.updated_at, running_updated_at)
        self.assertEqual(EventLog.objects.filter(task=task).count(), running_event_count)

        transition_workflow(task, "completed", actor="tester")
        task.refresh_from_db()
        completed_updated_at = task.updated_at
        completed_event_count = EventLog.objects.filter(task=task).count()

        result = transition_workflow(task, "completed", actor="repeater")

        self.assertEqual(result.status, "completed")
        task.refresh_from_db()
        self.assertEqual(task.updated_at, completed_updated_at)
        self.assertEqual(EventLog.objects.filter(task=task).count(), completed_event_count)
