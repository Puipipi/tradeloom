from pathlib import Path
from tempfile import TemporaryDirectory

from django.contrib.auth.models import Group, Permission, User
from django.test import override_settings
from django.urls import reverse

from enterprise_portal.testing import EmailVerifiedTestCase
from workbench.delivery.service import review_delivery_bundle
from workbench.models import EventLog, WorkflowTask

from .test_workflow_delivery_review import prepare_delivery_review


class EnterpriseCompletionTests(EmailVerifiedTestCase):
    def test_completion_uses_approved_bundle_and_replays_once(self):
        with TemporaryDirectory() as directory:
            root = Path(directory)
            with override_settings(MEDIA_ROOT=root / "media", TRADELOOM_ARTIFACT_ROOT=root / "artifacts"):
                self.check_completion()

    def check_completion(self):
        owners = Group.objects.create(name="企业老板")
        owners.permissions.add(*Permission.objects.filter(
            content_type__app_label="enterprise_portal", codename__in=("view_business_data", "view_all_enterpriseentry")
        ))
        owner = User.objects.create_user(username="completion-owner")
        owner.groups.add(owners)
        factory = User.objects.create_user(username="completion-factory")
        factory.groups.add(owners, Group.objects.create(name="工厂登记员"))
        workflow, step = prepare_delivery_review("合成待完成工作流")
        rejected, rejected_step = prepare_delivery_review("合成驳回工作流")
        detail = reverse("enterprise-workflow-detail", args=[workflow])
        action = reverse("enterprise-complete-workflow-delivery", args=[workflow])
        denied = reverse("enterprise-complete-workflow-delivery", args=[rejected])

        self.client.force_login(owner)
        self.assertNotContains(self.client.get(detail), action)
        self.assertEqual(self.client.post(action).status_code, 409)
        review_delivery_bundle(workflow, step, decision="approve", reviewer="local-test")
        review_delivery_bundle(rejected, rejected_step, decision="reject", reviewer="local-test")
        self.assertContains(self.client.get(detail), action)
        self.assertEqual(self.client.post(denied).status_code, 409)
        self.client.force_login(factory)
        self.assertEqual(self.client.post(action).status_code, 403)
        self.client.force_login(owner)
        self.assertEqual(self.client.get(action).status_code, 405)
        done = self.client.post(action)
        self.assertEqual(done.status_code, 303)
        self.assertEqual(done["Location"], detail + "?delivery=completed#delivery-review")
        after = self.client.get(done["Location"])
        self.assertContains(after, "工作流已完成")
        self.assertNotContains(after, action)
        self.assertEqual(self.client.post(action)["Location"], done["Location"])
        self.assertEqual(EventLog.objects.filter(task_id=workflow, event_type="workflow_delivery_completed").count(), 1)
        self.assertFalse(EventLog.objects.filter(task_id=rejected, event_type="workflow_delivery_completed").exists())
        state = WorkflowTask.objects.get(pk=workflow)
        self.assertEqual((state.status, state.current_step), ("completed", "completed"))
