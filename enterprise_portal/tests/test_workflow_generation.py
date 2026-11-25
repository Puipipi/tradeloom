from pathlib import Path
from tempfile import TemporaryDirectory

from django.contrib.auth.models import Group, Permission, User
from django.test import override_settings
from django.urls import reverse

from enterprise_portal.testing import EmailVerifiedTestCase
from workbench.delivery.service import review_delivery_bundle
from workbench.delivery.storage import DELIVERY_FILES
from workbench.models import ArtifactVersion, EventLog, WorkflowTask
from workbench.workflows.orchestrator import WorkflowOrchestrator
from workbench.workflows.prepare import create_prepared_workflow

from .test_workflow_delivery_review import prepare_delivery_batch


class EnterpriseDeliveryGenerationTests(EmailVerifiedTestCase):
    def test_generation_retries_and_replays_desktop_bundle(self):
        with TemporaryDirectory() as directory:
            root = Path(directory)
            with override_settings(MEDIA_ROOT=root / "media", TRADELOOM_ARTIFACT_ROOT=root / "artifacts"):
                self.check_generation(root)

    def check_generation(self, root):
        owners = Group.objects.create(name="企业老板")
        owners.permissions.add(*Permission.objects.filter(
            content_type__app_label="enterprise_portal", codename__in=("view_business_data", "view_all_enterpriseentry")
        ))
        owner, peer, factory = [
            User.objects.create_user(username=f"generation-{role}") for role in ("owner", "peer", "factory")
        ]
        for user in (owner, peer, factory):
            user.groups.add(owners)
        factory.groups.add(Group.objects.create(name="工厂登记员"))
        batch = prepare_delivery_batch("合成交付生成")
        workflow = create_prepared_workflow(batch_id=batch.pk, user_goal="Generate catalog",
                                            task_type="generate_deliverables")
        self.client.force_login(owner)
        detail = reverse("enterprise-workflow-detail", args=[workflow.pk])
        action = reverse("enterprise-generate-workflow-delivery", args=[workflow.pk])
        self.assertNotContains(self.client.get(detail), action)
        for role in ("product_profile", "delivery_quality"):
            subtask = workflow.subtasks.get(agent_role=role)
            WorkflowOrchestrator().dispatch_subtask(subtask.pk, f"test:generate:{subtask.pk}")
        original = self.client.get(detail).context["generation_form"]["confirmation"]
        data = {"confirmation": original}
        self.assertEqual(self.client.post(action, {"confirmation": original + "invalid"}).status_code, 400)
        self.client.force_login(peer)
        self.assertEqual(self.client.post(action, data).status_code, 404)
        self.client.force_login(factory)
        self.assertEqual(self.client.post(action, data).status_code, 403)
        self.client.force_login(owner)
        plan = workflow.steps.get(step_key="center_plan")
        original_plan = plan.input_refs
        plan.input_refs = {**original_plan, "execution_mode": "native_dsh"}
        plan.save(update_fields=["input_refs"])
        self.assertNotContains(self.client.get(detail), action)
        self.assertEqual(self.client.post(action, data).status_code, 409)
        plan.input_refs = original_plan
        plan.save(update_fields=["input_refs"])

        unavailable = root / "unavailable"
        unavailable.write_text("not a directory", encoding="utf-8")
        with override_settings(TRADELOOM_ARTIFACT_ROOT=unavailable):
            failed = self.client.post(action, data)
        self.assertContains(failed, "交付文件生成或质检失败", status_code=500)
        self.assertNotContains(failed, str(root), status_code=500)
        self.assertEqual(self.client.post(action, data).status_code, 409)
        retry = self.client.get(detail).context["generation_form"]
        self.assertEqual(retry["label"], "重试生成交付草稿")
        generated = self.client.post(action, {"confirmation": retry["confirmation"]})
        self.assertEqual(generated.status_code, 303)
        replay = self.client.post(action, {"confirmation": retry["confirmation"]})
        self.assertEqual(replay["Location"], generated["Location"])
        page = self.client.get(generated["Location"])
        self.assertContains(page, "批准交付包")
        self.assertNotContains(page, action)
        versions = ArtifactVersion.objects.filter(artifact__task_id=workflow.pk)
        self.assertEqual(set(versions.values_list("artifact__artifact_type", flat=True)), set(DELIVERY_FILES))
        self.assertEqual(versions.count(), 5)
        self.assertEqual(EventLog.objects.filter(task_id=workflow.pk, event_type="delivery_generation_completed").count(), 1)
        state = WorkflowTask.objects.get(pk=workflow.pk)
        self.assertEqual((state.status, state.current_step), ("waiting_human", "review_deliverables"))

        step_id = state.steps.get(step_key="generate_deliverables", status="completed").pk
        review_delivery_bundle(state.pk, step_id, decision="reject", reviewer="synthetic-reviewer")
        new_offer = self.client.get(detail).context["generation_form"]
        self.assertEqual(new_offer["label"], "重新生成交付草稿")
        self.assertEqual(self.client.post(action, {"confirmation": new_offer["confirmation"]}).status_code, 303)
        self.assertEqual(versions.filter(status="rejected").count(), 5)
        self.assertEqual(versions.filter(status="pending_review").count(), 5)
        self.assertEqual(EventLog.objects.filter(task_id=workflow.pk, event_type="delivery_generation_completed").count(), 2)
