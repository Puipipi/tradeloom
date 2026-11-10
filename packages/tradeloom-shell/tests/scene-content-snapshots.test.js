import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createStateStore, HOME_MARKER, HOME_MARKER_VALUE } from '../state.js'
import { createSceneMemoryStore } from '../scene-memory.js'

async function fixture(t, hooks) {
  const root = await mkdtemp(join(tmpdir(), 'tradeloom-scene-content-snapshot-'))
  const home = join(root, 'home')
  await mkdir(home, { recursive: true })
  await writeFile(join(home, HOME_MARKER), HOME_MARKER_VALUE)
  const env = { DSH_HOME: home, TRADELOOM_DSH_APP_HOME: home }
  const state = await createStateStore({ env, ...(hooks ? { _testHooks: hooks } : {}) })
  const memory = createSceneMemoryStore(state, { sceneIds: ['scene-a', 'scene-b'], verifySession: async () => true })
  t.after(async () => { await rm(root, { recursive: true, force: true }) })
  return { root, home, env, state, memory }
}

async function seed(memory) {
  await memory.configureScene({ sceneId: 'scene-a', expectedRevision: 0, responsibility: 'A original', assetRefs: [], primarySkill: null })
  await memory.configureScene({ sceneId: 'scene-b', expectedRevision: 0, responsibility: 'B untouched', assetRefs: [], primarySkill: null })
  await memory.bindSession({ sceneId: 'scene-a', sessionId: 'session-a', expectedSessionId: null })
  await memory.bindSession({ sceneId: 'scene-b', sessionId: 'session-b', expectedSessionId: null })
  await memory.updateHandoff({ sessionId: 'session-a', operationId: 'handoff-original', expectedRevision: 0, text: 'handoff original' })
  await memory.appendProgress({ sessionId: 'session-a', entryId: 'progress-original', text: 'progress original' })
  await memory.appendDecision({ sessionId: 'session-a', entryId: 'decision-original', text: 'decision original' })
}

test('full scene content snapshot restores profile and journals without rolling counters, ledgers, bindings, or other scenes back', async t => {
  const f = await fixture(t)
  await seed(f.memory)
  const captured = await f.memory.captureSceneContentSnapshot('scene-a')
  const exported = await f.memory.exportSceneContentSnapshot(captured.snapshotId, 'scene-a')
  assert.equal(exported.scope, 'tradeloom-scene-content/v1')
  assert.deepEqual(exported.sections, ['scene.profile', 'scene.handoff', 'scene.progress', 'scene.decisions'])
  assert.equal(exported.payload.handoff.text, 'handoff original')
  assert.equal(exported.payload.progress[0].text, 'progress original')

  await f.memory.configureScene({ sceneId: 'scene-a', expectedRevision: 1, responsibility: 'A changed', assetRefs: [], primarySkill: null })
  await f.memory.updateHandoff({ sessionId: 'session-a', operationId: 'handoff-later', expectedRevision: 1, text: 'handoff later' })
  await f.memory.appendProgress({ sessionId: 'session-a', entryId: 'progress-later', text: 'progress later' })
  await f.memory.appendDecision({ sessionId: 'session-a', entryId: 'decision-later', text: 'decision later' })
  const before = await f.memory.readForSession('session-a')
  await f.state.transact(state => {
    state.budgets.unrelated = { remaining: 7 }
    state.sceneMemory.scenes['scene-a'].rotations['finished-rotation'] = {
      operationId: 'finished-rotation', fingerprint: 'fixture', intentRevision: 1, phase: 'complete',
      oldSessionId: 'session-a', plannedSessionId: 'session-a2', createdSessionId: 'session-a2',
      expectedBindingRevision: 1, expectedProfileRevision: 1, expectedHandoffRevision: 1,
      archiveOld: false, workspaceId: null, cwd: null, agentPreset: null, errorCode: null,
      createdAt: '2026-10-30T00:00:00.000Z', updatedAt: '2026-10-30T00:00:00.000Z',
    }
  })
  const preview = await f.memory.previewSceneContentRestore(captured.snapshotId, 'scene-a')
  const restoring = f.memory.restoreSceneContentSnapshot(preview.previewId, 'scene-a')
  assert.equal(f.memory.cancelSceneContentRestore(preview.previewId, 'scene-a'), false)
  const restored = await restoring
  assert.equal(restored.backup.kind, 'pre-restore-backup')

  const a = await f.memory.readForSession('session-a')
  const b = await f.memory.readForSession('session-b')
  assert.equal(a.profile.responsibility, 'A original')
  assert.equal(a.profile.revision, before.profile.revision + 1)
  assert.equal(a.handoff.text, 'handoff original')
  assert.equal(a.handoff.sourceSessionId, 'session-a')
  assert.equal(a.handoff.operationId, 'handoff-original')
  assert.equal(a.handoffRevision, before.handoffRevision + 1)
  assert.equal(a.handoff.revision, a.handoffRevision)
  assert.deepEqual(a.progress.map(row => row.entryId), ['progress-original'])
  assert.deepEqual(a.decisions.map(row => row.entryId), ['decision-original'])
  assert.equal(b.profile.responsibility, 'B untouched')
  assert.equal(b.handoffRevision, 0)
  assert.equal((await f.state.read()).budgets.unrelated.remaining, 7)
  assert.equal((await f.state.read()).sceneMemory.scenes['scene-a'].rotations['finished-rotation'].phase, 'complete')
  assert.equal((await f.memory.updateHandoff({
    sessionId: 'session-a', operationId: 'handoff-later', expectedRevision: 1, text: 'handoff later',
  })).replayed, true)
  assert.deepEqual(await f.memory.appendProgress({ sessionId: 'session-a', entryId: 'progress-later', text: 'progress later' }),
    { sceneId: 'scene-a', entryId: 'progress-later', replayed: true })
  assert.deepEqual(await f.memory.appendDecision({ sessionId: 'session-a', entryId: 'decision-later', text: 'decision later' }),
    { sceneId: 'scene-a', entryId: 'decision-later', replayed: true })
  assert.equal((await f.memory.readForSession('session-a')).progress.length, 1)
  assert.equal((await f.memory.readForSession('session-a')).decisions.length, 1)
})

test('legacy version one reads without writes then atomically backs up before upgrading on first mutation', async t => {
  const f = await fixture(t)
  const oldModuleUrl = new URL('./fixtures/scene-memory-v1/scene-memory.js', import.meta.url)
  const oldSceneMemory = await import(oldModuleUrl.href)
  await f.state.transact(state => {
    state.sceneMemory = {
      version: 1,
      scenes: { 'scene-a': {
        profile: { revision: 2, responsibility: 'legacy', assetRefs: [], primarySkill: null },
        handoff: { revision: 1, sourceSessionId: 'session-a', text: 'legacy handoff', updatedAt: '2026-10-30T00:00:00.000Z', operationId: 'legacy-op' },
        progress: [{ entryId: 'legacy-progress', sourceSessionId: 'session-a', text: 'legacy progress', createdAt: '2026-10-30T00:00:00.000Z' }],
        decisions: [], operations: { 'legacy-op': { kind: 'handoff', fingerprint: '["session-a","legacy handoff"]', revision: 1, sourceSessionId: 'session-a' } },
        bindingRevision: 1, rotations: {},
      } }, sessionScenes: { 'session-a': 'scene-a' },
    }
  })
  const path = join(f.home, 'tradeloom-state', 'state.json')
  const beforeRead = await readFile(path, 'utf8')
  const legacy = await f.memory.readForSession('session-a')
  assert.equal(legacy.handoffRevision, 1)
  assert.equal(await readFile(path, 'utf8'), beforeRead)
  assert.equal((await f.state.read()).sceneMemory.version, 1)
  assert.equal((await oldSceneMemory.createSceneMemoryStore(f.state, {
    sceneIds: ['scene-a'], verifySession: async () => true,
  }).readForSession('session-a')).handoff.text, 'legacy handoff')

  await f.memory.appendProgress({ sessionId: 'session-a', entryId: 'new-progress', text: 'first v2 write' })
  const upgraded = (await f.state.read()).sceneMemory
  assert.equal(upgraded.version, 2)
  assert.equal(upgraded.scenes['scene-a'].journalOperations.progress['legacy-progress'].sourceSessionId, 'session-a')
  assert.equal(upgraded.scenes['scene-a'].handoffRevision, 1)
  const backups = await f.state.sceneMemorySnapshotFiles.listMigrationBackups()
  assert.equal(backups.length, 1)
  const backup = await f.state.sceneMemorySnapshotFiles.readMigrationBackup(backups[0])
  assert.deepEqual(backup.payload.memory, JSON.parse(beforeRead).sceneMemory)
  await assert.rejects(oldSceneMemory.createSceneMemoryStore(f.state, {
    sceneIds: ['scene-a'], verifySession: async () => true,
  }).readForSession('session-a'), { code: 'scene_memory_invalid' })
  const rollback = await fixture(t)
  await rollback.state.transact(state => { state.sceneMemory = backup.payload.memory })
  assert.equal((await oldSceneMemory.createSceneMemoryStore(rollback.state, {
    sceneIds: ['scene-a'], verifySession: async () => true,
  }).readForSession('session-a')).handoff.text, 'legacy handoff')
})

test('failed migration backup leaves the legacy state file byte-for-byte unchanged', async t => {
  const f = await fixture(t)
  await f.state.transact(state => {
    state.sceneMemory = { version: 1, scenes: {}, sessionScenes: {} }
  })
  const path = join(f.home, 'tradeloom-state', 'state.json')
  const before = await readFile(path)
  const failingState = await createStateStore({ env: f.env, _testHooks: {
    async rename(from, to, kind) {
      if (kind === 'scene-memory-migration-backup') {
        const err = new Error('test migration backup failure')
        err.code = 'EIO'
        throw err
      }
      const { rename } = await import('node:fs/promises')
      return rename(from, to)
    },
  } })
  const failingMemory = createSceneMemoryStore(failingState, { sceneIds: ['scene-a'], verifySession: async () => true })
  await assert.rejects(failingMemory.configureScene({
    sceneId: 'scene-a', expectedRevision: 0, responsibility: null, assetRefs: [], primarySkill: null,
  }), { code: 'scene_memory_migration_backup_failed' })
  assert.deepEqual(await readFile(path), before)
  assert.equal((await f.state.read()).sceneMemory.version, 1)
})

test('legacy handoff with no retained operation entry is backfilled when restoring its snapshot', async t => {
  const f = await fixture(t)
  await f.state.transact(state => {
    state.sceneMemory = {
      version: 1,
      scenes: { 'scene-a': {
        profile: { revision: 0, responsibility: null, assetRefs: [], primarySkill: null },
        handoff: { revision: 1, sourceSessionId: 'session-a', text: 'legacy handoff', updatedAt: '2026-10-30T00:00:00.000Z', operationId: 'constructor' },
        progress: [], decisions: [], operations: {}, bindingRevision: 1, rotations: {},
      } },
      sessionScenes: { 'session-a': 'scene-a' },
    }
  })
  const snapshot = await f.memory.captureSceneContentSnapshot('scene-a')
  await f.memory.appendProgress({ sessionId: 'session-a', entryId: 'trigger-upgrade', text: 'upgrade' })
  const preview = await f.memory.previewSceneContentRestore(snapshot.snapshotId, 'scene-a')
  await f.memory.restoreSceneContentSnapshot(preview.previewId, 'scene-a')
  const persisted = (await f.state.read()).sceneMemory.scenes['scene-a']
  assert.equal(Object.hasOwn(persisted.operations, 'constructor'), true)
  assert.deepEqual(persisted.operations.constructor, {
    kind: 'handoff', fingerprint: JSON.stringify(['session-a', 'legacy handoff']), revision: 1, sourceSessionId: 'session-a',
  })
})

test('migration backups do not mix with snapshots for valid scene IDs that resemble backup paths', async t => {
  const f = await fixture(t)
  await f.state.transact(state => {
    state.sceneMemory = {
      version: 1,
      scenes: Object.fromEntries(['migration-backup', 'scene-memory-migrations'].map(sceneId => [sceneId, {
        profile: { revision: 0, responsibility: null, assetRefs: [], primarySkill: null },
        handoff: null, progress: [], decisions: [], operations: {}, bindingRevision: 0, rotations: {},
      }])),
      sessionScenes: {},
    }
  })
  const sceneIds = ['migration-backup', 'scene-memory-migrations']
  const memory = createSceneMemoryStore(f.state, { sceneIds, verifySession: async () => true })
  const snapshots = new Map()
  for (const sceneId of sceneIds) snapshots.set(sceneId, await memory.captureSceneContentSnapshot(sceneId))
  await memory.bindSession({ sceneId: 'migration-backup', sessionId: 'session-a', expectedSessionId: null })

  for (const sceneId of sceneIds) {
    const snapshot = snapshots.get(sceneId)
    assert.deepEqual(await f.state.sceneMemorySnapshotFiles.list(sceneId), [snapshot.snapshotId])
    assert.equal((await f.state.sceneMemorySnapshotFiles.read(sceneId, snapshot.snapshotId)).payload.sceneId, sceneId)
  }
  const migrationBackups = await f.state.sceneMemorySnapshotFiles.listMigrationBackups()
  assert.equal(migrationBackups.length, 1)
  assert.notEqual(migrationBackups[0], snapshots.get('migration-backup').snapshotId)
  assert.equal((await f.state.sceneMemorySnapshotFiles.readMigrationBackup(migrationBackups[0])).kind, 'migration-backup')
})

test('content restore backfills missing row-ledger identities without clearing unrelated idempotency records', async t => {
  const f = await fixture(t)
  await seed(f.memory)
  const snapshot = await f.memory.captureSceneContentSnapshot('scene-a')
  await f.state.transact(state => {
    const scene = state.sceneMemory.scenes['scene-a']
    scene.progress = []
    delete scene.journalOperations.progress['progress-original']
    scene.journalOperations.progress['unrelated'] = {
      sourceSessionId: 'session-a', fingerprint: createHash('sha256').update('unrelated').digest('hex'),
    }
  })
  const preview = await f.memory.previewSceneContentRestore(snapshot.snapshotId, 'scene-a')
  await f.memory.restoreSceneContentSnapshot(preview.previewId, 'scene-a')
  const scene = (await f.state.read()).sceneMemory.scenes['scene-a']
  assert.equal(scene.progress[0].entryId, 'progress-original')
  assert.equal(scene.journalOperations.progress['progress-original'].sourceSessionId, 'session-a')
  assert.equal(scene.journalOperations.progress.unrelated.fingerprint, createHash('sha256').update('unrelated').digest('hex'))
})

test('restoring a null handoff advances its persistent counter and invalidates old graph cursors', async t => {
  const f = await fixture(t)
  await f.memory.configureScene({ sceneId: 'scene-a', expectedRevision: 0, responsibility: 'before', assetRefs: [], primarySkill: null })
  await f.memory.bindSession({ sceneId: 'scene-a', sessionId: 'session-a', expectedSessionId: null })
  await f.memory.appendProgress({ sessionId: 'session-a', entryId: 'p1', text: 'one' })
  await f.memory.appendProgress({ sessionId: 'session-a', entryId: 'p2', text: 'two' })
  const graphPage = await f.memory.readGraphForSession('session-a', { pageSize: 1 })
  assert.ok(graphPage.pagination.nextCursor)
  const snapshot = await f.memory.captureSceneContentSnapshot('scene-a')
  await f.memory.updateHandoff({ sessionId: 'session-a', operationId: 'h1', expectedRevision: 0, text: 'temporary' })
  const preview = await f.memory.previewSceneContentRestore(snapshot.snapshotId, 'scene-a')
  await f.memory.restoreSceneContentSnapshot(preview.previewId, 'scene-a')
  const restored = await f.memory.readForSession('session-a')
  assert.equal(restored.handoff, null)
  assert.equal(restored.handoffRevision, 2)
  await assert.rejects(f.memory.updateHandoff({
    sessionId: 'session-a', operationId: 'h2', expectedRevision: 1, text: 'stale expected revision',
  }), { code: 'scene_revision_conflict' })
  assert.equal((await f.memory.updateHandoff({
    sessionId: 'session-a', operationId: 'h3', expectedRevision: 2, text: 'after restore',
  })).revision, 3)
  await assert.rejects(f.memory.readGraphForSession('session-a', { pageSize: 1, cursor: graphPage.pagination.nextCursor }), {
    code: 'scene_graph_snapshot_changed',
  })
})

test('full content restore rejects append, binding, active rotation, and ledger conflicts without losing current state', async t => {
  const f = await fixture(t)
  await seed(f.memory)
  const snapshot = await f.memory.captureSceneContentSnapshot('scene-a')
  let preview = await f.memory.previewSceneContentRestore(snapshot.snapshotId, 'scene-a')
  await f.memory.appendProgress({ sessionId: 'session-a', entryId: 'concurrent', text: 'concurrent append' })
  await assert.rejects(f.memory.restoreSceneContentSnapshot(preview.previewId, 'scene-a'), { code: 'scene_content_restore_preview_stale' })
  assert.deepEqual((await f.memory.readForSession('session-a')).progress.map(row => row.entryId), ['progress-original', 'concurrent'])

  preview = await f.memory.previewSceneContentRestore(snapshot.snapshotId, 'scene-a')
  await f.memory.bindSession({ sceneId: 'scene-a', sessionId: 'session-a2', expectedSessionId: 'session-a' })
  await assert.rejects(f.memory.restoreSceneContentSnapshot(preview.previewId, 'scene-a'), { code: 'scene_content_restore_preview_stale' })

  const reopened = createSceneMemoryStore(await createStateStore({ env: f.env }), {
    sceneIds: ['scene-a', 'scene-b'], verifySession: async () => true,
  })
  const rotation = await reopened.getRotationSnapshot('scene-a')
  await reopened.beginRotation({
    sceneId: 'scene-a', operationId: 'rotation-active', oldSessionId: 'session-a2', plannedSessionId: 'session-a3',
    bindingRevision: rotation.bindingRevision, profileRevision: rotation.profileRevision,
    handoffRevision: rotation.handoffRevision, archiveOld: false, workspaceId: null, cwd: null, agentPreset: null,
  })
  await assert.rejects(reopened.previewSceneContentRestore(snapshot.snapshotId, 'scene-a'), { code: 'scene_rotation_in_progress' })

  const f2 = await fixture(t)
  await seed(f2.memory)
  const conflictSnapshot = await f2.memory.captureSceneContentSnapshot('scene-a')
  await f2.state.transact(state => {
    const scene = state.sceneMemory.scenes['scene-a']
    scene.progress[0].text = 'rewritten row'
    scene.journalOperations.progress['progress-original'].fingerprint = createHash('sha256')
      .update(JSON.stringify(['progress', 'session-a', 'rewritten row'])).digest('hex')
  })
  const conflictPreview = await f2.memory.previewSceneContentRestore(conflictSnapshot.snapshotId, 'scene-a')
  await assert.rejects(f2.memory.restoreSceneContentSnapshot(conflictPreview.previewId, 'scene-a'), {
    code: 'scene_content_snapshot_ledger_conflict',
  })
  assert.equal((await f2.memory.readForSession('session-a')).progress[0].text, 'rewritten row')
})

test('content backup or state commit failure leaves the source state unchanged', async t => {
  const f = await fixture(t)
  await seed(f.memory)
  const snapshot = await f.memory.captureSceneContentSnapshot('scene-a')
  await f.memory.configureScene({ sceneId: 'scene-a', expectedRevision: 1, responsibility: 'changed', assetRefs: [], primarySkill: null })
  const before = await readFile(join(f.home, 'tradeloom-state', 'state.json'))
  let failureKind = 'scene-memory-pre-restore-backup'
  const state = await createStateStore({ env: f.env, _testHooks: {
    async rename(from, to, kind) {
      if (kind === failureKind) {
        const err = new Error('injected atomic write failure')
        err.code = 'EIO'
        throw err
      }
      const { rename } = await import('node:fs/promises')
      return rename(from, to)
    },
  } })
  const memory = createSceneMemoryStore(state, { sceneIds: ['scene-a', 'scene-b'], verifySession: async () => true })
  let preview = await memory.previewSceneContentRestore(snapshot.snapshotId, 'scene-a')
  await assert.rejects(memory.restoreSceneContentSnapshot(preview.previewId, 'scene-a'), { code: 'scene_content_backup_write_failed' })
  assert.deepEqual(await readFile(join(f.home, 'tradeloom-state', 'state.json')), before)

  failureKind = 'state'
  preview = await memory.previewSceneContentRestore(snapshot.snapshotId, 'scene-a')
  await assert.rejects(memory.restoreSceneContentSnapshot(preview.previewId, 'scene-a'), { code: 'scene_content_state_commit_failed' })
  assert.deepEqual(await readFile(join(f.home, 'tradeloom-state', 'state.json')), before)
  const records = await memory.listSceneContentSnapshots('scene-a')
  assert.ok(records.some(record => record.kind === 'pre-restore-backup'))
})

test('snapshot previews are single-store and scene bound; cancelling performs no state write', async t => {
  const f = await fixture(t)
  await seed(f.memory)
  const snapshot = await f.memory.captureSceneContentSnapshot('scene-a')
  const other = await f.memory.captureSceneContentSnapshot('scene-b')
  const before = await readFile(join(f.home, 'tradeloom-state', 'state.json'))
  await assert.rejects(f.memory.exportSceneContentSnapshot(snapshot.snapshotId, 'scene-b'), { code: 'scene_content_snapshot_not_found' })
  const preview = await f.memory.previewSceneContentRestore(snapshot.snapshotId, 'scene-a')
  assert.equal(f.memory.cancelSceneContentRestore(preview.previewId, 'scene-b'), false)
  assert.equal(f.memory.cancelSceneContentRestore(preview.previewId, 'scene-a'), true)
  await assert.rejects(f.memory.restoreSceneContentSnapshot(preview.previewId, 'scene-a'), { code: 'scene_content_restore_preview_unavailable' })
  assert.deepEqual(await readFile(join(f.home, 'tradeloom-state', 'state.json')), before)

  const second = await fixture(t)
  const otherStore = second.memory
  const secondPreview = await f.memory.previewSceneContentRestore(other.snapshotId, 'scene-b')
  await assert.rejects(otherStore.restoreSceneContentSnapshot(secondPreview.previewId, 'scene-b'), {
    code: 'scene_content_restore_preview_unavailable',
  })
})

test('content snapshot checksum corruption is reported without changing state', async t => {
  const f = await fixture(t)
  await seed(f.memory)
  const snapshot = await f.memory.captureSceneContentSnapshot('scene-a')
  const statePath = join(f.home, 'tradeloom-state', 'state.json')
  const before = await readFile(statePath)
  const recordPath = join(f.home, 'tradeloom-state', 'snapshots', 'scene-memory', 'scene-a', `${snapshot.snapshotId}.json`)
  const record = JSON.parse(await readFile(recordPath, 'utf8'))
  record.payload.profile.responsibility = 'tampered'
  await writeFile(recordPath, JSON.stringify(record))
  await assert.rejects(f.memory.exportSceneContentSnapshot(snapshot.snapshotId, 'scene-a'), {
    code: 'scene_content_snapshot_checksum_mismatch',
  })
  assert.ok((await f.memory.listSceneContentSnapshots('scene-a')).some(row => row.status === 'invalid'
    && row.errorCode === 'scene_content_snapshot_checksum_mismatch'))
  assert.deepEqual(await readFile(statePath), before)
})

test('restore rejects a conflicting historical handoff idempotency identity', async t => {
  const f = await fixture(t)
  await seed(f.memory)
  const snapshot = await f.memory.captureSceneContentSnapshot('scene-a')
  await f.state.transact(state => {
    state.sceneMemory.scenes['scene-a'].operations['handoff-original'].fingerprint = JSON.stringify(['session-a', 'different'])
  })
  const preview = await f.memory.previewSceneContentRestore(snapshot.snapshotId, 'scene-a')
  await assert.rejects(f.memory.restoreSceneContentSnapshot(preview.previewId, 'scene-a'), {
    code: 'scene_content_snapshot_ledger_conflict',
  })
  assert.equal((await f.memory.readForSession('session-a')).handoff.text, 'handoff original')
})

test('built-in object-property names remain valid journal operation IDs and replay after row removal', async t => {
  const f = await fixture(t)
  await seed(f.memory)
  for (const [kind, entryId, text] of [
    ['progress', 'constructor', 'progress constructor'], ['progress', 'toString', 'progress tostring'],
    ['decisions', 'constructor', 'decision constructor'], ['decisions', 'toString', 'decision tostring'],
  ]) {
    const append = kind === 'progress' ? f.memory.appendProgress.bind(f.memory) : f.memory.appendDecision.bind(f.memory)
    await append({ sessionId: 'session-a', entryId, text })
  }
  await f.state.transact(state => {
    const scene = state.sceneMemory.scenes['scene-a']
    scene.progress = []
    scene.decisions = []
  })
  for (const [kind, entryId, text] of [
    ['progress', 'constructor', 'progress constructor'], ['progress', 'toString', 'progress tostring'],
    ['decisions', 'constructor', 'decision constructor'], ['decisions', 'toString', 'decision tostring'],
  ]) {
    const append = kind === 'progress' ? f.memory.appendProgress.bind(f.memory) : f.memory.appendDecision.bind(f.memory)
    assert.deepEqual(await append({ sessionId: 'session-a', entryId, text }), { sceneId: 'scene-a', entryId, replayed: true })
    await assert.rejects(append({ sessionId: 'session-a', entryId, text: `${text} changed` }), { code: 'scene_idempotency_conflict' })
  }
  assert.deepEqual((await f.memory.readForSession('session-a')).progress, [])
  assert.deepEqual((await f.memory.readForSession('session-a')).decisions, [])
})

test('profile restore surfaces migration-backup failure without committing version two', async t => {
  const f = await fixture(t)
  await f.state.transact(state => {
    state.sceneMemory = { version: 1, scenes: { 'scene-a': {
      profile: { revision: 0, responsibility: null, assetRefs: [], primarySkill: null },
      handoff: null, progress: [], decisions: [], operations: {}, bindingRevision: 0, rotations: {},
    } }, sessionScenes: {} }
  })
  const profileSnapshot = await f.memory.captureSceneProfileSnapshot('scene-a')
  const failingState = await createStateStore({ env: f.env, _testHooks: {
    async rename(from, to, kind) {
      if (kind === 'scene-memory-migration-backup') {
        const err = new Error('injected migration backup failure')
        err.code = 'EIO'
        throw err
      }
      const { rename } = await import('node:fs/promises')
      return rename(from, to)
    },
  } })
  const failingMemory = createSceneMemoryStore(failingState, { sceneIds: ['scene-a'], verifySession: async () => true })
  const preview = await failingMemory.previewSceneProfileRestore(profileSnapshot.snapshotId, 'scene-a')
  const path = join(f.home, 'tradeloom-state', 'state.json')
  const before = await readFile(path)
  await assert.rejects(failingMemory.restoreSceneProfileSnapshot(preview.previewId, 'scene-a'), {
    code: 'scene_memory_migration_backup_failed',
  })
  assert.deepEqual(await readFile(path), before)
})
