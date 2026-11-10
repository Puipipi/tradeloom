# WebAI 登录态只读候选

本目录是未挂载的 backend-side 候选，不是冻结 R1 的运行实现。本候选只从 Host 内部注入的 document identity 与只读固定信号生成小型 DTO；不要把 factory 或回调暴露给 renderer。

## 当前接口

```js
const authState = createWebAiAuthStateAdapter({
  provider: 'doubao', // 仅 deepseek | doubao
  readDocumentIdentity: () => ({ url: ownedWebContents.getURL(), documentId: hostDocumentToken, alive: !ownedWebContents.isDestroyed() }),
  // 仅由 Host 持有的隔离世界执行器；adapter 只传它自己的固定脚本。
  executeReadOnlyProbe: script => ownedWebContents.executeJavaScriptInIsolatedWorld(0x544c, [{ code: script }]),
  subscribeLifecycle: listener => subscribeOwnedWebContents(listener),
})
const dto = await authState.sample()
// { provider, authState: 'unknown' | 'unauthenticated' | 'authenticated', evidence, generation }
const menuEvidence = await authState.sampleAccountMenu()
// provider-specific finite booleans; does not change authState
```

`authenticated` 是 `.d.ts` 三态 DTO 的预留值，当前实现没有任何产生它的路径。Doubao probe 脚本在模块内固定为 `[data-testid="to_login_button"]`，只返回该元素存在且可见的布尔值；不读页面文字或元素属性。DeepSeek 仅把固定 origin 下精确 `/sign_in` 路径识别为已知未认证。信号缺失、查询失败、其他路径、页面 ready、cookie/session 存在、登录按钮缺席均为 `unknown`。采样前后会比较文档身份并检查本地 generation；导航（包括 in-page/SPA 导航）、文档替换、renderer 退出和关闭会作废旧结果。DTO 不包含 URL、账号、DOM、HTML、cookie、token 或原始错误。

`sampleAccountMenu()` 是独立采样，不改变 `authState`。Doubao 脚本只检查可见 `[role="menu"]`/`[role="menuitem"]`，精确比较“添加账号”“退出登录”；DeepSeek 脚本只在可见 `[role="menu"]` 容器内，对后代精确比较“下载手机应用”“系统设置”“帮助与反馈”“退出登录”，不要求 `menuitem` role。结果只含 allowlist 可见布尔与 `sameMenu`/`sameContainer`；跨容器不会满足同容器条件，不返回标签或其他菜单项文本。未命中可见候选容器时 `status=unknown` 且布尔为 false，这不证明站点没有菜单。

两个 probe 都只在已命中的可见 menu 上尝试以内部 menu id 和固定 `button[aria-controls]` 建立 trigger 关系，投影 `triggerPresent`、`triggerVisible`、`hasPopup`、`linked`、`shortcutAttributePresent` 布尔，不返回 menu id 或快捷键值。Doubao 菜单旁可见的 `Ctrl+Shift+,` 提示不证明 DOM 存在或使用 `aria-keyshortcuts`；最后一项只表示候选属性存在，不代表快捷键有效。

## 临时 DeepSeek root 定位诊断

`sampleDeepSeekMenuDevelopment()` 是独立的 Host-only 开发诊断，不进入普通 auth/menu DTO。它只在固定候选结构根 `nav`、`header`、已知导航/菜单/dialog role、显式展开/弹出 trigger，以及 class 子串候选 `dropdown`/`popover`/`popper`/`menu`、固定 `[data-state="open"]`、`[data-side]`、`[data-popper-placement]` 上做有界遍历；data 属性只用于固定匹配，不读取或返回其值。它只检查元素**直接文本节点**与四个固定 allowlist 标签精确相等，不读取 `body.textContent`、聊天历史或大祖先文本。遍历有 root、节点及直接子节点上限；达到上限返回 unknown，不导出部分文本。

四标签只有在同一个非宽根候选中共现才标记 `sameRestrictedContainer`。排除 `html/body/main/article`、`main/log/feed/article` role，以及带聊天、消息、会话、历史、transcript 等固定前缀 class 的子树。仅在完整同容器命中时附带最多三层祖先 metadata：安全格式的静态 tag、有限已知 role 和每层最多八个、长度不超48的 CSS class token；不读出或返回 id/data 属性、文本、账号、HTML。它只是供当前手动打开的菜单定位 root 的临时证据，不代表账户归属或登录成功，也不自动打开/关闭菜单。

找到并实测真实 DeepSeek root selector 后，前端应把它收窄为固定业务采样器，并删除此开发 metadata 接口；当前候选 root 列表不是已验证的站点 DOM 合同。主 `authState` 依旧没有 authenticated 产生路径。

不要用现有通用页面诊断结果直接当本 DTO：它会返回候选控件和页面诊断字段，适合显式诊断导出，不符合认证状态最小投影。

## 当前宿主入口与接线缺口

R1 SDK 源里现有 `browser-guests.ts` 的 host-owned `diagnostics(owner, request)` 通过实际 BrowserWindow/WebContents 调用固定诊断脚本；窗口状态与导航/关闭生命周期也在 BrowserGuests 内。它可作为 WebContents ownership 与生命周期的接线参考，但其诊断结果过宽，不能直接当认证 DTO。主进程 `aiWeb.status/subscribe` 可读窗口状态，不能证明站点已登录。source runtime 的 `source-preload.cjs` 没有 `aiWeb.status/subscribe` 或登录态采样入口。

R1 owner 在自有 Doubao 窗口中通过可访问性树看到账户菜单项“添加账号”“退出登录”；在自有 DeepSeek 登录窗中看到同一账户菜单文本“下载手机应用”“系统设置”“帮助与反馈”“退出登录”。没有读取昵称、DOM 或其它页面内容，也没有执行退出/设置/发送/上传动作。这些 AX 观察仅提供有限语义标签来源，不证明 DOM role/selector 命中。当前候选用 `[role="menu"]` 作待核容器；Doubao 另外候选 `[role="menuitem"]`，DeepSeek 检查容器内精确文本。若实际结构不匹配返回 false/unknown。trigger 关系也只有真实 menu id 与 `button[aria-controls]` 对得上时才会返回布尔。DeepSeek 正向登录态证据仍缺失。

用户手动登录后的最窄采样应由 C/Host owner 在已拥有的 WebContents 上调用固定 probe，只返回有限布尔；不能自动开窗、聚焦、点击、导出文字或让 renderer 自报 positive。现有主 preload 有 `aiWeb.status/subscribe`，source preload 没有这些入口，也没有 auth sample API。当前没有经真实 DOM 验证的账户/退出控件 selector，因此菜单布尔不是 authenticated positive，本候选仍不产生 authenticated，也未连接到 R1 UI。不能依赖用户长期保持账户菜单打开；启用正向判断前，需验证 trigger selector、登录/未登录对照与真实DOM，再由 C/Host owner提供受 sender 校验的采样入口。导航、`did-navigate-in-page`、render-process-gone、窗口关闭都要立即失效状态。本候选不改 source-preload。

## 验证边界

`recovery-20261029/webai-auth-state-20261101/testing/webai-auth-state.test.js` 使用合成 identity/生命周期及 Node VM DOM stub 执行固定 probe，证明有限投影、文本不外泄、同容器关系、遍历上限与迟到结果失效。它不是实际 WebContents、真实 DOM selector、登录态或 R1 UI 验收。候选不包含 Host、IPC、preload、正向登录证据或产品挂载代码。
