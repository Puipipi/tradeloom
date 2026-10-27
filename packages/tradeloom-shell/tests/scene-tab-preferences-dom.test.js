import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { runInNewContext } from 'node:vm'
import test from 'node:test'
import { publicRoleMetadata } from '../roles.js'
import { defaultSceneWorkbench } from '../scene-layout.js'
import { normalizeDockLayouts } from '../dock-layout.js'

const require = createRequire(import.meta.url)
const preferenceKey = 'tradeloom.workbench.scene-tabs'

async function harness(t, run, initialStorage) {
  const reactPath = process.env.TRADELOOM_REACT_LIBRARY
  const serverPath = process.env.TRADELOOM_REACT_SERVER_LIBRARY
  const domPath = process.env.TRADELOOM_DOM_MODULE
  if (!reactPath || !serverPath || !domPath) return t.skip('requires pinned React/JSDOM')
  const React = require(reactPath)
  const { createRoot } = createRequire(serverPath)('react-dom/client')
  const { JSDOM } = require(domPath)
  const dom = new JSDOM('<!doctype html><div id="root"></div><button id="outside">外部</button>', { url: 'http://fixture.local/', pretendToBeVisual: true })
  const prior = { window: globalThis.window, document: globalThis.document, IS_REACT_ACT_ENVIRONMENT: globalThis.IS_REACT_ACT_ENVIRONMENT }
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true })
  if (initialStorage !== undefined) dom.window.localStorage.setItem(preferenceKey, initialStorage)
  const config = JSON.parse(await readFile(new URL('../scenes.json', import.meta.url), 'utf8'))
  config.roles = publicRoleMetadata()
  config.sessionBindings = { center: 'same-title-a', product: 'same-title-b' }
  config.sessionBindingMetadata = { center: { scope: 'role', roleId: 'center', sessionId: 'same-title-a', workspaceId: 'fixture-workspace', archiveState: 'archived' } }
  let failure = false, deferredConfig
  const requests = [], cleanup = []
  const fetch = async (url, options = {}) => {
    requests.push([url, options.method || 'GET'])
    if ((options.method || 'GET') !== 'GET') throw new Error('this fixture permits read-only requests')
    if (failure) return { ok: false, json: async () => ({}) }
    if (url === '/tradeloom/scenes') {
      if (deferredConfig) return new Promise(resolve => { deferredConfig.resolve = value => resolve({ ok: true, json: async () => value }) })
      return { ok: true, json: async () => structuredClone(config) }
    }
    // A corrupt config response must not also corrupt the independently saved layout fixture.
    const layoutConfig = structuredClone(config)
    for (const scene of layoutConfig.scenes) for (const panel of scene.panels) if (panel.type === 'unknown-panel') panel.type = 'business-iframe'
    const sceneState = defaultSceneWorkbench(layoutConfig)
    if (url === '/tradeloom/scene-layouts') return { ok: true, json: async () => sceneState }
    if (url === '/tradeloom/dock-layouts') return { ok: true, json: async () => normalizeDockLayouts(layoutConfig, { version: 2, scenes: {} }, sceneState.layouts) }
    throw new Error('unexpected fixture route ' + url)
  }
  let registration
  dom.window.__ModuleLoader__ = { load(value) { registration = value } }
  runInNewContext(await readFile(new URL('../client.scenes.js', import.meta.url), 'utf8'), {
    window: dom.window, document: dom.window.document, fetch, File: dom.window.File, URL, URLSearchParams, setTimeout, clearTimeout,
  })
  const sceneRequire = name => { if (name === 'react') return React; throw new Error('optional module not loaded: ' + name) }
  const scenes = registration.factory(sceneRequire)
  let catalog = { phase: 'ready', ids: ['same-title-a', 'same-title-b', 'new-binding'] }
  const catalogListeners = new Set()
  const references = new Map(), retained = [], released = []
  let refresh = () => Promise.resolve()
  let readiness = () => Promise.resolve()
  const sessions = { list: { getSnapshot: () => catalog, subscribe: fn => { catalogListeners.add(fn); return () => catalogListeners.delete(fn) } },
    retain(id) { retained.push(id); const reference = { sessionId: id, ready: readiness(id), release() { released.push(id) } }; references.set(id, reference); return reference },
    refresh: () => refresh() }
  scenes.register({ slots: { inject: (_name, fn) => fn(), register: () => () => {} }, sessions,
    layout: { selectPanel() {} }, effect: fn => cleanup.push(fn()), on: () => () => {} })
  await scenes.retryLoadConfig()
  const root = createRoot(dom.window.document.getElementById('root'))
  const render = content => React.act(async () => root.render(content))
  const act = React.act
  const click = node => act(async () => node.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true, detail: 1 })))
  const pointer = (node, type, x, y = 20) => act(async () => {
    const event = new dom.window.MouseEvent(type, { bubbles: true, cancelable: true, button: 0, clientX: x, clientY: y })
    Object.defineProperty(event, 'pointerId', { value: 7 })
    node.dispatchEvent(event)
  })
  const tab = id => dom.window.document.querySelector(`[data-scene-tab-id="${id}"]`)
  const order = () => [...dom.window.document.querySelectorAll('[data-scene-tab-id]')].map(node => node.dataset.sceneTabId)
  const geometry = () => {
    const list = dom.window.document.querySelector('.tl-scene-tab-list')
    list.getBoundingClientRect = () => ({ left: 0, top: 0, right: 600, width: 600, height: 30 })
    for (const node of list.querySelectorAll('[data-scene-tab-id]')) {
      Object.defineProperty(node, 'offsetLeft', { configurable: true, get: () => order().indexOf(node.dataset.sceneTabId) * 60 })
      Object.defineProperty(node, 'offsetWidth', { configurable: true, get: () => 60 })
      node.getBoundingClientRect = () => ({ left: node.offsetLeft, right: node.offsetLeft + 60, top: 0, bottom: 30, width: 60, height: 30 })
    }
  }
  try {
    await run({ React, dom, scenes, config, requests, sessions, root, render, act, click, pointer, tab, order, geometry, references, retained, released, catalogListeners,
      failConfig: value => { failure = value }, deferConfig: value => { deferredConfig = value }, refreshWith: fn => { refresh = fn }, retainReadyWith: fn => { readiness = fn }, setCatalog: value => { catalog = value; for (const fn of catalogListeners) fn() } })
  } finally {
    await act(async () => root.unmount())
    for (const dispose of cleanup.reverse()) if (typeof dispose === 'function') dispose()
    dom.window.close()
    for (const [key, value] of Object.entries(prior)) { if (value === undefined) delete globalThis[key]; else globalThis[key] = value }
  }
}

test('scene tabs use one preference source, thresholded release-only reorder, fixed boundaries and cancellable drag', async t => harness(t, async h => {
  const { React, scenes, dom, act, render, click, pointer, tab, order, geometry } = h
  const pointerListeners = new Map(['pointermove', 'pointerup', 'pointercancel'].map(name => [name, new Set()]))
  const addListener = dom.window.addEventListener.bind(dom.window), removeListener = dom.window.removeEventListener.bind(dom.window)
  dom.window.addEventListener = (name, fn, ...args) => { pointerListeners.get(name)?.add(fn); return addListener(name, fn, ...args) }
  dom.window.removeEventListener = (name, fn, ...args) => { pointerListeners.get(name)?.delete(fn); return removeListener(name, fn, ...args) }
  const navigated = []
  const content = () => React.createElement(scenes.SceneTabs, { workbenchActive: true, onSceneSelect: id => navigated.push(id) })
  await render(content()); geometry()
  const initial = order()
  const source = tab(initial[1])
  await pointer(source, 'pointerdown', 75)
  await pointer(source, 'pointermove', 80)
  assert.equal(dom.window.document.querySelector('[data-dragging="true"]'), null, 'movement below 8px stays a click')
  await pointer(source, 'pointerup', 80); await click(source)
  assert.equal(navigated.at(-1), initial[1])
  await pointer(source, 'pointerdown', 75); await pointer(source, 'pointermove', 350)
  assert.equal(source.dataset.dragging, 'true')
  assert.equal(source.style.position, 'fixed', 'the complete existing button floats, rather than an icon copy')
  assert.equal(dom.window.localStorage.getItem(preferenceKey), null, 'pointer moves never commit preferences')
  await pointer(source, 'pointercancel', 350)
  assert.ok([...pointerListeners.values()].every(list => list.size === 0), 'cancel removes all temporary pointer listeners')
  assert.deepEqual(order(), initial)
  assert.equal(dom.window.localStorage.getItem(preferenceKey), null, 'cancel restores the original order without saving')
  await pointer(source, 'pointerdown', 75); await pointer(source, 'pointermove', 350); await pointer(source, 'pointerup', 350); await click(source)
  assert.equal(navigated.length, 1, 'the synthetic mouse click after drag is consumed before navigation')
  assert.notDeepEqual(order(), initial)
  assert.deepEqual(JSON.parse(dom.window.localStorage.getItem(preferenceKey)).order, order())
  await act(async () => source.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, detail: 0 })))
  assert.equal(navigated.length, 2, 'keyboard activation is preserved after dragging')
  const pin = async id => {
    await act(async () => tab(id).dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'F10', shiftKey: true, bubbles: true, cancelable: true })))
    const menu = dom.window.document.querySelector('[role="menu"]')
    const independent = [...menu.querySelectorAll('button')].find(node => node.textContent === '独立打开场景')
    assert.equal(independent.disabled, true, 'single-pane popouts do not advertise a complete scene window')
    await click([...menu.querySelectorAll('button')].find(node => node.textContent === '固定标签'))
  }
  await pin(initial[0]); await pin(initial[1]); geometry()
  const fixed = order().slice(0, 2)
  const ordinary = tab(order().at(-1))
  await pointer(ordinary, 'pointerdown', 350); await pointer(ordinary, 'pointermove', -100); await pointer(ordinary, 'pointerup', -100)
  assert.deepEqual(order().slice(0, 2), fixed)
  const pinnedBefore = JSON.parse(dom.window.localStorage.getItem(preferenceKey)).pinned
  const first = tab(fixed[0])
  await pointer(first, 'pointerdown', 20); await pointer(first, 'pointermove', 900); await pointer(first, 'pointerup', 900)
  assert.deepEqual(new Set(order().slice(0, 2)), new Set(fixed))
  assert.deepEqual(JSON.parse(dom.window.localStorage.getItem(preferenceKey)).pinned, pinnedBefore, 'cross-group drag never changes the pin set')
  const before = scenes.getSnapshot()
  h.failConfig(true)
  await act(async () => { await scenes.retryLoadConfig().catch(() => {}) })
  assert.equal(scenes.getSnapshot().config, before.config)
  assert.match(dom.window.document.body.textContent, /重试读取场景/)
  assert.equal(JSON.parse(dom.window.localStorage.getItem(preferenceKey)).version, 1)
  h.failConfig(false)
  const originalOrder = order()
  h.config.scenes.push({ ...structuredClone(h.config.scenes[1]), id: 'new-scene', label: '新增场景', defaultBusinessRoute: undefined })
  await act(async () => scenes.retryLoadConfig())
  assert.deepEqual(order().slice(0, originalOrder.length), originalOrder)
  assert.equal(order().at(-1), 'new-scene', 'new stable ids append after saved preference order')
  assert.equal(scenes.getSnapshot().panelRefreshKeys, before.panelRefreshKeys)
  assert.equal(h.requests.some(([, method]) => method === 'POST'), false)
  await pointer(tab(order()[0]), 'pointerdown', 20)
  assert.ok([...pointerListeners.values()].every(list => list.size === 1))
  await render(null)
  assert.ok([...pointerListeners.values()].every(list => list.size === 0), 'unmount during a pending gesture removes listeners without committing')
} ))

test('invalid stored preferences survive reads and failed storage reports unsaved changes', async t => harness(t, async h => {
  await h.render(h.React.createElement(h.scenes.SceneTabs))
  assert.equal(h.dom.window.localStorage.getItem(preferenceKey), '{broken-preference')
  assert.match(h.dom.window.document.body.textContent, /无法读取/)
  await h.act(async () => h.tab('products').dispatchEvent(new h.dom.window.MouseEvent('contextmenu', { bubbles: true, cancelable: true })))
  await h.click([...h.dom.window.document.querySelectorAll('[role="menu"] button')].find(node => node.textContent === '固定标签'))
  assert.equal(h.dom.window.localStorage.getItem(preferenceKey), '{broken-preference', 'bad storage is not erased by defaults or an unsavable mutation')
  assert.match(h.dom.window.document.body.textContent, /未保存/)
}, '{broken-preference'))

test('binding details use exact metadata identity and expose configured sharing without creating sessions', async t => harness(t, async h => {
  const { React, scenes, render, act, dom } = h
  h.config.sessionBindings.product = 'same-title-a'
  await scenes.retryLoadConfig()
  await render(React.createElement(scenes.RoleBindingDetails, { state: scenes.getSnapshot(), roleId: 'center' }))
  assert.match(dom.window.document.querySelector('summary').textContent, /已归档/)
  const details = dom.window.document.querySelector('details')
  await h.click(details.querySelector('summary'))
  assert.equal(details.open, true)
  assert.match(details.textContent, /same-title-a/)
  assert.match(details.textContent, /fixture-workspace/)
  assert.match(details.textContent, /product/)
  assert.match(details.textContent, /工作总览 \(center\)/)
  const state = { ...scenes.getSnapshot(), sessionBindings: { ...scenes.getSnapshot().sessionBindings, center: 'new-binding' } }
  await render(React.createElement(scenes.RoleBindingDetails, { state, roleId: 'center' }))
  assert.equal(dom.window.document.querySelector('[data-archive-state]').dataset.archiveState, 'unknown')
  assert.match(details.textContent, /new-binding/)
  assert.doesNotMatch(details.textContent, /fixture-workspace/)
  await h.click(details.querySelector('[aria-label="关闭绑定详情"]'))
  assert.equal(details.open, false)
  await h.click(details.querySelector('summary'))
  await act(async () => dom.window.document.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
  assert.equal(details.open, false)
  assert.equal(h.requests.some(([, method]) => method === 'POST'), false)
}))

test('saved order restores across initialization, effect cleanup avoids duplicate listeners, and quota failures stay visible', async t => harness(t, async h => {
  const { React, scenes, dom, render, act, click } = h
  const resizeListeners = new Set()
  const add = dom.window.addEventListener.bind(dom.window), remove = dom.window.removeEventListener.bind(dom.window)
  dom.window.addEventListener = (name, fn, ...args) => { if (name === 'resize') resizeListeners.add(fn); return add(name, fn, ...args) }
  dom.window.removeEventListener = (name, fn, ...args) => { if (name === 'resize') resizeListeners.delete(fn); return remove(name, fn, ...args) }
  const content = React.createElement(React.StrictMode, null, React.createElement(scenes.SceneTabs))
  await render(content)
  assert.deepEqual(h.order().slice(0, 2), ['products', 'center'])
  assert.equal(resizeListeners.size, 1, 'StrictMode cleanup leaves one measurement subscription')
  await render(null)
  assert.equal(resizeListeners.size, 0)
  await render(content)
  assert.equal(resizeListeners.size, 1, 'reinitializing the component adds no duplicate listener')
  const previous = dom.window.localStorage.getItem(preferenceKey)
  dom.window.Storage.prototype.setItem = () => { throw new Error('quota fixture') }
  await act(async () => h.tab('deliverables').dispatchEvent(new dom.window.MouseEvent('contextmenu', { bubbles: true, cancelable: true })))
  await click([...dom.window.document.querySelectorAll('[role="menu"] button')].find(node => node.textContent === '固定标签'))
  assert.equal(dom.window.localStorage.getItem(preferenceKey), previous)
  assert.match(dom.window.document.body.textContent, /未保存/)
}, JSON.stringify({ version: 1, order: ['products', 'center', 'retired-scene'], pinned: ['products'] })))

test('newer config retry wins over a late response while current scene and layouts stay mounted', async t => harness(t, async h => {
  const before = h.scenes.getSnapshot()
  const oldConfig = structuredClone(h.config)
  const deferred = {}
  h.deferConfig(deferred)
  const late = h.scenes.retryLoadConfig()
  assert.equal(h.scenes.getSnapshot().config, before.config, 'retry does not publish a null configuration')
  h.deferConfig(null)
  h.config.scenes[0].label = '新一代场景'
  await h.scenes.retryLoadConfig()
  deferred.resolve(oldConfig)
  await late
  assert.equal(h.scenes.getSnapshot().config.scenes[0].label, '新一代场景')
  assert.equal(h.scenes.getSnapshot().activeSceneId, before.activeSceneId)
  assert.equal(h.scenes.getSnapshot().dockLayouts.scenes.center, before.dockLayouts.scenes.center)
}))

test('ready native refresh preserves editor DOM, File and Provider identity through failure and late responses', async t => harness(t, async h => {
  const { React, scenes, dom, render, act } = h
  let mounts = 0, unmounts = 0
  const file = new dom.window.File(['fixture'], 'fixture.txt', { type: 'text/plain' })
  const provided = []
  function Provider({ session, children }) { provided.push(session); return children }
  function Editor() {
    React.useEffect(() => { mounts++; return () => { unmounts++ } }, [])
    return React.createElement('input', { 'data-fixture-editor': true, ref: node => { if (node && !node.fixtureFile) node.fixtureFile = file } })
  }
  const content = refreshKey => React.createElement(scenes.NativeChatPanel, { sceneId: 'center', refreshKey, SessionProvider: Provider, renderSlot: () => React.createElement(Editor) })
  await render(content(0))
  const input = dom.window.document.querySelector('input')
  input.value = '未发送草稿'
  const reference = provided.at(-1)
  await render(content(1))
  assert.equal(dom.window.document.querySelector('input'), input)
  assert.equal(provided.at(-1), reference)
  h.refreshWith(() => Promise.reject(new Error('fixture failure')))
  await render(content(2))
  assert.equal(dom.window.document.querySelector('input'), input)
  assert.equal(input.value, '未发送草稿')
  assert.equal(input.fixtureFile, file)
  assert.equal(mounts, 1); assert.equal(unmounts, 0)
  assert.match(dom.window.document.querySelector('[role="alert"]').textContent, /刷新失败/)
  let rejectLate
  h.refreshWith(() => new Promise((_resolve, reject) => { rejectLate = reject }))
  await render(content(3))
  const rejectOld = rejectLate
  h.refreshWith(() => Promise.resolve())
  await act(async () => scenes.bindRoleSession('center', 'new-binding'))
  const nextInput = dom.window.document.querySelector('input')
  assert.notEqual(nextInput, input, 'an actual binding replacement gets a different identity')
  await act(async () => rejectOld(new Error('late old request')))
  assert.equal(dom.window.document.querySelector('input'), nextInput)
  assert.equal(Boolean(dom.window.document.querySelector('[role="alert"]')), false, 'old refresh failure cannot affect the replacement session')
  await act(async () => scenes.retryLoadConfig())
  assert.equal(dom.window.document.querySelector('input'), nextInput, 'successful config reread preserves the mounted current editor')
  const before = scenes.getSnapshot()
  h.failConfig(true)
  await act(async () => { await scenes.retryLoadConfig().catch(() => {}) })
  assert.equal(scenes.getSnapshot().config, before.config)
  assert.equal(dom.window.document.querySelector('input'), nextInput)
  h.failConfig(false)
  h.config.scenes[0].panels[0].type = 'unknown-panel'
  await act(async () => { await scenes.retryLoadConfig().catch(() => {}) })
  assert.match(scenes.getSnapshot().configError, /未知面板类型/)
  assert.equal(scenes.getSnapshot().config, before.config)
  assert.equal(dom.window.document.querySelector('input'), nextInput)
  assert.equal(h.requests.some(([, method]) => method === 'POST'), false)
}))

test('A ready to pending B then failed A reports an error instead of trusting a historical ready reference', async t => harness(t, async h => {
  const { React, scenes, dom, render, act } = h
  function Provider({ children }) { return children }
  function Editor() { return React.createElement('input', { 'data-native-identity-probe': true }) }
  await render(React.createElement(scenes.NativeChatPanel, { sceneId: 'center', refreshKey: 0, SessionProvider: Provider, renderSlot: () => React.createElement(Editor) }))
  assert.ok(dom.window.document.querySelector('input'), 'A initially mounted a ready editor')
  let settleB
  h.retainReadyWith(id => id === 'same-title-b' ? new Promise(resolve => { settleB = resolve }) : Promise.reject(new Error('fixture A reconnect failed')))
  await act(async () => scenes.bindRoleSession('center', 'same-title-b'))
  assert.equal(Boolean(dom.window.document.querySelector('input')), false, 'pending B has no ready editor')
  await act(async () => scenes.bindRoleSession('center', 'same-title-a'))
  const error = dom.window.document.querySelector('[role="alert"]')
  assert.ok(error, 'A failed after its prior editor was unmounted: it must leave busy state and show the connection error')
  assert.match(error.textContent, /无法连接|连接失败/)
  await act(async () => settleB())
  assert.ok(dom.window.document.querySelector('[role="alert"]'), 'late B readiness cannot erase the current A failure')
  assert.equal(Boolean(dom.window.document.querySelector('input')), false)
}))
