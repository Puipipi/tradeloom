# 织贸助手 desktop16 便携版

这是用户确认的 desktop16 桌面壳与 DSH 运行环境的独立 Windows x64 便携包。它包含 Electron 44.7.0、Node、pnpm 和 Python，不要求先安装 Node/pnpm，也不需要 WebView2。它是未签名便携版，保留 desktop16 的已有行为与问题。

## 启动

1. 把整个 ZIP 解压到尽量短的目录，例如 `C:\TL16`。不要直接在压缩包预览中运行。包内包含较长的依赖路径；若解压工具报告路径过长，请使用支持Windows长路径的工具重新完整解压，不要忽略失败。
2. 双击 `Start-TradeLoom.cmd`。首次启动会创建当前用户自己的资料目录，不需要管理员权限。
3. 默认数据位置是 `%LOCALAPPDATA%\TradeLoom\desktop16-portable`。账号、会话、设置和日志属于你自己的这份数据，不包含作者的资料。

自选数据目录或仅做无界面检查：

```bat
Start-TradeLoom.cmd --data-root "D:\My Data\TradeLoom"
Start-TradeLoom.cmd --check --data-root "D:\My Data\TradeLoom"
```

`--check` 验证包内Electron/Node、desktop16关键文件、冻结工作台壳、可写数据目录和首次profile，并报告可选Office运行库；不启动桌面窗口。出现解压内容缺失或壳校验错误时，请保留自己的资料，重新解压完整包或使用新的数据目录；启动器不会覆盖已有不兼容profile。

关闭窗口可能仍在托盘运行，请通过应用菜单的退出功能结束应用。启动/运行日志在数据目录的 `logs` 下。日志可能包含本机运行信息或本地服务授权链接，反馈问题前请脱敏；不要公开自己的资料目录。

## 包含与未包含的功能

包含原生桌面窗口、DSH基础运行环境及冻结desktop16工作台壳。界面中的原生助手、会话、场景布局可加载；模型调用需要你自行配置账号或接口。没有预置作者的模型密钥或登录状态。

本包不包含 Django/ERPNext、Postgres、业务数据库、业务账号或企业资料。desktop16业务页面通过本机loopback3090代理访问服务；未另行部署服务时，业务面板和依赖该服务的工作流会不可用。没有把网页能打开当作完整业务软件可用。

Office高级转换的LibreOffice组件还需要系统中的 Microsoft Visual C++ x64运行库（MSVCP140系列DLL）。这不是基本桌面窗口的启动前提；`--check`会单独报告 `optionalOffice`，软件不会自动安装系统组件。

服务只绑定127.0.0.1动态端口。本包不开放局域网访问，也不提供手机连接服务。

## 版本与完整性

上游源码锚点：`1f81c047fc48fa190a683e469daa699857e9afe8`；固定main/host与冻结A34摘要见 `build-identity.json`、`shell-manifest.json`。它不是精确25日23:00完整源码快照，也不是上游签名安装器。

`SHA256SUMS.txt`列出分发文件的SHA256。第三方组件保留在原包路径内的许可证，汇总见 `licenses`、Electron的 `engine/LICENSE` 与 `engine/LICENSES.chromium.html`。这些许可证各自适用，不统一改成MIT。
