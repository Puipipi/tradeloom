import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { runInNewContext } from 'node:vm'
import test from 'node:test'

const require = createRequire(import.meta.url)

test('plugin overview reads Result snapshots, preserves unknowns and native management, and dismisses without stale results', async t => {
  const reactPath = process.env.TRADELOOM_REACT_LIBRARY
  const serverPath = process.env.TRADELOOM_REACT_SERVER_LIBRARY
  const domPath = process.env.TRADELOOM_DOM_MODULE
  if (!reactPath || !serverPath || !domPath) return t.skip('requires pinned React and JSDOM paths')
  const React = require(reactPath)
  const runtimeRequire = createRequire(serverPath)
  const { createRoot } = runtimeRequire('react-dom/client')
  const ReactDOM = runtimeRequire('react-dom')
  const { JSDOM } = require(domPath)
  const dom = new JSDOM('<!doctype html><div id="frame"><div data-shell-top></div><main id="workspace"><div id="root"></div></main><aside id="workspace-prior-inert" inert="keep-me"></aside><div data-shell-bottom></div><div data-shell-overlay></div></div><button id="outside">outside</button>', { url: 'http://fixture.local/', pretendToBeVisual: true })
  const rect = (left, top, width, height) => ({ left, top, right: left + width, bottom: top + height, width, height, x: left, y: top, toJSON() { return this } })
  dom.window.document.getElementById('frame').getBoundingClientRect = () => rect(12, 20, 900, 700)
  dom.window.document.getElementById('workspace-prior-inert').setAttribute('inert', 'keep-me')
  dom.window.document.querySelector('[data-shell-top]').getBoundingClientRect = () => rect(12, 20, 900, 42)
  dom.window.document.querySelector('[data-shell-bottom]').getBoundingClientRect = () => rect(12, 700, 900, 20)
  dom.window.HTMLElement.prototype.getClientRects = () => [rect(0, 0, 10, 10)]
  dom.window.HTMLElement.prototype.showPopover = function () { this.setAttribute('data-test-top-layer-open', '') }
  dom.window.HTMLElement.prototype.hidePopover = function () { this.removeAttribute('data-test-top-layer-open') }
  const previous = { window: globalThis.window, document: globalThis.document, act: globalThis.IS_REACT_ACT_ENVIRONMENT }
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true })
  let root
  try {
    let registration, Top, capture = false, calls = 0, deferred
    let response = { ok: true, value: { entries: [
      { entryId: 'alpha', moduleName: '@fixture/alpha', enabled: true, fiberPhase: 'active', meta: { title: { zh: '中文插件', en: 'Alpha' }, description: { zh: '真实字段投影', en: 'Description' } } },
      { entryId: 'beta', moduleName: '@fixture/beta', enabled: false, fiberPhase: null },
      { entryId: 'gamma', moduleName: '@fixture/gamma', enabled: true, fiberPhase: 'future-phase' },
    ], agentPresets: [{ id: 'conditional', rows: [{ moduleName: '@fixture/conditional', enabled: 'conditional', fiberPhase: 'failed' }] }] } }
    const bridge = { ...React, useState: initial => capture ? [typeof initial === 'function' ? initial() : initial, () => {}] : React.useState(initial), useEffect: (...args) => capture ? undefined : React.useEffect(...args) }
    // The loader registration runs before any production component is rendered.
    dom.window.__ModuleLoader__ = { load(value) { registration = value } }
    runInNewContext(await readFile(new URL('../client.js', import.meta.url), 'utf8'), { window: dom.window, document: dom.window.document, URL, URLSearchParams })
    const scene = { register() {}, SceneTabs: () => null, getSnapshot: () => ({}), subscribe: () => () => {} }
    const clientRequire = Object.assign(name => name === 'react' ? bridge : name === 'react-dom' ? ReactDOM : {}, { async: async () => scene })
    const plugin = registration.factory(clientRequire)
    assert.ok(plugin.inject.includes('remote.pluginInventory') && plugin.inject.includes('locale'), 'Cordis access must be declared at its owning plugin boundary')
    const selected = []
    await plugin.apply({ slots: { inject: (_key, fn) => fn(), register: (spec, component) => { if (spec.name === 'shell.top') Top = component; return () => {} } },
      layout: { selectPanel: value => selected.push(value) }, uiWorkspace: {}, remote: { pluginInventory: { list() { calls++; return deferred ? new Promise(resolve => { deferred.resolve = resolve }) : Promise.resolve(response) } } },
      locale: { resolveText: value => typeof value === 'string' ? value : value.zh || value.en } })
    capture = true
    const top = Top({ usePanelInfo: () => ({}) })
    capture = false
    const Tools = top.props.children[1].props.children.at(-1).type
    root = createRoot(dom.window.document.getElementById('root'))
    await React.act(async () => root.render(React.createElement(Tools)))
    const button = name => [...dom.window.document.querySelectorAll('button')].find(node => node.getAttribute('aria-label') === name || node.textContent === name)
    const click = node => React.act(async () => node.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })))
    const panel = () => dom.window.document.querySelector('.tl-plugin-inventory-panel')
    const toolsMenu = () => dom.window.document.querySelector('#tl-shell-tools-menu')
    const open = async () => { await click(button('打开工具菜单')); await click(button('插件管理')) }
    const closeTopbarPopover = async () => {
      if (!dom.window.document.querySelector('[data-tl-topbar-popover-open]')) return
      await React.act(async () => dom.window.document.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
      assert.equal(dom.window.document.querySelector('[data-tl-topbar-popover-open]'), null, 'Escape closes the top-layer popup before modal backdrop checks')
    }
    assert.equal(calls, 0, 'opening the shell must not eagerly query plugin inventory')
    await click(button('打开工具菜单'))
    assert.equal(toolsMenu().getAttribute('popover'), 'manual', 'the tools menu uses the native top-layer popover')
    assert.equal(toolsMenu().hasAttribute('data-tl-topbar-popover-open'), true, 'the modal stack owns the open tools popover')
    await React.act(async () => dom.window.document.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
    assert.equal(toolsMenu(), null, 'Escape closes the tools popover')
    await open()
    assert.equal(panel().getAttribute('aria-modal'), 'true', 'plugin inventory is a workspace modal')
    assert.match(panel().querySelector('style[data-tradeloom-plugin-inventory-style]').textContent, /width:min\(calc\(560px \* var\(--tl-ui-scale,1\)\)/, 'the workspace plugin overview keeps the reference-width cap and scale adaptation')
    const mask = panel().closest('.tl-workspace-modal-backdrop')
    assert.equal(mask.parentElement, dom.window.document.body, 'the modal uses a real body portal')
    assert.deepEqual([mask.style.left, mask.style.top, mask.style.width, mask.style.height], ['12px', '62px', '900px', '638px'], 'mask bounds use measured workspace bounds between top and bottom rows')
    assert.equal(dom.window.document.getElementById('workspace').hasAttribute('inert'), true, 'covered workspace content is inert')
    assert.equal(dom.window.document.getElementById('workspace-prior-inert').hasAttribute('inert'), true, 'pre-existing inert state remains active')
    const dialogButtons = [...panel().querySelectorAll('button:not([disabled])')]
    dialogButtons.at(-1).focus()
    await React.act(async () => dialogButtons.at(-1).dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Tab', bubbles: true })))
    assert.equal(dom.window.document.activeElement, dialogButtons[0], 'Tab wraps within the modal')
    assert.equal(calls, 1)
    assert.equal(button('打开工具菜单').getAttribute('aria-controls'), panel().id)
    assert.equal(button('打开工具菜单').getAttribute('aria-expanded'), 'true')
    const description = panel().querySelector('details.tl-plugin-inventory-description')
    assert.equal(description.open, false, 'descriptions start compact without shrinking the selected font')
    await click(description.querySelector('summary'))
    assert.equal(description.open, true, 'the native keyboard-focusable summary can reveal the full description')
    assert.equal(description.querySelector('p').textContent, '真实字段投影')
    await click(description.querySelector('summary'))
    assert.equal(description.open, false, 'a second activation collapses the description')
    assert.match(panel().textContent, /中文插件.*版本未知.*真实字段投影.*已启用.*已加载/s)
    assert.match(panel().textContent, /@fixture\/beta.*已停用.*运行状态未观测/s)
    assert.equal(panel().querySelector('[data-phase="future-phase"]').textContent, '未知状态（future-phase）', 'an observed new enum value must not be relabeled as unobserved')
    assert.match(panel().textContent, /按条件启用.*加载失败/s)
    assert.doesNotMatch(panel().textContent, /已安装|已连接/)
    response = { ok: false, error: { code: 'unavailable', message: 'sensitive internal failure' } }
    await click(button('刷新清单'))
    assert.match(panel().textContent, /读取失败/)
    assert.doesNotMatch(panel().textContent, /当前配置没有|sensitive internal/)
    response = { ok: true, value: { entries: [] } }
    await click(button('刷新清单'))
    assert.match(panel().textContent, /当前配置没有插件条目/)
    await React.act(async () => dom.window.document.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
    assert.equal(panel(), null)
    assert.equal(dom.window.document.activeElement, button('打开工具菜单'))
    assert.equal(dom.window.document.getElementById('workspace').hasAttribute('inert'), false, 'closing restores workspace inert state')
    assert.equal(dom.window.document.getElementById('workspace-prior-inert').getAttribute('inert'), 'keep-me', 'closing restores the exact prior inert value')
    
    await open()
    
    await closeTopbarPopover()
    await click(button('关闭插件概览'))
    assert.equal(panel(), null, 'the explicit close control dismisses the modal')
    assert.equal(dom.window.document.activeElement, button('打开工具菜单'), 'X returns focus to the owning trigger')
    
    await open()
    
    await closeTopbarPopover()
    const reopenedMask = panel().closest('.tl-workspace-modal-backdrop')
    await React.act(async () => reopenedMask.dispatchEvent(new dom.window.MouseEvent('mousedown', { bubbles: true })))
    assert.equal(panel(), null, 'activating the workspace mask dismisses the modal')
    assert.equal(dom.window.document.activeElement, button('打开工具菜单'), 'mask dismissal returns focus to the owning trigger')
    
    await open(); 
    await closeTopbarPopover()
    await click(dom.window.document.getElementById('outside'))
    assert.ok(panel(), 'a click outside the workspace portal does not dismiss the modal')
    await click(button('关闭插件概览'))
    assert.equal(panel(), null)
    
    await open(); await click(button('打开工具菜单')); assert.equal(panel(), null, 'the owning menu trigger toggles the overview closed')
    
    await open(); await click(button('完整插件管理')); assert.equal(panel(), null); assert.equal(selected.at(-1), 'plugins')
    deferred = {}
    
    await open()
    
    assert.match(panel().textContent, /正在读取/)
    await click(button('关闭插件概览'))
    await React.act(async () => deferred.resolve({ ok: true, value: { entries: [] } }))
    assert.equal(panel(), null, 'late inventory reads cannot reopen a dismissed overview')
    const beforePopupChecks = calls
    
    await open()
    
    await click(button('显示会话用量'))
    
    assert.equal(dom.window.document.querySelector('.tl-session-usage-panel').getAttribute('popover'), 'manual')
    await click(panel().querySelector('header strong'))
    
    assert.equal(dom.window.document.querySelector('.tl-session-usage-panel'), null, 'a modal content click dismisses the top-layer popover')
    assert.ok(panel(), 'the modal remains open after the outside popup click')
    await click(button('显示会话用量'))
    const modalBackdrop = panel().closest('.tl-workspace-modal-backdrop')
    await React.act(async () => modalBackdrop.dispatchEvent(new dom.window.MouseEvent('mousedown', { bubbles: true, cancelable: true })))
    
    assert.equal(dom.window.document.querySelector('.tl-session-usage-panel'), null, 'mousedown on the modal backdrop dismisses the top-layer popover first')
    assert.ok(panel(), 'mousedown on the backdrop does not dismiss the workspace modal')
    assert.equal(dom.window.document.getElementById('workspace').hasAttribute('inert'), true, 'the modal keeps its workspace inert lock while the popup closes')
    await click(button('显示会话用量'))
    
    await click(button('刷新清单'))
    
    assert.equal(dom.window.document.querySelector('.tl-session-usage-panel'), null, 'the modal refresh action dismisses the popup')
    assert.equal(calls, beforePopupChecks + 1, 'the modal refresh action still runs')
    assert.ok(panel(), 'the modal refresh action leaves the modal mounted')
    await click(button('关闭插件概览'))
    
    assert.equal(panel(), null)
    assert.equal(dom.window.document.getElementById('workspace-prior-inert').getAttribute('inert'), 'keep-me', 'the last modal close restores the original inert value')
  } finally {
    if (root) await React.act(async () => root.unmount())
    dom.window.close()
    for (const [key, value] of Object.entries({ window: previous.window, document: previous.document, IS_REACT_ACT_ENVIRONMENT: previous.act })) {
      if (value === undefined) delete globalThis[key]; else globalThis[key] = value
    }
  }
})
