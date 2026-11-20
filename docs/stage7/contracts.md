# 阶段 7 生产调用契约

| 契约 | 生产者 → 消费者 | 保持条件 |
| --- | --- | --- |
| 场景和布局 | packages/tradeloom-shell/client.js 的 require.async → client.scenes.js → client.dockview.js、scene-layout.js、dock-layout.js。正式 source06 source-shell-controller.mjs 把原生视图及几何投给 replica-ui/business-bridge.js | scene 是场景，panel 是场景内挂载位；独立场景窗和 panel popout 的窗口身份、拖动、还原、关闭分别持有。保布局持久化、DOM/CSS 命名、放缩时外框和内容同步 |
| 角色和授权 | source06 source-shell-controller.mjs 按当前 window、view、frame、seat 推导身份 → Host 注册的 execution-origin-authority.js → scene memory、MCP 及需要任务身份的服务 | 校验完整 sceneId、panelId、roleId、sessionId、bindingRevision、当前受信任 owner 与关联对象、窗口/代际/存活状态及撤销。operation 绑定授权操作及路由，失效拒绝。场景 owner 授权与工作流任务授权分开。活动场景、默认 scene、请求自报 owner 不代替该链 |
| 工作流 | client.scenes.js 惰性加载 client.workflow.js → host.js 的 WORKFLOW_NATIVE_UI_ROUTE／WORKFLOW_ROUTE → workflow-native-tools.js 所组装服务、workflow-native-executor.js 与 journal → workflow-artifact-source.js、workflow-native-artifact-http.js → Django runs、definitions 和 native-artifacts | UI 事件、任务身份、执行图、记录版本、恢复原执行与产物授权相互对应。Django 保存 CanvasWorkflowRun、定义、产物版本和 dispatch 事实；不凭页面状态补执行结果 |
| Django HTTP 和页面 | manage.py → config.settings 与 config.urls → workbench/urls.py → 域服务、共享模型 → workbench/templates/workbench 和 static/workbench JavaScript → Host 受控业务嵌入、专属 Edge | 保路径、HTTP method/状态码、JSON 字段、schema、CSRF、既有权限和幂等。DOM 事件、组件内滚动、窄宽断点及页面布局跟随当前消费者。数据库迁移和共享模型留 I |
| 启动与退出 | portable/Program.cs 和 launcher.json → Electron 的 bootstrap-entry.mjs → bootstrap-core.mjs、installed-bootstrap.mjs、core.mjs 与插件初始化。stage-desktop.mjs 使用 prepare-profile.mjs、desktop-receipt.mjs 校验候选；local-start-guard.mjs 和 websocket-authority.mjs 负责本地入口的约束 | 保 DATA 与程序分离、环境传递、本地服务占用和清理、事务/回退、认证及监听地址。正式覆盖有 source06 版本，统一核原实现和对应 postimage |
| 记忆、MCP、网站和语音 | Host 注册 scene-memory.js 和 mcp-runtime.js。client.scene-memory.js 消费目录和图，client.mcp-runtime.js 由 client.source-native.js 惰性加载并空注册，MCP 设置沿原生入口。手动网页由 source06 replica-ui/business-bridge.js 调用 source-preload.cjs，经 Main IPC 和 controller 的可信窗校验委托 aiWebWindows；client.session-audio.js 与 session-speech.js、windows-speech-provider.js/.ps1 组成回复朗读。语音输入另走官方绑定补丁 | 保当前 source、scene、role、session、bindingRevision 与撤销边界，切换及卸载清理；保持人工网站登录、提问、附件和保存入口。保持原生语音输入与自有 Windows 回复朗读的独立实现 |

## 配置来源

- I 管理 dsh-base.manifest.json、apps/tradeloom-launcher/dsh-upgrades、integrations/dsh/patches/patches.lock.json、source06/SOURCE-MANIFEST.json 和部署清单。更新脚本沿 update → upgrade/replay/build → apply/recover/rollback 使用固定官方 preimage、配方和生成 postimage。精确覆盖不等于官方输入。
- 启动配置由 launcher.json 描述外部 DATA 与服务端口，启动器 core 和 bootstrap 消费。packages/tradeloom-shell/cordis.patch.yml、package.json、scenes.json、Host 与 state.js 分别承担插件加载、文件出口、场景定义与当前绑定；共享配置由 I 管理。模块私有服务使用 I 提供的身份和配置入口。
- config/settings.py 由 Django 进程消费；workbench/urls.py 固定业务入口，workbench/models.py 与 migrations 固定共享数据契约。页面拥有模板与静态资源，领域服务拥有内部执行逻辑。
