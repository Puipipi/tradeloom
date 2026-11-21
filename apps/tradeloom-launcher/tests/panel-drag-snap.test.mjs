import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { runInNewContext } from 'node:vm'

const sourceRoot = new URL('../stage5-source06/asar/renderer/source-shell/replica-ui/', import.meta.url)
const rendererPath = new URL('renderer.js', sourceRoot)
const adapterPath = new URL('replica-adapter.js', sourceRoot)
const interactionsPath = new URL('panel-interactions.js', sourceRoot)

function sourceBetween(source, start, end) {
  const from = source.indexOf(start)
  const to = source.indexOf(end, from)
  assert.ok(from >= 0 && to > from, `source includes ${start} before ${end}`)
  return source.slice(from, to).trim()
}

function loadFunction(source, context = {}) {
  return runInNewContext(`(${source})`, context)
}

test('panel drop selects a neighboring edge for insertion and the center for slot swap', async () => {
  const renderer = await readFile(rendererPath, 'utf8')
  const dragging = { classList: { contains: () => false } }
  const left = { classList: { contains: () => false }, getBoundingClientRect: () => ({ left: 110, top: 0, right: 210, bottom: 100, width: 100, height: 100 }) }
  const right = { classList: { contains: () => false }, getBoundingClientRect: () => ({ left: 212, top: 0, right: 312, bottom: 100, width: 100, height: 100 }) }
  const findSnapTarget = loadFunction(sourceBetween(renderer,
    'function findSnapTarget(x, y, self) {', 'function swapGeom('), {
    grid: { querySelectorAll: () => [dragging, left, right] },
  })

  const between = findSnapTarget(211, 50, dragging)
  assert.equal(between.panel, left)
  assert.equal(between.axis, 'x')
  assert.equal(between.side, 'after')
  assert.equal(between.insert, true)

  const center = findSnapTarget(160, 50, dragging)
  assert.equal(center.panel, left)
  assert.equal(center.insert, false)
})

test('split-tree insertion moves a leaf beside its target without losing panel identities', async () => {
  const interactions = await readFile(interactionsPath, 'utf8')
  const helpers = sourceBetween(interactions, 'function withoutTreeLeaf(node, id) {', 'function insertPanelSlot(event) {')
  const validator = sourceBetween(interactions, 'function validSplitTree(tree, panelIds) {', 'function saveSplitTree(')
  const { move, valid } = runInNewContext(`${validator}
  ${helpers}
  ({ valid: validSplitTree, move: (tree, sourceId, targetId, axis, side) => {
    const remainder = withoutTreeLeaf(tree, sourceId)
    return setTreePaths(insertTreeLeaf(remainder, targetId, sourceId, axis, side))
  } })`)
  const moved = move({
    kind: 'split', axis: 'x', boundary: 1, ratio: 0.5, path: 'r',
    first: { kind: 'leaf', id: 'overview' },
    second: { kind: 'leaf', id: 'assistant' },
  }, 'overview', 'assistant', 'y', 'before')

  assert.deepEqual(JSON.parse(JSON.stringify(moved)), {
    kind: 'split', axis: 'y', boundary: 0, ratio: 0.5, path: 'r',
    first: { kind: 'leaf', id: 'overview' },
    second: { kind: 'leaf', id: 'assistant' },
  })
  assert.equal(valid(moved, ['overview', 'assistant']), true)
})

test('native role drag is recognized without a DOM ghost and hides the guest until drop', async () => {
  const adapter = await readFile(adapterPath, 'utf8')
  const panel = { classList: { contains: name => name === 'dragging' }, closest: () => panel }
  const record = {
    panel, sceneId: 'scene', content: { isConnected: true, getBoundingClientRect: () => ({ width: 200, height: 100 }) },
  }
  const state = { dragPanel: panel, roleDragPanel: panel, disposed: false }
  const roleDragIsActive = loadFunction(sourceBetween(adapter,
    'function roleDragIsActive(record) {', 'function roleMotionIsActive(record) {'), { state })
  const movingPanel = loadFunction(sourceBetween(adapter,
    'function movingPanel() {', 'function clearDragTracking(event) {'), {
    state, findTarget: () => panel, document: { querySelector: () => null },
  })
  const roleSurfaceVisible = loadFunction(sourceBetween(adapter,
    'function roleSurfaceVisible(record) {', 'function syncRoleSurface(record) {'), {
    state, roleDragIsActive, currentSceneId: () => 'scene',
    getComputedStyle: () => ({ display: 'block' }), modalVisible: () => false, menuVisible: () => false,
  })

  assert.equal(movingPanel()?.dragging, true)
  assert.equal(roleDragIsActive(record), true)
  assert.equal(roleSurfaceVisible(record), false)
})
