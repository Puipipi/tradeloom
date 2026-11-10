# WebAI 双站正证候选 R2

这是独立候选，不是已部署的 Main、前端或 WebContents 运行时代码。基线来自冻结的 `webai-auth-positive-20261101`，原文件 SHA-256 为 `A4B048A3D1DA68CCF09422458EDE69B1406C24E70BDD9321F8C53E30AB3F279A`。前一候选及其证据未修改。

## 认证状态规则

- DeepSeek 保留 A4B 规则：固定站点、固定菜单选择器、四项同一可见菜单语义及原文档代际检查。
- 豆包先检查固定登录按钮 `[data-testid="to_login_button"]`；可见时优先返回 `unauthenticated`，不再查询菜单。
- 豆包正证只接受固定 `role=menu` 中“添加账号”和“退出登录”同时可见，并且该菜单自身的 id 被一个可见 `button[aria-controls]` 引用，且该按钮 `aria-haspopup` 非空、非 `false`。结果以 `accountMenuLinkedVisible` 表达。跨菜单聚合的旧 trigger 布尔值不会授权。
- `sample()` 与 `sampleAccountMenu()` 共用同一个状态。菜单在同一文档中关闭或暂时不完整时保留已观测正证；新文档、导航、进程关闭、无效结果或异常会失效/回到 `unknown`。新文档没有正证时仍为 `unknown`。

父任务提供了豆包同菜单“添加账号/退出登录”及汇总 trigger 布尔的实机观察；严格同源组合尚未验证。R2 的 `accountMenuLinkedVisible` 严格组合目前只有隔离 DOM fixture 覆盖；不能据此声称豆包实机正证已验证。DeepSeek 正证来源沿用先前候选记录。本候选不证明站点 API 会话、账户权限或业务请求认证。

## 主要移植点

可将 `after/webai-auth-state.js` 作为单文件候选审阅；生产接入仍须由 Host 持有的 WebContents 提供 `readDocumentIdentity`、隔离世界只读 `executeReadOnlyProbe` 和生命周期订阅，不能由 renderer 传脚本或认证布尔。需同步 `webai-auth-state.d.ts` 中 `WebAiAuthEvidence` 的 `doubao-account-menu` 及菜单 DTO 的 `accountMenuLinkedVisible`。上层状态发布白名单也需显式接受 `doubao-account-menu`。本轮没有改 Host/Main/前端 publisher，也未部署。

## 文件

- `before/`：A4B 源文件快照。
- `after/`：R2 单文件 JS/类型候选。
- `webai-auth-state.patch`：JS 与 `.d.ts` 的规范相对路径补丁。
- `webai-auth-state.js`、`webai-auth-state.d.ts`：工作副本。
- 恢复目录 `recovery-20261029/webai-auth-positive-r2-20261101/`：隔离测试、命令和哈希证据。
