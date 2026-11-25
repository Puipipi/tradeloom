from django.contrib.auth.models import Group, Permission, User
from django.urls import reverse
from django.utils import timezone

from enterprise_portal.testing import EmailVerifiedTestCase
from workbench.models import AgentRun, EventLog, Task, WorkflowStep, WorkflowTask


class BusinessRunTests(EmailVerifiedTestCase):
    def test_projected_workflow_runs_and_role_access(self):
        url = reverse("enterprise-workflow-runs")
        self.assertEqual(self.client.get(url).status_code, 302)
        now = timezone.now()
        batch = Task.objects.create(title="合成安全批次", mode="test", status="completed", created_at=now, updated_at=now)
        workflow = WorkflowTask.objects.create(batch=batch, user_goal="CANARY_GOAL", task_type="quality_check")
        WorkflowStep.objects.create(task=workflow, step_key="delivery_quality", status="completed", attempt=2,
                                    started_at=now, finished_at=now, error_summary="CANARY_ERROR",
                                    input_refs={"path": "CANARY_IN"}, output_refs={"value": "CANARY_OUT"})
        WorkflowStep.objects.create(task=workflow, step_key="CANARY_RAW_KEY", status="CANARY_STATUS", started_at=now)
        WorkflowStep.objects.create(task=workflow, step_key="human_review", status="queued")
        AgentRun.objects.create(task=batch, capability_id="product_profile", status="completed", started_at=now,
                                result={"marker": "CANARY_RUN"}, error="CANARY_RUN_ERROR")
        EventLog.objects.create(event_type="health_check", actor="CANARY_ACTOR", payload_summary={"token": "CANARY_LOG"})
        owner_role = Group.objects.create(name="企业老板")
        owner_role.permissions.add(*Permission.objects.filter(
            content_type__app_label="enterprise_portal", codename__in=("view_business_data", "view_all_enterpriseentry")
        ))
        owner = User.objects.create_user(username="run-owner")
        owner.groups.add(owner_role)
        self.client.force_login(owner)
        owner_home = self.client.get(reverse("enterprise-home"))
        self.assertContains(owner_home, url)
        result = self.client.get(url)
        self.assertContains(result, reverse("enterprise-workflow-detail", args=[workflow.pk]), count=2)
        self.assertContains(result, "交付资料就绪检查")
        self.assertContains(result, "第 2 次")
        self.assertContains(result, "其他业务步骤")
        self.assertContains(result, "未知状态")
        for private in ("CANARY_", "产品资料", "健康检查", "待后续人工处理"):
            self.assertNotContains(result, private)
        registrar = User.objects.create_user(username="run-factory")
        registrar.groups.add(owner_role, Group.objects.create(name="工厂登记员"))
        self.client.force_login(registrar)
        self.assertNotContains(self.client.get(reverse("enterprise-home")), url)
        self.assertEqual(self.client.get(url).status_code, 403)
