# N03 场景 profile 配置快照

本切片只支持一个已登记 scene 的 `sceneMemory.scenes[sceneId].profile` 配置快照。它用于备份、预览和由可信本地 controller 显式调用恢复，不代表 N03 的引擎、数据库或 SDK 配置已实现。sceneMemory 的 profile、handoff、progress、decisions 完整内容快照另见 [N03 scene memory snapshots](N03-SCENE-MEMORY-SNAPSHOTS.md)。

## 恢复范围

快照只包含以下 profile 字段：

```json
{
  "revision": 4,
  "responsibility": "示例职责",
  "assetRefs": [{ "kind": "artifact", "id": "catalog-current", "label": "目录" }],
  "primarySkill": "product-review"
}
```

恢复会把 `revision` 写成恢复时当前 revision 加一，而不是回滚到快照中的 revision。其他 scene 保持不变。`handoff`、`progress`、`decisions`、`operations`、`sessionScenes`、`bindingRevision`、`rotations`、角色绑定和未知 state 字段都不会从快照恢复。现有日志继续 append-only；N01 cursor 会因 profile revision 改变而失效。

## API

调用方必须用可信 catalog 创建 `createSceneMemoryStore(stateStore, { sceneIds, ... })`，并把明确的 `sceneId` 传给各方法。scene 不在该实例 catalog 中时返回 `scene_not_found`；没有 catalog 时返回 `scene_catalog_unavailable`。这些方法未注册为 AI 工具；本 worktree 没有生产 Host/controller 或 UI 确认接线。

```js
import { createStateStore } from '@tradeloom/dsh-business-shell/state'
import { createSceneMemoryStore } from '@tradeloom/dsh-business-shell/scene-memory'

const state = await createStateStore({ env })
const memory = createSceneMemoryStore(state, { sceneIds: trustedCatalogSceneIds })

const snapshot = await memory.captureSceneProfileSnapshot('sales')
const rows = await memory.listSceneProfileSnapshots('sales')
const envelope = await memory.exportSceneProfileSnapshot(snapshot.snapshotId, 'sales')

const cancelled = await memory.previewSceneProfileRestore(snapshot.snapshotId, 'sales')
memory.cancelSceneProfileRestore(cancelled.previewId, 'sales') // 取消路径不写 state

const restorePreview = await memory.previewSceneProfileRestore(snapshot.snapshotId, 'sales')
// 由可信 controller 在外部展示范围并取得真实确认后，才调用 restore。
const restored = await memory.restoreSceneProfileSnapshot(restorePreview.previewId, 'sales')
```

`capture` 返回元数据 `{ snapshotId, createdAt, kind, scope, sceneId, payloadSha256, status }`。`list` 返回该 scene 的元数据列表；无快照是空列表，损坏项只投影 `{ snapshotId, status: "invalid", errorCode }`。`export` 返回经过校验的完整 envelope。预览 DTO 为：

```json
{
  "previewId": "<随机 UUID>",
  "snapshotId": "<随机 UUID>",
  "sceneId": "sales",
  "scope": "tradeloom-scene-profile/v1",
  "sourceProfileRevision": 2,
  "currentProfileRevision": 4,
  "bindingRevision": 3,
  "changedFields": ["responsibility", "assetRefs"],
  "expiresAt": "<UTC ISO 时间，约 5 分钟后>"
}
```

成功恢复返回 `{ status: "restored", sceneId, profile, snapshot, backup, changedFields }`。取消只对同一 owned state store、同一 scene 且尚未开始 apply 的 preview 生效；恢复事务已开始时取消返回 `false`，不声称中断它。preview 是进程内一次性 CAS 凭据，不是人类确认凭据。

## 持久化与并发检查

文件位于 marker-owned home 下 `tradeloom-state/snapshots/scene-profile/<sceneId>/<snapshotId>.json`。Envelope 固定 `formatVersion: 1`、`scope: "tradeloom-scene-profile/v1"`、`sections/presentSections: ["scene.profile"]`，payload 为 `{ sceneId, profile }`；SHA-256 覆盖 scope、sections、presentSections、payload 的 UTF-8 JSON，用于损坏检测，不是来源签名。写入复用 state store 的 owned-path/reparse 检查、临时文件 `fsync` 和原子 rename，并读回校验。

恢复在原 `stateStore.transact` 队列内重新读取并验证 snapshot、profile revision/内容、当前 binding revision 与活动 rotation。`scene.rotations` 中任何非 `complete`/`abandoned` 操作都会拒绝恢复。CAS 只绑定该 profile 与当前 binding；其他 state 字段不会被快照覆盖。apply 前先生成 `kind: "pre-restore-backup"` 的当前 profile 备份并读回校验，再赋值恢复目标并走 state 原子提交。备份验证失败或 state rename 失败时，不会通过直接覆盖 state 文件绕开原事务；提交失败时，已验证备份仍保留。队列仅提供同 Node 进程内事务串行，不提供跨进程锁。

主要错误码：`scene_profile_state_unavailable`、`scene_profile_snapshot_unavailable`、`scene_profile_snapshot_invalid`、`scene_profile_snapshot_checksum_mismatch`、`scene_profile_snapshot_not_found`、`scene_profile_snapshot_id_invalid`、`scene_profile_snapshot_write_failed`、`scene_profile_snapshot_verification_failed`、`scene_profile_backup_write_failed`、`scene_profile_backup_verification_failed`、`scene_profile_restore_preview_unavailable`、`scene_profile_restore_preview_stale`、`scene_profile_snapshot_changed`、`scene_profile_revision_conflict`、`scene_profile_state_commit_failed`、`scene_rotation_in_progress`。不向调用者返回底层路径或异常文本。

## 验证边界

本轮的临时 marker-owned 文件测试验证 scene 隔离、状态字段保留、单调 revision、preview/cancel、profile/binding/rotation CAS、跨 store 凭据拒绝、损坏摘要、备份读回失败及 state 原子提交失败。它验证的是 Node state store/scene-memory 后端代码，不是生产 Host 接线、UI 确认、多进程锁、SDK、数据库或完整 N03 场景恢复。
