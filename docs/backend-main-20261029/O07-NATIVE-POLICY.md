# O07：原生工具权限继承探测

## 结论

这是一次**成功发现权限绕过的机制探测**，不是“权限验收通过”。脚本按设计在发现后以退出码 2 结束。

在 rep4 已安装编译 SDK 的真实 AgentLoop/ToolRuntime 和标准 `dsh-tool-fs` 上，探测过程如下：

1. 将 SDK 标准 `write` 工具注册到 Host/global ToolRuntime，确认新建 agent 初始可见。
2. 对该真实 agent 调用原生 `agent.ctx.tools.restrict({ deny: ['write'] })`。之后 agent 工具视图不再包含继承的 global `write`。
3. 使用正确 `file_path` 与 `content` 参数直接执行原生标准写工具。ToolRuntime 返回 `isError: true`、错误码 `UNKNOWN_TOOL`，且目标文件未创建；这证明不是参数校验错误。
4. 在同一个实际 Native ToolRun 内绑定共享 `webai-runtime-files.js`，只为本次机制探测传入 `getDeniedTools: () => []`，随后调用 `write_new`。共享 adapter 在受限 agent scope 中安装了 SDK 标准写插件，ToolRuntime 成功创建文件，文件内容也与预期相符。

最终 AgentLoop `tool/result` 回执为 `isError: false`，其中包含上述完整观测。故真实 SDK restriction 拒绝了原 global 调用，但同一 restriction 没有阻止共享 adapter 后续安装的 scoped 同名能力。拒绝名单回调为空仅用于隔离本探测问题，不代表生产策略，也没有通过人为名单模拟 SDK 拒绝。

## 复跑

在独立 main 根目录运行：

```powershell
$env:TRADELOOM_DSH_RUNTIME_ROOT = Join-Path $env:LOCALAPPDATA 'Temp/tlr4p/targets/win-x64/dsh'
$env:TRADELOOM_WEB_AI_SHELL_ROOT = 'C:/Users/23825/Desktop/ICT/tradeloom/packages/tradeloom-shell'
node testing/o07_native_policy_probe.mjs
```

退出码 2 表示脚本拿到真实成功工具回执并复现 `FAIL_ADAPTER_BYPASSES_SDK_TOOL_RESTRICTION`。其他异常（例如工具回执失败、断言或模块加载错误）为普通非零退出，不算探测成功。脚本只在本次唯一临时目录创建文件，并在 `finally` 中清理该目录。

## 源码映射与最小自有 adapter 建议

- 已安装 SDK `node_modules/@deepseek-ai/dsh-tools/lib/index.js` 中 `ToolRuntime.restrict()`（约 2987–3005 行）只过滤 agent 从祖先/global layer 继承的工具视图；SDK 注释明确 agent scope 自己注册的工具仍然可见。`ToolRuntime.execute()` 构造 execution 时若当前视图找不到工具（约 3236 行），返回 `UNKNOWN_TOOL`；可见不代表 guard 允许，实际 guard 仍在执行阶段单调拒绝。
- 共享 [`webai-runtime-files.js`](C:/Users/23825/Desktop/ICT/tradeloom/packages/tradeloom-shell/webai-runtime-files.js:126) 的 `ensureListScope()` 在 agent scope 看不到 `write` 时（第 136 行）挂载标准 `dsh-tool-fs` 的 scoped `write` 插件。这是本探测确认的绕过路径。标准写工具原定义在 SDK `packages/fs/tool-fs/src/write.ts` 的 `write` 注册/执行处（约 74–120 行）。
- 下一步应由自有 adapter 在原 agent registry 的现存工具视图上执行，并在原 `write` 不可见时 fail closed；不要因 restriction 隐藏 global 工具而安装 scoped 同名 shadow。当前工具 API 没有可复用的统一 effective denied-list getter，因此生产 `getDeniedTools` 不能填空数组或推测策略。原 SDK、共享模块与产品源均未修改。

## 边界

使用真实 rep4 编译 SDK AgentLoop、ToolRuntime、ToolRestriction、标准 `dsh-tool-fs`、`SandboxedFileSystem`，以及共享 runtime-files 模块；LLM 响应和工作根都是本地测试输入。未运行模型或 GUI，未读取 profile/凭据，也未验证已安装 Host、生产 preset/guard 组合、真实网页或外部模型。此发现不覆盖上一份 O07 正向文件链验收，且不代表 O07 整体验收完成。
