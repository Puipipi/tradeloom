# 原始总目标验收矩阵

本矩阵中的本机证据路径已规范为占位符；原始外部证据不随源码克隆提供。

审计日期：2026-10-20。依据原始目标文件 `<LOCAL_TASK_BRIEF>` 逐项核对，并追加后续 DSH 桌面、手机与六 Agent 目标；各项状态依可定位源码/测试/运行证据判定。

本矩阵中的本机证据路径已规范为占位符；原始外部证据不随源码克隆提供。

状态含义：`[x]` 该条原文范围已被对应证据证明；`[-]` 已有实现但目标范围或证据不足；`[ ]` 尚未实现；`[!]` 受真实外部条件阻塞。

本矩阵中的本机证据路径已规范为占位符；原始外部证据不随源码克隆提供。

本矩阵包含原始 Phase 0–7 的 **65 条任务**、**8 条阶段完成标准**、**10 条总体约束**、**5 个架构组成**和**2 条用户边界**。阶段总体结论单列，子项勾选不自动推导阶段完成。

本矩阵中的本机证据路径已规范为占位符；原始外部证据不随源码克隆提供。

> **当前范围（2026-10-21）：** 本地 source-mode Electron 原生 GUI 已验收五个业务路由、配置场景、Dockview 双栏工作区、原生聊天面板、模型/助手入口与 Site 日夜主题；用户草稿、会话和面板状态有既有持久化证据。最新主题验收及当前25项源文件冻结见[本批方法审计基线](verification/2026-10-21-bingus-methodology-audit.md)与其引用的记录。真实 DeepSeek Flash 仅在演示数据下完成自然语言提案/澄清及 product/delivery 只读工具调用；业务执行仍标记 `local_mock/simulated_rules`，不代表模型自主完成整条 workflow、企业真实资料或真人审批。此前 source-pointer bundle 已实机验收Dockview分栏、标签合并与拆分；当前 source 已官方同步并后台启动，但本轮共享卡片间距CSS尚无 GUI 复验。远端 ERP 服务健康且八个 token GET 返回 HTTP 200；本地配置已导入但运行 Django 尚未启用，故 TradeLoom 到 ERPNext 的读/写集成仍未验收。390×844 与 320×720 是虚拟视口，不是实体手机；p8安装版未包含当前 source-mode 更新；企业规则访谈、实体手机仍未完成；AgentArts/P6已豁免。

本矩阵中的本机证据路径已规范为占位符；原始外部证据不随源码克隆提供。

## 逐条阶段任务与阶段标准

本矩阵中的本机证据路径已规范为占位符；原始外部证据不随源码克隆提供。

### Phase 0

本矩阵中的本机证据路径已规范为占位符；原始外部证据不随源码克隆提供。

| ID | 原始目标（简述） | 状态 | 证据及边界 | 未达成条件 |
|---|---|---:|---|---|
| P0-T01 | 检查当前仓库结构、已有代码、技术栈和依赖。 | [x] | `README.md:19`、`docs/architecture.md:3`、`requirements-workbench.txt:1`及`config/settings.py:1`记录仓库、架构和依赖现状。 | — |
| P0-T02 | 阅读项目根目录中的开发任务书及相关说明。 | [x] | 用户原始任务书：`<LOCAL_TASK_BRIEF>`，标题“织贸助手：多 Agent 工作台 — Codex 开发任务书”，SHA-256（原始字节）`443d829057e224176b63c0eb3db637db0beebce3ea59495cf6fea695b7fc0ac5`；本轮只读作为需求来源。实施计划是相关说明：`docs/superpowers/plans/2026-10-18-multi-agent-workbench.md`。 | — |
| P0-T03 | 核实华为第十一届 ICT 大赛创新赛赛题二的正式要求。 | [x] | 官方 `queryHtmlContext` 原始 JSON HTTP 200，SHA-256 `7eec5410cf6fb63b217a42b7563d73e60e6b05e2c2c6c2f3c551c5b53c3f75e7`；`zoneId=98269700`、`compId=85132021`、`version=89`、当前更新时间 `2026-10-19T02:00:30+08:00`。任务与评分来自 `data.modules[1]` / `tagId=ZM03`；来源、提交物和适用边界见`docs/research/2026-10-18-platform-capabilities.md` §8 与 `docs/00-赛题与目标.md`。原始文件保存在项目外 `<LOCAL_RESEARCH_ROOT>\official-rules-20261019\queryHtmlContext.json`。 | — |
| P0-T04 | 检查 AgentArts 对多 Agent、工作流、工具接口、应用发布和运行时调用的支持情况。 | [x] | `docs/research/2026-10-18-platform-capabilities.md:53`及§2.1–2.5按官方文档分别记录Agent/工作流、API、认证、文件和发布边界；报告明确账号能力仍待实测。 | — |
| P0-T05 | 输出实际技术架构、实施计划和平台兼容性风险。 | [x] | `docs/architecture.md:3`、`docs/superpowers/plans/2026-10-18-multi-agent-workbench.md:1`及`docs/research/2026-10-18-platform-capabilities.md:53`分别记录架构、实施计划和兼容风险。 | — |
| P0-T06 | 明确哪些功能可以直接实现，哪些需要真实账号或额外配置。 | [x] | `docs/agentarts-integration-checklist.md:39`与`docs/research/2026-10-18-platform-capabilities.md:53`逐项区分本地可做、账号实测、需额外开发；属于文档规划，不是账号实测。 | — |
| P0-AC | 阶段完成标准：有明确的实施计划和技术选型依据，不假定未经验证的平台能力。 | [x] | `docs/architecture.md:3`；`docs/superpowers/plans/2026-10-18-multi-agent-workbench.md:1`；官方平台研究明确保留账号实测边界。 | — |

本矩阵中的本机证据路径已规范为占位符；原始外部证据不随源码克隆提供。

### Phase 1

本矩阵中的本机证据路径已规范为占位符；原始外部证据不随源码克隆提供。

| ID | 原始目标（简述） | 状态 | 证据及边界 | 未达成条件 |
|---|---|---:|---|---|
| P1-T01 | 建立统一的网页工作台和导航。 | [x] | `workbench/views.py:185`首页及导航；`workbench/tests/test_pages.py:101`验证五页导航；当前同源295/295日志另见外部`full-workbench-final.log`。 | — |
| P1-T02 | 实现五个板块：工作台首页、产品资料库、任务与 Agent 中心、交付物中心、运行记录与设置。 | [x] | `workbench/views.py:185,219,312,413,445`分别提供五个页面；`workbench/tests/test_pages.py:101`验证五页可访问。 | — |
| P1-T03 | 建立任务、子任务、产品资料、人工确认、交付物和事件日志的数据模型。 | [x] | `workbench/models.py:13,30,59,80,108,163,216,247,282,339,370`定义任务、产品、文件、运行、工作流、审核、交付物和事件模型；`workbench/tests/test_domain_models.py:76,94,110,135,156`验证模型关系。 | — |
| P1-T04 | 实现数据持久化，避免刷新页面或重启后任务状态丢失。 | [x] | `workbench/tests/test_prepare_workflow.py:68`验证持久化计划/步骤的只读读取；外部`<LOCAL_EVIDENCE_ROOT>\phase4-generation-recovery\formal-restart-comparison.json`记录正式数据重启前后快照。未证明源代码精确回滚，故只支持持久化/重启保留范围。 |— |
| P1-T05 | 准备明确标记的模拟数据和模拟运行模式。 | [x] | `workbench/agents/mock_runtime.py:20,103`显式固定Mock模式和模拟标识；`workbench/tests/test_runtime.py:171`验证运行时依赖与schema。 | — |
| P1-AC | 阶段完成标准：应用可以启动，五个板块可访问，基本数据能够创建、查看和持久保存。 | [x] | `workbench/tests/test_pages.py:101`五页导航；`workbench/tests/test_domain_models.py:76,94,110,135,156`模型；`formal-restart-comparison.json`保留数据快照。应用可访问和数据持久化有证据，精确代码回滚不在此结论内。 | — |

本矩阵中的本机证据路径已规范为占位符；原始外部证据不随源码克隆提供。

### Phase 2

本矩阵中的本机证据路径已规范为占位符；原始外部证据不随源码克隆提供。

| ID | 原始目标（简述） | 状态 | 证据及边界 | 未达成条件 |
|---|---|---:|---|---|
| P2-T01 | 实现中心调度 Agent，负责理解目标、任务分类、子任务分派和结果汇总。 | [x] | `workbench/agents/center.py:14`；`workbench/tests/test_roles.py:159`中心计划；`workbench/tests/test_orchestrator.py:94`两项依赖子任务的结构化计划。仅证明本地规则实现。 | — |
| P2-T02 | 实现产品资料 Agent，负责产品资料整理、图片匹配候选和缺项检查。 | [x] | `workbench/agents/product_agent.py:13`；`workbench/tests/test_roles.py:235,323`读取图片候选及结构化输出；不证明真实云Agent。 | — |
| P2-T03 | 实现交付与质检 Agent，负责目录草稿、样品清单和交付物校验。 | [x] | `workbench/agents/delivery_agent.py:13`；`workbench/delivery/catalog.py:32`目录生成；`workbench/delivery/checklist.py:46`清单生成；`workbench/tests/test_generators.py:44,78,90,98`覆盖生成。 | — |
| P2-T04 | 为市场与客户 Agent 预留独立接口和职责边界。 | [x] | `workbench/agents/registry.py:37`职责注册；`workbench/tests/test_roles.py:808,839`额外市场/客户角色保留为占位并验证registry；此项只要求预留接口。 | — |
| P2-T05 | 为询报价 Agent 预留独立接口和职责边界。 | [x] | `workbench/agents/registry.py:37`角色注册；`workbench/tests/test_roles.py:808,839`验证报价/客户角色占位与registry，不证明报价决策功能。 | — |
| P2-T06 | 为每个 Agent 定义结构化输入、输出、权限和错误处理。 | [x] | `workbench/agents/workflow_contracts.py:1`及`workbench/agents/tool_contracts.py:154`；`workbench/tests/test_roles.py:620,678,714`验证工具allowlist、schema和结果校验。 | — |
| P2-T07 | 通过中心调度或明确的工作流协调 Agent，避免无约束的自由对话。 | [x] | `workbench/workflows/orchestrator.py:1`控制依赖执行；`workbench/tests/test_orchestrator.py:94`验证中心生成并持久化两个有依赖子任务。 | — |
| P2-T08 | 让各 Agent 共享可信业务数据，而不是依赖聊天记忆传递关键事实。 | [x] | `workbench/agents/context.py:1`组装来源上下文；`workbench/tests/test_roles.py:323`验证资料来源/schema；`workbench/tests/test_runtime.py:171`验证角色依赖上下文。 | — |
| P2-AC | 阶段完成标准：中心 Agent 能够真实调度至少两个职责不同的业务 Agent，查看各自的任务状态，并汇总结构化结果。若使用模拟运行时，必须清楚标记为模拟实现。 | [x] | `workbench/tests/test_orchestrator.py:94`两职责子任务计划；`workbench/tests/test_runtime.py:290`运行子任务；`workbench/agents/mock_runtime.py:103`明确模拟标记。范围为本地mock。 | — |

本矩阵中的本机证据路径已规范为占位符；原始外部证据不随源码克隆提供。

### Phase 3

本矩阵中的本机证据路径已规范为占位符；原始外部证据不随源码克隆提供。

| ID | 原始目标（简述） | 状态 | 证据及边界 | 未达成条件 |
|---|---|---:|---|---|
| P3-T01 | 支持创建产品资料整理任务。 | [x] | `workbench/views.py:445`工作流入口；`workbench/tests/test_prepare_workflow.py:39`准备流程；HTTP整链`workbench/tests/test_phase7_workflow_http_e2e.py:182`真实loopback创建任务。 | — |
| P3-T02 | 支持读取模拟产品表和图片清单。 | [x] | `workbench/workflows/validation.py:301`读取产品与图片并构建候选；`workbench/tests/test_review_candidates.py:472`覆盖候选；HTTP测试`test_phase7_workflow_http_e2e.py:182`上传实际CSV/图片。 | — |
| P3-T03 | 生成图片与产品编号的匹配候选。 | [x] | `workbench/workflows/validation.py:301`构造图片审核候选；`workbench/tests/test_image_selection.py:251`图片选择候选；`workbench/tests/test_review_candidates.py:427`重复SKU候选。 | — |
| P3-T04 | 检查缺失字段、重复编号和资料冲突。 | [-] | `workbench/workflows/validation.py:301`及`workbench/tests/test_review_candidates.py:427,472`覆盖缺项/重复SKU与候选审核；浏览器冲突 workflow `96b2afeccfb94814967c52212b57f1aa` 真实出现 2 项 duplicate SKU 与 2 项 ambiguous-image review，证据在 `workspace/testing/desktop-package-contract/business-demo-20261019-234414-f4fb04c3/logs/conflict-ui-downloads/ui-summary.md`。尚无同款异规格和来源冲突规则判定。 | 企业访谈后补充规格、图片编号/来源冲突规则。 |
| P3-T05 | 对不确定信息生成明确的人工确认事项。 | [x] | `workbench/workflows/validation.py:301`产生待审核候选；`workbench/tests/test_review_candidates.py:472`候选构建；`workbench/tests/test_review_application.py:125`只在显式确认后应用。 | — |
| P3-T06 | 允许用户在工作台处理缺项和冲突。 | [x] | `workbench/templates/workbench/workflow_detail.html:1`审核表单；`workbench/tests/test_review_application.py:125`应用确认；HTTP整链`workbench/tests/test_phase7_workflow_http_e2e.py:182`覆盖表单提交。 | — |
| P3-T07 | 用户确认后，从已保存的任务状态继续执行。 | [x] | `workbench/workflows/orchestrator.py:765`恢复入口；`workbench/tests/test_review_submission.py:162`提交审核不自动应用；HTTP整链`workbench/tests/test_phase7_workflow_http_e2e.py:182`覆盖显式apply/resume。 | — |
| P3-T08 | 根据已确认的产品资料生成英文目录草稿。 | [x] | `workbench/delivery/catalog.py:32`目录生成；`workbench/tests/test_generators.py:44,78`验证目录内容。 | — |
| P3-T09 | 生成样品核对清单。 | [x] | `workbench/delivery/checklist.py:46,55`样品清单生成；`workbench/tests/test_generators.py:90,98`验证产物。 | — |
| P3-T10 | 对交付物执行缺图、漏项和字段一致性检查。 | [x] | `workbench/delivery/quality.py:28`交付检查；`workbench/tests/test_quality.py:52,65`覆盖质量错误/一致性检查。 | — |
| P3-AC | 阶段完成标准：能够完整演示“创建任务 → 调度 Agent → 发现冲突 → 暂停 → 人工确认 → 恢复 → 生成交付物 → 审核”的流程。 | [x] | Django 页面真实浏览器演示已完成缺项确认与重复 SKU/图片歧义冲突两条链；冲突 workflow `96b2afeccfb94814967c52212b57f1aa` 在 `workspace/testing/desktop-package-contract/business-demo-20261019-234414-f4fb04c3/logs/conflict-ui-downloads/ui-summary.md` 记录六条 review、显式 apply/resume、5 个 v1 产物审核和 reload 后完成。运行均标记 `local_mock/simulated_rules`，不是原生 DSH 页面或真实模型。 | 企业其他规格/来源冲突规则仍须访谈与单独实现；此项仅确认已演示场景的端到端标准。 |

本矩阵中的本机证据路径已规范为占位符；原始外部证据不随源码克隆提供。

### Phase 4

本矩阵中的本机证据路径已规范为占位符；原始外部证据不随源码克隆提供。

| ID | 原始目标（简述） | 状态 | 证据及边界 | 未达成条件 |
|---|---|---:|---|---|
| P4-T01 | 将自然语言任务转换为结构化任务和工具参数。 | [-] | 源码接入可选白名单 `task_type`、签名预览及人工确认，legacy 无字段路径保留。除本地 GUI 的预填→预览→显式确认外，真实 DeepSeek Flash 原生会话已完成自然语言提案、澄清及受控提案交接；证据：[真实 provider GUI 验收](../../workspace/runtime/tradeloom-harness/evidence/real-provider-gui-20261021/acceptance.json)。验证范围限于该模型和本次演示输入；后续执行仍为 `local_mock/simulated_rules`，不能推导自主完成业务流程。源码入口：`workbench/intent/parser.py`、`workbench/api.py`、`workbench/agents/center.py`、`packages/tradeloom-shell/business-tools.js`。 | 保持人工确认门禁；企业规则与更广任务输入需访谈和单独验收。 |
| P4-T02 | 将提示词和业务规则独立管理，支持修改和测试。 | [x] | `workbench/intent/rules.json:1`独立规则；`workbench/intent/prompt.md:1`独立提示；`workbench/tests/test_task_intent.py:25,74`覆盖解析行为。 | — |
| P4-T03 | 根据当前任务动态组织必要上下文，并保留资料来源。 | [x] | `workbench/agents/context.py:1`按当前角色组装上下文；`workbench/tests/test_roles.py:323`校验带来源资料schema。 | — |
| P4-T04 | 为工具定义明确的输入输出 schema。 | [x] | `workbench/agents/tool_contracts.py:154`定义工具schema；`workbench/tests/test_roles.py:620,678,714`验证允许工具、非法ID及结果schema。 | — |
| P4-T05 | 实现任务状态持久化和暂停恢复。 | [x] | `workbench/workflows/orchestrator.py:765`恢复工作流；`workbench/tests/test_recovery.py:68,166,169`验证失效接管和恢复；`test_delivery_generation_recovery.py:192,211,228,244`验证进程硬退出恢复。 | — |
| P4-T06 | 将人工确认作为正式任务状态。 | [x] | `workbench/models.py:282`持久化HumanReview；`workbench/tests/test_review_submission.py:162,427`验证提交与审批门禁状态。 | — |
| P4-T07 | 使用确定性代码控制关键执行流程。 | [x] | `workbench/workflows/states.py:1`集中状态转换；`workbench/tests/test_states.py:48`验证合法状态图；`test_orchestrator.py:519`覆盖流程转换。 | — |
| P4-T08 | 实现有上限的重试、错误记录和失败接管。 | [x] | `workbench/tests/test_retries.py:102`重试有上限；`workbench/tests/test_recovery.py:68`失败接管；`test_delivery_generation_recovery.py:192,211,228,244`四种硬退出恢复边界。 | — |
| P4-T09 | 为关键操作保存可审计的事件记录。 | [x] | `workbench/models.py:370`EventLog；`workbench/tests/test_delivery_service.py:121,244`检查事件与审批边界；`test_delivery_generation_recovery.py:192`校验重放不重复写事件。 | — |
| P4-T10 | 避免重复执行造成重复副作用。 | [x] | 根审查与只读审查已完成当前公开关键写/执行入口的有界核对：workflow create/dispatch/retry/review submit+apply/resume/generation/takeover/bundle review/complete 均已有 key、状态、fingerprint 或重复状态保护；Product PATCH/confirm 同事实复用 revision。legacy AgentRun 由 `workbench/services.py:331` 使用主键短事务 claim，详见 `workbench/tests/test_api.py:132,148,167,193,208,219,240` 和真实 PostgreSQL 插入竞争测试 `workbench/tests/test_agent_run_idempotency_concurrency.py:72`；新版客户端回执由 `workbench/tests/js/test_agent_run_receipts.js:1` 覆盖。无 key 的 legacy 调用和显式新建操作保留原语义。测试日志：项目外 `workspace/testing/phase4-legacy-run-receipts/closeout/full-workbench-suite.log`。结论限于当前已实现公开入口，不外推到未来真实 LLM/provider/AgentArts 或浏览器行为。 | — |
| P4-T11 | 不展示模型私有内部推理链，只展示执行状态、依据来源、结果和下一步。 | [x] | `workbench/templates/workbench/runs.html:1`展示运行摘要；`workbench/tests/test_runs_page.py:52`验证UI状态字段；未发现呈现私有推理链的输出字段。 | — |
| P4-AC | 阶段完成标准：任务中断后能够恢复；异常有明确状态；关键操作可追踪；Agent 不会无限循环或绕过审批。 | [x] | `test_recovery.py:68,166,169`、`test_retries.py:102`及`test_delivery_generation_recovery.py:192,211,228,244`证明当前公开流程具备中断恢复/接管、错误状态和有限重试；`workspace/testing/phase4-generation-recovery/final-checks.log`记录27项恢复测试。该结论限于已实现的本地范围。DSH stdio SDK transport 可复用线索见 `workspace/experiments/central-agent/labapp/dsh_client.py`、`runtime.py`，尚未审查/接入/验证；AgentArts 按用户最新指示暂不实施。 | 后续在 DSH 当前产品实现中复用并验证模型 transport；本项当前本地范围已由既有证据支持。 |

本矩阵中的本机证据路径已规范为占位符；原始外部证据不随源码克隆提供。

### Phase 5

本矩阵中的本机证据路径已规范为占位符；原始外部证据不随源码克隆提供。

| ID | 原始目标（简述） | 状态 | 证据及边界 | 未达成条件 |
|---|---|---:|---|---|
| P5-T01 | 能够查看产品资料、任务进度和 Agent 执行状态。 | [x] | `workbench/views.py:219,445`资料/工作流页面；`workbench/tests/test_pages.py:169,296`页面行为；HTTP链`test_phase7_workflow_http_e2e.py:182`证明新流程请求可访问，不证明浏览器点击。 | — |
| P5-T02 | 能够查看子任务依赖、输入输出引用和错误摘要。 | [x] | `workbench/templates/workbench/workflow_detail.html:1`显示步骤状态；`workbench/tests/test_runs_page.py:52`及`test_recovery.py:68`覆盖状态/错误记录查看。 | — |
| P5-T03 | 能够查看待人工确认事项并提交确认结果。 | [x] | `workbench/templates/workbench/workflow_detail.html:1`待确认操作表单及当前英文名缺项提示；`workbench/tests/test_english_name_hints.py:1`覆盖最新版本/历史回执/batch隔离/HTML转义；`workbench/tests/test_phase7_workflow_http_e2e.py:282`覆盖提交后提示保留、显式apply后消失。 | — |
| P5-T04 | 能够预览生成的目录草稿和样品清单。 | [x] | `workbench/templates/workbench/artifacts.html:1`预览界面；`workbench/tests/test_delivery_service.py:323`预览服务；HTTP链`test_phase7_workflow_http_e2e.py:182`预览生成文件。 | — |
| P5-T05 | 能够下载真实生成的文件，而不是虚构下载链接。 | [x] | `workbench/delivery/service.py:1033`下载响应；`workbench/tests/test_delivery_service.py:323`断言文件字节；HTTP链`test_phase7_workflow_http_e2e.py:182`下载五类生成文件。 | — |
| P5-T06 | 记录交付物版本、审核状态和关联产品数据版本。 | [x] | `workbench/models.py:339`ArtifactVersion；`workbench/tests/test_delivery_service.py:323`版本关联；HTTP链`test_phase7_workflow_http_e2e.py:182`核对生成版本。 | — |
| P5-T07 | 能够查看任务历史、工具调用记录和失败原因。 | [x] | `workbench/models.py:370`事件记录；`workbench/templates/workbench/runs.html:1`运行历史；`workbench/tests/test_runs_page.py:52`验证显示内容。 | — |
| P5-T08 | 清楚标记模拟模式与真实服务模式。 | [x] | `workbench/agents/mock_runtime.py:103`和`workbench/tests/test_runs_page.py:52`覆盖运行标识；两条真实浏览器演示使用 `local_mock/simulated_rules`，见 `docs/work-report.md` 2026-10-20 八字段报告及隔离演示证据。 | 接入任何真实 provider 后仍须单独验证标签与模式切换。 |
| P5-AC | 阶段完成标准：用户可以通过工作台完成主要操作，不需要直接修改数据库或查看源代码才能完成演示。 | [x] | Django 业务 UI 的缺项确认与冲突处理两条浏览器流程均完成，并在 reload/隔离 Django 重启后复核状态；冲突流程证据见 `workspace/testing/desktop-package-contract/business-demo-20261019-234414-f4fb04c3/logs/conflict-ui-downloads/ui-summary.md`。不代表安装版 DSH 原生窗口验收。 | —（原业务工作台演示范围）；安装版 GUI 另见本矩阵“后续桌面与跨端目标”。 |

本矩阵中的本机证据路径已规范为占位符；原始外部证据不随源码克隆提供。

### Phase 6

本矩阵中的本机证据路径已规范为占位符；原始外部证据不随源码克隆提供。

| ID | 原始目标（简述） | 状态 | 证据及边界 | 未达成条件 |
|---|---|---:|---|---|
| P6-T01 | 验证实际比赛账号能否创建多个独立 Agent。 | [!] | `docs/agentarts-integration-checklist.md:45`及官方研究`2026-10-18-platform-capabilities.md:53`为账号实测待验证；`workbench/agents/registry.py:37`为本地注册表。无比赛账号实测。 | 需比赛账号权限进行创建并留存控制台证据。 |
| P6-T02 | 验证中心 Agent 能否调用其他 Agent 或通过工作流编排它们。 | [!] | 官方研究`docs/research/2026-10-18-platform-capabilities.md:57-60`记载平台编排文档边界及版本风险；无账号实际调用证据。 | 需账号部署并实际调用中心与子Agent，记录请求/响应。 |
| P6-T03 | 验证自定义工具、API 插件及鉴权方式。 | [!] | 官方研究`docs/research/2026-10-18-platform-capabilities.md:81-82`记录插件鉴权文档边界；Task 21 adapter 只保留调用方传入的插件配置结构，不代表账号验证插件或凭据。 | 需账号验证插件创建、认证与运行。 |
| P6-T04 | 验证文件上传限制、模型可用性和运行时调用方式。 | [!] | 官方研究`docs/research/2026-10-18-platform-capabilities.md:64-67`记录Runtime API/文件上传文档限制；Task 21 已有离线封套 mapper，未发送真实 Runtime 请求。 | 需账号核验区域、模型、文件开关及真实Runtime调用。 |
| P6-T05 | 验证暂停、恢复和人工确认是否需要自行实现。 | [!] | 本地暂停/恢复由`workbench/workflows/orchestrator.py:765`实现；AgentArts官方暂停能力在`docs/research/2026-10-18-platform-capabilities.md:87`仍标待账号验证。 | 需账号测试平台能力；本地封套 mapper 不覆盖平台恢复。 |
| P6-T06 | 验证应用发布、外部网页调用和部署方式。 | [!] | `docs/research/2026-10-18-platform-capabilities.md:84-85`记载网页/API发布文档边界；无真实发布URL/外部访问记录。 | 需账号发布部署并验证外部网页/API调用。 |
| P6-T07 | 验证平台导入导出格式、区域、配额、费用和权限。 | [!] | `docs/research/2026-10-18-platform-capabilities.md:77,89`记载区域/套餐/费用文档依据；账号配额、账单及权限未实测。 | 需账号控制台、配额及账单证据逐项核验。 |
| P6-T08 | 对照正式赛题确认部署方式与提交物符合要求。 | [-] | `docs/00-赛题与目标.md`及官方研究`docs/research/2026-10-18-platform-capabilities.md` §8 记录本次已核验的正式部署与分阶段提交要求；仍无 AgentArts 部署成果和最终提交物可供比对。 | 按已核验赛题要求完成 AgentArts 平台部署，并核对最终提交物与在线交互 Demo。 |
| P6-T09 | 记录每项能力的实际验证结果和证据。 | [-] | `docs/agentarts-integration-checklist.md:39`记录各项待验证状态，但暂无每项账号实测结果及原始证据。 | 账号实测完成后逐项附可复核证据；当前保持未验证。 |
| P6-AC | 阶段完成标准：清楚区分已验证、未验证、不支持和需要额外开发的能力。不允许将本地模拟运行描述成真实 AgentArts 接入。 | [x] | `docs/agentarts-integration-checklist.md`区分官方文档能力、离线 adapter、账号未验证及未连接状态；`/api/health` 明确为 `not_configured/documented_not_connected`。此标准只验收如实区分状态，不代表平台能力已实测；P6-T01–T09仍未完成。 | P6-T01–T09保留原始追踪且仍未验证；按用户最新指示暂不实施，不作为当前工作阻塞。 |

本矩阵中的本机证据路径已规范为占位符；原始外部证据不随源码克隆提供。

### Phase 7

本矩阵中的本机证据路径已规范为占位符；原始外部证据不随源码克隆提供。

| ID | 原始目标（简述） | 状态 | 证据及边界 | 未达成条件 |
|---|---|---:|---|---|
| P7-T01 | 编写并运行自动化测试。 | [x] | Task 21 历史官方 schema 修订检查点定向7/7及当时 workbench 全量302/302，后续两处同模块微调由定向7/7复核；保留其历史时点，未改写为最终源码验证。Task 20/21 最终源码 workbench 303/303（35.504秒）见项目外 `<LOCAL_EVIDENCE_ROOT>\phase5-english-hints\final-full-workbench-test.log`。这些自动化测试不证明真实 AgentArts。 | — |
| P7-T02 | 覆盖 Agent 分派、子任务依赖、状态转换、人工确认恢复和交付物校验。 | [x] | `workbench/tests/test_phase7_workflow_http_e2e.py:182`端到端流程；`workbench/tests/test_orchestrator.py:94`分派/依赖；`workbench/tests/test_review_submission.py:162`人工确认；295/295日志为同源总量记录，不单独证明每个行为。 | — |
| P7-T03 | 测试工具失败、重复提交和任务中断。 | [x] | `workbench/tests/test_retries.py:102`有界重试；`workbench/tests/test_recovery.py:68,166,169`中断接管/恢复；`workbench/tests/test_delivery_generation_recovery.py:192,211,228,244`四处硬退出边界；外部`<LOCAL_EVIDENCE_ROOT>\phase4-generation-recovery\final-checks.log`记录27个recovery测试通过。295总数仅作为总体日志。 | — |
| P7-T04 | 提供清晰的本地启动说明。 | [x] | `README.md:67`本地启动步骤及`README.md:103`演示步骤。 | — |
| P7-T05 | 提供环境变量示例，不硬编码密钥。 | [x] | `.env.example:1`环境变量模板；`config/settings.py:1`从环境读取设置；不包含真实密钥。 | — |
| P7-T06 | 更新项目 README 和 AgentArts 集成检查清单。 | [x] | `README.md:1`项目说明；`docs/agentarts-integration-checklist.md:1`集成清单与实测边界。 | — |
| P7-T07 | 检查所有模拟功能是否清楚标识。 | [x] | `workbench/agents/mock_runtime.py:103`运行标识；`workbench/tests/test_runs_page.py:52`页面显示模式；README已说明local mock。 | — |
| P7-T08 | 整理演示流程、已知限制和后续计划。 | [x] | `README.md:103`演示流程、`:180`已知限制和后续工作。 | — |
| P7-AC | 阶段完成标准：项目可运行、可测试、可复现，且能够明确展示多 Agent 对真实业务流程的帮助。 | [x] | 本地自动化回归、README 运行/演示说明与两条带模拟标识的浏览器工作流支持本地可运行、可测试及可复现演示；不把 local mock 解释为真实模型或 AgentArts。 | 真实 provider/平台能力是后续产品验收，不是本地阶段标准的证据。 |

本矩阵中的本机证据路径已规范为占位符；原始外部证据不随源码克隆提供。

## 总体设计约束

本矩阵中的本机证据路径已规范为占位符；原始外部证据不随源码克隆提供。

| ID | 原始约束 | 状态 | 直接证据与边界 | 仍需满足的条件 |
|---|---|---:|---|---|
| C-01 | 大模型负责理解任务、选择工具、处理模糊信息和提出澄清问题。 | [-] | 本地 GUI 的提案预填、解析预览和人工确认，以及真实 DeepSeek Flash 原生会话的自然语言提案/澄清已验证；product、delivery 两个业务角色各自执行只读工具，第三个 delivery child 读取审核摘要并区分 `reviews_scope=business_facts` 与 `delivery_review_summary`。证据：[真实 provider GUI 验收](../../workspace/runtime/tradeloom-harness/evidence/real-provider-gui-20261021/acceptance.json)。这证明本次 provider 与演示输入下的理解、工具选择和摘要，不证明整条 workflow 由模型自主执行；执行仍为 `local_mock/simulated_rules`，保存/执行保留人工门禁。 | 企业事实与规则需访谈；更广任务类型及完整真实业务闭环仍需单独验收。 |
| C-02 | 普通程序负责数据校验、文件处理、计算、排版、导出和状态管理。 | [x] | `workbench/delivery/quality.py:28`字段质量规则及`workbench/tests/test_quality.py:52,65`；`workbench/delivery/catalog.py:32`、`checklist.py:46`与`test_generators.py:44,90`分别证明生成；`workbench/agents/tool_contracts.py:154`和`test_roles.py:620,678,714`证明schema/结果校验；`workbench/workflows/states.py:1`、`test_states.py:48`及`test_orchestrator.py:519`证明受覆盖的状态转换。范围限于这些代码路径。 | — |
| C-03 | 人负责确认关键业务事实以及最终报价、交期等高风险决定。 | [x] | `workbench/delivery/service.py:896,1033`及`workbench/tests/test_delivery_service.py:121,244`、`workbench/tests/test_review_application.py:125,266`证明关键资料与交付审批需显式确认；报价工具当前无执行能力且以 409 拒绝（`workbench/agents/placeholder.py:43`、`workbench/agents/context.py:61`、`workbench/tests/test_roles.py:830`）。当前实现不越过人工决策边界。 | 企业访谈后定义报价/交期字段和人工确认流程；该未来业务设计不阻碍当前已实现边界验收。 |
| C-04 | 每个 Agent 都必须有清晰的职责、输入、输出和权限边界。 | [x] | `workbench/agents/workflow_contracts.py:1`职责/合同；`workbench/agents/tool_contracts.py:154`权限与schema；`workbench/tests/test_roles.py:620,678,714`验证allowlist、坏输入和结果。 | — |
| C-05 | 所有关键任务必须支持状态追踪和必要的暂停恢复。 | [x] | `workbench/workflows/orchestrator.py:765,825`恢复/完成入口；`workbench/tests/test_recovery.py:68,166,169`接管恢复；`test_delivery_generation_recovery.py:192,211,228,244`硬退出后恢复。范围是已覆盖工作流。 | — |
| C-06 | 未确认的业务数据不得被标记为已确认事实。 | [x] | `workbench/tests/test_delivery_service.py:244`未确认资料阻止交付；`workbench/tests/test_review_application.py:125`显式apply才变更revision；`workbench/tests/test_review_submission.py:162`单纯提交不应用事实。 | — |
| C-07 | 不得伪造企业数据、平台接入状态、执行结果或测试结果。 | [x] | `workbench/agents/mock_runtime.py:103`及`workbench/tests/test_runs_page.py:52`覆盖 Mock 标识；当前公开状态明确区分 `local_demo`、`not_configured` 与 `documented_not_connected`。仅证明当前公开 surface 据实标识，不推及所有未来输出。 | 随新增公开功能继续据实显示模拟、未配置或真实运行状态；真实平台能力需账号实测后单独记录。 |
| C-08 | 优先保证完整的端到端流程，再扩展更多业务 Agent。 | [x] | `workbench/tests/test_orchestrator.py:94`端到端主流程的两角色依赖；`workbench/tests/test_phase7_workflow_http_e2e.py:182`当前业务流程；`workbench/tests/test_roles.py:808`额外市场/客户角色仍为占位。 | — |
| C-09 | 采用适合现有仓库的技术栈，不要为追求复杂架构而无故重写项目。 | [x] | `docs/architecture.md:3`及`docs/superpowers/plans/2026-10-18-multi-agent-workbench.md:1`采用现有Django/PostgreSQL工作台；`requirements-workbench.txt:1`依赖；没有项目重写。 | — |
| C-10 | 所有阶段都应保留可运行版本和清晰的验收标准。 | [x] | 可运行源码 checkpoint、相对路径/SHA manifest 保存在 `workspace/testing/phase7-local-rollout/phase7b-luna-live-rollout/source_snapshot/`；该源码曾由隔离服务运行并通过请求验证，但当前 8011 演示 Django 已停止，不能据历史证据称当前服务在线。阶段验收标准见本矩阵。该证据不声称每个历史阶段均有独立版本，也不要求追溯未知旧内存代码的精确回滚。 | 后续未完成阶段继续保存可运行 checkpoint 并维护清晰验收标准。 |

本矩阵中的本机证据路径已规范为占位符；原始外部证据不随源码克隆提供。

## 架构组成

本矩阵中的本机证据路径已规范为占位符；原始外部证据不随源码克隆提供。

| ID | 原始组成 | 状态 | 证据及边界 | 仍需满足的条件 |
|---|---|---:|---|---|
| A-01 | 一个中心调度 Agent。 | [x] | workbench/agents/center.py:14; workbench/tests/test_roles.py:159；本地规则/模拟实现，见 P2/P5 边界。 | — |
| A-02 | 多个具有独立职责的业务 Agent。 | [x] | workbench/agents/product_agent.py:13; workbench/agents/delivery_agent.py:13; workbench/tests/test_runtime.py:290；本地规则/模拟实现，见 P2/P5 边界。 | — |
| A-03 | 一个共享业务数据层。 | [x] | workbench/models.py:108; workbench/models.py:216; workbench/tests/test_domain_models.py:76；本地规则/模拟实现，见 P2/P5 边界。 | — |
| A-04 | 一组可测试、可复用的确定性工具。 | [x] | workbench/agents/tool_contracts.py:1; workbench/tests/test_roles.py:620；本地规则/模拟实现，见 P2/P5 边界。 | — |
| A-05 | 一个支持任务追踪、人工确认、暂停恢复和交付审核的网页工作台。 | [x] | workbench/workflows/orchestrator.py:765; workbench/templates/workbench/workflow_detail.html:1; workbench/tests/test_phase7_workflow_http_e2e.py:182；本地规则/模拟实现，见 P2/P5 边界。 | — |

本矩阵中的本机证据路径已规范为占位符；原始外部证据不随源码克隆提供。

## 用户边界

本矩阵中的本机证据路径已规范为占位符；原始外部证据不随源码克隆提供。

| ID | 原始边界 | 状态 | 证据及边界 | 后续条件 |
|---|---|---:|---|---|
| B-01 | 各 Agent 保持通用职责与框架，不填入尚待询问企业后确定的规则。 | [x] | docs/01-业务基线.md:1; docs/02-客户访谈问题表.md:1; README.md:1 | 按访谈结果逐项纳入规则。 |
| B-02 | 做事前先查找已有实现；参考来源和已复用实现有文档记录。 | [x] | docs/research/2026-10-19-open-source-workbench-reference.md:1; docs/research/2026-10-19-retry-recovery-reference.md:1; workbench/tests/test_phase7_workflow_http_e2e.py:182 | 今后扩展继续先记录来源和复用边界。 |

本矩阵中的本机证据路径已规范为占位符；原始外部证据不随源码克隆提供。

## 非原始 Goal 条目的独立缺口

本矩阵中的本机证据路径已规范为占位符；原始外部证据不随源码克隆提供。

| ID | 状态 | 缺口 | 直接证据与边界 | 最小条件 |
|---|---:|---|---|---|
| GAP-L01 | [x] | Task 21 的离线 AgentArts Runtime request-envelope adapter、认证头/状态映射、`not_configured` health evidence 已实现。 | `workbench/agents/agentarts.py`、`workbench/tests/test_agentarts_adapter.py`；最终同模块定向日志为项目外 `workspace/testing/phase6-offline-adapter/targeted-test-post-review.log`；随后当前源码 `workbench` 313/313 见 `workspace/testing/phase4-legacy-run-receipts/closeout/full-workbench-suite.log`。本机 8000 已受控重启并由 GET 验证新增 health evidence 字段；该 adapter 无 transport，未做账号/API调用或部署。 | AgentArts 登录后另行验收真实平台调用、部署和权限。 |

本矩阵中的本机证据路径已规范为占位符；原始外部证据不随源码克隆提供。

此项是审计发现的本地实现缺口，现已完成；它不是原始 goal 新增任务，也不替换 Phase 6 各项账号实测状态。
## 当前证据划分

本矩阵中的本机证据路径已规范为占位符；原始外部证据不随源码克隆提供。

- **当前源码自动化日志：** Task 21 历史定向7/7、当时 `workbench` 全量302/302日志保留在项目外 `<LOCAL_EVIDENCE_ROOT>\phase6-offline-adapter\`，对应当时的代码与日期边界，不改写为最终源码测试。Task 20/21 合入后的最终源码 `workbench` 全量303/303（35.504秒）见项目外 `<LOCAL_EVIDENCE_ROOT>\phase5-english-hints\final-full-workbench-test.log`；本轮正式实例加载验证未重跑测试。Phase 7 旧 HTTP 整链定向1/1和295/295仍为此前基线。
- **HTTP链：** `test_phase7_workflow_http_e2e.py` 通过真实 loopback HTTP、页面 form/DTO 驱动上传、typed review/apply/resume、五类文件预览下载与显式审批/完成；测试中的 ORM 仅断言持久化和副作用。运行时仍为 `local_mock/simulated_rules`。这不证明浏览器点击或平台真实调用。
- **浏览器/CUA：** 业务 UI 两条真实浏览器流程的交互、reload、生成/审批和下载已由主控分别验收；冲突流程有 `workspace/testing/desktop-package-contract/business-demo-20261019-234414-f4fb04c3/logs/conflict-ui-downloads/ui-summary.md` 与 `verification.json`。这不是 DSH 安装版原生 GUI 验收。p8 安装版首启 Web RPC 失败；p7 桌面截图仅作历史布局证据。
- **AgentArts：** 已有依据公开文档的离线封套构造与响应映射，见 `workbench/agents/agentarts.py` 和 `docs/research/2026-10-19-phase6-offline-adapter.md`；本机正式 `--noreload` 服务已按当前源码受控重启，`GET /api/health` 保留 `execution_mode=local_demo`、`agentarts=not_configured`，并返回 `agentarts_status.evidence=documented_not_connected`。仍没有账号、真实 API 调用或部署实测。
- **业务规则：** 同款不同规格、图片编号冲突、来源冲突等仍需企业访谈；已有通用缺字段、缺图、重复 SKU 路径不表示所有冲突已实现。普通 CSV 能创建 revision；`missing_current_revision` 是异常边界，不作为扩展修复入口。
- **证据保护：** p8 安装器与资源对比证据在项目外 `workspace/runtime/tradeloom-harness/evidence/install-p8-20261020-1/`；当前测试日志为项目外 `workspace/testing/desktop-package-contract/framework-suite-candidate7-20261020-01.log`。隔离业务日志/快照不在 Git 仓库。没有读取个人 provider 凭据或个人 DSH 私密状态。

本矩阵中的本机证据路径已规范为占位符；原始外部证据不随源码克隆提供。

## 当前范围与最小剩余行动

本矩阵中的本机证据路径已规范为占位符；原始外部证据不随源码克隆提供。

| 范围 | 状态 | 证据与边界 / 下一步 |
|---|---|---|
| 安装版打开并可操作 | [!] p8 已安装且 14,150 个资源逐文件核对一致；其首启曾报 `Web RPC failed`。本地 source-mode Electron 随后实际完成本地框架与业务 GUI 验收，但没有把本轮源码改动 stage/package/install 到 p8。 | 用户要求本地优先；先处理本地剩余 UI 缺陷。之后若用户安排发布，再单独验更新安装版启动，不能由本地运行外推。 |
| 顶部五业务入口、助手选择与原生历史 | [x] 五业务路由已逐项打开；助手入口已移到顶部折叠菜单，左侧原生 workspaces/history 保留。既有六个 preset/workspace 独立会话映射与重启保留证据仍有效。 | p8 安装版尚未包含当前 source-mode 更新；本条不把助手选择器表述为左侧常驻六角色栏。 |
| 场景与 Dockview 面板操作 | [x] 此前同步的 source-pointer bundle 已实机验证调整分栏、把面板标签合并为同组、再拆为分栏；会话草稿保留。截图证据见 `<LOCAL_EVIDENCE_ROOT>/source-pointer-native-20261021/merged-tabs.png`、`split-tabs.png` 与 `restored-layout.png`。七场景逐页留白与主题检查绑定前一同步 bundle `a2e86a34bcdba5216c372172054885a64b14c0aea66d2be40426347a03e9fdb5`；最终 spacing bundle `babaee741aa6be4a7d3b3e35453c4b771d44d7aa110b32c16a2e944848ec8491` 仅复验工作总览、ERP 新文案/DEMO Item 和窄屏菜单/主题/单面板。分阶段 GUI 证据见项目外 `workspace/testing/ui-spacing-20261021/ui-verification-final.json`（SHA-256 `6dfff530f317224cbcdcc6d36b2f555f76e2e60a2cfe2cbe819c091b19f5b4e0`）。本轮 Dockview 标签拖动只选中参考标签，未证明移动/停靠；旧 bundle 拖放结果仅适用于其记录时的版本。 |
| 角色会话绑定与复用 | [x] 六个助手通过顶部选择器切换现有 preset/role session；原生聊天作为工作区面板显示，中心草稿跨切场景保留，重新载入只重挂载视图而不新建会话。 | 真实模型只读工具和提案证据按上方范围限定；不声称所有 provider 或完整自动 workflow 已验。 |
| 受保护场景与资料接口 | [x] 源码和本轮运行时合同测试覆盖 `/tradeloom/scenes` 认证读取及用户资料路由的拒绝/编辑边界：`host.js`、`tests/scenes.test.js:326`、`tests/shell.test.js:270-300`。 | GUI 首启后可再核对产品页面访问；自动接口通过不替代 UI 验收。 |
| 原生用户资料工具调用 | [x] 本地 source-mode 原生 GUI 的 user-profile preset 实际调用 `tradeloom_user_profile_read {}`；真实工具结果进入下一次模型请求，随后显示固定模拟回复。同轮本机 SSE fixture 验证对象 schema、tool-call、同 ID `role=tool` 回传，3 POST 均 HTTP 200。证据：[资料工具验收记录](../../workspace/runtime/tradeloom-harness/evidence/local-tool-call-gui-20261020/acceptance.json)；截图见 work-report 记录。 | 证明 user-profile 工具和本机 mock 往返，不代表真实供应商推理。 |
| 原生中心双业务子代理工具闭环 | [x] 本机 SSE mock 的双角色 spawn/tool/异步通知历史证据仍见[记录](../../workspace/runtime/tradeloom-harness/evidence/local-business-subagents-gui-20261020/acceptance.json)。另在真实 DeepSeek Flash 原生会话中，product 与 delivery 两种 child 分别执行只读工具，修复后 delivery child 读取当前 generation 对应的审核摘要并与 GUI 一致；详见[真实 provider 验收](../../workspace/runtime/tradeloom-harness/evidence/real-provider-gui-20261021/acceptance.json)，SHA-256 `4E9A682915A08A27D61BBE778398AF9AABFFF27951388EC7DBB55488E4CB46C5`。 | 真实 provider 的两类只读工具调用与审核语义已验；本行不表示模型自动执行整个业务工作流，后续业务执行仍是 `local_mock/simulated_rules`。演示审核标签“自动验收（演示）”不是真人审批。 |
| API-only 多供应商入口与本地凭据 | [-] 两个自定义 API provider 配置保存及重启持久化、A/B 本地 mock 路由历史验收仍有效；本轮又用现有 DeepSeek Flash provider 完成真实 API 原生会话及业务工具调用。 | 真实连通只覆盖当前 DeepSeek Flash 与本次请求；其他厂商/协议仍未实测。配置凭据不纳入证据；不读取个人 DSH 凭据。 |
| 独立数据根与启动隔离 | [x] 本地 source-mode 本次运行使用独立 DataRoot `workspace/runtime/tradeloom-harness/local-dev/workbench-20261020-02`；`core.mjs`、`installed-bootstrap.mjs` 契约仍有隔离测试。此证据不替代 p8 安装版目录验收。 | 安装版复验数据落在 TradeLoom 专属根，且不触碰个人 DSH。 |
| 手机响应式与 LAN | [-] 本地界面生成授权链接，并在同 profile 浏览器完成 303 后打开业务 iframe/场景页；虚拟视口 390×844 与 320×720 已验，CSV 文档不再横向溢出、表格仅自身横滚；原生窗口复验也确认 CSV 使用项目主题、保留 5 项 approved v1 与版本来源。截图：[原生 CSV 复验](<LOCAL_EVIDENCE_ROOT>\visualizations\2026\10\18\01a14efa-72b3-7a63-8b40-a274f33629cf\tradeloom-native-csv-preview-fixed-20261021.jpg)。 | 虚拟视口不替代实体手机；仍需按应用显示的授权入口用同 Wi-Fi 手机连接，`127.0.0.1` 不能作为手机地址。 |
| 中心提案 / 专家委派 | [-] 本地 GUI 已验证可信链接进入 Agent Center、预填、解析预览、候选查看及显式确认；真实 DeepSeek Flash 会话另已完成自然语言提案/澄清和提案预览的人审门禁，并调用 product/delivery 两类 child 做只读读取。 | 证据见 [真实 provider 验收](../../workspace/runtime/tradeloom-harness/evidence/real-provider-gui-20261021/acceptance.json)。真实模型工具调用范围已验证；完整 workflow 后续执行仍由 `local_mock/simulated_rules` 处理，未证明模型自主完成业务或真人审批。保持人工确认门禁。 |
| 场景动态模块注册 | [x] Cordis context 不再通过对象展开传递；场景模块接收原始 context 和可信 origin 回调，避免丢失注入服务。定向测试 scenes 12/12、business-tools 11/11、handoff renderer 3/3；shell 18 pass、3 skip。证据与日志见 `../../workspace/testing/desktop-package-contract/cordis-scene-context-fix-20261021/`。 |
| 业务工作流与代理 | [-] 本地 source-mode GUI 已完成两条独立演示 workflow：既有 `e40d...` 产品任务暂停/演示 review/apply/resume、交付审核并完成；本轮 `a0618507cd91405ba0b986e50156ed75` 复用已确认的产品 source v2/v3（本轮新增资料 review 为 0），运行两个依赖任务，生成 5 个 v1 文件，QA `passed` 覆盖 2 个产品，演示 reviewer 显式批准后完成；reload/helper restart 后仍完成且 5 项 approved。两条均标 `local_mock/simulated_rules`，不是模型自动决策或真人审批。HTML 原生 Save As 文件 3,335 字节，SHA-256 `3f00b707cefbd03552e04508c93b8ee5cf8cae39204a1fd0328892234ce6e287`。 | 真实模型决策、真人审批及所有业务规则仍未验。 |
| 自动化范围与本轮结果 | [x] Django workbench 最终完整回归 327/327、52.042 秒、exit 0，隔离测试库和历史诊断见上方旧记录。此次 CSV CSP/布局修复后另跑 `workbench.tests.test_business_embed` 9/9、exit 0；RED 1/1 exit 1，日志分别见 `../../workspace/testing/desktop-package-contract/csv-preview-csp-20261021-01/red-focused.log` 与 `../../workspace/testing/desktop-package-contract/csv-preview-csp-20261021-01/green-business-embed.log`。新虚拟视口与工作流验收见 [本轮记录](../../workspace/runtime/tradeloom-harness/evidence/local-proposal-mobile-e2e-20261021/acceptance.json)。本次未重跑 Django 327 或 Node 全套。 | 9 项是定向 CSV/embed 回归，不等于完整套件重跑；P8 安装版未包含本轮源码。 |

本矩阵中的本机证据路径已规范为占位符；原始外部证据不随源码克隆提供。

## Task 23 范围

本矩阵中的本机证据路径已规范为占位符；原始外部证据不随源码克隆提供。

本矩阵保留原始 Phase 0–7 逐项追踪；原始 P7-AC 的 `[x]` 表示本地自动化、可复现说明及标注模拟的业务演示证据。source-mode 本地 Electron 已实际点击验收新增场景、演示工作流及其重启状态；近期另以真实 DeepSeek Flash 验收了提案/澄清、两类业务 child 只读工具调用和交付审核摘要读取，证据见当前范围及 C-01 行。后续业务执行仍是 `local_mock/simulated_rules`，这些测试不证明模型自主完成整条工作流、企业真实数据或真人审批；本轮源码更新未进入 p8。实体手机和企业规则访谈仍未完成。当前没有记忆分层实现证据；原生聊天已作为 Dockview 工作区面板接入。鼠标拖动标签停靠仍需实机交互验收。实际计划文件为 `docs/superpowers/plans/2026-10-18-multi-agent-workbench.md`（标题“织贸助手（TradeWeave）多 Agent 工作台实施计划”，SHA-256 `717CCA56512A6F8EB49F4EE011B94E53C9BF2472D4DFFD42C3B0797342390B34`）；未勾选项不另造任务或推导为完成。

本矩阵中的本机证据路径已规范为占位符；原始外部证据不随源码克隆提供。

## 本批文档证据快照

本矩阵中的本机证据路径已规范为占位符；原始外部证据不随源码克隆提供。

本批 before 原始字节、before SHA-256、after 同步快照、canonical manifest 与检查输出均存于项目外 `<LOCAL_EVIDENCE_ROOT>\phase7-acceptance-matrix\`。目录路径不会提交到 Git。

## 后续后台证据增量（2026-10-21）

（同步前基线；GUI 状态已由下方“最终 GUI 复验”更新。）

以下证据补充当前范围，不重算原阶段状态，也不表示整体目标完成：

- candidate7 pinned React、ReactDOM server 与 Cordis 环境运行 `node --test tests/scenes.test.js`，23/23 pass、0 skip、exit 0；包含 collapsed-sidebar 对顶栏 `visibility:visible` 及 furled-only 66px 首行 inset 的样式契约。主控修前实测 621×627 时 FAB 遮挡助手入口；当前 CSS 已增加预留，但修复后的窗口效果仍待复验。
- 隔离 PostgreSQL 草稿 API 模块 32/32、exit 0；Django 完整套件的 389/389、exit 0 是此前独立全套结果，不能合并表述为新的全套。新增 HTTP 403 回归单测另有 1/1 exit 0 记录，详情见外部 `<LOCAL_EVIDENCE_ROOT>/erpnext-live-20261021/http403-test-run.md`。
- 项目外安全 checkpoint 记录七个只读 DocType 列表各 HTTP 200。唯一实际 Quotation create 请求返回 HTTP 202，操作仍为 `outcome_unknown`/`forbidden`，没有远端 name；本轮未重发或更新，未做 CAS。HTTP 403 不能作为“肯定未写入”的证据。独立远端只读证据 `<LOCAL_EVIDENCE_ROOT>/erpnext-engine-20261021/deployment/quotation-readonly-hook-evidence-20261021.json`（SHA-256 `AA1A2FDE7C3377E5EC5C14FB33E73D3FB1A6239000841C4DC9E4A6C177BE16EA`，UTC `2026-10-21T13:41:51.639290+00:00`）显示只读检查前后11类交易计数均为0；它不确定403原因，也不改变该 operation 的未知状态。
- 助手选择器已有 GUI 验收，且此前主控查看了七个业务场景、日夜主题和 MCP/Skill 能力列表；这不是本次窄屏可见性变更的窗口验收。插件资产的 GUI 查看与 22 个共享 Skill/52 个文件的资产哈希核对是两类不同证据，不能推断 52 个文件都逐一经 GUI 检查。
- 主控在修复前的 621×627 收起侧栏窗口实测 `.tl-shell-top` 可见、导航响应正常，但 meow-smooth FAB 覆盖助手首行入口，命中测试确认目标落在 FAB 上。当前源已加入 furled-only 左侧预留并通过 Node 样式合同；修复后的窗口效果尚未复验。真实 Quotation 成功创建与部署 CAS 更新也仍未验收。正式提交/取消/删除/库存仍未开放；图像/网页桥是预留能力，不作为本轮失败或新增必做项。

本矩阵中的本机证据路径已规范为占位符；原始外部证据不随源码克隆提供。



本矩阵中的本机证据路径已规范为占位符；原始外部证据不随源码克隆提供。



本矩阵中的本机证据路径已规范为占位符；原始外部证据不随源码克隆提供。



## 最终 GUI 复验（2026-10-21）

本节更新上述窄屏遮挡、间距待复验状态；修前观察保留为历史记录，不表示整体目标已完成。

- 七场景逐页检查卡片留白、日夜主题、侧栏及 MCP/Skill 面板滚动是在前一同步版本 `a2e86a34bcdba5216c372172054885a64b14c0aea66d2be40426347a03e9fdb5` 完成。最终 bundle `babaee741aa6be4a7d3b3e35453c4b771d44d7aa110b32c16a2e944848ec8491` 仅重开桌面检查工作总览、ERP 新中性文案/已连接 DEMO Item 列表，以及 621×627 窄屏菜单、主题与单面板切换。证据 `workspace/testing/ui-spacing-20261021/ui-verification-final.json` SHA-256 `6dfff530f317224cbcdcc6d36b2f555f76e2e60a2cfe2cbe819c091b19f5b4e0`，包含五个外部截图 hash；截图不随源码发布。
- 621×627 窄屏实测顶栏可见，助手选择器可展开且 hit-test 正确，FAB 不再遮挡入口；单面板切换可用且无横向溢出。实测 system/light 与 dark 外观切换。未测试实体手机。
- 本轮 Dockview 原生标签拖动只选中参考标签，移动/停靠结果未证明（inconclusive）。此前旧 bundle 的拖放记录不外推到最终 bundle。
- ERP 只读集成在实机界面成功显示连接状态和 DEMO Item。此前 Quotation 创建返回 HTTP 202 后仍为 `outcome_unknown/forbidden` 且没有远端名；没有重发、update 或 CAS。11 类交易只读计数为0的独立快照不证明未知请求没有副作用。未发新 LLM/付费请求；整体目标未完成。

## 后续 source-mode UI 复验（2026-10-23）

本节只更新受本次实机证据覆盖的窗口行为，不将局部验收外推为整体目标完成。

- owned desktop-8 使用最终纯 UI bundle `7fd1e912cd3781152faa843c85291743d139ebd44603c5550a88fd98f97353dc`。窗口实测 1282×823 与最大化 1707×1019；中心场景的左侧业务组与右侧助手区布局正常。资料场景在窄 pane 中通过“选择当前面板”切换资料与交付物，业务内容恢复到可用宽度，上传与预览可见。
- 主题修复在 DSH Host 接受 `ui-theme.preference=dark` 后返回 revision 1。关闭并重新启动后默认深色保持；正式主题按钮从深色切回 system/light 后稳定未回退。深色外壳切换到资料与交付物场景后，业务 iframe 同步深色。该证据支持这条主题设置与场景联动，不代表所有页面颜色已逐项验收。
- Provider 下拉菜单在 1282px 和最大化窗口均能显示且不被 rail 裁切。键盘从主题控件 Tab 到 tools 控件时可见蓝色 focus ring，按 Return 可打开菜单，弹层留在右侧可视范围。Root 已确认 provider 长名称从左起显示并以 ellipsis 收尾，不再裁掉首字母。
- Root 补充最大化窗口实测：DeepSeek 下拉可见但未选择或调用模型；Escape 可关闭 tools 菜单；主题按钮 system/light→dark、业务 panel 展开→还原均通过，重启后深色偏好仍保留。分隔条从 x=739 拖到 x=922；随后先进入 1282px 窄态再最大化至 1707px，分隔条恢复在 922px，Root 确认 resize 持久化与窄态不覆盖。
- 标签拖放仍未通过验收：最大化窗口第三次尝试将“资料”标签拖到右侧内容区域后仍只激活标签、未移动；该窗口没有“选择当前面板”控件，故这次观察不是窄 pane 选择器路径。是否由自动化拖动事件、Dockview 拖放阶段或目标区域处理导致，当前证据不足，标为未判定；不能用分隔条拖动成功替代标签拖放证据。
- 最终 shell Node suite：212 pass、15 skip、0 fail、exit 0；使用已存在的 desktop-8 jsdom runtime，不安装依赖。15 项 skip 的测试声明涵盖未配置的可选 pinned React/ReactDOM 与 JSDOM、candidate7 React 渲染、编译 DSH runtime/tools、DSH WebServer、Cordis/Loader、app-boot/include library paths；另有按操作系统 symlink 能力条件跳过的测试。此处记录声明类别，不推算各类别实际占用数量。
- 标签拖放原因仍未定位；临时事件诊断待审查/实机采集。实体手机尚未验收；整体项目目标仍未完成。

### 2026-10-23 侧栏保留 bundle `9fbed7ccad3fa134a2cd85ca52282770205e65b7650793599fbd2fe1e1465dd2`

- Root 通过 Sky 在 1282×823 与 1707×1019 两种窗口宽度实机检查；无 startup error。原生 caption 侧栏可以关闭并重新打开，原生历史、新会话、插件/自动化、上下文 GitHub 与设置入口仍可用；从“对话”入口进入真实 native chat 后返回工作场景，侧栏状态不变。工作台与独立对话保持一致的原生侧栏行为。
- Root 确认主题与工具控件固定在顶栏右侧；全局布局 popover 未被裁切；手动应用推荐布局后，中心场景呈现左侧业务、右侧助手的推荐比例。用户先前 custom Dockview 布局已在项目外私有备份：`workspace/testing/ui-20261023/private/dock-layouts-pre-activation-20261023.json`。该现场没有全关闭所有面板、标签 DnD、实体手机验收。
- Root 发现展开中心助手后 Dockview 已最大化，但后续读取按钮仍标“展开中心助手”。检查项目内实际发布的 Dockview bundle 证实 `DockviewApi` 没有 `isMaximizedGroup` 公共方法；`IDockviewPanelApi` 的 `isMaximized()` 是无参数 API，并对应 `maximize()`/`exitMaximized()`。当前 source 已改用 panel API，并有不提供虚构 `isMaximizedGroup` 的行为回归；此修复尚未同步或实机验收。
- Provider A 与 B 曾都显示“本”。当前 source 改用 provider 可见名称里的首个 ASCII 字母/数字（例如 A、B、D），无 ASCII 时回退首个 Unicode 字符，并新增入口标签回归；尚未同步/实机验收。
- 本 bundle 的窗口标题显示“DSH 本地构建”，同时 UI 品牌为织贸助手。只读定位到 `ui-layout/src/client/AppFrame.tsx` 的 `DSH_CLIENT_TITLE` 编译值及 `tsdown.client.ts` 的 build define；本轮单包窄构建未设置该变量，故回退到 locale 标题。当时尚未完成带标题变量的窄构建；后续候选产物和 SHA-256 见下方“窄构建与嵌入空会话契约核对”，并未同步或实机验收。

## 2026-10-23 用户新增视频 UI 参考归档与当前实机状态

- 用户提供的 ZIP 与 Markdown 已原样归档到项目外 `workspace/research/video-ui-reference-20261023/originals/`；完整 SHA-256、长度、ZIP 条目与提取文件清单见同目录 `manifest.json`。ZIP 中共 340 项、50,576,102 解压字节，读取/提取失败 0；包含 135 张 `01_实机截图` PNG、31 张 `02_UI示意_非实机`、135 张 JPG 缩略图和 7 项 HTML/Markdown/JSON 索引材料。归档没有视频或 PDF。参考文件和索引不进入 Git。
- 随附 Markdown 是二次分析，不作为已人工完整核验七段视频的证明，也不构成新功能/架构授权。报告主张可借鉴场景化工作区、可调整面板、文件与结果联动、可见执行状态；报告明确将实机截图与 UI 示意分开，并说明尺寸/颜色属于建议而非源码提取。保留“不要把每个 Agent 聊天铺满、不要把发光连线/工具可见误当成真实状态或授权”等限制。
- Root 对 bundle `9fbed7ccad3fa134a2cd85ca52282770205e65b7650793599fbd2fe1e1465dd2` 的已有实机结果仍有效：1282×823/1707×1019；原生侧栏可关闭和恢复，历史、新会话、插件/自动化、上下文 GitHub、设置及 native chat 入口可用；工作台/独立对话切换不篡改侧栏；主题/工具靠右；推荐布局可手动应用。custom Dockview 布局先前已私有备份。
- 同一旧 bundle 上“展开中心助手”确实完成最大化，但随后按钮标签没有更新，二次点击还原路径因此不正确；这是旧 bundle 的已观察失败，不被 source 测试覆盖。当前未同步 source 已改用官方 `panel.api.isMaximized()/maximize()/exitMaximized()`，并覆盖展开→还原→再次展开；shell suite 最新结果为 213 pass、15 skip、0 fail、exit 0。该修复尚未同步或实机复验。Provider 徽标 source 也已改为可区分的真实名称首字符，尚未实机复验。
- 截图归档路径示例：`workspace/research/video-ui-reference-20261023/extracted/DSH_Workbench_UI_Reference/01_实机截图/V01/S001_V01_01m50s250_顶栏与场景页签.png`、`.../V02/S029_V02_00m33s750_文档_目录_双会话四分区.png`、`.../V04/S062_V04_00m25s750_画布放大占用主要区域.png`、`.../V05/S095_V05_01m26s750_工作区与多个助手列表.png`、`.../V07/S133_V07_02m05s750_内嵌页面加载与助手空态.png`。恢复的 14 张本地参考帧仍在项目外 `workspace/research/ui-reference-20261022/images/`。
- 统一参考资料库入口：[README](../../workspace/research/video-ui-reference-20261023/README.md)与[合并索引](../../workspace/research/video-ui-reference-20261023/reference-index.md)。本轮将旧 14 帧、旧 manifest 和三份分析说明逐文件复制/哈希验证进同一资料库；旧目录仍保留可用。新 135 张目录截图是主参考，旧 14 帧为补充，随附报告仍只是二次分析。用户明确要求保留原生侧栏/功能，优先于报告建议。
## 2026-10-23 窄构建与嵌入空会话契约核对

- **当前实机基线：** owned desktop launcher manifest `workspace/runtime/tradeloom-harness/local-dev/workbench-20261020-02/harness-home/tradeloom-launcher-desktop.json` 仍指向 runtime `0.2.1-rc.2-tradeloom-desktop-8`、profile `desktop`、TradeLoom bundle `9fbed7ccad3fa134a2cd85ca52282770205e65b7650793599fbd2fe1e1465dd2`。Root 对该 bundle 已实测原生侧栏可关闭/恢复，工作台/对话切换保留状态，native chat 和原有历史等入口仍可用；用户要求保留原版功能，未作侧栏 suppression。
- **最大化按钮根因与源码状态：** 旧 bundle 的可观察回归是“展开”使组最大化，但按钮状态保持“展开”，还原路径不正确。Dockview 实际 public `IDockviewPanelApi` 通过无参 `panel.api.isMaximized()` 读取该组状态，并提供 `maximize()`/`exitMaximized()`；不能依赖不存在的 `DockviewApi.isMaximizedGroup(panel)`。TradeLoom source 已按真实 panel API 处理，并用真实形态 fixture 覆盖 expand→restore→expand。该 source 仍未同步/实机验收。
- **品牌窗口标题构建：** 当前 runtime `ui-layout/src/client/AppFrame.tsx` 将 `process.env.DSH_CLIENT_TITLE` 编译进 `AppFrame`，缺省才使用 locale 的“DSH 本地构建”。本次仅在 owned runtime8 的 `@deepseek-ai/dsh-client-ui-layout` 窄构建子进程设置 `DSH_CLIENT_TITLE=织贸助手`，执行 `pnpm --filter @deepseek-ai/dsh-client-ui-layout bundle`；没有修改 Host 源码、全局/用户环境或 branding patch。候选 `packages/client/ui-layout/lib/client.js` SHA-256 `567B3E3119FD4D132485AA27D92570B956C3F40481B0D3C3D467F53DD3301697`，构建内容含预期标题；该产物尚未 sync/restart 或窗口验收。app-boot 永久 root Include 修复构建前后 SHA-256 均为 `05FCB004972D3CC9CFE9BE3C4F22E0B166641D0CF0CB60E090BC0BB66182C964`。
- **商品场景空会话 composer：** 查明原 source CSS 选择器要求 `[data-composer-seat]:only-child`，但官方 `SlotOutlet` 始终输出 `data-slot="conversation.session"` 且 `display:contents` 的稳定锚点；session id 存在时它与 composer seat 是不同 DOM 子节点。空白 `DefaultConversationViews` 虽返回 null，外层锚点仍在，因此旧 `:only-child` 规则确实不会匹配。shell source 现只在嵌入 native-chat active 状态下针对“session slot 没有 `[data-slot="conversation.view"]`”的结构，让 composer seat 接收剩余间距；独立原生聊天样式不变。定向 DOM/CSS 行为回归以官方稳定锚点结构验证空会话匹配、存在 view 时不匹配。完整 shell suite 229 项：214 pass、15 skip、0 fail、exit 0。该测试不测像素，空会话实际位置仍待 Root 遮挡解除后的窗口复验。
- 本轮只生成 ui-layout 构建候选并改 shell source/测试与记录；未同步、重启或声称新 title/max/composer source 已激活。实体手机、标签 DnD 与空会话实际位置仍未验。

## 2026-10-23 完整截图观察与集成候选

- 统一参考库新增逐帧观察：[V01–V03（59 帧）](../../workspace/research/video-ui-reference-20261023/observations/2026-10-23-v01-v03.md)、[V04–V07（76 帧）](../../workspace/research/video-ui-reference-20261023/observations/2026-10-23-v04-v07.md)。共 135 张实际逐张检查的截图；S134 属 V02，V07 有 12 帧。截图多有裁切，材料不代表完整观看七段视频或由静帧证明交互因果。31 张示意图仍为建议层，135 张 JPG 为缩略图，旧 14 帧仍是补充；完整索引和哈希见外置参考库 README/manifest。
- 按本轮观察采纳：使用现有原生 DSH 侧栏/历史/新会话/插件/自动化/工作区能力，保持独立对话入口、顶层助手/场景导航和 Dockview 的可调面板层级。未采纳删除/常驻隐藏侧栏；也未从第三方截图授权新增 SSH、视频画布、股票或虚构后台/健康状态。未证明的动效、被裁切区域和标签拖放仍待真实窗口检查。
- **当前源候选：** shell suite 为 229 项：214 pass、15 skip、0 fail、exit 0；Node 语法检查通过。15 skip 为测试已声明的可选 runtime/React/JSDOM/Cordis/Loader/OS symlink 条件，测试总数中按实际 skip 计数为 15。运行时 `ui-layout/lib/client.js` 的窄构建候选 SHA-256 `567B3E3119FD4D132485AA27D92570B956C3F40481B0D3C3D467F53DD3301697`；永久 app-boot 修复 `05FCB004972D3CC9CFE9BE3C4F22E0B166641D0CF0CB60E090BC0BB66182C964` 未变。max/restore、provider 徽标和嵌入空态布局改动已在 source/test，待本轮 sync/start 后由 Root 对实际窗口复验。

## 2026-10-23 本地 source-mode 集成候选 `a1393039…c97977a`

- 已经由官方 `sync-dev-bundle --mode desktop` 将最终 source bundle 同步至 manifest 指定的 desktop-8 / DataRoot `workbench-20261020-02`，官方命令 exit 0，bundle hash `a1393039d07b19870f51188536c53f003f01d86402d4279975019abc0c97977a`。manifest 的 runtime、profile `desktop`、bundle hash 与目标一致；核心五个 source/package 文件哈希逐项与 profile 相同。Host `ui-layout/lib/client.js` 为窄构建哈希 `567B3E3119FD4D132485AA27D92570B956C3F40481B0D3C3D467F53DD3301697`，app-boot 永久修复仍为 `05FCB004972D3CC9CFE9BE3C4F22E0B166641D0CF0CB60E090BC0BB66182C964`。
- 指定本地快捷方式隐藏启动后，runner 记录 `cli-started`，CLI PID 36892；Electron 主窗口 PID 55356、HWND `0x8C1308`、标题“织贸助手”。这是启动/窗口存在证据，不代表本轮 UI 已通过；待 Root 按实际窗口名单无阻挡检查 max/restore、空会话 composer 和其它场景。启动前后没有重置或覆盖 Dockview 用户布局。
- shell Node suite 实际结果：229 项，214 pass、15 skip、0 fail，exit 0；15 项按测试声明的可选依赖/平台条件跳过。实际窗口仍待 Root 验收；跨组标签 DnD、实体手机及整体目标未完成。

## 来源到执行计划的现有闭环核查（2026-10-23，只读）

本节依据当前源码、测试定义和已有文档核对，没有运行界面或测试，没有访问业务数据库、ERP、真实文件、模型 API，也没有修改业务代码/数据。以下区分源码能力、自动化测试覆盖和真实资料验证；“测试定义存在”不等于本次执行或真实业务资料通过。

| 阶段 | 源码具备 | 自动化测试覆盖 | 真实资料实测 / 缺口 |
|---|---|---|---|
| 1. 原件留存与来源定位 | `.xlsx` 上传受大小/类型限制、以 SHA 建立追加来源版本；源文件私有保存，Workbook snapshot 保存 sheet/cell、公式/cache 状态、坐标和图片引用。见 `workbench/intake/api.py:573-640`、`workbench/intake/storage.py:113`、`workbench/intake/snapshots.py:17`、`workbench/models.py:109-163`。 | 合成 workbook 的上传→预览→mapping→candidate、幂等/冲突、源哈希与单元格 provenance 在 `workbench/tests/test_intake_api.py:215-281`；原始公式/cache 在 `workbench/tests/test_intake_parser.py:180` 起有 fixture 覆盖。 | 本次没有处理用户的四份历史 Excel。已有模型保留 SHA、sheet/coordinate 等来源身份，但不能据此把四份历史 Excel 自动认作同一产品或版本；实际内容、公式口径、同品规则仍需逐份人工确认。 |
| 2. 字段映射与候选关联 | mapping 绑定 snapshot/source SHA、revision 与闭合字段 schema；候选字段带 source locator/provenance。候选之间只追加 `suggested/confirmed/rejected` link 记录，不合并或改写候选。见 `workbench/intake/mapping.py:64-108`、`workbench/intake/api.py:807-875,893-945`、`workbench/models.py:222-277`。 | 映射/候选幂等与 source-bound 在 `test_intake_api.py:215-281`；候选 link 决策历史、重放及保持候选/产品/产品版本计数不变在 `workbench/tests/test_intake_links.py:318-362`。这些都是合成记录测试。 | 当前源码未发现从 `IntakeCandidate` 将记录提升为 `Product` 或 `ProductRevision` 的 API/服务；link 的 `confirmed` 只代表候选间人工关系决策，不是产品主档确认。不能将候选链接等同产品去重/入库。 |
| 3. 生产要求草稿与版本确认 | 草稿引用单一 candidate；不可解析、多个值或无单一 locator 的字段保持 unresolved。source evidence 校验 locator 属于该字段 provenance；revision 追加保存值和证据。确认需要显式版本与包装单位对，单位/数量的 source arithmetic 仅做现有包装检查。见 `workbench/requirements/service.py:36-128`、`workbench/requirements/api.py:206-257,282-388,390-441`、`workbench/requirements/calculations.py:16-49`、`workbench/models.py:282-320,404-478`。原件和注释按追加版本保留；录音日期允许 `null`，核听字段叫 `operator_claimed_checked`。见 `workbench/models.py:366-400`、`workbench/intake/narrative_annotations.py:18-58`。 | source value 与字段/坐标错配、多个数值不自动选取/聚合、历史参考保持 arithmetic 未确认、operator evidence 确认不创建 Product/ERP 均有测试：`workbench/tests/test_production_requirement.py:101-143,233-267,322-341,494-533`。二次资料/日期空值/声明状态历史测试在 `workbench/tests/test_intake_narrative_annotations.py:51-78,81-130`。 | 本次未用真实访谈摘录或原始录音。二次摘录只提供行范围和来源类型，不是录音转写校验；`operator_claimed_checked` 是人工声明，不是系统核听。未知录音日期应继续为 `null`。用户已明确：工时为人工估算，金额相对准确仍需公式、币种和确认；实际工人日报方式待确认。现有 `labor_analysis` schema 暴露估算字段，但 `labor_basis` 明标 `unconfirmed`（`workbench/intake/schemas.py:30-33`、`workbench/intake/mapping.py:100-108`）；当前 requirement calculation 只实现包装数量算术，不应声称已有工时/金额计算。 |
| 4. 执行计划草稿 | 仅接受该 draft 下的**已确认 requirement revision**；计划持有精确 revision ID，并校验 `requirement_refs` 的 evidence 属于该 revision/field。计划状态固定为 `draft`，详情把要求版本、来源候选及证据一起读回，实际执行状态为 `missing`。见 `workbench/execution_plans/api.py:88-143`、`workbench/execution_plans/service.py:9-28,35-82`、`workbench/models.py:325-346`。 | `test_execution_plan.py:170-209` 覆盖确认版本计划创建和历史版本不重绑；`211-245` 用合成 workbook 经公开 API 完成 import→candidate→requirement evidence/确认→plan/readback；`246` 起拒绝未确认 revision 和无效 evidence。该 E2E 是 synthetic fixture，不是四份真实 Excel。 | “需求版本确认→执行计划草稿关联”在当前合成公开 API 流程中已闭合。没有证据表明计划会自动转成 Product/ProductRevision、采购/生产订单或 ERP 写入；不把草稿生成称为实际执行。 |

### 当前可执行缺口与边界

1. 本节最初的静态审计未读取四份历史 workbook；后续已在明确授权下使用真实原件、项目外隔离目录完成只读解析与来源定位核对，不提升主档、不写主库。详细证据见下方 2026-10-23 Excel 只读审计段；不自动硬链接产品。
2. Candidate → Product/ProductRevision 提升尚无已核实接口；需先定人工确认、产品身份及版本创建规则，再另立实现/测试范围。源码中 `candidate-link` 的 confirmed 仅记录候选间关联决策（`workbench/urls.py:29-46,93-100`；`workbench/intake/api.py:850-875`），不是产品入库；生产要求确认只追加 requirement revision（`workbench/intake/api.py:893-941`），不创建 ProductRevision。本轮 Dockview 验证只涉及 UI 布局保存，未改变或重新验收此业务缺口；真实 workbook 只读解析也没有提升主档或写主库。
3. 劳动日报字段、工时估算口径、金额公式/币种和人工确认尚未定；先确认日常实际日报来源及这些计算口径，再补解析/公式和版本证据测试，不猜业务规则。

真实资料状态：该节记录的静态闭环核查当时未读取真实 Excel、访谈、录音、员工日报或产品主档；下方新增段落单独记录后来获授权的四份 Excel 只读解析，不改变当时对访谈、录音、员工日报和主档的未核验状态。此前 synthetic API 测试不能写成真实资料闭环。整体闭环仅到已确认生产要求对应的执行计划草稿。另，当前 source-mode 窗口状态：bundle `a1393039…` 已打开，Root 看见标题、provider 徽标和空会话 composer；max/restore 点击被物理 Escape 中断，结果未知，不标通过。

## 四份来源工作簿的只读解析与来源定位（2026-10-23）

- [x] 四份获准原件只读解析前后指纹一致；原件、逐表统计、单元格定位和完整解析明细仅保存在项目外的私有审计目录，不进入 Git。没有重算、改写、导出或导入主库。
- [x] 合成回归覆盖单元格图片占位、普通公式错误、公式缓存、浮动图片与真实文本，以及无 richData 部件的普通工作簿。图片单元格保留来源/图片关系并按未解决候选处理；普通文本、数字、公式缓存和真实错误保持各自类型；无图片关系的普通工作簿不产生无关 richData 告警。损坏图片引用仍保留可定位告警。
- [!] 来源没有自动硬关联。人工工时仍是估算，金额核对仍需确认公式与币种；工人实际日报方式未确认。不得把这些资料提升为已确认产品要求或执行计划。
- [!] 该轮只读来源审计与合成解析测试不是真实资料入库/API/ORM 集成验收；私有证据不会随 clone 发布。

## Intake 解析修复与 DnD 源码审计（2026-10-23）

- 对同坐标且 `kind=rich_data` 的 cell-image 引用，mapping 现在复用已被客户端接收的 `type_mismatch` 状态并置空候选值；raw XML、原始错误占位、单元格来源和独立图片关系均保留。formula/cache 错误状态优先，不会被图片占位覆盖；仅 `drawing` 浮动图片不参与单元格映射判定。没有新增 wire state、schema 或 migration。合成回归覆盖 cell-image 的文本/数字/日期映射、真实公式错误、普通文本/十进制零、公式缓存缺失和浮动图锚点内容。
- 无 richData 部件/引用的 workbook 不再报 `richdata_relationship_part_missing`；含 richData 元数据/部件但缺关系部件时仍输出该 warning，并在相应图片引用保留坐标、空 target 和 warning。报价单复核中 C4:C7 的候选状态从 `present` 变为 `type_mismatch`，V6:V89 仍是 84 个 `formula_error`；purchase、labor、production 的无关 warning 已消失。四份原件读前/读后 SHA-256 仍一致。运行时曾显示 openpyxl 对条件格式扩展的非致命读取警告；未保存或转换任何工作簿。
- TDD 红灯：新增 3 条行为回归在修复前有 2 fail、1 fixture setup error；修正合成 XML fixture 后重跑，剩余 2 条以预期原因失败（普通 workbook warning、图片单元格 mapping），exit 1。绿灯命令：`<LOCAL_USER_ROOT>\AppData\Local\TradeLoom\python-env\Scripts\python.exe workspace\testing\private\intake-audit-20261023\run_intake_unit_tests.py`，26 个 `IntakeParserTests` 与 `IntakeMappingSchemaTests` 均通过，exit 0；直接运行 SimpleTestCase，未建立或连接数据库。四原件脱敏复核 runner 同目录，exit 0，输入哈希和 CRC 均通过；这是只读结构复核，不是导入验收。
- 本轮只读 DnD 源审计：`client.scenes.js:1323-1325` 按实际 host 尺寸和 scene minimum width/height 推导 narrow；`:1494-1500` 仅 narrow 时设 `disableDnd`；`:1636-1637` 窄态禁用 Dockview tabs/header pointer events，同时恢复 group actions。Dockview pointer 策略需移动至少 5px 才进入拖动阶段。宽态未发现项目级拦截原因，不能据此判定拖放已修复或自动化驱动是根因。发布 bundle 的后台 jsdom 尝试在 pointerdown 初始化前因缺 `Document` 全局失败，且还需 ResizeObserver 与 hit-test 几何 shim；该失败不构成应用缺陷证据。本轮未改 UI，标签 DnD 留待用户允许的真实窗口验收。

## 隔离 PostgreSQL ORM/API 验证边界（2026-10-23）

只读检查确认已有专用 PostgreSQL 测试 runner：`workspace/runtime/tradeloom-harness/local-dev/django-phase2-test-runner-20261021-01/run-django-tests.mjs`，其文档约定使用本机专用测试端口 `127.0.0.1:55435` 和唯一 `tradeloom_test_*` 数据库。本轮对该端口执行 `pg_isready` 返回 exit 2（无可连接服务）；因此没有运行 ORM/API 测试、迁移或创建测试库，也没有改环境、切换 SQLite 或访问业务库。此前合成公开 API/ORM 测试的历史通过记录仍有效，但不等同于本轮 PostgreSQL 集成验证。

## 助手能力配置面板可视区域收尾（2026-10-23，源码候选）

`packages/tradeloom-shell/client.js` 将能力/配置面板保留为非模态 portal，按锚点和可视视口尺寸定位，最大宽 720px、边距 8px；窗口和 `visualViewport` 变化时重算，并使用既有 `.tl-shell-top` 语义主题变量作用域与 Agent 面板共享按钮样式。固定标题/关闭控件和滚动内容区保留，Esc 关闭并恢复选择器焦点，原角色隔离草稿与配置字段未改。源候选未同步/激活，暂无真实桌面视觉验收。

使用 runtime8 的真实 React 18.3.1、ReactDOM 和 jsdom 执行：`agent-configuration-dom.test.js` 1/1；相关 `scenes.test.js`、`shell.test.js`、`execution-plans-dom.test.js` 合计 66 pass、4 skip；完整 `npm test --prefix packages/tradeloom-shell` 为 216 pass、13 skip、0 fail，exit 0。13 项具体跳过条件：7 项需要 pinned compiled DSH runtime；1 项需要 DSH WebServer contract；2 项需要 compiled DSH tools library；2 项需要 Cordis context/Loader；1 项需要 pinned source 与 app-boot/include libraries。DOM/JSDOM 测试已在本轮启用。几何断言覆盖 400/520/1280px 与 300/823px、非零 anchor offset、250×200 visual viewport offset，以及触发器滚出可视区域时面板仍不越过视口底边。受控选择/输入和按键使用 pinned ReactTestUtils.Simulate，避免将 jsdom legacy input polyfill 当真实键盘证据；关闭行为用真实焦点元素上的 Escape 事件验证。几何和样式断言不代表像素级桌面/手机验收。此前观察到的 max/restore 未知状态继续保持未知；本轮未测试该功能。

## 窄画布场景切换回归（2026-10-23，本地候选已同步启动）

用 runtime8 的真实 React 18.3.1、ReactDOM 和 JSDOM 模拟 980×650 工作区（低于该场景 1143px 最小宽度），保留已保存的 ERPNext 辅助面板为 active，再真实点击“ERPNext”导航。修复前测试可见地切换 active scene 和 `aria-current`，但 active panel DOM 仍是 `auxiliary`，不是业务主面板；RED exit 1。根因是未挂载场景没有 `dockviewApis`，导航的即时 focus/reopen 失败，而该场景随后只从保存布局恢复 active panel。修复后导航请求会按 scene 暂存 panel id，并在该 scene 的 Dockview `onReady` 恢复保存布局后应用这次导航目标；已挂载场景、闭合面板恢复和用户保存布局仍走原路径，不重置布局。真实 React DOM 回归断言窄态 `disableDnd=true`、当前场景可见及 ERPNext `erpnext-status` 面板实际渲染。定向测试 exit 0；完整 shell suite 为 230 项，217 pass、13 skip、0 fail，exit 0。官方 `sync-dev-bundle --mode desktop` 同步及本地开发快捷方式启动后，manifest 指向 runtime8 / `desktop` profile，bundle SHA-256 `424b114a5ad4daa655be745f11cd28c892953972e53c36e8daaaa28a8634a5e2`；source/profile 的 `client.js`、`client.scenes.js`、`scenes.json` 和 `package.json` 哈希匹配。owned Electron PID 24444、HWND `0x18114C`、窗口标题“织贸助手”。这只是进程/窗口存在证据，窄态导航修复仍待 Root 实机验收；运行时 app-boot `05FCB004…82C964` 与 ui-layout `567B3E…01697` 哈希未变。同步前布局备份为 `workspace/testing/ui-20261023/private/dock-layout-preservation-20261023-222238-777.json`，文件 SHA-256 `E1D2B464…19CAE95C`；备份前后选定 Dockview 布局指纹同为 `D571215B0EB62F996DB761FA486060F2D220A01D079D01B3108E793F54EA3D3C`，state 文件 SHA-256 未变。外观与参考图的整体差异尚未处理。

### 协作源码检查点（2026-10-23）

- [x] 本机已激活 source bundle `424b114a5ad4daa655be745f11cd28c892953972e53c36e8daaaa28a8634a5e2`，包含窄态场景导航修复；该记录确认同步/启动，不替代当前 UI 验收。
- [!] 工作台 UI 仍在迭代；本地实际手机验收、当前 PostgreSQL 集成验收和 Dockview 跨组拖放均未通过本次证据确认。不要把 Node/DOM 合同测试外推为这些实机结果。
- [!] 当前验证边界和后续证据按本矩阵分项维护；本检查点不代表整体目标完成。

## Dockview 真实库 JSON 保存与恢复核验（2026-10-23，本地源码候选）

- 使用锁定的 `client.dockview.js` 生产 chunk、runtime8 React 18.3.1/ReactDOM 和 JSDOM，通过真实 `SceneWorkbench` 的 `onReady` API 实例加载推荐布局并调用 `layout(980,650)`、`layout(960,560)`、`fromJSON`、`toJSON` 和真实 `panel.api.close()`。仅对 DOM host 提供合成矩形/ResizeObserver；native conversation 使用简单占位，不据此声称 composer、像素、滚动、拖拽或手机行为已验证。
- 真实 Dockview 推荐树的外层、上排、下排分别约为 60/40、75/25、50/50（2px内）；自定义外层通过真实 `fromJSON/toJSON` 形成约 63/37，明确不同于推荐值。关闭“任务”面板后，测试捕获生产 `queueDockLayoutSave` 发出的真实 PUT body，按 HTTP `JSON.stringify/parse` 边界送入生产 `validateDockLayouts` 与 `normalizeDockLayouts`，再将 normalized tree 回灌真实 Dockview。四面板/关闭面板拓扑、嵌套方向、closed panel ID 和自定义外层比例（保存/恢复相对尺寸各在 2px内）均保留；React tree unmount 后 host DOM 清空且 scene API 引用释放。
- 原始 JS `toJSON()` 对象含 Dockview UI 默认字段；运行时检查这些 raw-only 字段为 `undefined` 或函数，JSON HTTP body 中均不保留。直接把未序列化对象交给严格 validator 曾产生拒绝，但不是实际 HTTP 合同。最终 HTTP body 的 panel 字段符合现有 allowlist，生产 validator 接受。故本轮没有修改 `dockRecordFor` 或放宽服务端 schema；validator 仍拒绝未知 panel、component、params 及 JSON 后实际存在的额外字段。
- 定向 integration 与附近 `dock-layout.test.js`、`scenes.test.js` 共 35 tests：33 pass、2 skip、0 fail、exit 0。该验证仅为本地源码/DOM 集成证据；candidate 未同步/激活，不代表真实桌面布局视觉或交互验收。真实手机、Dockview 跨组标签拖放及业务 ERP/数据库集成仍未验收。

## 业务 iframe 内容密度候选（2026-10-24）

- 仅在 `html[data-business-iframe="true"]` 下，将面板/详情标题设为 17px，说明设为 14px、1.5 行高与 4px 顶距；仅隐藏产品页重复的 `[data-testid="product-result-count"].count-note`。产品标题下完整的匹配/版本/缺项摘要、40px 状态行、警示、表单、筛选、时区提示均保留，独立页面样式不变。
- RED/GREEN 通过实际执行 `app.js` 产生 iframe 标记，并由 runtime8 jsdom 读取 computed styles 与挂载内容；`workbench/tests/js/*.js` 为 7 pass、0 skip、0 fail。此证据不等同于无遮挡实机像素验收。
- 当前桌面仍是 `591d5561…f714236` shell bundle；本轮只改 Django 直接服务的 `workbench/static/workbench/styles.css`。旧 `styles.css?v=imgsel2` GET 返回源码当前内容，但无 Cache-Control/ETag；模板静态链接已改为 `?v=iframe-density3`，令现有面板刷新请求新 URL。候选实机显示尚待主控确认。

## 最大化与 Dockview 布局保存诊断（2026-10-24，本地真实库集成）

- 真实 runtime8 Dockview 通过生产 group header 的“展开商品”按钮后，`onDidMaximizedGroupChange` 触发一次，`onDidLayoutChange` 为零，生产保存队列没有发 PUT。`JSON.stringify/parse(api.toJSON())` 后的最大化快照新增 `grid.maximizedNode`；普通布局不含此键，恢复动作会移除它。当前源码 `onDidLayoutChange` 才调用 `queueDockLayoutSave`，因此本测试没有伪造最大化 HTTP body，也未将假设描述为实机错误根因。
- 同一真实 Dockview 中启用 sash 的 pointerdown→move→up 改变了分支尺寸并触发生产 PUT；捕获的 HTTP JSON body 经生产 `validateDockLayouts` 接受。最大化/恢复各自没有 PUT；恢复后再次真实 sash 操作，HTTP body 不含 `maximizedNode` 且 validator 接受。该证据尚未复现主控所见“布局保存失败”提示，也不能排除实际请求时序、宿主响应或运行时差异；目前不改 validator 或生产保存逻辑。
- 定向真实库 integration 与附近 `dock-layout.test.js`、`scenes.test.js` 共 35 项：33 pass、2 skip、0 fail，exit 0；两个 skip 是需 Cordis context/Loader 与 pinned source/app-boot libraries 的测试。JSDOM 只提供 host 几何，不代表桌面像素、sash视觉或用户现场请求时序。当前桌面候选为 `591d5561…f714236`，没有因本诊断同步或重启。

## Dockview 快速跨组标签拖放候选（2026-10-24，未激活）

- 以真实 DockviewReact 8.6.0 / core 8.6.1、真实 `client.dockview.js` pointer backend 和公开 `addPanel()`/`toJSON()` 建立两组测试；仅用 JSDOM 几何与 hit-test shim。multi-move 正常拖放可合并；修复前同一 pointer ID 的 down→单次越过5px的 move→up 会留下原两组，RED；修复后单次与多次 move 均合并到目标组。pointercancel 不落位，先命中目标再在外部松手也不沿用陈旧目标，所有场景卸载后 DOM 清空。
- 根因是阈值 move 期间刚创建 PointerDragController，监听器错过了这次 move；若手势立即 up，`_currentTarget` 仍为空。仅在成功 pointerup 且 controller active 时用最终坐标同步 `_handleMove(e)`，再读取目标执行 drop；取消路径不命中也不落位。`scripts/build-dockview-chunk.mjs` 对锁定 MIT Dockview Core 8.6.1 生成结果做唯一锚点、失败关闭的窄变换；当前生成 chunk 与变换前 HEAD 基线逐字节重放后的结果一致。没有修改 Dockview 源依赖、许可证或通用拖放策略。
- 定向 pointer DnD、真实布局保存/恢复集成及包合同测试共 4 项：4 pass、0 skip、0 fail，exit 0。此为 JSDOM 真实库事件路径证据，不证明 Chromium/Electron 原生指针事件序列、视觉叠层或跨组拖放现场结果；候选未同步/激活，父控需在实际窗口复测。此前的 Sky 拖放尝试仍按当时证据记录，不能追溯改写为通过。

## Dockview 指针提示清理与 2026-10-24 实机复验

- 在 2026-10-24 激活的 bundle `43fbbba7b150cd7a624dc27756014468e085343259b34924e4ca54b1e60db681` 上，Root 实际将“资料”面板拖到另一组内容中心完成交换；两次相隔的稳定观察均未再看到“交换面板/分栏/合并标签”提示，也没有布局保存错误。提示现随 Dockview 原生 `.dv-drop-target` 生命周期清理，离开所有目标时由目标组观察器同步移除，pointerup 后的 0ms 任务兜底清理，卸载会取消计时器并断开观察器。
- runtime8 真实 Dockview/React/JSDOM 集成测试覆盖拖离目标后原生 overlay 与提示均消失，以及 pointerup final-hit 更新后 settled 状态无提示；Root 独立复跑两个 integration 测试：2 pass、0 skip、0 warning、exit 0、4.05 秒。JSDOM 结果不替代上述实机观察；测试只合成 host 几何，不测像素和物理输入时序。
- 同一窗口中 Root 实际验证 1707×1019 最大化窗口的分隔条可从距可见抓手约 4px 的位置命中并调整；此前在 `d61f` 候选实测的根/嵌套竖向分栏、header 合并、多标签中心交换、双击最大化/还原、拖向侧栏无落位继续有效，提示清理是其后窄增量。无录屏或逐帧测量，故不声称动画帧率/平滑度经视频计量；实机只确认展开与还原的起终状态。
- 重启后持久三组布局为左“资料”、右“商品+任务”（任务活动）、下方“商品助手”；Root 随后在 UI 中手动应用推荐布局。只读 `state.json` 中 products 布局当前为外层 60.2/39.8、上层 75.2/24.8、下层 50/50，面板集合为商品、任务、资料、商品助手，`closedPanelIds` 为空。该布局指纹与重启前保存的三组布局不同，说明 Root 的应用推荐操作已写入状态；激活时的 layout-only 私有备份留在项目外，不纳入仓库。
- 当前 bundle 来源/desktop profile 同步完成，`client.js`、`client.scenes.js`、`client.dockview.js`、`dock-layout.js`、`scene-layout.js`、`scenes.json`、`package.json` 共 7 项哈希匹配；Host `ui-layout/lib/client.js` 仍为 `567B3E3119FD4D132485AA27D92570B956C3F40481B0D3C3D467F53DD3301697`，app-boot 为 `05FCB004972D3CC9CFE9BE3C4F22E0B166641D0CF0CB60E090BC0BB66182C964`。上述结果不覆盖实体手机验收，也不表示整个项目目标完成。

## Dockview 整组标题拖放语义修复（2026-10-24，bundle `cdcd6411…`）

- 真实 Dockview 对空白组标题栏拖动提供 `{viewId, groupId, panelId: null}`。shell 现在按同一 view 的 `groupId` 取源组活动面板：拖到另一组内容中心执行已有交换，源组其余标签与分组几何保留；跨组同组边缘落位仍交给 Dockview 原生分栏，同组中心不交换；缺少或属于其他 view 的 transfer 不改变布局。
- Root 在 runtime8 实际验证：助手同组标签拖至内容边缘后恢复四组；空白助手组标题拖至资料内容中心成功交换；助手标签拖至资料内容中心反向交换成功；根分隔条 y=546 调整至约 y=656 后恢复；双击下方标题最大化，再双击还原；任务标题拖向侧栏后布局无变化。验证均为合成工作台面板，不涉及业务数据。另此前对同组助手标签边缘拆分、目标组标题合并和中心多标签交换的实机记录继续有效。
- Node shell 全套使用 runtime8 React/ReactDOM/JSDOM：232 项，219 pass、13 skip、0 fail、exit 0；13 项为需要本机未配置 pinned DSH/Cordis/WebServer 等依赖的条件测试。最终真实 Dockview integration 与 pointer 测试由 Root 独立复跑为 2 pass、0 skip、0 warning、exit 0。全套结果在最后实机复验前已完成；没有把 GUI 实测描述为全套自动化。
- 官方同步后的 desktop-8 bundle hash 为 `cdcd6411f614adb65085cb609a6e954b1ed752de12ee893165b05af59c24695e`，runtime/profile 中 package 文件与源码逐项一致；app-boot `05FCB004…82C964` 和 ui-layout `567B3E31…01697` 保持不变。JSDOM 事件测试不替代物理输入之外的浏览器/手机验收；本节不代表整体项目目标完成。

## Dockview 稳定帧复验与手机入口只读核对（2026-10-24，bundle `33d31ced…adee18`）

- Root 在 1707×1019 窗口用独立稳定帧复验。先前“空白标题栏无变化”和“拖到底缘合并整行”的即时截图没有等待画面稳定，随后 fresh capture 未复现；这些旧观察不作为缺陷已修复或回归通过的证据。
- 稳定帧实测：资料 tab 拖到本组右缘后成为独立右栏；拖到另一组空白标题区后合并；拖到本组底缘后仅资料拆为第二行，商品与总览仍在首行、商品助手仍在第三组。资料标题拖到上组右缘可恢复两列加底部助手。上下分隔条可调整，侧栏空白落点不改变布局。中心商品/资料交换、宽屏与展开侧栏时场景切换、根分隔条调整、双击组标题展开/还原均可用。主题 dark→跟随系统 light 成功；原生侧栏、会话、插件、设置和搜索入口仍可达。未测动画帧率。
- 本次候选由 primary checkout 的本地验收分支启动；launcher 的受信 release-root 校验不接受直接从隔离 worktree 启动。记录只标识分支与 bundle，不公开本机目录。任务创建页显示默认“本地规则演示”；未提交业务操作、未调用模型。实际模型、实体手机仍未验收。
- 手机入口实现为 `GET /tradeloom/mobile-link`，仅在受保护请求后按当前受信私有 IPv4 与端口 3088 生成授权入口；当前只读监听核对显示 DSH 占用局域网地址的 3088、Django 仅监听 `127.0.0.1:3090`。此处不记录本机 IP 或授权 URL/token。实体手机连接与配对尚未实测；应从应用内“连接手机”入口取得授权链接，不把 `127.0.0.1` 当作手机地址。
- runtime8 真实 Dockview integration 与 pointer DnD、`dock-layout.test.js`、`scenes.test.js` 共 36 项：35 pass、1 skip、0 fail，exit 0。skip 是 `client entry passes the real Cordis context through to scene registration`，因当前 runtime8 未提供 `TRADELOOM_CORDIS_LIBRARY`；为执行 empty-session DOM 用例另设置了 runtime8 的 `TRADELOOM_DOM_TEST_ROOT`，该用例通过。此次测试没有操作业务数据库或模型。
