import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID, createHash } from 'node:crypto'
import { Readable } from 'node:stream'
import test from 'node:test'
import { createStateStore, HOME_MARKER, HOME_MARKER_VALUE, replaceRoleBinding } from '../state.js'
import { createExecutionOriginAuthority } from '../execution-origin-authority.js'
import { createSceneMemoryCatalog, createSceneMemoryHandler, sceneMemoryDocument } from '../scene-memory.js'
import { ROLE_PRESETS } from '../roles.js'

// Current origin -> snapshot/update -> catalog/resolve and the real owned state
// store. Issuer/live-session inputs are controlled; this is not Electron/GUI.
async function fixture(t) {
  assert.ok(process.env.TL_SEVEN_TEST_ROOT, 'explicit private synthetic root required')
  await mkdir(process.env.TL_SEVEN_TEST_ROOT, { recursive: true })
  const root = await mkdtemp(join(process.env.TL_SEVEN_TEST_ROOT, 'scene-graph-')), home = join(root, 'home')
  await mkdir(home); await writeFile(join(home, HOME_MARKER), HOME_MARKER_VALUE)
  const state = await createStateStore({ env: { DSH_HOME: home, TRADELOOM_DSH_APP_HOME: home } })
  const live = new Set(['session-a', 'session-a2', 'session-b']), endpoint = 'tradeloom/scene-memory'
  const binding = (role, sessionId) => ({ sessionId, workspaceId: `workspace-${role}`, workspacePath: join(root, role), agentPreset: ROLE_PRESETS[role] })
  await state.transact(value => { replaceRoleBinding(value, 'center', binding('center', 'session-a')); replaceRoleBinding(value, 'product', binding('product', 'session-b')) })
  let durabilityBarrier
  const authority = createExecutionOriginAuthority({ stateStore: state, isSessionLive: source => live.has(source.sessionId),
    isSessionDurable: async source => { if (durabilityBarrier) await durabilityBarrier(source); return live.has(source.sessionId) } })
  const catalog = createSceneMemoryCatalog(authority, { now: () => '2026-10-31T00:00:00.000Z' })
  async function issuer(role = 'center', sceneId = 'scene-a') {
    const value = await state.read()
    return { scope: 'role', guestId: 101, generation: 1, sceneId, panelId: 'chat', roleId: role,
      ...value.roles[role], bindingRevision: value.roleBindingRevisions[role] }
  }
  async function mint(role = 'center', sceneId = 'scene-a') {
    const id = randomUUID(), bodyBytes = Buffer.from(JSON.stringify({ id })), source = await issuer(role, sceneId)
    const grant = await authority.registerGrant({ issuer: source, bodyBytes, endpoint, httpMethod: 'POST' })
    const origin = await authority.verifyRequest({ token: grant.token, endpoint, routePath: endpoint, httpMethod: 'POST', method: endpoint,
      rpcId: id, bodyBytes, bodyDigest: createHash('sha256').update(bodyBytes).digest('hex'), peerId: 'controlled', peerPrincipal: 'owner' })
    authority.retainOriginWork(origin, { kind: 'queue', owner: live }); return origin
  }
  let origin = await mint()
  const doc = sceneMemoryDocument(null)
  doc.profile = { revision: 1, responsibility: 'Scene A', assetRefs: [{ kind: 'business-route', id: '/products', label: 'Products' }], primarySkill: 'product-review' }
  doc.handoffRevision = 1; doc.handoff = { revision: 1, text: 'Old session handoff', sourceSessionId: 'session-a', updatedAt: 'controlled', operationId: origin.operationId }
  doc.progress = [1, 2].map(n => ({ entryId: `progress-a-${n}`, text: `Progress ${n}`, sourceSessionId: 'session-a', createdAt: 'controlled' }))
  doc.decisions = [{ entryId: 'decision-a-1', text: 'Long term decision', sourceSessionId: 'session-a', createdAt: 'controlled' }]
  await authority.updateSceneMemory(origin, 'scene-a', 0, () => doc)
  const other = await mint('product', 'scene-b')
  await authority.updateSceneMemory(other, 'scene-b', 0, () => ({ ...sceneMemoryDocument(null), profile: { revision: 1, responsibility: 'Cross-scene secret', assetRefs: [], primarySkill: null } }))
  t.after(async () => { authority.dispose(); await rm(root, { recursive: true, force: true }) })
  return { state, live, authority, catalog, issuer, file: state.paths.statePath,
    get origin() { return origin }, execute: input => catalog.execute(origin, input),
    graph: async query => (await catalog.execute(origin, { action: 'graph', query })).graph,
    async edit(transform) { const snapshot = await authority.transactSceneMemory(origin, 'snapshot', origin.sceneId); return authority.updateSceneMemory(origin, origin.sceneId, snapshot.revision, transform) },
    async rebind(sessionId) { await state.transact(value => replaceRoleBinding(value, 'center', binding('center', sessionId))); origin = await mint(); return origin },
    barrier: value => { durabilityBarrier = value },
  }
}

test('current graph is read-only, bounded, scene-filtered and stable across literal paging', async t => {
  const f = await fixture(t), before = await readFile(f.file)
  const filtered = await f.graph({ text: 'Long term decision', kinds: ['decision'], pageSize: 1 })
  assert.equal(filtered.scope, 'tradeloom-scene-memory-graph/v1'); assert.equal(filtered.status, 'available')
  assert.deepEqual(filtered.nodes.map(node => node.kind), ['decision']); assert.equal(filtered.nodes[0].source.sourceSessionId, 'session-a')
  const ids = new Set([...filtered.nodes, ...filtered.contextNodes].map(node => node.id))
  assert.ok(filtered.edges.length); assert.ok(filtered.edges.every(edge => ids.has(edge.source) && ids.has(edge.target)))
  const asset = await f.graph({ kinds: ['asset_ref'] }), context = new Map(asset.contextNodes.map(node => [node.kind, node]))
  assert.equal(asset.nodes.length, 1); assert.ok(context.has('scene') && context.has('profile'))
  assert.ok(asset.edges.some(edge => edge.kind === 'has_profile' && edge.source === context.get('scene').id && edge.target === context.get('profile').id))
  assert.ok(asset.edges.some(edge => edge.kind === 'references_asset' && edge.target === asset.nodes[0].id))
  const empty = await f.graph({ text: 'no literal match' })
  assert.equal(empty.status, 'empty'); assert.equal(empty.pagination.totalMatches, 0)
  assert.deepEqual([empty.nodes, empty.contextNodes, empty.edges], [[], [], []]); assert.ok(!JSON.stringify(empty).includes('Cross-scene secret'))
  const first = await f.graph({ kinds: ['progress'], pageSize: 1 }), second = await f.graph({ cursor: first.pagination.nextCursor })
  assert.equal(first.pagination.totalMatches, 2); assert.equal(second.pagination.offset, 1)
  assert.deepEqual(new Set([...first.nodes, ...second.nodes].map(node => node.data.entryId)), new Set(['progress-a-1', 'progress-a-2']))
  assert.equal(first.nodes[0].id, (await f.graph({ kinds: ['progress'], pageSize: 1 })).nodes[0].id)
  assert.deepEqual(await readFile(f.file), before)
})

test('cursor retains its append-only prefix and rejects changed profile, handoff and current binding', async t => {
  const f = await fixture(t), first = await f.graph({ kinds: ['progress'], pageSize: 1 })
  await f.execute({ action: 'progress', expectedRevision: 1, text: 'Third progress' })
  const second = await f.graph({ cursor: first.pagination.nextCursor })
  assert.equal(second.pagination.totalMatches, 2); assert.equal(second.pagination.hasMore, false)
  assert.deepEqual(second.nodes.map(node => node.data.entryId), ['progress-a-2']); assert.equal((await f.graph({ kinds: ['progress'] })).pagination.totalMatches, 3)
  const profile = await f.graph({ kinds: ['progress'], pageSize: 1 })
  await f.edit(value => ({ ...value, profile: { ...value.profile, revision: value.profile.revision + 1, responsibility: 'Changed' } }))
  await assert.rejects(f.graph({ cursor: profile.pagination.nextCursor }), { code: 'scene_graph_snapshot_changed' })
  const handoff = await f.graph({ kinds: ['progress'], pageSize: 1 }), revision = (await f.execute({ action: 'catalog' })).revision
  await f.execute({ action: 'handoff', expectedRevision: revision, text: 'Changed handoff' })
  await assert.rejects(f.graph({ cursor: handoff.pagination.nextCursor }), { code: 'scene_graph_snapshot_changed' })
  const binding = await f.graph({ kinds: ['progress'], pageSize: 1 })
  await f.rebind('session-a2'); await f.rebind('session-a')
  await assert.rejects(f.graph({ cursor: binding.pagination.nextCursor }), { code: 'scene_graph_snapshot_changed' })
})

test('long and lone-surrogate references retain distinct bounded resolvable IDs without writes', async t => {
  const f = await fixture(t), long = 'asset'.repeat(128), lone = '\uD800'
  await f.edit(value => ({ ...value, profile: { ...value.profile, revision: 2, assetRefs: [{ kind: 'artifact', id: long }, { kind: 'artifact', id: lone }] } }))
  const before = await readFile(f.file), first = await f.graph({ kinds: ['asset_ref'] }), second = await f.graph({ kinds: ['asset_ref'] })
  assert.deepEqual(first.nodes.map(node => node.id), second.nodes.map(node => node.id)); assert.equal(new Set(first.nodes.map(node => node.id)).size, 2)
  assert.ok(first.nodes.some(node => node.data.id === long) && first.nodes.some(node => node.data.id === lone))
  for (const node of first.nodes) { assert.ok(node.id.length < 128); assert.equal((await f.execute({ action: 'resolve', nodeId: node.id, expectedTarget: first.target })).selected.id, node.id) }
  assert.deepEqual(await readFile(f.file), before)
})

test('old source metadata is separate from current authorized navigation and stale origins fail', async t => {
  const f = await fixture(t), old = f.origin; await f.rebind('session-a2')
  const before = await readFile(f.file), graph = await f.graph({ kinds: ['handoff'] }), node = graph.nodes[0]
  assert.equal(node.source.sourceSessionId, 'session-a')
  const resolved = await f.execute({ action: 'resolve', nodeId: node.id, expectedTarget: graph.target })
  assert.deepEqual(resolved.target, { sceneId: 'scene-a', sessionId: 'session-a2', bindingRevision: f.origin.bindingRevision }); assert.equal(resolved.referenceSessionId, 'session-a')
  await assert.rejects(f.execute({ action: 'resolve', nodeId: node.id, expectedTarget: { ...graph.target, sessionId: 'session-a' } }), { code: 'scene_graph_target_changed' })
  await assert.rejects(f.catalog.execute(old, { action: 'graph' }), { code: 'stale_role_binding' })
  await assert.rejects(f.execute({ action: 'resolve', nodeId: 'scene:scene-b', expectedTarget: graph.target }), { code: 'scene_graph_node_not_found' })
  assert.deepEqual(await readFile(f.file), before)
})

test('unowned origins and corrupt state differ from a valid empty result', async t => {
  const f = await fixture(t)
  await assert.rejects(f.catalog.execute({ ...f.origin, sessionId: 'unknown' }, { action: 'graph' }), { code: 'operation_not_active' })
  assert.equal((await f.graph({ text: 'no-match' })).status, 'empty')
  await f.state.transact(value => { value.sceneMemories['scene-a'].value.profile = { invalid: true } })
  await assert.rejects(f.graph({}), { code: 'scene_memory_schema_unsupported' })
})

test('catalog compares the real stored revision and loses no fields on conflict', async t => {
  const f = await fixture(t), current = await f.execute({ action: 'catalog' })
  await f.execute({ action: 'decision', expectedRevision: current.revision, text: 'Accepted CAS' })
  const before = await readFile(f.file)
  await assert.rejects(f.execute({ action: 'decision', expectedRevision: current.revision, text: 'Rejected stale CAS' }), { code: 'scene_memory_revision_conflict' })
  assert.deepEqual(await readFile(f.file), before)
})

test('actual catalog route rejects forged targets; actor loss discards an in-flight read', async t => {
  const f = await fixture(t), handler = createSceneMemoryHandler({ connection: { requestRejection: () => undefined } }, f.authority)
  const endpoint = 'tradeloom/scene-memory'
  async function route(input) {
    const body = { id: randomUUID(), ...input }, bytes = Buffer.from(JSON.stringify(body))
    const grant = await f.authority.registerGrant({ issuer: await f.issuer(), bodyBytes: bytes, endpoint, httpMethod: 'POST' })
    const req = Readable.from([bytes]); req.method = 'POST'; req.headers = { 'x-tradeloom-origin': grant.token }
    let result; const res = { setHeader() {}, end(value) { result = JSON.parse(value) } }
    await handler(req, res); return { status: res.statusCode, ...result }
  }
  const graph = await f.graph({ kinds: ['handoff'] })
  assert.equal((await route({ action: 'graph', query: { kinds: ['handoff'] } })).result.graph.target.sceneId, 'scene-a')
  assert.equal((await route({ action: 'resolve', nodeId: graph.nodes[0].id, expectedTarget: { ...graph.target, sceneId: 'scene-b' } })).error_code, 'scene_graph_target_changed')
  assert.equal((await route({ action: 'graph', query: { kinds: ['unknown'] } })).error_code, 'invalid_arguments')
  let entered, release; const started = new Promise(resolve => { entered = resolve }), gate = new Promise(resolve => { release = resolve })
  f.barrier(async () => { entered(); await gate })
  const pending = f.graph({ kinds: ['handoff'] }); await started; f.live.delete('session-a'); release()
  await assert.rejects(pending, { code: 'session_not_live' })
})
