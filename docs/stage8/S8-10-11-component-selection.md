# 阶段 8 第 10/11 项：场景组件选择首切片

原要求 S059 已由主控打开原图实看，SHA-256 为 `957f4dc2f3b924f2178f782d6b22ccb19cc520d3901ce1d2728baa40470404e1`。观察到四区与分级要求；本次只取自建场景可选择已登记组件的一个切片：复制「运行记录」，把原 `reference` 槽从「资料」切换为「文件」，可切回，保留槽 ID 与网格。Host 目录供桌面及 Web 共用。

## 源码与构建

- F2 候选提交 `407df0c4fb46eb3a39e431b66cf701591250a04e`，Git 树 `28334debeeb1c5796b0ec788b328531978657d94`。
- A3 红绿回归：同一测试执行旧 `20fa159` 的真实复制按钮处理函数，触发 `window.prompt unsupported`；新代码用表单输入，确认、取消、重复、非法和超长校验均通过，且只在明确保存时提交原配置版本。A3 严格重放后的聚合结果为 58 项，54 通过、0 失败、4 项无关条件跳过。
- F2 正式构建独立读回：`[local-path-redacted]`。355 个源文件，39,828 个程序条目，21,788 个 ASAR 逻辑条目。程序 ZIP SHA-256 `b7b8333118ffb8b595efc2750c62874aacc797eed97a471566dec1b542515b72`；源码 ZIP `83a0fe639004d71dd79c561de9c28c5420bb9299bddeed4ec53bddab049bba00`；ASAR `9afd12d5cea463eb033259c93487a9450b631f27ed8136c54cf3b45f3df3dd27`。构建凭证不代表应用实操验收。

```powershell
node --test packages/tradeloom-shell/tests/source-scene-copy.test.mjs
$env:S5_08_OUTPUT='[local-path-redacted]
node --import file:///[local-path-redacted] --test packages/tradeloom-shell/tests/scene-configuration.test.mjs packages/tradeloom-shell/tests/source-configuration-apply.test.mjs packages/tradeloom-shell/tests/source-scene-copy.test.mjs packages/tradeloom-shell/tests/dock-layout.test.js packages/tradeloom-shell/tests/scenes.test.js packages/tradeloom-shell/tests/workflow-independent-panels.test.mjs
```

## 实机观察与待验

- F1 工作台实机启动，窗口 PID `43536`、HWND `68816630`，已核对桌面、Host、业务三端绑定。已打开「场景配置」、选中「运行记录」、看到 `reference` 槽的「资料」。
- 独立输入工具的两次动作均未验证执行；复查观察 ID `ac44673c35024f91b23c1bf675a9d91d` 未见副本，画面仅在工具内联截图。官方工具观察到 Windows 安全中心提示覆盖工作台，未派发点击。F1 保留现场。
- F2 防火墙规则已限定本机范围；现有系统提示仍在前台，F2 未启动。真实复制、选择文件、保存并应用、冷启动读回、切回资料，以及 Web 使用同一配置均待实操验收。
