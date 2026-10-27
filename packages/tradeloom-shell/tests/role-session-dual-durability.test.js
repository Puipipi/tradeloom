import test from 'node:test'
import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import { createNewSessionHandler } from '../host.js'
import { ROLE_IDS } from '../roles.js'

const op = '3b23e1e2-7080-4de9-9ba6-48044f950d5d', id = `session-${op}`
function fixture({ cold = false, status, failure, conflict } = {}) {
  const state = { roles: {}, roleBindingRevisions: Object.fromEntries(ROLE_IDS.map(role => [role, '0'])), sessionCreateOperations: {}, pendingSessionCreateByRole: {} }
  const workspace = { id: 'workspace', path: 'C:/owned/center', sessionIds: [] }, archives = [], order = []
  let found = false, agent, turns = 0, creates = 0
  if (cold || status) {
    state.sessionCreateOperations[op] = { operationId: op, fingerprint: JSON.stringify(['center', null]), role: 'center', expectedSessionId: null,
      sessionId: id, workspaceId: workspace.id, workspacePath: workspace.path, agentPreset: 'tradeloom-center', status: status ?? 'attempted' }
    state.pendingSessionCreateByRole.center = op; workspace.sessionIds.push(id); found = cold
  }
  const persistence = { identity: Symbol('persistence'), async flush() {
    order.push('flush'); assert.equal(state.roles.center, undefined)
    if (conflict === 'binding') state.roles.center = { sessionId: 'other' }
    if (conflict === 'archive') archives.push(id)
    if (conflict === 'membership') workspace.sessionIds = []
    if (conflict === 'turn') turns = 1
    if (failure === 'flush' || conflict === 'binding') throw new Error('private SDK detail')
  }, async stat() { order.push('stat'); return { header: { id: failure === 'header' ? 'wrong' : id, cwd: workspace.path, agentPreset: 'tradeloom-center' } } } }
  const ctx = { connection: { requestRejection: () => undefined }, get: () => failure === 'missing' ? undefined : persistence,
    agents: { get: key => key === id ? agent : undefined },
    workspaceRegistry: { list: () => [workspace], get: () => workspace, archivedSessionIds: archives },
    sessionQuery: { async observeSession() { order.push('observe'); if (!found) throw Object.assign(new Error(), { code: 'SESSION_QUERY_SESSION_NOT_FOUND' })
      return { header: { id, cwd: workspace.path }, cursor: (agent?.session.seq ?? 0) - 1, projections: { values: { agentPreset: 'tradeloom-center', turnBoundary: { lastTurn: turns, openTurnStartSeq: null } } }, events: [], [Symbol.dispose]() {} } } },
    sessionController: { async create() { creates++; order.push('create'); found = true; workspace.sessionIds.push(id)
      if (failure !== 'no-agent') agent = { id, session: { id, seq: 0 }, ctx: { get: () => persistence } }
      return { sessionId: id, agentPreset: 'tradeloom-center' }
    }, resolveAgent() { assert.fail('must not activate cold recovery') } },
  }
  const handler = createNewSessionHandler(ctx, { resolveOwnedHome: async () => `C:/owned/dual-${Math.random()}`, roleWorkspacePath: async () => workspace.path,
    createStateStore: async () => ({ async transact(callback) {
      if (conflict === 'final-turn' && order.at(-1) === 'observe' && order.includes('stat')) { agent.session.seq++; turns = 1; order.push('turn-after-observation') }
      const before = state.sessionCreateOperations[op]?.status; const result = await callback(state)
      if (before !== 'completed' && state.sessionCreateOperations[op]?.status === 'completed') order.push('completed'); return result } }) })
  async function request() { const req = Object.assign(Readable.from([Buffer.from(JSON.stringify({ role: 'center', expectedSessionId: null, operationId: op }))]), { method: 'POST' })
    const res = { setHeader() {}, end(text) { this.body = JSON.parse(text) } }; await handler(req, res); return res }
  return { state, order, request, get creates() { return creates } }
}
test('new-session fresh publishes only after flush and header stat', async () => {
  const f = fixture(), r = await f.request(); assert.equal(r.statusCode, 201)
  assert.ok(f.order.indexOf('create') < f.order.indexOf('flush')); assert.ok(f.order.indexOf('stat') < f.order.indexOf('completed'))
})
test('live turn after immutable observation but before final transaction refuses stale blank publication', async () => {
  const f = fixture({ conflict: 'final-turn' }), r = await f.request()
  assert.ok(f.order.includes('turn-after-observation'))
  assert.equal(r.statusCode, 409); assert.equal(r.body.error, 'session-create-outcome-unknown')
  assert.equal(f.state.roles.center, undefined); assert.equal(f.state.sessionCreateOperations[op].status, 'outcome_unknown')
})
test('attempted cold stored recovery flushes without Agent/create/resolve', async () => {
  const f = fixture({ cold: true }), r = await f.request(); assert.equal(r.statusCode, 201); assert.equal(f.creates, 0)
  assert.ok(f.order.includes('flush')); assert.ok(f.order.includes('stat')); assert.equal(f.state.roles.center.sessionId, id)
})
for (const failure of ['missing', 'flush', 'header', 'no-agent']) test(`new-session ${failure} retains attempted without binding`, async () => {
  const f = fixture({ failure }), r = await f.request(); assert.equal(r.statusCode, 503); assert.equal(r.body.error_code, 'role_session_not_durable')
  assert.equal(f.state.roles.center, undefined); assert.equal(f.state.sessionCreateOperations[op].status, 'attempted'); assert.equal(f.creates, 1)
})
for (const failure of ['missing', 'flush', 'header']) test(`cold stored ${failure} retains intent without activation`, async () => {
  const f = fixture({ cold: true, failure }), r = await f.request()
  assert.equal(r.statusCode, 503); assert.equal(r.body.error_code, 'role_session_not_durable')
  assert.equal(f.creates, 0); assert.equal(f.state.roles.center, undefined); assert.equal(f.state.sessionCreateOperations[op].status, 'attempted')
})
for (const conflict of ['binding', 'archive', 'membership', 'turn']) test(`await ${conflict} preserves original business conflict`, async () => {
  const f = fixture({ cold: true, conflict }), r = await f.request(); assert.equal(r.statusCode, 409)
  assert.equal(r.body.error, conflict === 'binding' ? 'stale-session-binding' : 'session-create-outcome-unknown')
  assert.equal(f.state.sessionCreateOperations[op].status, conflict === 'binding' ? 'created_unbound' : 'outcome_unknown'); assert.equal(f.creates, 0)
})
for (const status of ['completed', 'created_unbound', 'outcome_unknown', 'attempted']) test(`${status} replay never mints or newly flushes`, async () => {
  const f = fixture({ status, failure: 'missing' }), r = await f.request()
  assert.equal(r.statusCode, status === 'completed' ? 200 : 409); assert.equal(f.creates, 0); assert.equal(f.order.includes('flush'), false)
})
