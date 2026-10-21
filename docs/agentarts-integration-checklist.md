# AgentArts 集成核查清单

> 状态标记：`[ ]` 未开始，`[-]` 研究中，`[x]` 文档已确认，`[!]` 待账号实测/受阻。
>
> 目标平台：华为云 AgentArts（智果）。目标比赛：华为第十一届 ICT 大赛创新赛赛题二。
>
> 原则：官方文档已确认的协议可以先写 adapter 并单测；未配置时健康状态为 `agentarts=not_configured`、证据状态为 `documented_not_connected`。只有账号实测与部署验收后才可标“真实已接入”。

> **范围状态（用户最新指示，2026-10-19）：AgentArts/P6 暂不处理，保留本文作为既有研究与未验证事项的追踪记录，不作为当前项目阻塞。不得把未验证条目改成已完成。当前工作目标为复用官方 `deepseek-ai/deepseek-harness` 源码，制作编程新手可直接使用、手机与电脑可用的软件。现有 DSH stdio SDK transport 线索见 `workspace/experiments/central-agent/labapp/dsh_client.py`、`runtime.py`，尚待审查和集成。

> 2026-10-18 官方 research 已完成，完整证据与版本注记见 `docs/research/2026-10-18-platform-capabilities.md`。本文只保留能力结论与账号待测项。

## 首批官方证据（2026-10-18 reader）

| 证据 | 结论 |
|---|---|
| 赛题数据接口 | 明确 AgentArts 构建/编排/部署 + 可视化 Demo；初赛创新 60 / 应用 40；中国决赛 40/35/15/10；全球 40/30/15/10/5；初赛作品信息表；决赛 PPT、在线 Demo、Agent 设计、Skill/MCP 说明、分享帖 |
| 低/高代码路径 | 平台同时提供低代码与高代码构建路径 |
| 多 Agent 控制器 | 支持多 Agent 控制器编排 |
| 工作流 vs 多 Agent | 两种编排形态有明确区别与适用场景 |
| 节点 | 提供节点能力说明 |
| Runtime 调用 | 请求体由部署代码定义；支持 session 头与文件开关 |
| Runtime API | `POST /runtimes/{runtime_name}/invocations`；Authorization；`X-Invoke-Mode`；`x-hw-agentarts-session-id`；200/401/404/500 |
| 认证 | AKSK / APIKey / OAuth；部署后认证方式不能直接修改 |

来源：

- 赛题数据接口：<https://apigw-04.huawei.com/api/services/lras/cams/v1/comps/queryHtmlContext?zoneId=98269700&X-HW-ID=com.huawei.prm.talent&env=prod>
- 低/高代码：<https://support.huaweicloud.com/qs-agentarts/agentarts_04_0002.html>
- 多 Agent 控制器：<https://support.huaweicloud.com/lowcode-agentarts/agentarts_05_0057.html>
- 工作流 vs 多 Agent：<https://support.huaweicloud.com/lowcode-agentarts/agentarts_05_0279.html>
- 节点：<https://support.huaweicloud.com/lowcode-agentarts/agentarts_05_0041.html>
- Runtime 调用：<https://support.huaweicloud.com/highcode-agentarts/agentarts_10_130.html>
- InvokeRuntime API：<https://support.huaweicloud.com/api-agentarts/InvokeRuntime.html>
- 认证：<https://support.huaweicloud.com/api-agentarts/agentarts_07_0005.html>

## 能力核查表

| # | 能力 | 文档状态 | 账号状态 | 证据/待办 |
|---|---|---|---|---|
| 1 | 多 Agent 创建与调用 | [x] 支持多 Agent 控制器 | [!] 未实测 | 控制器文档；待验证 Agent 数量、职责绑定、调用方式 |
| 2 | 工作流编排 | [x] 有工作流与节点 | [!] 未实测 | 待验证分支、并行、失败重试、依赖 |
| 3 | API 插件与鉴权 | [x] 插件创建/工具/发布、API Key/Header、OpenAPI 3.0 导入；Runtime 支持 AKSK/APIKey/OAuth | [!] 未实测 | 插件调试成功后才能发布；账号权限与第三方 API 可达性待测 |
| 4 | 文件上传与存储 | [x] `AgentUploadFile` 单文件≤60MB；Runtime 需创建时开启文件上传下载，另有 ExecuteRuntimeUploadFiles | [!] 未实测 | 60MB 仅是特定上传 API 限制，不是全平台上限；Runtime 大小限制待逐项核实 |
| 5 | 人工暂停与恢复 | [!] 未找到持久化 pause/resume API 证据；提问器/输入/问答只证明单次运行内人工交互 | [!] 未实测 | 不能把问答节点写成完整 pause/resume/审批队列 |
| 6 | 发布与运行时调用 | [x] 版本/部署/渠道管理、网页/API/云商店；InvokeRuntime 路径与错误码 | [!] 未实测 | 首次部署选择认证方式；发布权限、外网访问、并发/超时待测 |
| 7 | 导入导出格式 | [x] AgentArts jsonl、Dify DSL yml，最大 128MB | [!] 未实测 | 知识库/自定义插件不自动迁移，模型需重选，部分节点不兼容 |
| 8 | 模型与区域 | [x] 预置 MaaS/自定义模型；默认 2,000,000 tokens 免费额度；SDK 示例区域 cn-southwest-2 | [!] 未实测 | 区域清单、账号权益、上下文长度待控制台验证 |
| 9 | 配额与费用 | [x] 体验版 20CU/1GB/2 成员/50 应用；超量按需；MaaS/AOM/APM/LTS/DEW 可能另计费 | [!] 未实测 | 套餐开放状态、CU 不按月重置、账单待验证 |
| 10 | 正式赛题提交限制 | [x] 评分与交付物已确认 | [!] 账号/报名相关待确认 | 初赛信息表；决赛 PPT/在线 Demo/设计/Skill-MCP/分享帖 |
| 11 | 观测与审计 | [x] 高代码提供日志/可观测；关联 AOM/APM/LTS | [!] 未实测 | 具体 trace 内容、导出与保留期待账号验证 |
| 12 | 数据与隐私 | [!] 未找到官方数据留存/训练使用条款结论 | [!] 未实测 | 上传真实企业资料前必须另行核实 |

## Adapter 边界

- 允许：离线 `AgentArtsAdapter` 按已确认的 `POST /runtimes/{runtime_name}/invocations` 构造 Authorization、`X-Invoke-Mode`、`x-hw-agentarts-session-id` 和 JSON 请求封套，并映射文档响应。Agent 的 `query` 与 Workflow 的 `inputs` 由调用方完整传入，不在 adapter 中猜变量名。
- 允许：健康检查返回 `agentarts=not_configured`、`evidence=documented_not_connected`。
- 边界：adapter 仅原样放入调用方提供的 `Authorization` 值并映射有限 JSON 响应；API Key/OAuth 等具体凭据值仍待账号验证。当前不实现 IAM/AK/SK 签名或 `X-Sdk-Content-Sha256: UNSIGNED-PAYLOAD` 条件头，也不含 HTTP transport、SSE、重试、文件上传或远端部署恢复；配置对象不会改变 health 状态。
- SDK 参考：固定 commit 的官方 SDK 同时提供高代码 Agent server/CLI 和 `RuntimeClient.invoke_agent`；后者含真实传输、会话、签名及 JSON/SSE 处理，可作为未来 transport/认证复用候选。本批只实现无 I/O payload 校验与有限 JSON 映射，故不引入 SDK 依赖。具体边界见 `docs/research/2026-10-19-phase6-offline-adapter.md`。
- 不允许：未配置账号时发起真实调用、把本地 mock 说成平台执行、把文档结论说成“真实已接入”。
- 真实接入判定：账号可调用、部署成功、至少一次真实 Runtime 请求返回可验证结果，且认证方式与区域确认。

## 账号实测清单（取得账号后）

- [ ] 创建并发布一个最小 Runtime，记录 runtime_name 与区域
- [ ] 用选定认证方式调用 `POST /runtimes/{runtime_name}/invocations`
- [ ] 验证 401 / 404 / 500 的真实响应结构
- [ ] 验证 session 头与多轮上下文
- [ ] 验证文件上传开关与大小限制
- [ ] 验证多 Agent 控制器与工作流节点
- [ ] 验证 pause/resume 是否原生支持
- [ ] 记录配额、费用与并发
- [ ] 核对部署后认证方式不可变更的限制

## 历史账号观察（2026-10-19；当前范围暂缓）

主控在约 12:19（Asia/Shanghai）通过 CUA 打开现有 tab 5，读取到华为云 AgentArts 登录页（标题“用户登录—华为云”，URL 位于 `auth.huaweicloud.com/authui/login.html`，目标控制台为 `console.huaweicloud.com/agentarts/`）。页面显示“欢迎使用华为云”“二维码已失效”，手机号、验证码输入框为空，并提供登录/注册入口。未登录控制台、账号权限不可见；未输入凭据、创建资源或调用付费模型/API。该观察只说明本次会话停留在登录页，不能据此判断平台是否支持相关能力。

同日约 12:21（Asia/Shanghai），主控通过 HTTP 读取 `http://127.0.0.1:8000/api/health`：`status=ok`、`execution_mode=local_demo`、AgentArts 为 `not_configured` / `documented_not_connected`，runtime 为 `local_mock`，`planning_mode=simulated_rules`。这是父级工具观察，本轮未自行请求该地址；已仅记录上述脱敏字段，未保存响应中其他信息。它证明当前本地服务健康且运行在模拟模式，不证明真实模型或 AgentArts 已接入。

原待验收清单保留用于后续范围恢复时参考；按用户最新指示，AgentArts账号登录、控制台点击、Runtime/部署验证和浏览器路径不纳入当前实施，也不作为当前软件目标的阻塞。未验证状态保持不变。

## 技术与合规风险

- 若平台不支持原生人工暂停，需要 Django 工作流保存状态并通过 API 恢复平台 Agent；需确认比赛是否接受混合编排。
- 若文件能力受限，交付物可由本地确定性程序生成，平台负责调度；须保留来源版本与审计。
- 若多 Agent 只能由单 Agent 多工具模拟，必须如实说明，不能作为“多 Agent 协作”实证。
- 平台文档与账号实测证据分别记录，不合并成“已验证”。

## 完成条件

- 12 项均有文档状态与账号状态。
- 研究中的项保持 `[-]`，未实测项保持 `[!]`。
- `docs/work-report.md` 的平台状态与本清单一致。
