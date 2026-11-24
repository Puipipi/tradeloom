# Windows 企业服务器图形入口

双击包根目录 `Start-ServerGui.vbs`，立即显示系统 WinForms 窗口。WScript 仅隐藏 PowerShell 的控制台；窗体、按钮和密码框由 Windows 自带 WinForms 构造，没有自定义 EXE、动态编译 DLL 或系统策略修改。进程仅使用 `RemoteSigned`。若主机策略拒绝脚本，按实际拒绝报告，不切换到被拦截的入口。

窗口提供“启动服务”“刷新状态”“打开管理控制台”。先显式启动服务；没有管理员时自行输入账号、密码和确认密码，再点“创建首个管理员”。密码框遮罩且不预填。成功后输入框清空，首建区域禁用；打开原 `/enterprise/console/` 管理页面，使用刚创建的账号登录。窗口关闭不停止服务。显式停止仍使用原 `Stop-EnterpriseServer.ps1 -DataRoot ...`。

## 启动与打包

快捷方式目标为 `%WINDIR%\System32\wscript.exe`，参数示例：

```text
"C:\TradeLoom-Server\Start-ServerGui.vbs" -DataRoot "C:\Users\name\AppData\Local\TradeLoomEnterpriseServer-RC14" -Port 27814 -PostgresPort 56814
```

仅支持 `-DataRoot`、`-RuntimeSource`、`-Port`、`-PostgresPort` 成对参数以及单独 `-Probe`。新安装默认使用包内 `enterprise-runtime-bundle`。已有安装只读回配置中的已保存端口和路径；参数不覆盖它们。不完整的非空目录明确拒绝，保留文件，由操作者另选空目录或先核查备份。

在原完整服务器包中添加以下文件，并采用本提交的安装脚本：

- 根目录 `Start-ServerGui.vbs`
- `scripts/ServerWindow.ps1`
- `scripts/ServerGuiBackend.ps1`
- `scripts/server-gui-admin.py`
- 修改后的 `scripts/Install-EnterpriseServer.ps1`
- 本文及更新后的 `README-Windows-Enterprise-Server.txt`

继续保留原 `scripts/EnterpriseServerHttps.ps1`、`scripts/Start-EnterpriseServer.ps1`、`scripts/Open-ServerConsole.ps1` 及其本地控制台依赖。不要包含私有 QA、数据库、凭据或试验用 WinExe。现有命令行安装默认仍交互创建管理员；仅图形后台使用新增内部 `-DeferAdministratorSetup` 开关。

## 归属与首次创建

后台复用固定安装、启动与健康检查。操作前要求 `install_root` 等于 DataRoot，应用、运行库、数据库分别位于其 `app`、`runtime`、`postgres-data`；Django/PG 的可执行路径、PID/监听者、当前 Windows SID 和健康模式须一致。归属不符或不健康时显示明确错误，不隐式停止/重启。并发启动同目录使用命名互斥锁。

外置 Python helper 直接使用已安装运行库和应用，不往已有 app 中复制代码、不写版本或 pycache。账号密码仅从窗口经过两跳 UTF-8 stdin；不进入参数、环境、文件或日志。数据库服务自己的随机凭据仍按原安装方式管理。首建使用 Django 账号与密码验证和数据库事务 advisory lock；任何已有超级管理员（含停用管理员）均拒绝再次首建，避免把首次引导用作账号恢复。

## 复测

```powershell
cscript.exe //nologo .\Start-ServerGui.vbs -Probe
python .\scripts\tests\verify-server-gui.py --qa-root C:\isolated-new-qa --runtime-source C:\trusted-runtime-bundle --port 27849 --postgres-port 56849
```

`-Probe` 经 WScript 隐藏启动 WinPS5.1，构造同一完整窗体、按钮、两密码字段和事件，校验控件及空白账号后释放；不 ShowDialog、不触发 Shown、不启动服务，不访问配置。集成测试拒绝已有 fixture 目录，使用独立真实 PG/HTTP，验证弱密码拒绝、中文账号及 Unicode 密码首建、并发仅一次、重复拒绝、带 CSRF 的老板登录、复用不改 PID/config/app、非空目录保留、错误路径和错误 PID 拒绝。

图形首屏、按钮点击和浏览器呈现须另行实际观察；探针与 HTTP 验证不能替代该项。测试结束后仅停止测试自己的 DataRoot，测试数据和脱敏证据保存在源码树外。

## 窗口内管理助手

从 Server 快捷方式打开企业服务器窗口，点击右上方「管理助手」打开原生窗口，可输入“检查服务状态”“启动服务”“停止服务”“重启服务器”，也可直接点击四个按钮。仅支持这些固定意图；不接外部模型，不执行用户输入的命令，不访问业务数据、邮箱配置、凭据或 Windows 账号管理。

状态从本安装的进程、端口归属与 HTTP 健康检查实时取得。停止、重启会先显示确认框，默认选“否”；取消后不派发后台动作。确认后重新核对安装与进程归属，使用既有 Stop/Start 管理同一 DataRoot，重启后报告健康结果。关闭窗口仍保留服务。管理助手不依赖浏览器本机登录票据，也不会要求输入 Windows 凭据。

复测入口：`powershell -NoProfile -File scripts/ServerWindow.ps1 -Probe` 构造完整窗体，验证固定中文意图、拒绝任意命令、取消零派发与确认后的固定动作派发；不显示桌面。`python scripts/tests/verify-native-management.py --package <源码或Server包目录> --runtime <受信运行库目录> --data-root <不存在的隔离目录>` 使用真实隔离 PostgreSQL/HTTP 验证启动、状态、确认拒绝、重启、停止和错误 PID 归属拒绝，并停止测试服务。测试固定使用专用测试端口，端口占用时应停止测试并另行安排，不操作占用者。

Probe 与功能测试不替代实际窗口呈现、鼠标点击及远程桌面验收。
