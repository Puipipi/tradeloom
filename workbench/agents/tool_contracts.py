from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Callable

from .schema_validation import validate_json_contract


ToolHandler = Callable[..., Any]


def _object(properties: dict[str, Any], required: list[str]) -> dict[str, Any]:
    return {
        "type": "object",
        "properties": properties,
        "required": required,
        "additionalProperties": True,
    }


_string = {"type": "string"}
_string_array = {"type": "array", "items": _string}
_revision = _object(
    {
        "revision_id": _string,
        "product_id": _string,
        "version": {"type": "integer"},
        "status": _string,
        "english_name_present": {"type": "boolean"},
        "snapshot": {"type": "object"},
    },
    ["revision_id", "product_id", "version", "status", "english_name_present", "snapshot"],
)
_image_candidate = _object(
    {
        "task_file_id": _string,
        "original_name": _string,
        "stored_name": _string,
        "match_types": _string_array,
    },
    ["task_file_id", "original_name", "stored_name", "match_types"],
)
_source_refs = _object(
    {
        "product": {"type": "string", "const": "workbench.BatchItem"},
        "product_id": _string,
        "revision": {
            "anyOf": [
                {"type": "string", "const": "workbench.BatchItem"},
                {"type": "null"},
            ]
        },
        "revision_id": {"type": ["string", "null"]},
        "task_file_ids": _string_array,
    },
    ["product", "product_id", "revision", "revision_id", "task_file_ids"],
)
_validation = _object(
    {
        "product_id": _string,
        "sku": _string,
        "position": {"type": "integer"},
        "current_revision": {"anyOf": [_revision, {"type": "null"}]},
        "image_candidates": {"type": "array", "items": _image_candidate},
        "missing_fields": _string_array,
        "uncertainties": _string_array,
        "source_refs": _source_refs,
    },
    ["product_id", "sku", "position", "current_revision", "image_candidates", "missing_fields", "uncertainties", "source_refs"],
)
_check = _object({"code": _string, "status": _string}, ["code", "status"])
_readiness_product = _object(
    {**_validation["properties"], "status": _string},
    [*_validation["required"], "status"],
)
_nullable_string = {"type": ["string", "null"]}
_customer_alias = _object(
    {
        "id": _string,
        "customer_id": _nullable_string,
        "source_candidate_id": _nullable_string,
        "raw_text": _string,
        "normalized_text": _string,
        "decision": _string,
        "created_at": _string,
        "updated_at": _string,
    },
    [
        "id",
        "customer_id",
        "source_candidate_id",
        "raw_text",
        "normalized_text",
        "decision",
        "created_at",
        "updated_at",
    ],
)
_customer_profile = _object(
    {
        "id": _string,
        "display_name": _string,
        "created_at": _string,
        "updated_at": _string,
        "aliases": {"type": "array", "items": _customer_alias},
    },
    ["id", "display_name", "created_at", "updated_at", "aliases"],
)
_customer_event = _object(
    {
        "id": _string,
        "customer_id": _string,
        "alias_id": _string,
        "source_candidate_id": _string,
        "event_type": _string,
        "occurred_on": _string,
        "payload": {"type": "object"},
        "source_refs": {"type": "object"},
        "created_at": _string,
    },
    [
        "id",
        "customer_id",
        "alias_id",
        "source_candidate_id",
        "event_type",
        "occurred_on",
        "payload",
        "source_refs",
        "created_at",
    ],
)
_customer_metric = _object(
    {
        "id": _string,
        "customer_id": _string,
        "metric_key": _string,
        "metric_version": _string,
        "as_of": _string,
        "window_start": _string,
        "window_end": _string,
        "value": _nullable_string,
        "unit": _string,
        "formula": _string,
        "coverage": {"type": "object"},
        "input_event_ids": _string_array,
        "inputs_hash": _string,
        "created_at": _string,
    },
    [
        "id",
        "customer_id",
        "metric_key",
        "metric_version",
        "as_of",
        "window_start",
        "window_end",
        "value",
        "unit",
        "formula",
        "coverage",
        "input_event_ids",
        "inputs_hash",
        "created_at",
    ],
)
_customer_prediction = _object(
    {
        "id": _string,
        "customer_id": _string,
        "prediction_type": _string,
        "predicted_on": _string,
        "horizon_days": {"type": "integer"},
        "result": _string,
        "rule_id": _string,
        "rule_version": _string,
        "input_snapshot": {"type": "object"},
        "inputs_hash": _string,
        "outcome": _string,
        "resolved_at": _nullable_string,
        "created_at": _string,
    },
    [
        "id",
        "customer_id",
        "prediction_type",
        "predicted_on",
        "horizon_days",
        "result",
        "rule_id",
        "rule_version",
        "input_snapshot",
        "inputs_hash",
        "outcome",
        "resolved_at",
        "created_at",
    ],
)
_customer_action = _object(
    {
        "id": _string,
        "customer_id": _string,
        "prediction_id": _string,
        "action_type": _string,
        "suggestion": _string,
        "due_on": _nullable_string,
        "status": _string,
        "note": _string,
        "decided_at": _nullable_string,
        "created_at": _string,
        "updated_at": _string,
    },
    [
        "id",
        "customer_id",
        "prediction_id",
        "action_type",
        "suggestion",
        "due_on",
        "status",
        "note",
        "decided_at",
        "created_at",
        "updated_at",
    ],
)


def _customer_tool_input(*, with_limit: bool = False) -> dict[str, Any]:
    properties: dict[str, Any] = {
        "customer_id": {"type": "string", "minLength": 1, "pattern": r".*\S.*"},
    }
    if with_limit:
        properties["limit"] = {
            "type": "integer",
            "minimum": 1,
            "maximum": 100,
            "default": 20,
        }
    return {
        "type": "object",
        "properties": properties,
        "required": ["customer_id"],
        "additionalProperties": False,
    }


TOOL_CONTRACTS: dict[str, tuple[str, dict[str, Any], dict[str, Any]]] = {
    "read_workflow_task": (
        "读取当前工作流任务及所属批次的标识、状态和任务描述。",
        {"type": "object", "properties": {}, "additionalProperties": False},
        _object(
            {key: _string for key in ("id", "status", "current_step", "task_type", "user_goal", "batch_id", "batch_title", "batch_status")},
            ["id", "status", "current_step", "task_type", "user_goal", "batch_id", "batch_title", "batch_status"],
        ),
    ),
    "read_batch_products": (
        "读取当前批次产品记录，包含产品标识、顺序、描述字段、图像来源名称和缺失字段。",
        {"type": "object", "properties": {}, "additionalProperties": False},
        {"type": "array", "items": _object(
            {**{key: _string for key in ("product_id", "sku", "name", "category", "material", "size", "color", "image_filename", "image_stored_name")}, "position": {"type": "integer"}, "missing_fields": _string_array},
            ["product_id", "sku", "position", "name", "category", "material", "size", "color", "image_filename", "image_stored_name", "missing_fields"],
        )},
    ),
    "read_current_revisions": (
        "读取当前批次产品各自的当前修订及其完整 JSON 快照。",
        {"type": "object", "properties": {}, "additionalProperties": False},
        {"type": "array", "items": _revision},
    ),
    "read_confirmed_revisions": (
        "读取当前批次中状态为 confirmed 的产品修订及其完整 JSON 快照。",
        {"type": "object", "properties": {}, "additionalProperties": False},
        {"type": "array", "items": _revision},
    ),
    "read_task_files": (
        "读取当前批次任务文件的标识、文件类型和原始/存储名称。",
        {"type": "object", "properties": {}, "additionalProperties": False},
        {"type": "array", "items": _object(
            {key: _string for key in ("task_file_id", "kind", "original_name", "stored_name")},
            ["task_file_id", "kind", "original_name", "stored_name"],
        )},
    ),
    "match_image_candidates": (
        "按当前批次产品匹配图像文件，返回候选来源和匹配方式。",
        {"type": "object", "properties": {"product_ids": {"type": ["array", "null"], "items": {"type": "string", "minLength": 1, "pattern": ".*\\S.*"}}}, "additionalProperties": False},
        {"type": "object", "additionalProperties": {"type": "array", "items": _image_candidate}},
    ),
    "validate_product_data": (
        "读取并汇总当前批次产品资料、修订、图像候选、缺失字段、不确定项及来源标识。",
        {"type": "object", "properties": {"product_ids": {"type": ["array", "null"], "items": {"type": "string", "minLength": 1, "pattern": ".*\\S.*"}}}, "additionalProperties": False},
        {"type": "object", "additionalProperties": _validation},
    ),
    "check_data_readiness": (
        "检查当前批次数据准备结果，返回范围、逐项检查和产品资料摘要。",
        {"type": "object", "properties": {}, "additionalProperties": False},
        _object(
            {
                "status": _string,
                "quality_scope": _string,
                "data_readiness": _string,
                "artifacts_generated": {"type": "boolean"},
                "scope": _object(
                    {"kind": _string, "all_product_ids": _string_array, "confirmed_revision_ids": _string_array, "unconfirmed_product_ids": _string_array, "requires_all_products_confirmed": {"type": "boolean"}, "all_products_confirmed": {"type": "boolean"}},
                    ["kind", "all_product_ids", "confirmed_revision_ids", "unconfirmed_product_ids", "requires_all_products_confirmed", "all_products_confirmed"],
                ),
                "checks": {"type": "array", "items": _check},
                "products": {"type": "array", "items": _readiness_product},
            },
            ["status", "quality_scope", "data_readiness", "artifacts_generated", "scope", "checks", "products"],
        ),
    ),
    "read_customer_profile": (
        "读取指定客户的档案及全部别名，不修改客户资料。",
        _customer_tool_input(),
        _customer_profile,
    ),
    "read_customer_events": (
        "按数量上限读取指定客户的事件及来源引用。",
        _customer_tool_input(with_limit=True),
        {"type": "array", "items": _customer_event},
    ),
    "read_customer_metrics": (
        "按数量上限读取指定客户已保存的指标快照及输入事件和覆盖范围。",
        _customer_tool_input(with_limit=True),
        {"type": "array", "items": _customer_metric},
    ),
    "read_customer_predictions": (
        "按数量上限读取指定客户已保存的推测及输入快照，不执行评估。",
        _customer_tool_input(with_limit=True),
        {"type": "array", "items": _customer_prediction},
    ),
    "read_customer_actions": (
        "按数量上限读取指定客户已保存的行动建议，不改变行动状态。",
        _customer_tool_input(with_limit=True),
        {"type": "array", "items": _customer_action},
    ),
    "compose_generation_intent": (
        "读取固定的生成意图清单，包含产物类型、格式、状态和是否已生成标记。",
        {"type": "object", "properties": {}, "additionalProperties": False},
        {"type": "array", "items": _object(
            {"artifact_type": _string, "format": _string, "status": _string, "artifacts_generated": {"type": "boolean"}},
            ["artifact_type", "format", "status", "artifacts_generated"],
        )},
    ),
}


@dataclass(frozen=True)
class ToolDefinition:
    description: str
    input_schema: dict[str, Any]
    output_schema: dict[str, Any]
    handler: ToolHandler


def make_tool_definition(name: str, handler: ToolHandler) -> ToolDefinition:
    description, input_schema, output_schema = TOOL_CONTRACTS[name]
    return ToolDefinition(description, input_schema, output_schema, handler)
