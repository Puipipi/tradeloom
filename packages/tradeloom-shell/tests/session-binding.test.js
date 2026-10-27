import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import test from 'node:test'
import { createSessionHandler, createScenesHandler } from '../host.js'

function request() {
  const request = Readable.from([Buffer.from(JSON.stringify({ role: 'center' }))])
  request.method = 'POST'
  return request
}

function response() {
  return { statusCode: 0, setHeader() {}, end(body) { this.body = body } }
}

for (const [archives, expected] of [[['existing-session'], 'archived'], [[], 'unarchived'], [undefined, 'unknown']]) {
  test(`existing role binding exposes ${expected} archive state without replacing or restoring the session`, async () => {
    const state = { roles: { center: { sessionId: 'existing-session', workspaceId: 'workspace-existing' } } }
    const before = structuredClone(state)
    let created = 0
    let restored = 0
    const ctx = {
      connection: { requestRejection: () => undefined },
      workspaceRegistry: {
        archivedSessionIds: archives,
        async create() { created++; throw new Error('must not create workspace') },
        async unarchiveSession() { restored++; throw new Error('must preserve archive intent') },
      },
      sessionController: { async create() { created++; throw new Error('must preserve existing session') } },
    }
    const handler = createSessionHandler(ctx, {
      resolveOwnedHome: async () => 'owned-home',
      createStateStore: async () => ({ transact: callback => callback(state) }),
    })
    const result = response()
    await handler(request(), result)
    assert.equal(result.statusCode, 200)
    const value = JSON.parse(result.body)
    assert.equal(value.sessionId, 'existing-session')
    assert.deepEqual(value.binding, {
      scope: 'role', roleId: 'center', sessionId: 'existing-session', workspaceId: 'workspace-existing',
      bindingRevision: '1', archiveState: expected,
    })
    assert.deepEqual(state, before)
    assert.equal(created, 0)
    assert.equal(restored, 0)
  })
}

test('scene bootstrap reads matched binding metadata without creating, restoring or writing a session', async () => {
  const state = { roles: {
    center: { sessionId: 'old-center', workspaceId: 'workspace-center' },
    product: { sessionId: 'new-product', workspaceId: 'workspace-product' },
    delivery: { sessionId: '' },
  }, roleBindingRevisions: { center: '17', product: '23', delivery: '0', market: '0', quote: '0', 'user-profile': '0' } }
  const before = structuredClone(state)
  let writes = 0
  let reads = 0
  const handler = createScenesHandler({
    connection: { requestRejection: () => undefined },
    webServer: { getOrigin: () => 'http://127.0.0.1:3088' },
    workspaceRegistry: { archivedSessionIds: ['old-center', 'old-product'] },
  }, { createStateStore: async () => ({
    async read() { reads++; return state },
    async transact() { writes++; throw new Error('bootstrap must remain read-only') },
  }) })
  const input = Readable.from([])
  input.method = 'GET'
  const result = response()
  await handler(input, result)
  assert.equal(result.statusCode, 200)
  const value = JSON.parse(result.body)
  assert.deepEqual(value.sessionBindings, { center: 'old-center', product: 'new-product' })
  assert.equal(value.sessionBindingMetadata.center.sessionId, value.sessionBindings.center)
  assert.equal(value.sessionBindingMetadata.center.bindingRevision, '17')
  assert.equal(value.sessionBindingMetadata.center.archiveState, 'archived')
  assert.equal(value.sessionBindingMetadata.product.sessionId, 'new-product')
  assert.equal(value.sessionBindingMetadata.product.bindingRevision, '23')
  assert.equal(value.sessionBindingMetadata.product.archiveState, 'unarchived')
  assert.equal(value.sessionBindingMetadata.delivery, undefined)
  assert.equal(reads, 1)
  assert.equal(writes, 0)
  assert.deepEqual(state, before)
})
