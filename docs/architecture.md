# TradeLoom 工作台架构与接口

正式工作台使用 Django 模板、Django JSON API 和 PostgreSQL。运行环境与 PostgreSQL 二进制位于用户目录，不进入仓库；本机 DSH account 双 Agent 测试代码只存在于父容器 ignored 的 `workspace/experiments/central-agent/`，不进入正式 tracked Agent seam。

## 组件

```text
Django templates + vanilla JS
            │ same-origin JSON
            ▼
workbench Django app
  ├── Task / Product / TaskFile / AgentRun
  ├── CSV/图片上传、确认、CSV 导出
  ├── generic Agent contracts + registry
  └── PostgreSQL
```

旧 FastAPI/Vue 主流程已停用。目录中可能残留 ignored 的 `.venv`、`node_modules` 和旧运行数据，但不参与正式启动。

## 数据模型

- `Task`：32 位 UUID hex 主键、标题、demo/upload、状态、创建/更新时间。
- `Product`：32 位 UUID hex、task FK、position、七个产品字段、图片引用、缺失项 JSON。
- `TaskFile`：32 位 UUID hex、task FK、source_csv/image、原始名与 stored name。
- `AgentRun`：32 位 UUID hex、task FK、能力、状态、起止时间、结果 JSON 或错误。

图片只按上传文件 stem 与当前 SKU 精确匹配。`image_filename` 是只读派生字段，修改 SKU 会重新匹配；无匹配时清空并增加“图片”缺项。编辑已确认任务会退回 `awaiting_confirmation`。

## API

| 方法 | 路径 | 用途 |
|---|---|---|
| GET | `/api/health` | 运行状态 |
| GET | `/api/agents` | 能力描述 |
| GET/POST | `/api/tasks` | 列表 / multipart 上传 |
| POST | `/api/tasks/demo` | 演示任务 |
| GET | `/api/tasks/{id}` | 任务和产品 |
| PATCH | `/api/products/{id}` | 编辑产品 |
| POST | `/api/tasks/{id}/confirm` | 确认 |
| GET | `/api/tasks/{id}/export.csv` | 导出 UTF-8 CSV |
| POST | `/api/tasks/{id}/agents/{capability}` | 运行 Agent |
| GET | `/api/tasks/{id}/runs` | 运行历史 |

错误响应统一为 `{"detail": "..."}`，保留 400/404/409/422 语义。

## Agent seam

正式 Agent 接口位于 `workbench/agents/`：

- `AgentRequest`：task_id、capability_id、input_refs、payload。
- `AgentResult`：status、output、pending_items、artifact_refs。
- `AgentExecutor(Protocol)` 与 `AgentRegistry`。

正式 registry 只实现确定性的 `product_profile`；`quotation` 与 `catalog_package` 只登记能力，调用返回 409 并持久化 `unavailable`。正式代码不包含 DSH account adapter、模型调用或凭证。

## 双 Agent 本地 lab

DSH account 测试完全位于父容器 ignored 的 `workspace/experiments/central-agent/`：

- Django JSON API 与 PostgreSQL `tradeloom_lab`。
- 中心 Agent 与 `user_info_agent` 使用两个独立 DSH 标准 SDK 进程、两个独立 patch 和两个独立 session。
- `patch.yml` 禁用所有模型工具/子 Agent/workspace/skill 注入；`patch-center.yml` 与 `patch-user-info.yml` 提供不同系统职责。
- 中心 `ask_user` 自动调用 user_info；最多两次自动信息回复、每次 HTTP 最多五次模型调用。
- user_info 缺项时暂停为 `needs_user_input`；超时会话 fail-closed。
- trace 只记录角色、session、输入摘要、可读输出和动作，不暴露思维过程。

该 lab 的日志、session、数据库连接变量和旧 SQLite 均在 ignored 本机目录。

## 旧 SQLite

旧 `data/runtime/workbench.db` 与 `data/runtime/uploads/` 保留不删除。正式启动不会自动导入。显式执行：

```powershell
python manage.py migrate_legacy_sqlite --path data\runtime\workbench.db
```

导入命令只读打开旧库；文件引用依赖原 `TRADELOOM_MEDIA_ROOT`，换目录时由操作者复制。

## AgentArts 边界

AgentArts 尚未配置。正式工作台与 DSH lab 都不代表 AgentArts 已集成；比赛材料仍需在 AgentArts 完成构建、编排、部署和可视化 Demo。

## 显示名与历史命名

- 页面中文主名：织贸助手（TradeWeave）。
- 英文副名：TradeWeave Agent Workspace。
- 仓库路径、Python 包、URL、数据库表与主键继续使用 `tradeloom` / `TradeLoom`，不做重命名迁移。
- 历史材料中的“贸织”“TradeLoom”与当前“织贸助手（TradeWeave）”指同一项目；数据 ID 不因显示名改变。

## 现状与目标差距（2026-10-18 Phase 0）

下面是已核实的本地现状，不代表目标功能已经实现。

### 当前已实现

| 能力 | 现状 |
|---|---|
| 技术栈 | Django 5.2 + PostgreSQL 17 + Django templates |
| 数据模型 | `Task`、`Product`、`TaskFile`、`AgentRun` 四张表，唯一迁移 `0001_initial` |
| 产品链路 | CSV/图片上传、按 SKU stem 精确匹配图片、缺项计算、编辑、确认、CSV 导出 |
| Agent seam | `AgentRequest/AgentResult` dataclass、`AgentExecutor` 协议、`AgentRegistry` |
| 本地执行器 | 仅 `product_profile`；`quotation`、`catalog_package` 返回 409 |
| 页面 | 任务列表、新建任务、Agent 能力三页 |
| 运行记录 | `AgentRun` 起止时间、结果或错误 |
| 测试 | 工作台 7 项测试通过，迁移无漂移 |

### 尚未实现

| 目标能力 | 差距 |
|---|---|
| 五板块 | 只有 3 个导航入口；缺首页、产品库、交付物中心、运行记录与设置 |
| 业务任务 | 无 `WorkflowTask`，现有 `Task` 只是产品批次；无 `queued/running/waiting_human/failed/completed/cancelled` 状态机 |
| 子任务 | 无 `SubTask`，无依赖、重试次数与 Agent 角色 |
| 人工审核 | 只有产品字段编辑与整体确认，无 `HumanReview` 节点与恢复 |
| 交付物 | 无 `Artifact/ArtifactVersion`，无英文目录、样品清单、质检与版本审核 |
| 事件审计 | 无 `EventLog`；只有 AgentRun |
| 产品版本 | 无 `ProductRevision` 与字段来源确认 |
| Runtime | 无 `AgentRuntime.plan_task/run_subtask/resume_task/health_check` |
| 工作流 | 无 `prepare_product_data` 与 `generate_deliverables` |
| 可靠性 | 无有限重试、幂等键、中断恢复 |
| 演示数据 | 仅 2 条产品，未覆盖 6 类异常 |
| 平台接入 | AgentArts 未配置，无账号与接口证据 |

### 模拟语义与交付边界

- 首版 `MockAgentRuntime` 的计划来自确定性规则/模板，健康信息必须返回 `execution_mode=local_mock`、`planning_mode=simulated_rules`，页面标注“模拟规划”。
- 关键词匹配、规则分支与模板拼接不能描述为“模型理解”“LLM 推理”或平台能力。
- 官方文档已确认的请求封套/协议可以先实现 adapter 并单测，但只能标 `documented_not_connected`；账号实测与部署验收后才可标“真实已接入”。
- 英文目录与样品清单必须使用英文正文与字段标签；缺英文名称时生成 HumanReview 由人补齐，不自动翻译产品事实。
- ArtifactVersion 绑定不可变的 ProductRevision 快照；已生成文件不随产品后续修改而改变。
- 执行进度落在 WorkflowStep；`queued` 单状态或聊天历史不能代表步骤进度。

产品批次不新增状态表：`ProductBatch` 是 `Task` 的 proxy 领域别名，`WorkflowTask` 通过 FK 引用原 `Task`。批次状态唯一来源是 `Task.status`。现有 CSV 创建、产品 PATCH、整体确认必须同步 `ProductRevision`，否则旧接口与版本审计会脱节。

### 用户 Phase 映射

| Phase | 目标 |
|---|---|
| Phase 1 | 五板块 + 数据模型 + 持久化 + 模拟数据 |
| Phase 2 | 多 Agent 架构 |
| Phase 3 | 端到端 |
| Phase 4 | 可靠性 |
| Phase 5 | 交付体验 |
| Phase 6 | AgentArts |
| Phase 7 | 测试交付 |

Phase 1 早期即建立五板块页面并显示真实基础数据，后续 Phase 只充实功能。

### 目标增量

Phase 1–7 按 `docs/superpowers/plans/2026-10-18-multi-agent-workbench.md` 增量实现：

1. 新增业务任务域与状态机，保留 legacy 产品链路。
2. 扩展模拟产品、产品修订与产品库。
3. 引入 `AgentRuntime` 与中心/产品资料/交付质检三个结构化执行器。
4. 实现两条工作流、人工审核、恢复、重试、幂等与事件日志。
5. 生成真实可读的英文目录与样品清单，并做确定性质检与版本审核。
6. 建成五板块页面，明确 `local_mock`。
7. 完成重启恢复、e2e 与 AgentArts 官方证据核验。

任何阶段未通过的测试或未取得的平台证据，都必须在 `docs/work-report.md` 标 `[!]`，不得用文档描述替代实现。
