from __future__ import annotations

import json
from concurrent.futures import ThreadPoolExecutor
from threading import Event
from unittest.mock import patch

from django.db import connections
from django.test import Client, TransactionTestCase
from django.utils import timezone

from workbench.agents.mock_runtime import MockAgentRuntime
from workbench.models import EventLog, SubTask, Task, WorkflowStep, WorkflowTask


class WorkflowDispatchConcurrencyTests(TransactionTestCase):
    reset_sequences = True

    def setUp(self):
        now = timezone.now()
        batch = Task.objects.create(
            title="Task13c2 concurrent fixture",
            mode="demo",
            status="confirmed",
            created_at=now,
            updated_at=now,
        )
        self.workflow = WorkflowTask.objects.create(
            batch=batch,
            user_goal="Run one explicit subtask",
            task_type="prepare_product_data",
            status="queued",
        )
        self.subtask = SubTask.objects.create(
            task=self.workflow,
            agent_role="product_profile",
            input_refs={
                "workflow_task_id": self.workflow.id,
                "batch_id": batch.id,
                "scope": "full_batch",
                "product_ids": [],
            },
            status="queued",
        )
        self.url = (
            f"/api/workflow-tasks/{self.workflow.id}/subtasks/"
            f"{self.subtask.id}/dispatch"
        )

    def test_running_replay_uses_a_second_connection_and_does_not_run_twice(self):
        entered = Event()
        release = Event()
        valid_result = MockAgentRuntime().run_subtask(self.subtask.id)

        def blocked_run(_runtime, _subtask_id):
            entered.set()
            if not release.wait(5):
                raise TimeoutError("bounded test handler wait expired")
            return valid_result

        def first_request():
            connections.close_all()
            try:
                response = Client().post(
                    self.url,
                    data=json.dumps({"idempotency_key": "concurrent-key"}),
                    content_type="application/json",
                )
                return response.status_code, response.json()
            finally:
                connections.close_all()

        with patch.object(
            MockAgentRuntime, "run_subtask", autospec=True, side_effect=blocked_run
        ) as handler:
            with ThreadPoolExecutor(max_workers=1) as pool:
                pending = pool.submit(first_request)
                try:
                    self.assertTrue(
                        entered.wait(5),
                        "first handler did not enter within the bound",
                    )
                    running = self.client.post(
                        self.url,
                        data=json.dumps({"idempotency_key": "concurrent-key"}),
                        content_type="application/json",
                    )
                    self.assertEqual(running.status_code, 409)
                    self.assertEqual(running.json()["code"], "step_in_progress")
                finally:
                    release.set()
                first_status, first_body = pending.result(timeout=6)

            replay = self.client.post(
                self.url,
                data=json.dumps({"idempotency_key": "concurrent-key"}),
                content_type="application/json",
            )

        self.assertEqual(first_status, 200)
        self.assertEqual(replay.status_code, 200)
        self.assertEqual(replay.json()["step"]["id"], first_body["step"]["id"])
        self.assertEqual(handler.call_count, 1)
        self.assertEqual(
            WorkflowStep.objects.filter(
                task=self.workflow,
                step_key=f"subtask:{self.subtask.id}",
            ).count(),
            1,
        )
        self.assertEqual(
            EventLog.objects.filter(
                task=self.workflow,
                event_type="subtask_started",
            ).count(),
            1,
        )

