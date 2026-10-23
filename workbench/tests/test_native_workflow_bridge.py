from __future__ import annotations

import json
import os
from concurrent.futures import ThreadPoolExecutor
from threading import Barrier

from django.db import close_old_connections
from django.test import TestCase, TransactionTestCase
from django.utils import timezone

from workbench.models import HumanReview, Product, ProductRevision, SubTask, Task, TaskFile, WorkflowStep, WorkflowTask
from workbench.workflows.execution import NativeAssignmentRequired, dispatch_saved_subtask
from workbench.workflows.orchestrator import StaleAttemptResult, WorkflowOrchestrationError, WorkflowOrchestrator


class NativeWorkflowModeTests(TestCase):
    bridge_key = "a" * 64

    def setUp(self):
        now = timezone.now()
        self.batch = Task.objects.create(
            title="Native bridge synthetic batch",
            mode="demo",
            status="awaiting_confirmation",
            created_at=now,
            updated_at=now,
        )

    def post_json(self, url, payload):
        from unittest.mock import patch

        native = "/native-assignment" in url or "/native-assignments/" in url
        headers = {"HTTP_X_TRADELOOM_NATIVE_BRIDGE": self.bridge_key} if native else {}
        with patch.dict(os.environ, {"TRADELOOM_NATIVE_BRIDGE_KEY": self.bridge_key}, clear=False):
            return self.client.post(url, data=json.dumps(payload), content_type="application/json", **headers)

    def post_native(self, url, payload, bridge_key="use-default", **extra_headers):
        from unittest.mock import patch

        key = self.bridge_key if bridge_key == "use-default" else bridge_key
        with patch.dict(os.environ, {"TRADELOOM_NATIVE_BRIDGE_KEY": self.bridge_key}, clear=False):
            headers = {} if key is None else {"HTTP_X_TRADELOOM_NATIVE_BRIDGE": key}
            headers.update(extra_headers)
            return self.client.post(url, data=json.dumps(payload), content_type="application/json", **headers)

    def test_native_endpoints_reject_missing_or_wrong_bridge_key_before_processing_body(self):
        workflow, subtask = self.create_native_workflow()
        initial_step_count = WorkflowStep.objects.filter(task=workflow).count()
        routes = [
            (f"/api/workflow-tasks/{workflow.id}/subtasks/{subtask.id}/native-assignment", {
                "idempotency_key": "bridge-denied", "expected_expert_preset": "tradeloom-product",
                "center_identity": {"agent_id": "center", "agent_preset": "tradeloom-center", "parent_session": None, "delegation_depth": 0},
            }),
            (f"/api/workflow-tasks/{workflow.id}/native-assignments/{'a' * 32}/bind", {
                "assignment_id": "a" * 32, "step_id": "a" * 32, "center_identity": {}, "child_identity": {},
            }),
            (f"/api/workflow-tasks/{workflow.id}/native-assignments/{'a' * 32}/submit", {
                "assignment_id": "a" * 32, "step_id": "a" * 32, "child_identity": {}, "advice": {},
            }),
        ]
        for url, body in routes:
            for key in (None, "b" * 64):
                response = self.post_native(
                    url,
                    body,
                    bridge_key=key,
                    HTTP_AUTHORIZATION="Bearer unrelated-dsh-token",
                )
                self.assertEqual(response.status_code, 403)
                self.assertEqual(response.json()["code"], "native_bridge_forbidden")
        self.assertEqual(WorkflowStep.objects.filter(task=workflow).count(), initial_step_count)

    def test_native_proxy_bridge_authenticates_bind_and_typed_submit_http_flow(self):
        workflow, subtask = self.create_native_workflow()
        center = {
            "agent_id": "host-center-http-submit",
            "agent_preset": "tradeloom-center",
            "parent_session": None,
            "delegation_depth": 0,
        }
        begin = self.post_json(
            f"/api/workflow-tasks/{workflow.id}/subtasks/{subtask.id}/native-assignment",
            {
                "idempotency_key": "native-http-submit",
                "expected_expert_preset": "tradeloom-product",
                "center_identity": center,
            },
        )
        self.assertEqual(begin.status_code, 200, begin.content)
        assignment_id = begin.json()["assignment_id"]
        child = {
            "agent_id": "host-product-http-submit",
            "agent_preset": "tradeloom-product",
            "parent_session": center["agent_id"],
            "delegation_depth": 1,
        }
        bind = self.post_json(
            f"/api/workflow-tasks/{workflow.id}/native-assignments/{assignment_id}/bind",
            {
                "assignment_id": assignment_id,
                "step_id": assignment_id,
                "center_identity": center,
                "child_identity": child,
            },
        )
        self.assertEqual(bind.status_code, 200, bind.content)

        submit_path = f"/api/workflow-tasks/{workflow.id}/native-assignments/{assignment_id}/submit"
        payload = {
            "assignment_id": assignment_id,
            "step_id": assignment_id,
            "child_identity": child,
            "advice": {"schema_version": "native-expert-advice.v1", "observations": []},
        }
        accepted = self.post_json(submit_path, payload)
        self.assertEqual(accepted.status_code, 200, accepted.content)
        self.assertEqual(accepted.json()["status"], "accepted")
        self.assertEqual(accepted.json()["provider"], "unknown")
        self.assertEqual(accepted.json()["model"], "unknown")

        step = WorkflowStep.objects.get(pk=assignment_id)
        self.assertEqual(step.output_refs["native_submission"]["child_agent_id"], child["agent_id"])
        self.assertEqual(step.output_refs["native_submission"]["state"], "accepted_not_settled")
        self.assertEqual(step.status, "completed")

    def create_native_workflow(self, task_type="prepare_product_data", user_goal="准备产品资料", role="product_profile"):
        preview = self.post_json(
            "/api/workflow-intent/preview",
            {
                "batch_id": self.batch.id,
                "user_goal": user_goal,
                "execution_mode": "native_dsh",
            },
        )
        self.assertEqual(preview.status_code, 200)
        created = self.post_json(
            "/api/workflow-tasks",
            {
                "batch_id": self.batch.id,
                "user_goal": user_goal,
                "task_type": task_type,
                "execution_mode": "native_dsh",
                "idempotency_key": f"native-assignment-create-{task_type}-{role}",
                "confirmation_token": preview.json()["confirmation_token"],
            },
        )
        self.assertEqual(created.status_code, 201)
        workflow = WorkflowTask.objects.get(pk=created.json()["id"])
        return workflow, SubTask.objects.get(task=workflow, agent_role=role)

    def bind_native_child(self, engine, workflow, step, child_identity):
        center_identity = step.input_refs["native_assignment"]["center"]
        return engine.bind_native_assignment(
            workflow.id,
            step.id,
            step.id,
            center_identity=center_identity,
            child_identity=child_identity,
        )

    def test_native_assignment_claim_is_persisted_and_same_request_replays(self):
        workflow, subtask = self.create_native_workflow()
        engine = WorkflowOrchestrator()
        host_center = {
            "agent_id": "center-agent",
            "agent_preset": "tradeloom-center",
            "parent_session": None,
            "delegation_depth": 0,
        }

        first = engine.begin_native_assignment(
            workflow.id,
            subtask.id,
            "native:assignment:product-profile",
            center_identity=host_center,
            expected_expert_preset="tradeloom-product",
        )
        replay = engine.begin_native_assignment(
            workflow.id,
            subtask.id,
            "native:assignment:product-profile",
            center_identity=host_center,
            expected_expert_preset="tradeloom-product",
        )

        self.assertEqual(first.id, replay.id)
        self.assertEqual(first.status, "running")
        self.assertEqual(first.step_key, f"subtask:{subtask.id}")
        self.assertEqual(first.attempt, 1)
        self.assertEqual(first.input_refs["native_assignment"]["state"], "awaiting_expert")
        self.assertEqual(first.input_refs["native_assignment"]["center"], host_center)
        self.assertEqual(first.input_refs["native_assignment"]["expected_expert_preset"], "tradeloom-product")
        self.assertEqual(WorkflowStep.objects.filter(task=workflow, step_key=f"subtask:{subtask.id}").count(), 1)
        subtask.refresh_from_db()
        workflow.refresh_from_db()
        self.assertEqual(subtask.status, "running")
        self.assertEqual(workflow.current_step, "product_profile")

    def test_native_assignment_http_endpoint_persists_only_server_bound_assignment(self):
        workflow, subtask = self.create_native_workflow()
        identity = {
            "agent_id": "host-center-2",
            "agent_preset": "tradeloom-center",
            "parent_session": None,
            "delegation_depth": 0,
        }
        path = f"/api/workflow-tasks/{workflow.id}/subtasks/{subtask.id}/native-assignment"
        payload = {
            "idempotency_key": "native-http-assignment",
            "expected_expert_preset": "tradeloom-product",
            "center_identity": identity,
        }
        first = self.post_json(path, payload)
        replay = self.post_json(path, payload)
        self.assertEqual(first.status_code, 200)
        self.assertEqual(replay.status_code, 200)
        self.assertEqual(first.json(), replay.json())
        self.assertEqual(first.json()["status"], "awaiting_expert")
        self.assertEqual(first.json()["provider"], "unknown")
        self.assertEqual(first.json()["model"], "unknown")
        self.assertEqual(first.json()["assignment_id"], first.json()["step_id"])
        self.assertEqual(WorkflowStep.objects.filter(task=workflow, step_key=f"subtask:{subtask.id}").count(), 1)

        wrong_path = self.post_json(
            f"/api/workflow-tasks/{'0' * 32}/subtasks/{subtask.id}/native-assignment",
            {**payload, "idempotency_key": "wrong-path-key"},
        )
        self.assertEqual(wrong_path.status_code, 404)
        self.assertFalse(WorkflowStep.objects.filter(task=workflow, idempotency_key="wrong-path-key").exists())

    def test_assignment_returns_canonical_bounded_product_advice_context(self):
        product = Product.objects.create(
            task=self.batch,
            position=1,
            sku="SYN-1",
            name="Synthetic product",
            category="category",
            material="",
            size="size",
            color="color",
            image_filename="",
            missing_fields=["material"],
            created_at=timezone.now(),
            updated_at=timezone.now(),
        )
        revision = ProductRevision.objects.create(
            product=product,
            version=1,
            snapshot={
                "sku": product.sku, "name": product.name, "category": product.category,
                "material": "", "size": product.size, "color": product.color,
                "image_filename": "", "english_name": "Synthetic English name",
            },
            status="needs_review",
            source_refs={},
        )
        workflow, subtask = self.create_native_workflow()
        WorkflowOrchestrator._canonical_native_result(workflow, subtask)
        center = {
            "agent_id": "host-center-advice-context",
            "agent_preset": "tradeloom-center",
            "parent_session": None,
            "delegation_depth": 0,
        }
        begin = self.post_json(
            f"/api/workflow-tasks/{workflow.id}/subtasks/{subtask.id}/native-assignment",
            {
                "idempotency_key": "native-advice-context",
                "expected_expert_preset": "tradeloom-product",
                "center_identity": center,
            },
        )
        self.assertEqual(begin.status_code, 200, begin.content)
        context = begin.json()["advice_context"]
        self.assertEqual(context["schema_version"], "native-advice-context.v1")
        self.assertEqual(context["role"], "product_profile")
        self.assertEqual(context["products"], [{
            "product_id": product.id,
            "fields": ["material"],
            "source_refs": {
                "product_id": product.id,
                "revision_id": revision.id,
                "task_file_ids": [],
            },
        }])
        self.assertNotIn("sku", json.dumps(context))
        self.assertNotIn("path", json.dumps(context).lower())

        assignment_id = begin.json()["assignment_id"]
        child = {
            "agent_id": "host-product-advice-context",
            "agent_preset": "tradeloom-product",
            "parent_session": center["agent_id"],
            "delegation_depth": 1,
        }
        self.post_json(
            f"/api/workflow-tasks/{workflow.id}/native-assignments/{assignment_id}/bind",
            {
                "assignment_id": assignment_id,
                "step_id": assignment_id,
                "center_identity": center,
                "child_identity": child,
            },
        )
        submit = self.post_json(
            f"/api/workflow-tasks/{workflow.id}/native-assignments/{assignment_id}/submit",
            {
                "assignment_id": assignment_id,
                "step_id": assignment_id,
                "child_identity": child,
                "advice": {
                    "schema_version": "native-expert-advice.v1",
                    "observations": [{
                        "product_id": product.id,
                        "field": "material",
                        "source_refs": context["products"][0]["source_refs"],
                        "note": "仅为待人工核实建议",
                        "suggested_value": "Synthetic material",
                    }],
                },
            },
        )
        self.assertEqual(submit.status_code, 200, submit.content)

    def test_advice_context_rejects_unbounded_complete_source_refs(self):
        from unittest.mock import patch

        product_id = "a" * 32
        source_refs = {
            "product_id": product_id,
            "revision_id": "b" * 32,
            "task_file_ids": [f"{index:032x}" for index in range(31)],
        }
        canonical = {
            "products": [{"product_id": product_id, "missing_fields": ["material"], "source_refs": source_refs}],
        }
        with self.assertRaisesRegex(WorkflowOrchestrationError, "建议来源超出支持范围"):
            WorkflowOrchestrator._native_advice_context("product_profile", canonical)

        workflow, subtask = self.create_native_workflow()
        center = {
            "agent_id": "host-center-over-limit",
            "agent_preset": "tradeloom-center",
            "parent_session": None,
            "delegation_depth": 0,
        }
        with patch.object(
            WorkflowOrchestrator,
            "_canonical_native_result",
            new=staticmethod(lambda _workflow, _subtask: (canonical, "c" * 64)),
        ):
            response = self.post_json(
                f"/api/workflow-tasks/{workflow.id}/subtasks/{subtask.id}/native-assignment",
                {
                    "idempotency_key": "native-advice-context-over-limit",
                    "expected_expert_preset": "tradeloom-product",
                    "center_identity": center,
                },
            )
        self.assertEqual(response.status_code, 413)
        self.assertEqual(response.json()["code"], "advice_context_too_large")
        self.assertFalse(WorkflowStep.objects.filter(task=workflow, step_key=f"subtask:{subtask.id}").exists())

    def test_delivery_advice_context_contains_only_canonical_needs_human_checks(self):
        now = timezone.now()
        product = Product.objects.create(
            task=self.batch,
            position=1,
            sku="SYN-DELIVERY-1",
            name="Synthetic delivery product",
            category="category",
            material="material",
            size="size",
            color="color",
            image_filename="",
            missing_fields=[],
            created_at=now,
            updated_at=now,
        )
        ProductRevision.objects.create(
            product=product,
            version=1,
            snapshot={
                "sku": product.sku, "name": product.name, "category": product.category,
                "material": product.material, "size": product.size, "color": product.color,
                "image_filename": "", "english_name": "Synthetic English name",
            },
            status="confirmed",
            source_refs={},
        )
        workflow, delivery = self.create_native_workflow(
            task_type="generate_deliverables",
            user_goal="生成英文目录",
            role="delivery_quality",
        )
        product_step = SubTask.objects.get(task=workflow, agent_role="product_profile")
        product_step.status = "completed"
        product_step.save(update_fields=["status", "updated_at"])
        center = {
            "agent_id": "host-center-delivery-context",
            "agent_preset": "tradeloom-center",
            "parent_session": None,
            "delegation_depth": 0,
        }
        step = WorkflowOrchestrator().begin_native_assignment(
            workflow.id,
            delivery.id,
            "native-delivery-advice-context",
            center_identity=center,
            expected_expert_preset="tradeloom-delivery",
        )
        context = step.input_refs["native_assignment"]["advice_context"]
        self.assertEqual(context, {
            "schema_version": "native-advice-context.v1",
            "role": "delivery_quality",
            "checks": [{
                "check_code": "image",
                "product_id": product.id,
                "source_refs": {
                    "workflow_task_id": workflow.id,
                    "batch_id": self.batch.id,
                    "product_ids": [product.id],
                },
            }],
        })

    def test_native_assignment_http_binds_one_expected_direct_child(self):
        workflow, subtask = self.create_native_workflow()
        center = {
            "agent_id": "host-center-http-bind",
            "agent_preset": "tradeloom-center",
            "parent_session": None,
            "delegation_depth": 0,
        }
        created = self.post_json(
            f"/api/workflow-tasks/{workflow.id}/subtasks/{subtask.id}/native-assignment",
            {
                "idempotency_key": "native-http-bind",
                "expected_expert_preset": "tradeloom-product",
                "center_identity": center,
            },
        )
        self.assertEqual(created.status_code, 200)
        child = {
            "agent_id": "host-product-http-bind",
            "agent_preset": "tradeloom-product",
            "parent_session": center["agent_id"],
            "delegation_depth": 1,
        }
        bind_path = f"/api/workflow-tasks/{workflow.id}/native-assignments/{created.json()['assignment_id']}/bind"
        bound = self.post_json(bind_path, {
            "assignment_id": created.json()["assignment_id"],
            "step_id": created.json()["step_id"],
            "center_identity": center,
            "child_identity": child,
        })
        self.assertEqual(bound.status_code, 200, bound.content)
        self.assertEqual(bound.json()["child_agent_id"], child["agent_id"])
        replay = self.post_json(bind_path, {
            "assignment_id": created.json()["assignment_id"],
            "step_id": created.json()["step_id"],
            "center_identity": center,
            "child_identity": child,
        })
        self.assertEqual(replay.status_code, 200)
        sibling = self.post_json(bind_path, {
            "assignment_id": created.json()["assignment_id"],
            "step_id": created.json()["step_id"],
            "center_identity": center,
            "child_identity": {**child, "agent_id": "host-product-sibling-http"},
        })
        self.assertEqual(sibling.status_code, 409)

    def test_native_workflow_cannot_fall_through_legacy_mock_dispatch(self):
        workflow, subtask = self.create_native_workflow()
        from unittest.mock import Mock, patch

        runtime = Mock()
        with patch("workbench.agents.mock_runtime.MockAgentRuntime.run_subtask", side_effect=AssertionError("native must not call mock runtime")) as run_mock:
            with self.assertRaises(NativeAssignmentRequired):
                dispatch_saved_subtask(workflow.id, subtask.id, "legacy-dispatch-key", orchestrator=WorkflowOrchestrator(runtime))
            engine = WorkflowOrchestrator(runtime)
            with self.assertRaises(NativeAssignmentRequired):
                engine.dispatch_subtask(subtask.id, "direct-legacy-dispatch")
            failed = WorkflowStep.objects.create(
                task=workflow,
                step_key=f"subtask:{subtask.id}",
                status="failed",
                attempt=1,
                idempotency_key="native-failed-attempt",
                input_refs={"subtask_id": subtask.id, "execution_mode": "native_dsh"},
                output_refs={"retryable": True},
            )
            subtask.status = "failed"
            subtask.save(update_fields=["status"])
            with self.assertRaises(NativeAssignmentRequired):
                engine.retry_subtask(subtask.id, "direct-legacy-retry", expected_step_id=failed.id)
        run_mock.assert_not_called()
        subtask.refresh_from_db()
        workflow.refresh_from_db()
        self.assertEqual(subtask.status, "failed")
        self.assertEqual(workflow.status, "queued")
        self.assertEqual(WorkflowStep.objects.filter(task=workflow, step_key=f"subtask:{subtask.id}").count(), 1)

    def test_native_assignment_can_resume_only_from_review_apply_authority(self):
        now = timezone.now()
        product = Product.objects.create(
            task=self.batch,
            position=0,
            sku="NATIVE-001",
            name="Synthetic product",
            category="accessory",
            material="cotton",
            size="25mm",
            color="blue",
            image_filename="native-001.png",
            image_stored_name="native-001.png",
            missing_fields=["英文名称"],
            created_at=now,
            updated_at=now,
        )
        image = TaskFile.objects.create(
            task=self.batch,
            kind="image",
            original_name="native-001.png",
            stored_name="native-001.png",
            created_at=now,
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
                "english_name": "",
            },
            status="confirmed",
            source_refs={"image": {"task_file_id": image.id, "original_name": image.original_name, "stored_name": image.stored_name}},
        )
        workflow, subtask = self.create_native_workflow()
        engine = WorkflowOrchestrator()
        center = {
            "agent_id": "resume-center",
            "agent_preset": "tradeloom-center",
            "parent_session": None,
            "delegation_depth": 0,
        }
        first = engine.begin_native_assignment(
            workflow.id, subtask.id, "native-first-attempt",
            center_identity=center, expected_expert_preset="tradeloom-product",
        )
        child = {
            "agent_id": "resume-product",
            "agent_preset": "tradeloom-product",
            "parent_session": "resume-center",
            "delegation_depth": 1,
        }
        self.bind_native_child(engine, workflow, first, child)
        engine.submit_native_assignment(
            workflow.id, first.id, first.id, child_identity=child,
            advice={"schema_version": "native-expert-advice.v1", "observations": [{
                "product_id": product.id,
                "field": "english_name",
                "source_refs": {
                    "product_id": product.id,
                    "revision_id": revision.id,
                    "task_file_ids": [image.id],
                },
                "note": "Unverified expert suggestion",
                "suggested_value": "Suggest only",
            }]},
        )
        review = HumanReview.objects.get(task=workflow, status="pending")
        signal = review.source_conflict["source_refs"]["signal"]
        self.assertEqual(signal["missing_field"], "english_name")
        self.assertEqual(review.answer, {}, "native advice must not be treated as an applied human answer")
        self.assertEqual(
            review.source_conflict["source_refs"]["native_expert_advice"][0]["source_refs"]["revision_id"],
            revision.id,
        )
        submitted = self.client.post(
            f"/api/workflow-tasks/{workflow.id}/reviews/{review.id}/submit",
            data=json.dumps({
                "review_key": review.review_key,
                "answer": {"type": "set_literal_field", "field": "english_name", "value": "Synthetic Name"},
                "reviewer": "operator-one",
            }),
            content_type="application/json",
        )
        self.assertEqual(submitted.status_code, 200, submitted.content)
        applied = self.client.post(
            f"/api/workflow-tasks/{workflow.id}/reviews/apply",
            data=json.dumps({
                "review_ids": [review.id],
                "idempotency_key": "native-review-apply",
                "decision": "apply_and_confirm",
                "reviewer": "operator-one",
            }),
            content_type="application/json",
        )
        self.assertEqual(applied.status_code, 200, applied.content)
        latest_plan = WorkflowStep.objects.filter(task=workflow, step_key="center_plan", status="completed").order_by("-attempt").first()
        self.assertEqual(latest_plan.input_refs["execution_mode"], "native_dsh")
        self.assertEqual(latest_plan.input_refs["execution_confirmation_fingerprint"], WorkflowStep.objects.get(task=workflow, step_key="center_plan", attempt=1).input_refs["execution_confirmation_fingerprint"])

        apply_step = WorkflowStep.objects.get(task=workflow, step_key="apply_review_cycle")
        authority = apply_step.output_refs["resume_authority"][subtask.id]
        expected_key = (
            f"workflow:{workflow.id}:subtask:{subtask.id}:resume:{apply_step.id}:"
            f"prior:{first.id}:attempt:{first.attempt + 1}"
        )
        resumed = engine.begin_native_assignment(
            workflow.id, subtask.id, expected_key,
            center_identity=center, expected_expert_preset="tradeloom-product",
        )
        self.assertEqual(resumed.attempt, authority["next_attempt"])
        self.assertEqual(resumed.input_refs["native_assignment"]["center"], center)
        self.assertEqual(resumed.input_refs["native_assignment"]["expected_expert_preset"], "tradeloom-product")
        self.assertEqual(WorkflowStep.objects.filter(task=workflow, step_key=f"subtask:{subtask.id}").count(), 2)

        resumed_child = {**child, "agent_id": "resume-product-2"}
        self.bind_native_child(engine, workflow, resumed, resumed_child)
        product_done = engine.submit_native_assignment(
            workflow.id, resumed.id, resumed.id, child_identity=resumed_child,
            advice={"schema_version": "native-expert-advice.v1", "observations": []},
        )
        self.assertEqual(product_done["result_status"], "candidate")
        delivery = SubTask.objects.get(task=workflow, agent_role="delivery_quality")
        delivery_step = engine.begin_native_assignment(
            workflow.id, delivery.id, "native-delivery-after-review",
            center_identity=center, expected_expert_preset="tradeloom-delivery",
        )
        delivery_child = {
            "agent_id": "resume-delivery",
            "agent_preset": "tradeloom-delivery",
            "parent_session": "resume-center",
            "delegation_depth": 1,
        }
        self.bind_native_child(engine, workflow, delivery_step, delivery_child)
        delivery_receipt = engine.submit_native_assignment(
            workflow.id, delivery_step.id, delivery_step.id,
            child_identity=delivery_child,
            advice={"schema_version": "native-expert-advice.v1", "observations": []},
        )
        self.assertEqual(delivery_receipt["result_status"], "ready_for_generation")
        delivery_step.refresh_from_db()
        result = delivery_step.output_refs["result_snapshot"]["result"]
        self.assertFalse(result["artifacts_generated"])
        self.assertEqual(result["artifact_quality"], "not_evaluated")

    def test_saved_native_workflow_rejects_explicit_mode_switch_but_legacy_replay_is_stable(self):
        workflow, _ = self.create_native_workflow()
        engine = WorkflowOrchestrator()
        saved = engine.plan_task(workflow.id)
        self.assertTrue(saved["subtasks"])
        self.assertEqual(engine.plan_task(workflow.id), saved)
        with self.assertRaises(WorkflowOrchestrationError):
            engine.plan_task(workflow.id, execution_mode="local_mock")

    def test_direct_expert_submit_is_bound_to_host_child_and_replays_frozen_result(self):
        workflow, subtask = self.create_native_workflow()
        engine = WorkflowOrchestrator()
        step = engine.begin_native_assignment(
            workflow.id,
            subtask.id,
            "native-submit-assignment",
            center_identity={
                "agent_id": "host-center-3",
                "agent_preset": "tradeloom-center",
                "parent_session": None,
                "delegation_depth": 0,
            },
            expected_expert_preset="tradeloom-product",
        )
        child_identity = {
            "agent_id": "host-product-3",
            "agent_preset": "tradeloom-product",
            "parent_session": "host-center-3",
            "delegation_depth": 1,
        }
        advice = {"schema_version": "native-expert-advice.v1", "observations": []}

        with self.assertRaises(WorkflowOrchestrationError):
            engine.submit_native_assignment(
                workflow.id, step.id, step.id, child_identity=child_identity, advice=advice
            )
        bound = engine.bind_native_assignment(
            workflow.id,
            step.id,
            step.id,
            center_identity={
                "agent_id": "host-center-3",
                "agent_preset": "tradeloom-center",
                "parent_session": None,
                "delegation_depth": 0,
            },
            child_identity=child_identity,
        )
        self.assertEqual(bound.input_refs["native_assignment"]["child_agent_id"], "host-product-3")

        accepted = engine.submit_native_assignment(
            workflow.id, step.id, step.id, child_identity=child_identity, advice=advice
        )
        replay = engine.submit_native_assignment(
            workflow.id, step.id, step.id, child_identity=child_identity, advice=advice
        )

        self.assertEqual(accepted, replay)
        self.assertEqual(accepted["status"], "accepted")
        self.assertEqual(accepted["execution_mode"], "native_dsh")
        self.assertEqual(accepted["provider"], "unknown")
        self.assertEqual(accepted["model"], "unknown")
        step.refresh_from_db()
        subtask.refresh_from_db()
        self.assertEqual(step.status, "completed")
        self.assertEqual(step.output_refs["native_submission"]["child_agent_id"], "host-product-3")
        self.assertEqual(step.output_refs["native_submission"]["state"], "accepted_not_settled")
        self.assertEqual(step.output_refs["result_snapshot"]["result"]["role"], "product_profile")
        self.assertEqual(subtask.status, "completed")

        with self.assertRaises(WorkflowOrchestrationError):
            engine.submit_native_assignment(
                workflow.id,
                step.id,
                step.id,
                child_identity={**child_identity, "agent_id": "sibling-product-3"},
                advice=advice,
            )
        with self.assertRaises(WorkflowOrchestrationError):
            engine.submit_native_assignment(
                workflow.id,
                step.id,
                step.id,
                child_identity=child_identity,
                advice={"schema_version": "native-expert-advice.v1", "observations": [{"note": "different"}]},
            )

    def test_direct_expert_submit_rejects_wrong_preset_and_depth_before_binding(self):
        workflow, subtask = self.create_native_workflow()
        engine = WorkflowOrchestrator()
        step = engine.begin_native_assignment(
            workflow.id,
            subtask.id,
            "native-submit-identity-guards",
            center_identity={
                "agent_id": "host-center-identity-guards",
                "agent_preset": "tradeloom-center",
                "parent_session": None,
                "delegation_depth": 0,
            },
            expected_expert_preset="tradeloom-product",
        )
        valid_identity = {
            "agent_id": "host-product-identity-guards",
            "agent_preset": "tradeloom-product",
            "parent_session": "host-center-identity-guards",
            "delegation_depth": 1,
        }
        advice = {"schema_version": "native-expert-advice.v1", "observations": []}
        for invalid_identity in (
            {**valid_identity, "agent_preset": "tradeloom-delivery"},
            {**valid_identity, "delegation_depth": 2},
        ):
            with self.subTest(invalid_identity=invalid_identity):
                with self.assertRaises(WorkflowOrchestrationError):
                    engine.submit_native_assignment(
                        workflow.id,
                        step.id,
                        step.id,
                        child_identity=invalid_identity,
                        advice=advice,
                    )
        step.refresh_from_db()
        self.assertEqual(step.status, "running")
        self.assertNotIn("child_agent_id", step.input_refs["native_assignment"])

    def test_native_assignment_binds_only_a_live_expected_direct_child(self):
        workflow, subtask = self.create_native_workflow()
        engine = WorkflowOrchestrator()
        center = {
            "agent_id": "host-center-bind",
            "agent_preset": "tradeloom-center",
            "parent_session": None,
            "delegation_depth": 0,
        }
        step = engine.begin_native_assignment(
            workflow.id, subtask.id, "native-bind-child",
            center_identity=center, expected_expert_preset="tradeloom-product",
        )
        child = {
            "agent_id": "host-product-bind",
            "agent_preset": "tradeloom-product",
            "parent_session": "host-center-bind",
            "delegation_depth": 1,
        }
        for invalid_child in (
            {**child, "agent_preset": "tradeloom-delivery"},
            {**child, "delegation_depth": 2},
            {**child, "parent_session": "another-center"},
        ):
            with self.subTest(invalid_child=invalid_child):
                with self.assertRaises(WorkflowOrchestrationError):
                    engine.bind_native_assignment(
                        workflow.id, step.id, step.id,
                        center_identity=center, child_identity=invalid_child,
                    )
        bound = engine.bind_native_assignment(
            workflow.id, step.id, step.id, center_identity=center, child_identity=child,
        )
        replay = engine.bind_native_assignment(
            workflow.id, step.id, step.id, center_identity=center, child_identity=child,
        )
        self.assertEqual(bound.id, replay.id)
        self.assertEqual(replay.input_refs["native_assignment"]["child_agent_id"], child["agent_id"])
        with self.assertRaises(WorkflowOrchestrationError):
            engine.bind_native_assignment(
                workflow.id,
                step.id,
                step.id,
                center_identity=center,
                child_identity={**child, "agent_id": "host-product-sibling"},
            )
        step.refresh_from_db()
        self.assertEqual(step.input_refs["native_assignment"]["child_agent_id"], child["agent_id"])

    def test_interrupted_native_assignment_rejects_late_submit_as_unknown(self):
        workflow, subtask = self.create_native_workflow()
        engine = WorkflowOrchestrator()
        step = engine.begin_native_assignment(
            workflow.id,
            subtask.id,
            "native-submit-after-interrupt",
            center_identity={
                "agent_id": "host-center-interrupted",
                "agent_preset": "tradeloom-center",
                "parent_session": None,
                "delegation_depth": 0,
            },
            expected_expert_preset="tradeloom-product",
        )
        interrupted = engine.interrupt_subtask(
            subtask.id,
            expected_step_id=step.id,
            operator_label="synthetic-operator",
            note="Native child completion is not observable after interruption.",
        )
        self.assertTrue(interrupted.output_refs["outcome_unknown"])
        self.assertFalse(interrupted.output_refs["retryable"])
        with self.assertRaises(StaleAttemptResult):
            engine.submit_native_assignment(
                workflow.id,
                step.id,
                step.id,
                child_identity={
                    "agent_id": "host-product-late",
                    "agent_preset": "tradeloom-product",
                    "parent_session": "host-center-interrupted",
                    "delegation_depth": 1,
                },
                advice={"schema_version": "native-expert-advice.v1", "observations": []},
            )
        interrupted.refresh_from_db()
        self.assertEqual(interrupted.status, "failed")
        self.assertTrue(interrupted.output_refs["outcome_unknown"])
        self.assertNotIn("native_submission", interrupted.output_refs)

    def test_direct_expert_submit_rejects_wrong_parent_without_claiming_sender(self):
        workflow, subtask = self.create_native_workflow()
        engine = WorkflowOrchestrator()
        step = engine.begin_native_assignment(
            workflow.id,
            subtask.id,
            "native-submit-wrong-parent",
            center_identity={
                "agent_id": "host-center-4",
                "agent_preset": "tradeloom-center",
                "parent_session": None,
                "delegation_depth": 0,
            },
            expected_expert_preset="tradeloom-product",
        )
        with self.assertRaises(WorkflowOrchestrationError):
            engine.submit_native_assignment(
                workflow.id,
                step.id,
                step.id,
                child_identity={
                    "agent_id": "other-child",
                    "agent_preset": "tradeloom-product",
                    "parent_session": "not-the-center",
                    "delegation_depth": 1,
                },
                advice={"schema_version": "native-expert-advice.v1", "observations": []},
            )
        step.refresh_from_db()
        self.assertNotIn("child_agent_id", step.input_refs["native_assignment"])
        self.assertEqual(step.status, "running")

    def test_native_assignment_fences_legacy_product_value_changes_even_when_role_result_is_unchanged(self):
        now = timezone.now()
        product = Product.objects.create(
            task=self.batch,
            position=0,
            sku="LEGACY-001",
            name="Synthetic product",
            category="accessory",
            material="cotton",
            size="25mm",
            color="blue",
            image_filename="",
            image_stored_name="",
            missing_fields=["英文名称"],
            created_at=now,
            updated_at=now,
        )
        workflow, subtask = self.create_native_workflow()
        engine = WorkflowOrchestrator()
        step = engine.begin_native_assignment(
            workflow.id,
            subtask.id,
            "native-source-fence-legacy-product",
            center_identity={
                "agent_id": "host-center-legacy",
                "agent_preset": "tradeloom-center",
                "parent_session": None,
                "delegation_depth": 0,
            },
            expected_expert_preset="tradeloom-product",
        )
        child = {
            "agent_id": "host-product-legacy",
            "agent_preset": "tradeloom-product",
            "parent_session": "host-center-legacy",
            "delegation_depth": 1,
        }
        self.bind_native_child(engine, workflow, step, child)
        frozen_result_hash = step.input_refs["native_assignment"]["source_result_fingerprint"]
        frozen_source_hash = step.input_refs["native_assignment"]["source_facts_fingerprint"]
        result_hash_before = engine._canonical_native_result(workflow, subtask)[1]
        product.material = "linen"
        product.save(update_fields=["material", "updated_at"])
        result_hash_after = engine._canonical_native_result(workflow, subtask)[1]

        self.assertEqual(result_hash_before, result_hash_after)
        with self.assertRaises(StaleAttemptResult):
            engine.submit_native_assignment(
                workflow.id,
                step.id,
                step.id,
                child_identity=child,
                advice={"schema_version": "native-expert-advice.v1", "observations": []},
            )
        step.refresh_from_db()
        self.assertEqual(len(frozen_result_hash), 64)
        self.assertEqual(len(frozen_source_hash), 64)
        self.assertEqual(step.status, "running")
        self.assertEqual(step.input_refs["native_assignment"]["child_agent_id"], child["agent_id"])

    def test_native_execution_mode_is_bound_to_preview_and_persisted(self):
        preview = self.post_json(
            "/api/workflow-intent/preview",
            {
                "batch_id": self.batch.id,
                "user_goal": "准备产品资料",
                "execution_mode": "native_dsh",
            },
        )
        self.assertEqual(preview.status_code, 200)
        preview_body = preview.json()
        self.assertEqual(preview_body["execution_mode"], "native_dsh")
        self.assertTrue(preview_body["confirmation_token"])

        mismatched = self.post_json(
            "/api/workflow-tasks",
            {
                "batch_id": self.batch.id,
                "user_goal": "准备产品资料",
                "task_type": "prepare_product_data",
                "execution_mode": "local_mock",
                "confirmation_token": preview_body["confirmation_token"],
            },
        )
        self.assertEqual(mismatched.status_code, 409)
        self.assertEqual(mismatched.json()["code"], "intent_confirmation_invalid")

        created = self.post_json(
            "/api/workflow-tasks",
            {
                "batch_id": self.batch.id,
                "user_goal": "准备产品资料",
                "task_type": "prepare_product_data",
                "execution_mode": "native_dsh",
                "idempotency_key": "native-create-1",
                "confirmation_token": preview_body["confirmation_token"],
            },
        )
        self.assertEqual(created.status_code, 201)
        workflow = WorkflowTask.objects.get(pk=created.json()["id"])
        center_step = WorkflowStep.objects.get(task=workflow, step_key="center_plan")
        self.assertEqual(created.json()["execution_mode"], "native_dsh")
        self.assertEqual(center_step.input_refs["execution_mode"], "native_dsh")
        self.assertTrue(center_step.input_refs["execution_confirmation_fingerprint"])

    def test_legacy_create_without_mode_remains_local_mock(self):
        created = self.post_json(
            "/api/workflow-tasks",
            {"batch_id": self.batch.id, "user_goal": "准备产品资料"},
        )
        self.assertEqual(created.status_code, 201)
        self.assertEqual(created.json()["execution_mode"], "local_mock")


class NativeWorkflowConcurrencyTests(TransactionTestCase):
    reset_sequences = True

    def create_native_workflow(self):
        now = timezone.now()
        batch = Task.objects.create(
            title="Native concurrency synthetic batch",
            mode="demo",
            status="awaiting_confirmation",
            created_at=now,
            updated_at=now,
        )
        preview = self.client.post(
            "/api/workflow-intent/preview",
            data=json.dumps({"batch_id": batch.id, "user_goal": "准备产品资料", "execution_mode": "native_dsh"}),
            content_type="application/json",
        )
        self.assertEqual(preview.status_code, 200)
        created = self.client.post(
            "/api/workflow-tasks",
            data=json.dumps({
                "batch_id": batch.id,
                "user_goal": "准备产品资料",
                "task_type": "prepare_product_data",
                "execution_mode": "native_dsh",
                "idempotency_key": "native-concurrent-create",
                "confirmation_token": preview.json()["confirmation_token"],
            }),
            content_type="application/json",
        )
        self.assertEqual(created.status_code, 201, created.content)
        workflow = WorkflowTask.objects.get(pk=created.json()["id"])
        subtask = SubTask.objects.get(task=workflow, agent_role="product_profile")
        return workflow, subtask

    def test_concurrent_begin_and_same_child_submit_create_one_step_and_receipt(self):
        workflow, subtask = self.create_native_workflow()
        center = {
            "agent_id": "native-concurrent-center",
            "agent_preset": "tradeloom-center",
            "parent_session": None,
            "delegation_depth": 0,
        }
        barrier = Barrier(2)

        def begin():
            close_old_connections()
            try:
                barrier.wait(timeout=10)
                return WorkflowOrchestrator().begin_native_assignment(
                    workflow.id,
                    subtask.id,
                    "native-concurrent-assignment",
                    center_identity=center,
                    expected_expert_preset="tradeloom-product",
                )
            finally:
                close_old_connections()

        with ThreadPoolExecutor(max_workers=2) as pool:
            first, second = list(pool.map(lambda _index: begin(), range(2)))
        self.assertEqual(first.id, second.id)
        self.assertEqual(WorkflowStep.objects.filter(task=workflow, step_key=f"subtask:{subtask.id}").count(), 1)

        child = {
            "agent_id": "native-concurrent-product",
            "agent_preset": "tradeloom-product",
            "parent_session": center["agent_id"],
            "delegation_depth": 1,
        }
        WorkflowOrchestrator().bind_native_assignment(
            workflow.id, first.id, first.id, center_identity=center, child_identity=child,
        )
        submit_barrier = Barrier(2)
        advice = {"schema_version": "native-expert-advice.v1", "observations": []}

        def submit():
            close_old_connections()
            try:
                submit_barrier.wait(timeout=10)
                return WorkflowOrchestrator().submit_native_assignment(
                    workflow.id,
                    first.id,
                    first.id,
                    child_identity=child,
                    advice=advice,
                )
            finally:
                close_old_connections()

        with ThreadPoolExecutor(max_workers=2) as pool:
            receipt_a, receipt_b = list(pool.map(lambda _index: submit(), range(2)))
        self.assertEqual(receipt_a, receipt_b)
        step = WorkflowStep.objects.get(pk=first.id)
        self.assertEqual(step.status, "completed")
        self.assertEqual(step.output_refs["native_submission"]["receipt"], receipt_a)
        self.assertEqual(
            WorkflowStep.objects.filter(task=workflow, step_key=f"subtask:{subtask.id}").count(),
            1,
        )
