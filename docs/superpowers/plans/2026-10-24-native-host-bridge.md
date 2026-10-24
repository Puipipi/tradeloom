# 原生 Host 子代理与工作流 HTTP 集成验证计划

## Goal

在隔离的 PostgreSQL 测试库中，以 pinned DSH `0.2.1-rc.2` Web Host 运行真实中心 Agent 和真实直接子 Agent；两者使用仅监听 loopback 的合成 Messages/SSE provider，并经现有受保护业务接口完成 native assignment、Host 子代理绑定和 typed advice 提交。验证 Django 确实保存回执，随后分别观察子 Agent terminal event、中心收到的 `subagent-settled` 通知和中心 turn 结束。

本验证是“真实 DSH Host/Agent 生命周期 + 合成 provider + 测试专用 HTTP authority resolver”。它不代表真实 DeepSeek/其他厂商模型、生产 LAN 拓扑、桌面 UI 或正式运行 profile 已通过。

## Architecture

- 保持 `WorkflowStep`、现有 attempt/idempotency/ref fencing、`_record_result`、人审和交付门禁为唯一业务执行依据；不新建 scheduler、业务模型或公网接口。
- Python `LiveServerTestCase` 提供隔离数据库和真实 Django loopback HTTP listener。它建立合成工作流、设置只在本次进程环境中的随机 native bridge key，并启动 Node Host 测试驱动。
- Vitest `.e2e.ts` 驱动通过 pinned `apps/web/tests/scaffold.ts` 的 `launchWebScaffold()` 启动真实 Web composition。真实 `scaffold.ctx`、`ctx.agents`、ToolRuntime、session、subagent activation 和 `send_message` 均保留；只用测试 package 将真实 `registerBusinessTools()` 的第三参数接到测试依赖注入点。测试文件的临时发现/导入方式须先通过下方入口前置验证。
- 测试 adapter 的 `authorityResolver` 只接受 Host 实际注入的 `ctx.webServer` 对象和其 loopback origin，将请求送到当前 Python LiveServer 的随机端口。它不可由工具参数、preset 配置、用户请求或环境外部输入选择。生产 `apply()` 的默认严格 authority 不改变。
- Node 驱动的本地 fake provider 只响应真实 Host 发出的 Anthropic Messages 请求。它检查真实工具 schema，并按中心/专家角色 marker 返回 tool-use 流；其工具输入只引用当前合成 workflow 与实际 begin/read 工具结果。服务监听 `127.0.0.1` 的随机端口，拒绝其他目标，不转发网络请求。
- Bridge key 由 Python 测试在内存生成，分别存在 Django 测试进程环境和 Node Host 子进程环境；仅 native POST 使用 `X-TradeLoom-Native-Bridge`。它不作为 CLI 参数、模型消息、provider 请求字段、测试日志或报告内容传递。fake provider 的 API key 也只是随机合成值。

## Tech Stack

- DSH `0.2.1-rc.2`，上游锁定提交 `687f282e8625c6b8d11ff58211a90524be2e4317`；只读来源为 `apps/web/tests/scaffold.ts`、`apps/web/tests/smoke-real.e2e.ts`、`apps/web/tests/official-subagent-bundle.e2e.ts`、`packages/subagent/tool-subagent/src/index.ts`、`packages/subagent/tool-subagent-control/src/index.ts`。
- Host 集成必须运行在发行包自带 Vitest 环境中。`scaffold.ts` 导入 `vitest` 的 `expect` 和 workspace 包，不能作为独立 Node 模块通过 `tsx` 加载；发行根实际安装 Vitest 4.1.11，`test:web:built` 调用 `vitest run --config vitest.web.config.ts`。该配置有两个 Web e2e/snapshot glob，另有 `packages/experimental/inspector/tests/client-browser.e2e.ts`。项目仓库外测试文件及项目 adapter 的加载仍待 preflight。
- Django `LiveServerTestCase`、已有 guarded PostgreSQL 17 测试集群 `127.0.0.1:55435`、每轮新建且唯一的 `tradeloom_test_*`。
- 已存在的 Node、pinned runtime、React/Host composition 和 Python 环境；不安装依赖。执行前需证明 Vitest driver 在受支持入口中能加载 scaffold、workspace imports 与项目侧测试 adapter。
- 现有业务实现：`packages/tradeloom-shell/business-tools.js`、`workbench/urls.py`、`workbench/api.py`、`workbench/workflows/orchestrator.py`。

### Vitest 测试入口前置验证（静态候选，尚未执行）

固定发行包的 `vitest.web.config.ts` 导出普通配置对象；其 `plugins`、`test.execArgv`、超时和串行设置可作为候选基础。项目侧临时配置可从该 pinned 配置导入并保留原插件；`root` 应继续指向 pinned release，使 `vite-tsconfig-paths` 的 `./tsconfig.base.json` 按已解析的 Vite root 定位。Vitest CLI 以 `config.dir || config.root` 作为测试 glob 的 cwd，并将匹配结果解析为绝对路径，因此外置单文件 include 在静态实现上有候选路径，但是否能被配置加载器发现并导入仍未验证。

`vitest/config` 导出 Vite `mergeConfig`，而该实现会拼接数组。故不能用 `mergeConfig(base, { test: { include: [probe] } })` 表示替换；候选做法是先合并必要的根/文件系统设置，再显式以新 `test` 对象替换 `include`，同时保留基础 `test` 的其他字段。Vite `server.fs.allow` 是目录访问限制配置，不自动证明外置模块解析或包依赖可用，也不能覆盖掉原有允许目录。

原配置导入有副作用：`vitest.web.config.ts` 会尝试 `process.loadEnvFile()` 读取发行根 `.env`。任何 preflight 必须先只检查该文件是否存在，不读取或输出内容；若存在，不导入该用户配置环境，应改在无用户 `.env` 的独立准备测试 runtime 验证。清理继承环境变量不能阻止配置重新读取 `.env`。发行包文件保持不变。

在运行真实 Host 前，实施期先做一个无 Host 启动的单文件探针：通过 pinned Vitest CLI 和项目侧配置仅发现指定探针，确认它使用 Vitest `expect`、能导入 `scaffold.ts` 的 workspace imports 与 TradeLoom adapter，且未收集原 Web/inspector 测试。测试文件传递/绝对 include、配置加载器的外置解析、原有插件和文件系统设置合并均须以该探针实测；adapter 的真实加载路径也仍未验证。`extraOverlayPath` 直接交给文件读取器，`extraInstallAnchors` 会在 scaffold 切换到临时 cwd 后读取清单，所以两者必须使用绝对路径。

若探针失败，停止 Host 集成并报告具体阻断及最小受支持接入方案；不得退回裸 Node/`tsx` 导入 scaffold，也不得修改 pinned release 的配置、manifest 或构建产物。当前只确认配置与 API 静态存在，不列可执行 RED/GREEN 命令，不声称入口通过。

### 角色访问范围

| Host 预设 | native begin | child bind | typed submit | read workflow |
| --- | --- | --- | --- | --- |
| `tradeloom-center` | 允许 | 允许 | 拒绝 | 允许 |
| `tradeloom-product` | 拒绝 | 拒绝 | 允许 | 允许 |
| `tradeloom-delivery` | 拒绝 | 拒绝 | 允许 | 允许 |

真实主链只需验证 center 与 product；delivery 是独立的 submit ACL 分支，只有专门覆盖其结果 schema 时才作为另一个角色场景。市场、询报价占位角色和用户资料演示角色不属于可运行的 native workflow 专家。本矩阵来自 `packages/tradeloom-shell/business-tools.js` 当前 `TOOL_ACCESS`（57–65 行），实现期间若 ACL 改动，须同步更新测试和矩阵。

## Spec

### 实际 API 与 Host 契约

1. 创建 root session 使用 Host Web RPC `session/create`，随后 `session/prompt` 的请求形状沿用 pinned `apps/web/tests/smoke-real.e2e.ts`：`{request:{requestId,sessionId,mode:'queue',content:[{type:'text',text}]}}`。测试驱动通过真实 Host RPC 传输，不直接调用模型工具执行函数。
2. root preset 为 `tradeloom-center`。中心模型先通过真实 `tradeloom_read_workflow_task` 或合成 prompt 中已有的 workflow/subtask 标识读取上下文，再调用 `tradeloom_begin_native_workflow_assignment`。Django API 路径为 `POST /api/workflow-tasks/{workflow_id}/subtasks/{subtask_id}/native-assignment`；真实工具先走已有 CSRF bootstrap，再携带 bridge header。
3. 只有 begin HTTP 返回可 spawn 的已持久化 assignment 后，中心才调用 DSH `subagent` 工具。Pinned `packages/subagent/tool-subagent/src/index.ts` 的真实 activation 返回 `{kind:'activation', subagentId}`，不等待 child 完成。
4. 中心用该真实 `subagentId` 调 `tradeloom_bind_native_workflow_expert`；工具从 `exec.agent` 与 `ctx.agents.get(childId)` 获取现场身份，Django 路径为 `POST /api/workflow-tasks/{workflow_id}/native-assignments/{assignment_id}/bind`。测试还核对 child preset、parent agent id 和 `delegationDepth === 1`。
5. bind 成功后，中心才用 pinned `send_message` 工具发送消息，其真实参数是 `{agent_id, message}`。消息只含 workflow/task/batch/subtask/assignment/step 标识、begin 返回的受限 `advice_context` 和允许的有限来源引用；不得含 bridge key、模型凭据或原始私密文件内容。
6. child 经真实 `tradeloom_read_workflow_task` 检查自身 workflow 和来源，再按 begin context 组装 `native-expert-advice.v1`，调用 `tradeloom_submit_native_workflow_advice`。提交 API 为 `POST /api/workflow-tasks/{workflow_id}/native-assignments/{assignment_id}/submit`；child 身份只从真实 ToolRuntime `exec` 获取。Django 对合成建议返回 `status=accepted`、`execution_mode=native_dsh`、`provider/model=unknown`，WorkflowStep 保存 `accepted_not_settled` 的 native submission marker。
7. Host event 必须分别证明：HTTP 接受和 WorkflowStep 落库；child session 的 `turn/end`；中心收到 `user/message` 且 `source.kind === 'subagent-settled'`、sender 对应真实 child session；中心最终 `turn/end`。`send_message` 的 delivery confirmation、Django accepted 回执、child settled、中心完成是四个不同观察点，不能互相替代。

### 新增测试范围

- `workbench/tests/test_native_workflow_host_e2e.py`：继承 `LiveServerTestCase`；核对当前 DB 名为本次独有 `tradeloom_test_*`；使用现有 native bridge 测试中的合成 Task/ProductRevision/WorkflowTask 构造方式创建一条 `native_dsh` 工作流；设置 `ALLOWED_HOSTS`/CSRF 为测试 loopback；仅将随机 64 位 hex key 放进当前测试进程及子进程环境；启动 Node harness；最后从 ORM 只读验证 WorkflowStep、receipt、native marker、provider/model unknown 和 task 状态。不能直接把 step 改 completed 或伪造 Host 身份。
- `packages/tradeloom-shell/tests/native-workflow-host-e2e.e2e.ts`：计划中的长期 Host 集成测试源；只有上述单文件探针通过后才建立。它将配置明确的 center/product presets 和仅测试安装的 adapter；启动随机 loopback fake Messages/SSE server；用真实 Host RPC 创建 session/prompt；在真实 `scaffold.ctx` 上跟踪 agent/session/event；按真实 tool schemas 驱动 begin → `subagent` → bind → `send_message` → child read → submit。所有 server、Host、WebScaffold、profile、临时 workspace/harness home 均在 `try/finally` 关闭。
- `packages/tradeloom-shell/tests/fixtures/native-host-business-tools/package.json` 与 `host.js`：最小仅测试 Cordis 插件，导入生产 `registerBusinessTools()`，注入实际 `tools/webServer/agents` 和经核验的内部依赖对象。resolver 必须校验 `webServer === ctx.webServer`、其 scheme/hostname 为 loopback，且仅指向当前 LiveServer 端口；其他值拒绝。fixture 为 center/product 注册对应 preset；只有单独覆盖 delivery ACL 时才注册 delivery，不把 placeholder/demo preset 当作执行角色。
- 项目外现有 private guarded runner：只为精确标签 `workbench.tests.test_native_workflow_host_e2e` 增加同等严格的固定路径分支。复用现有 `candidate8Root` 与 `candidate8NodeExecutable`，Web 根固定派生为 `candidate8Root/apps/web`；仅在 private runner 配置增加一个经 external-sibling 校验的 `nativeHostE2eRoot`，按每次 run 建独立子目录。runner 只为该精确标签注入 `TRADELOOM_NATIVE_HOST_E2E_ROOT`、`TRADELOOM_NATIVE_HOST_NODE_EXE`、`TRADELOOM_NATIVE_HOST_RUNTIME_ROOT`、`TRADELOOM_NATIVE_HOST_WEB_ROOT`；不接受调用者自选 runtime/data root、数据库端口、owner marker 或测试 DB 之外的 env 覆盖。原有 PG owner、唯一 DB、无 reparse point、产品根验证保持不变。

## Global Constraints

- 仅使用新的 `tradeloom_test_<唯一后缀>`；不得连接业务 PostgreSQL `55432`，不得启动/停止/改动 PG 服务，不迁移业务库。
- Node 子进程清空继承环境后，显式设置独立 `DSH_HOME`/agents home、`DSH_SNAPSHOT=record`、fake `DEEPSEEK_API_KEY`、指向随机 loopback Messages server 的 `DEEPSEEK_BASE_URL`，以及测试 bridge key。搜索、浏览、工具网络代理及任何外部 provider 均禁用；运行前核对 fake server 是唯一允许的模型请求接收端。
- 不在日志、工具输入、用户文本、assistant system prompt、session metadata、model/provider DTO、URL、命令行参数或测试报告写 bridge key。测试日志只记录阶段名、HTTP status、fixture 计数和测试库标识，不输出完整请求或来源值。
- Workflow/Task/Product/Revision/TaskFile 仅使用带 `Synthetic` 标记的测试数据；断言不触发真实 ERP、真实文件导入、用户资料或付费模型。
- 外层 test root 必须位于仓库外的已忽略私有测试目录；每次使用独立子目录。只允许 teardown 删除该次通过绝对路径和 reparse 检查创建的 fixture root；不得清理 PG data、旧 run、profile、用户目录或运行时。
- 本验证不运行 GUI、不是 production profile 的 plugin boot 验收，也不证明厂商服务、真实 provider/model 选择、DSH 插件恶意隔离或正式 LAN trust。真实 Host生命周期通过的是 pinned WebScaffold 的隔离 composition。

## 实施与验证步骤

### 1. 给真实 Host E2E 建立受控 runner 入口

- [ ] 先完成上面的 Vitest 入口前置验证。之后才扩展项目外 private guarded runner 的 exact-label allowlist，仅认可 `workbench.tests.test_native_workflow_host_e2e`。为该标签从 runner 固定 candidate8 配置派生 Node 可执行文件、Web app 根目录和外置 temp root；逐一验证路径位于 pinned release、普通文件/目录且非 reparse point。不给调用者追加任意运行时路径。
- [ ] 使用 `check`/guard 命令验证运行时 root、PG owner marker、PG 17、端口 `55435`、role、base DB 和专用 test DB guard；这一步只检查，不启动服务。
- [ ] 新模块尚不存在时，在入口验证通过后用既有 guarded runner 的精确标签执行 `workbench.tests.test_native_workflow_bridge` 基线，使用全新唯一 `tradeloom_test_*`。此计划不假定私有 runner 的路径、参数或 exact-label 配置已经存在；实施时先核对并记录真实 runner 接口，未通过路径/DB owner 检查即停止。

### 2. 先写真实链路 RED

- [ ] 添加 `test_native_workflow_host_e2e.py` 和 Vitest `.e2e.ts` harness 的最小单场景：测试数据只在独立 PostgreSQL 创建；通过已由探针验证的 pinned Web Vitest 配置加载真实 scaffold 和工具/agent context；provider 先仅返回一次中心 begin tool-use。测试 harness 源码长期留在 TradeLoom 仓库；不得从裸 Node 导入 scaffold，也不从 repo/global node_modules 解析 DSH。
- [ ] 初版故意不注入 authority resolver。预期工具在发出 Native POST 前因 loopback Host authority 不符合生产 allowlist 而以 `business_authority_unavailable` 拒绝，Django 未收到该 POST，因此没有 native assignment、绑定或 activation；workflow fixture 在该尝试前创建的普通 `WorkflowStep` 基线允许存在，断言应比较 baseline 并确认没有新增 native assignment step/副作用，而不是断言数据库中没有任何 `WorkflowStep`。把 RED 的私有日志保存在外部测试 run 目录；不输出 bridge key 或完整请求。
- [ ] Vitest 入口和 exact-label runner 验证通过前，不执行或记述 RED/GREEN 命令。验证通过后，runner 命令须从其实际 `--help`/源码接口生成并记录，不复用已有 test DB 名，也不得把静态候选误写成 `test:web:built` 已能发现外部测试文件。

### 3. 加测试专用 Cordis adapter 与动态合成 provider

- [ ] adapter 从生产模块导入 `registerBusinessTools()`；仅由真实 Host preset plugin load 调用，透传真实 Cordis `ctx`。resolver 接受 actual `ctx.webServer`，并只将该 Host loopback authority 路由到 Python LiveServer 的随机端口；生产 `apply()` 及默认 `authority()` 保持原样。
- [ ] Python 将 key 用 `os.environ` 临时设置，启动 Node 时通过明确的子进程 `env` 传递；恢复旧环境值的代码必须位于 `finally`。Node 不把 key放到 argv、profile、`extraOverlayPath`、session prompt 或 provider request。
- [ ] fake provider 监听随机 `127.0.0.1` 端口，只接收 DeepSeek-compatible `/messages` 请求。用已核验的 Messages streaming 帧构造器发工具流；每次请求验证 target host、路径、fake API-key，并拒绝未知模型角色/阶段。动态 tool input 取自当轮真实 Host tool schema、begin tool result 和 child 的 read-workflow tool result；禁止手抄 child id、assignment id 或伪造 source refs。
- [ ] 主链配置 center 与 product 两个 preset：中心使用真实 `subagent` + `send_message`，product child 使用真实 read + native submit 工具。仅在独立覆盖 delivery ACL 时启用 delivery preset。所有 preset 的 business tools ACL 仍通过 `exec.agent.session.header.agentPreset`；任何工具 args 中伪造的身份不得影响实际调用身份。

### 4. GREEN：完整真实 Host→Django→child 生命周期

- [ ] 将唯一新增差异设为测试 adapter 的 resolver，重复运行相同 scenario。成功序列严格为：中心 session/prompt → begin HTTP 持久化 → 真实 `subagent` activation 返回 `subagentId` → `ctx.agents.get(subagentId)` 校验 live preset/parent/depth → bind HTTP → 真实 `send_message({agent_id:subagentId,message})` → child 调用 read-workflow → child submit HTTP → accepted frozen receipt。
- [ ] provider 的 child 最终答复先 hold。收到 child submit 后，在 fake provider 完成 child turn 之前，从本机 Django GET 只读确认 WorkflowStep 已接受；同时断言 child 尚无 settled event。然后释放 provider response，分别观察 child session `turn/end`、中心 `subagent-settled`（sender 对应 child session）、中心最后 `turn/end`。该顺序证明 callback/HTTP accepted 不等于 child 已结束。
- [ ] Python 数据库最终只读断言：一条正确 WorkflowStep/assignment、一次 native accepted receipt、角色和 source refs 均对应该合成 workflow、provider/model 保持 `unknown`、`accepted_not_settled` 没被误写成生命周期结束。Node 报告只回传安全阶段计数；不得打印环境、URL session token、body 或 key。
- [ ] 入口验证与 exact-label runner 实际实现后，用新唯一 PostgreSQL 测试库执行 GREEN。保留真实 HTTP status 和 event 顺序断言，不用 mock Host/context、fake `ctx.agents`、直接改 WorkflowStep 或 MockAgentRuntime；测试数、skip 与命令以实际运行输出为准，本计划不预报。

### 5. 回放及失败边界复核

- [ ] 在同一真实 Host 测试流程中重复 begin 的同一 attempt/idempotency key，断言返回已有 assignment 且 `spawn_allowed=false`，provider 的 `subagent` activation 次数仍为 1；不要因 HTTP tool callback 再 spawn。
- [ ] 将无 bridge key、错误 bridge key及工具 args 中伪造的 agent/preset/parent/depth 作为隔离负向回归。缺/错 key 断言 403；身份只由真实 Host child fixture决定。复用现有 `test_native_workflow_bridge.py` 对错误 parent/preset/depth、late step、unknown、same-key replay 的覆盖，不重复构造另一套业务 validator。
- [ ] fake provider 在 begin 前的外网尝试必须零次；工作流遇到已存在 unknown/blocked 回执时，断言中心没有第二次 subagent activation，并以受控错误结束，不 fallback 到 `local_mock`。

### 6. 完成和复核

- [ ] 运行新 Host E2E 与既有 targeted `workbench.tests.test_native_workflow_bridge`，复核 runner 每条命令对应本次 worktree HEAD、隔离 DB 名和输出退出码。
- [ ] 检查新增 adapter 的 `package.json`/Cordis 插件注册只有测试包范围；对 key 不出现在 argv、provider request、session event、logger 和 persisted profile 的断言逐项确认。
- [ ] 所有 `try/finally` 确保 Python 子进程、Messages server、WebScaffold、ctx fiber/session listeners、profile 临时目录及 external test root均在本次根目录内关闭/清理。异常时保留最小脱敏失败阶段和 event order，不循环重启。
- [ ] 报告仅称“pinned WebScaffold 合成provider集成通过”。真实 Desktop GUI、真实供应商模型、真实用户资料、正式 LAN 端到端和生产进程启动仍须另外验收。

## 自检

- 本计划引用的 Host 接口都来自 pinned `0.2.1-rc.2`：`WebScaffold.ctx/hostFetch/whenTurnSettled`、`launchWebScaffold()`、`session/create`/`session/prompt`、`ctx.agents.get()`、`ctx.subagents.startActivation()`、`subagentId` 返回字段、`send_message` 的 `agent_id/message`、`subagent-settled` 和 `turn/end` 事件。`scaffold.ts` 属于 Vitest 测试模块；没有通过裸 Node/`tsx` 导入的依据。
- 发行根 `test:web:built` / `vitest.web.config.ts` 是静态确认的测试 lane。项目侧配置导入、绝对单文件 include、外置 adapter 解析和 fileserver allow 合并仍待探针实测；这段候选路径尚未执行，也不是测试通过证据。
- 生产 runtime/Host adapter/业务 schema/数据库模型均不在该计划的实现范围；唯一 HTTP resolver 变化属于已批准的测试注入，不进入模型 DTO 或生产配置。
