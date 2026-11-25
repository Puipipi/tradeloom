from pathlib import Path
from tempfile import TemporaryDirectory

from django.conf import settings
from django.contrib.auth.models import Group, User
from django.test import Client, override_settings
from django.urls import reverse
from django.utils import timezone

from enterprise_portal.testing import EmailVerifiedTestCase
from workbench.models import EventLog, Product, ProductRevision, TaskFile
from workbench.workflows.orchestrator import WorkflowOrchestrator
from workbench.workflows.prepare import create_prepared_workflow

from .test_workflow_delivery_review import prepare_delivery_batch


SECOND_IMAGE = b'<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><circle r="4"/></svg>'


class EnterpriseImageChoiceTests(EmailVerifiedTestCase):
    def test_image_choice_is_scoped_and_applied_with_the_complete_batch(self):
        with TemporaryDirectory() as directory, override_settings(MEDIA_ROOT=Path(directory)):
            self.check_image_choice(Path(directory))

    def check_image_choice(self, media):
        batch = prepare_delivery_batch("两个图片候选", english_name="")
        product = Product.objects.get(task=batch)
        (media / "different.svg").write_bytes(SECOND_IMAGE)
        candidate = TaskFile.objects.create(
            task=batch, kind="image", original_name=product.image_filename, stored_name="different.svg",
            created_at=timezone.now(),
        )
        foreign = TaskFile.objects.get(task=prepare_delivery_batch("同名跨批图片"), kind="image")
        workflow = create_prepared_workflow(batch_id=batch.pk, user_goal="检查商品图片")
        subtask = workflow.subtasks.get(agent_role="product_profile")
        WorkflowOrchestrator().dispatch_subtask(subtask.pk, "test:review:two-images")
        image_review = workflow.human_reviews.get(
            source_conflict__source_refs__signal__uncertainty="ambiguous_image_candidate",
        )
        english_review = workflow.human_reviews.get(source_conflict__source_refs__signal__missing_field="english_name")

        owner = User.objects.create_superuser("image-review-owner")
        factory = User.objects.create_user("image-review-factory")
        factory.groups.add(Group.objects.create(name="工厂登记员"))
        self.client.force_login(owner)
        detail = reverse("enterprise-workflow-detail", args=[workflow.pk])
        submit = reverse("enterprise-submit-english-review", args=[workflow.pk, image_review.pk])
        submit_english = reverse("enterprise-submit-english-review", args=[workflow.pk, english_review.pk])
        apply = reverse("enterprise-apply-english-review", args=[workflow.pk])
        preview = reverse("enterprise-review-image-preview", args=[workflow.pk, image_review.pk, candidate.pk])
        foreign_preview = reverse("enterprise-review-image-preview", args=[workflow.pk, image_review.pk, foreign.pk])
        other_workflow = create_prepared_workflow(batch_id=foreign.task_id, user_goal="另一批商品目录")
        cross_workflow_preview = reverse(
            "enterprise-review-image-preview", args=[other_workflow.pk, image_review.pk, candidate.pk],
        )
        page = self.client.get(detail)
        self.assertContains(page, 'name="task_file_id"', count=2)
        self.assertNotContains(page, "应用本批审核")
        session = self.client.session
        csrf_client = Client(enforce_csrf_checks=True)
        csrf_client.cookies[settings.SESSION_COOKIE_NAME] = session.session_key
        choice = {"task_file_id": candidate.pk}
        self.assertEqual(self.client.post(submit, {"task_file_id": " "}).status_code, 400)
        self.assertEqual(self.client.post(submit, {"task_file_id": [candidate.pk, foreign.pk]}).status_code, 400)
        self.assertEqual(csrf_client.post(submit, choice).status_code, 403)
        self.client.force_login(factory)
        self.assertEqual(self.client.get(preview).status_code, 403)
        self.assertEqual(self.client.post(submit, choice).status_code, 403)
        self.client.force_login(owner)
        self.assertEqual(self.client.get(foreign_preview).status_code, 404)
        self.assertEqual(self.client.get(cross_workflow_preview).status_code, 404)
        self.assertEqual(self.client.post(submit, {"task_file_id": foreign.pk}).status_code, 409)
        image = self.client.get(preview)
        self.assertEqual(image.status_code, 200)
        self.assertEqual(image.content, SECOND_IMAGE)
        self.assertEqual(image["Content-Type"], "image/svg+xml")
        self.assertEqual(image["Content-Security-Policy"], "sandbox; default-src 'none'")
        self.assertIn("no-store", image["Cache-Control"])
        (media / "different.svg").write_bytes(b'<svg xmlns="http://www.w3.org/2000/svg"><script/></svg>')
        self.assertEqual(self.client.get(preview).status_code, 404)
        (media / "different.svg").write_bytes(SECOND_IMAGE)
        candidate.original_name = "伪造元数据.svg"
        candidate.save(update_fields=["original_name"])
        self.assertEqual(self.client.get(preview).status_code, 409)
        self.assertEqual(self.client.post(submit, choice).status_code, 409)
        candidate.original_name = product.image_filename
        candidate.save(update_fields=["original_name"])

        first_receipt = self.client.post(submit, choice)
        self.assertEqual(first_receipt.status_code, 303)
        self.assertEqual(self.client.post(submit, choice)["Location"], first_receipt["Location"])
        self.assertEqual(self.client.post(submit, {"task_file_id": TaskFile.objects.exclude(pk=candidate.pk).get(task=batch, kind="image").pk}).status_code, 409)
        self.assertNotContains(self.client.get(detail), "应用本批审核")
        product.refresh_from_db()
        self.assertNotEqual(product.image_stored_name, candidate.stored_name)
        self.assertEqual(self.client.post(submit_english, {"english_name": "Ribbon"}).status_code, 303)
        confirmation = self.client.get(detail).context["english_review"]["confirmation"]
        candidate.original_name = "选择后来源已变化.svg"
        candidate.save(update_fields=["original_name"])
        self.assertEqual(self.client.post(apply, {"confirmation": confirmation}).status_code, 409)
        self.assertEqual(ProductRevision.objects.filter(product=product).count(), 1)
        candidate.original_name = product.image_filename
        candidate.save(update_fields=["original_name"])
        applied = self.client.post(apply, {"confirmation": confirmation})
        self.assertEqual(applied.status_code, 303)
        self.assertEqual(self.client.post(apply, {"confirmation": confirmation})["Location"], applied["Location"])
        self.assertEqual(self.client.post(submit, choice)["Location"], first_receipt["Location"])
        revisions = ProductRevision.objects.filter(product=product).order_by("version")
        self.assertEqual(revisions.count(), 2)
        self.assertEqual(revisions.last().source_refs["human_image_selection"]["task_file_id"], candidate.pk)
        self.assertEqual(revisions.last().snapshot["english_name"], "Ribbon")
        product.refresh_from_db()
        self.assertEqual(product.image_stored_name, candidate.stored_name)
        self.assertEqual(EventLog.objects.filter(task=workflow, event_type="human_review_cycle_applied").count(), 1)
