# 原生场景工作台与 ERPNext 入口实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans or superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在现有 DSH 原生窗口内落地可配置 Dockview 场景、真实原生会话嵌入、共享 per-session 模型目录入口，并增加明确断开的 ERPNext 服务入口。Dockview 的 desktop dock/split/tab/resize 交互取代本计划早期实现的固定 4×4 网格目标；旧 v1 网格只作为迁移输入与恢复快照。

**Architecture:** 继续使用 `@tradeloom/dsh-business-shell` composite plugin 和现有 Django/PostgreSQL 业务 UI。场景 JSON 与受限 panel registry 描述默认面板和内容；Dockview React core 管理用户的停靠、分割、标签和大小。布局状态经现有受保护 shell route 写入产品 apphome；窄屏使用容器 `ResizeObserver` 显示单面板选择视图，不改桌面 Dockview 树。原生聊天通过公开 `conversation.content` Factory + `SessionProvider` + `sessions.retain` 显示原 role session，Dockview 常驻 renderer 保留 panel DOM；顶部模型选择消费该 session 的原生 `ModelDirectory`。本批不 fork/修改 DSH、不改 Django 业务规则、不部署 ERPNext。

**Tech Stack:** 现有 Node.js ESM、DSH Cordis/React public client contracts、Vitest/jsdom renderer tests、原生 DSH model/session services、现有 launcher 和 apphome JSON state。

**Dockview dependency:** pin `dockview-react@8.6.0` (MIT; React peer dependency externalized to the host). First prove a separately built ModuleLoader factory asset under pinned candidate7’s real loader and renderer, including shared React identity, before changing the shell package. Use Dockview `renderer: 'always'` for iframe/native chat panels. Do not use a bare ESM import, a second React, eval/CSP changes, or a hand-built docking engine.

**Spec:** `docs/superpowers/specs/2026-10-21-unified-workbench-erpnext-design.md`

## Global Constraints

- 产品分支保持 `feature/workbench-shell`；不改个人 DSH home/profile/session，不改 pinned candidate7 上游源码，不创建 DSH fork。
- 维持现有五业务路由、六个通用 Agent/preset、提案交接和所有 Django 人工确认门禁；Agent 身份与 model/provider 选择分开。
- 聊天嵌入只能复用原生 `conversation.content`、显式 SessionProvider 和 `sessions.retain/release`，不搬运 DOM、不复制聊天 UI、不生成第二份会话或 provider 状态。
- 目标桌面采用 Dockview 原生 dock/split/tab/resize；配置仍决定允许的场景、面板、初始内容和注册类型。现有 v1 `{col,row,w,h,visible}` 只用于迁移。v2 按 sceneId 保存有界 `DockviewApi.toJSON()` 与产品自有关闭面板元数据；遇到重叠或不可安全表示的旧布局时生成确定性默认停靠布局并保留不可变 v1 快照，不能静默丢弃用户布局。
- Dockview 只负责工作区面板区域；顶层模型 rail、第二层紧凑场景导航与左 Agent rail 固定不动。窄屏由工作区容器 ResizeObserver 切为单面板选择，布局数据只保存桌面树，容器变宽恢复同一树。
- 布局偏好只存产品 apphome state；role→session 持久映射继续用现有 `/tradeloom/session`；不得把 UI 偏好写入业务数据库。
- 新场景仅能使用已注册 panel types；panel source/path 必须走现有固定路由 allowlist，不开放任意 URL、任意 renderer module 或外部 DOM。
- 顶部模型目录 rail 只读当前原生 session 的 `ctx.modelDirectories.directoryFor(sessionId)`，按真实 provider/model 分组展示图标，缺图标时使用名称首字并提供可访问名称；通过原生 `ModelDirectory.select()` 更改。保留原生 settings/provider 配置入口，不伪造模型或 provider。
- 场景导航与五个业务入口使用 `layout.selectPanel('scene-workbench')` 进入正式网格，并设置配置内已登记的业务 iframe route；禁止通过 `uiWorkspace.openSession` 把工作台换成全屏聊天。左侧六 Agent 点击选择既有 role/preset/session 并绑定网格中的原生聊天。
- ERPNext 本批只展示独立“未连接”入口，不创建或同步 ERP 记录；后续官方 API/七类 DocType/Quotation 草稿不纳入首批代码任务。
- Dockview loader 阶段及实现只运行下方定向 Node 和 candidate7 真实 renderer tests；真实 iframe 拖动命中、native session/draft 保留与窄宽往返需源模式 GUI 验证。获得主控审查后才按本机已有 `sync-dev-bundle` 和显式 candidate/DataRoot 启动 source-mode；不打包、安装或上传。
- 不编造企业事实或角色分工；独立参考 preview 保持原样。新示例只用无敏感合成数据并显式标记。

---

### Task 0: 以 pinned ModuleLoader 验证外置 Dockview 资产

**Files (external test workspace only until review):**
- Create: `workspace/testing/desktop-package-contract/unified-workbench-erpnext-20261021/dockview-loader-spike/` with pinned dependency manifest/lock, generated single Dockview asset, CSS, license and test evidence.
- Read-only runtime: candidate7’s actual ModuleLoader implementation and existing UI renderer test configuration.

**Interfaces:**
- Build Dockview into a single host ModuleLoader factory asset; only `react`, `react-dom`, `react-dom/client` and JSX runtime remain external and resolve through the host `require`.
- The test must register/load that asset through the actual pinned ModuleLoader path, mount a Dockview panel through the pinned renderer, and assert the adapter’s React object is identical to the host React export. Confirm `renderer:'always'` keeps a hidden panel mounted and that the bundled CSS is separately loadable without weakening CSP.

- [ ] **Step 1: Inspect pinned loader registration, package resolver, React externals and existing renderer harness.** Do not infer support from a plain browser import.
- [ ] **Step 2: Build the isolated asset with pinned `dockview-react@8.6.0` and preserve its MIT license/provenance.** Tooling/dependencies stay in external workspace cache, never project `node_modules`.
- [ ] **Step 3: Run the actual candidate7 loader/renderer proof.** If the loader cannot resolve the external asset with the host React instance, stop and report the exact failure before choosing another layout engine.
- [ ] **Step 4: Parent review checkpoint.** Only after the proof is accepted may the Dockview asset/CSS enter the product shell package allowlist/inject path.

### Task 1: 以 Dockview 替换固定网格并迁移场景布局

**Files:**
- Modify: `packages/tradeloom-shell/scenes.json`
- Create: `packages/tradeloom-shell/scene-layout.js`
- Modify: `packages/tradeloom-shell/client.scenes.js`
- Modify: `packages/tradeloom-shell/host.js`
- Modify: `packages/tradeloom-shell/state.js`
- Modify: `packages/tradeloom-shell/package.json`
- Test: `packages/tradeloom-shell/tests/scenes.test.js`
- Test: `packages/tradeloom-shell/tests/shell.test.js`

**Interfaces:**
- Consumes: current version-1 `scenes.json`, `ROLE_IDS`, `createStateStore().transact()` and protected `ctx.connection.requestRejection(req)`.
- Produces: scene config and panel registry with no fixed desktop grid; a version-2 layout record `{ sceneId, dockview: <bounded Dockview JSON>, closedPanelIds: [...] }`; pure validation/migration from current v1 `{col,row,w,h,visible}` state; and existing protected `GET/PUT /tradeloom/scene-layouts` returning validated per-scene preferences.
- Migration reads old v1 geometry/visibility without mutating it during GET. A safely representable non-overlapping layout maps to Dockview groups/splits. Overlapping or otherwise unrepresentable geometry gets deterministic config-order defaults and an immutable bounded v1 recovery snapshot. The first successful explicit layout save writes the v2 state atomically. Any rejection/save failure leaves the previous v1 snapshot and last valid v2 layout intact and is visible/retryable.
- Dockview state accepts only registered panel component IDs and bounded product-owned parameters; it never persists HTML, credentials, provider data or arbitrary URLs. Each scene’s `dockview` JSON is independent; narrow mode is transient presentation state and does not overwrite it.
- Renderer registry types for this batch: existing business iframe and explicit ERP status, plus the native embedded chat. Dockview component IDs resolve only through the existing panel registry; business iframe source remains a known Django route, not arbitrary URL input.

- [x] **Step 1: Add v1 baseline compatibility tests.** Existing `scenes.test.js` covers direct `col`/`row`/`w`/`h` defaults, five routes and invalid config; preserve those fixtures as v1 migration inputs while adding Dockview serialization/migration assertions.
- [x] **Step 2: Run the focused Node tests.** Initial scene+shell run exposed two route/layout assertion issues; the final focused command and result are recorded under Task 2 below. The later package-allowlist regression also produced its own real RED/GREEN logs.
- [ ] **Step 3: Replace fixed grid rendering with the reviewed Dockview adapter.** Keep `PANEL_REGISTRY`, native session refs and the native chat Factory intact; use always-render for stateful panels. Provide narrow single-panel navigation based on the container ResizeObserver without serializing narrow-mode changes.
- [ ] **Step 4: Add persistence migration and failure handling.** Save Dockview JSON per scene through the existing protected state route; preserve v1 snapshots and verify invalid/corrupt state cannot remove the last valid layout.
- [ ] **Step 5: Run focused tests and real renderer interactions.** Cover panel move/split/tab/resize, scene isolation, restart round-trip, legacy conversion/overlap fallback, narrow→wide restore, failed save, iframe drag target, retained native session/composer and business form state. The earlier 37/3 Node result is historical and does not validate this Dockview transition.

### Task 2: 在场景中嵌入真实原生 role 会话

**Files:**
- Modify: `packages/tradeloom-shell/client.js`
- Modify: `packages/tradeloom-shell/client.scenes.js`
- Modify: `packages/tradeloom-shell/package.json`
- Modify: `packages/tradeloom-shell/scene-layout.js`
- Test: `packages/tradeloom-shell/tests/scenes.test.js`, `packages/tradeloom-shell/tests/shell.test.js`
- Existing handoff regression: `packages/tradeloom-shell/handoff/tests/proposal-handoff.client.spec.tsx`

**Interfaces:**
- Consumes: `POST /tradeloom/session { role } -> { role, sessionId }`; injected `ctx.sessions`; `ctx.slots` factory renderer; native `SessionProvider`; public factory `conversation.content` props `{ variant:'embedded', phase, hero }`; selected scene and selected role in UI state.
- Produces: `SceneWorkbench` and `SceneChatPanel` in `client.scenes.js`. The panel renders the public `conversation.content` factory inside the actual `SessionProvider`. A module-local `retainedByRole` map retains one native session reference per role with `{ source:'mainView' }`; scene switches reuse the same reference so native composer drafts remain alive. Replacing a role's session releases only that role's old reference; plugin context disposal releases the retained references. Agent controls bind the existing role session in the grid and do not open a full-screen conversation.
- Existing API evidence: candidate7 `packages/client/ui-conversation/src/client/contract/slots.ts:301-315,528-550`; `ui-conversation/src/client/apply.ts:336-349,560-572`; `ui-subagent/src/client/sidebar-chat/index.tsx:102-117,120-168,176-201`; `ui-layout/src/client/service.ts:28-36`.

- [x] **Step 1: Add focused scene/session behavior tests.** `scenes.test.js` covers the product wrapper's embedded Factory call, role/session reference reuse, independent per-role references and cleanup; `shell.test.js` covers route/session and package contracts. These tests do not use `SlotTestRuntime` and do not prove the pinned `ConversationContent` visual render.
- [x] **Step 2: Run the focused Node suite and handoff regression.** The Node scene+shell suite completed with 37 pass, 3 existing skips, 0 fail (exit 0). The existing candidate7 proposal-handoff renderer spec completed 3/3 (exit 0); it is a separate handoff check, not native chat/model rail evidence.

The proposal-handoff regression used this existing candidate7 command (3/3; it does not exercise the embedded native chat):

```powershell
$repo = (Get-Location).Path
$runtime = '<EXTERNAL_RUNTIME_ROOT>\tradeloom-harness\releases\0.2.1-rc.2-tradeloom-desktop-7'
pnpm --dir $runtime exec vitest run --root $repo --config "$repo\packages\tradeloom-shell\handoff\vitest.handoff.config.mjs"
```

- [x] **Step 3: Implement the embedded chat panel in the existing scene chunk.** `client.scenes.js` owns `SceneWorkbench`, `SceneChatPanel`, the SessionProvider binding, the per-role retained-reference pool and cleanup. No separate `client.scene-chat.js` module was created. `package.json` includes the `scene-layout.js` host dependency in its 14-file allowlist; tests remain outside the bundle.
- [x] **Step 4: Bind the Agent rail and business navigation to the same workbench.** The six preset IDs and `/tradeloom/session` role mapping remain; the five business routes select configured scenes/panels, and the proposal handoff continues to prefill Agent Center while keeping explicit human preview/confirmation.
- [ ] **Step 5: Verify the production native renderer in the live source-mode GUI.** The current tests prove product wrapper/session-retention contracts, not a real pinned `SlotTestRuntime` ConversationContent mount. Parent-owned GUI validation must confirm the embedded native conversation/composer and session draft retention; do not mark this plan complete from the wrapper tests alone.

### Task 3: 双层导航与真实 per-session 模型入口

**Files:**
- Modify: `packages/tradeloom-shell/client.js`
- Modify: `packages/tradeloom-shell/client.scenes.js`
- Modify: `packages/tradeloom-shell/package.json`
- Test: `packages/tradeloom-shell/tests/scenes.test.js`, `packages/tradeloom-shell/tests/shell.test.js`

**Interfaces:**
- Consumes: existing `BUSINESS_MENUS`, `SceneTabs`, role-to-session route, injected `ctx.modelDirectories` and its `directoryFor(sessionId)`; `ModelDirectory.load()`, `.subscribe()`, `.getSnapshot()`, `.select(selection)`.
- Produces: one root-scoped top component with a first-row provider/model icon rail populated only from the active session’s real ModelDirectory plus the unchanged native settings affordance, and a second compact business/scene navigation row. Providers/models group from directory data; unavailable icons use a name initial and accessible label. Model selection reads and changes only the active role session’s directory.
- Existing API evidence: candidate7 `packages/client/ui-model-selection/src/client/service.ts:36-89`, `directory.ts:77-105`, `ui-model-selection/src/client/index.ts:107-193`; `ui-layout/src/client/service.ts:18-36`.

- [x] **Step 1: Add focused route and model-directory projection tests.** The current suite verifies the five routes and that model directory entries preserve provider/model identity; it does not yet exercise the live pinned ModelDirectory selection service in `SlotTestRuntime`.
- [x] **Step 2: Run focused Node checks.** The scene+shell result is 37 pass, 3 existing skips, 0 fail, exit 0; the package contract is included. Do not interpret this as a live model-catalog test.
- [x] **Step 3: Implement the real directory rail in `client.scenes.js`.** The rail resolves the active role's retained session, reads its injected `modelDirectories.directoryFor(sessionId)` and calls that directory's `load`/`select`; model identity is not copied into shell role/session state. No separate `client.model-menu.js` exists.
- [x] **Step 4: Compose one single-slot navigation component.** `client.js` keeps the `shell.top` occupant and composes the model rail, five business routes and scene tabs; the six-Agent rail remains intact.
- [ ] **Step 5: Verify the live provider/model directory in the source-mode GUI.** Confirm that each role displays its own native directory and that a selection persists through the existing service. Current automated wrapper tests do not establish this.

### Task 4: 增加明确断开的 ERPNext 服务入口

**Files:**
- Modify: `packages/tradeloom-shell/client.js`
- Modify: `packages/tradeloom-shell/client.scenes.js`
- Modify: `packages/tradeloom-shell/scenes.json`
- Modify: `packages/tradeloom-shell/package.json` only if adding a listed client module or asset
- Test: `packages/tradeloom-shell/tests/scenes.test.js`

**Interfaces:**
- Consumes: panel registry allowlist and current `layout.selectPanel`; no ERPNext credentials, network address, schema or connection state is assumed.
- Produces: a separate ERPNext scene/tab with a fixed disconnected state until an explicitly authorized later integration adds an official endpoint and credential contract. It does not count as a sixth Django business route or write to Django/ERPNext.

- [x] **Step 1: Add status/compatibility assertions.** Tests preserve the five existing Django route entries and verify the ERPNext scene presents only a disconnected state, without sample records or a write action.
- [x] **Step 2: Run focused Node tests.** The final scene+shell gate passed 37 tests with 3 existing skips and 0 failures; see Task 2 result and its log in the SDD ledger.
- [x] **Step 3: Add the disconnected integration scene.** `scenes.json` declares the ERPNext scene and `client.scenes.js` renders its fixed disconnected status. It does not fetch a guessed endpoint or write to either system.
- [x] **Step 4: Re-run focused Node tests.** The disconnected status and five-route compatibility checks are included in the same focused green gate. ERPNext service/API/DocType connection remains a separate later plan.

## 本机 source-mode handoff（经主控审查后）

当前 launcher 的显式参数在 `apps/tradeloom-launcher/cli.mjs:26-35,103-117,204-210`：支持 `start|sync-dev-bundle`、`--mode`、`--runtime` 与 `--data-root`。默认 runtime 来自 `apps/tradeloom-launcher/candidate-payload.mjs:DEFAULT_RUNTIME_CANDIDATE`，不是 candidate7；本机验收因此必须明确传 candidate7 的绝对路径与独立 DataRoot：

```powershell
$runtime = '<EXTERNAL_RUNTIME_ROOT>\tradeloom-harness\releases\0.2.1-rc.2-tradeloom-desktop-7'
$dataRoot = '<显式指定的产品专属 DataRoot>'
node apps/tradeloom-launcher/cli.mjs sync-dev-bundle --mode desktop --runtime $runtime --data-root $dataRoot
node apps/tradeloom-launcher/cli.mjs start --mode desktop --runtime $runtime --data-root $dataRoot
```

正常停止使用同一 DataRoot 对应的 `node apps/tradeloom-launcher/cli.mjs stop --data-root $dataRoot`，只请求本 launcher 管理的实例。上述命令只在主控批准实施后由运行负责人执行；本 plan 不执行启动/停止/同步。新依赖只增加到产品现有 package `files` allowlist，不改 pinned upstream 或默认 candidate，不 build/package/install/upload。

## 阶段 1：统一 shell Agent 注册与安全开发接缝（2026-10-21）

### 范围与行为边界

- **Modify:** `packages/tradeloom-shell/roles.js`, `state.js`, `scene-layout.js`, `client.js`, `client.scenes.js`, `host.js`, `business-tools.js`；仅在既有相邻测试需要时调整 `tests/shell.test.js`, `tests/scenes.test.js`, `tests/business-tools.test.js`。
- `roles.js` 提供单一 role 定义，继续导出 `ROLE_PRESETS`、`ROLE_LABELS`、`ROLE_IDS` 兼容视图。现有六个 ID、preset、显示名、session/workspace key 和原生会话 API 不变。
- `host.js` 在受保护的 GET `/tradeloom/scenes` 响应中增加仅含 `{id,label}` 的 `roles`。不得暴露 preset、prompt、工具权限、会话或工作区信息。客户端复用既有 scenes 加载与错误状态读取该列表，不另建请求/持久化；缺少/加载失败时维持原界面加载失败与重试语义。
- `state.js` 与 `scene-layout.js` 从共同事实源校验 role ID；`business-tools.js` 的工具 allowlist 保持逐项显式。新增角色默认无工具权限，不通过“已知 preset 列表”推导全权限。Python workflow role registry 保持独立。
- 本项目级发布授权已由用户明确给出：框架完成并经自查后可提交/推送 GitHub；此阶段不 stage/commit/push，后续也必须先验证发布内容不含敏感资料。

### 针对性测试与接入步骤

1. 先写行为测试：既有六角色由同一 registry 派生且 session/preset 兼容；scene handler 返回安全角色 DTO；场景校验和会话创建拒绝未知 ID；未知 role/preset 不获任何 tool allowlist。
2. RED 后实施最小抽取/导出兼容，再运行 `shell.test.js`、`scenes.test.js`、`business-tools.test.js` 定向 Node tests 与既有 pinned renderer gate。保存实际日志、exit code 和覆盖全文件（包括未跟踪文件）的 diff 快照。
3. 新增 shell role 的开发步骤：在 `roles.js` 注册稳定 role ID/preset/label；按需把 ID 加到受控场景配置；工具须在对应的每工具 allowlist 中单独授权；运行对应契约测试。不得新增产品业务职责或团队分工。
4. 独立 reader 审阅 diff、权限边界与测试证据后，再交父决定是否同步运行实例。本阶段不做 DTO/ERPNext/image/web bridge/模块示例，不启动或更改运行实例。

### 阶段 1 实施记录

- 已完成：统一六个 shell role 的定义与兼容导出；状态校验、场景校验、客户端助手选择和服务端安全角色 DTO 均使用同一事实源；工具 allowlist 保持逐角色显式授权。
- 验证结果：shell 定向 Node suite 66 项，60 pass、6 个既有可选依赖 skip、0 fail，exit 0；candidate7 pinned SlotTestRuntime renderer 7/7 pass，exit 0。最终日志和 exit 文件为 `testing/desktop-package-contract/agent-registry-20261021/shell-targeted-final.log`、`shell-targeted-final.exit`、`pinned-renderer-targeted.log`、`pinned-renderer-targeted.exit`；完整当前文件快照位于 `testing/desktop-package-contract/agent-registry-20261021/review-snapshot/`。未运行完整仓库套件。
- 本阶段没有同步或重启运行实例，未 stage/commit/push。用户已授权后续框架完成并自查后提交/推送；私有目标仓库由主控建立为 `Puipipi/tradeloom`，本阶段未添加 remote。
- 未完成的跨 Agent DTO、ERPNext 受控写入、图像/网页桥和模块示例仍是后续目标；此阶段结果不代表整体框架完成。
