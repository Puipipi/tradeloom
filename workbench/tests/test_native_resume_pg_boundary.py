"""Candidate only: actual journal/PG API, synthetic ack, never official child/HTTP Host."""
import hashlib
import json
import os
from pathlib import Path
import subprocess
from unittest.mock import patch
from django.db import connection
from django.test import TransactionTestCase

ROOT = Path(__file__).resolve().parents[3] / "workspace/testing/native-dag-resume-plan-20261027/slice3/pg-candidate"
INPUT_SHA256 = "0d99589e735ce0a1f35a5a0570ff5dd4a6f1b41ccbb44f77feeac49519701c3b"


class NativeResumePgBoundaryTests(TransactionTestCase):
    def setUp(self):
        self.assertEqual(connection.vendor, "postgresql")
        self.assertEqual(connection.settings_dict["HOST"], "127.0.0.1")
        self.assertEqual(str(connection.settings_dict["PORT"]), "55435")
        self.assertTrue(connection.settings_dict["NAME"].startswith("tradeloom_test_"))
        raw = (ROOT / "reviewed-input.json").read_bytes()
        self.assertEqual(hashlib.sha256(raw).hexdigest(), INPUT_SHA256)
        self.input = json.loads(raw)
        for item in [self.input["node"], self.input["helper"], *self.input["modules"]]:
            self.assertEqual(hashlib.sha256(Path(item["path"]).read_bytes()).hexdigest(), item["sha256"])
        self.key = "c" * 64
        auth = patch.dict(os.environ, {"TRADELOOM_NATIVE_BRIDGE_KEY": self.key})
        auth.start(); self.addCleanup(auth.stop)

    def node(self, body):
        env = {key: os.environ[key] for key in ("SYSTEMROOT", "WINDIR", "TEMP", "TMP", "PATH") if key in os.environ}
        result = subprocess.run([self.input["node"]["path"], self.input["helper"]["path"]], input=json.dumps(body), text=True,
                                capture_output=True, timeout=8, cwd=ROOT, env=env, creationflags=0x08000000)
        self.assertEqual(result.returncode, 0, "reviewed Node candidate failed")
        return json.loads(result.stdout)

    def save(self, generated):
        for index, write in enumerate(generated["writes"]):
            response = self.client.post("/api/canvas-workflow-runs", json.dumps(write), content_type="application/json",
                                        HTTP_X_TRADELOOM_NATIVE_BRIDGE=self.key)
            self.assertEqual(response.status_code, 201 if write["expectedRevision"] == 0 else 200)
            self.assertEqual(response.json()["snapshot"], write["snapshot"])
        connection.close()
        response = self.client.get("/api/canvas-workflow-runs", {"id": generated["snapshot"]["id"]}, HTTP_X_TRADELOOM_NATIVE_BRIDGE=self.key)
        self.assertEqual(response.status_code, 200)
        return response.json()["snapshot"]

    def test_cancel_and_resume_claim_are_persistent_and_replay_never_writes(self):
        generated = self.node({"mode": "generate", "workflowId": "pg-resume-claim"})
        saved = self.save(generated)
        self.assertEqual([row["snapshot"]["events"][-1]["type"] for row in generated["writes"]], ["run-created", "cancel-requested", "resume-claimed"])
        replay = self.node({"mode": "replay", "snapshot": saved, "claim": {
            "operationId": "resume-pg-fixture", "fingerprint": "b" * 64, "expectedRevision": 2, "nodeIds": ["a"]}})
        self.assertTrue(replay["result"]["reused"]); self.assertEqual(replay["writes"], [])
        crashed = self.node({"mode": "recover", "snapshot": saved})
        recovered = self.save(crashed)
        independent = self.node({"mode": "read", "snapshot": recovered})
        self.assertTrue(independent["plan"]["eligible"])
        self.assertEqual(independent["snapshot"]["nodes"]["a"]["attempt"], 0)
        self.assertEqual(independent["writes"], [])

    def test_ack_without_end_stays_blocked_after_new_pg_connection_and_node_reader(self):
        generated = self.node({"mode": "generate", "workflowId": "pg-resume-unknown", "ackThenCrash": True})
        saved = self.save(generated)
        inspected = self.node({"mode": "read", "snapshot": saved})
        self.assertFalse(inspected["plan"]["eligible"])
        rejected = self.node({"mode": "claim-blocked", "snapshot": saved, "claim": {
            "operationId": "must-not-retry", "fingerprint": "d" * 64, "expectedRevision": saved["revision"], "nodeIds": []}})
        self.assertEqual(rejected["result"]["errorCode"], "resume_blocked")
        self.assertEqual(rejected["writes"], [])
        self.assertEqual(rejected["snapshot"], saved)
