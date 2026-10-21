from __future__ import annotations

import csv
import base64
import copy
import hashlib
import io
import json
import os
import tempfile
from pathlib import Path
from unittest.mock import patch

from django.conf import settings
from django.test import Client, TransactionTestCase, override_settings

from workbench.models import EventLog, HumanReview, Product, ProductRevision, SubTask, TaskFile, WorkflowStep
from workbench.workflows.prepare import create_prepared_workflow


class MissingImageUploadIntegrationTests(TransactionTestCase):
    """Exercise the no-image path from normal batch creation through review upload."""

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
        self.temp = tempfile.TemporaryDirectory(prefix="task13b-missing-image-")
        self.root = Path(self.temp.name)
        self.media = self.root / "media"
        self.artifacts = self.root / "artifacts"
        self.media.mkdir()
        self.artifacts.mkdir()
        self.settings = override_settings(
            MEDIA_ROOT=self.media,
            TRADELOOM_ARTIFACT_ROOT=self.artifacts,
        )
        self.settings.enable()
        self.client = Client()

    def tearDown(self):
        self.settings.disable()
        self.temp.cleanup()

    def _create_normal_pipeline(self):
        products = io.StringIO(newline="")
        writer = csv.writer(products, lineterminator="\n")
        writer.writerow(("sku", "name", "category", "material", "size", "color", "image_filename"))
        writer.writerow(("NO-IMAGE-A", "缺图商品", "丝带", "涤纶", "25mm", "红色", ""))
        writer.writerow(("HAS-IMAGE-B", "已有图商品", "丝带", "棉", "30mm", "蓝色", "HAS-IMAGE-B.svg"))
        csv_upload = io.BytesIO(products.getvalue().encode("utf-8-sig"))
        csv_upload.name = "products.csv"
        existing_image = io.BytesIO(
            b'<svg xmlns="http://www.w3.org/2000/svg" width="2" height="2"><rect width="2" height="2" fill="blue"/></svg>'
        )
        existing_image.name = "HAS-IMAGE-B.svg"
        created = self.client.post(
            "/api/tasks",
            {"title": "正常流水线缺图测试", "products_csv": csv_upload, "images": [existing_image]},
        )
        self.assertEqual(created.status_code, 200, created.content)
        batch_id = created.json()["id"]
        workflow = create_prepared_workflow(batch_id=batch_id, user_goal="补充缺失商品图片")
        page = self.client.get(f"/workflow-tasks/{workflow.id}")
        target = page.context["dispatch_target"]
        self.assertEqual(page.status_code, 200, page.content)
        dispatched = self.client.post(
            target["url"],
            data=json.dumps({"idempotency_key": target["idempotency_key"]}),
            content_type="application/json",
        )
        self.assertEqual(dispatched.status_code, 200, dispatched.content)
        image_review = next(
            review
            for review in HumanReview.objects.filter(task=workflow)
            if (review.source_conflict.get("source_refs", {}).get("signal", {}).get("missing_field") == "图片"
                and "no_image_candidate" in review.source_conflict.get("source_refs", {}).get("signal", {}).get("uncertainties", []))
        )
        self.assertEqual(image_review.status, "pending")
        return batch_id, workflow, image_review

    def test_normal_pipeline_missing_image_can_be_uploaded_as_review_evidence(self):
        batch_id, workflow, image_review = self._create_normal_pipeline()
        review_source_before = copy.deepcopy(image_review.source_conflict)
        origin_step = WorkflowStep.objects.get(pk=image_review.source_conflict["origin_step_id"])
        origin_output_before = copy.deepcopy(origin_step.output_refs)
        product_a_before = Product.objects.get(task_id=batch_id, sku="NO-IMAGE-A")
        prior_revision = ProductRevision.objects.filter(product=product_a_before).order_by("-version").first()
        prior_revision_values = (prior_revision.snapshot, prior_revision.source_refs, prior_revision.status)
        uploaded_image = io.BytesIO(
            b'<svg xmlns="http://www.w3.org/2000/svg" width="2" height="2"><circle cx="1" cy="1" r="1" fill="red"/></svg>'
        )
        uploaded_image.name = "operator-selected-image.svg"
        upload_url = f"/api/workflow-tasks/{workflow.id}/reviews/{image_review.id}/image"
        upload_data = {
            "image": uploaded_image,
            "idempotency_key": "missing-image-key-1",
            "review_key": image_review.review_key,
            "reviewer": "tester",
        }
        page_before_upload = self.client.get(f"/workflow-tasks/{workflow.id}")
        self.assertEqual(page_before_upload.status_code, 200)
        upload_form_html = page_before_upload.content.decode("utf-8")
        self.assertIn('class="review-image-upload-form"', upload_form_html)
        self.assertIn('name="image" type="file"', upload_form_html)
        self.assertNotIn("已上传补图 operator-selected-image.svg", upload_form_html)
        first_upload = self.client.post(upload_url, upload_data)
        self.assertEqual(first_upload.status_code, 201, first_upload.content)
        first_receipt = first_upload.json()
        upload_preview = self.client.get(
            f"/api/workflow-tasks/{workflow.id}/task-files/{first_receipt['task_file_id']}/preview"
        )
        self.assertEqual(upload_preview.status_code, 200)
        self.assertIn("nosniff", upload_preview["X-Content-Type-Options"])
        self.assertIn(b"circle", b"".join(upload_preview.streaming_content))
        upload_preview.close()
        image_review.refresh_from_db()
        self.assertEqual(image_review.status, "pending")
        self.assertEqual(image_review.source_conflict, review_source_before)
        self.assertEqual(Product.objects.get(pk=product_a_before.id).image_stored_name, "")
        page_after_upload = self.client.get(f"/workflow-tasks/{workflow.id}")
        self.assertEqual(page_after_upload.status_code, 200)
        upload_page_html = page_after_upload.content.decode("utf-8")
        self.assertIn(first_receipt["upload_step_id"], upload_page_html)
        self.assertIn("review-typed-form", upload_page_html)
        self.assertIn(f"/api/workflow-tasks/{workflow.id}/task-files/{first_receipt['task_file_id']}/preview", upload_page_html)
        first_file_count = TaskFile.objects.filter(task_id=batch_id, kind="image").count()
        first_step_count = WorkflowStep.objects.filter(task=workflow, step_key__startswith="review_image_upload:").count()
        first_event_count = EventLog.objects.filter(task=workflow, event_type="human_review_image_uploaded").count()
        replay_image = io.BytesIO(uploaded_image.getvalue())
        replay_image.name = uploaded_image.name
        replay = self.client.post(upload_url, {**upload_data, "image": replay_image})
        self.assertEqual(replay.status_code, 201, replay.content)
        self.assertEqual(replay.json(), first_receipt)
        self.assertEqual(TaskFile.objects.filter(task_id=batch_id, kind="image").count(), first_file_count)
        self.assertEqual(WorkflowStep.objects.filter(task=workflow, step_key__startswith="review_image_upload:").count(), first_step_count)
        self.assertEqual(EventLog.objects.filter(task=workflow, event_type="human_review_image_uploaded").count(), first_event_count)

        changed_image = io.BytesIO(b'<svg xmlns="http://www.w3.org/2000/svg" width="2" height="2"><rect width="2" height="2" fill="green"/></svg>')
        changed_image.name = "different-name.svg"
        changed_key_replay = self.client.post(upload_url, {**upload_data, "image": changed_image})
        self.assertEqual(changed_key_replay.status_code, 409)

        second_image_bytes = b'<svg xmlns="http://www.w3.org/2000/svg" width="3" height="3"><rect width="3" height="3" fill="orange"/></svg>'
        second_image = io.BytesIO(second_image_bytes)
        second_image.name = "operator-final-artwork.svg"
        second_upload_payload = {
            "idempotency_key": "missing-image-key-2",
            "review_key": image_review.review_key,
            "reviewer": "tester",
        }
        second_upload = self.client.post(
            upload_url,
            {"image": second_image, **second_upload_payload},
        )
        self.assertEqual(second_upload.status_code, 201, second_upload.content)
        self.assertNotEqual(second_upload.json()["task_file_id"], first_receipt["task_file_id"])
        self.assertEqual(Product.objects.get(task_id=batch_id, sku="NO-IMAGE-A").image_stored_name, "")
        self.assertEqual(image_review.status, "pending")

        reviews = list(HumanReview.objects.filter(task=workflow).order_by("id"))
        for review in reviews:
            refs = review.source_conflict["source_refs"]
            signal = refs["signal"]
            if review.id == image_review.id:
                answer = {"type": "provide_image", "upload_step_id": second_upload.json()["upload_step_id"]}
            elif signal.get("missing_field"):
                field = signal["missing_field"]
                answer = {"type": "set_literal_field", "field": field, "value": "人审确认资料"}
            elif signal.get("uncertainty") == "current_revision_not_confirmed":
                answer = {"type": "confirm_current_revision", "revision_id": refs["revision_id"]}
            else:
                answer = {"note": "人工核对"}
            response = self.client.post(
                f"/api/workflow-tasks/{workflow.id}/reviews/{review.id}/submit",
                data=json.dumps({"review_key": review.review_key, "answer": answer, "reviewer": "tester"}),
                content_type="application/json",
            )
            self.assertEqual(response.status_code, 200, response.content)
        def replay_second_upload():
            replay_image = io.BytesIO(second_image_bytes)
            replay_image.name = "operator-final-artwork.svg"
            return self.client.post(upload_url, {"image": replay_image, **second_upload_payload})

        before_submitted_replay = (
            WorkflowStep.objects.filter(task=workflow, step_key__startswith="review_image_upload:").count(),
            TaskFile.objects.filter(task_id=batch_id, kind="image").count(),
            EventLog.objects.filter(task=workflow, event_type="human_review_image_uploaded").count(),
        )
        submitted_replay = replay_second_upload()
        self.assertEqual(submitted_replay.status_code, 201, submitted_replay.content)
        self.assertEqual(submitted_replay.json(), second_upload.json())
        self.assertEqual(before_submitted_replay, (
            WorkflowStep.objects.filter(task=workflow, step_key__startswith="review_image_upload:").count(),
            TaskFile.objects.filter(task_id=batch_id, kind="image").count(),
            EventLog.objects.filter(task=workflow, event_type="human_review_image_uploaded").count(),
        ))
        cycle = self.client.post(
            f"/api/workflow-tasks/{workflow.id}/reviews/apply",
            data=json.dumps({"review_ids": [item.id for item in reviews], "idempotency_key": "missing-image-cycle-apply", "decision": "apply_and_confirm", "reviewer": "tester"}),
            content_type="application/json",
        )
        self.assertEqual(cycle.status_code, 200, cycle.content)
        before_applied_replay = (
            WorkflowStep.objects.filter(task=workflow, step_key__startswith="review_image_upload:").count(),
            TaskFile.objects.filter(task_id=batch_id, kind="image").count(),
            EventLog.objects.filter(task=workflow, event_type="human_review_image_uploaded").count(),
        )
        applied_replay = replay_second_upload()
        self.assertEqual(applied_replay.status_code, 201, applied_replay.content)
        self.assertEqual(applied_replay.json(), second_upload.json())
        self.assertEqual(before_applied_replay, (
            WorkflowStep.objects.filter(task=workflow, step_key__startswith="review_image_upload:").count(),
            TaskFile.objects.filter(task_id=batch_id, kind="image").count(),
            EventLog.objects.filter(task=workflow, event_type="human_review_image_uploaded").count(),
        ))
        product_a = Product.objects.get(task_id=batch_id, sku="NO-IMAGE-A")
        product_b = Product.objects.get(task_id=batch_id, sku="HAS-IMAGE-B")
        self.assertEqual(product_a.image_filename, "operator-final-artwork.svg")
        self.assertEqual(product_b.image_filename, "HAS-IMAGE-B.svg")
        current_a = ProductRevision.objects.filter(product=product_a).order_by("-version").first()
        self.assertEqual(current_a.source_refs["human_image_upload"]["upload_step_id"], second_upload.json()["upload_step_id"])
        page_after_apply = self.client.get(f"/workflow-tasks/{workflow.id}")
        self.assertEqual(page_after_apply.status_code, 200)
        self.assertIn(second_upload.json()["upload_step_id"], page_after_apply.content.decode("utf-8"))
        image_review.refresh_from_db()
        self.assertEqual(image_review.source_conflict, review_source_before)
        origin_step.refresh_from_db()
        self.assertEqual(origin_step.output_refs, origin_output_before)
        prior_revision.refresh_from_db()
        self.assertEqual((prior_revision.snapshot, prior_revision.source_refs, prior_revision.status), prior_revision_values)

        def dispatch_visible_target():
            page = self.client.get(f"/workflow-tasks/{workflow.id}")
            self.assertEqual(page.status_code, 200, page.content)
            target = page.context["dispatch_target"]
            self.assertIsNotNone(target)
            role = SubTask.objects.get(pk=target["subtask_id"]).agent_role
            result = self.client.post(target["url"], data=json.dumps({"idempotency_key": target["idempotency_key"]}), content_type="application/json")
            step = WorkflowStep.objects.filter(task=workflow, step_key=f"subtask:{target['subtask_id']}").order_by("-attempt").first()
            subtask = SubTask.objects.get(pk=target["subtask_id"])
            self.assertEqual(result.status_code, 200, f"{role}: {result.content}; error={subtask.error_summary}; step={step.error_summary if step else None}; output={step.output_refs if step else None}")

        dispatch_visible_target()
        dispatch_visible_target()
        generated = self.client.post(
            f"/api/workflow-tasks/{workflow.id}/deliverables",
            data=json.dumps({"idempotency_key": "missing-image-generate"}),
            content_type="application/json",
        )
        self.assertEqual(generated.status_code, 200, generated.content)
        self.assertEqual(generated.json()["quality_status"], "passed")
        artifacts = self.client.get(f"/api/workflow-tasks/{workflow.id}/deliverables")
        catalog = next(item for item in artifacts.json()["artifacts"] if item["artifact_type"] == "catalog_html")
        preview = self.client.get(catalog["versions"][0]["preview_url"])
        self.assertEqual(preview.status_code, 200, preview.content)
        self.assertIn(base64.b64encode(second_image_bytes).decode("ascii"), preview.content.decode("utf-8"))

        second_workflow = create_prepared_workflow(batch_id=batch_id, user_goal="复用已确认的人审补图")
        page = self.client.get(f"/workflow-tasks/{second_workflow.id}")
        target = page.context["dispatch_target"]
        profile = self.client.post(
            target["url"], data=json.dumps({"idempotency_key": target["idempotency_key"]}),
            content_type="application/json",
        )
        self.assertEqual(profile.status_code, 200, profile.content)
        profile_subtask = SubTask.objects.get(task=second_workflow, agent_role="product_profile")
        self.assertEqual(profile_subtask.status, "completed")
        reused_image = next(
            item
            for item in profile_subtask.output_refs["result"]["products"]
            if item["product_id"] == product_a.id
        )["image_candidates"][0]
        self.assertEqual(reused_image["task_file_id"], second_upload.json()["task_file_id"])
        self.assertEqual(reused_image["match_types"], ["human_review_upload"])

    def test_db_failure_keeps_owned_file_for_same_byte_retry_and_rejects_key_reuse(self):
        batch_id, workflow, review = self._create_normal_pipeline()
        content = b'<svg xmlns="http://www.w3.org/2000/svg" width="2" height="2"><path d="M0 0h2v2H0z" fill="purple"/></svg>'
        image = io.BytesIO(content)
        image.name = "operator-upload.svg"
        payload = {
            "image": image,
            "idempotency_key": "failed-db-upload-key",
            "review_key": review.review_key,
            "reviewer": "failure-test",
        }
        upload_url = f"/api/workflow-tasks/{workflow.id}/reviews/{review.id}/image"
        with patch("workbench.workflows.review_images.TaskFile.objects.create", side_effect=RuntimeError("simulated DB failure")):
            with self.assertRaisesRegex(RuntimeError, "simulated DB failure"):
                self.client.post(upload_url, payload)
        self.assertFalse(WorkflowStep.objects.filter(task=workflow, step_key__startswith="review_image_upload:").exists())
        self.assertFalse(EventLog.objects.filter(task=workflow, event_type="human_review_image_uploaded").exists())
        self.assertEqual(TaskFile.objects.filter(task_id=batch_id, kind="image").count(), 1)
        owned_image = next(self.media.glob("review-upload-*.svg"))
        self.assertEqual(hashlib.sha256(owned_image.read_bytes()).hexdigest(), hashlib.sha256(content).hexdigest())

        retry_image = io.BytesIO(content)
        retry_image.name = "operator-upload.svg"
        retry = self.client.post(upload_url, {**payload, "image": retry_image})
        self.assertEqual(retry.status_code, 201, retry.content)
        self.assertEqual(TaskFile.objects.filter(task_id=batch_id, kind="image").count(), 2)
        self.assertEqual(EventLog.objects.filter(task=workflow, event_type="human_review_image_uploaded").count(), 1)

        changed_image = io.BytesIO(b'<svg xmlns="http://www.w3.org/2000/svg" width="2" height="2"><path d="M0 0h2v2H0z" fill="black"/></svg>')
        changed_image.name = "operator-upload.svg"
        conflict = self.client.post(upload_url, {**payload, "image": changed_image})
        self.assertEqual(conflict.status_code, 409)
        self.assertEqual(hashlib.sha256(owned_image.read_bytes()).hexdigest(), hashlib.sha256(content).hexdigest())

    def test_upload_answer_rejects_other_review_batch_stale_revision_and_corrupt_bytes(self):
        batch_id, workflow, review = self._create_normal_pipeline()
        content = b'<svg xmlns="http://www.w3.org/2000/svg" width="2" height="2"><path d="M0 0h2v2H0z" fill="purple"/></svg>'
        image = io.BytesIO(content)
        image.name = "operator-upload.svg"
        upload = self.client.post(
            f"/api/workflow-tasks/{workflow.id}/reviews/{review.id}/image",
            {"image": image, "idempotency_key": "proof-for-cross-checks", "review_key": review.review_key, "reviewer": "boundary-test"},
        )
        self.assertEqual(upload.status_code, 201, upload.content)
        upload_step_id = upload.json()["upload_step_id"]

        other_review = next(
            item for item in HumanReview.objects.filter(task=workflow)
            if item.id != review.id
        )
        wrong_review = self.client.post(
            f"/api/workflow-tasks/{workflow.id}/reviews/{other_review.id}/submit",
            data=json.dumps({"review_key": other_review.review_key, "answer": {"type": "provide_image", "upload_step_id": upload_step_id}, "reviewer": "boundary-test"}),
            content_type="application/json",
        )
        self.assertEqual(wrong_review.status_code, 409)

        other_batch_id, other_workflow, other_batch_review = self._create_normal_pipeline()
        wrong_batch = self.client.post(
            f"/api/workflow-tasks/{other_workflow.id}/reviews/{other_batch_review.id}/submit",
            data=json.dumps({"review_key": other_batch_review.review_key, "answer": {"type": "provide_image", "upload_step_id": upload_step_id}, "reviewer": "boundary-test"}),
            content_type="application/json",
        )
        self.assertEqual(wrong_batch.status_code, 409)
        self.assertNotEqual(batch_id, other_batch_id)

        product = Product.objects.get(task_id=batch_id, sku="NO-IMAGE-A")
        prior = ProductRevision.objects.filter(product=product).order_by("-version").first()
        ProductRevision.objects.create(
            product=product,
            version=prior.version + 1,
            snapshot=prior.snapshot,
            field_sources=prior.field_sources,
            status=prior.status,
            source_refs=prior.source_refs,
            reviewer=prior.reviewer,
        )
        stale_answer = self.client.post(
            f"/api/workflow-tasks/{workflow.id}/reviews/{review.id}/submit",
            data=json.dumps({"review_key": review.review_key, "answer": {"type": "provide_image", "upload_step_id": upload_step_id}, "reviewer": "boundary-test"}),
            content_type="application/json",
        )
        self.assertEqual(stale_answer.status_code, 409)
        review.refresh_from_db()
        self.assertEqual(review.status, "pending")

    def test_changed_upload_bytes_block_submit(self):
        _batch_id, workflow, review = self._create_normal_pipeline()
        image = io.BytesIO(b'<svg xmlns="http://www.w3.org/2000/svg" width="2" height="2"><circle cx="1" cy="1" r="1"/></svg>')
        image.name = "operator-upload.svg"
        uploaded = self.client.post(
            f"/api/workflow-tasks/{workflow.id}/reviews/{review.id}/image",
            {"image": image, "idempotency_key": "corrupt-bytes-proof", "review_key": review.review_key, "reviewer": "tamper-test"},
        )
        self.assertEqual(uploaded.status_code, 201, uploaded.content)
        task_file = TaskFile.objects.get(pk=uploaded.json()["task_file_id"])
        (self.media / task_file.stored_name).write_bytes(b"corrupted");
        rejected = self.client.post(
            f"/api/workflow-tasks/{workflow.id}/reviews/{review.id}/submit",
            data=json.dumps({"review_key": review.review_key, "answer": {"type": "provide_image", "upload_step_id": uploaded.json()["upload_step_id"]}, "reviewer": "tamper-test"}),
            content_type="application/json",
        )
        self.assertEqual(rejected.status_code, 409)
        review.refresh_from_db()
        self.assertEqual(review.status, "pending")
