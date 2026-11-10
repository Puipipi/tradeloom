# Host 内账户菜单 peek 状态机候选

这是隔离的后台候选，不修改现有认证 DTO，也没有连接 Main、Host、preload 或实际窗口。它把已由固定探针证明的账户菜单触发按钮，作为同一文档代际内的一次性 Host 私有能力；触发器本身绝不证明登录。

## Host 接线合同

Host 用 `createAccountMenuPeekController` 创建单个 provider 控制器。所有回调都必须是 Host 固定闭包；renderer 不得传 selector、脚本、DOM 节点、坐标、provider 覆盖值或点击命令。

1. 现有固定菜单探针先确认 provider-specific 正菜单，R2 捕获确认 `isTrusted` pointerdown，且 `ariaControlsElements` 与同一菜单根精确对象关联。然后仅调用 `bindFromConfirmedMenu()`。注入的 `captureConfirmedTrigger` 必须返回 `trustedPointerDown`、`strictMenuPositive`、`exactLinkedButton` 三项真值和同一 owner/origin/document/generation 的 opaque capability。它不应把 DOM 节点序列化到主进程或 renderer。
2. `readContext` 返回当前 owner 对象身份、固定 origin、documentId、generation、alive 和 focus；controller 每次异步回调后复核。导航、owner替换、失焦、generation变化或 `invalidate()` 都使结果变为 `unknown`。固定 provider negative 调用 `observeNegative()`：清除缓存绑定；若 peek 已经发起，仍允许它仅在同一文档/owner内清理本次菜单。
3. `readBoundMenu(capability, expectedMenuIdentity)` 只读取固定 provider 的严格菜单/已知 negative 投影，并返回 opaque 的精确 menu identity，不返回 DOM node。菜单本来已开时，peek 只读并返回 `already-open`，不关闭用户菜单。
4. 闭合菜单时，controller 先调用固定 `openBoundMenu`。该 Host 闭包必须在发送 native input 前重新核 owner/document/generation、固定按钮引用和菜单状态；实际发送后立即调用 `markDispatched()`。回调即使之后抛错，controller 仍会检查同一文档中是否出现与该按钮精确关联的菜单，以便安全恢复。
5. 只有本次 action 已派发、菜单从闭合变为打开、且固定读取器确认了同一 exact menu identity 时，finally 才调用 `closeBoundMenu`。close 闭包也必须在操作前复核身份和菜单引用。之后只验证该同一 identity 已闭合；不确定时返回 `restore-failed` 或 `unknown`，不会再试一次，也不会触碰新 document 或另一个 menu。

类型定义在 `after/account-menu-peek.d.ts`。回执独立于原认证 DTO：`authState` 仅为 `authenticated|unknown`，`evidence` 仅在严格正菜单观察时是 `account-menu`；`menuRestore` 单独表示 `restored|not-needed|failed|unknown`。已观察正菜单但关闭失败时，返回已观察的 `authenticated` 同时标明 `restore-failed`；若最终 owner/document/generation/focus 已变化，旧正结果会被覆盖为 `unknown`。任何 negative 都优先令结果为 `unknown`。

## 已知边界

- 绑定是短生命周期、同文档的 opaque capability。冷启动或刷新后没有绑定时为 `unknown`，必须等下一次由用户触发并通过原有严格菜单检查的可信操作；不使用 utility class 重建按钮。
- controller 不证明可信 pointer、正菜单语义或真实 DOM identity；这些事实只由上游固定 Host 闭包负责。回调也必须保证 menu identity 是隔离 world 内的 opaque reference，不可序列化 DOM。
- `openBoundMenu`/`closeBoundMenu` 必须是专用、固定的 Host 动作，不是通用 DOM-click RPC。若无法证明该菜单由本次 peek 打开，恢复结果为 `unknown`，不关菜单。
- 单测使用合成 Host closures，覆盖 open、严格读取、negative、restore、导航、失焦、并发和回调异常；它不代表真实站点、Electron input event、冷启动、用户 profile 或桌面验收。
- 没有读取任何凭据/业务内容，也没有操作 GUI、实际 Host、Main、SDK 或安装包。

## 固定账户入口诊断候选

`after/fixed-account-entry-probe.js` 是独立的 Host 私有诊断探针。它不修改上面的认证 DTO，也不把菜单/头像/按钮候选视为已登录。它只返回 provider、阶段、有限候选计数和对象关联布尔值；不会返回 DOM 引用、文本、ID、属性值、类名、URL 或账户信息。

- DeepSeek 使用已观察到的两条固定类链：`._9d8da05 → ._2afd28d → .dc1f7bee._4bcc731 → ._7b40dad.f14f3a6d`，以及 `.fdf01f38 → .ede5bc47 → ._2afd28d → .dc1f7bee._4bcc731`。探针只要求 strict-positive 菜单符合这两个已知菜单类，不额外要求 `role="menu"`。它按共享 `._2afd28d` 实际元素身份去重；只有唯一候选与可信捕获路径相同才返回匹配。候选类只用于诊断定位，站点变化时应返回 unknown。
- Doubao 只在固定 `nav,[role="navigation"]` 范围检查可见 button 候选及 `ariaControlsElements` 对本次已确认菜单的对象引用关系。计数是范围内全部符合固定属性条件的按钮候选；唯一按钮还必须与当前菜单精确关联并位于可信捕获路径中。反射不可用、多导航区、越界或歧义不会选一个猜测。
- 安装与调用应在同一个 Main-owned isolated world/document 中完成。Host 先检查固定 provider origin、当前 owned/focused WebContents 和 document generation，再执行 `fixedAccountEntryProbeInstallScript(provider)`。在既有固定严格菜单 positive 分支、且局部变量 `menu` 仍在同次脚本调用栈时，按下方方式调用 R2 closure hook。之后可独立调用 `fixedAccountEntryProbeClosedScript(provider)`。每个异步边界由 Host 重验 owner、origin、document 和 generation；导航/失焦/关闭时调用 dispose。DOM refs 从不跨 isolated-world 序列化。

R2 本身需要应用 `after/fixed-account-entry-r2-hook.patch`：它只在 R2 capture closure 内增加 `projectFixedAccountEntry(menuElement)`，从私有 `candidate.path` 传入最多四个同 document 元素。该 patch 必须与固定探针安装在同一个 isolated world。strict-positive 分支按此顺序运行：

```js
// Main 在构建原有固定菜单脚本时内联这两个表达式；它们依赖同一个 IIFE 中的局部 `menu`。
const script = `(() => {
  const menu = findMenuUsingExistingFixedProbe();
  const existingMenuEvidence = runExistingStrictMenuChecks(menu);
  if (!existingMenuEvidence.positive) return { existingMenuEvidence };
  const entryDiagnostic = ${fixedAccountEntryProbeR2ConfirmExpression(provider)};
  const triggerProjection = ${accountMenuTriggerCaptureConfirmedMenuExpression(provider)};
  return { existingMenuEvidence, entryDiagnostic, triggerProjection };
})()`
const result = await executeJavaScriptInIsolatedWorld(script, isolatedWorldId) // 一次执行
publishDevelopmentDiagnostic({ entryDiagnostic: result.entryDiagnostic, triggerProjection: result.triggerProjection })
```

这是 DOM-side 接线伪代码，不是本候选已连接的运行代码。两次固定表达式必须在 strict-positive 检查之后、同一个 IIFE/isolated-world 执行中求值；不要分别 `executeJavaScript`，因为局部 DOM `menu` 不会跨调用传递。R2 trigger projection 会消费并 dispose pointer capture，所以 fixed entry expression 必须先执行。`entryDiagnostic` 不可送入生产 auth publisher；现有 strict sampler 仍是认证判断唯一来源。此入口要求现有 R2 捕获到真实可信 pointer path，不能伪造 trusted pointer 或把它描述成冷启动证据。探针本身不 click、不聚焦、不展开菜单。需要由 Host 在单次执行前后维护并复核固定 `documentId/generation/focus/origin` 门禁；DOM script 的文档对象检查不能替代 Host generation 复核。

输出只含：DeepSeek `provider/phase/reason/menuState/visibleCandidateCount/capturedPathMatchesCandidate`；Doubao open/closed 都返回 `visiblePopupMenuButtonCountInNavigation/capturedButtonIsUniquePopupCandidate`。该计数只看 navigation 内所有可见 `button[aria-haspopup="menu"]` 候选，不依赖 `aria-controls`；closed 仍保留原 `closedHasAriaControls` 布尔和 controls 专用 `closedUniqueCandidate` 语义。popup 唯一性只描述当前固定捕获的同一私有按钮是否是唯一候选，缺引用、多 navigation 区或超界时为 unknown。候选计数是 `0|1|'2_plus'|'unknown'`。这些补充字段仅用于入口定位，不能直接作为认证或冷启动成功证据，也不改变 production authState/focus 判断。

10 项 VM/DOM fixture 只证明固定链查找、同 realm 引用传递、歧义/越界 fail-closed 和安全 DTO。它们不是实际站点 DOM 回归、Host 挂载、冷启动入口或 GUI 验收。真实 DeepSeek/Doubao 入口样本目前只用于筛选这些候选链；本站结构变更应保留 unknown，不能用类名直接认定账户或认证。
