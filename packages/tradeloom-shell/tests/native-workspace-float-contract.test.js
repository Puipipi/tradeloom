import test from 'node:test'
import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import { validateSceneConfig } from '../scene-layout.js'
import { validateDockviewLayout, validateDockLayouts } from '../dock-layout.js'
import { createDockLayoutsHandler } from '../host.js'

const config = {
  version: 1, grid: { cols: 4, rows: 4 }, businessRoutes: Object.fromEntries(['/home', '/products', '/agent-center', '/artifacts', '/runs'].map(path => [path, { sceneId: 'center', panelId: 'business-main' }])), scenes: [{
    id: 'center', label: 'Center', roleId: 'center', defaultBusinessRoute: '/home', panels: [
      { id: 'business-main', type: 'business-iframe', title: 'Business', path: '/home', col: 1, row: 1, w: 2, h: 2 },
      { id: 'native-chat', type: 'native-chat', title: 'Chat', col: 3, row: 1, w: 2, h: 2 },
      { id: 'native-workspace', type: 'native-workspace', title: 'Resources', optional: true, col: 1, row: 3, w: 4, h: 2 },
    ],
  }],
}
const scene = config.scenes[0]
const clone = value => structuredClone(value)
function layout(floated = 'native-workspace') {
  const ids = scene.panels.map(p => p.id)
  const gridIds = ids.filter(id => id !== floated)
  return {
    grid: { root: { type: 'branch', size: 100, data: [{ type: 'leaf', size: 100,
      data: { id: 'grid-group', views: gridIds, activeView: gridIds[0] } }] }, width: 1200, height: 800, orientation: 'HORIZONTAL' },
    activeGroup: 'float-group',
    panels: Object.fromEntries(scene.panels.map(p => [p.id, { id: p.id, contentComponent: p.type, title: p.title, renderer: 'always', params: { panelId: p.id } }])),
    floatingGroups: [{ data: { id: 'float-group', views: [floated], activeView: floated }, position: { top: 10, left: 20, width: 600, height: 400 } }],
  }
}
function dockDocument() {
  const restored = layout()
  restored.grid.root.data[0].data.views.push('native-workspace')
  restored.floatingGroups = []
  restored.activeGroup = 'grid-group'
  return { version: 2, scenes: { center: { version: 2, dockview: layout(), closedPanelIds: [],
    floatingRestore: { dockview: restored, closedPanelIds: [] } } } }
}
function request(method, body) {
  const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))])
  req.method = method
  return req
}
function response() {
  return { statusCode: 0, headers: {}, body: '', setHeader(k, v) { this.headers[k] = v }, end(v = '') { this.body += v } }
}

test('native workspace inherits scene role and accepts only panelId when floated and restored', () => {
  assert.equal(validateSceneConfig(config), config)
  assert.equal(scene.panels[2].roleId, undefined)
  assert.equal(scene.roleId, 'center')
  assert.equal(validateDockviewLayout(scene, layout(), []), true)
  const saved = validateDockLayouts(config, dockDocument())
  assert.deepEqual(saved.scenes.center.dockview.panels['native-workspace'].params, { panelId: 'native-workspace' })
  assert.equal(saved.scenes.center.floatingRestore.dockview.floatingGroups.length, 0)
  for (const id of ['native-chat', 'business-main']) assert.equal(validateDockviewLayout(scene, layout(id), []), true)
})

test('resource float preserves all cardinality, identity, component, position and authority guards', () => {
  const mutations = [
    d => d.floatingGroups.push(clone(d.floatingGroups[0])),
    d => d.floatingGroups[0].data.views.push('native-chat'),
    d => d.grid.root.data[0].data.views.push('native-workspace'),
    d => { d.floatingGroups[0].data.views = ['unknown']; d.floatingGroups[0].data.activeView = 'unknown' },
    d => { d.panels['native-workspace'].contentComponent = 'native-chat' },
    d => { d.panels['native-workspace'].title = 'Spoofed' },
    d => { d.floatingGroups[0].position.width = 0 },
    d => { d.floatingGroups[0].position.top = Infinity },
    d => { d.floatingGroups[0].position.url = 'forbidden' },
    ...['sessionId', 'roleId', 'authority'].map(key => d => { d.panels['native-workspace'].params[key] = 'injected' }),
  ]
  for (const mutate of mutations) { const d = layout(); mutate(d); assert.throws(() => validateDockviewLayout(scene, d, [])) }
})

test('Host fake PUT/GET changes only dockLayouts and retains roles/revisions and restore snapshot', async () => {
  const state = { version: 1, roles: { center: { sessionId: 'trusted-center', workspaceId: 'workspace', workspacePath: 'owned-path', agentPreset: 'center-preset' } },
    roleBindingRevisions: { center: '7' }, budgets: { untouched: true }, sceneWorkbench: null, dockLayouts: { version: 2, scenes: {} } }
  const nonLayout = clone(state); delete nonLayout.dockLayouts
  const store = { async read() { return clone(state) }, async transact(fn) { return clone(await fn(state)) } }
  const handler = createDockLayoutsHandler({ connection: { requestRejection: () => undefined } }, { createStateStore: () => store, readScenes: async () => JSON.stringify(config) })
  const put = response(); await handler(request('PUT', dockDocument()), put); assert.equal(put.statusCode, 200)
  const get = response(); await handler(request('GET'), get); assert.equal(get.statusCode, 200)
  const actual = JSON.parse(get.body).scenes.center
  assert.deepEqual(actual.dockview.floatingGroups[0].data.views, ['native-workspace'])
  assert.deepEqual(actual.dockview.panels['native-workspace'].params, { panelId: 'native-workspace' })
  assert.equal(actual.floatingRestore.dockview.floatingGroups.length, 0)
  const after = clone(state); delete after.dockLayouts; assert.deepEqual(after, nonLayout)
})

test('Host authorization rejects before any store or scene read', async () => {
  let calls = 0
  const fail = () => { calls++; throw Error('must not reach fixture dependency') }
  const handler = createDockLayoutsHandler({ connection: { requestRejection: () => 401 } }, { createStateStore: fail, readScenes: fail })
  for (const method of ['GET', 'PUT']) { const res = response(); await handler(request(method, dockDocument()), res); assert.equal(res.statusCode, 401) }
  assert.equal(calls, 0)
})
