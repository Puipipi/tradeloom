import json
import os
import uuid
from unittest.mock import patch

from django.test import TestCase

from workbench.models import CanvasWorkflowRun


class CanvasRunPersistenceTests(TestCase):
    def setUp(self):
        self.key = "a" * 64
        self.auth = patch.dict(os.environ, {"TRADELOOM_NATIVE_BRIDGE_KEY": self.key})
        self.auth.start()
        self.addCleanup(self.auth.stop)
        self.url = "/api/canvas-workflow-runs"

    def request(self, method="get", payload=None, query="", key=None):
        headers = {"HTTP_X_TRADELOOM_NATIVE_BRIDGE": self.key if key is None else key}
        if method == "get":
            return self.client.get(self.url + query, **headers)
        return self.client.post(self.url, json.dumps(payload), content_type="application/json", **headers)

    def snapshot(self, **extra):
        return {"id": str(uuid.uuid4()), "workflowId": "demo", "title": "Synthetic workflow",
                "executionMode": "native_dsh", "status": "running", "revision": 1,
                "startedAt": "2026-10-25T00:00:00Z", "finishedAt": None,
                "document": {"version": 1, "id": "demo", "nodes": [], "edges": []},
                "nodes": {}, **extra}

    def test_bridge_required_for_read_and_write(self):
        self.assertEqual(self.request(key="wrong").status_code, 403)
        self.assertEqual(self.request("post", {"snapshot": self.snapshot(), "expectedRevision": 0}, key="wrong").status_code, 403)
        self.assertFalse(CanvasWorkflowRun.objects.exists())

    def test_durable_create_cas_update_history_and_no_cross_identity_update(self):
        snap = self.snapshot()
        self.assertEqual(self.request("post", {"snapshot": snap, "expectedRevision": 0}).status_code, 201)
        fresh = self.client_class()
        result = fresh.get(self.url + "?id=" + snap["id"], HTTP_X_TRADELOOM_NATIVE_BRIDGE=self.key)
        self.assertEqual(result.json()["snapshot"], snap)
        changed = {**snap, "revision": 2, "status": "done", "finishedAt": "2026-10-25T00:01:00Z"}
        self.assertEqual(self.request("post", {"snapshot": changed, "expectedRevision": 1}).status_code, 200)
        self.assertEqual(self.request("post", {"snapshot": changed, "expectedRevision": 1}).status_code, 409)
        tampered = {**changed, "revision": 3, "workflowId": "another", "document": {**changed["document"], "id": "another"}}
        self.assertEqual(self.request("post", {"snapshot": tampered, "expectedRevision": 2}).status_code, 409)
        self.assertEqual(self.request(query="?workflow=demo").json()["runs"][0]["status"], "done")

    def test_active_workflow_is_unique_but_finished_history_is_not_evicted(self):
        first = self.snapshot()
        self.assertEqual(self.request("post", {"snapshot": first, "expectedRevision": 0}).status_code, 201)
        self.assertEqual(self.request("post", {"snapshot": self.snapshot(), "expectedRevision": 0}).status_code, 409)
        for index in range(35):
            snap = self.snapshot(status="done", finishedAt="2026-10-25T00:01:00Z")
            self.assertEqual(self.request("post", {"snapshot": snap, "expectedRevision": 0}).status_code, 201)
        self.assertEqual(CanvasWorkflowRun.objects.count(), 36)
        self.assertEqual(len(self.request(query="?workflow=demo").json()["runs"]), 36)

    def test_invalid_identity_and_snapshot_are_rejected(self):
        for snap in [self.snapshot(id="../escape"), self.snapshot(status="fake_success"), self.snapshot(executionMode="unknown"), self.snapshot(revision=True)]:
            self.assertEqual(self.request("post", {"snapshot": snap, "expectedRevision": 0}).status_code, 400)
        self.assertFalse(CanvasWorkflowRun.objects.exists())
