from django.contrib.auth.models import Group, Permission, User
from django.test import Client
from django.urls import reverse
from django.utils import timezone

from enterprise_portal.models import WorkflowHandoff
from enterprise_portal.testing import EmailVerifiedClient, EmailVerifiedTestCase
from workbench.models import Task, WorkflowTask


class WorkflowHandoffTests(EmailVerifiedTestCase):
    def setUp(self):
        super().setUp()
        self.owner_group, _ = Group.objects.get_or_create(name="企业老板")
        permissions = Permission.objects.filter(
            content_type__app_label="enterprise_portal",
            codename__in=("view_business_data", "view_all_enterpriseentry"),
        )
        self.owner_group.permissions.add(*permissions)
        self.owner = self.make_owner("sender")
        self.sender = self.verified_client(self.owner)
        self.receiver = self.verified_client(self.owner)
        now = timezone.now()
        batch = Task.objects.create(
            title="跨设备接力合成批次", mode="test", status="confirmed", created_at=now, updated_at=now,
        )
        self.workflow = WorkflowTask.objects.create(
            batch=batch, user_goal="PRIVATE-GOAL", task_type="prepare_product_data",
        )
        self.start_url = reverse("enterprise-workflow-handoff-start", args=[self.workflow.pk])
        self.receive_url = reverse("enterprise-workflow-handoff-receive")
        self.detail_url = reverse("enterprise-workflow-detail", args=[self.workflow.pk])

    def make_owner(self, name):
        user = User.objects.create_user(username=name, email=f"{name}@example.test", password="test-password")
        user.groups.add(self.owner_group)
        return user

    def verified_client(self, user, **kwargs):
        client = EmailVerifiedClient(**kwargs)
        client.force_login(user)
        return client

    def issue_code(self):
        response = self.sender.post(self.start_url)
        self.assertEqual(response.status_code, 200)
        self.assertIn("no-store", response["Cache-Control"])
        return response.context["code"]

    def test_different_sessions_continue_same_workflow_once(self):
        self.assertContains(self.sender.get(self.detail_url), self.start_url)
        self.assertContains(self.receiver.get(reverse("enterprise-home")), self.receive_url)
        code = self.issue_code()
        row = WorkflowHandoff.objects.get()
        self.assertNotEqual(row.code_digest, code)
        self.assertNotEqual(row.source_session_digest, self.sender.session.session_key)
        self.assertEqual(self.sender.post(self.receive_url, {"code": code}).status_code, 400)
        self.assertEqual(self.verified_client(self.make_owner("other-owner")).post(
            self.receive_url, {"code": code},
        ).status_code, 400)
        response = self.receiver.post(self.receive_url, {"code": code}, follow=True)
        self.assertRedirects(response, self.detail_url)
        self.assertContains(response, "跨设备接力合成批次")
        self.assertNotContains(response, "PRIVATE-GOAL")
        self.assertEqual(self.receiver.post(self.receive_url, {"code": code}).status_code, 400)

    def test_stale_codes_and_deleted_workflows(self):
        old = self.issue_code()
        code = self.issue_code()
        self.assertEqual(self.receiver.post(self.receive_url, {"code": old}).status_code, 400)
        WorkflowHandoff.objects.update(expires_at=timezone.now())
        self.assertEqual(self.receiver.post(self.receive_url, {"code": code}).status_code, 400)
        code = self.issue_code()
        self.workflow.delete()
        self.assertEqual(self.receiver.post(self.receive_url, {"code": code}).status_code, 400)
        self.assertEqual(self.sender.post(self.start_url).status_code, 404)

    def test_verified_roles_and_csrf_apply_to_both_actions(self):
        code = self.issue_code()
        password_only = Client()
        password_only.force_login(self.owner)
        for client in (Client(), password_only):
            self.assertEqual(client.post(self.start_url).status_code, 302)
            self.assertEqual(client.post(self.receive_url, {"code": code}).status_code, 302)

        for role in ("工厂登记员", "服务运维员"):
            group, _ = Group.objects.get_or_create(name=role)
            self.owner.groups.add(group)
            self.assertNotContains(self.receiver.get(reverse("enterprise-home")), self.receive_url)
            self.assertEqual(self.sender.post(self.start_url).status_code, 403)
            self.assertEqual(self.receiver.post(self.receive_url, {"code": code}).status_code, 403)
            self.owner.groups.remove(group)

        enforced_csrf = self.verified_client(self.owner, enforce_csrf_checks=True)
        self.assertEqual(enforced_csrf.post(self.start_url).status_code, 403)
        self.assertEqual(enforced_csrf.post(self.receive_url, {"code": code}).status_code, 403)
        self.assertEqual(self.sender.get(self.start_url).status_code, 405)
        self.assertRedirects(self.receiver.post(self.receive_url, {"code": code}), self.detail_url)
