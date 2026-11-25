from pathlib import Path
from tempfile import TemporaryDirectory

from django.conf import settings
from django.contrib.auth.models import Group, User
from django.test import override_settings
from django.urls import reverse
from django.utils import timezone

from enterprise_portal.testing import EmailVerifiedTestCase
from workbench.models import EventLog, Product, ProductRevision, TaskFile
from workbench.workflows.orchestrator import WorkflowOrchestrator
from workbench.workflows.prepare import create_prepared_workflow

from .test_workflow_delivery_review import prepare_delivery_batch


def prepare_sku_revision_batch(title, snapshot=None):
    facts = snapshot or {
        "name": "Ribbon", "category": "trim", "material": "cotton",
        "size": "25mm", "color": "red", "image_filename": "SKU-01.svg",
    }
    batch = prepare_delivery_batch(title, {**facts, "sku": "DUP-01"}, english_name="")
    first = Product.objects.get(task=batch)
    base = first.revisions.get().snapshot
    suffix = f"{batch.pk}-second.svg"
    original_name = "second-item.svg"
    now = timezone.now()
    (Path(settings.MEDIA_ROOT) / suffix).write_bytes(
        b'<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><circle cx="5" cy="5" r="4"/></svg>',
    )
    image = TaskFile.objects.create(task=batch, kind="image", original_name=original_name,
                                    stored_name=suffix, created_at=now)
    facts = {**base, "sku": first.sku, "name": "第二件商品", "image_filename": original_name}
    second = Product.objects.create(task=batch, position=1, image_stored_name=suffix, created_at=now,
                                      updated_at=now, **{key: value for key, value in facts.items()
                                                        if key != "english_name"})
    ProductRevision.objects.create(
        product=second, version=1, status="draft", snapshot={**facts, "english_name": "Second Ribbon"},
        source_refs={"image": {"task_file_id": image.pk, "original_name": original_name, "stored_name": suffix}},
    )
    return batch


class EnterpriseSkuRevisionReviewTests(EmailVerifiedTestCase):
    def test_same_cycle_contains_two_sku_reviews_a_version_confirmation_and_a_literal(self):
        with TemporaryDirectory() as directory, override_settings(MEDIA_ROOT=Path(directory)):
            self.check_cycle()

    def check_cycle(self):
        owner = User.objects.create_superuser("sku-revision-owner")
        factory = User.objects.create_user("sku-revision-factory")
        factory.groups.add(Group.objects.create(name="工厂登记员"))
        self.client.force_login(owner)
        batch = prepare_sku_revision_batch("合成重复 SKU 与版本")
        first, second = Product.objects.filter(task=batch).order_by("position")
        frozen = second.revisions.get()
        original_snapshot = frozen.snapshot
        workflow = create_prepared_workflow(batch_id=batch.pk, user_goal="整理商品基础资料")
        subtask = workflow.subtasks.get(agent_role="product_profile")
        WorkflowOrchestrator().dispatch_subtask(subtask.pk, "test:sku-revision")
        review_set = workflow.human_reviews
        self.assertEqual(review_set.count(), 4)

        def submit(field, value):
            product, signal = field
            kind, issue = signal
            review = review_set.get(
                source_conflict__source_refs__product_id=product.pk,
                **{f"source_conflict__source_refs__signal__{kind}": issue},
            )
            url = reverse("enterprise-submit-english-review", args=[workflow.pk, review.pk])
            return self.client.post(url, value)

        detail = reverse("enterprise-workflow-detail", args=[workflow.pk])
        apply = reverse("enterprise-apply-english-review", args=[workflow.pk])
        first_sku = (first, ("uncertainty", "duplicate_sku"))
        second_sku = (second, ("uncertainty", "duplicate_sku"))
        confirm = (second, ("uncertainty", "current_revision_not_confirmed"))
        english = (first, ("missing_field", "english_name"))
        page = self.client.get(detail)
        self.assertContains(page, 'name="resolved_sku" required maxlength="120"', count=2)
        self.assertContains(page, "冻结商品版本 1")
        self.assertContains(page, "Second Ribbon")
        self.assertNotContains(page, "应用本批审核")
        self.assertEqual(submit(first_sku, {"resolved_sku": "x" * 121}).status_code, 400)
        self.assertEqual(submit(confirm, {"confirmed": "yes", "revision_id": first.revisions.get().pk}).status_code, 400)
        self.assertEqual(submit(confirm, {"confirmed": "no"}).status_code, 400)
        self.client.force_login(factory)
        self.assertEqual(submit(confirm, {"confirmed": "yes"}).status_code, 403)
        self.assertEqual(submit(first_sku, {"resolved_sku": "DUP-01"}).status_code, 403)
        self.client.force_login(owner)
        foreign = create_prepared_workflow(batch_id=prepare_delivery_batch("跨批").pk, user_goal="整理商品基础资料")
        cross_url = reverse("enterprise-submit-english-review", args=[foreign.pk, review_set.first().pk])
        self.assertEqual(self.client.post(cross_url, {"confirmed": "yes"}).status_code, 404)

        first_result = submit(first_sku, {"resolved_sku": "DUP-01"})
        self.assertEqual(first_result.status_code, 303)
        self.assertEqual(submit(second_sku, {"resolved_sku": " DUP-01 "}).status_code, 409)
        second_result = submit(second_sku, {"resolved_sku": " DUP-02 "})
        self.assertEqual(second_result.status_code, 303)
        self.assertEqual(submit(second_sku, {"resolved_sku": " DUP-02 "})["Location"], second_result["Location"])
        self.assertNotContains(self.client.get(detail), "应用本批审核")
        stale = ProductRevision.objects.create(product=second, version=2, status="draft",
                                               snapshot=frozen.snapshot, source_refs=frozen.source_refs)
        self.assertEqual(submit(confirm, {"confirmed": "yes"}).status_code, 409)
        stale.delete()
        confirm_result = submit(confirm, {"confirmed": "yes"})
        self.assertEqual(confirm_result.status_code, 303)
        self.assertEqual(submit(english, {"english_name": "Ribbon"}).status_code, 303)
        self.assertEqual(ProductRevision.objects.filter(product__task=batch).count(), 2)
        token = self.client.get(detail).context["english_review"]["confirmation"]
        response = self.client.post(apply, {"confirmation": token})
        self.assertEqual(response.status_code, 303)
        self.assertEqual(self.client.post(apply, {"confirmation": token})["Location"], response["Location"])
        self.assertEqual(submit(confirm, {"confirmed": "yes"})["Location"], confirm_result["Location"])
        self.assertEqual(ProductRevision.objects.filter(product__task=batch).count(), 4)
        second.refresh_from_db()
        frozen.refresh_from_db()
        self.assertEqual(second.sku, "DUP-02")
        self.assertEqual(frozen.status, "draft")
        self.assertEqual(frozen.snapshot, original_snapshot)
        self.assertEqual(second.revisions.get(version=2).status, "confirmed")
        self.assertEqual(EventLog.objects.filter(task=workflow, event_type="human_review_cycle_applied").count(), 1)
