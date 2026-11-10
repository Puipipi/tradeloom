from __future__ import annotations

from typing import Any

from .context import RoleToolbox, WorkflowContext
from .workflow_contracts import (
    OUT_OF_SCOPE_TERMS,
    SIMULATED_MARKERS,
    SUPPORTED_TASK_TYPES,
    UnknownTaskIntent,
)


class CenterAgent:
    role_id = "center"
    available = True
    allowed_tools = frozenset(
        {
            "read_workflow_task",
            "read_batch_products",
            "read_current_revisions",
        }
    )

    def input_schema(self) -> dict[str, Any]:
        return {
            "type": "object",
            "required": ["workflow_task_id"],
            "properties": {
                "workflow_task_id": {"type": "string"},
            },
        }

    def output_schema(self) -> dict[str, Any]:
        return {
            "type": "object",
            "required": [
                "schema_version",
                "classification",
                "planning_step",
                "subtasks",
                "source_refs",
                "execution",
            ],
            "properties": {
                "classification": {"type": "object"},
                "planning_step": {"type": "object"},
                "subtasks": {"type": "array"},
                "source_refs": {"type": "object"},
                "execution": {"type": "object"},
            },
        }

    def plan(
        self, context: WorkflowContext, registry=None,
        confirmed_intent: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        if registry is None:
            from .registry import build_workflow_role_registry

            registry = build_workflow_role_registry()
        product_role = registry.get("product_profile")
        delivery_role = registry.get("delivery_quality")

        def required_field_hints(schema: dict[str, Any]) -> list[str]:
            properties = schema.get("properties", {})
            fields = []
            for field_name in schema.get("required", []):
                constraint = properties.get(field_name, {})
                if "const" in constraint:
                    fields.append(f"{field_name}={constraint['const']}")
                else:
                    fields.append(field_name)
            return fields

        toolbox = RoleToolbox(context, self.role_id, {})
        task = toolbox.call("read_workflow_task")
        task_type = task["task_type"]
        goal = task["user_goal"]
        if confirmed_intent is not None:
            classification = confirmed_intent.get("classification")
            if not isinstance(classification, dict):
                raise UnknownTaskIntent("已确认的自然语言意图缺少结构化分类")
            classified_type = classification.get("task_type")
            if classified_type not in SUPPORTED_TASK_TYPES or classified_type != task_type:
                raise UnknownTaskIntent("已确认意图与工作流任务类型不一致", task_type=task_type)
        if task_type not in SUPPORTED_TASK_TYPES:
            raise UnknownTaskIntent(
                f"不支持的任务类型：{task_type}；请明确为资料准备或交付生成。",
                task_type=task_type,
            )
        matched_terms = [term for term in OUT_OF_SCOPE_TERMS if term in goal]
        if matched_terms:
            raise UnknownTaskIntent(
                "任务意图超出中心规划范围："
                + "、".join(matched_terms)
                + "。当前只支持产品资料准备与交付资料生成规划。",
                task_type=task_type,
            )

        products = toolbox.call("read_batch_products")
        revisions = toolbox.call("read_current_revisions")
        revision_by_product = {
            item["product_id"]: item for item in revisions
        }
        product_refs = []
        for product in products:
            revision = revision_by_product.get(product["product_id"])
            product_refs.append(
                {
                    "product_id": product["product_id"],
                    "sku": product["sku"],
                    "position": product["position"],
                    "revision_id": revision["revision_id"] if revision else None,
                    "revision_version": revision["version"] if revision else None,
                    "revision_status": revision["status"] if revision else None,
                }
            )
        product_ids = [item["product_id"] for item in product_refs]
        revision_ids = [
            item["revision_id"]
            for item in product_refs
            if item["revision_id"] is not None
        ]
        confirmed_revision_ids = [
            item["revision_id"]
            for item in product_refs
            if item["revision_status"] == "confirmed"
        ]
        unconfirmed_product_ids = [
            item["product_id"]
            for item in product_refs
            if item["revision_status"] != "confirmed"
        ]

        plan_classification = (
            {
                **confirmed_intent["classification"],
                "task_type": task_type,
                "intent_key": task_type,
                "supported": True,
                "source": confirmed_intent.get("plan_source", "confirmed_natural_language_intent"),
                "evidence": confirmed_intent["evidence"],
                "simulation": {
                    "mode": confirmed_intent["mode"],
                    "execution": confirmed_intent["execution"],
                    "model_provider": confirmed_intent["model_provider"],
                },
                "rules": confirmed_intent["rules"],
                "prompt": confirmed_intent["prompt"],
            }
            if confirmed_intent is not None
            else {
                "task_type": task_type,
                "intent_key": task_type,
                "supported": True,
                "reason": (
                    "明确的资料准备任务"
                    if task_type == "prepare_product_data"
                    else "明确的交付生成任务"
                ),
            }
        )
        return {
            **SIMULATED_MARKERS,
            "schema_version": "agent-runtime-plan.v2",
            "plan_only": True,
            "classification": plan_classification,
            "planning_step": {
                "step_key": "center_plan",
                "kind": "workflow_step",
                "status": "planned",
                "subtask_created": False,
                "persistence_owner": "Task10",
            },
            "task": task,
            "source_summary": {
                "product_count": len(product_refs),
                "current_revision_count": len(revision_ids),
                "confirmed_current_revision_count": len(confirmed_revision_ids),
                "products_without_current_revision": len(product_refs)
                - len(revision_ids),
            },
            "source_refs": {
                "workflow_task": {
                    "model": "workbench.WorkflowTask",
                    "id": task["id"],
                },
                "batch": {
                    "model": "workbench.Task",
                    "id": task["batch_id"],
                },
                "product_revisions": product_refs,
            },
            "execution": {
                "subtasks_created": False,
                "dispatch_available": True,
                "run_subtask_ready": True,
                "persistence_owner": "Task10",
                "reason": "本地确定性角色处理器已接入；Task10 负责持久化与完成门禁。",
            },
            "subtasks": [
                {
                    "key": "product_profile",
                    "order": 1,
                    "agent_role": "product_profile",
                    "depends_on": [],
                    "input_refs": {
                        "workflow_task_id": task["id"],
                        "batch_id": task["batch_id"],
                        "scope": "full_batch",
                        "product_ids": product_ids,
                        "product_revision_ids": revision_ids,
                    },
                    "required_fields": required_field_hints(
                        product_role.input_schema()
                    ),
                    "input_schema": product_role.input_schema(),
                    "output_schema": product_role.output_schema(),
                },
                {
                    "key": "delivery_quality",
                    "order": 2,
                    "agent_role": "delivery_quality",
                    "depends_on": ["product_profile"],
                    "input_refs": {
                        "upstream": ["product_profile"],
                        "workflow_task_id": task["id"],
                        "batch_id": task["batch_id"],
                        "scope": "full_batch",
                        "all_product_ids": product_ids,
                        "all_revision_ids": revision_ids,
                        "confirmed_revision_ids": confirmed_revision_ids,
                        "unconfirmed_product_ids": unconfirmed_product_ids,
                        "requires_all_products_confirmed": True,
                        "all_products_confirmed": bool(product_refs)
                        and not unconfirmed_product_ids,
                    },
                    "required_fields": required_field_hints(
                        delivery_role.input_schema()
                    ),
                    "input_schema": delivery_role.input_schema(),
                    "output_schema": delivery_role.output_schema(),
                },
            ],
        }
