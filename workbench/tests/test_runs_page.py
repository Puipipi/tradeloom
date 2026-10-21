from __future__ import annotations

from unittest.mock import patch

from django.test import TestCase
from django.utils import timezone

from workbench.models import AgentRun, EventLog, Task


class RunsDiagnosticsTests(TestCase):
    def setUp(self):
        now = timezone.now()
        self.batch = Task.objects.create(
            title="诊断批次",
            mode="demo",
            status="created",
            created_at=now,
            updated_at=now,
        )

    def test_runs_page_shows_safe_failed_summary_and_current_intent_hashes(self):
        AgentRun.objects.create(
            task=self.batch,
            capability_id="product_profile",
            status="failed",
            started_at=timezone.now(),
            error="RuntimeError: CANARY_SECRET private-handler-detail",
            result={"output": "CANARY_RESULT", "artifact_refs": [{"url": "https://example.invalid/?token=CANARY_TOKEN"}]},
        )
        EventLog.objects.create(
            event_type="health_check",
            actor="CANARY_EVENT_ACTOR",
            payload_summary={"private": "CANARY_EVENT_PAYLOAD"},
        )

        response = self.client.get("/runs")
        body = response.content.decode()

        self.assertEqual(response.status_code, 200)
        self.assertContains(response, "运行失败，详情已隐藏")
        for secret in ("CANARY_SECRET", "private-handler-detail", "CANARY_RESULT", "CANARY_TOKEN", "CANARY_EVENT_ACTOR", "CANARY_EVENT_PAYLOAD"):
            self.assertNotIn(secret, body)
        from workbench.intent.parser import load_intent_config

        config = load_intent_config()
        self.assertContains(response, config["rules_version"])
        self.assertContains(response, config["prompt_version"])
        self.assertContains(response, config["rules_sha256"])
        self.assertContains(response, config["prompt_sha256"])

    def test_health_preserves_legacy_fields_and_reports_local_checks(self):
        response = self.client.get("/api/health")
        data = response.json()
        self.assertEqual(response.status_code, 200)
        self.assertEqual(data["status"], "ok")
        self.assertEqual(data["execution_mode"], "local_demo")
        self.assertEqual(data["agentarts"], "not_configured")
        self.assertEqual(data["dependencies"]["database"]["status"], "ok")
        self.assertEqual(data["dependencies"]["intent_config"]["status"], "ok")
        self.assertEqual(data["dependencies"]["external_provider"]["status"], "not_checked")
        self.assertEqual(data["dependencies"]["agentarts"]["status"], "not_configured")
        self.assertEqual(data["runtime"]["health_status"], "partial")

    def test_health_is_degraded_when_intent_config_is_invalid(self):
        from workbench.intent.parser import IntentConfigurationError

        with patch("workbench.diagnostics.load_intent_config", side_effect=IntentConfigurationError("CANARY_SECRET")):
            response = self.client.get("/api/health")
        self.assertEqual(response.status_code, 503)
        self.assertEqual(response.json()["status"], "degraded")
        self.assertEqual(response.json()["dependencies"]["intent_config"]["code"], "invalid")
        self.assertNotIn("CANARY_SECRET", response.content.decode())

    def test_health_is_degraded_when_database_probe_fails(self):
        with patch("workbench.diagnostics.connection.cursor", side_effect=RuntimeError("CANARY_SECRET")):
            response = self.client.get("/api/health")
        self.assertEqual(response.status_code, 503)
        self.assertEqual(response.json()["status"], "degraded")
        self.assertEqual(response.json()["dependencies"]["database"]["code"], "unavailable")
        self.assertNotIn("CANARY_SECRET", response.content.decode())

    def test_runtime_health_exception_is_degraded_without_exception_text(self):
        with patch("workbench.diagnostics.WorkflowOrchestrator") as orchestrator:
            orchestrator.return_value.runtime.health_check.side_effect = RuntimeError("CANARY_RUNTIME_SECRET")
            response = self.client.get("/api/health")
        self.assertEqual(response.status_code, 503)
        self.assertEqual(response.json()["dependencies"]["runtime"]["code"], "unavailable")
        self.assertNotIn("CANARY_RUNTIME_SECRET", response.content.decode())

    def test_unknown_runtime_health_status_is_degraded_and_sanitized(self):
        with patch("workbench.diagnostics.WorkflowOrchestrator") as orchestrator:
            orchestrator.return_value.runtime.health_check.return_value = {
                "status": "CANARY_RUNTIME_SECRET",
                "execution_mode": "CANARY_MODE",
            }
            response = self.client.get("/api/health")
        self.assertEqual(response.status_code, 503)
        self.assertEqual(response.json()["dependencies"]["runtime"]["code"], "unavailable")
        self.assertNotIn("CANARY_RUNTIME_SECRET", response.content.decode())
        self.assertNotIn("CANARY_MODE", response.content.decode())

