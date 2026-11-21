import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { runInNewContext } from 'node:vm'

const rendererPath = new URL('../stage5-source06/asar/renderer/source-shell/replica-ui/renderer.js', import.meta.url)
const bridgePath = new URL('../stage5-source06/asar/renderer/source-shell/replica-ui/business-bridge.js', import.meta.url)

function functionSource(source, signature, nextSignature) {
  const start = source.indexOf(signature)
  const end = source.indexOf(nextSignature, start)
  assert.ok(start >= 0 && end > start, `source includes ${signature} before ${nextSignature}`)
  return source.slice(start, end).trim()
}

function loadFunction(source, context = {}) {
  return runInNewContext(`(${source})`, context)
}

test('panel expansion slots follow current dock rectangles and keep multi-panel native view coverage', async () => {
  const renderer = await readFile(rendererPath, 'utf8')
  const bridge = await readFile(bridgePath, 'utf8')
  const gridRect = { left: 4, top: 119, width: 1891, height: 1033, right: 1895, bottom: 1152 }
  const grid = { offsetWidth: gridRect.width, offsetHeight: gridRect.height, getBoundingClientRect: () => gridRect }
  const make = (_tag, className) => ({ className, style: {} })
  const getComputedStyle = () => ({
    borderLeftWidth: '0px', borderRightWidth: '0px', borderTopWidth: '0px', borderBottomWidth: '0px',
    paddingLeft: '5px', paddingRight: '5px', paddingTop: '5px', paddingBottom: '5px',
  })
  const createSlot = loadFunction(functionSource(renderer,
    'function createPanelExpansionSlot(wrap) {', 'function restorePanelExpansionLayout'), { grid, make, getComputedStyle })
  const panels = [
    { id: 'workflow', rect: { left: 480.5, top: 124, width: 938, height: 509, right: 1418.5, bottom: 633 }, dataset: { col: '2', w: '2' }, getBoundingClientRect() { return this.rect } },
    { id: 'files', rect: { left: 1423.5, top: 124, width: 466.5, height: 509, right: 1890, bottom: 633 }, dataset: { col: '4', w: '1' }, getBoundingClientRect() { return this.rect } },
    { id: 'preview', rect: { left: 9, top: 638, width: 938, height: 509, right: 947, bottom: 1147 }, dataset: { col: '1', w: '1' }, getBoundingClientRect() { return this.rect } },
    { id: 'assistant', rect: { left: 952, top: 638, width: 938, height: 509, right: 1890, bottom: 1147 }, dataset: { col: '2', w: '3' }, getBoundingClientRect() { return this.rect } },
  ]
  const slots = panels.map(panel => createSlot(panel))
  const contentWidth = grid.offsetWidth - 10
  const contentHeight = grid.offsetHeight - 10
  const actualSlots = slots.map(slot => ({
    left: gridRect.left + 5 + Number.parseFloat(slot.style.left) / 100 * contentWidth,
    top: gridRect.top + 5 + Number.parseFloat(slot.style.top) / 100 * contentHeight,
    width: Number.parseFloat(slot.style.width) / 100 * contentWidth,
    height: Number.parseFloat(slot.style.height) / 100 * contentHeight,
  }))
  for (const [index, actual] of actualSlots.entries()) {
    for (const key of ['left', 'top', 'width', 'height']) {
      assert.ok(Math.abs(actual[key] - panels[index].rect[key]) < 0.01,
        `${panels[index].id} ${key} remains ${panels[index].rect[key]}px, got ${actual[key]}px`)
    }
  }
  assert.ok(slots.every(slot => slot.style.position === 'absolute' && slot.style.gridColumn === '1 / -1'),
    'each slot is positioned from its live rectangle rather than stale template grid lines')
  assert.ok(Math.abs(471 - actualSlots[2].width) > 400, 'legacy preview template width is about 471px, versus its measured 947px')
  assert.ok(Math.abs(1429 - actualSlots[3].width) > 400, 'legacy assistant template width is about 1429px, versus its measured 947px')

  const expansionCovers = loadFunction(functionSource(bridge,
    'function panelExpansionCovers(expandedRect, panelRect) {', 'function panelExpansionBlocksNativePane'))
  const blocksNativePane = loadFunction(functionSource(bridge,
    'function panelExpansionBlocksNativePane(expandedPanels, panel, panelRect) {', 'function sceneHasDraggingPanel'), {
    panelExpansionCovers: expansionCovers,
  })
  const makePanel = rect => ({ getBoundingClientRect: () => rect, classList: { contains: () => false } })
  const [workflow, files, preview, assistant] = panels.map(panel => makePanel(panel.rect))
  const workflowThenFilesThenPreview = [preview, files, workflow]
  assert.equal(blocksNativePane(workflowThenFilesThenPreview, assistant, panels[3].rect), true,
    'the native assistant view is hidden when any higher expanded column overlaps it, even if the topmost preview column does not')
  assert.equal(blocksNativePane([preview, files, workflow], preview, panels[2].rect), false,
    'the panel owning the topmost expansion keeps its own native content visible')
  assert.equal(blocksNativePane([workflow], assistant, panels[3].rect), true,
    'the workflow column alone also clips an overlapping native assistant pane')
  assert.equal(blocksNativePane([preview], assistant, panels[3].rect), false,
    'a disjoint preview column leaves the assistant visible')
})

test('panel collapse restores the exact pre-expansion style without remounting panel content', async () => {
  const renderer = await readFile(rendererPath, 'utf8')
  const restoreLayout = loadFunction(functionSource(renderer,
    'function restorePanelExpansionLayout(wrap, state) {', '/* ---- 面板展开/收起'))
  const attributes = new Map([['style', 'position:absolute;left:959px;width:947px'], ['data-panel-id', 'assistant']])
  const child = {}
  const wrap = {
    dataset: { splitTreeManaged: 'true' }, childNodes: [child],
    getAttribute: name => attributes.has(name) ? attributes.get(name) : null,
    setAttribute: (name, value) => attributes.set(name, String(value)),
    removeAttribute: name => attributes.delete(name),
  }
  const snapshot = { originalStyle: wrap.getAttribute('style'), originalManaged: wrap.dataset.splitTreeManaged }
  wrap.setAttribute('style', 'position:fixed;left:959px;width:947px;height:1113px')
  restoreLayout(wrap, snapshot)
  assert.equal(wrap.getAttribute('style'), snapshot.originalStyle)
  assert.equal(wrap.dataset.splitTreeManaged, 'true')
  assert.equal(wrap.childNodes[0], child, 'geometry restoration leaves the existing renderer and native view mounted')
})

test('scene dock owns managed panel slot swaps before the renderer applies template geometry', async () => {
  const renderer = await readFile(rendererPath, 'utf8')
  const interactionsPath = new URL('../stage5-source06/asar/renderer/source-shell/replica-ui/panel-interactions.js', import.meta.url)
  const interactions = await readFile(interactionsPath, 'utf8')
  const swapSource = functionSource(renderer, 'function swapGeom(a, b, drop) {', '/* ============================================================')
  const makePanel = (id, geometry) => ({ dataset: { panelId: id, ...geometry }, __meta: { ...geometry }, style: {} })
  const a = makePanel('workflow', { col: '2', row: '1', w: '2', h: '2' })
  const b = makePanel('preview', { col: '1', row: '3', w: '1', h: '2' })
  let fallbackApplications = 0
  let handled
  class TestCustomEvent {
    constructor(_type, init) { this.detail = init.detail; this.cancelable = init.cancelable; this.defaultPrevented = false }
    preventDefault() { if (this.cancelable) this.defaultPrevented = true }
  }
  const swap = loadFunction(swapSource, {
    window: { sourcePanelTabs: { slotPanel: panel => panel }, dispatchEvent(event) { handled = event; event.preventDefault() } },
    CustomEvent: TestCustomEvent,
    applyGeom() { fallbackApplications++ },
  })
  swap(a, b)
  assert.equal(fallbackApplications, 0, 'the scene dock applies managed split geometry without a template-grid intermediate frame')
  assert.equal(a.dataset.col, '1')
  assert.equal(b.dataset.col, '2')
  assert.equal(handled.defaultPrevented, true)
  assert.match(interactions, /positionTreePanels\(grid, tree\)/, 'managed splits synchronously position the swapped live rectangles')
  assert.match(interactions, /applyClosedPanelReflow\(grid, info, projection\.tree\)/, 'closed-panel projections hand their live geometry back synchronously')
  assert.match(interactions, /if \(geometryHandled\) event\.preventDefault\(\)/, 'the dock explicitly claims geometry ownership')

  const ordinaryA = makePanel('ordinary-a', { col: '1', row: '1', w: '1', h: '1' })
  const ordinaryB = makePanel('ordinary-b', { col: '2', row: '1', w: '1', h: '1' })
  const ordinarySwap = loadFunction(swapSource, {
    window: { sourcePanelTabs: { slotPanel: panel => panel }, dispatchEvent() {} },
    CustomEvent: TestCustomEvent,
    applyGeom() { fallbackApplications++ },
  })
  ordinarySwap(ordinaryA, ordinaryB)
  assert.equal(fallbackApplications, 2, 'ordinary template-grid panels retain their established swap behavior')
})

test('overview assistant defaults closed while saved trees and explicit reopen state take precedence', async () => {
  const scenePath = new URL('../stage5-source06/asar/renderer/source-shell/replica-ui/scenes-data.js', import.meta.url)
  const interactionsPath = new URL('../stage5-source06/asar/renderer/source-shell/replica-ui/panel-interactions.js', import.meta.url)
  const sceneData = await readFile(scenePath, 'utf8')
  const interactions = await readFile(interactionsPath, 'utf8')
  const scenes = { window: {} }
  runInNewContext(sceneData, scenes)
  const center = scenes.window.__SCENES__.scenes.find(scene => scene.id === 'center')
  assert.equal(center.panels.find(panel => panel.id === 'center-chat').closedByDefault, true)

  const info = {
    sceneId: 'center', columns: 4, rows: 4,
    panels: [{ dataset: { panelId: 'center-chat' }, __meta: center.panels.find(panel => panel.id === 'center-chat') }],
    geometry: center.panels.map(({ id, col, row, w, h }) => ({ id, col, row, w, h })),
  }
  const state = { closed: {}, tree: { version: 2, scenes: {} }, savedTree: undefined, validPreset: false }
  const grid = {}
  const context = {
    closedPanelStore: () => state.closed,
    defaultClosedPanelIds: loadFunction(functionSource(interactions,
      'function defaultClosedPanelIds(info) {', 'function closedPanelIdsFor(sceneKey)')),
    document: { getElementById: () => grid },
    sceneGridInfo: () => info,
    readSplitTrees: () => state.tree,
    savedTree: () => state.savedTree,
    validPresetGeometry: () => state.validPreset,
    persistClosedPanelStore: value => { state.persisted = structuredClone(value) },
  }
  const closedPanelIdsFor = loadFunction(functionSource(interactions,
    'function closedPanelIdsFor(sceneKey) {', 'function recordClosedPanel('), context)
  context.closedPanelIdsFor = closedPanelIdsFor
  assert.deepEqual(Array.from(closedPanelIdsFor('center')), ['center-chat'])

  state.savedTree = { tree: { kind: 'leaf', id: 'center-chat' } }
  assert.deepEqual(Array.from(closedPanelIdsFor('center')), [], 'a saved split tree keeps its chosen open panels')
  state.savedTree = undefined
  state.tree.scenes.center = { fromPreset: true, geometry: info.geometry }
  state.validPreset = true
  assert.deepEqual(Array.from(closedPanelIdsFor('center')), [], 'a valid saved preset overrides the new default')
  state.tree.scenes = {}
  state.validPreset = false
  state.closed.center = ['center-chat']
  assert.deepEqual(Array.from(closedPanelIdsFor('center')), ['center-chat'], 'explicit user close state remains authoritative')
  state.closed = {}

  const recordClosedPanel = loadFunction(functionSource(interactions,
    'function recordClosedPanel(sceneKey, panelId, closed) {', 'function applyClosedPanels(grid)'), context)
  recordClosedPanel('center', 'center-chat', false)
  assert.deepEqual(Array.from(state.closed.center), [], 'reopening the assistant persists an explicit open state')
  assert.deepEqual(JSON.parse(JSON.stringify(state.persisted)), { center: [] })

  const tree = loadFunction(functionSource(interactions,
    'function defaultSceneTree(info, visible) {', 'function activePanelSlots(info)'), {
    defaultClosedPanelIds: context.defaultClosedPanelIds,
  })
  const centerTree = tree(info, new Set(['overview', 'files', 'preview']))
  assert.equal(centerTree.axis, 'x')
  assert.equal(centerTree.ratio, .75, 'the overview business panel gets three quarters of the canvas')
  const workflow = scenes.window.__SCENES__.scenes.find(scene => scene.id === 'agent-center')
  const workflowInfo = {
    sceneId: 'agent-center',
    geometry: workflow.panels.map(({ id, col, row, w, h }) => ({ id, col, row, w, h })),
    panels: workflow.panels.filter(panel => panel.closedByDefault).map(panel => ({ dataset: { panelId: panel.id }, __meta: panel })),
  }
  const workflowTree = tree(workflowInfo, new Set(['workflow-main', 'files', 'preview', 'workflow-chat']))
  assert.equal(workflowTree.axis, 'y')
  assert.equal(workflowTree.ratio, .5)
  assert.equal(workflowTree.first.id, 'workflow-main')
  assert.equal(workflowTree.second.first.id, 'preview')
  assert.equal(workflowTree.second.second.first.id, 'workflow-chat')
})
