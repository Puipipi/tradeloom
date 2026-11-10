from __future__ import annotations

import json
from typing import Any

from jsonschema import Draft202012Validator

from .registry import build_workflow_role_registry
from .workflow_contracts import UnknownWorkflowRole


class RoleResultContractError(ValueError):
    """A role returned a value outside its registered JSON result contract."""


def validate_role_result(
    role_id: str,
    result: Any,
    *,
    task_id: str,
    batch_id: str,
) -> dict[str, Any]:
    registry = build_workflow_role_registry()
    try:
        role = registry.get(role_id)
    except UnknownWorkflowRole as exc:
        raise RoleResultContractError from exc
    if not getattr(role, "available", False) or not callable(
        getattr(role, "execute", None)
    ):
        raise RoleResultContractError

    try:
        json.dumps(result, ensure_ascii=False, allow_nan=False)
    except (TypeError, ValueError, OverflowError) as exc:
        raise RoleResultContractError from exc

    if not isinstance(result, dict):
        raise RoleResultContractError
    try:
        schema = role.output_schema()
        Draft202012Validator.check_schema(schema)
        errors = Draft202012Validator(schema).iter_errors(result)
        if next(errors, None) is not None:
            raise RoleResultContractError
    except RoleResultContractError:
        raise
    except Exception as exc:
        raise RoleResultContractError from exc

    if (
        result.get("role") != role_id
        or result.get("task_id") != str(task_id)
        or result.get("batch_id") != str(batch_id)
    ):
        raise RoleResultContractError
    return result
