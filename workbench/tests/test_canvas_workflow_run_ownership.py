import json
import os
import uuid
from concurrent.futures import ThreadPoolExecutor
from threading import Barrier, Event, local
from time import monotonic, sleep
from unittest.mock import patch as mock_patch
from base64 import urlsafe_b64encode
from datetime import timedelta
from unittest.mock import patch

from django.test import Client, TransactionTestCase
from django.db import connection, transaction
from django.utils import timezone

from workbench.models import CanvasWorkflowRun, CanvasWorkflowRunNamespace
from workbench.canvas_workflow_ownership import (
    MAX_DOMAIN_ENVELOPE_BYTES,
    _domain_size,
    _interrupted_snapshot,
)


class CanvasWorkflowRunOwnershipApiTests(TransactionTestCase):
    reset_sequences = True

    def setUp(self):
        self.bridge_key = "c" * 64
        self.bridge_env = patch.dict(os.environ, {"TRADELOOM_NATIVE_BRIDGE_KEY": self.bridge_key})
        self.bridge_env.start()
        self.addCleanup(self.bridge_env.stop)
        self.client = Client()
        self.url = "/api/canvas-workflow-runs"
        self.namespace, _ = CanvasWorkflowRunNamespace.objects.get_or_create(
            pk=1,
            defaults={"namespace_id": uuid.UUID("d1e6baf0-1c72-4ad6-b27b-9bd1a85a5a70")},
        )

    def post(self, payload):
        return self.client.generic(
            "POST",
            self.url,
            json.dumps(payload, separators=(",", ":")),
            content_type="application/json",
            HTTP_X_TRADELOOM_NATIVE_BRIDGE=self.bridge_key,
        )

    def snapshot(self, *, run_id, revision, title="Synthetic ownership fixture"):
        return {
            "id": str(run_id),
            "workflowId": "ownership-fixture",
            "revision": revision,
            "status": "running",
            "executionMode": "native_dsh",
            "title": title,
            "nodes": {},
            "document": {"id": "ownership-fixture", "version": 1, "nodes": []},
            "events": [],
        }

    def token(self, byte):
        return urlsafe_b64encode(bytes([byte]) * 32).decode("ascii").rstrip("=")

    def action(self, action, **fields):
        return self.post({"protocol": "canvas-run-owner/v1", "action": action,
                          "namespaceId": str(self.namespace.namespace_id), **fields})

    def create_owned(self, *, run_id=None, workflow_id="ownership-fixture", token_byte=1, status="running"):
        run_id = run_id or uuid.uuid4()
        initial = self.snapshot(run_id=run_id, revision=1)
        initial["workflowId"] = workflow_id
        initial["document"]["id"] = workflow_id
        initial["status"] = status
        owner_id = uuid.uuid4()
        token = self.token(token_byte)
        response = self.action("create_owned", runId=str(run_id), ownerId=str(owner_id),
                               ownerToken=token, snapshot=initial)
        self.assertEqual(response.status_code, 201, response.content)
        return run_id, owner_id, token, initial, response.json()

    def proof(self, run_id, owner_id, token, epoch="1"):
        return {"runId": str(run_id), "ownerId": str(owner_id),
                "ownerEpoch": epoch, "ownerToken": token}

    def test_ownerless_legacy_run_cannot_be_mutated_by_owner_action_without_proof(self):
        run_id = uuid.UUID("4f2a4d27-7d20-45ec-9475-734b9ab2ee03")
        before = self.snapshot(run_id=run_id, revision=1)
        CanvasWorkflowRun.objects.create(
            id=run_id,
            workflow_id="ownership-fixture",
            revision=1,
            status="running",
            execution_mode="native_dsh",
            snapshot=before,
        )

        response = self.post({
            "protocol": "canvas-run-owner/v1",
            "action": "save_owned",
            "namespaceId": str(self.namespace.namespace_id),
            "runId": str(run_id),
            "ownerId": str(uuid.uuid4()),
            "ownerEpoch": "1",
            "ownerToken": "A" * 43,
            "expectedRevision": 1,
            "snapshot": self.snapshot(run_id=run_id, revision=2, title="must not be written"),
        })

        self.assertEqual(response.status_code, 409)
        self.assertEqual(response.json(), {"error_code": "legacy_unmanaged"})
        persisted = CanvasWorkflowRun.objects.get(pk=run_id)
        self.assertEqual(persisted.revision, 1)
        self.assertEqual(persisted.snapshot, before)
        self.assertIsNone(persisted.owner_id)
        self.assertIsNone(persisted.owner_token_hash)

    def test_namespace_descriptor_is_server_owned_and_returns_signed_initial_cursor(self):
        response = self.client.get(
            self.url + "?action=owner_namespace",
            HTTP_X_TRADELOOM_NATIVE_BRIDGE=self.bridge_key,
        )
        self.assertEqual(response.status_code, 200)
        body = response.json()
        self.assertEqual(body["protocol"], "canvas-run-owner/v1")
        self.assertEqual(body["namespaceId"], str(self.namespace.namespace_id))
        self.assertEqual(body["leaseTtlMs"], 120000)
        self.assertEqual(body["renewAfterMs"], 40000)
        self.assertTrue(body["recoveryCursor"])
        self.assertEqual(len(response.content), len(response.content.decode("utf-8").encode("utf-8")))

    def test_owner_state_get_returns_managed_identity_as_json(self):
        run_id, owner_id, _, _, _ = self.create_owned()
        response = self.client.get(
            self.url + f"?action=owner_run&id={run_id}&namespaceId={self.namespace.namespace_id}",
            HTTP_X_TRADELOOM_NATIVE_BRIDGE=self.bridge_key,
        )
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["protocol"], "canvas-run-owner/v1")
        self.assertEqual(response.json()["runId"], str(run_id))
        self.assertEqual(response.json()["ownerId"], str(owner_id))
        self.assertEqual(response.json()["ownerEpoch"], "1")
        self.assertTrue(response.json()["active"])

    def test_create_retry_reconciles_advanced_row_without_replaying_and_binds_fingerprint(self):
        run_id, owner_id, token, initial, created = self.create_owned()
        self.assertNotIn(token.encode("ascii"), json.dumps(created).encode("utf-8"))
        proof = self.proof(run_id, owner_id, token)
        advanced = self.snapshot(run_id=run_id, revision=2, title="advanced")
        saved = self.action("save_owned", **proof, expectedRevision=1, snapshot=advanced)
        self.assertEqual(saved.status_code, 200, saved.content)
        retry = self.action("create_owned", runId=str(run_id), ownerId=str(owner_id),
                            ownerToken=token, snapshot=initial)
        self.assertEqual(retry.status_code, 200, retry.content)
        self.assertTrue(retry.json()["alreadyAdvanced"])
        self.assertEqual(retry.json()["snapshot"]["revision"], 2)
        changed = {**initial, "title": "different frozen input"}
        conflict = self.action("create_owned", runId=str(run_id), ownerId=str(owner_id),
                               ownerToken=token, snapshot=changed)
        self.assertEqual(conflict.status_code, 409)
        self.assertEqual(conflict.json()["error_code"], "owner_conflict")
        self.assertEqual(CanvasWorkflowRun.objects.get(pk=run_id).revision, 2)

    def test_save_checks_snapshot_run_identity_renew_does_not_change_revision_and_release_is_idempotent(self):
        run_id, owner_id, token, _, _ = self.create_owned()
        proof = self.proof(run_id, owner_id, token)
        before = CanvasWorkflowRun.objects.get(pk=run_id)
        valid_next = self.snapshot(run_id=run_id, revision=2)
        for wrong_proof in (
            {**proof, "namespaceId": str(uuid.uuid4())},
            {**proof, "ownerToken": self.token(33)},
            {**proof, "ownerEpoch": "2"},
        ):
            rejected = self.action("save_owned", **wrong_proof, expectedRevision=1, snapshot=valid_next)
            self.assertEqual(rejected.status_code, 409, rejected.content)
            self.assertEqual(rejected.json()["error_code"], "owner_fenced")
        unchanged = CanvasWorkflowRun.objects.get(pk=run_id)
        self.assertEqual(unchanged.revision, before.revision)
        self.assertEqual(unchanged.snapshot, before.snapshot)
        wrong = self.snapshot(run_id=uuid.uuid4(), revision=2)
        mismatch = self.action("save_owned", **proof, expectedRevision=1, snapshot=wrong)
        self.assertEqual(mismatch.status_code, 400)
        self.assertEqual(mismatch.json()["error_code"], "invalid_snapshot")
        renewed = self.action("renew_owned", **proof)
        self.assertEqual(renewed.status_code, 200, renewed.content)
        self.assertEqual(CanvasWorkflowRun.objects.get(pk=run_id).revision, before.revision)
        row = CanvasWorkflowRun.objects.get(pk=run_id)
        row.owner_lease_expires_at = timezone.now() - timedelta(seconds=1)
        row.save(update_fields=["owner_lease_expires_at"])
        expired_release = self.action("release_owned", **proof)
        self.assertEqual(expired_release.status_code, 409)
        self.assertEqual(expired_release.json()["error_code"], "owner_fenced")
        row.refresh_from_db()
        self.assertIsNone(row.owner_released_at)
        self.assertEqual(row.revision, 1)
        row.owner_lease_expires_at = timezone.now() + timedelta(minutes=1)
        row.save(update_fields=["owner_lease_expires_at"])
        release = self.action("release_owned", **proof)
        repeated = self.action("release_owned", **proof)
        self.assertEqual(release.status_code, 200, release.content)
        self.assertEqual(repeated.status_code, 200, repeated.content)
        rejected = self.action("renew_owned", **proof)
        self.assertEqual(rejected.status_code, 409)
        self.assertEqual(rejected.json()["error_code"], "owner_fenced")
        stored = CanvasWorkflowRun.objects.get(pk=run_id)
        self.assertEqual(stored.revision, 1)
        self.assertIsNotNone(stored.owner_released_at)

    def test_claim_rejects_running_and_new_epoch_does_not_accept_old_proof(self):
        run_id, owner_id, token, _, _ = self.create_owned()
        running_claim = self.action("claim_resumed", runId=str(run_id), expectedRevision=1,
                                    expectedOwnerEpoch="1", ownerId=str(uuid.uuid4()),
                                    ownerToken=self.token(2))
        self.assertEqual(running_claim.status_code, 409)
        self.assertEqual(running_claim.json()["error_code"], "owner_conflict")
        row = CanvasWorkflowRun.objects.get(pk=run_id)
        row.status = "interrupted"
        row.snapshot = {**row.snapshot, "status": "interrupted", "revision": 2}
        row.revision = 2
        row.owner_lease_expires_at = timezone.now() - timedelta(seconds=5)
        row.owner_fenced_at = timezone.now() - timedelta(seconds=5)
        row.save()
        fresh_owner = uuid.uuid4()
        fresh_token = self.token(3)
        claimed = self.action("claim_resumed", runId=str(run_id), expectedRevision=2,
                              expectedOwnerEpoch="1", ownerId=str(fresh_owner), ownerToken=fresh_token)
        self.assertEqual(claimed.status_code, 200, claimed.content)
        self.assertEqual(claimed.json()["ownerEpoch"], "2")
        self.assertIsNone(CanvasWorkflowRun.objects.get(pk=run_id).owner_fenced_at)
        latest = {**claimed.json()["snapshot"], "revision": 3, "status": "running"}
        late = self.action("save_owned", **self.proof(run_id, owner_id, token),
                           expectedRevision=2, snapshot=latest)
        self.assertEqual(late.status_code, 409)
        self.assertEqual(late.json()["error_code"], "owner_fenced")
        persisted = CanvasWorkflowRun.objects.get(pk=run_id)
        self.assertEqual(persisted.owner_epoch, 2)
        self.assertEqual(persisted.revision, 2)

    def test_recovery_fences_expired_owner_once_without_fabricating_child_terminal(self):
        run_id, _, _, _, _ = self.create_owned()
        row = CanvasWorkflowRun.objects.get(pk=run_id)
        row.snapshot = {
            **row.snapshot,
            "parentAgentId": "parent-synthetic",
            "sessionId": "session-synthetic",
            "bindingRevision": 3,
            "definitionRevision": "sha256:" + "a" * 64,
            "document": {"id": "ownership-fixture", "version": 1,
                         "nodes": [{"id": "agent-1", "kind": "agent"}]},
            "nodes": {"agent-1": {"status": "running", "attempt": 1,
                                    "attemptState": "running", "requestId": "req-synthetic",
                                    "toolCallId": "call-synthetic", "childId": "child-synthetic",
                                    "nativeRunId": "native-synthetic", "events": []}},
        }
        row.owner_lease_expires_at = timezone.now() - timedelta(seconds=10)
        row.save()
        descriptor = self.client.get(self.url + "?action=owner_namespace",
                                     HTTP_X_TRADELOOM_NATIVE_BRIDGE=self.bridge_key).json()
        cursor = descriptor["recoveryCursor"]
        body = {"protocol": "canvas-run-owner/v1", "action": "recover_expired",
                "namespaceId": descriptor["namespaceId"], "cursor": cursor}
        response = self.post(body)
        self.assertEqual(response.status_code, 200, response.content)
        item = response.json()["item"]
        self.assertEqual(item["kind"], "recovered")
        self.assertEqual(item["snapshot"]["status"], "interrupted")
        self.assertEqual(item["snapshot"]["revision"], 2)
        self.assertEqual(item["snapshot"]["nodes"]["agent-1"]["attempt"], 1)
        self.assertEqual(item["snapshot"]["events"][-1]["errorCategory"], "OWNER_LEASE_EXPIRED")
        self.assertFalse(any(event.get("type") == "subagent/end" for event in item["snapshot"]["events"]))
        persisted = CanvasWorkflowRun.objects.get(pk=run_id)
        self.assertEqual(persisted.owner_epoch, 2)
        fresh_owner = uuid.uuid4()
        claimed = self.action("claim_resumed", runId=str(run_id), expectedRevision=2,
                              expectedOwnerEpoch="2", ownerId=str(fresh_owner), ownerToken=self.token(44))
        self.assertEqual(claimed.status_code, 200, claimed.content)
        self.assertEqual(claimed.json()["ownerEpoch"], "3")
        after_claim = CanvasWorkflowRun.objects.get(pk=run_id)
        self.assertIsNone(after_claim.owner_fenced_at)
        replay_after_claim = self.post(body)
        self.assertEqual(replay_after_claim.status_code, 200, replay_after_claim.content)
        self.assertIsNone(replay_after_claim.json()["item"])
        self.assertTrue(replay_after_claim.json()["complete"])
        after_replay = CanvasWorkflowRun.objects.get(pk=run_id)
        self.assertEqual(after_replay.owner_epoch, 3)
        self.assertEqual(after_replay.revision, 2)
        self.assertEqual(after_replay.snapshot, after_claim.snapshot)
        self.assertEqual(after_replay.owner_id, fresh_owner)
        replay = self.post(body)
        self.assertEqual(replay.status_code, 200, replay.content)
        self.assertIsNone(replay.json()["item"])
        self.assertTrue(replay.json()["complete"])
        self.assertEqual(CanvasWorkflowRun.objects.get(pk=run_id).revision, 2)

    def test_recovery_pages_over_one_hundred_owned_rows_without_skipping(self):
        owned = []
        for index in range(101):
            run_id, owner_id, token, _, _ = self.create_owned(
                workflow_id=f"ownership-page-{index:03d}", token_byte=(index % 200) + 1
            )
            owned.append((run_id, owner_id, token))
        CanvasWorkflowRun.objects.filter(pk__in=[row[0] for row in owned]).update(
            owner_lease_expires_at=timezone.now() - timedelta(seconds=1)
        )

        descriptor = self.client.get(
            self.url + "?action=owner_namespace",
            HTTP_X_TRADELOOM_NATIVE_BRIDGE=self.bridge_key,
        ).json()
        cursor = descriptor["recoveryCursor"]
        seen = set()
        while True:
            response = self.action("recover_expired", cursor=cursor)
            self.assertEqual(response.status_code, 200, response.content)
            page = response.json()
            item = page["item"]
            if item is not None:
                self.assertEqual(item["kind"], "recovered")
                recovered_id = item["snapshot"]["id"]
                self.assertNotIn(recovered_id, seen)
                seen.add(recovered_id)
            self.assertLessEqual(len(response.content), 2 * 1024 * 1024 + 16 * 1024)
            cursor = page["nextCursor"]
            if page["complete"]:
                break

        self.assertEqual(seen, {str(row[0]) for row in owned})
        self.assertEqual(CanvasWorkflowRun.objects.filter(pk__in=[row[0] for row in owned], status="interrupted").count(), 101)

    def test_expired_recovery_only_fences_that_owner_and_serializes_with_renew(self):
        expired_id, _, expired_token, _, _ = self.create_owned(workflow_id="expired-owner")
        live_id, live_owner, live_token, _, _ = self.create_owned(workflow_id="live-owner", token_byte=9)
        CanvasWorkflowRun.objects.filter(pk=expired_id).update(
            owner_lease_expires_at=timezone.now() - timedelta(seconds=1)
        )
        descriptor = self.client.get(
            self.url + "?action=owner_namespace",
            HTTP_X_TRADELOOM_NATIVE_BRIDGE=self.bridge_key,
        ).json()
        renew_payload = {"protocol": "canvas-run-owner/v1", "action": "renew_owned",
                         "namespaceId": descriptor["namespaceId"],
                         **self.proof(expired_id, CanvasWorkflowRun.objects.get(pk=expired_id).owner_id, expired_token)}
        recover_payload = {"protocol": "canvas-run-owner/v1", "action": "recover_expired",
                           "namespaceId": descriptor["namespaceId"], "cursor": descriptor["recoveryCursor"]}
        barrier = Barrier(3)

        def post_after_barrier(payload):
            client = Client()
            barrier.wait(timeout=10)
            return client.generic(
                "POST", self.url, json.dumps(payload, separators=(",", ":")),
                content_type="application/json",
                HTTP_X_TRADELOOM_NATIVE_BRIDGE=self.bridge_key,
            )

        with ThreadPoolExecutor(max_workers=2) as pool:
            renew_future = pool.submit(post_after_barrier, renew_payload)
            recover_future = pool.submit(post_after_barrier, recover_payload)
            barrier.wait(timeout=10)
            renewed = renew_future.result(timeout=20)
            recovered = recover_future.result(timeout=20)

        self.assertEqual(renewed.status_code, 409, renewed.content)
        self.assertEqual(renewed.json()["error_code"], "owner_fenced")
        self.assertEqual(recovered.status_code, 200, recovered.content)
        self.assertEqual(recovered.json()["item"]["snapshot"]["id"], str(expired_id))
        expired = CanvasWorkflowRun.objects.get(pk=expired_id)
        live = CanvasWorkflowRun.objects.get(pk=live_id)
        self.assertEqual(expired.status, "interrupted")
        self.assertEqual(expired.owner_epoch, 2)
        self.assertEqual(live.status, "running")
        self.assertEqual(live.owner_id, live_owner)
        self.assertEqual(live.owner_epoch, 1)
        self.assertIsNotNone(live.owner_lease_expires_at)

    def test_recovery_rechecks_after_waiting_for_successful_renewal_row_lock(self):
        run_id, owner_id, token, _, _ = self.create_owned(workflow_id="renew-before-recovery")
        row = CanvasWorkflowRun.objects.get(pk=run_id)
        row.owner_lease_expires_at = timezone.now() + timedelta(seconds=1)
        row.save(update_fields=["owner_lease_expires_at"])
        original_expiry = row.owner_lease_expires_at
        renewed_write = Event()
        release_renew = Event()
        candidate_selected = Event()
        thread_state = local()
        original_save = CanvasWorkflowRun.save

        def delayed_renew_save(instance, *args, **kwargs):
            result = original_save(instance, *args, **kwargs)
            fields = kwargs.get("update_fields") or ()
            if getattr(thread_state, "hold_renew", False) and "owner_lease_expires_at" in fields:
                renewed_write.set()
                if not release_renew.wait(timeout=10):
                    raise AssertionError("renew transaction was not released")
            return result

        from workbench import canvas_workflow_ownership

        original_candidates = canvas_workflow_ownership._recovery_candidates

        def observe_selected(namespace_id, cutoff, last_id, using):
            candidate = original_candidates(namespace_id, cutoff, last_id, using)
            if getattr(thread_state, "is_recovery", False) and candidate is not None:
                candidate_selected.set()
            return candidate

        renew_payload = {"protocol": "canvas-run-owner/v1", "action": "renew_owned",
                         "namespaceId": str(self.namespace.namespace_id),
                         **self.proof(run_id, owner_id, token)}
        with ThreadPoolExecutor(max_workers=2) as pool, \
                mock_patch.object(CanvasWorkflowRun, "save", delayed_renew_save), \
                mock_patch.object(canvas_workflow_ownership, "_recovery_candidates", observe_selected):
            def renew_request():
                thread_state.hold_renew = True
                client = Client()
                return client.generic(
                    "POST", self.url, json.dumps(renew_payload, separators=(",", ":")),
                    content_type="application/json",
                    HTTP_X_TRADELOOM_NATIVE_BRIDGE=self.bridge_key,
                )

            renew_future = pool.submit(renew_request)
            self.assertTrue(renewed_write.wait(timeout=10), "renew did not acquire and update the run row")

            deadline = monotonic() + 10
            while True:
                with connection.cursor() as cursor:
                    cursor.execute("SELECT clock_timestamp()")
                    db_now = cursor.fetchone()[0]
                if db_now >= original_expiry:
                    break
                if monotonic() >= deadline:
                    self.fail("database clock did not reach the original lease expiry")
                sleep(0.005)

            descriptor = self.client.get(self.url + "?action=owner_namespace",
                                         HTTP_X_TRADELOOM_NATIVE_BRIDGE=self.bridge_key).json()
            recovery_payload = {"protocol": "canvas-run-owner/v1", "action": "recover_expired",
                                "namespaceId": descriptor["namespaceId"],
                                "cursor": descriptor["recoveryCursor"]}

            def recover_request():
                thread_state.is_recovery = True
                from django.db import connection
                with connection.cursor() as cursor:
                    cursor.execute("SET application_name = 'o09-owner-recovery-lock-test'")
                client = Client()
                return client.generic(
                    "POST", self.url, json.dumps(recovery_payload, separators=(",", ":")),
                    content_type="application/json",
                    HTTP_X_TRADELOOM_NATIVE_BRIDGE=self.bridge_key,
                )

            recovery_future = pool.submit(recover_request)
            self.assertTrue(candidate_selected.wait(timeout=10), "recovery did not select the expired candidate")
            deadline = monotonic() + 10
            waiting_for_row_lock = False
            while monotonic() < deadline:
                with connection.cursor() as cursor:
                    cursor.execute(
                        "SELECT 1 FROM pg_stat_activity WHERE application_name = %s "
                        "AND wait_event_type = 'Lock' AND state = 'active' LIMIT 1",
                        ["o09-owner-recovery-lock-test"],
                    )
                    waiting_for_row_lock = cursor.fetchone() is not None
                if waiting_for_row_lock:
                    break
                sleep(0.005)
            self.assertTrue(waiting_for_row_lock, "recovery did not wait on the renewal row lock")
            release_renew.set()
            renewed = renew_future.result(timeout=10)
            recovered = recovery_future.result(timeout=10)

        self.assertEqual(renewed.status_code, 200, renewed.content)
        self.assertEqual(recovered.status_code, 200, recovered.content)
        self.assertEqual(recovered.json()["item"]["kind"], "unmanaged")
        self.assertEqual(recovered.json()["item"]["reason"], "not_recoverable")
        stored = CanvasWorkflowRun.objects.get(pk=run_id)
        self.assertEqual(stored.status, "running")
        self.assertEqual(stored.revision, 1)
        self.assertEqual(stored.owner_epoch, 1)
        self.assertGreater(stored.owner_lease_expires_at, original_expiry)

    def test_oversized_recovery_candidate_is_rejected_without_mutating_the_run(self):
        run_id = uuid.uuid4()
        workflow_id = "oversized-recovery"
        owner_id = uuid.uuid4()
        token = self.token(21)
        snapshot = self.snapshot(run_id=run_id, revision=1)
        snapshot["workflowId"] = workflow_id
        snapshot["document"]["id"] = workflow_id
        base_size = _domain_size(snapshot, 0)
        snapshot["padding"] = "x" * (MAX_DOMAIN_ENVELOPE_BYTES - base_size - 200)
        self.assertLessEqual(_domain_size(snapshot, 0), MAX_DOMAIN_ENVELOPE_BYTES)
        recovery_candidate = _interrupted_snapshot(snapshot, timezone.now(), 2)
        self.assertGreater(_domain_size(recovery_candidate, 1), MAX_DOMAIN_ENVELOPE_BYTES)

        created = self.action("create_owned", runId=str(run_id), ownerId=str(owner_id),
                              ownerToken=token, snapshot=snapshot)
        self.assertEqual(created.status_code, 201, created.content)
        CanvasWorkflowRun.objects.filter(pk=run_id).update(
            owner_lease_expires_at=timezone.now() - timedelta(seconds=1)
        )
        before = CanvasWorkflowRun.objects.get(pk=run_id)
        descriptor = self.client.get(self.url + "?action=owner_namespace",
                                     HTTP_X_TRADELOOM_NATIVE_BRIDGE=self.bridge_key).json()
        rejected = self.action("recover_expired", cursor=descriptor["recoveryCursor"])
        self.assertEqual(rejected.status_code, 413, rejected.content)
        self.assertEqual(rejected.json()["error_code"], "recovery_response_too_large")
        after = CanvasWorkflowRun.objects.get(pk=run_id)
        self.assertEqual(after.status, before.status)
        self.assertEqual(after.revision, before.revision)
        self.assertEqual(after.snapshot, before.snapshot)
        self.assertEqual(after.owner_epoch, before.owner_epoch)
        self.assertEqual(after.owner_token_hash, before.owner_token_hash)
        self.assertIsNone(after.owner_fenced_at)

    def test_two_concurrent_saves_of_one_revision_commit_only_one_cas_winner(self):
        run_id, owner_id, token, _, _ = self.create_owned(workflow_id="same-row-cas")
        barrier = Barrier(3)
        payloads = []
        for title in ("CAS contender A", "CAS contender B"):
            payloads.append({
                "protocol": "canvas-run-owner/v1", "action": "save_owned",
                "namespaceId": str(self.namespace.namespace_id),
                **self.proof(run_id, owner_id, token),
                "expectedRevision": 1,
                "snapshot": {**self.snapshot(run_id=run_id, revision=2, title=title),
                             "workflowId": "same-row-cas",
                             "document": {"id": "same-row-cas", "version": 1, "nodes": []}},
            })

        def contender(payload):
            client = Client()
            barrier.wait(timeout=10)
            return client.generic(
                "POST", self.url, json.dumps(payload, separators=(",", ":")),
                content_type="application/json",
                HTTP_X_TRADELOOM_NATIVE_BRIDGE=self.bridge_key,
            )

        with ThreadPoolExecutor(max_workers=2) as pool:
            futures = [pool.submit(contender, payload) for payload in payloads]
            barrier.wait(timeout=10)
            results = [future.result(timeout=20) for future in futures]

        self.assertEqual(sorted(response.status_code for response in results), [200, 409])
        conflict = next(response for response in results if response.status_code == 409)
        self.assertEqual(conflict.json()["error_code"], "revision_conflict")
        stored = CanvasWorkflowRun.objects.get(pk=run_id)
        self.assertEqual(stored.revision, 2)
        self.assertIn(stored.snapshot["title"], {"CAS contender A", "CAS contender B"})

    def test_locked_run_does_not_block_an_independent_workflow_row(self):
        locked_id, _, _, _, _ = self.create_owned(workflow_id="row-lock-holder")
        target_id, target_owner, target_token, _, _ = self.create_owned(workflow_id="independent-row")
        locked = Event()
        release_lock = Event()

        def hold_one_row():
            from django.db import close_old_connections
            close_old_connections()
            try:
                with transaction.atomic():
                    CanvasWorkflowRun.objects.select_for_update().get(pk=locked_id)
                    locked.set()
                    if not release_lock.wait(timeout=10):
                        raise AssertionError("row lock was not released")
            finally:
                close_old_connections()

        with ThreadPoolExecutor(max_workers=2) as pool:
            lock_future = pool.submit(hold_one_row)
            self.assertTrue(locked.wait(timeout=10), "test failed to acquire the first row lock")
            payload = {
                "protocol": "canvas-run-owner/v1", "action": "save_owned",
                "namespaceId": str(self.namespace.namespace_id),
                **self.proof(target_id, target_owner, target_token),
                "expectedRevision": 1,
                "snapshot": {**self.snapshot(run_id=target_id, revision=2, title="independent row committed"),
                             "workflowId": "independent-row",
                             "document": {"id": "independent-row", "version": 1, "nodes": []}},
            }
            save_future = pool.submit(lambda: Client().generic(
                "POST", self.url, json.dumps(payload, separators=(",", ":")),
                content_type="application/json",
                HTTP_X_TRADELOOM_NATIVE_BRIDGE=self.bridge_key,
            ))
            try:
                saved = save_future.result(timeout=10)
            finally:
                release_lock.set()
            lock_future.result(timeout=10)

        self.assertEqual(saved.status_code, 200, saved.content)
        self.assertEqual(CanvasWorkflowRun.objects.get(pk=target_id).revision, 2)
        self.assertEqual(CanvasWorkflowRun.objects.get(pk=locked_id).revision, 1)
