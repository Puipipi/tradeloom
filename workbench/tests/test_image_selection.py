from __future__ import annotations

import csv
import hashlib
import io
import json
import os
import tempfile
from pathlib import Path
from unittest.mock import patch

from django.conf import settings
from django.test import TestCase, override_settings

from workbench.models import EventLog, HumanReview, Product, ProductRevision, SubTask, TaskFile, WorkflowStep, WorkflowTask


@override_settings(
    MEDIA_ROOT=Path(tempfile.mkdtemp(prefix="tradeloom-image-selection-")),
    TRADELOOM_ARTIFACT_ROOT=Path(tempfile.mkdtemp(prefix="tradeloom-image-artifacts-")),
)
class ImageSelectionIntegrationTests(TestCase):
    def setUp(self):
        database = settings.DATABASES["default"]
        expected_base_name = os.environ.get("TRADELOOM_EXPECTED_DB_NAME", "tradeloom_dev").strip()
        expected_port = os.environ.get("TRADELOOM_EXPECTED_DB_PORT", "55432").strip()
        expected_test_name = os.environ.get("TRADELOOM_DB_TEST_NAME", "").strip()
        self.assertEqual(os.environ.get("TRADELOOM_DB_NAME"), expected_base_name)
        self.assertTrue(expected_test_name.startswith("tradeloom_test_"))
        self.assertNotIn(expected_test_name, {expected_base_name, f"test_{expected_base_name}"})
        self.assertEqual(database["NAME"], expected_test_name)
        self.assertEqual(database["HOST"], "127.0.0.1")
        self.assertEqual(str(database["PORT"]), expected_port)
        self.assertEqual(database["USER"], "tradeloom")
        self.assertEqual(database["TEST"]["NAME"], expected_test_name)
        csv_buffer = io.StringIO(newline="")
        writer = csv.writer(csv_buffer, lineterminator="\n")
        writer.writerow(("sku", "name", "category", "material", "size", "color", "image_filename"))
        writer.writerow(("IMG-CHOICE", "测试丝带", "丝带", "涤纶", "25mm", "酒红", ""))
        csv_upload = io.BytesIO(csv_buffer.getvalue().encode("utf-8-sig"))
        csv_upload.name = "products.csv"
        first = io.BytesIO(b'<svg xmlns="http://www.w3.org/2000/svg"><title>first</title></svg>')
        first.name = "IMG-CHOICE.svg"
        second = io.BytesIO(b'<svg xmlns="http://www.w3.org/2000/svg"><title>second</title></svg>')
        second.name = "IMG-CHOICE.svg"
        uploaded = self.client.post(
            "/api/tasks",
            {
                "title": "图片人审集成测试",
                "products_csv": csv_upload,
                "images": [first, second],
            },
        )
        self.assertEqual(uploaded.status_code, 200, uploaded.content)
        self.batch_id = uploaded.json()["id"]
        self.assertEqual(
            self.client.post(f"/api/tasks/{self.batch_id}/confirm").status_code,
            200,
        )
        created = self.client.post(
            "/api/workflow-tasks",
            data=json.dumps({"batch_id": self.batch_id, "user_goal": "检查产品图片"}),
            content_type="application/json",
        )
        self.assertEqual(created.status_code, 201, created.content)
        self.workflow_id = created.json()["id"]
        self.product = Product.objects.get(task_id=self.batch_id)
        self.files = list(TaskFile.objects.filter(task_id=self.batch_id, kind="image").order_by("original_name"))
        self.assertEqual(len(self.files), 2)
        self.assertEqual(
            len({hashlib.sha256((Path(settings.MEDIA_ROOT) / item.stored_name).read_bytes()).hexdigest() for item in self.files}),
            2,
        )
        self.product_subtask = SubTask.objects.get(task_id=self.workflow_id, agent_role="product_profile")
        dispatched = self.client.post(
            f"/api/workflow-tasks/{self.workflow_id}/subtasks/{self.product_subtask.id}/dispatch",
            data=json.dumps({"idempotency_key": "image-selection-product-first"}),
            content_type="application/json",
        )
        self.assertEqual(dispatched.status_code, 200, dispatched.content)
        self.product_subtask.refresh_from_db()
        self.assertEqual(self.product_subtask.status, "waiting_human")
        self.reviews = list(HumanReview.objects.filter(task_id=self.workflow_id).order_by("id"))
        self.image_review = next(
            review
            for review in self.reviews
            if review.source_conflict["source_refs"]["signal"].get("uncertainty")
            == "ambiguous_image_candidate"
        )

    def submit(self, review, response):
        return self.client.post(
            f"/api/workflow-tasks/{self.workflow_id}/reviews/{review.id}/submit",
            data=json.dumps(
                {
                    "review_key": review.review_key,
                    "answer": response,
                    "reviewer": "image-operator",
                }
            ),
            content_type="application/json",
        )

    def test_candidate_preview_serves_only_canonical_image(self):
        selected = next(
            item for item in self.files
            if item.stored_name != self.product.image_stored_name
        )
        preview_url = (
            f"/api/workflow-tasks/{self.workflow_id}/task-files/"
            f"{selected.id}/preview"
        )
        preview = self.client.get(preview_url)
        self.assertEqual(preview.status_code, 200)
        self.assertEqual(preview["Content-Type"], "image/svg+xml")
        self.assertIn("sandbox", preview["Content-Security-Policy"])
        self.assertEqual(
            b"".join(preview.streaming_content),
            (Path(settings.MEDIA_ROOT) / selected.stored_name).read_bytes(),
        )
        self.assertEqual(
            self.client.get(
                f"/api/workflow-tasks/{self.workflow_id}/task-files/not-a-candidate/preview"
            ).status_code,
            404,
        )
        page = self.client.get(f"/workflow-tasks/{self.workflow_id}")
        self.assertEqual(page.status_code, 200)
        self.assertContains(page, f"alt=\"候选图片 {selected.original_name}\"")
        self.assertContains(page, selected.id)
        self.assertContains(page, "请选择一张图片")
        self.assertNotContains(page, f'value="{selected.id}" selected')

    def test_image_selection_rejects_extra_non_candidate_and_stale_sources(self):
        selected = next(
            item for item in self.files
            if item.stored_name != self.product.image_stored_name
        )
        extra = self.submit(
            self.image_review,
            {"type": "select_image_candidate", "task_file_id": selected.id, "extra": True},
        )
        self.assertEqual(extra.status_code, 409)
        foreign_file = TaskFile.objects.create(
            task_id=self.batch_id,
            kind="image",
            original_name="not-a-candidate.png",
            stored_name="not-a-candidate.png",
            created_at=self.files[0].created_at,
        )
        foreign = self.submit(
            self.image_review,
            {"type": "select_image_candidate", "task_file_id": foreign_file.id},
        )
        self.assertEqual(foreign.status_code, 409)
        self.image_review.refresh_from_db()
        self.assertEqual(self.image_review.status, "pending")

        selected.original_name = "renamed.svg"
        selected.save(update_fields=["original_name"])
        changed_metadata = self.submit(
            self.image_review,
            {"type": "select_image_candidate", "task_file_id": selected.id},
        )
        self.assertEqual(changed_metadata.status_code, 409)
        self.image_review.refresh_from_db()
        self.assertEqual(self.image_review.status, "pending")

    def test_image_selection_rejects_expired_revision(self):
        selected = next(
            item for item in self.files
            if item.stored_name != self.product.image_stored_name
        )
        current = ProductRevision.objects.get(product=self.product).snapshot
        ProductRevision.objects.create(
            product=self.product,
            version=2,
            snapshot=current,
            status="confirmed",
        )
        response = self.submit(
            self.image_review,
            {"type": "select_image_candidate", "task_file_id": selected.id},
        )
        self.assertEqual(response.status_code, 409)
        self.image_review.refresh_from_db()
        self.assertEqual(self.image_review.status, "pending")

    def test_applied_image_selection_is_reused_by_a_later_workflow(self):
        selected = next(
            item for item in self.files
            if item.stored_name != self.product.image_stored_name
        )
        for review in self.reviews:
            signal = review.source_conflict["source_refs"]["signal"]
            if signal.get("missing_field") == "english_name":
                submitted = self.submit(
                    review,
                    {"type": "set_literal_field", "field": "english_name", "value": "Ribbon"},
                )
                self.assertEqual(submitted.status_code, 200, submitted.content)
        selected_receipt = self.submit(
            self.image_review,
            {"type": "select_image_candidate", "task_file_id": selected.id},
        )
        self.assertEqual(selected_receipt.status_code, 200, selected_receipt.content)
        cycle = list(HumanReview.objects.filter(task_id=self.workflow_id, status="submitted"))
        applied = self.client.post(
            f"/api/workflow-tasks/{self.workflow_id}/reviews/apply",
            data=json.dumps(
                {
                    "review_ids": [review.id for review in cycle],
                    "idempotency_key": "image-selection-cross-workflow-apply",
                    "decision": "apply_and_confirm",
                    "reviewer": "image-operator",
                }
            ),
            content_type="application/json",
        )
        self.assertEqual(applied.status_code, 200, applied.content)

        second = self.client.post(
            "/api/workflow-tasks",
            data=json.dumps({"batch_id": self.batch_id, "user_goal": "再次检查同批产品"}),
            content_type="application/json",
        )
        self.assertEqual(second.status_code, 201, second.content)
        second_workflow_id = second.json()["id"]
        second_product_subtask = SubTask.objects.get(
            task_id=second_workflow_id,
            agent_role="product_profile",
        )
        dispatched = self.client.post(
            f"/api/workflow-tasks/{second_workflow_id}/subtasks/{second_product_subtask.id}/dispatch",
            data=json.dumps({"idempotency_key": f"workflow:{second_workflow_id}:subtask:{second_product_subtask.id}"}),
            content_type="application/json",
        )
        self.assertEqual(dispatched.status_code, 200, dispatched.content)
        saved = WorkflowStep.objects.filter(
            task_id=second_workflow_id,
            step_key=f"subtask:{second_product_subtask.id}",
        ).latest("attempt")
        product_result = saved.output_refs["result_snapshot"]["result"]["products"][0]
        self.assertEqual(
            [item["task_file_id"] for item in product_result["image_candidates"]],
            [selected.id],
        )
        self.assertNotIn(
            "ambiguous_image_candidate",
            product_result["uncertainties"],
        )

    def test_image_choice_receipt_apply_resume(self):
        selected = next(
            item for item in self.files
            if item.stored_name != self.product.image_stored_name
        )
        for review in self.reviews:
            signal = review.source_conflict["source_refs"]["signal"]
            if signal.get("missing_field") == "english_name":
                submitted = self.submit(
                    review,
                    {"type": "set_literal_field", "field": "english_name", "value": "Ribbon"},
                )
                self.assertEqual(submitted.status_code, 200, submitted.content)
        submitted = self.submit(
            self.image_review,
            {"type": "select_image_candidate", "task_file_id": selected.id},
        )
        self.assertEqual(submitted.status_code, 200, submitted.content)
        receipt = submitted.json()["answer"]
        self.assertEqual(receipt["response"], {"type": "select_image_candidate", "task_file_id": selected.id})
        self.assertEqual(receipt["source_refs"], self.image_review.source_conflict["source_refs"])
        replay = self.submit(
            self.image_review,
            {"type": "select_image_candidate", "task_file_id": selected.id},
        )
        self.assertEqual(replay.status_code, 200)
        self.assertEqual(replay.json()["answer"], receipt)
        self.assertContains(
            self.client.get(f"/workflow-tasks/{self.workflow_id}"),
            "人工选图（待应用）",
        )

        # Submission stores a receipt only; application is a separate explicit step.
        self.product.refresh_from_db()
        self.assertNotEqual(self.product.image_stored_name, selected.stored_name)
        cycle = list(HumanReview.objects.filter(task_id=self.workflow_id, status="submitted"))
        apply_url = f"/api/workflow-tasks/{self.workflow_id}/reviews/apply"
        apply_data = {
            "review_ids": [review.id for review in cycle],
            "idempotency_key": "image-selection-apply-once",
            "decision": "apply_and_confirm",
            "reviewer": "image-operator",
        }
        with patch(
            "workbench.workflows.fact_application.EventLog.objects.create",
            side_effect=RuntimeError("image-selection-rollback-marker"),
        ):
            failed_apply = self.client.post(
                apply_url,
                data=json.dumps(apply_data),
                content_type="application/json",
            )
        self.assertEqual(failed_apply.status_code, 500, failed_apply.content)
        self.product.refresh_from_db()
        self.assertNotEqual(self.product.image_stored_name, selected.stored_name)
        self.assertEqual(ProductRevision.objects.filter(product=self.product).count(), 1)
        self.assertTrue(
            all(review.status == "submitted" for review in HumanReview.objects.filter(task_id=self.workflow_id))
        )
        self.assertEqual(WorkflowTask.objects.get(pk=self.workflow_id).status, "waiting_human")
        self.product_subtask.refresh_from_db()
        self.assertEqual(self.product_subtask.status, "waiting_human")

        applied = self.client.post(
            apply_url,
            data=json.dumps(apply_data),
            content_type="application/json",
        )
        self.assertEqual(applied.status_code, 200, applied.content)
        self.product.refresh_from_db()
        self.assertEqual(self.product.image_filename, selected.original_name)
        self.assertEqual(self.product.image_stored_name, selected.stored_name)
        old_revision = ProductRevision.objects.get(product=self.product, version=1)
        old_image_ref = old_revision.source_refs["image"]
        revisions = list(ProductRevision.objects.filter(product=self.product).order_by("version"))
        self.assertEqual(len(revisions), 2)
        self.assertEqual(revisions[0].source_refs["image"], old_image_ref)
        self.assertNotEqual(revisions[0].source_refs["image"]["task_file_id"], selected.id)
        self.assertEqual(revisions[1].snapshot["image_filename"], selected.original_name)
        self.assertEqual(revisions[1].source_refs["image"]["task_file_id"], selected.id)
        self.assertEqual(
            revisions[1].source_refs["human_image_selection"],
            {
                "human_review_id": self.image_review.id,
                "task_file_id": selected.id,
                "original_name": selected.original_name,
                "stored_name": selected.stored_name,
            },
        )
        self.image_review.refresh_from_db()
        self.assertEqual(self.image_review.status, "approved")
        self.assertEqual(self.image_review.answer["request_fingerprint"], receipt["request_fingerprint"])

        self.product_subtask.refresh_from_db()
        self.assertEqual(self.product_subtask.status, "queued")
        apply_step = WorkflowStep.objects.filter(
            task_id=self.workflow_id,
            step_key="apply_review_cycle",
            status="completed",
        ).latest("created_at")
        resume = apply_step.output_refs["resume_authority"][self.product_subtask.id]
        resume_key = (
            f"workflow:{self.workflow_id}:subtask:{self.product_subtask.id}:resume:"
            f"{apply_step.id}:prior:{resume['expected_prior_step_id'] or 'none'}:"
            f"attempt:{resume['next_attempt']}"
        )
        rerun = self.client.post(
            f"/api/workflow-tasks/{self.workflow_id}/subtasks/{self.product_subtask.id}/dispatch",
            data=json.dumps({"idempotency_key": resume_key}),
            content_type="application/json",
        )
        self.assertEqual(rerun.status_code, 200, rerun.content)
        latest = WorkflowStep.objects.filter(
            task_id=self.workflow_id,
            step_key=f"subtask:{self.product_subtask.id}",
        ).order_by("-attempt").first()
        result = latest.output_refs["result_snapshot"]["result"]
        product_result = next(item for item in result["products"] if item["product_id"] == self.product.id)
        self.assertEqual(
            [item["task_file_id"] for item in product_result["image_candidates"]],
            [selected.id],
        )
        self.assertEqual(self.image_review.answer["request_fingerprint"], receipt["request_fingerprint"])

        delivery_subtask = SubTask.objects.get(
            task_id=self.workflow_id,
            agent_role="delivery_quality",
        )
        delivery_resume = apply_step.output_refs["resume_authority"][delivery_subtask.id]
        delivery_key = (
            f"workflow:{self.workflow_id}:subtask:{delivery_subtask.id}:resume:"
            f"{apply_step.id}:prior:{delivery_resume['expected_prior_step_id'] or 'none'}:"
            f"attempt:{delivery_resume['next_attempt']}"
        )
        delivery = self.client.post(
            f"/api/workflow-tasks/{self.workflow_id}/subtasks/{delivery_subtask.id}/dispatch",
            data=json.dumps({"idempotency_key": delivery_key}),
            content_type="application/json",
        )
        self.assertEqual(delivery.status_code, 200, delivery.content)
        delivery_subtask.refresh_from_db()
        self.assertEqual(delivery_subtask.output_refs["result"]["status"], "ready_for_generation")
        generation = self.client.post(
            f"/api/workflow-tasks/{self.workflow_id}/deliverables",
            data=json.dumps({"idempotency_key": "image-selection-generation"}),
            content_type="application/json",
        )
        self.assertEqual(generation.status_code, 200, generation.content)
        self.assertEqual(generation.json()["quality_status"], "passed")
        from workbench.models import ArtifactVersion

        generated_version = ArtifactVersion.objects.filter(
            artifact__task_id=self.workflow_id,
        ).first()
        self.assertIsNotNone(generated_version)
        generated_product = generated_version.snapshot["products"][0]
        self.assertEqual(generated_product["task_file_id"], selected.id)
        self.assertEqual(
            generated_product["image_sha256"],
            hashlib.sha256((Path(settings.MEDIA_ROOT) / selected.stored_name).read_bytes()).hexdigest(),
        )

