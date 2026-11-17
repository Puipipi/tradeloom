import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { Readable } from 'node:stream'
import { createScenesHandler, createSourceShellBindingHandler } from '../host.js'
import { resolveSceneConfiguration, sceneConfigurationRevision } from '../scene-layout.js'

const defaults = JSON.parse(await readFile(new URL('../scenes.json', import.meta.url), 'utf8'))
function fixture() {
  let state = { roles: {}, roleBindingRevisions: {} }, transactions = 0
  const store = { read: async () => structuredClone(state), transact: async action => {
    const next = structuredClone(state), result = await action(next)
    state = next; transactions++; return result
  } }
  const dependencies = { createStateStore: async () => store, readScenes: async () => JSON.stringify(defaults) }
  const ctx = { connection: { requestRejection: () => undefined }, webServer: { getOrigin: () => 'http://127.0.0.1:12345' }, workspaceRegistry: {} }
  async function request(handler, method, body) {
    const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]); req.method = method
    let response
    const res = { statusCode: 200, setHeader() {}, end(value) { response = value ? JSON.parse(value) : undefined } }
    await handler(req, res); return { status: res.statusCode, body: response }
  }
  return { request, dependencies, ctx, store, transactions: () => transactions }
}

test('saved Host configuration is consumed by GET and resolve-binding, with optimistic revision fencing', async () => {
  const f = fixture(), scenes = createScenesHandler(f.ctx, f.dependencies)
  const first = await f.request(scenes, 'GET')
  assert.equal(first.status, 200)
  const next = structuredClone(defaults), copy = { ...structuredClone(next.scenes[0]), id: 'synthetic-new', label: 'Synthetic', templateSceneId: next.scenes[0].id }
  delete copy.defaultBusinessRoute; next.scenes.push(copy)
  const saved = await f.request(scenes, 'PUT', { expectedRevision: first.body.configurationRevision, configuration: next })
  assert.equal(saved.status, 200); assert.equal(saved.body.scenes.at(-1).id, copy.id)
  assert.notEqual(saved.body.configurationRevision, first.body.configurationRevision)
  const collision = await f.request(scenes, 'PUT', { expectedRevision: first.body.configurationRevision, configuration: defaults })
  assert.equal(collision.status, 409)
  const binding = createSourceShellBindingHandler(f.ctx, f.dependencies)
  const panel = copy.panels.find(panel => panel.type === 'native-chat' && !panel.optional)
  const resolved = await f.request(binding, 'POST', { sceneId: copy.id, panelId: panel.id })
  assert.equal(resolved.status, 200); assert.equal(resolved.body.bindingStatus, 'unbound')
  assert.deepEqual((await f.store.read()).roles, {})
})

test('invalid role/layout rejects before saving; revision includes every field but is key-order independent', async () => {
  const f = fixture(), handler = createScenesHandler(f.ctx, f.dependencies)
  const invalid = structuredClone(defaults); invalid.scenes[0].roleId = 'renderer-owner'
  const result = await f.request(handler, 'PUT', { expectedRevision: sceneConfigurationRevision(defaults), configuration: invalid })
  assert.equal(result.status, 400); assert.equal(f.transactions(), 0)
  assert.equal(sceneConfigurationRevision(defaults), sceneConfigurationRevision(Object.fromEntries(Object.entries(defaults).reverse())))
  assert.deepEqual(resolveSceneConfiguration(defaults, {}), defaults)
})
