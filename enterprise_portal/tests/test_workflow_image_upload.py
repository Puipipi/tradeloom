from pathlib import Path
from tempfile import TemporaryDirectory
from urllib.parse import parse_qs, urlsplit

from django.conf import settings
from django.contrib.auth.models import Group, User
from django.core.files.uploadedfile import SimpleUploadedFile
from django.test import Client, override_settings
from django.urls import reverse
from django.utils import timezone

from enterprise_portal.testing import EmailVerifiedTestCase
from workbench.models import EventLog, Product, ProductRevision, Task, TaskFile
from workbench.workflows.orchestrator import WorkflowOrchestrator
from workbench.workflows.prepare import create_prepared_workflow


IMAGE = b'<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><circle cx="5" cy="5" r="4"/></svg>'


def prepare_missing_image_batch(title, snapshot=None):
    now = timezone.now()
    batch = Task.objects.create(title=title, mode="demo", status="confirmed", created_at=now, updated_at=now)
    snapshot = snapshot or {"sku": "SKU-01", "name": "Ribbon", "category": "trim", "material": "cotton",
                            "size": "25mm", "color": "red", "image_filename": ""}
    product = Product.objects.create(task=batch, position=0, created_at=now, updated_at=now, **snapshot)
    ProductRevision.objects.create(product=product, version=1, status="confirmed",
                                   snapshot={**snapshot, "english_name": ""})
    return batch


def prepare_missing_image_review(title):
    batch = prepare_missing_image_batch(title)
    workflow = create_prepared_workflow(batch_id=batch.pk, user_goal="检查商品资料")
    subtask = workflow.subtasks.get(agent_role="product_profile")
    WorkflowOrchestrator().dispatch_subtask(subtask.pk, f"test:review:missing-image:{workflow.pk}")
    review = workflow.human_reviews.get(source_conflict__source_refs__signal__missing_field="图片")
    return workflow, review


class EnterpriseImageUploadTests(EmailVerifiedTestCase):
    def test_upload_receipt_and_apply_are_separate_and_idempotent(self):
        with TemporaryDirectory() as directory, override_settings(MEDIA_ROOT=Path(directory)):
            self.check_upload(Path(directory))

    def check_upload(self, media):
        owner = User.objects.create_superuser("upload-review-owner")
        factory = User.objects.create_user("upload-review-factory")
        factory.groups.add(Group.objects.create(name="工厂登记员"))
        self.client.force_login(owner)
        workflow, review = prepare_missing_image_review("合成缺图")
        other, other_review = prepare_missing_image_review("隔离缺图")
        detail = reverse("enterprise-workflow-detail", args=[workflow.pk])
        upload = reverse("enterprise-review-image-upload", args=[workflow.pk, review.pk])
        other_upload = reverse("enterprise-review-image-upload", args=[other.pk, other_review.pk])
        submit = reverse("enterprise-submit-english-review", args=[workflow.pk, review.pk])
        other_submit = reverse("enterprise-submit-english-review", args=[other.pk, other_review.pk])
        apply = reverse("enterprise-apply-english-review", args=[workflow.pk])
        rows = self.client.get(detail).context["english_review"]["rows"]
        token = next(row["upload_confirmation"] for row in rows if row["id"] == review.pk)

        def data(confirmation=token, content=IMAGE, filename="ribbon.svg"):
            return {"image": SimpleUploadedFile(filename, content), "confirmation": confirmation}

        csrf_client = Client(enforce_csrf_checks=True)
        csrf_client.cookies[settings.SESSION_COOKIE_NAME] = self.client.session.session_key
        self.assertEqual(csrf_client.post(upload, data()).status_code, 403)
        self.client.force_login(factory)
        self.assertEqual(self.client.post(upload, data()).status_code, 403)
        self.client.force_login(owner)
        self.assertEqual(self.client.post(other_upload, data()).status_code, 403)
        self.assertEqual(self.client.post(upload, data(token + "x")).status_code, 400)
        self.assertEqual(self.client.post(upload, data(filename="wrong.png")).status_code, 409)
        self.assertEqual(self.client.post(upload, data(content=b"x" * (5 * 1024 * 1024 + 1))).status_code, 400)
        workflow.status = "running"
        workflow.save(update_fields=["status"])
        self.assertEqual(self.client.post(upload, data()).status_code, 409)
        workflow.status = "waiting_human"
        workflow.save(update_fields=["status"])
        self.assertFalse(TaskFile.objects.exists())
        self.assertEqual(list(media.iterdir()), [])
        self.assertEqual(self.client.post(submit, {"upload_step_id": "forged"}).status_code, 409)

        result = self.client.post(upload, data())
        self.assertEqual(result.status_code, 303)
        self.assertEqual(self.client.post(upload, data())["Location"], result["Location"])
        self.assertEqual(self.client.post(upload, data(filename="changed.svg")).status_code, 409)
        step_id = parse_qs(urlsplit(result["Location"]).query)["uploaded"][0]
        preview = reverse("enterprise-review-image-upload-preview", args=[workflow.pk, review.pk, step_id])
        wrong_preview = reverse("enterprise-review-image-upload-preview", args=[other.pk, other_review.pk, step_id])
        self.assertEqual(self.client.get(wrong_preview).status_code, 404)
        self.assertEqual(self.client.post(other_submit, {"upload_step_id": step_id}).status_code, 409)
        self.assertContains(self.client.get(result["Location"]), "已上传 ribbon.svg")
        self.assertNotContains(self.client.get(detail), "应用本批审核")
        review.refresh_from_db()
        self.assertEqual(review.status, "pending")
        response = self.client.get(preview)
        self.assertEqual(response.content, IMAGE)
        self.assertEqual(response["Content-Security-Policy"], "sandbox; default-src 'none'")
        self.assertIn("no-store", response["Cache-Control"])

        file = TaskFile.objects.get(task_id=workflow.batch_id)
        stored = media / file.stored_name
        stored.write_bytes(IMAGE.replace(b'r="4"', b'r="3"'))
        self.assertEqual(self.client.get(preview).status_code, 404)
        self.assertEqual(self.client.post(submit, {"upload_step_id": step_id}).status_code, 409)
        stored.write_bytes(IMAGE)
        submitted = self.client.post(submit, {"upload_step_id": step_id})
        self.assertEqual(submitted.status_code, 303)
        self.assertEqual(self.client.post(submit, {"upload_step_id": step_id})["Location"], submitted["Location"])
        english = workflow.human_reviews.get(source_conflict__source_refs__signal__missing_field="english_name")
        english_url = reverse("enterprise-submit-english-review", args=[workflow.pk, english.pk])
        self.assertEqual(self.client.post(english_url, {"english_name": "Ribbon"}).status_code, 303)
        confirmation = self.client.get(detail).context["english_review"]["confirmation"]
        applied = self.client.post(apply, {"confirmation": confirmation})
        self.assertEqual(applied.status_code, 303)
        self.assertEqual(self.client.post(apply, {"confirmation": confirmation})["Location"], applied["Location"])
        self.assertEqual(self.client.post(upload, data())["Location"], result["Location"])
        product = Product.objects.get(task_id=workflow.batch_id)
        revisions = ProductRevision.objects.filter(product=product).order_by("version")
        self.assertEqual(revisions.count(), 2)
        self.assertEqual(revisions.last().source_refs["human_image_upload"]["upload_step_id"], step_id)
        self.assertEqual(product.image_stored_name, file.stored_name)
        self.assertEqual(TaskFile.objects.filter(task_id=workflow.batch_id).count(), 1)
        self.assertEqual(EventLog.objects.filter(task=workflow, event_type="human_review_image_uploaded").count(), 1)
        self.assertEqual(EventLog.objects.filter(task=workflow, event_type="human_review_cycle_applied").count(), 1)
