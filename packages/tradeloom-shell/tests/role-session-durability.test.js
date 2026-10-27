import test from 'node:test'
import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import { createSessionHandler } from '../host.js'
import { ROLE_IDS } from '../roles.js'

function fixture(mode) {
  const order = [], state = { roles: {}, roleBindingRevisions: Object.fromEntries(ROLE_IDS.map(role => [role, '0'])) }
  const workspace = { id: 'workspace', path: 'C:/owned/test', sessionIds: [] }
  let agent, committed = false
  const persistence = { identity: Symbol('official-service'),
    async flush() {
      order.push('flush'); assert.equal(state.roles.center, undefined)
      if (mode === 'flush-reject') throw new Error('private key stack')
      if (mode === 'replace-agent') agent = { ...agent }
      if (mode === 'replace-service') ctx.get = () => ({ ...persistence, identity: Symbol('new') })
    },
    async stat(id) { order.push('stat'); return { header: { id: mode === 'bad-id' ? 'wrong' : id,
      cwd: mode === 'bad-cwd' ? 'wrong' : workspace.path, agentPreset: mode === 'bad-preset' ? 'wrong' : 'tradeloom-center' } } },
  }
  const ctx = { connection: { requestRejection: () => undefined },
    get: () => mode === 'missing' ? undefined : persistence,
    agents: { get: id => agent?.id === id ? agent : undefined },
    workspaceRegistry: { list: () => [workspace], get: () => workspace },
    sessionController: { async create(input) {
      order.push('create'); workspace.sessionIds.push(input.sessionId)
      agent = { id: input.sessionId, session: { id: input.sessionId }, ctx: { get: () => mode === 'wrong-identity' ? { ...persistence, identity: Symbol('other') } : persistence } }
      return { sessionId: input.sessionId, agentPreset: input.agentPreset }
    } },
  }
  const handler = createSessionHandler(ctx, { resolveOwnedHome: async () => 'C:/owned', roleWorkspacePath: async () => workspace.path,
    createStateStore: async () => ({ async transact(callback) { const value = await callback(state); order.push('commit'); committed = true; return value } }) })
  const request = () => Object.assign(Readable.from([Buffer.from(JSON.stringify({ role: 'center' }))]), { method: 'POST' })
  const response = () => ({ setHeader() {}, end(text) { this.body = JSON.parse(text) } })
  return { handler, request, response, state, order, ctx, get committed() { return committed } }
}
test('new role flushes public persistence before stat and binding commit', async () => {
  const f = fixture(), res = f.response(); await f.handler(f.request(), res)
  assert.equal(res.statusCode, 200); assert.deepEqual(f.order, ['create', 'flush', 'stat', 'commit'])
  assert.ok(f.state.roles.center.sessionId)
})
for (const mode of ['missing', 'wrong-identity', 'flush-reject', 'bad-id', 'bad-cwd', 'bad-preset', 'replace-agent', 'replace-service']) {
  test(`${mode} never persists role binding or exposes SDK error`, async () => {
    const f = fixture(mode), res = f.response(); await f.handler(f.request(), res)
    assert.equal(res.statusCode, 503); assert.equal(res.body.error_code, 'role_session_not_durable')
    assert.equal(f.committed, false); assert.equal(f.state.roles.center, undefined)
    assert.doesNotMatch(JSON.stringify(res.body), /private|stack|key/)
  })
}
test('existing binding never creates or flushes even with no persistence service', async () => {
  const f = fixture('missing'); f.state.roles.center = { sessionId: 'existing', workspaceId: 'workspace' }
  const res = f.response(); await f.handler(f.request(), res)
  assert.equal(res.statusCode, 200); assert.deepEqual(f.order, ['commit']); assert.equal(res.body.sessionId, 'existing')
})
