from __future__ import annotations

from copy import deepcopy
import json
from unittest.mock import Mock, patch

from django.test import TestCase
from django.utils import timezone
from jsonschema import Draft202012Validator

from workbench.agents.mock_runtime import MockAgentRuntime
from workbench.agents.result_contracts import (
    RoleResultContractError,
    validate_role_result,
)
from workbench.agents.registry import build_workflow_role_registry
from workbench.agents.context import _TOOL_DEFINITIONS
from workbench.agents.tool_contracts import ToolDefinition
from workbench.agents.workflow_contracts import ToolOutputContractError
from workbench.agents.workflow_contracts import InputContractError
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
    CompletionGateError,
    DependencyNotReady,
    IdempotencyConflict,
    InvalidAgentResult,
    StepInProgress,
    WorkflowOrchestrator,
)


class WorkflowOrchestratorTests(TestCase):
    def setUp(self):
        now = timezone.now()
        self.batch = Task.objects.create(
            title="Task10 演示批次",
            mode="demo",
            status="confirmed",
            created_at=now,
            updated_at=now,
        )
        self.product = Product.objects.create(
            task=self.batch,
            position=0,
            sku="TL-001",
            name="丝带",
            category="丝带",
            material="涤纶",
            size="25mm",
            color="酒红",
            image_filename="TL-001.svg",
            image_stored_name="tl-001.svg",
            missing_fields=[],
            created_at=now,
            updated_at=now,
        )
        ProductRevision.objects.create(
            product=self.product,
            version=1,
            snapshot={
                "sku": "TL-001", "name": "丝带", "category": "丝带",
                "material": "涤纶", "size": "25mm", "color": "酒红",
                "image_filename": "TL-001.svg", "english_name": "Ribbon",
            },
            status="confirmed",
        )
        TaskFile.objects.create(
            task=self.batch,
            kind="image",
            original_name="TL-001.svg",
            stored_name="tl-001.svg",
            created_at=now,
        )
        self.workflow = WorkflowTask.objects.create(
            batch=self.batch,
            user_goal="生成英文目录并检查交付资料",
            task_type="prepare_product_data",
            status="queued",
            current_step="plan",
        )
        self.engine = WorkflowOrchestrator(MockAgentRuntime())

    def test_plan_persists_center_step_and_two_dependent_real_role_subtasks_once(self):
        first = self.engine.plan_task(self.workflow.id)
        second = self.engine.plan_task(self.workflow.id)

        self.assertEqual(first, second)
        self.assertEqual(SubTask.objects.filter(task=self.workflow).count(), 2)
        product_step = SubTask.objects.get(task=self.workflow, agent_role="product_profile")
        delivery_step = SubTask.objects.get(task=self.workflow, agent_role="delivery_quality")
        self.assertEqual(list(delivery_step.depends_on.all()), [product_step])
        center = WorkflowStep.objects.get(task=self.workflow, step_key="center_plan")
        self.assertEqual(center.status, "completed")
        self.assertEqual(center.output_refs["subtask_ids"], [product_step.id, delivery_step.id])

        with self.assertRaises(DependencyNotReady):
            self.engine.dispatch_subtask(delivery_step.id, "delivery-first")
        product_step = self.engine.dispatch_subtask(product_step.id, "product-first")
        delivery_step = self.engine.dispatch_subtask(delivery_step.id, "delivery-after-product")
        self.assertEqual(product_step.status, "completed")
        self.assertEqual(delivery_step.status, "completed")
        self.assertEqual(delivery_step.output_refs["result"]["quality_scope"], "data_readiness")
        self.assertEqual(self.workflow.status, "queued")
        self.workflow.refresh_from_db()
        self.assertNotEqual(self.workflow.status, "completed")
        self.assertTrue(EventLog.objects.filter(task=self.workflow, event_type="subtask_completed").count() == 2)
        self.assertTrue(EventLog.objects.filter(task=self.workflow, event_type="workflow_status_changed").exists())
        self.assertFalse(HumanReview.objects.filter(task=self.workflow).exists())

    def test_dispatch_replay_and_resume_do_not_repeat_handlers_or_events(self):
        self.engine.plan_task(self.workflow.id)
        subtask = SubTask.objects.get(task=self.workflow, agent_role="product_profile")
        first = self.engine.dispatch_subtask(subtask.id, "stable-product-key")
        before = EventLog.objects.filter(task=self.workflow).count()
        replay = self.engine.dispatch_subtask(subtask.id, "stable-product-key")
        resumed = self.engine.resume_task(self.workflow.id)
        after_first_resume = EventLog.objects.filter(task=self.workflow).count()
        second_resume = self.engine.resume_task(self.workflow.id)

        self.assertEqual(replay.output_refs, first.output_refs)
        self.assertEqual(resumed["status"], "running")
        self.assertEqual(second_resume["status"], "running")
        self.assertEqual(EventLog.objects.filter(task=self.workflow).count(), after_first_resume)
        self.assertGreater(after_first_resume, before)
        self.assertEqual(WorkflowStep.objects.filter(task=self.workflow, step_key__startswith="subtask:").count(), 2)

    def test_invalid_role_input_fails_safely_and_same_key_replays_without_execution(self):
        self.engine.plan_task(self.workflow.id)
        subtask = SubTask.objects.get(task=self.workflow, agent_role="product_profile")
        subtask.input_refs = {**subtask.input_refs, "scope": "wrong"}
        subtask.save(update_fields=["input_refs", "updated_at"])

        with patch(
            "workbench.agents.product_agent.ProductAgent.execute",
            return_value={"role": "product_profile"},
        ) as execute:
            with self.assertRaises(InputContractError):
                self.engine.dispatch_subtask(subtask.id, "invalid-role-input")
            subtask.refresh_from_db()
            self.workflow.refresh_from_db()
            step = WorkflowStep.objects.get(
                task=self.workflow, idempotency_key="invalid-role-input"
            )
            failed_events = EventLog.objects.filter(
                task=self.workflow, event_type="subtask_failed"
            )
            self.assertEqual((self.workflow.status, subtask.status, step.status), ("failed", "failed", "failed"))
            self.assertNotIn("result", subtask.output_refs)
            self.assertNotIn("product_profile", self.workflow.result_refs.get("subtasks", {}))
            self.assertEqual(HumanReview.objects.filter(task=self.workflow).count(), 0)
            self.assertEqual(Artifact.objects.filter(task=self.workflow).count(), 0)
            self.assertEqual(failed_events.count(), 1)
            self.assertEqual(
                failed_events.get().payload_summary["refs"]["workflow_step_id"],
                step.id,
            )
            self.assertEqual(
                EventLog.objects.filter(task=self.workflow, event_type="subtask_started").get().payload_summary["refs"]["workflow_step_id"],
                step.id,
            )

            replay = self.engine.dispatch_subtask(subtask.id, "invalid-role-input")
            self.assertEqual(replay.status, "failed")
            self.assertEqual(execute.call_count, 0)
            self.assertEqual(failed_events.count(), 1)
            self.assertEqual(
                EventLog.objects.filter(task=self.workflow, event_type="subtask_started").count(),
                1,
            )

    def test_saved_legacy_plan_replays_without_replanning_or_rewriting(self):
        historical_plan = {
            "schema_version": "agent-runtime-plan.v2",
            "subtasks": [{"key": "legacy", "input_refs": {"original": True}}],
        }
        WorkflowStep.objects.create(
            task=self.workflow,
            step_key="center_plan",
            status="completed",
            attempt=1,
            idempotency_key=f"workflow:{self.workflow.id}:center_plan",
            input_refs={"workflow_task_id": self.workflow.id},
            output_refs={"plan": historical_plan, "subtask_ids": []},
        )
        existing_events = EventLog.objects.filter(task=self.workflow).count()
        with patch.object(self.engine.runtime, "plan_task", side_effect=AssertionError):
            replay = self.engine.plan_task(self.workflow.id)

        self.assertEqual(replay, historical_plan)
        self.assertEqual(WorkflowStep.objects.filter(task=self.workflow).count(), 1)
        self.assertEqual(SubTask.objects.filter(task=self.workflow).count(), 0)
        self.assertEqual(EventLog.objects.filter(task=self.workflow).count(), existing_events)

    def test_idempotency_key_cannot_be_reused_for_another_subtask(self):
        self.engine.plan_task(self.workflow.id)
        product_step = SubTask.objects.get(task=self.workflow, agent_role="product_profile")
        delivery_step = SubTask.objects.get(task=self.workflow, agent_role="delivery_quality")
        self.engine.dispatch_subtask(product_step.id, "same-key")

        with self.assertRaises(IdempotencyConflict):
            self.engine.dispatch_subtask(delivery_step.id, "same-key")

    def test_concurrent_replay_of_running_logical_step_reports_in_progress(self):
        self.engine.plan_task(self.workflow.id)
        subtask = SubTask.objects.get(task=self.workflow, agent_role="product_profile")
        subtask.status = "running"
        subtask.save(update_fields=["status"])
        WorkflowStep.objects.create(
            task=self.workflow,
            step_key=f"subtask:{subtask.id}",
            status="running",
            idempotency_key="original-key",
            started_at=timezone.now(),
        )

        with self.assertRaises(StepInProgress):
            self.engine.dispatch_subtask(subtask.id, "other-replay-key")

    def test_needs_human_pauses_workflow_and_blocks_dependents(self):
        ProductRevision.objects.create(
            product=self.product,
            version=2,
            snapshot={
                "sku": "TL-001", "name": "丝带", "category": "丝带",
                "material": "涤纶", "size": "25mm", "color": "酒红",
                "image_filename": "TL-001.svg", "english_name": "",
            },
            status="confirmed",
        )
        self.engine.plan_task(self.workflow.id)
        product_step = SubTask.objects.get(task=self.workflow, agent_role="product_profile")
        delivery_step = SubTask.objects.get(task=self.workflow, agent_role="delivery_quality")

        product_step = self.engine.dispatch_subtask(product_step.id, "product-before-delivery-check")
        self.assertEqual(product_step.status, "waiting_human")
        self.workflow.refresh_from_db()
        self.assertEqual(self.workflow.status, "waiting_human")
        self.assertEqual(self.workflow.result_refs["next_step"], "human_review")
        self.assertIn("product_profile", self.workflow.result_refs["subtasks"])
        with self.assertRaises(DependencyNotReady):
            self.engine.dispatch_subtask(delivery_step.id, "delivery-blocked")
        with self.assertRaises(DependencyNotReady):
            self.engine.resume_task(self.workflow.id)

    def test_handler_exception_is_persisted_as_failed_then_reraised(self):
        self.engine.plan_task(self.workflow.id)
        subtask = SubTask.objects.get(task=self.workflow, agent_role="product_profile")

        class BrokenRuntime:
            def run_subtask(self, _subtask_id):
                raise RuntimeError("handler fault")

        engine = WorkflowOrchestrator(BrokenRuntime())
        with self.assertRaisesRegex(RuntimeError, "handler fault"):
            engine.dispatch_subtask(subtask.id, "failing-product")
        subtask.refresh_from_db()
        self.workflow.refresh_from_db()
        step = WorkflowStep.objects.get(task=self.workflow, idempotency_key="failing-product")
        self.assertEqual(subtask.status, "failed")
        self.assertEqual(step.status, "failed")
        self.assertEqual(self.workflow.status, "failed")
        self.assertEqual(
            self.workflow.error_summary,
            "子任务执行失败，请检查输入与运行环境",
        )
        self.assertTrue(EventLog.objects.filter(task=self.workflow, event_type="subtask_failed").exists())
        page = self.client.get("/agent-center")
        self.assertContains(page, "产品资料")
        self.assertContains(page, "错误：子任务执行失败，请检查输入与运行环境")

    def test_invalid_agent_result_shapes_are_persisted_failed(self):
        invalid_results = (["not", "an", "object"], {}, {"status": "unknown_status"})
        for index, result in enumerate(invalid_results):
            with self.subTest(result=result):
                workflow = WorkflowTask.objects.create(
                    batch=self.batch,
                    user_goal="验证结构化返回边界",
                    task_type="prepare_product_data",
                    status="queued",
                )
                WorkflowOrchestrator(MockAgentRuntime()).plan_task(workflow.id)
                subtask = SubTask.objects.get(task=workflow, agent_role="product_profile")

                class InvalidRuntime:
                    def run_subtask(self, _subtask_id):
                        return result

                engine = WorkflowOrchestrator(InvalidRuntime())
                with self.assertRaises(InvalidAgentResult):
                    engine.dispatch_subtask(subtask.id, f"invalid-result-{index}")
                subtask.refresh_from_db()
                workflow.refresh_from_db()
                step = WorkflowStep.objects.get(task=workflow, step_key=f"subtask:{subtask.id}")
                self.assertEqual(subtask.status, "failed")
                self.assertEqual(step.status, "failed")
                self.assertEqual(workflow.status, "failed")

    def test_role_results_must_match_registered_contract_and_claim_identity(self):
        cases = [
            ("product_profile", "required", lambda result: result.pop("facts_changed")),
            ("product_profile", "type", lambda result: result.update(products="invalid")),
            ("product_profile", "schema_version", lambda result: result.update(schema_version="wrong")),
            ("product_profile", "role", lambda result: result.update(role="delivery_quality")),
            ("product_profile", "task_id", lambda result: result.update(task_id="wrong")),
            ("product_profile", "batch_id", lambda result: result.update(batch_id="wrong")),
            ("product_profile", "facts_changed", lambda result: result.update(facts_changed=True)),
            ("delivery_quality", "const", lambda result: result.update(quality_scope="artifact_quality")),
            ("delivery_quality", "type", lambda result: result.update(checks="invalid")),
            ("delivery_quality", "artifacts_generated", lambda result: result.update(artifacts_generated=True)),
            ("delivery_quality", "artifact_quality", lambda result: result.update(artifact_quality="passed")),
            ("product_profile", "json", lambda result: result.update(extension=float("nan"))),
        ]
        for index, (role, invalid_field, mutate) in enumerate(cases):
            with self.subTest(role=role, invalid_field=invalid_field):
                workflow = WorkflowTask.objects.create(
                    batch=self.batch, user_goal="验证结果结构契约",
                    task_type="prepare_product_data", status="queued",
                )
                WorkflowOrchestrator(MockAgentRuntime()).plan_task(workflow.id)
                if role == "delivery_quality":
                    product_subtask = SubTask.objects.get(task=workflow, agent_role="product_profile")
                    WorkflowOrchestrator(MockAgentRuntime()).dispatch_subtask(
                        product_subtask.id, f"contract-prerequisite-{index}"
                    )
                subtask = SubTask.objects.get(task=workflow, agent_role=role)
                valid_result = MockAgentRuntime().run_subtask(subtask.id)
                result = deepcopy(valid_result)
                mutate(result)

                class InvalidContractRuntime:
                    def run_subtask(self, _subtask_id):
                        return result

                with self.assertRaises(InvalidAgentResult):
                    WorkflowOrchestrator(InvalidContractRuntime()).dispatch_subtask(
                        subtask.id, f"contract-invalid-{index}"
                    )
                subtask.refresh_from_db()
                workflow.refresh_from_db()
                step = WorkflowStep.objects.get(task=workflow, step_key=f"subtask:{subtask.id}")
                self.assertEqual((workflow.status, subtask.status, step.status), ("failed", "failed", "failed"))
                self.assertNotIn("result", subtask.output_refs)
                self.assertNotIn(role, workflow.result_refs.get("subtasks", {}))
                self.assertEqual(HumanReview.objects.filter(task=workflow).count(), 0)
                self.assertEqual(Artifact.objects.filter(task=workflow).count(), 0)
                self.assertTrue(EventLog.objects.filter(task=workflow, event_type="subtask_failed", payload_summary__refs__workflow_step_id=step.id).exists())

    def test_both_registered_role_contracts_accept_real_mock_results(self):
        self.engine.plan_task(self.workflow.id)

        class CompatibleRuntime:
            def run_subtask(inner_self, subtask_id):
                return {
                    **MockAgentRuntime().run_subtask(subtask_id),
                    "extension": {"producer": "future-role-version"},
                }

        engine = WorkflowOrchestrator(CompatibleRuntime())
        product = SubTask.objects.get(task=self.workflow, agent_role="product_profile")
        engine.dispatch_subtask(product.id, "contract-valid-product")
        delivery = SubTask.objects.get(task=self.workflow, agent_role="delivery_quality")
        engine.dispatch_subtask(delivery.id, "contract-valid-delivery")
        self.assertIn("result", product.__class__.objects.get(pk=product.pk).output_refs)
        self.assertIn("result", delivery.__class__.objects.get(pk=delivery.pk).output_refs)

    def test_tool_output_contract_failure_uses_safe_failed_step_and_same_key_replay(self):
        self.engine.plan_task(self.workflow.id)
        subtask = SubTask.objects.get(task=self.workflow, agent_role="product_profile")
        original = _TOOL_DEFINITIONS["validate_product_data"]
        handler = Mock(wraps=original.handler)
        invalid_tool_output_contract = ToolDefinition(
            original.description,
            original.input_schema,
            {"type": "array"},
            handler,
        )
        with patch.dict(
            "workbench.agents.context._TOOL_DEFINITIONS",
            {"validate_product_data": invalid_tool_output_contract},
        ):
            with self.assertRaises(ToolOutputContractError):
                self.engine.dispatch_subtask(subtask.id, "tool-contract-failed")
            subtask.refresh_from_db()
            self.workflow.refresh_from_db()
            step = WorkflowStep.objects.get(
                task=self.workflow, idempotency_key="tool-contract-failed"
            )
            self.assertEqual((self.workflow.status, subtask.status, step.status), ("failed", "failed", "failed"))
            self.assertNotIn("result", subtask.output_refs)
            self.assertNotIn("product_profile", self.workflow.result_refs.get("subtasks", {}))
            self.assertEqual(HumanReview.objects.filter(task=self.workflow).count(), 0)
            self.assertEqual(Artifact.objects.filter(task=self.workflow).count(), 0)
            failed_event = EventLog.objects.get(task=self.workflow, event_type="subtask_failed")
            started_event = EventLog.objects.get(task=self.workflow, event_type="subtask_started")
            self.assertEqual(failed_event.payload_summary["refs"]["workflow_step_id"], step.id)
            self.assertEqual(started_event.payload_summary["refs"]["workflow_step_id"], step.id)
            self.assertEqual(handler.call_count, 1)

            replay = self.engine.dispatch_subtask(subtask.id, "tool-contract-failed")
            self.assertEqual(replay.status, "failed")
            self.assertEqual(handler.call_count, 1)
            self.assertEqual(EventLog.objects.filter(task=self.workflow, event_type="subtask_started").count(), 1)
            self.assertEqual(EventLog.objects.filter(task=self.workflow, event_type="subtask_failed").count(), 1)

    def test_unavailable_and_non_execution_roles_cannot_return_subtask_results(self):
        registry = build_workflow_role_registry()
        center_result = MockAgentRuntime().plan_task(self.workflow.id)
        center_result.update(
            role="center", task_id=self.workflow.id, batch_id=self.batch.id
        )
        json.dumps(center_result, allow_nan=False)
        Draft202012Validator(registry.get("center").output_schema()).validate(
            center_result
        )
        with self.assertRaises(RoleResultContractError):
            validate_role_result(
                "center", center_result, task_id=self.workflow.id, batch_id=self.batch.id
            )

        for role_id in ("market_customer", "quotation"):
            with self.subTest(role_id=role_id):
                role = registry.get(role_id)
                placeholder_result = {
                    "error": "role_unavailable",
                    "code": 409,
                    "role_id": role_id,
                    "message": "尚未接入",
                    "schema_version": "workflow-role-result.v1",
                    "role": role_id,
                    "task_id": self.workflow.id,
                    "batch_id": self.batch.id,
                }
                json.dumps(placeholder_result, allow_nan=False)
                Draft202012Validator(role.output_schema()).validate(placeholder_result)
                with self.assertRaises(RoleResultContractError):
                    validate_role_result(
                        role_id,
                        placeholder_result,
                        task_id=self.workflow.id,
                        batch_id=self.batch.id,
                    )

        unknown_result = {
            "schema_version": "workflow-role-result.v1",
            "role": "unknown",
            "task_id": self.workflow.id,
            "batch_id": self.batch.id,
            "status": "candidate",
            "products": [],
            "source_refs": {},
            "facts_changed": False,
        }
        json.dumps(unknown_result, allow_nan=False)
        with self.assertRaises(RoleResultContractError):
            validate_role_result(
                "unknown", unknown_result, task_id=self.workflow.id, batch_id=self.batch.id
            )

    def test_resume_reads_saved_steps_and_never_completes_without_real_artifacts(self):
        plan = self.engine.plan_task(self.workflow.id)
        self.assertEqual(len(plan["subtasks"]), 2)
        for subtask in SubTask.objects.filter(task=self.workflow, agent_role="product_profile"):
            self.engine.dispatch_subtask(subtask.id, "product-resume")
        self.workflow.refresh_from_db()
        self.assertEqual(self.workflow.result_refs["next_step"], "delivery_quality")
        self.assertEqual(self.workflow.status, "running")
        self.assertEqual(self.engine.resume_task(self.workflow.id)["status"], "running")
        self.workflow.refresh_from_db()
        self.assertEqual(self.workflow.result_refs["next_step"], "generate_deliverables")
        self.assertFalse(WorkflowStep.objects.filter(task=self.workflow, status="completed", output_refs__artifact_quality="passed").exists())
        with self.assertRaisesRegex(CompletionGateError, "未实现真实交付文件生成与文件 QA"):
            self.engine.complete_workflow(self.workflow.id)

    def test_plan_rejects_dangling_and_cyclic_dependencies(self):
        class InvalidPlanRuntime:
            def __init__(self, dependency):
                self.dependency = dependency

            def plan_task(self, task_id):
                return {
                    "subtasks": [
                        {"key": "product_profile", "agent_role": "product_profile", "depends_on": [self.dependency], "input_refs": {}},
                        {"key": "delivery_quality", "agent_role": "delivery_quality", "depends_on": ["product_profile" if self.dependency != "delivery_quality" else "product_profile"], "input_refs": {}},
                    ]
                }

        with self.assertRaises(ValueError):
            WorkflowOrchestrator(InvalidPlanRuntime("missing-role")).plan_task(self.workflow.id)

        self.workflow.status = "queued"
        self.workflow.save(update_fields=["status"])
        with self.assertRaises(ValueError):
            WorkflowOrchestrator(InvalidPlanRuntime("delivery_quality")).plan_task(self.workflow.id)

    def test_cross_workflow_dependency_is_rejected(self):
        other_workflow = WorkflowTask.objects.create(
            batch=self.batch,
            user_goal="另一个工作流",
            task_type="prepare_product_data",
        )
        foreign = SubTask.objects.create(task=other_workflow, agent_role="product_profile")
        local = SubTask.objects.create(task=self.workflow, agent_role="delivery_quality")
        local.depends_on.add(foreign)

        with self.assertRaises(DependencyNotReady):
            self.engine.dispatch_subtask(local.id, "cross-workflow")

    def test_completion_requires_all_subtasks_no_pending_review_and_phase3_file_qa(self):
        self.engine.plan_task(self.workflow.id)
        product_step = SubTask.objects.get(task=self.workflow, agent_role="product_profile")
        delivery_step = SubTask.objects.get(task=self.workflow, agent_role="delivery_quality")
        self.engine.dispatch_subtask(product_step.id, "complete-product")
        with self.assertRaises(CompletionGateError):
            self.engine.complete_workflow(self.workflow.id)
        self.engine.dispatch_subtask(delivery_step.id, "complete-delivery")
        HumanReview.objects.create(
            task=self.workflow,
            item_ref="TL-001",
            question="待确认事项",
            status="pending",
        )
        with self.assertRaises(CompletionGateError):
            self.engine.complete_workflow(self.workflow.id)
        HumanReview.objects.filter(task=self.workflow).update(status="approved")
        with self.assertRaisesRegex(CompletionGateError, "未实现真实交付文件生成与文件 QA"):
            self.engine.complete_workflow(self.workflow.id)

