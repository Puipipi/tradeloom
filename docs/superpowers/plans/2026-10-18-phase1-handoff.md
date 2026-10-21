# Phase 1 执行交接（Task 1–7）

> 本文件是下一执行器的入口。只执行 Task 1 小批；通过评审后再按顺序推进 Task 2–7。不要一次执行整个 Phase。

## 执行边界

- 仓库：`<REPO_ROOT>`
- 分支：`feature/workbench-shell`，保留现有未提交改动；不 checkout、不切分支、不回滚他人修改。
- 本轮执行约束：不 `git add`、不 commit、不 push、不创建远程。
- 不复制父容器 `workspace/experiments/central-agent/` 的 DSH 代码、日志、授权或数据库进正式仓库。
- 不新装依赖；Python 环境使用项目外 `%LOCALAPPDATA%\TradeLoom\python-env`。
- 不在命令输出、日志、文档中打印密码、token 或 `.env` 内容。
- 测试统一 `TestCase/TransactionTestCase`；不新建 `workbench/tests.py`，避免遮蔽现有 package。

## 现有事实

| 项 | 事实 |
|---|---|
| 技术栈 | Django 5.2、PostgreSQL 17、Django templates |
| 现有模型 | `Task`、`Product`、`TaskFile`、`AgentRun`，唯一迁移 `workbench.0001_initial` |
| 现有测试 | `workbench/tests/` package：`test_agents.py` 1 项 + `test_api.py` 6 项 = 7 项 |
| 现有数据 | 30 Task、60 Product、90 TaskFile、21 AgentRun；17 awaiting_confirmation、13 confirmed |
| 现有页面 | 任务列表、新建任务、Agent 能力三页 |
| 现有样例 | `data/samples/products.csv` 仅 2 条 |
| 现有 API | `/api/tasks/*`、`/api/agents`、`/api/health` 保持兼容 |

## 启动与环境

```powershell
Set-Location <REPO_ROOT>
powershell -ExecutionPolicy Bypass -File .\scripts\start-postgres.ps1 -Port 55432
powershell -ExecutionPolicy Bypass -File .\scripts\start-workbench.ps1 -Port 8000
```

测试（外部 Python + 独立测试库，避免交互删除旧 `tradeloom_test`）：

```powershell
$env:TRADELOOM_DB_NAME='tradeloom_dev'
$env:TRADELOOM_DB_HOST='127.0.0.1'
$env:TRADELOOM_DB_PORT='55432'
$env:TRADELOOM_DB_TEST_NAME='tradeloom_test_phase1_taskN'
& "$env:LOCALAPPDATA\TradeLoom\python-env\Scripts\python.exe" manage.py test workbench -v 1 --noinput
```

密码通过 `start-workbench.ps1`/测试脚本从项目外文件读取；不要手工把密码放进命令参数。

## Task 1：增量模型、迁移与约束测试（下一执行器立即开始）

**只做本 Task，不提前做 Task 2–7。**

**文件**

- Modify: `workbench/models.py`（末尾追加）
- Create: `workbench/migrations/0002_workflow_domain.py`
- Create: `workbench/tests/test_domain_models.py`

**新增 8 个模型**

1. `WorkflowTask`：`batch` FK → 原 `Task`；`user_goal`、`task_type`、`status`、`current_step`、`result_refs`、`error_summary`、timestamps。
2. `ProductRevision`：`product` FK、`version`、不可变 `snapshot` JSON、`field_sources`、`status`、`source_refs`、`reviewer`、timestamps。
3. `SubTask`：`task` FK、`agent_role`、`input_refs`、`output_refs`、`status`、`depends_on`（self M2M）、`retry_count`、`error_summary`、timestamps。
4. `WorkflowStep`：`task` FK、`step_key`、`status`、`attempt`、`idempotency_key`、`input_refs`、`output_refs`、`started_at`、`finished_at`、`error_summary`。
5. `HumanReview`：`task` FK、`item_ref`、`question`、`options`、`source_conflict`、`status`、`answer`、`reviewer`、timestamps。
6. `Artifact`：`task` FK、`artifact_type`、`storage_key`、`current_version`、`status`、timestamps。
7. `ArtifactVersion`：`artifact` FK、`version`、`file_path`、`sha256`、`source_product_versions`、`snapshot`、`status`、`created_at`。
8. `EventLog`：`task` FK（可空）、`subtask` FK（可空）、`event_type`、`actor`、`payload_summary`、`created_at`。

`ProductBatch` 不是第 9 个表：它是 `Task` 的 proxy 领域别名：

```python
class ProductBatch(Task):
    class Meta:
        proxy = True
```

**约束**

- 不改 `0001_initial.py`，不重命名现有表/主键。
- `WorkflowTask.status` 与 `Task.status` 分开；批次状态唯一来源是 `Task.status`。
- 新增模型默认带 timestamps；引用审核/版本证据的 FK 使用 `PROTECT`；`SubTask.depends_on` 为非对称 self M2M。字段按后续真实需求设置，避免过建。
- `ProductRevision.snapshot` 存业务事实（legacy 七字段、`english_name` 及后续人工批准字段）；`status/reviewer/field_sources/...` 是元数据，单独列。人工补充创建新 revision，`source_refs` 指向 `HumanReview`，旧快照不覆盖。
- 数据库约束：`(product, version)` 唯一；`(artifact, version)` 唯一；`(task, idempotency_key)` 在 key 非空时唯一；`HumanReview.review_key` 在 `status=pending` 且 key 非空时与 `task` 组合唯一，允许历史空 key。
- 不增加冗余 `is_current` 指针；当前修订由唯一最大 version 确定，事务锁分配版本留到 Task 3/交付 service。
- 应用层不可变性：已有 `ProductRevision` 的 `snapshot/product/version` 不能经 `save()`、`QuerySet.update()`、`bulk_update()` 改写；`status/reviewer` 仍可改。不新增数据库 trigger 或事件溯源框架。
- `ArtifactVersion.snapshot` 保存生成时固定来源快照，不设计可编辑业务内容。

**验收**

```powershell
& "$env:LOCALAPPDATA\TradeLoom\python-env\Scripts\python.exe" manage.py makemigrations workbench --name workflow_domain
& "$env:LOCALAPPDATA\TradeLoom\python-env\Scripts\python.exe" manage.py migrate
& "$env:LOCALAPPDATA\TradeLoom\python-env\Scripts\python.exe" manage.py test workbench -v 1 --noinput
& "$env:LOCALAPPDATA\TradeLoom\python-env\Scripts\python.exe" manage.py makemigrations --check --dry-run
```

Expected：新模型、唯一/条件唯一约束、不可变保护、`PROTECT`、非对称依赖测试通过；原 7 项测试仍通过；`No changes detected`。

## Task 2：业务状态机

- 文件：`workbench/workflows/__init__.py`、`states.py`、`tests/test_states.py`。
- 合法：`queued→running`、`running→waiting_human|failed|completed|cancelled`、`waiting_human→running|cancelled`、`failed→queued|cancelled`。
- `running→completed` 合法，但 Task 10/16 的编排门禁必须检查子任务、未决审核、质检。
- `queued→completed` 非法。
- 只用 Django TestCase。

## Task 3：legacy 版本同步与 60 条存量回填

- 文件：`workbench/products/__init__.py`、`versions.py`；修改 `services.py`；新增 `workbench/management/commands/backfill_product_revisions.py`；`tests/test_legacy_compat.py`。
- 三条旧链路：
  - `create_task_from_csv`：每个 Product 建 v1。
  - `update_product`：生成新版本，旧版本保留。
  - `confirm_task`：对应版本转 `confirmed`。
- 存量 60 个 Product：
  - 无 legacy 版本的 Product 建 v1，`source_refs={"source":"legacy_backfill","legacy_task_id":...}`。
  - 状态映射：`Task.status=confirmed → confirmed`；`awaiting_confirmation → needs_review`；其他 → `draft`。
  - `snapshot` 取当前真实字段；不编造历史版本。
  - 命令幂等：`backfill_product_revisions --dry-run` 先报告；真实执行后再次运行应为 0 新增。
  - 确认/审核元数据变化不得改写 `snapshot`。
- 验收：原 7 项 + 新测试通过；backfill 两次执行第二次 0 新增；60 个 Product 均有版本。

## Task 4：五板块骨架与真实基础数据

- 文件：`base.html`、`home.html`、`products.html`、`agent_center.html`、`artifacts.html`、`runs.html`；`views.py`、`urls.py`；`tests/test_pages.py`。
- `/home`（新首页）、`/products`、`/agent-center`、`/artifacts`、`/runs` 五页 early 可访问；五导航首页指向 `/home`。
- `/` 继续渲染原任务列表；`/tasks/new`、`/tasks/<id>`、`/agents` 旧深链保持可用。
- 首页展示真实 Task/Product 数量；其余页面显示真实数据或明确空态，不造假数据。
- 保留现有 3 个页面路由。
- 中文主名“织贸助手（TradeWeave）”，模拟规划标识 `local_mock`。

## Task 5：10 条覆盖型模拟产品

- 文件：`data/samples/phase1/products.csv`、`data/samples/phase1/images/*.svg`、`tests/test_demo_dataset.py`。
- 8–12 行，覆盖完整、缺图、缺材质、缺尺寸、重复 SKU、同款不同规格、图片编号冲突。
- 全部明显标注 demo，不使用真实客户/报价。

## Task 6：产品库查询与版本 API

- 文件：`workbench/products/query.py`；修改 `api.py`、`urls.py`；`tests/test_product_library_api.py`。
- `GET /api/product-library?q=&status=&batch_id=`；`GET /api/products/{id}/revisions`。
- 搜索、筛选、版本顺序、当前 revision 唯一。

## Task 7：产品资料库页面基础交互

- 文件：`products.html`；`tests/test_product_page.py`。
- 搜索/筛选、版本与来源列、确认状态、缺项标识；只读真实数据。

## 每批评审与快照

- 每个 Task 开始前，把将触碰的现有文件复制到 `.superpowers/sdd/2026-10-18-multi-agent-workbench/snapshots/taskN-before/`。
- 完成后复制到 `taskN-after/`，用 `git diff --no-index` 生成 diff 到 `reviews/taskN.diff`。
- reviewer 只读快照 diff、Task 规格与测试输出，不读 HEAD 范围；原因见 SDD 账本。
- 每个 Task 结束在 `progress.md` 追加完成行；未通过记录 fix round。

## 明确禁止

- `git add` / `git commit` / `git push` / 创建远程。
- 输出密码或 token；把秘密写入文档、日志、命令参数。
- 复制 DSH lab 进正式仓库。
- 一次执行 Task 2–7。
- 用假数据/假下载链接冒充实现。
