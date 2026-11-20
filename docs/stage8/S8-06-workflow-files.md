# 第 8 阶段第 6 项 · 工作流文件与预览

实看 S059「工作流主场景四分区」截图，SHA-256 为 `957f4dc2f3b924f2178f782d6b22ccb19cc520d3901ce1d2728baa40470404e1`。工作流右上面板显示当前目录、打开、上一级和条目。左下显示同层条目或选中文件的预览，支持从两处进入文件夹及选中文件。关闭目录后恢复已有业务文件与预览，仍使用 `/artifacts#files`、`/artifacts#preview` 及现有 iframe 发件人校验。

「打开」复用桌面的原生目录选择器，提示选择会授权当前工作流中心助手浏览。用户取消时保留原授权。Main 验证工作流宿主窗口和中心会话绑定，经既有父子进程控制通道把选中的目录交给 Host。Host 保存一份内存授权，绑定中心会话与绑定版本，向界面和助手发行当前目录的临时条目 ID。「上一级」到授权根即停止。根目录或绑定变更、关闭目录后，旧条目不可使用。目录内符号链接和 junction 跳转均拒绝。桌面预览支持不超过 1 MiB 的 UTF-8 文本及 PNG/JPEG，文件下载上限为 20 MiB。列表最多检查 500 项，截断时显示提示。

`tradeloom_workflow_files` 注册给中心助手，只有通过 Host 精确核实的当前中心会话可使用 `current`、`enter` 和 `up`。助手能看到获准的目录与文件名，文件内容预览和下载留给桌面用户。助手进入子目录后，Host 通过私有进程消息发出目录变更通知，Main 转发给当前工作流窗口，两个面板重新读取同一 Host 状态。测试覆盖了无需切焦、重挂载或点击刷新即可更新的路径。

## 源码与验证

隔离工作树为 `workspace/source-worktrees/stage8-workflow-files-20261119`，初始基线为 `24d8670f750e9fd97492d9e40a6a130c53f9c2d8`，最终行为提交为 `5d54d8912797abb2ddfe37915160dd05b44b9c0c`。该提交包含 SDK 参数兼容修正，文件夹 ID 仍在 Host 校验为 UUID 格式。

`packages/tradeloom-shell/tests/workflow-files.test.mjs` 在 Windows 临时目录执行真实文件系统读写，并用受控 Electron、进程传输和 Host 绑定状态驱动正式组件。测试运行真实工作流 companion、source preload、控制器、Main 目录选择与 Host 控制分发、SDK 目录控制及变更通知、业务 Host 授权和中心助手工具。严格回放模式还通过物理产物加载 SDK ToolRuntime 注册、参数投影及校验。三个用例如下。

- 用户和助手共用授权。验证正常打开、进入子目录、返回、左右两处选文件、文本/图像预览、下载和未知格式状态。助手导航后同窗两板同步。拒绝其他会话、任意路径、已失效 ID、未经授权的 renderer 与助手读取文件。
- 取消、替换授权根、junction 替换与绑定版本变更。验证取消保留原授权、换根使旧 ID 失效、禁止链接离根、过期目录弹窗结果无法发放授权。
- 用户关闭目录时撤销进行中的助手导航。控制 Host 在提交前的绑定读取，确认关闭后的旧操作失败，随后助手读取当前目录也失败。

源测试 3 项全部通过。A4 物理候选复跑相同 3 项，也全部通过，并执行真实 SDK 的工具注册、参数投影和校验。在隔离工作树根可复跑。

```powershell
node --test packages/tradeloom-shell/tests/workflow-files.test.mjs
$env:TL_WORKFLOW_FILES_REPLAY = '[local-path-redacted]
node --test packages/tradeloom-shell/tests/workflow-files.test.mjs
```

## 严格回放

A4 的 ASAR SHA-256 为 `7459fa2d927e557ae850f64a0a2b700267cd1d09b52b50f14ab8924c8ddbcc8b`。业务包为 79 个文件，聚合 SHA-256 为 `a8dceb3c45933e4318b2559d533c335f51d48991edacc1073db1b2701c223179`。第 5 项插件种子清单的 SHA-256 保持 `40e58722139336149644a361ffa97664a843b26cab0d7ad50e00657471399e8a`。A4 从 A3 仅修正业务工具的 SDK 字段声明，目录 IPC、工作流界面和其余业务包内容延续 A3 的严格回放。完整读回 `[local-path-redacted]` 的 SHA-256 为 `9603ffae0e8ce62e75b42fc8c41148eeb7d2abdb99e9f2544e17d01643571940`。

在同一隔离树用 A4 Desktop 桥和 SDK 复跑第 5 项工作流面板、鲸鱼所有权、原生工作流 UI、业务工具和 Shell 总览，连同三个目录用例共 108 项，104 通过、4 跳过。跳过项为可选 Cordis Loader、配置合成和 ERPNext、用户资料的 provider 序列化用例。目录工具的 SDK 验证包含在三个通过的候选用例内。

| 工作树内回执 | SHA-256 |
| --- | --- |
| `tmp/s8-06-a4-3.tap` | `85a847933557cbd21889e43af26024e6c2bd775234c1fd21d1e0de7e1e98ee62` |
| `tmp/s8-06-a4.tap` | `7b28e1399ec7225fc1824845f38f4fa0ddc61c93a35e3a620d735e4593fb0c9c` |
| `tmp/s8-06-sdk-resolve.mjs` | `a9ecd5f25eb838f5e977385be70112327ff9eb3386e53bbf269ee835b224dd9c` |

## 真机待验

本分支完成源码、受控正常入口和严格回放验证。仍需在已授权的真桌面窗口，使用独立测试目录确认原生选择器开启和取消、工作流窗口两个面板、格式预览和实际下载，以及实际中心助手导航时的同窗更新和授权关闭。没有运行安装包、启动正式桌面 Host、读取真实用户目录或调用外部模型。
