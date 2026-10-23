import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import test from 'node:test'

const nodeRequire = createRequire(import.meta.url)
const runtimePaths = [
  process.env.TRADELOOM_REACT_LIBRARY,
  process.env.TRADELOOM_REACT_SERVER_LIBRARY,
  process.env.TRADELOOM_DOM_MODULE,
]

function groupsFromJSON(node, groups = []) {
  if (node.type === 'leaf') groups.push([...node.data.views])
  else for (const child of node.data) groupsFromJSON(child, groups)
  return groups
}

test('real Dockview pointer drop uses pointerup coordinates and never drops on cancel or stale targets', {
  skip: runtimePaths.some(path => !path),
}, async t => {
  const [reactPath, reactDomPath, domPath] = runtimePaths
  const React = nodeRequire(reactPath)
  const pinnedRequire = createRequire(reactDomPath)
  const { createRoot } = pinnedRequire('react-dom/client')
  const act = React.act ?? pinnedRequire('react-dom/test-utils').act
  const { JSDOM } = nodeRequire(domPath)
  const dom = new JSDOM('<!doctype html><html><body></body></html>', {
    url: 'http://desktop.local/', pretendToBeVisual: true, runScripts: 'outside-only',
  })
  const savedDescriptors = new Map()
  const installGlobal = (key, value) => {
    savedDescriptors.set(key, Object.getOwnPropertyDescriptor(globalThis, key))
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value })
  }
  class ResizeObserverShim {
    constructor(callback) { this.callback = callback; this.targets = new Set() }
    observe(target) {
      this.targets.add(target)
      this.callback([{ target, contentRect: target.getBoundingClientRect() }], this)
    }
    unobserve(target) { this.targets.delete(target) }
    disconnect() { this.targets.clear() }
  }
  const frame = callback => dom.window.setTimeout(() => callback(Date.now()), 0)
  class PointerEventShim extends dom.window.MouseEvent {
    constructor(type, init = {}) {
      super(type, init)
      Object.defineProperties(this, {
        pointerId: { value: init.pointerId ?? 0 },
        pointerType: { value: init.pointerType ?? 'mouse' },
      })
    }
  }
  dom.window.PointerEvent = PointerEventShim
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
  installGlobal('IS_REACT_ACT_ENVIRONMENT', true)

  const originalRect = dom.window.HTMLElement.prototype.getBoundingClientRect
  const originalDimensionDescriptors = new Map(['offsetWidth', 'clientWidth', 'offsetHeight', 'clientHeight']
    .map(key => [key, Object.getOwnPropertyDescriptor(dom.window.HTMLElement.prototype, key)]))
  const layoutDimension = (element, axis) => {
    if (element.classList?.contains('dnd-fixture-host') || element.classList?.contains('dv-dockview')) return axis === 'width' ? 1200 : 700
    if (element.classList?.contains('dv-content-container')) return axis === 'width' ? 600 : 656
    return 0
  }
  for (const [key, axis] of [['offsetWidth', 'width'], ['clientWidth', 'width'], ['offsetHeight', 'height'], ['clientHeight', 'height']]) {
    Object.defineProperty(dom.window.HTMLElement.prototype, key, { configurable: true, get() { return layoutDimension(this, axis) } })
  }
  dom.window.HTMLElement.prototype.getBoundingClientRect = function () {
    if (this.classList?.contains('dnd-fixture-host') || this.classList?.contains('dv-dockview')) {
      return { x: 0, y: 0, left: 0, top: 0, right: 1200, bottom: 700, width: 1200, height: 700, toJSON() { return this } }
    }
    if (this.classList?.contains('dv-content-container')) {
      const containers = [...dom.window.document.querySelectorAll('.dv-content-container')]
      const index = containers.indexOf(this)
      const left = index > 0 ? 600 : 0
      return { x: left, y: 44, left, top: 44, right: left + 600, bottom: 700, width: 600, height: 656, toJSON() { return this } }
    }
    return originalRect.call(this)
  }
  const originalElementFromPoint = dom.window.document.elementFromPoint
  const originalElementsFromPoint = dom.window.document.elementsFromPoint
  const hitTestPoints = []
  let forceRootEdgeHit = false
  const pointTarget = (x, y) => {
    hitTestPoints.push({ x, y })
    if (forceRootEdgeHit && x >= 1180 && x < 1200 && y >= 44 && y < 700) {
      return dom.window.document.querySelector('.dv-dockview')
    }
    if (x < 600 || x >= 1200 || y < 44 || y >= 700) return null
    return dom.window.document.querySelectorAll('.dv-content-container')[1] ?? null
  }
  dom.window.document.elementFromPoint = (x, y) => pointTarget(x, y)
  dom.window.document.elementsFromPoint = (x, y) => {
    const target = pointTarget(x, y)
    return target ? [target] : []
  }

  const dockviewSource = await readFile(new URL('../client.dockview.js', import.meta.url), 'utf8')
  let registration
  dom.window.__ModuleLoader__ = { load(value) { if (value.chunk === 'client.dockview.js') registration = value } }
  dom.window.ResizeObserver = ResizeObserverShim
  dom.window.eval(dockviewSource)
  assert.equal(registration?.chunk, 'client.dockview.js')
  const dockview = registration.factory(id => pinnedRequire(id))
  const settled = () => new Promise(resolve => setTimeout(resolve, 15))

  async function runDrag(kind) {
    const host = dom.window.document.createElement('div')
    host.className = 'dnd-fixture-host'
    dom.window.document.body.append(host)
    const root = createRoot(host)
    let api
    const overlays = []
    const willDrops = []
    let overlayListener
    let willDropListener
    await act(async () => {
      root.render(React.createElement(dockview.DockviewReact, {
        dndStrategy: 'pointer',
        dndEdges: false,
        components: { fixture: () => React.createElement('div', null, 'fixture panel') },
        onReady: event => {
          api = event.api
          overlayListener = api.onWillShowOverlay(event => overlays.push({ kind: event.kind, position: event.position, edge: event.edge }))
          willDropListener = api.onWillDrop(event => willDrops.push({ kind: event.kind, position: event.position, edge: event.edge }))
        },
      }))
      await settled()
    })
    assert.ok(api, 'real DockviewReact exposes its public API')
    await act(async () => {
      api.addPanel({ id: 'source', component: 'fixture', title: 'source' })
      api.addPanel({ id: 'target', component: 'fixture', title: 'target', position: { referencePanel: 'source', direction: 'right' } })
      api.layout(1200, 700, true)
      await settled()
    })
    const sourceTab = host.querySelector('.dv-tab[aria-label="source"]')
    assert.ok(sourceTab, 'the actual Dockview tab is rendered')
    const pointer = (type, x, y) => {
      return new dom.window.PointerEvent(type, {
        bubbles: true, cancelable: true, button: 0, buttons: type === 'pointerup' ? 0 : 1,
        clientX: x, clientY: y, pointerId: 41, pointerType: 'mouse',
      })
    }
    const before = JSON.parse(JSON.stringify(api.toJSON()))
    forceRootEdgeHit = kind === 'root-edge'
    await act(async () => {
      sourceTab.dispatchEvent(pointer('pointerdown', 120, 20))
      dom.window.dispatchEvent(pointer('pointermove', 900, 300))
      if (kind === 'multi') {
        assert.equal(host.querySelectorAll('.dv-content-container').length, 2)
        dom.window.dispatchEvent(pointer('pointermove', 901, 301))
        assert.ok(host.querySelector('.dv-drop-target'), `the multi-move sequence activates the real target overlay; hit tests=${JSON.stringify(hitTestPoints)}`)
      }
      if (kind === 'cancel') dom.window.dispatchEvent(pointer('pointercancel', 900, 300))
      else if (kind === 'outside') dom.window.dispatchEvent(pointer('pointerup', 1300, 300))
      else if (kind === 'root-edge') {
        dom.window.dispatchEvent(pointer('pointermove', 1190, 350))
        dom.window.dispatchEvent(pointer('pointerup', 1190, 350))
      } else if (kind === 'content-edge') {
        dom.window.dispatchEvent(pointer('pointermove', 1190, 350))
        assert.ok(overlays.some(event => event.kind === 'content' && event.position === 'right'),
          `same-scene content edge preview identifies the right split under the pointer; events=${JSON.stringify(overlays)} hits=${JSON.stringify(hitTestPoints.slice(-4))}`)
        dom.window.dispatchEvent(pointer('pointerup', 1190, 350))
      } else dom.window.dispatchEvent(pointer('pointerup', 900, 300))
      await settled()
    })
    const after = JSON.parse(JSON.stringify(api.toJSON()))
    assert.deepEqual(groupsFromJSON(before.grid.root), [['source'], ['target']])
    if (kind === 'fast' || kind === 'multi') {
      assert.deepEqual(groupsFromJSON(after.grid.root), [['target', 'source']], `${kind} pointer drag merges the source panel into the target group`)
    } else if (kind === 'content-edge') {
      assert.deepEqual(groupsFromJSON(after.grid.root), [['target'], ['source']],
        'the Dockview content-edge target creates the split shown by the preview')
    } else {
      assert.deepEqual(groupsFromJSON(after.grid.root), [['source'], ['target']], `${kind} does not drop a panel`)
    }
    if (kind === 'root-edge') {
      assert.equal(host.querySelector('.dv-drop-target-edge'), null,
        'the Dockview root perimeter target remains disabled while same-scene panel targets stay enabled')
    }
    if (kind === 'content-edge') {
      assert.ok(willDrops.some(event => event.kind === 'content' && event.position === 'right'),
        `the resolved final drop has the same position as the visible content preview; events=${JSON.stringify(willDrops)} previews=${JSON.stringify(overlays)}`)
    }
    assert.equal(host.querySelector('.dv-tab-ghost-drag'), null, 'drag ghost is cleaned up after the gesture')
    await act(async () => { root.unmount(); await settled() })
    overlayListener?.dispose?.()
    willDropListener?.dispose?.()
    assert.equal(host.childElementCount, 0, 'unmount disposes the Dockview tree and its listeners')
    host.remove()
  }

  t.after(async () => {
    dom.window.HTMLElement.prototype.getBoundingClientRect = originalRect
    for (const [key, descriptor] of originalDimensionDescriptors) {
      if (descriptor) Object.defineProperty(dom.window.HTMLElement.prototype, key, descriptor)
      else delete dom.window.HTMLElement.prototype[key]
    }
    if (originalElementFromPoint) dom.window.document.elementFromPoint = originalElementFromPoint
    else delete dom.window.document.elementFromPoint
    if (originalElementsFromPoint) dom.window.document.elementsFromPoint = originalElementsFromPoint
    else delete dom.window.document.elementsFromPoint
    for (const [key, descriptor] of savedDescriptors) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor)
      else delete globalThis[key]
    }
    dom.window.close()
  })

  await runDrag('multi')
  await runDrag('fast')
  await runDrag('cancel')
  await runDrag('outside')
  await runDrag('root-edge')
  await runDrag('content-edge')
})
