# O09 临时 PostgreSQL 重启验收

本记录覆盖一次隔离测试：真实 PostgreSQL 与 Django HTTP API，真实 JS PostgreSQL adapter 和 journal；节点执行观察是合成输入，不是 Host 或原生 SDK 执行。

## 最终通过运行

在独立 main 仓库根目录执行：

~~~powershell
$pkg = Join-Path $env:TEMP 'tlr4p/targets/win-x64/unsigned-artifacts/win-unpacked/resources/tradeloom/python-packages'
$env:PYTHONPATH = "$pkg;C:/Users/23825/.codex/worktrees/backend-main-20261029/tradeloom"
& (Join-Path $env:TEMP 'tlr4p/targets/win-x64/unsigned-artifacts/win-unpacked/resources/runtime/primary-runtime/dependencies/python/python.exe') testing/o09_postgres_restart_acceptance.py
$code = $LASTEXITCODE
Remove-Item Env:PYTHONPATH
exit $code
~~~

最终退出码为 **0**。脚本创建独立临时集群和数据库，迁移现有 Django 模型，通过真实 loopback HTTP 使用 JS adapter 与 journal 建立记录，然后正常停止并重启 PostgreSQL 与 Django，再调用 journal 恢复。

本次数据位于 C:\Users\23825\AppData\Local\Temp\tl-o09-pg-uofpx1at\pgdata，数据库为 tradeloom_o09_6167c28d5e64；PostgreSQL 端口 63780，Django 端口 63781。验收 run ID 为 0573c47c-4ff8-457e-8562-97f28576a638。逐字段结果见 [脱敏证据 JSON](O09-POSTGRES-RESTART.evidence.json)。

恢复后 run 状态为 interrupted；done_node 仍为 done，active_node 变为 interrupted，unknown_node 保持 unknown。inspectResume 将已完成节点列为 completedNodeIds，不列入 eligible；active 与 unknown 节点都被阻止，resumeEligible 为 false。这是对持久化输入及恢复/筛选逻辑的验收，不能据此声称真实 native 执行不会重发。

测试输入由脚本通过 journal 状态接口合成：一个完成观察、一个已确认但未结束的活动尝试、一个抛错后记为 unknown 的尝试。没有启动模型或原生子任务。

## 首轮启动问题与回收

首次运行退出码为 **1**：pg_ctl start 后台启动的 PostgreSQL 继承了捕获管道，脚本等待管道关闭并在 60 秒后超时。日志确认该次自有 PostgreSQL 已就绪。随后只针对该次数据目录执行 pg_ctl status 和正常 pg_ctl stop；停止成功，脚本改为将启动器输出写入普通文件，并在 finally 中只检查、停止该测试自己的数据目录。

最终通过运行结束后，PostgreSQL 与 Django 均已正常停止。本批两个临时集群的 pg_ctl status 最终检查都返回 **3**（无 server running）：首次目录 tl-o09-pg-pjc5o1c2，最终目录 tl-o09-pg-uofpx1at。首轮已就绪时的 pg_ctl status 返回 **0**，随后针对该目录的正常停止返回 **0**。

## 验收边界

- workbench 模型与 API 在临时 PostgreSQL 上迁移并提供真实 HTTP 持久化；adapter 使用默认 HTTP 请求实现，未注入内存 Map 或模拟 HTTP server。
- 没有验证 artifact 注册、可信文件来源或 artifact 与 run 的真实字节关联。
- Host 启动时自动调用恢复的接线仍缺；本次直接调用 journal 的恢复入口。
- 没有验收 GUI、真实 Host 生命周期、原生 SDK 子任务、模型执行或打包环境运行。
- O09 不标记为整体完成；共享任务清单未修改。

脚本位置：[testing/o09_postgres_restart_acceptance.py](../../testing/o09_postgres_restart_acceptance.py)。