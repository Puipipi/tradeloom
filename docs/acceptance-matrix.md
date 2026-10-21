# 原始总目标验收矩阵

本矩阵中的本机证据路径已规范为占位符；原始外部证据不随源码克隆提供。

审计日期：2026-10-20。依据原始目标文件 `<LOCAL_TASK_BRIEF>` 逐项核对，并追加后续 DSH 桌面、手机与六 Agent 目标；各项状态依可定位源码/测试/运行证据判定。

本矩阵中的本机证据路径已规范为占位符；原始外部证据不随源码克隆提供。

状态含义：`[x]` 该条原文范围已被对应证据证明；`[-]` 已有实现但目标范围或证据不足；`[ ]` 尚未实现；`[!]` 受真实外部条件阻塞。

本矩阵中的本机证据路径已规范为占位符；原始外部证据不随源码克隆提供。

本矩阵包含原始 Phase 0–7 的 **65 条任务**、**8 条阶段完成标准**、**10 条总体约束**、**5 个架构组成**和**2 条用户边界**。阶段总体结论单列，子项勾选不自动推导阶段完成。

本矩阵中的本机证据路径已规范为占位符；原始外部证据不随源码克隆提供。

> **当前范围（2026-10-21）：** 本地 source-mode Electron 原生 GUI 已验收五个业务路由、配置场景、Dockview 双栏工作区、原生聊天面板、模型/助手入口与 Site 日夜主题；用户草稿、会话和面板状态有既有持久化证据。最新主题验收及当前25项源文件冻结见[本批方法审计基线](verification/2026-10-21-bingus-methodology-audit.md)与其引用的记录。真实 DeepSeek Flash 仅在演示数据下完成自然语言提案/澄清及 product/delivery 只读工具调用；业务执行仍标记 `local_mock/simulated_rules`，不代表模型自主完成整条 workflow、企业真实资料或真人审批。Dockview分栏调整已有实机证据，但本轮没有证明鼠标拖动标签停靠的完整交互。390×844 与 320×720 是虚拟视口，不是实体手机；p8安装版未包含当前 source-mode 更新；企业规则访谈、实体手机仍未完成；AgentArts/P6已豁免。

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
| 场景与 Dockview 面板操作 | [-] 当前实现采用 Dockview、保存各场景布局并保留原生聊天/业务面板 DOM；source freeze 与定向 renderer/shell 门禁见[方法审计记录](verification/2026-10-21-bingus-methodology-audit.md)。实机已验分栏调整和会话草稿保留。 | HTML/JSDOM门禁不证明实际标签拖拽停靠；原生面板鼠标移动/分组仍需真实交互证据。 |
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

本矩阵中的本机证据路径已规范为占位符；原始外部证据不随源码克隆提供。



本矩阵中的本机证据路径已规范为占位符；原始外部证据不随源码克隆提供。



本矩阵中的本机证据路径已规范为占位符；原始外部证据不随源码克隆提供。


