# N01：单场景记忆图谱与目标解析

本候选提供 O03 场景记忆的只读图形投影，以及对现存节点的目标解析。它不是 SDK 全局知识图谱，不从文本推理语义关系，也不读取其他场景、session 日志、资产文件或技能正文。

## 来源与边界

实现位于 `packages/tradeloom-shell/scene-memory-graph.js`，由 `scene-memory.js` 对外提供 `readGraphForSession` 和 `resolveGraphTarget`。每次调用只读取一次 owned state；session 必须已经通过 `sceneMemory.sessionScenes` 绑定到可信 scene，当前数据与绑定从同一个 state 快照解析。场景目录和 live-session 验证仍由创建 `createSceneMemoryStore` 的受信 Host composition 提供。

图节点只来自该 scene 已保存的数据：`scene`、`profile`、`asset_ref`、`skill_ref`、`session_binding`、`handoff`、`progress`、`decision`。`asset_ref` 与 `skill_ref` 是配置引用，不证明目标文件或技能当前存在；技能正文仍只能由 O03 的按需技能读取方法取回。handoff、progress、decision 的 `sourceSessionId` 是真实记录来源；旧来源与当前 target 分开表达。关系只表示当前 scene 对 profile/binding/handoff/journal 的真实归属，以及 profile 对已配置引用的包含关系。资产引用节点 ID 使用 `[sceneId, kind, id, occurrence]` 的 JSON 输入计算确定性 SHA-256，因此长度固定且不会因长 Unicode 或 JSON 可表示的孤立代理项导致 URI 编码失败；原始引用仍完整保存在 `data.id`。该哈希只用于节点标识，不是内容完整性证明或授权凭据。

## 读取 API

```js
const page = await sceneMemory.readGraphForSession(trustedSessionId, {
  text: '报价',             // 可选，字面子串，最多 1000 字符
  kinds: ['handoff'],       // 可选：scene/profile/asset_ref/skill_ref/session_binding/handoff/progress/decision
  pageSize: 25,             // 可选，1–100，默认 25
  cursor: pageToken,        // 可选，上一页 nextCursor
})
```

首屏 DTO 形状示例（内容为合成示意，不是运行输出）：

```json
{
  "scope": "tradeloom-scene-memory-graph/v1",
  "status": "available",
  "target": { "sessionId": "session-current", "sceneId": "scene-sales", "bindingRevision": 4 },
  "nodes": [{
    "id": "handoff:scene-sales:2", "kind": "handoff", "label": "继续核对报价",
    "source": { "scope": "sceneMemory", "record": "handoff", "sceneId": "scene-sales", "recordId": "2", "sourceSessionId": "session-prior" },
    "data": { "revision": 2, "text": "继续核对报价", "updatedAt": "2026-10-31T00:00:00.000Z", "operationId": "handoff-2" }
  }],
  "contextNodes": [{ "id": "scene:scene-sales", "kind": "scene", "label": "scene-sales", "source": { "scope": "sceneMemory", "record": "scene", "sceneId": "scene-sales" }, "data": { "sceneId": "scene-sales" } }],
  "edges": [{ "id": "edge:scene-sales:handoff:scene-sales:2", "source": "scene:scene-sales", "target": "handoff:scene-sales:2", "kind": "current_handoff" }],
  "pagination": { "pageSize": 25, "offset": 0, "totalMatches": 1, "hasMore": false, "nextCursor": null }
}
```

`totalMatches` 只计符合字面搜索和 kind 筛选的节点；为解释当前页边关系附带的 `contextNodes` 单独列出，不计入匹配数量。`contextNodes` 包含被选节点所需的真实祖先；返回的 `edges` 是这些可见节点之间原图关系的诱导边集合，例如只筛出资产节点时仍能看到 `scene → profile → asset_ref` 完整路径。无匹配时返回 `status: "empty"`，且 `nodes`、`contextNodes`、`edges` 都为空；这与未绑定或损坏状态不同。

游标是不透明的 base64url continuation snapshot，不是授权凭据。它绑定 session、scene、binding/profile/handoff revision、首屏 progress/decision 总数及原查询；后续调用仍重新验证当前 session 绑定。绑定变化（包括 A→B→A）、profile/handoff 变化会以 `scene_graph_snapshot_changed` 拒绝旧页。progress/decision 是 O03 append-only 记录：旧游标继续使用首屏记录前缀并排除后来追加的行，刷新首屏才会看到新增记录；若当前记录数小于游标捕获总数则拒绝，避免读取不完整快照。页大小最大 100；调用方需将 `pagination.nextCursor` 原样带到下一次调用。

## 解析已选节点

```js
const result = await sceneMemory.resolveGraphTarget(trustedSessionId, {
  nodeId: selectedNode.id,
  expectedTarget: graph.target,
})
```

结果返回 `selected` 的当前节点投影、当前 `target`，以及可选 `referenceSessionId`。`expectedTarget` 只是防止旧选择误用的比较条件；实际 target 总从当前可信绑定重算。历史来源 session 不会成为新 target。此方法只解析，不切换 session、不创建 session、不发送消息，也不执行图节点动作。

## 已注册的只读工具

现有 `registerBusinessTools(ctx, config, { sceneMemory })` 在显式注入 `sceneMemory` 时注册以下工具；不注入就不注册：

| 工具 | 参数 | 行为 |
|---|---|---|
| `tradeloom_scene_graph` | 可选 `text`, `kinds`, `page_size`, `cursor` | 读取当前执行 session 绑定场景的一页图谱 |
| `tradeloom_scene_target_resolve` | `node_id`, `expected_target:{session_id,scene_id,binding_revision}` | 对一个当前存在的节点执行只读解析 |

工具 actor 从 SDK `exec.agent`、其 session 与 preset 导出，并核对 `ctx.agents.get(agent.id)` 仍是同一活 agent；参数不能指定 actor/session。异步读取结束后再次核对身份；若期间 actor 失效，不返回已读取内容。成功工具结果沿现有包装返回 `{ok:true,data:"<JSON string>",requires_human_confirmation:false,business_ui_url:"",error_code:""}`；失败返回 `ok:false` 和固定 `error_code`。

## 错误

| code | 意义 |
|---|---|
| `invalid_arguments` | 查询、kind、游标或 target precondition 格式不合法 |
| `scene_catalog_unavailable` / `scene_not_found` | 场景目录未注入或当前已绑定 scene 不在允许目录 |
| `scene_session_unavailable` / `scene_session_not_bound` | session ID 无效或没有当前可信 scene 绑定 |
| `scene_memory_invalid` | owned scene-memory 数据校验失败 |
| `scene_graph_cursor_invalid` | 游标格式无效，或当前页 offset 已越过结果 |
| `scene_graph_snapshot_changed` | continuation 的身份/版本已变化，或当前 journal 数量少于游标捕获前缀；追加记录不触发此错误 |
| `scene_graph_node_not_found` | 指定节点不属于当前绑定 scene 的现存图 |
| `scene_graph_target_changed` | expected target 与当前可信绑定不符 |
| `host_identity_unavailable` | 注册工具的真实 actor 不存在、已替换或已失效 |
| `tool_cancelled` | SDK execute signal 已取消 |

## 证据与未接线范围

`tests/scene-memory-graph.test.js` 覆盖 marker-owned 临时 state 的只读字节不变、scene 隔离、稳定节点/边端点、空结果、literal/kind/page；append 后旧游标沿用原前缀分页、刷新查询看到新增记录，profile/handoff/binding 变化拒绝旧游标；也覆盖历史来源与当前 target 分离、损坏/未绑定错误分型，以及注册工具回调遇 actor 丢失和伪造 target 时拒绝。`tests/scene-rotation-sdk.test.js` 还在 rep12 的真实 Cordis/SessionController/AgentLoop testkit/SessionStore/JSONL/SQLite WorkspaceRegistry 组合中，验证轮换得到的新 SDK session 可读取原场景 handoff 图节点，且 target 是新 session、source 仍指向旧来源。

其中图谱文件测试的 state、scene catalog、session 验证器与业务工具 ctx 是显式测试 fixture；O04 组合中的 SDK 对象是真实 rep12 源树类，但测试套件/本地 adapter 仍为测试组合，无模型请求。没有真实生产 Host 注入 `sceneMemory`、scene catalog/session producer、UI 图谱或目标操作器；不证明 packaged Host、GUI 或 O03/N01 整体完成。
