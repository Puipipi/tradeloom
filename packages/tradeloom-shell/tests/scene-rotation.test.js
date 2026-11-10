import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createStateStore, HOME_MARKER, HOME_MARKER_VALUE } from '../state.js'
import { createSceneMemoryStore } from '../scene-memory.js'
import { createSceneRotationController } from '../scene-rotation.js'

async function fixture(t, hooks = {}) {
  const root = await mkdtemp(join(tmpdir(), 'tradeloom-scene-rotation-'))
  const home = join(root, 'home')
  await mkdir(home, { recursive: true })
  await writeFile(join(home, HOME_MARKER), HOME_MARKER_VALUE)
  const env = { DSH_HOME: home, TRADELOOM_DSH_APP_HOME: home }
  const state = await createStateStore({ env })
  const live = new Set(['session-old', 'session-other'])
  const memory = createSceneMemoryStore(state, {
    sceneIds: ['scene-main'],
    verifySession: async ({ sessionId }) => live.has(sessionId),
    now: () => '2026-10-30T00:00:00.000Z',
  })
  await memory.configureScene({
    sceneId: 'scene-main', expectedRevision: 0, responsibility: '当前职责',
    assetRefs: [], primarySkill: null,
  })
  await memory.bindSession({ sceneId: 'scene-main', sessionId: 'session-old', expectedSessionId: null })
  await memory.updateHandoff({ sessionId: 'session-old', operationId: 'handoff-initial', expectedRevision: 0, text: '继续处理现有工作' })
  const sessions = new Map([
    ['session-old', { sessionId: 'session-old', cwd: '/workspace', agentPreset: 'tradeloom-product', workspaces: ['workspace-main'], turnCount: 1, userMessageCount: 1 }],
    ['session-other', { sessionId: 'session-other', cwd: '/workspace', agentPreset: 'tradeloom-product', workspaces: [], turnCount: 0, userMessageCount: 0 }],
  ])
  const counters = { creates: 0, flushes: 0, attaches: 0, archives: 0, sends: 0 }
  let seq = 0
  const adapter = {
    newSessionId: () => `session-planned-${++seq}`,
    inspectSession: async id => {
      const row = sessions.get(id)
      return row ? { ...row, workspaceIds: [...(row.workspaceIds ?? row.workspaces ?? [])] } : null
    },
    async createSession(input) {
      counters.creates += 1
      if (hooks.beforeCreate) await hooks.beforeCreate(input, { memory, sessions, live, counters })
      if (!sessions.has(input.sessionId)) {
        sessions.set(input.sessionId, {
          sessionId: input.sessionId, cwd: input.cwd, agentPreset: input.agentPreset,
          workspaces: input.workspaceId && !hooks.omitWorkspaceOnCreate ? [input.workspaceId] : [], turnCount: 0, userMessageCount: 0,
        })
        live.add(input.sessionId)
      }
      if (hooks.afterCreate) return await hooks.afterCreate(input, { memory, sessions, live, counters })
      return { sessionId: input.sessionId }
    },
    async flushSession(id) {
      counters.flushes += 1
      if (hooks.beforeFlush) await hooks.beforeFlush(id, { memory, sessions, live, counters })
      if (!sessions.has(id)) throw Object.assign(new Error(), { code: 'session_missing' })
    },
    async attachSession(workspaceId, id) {
      counters.attaches += 1
      if (hooks.beforeAttach) await hooks.beforeAttach(workspaceId, id, { memory, sessions, live, counters })
      const session = sessions.get(id)
      session.workspaces = [...new Set([...session.workspaces, workspaceId])]
    },
    async archiveSession(id) { counters.archives += 1; if (hooks.archive) await hooks.archive(id); sessions.get(id).archived = true },
    isArchived: async id => sessions.get(id)?.archived === true,
  }
  const rotation = createSceneRotationController({ sceneMemory: memory, adapter, now: () => '2026-10-30T00:01:00.000Z' })
  t.after(async () => { await rotation.dispose(); await rm(root, { recursive: true, force: true }) })
  return { root, home, env, state, memory, live, sessions, adapter, rotation, counters }
}

test('preview and cancellation do not write; confirmed rotation binds the empty session without sending a message', async t => {
  const f = await fixture(t)
  const statePath = join(f.home, 'tradeloom-state', 'state.json')
  const before = await readFile(statePath)
  const preview = await f.rotation.preview('scene-main', { archiveOld: true })
  assert.equal(preview.oldSessionId, 'session-old')
  assert.equal(preview.handoff.text, '继续处理现有工作')
  assert.ok(preview.bindingRevision >= 0)
  assert.equal(preview.plannedSessionId, 'session-planned-1')
  assert.deepEqual(await readFile(statePath), before)
  assert.equal(f.rotation.cancel(preview.previewId), true)
  assert.deepEqual(await readFile(statePath), before)

  const nextPreview = await f.rotation.preview('scene-main', { archiveOld: true })
  const result = await f.rotation.execute(nextPreview.previewId)
  assert.equal(result.phase, 'complete')
  assert.equal(f.counters.creates, 1)
  assert.equal(f.counters.sends, 0)
  assert.equal(await f.adapter.isArchived('session-old'), true)
  await assert.rejects(f.memory.readForSession('session-old'), { code: 'scene_session_not_bound' })
  const context = await f.memory.readForSession(nextPreview.plannedSessionId)
  assert.equal(context.handoff.text, '继续处理现有工作')
  assert.equal(context.handoff.sourceSessionId, 'session-old')
  assert.equal(context.handoff.revision, 1)
  assert.deepEqual(Object.keys((await f.state.read()).sceneMemory.sessionScenes), [nextPreview.plannedSessionId])
})

test('binding generation prevents preview ABA even when old session id returns', async t => {
  const f = await fixture(t)
  const preview = await f.rotation.preview('scene-main', { archiveOld: false })
  await f.memory.bindSession({ sceneId: 'scene-main', sessionId: 'session-other', expectedSessionId: 'session-old' })
  await f.memory.bindSession({ sceneId: 'scene-main', sessionId: 'session-old', expectedSessionId: 'session-other' })
  await assert.rejects(f.rotation.execute(preview.previewId), { code: 'scene_rotation_stale_preview' })
  assert.equal(f.counters.creates, 0)
})

test('same preview concurrent execution dispatches one exact planned session create', async t => {
  let release
  let started
  const gate = new Promise(resolve => { release = resolve })
  const began = new Promise(resolve => { started = resolve })
  const f = await fixture(t, { beforeCreate: async () => { started(); await gate } })
  const preview = await f.rotation.preview('scene-main', { archiveOld: false })
  const first = f.rotation.execute(preview.previewId)
  await began
  const second = f.rotation.execute(preview.previewId)
  release()
  const [a, b] = await Promise.all([first, second])
  assert.equal(f.counters.creates, 1)
  assert.equal(a.operationId, b.operationId)
  assert.equal(a.phase, 'complete')
  assert.equal(await f.adapter.isArchived('session-old'), false)
})

test('dispose waits for the controller-owned SDK create to settle', async t => {
  let release
  let started
  let disposed = false
  const gate = new Promise(resolve => { release = resolve })
  const began = new Promise(resolve => { started = resolve })
  const f = await fixture(t, { beforeCreate: async () => { started(); await gate } })
  const preview = await f.rotation.preview('scene-main', { archiveOld: false })
  const execution = f.rotation.execute(preview.previewId)
  await began
  const disposal = f.rotation.dispose().then(() => { disposed = true })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(disposed, false)
  release()
  const result = await execution
  await disposal
  assert.equal(result.phase, 'complete')
  assert.equal(disposed, true)
  assert.equal(f.counters.creates, 1)
})

test('separate store and memory wrappers for one owned file share the pending operation', async t => {
  let release
  let started
  const gate = new Promise(resolve => { release = resolve })
  const began = new Promise(resolve => { started = resolve })
  const f = await fixture(t, { beforeCreate: async () => { started(); await gate } })
  const secondState = await createStateStore({ env: f.env })
  const secondMemory = createSceneMemoryStore(secondState, {
    sceneIds: ['scene-main'],
    verifySession: async ({ sessionId }) => f.live.has(sessionId),
  })
  assert.equal(Object.keys(secondMemory).includes('rotationOwnerKey'), false)
  const secondRotation = createSceneRotationController({ sceneMemory: secondMemory, adapter: f.adapter })
  t.after(async () => { await secondRotation.dispose() })
  const preview = await f.rotation.preview('scene-main', { archiveOld: false })
  const first = f.rotation.execute(preview.previewId)
  await began
  const observer = secondRotation.resume(preview.operationId)
  await secondRotation.dispose()
  release()
  const [firstResult, observedResult] = await Promise.all([first, observer])
  assert.equal(f.counters.creates, 1)
  assert.equal(firstResult.operationId, observedResult.operationId)
  assert.equal(firstResult.phase, 'complete')
})

test('new SDK session is attached to its original workspace before the scene binding moves', async t => {
  const f = await fixture(t, { omitWorkspaceOnCreate: true })
  const preview = await f.rotation.preview('scene-main', { archiveOld: false })
  assert.equal(preview.workspaceId, 'workspace-main')
  const result = await f.rotation.execute(preview.previewId)
  assert.equal(result.phase, 'complete')
  assert.equal(f.counters.attaches, 1)
  assert.deepEqual((await f.adapter.inspectSession(preview.plannedSessionId)).workspaceIds, ['workspace-main'])
})

test('workspace attach failure is recoverable without creating a second session', async t => {
  let failOnce = true
  const f = await fixture(t, {
    omitWorkspaceOnCreate: true,
    beforeAttach: async () => {
      if (failOnce) { failOnce = false; throw Object.assign(new Error(), { code: 'fixture_attach_rejected' }) }
    },
  })
  const preview = await f.rotation.preview('scene-main', { archiveOld: false })
  const first = await f.rotation.execute(preview.previewId)
  assert.equal(first.phase, 'session_created')
  assert.equal(first.errorCode, 'scene_rotation_workspace_mismatch')
  const result = await f.rotation.resume(first.operationId)
  assert.equal(result.phase, 'complete')
  assert.equal(f.counters.creates, 1)
  assert.deepEqual((await f.adapter.inspectSession(preview.plannedSessionId)).workspaceIds, ['workspace-main'])
})

test('flush failure remains recoverable from the exact persisted session id', async t => {
  let failOnce = true
  const f = await fixture(t, {
    beforeFlush: async () => {
      if (failOnce) { failOnce = false; throw Object.assign(new Error(), { code: 'fixture_flush_failed' }) }
    },
  })
  const preview = await f.rotation.preview('scene-main', { archiveOld: false })
  const first = await f.rotation.execute(preview.previewId)
  assert.equal(first.phase, 'session_created')
  assert.equal(first.createdSessionId, preview.plannedSessionId)
  const result = await f.rotation.resume(first.operationId)
  assert.equal(result.phase, 'complete')
  assert.equal(f.counters.creates, 1)
})

test('reopened state snapshot discovers pending operation and resumes its exact planned session once', async t => {
  let failOnce = true
  const f = await fixture(t, {
    beforeFlush: async () => {
      if (failOnce) { failOnce = false; throw Object.assign(new Error(), { code: 'fixture_flush_failed' }) }
    },
  })
  await (async () => {
    const preview = await f.rotation.preview('scene-main', { archiveOld: false })
    const first = await f.rotation.execute(preview.previewId)
    assert.equal(first.phase, 'session_created')
  })()
  assert.equal(f.counters.creates, 1)
  await f.rotation.dispose()

  const reopenedState = await createStateStore({ env: f.env })
  const reopenedMemory = createSceneMemoryStore(reopenedState, {
    sceneIds: ['scene-main'],
    verifySession: async ({ sessionId }) => f.live.has(sessionId),
    now: () => '2026-10-30T00:02:00.000Z',
  })
  const snapshot = await reopenedMemory.getRotationSnapshot('scene-main')
  assert.equal(snapshot.pendingOperationIds.length, 1)
  const [discoveredOperationId] = snapshot.pendingOperationIds
  const rotationAfterReopen = createSceneRotationController({ sceneMemory: reopenedMemory, adapter: f.adapter })
  t.after(() => rotationAfterReopen.dispose())

  const persisted = await rotationAfterReopen.getOperation(discoveredOperationId)
  assert.equal(persisted.phase, 'session_created')
  assert.equal(persisted.plannedSessionId, persisted.createdSessionId)
  const resumed = await rotationAfterReopen.resume(discoveredOperationId)
  assert.equal(resumed.phase, 'complete')
  assert.equal(resumed.createdSessionId, persisted.plannedSessionId)
  assert.equal(f.counters.creates, 1)
  assert.deepEqual((await reopenedMemory.getRotationSnapshot('scene-main')).pendingOperationIds, [])
})

test('create response loss is recovered by exact planned-id lookup without a second create', async t => {
  const f = await fixture(t, { afterCreate: async input => { throw Object.assign(new Error('response lost'), { code: 'transport_lost' }) } })
  const preview = await f.rotation.preview('scene-main', { archiveOld: false })
  const result = await f.rotation.execute(preview.previewId)
  assert.equal(result.phase, 'complete')
  assert.equal(result.createdSessionId, preview.plannedSessionId)
  assert.equal(f.counters.creates, 1)
  assert.ok(f.counters.flushes >= 1)
})

test('empty create response is resolved only by exact planned-id lookup', async t => {
  const f = await fixture(t, { afterCreate: async () => ({}) })
  const preview = await f.rotation.preview('scene-main', { archiveOld: false })
  const result = await f.rotation.execute(preview.previewId)
  assert.equal(result.phase, 'complete')
  assert.equal(result.createdSessionId, preview.plannedSessionId)
  assert.equal(f.counters.creates, 1)
})

test('SDK identity mismatch is retained for review and never rebound', async t => {
  const f = await fixture(t, { afterCreate: async () => ({ sessionId: 'session-other' }) })
  const preview = await f.rotation.preview('scene-main', { archiveOld: false })
  const result = await f.rotation.execute(preview.previewId)
  assert.equal(result.phase, 'needs_review')
  assert.equal(result.errorCode, 'scene_rotation_session_mismatch')
  assert.equal(result.createdSessionId, 'session-other')
  assert.equal((await f.state.read()).sceneMemory.sessionScenes['session-old'], 'scene-main')
  assert.equal(f.counters.creates, 1)
})

test('needs-review rotation can be explicitly abandoned without undoing or relabeling SDK state', async t => {
  const f = await fixture(t, { afterCreate: async () => ({ sessionId: 'session-other' }) })
  const preview = await f.rotation.preview('scene-main', { archiveOld: false })
  const mismatch = await f.rotation.execute(preview.previewId)
  assert.equal(mismatch.phase, 'needs_review')
  const abandoned = await f.rotation.abandon(mismatch.operationId)
  assert.equal(abandoned.phase, 'abandoned')
  assert.equal(abandoned.oldSessionId, 'session-old')
  assert.equal(abandoned.plannedSessionId, preview.plannedSessionId)
  assert.equal(abandoned.createdSessionId, 'session-other')
  assert.equal(abandoned.errorCode, 'scene_rotation_session_mismatch')
  assert.equal(f.sessions.has('session-other'), true)
  assert.equal((await f.memory.readForSession('session-old')).sceneId, 'scene-main')
  assert.deepEqual((await f.memory.getRotationSnapshot('scene-main')).pendingOperationIds, [])

  assert.deepEqual(await f.rotation.resume(mismatch.operationId), abandoned)
  assert.equal((await f.memory.getRotationOperation(mismatch.operationId)).phase, 'abandoned')
  assert.equal(f.counters.creates, 1)
  const next = await f.rotation.preview('scene-main', { archiveOld: false })
  assert.notEqual(next.operationId, mismatch.operationId)
  const rebound = await f.memory.bindSession({ sceneId: 'scene-main', sessionId: 'session-other', expectedSessionId: 'session-old' })
  assert.equal(rebound.sessionId, 'session-other')
  assert.equal((await f.memory.getRotationOperation(mismatch.operationId)).createdSessionId, 'session-other')
})

test('abandon rejects while an SDK operation is unsettled and does not release its in-flight task', async t => {
  let releaseCreate
  let startedCreate
  const createGate = new Promise(resolve => { releaseCreate = resolve })
  const createStarted = new Promise(resolve => { startedCreate = resolve })
  const f = await fixture(t, {
    beforeCreate: async () => { startedCreate(); await createGate },
  })
  const preview = await f.rotation.preview('scene-main', { archiveOld: false })
  const executing = f.rotation.execute(preview.previewId)
  await createStarted
  await assert.rejects(f.rotation.abandon(preview.operationId), { code: 'scene_rotation_in_progress' })
  let resumed = false
  const observing = f.rotation.resume(preview.operationId).then(result => { resumed = true; return result })
  await Promise.resolve()
  assert.equal(resumed, false)
  releaseCreate()
  const completed = await executing
  assert.equal(completed.phase, 'complete')
  assert.equal((await observing).phase, 'complete')
  assert.equal(f.counters.creates, 1)
})

test('stale handoff after creation requires a fresh recovery preview and never recreates', async t => {
  let changed = false
  const f = await fixture(t, {
    beforeCreate: async (_input, { memory }) => {
      if (!changed) {
        changed = true
        await memory.updateHandoff({ sessionId: 'session-old', operationId: 'handoff-concurrent', expectedRevision: 1, text: '期间更新的交接' })
      }
    },
  })
  const preview = await f.rotation.preview('scene-main', { archiveOld: false })
  const first = await f.rotation.execute(preview.previewId)
  assert.equal(first.phase, 'needs_review')
  assert.equal(f.counters.creates, 1)
  const recovery = await f.rotation.preview('scene-main', { archiveOld: false, recoverOperationId: first.operationId })
  assert.equal(recovery.plannedSessionId, preview.plannedSessionId)
  const resumed = await f.rotation.execute(recovery.previewId)
  assert.equal(resumed.phase, 'complete')
  assert.equal(f.counters.creates, 1)
  const context = await f.memory.readForSession(preview.plannedSessionId)
  assert.equal(context.handoff.text, '期间更新的交接')
})

test('recovery preview cannot adopt handoff changes made after it was shown', async t => {
  let changed = false
  const f = await fixture(t, {
    beforeCreate: async (_input, { memory }) => {
      if (!changed) {
        changed = true
        await memory.updateHandoff({ sessionId: 'session-old', operationId: 'handoff-before-recovery', expectedRevision: 1, text: '初次变化' })
      }
    },
  })
  const firstPreview = await f.rotation.preview('scene-main', { archiveOld: false })
  const needsReview = await f.rotation.execute(firstPreview.previewId)
  assert.equal(needsReview.phase, 'needs_review')
  const recovery = await f.rotation.preview('scene-main', { archiveOld: false, recoverOperationId: needsReview.operationId })
  await f.memory.updateHandoff({ sessionId: 'session-old', operationId: 'handoff-after-recovery-preview', expectedRevision: 2, text: '预览之后变化' })
  await assert.rejects(f.rotation.execute(recovery.previewId), { code: 'scene_rotation_stale_preview' })
  assert.equal(f.counters.creates, 1)
  assert.equal((await f.memory.readForSession('session-old')).handoff.text, '预览之后变化')
})

test('conflicting archive choices cannot join an in-flight recovery under the other preview', async t => {
  let firstChange = false
  let deferFlush = false
  let release
  let started
  const gate = new Promise(resolve => { release = resolve })
  const began = new Promise(resolve => { started = resolve })
  const f = await fixture(t, {
    beforeCreate: async (_input, { memory }) => {
      if (!firstChange) {
        firstChange = true
        await memory.updateHandoff({ sessionId: 'session-old', operationId: 'handoff-recovery-conflict', expectedRevision: 1, text: '需要复核' })
      }
    },
    beforeFlush: async () => { if (deferFlush) { started(); await gate } },
  })
  const initial = await f.rotation.preview('scene-main', { archiveOld: false })
  const needsReview = await f.rotation.execute(initial.previewId)
  assert.equal(needsReview.phase, 'needs_review')
  const keep = await f.rotation.preview('scene-main', { archiveOld: false, recoverOperationId: needsReview.operationId })
  const archive = await f.rotation.preview('scene-main', { archiveOld: true, recoverOperationId: needsReview.operationId })
  deferFlush = true
  const completing = f.rotation.execute(keep.previewId)
  await began
  await assert.rejects(f.rotation.execute(archive.previewId), { code: 'scene_rotation_in_progress' })
  release()
  const result = await completing
  assert.equal(result.phase, 'complete')
  assert.equal(result.archiveOld, false)
  assert.equal(f.counters.creates, 1)
  assert.equal(await f.adapter.isArchived('session-old'), false)
})

test('active old session archive failure remains recoverable without creating another session', async t => {
  let active = true
  const f = await fixture(t, { archive: async () => { if (active) throw Object.assign(new Error(), { code: 'workspace/session-active' }) } })
  const preview = await f.rotation.preview('scene-main', { archiveOld: true })
  const pending = await f.rotation.execute(preview.previewId)
  assert.equal(pending.phase, 'archive_pending')
  assert.equal(pending.errorCode, 'scene_rotation_archive_failed')
  active = false
  const result = await f.rotation.resume(pending.operationId)
  assert.equal(result.phase, 'complete')
  assert.equal(f.counters.creates, 1)
  assert.equal(await f.adapter.isArchived('session-old'), true)
})
