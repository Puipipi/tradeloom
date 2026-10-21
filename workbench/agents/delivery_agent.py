from __future__ import annotations

from typing import Any

from .context import RoleToolbox, WorkflowContext
from .workflow_contracts import (
    IncompleteBatchScopeError,
    InputContractError,
    require_input_fields,
)


class DeliveryQualityAgent:
    role_id = "delivery_quality"
    available = True
    allowed_tools = frozenset(
        {
            "read_batch_products",
            "read_confirmed_revisions",
            "read_task_files",
            "check_data_readiness",
            "compose_generation_intent",
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
                "all_product_ids",
                "confirmed_revision_ids",
                "unconfirmed_product_ids",
                "requires_all_products_confirmed",
            ],
            "properties": {
                "workflow_task_id": nonblank_id,
                "batch_id": nonblank_id,
                "scope": {"type": "string", "const": "full_batch"},
                "all_product_ids": id_list,
                "all_revision_ids": {"anyOf": [id_list, {"type": "null"}]},
                "confirmed_revision_ids": id_list,
                "unconfirmed_product_ids": id_list,
                "requires_all_products_confirmed": {
                    "type": "boolean",
                    "const": True,
                },
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
                "quality_scope",
                "data_readiness",
                "artifacts_generated",
                "artifact_quality",
                "checks",
                "generation_intent",
                "scope",
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
                    "enum": ["ready_for_generation", "needs_human", "blocked"],
                },
                "quality_scope": {"type": "string", "const": "data_readiness"},
                "data_readiness": {
                    "type": "string",
                    "enum": ["ready", "not_ready"],
                },
                "artifacts_generated": {"type": "boolean", "const": False},
                "artifact_quality": {"type": "string", "const": "not_evaluated"},
                "checks": {"type": "array"},
                "generation_intent": {"type": "array"},
                "scope": {"type": "object"},
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
                "all_product_ids": list,
                "confirmed_revision_ids": list,
                "unconfirmed_product_ids": list,
                "requires_all_products_confirmed": bool,
            },
        )
        toolbox = RoleToolbox(context, self.role_id, refs)
        if refs.get("scope") != "full_batch":
            raise InputContractError("交付质检必须使用 full_batch 范围")
        all_product_ids = refs.get("all_product_ids")
        if not isinstance(all_product_ids, (list, tuple, set)):
            raise InputContractError("交付质检缺少 all_product_ids")
        if set(all_product_ids) != set(context.product_ids):
            raise IncompleteBatchScopeError(
                "交付质检必须覆盖当前批次全部产品，不能只处理 confirmed 子集"
            )
        if refs.get("requires_all_products_confirmed") is not True:
            raise InputContractError(
                "交付质检要求 requires_all_products_confirmed=true"
            )

        confirmed_revision_ids = refs.get("confirmed_revision_ids")
        if confirmed_revision_ids is not None and set(confirmed_revision_ids) != set(
            context.confirmed_revision_ids
        ):
            raise IncompleteBatchScopeError(
                "confirmed_revision_ids 与当前批次实际确认修订不一致"
            )
        unconfirmed_product_ids = refs.get("unconfirmed_product_ids")
        if unconfirmed_product_ids is not None and set(
            unconfirmed_product_ids
        ) != set(context.unconfirmed_product_ids):
            raise InputContractError(
                "unconfirmed_product_ids 与当前批次实际未确认产品不一致"
            )

        readiness = toolbox.call("check_data_readiness")
        generation_intent = (
            toolbox.call("compose_generation_intent")
            if readiness["status"] == "ready_for_generation"
            else []
        )
        return {
            "schema_version": "workflow-role-result.v1",
            "role": self.role_id,
            "task_id": context.workflow.id,
            "batch_id": context.batch.id,
            **readiness,
            "artifact_quality": "not_evaluated",
            "generation_intent": generation_intent,
            "source_refs": {
                "workflow_task_id": context.workflow.id,
                "batch_id": context.batch.id,
                "product_ids": context.product_ids,
            },
            "facts_changed": False,
        }
