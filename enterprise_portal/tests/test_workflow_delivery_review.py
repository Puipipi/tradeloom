from urllib.parse import urlsplit
from pathlib import Path
from tempfile import TemporaryDirectory

from django.conf import settings
from django.contrib.auth.models import Group, Permission, User
from django.test import override_settings
from django.urls import reverse
from django.utils import timezone

from enterprise_portal.testing import EmailVerifiedTestCase
from workbench.delivery.service import generate_deliverables
from workbench.models import ArtifactVersion, EventLog, Product, ProductRevision, SubTask, Task, TaskFile, WorkflowTask
from workbench.workflows.orchestrator import WorkflowOrchestrator
from workbench.workflows.prepare import create_prepared_workflow


def prepare_delivery_batch(title, snapshot=None, english_name="Ribbon"):
    """Create confirmed product facts and image bytes for a local workflow."""
    now = timezone.now()
    batch = Task.objects.create(title=title, mode="demo", status="confirmed", created_at=now, updated_at=now)
    snapshot = snapshot or {
        "sku": "SKU-01", "name": "Ribbon", "category": "trim", "material": "polyester",
        "size": "25mm", "color": "red", "image_filename": "SKU-01.svg",
    }
    product = Product.objects.create(task=batch, position=0, image_stored_name="SKU-01.svg",
                                     created_at=now, updated_at=now, **snapshot)
    media = Path(settings.MEDIA_ROOT)
    media.mkdir(parents=True, exist_ok=True)
    (media / "SKU-01.svg").write_bytes(
        b'<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10" fill="#123456"/></svg>'
    )
    image = TaskFile.objects.create(task=batch, kind="image", original_name="SKU-01.svg",
                                    stored_name="SKU-01.svg", created_at=now)
    ProductRevision.objects.create(
        product=product, version=1, status="confirmed", snapshot={**snapshot, "english_name": english_name},
        source_refs={"image": {
            "task_file_id": image.id, "original_name": image.original_name, "stored_name": image.stored_name,
        }},
    )
    return batch


def prepare_delivery_review(title):
    batch = prepare_delivery_batch(title)
    workflow = create_prepared_workflow(batch_id=batch.pk, user_goal="Prepare catalog and sample checklist")
    engine = WorkflowOrchestrator()
    for role in ("product_profile", "delivery_quality"):
        subtask = SubTask.objects.get(task=workflow, agent_role=role)
        engine.dispatch_subtask(subtask.pk, f"enterprise-review:{workflow.pk}:{role}")
    bundle = generate_deliverables(workflow.pk, f"enterprise-review:{workflow.pk}:bundle")
    return workflow.pk, bundle["step_id"]


class WorkflowDeliveryReviewTests(EmailVerifiedTestCase):
    def test_exact_delivery_approval_and_replay(self):
        with TemporaryDirectory() as directory:
            root = Path(directory)
            with override_settings(MEDIA_ROOT=root / "media", TRADELOOM_ARTIFACT_ROOT=root / "artifacts"):
                self.check_approval()

    def check_approval(self):
        owners = Group.objects.create(name="企业老板")
        owners.permissions.add(*Permission.objects.filter(
            content_type__app_label="enterprise_portal", codename__in=("view_business_data", "view_all_enterpriseentry")
        ))
        owner = User.objects.create_user(username="delivery-owner")
        owner.groups.add(owners)
        factory = User.objects.create_user(username="delivery-factory")
        factory.groups.add(owners, Group.objects.create(name="工厂登记员"))
        workflow, step = prepare_delivery_review("合成交付包待审核")
        other_workflow, _ = prepare_delivery_review("另一个合成交付包")
        detail = reverse("enterprise-workflow-detail", args=[workflow])
        action = reverse("enterprise-review-workflow-delivery", args=[workflow, step])
        wrong_action = reverse("enterprise-review-workflow-delivery", args=[other_workflow, step])

        self.client.force_login(factory)
        self.assertEqual(self.client.post(action, {"decision": "approve"}).status_code, 403)
        self.client.force_login(owner)
        self.assertContains(self.client.get(detail), "批准交付包")
        self.assertEqual(self.client.post(wrong_action, {"decision": "approve"}).status_code, 404)
        submitted = self.client.post(action, {"decision": "approve"})
        target = urlsplit(submitted["Location"])
        self.assertEqual(target.path, detail)
        self.assertNotEqual(target.query, urlsplit(detail).query)
        self.assertEqual(submitted.status_code, 303)
        self.assertContains(self.client.get(f"{target.path}?{target.query}"), "已批准")
        self.assertContains(self.client.get(f"{target.path}?{target.query}"), "已批准")
        self.assertEqual(self.client.post(action, {"decision": "approve"}).status_code, 303)
        self.assertEqual(self.client.post(action, {"decision": "reject"}).status_code, 409)
        self.assertContains(self.client.get(detail), "已批准")
        self.assertNotContains(self.client.get(detail), "批准交付包")
        self.assertEqual(ArtifactVersion.objects.filter(artifact__task_id=workflow, status="approved").count(), 5)
        review = EventLog.objects.get(task_id=workflow, event_type="delivery_bundle_reviewed")
        self.assertEqual(review.payload_summary["refs"]["reviewer"], f"enterprise:{owner.pk}")
        state = WorkflowTask.objects.get(pk=workflow)
        self.assertEqual((state.status, state.current_step), ("running", "complete_workflow"))
        self.assertEqual(WorkflowTask.objects.get(pk=other_workflow).status, "waiting_human")
