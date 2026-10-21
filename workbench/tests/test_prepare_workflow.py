from __future__ import annotations

import json
from pathlib import Path
from unittest.mock import patch

from django.test import Client, TestCase
from django.utils import timezone
from jsonschema import Draft202012Validator

from workbench.models import (
    EventLog,
    HumanReview,
    Product,
    SubTask,
    Task,
    WorkflowStep,
    WorkflowTask,
)
from workbench.agents.collaboration import project_collaboration_envelope
from workbench.workflows.orchestrator import WorkflowOrchestrator


class PrepareWorkflowApiTests(TestCase):
    def setUp(self):
        now = timezone.now()
        self.batch = Task.objects.create(
            title="Task11 API 测试批次",
            mode="demo",
            status="awaiting_confirmation",
            created_at=now,
            updated_at=now,
        )
        self.url = "/api/workflow-tasks"

    def post(self, payload):
        return self.client.post(
            self.url,
            data=json.dumps(payload),
            content_type="application/json",
        )

    def test_create_persists_only_center_plan_and_two_queued_roles(self):
        with patch("workbench.agents.mock_runtime.MockAgentRuntime.run_subtask") as run:
            response = self.post(
                {"batch_id": self.batch.id, "user_goal": "准备产品资料"}
            )

        self.assertEqual(response.status_code, 201)
        workflow = WorkflowTask.objects.get(pk=response.json()["id"])
        self.assertEqual(workflow.status, "queued")
        self.assertEqual(workflow.task_type, "prepare_product_data")
        self.assertEqual(WorkflowStep.objects.filter(task=workflow).count(), 1)
        plan_step = WorkflowStep.objects.get(task=workflow, step_key="center_plan")
        self.assertEqual(plan_step.status, "completed")
        self.assertEqual(SubTask.objects.filter(task=workflow).count(), 2)
        roles = list(
            SubTask.objects.filter(task=workflow)
            .order_by("agent_role")
            .values_list("agent_role", flat=True)
        )
        self.assertEqual(roles, ["delivery_quality", "product_profile"])
        product = SubTask.objects.get(task=workflow, agent_role="product_profile")
        delivery = SubTask.objects.get(task=workflow, agent_role="delivery_quality")
        self.assertEqual(delivery.depends_on.get().id, product.id)
        self.assertEqual(product.status, "queued")
        self.assertEqual(delivery.status, "queued")
        self.assertEqual(run.call_count, 0)
        self.assertFalse(workflow.artifacts.exists())
        self.assertFalse(workflow.human_reviews.exists())

    def test_get_reads_persisted_plan_and_steps_without_writing(self):
        created = self.post(
            {
                "batch_id": self.batch.id,
                "user_goal": "准备产品资料",
                "task_type": "prepare_product_data",
            }
        )
        workflow_id = created.json()["id"]
        before = (
            WorkflowTask.objects.count(),
            WorkflowStep.objects.count(),
            SubTask.objects.count(),
            EventLog.objects.count(),
        )

        with (
            patch("workbench.workflows.orchestrator.WorkflowOrchestrator.plan_task") as plan,
            patch("workbench.agents.mock_runtime.MockAgentRuntime.run_subtask") as run,
        ):
            response = self.client.get(f"{self.url}/{workflow_id}")

        self.assertEqual(response.status_code, 200)
        payload = response.json()
        self.assertEqual(payload["id"], workflow_id)
        self.assertEqual(payload["batch_id"], self.batch.id)
        self.assertEqual(payload["status"], "queued")
        self.assertEqual(payload["execution_mode"], "local_mock")
        self.assertEqual(payload["planning_mode"], "simulated_rules")
        self.assertEqual(payload["agentarts"], "not_configured")
        self.assertEqual(payload["plan"]["subtasks"], created.json()["plan"]["subtasks"])
        self.assertEqual([row["step_key"] for row in payload["steps"]], ["center_plan"])
        self.assertEqual(len(payload["subtasks"]), 2)
        self.assertIn("depends_on", payload["subtasks"][0])
        self.assertEqual(
            before,
            (
                WorkflowTask.objects.count(),
                WorkflowStep.objects.count(),
                SubTask.objects.count(),
                EventLog.objects.count(),
            ),
        )
        plan.assert_not_called()
        run.assert_not_called()

    def test_get_adds_collaboration_projection_and_preserves_legacy_workflow_fields(self):
        created = self.post(
            {"batch_id": self.batch.id, "user_goal": "准备产品资料"}
        )
        workflow = WorkflowTask.objects.get(pk=created.json()["id"])
        EventLog.objects.filter(task=workflow).delete()
        workflow.result_refs = {"approved_bundle": "artifact-version:version-1"}
        workflow.save(update_fields=["result_refs", "updated_at"])
        review = HumanReview.objects.create(
            task=workflow,
            item_ref="product:demo-1",
            question="核对资料",
            options=["确认"],
            status="submitted",
        )
        event = EventLog.objects.create(
            task=workflow,
            event_type="workflow_review_submitted",
            actor="operator-demo",
            payload_summary={"private_raw_payload": "must-not-appear"},
        )
        unrelated_workflow = WorkflowTask.objects.create(
            batch=self.batch,
            user_goal="另一任务",
            task_type="prepare_product_data",
        )
        EventLog.objects.create(
            task=unrelated_workflow,
            event_type="unrelated_event",
            actor="other",
            payload_summary={"private_raw_payload": "must-not-appear"},
        )

        response = self.client.get(f"{self.url}/{workflow.id}")

        self.assertEqual(response.status_code, 200)
        payload = response.json()
        self.assertEqual(payload["id"], workflow.id)
        self.assertEqual(payload["batch_id"], self.batch.id)
        self.assertEqual(payload["status"], workflow.status)
        self.assertEqual(payload["result_refs"], workflow.result_refs)
        self.assertIn("dispatch_target", payload)
        self.assertEqual(
            payload["collaboration"],
            {
                "schema_version": 1,
                "task": {
                    "system": "tradeloom",
                    "id": workflow.id,
                    "batch_id": self.batch.id,
                },
                "status": {
                    "workflow": workflow.status,
                    "current_step": workflow.current_step,
                    "subtasks": [
                        {"id": item.id, "role": item.agent_role, "status": item.status}
                        for item in workflow.subtasks.order_by("created_at", "id")
                    ],
                    "reviews": [{"id": review.id, "status": "submitted"}],
                },
                "messages": [
                    {
                        "id": event.id,
                        "type": "workflow_review_submitted",
                        "actor": "operator-demo",
                        "created_at": event.created_at.isoformat(),
                    }
                ],
                "messages_truncated": False,
                "result": {
                    "data": None,
                    "refs": {"approved_bundle": "artifact-version:version-1"},
                },
                "error": None,
            },
        )
        self.assertEqual(
            set(payload["collaboration"]["messages"][0]),
            {"id", "type", "actor", "created_at"},
        )
        self.assertNotIn("private_raw_payload", json.dumps(payload["collaboration"]))
        schema_path = Path(__file__).resolve().parents[2] / "contracts" / "collaboration-envelope-v1.schema.json"
        schema = json.loads(schema_path.read_text(encoding="utf-8"))
        Draft202012Validator(schema).validate(payload["collaboration"])

    def test_collaboration_projection_uses_public_payload_and_separate_safe_events(self):
        public_payload = {
            "id": "workflow-1",
            "batch_id": "batch-1",
            "status": "running",
            "current_step": "product_profile",
            "subtasks": [{"id": "subtask-1", "agent_role": "product_profile", "status": "running"}],
            "reviews": [{"id": "review-1", "status": "pending"}],
            "result_refs": {"result": "workflow_step:step-1"},
            "error_summary": "provider-secret raw error",
            "plan": {"private": "not copied"},
        }
        event_metadata = [
            {
                "id": "event-1",
                "event_type": "workflow_started",
                "actor": "center",
                "created_at": timezone.now(),
            }
        ]

        envelope = project_collaboration_envelope(public_payload, event_metadata)

        self.assertEqual(envelope["task"], {"system": "tradeloom", "id": "workflow-1", "batch_id": "batch-1"})
        self.assertEqual(envelope["status"]["subtasks"], [{"id": "subtask-1", "role": "product_profile", "status": "running"}])
        self.assertEqual(envelope["status"]["reviews"], [{"id": "review-1", "status": "pending"}])
        self.assertEqual(envelope["messages"][0]["id"], "event-1")
        self.assertEqual(envelope["result"], {"data": None, "refs": {"result": "workflow_step:step-1"}})
        self.assertEqual(envelope["error"], {"code": None, "summary": "工作流执行失败，请查看本地状态。"})
        self.assertNotIn("plan", envelope)

    def test_collaboration_message_projection_is_stably_bounded_to_one_hundred(self):
        created = self.post(
            {"batch_id": self.batch.id, "user_goal": "准备产品资料"}
        )
        workflow = WorkflowTask.objects.get(pk=created.json()["id"])
        EventLog.objects.filter(task=workflow).delete()
        for index in range(101):
            EventLog.objects.create(
                task=workflow,
                event_type="test_event",
                actor=f"actor-{index:03d}",
                payload_summary={"index": index},
            )
        expected_ids = list(
            EventLog.objects.filter(task=workflow)
            .order_by("created_at", "id")
            .values_list("id", flat=True)[:100]
        )

        payload = self.client.get(f"{self.url}/{workflow.id}").json()["collaboration"]

        self.assertEqual(len(payload["messages"]), 100)
        self.assertTrue(payload["messages_truncated"])
        self.assertEqual([item["id"] for item in payload["messages"]], expected_ids)
        self.assertFalse(any("payload_summary" in item for item in payload["messages"]))

    def test_collaboration_uses_safe_error_summary_and_explicit_empty_messages(self):
        created = self.post(
            {"batch_id": self.batch.id, "user_goal": "准备产品资料"}
        )
        workflow = WorkflowTask.objects.get(pk=created.json()["id"])
        EventLog.objects.filter(task=workflow).delete()
        workflow.error_summary = "provider-secret: bearer-value and raw response"
        workflow.save(update_fields=["error_summary", "updated_at"])

        payload = self.client.get(f"{self.url}/{workflow.id}").json()["collaboration"]

        self.assertEqual(payload["messages"], [])
        self.assertFalse(payload["messages_truncated"])
        self.assertEqual(
            payload["error"],
            {"code": None, "summary": "工作流执行失败，请查看本地状态。"},
        )
        self.assertNotIn("provider-secret", json.dumps(payload, ensure_ascii=False))

    def test_missing_batch_and_unknown_workflow_are_not_found(self):
        self.assertEqual(
            self.post({"batch_id": "f" * 32, "user_goal": "准备资料"}).status_code,
            404,
        )
        self.assertEqual(self.client.get(f"{self.url}/{'e' * 32}").status_code, 404)

    def test_invalid_json_fields_and_types_return_422_without_rows(self):
        cases = [
            ("{", "application/json"),
            ("[]", "application/json"),
            (json.dumps({"batch_id": self.batch.id}), "application/json"),
            (json.dumps({"batch_id": 3, "user_goal": "准备"}), "application/json"),
            (json.dumps({"batch_id": "b" * 33, "user_goal": "准备"}), "application/json"),
            (json.dumps({"batch_id": self.batch.id, "user_goal": "  "}), "application/json"),
            (json.dumps({"batch_id": self.batch.id, "user_goal": "准备", "task_type": []}), "application/json"),
            (json.dumps({"batch_id": self.batch.id, "user_goal": "准备", "task_type": ""}), "application/json"),
            (json.dumps({"batch_id": self.batch.id, "user_goal": "准备", "task_type": "x" * 65}), "application/json"),
            (json.dumps({"batch_id": self.batch.id, "user_goal": "准备", "status": "completed"}), "application/json"),
            (json.dumps({"batch_id": self.batch.id, "user_goal": "准备", "current_step": "x"}), "application/json"),
            (json.dumps({"batch_id": self.batch.id, "user_goal": "准备", "result_refs": {}}), "application/json"),
        ]
        for body, content_type in cases:
            with self.subTest(body=body):
                response = self.client.post(self.url, data=body, content_type=content_type)
                self.assertEqual(response.status_code, 422)
        self.assertEqual(WorkflowTask.objects.count(), 0)
        self.assertEqual(WorkflowStep.objects.count(), 0)
        self.assertEqual(SubTask.objects.count(), 0)
        self.assertEqual(EventLog.objects.count(), 0)

    def test_unknown_intent_is_typed_422_and_rolls_back(self):
        response = self.post(
            {
                "batch_id": self.batch.id,
                "user_goal": "准备资料",
                "task_type": "unknown_intent",
            }
        )
        self.assertEqual(response.status_code, 422)
        self.assertEqual(response.json()["error"], "UnknownTaskIntent")
        self.assertEqual(WorkflowTask.objects.count(), 0)
        self.assertEqual(WorkflowStep.objects.count(), 0)
        self.assertEqual(SubTask.objects.count(), 0)
        self.assertEqual(EventLog.objects.count(), 0)

    def test_planning_exception_rolls_back_workflow_plan_and_events(self):
        def write_partial_plan_then_fail(workflow_id):
            workflow = WorkflowTask.objects.get(pk=workflow_id)
            WorkflowStep.objects.create(
                task=workflow,
                step_key="partial-center-plan",
                status="running",
                attempt=1,
                idempotency_key=f"workflow:{workflow.id}:partial",
                input_refs={"workflow_task_id": workflow.id},
                started_at=timezone.now(),
            )
            subtask = SubTask.objects.create(
                task=workflow,
                agent_role="product_profile",
                status="queued",
            )
            EventLog.objects.create(
                task=workflow,
                subtask=subtask,
                event_type="subtask_created",
                actor="center",
                payload_summary={"role": "product_profile"},
            )
            raise RuntimeError("planning failed after partial writes")

        with patch(
            "workbench.workflows.orchestrator.WorkflowOrchestrator.plan_task",
            side_effect=write_partial_plan_then_fail,
        ):
            self.client.raise_request_exception = False
            response = self.post({"batch_id": self.batch.id, "user_goal": "准备资料"})
        self.assertEqual(response.status_code, 500)
        self.assertEqual(WorkflowTask.objects.count(), 0)
        self.assertEqual(WorkflowStep.objects.count(), 0)
        self.assertEqual(SubTask.objects.count(), 0)
        self.assertEqual(EventLog.objects.count(), 0)

    def test_csrf_is_required_for_creation(self):
        client = Client(enforce_csrf_checks=True)
        data = json.dumps({"batch_id": self.batch.id, "user_goal": "准备资料"})
        self.assertEqual(
            client.post(self.url, data=data, content_type="application/json").status_code,
            403,
        )
        page = client.get("/tasks/new")
        token = client.cookies["csrftoken"].value
        self.assertEqual(page.status_code, 200)
        response = client.post(
            self.url,
            data=data,
            content_type="application/json",
            HTTP_X_CSRFTOKEN=token,
        )
        self.assertEqual(response.status_code, 201)

    def test_collection_and_detail_methods_are_restricted(self):
        self.assertEqual(self.client.get(self.url).status_code, 405)
        self.assertEqual(
            self.client.post(f"{self.url}/{'a' * 32}", data="{}", content_type="application/json").status_code,
            405,
        )

    def test_idempotency_key_replays_the_original_complete_receipt_once(self):
        payload = {
            "batch_id": self.batch.id,
            "user_goal": "准备产品资料",
            "task_type": "prepare_product_data",
            "idempotency_key": "workflow-create:stable-1",
        }
        original_plan = WorkflowOrchestrator.plan_task
        with patch(
            "workbench.workflows.orchestrator.WorkflowOrchestrator.plan_task",
            autospec=True,
            side_effect=original_plan,
        ) as plan:
            first = self.post(payload)
            second = self.post(payload)

        self.assertEqual(first.status_code, 201)
        self.assertEqual(second.status_code, 201)
        self.assertEqual(second.json(), first.json())
        workflow = WorkflowTask.objects.get(creation_idempotency_key=payload["idempotency_key"])
        self.assertEqual(WorkflowTask.objects.count(), 1)
        self.assertEqual(WorkflowStep.objects.filter(task=workflow).count(), 1)
        self.assertEqual(SubTask.objects.filter(task=workflow).count(), 2)
        self.assertEqual(
            list(
                EventLog.objects.filter(task=workflow)
                .order_by("event_type")
                .values_list("event_type", flat=True)
            ),
            [
                "subtask_created",
                "subtask_created",
                "workflow_plan_completed",
                "workflow_step_started",
            ],
        )
        self.assertEqual(plan.call_count, 1)

    def test_idempotency_key_cannot_be_reused_for_a_different_request(self):
        other_batch = Task.objects.create(
            title="Other batch",
            mode="demo",
            status="awaiting_confirmation",
            created_at=timezone.now(),
            updated_at=timezone.now(),
        )
        payload = {
            "batch_id": self.batch.id,
            "user_goal": "准备产品资料",
            "task_type": "prepare_product_data",
            "idempotency_key": "workflow-create:bound-1",
        }
        self.assertEqual(self.post(payload).status_code, 201)
        changed = [
            {**payload, "batch_id": other_batch.id},
            {**payload, "user_goal": "准备另一份资料"},
            {**payload, "task_type": "delivery_quality"},
        ]
        for request in changed:
            with self.subTest(request=request):
                response = self.post(request)
                self.assertEqual(response.status_code, 409)
                self.assertEqual(response.json()["code"], "idempotency_conflict")
        self.assertEqual(WorkflowTask.objects.count(), 1)

    def test_invalid_idempotency_key_is_rejected_without_creation(self):
        base = {"batch_id": self.batch.id, "user_goal": "准备资料"}
        invalid_keys = [None, "", "   ", 3, [], "x" * 201]
        for key in invalid_keys:
            with self.subTest(key=key):
                response = self.post({**base, "idempotency_key": key})
                self.assertEqual(response.status_code, 422)
        self.assertEqual(self.post(base).status_code, 201)
        self.assertEqual(self.post(base).status_code, 201)
        self.assertEqual(WorkflowTask.objects.count(), 2)

    def test_replay_returns_frozen_receipt_while_get_remains_live(self):
        payload = {
            "batch_id": self.batch.id,
            "user_goal": "准备资料",
            "idempotency_key": "workflow-create:frozen-1",
        }
        first = self.post(payload)
        self.assertEqual(first.status_code, 201)
        workflow = WorkflowTask.objects.get(pk=first.json()["id"])
        workflow.status = "running"
        workflow.current_step = "changed-after-create"
        workflow.save(update_fields=["status", "current_step", "updated_at"])
        self.batch.title = "批次来源已变化"
        self.batch.save(update_fields=["title", "updated_at"])
        Product.objects.create(
            task=self.batch,
            position=0,
            sku="NEW-SOURCE",
            name="新加入的产品",
            category="配件",
            material="棉",
            size="25mm",
            color="蓝色",
            image_filename="new-source.png",
            missing_fields=[],
            created_at=timezone.now(),
            updated_at=timezone.now(),
        )

        replay = self.post(payload)
        live = self.client.get(f"{self.url}/{workflow.id}")
        self.assertEqual(replay.status_code, 201)
        self.assertEqual(replay.json(), first.json())
        self.assertEqual(live.status_code, 200)
        self.assertEqual(live.json()["status"], "running")
        self.assertEqual(live.json()["current_step"], "changed-after-create")

    def test_planning_failure_does_not_consume_creation_key(self):
        payload = {
            "batch_id": self.batch.id,
            "user_goal": "准备资料",
            "idempotency_key": "workflow-create:retry-after-rollback",
        }

        def write_then_fail(workflow_id):
            workflow = WorkflowTask.objects.get(pk=workflow_id)
            WorkflowStep.objects.create(
                task=workflow,
                step_key="partial-plan",
                status="running",
                attempt=1,
                idempotency_key=f"workflow:{workflow.id}:partial",
            )
            raise RuntimeError("failed after partial writes")

        with patch(
            "workbench.workflows.orchestrator.WorkflowOrchestrator.plan_task",
            side_effect=write_then_fail,
        ):
            self.client.raise_request_exception = False
            failed = self.post(payload)
        self.assertEqual(failed.status_code, 500)
        self.assertFalse(
            WorkflowTask.objects.filter(
                creation_idempotency_key=payload["idempotency_key"]
            ).exists()
        )

        retried = self.post(payload)
        self.assertEqual(retried.status_code, 201)
        self.assertEqual(WorkflowTask.objects.count(), 1)
        self.assertEqual(WorkflowStep.objects.filter(task_id=retried.json()["id"]).count(), 1)
