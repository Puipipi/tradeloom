# 织贸助手源码启动指南

本指南适用于 Windows 上的 source-mode 开发。Git 仓库不包含 DSH runtime、Python 环境、PostgreSQL 程序/数据、用户 provider 配置或已有演示数据。先按[运行时准备与升级说明](upgrade-harness.md)准备 pinned DSH 源码和发行目录；脚本准备结果不是已编译、可启动的桌面发行版。fresh clone 的完整编译、receipt 和首次 GUI 启动尚无单命令流程，不要把下列准备步骤当成已实测的自动 bootstrap。

## 需要的外部程序

- Git 和 PowerShell 5.1 或更新版本。
- DSH 上游要求 Node.js `^22.19.0 || >=24.0.0`、pnpm `11.28.5`。`scripts/launch-tradeloom.ps1` 从 PATH 查找 `node.exe`。
- Python 专用环境，依赖见仓库根目录的 `requirements-workbench.txt`。本机完整隔离 Django 回归使用 Python 3.14.5；source launcher 只检查 `%LOCALAPPDATA%\TradeLoom\python-env\Scripts\python.exe` 存在，并未在代码中规定最低版本。packaged-runtime 使用的 Python 3.12.14 是另一套合同。
- PostgreSQL 17 Windows binaries。`scripts/start-postgres.ps1` 从 `%LOCALAPPDATA%\Programs\PostgreSQL\17\pgsql` 查找程序，数据根为 `%LOCALAPPDATA%\PostgreSQL\tradeloom`，默认只监听 loopback。脚本不会安装 PostgreSQL。

创建专用 Python 环境并安装本项目依赖：

```powershell
$pythonRoot = Join-Path $env:LOCALAPPDATA 'TradeLoom\python-env'
py -3.14 -m venv $pythonRoot
& "$pythonRoot\Scripts\python.exe" -m pip install -r .\requirements-workbench.txt
```

这里的 `py -3.14` 要求你已安装兼容的 Python 3.14；也可以把它换成已安装解释器的明确路径。该命令不是 Python 安装器，也不会准备 PostgreSQL 或 DSH。

## 固定 DSH runtime

通用准备命令和锁定 commit、marker、patch receipt 的验证方法见[运行时准备与升级说明](upgrade-harness.md)。准备脚本使用仓库父目录下的 `workspace/research/references/deepseek-harness` 和 `workspace/runtime/tradeloom-harness/releases/<version>`。这些外部目录须自行按说明创建；clone 不会带入它们。

当前普通启动脚本的默认候选由 `apps/tradeloom-launcher/candidate-payload.mjs` 固定为 `0.2.1-rc.2-tradeloom-desktop-2`。它不会下载 runtime，也没有 `-Runtime` 参数。source-mode 还需要与该发行目录相符的 compiled desktop、`.tradeloom-runtime-owned` marker 和 `.tradeloom-desktop-build-receipt.json`；仅运行 `prepare-runtime.ps1` 不满足启动条件。本机“织贸助手（本地开发）”快捷方式使用项目外 candidate7、数据根和 runner，是机器专用入口，不随仓库提供。

## 启动与停止

先确保已有 PostgreSQL 数据可保留；不要重置或覆盖已有集群。启动项目自有实例：

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\start-postgres.ps1 -Port 55432
powershell -ExecutionPolicy Bypass -File .\scripts\launch-tradeloom.ps1 -Mode desktop -DataRoot '<新建的绝对数据目录>'
```

首次 `DataRoot` 必须不存在或为空。启动器会创建 ownership marker，后续必须继续使用同一目录。启动前还需要本机 `55432`、Django `3090` 和所选局域网地址的 Host `3088` 可用；多张活动物理 Wi-Fi/以太网网卡时脚本会要求选择。真实数据库密码从产品外部本机密码文件传给服务进程；不要把它写入命令、`.env.example`、日志或 Git。

停止由该启动命令管理的实例：

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\stop-tradeloom.ps1 -DataRoot '<与启动时相同的绝对数据目录>'
```

普通窗口 X 只隐藏窗口；要结束应用，请使用应用菜单中的退出。不要用这些脚本关闭其他 DSH 实例。

## 配置和当前能力边界

- [`.env.example`](../.env.example) 是占位模板，不含真实密码或 API Key；真实设置只放本机环境/受保护数据根。无需 DeepSeek 官方登录；在织贸助手自己的 provider 设置中配置所选兼容 API。
- 真实 provider 的模型理解和工具调用，与 workflow 的 `local_mock`/`simulated_rules` 执行是分开的。当前本机已验证真实 DeepSeek Flash 的有限提案与只读工具调用，不代表整条 workflow 由真实 LLM 自动执行。
- ERPNext 默认未配置。管理员准备连接前，后端状态仍为未连接且不会访问 ERP 外部服务；普通桌面用户不需要安装 Linux、WSL、Docker 或 ERPNext。
- 窄屏网页视口通过过业务验收，实体手机尚未验收。p8 安装版未包含最近 source-mode 更新，且其历史首启问题仍待单独处理。

本机 GUI、candidate7 和独立数据根的证据见[验收矩阵](acceptance-matrix.md)及[工作报告](work-report.md)。这些本机记录不是 fresh clone、其他机器、安装版、实体手机或真实 ERP 服务的验收证据。
