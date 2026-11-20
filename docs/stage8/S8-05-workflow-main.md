# 第 8 阶段第 5 项 · 工作流主视图

## 参考

实看 S059 截图 `S059_V04_00m09s250_工作流主场景_四分区.png`，SHA-256 为 `957f4dc2f3b924f2178f782d6b22ccb19cc520d3901ce1d2728baa40470404e1`。截图的左上主区依次展示开始、刷新画布、画布页签和分类工具，右下是助手。当前候选沿用 TradeLoom 的画布、节点分类和视觉样式。

ComfyUI 官方资料中，空白画布双击打开节点搜索，画布支持平移、缩放和适应视图，子图支持通过端口连接并进入编辑。本切片用这些操作核对图编辑交互的职责边界，交付范围为画布入口、工具栏、页签、刷新和分类菜单。[ComfyUI 快捷键](https://docs.comfy.org/zh/interface/shortcuts) · [ComfyUI 子图](https://docs.comfy.org/zh/interface/features/subgraph)

## 源码与验证

- 行为提交为 `568148a2694cdbdfb8e9e43abebe33878027acfd` 和 `e4f24c3e5434f44aabc349471b7fb6dfe2d6e0aa`。原生主区等待指定画布 owner 的挂载确认，重新进入时读取现有访客状态。F2 基线的源码回归在 `document-loaded` 就调用显示，候选在正确的 `context-mounted` 后才显示。该证据解释可达的首屏聊天窗口，已安装应用长驻聊天问题仍需现场确认。
- 工具栏首层提供真实运行准备、刷新和可滚动键盘页签。刷新只读取已保存画布，保留视口和刷新期间的本地编辑。分类菜单用原生点击和键盘打开，按 Esc 或点外部关闭。新安装的鲸鱼组件识别原生访客身份和真实输入区，已有 profile 的旧组件在画布专用文档内使用样式保持隐藏。
- 测试提交 `b8b7dd0cc4154552b8527c9b4b00c1ca257e7c0c`。使用 F2 严格回放的 SDK 与场景资源，30 项全部通过。独立无头 Chrome 使用生产画布函数与受控 React/DOM 适配器，对菜单执行了真实指针移动、跨间隔点击、触摸、Enter、Tab、Esc 和外点关闭，并验证页签方向键及 Home。该验证涵盖浏览器事件、源逻辑和受控原生桥接。

在隔离工作树根目录复核。辅助脚本和完整回执位于同一工作树的 `tmp/`。

```powershell
$env:S5_08_OUTPUT = '[local-path-redacted]
node --import ./tmp/f2-resolve.mjs --test --test-reporter=tap packages/tradeloom-shell/tests/workflow-independent-panels.test.mjs packages/tradeloom-shell/tests/workflow-whale-owner.test.mjs packages/tradeloom-shell/tests/workflow-native-ui.test.js
node tmp/browser-proof.mjs
```

| 校验文件 | SHA-256 |
| --- | --- |
| `tmp/f2-resolve.mjs` | `f7c5f7f7891f57a0408ade6fcb96826c7d6fe1ad09bc3195a5d238fba1cd716b` |
| `tmp/browser-proof.mjs` | `9ea9764326be53a0a6db8479ceadab121e5087c7253cf8d270a0a45d0e38e518` |
| `tmp/workflow-main-30.tap` | `9c4870861e819eb723223743ec9dde64cdb0043dd6c956f9209f89fdf7790538` |
| `tmp/workflow-main-chrome.txt` | `5c07d0d34677b26df0a2e8d5953f79868636af204a6606553935bbdd8adf64c1` |

## A2 严格回放

配方提交 `8c7b0972ff1a3c6f8dfb502c7f2130b4e17773e0` 锁定 A2 回放。ASAR SHA-256 为 `163380909d67cdae9bbf29a9c3dc2f6b31b653ace71455dbb97e1a2e851815e3`。独立读回 21,788 个逻辑条目，变动为原生业务桥和启动时的插件种子清单校验常量。独立插件种子共 25,169 个文件，载荷变动只有 `p/202/assets/whale-widget.js`，清单 SHA-256 为 `40e58722139336149644a361ffa97664a843b26cab0d7ad50e00657471399e8a`，与 ASAR 内的启动校验一致。

完整读回位于 `[local-path-redacted]`，SHA-256 为 `dc17fd6b8d2d9508dd38b9429868f7de9e408fb9cf371e826207da7eafd017ab`。将上述 `S5_08_OUTPUT` 指向 A2 的 `strict/desktop`，将 `S5_08_WORKFLOW_BRIDGE` 指向其 `renderer/source-shell/replica-ui/business-bridge.js`，同一测试命令再次通过 30 项。将 `TL_WORKFLOW_CHROMIUM_SOURCE` 指向 A2 的 `strict/business-shell/client.workflow.js` 后，Chrome 回归再次通过。回执分别是 `tmp/workflow-main-a2-30.tap`（`704352190d9399652ccbcc7e353167fe4e7f8ae9dc629fc0daf71590497fc3a2`）和 `tmp/workflow-main-a2-chrome.txt`（`5c07d0d34677b26df0a2e8d5953f79868636af204a6606553935bbdd8adf64c1`）。

## 真机待验

F1、F2 保持各自的冻结验收状态。本切片使用隔离候选验证，尚未执行安装包、实际 Host 或真实 Agent。真机需从普通工作流入口观察初次进入和切走重进，核对主区画布和助手的鲸鱼数量。用获准的测试画布检查页签切换、编辑后刷新保护、保存后刷新、鼠标和键盘选分类节点、画布弹出与归位。开始按钮验到准备与确认界面，真实执行按现场授权另验。
