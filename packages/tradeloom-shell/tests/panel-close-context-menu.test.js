import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import vm from 'node:vm'
import { validateSceneConfig } from '../scene-layout.js'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const interactionsPath = join(repoRoot, 'apps/tradeloom-launcher/accepted-runtime/renderer/source-shell/replica-ui/panel-interactions.js')
const sourceDirectory = join(repoRoot, 'apps/tradeloom-launcher/stage5-source06/asar/renderer/source-shell/replica-ui')
const domModule = process.env.TRADELOOM_DOM_MODULE

const PANEL_TEMPLATE = (id, title) => `
  <section class="panel" data-panel-id="${id}" data-col="1" data-row="1" data-w="2" data-h="1">
    <div class="panel-header">
      <div class="panel-identity"><strong class="panel-title">${title}</strong></div>
      <div class="panel-controls"></div>
    </div>
    <div class="panel-content"></div>
  </section>`

async function loadHarness(scene, closedPanelIds = [], storage = {}, { dragPanels = false, componentTabs = Boolean(scene) } = {}) {
  const { JSDOM } = await import(pathToFileURL(domModule).href)
  const dom = new JSDOM(`<!doctype html><html><body>
    <div id="scenebar"><button class="tab active">工作总览</button></div>
    <div id="grid" style="--cols:4;--rows:4">
      ${scene ? scene.panels.map(panel => PANEL_TEMPLATE(panel.id, panel.title)).join('') : PANEL_TEMPLATE('overview', '总览') + PANEL_TEMPLATE('files', '文件')}
    </div>
  </body></html>`, { url: 'https://source-shell.test/', pretendToBeVisual: true })
  dom.window.businessBridge = {
    panelMenuCapabilities: () => ({ nativeConversation: true, independent: true }),
    openSceneRotation: () => undefined,
    openNativeMenu: async () => ({ ok: true }),
    requestPanelPlacement: async () => ({ ok: true }),
    requestRolePlacement: async () => ({ ok: true }),
  }
  for (const [key, value] of Object.entries(storage)) dom.window.localStorage.setItem(key, value)
  if (scene) {
    const grid = dom.window.document.getElementById('grid')
    const width = 1000, height = 600
    const bounds = (left, top, width, height) => ({ left, top, width, height, right: left + width, bottom: top + height })
    grid.getBoundingClientRect = () => bounds(0, 0, width, height)
    grid.style.columnGap = '0px'
    grid.style.rowGap = '0px'
    for (const [property, value] of Object.entries({ clientWidth: width, offsetWidth: width, clientHeight: height, offsetHeight: height })) {
      Object.defineProperty(grid, property, { value })
    }
    for (const [index, panel] of [...grid.querySelectorAll('.panel')].entries()) {
      const { col, row, w, h, closedByDefault } = scene.panels[index]
      Object.assign(panel.dataset, { sceneId: scene.id, col, row, w, h })
      panel.__meta = { sceneId: scene.id, closedByDefault }
      panel.__defaultLayoutGeometry = { id: panel.dataset.panelId, col, row, w, h }
      panel.getBoundingClientRect = () => {
        if (panel.classList.contains('pi-closed') || panel.classList.contains('pi-tab-inactive')) return bounds(0, 0, 0, 0)
        const sides = ['left', 'top', 'width', 'height']
        if (panel.classList.contains('pi-closed-reflow')) {
          return bounds(...sides.map(side => Number.parseFloat(panel.style.getPropertyValue(`--pi-reflow-${side}`))))
        }
        if (panel.dataset.splitTreeManaged === 'true') return bounds(...sides.map(side => Number.parseFloat(panel.style[side])))
        const [liveCol, liveRow, liveW, liveH] = ['col', 'row', 'w', 'h'].map(key => Number(panel.dataset[key]))
        return bounds((liveCol - 1) * width / scene.cols, (liveRow - 1) * height / scene.rows, liveW * width / scene.cols, liveH * height / scene.rows)
      }
    }
    if (closedPanelIds.length) dom.window.localStorage.setItem('uiClosedPanels:v1', JSON.stringify({ [scene.id]: closedPanelIds }))
  }
  const filename = scene ? join(sourceDirectory, 'panel-interactions.js') : interactionsPath
  const source = await readFile(filename, 'utf8')
  const sandbox = {
    window: dom.window,
    document: dom.window.document,
    CustomEvent: dom.window.CustomEvent,
    localStorage: dom.window.localStorage,
    Node: dom.window.Node,
    MutationObserver: dom.window.MutationObserver,
    ResizeObserver: dom.window.ResizeObserver,
    getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
    requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window),
    cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window),
    setTimeout: dom.window.setTimeout.bind(dom.window),
    clearTimeout: dom.window.clearTimeout.bind(dom.window),
  }
  const context = vm.createContext(sandbox)
  if (scene) {
    const rendererPath = join(sourceDirectory, 'renderer.js')
    const renderer = await readFile(rendererPath, 'utf8')
    const helper = renderer.indexOf('function createReplicaIcon(')
    const next = renderer.indexOf('function iconBtn(', helper)
    assert.ok(helper >= 0 && next > helper, 'the desktop renderer defines the shared icon helper before panel interactions load')
    vm.runInContext(renderer.slice(helper, next), context, { filename: rendererPath })
    if (dragPanels) {
      sandbox.CustomEvent = dom.window.CustomEvent
      const geometry = renderer.slice(renderer.indexOf('function applyGeom('), renderer.indexOf('function expandPanel('))
      const drag = renderer.slice(renderer.indexOf('function attachDrag('), renderer.indexOf('function clearScene('))
      vm.runInContext(`const grid = document.getElementById('grid')
        let activePanelDragCancel = null
        const panelExpandStates = []
        ${geometry}${drag}`, context, { filename: rendererPath })
      for (const panel of dom.window.document.querySelectorAll('#grid > .panel')) {
        context.attachDrag(panel, panel.querySelector('.panel-header'), dom.window.document.createElement('span'))
      }
    }
  }
  if (componentTabs) {
    const tabsPath = join(sourceDirectory, 'panel-tabs.js')
    vm.runInContext(await readFile(tabsPath, 'utf8'), context, { filename: tabsPath })
    const bridgePath = join(sourceDirectory, 'business-bridge.js')
    const bridge = await readFile(bridgePath, 'utf8')
    const nativeVisibility = bridge.slice(bridge.indexOf('  function nativePaneVisible('), bridge.indexOf('  function waitForRoleGeometryResponse('))
    vm.runInContext(`const state = { globalPanelOpen: false }
      const byId = id => document.getElementById(id)
      ${nativeVisibility}
      window.nativePaneVisibleForTest = nativePaneVisible`, context, { filename: bridgePath })
  }
  vm.runInContext(source, context, { filename })
  return dom
}

function resizeSceneRows(window, delta, finish = 'pointerup') {
  const handle = window.document.querySelector('.pi-resize-layer:not([hidden]) [data-resize-key="ty:r"]')
  assert.ok(handle, 'the regular scene divider remains available')
  const pointer = (target, type, clientY) => target.dispatchEvent(new window.MouseEvent(type, {
    bubbles: true, cancelable: true, button: 0, clientY,
  }))
  pointer(handle, 'pointerdown', 300)
  pointer(window, 'pointermove', 300 + delta)
  pointer(window, finish, 300 + delta)
}

function chooseSceneLayout(window, label) {
  const { document, MouseEvent } = window
  document.getElementById('scenebar').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }))
  const action = [...document.querySelectorAll('.pi-menu button')].find(button => button.textContent === label)
  assert.ok(action, label)
  action.click()
  return action
}

test('desktop panels close with the header × and restore through the scene context menu', async () => {
  const dom = await loadHarness()
  const { window } = dom
  const { document } = window
  try {
    const overview = document.querySelector('.panel[data-panel-id="overview"]')
    const files = document.querySelector('.panel[data-panel-id="files"]')
    assert.ok(overview && files, 'both scene panels mount')
    overview.__meta = { sceneId: 'scene-center' }
    files.__meta = { sceneId: 'scene-center' }

    assert.equal(document.querySelector('.pi-more'), null, 'the ⋯ overflow control is gone from every panel header')
    const closeButtons = [...document.querySelectorAll('.panel-controls > .pi-close')]
    assert.equal(closeButtons.length, 2, 'every panel header exposes exactly one × close control')
    assert.equal(closeButtons[0].textContent, '×')
    assert.equal(closeButtons[0].getAttribute('aria-label'), '关闭面板')

    closeButtons[0].click()
    assert.ok(overview.classList.contains('pi-closed'), 'clicking × hides the owning panel')
    assert.equal(files.classList.contains('pi-closed'), false, 'closing one panel leaves the others visible')
    const stored = JSON.parse(window.localStorage.getItem('uiClosedPanels:v1'))
    assert.deepEqual(Object.values(stored), [['overview']], 'the closed panel is persisted per scene')

    const contextEvent = new window.MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 40, clientY: 220 })
    document.getElementById('scenebar').dispatchEvent(contextEvent)
    const menu = document.querySelector('.pi-menu')
    assert.ok(menu, 'right-clicking the scene navigation bar opens the context menu')
    const restoreItem = [...menu.querySelectorAll('button')].find(item => item.textContent === '恢复面板：总览')
    assert.ok(restoreItem, 'the context menu lists the closed panel by title')
    restoreItem.click()
    assert.equal(overview.classList.contains('pi-closed'), false, 'the context-menu entry restores the panel')
    assert.deepEqual(Object.values(JSON.parse(window.localStorage.getItem('uiClosedPanels:v1') || '{}')), [],
      'restoring clears the persisted closed-panel entry')

    const blankEvent = new window.MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 30, clientY: 30 })
    document.getElementById('grid').dispatchEvent(blankEvent)
    assert.equal(document.querySelector('.pi-menu'), null, 'no context menu appears when the scene has nothing to restore')
  } finally {
    window.close()
  }
})

test('the exact desktop renderer closes and reflows all five configured scenes, then restores their original slots', async () => {
  const { scenes } = JSON.parse(await readFile(join(sourceDirectory, 'scenes.json'), 'utf8'))
  for (const scene of scenes) {
    const { window } = await loadHarness(scene)
    try {
      const { document, MouseEvent } = window
      const panels = [...document.querySelectorAll('#grid > .panel')]
      const main = panels[0], upperSide = panels[1]
      const close = panel => panel.querySelector('.pi-close').click()
      const geometry = panel => [panel.dataset.col, panel.dataset.row, panel.dataset.w, panel.dataset.h]
      const original = panels.map(geometry)
      if (scene.id === 'center') {
        const capabilities = window.businessBridge.panelMenuCapabilities
        window.businessBridge.panelMenuCapabilities = panel => panel === upperSide ? { placement: 'popped-out' } : capabilities(panel)
        close(upperSide)
        assert.equal(upperSide.classList.contains('pi-closed'), false)
        window.businessBridge.panelMenuCapabilities = capabilities
      }
      if (scene.id === 'center') resizeSceneRows(window, 24)
      const storedTree = window.localStorage.getItem('uiPanelSplitTree:v2')
      if (scene.id === 'center') assert.ok(JSON.parse(storedTree).scenes.center.tree.ratio > .5)
      close(upperSide)
      assert.ok(upperSide.classList.contains('pi-closed'), scene.id)
      assert.equal(main.style.getPropertyValue('--pi-reflow-width'), '1000px', scene.id)
      const originalHeight = Number.parseFloat(main.style.getPropertyValue('--pi-reflow-height'))
      const lower = panels[2]
      const originalLowerHeight = Number.parseFloat(lower.style.getPropertyValue('--pi-reflow-height'))
      assert.ok(originalHeight > 0 && originalLowerHeight > 0, scene.id)
      resizeSceneRows(window, 48)
      assert.ok(Number.parseFloat(main.style.getPropertyValue('--pi-reflow-height')) > originalHeight, scene.id)
      assert.ok(Number.parseFloat(lower.style.getPropertyValue('--pi-reflow-height')) < originalLowerHeight, scene.id)
      assert.equal(window.localStorage.getItem('uiPanelSplitTree:v2'), storedTree, scene.id)
      assert.deepEqual(panels.map(geometry), original, scene.id)
      document.getElementById('scenebar').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }))
      const restore = [...document.querySelectorAll('.pi-menu button')].find(button => button.textContent === `恢复面板：${scene.panels[1].title}`)
      assert.ok(restore, scene.id)
      restore.click()
      assert.equal(upperSide.classList.contains('pi-closed'), false, scene.id)
      assert.ok(panels.every(panel => !panel.classList.contains('pi-closed-reflow')), scene.id)
      assert.deepEqual(panels.map(geometry), original, scene.id)
      assert.equal(window.localStorage.getItem('uiPanelSplitTree:v2'), storedTree, scene.id)
      for (const panel of panels.slice(1)) close(panel)
      close(main)
      assert.equal(main.classList.contains('pi-closed'), false, scene.id)
      assert.equal(main.style.getPropertyValue('--pi-reflow-height'), '600px', scene.id)
    } finally { window.close() }
  }
  const scene = scenes[0]
  const { window } = await loadHarness(scene, [scene.panels[1].id])
  try {
    const [main, side] = window.document.querySelectorAll('#grid > .panel')
    assert.ok(side.classList.contains('pi-closed'))
    assert.equal(main.style.getPropertyValue('--pi-reflow-width'), '1000px')
  } finally { window.close() }
})

test('desktop custom scenes with no full split line reflow in reading order and restore the saved grid', async () => {
  const config = JSON.parse(await readFile(new URL('../scenes.json', import.meta.url), 'utf8'))
  const scene = structuredClone(config.scenes.find(item => item.id === 'center'))
  scene.templateSceneId = scene.id
  scene.id = 'center-custom'
  delete scene.defaultBusinessRoute
  const geometry = [{ col: 1, row: 1, w: 3, h: 1 }, { col: 4, row: 1, w: 1, h: 3 },
    { col: 2, row: 4, w: 3, h: 1 }, { col: 1, row: 2, w: 1, h: 3 }]
  scene.panels = scene.panels.filter(panel => !panel.optional).map((panel, index) => ({ ...panel, ...geometry[index] }))
  config.scenes.push(scene)
  assert.doesNotThrow(() => validateSceneConfig(config))

  const { window } = await loadHarness({ ...scene, ...config.grid })
  try {
    const { document, MouseEvent } = window
    const [top, right, bottom, left] = document.querySelectorAll('#grid > .panel')
    right.querySelector('.pi-close').click()
    assert.ok(right.classList.contains('pi-closed'))
    for (const [index, panel] of [top, left, bottom].entries()) {
      assert.equal(panel.style.getPropertyValue('--pi-reflow-top'), `${index * 200}px`)
      assert.equal(panel.style.getPropertyValue('--pi-reflow-width'), '1000px')
      assert.equal(panel.style.getPropertyValue('--pi-reflow-height'), '200px')
    }
    resizeSceneRows(window, 60, 'pointercancel')
    assert.equal(top.style.getPropertyValue('--pi-reflow-height'), '200px')
    resizeSceneRows(window, 60)
    assert.ok(Number.parseFloat(top.style.getPropertyValue('--pi-reflow-height')) > 200)
    assert.ok(Number.parseFloat(left.style.getPropertyValue('--pi-reflow-height')) < 200)
    assert.equal(window.localStorage.getItem('uiPanelSplitTree:v2'), null)
    document.getElementById('scenebar').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }))
    document.querySelector('.pi-menu button').click()
    assert.equal(right.classList.contains('pi-closed'), false)
    for (const [index, panel] of [top, right, bottom, left].entries()) {
      assert.equal(panel.classList.contains('pi-closed-reflow'), false)
      assert.deepEqual(Object.fromEntries(Object.keys(geometry[index]).map(key => [key, Number(panel.dataset[key])])), geometry[index])
    }
  } finally { window.close() }
})

test('desktop presets survive reopening, retain the resized visible layout, and remain scoped to their scenes', async () => {
  const { scenes: [center, products] } = JSON.parse(await readFile(join(sourceDirectory, 'scenes.json'), 'utf8'))
  const presetKey = 'uiSceneLayoutPresets:v1'
  const currentKey = 'uiPanelSplitTree:v2'
  const closedKey = 'uiClosedPanels:v1'
  const trackKey = 'uiGridTrackWeights:v1'
  const captureStorage = window => Object.fromEntries([presetKey, currentKey, closedKey, trackKey]
    .flatMap(key => window.localStorage.getItem(key) === null ? [] : [[key, window.localStorage.getItem(key)]]))
  const { window } = await loadHarness(center)
  let storage
  try {
    const [main, side] = window.document.querySelectorAll('#grid > .panel')
    resizeSceneRows(window, 24)
    side.querySelector('.pi-close').click()
    resizeSceneRows(window, 48)
    chooseSceneLayout(window, '保存当前为预设')
    const preset = JSON.parse(window.localStorage.getItem(presetKey))[center.id]
    assert.equal(preset.tree.ratio, .54)
    assert.equal(preset.projection.ratio, .62)
    chooseSceneLayout(window, '恢复默认预设')
    assert.equal(side.classList.contains('pi-closed'), false)
    assert.deepEqual(JSON.parse(window.localStorage.getItem(presetKey))[center.id], preset)
    chooseSceneLayout(window, '使用已保存预设')
    assert.equal(side.classList.contains('pi-closed'), true)
    assert.equal(main.style.getPropertyValue('--pi-reflow-height'), '372px')
    storage = captureStorage(window)
  } finally { window.close() }

  const reopened = (await loadHarness(center, [], storage)).window
  try {
    const [main, side] = reopened.document.querySelectorAll('#grid > .panel')
    assert.ok(side.classList.contains('pi-closed'))
    assert.equal(main.style.getPropertyValue('--pi-reflow-height'), '372px')
    const presets = JSON.parse(reopened.localStorage.getItem(presetKey))
    presets[center.id].geometry[0].col = 20
    reopened.localStorage.setItem(presetKey, JSON.stringify(presets))
    const current = captureStorage(reopened)
    chooseSceneLayout(reopened, '使用已保存预设')
    assert.deepEqual(captureStorage(reopened), current)
    assert.equal(main.style.getPropertyValue('--pi-reflow-height'), '372px')
    assert.match(reopened.document.querySelector('.pi-toast').textContent, /已保留当前布局/)
  } finally { reopened.close() }

  const other = (await loadHarness(products, [], storage)).window
  try {
    assert.equal(chooseSceneLayout(other, '使用已保存预设').disabled, true)
    chooseSceneLayout(other, '保存当前为预设')
    const presets = JSON.parse(other.localStorage.getItem(presetKey))
    assert.deepEqual(presets[center.id], JSON.parse(storage[presetKey])[center.id])
    assert.deepEqual(presets[products.id].closedPanelIds, [])
  } finally { other.close() }
})

test('desktop workflow defaults to four visible zones and keeps independently saved five-zone and legacy layouts', async () => {
  const context = { window: {} }
  vm.runInNewContext(await readFile(join(sourceDirectory, 'scenes-data.js'), 'utf8'), context)
  const scene = context.window.__SCENES__.scenes.find(item => item.id === 'agent-center')
  const closedKey = 'uiClosedPanels:v1', treeKey = 'uiPanelSplitTree:v2', presetKey = 'uiSceneLayoutPresets:v1'
  const panel = (window, id) => window.document.querySelector(`#grid > [data-panel-id="${id}"]`)
  const width = (window, id) => panel(window, id).style.getPropertyValue('--pi-reflow-width')
  const planClosed = window => panel(window, 'workflow-plan').classList.contains('pi-closed')
  const fresh = (await loadHarness(scene)).window
  let savedOpen, savedTree
  try {
    assert.equal(planClosed(fresh), true)
    assert.equal(width(fresh, 'workflow-main'), '750px')
    assert.equal(width(fresh, 'preview'), '500px')
    assert.equal(panel(fresh, 'workflow-main').style.getPropertyValue('--pi-reflow-height'), '360px')
    chooseSceneLayout(fresh, '恢复面板：业务计划')
    assert.equal(planClosed(fresh), false)
    assert.deepEqual(JSON.parse(fresh.localStorage.getItem(closedKey))[scene.id], [])
    savedOpen = fresh.localStorage.getItem(closedKey)
    resizeSceneRows(fresh, 24)
    savedTree = fresh.localStorage.getItem(treeKey)
    assert.ok(JSON.parse(savedTree).scenes[scene.id].geometry.some(panel => panel.id === 'workflow-plan'))
    chooseSceneLayout(fresh, '保存当前为预设')
    const preset = fresh.localStorage.getItem(presetKey)
    chooseSceneLayout(fresh, '恢复默认预设')
    assert.equal(planClosed(fresh), true)
    assert.equal(width(fresh, 'workflow-main'), '750px')
    assert.equal(fresh.localStorage.getItem(presetKey), preset)
    chooseSceneLayout(fresh, '使用已保存预设')
    assert.equal(planClosed(fresh), false)
  } finally { fresh.close() }
  for (const storage of [{ [closedKey]: savedOpen }, { [treeKey]: savedTree }]) {
    const reopened = (await loadHarness(scene, [], storage)).window
    try { assert.equal(planClosed(reopened), false) } finally { reopened.close() }
  }

  const leaf = id => ({ kind: 'leaf', id })
  const split = (axis, boundary, path, ratio, first, second) => ({ kind: 'split', axis, boundary, path, ratio, first, second })
  const tree = split('y', 3, 'r', .55, split('x', 3, 'r0', .63, leaf('workflow-main'), leaf('files')),
    split('x', 2, 'r1', .25, leaf('preview'), leaf('workflow-chat')))
  const topology = 'y3[x3[p:workflow-main|p:files]|x2[p:preview|p:workflow-chat]]'
  const geometry = [
    { id: 'workflow-main', col: 1, row: 1, w: 2, h: 2 }, { id: 'files', col: 3, row: 1, w: 2, h: 2 },
    { id: 'preview', col: 1, row: 3, w: 1, h: 2 }, { id: 'workflow-chat', col: 2, row: 3, w: 3, h: 2 },
  ]
  const legacy = JSON.stringify({ version: 2, scenes: { 'agent-center': { tree, topology, geometry } } })
  const old = (await loadHarness(scene, [], { [treeKey]: legacy })).window
  try {
    assert.equal(planClosed(old), true)
    assert.equal(width(old, 'workflow-main'), '630px')
    assert.equal(width(old, 'preview'), '250px')
    assert.equal(old.localStorage.getItem(treeKey), legacy)
  } finally { old.close() }
})

test('desktop presets retain snapped panel slots and split sizes with all panels open or one closed', async () => {
  const { scenes: [center, products] } = JSON.parse(await readFile(join(sourceDirectory, 'scenes.json'), 'utf8'))
  const presetKey = 'uiSceneLayoutPresets:v1'
  const capture = window => Object.fromEntries([...window.document.querySelectorAll('#grid > .panel')].map(panel => {
    const { left, top, width, height } = panel.getBoundingClientRect()
    return [panel.dataset.panelId, {
      slot: ['col', 'row', 'w', 'h'].map(key => Number(panel.dataset[key])),
      rect: [left, top, width, height], closed: panel.classList.contains('pi-closed'),
    }]
  }))
  const dragPanel = (window, panel, target) => {
    const header = panel.querySelector('.panel-header')
    const centerOf = node => {
      const { left, top, width, height } = node.getBoundingClientRect()
      return { clientX: left + width / 2, clientY: top + height / 2 }
    }
    for (const [type, point] of [['pointerdown', centerOf(panel)], ['pointermove', centerOf(target)], ['pointerup', centerOf(target)]]) {
      const event = new window.MouseEvent(type, { bubbles: true, cancelable: true, button: 0, ...point })
      Object.defineProperty(event, 'pointerId', { value: 1 })
      header.dispatchEvent(event)
    }
  }
  const { window } = await loadHarness(center, [], {}, { dragPanels: true })
  try {
    resizeSceneRows(window, 24)
    const [overview, files, preview, assistant] = window.document.querySelectorAll('#grid > .panel')
    files.querySelector('.pi-close').click()
    resizeSceneRows(window, 48)
    const before = capture(window)
    dragPanel(window, overview, preview)
    const crossRow = capture(window)
    assert.deepEqual(crossRow.overview, before.preview)
    assert.deepEqual(crossRow.preview, before.overview)
    assert.deepEqual(crossRow.files, before.files)
    assert.equal(crossRow.preview.rect[3], 372)
    dragPanel(window, overview, assistant)
    const snapped = capture(window)
    assert.deepEqual(snapped.overview, before['center-chat'])
    assert.deepEqual(snapped['center-chat'], before.preview)
    chooseSceneLayout(window, '保存当前为预设')
    const preset = JSON.parse(window.localStorage.getItem(presetKey))[center.id]
    assert.equal(preset.tree.ratio, .54)
    assert.equal(preset.projection.ratio, .62)
    assert.deepEqual(preset.closedPanelIds, ['files'])
    chooseSceneLayout(window, '恢复默认预设')
    assert.equal(capture(window).files.closed, false)
    assert.deepEqual(JSON.parse(window.localStorage.getItem(presetKey))[center.id], preset)
    const storage = Object.fromEntries(Object.entries(window.localStorage))
    const switched = await loadHarness(products, [], storage)
    const returned = await loadHarness(center, [], Object.fromEntries(Object.entries(switched.window.localStorage)))
    switched.window.close()
    try {
      chooseSceneLayout(returned.window, '使用已保存预设')
      assert.deepEqual(capture(returned.window), snapped)
    } finally { returned.window.close() }
  } finally { window.close() }

  const full = (await loadHarness(center, [], {}, { dragPanels: true })).window
  try {
    resizeSceneRows(full, 24)
    const [overview, , preview] = full.document.querySelectorAll('#grid > .panel')
    const before = capture(full)
    dragPanel(full, overview, preview)
    chooseSceneLayout(full, '保存当前为预设')
    const preset = JSON.parse(full.localStorage.getItem(presetKey))[center.id]
    assert.equal(preset.tree.ratio, .54)
    assert.equal(preset.tree.first.first.id, 'preview')
    assert.deepEqual(preset.closedPanelIds, [])
    await Promise.resolve()
    const snapped = capture(full)
    assert.deepEqual(snapped.overview, before.preview)
    assert.deepEqual(snapped.preview, before.overview)
    chooseSceneLayout(full, '恢复默认预设')
    chooseSceneLayout(full, '使用已保存预设')
    assert.deepEqual(capture(full), snapped)
  } finally { full.close() }
})

test('desktop component tabs merge, reorder, switch, split and survive preset reload', async () => {
  const { scenes: [scene] } = JSON.parse(await readFile(join(sourceDirectory, 'scenes.json'), 'utf8'))
  const { window } = await loadHarness(scene, [], {}, { componentTabs: true })
  const panels = window => Object.fromEntries([...window.document.querySelectorAll('#grid > .panel')]
    .map(panel => [panel.dataset.panelId, panel]))
  const tabs = panel => [...panel.querySelectorAll('[data-component-tab]')].map(button => button.dataset.componentTab)
  const selected = panel => panel.querySelector('[aria-selected="true"]')?.dataset.componentTab
  const { overview, files, preview } = panels(window)
  const iframe = overview.appendChild(window.document.createElement('iframe'))
  const guestAnchor = files.appendChild(window.document.createElement('div'))
  let popouts = 0
  window.open = () => { popouts++ }
  const pointer = (target, type, x, y) => {
    const event = new window.MouseEvent(type, { bubbles: true, cancelable: true, button: 0, clientX: x, clientY: y })
    Object.defineProperty(event, 'pointerId', { value: 41 })
    target.dispatchEvent(event)
  }
  const drag = (source, destination, x, y, finish = 'pointerup') => {
    source.closest('.pi-component-tabs').getBoundingClientRect = () => ({ top: 0, bottom: 30 })
    destination && (destination.getBoundingClientRect = destination.matches('button')
      ? () => ({ left: 50, width: 100 }) : destination.getBoundingClientRect)
    window.document.elementFromPoint = () => destination
    pointer(source, 'pointerdown', 60, 20)
    pointer(window, 'pointermove', x, y)
    const preview = window.document.querySelector('.pi-tab-split-preview')
    const highlight = preview ? { left: preview.style.left, width: preview.style.width }
      : destination?.closest('.panel')?.classList.contains('snap-target')
    pointer(window, finish, x, y)
    return highlight
  }
  try {
    const column = window.document.querySelector('[data-resize-key="tx:r0"]')
    assert.ok(column)
    pointer(column, 'pointerdown', 750, 130)
    pointer(window, 'pointermove', 830, 130)
    pointer(window, 'pointerup', 830, 130)
    assert.deepEqual(tabs(overview), ['overview'])
    assert.deepEqual(tabs(files), ['files'])
    assert.equal(drag(files.querySelector('button[role="tab"]'), overview.querySelector('button[role="tab"]'), 120, 20), true)
    assert.deepEqual(tabs(files), ['overview', 'files'])
    assert.equal(selected(files), 'files')
    assert.equal(overview.classList.contains('pi-tab-inactive'), true)
    assert.equal(files.getBoundingClientRect().width, 1000)
    assert.equal(window.nativePaneVisibleForTest(overview), false)
    assert.equal(window.nativePaneVisibleForTest(files), true)
    drag(files.querySelector('[data-component-tab="files"]'), files.querySelector('[data-component-tab="overview"]'), 70, 20)
    assert.deepEqual(tabs(files), ['files', 'overview'])
    files.querySelector('[data-component-tab="overview"]').click()
    assert.equal(selected(overview), 'overview')
    assert.equal(overview.getBoundingClientRect().width, 1000)
    assert.ok(files.classList.contains('pi-tab-inactive'))
    assert.equal(window.nativePaneVisibleForTest(overview), true)
    assert.equal(window.nativePaneVisibleForTest(files), false)
    const priorHeight = overview.getBoundingClientRect().height
    resizeSceneRows(window, 24)
    assert.ok(overview.getBoundingClientRect().height > priorHeight)
    assert.equal(overview.querySelector('iframe'), iframe)
    assert.equal(guestAnchor.parentElement, files)

    preview.querySelector('.pi-close').click()
    overview.querySelector('.pi-close').click()
    assert.equal(selected(files), 'files')
    window.document.getElementById('scenebar').dispatchEvent(new window.MouseEvent('contextmenu', { bubbles: true }))
    const restoreOverview = [...window.document.querySelectorAll('.pi-menu button')]
      .find(button => button.textContent === `恢复面板：${overview.querySelector('.panel-title').textContent}`)
    assert.ok(restoreOverview)
    restoreOverview.click()
    assert.equal(selected(overview), 'overview')

    const activeTab = () => overview.querySelector('[data-component-tab="files"]')
    const content = overview.querySelector('.panel-content')
    drag(activeTab(), null, 1200, 400)
    assert.equal(drag(activeTab(), content, 810, 24), false, 'a point in the nominal but not the resized slot is invalid')
    drag(activeTab(), content, 950, 80, 'pointercancel')
    assert.deepEqual(tabs(overview), ['files', 'overview'])
    assert.equal(selected(overview), 'overview')
    chooseSceneLayout(window, '保存当前为预设')
    const layoutState = JSON.parse(window.localStorage.getItem('uiSceneLayoutPresets:v1'))[scene.id]
    assert.deepEqual(layoutState.groups.find(group => group.slot === 'overview'), {
      slot: 'overview', tabs: ['files', 'overview'], active: 'overview',
    })
    assert.deepEqual(layoutState.closedPanelIds, ['preview'])
    const groupedRect = overview.getBoundingClientRect()
    chooseSceneLayout(window, '恢复默认预设')
    assert.deepEqual(tabs(overview), ['overview'])
    assert.equal(preview.classList.contains('pi-closed'), false)
    const reopened = (await loadHarness(scene, [], Object.fromEntries(Object.entries(window.localStorage)), { componentTabs: true })).window
    try {
      const current = panels(reopened)
      chooseSceneLayout(reopened, '使用已保存预设')
      assert.deepEqual(tabs(current.overview), ['files', 'overview'])
      assert.equal(selected(current.overview), 'overview')
      assert.equal(current.preview.classList.contains('pi-closed'), true)
      assert.equal(current.overview.getBoundingClientRect().width, groupedRect.width)
    } finally { reopened.close() }

    chooseSceneLayout(window, '使用已保存预设')
    const vacantGrid = window.document.getElementById('grid')
    assert.deepEqual(drag(activeTab(), vacantGrid, 950, 80), { left: '830px', width: '170px' })
    assert.deepEqual(tabs(overview), ['overview'])
    assert.deepEqual(tabs(files), ['files'])
    assert.equal(files.classList.contains('pi-tab-inactive'), false)
    assert.equal(files.getBoundingClientRect().left, 830)
    assert.equal(overview.querySelector('iframe'), iframe)
    assert.equal(guestAnchor.parentElement, files)
    assert.equal(popouts, 0)

    const owner = 'component-owner'
    const savedWithCustomOwner = JSON.parse(JSON.stringify(layoutState).replaceAll('"overview"', JSON.stringify(owner)))
    savedWithCustomOwner.groups = [
      { slot: owner, tabs: ['files', owner, 'center-chat'], active: 'center-chat' },
      { slot: 'preview', tabs: ['preview'], active: 'preview' },
    ]
    savedWithCustomOwner.projection = { kind: 'leaf', id: owner }
    const changed = { ...scene, panels: scene.panels.map(panel => panel.id === 'overview'
      ? { ...panel, id: 'component-added' } : panel) }
    const updated = (await loadHarness(changed, [], {
      'uiSceneLayoutPresets:v1': JSON.stringify({ [scene.id]: savedWithCustomOwner }),
    }, { componentTabs: true })).window
    try {
      chooseSceneLayout(updated, '使用已保存预设')
      const current = panels(updated)
      assert.deepEqual(tabs(current['center-chat']), ['files', 'center-chat'])
      assert.equal(selected(current['center-chat']), 'center-chat')
      assert.ok(current['component-added'].classList.contains('pi-closed'))
      assert.ok(current.preview.classList.contains('pi-closed'))
      const activeGroups = JSON.parse(updated.localStorage.getItem('uiScenePanelTabs:v1'))[scene.id]
      assert.deepEqual(activeGroups.find(group => group.tabs.includes('center-chat')), {
        slot: 'files', tabs: ['files', 'center-chat'], active: 'center-chat',
      })
      assert.deepEqual(activeGroups.find(group => group.slot === 'component-added'), {
        slot: 'component-added', tabs: ['component-added'], active: 'component-added',
      })
    } finally { updated.close() }
  } finally { window.close() }
})

test('the panel header context menu keeps the rotation, popout and native entries', async () => {
  const dom = await loadHarness()
  const { window } = dom
  const { document } = window
  try {
    const filesPanel = document.querySelector('.panel[data-panel-id="files"]')
    filesPanel.__meta = { sceneId: 'scene-center' }
    document.querySelector('.panel[data-panel-id="overview"]').__meta = { sceneId: 'scene-center' }
    document.querySelector('.panel[data-panel-id="overview"] .panel-controls > .pi-close').click()
    const header = document.querySelector('.panel[data-panel-id="files"] .panel-header')
    header.dispatchEvent(new window.MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 60, clientY: 60 }))
    const menu = document.querySelector('.pi-menu')
    assert.ok(menu, 'right-clicking a panel header opens its action menu')
    const labels = [...menu.querySelectorAll('button')].map(item => item.textContent)
    for (const label of ['独立窗口', '打开原生会话', '轮换此角色会话', '关闭面板']) {
      assert.ok(labels.includes(label), `panel context menu keeps ${label}`)
    }
    assert.ok(!labels.includes('应用') && !labels.includes('编辑'),
      'the native DSH application/edit entries stay out of ordinary panel menus')
    assert.ok(labels.some(label => label.startsWith('恢复面板：')), 'panel context menu also offers restore entries')

    filesPanel.classList.add('panel-native-chat')
    header.dispatchEvent(new window.MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 60, clientY: 60 }))
    const assistantMenu = document.querySelector('.pi-menu')
    const assistantLabels = [...assistantMenu.querySelectorAll('button')].map(item => item.textContent)
    assert.ok(!assistantLabels.includes('应用') && !assistantLabels.includes('编辑'),
      'the useless native application/edit entries are gone from assistant menus too')
  } finally {
    window.close()
  }
})
