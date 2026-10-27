import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { runInNewContext } from 'node:vm'
import test from 'node:test'
import { defaultSceneWorkbench } from '../scene-layout.js'
import { normalizeDockLayouts, validateDockLayouts } from '../dock-layout.js'
import { publicRoleMetadata } from '../roles.js'

const nodeRequire = createRequire(import.meta.url)
const runtimePaths = [
  process.env.TRADELOOM_REACT_LIBRARY,
  process.env.TRADELOOM_REACT_SERVER_LIBRARY,
  process.env.TRADELOOM_DOM_MODULE,
]

function walkLeaves(node, result = []) {
  if (node.type === 'leaf') result.push({ id: node.data.id, views: [...node.data.views], size: node.size })
  else for (const child of node.data) walkLeaves(child, result)
  return result
}

function assertSplitPercentages(children, expected, tolerancePoints = 0.3) {
  const total = children.reduce((sum, child) => sum + child.size, 0)
  assert.ok(total > 0)
  const actual = children.map(child => child.size / total * 100)
  assert.equal(actual.length, expected.length)
  for (let index = 0; index < expected.length; index++) {
    assert.ok(Math.abs(actual[index] - expected[index]) <= tolerancePoints,
      `split ${index} should be near ${expected[index]}%, got ${actual[index].toFixed(3)}%`)
  }
}

function assertSizesNear(actual, expected, tolerancePx = 2, label = 'serialized size') {
  assert.equal(actual.length, expected.length)
  for (let index = 0; index < expected.length; index++) {
    assert.ok(Math.abs(actual[index] - expected[index]) <= tolerancePx,
      `${label} ${index} should be within ${tolerancePx}px of ${expected[index]}, got ${actual[index]}`)
  }
}

function geometrySignature(grid) {
  const visit = node => node.type === 'leaf'
    ? { type: 'leaf', size: node.size, id: node.data.id }
    : { type: 'branch', size: node.size, orientation: node.orientation, children: node.data.map(visit) }
  return { orientation: grid.orientation, root: visit(grid.root) }
}

test('real Dockview snapshot survives the client HTTP save and server restore contract', {
  skip: runtimePaths.some(path => !path),
}, async t => {
  const [reactPath, reactDomPath, domPath] = runtimePaths
  const React = nodeRequire(reactPath)
  const pinnedRequire = createRequire(reactDomPath)
  const { createRoot } = pinnedRequire('react-dom/client')
  const act = React.act ?? pinnedRequire('react-dom/test-utils').act
  const settle = (milliseconds = 0) => new Promise(resolve => setTimeout(resolve, milliseconds))
  const { JSDOM } = nodeRequire(domPath)
  const dom = new JSDOM('<!doctype html><html><head></head><body><div id="root"></div></body></html>', {
    url: 'dsh-app://app/', pretendToBeVisual: true,
  })
  const popupWindows = []
  const popoutTicket = 'A'.repeat(43)
  let popoutUrlRequested = 0
  dom.window.dshDesktop = { panePopout: { async getUrl() {
    popoutUrlRequested++
    return `dsh-app://app/desktop-pane-popout.html?ticket=${popoutTicket}`
  } } }
  dom.window.open = url => {
    const popup = new JSDOM('<!doctype html><html><head></head><body></body></html>', {
      url: String(url), pretendToBeVisual: true,
    })
    const child = popup.window
    Object.defineProperty(child, 'opener', { configurable: true, value: dom.window })
    const closeWindow = child.close.bind(child)
    let closing = false
    child.close = () => {
      if (closing || child.closed) return
      closing = true
      child.dispatchEvent(new child.Event('beforeunload'))
      child.dispatchEvent(new child.Event('unload'))
      closeWindow()
    }
    popupWindows.push(popup)
    // Dockview attaches its load listener immediately after window.open returns.
    dom.window.setTimeout(() => child.dispatchEvent(new child.Event('load')), 0)
    return child
  }
  const geometryOverrides = new WeakMap()
  const originalRect = dom.window.HTMLElement.prototype.getBoundingClientRect
  const geometryMetricNames = ['clientWidth', 'clientHeight', 'offsetWidth', 'offsetHeight']
  const originalGeometryMetrics = new Map(geometryMetricNames.map(name => [name,
    Object.getOwnPropertyDescriptor(dom.window.HTMLElement.prototype, name)]))
  const isDockviewViewport = element => element.classList?.contains('tl-dockview-host')
    || element.classList?.contains('tl-dockview-theme') || element.classList?.contains('dv-dockview')
  for (const name of geometryMetricNames) {
    const dimension = name.endsWith('Width') ? 'width' : 'height'
    const original = originalGeometryMetrics.get(name)
    Object.defineProperty(dom.window.HTMLElement.prototype, name, {
      configurable: true,
      get() {
        const override = geometryOverrides.get(this)
        if (Number.isFinite(override?.[dimension])) return override[dimension]
        if (isDockviewViewport(this)) return dimension === 'width' ? 980 : 650
        return original?.get?.call(this) ?? 0
      },
    })
  }
  const originalElementFromPoint = dom.window.document.elementFromPoint
  const originalElementsFromPoint = dom.window.document.elementsFromPoint
  dom.window.HTMLElement.prototype.getBoundingClientRect = function () {
    const override = geometryOverrides.get(this)
    if (override) return override
    if (this.classList?.contains('tl-dockview-host')) {
      return { x: 0, y: 0, left: 0, top: 0, right: 980, bottom: 650, width: 980, height: 650, toJSON() { return this } }
    }
    if (this.classList?.contains('tl-dockview-theme')) {
      return { x: 0, y: 0, left: 0, top: 0, right: 980, bottom: 650, width: 980, height: 650, toJSON() { return this } }
    }
    if (this.classList?.contains('dv-dockview')) {
      return { x: 0, y: 0, left: 0, top: 0, right: 980, bottom: 650, width: 980, height: 650, toJSON() { return this } }
    }
    return originalRect.call(this)
  }
  class ResizeObserverShim {
    constructor(callback) { this.callback = callback; this.targets = new Set() }
    observe(target) {
      this.targets.add(target)
      const rect = target.getBoundingClientRect()
      this.callback([{ target, contentRect: rect }], this)
    }
    unobserve(target) { this.targets.delete(target) }
    disconnect() { this.targets.clear() }
  }
  class PointerEventShim extends dom.window.MouseEvent {
    constructor(type, init = {}) {
      super(type, init)
      Object.defineProperties(this, {
        pointerId: { value: init.pointerId ?? 0 },
        pointerType: { value: init.pointerType ?? 'mouse' },
        isPrimary: { value: init.isPrimary ?? true },
      })
    }
  }
  dom.window.PointerEvent = PointerEventShim
  const savedDescriptors = new Map()
  const installGlobal = (key, value) => {
    savedDescriptors.set(key, Object.getOwnPropertyDescriptor(globalThis, key))
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value })
  }
  let holdAnimationFrames = false
  const heldAnimationFrames = []
  const frame = callback => {
    if (holdAnimationFrames) {
      heldAnimationFrames.push(callback)
      return heldAnimationFrames.length
    }
    return dom.window.setTimeout(() => callback(Date.now()), 0)
  }
  installGlobal('window', dom.window)
  installGlobal('location', dom.window.location)
  installGlobal('document', dom.window.document)
  installGlobal('navigator', dom.window.navigator)
  installGlobal('HTMLElement', dom.window.HTMLElement)
  installGlobal('Element', dom.window.Element)
  installGlobal('Node', dom.window.Node)
  installGlobal('Document', dom.window.Document)
  installGlobal('PointerEvent', PointerEventShim)
  installGlobal('MutationObserver', dom.window.MutationObserver)
  installGlobal('ResizeObserver', ResizeObserverShim)
  installGlobal('requestAnimationFrame', frame)
  installGlobal('cancelAnimationFrame', id => dom.window.clearTimeout(id))
  installGlobal('getComputedStyle', dom.window.getComputedStyle.bind(dom.window))
  installGlobal('fetch', async () => { throw new Error('unexpected global fetch') })
  installGlobal('IS_REACT_ACT_ENVIRONMENT', true)

  const config = JSON.parse(await readFile(new URL('../scenes.json', import.meta.url), 'utf8'))
  config.roles = publicRoleMetadata()
  const sceneState = defaultSceneWorkbench(config)
  sceneState.activeSceneId = 'products'
  sceneState.businessPath = '/products'
  const dockLayouts = normalizeDockLayouts(config, { version: 2, scenes: {} }, sceneState.layouts)
  const putBodies = []
  const validatorErrors = []
  const putValidations = []
  let nextPutResponse = null
  const fetch = async (url, options = {}) => {
    if (url === '/tradeloom/scenes') return { ok: true, async json() { return { ...config, businessOrigin: 'http://desktop.local' } } }
    if (url === '/tradeloom/scene-layouts') return { ok: true, async json() { return sceneState } }
    if (url === '/tradeloom/dock-layouts' && options.method !== 'PUT') return { ok: true, async json() { return dockLayouts } }
    if (url === '/tradeloom/dock-layouts' && options.method === 'PUT') {
      const body = JSON.parse(options.body)
      putBodies.push(body)
      let valid = true
      try { validateDockLayouts(config, body) }
      catch (error) { valid = false; validatorErrors.push(error.message) }
      putValidations.push(valid)
      if (nextPutResponse) return nextPutResponse
      return { ok: valid, async json() { return {} } }
    }
    if (url === '/tradeloom/session') return { ok: true, status: 201, async json() { return { role: 'product', sessionId: 'synthetic-session' } } }
    throw new Error(`unexpected request: ${url}`)
  }
  const clientSource = await readFile(new URL('../client.scenes.js', import.meta.url), 'utf8')
  const dockviewSource = await readFile(new URL('../client.dockview.js', import.meta.url), 'utf8')
  const dockviewCss = await readFile(new URL('../vendor/dockview.css', import.meta.url), 'utf8')
  let clientRegistration
  let dockviewRegistration
  dom.window.__ModuleLoader__ = { load(value) {
    if (value.chunk === 'client.scenes.js') clientRegistration = value
    if (value.chunk === 'client.dockview.js') dockviewRegistration = value
  } }
  const vmGlobals = {
    window: dom.window, document: dom.window.document, navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement, Element: dom.window.Element, Node: dom.window.Node, Document: dom.window.Document,
    PointerEvent: PointerEventShim,
    MutationObserver: dom.window.MutationObserver, ResizeObserver: ResizeObserverShim,
    URL, URLSearchParams, fetch, requestAnimationFrame: frame,
    cancelAnimationFrame: id => dom.window.clearTimeout(id),
    setTimeout: dom.window.setTimeout.bind(dom.window), clearTimeout: dom.window.clearTimeout.bind(dom.window),
    queueMicrotask: callback => dom.window.queueMicrotask(callback),
  }
  runInNewContext(clientSource, { ...vmGlobals, React })
  dom.window.eval(dockviewSource)
  assert.equal(clientRegistration?.chunk, 'client.scenes.js')
  assert.equal(dockviewRegistration?.chunk, 'client.dockview.js')
  const nativeDockviewModule = dockviewRegistration.factory(id => pinnedRequire(id))
  const prelaidVisibleScenes = []
  const dockviewModule = {
    ...nativeDockviewModule,
    DockviewReact: props => {
      const sceneId = props.rightHeaderActionsComponent?.({})?.props?.sceneId
      const scene = config.scenes.find(item => item.id === sceneId)
      return React.createElement(nativeDockviewModule.DockviewReact, {
        ...props,
        onReady: event => {
          const section = scene && [...dom.window.document.querySelectorAll('.tl-dock-scene')]
            .find(node => node.getAttribute('aria-label') === `${scene.label}工作区`)
          const host = section?.querySelector('.tl-dockview-host')
          const rect = host?.getBoundingClientRect()
          const applied = Boolean(section?.classList.contains('is-active') && rect?.width > 0 && rect?.height > 0)
          if (applied) event.api.layout(rect.width, rect.height, true)
          prelaidVisibleScenes.push({ sceneId, active: section?.classList.contains('is-active') === true,
            width: rect?.width ?? 0, height: rect?.height ?? 0, apiWidth: event.api.width,
            apiHeight: event.api.height, applied })
          props.onReady(event)
        },
      })
    },
  }
  const sceneRequire = Object.assign(name => {
    if (name === 'react') return React
    if (name === 'react-dom') return pinnedRequire('react-dom')
    assert.fail(`unexpected client-scene dependency ${name}`)
  }, { async: async id => { assert.equal(id, './client.dockview.js'); return dockviewModule } })
  const sceneExports = clientRegistration.factory(sceneRequire)
  const cleanups = []
  sceneExports.register({
    layout: { selectPanel() {}, panelInfo: { getSnapshot() { return { activePanelId: null } }, subscribe() { return () => {} } } },
    sessions: { retain(_roleId, sessionId) { return { sessionId, ready: Promise.resolve(), release() {} } } },
    modelDirectories: { directoryFor() { return { store: { getSnapshot() { return {} }, subscribe() { return () => {} } }, load: async () => {} } } },
    theme: { getTheme() { return { active: { colorScheme: 'light' } } }, overrideTokens() { return () => {} } },
    slots: { inject(_name, callback) { callback() }, register() { return () => {} } },
    effect(callback) { cleanups.push(callback()) }, on() {},
  }, undefined, undefined, {}, {
    fontFamily: 'Arial, sans-serif', fontBody: 15, fontCompact: 13, lineHeight: 1.45,
    topRowHeight: 30, navHeight: 30, controlHeight: 28, modelControl: 30,
    sceneTabHeight: 32, dockTabHeight: 30, toolbarHeight: 34, iconSize: 16, cornerRadius: 8,
  })
  let root
  const host = dom.window.document.getElementById('root')
  let keyboardSashAttributeSnapshot
  t.after(async () => {
    const cleanupErrors = []
    try {
      if (root) await act(async () => root.unmount())
    } catch (error) { cleanupErrors.push(error) }
    try { assert.equal(host.childElementCount, 0, 'unmount disposes the real Dockview React tree') }
    catch (error) { cleanupErrors.push(error) }
    try {
      if (keyboardSashAttributeSnapshot) {
        for (const [name, value] of Object.entries(keyboardSashAttributeSnapshot.attributes)) {
          assert.equal(keyboardSashAttributeSnapshot.element.getAttribute(name), value,
            `unmount restores the sash's original ${name} attribute`)
        }
      }
    } catch (error) { cleanupErrors.push(error) }
    try { assert.equal(sceneExports.getDockviewApi('products'), undefined, 'scene teardown releases its Dockview API reference') }
    catch (error) { cleanupErrors.push(error) }
    for (const cleanup of cleanups) {
      try { cleanup?.() } catch (error) { cleanupErrors.push(error) }
    }
    for (const [key, descriptor] of savedDescriptors) {
      try {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor)
        else delete globalThis[key]
      } catch (error) { cleanupErrors.push(error) }
    }
    dom.window.HTMLElement.prototype.getBoundingClientRect = originalRect
    for (const [name, descriptor] of originalGeometryMetrics) {
      if (descriptor) Object.defineProperty(dom.window.HTMLElement.prototype, name, descriptor)
      else delete dom.window.HTMLElement.prototype[name]
    }
    if (originalElementFromPoint) dom.window.document.elementFromPoint = originalElementFromPoint
    else delete dom.window.document.elementFromPoint
    if (originalElementsFromPoint) dom.window.document.elementsFromPoint = originalElementsFromPoint
    else delete dom.window.document.elementsFromPoint
    dom.window.close()
    for (const popup of popupWindows) popup.window.close()
    if (cleanupErrors.length === 1) throw cleanupErrors[0]
    if (cleanupErrors.length > 1) throw new AggregateError(cleanupErrors, 'Dockview integration cleanup failed')
  })

    root = createRoot(host)
    const App = () => React.createElement(sceneExports.SceneWorkbench, {
      SessionProvider: ({ children }) => children,
      renderSlot: () => React.createElement('div', { 'data-native-chat-instance': 'true' }, 'native chat fixture'),
    })
    await act(async () => {
      root.render(React.createElement(App))
      await settle(80)
    })
    const api = sceneExports.getDockviewApi('products')
    assert.ok(api, 'the real Dockview instance is registered by the production SceneWorkbench')
    assert.equal(api.dndCapabilities.pointer, true)
    assert.equal(putBodies.length, 0, 'initial mount does not write the layout')
    assert.ok(prelaidVisibleScenes.some(entry => entry.sceneId === 'products' && entry.active && entry.applied
      && entry.width === 980 && entry.height === 650),
    'the active product Dockview receives the fixture host size before the production restore callback')
    assert.ok(prelaidVisibleScenes.filter(entry => !entry.active || entry.width <= 0 || entry.height <= 0)
      .every(entry => !entry.applied), 'the fixture never prelays a hidden or zero-size scene')
    await act(async () => { api.layout(980, 650, true); await settle() })
    const activeScene = host.querySelector('.tl-dock-scene.is-active')
    assert.ok(activeScene, 'the product workbench is the active scene in the integration fixture')
    const dockHost = activeScene.querySelector('.tl-dockview-host')
    const dockTheme = dockHost.querySelector('.tl-dockview-theme')
    const dockRoot = dockTheme.querySelector('.dv-dockview')
    assert.deepEqual([dockHost.clientWidth, dockHost.clientHeight, dockTheme.clientWidth, dockTheme.clientHeight,
      dockRoot.clientWidth, dockRoot.clientHeight, api.width, api.height], [980, 650, 980, 650, 980, 650, 980, 650],
    'fixture host, theme, vendor root, and public API share the same initial viewport dimensions')
    const groupAction = activeScene.querySelector('.tl-dock-group-actions button')
    assert.ok(groupAction, 'the production group header includes an action control')
    const groupActionStyle = dom.window.getComputedStyle(groupAction)
    const workbenchTokens = activeScene.closest('.tl-workbench').style
    const groupActionRule = [...activeScene.closest('.tl-workbench').querySelectorAll('style')].map(style => style.textContent)
      .find(text => text.includes('.tl-dock-group-actions button'))
    assert.match(groupActionRule, /\.dv-tabs-and-actions-container\s*\{[^}]*min-height:\s*var\(--tl-dock-tab-height\)/)
    assert.match(groupActionRule, /\.tl-dock-group-actions button\s*\{[^}]*min-height:\s*var\(--tl-control-height\)/)
    const inlineActionRule = groupActionRule.match(/\.tl-dock-inline-actions button\s*\{[^}]*\}/)?.[0]
    assert.ok(inlineActionRule, 'inline group actions have a compact override within the dock tab header')
    assert.match(inlineActionRule, /height:\s*calc\(var\(--tl-dock-tab-height\)\s*-\s*[\d.]+px\)/)
    assert.match(inlineActionRule, /min-height:\s*0/)
    const actionHeight = groupActionStyle.height.match(/^calc\(var\(--tl-dock-tab-height\)\s*-\s*([\d.]+)px\)$/)
    assert.ok(actionHeight, 'the rendered action height follows the responsive dock-tab metric')
    const dockTabHeight = Number.parseFloat(workbenchTokens.getPropertyValue('--tl-dock-tab-height'))
    const renderedActionHeight = dockTabHeight - Number.parseFloat(actionHeight[1])
    assert.ok(Number.isFinite(dockTabHeight) && dockTabHeight > 0)
    assert.ok(renderedActionHeight > 0 && renderedActionHeight < dockTabHeight,
      'the compact action remains positive and bounded by the responsive dock-tab height')
    assert.equal(groupActionStyle.boxSizing, 'border-box', 'group action dimensions include padding and border')
    assert.equal(groupActionStyle.lineHeight, '1.2')
    assert.match(groupActionRule, /\.tl-dock-group-actions button\s*\{[^}]*padding:\s*var\(--tl-space-1\)\s+var\(--tl-space-2\)/)
    const compactFontSize = Number.parseFloat(workbenchTokens.getPropertyValue('--tl-font-compact'))
    const spaceOne = Number.parseFloat(workbenchTokens.getPropertyValue('--tl-space-1'))
    const controlHeight = Number.parseFloat(workbenchTokens.getPropertyValue('--tl-control-height'))
    const groupActionLineBox = compactFontSize * 1.2 + 2 * spaceOne + 2 * 1
    assert.ok(groupActionLineBox <= controlHeight,
      'group action text, density-scaled vertical padding, and borders fit the current control-height token')
    const toolbarFixture = dom.window.document.createElement('div')
    toolbarFixture.className = 'tl-dock-toolbar'
    toolbarFixture.innerHTML = '<button type="button">工具</button>'
    activeScene.appendChild(toolbarFixture)
    const toolbarControl = toolbarFixture.querySelector('button')
    const toolbarStyle = dom.window.getComputedStyle(toolbarControl)
    assert.equal(toolbarStyle.height, 'var(--tl-control-height)')
    assert.equal(toolbarStyle.boxSizing, 'border-box')
    assert.equal(toolbarStyle.lineHeight, '1.2')
    const toolbarRule = [...activeScene.closest('.tl-workbench').querySelectorAll('style')].map(style => style.textContent)
      .find(text => text.includes('.tl-dock-toolbar button'))
    assert.match(toolbarRule, /\.tl-dock-toolbar button, \.tl-dock-toolbar select[^\{]*\{[^}]*height:\s*var\(--tl-control-height\);[^}]*padding:\s*2px 10px/)
    const toolbarFontSize = Number.parseFloat(workbenchTokens.getPropertyValue('--tl-font-compact'))
    assert.ok(toolbarFontSize * 1.2 + 2 * 2 + 2 <= controlHeight,
      'toolbar text, compact control padding, and borders fit the current control-height token')
    assert.equal(activeScene.classList.contains('is-narrow'), false,
      'the 980x650 collaboration fixture uses the wide workbench DnD mode')
    const recommendation = api.toJSON()
    assert.equal(recommendation.grid.orientation, 'VERTICAL')
    assertSplitPercentages(recommendation.grid.root.data, [60, 40])
    assertSplitPercentages(recommendation.grid.root.data[0].data, [75, 25])
    assertSplitPercentages(recommendation.grid.root.data[1].data, [40, 60])
    assert.deepEqual(walkLeaves(recommendation.grid.root).map(leaf => leaf.views), [
      ['business-main'], ['files'], ['preview'], ['native-chat'],
    ])
    const threePaneDock = JSON.parse(JSON.stringify(recommendation))
    threePaneDock.grid.orientation = 'HORIZONTAL'
    threePaneDock.grid.root = { type: 'branch', size: 100, data: [
      { type: 'leaf', size: 100 / 3, data: { id: 'restore-left', views: ['business-main'], activeView: 'business-main' } },
      { type: 'leaf', size: 100 / 3, data: { id: 'restore-middle', views: ['preview'], activeView: 'preview' } },
      { type: 'leaf', size: 100 / 3, data: { id: 'restore-right', views: ['native-chat'], activeView: 'native-chat' } },
    ] }
    threePaneDock.activeGroup = 'restore-right'
    await act(async () => { api.fromJSON(threePaneDock, { reuseExistingPanels: true }); await settle(50) })
    const threePaneBeforeFloat = JSON.parse(JSON.stringify(api.toJSON()))
    assert.deepEqual(walkLeaves(threePaneBeforeFloat.grid.root).map(leaf => leaf.views),
      [['business-main'], ['preview'], ['native-chat']],
      'the production restore fixture places the native-chat pane as the rightmost third pane')
    const actualChatGroup = api.getPanel('native-chat').api.group
    const actualFloatButton = actualChatGroup.element.querySelector('.tl-dock-group-actions button[aria-label^="悬浮"]')
    assert.ok(actualFloatButton, 'the actual Dockview native-chat group exposes the production float action')
    const popoutFailures = []
    const popoutFailureListener = api.onDidOpenPopoutWindowFail?.(event => popoutFailures.push({ reason: event?.reason, error: event?.error?.message }))
    await act(async () => { actualFloatButton.click(); await settle(60) })
    const actualAfterFloat = JSON.parse(JSON.stringify(api.toJSON()))
    assert.equal(popoutUrlRequested, 1, 'the actual floating action requests one fresh desktop popout URL')
    assert.equal(actualAfterFloat.popoutGroups?.length, 1,
      `the actual Dockview API serializes an independent popout group; failures=${JSON.stringify(popoutFailures)} popupCount=${popupWindows.length} parentURL=${dom.window.location.href}`)
    const serializedPopout = actualAfterFloat.popoutGroups[0]
    assert.equal(serializedPopout.url, `dsh-app://app/desktop-pane-popout.html?ticket=${popoutTicket}`,
      'the independent popout URL uses the dedicated blank document and one well-formed ticket')
    assert.ok(serializedPopout.data?.views?.includes('native-chat')
      || serializedPopout.grid?.root?.data?.some(node => node.data?.views?.includes('native-chat')),
    'the serialized popout contains the existing native-chat panel')
    assert.equal(actualAfterFloat.floatingGroups?.length ?? 0, 0,
      'separate desktop popouts are not misreported as in-window floating groups')
    const mainGridViewsAfterFloat = walkLeaves(actualAfterFloat.grid.root).flatMap(leaf => leaf.views)
    assert.ok(mainGridViewsAfterFloat.includes('business-main') && mainGridViewsAfterFloat.includes('preview'))
    assert.equal(mainGridViewsAfterFloat.includes('native-chat'), false,
      'the panel is removed from the main grid while its live content is rendered in the child document')
    const actualPopouts = api.getPopouts()
    assert.equal(actualPopouts.length, 1)
    const popupWindow = actualPopouts[0].window
    assert.ok(popupWindow && popupWindow.opener === dom.window)
    assert.equal(popupWindow.location.protocol, 'dsh-app:')
    assert.equal(popupWindow.location.pathname, '/desktop-pane-popout.html')
    const popupContainer = popupWindow.document.querySelector('.dv-popout-window, .dv-popout-container, .dv-dockview')
    assert.ok(popupContainer, 'Dockview renders the existing panel in the independent popout document')
    assert.equal(popupWindow.document.querySelector('[data-native-chat-instance="true"]')?.textContent,
      'native chat fixture', 'the existing native-chat content is rendered in the popup document')
    const floatingBorderRule = [...activeScene.closest('.tl-workbench').querySelectorAll('style')]
      .map(style => style.textContent)
      .find(text => text.includes('.tl-dockview-host .dv-shell > .dv-floating-overlay-host > .dv-resize-container'))
    assert.ok(floatingBorderRule, 'the shell still carries the separate in-window float rule without treating it as popup styling')
    assert.match(floatingBorderRule, /var\(--tl-floating-accent\) 84%/,
      'the in-window floating-pane border uses a dedicated teal semantic token')
    const workbenchStyleText = [...activeScene.closest('.tl-workbench').querySelectorAll('style')]
      .map(style => style.textContent).join('\n')
    assert.match(workbenchStyleText, /\.tl-workbench\s*\{[^}]*--tl-floating-accent:\s*var\(--tl-theme-teal,\s*#74cec6\)/,
      'floating outline resolves through the active theme teal token with its known fallback')
    assert.match(floatingBorderRule, /var\(--tl-corner-radius\) \+ 2px/,
      'floating-pane radius follows the active density/theme radius token')
    assert.match(floatingBorderRule, /var\(--tl-ui-scale, 1\)/,
      'floating-pane halo scales with the active interface density')
    const popupDockButton = popupWindow.document.querySelector('.tl-dock-group-actions button[aria-label^="停靠"]')
    assert.ok(popupDockButton, 'the popout renders the production dock control for the same group')
    await act(async () => { popupDockButton.click(); await settle(120); api.layout(980, 650, true); await settle(40) })
    const actualAfterDock = JSON.parse(JSON.stringify(api.toJSON()))
    assert.deepEqual(walkLeaves(actualAfterDock.grid.root).map(leaf => leaf.views),
      walkLeaves(threePaneBeforeFloat.grid.root).map(leaf => leaf.views),
      'floating and docking through the real Dockview API preserves the original three-pane order')
    assertSizesNear(actualAfterDock.grid.root.data.map(child => child.size),
      threePaneBeforeFloat.grid.root.data.map(child => child.size), 1,
      `floating and docking through the real Dockview API preserves the original three-pane proportions; before=${JSON.stringify(threePaneBeforeFloat.grid.root)} after=${JSON.stringify(actualAfterDock.grid.root)}`)
    popoutFailureListener?.dispose?.()
    await act(async () => { api.fromJSON(recommendation, { reuseExistingPanels: true }); await settle(50) })
    // This JSDOM fixture has no laid-out floating overlay, so Dockview reports
    // a zero-sized transient float position to the mocked persistence layer.
    // Start the unrelated sash/DnD HTTP assertions from a clean baseline.
    putBodies.length = 0
    validatorErrors.length = 0
    putValidations.length = 0
    const nativeChatRootBeforeDrop = activeScene.querySelector('[data-native-chat-instance="true"]')
    assert.ok(nativeChatRootBeforeDrop, 'the mounted native-chat panel has a live React content node before a center drop')
    const nativeConversation = dom.window.document.createElement('div')
    nativeConversation.className = 'tl-native-conversation'
    nativeConversation.innerHTML = '<div data-slot="conversation.header"><header><div data-conversation-header-leading><button>导航</button></div><div data-slot="conversation.session.header"><nav aria-label="会话层级"><span data-session-title>示例会话</span></nav><button data-header-action>操作</button></div><div data-conversation-tabs role="tablist"><button role="tab">对话</button><button role="tab">详情</button></div></header></div><div data-content-phase="active"><div data-native-chat-header-fixture-content></div></div>'
    activeScene.appendChild(nativeConversation)
    const nativeHeader = nativeConversation.querySelector('[data-slot="conversation.header"] > header')
    const nativeTitle = nativeHeader?.querySelector('[data-session-title]')
    const nativeTabs = nativeHeader?.querySelector('[data-conversation-tabs]')
    assert.ok(nativeHeader && nativeTitle && nativeTabs, 'the production theme styles target stable native conversation header and tab slots')
    assert.equal(dom.window.getComputedStyle(nativeHeader).minHeight, 'calc(34px * var(--tl-ui-scale, 1))',
      'the embedded conversation header follows the current interface-density scale')
    const nativeHeaderRule = [...activeScene.closest('.tl-workbench').querySelectorAll('style')].map(style => style.textContent)
      .find(text => text.includes('.tl-native-conversation [data-slot="conversation.header"] > header'))
    assert.match(nativeHeaderRule, /:is\(\.tl-native-conversation > header, \.tl-native-conversation \[data-slot="conversation\.header"\] > header\)\s*\{[^}]*padding:\s*0\s+var\(--tl-space-3\)/,
      'the native header uses the density-scaled shared inset token')
    assert.equal(dom.window.getComputedStyle(nativeTitle).fontSize, 'var(--tl-font-body)', 'the native session title inherits the shared body-size token')
    assert.equal(dom.window.getComputedStyle(nativeTabs.querySelector('[role="tab"]')).fontSize,
      'var(--tl-font-compact)', 'native conversation tabs use the shared compact-size token')
    assert.equal(dom.window.getComputedStyle(nativeConversation).getPropertyValue('--dsw-alias-bg-base'),
      'var(--tl-theme-canvas)', 'native DSH colors resolve through the workbench theme tokens')
    assert.equal(nativeHeader.querySelectorAll('button').length, 4, 'native leading, action, and both tab controls remain present')
    assert.ok(nativeConversation.querySelector('[data-content-phase="active"]'),
      'the conversation header remains a sibling of the mounted active content slot')
    const sourceTab = activeScene.querySelector('.dv-tab[data-tab-panel-id="preview"]')
    const sourcePanel = api.getPanel('preview')
    const targetPanel = api.getPanel('native-chat')
    assert.ok(sourceTab && sourcePanel && targetPanel)
    assert.equal(api.dndCapabilities.pointer, true,
      `the real Dockview API must enable pointer DnD in the 980x650 scene; capabilities=${JSON.stringify(api.dndCapabilities)}`)
    assert.equal(api.dndCapabilities.pointerHandlesMouse, true)
    assert.equal(api.dndCapabilities.html5, false)
    const sourceGroupId = sourcePanel.api.group.id
    const targetGroupId = targetPanel.api.group.id
    let targetContent = targetPanel.api.group.element.querySelector('.dv-content-container')
    assert.ok(targetContent, 'the real native-chat group exposes its Dockview content drop target')
    let dropRect = { x: 540, y: 390, left: 540, top: 390, right: 920, bottom: 630, width: 380, height: 240,
      toJSON() { return this } }
    targetContent.getBoundingClientRect = () => dropRect
    targetPanel.api.group.element.getBoundingClientRect = () => dropRect
    Object.defineProperties(targetContent, {
      offsetWidth: { configurable: true, get: () => dropRect.width },
      offsetHeight: { configurable: true, get: () => dropRect.height },
    })
    Object.defineProperties(targetPanel.api.group.element, {
      offsetWidth: { configurable: true, get: () => dropRect.width },
      offsetHeight: { configurable: true, get: () => dropRect.height },
    })
    const pointerHits = []
    let pointerHitOverride = null
    const pointerHit = (x, y) => {
      pointerHits.push({ x, y })
      return x >= dropRect.left && x <= dropRect.right && y >= dropRect.top && y <= dropRect.bottom
      ? (pointerHitOverride ?? targetContent) : null
    }
    dom.window.document.elementFromPoint = (x, y) => pointerHit(x, y)
    dom.window.document.elementsFromPoint = (x, y) => {
      const hit = pointerHit(x, y)
      return hit ? [hit] : []
    }
    const previewEvents = []
    const previewListener = api.onWillShowOverlay(event => previewEvents.push({
      kind: event.kind, position: event.position, transfer: event.getData?.(),
    }))
    const finalDropEvents = []
    const finalDropListener = api.onWillDrop(event => finalDropEvents.push({
      kind: event.kind, position: event.position, transfer: event.getData?.(),
      groupId: event.group?.id ?? event.group?.model?.id,
    }))
    const dragStarts = []
    const dragStartListener = api.onWillDragPanel(event => dragStarts.push(event.panel?.id))
    let pointerId = 90
    const dragPointer = (type, x, y) => new dom.window.PointerEvent(type, {
      bubbles: true, cancelable: true, button: 0, buttons: type === 'pointerup' ? 0 : 1,
      clientX: x, clientY: y, pointerId, pointerType: 'mouse',
    })
    const geometryBeforeSingleSwap = geometrySignature(api.toJSON().grid)
    await act(async () => {
      sourceTab.dispatchEvent(dragPointer('pointerdown', 120, 20))
      dom.window.dispatchEvent(dragPointer('pointermove', 700, 510))
      dom.window.dispatchEvent(dragPointer('pointermove', 701, 511))
      assert.ok(pointerHits.length > 0, `the live Dockview controller hit-tests the active scene target after threshold; hits=${JSON.stringify(pointerHits)}`)
      assert.ok(previewEvents.some(event => event.kind === 'content' && event.position === 'center'),
        `the real source tab shows a center-drop preview on the occupied native-chat panel; events=${JSON.stringify(previewEvents)} hits=${JSON.stringify(pointerHits)}`)
      await settle(10)
      const previewHint = targetPanel.api.group.element.querySelector('.tl-dock-drop-intent[data-intent="swap"]')
      assert.ok(previewHint, `the center preview labels the target as a panel swap; events=${JSON.stringify(previewEvents)}`)
      assert.equal(previewHint.getAttribute('aria-label'), '交换面板')
      assert.ok(previewHint.parentElement.classList.contains('dv-groupview'))
      assert.ok(targetPanel.api.group.element.querySelector('.dv-drop-target'),
        'Dockview owns the active native overlay inside the target group')
      dom.window.dispatchEvent(dragPointer('pointermove', 1100, 680))
      await settle(10)
      assert.equal(Boolean(targetPanel.api.group.element.querySelector('.dv-drop-target')), false,
        'Dockview clears its native overlay when the pointer leaves all targets')
      assert.equal(activeScene.querySelector('.tl-dock-drop-intent'), null,
        'leaving all targets also clears the target-scoped intent hint')
      dom.window.dispatchEvent(dragPointer('pointerup', 1100, 680))
      await settle(10)
      pointerId++
      pointerHits.length = 0
      previewEvents.length = 0
      await settle(10)
      sourceTab.dispatchEvent(dragPointer('pointerdown', 120, 20))
      dom.window.dispatchEvent(dragPointer('pointermove', 700, 510))
      dom.window.dispatchEvent(dragPointer('pointermove', 701, 511))
      await settle(10)
      assert.ok(activeScene.querySelector('.tl-dock-drop-intent'), 'the next drag can show its own target intent')
      const previewsBeforePointerUp = previewEvents.length
      dom.window.dispatchEvent(dragPointer('pointerup', 701, 511))
      assert.ok(previewEvents.length > previewsBeforePointerUp,
        'the pointerup final-hit may dispatch a Dockview overlay update after window-capture cleanup was scheduled')
      await settle(60)
      assert.equal(activeScene.querySelector('.tl-dock-drop-intent'), null,
        'a settled center drop removes the custom intent after Dockview completes its pointerup final hit and drop callbacks')
    })
    assert.equal(api.getPanel('preview').api.group.id, targetGroupId,
      'center drop swaps the dragged active panel into the destination group')
    assert.equal(api.getPanel('native-chat').api.group.id, sourceGroupId,
      'the destination active panel moves to the dragged panel source group')
    assert.deepEqual(geometrySignature(api.toJSON().grid), geometryBeforeSingleSwap,
      'single-panel swap preserves group topology, IDs, orientations, and split sizes')
    assert.equal(activeScene.querySelector('[data-native-chat-instance="true"]'), nativeChatRootBeforeDrop,
      'center swap preserves the existing native-chat React content node')
    assert.ok(putBodies.length > 0, 'the center swap reaches the production HTTP layout save queue')
    assert.deepEqual(validatorErrors, [], 'the center-swap HTTP payload passes the production validator')
    assert.equal(putValidations.at(-1), true)

    previewEvents.length = 0
    pointerHits.length = 0
    pointerId++
    await act(async () => { api.fromJSON(recommendation, { reuseExistingPanels: true }); await settle(50) })
    const multiTarget = api.getPanel('native-chat')
    const multiTargetGroup = multiTarget.api.group
    await act(async () => {
      api.getPanel('files').api.moveTo({ group: multiTargetGroup, index: 1, skipSetActive: true })
      api.getPanel('business-main').api.moveTo({ group: multiTargetGroup, index: 2, skipSetActive: true })
      await settle(50)
    })
    const nonActiveTabsBeforeSwap = multiTargetGroup.panels.map(panel => panel.id).filter(id => id !== 'native-chat')
    assert.deepEqual(nonActiveTabsBeforeSwap, ['files', 'business-main'])
    const multiSource = api.getPanel('preview')
    const multiSourceGroupId = multiSource.api.group.id
    assert.notEqual(multiSourceGroupId, multiTargetGroup.id,
      `multitab source and destination are distinct Dockview groups; source=${multiSourceGroupId} target=${multiTargetGroup.id} targetPanels=${JSON.stringify(multiTargetGroup.panels.map(panel => panel.id))}`)
    targetContent = multiTargetGroup.element.querySelector('.dv-content-container')
    dropRect = { x: 540, y: 390, left: 540, top: 390, right: 920, bottom: 630, width: 380, height: 240,
      toJSON() { return this } }
    targetContent.getBoundingClientRect = () => dropRect
    multiTargetGroup.element.getBoundingClientRect = () => dropRect
    Object.defineProperties(targetContent, {
      offsetWidth: { configurable: true, get: () => dropRect.width },
      offsetHeight: { configurable: true, get: () => dropRect.height },
    })
    const multiSourceTab = activeScene.querySelector('.dv-tab[data-tab-panel-id="preview"]')
    assert.ok(multiSourceTab?.isConnected, 'the multitab drag source is the currently mounted Dockview tab')
    assert.equal(api.dndCapabilities.pointer, true, 'pointer DnD remains enabled after restoring the recommendation')
    const geometryBeforeMultiSwap = geometrySignature(api.toJSON().grid)
    await act(async () => {
      multiSourceTab.dispatchEvent(dragPointer('pointerdown', 120, 20))
      dom.window.dispatchEvent(dragPointer('pointermove', 700, 510))
      dom.window.dispatchEvent(dragPointer('pointermove', 701, 511))
      assert.ok(pointerHits.length > 0, `multitab fixture performs real Dockview hit testing; hits=${JSON.stringify(pointerHits)}`)
      assert.ok(previewEvents.some(event => event.kind === 'content' && event.position === 'center'),
        `multitab center overlay reaches Dockview; starts=${JSON.stringify(dragStarts)} events=${JSON.stringify(previewEvents)} hits=${JSON.stringify(pointerHits)}`)
      dom.window.dispatchEvent(dragPointer('pointerup', 701, 511))
      await settle(60)
    })
    assert.equal(multiTarget.api.group.id, multiSourceGroupId,
      'a center drop swaps the destination active panel when its group has multiple tabs')
    assert.equal(multiSource.api.group.id, multiTargetGroup.id)
    assert.deepEqual(multiTargetGroup.panels.map(panel => panel.id).filter(id => id !== 'preview'), nonActiveTabsBeforeSwap,
      'center swap preserves the destination nonactive tab order')
    assert.equal(multiTargetGroup.activePanel.id, 'preview', 'the dragged panel becomes active in the destination group')
    assert.deepEqual(geometrySignature(api.toJSON().grid), geometryBeforeMultiSwap,
      'multitab swap preserves group topology, IDs, orientations, and split sizes')
    assert.equal(activeScene.querySelector('[data-native-chat-instance="true"]'), nativeChatRootBeforeDrop,
      'multitab swap preserves the native-chat React content node')
    await act(async () => { api.fromJSON(recommendation, { reuseExistingPanels: true }); await settle(50) })
    assert.deepEqual(walkLeaves(api.toJSON().grid.root).map(leaf => leaf.views),
      [['business-main'], ['files'], ['preview'], ['native-chat']], 'the fixture can restore its recommendation after the multitab swap')

    const edgeSource = api.getPanel('files')
    const edgeTarget = api.getPanel('business-main')
    const edgeSourceGroup = edgeTarget.api.group
    await act(async () => {
      edgeSource.api.moveTo({ group: edgeSourceGroup, index: 1, skipSetActive: true })
      edgeTarget.api.setActive()
      await settle(30)
    })
    targetContent = edgeTarget.api.group.element.querySelector('.dv-content-container')
    targetContent.getBoundingClientRect = () => dropRect
    edgeTarget.api.group.element.getBoundingClientRect = () => dropRect
    Object.defineProperties(targetContent, {
      offsetWidth: { configurable: true, get: () => dropRect.width },
      offsetHeight: { configurable: true, get: () => dropRect.height },
    })
    pointerHits.length = 0
    previewEvents.length = 0
    pointerId++
    const sameGroupTab = activeScene.querySelector('.dv-tab[data-tab-panel-id="files"]')
    assert.ok(sameGroupTab?.isConnected)
    const sameGroupIdBeforeEdge = edgeSourceGroup.id
    await act(async () => {
      sameGroupTab.dispatchEvent(dragPointer('pointerdown', 120, 20))
      dom.window.dispatchEvent(dragPointer('pointermove', 915, 510))
      dom.window.dispatchEvent(dragPointer('pointermove', 916, 511))
      assert.ok(previewEvents.some(event => event.kind === 'content' && event.position === 'right'),
        `same-group tab drag previews a right-edge split; previews=${JSON.stringify(previewEvents)}`)
      dom.window.dispatchEvent(dragPointer('pointerup', 916, 511))
      await settle(60)
    })
    assert.notEqual(api.getPanel('files').api.group.id, sameGroupIdBeforeEdge,
      'dragging a tab out of a same-group multitab center edge creates the native split shown by its preview')
    assert.equal(api.getPanel('business-main').api.group.id, sameGroupIdBeforeEdge)
    assert.deepEqual(walkLeaves(api.toJSON().grid.root).map(leaf => leaf.views),
      [['business-main'], ['files'], ['preview'], ['native-chat']])

    await act(async () => { api.fromJSON(recommendation, { reuseExistingPanels: true }); await settle(50) })
    const bottomEdgeSource = api.getPanel('files')
    const bottomEdgeTarget = api.getPanel('business-main')
    const bottomEdgeGroup = bottomEdgeTarget.api.group
    await act(async () => {
      bottomEdgeSource.api.moveTo({ group: bottomEdgeGroup, index: 1, skipSetActive: true })
      bottomEdgeSource.api.setActive()
      await settle(40)
    })
    assert.equal(bottomEdgeGroup.activePanel.id, 'files', 'the bottom-edge source is the active tab in its multitab group')
    targetContent = bottomEdgeGroup.element.querySelector('.dv-content-container')
    targetContent.getBoundingClientRect = () => dropRect
    bottomEdgeGroup.element.getBoundingClientRect = () => dropRect
    Object.defineProperties(targetContent, {
      offsetWidth: { configurable: true, get: () => dropRect.width },
      offsetHeight: { configurable: true, get: () => dropRect.height },
    })
    Object.defineProperties(bottomEdgeGroup.element, {
      offsetWidth: { configurable: true, get: () => dropRect.width },
      offsetHeight: { configurable: true, get: () => dropRect.height },
    })
    pointerHits.length = 0
    previewEvents.length = 0
    finalDropEvents.length = 0
    pointerId++
    const activeBottomEdgeTab = activeScene.querySelector('.dv-tab[data-tab-panel-id="files"]')
    const bottomEdgeGroupId = bottomEdgeGroup.id
    await act(async () => {
      activeBottomEdgeTab.dispatchEvent(dragPointer('pointerdown', 120, 20))
      dom.window.dispatchEvent(dragPointer('pointermove', 700, 624))
      dom.window.dispatchEvent(dragPointer('pointermove', 701, 625))
      assert.ok(previewEvents.some(event => event.kind === 'content' && event.position === 'bottom'),
        `an active same-group tab at the content bottom edge previews a bottom split; previews=${JSON.stringify(previewEvents)} hits=${JSON.stringify(pointerHits)}`)
      dom.window.dispatchEvent(dragPointer('pointerup', 701, 625))
      await settle(80)
    })
    assert.ok(finalDropEvents.some(event => event.kind === 'content' && event.position === 'bottom'),
      `the final pointerup target matches the bottom-edge preview; drops=${JSON.stringify(finalDropEvents)}`)
    assert.notEqual(bottomEdgeSource.api.group.id, bottomEdgeGroupId,
      'dropping the active tab at its own group bottom edge detaches only that panel into a split')
    assert.equal(bottomEdgeTarget.api.group.id, bottomEdgeGroupId,
      'the original group retains its other panel after the same-group bottom split')
    assert.deepEqual(walkLeaves(api.toJSON().grid.root).map(leaf => leaf.views),
      [['business-main'], ['files'], ['preview'], ['native-chat']],
      'a bottom-edge tab drop preserves the other three groups instead of merging the row')

    await act(async () => { api.fromJSON(recommendation, { reuseExistingPanels: true }); await settle(50) })
    const groupSource = api.getPanel('business-main')
    const groupTarget = api.getPanel('native-chat')
    const groupSourceGroup = groupSource.api.group
    const groupTargetGroup = groupTarget.api.group
    await act(async () => {
      api.getPanel('files').api.moveTo({ group: groupSourceGroup, index: 1, skipSetActive: true })
      groupSource.api.setActive()
      await settle(40)
    })
    assert.deepEqual(groupSourceGroup.panels.map(panel => panel.id), ['business-main', 'files'])
    const groupHeaderSpace = groupSourceGroup.element.querySelector('.dv-void-container')
    targetContent = groupTargetGroup.element.querySelector('.dv-content-container')
    assert.ok(groupHeaderSpace && targetContent, 'the source group exposes blank header space and the target exposes its content')
    targetContent.getBoundingClientRect = () => dropRect
    groupTargetGroup.element.getBoundingClientRect = () => dropRect
    Object.defineProperties(targetContent, {
      offsetWidth: { configurable: true, get: () => dropRect.width },
      offsetHeight: { configurable: true, get: () => dropRect.height },
    })
    pointerHits.length = 0
    previewEvents.length = 0
    pointerId++
    const geometryBeforeGroupSwap = geometrySignature(api.toJSON().grid)
    const groupIdBeforeGroupSwap = groupSourceGroup.id
    const targetGroupIdBeforeGroupSwap = groupTargetGroup.id
    await act(async () => {
      groupHeaderSpace.dispatchEvent(dragPointer('pointerdown', 120, 20))
      dom.window.dispatchEvent(dragPointer('pointermove', 700, 510))
      dom.window.dispatchEvent(dragPointer('pointermove', 701, 511))
      assert.ok(pointerHits.length > 0, 'group-header drag reaches real Dockview target hit testing')
      const groupTransfer = previewEvents.find(event => event.kind === 'content')?.transfer
      assert.ok(groupTransfer, `the real group drag publishes its Dockview transfer; previews=${JSON.stringify(previewEvents)}`)
      assert.equal(groupTransfer.viewId, api.id)
      assert.equal(groupTransfer.groupId, groupIdBeforeGroupSwap)
      assert.equal(groupTransfer.panelId, null, 'a blank-header drag is a group transfer with no panel ID')
      assert.ok(previewEvents.some(event => event.kind === 'content' && event.position === 'center'),
        `group drag shows a center content preview; previews=${JSON.stringify(previewEvents)}`)
      dom.window.dispatchEvent(dragPointer('pointerup', 701, 511))
      await settle(80)
    })
    assert.equal(api.getPanel('business-main').api.group.id, targetGroupIdBeforeGroupSwap,
      'dropping a whole-group header source at the content center swaps its active panel into the target group')
    assert.equal(api.getPanel('native-chat').api.group.id, groupIdBeforeGroupSwap,
      'the content target active panel moves into the dragged source group')
    assert.deepEqual(api.getPanel('files').api.group.panels.map(panel => panel.id), ['native-chat', 'files'],
      'a group swap preserves the source group nonactive tab')
    assert.deepEqual(geometrySignature(api.toJSON().grid), geometryBeforeGroupSwap,
      'a group-header center swap preserves the existing Dockview topology and split sizes')
    await act(async () => { api.fromJSON(recommendation, { reuseExistingPanels: true }); await settle(50) })

    const blankHeaderSource = api.getPanel('preview')
    const blankHeaderTarget = api.getPanel('native-chat').api.group
    const targetVoidHeader = blankHeaderTarget.element.querySelector('.dv-void-container')
    assert.ok(targetVoidHeader, 'the destination group exposes its real Dockview blank header drop target')
    blankHeaderTarget.element.getBoundingClientRect = () => dropRect
    targetVoidHeader.getBoundingClientRect = () => dropRect
    Object.defineProperties(blankHeaderTarget.element, {
      offsetWidth: { configurable: true, get: () => dropRect.width },
      offsetHeight: { configurable: true, get: () => dropRect.height },
    })
    Object.defineProperties(targetVoidHeader, {
      offsetWidth: { configurable: true, get: () => dropRect.width },
      offsetHeight: { configurable: true, get: () => dropRect.height },
    })
    pointerHitOverride = targetVoidHeader
    pointerHits.length = 0
    previewEvents.length = 0
    finalDropEvents.length = 0
    pointerId++
    const blankHeaderTab = activeScene.querySelector('.dv-tab[data-tab-panel-id="preview"]')
    await act(async () => {
      blankHeaderTab.dispatchEvent(dragPointer('pointerdown', 120, 20))
      dom.window.dispatchEvent(dragPointer('pointermove', 700, 510))
      dom.window.dispatchEvent(dragPointer('pointermove', 701, 511))
      assert.ok(previewEvents.some(event => event.kind === 'header_space'),
        `a real panel-tab drag over blank header reports Dockview header_space; previews=${JSON.stringify(previewEvents)} hits=${JSON.stringify(pointerHits)} starts=${JSON.stringify(dragStarts)} target=${targetVoidHeader.className}`)
      dom.window.dispatchEvent(dragPointer('pointerup', 701, 511))
      await settle(80)
    })
    assert.ok(finalDropEvents.some(event => event.kind === 'tab' && event.position === 'center'),
      `Dockview resolves a blank-header drop as an indexed tab insertion; drops=${JSON.stringify(finalDropEvents)}`)
    assert.equal(blankHeaderSource.api.group.id, blankHeaderTarget.id,
      'a panel-tab drop on another group blank header joins that native tab group')
    assert.ok(blankHeaderTarget.panels.some(panel => panel.id === 'preview'))
    pointerHitOverride = null
    await act(async () => { api.fromJSON(recommendation, { reuseExistingPanels: true }); await settle(50) })
    previewListener.dispose?.()
    finalDropListener.dispose?.()
    dragStartListener.dispose?.()
    const rawPanelRecord = recommendation.panels['business-main']
    const allowedPanelKeys = ['id', 'contentComponent', 'title', 'renderer', 'params']
    const rawExtraKeys = Object.keys(rawPanelRecord).filter(key => !allowedPanelKeys.includes(key))
    const wireRecommendation = JSON.parse(JSON.stringify(recommendation))
    const wireExtraKeys = Object.keys(wireRecommendation.panels['business-main']).filter(key => !allowedPanelKeys.includes(key))
    assert.ok(rawExtraKeys.length > 0, 'raw Dockview API objects include UI-only defaults outside the persisted schema')
    assert.deepEqual(wireExtraKeys, [], 'no Dockview UI-default fields survive JSON HTTP serialization')
    assert.ok(rawExtraKeys.every(key => rawPanelRecord[key] === undefined || typeof rawPanelRecord[key] === 'function'),
      'raw-only UI fields have no JSON representation and therefore cannot reach persisted state')
    putBodies.length = 0
    validatorErrors.length = 0
    putValidations.length = 0
    const expandButton = activeScene.querySelector('.tl-dock-group-actions button[aria-label^="展开"]')
    assert.ok(expandButton, 'the production group header exposes its real maximize action')
    const resizeThroughRealSash = async (delta, axis = 'x', occurrence = 0) => {
      const sashes = [...activeScene.querySelectorAll('.dv-sash.dv-enabled')]
      const sash = sashes.filter(candidate => {
        const movesOnX = candidate.parentElement?.parentElement?.classList.contains('dv-horizontal')
        return movesOnX === (axis === 'x')
      })[occurrence]
      assert.ok(sash, `the real Dockview grid exposes enabled ${axis}-axis sash ${occurrence}; found ${sashes.length}`)
      const start = { clientX: 400, clientY: 300 }
      const finish = axis === 'x' ? { clientX: 400 + delta, clientY: 300 } : { clientX: 400, clientY: 300 + delta }
      await act(async () => {
        sash.dispatchEvent(new dom.window.MouseEvent('pointerdown', { bubbles: true, ...start }))
        dom.window.document.dispatchEvent(new dom.window.MouseEvent('pointermove', { bubbles: true, ...finish }))
        dom.window.document.dispatchEvent(new dom.window.MouseEvent('pointerup', { bubbles: true, ...finish }))
        await settle(50)
      })
      return JSON.parse(JSON.stringify(api.toJSON()))
    }
    const beforeResize = JSON.parse(JSON.stringify(api.toJSON()))
    const geometryForKeyboardResize = () => {
      const rootElement = activeScene.querySelector('.tl-dockview-theme')
      assert.ok(rootElement, 'the Dockview root exposes its public layout surface')
      const root = api.toJSON().grid.root
      const topHeight = 650 * root.data[0].size / root.size
      const bottomTop = topHeight + 8
      const bottomHeight = 650 - bottomTop
      const topLeftWidth = 980 * root.data[0].data[0].size / root.data[0].data.reduce((sum, item) => sum + item.size, 0)
      const bottomLeftWidth = 980 * root.data[1].data[0].size / root.data[1].data.reduce((sum, item) => sum + item.size, 0)
      geometryOverrides.set(rootElement, { x: 0, y: 0, left: 0, top: 0, right: 980, bottom: 650, width: 980, height: 650, toJSON() { return this } })
      const groupRects = new Map([
        ['business-main', { left: 0, top: 0, width: topLeftWidth, height: topHeight }],
        ['files', { left: topLeftWidth, top: 0, width: 980 - topLeftWidth, height: topHeight }],
        ['preview', { left: 0, top: bottomTop, width: bottomLeftWidth, height: bottomHeight }],
        ['native-chat', { left: bottomLeftWidth, top: bottomTop, width: 980 - bottomLeftWidth, height: bottomHeight }],
      ])
      for (const [panelId, rect] of groupRects) {
        const group = api.getPanel(panelId)?.api.group
        assert.ok(group?.element, `the public ${panelId} group exposes a geometry element`)
        geometryOverrides.set(group.element, {
          x: rect.left, y: rect.top, left: rect.left, top: rect.top,
          right: rect.left + rect.width, bottom: rect.top + rect.height,
          width: rect.width, height: rect.height, toJSON() { return this },
        })
      }
      const rootSash = [...activeScene.querySelectorAll('.dv-sash.dv-enabled')].find(candidate =>
        !candidate.parentElement?.parentElement?.classList.contains('dv-horizontal'))
      assert.ok(rootSash, 'the real Dockview root divider is available for keyboard interaction')
      // The real root sash spans the row even when neighboring group pairs
      // overlap only across portions of that row.
      geometryOverrides.set(rootSash, { x: 0, y: topHeight - 4, left: 0, top: topHeight - 4, right: 980, bottom: topHeight + 4, width: 980, height: 8, toJSON() { return this } })
      return rootSash
    }
    const keyboardSash = geometryForKeyboardResize()
    keyboardSashAttributeSnapshot = {
      element: keyboardSash,
      attributes: Object.fromEntries(['tabindex', 'role', 'aria-orientation', 'aria-label', 'aria-valuemin', 'aria-valuemax', 'aria-valuenow', 'aria-valuetext']
        .map(name => [name, keyboardSash.getAttribute(name)])),
    }
    keyboardSash.setAttribute('class', keyboardSash.className)
    await settle(20)
    assert.equal(keyboardSash.getAttribute('role'), 'separator', 'the visible enabled sash has accessible separator semantics')
    assert.equal(keyboardSash.getAttribute('aria-orientation'), 'horizontal', 'the root sash adjusts the upper/lower heights')
    assert.equal(keyboardSash.getAttribute('tabindex'), '0', 'the real sash can receive keyboard focus')
    const wrongAxisEvent = new dom.window.KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true })
    keyboardSash.dispatchEvent(wrongAxisEvent)
    assert.equal(wrongAxisEvent.defaultPrevented, false, 'a key for the other sash axis is left to native navigation')
    const modifiedEvent = new dom.window.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true, ctrlKey: true })
    keyboardSash.dispatchEvent(modifiedEvent)
    assert.equal(modifiedEvent.defaultPrevented, false, 'modified shortcut keys are not intercepted')
    for (const panelId of ['business-main', 'files', 'preview', 'native-chat']) {
      const group = api.getPanel(panelId)?.api.group
      if (group?.element) geometryOverrides.delete(group.element)
    }
    keyboardSash.setAttribute('class', keyboardSash.className)
    await settle(20)
    assert.equal(keyboardSash.getAttribute('role'), null, 'a sash without a trusted neighboring-group pair is not advertised as adjustable')
    const unpairedEvent = new dom.window.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true })
    keyboardSash.dispatchEvent(unpairedEvent)
    assert.equal(unpairedEvent.defaultPrevented, false, 'an unpaired sash does not consume arrow keys')
    geometryForKeyboardResize()
    keyboardSash.setAttribute('class', keyboardSash.className)
    await settle(20)
    assert.equal(keyboardSash.getAttribute('role'), 'separator', 'the sash returns to the adjustable state once public geometry is available')
    const keyboardBefore = JSON.parse(JSON.stringify(api.toJSON()))
    putBodies.length = 0
    validatorErrors.length = 0
    putValidations.length = 0
    keyboardSash.focus()
    await act(async () => {
      keyboardSash.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }))
      await settle(60)
    })
    const keyboardAfter = JSON.parse(JSON.stringify(api.toJSON()))
    assert.notEqual(keyboardAfter.grid.root.data[0].size, keyboardBefore.grid.root.data[0].size,
      'ArrowDown resizes the real upper group through the public group API')
    assert.ok(putBodies.length > 0, 'keyboard resizing reaches the existing layout persistence queue')
    assert.deepEqual(validatorErrors, [], 'the keyboard resize HTTP body passes the production validator')
    assert.equal(putValidations.at(-1), true)
    const keyboardAfterDown = keyboardAfter.grid.root.data[0].size
    const keyboardSashAfterDown = geometryForKeyboardResize()
    keyboardSashAfterDown.setAttribute('class', keyboardSashAfterDown.className)
    await settle(20)
    const reverseEvent = new dom.window.KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true, cancelable: true, shiftKey: true })
    keyboardSashAfterDown.dispatchEvent(reverseEvent)
    await settle(60)
    assert.ok(api.toJSON().grid.root.data[0].size < keyboardAfterDown,
      'ArrowUp with Shift uses the accelerated inverse resize on the same real sash')
    assert.equal(sceneState.activeSceneId, 'products', 'keyboard sash resizing does not change the active scene')

    putBodies.length = 0
    validatorErrors.length = 0
    putValidations.length = 0
    const resized = await resizeThroughRealSash(30, 'y')
    assert.notEqual(resized.grid.root.data[0].size, beforeResize.grid.root.data[0].size,
      'the real root vertical Dockview sash gesture changes its serialized top/bottom split size')
    assert.ok(putBodies.length > 0, 'a real sash-end layout event reaches the production HTTP PUT queue')
    const resizeBody = JSON.parse(JSON.stringify(putBodies.at(-1)))
    const resizeRecord = resizeBody.scenes.products
    assert.deepEqual(validatorErrors, [], 'the actual pointer-resize HTTP body passes the production validator')
    assert.equal(putValidations.at(-1), true)
    assert.deepEqual(Object.keys(resizeRecord.dockview.grid).sort(), ['height', 'orientation', 'root', 'width'])
    assertSizesNear(resizeRecord.dockview.grid.root.data.map(child => child.size),
      resized.grid.root.data.map(child => child.size), 1, 'sash resize HTTP body root size')

    putBodies.length = 0
    validatorErrors.length = 0
    putValidations.length = 0
    const beforeMaximize = JSON.parse(JSON.stringify(api.toJSON()))
    const beforeMaximizeRoot = beforeMaximize.grid.root.data
    const beforeMaximizePercentages = beforeMaximizeRoot.map(child => child.size / beforeMaximizeRoot.reduce((sum, item) => sum + item.size, 0) * 100)
    let maximizeEvents = 0
    const maximizeEvent = api.onDidMaximizedGroupChange(() => { maximizeEvents++ })
    await act(async () => { expandButton.click(); await settle(50) })
    await act(async () => { api.layout(940, 540, true); await settle(30) })
    const maximized = JSON.parse(JSON.stringify(api.toJSON()))
    assert.equal(api.getPanel('business-main').api.isMaximized(), true,
      'the production header action maximizes the active business panel')
    assert.deepEqual(Object.keys(beforeMaximize.grid).sort(), ['height', 'orientation', 'root', 'width'])
    assert.deepEqual(Object.keys(maximized.grid).sort(), ['height', 'maximizedNode', 'orientation', 'root', 'width'],
      'the real JSON Dockview serializer adds maximizedNode while a group is maximized')
    assert.equal(maximized.grid.width, 940, 'the real maximized Dockview instance accepts the resized width')
    assert.equal(maximized.grid.height, 540, 'the real maximized Dockview instance accepts the resized height')
    assert.equal(maximizeEvents, 1)
    assert.equal(putBodies.length, 0, 'the production save queue does not issue an HTTP request for the transient maximize state')
    await act(async () => { api.layout(940, 540, true); await settle(30) })
    assert.equal(api.hasMaximizedGroup(), true, 'a layout pass during maximize does not silently exit the transient state')
    assert.equal(Object.hasOwn(JSON.parse(JSON.stringify(api.toJSON())).grid, 'maximizedNode'), true)
    assert.equal(putBodies.length, 0, 'a Dockview resize/layout event while maximized does not persist maximizedNode')
    const restoreButton = activeScene.querySelector('.tl-dock-group-actions button[aria-label^="还原"]')
    assert.ok(restoreButton, 'the production group header changes to its restore action')
    const maxGroupBeforeResizeRestore = api.getPanel('business-main').api.group.element
    maxGroupBeforeResizeRestore.getBoundingClientRect = () => ({ x: 0, y: 0, left: 0, top: 0, right: 940, bottom: 540, width: 940, height: 540, toJSON() { return this } })
    holdAnimationFrames = true
    await act(async () => { restoreButton.click() })
    const groupAfterResizeRestore = api.getPanel('business-main').api.group.element
    assert.ok(groupAfterResizeRestore.isConnected, 'the resize-restored group element remains attached to the active Dockview')
    assert.equal(groupAfterResizeRestore, api.getPanel('business-main').api.group.element,
      'restore animation resolves the panel current group element after the restore API completes')
    groupAfterResizeRestore.getBoundingClientRect = () => ({ x: 0, y: 36, left: 0, top: 36, right: 400, bottom: 340, width: 400, height: 304, toJSON() { return this } })
    const restoreStartFrames = heldAnimationFrames.splice(0)
    assert.ok(restoreStartFrames.length > 0, 'the production restore action schedules its geometry animation after layout restore')
    await act(async () => { for (const callback of restoreStartFrames) callback(Date.now()) })
    assert.equal(groupAfterResizeRestore.style.transition, 'none',
      'the FLIP first frame disables transition while applying its inverse geometry')
    assert.match(groupAfterResizeRestore.style.transform, /^translate\(0px, -36px\) scale\(2\.35, 1\.776315/,
      'the inverse transform is computed from the real pre-restore and post-restore group rectangles')
    await act(async () => {
      let framePasses = 0
      while (heldAnimationFrames.length && framePasses++ < 4) {
        for (const callback of heldAnimationFrames.splice(0)) callback(Date.now())
      }
      await settle(30)
    })
    holdAnimationFrames = false
    await act(async () => { await settle(50) })
    assert.match(groupAfterResizeRestore.style.transition, /200ms/,
      'resize restore animates the current group element rather than a stale pre-restore node')
    for (const callback of heldAnimationFrames.splice(0)) callback(Date.now())
    await act(async () => { api.layout(980, 650, true); await settle(30) })
    const restoredAfterMaximize = JSON.parse(JSON.stringify(api.toJSON()))
    assert.equal(api.hasMaximizedGroup(), false, 'the production restore action exits maximized mode')
    maximizeEvent.dispose?.()
    assert.equal(Object.hasOwn(restoredAfterMaximize.grid, 'maximizedNode'), false,
      'the real restore action removes the transient maximizedNode from serialized layout')
    assertSplitPercentages(restoredAfterMaximize.grid.root.data, beforeMaximizePercentages, 0.5)
    assert.equal(activeScene.querySelector('[data-native-chat-instance="true"]'), nativeChatRootBeforeDrop,
      'restore reapplies the normal tree with existing panel instances, preserving native-chat DOM')
    assert.ok(putBodies.length > 0, 'restoring after a maximize-time resize saves the normal geometry')
    const restoredLayoutBody = JSON.parse(JSON.stringify(putBodies.at(-1)))
    assert.deepEqual(validatorErrors, [], 'the normal layout saved after restore passes the production validator')
    assert.equal(Object.hasOwn(restoredLayoutBody.scenes.products.dockview.grid, 'maximizedNode'), false,
      'the restore save persists only the normal tree')
    putBodies.length = 0
    validatorErrors.length = 0
    putValidations.length = 0
    const resavedAfterRestore = await resizeThroughRealSash(18, 'y')
    assert.ok(putBodies.length > 0, 'a real sash-end layout event after restore reaches the production HTTP PUT queue')
    const restoredBody = JSON.parse(JSON.stringify(putBodies.at(-1)))
    const restoredRecord = restoredBody.scenes.products
    assert.deepEqual(validatorErrors, [], 'the actual post-restore HTTP body passes the production validator')
    assert.equal(putValidations.at(-1), true)
    assert.equal(Object.hasOwn(restoredRecord.dockview.grid, 'maximizedNode'), false,
      'the accepted post-restore HTTP body omits maximizedNode')
    assertSizesNear(restoredRecord.dockview.grid.root.data.map(child => child.size),
      resavedAfterRestore.grid.root.data.map(child => child.size), 1, 'post-restore HTTP body root size')
    await act(async () => { await settle(230) })

    const dblClickPanel = api.getPanel('business-main')
    const dblClickGroupElement = dblClickPanel.api.group.element
    const originalGroupRect = dblClickGroupElement.getBoundingClientRect
    dblClickGroupElement.getBoundingClientRect = () => dblClickPanel.api.isMaximized()
      ? { x: 0, y: 0, left: 0, top: 0, right: 980, bottom: 650, width: 980, height: 650, toJSON() { return this } }
      : { x: 0, y: 36, left: 0, top: 36, right: 400, bottom: 340, width: 400, height: 304, toJSON() { return this } }
    const businessTab = activeScene.querySelector('.dv-tab[data-tab-panel-id="business-main"]')
    const contentDoubleClick = new dom.window.MouseEvent('dblclick', { bubbles: true, cancelable: true, detail: 2 })
    await act(async () => {
      activeScene.querySelector('.dv-content-container').dispatchEvent(contentDoubleClick)
      await settle(20)
    })
    assert.equal(dblClickPanel.api.isMaximized(), false, 'double-clicking panel content does not maximize')
    const closeAction = businessTab.querySelector('.dv-default-tab-action,[role="button"],[aria-label*="关闭"],[title*="关闭"]')
    assert.ok(closeAction, 'the Dockview tab exposes its actual close action in the header')
    await act(async () => {
      closeAction.dispatchEvent(new dom.window.MouseEvent('dblclick', { bubbles: true, cancelable: true, detail: 2 }))
      await settle(20)
    })
    assert.equal(dblClickPanel.api.isMaximized(), false, 'double-clicking a tab close/action control does not maximize')
    await act(async () => {
      businessTab.dispatchEvent(new dom.window.MouseEvent('dblclick', { bubbles: true, cancelable: true, detail: 2 }))
      await settle(30)
    })
    assert.equal(dblClickPanel.api.isMaximized(), true, 'double-clicking a tab uses the existing panel maximize API')
    assert.match(dblClickPanel.api.group.element.style.transition, /200ms/, 'maximize uses the requested 200ms geometry transition on the current group element')
    const restoreAction = activeScene.querySelector('.tl-dock-group-actions button[aria-label^="还原"]')
    await act(async () => restoreAction.dispatchEvent(new dom.window.MouseEvent('dblclick', { bubbles: true, cancelable: true, detail: 2 })))
    assert.equal(dblClickPanel.api.isMaximized(), true, 'double-clicking a header action button is excluded from maximize handling')
    const blankHeader = dblClickGroupElement.querySelector('.dv-tabs-and-actions-container')
    await act(async () => {
      blankHeader.dispatchEvent(new dom.window.MouseEvent('dblclick', { bubbles: true, cancelable: true, detail: 2 }))
    })
    assert.equal(dblClickPanel.api.isMaximized(), false, 'double-clicking group header space restores the existing group')
    const restoredDoubleClickGroup = dblClickPanel.api.group.element
    assert.ok(restoredDoubleClickGroup.isConnected, 'the restored Dockview group element remains connected')
    restoredDoubleClickGroup.getBoundingClientRect = () => ({ x: 0, y: 36, left: 0, top: 36, right: 400, bottom: 340, width: 400, height: 304, toJSON() { return this } })
    await act(async () => { await settle(30) })
    assert.match(restoredDoubleClickGroup.style.transition, /200ms/,
      'restore FLIP targets the fresh panel.api.group.element after restoring the layout')
    await act(async () => { await settle(280) })
    assert.equal(restoredDoubleClickGroup.style.transform, '', 'the FLIP transform is removed after the transition')
    assert.equal(restoredDoubleClickGroup.style.transition, '', 'the temporary transition is removed after the transition')
    dblClickGroupElement.getBoundingClientRect = originalGroupRect
    const originalMatchMedia = dom.window.matchMedia
    dom.window.matchMedia = query => ({ matches: query.includes('prefers-reduced-motion: reduce'), media: query,
      addEventListener() {}, removeEventListener() {} })
    try {
      const reducedMotionGroup = dblClickPanel.api.group.element
      const reducedMotionTab = activeScene.querySelector('.dv-tab[data-tab-panel-id="business-main"]')
      await act(async () => {
        reducedMotionTab.dispatchEvent(new dom.window.MouseEvent('dblclick', { bubbles: true, cancelable: true, detail: 2 }))
        await settle(30)
      })
      assert.equal(dblClickPanel.api.isMaximized(), true, 'reduced motion keeps the maximize action functional')
      assert.equal(reducedMotionGroup.style.transform, '', 'reduced motion does not apply a FLIP transform')
      assert.equal(reducedMotionGroup.style.transition, '', 'reduced motion does not apply an animated transition')
      const reducedRestore = activeScene.querySelector('.tl-dock-group-actions button[aria-label^="还原"]')
      await act(async () => { reducedRestore.click(); await settle(30) })
    } finally {
      if (originalMatchMedia) dom.window.matchMedia = originalMatchMedia
      else delete dom.window.matchMedia
    }

    const nestedVertical = JSON.parse(JSON.stringify(api.toJSON()))
    nestedVertical.grid.orientation = 'HORIZONTAL'
    await act(async () => { api.fromJSON(nestedVertical, { reuseExistingPanels: true }); await settle(40) })
    const nestedBefore = JSON.parse(JSON.stringify(api.toJSON()))
    assert.equal(nestedBefore.grid.orientation, 'HORIZONTAL')
    assert.ok(nestedBefore.grid.root.data.every(child => child.type === 'branch'),
      'the real Dockview tree contains nested column branches for the vertical sash check')
    const nestedFirstRow = nestedBefore.grid.root.data[0].data.map(child => child.size)
    assert.ok(nestedFirstRow.length > 1)
    putBodies.length = 0
    validatorErrors.length = 0
    putValidations.length = 0
    const nestedResized = await resizeThroughRealSash(24, 'y', 0)
    const nestedAfter = nestedResized.grid.root.data[0].data.map(child => child.size)
    assert.notDeepEqual(nestedAfter, nestedFirstRow,
      'dragging a nested vertical sash changes that row split rather than the root column split')
    assert.deepEqual(nestedResized.grid.root.data.map(child => child.size),
      nestedBefore.grid.root.data.map(child => child.size),
      'nested vertical sash resizing preserves the root horizontal column geometry')
    const nestedBody = JSON.parse(JSON.stringify(putBodies.at(-1)))
    assert.ok(nestedBody, 'the nested vertical sash reaches the production save queue')
    assert.deepEqual(validatorErrors, [], 'the real nested vertical sash PUT passes the production validator')
    assert.equal(putValidations.at(-1), true)
    assertSizesNear(nestedBody.scenes.products.dockview.grid.root.data[0].data.map(child => child.size), nestedAfter, 1,
      'nested vertical sash PUT stores the actual row split sizes')
    await act(async () => { api.fromJSON(resized, { reuseExistingPanels: true }); await settle(40) })

    await act(async () => { api.layout(960, 560, true); await settle() })
    const boundaryLayout = JSON.parse(JSON.stringify(api.toJSON()))
    assert.equal(boundaryLayout.grid.orientation, 'VERTICAL')
    assert.deepEqual(walkLeaves(boundaryLayout.grid.root).map(leaf => leaf.views),
      walkLeaves(resized.grid.root).map(leaf => leaf.views),
      'the real Dockview serializer preserves the current four-panel topology, including the user-visible center swap, at the configured fit boundary')
    await act(async () => { api.layout(980, 650, true); await settle() })

    const custom = JSON.parse(JSON.stringify(recommendation))
    const customTotal = custom.grid.root.data.reduce((sum, child) => sum + child.size, 0)
    const expectedCustomSizes = [Math.round(customTotal * 0.63), 0]
    expectedCustomSizes[1] = customTotal - expectedCustomSizes[0]
    custom.grid.root.data[0].size = expectedCustomSizes[0]
    custom.grid.root.data[1].size = expectedCustomSizes[1]
    await act(async () => { api.fromJSON(custom); await settle() })
    const customApplied = api.toJSON()
    assertSplitPercentages(customApplied.grid.root.data, [63, 37])
    assert.ok(Math.abs(customApplied.grid.root.data[0].size / customTotal * 100 - 60) > 2,
      'the custom 63/37 tree is observably different from the default 60/40 recommendation')
    assertSizesNear(customApplied.grid.root.data.map(child => child.size), expectedCustomSizes, 2)

    const auxiliary = api.getPanel('files')
    assert.ok(auxiliary)
    await act(async () => {
      auxiliary.api.close()
      await settle(20)
    })
    await act(async () => { await settle(30) })
    assert.ok(putBodies.length > 0, 'closing a real panel reaches the client queueDockLayoutSave HTTP PUT path')
    const bodyOverHttp = JSON.parse(JSON.stringify(putBodies.at(-1)))
    const sentRecord = bodyOverHttp.scenes.products
    assert.deepEqual(sentRecord.closedPanelIds, ['files', 'assistant-center', 'assistant-delivery', 'assistant-user-profile', 'native-workspace'],
      'the HTTP record keeps parallel assistants and project files closed by default while persisting the user-closed files pane')
    assertSizesNear(sentRecord.dockview.grid.root.data.map(child => child.size), expectedCustomSizes, 2,
      'the actual HTTP save preserves the changed split, rather than merely preserving its ordering')
    const extraKeysAfterJson = [...new Set(Object.values(sentRecord.dockview.panels).flatMap(panel =>
      Object.keys(panel).filter(key => !['id', 'contentComponent', 'title', 'renderer', 'params'].includes(key))))].sort()
    assert.deepEqual(extraKeysAfterJson, [], 'undefined Dockview UI defaults disappear at the real JSON HTTP boundary; persisted fields match the strict schema')
    assert.deepEqual(validatorErrors, [], 'the production server layout validator accepts the HTTP payload')

    const normalized = normalizeDockLayouts(config, bodyOverHttp).scenes.products
    const beforeRestore = walkLeaves(normalized.dockview.grid.root)
    await act(async () => { api.fromJSON(normalized.dockview); await settle() })
    await act(async () => { await settle(20) })
    const restored = JSON.parse(JSON.stringify(api.toJSON()))
    assert.deepEqual(Object.keys(restored.panels).sort(), ['business-main', 'native-chat', 'preview'])
    assert.equal(restored.grid.orientation, 'VERTICAL')
    assert.deepEqual(walkLeaves(restored.grid.root).map(leaf => leaf.views), beforeRestore.map(leaf => leaf.views))
    assertSplitPercentages(restored.grid.root.data, [63, 37])
    assertSizesNear(restored.grid.root.data.map(child => child.size), expectedCustomSizes, 2,
      'normalized server state restored through Dockview retains the custom ratio within 2px')
    assert.ok(Math.abs(restored.grid.root.data[0].size / expectedCustomSizes.reduce((sum, size) => sum + size, 0) * 100 - 60) > 2,
      'restoration did not silently reset the custom layout to the default 60/40 recommendation')

    const priorPutCount = putBodies.length
    nextPutResponse = {
      ok: false,
      status: 400,
      async json() { return { error: 'invalid-dock-layout', message: 'PRIVATE_RESPONSE_DETAIL' } },
    }
    await resizeThroughRealSash(9)
    const layoutAlert = host.querySelector('.tl-dock-layout-error[role="alert"]')
    assert.ok(layoutAlert, 'the real rejected HTTP save is surfaced in the workbench')
    assert.match(layoutAlert.textContent, /HTTP 400.*invalid-dock-layout/)
    assert.doesNotMatch(layoutAlert.textContent, /PRIVATE_RESPONSE_DETAIL/,
      'the workbench shows only allowlisted HTTP status/code, never response detail')
    assert.equal(putBodies.length, priorPutCount + 1, 'the diagnostic is attached to a real production save request')
    nextPutResponse = null
    await resizeThroughRealSash(7)
    assert.equal(host.querySelector('.tl-dock-layout-error[role="alert"]'), null,
      'a later successful production save clears the prior error')
})
