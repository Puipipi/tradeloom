from __future__ import annotations

import hashlib
import json
from pathlib import Path
from string import Template
from typing import Any

from django.core import signing
from jsonschema.exceptions import SchemaError, ValidationError
from workbench.agents.schema_validation import validate_json_contract
from workbench.models import Task


CONFIG_DIR = Path(__file__).resolve().parent
CONFIRMATION_SALT = "workbench.task-intent.confirm.v1"
AVAILABLE_TASK_TYPES = ("prepare_product_data", "generate_deliverables")
STRUCTURED_CONFIRMATION_KIND = "structured_agent_proposal"
STRUCTURED_CONFIRMATION_VERSION = 1
EXECUTION_MODES = ("local_mock", "native_dsh")

RULES_SCHEMA = {
    "type": "object",
    "required": ["version", "prepare_product_data", "generate_deliverables", "out_of_scope", "negation", "combination"],
    "additionalProperties": False,
    "properties": {
        "version": {"type": "string", "minLength": 1, "maxLength": 80},
        "prepare_product_data": {"$ref": "#/$defs/languages"},
        "generate_deliverables": {"$ref": "#/$defs/languages"},
        "out_of_scope": {"$ref": "#/$defs/languages"},
        "negation": {"$ref": "#/$defs/languages"},
        "combination": {"$ref": "#/$defs/languages"},
    },
    "$defs": {
        "languages": {
            "type": "object", "required": ["zh", "en"], "additionalProperties": False,
            "properties": {
                "zh": {"type": "array", "items": {"type": "string", "minLength": 1}, "minItems": 1},
                "en": {"type": "array", "items": {"type": "string", "minLength": 1}, "minItems": 1},
            },
        }
    },
}

ACTION_SCHEMA = {
    "type": "object",
    "required": ["operation", "batch_id", "user_goal", "task_type"],
    "additionalProperties": False,
    "properties": {
        "operation": {"const": "create_workflow"},
        "batch_id": {"type": "string", "minLength": 1, "maxLength": 32},
        "user_goal": {"type": "string", "minLength": 1, "maxLength": 4000},
        "task_type": {"enum": list(AVAILABLE_TASK_TYPES)},
    },
}


class IntentConfigurationError(ValueError):
    pass


class InvalidIntentConfirmation(ValueError):
    pass


class InvalidStructuredProposal(ValueError):
    pass


def _sha256(raw: bytes) -> str:
    return hashlib.sha256(raw).hexdigest()


def load_intent_config() -> dict[str, Any]:
    """Load and validate the editable simulation rules and future prompt template."""
    rules_path = CONFIG_DIR / "rules.json"
    prompt_path = CONFIG_DIR / "prompt.md"
    try:
        rules_raw = rules_path.read_bytes()
        prompt_raw = prompt_path.read_bytes()
        rules = json.loads(rules_raw.decode("utf-8"))
        prompt_source = prompt_raw.decode("utf-8")
        validate_json_contract(rules, RULES_SCHEMA)
        first_line, _, prompt_body = prompt_source.partition("\n")
        prefix = "version: "
        if not first_line.startswith(prefix) or not first_line[len(prefix):].strip() or not prompt_body.strip():
            raise ValueError("prompt template metadata or body is missing")
        prompt_version = first_line[len(prefix):].strip()
        template = Template(prompt_body)
        template.substitute(batch_id="batch_id", user_goal="user_goal", task_types="task_types")
    except (OSError, UnicodeDecodeError, json.JSONDecodeError, ValueError, KeyError, SchemaError, ValidationError) as exc:
        raise IntentConfigurationError("自然语言意图配置无效") from exc

    return {
        "rules": rules,
        "rules_version": rules["version"],
        "rules_sha256": _sha256(rules_raw),
        "prompt_version": prompt_version,
        "prompt_sha256": _sha256(prompt_raw),
        "prompt_template": prompt_body,
    }


def _matches(text: str, phrases: list[str]) -> list[str]:
    lowered = text.casefold()
    return [phrase for phrase in phrases if phrase.casefold() in lowered]


def _rule_matches(text: str, configured: dict[str, list[str]]) -> dict[str, list[str]]:
    return {language: _matches(text, phrases) for language, phrases in configured.items()}


def _any_matches(matches: dict[str, list[str]]) -> list[str]:
    return [phrase for phrases in matches.values() for phrase in phrases]


def parse_goal(*, batch_id: str, user_goal: str, config: dict[str, Any] | None = None) -> dict[str, Any]:
    config = config or load_intent_config()
    rules = config["rules"]
    out_of_scope = _rule_matches(user_goal, rules["out_of_scope"])
    matched_out = _any_matches(out_of_scope)
    if matched_out:
        return _non_ready("unsupported", "目标包含当前未支持的业务范围。", matched_out)

    prepare = _rule_matches(user_goal, rules["prepare_product_data"])
    deliver = _rule_matches(user_goal, rules["generate_deliverables"])
    prepare_terms = _any_matches(prepare)
    deliver_terms = _any_matches(deliver)
    if not prepare_terms and not deliver_terms:
        return _non_ready("clarification", "请说明要整理产品资料，还是生成目录/交付物。", [])

    negative = _rule_matches(user_goal, rules["negation"])
    if _any_matches(negative):
        return _non_ready("clarification", "目标中的否定表达使执行方向不明确，请改写为希望完成的动作。", prepare_terms + deliver_terms)

    if prepare_terms and deliver_terms:
        connectors = _rule_matches(user_goal, rules["combination"])
        connector_terms = _any_matches(connectors)
        if not connector_terms:
            return _non_ready("clarification", "目标同时提到资料整理与目录生成，请明确两者是否按现有顺序作为一个交付目标。", prepare_terms + deliver_terms)
        task_type = "generate_deliverables"
        reason = "明确提出资料整理与目录生成；按现有产品资料到交付物顺序规划。"
        evidence = prepare_terms + connector_terms + deliver_terms
    elif deliver_terms:
        task_type = "generate_deliverables"
        reason = "明确提出目录或交付物生成。"
        evidence = deliver_terms
    else:
        task_type = "prepare_product_data"
        reason = "明确提出产品资料整理。"
        evidence = prepare_terms

    action = {
        "operation": "create_workflow",
        "batch_id": batch_id,
        "user_goal": user_goal,
        "task_type": task_type,
    }
    try:
        validate_json_contract(action, ACTION_SCHEMA)
    except Exception as exc:
        raise IntentConfigurationError("解析结果不符合允许的工作流动作 schema") from exc
    return {
        "status": "ready",
        "classification": {
            "task_type": task_type,
            "reason": reason,
            "evidence": evidence,
            "source": "simulated_rules",
        },
        "evidence": evidence,
        "action": action,
    }


def _non_ready(status: str, reason: str, evidence: list[str]) -> dict[str, Any]:
    return {
        "status": status,
        "classification": {"task_type": None, "reason": reason, "evidence": evidence, "source": "simulated_rules"},
        "evidence": evidence,
        "action": None,
        "clarification": reason if status == "clarification" else None,
    }


def _structured_proposal(*, batch_id: str, user_goal: str, task_type: str) -> dict[str, Any]:
    if task_type not in AVAILABLE_TASK_TYPES:
        raise InvalidStructuredProposal("task_type 当前不受支持")
    action = {
        "operation": "create_workflow",
        "batch_id": batch_id,
        "user_goal": user_goal,
        "task_type": task_type,
    }
    try:
        validate_json_contract(action, ACTION_SCHEMA)
    except (SchemaError, ValidationError, TypeError) as exc:
        raise InvalidStructuredProposal("结构化提案不符合现有工作流 schema") from exc
    label = "产品资料准备" if task_type == "prepare_product_data" else "生成交付文件"
    return {
        "status": "ready",
        "classification": {
            "task_type": task_type,
            "reason": f"Agent 提议：{label}。请检查目标和只读来源后确认。",
            "evidence": [],
            "source": "structured_agent_proposal",
        },
        "evidence": [],
        "action": action,
    }


def _structured_confirmation_payload(*, batch_id: str, user_goal: str, task_type: str, execution_mode: str, config: dict[str, Any]) -> dict[str, Any]:
    if task_type not in AVAILABLE_TASK_TYPES:
        raise InvalidStructuredProposal("task_type 当前不受支持")
    return {
        "confirmation_kind": STRUCTURED_CONFIRMATION_KIND,
        "confirmation_version": STRUCTURED_CONFIRMATION_VERSION,
        "batch_id": batch_id,
        "user_goal": user_goal,
        "task_type": task_type,
        "execution_mode": execution_mode,
        "rules_version": config["rules_version"],
        "rules_sha256": config["rules_sha256"],
        "prompt_version": config["prompt_version"],
        "prompt_sha256": config["prompt_sha256"],
    }


def preview_intent(*, batch: Task, user_goal: str, task_type: str | None = None, execution_mode: str = "local_mock") -> dict[str, Any]:
    if execution_mode not in EXECUTION_MODES:
        raise InvalidStructuredProposal("execution_mode 当前不受支持")
    config = load_intent_config()
    structured = task_type is not None
    parsed = (
        _structured_proposal(batch_id=batch.id, user_goal=user_goal, task_type=task_type)
        if structured
        else parse_goal(batch_id=batch.id, user_goal=user_goal, config=config)
    )
    result = {
        **parsed,
        "mode": "agent_proposal" if structured else "local_mock",
        "execution": "human_confirmation_required" if structured else "simulated_rules",
        "execution_mode": execution_mode,
        "model_provider": "not_verified" if structured else "not_configured",
        "prompt": {"version": config["prompt_version"], "sha256": config["prompt_sha256"]},
        "rules": {"version": config["rules_version"], "sha256": config["rules_sha256"]},
        "sources": [
            {"kind": "batch", "model": "workbench.Task", "id": batch.id, "title": batch.title},
            {"kind": "products", "model": "workbench.Product", "count": batch.products.count()},
            {"kind": "files", "model": "workbench.TaskFile", "count": batch.files.count()},
        ],
    }
    if parsed["status"] == "ready":
        result["confirmation_token"] = signing.dumps(
            _structured_confirmation_payload(
                batch_id=batch.id, user_goal=user_goal, task_type=task_type, execution_mode=execution_mode, config=config,
            ) if structured else _confirmation_payload(batch_id=batch.id, user_goal=user_goal, parsed=parsed, execution_mode=execution_mode, config=config),
            salt=CONFIRMATION_SALT,
            compress=True,
        )
    return result


def _confirmation_payload(*, batch_id: str, user_goal: str, parsed: dict[str, Any], execution_mode: str = "local_mock", config: dict[str, Any]) -> dict[str, Any]:
    return {
        "batch_id": batch_id,
        "user_goal": user_goal,
        "task_type": parsed["action"]["task_type"],
        "execution_mode": execution_mode,
        "action": parsed["action"],
        "classification": parsed["classification"],
        "evidence": parsed["evidence"],
        "rules_version": config["rules_version"],
        "rules_sha256": config["rules_sha256"],
        "prompt_version": config["prompt_version"],
        "prompt_sha256": config["prompt_sha256"],
    }


def verify_confirmation_token(*, token: str, batch_id: str, user_goal: str, task_type: str, execution_mode: str = "local_mock") -> dict[str, Any]:
    if execution_mode not in EXECUTION_MODES:
        raise InvalidIntentConfirmation("执行模式不受支持")
    try:
        signed = signing.loads(token, salt=CONFIRMATION_SALT)
        config = load_intent_config()
        if isinstance(signed, dict) and signed.get("confirmation_kind") == STRUCTURED_CONFIRMATION_KIND:
            if task_type not in AVAILABLE_TASK_TYPES:
                raise InvalidIntentConfirmation("结构化提案任务类型不受支持")
            expected = _structured_confirmation_payload(
                batch_id=batch_id, user_goal=user_goal, task_type=task_type, execution_mode=execution_mode, config=config,
            )
            legacy_expected = {key: value for key, value in expected.items() if key != "execution_mode"}
            if signed != expected and not (execution_mode == "local_mock" and signed == legacy_expected):
                raise InvalidIntentConfirmation("结构化提案确认与当前目标、类型或规则不一致")
            label = "产品资料准备" if task_type == "prepare_product_data" else "生成交付文件"
            return {
                "classification": {
                    "task_type": task_type,
                    "reason": f"Agent 提议：{label}，已由用户确认。",
                    "evidence": [],
                    "source": "structured_agent_proposal",
                },
                "evidence": [],
                "rules": {"version": config["rules_version"], "sha256": config["rules_sha256"]},
                "prompt": {"version": config["prompt_version"], "sha256": config["prompt_sha256"]},
                "mode": "agent_proposal",
                "execution": "human_confirmation_required",
                "model_provider": "not_verified",
                "execution_mode": execution_mode,
                "plan_source": "confirmed_structured_agent_proposal",
            }
        parsed = parse_goal(batch_id=batch_id, user_goal=user_goal, config=config)
        expected = _confirmation_payload(batch_id=batch_id, user_goal=user_goal, parsed=parsed, execution_mode=execution_mode, config=config)
        legacy_expected = {key: value for key, value in expected.items() if key != "execution_mode"}
        if parsed["status"] != "ready" or task_type != parsed["action"]["task_type"] or (signed != expected and not (execution_mode == "local_mock" and signed == legacy_expected)):
            raise InvalidIntentConfirmation("预览确认与当前目标或规则不一致")
        return {
            "classification": parsed["classification"],
            "evidence": parsed["evidence"],
            "rules": {"version": config["rules_version"], "sha256": config["rules_sha256"]},
            "prompt": {"version": config["prompt_version"], "sha256": config["prompt_sha256"]},
            "mode": "local_mock",
            "execution_mode": execution_mode,
            "execution": "simulated_rules",
            "model_provider": "not_configured",
            "plan_source": "confirmed_natural_language_intent",
        }
    except InvalidIntentConfirmation:
        raise
    except (signing.BadSignature, IntentConfigurationError, ValueError, TypeError) as exc:
        raise InvalidIntentConfirmation("预览确认无效或当前规则已变化，请重新解析。") from exc
