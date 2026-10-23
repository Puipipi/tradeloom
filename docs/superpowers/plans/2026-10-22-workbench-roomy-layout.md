# Workbench Roomier Layout Implementation Plan

> **For agentic workers:** Follow this short plan in order; keep changes within the Phase C ownership scope and do not commit or activate the app.

**Goal:** Give the business workbench a clear main task, keep native chat independent, and reduce the vertical and horizontal crowding in the shell and intake page.

**Architecture:** Keep the existing two-row shell, SceneTabs, native `renderSlot` chat factory, and Dockview persistence. Each scene has one closed layout profile in `scenes.json`; defaults and explicit recommendation reset serialize it into Dockview. Retain stored v2 custom layouts. Use the host's existing maximize-and-picker mode when the Dockview canvas cannot fit a profile. Add accessible intake task tabs that toggle visibility on existing DOM sections in place, preserving forms, drafts, and scroll state.

**Tech Stack:** Existing React shell, Dockview, CSS variables, Django templates, vanilla JS, Node tests, jsdom.

**Spec:** User's Phase C instruction dated 2026-10-22. Reference: [luanyujia-workbench](https://github.com/mashanglinyu/luanyujia-workbench), commit `5e961be6b83ff742adbd4d226455f2ccd24efbc0`.

## Visual direction

Retain TradeLoom's current light/dark surface, ink, muted, line, and accent variables and system/Segoe UI typography. Tighten to two compact shell rows and use the screenshot-defined scene-specific pane hierarchy, retaining one native chat panel per scene. Use a persistent task strip over the intake work area; the existing source list and preview remain together. Borrow only the reference's compact navigation, clear panel hierarchy, thin separators, and independent scrolling.

```text
┌ model / agent / theme / tools ───────────────────────────────┐
├ scene icons; active label expands ───────────────────────────┤
│      scene-specific panels; independent Dockview resizing       │
└───────────────────────────────────────┴─────────────────────┘
Intake  [原件] [字段整理] [候选关联] [访谈依据] [生产要求] [计划]
        ┌ one visible task; existing nodes remain mounted ┐
```

## Screenshot mapping and adoption boundary

- `#1`, `#3`, and `#6` show a website's own history and document preview; `#10` shows the host's native conversation history, a separate layer with a different owner. The reference source describes an expand-overlay that closes with Escape; its arrow direction and cyan-focus mapping remain unverified. Reuse Dockview's existing maximize/restore behavior; do not reproduce the author's custom overlay.
- `#2` shows two independent large conversations, each with its own reload, task, composer, and scroll. Use it as evidence for giving chat real space; keep the existing one-native-chat-per-scene contract rather than inventing a second session.
- `#3/#4/#11` inform the four-panel collaboration profile for Products, Agent Center, and Deliverables: current business main and auxiliary in the upper row at 75/25; reference and native chat in the lower row at 25/75; rows at 58/42. Use existing panel IDs and types only. `#4` lacks a visible global scene bar; a separate window is one possible explanation, not a confirmed behavior.
- `#5` belongs to another machine/user theme and dedicated experiment tools. Do not copy its flowers, bows, image-analysis action, or identity.
- `#7` is an operations console with terminal, status, cloud, files, logs, and chat. It does not add SSH or market data to TradeLoom.
- `#10` keeps conversation tools with the host conversation and its history. The shell's global tools menu therefore holds plugin, automation, explicit sidebar toggle, mobile link, and return-to-workbench actions; chat-specific controls stay in the chat panel.
- `#11/#12/#13` support grouping existing tools in an anchored menu that overlays rather than resizes the work area. Their node engine, custom “start” behavior, templates, and specialized board controls are not added without corresponding TradeLoom capabilities.
- `#14` informs compact inactive scene icons, expanded active labels, and a right-aligned tool affordance. Snapshot, notification, session-pressure, and folder actions visible in that host version are not shown as clickable controls unless TradeLoom has a real handler.
- `#6/#8/#9` are byte-identical and count as one screenshot observation, not three independent examples.

The scene profiles are: Center assistant-led at 32/68 with all three existing business panels tabbed on the left and native chat full-height on the right; Products, Agent Center, and Deliverables use the four-panel profile above; Runs, User Profile, and ERPNext are business-led at 72/28 with auxiliary business panels tabbed together. The minima are based on the actual Dockview canvas: the assistant-led profile needs 320px for its 32% context side and 560px for the 68% chat side, so 1000px total; the business-led profile needs 800px for business and 320px for chat, so 1143px total. Four-panel layouts need 1200×600 (300px narrow panes and 900px business/chat panes across each row). Assistant-led and business-led profiles require 360px height; the four-panel profile requires 600px. Below either profile threshold, use the existing single-maximized-panel picker and do not persist narrow geometry. These are conservative fit calculations, not measurements of the user's monitor.

## Global constraints

- Preserve each scene's custom Dockview layout and existing migration snapshots.
- Keep keyboard navigation, narrow single-panel behavior, Dockview tabs/drag/resize/maximize/restore, and per-scene persistence.
- Keep native chat in the host conversation factory; do not guess plugin IDs or create substitute chat controls.
- Keep all current intake selectors and business behavior; task switches must not issue reads or writes.
- No dependencies, business/API/ERP changes, main DB migration, app activation, build/install, real-data import, commit, or push.
- Do not copy author-specific content or use their scripts; cite the upstream repo and pinned commit above.

## Owned files

- Shell recommendation contract: `packages/tradeloom-shell/scenes.json`, `scene-layout.js`, `dock-layout.js`, `client.scenes.js`, `client.js`; tests `tests/dock-layout.test.js`, `tests/scenes.test.js`.
- Workbench: `workbench/templates/workbench/artifacts.html`, `workbench/static/workbench/intake.js`, `workbench/static/workbench/styles.css`; touch `base.html` only for an evidenced embedded-container sizing hook.
- Tests: `packages/tradeloom-shell/tests/intake-ui.test.js`, `workbench/tests/test_pages.py`.

## Tasks

### 1. Freeze baseline and test Dockview defaults

- [x] Verify the independent Phase B file copies and SHA manifest under `workspace/testing/workbench-ui-roomy-20261022/phase-b-baseline`.
- [x] Map scene profiles to the screenshots and assert fresh defaults and explicit recommendation reset agree while custom saved layouts preserve their panels and proportions.
- [x] Run focused dock-layout and scene tests; initial run with the external DOM variable absent failed only because `jsdom` was not resolvable.

### 2. Make the shell less crowded

- [x] Define the scene-aware recommendation profile and serialize it identically for new defaults and explicit reset in `client.scenes.js`.
- [x] Derive the single-panel fallback from actual Dockview canvas width and height; retain desktop geometry without saving narrow-mode changes.
- [x] Keep compact scene icons in row two, with active title and hover/focus title reveal. Group existing utility actions in a theme-aware top-row menu with verified host APIs.
- [x] Run focused dock-layout and scene tests; assert persisted custom layouts remain unchanged.

### 3. Split intake into in-place tasks

- [x] Add RED tests for first-task visibility and workflow-driven navigation; add behavior tests for keyboard switching and retained DOM state.
- [x] Wrap the existing source/upload/preview, mapping/candidate, links, narrative, requirement, and execution-plan sections in six stable task regions; keep their children in place.
- [x] Add an in-place task controller that toggles `hidden`, `aria-selected`, and `tabindex`. Update candidate-to-requirement and requirement-to-plan transitions.
- [x] Keep annotation compact by default, translate source/audio states, preserve drafts on history paging, and retain metadata on read failures.

### 4. Consolidate responsive rules and verify

- [x] Add scoped, container-width responsive rules; keep text forms in one column at narrow container widths and allow horizontal scrolling only for grids/tables.
- [x] Use theme variables, readable body text, visible focus, and retain the compact annotation entry.
- [x] Run the full Node suite with the pinned Node 24.21 runtime and verified external DSH/DOM libraries: 183 passed, 0 skipped. Django page rendering and schema checks remain a pre-activation gate; no DB was accessed in this Phase C run.
- [x] Save unique logs and SHA-256s; jsdom tests do not certify desktop visual appearance.

## 2026-10-23 integrated panel-workbench revision

This revision supersedes the earlier palette and top-level action arrangement while retaining scene IDs, saved Dockview JSON, per-scene recommendations, chat/session ownership, and existing business routes. **User correction (2026-10-23): forced sidebar suppression was withdrawn.** Both workbench and standalone conversation use the Host's existing sidebar visibility, history and navigation; switching modes does not call `toggleSidebar()` or alter the saved width. The tools menu keeps the existing `layout.toggleSidebar()` action available in both modes.

- Adopt the reference's two compact rows: truthful TradeLoom identity and compact provider/model selectors above; scene icons with active/hover/focus labels and an explicit `对话` action below. Theme and tools stay at the row's right edge. Keep provider names in title/accessible labels and allow chip shrink/ellipsis.
- Adopt the reference's panel-first hierarchy: Dockview group shells with 10px gutters, rounded edges, 36px headers, and group-local refresh/maximize controls. Keep one scene-wide `布局` menu beside scene navigation for recommendation reset, closed-panel restore, and save recovery; it remains available after every panel is closed. Use the Dockview popover/top-layer mechanism because its group shells clip overflow. Group actions stop event bubbling so using an inactive group's controls does not move focus. Retain Dockview drag, tabs, resize, maximize/restore, and persisted user layouts.
- Use the DSH `ctx.theme.overrideTokens()` aliases for the shell palette. The same eight-value semantic palette crosses the existing strict same-origin business iframe bridge; the child accepts only the exact message keys and validated six-digit colors. The dark design values are canvas `#0c1017`, panel `#131925`, header `#171f2c`, border `#293345`, text `#dfe7f3`, muted `#8b97ab`, blue `#4d83dd`, and teal `#37b5a9`; light mode uses a cool near-white counterpart.
- Fix only the empty embedded native-chat state by letting its sole active composer seat fill the remaining scroll-body height. Do not change the standalone conversation layout or native chat/history behavior.
- Keep the prior profile proportions and all saved custom layouts. Do not copy screenshot author branding, health dots, SSH/terminal controls, snapshot/notification semantics, floating overlays, numbered meanings, or media-canvas features. Static screenshots do not establish hover timing, iframe behavior, or action contracts; those require source/API evidence or live UI checks.
- Frame interpretation for this revision: #02/#03/#05/#07/#11/#14 are workbench-mode references without a resident native history sidebar; #10 is the standalone native conversation with its history. The two modes keep the same top shell, and the explicit conversation entry opens the existing bound session. The earlier `#3/#4/#11` four-panel profile mapping above remains an older plan hypothesis and does not override the current scene JSON or saved per-scene geometry.
- The local reference checkout is pinned at `5e961be6b83ff742adbd4d226455f2ccd24efbc0`; Root verified that GitHub `main` README had 33 commits during this task, but no current remote commit SHA was fetched, so the local checkout remains the only reproducible source revision here.
- The temporary Host `ui-layout` sidebar-suppression patch was reversed after the user's correction; it is not part of the active implementation. Sidebar visibility and native history remain available during workbench use.
- Sidebar suppression has unit, store, and AppFrame regression coverage for custom width, initially closed state, narrow expansion override, overlapping claims, idempotent disposal, and unchanged manual toggle semantics. The shell and iframe changes have targeted protocol and group-action tests. Desktop appearance, live native-history restoration, Dockview drag persistence, and dark/light cross-scene behavior remain live acceptance points; test coverage alone does not certify those.
- Latest shell validation: `npm test --prefix packages/tradeloom-shell` with the pinned runtime 8 jsdom paths reports 213 pass, 15 skips, 0 fail. The skips are: seven tests requiring the pinned compiled DSH runtime; one requiring pinned React plus external JSDOM; one requiring the pinned DSH WebServer library; two requiring the pinned DSH tools library; one requiring candidate-7 React libraries; two requiring the pinned Cordis library/Loader; and one requiring pinned source plus app-boot/include libraries for profile composition. Latest runtime sidebar validation: the AppFrame, layout-store, and service Vitest files report 88 pass, 0 fail. New DOM behavior coverage verifies layout recovery after all panels are closed, per-group refresh/maximize without activating an inactive group, no empty wide-screen toolbar row, the narrow selector row, compact provider initials with full accessible names, and correct standalone/workbench selection states. Cross-group drag remains unverified; the tests do not simulate a Dockview drag gesture.

## 2026-10-23 合并参考资料与用户优先级

- 统一入口：[工作台 UI 参考资料库](../../../../workspace/research/video-ui-reference-20261023/README.md)；决策索引：[reference-index.md](../../../../workspace/research/video-ui-reference-20261023/reference-index.md)。主参考是 ZIP 中 135 张按视频帧标注的实机截图；旧会话恢复的 14 帧作为补充，06/08/09 exact-hash 重复仍保留；31 张示意和 135 张缩略图单独分层，不重复计为实机观察。
- 用户最新要求“保留原版侧边栏/功能，仅改 UI”是硬优先级；不会按随附 AI 分析报告删侧栏、隐藏原生功能或引入未经授权的业务功能。报告作为二次资料，不当作完整人工核验视频。
- 对照视觉设计时优先保留原生功能、业务数据/会话与现有 Dockview 状态，再调整外壳层级和信息密度；新参考不可覆盖已记录的实机通过/失败。当前 max/restore source 修复仍待同步和真实 UI 验收。

### 本轮完整逐帧观察采纳表（2026-10-23）

两份逐帧记录已归档于统一参考库：[V01–V03（59 帧）](../../../../workspace/research/video-ui-reference-20261023/observations/2026-10-23-v01-v03.md) 和 [V04–V07（76 帧）](../../../../workspace/research/video-ui-reference-20261023/observations/2026-10-23-v04-v07.md)。它们记录审图者直接查看截图所得的可见事实，不表示完整观看七段视频；截图常有裁切，画外控件只能记为未知。135 张 JPG 缩略图不是额外观察，31 张非实机示意仍仅是建议层；旧 14 帧仍为补充，S134 属于 V02。

| 参考观察 | 本项目采纳 | 不采纳 / 未能证明 |
|---|---|---|
| 顶层工作区/助手入口与独立会话标题；场景切换、面板分组和各自标题栏操作 | 保留原生 DSH 侧栏的历史、新会话、插件、自动化、工作区等完整功能；顶层助手/场景选择继续使用真实入口；工作区布局优先依赖现有 Dockview 分组、拖放、分隔线和每组操作 | 不按静态帧删除或常驻隐藏侧栏，不把用户界面缩成仅历史条；不伪造绑定、健康状态或服务动作 |
| 多面板、独立滚动、可调分栏、聊天输入与状态控件 | 复用现有业务面板、原生会话和 composer，保留草稿、模型/权限/发送等既有控制合同；空态只调整嵌入容器布局，独立聊天不改 | 不创建第二个会话、后端或消息，不凭截图推断真实媒体、节点或助手能力 |
| SSH/终端、Blender、ComfyUI、视频画布、股票/资源监控、浮窗和编号标记 | 只在 TradeLoom 已有对应能力时映射外观参考，并由现有实现/合同决定 | 截图或随附 AI 报告没有授权新增 SSH、视频、股票、Agent 群聊、远程执行、虚构数据/API/工具；不复制第三方交互语义 |
| 菜单、状态、悬浮/展开、图中标记及被裁切区域 | 保留已验证的键盘/菜单合同，待真实 UI 检查 | 静态截图不能证明因果、动画、拖拽步骤、浮层行为、画外按钮是否存在；未实测项仍标待验 |

本轮实际 source-mode 集成候选为 `a1393039d07b19870f51188536c53f003f01d86402d4279975019abc0c97977a`：已按官方流程同步至 desktop-8 并从指定快捷方式启动。shell suite 229 项（214 pass、15 skip、0 fail）已在本轮 source 测试通过；真实窗口现由 Root 单独验收。原生侧栏完整保留，截图资料不授权新增 SSH/视频/股票或其它后端能力。参考观察报告的逐帧哈希及文件路径见统一参考库 README。

### 2026-10-23 助手能力面板窄屏修正（未激活）

能力与配置仍由现有 Agent Directory 提供；本次只将其既有面板改为基于锚点与 `visualViewport` 边界的非模态 portal，增加 Escape/焦点返回、固定标题与独立滚动区。Portal 根沿用 `.tl-shell-top` 语义色变量和相同控件规则；角色配置与草稿合同未变。runtime8 真实 React/JSDOM 几何及交互测试通过，但这不等于实际窗口/手机验收。本次源候选未同步或激活，见 `docs/acceptance-matrix.md` 的对应验收段。
