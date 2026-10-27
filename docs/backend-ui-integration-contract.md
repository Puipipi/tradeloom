# 后端与 UI 分层接入合同

更新：2026-10-25。对应逐图审计 `workspace/testing/full-visual-audit-20261025/comparison.json`。本合同只列已核对的接口和明确缺口，不代表所有审计项已经验收。

## 运行版本与文件归属

运行端口与代码源需分别判断：3088 shell 使用 desktop16 冻结包 `ea6a7e30985d360099d39af9ca9035d718bf46d1681ff0bd7f05f10e0ccf2eca`；3090 Django 监听进程实际匹配当前 checkout 的 `manage.py`，而非安装 backend 副本。`BASE_DIR` 来自实际加载的 `config/settings.py`；`TEMPLATES.APP_DIRS=true`，静态/模板新请求可能读取 checkout 候选文件，故不能一概称业务源码改动未生效。运行时 `DEBUG` 与缓存最终状态未知。端口、哈希和进程路径布尔证据见 `workspace/testing/postgres-bom-audit-20261025/postgres-bom-audit.md`。GitHub 不修改；本轮不重启软件。

前端单写 `client.js`、`client.scenes.js`、布局/样式、CLI/runner 和补丁 lock/order。后端交付独立补丁与存储模块。禁止整仓同步覆盖；各层独立冻结、验收、部署和回滚。

## 可立即消费：会话绑定

`GET /tradeloom/scenes` 保留 `sessionBindings`，新增 `sessionBindingMetadata`。每项包含 `scope:'role'`、`roleId`、`sessionId`、`workspaceId`、`archiveState`。

UI 必须核对 role 和 sessionId 一致后才显示归档提示。`unknown` 不是未归档；`unarchived` 不是正在执行。读取不创建、不恢复、不发送会话。此接口已经进入 desktop16；完整字段与证据见 `docs/session-binding-contract.md`。

## 新候选：DeepSeek / 豆包独立窗口

补丁 `integrations/dsh/patches/desktop-ai-web-multisite-state.patch` 的 SHA-256：

`858dbaed145acb6f124989597a980f641cc9592d3f007c2740d1181c96091088`

依赖顺序：原有 `desktop-ai-web.patch`，随后 `desktop-ai-web-main-frame-phase.patch`，最后本补丁。后端没有修改 lock/order、正式 runtime 或 receipt。

接口：

```ts
type Provider = 'deepseek' | 'doubao'
aiWeb.status({provider}): Promise<State>
aiWeb.toggle({provider}): Promise<State>
aiWeb.subscribe((state: State) => void): () => void
```

`State` 字段：`provider`、`revision`、`available`、`open`、`visible`、`phase`、`error`、`persistentSession`、`origin`。phase 为 `closed|loading|ready|error`。error 为 `null|page_load_failed|page_process_stopped`。

先订阅，再分别查询两站状态。按 provider 保存状态；同一主进程内忽略较旧 revision。卸载调用订阅清理函数。revision 只在同一主进程内有效，完整重启后不能与旧值比较。status 不打开窗口、不推进 revision。

`visible` 来自真实窗口可见且未最小化状态。原生关闭会发 closed；隐藏或最小化不代表 closed。`ready` 只代表主文档加载完成，不证明登录、模型可用、回答完成或视频解析。光晕/展开应绑定真实窗口状态，不能用点击意图冒充成功。

DeepSeek 原有持久分区不变；豆包使用独立分区。远程页面无产品 preload、Node 或产品 API。旧 desktop16 只支持 DeepSeek：没有 subscribe 或拒绝 doubao 时显示需要升级，不能伪造 available 或已连接。

验证：原生 startup/webdoc/preload 三文件 172/172；实际 Electron 受控双窗口检查 12/12；browser-guests/ipc 严格语义检查 exit 0；LF 补丁正向与逆向逐字节核对通过。正式候选仍需官方聚合构建、补丁生命周期和实际 GUI 验收。

冻结哈希与目标文件：`workspace/testing/ai-web-host-20261025/multisite-delivery.json`。受控网页测试不证明真实豆包登录或抖音内容理解。

## 豆包官方页面匿名只读观察（2026-10-25）

实际只读目标为 `https://www.doubao.com`，Host 报告 `provider=doubao`、`phase=ready`、`open=true`、`visible=false`、独立持久会话；页面截图及 DOM 显示未登录入口和消息输入框。此处的 `ready` 仅表示页面加载完成。该匿名 profile 未登录、未提交任何消息、未复制用户凭据；远程页面观测到 `productApi` 与 `nodeRequire` 均为 `undefined`。证据文件及 SHA-256 见 `workspace/testing/ai-web-host-20261025/doubao-readonly-delivery.json`。

该观察不证明登录或登录保持、问答收发、模型可用、抖音视频内容理解，也不验证 DOM 适配器。页面推荐文案不作为产品能力证据。

## O01 场景独立打开边界

当前 pane ticket 只描述单 pane inert fixture，且 fixture README 标记为尚未运行；它不能证明整场景 Host 独立打开能力。完整 scene popout 目前只是设计提议。独立打开必须由原生 Host 持有窗口及目标身份，不能用 `window.open` 放行任意 URL。

## P1 无内容站点诊断：patch23 v2 已交评估，未部署

当前只读诊断补丁为 `integrations/dsh/patches/desktop-ai-web-readonly-diagnostics.patch`，SHA-256 `2A3EFE8E01C040696C72F2F27908C1DEAC8B77CB6D7584498C420FBFFF5C0AB7`。v2 受控 Electron 元数据诊断 12 项通过，上传 smoke 16 项通过；这些是受控 fixture 结果，不是对 DeepSeek 或豆包真实站点的验证。fixture SyntaxError 事故已修复，旧自有失败 Electron 进程已清理。

补丁仅处于前端评估，未部署、未激活，也未改 published lock、CLI、live16 或业务运行时。它不包含站点问答 adapter；上传 smoke 只证明受控页面事件和测试字节链，不代表真实网页问答或文件上传闭环。当前入口提议是原生网页窗口既有“网页”菜单的固定只读导出动作；实际接线和普通 GUI 验收仍待后续批准。

## P0 恢复 overlay 候选

恢复 overlay 覆盖 43 个组件，RC3 四项基线哈希已登记；当前仍未部署、未标记 golden。候选文件与运行效果分开验收。3090 Django 业务服务的实际进程来自当前 checkout，模板或静态资源的新请求可能读取候选源码；因此不能笼统声称业务源码变更都尚未生效。运行时 `DEBUG` 与缓存状态仍未知。

## O06 原生助手调用网页 AI：控制器已测，桥接未接

`integrations/dsh/native-ai-web/ask.ts` 提供独立 ask controller；fake-adapter 测试 13/13，strict TypeScript noEmit exit 0。测试覆盖控制器队列、取消、超时、已有草稿/附件保护、完成检测和有界回答，但没有运行真实站点 adapter。

`integrations/dsh/native-ai-web/BRIDGE-CONTRACT.md` 是 typed process IPC 草案，不能当作已实现 Host bridge。Host/child IPC、native assistant 工具路由、真实站点输入/回答关联、同站真实序列化与长回答落盘尚未接通。O06 仍为进行中；真实网页问答尚未证明。

## O07 网页本地文件工具：执行层有 DSH 证据，网页往返未接

`packages/tradeloom-shell/webai-file-tools.js` 与 `webai-local-directory.js` 的 DSH provider 定向测试 9/9；未设置 `TRADELOOM_NATIVE_RUNTIME` 时另 9 项 provider 测试按预期 skip。`workspace/testing/webai-file-tools-20261025/local-regression-run.txt` 记录本地真实 DSH executor 读样例、`write_new` 测试文件、读回，并由 Node 测试 1/1。该证据只覆盖本地执行层，不代表网页模型生成代码或完整工具往返。

`workspace/testing/webai-file-tools-20261025/INTEGRATION.md` 是接线合同草案。网页生成/请求回传、真实 assistant-tool provenance、native UI grant 签发及撤销/TTL 等真实生命周期尚未接通或验收。O07 仍为进行中，与 O06 分开验收。

## 工作流：现有接口与存储候选

当前 `GET /tradeloom/workflows` catalog 明示 `executionMode:'local_mock'`、`runHistory:{storage:'memory',limit:30}`。已有保存、确认、运行、人工决定、取消及读取接口。这些状态不能显示成真实 DSH 执行器已经接通。

存储候选 `workflow-postgres.js` 导出 `createPostgresWorkflowRunStore`：

```ts
get(id): Promise<Snapshot | null>
list({workflowId?, activeOnly?}?): Promise<RunSummary[]>
save(snapshot, expectedRevision): Promise<Snapshot>
```

依赖 `business-tools.js` 的受信任业务地址及 native bridge HTTP 传输；Django `CanvasWorkflowRun`、迁移 0012、`/api/canvas-workflow-runs`。配对密钥只由 Host 持有，不向 UI 或网页暴露。尚未完成 runner 接线、package exports/files 收录或正式数据库迁移。

Snapshot 的执行模式为 `native_dsh|local_mock|custom`，状态为 `running|waiting|done|failed|cancelled|interrupted`。API 接受某个枚举值不证明对应执行器存在。每次写入必须 `revision=expectedRevision+1`；冲突返回 409，不能静默覆盖、回退内存或显示成功。缺记录仅在 404/run_not_found 时返回 null。列表上限 100。

当前证据：存储与业务工具测试 53 通过、3 个既有环境跳过；存储协议测试使用 HTTP fixture，不是 PostgreSQL 端到端证明。Django 四项接口测试另在隔离 PostgreSQL 通过。真实 runner 事件、重启读回、中断恢复和不重复执行尚未验收。

后续集成顺序：冻结执行 DTO及真实执行器适配；持久化写入成功后才发布 UI 状态；接 Host 查询；验证人工确认/错误/取消；最后验收重启。回滚只撤接线与候选包，保留数据库记录和迁移，不删除历史。

## 审计所需数据的准确边界

| UI 所需 | 当前证据与处理 |
| --- | --- |
| MCP 服务分组、连接、开关、工具计数 | 本轮尚未冻结可消费的原生数据接口；保留原生管理功能，数据未知，不用静态数字代替。 |
| 轮数、压缩、上下文与用量 | 原生对话功能存在；尚未交付工作台独立统计 DTO。不能拿画布节点数、消息 DOM 数或估算 token 充当真实统计。 |
| 真实执行事件、限制、暂停、错误 | 当前画布 runner 为 mock。缺真实适配与持久事件合同；waiting 人工确认不等于引擎任意暂停。 |
| artifact、节点、文件结果与来源 | 当前无已验收的真实执行器关联合同。候选应保留 runId/nodeId、原始来源和结果身份；此处是待实现要求，不是已上线字段。 |
| 记忆、身份、规则、索引 | 角色 preset/会话绑定存在，不等于独立记忆、交接台账或索引服务。保留原生能力，不以新空面板冒充。 |
| 网页登录保持 | 真实 DeepSeek 手工上传 marker、回答落盘及完整重启后保持登录已有证据；不能推广为豆包已验证。 |
| 网页自然语言文件工具闭环 | 尚未实现。手工选文件和保存文字不算闭环。 |
| 豆包抖音视频内容分析 | 尚未取得真实网页内容分析证据；标题、预览和第三方宣称不算完成。 |
| 防火墙稳定监听路径 | 已定位候选 Electron Node-mode Host 路径变化；稳定 Host 模块尚未完成或激活。未修改 Windows 防护或 LAN 默认值。 |

不扩建 SSH、行情、GPU、磁盘清理或图像编辑业务。未知项可显示“数据尚未接入”；不能生成假数据来通过视觉审计。

## 逐图审计补充：F11 / F12 / F21 / V12

以下路径相对锁定 RC3 原生源码根，已在 desktop16 只读源码核对；不是对该宿主服务在线状态的实机证明。

### F12：优先复用现成插件清单

已有 Host Remote：`ctx.remote.pluginInventory.list()`。返回 Result；先判断 `ok`，成功读取 `value: PluginInventorySnapshot`，失败显示错误或不可用，不能当作空清单。

- Host：`packages/host/plugin-inventory/src/index.ts` 的 `PluginInventoryGateway`，service 名 `pluginInventory`。
- 类型：同目录 `types.ts` 的 `PluginInventorySnapshot`。
- 原生使用者：`packages/client/ui-settings-plugin-inventory/src/client/index.ts`。
- 注册 slot：`settings.plugins.tab`，id `all`，order `10`，locale `settings.pluginInventory`。
- 必要服务：`slots`、`locale`、`remote`、`remote.pluginInventory`、`modules`。

Snapshot 有 `entries`、可选 `agentPresets` 和 `managementAvailable`。entries 每项有 `entryId`、`moduleName`、可选本地化 `meta`、`enabled`、`fiberPhase`。phase 为 `pending|loading|active|failed|unloading|null`；null 表示没有观察到实时根 Fiber。preset rows 的 enabled 还可能为 `conditional`。

紧凑概览可读取该服务并沿用原生显示名称，不需要新增 Host 清单服务。它是 Loader 条目与 preset composition 视图，不等于所有已下载 npm 包、工具数、MCP 连接状态或插件运行成功证明。插件安装/修改继续走原生管理；本轮只读接口不承担安装动作。

### F11：MCP 连接与工具归属需补原生观测

现有 `/tradeloom/agent-capabilities?role=...` 在 `capabilities.js` 中只投影当前角色工具 schema 和 skills snapshot。`mcp.status` 为 `unavailable|not_configured|declared_only|visible_tool`；这些不是 MCP 连接状态。`visibleTools` 是字符串数组，没有服务器连接 DTO。此接口没有 MCP 开关操作。

原生 `packages/mcp/mcp-client/src/index.ts` 每个插件实例对应一个 serverName；`connection.ts` 私有维护连接、重连和当前代次。`server-context.ts` 对外贡献资源操作与成功连接后的 instructions，没有供 UI 枚举连接状态的 Remote。配置条目 enabled、Fiber active 或 instructions 非空，都不能替代当下握手与连接状态。

接入顺序：先在原生连接拥有者提供只读观测（实例/作用域/会话身份、连接状态、generation、观察时间、真实已注册工具归属和数量）；再给角色端点投影。未接通前保留原字段，前端连接状态与 server 分组显示未知。此处仅冻结缺口与语义，不发布假造的新字段。不能仅拆分工具名来推断服务器：serverName 允许下划线，归属应来自注册时的显式元数据。

### F11 / F12 补充：desktop17 prospective25 的技能与插件公开接口（静态）

此补充只核对 RC3 source HEAD `1f81c047fc48fa190a683e469daa699857e9afe8`；不是 desktop17 当前运行宿主的在线接口或界面实机证明。

- 核对的相关代码中没有独立的“Skills 管理 pane”注册。插件管理主面板 id 为 `plugins`（`packages/client/ui-plugin-manager/src/client/index.ts:68-72,113-157`）；设置区 section id 也为 `plugins`，其中原生只读插件库存 tab id 为 `all`（`packages/client/ui-settings-plugins/src/client/index.ts:74-84`、`packages/client/ui-settings-plugin-inventory/src/client/index.ts:32-63`）。`ui-skill` 注册的是 `tool.call.toolview` key `skill` 和 `/` 输入触发器，不是管理页（`packages/client/ui-skill/src/client/index.ts:80-91,167-185`）。
- `ctx.remote.pluginInventory.list()` 返回 `Result<PluginInventorySnapshot>`。可用字段为 `entries[].entryId/moduleName/enabled/fiberPhase/meta?`，snapshot 另有可选 `agentPresets`、`managementAvailable`；`meta` 限于本地化 title、description、icon、error。它是当前 Loader entries / preset rows 的库存投影，不含已安装 package version、物理安装路径或完整 catalog。配置条目、`enabled` 与 Fiber phase 不能单独证明 bundle 已安装、完整 catalog 存在或功能成功运行（`packages/host/plugin-inventory/src/index.ts:50-73,82-113`、`types.ts:16-26,65-75`、`packages/util/package-manifest/src/types.ts:44-54`）。
- 如需只读 catalog/安装版本，用 `ctx.remote.pluginManager.listBundles()`，DTO 为 `BundleInfo[]`：含 `name/official/availability/installed/enabled`、可选 `version`、显示 metadata、rows、`installTarget` 等。它汇总安装提供、profile 已选/依赖与官方 on-demand catalog；`version` 是包 manifest 版本，可能缺省。DTO 没有实际安装目录字段；可选 `source` 表示 profile dependency 的安装 spec（本地 spec 可能是绝对路径），不能当作已解析物理路径。`listPlugins()` 是当前 Loader entry 的管理投影，带 patch/readOnly 信息，不补出版本或安装目录（`packages/boot/plugin-manager/src/index.ts:288-307,310-385`、`types.ts:37-41,55-90`）。只读页面应仅调用 list 方法；不要为了读取状态调用 enable/install/remove 等写操作。
- 技能 catalog 的公开入口是 `ctx.remote.skills.list({ sessionId }, signal)`。返回 `SkillListValue.skills[]`，每项为 `name`、`description`、可选 `whenToUse`、`modelInvocable` 和可选绝对 `SKILL.md` `path`；该 Remote 按 session 当前 preset/cwd 列出 human-invocable 技能元数据，不加载正文，非 filesystem provider 可没有 path（`packages/api/session-controller/src/skill-catalog.ts:19-36,41-50,63-89`、`types.ts:243-260`）。
- 原生 `ui-skill` 已提供打开**原文文件**的办法：对目录中选中的 `/name` 找到该 skill 的 `path`，用 `fileAddressFor(sessionId, cwd, path)` 生成 session-file address，再调用 `ctx.sidebarRight.openResource(...)`；调用依赖保留中的 session scope 和 catalog 返回的 path（`packages/client/ui-skill/src/client/index.ts:115-133,205-222,236-245`、`packages/util/workspace-path/src/index.ts:82-99`）。在核对的原生接口里没有“打开技能目录/在文件管理器定位目录”的专用 skill API；原文预览只定位到 `SKILL.md`。
- 若前端要自己读文字，原生文档预览直接调用 `ctx.remote.workspaceFiles.read(sessionId, path, { offset }, signal)`；DTO 给出 `absolutePath/version/bytes?` 和分页 `text/lines/eof`。默认限制为每页 2 MiB、最多 5000 行、整文件 byte read 32 MiB；普通 text read 会拒绝 NUL 页。Host 文档明确：file read 服从组合 filesystem 的读权限，可读取 workspace 外路径；`list(sessionId,path)` 仅列 workspace 内目录并受 entry cap 限制。因此技能原文的实际访问权来自 Host 组合的 `ctx.fs`，源码没有一个独立 skill grant/用户确认接口；目录列表不能据此扩到 workspace 外。不要把 `skills.list.path` 当作无条件授权（`packages/api/workspace-files/src/index.ts:2-19,183-190,233-246,303-327,402-434`、`types.ts:21-61`、`packages/client/ui-sidebar-documentpreview/src/client/rpc.ts:14-31,74-82`）。

以上结论只说明 desktop17/25 源码中公开声明的能力和 DTO；没有通过 Node、HTTP 或 GUI 实测确认目标前端构建实际注入这些 Remote、pane 当前可见或目标宿主 filesystem 会允许访问某条路径。证据与精确源定位见 `workspace/testing/native-public-capabilities-20261026/skills-plugin-inventory.md`。

### F21：artifact 不能从 output 猜测

`workflow-engine.js` 当前把 executor 返回值 `String(...)` 写入 node.output；node 初始化仅有 status/output/error。没有可靠的 artifact 数组或下载来源。此处不承诺已经存在可消费的新 DTO。

真实执行器接线时应共同冻结：runId/nodeId、artifact 稳定 ID、名称、媒体类型、字节数、受控预览/下载引用、来源执行/工具事件、产生时间和可用/缺失状态。URL 与文件路径必须由后端校验/解析。UI 不按输出字符串、后缀或任意路径猜测文件，也不为 mock output 生成可下载结果卡。DTO 冻结与真实写入验证应先于 UI 接线。

### V12：规则与身份存在；完整记忆台账尚未证明

`packages/context/agent-instructions` 是现成 AGENTS.md/CLAUDE.md 及 overlay 发现、预算和刷新能力，配置受项目根与会话目录约束。`packages/core/system-prompt` 提供有序提示词段、作用域 persona/身份和工具 schema 组装。两者是宿主能力，不等于已经有独立“记忆管理”页面或跨会话记忆索引。

本轮没有查到可以直接承诺给工作台复用的记忆/身份/规则可视化管理 slot。不能将 `packages/identity` 中匿名用户 ID 当成 Agent 人格，也不能将测试中的 memory backend 当成长程记忆。原生已有入口保持；新增可视化入口需先确认准确服务和只读数据，暂标未接入。


## V13：原生单节点工作流 UI → Host → ToolRuntime 桥（候选源码）

固定接口为 `POST /tradeloom/workflows/native`，不替换原Canvas/mock路由或业务WorkflowTask桥。Host先调用connection.requestRejection；浏览器不提供Agent/parent/session/model/preset/raw tool名/authority/exec。Host从server state.roles.center.sessionId寻找registry中同一live Agent并核session；不存在返回409 center_session_not_live，不创建fake Agent。固定native工具通过真实ctx.tools.execute接收Host生成callId、白名单arguments、真实Agent及请求owned signal；ToolRunContext只由原生ToolRuntime生成。PTC/工具guard照常执行，不造parentToken。

请求JSON上限4096 bytes，严格拒绝额外键及类型。全部正常/错误响应带schemaVersion:1、ok与executionMode:native_dsh，缓存禁用。动作：

| action | 参数（除action外） | 返回 |
| --- | --- | --- |
| prepare | workflowId | 200 prepared |
| submit | workflowId, operationId, expectedDefinitionRevision, expectedBindingRevision, confirm:true | 202 submission，仅接受回执 |
| get | runId | 200 run |
| list | workflowId?/activeOnly? | 200 runs |
| cancel | runId, operationId | 200 cancellation，仅abort请求 |

prepare只读取已存且明确confirmed、单合法非center agent/noedges定义，校验当前中心完整workspace/session/preset/archive/revision及官方subagent preset schema。prepared固定为 `{workflowId,title,eligible:true,executionMode:'native_dsh',confirmed:true,definitionRevision,bindingRevision,center:{roleId:'center',sessionId,workspaceId,archiveState:'unarchived'},node:{id,roleId,agentPreset}}`。不创建run或spawn。definitionRevision为确认定义摘要，bindingRevision为持久十进制revision。UI必须保留两者；submit不匹配则409并重新prepare，不裁edges、不自动重试。

service.submit仍支持人工Agent旧 `{workflowId}`，可选expectedDefinitionRevision/expectedBindingRevision提供时必须匹配；HTTP强制两revision和confirm:true。服务在异步定义/store读取后、create前重核权威定义/绑定。create持久成功前零spawn，之后仍按owned run生命周期在dispatch前重核。operationId仅幂等，不授权；Host callId为可信owned profile home规范路径、真实sessionId、action、operationId的域分离hash，浏览器不能指定namespace。丢响应后同op通过真实ToolRuntime callId及持久runId复用，不重复spawn；读操作用Host随机callId。

submit固定202形状：`{schemaVersion:1,ok:true,executionMode:'native_dsh',action:'submit',operationId,submission:{runId,accepted:true,reused,settled:false}}`。Host再通过真实native_get回读并确认run/workflow/session/parent/revision身份后才发接受回执；不从模型文本生成receipt。202永远不代表完成，重复提交返回已终态run时202也保持settled:false，另get核证。

get/list先复用verifyWorkflowDefinition(run.document,run.definitionRevision)核已确认定义摘要，并要求document.id=run.workflowId、单agent/noedges、定义node ID与唯一持久node一致；损坏快照固定503 submission_unverified。投影id/workflowId/status/revision/definitionRevision/bindingRevision/sessionId、节点latest attempt/attemptState/childId/nativeRunId/toolCallId/output/error。status保留持久标记，本身不等于已验证结束或成功。settled表示确有可信子运行结束，succeeded另表示成功；两者不能混同。

settled/terminalReceipt只认source=subagent/end，且run/node/attempt/requestId/parent/session/双revision/toolCallId/childId/nativeRunId全部非空并严格匹配当前持久node的journal终结事件。映射必须遵守实际executor/journal：completed→node-terminal/status=done/receipt.status=completed；aborted→node-interrupted/status=interrupted/receipt.status=interrupted；其他非空stopReason→node-error/status=failed/receipt.status=failed。terminalReceipt保留真实stopReason及对应status。每node settled=有这种匹配receipt，run settled=所有当前node有匹配receipt；succeeded只在completed且node done、run done时为true。真实failed/aborted end因此settled:true、succeeded:false，UI应停止轮询并显示失败/中断，不无限等待。

无receipt、缺/错身份、unknown、tool_error、startup-recovery或只有“完成”模型文本均settled:false/succeeded:false/terminalReceipt:null；进程恢复不等于child已结束。provider/model固定unknown，不猜真实模型或artifact。submit202和cancel200自身仍始终settled:false，它们只代表请求接受，权威结束/成功结果需get/list核验。

cancel返回abortRequested/reason及settled:false；已终态或不owned分别如实reason，不把信号接受当cancelled。真正结果另get核对。请求断开只abort提交前/尚在ToolRuntime调用的请求；service已接受run使用独立owned controller，响应关闭/旧请求signal不接管其生命周期。

错误仅固定安全code：auth401/403，输入400，stale/unsupported/notlive409，基础设施/PG异常503；不返回message/stack/URL/key，不自动重试，不借模型文本当服务结果。真实18 SDK离线测试会用facade Agent/workspace/CAS及合成child，必须标注；不代表已启动Host/HTTP33190/PG/model/GUI。完整DAG、人工resume、网页O06/O07仍独立待验。


### V13 补充：operation作用域、冲突优先级与旧owner

operationId只在可信profile namespace+当前真实center session+action作用域内幂等，不授权、不跨中心转移。相同op+相同合法确认体在持久snapshot身份完全相同的情况下reused:true，零新增spawn。既有run即便终态，202仍settled:false，另get查真实settled/succeeded。

| 同op后续请求 | 实际409 code与字段 |
| --- | --- |
| 另一已存、confirmed、eligible workflowId且附其正确prepare revisions | submission_identity_conflict；workflowId/definitionRevision与原持久提交不同 |
| expectedDefinitionRevision已经stale | definition_revision_mismatch，先于持久幂等身份比较 |
| definition仍匹配，但expectedBindingRevision已经stale | binding_revision_mismatch，先于持久幂等身份比较 |
| 同workflow重新prepare后提供新的合法definitionRevision或bindingRevision | submission_identity_conflict；新合法revision不等于原op持久身份 |

定义不存在/不confirmed/unsupported等校验仍优先报告各自固定code，不伪装成全局idempotency表中的冲突。UI收到409应停止沿用本次prepare/operation进行自动重试，重新prepare，由用户确认后生成new operationId；不得悄然复用旧op去覆盖原run。

中心变更后HTTP始终解析当前真实中心；旧run仍归原parent/session，get/cancel返回403 run_parent_mismatch，list只显示当前owner，不转移旧run、不自动重派。UI遇403应停止旧owner轮询/取消动作，提示绑定变化，并重新prepare/newop；旧owner的工作生命周期不会被HTTP权限转移。以上为源码+真实SDK离线facade测试合同，未证明真实Host/PG/model端到端。


V13 冻结补充：operationId精确格式为 `/^[A-Za-z0-9_-]{1,128}$/`，推荐UUID；它仅作当前profile/center/action作用域幂等标识，不是授权凭据。

当前native run DTO不发布artifacts或下载地址字段；artifact能力未接入不等于已证明“0成果”。前端不得从node.output解析文件路径、URL或后缀来伪造文件卡/下载入口；后续需有独立受信artifact合同及来源证据后再展示。

### V14 中心冷会话恢复与取消边界

五个原生 action（prepare/submit/get/list/cancel）保持 V13 鉴权、输入、工具权限和当前 owner 规则。仅在鉴权/输入校验成功且可信中心 ID 的 registry Agent 不存在时，Host 调用公开 `ctx.sessionController.resolveAgent(sessionId)`；真实返回类型为 `{agent: Agent} | {error: ApiSessionAgentError}`。已有 live Agent 不 resolve，缺失/失败固定409 center_session_not_live，不新建会话、不选择默认 preset、不发 prompt、不手造 Agent/ToolRunContext。resolver 生命周期由原 Host 框架所有，本 handler 不 dispose。

恢复前保存可信中心 ID 与 getRoleBindingRevision；await 后重读服务端 state，中心 ID 变化拒绝 center_binding_mismatch，revision 变化拒绝 binding_revision_mismatch，再核 Agent.id、Agent.session.id 与 registry exact object。state.js:16–25、70–85 的 replaceRoleBinding 以 sessionId/workspaceId/workspacePath/agentPreset 元组变化递增 revision；getRoleBindingRevision:60–67 是已存 revision/legacy seed 的读取，不是实时元组 hash。因此同 revision 覆盖元组变化的前提是可信 writer 遵守 replaceRoleBinding 合同；不能把任意绕 writer 直接改文件且不 bump revision 当作已检测。

Client retain/reference.ready 仅保证初次历史打开；冷历史 follow 的首快照之后后台 promote，不能作为 Host Agent 已就绪屏障。公开 resolver 完成才用于此次 Host 工具调用。真实 Agent 的 ID 契约见 runtime18 core/agent/src/types.ts:14–17（Session-backed Agent identity），core/agent-loop/src/index.ts:683–693、750–805（同 id 创建 Session preparation 与 Agent），及604（ReactLoopAgent 同 id/session 构造）。

resolve 等待期间请求 aborted/未完成 request close/response close 仍接原 AbortController。恢复完成后即使进入 tools.execute，真实 runtime18 ToolRuntime 的 prepareExecution 在 tools/pre-execute 和工具体之前检查 callerCancelled（core/tools/src/index.ts:1500–1510）；不额外添加重复 handler guard。新增 prepare/submit/cancel 三条等待期间 abort 回归证实 pre-execute 零调用、service 工具体零派遣、零持久化/子运行。原 SDK error.info.code 为 TOOL_ABORTED_BEFORE_DISPATCH（1980–1987），不在当前公开 allowlist，沿现有固定503 native_workflow_unavailable 映射，不扩大错误 schema。

验证：service+ui+tools 三个现有相关套件最终81/81通过、exit0。新增测试初轮暴露 fixture schema baseline：replaceRoleBinding 要求完整角色 revision map，不能仅 center 一项；已修 fixture，不改 state schema。初轮失败 raw 与修正/补充后的 raw 均保留在 desktop18-26/native-center-liveness-contract/implementation。本轮仅源码/真实SDK离线 facades 证明，未安装冻结 v3、未启动 Host/HTTP/PG/model/GUI，真实 Host 冷恢复仍待独立验收。
### V15 内部文件声明来源与 HTTP 发布边界

本轮仅为 native journal 内部增加可选 `tradeloom.presented-evidence/v1` 来源子 schema，外层仍为 `tradeloom.native-run-journal/v1`。本轮 HTTP get/list DTO **仍不发布 artifacts、来源坐标、文件路径或下载地址**；V13/V14 的白名单投影不因内部节点新增字段而扩张。前端不得直接透传 journal、解析 output 路径或据文件后缀生成成果卡。

内部 ack 同次 CAS 保存 `artifactRangeStart:{childSessionId,nativeRunId,startInclusive}`；匹配 terminal 同次 CAS 保存 `artifactEvidence:{schema,range:{childSessionId,nativeRunId,startInclusive,endExclusive},declarations}`。每条声明包含 `sourceSessionSeq/fileIndex/presentCallId/sourceTurn/path/description?`。声明身份是 exact child 的持久事件坐标 `(childSessionId,sourceSessionSeq,fileIndex)`，path 只定位当前文件，不是产物身份或授权。范围为 `[startInclusive,endExclusive)`，两端取保留的 exact Session 的 next-seq；它与 latest-event cursor 不同。

只有匹配 ack 的 child/nativeRunId/范围及严格 schema、坐标、预算校验通过，才采纳 `deliverables/presented` 来源。缺 capture 服务、范围不完整、错误来源、身份不符或存储失败保持 unknown；不能把 `artifacts:[]` 加 unknown 解释为已证明“零成果”。可验证范围中的空声明只表示该范围未观察到文件声明，不表示没有产生文件。

`presented` 只代表成功 present 工具声明了当时存在的 regular file，不证明本次 created、内容正确、已审批或 immutable。来源记录不冻结字节，也没有伪造 version/hash；现有官方打开入口读取当前文件，后来修改的文件不能称为“原始产物下载”。旧 v1 没有新子 schema 的记录继续保留 unknown，不能回填猜测来源；旧终态不追加事后 artifact 写入。

证据按阶段分开：V14 的 81/81 是中心冷恢复相关历史验证；本轮 executor/journal/source validator 与最近 composition/service 离线 gate 为 120/120、exit0，原始日志在 `workspace/testing/native-prospective-contract-20261025/desktop18-26/native-artifact-contract-review/implementation/final-verified.raw.log`，退出文件为 `final-verified.exit.txt`。独立真实 PostgreSQL/Django TestCase client 合同为 3/3、exit0，正规 runner 记录在 `workspace/testing/workflow-native-persistence-20261025/runs/2026-10-26T115353-130Z-48992/`，详细范围见 artifact review 的 `pg-compat/RESULT.md`。

120 项使用受控 Host/child 生命周期 fixture；PG 3 项证明真实新 journal/source DTO 的 CAS 与读回兼容，child 和 source 坐标仍为明确 synthetic fixture，示例路径并无真实文件。两者均不证明真实 present 工具、原生模型产物或实际 HTTP/GUI 交付；不把这组证据与 V14 81 项相加或升级为实机完成。

### V16 可信隔离proxy、角色空会话耐久检查与正式profile布局

`businessProxyEnabled` 仅为可信Host配置boolean，缺省true；浏览器/body/header/tool arguments不能设置。新owned隔离profile显式false时，四prefix `/business`、`/business-api`、`/business-static`、`/business-media` 都先执行既有connection鉴权；鉴权通过后返回503及`cache-control:no-store`。`/business`为固定“业务服务未连接／当前为隔离测试模式”HTML，其他三项为固定JSON `{error:"business_proxy_disabled"}`。此时不转发业务upstream；它不是全Host出网禁用，不用四路由回执推断其他插件网络活动或历史零网络。生产bundle缺省不因隔离profile改变。

角色创建新binding分支在 `sessionController.create` 成功后、`replaceRoleBinding`/事务commit前做耐久checkpoint：从真实registry取得创建Agent，核Agent.id/Agent.session.id/registry exact object；取得当前公开`ctx.get('sessionPersistence')`非空实例identity，并核与Agent.ctx所见identity相同；核工作区id/path/session membership。随后await公开 `sessionPersistence.flush()`，这是**该实例全部write handles**的barrier，不是仅某个id的flush，也不是私有writeHandles或`ctx.sessions.flush()`布尔。flush后复核Agent/实例/工作区身份，再await公开`stat(id)`，核header.id/cwd/agentPreset，并在stat await后再核现场身份，才允许提交角色绑定。

`stat`同实例可能看见pendingheader，故仅为身份sanity，不是独立磁盘耐久证据；耐久主保证来自正确实例的await flush合同，正式重启可恢复性仍须独立新进程reader核format/header/SHA及事件metadata。缺服务、missing identity、flush拒绝、await期间Agent或实例替换、header错配均不commit新binding；原503 `{error:"tradeloom-home-unavailable"}`兼容保留，仅固定checkpoint异常额外 `error_code:"role_session_not_durable"`，不向HTTP泄露SDK message/stack。实际已创建Session/工作区不自动删、不自动mint重试。

已有binding分支仍按原路径返回，不backfill/flush/激活或修复旧引用。本合同不授权对旧v6b孤儿中心recreate、删除state或改身份掩盖冷失败。旧v6b真实31schema含五native可见及10center插件active，证明该次Host注册slice，不证明其空Session已物化；后续冷list首门失败与空sessions根证据继续保留，不能用新checkpoint源码覆盖旧失败。

正常peer解析依赖正式物理布局与当前Host公开profile resolver：新候选普通copy位于 `home/profiles/<非保留profile>/plugins/tradeloom-shell`，derived19fileURL与其他配置语义核对后，profile deps={}仍可继承installation SDK映射。`home/bundles`外置普通copy不保证bare dynamic peer可解析；静态import/export闭包也不能代替动态import核验。原tool-policy字节不改、scopeOf与guard保持同SDK/preset scope，不用绝对scopeURL包装apply、复制scope副本、私有resolver或降global guard。Node CLI profile可装配不等于Electron Desktop已采用该profile，后者另审正式入口。

证据按阶段分别记录，不合成总数：`sdk-empty-session-flush-proof/evidence/proof-result.json`为真实SDK双进程纯FS证明，未flush空Session在独立reader缺席，flush后header可list/stat/open，eventCount/userMessageCount/toolEventCount均0；不是Host或模型证据。`role-session-durability-implementation/green.raw.txt`为新handler离线facade10/10、exit0；`related.raw.txt`为相关66tests中63pass/3原条件skip/0fail、exit0，不能称66全真实SDK。旧v6b实机五工具注册slice见 `v6-host-supervision/evidence/v6-host-once/REPORT.md`，它不含本新checkpoint。新v7组合/独立profile/创建后独立reader/重启cold resolve与prepare仍待正式验收；不调用PG/模型/submit来替代，不重试被历史policy拒绝的Django33190动作。

### V17 双发布路径耐久与最终同步 seq 守卫（source 候选）

当前 Host source SHA256 `9202bf05e05ac078bb7a1d8eae03b34fd6a8831cd338e18bbb88a839ab7186ac` 同时覆盖 `/tradeloom/session` 的新角色分支，以及 `/tradeloom/session/new` 的新建与 attempted 恢复发布点；V16 的 dd32494 历史候选只覆盖前者，保留原证据，不改称全覆盖。模块内共用 checkpoint 位于真实创建/观察之后、`replaceRoleBinding` 与 operation.completed 之前。

fresh 必须持有真实 registry Agent，核 id/session、Host 与 Agent 公开 `sessionPersistence.identity` 相同，禁止缺 Agent 时降级 cold；await `sessionPersistence.flush()`，随后 stat header 的 id/cwd/preset，复核 provider/Agent/workspace 后才提交角色绑定。该 flush 是本服务实例全部 active write handles 的公开 durability barrier，不是单中心 flush；作用范围已经明确接受。stat 同实例可见 pending，不能单独当落盘证明，真实跨进程耐久仍须独立 reader。

new-session 保留 prepared→attempted→completed 的单次创建意图：prepared 才可 mint 一次；attempted+notfound 不再 create；attempted 已有可复用观察时允许恢复发布。若 registry 有 Agent，仍核真实 identity；无 Agent 的已存 cold 路径只用原可信 query 与同 Host provider 的公开 flush/stat，并重观察 id/cwd/preset/未开始 turn/工作区成员/归档条件，不 resolve/resume/create，不制造 Agent/exec。completed 历史重放直接返回、零新 flush，不追溯修复；outcome_unknown/created_unbound 保留原 409，不删旧 operation/state，不自动造消息或新 ID。旧 v6b 孤儿不自动 repair。

最终事务不再只信 immutable blank 快照：保留公开 `SessionObservation.cursor`（latest-event index，空值 -1），对存在的 live Session 在同步发布 callback 内要求 `session.seq === cursor + 1`（seq 是 next index）。同 Agent 在重观察完成后、等待最终事务锁时追加事件也会拒绝发布，409 `session-create-outcome-unknown`/operation.outcome_unknown；原 stale-session-binding→created_unbound、归档/成员/query 不再可复用等业务冲突优先，不用 durability 503 吞掉它们。cold 无 Agent 不强造 pointer 或 blank=true。

单纯缺 provider、flush 失败、provider/Agent 身份或 header 不符不绑定、不 completed，保持 attempted 供明确恢复；503 保留旧 `error` 字段（legacy 为 `tradeloom-home-unavailable`，new-route 为 `session-create-unavailable`），仅额外追加固定 `error_code:"role_session_not_durable"`，不暴露 SDK 任意 message/stack。known stale 冲突即使与 flush reject 同时发生，也优先原业务 409。

本增量红证为旧 source 在“重观察后、最终 callback 前 seq/turn 变化”仍返回 201；窄修复定向 3/3，最终相关 gate 为 84 tests / 81 pass / 3 原条件 skip / 0 fail、exit0。证据为 [seq guard RESULT](C:/Users/23825/Desktop/ICT/workspace/testing/native-prospective-contract-20261025/desktop18-26/role-session-seq-guard/RESULT.md)、原始 `related.raw.txt` 与 `related.exit.txt`。这些是 offline handler/Agent/store facades；既有 SDK 双进程纯 FS flush proof 单独保留，不与离线计数混成真实 Host、PG、模型或 UI 通过。

v8 source 固定为 43 文件 tree `49d06788c20bceb41e026366992ce9bf3c2f571846345dcc9eeddeacaf71ff9d`，manifest SHA `fe04e742c642c048dbdf4ed4f8820f96690f1c7aa6050f055d0e12a6567c1c39`；[冻结 HANDOFF](C:/Users/23825/Desktop/ICT/workspace/testing/native-prospective-contract-20261025/desktop18-26/backend-frontend-candidate-v8/HANDOFF.md) 不被本次合同更新改写。新 [v8 profile 准备](C:/Users/23825/Desktop/ICT/workspace/testing/native-prospective-contract-20261025/desktop18-26/real-host-profile-v8-durability/HANDOFF.md) 与 [readerRoot admission](C:/Users/23825/Desktop/ICT/workspace/testing/native-prospective-contract-20261025/desktop18-26/real-host-profile-v8-durability/PERSISTENCE-ROOT-ADMISSION.json) 仅证明官方 init/copy/dump 及同环境公开 helper 求值，非 live backend 观测。profileDir/plugins 普通 copy、19 fileURL、唯一 Host businessProxyEnabled:false 保留；不覆盖 production16、旧 profile 或个人数据。

父端 root 最新 get_goal 已确认 active，updatedAt=1793031095，tokens=9086082，time=30693；本子线程 get_goal 返回 null 只代表子线程无该父目标记录，不据此改变父目标。root已亲读阶段A passed:true：六preset healthy、四proxy503、legacy创建200/rev1、新创建201/rev2、同op重放200、两次list唯一。owned PID61960结束、child exit1为Windows外部terminate非graceful，端口归还/保护hash一致。这是A阶段事实，独立reader R及重启coldprepare B尚未运行，跨进程耐久/冷恢复仍未完成；后续结果须独立追加，不能以A或准备回执代替。真实 dispatch/terminal/Artifact、PG HTTP 与模型、DAG/resume、O06/O07 等原 51 项完整责任保持；单项受阻继续独立项，不假 complete/paused/blocked。游戏期间仍禁止键鼠、切窗、焦点、截图或可见 GUI；当前合同改动不授权启动任何服务。

### V18 native-workspace 浮窗 source 合同与 O06/O07 分层验收

`dock-layout.js` source SHA256 `25e672da39a2c5e7cc975bd8751b312722c3555e6393ce846dd26a14676c88f6` 仅在既有浮窗类型白名单增加 `native-workspace`；仍至多一个floating group、每组恰一view、合法有限position/尺寸、panel不得重复，且component/title/renderer必须匹配scene登记配置。serialized params仍仅允许与record.id一致的panelId，不接收roleId/sessionId/workspacePath/authority/token。布局保存只写dockLayouts，不创建或改变角色绑定。

native-workspace省略roleId时继承受配置约束的scene角色，显式role也必须合法；renderer从scene登记panelId查descriptor派生角色，Host的session/workspace/revision/archive绑定由Host state.roles生成，不能从浮窗输入升级为权限。source/离线序列化及handler相关验证为84pass、8原条件skip、0fail，不能把92称全通过；[FINAL-RESULT](C:/Users/23825/Desktop/ICT/workspace/testing/native-workspace-float-20261027/implementation/FINAL-RESULT.json)与原raw/失败保留。真实跨窗口draft/附件保持、收回与实际窗口交互仍由前端C67验收，source type放行不等于已部署/实机通过。

O07新增独立一次synthetic-native-observer→codec→真实固定runtime18 DSH LocalFileSystem组合为1pass/0skip/exit0；九项固定输入SHA前后同，五个新owned fixture文件的完整清单/bytes/SHA/nlink1已核并保留。覆盖nonce/conversation拒绝、真实list/read/write_new、message/request重放与异体冲突、current/revoke及独立grant隔离；[实际报告](C:/Users/23825/Desktop/ICT/workspace/testing/webai-o07-envelope-fs-20261027/actual-run/REPORT.md)、[result](C:/Users/23825/Desktop/ICT/workspace/testing/webai-o07-envelope-fs-20261027/actual-run/result.json)、[fixture receipt](C:/Users/23825/Desktop/ICT/workspace/testing/webai-o07-envelope-fs-20261027/fixture-receipt.json)。这不是native授权目录UI、Host/profile装配、真实网页assistant来源或同conversation结果回环/继续回答证明。list/read/write_new授权不包含运行模型生成代码的权限，本组合未执行代码或新增shell工具。

O06 v4r2仍为source候选：r1 source22、r2 source14及部分TypeScript检查按各自原证据记录，不是Factory/aggregate或真实ask验收。r2 probe超时已清理；r3取得完整bytes但loadingFailed，overallfailed，不能算O06成功；r4信息性A/B仍待审未跑，原失败证据保留。这里不合并12/22/14/84等不同组或阶段计数为虚假全面测试。

root最新实际goal快照为active，updatedAt1793036745；不修改goal状态或原51勾选。真实native runner、PG HTTP、O06/O07网页闭环、豆包、多Agent/DAG、人工resume等仍未完；33190历史policy单项拒绝不得换入口等价retry。当前已允许必要GUI测试，由前端预约独占并核窗口身份；本次文档任务自身未使用GUI。本轮仅文档与外部V18快照，不改产品/测试/scene/frontend，不启动服务。V17及此前全部字节前缀保持，旧冻结合同不回写。
