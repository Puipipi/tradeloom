# O07：已安装 SDK 文件运行时验收

## 结果

**此前首轮报告已撤回，不作为验收证据。** 首轮没有检查 AgentLoop 持久化的工具结果；ToolRuntime 会将 execute 内断言错误记录为工具失败，因此单看脚本适配器结束不足以证明文件用例成功。现行脚本在外层检查真实 `tool/result` 的成功状态和回执，并要求 execute 内所有检查完成。它另有故意抛错的负向模式，证明工具失败会令整个脚本以非零退出。

修正后的独立验收通过。它从 rep4 已安装目录加载同一份编译 SDK 类，并动态导入共享的 `packages/tradeloom-shell/webai-runtime-files.js`。真实 SDK AgentLoop 通过本地确定性脚本适配器发起一个 ToolRuntime 工具调用；共享模块在该真实 `exec` 生命周期内签发并使用文件能力，`write_new` 走 SDK 的 `dsh-tool-fs` 写工具。

通过的断言：

- AgentLoop 工具调用触发真实 ToolRuntime 执行，并可绑定 live `exec` 与 agent scope。
- 在唯一临时工作根中读取已知 UTF-8 文件，并通过 SDK 写工具创建新文件、核对落盘内容。
- 拒绝覆盖既有文件，且原字节保持不变。
- 拒绝 `../` 越界路径，根外哨兵文件保持不变。
- 注入的测试策略拒绝名单可拦截读取；这是验收输入，不代表生产 preset 已验证。
- 外层 ToolRuntime 调用结束后，原能力不能再次执行，且运行时已自动撤销授权。

## 复跑

在独立 main 根目录执行：

```powershell
$env:TRADELOOM_DSH_RUNTIME_ROOT = Join-Path $env:LOCALAPPDATA 'Temp/tlr4p/targets/win-x64/dsh'
$env:TRADELOOM_WEB_AI_SHELL_ROOT = 'C:/Users/23825/Desktop/ICT/tradeloom/packages/tradeloom-shell'
node testing/o07_sdk_runtime_acceptance.mjs
```

验收使用 Node 内置断言，无需安装依赖。成功时脚本以退出码 0 输出一行非敏感 JSON 摘要，并在 `finally` 中仅删除本次创建的 `tl-o07-sdk-*` 临时工作根及其同名根外哨兵文件。

负向控制（预期脚本退出码非 0）：

```powershell
$env:TRADELOOM_O07_NEGATIVE = '1'
node testing/o07_sdk_runtime_acceptance.mjs
Remove-Item Env:TRADELOOM_O07_NEGATIVE
```

该模式让真实 ToolRuntime 工具 execute 故意失败；若脚本意外退出 0，即为负向验收失败。

## 边界

已验证的是 rep4 已安装编译 SDK 的 AgentLoop、ToolRuntime、scope、SandboxPolicy、SandboxedFileSystem 与标准文件写工具，同共享 runtime-files 模块及真实临时文件系统的组合；LLM 响应和拒绝名单是确定性本地测试输入。没有验证已安装 Host 的插件挂载、真实 preset/策略来源、GUI、provider 网页/DOM、外部模型、真实模型消息或真实子代理生成，因此不据此标记 O07 整体验收完成。
