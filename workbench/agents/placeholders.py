from __future__ import annotations

from typing import Any

from .context import WorkflowContext
from .workflow_contracts import RoleUnavailable


class _UnavailablePlaceholder:
    role_id = ""
    available = False
    code = 409
    allowed_tools = frozenset()

    def input_schema(self) -> dict[str, Any]:
        return {
            "type": "object",
            "required": ["workflow_task_id", "batch_id"],
            "properties": {
                "workflow_task_id": {"type": "string"},
                "batch_id": {"type": "string"},
            },
        }

    def output_schema(self) -> dict[str, Any]:
        return {
            "type": "object",
            "required": ["error", "code", "role_id", "message"],
            "properties": {
                "error": {"type": "string"},
                "code": {"type": "integer", "const": 409},
                "role_id": {"type": "string"},
                "message": {"type": "string"},
            },
        }

    def execute(
        self,
        _context: WorkflowContext,
        _input_refs: dict[str, Any] | None,
    ) -> dict[str, Any]:
        raise RoleUnavailable(
            f"角色 {self.role_id} 尚未接入，返回 409；未执行任何业务动作。",
            role_id=self.role_id,
        )


class MarketCustomerPlaceholder(_UnavailablePlaceholder):
    role_id = "market_customer"


class QuotationPlaceholder(_UnavailablePlaceholder):
    role_id = "quotation"
