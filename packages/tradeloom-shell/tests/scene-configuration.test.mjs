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

test('a custom runs scene saves both selected components and restores each slot independently', async () => {
  const f = fixture(), handler = createScenesHandler(f.ctx, f.dependencies)
  const first = await f.request(handler, 'GET')
  const component = first.body.componentCatalog.find(value => value.id === 'artifact-files')
  const next = structuredClone(defaults)
  const scene = { ...structuredClone(next.scenes.find(value => value.id === 'runs')), id: 'runs-copy', templateSceneId: 'runs' }
  delete scene.defaultBusinessRoute
  next.scenes.push(scene)
  const panel = scene.panels.find(value => value.id === component.panelId)
  const original = { ...panel }
  Object.assign(panel, { componentId: component.id, path: component.path, title: component.label })
  const product = first.body.componentCatalog.find(value => value.id === 'product-catalog')
  const auxiliary = scene.panels.find(value => value.id === product.panelId)
  const originalAuxiliary = { ...auxiliary }
  Object.assign(auxiliary, { componentId: product.id, path: product.path, title: '商品筛选', h: 1 })
  for (const change of [{ componentId: 'unknown' }, { path: '/artifacts' }, { type: 'native-chat' },
    { roleId: 'center' }, { data: {} }, { id: 'different-slot' }]) {
    const bad = structuredClone(next)
    Object.assign(bad.scenes.at(-1).panels.find(value => value.id === panel.id), change)
    assert.equal((await f.request(handler, 'PUT', { expectedRevision: first.body.configurationRevision, configuration: bad })).status, 400)
  }
  for (const changes of [{ componentId: component.id }, { path: '/agent-center' }, { w: 2 }]) {
    const bad = structuredClone(next)
    Object.assign(bad.scenes.at(-1).panels.find(value => value.id === auxiliary.id), changes)
    assert.equal((await f.request(handler, 'PUT', { expectedRevision: first.body.configurationRevision, configuration: bad })).status, 400)
  }
  assert.equal(f.transactions(), 0)
  const saved = await f.request(handler, 'PUT', { expectedRevision: first.body.configurationRevision, configuration: next })
  assert.equal(saved.status, 200)
  const cold = await f.request(createScenesHandler(f.ctx, f.dependencies), 'GET')
  assert.deepEqual(cold.body.scenes.at(-1), scene)
  assert.deepEqual(cold.body.scenes.find(value => value.id === 'runs'), defaults.scenes.find(value => value.id === 'runs'))
  assert.deepEqual(cold.body.businessRoutes, defaults.businessRoutes)
  assert.deepEqual(cold.body.scenes.at(-1).layoutProfile, defaults.scenes.find(value => value.id === 'runs').layoutProfile)
  delete panel.componentId
  Object.assign(panel, original)
  const restored = await f.request(handler, 'PUT', { expectedRevision: cold.body.configurationRevision, configuration: next })
  assert.equal(restored.status, 200)
  assert.deepEqual(restored.body.scenes.at(-1).panels.find(value => value.id === original.id), original)
  assert.deepEqual(restored.body.scenes.at(-1).panels.find(value => value.id === auxiliary.id), auxiliary)
  delete auxiliary.componentId
  Object.assign(auxiliary, { path: originalAuxiliary.path, title: originalAuxiliary.title })
  const restoredBoth = await f.request(handler, 'PUT', { expectedRevision: restored.body.configurationRevision, configuration: next })
  assert.equal(restoredBoth.status, 200)
  assert.deepEqual(restoredBoth.body.scenes.at(-1).panels.find(value => value.id === auxiliary.id), { ...originalAuxiliary, h: 1 })
})

test('Host accepts only custom template instances and preserves built-ins and layout state', async () => {
  const f = fixture(), handler = createScenesHandler(f.ctx, f.dependencies)
  const initial = (await f.request(handler, 'GET')).body
  const next = structuredClone(defaults)
  const copy = structuredClone(next.scenes.find(scene => scene.id === 'runs'))
  copy.id = 'runs-composed'; copy.templateSceneId = 'runs'
  delete copy.defaultBusinessRoute
  copy.panels.find(panel => panel.id === 'business-main').h = 1
  const fromCatalog = (componentId, col) => {
    const entry = initial.componentCatalog.find(item => item.id === componentId)
    return { id: `component-${componentId}`, componentId, col, row: 2, w: 1, h: 1,
      title: entry.label, type: entry.type, path: entry.path, category: entry.category }
  }
  const file = fromCatalog('artifact-files', 1), product = fromCatalog('product-catalog', 3)
  copy.panels.push(file, product)
  next.scenes.push(copy)
  const attempt = (configuration, revision = initial.configurationRevision) =>
    f.request(handler, 'PUT', { expectedRevision: revision, configuration })
  for (const change of [
    bad => { bad.scenes.at(-1).templateSceneId = 'fictional' },
    bad => { bad.scenes.at(-1).panels.at(-1).path = '/artifacts' },
    bad => { bad.scenes.at(-1).panels.at(-1).col = 1 },
    bad => { const scene = bad.scenes.at(-1); scene.panels = scene.panels.filter(panel => panel.type !== 'native-chat') },
    bad => { bad.scenes[0].templateSceneId = 'runs' },
    bad => { const runs = bad.scenes.find(scene => scene.id === 'runs'); runs.templateSceneId = 'center'
      runs.panels.find(panel => panel.id === 'business-main').h = 1; runs.panels.push(product) },
    bad => { bad.businessRoutes['/runs'].sceneId = copy.id },
  ]) {
    const rejected = structuredClone(next); change(rejected)
    assert.equal((await attempt(rejected)).status, 400)
  }
  const saved = await attempt(next)
  assert.equal(saved.status, 200)
  assert.equal((await attempt(next)).status, 409)
  const cold = (await f.request(createScenesHandler(f.ctx, f.dependencies), 'GET')).body
  assert.deepEqual(cold.scenes.at(-1), copy)
  assert.deepEqual(cold.scenes.find(scene => scene.id === 'runs'), defaults.scenes.find(scene => scene.id === 'runs'))
  await f.store.transact(state => { state.sceneWorkbench = { activeSceneId: copy.id, roleByScene: { [copy.id]: 'center' },
    layouts: { [copy.id]: { expandedPanel: file.id, panels: { [file.id]: { visible: true }, [product.id]: { visible: false } } } } } })
  copy.panels = copy.panels.filter(panel => panel.id !== file.id)
  const removed = await attempt(next, cold.configurationRevision)
  assert.equal(removed.status, 200)
  const state = await f.store.read()
  assert.deepEqual(state.sceneWorkbench.layouts[copy.id], { expandedPanel: '', panels: { [product.id]: { visible: false } } })
  assert.equal(state.sceneWorkbench.roleByScene[copy.id], 'center')
})
