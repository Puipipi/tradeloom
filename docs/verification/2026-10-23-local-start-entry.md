# 本地启动与协作说明（2026-10-23）

本说明区分 DSH 原生桌面端和本仓库的 Django 网页工作台，并记录本地启动守卫的文件状态。它不证明当前桌面窗口已加载新代码，也不代表手机入口或重复点击的端到端行为已验收。

## 两种入口

- **DSH 原生桌面端**由 TradeLoom launcher 启动 Electron 桌面包，网页服务默认使用端口 3088。它与下方 Django 工作台是不同应用入口。
- **Django 网页工作台**按 README 中的 `start-postgres.ps1`、`start-workbench.ps1` 启动，工作台/API 默认使用 `127.0.0.1:8000`，双 Agent 测试页使用 `127.0.0.1:8010`。这些命令不会启动 DSH 桌面包。

仓库 `scripts/launch-tradeloom.ps1` 是源码 launcher 包装脚本：它从 PATH 选取 `node.exe`，收集本次网络候选，再运行仓库的 `apps/tradeloom-launcher/cli.mjs`；支持 `-Mode desktop|web`、`-DataRoot`，现在也支持可选 `-Runtime`。仓库 CLI 默认 runtime candidate 是 `0.2.1-rc.2-tradeloom-desktop-2`；已审阅的本机桌面候选是 `0.2.1-rc.2-tradeloom-desktop-8`，且使用独立的 owned DataRoot。使用后者时，协作者须将本机确切路径放入变量并通过包装脚本显式传入两项：

```powershell
$runtime = '<本机受控 desktop-8 runtime 的绝对路径>'
$dataRoot = '<本机已标记为 TradeLoom 所有的 DataRoot 绝对路径>'
powershell -NoProfile -File .\scripts\launch-tradeloom.ps1 -Mode desktop -Runtime $runtime -DataRoot $dataRoot
```

这些占位符必须替换成该机器已确认的路径；不要把本机路径、凭据或业务数据写入仓库。包装脚本负责提供真实的本次网络候选；直接调用仓库 CLI 时还必须自行提供有效的 `--host`/`--candidates`，不能照抄上方包装脚本命令。省略 `-Runtime` 时保持仓库原有默认候选行为。桌面 launcher 还要求其专用 Python 环境及桌面包文件已准备；源码包装脚本不负责启动 PostgreSQL，因此运行它之前须确认相应 owned PostgreSQL 实例已就绪。私有本地控制器另有受控流程，由它管理其专属 PostgreSQL 生命周期。

## 本机启动守卫状态

`apps/tradeloom-launcher/local-start-guard.mjs` 为同一个规范化 home 目录提供跨进程启动互斥。私有 DSH 控制器的启动副作用现在在互斥范围内执行，停止回调不取得启动锁；控制器退出时等待异步最终状态记录完成后才释放锁。当前工作树中的桌面候选源码文件已按此接入；本次只更新了文件，没有执行应用或控制器的启停，也没有进行热加载。

文件级证据：本次更新保存了旧控制器副本，提案精确替换后的 SHA-256 为 `747f8b9bff44ca1a1dd317b621dd7a049cbbdd7168f9115c2a3cb522fb505335`，Node 24.21.0 `--check` 退出码为 0，模拟控制器测试为 3/3、退出码为 0。模拟测试覆盖停止回调、锁保持到子进程关闭与最终记录完成、启动记录失败时仍等待子进程关闭。PowerShell 启动包装器回归测试退出码为 0，使用合成网络接口、临时仓库和只记录参数的 fake CLI；覆盖 runtime 路径含空格、保留默认候选、旧第三位置 ERP 参数，以及空值、引号、换行、相对和不完整 Windows 路径被拒绝。之前对守卫与核心模块的 7 项和 22 项测试证据仍对应未变更源码；本次没有重跑它们。

主控在 2026-10-23 03:01:19Z 的只读 TCP 监听查询中，对端口 3088、3090、55432、55435 均未发现监听。这只是该时点、这些端口的观测，不判断其他进程状态或窗口状态；该历史观测之后的启动情况见下方独立记录。

本记录前半部分记录私有控制器文件和模拟源码测试；运行时冷启动及 HTTP readiness 另见下节。这里没有检查本机 DSH 窗口、桌面入口点击或手机界面，也没有确认或创建 Windows 桌面快捷方式。

## 运行时冷启动（2026-10-23 03:27Z）

- 根代理复核授权后，通过已审计的私有控制器对其 owned DataRoot 执行了一次隐藏冷启动。控制器启动前确认 PG17 DataRoot 所有权标记、Node 24.16.0、控制器 SHA-256 与目标端口状态；PostgreSQL 仅使用自有 55432 端口，测试端口 55435 未启动。PG17 按正常 `pg_ctl start` 流程处理先前观察到的 `postmaster.pid`；没有手动改动 PID 文件、WAL、配置或数据。
- 就绪后，PG 的 `pg_isready` 通过；受管 PostgreSQL、Django 和 Electron 分别拥有本地数据库、Django 与 DSH 监听。五项只读 HTTP readiness GET 全部通过；记录的来源计数为 1，未读取来源正文，未写入 annotation。未运行迁移、导入、业务写入或模型调用。
- 对同一控制器再调用一次 `start`，启动 guard 返回 exit 1 与“此 app home 正在启动。”。前后控制器状态文件哈希与已核对的进程身份相同，监听归属未变，55435 仍无监听。该检查证明同一生命周期内 guard 拒绝重复调用，不证明桌面点击、焦点或界面表现。
- 本节只记录源码级与 HTTP/进程级运行证据。桌面窗口视觉、用户实际点击与手机界面仍需独立验收；本节不声称这些能力已验证，也不确认存在 Windows 桌面快捷方式。
