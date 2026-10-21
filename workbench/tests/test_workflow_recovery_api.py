from __future__ import annotations

import json
from unittest.mock import patch

from django.test import Client, TestCase
from django.utils import timezone

from workbench.agents.runtime import RetryableExecutionError
from workbench.models import SubTask, Task, WorkflowStep, WorkflowTask


class WorkflowRecoveryApiTests(TestCase):
    def setUp(self):
        now = timezone.now()
        batch = Task.objects.create(
            title="Recovery API fixture", mode="demo", status="confirmed",
            created_at=now, updated_at=now,
        )
        self.workflow = WorkflowTask.objects.create(
            batch=batch, user_goal="Retry an explicit role",
            task_type="prepare_product_data", status="queued",
        )
        self.subtask = SubTask.objects.create(
            task=self.workflow, agent_role="product_profile", status="queued",
            input_refs={
                "workflow_task_id": self.workflow.id,
                "batch_id": batch.id,
                "scope": "full_batch",
                "product_ids": [],
            },
        )
        self.root = f"/api/workflow-tasks/{self.workflow.id}/subtasks/{self.subtask.id}"

    def post(self, suffix, body):
        return self.client.post(
            f"{self.root}/{suffix}",
            data=json.dumps(body, allow_nan=False),
            content_type="application/json",
        )

    def _make_retryable_failure(self):
        with patch(
            "workbench.agents.mock_runtime.MockAgentRuntime.run_subtask",
            side_effect=RetryableExecutionError(),
        ):
            response = self.post("dispatch", {"idempotency_key": "initial-key"})
        self.assertEqual(response.status_code, 500)
        return WorkflowStep.objects.get(task=self.workflow, attempt=1)

    def test_retry_endpoint_returns_historical_attempt_and_scrubs_step_snapshot(self):
        first = self._make_retryable_failure()
        first_error = first.error_summary
        first_snapshot = first.output_refs["result_snapshot"].copy()
        retry = self.post(
            "retry",
            {"idempotency_key": "retry-key-2", "expected_step_id": first.id},
        )
        self.assertEqual(retry.status_code, 200)
        payload = retry.json()
        self.assertEqual(payload["subtask_status"], "completed")
        self.assertEqual(payload["current_subtask_status"], "completed")
        self.assertEqual(payload["step"]["attempt"], 2)
        self.assertEqual(
            payload["result_ref"],
            f"workflow_step:{payload['step']['id']}:output_refs.result_snapshot",
        )

        first.refresh_from_db()
        self.assertEqual(first.error_summary, first_error)
        self.assertEqual(first.output_refs["result_snapshot"], first_snapshot)
        first.output_refs["result_snapshot"]["private_extension"] = "STEP_PRIVATE_MARKER"
        first.save(update_fields=["output_refs", "updated_at"])
        replay = self.post(
            "retry",
            {"idempotency_key": "retry-key-2", "expected_step_id": first.id},
        )
        self.assertEqual(replay.status_code, 200)
        self.assertEqual(replay.json()["step"]["id"], payload["step"]["id"])
        self.assertEqual(replay.json()["subtask_status"], "completed")
        self.assertEqual(replay.json()["current_subtask_status"], "completed")

        api_detail = self.client.get(f"/api/workflow-tasks/{self.workflow.id}")
        page_detail = self.client.get(f"/workflow-tasks/{self.workflow.id}")
        api_payload = api_detail.json()
        self.assertEqual(api_payload["status"], "running")
        self.assertEqual(api_payload["error_summary"], "")
        self.assertEqual(api_payload["subtasks"][0]["status"], "completed")
        first.refresh_from_db()
        self.assertEqual(first.error_summary, first_error)
        self.assertTrue(
            all("result_snapshot" not in step["output_refs"] for step in api_payload["steps"])
        )
        self.assertNotIn("STEP_PRIVATE_MARKER", str(api_payload))
        self.assertNotContains(page_detail, "STEP_PRIVATE_MARKER")
        self.assertEqual(
            api_detail.json()["subtasks"][0]["output_refs"]["result"]["status"],
            "candidate",
        )

    def test_old_retry_key_replay_is_bound_to_original_expected_step(self):
        first = self._make_retryable_failure()
        with patch(
            "workbench.agents.mock_runtime.MockAgentRuntime.run_subtask",
            side_effect=RetryableExecutionError(),
        ):
            old_retry = self.post(
                "retry",
                {"idempotency_key": "retry-key-2", "expected_step_id": first.id},
            )
        self.assertEqual(old_retry.status_code, 500)
        second = WorkflowStep.objects.get(task=self.workflow, attempt=2)
        newer = self.post(
            "retry",
            {"idempotency_key": "retry-key-3", "expected_step_id": second.id},
        )
        self.assertEqual(newer.status_code, 200)
        replay_old = self.post(
            "retry",
            {"idempotency_key": "retry-key-2", "expected_step_id": first.id},
        )
        self.assertEqual(replay_old.status_code, 200)
        self.assertEqual(replay_old.json()["step"]["id"], second.id)
        self.assertEqual(replay_old.json()["subtask_status"], "failed")
        self.assertEqual(replay_old.json()["current_subtask_status"], "completed")
        wrong_binding = self.post(
            "retry",
            {"idempotency_key": "retry-key-2", "expected_step_id": second.id},
        )
        self.assertEqual(wrong_binding.status_code, 409)
        self.assertEqual(wrong_binding.json()["code"], "idempotency_conflict")

    def test_api_validates_standard_json_and_shows_retry_form_only_for_safe_failure(self):
        self.assertEqual(
            self.client.post(f"{self.root}/retry", data="{bad", content_type="application/json").status_code,
            422,
        )
        first = self._make_retryable_failure()
        detail = self.client.get(f"/workflow-tasks/{self.workflow.id}")
        self.assertContains(detail, 'data-testid="workflow-retry"')
        self.assertContains(detail, "剩余 2 次")
        invalid = self.post(
            "retry",
            {"idempotency_key": "x" * 201, "expected_step_id": first.id},
        )
        self.assertEqual(invalid.status_code, 422)
        self.assertEqual(
            self.client.get(f"{self.root}/retry").status_code,
            405,
        )

    def test_retry_api_requires_csrf_and_unknown_subtask_is_404(self):
        first = self._make_retryable_failure()
        csrf_client = Client(enforce_csrf_checks=True)
        response = csrf_client.post(
            f"{self.root}/retry",
            data=json.dumps({"idempotency_key": "key", "expected_step_id": first.id}),
            content_type="application/json",
        )
        self.assertEqual(response.status_code, 403)
        missing = self.client.post(
            f"/api/workflow-tasks/{self.workflow.id}/subtasks/unknown/retry",
            data=json.dumps({"idempotency_key": "key", "expected_step_id": first.id}),
            content_type="application/json",
        )
        self.assertEqual(missing.status_code, 404)

    def test_interrupt_api_and_detail_explain_unknown_outcome(self):
        with patch(
            "workbench.agents.mock_runtime.MockAgentRuntime.run_subtask",
            side_effect=KeyboardInterrupt(),
        ):
            with self.assertRaises(KeyboardInterrupt):
                self.post("dispatch", {"idempotency_key": "running-key"})
        step = WorkflowStep.objects.get(task=self.workflow, attempt=1)
        detail_running = self.client.get(f"/workflow-tasks/{self.workflow.id}")
        self.assertContains(detail_running, 'data-testid="workflow-interrupt"')
        self.assertContains(detail_running, "结果和外部副作用仍可能发生")
        interrupted = self.post(
            "interrupt",
            {
                "expected_step_id": step.id,
                "operator_label": "local operator",
                "note": "process was restarted",
            },
        )
        self.assertEqual(interrupted.status_code, 200)
        self.assertTrue(interrupted.json()["step"]["id"] == step.id)
        step.refresh_from_db()
        self.assertTrue(step.output_refs["result_snapshot"]["outcome_unknown"])
