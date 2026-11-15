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
    url: 'http://desktop.local/', pretendToBeVisual: true,
  })
  const originalRect = dom.window.HTMLElement.prototype.getBoundingClientRect
  const originalElementFromPoint = dom.window.document.elementFromPoint
  const originalElementsFromPoint = dom.window.document.elementsFromPoint
  dom.window.HTMLElement.prototype.getBoundingClientRect = function () {
    if (this.classList?.contains('tl-dockview-host')) {
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
  t.diagnostic(JSON.stringify({ sourceDockGrid: dockLayouts.scenes.products.dockview.grid }))
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
    URLSearchParams, fetch, requestAnimationFrame: frame,
    cancelAnimationFrame: id => dom.window.clearTimeout(id),
    setTimeout: dom.window.setTimeout.bind(dom.window), clearTimeout: dom.window.clearTimeout.bind(dom.window),
    queueMicrotask: callback => dom.window.queueMicrotask(callback),
  }
  runInNewContext(clientSource, { ...vmGlobals, React })
  dom.window.eval(dockviewSource)
  assert.equal(clientRegistration?.chunk, 'client.scenes.js')
  assert.equal(dockviewRegistration?.chunk, 'client.dockview.js')
  const dockviewModule = dockviewRegistration.factory(id => pinnedRequire(id))
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
  })
  let root
  const host = dom.window.document.getElementById('root')
  t.after(async () => {
    const cleanupErrors = []
    try {
      if (root) await act(async () => root.unmount())
    } catch (error) { cleanupErrors.push(error) }
    try { assert.equal(host.childElementCount, 0, 'unmount disposes the real Dockview React tree') }
    catch (error) { cleanupErrors.push(error) }
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
    if (originalElementFromPoint) dom.window.document.elementFromPoint = originalElementFromPoint
    else delete dom.window.document.elementFromPoint
    if (originalElementsFromPoint) dom.window.document.elementsFromPoint = originalElementsFromPoint
    else delete dom.window.document.elementsFromPoint
    dom.window.close()
    if (cleanupErrors.length === 1) throw cleanupErrors[0]
    if (cleanupErrors.length > 1) throw new AggregateError(cleanupErrors, 'Dockview integration cleanup failed')
  })

    root = createRoot(host)
    const App = () => React.createElement(React.Fragment, null,
      React.createElement(sceneExports.SceneTabs, { workbenchActive: true }),
      React.createElement(sceneExports.SceneWorkbench, {
        SessionProvider: ({ children }) => children,
        renderSlot: () => React.createElement('div', { 'data-native-chat-instance': 'true' }, 'native chat fixture'),
      }))
    await act(async () => {
      root.render(React.createElement(App))
      await settle(80)
    })
    const api = sceneExports.getDockviewApi('products')
    assert.ok(api, 'the real Dockview instance is registered by the production SceneWorkbench')
    assert.equal(api.dndCapabilities.pointer, true)
    assert.equal(putBodies.length, 0, 'initial mount does not write the layout')
    await act(async () => { api.layout(980, 650, true); await settle() })
    const activeScene = host.querySelector('.tl-dock-scene.is-active')
    assert.ok(activeScene, 'the product workbench is the active scene in the integration fixture')
    assert.equal(activeScene.classList.contains('is-narrow'), false,
      'the 980x650 collaboration fixture uses the wide workbench DnD mode')
    const recommendation = api.toJSON()
    t.diagnostic(JSON.stringify({ initialGrid: recommendation.grid }))
    assert.equal(recommendation.grid.orientation, 'VERTICAL')
    assertSplitPercentages(recommendation.grid.root.data, [60, 40])
    assertSplitPercentages(recommendation.grid.root.data[0].data, [75, 25])
    assertSplitPercentages(recommendation.grid.root.data[1].data, [40, 60])
    assert.deepEqual(walkLeaves(recommendation.grid.root).map(leaf => leaf.views), [
      ['business-main'], ['files'], ['preview'], ['native-chat'],
    ])
    const nativeChatRootBeforeDrop = activeScene.querySelector('[data-native-chat-instance="true"]')
    assert.ok(nativeChatRootBeforeDrop, 'the mounted native-chat panel has a live React content node before a center drop')
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
    const pointerHit = (x, y) => {
      pointerHits.push({ x, y })
      return x >= dropRect.left && x <= dropRect.right && y >= dropRect.top && y <= dropRect.bottom
      ? targetContent : null
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
    previewListener.dispose?.()
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
    await act(async () => {
      for (const callback of restoreStartFrames) callback(Date.now())
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

    const filesPanel = api.getPanel('files')
    assert.ok(filesPanel)
    await act(async () => {
      filesPanel.api.close()
      await settle(20)
    })
    await act(async () => { await settle(30) })
    assert.ok(putBodies.length > 0, 'closing a real panel reaches the client queueDockLayoutSave HTTP PUT path')
    const bodyOverHttp = JSON.parse(JSON.stringify(putBodies.at(-1)))
    const sentRecord = bodyOverHttp.scenes.products
    assert.deepEqual(sentRecord.closedPanelIds, ['files', 'assistant-center', 'assistant-delivery', 'assistant-user-profile', 'native-workspace'])
    assertSizesNear(sentRecord.dockview.grid.root.data.map(child => child.size), expectedCustomSizes, 2,
      'the actual HTTP save preserves the changed split, rather than merely preserving its ordering')
    const extraKeysAfterJson = [...new Set(Object.values(sentRecord.dockview.panels).flatMap(panel =>
      Object.keys(panel).filter(key => !['id', 'contentComponent', 'title', 'renderer', 'params'].includes(key))))].sort()
    assert.deepEqual(extraKeysAfterJson, [], 'undefined Dockview UI defaults disappear at the real JSON HTTP boundary; persisted fields match the strict schema')
    assert.deepEqual(validatorErrors, [], 'the production server layout validator accepts the HTTP payload')

    const closeActions = [...host.querySelectorAll('[data-pane-action="close"]')]
    assert.ok(closeActions.length >= 1, 'an open panel exposes a close action in the visible panel menu')
    const restoreActions = [...host.querySelectorAll('[data-pane-action="restore-files"]')]
    assert.ok(restoreActions.length >= 1, 'a closed panel exposes a restore action in the visible panel menu')
    await act(async () => { restoreActions[0].click(); await settle(90) })
    assert.ok(api.getPanel('files'), 'the visible restore action recreates the closed panel')
    assert.equal(Object.keys(api.toJSON().panels).filter(id => id === 'files').length, 1,
      'the visible restore action creates exactly one files panel')

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

    const beforeReopenPutCount = putBodies.length
    const layoutTrigger = host.querySelector('button[aria-label="工作区布局"]')
    assert.ok(layoutTrigger, 'the production scene exposes its layout menu after a panel is closed')
    await act(async () => { layoutTrigger.click(); await settle() })
    const reopenButton = [...host.querySelectorAll('button')].find(button => button.textContent === '恢复文件')
    assert.ok(reopenButton, 'the production layout menu lists the closed files panel for restoration')
    await act(async () => { reopenButton.click(); await settle(60) })
    const reopenedFiles = api.getPanel('files')
    assert.ok(reopenedFiles, 'the layout-menu restore recreates the closed files panel through the production path')
    assert.equal(Object.keys(api.toJSON().panels).filter(id => id === 'files').length, 1, 'restore creates exactly one files panel instance')
    assert.equal(api.activePanel?.id, 'files', 'the restored files panel becomes active')
    assert.ok(putBodies.length > beforeReopenPutCount, 'the restore reaches the production HTTP layout save queue')
    const reopenedRecord = JSON.parse(JSON.stringify(putBodies.at(-1))).scenes.products
    assert.equal(reopenedRecord.closedPanelIds.includes('files'), false, 'the saved closed-panel list is cleared after restoration')
    assert.deepEqual(validatorErrors, [], 'the restored layout passes the production validator')
    assert.equal(putValidations.at(-1), true)
})
