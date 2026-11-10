import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { registerBusinessTools } from '../business-tools.js'
import { createStateStore, HOME_MARKER, HOME_MARKER_VALUE } from '../state.js'
import { createSceneMemoryStore } from '../scene-memory.js'
import { ROLE_PRESETS } from '../roles.js'

async function fixture(t, options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'tradeloom-scene-memory-'))
  const home = join(root, 'home')
  await mkdir(home, { recursive: true })
  await writeFile(join(home, HOME_MARKER), HOME_MARKER_VALUE)
  const env = { DSH_HOME: home, TRADELOOM_DSH_APP_HOME: home }
  const state = await createStateStore({ env, ...(options.testHooks ? { _testHooks: options.testHooks } : {}) })
  const liveSessions = new Set(['session-a', 'session-b', 'session-a2'])
  const memory = createSceneMemoryStore(state, {
    sceneIds: ['scene-a', 'scene-b'],
    verifySession: async ({ sessionId }) => liveSessions.has(sessionId),
    now: () => '2026-10-30T00:00:00.000Z',
  })
  t.after(async () => { await rm(root, { recursive: true, force: true }) })
  return { root, home, env, state, memory, liveSessions }
}

async function configureAndBind(memory) {
  await memory.configureScene({
    sceneId: 'scene-a', expectedRevision: 0,
    responsibility: '实际商品交接', assetRefs: [{ kind: 'business-route', id: '/products', label: '商品' }],
    primarySkill: 'product-review',
  })
  await memory.configureScene({
    sceneId: 'scene-b', expectedRevision: 0,
    responsibility: '实际交付交接', assetRefs: [{ kind: 'artifact', id: 'catalog-current' }], primarySkill: null,
  })
  await memory.bindSession({ sceneId: 'scene-a', sessionId: 'session-a', expectedSessionId: null })
  await memory.bindSession({ sceneId: 'scene-b', sessionId: 'session-b', expectedSessionId: null })
}

test('scene records isolate scenes, survive reopen, and follow only the newly bound session', async t => {
  const f = await fixture(t)
  await configureAndBind(f.memory)
  const handoff = await f.memory.updateHandoff({
    sessionId: 'session-a', operationId: 'handoff-1', expectedRevision: 0, text: '实际交接内容 A',
  })
  assert.deepEqual(handoff, { sceneId: 'scene-a', revision: 1, replayed: false })
  assert.deepEqual(await f.memory.updateHandoff({
    sessionId: 'session-a', operationId: 'handoff-1', expectedRevision: 0, text: '实际交接内容 A',
  }), { sceneId: 'scene-a', revision: 1, replayed: true })
  await assert.rejects(f.memory.updateHandoff({
    sessionId: 'session-a', operationId: 'handoff-1', expectedRevision: 0, text: '不同内容',
  }), { code: 'scene_idempotency_conflict' })
  await f.memory.appendProgress({ sessionId: 'session-a', entryId: 'progress-1', text: '进度记录' })
  assert.deepEqual(await f.memory.appendProgress({ sessionId: 'session-a', entryId: 'progress-1', text: '进度记录' }),
    { sceneId: 'scene-a', entryId: 'progress-1', replayed: true })
  await assert.rejects(f.memory.appendProgress({ sessionId: 'session-a', entryId: 'progress-1', text: '不同进度' }),
    { code: 'scene_idempotency_conflict' })
  await f.memory.appendDecision({ sessionId: 'session-a', entryId: 'decision-1', text: '长期决策' })

  const a = await f.memory.readForSession('session-a')
  const b = await f.memory.readForSession('session-b')
  assert.equal(a.sceneId, 'scene-a')
  assert.equal(a.handoff.text, '实际交接内容 A')
  assert.equal(a.profile.primarySkill, 'product-review')
  assert.equal(a.progress.length, 1)
  assert.equal(a.decisions.length, 1)
  assert.equal(b.sceneId, 'scene-b')
  assert.equal(b.handoff, null)
  assert.equal(b.profile.responsibility, '实际交付交接')
  assert.deepEqual(b.progress, [])

  await f.memory.bindSession({ sceneId: 'scene-a', sessionId: 'session-a2', expectedSessionId: 'session-a' })
  await assert.rejects(f.memory.readForSession('session-a'), { code: 'scene_session_not_bound' })
  const reopened = createSceneMemoryStore(await createStateStore({ env: f.env }), {
    sceneIds: ['scene-a', 'scene-b'], verifySession: async ({ sessionId }) => f.liveSessions.has(sessionId),
    now: () => '2026-10-30T00:00:00.000Z',
  })
  const next = await reopened.readForSession('session-a2')
  assert.equal(next.handoff.text, '实际交接内容 A')
  assert.equal(next.progress[0].text, '进度记录')
  assert.equal(next.decisions[0].text, '长期决策')
  assert.deepEqual((await f.state.read()).roles, {})
})

test('binding requires trusted live-session verification and prevents one session from owning two scenes', async t => {
  const f = await fixture(t)
  await f.memory.configureScene({ sceneId: 'scene-a', expectedRevision: 0, responsibility: null, assetRefs: [], primarySkill: null })
  await f.memory.configureScene({ sceneId: 'scene-b', expectedRevision: 0, responsibility: null, assetRefs: [], primarySkill: null })
  await assert.rejects(f.memory.configureScene({ sceneId: 'scene-c', expectedRevision: 0, responsibility: null, assetRefs: [], primarySkill: null }), { code: 'scene_not_found' })
  await assert.rejects(f.memory.configureScene({ sceneId: 'scene-a', expectedRevision: 0, responsibility: null, assetRefs: [{ kind: 'artifact', id: 'x', path: 'C:/outside' }], primarySkill: null }), { code: 'invalid_arguments' })
  await assert.rejects(f.memory.bindSession({ sceneId: 'scene-a', sessionId: 'session-unknown', expectedSessionId: null }), { code: 'scene_session_unverified' })
  await f.memory.bindSession({ sceneId: 'scene-a', sessionId: 'session-a', expectedSessionId: null })
  await assert.rejects(f.memory.bindSession({ sceneId: 'scene-b', sessionId: 'session-a', expectedSessionId: null }), { code: 'scene_session_conflict' })
  await assert.rejects(f.memory.bindSession({ sceneId: 'scene-a', sessionId: 'session-b', expectedSessionId: null }), { code: 'scene_binding_conflict' })
  await assert.rejects(f.memory.readForSession(['session-a']), { code: 'scene_session_unavailable' })
})

test('persisted scene-memory identifier fields require actual strings', async t => {
  const f = await fixture(t)
  await configureAndBind(f.memory)
  await f.memory.updateHandoff({ sessionId: 'session-a', operationId: 'handoff-1', expectedRevision: 0, text: 'handoff' })
  await f.memory.appendProgress({ sessionId: 'session-a', entryId: 'progress-1', text: 'progress' })
  await f.memory.appendDecision({ sessionId: 'session-a', entryId: 'decision-1', text: 'decision' })
  const statePath = join(f.home, 'tradeloom-state', 'state.json')
  const validState = JSON.parse(await readFile(statePath, 'utf8'))
  const malformed = [
    state => { state.sceneMemory.scenes['scene-a'].handoff.sourceSessionId = ['session-a'] },
    state => { state.sceneMemory.scenes['scene-a'].handoff.operationId = ['handoff-1'] },
    state => { state.sceneMemory.scenes['scene-a'].progress[0].entryId = ['progress-1'] },
    state => { state.sceneMemory.scenes['scene-a'].progress[0].sourceSessionId = ['session-a'] },
    state => { state.sceneMemory.scenes['scene-a'].decisions[0].entryId = ['decision-1'] },
    state => { state.sceneMemory.scenes['scene-a'].decisions[0].sourceSessionId = ['session-a'] },
    state => { state.sceneMemory.scenes['scene-a'].operations['handoff-1'].sourceSessionId = ['session-a'] },
    state => { state.sceneMemory.sessionScenes['session-a'] = ['scene-a'] },
  ]
  for (const corrupt of malformed) {
    const value = structuredClone(validState)
    corrupt(value)
    await writeFile(statePath, JSON.stringify(value))
    await assert.rejects(f.memory.readForSession('session-a'), { code: 'scene_memory_invalid' })
  }
})

test('unconfigured profile and skill are explicit and never receive generated content', async t => {
  const f = await fixture(t)
  await f.memory.bindSession({ sceneId: 'scene-a', sessionId: 'session-a', expectedSessionId: null })
  const context = await f.memory.readForSession('session-a')
  assert.equal(context.profileStatus, 'not_configured')
  assert.equal(context.handoffStatus, 'missing')
  assert.equal(context.profile.responsibility, null)
  assert.deepEqual(context.profile.assetRefs, [])
  assert.equal((await f.memory.readConfiguredSkill('session-a', null, {})).status, 'not_configured')
})

test('skill body loads on demand by configured name through the scoped SDK service', async t => {
  const f = await fixture(t)
  await configureAndBind(f.memory)
  const calls = []
  const skills = {
    async snapshot(options) { calls.push(['snapshot', options]); return { complete: true, skills: [{ name: 'product-review', invocation: { modelInvocable: true } }] } },
    async get(name, options) { calls.push(['get', name, options]); return { name, invocation: { modelInvocable: true }, content: 'Actual skill body.' } },
  }
  const agent = { id: 'agent-a', session: { id: 'session-a', header: { agentPreset: ROLE_PRESETS.product, cwd: 'C:/workspace' } }, ctx: { get: name => name === 'skills' ? skills : undefined } }
  const result = await f.memory.readConfiguredSkill('session-a', skills, { agent, signal: new AbortController().signal })
  assert.deepEqual(result, { status: 'available', skill: 'product-review', content: 'Actual skill body.' })
  assert.equal(calls.length, 2)
  assert.equal(calls[0][1].scope, agent)
  assert.equal(calls[0][1].cwd, 'C:/workspace')
})

test('configured but absent skill remains missing; no skill text is fabricated', async t => {
  const f = await fixture(t)
  await f.memory.configureScene({ sceneId: 'scene-a', expectedRevision: 0, responsibility: null, assetRefs: [], primarySkill: 'missing-skill' })
  await f.memory.bindSession({ sceneId: 'scene-a', sessionId: 'session-a', expectedSessionId: null })
  const result = await f.memory.readConfiguredSkill('session-a', {
    async snapshot() { return { complete: true, skills: [] } },
    async get() { assert.fail('missing skill must not be loaded') },
  }, { agent: { session: { id: 'session-a', header: { cwd: 'C:/workspace' } } } })
  assert.deepEqual(result, { status: 'missing', skill: 'missing-skill', content: null })
})

test('a skill lookup that resolves missing after a concurrent profile change rejects the stale result', async t => {
  const f = await fixture(t)
  await f.memory.configureScene({ sceneId: 'scene-a', expectedRevision: 0, responsibility: null, assetRefs: [], primarySkill: 'product-review' })
  await f.memory.bindSession({ sceneId: 'scene-a', sessionId: 'session-a', expectedSessionId: null })
  let finishGet
  let signalGetStarted
  const getResult = new Promise(resolve => { finishGet = resolve })
  const getStarted = new Promise(resolve => { signalGetStarted = resolve })
  const skills = {
    async snapshot() { return { complete: true, skills: [{ name: 'product-review', invocation: { modelInvocable: true } }] } },
    get() { signalGetStarted(); return getResult },
  }
  const agent = { session: { id: 'session-a', header: { cwd: 'C:/workspace' } } }
  const loading = f.memory.readConfiguredSkill('session-a', skills, { agent, signal: new AbortController().signal })
  await getStarted
  await f.memory.configureScene({ sceneId: 'scene-a', expectedRevision: 1, responsibility: '已变更', assetRefs: [], primarySkill: 'product-review' })
  finishGet(null)
  await assert.rejects(loading, { code: 'scene_binding_changed' })
})

test('skill load is discarded if the scene configuration changes while the SDK lookup is pending', async t => {
  const f = await fixture(t)
  await f.memory.configureScene({ sceneId: 'scene-a', expectedRevision: 0, responsibility: null, assetRefs: [], primarySkill: 'product-review' })
  await f.memory.bindSession({ sceneId: 'scene-a', sessionId: 'session-a', expectedSessionId: null })
  let finishSnapshot
  const snapshot = new Promise(resolve => { finishSnapshot = resolve })
  let getCalls = 0
  const skills = {
    snapshot: () => snapshot,
    async get() { getCalls += 1; return { name: 'product-review', invocation: { modelInvocable: true }, content: 'stale body' } },
  }
  const agent = { session: { id: 'session-a', header: { cwd: 'C:/workspace' } } }
  const loading = f.memory.readConfiguredSkill('session-a', skills, { agent, signal: new AbortController().signal })
  await f.memory.configureScene({ sceneId: 'scene-a', expectedRevision: 1, responsibility: '更新后的职责', assetRefs: [], primarySkill: 'product-review' })
  finishSnapshot({ complete: true, skills: [{ name: 'product-review', invocation: { modelInvocable: true } }] })
  await assert.rejects(loading, { code: 'scene_binding_changed' })
  assert.equal(getCalls, 0)
})

test('revoking a session binding while skill discovery is pending prevents body retrieval', async t => {
  const f = await fixture(t)
  await f.memory.configureScene({ sceneId: 'scene-a', expectedRevision: 0, responsibility: null, assetRefs: [], primarySkill: 'product-review' })
  await f.memory.bindSession({ sceneId: 'scene-a', sessionId: 'session-a', expectedSessionId: null })
  let finishSnapshot
  const snapshot = new Promise(resolve => { finishSnapshot = resolve })
  let getCalls = 0
  const skills = {
    snapshot: () => snapshot,
    async get() { getCalls += 1; return { name: 'product-review', invocation: { modelInvocable: true }, content: 'stale body' } },
  }
  const agent = { session: { id: 'session-a', header: { cwd: 'C:/workspace' } } }
  const loading = f.memory.readConfiguredSkill('session-a', skills, { agent, signal: new AbortController().signal })
  await f.memory.bindSession({ sceneId: 'scene-a', sessionId: 'session-a2', expectedSessionId: 'session-a' })
  finishSnapshot({ complete: true, skills: [{ name: 'product-review', invocation: { modelInvocable: true } }] })
  await assert.rejects(loading, { code: 'scene_session_not_bound' })
  assert.equal(getCalls, 0)
})

test('registered scene tools derive scope from live execute identity and reject scene or actor overrides', async t => {
  const f = await fixture(t)
  await configureAndBind(f.memory)
  const skills = {
    async snapshot() { return { complete: true, skills: [{ name: 'product-review', provider: 'fixture', source: 'fixture', invocation: { modelInvocable: true } }] } },
    async get(name) { return { name, provider: 'fixture', source: 'fixture', invocation: { modelInvocable: true }, content: 'Skill body on demand.' } },
  }
  const agent = { id: 'agent-a', session: { id: 'session-a', header: { agentPreset: ROLE_PRESETS.center, parentSession: null, delegationDepth: 0, cwd: 'C:/workspace' } }, ctx: { get: name => name === 'skills' ? skills : undefined } }
  const agentB = { id: 'agent-b', session: { id: 'session-b', header: { agentPreset: ROLE_PRESETS.center, parentSession: null, delegationDepth: 0, cwd: 'C:/workspace' } }, ctx: { get: name => name === 'skills' ? skills : undefined } }
  const agents = new Map([[agent.id, agent], [agentB.id, agentB]])
  const registered = new Map()
  const ctx = {
    agents: { get: id => agents.get(id) },
    tools: { register(definition) { registered.set(definition.name, definition); return () => registered.delete(definition.name) } },
  }
  const dispose = registerBusinessTools(ctx, { preset: ROLE_PRESETS.center }, { sceneMemory: f.memory })
  t.after(dispose)
  const exec = { agent }
  const read = registered.get('tradeloom_scene_context')
  const skill = registered.get('tradeloom_scene_skill')
  const update = registered.get('tradeloom_scene_handoff_update')
  const progress = registered.get('tradeloom_scene_progress_append')
  const decision = registered.get('tradeloom_scene_decision_append')
  assert.ok(read && skill && update && progress && decision)
  const readResult = await read.execute({}, exec)
  assert.equal(readResult.ok, true)
  assert.equal(JSON.parse(readResult.data).sceneId, 'scene-a')
  const readBResult = await read.execute({}, { agent: agentB })
  assert.equal(readBResult.ok, true)
  assert.equal(JSON.parse(readBResult.data).sceneId, 'scene-b')
  const skillResult = await skill.execute({}, exec)
  assert.equal(skillResult.ok, true)
  assert.equal(JSON.parse(skillResult.data).content, 'Skill body on demand.')
  assert.equal((await update.execute({ operation_id: 'op-1', expected_revision: 0, text: '内容' }, exec)).ok, true)
  assert.equal((await progress.execute({ entry_id: 'progress-1', text: '进度' }, exec)).ok, true)
  assert.equal((await decision.execute({ entry_id: 'decision-1', text: '决策' }, exec)).ok, true)
  const pagedResult = await read.execute({ progress_offset: 1, decision_offset: 0, page_size: 1 }, exec)
  assert.equal(pagedResult.ok, true)
  const pagedContext = JSON.parse(pagedResult.data)
  assert.deepEqual(pagedContext.progress, [])
  assert.deepEqual(pagedContext.pagination.progress, { offset: 1, total: 1, hasMore: false, nextOffset: null })
  assert.equal((await read.execute({ scene_id: 'scene-b' }, exec)).error_code, 'invalid_arguments')
  assert.equal((await read.execute({ actor_session_id: 'session-b' }, exec)).error_code, 'invalid_arguments')
  const spoof = await update.execute({ scene_id: 'scene-b', operation_id: 'op-2', expected_revision: 1, text: '越权内容' }, exec)
  assert.equal(spoof.error_code, 'invalid_arguments')
  const forged = await read.execute({}, { agent: { ...agent, id: 'forged' } })
  assert.equal(forged.error_code, 'host_identity_unavailable')
  assert.equal((await f.memory.readForSession('session-b')).handoff, null)
  assert.equal(registered.has('tradeloom_scene_context'), true)
})

test('registered skill tool discards a valid body if the live preset changes during get', async t => {
  const f = await fixture(t)
  await f.memory.configureScene({ sceneId: 'scene-a', expectedRevision: 0, responsibility: null, assetRefs: [], primarySkill: 'product-review' })
  await f.memory.bindSession({ sceneId: 'scene-a', sessionId: 'session-a', expectedSessionId: null })
  let signalGetStarted
  let finishGet
  const getStarted = new Promise(resolve => { signalGetStarted = resolve })
  const getResult = new Promise(resolve => { finishGet = resolve })
  const skills = {
    async snapshot() { return { complete: true, skills: [{ name: 'product-review', invocation: { modelInvocable: true } }] } },
    get() { signalGetStarted(); return getResult },
  }
  const agent = { id: 'agent-a', session: { id: 'session-a', header: { agentPreset: ROLE_PRESETS.center, parentSession: null, delegationDepth: 0, cwd: 'C:/workspace' } }, ctx: { get: name => name === 'skills' ? skills : undefined } }
  const registered = new Map()
  const ctx = {
    agents: { get: id => id === agent.id ? agent : undefined },
    tools: { register(definition) { registered.set(definition.name, definition); return () => registered.delete(definition.name) } },
  }
  const dispose = registerBusinessTools(ctx, { preset: ROLE_PRESETS.center }, { sceneMemory: f.memory })
  t.after(dispose)
  const loading = registered.get('tradeloom_scene_skill').execute({}, { agent })
  await getStarted
  agent.session.header.agentPreset = ROLE_PRESETS['user-profile']
  finishGet({ name: 'product-review', invocation: { modelInvocable: true }, content: 'must not be returned' })
  const result = await loading
  assert.equal(result.ok, false)
  assert.equal(result.error_code, 'host_identity_unavailable')
  assert.equal(result.data, '')
})

test('scene tools do not register without the trusted scene-memory consumer', () => {
  const registered = new Map()
  const ctx = { tools: { register(definition) { registered.set(definition.name, definition); return () => registered.delete(definition.name) } } }
  const dispose = registerBusinessTools(ctx, { preset: ROLE_PRESETS.center })
  dispose()
  assert.equal(registered.has('tradeloom_scene_context'), false)
})

test('a failed owned-state atomic write leaves the previous scene data intact', async t => {
  const f = await fixture(t)
  await configureAndBind(f.memory)
  await f.memory.updateHandoff({ sessionId: 'session-a', operationId: 'handoff-1', expectedRevision: 0, text: '原有交接' })
  const failingState = await createStateStore({ env: f.env, _testHooks: { rename(_temporary, _target, kind) {
    if (kind === 'state') throw Object.assign(new Error('fixture rename failure'), { code: 'EIO' })
  } } })
  const failingMemory = createSceneMemoryStore(failingState, { sceneIds: ['scene-a', 'scene-b'], verifySession: async () => true })
  await assert.rejects(failingMemory.appendProgress({ sessionId: 'session-a', entryId: 'progress-failed', text: '不得提交' }), { code: 'EIO' })
  assert.equal((await f.memory.readForSession('session-a')).progress.length, 0)
  assert.equal((await f.memory.readForSession('session-a')).handoff.text, '原有交接')
  const persisted = JSON.parse(await readFile(join(f.home, 'tradeloom-state', 'state.json'), 'utf8'))
  assert.equal(persisted.sceneMemory.scenes['scene-a'].progress.length, 0)
})

test('scene journals beyond 1000 entries remain appendable and context reads bounded pages', async t => {
  const f = await fixture(t)
  await configureAndBind(f.memory)
  const timestamp = '2026-10-30T00:00:00.000Z'
  await f.state.transact(state => {
    const scene = state.sceneMemory.scenes['scene-a']
    scene.handoff = { revision: 1, sourceSessionId: 'session-a', text: 'handoff', updatedAt: timestamp, operationId: 'handoff-1' }
    scene.handoffRevision = 1
    for (let index = 1; index <= 1001; index += 1) {
      const suffix = String(index)
      const progress = { entryId: `progress-${suffix}`, sourceSessionId: 'session-a', text: 'p', createdAt: timestamp }
      const decision = { entryId: `decision-${suffix}`, sourceSessionId: 'session-a', text: 'd', createdAt: timestamp }
      scene.progress.push(progress)
      scene.decisions.push(decision)
      scene.journalOperations.progress[progress.entryId] = {
        sourceSessionId: progress.sourceSessionId,
        fingerprint: createHash('sha256').update(JSON.stringify(['progress', progress.sourceSessionId, progress.text])).digest('hex'),
      }
      scene.journalOperations.decisions[decision.entryId] = {
        sourceSessionId: decision.sourceSessionId,
        fingerprint: createHash('sha256').update(JSON.stringify(['decisions', decision.sourceSessionId, decision.text])).digest('hex'),
      }
    }
  })

  await assert.rejects(f.memory.readForSession('session-a', { sceneId: 'scene-b' }), { code: 'invalid_arguments' })
  await assert.rejects(f.memory.readForSession('session-a', { pageSize: 101 }), { code: 'invalid_arguments' })

  const page = await f.memory.readForSession('session-a', { progressOffset: 990, decisionOffset: 1000, pageSize: 5 })
  assert.equal(page.progress.length, 5)
  assert.equal(page.decisions.length, 1)
  assert.deepEqual(page.pagination, {
    pageSize: 5,
    progress: { offset: 990, total: 1001, hasMore: true, nextOffset: 995 },
    decisions: { offset: 1000, total: 1001, hasMore: false, nextOffset: null },
  })
  const continuation = await f.memory.readForSession('session-a', { progressOffset: page.pagination.progress.nextOffset, decisionOffset: 0, pageSize: 5 })
  assert.equal(continuation.progress.length, 5)
  assert.deepEqual(continuation.pagination.progress, { offset: 995, total: 1001, hasMore: true, nextOffset: 1000 })
  await f.memory.appendProgress({ sessionId: 'session-a', entryId: 'progress-1002', text: 'p2' })
  const finalPage = await f.memory.readForSession('session-a', { progressOffset: 1001, decisionOffset: 0, pageSize: 5 })
  assert.equal(finalPage.progress[0].entryId, 'progress-1002')
  assert.equal(finalPage.pagination.progress.total, 1002)
  const handoff = await f.memory.updateHandoff({ sessionId: 'session-a', operationId: 'handoff-after-1001', expectedRevision: 1, text: 'after many operations' })
  assert.equal(handoff.revision, 2)
})
