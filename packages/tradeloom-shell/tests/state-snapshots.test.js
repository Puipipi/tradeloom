import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { HOME_MARKER, HOME_MARKER_VALUE, createStateStore, replaceRoleBinding } from '../state.js'

async function makeStore(t, hooks) {
  const home = await mkdtemp(join(tmpdir(), 'tradeloom-state-snapshot-'))
  await writeFile(join(home, HOME_MARKER), HOME_MARKER_VALUE)
  t.after(() => rm(home, { recursive: true, force: true }))
  const env = { DSH_HOME: home, TRADELOOM_DSH_APP_HOME: home }
  return { home, env, store: await createStateStore({ env, ...(hooks ? { _testHooks: hooks } : {}) }) }
}

test('snapshot preview is read-only and restore changes only supported config/layout partitions', async t => {
  const { env, store } = await makeStore(t)
  await store.transact(state => {
    state.userProfile = { displayName: 'First', notes: 'private fixture note' }
    state.sceneWorkbench = { selectedScene: 'sales', cards: ['native-chat'] }
    state.dockLayouts = { version: 2, scenes: { sales: { panels: [{ id: 'p1', type: 'native-chat' }] } } }
    replaceRoleBinding(state, 'center', { sessionId: 'session-before', workspaceId: 'workspace-a', agentPreset: 'tradeloom-center' })
    state.budgets = { center: { remaining: 7 } }
    state.sessionCreateOperations = { op1: { status: 'complete' } }
    state.pendingSessionCreateByRole = { product: 'op1' }
  })

  const captured = await store.captureSnapshot()
  assert.equal(captured.scope, 'tradeloom-state/config-layout-v1')
  assert.match(captured.snapshotId, /^[0-9a-f-]{36}$/)
  assert.match(captured.payloadSha256, /^[0-9a-f]{64}$/)
  const exported = await store.exportSnapshot(captured.snapshotId)
  assert.deepEqual(exported.payload.userProfile, { displayName: 'First', notes: 'private fixture note' })

  await store.transact(state => {
    state.userProfile = { displayName: 'Second', notes: 'new fixture note' }
    state.sceneWorkbench = { selectedScene: 'product', cards: ['artifact-browser'] }
    state.dockLayouts = { version: 2, scenes: { product: { panels: [] } } }
    replaceRoleBinding(state, 'center', { sessionId: 'session-after', workspaceId: 'workspace-b', agentPreset: 'tradeloom-center' })
    state.budgets.center.remaining = 3
    state.sessionCreateOperations.op2 = { status: 'pending' }
    state.pendingSessionCreateByRole.product = 'op2'
  })

  const statePath = store.paths.statePath
  const beforePreview = await readFile(statePath)
  const preview = await store.previewRestore(captured.snapshotId)
  assert.deepEqual(preview.changedSections, ['userProfile', 'sceneWorkbench', 'dockLayouts'])
  assert.deepEqual(await readFile(statePath), beforePreview)
  assert.equal(await store.cancelRestorePreview(preview.previewId), true)
  assert.deepEqual(await readFile(statePath), beforePreview)

  const approved = await store.previewRestore(captured.snapshotId)
  const restored = await store.restoreSnapshot(approved.previewId)
  assert.ok(restored.backup.snapshotId)
  const after = await (await createStateStore({ env })).read()
  assert.deepEqual(after.userProfile, { displayName: 'First', notes: 'private fixture note' })
  assert.deepEqual(after.sceneWorkbench, { selectedScene: 'sales', cards: ['native-chat'] })
  assert.deepEqual(after.dockLayouts, { version: 2, scenes: { sales: { panels: [{ id: 'p1', type: 'native-chat' }] } } })
  assert.equal(after.roles.center.sessionId, 'session-after')
  assert.equal(after.roleBindingRevisions.center, '2')
  assert.deepEqual(after.budgets, { center: { remaining: 3 } })
  assert.deepEqual(after.sessionCreateOperations, { op1: { status: 'complete' }, op2: { status: 'pending' } })
  assert.deepEqual(after.pendingSessionCreateByRole, { product: 'op2' })
  const backup = await store.exportSnapshot(restored.backup.snapshotId)
  assert.equal(backup.kind, 'pre-restore-backup')
  assert.deepEqual(backup.payload.userProfile, { displayName: 'Second', notes: 'new fixture note' })
})

test('preview ignores unrelated state changes but rejects changed selected partitions', async t => {
  const { env, store } = await makeStore(t)
  await store.transact(state => { state.userProfile = { displayName: 'Before', notes: '' } })
  const snapshot = await store.captureSnapshot()
  await store.transact(state => { state.userProfile = { displayName: 'After', notes: '' } })
  const preview = await store.previewRestore(snapshot.snapshotId)

  const peer = await createStateStore({ env })
  await peer.transact(state => {
    replaceRoleBinding(state, 'product', { sessionId: 'other-session', workspaceId: null, agentPreset: 'tradeloom-product' })
    state.sessionCreateOperations.later = { status: 'pending' }
  })
  const [, result] = await Promise.all([
    peer.transact(state => { state.budgets.concurrent = { remaining: 11 } }),
    store.restoreSnapshot(preview.previewId),
  ])
  assert.deepEqual(result.changedSections, ['userProfile'])
  const current = await peer.read()
  assert.deepEqual(current.userProfile, { displayName: 'Before', notes: '' })
  assert.equal(current.roles.product.sessionId, 'other-session')
  assert.equal(current.roleBindingRevisions.product, '1')
  assert.deepEqual(current.sessionCreateOperations, { later: { status: 'pending' } })
  assert.deepEqual(current.budgets.concurrent, { remaining: 11 })

  const stale = await store.previewRestore(snapshot.snapshotId)
  await peer.transact(state => { state.sceneWorkbench = { active: 'changed-after-preview' } })
  const unchanged = await readFile(store.paths.statePath)
  await assert.rejects(store.restoreSnapshot(stale.previewId), error => error.code === 'restore_preview_stale')
  assert.deepEqual(await readFile(store.paths.statePath), unchanged)
})

test('snapshot checksum corruption and unsupported scope never write state', async t => {
  const { store } = await makeStore(t)
  await store.transact(state => { state.userProfile = { displayName: 'Keep', notes: 'unchanged' } })
  const captured = await store.captureSnapshot()
  const path = join(store.paths.home, 'tradeloom-state', 'snapshots', `${captured.snapshotId}.json`)
  const original = await readFile(path, 'utf8')
  const before = await readFile(store.paths.statePath)
  await writeFile(path, original.replace('Keep', 'Tamper'))
  await assert.rejects(store.exportSnapshot(captured.snapshotId), error => error.code === 'snapshot_checksum_mismatch')
  await assert.rejects(store.captureSnapshot({ scope: 'all-files' }), error => error.code === 'snapshot_scope_unsupported')
  assert.deepEqual(await readFile(store.paths.statePath), before)
})

test('backup sourceSnapshotId requires a string, not a coercible array', async t => {
  const { store } = await makeStore(t)
  const snapshot = await store.captureSnapshot()
  const path = join(store.paths.home, 'tradeloom-state', 'snapshots', `${snapshot.snapshotId}.json`)
  const record = JSON.parse(await readFile(path, 'utf8'))
  record.kind = 'pre-restore-backup'
  record.sourceSnapshotId = [snapshot.snapshotId]
  await writeFile(path, JSON.stringify(record))
  await assert.rejects(store.exportSnapshot(snapshot.snapshotId), error => error.code === 'snapshot_invalid')
})

test('backup readback failure leaves current state unchanged', async t => {
  let corruptNextBackup = false
  const hooks = {
    async afterSnapshotWrite({ kind, path }) {
      if (kind !== 'pre-restore-backup' || !corruptNextBackup) return
      corruptNextBackup = false
      const text = await readFile(path, 'utf8')
      await writeFile(path, text.replace('backup', 'broken'))
    },
  }
  const { store } = await makeStore(t, hooks)
  await store.transact(state => { state.userProfile = { displayName: 'Old', notes: '' } })
  const snapshot = await store.captureSnapshot()
  await store.transact(state => { state.userProfile = { displayName: 'Current', notes: '' } })
  const preview = await store.previewRestore(snapshot.snapshotId)
  const before = await readFile(store.paths.statePath)
  corruptNextBackup = true
  await assert.rejects(store.restoreSnapshot(preview.previewId), error => error.code === 'backup_verification_failed')
  assert.deepEqual(await readFile(store.paths.statePath), before)
})

test('corrupt current state is not overwritten by a restore attempt', async t => {
  const { store } = await makeStore(t)
  await store.transact(state => { state.userProfile = { displayName: 'Saved', notes: '' } })
  const snapshot = await store.captureSnapshot()
  const preview = await store.previewRestore(snapshot.snapshotId)
  const bytes = Buffer.from('{invalid current state')
  await writeFile(store.paths.statePath, bytes)
  await assert.rejects(store.restoreSnapshot(preview.previewId), error => error.code === 'state_unavailable')
  assert.deepEqual(await readFile(store.paths.statePath), bytes)
  assert.equal((await store.listSnapshots()).filter(row => row.kind === 'pre-restore-backup').length, 0)
})

test('a restore preview can be applied only once when two callers race', async t => {
  const { store } = await makeStore(t)
  await store.transact(state => { state.userProfile = { displayName: 'Saved', notes: '' } })
  const snapshot = await store.captureSnapshot()
  await store.transact(state => { state.userProfile = { displayName: 'Current', notes: '' } })
  const preview = await store.previewRestore(snapshot.snapshotId)
  const attempts = await Promise.allSettled([
    store.restoreSnapshot(preview.previewId),
    store.restoreSnapshot(preview.previewId),
  ])
  assert.equal(attempts.filter(item => item.status === 'fulfilled').length, 1)
  assert.equal(attempts.filter(item => item.status === 'rejected' && item.reason?.code === 'restore_preview_unavailable').length, 1)
  assert.equal((await store.listSnapshots()).filter(row => row.kind === 'pre-restore-backup').length, 1)
})

test('cancel after restore application starts is rejected and does not interrupt the transaction', async t => {
  let releaseBackup
  let signalBackupStarted
  const backupStarted = new Promise(resolve => { signalBackupStarted = resolve })
  const backupGate = new Promise(resolve => { releaseBackup = resolve })
  const hooks = {
    async afterSnapshotWrite({ kind }) {
      if (kind !== 'pre-restore-backup') return
      signalBackupStarted()
      await backupGate
    },
  }
  const { store } = await makeStore(t, hooks)
  await store.transact(state => { state.userProfile = { displayName: 'Snapshot', notes: '' } })
  const snapshot = await store.captureSnapshot()
  await store.transact(state => { state.userProfile = { displayName: 'Current', notes: '' } })
  const preview = await store.previewRestore(snapshot.snapshotId)
  const applying = store.restoreSnapshot(preview.previewId)
  await backupStarted
  assert.equal(store.cancelRestorePreview(preview.previewId), false)
  releaseBackup()
  const result = await applying
  assert.deepEqual(result.changedSections, ['userProfile'])
  assert.deepEqual((await store.read()).userProfile, { displayName: 'Snapshot', notes: '' })
})

test('a different owned store cannot consume another store preview', async t => {
  const first = await makeStore(t)
  await first.store.transact(state => { state.userProfile = { displayName: 'Saved', notes: '' } })
  const snapshot = await first.store.captureSnapshot()
  await first.store.transact(state => { state.userProfile = { displayName: 'Current', notes: '' } })
  const preview = await first.store.previewRestore(snapshot.snapshotId)
  const second = await makeStore(t)
  await assert.rejects(second.store.restoreSnapshot(preview.previewId), error => error.code === 'restore_preview_unavailable')
  const restored = await first.store.restoreSnapshot(preview.previewId)
  assert.deepEqual(restored.changedSections, ['userProfile'])
  assert.deepEqual((await first.store.read()).userProfile, { displayName: 'Saved', notes: '' })
})

test('snapshot listing rejects an owned-home junction before reading the target directory', async t => {
  const { home, store } = await makeStore(t)
  const external = await mkdtemp(join(tmpdir(), 'tradeloom-snapshot-junction-target-'))
  t.after(() => rm(external, { recursive: true, force: true }))
  const snapshotDirectory = join(home, 'tradeloom-state', 'snapshots')
  await mkdir(snapshotDirectory)
  await rm(snapshotDirectory, { recursive: true })
  await writeFile(join(external, '550e8400-e29b-41d4-a716-446655440000.json'), '{"foreign":true}')
  await symlink(external, snapshotDirectory, 'junction')
  await assert.rejects(store.listSnapshots(), error => error.code === 'snapshot_unavailable')
})

test('atomic state rename failure preserves original bytes after a verified backup', async t => {
  let rejectStateRename = false
  const hooks = {
    async rename(from, to) {
      if (rejectStateRename && to.endsWith('state.json')) {
        rejectStateRename = false
        const error = new Error('injected state rename failure')
        error.code = 'EIO'
        throw error
      }
      const { rename } = await import('node:fs/promises')
      return rename(from, to)
    },
  }
  const { env, store } = await makeStore(t)
  await store.transact(state => { state.userProfile = { displayName: 'Snapshot', notes: '' } })
  const snapshot = await store.captureSnapshot()
  await store.transact(state => { state.userProfile = { displayName: 'Original', notes: '' } })
  const withFailure = await createStateStore({ env, _testHooks: hooks })
  const preview = await withFailure.previewRestore(snapshot.snapshotId)
  const original = await readFile(store.paths.statePath)
  rejectStateRename = true
  await assert.rejects(withFailure.restoreSnapshot(preview.previewId), error => error.code === 'state_commit_failed')
  assert.deepEqual(await readFile(store.paths.statePath), original)
  const records = await store.listSnapshots()
  assert.equal(records.some(row => row.kind === 'pre-restore-backup' && row.status === 'valid'), true)
})
