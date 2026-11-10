# N03 后端状态快照切片

本候选只实现 N03 的一个后端状态域：现有 owned home 下 `tradeloom-state/state.json` 的配置/布局分区。任务清单原范围还包括界面、引擎及数据快照与分层回退；本切片不代表 N03 整体完成。

## 现有状态存储约定

`packages/tradeloom-shell/state.js` 的 `resolveOwnedHome(env)` 要求显式绝对路径 `TRADELOOM_DSH_APP_HOME === DSH_HOME`，并验证 `.tradeloom-owned` marker 和路径没有 reparse point。`createStateStore({ env })` 在该 home 的 `tradeloom-state/state.json` 读写。现有 `read()` 接受 state version 1，归一化角色绑定 revision，给缺失的 `dockLayouts` 补 `{ version: 2, scenes: {} }`；它没有完整验证各配置区块的嵌套业务 schema。

现有 `transact(mutator)` 通过模块内按绝对 state 路径串行的队列读改写；临时文件用 `wx`、权限模式 `0600`、`fsync`，再 `rename`，Windows 对 `EPERM`/`EBUSY` 作有限重试。队列只保证同一 Node 进程内的串行化，不提供跨进程锁。

## 支持范围

快照 scope 固定为 `tradeloom-state/config-layout-v1`，支持分区：

- `userProfile`：必须是对象；内容按 JSON 保存。此区可能含用户笔记，快照及导出数据应按敏感本地状态处理。
- `sceneWorkbench`：对象或 `null`。
- `dockLayouts`：对象，必须有 `version: 2` 与对象型 `scenes`。

当前代码树中对这三个分区只找到 `initialState()` 与 `dockLayouts` 旧版默认值写入，没有定位到更深的 backend writer/schema；因此分区内部除上述由当前默认值/存储代码证明的形状外，不宣称有完整 panel/config schema 验证。缺失分区会通过 `presentSections` 精确保留其“缺失”状态。

`roles`、`roleBindingRevisions`、`budgets`、`sessionCreateOperations`、`pendingSessionCreateByRole` 及其他 state 字段不进入恢复 payload；恢复时保留事务中读取到的当前值。`transact` 会按原逻辑重算角色 revision；因为角色绑定未改，其 revision 保持不变。

此 scope 不包含 SDK profile/config、模型或引擎密钥、业务数据库、O09 workflow/run 历史及附件/交付物。当前 backend worktree 没有 `host.js` 或 UI 确认入口：本 API 仅供可信本地调用方组合，未形成 Host route 或界面；`restoreSnapshot` 不注册为 AI tool，也没有 `confirmed: true` 之类可由调用者伪造的人类确认标记。调用方必须展示 preview，并只在自己的可信确认流程完成后调用恢复。

## Store API

```js
import { createStateStore } from '@tradeloom/dsh-business-shell/state'

const store = await createStateStore({ env })
const snapshot = await store.captureSnapshot()
const exported = await store.exportSnapshot(snapshot.snapshotId) // 含 payload；仅可信本地调用方可读
const rows = await store.listSnapshots()                         // 元数据，不含 payload
```

取消路径只创建并丢弃预览，不写当前 state；该 preview 丢弃后不能再用于恢复：

```js
const cancelledPreview = await store.previewRestore(snapshot.snapshotId)
await store.cancelRestorePreview(cancelledPreview.previewId)
```

恢复路径必须另行取得一份新的预览。可信 Host controller 应在外部完成影响展示和真实确认后，才显式调用 `restoreSnapshot`; store 本身不验证或伪造人类确认：

```js
const restorePreview = await store.previewRestore(snapshot.snapshotId)
// trusted controller presents the preview and obtains the actual user decision here
const restored = await store.restoreSnapshot(restorePreview.previewId)
```

`captureSnapshot({ scope })` 只接受未指定 scope 或固定 scope。snapshot/backup envelope 使用严格字段：`formatVersion`、`snapshotId`、`createdAt`、`kind`、`scope`、`sections`、`presentSections`、`payload`、`payloadSha256`、`sourceSnapshotId`。ID 是随机 UUID；时间为 UTC ISO 时间；摘要覆盖固定 scope、sections、presentSections 和 payload 的 UTF-8 JSON。摘要用于检测损坏，不是签名、来源认证或防恶意修改证明。

`listSnapshots()` 返回 metadata；校验失败的条目以 `{ snapshotId, status: "invalid", errorCode }` 显示，不把原文件内容或异常消息投影给调用方。`exportSnapshot(id)` 先完整验证 envelope 与摘要，然后才返回 payload。快照/恢复前备份都存入 owned home 下 `tradeloom-state/snapshots/`，文件名只由 UUID 生成，写入后读回校验；前恢复备份以 `kind: "pre-restore-backup"` 标识并保留来源 snapshot id。

`previewRestore(id)` 不写任何文件，preview 仅存于当前 Node 进程，5 分钟过期；返回：

```json
{
  "previewId": "<随机 UUID>",
  "snapshotId": "<已验证 snapshot UUID>",
  "snapshotSha256": "<64 位十六进制摘要>",
  "scope": "tradeloom-state/config-layout-v1",
  "changedSections": ["userProfile", "sceneWorkbench", "dockLayouts"],
  "expiresAt": "<UTC ISO 时间，5 分钟后>"
}
```

preview 凭据只在当前进程内存有效且单次使用，不是人类确认凭据。apply 一旦开始，`cancelRestorePreview` 返回 `false`，不声称可中止已经进入事务的恢复。CAS 只覆盖将被恢复的三个配置/布局分区：无关 role、revision、budget 或 session-operation 写入不会令预览失效；预览后目标分区发生变化则返回 `restore_preview_stale`。真正 apply 在 `transact` 内重新验证 snapshot 和当前选中分区摘要，先生成并读回验证当前选中分区备份，再赋值 snapshot 中选中分区，最后复用原 state atomic commit。任何备份写入/读回或 state atomic commit 失败，都不会通过直接替换 `state.json` 绕过原事务；commit 失败时 pre-restore backup 仍保留。

成功返回：

```json
{
  "snapshot": {
    "snapshotId": "<目标 UUID>",
    "createdAt": "<UTC ISO 时间>",
    "kind": "capture",
    "scope": "tradeloom-state/config-layout-v1",
    "sections": ["userProfile", "sceneWorkbench", "dockLayouts"],
    "payloadSha256": "<64 位十六进制摘要>",
    "sourceSnapshotId": null,
    "status": "valid"
  },
  "backup": {
    "snapshotId": "<备份 UUID>",
    "createdAt": "<UTC ISO 时间>",
    "kind": "pre-restore-backup",
    "scope": "tradeloom-state/config-layout-v1",
    "sections": ["userProfile", "sceneWorkbench", "dockLayouts"],
    "payloadSha256": "<64 位十六进制摘要>",
    "sourceSnapshotId": "<目标 UUID>",
    "status": "valid"
  },
  "changedSections": ["userProfile"]
}
```

主要稳定错误码：`snapshot_scope_unsupported`、`snapshot_id_invalid`、`snapshot_not_found`、`snapshot_invalid`、`snapshot_checksum_mismatch`、`snapshot_unavailable`、`snapshot_write_failed`、`snapshot_verification_failed`、`backup_write_failed`、`backup_verification_failed`、`restore_preview_unavailable`、`restore_preview_stale`、`restore_snapshot_changed`、`state_unavailable`、`state_commit_failed`。不把底层文件路径或异常消息作为 API 错误文本返回。

## 本轮验证

- `node --check packages/tradeloom-shell/state.js`：exit 0。
- `node --check packages/tradeloom-shell/tests/state-snapshots.test.js`：exit 0。
- `node --test packages/tradeloom-shell/tests/state-snapshots.test.js packages/tradeloom-shell/tests/workflow-native-service.test.js packages/tradeloom-shell/tests/workflow-native-ui.test.js packages/tradeloom-shell/tests/skills-open.test.js`：115 passed，0 failed，0 skipped，exit 0；原始输出见 [`targeted-tests.txt`](../../recovery-20261029/n03-state-snapshots-20261030/targeted-tests.txt)。新增 11 项覆盖真实临时 owned home 文件 I/O、capture/export/list、preview/cancel 零 state 写入、只改目标分区、保留并发运行台账、selected-scope stale、摘要损坏、伪造数组 sourceSnapshotId 拒绝、current state 损坏拒绝、backup 写入/读回失败、state rename 失败保原字节、跨 owned store preview 隔离、apply开始后取消拒绝及 junction 列表拒绝。

故障注入仅通过测试创建的 `createStateStore({ _testHooks })` seam 实现；正常调用不提供该参数。fixture 目录与 marker 都由测试创建并在 Node test cleanup 中清理，不指向已有 DSH_HOME。

此验证是 Node state store 文件行为，不是生产 Host/renderer/GUI、多进程并发、模型引擎或业务数据库的恢复验收。N03 其余配置/引擎/业务数据域仍未实现。
