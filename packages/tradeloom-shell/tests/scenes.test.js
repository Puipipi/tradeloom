import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { runInNewContext } from 'node:vm'
import { Readable } from 'node:stream'
import test from 'node:test'
import { ROLE_IDS } from '../state.js'
import { createScenesHandler } from '../host.js'
import { defaultSceneWorkbench } from '../scene-layout.js'
import { normalizeDockLayouts } from '../dock-layout.js'
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
    ['agent-center', '任务', 'center'],
    ['deliverables', '交付物', 'delivery'],
    ['runs', '运行记录', 'center'],
    ['user-profile', '资料整理', 'user-profile'],
    ['erpnext', 'ERPNext', 'center'],
  ])
  assert.deepEqual(config.scenes.map(scene => scene.icon), ['⌂', '▦', '◉', '⇩', '≋', '◈', '▤'],
    'each scene has a compact, accessible glyph for the unified navigation rail')
  assert.ok(config.scenes.every(scene => ROLE_IDS.includes(scene.roleId)))
  assert.deepEqual(Object.keys(config.businessRoutes).sort(), ['/agent-center', '/artifacts', '/home', '/products', '/runs'])
  assert.deepEqual(config.businessRoutes['/agent-center'], { sceneId: 'agent-center', panelId: 'business-main' })
  assert.deepEqual(config.businessRoutes['/products'], { sceneId: 'products', panelId: 'business-main' })
  assert.deepEqual(config.businessRoutes['/artifacts'], { sceneId: 'deliverables', panelId: 'business-main' })
  assert.deepEqual(config.businessRoutes['/runs'], { sceneId: 'runs', panelId: 'business-main' })
  for (const scene of config.scenes) {
    assert.deepEqual(new Set(scene.panels.map(panel => panel.id)).size, scene.panels.length)
    const business = scene.panels.find(panel => panel.id === 'business-main')
    const auxiliary = scene.panels.find(panel => panel.id === 'auxiliary')
    const reference = scene.panels.find(panel => panel.id === 'reference')
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
  assert.deepEqual(JSON.parse(JSON.stringify(exports.sceneNavigationItems(config))), [
    { id: 'center', label: '工作总览', icon: '⌂', route: '/home' },
    { id: 'products', label: '商品', icon: '▦', route: '/products' },
    { id: 'agent-center', label: '任务', icon: '◉', route: '/agent-center' },
    { id: 'deliverables', label: '交付物', icon: '⇩', route: '/artifacts' },
    { id: 'runs', label: '运行记录', icon: '≋', route: '/runs' },
    { id: 'user-profile', label: '资料整理', icon: '◈', route: null },
    { id: 'erpnext', label: 'ERPNext', icon: '▤', route: null },
  ])
  const current = { config, activeSceneId: 'center', businessPath: '/home', layouts: bothStates }
  const selectedProfile = exports.selectScene(current, 'user-profile')
  assert.equal(selectedProfile.activeSceneId, 'user-profile')
  assert.equal(selectedProfile.businessPath, '/artifacts', 'a scene without a menu default opens its configured main business panel')
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

test('native chat panel uses the pinned conversation factory', async () => {
  let registration
  runInNewContext(await readFile(sceneChunkUrl, 'utf8'), {
    window: { __ModuleLoader__: { load(value) { registration = value } } },
  })
  const React = { Fragment: 'Fragment', createElement: (type, props, ...children) => ({ type, props, children }) }
  const exports = registration.factory(() => React)
  let factoryCall
  const node = exports.SceneChatPanel({
    sessionId: 'session-center',
    renderFactorySlot(...args) { factoryCall = args; return { conversation: true } },
  })
  assert.deepEqual(node, { conversation: true })
  assert.equal(factoryCall[0], 'conversation.content')
  assert.deepEqual(JSON.parse(JSON.stringify(factoryCall[1])), { variant: 'embedded', phase: 'active', hero: false })
  assert.equal(typeof factoryCall[2].slots.views, 'function')
  const renderedView = factoryCall[2].slots.views({ renderSlot(name, owner) { return { name, owner } } })
  assert.deepEqual(JSON.parse(JSON.stringify(renderedView)), { type: 'Fragment', props: null, children: [{ name: 'conversation.session', owner: { view: 'chat' } }] })

})

test('ERPNext status panel reads Django status on entry and rechecks when its panel refresh key changes', async () => {
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
    React,
    fetch: async url => {
      requests.push(url)
      return { ok: true, async json() { return {
        configured: true, connected: true, status: 'connected', error_code: '', base_url: 'must-not-render',
      } } }
    },
    window: { __ModuleLoader__: { load(value) { registration = value } } },
  })
  const component = registration.factory(() => React).ERPNextStatus
  const flatten = node => typeof node === 'string' ? node : Array.isArray(node) ? node.map(flatten).join(' ') : node?.children?.map(flatten).join(' ') ?? ''

  component({ refreshKey: 0 })
  await new Promise(resolve => setImmediate(resolve))
  const connected = flatten(component({ refreshKey: 0 }))
  assert.equal(connected.includes('ERPNext 已连接'), true)
  assert.equal(connected.includes('must-not-render'), false)
  assert.deepEqual(requests, ['/business-api/erpnext/status'])

  component({ refreshKey: 1 })
  await new Promise(resolve => setImmediate(resolve))
  component({ refreshKey: 1 })
  assert.deepEqual(requests, ['/business-api/erpnext/status', '/business-api/erpnext/status'])
})

test('scene chat renders the pinned conversation factory inside its retained role SessionProvider', async () => {
  let registration
  const sceneConfig = await readClientSceneConfig()
  const componentStates = new WeakMap()
  let activeComponent
  let hookIndex = 0
  const fetchCalls = []
  const legacyState = defaultSceneWorkbench(sceneConfig)
  const dockLayouts = normalizeDockLayouts(sceneConfig, { version: 2, scenes: {} }, legacyState.layouts)
  const React = {
    Fragment: 'Fragment',
    createElement(type, props, ...children) { return { type, props: props ?? {}, children } },
    useRef(initial) {
      let state = componentStates.get(activeComponent)
      if (!state) { state = []; componentStates.set(activeComponent, state) }
      const index = hookIndex++
      if (!(index in state)) state[index] = { current: initial }
      return state[index]
    },
    useState(initial) {
      let state = componentStates.get(activeComponent)
      if (!state) { state = []; componentStates.set(activeComponent, state) }
      const index = hookIndex++
      if (!(index in state)) state[index] = typeof initial === 'function' ? initial() : initial
      return [state[index], value => { state[index] = typeof value === 'function' ? value(state[index]) : value }]
    },
    useEffect(effect) { effect() },
  }
  runInNewContext(await readFile(sceneChunkUrl, 'utf8'), {
    React,
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
    window: { __ModuleLoader__: { load(value) { registration = value } } },
  })
  const dockPanels = new Map(sceneConfig.scenes[0].panels.map(panel => {
    const group = { id: 'test-group' }
    const api = {
      id: panel.id, group,
      setActive() {}, setTitle() {}, close() {}, maximize() {}, exitMaximized() {}, isMaximized() { return false },
    }
    return [panel.id, { id: panel.id, api }]
  }))
  const dockApi = {
    panels: [...dockPanels.values()],
    activePanel: dockPanels.values().next().value,
    fromJSON() {}, layout() {}, hasMaximizedGroup() { return false },
    getPanel(id) { return dockPanels.get(id) }, getPanels() { return [...dockPanels.values()] },
    onDidLayoutChange() { return { dispose() {} } }, onDidMaximizedGroupChange() { return { dispose() {} } },
  }
  let dockReady = false
  const dockviewModule = {
    dockviewCss: '',
    DockviewReact({ components, onReady }) {
      if (!dockReady) { dockReady = true; onReady({ api: dockApi }) }
      return React.createElement(components['native-chat'], {
        id: 'native-chat', sceneId: 'center', params: { panelId: 'native-chat' }, api: dockApi.getPanel('native-chat').api,
      })
    },
  }
  const sceneRequire = Object.assign(() => React, { async: async () => dockviewModule })
  const exports = registration.factory(sceneRequire)
  const reference = { ready: Promise.resolve(), release() {} }
  let sessionRetains = 0
  const invoke = (Component, props = {}) => {
    const previous = activeComponent
    activeComponent = Component
    hookIndex = 0
    try { return Component(props) } finally { activeComponent = previous }
  }
  exports.register({
    layout: { selectPanel() {} },
    sessions: { retain(sessionId, options) { sessionRetains++; assert.equal(sessionId, 'native-center-session'); assert.deepEqual(JSON.parse(JSON.stringify(options)), { source: 'mainView' }); return reference } },
    modelDirectories: { directoryFor() { throw new Error('not used in this test') } },
    slots: { inject(_name, register) { register() }, register() { return () => {} } },
    effect() {},
  })
  invoke(exports.SceneTabs)
  for (let attempt = 0; attempt < 20 && !exports.getSnapshot().config; attempt++) {
    await new Promise(resolve => setImmediate(resolve))
  }
  invoke(exports.SceneTabs)
  assert.equal(await exports.selectRole('center', 'native-center-session'), true)
  assert.equal(exports.getSnapshot().config?.scenes.length, 7, JSON.stringify({ error: exports.getSnapshot().configError, fetchCalls }))
  assert.equal(exports.getSnapshot().sessionBindings.center, 'native-center-session')
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
    renderSlot(name) {
      assert.equal(name, 'scene.workbench.chat')
      return invoke(exports.SceneChatPanel, {
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
  await new Promise(resolve => setImmediate(resolve))
  mounted = renderWorkbench()
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
  const panel = find(mounted, node => node.props?.['data-panel-id'] === 'native-chat')
  assert.ok(panel, 'Dockview mounts the registered native-chat panel')
  assert.strictEqual(providedSessions.at(-1), reference)
  assert.equal(providedViewKeys.at(-1), 'native-center-session:0')
  const refresh = find(panel, node => node.type === 'button' && node.props['aria-label'] === '重新载入对话视图')
  refresh.props.onClick()
  const refreshed = renderWorkbench()
  assert.strictEqual(providedSessions.at(-1), reference, 'refresh keeps the existing native SessionProvider reference')
  assert.equal(providedViewKeys.at(-1), 'native-center-session:1', 'refresh remounts only the conversation view subtree')
  assert.equal(sessionRetains, 1, 'refresh does not create or retain another native session')
  assert.equal(fetchCalls.some(([, method]) => method === 'POST'), false, 'refresh sends no model/session request')
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
    ['retain', 'session-center', { source: 'mainView' }],
    ['retain', 'session-product', { source: 'mainView' }],
  ])
  assert.deepEqual(calls.filter(call => call[0] === 'release'), [], 'scene switches must not dispose another role composer')

  exports.releaseRoleSessions()
  assert.deepEqual(calls.filter(call => call[0] === 'release'), [
    ['release', 'session-center'], ['release', 'session-product'],
  ], 'the bounded role pool is released when the workbench context ends')
})

test('role selection binds the AgentDirectory session response without a duplicate request', async () => {
  let registration
  let sessionPosts = 0
  const source = await readFile(sceneChunkUrl, 'utf8')
  const config = await readClientSceneConfig()
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
  const React = { createElement(type, props, ...children) { return { type, props, children } }, useState: value => [value, () => {}], useEffect(effect) { effect() } }
  const exports = registration.factory(() => React)
  exports.register({ layout: { selectPanel() {} }, sessions: { retain() {} }, slots: { inject(_name, register) { register() }, register() {} }, effect() {} })
  exports.SceneTabs()
  for (let attempt = 0; attempt < 20 && !exports.getSnapshot().config; attempt++) await new Promise(resolve => setImmediate(resolve))
  assert.equal(await exports.selectRole('product', 'session-product'), true)
  assert.equal(sessionPosts, 0, 'the caller already created the session; selecting the role must bind it without another POST')
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
  assert.equal(exports.currentModelLabel({ provider: 'provider-a', model: 'model-a' }, groups), '接口 A · 模型 A')
  assert.equal(exports.currentModelLabel({ provider: 'removed-provider', model: 'secret-raw-id' }, groups), '已选择模型',
    'the rail must never fall back to exposing provider or model identifiers')
  const config = await readClientSceneConfig()
  assert.deepEqual(config.roles.map(role => [role.id, role.assistantLabel]), [
    ['center', '中心助手'], ['product', '商品助手'], ['market', '市场助手'],
    ['quote', '询报价助手'], ['delivery', '交付助手'], ['user-profile', '资料助手'],
  ], 'role metadata keeps the original native conversation titles as a separate display field')
  assert.equal(exports.assistantLabel('delivery', config), '交付助手')
  assert.deepEqual(JSON.parse(JSON.stringify(exports.bindSession({ product: 'session-product' }, 'delivery', 'session-delivery', config))), {
    product: 'session-product', delivery: 'session-delivery',
  })
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
    useState: initial => [initial, () => {}],
    useRef: initial => ({ current: initial }),
    useEffect() {},
  }
  const chunk = chunkRegistration.factory(name => { assert.equal(name, 'react'); return React })
  const calls = []
  const slots = {
    inject(name, register) { calls.push({ name, result: register() }) },
    register(spec, component) { calls.push({ spec, component }); return () => {} },
  }
  const entryRequire = name => { assert.equal(name, 'react'); return React }
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
  assert.ok(modelRow, 'the compact helper chooser and model rail share the first top row')
  assert.equal(modelRow.children[0].type.name, 'AgentDirectory', 'the helper selector stays to the left of model controls')
  assert.equal(modelRow.children[1].type.name, 'ModelDirectoryRail')
  const railStyle = modelRow.children[1].type().children.find(child => child?.props?.['data-tradeloom-navigation-style'])
  assert.match(railStyle.children[0], /\.tl-model-rail\s*\{[\s\S]*display:\s*flex;\s*flex:\s*1 1 auto/,
    'the model rail grows to reserve the far-right theme control position')
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
      serviceCtx.reflect.provide('remote', { session: remoteSession })
      serviceCtx.reflect.provide('remote.session', remoteSession)
      serviceCtx.reflect.provide('theme', theme)
    },
  })

  const React = {
    createElement: (type, props, ...children) => ({ type, props, children }),
    useState: initial => [initial, value => stateUpdates.push(typeof value === 'function' ? value(initial) : value)],
    useRef: initial => ({ current: initial }),
    useEffect(effect) { effect() },
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
  const clientRequire = name => { assert.equal(name, 'react'); return React }
  clientRequire.async = async name => {
    assert.equal(name, './client.scenes.js')
    sceneExports = chunkRegistration.factory(clientRequire)
    return sceneExports
  }
  const client = entryRegistration.factory(clientRequire)
  assert.ok(client.inject.includes('remote') && client.inject.includes('remote.session'),
    'the shell root must declare both native model-directory remote dependencies')
  const clientFiber = ctx.registry.plugin({
    name: 'tradeloom-business-shell-client-test',
    inject: client.inject,
    apply(clientContext) {
      assert.strictEqual(clientContext.remote.session, remoteSession,
        'the root shell context can access the native model catalog dependency on first entry')
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
    useEffect(effect) { effect() },
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

test('business and scene navigation share the single rendered shell.top occupant', async () => {
  const entrySource = await readFile(new URL('../client.js', import.meta.url), 'utf8')
  const topSlotPatch = await readFile(new URL('../../../integrations/dsh/patches/ui-layout-shell-top.patch', import.meta.url), 'utf8')
  assert.match(topSlotPatch, /\+\s+'shell\.top': \{ kind: 'single'; scope: 'root' \}/)
  assert.match(topSlotPatch, /renderSlot\('shell\.top', \{\}\)/)
  let entryRegistration
  runInNewContext(entrySource, { window: { __ModuleLoader__: { load(value) { entryRegistration = value } } } })
  let chunkRegistration
  runInNewContext(await readFile(sceneChunkUrl, 'utf8'), { window: { __ModuleLoader__: { load(value) { chunkRegistration = value } } } })
  const React = {
    createElement: (type, props, ...children) => ({ type, props, children }),
    useState: initial => [initial, () => {}],
    useRef: initial => ({ current: initial }),
    useEffect() {},
  }
  const chunk = chunkRegistration.factory(() => React)
  const calls = []
  const slots = {
    inject(_name, register) { register() },
    register(spec, component) {
      if (spec.name === 'shell.top' && calls.some(call => call.spec.name === 'shell.top')) {
        throw new Error('single slot shell.top already has an occupant')
      }
      calls.push({ spec, component })
      return () => {}
    },
  }
  const entryRequire = name => { assert.equal(name, 'react'); return React }
  entryRequire.async = async name => { assert.equal(name, './client.scenes.js'); return chunk }
  const plugin = entryRegistration.factory(entryRequire)
  await plugin.apply({ slots, layout: { selectPanel() {} }, uiWorkspace: { openSession() {} } })

  const top = calls.filter(call => call.spec.name === 'shell.top')
  assert.equal(top.length, 1)
  const tree = top[0].component({ usePanelInfo: () => ({}) })
  const componentNames = []
  const visit = node => { if (!node || typeof node !== 'object') return; if (typeof node.type === 'function') componentNames.push(node.type.name); for (const child of node.children ?? []) Array.isArray(child) ? child.forEach(visit) : visit(child) }
  visit(tree)
  assert.ok(componentNames.includes('BusinessMenu'))
  const menuElement = tree.children.find(node => node?.type?.name === 'BusinessMenu')
  assert.equal(menuElement.props.SceneTabs, chunk.SceneTabs, 'scene controls are rendered inside the existing business navigation owner')
  const menuTree = menuElement.type({ ...menuElement.props, usePanelInfo: () => ({}) })
  const navs = []
  const findNavs = node => { if (!node || typeof node !== 'object') return; if (node.type === 'nav') navs.push(node); for (const child of node.children ?? []) Array.isArray(child) ? child.forEach(findNavs) : findNavs(child) }
  findNavs(menuTree)
  assert.equal(navs.length, 1, 'the unified row has one navigation landmark')
  assert.equal(navs[0].props.className, 'tl-navigation')
  assert.ok(navs[0].children.some(child => child?.type === chunk.SceneTabs), 'scene tabs remain in the second navigation row after its scoped style node')
  const navStyle = navs[0].children.find(child => child?.props?.['data-tradeloom-nav-style'])
  assert.match(navStyle.children[0], /\.tl-navigation \.tl-scene-tab \{ font: inherit; color: inherit; background: transparent; \}/,
    'scene controls inherit the unified navigation typography')
  assert.ok(navs[0].children.some(child => child?.type === 'button' && child.children.includes('连接手机')),
    'the existing phone action remains in the unified navigation')
})

test('agent selector shows scene-config failure and retries the existing request until role metadata loads', async () => {
  const entrySource = await readFile(new URL('../client.js', import.meta.url), 'utf8')
  const chunkSource = await readFile(sceneChunkUrl, 'utf8')
  let entryRegistration
  let chunkRegistration
  let fetch
  const elements = (type, props, ...children) => ({ type, props: props ?? {}, children })
  const hookValues = []
  let hookIndex = 0
  const React = {
    createElement: elements, Fragment: 'fragment',
    useState(initial) {
      const index = hookIndex++
      if (!(index in hookValues)) hookValues[index] = initial
      return [hookValues[index], next => { hookValues[index] = typeof next === 'function' ? next(hookValues[index]) : next }]
    },
    useRef(initial) {
      const index = hookIndex++
      if (!(index in hookValues)) hookValues[index] = { current: initial }
      return hookValues[index]
    },
    useEffect(effect) { effect() },
  }
  const window = {
    location: { origin: 'http://desktop.local' },
    document: { querySelectorAll: () => [], addEventListener() {}, removeEventListener() {} },
    addEventListener() {}, removeEventListener() {},
    __ModuleLoader__: { load(value) { entryRegistration = value } },
  }
  runInNewContext(entrySource, { window, fetch: (...args) => fetch(...args) })
  runInNewContext(chunkSource, { window: { __ModuleLoader__: { load(value) { chunkRegistration = value } } }, fetch: (...args) => fetch(...args) })

  const config = await readClientSceneConfig()
  const saved = defaultSceneWorkbench(config)
  const dockLayouts = normalizeDockLayouts(config, { version: 2, scenes: {} }, saved.layouts)
  let sceneFetches = 0
  const requests = []
  const capabilityRequests = new Map()
  const capabilityFetchOptions = []
  fetch = async (url, options = {}) => {
    requests.push([url, options.method ?? 'GET'])
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
  const clientRequire = name => { assert.equal(name, 'react'); return React }
  let sceneExports
  clientRequire.async = async name => {
    assert.equal(name, './client.scenes.js')
    sceneExports = chunkRegistration.factory(clientRequire)
    return sceneExports
  }
  const slots = { registrations: [], inject(_name, callback) { callback() }, register(spec, component) { this.registrations.push({ spec, component }); return () => {} } }
  const client = entryRegistration.factory(clientRequire)
  await client.apply({
    layout: { selectPanel() {} }, uiWorkspace: { openSession() {} },
    sessions: { retain() {} }, modelDirectories: {}, remote: { session: {} }, theme: { getTheme: () => ({ active: { colorScheme: 'light' } }) },
    on() {}, off() {}, effect() {}, slots,
  })

  function find(node, predicate) {
    if (!node || typeof node !== 'object') return undefined
    if (predicate(node)) return node
    for (const child of node.children ?? []) {
      const result = Array.isArray(child) ? child.map(item => find(item, predicate)).find(Boolean) : find(child, predicate)
      if (result) return result
    }
  }
  const getTop = () => slots.registrations.find(item => item.spec.name === 'shell.top').component({ usePanelInfo: () => ({}) })
  const sceneTabs = find(getTop(), node => node.type?.name === 'BusinessMenu')?.props.SceneTabs
  sceneTabs()
  for (let attempt = 0; attempt < 20; attempt++) await new Promise(resolve => setImmediate(resolve))

  const agentElement = find(getTop(), node => node.type?.name === 'AgentDirectory')
  const renderAgent = () => { hookIndex = 0; return agentElement.type(agentElement.props) }
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
  await new Promise(resolve => setImmediate(resolve))
  capabilityRequests.get('center')({ ok: true, async json() { return centerResult } })
  await new Promise(resolve => setImmediate(resolve))
  agentTree = renderAgent()
  assert.ok(find(agentTree, node => node.type === 'strong' && node.children?.includes('product-skill')),
    'a late response for the previously selected role cannot replace the current role capability result')
  assert.deepEqual(requests.filter(([url]) => url.startsWith('/tradeloom/agent-capabilities?')), [
    ['/tradeloom/agent-capabilities?role=center', 'GET'],
    ['/tradeloom/agent-capabilities?role=product', 'GET'],
  ])
  assert.ok(capabilityFetchOptions.every(options => options.credentials === 'same-origin' && !('body' in options)),
    'the UI uses authenticated same-origin read requests without session IDs or write payloads')

  let reread = find(agentTree, node => node.type === 'button' && node.children?.includes('重新读取'))
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
  const entryRequire = name => { assert.equal(name, 'react'); return React }
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
  let initialEffects = 0
  const React = {
    createElement: (type, props, ...children) => ({ type, props, children }),
    useState(initial) { state.current ??= initial; return [state.current, value => { state.current = value }] },
    useEffect(effect) { if (initialEffects++ < 2) effect() },
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
  let tree = exports.SceneTabs()
  await new Promise(resolve => setImmediate(resolve))
  tree = exports.SceneTabs()
  let reload = buttons(tree).find(button => button.children.includes('重试读取场景'))
  assert.ok(reload, 'top navigation must offer retry when scene configuration cannot load')
  await reload.props.onClick()
  await new Promise(resolve => setImmediate(resolve))
  tree = exports.SceneTabs()
  assert.equal(configFetches, 2)
  assert.ok(buttons(tree).some(button => button.props['aria-label'] === '本地新场景名'))
  assert.ok(buttons(tree).some(button => button.children.includes('刷新场景配置')))
})

test('an empty scene list is rejected and leaves the top navigation retry available', async () => {
  let chunkRegistration
  const state = { current: undefined }
  let effectCount = 0
  const React = {
    createElement: (type, props, ...children) => ({ type, props, children }),
    useState(initial) { state.current ??= initial; return [state.current, value => { state.current = value }] },
    useEffect(effect) { if (effectCount++ < 2) effect() },
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
  assert.ok(tree.children.some(child => child?.type === 'button' && child.children.includes('重试读取场景')))
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
  const handler = createScenesHandler({
    connection: { requestRejection: () => undefined },
    webServer: { getOrigin: () => 'http://192.168.1.23:3088' },
  })
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
  })
  assert.ok(body.roles.every(role => Object.keys(role).sort().join(',') === 'assistantLabel,id,label'))
  for (const privateField of ['preset', 'prompt', 'tool', 'session', 'workspace']) {
    assert.equal(JSON.stringify(body.roles).toLowerCase().includes(privateField), false, `public role metadata does not expose ${privateField}`)
  }
  const rejected = createScenesHandler({ connection: { requestRejection: () => 401 } }, { readScenes: async () => { throw new Error('must not read') } })
  const deniedReq = Readable.from([]); deniedReq.method = 'GET'
  const deniedRes = { statusCode: 200, end(value = '') { this.body = value } }
  await rejected(deniedReq, deniedRes)
  assert.equal(deniedRes.statusCode, 401)
  assert.equal(deniedRes.body, '')
})

