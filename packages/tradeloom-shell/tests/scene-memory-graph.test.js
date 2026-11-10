import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { registerBusinessTools } from '../business-tools.js'
import { createStateStore, HOME_MARKER, HOME_MARKER_VALUE } from '../state.js'
import { createSceneMemoryStore } from '../scene-memory.js'
import { ROLE_PRESETS } from '../roles.js'

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'tradeloom-scene-memory-graph-'))
  const home = join(root, 'home')
  await mkdir(home, { recursive: true })
  await writeFile(join(home, HOME_MARKER), HOME_MARKER_VALUE)
  const env = { DSH_HOME: home, TRADELOOM_DSH_APP_HOME: home }
  const state = await createStateStore({ env })
  const live = new Set(['session-a', 'session-a2', 'session-b'])
  const memory = createSceneMemoryStore(state, {
    sceneIds: ['scene-a', 'scene-b'],
    verifySession: async ({ sessionId }) => live.has(sessionId),
    now: () => '2026-10-31T00:00:00.000Z',
  })
  await memory.configureScene({
    sceneId: 'scene-a', expectedRevision: 0, responsibility: '独立图谱场景 A',
    assetRefs: [{ kind: 'business-route', id: '/products', label: '产品入口' }], primarySkill: 'product-review',
  })
  await memory.configureScene({
    sceneId: 'scene-b', expectedRevision: 0, responsibility: '不可跨场景读取的秘密说明',
    assetRefs: [{ kind: 'artifact', id: 'private-catalog' }], primarySkill: null,
  })
  await memory.bindSession({ sceneId: 'scene-a', sessionId: 'session-a', expectedSessionId: null })
  await memory.bindSession({ sceneId: 'scene-b', sessionId: 'session-b', expectedSessionId: null })
  await memory.updateHandoff({ sessionId: 'session-a', operationId: 'handoff-a', expectedRevision: 0, text: '来自旧会话的实际交接' })
  await memory.appendProgress({ sessionId: 'session-a', entryId: 'progress-a-1', text: '首条进度记录' })
  await memory.appendProgress({ sessionId: 'session-a', entryId: 'progress-a-2', text: '第二条进度记录' })
  await memory.appendDecision({ sessionId: 'session-a', entryId: 'decision-a-1', text: '已经记录的长期决策' })
  t.after(() => rm(root, { recursive: true, force: true }))
  return { root, home, env, state, memory, live }
}

test('graph query is a read-only, bounded literal projection with valid edge endpoints and stable paging', async t => {
  const f = await fixture(t)
  const file = join(f.home, 'tradeloom-state', 'state.json')
  const before = await readFile(file)
  const filtered = await f.memory.readGraphForSession('session-a', { text: '已经记录的长期决策', kinds: ['decision'], pageSize: 1 })
  assert.equal(filtered.scope, 'tradeloom-scene-memory-graph/v1')
  assert.equal(filtered.status, 'available')
  assert.equal(filtered.target.sessionId, 'session-a')
  assert.deepEqual(filtered.nodes.map(node => node.kind), ['decision'])
  assert.equal(filtered.nodes[0].source.sourceSessionId, 'session-a')
  const visibleIds = new Set([...filtered.nodes, ...filtered.contextNodes].map(node => node.id))
  assert.ok(filtered.edges.length > 0)
  assert.ok(filtered.edges.every(edge => visibleIds.has(edge.source) && visibleIds.has(edge.target)))

  const assetOnly = await f.memory.readGraphForSession('session-a', { kinds: ['asset_ref'] })
  assert.deepEqual(assetOnly.nodes.map(node => node.kind), ['asset_ref'])
  const contextByKind = new Map(assetOnly.contextNodes.map(node => [node.kind, node]))
  assert.ok(contextByKind.has('scene'))
  assert.ok(contextByKind.has('profile'))
  assert.ok(assetOnly.edges.some(edge => edge.kind === 'has_profile'
    && edge.source === contextByKind.get('scene').id && edge.target === contextByKind.get('profile').id))
  assert.ok(assetOnly.edges.some(edge => edge.kind === 'references_asset'
    && edge.source === contextByKind.get('profile').id && edge.target === assetOnly.nodes[0].id))

  const empty = await f.memory.readGraphForSession('session-a', { text: '没有此内容的字面搜索结果' })
  assert.equal(empty.status, 'empty')
  assert.equal(empty.pagination.totalMatches, 0)
  assert.deepEqual(empty.nodes, [])
  assert.deepEqual(empty.contextNodes, [])
  assert.deepEqual(empty.edges, [])
  assert.equal(JSON.stringify(empty).includes('秘密说明'), false)

  const first = await f.memory.readGraphForSession('session-a', { kinds: ['progress'], pageSize: 1 })
  assert.equal(first.pagination.totalMatches, 2)
  assert.equal(first.pagination.hasMore, true)
  const second = await f.memory.readGraphForSession('session-a', { cursor: first.pagination.nextCursor })
  assert.equal(second.pagination.offset, 1)
  assert.deepEqual(new Set([...first.nodes, ...second.nodes].map(node => node.data.entryId)), new Set(['progress-a-1', 'progress-a-2']))
  const repeat = await f.memory.readGraphForSession('session-a', { kinds: ['progress'], pageSize: 1 })
  assert.equal(first.nodes[0].id, repeat.nodes[0].id)
  assert.deepEqual(await readFile(file), before)
})

test('cursor keeps its original append-only journal prefix and rejects profile, handoff and binding changes', async t => {
  const f = await fixture(t)
  const first = await f.memory.readGraphForSession('session-a', { kinds: ['progress'], pageSize: 1 })
  await f.memory.appendProgress({ sessionId: 'session-a', entryId: 'progress-a-3', text: '追加后不能混页' })
  const oldSecondPage = await f.memory.readGraphForSession('session-a', { cursor: first.pagination.nextCursor })
  assert.equal(oldSecondPage.pagination.totalMatches, 2)
  assert.equal(oldSecondPage.pagination.hasMore, false)
  assert.deepEqual(oldSecondPage.nodes.map(node => node.data.entryId), ['progress-a-2'])
  assert.equal(oldSecondPage.nodes.some(node => node.data.entryId === 'progress-a-3'), false)
  const freshPage = await f.memory.readGraphForSession('session-a', { kinds: ['progress'], pageSize: 1 })
  assert.equal(freshPage.pagination.totalMatches, 3)
  assert.equal(freshPage.pagination.hasMore, true)

  const profilePage = await f.memory.readGraphForSession('session-a', { kinds: ['progress'], pageSize: 1 })
  const profile = await f.memory.readForSession('session-a')
  await f.memory.configureScene({ sceneId: 'scene-a', expectedRevision: profile.profile.revision,
    responsibility: '新配置', assetRefs: profile.profile.assetRefs, primarySkill: profile.profile.primarySkill })
  await assert.rejects(f.memory.readGraphForSession('session-a', { cursor: profilePage.pagination.nextCursor }), { code: 'scene_graph_snapshot_changed' })

  const handoffPage = await f.memory.readGraphForSession('session-a', { kinds: ['progress'], pageSize: 1 })
  await f.memory.updateHandoff({ sessionId: 'session-a', operationId: 'handoff-a-2', expectedRevision: 1, text: '更新的交接' })
  await assert.rejects(f.memory.readGraphForSession('session-a', { cursor: handoffPage.pagination.nextCursor }), { code: 'scene_graph_snapshot_changed' })

  const bindingPage = await f.memory.readGraphForSession('session-a', { kinds: ['progress'], pageSize: 1 })
  await f.memory.bindSession({ sceneId: 'scene-a', sessionId: 'session-a2', expectedSessionId: 'session-a' })
  await f.memory.bindSession({ sceneId: 'scene-a', sessionId: 'session-a', expectedSessionId: 'session-a2' })
  await assert.rejects(f.memory.readGraphForSession('session-a', { cursor: bindingPage.pagination.nextCursor }), { code: 'scene_graph_snapshot_changed' })
})

test('long and lone-surrogate asset references have stable bounded resolvable node IDs', async t => {
  const f = await fixture(t)
  const longId = '商品'.repeat(128)
  const loneSurrogateId = '\uD800'
  await f.memory.configureScene({
    sceneId: 'scene-a', expectedRevision: 1, responsibility: '独立图谱场景 A',
    assetRefs: [
      { kind: 'artifact', id: longId, label: '长引用' },
      { kind: 'artifact', id: loneSurrogateId, label: '孤立代理引用' },
    ],
    primarySkill: 'product-review',
  })
  const before = await readFile(join(f.home, 'tradeloom-state', 'state.json'))
  const first = await f.memory.readGraphForSession('session-a', { kinds: ['asset_ref'] })
  const second = await f.memory.readGraphForSession('session-a', { kinds: ['asset_ref'] })
  assert.equal(first.nodes.length, 2)
  assert.deepEqual(first.nodes.map(node => node.id), second.nodes.map(node => node.id))
  assert.equal(new Set(first.nodes.map(node => node.id)).size, 2)
  for (const node of first.nodes) {
    assert.ok(node.id.length < 128)
    const resolved = await f.memory.resolveGraphTarget('session-a', { nodeId: node.id, expectedTarget: first.target })
    assert.equal(resolved.selected.id, node.id)
  }
  assert.ok(first.nodes.some(node => node.data.id === longId))
  assert.ok(first.nodes.some(node => node.data.id === loneSurrogateId))
  assert.deepEqual(await readFile(join(f.home, 'tradeloom-state', 'state.json')), before)
})

test('target resolution keeps an old handoff source separate from the current bound session', async t => {
  const f = await fixture(t)
  await f.memory.bindSession({ sceneId: 'scene-a', sessionId: 'session-a2', expectedSessionId: 'session-a' })
  const file = join(f.home, 'tradeloom-state', 'state.json')
  const before = await readFile(file)
  const graph = await f.memory.readGraphForSession('session-a2', { kinds: ['handoff'] })
  const handoff = graph.nodes[0]
  assert.equal(handoff.source.sourceSessionId, 'session-a')
  const resolved = await f.memory.resolveGraphTarget('session-a2', { nodeId: handoff.id, expectedTarget: graph.target })
  assert.deepEqual(resolved.target, { sessionId: 'session-a2', sceneId: 'scene-a', bindingRevision: graph.target.bindingRevision })
  assert.equal(resolved.referenceSessionId, 'session-a')
  await assert.rejects(f.memory.resolveGraphTarget('session-a2', { nodeId: handoff.id, expectedTarget: {
    sessionId: 'session-a', sceneId: 'scene-a', bindingRevision: graph.target.bindingRevision - 1,
  } }), { code: 'scene_graph_target_changed' })
  await assert.rejects(f.memory.readGraphForSession('session-a'), { code: 'scene_session_not_bound' })
  await assert.rejects(f.memory.resolveGraphTarget('session-a2', { nodeId: 'scene:scene-b', expectedTarget: graph.target }), { code: 'scene_graph_node_not_found' })
  assert.deepEqual(await readFile(file), before)
})

test('unbound and corrupt state errors remain distinct from an empty search', async t => {
  const f = await fixture(t)
  await assert.rejects(f.memory.readGraphForSession('session-unknown'), { code: 'scene_session_not_bound' })
  const empty = await f.memory.readGraphForSession('session-a', { text: 'no-match' })
  assert.equal(empty.status, 'empty')
  await f.state.transact(state => { state.sceneMemory.scenes['scene-a'].profile = { invalid: true } })
  await assert.rejects(f.memory.readGraphForSession('session-a'), { code: 'scene_memory_invalid' })
})

test('registered graph tools use live actor scope, reject forged targets and discard results after actor loss', async t => {
  const f = await fixture(t)
  const agentA = { id: 'agent-a', session: { id: 'session-a', header: { agentPreset: ROLE_PRESETS.center, parentSession: null, delegationDepth: 0 } } }
  const agentB = { id: 'agent-b', session: { id: 'session-b', header: { agentPreset: ROLE_PRESETS.center, parentSession: null, delegationDepth: 0 } } }
  const agents = new Map([[agentA.id, agentA], [agentB.id, agentB]])
  const tools = new Map()
  let delayRead = false
  let started
  let release
  const readStarted = new Promise(resolve => { started = resolve })
  const gate = new Promise(resolve => { release = resolve })
  const actualRead = f.state.read.bind(f.state)
  const graphState = {
    paths: f.state.paths,
    async read() { const value = await actualRead(); if (delayRead) { started(); await gate }; return value },
    transact: f.state.transact.bind(f.state),
  }
  const graphMemory = createSceneMemoryStore(graphState, {
    sceneIds: ['scene-a', 'scene-b'], verifySession: async ({ sessionId }) => f.live.has(sessionId),
  })
  const ctx = { agents: { get: id => agents.get(id) }, tools: { register(definition) { tools.set(definition.name, definition); return () => tools.delete(definition.name) } } }
  const dispose = registerBusinessTools(ctx, { preset: ROLE_PRESETS.center }, { sceneMemory: graphMemory })
  t.after(dispose)
  const graphTool = tools.get('tradeloom_scene_graph')
  const resolveTool = tools.get('tradeloom_scene_target_resolve')
  assert.ok(graphTool && resolveTool)
  const graphResult = await graphTool.execute({ kinds: ['handoff'] }, { agent: agentA })
  assert.equal(graphResult.ok, true)
  const graph = JSON.parse(graphResult.data)
  assert.equal(graph.target.sceneId, 'scene-a')
  assert.equal(graph.nodes[0].source.sourceSessionId, 'session-a')
  const forged = await resolveTool.execute({ node_id: graph.nodes[0].id, expected_target: {
    session_id: 'session-b', scene_id: 'scene-b', binding_revision: 1,
  } }, { agent: agentA })
  assert.equal(forged.error_code, 'scene_graph_target_changed')
  const unknownKind = await graphTool.execute({ kinds: ['other'] }, { agent: agentA })
  assert.equal(unknownKind.error_code, 'invalid_arguments')

  delayRead = true
  const pending = graphTool.execute({ kinds: ['handoff'] }, { agent: agentA })
  await readStarted
  agents.delete(agentA.id)
  release()
  const lost = await pending
  assert.equal(lost.ok, false)
  assert.equal(lost.error_code, 'host_identity_unavailable')
})
