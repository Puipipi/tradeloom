from __future__ import annotations

import json
from unittest.mock import patch

from django.test import SimpleTestCase
from django.test import RequestFactory

from workbench.agents.agentarts import AgentArtsAdapter, AgentArtsResponseError
from workbench.agents.adapters import AdapterRegistry
from workbench.api import health


class AgentArtsAdapterTests(SimpleTestCase):
    def setUp(self):
        self.adapter = AgentArtsAdapter(
            endpoint="https://agentarts.example.test/api",
            runtime_name="trade_runtime-1",
            session_id="session_01-ab",
            authorization="Bearer TEST_ONLY_AUTHORIZATION",
        )

    def test_builds_published_invocation_envelope_without_network_access(self):
        payload = {"query": "hello"}
        with patch("socket.create_connection") as connect, patch("urllib.request.urlopen") as urlopen:
            request = self.adapter.build_request(payload)
            health = self.adapter.health_check()

        self.assertEqual(request["method"], "POST")
        self.assertEqual(request["url"], "https://agentarts.example.test/api/runtimes/trade_runtime-1/invocations")
        self.assertEqual(request["headers"]["Authorization"], "Bearer TEST_ONLY_AUTHORIZATION")
        self.assertEqual(request["headers"]["X-Invoke-Mode"], "published")
        self.assertEqual(request["headers"]["x-hw-agentarts-session-id"], "session_01-ab")
        self.assertEqual(request["headers"]["Content-Type"], "application/json")
        self.assertEqual(request["body"], payload)
        self.assertEqual(health, {
            "agentarts": "not_configured",
            "evidence": "documented_not_connected",
            "adapter": "offline_adapter",
        })
        connect.assert_not_called()
        urlopen.assert_not_called()

    def test_debug_mode_and_caller_supplied_workflow_inputs_are_preserved(self):
        payload = {
            "inputs": {"product_ids": ["p-1"]},
            "plugin_configs": [{"plugin_id": "plugin-1", "config": {"X-Api-Key": "TEST_ONLY_PLUGIN_VALUE"}}],
        }
        request = self.adapter.build_request(payload, invoke_mode="debug")
        self.assertEqual(request["headers"]["X-Invoke-Mode"], "debug")
        self.assertEqual(request["body"], payload)

    def test_rejects_invalid_envelope_values_without_echoing_secrets(self):
        invalid = (
            ("http://agentarts.example.test", "bad/name", "session", "TEST_AUTH"),
            ("https://agentarts.example.test", "runtime", "bad session", "TEST_AUTH"),
            ("https://agentarts.example.test", "runtime", "session", "TEST_AUTH\r\nX-Evil: yes"),
        )
        for args in invalid:
            with self.subTest(runtime_name=args[1]):
                with self.assertRaises(ValueError) as caught:
                    AgentArtsAdapter(*args)
                self.assertNotIn("TEST_AUTH", str(caught.exception))

        self.assertNotIn("TEST_ONLY_AUTHORIZATION", repr(self.adapter))

        with self.assertRaises(ValueError):
            self.adapter.build_request(["not", "an", "object"])
        with self.assertRaises(ValueError):
            self.adapter.build_request({"query": "hello"}, invoke_mode="other")
        for payload in (
            {"query": {"message": "hello"}},
            {"query": "  "},
            {"query": "hello", "plugin_configs": []},
            {"inputs": []},
            {"query": "hello", "inputs": {}},
            {"query": "hello", "extra": "unsupported"},
            {"plugin_configs": [{"plugin_id": "p", "config": {"header": 4}}], "inputs": {}},
        ):
            with self.subTest(payload=payload):
                with self.assertRaises(ValueError):
                    self.adapter.build_request(payload)

    def test_maps_documented_success_and_null_text(self):
        mapped = self.adapter.map_response(200, {
            "event": "message",
            "data": {"text": "远端返回内容"},
            "createdTime": 1760169416635,
        })
        self.assertEqual(mapped, {"status": "received", "event": "message", "text": "远端返回内容"})
        self.assertEqual(self.adapter.map_response(200, {
            "event": "message", "data": {"text": None}, "createdTime": 1760169416635,
        }), {"status": "received", "event": "message", "text": None})

    def test_maps_documented_http_errors_to_fixed_safe_summaries(self):
        expected = {
            401: ("unauthorized", "AgentArts 拒绝了认证信息"),
            404: ("runtime_not_found", "AgentArts Runtime 不存在或不可用"),
            500: ("remote_error", "AgentArts Runtime 执行失败"),
        }
        for status, (code, summary) in expected.items():
            with self.subTest(status=status):
                with self.assertRaises(AgentArtsResponseError) as caught:
                    self.adapter.map_response(status, {"detail": "SERVER_CANARY TEST_ONLY_AUTHORIZATION"})
                self.assertEqual(caught.exception.code, code)
                self.assertEqual(str(caught.exception), summary)
                self.assertNotIn("CANARY", repr(caught.exception))
                self.assertNotIn("TEST_ONLY_AUTHORIZATION", repr(caught.exception))

    def test_rejects_sse_and_malformed_success_without_trusting_body_text(self):
        with self.assertRaises(AgentArtsResponseError) as caught:
            self.adapter.map_response(200, "data: {\"text\": \"done\"}", content_type="text/event-stream")
        self.assertEqual(caught.exception.code, "unsupported_response")
        with self.assertRaises(AgentArtsResponseError) as caught:
            self.adapter.map_response(200, {"event": "message", "data": {"text": "x"}, "createdTime": 1760169416635}, content_type="text/html")
        self.assertEqual(caught.exception.code, "unsupported_response")
        self.assertEqual(self.adapter.map_response(
            200,
            {"event": "message", "data": {"text": None}, "createdTime": 1760169416635},
            content_type="application/json; charset=utf-8",
        )["text"], None)
        with self.assertRaises(AgentArtsResponseError) as caught:
            self.adapter.map_response(200, {"text": "completed"})
        self.assertEqual(caught.exception.code, "invalid_response")
        self.assertNotIn("completed", str(caught.exception))
        for invalid in (
            {"event": "message", "data": {}, "createdTime": 1760169416635},
            {"event": "message", "data": {"text": None}, "createdTime": "1760169416635"},
            {"event": "message", "data": {"text": None}, "createdTime": True},
        ):
            with self.subTest(invalid=invalid):
                with self.assertRaises(AgentArtsResponseError) as caught:
                    self.adapter.map_response(200, invalid)
                self.assertEqual(caught.exception.code, "invalid_response")

    def test_health_adds_documented_status_and_preserves_legacy_fields(self):
        diagnostics = {
            "status": "ok",
            "dependencies": {
                "agentarts": {"status": "not_configured"},
                "runtime": {"status": "ok"},
            },
            "intent": None,
        }
        with patch("workbench.api.collect_local_diagnostics", return_value=diagnostics):
            response = health(RequestFactory().get("/api/health"))

        self.assertEqual(response.status_code, 200)
        data = json.loads(response.content)
        self.assertEqual(data["execution_mode"], "local_demo")
        self.assertEqual(data["agentarts"], "not_configured")
        self.assertEqual(data["agentarts_status"], {
            "status": "not_configured",
            "evidence": "documented_not_connected",
        })
        self.assertEqual(data["dependencies"]["agentarts"]["status"], "not_configured")

    def test_health_lists_image_and_web_adapters_as_unconfigured_without_network_io(self):
        diagnostics = {
            "status": "ok",
            "dependencies": {
                "agentarts": {"status": "not_configured"},
                "runtime": {"status": "ok"},
            },
            "intent": None,
        }
        with (
            patch("workbench.api.collect_local_diagnostics", return_value=diagnostics),
            patch("socket.create_connection") as connect,
            patch("urllib.request.urlopen") as urlopen,
        ):
            response = health(RequestFactory().get("/api/health"))

        data = json.loads(response.content)
        self.assertEqual(
            data["adapter_capabilities"],
            [
                {
                    "id": "image_generation",
                    "label": "图像生成",
                    "status": "not_configured",
                    "reason": "未配置外部服务",
                },
                {
                    "id": "web_model_bridge",
                    "label": "网页模型桥",
                    "status": "not_configured",
                    "reason": "未配置外部服务",
                },
            ],
        )
        connect.assert_not_called()
        urlopen.assert_not_called()

    def test_registered_extension_is_not_reported_ready_or_invoked_by_health(self):
        class NeverCallImageAdapter:
            def generate(self, request):
                raise AssertionError("health must not invoke adapters")

        class NeverCallWebAdapter:
            def complete(self, request):
                raise AssertionError("health must not invoke adapters")

        registry = AdapterRegistry(
            image_generation=NeverCallImageAdapter(),
            web_model_bridge=NeverCallWebAdapter(),
        )

        self.assertEqual(
            [item["status"] for item in registry.safe_capabilities()],
            ["configured_unverified", "configured_unverified"],
        )
