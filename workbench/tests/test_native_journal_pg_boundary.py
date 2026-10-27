"""Non-listener PG/API boundary with real JS journal, synthetic child observations.

Not the production HTTP runStore, official child dispatch, model or Host proof.
"""
import hashlib
import json
import os
from pathlib import Path
import subprocess
from unittest.mock import patch

from django.db import connection
from django.test import TransactionTestCase


EVIDENCE_ROOT = Path(__file__).resolve().parents[3] / "workspace/testing/native-journal-pg-boundary-20261027"
MANIFEST_SHA256 = "1b1216e2813d3ae98c11ef44db35488bdcddd9ed124264afb7e566ed085e421c"


class NativeJournalPgBoundaryTests(TransactionTestCase):
    def setUp(self):
        self.assertEqual(connection.vendor, "postgresql")
        self.assertEqual(connection.settings_dict["HOST"], "127.0.0.1")
        self.assertEqual(str(connection.settings_dict["PORT"]), "55435")
        self.assertTrue(connection.settings_dict["NAME"].startswith("tradeloom_test_"))
        raw = (EVIDENCE_ROOT / "reviewed-input.json").read_bytes()
        self.assertEqual(hashlib.sha256(raw).hexdigest(), MANIFEST_SHA256)
        self.manifest = json.loads(raw)
        for item in [self.manifest["node"], *self.manifest["modules"], self.manifest["helper"]]:
            self.assertEqual(hashlib.sha256(Path(item["path"]).read_bytes()).hexdigest(), item["sha256"])
        self.key = "b" * 64  # Synthetic per-process bridge fixture, no user key.
        auth = patch.dict(os.environ, {"TRADELOOM_NATIVE_BRIDGE_KEY": self.key})
        auth.start()
        self.addCleanup(auth.stop)

    def node(self, body, success=True):
        env = {key: os.environ[key] for key in ("SYSTEMROOT", "WINDIR", "TEMP", "TMP", "PATH") if key in os.environ}
        result = subprocess.run([self.manifest["node"]["path"], self.manifest["helper"]["path"]],
                                input=json.dumps(body), text=True, capture_output=True, timeout=8,
                                cwd=EVIDENCE_ROOT, env=env, creationflags=0x08000000)
        if not success:
            self.assertNotEqual(result.returncode, 0)
            return None
        self.assertEqual(result.returncode, 0, "reviewed Node boundary failed")
        return json.loads(result.stdout)

    def save(self, write):
        return self.client.post("/api/canvas-workflow-runs", json.dumps(write), content_type="application/json",
                                HTTP_X_TRADELOOM_NATIVE_BRIDGE=self.key)

    def read(self, run_id):
        # No TestCase outer transaction: API writes commit; read uses a new PG connection.
        connection.close()
        response = self.client.get("/api/canvas-workflow-runs", {"id": run_id}, HTTP_X_TRADELOOM_NATIVE_BRIDGE=self.key)
        self.assertEqual(response.status_code, 200)
        return response.json()["snapshot"]

    def persist(self, generated):
        for index, write in enumerate(generated["writes"]):
            response = self.save(write)
            self.assertEqual(response.status_code, 201 if index == 0 else 200)
            self.assertEqual(response.json()["snapshot"], write["snapshot"])
        return self.read(generated["snapshot"]["id"])

    def test_ack_terminal_cas_and_unknown_artifact_survive_pg_readback(self):
        generated = self.node({"mode": "generate", "workflowId": "boundary-terminal"})
        saved = self.persist(generated)
        self.assertEqual(saved, generated["snapshot"])
        self.assertEqual(saved["status"], "done")
        self.assertTrue(saved["definitionRevision"].startswith("sha256:"))
        self.assertEqual((saved["parentAgentId"], saved["sessionId"]), ("synthetic-parent", "synthetic-session"))
        ack = next(w for w in generated["writes"] if w["snapshot"]["nodes"]["node-a"]["attemptState"] == "acknowledged")
        self.assertLess(ack["snapshot"]["revision"], saved["revision"])
        self.assertEqual(saved["nodes"]["node-a"]["artifactSource"], "unknown")
        self.assertEqual(saved["nodes"]["node-a"]["artifacts"], [])
        self.assertNotIn("artifactEvidence", saved["nodes"]["node-a"])
        # A genuinely new Node process validates the public snapshot from PG/API.
        independent = self.node({"mode": "read", "snapshots": [saved]})
        self.assertEqual(independent["snapshots"], [saved])
        self.assertEqual(independent["writes"], [])
        changed = json.loads(json.dumps(saved)); changed["revision"] += 1
        self.assertEqual(self.save({"snapshot": changed, "expectedRevision": saved["revision"]}).status_code, 409)
        self.assertEqual(self.save(generated["writes"][0]).status_code, 409)
        self.assertEqual(self.read(saved["id"]), saved)

    def test_public_recovery_persists_interrupted_without_dispatch(self):
        generated = self.node({"mode": "generate", "workflowId": "boundary-active", "active": True})
        saved = self.persist(generated)
        self.assertEqual(saved["nodes"]["node-a"]["attemptState"], "acknowledged")
        recovered = self.node({"mode": "recover", "snapshots": [saved]})
        self.assertEqual(len(recovered["writes"]), 1)
        write = recovered["writes"][0]
        self.assertEqual(self.save(write).status_code, 200)
        actual = self.read(saved["id"])
        self.assertEqual(actual["status"], "interrupted")
        self.assertEqual(actual["nodes"]["node-a"]["attempt"], 1)
        self.assertEqual(actual["nodes"]["node-a"]["childId"], "synthetic-child")
        again = self.node({"mode": "recover", "snapshots": [actual]})
        self.assertEqual(again["writes"], [])

    def test_independent_reader_rejects_digest_tamper(self):
        generated = self.node({"mode": "generate", "workflowId": "boundary-digest"})
        saved = self.persist(generated)
        saved["definitionRevision"] = "sha256:" + "0" * 64
        self.node({"mode": "read", "snapshots": [saved]}, success=False)
