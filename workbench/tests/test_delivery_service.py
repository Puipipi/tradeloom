from __future__ import annotations

import threading
import tempfile
import hashlib
import json
from pathlib import Path
from unittest.mock import patch

from django.db import close_old_connections
from django.test import Client, TransactionTestCase, override_settings
from django.utils import timezone

from workbench.delivery.service import (
    DeliveryConflict,
    DeliveryGenerationError,
    DeliveryQualityError,
    generate_deliverables,
    review_delivery_bundle,
)
from workbench.models import (
    ArtifactVersion,
    EventLog,
    HumanReview,
    Product,
    ProductRevision,
    SubTask,
    Task,
    TaskFile,
    WorkflowStep,
    WorkflowTask,
)
from workbench.workflows.orchestrator import CompletionGateError, WorkflowOrchestrator
from workbench.workflows.prepare import create_prepared_workflow


SVG = b'<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10" fill="#123456"/></svg>'


class DeliveryServiceTests(TransactionTestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.media = self.root / "media"
        self.media.mkdir()
        self.artifacts = self.root / "artifacts"
        self.settings = override_settings(
            MEDIA_ROOT=self.media,
            TRADELOOM_ARTIFACT_ROOT=self.artifacts,
        )
        self.settings.enable()
        now = timezone.now()
        self.batch = Task.objects.create(
            title="Delivery test batch", mode="demo", status="confirmed",
            created_at=now, updated_at=now,
        )
        self.product = Product.objects.create(
            task=self.batch, position=0, sku="SKU-01", name="Ribbon",
            category="trim", material="polyester", size="25mm", color="red",
            image_filename="SKU-01.svg", image_stored_name="SKU-01.svg",
            missing_fields=[], created_at=now, updated_at=now,
        )
        self.image = self.media / "SKU-01.svg"
        self.image.write_bytes(SVG)
        self.task_file = TaskFile.objects.create(
            task=self.batch, kind="image", original_name="SKU-01.svg",
            stored_name="SKU-01.svg", created_at=now,
        )
        self.revision = ProductRevision.objects.create(
            product=self.product, version=1, status="confirmed",
            snapshot={
                "sku": "SKU-01", "name": "Ribbon", "category": "trim",
                "material": "polyester", "size": "25mm", "color": "red",
                "image_filename": "SKU-01.svg", "english_name": "Ribbon",
            },
            source_refs={"image": {"task_file_id": self.task_file.id, "stored_name": self.task_file.stored_name}},
        )
        self.workflow = create_prepared_workflow(
            batch_id=self.batch.id,
            user_goal="Prepare catalog and sample checklist",
        )
        engine = WorkflowOrchestrator()
        product_subtask = SubTask.objects.get(task=self.workflow, agent_role="product_profile")
        delivery_subtask = SubTask.objects.get(task=self.workflow, agent_role="delivery_quality")
        engine.dispatch_subtask(product_subtask.id, f"test:{self.workflow.id}:product")
        engine.dispatch_subtask(delivery_subtask.id, f"test:{self.workflow.id}:delivery")
        self.workflow.refresh_from_db()

    def tearDown(self):
        self.settings.disable()
        self.temp.cleanup()

    def test_generation_replays_exact_bundle_without_new_versions_or_files(self):
        page = Client().get(f"/workflow-tasks/{self.workflow.id}")
        self.assertEqual(page.status_code, 200)
        self.assertContains(page, "生成交付草稿")
        first = generate_deliverables(self.workflow.id, "delivery:test:one")
        self.assertEqual(first["status"], "completed")
        self.assertEqual(ArtifactVersion.objects.filter(artifact__task=self.workflow).count(), 5)
        with self.assertRaises(DeliveryConflict):
            generate_deliverables(self.workflow.id, "delivery:test:premature-next-version")
        self.assertEqual(ArtifactVersion.objects.filter(artifact__task=self.workflow).count(), 5)
        files_before = sorted(path.name for path in (self.artifacts / self.workflow.id / first["step_id"]).iterdir())
        event_count = EventLog.objects.filter(task=self.workflow).count()

        replay = generate_deliverables(self.workflow.id, "delivery:test:one")

        self.assertTrue(replay["replayed"])
        self.assertEqual(replay["step_id"], first["step_id"])
        self.assertEqual(ArtifactVersion.objects.filter(artifact__task=self.workflow).count(), 5)
        self.assertEqual(EventLog.objects.filter(task=self.workflow).count(), event_count)
        metadata = Client().get(f"/api/workflow-tasks/{self.workflow.id}/deliverables")
        self.assertEqual(metadata.status_code, 200)
        self.assertEqual(len(metadata.json()["artifacts"]), 5)
        page = Client().get(f"/workflow-tasks/{self.workflow.id}")
        self.assertEqual(page.status_code, 200)
        self.assertContains(page, "批准交付文件")
        self.assertContains(page, "catalog_html")
        self.assertEqual(files_before, sorted(path.name for path in (self.artifacts / self.workflow.id / first["step_id"]).iterdir()))

    def test_approval_requires_review_stage_and_completion_requires_exact_approval_receipt(self):
        with self.assertRaises(DeliveryConflict):
            review_delivery_bundle(self.workflow.id, "missing", decision="approve", reviewer="local")
        generated = generate_deliverables(self.workflow.id, "delivery:test:review")
        versions = ArtifactVersion.objects.filter(artifact__task=self.workflow)
        ids = sorted(item.id for item in versions)

        # A status flip and quality flag cannot replace the service receipt.
        for version in versions:
            version.status = "approved"
            version.artifact.status = "approved"
            version.artifact.save(update_fields=["status", "updated_at"])
            version.save(update_fields=["status", "updated_at"])
        step = WorkflowStep.objects.get(pk=generated["step_id"])
        step.output_refs["quality_status"] = "passed"
        step.save(update_fields=["output_refs", "updated_at"])
        workflow = WorkflowTask.objects.get(pk=self.workflow.id)
        workflow.status = "running"
        workflow.current_step = "complete_workflow"
        workflow.save(update_fields=["status", "current_step", "updated_at"])
        response = Client().post(f"/api/workflow-tasks/{workflow.id}/complete")
        self.assertEqual(response.status_code, 409)
        with self.assertRaises(CompletionGateError):
            WorkflowOrchestrator().complete_workflow(workflow.id)
        self.assertFalse(EventLog.objects.filter(task=workflow, event_type="workflow_delivery_completed").exists())

        # Restore the state through the real bundle review pathway.
        workflow.status = "waiting_human"
        workflow.current_step = "review_deliverables"
        workflow.save(update_fields=["status", "current_step", "updated_at"])
        for version in versions:
            version.status = "pending_review"
            version.artifact.status = "pending_review"
            version.artifact.save(update_fields=["status", "updated_at"])
            version.save(update_fields=["status", "updated_at"])
        review_delivery_bundle(
            workflow.id, generated["step_id"], decision="approve", reviewer="local QA", note="checked",
        )
        with self.assertRaises(DeliveryConflict):
            generate_deliverables(workflow.id, "delivery:test:approved-new-version")
        self.assertEqual(ArtifactVersion.objects.filter(artifact__task=workflow).count(), 5)
        replay = review_delivery_bundle(
            workflow.id, generated["step_id"], decision="approve", reviewer="local QA", note="checked",
        )
        self.assertTrue(replay["replayed"])
        with self.assertRaises(DeliveryConflict):
            review_delivery_bundle(
                workflow.id, generated["step_id"], decision="reject", reviewer="local QA", note="different",
            )
        receipt = EventLog.objects.get(task=workflow, event_type="delivery_bundle_reviewed")
        self.assertEqual(receipt.payload_summary["refs"]["artifact_version_ids"], ids)
        response = Client().post(f"/api/workflow-tasks/{workflow.id}/complete")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(WorkflowTask.objects.get(pk=workflow.id).status, "completed")

    def test_completion_rejects_new_business_review_and_tampered_file_after_approval(self):
        generated = generate_deliverables(self.workflow.id, "delivery:test:gate")
        review_delivery_bundle(
            self.workflow.id, generated["step_id"], decision="approve", reviewer="local QA",
        )
        workflow = WorkflowTask.objects.get(pk=self.workflow.id)
        workflow.current_step = "complete_workflow"
        workflow.save(update_fields=["current_step", "updated_at"])
        HumanReview.objects.create(
            task=workflow, item_ref="product:test", question="Check source",
            options=[], status="pending",
        )
        response = Client().post(f"/api/workflow-tasks/{workflow.id}/complete")
        self.assertEqual(response.status_code, 409)
        HumanReview.objects.filter(task=workflow).delete()

        version = ArtifactVersion.objects.get(artifact__task=workflow, artifact__artifact_type="catalog_html")
        (self.artifacts / version.file_path).write_bytes(b"tampered after approval")
        response = Client().post(f"/api/workflow-tasks/{workflow.id}/complete")
        self.assertEqual(response.status_code, 409)
        self.assertNotEqual(WorkflowTask.objects.get(pk=workflow.id).status, "completed")

    def test_completion_rejects_a_new_current_revision_after_bundle_approval(self):
        generated = generate_deliverables(self.workflow.id, "delivery:test:source-change")
        review_delivery_bundle(
            self.workflow.id, generated["step_id"], decision="approve", reviewer="local QA",
        )
        ProductRevision.objects.create(
            product=self.product,
            version=2,
            status="confirmed",
            snapshot={**self.revision.snapshot, "color": "blue"},
            source_refs={"image": {"task_file_id": self.task_file.id, "stored_name": self.task_file.stored_name}},
        )
        workflow = WorkflowTask.objects.get(pk=self.workflow.id)
        workflow.current_step = "complete_workflow"
        workflow.save(update_fields=["current_step", "updated_at"])
        response = Client().post(f"/api/workflow-tasks/{workflow.id}/complete")
        self.assertEqual(response.status_code, 409)
        self.assertNotEqual(WorkflowTask.objects.get(pk=workflow.id).status, "completed")

    def test_source_change_after_claim_is_detected_before_artifact_registration(self):
        from workbench.delivery import service

        publish = service.publish_staging_directory

        def publish_then_change_source(staging, final):
            publish(staging, final)
            ProductRevision.objects.create(
                product=self.product,
                version=2,
                status="confirmed",
                snapshot={**self.revision.snapshot, "color": "blue"},
                source_refs={"image": {"task_file_id": self.task_file.id, "stored_name": self.task_file.stored_name}},
            )

        with patch.object(service, "publish_staging_directory", side_effect=publish_then_change_source):
            with self.assertRaises(DeliveryConflict):
                generate_deliverables(self.workflow.id, "delivery:test:source-race")

        self.workflow.refresh_from_db()
        step = WorkflowStep.objects.get(task=self.workflow, step_key="generate_deliverables")
        self.assertEqual(step.status, "failed")
        self.assertEqual(self.workflow.status, "failed")
        self.assertEqual(ArtifactVersion.objects.filter(artifact__task=self.workflow).count(), 0)
        unregistered_dir = self.artifacts / self.workflow.id / step.id
        self.assertTrue((unregistered_dir / "catalog.html").is_file())

    def test_empty_batch_and_unconfirmed_latest_revision_are_rejected_before_claim(self):
        empty_batch = Task.objects.create(
            title="Empty batch", mode="demo", status="confirmed",
            created_at=timezone.now(), updated_at=timezone.now(),
        )
        empty_workflow = WorkflowTask.objects.create(
            batch=empty_batch, user_goal="empty", task_type="prepare_product_data",
            status="running", current_step="generate_deliverables",
        )
        with self.assertRaises(DeliveryConflict):
            generate_deliverables(empty_workflow.id, "delivery:test:empty")
        self.assertFalse(WorkflowStep.objects.filter(task=empty_workflow, step_key="generate_deliverables").exists())

        ProductRevision.objects.create(
            product=self.product, version=2, status="draft",
            snapshot={**self.revision.snapshot, "color": "blue"},
        )
        with self.assertRaises(DeliveryConflict):
            generate_deliverables(self.workflow.id, "delivery:test:unconfirmed")
        self.assertFalse(WorkflowStep.objects.filter(task=self.workflow, step_key="generate_deliverables").exists())

    def test_cross_batch_taskfile_and_missing_image_bytes_block_generation(self):
        other_batch = Task.objects.create(
            title="Other batch", mode="demo", status="confirmed",
            created_at=timezone.now(), updated_at=timezone.now(),
        )
        foreign_file = TaskFile.objects.create(
            task=other_batch, kind="image", original_name="SKU-01.svg",
            stored_name="SKU-01.svg", created_at=timezone.now(),
        )
        ProductRevision.objects.filter(pk=self.revision.id).update(
            source_refs={"image": {"task_file_id": foreign_file.id, "stored_name": foreign_file.stored_name}}
        )
        with self.assertRaises(DeliveryConflict):
            generate_deliverables(self.workflow.id, "delivery:test:foreign-taskfile")
        self.assertFalse(WorkflowStep.objects.filter(task=self.workflow, step_key="generate_deliverables").exists())

        ProductRevision.objects.filter(pk=self.revision.id).update(
            source_refs={"image": {"task_file_id": self.task_file.id, "stored_name": self.task_file.stored_name}}
        )
        self.image.unlink()
        with self.assertRaises(DeliveryGenerationError):
            generate_deliverables(self.workflow.id, "delivery:test:missing-image")
        self.workflow.refresh_from_db()
        self.assertEqual(self.workflow.status, "failed")
        self.assertEqual(ArtifactVersion.objects.filter(artifact__task=self.workflow).count(), 0)

    def test_taskfile_relative_path_cannot_escape_media_root(self):
        outside = self.root / "outside.svg"
        outside.write_bytes(SVG)
        unsafe_name = "../outside.svg"
        TaskFile.objects.filter(pk=self.task_file.id).update(stored_name=unsafe_name)
        ProductRevision.objects.filter(pk=self.revision.id).update(
            source_refs={"image": {"task_file_id": self.task_file.id, "stored_name": unsafe_name}}
        )

        with self.assertRaises(DeliveryGenerationError):
            generate_deliverables(self.workflow.id, "delivery:test:taskfile-path-traversal")

        self.workflow.refresh_from_db()
        self.assertEqual(self.workflow.status, "failed")
        self.assertEqual(ArtifactVersion.objects.filter(artifact__task=self.workflow).count(), 0)

    def test_non_html_bundle_versions_are_download_only(self):
        generate_deliverables(self.workflow.id, "delivery:test:download-only")
        metadata = Client().get(f"/api/workflow-tasks/{self.workflow.id}/deliverables").json()
        previewable = {"catalog_html", "catalog_markdown", "sample_checklist_csv"}
        for artifact in metadata["artifacts"]:
            version = artifact["versions"][0]
            if artifact["artifact_type"] in previewable:
                self.assertTrue(version["preview_url"])
            else:
                self.assertIsNone(version["preview_url"])
                self.assertTrue(version["download_url"])
                response = Client().get(version["download_url"])
                self.assertEqual(response.status_code, 200)
                self.assertIn("attachment;", response["Content-Disposition"])
                response.close()

    def test_delivery_review_summary_is_generation_bound_and_separate_from_business_reviews(self):
        generated = generate_deliverables(self.workflow.id, "delivery:test:review-summary")
        review_delivery_bundle(
            self.workflow.id,
            generated["step_id"],
            decision="approve",
            reviewer="automated-demo-review (demo)",
            note="private note must not be projected",
        )

        workflow_payload = Client().get(f"/api/workflow-tasks/{self.workflow.id}").json()
        self.assertEqual(workflow_payload["reviews_scope"], "business_facts")
        self.assertEqual(workflow_payload["reviews"], [])
        self.assertEqual(workflow_payload["pending_review_count"], 0)

        payload = Client().get(f"/api/workflow-tasks/{self.workflow.id}/deliverables").json()
        summary = payload["delivery_review_summary"]
        self.assertEqual(summary["scope"], "delivery_bundle")
        self.assertEqual(summary["generation_step_id"], generated["step_id"])
        self.assertEqual(summary["decision"], "approve")
        self.assertEqual(summary["reviewer"], "automated-demo-review (demo)")
        self.assertEqual(summary["artifact_version_ids"], sorted(
            ArtifactVersion.objects.filter(artifact__task=self.workflow).values_list("id", flat=True)
        ))
        self.assertNotIn("note", summary)
        self.assertNotIn("request_fingerprint", summary)
        self.assertNotIn("private note must not be projected", str(payload))

        newer_generation = WorkflowStep.objects.create(
            task=self.workflow,
            step_key="generate_deliverables",
            status="completed",
            attempt=2,
            output_refs={"artifact_version_ids": []},
        )
        current_payload = Client().get(f"/api/workflow-tasks/{self.workflow.id}/deliverables").json()
        self.assertEqual(current_payload["generation_step_id"], newer_generation.id)
        self.assertIsNone(current_payload["delivery_review_summary"])

    def test_deliverables_without_a_review_event_expose_null_summary(self):
        generate_deliverables(self.workflow.id, "delivery:test:review-summary-pending")
        payload = Client().get(f"/api/workflow-tasks/{self.workflow.id}/deliverables").json()
        self.assertIsNone(payload["delivery_review_summary"])

    def test_sample_checklist_csv_has_version_bound_safe_preview(self):
        generated = generate_deliverables(self.workflow.id, "delivery:test:csv-preview")
        version = ArtifactVersion.objects.get(
            artifact__task=self.workflow, artifact__artifact_type="sample_checklist_csv"
        )
        metadata = Client().get(f"/api/workflow-tasks/{self.workflow.id}/deliverables").json()
        csv_row = next(
            row for artifact in metadata["artifacts"]
            if artifact["artifact_type"] == "sample_checklist_csv"
            for row in artifact["versions"]
        )
        self.assertEqual(csv_row["preview_url"], f"/api/workflow-tasks/{self.workflow.id}/artifact-versions/{version.id}/preview")

        rows_before = list(ArtifactVersion.objects.filter(artifact__task=self.workflow).values_list("id", "sha256", "status"))
        events_before = list(EventLog.objects.filter(task=self.workflow).values_list("id", "event_type", "created_at"))
        preview = Client().get(csv_row["preview_url"])
        self.assertEqual(preview.status_code, 200)
        self.assertContains(preview, "pending_review")
        self.assertContains(preview, "模拟")
        self.assertContains(preview, "待审核")
        self.assertContains(preview, f"/api/workflow-tasks/{self.workflow.id}/artifact-versions/{version.id}/download")
        self.assertContains(preview, "product_id")
        self.assertContains(preview, "SKU-01")
        self.assertContains(preview, self.revision.id)
        self.assertIn("sandbox allow-downloads", preview["Content-Security-Policy"])
        self.assertEqual(preview["X-Content-Type-Options"], "nosniff")
        self.assertEqual(rows_before, list(ArtifactVersion.objects.filter(artifact__task=self.workflow).values_list("id", "sha256", "status")))
        self.assertEqual(events_before, list(EventLog.objects.filter(task=self.workflow).values_list("id", "event_type", "created_at")))

        checksum = version.sha256
        downloaded = Client().get(f"/api/workflow-tasks/{self.workflow.id}/artifact-versions/{version.id}/download")
        self.assertEqual(downloaded.status_code, 200)
        self.assertEqual(hashlib.sha256(b"".join(downloaded.streaming_content)).hexdigest(), checksum)

    def test_sample_checklist_preview_parses_saved_csv_and_escapes_cells(self):
        generate_deliverables(self.workflow.id, "delivery:test:csv-escape")
        version = ArtifactVersion.objects.get(
            artifact__task=self.workflow, artifact__artifact_type="sample_checklist_csv"
        )
        path = self.artifacts / version.file_path
        saved_csv = (
            "product_id,revision_id,revision_version,sku,english_name,name,category,material,size,color,image_task_file_id,image_filename,image_sha256\n"
            'saved-id,rev-id,1,SKU-SAVED,Ribbon,"<script>alert(1)</script>, ""quoted""\nsecond line",trim,cotton,20mm,blue,,,\n'
        ).encode("utf-8-sig")
        path.write_bytes(saved_csv)
        version.sha256 = hashlib.sha256(saved_csv).hexdigest()
        version.save(update_fields=["sha256"])

        url = f"/api/workflow-tasks/{self.workflow.id}/artifact-versions/{version.id}/preview"
        response = Client().get(url)
        self.assertEqual(response.status_code, 200)
        self.assertContains(response, "SKU-SAVED")
        self.assertContains(response, "&lt;script&gt;alert(1)&lt;/script&gt;")
        self.assertNotContains(response, "<script>alert(1)</script>")
        self.assertContains(response, "second line")
        self.assertContains(response, "&quot;quoted&quot;")

    def test_sample_checklist_preview_rejects_hash_tampering_and_foreign_workflow(self):
        generate_deliverables(self.workflow.id, "delivery:test:csv-guard")
        version = ArtifactVersion.objects.get(
            artifact__task=self.workflow, artifact__artifact_type="sample_checklist_csv"
        )
        url = f"/api/workflow-tasks/{self.workflow.id}/artifact-versions/{version.id}/preview"
        path = self.artifacts / version.file_path
        path.write_bytes(path.read_bytes() + b"tampered")
        response = Client().get(url)
        self.assertEqual(response.status_code, 409)
        self.assertNotIn(str(self.artifacts), response.content.decode())
        self.assertEqual(Client().get(f"/api/workflow-tasks/not-this-workflow/artifact-versions/{version.id}/preview").status_code, 404)

    def test_approved_csv_preview_shows_actual_review_status(self):
        approved = generate_deliverables(self.workflow.id, "delivery:test:csv-approved")
        review_delivery_bundle(self.workflow.id, approved["step_id"], decision="approve", reviewer="local QA")
        approved_version = ArtifactVersion.objects.get(
            artifact__task=self.workflow, artifact__artifact_type="sample_checklist_csv", version=1
        )
        response = Client().get(f"/api/workflow-tasks/{self.workflow.id}/artifact-versions/{approved_version.id}/preview")
        self.assertEqual(response.status_code, 200)
        self.assertContains(response, "approved")
        self.assertContains(response, "已批准")
        self.assertNotContains(response, "尚未批准")
        self.assertIn("allow-downloads", response["Content-Security-Policy"])


    def test_rejected_csv_preview_shows_actual_review_status(self):
        rejected = generate_deliverables(self.workflow.id, "delivery:test:csv-rejected")
        review_delivery_bundle(self.workflow.id, rejected["step_id"], decision="reject", reviewer="local QA")
        version = ArtifactVersion.objects.get(
            artifact__task=self.workflow, artifact__artifact_type="sample_checklist_csv", version=1
        )
        response = Client().get(f"/api/workflow-tasks/{self.workflow.id}/artifact-versions/{version.id}/preview")
        self.assertEqual(response.status_code, 200)
        self.assertContains(response, "rejected")
        self.assertContains(response, "已驳回")
        self.assertNotContains(response, "尚未批准")

    def test_missing_delivery_file_review_api_returns_safe_conflict(self):
        generated = generate_deliverables(self.workflow.id, "delivery:test:missing-review")
        html_version = ArtifactVersion.objects.get(
            artifact__task=self.workflow, artifact__artifact_type="catalog_html"
        )
        (self.artifacts / html_version.file_path).unlink()
        response = Client().post(
            f"/api/workflow-tasks/{self.workflow.id}/deliverables/{generated['step_id']}/review",
            data=json.dumps({"decision": "approve", "reviewer": "local QA", "note": ""}),
            content_type="application/json",
        )
        self.assertEqual(response.status_code, 409)
        self.assertEqual(response.json()["code"], "delivery_conflict")
        self.assertNotIn(str(self.artifacts), response.content.decode())

    def test_generation_quality_error_returns_generic_saved_failure_response(self):
        with patch("workbench.delivery.service.check_delivery_files", side_effect=DeliveryQualityError("private path details")):
            response = Client().post(
                f"/api/workflow-tasks/{self.workflow.id}/deliverables",
                data=json.dumps({"idempotency_key": "delivery:test:qa-api-error"}),
                content_type="application/json",
            )
        self.assertEqual(response.status_code, 500)
        self.assertEqual(response.json()["code"], "generation_failed")
        self.assertNotIn("private path details", response.content.decode())
        self.workflow.refresh_from_db()
        self.assertEqual(self.workflow.status, "failed")

    def test_download_rejects_database_path_outside_artifact_root(self):
        generate_deliverables(self.workflow.id, "delivery:test:path")
        version = ArtifactVersion.objects.get(artifact__task=self.workflow, artifact__artifact_type="catalog_html")
        ArtifactVersion.objects.filter(pk=version.id).update(file_path="../outside/catalog.html")
        response = Client().get(
            f"/api/workflow-tasks/{self.workflow.id}/artifact-versions/{version.id}/download"
        )
        self.assertEqual(response.status_code, 404)
        response.close()

    def test_download_endpoint_returns_real_registered_bytes_and_detects_tampering(self):
        generated = generate_deliverables(self.workflow.id, "delivery:test:download")
        versions = ArtifactVersion.objects.filter(artifact__task=self.workflow)
        html_version = versions.get(artifact__artifact_type="catalog_html")
        url = f"/api/workflow-tasks/{self.workflow.id}/artifact-versions/{html_version.id}/download"
        response = Client().get(url)
        self.assertEqual(response.status_code, 200)
        self.assertIn("attachment;", response["Content-Disposition"])
        self.assertIn(b"data:image/svg+xml;base64,", b"".join(response.streaming_content))
        response.close()
        Path(self.artifacts / html_version.file_path).write_bytes(b"tampered")
        self.assertEqual(Client().get(url).status_code, 409)

    def test_registration_failure_keeps_old_versions_and_files_unchanged(self):
        first = generate_deliverables(self.workflow.id, "delivery:test:first")
        review_delivery_bundle(
            self.workflow.id, first["step_id"], decision="reject", reviewer="local QA", note="revise",
        )
        old_versions = list(ArtifactVersion.objects.filter(artifact__task=self.workflow).order_by("id"))
        old_digests = {item.id: item.sha256 for item in old_versions}
        def fail_registration(*args, **kwargs):
            raise RuntimeError("simulated database registration failure")

        with patch.object(ArtifactVersion.objects, "create", side_effect=fail_registration):
            with self.assertRaises(DeliveryConflict):
                generate_deliverables(self.workflow.id, "delivery:test:second")

        for version in old_versions:
            version.refresh_from_db()
            self.assertEqual(version.sha256, old_digests[version.id])
            self.assertTrue((self.artifacts / version.file_path).is_file())
        self.assertEqual(
            list(ArtifactVersion.objects.filter(artifact__task=self.workflow).order_by("id").values_list("id", flat=True)),
            [item.id for item in old_versions],
        )
        latest = WorkflowStep.objects.filter(task=self.workflow, step_key="generate_deliverables").order_by("-attempt").first()
        self.assertEqual(latest.status, "running")

    def test_quality_failure_blocks_artifacts_and_new_key_can_retry_failed_attempt(self):
        from workbench.delivery import service

        with patch.object(service, "check_delivery_files", side_effect=DeliveryQualityError("bad output")):
            with self.assertRaises(DeliveryGenerationError):
                generate_deliverables(self.workflow.id, "delivery:test:qa-fail")
        first_step = WorkflowStep.objects.filter(task=self.workflow, step_key="generate_deliverables").get()
        self.workflow.refresh_from_db()
        self.assertEqual(first_step.status, "failed")
        self.assertEqual(self.workflow.status, "failed")
        self.assertEqual(ArtifactVersion.objects.filter(artifact__task=self.workflow).count(), 0)

        retry = generate_deliverables(self.workflow.id, "delivery:test:qa-retry")
        self.assertEqual(retry["status"], "completed")
        self.assertEqual(WorkflowStep.objects.filter(task=self.workflow, step_key="generate_deliverables").count(), 2)
        self.assertEqual(ArtifactVersion.objects.filter(artifact__task=self.workflow).count(), 5)

    def test_rejected_bundle_allows_new_key_and_preserves_old_read_only_version(self):
        first = generate_deliverables(self.workflow.id, "delivery:test:reject-first")
        first_versions = list(ArtifactVersion.objects.filter(artifact__task=self.workflow).order_by("id"))
        first_files = {item.file_path: (self.artifacts / item.file_path).read_bytes() for item in first_versions}
        review_delivery_bundle(
            self.workflow.id, first["step_id"], decision="reject", reviewer="local QA", note="revise copy",
        )
        second = generate_deliverables(self.workflow.id, "delivery:test:reject-second")
        self.assertNotEqual(first["step_id"], second["step_id"])
        for version in first_versions:
            version.refresh_from_db()
            self.assertEqual(version.version, 1)
            self.assertEqual(version.status, "rejected")
            self.assertEqual((self.artifacts / version.file_path).read_bytes(), first_files[version.file_path])
        self.assertEqual(
            sorted(ArtifactVersion.objects.filter(artifact__task=self.workflow).values_list("version", flat=True)),
            [1, 1, 1, 1, 1, 2, 2, 2, 2, 2],
        )

    def test_two_generation_keys_only_claim_once_while_first_attempt_is_running(self):
        entered = threading.Event()
        release = threading.Event()
        results = []
        errors = []
        from workbench.delivery import service

        original_load = service._load_product_images

        def wait_after_claim(source):
            entered.set()
            if not release.wait(timeout=10):
                raise RuntimeError("test synchronization timed out")
            return original_load(source)

        def first_attempt():
            close_old_connections()
            try:
                results.append(generate_deliverables(self.workflow.id, "delivery:race:first"))
            except Exception as exc:  # surfaced in the main test thread
                errors.append(exc)
            finally:
                close_old_connections()

        with patch.object(service, "_load_product_images", side_effect=wait_after_claim):
            thread = threading.Thread(target=first_attempt)
            thread.start()
            self.assertTrue(entered.wait(timeout=10), "first attempt did not claim generation")
            with self.assertRaises(DeliveryConflict):
                generate_deliverables(self.workflow.id, "delivery:race:second")
            release.set()
            thread.join(timeout=15)

        self.assertFalse(thread.is_alive(), "generation thread did not finish")
        self.assertEqual(errors, [])
        self.assertEqual(len(results), 1)
        self.assertEqual(WorkflowStep.objects.filter(task=self.workflow, step_key="generate_deliverables").count(), 1)
        self.assertEqual(ArtifactVersion.objects.filter(artifact__task=self.workflow).count(), 5)
