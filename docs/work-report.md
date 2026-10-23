# 织贸助手（TradeWeave）开发工作报告

## source-web 启动记录（2026-10-19）

### 当前阶段

- [x] Windows source-web 本机启动流程当时已验证；smoke-5 记录的 wrapper PID 58024、Node/DSH PID 53340、Python/Django PID 10820、PostgreSQL PID 53672 是该次运行记录，不代表当前仍存活。安装包与业务隔离演示状态见下方 2026-10-20 八字段报告。

### 已完成

- [x] `env-preflight.json` 确认 `envVariableAbsent=true`，在真正 unset `TRADELOOM_DB_PASSWORD` 的情况下由 launcher 缺省密码文件路径启动成功。
- [x] 5 个业务页面对 backend trusted Host 请求均返回 HTTP 200；截至 `10:04:52Z` 最新日志无 entry/import failure，默认浏览器打开请求已发起。这些结果证明本机启动和 HTTP 可达，不证明 UI 已验收。
- [x] Native MockAdapter 四路径组合：4 pass、3 skip。实际覆盖 Cordis/SessionController/Tools 与 MockAdapter；不含真实 provider 或完整 Host GUI，也不证明暖 child 已映射到 B 后 claim 旧 A 的强交错。

### 未完成

- [ ] 真实 provider/model 调用、完整 Host GUI/界面验收、已登录代理业务操作、实体手机访问和 installer 仍未验收；业务执行路径为 Django `local_mock`/`simulated_rules`。

### 测试结果

- [x] Native command execution `exec-f46b5be6-a701-4691-98f2-397c5c979f31` 数值 exitCode 0，4 pass、3 skip；smoke-5 的 env preflight、5 页 HTTP 结果与进程状态由主控独立核实。此历史批次未重跑代码测试。

### 运行方式

- [x] 仓库根 PowerShell 运行 `scripts/start-postgres.ps1 -Port 55432`，再运行 `scripts/launch-tradeloom.ps1 -Mode web -DataRoot <绝对数据根>`；停止用相同数据根运行 `scripts/stop-tradeloom.ps1`。缺省密码只从 `%LOCALAPPDATA%\PostgreSQL\tradeloom\superuser-password.txt` 读入本次 Node 子进程；DSH 子进程沿用既有过滤规则。

### 平台状态

- [x] smoke-5 下 DSH 绑定所选私网（原 IP 已脱敏） `:3088`，Django 仅监听 `127.0.0.1:3090`，PostgreSQL 使用专属本地实例。运行标识与端口均来自主控核实的外部证据，本轮未操作服务。

### 风险与问题

- [-] 浏览器自动打开不是界面验收；Codex IAB 使用独立 cookie 状态，401 不能代表用户浏览器登录或代理行为。HTTP 200 只证明所测页面请求可达。
- [-] smoke-4 的历史失败由 wrapper .NET 清变量后留下空字符串引起（`Test-Path Env:TRADELOOM_DB_PASSWORD=true`、值非 null），导致当时走显式空值分支；它不是产品缺省密码读取故障。smoke-5 的 `envVariableAbsent=true` 已通过该复现边界；smoke-4 失败证据仍保留。

### 下一步

- [ ] 在用户实际浏览器验收页面与业务流程；配置产品自己的 provider 后单独做真实模型验收；后续完成安装包、完整 GUI、已登录代理和实体手机验收。长期目标尚未完成。
## 历史阶段快照（更新前）

本节及后续旧批次记录保留当时的状态和结论；当前入口与验收状态以本文最新八字段记录及 `docs/acceptance-matrix.md` 为准。

Task 1–3 的源码、renderer、受控 MockAdapter 与 Django 数据库回归证据均保留如下历史记录；真实 provider API、GUI、DSH→Django 浏览器回路仍待运行时验收。当前候选已提升为 `0.2.1-rc.2-tradeloom-desktop-2`，两项 replacement patch 已合入并通过本地目标测试；desktop-2 尚未完成构建。外部 r1 runtime 准备/安装 exit 0，但 `build:lib` exit 2（`apps/desktop/src/main.ts:728` TS2322；`apps/desktop/tests/web-document.spec.ts` EOF TS1005），因此 r1 未运行 web/desktop build 或生成 receipt。原始证据见 `LOCAL_RUNTIME_EVIDENCE/desktop-compile-1`；replacement artifact 修正后的 r2 需重新构建验证。launcher 与八项 pinned patch lifecycle 的当前结果见测试章节。新增 DSH 原生业务 API 工具适配源码与本地 HTTP fixture；尚未启动真实 DSH、Django、Electron GUI 或 installer。

## 已完成

- 上游只读来源为 `EXTERNAL_REFERENCES/deepseek-harness`，HEAD `687f282e8625c6b8d11ff58211a90524be2e4317`，版本 `0.2.1-rc.2`。Task 1 两份 slot patch、锁文件和隔离 runtime 生命周期源码已在仓库；Task 2 另增 reasoning-hidden renderer patch。
- Task 1 新增 `shell.top` 与 `sidebar.agents`；原生 workspaces/chat 保持。经主控核验，生命周期套件 9/9、patched `build:lib` 和 `build:web` exit 0，布局 Vitest 三文件 68/68。
- DSH Host 公开接口已核实：`connection.requestRejection(req)`、`workspaceRegistry.list/create`、`sessionController.create`；Client 使用原生 `uiWorkspace.openSession`。`uiWorkspace` 未公开当前会话选择读取器，因此启动不强制跳转；registry 默认 preset 为中心，原生恢复和 New Session 流程得以保留。Task 2 复合插件、角色、受保护 Host routes、显式 apphome JSON 状态/预算策略和导航 client 已写入 `packages/tradeloom-shell/`。用户资料演示角色通过仅该 preset 加载的只读工具取得当前可编辑资料。
- 用户资料角色使用专属只读工具动态读取可编辑的演示资料；提示要求仅依据工具结果、空字段向用户补充，不猜身份。演示初始值由 apphome state 提供；市场和询报价保持占位。中心仅用 DSH 原生 subagent/send_message，预算现按每个人类 RPC 最多 4 次委派、16 次消息尝试计数，超限仍调用 Host Agent API 终止当前 execution 并保留 inbox；24 step/轮及深度/并发 1/4 不变。旧 session-id 预算历史保留，新归属映射在现有原子 state store 持久化；专家不加载委派或业务写工具。
- 私有推理隐藏方案已确定为部署策略 patch：业务副本固定 `ChatPresentationPolicy.reasoningVisibility='hidden'`，`ReasoningRow` hidden 时不渲染推理内容，保留 visible 分支及普通状态、回答、工具行。patch 已写入仓库；JSX 修正、verbose policy 覆盖与 SHA 同步完成，lifecycle 9/9、renderer `build:lib:client` 和指定五文件 Vitest 113/113 均已通过。
- 组合插件显式注册 Host entry，registry 默认中心并禁用 `standard`、`ptc`、`minimal`、`cordis` 四个预置声明；六个业务 preset 各自启用 24 步/轮门禁。状态 store 按 canonical 路径使用进程内 Promise 队列及原子 rename；不依赖可能遗留的磁盘锁。左侧 Agent 入口样式保持中性，顶部业务页选中态依据公开 `layout.panelInfo`。
- Task 2 native runtime 受控 MockAdapter 集成经主控验收 4/4：真实 SessionController、Loader、Tools/runtime 装配，两个 preset 子 Agent、资料工具读取/结算及 parent 汇总、budget overflow cancellation 与 24-step gate。真实 provider API、真实 DeepSeek 模型和 GUI 仍未验收；证据 `EXTERNAL_RUNTIME/tradeloom-harness/evidence/native-integration-2/summary.md`，review artifact 位于 `LOCAL_EVIDENCE/dsh-task2-native-integration-artifact-rev4`。
- 设计固定 DSH `:3088`、Django `127.0.0.1:3090`；不新增 Django auth/owner/team/schema，不接管现有 DSH。
- Task 3 在 `packages/tradeloom-shell/` 将五个业务菜单接到现有 Django 页面 iframe，并增加四个固定代理别名。代理在读取请求体前执行 DSH `requestRejection`，只转发 Django CSRF cookie，固定访问 loopback `3090`，按流保留上传、下载、range 和响应状态等语义；DSH 原生 `/api/*` 与 `/api/remote.mux` 未被代理接管。
- Task 3 的 Django embed 开关默认关闭，仅用于未来专用 `3090` 进程；页面内链接、表单、API、静态/媒体 URL、预览和下载 DTO 使用集中 URL helper。embed 时隐藏重复导航、将 Django 主布局切换为单栏并使用同源 frame policy；普通布局与 8000 默认配置保持原样。页面源码还未在真实浏览器/运行实例中验收。
- 修复五个自有 Cordis 插件的 export namespace：移除折叠 named `inject` 的 default export。新增测试通过 pinned compiled Cordis Loader 的真实 `unwrapExports` 验证五个模块的命名空间与注入契约。
- Task 6 为中心、商品、交付 preset 注册原生工具；Cordis config 显式过滤注册集合：center 5、product 1、delivery 2，缺失/未知 config 不注册工具，执行时继续按 preset 复核。Pinned ToolRuntime scoped registry 源码与测试确认重复名称允许存在不同 agent scope、同一 scope 内拒绝重复；scoped context 继承 Host 依赖，`webServer` 是已有 Host 服务。工具固定访问 Django `127.0.0.1:3090`，Host/Origin 使用本实例可信 LAN `:3088`；POST 先获取 CSRF cookie，绝不转发 Authorization/native token。preview 使用固定 DTO 丢弃 `confirmation_token`，提示人工到 Agent 中心确认；工具没有正式任务创建或审核/apply 提交能力。
- workflow API 详情现在额外提供仅含 `subtask_id`、server-selected `idempotency_key` 与 `blocked_reason` 的 `dispatch_target`。页面和 API 共用原有依赖/审核/恢复键推导；工具先重新读取该 DTO，只有服务器当前选中的 subtask 才 dispatch，确保人工 apply 后用正确恢复键，不暴露 `resume_authority`。
- 预算归属由已审 artifact `policy.js` 修复：按实际 `UserMessage.source.rpcId` 分配 human-RPC scope；持久化待消费 inbox message id 的归属快照，防止旧子 Agent 回包借用后续请求预算；`subagent/start` 先同步保留 pending scope，首个 child turn 等待持久化，歧义来源 fail closed。每 scope 保持 4/16 限额与超限取消，既有 24-step gate 与原子 state store 未改，历史旧预算保留。

## 未完成

- sidebar fixture、patch lock 与 11 个既有上游 targets 已合入/登记；renderer patch lifecycle、client 编译及五文件 Vitest 验证已通过。受控 MockAdapter 集成通过，但真实 provider API/GUI 尚未验收。
- Task 3 的真实 DSH iframe、代理访问实际 Django `3090`、跨页面业务工作流和浏览器布局尚未运行验收。
- Task 4 的安装版 bootstrap、receipt writer、owned stage 与 builder metadata 已在产品源码和隔离夹具接线验证；仍需后续专属 builder 在授权的 owned runtime 中应用补丁、编译并写入真实 receipt，之后才能验证安装版。Task 5 升级与实机验收未开始。上游卸载 helper 把 `DSH_HOME` 作为受保护根目录参数，清理目标由独立 appId、产品名与包名派生；`DSH_HOME` 不是删除目标。
- 手机入口 artifact 的 host/client 与测试已合入产品 bundle；本包 Node 测试为 25 pass、0 fail、3 skip（两个跳过项依赖外部 pinned runtime，另一个 composer 需显式 fixture）。手机实机仍未验收。未做 DSH 安装/启动、真实 provider/subagent 会话或 Electron 安装验收。
- 新增业务工具已接入现有 Django DTO，但还未在真实原生 DSH 会话中调用；业务执行路径仍是 Django `local_mock`/`simulated_rules`，不是 provider 或生产业务模型运行时。
- 预算归属首次产品验证曾失败：中心 preset 下普通 scoped `subagent/start` observer 未收到由 `scopeTarget(parent)` 发出的生命周期事件，后续调用被拒绝且未触发 native cancel。当前最小产品修正已把唯一 policy 安装移至 Host root、将生命周期 hooks 设为 global，并在全局 start observer 中按已注册 child 的 `parentSession` 精确归属；外部 preset 在触碰 state store 前直接 passthrough。算法限额、原子 store 与既有 24-step gate 未改。定向 shell/hook 测试已覆盖这些边界；完整产品 native 组合复验仍待独立验证，不能视为 native integration 通过。

## 测试结果

- Task 1：`python -m unittest scripts.dsh.tests.test_patch_lifecycle -v`，9/9，exit 0；原始证据在 `LOCAL_EVIDENCE/dsh-slot-patches`。
- Task 1 旧 slots-1 patched release 的历史结果：当时 `build:lib`、`build:web` 均 exit 0；布局 Vitest 三文件 68/68。该历史成功仅对应旧 slots-1 release，不能代表当前 desktop-2 candidate 的编译结果。builder 的只读 fixture patch 已由主控复核并合入仓库版本化 patch。
- Task 2 `node --test packages/tradeloom-shell/tests/*.test.js` 为 16/16，exit 0。运行时使用既有编译产物的官方 `loadProfile('app','web',...)` 与 `composeEntries` 实际组合 profile 两层和产品 overlay，核实六业务 preset、中心默认值、四个内置 coding preset 禁用、无重复 id，并验证用户资料提示/工具归属；官方 `ToolRuntime.prototype.register` 实际接受有效 schema、拒绝非法 schema且不执行插入。原始日志 `task2-node-tests-run8.log` 和命令/exit 记录 `task2-node-tests-run8-command-exit.txt` 在 `LOCAL_EVIDENCE/dsh-composite-shell`；exit 由主控核验的原生 command output `exec-8d721f01-d6a9-4921-bcea-93f0a739097b` 导出，未重跑。renderer 验证日志及五文件清单见 `LOCAL_RUNTIME_EVIDENCE/native-integration-1\summary.md`：`build:lib:client` exit 0，Vitest 113/113。renderer patch lifecycle 为 9/9，110.094s，exit 0；三份 patch hashes 与 lock 匹配、11 个 pinned targets 均存在。自有插件及三份 patch/lock 的 SHA-256 清单：`LOCAL_EVIDENCE/dsh-composite-shell\source-hash-manifest-task2.txt`。修改涉及 JS `node --check` exit 0，证据为 `task2-node-syntax-run5.log` / `task2-node-syntax-run5-exit.txt`。这些源码/renderer测试不等同于真实模型 Agent 工具回路验收。
- Task 2 native runtime 受控 MockAdapter 集成：主控验收 4/4，真实 SessionController/Loader/Tools/runtime 装配，两个 preset 子 Agent，资料 tool 读取、子 Agent 两次 settlement 和 parent 汇总、budget-5 cancellation、24-step gate。预算断言按 runtime `listChildren` 与 parent catalog 为空的情形另有定向 1 pass、3 skip，已由主控审阅。非真实 DeepSeek API/模型或 GUI 验收；证据见 `EXTERNAL_RUNTIME/tradeloom-harness/evidence/native-integration-2/summary.md`，不可移植测试入口的 review artifact 为 `LOCAL_EVIDENCE/dsh-task2-native-integration-artifact-rev4`。
- 当前 patch/renderer lifecycle `python -m unittest scripts.dsh.tests.test_patch_lifecycle -v`：9/9，exit 0，110.094s；日志 `task2-patch-lifecycle-run4.log` 和 `task2-patch-lifecycle-run4-exit.txt` 在同一证据目录。三份 patch 哈希匹配 `patches.lock.json`，11 个 pinned source targets 均存在。生命周期测试不替代 client TypeScript/Vitest 编译验证。
- 首轮 8 项测试曾因 Windows file URL 路径拼接失败；修正测试路径后通过，失败日志保留。patched release 先前发现一个生成 manifest 含 NUL，后经同版本依赖缓存校验恢复；损坏原因未知，修复后 build 通过，原始日志保留。
- Task 3 Django 数据库回归：恢复既有 app-owned PostgreSQL 17 后，固定解释器执行 `manage.py test workbench.tests.test_business_embed workbench.tests.test_pages --keepdb --noinput --verbosity 2`，19/19 exit 0（7 个 embed SimpleTestCase + 12 个 DB-backed PageTests），日志 `django-page-regression-run2.log`。连接身份通过只读查询核实为 `tradeloom_dev`/55432；测试 runner 使用 `tradeloom_test_dsh_business_embed`，仅在隔离测试库应用 migrations，并保留该库。命令和环境身份记录在 `django-page-regression-run2-command.txt`。更早一次 run7 曾因无输出中止、exit unavailable，原始日志/context 保留，不作为通过证据。
- Task 3 Node 代理/URL/壳合同：设置 `TRADELOOM_CORDIS_LOADER_LIBRARY` 指向 pinned compiled Loader 后执行三个测试文件，22 pass、0 fail、2 skip，exit 0。真实 Cordis Loader `unwrapExports` 测试未 skip，并验证五个自有插件命名空间。日志 `node-integrated-run5.log`。Task 2 delegation isolate 更新后的官方 composer 单项使用 pinned source、compiled app-boot/include 库和 runtime CLI install anchor 重跑，1/1 pass、0 skip、exit 0（`cordis-composer-run2.log`）。URL 根路径及已映射 alias/query/fragment 定向测试 `business-url.test.js` 2/2 exit 0。官方 compiled WebServer 路由匹配合同最新重跑 4/4、0 skip、exit 0（`dsh-webserver-contract-run2.log`）；代理 loopback fixture 5/5 exit 0（`node-embed-url-proxy-run4.log`）。
- Task 6 原生工具定向 Node 测试 `node --test packages/tradeloom-shell/tests/business-tools.test.js`：9/9 通过；覆盖中心/商品/交付注册集合与未知 config fail-closed、固定 method/path、可信 LAN Host/Origin、CSRF 获取与转发、执行时角色拒绝、未知 URL 字段拒绝、预览 token 不泄露、dispatch 复用 server-selected resume key、错误 HTML/凭据不泄露，以及 native `exec.signal` 取消和有限 30 秒 HTTP 超时（fixture 注入短时限）。该 HTTP 是独立本地 fixture，不是真实 Django 或原生 DSH E2E。Django dispatch helper 有 SimpleTestCase 覆盖，未连接数据库。Node 语法检查与 Python `compileall` 通过。日志见 `LOCAL_EVIDENCE/dsh-business-tools`。
- Task 6 合并 budget-epoch artifact 后执行产品 shell targeted suite：`node --test packages/tradeloom-shell/tests/*.test.js` 为 47 pass、0 fail、3 skip；跳过项依赖 pinned WebServer/Loader/profile composer compiled fixture。新增 artifact 13 项真实文件系统和 hook mock 测试均通过；既有直接预算测试改用 human-RPC scope 保持原门禁意图。未加载 pinned Harness 编译库或启动真实 DSH/provider。日志见 `LOCAL_EVIDENCE/dsh-business-tools`。
- Native policy 诊断 artifact 的 Host-root 变体在 pinned runtime + `MockAdapter` 下通过：cancel5 与 cancel17 保留 `keepInbox:true`，三个 RPC / 六次 delegation 分桶。较早 RPC6 失败由 fixture 在中心 assistant summary/driver 完成前提前发下一 RPC 引起；稳定边界已补等待。warm-child interleaving 只证明 A settlement 入队早于 B、旧 A 消息解析仍使用 A scope；未证明 child 映射已经切到 B 后旧 A claim 的更强场景。以上均是独立诊断 MockAdapter 证据，不是产品 native 通过。本次产品代码没有复制诊断导出或 trace/push/snapshot 诊断能力。
- 本次产品 clean policy 定向测试 `node --test packages/tradeloom-shell/tests/budget-epochs.test.js` 为 16/16 pass，覆盖 Host-root global hooks、foreign preset 零 state-store 访问、跨 parent start 隔离、Agent ID 重用时 dispose identity guard，以及既有 4/16 预算、pending reservation、inbox snapshot/24-step 关联契约。Host 加载只验证 Cordis 静态配置与本地插件 apply fixture；完整产品 native 组合复验仍 pending。
- 本次更改后完整产品 shell suite `node --test packages/tradeloom-shell/tests/*.test.js` 为 51 pass、0 fail、3 skip，exit 0；跳过项仍依赖 pinned WebServer/Loader/profile composer compiled fixture。证据 `LOCAL_EVIDENCE/dsh-business-tools\native-budget-host-root-shell.log`。初次运行因 mobile-link 测试 fixture 未提供新增的 Host `on`/`agents`/`tools` 注入而失败；补齐 fixture 后整套通过，首次日志另存 `native-budget-host-root-shell-attempt1-failure.log`。五个相关 JS 文件 `node --check` 与 `git diff --check` 均 exit 0。
- Task 6 新增 Django `SimpleTestCase` 使用项目专用解释器逐项运行：3/3 pass，覆盖服务端 resume key 推导、未解决人工审核拦截，以及 workflow API 只返回 dispatch DTO；没有连接数据库。工作区旧 `.venv` 不含 Django，未安装依赖；实际验证使用已登记 TradeLoom Python runtime。

## 运行方式

本阶段测试仍使用现有 app-owned PostgreSQL 17 开发集群（`127.0.0.1:55432`，PID 2612）、临时 loopback HTTP fixture 和 budget filesystem fixture。外部隔离 compiler 已对 desktop-2 执行官方 runtime prepare、install、`build:lib`、`build:web`、`build:desktop` 与定向 Vitest；这不包括启动真实 Django、DSH、模型 API、Electron GUI 或安装器。

## 平台状态

固定上游、MIT license 与当前八项 patch hashes 已锁定。当前候选为 `0.2.1-rc.2-tradeloom-desktop-2`；r2 的 prepare、install、`build:lib`、`build:web`、`build:desktop` 和四个定向 Vitest 文件均 exit 0（28/28），阶段证据见 `LOCAL_RUNTIME_EVIDENCE/desktop-compile-2`。旧 r1 `build:lib` exit 2 与 slots-1 历史构建结果均保留为历史记录。Task 6 工具只复用现有 API 与 Django 本地模拟执行器；预算策略按每个 human request RPC 使用独立 4/16 桶，24 steps/轮保持不变。Native 诊断已定位 Host-root/global lifecycle seam；产品最小修正及 shell 定向验证已完成，但独立 native 产品组合复验仍 pending，诊断 MockAdapter 结果不算产品通过。真实 DSH/3090 调用、模型执行、Windows 安装包和 LAN 手机访问均未尝试。PG 启动记录见 `pg-restore-run1-command.txt`、`pg-restore-run1-exit.txt` 和 `pg-restore-run1-postgres-log-segment.txt`；启动日志显示实例曾被中断后自动恢复，恢复成功，停止原因未知。

## 风险与问题

Task 2 renderer/Node/native MockAdapter 集成验证均通过，但没有真实 DeepSeek API 或 GUI 验收。生成 manifest 损坏原因未知。Task 3 通过 Django 客户端、独立 PostgreSQL 测试库回归和 Node stream fixture；仍不证明 iframe 在真实 DSH/3090 运行时、Django Host/CSRF launcher 配置与浏览器布局端到端正确。Task 6 只用本地 HTTP/filesystem fixture 验证业务工具契约，不代表真实 Django/DSH E2E；业务执行仍是 local_mock/simulated_rules。Native budget 产品 policy 已改为 Host-root 单例与 global lifecycle tracking，并有针对性 Node 验证；独立 native 产品组合复验仍 pending。诊断变体的 cancel5/cancel17/RPC6 证据来自 MockAdapter，warm-child 仅证明消息插入顺序和 A scope 解析，不涵盖 child 映射切换至 B 后旧 A claim。PG 启动日志显示先前“database system was not properly shut down”，PostgreSQL 17 自动 WAL recovery 和 checkpoint 正常完成并 ready；停机原因未知，没有执行 repair/reset。隔离测试库 `tradeloom_test_dsh_business_embed` 被保留。Task 4 desktop-2 source build 和 receipt 已通过；安装部署、GUI 和 LAN 设备访问尚未验证。官方 production package 的 `dsh-app-boot` 布局与 launcher 现有 source-runtime 初始化路径尚未适配。正式 `tradeloom_dev` 仅做只读连接身份查询，本轮未改业务表；现有 DSH、Django `8000` 未触碰。

## 下一步

最小下一步是让 launcher 在开发 source-runtime 与安装 packaged-runtime 两种布局下复用官方 `@deepseek-ai/dsh-app-boot` 的 `initProfile`，同时保持现有 receipt 对 pinned commit、patch digest、marker、普通文件和 packaged `main.js` hash 的校验；建议先做两布局 resolver 的 fixture/结构检查，再进行专属 runtime stage、安装器、GUI 与 LAN 验收。业务工具还需在独立原生 DSH runtime 对接自有 Django `3090` 做真实会话验证；预算策略需先解决 native settlement/cancel race，再完成稳定集成验收。当前业务 HTTP fixture 不代表真实 DSH/Django/model E2E；本批没有启动 DSH、Django 服务、真实 provider 或实体手机测试。

Task 4 第一批补充记录（2026-10-19）：隔离启动器源码位于 `apps/tradeloom-launcher/`；桌面模式复用 Electron 内唯一 DSH Host，Web 开发模式与桌面模式使用同一 ownhome 并通过命名管道排他锁互斥。它按物理网卡元数据筛选 LAN IPv4、多网卡时显式选择、预检 `3088`/`3090`，隔离 DSH/Agent/cwd/cache 路径和子进程凭据，只停止当前启动器持有的句柄。desktop identity、Host LAN、业务 CSRF、managed update 与 websocket authority 补丁已登记在 pinned patch lock；上游卸载 helper 将 `DSH_HOME` 用作 protectedRoot，不是删除目标。

Task 4 收敛补充：固定 releases 根、单版本目录、runtime ownership marker 与 profile/bundle reparse 检查在 profile 读取和复制前执行；desktop receipt 还会逐级拒绝编译文件祖先目录的 reparse point。partial bundle 缺文件不会触发覆盖复制。官方更新 UI、自动检查和 feed 配置由版本化 patch 禁用。实际 builder 配置函数曾在隔离模块依赖夹具中执行，断言 appId、productName、extraMetadata.name 和协议身份。安装版 `.exe`/快捷方式通过 `extraMetadata.main` 指向自有 bootstrap，并由显式 owned stage 注入资源；bootstrap/stage/build receipt 只在隔离夹具验证。没有真实编译 receipt 时安装包入口会拒绝启动，不能视为已交付可用发行版。

Task 4 当前完整 launcher 测试 `node --test apps/tradeloom-launcher/tests/*.test.mjs` 为 34/34 pass、0 skip、exit 0，日志为 `LOCAL_EVIDENCE/dsh-business-tools\launcher-desktop2-final.log`；覆盖真实 loopback 占用、受管无害子进程与 STOP socket、单/多网卡 payload、外来同 HEAD clone、runtime 与 compiled 祖先 junction、partial bundle、receipt hash、官方 profile composer、bootstrap 首次 profile 初始化/ASAR、owned stage 生成及真实 builder metadata 执行。启动器默认 candidate 测试确认使用独立 `0.2.1-rc.2-tradeloom-desktop-2`。八 patch 生命周期 `python -m unittest scripts.dsh.tests.test_patch_lifecycle -v` 为 9/9 pass、exit 0，日志为 `LOCAL_EVIDENCE/dsh-business-tools\patch-lifecycle-desktop2-final.log`；八项 patch lock hash 已核验匹配。replacement `desktop-business-csrf.patch` SHA-256 为 `AFECC88496458AAB05A42474D6E4439054BBD0A55231AED41B5E9331E6714A84`，`desktop-websocket-authority.patch` SHA-256 为 `F1828DE831BBCC7B273E8EDBC554A2CBAE7237BE698539D732647DE8E17AAE89`。当前 r2 desktop build 和 source-runtime receipt 已通过；phase07 receipt 写入曾因假设存在独立 `web-document.js` 失败，已在 phase10 修正并验证，详见下文。没有运行真实 DSH/Django、Electron GUI 或 installer。

手机入口 artifact 由主控审阅后合入 `packages/tradeloom-shell/host.js`、`client.js` 与 `tests/mobile-link.test.js`。`node --test packages/tradeloom-shell/tests/*.test.js` 为 25 pass、0 fail、3 skip、exit 0；其中 2 项需要外部 pinned runtime，1 项需显式 composer fixture。入口通过受保护 GET 路由及 DSH `requestRejection` 生成当次 authenticated root URL，不将 token 写日志或状态。没有实体手机测试，不能据此宣称手机端已验收。

本阶段 desktop receipt verifier 绑定 patch lock 与实际发行的 compiled main/Host 入口 hashes；receipt writer 只接受外部 builder 提供的真实成功证据。CSRF 桥由 desktop build 内联进 `apps/desktop/lib/main.js`，不单独生成 web-document 文件。安装版 bootstrap 先隔离 ownhome/agents/workspace/cache、互斥锁和 Django，再导入官方 main；builder 缺失显式 stage 会失败，不退回官方入口。stage 和 builder metadata 仍只用隔离夹具验证；r2 已在受控 pinned source runtime 写入并验证 receipt，但这不是安装包或 GUI 验收。已有工作用 DSH 的安装、home、账号、配置、会话、进程、端口及协议关联均未读取或触碰；全局 `dsh` 未运行。真实安装和端到端验收留待后续专属发行流程。

候选 `0.2.1-rc.2-tradeloom-desktop-2` 的外部 r2 prepare、install、`build:lib`、`build:web`、`build:desktop` 均 exit 0；定向命令 `pnpm exec vitest run apps/desktop/tests/web-document.spec.ts apps/desktop/tests/websocket-authority.spec.ts apps/desktop/tests/update-coordinator.spec.ts apps/desktop/tests/update-channel.spec.ts` exit 0，四文件 28/28。phase07 receipt 首次写入因清单要求不存在的 `apps/desktop/lib/web-document.js` 而失败；phase09 重发的 metadata 不准确，其原 receipt SHA-256 `D30738154D90C5878A78D11464CC5F87D43D6B0793ADF0C683184D60EA6EFF69` 保留为历史证据。官方 bundle 检查确认 CSRF 桥内联在 `apps/desktop/lib/main.js`（518679 字节），无本地 helper/chunk import。修正后精确命令 `node.exe LOCAL_RUNTIME_EVIDENCE/desktop-compile-2\write-receipt-corrected.mjs` 于 phase10 exit 0，产品 writer 原子写入并 verify 通过。新 receipt SHA-256 为 `27D50B2E0A8D368E7CE35BD7590B2F76695A3E026B68F62AC853976983A523B2`；patch digest 为 `9d0243aec8edfe9340ca969c1aa7523da104686d082df7b83c74fc088dc3eaa1`；main hash 为 `087e268148f56ab0b05add5cd879335aa2aabc8b83f5a5b38452b6f93ddc6631`，Host hash 为 `61896cd7416a9955b015e013a51b9a770272c68997fe2d9da92cb45508f4e59e`。官方 `@deepseek-ai/dsh` 生产依赖闭包包含公开导出 `initProfile` 的 `@deepseek-ai/dsh-app-boot`；后续 launcher 可从官方 packaged `resources/dsh` 依赖入口初始化，无需复制完整上游源码树，但 source-runtime / packaged-runtime 双布局适配仍待实现。source build 和 receipt 不代表安装包、GUI、DSH→Django 或手机验收。Native budget integration 仍 pending，曾观测到 child settlement 归属丢失与 cancellation race，尚未产品合入或稳定整组验证。

Task 4 安装版接线补充（2026-10-19）：将已审 bootstrap artifact 集成到 `apps/tradeloom-launcher/`，测试 12/12；新增受控 `stage-desktop.mjs` 与 fixture 测试 2/2。stage 固定写入 `%LOCALAPPDATA%\TradeLoom\staging\desktop`，只复制六个自有 launcher 模块及明确 deployment manifest，要求 pinned owned source runtime 已带与当前 patch lock 相符的 receipt、专用 Python/Django 路径和有效 LAN 地址。manifest runtime 指向未来安装目标 `%LOCALAPPDATA%\TradeLoom\runtime\releases\<版本目录名>`；source runtime 的 receipt 已在 r2 构建后生成并验证，但仍不复制该 runtime，后续安装步骤仍需部署目标。`desktop-identity.patch` 将 `extraMetadata.main` 指向自有 bootstrap，并用现有 electron-builder FileSet 把 launcher/resources stage 纳入包；缺 stage 或 marker 时 builder 失败。官方 builder 配置函数在临时模块夹具真实执行，断言 appId、productName、包名、tradeloom 文件名前缀、main、FileSet 和 extraResources；stage manifest 另经 bootstrap 的真实 `validateManifest` 验证，resources 目标是一层 `resources/tradeloom`。

该安装版接线批次当时的完整 `node --test apps/tradeloom-launcher/tests/*.test.mjs` 为 34/34 pass、0 skip，日志 `launcher-bootstrap-stage-final.log`；identity patch metadata 定向测试 2/2，日志 `desktop-identity-artifact-final.log`；完整 pinned lifecycle 为 9/9、exit 0，日志 `patch-lifecycle-bootstrap-final.log`。最终 `desktop-identity.patch` SHA-256 为 `B63CA1B224320BD280EDA7822DB43BA213090D53E86E28DD98BF1E55E2DD20DB`，与 patch lock 一致。当时未运行官方 build、未写外部 runtime/receipt、未安装或启动 GUI/DSH/Django；后续 desktop-2 r2 build 和 source receipt 已在上文单独记录。Task 2 中心 native agent 已接到现有 Django API，但真实 DSH/Django/model 端到端仍未验收；iframe/代理可访问业务页面本身不构成 agent tool 端到端证据。

## 本轮启动路径与当前阻塞（2026-10-19）

- 最短 source-web 启动入口是仓库根目录 `scripts/launch-tradeloom.ps1 -Mode web`；它收集活动物理 Wi-Fi/以太网的私有 IPv4，单网卡自动选，多网卡要求用户选，然后调用 `apps/tradeloom-launcher/cli.mjs start --mode web --host <选中地址> --candidates <payload>`。不要单独传 `--host`：CLI 会要求该地址同时存在于可信候选 payload。启动器使用默认 candidate `0.2.1-rc.2-tradeloom-desktop-2`，路径为 `EXTERNAL_RUNTIME/\releases\0.2.1-rc.2-tradeloom-desktop-2`；该候选的八项 patch lifecycle 9/9 与 r2 source build/receipt 已有通过证据。这里记录启动方法，不代表本轮启动了服务。
- 该模式在 `%LOCALAPPDATA%\TradeLoom` 下使用自有 harness-home、agents-home、workspace、logs、cache 和 Python 路径；profile 为 `harness-home\profiles\tradeloom`。它将 `packages/tradeloom-shell` 的 manifest.files 精确复制进所选 TradeLoom release 的 `node_modules\@tradeloom\dsh-business-shell`，以 hash 校验后通过 source checkout 中 `packages\boot\app-boot\lib\index.js` 的 `initProfile` 初始化 profile。Django 由专用 `%LOCALAPPDATA%\TradeLoom\python-env\Scripts\python.exe` 运行仓库 `manage.py runserver 127.0.0.1:3090 --noreload`，DSH 网页服务绑定选中的 LAN 私有 IPv4 `:3088`；launcher 为 Django 设置本实例 Host/Origin，且隔离 inherited DSH/provider 凭据。当前候选可作 source runtime，启动依赖本地专用 Python 环境和已准备/迁移的 `tradeloom_dev` PostgreSQL（`127.0.0.1:55432`）。这两个运行前提本轮未实测；缺 Python 或数据库时会启动失败并写入产品专属日志。
- 没有 TradeLoom 自己配置的模型 provider 凭据时，网页 UI/本地规则流程可以启动，但真实模型调用不能据此视为可用；不得借用电脑现有 DSH 的登录态、profile 或凭据。当前 Django 业务 API 的执行模式仍是 `local_mock`/`simulated_rules`，不是生产业务模型执行。
- 发行包初版仍有独立缺口：当前 source `prepare-profile` 要求版本化 runtime 是带 pinned `.git`、`apps/cli/lib/bin.js` 和 `packages/boot/app-boot/lib/index.js` 的上游源码 checkout；官方生产包则把 CLI 生产依赖闭包（其中包含公开导出 `initProfile` 的 `@deepseek-ai/dsh-app-boot`）放在桌面 app 的 `dsh` 依赖树，不能用当前源码路径解析。桌面 stage 只复制自有 launcher 文件与 `resources/tradeloom/deployment.json`，不会部署 DSH runtime、业务 bundle 或 Django backend；manifest 指向的 LocalAppData release 因而需要实际部署步骤。source receipt 只证明 pinned source runtime 的构建 main/Host hash，未证明 app.asar 或安装布局。后续应在 source checkout 与官方 packaged `resources/dsh` 两种布局中复用同一 app-boot `initProfile`，并以构建 receipt/lock 为信任根；将产品 bundle、固定 Django backend 清单及必要 `data/samples` 明确纳入 stage/package，启动时通过 manifest 中的已验证相对路径解析，不能要求终端用户保留完整源码 checkout。
- Windows 完整 `package-target --prepare-only` 的官方包环境目前仍会强制解析 release update-policy HTTPS origin；TradeLoom 已有身份 `cn.tradeloom.workbench`，并由 managed-update patch 禁用更新，但没有真实发布服务可提供 origin，本轮未伪造域名，也未运行构建。官方 `prepare:runtime`、`prepare:packages`、`prepare:dsh` 是可分别调用的资源准备入口，适用于继续准备 source/resource；要让完整 branded offline package 流程通过，最窄方案是在现有 managed-update patch 中增加仅对合法 TradeLoom owned stage 生效的离线构建分支，跳过 TradeLoom 自身不使用的发布 origin 校验，同时让非 TradeLoom 上游 package 路径保留原策略。
- 产品 native budget clean 组合验证当前未通过，不能报告集成完成：证据 `LOCAL_EVIDENCE/dsh-budget-native-integration\evidence` 的 `exit.txt` 为 1，Vitest 7 项中 1 pass、3 fail、3 skip。三项失败为三个 RPC 委派分桶测试超时 5 秒、第五次 delegation 测试仅发出 3 次 native calls 后 turn 变为 blocked（未达第 5 次且未证明预期 cancellation）、第 17 次 `send_message` 断言实际计数 18。其余 mock/诊断边界不替代该失败；policy/Host/Cordis 本批保持冻结，后续需针对失败原因修复并重跑整组 native 验证。

## source-web 首次启动诊断（2026-10-19）

- 外部 smoke `LOCAL_RUNTIME_EVIDENCE/desktop-web-smoke-1\launcher` 的 `exit.json` 为 exit 1。`launcher.stderr.log` 首错在 `apps/tradeloom-launcher/core.mjs:115`：`ensureOwnedDirectory` 拒绝 `%LOCALAPPDATA%\TradeLoom\logs` 的 realpath 不匹配，随后 `writeFailure` 对同一目录重试并重复报错。
- 本次只读复核 Node 返回 requested=`%LOCALAPPDATA%\TradeLoom\logs`、resolved=`%LOCALAPPDATA%\Packages\OpenAI.Codex_2p2nqsd0c76g0\LocalCache\Local\TradeLoom\logs`，两者不只是大小写不同。故这次证据不能支持将 Windows 路径按大小写不敏感作为修复；没有修改 `core.mjs` 或测试，也没有重跑启动。需先确认启动进程应使用的 TradeLoom 专属 LocalAppData 根，避免放宽 realpath 安全校验接受另一个路径目标。

## source-web 数据根与预算结算修正（2026-10-19）

- Windows 启动与停止脚本新增可选 `-DataRoot`，只经 `ProcessStartInfo.EnvironmentVariables` 设置本次 Node 子进程的 `TRADELOOM_DATA_ROOT`；省略参数时脚本主动清除该变量，保持原 `%LOCALAPPDATA%\TradeLoom` 默认。Node 只接受绝对路径。指定根有独立 ownership marker；根及子目录仍走原 marker、reparse ancestor、realpath 校验。Django/DSH/home/workspace/log/cache 使用该根，专用 Python 仍为 `%LOCALAPPDATA%\TradeLoom\python-env`。启动失败发生在日志目录通过 ownership 验证之前时，只写 stderr，不再尝试向拒绝的路径写日志。已确认建议根 `EXTERNAL_WORKSPACE/runtime\tradeloom-app-data` 当前不存在；未创建它或启动服务。
- README 与快速开始已同步绝对数据根下的 Web 启动/停止命令。PowerShell parser 两脚本通过；launcher 全套曾为 36/36 pass、0 skip。之后只给 `writeFailure` 增加了验证日志目录后才写盘的保护，本批按主控要求未重跑 launcher 全套；该次新增保护通过 Node syntax check。
- `policy.js` 在 `agent/disposed` 时继续清理 Agent WeakMap；仅当 ID 映射仍指向同一个 Agent，才把 active map 替换成仅含复制 `scopes` / `unowned` 的标量快照，不保留 Agent 或 turn 引用。下一条 `subagent-settled` insertion 消费此快照；新 Agent/ID 映射不被旧 dispose 覆盖。持久 history 歧义 fail-closed、消息插入快照及其身份保护保持。
- 首次 shell 全套在两项已有 state 并发提交测试出现 `EPERM`/`rename`；定向重跑 2/2 通过。同进程 transact 已按 statePath 排队，测试的公开读取均在 transact Promise 完成后，未见公开 read 与 rename 交错；外部占用原因未证实。随后只在 `state.js` rename 提交处为 Windows `EPERM`/`EBUSY` 增加最多三次退避（20/50/100ms），重复同一个已关闭并 fsync 的临时文件，不重跑 mutator、不删除既有 state，其他错误立即抛出；耗尽时仍抛首个原 rename 错误。
- 修正后完整 `node --test packages/tradeloom-shell/tests/*.test.js` exit 0，54 pass、0 fail、3 skip；证据 `LOCAL_EVIDENCE/dsh-business-tools\shell-data-root-budget-retry-final.log` / `.exit.txt`。预算归属 `budget-epochs.test.js` 19/19 pass；两个 state rename 并发用例定向复测 2/2 pass，证据 `state-rename-targeted-final.log` / `.exit.txt`。首次失败完整日志保留在 `shell-data-root-budget-fix.log`（exit 1；52 pass、2 fail、3 skip），不作为最终通过结果隐藏。
- Node 源语法、两份 PowerShell 脚本 parse 与 `git diff --check` exit 0。关键源 SHA-256：`policy.js` `9C455CF1358B875C2CAAA91999EEEE71A1C53607CD89292C7D6DDBAD698A8B0C`；`state.js` `8D4EF24BAA26B287AD18ED81161C45B9C56392AF7EA8DA0D40F2BC8C66D0A037`；`core.mjs` `5677F0DFABACD2C2E9630CB72C6D26C01275A92BEDABC9065D421C23B7A81139`；`cli.mjs` `9CE5C8709F40138B93EBAA691BF935515143D7F6156AC948F310C82D726019BD`。未改 Host/Cordis、8 patch、lock、receipt 或 runtime；没有运行服务或 native 验收。

## profile bundle 解析修复与 native budget 复验边界（2026-10-19）

- pinned `@deepseek-ai/dsh-app-boot` 的 `initProfile` 只生成 profile manifest，不会安装其中列出的插件；官方 `resolveBundleDir` 先查 DSH 安装，再查 profile 自身的 `node_modules`。因此 `initProfile` 写入裸包名后，runtime 里的 `node_modules/@tradeloom/dsh-business-shell` 不足以让 profile 的裸包解析成功。检查隔离 desktop-2 release 时确认该 runtime bundle 已物理存在；自有 DataRoot 当前 profile 有 launcher record/manifest，但缺少 profile 内的该包。未读取或改动个人 DSH。
- `prepareProfile` 现在对 release 与 profile 两处都做文件清单 SHA-256 校验；仅当 profile 包缺失时，才从已验证 release 包精确补入 `profiles/<name>/node_modules/@tradeloom/dsh-business-shell`。已有包只在内容一致时复用，不同内容报错拒绝覆盖。没有改变 resolver、使用全局搜索路径或复制整棵 `node_modules`。本次只在临时自有测试目录运行 `prepareProfile`，未修改仍在使用中的 profile；后续受控启动需重新运行准备流程才会物化该修复。
- 新增真实解析回归：由 `prepareProfile` 生成临时 profile 后，从该目录执行 Node 裸包 import，并用 pinned 官方 `appBoot.loadProfile` 从 install anchor 解析 base/Web、从 profile `node_modules` 解析 TradeLoom 包。定向 `profile-contract.test.mjs` 2/2 通过；launcher 全套 `node --test apps/tradeloom-launcher/tests/*.test.mjs` 为 37 pass、0 fail、0 skip，exit 0。`prepare-profile.mjs` 与新增测试通过 `node --check`，`git diff --check` exit 0。
- native budget clean 组合结果已由主控核实并取代上文早期失败状态：实际 command execution `exec-f46b5be6-a701-4691-98f2-397c5c979f31` 数值 `exitCode 0`，4 pass、3 skip；证据为 `LOCAL_EVIDENCE/dsh-budget-native-integration\evidence\process-clean-final-attached.txt` 与 `stdout-clean-final-attached.log`。覆盖真实 Cordis/SessionController/Tools 装配和 MockAdapter；未覆盖真实 provider 或完整 Host GUI，也未证明暖 child 已映射到 B 后、旧 A claim 的强交错。早期失败日志仍作为历史保留，不能代表当前 clean 结果。

## 开发同步草稿收尾检查（2026-10-19）

- 显式开发 bundle 同步功能尚未完成；当前工作优先转向 Windows 桌面运行与安装包。未修改运行中的 TradeLoom 服务、profile、bundle 或数据库；新同步测试尚未执行，不能将同步功能视作已验收。
- 对 `apps/tradeloom-launcher/core.mjs`、`cli.mjs`、`prepare-profile.mjs`、`sync-dev-bundle.mjs` 运行 `node --check`，四个文件全部通过，命令组 exit 0。
- 运行既有 launcher 测试一次，命令为 `node --test` 加载 `apps/tradeloom-launcher/tests/` 下除 `sync-dev-bundle.test.mjs` 外全部 `*.test.mjs`。结果 37 pass、0 fail、0 skip，exit 0。覆盖现有启动/停止 helper、desktop bootstrap/stage、profile contract、receipt 与 websocket authority 测试；没有启动服务、重编 DSH 或验证安装包。

## 桌面 CLI 启动入口修正（2026-10-19）

- `cli.mjs` 将未完成的 `sync-dev-bundle.mjs` 改为仅在显式 `sync-dev-bundle` 操作时动态导入；普通 `start` / `stop` 不再因草稿模块的未导出符号而加载失败。开发 bundle 同步仍未完成，本次未运行其测试或扩展该功能。
- Windows 桌面启动现在从所选受管 runtime 固定构造 `apps/desktop/.desktop-build/targets/win-x64/runtime/primary-runtime`，并注入 `DSH_DESKTOP_PRIMARY_RUNTIME_DIR`；启动前缺失时给出“桌面 Primary Runtime 尚未准备”的受控准备提示。该变量来自 launcher 自己的 runtime 路径，不读取继承的 `DSH_*` 值。
- 新增普通 `stop` CLI 子进程回归和桌面环境构造回归。launcher 测试（排除未完成的 `sync-dev-bundle.test.mjs`）最终为 39 pass、0 fail、0 skip，exit 0。隔离数据根下直接执行 `node apps/tradeloom-launcher/cli.mjs stop` 返回预期 exit 1，stderr 为“未找到由本启动器管理的运行实例”；这确认入口成功加载并进入 stop 分支，没有启动/停止实际服务。
- 未启动桌面、Web、Django 或 DSH 服务；未改 runtime、profile、bundle、数据库或用户数据。桌面完整启动和安装包验证仍未完成。

## 桌面窗口启动环境修正（2026-10-19）

- 桌面专用子进程环境固定设置 `DSH_DESKTOP_OPEN_DEVTOOLS=0`，并移除继承的 `ELECTRON_RUN_AS_NODE`；普通 Node 子进程环境构造保持原样。定向 `core.test.mjs` + `cli-entry.test.mjs`：13 pass、0 fail、0 skip，exit 0。
- 主控报告 source Electron PID 54000 正在运行，3088、3090、55432 的 TCP 探测均成功；此前观察到 DevTools 脱离主窗口并成为标题窗口。本次只准备桌面子进程环境，不重启进程，也未完成真实窗口渲染验收或安装包验证。

## DSH 桌面主窗口可见性验收（2026-10-19）

- 主控受控重启后确认真实 source Electron 主窗口可见：Electron PID `18988`，父 launcher PID `53680`，窗口标题 `DeepSeek Harness`，`MainWindowHandle=855776`；`3088`、`3090`、`55432` 三个受管端口的 TCP 探测均成功。这证明桌面进程主窗口已显示及服务端口可连接，不代表业务页面渲染/交互、登录代理或真实 provider/模型调用已验收。桌面窗口标题仍为上游 `DeepSeek Harness`。
- 可见性修正位于 `apps/tradeloom-launcher/core.mjs` 与 `cli.mjs`：通用受管子进程仍默认 `windowsHide:true`，只有 Electron 桌面启动显式使用 `windowsHide:false`。同一桌面环境修正固定 `DSH_DESKTOP_OPEN_DEVTOOLS=0` 并清除桌面子进程继承的 `ELECTRON_RUN_AS_NODE`；不会改变一般 Node 子进程设置。
- launcher 基线命令（排除未完成的 `sync-dev-bundle.test.mjs`）为 39 pass、0 fail、0 skip，exit 0；本次窗口启动改动的定向 `node --test apps/tradeloom-launcher/tests/core.test.mjs apps/tradeloom-launcher/tests/cli-entry.test.mjs` 为 13 pass、0 fail、0 skip，exit 0。两项是不同批次/范围，不合并相加。
- 启动日志中出现 `No handler registered for 'dsh-desktop:mandatory-status'`，但在该警告仍存在时主窗口已可见、三个端口均可连接；因此本记录不把它判定为窗口隐藏原因，也未据此改动上游 patch。业务层效果仍需单独验收。
- source primary runtime 的完整 smoke 仍失败：一个 `.pyd` 绝对路径长 260 字符，Python `os.path.exists` 返回 `False`，随后报 `ModuleNotFoundError: No module named 'pandas._libs.tslibs.np_datetime'`。桌面进程可见及端口连通不覆盖该 smoke，不能据窗口验收将 Primary Runtime / 业务能力报告为完整通过。
- 截至本节记录时（2026-10-19），安装包验收未完成：当时的 stage 尚未部署完整生产 DSH 资源闭包、业务 bundle 与 Django backend。该历史状态已由下方 2026-10-20 八字段更新；手机同 Wi-Fi 浏览器入口是 companion Web 访问方式，实体手机尚未验收。

## 桌面工作台与安装状态（2026-10-20，八字段）

- **当前阶段：** [x] 本地 source-mode Electron 已完成本轮原生 GUI 业务整链验收：工作流 `e40d9760ffac4fd9a52af4cf349e9a7b`、批次 `be4506de206341b5847567c69c77a0f2` 在重启后仍为 completed；completed 卡片不再显示已过时的下一步。运行标识为 `local_mock/simulated_rules`，不是真实模型执行。本轮窗口标题为“织贸助手”；本地使用隔离 Electron/DataRoot 和 p8 runtime 只读 junction，不代表 p8 安装版包含或通过了本轮源码修复。p8 首启 `Web RPC failed` 保留为该安装版本的历史故障。
- **已完成：** [x] 五个业务入口、两场景切换/刷新/展开/返回、六个 Agent 对应 preset/workspace 与重启后会话保留已实际点击。原生 Agent 中心工作流要求人工提交 review、显式 apply 后再恢复 `product_profile` 与 `delivery_quality`；4 个演示 review 完成后生成 5 个交付文件，2 个演示产品质检通过，5 项均经显式审核批准，工作流完成且重启后状态保留。Catalog HTML 与 CSV 均经原生 Save As 落盘并校验：HTML 3,335 字节、SHA-256 `3f00b707cefbd03552e04508c93b8ee5cf8cae39204a1fd0328892234ce6e287`；CSV 713 字节、SHA-256 `56bce7aa3e8b1225e56980c2ec6729b22ecfa138f86635d1878692cef87a56a3`。两个预览均在同一 iframe 打开；HTML 显示两张演示图，CSV 预览不再出现重复 Django 侧栏，并可返回交付物中心。全部演示资料和审核标签均明确为演示数据/演示验收。详见本轮 [GUI 验收 JSON]（项目外证据文件：local-workbench-e2e-gui-acceptance-20261020.json；未随仓库提供）。
- **未完成：** [!] 产品内真实厂商 API 保存/请求、真实模型理解与多 Agent 委派、结构化提案 handoff 浏览器流程、窄屏/实体手机、退出确认取消/批准生命周期尚未验证；AgentArts 按用户要求豁免。Agent 中心 completed 卡片的陈旧 next-step 已由源码修复，并在本轮原生 GUI 复验中确认不再显示。并排原生会话和视频参考记忆分层未实现。p8 安装版尚未用本轮源码修复更新验收。
- **测试结果：** [x] 本轮定向测试：completed next-step 无数据库渲染 1/1、exit 0（RED 1/1、exit 1）；business proxy 7/7、exit 0，日志 `LOCAL_EVIDENCE/desktop-package-contract\wsgi-stream-boundary-20261020\logs\business-proxy-pinned-green.log`；BusinessEmbed/CSV preview 9/9、exit 0，日志 `LOCAL_EVIDENCE/desktop-package-contract\artifact-preview-same-window-20261020\embed-regression-green.log`。Django 最终全套在隔离 PG `127.0.0.1:55435`、新测试库 `tradeloom_test_full_regression_20261020_05` 上为 **327/327、52.042 秒、exit 0**；日志 `EXTERNAL_TEST_ROOT\si-20261020-01\run-full-final05-673e7847cfe94e259e3adde742f70524\workbench-full-final.log`，退出码文件同目录 `workbench-full-final.exit.txt`。此前 `_01` 为 312/327（15项失败：9项测试用户守卫不匹配、5项 recovery worker 未继承依赖路径、1项旧 `target=_blank` 断言）；修正隔离角色/子进程依赖并更新过期断言后，`_02` 为 326/327，唯一失败来自测试假设 `subtasks[0]` 顺序稳定。旧断言隔离重跑 `_03` 1/1，新按 `product_subtask.id` 选择的断言 `_04` 1/1，最终 `_05` 全套通过。未连接或修改 PG `55432`。测试后隔离 PG 已按 `pg_ctl stop` exit 0 停止，PID 38660 已退出、55435 已释放，数据保留；证据 `LOCAL_RUNTIME_EVIDENCE/full-regression-20261020-01\final-fixture-stop-summary.json`（SHA-256 `93bc4eb7cbb9e6e4b7171f220d07a48c74459de811358e1c796fbc5e10648d5b`）。Shell+launcher 初次全目录 131 项为 121 pass、2 fail、8 skip、exit 1；两项 profile-contract 失败源于默认 slots-1/desktop-2 runtime 缺 `@deepseek-ai/cordis`。使用只读 candidate7 runtime 的 focused profile-contract 为 2/2；3 个具名 pinned 契约为 3/3；Cordis Loader 契约为 1/1。Node 全目录未重跑；4 个 stage6 inventory 用例仍 skip，未将文件级过滤项计为契约通过。命令、隔离细节、日志和两项测试 SHA 见 [本轮验收记录]（项目外证据文件：verification.json；未随仓库提供）。此前 124/4skip、324/324 均为历史结果，不计为本轮运行。
- **运行方式：** [x] 本轮使用隔离 local source-mode Electron 与专用 DataRoot。HTML/CSV 下载与哈希明细见 `LOCAL_RUNTIME_EVIDENCE/local-dev-workbench-20261020-02\download-gui-e40d9760.json`。
- **平台状态：** [x] Windows x64 本地 source-mode 原生 GUI 已完成上述界面、工作流、预览及下载复验；截图索引见 GUI 验收 JSON。p8 安装版、实体手机和窄视口未由本轮验证。
- **风险与问题：** [!] 工作流执行与中心/业务角色均为 `local_mock/simulated_rules`，reviewer 使用演示验收标签，不代表真人业务审批或真实模型委派。completed 卡片陈旧 `next_step` 已修复并由原生 GUI 复验。两个自定义 provider 配置可保存并在应用重启后保留；原生聊天分别命中本地 A/B mock，累计 A 两次、B 一次 POST。未验证真实厂商请求、模型驱动委派、实体手机、窄视口和 native quit 生命周期；本地源码通过不能外推为安装版通过。
- **下一步：** [-] 继续按用户“本地优先”要求验收模型驱动的结构化提案/委派、真实供应商请求、退出生命周期、窄屏与实体手机；只有本地框架确认后再安排是否 stage/package/install，不自动打包。AgentArts 豁免；不把演示工作流称真实模型运行。

### 本地 source-mode GUI 验收证据

- [x] 主控通过 first-party Windows computer-use 对本地 Electron 实际截图和点击；截图 `LOCAL_SCREENSHOTS/2026\10\18\01a14efa-72b3-7a63-8b40-a274f33629cf\tradeloom-local-workbench-final-20261020.jpg`，逐项摘要见 `LOCAL_EVIDENCE/desktop-package-contract\local-workbench-gui-acceptance-20261020.json`。浏览器授权跳转不是实体手机测试。
- [-] 本轮实际保存两个自定义 API provider 配置并在重启后复用；原生聊天分别向 `127.0.0.1:54899/a/v1/chat/completions`、`/b/v1/chat/completions` 发出请求，A 两次、B 一次，均得到标注“模拟服务”的固定回复。该验收只证明产品配置持久化和本地 OpenAI-compatible mock 路由，不证明真实厂商 API、模型推理或 Agent 委派。脱敏快照见 `LOCAL_EVIDENCE/desktop-package-contract\completed-card-provider-gui-20261020\verification.json`。

### p7 历史人工验收记录与当前本地续接

1. [x] 外部 writer 已核对 p7 的关键入口源码与 receipt，并复制到 `workspace/deliverables/tradeloom-desktop-p7-20261020`；exe SHA256 为 `E4338582FB034C3885ED00A554E8054B92FEA7EF924A327DBE407A68CAE63DF5`，摘要见 `runtime/tradeloom-harness/evidence/package-installer-7-20261020-1/summary.json`。
2. [x] `2026-10-20 08:06 UTC` 历史快照显示旧 p3 PID `13396` 不存在且目标端口无监听；此记录不是当前进程状态。如需识别 p3，按其可执行路径核对（`EXTERNAL_RUNTIME/\build\p3\targets\win-x64\unsigned-artifacts\win-unpacked\织贸助手.exe`），不要只凭窗口标题判断或关闭个人工作用 DSH。
3. [x] 旧 p7 曾启动，用户截图确认顶部业务导航和左侧 6 个通用 Agent；该截图是历史布局证据。p8 后续安装首启出现 welcome/account.state Web RPC failure，且未以本轮修复重验；本地 source-mode GUI 的对应范围现已实际通过，见上方本地验收记录。
4. [ ] 使用产品自有 provider 配置验原生对话及资料工具/子 Agent 调用，不读取个人 DSH 凭据。结构化提案只验证“handoff 预填 → 用户查看预览 → 用户显式确认创建”；任何本地 workflow 结果仍标 `local_mock/simulated_rules`，不得称真实模型执行。本次提案浏览器流程目前未验收。
5. [ ] 验证关窗隐藏、退出确认取消后服务继续、批准退出后仅清理产品自有服务；最后用真实手机和电脑连同一 Wi-Fi，按应用实际显示的 LAN 地址/授权入口验证，不能使用 `127.0.0.1`。

### p7 阶段结项审计（历史记录）

该阶段分类为 **progress**：p7 官方打包、receipt/关键入口/资源核对、交付复制和安装后资源比对均已通过；p7 当时的截图确认导航/Agent 布局。p5 安装器与交付副本可重新安装回退且不含后续结构化提案接线。原生对话及资料工具调用未验收，不能据此标记整体目标完成。

该阶段之后安装 p8，但首启 welcome/account.state Web RPC 报错，不能沿用 p7 截图作为当前启动成功证据。各 Agent 独立会话、中心区交互、原生聊天、资料工具和子 Agent 调用仍未通过；此前 `type: null` 错误表明旧安装版调用失败。结构化提案虽已进入源码，浏览器中的 handoff→Agent Center 预填→预览→人工确认创建未执行。产品自有 provider 未验证，业务模拟仍是 `local_mock/simulated_rules`；关窗/取消/批准退出行为和实体手机同 Wi-Fi/LAN 授权也未验收。`2026-10-20 08:06 UTC` 的端口/PID快照仅反映该时点，不作当前运行状态判断。

隔离业务 Django `8011` 当前离线；此前启动请求被执行器报告 `CreateProcess ... blocked by policy`，原始回执不可取得，主控已禁止用保存脚本或替代 shell 再试。因此不能把旧业务 demo 当成当前浏览器可用环境，也不能以其历史工作流证据替代 p8/原生 DSH 验收。AgentArts 仍按用户要求豁免。
## source-mode 开发 bundle 同步与视频方法参考（2026-10-19）

- [x] 显式同步模块导出、destination 自有旧 `package.json.files` hash、嵌套路径 `agents/demo.js` fixture 和 session/receipt 保留已验证。`node --test apps/tradeloom-launcher/tests/sync-dev-bundle.test.mjs`：5/5，exit 0。
- [x] `node --test apps/tradeloom-launcher/tests/profile-contract.test.mjs apps/tradeloom-launcher/tests/cli-entry.test.mjs`：3/3，exit 0。同步 CLI 隔离入口到达预期 runtime-path validation（预期 exit 1）；PowerShell wrapper 语法解析及显式 action 静态检查 exit 0，没有执行可能接触真实 profile 的 wrapper。
- [x] `docs/desktop-bootstrap.md` 已明确 source sync 必须指定符合当前 patch lock/receipt、并完成官方 development preparation 的 source runtime 绝对路径；这不表示默认 source runtime 或安装版通过实机验收。
- [x] 新增 [视频方法参考](video-methodology-reference.md)，依据用户提供的 346 段字幕与主控按时间顺序抽看的多个时间点截图，区分字幕/画面证据，标出 ASR 术语不确定及源码/行为未核实的边界。只记录可复用方法，未新增软件功能。

## 用户资料工具 schema 修复（2026-10-20）

- [x] 将 `packages/tradeloom-shell/profile-tool.js` 中 `tradeloom_user_profile_read` 的无参数声明从 `{}` 改为根类型为 `object` 的 JSON Schema。pinned ToolRuntime 原先仅校验输出 schema，输入定义被原样送入 pi-ai；空对象最终在 provider wire payload 中没有根 `type`，与用户报告的 `type: null` 一致。
- [x] 新增 pinned wire 回归：通过实际编译的 DSH ToolRuntime 注册产品工具，以 pinned pi-ai OpenAI-compatible 序列化器捕获 `tools[].function.parameters`，并在 fetch/网络派发前终止。旧 `{}` 输入的有效 RED 见 `LOCAL_EVIDENCE/desktop-package-contract\profile-schema-wire-valid-red.log`（exit 1；捕获的 payload 为 `parameters:{}`）；修复后 `node --test tests/shell.test.js tests/business-tools.test.js` 为 28 pass、0 fail、2 skip，exit 0，日志见 `LOCAL_EVIDENCE/desktop-package-contract\profile-schema-wire-final.log`。两个 Node 语法检查及针对文件的 `git diff --check` 均 exit 0。
- [ ] 安装后的 p8 profile inventory 已核对 `profile-tool.js` 使用根类型为 object 的参数 schema；但 p8 首启 Web RPC 失败，真实原生资料工具请求仍未验成。较早 p7 的 `type: null` 报错保留为历史故障证据。下方单次直接 API smoke 只验证供应商 endpoint 与合成工具回合，不证明其他产品内请求已通过。手动添加 API 配置失败尚无错误信息，当前没有证据表明它与旧 schema 问题同因。

## 安装版业务 bundle 更新与账号入口边界（2026-10-20）

- [x] `installed-bootstrap.mjs` 仅在受控的专属 profile 路径更新 business-shell：新 profile 写 inventory；旧 profile 只接受登记的旧/新摘要，或无记录且完整树精确匹配 stage6/p7 legacy 摘要 `b86ae8b432b6a9cfb28582673d1867b0bfa7f39b8d9cd65c29f3ed692fb3766f`（11 文件）。更新先在 profile 内暂存并复核摘要，再保留旧 bundle/inventory 备份后切换；失败回滚，重试可恢复唯一受信备份；记录存在但 bundle/可信备份缺失时拒绝继续。未知修改拒绝覆盖。隔离 fixture 验证设置、credentials、session 和 state 文件哈希保持不变；业务/PG 数据不迁移。
- [x] 安装引导 RED：`installed-shell-upgrade-red.log` 复现 legacy p7 bundle 无库存记录时被拒绝；新增“登记存在但 bundle 缺失”用例在守卫关闭时直接实测失败（预期拒绝未发生，exit 1；该次终端输出未另存文件）。恢复守卫后的最终 `node --test apps/tradeloom-launcher/tests/installed-bootstrap.test.mjs` 为 10/10，exit 0，日志及 exit 记录见 `LOCAL_EVIDENCE/desktop-package-contract\bundle-account-final-20261020\installed-bootstrap.log` / `.exit.txt`。覆盖新装、legacy 升级、重复调用、未知编辑拒绝、注入 rename 失败回滚/重试、可信备份恢复、无可信备份时 fail-closed 和 profile 其他文件保留。
- [x] Cordis overlay 只禁用 `deepseek-account`、`llm-deepseek-account`；保留 `authorization`、`credentials`、`llm-pi-ai` 与 API-key `llm-deepseek`。没有改默认模型、用户模型选择或凭据。pinned 官方 composer 中，无禁用项的 RED 见 `account-disable-composer-red.log`；GREEN 1/1 见 `account-disable-composer-green.log`。最终 `node --test packages/tradeloom-shell/tests/shell.test.js packages/tradeloom-shell/tests/business-tools.test.js` 为 29 pass、0 fail、1 skip，exit 0；日志见 `LOCAL_EVIDENCE/desktop-package-contract\bundle-account-final-20261020\shell-business-tools.log` / `.exit.txt`。跳过项是需特定 pinned Cordis Loader unwrap 条件的测试。
- [ ] 产品源码子任务当时未创建新安装包；之后 p8 已构建、安装并完成资源对照，但首启 Web RPC 失败。当前场景工作台源码尚未 stage/package/upload。产品目标是跨厂商、多模型和多组独立 base URL/key/model/protocol，禁用 DeepSeek 官方账号登录并保留手动 API、`llm-pi-ai` 和用户模型选择；native API 表单反馈 patch 已纳入源码补丁集。此次仅对 DeepSeek 做一次直接 API smoke，不证明其他供应商或产品内配置已连通。生图及网页反代属于后续 adapter，聊天多模态不等于生图。

## DeepSeek API 与工具 schema 合成 smoke（2026-10-20）

- [x] 主控使用一次性安全输入包装器执行脚本 `LOCAL_EVIDENCE/desktop-package-contract\provider-smoke-20261020\provider-smoke.mjs`：读取模型列表及两次 chat completion，共 3 个 HTTP 请求、0 重试，均 HTTP 200；`deepseek-flash` 可用，产品注册的 `tradeloom_user_profile_read` 参数 schema 被接受并返回有效空对象参数，随后以固定合成 profile fixture 收到预期回执标记。用量合计 468 tokens。脱敏结果见 `LOCAL_EVIDENCE/desktop-package-contract\provider-smoke-20261020\result.json`；wrapper/tool session `51919` exit 0。
- [ ] 该 smoke 是直接 API 调用加真实产品工具 schema、合成工具结果；没有读取真实用户资料，也不代表 p7 原生 GUI、产品 provider 设置、多 Agent 委派或其他供应商已验证。密钥未写入证据或报告。

## 视频方法参考时序核对修订（2026-10-19）

- [x] 已按时间顺序补入覆盖全片范围的截图观察，并与 346 段自动字幕分开标注；视频画面报告时长 740 秒（12:20），截图覆盖到片尾约 12:17。该核对不是逐帧或连续观看，字幕约 12:01.5 后无内容；画面中的源码/行为未独立核实。
- [x] 修订记录补入 UI 上下文接口（当前窗口/面板/选中对象）、多级索引、会话档案引用/备份、任务检查点/范围/截止/回执示例，尤其补记字幕外 12:08 OCR 断点续做画面。当前 TradeLoom 尚无 UI 上下文接口；现有 Django 业务工作流只证明受控 API、服务端幂等 dispatch 与已保存步骤恢复，不代表通用 OCR 或暂停/续做系统。业务事实仍以数据库/API 为准，不让 Agent 随意覆盖共享 Markdown。
- [x] README 原有方法参考入口保持不变；本次仅修订方法论文档和本报告，没有增加功能代码或按视频扩展权限。

## Native provider 表单反馈与第九项 DSH patch（2026-10-20）

- [x] 集成主控审过的四文件 provider 表单 patch `native-provider-ui-fix.patch`，SHA-256 `AA336767F2B184E2AF2C44D56943699D7CD069A238F991F65619618FEF4B9CEF`。前八项 patch 顺序与 hash 保持；新项追加至 `integrations/dsh/patches/patches.lock.json`。锁内登记四个 pinned base/new SHA；`prepare-runtime.ps1` 在 patch 前后校验，`check-upstream.ps1` 纳入目标 allowlist 并对已准备 runtime 校验 patch 输出摘要。未改 upstream source copy 或 candidate5。
- [x] 外部隔离 provider UI artifact 报告组件测试 106/106、TypeScript `--noEmit` exit 0；artifact manifest SHA-256 `2c81ad081f8600f807dab87e9249f27478b87d7a752f4b12aa404737167e7fb9`。产品定向验证：`python -m unittest scripts.dsh.tests.test_patch_lifecycle -v` 为 9/9、exit 0，真实执行 prepare ordered apply、base/new target hash 和 clean runtime reverse compatibility；最终证据在 `LOCAL_EVIDENCE/desktop-package-contract\native-provider-lifecycle-final-20261020\patch-lifecycle-verified.log` / `.exit.txt`。`node --test apps/tradeloom-launcher/tests/*.test.mjs` 为 58/58、exit 0；`node --test packages/tradeloom-shell/tests/shell.test.js packages/tradeloom-shell/tests/business-tools.test.js` 为 29 pass、1 skip、0 fail、exit 0；证据均在同一目录。跳过项需特定 pinned Cordis Loader unwrap 条件。
- [x] profile bundle 检查先 inventory 普通文件并拒绝链接，再读 profile `package.json`。链接注入回归曾因过早读取而 RED exit 1；修正后包含在 launcher 58/58 中。安装引导单独结果为 10/10，证据见 `LOCAL_EVIDENCE/desktop-package-contract\bundle-account-final-20261020\installed-bootstrap.log` / `.exit.txt`。
- [ ] 本轮只更新源码补丁与隔离测试，不创建新安装包，也未更新已安装 p7。provider UI 测试不使用真实 key/API，不证明任意厂商连通。使用步骤与范围边界见 `docs/agent-development.md`“手动添加与选择供应商模型”。

## 原生产品字段保存失败：JSON 请求体边界修复（2026-10-20）

- [!] 原生 GUI 中保存演示产品字段时，Django 返回“请求体必须是 JSON”，表单未更新；实机截图：`LOCAL_SCREENSHOTS/2026\10\18\01a14efa-72b3-7a63-8b40-a274f33629cf\tradeloom-native-product-json-failure-20261020.jpg`。该失败不由浏览器页面可访问/既有工作流通过所替代。
- [x] 隔离 loopback 复现确认兼容缺口：Django 5.2.18 `WSGIRequest` 在没有 `CONTENT_LENGTH` 时按 0 字节读取；经实际产品 `forwardWebRequest` 与 `createBusinessProxyHandler` 的 32 字节 streamed JSON 到达 0 字节，而显式长度到达完整 32 字节。仅对缺 `Content-Length` 的 JSON body 在业务代理处有界收集并补准确长度；限制对齐项目未覆盖的 Django 默认 `DATA_UPLOAD_MAX_MEMORY_SIZE=2,621,440`（Django 5.2.18 默认 2.5 MiB）。已有长度请求与 multipart 仍流式转发，过限/断流不转发部分体。未改 Django JSON 校验、canonical Electron/Host 或数据库。
- [x] TDD 红证据：新增 streamed JSON 长度断言在旧代理失败，预期长度 `35`、实际缺失，exit 1；日志 `LOCAL_EVIDENCE/desktop-package-contract\wsgi-stream-boundary-20261020\logs\business-proxy-red.log`。最终在本进程临时设置 candidate7 的 pinned `@deepseek-ai/dsh-host-webserver/lib/index.js` 后，`node --test LOCAL_USER_HOME\Desktop\ICT\tradeloom\packages\tradeloom-shell\tests\business-proxy.test.js` 为 7 pass、0 fail、0 skip，exit 0；包含 POST/PATCH 的 JSON 与 `+json` UTF-8、超限拒绝、chunked multipart 流式和断流不部分转发。路径及日志在 `LOCAL_EVIDENCE/desktop-package-contract\wsgi-stream-boundary-20261020\verification.json`、`...\logs\business-proxy-pinned-green.log` / `.exit.txt`。同一真实 Django WSGIRequest 隔离链复测 streamed 与显式 Content-Length 均完整收到 32 字节，exit 0；修复前边界记录于 `verification-before-fix.json`。
- [ ] 当前 Native GUI/正式运行环境尚待主控复验该保存动作；本回归使用 Python 3.12.14 隔离 fixture，Django 版本为 5.2.18；当前应用运行时为 Python 3.14，仍需确认其随包 Django 版本/实机结果。未启动或重启应用、未连接业务数据库、未打包。

## Agent 中心已完成任务的下一步提示修复（2026-10-20）

- [x] `workbench/views.py` 仅在工作流状态不是 `completed` 时显示 `result_refs.next_step` 摘要；未改工作流状态、计划快照或历史事件。running 任务仍显示“下一步：产品资料”，completed 任务不再显示陈旧“下一步：生成交付文件”。
- [x] TDD 使用 `SimpleTestCase` 直接调用 `agent_center()` 并渲染真实模板；模型查询仅在测试进程内替换为演示对象，不连接数据库或服务。新回归先因 completed 卡片显示陈旧下一步而 RED（exit 1），修复后 1/1 PASS（exit 0）。runner、红绿日志见 `LOCAL_EVIDENCE/desktop-package-contract\completed-next-step-20261020\`。
- [!] 首次尝试数据库 runner 时，目标隔离 PostgreSQL `127.0.0.1:55435` 无监听；该尝试未进入测试断言，由我停止自己的 runner，未启动服务或修改数据库。最终回归改为无数据库渲染测试。主控仍需在 runtime helper 重启后复验原生 GUI 文案；当前不声称实机已验证。

## 原生用户资料工具调用验收（2026-10-20）

- **当前阶段：** [x] 本地 source-mode 原生 GUI 的用户资料工具调用已通过；测试 fixture 已停止。
- **已完成：** [x] user-profile preset 调用 `tradeloom_user_profile_read`，参数 `{}`；真实工具结果进入下一次模型请求，随后显示固定模拟回复。受控本机 SSE fixture 验证对象根 schema、tool-call、同一 `tool_call_id` 的 `role=tool` 结果及最终响应。截图：`LOCAL_SCREENSHOTS/2026\10\18\01a14efa-72b3-7a63-8b40-a274f33629cf\tradeloom-native-user-profile-tool-trace-20261020.jpg`。验收记录：`LOCAL_RUNTIME_EVIDENCE/local-tool-call-gui-20261020\acceptance.json`，SHA-256 `F1D11C4F3FFA68C8ECB13B5D0648E823170274D76DFAEC88A8750631CA7B701A`。
- **未完成：** [ ] 真实供应商模型推理、原生提案链接到 Agent Center 的预填/人工预览/确认链、实体手机验收。后续本机 mock subagent 闭环已见下节记录。
- **测试结果：** [x] 本机 SSE fixture 共 3 次 POST，均 HTTP 200：工具调用、无工具声明的辅助请求、同 ID 的 tool 结果；`displayName`/`notes` 字符串形状符合约定。脱敏摘要 `request-summary.json` SHA-256 `9FC0D194CD80B19BEFB6DE236FF264C516C5D8613DA431AABCBEFCD5CE7459B0`。fixture 脚本 SHA-256 `6BA69141584CF00E4C02395C4A48498285C1901024CCFE78DDC5B66BD3EE89B9`。这些证据证明工具 wire 往返，不证明真实模型推理或子代理委派。
- **运行方式：** [x] 使用本地 source-mode 应用及 `LOCAL_RUNTIME_EVIDENCE/local-tool-call-gui-20261020\mock-user-profile-tool.mjs`；fixture 当前已停止。
- **平台状态：** [x] 验收在本机 Windows source-mode 原生 GUI 完成；不代表安装包包含本轮源码。
- **风险与问题：** [!] 本轮资料工具 SSE 为本机模拟服务；工具读取了演示资料，脱敏请求摘要及验收 JSON 未保存资料字段值或凭据。真实 vendor 与实体手机仍未验收；下节的本机 mock 子代理验收不代表真实 LLM 决策。
- **下一步：** [-] 原生用户资料 child 工具闭环已由本机 mock 验收，见下节；后续先验提案链接进入业务页与人工确认，再独立验真实供应商和实体手机。

## 本机模拟模型下的原生双业务子代理工具闭环（2026-10-20）

- **当前阶段：** [x] 本地 source-mode 原生 GUI 已以两个不同业务 preset 完成中心 spawn、child 工具执行、异步完成通知和中心汇总的模拟模型闭环；未运行新业务工作流。
- **已完成：** [x] 先行的 center→user-profile 单 child 闭环为 6 次 HTTP POST、全部 HTTP 200，验收记录见 [`acceptance.json`]（项目外证据文件：acceptance.json；未随仓库提供），SHA-256 `53C9B6C2F3D66C4FF70A2BB3FE43076A0A37575F8A6FFD9676859E658284F125`。本轮商品 child `e2081a75-5769-427d-8394-31f51da583e0` 使用 `tradeloom-product` preset 调用 `tradeloom_read_products`，读取明确指定的演示批次 2 条记录；交付 child `29ac5e80-d560-49f3-8039-15afcf84e6f9` 使用 `tradeloom-delivery` preset 调用 `tradeloom_read_deliverables`，读取既有工作流的 5 个 artifact、5 个版本。中心收到两个 child 的完成通知后再请求模型并产生 `local_mock` 汇总。仅新建测试会话并读取已有演示数据。
- **未完成：** [ ] 真实供应商模型推理/自主决策、原生 Markdown 提案链接点击到 Agent Center、fragment 预填后的人工预览与确认端到端；实体手机验收。
- **测试结果：** [x] 脱敏验收记录为 `LOCAL_RUNTIME_EVIDENCE/local-business-subagents-gui-20261020\acceptance.json`，SHA-256 `3BC027205258ADE3160C3D6ACD738ED831E5AD53D7A4A69B22432F7208501A29`；`request-summary.json` SHA-256 `CBAE4F828E8F92549FE2BFFD2DCC189683862194E6886C4B58FE26C5B2489A40`。本机 mock 收到 10 次 HTTP POST，均 HTTP 200；10 指 HTTP 请求数，不是 GUI 消息数。脚本 SHA-256 `40F5E90CF6BC976B31A94E9276C672D13B861881EA3A549E7D0C2BC3873F51FD`。fixture TTY `85453` 受控停止 exit 0；相关端口已释放。
- **运行方式：** [x] 本地 source-mode 应用配合本机受控 SSE mock；测试 fixture 已停止。工具和本机 mock 读取/解析了演示数据；脱敏请求摘要及验收 JSON 不保存业务字段值、原始提示词或 headers。
- **平台状态：** [x] 验收覆盖原生 DSH subagent spawn/tool/完成通知机制、TradeLoom 工具和共享 Django 只读 API；不代表任一真实供应商模型或安装包已验。
- **风险与问题：** [!] 模型输出均来自本机模拟服务，不能称为真实 LLM 自主选择角色。业务 handoff 当前返回相对 Markdown URL，而 pinned renderer 会过滤相对链接；这是源码行为发现，尚未通过原生 GUI 复现为失败或修复。链接导航仍需窄范围验收。
- **下一步：** [-] 先在受控本机环境复现 center 工具返回链接能否从原生聊天进入 Agent Center；验证通过 proposal fragment 预填、用户手动解析预览和明确确认。不得放开任意相对 URL 或 `dsh-app:` 路由；真实供应商与手机测试仍独立未完成。

## 原生结构化提案交接与场景注册修复（2026-10-21，八字段）

- **当前阶段：** [x] 本地 source-mode 原生 GUI 已验证中心工具提案链接进入 Agent Center、受限 fragment 预填、人工解析预览并显式确认创建；新工作流 `a0618507cd91405ba0b986e50156ed75` 保持 `local_mock/simulated_rules`、状态 queued，两个子任务仍 queued 未执行。
- **已完成：** [x] 场景动态模块注册保留 Cordis 原始 context，并通过第二参数传入可信业务 origin 回调，修复因展开 context 丢失注入服务导致的场景无法加载。GUI 中 workflow/subtask/review 数量从解析前 1/2/0 到保存后中心 2/4/0；保存前候选标记为 `agent_proposal`、`human_confirmation_required`、`not_verified`，产品资料仍是演示数据。中心→资料助手单 child 与两个不同业务角色 child 的既有 mock 验收仍分别见前文记录。开源参考的源码/模板及边界见[参考审阅记录]（项目外证据文件：REFERENCE-NOTES.md；未随仓库提供）；只采用场景配置/面板注册方法，没有迁移独立预览 UI。
- **未完成：** [ ] 真实供应商模型理解/决策、实体手机与窄屏、p8 安装版更新验收仍未完成；本轮 queued 工作流没有执行。不得把本机 mock 结果称为真实模型决策。
- **测试结果：** [x] 脱敏原生 GUI 验收记录 [`acceptance.json`]（项目外证据文件：acceptance.json；未随仓库提供），SHA-256 `BD588C88E9AE237877490151C30791568F4BA99D5DE9885B9FE1DA6362340E20`；对应 summary SHA-256 `7C39307841F053F3133BEC0C3EBF5D18D66254C16F675472516D7D8EBA968B63`。本机 mock 3/3 POST HTTP 200，工具返回 `ok=true`、需人工审核数据对象，absolute origin/path/version/batch/goal/type 均匹配。Cordis/工具/renderer 定向门禁分别为 12/12、11/11、3/3，shell 18 pass、3 skip、0 fail；日志及 exit 记录见 `LOCAL_EVIDENCE/desktop-package-contract\cordis-scene-context-fix-20261021\`。这不是 Node 全套或 Django 重跑。
- **运行方式：** [x] 本地 source-mode 应用与隔离 SSE mock；fixture TTY 1353 已 stop，exit 0，PID 4044 已退出且 54899 已释放。GUI 链中曾观察到一次 `user input detected` 中断，之后重新观察到预填并完成解析/确认，故不称全程无人工干扰。
- **平台状态：** [x] 当前证据为 Windows 本地原生 DSH 容器中的 source-mode GUI；本轮不打包、不上传，也未更新 p8。没有触碰个人 DSH。
- **风险与问题：** [!] handoff 测试目录不在 package files allowlist 中，本轮未打包。自动审批拒绝移动/删除测试目录；当时原始短回执和具体拒绝理由未提供，不能推断。测试目录保留，未重试移动或删除。真实供应商、手机与安装版仍待单独验收。
- **下一步：** [-] 保持人工确认门禁，后续继续本地框架验收；只有真实模型/设备证据到位后再分别更新状态。无需为本轮结果自动打包或发布。

## 虚拟手机视口业务闭环与 CSV 预览样式修复（2026-10-21，八字段）

- **当前阶段：** [x] 本地 source-mode 界面已在 390×844 与 320×720 虚拟视口完成 workflow `a0618507cd91405ba0b986e50156ed75` 的执行、交付预览、演示审核和完成；reload/helper restart 后仍 completed、5 项 approved。
- **已完成：** [x] 复用已确认产品版本 v2/v3，本轮新产品 review 数为 0。两个依赖任务按 product→delivery 顺序完成，生成 5 个 v1 文件；文件 QA passed，覆盖 2 个演示产品；reviewer 标签为自动验收（演示），显式批准 5 项后工作流完成。HTML 与 CSV 均在同一 iframe 预览并可返回；CSV 预览使用项目 CSS 内联显示，同时保留原 CSP sandbox，SHA/source ID 可断行，表格仅由自身区域横向滚动。重启后原生 GUI 也复验 CSV 预览：项目主题样式生效、5 项 approved v1、713 字节及来源版本一致，截图见[原生 CSV 复验]（项目外证据文件：tradeloom-native-csv-preview-fixed-20261021.jpg；未随仓库提供）。原生 HTML Save As 保存到 `LOCAL_SCREENSHOTS/2026\10\18\01a14efa-72b3-7a63-8b40-a274f33629cf\tradeloom-proposal-native-catalog-20261021.html`，3,335 字节，SHA-256 `3f00b707cefbd03552e04508c93b8ee5cf8cae39204a1fd0328892234ce6e287`；IAB 顶层下载副本 hash 相同。
- **未完成：** [!] 实体手机和窄屏硬件、真实供应商模型、真人审核、native quit 生命周期仍未验；AgentArts 按用户要求豁免。p8 安装版未更新本轮源码。
- **测试结果：** [x] `workbench.tests.test_business_embed` 定向回归 9/9、exit 0；新 CSV 样式合同在旧实现上 RED 1/1、exit 1。日志：[RED]（项目外证据文件：red-focused.log；未随仓库提供）、[GREEN]（项目外证据文件：green-business-embed.log；未随仓库提供）。本轮无数据库连接，未重跑 Django 327 或 Node 全套。脱敏虚拟视口/工作流验收：[acceptance.json]（项目外证据文件：acceptance.json；未随仓库提供），SHA-256 `CEAE0357449D1A35F6FF1F66F43DF51CC200CA3E71EA6532BD6D876745619846`。
- **运行方式：** [x] Windows 本地 source-mode 应用；由官方 helper stop/start 载入当前源码，没有 sync、compile、package 或 upload。虚拟视口复验后已恢复默认 viewport。
- **平台状态：** [x] 原生窗口与 IAB 虚拟视口均有验收记录；验收 JSON 中 CSV body width/scrollWidth 在 390×844 为 319/319、320×720 为 249/249；表格宽度 245、内容宽度 2896、`overflow-x:auto`，宽表保留局部横滚。图片引用存在，但未验证图片像素。此项不是实体手机验收。
- **风险与问题：** [!] 所有业务资料均为演示数据，审核标签是自动验收（演示），不是企业事实或真人审批；本批虚拟视口验收未调用真实模型。本轮 IAB iframe 下载事件未捕获，但原生点击、Save As 保存及相同 SHA 的顶层副本均有证据，不能据 iframe 事件缺失判断下载失败。
- **下一步：** [-] 继续按本地优先推进真实 provider 与实体手机验收；未完成这些验证前不自动 stage/package/install。保留 p8 安装版边界，不将本地 source-mode 结果冒充安装版结果。

## 原生菜单退出与重开状态保持（2026-10-21，八字段）

- **当前阶段：** [x] Windows 本地 source-mode 原生 GUI 已验证应用菜单退出及重新启动后的状态保持。
- **已完成：** [x] 菜单退出后本轮 CLI、Electron、Django 进程均退出，3088/3090 释放；PostgreSQL 原实例继续运行。重新打开后 workflow `a0618507cd91405ba0b986e50156ed75` 仍为 `completed`、`local_mock/simulated_rules`，五个交付物保持 v1 `approved`，产品来源仍为 v2/v3；没有重新执行工作流。原生截图：[完成状态]（项目外证据文件：tradeloom-native-quit-reopen-completed-20261021.jpg；未随仓库提供）、[交付物状态]（项目外证据文件：tradeloom-native-quit-reopen-deliverables-20261021.jpg；未随仓库提供）。
- **未完成：** [!] 真实供应商请求与实体手机仍未验；p8 安装版没有本轮 source-mode 的改动。
- **测试结果：** [x] 退出/重开证据：[lifecycle.json]（项目外证据文件：lifecycle.json；未随仓库提供），SHA-256 `B70A6BC964A89EAB9C1A3DA10C10B8D478F00A9B8308D46704B0CC17ED1FDDFF`。本轮没有改代码或重跑自动化测试。
- **运行方式：** [x] 在原生应用菜单选择 Quit 后重新启动 source-mode 应用；未强制结束进程，未重启 PostgreSQL。
- **平台状态：** [x] CLI、Electron、Django 退出后已重新打开原生 GUI；既有工作流状态和交付物版本均保留。
- **风险与问题：** [!] 普通窗口关闭是隐藏窗口行为；本次菜单退出未出现确认弹窗，观察到应用进程正常退出。源码退出路径包含 `backend.close` / `platformView.dispose`，但本次未逐函数验证调用；源码虽包含 `before-quit` 确认逻辑，本次没有验证弹窗分支。本地演示状态不代表真人审批或真实模型运行。
- **下一步：** [-] 后续分别验证真实 provider 与实体手机；本次 source-mode 菜单退出结果不外推为 p8 安装版验收。

## 交付审核摘要与 Agent Center 说明（2026-10-21，八字段）

- **当前阶段：** [x] 审核语义窄修、定向回归及 source-mode 原生 GUI 真实 provider 验收均已完成；本批未打包或更新 p8。
- **已完成：** [x] API/工具保留 `reviews` 的业务事实语义并标记 `reviews_scope=business_facts`；`delivery_review_summary` 仅关联当前最新生成步骤的审核事件，避免从 `approved` 状态臆造审核，且不暴露备注或 request fingerprint。真实 DeepSeek Flash 原生会话已读取 product 与 delivery 两类演示资料；修复后第三个 delivery child 读取并准确区分业务事实 review 与交付审核摘要。真实模型还完成自然语言提案、澄清、可信链接预填及保存前人工确认门禁；业务状态仍为 2 项任务、4 个子任务、0 项待确认。工具结果与 GUI 摘要一致，实际工具调用 `ok=true`、`isError=false`。证据：[真实 provider GUI 验收]（项目外证据文件：acceptance.json；未随仓库提供），SHA-256 `4E9A682915A08A27D61BBE778398AF9AABFFF27951388EC7DBB55488E4CB46C5`。
- **未完成：** [!] 实体手机验收、企业规则访谈及将本轮源码更新到 p8 尚未完成；没有证明模型自动执行整条 workflow。
- **测试结果：** [x] 本批 RED 捕获工具/API 缺字段及旧响应兼容问题；GREEN 为 Node 定向测试 12/12、隔离 Django 定向测试 4/4。日志及隔离数据库身份见[测试验收 JSON]（项目外证据文件：verification.json；未随仓库提供）。本批没有重跑完整 Django/Node 套件。
- **运行方式：** [x] Windows source-mode 原生应用通过既有 provider 配置使用 DeepSeek Flash；只读演示数据。同步使用官方 helper stop exit 0 → sync-dev-bundle exit 0 → start；启动终端会话 12130，CLI PID 52148、Electron PID 54732、Django PID 22296。独立隔离 Django 测试使用 PG17 loopback fixture `127.0.0.1:55435`，测试结束后已正常停止并保留数据。
- **平台状态：** [x] 真实模型请求、两类业务 child 的只读工具调用及第三个 child 对审核摘要的复核已在原生 GUI 验证；provider 设置同步前后 SHA 保持一致。AgentArts/P6 仍按用户边界豁免；p8 安装版未包含本轮 source-mode 更新。
- **风险与问题：** [!] 工作流后续执行仍是 `local_mock/simulated_rules`；审核标签“自动验收（演示）”不是真人审批，读取的是演示数据，不是企业事实。验收 JSON 未记录资料字段值、原始提示词或 headers；真实 provider 的成功范围限于本批实际请求和两类只读工具，不外推为所有供应商、完整自主业务执行或生产业务验收。
- **下一步：** [-] 按本地优先继续实体手机和企业规则访谈；如需更新安装版，另行安排 p8 更新及验收。维持人工确认门禁，不把真实模型读工具/提案验收扩写为自动完成工作流。

## 本地开发入口说明校正（2026-10-21，八字段）

- **当前阶段：** [x] README 与快速开始已区分本机已验证的 candidate7 source-mode、仓库通用默认 candidate2 和历史 p8 安装版状态。
- **已完成：** [x] 首选本机桌面快捷方式，并记录本机 runner 的真实 `start`/`stop` 命令、独立 DataRoot、状态核对方式和普通窗口 X/菜单退出区别；说明该 runner/runtime/DataRoot/API 设置在仓库外，不随 clone 提供。产品不要求 DeepSeek 官方账号登录，模型 API 按织贸助手自有配置说明。
- **未完成：** [!] 实体手机及更广厂商/协议验收仍未完成；p8 首启曾报 Web RPC failure，且没有本轮 source-mode 更新。
- **测试结果：** [x] 本批未运行测试套件或服务；只读核对 `workbench-control.mjs` 仅接受 `start|stop`、其显式指定 candidate7/runtime 与 DataRoot，`cli.mjs` 解析 `--runtime`，仓库默认值为 candidate2。文档引用目标存在，`git diff --check` 通过。
- **运行方式：** [x] 文档给出本机 runner 原支持命令，桌面快捷方式为首选；本轮未启动或停止应用。跨机器保留通用 PowerShell 启动说明，明确其 runtime 预设和准备条件。
- **平台状态：** [x] source-mode 已有真实 DeepSeek Flash 的有限提案/澄清与只读工具调用证据；后续业务执行仍为 `local_mock`/`simulated_rules`。p8 安装和资源核对曾通过，但其历史首启故障与本轮 source-mode 验收分开记录。
- **风险与问题：** [!] 本机 runner 和依赖 runtime、数据、provider 配置位于仓库外，不能直接用于其他电脑或新 clone；PowerShell 通用包装脚本不接受 runtime 参数，非默认候选需显式使用受支持的底层 CLI 路径。没有记录 API Key 或授权 URL。
- **下一步：** [-] 本机优先使用“织贸助手（本地开发）”快捷方式。跨电脑演示前，应先准备该机器自己的受控 runtime、数据根和 provider 配置；实体手机验收按应用实际显示的连接入口进行。本批未打包、安装或上传。

## 外部条件受阻收口（2026-10-21，八字段）

- **当前阶段：** [!] 原目标仍未完成；连续三轮收口审计中的关键外部条件没有变化。
- **已完成：** [x] source-mode 本地框架、真实 DeepSeek Flash 有限提案/澄清及只读工具调用已有证据；后续业务执行仍为 `local_mock/simulated_rules`，保留人工确认门禁。
- **未完成：** [!] 企业访谈尚未确定同款异规格、来源冲突等业务规则；同 Wi-Fi 实体手机验收仍缺实际设备与连接结果。其他厂商的真实调用需相应 API 配置与请求证据。
- **测试结果：** [x] 本轮未运行测试。历史 Node 全目录的两项环境失败已有 candidate7 runtime 下 profile-contract 定向 2/2 记录；本轮未重跑，不将历史红灯写作当前产品失败或全套通过。
- **运行方式：** [x] 本轮只更新收口记录，未启动或停止应用、服务，也未登录或读取新凭据。
- **平台状态：** [x] 本地 source-mode 已支持当前可复核的演示流程及有限真实模型工具范围；演示业务执行标记仍为 `local_mock/simulated_rules`，不能据此声称真实模型完成整条业务流程。
- **风险与问题：** [!] 现有证据下没有可独立补齐的本地实现缺口。AgentArts/P6 是用户豁免，安装包更新按本地优先暂缓，均不列作必须阻塞条件；原目标整体仍未完成。
- **下一步：** [-] 待企业规则访谈结果和实体手机验收证据到位后，再确定对应规则与验证范围；其他厂商按各自配置单独验收。不要求用户重复提供已有授权 Key。


## BingusSharedLoader 方法审计基线（2026-10-21，八字段）

- **当前阶段：** [x] 已完成固定上游 commit `9471bcb16f3a479efdff3e0520def4573ae0a028` 的只读方法映射；本记录不是 TradeLoom 全项目完成声明。
- **已完成：** [x] 最终清单包含 16 项作者方法、43 个独立子项、6 项专用机制不采用、3 项审计观察；66 个文本源已读，2 个 PNG 仅核对清单。逐项报告见[方法审计](verification/2026-10-21-bingus-methodology-audit.md)，机器记录见 `testing/desktop-package-contract/bingus-audit-20261021/methodology-audit.json`。
- **未完成：** [-] 统一 Agent 注册表、共享协作 DTO、受控 ERP 草稿写入/回读、图像/网页扩展桥及新增模块示例仍是产品缺口；安装版、实体手机、Dockview 鼠标标签拖放也没有本审计新证据。
- **测试结果：** [x] 本轮未运行测试。引用的 renderer 7/7、shell 42 pass/5 skip、Django 327/327均为冻结记录/历史记录，不是本轮执行；旧 Node 131项为121/2/8、exit 1，其 candidate7 profile 定向2/2只修正该文件。另有163/2fail摘要未定位完整日志/命令/exit，明确保持不可定位。
- **运行方式：** [x] 只读核对既有方法源、当前冻结清单、验收记录与测试证据；未启动/停止应用或服务，未读取凭据/会话，未发送 provider/ERP 请求。
- **平台状态：** [x] 本机Site主题GUI记录与当前25项source manifest hash相符；真实DeepSeek Flash证据限于演示数据下提案/澄清及只读工具。业务执行仍是 `local_mock/simulated_rules`。
- **风险与问题：** [!] 不将旧131项、不可定位的163项摘要或旧Django全套结果外推到当前源码；固定上游的tracked 68与allowlist 63相差5项，`--git`清单检查会失败，但本轮没有运行该脚本。AgentArts/P6为用户豁免；安装版按本地优先边界保留。
- **下一步：** [-] 逐项选择当前未完成leaf补实现或证据；运行时、实体手机、真实企业事实和安装版状态各自按目标范围验证，不能以本方法审计替代。

## 协作 DTO 与 adapter 接缝（2026-10-21，八字段）

- **当前阶段：** [!] Phase 2 协作投影与扩展接缝已实现并通过两个 Django 测试模块的定向回归；整体目标仍未完成。
- **已完成：** [x] `GET /api/workflow-tasks/{id}` 保留原响应并增加协作 envelope v1；投影复用既有公开序列化结果，仅额外读取当前任务最多 100 条 EventLog 安全元数据。原始 `payload_summary` 不进入 envelope，未知错误映射为固定摘要。图像生成与网页模型桥仅有服务端注入 Protocol；默认 `not_configured`，注入对象也不会被报告为 `ready`。
- **未完成：** [!] 没有真实图像生成或网页模型桥实现/调用；协作 envelope 尚未接入外部协作者，也不复制 DSH 原生聊天。ERP 写入、受控草稿回读/审计及真实 ERP 服务仍未完成。
- **测试结果：** [x] 新约束 RED：隔离 Django 定向模块 26 项中 2 error、1 failure，暴露旧 ORM 输入投影与缺失 `web_model_bridge` 接缝；GREEN：同模块 26/26、exit 0。RED 与 GREEN 使用新建且互不复用的测试库 `tradeloom_test_phase2_red_20261021_02`、`tradeloom_test_phase2_green_20261021_03`。测试运行记录 ID 分别为 `2026-10-21T064453-811Z-59276` 和 `2026-10-21T064615-181Z-28140`，原始日志保存在项目外验收证据；另有 Python 编译和 JSON Schema 解析检查通过。没有重跑完整 Django 套件。
- **运行方式：** [x] 测试只使用独立 PostgreSQL 17 loopback `127.0.0.1:55435` 与外部测试 Python 环境；产品 `.venv` 和业务数据库 `55432` 未触碰。测试库按 runner 的 keepdb 规则保留。
- **平台状态：** [x] API 可从既有 workflow serializer 投影稳定 DTO；健康接口仅返回不含配置秘密的 adapter 能力元数据。未调用图像、网页或 ERP 外部服务。
- **风险与问题：** [!] 26 项只覆盖 `test_prepare_workflow` 与 `test_agentarts_adapter` 两个模块；不代表整个 Django 应用、客户端协作或供应商集成已通过。EventLog 记录的是事件元数据，不等价于外部消息或真人审批。
- **下一步：** [-] 在保留当前人工确认门禁的前提下，分别为协作调用方、图像生成和网页模型桥设计有来源约束的具体 adapter；配置真实 provider 前保持未配置状态，不扩写业务规则。

## 助手 MCP / Skill 能力只读面板（2026-10-21，八字段）

- **当前阶段：** [!] 固定路由和顶部助手菜单能力面板已实现；本轮完成 candidate7 定向 Node 与 pinned renderer 门禁，整体框架仍未完成。
- **已完成：** [x] `GET /tradeloom/agent-capabilities?role=...` 只接受已发布 role。服务端核对持久 role→preset binding、live Agent ID 及 DSH `composedPreset(agent.ctx)`；live preset 不符或服务不可用时 fail closed。tools/Skill 只投影白名单摘要，不接受客户端 session ID、不 resume、不导出路径、prompt 或原始异常。未绑定时仍可显示该预设的 MCP 声明状态，但工具与 Skill 保持未知；`declared_only` 不表示已连接，`visible_tool` 不表示健康或已成功调用。菜单支持 role 选择、失败重试和过期响应隔离。
- **未完成：** [!] 本轮改动尚未同步到运行副本，也没有针对能力面板的实机 GUI 验收；没有 MCP/Skill 的编辑、逐项授权或连接健康 API。此只读展示不表示实现了用户级能力分配。
- **测试结果：** [x] 两项新增 scope 回归先 RED 后 GREEN：旧实现未核 `composedPreset` 的回归 6 pass/1 fail；修复后 capability+scene 定向测试 27 项，25 pass、2 个可选依赖 skip、0 fail。最终 shell Node suite 115/115、exit 0、0 skip；launcher 58 项，54 pass、4 skip、0 fail、exit 0；candidate7 pinned SlotTestRuntime renderer 7/7、exit 0。launcher 的4个 skip 均要求独立冻结 Stage 6 bundle inventory fixture，未以 candidate7 代替。
- **运行方式：** [x] Shell 命令为 `pnpm --dir packages/tradeloom-shell test`；launcher 使用 PowerShell 收集 `apps/tradeloom-launcher/tests/*.test.mjs` 后执行 `node --test --test-reporter=spec @files`。环境变量名为 `TRADELOOM_DSH_TEST_RUNTIME`、`TRADELOOM_DSH_WEBSERVER_LIBRARY`、`TRADELOOM_DSH_TOOLS_LIBRARY`、`TRADELOOM_REACT_LIBRARY`、`TRADELOOM_REACT_SERVER_LIBRARY`、`TRADELOOM_CORDIS_LIBRARY`、`TRADELOOM_CORDIS_LOADER_LIBRARY`、`TRADELOOM_DSH_PINNED_SOURCE`、`TRADELOOM_DSH_APP_BOOT_LIBRARY`、`TRADELOOM_CORDIS_INCLUDE_LIBRARY`，值均指向 candidate7 内对应已编译库；未设置 `TRADELOOM_STAGE6_BUSINESS_SHELL`。pinned renderer 命令为 `pnpm exec vitest run --config <repo>/testing/desktop-package-contract/main-slot-renderer/vitest.config.mjs --reporter=verbose`。实际日志与 exit 文件保存在项目外验收目录 `LOCAL_EVIDENCE/desktop-package-contract/agent-capabilities-final2-20261021/`。本轮未重跑 Python；此前隔离 PostgreSQL `workbench.tests` 全套 357/357、43.353 秒、exit 0（run `2026-10-21T072416-295Z-24040`，result JSON SHA-256 `A333461144A81C68CA9FCD451295492ADF3FD59DD8C95C3A4B2890A5E53BDB9A`）属于先前证据，不验证本次客户端面板。
- **平台状态：** [!] 既有 Site 主题 GUI 记录绑定 bundle SHA-256 `48813c1be56f59c600bf5092e04b9f8aaa5855d947d27f191e46dd979ce33618` 与 manifest SHA-256 `A58CD94C45795771BB5C634FCDD73F1BBEABD03B06C3F23A8DAFEAB96C916B2C`；它早于本次能力面板修改。本轮没有同步、重启或新 GUI 证据，不将旧截图用于证明新面板实机通过。
- **风险与问题：** [!] 能力目录来自 DSH 当前服务快照，其显示的是给定 role 的当前可见工具与 Skill 元数据；MCP 仅报告预设声明或模型可见工具名，不能推出服务端连接状态。项目整体仍有其他未实现/未验收项，Bingus 43 项审计状态不因本窄功能自动变绿。
- **下一步：** [-] 主控审阅本次 diff 后再安排同步，并在明确 source/runtime bundle 对应关系后验收窗口内的菜单、未绑定 MCP 声明和 live preset mismatch 显示；继续按 Bingus 审计逐项关闭其余真实缺口。

## 本地插件与技能资产同步记录（2026-10-21，八字段）

- **当前阶段：** [x] 已完成本地 DSH 插件/Skill 资产导入后的受保护 profile 恢复与官方同步；此记录不是应用 GUI 验收或全项目完成声明。
- **已完成：** [x] 20 个插件（保留原 18 个桌面插件的版本与状态，并加入 2 个 Web 扩展）和 22 个共享 Skill 已导入；BetterSidebar 原禁用状态保留。Memorax headless 状态依赖个人 state/home，本次没有复制；需先独立隔离初始化，避免迁移个人状态。
- **未完成：** [-] 本次未启动应用，也未做插件/新 UI 的窗口验收；用户选择暂不测试。ERPNext 服务仍未部署或连接，插件导入不代表 ERP 集成或 Agent 能力已验收。
- **测试结果：** [x] Profile 恢复与官方 bundle 同步各 exit 0；同步后 23 项 source/runtime/profile 哈希与记录一致。新 bundle SHA-256 `045e95445637b0e077c714da06bc6db9f97daa06796b1d8463f09641f7855b6f`。脱敏运行证据在项目外 `<LOCAL_EVIDENCE_ROOT>/evidence/plugin-import-other-profiles-20261021/bundle-restore-sync-20261021.json`；本次未运行测试套件。
- **运行方式：** [x] SDK 插件安装后，现有 profile business module 缺失；使用受保护的 `prepareProfile(source=<已核验的旧运行时副本>)` 恢复，再运行官方同步。ownership/hash guard 保持启用，没有改写其他插件配置或选择。
- **平台状态：** [x] 本地 bundle 已同步；此状态只说明资产和配置副本哈希对齐，不说明新进程已加载或插件可用。
- **风险与问题：** [!] 不迁移绑定个人 state/home 的 Memorax 数据；原生应用未启动，因此插件可见性与交互仍未验。完整 Bingus 方法审计中的其他缺口保持原状态。
- **下一步：** [-] 用户安排允许重新打开应用后再核验插件菜单与能力面板；ERPNext 部署另行处理。本地 source-mode 仍是当前交付路径。

## ERPNext 草稿计划与 PowerShell 参数定向复审（2026-10-21，八字段）

- **当前阶段：** [!] 本轮只补齐 Quotation 草稿操作计划和既有 PowerShell 配置参数修复的审查记录；未实施草稿写入代码。
- **已完成：** [x] 草稿计划已明确 create/update 为不同的幂等操作：服务器生成 operation ID，update 使用新 key 和 `target_operation` 关联；旧成功收据不可由后续 update 或新的远端读回改写。fingerprint 绑定 action、instance、target、expected `modified`、规范化 payload 与 workflow。
- **未完成：** [-] ERPNext 草稿 API、持久操作模型/迁移、写入工具和表单均未实现；Quotation 修改的原子 `modified` 条件仍待固定版本直接证据。未创建或修改业务记录。
- **测试结果：** [x] PowerShell 显式空/空白 `-ErpNextConfigFile` fail-closed 修复的 Query scoped 复审已通过：Important addressed，双轴复审无剩余 Critical/Important。修复后仅有静态 PowerShell parse 与 `git diff --check` 检查；未运行测试套件。精确审查 artifact 为 `<LOCAL_EVIDENCE_ROOT>/desktop-package-contract/erpnext-live-review-20261021/scoped-fix-review.txt`，SHA-256 `10532D541597E5477E41273344B8442161308240F3228BBB9479BBDF968F2CC6`。
- **运行方式：** [x] 本轮没有启动软件、服务或 ERPNext；没有做数据库迁移、远端写请求、GUI 验收、提交或推送。
- **平台状态：** [x] launcher 脚本 SHA-256 `DD3B9D065BA01689F3333DAEA0C6761AF6FD6DCB4365E923134BDA95B71AC06B`。ERPNext 查询面板源文件 `packages/tradeloom-shell/client.scenes.js` 当前 SHA-256 `270EE39AB3B899190650FC4C589BA3C9B360F5C2C977F2D09E41A28EC9386567`；本轮未修改此文件。
- **风险与问题：** [!] CSRF 与本地 DSH request-rejection 是同源请求保护，不是多用户身份认证；浏览器请求不得用 `role` 或 `actor` 字段授权。Agent 写入只可按可信 DSH 执行 preset 检查。结果不确定时必须保留 operation 状态并禁止自动重发。
- **下一步：** [-] 先由主控审阅 [草稿写入计划](superpowers/plans/2026-10-21-erpnext-draft-write.md)及原子更新条件证据；草稿实现须另行开始。本轮 Query scoped 复审不等于 launcher runtime 验证，也不证明 ERPNext 已配置或可写。

## ERPNext Quotation 草稿后端首批（2026-10-21，八字段）

- **当前阶段：** [!] 固定 Quotation create/update、操作预留与只读调和代码已实现；隔离测试和部署服务验证尚待完成，整体草稿与框架目标仍未完成。
- **已完成：** [x] 新增 `ErpNextDraftOperation` 模型及手写迁移；Django 增加固定 POST 创建、GET 操作读取和 PUT 条件更新。操作由服务器生成 ID，按 ERP instance + 幂等键预留，fingerprint 固定 action/instance/target/expected modified/规范化 payload/workflow。相同请求不重发，不同请求冲突；请求身份与成功收据不可改写。创建仅固定 `Quotation`，强制 `quotation_to=Customer`，限制字段/数值/日期/明细数量；create/update 均回读确认 `docstatus=0` 后记录独立收据。更新将 `modified=expected_modified` 交给 Frappe 事务校验。失败或读回不确定保留状态与已知 ERP name；GET 把不可变操作收据与当前远端只读状态分开。既有七类只读 API 未扩展。
- **未完成：** [!] 官方源码证明不等于部署镜像实际条件更新已验；本轮没有真实 ERP 请求、业务单据或数据库迁移。Agent 写工具与场景草稿界面仍未实现。提交、取消、删除、库存仍不开放。
- **测试结果：** [x] 最终定向回归 42/42、exit 0、0 skip，Django system check 无问题；首次运行的 3 项失败来自假 client/测试断言与固定 client 契约不一致，已修正夹具后在新数据库重跑。测试包括草稿 API、ERPNext adapter 与只读 API；没有用测试替身声称真实 Frappe 已通过。
- **运行方式：** [x] 命令为 `node <RUNTIME_ROOT>/local-dev/django-phase2-test-runner-20261021-01/run-django-tests.mjs test --test-db tradeloom_test_phase2_erpnext_20261021_04 workbench.tests.test_erpnext_draft_api workbench.tests.test_erpnext_adapter workbench.tests.test_erpnext_api`；外部隔离 runner 在 loopback PostgreSQL 55435 上创建并保留了唯一测试库，`keepdb` 保留测试数据。日志目录 `<RUNTIME_ROOT>/local-dev/django-phase2-test-runner-20261021-01/runs/2026-10-21T102028-006Z-46324/`，`result.json` SHA-256 `3C42BF3449762721DEA26690F9DF71842348B5A63D376039B2DDB34FD73EE3E4`。业务数据库 55432 未触碰。
- **平台状态：** [x] 浏览器写 API 沿用同源 Django CSRF，不接受请求体中的 `role`/`actor` 授权；记录来源为 `local_workbench`，不声称已认证的自然人身份。没有同步运行 bundle 或 GUI 验收。
- **风险与问题：** [!] 更新依赖 ERPNext 事务内 `modified` 比较；实现依据官方 Frappe v16.52.0 tagged source，部署镜像与并发冲突响应仍待集成验证。超时/不确定结果不得自动重发。隔离测试证明模型与 migration 在测试数据库可创建，不代表业务库已迁移。
- **下一步：** [-] 主控审阅后再安排部署镜像条件更新集成验证、Agent 工具与界面阶段。本记录不代表 ERPNext 已部署、草稿业务可用或全目标完成。

### 条件更新增量（2026-10-21）

- 官方 Frappe v16.52.0 源码审阅支持在固定 `PUT /api/resource/Quotation/{name}` 请求内携带 `modified=expected_modified`：`frappe/api/v1.py:update_doc` 先锁定文档再应用 payload；`frappe/model/document.py:check_if_latest` 在保存时比较锁定行与传入原始版本。实现仅认定响应中的 `TimestampMismatchError` 为版本冲突，不把所有 HTTP 417 都误判为冲突。该证据来自官方 tagged source，不等于已对部署镜像完成集成验证。
- 当前代码新增独立 update operation：每次更新使用新幂等键与服务器 operation ID，引用已成功的同实例目标操作；fingerprint 绑定 action、instance、target、expected modified、规范化内容与 workflow。成功目标的历史收据保持不变。操作结果不确定时不自动重发；冲突记录为终态，之后只允许读取/调和。
- 已增加更新成功、不可变 create receipt、相同键重放、异 fingerprint 冲突、工作流/目标限制、版本冲突和不确定结果的定向测试源码。最终隔离 PostgreSQL 定向测试 42/42、exit 0；Django test runner 在专用新测试库应用了迁移。没有发起真实 ERP 请求或业务单据写入。
- 未开放提交、取消、删除、库存写操作；Agent 写工具与桌面草稿 UI 仍未实现。不能据官方源码审阅声明 ERP 草稿写入已通过真实服务验收。

### 崩溃安全与并发幂等增量（2026-10-21）

- **当前阶段：** [!] 本轮修复仅覆盖 Quotation 草稿服务/API 的本地持久状态与幂等写入资格；ERPNext 部署镜像的真实 CAS 集成仍待验证。
- **已完成：** [x] 新 create/update 操作在网络副作用前提交为 `outcome_unknown`。只有首次创建操作行的原始请求（`created=true`）可获得一次写入资格；同键并发请求只读取/调和，不发送第二次远端写。旧版 `reserved` 行在重放或读取时保守升级为 `outcome_unknown`，不推断远端失败。无 `remote_name` 的未知操作保留不确定状态。回读 `modified` 需通过格式与日历值校验，且与 `external_ref.modified` 一致后才可成功；保存原始字符串供后续 update 精确使用。
- **未完成：** [!] 未对真实 ERPNext 发送写请求；与部署镜像的 Frappe 条件更新竞态尚未集成验证。ERP 草稿 Agent 工具和场景表单仍是后续工作。本轮没有启停产品或 GUI 验收。
- **测试结果：** [x] 首次 RED 在隔离 PostgreSQL 55435 上 24 项中 5 项失败，暴露预留仍为 `reserved`、无效 `modified` 可成功等问题；失败日志位于 `<RUNTIME_ROOT>/local-dev/django-phase2-test-runner-20261021-01/runs/2026-10-21T103905-234Z-50004/`，`result.json` SHA-256 `E38F6005B002AD0483EE7164D61FD45F8C61EAB701033180EB85722D7FC5429A`。修复后草稿 API 模块 26/26、exit 0；最终与 ERPNext adapter/API 合并定向回归 49/49、0 skip、exit 0，Django system check 无问题。
- **RED 证据范围：** 上述 5 项失败早于后续保存路径对终态更新增加锁内 fresh-state 检查；它们证明的是预留状态与 `modified` 校验问题，不是那项终态并发修复的配对 RED。该终态修复没有留存修复前失败日志，当前可引用的证据是修复后的隔离 PostgreSQL 定向/并发测试结果；不应将其表述为 RED→GREEN。
- **运行方式：** [x] 最终命令：`node <RUNTIME_ROOT>/local-dev/django-phase2-test-runner-20261021-01/run-django-tests.mjs test --test-db tradeloom_test_draft_outcome_final_20261021_02 workbench.tests.test_erpnext_draft_api workbench.tests.test_erpnext_adapter workbench.tests.test_erpnext_api`。使用 runner 新建的专用隔离测试库并保留数据；最终日志在 `<RUNTIME_ROOT>/local-dev/django-phase2-test-runner-20261021-01/runs/2026-10-21T104440-853Z-41752/`，`result.json` SHA-256 `92D7888710A3FE4F9A54B4121421FE4F667A6646A49D4CFC79DCD3C85475DD47`。并发用例是 `TransactionTestCase`，由两个独立线程/数据库连接发起真实 Django API 请求；阻塞远端 fake 后证明同 payload 最多一次写、异 payload 返回 409；另一用例模拟预留后硬中断并证明重放不再创建。业务数据库 55432 与真实 ERPNext 均未触碰。
- **平台状态：** [x] API 对 `outcome_unknown` 继续返回 202；兼容 envelope 的 `ok=true` 仅表示请求被接收，调用方必须只以 `status=succeeded` 作为成功。当前没有 ERP 草稿工具或表单消费者，因此后续 UI/工具应遵守该状态约定。
- **风险与问题：** [!] 隔离数据库并发测试证明的是 Django 预留/幂等串行化，不证明部署 Frappe 镜像的条件更新或跨系统 exactly-once。状态未知时不得自动重试写入。
- **下一步：** [-] 冻结本轮后端 diff 供独立审查；其后再开展 ERP 草稿工具/UI 和经授权的部署镜像 CAS 验证。本记录不表示 ERPNext 已部署或写入流程已对真实服务验收。

## 共享场景卡片间距与本轮回归（2026-10-21）

（同步前基线；GUI 状态已由下方“最终窗口复核增量”更新。）

- **当前阶段：** [!] shell Dockview 面板和 Django 业务嵌入页已统一使用共享间距变量；本轮没有运行 GUI，因此新间距仍未做原生窗口验收。
- **已完成：** [x] shell 场景外边距、Dockview 标签栏与面板操作区采用统一 inset；iframe 页面内部单独使用页面/卡片 inset；窄屏沿各自 token 收缩。原生聊天保留其自身布局和内部留白，Dockview sash/面板宽度计算未改。深浅主题继续使用既有 Site tokens。
- **未完成：** [!] 当前 source 已由主控官方同步并在后台启动；本批卡片间距尚未做 GUI 复验，因此不声明间距效果通过。没有改变 ERP 服务配置或业务数据。整体产品目标仍未完成。
- **测试结果：** [x] Django `workbench.tests` 389/389、exit 0；Node shell 121/121、exit 0、0 skip；launcher 61 项中 57 pass、0 fail、4 skip；candidate7 pinned renderer 7/7、exit 0。Django 使用独立 PostgreSQL 55435，未触碰业务库。Launcher 的四项 skip 均是旧 Stage 6 payload 专项：精确11文件旧bundle的升级/未知编辑拒绝、链接manifest拒绝、旧bundle交换中断恢复、缺失bundle且无可信备份时拒绝；`TRADELOOM_STAGE6_BUSINESS_SHELL` 未设置，candidate7 是当前bundle而不是该历史冻结payload，不能替代它们。
- **运行方式：** [x] Django 命令为 `node <RUNTIME_ROOT>/local-dev/django-phase2-test-runner-20261021-01/run-django-tests.mjs test --test-db tradeloom_test_spacing_20261021_01 workbench.tests`，run ID `2026-10-21T120157-034Z-48700`，结果 `result.json` SHA-256 `76EFA445B0EE4CF2C39C901083B7836E629D9E653F1CD3A848DCB47931E86584`。Node 日志目录 `<LOCAL_EVIDENCE_ROOT>/ui-spacing-20261021/` 中，shell `shell-node.log` SHA-256 `B68E763B01CFCF48E20AAA15220BB73BE7D99917DA9B0EFFC065F5A90F3B42FD`，launcher `launcher-node.log` SHA-256 `80E219FB945DA6F2406367FB7B10D19E9292F2F60AE59F0F3F3DBF2600896D7E`。renderer 使用 candidate7 的 `pnpm exec vitest run --config <repo>/testing/desktop-package-contract/main-slot-renderer/vitest.config.mjs --reporter=verbose`。测试没有包含真实 ERP 写入或模型请求。
- **平台状态：** [!] 本批冻结源 `client.scenes.js` SHA-256 `326FD6F2E87CCF97B6A2CA36ACFB33E45276FC7F93F633AAF32C150CE5BAC12B`；`styles.css` SHA-256 `8A44CACF1C1AA81C6B65316AB3122A51AF14009F18255B1E115D31896E4181A8`。focused diff 位于 `<LOCAL_EVIDENCE_ROOT>/desktop-package-contract/scene-spacing-20261021.patch`，SHA-256 `19D7989F7541628EE0FBE9E1D2A30482010603A2F998836795EF928B3A777E53`。本轮 GUI 操作收到 Escape 中止，未以旧版窗口或历史截图推断新间距效果。
- **风险与问题：** [!] 方法审计既有43个leaf状态没有因本轮综合测试自动更新。当前确切未验证项包括：新 spacing 的 GUI 效果，以及本地 Django 到 ERPNext 的真实读取、Quotation 条件更新与草稿回读。远端 ERP 服务健康且八个 token GET 均返回 HTTP 200；本地私密配置已导入，但当前运行的 Django 尚未启用该配置，所以这些检查不是 TradeLoom 集成验收。正式提交、取消、删除和库存写操作按既定边界未开放；图像/网页桥是预留接缝，不是本批必做 provider。此前已实机查看能力面板，以及20项插件资产（19项安装、另含 Codex experimental；14项为更新）和22项 Skill/52个文件；本轮没有重验这些功能。
- **下一步：** [-] 由主控在用户方便时对冻结source运行副本做卡片边距实机检查；另按授权安排 ERP 服务只读与草稿 CAS 集成验证。四个 launcher Stage 6 skip 只有找到对应的原始冻结payload后才能补验，不能用 candidate7 冒充旧版本。

### 最终窗口复核增量（2026-10-21）

本节更新上节“间距待 GUI 复验”的时点状态；保留此前的中断记录作为历史，不据此推断其他未验功能已完成。

- **GUI 结果：** [x] 七个场景的卡片留白、日夜主题、侧栏及 MCP/Skill 能力面板滚动是在前一同步 bundle `a2e86a34bcdba5216c372172054885a64b14c0aea66d2be40426347a03e9fdb5` 上逐页检查。最终 bundle `babaee741aa6be4a7d3b3e35453c4b771d44d7aa110b32c16a2e944848ec8491` 只重开桌面检查工作总览、ERP 新中性文案与已连接的 DEMO Item 列表，并检查 621×627 窄屏菜单、主题和单面板切换。分阶段证据 JSON 位于项目外 `workspace/testing/ui-spacing-20261021/ui-verification-final.json`，SHA-256 `6dfff530f317224cbcdcc6d36b2f555f76e2e60a2cfe2cbe819c091b19f5b4e0`，记录五张外部截图的 hash；截图不纳入 Git。
- **窄屏结果：** [x] 621×627 窄窗口下顶栏可见；助手选择器可展开且 hit-test 命中；meow-smooth FAB 与选择器保留间距；单面板切换成功，页面无横向溢出。已观察 system/light 与 dark 切换。该 GUI 结果不表示实体手机已验收。
- **未证明项：** [!] 本轮原生自动化对 Dockview 标签拖动只选中了参考标签，不能证明标签移动/停靠成功；此前有效拖放证据仍仅限其记录时的旧 bundle。没有发出新的 LLM/付费请求。Quotation 写入仍为先前的 HTTP 202 `outcome_unknown/forbidden`，无远端名；没有重发、更新或 CAS。远端只读快照显示11类交易计数为0，但不证明未知请求绝无副作用。
- **范围：** 整体目标未完成。最终 GUI 只更新本节列出的界面观察，不改变 Bingus 43 项 leaf 状态，也不把 ERP 真实读成功外推为写入闭环。

## 同步前记录：窄屏可见性与 ERPNext 403 核对（2026-10-21，GUI 状态已由上方最终窗口复核更新）

- **当前阶段：** [!] 修复了自有 shell 顶栏在窄侧栏收起状态下继承插件 `visibility:hidden` 的问题，并将三处页面间距改为既有共享 token；真实窗口需等本次同步后复验，不能由 Node 结果代替。
- **已完成：** [x] `.tl-shell-top` 明确恢复 `visibility:visible`，没有修改第三方插件；针对插件固定左上 FAB 在 `html[data-meow-smooth-furled]` 状态再为首行 `.tl-top-model-row` 预留 `66px`（既有10px内距加56px FAB）。`.review-image-candidate`、`.state-grid`、`.runs-layout` 使用既有间距变量。样式契约同时断言可见性与该 furled-only inset。
- **测试结果：** [x] candidate7 React/ReactDOM server/Cordis 下 `node --test tests/scenes.test.js` 为 23/23 pass、0 skip、0 fail，exit 0。此项证明样式规则合同，不证明 FAB 不再遮挡实际控件。随后隔离 PostgreSQL 55435 的 `workbench.tests.test_erpnext_draft_api` 为 32/32、exit 0；run `2026-10-21T133741-872Z-46892`，`result.json` SHA-256 `7B48ACE1C2A70829C95B37509F1ED4A8C7C52D8C4801FACB68C9F6A092F4B666`，stdout SHA-256 `1A8763774B6CEFE180859B128B07EFAEB85798556340127BF3A78D83D216ED98`。其中新增 403 回归单测另有 1/1、exit 0 的隔离运行记录，见项目外 `LOCAL_EVIDENCE/erpnext-live-20261021/http403-test-run.md`；当前模块重跑仍包含该用例。
- **外部 ERP 证据：** [!] 项目外安全 checkpoint `LOCAL_EVIDENCE/erpnext-live-20261021/checkpoint.json` SHA-256 `C372C3E08E9F5602D068F7D9F3E53984F2E014E0BB5AE66DD858AC216A074FB4` 记录七类白名单 DocType 列表均 HTTP 200，状态接口与一条记录详情读取也成功。唯一一次 Quotation 创建请求返回 HTTP 202；随后只读操作查询显示 `outcome_unknown`/安全错误 `forbidden` 且没有远端单据名。没有重发、更新、CAS 竞态或自动重试。HTTP 403 不证明远端没有副作用。独立远端只读证据 `LOCAL_EVIDENCE/erpnext-engine-20261021/deployment/quotation-readonly-hook-evidence-20261021.json` SHA-256 `AA1A2FDE7C3377E5EC5C14FB33E73D3FB1A6239000841C4DC9E4A6C177BE16EA`（UTC `2026-10-21T13:41:51.639290+00:00`）显示只读事务前后 11 类交易计数均为 0；这是当前远端快照，不证明该 Quotation 请求没有副作用，也未确定 403 的完整原因。
- **未完成：** [!] 真实 Quotation 创建未确认成功；更新和部署 Frappe 的 `modified` CAS 未执行。提交、取消、删除和库存写入仍关闭。主控在修复前于 621×627 收起侧栏窗口实测：顶栏已重新可见、导航可用，但 `meow-smooth` FAB 覆盖助手首行入口，`elementFromPoint` 命中该 FAB。现源码已按已核定方案预留 FAB 空间并通过定向合同测试；修复后的窗口结果仍待主控复验，此前遮挡现象保留为修前实测记录。
- **范围边界：** [x] 早前 Django 全套 389/389、exit 0 仍是该次全套结果；本轮 32 项是草稿 API 模块定向回归，不把二者相加或称为 400 项全套。全局插件/Skill 已有此前资产与 GUI 证据；图像/网页桥仍为预留接缝，不因此增加接入任务。
- **运行方式：** [x] 本轮 shell 命令以环境变量指向 candidate7 的 React、ReactDOM server 与 Cordis：`TRADELOOM_REACT_LIBRARY`、`TRADELOOM_REACT_SERVER_LIBRARY`、`TRADELOOM_CORDIS_LIBRARY`；候选运行库绝对路径留在本机记录中。Django 使用隔离 runner 新库 `tradeloom_test_forbidden403_20261021_01`，未访问业务 PostgreSQL。
- **平台状态：** [!] 主控已完成同步/重启和该小窗口实测；此证据只确认顶栏恢复可见并定位 FAB 遮挡，尚非完整窄屏验收。整体框架与 ERP 写入目标仍未完成。
- **下一步：** [-] 针对当前 `outcome_unknown` 只允许同一操作的只读调和，不生成新幂等键、不重发创建；在创建结果确认成功后，于已授权演示范围验证部署镜像 CAS。
