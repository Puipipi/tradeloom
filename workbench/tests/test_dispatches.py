import json
import os
from unittest.mock import patch

from django.test import TestCase

from workbench.models import BusinessDispatch


class DispatchApiTests(TestCase):
    def setUp(self):
        self.key = "a" * 64
        self.bridge = patch.dict(os.environ, {"TRADELOOM_NATIVE_BRIDGE_KEY": self.key})
        self.bridge.start()
        self.addCleanup(self.bridge.stop)
        self.sender = {"agent_id": "center-agent", "session_id": "center-session", "agent_preset": "tradeloom-center"}
        self.receiver = {"agent_id": "product-agent", "session_id": "product-session", "agent_preset": "tradeloom-product"}

    def post(self, path, payload, key=None):
        return self.client.post(
            path,
            json.dumps(payload),
            content_type="application/json",
            HTTP_X_TRADELOOM_NATIVE_BRIDGE=self.key if key is None else key,
        )

    def create(self, *, kind="action", key="dispatch-1", source="workflow:demo", requirement="Review the product data."):
        return self.post("/api/dispatches", {
            "actor": self.sender,
            "idempotency_key": key,
            "kind": kind,
            "recipient": self.receiver,
            "source": source,
            "requirement": requirement,
        })

    def claim(self, dispatch_id, actor=None):
        return self.post(f"/api/dispatches/{dispatch_id}/claim", {"actor": actor or self.receiver})

    def receipt(self, dispatch_id, actor=None, status="completed", result="Reviewed."):
        return self.post(f"/api/dispatches/{dispatch_id}/receipt", {
            "actor": actor or self.receiver,
            "status": status,
            "result": result,
        })

    def test_bridge_authentication_and_identity_are_required(self):
        self.assertEqual(self.post("/api/dispatches", {}, key="b" * 64).status_code, 403)
        self.assertEqual(self.post("/api/dispatches", {}).status_code, 422)
        self.assertEqual(self.create().status_code, 202)
        response = self.post("/api/dispatches/inbox", {"actor": self.receiver}, key="b" * 64)
        self.assertEqual(response.status_code, 403)
        self.assertEqual(self.post("/api/dispatches/inbox", {}).status_code, 422)

    def test_create_is_queued_and_idempotent_by_sender_session_and_key(self):
        first = self.create()
        replay = self.create()
        conflict = self.create(requirement="A different request.")
        self.assertEqual(first.status_code, 202)
        self.assertEqual(replay.status_code, 200)
        self.assertEqual(first.json()["dispatch"]["id"], replay.json()["dispatch"]["id"])
        self.assertTrue(replay.json()["replayed"])
        self.assertEqual(conflict.status_code, 409)
        self.assertEqual(conflict.json()["code"], "idempotency_conflict")
        self.assertEqual(BusinessDispatch.objects.count(), 1)
        self.assertEqual(first.json()["dispatch"]["status"], "queued")
        self.assertEqual(first.json()["dispatch"]["delivery_result"]["state"], "queued")

    def test_same_session_but_different_agent_cannot_replay_another_senders_dispatch(self):
        self.assertEqual(self.create().status_code, 202)
        other_actor = {**self.sender, "agent_id": "different-agent"}
        response = self.post("/api/dispatches", {
            "actor": other_actor,
            "idempotency_key": "dispatch-1",
            "kind": "action",
            "recipient": self.receiver,
            "source": "workflow:demo",
            "requirement": "Review the product data.",
        })
        self.assertEqual(response.status_code, 403)
        self.assertEqual(response.json()["code"], "dispatch_sender_conflict")
        self.assertEqual(BusinessDispatch.objects.count(), 1)

    def test_inbox_outbox_are_scoped_and_busy_claim_stays_queued(self):
        first = self.create(key="one").json()["dispatch"]
        second = self.create(key="two").json()["dispatch"]
        outbox = self.post("/api/dispatches/inbox", {"actor": self.sender, "view": "outbox"})
        inbox = self.post("/api/dispatches/inbox", {"actor": self.receiver, "view": "inbox"})
        self.assertEqual(len(outbox.json()["items"]), 2)
        self.assertEqual(len(inbox.json()["items"]), 2)
        wrong_actor = self.claim(first["id"], {**self.receiver, "session_id": "other-session"})
        self.assertEqual(wrong_actor.status_code, 403)
        claimed = self.claim(first["id"])
        busy = self.claim(second["id"])
        self.assertEqual(claimed.status_code, 200)
        self.assertEqual(claimed.json()["dispatch"]["status"], "claimed")
        self.assertEqual(busy.status_code, 200)
        self.assertEqual(busy.json()["result"], "busy")
        second_record = BusinessDispatch.objects.get(pk=second["id"])
        self.assertEqual(second_record.status, "queued")

    def test_receipt_only_closes_its_action_and_identical_retry_is_idempotent(self):
        first = self.create(key="one").json()["dispatch"]
        second = self.create(key="two").json()["dispatch"]
        self.assertEqual(self.claim(first["id"]).status_code, 200)
        wrong_actor = self.receipt(first["id"], actor={**self.receiver, "agent_id": "other-agent"})
        self.assertEqual(wrong_actor.status_code, 403)
        completed = self.receipt(first["id"])
        replay = self.receipt(first["id"])
        conflict = self.receipt(first["id"], result="Changed result.")
        self.assertEqual(completed.status_code, 200)
        self.assertTrue(replay.json()["replayed"])
        self.assertEqual(conflict.status_code, 409)
        second_record = BusinessDispatch.objects.get(pk=second["id"])
        self.assertEqual(second_record.status, "queued")
        self.assertEqual(self.claim(second["id"]).status_code, 200)

    def test_notification_ack_is_distinct_from_action_completion(self):
        notification = self.create(kind="notification").json()["dispatch"]
        response = self.claim(notification["id"])
        self.assertEqual(response.json()["dispatch"]["status"], "acknowledged")
        self.assertEqual(response.json()["dispatch"]["kind"], "notification")
        wrong_kind_receipt = self.receipt(notification["id"], status="completed")
        self.assertEqual(wrong_kind_receipt.status_code, 409)

    def test_inbox_offset_exposes_later_queued_items(self):
        rows = [BusinessDispatch(
            kind=BusinessDispatch.Kind.ACTION,
            status=BusinessDispatch.Status.QUEUED,
            sender_session_id=self.sender["session_id"],
            sender_agent_id=self.sender["agent_id"],
            sender_preset=self.sender["agent_preset"],
            recipient_session_id=self.receiver["session_id"],
            recipient_agent_id=self.receiver["agent_id"],
            recipient_preset=self.receiver["agent_preset"],
            source="workflow:demo",
            requirement="Review.",
            idempotency_key=f"page-{index}",
            request_fingerprint=f"{index:064x}",
            delivery_result={"state": "queued"},
        ) for index in range(101)]
        BusinessDispatch.objects.bulk_create(rows)
        first = self.post("/api/dispatches/inbox", {"actor": self.receiver, "view": "inbox"}).json()
        second = self.post("/api/dispatches/inbox", {"actor": self.receiver, "view": "inbox", "offset": 100}).json()
        self.assertEqual(len(first["items"]), 100)
        self.assertTrue(first["has_more"])
        self.assertEqual(first["next_offset"], 100)
        self.assertEqual(len(second["items"]), 1)
        self.assertFalse(second["has_more"])
        self.assertIsNone(second["next_offset"])

    def test_bad_shape_or_actor_spoof_is_rejected_without_writes(self):
        payload = {
            "actor": self.sender,
            "idempotency_key": "bad",
            "kind": "action",
            "recipient": self.receiver,
            "source": "workflow:demo",
            "requirement": "Check.",
            "sender_session_id": "spoofed",
        }
        self.assertEqual(self.post("/api/dispatches", payload).status_code, 422)
        invalid = self.create(kind="scheduler")
        self.assertEqual(invalid.status_code, 422)
        malformed_status = self.receipt("f" * 32, status=[])
        self.assertEqual(malformed_status.status_code, 422)
        self.assertEqual(self.post("/api/dispatches/not-an-id/claim", {"actor": self.receiver}).status_code, 404)
        self.assertEqual(BusinessDispatch.objects.count(), 0)
