# 织贸助手（TradeWeave）多 Agent 工作台实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在现有 Django/PostgreSQL 工作台上增量实现“业务任务 → 子任务 → 人工审核 → 恢复 → 英文目录与样品清单 → 质检审核”的可暂停、可恢复、可审计闭环。

**Architecture:** 保留现有 `Task/Product/TaskFile/AgentRun` 与 `/api/tasks/*` 作为唯一产品批次状态源；新增 `WorkflowTask` 业务任务域与独立编排层。流程由程序状态机控制，模型只通过 `AgentRuntime` 返回结构化计划与结果；首版固定为模拟规划。

**Tech Stack:** Django 5.2、PostgreSQL 17、Django templates、原生 JS、Python 3.14、Playwright（仅 e2e）。

**Spec:** `docs/specs/2026-10-18-multi-agent-workbench-spec.md`

> **当前协作优先级（用户最新要求）**：长期 Phase 0–7 目标保持不变；当前批次先完善适合三人协作的通用 Agent 框架和接入说明。已存在的本地角色仅为可替换演示规则，企业约束、审核选项与交付内容待实际访谈确认。未完成阶段和任务保持未勾选；不得将待访谈内容写成已确认业务规则。接入边界见 `docs/agent-development.md`。

## Global Constraints

- 页面中文主名使用“织贸助手（TradeWeave）”；仓库路径 `tradeloom`、Python 包名、URL 与现有数据 ID 不改。
- 技术栈保持 Django 5.2 / PostgreSQL 17 / Django templates，不引入前端框架或新运行时。
- 不重写 `workbench/models.py` 现有模型，不修改 `0001_initial.py`，只做增量迁移。
- `Task.status=created|awaiting_confirmation|confirmed` 是产品批次唯一状态源；`ProductBatch` 是 `Task` 的 proxy 领域别名，不新增批次状态表。`WorkflowTask` 通过 FK 引用原 `Task`。
- `Task.status` 不得与新业务任务状态 `queued|running|waiting_human|failed|completed|cancelled` 混用。
- `/` 继续作为原任务列表，新工作台首页使用 `/home`；五板块导航的首页指向 `/home`。现有 `/`、`/tasks/new`、`/tasks/<id>`、`/agents` 深链保持不变；新路由在 Task 4 实现。
- `/api/tasks/*` 现有行为与 7 项测试保持通过；`workbench/tests/` 是既有测试包，不新建同名 `workbench/tests.py` 遮蔽它。
- 测试统一用 Django `TestCase/TransactionTestCase` 或现有 pytest runner 执行；不把 pytest 函数/fixture 写进 `manage.py test` 收集目录。
- 首版 `MockAgentRuntime` 输出 `execution_mode=local_mock`、`planning_mode=simulated_rules` 与“模拟规划”；关键词/规则/模板不得称为 LLM 理解。
- 官方文档已确认的请求封套与协议可以先实现 adapter 并单测，但必须标 `documented_not_connected`/`agentarts=not_configured`；只有账号实测与部署验收后才可标“真实已接入”。
- 交付物正文、字段标签与文件名使用英文；缺英文名称时进入 HumanReview 由人补齐，禁止自动翻译业务事实。
- `ProductRevision.snapshot` 至少允许 legacy 七字段、`english_name` 及后续经人工批准的业务字段；人工补充时创建新 revision，`source_refs` 指向对应 `HumanReview`，旧快照不覆盖。不增加冗余 `is_current` 指针，当前修订由该产品唯一最大 `version` 确定。
- `ProductRevision` 在 Task 1 增加应用层不可变性保护：已有记录的 `snapshot`、`product`、`version` 不得经 `save()`、`QuerySet.update()` 或 `bulk_update()` 改写；`status`、`reviewer` 等元数据仍可更新。不引入数据库 trigger 或新事件溯源框架。
- `ArtifactVersion` 必须绑定不可变 `ProductRevision` 快照与来源版本；`snapshot` 保存生成时的固定来源数据，不设计可编辑业务内容；后续产品修改不得改变已生成文件。
- 执行进度必须落到 `WorkflowStep`（步骤、尝试次数、幂等键、输出引用、起止时间），不能用单一 `queued` 状态或聊天历史代替。
- 本轮执行约束：保留当前未提交 baseline，不 `git add`、不 commit、不 push、不创建远程。
- 外部依赖只允许项目外安装；不提交 `.env`、密码、token。
- 每个任务结束必须留下测试命令与真实输出；状态标记只用 `[ ]`、`[-]`（进行中）、`[x]`、`[!]`。

## 用户 Phase 映射

| 用户 Phase | 目标 | 本计划 Batch |
|---|---|---|
| Phase 1 | 五板块 + 数据模型 + 持久化 + 模拟数据 | Task 1–7 |
| Phase 2 | 多 Agent 架构 | Task 8–10 |
| Phase 3 | 端到端 | Task 11–15 |
| Phase 4 | 可靠性 | Task 16–18 |
| Phase 5 | 交付体验 | Task 19–20 |
| Phase 6 | AgentArts | Task 21 |
| Phase 7 | 测试交付 | Task 22–23 |

Phase 1 早期就建立五个可访问页面并展示真实基础数据；后续 Phase 只充实功能，不把导航拖到最后。

## 文件结构

```text
workbench/
├── models.py                     # 追加新模型（WorkflowStep 等），现有四表不改
├── migrations/0002_workflow_domain.py
├── workflows/
│   ├── states.py                 # 业务状态与合法转换
│   ├── orchestrator.py           # 子任务依赖、重试、幂等、事件
│   ├── prepare.py                # prepare_product_data
│   ├── validation.py             # 缺项/冲突检测
│   └── reviews.py                # 人工审核与恢复
├── products/
│   ├── query.py                  # 产品库查询
│   └── versions.py               # 产品修订/确认，legacy 全链路同步
├── delivery/
│   ├── catalog.py                # 英文 HTML/Markdown
│   ├── checklist.py              # 样品清单 CSV/JSON
│   ├── quality.py                # 交付质检
│   ├── storage.py                # 文件落盘与 SHA256
│   └── service.py                # Artifact 版本与审核
├── agents/
│   ├── runtime.py                # AgentRuntime 协议
│   ├── mock_runtime.py           # 模拟规划执行器
│   ├── center.py / product_agent.py / delivery_agent.py
│   ├── placeholders.py           # market / quotation
│   └── agentarts.py              # 文档封套 adapter（未连接）
├── templates/workbench/
│   ├── home.html / products.html / agent_center.html
│   ├── artifacts.html / runs.html
│   └── base.html                 # 五板块导航（Phase 1 建立）
├── urls.py / api.py / views.py   # 增量路由，legacy 路由保留
└── tests/                        # 既有包；新增独立测试文件
data/samples/phase1/              # 10 条模拟产品与图片
e2e/workbench-multi-agent-smoke.py
```

---

# Phase 1：五板块 + 数据模型 + 持久化 + 模拟数据

### Task 1: 增量业务模型与迁移

**Files:**
- Modify: `workbench/models.py`（文件末尾追加）
- Create: `workbench/migrations/0002_workflow_domain.py`
- Test: `workbench/tests/test_domain_models.py`（Django `TestCase`）

**Interfaces:**
- Consumes: 现有 `Task`、`Product`、`hex_uuid`
- Produces: `ProductBatch`（`Task` proxy）、`WorkflowTask`、`ProductRevision`、`SubTask`、`WorkflowStep`、`HumanReview`、`Artifact`、`ArtifactVersion`、`EventLog`

**Scope guard:** Task 1 只做模型、迁移与约束测试。不得提前实现 Task 2–7 的状态机、legacy 同步、五页面、样例数据或产品库。

模型约定：

```python
class ProductBatch(Task):
    class Meta:
        proxy = True

class WorkflowTask(models.Model):
    batch = models.ForeignKey(Task, on_delete=models.PROTECT, related_name="workflow_tasks")
    ...
```

- [ ] **Step 1: 写失败测试**

```python
from django.test import TestCase
from django.utils import timezone

class DomainModelTests(TestCase):
    def test_workflow_task_references_legacy_batch_and_step(self):
        now = timezone.now()
        batch = Task.objects.create(title="批次", mode="demo", status="awaiting_confirmation",
                                    created_at=now, updated_at=now)
        task = WorkflowTask.objects.create(batch=batch, user_goal="生成目录",
                                           task_type="prepare_product_data",
                                           status="queued", current_step="plan",
                                           created_at=now, updated_at=now)
        step = WorkflowStep.objects.create(task=task, step_key="plan", status="running",
                                           attempt=1, idempotency_key="plan-1")
        self.assertTrue(ProductBatch.objects.filter(id=batch.id).exists())
        self.assertEqual(step.task_id, task.id)
```

- [ ] **Step 2: 运行并确认失败**

Run: `python manage.py test workbench.tests.test_domain_models -v 1 --noinput`

Expected: `ImportError` 或 `no such table`。

- [ ] **Step 3: 追加模型并生成迁移**

`ProductBatch` 用 proxy，不建表；`WorkflowTask.batch` 指向原 `Task`；不复制批次状态字段。新增模型统一带便于创建的 timestamps；引用审核/版本证据的 FK 使用 `PROTECT`；`SubTask.depends_on` 使用非对称 self M2M。
`ProductRevision` 必须含不可变业务事实快照 `snapshot`（legacy 七字段、`english_name` 及后续人工批准字段）与独立元数据 `status/field_sources/source_refs/reviewer/timestamps`。人工补充创建新 revision，`source_refs` 指向对应 `HumanReview`，旧快照不覆盖。

数据库约束至少包括：

- `(product, version)` 唯一；
- `(artifact, version)` 唯一；
- `(task, idempotency_key)` 在 key 非空时唯一；
- `HumanReview.review_key` 在 `status=pending` 且 key 非空时与 `task` 组合唯一，允许历史空 key。

`ProductRevision` 的 `snapshot/product/version` 通过应用层 `save()`、`QuerySet.update()`、`bulk_update()` 保护；`status/reviewer` 元数据仍可修改。当前 revision 只按最大唯一 version 读取，不增加 `is_current` 指针；事务锁分配版本留到 Task 3/交付 service。

Run: `python manage.py makemigrations workbench --name workflow_domain`

- [ ] **Step 4: 迁移并测试**

Run: `python manage.py migrate && python manage.py test workbench.tests.test_domain_models -v 1 --noinput`

Expected: PASS；覆盖唯一约束、idempotency/review_key 条件唯一、`ProductRevision` 不可变保护、`PROTECT` 与非对称依赖；`makemigrations --check --dry-run` 输出 `No changes detected`。

### Task 2: 业务任务状态机

**Files:**
- Create: `workbench/workflows/__init__.py`
- Create: `workbench/workflows/states.py`
- Test: `workbench/tests/test_states.py`

**Interfaces:**
- Produces: `transition_workflow(task, to_status, actor) -> WorkflowTask`；`InvalidTransition`
- 合法路径：`queued→running`、`running→waiting_human|failed|completed|cancelled`、`waiting_human→running|cancelled`、`failed→queued|cancelled`。
- `running→completed` 是合法状态转换，但编排层必须额外检查：所有子任务成功、无未决 HumanReview、产物质检通过。状态机本身不替代门禁。

- [ ] **Step 1: 写失败测试（Django TestCase）**

```python
class StateTests(TestCase):
    def test_legal_and_illegal_transitions(self):
        task = make_workflow_task(status="queued")
        transition_workflow(task, "running", actor="system")
        transition_workflow(task, "completed", actor="system")  # 状态机合法
        with self.assertRaises(InvalidTransition):
            transition_workflow(task, "queued", actor="system")   # completed 是终态
        other = make_workflow_task(status="queued")
        with self.assertRaises(InvalidTransition):
            transition_workflow(other, "completed", actor="system")  # queued→completed 非法
```

- [ ] **Step 2: 运行失败**

Run: `python manage.py test workbench.tests.test_states -v 1 --noinput`

- [ ] **Step 3: 实现转换表与终态保护**

- [ ] **Step 4: 测试通过**

Run: `python manage.py test workbench.tests.test_states -v 1 --noinput`

Expected: PASS；非法 `queued→completed` 被拒绝，合法 `running→completed` 通过状态机，门禁在 Task 10/16 测试。

### Task 3: legacy 全链路产品版本同步

**Files:**
- Modify: `workbench/services.py`（只追加/小改现有方法）
- Create: `workbench/products/__init__.py`
- Create: `workbench/products/versions.py`
- Test: `workbench/tests/test_legacy_compat.py`

**Interfaces:**
- `sync_revision_from_product(product, actor) -> ProductRevision`
- `confirm_batch_revisions(task_id, reviewer) -> list[ProductRevision]`
- `ProductBatch` 只读 `Task.status`，不另存状态。
- `backfill_legacy_product_revisions(dry_run=True) -> BackfillReport`（管理命令 `backfill_product_revisions`）

- [ ] **Step 1: 写测试**

覆盖三条 legacy 路径：

1. `POST /api/tasks` 后每个 Product 有 v1 revision（`draft` 或 `needs_review`）。
2. `PATCH /api/products/{id}` 后生成新 revision，旧 revision 保留。
3. `POST /api/tasks/{id}/confirm` 后对应 revisions 转 `confirmed`；任务状态仍以 `Task.status` 为唯一来源。

还必须覆盖既有 60 个 Product 的初始版本回填：

4. 幂等 backfill 为每个无 legacy 版本的 Product 建 v1，`source=legacy_backfill`，快照取当前真实字段；不得编造历史版本。
5. 按真实 `Task.status` 映射：`confirmed→confirmed`、`awaiting_confirmation→needs_review`、其他→`draft`。
6. 重复执行 backfill 不新增版本；确认状态/审核元数据单独存储，不修改已固化的 `snapshot`。

- [ ] **Step 2: 运行失败**

Run: `python manage.py test workbench.tests.test_legacy_compat -v 1 --noinput`

- [ ] **Step 3: 在现有 `create_task_from_csv`、`update_product`、`confirm_task` 内同步 revision**

不改变原返回值；不新增独立批次状态。

- [ ] **Step 3b: 新增幂等 backfill 管理命令与 dry-run 报告**

Run: `python manage.py backfill_product_revisions --dry-run`，再执行一次真实回填并复跑确认 0 新增。

- [ ] **Step 4: 回归**

Run: `python manage.py test workbench -v 1 --noinput`

Expected: 原 7 项 + 新增测试全部 PASS。

### Task 4: 五板块骨架与真实基础数据

**Files:**
- Modify: `workbench/templates/workbench/base.html`
- Create: `workbench/templates/workbench/home.html`
- Create: `workbench/templates/workbench/products.html`
- Create: `workbench/templates/workbench/agent_center.html`
- Create: `workbench/templates/workbench/artifacts.html`
- Create: `workbench/templates/workbench/runs.html`
- Modify: `workbench/views.py`、`workbench/urls.py`
- Test: `workbench/tests/test_pages.py`

**Interfaces:** 新首页 `/home`，以及 `/products`、`/agent-center`、`/artifacts`、`/runs` 五个导航入口；`/` 继续渲染原任务列表，旧深链保留。

- [ ] **Step 1: 写页面测试**：五个导航项均指向新入口（首页 `/home`）、中文主名“织贸助手（TradeWeave）”、`local_mock` 标识、`/home` 展示真实 Task/Product 数量，且 `/` 仍为原任务列表。
- [ ] **Step 2: 实现基础页面**

Phase 1 只要求真实基础数据可见：首页统计、产品列表、任务/审核空态、交付物空态、运行记录空态。不得用假数据填充。

- [ ] **Step 3: 保留现有三个页面路由**，追加新路由。

- [ ] **Step 4: 运行**

Run: `python manage.py test workbench.tests.test_pages -v 1 --noinput`

### Task 5: 10 条覆盖型模拟产品

**Files:**
- Create: `data/samples/phase1/products.csv`
- Create: `data/samples/phase1/images/*.svg`
- Test: `workbench/tests/test_demo_dataset.py`

- [ ] 断言行数 8–12，覆盖完整、缺图、缺材质、缺尺寸、重复 SKU、同款不同规格、图片编号冲突；所有行标注 demo。
- [ ] Run: `python manage.py test workbench.tests.test_demo_dataset -v 1 --noinput`

### Task 6: 产品修订查询与确认

**Files:**
- Modify: `workbench/products/versions.py`
- Create: `workbench/products/query.py`
- Modify: `workbench/api.py`、`workbench/urls.py`
- Test: `workbench/tests/test_product_library_api.py`

**Interfaces:**
- `GET /api/product-library?q=&status=&batch_id=`
- `GET /api/products/{id}/revisions`

- [ ] 测试搜索、状态筛选、版本顺序、当前 revision 唯一。
- [ ] Run: `python manage.py test workbench.tests.test_product_library_api -v 1 --noinput`

### Task 7: 产品资料库页面基础交互

**Files:**
- Modify: `workbench/templates/workbench/products.html`
- Test: `workbench/tests/test_product_page.py`

- [ ] 搜索/筛选表单、版本与来源列、确认状态、缺项标识；页面只读真实数据。
- [ ] Run: `python manage.py test workbench.tests.test_product_page -v 1 --noinput`

# Phase 2：多 Agent 架构

### Task 8: AgentRuntime 协议与模拟规划

**Files:**
- Create: `workbench/agents/runtime.py`
- Create: `workbench/agents/mock_runtime.py`
- Test: `workbench/tests/test_runtime.py`

**Interfaces:**

```python
class AgentRuntime(Protocol):
    def plan_task(self, task_id: str) -> dict: ...
    def run_subtask(self, subtask_id: str) -> dict: ...
    def resume_task(self, task_id: str) -> dict: ...
    def health_check(self) -> dict: ...
```

- [ ] 测试四方法、`execution_mode=="local_mock"`、`planning_mode=="simulated_rules"`、未知任务异常。
- [ ] Run: `python manage.py test workbench.tests.test_runtime -v 1 --noinput`

### Task 9: 三个职责 Agent + 两个占位

**Files:**
- Create: `workbench/agents/center.py`、`product_agent.py`、`delivery_agent.py`、`placeholders.py`
- Modify: `workbench/agents/registry.py`
- Test: `workbench/tests/test_roles.py`

- [x] 中心输出有序子任务与依赖；产品资料输出候选与冲突；交付质检全批 confirmed 守门；market/quotation 返回 409（Task 9 review clean）。
- [x] Run: `python manage.py test workbench.tests.test_roles -v 1 --noinput`

### Task 10: 编排、依赖、事件与幂等基线

**Files:**
- Create: `workbench/workflows/orchestrator.py`
- Create: `workbench/workflows/events.py`
- Test: `workbench/tests/test_orchestrator.py`

**Interfaces:**
- `dispatch_subtask(subtask_id, idempotency_key) -> SubTask`
- `dispatch_subtask(subtask_id, idempotency_key) -> SubTask`；`resume_task(task_id)` 继续已持久化的下一步。
- 依赖未完成抛 `DependencyNotReady`；重复幂等键返回原结果；并发重复的 running step 明确返回 `StepInProgress`；状态变化写短 EventLog。
- Phase 2 只确认资料就绪；真实文件生成/文件 QA 在 Phase3 未接入前，完成入口必须明确拒绝 WorkflowTask completed。
- 状态：Task 10 已通过 Luna Spec 复审与根主控代码/测试审查；Task10 完成不代表 Phase 3 文件生成或 QA 已实现。

- [x] 测试依赖阻塞/跨工作流/cycle/dangling、幂等与 in-progress、真实角色成功/等待人工/失败、恢复、文件门禁。
- [x] Run: `python manage.py test workbench.tests.test_orchestrator -v 1 --noinput`

# Phase 3：端到端

长期阶段保留。当前批次优先完成通用协作框架；具体业务规则、角色内容与交付要求尚待用户访谈，后续实现前先确认这些内容。

### Task 11: 创建业务任务并生成计划

**Files:**
- Create: `workbench/workflows/prepare.py`
- Modify: `workbench/api.py`、`workbench/urls.py`
- Test: `workbench/tests/test_prepare_workflow.py`

**Interfaces:** `POST /api/workflow-tasks`、`GET /api/workflow-tasks/{id}`。

- [x] 创建后状态 `queued`；中心规划记录为 `center_plan` `WorkflowStep`，并生成 `product_profile`、`delivery_quality` 两个业务子任务（主控裁决：不重复创建 `center` 业务子任务）；返回计划。
- [x] GET 只读已保存的工作流、中心计划、steps、子任务、依赖、来源/结果引用与错误摘要；POST 不触发业务角色、人工审核或产物生成。创建请求不承诺幂等。
- [x] Run: `python manage.py test workbench.tests.test_prepare_workflow -v 1 --noinput`；8 项通过，全量 102 项、`check`、无迁移漂移均通过。

Task 11 已通过 scoped review；验收证据见[Task 11 报告](../../../.superpowers/sdd/2026-10-18-multi-agent-workbench/reports/task11.md)。Phase 3 整体仍未完成。

### Task 12: 六类冲突检测与暂停

> 2026-10-19 Task 12a 已通过 scoped review，仅完成通用 HumanReview candidate 持久化接缝及当前角色已有 needs_human 信号适配；不等于六类检测已实现。Task12a 的演示验证只复用既有结果补录 pending review。完整 Task 12 验收项仍未完成；当前只覆盖现有缺字段、缺图/已有歧义信号和角色通用待确认结果；通用重复 SKU 检测与 typed 人审改号子批次已单独验收；variant、image conflict、source conflict 检测仍待后续实现与实际访谈，不能据此推断企业货号规则。

**Files:**
- Create: `workbench/workflows/validation.py`
- Test: `workbench/tests/test_conflicts.py`

- [ ] `missing_field`、`missing_image`、`duplicate_sku`、`variant_conflict`、`image_conflict`、`source_conflict` 各一条测试。
- [ ] 任务转 `waiting_human`，每类生成 HumanReview。
- [x] 通用重复 SKU 子批次已单独实现并通过真实 demo API/DB/CUA 闭环；用例及终态证据见 `.superpowers/sdd/2026-10-18-multi-agent-workbench/plans/task12-13-duplicate-sku.md` 与外部 `workspace/testing/task12-13-duplicate-sku/finalaudit.json`。该勾选不代表其他五类冲突或 Task12 整体完成。
- [ ] Run: `python manage.py test workbench.tests.test_conflicts -v 1 --noinput`

### Task 13: 人工处理、批准、恢复与任务中心页面

> 通用重复 SKU 子批次已增加显式 typed 回执、可纠正唯一性预检和完整周期 apply/恢复闭环；Task13整体、完整Task13c及Phase3仍未完成。


**Files:**
- Create: `workbench/workflows/reviews.py`
- Modify: `workbench/templates/workbench/agent_center.html`
- Modify: `workbench/api.py`、`workbench/urls.py`
- Test: `workbench/tests/test_resume.py`、`workbench/tests/test_agent_center_page.py`

- [ ] 审核接口与 resume；恢复只执行第一个未完成步骤；重复 resume 幂等。
- [ ] 页面展示计划、子任务依赖、重试次数、审核节点、事件时间线，不显示私有推理。
- [ ] Run: `python manage.py test workbench.tests.test_resume workbench.tests.test_agent_center_page -v 1 --noinput`

### Task 14: 英文目录与样品清单生成

**Files:**
- Create: `workbench/delivery/__init__.py`、`catalog.py`、`checklist.py`、`storage.py`
- Test: `workbench/tests/test_generators.py`

- [x] 从当前全批次 confirmed ProductRevision 与实际 TaskFile 图片生成 `catalog.html`、`catalog.md`、`sample_checklist.csv`、`sample_checklist.json`；有英文名使用其显式值，不猜其他英文翻译。
- [x] 纯生成器缺英文名抛 `EnglishNameRequired`，禁止自动翻译；角色现有 needs_human/candidate 接口可阻断常规生成。
- [ ] 缺英文名之后通过已提交人审答案应用产品事实并恢复工作流；本批未实现 resolver/事实恢复，不把角色 candidate 当作事实已修复。
- [x] 生成时固化 ProductRevision 快照 JSON、source IDs、TaskFile 图片 hash。
- [x] 外部 Python 测试库实际 TEST.NAME 断言为 `tradeloom_test_phase3_files` 后执行 `python manage.py test --keepdb workbench.tests.test_generators -v 1 --noinput`；最终 Markdown delimiter 微调后 generator 6 项通过。

### Task 15: 质检、产物版本与端到端闭环

**Files:**
- Create: `workbench/delivery/quality.py`、`service.py`
- Modify: `workbench/api.py`、`workbench/urls.py`、`config/settings.py`
- Test: `workbench/tests/test_delivery_service.py`、`workbench/tests/test_quality.py`。未来可新增独立 `test_artifacts.py` / `test_end_to_end.py` 用于尚未实现的产品事实审核恢复闭环；这两个文件当前不存在。

- [x] `TRADELOOM_ARTIFACT_ROOT` 默认 `data/runtime/artifacts`；新 attempt 路径不覆盖旧版本，五 ArtifactVersion 递增保存 SHA256、来源快照，并支持 bundle 批准/驳回。
- [x] 文件生成后重读实际文件进行独立 QA；真实 QA 报告校验四种输出 hash，错误或损坏文件不能审核/完成。
- [x] 端到端文件路径：资料就绪→生成 v1/真实下载→驳回→v2→批准→独立显式完成；真实隔离 CUA 已核验 5 Artifact/10 Version、2 审核事件/1 完成事件及 15 份下载 hash。
- [ ] 产品事实冲突→HumanReview 答案解析/事实应用→恢复→重新生成完整闭环；本批不实现该人审事实恢复。
- [x] 验证实际 `TEST.NAME=tradeloom_test_phase3_files` 且传入 `--keepdb` 后，`test_delivery_service`/`test_quality`/`test_generators`/页面回归专项通过；修复前全 workbench 214/214、check/no-drift/nodecheck 通过。最后 generator delimiter 与 fix5 页修后分别另行跑 generator 6/6 和页面 1/1，未声称最后小修后重跑全量。

# Phase 4：可靠性

## Phase 4 子批次状态

- [x] `role-result-contracts`、`tool-contracts`、`role-input-contracts` 与 `task16-17-recovery` 子批次已验收；报告及快照见工作报表和 SDD 证据目录。Task16/17整体、Task18与Phase4整体仍未完成。
- `role-input-contracts` 与 `task16-17-recovery` 均仅为已接受子批次，不代表 Task 16/17 整体或 Phase 4 完成。以下只勾选已有实现与证据覆盖的子项；Task 16/17 其余业务恢复/完成门禁、Task 18 和 Phase 4 其他目标仍未完成。证据见 [实现/自动测试报告](../../../.superpowers/sdd/2026-10-18-multi-agent-workbench/reports/task16-17-recovery.md) 与 [CUA/QA 报告](../../../.superpowers/sdd/2026-10-18-multi-agent-workbench/reports/task16-17-recovery-qa.md)。

### Task 16: 有限重试、失败状态与完成门禁

**Files:**
- Modify: `workbench/workflows/orchestrator.py`
- Test: `workbench/tests/test_retries.py`

- [x] 单子任务最多重试 2 次；耗尽转 `failed` 并写 EventLog。证据：[自动测试](../../../.superpowers/sdd/2026-10-18-multi-agent-workbench/reports/task16-17-recovery.md) 与 [A/B/C 页面验收及耗尽事件](../../../.superpowers/sdd/2026-10-18-multi-agent-workbench/reports/task16-17-recovery-qa.md)。
- [x] 文件交付 complete 入口需要两 SubTask completed、无 pending/submitted 业务审核、当前五版本全 approved、真实 QA/hash 与绑定当前 generation step/五 version IDs 的 approve receipt；仅修改 status/quality 无法完成。见 task14-15-files 报告。
- [ ] 产品事实业务审核的答案应用/恢复完成门禁尚未实现；不能用交付文件审核代替。
- [x] 单子任务 retry 专项在独立 Task16–17 批次验证；后续复跑命令须显式使用 `--keepdb`。

### Task 17: 中断恢复与幂等重放

**Files:**
- Test: `workbench/tests/test_recovery.py`（`TransactionTestCase`）

- [ ] 重建服务后 waiting_human/审核/子任务/WorkflowStep 状态保持。
- [ ] 恢复只从最后未完成步骤继续；重复 resume 不增加 attempt、不重复生成 ArtifactVersion。
- [x] 页面刷新或聊天历史不参与进度判定。证据：[A reload 后历史 attempt 不变且未新增 attempt](../../../.superpowers/sdd/2026-10-18-multi-agent-workbench/reports/task16-17-recovery-qa.md)。
- [ ] Product/Delivery 人审待处理答案的恢复应用，以及生成文件 claim 进程中断后的接管仍未实现；running generation claim 明确阻塞，不套用只读重试。
- [x] 单子任务恢复在独立 Task16–17 批次测试；后续复跑命令须显式使用 `--keepdb`。

### Task 18: 运行记录与设置页面

**Files:**
- Modify: `workbench/views.py`、`workbench/api.py`；新增 `workbench/diagnostics.py`
- Modify: `workbench/templates/workbench/runs.html`
- Modify: `workbench/static/workbench/styles.css`（诊断 hash 折行）
- Test: `workbench/tests/test_runs_page.py`、`workbench/tests/test_delivery_generation_recovery.py`、`workbench/tests/generation_recovery_worker.py`（子进程使用受核验的隔离测试库）

- [x] 展示 EventLog、AgentRun、安全错误摘要、当前规则和 Prompt 版本及真实 SHA、health 检查、`local_mock` 说明；错误、结果、事件 payload、外部凭据与 URL 不显示。
- [x] Run（隔离库 `tradeloom_test_run_diagnostics`、同 shell settings guard、显式 `--keepdb`）：目标 35/35；最终 `python manage.py test --keepdb workbench -v 1 --noinput` 289/289；`manage.py check`、`makemigrations --check --dry-run`、compileall、`git diff --check` 均 exit 0。正式服务已受控重启：旧 listener/launcher 12300/36412 → 新 20916/45200，PostgreSQL 30328 未动；11 个 GET、CSRF 只读 preview 和 13 项正式数据比较通过，无 browser/CUA。
- Task18 完成此诊断切片；Phase 4 其余目标仍未完成。详细实现与边界见 [Task18 诊断报告](../../research/2026-10-19-phase4-run-diagnostics.md)。

# Phase 5：交付体验

### Task 19: 交付物中心预览与下载

**Files:**
- Modify: `workbench/templates/workbench/artifacts.html`
- Test: `workbench/tests/test_artifact_page.py`

- [x] 版本列表、质检与 source/hash 信息、HTML/Markdown 预览、五种文件真实下载；交付 approve/reject 在工作流详情审阅入口完成。
- [x] fix5 后页面显示 5 个文件类型行、4 个 HTML/Markdown 版本预览和 10 个版本下载链接；实际 320px CUA 无横向溢出。回归位于现有 `workbench.tests.test_pages.PageTests.test_artifacts_page_shows_real_artifact_without_fake_download`（不新增不存在的 `test_artifact_page.py`）。
- [x] 补齐用户要求的样品清单预览：交付物列表为每个 CSV 版本提供预览入口；预览读取对应已登记且 SHA 正确的保存 CSV，完整呈现所有列/行，并显示版本、审核状态、来源 Revision、大小、哈希与该版本下载入口。草稿/模拟/未批准状态清晰可见，预览不写业务数据。
- [x] 旧 Task14–15 QA 上 v1 rejected/v2 approved 两个 CSV 保存版本经只读 HTTP 兼容核验，表格与 CSV 原字节解析逐格一致，SHA/下载及状态符合版本记录；旧 QA schema 未迁移。未做浏览器点击验收，完整 e2e 仍为 Task 22 待办。

### Task 20: 交付体验补全

**Files:**
- Modify: `workbench/delivery/service.py`、`workbench/templates/workbench/artifacts.html`
- Test: `workbench/tests/test_delivery_experience.py`

- [x] 工作流详情按当前批次最新 Revision 的 `snapshot.english_name` 展示缺项提示，列出 SKU/位置并链接当前人审项；显隐采用与生成器相同的英文名规则：仅非空字符串算已填写。正常人审链实测 typed 答案提交后提示保留、显式 apply 后提示消失；生成资格仍由现有 Revision 确认等门禁决定。既有 ArtifactVersion 与质检状态不受提示影响，不做翻译/质量检测。Django/loopback HTTP 覆盖见 `workbench/tests/test_english_name_hints.py` 与 `workbench/tests/test_phase7_workflow_http_e2e.py`；未做浏览器点击验收。
- [x] 交付包驳回后生成新版本且旧版本保持只读；真实 CUA 核验 v1 rejected、v2 approved 与每个版本独立下载。
- [x] 下载响应使用真实文件名与 Content-Disposition，服务校验 DB 登记路径/存在性/SHA。
- [x] 页面回归使用存在的 `workbench.tests.test_pages` 定向测试；后续命令先断言实际 TEST.NAME 并显式 `--keepdb`。

# Phase 6：AgentArts

### Task 21: 文档封套 adapter、证据清单与健康状态

**Files:**
- Create: `workbench/agents/agentarts.py`
- Modify: `docs/agentarts-integration-checklist.md`
- Modify: `workbench/api.py`（health 增加 `agentarts_status`）
- Test: `workbench/tests/test_agentarts_adapter.py`

**Interfaces:**
- 根据已核实文档构造 `POST /runtimes/{runtime_name}/invocations` 请求封套与认证头，但默认不发起网络请求。
- `health_check()` 返回 `agentarts=not_configured`、`evidence=documented_not_connected`。

- [x] 离线单测覆盖 Agent `query`、Workflow `inputs`/可选 `plugin_configs`、Header、200/401/404/500 映射、异常 JSON/SSE 内容类型及配置/health 不联网。
- [x] 清单区分“文档已确认 / 账号待测 / 未验证”，不写“真实已接入”；SDK 高代码开发/部署边界已记录。
- [x] Run: 项目外 Python `manage.py test workbench.tests.test_agentarts_adapter -v 1 --noinput --keepdb`，隔离库 `tradeloom_test_agentarts_adapter`，7 tests passed。真实账号、SSE、SDK 安装与正式实例未验证。

# Phase 7：测试交付

### Task 22: 完整浏览器 e2e

**Files:**
- Create: `e2e/workbench-multi-agent-smoke.py`

- [x] Phase 7 HTTP 整链切片：`workbench.tests.test_phase7_workflow_http_e2e` 使用 Django live server 随机 loopback 端口与 urllib 验证业务 API/HTML 链。该切片不替代本任务下面的真实浏览器验收；不得据此勾选 Task 22 或 Phase 7。
- [ ] 创建任务→计划→冲突暂停→编辑/批准→恢复→生成四文件→质检→批准→下载。
- [ ] Run: `python e2e/workbench-multi-agent-smoke.py`

Expected: `e2e_result=passed`，截图与下载文件在 `data/runtime/`。

### Task 23: 全量回归、验收矩阵与报告

**Files:**
- Modify: `docs/work-report.md`、`README.md`
- Test: 全量

- [ ] 运行 `python manage.py test workbench -v 1 --noinput`，全部 PASS。
- [ ] 逐条核对用户 Phase 1–7 验收，失败项标 `[!]`。
- [ ] 更新报告的真实/模拟/未实现分类；平台证据未实测项保持 `[!]`。

## 执行批次与门槛

| 批次 | Task | 进入下一批条件 |
|---|---|---|
| Phase 1 | 1–7 | 增量迁移可回滚；原 7 项测试通过；`/home` 等五页可访问且旧深链保留；10 条模拟数据与版本同步通过 |
| Phase 2 | 8–10 | 四方法 runtime、三职责、依赖/幂等/事件测试通过 |
| Phase 3 | 11–15 | 暂停→审核→恢复→四文件→质检→审批端到端通过 |
| Phase 4 | 16–18 | 重试上限、完成门禁、重启恢复、幂等重放通过 |
| Phase 5 | 19–20 | 预览/下载/版本/英文审核体验通过 |
| Phase 6 | 21 | adapter 单测与证据清单完成，未实测项标 `[!]` |
| Phase 7 | 22–23 | e2e 与全量回归通过，验收矩阵与报告完成 |

每批开始前先跑上一批全量测试；不得跨批合并，不得跳过未验证的平台项。

