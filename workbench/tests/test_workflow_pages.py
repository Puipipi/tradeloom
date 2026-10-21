from __future__ import annotations

import json
from unittest.mock import Mock, patch

from django.test import Client, RequestFactory, SimpleTestCase, TestCase
from django.utils import timezone
from django.utils.dateparse import parse_datetime

from workbench.models import EventLog, HumanReview, Product, SubTask, Task, WorkflowStep, WorkflowTask
from workbench.tests.test_review_submission import create_pending_review
from workbench.workflows.orchestrator import WorkflowOrchestrator


class AgentCenterExecutionSummaryTests(SimpleTestCase):
    def test_agent_center_hides_next_step_for_completed_workflows_only(self):
        from workbench import views

        batch = type("Batch", (), {"title": "DEMO ONLY"})()
        completed = type("Workflow", (), {
            "id": "completed-workflow",
            "batch": batch,
            "task_type": "prepare_product_data",
            "status": "completed",
            "current_step": "complete_workflow",
            "result_refs": {"next_step": "generate_deliverables"},
            "error_summary": "",
        })()
        running = type("Workflow", (), {
            "id": "running-workflow",
            "batch": batch,
            "task_type": "prepare_product_data",
            "status": "running",
            "current_step": "product_profile",
            "result_refs": {"next_step": "product_profile"},
            "error_summary": "",
        })()

        workflow_manager = Mock()
        workflow_manager.select_related.return_value.order_by.return_value = [completed, running]
        workflow_manager.count.return_value = 2
        subtask_manager = Mock()
        subtask_manager.select_related.return_value.order_by.return_value = []
        subtask_manager.count.return_value = 0
        review_manager = Mock()
        review_manager.filter.return_value.select_related.return_value.order_by.return_value = []
        review_manager.filter.return_value.count.return_value = 0
        task_manager = Mock()
        task_manager.filter.return_value.distinct.return_value.order_by.return_value = []

        with (
            patch.object(views.WorkflowTask, "objects", workflow_manager),
            patch.object(views.SubTask, "objects", subtask_manager),
            patch.object(views.HumanReview, "objects", review_manager),
            patch.object(views.Task, "objects", task_manager),
        ):
            response = views.agent_center(RequestFactory().get("/agent-center"))

        html = response.content.decode("utf-8")
        self.assertEqual(response.status_code, 200)
        self.assertIn('/workflow-tasks/completed-workflow', html)
        self.assertIn('/workflow-tasks/running-workflow', html)
        self.assertIn("下一步：产品资料", html)
        self.assertNotIn("下一步：生成交付文件", html)


class WorkflowPagesTests(TestCase):
    def make_batch(self, title="批次 A"):
        now = timezone.now()
        return Task.objects.create(
            title=title,
            mode="demo",
            status="awaiting_confirmation",
            created_at=now,
            updated_at=now,
        )

    def make_workflow(self, batch, **kwargs):
        return WorkflowTask.objects.create(
            batch=batch,
            user_goal=kwargs.pop("user_goal", "准备本批产品资料"),
            task_type="prepare_product_data",
            status=kwargs.pop("status", "queued"),
            **kwargs,
        )

    def test_agent_center_has_generic_creation_form_and_detail_links(self):
        batch = self.make_batch()
        Product.objects.create(
            task=batch,
            position=0,
            sku="SKU-1",
            name="演示产品",
            category="配件",
            material="棉",
            size="25mm",
            color="蓝色",
            image_filename="sku-1.png",
            missing_fields=[],
            created_at=timezone.now(),
            updated_at=timezone.now(),
        )
        workflow = self.make_workflow(batch)
        review = HumanReview.objects.create(
            task=workflow,
            item_ref="SKU-1",
            question="补充产品信息",
            status="pending",
            review_key="review-key",
            source_conflict={"source_refs": {"product_id": "p-1"}},
        )

        response = self.client.get("/agent-center")

        self.assertEqual(response.status_code, 200)
        self.assertContains(response, 'id="workflow-create-form"')
        self.assertContains(response, 'data-intent-preview-endpoint="/api/workflow-intent/preview"')
        self.assertContains(response, 'data-testid="intent-preview"')
        self.assertContains(response, 'name="batch_id"')
        self.assertContains(response, batch.id)
        self.assertContains(response, 'name="user_goal"')
        self.assertContains(response, "创建业务计划")
        self.assertContains(response, f'href="/workflow-tasks/{workflow.id}"')
        self.assertContains(response, f'href="/workflow-tasks/{workflow.id}#review-{review.id}"')
        self.assertContains(response, "待填写")

    def test_workflow_detail_is_read_only_and_renders_saved_data_safely(self):
        batch = self.make_batch(title="<批次 & A>")
        workflow = self.make_workflow(batch, user_goal="<script>alert(1)</script>")
        step = WorkflowStep.objects.create(
            task=workflow,
            step_key="center_plan",
            status="completed",
            attempt=2,
            idempotency_key=f"workflow:{workflow.id}:plan",
            output_refs={
                "plan": {"classification": {"reason": "two-step plan"}, "subtasks": []},
                "canonical_result_ref": "subtask:source-subtask:output_refs.result",
                "source_refs": {
                    "revision_ids": [f"revision-{index:02}" for index in range(31)],
                    "subtask_ids": ["source-subtask"],
                },
                "result": {"private_reasoning": "DO_NOT_RENDER_PRIVATE_STEP"},
            },
            started_at=timezone.now(),
            finished_at=timezone.now(),
        )
        subtask = SubTask.objects.create(
            task=workflow,
            agent_role="product_profile",
            status="queued",
            input_refs={"batch_id": batch.id, "product_ids": ["p-1"]},
            output_refs={"result": {"private_reasoning": "DO_NOT_RENDER_PRIVATE"}},
        )
        EventLog.objects.create(
            task=workflow,
            subtask=subtask,
            event_type="subtask_created",
            actor="center",
            payload_summary={"role": "product_profile"},
        )
        HumanReview.objects.create(
            task=workflow,
            item_ref="SKU-1",
            question="核对英文名称",
            status="pending",
            review_key="key-1",
            source_conflict={"source_refs": {"product_id": "p-1", "revision_id": "r-1"}},
        )
        before = (
            WorkflowTask.objects.count(), WorkflowStep.objects.count(),
            SubTask.objects.count(), HumanReview.objects.count(), EventLog.objects.count(),
        )
        with (
            patch.object(WorkflowOrchestrator, "plan_task") as plan,
            patch.object(WorkflowOrchestrator, "dispatch_subtask") as dispatch,
        ):
            response = self.client.get(f"/workflow-tasks/{workflow.id}")

        self.assertEqual(response.status_code, 200)
        self.assertContains(response, "two-step plan")
        self.assertContains(response, "产品资料")
        self.assertContains(response, "SKU-1")
        self.assertContains(response, "r-1")
        self.assertContains(response, "规范结果引用")
        self.assertContains(response, "subtask:source-subtask:output_refs.result")
        self.assertContains(response, "revision-30")
        self.assertContains(response, "2026-") if step.started_at else None
        self.assertContains(response, 'data-testid="mode-note"')
        self.assertContains(response, "local_mock")
        self.assertContains(response, "AgentArts 未配置")
        self.assertContains(response, "&lt;批次 &amp; A&gt;")
        self.assertNotContains(response, "<script>alert(1)</script>")
        self.assertNotContains(response, "DO_NOT_RENDER_PRIVATE")
        self.assertNotContains(response, "DO_NOT_RENDER_PRIVATE_STEP")
        self.assertEqual(before, (
            WorkflowTask.objects.count(), WorkflowStep.objects.count(),
            SubTask.objects.count(), HumanReview.objects.count(), EventLog.objects.count(),
        ))
        plan.assert_not_called()
        dispatch.assert_not_called()

    def test_detail_is_get_only_unknown_is_404_and_sets_csrf_cookie(self):
        self.assertEqual(self.client.get(f"/workflow-tasks/{'f' * 32}").status_code, 404)
        batch = self.make_batch()
        workflow = self.make_workflow(batch)
        client = Client(enforce_csrf_checks=True)
        response = client.get(f"/workflow-tasks/{workflow.id}")
        self.assertEqual(response.status_code, 200)
        self.assertIn("csrftoken", client.cookies)
        self.assertEqual(self.client.post(f"/workflow-tasks/{workflow.id}").status_code, 405)

    def test_existing_pending_review_can_submit_note_and_becomes_read_only_receipt(self):
        batch, product, revision, file, workflow, _engine, _subtask, review = create_pending_review()
        url = f"/api/workflow-tasks/{workflow.id}/reviews/{review.id}/submit"
        payload = {"review_key": review.review_key, "answer": {"note": "资料已核对"}, "reviewer": "操作员"}
        submitted = self.client.post(url, data=json.dumps(payload), content_type="application/json")
        self.assertEqual(submitted.status_code, 200)
        response = self.client.get(f"/workflow-tasks/{workflow.id}")
        self.assertContains(response, "已提交待核验")
        self.assertContains(response, "资料已核对")
        self.assertContains(response, "操作员")
        self.assertContains(response, "不会应用产品事实或恢复任务")
        self.assertEqual(
            response.content.decode().count('data-testid="review-note-form"'),
            0,
        )
        self.assertEqual(
            response.content.decode().count('data-testid="review-typed-form"'),
            HumanReview.objects.filter(task=workflow, status="pending").count(),
        )
        submitted_at = parse_datetime(submitted.json()["answer"]["submitted_at"])
        self.assertContains(
            response,
            timezone.localtime(submitted_at).strftime("%Y-%m-%d %H:%M"),
        )
        self.assertEqual(HumanReview.objects.get(pk=review.id).status, "submitted")

    def test_pending_review_exposes_note_form_with_saved_question_and_source(self):
        batch, product, revision, file, workflow, _engine, _subtask, review = create_pending_review()
        response = self.client.get(f"/workflow-tasks/{workflow.id}")
        self.assertContains(response, 'data-testid="review-typed-form"')
        self.assertContains(response, 'name="value" value=""')
        self.assertContains(response, 'name="reviewer"')
        self.assertContains(response, review.question)
        self.assertContains(response, revision.id)
        self.assertContains(response, "提交人审回执")
        self.assertContains(response, "待填写")

    def test_create_form_uses_existing_workflow_api_contract(self):
        batch = self.make_batch()
        Product.objects.create(
            task=batch, position=0, sku="CREATE-1", name="sample",
            category="sample", material="sample", size="sample", color="sample",
            image_filename="sample.png", missing_fields=[],
            created_at=timezone.now(), updated_at=timezone.now(),
        )
        response = self.client.get("/agent-center")
        self.assertContains(response, 'data-workflow-create-endpoint="/api/workflow-tasks"')
        self.assertNotContains(response, "data-default-task-type")
        self.assertContains(response, "本地规则模拟")
        self.assertContains(response, "先解析目标")
        self.assertContains(response, "查看候选和模拟标记后")
        self.assertContains(response, "明确确认保存计划")
        self.assertContains(response, "确认后只保存计划并排队，尚未运行子任务")
        self.assertContains(response, "本页使用本地规则解析；也可接收聊天 Agent 的结构化提案，保存前仍需确认。")
        self.assertContains(response, 'id="workflow-create-error"')
        self.assertContains(response, 'id="workflow-create-notice"')
        self.assertContains(response, "app.js")

        with patch("workbench.agents.mock_runtime.MockAgentRuntime.run_subtask") as run:
            created = self.client.post(
                "/api/workflow-tasks",
                data=json.dumps({
                    "batch_id": batch.id,
                    "user_goal": "Prepare product data",
                    "task_type": "prepare_product_data",
                }),
                content_type="application/json",
            )
        self.assertEqual(created.status_code, 201)
        self.assertEqual(created.json()["status"], "queued")
        self.assertEqual(len(created.json()["subtasks"]), 2)
        run.assert_not_called()

