# DeepSeek Harness 织贸业务工作台设计

## 目标与边界

以官方 `deepseek-ai/deepseek-harness` 为可升级的软件主体，给编程新手提供一个本机电脑启动、同一 Wi-Fi 手机浏览器可访问的织贸工作台。界面保留 DSH 原生主壳和对话；上方显示当前工作台的业务菜单，左侧显示统一 Agent 目录。用户可直接与任一 Agent 对话，默认入口是中心 Agent，由它通过 DSH 原生子 Agent 能力向专家发消息并汇总。

现有 Django/Postgres 继续承担业务数据、确定性审批、幂等任务创建和交付。模型产出供 Django 校验的候选计划或内容；模型不写数据库、不批准业务操作，也不绕过现有确认和审批。工作台只调用现有 API/业务服务，业务流程仍由现有规则决定。

本设计基于只读官方浅克隆 `<LOCAL_RESEARCH_ROOT>\references\deepseek-harness`，HEAD `687f282e8625c6b8d11ff58211a90524be2e4317`，版本 `0.2.1-rc.2`，MIT。研究摘要见同目录 `RESEARCH-NOTE-2026-10-19.md`。此快照是设计依据，产品实施在独立副本进行。

## 用户目标和验收 ID

- **DSH-01 上游主体**：桌面和浏览器应用来自固定版本官方 DSH；自有代码作为独立插件/启动器/可重复 patch 管理，升级时能报告上游兼容或冲突。
- **DSH-02 业务导航**：保留 DSH 主壳、会话和对话体验；顶部菜单随当前工作台展示业务入口；左栏统一呈现所有 Agent。
- **DSH-03 原生会话**：每个 Agent 均可通过 DSH 会话路由直接聊天；中心 Agent 默认选中并通过 DSH 原生 `@deepseek-ai/dsh-tool-subagent` 委派专家，用户可打开原生子 Agent 会话查看或直接发消息。业务 profile 不展示私有推理链，只显示最终回复、执行状态、工具结果、依据与下一步。
- **DSH-04 业务后端**：由现有 Django/Postgres 处理数据、业务规则、确认、审批、幂等和交付；Agent 无数据库、shell、任意文件系统或审批工具。
- **DSH-05 本地跨设备**：用户通过桌面一键启动，电脑保持开机时，同一局域网手机通过浏览器访问；绑定活动物理网卡上的具体私有 IPv4（优先 Wi-Fi，也允许 Ethernet），禁止 wildcard `0.0.0.0`、公网地址和默认 VPN/tunnel。
- **DSH-06 数据与凭据隔离**：使用 TradeLoom 自有 DSH runtime/profile/home；不修改、升级或重启当前 DSH 工作安装，不读取其私密 home、profile、会话、登录态或凭据，也不复制凭据。
- **DSH-07 易上手与升级**：提供 Windows 启动器和图形化的首次配置/连接提示；不要求用户开命令行。上游升级须先做固定版本 diff、patch dry-run、导出和契约验证，再生成新发行件。
- **DSH-08 保留现有业务能力**：业务面板经 DSH 原生 webServer 路由同源代理到 Django；每个代理请求先经 DSH connection auth guard，Django 原有 CSRF、权限检查与业务执行路径保留；嵌入模板只隐藏 Django 重复业务导航。
- **DSH-09 范围限制**：AgentArts 不在本次；不重写 DSH 聊天 UI/agent loop，不另建聊天消息数据库，不引入新业务规则、SSO 或复杂 RBAC，不公开到公网，不承诺未验证的 PWA 离线/安装能力。

## 设计选择

采用“上游源码独立副本 + 仓库内可复用 patch + 一个自有复合插件 + 本地启动器”方案。两个最小 patch 覆盖五个上游文件：ui-layout 的 slot contract 与 AppFrame 渲染 `shell.top`；ui-sidebar 的 slot contract、slot registry 与 SidebarRoot 渲染 `sidebar.agents`。导航行为、业务菜单和 Agent 目录属于仓库内自有插件，不复制上游 UI 包。

顶部槽作为 frame 全宽、位于三个列区之前的一行；在窄屏保留菜单可见并允许横向滚动。Agent 列表置于左栏的主要内容区，在原生 workspace 区域之前；保留 DSH 原生会话控制、设置和折叠行为。只在业务内容需要完整视口时，通过 DSH keyed main panel 打开 Django 同源嵌入页；嵌入模板仅隐藏 Django 重复的业务侧栏/导航，仍由 Django 原页面、模板、JS 和权限路径处理操作。

Agent 目录映射到 DSH preset与原生session；六个条目为中心、商品、市场占位、询报价占位、交付和用户资料演示。registry 默认 preset 为中心；Client 不强制跳转，以保留原生恢复；首次没有选中 workspace 时，用户可从左侧目录打开中心，其他角色点选后各自打开原生session，可在该专家的原生会话中直接对话。Host的专用routes先调用 `connection.requestRejection(req)`；业务session route使用已核实的 `ctx.workspaceRegistry.list/create` 与 `ctx.sessionController.create`，返回的SessionId经 `uiWorkspace.openSession` 打开。role workspace/session映射与预算共享 apphome 下轻量原子JSON store；仅在显式 `TRADELOOM_DSH_APP_HOME === DSH_HOME` 且 `.tradeloom-owned` marker正确时创建目录/写状态，拒绝缺少标记、路径不一致和 reparse point，无默认home fallback。中心preset独立于standard/sdk-minimal，allowedAgentPresets仅含五专家；中心使用原生subagent/send_message，专家没有派生/互发或shell/fs/MCP/业务写工具。原生 `tools/pre-execute` 根据 `exec.name`（`subagent`/`send_message`）、`exec.agent.id` 和 `header.parentSession` 在工具体执行前，按root SessionId 原子扣记尝试：4次委派、中心及其直接子session共16次消息，失败及超限尝试都计入；SubagentRuntime并发4、深度1、子最大token 4096。此设计不定义自建agent loop，不复制官方spawn/send工具。

顶部五个业务入口使用现有 Django 页面路径：`/home`、`/products`、`/agent-center`、`/artifacts`、`/runs`。主壳使用五个互相独立的 native keyed main panels，点击后分别以同源 iframe 加载既有 Django 页面。四个固定 `/business`、`/business-api`、`/business-static`、`/business-media` 是后端路由前缀，不作为菜单或业务面板。Task 3 已将菜单接入现有 Django 页；真实 DSH/Django 服务中的 iframe 与业务流仍待运行时验收。中心为启动默认 session。为整个独立织贸助手隐藏私有推理内容，不依赖 compact、CSS 或现有 reasoning slots：app 专属 renderer patch 给 `ChatPresentationPolicy` 加 `reasoningVisibility`，patched `derivePresentationPolicy` 固定为 hidden；`ReasoningRow` 在此值下不渲染 Think 标题、摘要、预览、展开内容或辅助文本。保留 visible 分支供上游维护，其他运行状态、工具行和最终回复沿原生 renderer 显示。现有 `conversation.chat.reasoning.body/content` slot 仅负责已展开文本，不能单独隐藏整行。

DSH `ui-subagent` 源码已包含 `SubagentHeaderLineage` 与会话打开/右侧查看能力，可复用其地址和 session 路由。该 UI 能力不表示 SDK 有同等的人类直接输入接口；不伪造 `session/prompt`。如果当前原生界面能力无法直接给某专家开独立对话，则通过该专家自己的 DSH root session 实现，不自行拼造私有协议。

新 app 使用两个监听端口，不复用当前正式服务：DSH 原生 web 直接绑定选定的具体局域网 IPv4 `:3088`；专用 Django 进程只绑定 `127.0.0.1:3090`。启动前检查两端口；任一占用则显示冲突并退出，不重启/终止占用者，也不挪用现 Django `8000`。不新增 gateway、Django 登录/owner/team 表或 auth schema。DSH 原生 connection cookie/auth 保护主壳；新增业务 proxy handler 对每个 HTTP 请求（含静态、媒体和下载）调用 `ctx.connection.requestRejection(req)`，401/403 即停止，否则才转发至 loopback Django。DSH 原生 `/api/*`、`/connect`、`/api/remote.mux` 路由保持原样，不代理 Django 的 `/api`。

官方 DSH connection 注册 `/api`、`/connect` 和远程 WebSocket `/api/remote.mux`；这些原生路由保持不动。自有 server plugin 注册无尾斜杠的 `/business`、`/business-api`、`/business-static`、`/business-media` 四类 segment-boundary alias；每个 handler 先调用官方 `requestRejection(req)`，认证通过才分别映射到 Django 页面、`/api/*`、`/static/*`、`/uploads/*`。当前 Django `MEDIA_URL` 实际为 `/uploads/`，`/business-media/*` 映射到此路径。业务 `/business-api/*` 有独立 DSH connection guard，绝不占用或重写原生 DSH `/api/*`。

DSH 原生启动 token 只用于建立该独立 DSH 实例的 authority-bound HttpOnly cookie，token 不进入业务 URL。所有业务页面、API、静态、媒体和下载请求均单独调用 connection auth guard。浏览器同源业务 POST 继续通过 Django CSRF middleware 与同 app Origin 检查；转发固定目标，不接受任意代理目标或外部 redirect。验收要求匿名无法读取 DSH 会话/运行数据、业务内容/API 或建立远程会话 WS；不对官方公开静态壳资源作未验证的拒绝承诺。

自有 main panel 只加载固定 Django 页面路由到同源 iframe/嵌入页，不加载用户 URL。Django embed 模板仅隐藏 Django 重复业务导航；embed 布局将主内容切换为单栏，普通页面布局不变。为保留模板、硬编码 `/api`、`/static`、`/uploads/`、`/workflow-tasks` 等既有链接/表单/下载，Task 3 已审查实际模板与 JS 调用点，并提供精确 `businessUrl()`/prefix helper：页面内部链接和表单保留现路由语义，Django API 映射到明确 `/business-api/*` 受控 alias；静态、媒体和下载分别走 `/business-static/*`、`/business-media/*`。Django 响应 URL 字段由现有 API 生成时使用 helper，proxy 不盲目替换整段 HTML/JSON。`app.js` 的 fetch、上传、导航和下载链接使用同一个 helper。该 helper 不重写业务执行逻辑。

iframe 与 DSH 主页同源；CSP 允许 `frame-src 'self'`、`frame-ancestors 'self'`，静态资源和 media/download 通过受保护的同源代理继续走现有 Django 路由；首版只适用于可信局域网，不承诺 TLS 或公网安全。

业务面板只复用现有 Django URLs 与模板/API；Django 保持 loopback-only，业务数据访问由 DSH 原生连接授权保护。Agent 预算由 DSH 原生 `tools/pre-execute` 门禁在工具执行前按 root session 计数，不新增业务表或自造执行包装层；每个 root session 最多 4 次委派，中心与直接子 Agent 累计最多 16 条消息，最大并发 4、深度 1。Task 2 核实门禁真实输入字段及原子计数存储位置；不实现 agent loop，不复制官方 spawn/send 工具。

启动 DSH 子进程时只向子进程构造受限环境：先移除继承的 provider secret 变量（含 `DEEPSEEK_API_KEY` 及实际启用 provider 的同类变量）和继承的 `DSH_*` 路由变量，再仅设置 app-owned `DSH_HOME`、`DSH_AGENTS_HOME`。cwd 固定为 app-owned 业务 workspace，避免从工作目录加载 `.env`/`AGENTS.md`。不读取或记录变量值，不修改父进程/系统环境，不复制当前 DSH credentials；新 home 后续由用户通过官方登录流程建立自己的凭据。

## 独立发行布局

- 源码只读参考：`workspace/research/references/deepseek-harness/`。
- 可升级发行副本：仓库外 sibling `workspace/runtime/tradeloom-harness/releases/<pin>/`，固定上游 remote、tag/commit 和 MIT license；它只是编译副本/cache，不放唯一自有源码。现有 `upstream`/`build-tools` 不可覆写。clone、依赖安装、构建、打包均在新的版本化 app-owned 副本执行；禁止全局 npm/pnpm update。
- 本机 DSH 数据：`%LOCALAPPDATA%\TradeLoom\harness-home`，专用 profile/runtime/config 与 DSH session 存储均在此处。
- 自有插件源码：仓库 `packages/tradeloom-shell/`，以一个复合 plugin bundle 发布；可协作审查和版本管理。
- 上游 patch 源码：仓库 `integrations/dsh/patches/`；经兼容检查后复制/应用到 workspace runtime。
- 启动器与辅助脚本源码：仓库 `apps/tradeloom-launcher/`、`scripts/dsh/`；workspace runtime 只收构建产物/临时副本。
- Windows 用户入口：单一桌面启动器负责依赖检测、物理网卡具体 LAN IPv4 选择（优先 Wi-Fi，也允许 Ethernet）、启动顺序、连接地址和停止自有进程；占用端口即退出，不杀进程。子进程 DSH_HOME、DSH_AGENTS_HOME、cwd、provider env 清理与运行数据均限定于 app-owned 路径。

上游已知版本要求 Node `^22.19.0 || >=24.0.0`、pnpm `11.28.5`。隔离基线实测 `pnpm install --frozen-lockfile --ignore-scripts` 成功；首次 `build:web` 因缺生成的 worker 包失败，随后 `pnpm run build:lib` 成功，再执行 `pnpm run build:web` 成功（156 files，输出 index SHA-256 `94BB1ABD888BFA2B5CB77A3F396C174DF2C482D1AAF3B3F657ABC0E8C9E64D41`）。Windows installer 尚未执行。升级候选需锁 commit、运行 patch `git apply --check` 与 feature contract tests；失败时不改当前发行目录，留存补丁冲突报告。

## 成功验收

1. 同一局域网中电脑和手机打开 `http://<电脑LAN-IP>:3088` 同一 origin；未授权不能读取 DSH 会话/运行数据、Django 业务页/API 或完成远程会话 WebSocket upgrade；公开静态壳资源按 DSH 原生行为处理。授权后可访问，CSRF 失败写请求仍拒绝。
2. 顶部菜单、左 Agent 列表在桌面/窄屏可见；选择中心、专家后均进入真实 DSH session，浏览器刷新后会话可恢复。
3. 中心对专家发起真实原生委派，完成事件回流；用户可开专家 session 并直接对话。拒绝 shell、任意路径文件和无白名单工具。
4. 业务面板同源显示；预览、人工确认、Django 既有权限/幂等和审批继续生效。
5. clean independent runtime 上可从源快照重建；patch apply check + 构建/测试全绿；一次升级兼容模拟给出可解释结果。构建/运行/停止日志、进程 command line、DSH_HOME、绑定地址和端口证明均只指向 TradeLoom-owned paths、IP 和 3088；拒绝占用端口时不杀进程。测试 launcher 对非 app-owned runtime/home 路径的拒绝场景，并记录新 app 自己启动的进程句柄、cwd、环境、数据路径和监听端口；不读取当前工作 DSH 私密目录或会话，也不要求现有用户进程状态保持不变。
6. 可交付 Windows 启动器和独立 Electron 包（独立 `appId`、产品名、安装/快捷方式/卸载身份、userData/cache，禁用默认 `dsh://` 接管）；手机实机浏览器访问并完成一次业务只读查看和一次有确认门槛的业务流程。若未做实机，则报告明确写未验证。

