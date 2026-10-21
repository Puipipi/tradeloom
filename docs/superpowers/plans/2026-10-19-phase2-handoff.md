# Phase 2 执行交接（Task 8–10）

> Phase 1 已完成并通过最终验收。本文件记录 Phase 2 的接口与交接事实；Task 8–10 已通过审查。当前协作优先级是通用 Agent 框架，具体业务规则、审核选项与交付内容待访谈，长期 Phase 0–7 计划保留。Agent 接入约定见 `docs/agent-development.md`。

## 当前事实

- 仓库：`<REPO_ROOT>`；分支 `feature/workbench-shell` 保持现有未提交基线。
- 环境：Python 在项目外 `%LOCALAPPDATA%\TradeLoom\python-env`；PostgreSQL `127.0.0.1:55432`；密码只从项目外 pwfile 读入环境。
- 测试库按 Task 命名（如 `tradeloom_test_phase2_taskN`）；8000 是正式工作台，8010/DSH/PG 不随本批重启。
- Phase 1 生产基线：Task=30、Product=60、TaskFile=90、AgentRun=21、ProductRevision=60、WorkflowTask=1、EventLog=1。
- Phase 1 探针基线：WorkflowTask `07082f323dfa4746a6f83e0df870ae7d` 原为 `queued`，`task_type=prepare_product_data`，关联 demo 批次 `02bd0d9315664f8183488b93e4de1d1c`；Task10 获准运行后进入 `waiting_human`，`product_profile` 的真实本地模拟结果为 `needs_human`，依赖 `delivery_quality` 保持 queued。探针不是业务审核或文件生成。
- Task 8、9、10 已通过主控审查；Task10 全量 94 项测试、Django check 与迁移漂移检查均通过。获准探针已运行并进入 `waiting_human`，不再是 queued。
- 当前中心/角色执行只代表可替换的本地演示规则，尚未通过实际业务访谈；本阶段只收尾通用框架，具体业务与交付内容等待用户访谈。
- 当前 Phase 3 子批次状态：Task 11、Task 12a、Task 13a、Task 13c1/13c2、Task13b-facts 与 Task13b-image-selection 均已通过相应 scoped review；歧义图片子批次也由主控 CUA 完成冻结候选选择、显式完整周期 apply、固定两角色恢复及真实文件生成/审核/完成闭环和只读审计。Task 12 完整六类检测、`no_image_candidate` 与其他图片/来源冲突、完整 Task 13c、Task 13整体与 Phase 3 其余目标仍未完成。

## 现有模型与来源

- `Task`（批次唯一状态源）、`Product`、`TaskFile`、`AgentRun`。
- `WorkflowTask`、`ProductRevision`、`SubTask`、`WorkflowStep`、`HumanReview`、`Artifact`、`ArtifactVersion`、`EventLog`。
- 产品版本：`workbench/products/versions.py`；查询：`workbench/products/query.py`。
- 状态机：`workbench/workflows/states.py`。
- 现有 registry 三个 capability：`product_profile`、`quotation`、`catalog_package`；旧 `/api/tasks/*`、`/api/agents` 与 `/agents` 页面必须保留。

## Task 8–10 边界

### Task 8：AgentRuntime 协议与模拟规划

- 实现 `AgentRuntime.plan_task/run_subtask/resume_task/health_check` 协议。
- 首版为 `MockAgentRuntime`：明确 `execution_mode=local_mock`、`planning_mode=simulated_rules` 和“模拟规划”；不得把规则/模板称为 LLM 理解。
- AgentArts 仍为 `not_configured`；规则模拟标记为强制项。
- 测试协议行为、模拟标记与错误边界；不接真实 AgentArts。

#### Task 8 计划契约（供 Task 9/10 消费）

- 计划只包含两个业务 `SubTask`：`product_profile` → `delivery_quality`。中心规划记录为独立 `WorkflowStep`，不再重复创建 `center` 业务子任务；若 Task 11 示例仍写“三子任务”，按实际职责改为“中心规划 Step + 两个业务 SubTask”。
- `delivery_quality.input_refs` 固定包含 `workflow_task_id`、`batch_id`、`scope=full_batch`、`all_product_ids`、`all_revision_ids`、`confirmed_revision_ids`、`unconfirmed_product_ids`、`requires_all_products_confirmed=true` 与 `all_products_confirmed`。只有 `confirmed` 子集不能代表完整批次可交付；Task 9 必须检查未确认产品，不能静默忽略。
- 计划输出 schema 限定 `quality_scope=data_readiness`、`artifacts_generated=false`。`ready_for_generation`/`data_readiness` 不等于文件质检 `passed`/`completed`；真实文件生成与质检在 Phase 3 实现。
- Task 8 仍只生成计划，不创建业务子任务、不执行 Agent、不写生产数据。

### Task 9：结构化角色与权限

- 中心协调、产品资料、交付质检三个结构化角色；市场与询报价保留占位（不可用返回 409）。
- 每个角色有明确输入/输出 schema、可见数据来源与权限；共享任务/产品/版本数据来自 ORM，不复制第二套查询。
- 交付质检 Agent 可做真实独立的结构化 dispatch，但只消费 `confirmed` 产品资料的就绪/质检；文件生成在 Phase3 Task14/15，不在 Phase2 提前实现。
- 原有三 capability 与 legacy 产品资料执行器保留；新增角色不能静默替换旧 API。

Task9 已建立独立的 `WorkflowRoleRegistry`，与原有三 capability registry 分开。`run_subtask` 按 `SubTask.agent_role` 分派 `product_profile` / `delivery_quality`，中心规划仍是 `center_plan` `WorkflowStep`；`market_customer` / `quotation` 抛 typed 409，`resume_task` 留待 Task10/13。角色工具只能通过固定 `RoleToolbox` allowlist 调用读取、候选和校验工具，不能确认事实、审批、报价或发消息。

### Task 10：编排、依赖、幂等与完成门禁

- Task10 先完成独立 dispatch、子任务依赖、`WorkflowStep` 幂等键、失败记录与完成门禁；完整有上限重试在 Phase4 Task16，不在 Task10 提前扩展。
- 两个不同业务 Agent 必须有真实独立 dispatch 路径；不得用一个规则 `if` 冒充多 Agent。
- Phase2 不得凭无文件结果把业务任务置 `completed` 或把产物标为 `passed`；文件生成与产物验收在 Phase3 Task14/15。
- `running→completed` 状态层合法，但完成前必须检查：子任务成功、无未决 HumanReview、质检通过。
- Task 10 当前没有真实文件生成或文件 QA 能力；完成门禁在 Phase3 相应实现获确认前明确拒绝 `WorkflowTask.completed`。不能用手写 `Artifact.status=passed` 代替 QA。
- 依赖、幂等、失败/恢复与门禁测试先写 RED；不提前接真实 AgentArts 或新认证。

### Task 11：通用创建与只读查询入口

Task 11 仅提供 `POST /api/workflow-tasks` 与 `GET /api/workflow-tasks/{id}`。POST 原子创建 `queued` WorkflowTask 并复用现有 `plan_task()` 持久化中心计划、两个 queued 业务 SubTask 和依赖；不会触发 handler、审核或产物生成。GET 只序列化数据库已保存的字段/计划/steps/SubTasks/依赖/引用/错误，不重新规划。请求只接受 `batch_id`、`user_goal` 和可选 `task_type`；创建重复请求会创建新工作流，不宣称创建幂等。Task 11 已通过审查，验收报告见 `.superpowers/sdd/2026-10-18-multi-agent-workbench/reports/task11.md`。

### Task 12a：通用待确认事项持久化（已通过 scoped review）

只把当前 `ProductAgent` 的 `missing_fields`/现有 `uncertainties` 与 `DeliveryQualityAgent` 的真实 `needs_human` checks 转成通用 HumanReview 候选；无可解析信号时保留一条通用核对项。candidate 保存稳定 key、空 options、空 reviewer/answer 和经当前 WorkflowContext 校验的来源引用，在同一事务中持久化 review、等待状态和短事件；不批准、不写业务事实、不运行依赖。重复 dispatch/同来源服务重放不重复建立 pending review。

Task 12a 不实现原六类检测中的全部内容；不把现有 `no_image_candidate`、`ambiguous_image_candidate` 扩大解释为自动冲突判定。Task13b-image-selection 后续仅支持从冻结候选中人工选择歧义图片；`no_image_candidate`、variant、其他 image/source conflict 的检测条件与审核选项仍待访谈。Task13a 仍保留通用 `submitted` 回执语义。Task13b-facts 已支持七个基础字段的人写字面值、精确当前 Revision 确认、整周期原子 apply 和固定 WorkflowStep attempt 恢复；普通 note、`no_image_candidate` 与未知审核仍阻断整批应用。完整 Task13c、Task13整体和Phase3其他目标仍未完成。参考 [LangGraph 官方 interrupt 文档](https://docs.langchain.com/oss/python/langgraph/interrupts)仅限持久 payload、同身份恢复与副作用幂等思路；未引入该依赖。

代码冻结、审查与验证证据见 `.superpowers/sdd/2026-10-18-multi-agent-workbench/reports/task12a.md`。审查后只复用探针已有 canonical result 补录 5 条 pending HumanReview；无角色重跑/批准/事实修改，重放不增加 review/event。Task 12 完整验收和 Phase 3 保持未完成。

## 可复用入口

- `WorkbenchService` 的 CSV/产品/确认/运行记录方法；`CSV_FIELDS` 七字段协议与额外列忽略规则。
- `query_product_library`、`get_product_with_revisions`：产品搜索/状态/批次/版本历史共享查询。
- `transition_workflow`：状态转换与真实 from/to EventLog。
- `sync_revision_from_product`、`confirm_batch_revisions`：版本/审核同步；后者要求调用方已锁定/已确认 Task。
- `/api/product-library`、`/api/products/{id}/revisions`、现有多页模板与中文 label 映射。

## Phase 3 框架交接

- 当前验收状态：Task 11 创建/查询入口 `[x]`；Task 12a 当前既有 `needs_human` 信号的通用 pending `HumanReview` 持久化 `[x]`；Task13a 通用提交回执与来源重新核验 `[x]`；Task13c1/13c2 通用 UI/dispatch 子批次 `[x]`；Task13b-facts 的受支持事实应用与固定工作流恢复子批次 `[x]`；Task13b-image-selection 歧义图片人工选择子批次 `[x]`。Task 12 完整六类检测、`no_image_candidate`、其他图片/来源冲突、完整 Task13c、Task13整体与 Phase 3 仍未完成。
- Task13b-facts 的最小可写字段固定为 `sku/name/category/material/size/color/english_name`；`english_name` 只写入新 `ProductRevision.snapshot` 且必须由人提供，不自动翻译。Task13b-image-selection 仅接受精确 schema `{"type":"select_image_candidate","task_file_id":"..."}`，候选来自冻结 canonical 结果，预览入口为只读 `GET /api/workflow-tasks/{workflow_id}/task-files/{task_file_id}/preview`。`submitted` 仍只是回执；单独完整周期 apply 才执行全批 CAS、建立新 Revision 并恢复两既有角色；后续 matcher 验证并复用所选图片，来源标记无效时阻断。`no_image_candidate`、其他 image/source 冲突、企业规则和其他审核决策继续等待访谈。
- 恢复沿现有 WorkflowStep 历史继续并追加单调递增的新 attempt；不能重建或跳过旧 Step 假装 resume。Task13b-facts apply 会重核来源/全批当前 Revision 与 TaskFile，再批准整个支持周期、追加最新固定 plan 并复用两个既有 SubTask；它不自动执行 handlers、生成文件或批准交付。submitted 普通说明、过期来源与unsupported review 仍不能通过。完整 Task13c 页面/闭环仍待完成，且不展示私有推理。
- AgentArts 仍待账号登录后的实际能力验证；具体企业规则/审核选择/交付内容待用户访谈。长期 Phase 0–7 目标保留，未完成项不打勾。

### Task 13a 增量计划：通用审核提交回执

- 范围：新增 `POST /api/workflow-tasks/{workflow_id}/reviews/{review_id}/submit` 与 GET 已保存审核摘要；审核提交仅把 pending 记为 `submitted`，写入非身份认证的 reviewer 标签、answer、来源校验结果、专用 submitted_at 与幂等请求指纹，并原子写一条短事件。来源必须从已保存 `source_conflict.source_refs` 重新验证，客户端不能替换来源；跨批、过期 revision、错绑 revision、外来文件或无法证明归属的 `subtask_id/result_ref` 均拒绝。
- 锁序：事务先锁 WorkflowTask，再按 ID 排序锁批次 Task 与相关 Product，继而锁 HumanReview 与其来源记录；不调用角色、Agent 或外部服务。重放相同 review_key/answer/reviewer 返回原回执和时间；不同内容冲突，不覆盖历史回执。
- 测试先行：真实角色生成 pending 候选后覆盖成功提交、幂等、格式/对象归属、来源过期/错绑、CSRF、rollback、GET 只读、门禁阻塞及双连接 PostgreSQL 并发提交。生产代码在针对性 RED 证据前不写。
- 历史停点：Task13a 当时只创建提交回执，不应用 answer、不批准、不改写 Product/Revision/Task/SubTask/Workflow、不 resume 或调用 Agent。后续 Task13b-facts 已实现并验收明确范围内的事实应用与新 WorkflowStep attempt 恢复；普通提交语义保持不变。Task12 六类、完整 Task13c、Task13整体和Phase3仍未完成。

## 过程约束

- Phase 1 已采用复用 worker、小批 TDD、冻结 before/after diff 的独立 review；Phase 2 延续小批 TDD 与 scoped diff，不重开总审计循环。
- 不复制 DSH lab 代码/日志/授权/数据库进正式仓库；不输出密码/token/.env 内容。
- 不 `git add/commit/push`、不切分支、不创建远程、不安装项目内软件、不回退他人改动。
- 先完成 Task 8，RED/GREEN 后再进入 Task 9；每批独立快照、diff、报告和 review。

### Task 13c1：通用工作流列表、只读详情与审核说明回执（前置于 Task 13b）

Task 13c1 在 Task 13b 之前交付通用可操作回执界面：用户需要先能查看已保存的计划、步骤、子任务、来源与审核队列，并将 `pending` 项的补充说明提交为 `submitted` 回执；Task 13b 之后再定义获批事实字段、应用规则与新 attempt 恢复。这样界面可验证 Task13a 的提交边界，而不会预设待访谈的业务字段、审核选项或三人分工。Task13c1 不代表完整 Task13、Task13c、Task13b 或 Phase3 已完成。

- Agent Center 提供通用“创建业务计划”表单，使用已有产品批次与目标文本，固定默认 `prepare_product_data`；复用 `POST /api/workflow-tasks`，成功跳转详情。空批次引导到 `/tasks/new`；提交时只创建计划与排队子任务，明确尚未运行；请求中禁用按钮防双击，错误保留输入。
- 工作流、子任务、pending/submitted 审核列表可导航到详情，状态区分待填写与已提交待核验。
- GET `/workflow-tasks/<id>` 复用 `get_prepared_workflow()` 与 `serialize_prepared_workflow()`，未知 ID 404，GET-only 并设置 CSRF cookie；不规划、不写库、不调用 handler。展示目标、批次、状态/模拟标记、已存计划、步骤 attempt/时间、子任务角色/状态/依赖/输入输出引用/短错误、审核和计数、按时间与 ID 排序的事件；不展示私有推理或完整任意 raw output JSON。来源引用可折叠并保留可追溯 ID。
- pending 审核仅提供普通说明文本、填写人标签（最多 120 字）和保存按钮；发送现有 submit API 所需 `{review_key, answer:{note:text}, reviewer:label}`。非空浏览器校验，API 422/409/故障保留输入并就近显示错误；成功刷新为只读 submitted 回执，展示实际 `submitted_at`、说明与标签。submitted 不可覆盖；已存在的非 note JSON 回答只安全只读摘要。页面明确说明“说明已保存，待核验；不会应用产品事实或恢复任务”，不提供批准/恢复/真实调用/下载。
- 页面沿用现有 indigo/teal 壳、中文卡片与表格；不重做导航或新增依赖。320px 下页面不横向溢出（表格容器可滚动），键盘 focus、字段 label、`aria-live` 错误、长 ID/文本可换行，空态与失败态给出下一步。
- TDD RED：先新增独立 `test_workflow_pages.py`，用已有 API 与 `create_pending_review()` 真实 fixture 验证详情只读/不调用 plan/handler、创建表单和批次选择、表单数据/跳转钩子、pending/submitted 回执字段与状态、HTML escape、foreign/unknown 404 与 GET-only、CSRF cookie；确认失败后再实现。
- GREEN：仅修改 `views.py`、`urls.py`、Agent Center 与详情模板、现有 `app.js`/`styles.css`，新增独立测试；不触及 models/migrations/services/agents/orchestrator/reviews.py。可添加纯展示 helper；event 只读查询稳定排序。
- 验证：目标 `test_workflow_pages`、既有 `test_pages`、完整 workbench、Django `check`、`makemigrations --check --dry-run`；使用项目外 Python 与隔离测试库 `tradeloom_test_phase3_task13c1`，测试数据库口令仅从项目外 pwfile 注入。静态 JS 语法可查；浏览器真实 DOM 交互由主控 CUA 验收，不将自动化断言当作浏览器验收。
- SDD：Task13c1 实际触及文件已有 `task13c1-before/after`、`reviews/task13c1.diff`、Fix1/Fix2 独立增量与 8 字段 `reports/task13c1.md`；主控/Luna 审查及 CUA 验收已通过，不改写 HEAD 大基线及 Task13a/12a 快照。Task13c1 子批次 `[x]`；Task13b、完整 Task13c、Task13、Phase3 仍未完成。说明式提交语义参考 [Django Forms 文档](https://docs.djangoproject.com/en/5.2/topics/forms/) 与 [Django CSRF 文档](https://docs.djangoproject.com/en/5.2/howto/csrf/)，不增加依赖。

### Task 13c1 验收状态更新（2026-10-19）

- 主控与 Luna 已通过 base、Fix1、Fix2 scoped review；CUA 在隔离 QA 库验证创建计划、pending note 提交/刷新、空输入校验、来源过期 HTTP 409 输入保留及 320px 页面/容器内表格滚动。
- Fix1 目标 6/6、页面 12/12、全 workbench 129/129、Django check、迁移 no-drift 与 JS syntax check 通过；Fix2 定向目标 6/6、页面 12/12 通过。正式工作台仅只读检查，QA 8011 已停止。
- 当前状态：Task13c1/13c2 与 Task13b-facts 子批次标记 `[x]`；`task14-15-files` 文件生成、落盘 QA、bundle 审核、受控下载/预览和显式完成门禁已通过自动化验证及主控隔离 CUA。Task13b-facts 的同一隔离 demo 继续完成人审应用、两角色恢复、v1 驳回、v2 批准及显式完成；10 个下载 hash 与 ArtifactVersion/磁盘一致。以上均是子批次，不代表完整 Task14/15、Task13c、Task13、Task12六类检测或Phase3完成。两次历史 PermissionError 根因未确认；标准服务重启后两次后续生成通过，不声称有修复。生成进程 crash 接管仍属 Task17 缺口。

### Task 13c2：保存计划的单子任务 dispatch API 与详情页执行入口

- **目标与边界**：为用户已保存的明确 SubTask 提供一次显式本地模拟 dispatch。入口为 `POST /api/workflow-tasks/<workflow_id>/subtasks/<subtask_id>/dispatch`，body 仅 `{ "idempotency_key": "..." }`。不推断意图、不重规划、不循环执行依赖/后续角色、不自动批准、恢复、重试或完成 WorkflowTask；不增加企业审核事实、产品规则、文件生成、迁移、模型、Agent 或依赖。
- **输入契约**：严格解析标准 JSON 对象，拒绝 NaN/Infinity、未知/只读字段和错类型；键必须为字符串，原样保存、长度 1–200，且非空白。非法请求 422；GET 返回 405；沿用 Django CSRF。先解析 WorkflowTask 与 SubTask，并验证 SubTask 属于该 WorkflowTask；缺失或跨工作流 ID 统一 404，且不调用 engine。
- **应用服务与 engine**：新增 `workbench/workflows/execution.py` 薄应用服务；验证归属后恰好调用现有 `WorkflowOrchestrator.dispatch_subtask(subtask_id, key)` 一次。不可外围套事务，以免将 handler 锁在事务中。engine 仅允许对 `SubTask.status == queued` 且 WorkflowTask 状态为 `queued`/`running` 的**新**执行创建 step；`pending/submitted HumanReview`、依赖状态及其余现有门禁继续权威。保留现有 key match/prior step 的 replay、`StepInProgress` 与 `IdempotencyConflict` 判定顺序：已保存同 key 的 running 返回 409；匹配的 completed/failed step 回读原 SubTask；不同 key 不能重派同一 SubTask，同一 WorkflowTask 的 key 不能绑其他逻辑 step；不同 WorkflowTask 可使用相同 key。没有存量 step 却发现终态/等待 SubTask 时不得静默返回成功。WorkflowTask 状态改为 `queued/running` allowlist，拒绝 unknown 与终态。
- **HTTP 语义**：200 表示读取/返回持久化调度结果，不保证 completed。响应只含 `workflow_id`、`subtask_id`、`workflow_status`、`subtask_status`、实际 `step`（id/key/status/attempt/started_at/finished_at）和 canonical `result_ref`，加现有 `SIMULATED_MARKERS`（`local_mock`、`simulated_rules`、`not_configured`）；不返回任意 raw output 或私有推理。同 key 重放 step ID 不变且不增加 handler、started event。running→409 `step_in_progress`；幂等冲突、依赖/审核/状态拒绝分别返回稳定 409 code；未知或不归属→404；输入错误→422。handler 或 `InvalidAgentResult` 等执行失败要先让 engine 持久化失败并 rethrow，再返回不泄漏异常原文的 500 `execution_failed`；失败回读仍明确展示保存的 failed 状态，不称为成功执行、不自动重试。
- **状态校验/UI**：详情页 overview 仅在已保存 WorkflowTask 为 queued/running、unresolved review 数为 0、无 running 子任务且按现有顺序有一个 queued SubTask 其同 workflow 依赖全部 completed 时展示“执行下一步（本地模拟）”。选择首个 eligible 目标；若无法执行，以明确短文案说明等待依赖/人审/运行中/失败或终态，不显示可执行按钮。页面状态只是提示，POST 必须重新校验。隐藏目标 ID 与稳定键 `workflow:{workflow_id}:subtask:{subtask_id}`；沿用 `jsonFetch` 与 CSRF，提交时禁用按钮防双击，成功刷新详情；失败用就近 `aria-live` 展示短错误并提供刷新入口。同 key 重试会读取原步骤。将 overview 的“页面不会运行它们”更新为“保存不会执行；点击按钮只运行一个本地模拟子任务”，提交说明仍不解锁。只加必要 CSS，保留 320px 宽度行为和现有壳。
- **测试先行（独立 `workbench/tests/test_workflow_dispatch.py`）**：RED 覆盖 endpoint 缺失、严格 body/CSRF/GET/404 foreign，先确认正确失败。核心成功路径用真实创建 plan 与当前 mock runtime：dispatch Product → waiting_human；Delivery 仍未运行；同 key 返回相同步骤且步骤/event/handler 不增。完整 confirmed demo fixture（测试资料仅）分别调用两角色，验证真实依赖顺序，且无文件、WorkflowTask 不 completed。拒绝早派依赖、跨 workflow 依赖、人审 pending/submitted、终态/未知 WorkflowTask、非 queued SubTask 均无 step/event/handler 写入；覆盖同 key 跨 SubTask 409、不同 WorkflowTask key 可复用、换 key 重派同 SubTask 冲突。异常和不合法 runtime result 返回通用 500，Workflow/SubTask/Step 持久 failed，HTTP 不泄漏内部文本；failed step 同 key 回放原记录且不重跑。
- **并发/事务**：真实 PostgreSQL `TransactionTestCase`、两个独立连接；第一个 handler 在事务外受有界 Event 暂停，第二请求同 SubTask/key 必须 409；释放后重请求 200 同 step。断言仅 1 handler、1 step、1 started event。测试清理连接并使用有界等待避免 hang；不可在 `TestCase` 外层事务里伪证并发。
- **文档/范围与验证**：可窄改 orchestrator 状态 guard，其余责任限于 `execution.py`、`api.py`/`urls.py`、`workflow_views.py`/详情模板/`app.js`/必要 CSS、独立测试、README、`docs/agent-development.md`、本 handoff、`docs/work-report.md` 与 SDD。报告按既有八字段列批次/目标/来源/固定版本/范围/结果/验证/状态。来源为现有 engine、[12-factor-agents Factor 6](https://github.com/humanlayer/12-factor-agents/blob/main/content/factor-06-launch-pause-resume.md) 与 [Django 5.2 transactions](https://docs.djangoproject.com/en/5.2/topics/db/transactions/)；仅复用 simple API/持久 checkpoint/自控流程原则，不引入框架。先保存 `task13c2-before`，通过后保存 `task13c2-after` 与 `reviews/task13c2.diff`，修复使用独立 fixN。外部 Python 与隔离库 `tradeloom_test_phase3_task13c2`，密码仅 env 注入。运行目标、orchestrator/page相关测试、一次 workbench 全量、Django check、迁移 no-drift、node syntax；记录实际数量/退出码。实现通过后只准备 `workspace/testing/task13c2`、QA 库名 `tradeloom_ui_task13c2`、loopback 8011 方案，暂不启动/seed，交主控审查与 CUA。8000/PG 保持，8010 不启动，不复用上批 QA 库。Task13c2 即使通过只标本子批次待审；Task13、Phase3/4/5 仍未完成。

#### Task 13c2 实施验证进展（2026-10-19）

- RED 证据：新增 endpoint 测试在路由实现前 9 个请求断言得到预期 404；状态 guard 独立测试也先失败，证明原 engine 会静默返回无 step 的 completed 子任务并接受 unknown WorkflowTask 状态。
- 基础 GREEN：dispatch API 与 PostgreSQL 双连接并发目标 17 项、`test_orchestrator`/页面回归 29 项、完整 workbench 146 项通过；check、迁移 no-drift、JS syntax 均 exit 0。Fix1 RED 曾在数据库读回得到私有 marker；修复后相关目标 28 项及完整 workbench 146 项 exit 0。
- 双连接检查使用 `TransactionTestCase`、独立 Django Client/连接及 5 秒有界 Event；handler 在 orchestrator claim 事务提交后暂停，第二连接收到 409 `step_in_progress`，释放后同 key 读取相同 step；1 handler、1 step、1 started event。测试显式关闭 worker 线程连接，隔离库成功清理。
- 正式 8000 GET-only 检查确认 Agent Center/详情 200、dispatch GET 405；正式库只读计数 1 WF、5 pending、0 submitted。主控/Luna review 与 CUA 已通过，QA 证据见 `reports/task13c2.md`；独立 QA 库最终 3 WF，8011 已停止且数据/日志保留，正式库无 dispatch POST。Task13c2 仅子批次已验收；Task13/完整 Task13c/Phase3/4/5 仍未完成。


#### Task 13c2 review / CUA 收尾（2026-10-19）

- Minor fix1：`_record_failure` 固定失败摘要，不拼接未知异常；失败状态、step/source 引用、失败事件与异常 rethrow 保持。回归确认 GET/HTML/event 无 marker、same-key failed replay 不重跑。
- 主控与 Luna scoped review 通过。CUA 在 `tradeloom_ui_task13c2` 验证 A 缺英文名后进入 human review；提交说明不会解锁；B 两角色逐次执行且 workflow 不自动 completed/无文件；C 仅用于 320px布局。QA详情、SQL、HTTP日志和 viewport 图片见 `.superpowers/sdd/2026-10-18-multi-agent-workbench/reports/task13c2.md`。
- QA A/B/C 分别为 `16c80e2beddc4ac298e4ac7b98766ddf` / `be4ec2d330cc4041976331289cb9acdc` / `d1ff8c928c5b4b6589ad80df66480e6c`。正式数据只读：1 WF、5 pending、0 submitted；QA结束后仅停本任务 8011 父子进程，8000/PG保持。
- Task13c2 标记 `[x]` 仅代表本子批次。后续 `task16-17-recovery` 显式有限重试/中断接管子批次与 Task13b-facts 均已通过主控审查及 CUA；Task16/17整体、Task18与Phase4仍未完成。Task13整体、完整 Task13c、Task12六类检测、Phase3及Phase4/5未完成；AgentArts 未配置。

### Phase 4 handoff：role-result-contracts、tool-contracts 与 role-input-contracts 子批次已验收

三个子批次已由主控审查接受，均只表示各自范围完成，Phase 4 整体仍为 `[-]`。`role-input-contracts` 让 Product/Delivery 的注册 `input_schema` 在真实 runtime `execute()` 前校验，并让新计划直接引用注册的 input/output schema；已有计划 replay 保持原 JSON。错误保持安全且角色标记明确，unknown subtask/center/role 与 unavailable placeholder 的既有优先级、领域来源校验顺序保留。Product 可选 `product_revision_ids` 与 Delivery 可选 `all_revision_ids` 均允许 null；Delivery 的兼容性 fix1 只运行定向 Runtime 测试 1/1。

验证记录需按阶段阅读：目标组 51/51 exit 0（当时含随后消除的 Django UserWarning）；fixture 修正后 TestRunner guard 7/7、workbench 168/168 均 exit 0 且无 warning。`manage.py check` 与迁移 no-drift 在此前 exit 0，之后未重跑。之后 nullable 兼容性 fix1 目标测试 1/1 exit 0，fix1 后未运行 169 项全量。原生 Django TestRunner 现要求显式 `TRADELOOM_DB_TEST_NAME` 匹配 `TEST.NAME` 且指向 `tradeloom_test_*`，运行命令见 README。

执行器曾因错拼测试变量而让 Django 清理默认 `tradeloom_test` 并创建/销毁同名测试库；该库原数据未知，无测试库备份证据。业务连接配置为 `tradeloom_dev`，正式库给定只读计数核对前后均为 WorkflowTask 1、HumanReview pending/submitted 5/0、Artifact 0。查询仅涉及 `tradeloom_dev`、`tradeloom_test`、`tradeloom_test_phase4_inputs` 三个指定库名，正式库 dump 不作为测试库恢复证据。事故细节见 [独立记录](../../../.superpowers/sdd/2026-10-18-multi-agent-workbench/reports/role-input-contracts-error.md)。

`task16-17-recovery` 子批次现已由主控接受并完成隔离 CUA；详见 SDD `reports/task16-17-recovery.md`、`reports/task16-17-recovery-fix1.md` 与 `reports/task16-17-recovery-qa.md`。实现通过既有 Django/PostgreSQL 短事务与 WorkflowStep 历史支持每个 SubTask 最多 3 次 attempt 的显式安全重试、历史 key 回放及 outcome-unknown 接管；无 Temporal/LangGraph 运行时依赖，也无后台自动重试。Task 16/17 整体、Task 18、Phase 4 整体仍未完成；Task13b-facts 当前已完成其基础事实应用/恢复子批次，完整 Task13、Phase3 其他目标和 Phase5–7仍待后续。QA 库 `tradeloom_ui_phase4_recovery` 与外部 seed/log/PID 证据保留，8011 已停止；正式库只读 1 WorkflowTask、5 pending/0 submitted、0 Artifact。

### Task13b-facts acceptance handoff（2026-10-19）

- 通过 scoped code review 与真实隔离 CUA；验收记录见 `.superpowers/sdd/2026-10-18-multi-agent-workbench/reports/task13b-facts.md`，只读 QA 审计脚本/结果与 pre/post apply 证据保存在外部 `workspace/testing/task13b-facts/`。
- UI 支持 7 个基础字段的人工字面值（`sku/name/category/material/size/color/english_name`）与精确 current Revision 确认。`english_name` 仅进入 Revision snapshot、不自动翻译；普通 note 提交仍只是回执，note/image/未知信号会阻断整个人审周期。
- Apply 对当前完整周期进行来源与全批 CAS，在单一事务内创建 immutable Revision、批准 cycle、append 最新固定 plan 并复用两个原 SubTask。用户随后逐步执行 Product→Delivery；文件生成、bundle 驳回/批准和明确 complete 均为独立操作。该子批次不增加新业务策略或动态 DAG。
- QA 闭环结果：两条旧 Revision 和五条 Review 的 answer/source 不变；2 个 SubTask 原 ID 保留并 completed；center plan 2、apply step/event 各 1；生成 attempts 4（前两次 PermissionError，后两次成功）；5 Artifact、10 Versions、2 次 bundle review、1 次 delivery complete event。10 个下载/DB/磁盘 SHA256 匹配，v1 rejected、v2 approved。
- 两次 PermissionError 的根因仍未确认；诊断运行没有捕获异常，标准服务重启后第 3、4 次生成成功，没有针对这两次失败的代码修复。QA DB/文件/诊断材料保留；owned 8011 已关闭，formal 8000 未写。duplicate SKU/image arbitration、完整 Task12/13/Phase3 与 Phase0–7 目标仍待后续；没有 AgentArts、付费 provider 或外部平台接入。
