"""Synthetic business lineage through real services/ORM; no listener or model.

This deliberately exercises the existing local_mock business roles, not the
native DSH runner. Confirmation and image registration use real review APIs.
"""
from __future__ import annotations

import copy
import hashlib
import json

from django.core.files.uploadedfile import SimpleUploadedFile
from django.db import connection
from django.test import TransactionTestCase, override_settings

from workbench.models import (
    ArtifactVersion, EventLog, HumanReview, IntakeOperationReceipt,
    Product, ProductRevision, WorkflowTask,
)
from workbench.workflows.prepare import create_prepared_workflow

from . import test_intake_product_application as intake_fixture


class BusinessLineageDeliveryPgTests(TransactionTestCase):
    _create_candidate = intake_fixture.IntakeProductApplicationApiTests._create_candidate

    def setUp(self):
        self.assertEqual(connection.vendor, "postgresql")
        self.assertTrue(connection.settings_dict["NAME"].startswith("tradeloom_test_"))
        self.assertEqual(connection.settings_dict["HOST"], "127.0.0.1")
        self.assertEqual(str(connection.settings_dict["PORT"]), "55435")
        # Reuse the existing synthetic XLSX upload/preview/mapping/candidate path.
        intake_fixture.IntakeProductApplicationApiTests.setUp(self)
        self.media = self.data_root / "media"
        self.artifacts = self.data_root / "artifacts"
        self.media.mkdir()
        self.artifacts.mkdir()
        self.delivery_settings = override_settings(
            MEDIA_ROOT=self.media, TRADELOOM_ARTIFACT_ROOT=self.artifacts,
        )
        self.delivery_settings.enable()

    def tearDown(self):
        self.delivery_settings.disable()
        intake_fixture.IntakeProductApplicationApiTests.tearDown(self)

    def post_json(self, url, body, *, key=None):
        headers = {"HTTP_IDEMPOTENCY_KEY": key} if key else {}
        return self.client.post(
            url, data=json.dumps(body), content_type="application/json", **headers,
        )

    def dispatch_visible_target(self, workflow):
        page = self.client.get(f"/workflow-tasks/{workflow.id}")
        self.assertEqual(page.status_code, 200)
        target = page.context["dispatch_target"]
        self.assertIsNotNone(target)
        response = self.post_json(target["url"], {"idempotency_key": target["idempotency_key"]})
        self.assertEqual(response.status_code, 200, response.content)

    def prepare_approved_bundle(self):
        # Draft only: no fixture writes a confirmed product/revision/status.
        batch = intake_fixture.IntakeProductApplicationApiTests._task(self, status="draft")
        payload = intake_fixture.IntakeProductApplicationApiTests._payload(self, batch)
        apply_url = f"/api/intake/candidates/{self.candidate.pk}/apply"
        applied = self.post_json(apply_url, payload, key="lineage-product-first")
        self.assertEqual(applied.status_code, 201, applied.content)
        self.assertEqual(applied.json()["application"]["status"], "needs_review")
        product = Product.objects.get(task=batch)
        initial = ProductRevision.objects.get(product=product)
        self.assertEqual(initial.status, "needs_review")
        self.assertEqual(initial.source_refs["intake_source_sha256"], self.candidate.source_sha256)
        self.assertEqual(initial.source_refs["intake_candidate_id"], self.candidate.pk)
        frozen_fields = copy.deepcopy(initial.source_refs["intake_fields"])
        self.assertTrue(frozen_fields["sku"]["sources"])
        self.assertEqual(frozen_fields["sku"]["source_fields"], ["style_number"])
        for field in frozen_fields.values():
            self.assertEqual(field["source_sha256"], self.candidate.source_sha256)
            self.assertEqual(field["mapping_id"], self.candidate.mapping_revision_id)
        count_before_replay = (Product.objects.count(), ProductRevision.objects.count(), IntakeOperationReceipt.objects.count())
        replay = self.post_json(apply_url, payload, key="lineage-product-first")
        self.assertEqual(replay.status_code, 200, replay.content)
        self.assertEqual(replay.json()["application"], applied.json()["application"])
        self.assertEqual(count_before_replay, (Product.objects.count(), ProductRevision.objects.count(), IntakeOperationReceipt.objects.count()))

        workflow = create_prepared_workflow(
            batch_id=batch.id, user_goal="Synthetic intake lineage to reviewed delivery",
        )
        self.dispatch_visible_target(workflow)
        reviews = list(HumanReview.objects.filter(task=workflow).order_by("id"))
        self.assertTrue(reviews)
        image_reviews = [r for r in reviews if r.source_conflict["source_refs"]["signal"].get("missing_field") == "图片"]
        self.assertEqual(len(image_reviews), 1)
        image_review = image_reviews[0]
        svg = b'<svg xmlns="http://www.w3.org/2000/svg" width="2" height="2"><rect width="2" height="2" fill="navy"/></svg>'
        uploaded = self.client.post(
            f"/api/workflow-tasks/{workflow.id}/reviews/{image_review.id}/image",
            {"image": SimpleUploadedFile("synthetic-lineage.svg", svg, "image/svg+xml"),
             "review_key": image_review.review_key, "idempotency_key": "lineage-image",
             "reviewer": "synthetic-lineage-operator"},
        )
        self.assertEqual(uploaded.status_code, 201, uploaded.content)
        values = {"category": "synthetic trim", "material": "synthetic polyester", "english_name": "Synthetic item"}
        for review in reviews:
            refs = review.source_conflict["source_refs"]
            signal = refs["signal"]
            if review.pk == image_review.pk:
                answer = {"type": "provide_image", "upload_step_id": uploaded.json()["upload_step_id"]}
            elif signal.get("missing_field"):
                field = signal["missing_field"]
                self.assertIn(field, values)
                answer = {"type": "set_literal_field", "field": field, "value": values[field]}
            else:
                self.assertEqual(signal.get("uncertainty"), "current_revision_not_confirmed")
                answer = {"type": "confirm_current_revision", "revision_id": refs["revision_id"]}
            submitted = self.post_json(
                f"/api/workflow-tasks/{workflow.id}/reviews/{review.id}/submit",
                {"review_key": review.review_key, "answer": answer, "reviewer": "synthetic-lineage-operator"},
            )
            self.assertEqual(submitted.status_code, 200, submitted.content)
        confirmed_response = self.post_json(
            f"/api/workflow-tasks/{workflow.id}/reviews/apply",
            {"review_ids": [r.id for r in reviews], "idempotency_key": "lineage-review-confirm",
             "decision": "apply_and_confirm", "reviewer": "synthetic-lineage-operator"},
        )
        self.assertEqual(confirmed_response.status_code, 200, confirmed_response.content)
        confirmed = ProductRevision.objects.filter(product=product).latest("version")
        self.assertNotEqual(confirmed.id, initial.id)
        self.assertEqual(confirmed.status, "confirmed")
        self.assertEqual(confirmed.reviewer, "synthetic-lineage-operator")
        self.assertEqual(confirmed.source_refs["prior_revision_id"], initial.id)
        self.assertEqual(confirmed.source_refs["intake_source_sha256"], self.candidate.source_sha256)
        self.assertEqual(confirmed.source_refs["intake_fields"], frozen_fields)
        self.assertEqual(confirmed.source_refs["human_image_upload"]["sha256"], hashlib.sha256(svg).hexdigest())
        initial.refresh_from_db()
        self.assertEqual(initial.status, "needs_review")
        self.assertEqual(initial.source_refs["intake_fields"], frozen_fields)

        self.dispatch_visible_target(workflow)  # resumed product_profile
        self.dispatch_visible_target(workflow)  # delivery_quality
        delivery_url = f"/api/workflow-tasks/{workflow.id}/deliverables"
        generation = {"idempotency_key": "lineage-delivery"}
        generated = self.post_json(delivery_url, generation)
        self.assertEqual(generated.status_code, 200, generated.content)
        bundle = generated.json()
        self.assertEqual(bundle["quality_status"], "passed")
        versions = list(ArtifactVersion.objects.filter(artifact__task=workflow).order_by("id"))
        self.assertEqual(len(versions), 5)
        self.assertEqual(set(bundle["artifact_version_ids"]), {v.id for v in versions})
        files_before_replay = self.registered_file_manifest(versions)
        for version in versions:
            self.assertEqual({row["revision_id"] for row in version.source_product_versions}, {confirmed.id})
            self.assertEqual(hashlib.sha256((self.artifacts / version.file_path).read_bytes()).hexdigest(), version.sha256)
        generation_replay = self.post_json(delivery_url, generation)
        self.assertEqual(generation_replay.status_code, 200, generation_replay.content)
        self.assertEqual(generation_replay.json()["artifact_version_ids"], bundle["artifact_version_ids"])
        self.assertEqual(ArtifactVersion.objects.filter(artifact__task=workflow).count(), 5)
        self.assertEqual(files_before_replay, self.registered_file_manifest(versions))

        # Approval must be a real service receipt, not a status assignment.
        from workbench.delivery.service import review_delivery_bundle
        review_delivery_bundle(workflow.id, bundle["step_id"], decision="approve", reviewer="synthetic-lineage-operator")
        receipt = EventLog.objects.get(task=workflow, event_type="delivery_bundle_reviewed")
        self.assertEqual(receipt.payload_summary["refs"]["generation_step_id"], bundle["step_id"])
        self.assertEqual(receipt.payload_summary["refs"]["decision"], "approve")
        self.assertEqual(set(receipt.payload_summary["refs"]["artifact_version_ids"]), {v.id for v in versions})
        workflow.refresh_from_db()
        self.assertEqual(workflow.status, "running")
        self.assertEqual(workflow.current_step, "complete_workflow")
        self.assertFalse(EventLog.objects.filter(task=workflow, event_type="workflow_delivery_completed").exists())
        return batch, product, payload, workflow, confirmed, bundle, versions

    def registered_file_manifest(self, versions):
        paths = [version.file_path for version in versions]
        self.assertEqual(len(paths), 5)
        self.assertEqual(len(set(paths)), 5)
        result = {}
        for version in versions:
            content = (self.artifacts / version.file_path).read_bytes()
            self.assertGreater(len(content), 0)
            result[version.file_path] = {"bytes": len(content), "sha256": hashlib.sha256(content).hexdigest()}
            self.assertEqual(result[version.file_path]["sha256"], version.sha256)
        self.assertEqual(set(result), set(paths))
        return result

    def test_source_lineage_completes_with_receipt_and_download_hashes(self):
        _batch, _product, _payload, workflow, _confirmed, bundle, versions = self.prepare_approved_bundle()
        completed = self.post_json(f"/api/workflow-tasks/{workflow.id}/complete", {})
        self.assertEqual(completed.status_code, 200, completed.content)
        self.assertEqual(completed.json(), {"workflow_task_id": workflow.id, "status": "completed", "replayed": False})
        workflow.refresh_from_db()
        self.assertEqual(workflow.status, "completed")
        self.assertEqual(workflow.current_step, "completed")
        receipt = EventLog.objects.get(task=workflow, event_type="workflow_delivery_completed")
        self.assertEqual(receipt.payload_summary["from_status"], "running")
        self.assertEqual(receipt.payload_summary["to_status"], "completed")
        self.assertEqual(receipt.payload_summary["refs"]["workflow_step_id"], bundle["step_id"])
        self.assertEqual(set(receipt.payload_summary["refs"]["artifact_version_ids"]), {v.id for v in versions})
        for version in versions:
            downloaded = self.client.get(f"/api/workflow-tasks/{workflow.id}/artifact-versions/{version.id}/download")
            self.assertEqual(downloaded.status_code, 200)
            try:
                self.assertEqual(hashlib.sha256(b"".join(downloaded.streaming_content)).hexdigest(), version.sha256)
            finally:
                downloaded.close()

    def test_new_revision_blocks_old_approval_on_independent_uncompleted_workflow(self):
        batch, product, payload, workflow, confirmed, _bundle, _versions = self.prepare_approved_bundle()
        apply_url = f"/api/intake/candidates/{self.candidate.pk}/apply"
        # A new revision is appended by the real intake API, never by ORM status edits.
        changed = copy.deepcopy(payload)
        changed["target"] = {"task_id": batch.id, "product_id": product.id, "expected_revision_id": confirmed.id}
        changed["fields"] = {"color": {"value": "synthetic second variant", "source_fields": [], "note": "Explicit synthetic operator revision after approval"}}
        appended = self.post_json(apply_url, changed, key="lineage-product-after-approval")
        self.assertEqual(appended.status_code, 201, appended.content)
        latest = ProductRevision.objects.filter(product=product).latest("version")
        self.assertNotEqual(latest.id, confirmed.id)
        self.assertEqual(latest.status, "needs_review")
        rejected = self.post_json(f"/api/workflow-tasks/{workflow.id}/complete", {})
        self.assertEqual(rejected.status_code, 409, rejected.content)
        self.assertNotEqual(WorkflowTask.objects.get(pk=workflow.id).status, "completed")
        self.assertFalse(EventLog.objects.filter(task=workflow, event_type="workflow_delivery_completed").exists())
        self.assertEqual(ArtifactVersion.objects.filter(artifact__task=workflow).count(), 5)
