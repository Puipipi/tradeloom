from __future__ import annotations

from typing import Any

from .context import RoleToolbox, WorkflowContext
from .workflow_contracts import (
    IncompleteBatchScopeError,
    InputContractError,
    require_input_fields,
)


class ProductAgent:
    role_id = "product_profile"
    available = True
    allowed_tools = frozenset(
        {
            "read_batch_products",
            "read_current_revisions",
            "read_task_files",
            "match_image_candidates",
            "validate_product_data",
        }
    )

    def input_schema(self) -> dict[str, Any]:
        nonblank_id = {"type": "string", "minLength": 1, "pattern": r".*\S.*"}
        id_list = {"type": "array", "items": nonblank_id}
        return {
            "type": "object",
            "required": [
                "workflow_task_id",
                "batch_id",
                "scope",
                "product_ids",
            ],
            "properties": {
                "workflow_task_id": nonblank_id,
                "batch_id": nonblank_id,
                "scope": {"type": "string", "const": "full_batch"},
                "product_ids": id_list,
                "product_revision_ids": {"anyOf": [id_list, {"type": "null"}]},
            },
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
                "products",
                "source_refs",
                "facts_changed",
            ],
            "properties": {
                "schema_version": {"type": "string", "const": "workflow-role-result.v1"},
                "role": {"type": "string", "const": self.role_id},
                "task_id": {"type": "string", "minLength": 1},
                "batch_id": {"type": "string", "minLength": 1},
                "status": {
                    "type": "string",
                    "enum": ["candidate", "needs_human"],
                },
                "products": {"type": "array"},
                "source_refs": {"type": "object"},
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
                "scope": str,
                "product_ids": list,
            },
        )
        scope = refs.get("scope")
        if scope != "full_batch":
            raise InputContractError("产品资料角色只接受 full_batch 范围")
        product_ids = refs["product_ids"]
        if len(product_ids) != len(set(product_ids)):
            raise InputContractError("product_ids 不能包含重复 ID")
        if set(product_ids) != set(context.product_ids):
            raise IncompleteBatchScopeError(
                "产品资料角色只支持 full_batch，不能遗漏当前批次产品"
            )
        toolbox = RoleToolbox(context, self.role_id, refs)
        validations = toolbox.call(
            "validate_product_data",
            product_ids=list(product_ids),
        )

        products = []
        needs_human = False
        for product in context.products:
            validation = validations.get(product.id)
            if validation is None:
                continue
            product_status = (
                "candidate"
                if not validation["missing_fields"]
                and not validation["uncertainties"]
                else "needs_human"
            )
            needs_human = needs_human or product_status == "needs_human"
            products.append(
                {
                    **validation,
                    "status": product_status,
                }
            )

        return {
            "schema_version": "workflow-role-result.v1",
            "role": self.role_id,
            "task_id": context.workflow.id,
            "batch_id": context.batch.id,
            "status": "needs_human" if needs_human else "candidate",
            "products": products,
            "source_refs": {
                "workflow_task_id": context.workflow.id,
                "batch_id": context.batch.id,
                "product_ids": [product.id for product in context.products if product.id in validations],
            },
            "facts_changed": False,
        }
