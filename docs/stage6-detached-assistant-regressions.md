# 独立场景助手回归修复（r13 后续）

## 改动与根因

- `renderer.js` 的面板拖拽起点排除助手标签行。此前完整独立窗口中，鼠标按下 × 会由标题栏取得 pointer capture，抬起后 click 不再交给 ×；直接 `.click()` 的窄 mock 因而漏检。
- `business-bridge.css` 显式隐藏 `[hidden]` 状态占位。此前 `display:flex` 覆盖浏览器的 hidden 默认样式，菜单暂时遮挡原生画布时会露出旧的“正在连接工作流画布”。没有证据证明该动作重载画布。
- `business-bridge.js` 按菜单与 pane 的矩形交集遮挡 native guest，避免位于助手区域的添加菜单隐藏不重叠的工作流。真正重叠的上下文菜单仍须暂时隐藏 native guest；保留相同挂载与草稿。
- `host.js` 按官方 rc.3 `@deepseek-ai/dsh-agent-preset-registry/display` 契约排除内置模式：ID 为 `standard/ptc/minimal/cordis` 且 `name === undefined`。具名自定义声明保留；显示名或前缀不用于猜测身份。

## 目录真实链路与边界

权威目录是当前 Host context 的 `ctx.get('agentPresets').list()`；官方 `list()` 枚举所有 declared definitions（含失败诊断），不只场景绑定。TradeLoom GET `/tradeloom/assistant-presets` 过滤官方模式、失效项及已由 role catalog 表示的织贸角色。实际 Main `lib/main.js` 已注入 `listAssistantPresets: async () => (await sourceRequest('/tradeloom/assistant-presets')).presets`；controller 合并角色与 preset、派发 opaque targets；preload 暴露 `assistantTabCatalog`；business bridge 渲染并去重。

`sourceRequest` 保留 Host cookie、实例一致性与 response.ok 检查；HTTP 错误携带 code/status。没有改动 session/auth 规则，没有读取或打包用户自有 preset/profile。当前 controller 可在补充 preset roster 失败时只保留场景角色。因此，截图里只有四个场景角色，单凭本次同 ID 修复不能解释；真实交付 Host 的目录请求、实例/profile 是否一致仍需 Windows 实机诊断。不得把合成端到端成功写成该真实环境已恢复。

## 可复测验证

1. `node --test packages/tradeloom-shell/tests/source-assistant-tabs.test.mjs packages/tradeloom-shell/tests/assistant-presets.test.mjs`：14 项通过（其中新增同 ID 自定义预设用例修前失败、修后通过）。依赖使用只读 rc.3 SDK。
2. 用 Electron 运行 `apps/tradeloom-launcher/tests/qa-detached-assistant-electron.cjs`。可设 `QA_REPO` 与 `QA_OUT`，输出独立 userdata、JSON 与截图。脚本只访问合成 Context/Registry、本地临时 HTTP route 与隔离窗口，不控制真实桌面。
3. 完整 `source-entry.html?scene=...&solo=1`，分别执行工作流、商品、交付三个场景。右键添加普通自定义“交付协同”和具名同 ID 自定义“极简审核助手”；真实 `sendInputEvent` 坐标点击切换，关闭非活动、活动、owned-elsewhere 标签，回到各场景固定助手。固定标签无 ×，已打开项从菜单去重。
4. synthetic WebContentsView 保留两个节点与 `{x:31,y:47,zoom:1.06}`，比较 token、draft、viewport、panel DOM identity；菜单开启/取消、添加/切换/关闭后额外 mount 数为 0。重叠的右键菜单可暂时遮挡 guest，恢复后状态一致；hidden 占位 computed display 为 none。
5. 官方真实 `Registry.register()` 两阶段：四个官方无 name 模式 + 一个普通自定义，GET 返回 1 项；第二个合成 registry 三个官方模式 + 两个自定义（其中 minimal 为具名声明），GET 返回 2 项。该真实 GET response 经 production controller catalog handler 与 preload 测试 IPC 到完整 detached 菜单。角色与两个 preset 同时存在。

本次证据为隔离 Electron/Registry/HTTP 集成验证，非真实 DSH 会话或 Windows 打包安装验收。对应交付记录需补真实包测试与 GitHub 提交。
