import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { runInNewContext } from 'node:vm'
import test from 'node:test'
import { publicRoleMetadata } from '../roles.js'
import { defaultSceneWorkbench } from '../scene-layout.js'
import { normalizeDockLayouts } from '../dock-layout.js'

const require = createRequire(import.meta.url)

async function harness(t, run) {
  const reactPath = process.env.TRADELOOM_REACT_LIBRARY
  const serverPath = process.env.TRADELOOM_REACT_SERVER_LIBRARY
  const domPath = process.env.TRADELOOM_DOM_MODULE
  if (!reactPath || !serverPath || !domPath) return t.skip('requires pinned React/JSDOM')
  const React = require(reactPath)
  const { createRoot } = createRequire(serverPath)('react-dom/client')
  const { JSDOM } = require(domPath)
  const dom = new JSDOM('<!doctype html><div id="root"></div>', { url: 'http://fixture.local/', pretendToBeVisual: true })
  const previous = { window: globalThis.window, document: globalThis.document, IS_REACT_ACT_ENVIRONMENT: globalThis.IS_REACT_ACT_ENVIRONMENT }
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true })
  const config = JSON.parse(await readFile(new URL('../scenes.json', import.meta.url), 'utf8'))
  config.roles = publicRoleMetadata()
  config.sessionBindings = { center: 'center-bound', product: 'product-bound' }
  const scene = config.scenes.find(item => item.id === 'center')
  if (!scene.panels.some(panel => panel.id === 'native-workspace')) scene.panels.push({
    id: 'native-workspace', title: '项目文件', type: 'native-workspace', optional: true,
    category: 'resources', col: 1, row: 1, w: 2, h: 2,
  })
  const requests = [], releases = [], references = new Map(), retained = [], cleanups = []
  let refresh = () => Promise.resolve()
  const fetch = async (url, options = {}) => {
    requests.push([url, options.method ?? 'GET'])
    assert.equal(options.method ?? 'GET', 'GET', 'resource panes must never create conversations')
    if (url === '/tradeloom/scenes') return { ok: true, json: async () => structuredClone(config) }
    const state = defaultSceneWorkbench(config)
    if (url === '/tradeloom/scene-layouts') return { ok: true, json: async () => state }
    if (url === '/tradeloom/dock-layouts') return { ok: true, json: async () => normalizeDockLayouts(config, { version: 2, scenes: {} }, state.layouts) }
    throw new Error('unexpected fixture URL ' + url)
  }
  let registration
  dom.window.__ModuleLoader__ = { load(value) { registration = value } }
  runInNewContext(await readFile(new URL('../client.scenes.js', import.meta.url), 'utf8'), {
    window: dom.window, document: dom.window.document, fetch, URL, URLSearchParams, setTimeout, clearTimeout,
  })
  const scenes = registration.factory(name => { if (name === 'react') return React; throw new Error('unused optional module: ' + name) })
  const sessions = {
    list: { getSnapshot: () => ({ phase: 'ready', ids: ['center-bound', 'product-bound', 'replacement'] }), subscribe: () => () => {} },
    retain(id) {
      retained.push(id)
      const reference = { sessionId: id, ready: Promise.resolve(), release() { releases.push(id) } }
      references.set(id, reference)
      return reference
    },
    refresh: () => refresh(),
  }
  scenes.register({ slots: { inject: (_name, callback) => callback(), register: () => () => {} }, sessions,
    layout: { selectPanel() {} }, effect: callback => cleanups.push(callback()), on: () => () => {} })
  await scenes.retryLoadConfig()
  const root = createRoot(dom.window.document.getElementById('root'))
  const scope = React.createContext(null)
  function Provider({ session, children }) { return React.createElement(scope.Provider, { value: session }, children) }
  function Resource({ ownerId, active }) {
    const reference = React.useContext(scope)
    return React.createElement('input', { 'data-owner': ownerId, 'data-session': reference?.sessionId, 'data-active': String(active) })
  }
  const factoryCalls = []
  const renderFactorySlot = (name, props) => {
    factoryCalls.push({ name, props })
    assert.equal(name, 'sidebar.surface')
    return React.createElement(Resource, props)
  }
  const content = (props = {}) => React.createElement(scenes.NativeWorkspacePanel, {
    sceneId: 'center', panelId: 'native-workspace', refreshKey: 0, active: true,
    SessionProvider: Provider, renderFactorySlot, ...props,
  })
  try {
    await run({ React, scenes, config, dom, references, retained, releases, factoryCalls, content, Provider,
      render: node => React.act(async () => root.render(node)), act: React.act,
      refreshWith(callback) { refresh = callback }, requests })
  } finally {
    await React.act(async () => root.unmount())
    for (const cleanup of cleanups.reverse()) cleanup?.()
    dom.window.close()
    Object.assign(globalThis, previous)
  }
}

test('native resource pane inherits the scene role and keeps its input across refresh and hidden scene', async t => harness(t, async h => {
  await h.render(h.content())
  const input = h.dom.window.document.querySelector('input')
  assert.ok(input)
  assert.equal(input.dataset.owner, 'center:native-workspace')
  assert.equal(input.dataset.session, 'center-bound')
  assert.equal(h.scenes.roleForPanel(h.config, 'center', 'native-workspace'), 'center')
  input.value = 'resource view state'
  await h.render(h.content({ refreshKey: 1, active: false }))
  assert.equal(h.dom.window.document.querySelector('input'), input)
  assert.equal(input.value, 'resource view state')
  assert.equal(input.dataset.active, 'false')
  let reject
  h.refreshWith(() => new Promise((_resolve, fail) => { reject = fail }))
  await h.render(h.content({ refreshKey: 2 }))
  await h.act(async () => reject(new Error('owned refresh failure')))
  assert.equal(h.dom.window.document.querySelector('input'), input)
  assert.match(h.dom.window.document.querySelector('[role="alert"]').textContent, /刷新失败/)
  assert.equal(h.requests.some(([, method]) => method !== 'GET'), false)
}))

test('explicit role resource pane never takes the global or another role conversation', async t => harness(t, async h => {
  await h.render(h.content({ roleId: 'product' }))
  assert.equal(h.dom.window.document.querySelector('input').dataset.session, 'product-bound')
  assert.deepEqual(h.retained, ['product-bound'])
  await h.act(async () => h.scenes.bindRoleSession('product', 'replacement'))
  assert.equal(h.dom.window.document.querySelector('input').dataset.session, 'replacement')
  assert.equal(h.factoryCalls.every(call => call.props.ownerId === 'center:native-workspace'), true)
}))

test('unbound resource pane stays unbound and never creates a native conversation', async t => harness(t, async h => {
  await h.render(h.content({ roleId: 'delivery' }))
  assert.equal(h.dom.window.document.querySelector('input'), null)
  assert.match(h.dom.window.document.body.textContent, /尚无已连接会话/)
  assert.deepEqual(h.retained, [])
  assert.equal(h.factoryCalls.length, 0)
  assert.equal(h.requests.some(([, method]) => method !== 'GET'), false)
}))

test('same Session chat yields its hidden input while resource and distinct Session views remain resident', async t => harness(t, async h => {
  let mounts = 0, unmounts = 0
  function Chat() {
    h.React.useLayoutEffect(() => { mounts++; return () => { unmounts++ } }, [])
    return h.React.createElement('textarea', { 'data-chat-test': '' })
  }
  const chat = props => h.React.createElement(h.scenes.NativeChatPanel, {
    sceneId: 'center', refreshKey: 0, SessionProvider: h.Provider,
    renderSlot: () => h.React.createElement(Chat), ...props,
  })
  await h.render(h.React.createElement(h.React.Fragment, null,
    chat({ key: 'center', active: true }),
    chat({ key: 'hidden-same', roleId: 'center', active: false }),
    chat({ key: 'other', roleId: 'product', active: false }),
    h.content({ key: 'resource', active: false })))
  assert.equal(h.dom.window.document.querySelectorAll('[data-chat-test]').length, 2)
  const resource = h.dom.window.document.querySelector('input')
  resource.value = 'retained resource state'
  const reference = h.references.get('center-bound')
  await h.render(h.React.createElement(h.React.Fragment, null,
    chat({ key: 'center', active: false }),
    chat({ key: 'hidden-same', roleId: 'center', active: true }),
    chat({ key: 'other', roleId: 'product', active: false }),
    h.content({ key: 'resource', active: false })))
  assert.equal(h.dom.window.document.querySelectorAll('[data-chat-test]').length, 2)
  assert.equal(mounts, 3)
  assert.equal(unmounts, 1)
  assert.equal(h.references.get('center-bound'), reference)
  assert.equal(h.releases.length, 0)
  assert.equal(h.dom.window.document.querySelector('input'), resource)
  assert.equal(resource.value, 'retained resource state')
  assert.equal(h.requests.some(([, method]) => method !== 'GET'), false)
}))
