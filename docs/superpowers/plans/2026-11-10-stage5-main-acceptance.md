# TradeLoom Stage 5 Main Acceptance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development (recommended) or executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在不混入功能添加分支、不覆盖现有隔离数据的前提下，完成 current-main 960bb 的阶段5适用回归、生产候选后台/GUI 验收，修复可复现阻塞问题后再提供桌面测试入口。

**Architecture:** 源码与运行包分层验收。先在 `D:/TL-S5-A20261110` 建立全新的测试输出与固定 UI 依赖，使用 current-main 的源码和已保存的 pinned SDK；再对当前 P 做后台与 GUI 验收。任何源码修复都走独立提交和重新 re-pin 的候选包，绝不直接 overlay P 或 R73。

**Tech Stack:** Node.js 24 `node:test`、PowerShell、React 18.3.1、JSDOM 30.1.3、编译后的 DSH pinned runtime、Electron、Windows Computer Use。

**Spec:** `C:/Users/23825/Desktop/ICT/项目交接-阶段5-20261110.md`、`C:/Users/23825/Desktop/ICT/项目交接-证据索引-20261110.json`、`D:/Codex-ICT-private-backups/ui18-final-20261105-01a16e3f/stage5-source-feature-additions-20261107/STAGE5-REMAINING-DISPOSITION-CURRENT.md`。

## Global Constraints

- current-main：`960bb8e137dfe4528664d75f7f57ed4662fe0a50` / tree `b7410a4edcb19dd3becf3c93ac9307ee8647450e`；功能添加分支 `codex/feature-additions` 只读，禁止 reset/clean/copy/merge。
- 不读取、复制、删除或回灌 P 的 profile、聊天、附件、数据库、登录状态和凭据；不读取 `测试用api.txt`。
- 不启动或替换 R73，不修改防火墙规则，不提前进入阶段6/7，不新增未经合同确认的 catalog/list、语音、MCP、usage 原型。
- 所有测试输出写入新建隔离根；不得把缺少必填环境、装载失败或条件 skip 统计为通过。
- 桌面快捷方式只能在适用后台验收无阻塞、关键 GUI 冒烟通过后创建。
- 若修改产品源码，必须 TDD、提交新 HEAD/tree、复制并 re-pin 当前 recipe、构建全新候选并安全提取；不得直接修改 P。

## Review Focus

- 旧 Host epoch、旧 role binding、错误 scene/panel/session、重放 grant：必须 fail closed；由任务2的 production-origin 负例覆盖。
- collector 在请求 abort、端口/service 改变、dispose 时尚未完成：必须取消并等待，不能遗留子进程；由任务2的 listener 测试和独立 Cordis 合同复核覆盖。
- Dock 关闭后刷新/恢复、保存失败、重复恢复：不得丢布局或重复 panel；由任务3的真实 Dockview 集成与 GUI 冒烟覆盖。
- 启动器 wrapper 返回但 app 尚未 ready、主窗关闭但服务尚未退出：必须按实际 PID/端口和 ready 状态判断；由任务4覆盖。
- 测试根、runtime 根或 profile 指向非隔离目录：必须拒绝执行；由任务1的路径断言与任务5的进程/路径复核覆盖。

---

### Task 1: 固定隔离验收环境与当前基线

**Files:**
- Create: `D:/TL-S5-A20261110/run-stage5-tests.ps1`（测试执行器，不属于产品源码）
- Create: `D:/TL-S5-A20261110/evidence/environment.json`
- Create: `D:/TL-S5-A20261110/evidence/*.log`

**Interfaces:**
- Consumes: current-main checkout、pinned SDK `sdk-typecheck`、已保存 O04/N01 SDK execution roots。
- Produces: 可重复执行的环境变量映射、逐命令原始 stdout/stderr、exit code 和测试计数。

- [ ] **Step 1: 固定路径和版本**
  断言源码 HEAD/tree/clean、功能分支只读身份、P/shortcut 目标路径、测试根不指向任何现有 profile；记录 Node/npm/Python 与依赖版本。

- [ ] **Step 2: 安装并读回固定 UI 依赖**
  在 `D:/TL-S5-A20261110/ui-deps` 安装 `react@18.3.1`、`react-dom@18.3.1`、`jsdom@30.1.3`，设置 `TRADELOOM_REACT_LIBRARY`、`TRADELOOM_REACT_SERVER_LIBRARY`、`TRADELOOM_DOM_MODULE`、`TRADELOOM_DOM_TEST_ROOT`。

- [ ] **Step 3: 运行无外部 runtime 的 focused 基线**
  运行 `listener-identity-integration.test.js`、`scene-rotation.test.js`、`dock-layout.test.js`、`dockview-package.test.js`、`agent-configuration.test.js`、`agent-configuration-snapshots.test.js`。期望 exit 0、fail 0；任何失败先定位，不改断言求绿。

- [ ] **Step 4: 运行完整 Shell 与 production-origin 基线**
  设置 `TRADELOOM_AGENT_CONFIGURATION_TEST_ROOT`、`TRADELOOM_DSH_PINNED_SOURCE`、`N01_PRIVATE_TEST_ROOT`、`O04_PRIVATE_TEST_ROOT` 和已有 pinned SDK 路径，执行 `node --test packages/tradeloom-shell/tests/*.test.js` 与两个 `production-origin-*.test.mjs`。保留首轮裸 `npm test` 的缺环境失败，不覆盖历史。

### Task 2: Host、owner-fence 与生命周期阻塞修复

**Files:**
- Test: `apps/tradeloom-launcher/tests/production-origin-chain.test.mjs`
- Test: `packages/tradeloom-shell/tests/listener-identity-integration.test.js`
- Modify only on reproduced defect: 对应的 `packages/tradeloom-shell/host.js`、`execution-origin-authority.js`、`scene-memory-store.js`、`listener-identity.js` 或 accepted-runtime caller。

**Interfaces:**
- Consumes: `createExecutionOriginAuthority()`、`sceneMemoryOriginAuthority`、`registerListenerIdentityRoute()`。
- Produces: 当前 main 的 Host/owner-fence 通过证据；若有修复，给出最小新接口与负例。

- [ ] **Step 1: 跑完整 owner-fence 正负例**
  覆盖 grant 重放、body/method/rpc/peer 不匹配、跨 role/scene/panel/session、stale binding、terminal/revoked、Host restart 旧 epoch、异步 commit 前后撤销。期望无 skip、fail 0。

- [ ] **Step 2: 跑 listener 与真实 Cordis 合同**
  运行 listener 15 例；使用当前 P 的 Electron 执行已保存 Cordis 合同脚本，确认 async disposer 和 root dispose 都等待。该结果只标框架级，不冒充生产 Host。

- [ ] **Step 3: 对每个真实失败执行 TDD**
  先保留稳定 RED 和根因，再改一个最小产品点；测试不得删除安全断言。若只是缺 fixture，则修测试环境，不改产品。

- [ ] **Step 4: 重跑任务1完整 Shell/origin 回归**
  期望 fail 0；未执行的 SDK 条件用例必须明确列出，不得写成全绿。

### Task 3: Dock 关闭、持久化与恢复闭环

**Files:**
- Test: `packages/tradeloom-shell/tests/dockview-integration.test.js`
- Test: `packages/tradeloom-shell/tests/dock-layout.test.js`
- Modify only on reproduced defect: `packages/tradeloom-shell/client.scenes.js` 或 `dock-layout.js`。

**Interfaces:**
- Consumes: `reopenScenePanel(sceneId, panelId)`、`queueDockLayoutSave()`、`closedPanelIds`。
- Produces: 真实 Dockview 下 close→HTTP PUT→reload/fromJSON→layout menu restore→HTTP PUT 的回归证据。

- [ ] **Step 1: 扩展真实 Dockview 集成断言**
  在现有关闭 `auxiliary` 的服务器恢复之后，通过生产布局菜单恢复该 panel，断言仅一个实例、closedPanelIds 清空、布局校验通过且后续 PUT 成功。

- [ ] **Step 2: 运行 DOM/Dockview 套件**
  运行 `dock-layout`、`dockview-integration`、`dockview-pointer-dnd`、`scenes`，要求真实 React/JSDOM 用例未 skip、fail 0。

- [ ] **Step 3: 仅在可复现缺陷时修产品**
  若有 RED，最小修复后重复完整 DOM/Dockview 套件；不改变用户已删除的“会话用量”和场景计数入口。

### Task 4: 当前 P 的后台与关键 GUI 验收

**Files:**
- Create: `D:/TL-S5-A20261110/evidence/package-background.json`
- Create: `D:/TL-S5-A20261110/evidence/gui-observation.json`
- Create only after all gates pass: `C:/Users/23825/Desktop/织贸助手-阶段5隔离测试.lnk`

**Interfaces:**
- Consumes: `P/启动工作台.exe`、动态 Host 地址、端口 3088/3090/55432。
- Produces: 启动/健康/listener/正常退出证据，以及 Dock GUI 观察。

- [ ] **Step 1: 启动前所有权检查**
  确认 P 路径进程和三个端口无现存 owner；若已有实例，不启动第二实例、不 kill，先识别并沿用正常退出链。

- [ ] **Step 2: 后台启动与只读 HTTP 验收**
  通过 wrapper 启动 P；从实际启动证据确定绑定地址，检查 Host/Django/PostgreSQL ready、受保护路由鉴权、listener identity 的进程路径归属。不得修改防火墙，不输出凭据或业务数据。

- [ ] **Step 3: 关键 GUI 冒烟**
  在现有 P 窗口验证场景切换、关闭面板、布局菜单恢复、重开后布局/既有模型会话可取回；不读取聊天正文，不发送新模型请求，不登出。

- [ ] **Step 4: 正常退出与排净**
  正常关闭主窗，按 P 精确路径/PID 与三个端口确认 app、Django、PostgreSQL 退出；wrapper 返回不算退出证据，禁止 kill。

### Task 5: 全量适用回归、独立复核与交付

**Files:**
- Create: `D:/TL-S5-A20261110/evidence/final-summary.json`
- Modify: `C:/Users/23825/Desktop/ICT/项目交接-阶段5-20261110.md`
- Modify: `C:/Users/23825/Desktop/ICT/项目交接-证据索引-20261110.json`

**Interfaces:**
- Consumes: 任务1–4原始日志、diff、进程/端口状态。
- Produces: 最终验收边界、桌面测试入口和更新后的交接。

- [ ] **Step 1:  fresh 全量适用回归**
  重跑 Shell、production-origin、当前 launcher 适用测试；历史 4999/R76/R9 专用测试或缺少冻结外部 fixture 的用例单列，不计入当前通过数，也不冒称整个旧 launcher suite 全绿。

- [ ] **Step 2: 独立 defect-first review**
  审查所有 diff 和验收证据；Critical/Important 必须修复并重跑，Unknowns 不写成已通过。

- [ ] **Step 3: 创建快捷方式**
  仅当后台阻塞为0且关键 GUI 冒烟通过，创建 Target=`D:/TL-S5-M960R1/TradeLoom-main960bb-20261110-r1/启动工作台.exe`、Start in=P 根、Arguments 为空的 `.lnk`，读回属性验证。

- [ ] **Step 4: 更新交接**
  分别记录 main 与 `codex/feature-additions`，写明实际通过数、skip/未验项、快捷方式路径、候选源码/tree、进程收尾。只有真实满足阶段验收标准时才标 Stage 5 complete，否则保留未完成项。
