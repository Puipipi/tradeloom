# DSH 织贸业务工作台实施计划

**目标：** 基于官方 DSH 主壳、原生聊天和 subagent runtime，提供 Windows 一键启动、同一局域网手机可用的业务工作台；现有 Django/Postgres 继续作为业务规则、审批、幂等和交付的唯一权威。

**固定上游：** `0.2.1-rc.2` / `687f282e8625c6b8d11ff58211a90524be2e4317`，MIT。官方源码只读于 `workspace/research/references/deepseek-harness/`。唯一自有源码、patch、脚本和测试均在本仓库；构建副本/cache 位于仓库外 sibling `workspace/runtime/tradeloom-harness/releases/<pin>/`。不写入或覆盖已有 `upstream`、`build-tools`。

## 全局执行约束

- 不读取、复制、修改、升级、重启当前工作 DSH 的 home、profile、auth、session 或进程；不运行全局 `dsh`，不修改现有正式 Django `8000` 或 Postgres 服务/数据。
- 每次读写/移动/递归清理 runtime 前检查绝对路径在 app-owned 根内，拒绝 reparse-point ancestor；已有目标永不覆盖。端口占用就报告退出，不 kill、不替换。
- Python 使用 `<LOCAL_PYTHON_ENV>\Scripts\python.exe`；业务测试用现有 PG `55432` 上独立 `TEST_NAME`。未来迁移前记录并保护现有表/数据，禁止 reset/drop/truncate。
- 上游 Node `^22.19.0 || >=24.0.0`、pnpm `11.28.5`。隔离基线已验证 frozen install；首个 `build:web` 因缺 worker 包失败，接着 `build:lib`、再 `build:web` 成功。Windows installer 尚未验证。不得重跑已完成 baseline 来替代后续增量验证。
- 自有界面以一个 DSH composite plugin 发布；保留 DSH 原生 session、chat、tool/subagent execution。隐藏任何私有推理链，仅显示最终回复、执行状态、工具结果、依据和下一步；实现前先核对官方 renderer 配置。
- 所有模型 Agent 使用最小工具权限；专家不可派生/互发。原生 `tools/pre-execute` 在工具运行前执行预算门禁：每个 root session 最多 4 次委派，中心与直接子 Agent 之间累计最多 16 条消息；`maxActiveSubagents=4`、`maxDepth=1`。Task 2 核实门禁实际输入、原子计数存储与恢复语义，不复制官方 spawn/send 工具，也不加业务数据库或自建 agent loop。

## Task 1：锁定独立上游和可复用 slot patches（本批已授权）

**文件：** `scripts/dsh/prepare-runtime.ps1`、`scripts/dsh/check-upstream.ps1`、`scripts/dsh/tests/test_patch_lifecycle.py`、`integrations/dsh/patches/patches.lock.json`、`ui-layout-shell-top.patch`、`ui-sidebar-agents.patch`、`THIRD_PARTY_NOTICES.md`（仅在无既有对应文件时新增）、本规格/本计划/`docs/work-report.md`。

**补丁范围：** 两个 patch 覆盖五个官方文件：ui-layout slot registry 与 AppFrame；ui-sidebar slot contract、slot registry 与 SidebarRoot。新增 `shell.top` 全宽顶部槽和 `sidebar.agents` 槽，不改动原 workspaces/native chat 行为。补丁锁定上游 commit、MIT LICENSE SHA 和两个 patch SHA。

**行为接口：** `prepare-runtime.ps1 -ReferencePath <pinned-or-test-source> -RuntimePath <new-versioned-app-owned-target>` 仅接受只读固定 source 或测试 fixture；目标须为空且只能是外部 releases 的一个版本化子目录或测试根内路径。检查 HEAD/license/patch hashes，staging clone 后依序 dry-run/apply 并原子发布。`check-upstream.ps1 -RuntimePath <patched-app-owned-runtime> [-CandidateRef <descendant-ref>]` 输出结构化 `compatible | conflict` 和非零区分 exit code，不改当前 runtime。禁止 repo-local workspace runtime、foreign path、junction/reparse ancestor 和已存在目标。

**验证：** stdlib unittest 通过 `pwsh -NoProfile -File` 驱动真实临时 Git repositories。覆盖成功应用、上游 HEAD/license mismatch、patch context drift、候选兼容成功和冲突、已存在目标拒绝、错误路径拒绝、junction 指向 foreign temp 目录且 sentinel 不变、source/runtime 不变。脚本另有 patch SHA 锁校验，但本批没有单独 hash mismatch 行为用例。保存首次失败与最终命令/exit/output、基线/结果 SHA 到 `<LOCAL_EVIDENCE_ROOT>\dsh-slot-patches`。本任务不执行 DSH build/install/run，不碰 baseline builder 目录。

## Task 2：DSH 主壳导航、Agent 目录和原生委派

**文件：** 仓库内 `packages/tradeloom-shell/` 单一 composite plugin（manifest、client/host entry、角色和业务路由、原生 Agent presets、apphome 原子状态/预算策略、合同测试）；业务 app 独有的上游 renderer 可见性与 UI 测试 patch 放 `integrations/dsh/patches/`。生成/安装源码仅在需要时加到 `scripts/dsh/`，本批不执行安装。Task 1 slot test fixture hunk并入既有sidebar patch；所有patch目标均锁定在 pinned source 已有文件。

**实现依据：** 复用官方 decoration/plugin packaging contract，`shell.top` 放总览、商品、Agent 中心、资料、运行记录五项可横向滚动业务菜单，分别对应 `/home`、`/products`、`/agent-center`、`/artifacts`、`/runs`，`sidebar.agents` 放中心、商品、市场占位、询报价占位、交付、用户资料演示目录；registry 默认 preset 为中心；Client 不强制跳转以保留原生恢复，首次无选中 workspace 时用户可从左侧目录打开中心。`connection.requestRejection(req)` 先保护专用 Host routes；在显式相同的 `TRADELOOM_DSH_APP_HOME` 与 `DSH_HOME` 且 marker 有效时，共用 apphome 下原子 JSON store 持久化 role→workspace/session映射和预算。Host 复用公开 `ctx.workspaceRegistry.list/create`、`ctx.sessionController.create`；Client 用 `uiWorkspace.openSession(sessionId)` 保留原生聊天。专家可通过自己的 DSH root session直接对话；中心用官方 subagent与send_message。角色明确指定各自独立 preset，不继承 `standard`/`sdk-minimal`，专家不加载派生/互发、shell、fs、MCP或业务写工具。中心的 native tool gate 挂在 `tools/pre-execute`，用稳定 `Agent.id` 与直接子 `header.parentSession` 算 root key；每 root最多4次delegate与16条中心/直接子 send_message尝试（失败和超限尝试也计入），并发4、深度1、子 maxTokens 4096。tests使用真实 exec字段形状和真实文件状态，不调用模型或伪称 native integration。五个业务菜单各有独立 keyed main panel，四个 alias 仅为 Host 路由前缀，不作为菜单项；Task 3接入前清楚标为未接；思维链整页通过 deployment `ChatPresentationPolicy` 和 `ReasoningRow` renderer patch隐藏，保留visible实现分支、正常状态/最终回复/工具结果。

**验证：** 上游 renderer与slot补丁的本地unittest lifecycle suite、受影响的client tests/build和自有 Node合同测试。已经成功的patched `build:lib`/`build:web` 不重跑。Native DSH安装、模型、真实会话/委派与UI验收由主控后续授权安排；当前Node contracts与source checks不作为它们的替代。

## Task 3：同源 Django 业务嵌入

**文件：** 先检查现有 Django templates、`app.js`、URL/下载/API 响应，再仅修改必需的 `workbench/templates/...`、`workbench/static/workbench/app.js`、URL helper/template tag 和 plugin server route；新增有行为意义的 Django tests。Django 原有业务规则和 API 语义不重写。

**路由/授权：** DSH 原生服务直接处理 `/api/*`、`/connect`、精确 WS `/api/remote.mux`。Composite server plugin 注册无尾斜杠的 `/business`、`/business-api`、`/business-static`、`/business-media` 四类 segment-boundary alias；分别映射 Django 页面、`/api/*`、`/static/*`、`/uploads/*`。Django 实际 `MEDIA_URL` 为 `/uploads/`；`/business-media/*` 映射到此路径。每个 handler（GET、static、media、download、POST）先调用 `ctx.connection.requestRejection(req)`，拒绝即停止，放行才代理至 `127.0.0.1:3090`。请求和响应按流转发，保留下载及 CSRF 所需语义；原生 DSH cookie 不转发至 Django，也不允许 Django 覆盖。禁止 gateway 与 Django auth/session/owner/team schema。Django 原有 CSRF 和同 app Origin 检查保护写请求。每条代理路由目的固定，不接受任意 URL/redirect。匿名验收覆盖会话/运行数据、业务内容/API、远程 WS；不假定公开 DSH 静态壳资源也拒绝匿名读取。

**嵌入行为：** iframe 同源；embed base 只隐藏重复 Django 导航。保留 templates、硬编码 `/api`、`/static`、`/uploads/`、`/workflow-tasks`、表单提交和下载：先由实际调用点清单驱动 `businessUrl()` helper，使页面内链/表单、API POST、上传、JS 导航和响应中 preview/download URL 使用四类 alias；不对整段 HTML/JSON 做字符串替换。CSP 仅允许同源 frame/assets，media/download 继续经 Django 原权限路径。

**验证：** Python 使用固定解释器、`tradeloom_dev` 正式连接身份和独立测试库 `tradeloom_test_dsh_business_embed` 运行 Django 测试。embed 定向测试 7/7；与页面回归模块组合为 19/19、exit 0，migration 应用于隔离测试库并保留。另通过官方 compiled WebServer `match` 验证四 alias 路由契约，Node loopback fixture 覆盖代理流、下载响应头和授权先拒绝。旧 run7 中止日志保留但不作通过证据；当前页面 iframe 在真实 DSH/Django `3090` 进程中的布局与端到端业务流程仍待 launcher/runtime 阶段验收。未来如需 migration，先留存并比较现有 live tables/rows，再仅允许可回滚 additive schema；本方案默认不需 Django auth/AgentBudget migration。

## Task 4：隔离启动器、局域网绑定和独立桌面发行

**文件：** `apps/tradeloom-launcher/`、`scripts/launch-tradeloom.ps1`、`scripts/stop-tradeloom.ps1`、最小必要的 Electron builder override、launcher tests、quick-start。

**启动合同：** launcher 提供单一“启动织贸工作台”入口，检查 `3088` 与 `3090` 空闲；DSH 绑定用户选择的活动物理网卡具体私有 LAN IPv4 的 `:3088`（优先 Wi-Fi，也允许 Ethernet），Django 只绑定 `127.0.0.1:3090`。没有 LAN IPv4、wildcard/public/VPN 地址或端口冲突时显示说明并退出；不自动修改宽泛防火墙规则。子进程使用 `%LOCALAPPDATA%\TradeLoom\harness-home` 与 app-owned `DSH_AGENTS_HOME`，cwd 固定 app-owned workspace。仅在 child environment 中清除继承 provider secrets（包括 `DEEPSEEK_API_KEY` 与启用 provider）和 `DSH_*` 路由配置，再设置本 app 的 DSH paths；不读取/记录变量值、不改父进程环境、不复制凭据。stop 只通过本次 launcher 保存的 child handles 停止自身进程。

首次使用由 launcher 触发官方 DSH 新 home 的正常登录流程；不实现额外 Django 用户设置/SSO/RBAC。DSH 每条业务 proxy 使用原生 `requestRejection`；只把 authority-bound cookie 作为访问保护，token 不进业务 URL。局域网明文不宣称 TLS 或公网安全。

Electron 发行必须使用独立 `appId=cn.tradeloom.workbench`、产品名“织贸助手”、exe/install 目录、shortcut、卸载项、Electron `userData`/cache，并禁用或重命名默认 `dsh://` scheme；验证包 metadata 后才允许安装，不接管/覆盖当前 DSH。

**验证：** 真实 launcher tests 覆盖地址选择、占用端口拒绝、child env 清理/DSH path ownership、只停止自有 handles、打包 metadata。端口与路径检查先行；绝不枚举或检查现工作 DSH 私密目录、进程内容或会话。

## Task 5：上游升级、真实委派与跨设备交付验收

**文件：** `e2e/dsh-native-delegation.spec.ts`、升级 fixture tests、`docs/quick-start.md`、`docs/upgrade-harness.md`、`docs/work-report.md`。

**验证：** 构造本地 pinned-compatible 与 patch-conflict descendant refs，分别要求兼容报告 exit 0、冲突报告稳定非零，当前 runtime SHA/status 前后相同。用 DSH 原生 session events 验证中心 spawn 专家、`subagent/start`/`subagent/end`、用户直接消息、刷新恢复，并确保模型不能绕过 Django 确认。Windows 打包只从隔离副本执行官方 desktop package script，验证 installer identity/paths。真实电脑保持开机，用同局域网手机浏览器访问并执行业务只读查看和一项有确定性确认门槛的流程；未实机的项明确标注未验证，不声称 PWA/offline 或 installation 验收。

**交付：** 面向零命令行用户说明启动、网络选择、登录、退出和升级回滚。报告只记录 app-owned paths、监听地址/端口和自身 PID handles；不读工作 DSH 私密状态。所有变更可审阅，不执行 `git add`、commit 或 push。
