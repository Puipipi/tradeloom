# 织贸助手（TradeWeave）多 Agent 工作台业务规格

| 项 | 内容 |
|---|---|
| 状态 | Phase 0 业务规格，待主控审计 |
| 来源 | `<LOCAL_TASK_BRIEF_ROOT>\织贸助手_Codex开发任务书.md`（2026-10-18 22:03，只读引用，不执行其文件操作指令） |
| 目标优先级 | 本规格与 2026-10-18 新目标优先于 `2026-10-17-tradeloom-design.md` 中“3 个智能体 / 报价陪跑”的旧表述 |
| 技术基线 | Django 5.2、PostgreSQL 17、Django templates、现有 `workbench` 应用 |
| 平台状态 | AgentArts 未配置；真实能力待官方证据，禁止把本地模拟描述成平台接入 |

## 命名映射

| 场景 | 名称 |
|---|---|
| 页面中文主名 | 织贸助手（TradeWeave） |
| 英文副名 | TradeWeave Agent Workspace |
| 仓库路径与 Python 包 | `tradeloom`（不变） |
| 历史名称 | TradeLoom、贸织、TradeWeave |
| 数据 ID | 现有 Task/Product/AgentRun 主键与迁移数据全部不变 |

重命名只影响页面显示与文档，不触发仓库、模块、数据库或 URL 大改。

## 产品定位

面向彩带、丝带及装饰品小微工贸企业，把“产品资料整理 → 人工确认 → 英文目录与样品清单 → 质检审核”做成可暂停、可恢复、可审计的工作流。企业访谈尚未完成，当前需求是待验证假设。

分工原则：

- 模型负责理解目标、任务路由、澄清与汇总。
- 普通程序负责校验、读写文件、排版、导出、持久化和权限检查。
- 人确认关键业务事实与高风险操作。
- Agent 之间只交换结构化输入输出，不做无限自由聊天。
- 明确区分真实实现、本地模拟与待接入平台能力。

## 目标运行架构

```text
网页工作台（5 板块）
        │ 同源 JSON / Django templates
        ▼
WorkflowTask 业务任务 + 编排服务
        │
        ├── 中心调度 Agent
        ├── 产品资料 Agent
        ├── 交付与质检 Agent
        ├── 市场与客户 Agent（占位）
        └── 询报价 Agent（占位）
        │
共享层：Product / ProductBatch / ProductRevision / SubTask /
HumanReview / Artifact / ArtifactVersion / EventLog / 文件存储
```

`AgentRuntime` 接口固定为：

```python
plan_task(task_id: str) -> dict
run_subtask(subtask_id: str) -> dict
resume_task(task_id: str) -> dict
health_check() -> dict
```

首版实现 `MockAgentRuntime`，所有输出带 `execution_mode=local_mock`。

`MockAgentRuntime` 的默认计划来自确定性规则或固定模板，必须标注 `planning_mode=simulated_rules` 和“模拟规划”。不得把关键词匹配、规则分支或模板拼接描述成“模型理解”或“LLM 规划”。官方文档已确认的请求封套/协议可以先实现 `AgentArtsRuntime` adapter 并单测，但健康状态保持 `agentarts=not_configured`、证据状态 `documented_not_connected`；只有账号实测与部署验收后才可标“真实已接入”。

## 五个板块

1. **工作台首页**：任务统计、最近任务、待人工确认、失败/完成数量；模拟数据标识。
2. **产品资料库**：货号、名称、品类、材质、颜色、尺寸、图片、来源、版本、确认状态；搜索与筛选。
3. **任务与 Agent 中心**：任务计划、子任务依赖、Agent 状态、输入/输出引用、重试次数、错误摘要、时间线、人工确认节点；不展示模型私有推理。
4. **交付物中心**：英文目录、样品清单、版本、审核状态、真实文件预览与下载；不生成假链接。
5. **运行记录与设置**：工具/Agent 调用、状态变化、错误、规则版本、健康检查、模拟/真实模式说明；不记录密钥。

路由裁决：`/` 继续作为原任务列表，新工作台首页使用 `/home`；五板块导航首页指向 `/home`。现有 `/`、`/tasks/new`、`/tasks/<id>`、`/agents` 深链保持可用，新路由在 Task 4 增量实现。

## 状态模型

业务任务 `WorkflowTask.status`：

```text
queued | running | waiting_human | failed | completed | cancelled
```

产品批次状态（通过 `ProductBatch` 代理读取 `Task.status`，唯一来源）：

```text
created | awaiting_confirmation | confirmed | archived
```

产品修订 `ProductRevision.status`：

```text
draft | needs_review | confirmed | archived
```

交付物 `ArtifactVersion.status`：

```text
draft | pending_approval | approved | rejected
```

业务任务状态与产品批次状态必须分开存储。现有 `Task.status=awaiting_confirmation|confirmed` 与 `/api/tasks/*` 保留为 legacy 产品批次 API，不得与新任务状态混用。

## 数据模型

| 模型 | 关键字段 |
|---|---|
| `WorkflowTask` | id、batch FK → 原 `Task`、user_goal、task_type、status、current_step、result_refs、error_summary、timestamps |
| `ProductBatch` | `Task` 的 proxy 领域别名；批次状态唯一来源为 `Task.status`，不新建状态表 |
| `ProductRevision` | product FK、version、snapshot JSON（不可变业务事实）、field_sources、status、source_refs、reviewer、timestamps；快照允许 legacy 七字段、english_name 及后续人工批准业务字段 |
| `SubTask` | task FK、agent_role、input_refs、output_refs、status、depends_on(M2M self)、retry_count、error_summary、timestamps |
| `WorkflowStep` | task FK、step_key、status、attempt、idempotency_key、input_refs、output_refs、started_at、finished_at、error_summary |
| `HumanReview` | task FK、item_ref、question、options、source_conflict、status、answer、reviewer、timestamps |
| `Artifact` | task FK、artifact_type、storage_key、current_version、status、timestamps |
| `ArtifactVersion` | artifact FK、version、file_path、sha256、source_product_versions、snapshot（固定来源快照）、status、timestamps |
| `EventLog` | task/subtask FK、event_type、actor、payload_summary、created_at |

迁移必须增量、可回滚，不修改 `0001_initial`，不重命名现有表或主键。

Task 1 数据库约束：

- `(product, version)` 唯一，`(artifact, version)` 唯一；
- `(task, idempotency_key)` 在 key 非空时唯一；
- `HumanReview.review_key` 在 `status=pending` 且 key 非空时与 `task` 组合唯一，允许历史空 key；
- 新增模型默认带 timestamps，引用审核/版本证据的 FK 使用 `PROTECT`，`SubTask.depends_on` 为非对称 self M2M；
- 不增加冗余 `is_current` 指针，当前修订由唯一最大 version 确定；事务锁分配版本在 Task 3/交付 service 实现。

`ProductRevision` 的应用层不可变性：已有记录的 `snapshot/product/version` 不得经 `save()`、`QuerySet.update()` 或 `bulk_update()` 改写；`status/reviewer` 等审核元数据仍可更新。人工补充业务事实时创建新 revision，`source_refs` 指向对应 `HumanReview`，旧快照不覆盖。不新增数据库 trigger 或事件溯源框架。`ArtifactVersion.snapshot` 是生成时的固定来源数据，不设计可编辑业务内容。

legacy 同步要求：现有 `create_task_from_csv`、`update_product`、`confirm_task` 必须同步写入/更新 `ProductRevision`。CSV 创建生成 v1，PATCH 生成新版本，确认把对应版本转为 `confirmed`；不能只在新 API 记录版本，也不能复制一套批次状态。

既有 60 个 Product 必须有可追踪的初始版本，不能只给新 CSV 建版本。采用幂等 backfill（管理命令或增量数据迁移）：

- 每个尚无 legacy 版本的 Product 建立 v1，`source_refs.source=legacy_backfill`。
- 按真实 `Task.status` 映射：`confirmed→confirmed`、`awaiting_confirmation→needs_review`、其他→`draft`。
- `snapshot` 固化当前真实字段（sku/name/category/material/size/color/image_filename）；不得编造并不存在的历史版本。
- 重复执行不新增版本；确认状态与审核元数据是独立列，修改它们不得改写 `snapshot`。

## 两条受控工作流

### `prepare_product_data`

读取产品表与图片清单 → 匹配候选 → 确定性校验 → 生成问题清单 → `waiting_human` → 人工编辑并批准 → 恢复 → 生成确认版产品数据。

必须识别：缺字段、缺图、重复 SKU、同款不同规格、图片编号冲突、字段来源冲突。缺资料时暂停，不允许模型猜尺寸、材质或颜色代码。

### `generate_deliverables`

只读取已确认批次 → 生成英文目录（HTML 与 Markdown）与样品清单（CSV 与 JSON）→ 确定性质检 → 生成 Artifact 版本 → `pending_approval` → 人工批准/驳回。

交付物必须是可打开的真实文件，路径、SHA256、来源产品版本可追溯；不允许假下载链接。

### 交付物语言与不可变快照

- 目录与样品清单的正文、字段标签、标题使用英文；CSV/JSON 只保留英文内容与稳定字段名。
- 产品缺少英文名称时，生成前必须创建 `HumanReview` 请人补齐；不得自动翻译产品名称、材质、规格或颜色等业务事实。
- `ArtifactVersion` 必须引用生成时的不可变产品快照（`ProductRevision` ID + 版本号 + 字段值），后续修改产品不得改变已生成交付物。
- 每个版本记录文件路径、SHA256、字节数与来源快照；下载必须返回真实文件。

## 演示数据

提供 8–12 条明显标注为演示的假产品，覆盖：

- 完整记录；
- 缺图；
- 缺材质/尺寸；
- 重复 SKU；
- 同款不同规格；
- 图片编号冲突；
- 字段来源冲突。

不得使用真实客户、订单或报价。现有 2 条演示数据不足，Phase 2 扩展。

## 可靠性与审计

- 单工具/子任务最多重试 2–3 次，耗尽后暂停或失败。
- 每一步写入 `WorkflowStep`（状态、尝试次数、幂等键、输入/输出引用、起止时间），恢复从最后一个持久化步骤继续，不从头重跑。
- 幂等键避免重复创建任务、交付物版本与重复副作用。
- 刷新页面、重启进程后状态一致。
- 不得只用一个 `queued` 状态或聊天历史代表执行进度；业务状态、步骤状态与事件日志分别持久化。
- 每次状态变化写 EventLog，记录 actor、前后状态、引用与摘要，不记录密钥或私有推理。
- 真实平台能力不足时记录替代架构与合规风险，不暗中换平台冒充合规。

## 12-Factor Agents 对齐

| 原则 | 当前 | 目标 |
|---|---|---|
| 自然语言转结构化调用 | 部分（静态上传） | 中心 Agent 生成结构化计划 |
| 提示词/规则版本化 | 无 | 规则与 prompt 版本字段/文件 |
| 上下文标来源 | 部分（missing_fields） | ProductRevision.field_sources |
| 工具有 schema | 部分（dataclass） | 每个工具明确输入/输出/错误 |
| 状态持久化 | 有 legacy Task | WorkflowTask/SubTask/Review/Artifact |
| 暂停恢复 | 有产品确认，无任务暂停 | waiting_human + resume |
| 人工介入 | 有确认按钮 | HumanReview 正式节点 |
| 固定流程由程序控制 | 有确定性校验 | 工作流状态机控制 |
| 有界重试 | 无 | retry_count + 上限 |
| Agent 职责聚焦 | 单执行器 | 3 个实现 + 2 个占位 |
| 核心服务与 UI 解耦 | 有 service 层 | workflows 与 UI 分离 |
| 审计事件与版本 | 仅 AgentRun | EventLog + ArtifactVersion |

## 平台与比赛边界

- 目标为华为第十一届 ICT 大赛创新赛赛题二。
- 不假设本地代码可一键导入 AgentArts，不假设账号已开放全部能力。
- 多 Agent 创建/调用、工作流编排、API 插件与鉴权、文件上传限制、人工暂停恢复、发布与运行时调用、导入导出格式、模型/区域/配额/费用、正式赛题提交限制，全部进入 `docs/agentarts-integration-checklist.md`，逐项等待证据。
- 未取得证据前，页面与报告只能写“本地模拟”，不得写“已接入 AgentArts”。

## 验收总纲

- 按 README 可启动，8000 健康。
- 可创建业务任务并查看中心计划与子任务状态。
- 缺项/冲突暂停并展示人工确认项。
- 确认后恢复，生成英文目录 HTML/Markdown 与样品清单 CSV/JSON 真实文件。
- 交付物有版本、状态、预览、下载与来源版本。
- 失败有错误、有限重试与审计记录。
- 模拟模式清晰可见。
- 测试覆盖状态转换、依赖、人工确认恢复、幂等与交付校验。
- 不提交 `.env`/密钥，不伪造平台能力。

## 用户 Phase 映射

| Phase | 目标 |
|---|---|
| Phase 1 | 五板块 + 数据模型 + 持久化 + 模拟数据 |
| Phase 2 | 多 Agent 架构 |
| Phase 3 | 端到端 |
| Phase 4 | 可靠性 |
| Phase 5 | 交付体验 |
| Phase 6 | AgentArts |
| Phase 7 | 测试交付 |

## 现有实现的复用边界

直接复用：`Product`、`TaskFile`、`AgentRun`、CSV 解析、图片按 SKU 精确匹配、缺项计算、确认后导出 CSV、`AgentRegistry` 结构化契约、Django/PostgreSQL 启动脚本。

增量新增：业务任务/子任务/审核/产物/事件模型与两条工作流；不重写现有产品校验与上传链路。

外部 DSH account 实验位于父容器 `workspace/experiments/central-agent/`，只作为本地协议参考，不复制进正式仓库或正式运行链路。
