import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { HOME_MARKER, HOME_MARKER_VALUE, createStateStore } from '../state.js'
import { createSceneMemoryStore } from '../scene-memory.js'

async function fixture(t, hooks) {
  const root = await mkdtemp(join(tmpdir(), 'tradeloom-scene-profile-snapshots-'))
  const home = join(root, 'home')
  await mkdir(home, { recursive: true })
  await writeFile(join(home, HOME_MARKER), HOME_MARKER_VALUE)
  const env = { DSH_HOME: home, TRADELOOM_DSH_APP_HOME: home }
  const state = await createStateStore({ env, ...(hooks ? { _testHooks: hooks } : {}) })
  const memory = createSceneMemoryStore(state, {
    sceneIds: ['scene-a', 'scene-b'],
    verifySession: async () => true,
    now: () => '2026-10-31T00:00:00.000Z',
  })
  await memory.configureScene({
    sceneId: 'scene-a', expectedRevision: 0, responsibility: 'A initial',
    assetRefs: [{ kind: 'artifact', id: 'a-original' }], primarySkill: 'product-review',
  })
  await memory.configureScene({
    sceneId: 'scene-b', expectedRevision: 0, responsibility: 'B protected',
    assetRefs: [{ kind: 'business-route', id: '/business/b' }], primarySkill: null,
  })
  await memory.bindSession({ sceneId: 'scene-a', sessionId: 'session-a', expectedSessionId: null })
  await memory.bindSession({ sceneId: 'scene-b', sessionId: 'session-b', expectedSessionId: null })
  t.after(() => rm(root, { recursive: true, force: true }))
  return { root, home, env, state, memory }
}

async function changeProfile(memory, sceneId, expectedRevision, value) {
  return await memory.configureScene({ sceneId, expectedRevision, ...value })
}

function rotationInput(snapshot) {
  return {
    sceneId: snapshot.sceneId, operationId: 'rotation-active', oldSessionId: snapshot.oldSessionId,
    plannedSessionId: 'session-planned', bindingRevision: snapshot.bindingRevision,
    profileRevision: snapshot.profileRevision, handoffRevision: snapshot.handoffRevision,
    archiveOld: false, workspaceId: 'workspace-a', cwd: 'C:/workspace-a', agentPreset: 'tradeloom-product',
  }
}

test('scene profile snapshot restores only one scene with monotonic revision and preserves memory ledgers', async t => {
  const f = await fixture(t)
  await f.memory.updateHandoff({ sessionId: 'session-a', operationId: 'handoff-1', expectedRevision: 0, text: 'handoff stays' })
  await f.memory.appendProgress({ sessionId: 'session-a', entryId: 'progress-1', text: 'progress stays' })
  await f.memory.appendDecision({ sessionId: 'session-a', entryId: 'decision-1', text: 'decision stays' })
  await f.state.transact(state => { state.futureRuntimeFlag = { keep: true } })

  const saved = await f.memory.captureSceneProfileSnapshot('scene-a')
  assert.equal(saved.scope, 'tradeloom-scene-profile/v1')
  assert.equal(saved.kind, 'capture')
  assert.equal(saved.sceneId, 'scene-a')
  assert.match(saved.snapshotId, /^[0-9a-f-]{36}$/)
  assert.match(saved.payloadSha256, /^[0-9a-f]{64}$/)
  assert.equal((await f.memory.listSceneProfileSnapshots('scene-a')).length, 1)
  assert.deepEqual(await f.memory.listSceneProfileSnapshots('scene-b'), [])
  await assert.rejects(f.memory.exportSceneProfileSnapshot(saved.snapshotId, 'scene-b'), { code: 'scene_profile_snapshot_not_found' })
  const exported = await f.memory.exportSceneProfileSnapshot(saved.snapshotId, 'scene-a')
  assert.deepEqual(exported.payload.profile, {
    revision: 1, responsibility: 'A initial', assetRefs: [{ kind: 'artifact', id: 'a-original' }], primarySkill: 'product-review',
  })

  await changeProfile(f.memory, 'scene-a', 1, {
    responsibility: 'A changed', assetRefs: [{ kind: 'artifact', id: 'a-current' }], primarySkill: null,
  })
  const bytesBeforePreview = await readFile(f.state.paths.statePath)
  const cancelled = await f.memory.previewSceneProfileRestore(saved.snapshotId, 'scene-a')
  assert.deepEqual(cancelled.changedFields, ['responsibility', 'assetRefs', 'primarySkill'])
  assert.deepEqual(await readFile(f.state.paths.statePath), bytesBeforePreview)
  assert.equal(await f.memory.cancelSceneProfileRestore(cancelled.previewId, 'scene-a'), true)
  assert.deepEqual(await readFile(f.state.paths.statePath), bytesBeforePreview)

  const preview = await f.memory.previewSceneProfileRestore(saved.snapshotId, 'scene-a')
  const result = await f.memory.restoreSceneProfileSnapshot(preview.previewId, 'scene-a')
  assert.equal(result.status, 'restored')
  assert.equal(result.backup.kind, 'pre-restore-backup')
  const reopened = createSceneMemoryStore(await createStateStore({ env: f.env }), {
    sceneIds: ['scene-a', 'scene-b'], verifySession: async () => true,
  })
  const after = await (await createStateStore({ env: f.env })).read()
  const a = await reopened.readForSession('session-a')
  const b = await reopened.readForSession('session-b')
  assert.deepEqual(a.profile, {
    revision: 3, responsibility: 'A initial', assetRefs: [{ kind: 'artifact', id: 'a-original' }], primarySkill: 'product-review',
  })
  assert.equal(a.handoff.text, 'handoff stays')
  assert.deepEqual(a.progress.map(row => row.text), ['progress stays'])
  assert.deepEqual(a.decisions.map(row => row.text), ['decision stays'])
  assert.equal(b.profile.responsibility, 'B protected')
  assert.deepEqual(after.futureRuntimeFlag, { keep: true })
  assert.equal(after.sceneMemory.sessionScenes['session-a'], 'scene-a')
  assert.equal(after.sceneMemory.scenes['scene-a'].bindingRevision, 1)
  await assert.rejects(f.memory.restoreSceneProfileSnapshot(preview.previewId, 'scene-a'), { code: 'scene_profile_restore_preview_unavailable' })
})

test('profile restore rejects changed profile, binding and active rotation without touching other partitions', async t => {
  const f = await fixture(t)
  const snapshot = await f.memory.captureSceneProfileSnapshot('scene-a')
  const staleProfile = await f.memory.previewSceneProfileRestore(snapshot.snapshotId, 'scene-a')
  await changeProfile(f.memory, 'scene-a', 1, { responsibility: 'new', assetRefs: [], primarySkill: null })
  const before = await readFile(f.state.paths.statePath)
  await assert.rejects(f.memory.restoreSceneProfileSnapshot(staleProfile.previewId, 'scene-a'), { code: 'scene_profile_restore_preview_stale' })
  assert.deepEqual(await readFile(f.state.paths.statePath), before)

  const staleBinding = await f.memory.previewSceneProfileRestore(snapshot.snapshotId, 'scene-a')
  await f.memory.bindSession({ sceneId: 'scene-a', sessionId: 'session-a2', expectedSessionId: 'session-a' })
  const reboundBytes = await readFile(f.state.paths.statePath)
  await assert.rejects(f.memory.restoreSceneProfileSnapshot(staleBinding.previewId, 'scene-a'), { code: 'scene_profile_restore_preview_stale' })
  assert.deepEqual(await readFile(f.state.paths.statePath), reboundBytes)

  const activePreview = await f.memory.previewSceneProfileRestore(snapshot.snapshotId, 'scene-a')
  await f.memory.updateHandoff({ sessionId: 'session-a2', operationId: 'handoff-start', expectedRevision: 0, text: 'rotation prerequisite' })
  const rotation = await f.memory.getRotationSnapshot('scene-a')
  await f.memory.beginRotation(rotationInput(rotation))
  const activeBytes = await readFile(f.state.paths.statePath)
  await assert.rejects(f.memory.restoreSceneProfileSnapshot(activePreview.previewId, 'scene-a'), { code: 'scene_rotation_in_progress' })
  assert.deepEqual(await readFile(f.state.paths.statePath), activeBytes)
})

test('corrupt profile snapshot checksum and cross-scene use are rejected', async t => {
  const f = await fixture(t)
  const snapshot = await f.memory.captureSceneProfileSnapshot('scene-a')
  const file = join(f.home, 'tradeloom-state', 'snapshots', 'scene-profile', 'scene-a', `${snapshot.snapshotId}.json`)
  const record = JSON.parse(await readFile(file, 'utf8'))
  record.payload.profile.responsibility = 'tampered'
  await writeFile(file, JSON.stringify(record))
  await assert.rejects(f.memory.exportSceneProfileSnapshot(snapshot.snapshotId, 'scene-a'), { code: 'scene_profile_snapshot_checksum_mismatch' })
  await assert.rejects(f.memory.previewSceneProfileRestore(snapshot.snapshotId, 'scene-b'), { code: 'scene_profile_snapshot_not_found' })
})

test('preview tokens are bound to one owned store and scene, and cannot be cancelled after restore begins', async t => {
  let backupStarted
  let releaseBackup
  const started = new Promise(resolve => { backupStarted = resolve })
  const hold = new Promise(resolve => { releaseBackup = resolve })
  const f = await fixture(t, {
    async afterSnapshotWrite({ kind }) {
      if (kind === 'scene-profile-pre-restore-backup') {
        backupStarted()
        await hold
      }
    },
  })
  const snapshot = await f.memory.captureSceneProfileSnapshot('scene-a')
  await changeProfile(f.memory, 'scene-a', 1, { responsibility: 'changed', assetRefs: [], primarySkill: null })
  const preview = await f.memory.previewSceneProfileRestore(snapshot.snapshotId, 'scene-a')

  const otherRoot = await mkdtemp(join(tmpdir(), 'tradeloom-scene-profile-other-store-'))
  const otherHome = join(otherRoot, 'home')
  await mkdir(otherHome, { recursive: true })
  await writeFile(join(otherHome, HOME_MARKER), HOME_MARKER_VALUE)
  t.after(() => rm(otherRoot, { recursive: true, force: true }))
  const otherStore = await createStateStore({ env: { DSH_HOME: otherHome, TRADELOOM_DSH_APP_HOME: otherHome } })
  const otherMemory = createSceneMemoryStore(otherStore, { sceneIds: ['scene-a'], verifySession: async () => true })
  await assert.rejects(otherMemory.restoreSceneProfileSnapshot(preview.previewId, 'scene-a'), { code: 'scene_profile_restore_preview_unavailable' })
  assert.equal(await otherMemory.cancelSceneProfileRestore(preview.previewId, 'scene-a'), false)

  const applying = f.memory.restoreSceneProfileSnapshot(preview.previewId, 'scene-a')
  await started
  assert.equal(f.memory.cancelSceneProfileRestore(preview.previewId, 'scene-a'), false)
  releaseBackup()
  assert.equal((await applying).status, 'restored')
})

test('snapshot operations reject a scene outside the trusted catalog', async t => {
  const f = await fixture(t)
  await assert.rejects(f.memory.captureSceneProfileSnapshot('scene-not-registered'), { code: 'scene_not_found' })
  assert.deepEqual(await f.memory.listSceneProfileSnapshots('scene-not-registered').catch(error => error.code), 'scene_not_found')
})

test('backup verification and state atomic commit failure leave original state bytes intact', async t => {
  let corruptBackup = false
  let failBackupWrite = false
  let failStateCommit = false
  const f = await fixture(t, {
    async afterSnapshotWrite({ kind, path }) {
      if (kind === 'scene-profile-pre-restore-backup' && corruptBackup) await writeFile(path, '{bad backup')
    },
    async rename(source, target, kind) {
      if (kind === 'scene-profile-pre-restore-backup' && failBackupWrite) throw Object.assign(new Error('test backup rename failure'), { code: 'EIO' })
      if (kind === 'state' && failStateCommit) throw Object.assign(new Error('test state rename failure'), { code: 'EIO' })
      return await rename(source, target)
    },
  })
  const snapshot = await f.memory.captureSceneProfileSnapshot('scene-a')
  await changeProfile(f.memory, 'scene-a', 1, { responsibility: 'changed', assetRefs: [], primarySkill: null })
  const original = await readFile(f.state.paths.statePath)

  corruptBackup = true
  const backupPreview = await f.memory.previewSceneProfileRestore(snapshot.snapshotId, 'scene-a')
  await assert.rejects(f.memory.restoreSceneProfileSnapshot(backupPreview.previewId, 'scene-a'), { code: 'scene_profile_backup_verification_failed' })
  assert.deepEqual(await readFile(f.state.paths.statePath), original)
  corruptBackup = false

  failBackupWrite = true
  const writePreview = await f.memory.previewSceneProfileRestore(snapshot.snapshotId, 'scene-a')
  await assert.rejects(f.memory.restoreSceneProfileSnapshot(writePreview.previewId, 'scene-a'), { code: 'scene_profile_backup_write_failed' })
  assert.deepEqual(await readFile(f.state.paths.statePath), original)
  failBackupWrite = false

  failStateCommit = true
  const commitPreview = await f.memory.previewSceneProfileRestore(snapshot.snapshotId, 'scene-a')
  await assert.rejects(f.memory.restoreSceneProfileSnapshot(commitPreview.previewId, 'scene-a'), { code: 'scene_profile_state_commit_failed' })
  assert.deepEqual(await readFile(f.state.paths.statePath), original)
  failStateCommit = false
  assert.ok((await readdir(join(f.home, 'tradeloom-state', 'snapshots', 'scene-profile', 'scene-a'))).length >= 3)
})

test('profile preview cursor is invalidated by the restored profile revision', async t => {
  const f = await fixture(t)
  await changeProfile(f.memory, 'scene-a', 1, {
    responsibility: 'before graph',
    assetRefs: [{ kind: 'artifact', id: 'one' }, { kind: 'artifact', id: 'two' }],
    primarySkill: null,
  })
  const saved = await f.memory.captureSceneProfileSnapshot('scene-a')
  await changeProfile(f.memory, 'scene-a', 2, { responsibility: 'changed', assetRefs: [], primarySkill: null })
  const cursor = await f.memory.readGraphForSession('session-a', { pageSize: 1 })
  assert.ok(cursor.pagination.nextCursor)
  const preview = await f.memory.previewSceneProfileRestore(saved.snapshotId, 'scene-a')
  await f.memory.restoreSceneProfileSnapshot(preview.previewId, 'scene-a')
  await assert.rejects(f.memory.readGraphForSession('session-a', { cursor: cursor.pagination.nextCursor }),
    { code: 'scene_graph_snapshot_changed' })
})
