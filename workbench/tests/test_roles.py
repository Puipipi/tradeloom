from __future__ import annotations

from copy import deepcopy
from unittest.mock import Mock, patch

from django.test import TestCase
from django.utils import timezone

from workbench.agents.context import TOOL_ALLOWLIST, RoleToolbox, WorkflowContext
from workbench.agents.mock_runtime import MockAgentRuntime
from workbench.agents.registry import (
    build_default_registry,
    build_workflow_role_registry,
)
from workbench.agents.workflow_contracts import (
    CrossBatchReferenceError,
    IncompleteBatchScopeError,
    InputContractError,
    RolePermissionError,
    RoleUnavailable,
    StaleRevisionReferenceError,
    UnknownTaskIntent,
    UnknownToolError,
    UnknownWorkflowRole,
    ToolInputContractError,
    ToolOutputContractError,
)
from workbench.agents.context import _TOOL_DEFINITIONS
from workbench.agents.tool_contracts import ToolDefinition
from workbench.models import (
    EventLog,
    Product,
    ProductRevision,
    SubTask,
    Task,
    TaskFile,
    WorkflowStep,
    WorkflowTask,
)


class WorkflowRoleTests(TestCase):
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
        missing_fields: list[str] | None = None,
        with_image: bool = False,
    ) -> Product:
        now = timezone.now()
        image_filename = f"{sku}.svg" if with_image else ""
        image_stored_name = f"stored-{sku}.svg" if with_image else ""
        return Product.objects.create(
            task=batch,
            position=position,
            sku=sku,
            name=f"产品 {sku}",
            category="丝带",
            material="涤纶",
            size="25mm",
            color="酒红",
            image_filename=image_filename,
            image_stored_name=image_stored_name,
            missing_fields=[] if missing_fields is None else missing_fields,
            created_at=now,
            updated_at=now,
        )

    def make_revision(
        self,
        product: Product,
        *,
        version: int = 1,
        status: str,
        english_name: str = "Ribbon",
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
                "english_name": english_name,
            },
            status=status,
        )

    def make_image_file(
        self,
        batch: Task,
        *,
        original_name: str,
        stored_name: str,
    ) -> TaskFile:
        return TaskFile.objects.create(
            task=batch,
            kind="image",
            original_name=original_name,
            stored_name=stored_name,
            created_at=timezone.now(),
        )

    def make_workflow(
        self,
        batch: Task,
        *,
        task_type: str = "prepare_product_data",
        user_goal: str = "生成英文目录并检查交付资料",
    ) -> WorkflowTask:
        return WorkflowTask.objects.create(
            batch=batch,
            user_goal=user_goal,
            task_type=task_type,
            status="queued",
            current_step="plan",
        )

    def make_subtask(
        self,
        workflow: WorkflowTask,
        *,
        role: str,
        input_refs: dict | None = None,
    ) -> SubTask:
        return SubTask.objects.create(
            task=workflow,
            agent_role=role,
            input_refs={} if input_refs is None else input_refs,
            status="queued",
        )

    def assert_no_persisted_execution(self, subtask: SubTask, workflow: WorkflowTask):
        subtask.refresh_from_db()
        workflow.refresh_from_db()
        self.assertEqual(subtask.status, "queued")
        self.assertEqual(subtask.output_refs, {})
        self.assertEqual(subtask.retry_count, 0)
        self.assertEqual(workflow.status, "queued")
        self.assertEqual(WorkflowStep.objects.count(), 0)
        self.assertEqual(EventLog.objects.count(), 0)

    def test_center_plan_classifies_supported_tasks_and_keeps_two_business_roles(self):
        batch = self.make_batch(title="中心规划批次")
        product = self.make_product(batch, sku="A-001", position=0, with_image=True)
        revision = self.make_revision(product, status="confirmed")
        prepare = self.make_workflow(batch)
        generate = self.make_workflow(
            batch,
            task_type="generate_deliverables",
            user_goal="生成英文目录和样品清单",
        )

        runtime = MockAgentRuntime()
        first_plan = runtime.plan_task(prepare.id)
        second_plan = runtime.plan_task(generate.id)

        self.assertEqual(first_plan["schema_version"], "agent-runtime-plan.v2")
        self.assertEqual(first_plan["classification"]["intent_key"], "prepare_product_data")
        self.assertEqual(
            second_plan["classification"]["intent_key"],
            "generate_deliverables",
        )
        self.assertEqual(
            first_plan["planning_step"],
            {
                "step_key": "center_plan",
                "kind": "workflow_step",
                "status": "planned",
                "subtask_created": False,
                "persistence_owner": "Task10",
            },
        )
        self.assertEqual(
            [item["key"] for item in first_plan["subtasks"]],
            ["product_profile", "delivery_quality"],
        )
        self.assertEqual(
            first_plan["subtasks"][1]["depends_on"],
            ["product_profile"],
        )
        self.assertTrue(first_plan["execution"]["run_subtask_ready"])
        self.assertTrue(first_plan["execution"]["dispatch_available"])
        self.assertFalse(first_plan["execution"]["subtasks_created"])
        self.assertEqual(
            first_plan["source_refs"]["product_revisions"][0]["revision_id"],
            revision.id,
        )
        self.assertEqual(SubTask.objects.count(), 0)
        self.assertEqual(WorkflowStep.objects.count(), 0)
        self.assertEqual(EventLog.objects.count(), 0)

    def test_center_rejects_unknown_type_and_out_of_scope_intent(self):
        batch = self.make_batch(title="不支持批次")
        unknown = self.make_workflow(
            batch,
            task_type="market_research",
            user_goal="做市场调研",
        )
        out_of_scope = self.make_workflow(
            batch,
            task_type="prepare_product_data",
            user_goal="给客户发送报价邮件并审批",
        )
        runtime = MockAgentRuntime()

        with self.assertRaises(UnknownTaskIntent) as unknown_context:
            runtime.plan_task(unknown.id)
        self.assertEqual(unknown_context.exception.code, 422)
        self.assertEqual(unknown_context.exception.task_type, "market_research")

        with self.assertRaises(UnknownTaskIntent) as scope_context:
            runtime.plan_task(out_of_scope.id)
        self.assertEqual(scope_context.exception.code, 422)
        self.assertIn("超出", str(scope_context.exception))
        self.assertEqual(SubTask.objects.count(), 0)
        self.assertEqual(WorkflowStep.objects.count(), 0)

    def test_product_agent_reads_images_and_keeps_products_without_revision(self):
        batch = self.make_batch(title="产品资料批次")
        other_batch = self.make_batch(title="其他批次")
        complete = self.make_product(
            batch,
            sku="A-001",
            position=0,
            with_image=True,
        )
        missing_revision = self.make_product(
            batch,
            sku="A-002",
            position=1,
            missing_fields=["材质"],
        )
        ambiguous = self.make_product(
            batch,
            sku="A-003",
            position=2,
            with_image=True,
        )
        other = self.make_product(other_batch, sku="B-001", position=0)
        self.make_revision(complete, status="confirmed")
        self.make_revision(ambiguous, status="confirmed")
        self.make_revision(other, status="confirmed")
        image_one = self.make_image_file(
            batch,
            original_name="A-001.svg",
            stored_name=complete.image_stored_name,
        )
        image_two = self.make_image_file(
            batch,
            original_name="A-003.svg",
            stored_name=ambiguous.image_stored_name,
        )
        image_three = self.make_image_file(
            batch,
            original_name="A-003.png",
            stored_name="stored-A-003.png",
        )
        workflow = self.make_workflow(batch)
        plan = MockAgentRuntime().plan_task(workflow.id)
        subtask = self.make_subtask(
            workflow,
            role="product_profile",
            input_refs=plan["subtasks"][0]["input_refs"],
        )

        result = MockAgentRuntime().run_subtask(subtask.id)

        self.assertEqual(result["schema_version"], "workflow-role-result.v1")
        self.assertEqual(result["role"], "product_profile")
        self.assertEqual(result["execution_mode"], "local_mock")
        self.assertEqual(result["planning_mode"], "simulated_rules")
        self.assertEqual(result["agentarts"], "not_configured")
        self.assertEqual(result["status"], "needs_human")
        self.assertFalse(result["facts_changed"])
        self.assertEqual(
            [item["product_id"] for item in result["products"]],
            [complete.id, missing_revision.id, ambiguous.id],
        )
        by_id = {item["product_id"]: item for item in result["products"]}
        self.assertEqual(by_id[complete.id]["current_revision"]["status"], "confirmed")
        self.assertEqual(
            [item["task_file_id"] for item in by_id[complete.id]["image_candidates"]],
            [image_one.id],
        )
        self.assertIsNone(by_id[missing_revision.id]["current_revision"])
        self.assertIn(
            "missing_current_revision",
            by_id[missing_revision.id]["uncertainties"],
        )
        self.assertIn("材质", by_id[missing_revision.id]["missing_fields"])
        self.assertEqual(
            {item["task_file_id"] for item in by_id[ambiguous.id]["image_candidates"]},
            {image_two.id, image_three.id},
        )
        self.assertIn(
            "ambiguous_image_candidate",
            by_id[ambiguous.id]["uncertainties"],
        )
        self.assertEqual(
            result["source_refs"]["product_ids"],
            [complete.id, missing_revision.id, ambiguous.id],
        )
        self.assertNotIn(other.id, by_id)
        self.assert_no_persisted_execution(subtask, workflow)

    def test_product_agent_requires_full_batch_and_typed_required_refs(self):
        batch = self.make_batch(title="全批契约批次")
        complete = self.make_product(batch, sku="A-001", position=0, with_image=True)
        missing = self.make_product(
            batch,
            sku="A-002",
            position=1,
            missing_fields=["材质"],
        )
        revision = self.make_revision(complete, status="confirmed")
        self.make_image_file(
            batch,
            original_name="A-001.svg",
            stored_name=complete.image_stored_name,
        )
        workflow = self.make_workflow(batch)
        plan = MockAgentRuntime().plan_task(workflow.id)
        full_refs = plan["subtasks"][0]["input_refs"]

        normal = self.make_subtask(
            workflow,
            role="product_profile",
            input_refs=full_refs,
        )
        normal_result = MockAgentRuntime().run_subtask(normal.id)
        self.assertEqual(
            [item["product_id"] for item in normal_result["products"]],
            [complete.id, missing.id],
        )
        self.assert_no_persisted_execution(normal, workflow)

        subset = self.make_subtask(
            workflow,
            role="product_profile",
            input_refs={
                **full_refs,
                "product_ids": [complete.id],
                "product_revision_ids": [revision.id],
            },
        )
        with self.assertRaises(IncompleteBatchScopeError):
            MockAgentRuntime().run_subtask(subset.id)
        self.assert_no_persisted_execution(subset, workflow)

        bad_cases = [
            {},
            {
                **full_refs,
                "product_ids": {"not": "a-list"},
            },
            {
                **full_refs,
                "product_ids": [complete.id, {"bad": "id"}],
            },
            {
                **full_refs,
                "scope": "selected_products",
            },
        ]
        for index, bad_refs in enumerate(bad_cases):
            bad = self.make_subtask(
                workflow,
                role="product_profile",
                input_refs=bad_refs,
            )
            with self.subTest(index=index):
                with self.assertRaises(InputContractError):
                    MockAgentRuntime().run_subtask(bad.id)
                self.assert_no_persisted_execution(bad, workflow)

    def test_delivery_agent_blocks_incomplete_batch_without_filtering(self):
        batch = self.make_batch(title="混合确认批次")
        confirmed_product = self.make_product(
            batch,
            sku="A-001",
            position=0,
            with_image=True,
        )
        unconfirmed_product = self.make_product(
            batch,
            sku="A-002",
            position=1,
            with_image=True,
        )
        confirmed_revision = self.make_revision(
            confirmed_product,
            status="confirmed",
        )
        unconfirmed_revision = self.make_revision(
            unconfirmed_product,
            status="needs_review",
        )
        self.make_image_file(
            batch,
            original_name="A-001.svg",
            stored_name=confirmed_product.image_stored_name,
        )
        self.make_image_file(
            batch,
            original_name="A-002.svg",
            stored_name=unconfirmed_product.image_stored_name,
        )
        workflow = self.make_workflow(batch)
        plan = MockAgentRuntime().plan_task(workflow.id)
        subtask = self.make_subtask(
            workflow,
            role="delivery_quality",
            input_refs=plan["subtasks"][1]["input_refs"],
        )

        result = MockAgentRuntime().run_subtask(subtask.id)

        self.assertEqual(result["role"], "delivery_quality")
        self.assertEqual(result["status"], "blocked")
        self.assertEqual(result["quality_scope"], "data_readiness")
        self.assertEqual(result["data_readiness"], "not_ready")
        self.assertFalse(result["artifacts_generated"])
        self.assertEqual(result["artifact_quality"], "not_evaluated")
        self.assertEqual(
            result["scope"]["all_product_ids"],
            [confirmed_product.id, unconfirmed_product.id],
        )
        self.assertEqual(
            result["scope"]["confirmed_revision_ids"],
            [confirmed_revision.id],
        )
        self.assertEqual(
            result["scope"]["unconfirmed_product_ids"],
            [unconfirmed_product.id],
        )
        self.assertIn(
            {
                "code": "confirmed_revision",
                "status": "blocked",
                "product_id": unconfirmed_product.id,
                "revision_status": "needs_review",
            },
            result["checks"],
        )
        self.assertEqual(result["generation_intent"], [])
        self.assert_no_persisted_execution(subtask, workflow)

        self.assertEqual(
            set(
                ProductRevision.objects.filter(
                    id__in=[confirmed_revision.id, unconfirmed_revision.id]
                ).values_list("status", flat=True)
            ),
            {"confirmed", "needs_review"},
        )

        filtered = self.make_subtask(
            workflow,
            role="delivery_quality",
            input_refs={
                **plan["subtasks"][1]["input_refs"],
                "all_product_ids": [confirmed_product.id],
                "confirmed_revision_ids": [confirmed_revision.id],
            },
        )
        with self.assertRaises(IncompleteBatchScopeError):
            MockAgentRuntime().run_subtask(filtered.id)
        self.assert_no_persisted_execution(filtered, workflow)

    def test_delivery_agent_ready_for_generation_without_claiming_file_quality(self):
        batch = self.make_batch(title="完整确认批次")
        product = self.make_product(
            batch,
            sku="A-001",
            position=0,
            with_image=True,
        )
        revision = self.make_revision(product, status="confirmed")
        self.make_image_file(
            batch,
            original_name="A-001.svg",
            stored_name=product.image_stored_name,
        )
        workflow = self.make_workflow(batch)
        plan = MockAgentRuntime().plan_task(workflow.id)
        subtask = self.make_subtask(
            workflow,
            role="delivery_quality",
            input_refs=plan["subtasks"][1]["input_refs"],
        )

        result = MockAgentRuntime().run_subtask(subtask.id)

        self.assertEqual(result["status"], "ready_for_generation")
        self.assertEqual(result["quality_scope"], "data_readiness")
        self.assertEqual(result["data_readiness"], "ready")
        self.assertFalse(result["artifacts_generated"])
        self.assertEqual(result["artifact_quality"], "not_evaluated")
        self.assertEqual(
            result["scope"]["confirmed_revision_ids"],
            [revision.id],
        )
        self.assertEqual(
            [item["artifact_type"] for item in result["generation_intent"]],
            ["english_catalog", "sample_checklist"],
        )
        self.assertTrue(
            all(item["artifacts_generated"] is False for item in result["generation_intent"])
        )
        self.assert_no_persisted_execution(subtask, workflow)

    def test_delivery_agent_requires_human_for_missing_english_name(self):
        batch = self.make_batch(title="缺英文名批次")
        product = self.make_product(
            batch,
            sku="A-001",
            position=0,
            with_image=True,
        )
        self.make_revision(product, status="confirmed", english_name="")
        self.make_image_file(
            batch,
            original_name="A-001.svg",
            stored_name=product.image_stored_name,
        )
        workflow = self.make_workflow(batch)
        plan = MockAgentRuntime().plan_task(workflow.id)
        subtask = self.make_subtask(
            workflow,
            role="delivery_quality",
            input_refs=plan["subtasks"][1]["input_refs"],
        )

        result = MockAgentRuntime().run_subtask(subtask.id)

        self.assertEqual(result["status"], "needs_human")
        self.assertEqual(result["data_readiness"], "not_ready")
        self.assertEqual(result["generation_intent"], [])
        self.assertIn(
            {
                "code": "english_name",
                "status": "needs_human",
                "product_id": product.id,
            },
            result["checks"],
        )
        self.assert_no_persisted_execution(subtask, workflow)

    def test_cross_batch_and_stale_revision_refs_are_rejected_without_writes(self):
        batch = self.make_batch(title="批次 A")
        other_batch = self.make_batch(title="批次 B")
        product = self.make_product(batch, sku="A-001", position=0, with_image=True)
        other_product = self.make_product(other_batch, sku="B-001", position=0)
        old_revision = self.make_revision(product, version=1, status="confirmed")
        self.make_revision(product, version=2, status="confirmed")
        other_revision = self.make_revision(other_product, version=1, status="confirmed")
        workflow = self.make_workflow(batch)

        cross_batch = self.make_subtask(
            workflow,
            role="product_profile",
            input_refs={
                "workflow_task_id": workflow.id,
                "batch_id": other_batch.id,
                "scope": "full_batch",
                "product_ids": [product.id],
            },
        )
        with self.assertRaises(CrossBatchReferenceError):
            MockAgentRuntime().run_subtask(cross_batch.id)
        self.assert_no_persisted_execution(cross_batch, workflow)

        cross_revision = self.make_subtask(
            workflow,
            role="product_profile",
            input_refs={
                "workflow_task_id": workflow.id,
                "batch_id": batch.id,
                "scope": "full_batch",
                "product_ids": [product.id],
                "product_revision_ids": [other_revision.id],
            },
        )
        with self.assertRaises(CrossBatchReferenceError):
            MockAgentRuntime().run_subtask(cross_revision.id)
        self.assert_no_persisted_execution(cross_revision, workflow)

        stale = self.make_subtask(
            workflow,
            role="product_profile",
            input_refs={
                "workflow_task_id": workflow.id,
                "batch_id": batch.id,
                "scope": "full_batch",
                "product_ids": [product.id],
                "product_revision_ids": [old_revision.id],
            },
        )
        with self.assertRaises(StaleRevisionReferenceError):
            MockAgentRuntime().run_subtask(stale.id)
        self.assert_no_persisted_execution(stale, workflow)

    def test_role_tool_allowlist_rejects_overreach_and_unknown_tools(self):
        batch = self.make_batch(title="权限批次")
        product = self.make_product(batch, sku="A-001", position=0, with_image=True)
        self.make_revision(product, status="confirmed")
        workflow = self.make_workflow(batch)
        context = WorkflowContext.from_workflow(workflow)

        product_tools = RoleToolbox(context, "product_profile", {})
        with self.assertRaises(RolePermissionError):
            product_tools.call("read_confirmed_revisions", unexpected=object())
        with self.assertRaises(UnknownToolError):
            product_tools.call("send_message", unexpected=object())
        with self.assertRaises(UnknownToolError):
            product_tools.call("approve_product")

        delivery_tools = RoleToolbox(context, "delivery_quality", {})
        with self.assertRaises(RolePermissionError):
            delivery_tools.call("match_image_candidates")
        with self.assertRaises(UnknownToolError):
            delivery_tools.call("confirm_fact")

    def test_tool_call_rejects_kwargs_outside_registered_input_contract(self):
        batch = self.make_batch(title="工具输入契约")
        workflow = self.make_workflow(batch)
        toolbox = RoleToolbox(WorkflowContext.from_workflow(workflow), "center", {})
        definition = _TOOL_DEFINITIONS["read_workflow_task"]
        handler = Mock(return_value={})
        with patch.dict(
            "workbench.agents.context._TOOL_DEFINITIONS",
            {
                "read_workflow_task": ToolDefinition(
                    definition.description,
                    definition.input_schema,
                    definition.output_schema,
                    handler,
                )
            },
        ):
            with self.assertRaises(ToolInputContractError):
                toolbox.call("read_workflow_task", unexpected="ignored")
        handler.assert_not_called()

    def test_toolbox_constructor_preserves_role_and_source_validation_order(self):
        batch = self.make_batch(title="工具来源校验")
        foreign_batch = self.make_batch(title="外部批次")
        foreign_product = self.make_product(foreign_batch, sku="FOREIGN", position=0)
        workflow = self.make_workflow(batch)
        context = WorkflowContext.from_workflow(workflow)

        with self.assertRaises(UnknownWorkflowRole):
            RoleToolbox(context, "unknown", {"product_ids": [foreign_product.id]})
        with self.assertRaises(CrossBatchReferenceError):
            RoleToolbox(
                context,
                "product_profile",
                {"product_ids": [foreign_product.id]},
            )

    def test_tool_input_schema_rejects_bad_product_ids_before_handler(self):
        batch = self.make_batch(title="工具产品范围")
        workflow = self.make_workflow(batch)
        toolbox = RoleToolbox(WorkflowContext.from_workflow(workflow), "product_profile", {})
        definition = _TOOL_DEFINITIONS["match_image_candidates"]
        handler = Mock(return_value={})
        replacement = ToolDefinition(
            definition.description,
            definition.input_schema,
            definition.output_schema,
            handler,
        )
        with patch.dict(
            "workbench.agents.context._TOOL_DEFINITIONS",
            {"match_image_candidates": replacement},
        ):
            for value in ("p-1", 7, ["p-1", 3], [" "]):
                with self.subTest(product_ids=value):
                    with self.assertRaises(ToolInputContractError):
                        toolbox.call("match_image_candidates", product_ids=value)
        handler.assert_not_called()

    def test_optional_product_ids_keep_none_omitted_and_empty_list_semantics(self):
        batch = self.make_batch(title="可选工具参数")
        product = self.make_product(batch, sku="A-optional", position=0, with_image=True)
        self.make_image_file(batch, original_name="A-optional.svg", stored_name="stored-A-optional.svg")
        workflow = self.make_workflow(batch)
        toolbox = RoleToolbox(WorkflowContext.from_workflow(workflow), "product_profile", {})

        self.assertIn(product.id, toolbox.call("match_image_candidates"))
        self.assertIn(product.id, toolbox.call("match_image_candidates", product_ids=None))
        self.assertEqual(toolbox.call("match_image_candidates", product_ids=[]), {})
        self.assertIn(product.id, toolbox.call("validate_product_data"))
        self.assertIn(product.id, toolbox.call("validate_product_data", product_ids=None))
        self.assertEqual(toolbox.call("validate_product_data", product_ids=[]), {})

    def test_tool_output_contract_rejects_bad_shape_missing_id_and_non_json_values(self):
        batch = self.make_batch(title="工具输出契约")
        workflow = self.make_workflow(batch)
        toolbox = RoleToolbox(WorkflowContext.from_workflow(workflow), "center", {})
        original = _TOOL_DEFINITIONS["read_workflow_task"]
        valid_dto = original.handler(toolbox.context)
        missing_id = deepcopy(valid_dto)
        missing_id.pop("id")
        nan_extension = deepcopy(valid_dto)
        nan_extension["extension"] = float("nan")
        non_json_extension = deepcopy(valid_dto)
        non_json_extension["extension"] = object()
        invalid_outputs = ([], missing_id, nan_extension, non_json_extension)

        for result in invalid_outputs:
            with self.subTest(result=result):
                handler = Mock(return_value=result)
                replacement = ToolDefinition(
                    original.description,
                    original.input_schema,
                    original.output_schema,
                    handler,
                )
                with patch.dict(
                    "workbench.agents.context._TOOL_DEFINITIONS",
                    {"read_workflow_task": replacement},
                ):
                    with self.assertRaises(ToolOutputContractError) as caught:
                        toolbox.call("read_workflow_task")
                self.assertEqual(caught.exception.code, 500)
                self.assertNotIn(str(result), str(caught.exception))
                handler.assert_called_once_with(toolbox.context)

        valid_extension = {
            **original.handler(toolbox.context),
            "extension": {"producer": "future"},
        }
        replacement = ToolDefinition(
            original.description,
            original.input_schema,
            original.output_schema,
            Mock(return_value=valid_extension),
        )
        with patch.dict(
            "workbench.agents.context._TOOL_DEFINITIONS",
            {"read_workflow_task": replacement},
        ):
            self.assertEqual(toolbox.call("read_workflow_task"), valid_extension)

    def test_all_registered_tools_validate_real_handler_outputs(self):
        batch = self.make_batch(title="工具真实返回")
        product = self.make_product(batch, sku="A-real", position=0, with_image=True)
        self.make_revision(product, status="confirmed")
        self.make_image_file(batch, original_name="A-real.svg", stored_name="stored-A-real.svg")
        workflow = self.make_workflow(batch)
        context = WorkflowContext.from_workflow(workflow)
        toolboxes = {
            "center": RoleToolbox(context, "center", {}),
            "product_profile": RoleToolbox(context, "product_profile", {}),
            "delivery_quality": RoleToolbox(context, "delivery_quality", {}),
        }
        role_by_tool = {
            "read_workflow_task": "center",
            "read_batch_products": "center",
            "read_current_revisions": "center",
            "read_confirmed_revisions": "delivery_quality",
            "read_task_files": "product_profile",
            "match_image_candidates": "product_profile",
            "validate_product_data": "product_profile",
            "check_data_readiness": "delivery_quality",
            "compose_generation_intent": "delivery_quality",
        }

        for tool_name, role_id in role_by_tool.items():
            with self.subTest(tool=tool_name):
                toolboxes[role_id].call(tool_name)

    def test_describe_tools_is_allowlisted_and_returns_independent_json_copies(self):
        batch = self.make_batch(title="工具元数据")
        workflow = self.make_workflow(batch)
        toolbox = RoleToolbox(WorkflowContext.from_workflow(workflow), "center", {})
        first = toolbox.describe_tools()
        self.assertEqual(
            {tool["name"] for tool in first},
            set(TOOL_ALLOWLIST["center"]),
        )
        self.assertTrue(all(set(tool) == {"name", "description", "input_schema", "output_schema"} for tool in first))
        first[0]["input_schema"]["type"] = "changed"
        second = toolbox.describe_tools()
        self.assertNotEqual(second[0]["input_schema"]["type"], "changed")
        self.assertTrue(
            toolbox.call("read_workflow_task")["id"] == workflow.id
        )

    def test_unknown_role_center_subtask_and_quotation_placeholder_are_explicit(self):
        batch = self.make_batch(title="角色边界批次")
        workflow = self.make_workflow(batch)
        runtime = MockAgentRuntime()
        unknown = self.make_subtask(workflow, role="mystery_role")
        center_subtask = self.make_subtask(workflow, role="center")
        quotation = self.make_subtask(workflow, role="quotation")

        with patch.object(WorkflowContext, "from_workflow", side_effect=AssertionError):
            with self.assertRaises(UnknownWorkflowRole) as unknown_context:
                runtime.run_subtask(unknown.id)
            with self.assertRaises(InputContractError) as center_context:
                runtime.run_subtask(center_subtask.id)
        self.assertEqual(unknown_context.exception.code, 404)
        self.assertEqual(center_context.exception.role_id, "center")

        with self.assertRaises(RoleUnavailable) as quotation_context:
            runtime.run_subtask(quotation.id)
        self.assertEqual(quotation_context.exception.code, 409)
        self.assertEqual(quotation_context.exception.role_id, "quotation")
        self.assert_no_persisted_execution(unknown, workflow)
        self.assert_no_persisted_execution(center_subtask, workflow)
        self.assert_no_persisted_execution(quotation, workflow)

    def test_role_registry_schemas_and_legacy_capabilities_stay_separate(self):
        role_registry = build_workflow_role_registry()
        self.assertEqual(
            role_registry.role_ids(),
            [
                "center",
                "product_profile",
                "delivery_quality",
                "market_customer",
                "quotation",
            ],
        )
        for role_id in role_registry.role_ids():
            role = role_registry.get(role_id)
            self.assertEqual(role.input_schema()["type"], "object")
            self.assertEqual(role.output_schema()["type"], "object")
            self.assertIsInstance(role.allowed_tools, frozenset)
        self.assertEqual(
            role_registry.get("product_profile").allowed_tools,
            TOOL_ALLOWLIST["product_profile"],
        )
        self.assertEqual(
            role_registry.get("delivery_quality").allowed_tools,
            TOOL_ALLOWLIST["delivery_quality"],
        )

        legacy = build_default_registry()
        self.assertEqual(
            [item.id for item in legacy.capabilities()],
            ["product_profile", "quotation", "catalog_package"],
        )
