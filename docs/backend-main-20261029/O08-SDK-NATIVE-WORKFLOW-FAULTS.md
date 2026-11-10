# O08：真实 SDK 异常闭环验收

## 结果

命令：`node testing/o08_sdk_native_workflow_faults.mjs`。运行器串行调用原 `o08_sdk_native_workflow_acceptance.mjs`，使用同一 rep4 SDK、真实 Context/ToolRuntime/AgentLoop/Session/Subagent manager 和本地确定性 ScriptAdapter；每个子场景最长 19 秒。三种结果均由外层断言 SDK 子代理 start/end、父子关系、单次 attempt、非成功节点/无 artifacts、active child 清理及 workflow 真实状态，不手动发送生命周期事件。

- **UI 取消**：调用原生 UI cancel handler。收到 `abortRequested=true`、`intentPersisted=true`、`settled=false`；真实 child 观察到 signal，`subagent/end.stopReason=aborted`；run/node 为 `interrupted`，journal 有一个 `node-interrupted`，attempt 为 1。
- **服务超时**：service deadline 为 2500 ms。真实 child stream 观察到 abort，并最终由 SDK 发出一次 `subagent/end.stopReason=aborted`。executor 在其期限内没有取得配对 terminal proof，按原实现记录 `attempt-unknown/SUBAGENT_TERMINAL_TIMEOUT`；run 为 `interrupted`、node 为 `unknown`、attempt 为 1。测试只把外层观察到的迟到 child end 作为 SDK 清理证据，不把它提升为 journal 已确认的终态。
- **本地 LLM 异常**：ScriptAdapter 抛出 `O08_TEST_LLM_FAILURE`。SDK child 以 `stopReason=error` 结束；原 workflow 记录一个 `node-error`，run/node 为 `failed`，没有 done 或 artifacts。

## 边界

以上为原项目 SDK 与原 workflow handler/service/executor 在同一测试 Context 中的异常验收。LLM 使用确定性本地脚本；测试只用内存 runStore 和隔离临时 Session/settings/workspace，不启动 PG、GUI、Host bootstrap、真实网页或外部模型。超时的 journal 结果仍是 unknown；这不是 O08 整体完成，也不证明生产 Host 的自动恢复、真实 Electron/DOM 或外部模型行为。成功路径及 PG 重启读回分别见[正向验收](O08-SDK-NATIVE-WORKFLOW.md)与[PG 验收](O08-POSTGRES-NATIVE-WORKFLOW.md)。
