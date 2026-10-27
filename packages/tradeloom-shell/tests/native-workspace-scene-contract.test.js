import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { validateSceneConfig } from '../scene-layout.js'
import { defaultDockLayout, normalizeDockLayouts, validateDockLayouts, validateDockviewLayout } from '../dock-layout.js'
import { createScenesHandler } from '../host.js'

const original = JSON.parse(await readFile(new URL('../scenes.json', import.meta.url), 'utf8'))
const pane = { id: 'local-workspace', type: 'native-workspace', title: '本地文件', category: 'resources', optional: true, col: 1, row: 1, w: 1, h: 1 }
function configured(extra = {}) {
  const config = structuredClone(original)
  config.scenes[0].panels.push({ ...pane, ...extra })
  return config
}

test('workspace pane accepts scene role inheritance and valid explicit role without changing business panes', () => {
  for (const extra of [{}, { roleId: 'product' }]) {
    const config = configured(extra)
    assert.strictEqual(validateSceneConfig(config), config)
    assert.deepEqual(config.scenes[0].panels.filter(p => ['files', 'preview'].includes(p.id)), original.scenes[0].panels.filter(p => ['files', 'preview'].includes(p.id)))
  }
  assert.throws(() => validateSceneConfig(configured({ roleId: 'untrusted-role' })), /panel/)
  assert.throws(() => validateSceneConfig(configured({ type: 'unregistered-type' })), /panel/)
})

test('optional chat still requires an explicit role and every scene still needs required chat', () => {
  const chat = configured({ type: 'native-chat' })
  assert.throws(() => validateSceneConfig(chat), /panel/)
  const noChat = configured()
  noChat.scenes[0].panels = noChat.scenes[0].panels.filter(p => p.type !== 'native-chat')
  assert.throws(() => validateSceneConfig(noChat), /required native chat/)
})

test('new optional workspace defaults closed and upgrades old layouts and floating restore without moving old panes', () => {
  const config = configured(), scene = config.scenes[0]
  assert.ok(defaultDockLayout(scene).closedPanelIds.includes(pane.id))
  const old = defaultDockLayout(original.scenes[0])
  old.floatingRestore = { dockview: structuredClone(old.dockview), closedPanelIds: [...old.closedPanelIds] }
  const result = normalizeDockLayouts(config, { version: 2, scenes: { [scene.id]: old } }).scenes[scene.id]
  assert.deepEqual(result.dockview, old.dockview)
  assert.deepEqual(result.floatingRestore.dockview, old.floatingRestore.dockview)
  assert.ok(result.closedPanelIds.includes(pane.id))
  assert.ok(result.floatingRestore.closedPanelIds.includes(pane.id))
})

test('workspace open records use registered type/title and retain panelId-only params and floating rejection', () => {
  const config = configured(), scene = config.scenes[0]
  const layout = defaultDockLayout(scene)
  layout.closedPanelIds = layout.closedPanelIds.filter(id => id !== pane.id)
  let leaf = layout.dockview.grid.root
  while (leaf.type === 'branch') leaf = leaf.data[0]
  leaf.data.views.push(pane.id)
  layout.dockview.panels[pane.id] = { id: pane.id, contentComponent: pane.type, title: pane.title, renderer: 'always', params: { panelId: pane.id } }
  assert.doesNotThrow(() => validateDockLayouts(config, { version: 2, scenes: { [scene.id]: layout } }))
  for (const field of ['sessionId', 'roleId', 'authority']) {
    const invalid = structuredClone(layout)
    invalid.dockview.panels[pane.id].params[field] = 'external'
    assert.throws(() => validateDockviewLayout(scene, invalid.dockview, invalid.closedPanelIds), /parameters/)
  }
  const invalid = structuredClone(layout)
  invalid.dockview.panels[pane.id].contentComponent = 'native-chat'
  assert.throws(() => validateDockviewLayout(scene, invalid.dockview, invalid.closedPanelIds), /registered component/)
  const floating = structuredClone(layout)
  floating.dockview.floatingGroups = [{ data: { id: 'workspace-float', views: [pane.id], activeView: pane.id }, position: { top: 0, left: 0, width: 400, height: 300 } }]
  assert.throws(() => validateDockviewLayout(scene, floating.dockview, floating.closedPanelIds), /tree view references an unknown or repeated panel/)
})

test('Host scene response carries workspace declaration and existing bindings without creating a session', async () => {
  const config = configured()
  let status, payload
  const handler = createScenesHandler({ connection: { requestRejection: () => undefined }, webServer: { getOrigin: () => 'http://127.0.0.1:33188' } }, {
    readScenes: async () => JSON.stringify(config),
    createStateStore: async () => ({ read: async () => ({ roles: {} }) }),
  })
  const res = { setHeader() {}, writeHead(code) { status = code }, end(body) { payload = JSON.parse(body) }, set statusCode(code) { status = code } }
  await handler({ method: 'GET' }, res)
  assert.equal(status, 200)
  assert.equal(payload.scenes[0].panels.at(-1).type, 'native-workspace')
  assert.deepEqual(payload.sessionBindings, {})
  assert.deepEqual(payload.scenes[0].panels.filter(p => ['files', 'preview'].includes(p.id)), original.scenes[0].panels.filter(p => ['files', 'preview'].includes(p.id)))
})
