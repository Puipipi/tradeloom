import test from 'node:test'
import assert from 'node:assert/strict'
import { planReadyNodes } from '../workflow-native-graph.js'
const document = { nodes: ['a', 'b', 'c', 'd'].map(id => ({ id })), edges: [{ from: 'a', to: 'b' }, { from: 'b', to: 'c' }] }
const snapshot = states => ({ nodes: Object.fromEntries(Object.entries(states).map(([id, status]) => [id, { status }])) })
test('stable topological ready nodes are serialized and joins wait for every parent', () => {
  assert.deepEqual(planReadyNodes(document, snapshot({ a: 'pending', b: 'pending', c: 'pending', d: 'pending' })).readyNodeIds, ['a'])
  const join = { nodes: document.nodes, edges: [{ from: 'a', to: 'c' }, { from: 'b', to: 'c' }] }
  assert.deepEqual(planReadyNodes(join, snapshot({ a: 'done', b: 'running', c: 'pending', d: 'done' })).readyNodeIds, [])
  assert.deepEqual(planReadyNodes(join, snapshot({ a: 'done', b: 'done', c: 'pending', d: 'done' })).readyNodeIds, ['c'])
})
test('failed descendants are blocked transitively while independent pending node remains ready', () => {
  const result = planReadyNodes(document, snapshot({ a: 'failed', b: 'pending', c: 'pending', d: 'pending' }))
  assert.deepEqual(result.blockedNodes, [{ nodeId: 'b', blockedBy: ['a'] }, { nodeId: 'c', blockedBy: ['b'] }])
  assert.deepEqual(result.readyNodeIds, ['d'])
})
test('unknown or interrupted pauses all new dispatch and never fabricates completion', () => {
  for (const state of ['unknown', 'interrupted']) {
    const result = planReadyNodes(document, snapshot({ a: state, b: 'pending', c: 'pending', d: 'pending' }))
    assert.deepEqual(result.readyNodeIds, [])
    assert.equal(result.paused, true)
    assert.equal(result.settled, false)
  }
})
