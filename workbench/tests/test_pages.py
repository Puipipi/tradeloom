from __future__ import annotations

from datetime import datetime, timezone as dt_timezone

from django.test import TestCase
from django.utils import timezone

from workbench.models import (
    AgentRun,
    Artifact,
    ArtifactVersion,
    EventLog,
    HumanReview,
    BatchItem,
    SubTask,
    Task,
    WorkflowTask,
)


class PageTests(TestCase):
    def make_batch(
        self,
        *,
        title: str = "测试批次",
        status: str = "awaiting_confirmation",
    ) -> Task:
        now = timezone.now()
        return Task.objects.create(
            title=title,
            mode="demo",
            status=status,
            created_at=now,
            updated_at=now,
        )

    def make_product(
        self,
        batch: Task,
        *,
        sku: str,
        position: int = 0,
        missing_fields: list[str] | None = None,
    ) -> BatchItem:
        now = timezone.now()
        return BatchItem.objects.create(
            task=batch,
            position=position,
            sku=sku,
            name="罗纹丝带",
            category="丝带",
            material="涤纶",
            size="25mm",
            color="酒红",
            image_filename=f"{sku}.svg",
            image_stored_name=f"stored-{sku}.svg",
            missing_fields=[] if missing_fields is None else missing_fields,
            created_at=now,
            updated_at=now,
        )

    def make_workflow(
        self,
        batch: Task,
        *,
        status: str = "queued",
    ) -> WorkflowTask:
        return WorkflowTask.objects.create(
            batch=batch,
            user_goal="测试业务任务",
            task_type="prepare_product_data",
            status=status,
            current_step="plan",
        )

    def test_five_new_pages_and_global_navigation(self):
        for path in (
            "/home",
            "/products",
            "/customers",
            "/agent-center",
            "/artifacts",
            "/runs",
        ):
            with self.subTest(path=path):
                self.assertEqual(self.client.get(path).status_code, 200)

        home = self.client.get("/home")
        self.assertContains(home, "织贸助手（TradeWeave）")
        self.assertContains(home, "本地演示数据")
        self.assertContains(home, "local_mock")
        self.assertContains(home, "本地规则模拟")
        self.assertContains(home, "中心规划与业务角色采用本地规则模拟，执行记录保存在工作台。")
        self.assertContains(home, "local_demo")
        self.assertContains(home, "AgentArts 未配置")
        self.assertNotContains(home, "Phase 1")
        self.assertNotContains(home, "WorkflowTask")
        self.assertNotContains(home, "legacy")
        for testid in (
            "nav-home",
            "nav-products",
            "nav-customers",
            "nav-agent-center",
            "nav-artifacts",
            "nav-runs",
            "nav-tasks",
            "nav-new",
            "nav-agents",
        ):
            self.assertContains(home, f'data-testid="{testid}"')

        self.assertRegex(
            home.content.decode(),
            r'<a[^>]*data-testid="nav-home"[^>]*aria-current="page"',
        )

    def test_home_uses_real_counts_and_actionable_batches(self):
        incomplete = self.make_batch(title="待补批次")
        self.make_product(incomplete, sku="HOME-1", missing_fields=["材质"])
        self.make_product(incomplete, sku="HOME-2", position=1)
        complete = self.make_batch(title="可确认批次")
        self.make_product(complete, sku="HOME-3")
        confirmed = self.make_batch(title="已确认批次", status="confirmed")
        self.make_product(confirmed, sku="HOME-4")
        empty = self.make_batch(title="空批次")
        self.make_workflow(complete)

        response = self.client.get("/home")

        self.assertEqual(response.context["batch_count"], 4)
        self.assertEqual(response.context["product_count"], 4)
        self.assertEqual(response.context["pending_count"], 3)
        self.assertEqual(response.context["workflow_count"], 1)
        self.assertEqual(response.context["actionable_count"], 1)
        self.assertContains(response, 'data-testid="stat-batches">4<')
        self.assertContains(response, 'data-testid="stat-products">4<')
        self.assertContains(response, 'data-testid="stat-pending">3<')
        self.assertContains(response, 'data-testid="stat-workflows">1<')
        self.assertContains(response, 'data-testid="stat-actionable">1<')
        self.assertContains(response, "待补批次")
        self.assertContains(response, "可确认批次")
        self.assertContains(response, "尚未导入产品")
        self.assertContains(response, "可确认")
        self.assertContains(response, "待补 1 项")

    def test_products_page_renders_sku_cost_ledger(self):
        """商品/产品资料页面已被 SKU 成本台账取代。

        老的产品资料库表格与筛选条不再渲染，「产品资料」只剩数据模型与 /api/products
        追溯接口；页面本体是成本台账。这里盯住三件事：台账外壳在、市场条在、
        老表格确实下线了。
        """
        response = self.client.get("/products")

        self.assertEqual(response.status_code, 200)
        self.assertContains(response, 'data-testid="sku-panel"')
        self.assertContains(response, "SKU 成本台账")
        self.assertContains(response, 'data-testid="sku-market-US"')
        self.assertContains(response, 'data-testid="sku-period"')
        self.assertNotContains(response, 'data-testid="products-table"')
        self.assertNotContains(response, "个产品匹配当前筛选")
        self.assertRegex(
            response.content.decode(),
            r'<a[^>]*data-testid="nav-products"[^>]*aria-current="page"',
        )

    def test_agent_center_shows_real_records_and_capability_link(self):
        batch = self.make_batch(title="业务批次")
        workflow = self.make_workflow(batch, status="running")
        SubTask.objects.create(
            task=workflow,
            agent_role="product_profile",
            status="running",
        )
        HumanReview.objects.create(
            task=workflow,
            item_ref="P-100",
            question="补齐英文名称",
            status="pending",
        )

        response = self.client.get("/agent-center")

        self.assertEqual(response.context["workflow_count"], 1)
        self.assertEqual(response.context["subtask_count"], 1)
        self.assertEqual(response.context["pending_review_count"], 1)
        self.assertContains(response, "产品资料")
        self.assertContains(response, "产品资料准备")
        self.assertContains(response, "待填写")
        self.assertContains(response, "任务规划")
        self.assertContains(response, "P-100")
        self.assertContains(response, "已创建业务任务")
        self.assertContains(response, 'href="/agents"')
        self.assertContains(response, "本地规则模拟")
        self.assertContains(response, "已保存的业务任务与当前步骤")
        self.assertNotContains(response, 'data-testid="run-agent-product_profile"')
        self.assertNotContains(response, "WorkflowTask")
        self.assertNotContains(response, "legacy")

    def test_agent_center_empty_states(self):
        response = self.client.get("/agent-center")

        self.assertContains(response, "尚无业务任务")
        self.assertContains(response, "尚无子任务")
        self.assertContains(response, "暂无待人工确认")

    def test_artifacts_page_shows_real_artifact_without_fake_download(self):
        batch = self.make_batch()
        workflow = self.make_workflow(batch)
        artifact_types = (
            "catalog_html",
            "catalog_markdown",
            "sample_checklist_csv",
            "sample_checklist_json",
            "quality_report_json",
        )
        for artifact_type in artifact_types:
            artifact = Artifact.objects.create(
                task=workflow,
                artifact_type=artifact_type,
                storage_key=f"artifacts/{artifact_type}",
                current_version=2,
                status="draft",
            )
            for version in (1, 2):
                ArtifactVersion.objects.create(
                    artifact=artifact,
                    version=version,
                    file_path=f"artifacts/{artifact_type}-v{version}",
                    sha256="a" * 64,
                    status="draft",
                )

        response = self.client.get("/artifacts")

        self.assertContains(response, "英文目录 HTML")
        self.assertContains(response, 'data-testid="artifact-version-2"')
        self.assertContains(response, "草稿")
        self.assertNotContains(response, 'href="/api/artifacts')
        self.assertEqual(response.content.count(b'/preview" rel="noopener">'), 6)
        self.assertNotIn(b'target="_blank"', response.content)
        self.assertEqual(response.content.count(b"\xe9\xa2\x84\xe8\xa7\x88\xe6\xb8\x85\xe5\x8d\x95"), 2)
        self.assertEqual(response.content.count(b'">\xe4\xb8\x8b\xe8\xbd\xbd</a>'), 10)

    def test_artifacts_empty_state(self):
        response = self.client.get("/artifacts")

        self.assertContains(response, "尚未生成交付物")

    def test_artifacts_page_exposes_private_intake_workbench(self):
        response = self.client.get("/artifacts")

        self.assertEqual(response.status_code, 200)
        self.assertContains(response, 'data-testid="intake-workbench"')
        self.assertContains(response, 'data-testid="intake-upload"')
        self.assertContains(response, 'data-testid="intake-sources"')
        self.assertContains(response, 'data-testid="intake-preview-grid"')
        self.assertContains(response, 'data-testid="intake-mapping"')
        self.assertContains(response, 'data-testid="intake-candidates"')
        self.assertContains(response, 'data-testid="intake-narratives"')
        self.assertContains(response, 'data-testid="intake-requirement-workspace"')
        self.assertContains(response, "/api/production-requirements/__REQUIREMENT__/revisions")
        self.assertContains(response, "intake.js")

    def test_runs_page_shows_real_runs_events_and_platform_status(self):
        batch = self.make_batch(title="运行批次")
        workflow = self.make_workflow(batch)
        AgentRun.objects.create(
            task=batch,
            capability_id="product_profile",
            status="succeeded",
            started_at=timezone.now(),
        )
        EventLog.objects.create(
            task=workflow,
            event_type="workflow_status_changed",
            actor="system",
            payload_summary={"from_status": "queued", "to_status": "running"},
        )

        response = self.client.get("/runs")

        self.assertContains(response, 'data-testid="runs-table"')
        self.assertContains(response, "产品资料")
        self.assertContains(response, "成功")
        self.assertContains(response, "状态变化")
        self.assertContains(response, "system")
        self.assertContains(response, "状态事件")
        self.assertContains(response, 'data-testid="platform-status"')
        self.assertContains(response, "local_mock")
        self.assertContains(response, "local_demo")
        self.assertContains(response, "not_configured")
        self.assertNotContains(response, "EventLog")
        self.assertNotContains(response, "legacy")

    def test_times_render_in_shanghai_short_format(self):
        utc_start = datetime(
            2026,
            10,
            18,
            14,
            9,
            tzinfo=dt_timezone.utc,
        )
        utc_finish = datetime(
            2026,
            10,
            18,
            14,
            10,
            tzinfo=dt_timezone.utc,
        )
        batch = self.make_batch(title="时区批次")
        batch.created_at = utc_start
        batch.updated_at = utc_start
        batch.save(update_fields=["created_at", "updated_at"])
        product = self.make_product(batch, sku="TZ-1")
        AgentRun.objects.create(
            task=batch,
            capability_id="product_profile",
            status="succeeded",
            started_at=utc_start,
            finished_at=utc_finish,
        )
        workflow = self.make_workflow(batch)
        event = EventLog.objects.create(
            task=workflow,
            event_type="workflow_status_changed",
            actor="system",
        )
        EventLog.objects.filter(pk=event.pk).update(created_at=utc_start)
        artifact = Artifact.objects.create(
            task=workflow,
            artifact_type="catalog_html",
            storage_key="artifacts/catalog.html",
            current_version=1,
            status="draft",
        )
        Artifact.objects.filter(pk=artifact.pk).update(updated_at=utc_start)

        home = self.client.get("/home")
        runs = self.client.get("/runs")
        artifacts = self.client.get("/artifacts")

        self.assertContains(home, "2026-10-18 22:09")
        self.assertContains(home, "上海时间")
        self.assertNotContains(home, "2026-10-18T14:09")
        self.assertContains(runs, "2026-10-18 22:09")
        self.assertContains(runs, "2026-10-18 22:10")
        self.assertContains(runs, "上海时间")
        self.assertNotContains(runs, "2026-10-18T14:09")
        self.assertContains(runs, "状态变化")
        self.assertContains(artifacts, "2026-10-18 22:09")
        self.assertContains(artifacts, "上海时间")
        self.assertNotContains(artifacts, "2026-10-18T14:09")

    def test_list_limits_are_stated(self):
        batch = self.make_batch(title="截断批次")
        for index in range(7):
            self.make_workflow(batch, status="queued")
        agent_center = self.client.get("/agent-center")
        self.assertContains(agent_center, "仅显示最近 6 条，共 7 条")

        for index in range(51):
            AgentRun.objects.create(
                task=batch,
                capability_id="product_profile",
                status="succeeded",
                started_at=timezone.now(),
            )
        workflow = WorkflowTask.objects.filter(batch=batch).first()
        for index in range(21):
            EventLog.objects.create(
                task=workflow,
                event_type="workflow_status_changed",
                actor="system",
            )
        runs = self.client.get("/runs")
        self.assertContains(runs, "仅显示最近 50 条，共 51 条")
        self.assertContains(runs, "仅显示最近 20 条，共 21 条")

    def test_product_library_endpoint_is_gone(self):
        # 产品资料库（含查询/版本/还原接口）已随 0027 迁移下线。
        batch = self.make_batch(status="custom_status")
        self.make_product(batch, sku="UNKNOWN-1")

        self.assertEqual(self.client.get("/api/product-library").status_code, 404)
        self.assertEqual(self.client.get(f"/api/batch-items/{batch.id}").status_code, 405)

    def test_old_routes_and_js_testids_remain(self):
        batch = self.make_batch(title="旧任务")
        self.make_product(batch, sku="OLD-1")

        task_list = self.client.get("/")
        self.assertEqual(task_list.status_code, 200)
        self.assertContains(task_list, "旧任务")
        self.assertContains(task_list, 'data-testid="nav-tasks"')
        self.assertRegex(
            task_list.content.decode(),
            r'<a[^>]*data-testid="nav-tasks"[^>]*aria-current="page"',
        )

        new_page = self.client.get("/tasks/new")
        self.assertContains(new_page, 'id="upload-form"')
        self.assertContains(new_page, 'data-testid="load-demo"')

        detail = self.client.get(f"/tasks/{batch.id}")
        self.assertContains(detail, 'data-testid="task-detail"')

        agents = self.client.get("/agents")
        self.assertContains(agents, 'id="agents-page"')
        self.assertContains(agents, 'data-testid="agent-map"')

        health = self.client.get("/api/health")
        self.assertEqual(health.json()["status"], "ok")
