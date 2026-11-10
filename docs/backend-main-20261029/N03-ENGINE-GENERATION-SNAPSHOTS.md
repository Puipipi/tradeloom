# N03 engine-generation payload snapshots

This backend package slice captures a real, controlled payload tree and provides restore orchestration. It does not infer an engine generation from a version string or build receipt. No production launcher producer or activation adapter is wired in this worktree, so a production restore remains unavailable until those trusted interfaces are supplied.

## Trust and payload scope

The only producer is the trusted `getCurrentGeneration()` factory dependency. It supplies:

```js
{
  generationId: 'generation-abc',
  runtimeVersion: 'runtime-version',
  scope: 'one-controlled-engine-subtree/v1',
  activationRevision: 'monotonic-authoritative-token',
  root: 'absolute path supplied by the trusted launcher adapter',
  entries: [
    { path: 'assets', type: 'directory' },
    { path: 'assets/empty', type: 'directory' },
    { path: 'bin', type: 'directory' },
    { path: 'bin/engine.dat', type: 'file', size: 12, sha256: '<64 lowercase hex>' },
    { path: 'version.txt', type: 'file', size: 12, sha256: '<64 lowercase hex>' },
  ],
}
```

`root` must be the complete root of one explicitly named engine payload subtree. The service independently walks that tree and requires the producer inventory to match every file and directory, including empty directories. Missing or extra files/directories, reparse points, invalid hashes, a changing activation token, or a source path overlapping either the owned `DSH_HOME` or snapshot store reject capture. The source path is never accepted from a request, persisted in the snapshot metadata, or returned to callers.

The `scope` is an opaque producer-owned identifier for that exact subtree. Restore is allowed only when the target snapshot and current generation have the same scope. The producer must provide a stable, non-reusable activation revision across A→B→A transitions; the service includes that token and the complete payload inventory in its preview compare-and-swap check.

The packaged desktop harness manifest at `staging/desktop-6/resources/tradeloom/deployment.json` describes packaged resources and a primary Python runtime. The existing bootstrap and receipt code verify installation/build identity; they do not provide this service's full engine inventory, immutable backup payload, or activation/rollback interface. `getDshRuntimeVersion()` is version information only. Neither source should be treated as a generation producer.

Snapshots live beneath the explicitly owned `DSH_HOME` in `tradeloom-engine-generation-snapshots/`. Each snapshot contains a metadata manifest and a byte-for-byte copy of every inventoried file, with empty directories preserved. The manifest checksum covers the metadata and full sorted inventory; every stored file is size/hash checked when exported, previewed, or used for restore. No user profile, credentials, sessions, business database, or arbitrary filesystem paths are read by this module.

## Service API

```js
import { createEngineGenerationSnapshots } from '@tradeloom/dsh-business-shell/engine-generation-snapshots'

const snapshots = createEngineGenerationSnapshots({
  env: ownedHostEnvironment,
  getCurrentGeneration: trustedLauncherCatalog.getCurrentGeneration,
  activationAdapter: trustedLauncherGenerationAdapter, // optional; absent means restore is unavailable
})

const saved = await snapshots.capture()
const metadata = await snapshots.export(saved.snapshotId) // manifest and hashes; no binary payload bytes
const page = await snapshots.list()
const preview = await snapshots.previewRestore(saved.snapshotId)
if (operatorCancels) {
  snapshots.cancelRestorePreview(preview.previewId)
} else {
  // A future trusted Host controller can explicitly call restore after its own confirmation flow.
  const result = await snapshots.restore(preview.previewId)
}
await snapshots.dispose()
```

`capture()` returns `{ snapshotId, createdAt, kind, generationId, runtimeVersion, scope, activationRevision, entryCount, fileCount, directoryCount, totalBytes, checksum }`. `list()` returns `{ snapshots, invalid }`; invalid manifest rows expose only the snapshot ID and a fixed error code. `export(snapshotId)` returns the same metadata plus the verified relative `entries` manifest; it does not export executable bytes. `previewRestore(snapshotId)` returns an opaque in-memory `previewId`, target/current metadata, exact added/changed/removed relative paths, and whether an activation adapter is present. The preview binds the snapshot checksum and full current generation fingerprint. It has no time-based expiry; a changed generation or revision makes it stale. `cancelRestorePreview(previewId)` only removes an unconsumed preview and writes nothing.

Restore first verifies the target snapshot and current compare-and-swap identity. If an activation adapter is present, the service copies and verifies the current generation as a `pre-restore-backup`, rechecks the current token, and then calls the adapter's `prepare({ targetSnapshot, backupSnapshot, expectedCurrent, readSnapshotFile })`. `prepare` must not alter the active generation; it may stage files and returns `commit({ expectedCurrent })` plus `rollback({ phase, expectedCurrent, backupSnapshot, readSnapshotFile })`. A `prepared` rollback discards staging only. A `commit` rollback uses the verified backup and must compare-and-swap rather than overwrite a newer unrelated activation. The service reads the authoritative generation back after commit and compares generation ID, runtime version, scope and every payload entry. On failure it asks the adapter to roll back and reads the active payload again. A verified rollback returns a failure with `backupSnapshotId`; an unverified rollback returns `engine_restore_rollback_failed` or `engine_restore_state_unknown` with the backup ID. Public errors expose stable codes only; the original activation error remains in the non-JSON `Error.cause` chain, and if rollback also fails its original error remains on the non-JSON `rollbackCause` property.

Without an activation adapter, `previewRestore` is still read-only and reports `restorable:false`; `restore` returns `engine_restore_unavailable` before creating a backup or changing the active payload. The service does not create an `active.json`, switch a private pointer, overwrite an installed tree, or claim a launcher activation occurred. `dispose()` rejects later calls and waits for an already-started copy/activation transition to finish its readback or rollback.

Stable errors include `engine_generation_unavailable`, `engine_generation_invalid`, `engine_generation_inventory_mismatch`, `engine_generation_source_changed`, `engine_generation_source_overlap`, `engine_generation_snapshot_id_invalid`, `engine_generation_snapshot_not_found`, `engine_generation_snapshot_invalid`, `engine_generation_snapshot_checksum_mismatch`, `engine_generation_snapshot_unavailable`, `engine_generation_snapshot_write_failed`, `engine_generation_backup_write_failed`, `engine_generation_scope_mismatch`, `engine_generation_preview_stale`, `engine_generation_restore_preview_not_found`, `engine_generation_service_closed`, `engine_restore_unavailable`, `engine_activation_unavailable`, `engine_restore_failed`, `engine_restore_rollback_failed`, and `engine_restore_state_unknown`. Errors do not return source paths, raw filesystem messages, or binary content. After a verified backup exists, restore failures include its `backupSnapshotId`.

## Validation boundary

The focused Node suite uses marker-owned runtime directories under the recovery test root. It checks exact producer/tree inventory (including missing/extra entries and empty directories), checksum/export behavior, source/store separation, preview/cancel without active changes, scope and activation-revision rejection, a physically staged/renamed fixture activation with byte-for-byte rollback, disposal during a held commit, backup failure, commit failure, readback mismatch, rollback failure, and corrupt payload rejection. The fixture adapter moves and restores real files only inside its owned test directory; it is not the desktop launcher or an SDK activation proof.

No current production launcher module supplies `getCurrentGeneration()` or the atomic activation adapter, and no Host route mounts this service. This slice therefore proves owned filesystem snapshots and the injected transaction orchestration only. It does not prove a real engine backup/activation, installed runtime upgrade/reopen, Electron/GUI confirmation, model behavior, SDK profile state, business data backup, or completion of N03.
