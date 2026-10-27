import { topologicalOrder } from './workflow-schema.js'

/** Pure readiness for a validated, persisted DAG; no tools or scheduler state. */
export function planReadyNodes(document, snapshot) {
  const order = topologicalOrder(document.nodes, document.edges)
  if (!order || order.some(id => !snapshot.nodes[id])) throw new TypeError('Invalid persisted workflow graph')
  const parents = new Map(order.map(id => [id, []]))
  for (const edge of document.edges) parents.get(edge.to).push(edge.from)
  const states = new Map(order.map(id => [id, snapshot.nodes[id].status]))
  const paused = [...states.values()].some(status => status === 'unknown' || status === 'interrupted')
  const blockedNodes = []
  if (!paused) for (const id of order) {
    if (states.get(id) !== 'pending') continue
    const blockedBy = parents.get(id).filter(parent => ['failed', 'skipped'].includes(states.get(parent)))
    if (blockedBy.length) { blockedNodes.push({ nodeId: id, blockedBy }); states.set(id, 'skipped') }
  }
  const busy = [...states.values()].some(status => status === 'running' || status === 'waiting')
  const readyNodeIds = paused || busy ? [] : order.filter(id => states.get(id) === 'pending'
    && parents.get(id).every(parent => states.get(parent) === 'done')).slice(0, 1)
  return { readyNodeIds, blockedNodes, paused,
    settled: [...states.values()].every(status => ['done', 'failed', 'skipped'].includes(status)) }
}
