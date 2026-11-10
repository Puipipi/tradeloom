# O08：真实 SDK 工作流与 PostgreSQL 重启读回

## 最终运行

在独立 main 仓库根目录运行：

```powershell
python testing/o08_postgres_native_workflow_acceptance.py
```

最终运行 exit 0，顶层回执为 `ok: true`，临时根清理后不存在。脚本创建唯一临时 PostgreSQL cluster/database 和 Django 服务，执行仓库 migration；随后启动一次 [O08 SDK 驱动](../../testing/o08_sdk_native_workflow_acceptance.mjs)，由 rep4 真实 Cordis/AgentLoop/ToolRuntime/subagent 完成一个纯 AI 节点。runStore 是原 [workflow-postgres adapter](../../packages/tradeloom-shell/workflow-postgres.js)，走原 `requestBusinessJson` 默认 loopback HTTP 请求和 Django 的 `/api/canvas-workflow-runs`，不是内存 runStore 或手工插入 snapshot。

本次端口状态：PG 初次启动 `pg_ctl status=0`，首轮正常停止后 `=3`，同一数据目录重启后 `=0`，最终清理后 `=3`。PostgreSQL 与 Django 在执行完成后均先停止，再重启并由原 adapter GET 读取同一 run。实际 runId 为 `1b976682-ea90-7da6-7578-55f0bbd07d44`，重启前后 revision 均为 4；run 与节点均为 `done`，attempt 为 1，terminal event 仅一条且 source 为 `subagent/end`。childId、nativeRunId、requestId、parent/session 身份与完整输出在两次读取间相同。重启读回走 `readback-only` 分支，不创建 SDK Context、不调用 LLM，也不重新派发工作流。

## 隔离与清理

PG 数据、日志、Django 输出和临时数据库均放在本次新建的 `%TEMP%/tl-o08-pg-*` 下。脚本复用打包的 PG/Python 二进制；使用新数据库、loopback 动态端口和进程内生成的 synthetic bridge key。key 只通过子进程环境交给这次 Django/Node 测试，不写入日志或回执。`pg_ctl` 输出直接写入本次普通日志文件，避免后台进程继承捕获管道。finally 只检查/停止传入本次 data directory 的 cluster、停止本次 Django 子进程，并在确认服务已停后删除该临时根。

## 证据边界

- 实际执行链为 rep4 SDK AgentLoop、ToolRuntime、subagent、in-process spawn、真实 child Session 和本地确定性 ScriptAdapter；原 native UI/service/authority/executor 通过真实 SDK ToolRun 和 terminal receipt。
- workflow run 的写入及重启回读经过真实 PostgreSQL、Django HTTP、ORM 和原 JS adapter。child Session 持久化由 rep4 JSONL provider 写在该次 Node 执行的另一唯一临时根中。
- workflow definition 使用原 `workflow-engine` 文件 store 保存到 Node 临时根；现有 Django 路由提供 run persistence，没有 Canvas workflow definition HTTP API。因此定义没有手工插入 PG。
- `readState`、workspace registry、连接准入与 role/session binding 是测试 fixture；settings 是声明了临时路径的内存 no-op fixture。没有读取用户 settings、profile、运行数据或 credentials。
- 本验收不启动生产 Host，不验证生产 host bootstrap 的恢复接线、真实 Electron Main/GUI、真实 workspace、网页或外部模型。它证明原生 SDK/workflow 在单一测试 Node Context 中完成，并证明原 PG adapter 对完成 run 的停启持久化；不表示 O08 整体验收完成。

脚本：[testing/o08_postgres_native_workflow_acceptance.py](../../testing/o08_postgres_native_workflow_acceptance.py)。
