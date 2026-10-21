# 织贸助手（TradeWeave / TradeLoom）Phase 0：AgentArts 与第十一届 ICT 平台能力研究

> 检索日期：2026-10-18（以下“页面更新时间”均为官方页面自报，不等同于检索日期）。  
> 研究方式：只读官方网页/官方 PDF/官方页面数据接口；未登录华为云、未部署、未购买、未调用真实模型、未探测凭据。  
> 结论标签：**文档支持** 表示官方文档明确说明；**账号实测待验证** 表示当前没有账号或控制台证据，不能据此声称已开通/可用。找不到官方证据只标“未找到”，不推断为不支持。

## 1. 赛题 2 的当前官方要求

### 1.1 入口与版本

- 官方赛题入口（中国区，页面参数）：<https://e.huawei.com/cn/talent/#/ict/innovation-details?zoneCode=027425&zoneId=98269700&compId=85132021&divisionName=%E4%B8%AD%E5%9B%BD%E5%8C%BA&type=C002&isCollectGender=N&enrollmentDeadline=2026-11-30%2023%3A59%3A59&compTotalApplicantCount=201>
- 页面动态数据接口（官方域）：<https://apigw-04.huawei.com/api/services/lras/cams/v1/comps/queryHtmlContext?zoneId=98269700&X-HW-ID=com.huawei.prm.talent&env=prod>
- 运行数据版本：`zoneCode=027425`、`zoneId=98269700`、`compId=85132021`、`compCategory=innovation`、`numberVersion=89`；页面 `lastUpdateDate=2026-10-18T02:00:29+08:00`，`release=2026-08-31`。检索日期为 2026-10-18。
- 官方通用手册：<https://e.huawei.com/en/documents/others/97a7871692ee4dfaa974cc326fbcd67f>（2026-2027 大赛手册；具体赛题 2 细则以中国区赛题页为准）。

### 1.2 任务要求与赛程

文档支持的赛题 2 要求：

- 场景不限，鼓励真实业务痛点；任务要求在华为云 AgentArts 完成智能体的**构建、编排与部署**。
- 通过**可访问、可交互的可视化 Demo 页面**展示核心功能和交互流程。
- 体现 AgentArts 在智能体设计、工具编排、知识接入、多 Agent 协作、效果评估等环节的价值，鼓励形成“场景识别→Agent 架构→技能编排→调试优化→部署上线”的闭环。
- 中国区页面写明：团队赛，3 名学生 + 1 名指导教师，同一高校；报名截止后不得更换；每名选手只能报名一个赛道。

赛程（官方页面）：

| 阶段 | 时间 |
| --- | --- |
| 报名 | 2026-08-31—2026-11-30 |
| 初赛 | 2026-12 |
| 中国总决赛 | 2027-03 |
| 全球总决赛 | 2027-05 |

页面字段 `enrollmentDeadline=2026-11-30 23:59:59`；`uploadWorkDeadline=2027-03-26 23:59:59`。后者仅按页面字段记录，不能自行解释为所有阶段统一截止时间。官方页面写明共 54 支队伍晋级中国总决赛；中国总决赛线上答辩为 15 分钟展示 + 5 分钟问答；每校同一赛题全球总决赛最多一支队伍；三赛题独立评审和晋级，全球总决赛页面表述为 2 道赛题独立评审。中国总决赛每个赛题最高名额按页面为：一等奖 4、二等奖 6、三等奖 8。

### 1.3 提交物与评分

| 阶段 | 官方要求的提交物 | 评分（官方页面表述） |
| --- | --- | --- |
| 初赛 | 作品信息收集表 Word；可附作品介绍 PPT/设计文件/演示视频。材料应覆盖作品简介与创意、团队、Agent 设计方案（场景、编排、工作流、模型与资产）、行业问题/落地场景，以及基于 AgentArts 构建运行的 Demo 视频。 | 创新性 60%；应用价值 40%。 |
| 中国总决赛 | 作品答辩 PPT；可在线访问和交互的 Demo 地址；Agent 设计方案文档（场景、编排、工作流、知识库构建、模型与资产选择）；自定义 Skill/MCP 服务说明（如有）；华为云开发者社区或开源社区分享帖截图。最终分数 100% 由答辩当天评委组评议。 | 创新性 40%；应用价值 35%；完整性与可展示性 15%；答辩表现 10%。 |
| 全球总决赛 | 同中国总决赛，并增加作品/方案应用及落地进展说明；社区分享帖截图及阅读量、互动量等反馈。最终分数 100% 由答辩当天评委组评议。 | 创新性 40%；应用价值 30%；完整性与可展示性 15%；作品应用与落地进展 10%；答辩表现 5%。 |

账号/参赛资格、具体提交系统是否开放、各地区实施细则和最终评奖均**账号实测/组委会确认待验证**；本报告不假定比赛账号权限。

## 2. AgentArts 的核心边界（已确认）

### 2.1 低代码与高代码是不同的开发/部署路径

- 官方“选择开发路径”页：<https://support.huaweicloud.com/qs-agentarts/agentarts_04_0002.html>（正文未显示明确更新时间）。  
  文档支持：**Managed Agents** 由平台托管构建/部署/运行，用户提供模型、提示词、工具与技能；**托管运行时** 由用户提供容器镜像/Agent 代码，平台提供运行环境、弹性伸缩与隔离。两者不能混称为同一实现方式。
- 低代码支持单智能体、工作流、多智能体三种构建类型；高代码见 <https://support.huaweicloud.com/highcode-agentarts/agentarts_10_001.html>：可在本地使用 LangChain/LangGraph 等框架、通过 SDK/容器部署到 Runtime，使用 Memory、Gateway、Tools、Identity，并获得日志/可观测能力。
- 账号实测待验证：当前账号是否开通体验版、能否创建 Managed Agents、能否使用高代码 Runtime/SDK、可用区域和模型，均未验证。

### 2.2 多 Agent 与工作流

- <https://support.huaweicloud.com/lowcode-agentarts/agentarts_05_0279.html>（2026-08-04 页面）：工作流是确定性流水线；多智能体是多个独立 Agent 按角色分工协作；官方明确多智能体依赖中央控制模型和已开发好的专家智能体，且该页仍提示多智能体调试难度较大。
- <https://support.huaweicloud.com/lowcode-agentarts/agentarts_05_0057.html>（2026-09-28 页面）：多 Agent 控制器支持意图识别、子智能体、起始/默认/结束工作流，工作流必须先发布才能被多智能体引用。
- <https://support.huaweicloud.com/lowcode-agentarts/agentarts_05_0041.html>（正文未显示明确更新时间）：工作流可视化画布支持大模型、代码、判断、循环、插件、MCP、HTTP 请求、消息、提问器、输入、问答等节点；工作流运行会产生模型/服务费用。
- 文档冲突/版本风险：最新动态（<https://support.huaweicloud.com/wtsnew-agentarts/index.html>）出现“多智能体支持调试”的新增记录，而 05_0279 仍写“当前无可视化调试能力”；实际控制台版本与调试能力必须账号实测，不能只凭一个页面下结论。

### 2.3 运行时外部 API、认证和文件

- 运行时调用概述：<https://support.huaweicloud.com/highcode-agentarts/agentarts_10_130.html>（页面更新时间 2026-09-16）。文档支持：运行时部署后通过 RESTful API 交互；Agent 代码决定请求/响应体，平台网关只做鉴权和路由；同一 `X-Hw-Agentarts-Session-Id` 可关联多轮；文件上传/下载必须在创建运行时开启“文件上传下载”，创建时未开启后续不能使用该能力。
- `ExecuteRuntime`：<https://support.huaweicloud.com/api-agentarts/InvokeRuntime1.html>（2026-09-30 页面）。文档支持：`POST /runtimes/{runtime_name}/invocations`；必填 `X-Hw-Agentarts-Session-Id`、`Authorization`；状态码 200/401/404/500；不同区域使用不同 gateway domain。
- 认证鉴权：<https://support.huaweicloud.com/api-agentarts/agentarts_07_0005.html>（2026-08-27 页面）。文档支持：工作流/智能体、运行时、网关等支持 AK/SK、API Key、OAuth 2.0 的不同组合；部署时选择认证方式，重新部署不能直接改变，错误时需要重新创建/复制智能体；AK/SK 签名消息体限制为 12MB。
- **60MB 的准确边界**：2026-06-02 版 API 参考中的“上传文件 - AgentUploadFile”接口写明单文件不超过 60MB，适用于工作流/智能体上传文件接口；不是 AgentArts 全平台所有文件、知识库、插件、媒体或高代码 Runtime 上传的统一上限。高代码 Runtime 另有 `ExecuteRuntimeUploadFiles`/文件上传下载开关，2026-09-24 API 参考虽列出该接口，但其具体大小限制本次未完成逐项核实；账号实测待验证。

### 2.4 模型与套餐

- 官方产品概览：<https://support.huaweicloud.com/productdesc-agentarts/agentarts_03_0002.html>。文档支持：预置/自定义模型、低代码与高代码、单智能体/工作流/多智能体；平台提供 MaaS 模型及自定义模型接入。
- 免费模型：<https://support.huaweicloud.com/lowcode-agentarts/agentarts_05_0186.html>（2026-09-16 页面）。文档支持：开通后默认 2,000,000 tokens 免费额度，用于模型调测和智能体试运行；免费额度用尽或通过 API 调用需要开通 MaaS 并完成鉴权，按 MaaS 计费。
- 自定义模型：<https://support.huaweicloud.com/lowcode-agentarts/agentarts_05_0191.html>。文档支持：可接入用户自建或第三方模型服务 API，支持 Chat/Embeddings/Rerank/图像理解及多种协议；第三方模型费用由供应商收取，平台不建议额外收费，但应设置流控。
- 订阅套餐：<https://support.huaweicloud.com/productdesc-agentarts/agentarts_03_0003.html>（2026-09-24 页面）。文档支持：体验版 20CU、1GB 知识库、2 名成员、50 个应用、支持自定义模型和导入导出；团队/企业付费套餐当前多未开放，需提交工单。  
- 计费：<https://support.huaweicloud.com/price-agentarts/agentarts_08_0003.html>（2026-09-24 页面）。文档支持：套餐 CU 额度、超出按需、MaaS 模型、AOM/APM/LTS 日志观测、DEW 凭据等关联服务可能另计费；体验版 20CU 为一次性赠送额度，不按月重置。

> 以上额度、套餐、模型和区域均属**文档记录**；实际账号是否获得体验版、免费 tokens、区域权限和配额，必须以账号控制台/账单实测，不能写成已获得。

### 2.5 自定义工具、发布、外网页、导入导出、暂停恢复、区域和权限

**自定义 API 插件**：官方示例 <https://support.huaweicloud.com/lowcode-agentarts/agentarts_05_0124.html>（2026-09-16 页面）展示“创建插件→创建工具→调试→发布”，插件 URL、API Key/Header/Bearer 鉴权、工具 path、请求/响应参数均有配置步骤；插件调试成功后才能发布。最新动态（<https://support.huaweicloud.com/wtsnew-agentarts/index.html>）还记录 OpenAPI 3.0 JSON 导入、服务域名/基准 URL 变量、华为云认证、MCP OAuth 2.0 等新增能力。工作流 API 的 `plugin_configs` 在官方 API 参考（<https://support.huaweicloud.com/api-agentarts/agentarts-api-pdf.pdf>）中说明：插件节点采用“用户级鉴权”时需要传插件鉴权配置，否则无需传。  
**边界**：插件“创建/调试/发布”和 API Key Header 有文档；具体账号能否创建、目标第三方 API 是否可达、OAuth 客户端如何登记、插件是否被当前套餐允许，均**账号实测待验证**。

**发布与网页/API 入口**：<https://support.huaweicloud.com/lowcode-agentarts/agentarts_05_0053.html>（发布并部署工作流）明确：提交版本、可勾选“部署至实例”、部署后生成 API；“渠道管理”的“网页”渠道可“立即访问/复制链接/重新生成”，API 渠道可查看请求 Path、方式、凭证 Key、参数；“云商店”渠道也有发布链接。部署时入站认证可选 IAM、OAuth 2.0 或 API Key，**仅第一次部署可选择**；部署后的 API 调用见 <https://support.huaweicloud.com/lowcode-agentarts/agentarts_05_0055.html>。  
**边界**：发布为网页 URL 有文档；是否有当前账号的发布权限、网页是否可被外部访问、调用量/套餐/域名是否满足比赛，均**账号实测待验证**。高代码 Runtime 的部署/API 发布见 10_130；低代码工作流/多智能体发布和 API 调用见 05_0053/05_0055/05_0057。

**暂停、恢复、人工审批**：官方工作流节点（05_0041）确有“提问器/输入/问答”等面向用户收集信息或中途提问的节点；API 参考的响应示例也提到“提问器节点问题消息”。这能证明**一次运行中的人工交互**，但本次未找到官方说明：AgentArts 是否提供持久化的暂停/恢复 API、跨 HTTP 调用的审批令牌、人工审核队列或恢复同一运行实例。不能把“提问器节点”写成完整的 pause/resume/human approval；该项标 **未找到官方持久化 API 证据，账号实测待验证**。

**支持区域、权限、配额**：官方“支持区域”入口为 <https://developer.huaweicloud.com/endpoint?agentarts>；“系统权限”入口为 <https://support.huaweicloud.com/permissions/iam_01_0001.html?product=agentarts>。文档支持 IAM 用户/用户组/策略授权、区域级/全局服务作用范围。运行时 SDK 页面 <https://support.huaweicloud.com/highcode-agentarts/agentarts_10_037.html> 明示支持“西南-贵阳一（cn-southwest-2）”；API 示例使用华北-北京四 endpoint。具体区域清单、账号可用区和 AgentArts 专属权限项需以控制台/账号实际验证；本次未把示例区域误写成所有账号可用区域。

**导入导出**：<https://support.huaweicloud.com/lowcode-agentarts/agentarts_05_0058.html> 文档支持 AgentArts 工作流导入/导出（jsonl）及 Dify DSL（yml）导入，最大导入文件 128MB。Dify 导入时知识库和自定义插件不能自动导出/迁移，模型需要重新选择，部分节点、重试、超时、异常分支、SSL 验证等存在不兼容。套餐/计费页（03_0003、08_0003）还写明“应用导入导出支持”；最新动态记录应用/工作流、模型、供应商、路由策略等资源导入导出优化。  
**边界**：平台级导入导出有文档，但不等于当前账号可导入、可导出全部关联资源，也不等于 Dify 工作流可无损迁移。

### 2.6 平台能力矩阵（文档支持 vs 账号实测）

| 能力 | 低代码路径 | 高代码路径 | 文档结论 | 账号实测 |
| --- | --- | --- | --- | --- |
| 单智能体 | Managed Agent/单智能体配置 | 自研代码或框架部署 Runtime | 文档支持 | 未验证 |
| 工作流编排 | 可视化画布、条件/循环/插件/MCP/HTTP 等节点 | 自有代码/框架控制流程 | 文档支持 | 未验证 |
| 多 Agent 协作 | 多智能体控制器：意图、子智能体、起始/默认/结束工作流 | 可由 LangGraph 等实现，非平台原生同一配置 | 文档支持低代码多智能体；高代码需自建 | 未验证 |
| 自定义工具/API 插件 | 创建插件/工具、API Key/Header、OpenAPI 导入 | SDK/网关/自研工具 | 文档支持，具体鉴权配置和发布 | 未验证 |
| 文件上传 | 工作流/智能体 `AgentUploadFile` 文档为单文件≤60MB | Runtime 需创建时开启文件上传下载；另有 ExecuteRuntimeUploadFiles | **60MB仅特定上传API，不是全平台上限** | 未验证 |
| 模型 | 预置 MaaS/自定义模型接入 | 自选模型/自研服务 | 文档支持；第三方费用另计 | 未验证 |
| 外部运行时 API | 工作流 API 调用路径 | `POST /runtimes/{name}/invocations`、Session ID、Authorization | 文档支持 | 未验证 |
| 应用网页/API 发布 | 版本、部署、渠道管理、网页/API/云商店 | Runtime 部署与 API | 文档支持 | 未验证 |
| 暂停/恢复/人工审批 | 提问器/输入/问答节点；持久化恢复API未找到 | 可在自有代码实现，平台API未证实 | **未找到持久化证据** | 未验证 |
| 区域/权限/配额/费用 | 区域 endpoint、IAM、套餐/CU | SDK 支持 cn-southwest-2 | 文档有入口/套餐；账号权益未验证 | 未验证 |
| 导入导出 | AgentArts jsonl/Dify yml，最大 128MB | 资源/应用导入导出 | 文档支持，关联资源可能不完整 | 未验证 |

## 3. 12-Factor Agents 官方源与 TradeLoom 映射

官方当前 README：<https://github.com/humanlayer/12-factor-agents>（检索日期 2026-10-18；具体原则页在表中链接）。该仓库是工程原则参考，不是 AgentArts 官方文档，也不是比赛强制框架；下表描述的是 TradeLoom 当前实现与目标的映射，不声称已完全合规。

**实现边界（必须先读）**：

- **正式工作台**：`tradeloom/` 内 tracked 的 Django 应用，正式持久化只用 PostgreSQL；旧 SQLite 仅作为归档数据，不再参与运行。
- **DSH account 实验**：父容器 `workspace/experiments/central-agent/` 的本地协议实验，使用独立 PostgreSQL `tradeloom_lab`，不进入正式仓库、正式数据库或比赛部署；它只提供协议参考，不算正式能力。
- 下表的“正式实现”列只评价正式工作台；lab 列单独标注，不作合规证据。

| # | 官方原则（原文标题） | 正式工作台 | DSH 实验（隔离） | 状态/缺口 |
| --- | --- | --- | --- | --- |
| 1 | Natural Language to Tool Calls（<https://github.com/humanlayer/12-factor-agents/blob/main/content/factor-01-natural-language-to-tool-calls.md>） | `AgentRequest/AgentResult` + `AgentRegistry` 只接受结构化请求，执行器不能自由调用工具。 | center 只接受结构化 decision。 | 部分：尚无通用工具调用层 |
| 2 | Own your prompts（<https://github.com/humanlayer/12-factor-agents/blob/main/content/factor-02-own-your-prompts.md>） | 正式本地执行器无模型提示；模拟规划规则独立于 UI。 | center/user_info 指令在本地 patch 中，未版本化。 | 部分：正式工作台无 prompt 版本层 |
| 3 | Own your context window（<https://github.com/humanlayer/12-factor-agents/blob/main/content/factor-03-own-your-context-window.md>） | 从 Task/Product 构造结构化 payload，不把整段聊天历史当上下文。 | `_center_prompt` 带目标、专家与 facts。 | 已做基础；正式工作台不调用模型 |
| 4 | Tools are just structured outputs（<https://github.com/humanlayer/12-factor-agents/blob/main/content/factor-04-tools-are-structured-outputs.md>） | `InputRef`、`PendingItem`、`ArtifactRef`、AgentRun JSON。 | 决策为严格 JSON。 | 部分：工具 schema/通用工具未落地 |
| 5 | Unify execution state and business state（<https://github.com/humanlayer/12-factor-agents/blob/main/content/factor-05-unify-execution-state.md>） | Task/Product/TaskFile/AgentRun 全部在 PostgreSQL；旧 SQLite 只归档。 | 独立 `tradeloom_lab`，不与正式库混用。 | 已做基础；缺统一 EventLog/审批状态 |
| 6 | Launch/Pause/Resume with simple APIs（<https://github.com/humanlayer/12-factor-agents/blob/main/content/factor-06-launch-pause-resume.md>） | 有创建/编辑/确认/导出；尚无持久化工作流暂停与显式 resume API。 | session/message 与 `outcome_unknown`/409 只作协议参考。 | 部分，关键缺口 |
| 7 | Contact humans with tool calls（<https://github.com/humanlayer/12-factor-agents/blob/main/content/factor-07-contact-humans-with-tools.md>） | 产品字段编辑与整体确认是人工节点；尚无 durable HumanReview 队列。 | `ask_user` 自动链不属于正式流程。 | 部分 |
| 8 | Own your control flow（<https://github.com/humanlayer/12-factor-agents/blob/main/content/factor-08-own-your-control-flow.md>） | registry 只做单次 dispatch；正式中心控制流待 Phase 2/3 实现。 | 中心循环由 lab 代码控制，最多 2 次 helper、5 次调用。 | 部分：正式工作台无中心控制流 |
| 9 | Compact Errors into Context Window（<https://github.com/humanlayer/12-factor-agents/blob/main/content/factor-09-compact-errors.md>） | AgentRun 保存 error；无自动重试与错误摘要回注。 | timeout→504/409 + `outcome_unknown`。 | 部分：无重试策略 |
| 10 | Small, Focused Agents（<https://github.com/humanlayer/12-factor-agents/blob/main/content/factor-10-small-focused-agents.md>） | 当前只有 product_profile；目标新增中心/产品资料/交付质检。 | center/user_info 边界独立。 | 部分：正式职责尚未拆分 |
| 11 | Trigger from anywhere（<https://github.com/humanlayer/12-factor-agents/blob/main/content/factor-11-trigger-from-anywhere.md>） | Django 模板 + 同源 HTTP API 已提供页面与程序入口，满足“可由多种入口触发”的基础；不要求新增 Slack/邮件渠道。 | lab HTTP API 独立。 | 基础满足；外部渠道不是必做项 |
| 12 | Stateless reducer（<https://github.com/humanlayer/12-factor-agents/blob/main/content/factor-12-stateless-reducer.md>） | 业务状态可从 PostgreSQL 的 Task/Product/Run 重建；EventLog 用于审计，不要求完整事件溯源架构。 | lab 从 session 读取目标与 facts。 | 基础方向满足；无需为合规引入事件溯源 |

## 4. 最小账号实验证据清单

以下均**未执行**；需要账号/控制台/合法测试额度，不能替代 Phase0 文档结论。

| 实验 | 最小证据 | 当前状态 |
| --- | --- | --- |
| 套餐与区域 | 控制台显示套餐、区域、成员、应用数、CU/知识库额度 | 账号实测待验证 |
| 低代码单智能体 | 创建、调试、发布并保存页面/API 证据 | 未执行 |
| 工作流 | 发布版本、部署实例，得到网页 URL/API Path，调用一次并保存响应 | 未执行 |
| 多智能体 | 建立意图识别 + 子智能体/工作流，确认实际控制台是否支持调试；记录版本冲突 | 未执行 |
| 入站认证 | 分别验证 IAM/API Key/OAuth（至少一种）；确认首次部署后不可改 | 未执行 |
| 自定义插件 | 用 API Key Header 或 OpenAPI 导入创建/调试/发布；验证用户级 `plugin_configs` | 未执行 |
| 文件 | 仅对 `AgentUploadFile` 测试 60MB 边界；区分高代码 Runtime 文件上传开关和独立大小限制 | 未执行，禁止把 60MB 推广到全平台 |
| 高代码 Runtime | 部署容器，验证 session ID、Authorization、文件开关、外部 API 和日志 | 未执行 |
| 模型与费用 | 验证 2,000,000 tokens 免费额度、自定义模型、MaaS/第三方模型账单 | 账号/账单待验证 |
| 暂停/恢复/审批 | 测试提问器/问答节点后是否有持久化 pause/resume/approval API；找不到证据则记录为未证实 | 未执行 |
| 导入导出 | 导入/导出 AgentArts jsonl 和 Dify yml（≤128MB），核对插件/知识库/模型丢失 | 未执行 |
| 权限与观测 | IAM 用户组/策略、支持区域、配额；查看 trace/logs，确认不泄露 CoT/凭据 | 未执行 |

## 5. 关键风险与主控决策点

- **比赛合规风险**：赛题 2 明确要求基于 AgentArts 构建、编排、部署，并提供可在线访问/交互的 Demo；当前正式 Django+PG 工作台是本地骨架，ignored DSH lab 不是 AgentArts 部署。没有账号实测，不能声称 Phase6 或比赛部署完成。
- **低/高代码混用**：Managed Agents、低代码单/工作流/多智能体、高代码 Runtime 是不同路径；60MB 只是特定 `AgentUploadFile` API 的文档限制，不能写成平台统一上限。
- **pause/resume**：人工提问节点不等同持久化暂停/恢复/审批；当前未找到正式 API 证据，比赛 Demo 不能把“问答节点”宣称为完整恢复能力。
- **账号权益**：体验版/付费套餐、区域、成员数、应用数、CU、免费 tokens、MaaS/第三方模型、AOM/APM/LTS/DEW 费用均需账号和账单验证。
- **迁移风险**：Dify 导入不迁移知识库/自定义插件；模型需重选；部分节点、重试、超时、异常分支和 SSL 配置不兼容。
- **认证不可逆**：部署时选择的 IAM/OAuth/API Key 方式，重新部署不能直接修改；错误需要重创建/复制。
- **文档版本冲突**：多智能体调试能力在旧选型页和最新动态中表述不一致；以实际控制台版本和截图为准。
- **lab 边界**：ignored central-agent 的 DSH account 测试不进入 GitHub，不是 AgentArts，也不应把本地 trace/运行记录冒充平台运行。

## 6. 来源与版本注记

- 赛题页/API：上述 SPA 与 `queryHtmlContext`；页面 `numberVersion=89`、`lastUpdateDate=2026-10-18T02:00:29+08:00`，检索日期 2026-10-18。
- 华为云文档页面更新时间明确者已随文标注；未显示的页面不臆造日期。检索日期统一为 2026-10-18。
- 官方通用手册：<https://e.huawei.com/en/documents/others/97a7871692ee4dfaa974cc326fbcd67f>（2026-08-27 页面版本）。
- AgentArts 主要页面：04_0002、10_001、10_130、InvokeRuntime1、agentarts_07_0005、05_0279、05_0057、05_0041、05_0124、05_0053、05_0055、05_0058、05_0186、05_0191、03_0003、08_0003；URL 已在上文对应段落给出。
- 12-factor：README 与 factor-01 至 factor-12 当前 main 分支页面；检索日期 2026-10-18。

## 7. 2026-10-19 官方资料增量复核

以下是 2026-10-19 对官方入口与指定文档的增量核对，不改写上文 2026-10-18 的证据快照：

- [第十一届 ICT 创新赛官方入口](https://e.huawei.com/cn/talent/#/ict/innovation-details?zoneCode=027425&zoneId=98269700&compId=85132021)：当日打开仅返回动态 JavaScript 页面壳，未复核出当前评分、提交物或截止时间。高校转发内容只能作为线索，不能标成官方细则。
- [InvokeRuntime](https://support.huaweicloud.com/api-agentarts/InvokeRuntime.html)：接口为 `POST /runtimes/{runtime_name}/invocations`，`Authorization` 必填；`X-Invoke-Mode` 是 Header。`query` 用于单/多智能体；工作流 `inputs` 的字段名由开始节点变量定义；session 通过 Header 传递。此接口不是 OpenAI Chat Completions 兼容接口。
- [高代码 Runtime 概述](https://support.huaweicloud.com/highcode-agentarts/agentarts_10_029.html)：列出 8080 端口和 `/invocations`，并说明临时本地磁盘会在重启/弹性伸缩后丢失，以及 ARM64 限制。
- [CreateCoreRuntime](https://support.huaweicloud.com/api-agentarts/CreateCoreRuntime.html)：另列 `arm64` 与 `x86_64` 架构，与概述页 ARM64 限制表述存在口径冲突，部署前须以目标区域/版本核验。
- [AgentArts 最新动态](https://support.huaweicloud.com/wtsnew-agentarts/index.html)：2026 年 9 月动态列出 Managed Agents 能力更新；这属于文档能力记录，不证明当前账号已开通或完成实测。

本节只记录官方文档行为；未进行账号登录、部署、凭据检查或云运行时 API 调用。每个来源的摘要保持在 200 字以内。

## 8. 2026-10-19 官方赛事 API 原始响应核验

本节是官方赛事接口的新增证据；保留 §7 当日打开 SPA 页面仅得到动态 JS 壳的历史记录。两者请求路径不同：§7 记录赛事网页入口，以下记录官方 `queryHtmlContext` JSON API。此次只读公开赛题数据，不涉及 AgentArts 账号、凭据或平台运行时。

- **请求与快照：** `GET https://apigw-04.huawei.com/api/services/lras/cams/v1/comps/queryHtmlContext?zoneId=98269700&X-HW-ID=com.huawei.prm.talent&env=prod` 返回 HTTP 200、`application/json; charset=UTF-8`，于 `2026-10-19T03:40:38Z` 接收；JSON `code=200`、`message=success`。原始 56,645 字节文件在项目外 `<LOCAL_RESEARCH_ROOT>\official-rules-20261019\queryHtmlContext.json`，SHA-256 `7eec5410cf6fb63b217a42b7563d73e60e6b05e2c2c6c2f3c551c5b53c3f75e7`；元数据和解析摘要同目录。响应 `zoneId=98269700`、`compId=85132021`、`numberVersion=89`，当前 `org_lastUpdateDate=2026-10-19T02:00:30+08:00`。这更新时间晚于 §1 保存的 10 月 18 日记录；版本号相同不能证明正文未变。
- **来源定位：** `data.modules[1]` 的 `tagId=ZM03` 是具体赛题及评分；`data.modules[3]` 的 `tagId=ZM05` 是赛程/奖项，也提及赛题二，但不是任务与评分的具体来源。`data.modules[4]` 的 `tagId=ZM04` 是通用参赛规则；`data.modules[0]` 的 `tagId=ZM01` 包含模板链接。解析器只读取 context HTML 文本与 href，不执行页面脚本，也不下载附件。可复核的分块和要求摘录见项目外 `official-rules-parsed-summary.md`。
- **赛题二硬要求：** `$.data.modules[1].context` 块 [37]–[49] 要求基于 AgentArts 构建、编排、部署 Agent，并通过可视化 Demo 展示核心功能与交互；需体现平台在 Agent 设计、工具编排、知识接入、多 Agent 协作和效果评估的价值。场景不限，真实痛点与完整开发闭环是鼓励方向，不应提升为额外硬验收项。
- **分阶段材料和评分：** 同模块块 [125]–[134] 为初赛：Word 作品信息收集表，材料覆盖作品与团队、Agent 方案及行业问题，并提供基于 AgentArts 构建运行完整流程的 Demo 视频；评分创新 60%、应用价值 40%。块 [135]–[145] 为中国总决赛：答辩 PPT、可在线访问交互 Demo、Agent 方案、Skill/MCP 说明（如有）和分享帖截图；评分 40%/35%/15%/10%。块 [146]–[158] 为全球总决赛：增加应用/落地进展和社区反馈数据；评分 40%/30%/15%/10%/5%。
- **其他边界：** MaaS Token Plan 与云资源代金券列为资源支持，额度、范围、有效期以通知为准；不是取得代金券的赛题硬依赖。原始响应中“英文答辩总分加 2 分”位于 `ZM03` 的赛题二内容之前、上一赛题评分表尾；赛题二评分块没有该加分，是否适用待组委会确认。完整源码不是 `ZM03` 分阶段材料清单中的独立必交项；通用规则另有提交代码后应可复现展示的条件，两者需区分。

**对现有记录的修订边界：** `docs/00-赛题与目标.md` 已按官方原始响应校正代金券、真实痛点、英文加分和报价 Agent 的措辞。官方平台部署与在线交互 Demo 要求仍是硬约束，本地 Django 工作台/离线 adapter 不能替代 AgentArts 部署。实际账号、平台调用、部署和提交成果仍未核验；P6 实测状态不因公开赛事资料确认而改变。

