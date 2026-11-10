# N03 scene memory content snapshots

This slice adds explicit capture/export/preview/cancel/restore for one catalogued scene's persisted `sceneMemory` content. It complements the narrower [scene profile snapshots](N03-SCENE-PROFILE-SNAPSHOTS.md); it does not replace them or complete N03.

## Scope and preservation

The snapshot payload is exactly one scene's `profile`, `handoff`, `progress`, and `decisions`, with the captured `handoffRevision` recorded as source metadata. It does not restore that counter to its old value. A restore preserves the current `sessionScenes`, `bindingRevision`, rotation records, handoff operation records, progress/decision idempotency ledgers, every other scene, and all other state-store fields. Unknown fields outside `sceneMemory` remain untouched. A conflicting historical operation identity rejects the restore.

The profile revision is written as the current revision plus one. Every restore, including one that restores `handoff: null`, advances the scene's monotonic handoff counter by one; an exhausted safe integer rejects with `scene_content_revision_conflict`. A restored non-null handoff keeps its real `sourceSessionId`, text, `operationId`, and `updatedAt`, while its record revision is set to the new counter. Progress and decision rows keep their original IDs, source sessions, content, and timestamps. Their idempotency ledger survives restore: replaying a removed-but-previously-committed entry returns `replayed: true` without re-adding it; reuse with a different identity conflicts.

Any scene rotation other than `complete` or `abandoned` blocks preview and restore with `scene_rotation_in_progress`. Restore preview CAS covers the complete selected content (profile and revision, handoff and counter, both full journals) plus the current binding revision. A concurrent append or any selected content/binding change makes the preview stale; it never replaces a newer append. Backup of current content is written and read back with checksum verification before state mutation. A backup or atomic state commit failure leaves the state file unchanged.

## Controller API

These methods are on `createSceneMemoryStore(stateStore, { sceneIds, ... })`. They are not registered as AI tools. A future trusted local controller must provide the explicit catalog scene ID and separately obtain real user confirmation; a preview token is a one-time CAS credential, not proof of human confirmation.

```js
import { createStateStore } from '@tradeloom/dsh-business-shell/state'
import { createSceneMemoryStore } from '@tradeloom/dsh-business-shell/scene-memory'

const state = await createStateStore({ env })
const memory = createSceneMemoryStore(state, { sceneIds: trustedSceneCatalog })
const saved = await memory.captureSceneContentSnapshot('sales')
const rows = await memory.listSceneContentSnapshots('sales')
const envelope = await memory.exportSceneContentSnapshot(saved.snapshotId, 'sales')

// Cancellation path: this preview is consumed and no state is written.
const cancelled = await memory.previewSceneContentRestore(saved.snapshotId, 'sales')
memory.cancelSceneContentRestore(cancelled.previewId, 'sales')

// Apply path: obtain real confirmation outside this module before this call.
const fresh = await memory.previewSceneContentRestore(saved.snapshotId, 'sales')
const restored = await memory.restoreSceneContentSnapshot(fresh.previewId, 'sales')
```

`capture` returns `{ snapshotId, createdAt, kind, scope, sceneId, sections, payloadSha256, status }`. `list` returns those metadata rows, with invalid files represented only by `{ snapshotId, status: "invalid", errorCode }`. `export` returns the checked envelope. The content envelope scope is `tradeloom-scene-content/v1` and its sections are `scene.profile`, `scene.handoff`, `scene.progress`, and `scene.decisions`; captures have `sourceSnapshotId: null`, while a pre-restore backup records the capture ID it protects.

Successful restore returns `{ status: "restored", sceneId, profileRevision, handoffRevision, handoff, progress, decisions, snapshot, backup, changedSections }`. Stable errors include `scene_catalog_unavailable`, `scene_not_found`, `scene_memory_unavailable`, `scene_memory_invalid`, `scene_memory_migration_backup_failed`, `scene_memory_migration_backup_unavailable`, `scene_content_snapshot_id_invalid`, `scene_content_snapshot_not_found`, `scene_content_snapshot_invalid`, `scene_content_snapshot_checksum_mismatch`, `scene_content_snapshot_unavailable`, `scene_content_snapshot_write_failed`, `scene_content_snapshot_verification_failed`, `scene_content_restore_preview_unavailable`, `scene_content_restore_preview_stale`, `scene_content_snapshot_changed`, `scene_content_snapshot_ledger_conflict`, `scene_content_revision_conflict`, `scene_content_backup_write_failed`, `scene_content_backup_verification_failed`, `scene_content_state_commit_failed`, and `scene_rotation_in_progress`. Lower-level filesystem paths and exception text are not returned.

## Persistence and version transition

Content snapshot envelopes are under the marker-owned `tradeloom-state/snapshots/scene-memory/<sceneId>/<snapshotId>.json`; pre-restore copies use `kind: "pre-restore-backup"`. Version-migration backups use the separate sibling directory `tradeloom-state/scene-memory-migration-backups/<snapshotId>.json`, outside the scene-ID namespace. Writes use the existing owned-path/reparse validation, temporary-file fsync, atomic rename, and read-back verification. A five-minute in-process preview is bound to the state path and scene and can be cancelled only before apply starts.

Persisted `sceneMemory` is now version 2. Version 2 adds each scene's monotonic `handoffRevision` and separate `journalOperations.progress` / `journalOperations.decisions` maps. The handoff record keeps its own historical revision; `readForSession` exposes `handoffRevision` even when handoff is null, and handoff update CAS plus rotation/graph snapshots use the monotonic counter. Existing progress and decision rows seed their SHA-256 identity ledger during upgrade; there is no journal row cap or silent trimming.

Readers accept version 1 and normalize it in memory without writing. The first successful state transaction that persists scene memory upgrades the whole namespace to version 2. Before that transaction commits, the exact old `sceneMemory` value is written and read back from `tradeloom-state/scene-memory-migration-backups/<id>.json`, outside the scene snapshot namespace. If the backup cannot be verified, the state transaction does not commit. Version 2 requires the new counter and ledgers; the older reader rejects it rather than dropping those fields. Rollback requires stopping writers and having the owner inspect and restore the verified pre-upgrade copy. Restoring that copy discards scene-memory changes made after the upgrade, so preserve those changes separately first. It is not automatic and does not roll back SDK sessions or other state; the old-reader test uses an owned fixture and is not a production SDK downgrade test.

## Verification boundary

Tests use isolated marker-owned state files and real local file I/O. They do not exercise production Host/controller composition, GUI confirmation, cross-process state writers, SDK profile/configuration, session databases, business databases, files referenced by assetRefs, or the remaining N03 configuration/engine/data domains. This is a backend slice, not a complete scene restore product.
