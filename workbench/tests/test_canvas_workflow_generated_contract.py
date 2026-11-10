"""Real PostgreSQL/API contract for JS-produced snapshots; no HTTP listener or LLM.

The JS producer uses real service/journal modules and a synthetic child lifecycle.
"""
import copy
import json
import os
from pathlib import Path
from unittest.mock import patch

from django.db import connection
from django.test import TestCase
from workbench.models import CanvasWorkflowRun


class GeneratedCanvasContractTests(TestCase):
    @classmethod
    def setUpTestData(cls):
        cls.bundle = json.loads((Path(__file__).parent / "fixtures" / "canvas-generated-20261026.json").read_text(encoding="utf-8"))

    def setUp(self):
        self.assertEqual(connection.vendor, "postgresql")
        self.key = "b" * 64  # Synthetic test credential; no host key is read.
        auth = patch.dict(os.environ, {"TRADELOOM_NATIVE_BRIDGE_KEY": self.key})
        auth.start()
        self.addCleanup(auth.stop)

    def post(self, payload):
        return self.client.post("/api/canvas-workflow-runs", json.dumps(payload), content_type="application/json", HTTP_X_TRADELOOM_NATIVE_BRIDGE=self.key)

    def read(self, query):
        return self.client.get("/api/canvas-workflow-runs" + query, HTTP_X_TRADELOOM_NATIVE_BRIDGE=self.key)

    def replay(self, sequence):
        for payload in sequence:
            response = self.post(payload)
            self.assertEqual(response.status_code, 201 if payload["expectedRevision"] == 0 else 200, response.content)
            snapshot = payload["snapshot"]
            self.assertEqual(CanvasWorkflowRun.objects.get(pk=snapshot["id"]).snapshot, snapshot)
            self.assertEqual(self.read("?id=" + snapshot["id"]).json()["snapshot"], snapshot)

    def test_generated_attempt_ack_terminal_cas_and_terminal_write_rejection(self):
        sequence = self.bundle["completed"]
        self.assertEqual([p["snapshot"]["events"][-1]["type"] for p in sequence], ["run-created", "attempt-started", "child-ack", "node-terminal"])
        self.replay(sequence[:2])
        # CAS failure while still running, independently of terminal immutability.
        self.assertEqual(self.post(sequence[1]).status_code, 409)
        self.replay(sequence[2:])
        self.assertEqual(self.post(sequence[-1]).status_code, 409)
        terminal = copy.deepcopy(sequence[-1]["snapshot"])
        terminal["revision"] += 1
        self.assertEqual(self.post({"snapshot": terminal, "expectedRevision": terminal["revision"] - 1}).status_code, 409)
        self.assertEqual(CanvasWorkflowRun.objects.count(), 1)
        self.assertEqual(CanvasWorkflowRun.objects.get().snapshot, sequence[-1]["snapshot"])

    def test_generated_active_unique_and_recovery_history_readback(self):
        completed = self.bundle["completed"]
        recovery = self.bundle["recovery"]
        self.replay(completed[:1])
        self.assertEqual(self.post(recovery[0]).status_code, 409)
        self.assertEqual(CanvasWorkflowRun.objects.count(), 1)
        self.replay(completed[1:])
        self.replay(recovery)
        self.assertEqual(CanvasWorkflowRun.objects.count(), 2)
        self.assertEqual(recovery[-1]["snapshot"]["events"][-1]["type"], "run-interrupted")
        history = self.read("?workflow=workflow").json()["runs"]
        self.assertEqual({row["status"] for row in history}, {"done", "interrupted"})
        self.assertEqual({row["id"] for row in history}, {completed[0]["snapshot"]["id"], recovery[0]["snapshot"]["id"]})

    def test_new_source_schema_is_atomic_with_terminal_and_old_v1_stays_unknown(self):
        sequence = self.bundle["artifact"]
        self.assertEqual(len(sequence), 4)
        self.assertEqual([p["snapshot"]["events"][-1]["type"] for p in sequence], ["run-created", "attempt-started", "child-ack", "node-terminal"])
        self.replay(sequence[:3])
        ack_node = CanvasWorkflowRun.objects.get(pk=sequence[0]["snapshot"]["id"]).snapshot["nodes"]["task"]
        self.assertEqual(ack_node["artifactRangeStart"], {"childSessionId": "fixture-child", "nativeRunId": "fixture-epoch", "startInclusive": 4})
        self.assertEqual(ack_node["artifactSource"], "unknown")
        self.assertEqual(ack_node["artifacts"], [])
        self.replay(sequence[3:])
        final = sequence[-1]["snapshot"]
        node = final["nodes"]["task"]
        self.assertEqual(node["artifactEvidence"]["schema"], "tradeloom.presented-evidence/v1")
        self.assertEqual(node["artifactEvidence"]["range"]["endExclusive"], 8)
        self.assertEqual(node["artifacts"], node["artifactEvidence"]["declarations"])
        self.assertEqual(final["events"][-1]["artifactEvidence"], node["artifactEvidence"])
        update = {**final, "revision": 5}
        self.assertEqual(self.post({"snapshot": update, "expectedRevision": 4}).status_code, 409)
        self.assertEqual(CanvasWorkflowRun.objects.get(pk=final["id"]).snapshot, final)
        self.replay(self.bundle["completed"])
        old = self.read("?id=" + self.bundle["completed"][-1]["snapshot"]["id"]).json()["snapshot"]
        self.assertEqual(old["journalSchema"], "tradeloom.native-run-journal/v1")
        self.assertEqual(old["nodes"]["task"]["artifactSource"], "unknown")
        self.assertNotIn("artifactEvidence", old["nodes"]["task"])
