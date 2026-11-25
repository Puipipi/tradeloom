from pathlib import Path
from tempfile import TemporaryDirectory

from django.contrib.auth.models import Group, Permission, User
from django.test import override_settings
from django.urls import reverse

from enterprise_portal.testing import EmailVerifiedTestCase
from workbench.models import EventLog, HumanReview, WorkflowTask
from workbench.workflows.prepare import create_prepared_workflow

from .test_workflow_delivery_review import prepare_delivery_batch


class EnterpriseLocalDispatchTests(EmailVerifiedTestCase):
    def test_first_attempt_replay_and_scopes(self):
        with TemporaryDirectory() as directory:
            root = Path(directory)
            with override_settings(MEDIA_ROOT=root / "media", TRADELOOM_ARTIFACT_ROOT=root / "artifacts"):
                self.check_dispatch()

    def check_dispatch(self):
        owners = Group.objects.create(name="企业老板")
        owners.permissions.add(*Permission.objects.filter(
            content_type__app_label="enterprise_portal", codename__in=("view_business_data", "view_all_enterpriseentry")
        ))
        owner, peer, factory = [
            User.objects.create_user(username=f"dispatch-{role}") for role in ("owner", "peer", "factory")
        ]
        for user in (owner, peer, factory):
            user.groups.add(owners)
        factory.groups.add(Group.objects.create(name="工厂登记员"))
        batch = prepare_delivery_batch("企业业务执行批次")
        workflow = create_prepared_workflow(batch_id=batch.pk, user_goal="Generate catalog",
                                            task_type="generate_deliverables")
        other = create_prepared_workflow(batch_id=batch.pk, user_goal="Generate catalog",
                                         task_type="generate_deliverables")
        action = reverse("enterprise-dispatch-workflow-next", args=[workflow.pk])
        detail = reverse("enterprise-workflow-detail", args=[workflow.pk])
        self.client.force_login(owner)
        self.assertContains(self.client.get(detail), "执行下一步（本地模拟）")
        token = self.client.get(detail).context["dispatch_confirmation"]
        form = {"confirmation": token}
        self.assertEqual(self.client.post(action, {"confirmation": token + "x"}).status_code, 400)
        self.assertEqual(self.client.post(reverse("enterprise-dispatch-workflow-next", args=[other.pk]), form).status_code, 404)
        self.client.force_login(peer)
        self.assertEqual(self.client.post(action, form).status_code, 404)
        self.client.force_login(factory)
        self.assertEqual(self.client.post(action, form).status_code, 403)
        self.client.force_login(owner)

        plan = workflow.steps.get(step_key="center_plan")
        original = plan.input_refs
        for mode in ("native_dsh", None):
            plan.input_refs = {"execution_mode": mode} if mode else {}
            plan.save(update_fields=["input_refs"])
            self.assertNotContains(self.client.get(detail), action)
            self.assertEqual(self.client.post(action, form).status_code, 409)
        plan.input_refs = original
        plan.save(update_fields=["input_refs"])
        review = HumanReview.objects.create(task=workflow, item_ref="synthetic", question="待确认", status="pending")
        self.assertNotContains(self.client.get(detail), action)
        self.assertEqual(self.client.post(action, form).status_code, 409)
        review.status = "approved"
        review.save(update_fields=["status"])

        first = self.client.post(action, form)
        self.assertEqual(first.status_code, 303)
        self.assertEqual(self.client.post(action, form)["Location"], first["Location"])
        self.assertEqual(workflow.subtasks.filter(status="completed").count(), 1)
        second_token = self.client.get(first["Location"]).context["dispatch_confirmation"]
        self.assertTrue(second_token)
        self.assertNotEqual(second_token, token)
        second = self.client.post(action, {"confirmation": second_token})
        self.assertEqual(second.status_code, 303)
        self.assertNotEqual(second["Location"], first["Location"])
        self.assertNotContains(self.client.get(second["Location"]), action)
        self.assertEqual(workflow.steps.filter(step_key__startswith="subtask:", status="completed").count(), 2)
        self.assertEqual(EventLog.objects.filter(task=workflow, event_type="subtask_completed").count(), 2)
        self.assertEqual(WorkflowTask.objects.get(pk=workflow.pk).current_step, "generate_deliverables")
