from django.contrib.auth.models import Group, Permission, User
from django.test import Client
from django.urls import reverse
from django.utils import timezone

from enterprise_portal.testing import EmailVerifiedTestCase
from workbench.models import SubTask, Task, WorkflowStep, WorkflowTask


class BusinessWorkflowPortalTests(EmailVerifiedTestCase):
    def setUp(self):
        super().setUp()
        self.owner_group, _ = Group.objects.get_or_create(name="企业老板")
        self.business, self.records = [
            Permission.objects.get(content_type__app_label="enterprise_portal", codename=codename)
            for codename in ("view_business_data", "view_all_enterpriseentry")
        ]
        self.owner_group.permissions.add(self.business, self.records)
        self.owner = self.make_user("workflow-owner", self.owner_group)
        self.list_url = reverse("enterprise-workflows")

    def make_user(self, name, *groups):
        user = User.objects.create_user(name, email=f"{name}@example.test", password="test-password")
        user.groups.add(*groups)
        return user

    def make_workflow(self, title):
        now = timezone.now()
        batch = Task.objects.create(
            title=title, mode="test", status="confirmed", created_at=now, updated_at=now,
        )
        return WorkflowTask.objects.create(
            batch=batch, user_goal="SECRET-GOAL", task_type="prepare_product_data",
            status="waiting_human", result_refs={"command": "SECRET-COMMAND"},
        )

    def detail_url(self, workflow):
        return reverse("enterprise-workflow-detail", args=[workflow.pk])

    def test_saved_dependencies_steps_and_projection(self):
        workflow = self.make_workflow("合成商品批次")
        other = self.make_workflow("其他批次")
        first = SubTask.objects.create(
            task=workflow, agent_role="product_profile", status="completed",
            input_refs={"directory": "SECRET-PATH"},
        )
        second = SubTask.objects.create(
            task=workflow, agent_role="UNKNOWN-PRIVATE-ROLE", status="UNKNOWN-PRIVATE-STATUS",
        )
        outside = SubTask.objects.create(task=other, agent_role="delivery_quality")
        second.depends_on.add(first, outside)
        WorkflowStep.objects.create(task=workflow, step_key="center_plan", status="completed")
        WorkflowStep.objects.create(task=workflow, step_key=f"subtask:{second.pk}", attempt=2)
        WorkflowStep.objects.create(
            task=workflow, step_key="UNKNOWN-PRIVATE-STEP", error_summary="SECRET-ERROR",
        )
        WorkflowStep.objects.create(task=other, step_key="complete_workflow")

        self.client.force_login(self.owner)
        self.assertContains(self.client.get(reverse("enterprise-home")), self.list_url)
        self.assertContains(self.client.get(self.list_url), self.detail_url(workflow))
        response = self.client.get(self.detail_url(workflow))
        self.assertContains(response, 'href="#task-1"')
        self.assertContains(response, 'id="task-1"')
        self.assertContains(response, "中心规划")
        self.assertContains(response, "其他任务")
        self.assertContains(response, "其他步骤")
        self.assertContains(response, "第 2 次")
        self.assertContains(response, "合成商品批次")
        self.assertContains(response, "等待人工处理")
        self.assertContains(response, 'name="viewport"')
        self.assertNotContains(response, "UNKNOWN-PRIVATE")
        self.assertNotContains(response, "SECRET-")
        self.assertNotContains(response, outside.pk)
        self.assertNotContains(response, "完成工作流")
        self.assertNotContains(response, "其他批次")
        self.assertIn("no-store", response["Cache-Control"])

    def test_requires_current_verified_owner_and_denies_direct_access(self):
        workflow = self.make_workflow("合成商品批次")
        operations, _ = Group.objects.get_or_create(name="服务运维员")
        factory, _ = Group.objects.get_or_create(name="工厂登记员")
        for url in (self.list_url, self.detail_url(workflow)):
            self.assertEqual(Client().get(url).status_code, 302)
            password_only = Client()
            password_only.force_login(self.owner)
            self.assertEqual(password_only.get(url).status_code, 302)
            for group in (operations, factory):
                user = self.make_user(f"mixed-{group.pk}-{len(url)}", self.owner_group, group)
                self.client.force_login(user)
                self.assertEqual(self.client.get(url).status_code, 403)
                self.assertNotContains(self.client.get(reverse("enterprise-home")), self.list_url)
        self.client.force_login(self.owner)
        self.assertEqual(self.client.get(self.detail_url(workflow)).status_code, 200)
        self.owner_group.permissions.remove(self.records)
        self.assertEqual(self.client.get(self.detail_url(workflow)).status_code, 403)
        self.assertNotContains(self.client.get(reverse("enterprise-home")), self.list_url)

    def test_empty_states_and_deleted_record(self):
        self.client.force_login(self.owner)
        self.assertContains(self.client.get(self.list_url), "当前没有已保存的业务工作流")
        workflow = self.make_workflow("待处理批次")
        url = self.detail_url(workflow)
        response = self.client.get(url)
        self.assertContains(response, "当前没有已记录的任务")
        self.assertContains(response, "当前没有已记录的步骤")
        self.assertEqual(self.client.post(url).status_code, 405)
        workflow.delete()
        self.assertEqual(self.client.get(url).status_code, 404)
        self.assertNotContains(self.client.get(self.list_url), "待处理批次")
