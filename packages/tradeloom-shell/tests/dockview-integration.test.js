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
  let viewportWidth = 980
  const resizeObservers = new Set()
  dom.window.HTMLElement.prototype.getBoundingClientRect = function () {
    if (this.classList?.contains('tl-dockview-host')) {
      return { x: 0, y: 0, left: 0, top: 0, right: viewportWidth, bottom: 650, width: viewportWidth, height: 650, toJSON() { return this } }
    }
    return originalRect.call(this)
  }
  class ResizeObserverShim {
    constructor(callback) { this.callback = callback; this.targets = new Set() }
    observe(target) {
      resizeObservers.add(this)
      this.targets.add(target)
      const rect = target.getBoundingClientRect()
      this.callback([{ target, contentRect: rect }], this)
    }
    unobserve(target) { this.targets.delete(target) }
    disconnect() { this.targets.clear(); resizeObservers.delete(this) }
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
  const workflow = config.scenes.find(scene => scene.id === 'agent-center')
  const workflowCopy = { ...structuredClone(workflow), id: 'workflow-copy', templateSceneId: workflow.id, label: '工作流副本' }
  delete workflowCopy.defaultBusinessRoute
  const legacyWorkflow = { ...structuredClone(workflowCopy), id: 'workflow-legacy', label: '旧工作流' }
  legacyWorkflow.panels = legacyWorkflow.panels.filter(panel => panel.id !== 'business-plan')
  const tabbedWorkflow = { ...structuredClone(workflowCopy), id: 'workflow-tabbed', label: '分标签工作流' }
  const tabbedMain = tabbedWorkflow.panels.find(panel => panel.id === 'business-main')
  tabbedMain.frontendTabs = [
    { id: 'plan', view: 'business', label: '原业务视图' },
    { id: 'drawing', view: 'workflow-canvas', label: '原画布视图' },
  ]
  const customWorkflow = { ...structuredClone(workflowCopy), id: 'workflow-custom', label: '自定义工作流' }
  customWorkflow.panels.find(panel => panel.id === 'business-main').path = '/products'
  config.scenes.push(workflowCopy, legacyWorkflow, tabbedWorkflow, customWorkflow)
  const sceneState = defaultSceneWorkbench(config)
  sceneState.activeSceneId = 'products'
  sceneState.businessPath = '/products'
  const dockLayouts = normalizeDockLayouts(config, { version: 2, scenes: {} }, sceneState.layouts)
  t.diagnostic(JSON.stringify({ sourceDockGrid: dockLayouts.scenes.products.dockview.grid }))
  const putBodies = []
  const validatorErrors = []
  const putValidations = []
  let nextPutResponse = null
  const workflowReads = []
  const savedWorkflow = { version: 1, id: 'saved-canvas', title: '已保存画布', description: '',
    source: 'manual', confirmed: true, nodes: [{ id: 'in', kind: 'input', title: '输入', instruction: '', position: { x: 40, y: 60 } }], edges: [] }
  const workflowDetailUrl = '/tradeloom/workflows?id=saved-canvas'
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
    if (url === '/tradeloom/workflows' || url === workflowDetailUrl) {
      workflowReads.push(url)
      return { ok: true, async json() { return url === workflowDetailUrl ? { workflow: savedWorkflow, run: null }
        : { workflows: [savedWorkflow], catalog: { agents: [], kinds: [] } } } }
    }
    throw new Error(`unexpected request: ${url}`)
  }
  const clientSource = await readFile(new URL('../client.scenes.js', import.meta.url), 'utf8')
  const dockviewSource = await readFile(new URL('../client.dockview.js', import.meta.url), 'utf8')
  const workflowSource = await readFile(new URL('../client.workflow.js', import.meta.url), 'utf8')
  const dockviewCss = await readFile(new URL('../vendor/dockview.css', import.meta.url), 'utf8')
  let clientRegistration
  let dockviewRegistration
  let workflowRegistration
  dom.window.__ModuleLoader__ = { load(value) {
    if (value.chunk === 'client.scenes.js') clientRegistration = value
    if (value.chunk === 'client.dockview.js') dockviewRegistration = value
    if (value.chunk === 'client.workflow.js') workflowRegistration = value
  } }
  const vmGlobals = {
    window: dom.window, document: dom.window.document, navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement, Element: dom.window.Element, Node: dom.window.Node, Document: dom.window.Document,
    PointerEvent: PointerEventShim,
    MutationObserver: dom.window.MutationObserver, ResizeObserver: ResizeObserverShim,
    URLSearchParams, fetch, requestAnimationFrame: frame, getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
    cancelAnimationFrame: id => dom.window.clearTimeout(id),
    setTimeout: dom.window.setTimeout.bind(dom.window), clearTimeout: dom.window.clearTimeout.bind(dom.window),
    setInterval: dom.window.setInterval.bind(dom.window), clearInterval: dom.window.clearInterval.bind(dom.window),
    queueMicrotask: callback => dom.window.queueMicrotask(callback),
  }
  runInNewContext(clientSource, { ...vmGlobals, React })
  runInNewContext(workflowSource, vmGlobals)
  dom.window.eval(dockviewSource)
  assert.equal(clientRegistration?.chunk, 'client.scenes.js')
  assert.equal(dockviewRegistration?.chunk, 'client.dockview.js')
  const dockviewModule = dockviewRegistration.factory(id => pinnedRequire(id))
  const sceneRequire = Object.assign(name => {
    if (name === 'react') return React
    if (name === 'react-dom') return pinnedRequire('react-dom')
    assert.fail(`unexpected client-scene dependency ${name}`)
  }, { async: async id => {
    if (id === './client.workflow.js') return workflowRegistration.factory(pinnedRequire)
    assert.equal(id, './client.dockview.js')
    return dockviewModule
  } })
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
    const sceneApp = exports => React.createElement(React.Fragment, null,
      React.createElement(exports.SceneTabs, { workbenchActive: true }),
      React.createElement(exports.SceneWorkbench, {
        SessionProvider: ({ children }) => children,
        renderSlot: () => React.createElement('div', { 'data-native-chat-instance': 'true' }, 'native chat fixture'),
      }))
    await act(async () => {
      root.render(sceneApp(sceneExports))
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

    const filesClose = host.querySelector('.tl-dock-scene.is-active [data-tab-panel-id="files"] .dv-default-tab-action')
    assert.ok(filesClose, 'the ordinary Dockview tab exposes a close control')
    await act(async () => {
      filesClose.click()
      await settle(20)
    })
    const top = api.toJSON().grid.root.data[0]
    assert.equal(top.type, 'leaf', 'the split collapses and the remaining group occupies the whole top row')
    assert.deepEqual(top.data.views, ['business-main'])
    await act(async () => { await settle(30) })
    assert.ok(putBodies.length > 0, 'closing a real panel reaches the client queueDockLayoutSave HTTP PUT path')
    const bodyOverHttp = JSON.parse(JSON.stringify(putBodies.at(-1)))
    const sentRecord = bodyOverHttp.scenes.products
    assert.deepEqual(sentRecord.closedPanelIds, ['files', 'assistant-center', 'assistant-delivery', 'assistant-user-profile', 'native-workspace'])
    assert.deepEqual(sentRecord.closedPanelPositions, { files: { direction: 'right', neighbors: ['business-main'] } })
    assert.deepEqual(normalizeDockLayouts(config, bodyOverHttp).scenes.products.closedPanelPositions, sentRecord.closedPanelPositions)
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
    assert.deepEqual(walkLeaves(api.toJSON().grid.root).map(leaf => leaf.views), walkLeaves(customApplied.grid.root).map(leaf => leaf.views))

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

    const workflowTab = host.querySelector('[data-scene-tab-id="agent-center"]')
    assert.ok(workflowTab, 'the workflow scene is available from the scene bar')
    await act(async () => { workflowTab.click(); await settle(80) })
    const workflowApi = sceneExports.getDockviewApi('agent-center')
    assert.ok(workflowApi)
    await act(async () => { workflowApi.layout(980, 650, true); await settle() })
    const recommendedGrid = JSON.parse(JSON.stringify(workflowApi.toJSON().grid))
    assert.deepEqual(walkLeaves(recommendedGrid.root).map(leaf => leaf.views), [
      ['business-main'], ['files'], ['preview'], ['native-chat'],
    ])
    assertSplitPercentages(recommendedGrid.root.data, [60, 40])
    assertSplitPercentages(recommendedGrid.root.data[1].data, [50, 50])
    const currentScene = () => host.querySelector('.tl-dock-scene.is-active')
    const workflowFrame = id => currentScene().querySelector(`iframe[data-tradeloom-panel-id="${id}"]`)
    const canvas = () => currentScene().querySelector('[data-workflow-canvas] .tl-wf [data-node-id="in"]')
    const originalCanvas = canvas()
    assert.ok(originalCanvas, 'the canonical Web workflow actually mounts its canvas')
    assert.deepEqual(workflowReads, ['/tradeloom/workflows', workflowDetailUrl], 'loading does not request a second refresh')
    assert.equal(workflowFrame('business-main'), null)
    assert.equal(workflowFrame('business-plan'), null)
    const restorePlanButton = () => [...host.querySelectorAll('.tl-layout-menu-popover button')]
      .find(button => button.textContent === '恢复业务计划')
    assert.ok(restorePlanButton())
    await act(async () => { restorePlanButton().click(); await settle(70) })
    assert.equal(workflowFrame('business-plan')?.getAttribute('src'), '/business/agent-center')
    assert.equal(canvas(), originalCanvas)
    assert.deepEqual(walkLeaves(workflowApi.toJSON().grid.root).map(leaf => leaf.views), [
      ['business-plan'], ['business-main'], ['files'], ['preview'], ['native-chat'],
    ])

    await act(async () => { workflowApi.getPanel('business-plan').api.close(); await settle(60) })
    assert.equal(workflowApi.getPanel('business-plan'), undefined)
    assert.equal(workflowFrame('business-plan'), null)
    assert.equal(canvas(), originalCanvas)
    const shellSource = await readFile(new URL('../client.js', import.meta.url), 'utf8')
    const origin = 'http://business.fixture'
    const proposalGuard = shellSource.slice(shellSource.indexOf('    function proposalRoute('), shellSource.indexOf('    function isSourceProposalCandidate('))
    const handoff = shellSource.slice(shellSource.indexOf('    function installProposalHandoff('), shellSource.indexOf('    function setTrustedBusinessOrigin('))
    const removeHandoff = runInNewContext(`${proposalGuard}${handoff}
      let removeProposalHandoff
      installProposalHandoff()
      removeProposalHandoff`, {
      window: dom.window, URL, URLSearchParams, trustedBusinessOrigin: origin,
      sourceAccountMode: false, sceneApi: sceneExports, setAgentCenterHref() {},
    })
    t.after(removeHandoff)
    const clickProposal = async href => {
      const anchor = currentScene().appendChild(dom.window.document.createElement('a'))
      anchor.href = href
      let intercepted = true
      anchor.addEventListener('click', event => { intercepted = false; event.preventDefault() })
      await act(async () => { anchor.click(); await settle(70) })
      anchor.remove()
      return intercepted
    }
    const taskRoute = '/business/workflow-tasks/demo#workflow-plan'
    assert.equal(await clickProposal('http://untrusted.fixture' + taskRoute), false)
    assert.equal(await clickProposal(origin + '/business/workflow-tasks/demo?unexpected=1#workflow-plan'), false)
    assert.equal(workflowApi.getPanel('business-plan'), undefined)
    assert.equal(await clickProposal(origin + taskRoute), true)
    assert.equal(workflowFrame('business-plan')?.getAttribute('src'), taskRoute)
    assert.equal(workflowApi.activePanel?.id, 'business-plan')
    assert.equal(canvas(), originalCanvas)
    await act(async () => { sceneExports.navigateBusiness('/agent-center'); await settle() })
    assert.equal(workflowApi.activePanel?.id, 'business-main')
    assert.equal(canvas(), originalCanvas)
    const refreshCanvas = currentScene().querySelector('[data-pane-action="refresh"][aria-label="刷新工作流画布"]')
    assert.ok(refreshCanvas)
    const readsBeforeRefresh = workflowReads.length
    savedWorkflow.nodes[0].title = '服务端已刷新'
    await act(async () => { refreshCanvas.click(); await settle() })
    assert.deepEqual(workflowReads.slice(readsBeforeRefresh), [workflowDetailUrl, '/tradeloom/workflows'])
    assert.equal(canvas(), originalCanvas)
    assert.match(canvas().textContent, /服务端已刷新/)
    const readsBeforeDraft = workflowReads.length
    await act(async () => { canvas().dispatchEvent(new dom.window.MouseEvent('dblclick', { bubbles: true })); await settle() })
    const draftInput = currentScene().querySelector('.tl-wf textarea')
    assert.ok(draftInput)
    const draftText = '保留编辑中的节点说明'
    await act(async () => {
      Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, 'value').set.call(draftInput, draftText)
      pinnedRequire('react-dom/test-utils').Simulate.change(draftInput)
      await settle()
    })
    await act(async () => { refreshCanvas.click(); await settle() })
    assert.equal(currentScene().querySelector('.tl-wf textarea'), draftInput)
    assert.equal(draftInput.value, draftText)
    const canvasButton = label => [...currentScene().querySelectorAll('.tl-wf button')].find(button => button.textContent === label)
    await act(async () => { canvasButton('应用到草稿').click(); await settle() })
    assert.ok(canvasButton('保存*'))
    assert.match(canvas().textContent, new RegExp(draftText))
    await act(async () => { refreshCanvas.click(); await settle() })
    assert.equal(canvas(), originalCanvas)
    assert.ok(canvasButton('保存*'))
    assert.match(canvas().textContent, new RegExp(draftText))
    assert.equal(workflowReads.length, readsBeforeDraft)
    await act(async () => { workflowApi.getPanel('business-plan').api.close(); await settle() })
    const beforeReset = putBodies.length
    const resetButton = [...host.querySelectorAll('.tl-layout-menu-popover button')]
      .find(button => button.textContent === '恢复默认预设')
    assert.ok(resetButton, 'the workflow scene offers its local recommendation')
    await act(async () => { resetButton.click(); await settle(80) })
    const resetGrid = JSON.parse(JSON.stringify(workflowApi.toJSON().grid))
    assert.deepEqual(walkLeaves(resetGrid.root), walkLeaves(recommendedGrid.root))
    assertSizesNear(resetGrid.root.data.map(row => row.size), recommendedGrid.root.data.map(row => row.size))
    assert.ok(putBodies.length > beforeReset, 'reset saves the workflow recommendation through the client')
    assert.equal(putBodies.at(-1).scenes['agent-center'].closedPanelIds.includes('business-plan'), true)
    assert.deepEqual(validatorErrors, [], 'the workflow recommendation is accepted on save')

    await act(async () => {
      restorePlanButton().click()
      const plan = workflowApi.getPanel('business-plan')
      const files = workflowApi.getPanel('files')
      files.api.moveTo({ group: plan.api.group, index: 0 })
      await settle(30)
    })
    const tabbedViews = walkLeaves(workflowApi.toJSON().grid.root).map(leaf => leaf.views)
    assert.ok(tabbedViews.some(views => views.join(',') === 'files,business-plan'))
    const workflowFilesClose = host.querySelector('.tl-dock-scene.is-active [data-tab-panel-id="files"] .dv-default-tab-action')
    assert.ok(workflowFilesClose)
    await act(async () => { workflowFilesClose.click(); await settle(60) })
    const persisted = normalizeDockLayouts(config, JSON.parse(JSON.stringify(putBodies.at(-1))))
    assert.deepEqual(persisted.scenes['agent-center'].closedPanelPositions.files, { direction: 'within', neighbors: ['business-plan'], index: 0 })
    dockLayouts.scenes['agent-center'] = persisted.scenes['agent-center']
    sceneState.activeSceneId = 'agent-center'
    await act(async () => {
      await sceneExports.retryLoadConfig()
      workflowApi.fromJSON(persisted.scenes['agent-center'].dockview)
      await settle(60)
    })
    const planTab = host.querySelector('.tl-dock-scene.is-active [data-tab-panel-id="business-plan"]')
    await act(async () => {
      planTab.dispatchEvent(new dom.window.MouseEvent('contextmenu', { bubbles: true, cancelable: true }))
      await settle()
    })
    const restoreFile = [...dom.window.document.querySelectorAll('.dv-context-menu [role="menuitem"]')]
      .find(item => item.textContent === '恢复面板：文件')
    assert.ok(restoreFile, 'right-clicking a Dockview tab offers closed panels from the current scene')
    await act(async () => { restoreFile.click(); await settle(60) })
    assert.deepEqual(walkLeaves(workflowApi.toJSON().grid.root).map(leaf => leaf.views), tabbedViews)
    assert.equal(putBodies.at(-1).scenes['agent-center'].closedPanelPositions, undefined)

    const floatFiles = host.querySelector('.tl-dock-scene.is-active [data-pane-action="float"][aria-label="悬浮文件"]')
    assert.ok(floatFiles)
    await act(async () => { floatFiles.click(); await settle(40) })
    const detachedClose = host.querySelector('.tl-dock-scene.is-active [data-tab-panel-id="files"] .dv-default-tab-action')
    assert.ok(detachedClose)
    await act(async () => { detachedClose.click(); await settle(30) })
    assert.equal(workflowApi.getPanel('files').api.location.type, 'floating')
    const returnFiles = host.querySelector('.tl-dock-scene.is-active [data-pane-action="float"][aria-label="收回文件"]')
    await act(async () => { returnFiles.click(); await settle(40) })
    await act(async () => {
      workflowApi.fromJSON(persisted.scenes['agent-center'].dockview)
      for (const panel of [...workflowApi.panels]) {
        if (panel.id !== 'business-main') panel.api.close()
      }
      await settle(40)
    })
    const lastClose = host.querySelector('.tl-dock-scene.is-active [data-tab-panel-id="business-main"] .dv-default-tab-action')
    await act(async () => { lastClose.click(); await settle(30) })
    assert.deepEqual(workflowApi.panels.map(panel => panel.id), ['business-main'])

    // Older records can still contain zero open panels, so the scene menu must remain usable.
    await act(async () => { workflowApi.getPanel('business-main').api.close(); await settle(40) })
    assert.deepEqual(workflowApi.panels, [])
    await act(async () => {
      workflowTab.dispatchEvent(new dom.window.MouseEvent('contextmenu', { bubbles: true, cancelable: true }))
      await settle()
    })
    const emptySceneRestore = [...host.querySelectorAll('.tl-scene-tab-menu [role="menuitem"]')]
      .find(item => item.textContent === '恢复面板：文件')
    assert.ok(emptySceneRestore)
    await act(async () => { emptySceneRestore.click(); await settle(60) })
    assert.deepEqual(workflowApi.panels.map(panel => panel.id), ['files'])
    assert.deepEqual(validatorErrors, [])

    const presetAction = async label => {
      const action = [...host.querySelectorAll('.tl-layout-menu-popover button')].find(button => button.textContent === label)
      assert.ok(action, label)
      await act(async () => { action.click(); await settle(70) })
    }
    const officeTab = host.querySelector('[data-scene-tab-id="products"]')
    await act(async () => { officeTab.click(); await settle(90) })
    await presetAction('保存当前为预设')
    const productPreset = structuredClone(putBodies.at(-1).scenes.products.preset)
    assert.ok(productPreset?.dockview)
    assert.equal(putBodies.at(-1).scenes['agent-center'].preset, undefined)
    await act(async () => { workflowTab.click(); await settle(70) })
    await act(async () => {
      viewportWidth = 500
      for (const observer of resizeObservers) {
        for (const target of observer.targets) {
          if (target.matches('.tl-dock-scene.is-active .tl-dockview-host')) {
            observer.callback([{ target, contentRect: target.getBoundingClientRect() }], observer)
          }
        }
      }
      await settle(90)
    })
    assert.ok(host.querySelector('.tl-dock-scene.is-active.is-narrow'))
    await presetAction('保存当前为预设')
    const workflowPreset = structuredClone(putBodies.at(-1).scenes['agent-center'].preset)
    assert.deepEqual(Object.keys(workflowPreset.dockview.panels), ['files'])
    assert.deepEqual(putBodies.at(-1).scenes.products.preset, productPreset)
    await presetAction('恢复默认预设')
    assert.ok(workflowApi.getPanel('business-main'))
    assert.equal(workflowApi.getPanel('business-plan'), undefined)
    assert.deepEqual(putBodies.at(-1).scenes['agent-center'].preset, workflowPreset)
    assert.equal(await clickProposal(origin + taskRoute), true)
    assert.equal(workflowApi.activePanel?.id, 'business-plan')
    assert.equal(workflowApi.getPanel('business-plan').api.isMaximized(), true)
    assert.equal(workflowFrame('business-plan')?.getAttribute('src'), taskRoute)
    await act(async () => { sceneExports.navigateBusiness('/agent-center'); await settle() })
    assert.equal(workflowApi.activePanel?.id, 'business-main')
    assert.equal(workflowApi.getPanel('business-main').api.isMaximized(), true)
    await presetAction('恢复默认预设')
    nextPutResponse = { ok: false, status: 400, async json() { return { error: 'invalid-dock-layout' } } }
    await presetAction('保存当前为预设')
    nextPutResponse = null
    assert.deepEqual(JSON.parse(JSON.stringify(sceneExports.getSnapshot().dockLayouts.scenes['agent-center'].preset)), workflowPreset)
    await presetAction('使用已保存预设')
    assert.deepEqual(workflowApi.panels.map(panel => panel.id), ['files'])
    await presetAction('恢复默认预设')

    const savedAfterDefault = normalizeDockLayouts(config, putBodies.at(-1))
    Object.assign(dockLayouts.scenes, savedAfterDefault.scenes)
    dockLayouts.scenes['workflow-copy'] = persisted.scenes['agent-center']
    const reloaded = clientRegistration.factory(sceneRequire)
    await act(async () => { root.render(sceneApp(reloaded)); await settle(110) })
    const reloadedWorkflow = reloaded.getDockviewApi('agent-center')
    assert.ok(reloadedWorkflow?.getPanel('business-main'))
    assert.equal(reloadedWorkflow.getPanel('business-plan'), undefined)
    assert.deepEqual(JSON.parse(JSON.stringify(reloaded.getSnapshot().dockLayouts.scenes.products.preset)), productPreset)
    await presetAction('使用已保存预设')
    assert.deepEqual(reloadedWorkflow.panels.map(panel => panel.id), ['files'])
    await act(async () => { reloaded.navigateScene('workflow-copy'); await settle(80) })
    assert.ok(canvas(), 'a copy inheriting both canonical seats keeps its canvas')
    assert.equal(workflowFrame('business-plan')?.getAttribute('src'), '/business/agent-center',
      'an existing saved layout with the separate plan open retains the business frame')
    await act(async () => { reloaded.navigateScene('workflow-legacy'); await settle(80) })
    assert.equal(canvas(), null)
    assert.equal(workflowFrame('business-main')?.getAttribute('src'), '/business/agent-center')
    await act(async () => { reloaded.navigateScene('workflow-tabbed'); await settle(80) })
    const drawingTab = currentScene().querySelector('[data-business-view-tabs] button[id$="-drawing-tab"]')
    assert.ok(drawingTab)
    assert.equal(workflowFrame('business-main')?.getAttribute('src'), '/business/agent-center')
    assert.equal(canvas(), null)
    await act(async () => { drawingTab.click(); await settle() })
    assert.ok(canvas())
    await act(async () => { reloaded.navigateScene('workflow-custom'); await settle(80) })
    assert.equal(canvas(), null)
    assert.equal(workflowFrame('business-main')?.getAttribute('src'), '/business/products')

    // Start on the real single-tab recommendation, then exercise the header drop targets.
    viewportWidth = 980
    await act(async () => { reloaded.navigateScene('products'); await settle(90) })
    await presetAction('恢复默认预设')
    const tabsApi = reloaded.getDockviewApi('products')
    assert.equal(tabsApi.dndCapabilities.pointer, true)
    assert.ok(tabsApi.groups.every(group => group.panels.length === 1))
    const tab = id => currentScene().querySelector(`.dv-tab[data-tab-panel-id="${id}"]`)
    const position = (element, left, top, width, height) => {
      element.getBoundingClientRect = () => ({ x: left, y: top, left, top, width, height,
        right: left + width, bottom: top + height, toJSON() { return this } })
      Object.defineProperties(element, {
        offsetWidth: { configurable: true, get: () => width },
        offsetHeight: { configurable: true, get: () => height },
      })
    }
    const dragTab = async (source, destination, from, to, preview) => {
      pointerId++
      dom.window.document.elementFromPoint = () => destination
      dom.window.document.elementsFromPoint = () => [destination]
      await act(async () => {
        source.dispatchEvent(dragPointer('pointerdown', ...from))
        dom.window.dispatchEvent(dragPointer('pointermove', ...to))
        dom.window.dispatchEvent(dragPointer('pointermove', to[0] + 1, to[1]))
        preview?.()
        dom.window.dispatchEvent(dragPointer('pointerup', to[0] + 1, to[1]))
        await settle(60)
      })
    }
    const mergedSeatId = tabsApi.getPanel('business-main').api.group.id
    const tabStrip = () => tab('business-main').closest('.dv-tabs-container')
    const tabsInSeat = () => tabsApi.getGroup(mergedSeatId).panels.map(panel => panel.id)
    position(tabStrip(), 480, 40, 440, 36)
    position(tab('business-main'), 480, 40, 140, 36)
    position(tab('files'), 160, 40, 120, 36)
    await dragTab(tab('files'), tab('business-main'), [200, 56], [607, 56], () => {
      assert.ok(currentScene().querySelector('.tl-dock-drop-intent[data-intent="merge"]'))
    })
    assert.deepEqual(tabsInSeat(), ['business-main', 'files'])
    assert.equal(tabsApi.groups.length, 3, 'merging the old one-tab panel removes its empty group')
    assert.equal(tabsApi.getPanel('files').api.isVisible, true)
    assert.equal(tabsApi.getPanel('business-main').api.isVisible, false)

    position(tabStrip(), 480, 40, 440, 36)
    position(tab('business-main'), 480, 40, 140, 36)
    position(tab('files'), 620, 40, 120, 36)
    const beforeReorder = geometrySignature(tabsApi.toJSON().grid)
    await dragTab(tab('files'), tab('business-main'), [680, 56], [490, 56])
    assert.deepEqual(tabsInSeat(), ['files', 'business-main'], 'same-header drag only reorders its tabs')
    assert.equal(tabsApi.groups.length, 3)
    assert.deepEqual(geometrySignature(tabsApi.toJSON().grid), beforeReorder)
    pointerId++
    await act(async () => {
      tab('business-main').dispatchEvent(dragPointer('pointerdown', 650, 56))
      tab('business-main').dispatchEvent(dragPointer('pointerup', 650, 56))
      await settle()
    })
    assert.equal(tabsApi.activePanel?.id, 'business-main')
    assert.equal(tab('business-main').getAttribute('aria-selected'), 'true')
    assert.ok(workflowFrame('business-main'), 'selecting the tab activates the business component')
    assert.equal(tabsApi.getPanel('business-main').api.isVisible, true)
    assert.equal(tabsApi.getPanel('files').api.isVisible, false)
    await presetAction('保存当前为预设')
    const tabsSaved = normalizeDockLayouts(config, putBodies.at(-1))
    const tabsPreset = tabsSaved.scenes.products.preset
    const findSeat = node => node.type === 'leaf'
      ? (node.data.id === mergedSeatId ? node.data : undefined)
      : node.data.map(findSeat).find(Boolean)
    const savedSeat = findSeat(tabsPreset.dockview.grid.root)
    assert.deepEqual(savedSeat.views, ['files', 'business-main'])
    assert.equal(savedSeat.activeView, 'business-main')
    assert.equal(tabsPreset.dockview.activeGroup, mergedSeatId)
    const current = tabsApi.toJSON()
    await presetAction('恢复默认预设')
    Object.assign(dockLayouts.scenes, normalizeDockLayouts(config, putBodies.at(-1)).scenes)
    const tabsReloaded = clientRegistration.factory(sceneRequire)
    await act(async () => { root.render(sceneApp(tabsReloaded)); await settle(120) })
    await act(async () => { tabsReloaded.navigateScene('products'); await settle(80) })
    const loadedApi = tabsReloaded.getDockviewApi('products')
    assert.ok(loadedApi.groups.every(group => group.panels.length === 1))
    await presetAction('使用已保存预设')
    const loaded = loadedApi.toJSON()
    assert.equal(loaded.activeGroup, current.activeGroup)
    assert.equal(findSeat(loaded.grid.root).activeView, 'business-main')
    assert.equal(loadedApi.activePanel?.id, 'business-main')
    assert.deepEqual(loadedApi.getGroup(mergedSeatId).panels.map(panel => panel.id), ['files', 'business-main'])

    const mergedGroup = loadedApi.getGroup(mergedSeatId)
    const splitTarget = mergedGroup.element.querySelector('.dv-content-container')
    position(mergedGroup.element, 480, 40, 440, 410)
    position(splitTarget, 480, 76, 440, 374)
    position(tab('files'), 480, 40, 140, 36)
    const popouts = loadedApi.getPopouts().length
    const originalOpen = dom.window.open
    let windowOpens = 0
    dom.window.open = () => { windowOpens++; return null }
    try {
      await dragTab(tab('files'), splitTarget, [510, 56], [910, 215], () => {
        assert.ok(currentScene().querySelector('.tl-dock-drop-intent[data-intent="split"]'))
      })
    } finally { dom.window.open = originalOpen }
    assert.deepEqual(mergedGroup.panels.map(panel => panel.id), ['business-main'])
    const separatedGroup = loadedApi.getPanel('files').api.group
    assert.notEqual(separatedGroup.id, mergedSeatId)
    assert.equal(separatedGroup.api.location.type, 'grid')
    assert.deepEqual(separatedGroup.panels.map(panel => panel.id), ['files'])
    assert.equal(loadedApi.getPopouts().length, popouts)
    assert.equal(windowOpens, 0)
    assert.equal(loadedApi.toJSON().floatingGroups?.length ?? 0, 0)

    assert.deepEqual(validatorErrors, [])
})
