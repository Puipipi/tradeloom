from __future__ import annotations

from typing import Any

from .context import RoleToolbox, WorkflowContext
from .workflow_contracts import require_input_fields


class MarketCustomerAgent:
    role_id = "market_customer"
    available = True
    facts_changed = False
    allowed_tools = frozenset(
        {
            "read_customer_profile",
            "read_customer_events",
            "read_customer_metrics",
            "read_customer_predictions",
            "read_customer_actions",
        }
    )

    def input_schema(self) -> dict[str, Any]:
        nonblank_id = {"type": "string", "minLength": 1, "pattern": r".*\S.*"}
        return {
            "type": "object",
            "required": ["workflow_task_id", "batch_id", "customer_id"],
            "properties": {
                "workflow_task_id": nonblank_id,
                "batch_id": nonblank_id,
                "customer_id": nonblank_id,
            },
            "additionalProperties": False,
        }

    def output_schema(self) -> dict[str, Any]:
        return {
            "type": "object",
            "required": [
                "schema_version",
                "role",
                "task_id",
                "batch_id",
                "status",
                "customer",
                "events",
                "metrics",
                "predictions",
                "actions",
                "source_refs",
                "facts_changed",
            ],
            "properties": {
                "schema_version": {
                    "type": "string",
                    "const": "workflow-role-result.v1",
                },
                "role": {"type": "string", "const": self.role_id},
                "task_id": {"type": "string", "minLength": 1},
                "batch_id": {"type": "string", "minLength": 1},
                "status": {"type": "string", "const": "candidate"},
                "customer": {"type": "object"},
                "events": {"type": "array"},
                "metrics": {"type": "array"},
                "predictions": {"type": "array"},
                "actions": {"type": "array"},
                "source_refs": {
                    "type": "object",
                    "required": ["workflow_task_id", "batch_id", "customer_id"],
                    "properties": {
                        "workflow_task_id": {"type": "string", "minLength": 1},
                        "batch_id": {"type": "string", "minLength": 1},
                        "customer_id": {"type": "string", "minLength": 1},
                    },
                },
                "facts_changed": {"type": "boolean", "const": False},
            },
        }

    def execute(
        self,
        context: WorkflowContext,
        input_refs: dict[str, Any] | None,
    ) -> dict[str, Any]:
        refs = require_input_fields(
            input_refs,
            {
                "workflow_task_id": str,
                "batch_id": str,
                "customer_id": str,
            },
        )
        customer_id = refs["customer_id"]
        toolbox = RoleToolbox(context, self.role_id, refs)
        customer = toolbox.call("read_customer_profile", customer_id=customer_id)
        events = toolbox.call("read_customer_events", customer_id=customer_id)
        metrics = toolbox.call("read_customer_metrics", customer_id=customer_id)
        predictions = toolbox.call(
            "read_customer_predictions",
            customer_id=customer_id,
        )
        actions = toolbox.call("read_customer_actions", customer_id=customer_id)

        return {
            "schema_version": "workflow-role-result.v1",
            "role": self.role_id,
            "task_id": context.workflow.id,
            "batch_id": context.batch.id,
            "status": "candidate",
            "customer": customer,
            "events": events,
            "metrics": metrics,
            "predictions": predictions,
            "actions": actions,
            "source_refs": {
                "workflow_task_id": context.workflow.id,
                "batch_id": context.batch.id,
                "customer_id": customer_id,
            },
            "facts_changed": False,
        }
