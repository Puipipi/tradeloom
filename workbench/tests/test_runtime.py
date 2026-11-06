from __future__ import annotations

import json
from copy import deepcopy
from unittest.mock import patch

from django.test import TestCase
from django.utils import timezone

from workbench.agents.mock_runtime import MockAgentRuntime
from workbench.agents.registry import build_workflow_role_registry
from workbench.agents.runtime import (
    AgentRuntime,
    UnknownSubTaskError,
    UnknownWorkflowTaskError,
)
from workbench.agents.workflow_contracts import InputContractError
from workbench.models import (
    EventLog,
    Product,
    ProductRevision,
    SubTask,
    Task,
    WorkflowStep,
    WorkflowTask,
)


class RuntimeTests(TestCase):
    def make_batch(self, *, title: str, status: str = "awaiting_confirmation") -> Task:
        now = timezone.now()
        return Task.objects.create(
            title=title,
            mode="demo",
            status=status,
            created_at=now,
            updated_at=now,
        )

    def make_product(
        self,
        batch: Task,
        *,
        sku: str,
        position: int,
    ) -> Product:
        now = timezone.now()
        return Product.objects.create(
            task=batch,
            position=position,
            sku=sku,
            name=f"产品 {sku}",
            category="丝带",
            material="涤纶",
            size="25mm",
            color="酒红",
            image_filename=f"{sku}.svg",
            image_stored_name=f"stored-{sku}.svg",
            missing_fields=[],
            created_at=now,
            updated_at=now,
        )

    def make_revision(
        self,
        product: Product,
        *,
        version: int,
        status: str,
    ) -> ProductRevision:
        return ProductRevision.objects.create(
            product=product,
            version=version,
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
            status=status,
        )

    def make_workflow(self, batch: Task) -> WorkflowTask:
        return WorkflowTask.objects.create(
            batch=batch,
            user_goal="生成英文目录并检查交付资料",
            task_type="prepare_product_data",
            status="queued",
            current_step="plan",
        )

    def test_plan_uses_current_orm_revisions_and_isolates_batch(self):
        batch_a = self.make_batch(title="批次 A")
        batch_b = self.make_batch(title="批次 B")
        product_a1 = self.make_product(batch_a, sku="A-001", position=0)
        product_a2 = self.make_product(batch_a, sku="A-002", position=1)
        product_b = self.make_product(batch_b, sku="B-001", position=0)
        self.make_revision(product_a1, version=1, status="draft")
        revision_a1 = self.make_revision(product_a1, version=2, status="confirmed")
        revision_a2 = self.make_revision(product_a2, version=1, status="needs_review")
        revision_b = self.make_revision(product_b, version=1, status="confirmed")
        workflow = self.make_workflow(batch_a)
        self.make_workflow(batch_b)

        runtime: AgentRuntime = MockAgentRuntime()
        plan = runtime.plan_task(workflow.id)

        self.assertEqual(plan["execution_mode"], "local_mock")
        self.assertEqual(plan["planning_mode"], "simulated_rules")
        self.assertEqual(plan["agentarts"], "not_configured")
        self.assertIn("模拟规划", plan["notice"])
        self.assertEqual(plan["schema_version"], "agent-runtime-plan.v2")
        self.assertEqual(
            plan["classification"]["intent_key"],
            "prepare_product_data",
        )
        self.assertEqual(plan["planning_step"]["kind"], "workflow_step")
        self.assertFalse(plan["planning_step"]["subtask_created"])
        self.assertEqual(plan["task"]["id"], workflow.id)
        self.assertEqual(plan["task"]["batch_id"], batch_a.id)
        self.assertEqual(
            plan["source_summary"],
            {
                "product_count": 2,
                "current_revision_count": 2,
                "confirmed_current_revision_count": 1,
                "products_without_current_revision": 0,
            },
        )
        self.assertEqual(
            plan["source_refs"]["product_revisions"],
            [
                {
                    "product_id": product_a1.id,
                    "sku": product_a1.sku,
                    "position": 0,
                    "revision_id": revision_a1.id,
                    "revision_version": 2,
                    "revision_status": "confirmed",
                },
                {
                    "product_id": product_a2.id,
                    "sku": product_a2.sku,
                    "position": 1,
                    "revision_id": revision_a2.id,
                    "revision_version": 1,
                    "revision_status": "needs_review",
                },
            ],
        )
        self.assertNotIn(
            product_b.id,
            [ref["product_id"] for ref in plan["source_refs"]["product_revisions"]],
        )
        self.assertNotIn(
            revision_b.id,
            [ref["revision_id"] for ref in plan["source_refs"]["product_revisions"]],
        )
        self.assertTrue(plan["plan_only"])
        self.assertFalse(plan["execution"]["subtasks_created"])
        self.assertTrue(plan["execution"]["dispatch_available"])
        self.assertTrue(plan["execution"]["run_subtask_ready"])
        json.dumps(plan, ensure_ascii=False)
        self.assertEqual(SubTask.objects.count(), 0)
        self.assertEqual(WorkflowStep.objects.count(), 0)

    def test_plan_has_ordered_roles_dependencies_and_consumable_schemas(self):
        batch = self.make_batch(title="批次")
        product = self.make_product(batch, sku="A-001", position=0)
        confirmed = self.make_revision(product, version=1, status="confirmed")
        workflow = self.make_workflow(batch)

        plan = MockAgentRuntime().plan_task(workflow.id)
        subtasks = plan["subtasks"]

        self.assertEqual(
            [item["key"] for item in subtasks],
            ["product_profile", "delivery_quality"],
        )
        self.assertEqual([item["order"] for item in subtasks], [1, 2])
        self.assertEqual(subtasks[0]["depends_on"], [])
        self.assertEqual(subtasks[1]["depends_on"], ["product_profile"])
        self.assertEqual(
            subtasks[0]["required_fields"],
            [
                "workflow_task_id",
                "batch_id",
                "scope=full_batch",
                "product_ids",
            ],
        )
        self.assertEqual(
            subtasks[1]["required_fields"],
            [
                "workflow_task_id",
                "batch_id",
                "scope=full_batch",
                "all_product_ids",
                "confirmed_revision_ids",
                "unconfirmed_product_ids",
                "requires_all_products_confirmed=True",
            ],
        )
        registry = build_workflow_role_registry()
        for index, role_id in enumerate(("product_profile", "delivery_quality")):
            role = registry.get(role_id)
            self.assertEqual(subtasks[index]["input_schema"], role.input_schema())
            self.assertEqual(subtasks[index]["output_schema"], role.output_schema())
        self.assertEqual(
            subtasks[0]["input_refs"]["product_revision_ids"],
            [confirmed.id],
        )
        self.assertEqual(
            subtasks[1]["input_refs"]["confirmed_revision_ids"],
            [confirmed.id],
        )
        self.assertEqual(
            subtasks[1]["input_refs"],
            {
                "upstream": ["product_profile"],
                "workflow_task_id": workflow.id,
                "batch_id": batch.id,
                "scope": "full_batch",
                "all_product_ids": [product.id],
                "all_revision_ids": [confirmed.id],
                "confirmed_revision_ids": [confirmed.id],
                "unconfirmed_product_ids": [],
                "requires_all_products_confirmed": True,
                "all_products_confirmed": True,
            },
        )
        json.dumps(plan, ensure_ascii=False)

    def test_delivery_plan_keeps_full_batch_scope_for_unconfirmed_products(self):
        batch = self.make_batch(title="混合确认批次")
        confirmed_product = self.make_product(batch, sku="A-001", position=0)
        unconfirmed_product = self.make_product(batch, sku="A-002", position=1)
        confirmed = self.make_revision(
            confirmed_product,
            version=1,
            status="confirmed",
        )
        unconfirmed = self.make_revision(
            unconfirmed_product,
            version=1,
            status="needs_review",
        )
        workflow = self.make_workflow(batch)

        plan = MockAgentRuntime().plan_task(workflow.id)
        delivery_refs = plan["subtasks"][1]["input_refs"]

        self.assertEqual(delivery_refs["scope"], "full_batch")
        self.assertEqual(
            delivery_refs["all_product_ids"],
            [confirmed_product.id, unconfirmed_product.id],
        )
        self.assertEqual(
            delivery_refs["all_revision_ids"],
            [confirmed.id, unconfirmed.id],
        )
        self.assertEqual(delivery_refs["confirmed_revision_ids"], [confirmed.id])
        self.assertEqual(
            delivery_refs["unconfirmed_product_ids"],
            [unconfirmed_product.id],
        )
        self.assertTrue(delivery_refs["requires_all_products_confirmed"])
        self.assertFalse(delivery_refs["all_products_confirmed"])

    def test_unknown_task_and_subtask_raise_typed_errors(self):
        runtime = MockAgentRuntime()

        with self.assertRaises(UnknownWorkflowTaskError) as task_context:
            runtime.plan_task("missing-task")
        self.assertEqual(task_context.exception.task_id, "missing-task")

        with self.assertRaises(UnknownWorkflowTaskError) as resume_context:
            runtime.resume_task("missing-task")
        self.assertEqual(resume_context.exception.task_id, "missing-task")

        with self.assertRaises(UnknownSubTaskError) as subtask_context:
            runtime.run_subtask("missing-subtask")
        self.assertEqual(subtask_context.exception.subtask_id, "missing-subtask")
        self.assertEqual(EventLog.objects.count(), 0)

    def test_run_subtask_dispatches_real_role_without_persisting_completion(self):
        batch = self.make_batch(title="批次")
        product = self.make_product(batch, sku="A-001", position=0)
        workflow = self.make_workflow(batch)
        plan = MockAgentRuntime().plan_task(workflow.id)
        refs = deepcopy(plan["subtasks"][0]["input_refs"])
        refs["product_revision_ids"] = None
        refs["future_extension"] = {"producer": "phase4"}
        subtask = SubTask.objects.create(
            task=workflow,
            agent_role="product_profile",
            input_refs=refs,
            status="queued",
        )

        result = MockAgentRuntime().run_subtask(subtask.id)

        self.assertEqual(result["role"], "product_profile")
        self.assertEqual(result["status"], "needs_human")
        self.assertEqual(result["products"][0]["product_id"], product.id)
        self.assertEqual(result["execution_mode"], "local_mock")
        self.assertEqual(result["planning_mode"], "simulated_rules")
        self.assertEqual(result["agentarts"], "not_configured")
        subtask.refresh_from_db()
        workflow.refresh_from_db()
        self.assertEqual(subtask.status, "queued")
        self.assertEqual(subtask.output_refs, {})
        self.assertEqual(subtask.retry_count, 0)
        self.assertEqual(workflow.status, "queued")
        self.assertEqual(WorkflowStep.objects.count(), 0)
        self.assertEqual(EventLog.objects.count(), 0)

    def test_run_subtask_rejects_role_input_schema_before_execute(self):
        batch = self.make_batch(title="批次")
        self.make_product(batch, sku="A-001", position=0)
        workflow = self.make_workflow(batch)
        plan = MockAgentRuntime().plan_task(workflow.id)
        invalid_inputs = [
            ("required", lambda refs: refs.pop("product_ids")),
            ("array_item", lambda refs: refs.update(product_ids=["  "])),
            ("const", lambda refs: refs.update(scope="selected_products")),
        ]
        for index, (failure, mutate) in enumerate(invalid_inputs):
            with self.subTest(failure=failure):
                refs = deepcopy(plan["subtasks"][0]["input_refs"])
                mutate(refs)
                subtask = SubTask.objects.create(
                    task=workflow,
                    agent_role="product_profile",
                    input_refs=refs,
                    status="queued",
                )
                with patch(
                    "workbench.agents.product_agent.ProductAgent.execute",
                    return_value={"role": "product_profile"},
                ) as execute:
                    with self.assertRaises(InputContractError) as error:
                        MockAgentRuntime().run_subtask(subtask.id)

                self.assertEqual(error.exception.role_id, "product_profile")
                self.assertEqual(str(error.exception), "角色输入不符合已声明契约")
                self.assertNotIn("  ", str(error.exception))
                execute.assert_not_called()

    def test_delivery_role_input_schema_rejects_bad_array_item_before_execute(self):
        batch = self.make_batch(title="空批次")
        workflow = self.make_workflow(batch)
        plan = MockAgentRuntime().plan_task(workflow.id)
        refs = deepcopy(plan["subtasks"][1]["input_refs"])
        refs["all_product_ids"] = ["  "]
        subtask = SubTask.objects.create(
            task=workflow,
            agent_role="delivery_quality",
            input_refs=refs,
            status="queued",
        )

        with patch(
            "workbench.agents.delivery_agent.DeliveryQualityAgent.execute",
            return_value={"role": "delivery_quality"},
        ) as execute:
            with self.assertRaises(InputContractError) as error:
                MockAgentRuntime().run_subtask(subtask.id)

        self.assertEqual(error.exception.role_id, "delivery_quality")
        self.assertEqual(str(error.exception), "角色输入不符合已声明契约")
        execute.assert_not_called()

    def test_delivery_role_accepts_null_optional_all_revision_ids(self):
        batch = self.make_batch(title="空批次")
        workflow = self.make_workflow(batch)
        plan = MockAgentRuntime().plan_task(workflow.id)
        refs = deepcopy(plan["subtasks"][1]["input_refs"])
        refs["all_revision_ids"] = None
        subtask = SubTask.objects.create(
            task=workflow,
            agent_role="delivery_quality",
            input_refs=refs,
            status="queued",
        )

        result = MockAgentRuntime().run_subtask(subtask.id)

        self.assertEqual(result["role"], "delivery_quality")
        self.assertEqual(result["quality_scope"], "data_readiness")

    def test_resume_task_plans_then_runs_saved_first_subtask(self):
        batch = self.make_batch(title="批次")
        workflow = self.make_workflow(batch)

        result = MockAgentRuntime().resume_task(workflow.id)

        workflow.refresh_from_db()
        self.assertEqual(result["task_id"], workflow.id)
        self.assertEqual(result["subtask_status"], "completed")
        self.assertEqual(workflow.status, "running")
        self.assertEqual(workflow.current_step, "delivery_quality")
        self.assertEqual(WorkflowStep.objects.filter(task=workflow).count(), 2)
        self.assertGreater(EventLog.objects.filter(task=workflow).count(), 0)

    def test_health_reports_only_implemented_capabilities(self):
        health = MockAgentRuntime().health_check()

        self.assertEqual(health["status"], "partial")
        self.assertEqual(health["execution_mode"], "local_mock")
        self.assertEqual(health["planning_mode"], "simulated_rules")
        self.assertEqual(health["agentarts"], "not_configured")
        self.assertIn("模拟规划", health["notice"])
        self.assertEqual(
            health["implemented_capabilities"],
            ["plan_task", "run_subtask", "resume_task", "health_check"],
        )
        self.assertEqual(
            health["not_ready_capabilities"],
            [],
        )
        self.assertTrue(health["capabilities"]["plan_task"]["available"])
        self.assertTrue(health["capabilities"]["health_check"]["available"])
        self.assertTrue(health["capabilities"]["run_subtask"]["available"])
        self.assertTrue(health["capabilities"]["resume_task"]["available"])
        self.assertTrue(health["capabilities"]["safe_retry"]["available"])
        self.assertEqual(
            health["capabilities"]["safe_retry"]["mode"], "local_read_only_roles"
        )
        self.assertTrue(health["task9_bound"])
        self.assertTrue(health["task10_bound"])
        self.assertTrue(health["roles"]["product_profile"]["available"])
        self.assertTrue(health["roles"]["delivery_quality"]["available"])
        self.assertTrue(health["roles"]["market_customer"]["available"])
        self.assertNotIn("code", health["roles"]["market_customer"])
        self.assertEqual(health["roles"]["quotation"]["code"], 409)
        json.dumps(health, ensure_ascii=False)
