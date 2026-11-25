from django.contrib.auth.models import Group, Permission, User
from django.urls import reverse
from django.utils import timezone

from enterprise_portal.testing import EmailVerifiedTestCase
from workbench.models import AgentRun, EventLog, Task, WorkflowTask


class EnterpriseWorkflowCreationTests(EmailVerifiedTestCase):
    def test_preview_confirm_and_replay_use_desktop_plan(self):
        owners = Group.objects.create(name="企业老板")
        owners.permissions.add(*Permission.objects.filter(
            content_type__app_label="enterprise_portal", codename__in=("view_business_data", "view_all_enterpriseentry")
        ))
        owner, peer, factory = [User.objects.create_user(username=role) for role in ("owner", "peer", "factory")]
        for user in (owner, peer, factory):
            user.groups.add(owners)
        factory.groups.add(Group.objects.create(name="工厂登记员"))
        now = timezone.now()
        batch, other = [
            Task.objects.create(title=title, mode="demo", status="confirmed", created_at=now, updated_at=now)
            for title in ("业务创建批次", "另一批次")
        ]
        target = reverse("enterprise-create-from-batch", args=[batch.pk])
        self.client.force_login(owner)
        self.assertContains(self.client.get(reverse("enterprise-products")), target)
        preview = self.client.post(target, {"action": "preview", "goal": "整理本批产品资料"})
        self.assertContains(preview, "确认创建工作流")
        token = preview.context["confirmation"]
        self.assertFalse(WorkflowTask.objects.exists())
        unsupported = self.client.post(target, {"action": "preview", "goal": "给客户发邮件"})
        self.assertNotContains(unsupported, "确认创建工作流")

        confirm = {"action": "confirm", "confirmation": token}
        self.assertEqual(self.client.post(target, {"action": "confirm", "confirmation": "invalid"}).status_code, 400)
        self.assertEqual(self.client.post(reverse("enterprise-create-from-batch", args=[other.pk]), confirm).status_code, 404)
        self.client.force_login(peer)
        self.assertEqual(self.client.post(target, confirm).status_code, 404)
        self.client.force_login(factory)
        self.assertEqual(self.client.get(target).status_code, 403)
        self.assertEqual(self.client.post(target, confirm).status_code, 403)
        self.client.force_login(owner)
        created = self.client.post(target, confirm)
        self.assertEqual(created.status_code, 303)
        self.assertEqual(self.client.post(target, confirm)["Location"], created["Location"])
        self.assertContains(self.client.get(created["Location"]), batch.title)
        self.assertContains(self.client.get(created["Location"]), "中心规划")
        workflow = WorkflowTask.objects.get()
        self.assertEqual((workflow.batch_id, workflow.task_type, workflow.status), (batch.pk, "prepare_product_data", "queued"))
        self.assertEqual(list(workflow.subtasks.order_by("agent_role").values_list("status", flat=True)), ["queued", "queued"])
        self.assertEqual(workflow.steps.get(step_key="center_plan").input_refs["execution_mode"], "local_mock")
        self.assertEqual(EventLog.objects.filter(task=workflow, event_type="workflow_plan_completed").count(), 1)
        self.assertFalse(AgentRun.objects.exists())
