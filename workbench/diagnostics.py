from __future__ import annotations

from typing import Any

from django.db import connection

from workbench.intent.parser import IntentConfigurationError, load_intent_config
from workbench.workflows.orchestrator import WorkflowOrchestrator


def collect_local_diagnostics() -> dict[str, Any]:
    """Check local dependencies and the runtime the web workflow currently selects."""
    dependencies: dict[str, dict[str, Any]] = {
        "database": {"status": "ok", "scope": "SELECT 1"},
        "intent_config": {"status": "ok"},
        "runtime": {"status": "ok", "scope": "local_health_check_only"},
        "external_provider": {"status": "not_checked"},
        "agentarts": {"status": "not_configured"},
    }
    intent: dict[str, str] | None = None
    runtime_health: dict[str, Any] | None = None

    try:
        with connection.cursor() as cursor:
            cursor.execute("SELECT 1")
            cursor.fetchone()
    except Exception:
        dependencies["database"] = {"status": "degraded", "code": "unavailable"}

    try:
        config = load_intent_config()
        intent = {
            "rules_version": config["rules_version"],
            "rules_sha256": config["rules_sha256"],
            "prompt_version": config["prompt_version"],
            "prompt_sha256": config["prompt_sha256"],
        }
    except IntentConfigurationError:
        dependencies["intent_config"] = {"status": "degraded", "code": "invalid"}
    except Exception:
        dependencies["intent_config"] = {"status": "degraded", "code": "unavailable"}

    try:
        # WorkflowOrchestrator is the actual web execution path; its constructor
        # currently selects MockAgentRuntime and performs no external calls here.
        runtime = WorkflowOrchestrator().runtime
        checked_health = runtime.health_check()
        health_status = checked_health.get("status")
        if health_status not in {"ok", "partial"}:
            dependencies["runtime"] = {"status": "degraded", "code": "unavailable"}
        else:
            execution_mode = checked_health.get("execution_mode")
            planning_mode = checked_health.get("planning_mode")
            runtime_health = {
                "status": health_status,
                "execution_mode": execution_mode if execution_mode == "local_mock" else "unknown",
                "planning_mode": planning_mode if planning_mode == "simulated_rules" else "unknown",
            }
            dependencies["runtime"] = {
                "status": "ok",
                "scope": "local_health_check_only",
                "health_status": health_status,
                "execution_mode": runtime_health["execution_mode"],
                "planning_mode": runtime_health["planning_mode"],
            }
    except Exception:
        dependencies["runtime"] = {"status": "degraded", "code": "unavailable"}

    degraded = any(item["status"] == "degraded" for item in dependencies.values())
    return {
        "status": "degraded" if degraded else "ok",
        "dependencies": dependencies,
        "intent": intent,
        "runtime_health": runtime_health,
    }


def safe_run_error_summary(run) -> str:
    """Return fixed summaries only; AgentRun.error is legacy untrusted free text."""
    if run.status == "failed":
        return "运行失败，详情已隐藏"
    if run.status == "unavailable":
        return "能力当前不可用"
    return ""
