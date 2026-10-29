from __future__ import annotations

from django.test import TestCase
from django.utils import timezone

from workbench.agents.context import RoleToolbox, WorkflowContext
from workbench.agents.mock_runtime import MockAgentRuntime
from workbench.agents.result_contracts import validate_role_result
from workbench.agents.workflow_contracts import (
    InputContractError,
    RolePermissionError,
    ToolInputContractError,
)
from workbench.models import (
    Customer,
    CustomerAction,
    CustomerAlias,
    CustomerEvent,
    CustomerMetricSnapshot,
    CustomerPrediction,
    SubTask,
    Task,
    WorkflowTask,
)


class MarketCustomerAgentTests(TestCase):
    def setUp(self) -> None:
        now = timezone.now()
        self.batch = Task.objects.create(
            title="客户只读角色批次",
            mode="demo",
            status="queued",
            created_at=now,
            updated_at=now,
        )
        self.workflow = WorkflowTask.objects.create(
            batch=self.batch,
            user_goal="读取指定客户资料",
            task_type="prepare_product_data",
            status="queued",
            current_step="plan",
        )
        self.customer = Customer.objects.create(display_name="客户甲")
        self.other_customer = Customer.objects.create(display_name="客户乙")

    def make_refs(self, customer_id: str | None = None) -> dict[str, str]:
        return {
            "workflow_task_id": self.workflow.id,
            "batch_id": self.batch.id,
            "customer_id": customer_id or self.customer.id,
        }

    def make_subtask(self, input_refs: dict) -> SubTask:
        return SubTask.objects.create(
            task=self.workflow,
            agent_role="market_customer",
            input_refs=input_refs,
            status="queued",
        )

    def fact_counts(self) -> tuple[int, int, int, int]:
        return (
            CustomerEvent.objects.count(),
            CustomerMetricSnapshot.objects.count(),
            CustomerPrediction.objects.count(),
            CustomerAction.objects.count(),
        )

    def test_runtime_reads_requested_customer_without_changing_facts(self) -> None:
        CustomerAlias.objects.create(
            customer=self.customer,
            raw_text="客户甲",
            normalized_text="customer-agent-primary",
            decision=CustomerAlias.Decision.CONFIRMED,
        )
        CustomerAlias.objects.create(
            customer=self.other_customer,
            raw_text="客户乙",
            normalized_text="customer-agent-other",
            decision=CustomerAlias.Decision.CONFIRMED,
        )
        subtask = self.make_subtask(self.make_refs())
        before = self.fact_counts()

        result = MockAgentRuntime().run_subtask(subtask.id)

        self.assertEqual(result["schema_version"], "workflow-role-result.v1")
        self.assertEqual(result["role"], "market_customer")
        self.assertEqual(result["task_id"], self.workflow.id)
        self.assertEqual(result["batch_id"], self.batch.id)
        self.assertEqual(result["status"], "candidate")
        self.assertEqual(result["customer"]["id"], self.customer.id)
        self.assertEqual(result["customer"]["display_name"], "客户甲")
        self.assertEqual(len(result["customer"]["aliases"]), 1)
        self.assertEqual(
            result["customer"]["aliases"][0]["customer_id"],
            self.customer.id,
        )
        self.assertEqual(result["events"], [])
        self.assertEqual(result["metrics"], [])
        self.assertEqual(result["predictions"], [])
        self.assertEqual(result["actions"], [])
        self.assertEqual(
            result["source_refs"],
            {
                "workflow_task_id": self.workflow.id,
                "batch_id": self.batch.id,
                "customer_id": self.customer.id,
            },
        )
        self.assertFalse(result["facts_changed"])
        self.assertEqual(self.fact_counts(), before)
        validate_role_result(
            "market_customer",
            result,
            task_id=self.workflow.id,
            batch_id=self.batch.id,
        )

    def test_missing_customer_id_is_rejected(self) -> None:
        refs = self.make_refs()
        refs.pop("customer_id")
        subtask = self.make_subtask(refs)

        with self.assertRaises(InputContractError) as caught:
            MockAgentRuntime().run_subtask(subtask.id)

        self.assertEqual(caught.exception.role_id, "market_customer")

    def test_unknown_customer_is_rejected(self) -> None:
        subtask = self.make_subtask(self.make_refs("unknown-customer"))

        with self.assertRaises(InputContractError):
            MockAgentRuntime().run_subtask(subtask.id)

    def test_customer_tools_cannot_overreach_role_permissions(self) -> None:
        context = WorkflowContext.from_workflow(self.workflow)
        customer_tools = RoleToolbox(context, "market_customer", self.make_refs())
        product_tools = RoleToolbox(context, "product_profile", {})

        with self.assertRaises(RolePermissionError):
            customer_tools.call("read_batch_products")
        with self.assertRaises(RolePermissionError):
            product_tools.call(
                "read_customer_profile",
                customer_id=self.customer.id,
            )

    def test_customer_tool_inputs_require_id_and_bounded_limit(self) -> None:
        toolbox = RoleToolbox(
            WorkflowContext.from_workflow(self.workflow),
            "market_customer",
            self.make_refs(),
        )
        limited_tools = (
            "read_customer_events",
            "read_customer_metrics",
            "read_customer_predictions",
            "read_customer_actions",
        )

        with self.assertRaises(ToolInputContractError):
            toolbox.call("read_customer_profile")
        for tool_name in limited_tools:
            for limit in (0, 101):
                with self.subTest(tool=tool_name, limit=limit):
                    with self.assertRaises(ToolInputContractError):
                        toolbox.call(
                            tool_name,
                            customer_id=self.customer.id,
                            limit=limit,
                        )
            self.assertEqual(
                toolbox.call(tool_name, customer_id=self.customer.id, limit=1),
                [],
            )
