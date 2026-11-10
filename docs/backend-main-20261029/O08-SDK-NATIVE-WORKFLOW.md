# O08：真实 SDK 原生工作流链验收

## 结果

命令：`python testing/o08_postgres_native_workflow_acceptance.py`。PG 停启及原 adapter 重启回读证据见 [O08 PG 验收记录](O08-POSTGRES-NATIVE-WORKFLOW.md)。此集成驱动 `testing/o08_sdk_native_workflow_acceptance.mjs` 的 Postgres 模式，脚本以 JSON 收据报告 `ok: true`。验收覆盖原生 UI handler 的 `prepare → submit → get`、原 `workflow-native-tools`、`workflow-native-service`、`workflow-native-task-authority` 和 executor。rep4 编译 SDK 提供真实 Cordis Context、ToolRuntime、AgentLoop、Session、AgentPresetRegistry、Subagent manager、in-process spawn provider、官方 `tool-subagent` 工具及 JSONL session persistence。

成功收据要求并实际检查：SDK workflow submit ToolRun 成功并返回排队 runId；真实 `subagent` ToolRun 成功并返回 activation childId；child 的 start/end 事件各一次且 ID/runId 配对；本地确定性 LLM adapter 至少实际调用一次；从 SDK session query 读回 child Session header 并核对 `parentSession`；原生 run 和纯 AI 节点均为 `done`；持久 terminal event 的来源为 `subagent/end`，其 request、child、native run、parent agent、session 和完整输出一致；UI `get` 读回 done 状态。脚本对 drain 设置 18 秒上限；finally 会回收自身临时目录，并让 unregister/service/Context 清理失败导致验收失败。

首次真实执行揭示子代理服务要求 `ctx.sessionPersistence`：未挂载时 SDK 返回 `PERSISTENCE_UNAVAILABLE`，没有 child 事件，也没有模型调用。脚本随后挂载 rep4 自带的 `dsh-session-persistence-jsonl`，将日志根显式指向本次唯一临时目录，闭环才通过。settings 使用声明在同一临时根内的内存 no-op fixture；不加载用户 settings、profile 或默认数据目录。

工作流定义通过原 `workflow-engine` 文件 store 写入本次 O08 临时目录；仓库当前没有 Canvas workflow definition HTTP endpoint。原 `workflow-postgres` adapter 使用真实 loopback Django API 持久化 run，停机重启后按同一 runId 读回。

## 边界

测试使用本地确定性 ScriptAdapter，不调用外部模型。`readState`、workspace registry 和连接准入是测试 fixture；PG 集成使用真实 `workflow-postgres` adapter、Django HTTP API 和临时 PostgreSQL。SDK 子 Session 的 JSONL persistence 与 workflow 定义文件 store 是 rep4/原项目实现，只写入本次临时根。测试证明同一 Node Context 中的原 SDK/native workflow 组合和 run 的 PG 重启持久化，不证明生产 Host bootstrap 自动挂载、真实 Electron Main/GUI、真实网页、外部模型或生产 workspace/profile。O08 的真实 GUI/native 应用验收仍须单独进行，本报告不表示 O08 整体完成。

故障闭环（UI 取消、服务超时、本地 LLM 异常）的单独验收见[O08 真实 SDK 异常闭环](O08-SDK-NATIVE-WORKFLOW-FAULTS.md)。
