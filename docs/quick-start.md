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

普通启动脚本默认候选仍由 `apps/tradeloom-launcher/candidate-payload.mjs` 固定为 `0.2.1-rc.2-tradeloom-desktop-2`，不会下载 runtime。`-Runtime` 是包装脚本实际支持的可选参数，但 runtime 必须位于当前 checkout 推导出的受信 `workspace/runtime/tradeloom-harness/releases` 根目录下，并且是其直接子目录。launcher 还会验证 ownership marker、真实 desktop build receipt 和编译文件摘要、产品身份及开发 project descriptor；不能用参数指定其他任意目录来代替这些检查。仅运行 `prepare-runtime.ps1` 不满足启动条件。

本地源码候选使用当前 worktree 的 launcher，并显式传入维护者已准备好的受管 desktop runtime。示例中的 `$runtime` 必须是当前 checkout 推导出的 `workspace/runtime/tradeloom-harness/releases/<version>` 下的直接子目录；各 worktree 的受信发行根不同，不要把别的 clone/worktree 的 runtime 路径传进来。`$dataRoot` 是本机新建的绝对路径，首次须不存在或为空。它只隔离 TradeLoom 的文件/profile；launcher 当前仍连接同一 PostgreSQL 实例中的 `tradeloom_dev`，因此不同 DataRoot 不会自动隔离数据库。若你没有位于受信发行根、且已具备 marker、真实 build receipt、产品身份和开发 project descriptor 的 runtime，应先按[固定 runtime 准备与升级说明](upgrade-harness.md)完成受控准备。fresh clone 尚缺一条完整、已验证的官方 Desktop prepare/build、TradeLoom receipt 与 descriptor 生成/首次启动流程；上游生成 descriptor 的 `dev.ts` 会继续启动应用，本文不虚构一个安全的一键命令。单改 `-Runtime` 不会同步或部署候选 shell/UI/launcher bundle。

```powershell
# 从本 worktree 的仓库根目录运行；将 runtime 替换为已准备的受管绝对路径。
$runtime = '<已准备好的受管 runtime 绝对路径>'
$dataRoot = Join-Path $env:LOCALAPPDATA 'TradeLoom\intake-product-confirmation'
powershell -ExecutionPolicy Bypass -File .\scripts\launch-tradeloom.ps1 -Mode desktop -Runtime $runtime -DataRoot $dataRoot
```

`-Runtime` 必须是已准备好的绝对发行路径，不要把占位路径或未经核验的目录当成可启动 bundle。source-mode 的官方依赖安装、构建和 receipt 约束见[运行时准备与升级说明](upgrade-harness.md)。本地候选契约、源码检查点和未验证边界见[README 本轮候选说明](../README.md#本轮本地源码候选)及三份[应用契约](plans/2026-10-24-intake-product-application-contract.md)、[原生桥验证](verification/2026-10-24-native-workflow-bridge.md)、[执行计划来源验证](verification/2026-10-24-execution-plan-source-references.md)。

source-mode 桌面还需要上游开发 project descriptor：`apps/desktop/.desktop-build/development/project/desktop-runtime.json`。它由 DSH 的 `prepareDevelopmentProject` 根据已构建的 Desktop、Host 与依赖目录生成，独立于 patched runtime 准备、官方 Desktop build 和 TradeLoom build receipt；launcher 会在启动 Django 或 Electron 前检查该普通文件及基本结构，缺失时明确拒绝启动。上游 `apps/desktop/scripts/dev.ts` 会调用 `prepareDevelopmentProject`，随后继续准备 primary runtime 并启动 Electron，因此它不是纯准备命令；不要为了生成 descriptor 而把 `dev.ts` 当成不会启动窗口的步骤。安装版走独立的 packaged bootstrap，不要求此开发 descriptor。

source-mode 的 Electron 产品身份由锁定补丁 `integrations/dsh/patches/desktop-branding.patch` 写入 pinned `apps/desktop/package.json` 的 `dshDesktopAppId`；启动器会检查该清单身份。不要手改外部 runtime 的上游清单；更新身份时应修改受管品牌补丁并同步校验锁。

## 启动与停止

先确保已有 PostgreSQL 数据可保留；不要重置或覆盖已有集群。启动项目自有实例：

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\start-postgres.ps1 -Port 55432
powershell -ExecutionPolicy Bypass -File .\scripts\launch-tradeloom.ps1 -Mode desktop -DataRoot '<新建的绝对数据目录>'
```

首次 `DataRoot` 必须不存在或为空。启动器会创建 ownership marker，后续必须继续使用同一目录。启动前还需要本机 `55432`、Django `3090` 和所选局域网地址的 Host `3088` 可用；多张活动物理 Wi-Fi/以太网网卡时脚本会要求选择。一次受管启动会统一管理 Django 与 Host，并为二者生成和传递临时 native bridge key；密钥仅供这两个子进程配对，不要手工复制，也不要放入 `.env`、命令、文档或日志。缺少配对时 native 请求会 fail closed；无需反复导入 API key 或登录 DeepSeek 官方账号。provider keys 仍在应用原生设置路径管理。真实数据库密码从产品外部本机密码文件传给服务进程；不要把它写入命令、`.env.example`、日志或 Git。

手机和电脑连接同一 Wi-Fi 时，手机访问本次选择的 Host 局域网地址 `http://<Host局域网地址>:3088`；Django `3090` 和 PostgreSQL `55432` 仍只监听 loopback。实体手机、当前候选 GUI、真实模型和 ERP 尚未验证；报价的单位、币种和利润口径待业务确认。

停止由该启动命令管理的实例：

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\stop-tradeloom.ps1 -DataRoot '<与启动时相同的绝对数据目录>'
```

普通窗口 X 只隐藏窗口；要结束应用，请使用应用菜单中的退出。不要用这些脚本关闭其他 DSH 实例。

如果启动故障对话框中选择“备份设置、禁用第三方插件并退出”，应用会退出而不会自行重启。之后请从织贸助手快捷方式重新打开。

## 配置和当前能力边界

- [`.env.example`](../.env.example) 是占位模板，不含真实密码或 API Key。provider keys 通过应用原生设置路径管理；无需 DeepSeek 官方登录。
- 真实 provider 的模型理解和工具调用，与 workflow 的 `local_mock`/`simulated_rules` 执行是分开的。当前本机已验证真实 DeepSeek Flash 的有限提案与只读工具调用，不代表整条 workflow 由真实 LLM 自动执行。
- ERPNext 默认未配置。管理员准备连接前，后端状态仍为未连接且不会访问 ERP 外部服务；普通桌面用户不需要安装 Linux、WSL、Docker 或 ERPNext。
- 窄屏网页视口通过过业务验收，实体手机尚未验收。p8 安装版未包含最近 source-mode 更新，且其历史首启问题仍待单独处理。

本机 GUI、专属 runtime、数据根与 runner 的历史启动证据见[本地启动入口核验](verification/2026-10-23-local-start-entry.md)、[验收矩阵](acceptance-matrix.md)及[工作报告](work-report.md)。这些记录不证明本轮候选已在运行，也不是实体手机、真实模型或 ERP 的验收证据。相关的[DSH 生态源码参考与采用边界](open-source-reuse.md)是固定提交的静态研究；[Intake live 只读一致性核查](verification/2026-10-24-intake-live-readonly.md)仅记录脱敏 GET/XML 核验。
