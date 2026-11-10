# O07 写入限制最小候选

## 缺陷与修复

共享只读基线 `packages/tradeloom-shell/webai-runtime-files.js` 在 `enableStandardWrite` 开启且 agent 看不到继承的 `write` 时，会在 agent scope 安装新的标准写工具。真实 SDK 的 `tools.restrict({ deny: ['write'] })` 只过滤继承工具；scope-local 工具仍可见，因此该安装路径绕过了现有 SDK 限制。

候选只调整 `ensureListScope`：要求启用写入时，调用者当前必须可见已有 `write`；否则以既有 `UNKNOWN_TOOL` 错误失败关闭。保留原公开选项和原 RuntimeFiles `write_new` 的 grant/sandbox/no-overwrite 检查；删除仅为 scoped shadow 服务的附加 guard 与 `standardFsTools.apply` 安装。已有 SDK global write 保持其原有权限/guard，并可在候选绑定期间正常直接调用。

## 候选文件与应用方式

- `recovery-20261029/o07-write-restriction-candidate-20261030/base/packages/tradeloom-shell/`：共享源码的只读基线副本，包含该模块及其同目录依赖 `webai-local-directory.js`。
- `recovery-20261029/o07-write-restriction-candidate-20261030/after/packages/tradeloom-shell/`：候选副本。
- `recovery-20261029/o07-write-restriction-candidate-20261030/o07-write-restriction.patch`：仅针对 `packages/tradeloom-shell/webai-runtime-files.js` 的文本补丁。

在目标仓库根目录先确认目标文件仍与 `base` 完全一致、没有额外改动，再运行 `git apply --check <补丁路径>`，通过后才可应用。若目标已与 `after` 一致则无需重复应用；存在其他差异时停止，先人工合并。撤回前确认目标仍与 `after` 一致，再用 `git apply -R --check <补丁路径>` 检查并反向应用；有额外差异时不要自动覆盖。此次只提供候选，不应用到独立 main、共享源码、SDK 或运行 profile。

## 验收

运行命令：

```powershell
$env:TRADELOOM_DSH_RUNTIME_ROOT = 'C:/Users/23825/AppData/Local/Temp/tlr4p/targets/win-x64/dsh'
node --check testing/o07_native_policy_fixed_acceptance.mjs
node testing/o07_native_policy_fixed_acceptance.mjs
Remove-Item Env:TRADELOOM_DSH_RUNTIME_ROOT
```

验收脚本使用 rep4 安装的真实 SDK `AgentLoop`、`ToolRuntime`、标准 `tool-fs` 和沙箱文件系统；LLM 是确定性本地脚本，策略是本测试显式施加的 SDK restriction，文件只写入本次创建的临时目录。外层 SDK `tool/result` 回执必须成功并包含全部已完成断言。验证项包括：SDK restriction 隐藏 `write` 后，直接调用与候选 bind 都拒绝且不创建文件；移除该测试 restriction 后，普通 global `write` 仍可直接成功，候选 `write_new` 复用已有 global 写能力，`standardFsTools.apply` 调用次数为零，重复目标覆盖被拒且原内容保留。最终命令退出码为 0。

这证明候选的真实 SDK 组合行为，不证明生产 preset/guard、已安装 Host 挂载、Electron、GUI、网页或外部模型。O07 文件能力仍未在生产 Host 启用。
