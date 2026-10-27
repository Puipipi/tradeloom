import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { runInNewContext } from 'node:vm'
import { Readable } from 'node:stream'
import { File } from 'node:buffer'
import test from 'node:test'
import { ROLE_IDS } from '../state.js'
import { createScenesHandler } from '../host.js'
import { defaultSceneWorkbench } from '../scene-layout.js'
import { defaultDockLayout, normalizeDockLayouts, validateDockLayouts, validateDockviewLayout } from '../dock-layout.js'
import { pathToFileURL } from 'node:url'
import { publicRoleMetadata } from '../roles.js'

const sceneConfigUrl = new URL('../scenes.json', import.meta.url)
const sceneChunkUrl = new URL('../client.scenes.js', import.meta.url)

async function readClientSceneConfig() {
  return { ...JSON.parse(await readFile(sceneConfigUrl, 'utf8')), roles: publicRoleMetadata() }
}

test('scene JSON defines role-bound 4x4 grids and maps all known business routes', async () => {
  const config = await readClientSceneConfig()
  const { validateSceneConfig, normalizeSceneWorkbench } = await import('../scene-layout.js')
  assert.strictEqual(validateSceneConfig(config), config)
  assert.equal(config.version, 1)
  assert.deepEqual(config.grid, { cols: 4, rows: 4 })
  assert.deepEqual(config.scenes.map(scene => [scene.id, scene.label, scene.roleId]), [
    ['center', '工作总览', 'center'],
    ['products', '商品', 'product'],
    ['agent-center', '工作流', 'center'],
    ['deliverables', '交付物', 'delivery'],
    ['runs', '运行记录', 'center'],
    ['user-profile', '资料整理', 'user-profile'],
    ['erpnext', 'ERPNext', 'center'],
  ])
  assert.deepEqual(config.scenes.map(scene => scene.icon), ['⌂', '▦', '◉', '⇩', '≋', '◈', '▤'],
    'each scene has a compact, accessible glyph for the unified navigation rail')
  assert.deepEqual(config.scenes.map(scene => [scene.id, scene.layoutProfile.kind, scene.layoutProfile.minimumWidth, scene.layoutProfile.minimumHeight]), [
    ['center', 'collaboration_grid', 960, 560],
    ['products', 'collaboration_grid', 960, 560],
    ['agent-center', 'collaboration_grid', 960, 560],
    ['deliverables', 'collaboration_grid', 960, 560],
    ['runs', 'business_lead', 1143, 360],
    ['user-profile', 'collaboration_grid', 960, 560],
    ['erpnext', 'business_lead', 1143, 360],
  ], 'every scene uses the reviewed split profile and canvas fit threshold')
  const invalidProfile = structuredClone(config)
  invalidProfile.scenes[0].layoutProfile.minimumWidth++
  assert.throws(() => validateSceneConfig(invalidProfile), /dock layout profile/)
  const erpScene = config.scenes.find(scene => scene.id === 'erpnext')
  assert.equal(erpScene.panels.find(panel => panel.id === 'auxiliary').text, '在此添加与当前业务相关的资料与任务。')
  assert.equal(erpScene.panels.find(panel => panel.id === 'reference').text, '在此配置当前业务的参考资料来源。')
  assert.ok(config.scenes.every(scene => ROLE_IDS.includes(scene.roleId)))
  assert.deepEqual(Object.keys(config.businessRoutes).sort(), ['/agent-center', '/artifacts', '/home', '/products', '/runs'])
  assert.deepEqual(config.businessRoutes['/agent-center'], { sceneId: 'agent-center', panelId: 'business-main' })
  assert.deepEqual(config.businessRoutes['/products'], { sceneId: 'products', panelId: 'business-main' })
  assert.deepEqual(config.businessRoutes['/artifacts'], { sceneId: 'deliverables', panelId: 'business-main' })
  assert.deepEqual(config.businessRoutes['/runs'], { sceneId: 'runs', panelId: 'business-main' })
  assert.equal(config.scenes.find(scene => scene.id === 'deliverables').defaultBusinessPath, '/artifacts#deliverables',
    'the delivery scene opens the existing delivery-versions section')
  assert.equal(config.scenes.find(scene => scene.id === 'user-profile').defaultBusinessPath, '/artifacts#sources',
    'the materials scene opens the existing source-intake section')
  const invalidBusinessFragment = structuredClone(config)
  invalidBusinessFragment.scenes.find(scene => scene.id === 'user-profile').defaultBusinessPath = '/artifacts#unknown'
  assert.throws(() => validateSceneConfig(invalidBusinessFragment), /business path/)
  const centerRecommendationRecord = defaultDockLayout(config.scenes[0])
  const centerRecommendation = centerRecommendationRecord.dockview
  assert.equal(centerRecommendation.grid.orientation, 'VERTICAL')
  assert.deepEqual(centerRecommendation.grid.root.data.map(row => row.size), [60, 40],
    'the recommended workbench reserves the larger upper band for business content')
  assert.deepEqual(centerRecommendation.grid.root.data.map(row => row.data.map(column => column.size)), [[75, 25], [40, 60]],
    'the upper band pairs business content with files and the lower band favors chat beside preview')
  assert.deepEqual(centerRecommendationRecord.closedPanelIds, ['assistant-product', 'assistant-delivery', 'assistant-user-profile', 'native-workspace'],
    'alternate assistants and project files remain available without consuming default workspace space')
  for (const sceneId of ['center', 'products', 'agent-center', 'deliverables', 'user-profile']) {
    const scene = config.scenes.find(item => item.id === sceneId)
    assert.equal(scene.panels.find(panel => panel.id === 'files')?.path, '/artifacts#files', `${sceneId} has a distinct files pane`)
    assert.equal(scene.panels.find(panel => panel.id === 'preview')?.path, '/artifacts#preview', `${sceneId} has a distinct preview pane`)
  }
  assert.equal(config.scenes.find(scene => scene.id === 'runs').panels.some(panel => panel.id === 'files'), false,
    'the records workspace retains its specialized layout')
  assert.equal(centerRecommendation.activeGroup, 'topa', 'the default workbench opens on the business preview')
  for (const scene of config.scenes) {
    assert.deepEqual(new Set(scene.panels.map(panel => panel.id)).size, scene.panels.length)
    const business = scene.panels.find(panel => panel.id === 'business-main')
    const auxiliary = scene.panels.find(panel => panel.id === 'auxiliary' || panel.id === 'files')
    const reference = scene.panels.find(panel => panel.id === 'reference' || panel.id === 'preview')
    const chat = scene.panels.find(panel => panel.id === 'native-chat')
    assert.deepEqual([business, auxiliary, reference, chat].map(({ col, row, w, h }) => ({ col, row, w, h })), [
      { col: 1, row: 1, w: 3, h: 2 },
      { col: 4, row: 1, w: 1, h: 2 },
      { col: 1, row: 3, w: 1, h: 2 },
      { col: 2, row: 3, w: 3, h: 2 },
    ])
    assert.equal(chat.type, 'native-chat')
    assert.ok(['business-iframe', 'erpnext-status'].includes(business.type))
    if (scene.id !== 'erpnext') {
      assert.equal(auxiliary.type, 'business-iframe', `${scene.id} uses an existing business page in its auxiliary panel`)
      assert.equal(reference.type, 'business-iframe', `${scene.id} uses an existing business page in its reference panel`)
    }
  }
  const added = structuredClone(config)
  added.scenes.push({
    id: 'generic-extension', label: '通用场景', roleId: 'center', panels: [
      { id: 'business-main', type: 'business-iframe', title: '总览', path: '/home', col: 1, row: 1, w: 3, h: 2 },
      { id: 'auxiliary', type: 'placeholder', title: '辅助资料', text: '未配置', col: 4, row: 1, w: 1, h: 2 },
      { id: 'reference', type: 'placeholder', title: '参考资料', text: '未配置', col: 1, row: 3, w: 1, h: 2 },
      { id: 'native-chat', type: 'native-chat', title: '中心助手', col: 2, row: 3, w: 3, h: 2 },
    ],
  })
  assert.strictEqual(validateSceneConfig(added), added, 'a new scene using registered panels needs no renderer change')
  for (const mutate of [
    value => { value.scenes[0].panels[0].type = 'arbitrary-module' },
    value => { value.scenes[0].panels[1].id = value.scenes[0].panels[0].id },
    value => { value.scenes[0].panels[0].col = 4 },
    value => { value.scenes = [] },
  ]) {
    const invalid = structuredClone(config)
    mutate(invalid)
    assert.throws(() => validateSceneConfig(invalid), /scene|panel|grid|route/i)
  }
  const state = normalizeSceneWorkbench(config, {
    version: 1,
    activeSceneId: 'user-profile', roleByScene: { center: 'product', 'user-profile': 'delivery', erpnext: 'center' }, businessPath: '/artifacts',
    layouts: { center: { expandedPanel: 'native-chat', panels: { 'business-main': { visible: false } } } },
  })
  assert.equal(state.activeSceneId, 'user-profile')
  assert.equal(state.roleByScene['user-profile'], 'delivery')
  assert.equal(state.roleByScene.center, 'product')
  assert.equal(state.layouts.center.panels['business-main'].visible, false)
  assert.equal(state.layouts.center.panels['native-chat'].col, 2)
  assert.equal(state.layouts.center.expandedPanel, 'native-chat')
})

test('scene client chunk exposes independent layout state and scene-to-role mapping', async () => {
  const source = await readFile(sceneChunkUrl, 'utf8')
  let registration
  runInNewContext(source, { window: { __ModuleLoader__: { load(value) { registration = value } } } })
  assert.equal(registration.id, '@tradeloom/dsh-business-shell')
  assert.equal(registration.chunk, 'client.scenes.js')
  const exports = registration.factory(name => {
    assert.equal(name, 'react')
    return { createElement() {} }
  })
  const config = await readClientSceneConfig()
  const center = config.scenes.find(scene => scene.id === 'center')
  const profile = config.scenes.find(scene => scene.id === 'user-profile')
  const states = exports.rememberLayout({}, center.id, { expandedPanel: 'session' })
  const bothStates = exports.rememberLayout(states, profile.id, { expandedPanel: 'business' })
  assert.equal(JSON.stringify(bothStates), JSON.stringify({
    center: { expandedPanel: 'session' },
    'user-profile': { expandedPanel: 'business' },
  }))
  assert.equal(exports.roleForScene(config, 'center'), 'center')
  assert.equal(exports.roleForScene(config, 'user-profile'), 'user-profile')
  assert.equal(exports.roleForScene(config, 'unknown'), undefined)
  assert.equal(exports.roleForPanel(config, 'center', 'native-chat'), 'center')
  assert.equal(exports.roleForPanel(config, 'center', 'assistant-product'), 'product',
    'an optional chat panel resolves its own configured role instead of inheriting the scene role')
  const roleReferences = []
  const sessions = { retain(sessionId) { const reference = { sessionId, release() {} }; roleReferences.push(reference); return reference } }
  const centerReference = exports.retainRoleSession(sessions, 'center', 'session-center')
  const productReference = exports.retainRoleSession(sessions, 'product', 'session-product')
  assert.notStrictEqual(centerReference, productReference, 'parallel assistant panels retain independent native session references')
  assert.deepEqual(roleReferences.map(reference => reference.sessionId), ['session-center', 'session-product'])
  assert.deepEqual(JSON.parse(JSON.stringify(exports.sceneNavigationItems(config))), [
    { id: 'center', label: '工作总览', icon: '⌂', route: '/home', navigationGroup: 'business' },
    { id: 'products', label: '商品', icon: '▦', route: '/products', navigationGroup: 'business' },
    { id: 'agent-center', label: '工作流', icon: '◉', route: '/agent-center', navigationGroup: 'business' },
    { id: 'deliverables', label: '交付物', icon: '⇩', route: '/artifacts', navigationGroup: 'business' },
    { id: 'runs', label: '运行记录', icon: '≋', route: '/runs', navigationGroup: 'tools' },
    { id: 'user-profile', label: '资料整理', icon: '◈', route: null, navigationGroup: 'business' },
    { id: 'erpnext', label: 'ERPNext', icon: '▤', route: null, navigationGroup: 'tools' },
  ])
  const current = {
    config, activeSceneId: 'center', businessPath: '/home', layouts: bothStates,
    businessPathsByScene: { deliverables: '/artifacts', 'user-profile': '/artifacts' },
  }
  const selectedProfile = exports.selectScene(current, 'user-profile')
  assert.equal(selectedProfile.activeSceneId, 'user-profile')
  assert.equal(selectedProfile.businessPath, '/artifacts#sources', 'a legacy bare artifacts URL is normalized to the materials source-intake section')
  assert.equal(exports.selectScene(current, 'deliverables').businessPath, '/artifacts#deliverables',
    'a legacy bare artifacts URL is normalized to the delivery-versions section')
  assert.equal(selectedProfile.layouts.center.expandedPanel, 'session')
  assert.equal(selectedProfile.layouts['user-profile'].expandedPanel, 'business')
  assert.strictEqual(exports.selectScene(selectedProfile, 'unknown'), selectedProfile)
  const expanded = exports.updatePanelLayout({}, 'overview-notes', 'expand')
  const refreshed = exports.updatePanelLayout(expanded, 'business-home', 'refresh')
  assert.equal(refreshed.expandedPanel, 'overview-notes')
  assert.equal(refreshed.refreshCounts['business-home'], 1)
  const bindings = exports.bindSession({}, exports.roleForScene(config, 'center'), 'session-center', config)
  const nextBindings = exports.bindSession(bindings, exports.roleForScene(config, 'user-profile'), 'session-profile', config)
  assert.equal(JSON.stringify(nextBindings), JSON.stringify({ center: 'session-center', 'user-profile': 'session-profile' }))
  assert.equal(typeof exports.PANEL_REGISTRY['business-iframe'], 'function')
  assert.equal(typeof exports.PANEL_REGISTRY.placeholder, 'function')
  assert.equal(typeof exports.PANEL_REGISTRY['native-chat'], 'function')
})

test('file selection bridge relays only validated same-scene files and preview messages', async () => {
  const source = await readFile(sceneChunkUrl, 'utf8')
  let registration
  runInNewContext(source, { URL, Blob, File, setTimeout, clearTimeout,
    window: { location: { origin: 'http://shell.test' }, __ModuleLoader__: { load(value) { registration = value } } } })
  const exports = registration.factory(() => ({ createElement() {} }))
  const config = await readClientSceneConfig()
  const scene = structuredClone(config.scenes.find(item => item.id === 'center'))
  scene.panels.find(panel => panel.id === 'business-main').path = '/artifacts#deliverables'
  const sent = []
  const frame = (panelId, path) => ({
    dataset: { tradeloomPanelId: panelId },
    src: `http://shell.test/business${path}`,
    contentWindow: { postMessage(data, origin) { sent.push({ panelId, data, origin }) } },
  })
  const files = frame('files', '/artifacts#files')
  const preview = frame('preview', '/artifacts#preview')
  const deliverables = frame('business-main', '/artifacts#deliverables')
  const frames = [files, preview, deliverables]
  const handler = exports.createFileSelectionMessageHandler(scene, () => frames, 'http://shell.test')
  const send = (from, data, origin = 'http://shell.test') => handler({ source: from.contentWindow, origin, data })
  const takeSent = () => JSON.parse(JSON.stringify(sent.splice(0)))
  const initialSceneGeneration = exports.getSnapshot().fileSelectionGenerations.center ?? 0
  assert.equal(send(files, { type: 'tradeloom:file-selection', kind: 'artifact', id: 'catalog-version-2', previewMime: 'text/markdown' }), true,
    'a validated catalog version may provide the optional Markdown prefetch hint')
  assert.equal(exports.getSnapshot().fileSelectionGenerations.center, initialSceneGeneration + 1,
    'publishing the validated selection invalidates the preview panel with a monotonic per-scene generation')
  assert.deepEqual(takeSent(), [
    { panelId: 'preview', data: {
      type: 'tradeloom:file-selection', kind: 'artifact', id: 'catalog-version-2', previewMime: 'text/markdown',
    }, origin: 'http://shell.test' },
    { panelId: 'business-main', data: {
      type: 'tradeloom:file-selection', kind: 'artifact', id: 'catalog-version-2', previewMime: 'text/markdown',
    }, origin: 'http://shell.test' },
  ])
  assert.equal(send(files, { type: 'tradeloom:file-selection', kind: 'source', id: 'source-17', previewMime: 'text/markdown' }), false,
    'source files cannot opt into the artifact Markdown reader')
  assert.equal(send(files, { type: 'tradeloom:file-selection', kind: 'artifact', id: 'catalog-version-2', previewMime: 'text/html' }), false,
    'the shell accepts only the exact Markdown hint')
  assert.equal(send(files, { type: 'tradeloom:file-selection', kind: 'artifact', id: 'catalog-version-2', previewMime: 'text/markdown', url: 'https://outside.test' }), false,
    'selection messages never carry a URL, even alongside the Markdown hint')
  takeSent()
  assert.equal(send(files, { type: 'tradeloom:file-selection', kind: 'source', id: 'source-17' }), true)
  assert.deepEqual(takeSent(), [{ panelId: 'preview', data: { type: 'tradeloom:file-selection', kind: 'source', id: 'source-17' }, origin: 'http://shell.test' }])
  assert.equal(send(preview, { type: 'tradeloom:preview-ready' }), true)
  assert.deepEqual(takeSent(), [{ panelId: 'preview', data: { type: 'tradeloom:file-selection', kind: 'source', id: 'source-17' }, origin: 'http://shell.test' }],
    'preview readiness replays only the last stable id selection')
  assert.equal(send(files, { type: 'tradeloom:files-ready' }), true)
  assert.deepEqual(takeSent(), [{ panelId: 'files', data: { type: 'tradeloom:file-selection', kind: 'source', id: 'source-17' }, origin: 'http://shell.test' }])
  assert.equal(send(preview, { type: 'tradeloom:file-request-selection' }), true)
  assert.deepEqual(takeSent(), [{ panelId: 'preview', data: { type: 'tradeloom:file-selection', kind: 'source', id: 'source-17' }, origin: 'http://shell.test' }])
  assert.equal(send(files, { type: 'tradeloom:file-selection', kind: 'artifact', id: 'version-9', url: 'https://outside.test/file' }), false)
  assert.equal(send(deliverables, { type: 'tradeloom:file-selection', kind: 'source', id: 'source-18' }), false,
    'the delivery browser cannot publish a source selection')
  assert.equal(send(deliverables, { type: 'tradeloom:file-selection', kind: 'artifact', id: 'version-9' }), true,
    'the complete delivery browser can publish an artifact id to the preview pane')
  assert.deepEqual(takeSent(), [
    { panelId: 'files', data: { type: 'tradeloom:file-selection', kind: 'artifact', id: 'version-9' }, origin: 'http://shell.test' },
    { panelId: 'preview', data: { type: 'tradeloom:file-selection', kind: 'artifact', id: 'version-9' }, origin: 'http://shell.test' },
  ])
  assert.equal(handler.requestFileFocus('artifact', 'version-8', () => {}), false,
    'the locate action can only target the current scene selection')
  let focusResult
  assert.equal(handler.requestFileFocus('artifact', 'version-9', result => { focusResult = result }), true)
  const focusRequest = sent.at(-1)
  assert.equal(focusRequest.panelId, 'files')
  assert.deepEqual(Object.keys(focusRequest.data).sort(), ['id', 'kind', 'nonce', 'type'])
  assert.equal(focusRequest.data.type, 'tradeloom:file-focus')
  assert.equal(handler({ source: preview.contentWindow, origin: 'http://shell.test', data: {
    type: 'tradeloom:file-focus-result', kind: 'artifact', id: 'version-9', nonce: focusRequest.data.nonce, found: true,
  } }), false, 'a preview iframe cannot acknowledge a file-row focus request')
  assert.equal(handler({ source: files.contentWindow, origin: 'http://shell.test', data: {
    type: 'tradeloom:file-focus-result', kind: 'artifact', id: 'version-9', nonce: focusRequest.data.nonce, found: true,
  } }), true)
  assert.deepEqual(JSON.parse(JSON.stringify(focusResult)), { ok: true, found: true })
  takeSent()
  assert.equal(handler.requestFileExport('artifact', 'version-9', () => {}), true,
    'a verified locate result registers the reopened files frame as the source for the next export')
  assert.equal(sent.at(-1).panelId, 'files')
  assert.equal(sent.at(-1).data.type, 'tradeloom:file-export-request')
  takeSent()
  let staleFocusResult
  assert.equal(handler.requestFileFocus('artifact', 'version-9', result => { staleFocusResult = result }), true)
  const staleFocusRequest = sent.at(-1)
  assert.equal(send(files, { type: 'tradeloom:file-selection', kind: 'artifact', id: 'version-10' }), true)
  takeSent()
  assert.equal(handler({ source: files.contentWindow, origin: 'http://shell.test', data: {
    type: 'tradeloom:file-focus-result', kind: 'artifact', id: 'version-9',
    nonce: staleFocusRequest.data.nonce, found: true,
  } }), false, 'a focus result from an older scene selection cannot claim success')
  assert.deepEqual(JSON.parse(JSON.stringify(staleFocusResult)), { ok: false, found: false, error: '所选版本已变化，请重新定位。' })

  const lateScene = structuredClone(scene)
  lateScene.id = 'late-focus-test'
  const lateSent = []
  const lateFrame = (panelId, path) => ({
    dataset: { tradeloomPanelId: panelId },
    src: `http://shell.test/business${path}`,
    contentWindow: { postMessage(data, origin) { lateSent.push({ panelId, data, origin }) } },
  })
  const lateFiles = lateFrame('files', '/artifacts#files')
  const lateLoadListeners = []
  lateFiles.addEventListener = (type, callback) => { if (type === 'load') lateLoadListeners.push(callback) }
  const latePreview = lateFrame('preview', '/artifacts#preview')
  const lateDeliverables = lateFrame('business-main', '/artifacts#deliverables')
  const lateFrames = [lateFiles, latePreview, lateDeliverables]
  const lateHandler = exports.createFileSelectionMessageHandler(lateScene, () => lateFrames, 'http://shell.test')
  const lateSend = (from, data) => lateHandler({ source: from.contentWindow, origin: 'http://shell.test', data })
  assert.equal(lateSend(lateDeliverables, { type: 'tradeloom:file-selection', kind: 'artifact', id: 'late-version' }), true)
  lateSent.length = 0
  assert.equal(lateSend(lateFiles, { type: 'tradeloom:files-ready' }), true)
  lateSent.length = 0
  for (const listener of lateLoadListeners) listener({ type: 'load' })
  let lateFocusCalls = 0
  let lateFocusValue
  assert.equal(lateHandler.requestFileFocus('artifact', 'late-version', result => { lateFocusCalls += 1; lateFocusValue = result }), true)
  const firstLateFocus = lateSent.find(item => item.data.type === 'tradeloom:file-focus')
  assert.ok(firstLateFocus, 'a previously ready iframe receives focus after its load event')
  assert.deepEqual(Object.keys(firstLateFocus.data).sort(), ['id', 'kind', 'nonce', 'type'])
  const lateResult = { type: 'tradeloom:file-focus-result', kind: 'artifact', id: 'late-version', nonce: firstLateFocus.data.nonce, found: true }
  assert.equal(lateHandler({ source: lateFiles.contentWindow, origin: 'http://shell.test', data: lateResult }), true)
  assert.equal(lateHandler({ source: lateFiles.contentWindow, origin: 'http://shell.test', data: lateResult }), false)
  assert.equal(lateFocusCalls, 1, 'duplicate results cannot invoke the locate callback more than once')
  assert.deepEqual(JSON.parse(JSON.stringify(lateFocusValue)), { ok: true, found: true })

  const pendingScene = structuredClone(scene)
  pendingScene.id = 'late-focus-pending-test'
  const pendingSent = []
  const pendingFrame = (panelId, path) => ({
    dataset: { tradeloomPanelId: panelId },
    src: `http://shell.test/business${path}`,
    contentWindow: { postMessage(data, origin) { pendingSent.push({ panelId, data, origin }) } },
  })
  const pendingFiles = pendingFrame('files', '/artifacts#files')
  const pendingPreview = pendingFrame('preview', '/artifacts#preview')
  const pendingDeliverables = pendingFrame('business-main', '/artifacts#deliverables')
  const pendingHandler = exports.createFileSelectionMessageHandler(pendingScene,
    () => [pendingFiles, pendingPreview, pendingDeliverables], 'http://shell.test')
  const pendingSend = (from, data) => pendingHandler({ source: from.contentWindow, origin: 'http://shell.test', data })
  assert.equal(pendingSend(pendingDeliverables, { type: 'tradeloom:file-selection', kind: 'artifact', id: 'pending-version' }), true)
  pendingSent.length = 0
  let pendingCalls = 0
  let pendingValue
  assert.equal(pendingHandler.requestFileFocus('artifact', 'pending-version', result => { pendingCalls += 1; pendingValue = result }), true)
  const firstPendingFocus = pendingSent.find(item => item.data.type === 'tradeloom:file-focus')
  assert.ok(firstPendingFocus, 'an existing frame receives focus while its message listener is initializing')
  pendingSent.length = 0
  assert.equal(pendingSend(pendingFiles, { type: 'tradeloom:files-ready' }), true)
  const replayedFocus = pendingSent.find(item => item.data.type === 'tradeloom:file-focus')
  assert.equal(replayedFocus?.data.nonce, firstPendingFocus.data.nonce,
    'late files-ready retries the still-pending request with its original nonce')
  const pendingResult = { type: 'tradeloom:file-focus-result', kind: 'artifact', id: 'pending-version', nonce: firstPendingFocus.data.nonce, found: true }
  assert.equal(pendingHandler({ source: pendingFiles.contentWindow, origin: 'http://shell.test', data: pendingResult }), true)
  assert.equal(pendingHandler({ source: pendingFiles.contentWindow, origin: 'http://shell.test', data: pendingResult }), false)
  assert.equal(pendingCalls, 1, 'the delayed-ready response invokes the locate callback exactly once')
  assert.deepEqual(JSON.parse(JSON.stringify(pendingValue)), { ok: true, found: true })

  const reopenedScene = structuredClone(scene)
  reopenedScene.id = 'close-reopen-focus-export'
  const reopenedSent = []
  const makeReopenedFrame = (panelId, path) => ({
    dataset: { tradeloomPanelId: panelId }, src: `http://shell.test/business${path}`,
    contentWindow: { postMessage(data, targetOrigin) { reopenedSent.push({ panelId, data, targetOrigin }) } },
  })
  const reopenedPreview = makeReopenedFrame('preview', '/artifacts#preview')
  const reopenedDeliverables = makeReopenedFrame('business-main', '/artifacts#deliverables')
  let reopenedFiles = null
  const reopenedHandler = exports.createFileSelectionMessageHandler(reopenedScene,
    () => [reopenedPreview, reopenedDeliverables, ...(reopenedFiles ? [reopenedFiles] : [])], 'http://shell.test')
  const reopenedSend = (from, data) => reopenedHandler({ source: from.contentWindow, origin: 'http://shell.test', data })
  assert.equal(reopenedSend(reopenedDeliverables, { type: 'tradeloom:file-selection', kind: 'artifact', id: 'reopened-version' }), true)
  reopenedSent.length = 0
  // The old files pane was closed; opening it creates a new authenticated frame.
  reopenedFiles = makeReopenedFrame('files', '/artifacts#files')
  let reopenedFocusCalls = 0
  assert.equal(reopenedHandler.requestFileFocus('artifact', 'reopened-version', result => {
    reopenedFocusCalls++
    assert.deepEqual(JSON.parse(JSON.stringify(result)), { ok: true, found: true })
  }), true)
  const firstReopenedFocus = reopenedSent.find(item => item.data.type === 'tradeloom:file-focus')
  assert.ok(firstReopenedFocus, 'locate sends to the newly opened exact files frame')
  // The first focus can arrive before the new iframe installs its listener.
  reopenedSent.length = 0
  assert.equal(reopenedSend(reopenedFiles, { type: 'tradeloom:files-ready' }), true)
  const replayedReopenedFocus = reopenedSent.find(item => item.data.type === 'tradeloom:file-focus')
  assert.equal(replayedReopenedFocus?.data.nonce, firstReopenedFocus.data.nonce,
    'the files-ready handshake retries the same pending focus request after remount')
  assert.equal(reopenedSend(reopenedFiles, {
    type: 'tradeloom:file-focus-result', kind: 'artifact', id: 'reopened-version',
    nonce: firstReopenedFocus.data.nonce, found: true,
  }), true)
  assert.equal(reopenedFocusCalls, 1, 'the matching remounted frame completes the pending locate once')
  reopenedSent.length = 0
  assert.equal(reopenedHandler.requestFileExport('artifact', 'reopened-version', () => {}), true,
    'after locate, reload uses only the newly verified files frame')
  assert.equal(reopenedSent.length, 1)
  assert.equal(reopenedSent[0].panelId, 'files')
  assert.equal(reopenedSent[0].data.type, 'tradeloom:file-export-request')

  assert.equal(send(files, { type: 'tradeloom:file-selection', kind: 'source', id: 'x'.repeat(129) }), false)
  assert.equal(send(files, { type: 'tradeloom:file-selection', kind: 'source', id: 'source-18' }, 'https://outside.test'), false)
  assert.equal(handler({ source: {}, origin: 'http://shell.test', data: { type: 'tradeloom:file-selection', kind: 'source', id: 'source-18' } }), false)
  assert.deepEqual(sent, [], 'invalid payloads, origins, and frame sources do not relay')

  const desktopSent = []
  const desktopFiles = frame('files', '/artifacts#files')
  desktopFiles.src = 'dsh-app://app/business/artifacts#files'
  desktopFiles.contentWindow.postMessage = (data, origin) => desktopSent.push({ data, origin })
  const desktopPreview = frame('preview', '/artifacts#preview')
  desktopPreview.src = 'dsh-app://app/business/artifacts#preview'
  desktopPreview.contentWindow.postMessage = (data, origin) => desktopSent.push({ data, origin })
  const desktopHandler = exports.createFileSelectionMessageHandler(scene, () => [desktopFiles, desktopPreview], 'dsh-app://app')
  assert.equal(desktopHandler({ source: desktopFiles.contentWindow, origin: 'dsh-app://app',
    data: { type: 'tradeloom:file-selection', kind: 'source', id: 'desktop-source-4' } }), true)
  assert.deepEqual(JSON.parse(JSON.stringify(desktopSent)), [{
    data: { type: 'tradeloom:file-selection', kind: 'source', id: 'desktop-source-4' }, origin: 'dsh-app://app',
  }], 'standard dsh-app://app origin is retained exactly for the desktop postMessage target')
  assert.equal(desktopHandler({ source: desktopFiles.contentWindow, origin: 'null',
    data: { type: 'tradeloom:file-selection', kind: 'source', id: 'spoofed' } }), false,
  'opaque null is rejected even when an iframe source matches')

  const taskScene = structuredClone(config.scenes.find(item => item.id === 'agent-center'))
  const taskFramesSent = []
  const taskFiles = frame('files', '/artifacts#files')
  const taskPreview = frame('preview', '/artifacts#preview')
  const taskMain = frame('business-main', '/workflow-tasks/55')
  taskMain.src = 'http://shell.test/business/workflow-tasks/55'
  for (const item of [taskFiles, taskPreview, taskMain]) item.contentWindow.postMessage = (data, origin) => taskFramesSent.push({
    panelId: item.dataset.tradeloomPanelId, data, origin,
  })
  const taskBridge = exports.createFileSelectionMessageHandler(taskScene, () => [taskFiles, taskPreview, taskMain],
    'http://shell.test', () => '/workflow-tasks/55')
  assert.equal(taskBridge({ source: taskMain.contentWindow, origin: 'http://shell.test',
    data: { type: 'tradeloom:file-selection', kind: 'source', id: 'source-4' } }), false,
  'workflow details may publish artifacts only')
  assert.equal(taskBridge({ source: taskMain.contentWindow, origin: 'http://shell.test',
    data: { type: 'tradeloom:file-selection', kind: 'artifact', id: 'artifact-9' } }), true)
  assert.deepEqual(JSON.parse(JSON.stringify(taskFramesSent.map(item => [item.panelId, item.data]))), [
    ['files', { type: 'tradeloom:file-selection', kind: 'artifact', id: 'artifact-9' }],
    ['preview', { type: 'tradeloom:file-selection', kind: 'artifact', id: 'artifact-9' }],
  ], 'a workflow Artifact id reaches only the same-scene files and preview panes')

  assert.equal(taskBridge({ source: taskFiles.contentWindow, origin: 'http://shell.test',
    data: { type: 'tradeloom:file-selection', kind: 'artifact', id: 'artifact-9' } }), true,
  'the row initiating a drag publishes its own id so export stays on that exact pane')
  taskFramesSent.length = 0
  let imported
  assert.equal(taskBridge.requestFileExport('artifact', 'artifact-9', result => { imported = result }), true)
  const exportRequest = taskFramesSent.at(-1)
  assert.equal(exportRequest.panelId, 'files', 'artifact export prefers the same-scene files pane')
  assert.deepEqual(Object.keys(exportRequest.data).sort(), ['id', 'kind', 'nonce', 'type'])
  assert.equal(exportRequest.data.type, 'tradeloom:file-export-request')
  assert.equal(taskBridge({ source: taskMain.contentWindow, origin: 'http://shell.test', data: {
    type: 'tradeloom:file-export-response', kind: 'artifact', id: 'artifact-9', nonce: exportRequest.data.nonce,
    name: 'forged.csv', mimeType: 'text/csv', lastModified: 1, blob: new Blob(['x']),
  } }), false, 'a different authorized frame cannot answer a pending export')
  assert.equal(taskBridge({ source: taskFiles.contentWindow, origin: 'http://shell.test', data: {
    type: 'tradeloom:file-export-response', kind: 'artifact', id: 'artifact-9', nonce: exportRequest.data.nonce,
    name: 'quote.csv', mimeType: 'text/csv', lastModified: 123, blob: new Blob(['actual bytes'], { type: 'text/csv' }),
  } }), true)
  assert.equal(imported.ok, true)
  assert.equal(imported.file.name, 'quote.csv')
  assert.equal(imported.file.type, 'text/csv')
  assert.equal(imported.blobMimeType, 'text/csv', 'the native preview can verify the exported Blob response MIME independently of its File label')
  assert.equal(await imported.file.text(), 'actual bytes')
  assert.equal(taskBridge({ source: taskFiles.contentWindow, origin: 'http://shell.test',
    data: { type: 'tradeloom:file-selection', kind: 'source', id: 'source-4' } }), true)
  assert.equal(taskBridge.requestFileExport('source', 'source-4', () => {}), true)
  const sourceRequest = taskFramesSent.at(-1)
  assert.equal(taskBridge({ source: taskFiles.contentWindow, origin: 'http://shell.test', data: {
    type: 'tradeloom:file-export-response', kind: 'source', id: 'source-4', nonce: sourceRequest.data.nonce,
    error: '下载失败',
  } }), true)
  taskBridge.dispose()

  const otherScene = structuredClone(config.scenes.find(item => item.id === 'products'))
  const otherFiles = frame('files', '/artifacts#files')
  const otherPreview = frame('preview', '/artifacts#preview')
  const otherBridge = exports.createFileSelectionMessageHandler(otherScene, () => [otherFiles, otherPreview], 'http://shell.test')
  assert.equal(otherBridge({ source: otherFiles.contentWindow, origin: 'http://shell.test',
    data: { type: 'tradeloom:file-selection', kind: 'artifact', id: 'artifact-9' } }), true)
  sent.length = 0
  let otherImport
  assert.equal(otherBridge.requestFileExport('artifact', 'artifact-9', result => { otherImport = result }), true)
  const otherRequest = sent.at(-1)?.data
  assert.equal(taskBridge({ source: otherFiles.contentWindow, origin: 'http://shell.test', data: {
    type: 'tradeloom:file-export-response', kind: 'artifact', id: 'artifact-9', nonce: otherRequest?.nonce,
    error: 'invalid scene reply',
  } }), false, 'an export request in another scene cannot complete this scene’s pending import')
  assert.equal(otherImport, undefined)
  otherBridge.dispose()
})

test('catalog Markdown preview defaults to the native reader, guards stale exports, and keeps generated images bounded', async () => {
  const source = await readFile(sceneChunkUrl, 'utf8')
  let registration
  let copiedVersionId = ''
  let openedFilesPane = 0
  const focusRequests = []
  runInNewContext(source, { URL, File, Blob,
    navigator: { clipboard: { async writeText(value) { copiedVersionId = value } } },
    window: { __ModuleLoader__: { load(value) { registration = value } } } })
  const hookValues = []
  let hookIndex = 0
  const refValues = []
  let refIndex = 0
  let effects = []
  function MarkdownText() {}
  const React = {
    createElement(type, props, ...children) { return { type, props: props ?? {}, children } },
    useState(initial) {
      const index = hookIndex++
      if (!(index in hookValues)) hookValues[index] = initial
      return [hookValues[index], value => { hookValues[index] = typeof value === 'function' ? value(hookValues[index]) : value }]
    },
    useRef(initial) {
      const index = refIndex++
      if (!(index in refValues)) refValues[index] = { current: initial }
      return refValues[index]
    },
    useEffect(callback) { effects.push(callback) },
    useLayoutEffect(callback) { callback() },
  }
  const exports = registration.factory(name => {
    if (name === 'react') return React
    if (name === '@deepseek-ai/dsh-client-ui-primitives') return { MarkdownText }
    throw new Error(`unexpected dependency: ${name}`)
  })
  const callbacks = []
  const requestFileExport = (kind, id, callback) => { callbacks.push({ kind, id, callback }); return true }
  const render = selection => {
    hookIndex = 0
    refIndex = 0
    effects = []
    const tree = exports.ArtifactMarkdownPreview({ sceneId: 'center', selection, requestFileExport,
      requestFileFocus(kind, id, callback) { focusRequests.push({ kind, id, callback }); return true },
      openFilesPanel() { openedFilesPane += 1; return true }, closePanel() {} })
    return { tree, effects: [...effects] }
  }
  const find = (node, predicate) => {
    if (!node || typeof node !== 'object') return null
    if (predicate(node)) return node
    for (const child of node.children ?? []) {
      const found = find(child, predicate)
      if (found) return found
    }
    return null
  }

  let selection = { kind: 'artifact', id: 'version-old', previewMime: 'text/markdown' }
  let rendered = render(selection)
  const staleCleanup = rendered.effects[0]()
  assert.deepEqual(callbacks.map(({ kind, id }) => ({ kind, id })), [{ kind: 'artifact', id: 'version-old' }])
  staleCleanup?.()
  selection = { kind: 'artifact', id: 'version-current', previewMime: 'text/markdown' }
  rendered = render(selection)
  const cleanupCurrent = rendered.effects[0]()
  const oldFile = new File(['# stale version'], 'catalog.md', { type: 'text/markdown', lastModified: 100 })
  await callbacks[0].callback({ ok: true, file: oldFile, blobMimeType: oldFile.type })
  assert.equal(hookValues[2].status, 'loading', 'a response from the previous selection cannot replace the current document')
  const currentFile = new File(['# Current catalog\n\n| SKU |\n| --- |\n| A-1 |'], 'catalog.md', { type: 'text/markdown', lastModified: 200 })
  await callbacks[1].callback({ ok: true, file: currentFile, blobMimeType: currentFile.type })
  rendered = render(selection)
  assert.ok(find(rendered.tree, node => node.type === MarkdownText), 'a supported Markdown artifact opens in the native reader by default')
  find(rendered.tree, node => node.type === 'button' && node.children[0] === '源码').props.onClick()
  rendered = render(selection)
  const sourceView = find(rendered.tree, node => node.type === 'pre' && node.props['aria-label'] === 'Markdown源码')
  assert.ok(sourceView, 'the explicit source view remains a read-only preformatted element')
  assert.equal(sourceView.props.contentEditable, undefined)
  assert.equal(sourceView.children[0].children[0], '# Current catalog\n\n| SKU |\n| --- |\n| A-1 |')
  assert.ok(find(rendered.tree, node => node.type === 'code' && node.children[0] === 'version-current'),
    'the footer identifies the selected ArtifactVersion by its real id')
  const copyIdButton = find(rendered.tree, node => node.type === 'button' && node.children[0] === '复制版本ID')
  await copyIdButton.props.onClick()
  assert.equal(copiedVersionId, 'version-current', 'the copy action writes the real ArtifactVersion id rather than a local path')
  assert.match(source, /\.tl-markdown-preview-footer > \* \{ min-width:0; max-width:100%; \}/)
  assert.match(source, /\.tl-dock-panel-body:has\(> \.tl-markdown-preview\)\s*\{\s*display:flex; flex-direction:column; min-height:0; overflow:hidden; padding:0;/,
    'the production Dockview panel body constrains the Markdown reader so its own content region scrolls')
  assert.match(source, /\.tl-markdown-preview\s*\{[^}]*flex:1 1 0; width:100%; height:100%; min-width:0; min-height:0;/,
    'the Markdown section fills the constrained panel body rather than sizing to document content')
  assert.match(source, /\.tl-markdown-preview-version-id,\.tl-markdown-preview-version-id code \{ overflow-wrap:anywhere; \}/,
    'a long opaque version id wraps inside narrow preview panes instead of widening the dock')
  const locateButton = find(rendered.tree, node => node.type === 'button' && node.children[0] === '定位')
  locateButton.props.onClick()
  assert.equal(openedFilesPane, 1, 'locating opens or focuses the existing files panel first')
  assert.deepEqual(focusRequests.map(({ kind, id }) => ({ kind, id })), [{ kind: 'artifact', id: 'version-current' }],
    'the locate control sends only the registered artifact kind and exact version id')
  focusRequests[0].callback({ ok: true, found: true })
  assert.equal(hookValues[4], '已定位到文件行。', 'the locate result is visible in the preview action status')
  const readerButton = find(rendered.tree, node => node.type === 'button' && node.children[0] === '阅读')
  readerButton.props.onClick()
  rendered = render(selection)
  const reader = find(rendered.tree, node => node.type === MarkdownText)
  assert.ok(reader, 'the explicit reader mode reuses the native MarkdownText component')
  assert.equal(reader.props.variant, 'body')
  assert.equal(reader.props.text, '# Current catalog\n\n| SKU |\n| --- |\n| A-1 |')
  assert.equal(reader.props.pathImages.resolve('data:image/png;base64,AAAA'), 'data:image/png;base64,AAAA')
  assert.equal(reader.props.pathImages.resolve('data:image/svg+xml;base64,PHN2Zy8+'), 'data:image/svg+xml;base64,PHN2Zy8+',
    'the validated catalog SVG data URI is passed through to the native image renderer')
  assert.equal(reader.props.pathImages.resolve('data:image/svg+xml;base64,PHN2Zz'), undefined,
    'malformed SVG base64 is rejected')
  assert.equal(reader.props.pathImages.resolve('data:text/html;base64,PGgxPk5vPC9oMT4='), undefined,
    'non-image data URIs remain blocked')
  assert.equal(reader.props.pathImages.resolve('javascript:alert(1)'), undefined)
  cleanupCurrent?.()

  selection = { kind: 'artifact', id: 'version-mime-mismatch', previewMime: 'text/markdown' }
  rendered = render(selection)
  const cleanupMismatch = rendered.effects[0]()
  const forgedFileLabel = new File(['not markdown'], 'catalog.md', { type: 'text/markdown', lastModified: 300 })
  await callbacks.at(-1).callback({ ok: true, file: forgedFileLabel, blobMimeType: 'text/html' })
  rendered = render(selection)
  assert.equal(hookValues[2].status, 'error', 'a File label cannot override a mismatching exported Blob MIME')
  assert.match(JSON.stringify(rendered.tree), /当前版本不是受支持的 Markdown 文件/)
  cleanupMismatch?.()

  let missingHookIndex = 0
  let missingRefIndex = 0
  const missingHookValues = ['reader', 0, { status: 'ready', file: currentFile, text: '# Current catalog', error: '' }, '']
  const missingRefValues = []
  const MissingReaderReact = {
    ...React,
    useState(initial) {
      const index = missingHookIndex++
      if (!(index in missingHookValues)) missingHookValues[index] = initial
      return [missingHookValues[index], value => { missingHookValues[index] = typeof value === 'function' ? value(missingHookValues[index]) : value }]
    },
    useRef(initial) {
      const index = missingRefIndex++
      if (!(index in missingRefValues)) missingRefValues[index] = { current: initial }
      return missingRefValues[index]
    },
    useLayoutEffect(callback) { callback() },
    useEffect() {},
  }
  const missingReaderExports = registration.factory(name => {
    if (name === 'react') return MissingReaderReact
    throw new Error('native Markdown module unavailable')
  })
  missingRefIndex = 0
  const missingReaderTree = missingReaderExports.ArtifactMarkdownPreview({ sceneId: 'center', selection, requestFileExport, closePanel() {} })
  assert.match(JSON.stringify(missingReaderTree), /原生 Markdown 阅读器不可用/,
    'the optional native renderer failure is readable and does not pretend the content was rendered')
})

test('Dockview layout persistence allows chat overlay and restores its original layout', async () => {
  const scene = { panels: [
    { id: 'business-main', type: 'business-iframe', title: '商品' },
    { id: 'native-chat', type: 'native-chat', title: '商品助手' },
  ] }
  const layout = {
    grid: { root: { type: 'branch', size: 100, data: [
      { type: 'leaf', size: 100, data: { id: 'business', views: ['business-main'], activeView: 'business-main' } },
    ] }, width: 960, height: 640, orientation: 'HORIZONTAL' },
    panels: {
      'business-main': { id: 'business-main', contentComponent: 'business-iframe', title: '商品', renderer: 'always', params: { panelId: 'business-main' } },
      'native-chat': { id: 'native-chat', contentComponent: 'native-chat', title: '商品助手', renderer: 'always', params: { panelId: 'native-chat' } },
    },
    activeGroup: 'business',
    floatingGroups: [{ data: { id: 'chat-float', views: ['native-chat'], activeView: 'native-chat' },
      position: { top: 8, right: 8, width: 500, height: 600 } }],
  }
  assert.equal(validateDockviewLayout(scene, layout), true)
  const floatingPreview = structuredClone(layout)
  floatingPreview.grid.root.data[0].data.views = ['native-chat']
  floatingPreview.grid.root.data[0].data.activeView = 'native-chat'
  floatingPreview.floatingGroups[0].data.views = ['business-main']
  floatingPreview.floatingGroups[0].data.activeView = 'business-main'
  assert.equal(validateDockviewLayout(scene, floatingPreview), true, 'an existing business iframe can float while the native chat remains docked')
  const invalid = structuredClone(layout)
  invalid.floatingGroups[0].data.views = ['unregistered-panel']
  assert.throws(() => validateDockviewLayout(scene, invalid), /only a business panel, native chat or native workspace may be floated/)

  const config = JSON.parse(await readFile(sceneConfigUrl, 'utf8'))
  const center = config.scenes.find(item => item.id === 'center')
  const restoreDockview = defaultDockLayout(center).dockview
  const floatingDockview = structuredClone(restoreDockview)
  const removeChat = node => {
    if (node.type === 'leaf') return node.data.views.includes('native-chat') ? null : node
    const data = node.data.map(removeChat).filter(Boolean)
    return data.length === 1 ? data[0] : { ...node, data }
  }
  floatingDockview.grid.root = removeChat(floatingDockview.grid.root)
  floatingDockview.floatingGroups = [{ data: { id: 'chat-float', views: ['native-chat'], activeView: 'native-chat' },
    position: { top: 8, right: 8, width: 600, height: 700 } }]
  const accepted = validateDockLayouts(config, { version: 2, scenes: { center: { version: 2, dockview: floatingDockview,
    closedPanelIds: center.panels.filter(panel => panel.optional === true).map(panel => panel.id),
    floatingRestore: { dockview: restoreDockview, closedPanelIds: center.panels.filter(panel => panel.optional === true).map(panel => panel.id) } } } })
  assert.deepEqual(accepted.scenes.center.floatingRestore.dockview, restoreDockview,
    'the original group tree remains available to restore the chat to its pre-float position')
})

test('native chat panel uses the pinned conversation factory', async () => {
  let registration
  runInNewContext(await readFile(sceneChunkUrl, 'utf8'), {
    Blob, File, setTimeout, clearTimeout,
    window: {
      __ModuleLoader__: { load(value) { registration = value } },
      location: { origin: 'http://127.0.0.1:3088' },
      addEventListener() {}, removeEventListener() {},
    },
  })
  const stateUpdates = []
  let nextExportResult
  const React = { Fragment: 'Fragment', createElement: (type, props, ...children) => ({ type, props, children }),
    useState: initial => [initial, value => stateUpdates.push(value)], useRef: current => ({ current }), useLayoutEffect() {} }
  const exports = registration.factory(() => React)
  let factoryCall
  const node = exports.SceneChatPanel({
    sessionId: 'session-center',
    onAddFiles(files) { assert.equal(files[0].name, 'source.xlsx'); return true },
    requestFileExport(kind, id, onResult) {
      assert.deepEqual([kind, id], ['source', 'source-17'])
      onResult(nextExportResult ?? { ok: true, file: new File(['bytes'], 'source.xlsx', { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }) })
      return true
    },
    nativeHeaderFactoryAvailable: true,
    renderSlot() { throw new Error('ordinary native header belongs to its original owner') },
    renderFactorySlot(...args) {
      if (args[0] === 'conversation.header.frame') return { nativeHeader: true }
      factoryCall = args; return { conversation: true }
    },
  })
  assert.equal(node.type, 'div')
  assert.equal(node.props.className, 'tl-native-conversation')
  assert.deepEqual(node.children[0], { nativeHeader: true }, 'an available native header factory retains actions and view navigation without redeclaring its slots')
  assert.deepEqual(node.children[1], { conversation: true })
  const drop = { dataTransfer: { types: ['application/x-tradeloom-file'], getData: () => JSON.stringify({ kind: 'source', id: 'source-17' }) }, preventDefault() {} }
  node.props.onDrop(drop)
  assert.deepEqual(JSON.parse(JSON.stringify(stateUpdates.at(-1))), { ok: true, text: '已将“source.xlsx”加入附件草稿；尚未发送。' },
    'a file drop adds a genuine File to this Session draft and leaves submission to the user')
  nextExportResult = { ok: false, error: '文件下载失败，未添加附件。' }
  node.props.onDrop(drop)
  assert.deepEqual(JSON.parse(JSON.stringify(stateUpdates.at(-1))), { ok: false, text: '文件下载失败，未添加附件。' },
    'a verified business download failure is visible and does not create a draft attachment')
  assert.equal(factoryCall[0], 'conversation.content')
  assert.deepEqual(JSON.parse(JSON.stringify(factoryCall[1])), { variant: 'embedded', phase: 'active', hero: false })
  assert.equal(factoryCall[2], undefined, 'the native session selects its active view; embedding must not force chat and discard tabs')

})

test('native chat unbound state uses the shared pane state without offering a create-session action', async () => {
  let registration
  const React = {
    Fragment: 'Fragment',
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
    useState: initial => [typeof initial === 'function' ? initial() : initial, () => {}],
    useRef: initial => ({ current: initial }),
    useLayoutEffect(effect) { effect() },
    useEffect: () => {},
  }
  runInNewContext(await readFile(sceneChunkUrl, 'utf8'), {
    React,
    URL,
    Blob, File, setTimeout, clearTimeout,
    window: { __ModuleLoader__: { load(value) { registration = value } }, location: { origin: 'http://127.0.0.1:3088' }, addEventListener() {}, removeEventListener() {} },
  })
  const exports = registration.factory(() => React)
  const tree = exports.NativeChatPanel({ sceneId: 'products', roleId: 'product', SessionProvider() {}, renderSlot() {} })
  assert.equal(tree.type, exports.PaneState)
  assert.equal(tree.props.title, '尚无已连接会话')
  assert.equal(tree.props.description, '该助手尚无已连接会话。')
  assert.equal(tree.props.action, undefined, 'an unbound role does not imply permission to create a session')
  const rendered = tree.type(tree.props)
  assert.equal(rendered.props.className, 'tl-pane-state')
  assert.equal(rendered.props.role, 'status')
  assert.equal(rendered.children[0].props.className, 'tl-pane-state-symbol')
  assert.equal(rendered.children[0].children[0].props.className, 'tl-pane-state-icon')
})

test('PaneState action and scaled visual contract stay explicit', async () => {
  let registration
  const React = { createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }) }
  runInNewContext(await readFile(sceneChunkUrl, 'utf8'), {
    React, Blob, File, setTimeout, clearTimeout,
    window: { __ModuleLoader__: { load(value) { registration = value } }, location: { origin: 'http://127.0.0.1:3088' }, addEventListener() {}, removeEventListener() {} },
  })
  const exports = registration.factory(() => React)
  let invoked = 0
  const node = exports.PaneState({ title: 'ERPNext 尚未配置', description: '请由管理员配置 ERPNext 连接后再使用只读数据。',
    action: { label: '检查连接', onClick() { invoked += 1 } }, icon: 'erpnext' })
  assert.equal(node.props.className, 'tl-pane-state')
  assert.equal(node.props.role, 'status')
  const button = node.children.find(child => child?.type === 'button')
  assert.equal(button.children[0], '检查连接')
  button.props.onClick()
  assert.equal(invoked, 1)
  const busyNode = exports.PaneState({ title: '正在连接助手…', description: '正在连接已绑定的原生会话。', busy: true,
    action: { label: '重试连接', onClick() { invoked += 1 } } })
  assert.equal(busyNode.props['aria-busy'], 'true')
  assert.ok(busyNode.children[0].children.some(child => child?.props?.className === 'tl-pane-state-spinner'),
    'a live busy state includes a visible spinner glyph')
  assert.equal(busyNode.children.find(child => child?.type === 'button').props.disabled, true)
  const idleNode = exports.PaneState({ title: '尚无已连接会话', description: '该助手尚无已连接会话。' })
  assert.equal(idleNode.children[0].children.some(child => child?.props?.className === 'tl-pane-state-spinner'), false,
    'an unbound idle state does not imply loading')
  for (const fontBody of [10, 14, 16, 22]) {
    const styles = exports.workbenchUiStyles({ fontBody, controlHeight: 32, iconSize: 16, cornerRadius: 8 })
    assert.equal(styles['--tl-ui-scale'], String(fontBody / 14))
  }
  const source = await readFile(sceneChunkUrl, 'utf8')
  assert.match(source, /\.tl-pane-state \{[^}]*var\(--tl-ui-scale/)
  assert.match(source, /\.tl-pane-state-action \{[^}]*var\(--tl-control-height\)/)
  assert.match(source, /\.tl-pane-state-description \{[^}]*overflow-wrap:anywhere/)
  assert.match(source, /@media \(prefers-reduced-motion: reduce\)[\s\S]*?\.tl-pane-state-spinner[^}]*animation:\s*none/)
})

test('ERPNext status panel reads Django status on entry and rechecks when its panel refresh key changes', async () => {
  let registration
  let state
  let dependencies
  let cleanup
  const requests = []
  let connectedStatus = true
  const React = {
    createElement(type, props, ...children) { return { type, props: props ?? {}, children } },
    useState(initial) {
      if (state === undefined) state = typeof initial === 'function' ? initial() : initial
      return [state, next => { state = typeof next === 'function' ? next(state) : next }]
    },
    useEffect(effect, nextDependencies) {
      if (!dependencies || nextDependencies.some((value, index) => value !== dependencies[index])) {
        cleanup?.()
        cleanup = effect()
        dependencies = [...nextDependencies]
      }
    },
  }
  runInNewContext(await readFile(sceneChunkUrl, 'utf8'), {
    React,
    URL,
    URLSearchParams,
    fetch: async url => {
      requests.push(url)
      return { ok: true, async json() { return {
        configured: true, connected: connectedStatus, status: connectedStatus ? 'connected' : 'unavailable', error_code: '', site_url: 'https://erp.example.test/tenant',
        apiKey: 'must-not-render', apiSecret: 'must-not-render',
      } } }
    },
    window: { __ModuleLoader__: { load(value) { registration = value } } },
  })
  const component = registration.factory(() => React).ERPNextStatus
  const flatten = node => typeof node === 'string' ? node : Array.isArray(node) ? node.map(flatten).join(' ') : node?.children?.map(flatten).join(' ') ?? ''
  const findNodes = (node, predicate, matches = []) => {
    if (Array.isArray(node)) for (const item of node) findNodes(item, predicate, matches)
    else if (node && typeof node === 'object') {
      if (predicate(node)) matches.push(node)
      findNodes(node.children, predicate, matches)
    }
    return matches
  }

  component({ refreshKey: 0 })
  await new Promise(resolve => setImmediate(resolve))
  const connectedTree = component({ refreshKey: 0 })
  const connected = flatten(connectedTree)
  assert.equal(connected.includes('ERPNext 已连接'), true)
  assert.equal(connected.includes('must-not-render'), false)
  assert.equal(findNodes(connectedTree, node => node.type?.name === 'ERPNextQuotationDraft').length, 1,
    'the bounded Quotation editor is part of the existing connected ERPNext panel')
  const links = findNodes(connectedTree, node => node.type === 'a')
  assert.deepEqual(links.map(link => [link.props.href, link.props.target, link.props.rel]), [
    ['https://erp.example.test/tenant', '_blank', 'noopener noreferrer'],
  ])
  const connectedDraft = findNodes(connectedTree, node => node.type?.name === 'ERPNextQuotationDraft')[0]
  assert.equal(connectedDraft.props.enabled, true)
  assert.deepEqual(requests, ['/business-api/erpnext/status'])

  component({ refreshKey: 1 })
  await new Promise(resolve => setImmediate(resolve))
  const afterRefresh = component({ refreshKey: 1 })
  assert.deepEqual(requests, ['/business-api/erpnext/status', '/business-api/erpnext/status'])
  connectedStatus = false
  component({ refreshKey: 2 })
  await new Promise(resolve => setImmediate(resolve))
  const unavailableTree = component({ refreshKey: 2 })
  const retainedDraft = findNodes(unavailableTree, node => node.type?.name === 'ERPNextQuotationDraft')[0]
  assert.ok(retainedDraft, 'a transient disconnect must not unmount and discard operation keys/readback IDs')
  assert.equal(retainedDraft.props.enabled, false)
  assert.equal(retainedDraft.type, connectedDraft.type)
  assert.ok(afterRefresh)
  assert.deepEqual(requests, ['/business-api/erpnext/status', '/business-api/erpnext/status', '/business-api/erpnext/status'])
})

test('ERPNext not-configured and status-error panes retain their existing check/retry actions', async () => {
  async function mountStatus(fetchStatus) {
    let registration
    let state
    let dependencies
    let cleanup
    const requests = []
    const React = {
      createElement(type, props, ...children) { return { type, props: props ?? {}, children } },
      useState(initial) {
        if (state === undefined) state = typeof initial === 'function' ? initial() : initial
        return [state, next => { state = typeof next === 'function' ? next(state) : next }]
      },
      useEffect(effect, nextDependencies) {
        if (!dependencies || nextDependencies.some((value, index) => value !== dependencies[index])) {
          cleanup?.()
          cleanup = effect()
          dependencies = [...nextDependencies]
        }
      },
    }
    runInNewContext(await readFile(sceneChunkUrl, 'utf8'), {
      React, URL, URLSearchParams,
      fetch: async url => { requests.push(url); return fetchStatus() },
      window: { __ModuleLoader__: { load(value) { registration = value } } },
    })
    return { component: registration.factory(() => React).ERPNextStatus, requests }
  }
  const findNodes = (node, predicate, matches = []) => {
    if (Array.isArray(node)) for (const item of node) findNodes(item, predicate, matches)
    else if (node && typeof node === 'object') {
      if (predicate(node)) matches.push(node)
      findNodes(node.children, predicate, matches)
    }
    return matches
  }

  const notConfigured = await mountStatus(() => ({ ok: true, async json() {
    return { configured: false, connected: false, status: 'not_configured' }
  } }))
  notConfigured.component({ refreshKey: 0 })
  await new Promise(resolve => setImmediate(resolve))
  const notConfiguredTree = notConfigured.component({ refreshKey: 0 })
  const notConfiguredPane = findNodes(notConfiguredTree, node => node.type?.name === 'PaneState')[0]
  assert.equal(notConfiguredPane.props.title, 'ERPNext 尚未配置')
  assert.equal(notConfiguredPane.props.description, '请由管理员配置 ERPNext 连接后再使用只读数据。')
  assert.equal(notConfiguredPane.props.action.label, '检查连接')
  assert.equal(findNodes(notConfiguredTree, node => node.type?.name === 'ERPNextQuotationDraft')[0].props.enabled, false)
  notConfiguredPane.props.action.onClick()
  notConfigured.component({ refreshKey: 0 })
  const checkingTree = notConfigured.component({ refreshKey: 0 })
  const checkingPane = findNodes(checkingTree, node => node.type?.name === 'PaneState')[0]
  assert.equal(checkingPane.props.busy, true)
  assert.equal(checkingPane.props.action.disabled, true)
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(notConfigured.requests.length, 2, 'the existing check action triggers only its existing status request')

  for (const status of ['invalid_configuration', 'unavailable']) {
    const failingStatus = await mountStatus(() => ({ ok: true, async json() {
      return { configured: status !== 'not_configured', connected: false, status }
    } }))
    failingStatus.component({ refreshKey: 0 })
    await new Promise(resolve => setImmediate(resolve))
    const tree = failingStatus.component({ refreshKey: 0 })
    const pane = findNodes(tree, node => node.type?.name === 'PaneState')[0]
    assert.ok(pane, `${status} is a real failure state and uses PaneState`)
    assert.equal(pane.props.tone, 'error')
    assert.equal(pane.props.action.label, '检查连接', 'existing check action remains the only action')
  }

  let errorRequests = 0
  let resolveRetry
  const statusError = await mountStatus(() => {
    errorRequests += 1
    if (errorRequests === 1) return Promise.reject(new Error('transport unavailable'))
    return new Promise(resolve => { resolveRetry = () => resolve({ ok: true, async json() {
      return { configured: true, connected: false, status: 'unavailable' }
    } }) })
  })
  statusError.component({ refreshKey: 0 })
  await new Promise(resolve => setImmediate(resolve))
  const errorTree = statusError.component({ refreshKey: 0 })
  const errorPane = findNodes(errorTree, node => node.type?.name === 'PaneState')[0]
  assert.equal(errorPane.props.title, 'ERPNext 状态暂不可用')
  assert.equal(errorPane.props.description, '暂时无法读取连接状态，请稍后重试。')
  assert.equal(errorPane.props.role, 'alert')
  assert.equal(errorPane.props.action.label, '重试')
  errorPane.props.action.onClick()
  statusError.component({ refreshKey: 0 })
  const retryingTree = statusError.component({ refreshKey: 0 })
  const retryingPane = findNodes(retryingTree, node => node.type?.name === 'PaneState')[0]
  assert.equal(retryingPane.props.busy, true)
  assert.equal(retryingPane.props.action.disabled, true)
  assert.ok(retryingPane.props.title.startsWith('正在检查'))
  resolveRetry()
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(statusError.requests.length, 2, 'the error retry reuses the same status endpoint')
})

test('Quotation editor treats 202 as unknown and only a GET readback can confirm success', async () => {
  let registration
  let state
  const calls = []
  const React = {
    createElement(type, props, ...children) { return { type, props: props ?? {}, children } },
    useState(initial) {
      if (state === undefined) state = typeof initial === 'function' ? initial() : initial
      return [state, next => { state = typeof next === 'function' ? next(state) : next }]
    },
  }
  const unknown = {
    ok: true, operation_id: 'a'.repeat(32), action: 'create', doctype: 'Quotation', status: 'outcome_unknown',
    source: 'local_workbench', workflow_id: null, target_operation_id: null, remote_name: null, remote_modified: null,
    payload_sha256: 'b'.repeat(64), error_code: 'unavailable', receipt: null, remote_current: null, remote_error_code: 'unavailable',
  }
  const succeeded = {
    ...unknown, status: 'succeeded', remote_name: 'QTN-1', remote_modified: '2026-10-21 12:30:00.000000', error_code: '', remote_error_code: '',
    receipt: { doctype: 'Quotation', data: { name: 'QTN-1', modified: '2026-10-21 12:30:00.000000', docstatus: 0,
      quotation_to: 'Customer', company: 'Demo Company', party_name: 'Customer-1', transaction_date: '2026-10-21',
      currency: 'USD', items: [{ item_code: 'ITEM-1', qty: '2', rate: '5.25', uom: 'Nos' }] },
      external_ref: { system: 'erpnext', instance_id: 'local', doctype: 'Quotation', name: 'QTN-1', modified: '2026-10-21 12:30:00.000000' }, truncated_children: [] },
    remote_current: { doctype: 'Quotation', data: { name: 'QTN-1', modified: '2026-10-21 12:30:00.000000', docstatus: 0,
      quotation_to: 'Customer', company: 'Demo Company', party_name: 'Customer-1', transaction_date: '2026-10-21',
      currency: 'USD', items: [{ item_code: 'ITEM-1', qty: '2', rate: '5.25', uom: 'Nos' }] },
      external_ref: { system: 'erpnext', instance_id: 'local', doctype: 'Quotation', name: 'QTN-1', modified: '2026-10-21 12:30:00.000000' }, truncated_children: [] },
  }
  runInNewContext(await readFile(sceneChunkUrl, 'utf8'), {
    React, URLSearchParams, document: { cookie: 'csrftoken=fixture-csrf-token;' },
    crypto: { randomUUID: () => '11111111-1111-4111-8111-111111111111' },
    fetch: async (url, options = {}) => {
      calls.push({ url, method: options.method ?? 'GET', body: options.body, headers: options.headers })
      if (url === '/business-api/') return { ok: true, status: 200 }
      if (options.method === 'POST') return { ok: true, status: 202, async json() { return unknown } }
      return { ok: true, status: 200, async json() { return succeeded } }
    },
    window: { __ModuleLoader__: { load(value) { registration = value } } },
  })
  const DraftEditor = registration.factory(() => React).ERPNextQuotationDraft
  const component = props => DraftEditor({ enabled: true, ...props })
  assert.equal(typeof DraftEditor, 'function')
  const find = (node, predicate) => {
    if (Array.isArray(node)) return node.flatMap(item => find(item, predicate))
    if (!node || typeof node !== 'object') return []
    return [...(predicate(node) ? [node] : []), ...find(node.children, predicate)]
  }
  const flatten = node => typeof node === 'string' ? node : Array.isArray(node) ? node.map(flatten).join(' ') : node?.children?.map(flatten).join(' ') ?? ''
  const fill = tree => {
    const fields = {
      '公司': 'Demo Company', '客户': 'Customer-1', '交易日期': '2026-10-21', '币种': 'USD',
      '商品编码 1': 'ITEM-1', '数量 1': '2', '单价 1': '5.25', '单位 1': 'Nos',
    }
    for (const [key, value] of Object.entries(fields)) {
      tree = component()
      const input = find(tree, node => node.type === 'input' && node.props['aria-label'] === key)[0]
      input.props.onChange({ target: { value } })
    }
    return tree
  }
  let tree = fill(component())
  tree = component()
  await find(tree, node => node.type === 'button' && node.children.includes('创建报价草稿'))[0].props.onClick()
  tree = component()
  assert.match(flatten(tree), /结果待核对/)
  assert.doesNotMatch(flatten(tree), /已确认保存草稿/)
  assert.deepEqual(calls.map(call => [call.method, call.url]), [
    ['GET', '/business-api/'], ['POST', '/business-api/erpnext/quotation-drafts'],
  ])
  const postCall = calls[1]
  const posted = JSON.parse(postCall.body)
  assert.equal(posted.idempotency_key, '11111111-1111-4111-8111-111111111111')
  assert.equal('role' in posted, false)
  assert.equal('actor' in posted, false)
  assert.equal(postCall.headers['X-CSRFToken'], 'fixture-csrf-token')
  const check = find(tree, node => node.type === 'button' && node.children.includes('读取操作状态'))[0]
  await check.props.onClick()
  tree = component()
  assert.match(flatten(tree), /已确认保存草稿/)
  assert.match(flatten(tree), /QTN-1/)
  assert.deepEqual(calls.map(call => call.method), ['GET', 'POST', 'GET'])
})

test('Quotation editor recovers a lost response by reusing the identical request key and body', async () => {
  let registration
  let state
  let nextKey = 0
  const calls = []
  const React = {
    createElement(type, props, ...children) { return { type, props: props ?? {}, children } },
    useState(initial) {
      if (state === undefined) state = typeof initial === 'function' ? initial() : initial
      return [state, next => { state = typeof next === 'function' ? next(state) : next }]
    },
  }
  const operation = {
    ok: true, operation_id: 'c'.repeat(32), action: 'create', doctype: 'Quotation', status: 'outcome_unknown',
    source: 'local_workbench', workflow_id: null, target_operation_id: null, remote_name: 'QTN-2',
    remote_modified: null, payload_sha256: 'd'.repeat(64), error_code: 'unavailable', receipt: null,
    remote_current: null, remote_error_code: 'unavailable',
  }
  runInNewContext(await readFile(sceneChunkUrl, 'utf8'), {
    React, URLSearchParams, document: { cookie: 'csrftoken=fixture-csrf-token;' },
    crypto: { randomUUID: () => `22222222-2222-4222-8222-${String(++nextKey).padStart(12, '0')}` },
    fetch: async (url, options = {}) => {
      calls.push({ url, method: options.method ?? 'GET', body: options.body })
      if (url === '/business-api/') return { ok: true, status: 200 }
      if (options.method === 'POST' && calls.filter(call => call.method === 'POST').length === 1) throw new Error('fixture network interruption')
      return { ok: true, status: 202, async json() { return operation } }
    },
    window: { __ModuleLoader__: { load(value) { registration = value } } },
  })
  const DraftEditor = registration.factory(() => React).ERPNextQuotationDraft
  const component = props => DraftEditor({ enabled: true, ...props })
  assert.equal(typeof DraftEditor, 'function')
  const find = (node, predicate) => {
    if (Array.isArray(node)) return node.flatMap(item => find(item, predicate))
    if (!node || typeof node !== 'object') return []
    return [...(predicate(node) ? [node] : []), ...find(node.children, predicate)]
  }
  let initialTree = component()
  const maxLengths = {
    '公司': 140, '客户': 140, '交易日期': 10, '有效日期': 10, '币种': 3,
    '商品编码 1': 140, '数量 1': 32, '单价 1': 32, '单位 1': 140,
  }
  for (const [label, maxLength] of Object.entries(maxLengths)) {
    assert.equal(find(initialTree, node => node.type === 'input' && node.props['aria-label'] === label)[0].props.maxLength, maxLength)
  }
  find(initialTree, node => node.type === 'input' && node.props['aria-label'] === '公司')[0]
    .props.onChange({ target: { value: 'x'.repeat(141) } })
  initialTree = component()
  await find(initialTree, node => node.type === 'button' && node.children.includes('创建报价草稿'))[0].props.onClick()
  assert.deepEqual(calls, [], 'the form rejects overlong text before requesting Django')
  assert.match(JSON.stringify(component()), /请填写有效的公司、客户、日期、币种和报价行/)
  const fillRequired = tree => {
    const fields = { '公司': 'Demo Company', '客户': 'Customer-1', '交易日期': '2026-10-21', '币种': 'USD', '商品编码 1': 'ITEM-1', '数量 1': '1', '单价 1': '3', '单位 1': 'Nos' }
    for (const [key, value] of Object.entries(fields)) {
      tree = component()
      const input = find(tree, node => node.type === 'input' && node.props['aria-label'] === key)[0]
      input.props.onChange({ target: { value } })
    }
    return tree
  }
  let tree = fillRequired(component())
  tree = component()
  await find(tree, node => node.type === 'button' && node.children.includes('创建报价草稿'))[0].props.onClick()
  tree = component()
  const firstPost = calls.find(call => call.method === 'POST')
  const firstBody = firstPost.body
  assert.match(tree.children ? JSON.stringify(tree) : '', /暂未收到操作回执/)
  await find(tree, node => node.type === 'button' && node.children.includes('用原请求键恢复回执'))[0].props.onClick()
  const posts = calls.filter(call => call.method === 'POST')
  assert.equal(posts.length, 2)
  assert.equal(posts[1].body, firstBody)
  assert.equal(JSON.parse(posts[1].body).idempotency_key, '22222222-2222-4222-8222-000000000001')
})

test('Quotation editor sends each explicit update as a new operation against the exact readback version', async () => {
  let registration
  let state
  let nextKey = 0
  const calls = []
  const React = {
    createElement(type, props, ...children) { return { type, props: props ?? {}, children } },
    useState(initial) {
      if (state === undefined) state = typeof initial === 'function' ? initial() : initial
      return [state, next => { state = typeof next === 'function' ? next(state) : next }]
    },
  }
  const record = modified => ({ doctype: 'Quotation', data: { name: 'QTN-3', modified, docstatus: 0,
    quotation_to: 'Customer', company: 'Demo Company', party_name: 'Customer-1', transaction_date: '2026-10-21',
    currency: 'USD', items: [{ item_code: 'ITEM-1', qty: '1', rate: '3', uom: 'Nos' }] },
    external_ref: { system: 'erpnext', instance_id: 'erp-demo', doctype: 'Quotation', name: 'QTN-3', modified }, truncated_children: [] })
  const created = { ok: true, operation_id: '3'.repeat(32), action: 'create', doctype: 'Quotation', status: 'succeeded',
    source: 'local_workbench', workflow_id: null, target_operation_id: null, remote_name: 'QTN-3', remote_modified: '2026-10-21 12:00:00.000000',
    payload_sha256: 'e'.repeat(64), error_code: '', receipt: record('2026-10-21 12:00:00.000000'),
    remote_current: record('2026-10-21 12:00:00.000000'), remote_error_code: '' }
  const conflict = { ...created, operation_id: '4'.repeat(32), action: 'update', status: 'conflict',
    target_operation_id: created.operation_id, remote_current: null, error_code: 'conflict' }
  const conflictRead = { ...conflict, remote_current: record('2026-10-21 12:30:00.000000') }
  const updated = { ...created, operation_id: '5'.repeat(32), action: 'update', status: 'succeeded',
    target_operation_id: created.operation_id, remote_modified: '2026-10-21 13:00:00.000000',
    receipt: record('2026-10-21 13:00:00.000000'), remote_current: record('2026-10-21 13:00:00.000000') }
  runInNewContext(await readFile(sceneChunkUrl, 'utf8'), {
    React, URLSearchParams, document: { cookie: 'csrftoken=fixture-csrf-token;' },
    crypto: { randomUUID: () => `33333333-3333-4333-8333-${String(++nextKey).padStart(12, '0')}` },
    fetch: async (url, options = {}) => {
      calls.push({ url, method: options.method ?? 'GET', body: options.body, headers: options.headers })
      if (url === '/business-api/') return { ok: true, status: 200 }
      if (options.method === 'POST') return { ok: true, status: 201, async json() { return created } }
      if (options.method === 'PUT' && calls.filter(call => call.method === 'PUT').length === 1) {
        return { ok: false, status: 409, async json() { return conflict } }
      }
      if (options.method === 'PUT') return { ok: true, status: 200, async json() { return updated } }
      if (options.method === 'GET' && url.endsWith(`/quotation-drafts/${conflict.operation_id}`)) {
        return { ok: true, status: 200, async json() { return conflictRead } }
      }
      throw new Error('unexpected request')
    },
    window: { __ModuleLoader__: { load(value) { registration = value } } },
  })
  const DraftEditor = registration.factory(() => React).ERPNextQuotationDraft
  const component = props => DraftEditor({ enabled: true, ...props })
  const find = (node, predicate) => {
    if (Array.isArray(node)) return node.flatMap(item => find(item, predicate))
    if (!node || typeof node !== 'object') return []
    return [...(predicate(node) ? [node] : []), ...find(node.children, predicate)]
  }
  const fillFields = async fields => {
    let tree = component()
    for (const [label, value] of Object.entries(fields)) {
      const input = find(tree, node => node.type === 'input' && node.props['aria-label'] === label)[0]
      input.props.onChange({ target: { value } })
      tree = component()
    }
    return tree
  }
  let tree = await fillFields({
    '公司': 'Demo Company', '客户': 'Customer-1', '交易日期': '2026-10-21', '币种': 'USD',
    '商品编码 1': 'ITEM-1', '数量 1': '1', '单价 1': '3', '单位 1': 'Nos',
  })
  await find(tree, node => node.type === 'button' && node.children.includes('创建报价草稿'))[0].props.onClick()
  tree = component()
  assert.match(tree.children ? JSON.stringify(tree) : '', /已确认保存草稿/)
  tree = await fillFields({ '客户': 'Customer-2' })
  await find(tree, node => node.type === 'button' && node.children.includes('保存为新修改操作'))[0].props.onClick()
  tree = component()
  assert.match(JSON.stringify(tree), /版本冲突/)
  const blockedUpdate = find(tree, node => node.type === 'button' && node.children.includes('保存为新修改操作'))[0]
  assert.equal(blockedUpdate.props.disabled, true)
  await find(tree, node => node.type === 'button' && node.children.includes('刷新冲突版本'))[0].props.onClick()
  tree = component()
  assert.match(JSON.stringify(tree), /已读取冲突时的当前版本/)
  assert.equal(find(tree, node => node.type === 'button' && node.children.includes('保存为新修改操作'))[0].props.disabled, false)
  await find(tree, node => node.type === 'button' && node.children.includes('保存为新修改操作'))[0].props.onClick()
  tree = component()
  assert.match(JSON.stringify(tree), /已确认保存草稿/)
  const post = calls.find(call => call.method === 'POST')
  const puts = calls.filter(call => call.method === 'PUT')
  assert.ok(post && puts.length === 2)
  const createBody = JSON.parse(post.body)
  const firstUpdate = JSON.parse(puts[0].body)
  const secondUpdate = JSON.parse(puts[1].body)
  assert.ok(puts.every(put => put.url === `/business-api/erpnext/quotation-drafts/${created.operation_id}`))
  assert.equal(firstUpdate.expected_modified, '2026-10-21 12:00:00.000000')
  assert.equal(secondUpdate.expected_modified, '2026-10-21 12:30:00.000000')
  assert.notEqual(firstUpdate.idempotency_key, createBody.idempotency_key)
  assert.notEqual(secondUpdate.idempotency_key, firstUpdate.idempotency_key)
  assert.equal(secondUpdate.payload.party_name, 'Customer-2')
  assert.equal('role' in secondUpdate, false)
  assert.equal('actor' in secondUpdate, false)
  assert.ok(puts.every(put => put.headers['X-CSRFToken'] === 'fixture-csrf-token'))
  assert.deepEqual(calls.filter(call => call.method === 'GET').map(call => call.url), [
    '/business-api/', '/business-api/', `/business-api/erpnext/quotation-drafts/${conflict.operation_id}`, '/business-api/',
  ])
})

test('scene chat renders the pinned conversation factory inside its retained role SessionProvider', async () => {
  let registration
  const sceneConfig = await readClientSceneConfig()
  sceneConfig.sessionBindings = { center: 'native-center-session', product: 'native-product-session' }
  sceneConfig.roles.find(role => role.id === 'center').assistantLabel = '当前中心助手'
  const componentStates = new WeakMap()
  let activeComponent
  let hookIndex = 0
  const fetchCalls = []
  let dockActionRefreshes = 0
  let resizeViewport = { width: 2000, height: 800 }
  const sceneDockHost = {
    getBoundingClientRect: () => resizeViewport,
    addEventListener() {}, removeEventListener() {},
  }
  let resizeCallback
  const legacyState = defaultSceneWorkbench(sceneConfig)
  const dockLayouts = normalizeDockLayouts(sceneConfig, { version: 2, scenes: {} }, legacyState.layouts)
  const popoutTicket = 'P'.repeat(43)
  const popoutAddedListeners = new Set()
  const popoutRemovedListeners = new Set()
  const popoutWillCloseListeners = new Set()
  const popoutCalls = []
  let popoutUrlRequests = 0
  let popoutEntries = []
  let popoutDocumentLoadUnsubscribes = 0
  let popoutMessageUnsubscribes = 0
  const popoutClasses = new Set()
  const popoutStyleValues = new Map()
  const popoutAttributes = new Map()
  const popoutBody = {
    setAttribute(name, value) { popoutAttributes.set(name, value) },
    removeAttribute(name) { popoutAttributes.delete(name) },
    classList: {
    add(...names) { for (const name of names) popoutClasses.add(name) },
    toggle(name, force) { if (force) popoutClasses.add(name); else popoutClasses.delete(name) },
  }, style: { setProperty(name, value) { popoutStyleValues.set(name, value) } } }
  const popoutDocument = {
    body: popoutBody,
    documentElement: { dataset: {}, style: { setProperty() {} } },
    querySelectorAll() { return [] }, addEventListener() {}, removeEventListener(type) {
      if (type === 'load') popoutDocumentLoadUnsubscribes++
    },
  }
  const popoutWindow = {
    opener: null,
    location: { protocol: 'dsh-app:', hostname: 'app', port: '', pathname: '/desktop-pane-popout.html', search: `?ticket=${popoutTicket}`, hash: '', href: `dsh-app://app/desktop-pane-popout.html?ticket=${popoutTicket}` },
    document: popoutDocument, addEventListener() {}, removeEventListener(type) {
      if (type === 'message') popoutMessageUnsubscribes++
    },
    close() {
      const entry = popoutEntries[0]
      if (!entry) return
      for (const listener of popoutWillCloseListeners) listener({ id: entry.id, window: popoutWindow })
      popoutEntries = []
      for (const dockPanel of dockPanels.values()) dockPanel.api.location = { type: 'grid' }
      for (const listener of popoutRemovedListeners) listener({ id: entry.id, group: entry.group })
    },
  }
  let queuedRestoreFrames = null
  const shellWindow = {
    __ModuleLoader__: { load(value) { registration = value } },
    location: { origin: 'http://127.0.0.1:3088' },
    innerWidth: 2000, innerHeight: 800, screenX: 100, screenY: 50,
    requestAnimationFrame(callback) { if (queuedRestoreFrames) queuedRestoreFrames.push(callback); else callback(); return 1 },
    dshDesktop: { panePopout: { async getUrl() { popoutUrlRequests++; return popoutWindow.location.href } } },
    dispatchEvent() {}, addEventListener() {}, removeEventListener() {},
  }
  popoutWindow.opener = shellWindow
  const React = {
    Fragment: 'Fragment',
    createElement(type, props, ...children) { return { type, props: props ?? {}, children } },
    useRef(initial) {
      let state = componentStates.get(activeComponent)
      if (!state) { state = []; componentStates.set(activeComponent, state) }
      const index = hookIndex++
      if (!(index in state)) state[index] = { current: activeComponent?.name === 'SceneDock' && index === 1 && initial === null ? sceneDockHost : initial }
      return state[index]
    },
    useState(initial) {
      let state = componentStates.get(activeComponent)
      if (!state) { state = []; componentStates.set(activeComponent, state) }
      const index = hookIndex++
      if (!(index in state)) state[index] = typeof initial === 'function' ? initial() : initial
      const owner = activeComponent
      return [state[index], value => {
        state[index] = typeof value === 'function' ? value(state[index]) : value
        if (owner?.name === 'DockGroupActions') dockActionRefreshes++
      }]
    },
    useEffect(effect) { effect() },
    useLayoutEffect() {},
  }
  runInNewContext(await readFile(sceneChunkUrl, 'utf8'), {
    React,
    URL,
    fetch: async (url, options = {}) => {
      fetchCalls.push([url, options.method ?? 'GET'])
      if (url === '/tradeloom/scenes') return { ok: true, async json() { return sceneConfig } }
      if (url === '/tradeloom/scene-layouts' && (options.method ?? 'GET') === 'GET') return {
        ok: true, async json() { return legacyState },
      }
      if (url === '/tradeloom/scene-layouts') return { ok: true }
      if (url === '/tradeloom/dock-layouts' && (options.method ?? 'GET') === 'GET') return {
        ok: true, async json() { return dockLayouts },
      }
      throw new Error(`unexpected request ${url}`)
    },
    requestAnimationFrame(callback) { callback(); return 1 },
    cancelAnimationFrame() {},
    ResizeObserver: class {
      constructor(callback) { resizeCallback = callback }
      observe(target) { resizeCallback([{ target, contentRect: resizeViewport }]) }
      disconnect() {}
    },
    window: shellWindow,
    document: { getElementById() { return null } },
  })
  const createDockPanel = panel => {
    const group = { id: 'test-group', api: { width: 0, height: 0, setSize({ width, height }) { this.width = width; this.height = height } } }
    const api = {
      id: panel.id, group, location: { type: 'grid' },
      setActive() { activatedPanels.push(panel.id) }, setTitle() {}, close() {},
      isMaximized(...args) {
        assert.equal(args.length, 0, 'IDockviewPanelApi.isMaximized() takes no panel or group argument')
        return maximizedGroup && maximizedPanelId === panel.id
      },
      maximize() { maximizeCalls.push(['maximize', panel.id]); maximizedGroup = true; maximizedPanelId = panel.id; maximizeListener?.() },
      exitMaximized() {
        if (!this.isMaximized()) return
        maximizeCalls.push(['restore']); maximizedGroup = false; maximizedPanelId = ''; maximizeListener?.()
      },
      moveTo(options) { floatDockCalls.push(['dock', panel.id, options.position]); this.location = { type: 'grid' }; layoutListener?.() },
    }
    return { id: panel.id, group, api }
  }
  const activatedPanels = []
  const dockPanels = new Map(sceneConfig.scenes[0].panels.filter(panel => panel.optional !== true).map(panel => [panel.id, createDockPanel(panel)]))
  let maximizedGroup = false
  let maximizedPanelId = ''
  let maximizeListener
  let activePanelListener
  let layoutListener
  const maximizeCalls = []
  const floatDockCalls = []
  const loadedDockLayouts = []
  let dockLayoutOverride = null
  let siblingLayoutChangedWhileFloating = false
  const dockApi = {
    panels: [...dockPanels.values()],
    activePanel: dockPanels.get('native-chat'),
    fromJSON(layout) {
      loadedDockLayouts.push(layout)
      dockLayoutOverride = structuredClone(layout)
      if (!layout.floatingGroups?.length) for (const panel of dockPanels.values()) panel.api.location = { type: 'grid' }
      for (const panel of sceneConfig.scenes[0].panels) {
        if (layout.panels?.[panel.id] && !dockPanels.has(panel.id)) dockPanels.set(panel.id, createDockPanel(panel))
      }
      layoutListener?.()
    }, toJSON() {
      const value = structuredClone(dockLayoutOverride ?? dockLayouts.scenes.center.dockview)
      const popout = popoutEntries[0]
      if (popout) {
        const poppedIds = (popout.group?.panels ?? []).map(item => item.id)
        const removePanel = node => {
          if (node.type === 'leaf') {
            const views = node.data.views.filter(id => !poppedIds.includes(id))
            if (views.length === node.data.views.length) return node
            return { ...node, data: { ...node.data, views, activeView: views[0] ?? '' } }
          }
          return { ...node, data: node.data.map(removePanel) }
        }
        value.grid.root = removePanel(value.grid.root)
        value.popoutGroups = [{ gridReferenceGroup: popout.group.id,
          data: { id: popout.group.id, views: poppedIds, activeView: poppedIds[0] },
          position: { top: 8, left: 8, width: 1120, height: 752 }, url: popoutWindow.location.href }]
      }
      const floatingPanel = [...dockPanels.values()].find(panel => panel.api.location?.type === 'floating')
      if (floatingPanel) {
        const removePanel = (node, root = false) => {
          if (node.type === 'leaf') {
            if (!node.data.views.includes(floatingPanel.id)) return node
            const views = node.data.views.filter(id => id !== floatingPanel.id)
            if (!views.length) return null
            return { ...node, data: { ...node.data, views,
              activeView: views.includes(node.data.activeView) ? node.data.activeView : views[0] } }
          }
          const data = node.data.map(child => removePanel(child)).filter(Boolean)
          if (!data.length) return null
          if (data.length === 1) return { ...data[0], size: root ? 100 : node.size }
          return { ...node, data }
        }
        value.grid.root = removePanel(value.grid.root, true)
        value.floatingGroups = [{ data: { id: 'panel-float', views: [floatingPanel.id], activeView: floatingPanel.id },
          position: { top: 8, right: 8, width: 1120, height: 752 } }]
      }
      if (siblingLayoutChangedWhileFloating && value.grid.root?.type === 'branch' && value.grid.root.data.length > 1) {
        value.grid.root.data[1].size = 44
      }
      return value
    }, layout() {}, hasMaximizedGroup() { return maximizedGroup },
    maximizeGroup(panel) { panel.api.maximize() },
    exitMaximizedGroup() { maximizeCalls.push(['restore']); maximizedGroup = false; maximizedPanelId = ''; maximizeListener?.() },
    addPanel(panel) { const created = createDockPanel(panel); dockPanels.set(panel.id, created); layoutListener?.(); return created },
    addFloatingGroup(panel, options) { floatDockCalls.push(['float', panel.id, options]); panel.api.location = { type: 'floating' }; layoutListener?.() },
    addPopoutGroup(panel, options) {
      popoutCalls.push([panel.id, options])
      panel.api.location = { type: 'popout' }
      panel.api.group = { id: 'chat-pane', panels: [panel], activePanel: panel, api: panel.group.api }
      const entry = { id: 'test-popout', group: panel.api.group, window: popoutWindow }
      popoutEntries = [entry]
      for (const listener of popoutAddedListeners) listener(entry)
      return Promise.resolve(true)
    },
    getPopouts() { return popoutEntries },
    removeGroup(group) {
      const entry = popoutEntries.find(item => item.group === group)
      if (!entry) return
      popoutEntries = []
      for (const dockPanel of dockPanels.values()) dockPanel.api.location = { type: 'grid' }
      for (const listener of popoutRemovedListeners) listener(entry)
    },
    getPanel(id) { return dockPanels.get(id) }, getPanels() { return [...dockPanels.values()] },
    onDidLayoutChange(listener) { layoutListener = listener; return { dispose() {} } },
    onDidActivePanelChange(listener) { activePanelListener = listener; return { dispose() {} } },
    onDidMaximizedGroupChange(listener) { maximizeListener = listener; return { dispose() {} } },
    onDidAddPopoutGroup(listener) { popoutAddedListeners.add(listener); return { dispose() { popoutAddedListeners.delete(listener) } } },
    onDidRemovePopoutGroup(listener) { popoutRemovedListeners.add(listener); return { dispose() { popoutRemovedListeners.delete(listener) } } },
    onWillClosePopoutWindow(listener) { popoutWillCloseListeners.add(listener); return { dispose() { popoutWillCloseListeners.delete(listener) } } },
    onWillDragPanel() { return { dispose() {} } },
    onWillShowOverlay() { return { dispose() {} } },
    onWillDrop() { return { dispose() {} } },
  }
  let dockReady = false
  let dockRenderProps
  const dockviewModule = {
    dockviewCss: '',
    DockviewReact({ components, onReady, ...props }) {
      dockRenderProps = props
      if (!dockReady) { dockReady = true; onReady({ api: dockApi }) }
      if (!dockApi.getPanel('native-chat')) return null
      return React.createElement(components['native-chat'], {
        id: 'native-chat', sceneId: 'center', params: { panelId: 'native-chat' }, api: dockApi.getPanel('native-chat').api,
      })
    },
  }
  const sceneRequire = Object.assign(() => React, { async: async () => dockviewModule })
  const exports = registration.factory(sceneRequire)
  const reference = { ready: Promise.resolve(), release() {} }
  let sessionRetains = 0
  let sidebarSuppressionCalls = 0
  let sidebarToggleCalls = 0
  let popoutThemeChange
  const invoke = (Component, props = {}) => {
    const previous = activeComponent
    activeComponent = Component
    hookIndex = 0
    try { return Component(props) } finally { activeComponent = previous }
  }
  let chatSlotDeclaration
  exports.register({
    layout: {
      selectPanel() {},
      suppressSidebar() { sidebarSuppressionCalls++; return () => {} },
      toggleSidebar() { sidebarToggleCalls++ },
    },
    sessions: { retain(sessionId, options) { sessionRetains++; assert.equal(sessionId, 'native-center-session'); assert.deepEqual(JSON.parse(JSON.stringify(options)), { source: 'tradeloomRoleWidget' }); return reference } },
    modelDirectories: { directoryFor() { throw new Error('not used in this test') } },
    slots: { inject(_name, register) { register() }, register(spec) { if (spec.name === 'scene.workbench.chat') { chatSlotDeclaration = spec; assert.equal(spec.children?.['conversation.header'], undefined, 'a native child slot can have only its original declaring owner') }; return () => {} } },
    on(name, listener) { if (name === 'theme/change') popoutThemeChange = listener },
    effect() {},
  })
  invoke(exports.SceneTabs)
  for (let attempt = 0; attempt < 20 && !exports.getSnapshot().config; attempt++) {
    await new Promise(resolve => setImmediate(resolve))
  }
  invoke(exports.SceneTabs)
  assert.deepEqual(JSON.parse(JSON.stringify(exports.getSnapshot().sessionBindings)), sceneConfig.sessionBindings,
    'cold boot hydrates existing role bindings from the authenticated scene response')
  exports.bindRoleSession('product', 'native-product-newer-session')
  await exports.retryLoadConfig()
  assert.equal(exports.getSnapshot().sessionBindings.product, 'native-product-newer-session',
    'a binding updated in the live client wins over an older asynchronous scene response')
  assert.equal(await exports.selectRole('center', 'native-center-session'), true)
  assert.equal(exports.getSnapshot().config?.scenes.length, 7, JSON.stringify({ error: exports.getSnapshot().configError, fetchCalls }))
  assert.equal(exports.sceneTabsNeedCompact(610, 610), false, 'all scene labels stay expanded when their measured width fits exactly')
  assert.equal(exports.sceneTabsNeedCompact(611, 610), true, 'the scene list switches to compact mode only when measured labels exceed available width')
  assert.equal(exports.getSnapshot().sessionBindings.center, 'native-center-session')
  for (const scene of sceneConfig.scenes) {
    assert.equal(JSON.stringify(exports.getSnapshot().dockDefaults[scene.id].dockview), JSON.stringify(dockLayouts.scenes[scene.id].dockview),
      `${scene.id} default and recommended-reset JSON use the same configured recommendation`)
  }
  const factoryCalls = []
  const providedSessions = []
  const providedViewKeys = []
  const SessionProvider = ({ session, children }) => {
    assert.strictEqual(session, reference)
    providedSessions.push(session)
    providedViewKeys.push(children?.props?.key)
    return children
  }
  const sceneProps = {
    SessionProvider,
    renderSlot(name, owner) {
      assert.equal(name, 'scene.workbench.chat')
      return invoke(exports.SceneChatPanel, {
        renderSlot() { throw new Error('the embedded panel must not render an ordinary header owned by main.conversation') },
        renderFactorySlot(...args) {
          factoryCalls.push(args)
          return React.createElement('actual-pinned-conversation-factory', { props: args[1] })
        },
      })
    },
  }
  const resolve = node => {
    if (Array.isArray(node)) return node.map(resolve)
    if (!node || typeof node !== 'object') return node
    if (typeof node.type === 'function') return resolve(invoke(node.type, { ...node.props, children: node.children.length <= 1 ? node.children[0] : node.children }))
    return { ...node, children: node.children.map(resolve) }
  }
  const renderWorkbench = () => resolve(invoke(exports.SceneWorkbench, sceneProps))
  renderWorkbench()
  await new Promise(resolve => setImmediate(resolve))
  let mounted = renderWorkbench()
  assert.equal(dockRenderProps.theme?.gap, 10,
    'the default Dockview theme configures a real inter-group gap rather than outer padding or sash styling')
  assert.equal(sidebarSuppressionCalls, 0, 'rendering a workbench never claims to hide the native sidebar')
  assert.equal(sidebarToggleCalls, 0, 'entering and rendering a workbench never toggles the native sidebar')
  await new Promise(resolve => setImmediate(resolve))
  mounted = renderWorkbench()
  assert.equal(sidebarSuppressionCalls, 0, 'workbench updates never claim temporary sidebar suppression')
  assert.equal(sidebarToggleCalls, 0, 'scene updates never mutate the native sidebar preference')
  assert.ok(factoryCalls.length >= 1)
  assert.ok(factoryCalls.every(call => call[0] === 'conversation.content'
    && JSON.stringify(call[1]) === JSON.stringify({ variant: 'embedded', phase: 'active', hero: false })))
  const find = (node, predicate) => {
    if (!node || typeof node !== 'object') return undefined
    if (predicate(node)) return node
    for (const child of node.children ?? []) {
      const found = Array.isArray(child) ? child.map(item => find(item, predicate)).find(Boolean) : find(child, predicate)
      if (found) return found
    }
  }
  assert.ok(find(mounted, node => node.type === 'actual-pinned-conversation-factory'),
    'the retained role session renders through the pinned conversation factory in its Dockview panel')
  const dockThemeStyles = find(mounted, node => node.type === 'style' && node.children?.some(child => typeof child === 'string' && child.includes('--dv-spacing-padding: var(--tl-space-1);')))
  assert.ok(dockThemeStyles, 'Dockview panel insets follow the selected density scale')
  assert.ok(dockThemeStyles.children.some(child => typeof child === 'string' && child.includes('background: var(--tl-canvas);')),
    'the official split gap exposes the workbench canvas behind surface-colored groups')
  assert.ok(dockThemeStyles.children.some(child => typeof child === 'string' && child.includes('border: 1px solid var(--tl-border);') && child.includes('border-radius: var(--tl-corner-radius);')),
    'each independently docked panel keeps the reference fine border and rounded frame')
  const nativeDensityStyles = dockThemeStyles.children.find(child => typeof child === 'string')
  assert.match(nativeDensityStyles, /\.tl-native-conversation \{ container-type: size; \}/,
    'embedded conversations supply the height container required by native short-pane density rules')
  assert.doesNotMatch(nativeDensityStyles, /\[data-composer-card\] \[title\]:has|div:has\(> button\[title\]\)/,
    'model controls cannot be resized as 64px attachment cards by title or ARIA shape')
  assert.doesNotMatch(nativeDensityStyles, /\[data-composer-card\] \{\s*gap:/,
    'native short-pane composer gaps must not be overwritten by fixed shell spacing')
  const standaloneNavigation = resolve(invoke(exports.SceneTabs, { workbenchActive: false }))
  assert.equal(find(standaloneNavigation, node => node.props?.className === 'tl-scene-tab' && node.props?.['aria-current']), undefined,
    'standalone conversation mode does not leave the previous business scene selected')
  const workbenchNavigation = resolve(invoke(exports.SceneTabs, { workbenchActive: true }))
  assert.equal(find(workbenchNavigation, node => node.props?.className === 'tl-scene-tab' && node.props?.['aria-current'] === 'page')?.props?.['aria-label'], '工作总览',
    'the active workbench scene is selected in the scene navigation')
  const coldBootLayoutMenu = resolve(invoke(exports.SceneTabs, { workbenchActive: true }))
  const productAssistantOption = find(coldBootLayoutMenu, node => node.type === 'button' && node.children?.includes('商品助手'))
  assert.ok(productAssistantOption, `a cold-boot existing optional role binding exposes its real assistant option: ${JSON.stringify(coldBootLayoutMenu)}`)
  productAssistantOption.props.onClick()
  assert.ok(dockApi.getPanel('assistant-product'), 'the existing optional session can be opened without creating a new binding')
  assert.deepEqual(fetchCalls.filter(([url, method]) => url === '/tradeloom/session' && method === 'POST'), [],
    'loading and opening an optional existing assistant never posts to the session-creation endpoint')
  const panel = find(mounted, node => node.props?.['data-panel-id'] === 'native-chat')
  assert.ok(panel, 'Dockview mounts the registered native-chat panel')
  assert.equal(find(panel, node => node.props?.className === 'tl-dock-panel-actions'), undefined,
    'panel actions no longer add a second control row below Dockview tabs')
  assert.equal(find(mounted, node => node.props?.className === 'tl-workbench-heading'), undefined,
    'the duplicated current-assistant heading is removed')
  assert.equal(find(mounted, node => node.props?.className === 'tl-dock-active-panel-actions'), undefined,
    'the old outer action toolbar is removed')
  assert.equal(find(mounted, node => node.props?.className === 'tl-dock-toolbar'), undefined,
    'wide scenes do not leave an empty external toolbar row')
  const groupActions = () => resolve(dockRenderProps.rightHeaderActionsComponent({
    activePanel: dockApi.getPanel(dockApi.activePanel?.id), isGroupActive: true,
  }))
  const bindingStatus = () => find(groupActions(), node => node.props?.className === 'tl-dock-binding-status')
  assert.equal(bindingStatus()?.children?.join(''), '✓ 已绑定',
    'a chat pane identifies that its role is associated with an existing session')
  assert.match(bindingStatus()?.props?.title ?? '', /不代表.*连接/,
    'the binding hint does not imply the native session is connected or ready')
  dockApi.activePanel = dockApi.getPanel('assistant-product')
  activePanelListener?.({ panel: dockApi.activePanel, origin: 'user' })
  renderWorkbench()
  assert.equal(bindingStatus()?.children?.join(''), '✓ 已绑定',
    'switching the active header to a different role shows that role’s existing binding')
  dockApi.activePanel = dockApi.getPanel('business-main')
  activePanelListener?.({ panel: dockApi.activePanel, origin: 'user' })
  renderWorkbench()
  assert.equal(bindingStatus(), undefined, 'business pane headers do not show chat binding status')
  dockApi.addPanel({ id: 'assistant-delivery', component: 'native-chat' })
  dockApi.activePanel = dockApi.getPanel('assistant-delivery')
  activePanelListener?.({ panel: dockApi.activePanel, origin: 'user' })
  renderWorkbench()
  assert.equal(bindingStatus()?.children?.join(''), '未绑定', 'a chat role without an existing binding is labeled without creating one')
  assert.match(bindingStatus()?.props?.title ?? '', /不会自动创建/)
  assert.equal(exports.bindRoleSession('delivery', 'native-delivery-session'), true)
  renderWorkbench()
  assert.equal(bindingStatus()?.children?.join(''), '✓ 已绑定',
    'the mounted chat header follows a later existing role-binding update')
  assert.equal(exports.bindRoleSession('delivery', 'native-delivery-session', {
    scope: 'role', roleId: 'delivery', sessionId: 'native-delivery-session', workspaceId: null, archiveState: 'archived',
  }), true)
  renderWorkbench()
  assert.equal(bindingStatus()?.children?.join(''), '▣ 已归档', 'the existing pane header identifies archived history without replacing its session')
  assert.equal(bindingStatus()?.props?.['data-archive-state'], 'archived')
  assert.match(bindingStatus()?.props?.title ?? '', /显示归档/)
  assert.deepEqual(fetchCalls.filter(([url, method]) => url === '/tradeloom/session' && method === 'POST'), [],
    'the binding badge and its updates never create a native session')
  dockApi.activePanel = dockApi.getPanel('native-chat')
  activePanelListener?.({ panel: dockApi.activePanel, origin: 'user' })
  renderWorkbench()
  let groupTree = groupActions()
  let toolbarRefresh = find(groupTree, node => node.type === 'button' && node.props?.['aria-label'] === '刷新当前中心助手')
  let toolbarMaximize = find(groupTree, node => node.type === 'button' && node.props?.['aria-label'] === '展开当前中心助手')
  assert.ok(toolbarRefresh, 'the active Dockview group header owns refresh')
  assert.ok(toolbarMaximize, 'the active Dockview group header owns maximize')
  assert.equal(dockRenderProps.disableFloatingGroups, false, 'Dockview keeps native floating groups available')
  let floatButton = find(groupTree, node => node.type === 'button' && /^悬浮.*助手$/.test(node.props?.['aria-label'] ?? ''))
  assert.ok(floatButton, 'the native chat header exposes an explicit separate-window action')
  floatButton.props.onClick({ stopPropagation() {} })
  floatButton.props.onClick({ stopPropagation() {} })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(popoutUrlRequests, 1, 'opening a pane requests a fresh one-time URL from the native owner')
  assert.equal(popoutCalls.length, 1, 'a second click while the one-time URL request is pending cannot start another popout')
  assert.equal(popoutCalls[0][0], 'native-chat')
  assert.equal(popoutCalls[0][1].popoutUrl, popoutWindow.location.href)
  assert.deepEqual(JSON.parse(JSON.stringify(popoutCalls[0][1].position)), { left: 972, top: 58, width: 1120, height: 752 },
    'the native chat opens in the separate Dockview window positioned at the right of the primary window')
  groupTree = groupActions()
  const dockButton = find(groupTree, node => node.type === 'button' && /^停靠.*助手$/.test(node.props?.['aria-label'] ?? ''))
  assert.ok(dockButton, 'a popped-out native chat offers an explicit dock action')
  queuedRestoreFrames = []
  const beforeQueuedRestoreCount = loadedDockLayouts.length
  dockButton.props.onClick({ stopPropagation() {} })
  for (const listener of popoutRemovedListeners) listener({})
  assert.ok(queuedRestoreFrames.length >= 2, 'two removal notifications can schedule the same pending restore before the next paint')
  const restoreFrames = queuedRestoreFrames
  queuedRestoreFrames = null
  for (const callback of restoreFrames) callback()
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(loadedDockLayouts.length - beforeQueuedRestoreCount, 1,
    'only the first queued callback consumes the captured pending restore; the stale callback does not deserialize again')
  assert.equal(popoutDocumentLoadUnsubscribes, 1, 'the removed popout document listener is detached even when Dockview omits event.window')
  assert.deepEqual(JSON.parse(JSON.stringify(dockApi.toJSON())), JSON.parse(JSON.stringify(exports.getSnapshot().dockDefaults.center.dockview)),
    'Dockview native close returns the chat to its existing group tree without reloading the layout')

  const previewGroupTree = resolve(dockRenderProps.rightHeaderActionsComponent({
    activePanel: dockApi.getPanel('preview'), isGroupActive: false,
  }))
  const floatPreviewButton = find(previewGroupTree, node => node.type === 'button'
    && String(node.props?.['aria-label'] ?? '').startsWith('悬浮'))
  assert.ok(floatPreviewButton, 'the existing preview pane exposes its separate-window action')
  floatPreviewButton.props.onClick({ stopPropagation() {} })
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(JSON.parse(JSON.stringify(popoutCalls.at(-1))),
    ['preview', { popoutUrl: popoutWindow.location.href, position: { left: 108, top: 58, width: 1120, height: 752 } }],
    'the preview popout uses the signed URL, left-side placement and shared half-width/near-full-height bounds')
  const previewDockTree = resolve(dockRenderProps.rightHeaderActionsComponent({
    activePanel: dockApi.getPanel('preview'), isGroupActive: true,
  }))
  const dockPreviewButton = find(previewDockTree, node => node.type === 'button'
    && String(node.props?.['aria-label'] ?? '').startsWith('停靠'))
  assert.ok(dockPreviewButton, 'the preview popout retains its explicit dock action')
  dockPreviewButton.props.onClick({ stopPropagation() {} })
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(JSON.parse(JSON.stringify(dockApi.toJSON())),
    JSON.parse(JSON.stringify(exports.getSnapshot().dockDefaults.center.dockview)),
    'Dockview native close returns the preview to its saved group tree without reloading the layout')

  const ratioLayout = structuredClone(exports.getSnapshot().dockDefaults.center.dockview)
  ratioLayout.grid.orientation = 'HORIZONTAL'
  ratioLayout.grid.root = { type: 'branch', size: 100, data: [
    { type: 'leaf', size: 62, data: { id: 'business-tabs', views: ['business-main', 'auxiliary', 'reference'], activeView: 'business-main' } },
    { type: 'leaf', size: 38, data: { id: 'chat-pane', views: ['native-chat'], activeView: 'native-chat' } },
  ] }
  dockLayoutOverride = ratioLayout
  groupTree = groupActions()
  floatButton = find(groupTree, node => node.type === 'button' && /^悬浮.*助手$/.test(node.props?.['aria-label'] ?? ''))
  floatButton.props.onClick({ stopPropagation() {} })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(popoutEntries.length, 1, 'a separate window contains the existing group rather than creating a second chat')
  assert.equal(popoutStyleValues.get('--dsh-ui-scale'), 'var(--tl-ui-scale, 1)',
    'native menus portaled under body inherit the workbench density scale')
  assert.equal(popoutStyleValues.get('--dsh-content-font-size'), 'var(--tl-font-body, 14px)',
    'native menus portaled under body inherit the workbench font size')
  assert.equal(popoutClasses.has('is-light'), true)
  assert.equal(popoutClasses.has('is-dark'), false)
  assert.equal(popoutAttributes.has('data-ds-dark-theme'), false)
  popoutThemeChange?.({ active: { colorScheme: 'dark' } })
  assert.equal(popoutClasses.has('is-dark'), true, 'the adopted popout document switches to dark theme')
  assert.equal(popoutAttributes.has('data-ds-dark-theme'), true,
    'the native token stylesheet selects its dark composer and attachment palette in the popout')
  assert.equal(popoutDocument.documentElement.style.colorScheme, 'dark',
    'native form controls follow the resolved popup color scheme')
  assert.equal(popoutClasses.has('is-light'), false, 'dark and light body classes remain mutually exclusive')
  popoutThemeChange?.({ active: { colorScheme: 'light' } })
  assert.equal(popoutClasses.has('is-light'), true, 'the adopted popout document switches back to light theme')
  assert.equal(popoutClasses.has('is-dark'), false, 'switching back removes the stale dark class')
  assert.equal(popoutAttributes.has('data-ds-dark-theme'), false, 'light theme retracts the native dark token selector')
  assert.equal(popoutDocument.documentElement.style.colorScheme, 'light')
  groupTree = groupActions()
  const dockChatRatio = find(groupTree, node => node.type === 'button' && /^停靠.*助手$/.test(node.props?.['aria-label'] ?? ''))
  dockChatRatio.props.onClick({ stopPropagation() {} })
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(JSON.parse(JSON.stringify(dockApi.toJSON().grid.root.data.map(child => child.size))), [62, 38],
    'Dockview native close preserves the 62/38 split ratio without rebuilding the panel')

  const editedWhilePopout = structuredClone(ratioLayout)
  const businessGroup = structuredClone(ratioLayout.grid.root.data[0])
  businessGroup.size = 50
  const previewGroup = { type: 'leaf', size: 20, data: { id: 'preview-pane', views: ['preview'], activeView: 'preview' } }
  const chatGroup = structuredClone(ratioLayout.grid.root.data[1])
  chatGroup.size = 30
  editedWhilePopout.grid.root.data = [businessGroup, previewGroup, chatGroup]
  dockApi.activePanel = dockApi.getPanel('native-chat')
  activePanelListener?.({ panel: dockApi.activePanel, origin: 'user' })
  renderWorkbench()
  groupTree = groupActions()
  floatButton = find(groupTree, node => node.type === 'button' && /^悬浮.*助手$/.test(node.props?.['aria-label'] ?? ''))
  floatButton.props.onClick({ stopPropagation() {} })
  await new Promise(resolve => setImmediate(resolve))
  dockLayoutOverride = editedWhilePopout
  dockLayoutOverride.grid.root.data[0].size = 60
  dockLayoutOverride.grid.root.data[1].size = 30
  dockLayoutOverride.grid.root.data[2].size = 10
  groupTree = groupActions()
  const editedLayoutDock = find(groupTree, node => node.type === 'button' && /^停靠.*助手$/.test(node.props?.['aria-label'] ?? ''))
  assert.ok(editedLayoutDock, 'the chat remains dockable after the main layout changes')
  const restoreCountAfterEdit = loadedDockLayouts.length
  editedLayoutDock.props.onClick({ stopPropagation() {} })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(loadedDockLayouts.length, restoreCountAfterEdit + 1,
    'docking after a layout edit restores the captured current grid, with the returned panel reused')
  assert.equal(loadedDockLayouts.at(-1).popoutGroups, undefined,
    'the repaired main-window snapshot does not serialize a popout or its one-time URL')
  assert.ok(loadedDockLayouts.at(-1).grid.root.data.some(node => node.type === 'leaf'
    && node.data.id === 'chat-pane' && node.data.views.includes('native-chat')),
  'the existing chat panel is inserted into its retained empty group in the current grid')
  assert.deepEqual(JSON.parse(JSON.stringify(dockApi.toJSON().grid.root.data.map(child => child.size))), [48, 24, 8],
    'the 6:3:1 proportions are preserved within the available 80px after two 10px gaps')

  const inactiveGroupTree = resolve(dockRenderProps.rightHeaderActionsComponent({
    activePanel: dockApi.getPanel('business-main'), isGroupActive: false,
  }))
  assert.ok(find(inactiveGroupTree, node => node.type === 'button' && node.props?.['aria-label'] === '刷新总览'),
    'an inactive group retains its own refresh action without changing focus')
  assert.ok(find(inactiveGroupTree, node => node.type === 'button' && node.props?.['aria-label'] === '展开总览'),
    'an inactive group retains its own maximize action')
  assert.ok(find(inactiveGroupTree, node => node.type === 'button' && node.props?.['aria-label'] === '悬浮总览'),
    'the business preview exposes the same reversible overlay affordance as the native chat')
  const previewFloatButton = find(inactiveGroupTree, node => node.type === 'button' && node.props?.['aria-label'] === '悬浮总览')
  previewFloatButton.props.onClick({ stopPropagation() {} })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(popoutCalls.at(-1)[0], 'business-main', 'the existing business panel moves to a separate window without creating a new iframe')
  assert.equal(popoutEntries.length, 1, 'the Dockview popout registry contains the moved business pane')
  const previewActions = resolve(dockRenderProps.rightHeaderActionsComponent({
    activePanel: dockApi.getPanel('business-main'), isGroupActive: true,
  }))
  const dockPreview = find(previewActions, node => node.type === 'button' && node.props?.['aria-label'] === '停靠总览')
  assert.ok(dockPreview, 'a popped-out business pane keeps a visible dock action')
  siblingLayoutChangedWhileFloating = true
  const restoreCountBeforeDock = loadedDockLayouts.length
  dockPreview.props.onClick({ stopPropagation() {} })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(loadedDockLayouts.length, restoreCountBeforeDock,
    'docking keeps main-window changes made while the business pane was popped out')
  assert.deepEqual(JSON.parse(JSON.stringify(dockApi.toJSON().grid.root.data.map(child => child.size))), [48, 44, 8],
    'the changed proportions among the remaining panes survive business-pane return')
  const inactiveRefresh = find(inactiveGroupTree, node => node.type === 'button' && node.props?.['aria-label'] === '刷新总览')
  const activeBeforeInactiveAction = [...activatedPanels]
  let stoppedPointerDown = false
  inactiveRefresh.props.onPointerDown({ stopPropagation() { stoppedPointerDown = true } })
  inactiveRefresh.props.onClick({ stopPropagation() {} })
  assert.equal(stoppedPointerDown, true, 'group action pointer-down does not activate the inactive Dockview group')
  assert.deepEqual(activatedPanels, activeBeforeInactiveAction, 'running an inactive group action does not change the active panel')
  const navTree = resolve(invoke(exports.SceneTabs, { workbenchActive: true }))
  const layoutTrigger = find(navTree, node => node.type === 'button' && node.props?.['aria-label'] === '工作区布局')
  assert.ok(layoutTrigger, 'the global navigation keeps layout access independent of Dockview groups')
  const layoutMenu = find(navTree, node => node.props?.id === 'tl-scene-layout-menu')
  const recommendLayout = find(layoutMenu, node => node.type === 'button' && node.children?.includes('应用推荐布局'))
  assert.ok(recommendLayout, 'the user can explicitly apply the configured recommendation after changing a saved layout')
  recommendLayout.props.onClick()
  assert.equal(JSON.stringify(loadedDockLayouts.at(-1)), JSON.stringify(exports.getSnapshot().dockDefaults.center.dockview),
    'applying the recommendation restores the exact scene-specific Dockview tree')
  assert.strictEqual(providedSessions.at(-1), reference)
  assert.equal(providedViewKeys.at(-1), 'native-center-session')
  toolbarRefresh.props.onClick()
  const refreshed = renderWorkbench()
  assert.strictEqual(providedSessions.at(-1), reference, 'refresh keeps the existing native SessionProvider reference')
  assert.equal(providedViewKeys.at(-1), 'native-center-session', 'refresh keeps the existing conversation view subtree mounted')
  assert.equal(exports.getSnapshot().panelRefreshKeys?.products, undefined, 'refreshing the center panel does not mutate another scene’s refresh state')
  assert.equal(sessionRetains, 1, 'refresh does not create or retain another native session')
  assert.equal(fetchCalls.some(([, method]) => method === 'POST'), false, 'refresh sends no model/session request')
  toolbarMaximize.props.onClick()
  assert.deepEqual(maximizeCalls, [['maximize', 'native-chat']], 'maximize uses the pinned Dockview public API for the selected panel')
  assert.ok(dockActionRefreshes > 0, 'the official maximize event notifies stable group header renderers to refresh their labels')
  renderWorkbench()
  const toolbarRestore = find(groupActions(), node => node.type === 'button' && node.props?.['aria-label'] === '还原当前中心助手')
  assert.ok(toolbarRestore, 'the toolbar label follows Dockview maximized state')
  toolbarRestore.props.onClick()
  assert.deepEqual(maximizeCalls, [['maximize', 'native-chat'], ['restore']])
  renderWorkbench()
  const toolbarExpandAgain = find(groupActions(), node => node.type === 'button' && node.props?.['aria-label'] === '展开当前中心助手')
  assert.ok(toolbarExpandAgain, 'the button returns to Expand after the group is restored')
  toolbarExpandAgain.props.onClick()
  assert.deepEqual(maximizeCalls, [['maximize', 'native-chat'], ['restore'], ['maximize', 'native-chat']],
    'the same public panel API can expand the group again after a restore')
  renderWorkbench()
  assert.ok(find(groupActions(), node => node.type === 'button' && node.props?.['aria-label'] === '还原当前中心助手'),
    'the second maximize updates the stable header action back to Restore')
  dockApi.activePanel = dockPanels.get('business-main')
  activePanelListener({ panel: dockApi.activePanel, origin: 'user' })
  renderWorkbench()
  const businessRefresh = find(groupActions(), node => node.type === 'button' && node.props?.['aria-label'] === '刷新总览')
  assert.ok(businessRefresh, 'the group header follows Dockview active-panel changes')
  businessRefresh.props.onClick()
  assert.equal(exports.getSnapshot().panelRefreshKeys.center['business-main'], 2,
    'refresh targets the active business panel rather than the previously active chat')
  const centerLayoutBeforeNarrow = JSON.stringify(dockLayouts.scenes.center)
  resizeViewport = { width: 900, height: 800 }
  resizeCallback([{ target: sceneDockHost, contentRect: resizeViewport }])
  const narrowTree = renderWorkbench()
  assert.ok(find(narrowTree, node => node.type === 'select' && node.props?.['aria-label'] === '选择当前面板'),
    'the actual Dockview canvas below the collaboration-grid width threshold switches to the single-panel picker')
  assert.ok(find(narrowTree, node => node.props?.className === 'tl-dock-toolbar'),
    'narrow mode renders the compact panel selector toolbar')
  const narrowGroupActions = find(groupActions(), node => node.props?.className === 'tl-dock-group-actions')
  const narrowRefresh = find(narrowGroupActions, node => node.type === 'button' && node.props?.['aria-label'] === '刷新总览')
  assert.ok(narrowRefresh, 'narrow mode keeps per-group refresh reachable while tab dragging is disabled')
  narrowRefresh.props.onClick({ stopPropagation() {} })
  assert.equal(exports.getSnapshot().panelRefreshKeys.center['business-main'], 3,
    'narrow-mode group refresh still targets its own panel')
  assert.equal(dockRenderProps.disableDnd, true, 'narrow mode disables layout dragging so responsive geometry stays transient')
  assert.equal(JSON.stringify(dockLayouts.scenes.center), centerLayoutBeforeNarrow,
    'narrow mode keeps the serialized saved layout unchanged')
  resizeViewport = { width: 2000, height: 800 }
  resizeCallback([{ target: sceneDockHost, contentRect: resizeViewport }])
  const wideTree = renderWorkbench()
  assert.equal(find(wideTree, node => node.type === 'select' && node.props?.['aria-label'] === '选择当前面板'), undefined,
    'the full recommended layout returns when the same canvas widens')
  assert.equal(dockRenderProps.disableDnd, false)
  assert.deepEqual(maximizeCalls.slice(-2), [['maximize', 'business-main'], ['restore']], 'responsive maximize restores without replacing the saved tree')
  resizeViewport = { width: 2000, height: 300 }
  resizeCallback([{ target: sceneDockHost, contentRect: resizeViewport }])
  assert.ok(find(renderWorkbench(), node => node.type === 'select' && node.props?.['aria-label'] === '选择当前面板'),
    'a canvas below the minimum row height also uses the single-panel mode')
  resizeViewport = { width: 2000, height: 800 }
  resizeCallback([{ target: sceneDockHost, contentRect: resizeViewport }])
  renderWorkbench()
  assert.deepEqual(maximizeCalls.slice(-2), [['maximize', 'business-main'], ['restore']])

  for (const panelId of [...dockPanels.keys()]) dockPanels.delete(panelId)
  dockApi.activePanel = undefined
  layoutListener()
  renderWorkbench()
  const noPanelsNavigation = resolve(invoke(exports.SceneTabs, { workbenchActive: true }))
  const noPanelsMenu = find(noPanelsNavigation, node => node.props?.id === 'tl-scene-layout-menu')
  const noPanelsRecommendation = find(noPanelsMenu, node => node.type === 'button' && node.children?.includes('应用推荐布局'))
  assert.ok(noPanelsRecommendation, 'the global layout menu remains reachable after every Dockview panel is closed')
  noPanelsRecommendation.props.onClick()
  assert.equal(JSON.stringify(loadedDockLayouts.at(-1)), JSON.stringify(exports.getSnapshot().dockDefaults.center.dockview),
    'the global recovery action restores the configured recommendation when no group header exists')
  assert.equal(dockPanels.size, 4, 'recommended reset recreates the four default panels')
  assert.ok(['center-assistant', 'product-assistant', 'delivery-assistant'].every(id => !dockPanels.has(id)),
    'optional parallel assistants stay closed in the default recommendation')
})

test('narrow scene navigation focuses the requested panel when mounting an unvisited scene in real React DOM', { skip: !process.env.TRADELOOM_REACT_LIBRARY || !process.env.TRADELOOM_REACT_SERVER_LIBRARY || !process.env.TRADELOOM_DOM_MODULE }, async t => {
  const { createRequire } = await import('node:module')
  const nodeRequire = createRequire(import.meta.url)
  const React = nodeRequire(process.env.TRADELOOM_REACT_LIBRARY)
  const pinnedRequire = createRequire(process.env.TRADELOOM_REACT_SERVER_LIBRARY)
  const { createRoot } = pinnedRequire('react-dom/client')
  const act = React.act ?? pinnedRequire('react-dom/test-utils').act
  const { JSDOM } = nodeRequire(process.env.TRADELOOM_DOM_MODULE)
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    url: 'http://desktop.local/', pretendToBeVisual: true,
  })
  let hostSize = { width: 980, height: 650 }
  let dockResizeCallback
  const globals = ['window', 'document', 'navigator', 'fetch', 'requestAnimationFrame', 'cancelAnimationFrame', 'IS_REACT_ACT_ENVIRONMENT']
    .map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)])
  let root
  try {
    const dockWriteCalls = []
    const dockWriteBodies = []
    const fetch = async (url, options = {}) => {
      dockWriteCalls.push([url, options.method ?? 'GET'])
      if (url === '/tradeloom/scenes') return { ok: true, async json() { return { ...config, businessOrigin: 'http://desktop.local' } } }
      if (url === '/tradeloom/scene-layouts' && options.method === 'PUT') return { ok: true, async json() { return {} } }
      if (url === '/tradeloom/scene-layouts') return { ok: true, async json() { return savedSceneState } }
      if (url === '/tradeloom/dock-layouts' && options.method === 'PUT') {
        dockWriteBodies.push(JSON.parse(options.body))
        return { ok: true, async json() { return {} } }
      }
      if (url === '/tradeloom/dock-layouts') return { ok: true, async json() { return savedDockLayouts } }
      if (url === '/business-api/erpnext/status') return { ok: true, async json() { return { configured: false, connected: false, status: 'not_configured' } } }
      throw new Error(`unexpected synthetic request: ${url}`)
    }
    const installGlobal = (key, value) => Object.defineProperty(globalThis, key, { configurable: true, writable: true, value })
    installGlobal('window', dom.window)
    installGlobal('document', dom.window.document)
    installGlobal('navigator', dom.window.navigator)
    installGlobal('fetch', fetch)
    installGlobal('requestAnimationFrame', callback => dom.window.setTimeout(callback, 0))
    installGlobal('cancelAnimationFrame', id => dom.window.clearTimeout(id))
    installGlobal('IS_REACT_ACT_ENVIRONMENT', true)

    const config = await readClientSceneConfig()
    const savedSceneState = defaultSceneWorkbench(config)
    savedSceneState.activeSceneId = 'center'
    savedSceneState.businessPath = '/home'
    const savedDockLayouts = normalizeDockLayouts(config, { version: 2, scenes: {} }, savedSceneState.layouts)
    const productsLayout = savedDockLayouts.scenes.products
    productsLayout.dockview.grid.root.data[0].size = 64
    productsLayout.closedPanelIds = ['auxiliary']
    const savedProductsLayoutBeforeNavigation = structuredClone(productsLayout)
    const centerLeaf = savedDockLayouts.scenes.center.dockview.grid.root.data[0]
    centerLeaf.data.activeView = 'business-main'
    savedDockLayouts.scenes.center.dockview.activeGroup = centerLeaf.data.id
    const erpLeaf = savedDockLayouts.scenes.erpnext.dockview.grid.root.data[0]
    erpLeaf.data.activeView = 'auxiliary'
    savedDockLayouts.scenes.erpnext.dockview.activeGroup = erpLeaf.data.id
    savedDockLayouts.scenes.erpnext.closedPanelIds = ['business-main']

    let registration
    const chunkSource = await readFile(sceneChunkUrl, 'utf8')
    dom.window.__ModuleLoader__ = { load(value) { registration = value } }
    runInNewContext(chunkSource, {
      window: dom.window, document: dom.window.document, React, URLSearchParams, fetch,
      crypto: dom.window.crypto,
      ResizeObserver: class {
        constructor(callback) { dockResizeCallback = callback }
        observe() {}
        disconnect() {}
      },
      requestAnimationFrame: callback => dom.window.setTimeout(callback, 0),
      cancelAnimationFrame: id => dom.window.clearTimeout(id),
      setTimeout: dom.window.setTimeout.bind(dom.window), clearTimeout: dom.window.clearTimeout.bind(dom.window),
    })

    const sceneByComponents = new WeakMap()
    const mountOrder = ['center', 'products', 'erpnext']
    let nextSceneIndex = 0
    const apiForScene = (sceneId, onPanelChange) => {
      const scene = config.scenes.find(item => item.id === sceneId)
    let maximizedPanelId = ''
      const makePanel = panel => ({
        id: panel.id,
        component: panel.type,
        api: {
          id: panel.id,
          group: { api: { width: 0, height: 0, setSize(size) { Object.assign(this, size) } } },
          setActive() { activePanelId = panel.id; activeListener?.({ panel: panels.get(panel.id), origin: 'user' }); onPanelChange() },
        setTitle() {}, close() {}, isMaximized() { return maximizedPanelId === panel.id },
        maximize() { maximizedPanelId = panel.id; maximizeListener?.() },
        exitMaximized() { maximizedPanelId = ''; maximizeListener?.() },
        },
      })
      const initiallyClosed = new Set(savedDockLayouts.scenes[sceneId].closedPanelIds ?? [])
      const panels = new Map(scene.panels.filter(panel => !initiallyClosed.has(panel.id)).map(panel => [panel.id, makePanel(panel)]))
      let activePanelId = scene.panels[0].id
      let activeListener
      let layoutListener
      let maximizeListener
      let layout = savedDockLayouts.scenes[sceneId].dockview
      const getActiveView = value => {
        const visit = node => {
          if (!node) return undefined
          if (node.type === 'leaf') return node.data.id === value.activeGroup ? node.data.activeView : undefined
          for (const child of node.data ?? []) { const selected = visit(child); if (selected) return selected }
          return undefined
        }
        return visit(value.grid?.root)
      }
      const api = {
        get activePanel() { return panels.get(activePanelId) },
        fromJSON(value) { layout = value; activePanelId = getActiveView(value) ?? scene.panels[0].id; layoutListener?.() },
        toJSON() { return layout }, layout() {},
        getPanel(id) { return panels.get(id) }, getPanels() { return [...panels.values()] },
        addPanel(panel) {
          let result = panels.get(panel.id)
          if (!result) {
            const definition = scene.panels.find(item => item.id === panel.id)
            if (definition) { result = makePanel(definition); panels.set(panel.id, result) }
          }
          activePanelId = panel.id
          onPanelChange()
          return result
        },
        hasMaximizedGroup() { return Boolean(maximizedPanelId) },
        maximizeGroup(panel) { panel.api.maximize() },
        exitMaximizedGroup() { panels.get(maximizedPanelId)?.api.exitMaximized() },
        onDidLayoutChange(listener) { layoutListener = listener; return { dispose() {} } },
        onDidActivePanelChange(listener) { activeListener = listener; return { dispose() {} } },
        onDidMaximizedGroupChange(listener) { maximizeListener = listener; return { dispose() {} } },
        onWillDragPanel() { return { dispose() {} } },
        onWillShowOverlay() { return { dispose() {} } },
        onWillDrop() { return { dispose() {} } },
      }
      return api
    }
    function DockviewReact({ components, onReady, ...props }) {
      let sceneId = sceneByComponents.get(components)
      if (!sceneId) {
        sceneId = mountOrder[nextSceneIndex++]
        sceneByComponents.set(components, sceneId)
      }
      const [, rerender] = React.useReducer(value => value + 1, 0)
      const apiRef = React.useRef(null)
      if (!apiRef.current) apiRef.current = apiForScene(sceneId, rerender)
      React.useEffect(() => { onReady({ api: apiRef.current }) }, [])
      const panel = apiRef.current.activePanel
      const Component = panel && components[panel.component]
      return React.createElement('div', { className: 'test-dockview', 'data-test-scene': sceneId, 'data-disable-dnd': String(props.disableDnd) },
        Component ? React.createElement(Component, { id: panel.id, sceneId, params: { panelId: panel.id }, api: panel.api }) : null)
    }
    const dockviewModule = { DockviewReact, dockviewCss: '' }
    const sceneRequire = Object.assign(name => {
      if (name === 'react') return React
      if (name === 'react-dom') return { createPortal: child => child }
      assert.fail(`unexpected scene dependency: ${name}`)
    }, { async: async () => dockviewModule })
    const sceneExports = registration.factory(sceneRequire)
    sceneExports.register({
      layout: { selectPanel() {} }, sessions: { retain() { return { ready: Promise.resolve(), release() {} } } },
      modelDirectories: { directoryFor() { return undefined } }, slots: { inject(_name, callback) { callback() }, register() { return () => {} } },
      effect() {}, on() {},
    })
    const SessionProvider = ({ children }) => children
    const App = () => React.createElement(React.Fragment, null,
      React.createElement(sceneExports.SceneTabs, { workbenchActive: true }),
      React.createElement(sceneExports.SceneWorkbench, { SessionProvider, renderSlot() { return null } }))
    const host = dom.window.document.getElementById('root')
    const originalRect = dom.window.HTMLElement.prototype.getBoundingClientRect
    dom.window.HTMLElement.prototype.getBoundingClientRect = function () {
      if (this.classList?.contains('tl-dockview-host')) return { x: 0, y: 0, left: 0, top: 0, right: hostSize.width, bottom: hostSize.height, width: hostSize.width, height: hostSize.height, toJSON() { return this } }
      return originalRect.call(this)
    }
    root = createRoot(host)
    await act(async () => { root.render(React.createElement(App)); await new Promise(resolve => setTimeout(resolve, 20)) })
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })
    assert.ok(host.querySelector('.tl-dock-scene.is-active[aria-label="工作总览工作区"]'), 'the initial scene is visibly mounted')

    const productsTab = host.querySelector('button.tl-scene-tab[aria-label="商品"]')
    assert.ok(productsTab)
    await act(async () => {
      productsTab.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
      await new Promise(resolve => setTimeout(resolve, 20))
    })
    const activeProducts = host.querySelector('.tl-dock-scene.is-active[aria-label="商品工作区"]')
    assert.ok(activeProducts, 'clicking Products mounts its visible scene')
    assert.equal(activeProducts.querySelector('select[aria-label="选择当前面板"]'), null,
      'a 980x650 collaboration-grid host stays in multi-panel mode')
    assert.equal(activeProducts.querySelector('.test-dockview')?.getAttribute('data-disable-dnd'), 'false')
    assert.equal(activeProducts.querySelector('.tl-dock-panel')?.getAttribute('data-panel-id'), 'business-main')
    assert.deepEqual(savedDockLayouts.scenes.products, savedProductsLayoutBeforeNavigation,
      'scene navigation leaves an existing custom recommendation and its closed-panel list intact')
    const productsHost = activeProducts.querySelector('.tl-dockview-host')
    const productPutCountBeforeNarrow = dockWriteCalls.filter(([url, method]) => url === '/tradeloom/dock-layouts' && method === 'PUT').length
    const resizeProductHost = async size => {
      hostSize = size
      await act(async () => {
        dockResizeCallback([{ target: productsHost, contentRect: size }])
        await new Promise(resolve => setTimeout(resolve, 0))
      })
    }
    await resizeProductHost({ width: 959, height: 650 })
    assert.ok(activeProducts.querySelector('select[aria-label="选择当前面板"]'),
      '959px host width is below the collaboration-grid cutoff')
    assert.equal(activeProducts.querySelector('.test-dockview')?.getAttribute('data-disable-dnd'), 'true')
    await resizeProductHost({ width: 980, height: 559 })
    assert.ok(activeProducts.querySelector('select[aria-label="选择当前面板"]'),
      '559px host height is below the collaboration-grid cutoff')
    assert.equal(JSON.stringify(savedDockLayouts.scenes.products), JSON.stringify(savedProductsLayoutBeforeNavigation),
      'responsive single-panel mode does not rewrite user proportions or closed panels')
    assert.equal(dockWriteCalls.filter(([url, method]) => url === '/tradeloom/dock-layouts' && method === 'PUT').length,
      productPutCountBeforeNarrow, 'responsive resizing does not persist a narrow Dockview geometry')
    await resizeProductHost({ width: 960, height: 560 })
    assert.equal(activeProducts.querySelector('select[aria-label="选择当前面板"]'), null,
      'the recommended grid returns at the exact 960x560 boundary')
    assert.equal(activeProducts.querySelector('.test-dockview')?.getAttribute('data-disable-dnd'), 'false')

    const productsApi = sceneExports.getDockviewApi('products')
    const stableProductsAfterWideRestore = structuredClone(savedDockLayouts.scenes.products)
    const putCountBeforeHostResize = dockWriteBodies.length
    await resizeProductHost({ width: 940, height: 540 })
    assert.ok(activeProducts.querySelector('select[aria-label="选择当前面板"]'),
      'the observed 940x540 host enters single-panel mode')
    assert.equal(productsApi.hasMaximizedGroup(), true, 'narrow mode maximizes the selected panel in memory')
    assert.equal(dockWriteBodies.length, putCountBeforeHostResize,
      'the observed narrow resize does not persist temporary maximized geometry')
    await resizeProductHost({ width: 980, height: 650 })
    assert.equal(activeProducts.querySelector('select[aria-label="选择当前面板"]'), null,
      'the observed 980x650 host restores the multi-panel workbench')
    assert.equal(productsApi.hasMaximizedGroup(), false, 'returning wide exits temporary maximize')
    assert.deepEqual(savedDockLayouts.scenes.products, stableProductsAfterWideRestore,
      'narrow/wide host transitions preserve custom ratios and closed-panel IDs')
    assert.ok(dockWriteBodies.every(body => !Object.hasOwn(body.scenes.products.dockview.grid, 'maximizedNode')),
      'the HTTP queue never persists temporary maximized geometry')

    await resizeProductHost({ width: 959, height: 650 })
    const erpTab = host.querySelector('#tl-scene-tools-menu button[aria-label="ERPNext"]')
    assert.ok(erpTab)
    await act(async () => {
      erpTab.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
      await new Promise(resolve => setTimeout(resolve, 20))
    })
    const activeScene = host.querySelector('.tl-dock-scene.is-active[aria-label="ERPNext工作区"]')
    assert.ok(activeScene, 'clicking the scene navigator makes ERPNext the active visible workbench')
    assert.equal(activeScene.style.display, 'flex')
    assert.equal(host.querySelector('#tl-scene-tools-menu button[aria-label="ERPNext"]').getAttribute('aria-current'), 'page')
    assert.ok(activeScene.querySelector('select[aria-label="选择当前面板"]'), 'the 959px canvas enters narrow single-pane mode')
    assert.equal(activeScene.querySelector('.test-dockview')?.getAttribute('data-disable-dnd'), 'true')
    const visiblePanel = activeScene.querySelector('.tl-dock-panel')
    assert.equal(visiblePanel?.getAttribute('data-panel-id'), 'business-main',
      'narrow unvisited scenes show the requested main business panel instead of the saved auxiliary placeholder')
    assert.equal(visiblePanel?.getAttribute('data-panel-type'), 'erpnext-status')
    assert.deepEqual(savedDockLayouts.scenes.erpnext.closedPanelIds, ['business-main'], 'the saved closed-panel state is not rewritten by navigation')
    assert.equal(erpLeaf.data.activeView, 'auxiliary', 'the saved group selection remains unchanged while navigation opens the required panel in memory')
  } finally {
    if (root) await act(async () => root.unmount())
    for (const [key, descriptor] of globals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor)
      else delete globalThis[key]
    }
    dom.window.close()
  }
})

test('native role sessions retain composer drafts across scene switches and release at workbench teardown', async () => {
  let registration
  runInNewContext(await readFile(sceneChunkUrl, 'utf8'), {
    window: { __ModuleLoader__: { load(value) { registration = value } } },
  })
  const exports = registration.factory(() => ({ createElement() {} }))
  const calls = []
  const sessions = { retain(sessionId, options) {
    const reference = { sessionId, release() { calls.push(['release', sessionId]) } }
    calls.push(['retain', sessionId, options])
    return reference
  } }

  const center = exports.retainRoleSession(sessions, 'center', 'session-center')
  const product = exports.retainRoleSession(sessions, 'product', 'session-product')
  const centerAgain = exports.retainRoleSession(sessions, 'center', 'session-center')
  assert.strictEqual(centerAgain, center, 'returning to a scene reuses its live Session scope and composer draft')
  assert.notStrictEqual(product, center, 'each role keeps an independent native Session scope')
  assert.deepEqual(JSON.parse(JSON.stringify(calls.filter(call => call[0] === 'retain'))), [
    ['retain', 'session-center', { source: 'tradeloomRoleWidget' }],
    ['retain', 'session-product', { source: 'tradeloomRoleWidget' }],
  ])
  assert.deepEqual(calls.filter(call => call[0] === 'release'), [], 'scene switches must not dispose another role composer')

  exports.releaseRoleSessions()
  assert.deepEqual(calls.filter(call => call[0] === 'release'), [
    ['release', 'session-center'], ['release', 'session-product'],
  ], 'the bounded role pool is released when the workbench context ends')
})

test('mounted chat panels wait for existing catalog sessions, retry on refresh, and share without cross-release', async () => {
  let registration
  runInNewContext(await readFile(sceneChunkUrl, 'utf8'), {
    window: { __ModuleLoader__: { load(value) { registration = value } } },
  })
  const exports = registration.factory(() => ({ createElement() {} }))
  let catalog = { phase: 'pending', ids: [], byId: {} }
  const listeners = new Set()
  const calls = []
  let finishCatalogRefresh
  const sessionReference = { sessionId: 'existing-center-session', ready: Promise.resolve(), release() { calls.push('release') } }
  const sessions = {
    list: {
      getSnapshot() { return catalog },
      subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener) },
    },
    retain(sessionId, options) {
      calls.push(['retain', sessionId, options])
      return sessionReference
    },
    refresh() {
      calls.push('refresh')
      if (catalog.phase === 'pending') return new Promise(resolve => {
        finishCatalogRefresh = () => {
          catalog = { phase: 'ready', ids: ['existing-center-session'], byId: { 'existing-center-session': {} } }
          for (const listener of [...listeners]) listener()
          resolve()
        }
      })
      catalog = { phase: 'ready', ids: ['existing-center-session'], byId: { 'existing-center-session': {} } }
      for (const listener of [...listeners]) listener()
      return Promise.resolve()
    },
  }
  const ready = []
  const unavailable = []
  const stopPending = exports.retainListedRoleSession(sessions, 'center', 'existing-center-session', {
    onReady(reference) { ready.push(reference) },
    onUnavailable(message) { unavailable.push(message) },
  })
  assert.deepEqual(calls, ['refresh'], 'a pending native catalog triggers one public read refresh without retaining early')
  assert.equal(listeners.size, 1, 'a pending mount subscribes to the existing native session catalog')
  assert.equal(calls.some(call => Array.isArray(call) && call[0] === 'retain'), false,
    'retain waits until the refresh confirms the existing session id')
  finishCatalogRefresh()
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(ready.length, 1)
  assert.strictEqual(ready[0], sessionReference)
  assert.deepEqual(JSON.parse(JSON.stringify(calls.filter(Array.isArray))), [
    ['retain', 'existing-center-session', { source: 'tradeloomRoleWidget' }],
  ])

  let retriedReady = 0
  const stopRetry = exports.retainListedRoleSession(sessions, 'center', 'existing-center-session', {
    refresh: true,
    onReady(reference) { assert.strictEqual(reference, sessionReference); retriedReady++ },
    onUnavailable(message) { unavailable.push(message) },
  })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(calls.includes('refresh'), true, 'the panel refresh path refreshes only the native session catalog')
  assert.equal(retriedReady, 1, 'refresh retries the same existing binding when the catalog confirms it')
  assert.equal(calls.filter(Array.isArray).length, 1,
    'a second panel shares the same existing role reference without retaining or creating another session')

  stopRetry()
  assert.equal(listeners.size, 1, 'unmounting one pane removes only its own catalog listener')
  assert.equal(calls.includes('release'), false, 'unmounting one pane does not release the reference retained for the other pane')
  stopPending()
  assert.equal(listeners.size, 0)
  assert.equal(calls.includes('release'), false, 'scene/pane cleanup preserves the shared role scope until workbench teardown')
  exports.releaseRoleSessions()
  assert.equal(calls.filter(call => call === 'release').length, 1,
    'the workbench releases the shared native reference exactly once')

  const absentCalls = []
  const absent = {
    list: { getSnapshot() { return { phase: 'ready', ids: [], byId: {} } }, subscribe() { return () => {} } },
    retain() { absentCalls.push('retain') }, refresh() { absentCalls.push('refresh') },
  }
  const absentErrors = []
  const stopAbsent = exports.retainListedRoleSession(absent, 'center', 'missing-session', {
    onUnavailable(message) { absentErrors.push(message) },
  })
  assert.deepEqual(absentCalls, [])
  assert.match(absentErrors[0], /不会创建新会话/)
  stopAbsent()

  const retryCalls = []
  let retryReferenceCount = 0
  let retryReleaseCount = 0
  const retrySessions = {
    list: { getSnapshot() { return { phase: 'ready', ids: ['recoverable-session'], byId: { 'recoverable-session': {} } } }, subscribe() { return () => {} } },
    retain() {
      retryCalls.push('retain')
      retryReferenceCount++
      return {
        ready: retryReferenceCount === 1 ? Promise.reject(new Error('transient-open-failure')) : Promise.resolve(),
        release() { retryReleaseCount++ },
      }
    },
    async refresh() { retryCalls.push('refresh') },
  }
  const retryErrors = []
  const stopFailedOpen = exports.retainListedRoleSession(retrySessions, 'center', 'recoverable-session', {
    onUnavailable(message) { retryErrors.push(message) },
  })
  await new Promise(resolve => setImmediate(resolve))
  assert.match(retryErrors.at(-1), /暂时无法连接/)
  let retryOpened = false
  const stopRecoveredOpen = exports.retainListedRoleSession(retrySessions, 'center', 'recoverable-session', {
    refresh: true,
    onReady() { retryOpened = true },
    onUnavailable(message) { retryErrors.push(message) },
  })
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(retryCalls, ['retain', 'retain', 'refresh'],
    'refresh after an open failure retries the same session with a fresh owned reference')
  assert.equal(retryOpened, true)
  stopFailedOpen()
  stopRecoveredOpen()
  assert.equal(retryReleaseCount, 0, 'neither panel cleanup releases another panel’s still-tracked reference')
  exports.releaseRoleSessions()
  assert.equal(retryReleaseCount, 2, 'workbench teardown releases both old and retried references exactly once')
})

test('catalog notification during retain cannot synchronously acquire a role session twice', async () => {
  let registration
  runInNewContext(await readFile(sceneChunkUrl, 'utf8'), {
    window: { __ModuleLoader__: { load(value) { registration = value } } },
  })
  const exports = registration.factory(() => ({ createElement() {} }))
  const catalog = { phase: 'ready', ids: ['session-reentrant'], byId: { 'session-reentrant': {} } }
  const listeners = new Set()
  let retainCalls = 0
  const reference = { sessionId: 'session-reentrant', ready: Promise.resolve(), release() {} }
  const sessions = {
    list: {
      getSnapshot: () => catalog,
      subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener) },
    },
    retain() {
      retainCalls++
      // The production Session service synchronously updates list.byId.retainedBy
      // from retain(), so reproduce that store notification before it returns.
      for (const listener of [...listeners]) listener()
      return reference
    },
  }
  let readyCalls = 0
  const stop = exports.retainListedRoleSession(sessions, 'center', 'session-reentrant', {
    onReady(value) { assert.strictEqual(value, reference); readyCalls++ },
  })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(retainCalls, 1, 'a synchronous list notification cannot re-enter retain before acquisition completes')
  assert.equal(readyCalls, 1, 'the single acquired reference becomes ready once')
  stop()
})

test('role selection binds the AgentDirectory session response without a duplicate request', async () => {
  let registration
  let sessionPosts = 0
  const source = await readFile(sceneChunkUrl, 'utf8')
  const config = await readClientSceneConfig()
  config.sessionBindings = { center: 'session-center' }
  config.sessionBindingMetadata = { center: {
    scope: 'role', roleId: 'center', sessionId: 'session-center', workspaceId: null, archiveState: 'archived',
  } }
  const savedState = defaultSceneWorkbench(config)
  const dockLayouts = normalizeDockLayouts(config, { version: 2, scenes: {} }, savedState.layouts)
  runInNewContext(source, {
    window: { __ModuleLoader__: { load(value) { registration = value } } },
    fetch: async (url, options = {}) => {
      if (url === '/tradeloom/scenes') return { ok: true, async json() { return config } }
      if (url === '/tradeloom/scene-layouts' && (options.method ?? 'GET') === 'GET') return { ok: true, async json() { return savedState } }
      if (url === '/tradeloom/dock-layouts') return { ok: true, async json() { return dockLayouts } }
      if (url === '/tradeloom/scene-layouts') return { ok: true }
      if (url === '/tradeloom/session') { sessionPosts++; return { ok: true, async json() { return { role: 'product', sessionId: 'session-product' } } } }
      throw new Error(`unexpected request ${url}`)
    },
  })
  const React = { createElement(type, props, ...children) { return { type, props, children } }, useState: value => [typeof value === 'function' ? value() : value, () => {}], useRef: initial => ({ current: initial }), useLayoutEffect(effect) { effect() }, useEffect(effect) { effect() } }
  const exports = registration.factory(() => React)
  exports.register({ layout: { selectPanel() {} }, sessions: { retain() {} }, slots: { inject(_name, register) { register() }, register() {} }, effect() {} })
  exports.SceneTabs()
  for (let attempt = 0; attempt < 20 && !exports.getSnapshot().config; attempt++) await new Promise(resolve => setImmediate(resolve))
  assert.equal(exports.roleBindingStatus(exports.getSnapshot(), 'center').archiveState, 'archived', 'read-only scene bootstrap supplies existing-session archive metadata')
  assert.equal(await exports.selectRole('product', 'session-product', {
    scope: 'role', roleId: 'product', sessionId: 'session-product', workspaceId: null, archiveState: 'archived',
  }), true)
  assert.equal(sessionPosts, 0, 'the caller already created the session; selecting the role must bind it without another POST')
  assert.equal(exports.roleBindingStatus(exports.getSnapshot(), 'product').archiveState, 'archived')
})

test('role binding labels distinguish archived history from unknown and ignore stale metadata', async () => {
  let registration
  runInNewContext(await readFile(sceneChunkUrl, 'utf8'), {
    window: { __ModuleLoader__: { load(value) { registration = value } } },
  })
  const exports = registration.factory(() => ({ createElement() {} }))
  const state = { sessionBindings: { center: 'existing' }, sessionBindingMetadata: {} }
  assert.equal(exports.roleBindingStatus(state, 'center').archiveState, 'unknown')
  for (const archiveState of ['archived', 'unarchived', 'unknown']) {
    state.sessionBindingMetadata.center = {
      sessionId: 'existing', binding: { scope: 'role', roleId: 'center', sessionId: 'existing', workspaceId: null, archiveState },
    }
    const status = exports.roleBindingStatus(state, 'center')
    assert.equal(status.archiveState, archiveState)
    assert.equal(status.label, archiveState === 'archived' ? '▣ 已归档' : '✓ 已绑定')
    assert.doesNotMatch(status.title, /正在执行|模型可用/)
    if (archiveState === 'archived') assert.match(status.title, /显示归档/)
  }
  state.sessionBindingMetadata.center.binding.archiveState = 'archived'
  state.sessionBindings.center = 'new-session'
  assert.equal(exports.roleBindingStatus(state, 'center').archiveState, 'unknown', 'old-session archive state cannot mark a newer binding')
  state.sessionBindings.center = 'existing'
  state.sessionBindingMetadata.center.binding.sessionId = 'other-history'
  assert.equal(exports.roleBindingStatus(state, 'center').archiveState, 'unknown', 'payload identity must also match the current binding')
  state.sessionBindingMetadata.center.binding.sessionId = 'existing'
  state.sessionBindingMetadata.center.binding.roleId = 'product'
  assert.equal(exports.roleBindingStatus(state, 'center').archiveState, 'unknown', 'foreign role metadata is rejected')
  assert.equal(exports.roleBindingStatus({ sessionBindings: {} }, 'center').label, '未绑定')
})

test('model directory entries retain the directory provider/model identity for selection', async () => {
  let registration
  runInNewContext(await readFile(sceneChunkUrl, 'utf8'), {
    window: { __ModuleLoader__: { load(value) { registration = value } } },
  })
  const React = { createElement: (type, props, ...children) => ({ type, props, children }), useState: value => [value, () => {}], useEffect() {} }
  const exports = registration.factory(() => React)
  const groups = exports.modelDirectoryEntries([
    { id: 'provider-a', name: '接口 A', models: [{ id: 'model-a', name: '模型 A' }] },
    { id: 'provider-b', name: '接口 B', models: [{ id: 'model-b', name: '模型 B' }] },
  ])
  assert.deepEqual(groups.map(group => [group.provider, group.models.map(model => model.id)]), [
    ['provider-a', ['model-a']], ['provider-b', ['model-b']],
  ])
  assert.deepEqual(['接口 A', '接口 B', 'DeepSeek API', '织贸助手', ''].map(exports.providerBadgeLabel), ['A', 'B', 'D', '织', '模'],
    'provider badges use the first visible ASCII identifier when present and retain a readable Unicode fallback')
  assert.equal(exports.currentModelLabel({ provider: 'provider-a', model: 'model-a' }, groups), '接口 A · 模型 A')
  assert.equal(exports.currentModelLabel({ provider: 'removed-provider', model: 'secret-raw-id' }, groups), '已选择模型',
    'the rail must never fall back to exposing provider or model identifiers')
  const config = await readClientSceneConfig()
  const railSnapshot = { config, activeSceneId: 'center', sessionBindings: { center: 'session-center' } }
  const directoryInfo = {
    key: JSON.stringify(['center', 'session-center']), status: 'ready', snapshot: {
      groups: [{ id: 'provider-a', name: '接口 A', models: [{ id: 'model-a', name: '模型 A' }] }],
      current: { provider: 'provider-a', model: 'model-a' },
    }, error: '',
  }
  let hookIndex = 0
  const railReact = {
    createElement(type, props, ...children) { return { type, props: props ?? {}, children } },
    useState() { return [[railSnapshot, directoryInfo, ''][hookIndex++], () => {}] },
    useEffect() {},
  }
  const rail = registration.factory(() => railReact).ModelDirectoryRail()
  const findNodes = (node, predicate, result = []) => {
    if (Array.isArray(node)) for (const child of node) findNodes(child, predicate, result)
    else if (node && typeof node === 'object') {
      if (predicate(node)) result.push(node)
      findNodes(node.children, predicate, result)
    }
    return result
  }
  const providerSummary = findNodes(rail, node => node.type === 'summary')[0]
  const modelOption = findNodes(rail, node => node.type === 'button' && node.props.title === '接口 A · 模型 A')[0]
  assert.equal(providerSummary.children[0], 'A', 'provider controls use a distinguishable ASCII initial instead of a repeated Chinese initial')
  assert.equal(providerSummary.props['aria-label'], '接口 A模型列表')
  assert.equal(providerSummary.props.title, '接口 A')
  assert.equal(findNodes(rail, node => node.type === 'strong')[0].children[0], '接口 A', 'the open provider menu retains the complete provider name')
  assert.equal(modelOption.props['aria-label'], '选择接口 A的模型 A')
  const currentModel = findNodes(rail, node => node.props?.className === 'tl-model-current')[0]
  assert.equal(currentModel.children[0], '接口 A · 模型 A')
  assert.equal(currentModel.props.title, '接口 A · 模型 A')
  assert.deepEqual(config.roles.map(role => [role.id, role.assistantLabel]), [
    ['center', '中心助手'], ['product', '商品助手'], ['market', '市场助手'],
    ['quote', '询报价助手'], ['delivery', '交付助手'], ['user-profile', '资料助手'],
  ], 'role metadata keeps the original native conversation titles as a separate display field')
  assert.equal(exports.assistantLabel('delivery', config), '交付助手')
  assert.deepEqual(JSON.parse(JSON.stringify(exports.bindSession({ product: 'session-product' }, 'delivery', 'session-delivery', config))), {
    product: 'session-product', delivery: 'session-delivery',
  })
})

test('appearance control follows an asynchronous DSH preference update', async () => {
  let registration
  runInNewContext(await readFile(sceneChunkUrl, 'utf8'), {
    window: { __ModuleLoader__: { load(value) { registration = value } } },
  })
  let preference = 'system'
  let colorScheme = 'light'
  const themeListeners = new Map()
  const selected = []
  const theme = {
    getTheme: () => ({ preference, active: { colorScheme } }),
    setTheme(next) {
      selected.push(next)
      setTimeout(() => {
        preference = next
        colorScheme = next === 'dark' ? 'dark' : 'light'
        themeListeners.get('theme/change')?.(theme.getTheme())
      }, 2)
    },
  }
  const hookValues = []
  let hookIndex = 0
  const React = {
    createElement(type, props, ...children) { return { type, props: props ?? {}, children } },
    useState(initial) {
      const values = [
        { config: null, activeSceneId: 'center', sessionBindings: {} },
        { key: '', status: 'idle', snapshot: null, error: '' },
        '',
      ]
      const index = hookIndex++
      if (hookValues[index] === undefined) hookValues[index] = index < values.length ? values[index] : initial
      return [hookValues[index], value => { hookValues[index] = typeof value === 'function' ? value(hookValues[index]) : value }]
    },
    useEffect() {},
  }
  const exports = registration.factory(() => React)
  exports.register({
    theme,
    slots: { inject(_name, register) { register() }, register() {} },
    on(name, listener) { themeListeners.set(name, listener); return () => themeListeners.delete(name) },
    effect() {},
  })
  const findNode = (node, predicate) => {
    if (Array.isArray(node)) return node.map(item => findNode(item, predicate)).find(Boolean)
    if (!node || typeof node !== 'object') return undefined
    if (predicate(node)) return node
    return node.children?.map(child => findNode(child, predicate)).find(Boolean)
  }
  const rail = exports.ModelDirectoryRail()
  const themeButton = findNode(rail, node => node.props?.className === 'tl-theme-cycle')
  themeButton.props.onClick()
  await new Promise(resolve => setTimeout(resolve, 10))

  assert.deepEqual(selected, ['dark'])
  assert.equal(preference, 'dark')
  assert.equal(colorScheme, 'dark')
  hookIndex = 0
  const updatedRail = exports.ModelDirectoryRail()
  const updatedThemeButton = findNode(updatedRail, node => node.props?.className === 'tl-theme-cycle')
  assert.equal(updatedThemeButton.props['aria-label'], '当前外观：深色，切换到跟随系统')
  assert.match(findNode(updatedRail, node => node.props?.className?.includes('tl-model-rail'))
    .props.className, /is-dark/)

})

test('model directory rail refreshes a pending native catalog before retaining its hydrated role session', async () => {
  let registration
  const config = await readClientSceneConfig()
  config.sessionBindings = { center: 'existing-center-session' }
  const savedSceneState = defaultSceneWorkbench(config)
  const dockLayouts = normalizeDockLayouts(config, { version: 2, scenes: {} }, savedSceneState.layouts)
  const fetchCalls = []
  const React = {
    createElement(type, props, ...children) { return { type, props: props ?? {}, children } },
    useState(initial) { return [typeof initial === 'function' ? initial() : initial, () => {}] },
    useEffect(effect) { effects.push(effect) },
  }
  const effects = []
  let catalog = { phase: 'pending', ids: [], byId: {} }
  const listListeners = new Set()
  const retainCalls = []
  const directoryCalls = []
  const directoryStore = {
    getSnapshot() { return { groups: [], current: null } },
    subscribe() { return () => {} },
  }
  const reference = { ready: Promise.resolve(), release() {} }
  let finishRefresh
  const sessions = {
    list: {
      getSnapshot() { return catalog },
      subscribe(listener) { listListeners.add(listener); return () => listListeners.delete(listener) },
    },
    retain(sessionId, options) { retainCalls.push([sessionId, options]); return reference },
    refresh() {
      return new Promise(resolve => {
        finishRefresh = () => {
          catalog = { phase: 'ready', ids: ['existing-center-session'], byId: { 'existing-center-session': {} } }
          for (const listener of [...listListeners]) listener()
          resolve()
        }
      })
    },
  }
  runInNewContext(await readFile(sceneChunkUrl, 'utf8'), {
    window: { __ModuleLoader__: { load(value) { registration = value } } },
    fetch: async (url, options = {}) => {
      fetchCalls.push([url, options.method ?? 'GET'])
      if (url === '/tradeloom/scenes') return { ok: true, async json() { return config } }
      if (url === '/tradeloom/scene-layouts') return { ok: true, async json() { return savedSceneState } }
      if (url === '/tradeloom/dock-layouts') return { ok: true, async json() { return dockLayouts } }
      throw new Error(`unexpected request ${url}`)
    },
  })
  const exports = registration.factory(() => React)
  exports.register({
    sessions,
    modelDirectories: { directoryFor(sessionId) {
      directoryCalls.push(sessionId)
      return { store: directoryStore, async load() {} }
    } },
    slots: { inject(_name, register) { register() }, register() {} },
    theme: { getTheme() { return { preference: 'system', active: { colorScheme: 'light' } } } },
  })
  await exports.retryLoadConfig()
  effects.length = 0
  exports.ModelDirectoryRail()
  const effectCleanups = effects.map(effect => effect())
  const cleanup = () => effectCleanups.forEach(stop => stop?.())
  assert.deepEqual(retainCalls, [], 'the rail does not retain while the native session catalog is pending')
  assert.equal(typeof finishRefresh, 'function', 'the rail starts one read-only catalog refresh on mount')
  finishRefresh()
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(JSON.parse(JSON.stringify(retainCalls)), [['existing-center-session', { source: 'tradeloomRoleWidget' }]])
  assert.deepEqual(directoryCalls, ['existing-center-session'], 'the directory opens only after the existing bound id appears in the ready catalog')
  assert.equal(fetchCalls.some(([url, method]) => url === '/tradeloom/session' && method === 'POST'), false,
    'warming the directory never creates or replaces the persisted session')
  cleanup()
  exports.releaseRoleSessions()
})

test('model directory diagnostics expose only a safe phase and allowlisted failure category', async () => {
  let registration
  runInNewContext(await readFile(sceneChunkUrl, 'utf8'), {
    window: { __ModuleLoader__: { load(value) { registration = value } } },
  })
  const exports = registration.factory(() => ({ createElement() {} }))

  assert.deepEqual(JSON.parse(JSON.stringify(exports.modelDirectoryDiagnostic(
    'directoryFor', new Error('ui-model-selection: session "private-session-id" resolved no scope'),
  ))), {
    phase: 'directoryFor', reason: 'missingScope', error: '模型目录暂时无法加载，请重新打开工作台或检查模型配置。',
  })
  assert.deepEqual(JSON.parse(JSON.stringify(exports.modelDirectoryDiagnostic(
    'directoryFor', new Error('ui-model-selection: session "private-session-id" resolved no binding'),
  ))), {
    phase: 'directoryFor', reason: 'missingBinding', error: '模型目录暂时无法加载，请重新打开工作台或检查模型配置。',
  })
  assert.deepEqual(JSON.parse(JSON.stringify(exports.modelDirectoryDiagnostic(
    'directoryFor', new Error("Cannot read properties of undefined (reading 'directoryFor')"),
  ))), {
    phase: 'directoryFor', reason: 'missingInjected:modelDirectories',
    error: '模型目录暂时无法加载，请重新打开工作台或检查模型配置。',
  })
  assert.equal(exports.modelDirectoryDiagnostic('retain', new Error('cannot get property "sessions" without inject')).reason, 'missingInjected:sessions')
  assert.equal(exports.modelDirectoryDiagnostic('ready', new Error('cannot get property "remote.session" without inject')).reason, 'missingInjected:remote.session')
  assert.equal(exports.modelDirectoryDiagnostic('ready', new Error('cannot get property "authorization" without inject')).reason, 'unavailable')
  const remoteFailure = exports.modelDirectoryDiagnostic('load', new Error('secret URL and credential text'))
  assert.deepEqual(JSON.parse(JSON.stringify(remoteFailure)), {
    phase: 'load', reason: 'unavailable', error: '模型目录暂时无法加载，请重新打开工作台或检查模型配置。',
  })
  assert.equal(JSON.stringify(remoteFailure).includes('secret URL'), false)
})

test('model directory failure renders an accessible stage diagnostic without exposing the exception', async t => {
  const reactPath = process.env.TRADELOOM_REACT_LIBRARY
  const serverPath = process.env.TRADELOOM_REACT_SERVER_LIBRARY
  if (!reactPath || !serverPath) return t.skip('set candidate7 React library paths to render the real React component')
  const { createRequire } = await import('node:module')
  const React = createRequire(import.meta.url)(reactPath)
  const renderToStaticMarkup = createRequire(import.meta.url)(serverPath).renderToStaticMarkup
  let registration
  runInNewContext(await readFile(sceneChunkUrl, 'utf8'), {
    React,
    window: { __ModuleLoader__: { load(value) { registration = value } } },
  })
  const exports = registration.factory(() => React)
  const diagnostic = exports.modelDirectoryDiagnostic(
    'ready', new Error('cannot get property "remote.session" without inject'),
  )
  const markup = renderToStaticMarkup(React.createElement(exports.ModelDirectoryFailure, { diagnostic }))
  assert.match(markup, /role="status"/)
  assert.match(markup, /data-model-directory-phase="ready"/)
  assert.match(markup, /data-model-directory-error="missingInjected:remote\.session"/)
  assert.match(markup, /模型目录暂时无法加载，请重新打开工作台或检查模型配置。/)
  assert.doesNotMatch(markup.replace(/<[^>]+>/g, ''), /missingInjected:remote\.session/)
  assert.doesNotMatch(markup, /without inject/)
})

test('client entry loads the registered scene chunk and preserves the existing shell slots', async () => {
  const entrySource = await readFile(new URL('../client.js', import.meta.url), 'utf8')
  let entryRegistration
  runInNewContext(entrySource, { window: { __ModuleLoader__: { load(value) { entryRegistration = value } } } })
  let chunkRegistration
  runInNewContext(await readFile(sceneChunkUrl, 'utf8'), { window: { __ModuleLoader__: { load(value) { chunkRegistration = value } } } })
  const React = {
    createElement: (type, props, ...children) => ({ type, props, children }),
    useState: initial => [typeof initial === 'function' ? initial() : initial, () => {}],
    useRef: initial => ({ current: initial }),
    useEffect() {},
  }
  const chunk = chunkRegistration.factory(name => { assert.equal(name, 'react'); return React })
  const calls = []
  const slots = {
    inject(name, register) { calls.push({ name, result: register() }) },
    register(spec, component) { calls.push({ spec, component }); return () => {} },
  }
  const entryRequire = name => {
    if (name === 'react') return React
    if (name === 'react-dom') return { createPortal: child => child }
    assert.fail(`unexpected entry dependency: ${name}`)
  }
  entryRequire.async = async name => { assert.equal(name, './client.scenes.js'); return chunk }
  const plugin = entryRegistration.factory(entryRequire)
  await plugin.apply({ slots, layout: { selectPanel() {} }, uiWorkspace: { openSession() {} } })
  assert.ok(calls.some(call => call.spec?.name === 'shell.top'), 'business and scene navigation must keep the existing top slot')
  assert.ok(calls.some(call => call.spec?.key === 'scene-workbench'), 'scene grid must register as a native main panel')
  assert.ok(calls.some(call => call.spec?.key === 'business-home'), 'existing business panels must remain registered')
  assert.equal(calls.some(call => call.spec?.name === 'sidebar.agents'), false, 'the Agent list must not occupy the conversation sidebar')
  const top = calls.find(call => call.spec?.name === 'shell.top').component({ usePanelInfo: () => ({}) })
  const findAgentSelector = node => {
    if (!node || typeof node !== 'object') return undefined
    if (node.type?.name === 'AgentDirectory') return node
    for (const child of node.children ?? []) {
      const found = Array.isArray(child) ? child.map(findAgentSelector).find(Boolean) : findAgentSelector(child)
      if (found) return found
    }
  }
  assert.ok(findAgentSelector(top), 'the existing AgentDirectory component must be reused in the top model row')
  const modelRow = (function find(node) {
    if (!node || typeof node !== 'object') return undefined
    if (node.props?.className === 'tl-top-model-row') return node
    for (const child of node.children ?? []) {
      const found = Array.isArray(child) ? child.map(find).find(Boolean) : find(child)
      if (found) return found
    }
  })(top)
  assert.ok(modelRow, 'the compact helper chooser and website rail share the first top row')
  assert.equal(modelRow.children[0].props.className, 'tl-shell-brand', 'the real TradeLoom identity leads the provider controls')
  assert.equal(modelRow.children[1].type.name, 'NativeWindowsMenuSlot', 'the original Windows Applications/Edit menu gets a compact slot beside the brand')
  assert.equal(modelRow.children[2].type.name, 'AgentDirectory', 'the helper selector stays to the left of website controls')
  assert.equal(modelRow.children[3].type.name, 'AIWebRail')
  const websiteRail = modelRow.children[3].type()
  const railStyle = websiteRail.children.find(child => child?.props?.['data-tradeloom-navigation-style'])
  const websiteStyle = websiteRail.children.find(child => child?.props?.['data-tradeloom-ai-web-style'])
  assert.match(websiteStyle.children[0], /\.tl-ai-web-rail\s*\{[\s\S]*display:\s*flex;\s*flex:\s*1 1 0/,
    'the website rail fills remaining space so theme and tools stay aligned at the far right')
  assert.match(railStyle.children[0], /\.tl-navigation \.tl-scene-tab\[aria-current="page"\]\s*\{[^}]*box-shadow:/,
    'the selected work scene keeps a restrained accent glow as a visible selected state')
  const inactiveLabelRule = railStyle.children[0].match(/\.tl-navigation \.tl-scene-tab-label\s*\{([^}]+)\}/)?.[1]
  assert.ok(inactiveLabelRule, 'scene labels retain a shared rule at every viewport width')
  assert.match(inactiveLabelRule, /max-width:\s*0\s*;/, 'inactive scene labels collapse beside their icons')
  assert.match(inactiveLabelRule, /overflow:\s*hidden\s*;/, 'collapsed labels cannot spill into adjacent scene controls')
  assert.match(inactiveLabelRule, /opacity:\s*0\s*;/, 'inactive scene labels are visually hidden')
  const activeLabelRule = railStyle.children[0].match(/\.tl-navigation \.tl-scene-tab\[aria-current="page"\] \.tl-scene-tab-label\s*\{([^}]+)\}/)?.[1]
  assert.ok(activeLabelRule, 'the accessible current-page state controls the expanded label')
  assert.match(activeLabelRule, /max-width:\s*(?!0(?:\s|;))[^;]+;/, 'the active scene has room for its label')
  assert.match(activeLabelRule, /opacity:\s*1\s*;/, 'the active scene label remains visible at wide and compact widths')
  assert.match(railStyle.children[0], /\.tl-theme-toggle\s*\{[^}]*margin-left:\s*auto/)
})

test('client entry passes the real Cordis context through to scene registration', { skip: !process.env.TRADELOOM_CORDIS_LIBRARY }, async () => {
  const cordisPath = process.env.TRADELOOM_CORDIS_LIBRARY.replaceAll('\\', '/')
  const { Context } = await import(pathToFileURL(cordisPath).href)
  const ctx = new Context()
  const registrations = []
  const selectedPanels = []
  const openedSessions = []
  const retainedSessions = []
  const releasedSessions = []
  const sessions = {
    retain(sessionId, options) {
      const reference = { sessionId, ready: Promise.resolve(), release() { releasedSessions.push(sessionId) } }
      retainedSessions.push({ sessionId, options, reference })
      return reference
    },
  }
  const remoteSession = { modelCatalog() { return Promise.resolve({ groups: [] }) } }
  const remotePluginInventory = { async list() { return { ok: true, value: { entries: [] } } } }
  const theme = { getTheme() { return { preference: 'system', active: { colorScheme: 'light' } } }, setTheme() {} }
  const documentListeners = []
  const businessOrigin = 'http://127.0.0.1:3088'
  const layout = { selectPanel(...args) { selectedPanels.push(args) } }
  const uiWorkspace = { openSession(...args) { openedSessions.push(args) } }
  const slots = {
    inject(_name, register) { register() },
    register(spec, component) { registrations.push({ type: 'slot', spec, component }); return () => {} },
  }
  const services = await ctx.registry.plugin({
    name: 'tradeloom-scene-regression-services', inject: [],
    apply(serviceCtx) {
      serviceCtx.reflect.provide('slots', slots)
      serviceCtx.reflect.provide('layout', layout)
      serviceCtx.reflect.provide('uiWorkspace', uiWorkspace)
      serviceCtx.reflect.provide('sessions', sessions)
      serviceCtx.reflect.provide('modelDirectories', { directoryFor() { throw new Error('not used in this test') } })
      serviceCtx.reflect.provide('remote', { session: remoteSession, pluginInventory: remotePluginInventory })
      serviceCtx.reflect.provide('remote.session', remoteSession)
      serviceCtx.reflect.provide('remote.pluginInventory', remotePluginInventory)
      serviceCtx.reflect.provide('locale', { resolveText: text => typeof text === 'string' ? text : text.zh || text.en })
      serviceCtx.reflect.provide('theme', theme)
    },
  })

  const React = {
    createElement: (type, props, ...children) => ({ type, props, children }),
    useState: initial => [initial, value => stateUpdates.push(typeof value === 'function' ? value(initial) : value)],
    useRef: initial => ({ current: initial }),
    useEffect(effect) { effect() },
    useLayoutEffect(effect) { effect() },
  }
  const stateUpdates = []
  const entrySource = await readFile(new URL('../client.js', import.meta.url), 'utf8')
  const chunkSource = await readFile(sceneChunkUrl, 'utf8')
  let entryRegistration
  runInNewContext(entrySource, {
    URL, URLSearchParams,
    window: { document: { addEventListener(...args) { documentListeners.push(args) }, removeEventListener() {} }, __ModuleLoader__: { load(value) { entryRegistration = value } } },
  })
  let chunkRegistration
  const config = { ...(await readClientSceneConfig()), businessOrigin }
  const layoutState = {
    version: 1, activeSceneId: 'center',
    roleByScene: Object.fromEntries(config.scenes.map(scene => [scene.id, scene.roleId])),
    businessPath: '/home',
    layouts: Object.fromEntries(config.scenes.map(scene => [scene.id, { expandedPanel: '', panels: {} }])),
  }
  const defaultDockState = normalizeDockLayouts(config, { version: 2, scenes: {} }, defaultSceneWorkbench(config).layouts)
  const fetchRequests = []
  const fetch = async (url, options = {}) => {
    fetchRequests.push([url, options.method ?? 'GET', options.body])
    if (url === '/tradeloom/scenes') return { ok: true, async json() { return config } }
    if (url === '/tradeloom/scene-layouts' && (options.method ?? 'GET') === 'GET') return { ok: true, async json() { return layoutState } }
    if (url === '/tradeloom/scene-layouts') return { ok: true }
    if (url === '/tradeloom/dock-layouts' && (options.method ?? 'GET') === 'GET') return { ok: true, async json() { return defaultDockState } }
    if (url === '/tradeloom/dock-layouts' && options.method === 'PUT') return { ok: true, async json() { return defaultDockState } }
    if (url === '/tradeloom/session') {
      const role = JSON.parse(options.body).role
      return { ok: true, async json() { return { role, sessionId: `cordis-${role}-session` } } }
    }
    throw new Error(`unexpected scene request ${url}`)
  }
  runInNewContext(chunkSource, { fetch, window: { __ModuleLoader__: { load(value) { chunkRegistration = value } } } })
  let sceneExports
  const clientRequire = name => {
    if (name === 'react') return React
    if (name === 'react-dom') return { createPortal: child => child }
    assert.fail(`unexpected entry dependency: ${name}`)
  }
  clientRequire.async = async name => {
    assert.equal(name, './client.scenes.js')
    sceneExports = chunkRegistration.factory(clientRequire)
    return sceneExports
  }
  const client = entryRegistration.factory(clientRequire)
  assert.ok(client.inject.includes('remote') && client.inject.includes('remote.session'),
    'the shell root must declare its native model-directory remote dependencies')
  const clientFiber = ctx.registry.plugin({
    name: 'tradeloom-business-shell-client-test',
    inject: client.inject,
    apply(clientContext) {
      assert.strictEqual(clientContext.remote.session, remoteSession,
        'the root shell context can access the native model catalog dependency on first entry')
      assert.strictEqual(clientContext.remote.pluginInventory, remotePluginInventory,
        'the root shell declares and can resolve the existing plugin inventory Remote')
      return client.apply(clientContext)
    },
  })
  await clientFiber
  assert.deepEqual(selectedPanels, [['scene-workbench']], 'the first client load selects the formal workbench before an old full-screen conversation is restored')

  assert.ok(registrations.some(item => item.type === 'slot' && item.spec.key === 'scene-workbench'),
    'the real scene register must resolve injected ctx.slots and register its panel')
  assert.ok(sceneExports, 'the actual client scene chunk must load through require.async')
  assert.equal(typeof sceneExports.SceneTabs, 'function')
  sceneExports.SceneTabs()
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(fetchRequests.slice(0, 2).map(([url]) => url), ['/tradeloom/scenes', '/tradeloom/scene-layouts'], 'the scene tab loads its config and saved layout')
  await sceneExports.retryLoadConfig()
  assert.deepEqual(sceneExports.getSnapshot().config.roles, publicRoleMetadata(), 'the live Cordis scene context loaded safe role metadata')
  const tabs = sceneExports.SceneTabs()
  assert.deepEqual(documentListeners.map(([eventName]) => eventName), ['load', 'click'],
    `the scene chunk must receive the callback after config loads: ${JSON.stringify(tabs)}`)
  assert.ok(registrations.some(item => item.type === 'slot' && item.spec.key === 'business-home'),
    'the existing client entry remains active under the same Cordis service context')

  const visit = (node, predicate) => {
    if (!node || typeof node !== 'object') return undefined
    if (predicate(node)) return node
    for (const child of node.children ?? []) {
      const found = Array.isArray(child) ? child.map(item => visit(item, predicate)).find(Boolean) : visit(child, predicate)
      if (found) return found
    }
  }
  const profileTab = visit(tabs, node => node.type === 'button' && node.props?.['aria-label'] === '资料整理')
  profileTab.props.onClick()
  assert.deepEqual(selectedPanels, [['scene-workbench'], ['scene-workbench']], 'the injected layout service selects the existing scene panel')

  assert.equal(registrations.some(item => item.type === 'slot' && item.spec.name === 'sidebar.agents'), false,
    'role selection must leave the original sidebar history area available')
  assert.equal(await sceneExports.selectRole('product'), true, 'the registered scene context can switch the active scene role')
  assert.deepEqual(fetchRequests.filter(([url, method]) => url === '/tradeloom/session' && method === 'POST').map(([, , body]) => JSON.parse(body).role), ['product'], 'scene role selection creates exactly one session')
  assert.deepEqual(selectedPanels, [['scene-workbench'], ['scene-workbench'], ['scene-workbench']], 'scene and Agent navigation keep the workbench selected')
  assert.deepEqual(retainedSessions, [], 'selecting a role does not retain another scope before its scene mounts')
  assert.deepEqual(releasedSessions, [])
  assert.equal(openedSessions.length, 0, 'role selection no longer opens the full-screen conversation panel')

  sceneExports.retainRoleSession(sessions, 'product', 'cordis-product-session')
  sceneExports.retainRoleSession(sessions, 'center', 'cordis-center-session')
  assert.deepEqual(retainedSessions.map(item => item.sessionId), ['cordis-product-session', 'cordis-center-session'])
  assert.ok(clientFiber.ctx.fiber.getEffects().some(effect => effect?.label === 'tradeloom scene workbench role sessions'),
    'Cordis owns the workbench session-release cleanup on the client plugin fiber')

  const themeRevisionBeforeDispose = sceneExports.getSnapshot().themeRevision ?? 0
  await clientFiber.dispose()
  assert.equal(clientFiber.ctx.fiber.uid, null, 'Cordis plugin fiber is disposed')
  clientFiber.ctx.emit('theme/change', { active: { colorScheme: 'dark' } })
  assert.equal(sceneExports.getSnapshot().themeRevision ?? 0, themeRevisionBeforeDispose,
    'Cordis automatically removes theme listeners owned by the disposed plugin fiber')
  assert.deepEqual(releasedSessions, ['cordis-product-session', 'cordis-center-session'], 'disposing the Cordis plugin releases every retained role scope')
  await services.dispose()
})

test('scene client forwards the server-reported business origin only after loading scene config', async () => {
  let registration
  const chunkSource = await readFile(sceneChunkUrl, 'utf8')
  const React = {
    createElement: (type, props, ...children) => ({ type, props, children }),
    useState: initial => [initial, () => {}],
    useRef: initial => ({ current: initial }),
    useEffect(effect) { effect() },
    useLayoutEffect() {},
  }
  const businessOrigin = 'http://192.168.1.23:3088'
  const config = await readClientSceneConfig()
  config.businessOrigin = businessOrigin
  const savedState = defaultSceneWorkbench(config)
  const dockLayouts = normalizeDockLayouts(config, { version: 2, scenes: {} }, savedState.layouts)
  runInNewContext(chunkSource, {
    window: { __ModuleLoader__: { load(value) { registration = value } } },
    fetch: async url => ({ ok: true, async json() {
      if (url === '/tradeloom/scenes') return config
      if (url === '/tradeloom/scene-layouts') return savedState
      if (url === '/tradeloom/dock-layouts') return dockLayouts
      throw new Error(`unexpected request ${url}`)
    } }),
  })
  const origins = []
  const roleUpdates = []
  const exports = registration.factory(() => React)
  exports.register({
    layout: { selectPanel() {} }, uiWorkspace: { openSession() {} },
    slots: { inject(_name, register) { register() }, register() { return () => {} } },
  }, value => origins.push(value), roles => roleUpdates.push(roles))
  exports.SceneTabs()
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(origins, [businessOrigin])
  assert.deepEqual(JSON.parse(JSON.stringify(roleUpdates.at(-1))), {
    status: 'ready', error: '', roles: publicRoleMetadata(),
  }, 'the existing scenes request supplies loading state and safe role display metadata')
})

test('embedded empty-session composer docks below its stable session slot anchor', { skip: !process.env.TRADELOOM_DOM_TEST_ROOT }, async () => {
  const domPath = `${process.env.TRADELOOM_DOM_TEST_ROOT.replaceAll('\\', '/')}/node_modules/jsdom/lib/api.js`
  const { JSDOM } = await import(pathToFileURL(domPath).href)
  const source = await readFile(sceneChunkUrl, 'utf8')
  const rule = source.match(/(\.tl-dock-panel-body\.is-native-chat\s+\[data-content-phase="active"\]\s+\[data-conversation-scroll\]\s*>\s*\[data-slot="conversation\.session"\]:not\(:has\(\[data-slot="conversation\.view"\]\)\)\s*\+\s*\[data-composer-seat\])\s*\{\s*margin-block-start:\s*auto;\s*\}/)
  assert.ok(rule, 'embedded-only styling targets the empty native session slot, not a DOM-only-child assumption')

  const marginFor = viewMarkup => {
    const dom = new JSDOM(`<style>${rule[0]}</style><div class="tl-dock-panel-body is-native-chat"><div data-content-phase="active"><div data-conversation-scroll><div data-slot="conversation.session" style="display:contents">${viewMarkup}</div><div data-composer-seat></div></div></div></div>`)
    const seat = dom.window.document.querySelector('[data-composer-seat]')
    return dom.window.getComputedStyle(seat).marginBlockStart
  }
  assert.equal(marginFor(''), 'auto', 'a blank session keeps its stable empty slot anchor while the composer seat receives the free space')
  assert.notEqual(marginFor('<div data-slot="conversation.view"></div>'), 'auto', 'sessions with a conversation view keep their existing active transcript/composer flow')
})

test('business and scene navigation share the single rendered shell.top occupant', async () => {
  const entrySource = await readFile(new URL('../client.js', import.meta.url), 'utf8')
  const topSlotPatch = await readFile(new URL('../../../integrations/dsh/patches/ui-layout-shell-top.patch', import.meta.url), 'utf8')
  assert.match(topSlotPatch, /\+\s+'shell\.top': \{ kind: 'single'; scope: 'root' \}/)
  assert.match(topSlotPatch, /renderSlot\('shell\.top', \{\}\)/)
  let entryRegistration
  runInNewContext(entrySource, { window: { __ModuleLoader__: { load(value) { entryRegistration = value } } } })
  let chunkRegistration
  runInNewContext(await readFile(sceneChunkUrl, 'utf8'), { window: { __ModuleLoader__: { load(value) { chunkRegistration = value } } } })
  const hookValues = []
  let hookIndex = 0
  const React = {
    createElement: (type, props, ...children) => ({ type, props, children }),
    useState(initial) {
      const index = hookIndex++
      if (!(index in hookValues)) hookValues[index] = initial
      return [hookValues[index], next => { hookValues[index] = typeof next === 'function' ? next(hookValues[index]) : next }]
    },
    useRef(initial) { const index = hookIndex++; return hookValues[index] ??= { current: initial } },
    useEffect() {},
    useLayoutEffect() {},
  }
  const chunk = chunkRegistration.factory(() => React)
  const calls = []
  let nativeSettingsOpen = false
  const settingsStore = { getSnapshot: () => ({ open: nativeSettingsOpen }),
    actions: { open() { nativeSettingsOpen = true }, close() { nativeSettingsOpen = false } } }
  const slots = {
    entries: name => name === 'sidebar.settings' ? [{ store: { create: () => settingsStore } }] : [],
    inject(_name, register) { register() },
    register(spec, component) {
      if (spec.name === 'shell.top' && calls.some(call => call.spec.name === 'shell.top')) {
        throw new Error('single slot shell.top already has an occupant')
      }
      calls.push({ spec, component })
      return () => {}
    },
  }
  const entryRequire = name => {
    if (name === 'react') return React
    if (name === 'react-dom') return { createPortal: child => child }
    assert.fail(`unexpected entry dependency: ${name}`)
  }
  entryRequire.async = async name => { assert.equal(name, './client.scenes.js'); return chunk }
  const plugin = entryRegistration.factory(entryRequire)
  const layoutCalls = []
  const layout = { selectPanel(id) { layoutCalls.push(['panel', id]) }, toggleSidebar() { layoutCalls.push(['sidebar']) } }
  await plugin.apply({ slots, layout, uiWorkspace: { openSession() {} } })

  const top = calls.filter(call => call.spec.name === 'shell.top')
  assert.equal(top.length, 1)
  const tree = top[0].component({ usePanelInfo: () => ({}) })
  const componentNames = []
  const visit = node => { if (!node || typeof node !== 'object') return; if (typeof node.type === 'function') componentNames.push(node.type.name); for (const child of node.children ?? []) Array.isArray(child) ? child.forEach(visit) : visit(child) }
  visit(tree)
  assert.ok(componentNames.includes('BusinessMenu'))
  assert.ok(componentNames.includes('ShellToolsMenu'), 'utility actions live in the compact first row')
  const findNode = (node, predicate) => {
    if (!node || typeof node !== 'object') return undefined
    if (predicate(node)) return node
    for (const child of node.children ?? []) {
      const found = Array.isArray(child) ? child.map(item => findNode(item, predicate)).find(Boolean) : findNode(child, predicate)
      if (found) return found
    }
  }
  const toolsElement = findNode(tree, node => node?.type?.name === 'ShellToolsMenu')
  assert.ok(toolsElement)
  hookValues.length = 0
  hookIndex = 0
  let toolsTree = toolsElement.type()
  const settingsButton = findNode(toolsTree, node => node.props?.['aria-label'] === '打开原生设置')
  settingsButton.props.onClick()
  assert.equal(nativeSettingsOpen, true)
  settingsButton.props.onClick()
  assert.equal(nativeSettingsOpen, false, 'the same top-level settings control closes the existing native modal')
  const trigger = findNode(toolsTree, node => node?.type === 'button' && node.props?.['aria-label'] === '打开工具菜单')
  assert.equal(trigger.props['aria-label'], '打开工具菜单')
  trigger.props.onClick()
  hookIndex = 0
  toolsTree = toolsElement.type()
  const menu = findNode(toolsTree, node => node?.props?.role === 'group')
  const actions = menu.children.filter(node => node?.type === 'button')
  assert.ok(actions.some(node => node.children.includes('刷新场景配置')), 'scene configuration refresh stays in the utility menu')
  const pluginAction = actions.find(node => node.children.includes('插件管理'))
  assert.ok(pluginAction, 'plugin inventory remains in the shell tools menu')
  const beforePluginOverview = layoutCalls.length
  pluginAction.props.onClick()
  hookIndex = 0
  const pluginOverview = findNode(toolsElement.type(), node => node.type?.name === 'PluginInventoryOverview')
  assert.ok(pluginOverview, 'plugin management first opens the compact read-only overview')
  assert.equal(layoutCalls.length, beforePluginOverview, 'the compact overview does not replace the current workbench panel')
  pluginOverview.props.onClose()
  for (const [label, expected] of [['返回工作台', ['panel', 'scene-workbench']], ['自动化', ['panel', 'schedules']], ['切换会话侧栏', ['sidebar']]]) {
    const action = actions.find(node => node.children.includes(label))
    assert.ok(action, `${label} is present in the shell tools menu`)
    action.props.onClick()
    assert.deepEqual(layoutCalls.at(-1), expected)
  }
  hookIndex = 0
  const workbenchTools = toolsElement.type({ workbenchActive: true })
  findNode(workbenchTools, node => node?.type === 'button' && node.props?.['aria-label'] === '打开工具菜单').props.onClick()
  hookIndex = 0
  const openedWorkbenchTools = toolsElement.type({ workbenchActive: true })
  const workbenchMenu = findNode(openedWorkbenchTools, node => node?.props?.role === 'group')
  const workbenchSidebarAction = workbenchMenu.children.find(node => node?.type === 'button' && node.children.includes('切换会话侧栏'))
  assert.ok(workbenchSidebarAction, 'the native sidebar toggle stays available in workbench mode')
  workbenchSidebarAction.props.onClick()
  assert.deepEqual(layoutCalls.at(-1), ['sidebar'], 'workbench mode uses the existing Host sidebar toggle contract')
  const menuElement = tree.children.find(node => node?.type?.name === 'BusinessMenu')
  assert.equal(menuElement.props.SceneTabs, chunk.SceneTabs, 'scene controls are rendered inside the existing business navigation owner')
  const menuTree = menuElement.type({ ...menuElement.props, usePanelInfo: () => ({}) })
  const conversationEntry = menuTree.children.find(child => child?.props?.className === 'tl-conversation-entry')
  assert.ok(conversationEntry, 'the native conversation entry is explicit in the secondary navigation row')
  assert.equal(conversationEntry.props.disabled, true, 'an unavailable conversation entry cannot act as an empty button')
  assert.equal(conversationEntry.props['aria-label'], '当前助手尚未连接，无法打开对话', 'the unavailable state is explained to assistive technology')
  const navs = []
  const findNavs = node => { if (!node || typeof node !== 'object') return; if (node.type === 'nav') navs.push(node); for (const child of node.children ?? []) Array.isArray(child) ? child.forEach(findNavs) : findNavs(child) }
  findNavs(menuTree)
  assert.equal(navs.length, 1, 'the unified row has one navigation landmark')
  assert.equal(navs[0].props.className, 'tl-navigation')
  assert.ok(navs[0].children.some(child => child?.type === chunk.SceneTabs), 'scene tabs remain in the second navigation row after its scoped style node')
  const navStyle = navs[0].children.find(child => child?.props?.['data-tradeloom-nav-style'])
  assert.match(navStyle.children[0], /\.tl-shell-top\s*\{[^}]*visibility:\s*visible\s*;/,
    'the shell top explicitly remains visible when a collapsed-sidebar plugin rule targets its slot')
  assert.match(navStyle.children[0], /html\[data-windows-titlebar\]\s+\.tl-shell-top\s+\.tl-top-model-row\s*\{[^}]*inset-inline-start:\s*40px[^}]*inset-inline-end:\s*140px/s,
    'the compact first row occupies the Windows titlebar between the sidebar toggle and window controls')
  assert.match(navStyle.children[0], /\.tl-top-model-row\s*\{[^}]*-webkit-app-region:\s*drag/s,
    'the titlebar row remains a draggable surface')
  assert.doesNotMatch(navStyle.children[0], /\.tl-top-model-row\s*>\s*\*\s*\{[^}]*-webkit-app-region:\s*no-drag/s,
    'flex spacer space inside the model rail is not excluded from the titlebar drag region')
  for (const selector of ['button', 'a', 'input', 'select', 'textarea', 'summary', '[role="button"]', '[data-windows-menu]']) {
    assert.ok(navStyle.children[0].includes(`.tl-top-model-row ${selector}`),
      `the interactive titlebar target ${selector} remains individually excluded from the drag surface`)
  }
  assert.match(navStyle.children[0], /\.tl-top-model-row \[data-windows-menu\]\s*\{\s*-webkit-app-region:\s*no-drag;/,
    'the native Applications/Edit menu host remains an explicit no-drag island')
  assert.match(navStyle.children[0], /html\[data-meow-smooth-furled\]\s+\.tl-top-model-row\s*\{[^}]*padding-inline-start:\s*8px\s*;/,
    'the titlebar row does not reserve a second sidebar-toggle offset after merging into native chrome')
  assert.match(navStyle.children[0], /\.tl-navigation \.tl-scene-tab \{ font: inherit; color: inherit; background: transparent; \}/,
    'scene controls inherit the unified navigation typography')
  const toolsStyle = navStyle.children[0]
  assert.match(toolsStyle, /\.tl-shell-tools-menu\s*\{[^}]*position:\s*absolute/s, 'the row-one tools menu is positioned below its trigger')
  assert.ok(navs[0].children.every(child => !(child?.type === 'button' && child.children.includes('连接手机'))),
    'the phone action is moved out of the crowded business navigation row')
})

test('agent selector shows scene-config failure and retries the existing request until role metadata loads', async () => {
  const entrySource = await readFile(new URL('../client.js', import.meta.url), 'utf8')
  const chunkSource = await readFile(sceneChunkUrl, 'utf8')
  let entryRegistration
  let chunkRegistration
  let fetch
  let triggerFocusCount = 0
  const persistedOperations = new Map()
  const elements = (type, props, ...children) => {
    const node = { type, props: props ?? {}, children }
    if (props?.ref && typeof props.ref === 'object') {
      props.ref.current = type === 'button' && props['aria-label'] === '打开工具菜单'
        ? { focus() { triggerFocusCount++ }, getBoundingClientRect: () => ({ x: 400, y: 0, width: 28, height: 32, right: 428, bottom: 32 }) }
        : { contains(target) { return target?.insideShellTools === true }, querySelectorAll: () => [],
          getBoundingClientRect: () => ({ x: 400, y: 0, width: 28, height: 32, right: 428, bottom: 32 }) }
    }
    return node
  }
  const componentHookSlots = new Map()
  let activeHookOwner = null
  const hookFrame = () => {
    const owner = activeHookOwner ?? 'unscoped-fixture'
    if (!componentHookSlots.has(owner)) componentHookSlots.set(owner, {
      states: [], refs: [], layoutEffects: [], effects: [], stateIndex: 0, refIndex: 0, layoutEffectIndex: 0, effectIndex: 0,
    })
    return componentHookSlots.get(owner)
  }
  const documentListeners = new Map()
  const testDocument = {
    querySelectorAll: () => [],
    querySelector(selector) {
      if (selector !== '[data-tl-topbar-popover-open]') return null
      const toolsFrame = [...componentHookSlots].find(([component]) => component.name === 'ShellToolsMenu')?.[1]
      return [1, 2, 6, 8].some(index => toolsFrame?.states[index] === true)
        ? { dataset: { tlTopbarPopoverOpen: '' } } : null
    },
    addEventListener(type, listener) {
      if (!documentListeners.has(type)) documentListeners.set(type, new Set())
      documentListeners.get(type).add(listener)
    },
    removeEventListener(type, listener) { documentListeners.get(type)?.delete(listener) },
    dispatchEvent(event) { this.dispatch(event.type, event); return true },
    dispatch(type, event) { for (const listener of documentListeners.get(type) ?? []) listener({ type, ...event }) },
  }
  const React = {
    createElement: elements, Fragment: 'fragment',
    useState(initial) {
      const frame = hookFrame(), index = frame.stateIndex++
      if (!(index in frame.states)) frame.states[index] = typeof initial === 'function' ? initial() : initial
      return [frame.states[index], next => { frame.states[index] = typeof next === 'function' ? next(frame.states[index]) : next }]
    },
    useRef(initial) {
      const frame = hookFrame(), index = frame.refIndex++
      if (!(index in frame.refs)) frame.refs[index] = { current: initial }
      return frame.refs[index]
    },
    useLayoutEffect(effect, dependencies) {
      const frame = hookFrame(), index = frame.layoutEffectIndex++
      const previous = frame.layoutEffects[index]
      if (!previous || !dependencies || dependencies.some((value, item) => value !== previous.dependencies?.[item])) {
        previous?.cleanup?.()
        frame.layoutEffects[index] = { dependencies, cleanup: effect() }
      }
    },
    useEffect(effect, dependencies) {
      const frame = hookFrame(), index = frame.effectIndex++
      const previous = frame.effects[index]
      if (!previous || !dependencies || dependencies.some((value, item) => value !== previous.dependencies?.[item])) {
        previous?.cleanup?.()
        frame.effects[index] = { dependencies, cleanup: effect() }
      }
    },
  }
  const renderWithHooks = (component, props) => {
    const previousOwner = activeHookOwner
    activeHookOwner = component
    const frame = hookFrame()
    frame.stateIndex = frame.refIndex = frame.layoutEffectIndex = frame.effectIndex = 0
    try { return component(props) }
    finally { activeHookOwner = previousOwner }
  }
  const remountWithHooks = component => {
    const frame = componentHookSlots.get(component)
    if (!frame) return
    for (const slot of [...frame.layoutEffects, ...frame.effects]) slot?.cleanup?.()
    frame.states.length = 0
    frame.refs.length = 0
    frame.layoutEffects.length = 0
    frame.effects.length = 0
    frame.stateIndex = frame.refIndex = frame.layoutEffectIndex = frame.effectIndex = 0
  }
  const window = {
    location: { origin: 'http://desktop.local' },
    crypto: { randomUUID: () => '70f31e2d-716a-4d55-a43d-d4f3898ac4d0' },
    localStorage: {
      getItem(key) { return persistedOperations.get(key) ?? null },
      setItem(key, value) { persistedOperations.set(key, value) },
      removeItem(key) { persistedOperations.delete(key) },
    },
    document: testDocument,
    CustomEvent: class CustomEvent { constructor(type) { this.type = type } },
    addEventListener() {}, removeEventListener() {},
    __ModuleLoader__: { load(value) { entryRegistration = value } },
  }
  runInNewContext(entrySource, { window, document: testDocument, fetch: (...args) => fetch(...args) })
  runInNewContext(chunkSource, { window: { __ModuleLoader__: { load(value) { chunkRegistration = value } } }, document: testDocument, fetch: (...args) => fetch(...args) })

  const config = await readClientSceneConfig()
  const saved = defaultSceneWorkbench(config)
  saved.activeSceneId = 'deliverables'
  saved.roleByScene.deliverables = 'center'
  saved.businessPath = '/artifacts'
  const dockLayouts = normalizeDockLayouts(config, { version: 2, scenes: {} }, saved.layouts)
  let sceneFetches = 0
  const requests = []
  const openedNativeSessions = []
  const selectedShellPanels = []
  const usageValues = new Map([
    ['session-profile-live', { pressureTokens: 0, contextWindow: 128000 }],
    ['session-loaded-without-pressure', undefined],
  ])
  const usageListeners = new Map()
  let usageScopeLookups = 0
  let retainCalls = 0
  let createSessionCalls = 0
  let projectionRefreshCalls = 0
  let sessionSearchCalls = 0
  const catalogListeners = new Set()
  let sessionCatalog = { phase: 'ready', ids: [], byId: {}, projectionsBySession: {} }
  const sessionsApi = {
    list: {
      getSnapshot() { return sessionCatalog },
      subscribe(listener) { catalogListeners.add(listener); return () => catalogListeners.delete(listener) },
    },
    retain() { retainCalls++ },
    create() { createSessionCalls++; return Promise.resolve('unexpected-created-session') },
    refreshProjections() { projectionRefreshCalls++; return Promise.resolve() },
    search() { sessionSearchCalls++; return Promise.resolve({ ok: true, items: [], hasMore: false }) },
    scope(sessionId) {
      usageScopeLookups++
      return usageValues.has(sessionId) ? { sessionId } : undefined
    },
    sessionOf(scoped) {
      if (!scoped) return undefined
      return { projections: { faceOf(key) {
        assert.equal(key, 'contextPressure')
        return {
          getSnapshot: () => usageValues.get(scoped.sessionId),
          subscribe(listener) {
            if (!usageListeners.has(scoped.sessionId)) usageListeners.set(scoped.sessionId, new Set())
            usageListeners.get(scoped.sessionId).add(listener)
            return () => usageListeners.get(scoped.sessionId)?.delete(listener)
          },
        }
      } } }
    },
  }
  const capabilityRequests = new Map()
  const capabilityFetchOptions = []
  const configurationRequests = new Map()
  const configurationGetCount = new Map()
  const configurationFetchOptions = []
  const savedConfigurations = new Map()
  let releaseConfigurationSave
  const configFixture = role => savedConfigurations.get(role) ?? {
    role, preset: `tradeloom-${role}`, revision: 'a'.repeat(64), editable: true,
    mcpServers: role === 'product' ? [{ id: 'tradeloom-mcp-products', transport: 'streamable-http', serverName: 'products',
      url: 'http://127.0.0.1:3090/mcp', headers: { Authorization: { envName: 'PRODUCTS_TOKEN', scheme: 'bearer', present: true } },
      toolCallTimeoutMs: 30000, failOnStartupError: false }] : [],
    skill: { includeDefaultRoots: true, customSkillDirs: role === 'product' ? ['skills/nested'] : [] },
    deniedTools: role === 'product' ? ['offline-legacy-tool'] : [],
  }
  let newSessionCalls = 0
  let releaseNewSession
  const newSessionPayloads = []
  fetch = async (url, options = {}) => {
    requests.push([url, options.method ?? 'GET'])
    if (url.startsWith('/tradeloom/agent-configuration?')) {
      configurationFetchOptions.push(options)
      const role = new URL(url, 'http://desktop.local').searchParams.get('role')
      if (options.method === 'PUT') {
        const body = JSON.parse(options.body)
        savedConfigurations.set(role, { ...configFixture(role), ...body, revision: 'b'.repeat(64), editable: true })
        return await new Promise(resolve => { releaseConfigurationSave = () => resolve({ ok: true, async json() { return { role, preset: `tradeloom-${role}`, revision: 'b'.repeat(64), appliedForNewAgents: true, currentSessionUnchanged: true } } }) })
      }
      const count = (configurationGetCount.get(role) ?? 0) + 1
      configurationGetCount.set(role, count)
      if (count === 1) return await new Promise(resolve => configurationRequests.set(role, resolve))
      return { ok: true, async json() { return configFixture(role) } }
    }
    if (url === '/tradeloom/session/new') {
      newSessionCalls++
      newSessionPayloads.push(JSON.parse(options.body))
      const status = newSessionCalls === 1 ? 503 : 201
      return await new Promise(resolve => { releaseNewSession = () => resolve({ ok: status === 201, status, async json() {
        return status === 201 ? { role: 'product', sessionId: 'session-product-new-config' } : { error: 'session-create-outcome-unknown' }
      } }) })
    }
    if (url.startsWith('/tradeloom/agent-capabilities?')) {
      capabilityFetchOptions.push(options)
      const role = new URL(url, 'http://desktop.local').searchParams.get('role')
      return await new Promise(resolve => capabilityRequests.set(role, resolve))
    }
    if (url === '/tradeloom/scenes') {
      sceneFetches++
      if (sceneFetches <= 2) return { ok: false, async json() { return {} } }
      return { ok: true, async json() { return config } }
    }
    if (url === '/tradeloom/scene-layouts') return { ok: true, async json() { return saved } }
    if (url === '/tradeloom/dock-layouts') return { ok: true, async json() { return dockLayouts } }
    throw new Error(`unexpected request ${url}`)
  }
  const clientRequire = name => {
    if (name === 'react') return React
    if (name === 'react-dom') return { createPortal: child => child }
    assert.fail(`unexpected entry dependency: ${name}`)
  }
  let sceneExports
  clientRequire.async = async name => {
    assert.equal(name, './client.scenes.js')
    sceneExports = chunkRegistration.factory(clientRequire)
    return sceneExports
  }
  const slots = { registrations: [], inject(_name, callback) { callback() }, register(spec, component) { this.registrations.push({ spec, component }); return () => {} } }
  const client = entryRegistration.factory(clientRequire)
  const themeListeners = new Map()
  let themeSnapshot = { active: { colorScheme: 'light' }, fontSizes: { text: 14, code: 11, terminal: 13 } }
  const theme = {
    getTheme: () => themeSnapshot,
    setFontSize(role, px) {
      assert.equal(role, 'text')
      assert.ok(Number.isInteger(px) && px >= 10 && px <= 22)
      themeSnapshot = { ...themeSnapshot, fontSizes: { ...themeSnapshot.fontSizes, [role]: px } }
      for (const listener of themeListeners.get('theme/change') ?? []) listener(themeSnapshot)
    },
  }
  await client.apply({
    layout: { selectPanel(id) { selectedShellPanels.push(id) } }, uiWorkspace: { openSession(id) { openedNativeSessions.push(id) } },
    sessions: sessionsApi, modelDirectories: {}, remote: { session: {} }, theme,
    on(name, listener) {
      if (!themeListeners.has(name)) themeListeners.set(name, new Set())
      themeListeners.get(name).add(listener)
      return () => themeListeners.get(name)?.delete(listener)
    }, off() {}, effect() {}, slots,
  })

  function find(node, predicate) {
    if (!node || typeof node !== 'object') return undefined
    if (predicate(node)) return node
    for (const child of node.children ?? []) {
      const result = Array.isArray(child) ? child.map(item => find(item, predicate)).find(Boolean) : find(child, predicate)
      if (result) return result
    }
  }
  const topComponent = slots.registrations.find(item => item.spec.name === 'shell.top').component
  const getTop = () => renderWithHooks(topComponent, { usePanelInfo: () => ({}) })
  const sceneTabs = find(getTop(), node => node.type?.name === 'BusinessMenu')?.props.SceneTabs
  renderWithHooks(sceneTabs, {})
  for (let attempt = 0; attempt < 20; attempt++) await new Promise(resolve => setImmediate(resolve))

  const agentElement = find(getTop(), node => node.type?.name === 'AgentDirectory')
  const renderAgent = () => renderWithHooks(agentElement.type, agentElement.props)
  let agentTree = renderAgent()
  const findAll = (node, predicate, out = []) => {
    if (!node || typeof node !== 'object') return out
    if (predicate(node)) out.push(node)
    for (const child of node.children ?? []) Array.isArray(child) ? child.forEach(item => findAll(item, predicate, out)) : findAll(child, predicate, out)
    return out
  }
  const error = find(agentTree, node => node.props?.role === 'alert')
  assert.ok(error, 'the selector must stop saying it is loading when the scene configuration request fails')
  assert.match(JSON.stringify(error), /助手列表暂不可用/)
  let retry = find(agentTree, node => node.type === 'button' && node.children?.includes('重试助手列表'))
  assert.ok(retry, 'the visible role-load error provides a retry action')
  const unhandled = []
  const captureUnhandled = reason => unhandled.push(reason)
  process.on('unhandledRejection', captureUnhandled)
  let failedRetry
  try {
    failedRetry = await retry.props.onClick()
    for (let attempt = 0; attempt < 20; attempt++) await new Promise(resolve => setImmediate(resolve))
  } finally {
    process.removeListener('unhandledRejection', captureUnhandled)
  }
  assert.equal(failedRetry, false, 'an expected offline configuration failure is handled by the click action')
  assert.deepEqual(unhandled, [], 'repeated offline retries do not create unhandled rejections')
  agentTree = renderAgent()
  assert.ok(find(agentTree, node => node.props?.role === 'alert'), 'a failed retry keeps the actionable error visible')
  retry = find(agentTree, node => node.type === 'button' && node.children?.includes('重试助手列表'))
  assert.ok(retry)
  assert.equal(await retry.props.onClick(), true, 'a later successful retry completes the same configuration request')
  for (let attempt = 0; attempt < 20 && !sceneExports.getSnapshot().config; attempt++) await new Promise(resolve => setImmediate(resolve))
  assert.equal(sceneExports.getSnapshot().businessPath, '/artifacts#deliverables',
    'loading an older saved delivery scene with the bare artifacts route restores the existing delivery-versions anchor')
  agentTree = renderAgent()
  assert.equal(sceneFetches, 3, 'each retry reuses the SceneWorkbench configuration loader instead of making a duplicate request')
  assert.equal(find(agentTree, node => node.props?.role === 'alert'), undefined, 'successful retry clears the role-load error')
  const roles = ['中心', '商品专家', '市场研究（占位）', '询报价（占位）', '交付协同', '用户资料（演示）']
  assert.equal(findAll(agentTree, node => node.type === 'button' && roles.includes(node.props?.['aria-label'])).length, 6,
    'successful retry exposes the current safe role menu')
  assert.deepEqual(requests.filter(([url]) => url === '/tradeloom/scenes').map(([, method]) => method), ['GET', 'GET', 'GET'])

  const capabilityButton = find(agentTree, node => node.type === 'button' && node.children?.includes('查看 MCP 与 Skill 能力'))
  assert.ok(capabilityButton, 'the existing Agent selector exposes capability details without adding a sidebar')
  capabilityButton.props.onClick()
  agentTree = renderAgent()
  const selector = find(agentTree, node => node.type === 'select' && node.props?.['aria-label'] === '选择要查看能力的助手')
  assert.ok(selector, 'the detail view can inspect each role from the safe role metadata')
  selector.props.onChange({ target: { value: 'product' } })
  assert.deepEqual([...capabilityRequests.keys()].sort(), ['center', 'product'])
  const productResult = {
    role: 'product', status: 'ready', tools: { status: 'available', items: [{ name: 'read_products' }] },
    skills: { status: 'available', complete: true, items: [{ name: 'product-skill', description: 'Product scoped', source: 'runtime', invocation: { modelInvocable: true, userInvocable: false } }] },
    mcp: { status: 'not_configured', visibleTools: null },
  }
  const centerResult = {
    role: 'center', status: 'ready', tools: { status: 'available', items: [] },
    skills: { status: 'available', complete: true, items: [] }, mcp: { status: 'not_configured', visibleTools: null },
  }
  capabilityRequests.get('product')({ ok: true, async json() { return productResult } })
  configurationRequests.get('product')({ ok: true, async json() { return configFixture('product') } })
  await new Promise(resolve => setImmediate(resolve))
  capabilityRequests.get('center')({ ok: true, async json() { return centerResult } })
  await new Promise(resolve => setImmediate(resolve))
  agentTree = renderAgent()
  assert.ok(find(agentTree, node => node.type === 'strong' && node.children?.includes('product-skill')),
    'a late response for the previously selected role cannot replace the current role capability result')
  const savedConfigTab = find(agentTree, node => node.type === 'button' && node.children?.includes('已保存配置'))
  assert.ok(savedConfigTab, 'the existing capability dialog has a separate saved-configuration view')
  savedConfigTab.props.onClick()
  agentTree = renderAgent()
  assert.ok(find(agentTree, node => node.type === 'summary' && node.children?.some?.(child => String(child).includes('products · HTTP'))),
    'MCP server details are collapsed to keep the capability panel compact')
  assert.ok(find(agentTree, node => node.type === 'p' && JSON.stringify(node.children).includes('当前运行中的会话继续使用其原有能力')),
    'saved defaults are distinct from the current running session')
  assert.equal(find(agentTree, node => node.type === 'input' && node.props?.['aria-label'] === '环境变量名 1')?.props?.value,
    'PRODUCTS_TOKEN', 'the editor shows an environment variable reference, not its resolved value')
  const environmentName = find(agentTree, node => node.type === 'input' && node.props?.['aria-label'] === '环境变量名 1')
  environmentName.props.onChange({ target: { value: 'PRODUCTS_TOKEN_NEXT' } })
  const skillDirectories = find(agentTree, node => node.type === 'textarea' && node.props?.value === 'skills/nested')
  assert.ok(skillDirectories, 'the editor exposes role-specific relative Skill directories')
  skillDirectories.props.onChange({ target: { value: 'skills/nested\nskills/new-folder' } })
  const lateCenterConfig = configurationRequests.get('center')
  assert.ok(lateCenterConfig, 'the first center configuration read remains independently pending')
  lateCenterConfig({ ok: true, async json() { return configFixture('center') } })
  await new Promise(resolve => setImmediate(resolve))
  agentTree = renderAgent()
  assert.equal(find(agentTree, node => node.type === 'input' && node.props?.['aria-label'] === '环境变量名 1')?.props?.value,
    'PRODUCTS_TOKEN_NEXT', 'a late previous-role configuration response does not replace the selected role draft')
  assert.equal(find(agentTree, node => node.type === 'textarea')?.props?.value, 'skills/nested\nskills/new-folder')
  find(agentTree, node => node.type === 'select' && node.props?.['aria-label'] === '选择要查看能力的助手')
    .props.onChange({ target: { value: 'center' } })
  capabilityRequests.get('center')({ ok: true, async json() { return centerResult } })
  await new Promise(resolve => setImmediate(resolve))
  agentTree = renderAgent()
  assert.notEqual(find(agentTree, node => node.type === 'textarea')?.props?.value, 'skills/nested\nskills/new-folder',
    'one role never displays another role’s unsaved Skill text')
  find(agentTree, node => node.type === 'select' && node.props?.['aria-label'] === '选择要查看能力的助手')
    .props.onChange({ target: { value: 'product' } })
  capabilityRequests.get('product')({ ok: true, async json() { return productResult } })
  for (let attempt = 0; attempt < 20; attempt++) await new Promise(resolve => setImmediate(resolve))
  agentTree = renderAgent()
  assert.equal(find(agentTree, node => node.type === 'textarea')?.props?.value, 'skills/nested\nskills/new-folder',
    'returning to a role restores its unsubmitted Skill draft')
  const saveDefaults = find(agentTree, node => node.type === 'button' && node.children?.includes('保存默认配置'))
  assert.ok(saveDefaults && !saveDefaults.props.disabled, 'changed configuration has an explicit save action')
  saveDefaults.props.onClick()
  saveDefaults.props.onClick()
  agentTree = renderAgent()
  const savingDefaults = find(agentTree, node => node.type === 'button' && node.children?.includes('保存中…'))
  assert.ok(savingDefaults?.props.disabled, 'save submission blocks duplicate mutation while it is in flight')
  assert.equal(find(agentTree, node => node.type === 'input' && node.props?.['aria-label'] === '环境变量名 1')?.props?.disabled,
    true, 'environment reference inputs stay locked while the submitted snapshot is saving')
  assert.equal(find(agentTree, node => node.type === 'select' && node.props?.['aria-label'] === '引用方式 1')?.props?.disabled,
    true, 'reference scheme cannot drift while the save is in flight')
  assert.equal(configurationFetchOptions.filter(options => options.method === 'PUT').length, 1,
    'a synchronous duplicate click starts only one configuration write')
  await new Promise(resolve => setImmediate(resolve))
  const submittedConfiguration = JSON.parse(configurationFetchOptions.find(options => options.method === 'PUT').body)
  assert.equal(submittedConfiguration.mcpServers[0].headers.Authorization.envName, 'PRODUCTS_TOKEN_NEXT')
  assert.equal('present' in submittedConfiguration.mcpServers[0].headers.Authorization, false,
    'GET presence metadata is never sent back as configuration')
  assert.deepEqual(submittedConfiguration.skill.customSkillDirs, ['skills/nested', 'skills/new-folder'],
    'the latest Skill text is normalized on save without waiting for blur')
  assert.ok(configurationFetchOptions.filter(options => options.method === 'PUT').every(options => options.credentials === 'same-origin'))
  releaseConfigurationSave()
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(requests.filter(([url]) => url.startsWith('/tradeloom/agent-capabilities?')), [
    ['/tradeloom/agent-capabilities?role=center', 'GET'],
    ['/tradeloom/agent-capabilities?role=product', 'GET'],
    ['/tradeloom/agent-capabilities?role=center', 'GET'],
    ['/tradeloom/agent-capabilities?role=product', 'GET'],
  ], 'the saved-configuration editor uses the current capability reads already in the dialog')
  agentTree = renderAgent()
  const newConversation = find(agentTree, node => node.type === 'button' && node.children?.includes('用已保存配置新建对话'))
  assert.ok(newConversation && !newConversation.props.disabled, 'a clean saved configuration can create a new conversation')
  newConversation.props.onClick()
  newConversation.props.onClick()
  assert.equal(newSessionCalls, 1, 'double click reuses one in-flight operation')
  assert.deepEqual(newSessionPayloads[0], {
    role: 'product', expectedSessionId: null, operationId: '70f31e2d-716a-4d55-a43d-d4f3898ac4d0',
  }, 'the UI sends only role, the expected binding, and a stable operation ID')
  assert.equal(JSON.parse(persistedOperations.get('tradeloom:session-create:product')).operationId,
    newSessionPayloads[0].operationId, 'the same operation ID survives a reload/timeout until its outcome is confirmed')
  releaseNewSession()
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(persistedOperations.has('tradeloom:session-create:product'), true,
    'an unknown response keeps the exact operation available for safe retry')
  agentTree = renderAgent()
  assert.match(JSON.stringify(find(agentTree, node => node.props?.role === 'status')),
    /创建结果尚未确认.*旧会话保持不变.*已保留该操作/,
    'an unknown outcome explains the retained operation and does not suggest creating a different session')
  find(agentTree, node => node.type === 'button' && node.children?.includes('用已保存配置新建对话')).props.onClick()
  assert.equal(newSessionCalls, 2, 'retry sends one additional request after the first outcome is unknown')
  assert.deepEqual(newSessionPayloads[1], newSessionPayloads[0], 'retry reuses the identical expected binding and operation UUID')
  agentTree = renderAgent()
  find(agentTree, node => node.type === 'select' && node.props?.['aria-label'] === '选择要查看能力的助手')
    .props.onChange({ target: { value: 'center' } })
  capabilityRequests.get('center')({ ok: true, async json() { return centerResult } })
  await new Promise(resolve => setImmediate(resolve))
  agentTree = renderAgent()
  releaseNewSession()
  await new Promise(resolve => setImmediate(resolve))
  for (let attempt = 0; attempt < 20; attempt++) await new Promise(resolve => setImmediate(resolve))
  assert.equal(sceneExports.getSnapshot().sessionBindings.product, 'session-product-new-config',
    'the returned native session updates its role binding without replacing the previous Session')
  assert.equal(sceneExports.getSnapshot().roleByScene[sceneExports.getSnapshot().activeSceneId], 'center',
    'a late create response does not switch back after the user selected another role')
  assert.equal(persistedOperations.has('tradeloom:session-create:product'), false, 'confirmed success clears the local replay hint')
  assert.deepEqual(requests.filter(([url]) => url.startsWith('/tradeloom/agent-capabilities?')), [
    ['/tradeloom/agent-capabilities?role=center', 'GET'],
    ['/tradeloom/agent-capabilities?role=product', 'GET'],
    ['/tradeloom/agent-capabilities?role=center', 'GET'],
    ['/tradeloom/agent-capabilities?role=product', 'GET'],
    ['/tradeloom/agent-capabilities?role=center', 'GET'],
  ], 'the late response does not refresh or replace the newly selected role view')
  agentTree = renderAgent()
  find(agentTree, node => node.type === 'select' && node.props?.['aria-label'] === '选择要查看能力的助手')
    .props.onChange({ target: { value: 'product' } })
  capabilityRequests.get('product')({ ok: true, async json() { return productResult } })
  await new Promise(resolve => setImmediate(resolve))
  assert.ok(capabilityFetchOptions.every(options => options.credentials === 'same-origin' && !('body' in options)),
    'the UI uses authenticated same-origin read requests without session IDs or write payloads')

  agentTree = renderAgent()
  find(agentTree, node => node.type === 'button' && node.children?.includes('当前能力')).props.onClick()
  agentTree = renderAgent()
  let reread = find(agentTree, node => node.type === 'button' && node.children?.includes('重新读取'))
  assert.ok(reread, 'configuration controls remain available after returning to the role')
  reread.props.onClick()
  capabilityRequests.get('product')({ ok: false, async json() { return {} } })
  await new Promise(resolve => setImmediate(resolve))
  agentTree = renderAgent()
  let capabilityError = find(agentTree, node => node.props?.role === 'alert')
  assert.match(JSON.stringify(capabilityError), /能力信息暂时无法读取/)
  const retryCapability = find(capabilityError, node => node.type === 'button' && node.children?.includes('重试'))
  retryCapability.props.onClick()
  capabilityRequests.get('product')({ ok: true, async json() { return productResult } })
  await new Promise(resolve => setImmediate(resolve))
  agentTree = renderAgent()
  assert.ok(find(agentTree, node => node.type === 'strong' && node.children?.includes('product-skill')),
    'the capability error can be retried without changing the bound role or session')

  const currentSelector = find(agentTree, node => node.type === 'select' && node.props?.['aria-label'] === '选择要查看能力的助手')
  currentSelector.props.onChange({ target: { value: 'center' } })
  capabilityRequests.get('center')({ ok: true, async json() {
    return { role: 'center', status: 'not_bound', tools: null, skills: null, mcp: { status: 'declared_only', visibleTools: null } }
  } })
  await new Promise(resolve => setImmediate(resolve))
  agentTree = renderAgent()
  assert.ok(find(agentTree, node => node.type === 'p' && node.children?.includes('该预设声明了 MCP 客户端；这不代表当前会话已连接。')),
    'an unbound role still shows the safe preset MCP declaration without implying a live connection')
  assert.ok(find(agentTree, node => node.type === 'p' && node.children?.includes('该助手当前没有已绑定的原生会话，工具与 Skill 能力未知。')))

  await sceneExports.selectRole('center', 'native-center-session-123')
  const beforeOpen = sceneExports.getSnapshot()
  const toolsElement = find(getTop(), node => node.type?.name === 'ShellToolsMenu')
  assert.ok(toolsElement, 'the shell tools menu is available alongside native chat')
  const openMenuAndFindAction = label => {
    let tree = renderWithHooks(toolsElement.type, toolsElement.props)
    find(tree, node => node.type === 'button' && node.props?.['aria-label'] === '打开工具菜单').props.onClick()
    tree = renderWithHooks(toolsElement.type, toolsElement.props)
    return find(tree, node => node.type === 'button' && node.children?.includes(label))
  }
  const navigation = find(getTop(), node => node.type?.name === 'BusinessMenu')
  const openCurrentChat = () => renderWithHooks(navigation.type, { ...navigation.props, usePanelInfo: selector => selector({}) }).children
    .find(node => node?.props?.['aria-label'] === '打开当前对话')
  assert.ok(openCurrentChat(), 'a known active role session exposes the explicit native conversation action')
  assert.equal(openCurrentChat().props['aria-current'], 'page', 'the standalone conversation entry is selected when it is the active main panel')
  openCurrentChat().props.onClick()
  assert.deepEqual(openedNativeSessions, ['native-center-session-123'], 'the current bound session is passed to the host UI workspace API')
  assert.deepEqual(sceneExports.getSnapshot().sessionBindings, beforeOpen.sessionBindings, 'opening chat does not create or change role-to-session bindings')
  assert.equal(sceneExports.getSnapshot().activeSceneId, beforeOpen.activeSceneId, 'opening chat leaves the current scene selected')
  assert.equal(requests.some(([url, method]) => url === '/tradeloom/session' && method === 'POST'), false, 'opening chat does not request a new native session')
  openMenuAndFindAction('返回工作台').props.onClick()
  assert.deepEqual(selectedShellPanels.at(-1), 'scene-workbench', 'return action restores the workbench main panel')
  assert.equal(sceneExports.getSnapshot().activeSceneId, beforeOpen.activeSceneId, 'return action keeps the same scene')

  const staleChatAction = openCurrentChat()
  assert.ok(staleChatAction)
  sceneExports.navigateBusiness('/products')
  assert.equal(sceneExports.getSnapshot().activeSceneId, 'products', 'the test switches scenes while the utility menu is open')
  const openedBeforeStaleClick = openedNativeSessions.length
  staleChatAction.props.onClick()
  assert.equal(openedNativeSessions.length, openedBeforeStaleClick + 1)
  assert.equal(openedNativeSessions.at(-1), 'session-product-new-config',
    'a stale menu action resolves the live scene binding and cannot open the previous scene\'s session')

  sceneExports.navigateScene('deliverables')
  assert.equal(sceneExports.getSnapshot().businessPath, '/artifacts#deliverables',
    'selecting the delivery scene keeps its existing delivery-versions anchor instead of the bare intake URL')
  sceneExports.navigateScene('user-profile')
  assert.equal(sceneExports.getSnapshot().businessPath, '/artifacts#sources',
    'selecting the materials scene opens its existing source-intake anchor')
  const subscribe = sceneExports.subscribe
  let topSubscriptionCount = 0
  let topNotifications = 0
  sceneExports.subscribe = listener => {
    topSubscriptionCount++
    const unsubscribe = subscribe(() => { topNotifications++; listener() })
    return () => { unsubscribe(); topSubscriptionCount-- }
  }
  const topRegistration = slots.registrations.find(item => item.spec.name === 'shell.top')
  remountWithHooks(topRegistration.component)
  const renderConversationEntry = () => {
    const topTree = renderWithHooks(topRegistration.component, { usePanelInfo: selector => selector({ activePanelId: 'scene-workbench' }) })
    const businessMenu = find(topTree, node => node.type?.name === 'BusinessMenu')
    const menuTree = renderWithHooks(businessMenu.type, { ...businessMenu.props, usePanelInfo: selector => selector({ activePanelId: 'scene-workbench' }) })
    return find(menuTree, node => node.props?.className === 'tl-conversation-entry')
  }
  const disconnectedEntry = renderConversationEntry()
  assert.equal(disconnectedEntry.props.disabled, true, 'the conversation entry remains disabled before the current role has a session binding')
  assert.equal(topSubscriptionCount, 1, 'the mounted top navigation subscribes once to role/session snapshot changes')
  assert.equal(sceneExports.bindRoleSession('user-profile', 'session-profile-live'), true)
  assert.equal(topNotifications, 1, 'a newly bound role session notifies the top navigation without a panel focus change')
  const connectedEntry = renderConversationEntry()
  assert.equal(topSubscriptionCount, 1, 'rerendering keeps one stable subscription instead of accumulating listeners')
  assert.equal(connectedEntry.props.disabled, false, 'the conversation entry enables after its scene snapshot binds a session')
  connectedEntry.props.onClick()
  assert.equal(openedNativeSessions.at(-1), 'session-profile-live', 'the enabled entry opens the newly bound native session')
  sceneExports.subscribe = subscribe
  let toolsTree = renderWithHooks(toolsElement.type, toolsElement.props)
  let trigger = find(toolsTree, node => node.type === 'button' && node.props?.['aria-label'] === '打开工具菜单')
  trigger.props.onClick()
  toolsTree = renderWithHooks(toolsElement.type, toolsElement.props)
  assert.ok(find(toolsTree, node => node.props?.['aria-label'] === '工作台工具'), 'opening the disclosure reveals its grouped actions')
  testDocument.dispatch('keydown', { key: 'Escape', preventDefault() {} })
  toolsTree = renderWithHooks(toolsElement.type, toolsElement.props)
  assert.equal(find(toolsTree, node => node.props?.['aria-label'] === '工作台工具'), undefined, 'Escape closes the utility disclosure')
  assert.equal(find(toolsTree, node => node.props?.['aria-label'] === '打开工具菜单').props['aria-expanded'], false)
  assert.ok(triggerFocusCount > 0, 'Escape returns keyboard focus to the disclosure trigger')

  trigger = find(toolsTree, node => node.type === 'button' && node.props?.['aria-label'] === '打开工具菜单')
  trigger.props.onClick()
  toolsTree = renderWithHooks(toolsElement.type, toolsElement.props)
  testDocument.dispatch('click', { target: { insideShellTools: false } })
  toolsTree = renderWithHooks(toolsElement.type, toolsElement.props)
  assert.equal(find(toolsTree, node => node.props?.['aria-label'] === '工作台工具'), undefined, 'a click outside the utility disclosure closes it')

  sceneExports.bindRoleSession('center', 'session-profile-live')
  sceneExports.bindRoleSession('product', 'session-not-loaded')
  sceneExports.bindRoleSession('delivery', 'session-loaded-without-pressure')
  const summary = (displayTitle, overrides = {}) => ({ displayTitle, title: displayTitle, updatedAt: 0, running: false, blank: false, retainedBy: {}, ...overrides })
  sessionCatalog = {
    phase: 'ready',
    ids: ['session-profile-live', 'session-not-loaded', 'session-loaded-without-pressure', 'catalog-subagent-539', 'catalog-other-unknown'],
    byId: {
      'session-profile-live': summary('资料工作会话'),
      'session-not-loaded': summary('未载入的商品会话'),
      'session-loaded-without-pressure': summary('用量尚未提供的会话'),
      'catalog-subagent-539': summary('子助手会话', { origin: 'subagent', parentId: 'session-profile-live' }),
      'catalog-other-unknown': summary('其他未知会话'),
    },
    projectionsBySession: {
      'catalog-subagent-539': { values: { contextPressure: { projectedTokens: 539000, contextWindow: 100000 } }, state: 'ready', error: null },
      'catalog-other-unknown': { values: {}, state: 'ready', error: null },
    },
  }
  const boundBeforeUsage = JSON.stringify(sceneExports.getSnapshot().sessionBindings)
  const retainBeforeUsage = retainCalls
  const createRequestsBeforeUsage = requests.filter(([url, method]) => url === '/tradeloom/session/new' && method === 'POST').length
  const usageAction = openMenuAndFindAction('会话用量')
  assert.ok(usageAction, 'session usage is available from the utility menu')
  usageAction.props.onClick()
  toolsTree = renderWithHooks(toolsElement.type, toolsElement.props)
  let usagePanel = find(toolsTree, node => node.props?.['aria-label'] === '会话用量' && node.props?.role === 'dialog')
  assert.ok(usagePanel, 'the utility menu opens the anchored session-usage panel')
  assert.match(JSON.stringify(usagePanel), /共 5 条/,
    'the header counts actual Host catalog ids rather than role bindings or a screenshot total')
  assert.match(JSON.stringify(usagePanel), /中心助手 \/ 资料助手|资料助手 \/ 中心助手/,
    'roles bound to the same existing session are grouped instead of counted twice')
  const usageGroups = findAll(usagePanel, node => node.type === 'details' && node.props?.className === 'tl-session-usage-group')
  assert.deepEqual(usageGroups.map(group => [
    group.children?.[0]?.children?.[2]?.children?.[0]?.children?.[0],
    group.children?.[0]?.children?.[3]?.children?.[0], group.props.open,
  ]), [
    ['场景会话', '3 条', false], ['助手会话', '1 条', true], ['其他会话', '1 条', true],
  ], 'catalog rows use source metadata to form the three collapsible groups, show each count, and keep the reference primary group compact')
  const usageRows = findAll(usagePanel, node => node.type === 'article' && node.props?.role === 'listitem')
  assert.equal(usageRows.length, 5, 'each unique Host catalog id produces one compact two-line row')
  const assistantUsageRow = usageRows.find(row => row.props?.['data-session-id'] === 'catalog-subagent-539')
  assert.equal(assistantUsageRow?.props?.['data-usage-tone'], 'danger')
  assert.match(JSON.stringify(assistantUsageRow), /539%/,
    'a cached subagent estimate is shown in the assistant group with its actual percentage above 100')
  assert.match(JSON.stringify(usagePanel), /轮数 \/ 压缩 \/ 成本：未知/,
    'unsupported turn-count, compaction and cost remain explicitly unknown in the shared explanation')
  const otherUnknownRow = usageRows.find(row => row.props?.['data-session-id'] === 'catalog-other-unknown')
  assert.match(JSON.stringify(otherUnknownRow), /暂无用量记录/)
  assert.equal(otherUnknownRow?.props?.['data-usage-tone'], 'muted', 'a missing projection is unknown, not numeric zero')
  const notLoadedRow = usageRows.find(row => row.props?.['data-session-id'] === 'session-not-loaded')
  assert.match(JSON.stringify(notLoadedRow), /暂无用量记录/,
    'a not-loaded bound session with no cached usage remains explicit unknown')
  const zeroUsageRow = usageRows.find(row => row.props?.['data-session-id'] === 'session-profile-live')
  assert.equal(find(zeroUsageRow, node => node.props?.['data-usage-value'] === 'used')?.children?.[0], '0')
  assert.equal(find(zeroUsageRow, node => node.props?.['data-usage-value'] === 'capacity')?.children?.[0], '12.8万')
  assert.match(JSON.stringify(usagePanel), /0%/,
    'a genuine zero pressure is shown as zero rather than treated as unavailable')
  assert.match(JSON.stringify(zeroUsageRow), /最近上下文估算 0 \/ 128,000 tokens/,
    'a live context projection keeps numeric zero visibly distinct from unavailable data')
  assert.equal(usageListeners.get('session-profile-live')?.size, 1,
    'the panel subscribes once to the existing session context-pressure projection')
  assert.equal(catalogListeners.size, 1, 'an open global panel subscribes to the Host catalog for non-bound rows')
  const usagePanelRevision = usagePanel.props['data-revision']
  usageValues.set('session-profile-live', { projectedTokens: 64000, contextWindow: 128000 })
  for (const listener of usageListeners.get('session-profile-live') ?? []) listener()
  toolsTree = renderWithHooks(toolsElement.type, toolsElement.props)
  usagePanel = find(toolsTree, node => node.props?.['aria-label'] === '会话用量' && node.props?.role === 'dialog')
  assert.notEqual(usagePanel.props['data-revision'], usagePanelRevision,
    'projection updates invalidate the mounted usage panel without reading chat content')
  assert.match(JSON.stringify(usagePanel), /6\.4万/)
  assert.match(JSON.stringify(usagePanel), /12\.8万/)
  assert.match(JSON.stringify(usagePanel), /最近上下文估算 64,000 \/ 128,000 tokens/)
  assert.match(JSON.stringify(usagePanel), /50%/)
  usageValues.set('session-profile-live', { projectedTokens: 225280, contextWindow: 128000 })
  for (const listener of usageListeners.get('session-profile-live') ?? []) listener()
  toolsTree = renderWithHooks(toolsElement.type, toolsElement.props)
  usagePanel = find(toolsTree, node => node.props?.['aria-label'] === '会话用量' && node.props?.role === 'dialog')
  assert.match(JSON.stringify(usagePanel), /176%/,
    'percentage text preserves true usage above capacity')
  const liveUsageRow = find(usagePanel, node => node.type === 'article' && node.props?.['data-session-id'] === 'session-profile-live')
  assert.equal(liveUsageRow?.props?.['data-usage-tone'], 'warning', 'the panel uses a readable warning band above 100%')
  usageValues.set('session-profile-live', { projectedTokens: 690000, contextWindow: 128000 })
  for (const listener of usageListeners.get('session-profile-live') ?? []) listener()
  toolsTree = renderWithHooks(toolsElement.type, toolsElement.props)
  usagePanel = find(toolsTree, node => node.props?.['aria-label'] === '会话用量' && node.props?.role === 'dialog')
  assert.match(JSON.stringify(usagePanel), /539%/)
  const overBudgetRow = find(usagePanel, node => node.type === 'article' && node.props?.['data-session-id'] === 'session-profile-live')
  assert.equal(overBudgetRow?.props?.['data-usage-tone'], 'danger')
  assert.match(JSON.stringify(overBudgetRow), /69万/)
  assert.match(JSON.stringify(overBudgetRow), /12\.8万/)
  assert.match(JSON.stringify(overBudgetRow), /最近上下文估算 690,000 \/ 128,000 tokens/,
    'over-capacity token values and percentage are never clipped at 100%')
  assert.match(JSON.stringify(overBudgetRow), /最近上下文估算 690,000 \/ 128,000 tokens/,
    'the compact row keeps the exact token counts accessible in its title and label')
  const liveUsageRevision = usagePanel.props['data-revision']
  sessionCatalog = { ...sessionCatalog, ids: [...sessionCatalog.ids, 'catalog-late-row'], byId: { ...sessionCatalog.byId, 'catalog-late-row': summary('后到的会话') } }
  for (const listener of [...catalogListeners]) listener()
  toolsTree = renderWithHooks(toolsElement.type, toolsElement.props)
  usagePanel = find(toolsTree, node => node.props?.['aria-label'] === '会话用量' && node.props?.role === 'dialog')
  assert.notEqual(usagePanel.props['data-revision'], liveUsageRevision,
    'catalog updates rerender unopened sessions without retaining their references')
  assert.equal(findAll(usagePanel, node => node.type === 'article' && node.props?.role === 'listitem').length, 6)
  assert.equal(JSON.stringify(sceneExports.getSnapshot().sessionBindings), boundBeforeUsage,
    'opening and updating usage preserves the existing role bindings')
  assert.equal(retainCalls, retainBeforeUsage, 'usage reads never retain or create a session')
  assert.equal(createSessionCalls, 0, 'usage never creates a session')
  assert.equal(projectionRefreshCalls, 0, 'usage never fetches missing projection data automatically')
  assert.equal(sessionSearchCalls, 0, 'usage never searches or reads conversation history')
  assert.equal(requests.filter(([url, method]) => url === '/tradeloom/session/new' && method === 'POST').length,
    createRequestsBeforeUsage, 'usage reads never call the native session-creation route')
  testDocument.dispatch('keydown', { key: 'Escape', preventDefault() {} })
  toolsTree = renderWithHooks(toolsElement.type, toolsElement.props)
  assert.equal(find(toolsTree, node => node.props?.['aria-label'] === '会话用量' && node.props?.role === 'dialog'), undefined,
    'Escape closes the usage panel')
  assert.equal(usageListeners.get('session-profile-live')?.size ?? 0, 0,
    'closing the panel removes the projection subscription')
  assert.equal(catalogListeners.size, 0, 'closing the panel removes the Host list subscription')
  const reopenUsage = openMenuAndFindAction('会话用量')
  reopenUsage.props.onClick()
  toolsTree = renderWithHooks(toolsElement.type, toolsElement.props)
  assert.ok(find(toolsTree, node => node.props?.['aria-label'] === '会话用量' && node.props?.role === 'dialog'))
  testDocument.dispatch('click', { target: { insideShellTools: false } })
  toolsTree = renderWithHooks(toolsElement.type, toolsElement.props)
  assert.equal(find(toolsTree, node => node.props?.['aria-label'] === '会话用量' && node.props?.role === 'dialog'), undefined,
    'clicking outside the anchored panel closes it')
  assert.equal(usageListeners.get('session-profile-live')?.size ?? 0, 0,
    'outside dismissal also releases per-session projection subscriptions')
  assert.equal(catalogListeners.size, 0, 'outside dismissal also releases the Host list subscription')

  const fontAction = openMenuAndFindAction('界面大小')
  assert.ok(fontAction, 'the utility menu exposes the interface-density control')
  fontAction.props.onClick()
  toolsTree = renderWithHooks(toolsElement.type, toolsElement.props)
  let fontPanel = find(toolsTree, node => node.props?.['aria-label'] === '界面大小' && node.props?.role === 'dialog')
  assert.ok(fontPanel, 'the interface-density control opens as an anchored dialog')
  let fontSlider = find(fontPanel, node => node.type === 'input' && node.props?.['aria-label'] === '界面大小')
  assert.equal(fontSlider.props.min, 10)
  assert.equal(fontSlider.props.max, 22)
  assert.equal(fontSlider.props.value, 14, 'shell defaults follow the persisted native theme text size, defaulting to 14px')
  fontSlider.props.onChange({ currentTarget: { value: '16' } })
  assert.equal(themeSnapshot.fontSizes.text, 16, 'the menu writes through the native persistent theme preference')
  await new Promise(resolve => setImmediate(resolve))
  toolsTree = renderWithHooks(toolsElement.type, toolsElement.props)
  fontPanel = find(toolsTree, node => node.props?.['aria-label'] === '界面大小' && node.props?.role === 'dialog')
  fontSlider = find(fontPanel, node => node.type === 'input' && node.props?.['aria-label'] === '界面大小')
  assert.equal(fontSlider.props.value, 16, 'a saved native preference updates the shell and slider immediately')
  assert.equal(JSON.stringify(fontPanel).includes('114% · 正文16px'), true, 'the selected scale and body size are shown explicitly')
  find(fontPanel, node => node.type === 'button' && node.children?.includes('恢复参考大小')).props.onClick()
  assert.equal(themeSnapshot.fontSizes.text, 14, 'reset stores the native default size rather than a local override')
  await new Promise(resolve => setImmediate(resolve))
  toolsTree = renderWithHooks(toolsElement.type, toolsElement.props)
  fontPanel = find(toolsTree, node => node.props?.['aria-label'] === '界面大小' && node.props?.role === 'dialog')
  fontSlider = find(fontPanel, node => node.type === 'input' && node.props?.['aria-label'] === '界面大小')
  assert.equal(fontSlider.props.value, 14)
  testDocument.dispatch('keydown', { key: 'Escape', preventDefault() {} })
  toolsTree = renderWithHooks(toolsElement.type, toolsElement.props)
  assert.equal(find(toolsTree, node => node.props?.['aria-label'] === '界面大小' && node.props?.role === 'dialog'), undefined,
    'Escape closes the interface-density dialog')

})

test('an asynchronous scene chunk failure leaves business navigation available and can be retried', async () => {
  const entrySource = await readFile(new URL('../client.js', import.meta.url), 'utf8')
  let entryRegistration
  runInNewContext(entrySource, { window: { __ModuleLoader__: { load(value) { entryRegistration = value } } } })
  let chunkRegistration
  runInNewContext(await readFile(sceneChunkUrl, 'utf8'), { window: { __ModuleLoader__: { load(value) { chunkRegistration = value } } } })
  const React = {
    createElement: (type, props, ...children) => ({ type, props, children }),
    useState: initial => [initial, () => {}],
    useEffect() {},
  }
  const chunk = chunkRegistration.factory(() => React)
  let attempts = 0
  const registrations = []
  const slots = {
    inject(_name, register) { register() },
    register(spec, component) { registrations.push({ spec, component }); return () => {} },
  }
  const entryRequire = name => {
    if (name === 'react') return React
    if (name === 'react-dom') return { createPortal: child => child }
    assert.fail(`unexpected entry dependency: ${name}`)
  }
  entryRequire.async = async name => {
    assert.equal(name, './client.scenes.js')
    attempts++
    if (attempts === 1) throw new Error('chunk unavailable')
    return chunk
  }
  const plugin = entryRegistration.factory(entryRequire)
  await plugin.apply({ slots, layout: { selectPanel() {} }, uiWorkspace: { openSession() {} } })
  assert.equal(registrations.some(item => item.spec.name === 'sidebar.agents'), false, 'scene chunk failure does not reserve a sidebar slot for agents')
  let top = registrations.find(item => item.spec.name === 'shell.top').component({ usePanelInfo: () => ({}) })
  const findButton = (node, label) => {
    if (!node || typeof node !== 'object') return undefined
    if (node.type === 'button' && node.children.includes(label)) return node
    for (const child of node.children ?? []) {
      const found = Array.isArray(child) ? child.map(item => findButton(item, label)).find(Boolean) : findButton(child, label)
      if (found) return found
    }
  }
  assert.ok(findButton(top, '重试工作场景'))
  await findButton(top, '重试工作场景').props.onClick()
  assert.equal(attempts, 2)
  top = registrations.find(item => item.spec.name === 'shell.top').component({ usePanelInfo: () => ({}) })
  const names = []
  const visit = node => { if (!node || typeof node !== 'object') return; if (typeof node.type === 'function') names.push(node.type.name); for (const child of node.children ?? []) Array.isArray(child) ? child.forEach(visit) : visit(child) }
  visit(top)
  const menu = top.children.find(node => node?.type?.name === 'BusinessMenu')
  assert.equal(menu?.props.SceneTabs, chunk.SceneTabs, 'retry loads scene controls into the existing business navigation')
})

test('scene navigation exposes config reload after a failed request and refreshes edited JSON', async () => {
  let chunkRegistration
  let configFetches = 0
  const config = await readClientSceneConfig()
  config.scenes[0].label = '本地新场景名'
  const savedState = defaultSceneWorkbench(config)
  const dockLayouts = normalizeDockLayouts(config, { version: 2, scenes: {} }, savedState.layouts)
  const source = await readFile(sceneChunkUrl, 'utf8')
  const state = { current: undefined }
  let effectIndex = 0
  const effectDependencies = []
  const React = {
    createElement: (type, props, ...children) => ({ type, props, children }),
    useState(initial) { if (initial && typeof initial === 'object' && 'config' in initial) { state.current ??= initial; return [state.current, value => { state.current = value }] }; return [typeof initial === 'function' ? initial() : initial, () => {}] },
    useRef: initial => ({ current: initial }),
    useLayoutEffect() {},
    useEffect(effect, dependencies) {
      const index = effectIndex++
      const previous = effectDependencies[index]
      effectDependencies[index] = dependencies
      if (!previous || dependencies.some((value, item) => value !== previous[item])) effect()
    },
  }
  runInNewContext(source, {
    window: { __ModuleLoader__: { load(value) { chunkRegistration = value } } },
    fetch: async url => {
      if (url === '/tradeloom/scenes') {
        configFetches++
        if (configFetches === 1) throw new Error('offline')
        return { ok: true, async json() { return config } }
      }
      if (url === '/tradeloom/scene-layouts') return { ok: true, async json() { return savedState } }
      if (url === '/tradeloom/dock-layouts') return { ok: true, async json() { return dockLayouts } }
      throw new Error(`unexpected request ${url}`)
    },
  })
  const exports = chunkRegistration.factory(() => React)
  function buttons(node, found = []) {
    if (!node || typeof node !== 'object') return found
    if (node.type === 'button') found.push(node)
    for (const child of node.children ?? []) Array.isArray(child) ? child.forEach(item => buttons(item, found)) : buttons(child, found)
    return found
  }
  const renderTabs = () => { effectIndex = 0; return exports.SceneTabs() }
  let tree = renderTabs()
  await new Promise(resolve => setImmediate(resolve))
  tree = renderTabs()
  assert.match(JSON.stringify(tree), /场景配置暂时无法读取|工作场景暂时无法读取|读取场景配置失败|无法读取场景/,
    'the scene strip reports an unavailable config without adding a separate toolbar action')
  await exports.retryLoadConfig()
  await new Promise(resolve => setImmediate(resolve))
  tree = renderTabs()
  assert.equal(configFetches, 2)
  assert.ok(buttons(tree).some(button => button.props['aria-label'] === '本地新场景名'))
  assert.equal(buttons(tree).some(button => button.children.includes('刷新场景配置')), false,
    'scene config refresh is moved out of the scene tab strip into the shell tools menu')
  const sceneTabButtons = buttons(tree).filter(button => button.props?.className === 'tl-scene-tab')
  assert.equal(sceneTabButtons.length, 5, 'only business scenes occupy the primary scene rail')
  assert.ok(buttons(tree).some(button => button.children.includes('工具')))
  assert.ok(buttons(tree).some(button => button.children.includes('运行记录')))
  assert.ok(buttons(tree).some(button => button.children.includes('ERPNext')))
  for (const button of sceneTabButtons) {
    assert.equal(button.children[0]?.children?.[0]?.type, 'svg', `${button.props['aria-label']} should use a recognizable inline icon`)
    assert.equal(button.children[1]?.props?.className, 'tl-scene-tab-label')
    assert.equal(button.children[1]?.children?.[0], button.props['aria-label'], 'the compact tab retains its readable label for hover/focus/current styling')
  }
})

test('an empty scene list is rejected and leaves the top navigation retry available', async () => {
  let chunkRegistration
  const state = { current: undefined }
  let effectCount = 0
  const React = {
    createElement: (type, props, ...children) => ({ type, props, children }),
    useState(initial) { if (initial && typeof initial === 'object' && 'config' in initial) { state.current ??= initial; return [state.current, value => { state.current = value }] }; return [typeof initial === 'function' ? initial() : initial, () => {}] },
    useRef: initial => ({ current: initial }),
    useLayoutEffect() {},
    useEffect(effect) { effect() },
  }
  runInNewContext(await readFile(sceneChunkUrl, 'utf8'), {
    window: { __ModuleLoader__: { load(value) { chunkRegistration = value } } },
    fetch: async url => ({ ok: true, async json() { return url === '/tradeloom/scenes'
      ? { version: 1, scenes: [] }
      : { version: 1, activeSceneId: 'center', roleByScene: { center: 'center' }, layouts: {} } } }),
  })
  const exports = chunkRegistration.factory(() => React)
  exports.SceneTabs()
  await new Promise(resolve => setImmediate(resolve))
  const tree = exports.SceneTabs()
  assert.ok(JSON.stringify(tree).includes('工作场景暂时无法读取'), 'empty configuration must not reach SceneWorkbench')
  assert.ok(tree.children.some(child => child?.props?.role === 'status'), 'the scene row reports the failure while reload stays in the shell tools menu')
})

test('switching scenes keeps each role bound to its own native Session and composer', async () => {
  let chunkRegistration
  const React = {
    createElement: (type, props, ...children) => ({ type, props, children }),
    useState: initial => [initial, () => {}], useEffect() {},
  }
  runInNewContext(await readFile(sceneChunkUrl, 'utf8'), { window: { __ModuleLoader__: { load(value) { chunkRegistration = value } } } })
  const exports = chunkRegistration.factory(() => React)
  const config = await readClientSceneConfig()
  const center = exports.bindSession({}, 'center', 'center-session', config)
  const product = exports.bindSession(center, 'product', 'product-session', config)
  assert.deepEqual(JSON.parse(JSON.stringify(product)), { center: 'center-session', product: 'product-session' })
  const centerReference = exports.retainRoleSession({ retain: sessionId => ({ sessionId, release() {} }) }, 'center', product.center)
  const productReference = exports.retainRoleSession({ retain: sessionId => ({ sessionId, release() {} }) }, 'product', product.product)
  assert.equal(centerReference.sessionId, 'center-session')
  assert.equal(productReference.sessionId, 'product-session')
  assert.notStrictEqual(centerReference, productReference)
  exports.releaseRoleSessions()
})

test('scene config endpoint returns editable scenes and the live business origin to an authenticated GET', async () => {
  const expected = await readFile(sceneConfigUrl, 'utf8')
  let storeReads = 0
  let storeWrites = 0
  const handler = createScenesHandler({
    connection: { requestRejection: () => undefined },
    webServer: { getOrigin: () => 'http://192.168.1.23:3088' },
  }, { createStateStore: async () => ({
    async read() {
      storeReads++
      return { roles: {
        center: { sessionId: 'tl-center-existing' },
        product: { sessionId: 'session-product-existing' },
        delivery: { sessionId: '' },
        unknown: { sessionId: 'session-unknown' },
        market: { sessionId: 'not valid' },
      } }
    },
    async transact() { storeWrites++; throw new Error('scene GET must not write') },
  }) })
  const req = Readable.from([])
  req.method = 'GET'
  const res = { headers: {}, statusCode: 200, body: '', setHeader(name, value) { this.headers[name] = value }, end(value = '') { this.body = value } }
  await handler(req, res)
  assert.equal(res.statusCode, 200)
  assert.equal(res.headers['cache-control'], 'no-store')
  const body = JSON.parse(res.body)
  assert.deepEqual(body, {
    ...JSON.parse(expected), businessOrigin: 'http://192.168.1.23:3088',
    roles: publicRoleMetadata(),
    sessionBindings: { center: 'tl-center-existing', product: 'session-product-existing' },
    sessionBindingMetadata: {
      center: { scope: 'role', roleId: 'center', sessionId: 'tl-center-existing', workspaceId: null, archiveState: 'unknown', bindingRevision: '1' },
      product: { scope: 'role', roleId: 'product', sessionId: 'session-product-existing', workspaceId: null, archiveState: 'unknown', bindingRevision: '1' },
    },
  })
  assert.equal(storeReads, 1, 'scene GET reads persisted role bindings once')
  assert.equal(storeWrites, 0, 'scene GET never creates a session or writes state')
  assert.ok(body.roles.every(role => Object.keys(role).sort().join(',') === 'assistantLabel,id,label'))
  for (const privateField of ['preset', 'prompt', 'tool', 'session', 'workspace']) {
    assert.equal(JSON.stringify(body.roles).toLowerCase().includes(privateField), false, `public role metadata does not expose ${privateField}`)
  }
  const rejected = createScenesHandler({ connection: { requestRejection: () => 401 } }, {
    readScenes: async () => { throw new Error('must not read') },
    createStateStore: async () => { throw new Error('must not open state') },
  })
  const deniedReq = Readable.from([]); deniedReq.method = 'GET'
  const deniedRes = { statusCode: 200, end(value = '') { this.body = value } }
  await rejected(deniedReq, deniedRes)
  assert.equal(deniedRes.statusCode, 401)
  assert.equal(deniedRes.body, '')
})



test('workflow business tabs lazy-load the actual canvas, retry safely, keep both views mounted and bridge only the existing center model catalog', {
  skip: !process.env.TRADELOOM_REACT_LIBRARY || !process.env.TRADELOOM_REACT_SERVER_LIBRARY || !process.env.TRADELOOM_DOM_MODULE,
}, async () => {
  const { createRequire } = await import('node:module')
  const nodeRequire = createRequire(import.meta.url)
  const React = nodeRequire(process.env.TRADELOOM_REACT_LIBRARY)
  const pinnedRequire = createRequire(process.env.TRADELOOM_REACT_SERVER_LIBRARY)
  const { createRoot } = pinnedRequire('react-dom/client')
  const act = React.act ?? pinnedRequire('react-dom/test-utils').act
  const { JSDOM } = nodeRequire(process.env.TRADELOOM_DOM_MODULE)
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: 'http://desktop.local/', pretendToBeVisual: true })
  const globals = ['window', 'document', 'navigator', 'MutationObserver', 'ResizeObserver', 'getComputedStyle', 'IS_REACT_ACT_ENVIRONMENT'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)])
  let root
  const cleanupEffects = []
  class FixtureResizeObserver {
    constructor(callback) { this.callback = callback; this.targets = new Set() }
    observe(target) {
      this.targets.add(target)
      this.callback([...this.targets].map(item => ({ target: item, contentRect: item.getBoundingClientRect() })))
    }
    unobserve(target) { this.targets.delete(target) }
    disconnect() { this.targets.clear() }
  }
  try {
    dom.window.ResizeObserver = FixtureResizeObserver
    for (const [key, value] of Object.entries({ window: dom.window, document: dom.window.document, navigator: dom.window.navigator,
      MutationObserver: dom.window.MutationObserver, ResizeObserver: FixtureResizeObserver,
      getComputedStyle: dom.window.getComputedStyle.bind(dom.window), IS_REACT_ACT_ENVIRONMENT: true })) {
      Object.defineProperty(globalThis, key, { configurable: true, writable: true, value })
    }
    const config = await readClientSceneConfig()
    config.sessionBindings = { center: 'existing-center-session' }
    const saved = defaultSceneWorkbench(config)
    saved.activeSceneId = 'agent-center'
    const dockLayouts = normalizeDockLayouts(config, { version: 2, scenes: {} }, saved.layouts)
    const beforeSaved = JSON.stringify(dockLayouts)
    const requests = []
    const doc = { version: 1, id: 'fixture-workflow', title: '商品核对画布', description: '', source: 'local_mock', confirmed: false,
      nodes: [{ id: 'agent-a', kind: 'agent', agent: 'center', title: '核对商品', instruction: '', model: null, position: { x: 40, y: 60 } }], edges: [] }
    const fetch = async (url, options = {}) => {
      requests.push([String(url), options.method ?? 'GET'])
      let value
      if (url === '/tradeloom/scenes') value = config
      else if (url === '/tradeloom/scene-layouts') value = saved
      else if (url === '/tradeloom/dock-layouts') value = dockLayouts
      else if (url === '/tradeloom/workflows') value = { catalog: { agents: [{ id: 'center', label: '中心助手', icon: '◎', color: '#356fc4' }], kinds: [] }, workflows: [{ id: doc.id, title: doc.title }] }
      else if (String(url).startsWith('/tradeloom/workflows?id=')) value = { workflow: doc, run: null }
      else throw new Error('Unexpected integration request: ' + url)
      return { ok: true, json: async () => value }
    }
    let registration
    const context = { window: { ...dom.window, __ModuleLoader__: { load(value) { registration = value } } }, document: dom.window.document,
      MutationObserver: dom.window.MutationObserver, ResizeObserver: FixtureResizeObserver,
      getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
      fetch, setTimeout, clearTimeout, setInterval, clearInterval, URLSearchParams }
    // Keep the real Window instance: DOM/File/realm behavior must not be mocked.
    context.window = dom.window
    dom.window.__ModuleLoader__ = { load(value) { registration = value } }
    runInNewContext(await readFile(sceneChunkUrl, 'utf8'), context)
    const sceneRegistration = registration
    runInNewContext(await readFile(new URL('../client.workflow.js', import.meta.url), 'utf8'), context)
    const workflowRegistration = registration
    const workflow = workflowRegistration.factory(name => { assert.equal(name, 'react'); return React })
    let lazyCalls = 0, mounts = 0, unmounts = 0, canvasProps
    function CanvasProbe(props) {
      canvasProps = props
      React.useEffect(() => { mounts++; return () => { unmounts++ } }, [])
      return React.createElement(workflow.WorkflowCanvas, props)
    }
    const require = Object.assign(name => { if (name === 'react') return React; throw new Error('Optional module unavailable') }, {
      async: async name => { assert.equal(name, './client.workflow.js'); lazyCalls++; if (lazyCalls === 1) throw new Error('one isolated load failure'); return { default: { WorkflowCanvas: CanvasProbe } } },
    })
    const scenes = sceneRegistration.factory(require)
    assert.equal(typeof scenes.useRoleModelGroups, 'function')
    const retained = [], released = [], directoryCalls = [], subscribers = new Set()
    const directorySnapshot = { groups: [{ id: 'provider-a', name: '接口 A', models: [{ id: 'model-a', name: '模型 A' }] }] }
    scenes.register({
      sessions: { list: { getSnapshot: () => ({ phase: 'ready', ids: ['existing-center-session'] }), subscribe: () => () => {} },
        retain: id => { retained.push(id); return { sessionId: id, ready: Promise.resolve(), release: () => released.push(id) } }, refresh: async () => {} },
      modelDirectories: { directoryFor: id => { directoryCalls.push(id); return { store: { getSnapshot: () => directorySnapshot, subscribe: fn => { subscribers.add(fn); return () => subscribers.delete(fn) } }, load: async () => {} } } },
      slots: { inject(_name, fn) { fn() }, register() {} }, effect: fn => cleanupEffects.push(fn),
      theme: { getTheme: () => ({ active: { colorScheme: 'dark' } }) },
    })
    await scenes.retryLoadConfig()
    const panel = config.scenes.find(scene => scene.id === 'agent-center').panels.find(panel => panel.id === 'business-main')
    assert.deepEqual(panel.frontendTabs.map(tab => tab.id), ['plans', 'canvas'])
    root = createRoot(dom.window.document.getElementById('root'))
    await act(async () => { root.render(React.createElement(scenes.BusinessPaneTabs, { panel, path: '/agent-center', refreshKey: 0, sceneId: 'agent-center' })); await new Promise(resolve => setTimeout(resolve, 10)) })
    const host = dom.window.document.getElementById('root')
    const iframe = host.querySelector('iframe'), browsingContext = iframe.contentWindow
    assert.equal(lazyCalls, 1, 'the workflow entry defaults to the actual canvas and attempts its lazy chunk')
    assert.deepEqual(retained, ['existing-center-session'], 'the default canvas uses only the existing center session')
    const click = async label => { await act(async () => { [...host.querySelectorAll('button')].find(button => button.textContent === label).click(); await new Promise(resolve => setTimeout(resolve, 25)) }) }
    await click('工作流画布')
    assert.match(host.textContent, /工作流画布暂时无法加载/)
    assert.ok(host.querySelector('iframe') === iframe && iframe.closest('[role="tabpanel"]').hidden)
    await click('重试画布')
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 25)) })
    assert.ok(host.querySelector('.tl-wf[aria-label="工作流画布"]'), 'the production WorkflowCanvas component is mounted inside the existing business pane')
    assert.equal(host.querySelector('.tl-wf').closest('[role="tabpanel"]').hidden, false)
    assert.deepEqual(JSON.parse(JSON.stringify(canvasProps.modelGroups)), [{ provider: 'provider-a', providerName: '接口 A', models: [{ provider: 'provider-a', id: 'model-a', name: '模型 A' }] }])
    assert.equal(Object.hasOwn(canvasProps, 'initial'), false, 'production wiring never supplies fixture initial data')
    assert.deepEqual(retained, ['existing-center-session'])
    assert.deepEqual(directoryCalls, ['existing-center-session'])
    const canvasNode = host.querySelector('.tl-wf')
    await click('业务计划')
    assert.equal(host.querySelector('iframe'), iframe)
    assert.equal(iframe.contentWindow, browsingContext)
    assert.equal(iframe.closest('[role="tabpanel"]').hidden, false)
    assert.equal(canvasNode.closest('[role="tabpanel"]').hidden, true)
    await click('工作流画布')
    assert.equal(host.querySelector('.tl-wf'), canvasNode)
    assert.equal(lazyCalls, 2, 'a successful loaded canvas is reused across view switches')
    assert.equal(mounts, 1); assert.equal(unmounts, 0)
    directorySnapshot.groups = [{ id: 'provider-b', name: '接口 B', models: [{ id: 'model-b', name: '模型 B' }] }]
    await act(async () => { for (const fn of subscribers) fn() })
    assert.equal(canvasProps.modelGroups[0].provider, 'provider-b', 'read-only existing directory notifications update canvas model choices')
    assert.equal(JSON.stringify(dockLayouts), beforeSaved, 'internal view selection never rewrites the saved Dockview grid or closed panel state')
    assert.equal(requests.some(([, method]) => method !== 'GET'), false, 'view selection does not create sessions, start runs, or write layout')
    assert.equal(requests.some(([url]) => /session/.test(url)), false)
  } finally {
    if (root) await act(async () => root.unmount())
    for (const fn of cleanupEffects) fn()?.()
    for (const [key, descriptor] of globals) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key] }
    dom.window.close()
  }
})
