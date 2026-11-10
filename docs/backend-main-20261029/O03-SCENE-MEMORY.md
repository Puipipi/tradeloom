# O03 后端场景记忆切片

本候选实现 O03 的后端场景记忆部分，不代表完整 O03 或 O04 已完成。需求是按稳定场景保存职责、资产入口、主技能入口、当前交接、进度和长期决策；新 session 只能读它所绑定场景的交接。场景 ID 必须来自可信场景目录，不能从 role/preset 或 session lineage 推断。

## 模块与存储

`packages/tradeloom-shell/scene-memory.js` 导出：

```js
import { createStateStore } from '@tradeloom/dsh-business-shell/state'
import { createSceneMemoryStore } from '@tradeloom/dsh-business-shell/scene-memory'

const state = await createStateStore()
const memory = createSceneMemoryStore(state, {
  sceneIds: trustedSceneCatalog.map(scene => scene.id),
  verifySession: async ({ sceneId, sessionId }) => trustedHostSessionIsCurrent(sceneId, sessionId),
})
```

`sceneIds` 必须由可信 Host/controller 提供；空目录时配置/查找返回 `scene_catalog_unavailable`，未知 ID 返回 `scene_not_found`。`verifySession` 必须查询真实活动 Host session；缺失或非字面 `true` 时绑定失败。未来 Host composition 的最小调用形状如下；其中 `trustedSceneCatalog`、`lookupLiveHostSession`、`currentSceneForSession` 是 Host 必须提供的真实服务依赖，本 worktree 未实现或伪造这些服务：

```js
import { registerBusinessTools } from '@tradeloom/dsh-business-shell/business-tools'

const memory = createSceneMemoryStore(await createStateStore(), {
  sceneIds: trustedSceneCatalog.map(({ id }) => id),
  verifySession: async ({ sceneId, sessionId }) => {
    const session = await lookupLiveHostSession(sessionId)
    return session?.id === sessionId && currentSceneForSession(sessionId) === sceneId
  },
})
const unregister = registerBusinessTools(ctx, { preset: thisPluginPreset }, { sceneMemory: memory })
```

不能把验证回调替换成 `() => true`，不能从工具参数接收场景或 actor。当前 worktree 没有把真实场景目录、Host session producer 或 configure/bind 调用接入生产 Host；这段示例是明确的 composition seam，不是已接线代码。

数据经现有 `createStateStore.read/transact` 存在 owned `tradeloom-state/state.json` 的 `sceneMemory` 命名空间，使用该 store 的序列化写队列和原子替换。每个场景保存 `profile`、单条当前 `handoff`、独立 `progress`/`decisions` 列表及幂等操作索引；`sessionScenes` 保存可信绑定。每个场景最多一个活动 session，一个 session 不能同时绑定多个场景。绑定按 `expectedSessionId` 比较更新；重绑后旧 session 立即失去读取/写入权限，新 session 可读同一场景交接。此写队列是本地进程级机制，不承诺跨进程锁。

持久 `sceneMemory` 当前写为 version 2：每场景 `handoffRevision` 是独立于交接内容记录 revision 的单调 CAS counter；progress/decision 的 `journalOperations` 保留来源和 SHA-256 幂等指纹。version 1 可只读兼容；首次成功写入升级前会把原 namespace 写入并验证 owned migration backup。完整单 scene 内容快照与恢复见 [N03 scene memory snapshots](N03-SCENE-MEMORY-SNAPSHOTS.md)。

`SCENE_MEMORY_SCOPE` 继续标记既有工具 DTO；它不表示持久存储仍是 v1。完整快照方法是可信 controller API，不新增业务工具。迁移备份失败使用 `scene_memory_migration_backup_failed` 或 `scene_memory_migration_backup_unavailable`，状态内容不会提交。

不覆盖 `roles`、`roleBindingRevisions`、预算、session 创建/幂等台账或未知 state 字段。N03 state-config snapshot 只选择 `userProfile`、`sceneWorkbench`、`dockLayouts`；sceneMemory 有独立的 profile-only 与完整内容快照切片，但都不包含 SDK profiles/sessions、引擎、业务数据库或全部 N03 数据域，不得把它们当完整 N03 导出/恢复。

## API 与错误

- `configureScene({sceneId, expectedRevision, responsibility, assetRefs, primarySkill})`：仅供可信 Host/controller 配置；CAS 递增 profile revision。`responsibility`/`primarySkill` 可为 `null`；`assetRefs` 仅允许 `{kind:'business-route'|'artifact'|'skill', id, label?}`。这些是引用元数据，不读取任意路径或证明资产存在。
- `bindSession({sceneId, sessionId, expectedSessionId})`：先检查当前绑定 CAS，再调用 `verifySession({sceneId,sessionId})`；绑定成功后，原活动 session 失权。
- `readForSession(sessionId, {progressOffset=0, decisionOffset=0, pageSize=25})`：由 session 索引推导场景，返回 `{scope,sceneId,sessionId,profile,handoff,handoffRevision,progress,decisions,pagination,profileStatus,handoffStatus}`。`handoffRevision` 即使在 handoff 为 null 时也可用于 CAS。`pageSize` 为 1–100，两个 offset 为非负安全整数；超出末尾返回空数组。`pagination` 各列表包含 `{offset,total,hasMore,nextOffset}`，可按 `nextOffset` 继续读取。存储保留全部合法记录，不做数量截断；返回页受 pageSize 限制。未配置 profile 是 `not_configured`，没有交接是 `handoffStatus:'missing'`，不生成默认场景内容。
- `updateHandoff({sessionId,operationId,expectedRevision,text})`：仅覆盖当前交接，`expectedRevision` 对照单调 `handoffRevision` counter；内容记录仍带真实来源 session、当前记录 revision、时间和 operation ID。同 operation ID/同内容重试返回其历史 revision 与 `replayed:true`；恢复过往 snapshot 后需先重新读取当前 counter，复用 ID 改内容仍拒绝。
- `appendProgress({sessionId,entryId,text})` 与 `appendDecision({sessionId,entryId,text})`：分别追加到两个集合；同 ID/同来源/同内容幂等，冲突拒绝。
- `readConfiguredSkill(sessionId, skillService, execution)`：只读该 scene 已配置的 skill 名称，通过当前 agent scoped `skills.snapshot/get` 按需加载；不会接受调用参数指定的 skill/path。未配置返回 `not_configured`，目录中不存在/不可调用返回 `missing`，服务缺失返回 `unavailable`；加载期间配置 revision、绑定或 abort 变化时拒绝返回旧正文。

可识别的稳定错误码为：`invalid_arguments`、`scene_catalog_unavailable`、`scene_not_found`、`scene_memory_invalid`、`scene_session_unavailable`、`scene_session_unverified`、`scene_binding_conflict`、`scene_session_conflict`、`scene_session_not_bound`、`scene_revision_conflict`、`scene_idempotency_conflict`、`scene_binding_changed`、`scene_skill_changed`、`tool_cancelled`。工具输出沿用既有包装：`{ok,data,requires_human_confirmation,business_ui_url,error_code}`，其中 `data` 是对应 allowlisted DTO 的 JSON 字符串；未知内部错误映射为 `scene_memory_unavailable`。

## Business tools 接口

仅当可信 composition 显式把 `sceneMemory` 依赖传给现有 `registerBusinessTools(ctx, config, {sceneMemory})` 时才注册以下工具。没有该依赖时不注册；现有 `apply(ctx, config)` 尚未装配此服务。工具从真实 `exec.agent.session.id`、preset 和 Host `ctx.agents.get(agent.id) === agent` 校验身份，参数不接受 actor/session/scene 字段，并沿用逐工具 `TOOL_ACCESS` preset allowlist。

| 工具 | 输入 | 结果 |
|---|---|---|
| `tradeloom_scene_context` | `{progress_offset?, decision_offset?, page_size?}` | 场景 DTO；每个列表默认最多 25、最多 100 条，并返回 `pagination` 元数据 |
| `tradeloom_scene_skill` | `{}` | 已配置技能的按需读取状态与正文 |
| `tradeloom_scene_handoff_update` | `{operation_id, expected_revision, text}` | `{sceneId,revision,replayed}` |
| `tradeloom_scene_progress_append` | `{entry_id,text}` | `{sceneId,entryId,replayed}` |
| `tradeloom_scene_decision_append` | `{entry_id,text}` | `{sceneId,entryId,replayed}` |

最小读取示例：首次调用 `tradeloom_scene_context` 后，分别读取 `pagination.progress.nextOffset` 和 `pagination.decisions.nextOffset`；后续调用仅传 `progress_offset`、`decision_offset`、`page_size`，不得传 scene/session/actor。最小写入示例：读取当前交接 revision，再以新的稳定 `operation_id` 调用 `tradeloom_scene_handoff_update`，随后重新读取确认。换 session 由可信 controller 调 `bindSession`，新 session 再调用 context；不通过伪造旧 session 或 role/preset 复用另一场景数据。记录不会按数量静默截断；单次读取通过有界分页控制返回量。

## 验收与未覆盖边界

`tests/scene-memory.test.js` 使用新建 marker-owned 临时 home 验证真实 state 文件写入/重开、同 role 不同 scene 隔离、重绑后的旧 session 拒绝、交接幂等/冲突、进度与决策分离、超过 1000 条仍可追加且有界分页、持久记录 ID 的严格字符串校验、技能按需读取与失效拒绝（包括 get 返回 missing 时的配置复核、preset 变更时的已加载正文丢弃）、真实 `registerBusinessTools` execute 的身份/参数边界，以及原子替换失败保留旧状态。skills、Host session registry、scene catalog 和 `verifySession` 是测试 fixture；本切片未运行真实 AgentLoop、Host/bootstrap、场景 UI、native session creator，也未接入用户 UI 的配置/交接编辑器。

O04 的后端轮换控制器候选单列在 [O04 scene rotation](O04-SCENE-ROTATION.md)，并有隔离文件测试和 rep12 SDK 组合验收；它尚未接入生产 Host、用户确认对话框或新界面，本切片没有轮换任何现有用户 session。O04 的非终态操作会阻止该场景重新绑定；可信 controller 可显式将已 settle 的失败操作置为 `abandoned` 以释放该预留，但这不删除/归档 SDK session、不回滚绑定，也不表示轮换成功。N03 的完整配置、引擎、数据备份/恢复范围仍未完成。没有配置时返回明确 missing/not-configured 状态，不填充模板或合成技能/资产内容。
