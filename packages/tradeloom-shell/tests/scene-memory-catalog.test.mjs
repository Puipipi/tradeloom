import test from 'node:test'
import assert from 'node:assert/strict'
import { createSceneMemoryCatalog, sceneMemoryDocument } from '../scene-memory.js'

test('catalog uses captured owner, preserves unknown value fields and compares revision', async () => {
  const origin = { sceneId: 'one', panelId: 'chat', roleId: 'center', sessionId: 'session-one', bindingRevision: '9007199254740993', operationId: 'operation' }
  let value = { ...sceneMemoryDocument(null), retained: { old: true } }, revision = 0
  const authority = {
    async transactSceneMemory(owner, action, scene) { assert.equal(owner, origin); assert.equal(scene, 'one'); assert.equal(action, 'snapshot'); return { value, revision } },
    async updateSceneMemory(owner, scene, expected, transform) { assert.equal(owner, origin); assert.equal(scene, 'one'); if (expected !== revision) throw Object.assign(Error(), { code: 'scene_memory_revision_conflict' }); value = transform(value); return { value, revision: ++revision } },
  }
  const catalog = createSceneMemoryCatalog(authority)
  await catalog.execute(origin, { action: 'decision', text: 'Synthetic decision', expectedRevision: 0 })
  assert.deepEqual(value.retained, { old: true })
  const result = await catalog.execute(origin, { action: 'graph', query: { pageSize: 1 } })
  assert.equal(result.graph.target.bindingRevision, origin.bindingRevision)
  assert.equal(result.graph.pagination.hasMore, true)
  await assert.rejects(catalog.execute(origin, { action: 'handoff', text: 'stale', expectedRevision: 0 }), { code: 'scene_memory_revision_conflict' })
  await assert.rejects(catalog.execute(origin, { action: 'graph', sceneId: 'other' }), { code: 'invalid_arguments' })
  const page = await catalog.execute(origin, { action: 'graph', query: { cursor: result.graph.pagination.nextCursor } })
  assert.equal(page.graph.target.sessionId, origin.sessionId)
  const node = page.graph.nodes[0]
  await assert.rejects(catalog.execute(origin, { action: 'resolve', nodeId: node.id, expectedTarget: { ...result.graph.target, sessionId: 'other' } }), { code: 'scene_graph_target_changed' })
})

test('unrecognized existing memory is reported, never rewritten into a graph', () => {
  assert.throws(() => sceneMemoryDocument({ arbitraryExistingData: true }), { code: 'scene_memory_schema_unsupported' })
})
