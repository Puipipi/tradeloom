from pathlib import Path
from tempfile import TemporaryDirectory

from django.contrib.auth.models import Group, Permission, User
from django.core import signing
from django.test import Client, override_settings
from django.urls import reverse

from enterprise_portal.testing import EmailVerifiedTestCase
from enterprise_portal.workflow_english_review import APPLY_SALT, FIELDS
from workbench.models import EventLog, Product, ProductRevision
from workbench.workflows.orchestrator import WorkflowOrchestrator
from workbench.workflows.prepare import create_prepared_workflow

from .test_workflow_delivery_review import prepare_delivery_batch


def prepare_missing_literal_batch(title):
    return prepare_delivery_batch(title, {
        "sku": "SKU-01", "name": "Ribbon", "category": "trim", "material": "",
        "size": "25mm", "color": "red", "image_filename": "SKU-01.svg",
    }, english_name="")


def dispatch_until_review(workflow):
    for role in ("product_profile", "delivery_quality"):
        subtask = workflow.subtasks.get(agent_role=role)
        WorkflowOrchestrator().dispatch_subtask(subtask.pk, f"test:literal:{subtask.pk}")
        workflow.refresh_from_db()
        if workflow.status == "waiting_human":
            break
    reviews = {}
    for review in workflow.human_reviews.all():
        signal = review.source_conflict["source_refs"]["signal"]
        reviews[signal.get("missing_field") or signal.get("uncertainty")] = review.pk
    return reviews


class EnterpriseEnglishReviewTests(EmailVerifiedTestCase):
    def test_real_review_commits_one_revision_only_after_explicit_apply(self):
        with TemporaryDirectory() as directory, override_settings(MEDIA_ROOT=Path(directory)):
            self.check_actual_review()

    def check_actual_review(self):
        owners = Group.objects.create(name="企业老板")
        owners.permissions.add(*Permission.objects.filter(
            content_type__app_label="enterprise_portal",
            codename__in=("view_business_data", "view_all_enterpriseentry"),
        ))
        owner = User.objects.create_user(username="review-owner")
        peer = User.objects.create_user(username="review-other-owner")
        for user in (owner, peer):
            user.groups.add(owners)
        factory = User.objects.create_user(username="review-factory")
        factory.groups.add(Group.objects.create(name="工厂登记员"))

        batch = prepare_missing_literal_batch("合成商品资料审核")
        workflow = create_prepared_workflow(
            batch_id=batch.pk, user_goal="生成英文目录", task_type="generate_deliverables",
        )
        other = create_prepared_workflow(
            batch_id=prepare_delivery_batch("另一批").pk, user_goal="生成英文目录", task_type="generate_deliverables",
        )
        reviews = dispatch_until_review(workflow)
        self.assertEqual(set(reviews), {"material", "english_name"})
        detail = reverse("enterprise-workflow-detail", args=[workflow.pk])
        submit_url = reverse("enterprise-submit-english-review", args=[workflow.pk, reviews["english_name"]])
        apply_url = reverse("enterprise-apply-english-review", args=[workflow.pk])
        answer = {"english_name": "Reviewed Ribbon"}
        material_url = reverse("enterprise-submit-english-review", args=[workflow.pk, reviews["material"]])
        unverified = Client()
        unverified.force_login(owner)
        self.assertEqual(unverified.post(submit_url, answer).status_code, 302)
        self.client.force_login(factory)
        self.assertEqual(self.client.post(submit_url, answer).status_code, 403)
        self.assertEqual(self.client.post(apply_url, {}).status_code, 403)
        self.assertEqual(self.client.post(material_url, {"material": "cotton"}).status_code, 403)

        self.client.force_login(owner)
        cross_workflow = reverse("enterprise-submit-english-review", args=[other.pk, reviews["english_name"]])
        self.assertEqual(self.client.post(cross_workflow, answer).status_code, 404)
        plan = workflow.steps.get(step_key="center_plan")
        local_plan = plan.input_refs
        plan.input_refs = {**local_plan, "execution_mode": "native_dsh"}
        plan.save(update_fields=["input_refs"])
        self.assertNotContains(self.client.get(detail), 'name="english_name"')
        self.assertEqual(self.client.post(submit_url, answer).status_code, 403)
        self.assertEqual(self.client.post(apply_url, {}).status_code, 403)
        plan.input_refs = local_plan
        plan.save(update_fields=["input_refs"])
        page = self.client.get(detail)
        self.assertContains(page, "待填写", count=2)
        self.assertContains(page, 'name="material" required maxlength="200"')
        self.assertContains(page, "材质（按原文填写）")
        self.assertContains(self.client.post(material_url, {"material": "x" * 201}),
                            "字段 material 超过现有产品字段长度限制", status_code=400)
        self.assertEqual(self.client.post(material_url, {"field": "sku", "material": "cotton"}).status_code, 400)
        self.assertEqual(self.client.post(material_url, {"english_name": "Swapped"}).status_code, 400)
        self.assertNotContains(page, "应用本批审核")
        self.assertEqual(self.client.post(apply_url, {}).status_code, 400)
        submitted = self.client.post(submit_url, answer)
        self.assertEqual(submitted.status_code, 303)
        self.assertContains(self.client.get(submitted["Location"]), "已提交，待应用")
        self.assertEqual(self.client.post(submit_url, answer)["Location"], submitted["Location"])
        self.assertEqual(self.client.post(submit_url, {"english_name": "Different"}).status_code, 409)
        revisions = ProductRevision.objects.filter(product__task=batch).order_by("version")
        self.assertEqual(revisions.count(), 1)
        self.assertNotContains(self.client.get(detail), "应用本批审核")
        self.assertEqual(self.client.post(material_url, {"material": " cotton "}).status_code, 303)
        token = self.client.get(detail).context["english_review"]["confirmation"]
        apply = {"confirmation": token}
        self.client.force_login(peer)
        self.assertEqual(self.client.post(apply_url, apply).status_code, 403)
        self.client.force_login(owner)
        result = self.client.post(apply_url, apply)
        self.assertEqual(result.status_code, 303)
        self.assertContains(self.client.get(result["Location"]), "已应用")
        self.assertEqual(self.client.post(apply_url, apply)["Location"], result["Location"])
        self.assertEqual(self.client.post(submit_url, answer)["Location"], submitted["Location"])
        self.assertEqual(list(revisions.values_list("snapshot__english_name", flat=True)), ["", "Reviewed Ribbon"])
        self.assertEqual(revisions.last().snapshot["material"], " cotton ")
        self.assertEqual(Product.objects.get(task=batch).material, " cotton ")
        self.assertEqual(EventLog.objects.filter(task=workflow, event_type="human_review_cycle_applied").count(), 1)
        workflow.refresh_from_db()
        self.assertEqual((workflow.status, workflow.current_step), ("running", "product_profile"))

    def test_other_review_action_blocks_batch_even_when_text_answers_are_complete(self):
        with TemporaryDirectory() as directory, override_settings(MEDIA_ROOT=Path(directory)):
            owner = User.objects.create_superuser(username="mixed-review-owner")
            self.client.force_login(owner)
            batch = prepare_missing_literal_batch("含无版本的合成商品")
            revision = ProductRevision.objects.get(product__task=batch)
            Product.objects.create(
                task=batch, position=1, sku="NO-REVISION", name="无版本商品",
                category="trim", material="cotton", size="25mm", color="red",
                image_filename="SKU-01.svg", image_stored_name="SKU-01.svg",
                created_at=revision.product.created_at, updated_at=revision.product.updated_at,
            )
            workflow = create_prepared_workflow(
                batch_id=batch.pk, user_goal="整理本批产品资料", task_type="prepare_product_data",
            )
            dispatch_until_review(workflow)
            supported = []
            for field, value in (("material", "cotton"), ("english_name", "Ribbon")):
                review = workflow.human_reviews.get(
                    source_conflict__source_refs__revision_id=revision.pk,
                    source_conflict__source_refs__signal__missing_field=field,
                )
                supported.append(review.pk)
                submit = reverse("enterprise-submit-english-review", args=[workflow.pk, review.pk])
                self.assertEqual(self.client.post(submit, {field: value}).status_code, 303)
            content = self.client.get(reverse("enterprise-workflow-detail", args=[workflow.pk]))
            self.assertContains(content, "本批还有其他审核事项")
            self.assertNotContains(content, "应用本批审核")

            apply_url = reverse("enterprise-apply-english-review", args=[workflow.pk])
            all_reviews = list(workflow.human_reviews.values_list("id", flat=True))
            for review_ids in (supported, all_reviews):
                token = signing.dumps({
                    "owner": str(owner.pk), "workflow": workflow.pk, "reviews": sorted(review_ids),
                }, salt=APPLY_SALT)
                self.assertEqual(self.client.post(apply_url, {"confirmation": token}).status_code, 409)
            self.assertEqual(ProductRevision.objects.filter(product__task=batch).count(), 1)

    def test_mobile_uses_all_existing_literal_field_lengths(self):
        self.assertEqual({field: spec["limit"] for field, spec in FIELDS.items()}, {
            "sku": 120, "name": 200, "category": 120, "material": 200,
            "size": 120, "color": 120, "english_name": 200,
        })
