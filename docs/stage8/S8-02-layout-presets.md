# 第 8 阶段第 2 项 · 场景布局预设

Web 端在「工作区布局」中提供「保存当前为预设」「使用已保存预设」和「恢复默认预设」。原生端从场景栏或网格空白处打开右键菜单。每个场景可覆盖保存一份自定义预设，应用默认布局后仍可取回这份自定义预设。

- Web 端通过现有 Host 布局接口保存 Dockview 布局、关闭面板和恢复位置。保存或应用预设前须收回悬浮面板和独立窗口。仅因窄窗口而最大化的临时状态不写入预设。
- 原生端存储分隔比例、面板坐标、关闭状态和当前补位比例。恢复默认读取当前场景的配置坐标。应用前校验面板集合及坐标，用户保存的预设和场景定义分别持久化。

## 定向验证

从隔离工作树根目录运行。`$sdkResolver` 指向已有 F2 严格回放的 Node ESM 包解析辅助脚本，`$nodeModules` 指向已有 React、React DOM 和 jsdom 依赖目录。

```powershell
$env:TRADELOOM_REACT_LIBRARY = "$nodeModules/react/index.js"
$env:TRADELOOM_REACT_SERVER_LIBRARY = "$nodeModules/react-dom/server.js"
$env:TRADELOOM_DOM_MODULE = "$nodeModules/jsdom/lib/api.js"
$env:TL_PANEL_OUTPUT_ROOT = (Resolve-Path apps/tradeloom-launcher/stage5-source06/asar).Path
node --import $sdkResolver --test packages/tradeloom-shell/tests/dock-layout.test.js packages/tradeloom-shell/tests/dockview-integration.test.js packages/tradeloom-shell/tests/panel-close-context-menu.test.js packages/tradeloom-shell/tests/native-panel-race.test.mjs
node --import $sdkResolver --test --test-name-pattern='Host layout endpoint' packages/tradeloom-shell/tests/scenes.test.js
```

实跑覆盖宽窄窗口的保存和应用、两场景隔离、恢复默认后取回自定义预设、重开后应用、无效预设保留当前布局，以及真实 Host 路由对临时状态目录的 GET/PUT 和错误读回。扩大运行 `scenes.test.js` 时，已有的 ERPNext 窄窗口导航用例在第 1 项冻结提交和本候选均止于 959px 选择器断言。正式包体与操作系统窗口仍待验收。
