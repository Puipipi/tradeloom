from __future__ import annotations

from typing import Any


SIMULATED_MARKERS = {
    "execution_mode": "local_mock",
    "planning_mode": "simulated_rules",
    "agentarts": "not_configured",
    "notice": (
        "模拟规划与本地确定性角色执行：仅按当前数据库记录和固定规则处理，"
        "不代表 LLM 理解、业务完成或文件质检通过。"
    ),
}

SUPPORTED_TASK_TYPES = frozenset(
    {
        "prepare_product_data",
        "generate_deliverables",
    }
)

OUT_OF_SCOPE_TERMS = (
    "报价",
    "营销",
    "客户开发",
    "发邮件",
    "发送邮件",
    "审批",
)


class WorkflowRoleError(Exception):
    code = 400

    def __init__(
        self,
        message: str,
        *,
        role_id: str | None = None,
        task_type: str | None = None,
        tool_name: str | None = None,
        details: dict[str, Any] | None = None,
    ) -> None:
        self.role_id = role_id
        self.task_type = task_type
        self.tool_name = tool_name
        self.details = details or {}
        super().__init__(message)

    def as_dict(self) -> dict[str, Any]:
        payload: dict[str, Any] = {
            "error": type(self).__name__,
            "code": self.code,
            "message": str(self),
        }
        if self.role_id is not None:
            payload["role_id"] = self.role_id
        if self.task_type is not None:
            payload["task_type"] = self.task_type
        if self.tool_name is not None:
            payload["tool_name"] = self.tool_name
        if self.details:
            payload["details"] = self.details
        return payload


class UnknownTaskIntent(WorkflowRoleError):
    code = 422


class UnknownWorkflowRole(WorkflowRoleError):
    code = 404


class RoleUnavailable(WorkflowRoleError):
    code = 409


class RolePermissionError(WorkflowRoleError):
    code = 403


class UnknownToolError(WorkflowRoleError):
    code = 403


class CrossBatchReferenceError(WorkflowRoleError):
    code = 403


class StaleRevisionReferenceError(WorkflowRoleError):
    code = 409


class IncompleteBatchScopeError(WorkflowRoleError):
    code = 409


class InputContractError(WorkflowRoleError):
    code = 400


class ToolInputContractError(InputContractError):
    """A tool call did not match its registered JSON input contract."""


class ToolOutputContractError(WorkflowRoleError):
    """A registered tool returned data outside its JSON output contract."""

    code = 500


def require_input_fields(
    input_refs: Any,
    required_fields: dict[str, type],
) -> dict[str, Any]:
    """Validate the small fixed input contract without a JSONSchema dependency."""

    if not isinstance(input_refs, dict):
        raise InputContractError("input_refs 必须是对象")
    for field_name, expected_type in required_fields.items():
        if field_name not in input_refs:
            raise InputContractError(f"缺少必填输入字段：{field_name}")
        value = input_refs[field_name]
        if not isinstance(value, expected_type):
            raise InputContractError(
                f"输入字段 {field_name} 类型错误，期望 {expected_type.__name__}"
            )
        if expected_type is str and not value.strip():
            raise InputContractError(f"输入字段 {field_name} 不能为空")
        if expected_type is list:
            for item in value:
                if not isinstance(item, str) or not item.strip():
                    raise InputContractError(
                        f"输入字段 {field_name} 必须是非空字符串 ID 列表"
                    )
    return input_refs
