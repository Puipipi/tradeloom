from __future__ import annotations

import json
import hashlib
import os
import subprocess
import sys
import threading
from pathlib import Path
from unittest.mock import patch

from django.db import close_old_connections
from django.db import connection
from django.test import Client, TransactionTestCase

from workbench.delivery import service
from workbench.delivery.service import DeliveryConflict, DeliveryGenerationError, DeliveryNotFound, _claim_generation, generate_deliverables, review_delivery_bundle
from workbench.models import ArtifactVersion, EventLog, HumanReview, WorkflowStep

from .test_delivery_service import DeliveryServiceTests


class DeliveryGenerationRecoveryTests(TransactionTestCase):
    """Exercise explicit recovery against the same PostgreSQL-backed fixture as delivery tests."""

    def setUp(self):
        DeliveryServiceTests.setUp(self)

    def tearDown(self):
        DeliveryServiceTests.tearDown(self)

    def claim_running_generation(self, key: str = "generation:original") -> WorkflowStep:
        step, _source, replay = _claim_generation(self.workflow.id, key)
        self.assertFalse(replay)
        return step

    def takeover_payload(self, step: WorkflowStep, **overrides) -> dict[str, str]:
        payload = {
            "expected_step_id": step.id,
            "decision": "outcome_unknown",
            "idempotency_key": "takeover:operator:1",
            "operator_label": "local operator",
            "note": "Process exit confirmed; external result remains unknown.",
        }
        payload.update(overrides)
        return payload

    @staticmethod
    def directory_hashes(directory: Path) -> dict[str, str]:
        return {
            item.name: hashlib.sha256(item.read_bytes()).hexdigest()
            for item in sorted(directory.iterdir())
            if item.is_file()
        }

    def hard_exit_worker(self, crash_at: str, key: str = "generation:child") -> int:
        test_database = connection.settings_dict["NAME"]
        self.assertTrue(test_database.startswith("tradeloom_test_"))
        environment = os.environ.copy()
        environment.update(
            {
                "DJANGO_SETTINGS_MODULE": "config.settings",
                "TRADELOOM_DB_NAME": test_database,
                "TRADELOOM_DB_TEST_NAME": test_database,
                "EXPECTED_TEST_DATABASE": test_database,
                "GENERATION_RECOVERY_WORKFLOW_ID": self.workflow.id,
                "GENERATION_RECOVERY_IDEMPOTENCY_KEY": key,
                "GENERATION_RECOVERY_CRASH_AT": crash_at,
                "TRADELOOM_MEDIA_ROOT": str(self.media),
                "TRADELOOM_ARTIFACT_ROOT": str(self.artifacts),
            }
        )
        completed = subprocess.run(
            [sys.executable, "-m", "workbench.tests.generation_recovery_worker"],
            cwd=Path(__file__).resolve().parents[2],
            env=environment,
            capture_output=True,
            text=True,
            timeout=45,
            check=False,
        )
        self.assertEqual(completed.returncode, 86, completed.stderr)
        return completed.returncode

    def test_generation_worker_rejects_database_identity_mismatch_before_work(self):
        test_database = connection.settings_dict["NAME"]
        self.assertTrue(test_database.startswith("tradeloom_test_"))
        environment = os.environ.copy()
        environment.update(
            {
                "DJANGO_SETTINGS_MODULE": "config.settings",
                "TRADELOOM_DB_NAME": test_database,
                "TRADELOOM_DB_TEST_NAME": test_database,
                "EXPECTED_TEST_DATABASE": "tradeloom_test_wrong_identity",
            }
        )
        completed = subprocess.run(
            [sys.executable, "-m", "workbench.tests.generation_recovery_worker"],
            cwd=Path(__file__).resolve().parents[2],
            env=environment,
            capture_output=True,
            text=True,
            timeout=45,
            check=False,
        )
        self.assertNotEqual(completed.returncode, 0)
        self.assertIn("refused test database identity", completed.stderr)

    def test_takeover_requires_explicit_unknown_decision_and_replays_immutable_receipt(self):
        step = self.claim_running_generation()
        payload = self.takeover_payload(step)
        event_count = EventLog.objects.filter(task=self.workflow).count()

        first = service.take_over_generation(self.workflow.id, **payload)
        step.refresh_from_db()
        self.workflow.refresh_from_db()

        self.assertEqual(step.status, "failed")
        self.assertTrue(step.output_refs["generation_recovery"]["outcome_unknown"])
        self.assertEqual(step.idempotency_key, "generation:original")
        self.assertEqual(self.workflow.status, "failed")
        self.assertEqual(self.workflow.current_step, "generate_deliverables_failed")

        replay = service.take_over_generation(self.workflow.id, **payload)

        self.assertEqual(
            {key: replay[key] for key in first if key != "replayed"},
            {key: first[key] for key in first if key != "replayed"},
        )
        self.assertTrue(replay["replayed"])
        self.assertEqual(EventLog.objects.filter(task=self.workflow).count(), event_count + 2)

    def test_same_takeover_key_with_changed_payload_conflicts_without_side_effect(self):
        step = self.claim_running_generation()
        payload = self.takeover_payload(step)
        service.take_over_generation(self.workflow.id, **payload)
        event_count = EventLog.objects.filter(task=self.workflow).count()
        saved_receipt = WorkflowStep.objects.get(pk=step.id).output_refs.copy()

        with self.assertRaises(DeliveryConflict):
            service.take_over_generation(self.workflow.id, **self.takeover_payload(step, note="changed"))

        self.assertEqual(EventLog.objects.filter(task=self.workflow).count(), event_count)
        self.assertEqual(WorkflowStep.objects.get(pk=step.id).output_refs, saved_receipt)

    def test_api_only_shows_takeover_for_latest_running_generation_and_uses_exact_payload(self):
        step = self.claim_running_generation()
        client = Client()
        page = client.get(f"/workflow-tasks/{self.workflow.id}")
        self.assertEqual(page.status_code, 200)
        self.assertContains(page, "标记结果未知并封存本次尝试")
        self.assertContains(page, step.id)
        payload = self.takeover_payload(step)
        invalid = client.post(
            f"/api/workflow-tasks/{self.workflow.id}/deliverables/{step.id}/takeover",
            data=json.dumps({**payload, "unrecognized": "field"}),
            content_type="application/json",
        )
        self.assertEqual(invalid.status_code, 422)
        self.assertEqual(WorkflowStep.objects.get(pk=step.id).status, "running")
        response = client.post(
            f"/api/workflow-tasks/{self.workflow.id}/deliverables/{step.id}/takeover",
            data=json.dumps(payload),
            content_type="application/json",
        )
        self.assertEqual(response.status_code, 200)
        event_count = EventLog.objects.filter(task=self.workflow).count()
        replay = client.post(
            f"/api/workflow-tasks/{self.workflow.id}/deliverables/{step.id}/takeover",
            data=json.dumps(payload),
            content_type="application/json",
        )
        self.assertEqual(replay.status_code, 200)
        self.assertTrue(replay.json()["replayed"])
        conflict = client.post(
            f"/api/workflow-tasks/{self.workflow.id}/deliverables/{step.id}/takeover",
            data=json.dumps({**payload, "note": "different raw value"}),
            content_type="application/json",
        )
        self.assertEqual(conflict.status_code, 409)
        self.assertEqual(EventLog.objects.filter(task=self.workflow).count(), event_count)

        saved = WorkflowStep.objects.get(pk=step.id).output_refs["generation_recovery"]
        self.assertEqual(saved["outcome_unknown"], True)
        self.assertEqual(saved["takeover_receipts"][payload["idempotency_key"]]["payload"], payload)

        refreshed = client.get(f"/workflow-tasks/{self.workflow.id}")
        self.assertEqual(refreshed.status_code, 200)
        self.assertNotContains(refreshed, "标记结果未知并封存本次尝试")
        self.assertContains(refreshed, "用新幂等键显式重试")

    def test_hard_exit_after_claim_requires_takeover_then_new_key(self):
        self.hard_exit_worker("claim_committed")
        interrupted = WorkflowStep.objects.get(task=self.workflow, step_key="generate_deliverables")
        self.assertEqual(interrupted.status, "running")
        with self.assertRaises(DeliveryConflict):
            generate_deliverables(self.workflow.id, "generation:child")

        payload = self.takeover_payload(interrupted)
        service.take_over_generation(self.workflow.id, **payload)
        generated = generate_deliverables(self.workflow.id, "generation:after-takeover")
        event_count = EventLog.objects.filter(task=self.workflow).count()
        replay = service.take_over_generation(self.workflow.id, **payload)

        self.assertEqual(generated["status"], "completed")
        self.assertNotEqual(generated["step_id"], interrupted.id)
        self.assertEqual(ArtifactVersion.objects.filter(artifact__task=self.workflow).count(), 5)
        self.assertTrue(replay["replayed"])
        self.assertEqual(EventLog.objects.filter(task=self.workflow).count(), event_count)

    def test_hard_exit_with_partial_staging_keeps_orphan_and_retries_in_new_directory(self):
        self.hard_exit_worker("staging_partial")
        interrupted = WorkflowStep.objects.get(task=self.workflow, step_key="generate_deliverables")
        original_directory = self.artifacts / ".staging" / self.workflow.id / interrupted.id
        original_hashes = self.directory_hashes(original_directory)
        self.assertTrue((original_directory / "partial.marker").exists())
        self.assertEqual((original_directory / "catalog.html").read_bytes(), b"incomplete delivery file")
        service.take_over_generation(self.workflow.id, **self.takeover_payload(interrupted))

        generated = generate_deliverables(self.workflow.id, "generation:after-partial")

        self.assertTrue((original_directory / "partial.marker").exists())
        self.assertEqual((original_directory / "catalog.html").read_bytes(), b"incomplete delivery file")
        self.assertEqual(self.directory_hashes(original_directory), original_hashes)
        self.assertNotEqual(generated["step_id"], interrupted.id)
        self.assertEqual(ArtifactVersion.objects.filter(artifact__task=self.workflow).count(), 5)

    def test_hard_exit_after_publish_keeps_unregistered_final_files_private(self):
        self.hard_exit_worker("published_before_registration")
        interrupted = WorkflowStep.objects.get(task=self.workflow, step_key="generate_deliverables")
        original_directory = self.artifacts / self.workflow.id / interrupted.id
        original_hashes = self.directory_hashes(original_directory)
        self.assertTrue(original_directory.is_dir())
        self.assertEqual(ArtifactVersion.objects.filter(artifact__task=self.workflow).count(), 0)
        service.take_over_generation(self.workflow.id, **self.takeover_payload(interrupted))

        generated = generate_deliverables(self.workflow.id, "generation:after-publish")

        self.assertTrue(original_directory.is_dir())
        self.assertEqual(self.directory_hashes(original_directory), original_hashes)
        self.assertNotEqual(generated["step_id"], interrupted.id)
        self.assertEqual(ArtifactVersion.objects.filter(artifact__task=self.workflow).count(), 5)

    def test_hard_exit_after_registration_replays_original_five_versions(self):
        self.hard_exit_worker("registered_before_response")
        interrupted = WorkflowStep.objects.get(task=self.workflow, step_key="generate_deliverables")
        original_ids = list(interrupted.output_refs["artifact_version_ids"])
        self.assertEqual(len(original_ids), 5)

        replay = generate_deliverables(self.workflow.id, "generation:child")

        self.assertTrue(replay["replayed"])
        self.assertEqual(replay["step_id"], interrupted.id)
        self.assertEqual(replay["artifact_version_ids"], original_ids)
        self.assertEqual(ArtifactVersion.objects.filter(artifact__task=self.workflow).count(), 5)

    def test_postgres_takeover_wins_race_with_published_worker_finalization(self):
        published = threading.Event()
        finish = threading.Event()
        worker_errors: list[Exception] = []
        publish = service.publish_staging_directory

        def publish_then_wait(staging, final):
            publish(staging, final)
            published.set()
            if not finish.wait(timeout=20):
                raise TimeoutError("test did not release finalization")

        def generate_in_worker():
            close_old_connections()
            try:
                generate_deliverables(self.workflow.id, "generation:concurrent-worker")
            except Exception as exc:
                worker_errors.append(exc)
            finally:
                close_old_connections()

        with patch("workbench.delivery.service.publish_staging_directory", side_effect=publish_then_wait):
            thread = threading.Thread(target=generate_in_worker)
            thread.start()
            self.assertTrue(published.wait(timeout=20), "worker did not reach published-before-finalize window")
            step = WorkflowStep.objects.get(task=self.workflow, step_key="generate_deliverables")
            payload = self.takeover_payload(
                step,
                idempotency_key="takeover:race",
                note="Takeover committed while worker waited before database registration.",
            )
            response = Client().post(
                f"/api/workflow-tasks/{self.workflow.id}/deliverables/{step.id}/takeover",
                data=json.dumps(payload),
                content_type="application/json",
            )
            self.assertEqual(response.status_code, 200, response.content)
            finish.set()
            thread.join(timeout=25)
        self.assertFalse(thread.is_alive(), "generation worker did not exit")
        self.assertEqual(len(worker_errors), 1)
        self.assertIsInstance(worker_errors[0], DeliveryConflict)
        self.assertEqual(ArtifactVersion.objects.filter(artifact__task=self.workflow).count(), 0)
        self.assertEqual(WorkflowStep.objects.get(pk=step.id).status, "failed")
        self.assertTrue((self.artifacts / self.workflow.id / step.id).is_dir())

    def test_stale_step_and_unresolved_human_review_cannot_be_taken_over(self):
        step = self.claim_running_generation()
        payload = self.takeover_payload(step, expected_step_id="stale-step-id")
        with self.assertRaises(DeliveryConflict):
            service.take_over_generation(self.workflow.id, **payload)
        self.assertEqual(WorkflowStep.objects.get(pk=step.id).status, "running")
        with self.assertRaises(DeliveryNotFound):
            service.take_over_generation("missing-workflow", **self.takeover_payload(step))
        foreign = Client().post(
            f"/api/workflow-tasks/missing-workflow/deliverables/{step.id}/takeover",
            data=json.dumps(self.takeover_payload(step)),
            content_type="application/json",
        )
        self.assertEqual(foreign.status_code, 404)

        HumanReview.objects.create(
            task=self.workflow,
            item_ref="product:pending",
            question="Confirm current source",
            options=[],
            status="submitted",
        )
        with self.assertRaises(DeliveryConflict):
            service.take_over_generation(self.workflow.id, **self.takeover_payload(step))
        self.assertEqual(WorkflowStep.objects.get(pk=step.id).status, "running")

    def test_three_failed_attempts_are_the_round_limit_and_rejection_starts_a_new_round(self):
        for attempt in range(1, 3):
            with patch("workbench.delivery.service._load_product_images", side_effect=RuntimeError("private")):
                with self.assertRaises(DeliveryGenerationError):
                    generate_deliverables(self.workflow.id, f"generation:failed:{attempt}")

        first = generate_deliverables(self.workflow.id, "generation:after-repair")
        review_delivery_bundle(
            self.workflow.id,
            first["step_id"],
            decision="reject",
            reviewer="local operator",
            note="Start a new version round.",
        )
        count_before = WorkflowStep.objects.filter(task=self.workflow, step_key="generate_deliverables").count()
        event_count = EventLog.objects.filter(task=self.workflow).count()
        for attempt in range(1, 4):
            with patch("workbench.delivery.service._load_product_images", side_effect=RuntimeError("private")):
                with self.assertRaises(DeliveryGenerationError):
                    generate_deliverables(self.workflow.id, f"generation:new-round-failed:{attempt}")
        exhausted_event_count = EventLog.objects.filter(task=self.workflow).count()
        with self.assertRaises(DeliveryConflict):
            generate_deliverables(self.workflow.id, "generation:new-round-blocked-fourth")
        self.assertEqual(
            WorkflowStep.objects.filter(task=self.workflow, step_key="generate_deliverables").count(),
            count_before + 3,
        )
        self.assertGreater(exhausted_event_count, event_count)
        self.assertEqual(EventLog.objects.filter(task=self.workflow).count(), exhausted_event_count)
        page = Client().get(f"/workflow-tasks/{self.workflow.id}")
        self.assertContains(page, "本轮 2 次错误重试额度已耗尽")
        self.assertNotContains(page, "错误重试（剩余 0 次）")
        self.assertNotContains(page, "生成交付草稿")

