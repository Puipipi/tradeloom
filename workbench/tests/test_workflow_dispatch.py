from __future__ import annotations

import json
from unittest.mock import patch

from django.middleware.csrf import _get_new_csrf_string
from django.test import Client, TestCase
from django.utils import timezone

from workbench.models import (
    Artifact,
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
    IdempotencyConflict,
    WorkflowOrchestrationError,
    WorkflowOrchestrator,
)


class WorkflowDispatchApiTests(TestCase):
    def setUp(self):
        now = timezone.now()
        self.batch = Task.objects.create(
            title="Task13c2 full batch fixture",
            mode="demo",
            status="confirmed",
            created_at=now,
            updated_at=now,
        )
        self.product = Product.objects.create(
            task=self.batch,
            position=0,
            sku="TL-13C2",
            name="Ribbon",
            category="trim",
            material="polyester",
            size="25mm",
            color="red",
            image_filename="TL-13C2.svg",
            image_stored_name="TL-13C2.svg",
            missing_fields=[],
            created_at=now,
            updated_at=now,
        )
        ProductRevision.objects.create(
            product=self.product,
            version=1,
            snapshot={
                "sku": self.product.sku,
                "name": self.product.name,
                "category": self.product.category,
                "material": self.product.material,
                "size": self.product.size,
                "color": self.product.color,
                "image_filename": self.product.image_filename,
                "english_name": "",
            },
            status="confirmed",
        )
        TaskFile.objects.create(
            task=self.batch,
            kind="image",
            original_name="TL-13C2.svg",
            stored_name="TL-13C2.svg",
            created_at=now,
        )
        self.workflow = WorkflowTask.objects.create(
            batch=self.batch,
            user_goal="Prepare the saved product plan",
            task_type="prepare_product_data",
            status="queued",
        )
        self.engine = WorkflowOrchestrator()
        self.engine.plan_task(self.workflow.id)
        self.product_subtask = SubTask.objects.get(
            task=self.workflow, agent_role="product_profile"
        )
        self.delivery_subtask = SubTask.objects.get(
            task=self.workflow, agent_role="delivery_quality"
        )
        self.url = self.dispatch_url(self.product_subtask)

    def dispatch_url(self, subtask):
        return (
            f"/api/workflow-tasks/{subtask.task_id}/subtasks/"
            f"{subtask.id}/dispatch"
        )

    def post(self, *, key="workflow:test:product", body=None, url=None, client=None):
        payload = {"idempotency_key": key} if body is None else body
        return (client or self.client).post(
            url or self.url,
            data=json.dumps(payload, allow_nan=False),
            content_type="application/json",
        )

    def test_dispatches_one_saved_subtask_and_same_key_replays_saved_step(self):
        first = self.post()
        self.assertEqual(first.status_code, 200)
        payload = first.json()
        self.assertEqual(payload["workflow_id"], self.workflow.id)
        self.assertEqual(payload["subtask_id"], self.product_subtask.id)
        self.assertEqual(payload["subtask_status"], "waiting_human")
        self.assertEqual(payload["step"]["status"], "completed")
        self.assertEqual(payload["step"]["key"], "workflow:test:product")
        self.assertEqual(payload["result_ref"], f"workflow_step:{payload['step']['id']}:output_refs.result_snapshot")
        self.assertEqual(payload["execution_mode"], "local_mock")
        self.assertEqual(payload["planning_mode"], "simulated_rules")
        self.assertEqual(payload["agentarts"], "not_configured")
        self.assertNotIn("output_refs", payload)
        self.assertEqual(WorkflowStep.objects.filter(task=self.workflow, step_key__startswith="subtask:").count(), 1)
        self.assertEqual(EventLog.objects.filter(task=self.workflow, event_type="subtask_started").count(), 1)
        self.assertFalse(WorkflowStep.objects.filter(task=self.workflow, step_key=f"subtask:{self.delivery_subtask.id}").exists())

        event_count = EventLog.objects.filter(task=self.workflow).count()
        replay = self.post()
        self.assertEqual(replay.status_code, 200)
        self.assertEqual(replay.json()["step"]["id"], payload["step"]["id"])
        self.assertEqual(WorkflowStep.objects.filter(task=self.workflow, step_key__startswith="subtask:").count(), 1)
        self.assertEqual(EventLog.objects.filter(task=self.workflow).count(), event_count)

    def test_key_at_schema_limit_is_accepted_without_normalizing_it(self):
        key = "k" * 200
        response = self.post(key=key)
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["step"]["key"], key)

    def test_dispatch_rejects_invalid_keys_foreign_ids_and_wrong_method(self):
        for body in (
            {},
            {"idempotency_key": "   "},
            {"idempotency_key": "x" * 201},
            {"idempotency_key": 5},
            {"idempotency_key": "x", "subtask_id": self.delivery_subtask.id},
        ):
            with self.subTest(body=body):
                self.assertEqual(self.post(body=body).status_code, 422)
        self.assertEqual(
            self.client.post(self.url, data='{"idempotency_key":NaN}', content_type="application/json").status_code,
            422,
        )
        self.assertEqual(self.client.get(self.url).status_code, 405)
        self.assertEqual(self.client.post(self.url, data="{", content_type="application/json").status_code, 422)
        self.assertEqual(self.post(body=[]).status_code, 422)
        with patch("workbench.workflows.execution.WorkflowOrchestrator.dispatch_subtask") as dispatch:
            self.assertEqual(
                self.post(url=f"/api/workflow-tasks/{self.workflow.id}/subtasks/missing/dispatch").status_code,
                404,
            )
            self.assertEqual(
                self.post(url=f"/api/workflow-tasks/missing/subtasks/{self.product_subtask.id}/dispatch").status_code,
                404,
            )
            dispatch.assert_not_called()
        other_workflow = WorkflowTask.objects.create(
            batch=self.batch,
            user_goal="another saved plan",
            task_type="prepare_product_data",
        )
        self.assertEqual(
            self.post(url=f"/api/workflow-tasks/{other_workflow.id}/subtasks/{self.product_subtask.id}/dispatch").status_code,
            404,
        )
        self.assertFalse(WorkflowStep.objects.filter(step_key=f"subtask:{self.product_subtask.id}").exists())

    def test_dispatch_obeys_dependency_and_review_gates_without_writes(self):
        response = self.post(url=self.dispatch_url(self.delivery_subtask), key="early-delivery")
        self.assertEqual(response.status_code, 409)
        self.assertEqual(response.json()["code"], "dependency_not_ready")
        self.assertFalse(WorkflowStep.objects.filter(task=self.workflow, step_key=f"subtask:{self.delivery_subtask.id}").exists())

        review = HumanReview.objects.create(
            task=self.workflow,
            item_ref="generic-check",
            question="Generic check",
            options=[],
            status="pending",
        )
        response = self.post(key="blocked-by-review")
        self.assertEqual(response.status_code, 409)
        self.assertEqual(response.json()["code"], "dependency_not_ready")
        self.assertFalse(WorkflowStep.objects.filter(task=self.workflow, step_key=f"subtask:{self.product_subtask.id}").exists())
        review.status = "submitted"
        review.save(update_fields=["status"])
        self.assertEqual(self.post(key="blocked-by-submitted-review").status_code, 409)

    def test_csrf_is_required_and_same_key_is_rejected_for_another_subtask(self):
        csrf_client = Client(enforce_csrf_checks=True)
        csrf_client.cookies["csrftoken"] = _get_new_csrf_string()
        denied = self.post(client=csrf_client)
        self.assertEqual(denied.status_code, 403)
        csrf_client.cookies["csrftoken"] = _get_new_csrf_string()
        allowed = csrf_client.post(
            self.url,
            data=json.dumps({"idempotency_key": "shared-key"}),
            content_type="application/json",
            HTTP_X_CSRFTOKEN=csrf_client.cookies["csrftoken"].value,
        )
        self.assertEqual(allowed.status_code, 200)
        conflict = self.post(
            url=self.dispatch_url(self.delivery_subtask), key="shared-key"
        )
        self.assertEqual(conflict.status_code, 409)
        self.assertEqual(conflict.json()["code"], "idempotency_conflict")

    def test_engine_rejects_nonqueued_subtask_without_an_existing_step(self):
        self.product_subtask.status = "completed"
        self.product_subtask.save(update_fields=["status"])
        with self.assertRaises(WorkflowOrchestrationError):
            self.engine.dispatch_subtask(self.product_subtask.id, "completed-without-step")
        self.assertFalse(WorkflowStep.objects.filter(task=self.workflow, step_key=f"subtask:{self.product_subtask.id}").exists())

    def test_engine_rejects_unknown_workflow_state_before_creating_a_step(self):
        self.workflow.status = "unknown-state"
        self.workflow.save(update_fields=["status"])
        with self.assertRaises(WorkflowOrchestrationError):
            self.engine.dispatch_subtask(self.product_subtask.id, "unknown-workflow-state")
        self.assertFalse(WorkflowStep.objects.filter(task=self.workflow, step_key=f"subtask:{self.product_subtask.id}").exists())

    def test_engine_rejects_a_second_key_for_the_same_subtask(self):
        self.engine.dispatch_subtask(self.product_subtask.id, "first-key")
        with self.assertRaises(IdempotencyConflict):
            self.engine.dispatch_subtask(self.product_subtask.id, "second-key")

    def test_handler_failure_is_persisted_and_same_key_replays_failed_step(self):
        with patch("workbench.agents.mock_runtime.MockAgentRuntime.run_subtask", side_effect=RuntimeError("private handler detail")) as handler:
            with self.assertRaisesRegex(RuntimeError, "private handler detail"):
                self.engine.dispatch_subtask(self.product_subtask.id, "handler-fails")
            step = WorkflowStep.objects.get(task=self.workflow, step_key=f"subtask:{self.product_subtask.id}")
            event_count = EventLog.objects.filter(task=self.workflow).count()
            replay = self.engine.dispatch_subtask(self.product_subtask.id, "handler-fails")
        self.assertEqual(step.status, "failed")
        self.assertEqual(replay.status, "failed")
        self.assertEqual(handler.call_count, 1)
        self.assertEqual(EventLog.objects.filter(task=self.workflow).count(), event_count)


    def test_same_key_is_independent_across_workflows(self):
        other = WorkflowTask.objects.create(
            batch=self.batch,
            user_goal="independent saved plan",
            task_type="prepare_product_data",
        )
        self.engine.plan_task(other.id)
        other_product = SubTask.objects.get(task=other, agent_role="product_profile")
        self.assertEqual(self.engine.dispatch_subtask(self.product_subtask.id, "reusable-key").status, "waiting_human")
        self.assertEqual(self.engine.dispatch_subtask(other_product.id, "reusable-key").status, "waiting_human")

    def test_confirmed_fixture_dispatches_both_roles_in_dependency_order_without_completing_workflow(self):
        now = timezone.now()
        batch = Task.objects.create(
            title="Task13c2 confirmed fixture",
            mode="demo",
            status="confirmed",
            created_at=now,
            updated_at=now,
        )
        product = Product.objects.create(
            task=batch,
            position=0,
            sku="TL-13C2-FULL",
            name="Ribbon",
            category="trim",
            material="polyester",
            size="25mm",
            color="red",
            image_filename="TL-13C2-FULL.svg",
            image_stored_name="TL-13C2-FULL.svg",
            missing_fields=[],
            created_at=now,
            updated_at=now,
        )
        ProductRevision.objects.create(
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
                "english_name": "Ribbon",
            },
            status="confirmed",
        )
        TaskFile.objects.create(
            task=batch,
            kind="image",
            original_name="TL-13C2-FULL.svg",
            stored_name="TL-13C2-FULL.svg",
            created_at=now,
        )
        workflow = WorkflowTask.objects.create(
            batch=batch,
            user_goal="Run the saved confirmed product plan",
            task_type="prepare_product_data",
            status="queued",
        )
        self.engine.plan_task(workflow.id)
        product_subtask = SubTask.objects.get(task=workflow, agent_role="product_profile")
        delivery_subtask = SubTask.objects.get(task=workflow, agent_role="delivery_quality")

        first = self.post(
            url=self.dispatch_url(product_subtask),
            key=f"workflow:{workflow.id}:subtask:{product_subtask.id}",
        )
        self.assertEqual(first.status_code, 200)
        self.assertEqual(first.json()["subtask_status"], "completed")
        second = self.post(
            url=self.dispatch_url(delivery_subtask),
            key=f"workflow:{workflow.id}:subtask:{delivery_subtask.id}",
        )
        self.assertEqual(second.status_code, 200)
        self.assertEqual(second.json()["subtask_status"], "completed")
        workflow.refresh_from_db()
        self.assertEqual(workflow.status, "running")
        self.assertEqual(WorkflowStep.objects.filter(task=workflow, step_key__startswith="subtask:").count(), 2)
        self.assertEqual(Artifact.objects.filter(task=workflow).count(), 0)
        self.assertEqual(second.json()["result_ref"], f"workflow_step:{second.json()['step']['id']}:output_refs.result_snapshot")

    def test_handler_failure_returns_safe_500_after_persisting_failed_state(self):
        private_marker = "private-handler-marker-13c2"
        with patch("workbench.agents.mock_runtime.MockAgentRuntime.run_subtask", side_effect=RuntimeError(private_marker)) as handler:
            response = self.post(key="handler-fails-http")
        self.assertEqual(response.status_code, 500)
        self.assertEqual(response.json()["code"], "execution_failed")
        self.assertNotIn("private handler detail", response.content.decode("utf-8"))
        self.product_subtask.refresh_from_db()
        self.workflow.refresh_from_db()
        step = WorkflowStep.objects.get(task=self.workflow, step_key=f"subtask:{self.product_subtask.id}")
        self.assertEqual(self.product_subtask.status, "failed")
        self.assertEqual(self.workflow.status, "failed")
        self.assertEqual(step.status, "failed")
        self.assertEqual(step.idempotency_key, "handler-fails-http")
        self.assertEqual(step.input_refs["subtask_id"], self.product_subtask.id)
        self.assertEqual(step.error_summary, "子任务执行失败，请检查输入与运行环境")
        self.assertEqual(self.product_subtask.error_summary, step.error_summary)
        self.assertEqual(self.workflow.error_summary, step.error_summary)
        self.assertTrue(
            EventLog.objects.filter(
                task=self.workflow,
                event_type="subtask_failed",
                payload_summary__refs__workflow_step_id=step.id,
            ).exists()
        )
        event = EventLog.objects.get(task=self.workflow, event_type="subtask_failed")
        self.assertNotIn(private_marker, json.dumps(event.payload_summary, ensure_ascii=False))
        saved = self.client.get(f"/api/workflow-tasks/{self.workflow.id}")
        self.assertEqual(saved.status_code, 200)
        self.assertNotIn(private_marker, saved.content.decode("utf-8"))
        self.assertEqual(saved.json()["error_summary"], step.error_summary)
        saved_subtasks = {item["id"]: item for item in saved.json()["subtasks"]}
        self.assertEqual(saved_subtasks[self.product_subtask.id]["status"], "failed")
        self.assertEqual(saved_subtasks[self.product_subtask.id]["error_summary"], step.error_summary)
        self.assertEqual(saved.json()["steps"][-1]["error_summary"], step.error_summary)
        detail = self.client.get(f"/workflow-tasks/{self.workflow.id}")
        self.assertEqual(detail.status_code, 200)
        self.assertNotIn(private_marker, detail.content.decode("utf-8"))
        event_count = EventLog.objects.filter(task=self.workflow).count()
        replay = self.post(key="handler-fails-http")
        self.assertEqual(replay.status_code, 200)
        self.assertEqual(replay.json()["subtask_status"], "failed")
        self.assertEqual(replay.json()["step"]["id"], step.id)
        self.assertEqual(handler.call_count, 1)
        self.assertEqual(EventLog.objects.filter(task=self.workflow).count(), event_count)

    def test_invalid_runtime_result_is_a_safe_500_with_persisted_failure(self):
        with patch(
            "workbench.agents.mock_runtime.MockAgentRuntime.run_subtask",
            return_value={"status": "secret-unexpected", "private": "do not leak"},
        ) as handler:
            response = self.post(key="invalid-result")
        self.assertEqual(response.status_code, 500)
        self.assertEqual(response.json()["code"], "execution_failed")
        self.assertNotIn("secret-unexpected", response.content.decode("utf-8"))
        self.assertNotIn("do not leak", response.content.decode("utf-8"))
        step = WorkflowStep.objects.get(task=self.workflow, step_key=f"subtask:{self.product_subtask.id}")
        self.product_subtask.refresh_from_db()
        self.workflow.refresh_from_db()
        self.assertEqual(step.status, "failed")
        self.assertEqual(self.product_subtask.status, "failed")
        self.assertEqual(self.workflow.status, "failed")
        self.assertEqual(step.error_summary, "角色返回结果不符合契约")
        detail = self.client.get(f"/workflow-tasks/{self.workflow.id}")
        self.assertEqual(detail.status_code, 200)
        self.assertNotIn("secret-unexpected", detail.content.decode("utf-8"))
        self.assertNotIn("do not leak", detail.content.decode("utf-8"))
        event_count = EventLog.objects.filter(task=self.workflow).count()
        replay = self.post(key="invalid-result")
        self.assertEqual(replay.status_code, 200)
        self.assertEqual(replay.json()["subtask_status"], "failed")
        self.assertEqual(replay.json()["step"]["id"], step.id)
        self.assertEqual(handler.call_count, 1)
        self.assertEqual(EventLog.objects.filter(task=self.workflow).count(), event_count)

    def test_terminal_workflow_and_nonqueued_subtask_are_rejected_without_step(self):
        self.workflow.status = "completed"
        self.workflow.save(update_fields=["status"])
        response = self.post(key="terminal-workflow")
        self.assertEqual(response.status_code, 409)
        self.assertEqual(response.json()["code"], "state_conflict")
        self.assertFalse(WorkflowStep.objects.filter(task=self.workflow, step_key=f"subtask:{self.product_subtask.id}").exists())

        self.workflow.status = "queued"
        self.workflow.save(update_fields=["status"])
        self.product_subtask.status = "completed"
        self.product_subtask.save(update_fields=["status"])
        response = self.post(key="nonqueued-subtask")
        self.assertEqual(response.status_code, 409)
        self.assertEqual(response.json()["code"], "state_conflict")
        self.assertFalse(WorkflowStep.objects.filter(task=self.workflow, step_key=f"subtask:{self.product_subtask.id}").exists())

    def test_cross_workflow_dependency_is_rejected_without_writes(self):
        other = WorkflowTask.objects.create(
            batch=self.batch,
            user_goal="foreign dependency workflow",
            task_type="prepare_product_data",
        )
        self.engine.plan_task(other.id)
        foreign = SubTask.objects.get(task=other, agent_role="product_profile")
        self.product_subtask.status = "completed"
        self.product_subtask.save(update_fields=["status"])
        self.delivery_subtask.depends_on.add(foreign)
        before_events = EventLog.objects.filter(task=self.workflow).count()
        response = self.post(
            url=self.dispatch_url(self.delivery_subtask),
            key="foreign-dependency",
        )
        self.assertEqual(response.status_code, 409)
        self.assertEqual(response.json()["code"], "dependency_not_ready")
        self.assertFalse(WorkflowStep.objects.filter(task=self.workflow, step_key=f"subtask:{self.delivery_subtask.id}").exists())
        self.assertEqual(EventLog.objects.filter(task=self.workflow).count(), before_events)

    def test_detail_offers_only_the_first_persisted_eligible_subtask(self):
        detail = self.client.get(f"/workflow-tasks/{self.workflow.id}")
        self.assertEqual(detail.status_code, 200)
        self.assertContains(detail, 'data-testid="workflow-dispatch"')
        self.assertContains(detail, "执行下一步（本地模拟）")
        self.assertContains(detail, self.product_subtask.id)
        self.assertContains(detail, f"workflow:{self.workflow.id}:subtask:{self.product_subtask.id}")
        self.assertNotContains(detail, f"workflow:{self.workflow.id}:subtask:{self.delivery_subtask.id}")
        self.assertContains(detail, "保存不会执行")

        blocked = self.post()
        self.assertEqual(blocked.status_code, 200)
        waiting = self.client.get(f"/workflow-tasks/{self.workflow.id}")
        self.assertNotContains(waiting, 'data-testid="workflow-dispatch"')
        self.assertContains(waiting, "等待人工")

