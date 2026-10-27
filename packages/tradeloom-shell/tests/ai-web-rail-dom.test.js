import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { runInNewContext } from 'node:vm'
import test from 'node:test'

const require = createRequire(import.meta.url)

test('direct website icons follow each native window revision, close/minimize events and legacy capability', async t => {
  const reactPath = process.env.TRADELOOM_REACT_LIBRARY
  const reactDomPath = process.env.TRADELOOM_REACT_SERVER_LIBRARY
  const domPath = process.env.TRADELOOM_DOM_MODULE
  if (!reactPath || !reactDomPath || !domPath) return t.skip('requires pinned React and external JSDOM paths')
  const React = require(reactPath)
  const { createRoot } = createRequire(reactDomPath)('react-dom/client')
  const { JSDOM } = require(domPath)
  const dom = new JSDOM('<!doctype html><div id="root"></div>', { url: 'http://desktop.local/', pretendToBeVisual: true })
  const previous = { window: globalThis.window, document: globalThis.document, act: globalThis.IS_REACT_ACT_ENVIRONMENT }
  globalThis.window = dom.window
  globalThis.document = dom.window.document
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  const source = await readFile(new URL('../client.scenes.js', import.meta.url), 'utf8')
  const calls = []
  const state = (provider, revision = 0, open = false, visible = open) => ({ provider, revision, available: true, open, visible,
    phase: open ? 'loading' : 'closed', error: null, persistentSession: true, origin: null })
  const current = { deepseek: state('deepseek'), doubao: state('doubao') }
  let listener, resolveInitial, resolveToggle, unsubscriptions = 0
  let deferToggle = false
  dom.window.dshDesktop = { aiWeb: {
    subscribe(fn) { calls.push(['subscribe']); listener = fn; return () => { unsubscriptions++ } },
    status(value) { calls.push(['status', value]); return value.provider === 'deepseek' && !resolveInitial
      ? new Promise(resolve => { resolveInitial = resolve }) : Promise.resolve(current[value.provider]) },
    toggle(value) {
      calls.push(['toggle', value])
      if (deferToggle) return new Promise(resolve => { resolveToggle = resolve })
      const old = current[value.provider]
      current[value.provider] = state(value.provider, old.revision + 1, !old.visible)
      return Promise.resolve(current[value.provider])
    },
  } }
  let registration
  dom.window.__ModuleLoader__ = { load(value) { registration = value } }
  runInNewContext(source, { window: dom.window, document: dom.window.document })
  const exports = registration.factory(() => React)
  let root = createRoot(dom.window.document.getElementById('root'))
  const button = provider => dom.window.document.querySelector(`[data-provider="${provider}"]`)
  const click = async node => React.act(async () => { node.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })); await Promise.resolve() })
  const emit = async next => React.act(async () => { listener(next); await Promise.resolve() })
  try {
    await React.act(async () => { root.render(React.createElement(exports.AIWebRail)) })
    assert.equal(calls[0][0], 'subscribe', 'subscribe before querying either native window')
    assert.equal(dom.window.document.querySelectorAll('.tl-ai-web-launch').length, 2)
    assert.equal(dom.window.document.querySelector('[popover],.tl-ai-web-menu-trigger,a'), null, 'no hidden manual menu or replacement browser flow')
    for (const provider of ['deepseek', 'doubao']) {
      assert.equal(button(provider).getAttribute('aria-pressed'), 'false')
      assert.match(button(provider).querySelector('img').src, /^data:image\//)
    }
    await click(button('deepseek'))
    assert.equal(button('deepseek').getAttribute('aria-pressed'), 'true', 'loading does not suppress real visible-window glow')
    assert.match(button('deepseek').title, /正在加载/)
    assert.equal(button('doubao').getAttribute('aria-pressed'), 'false')
    await React.act(async () => { resolveInitial(state('deepseek')); await Promise.resolve() })
    assert.equal(button('deepseek').getAttribute('aria-pressed'), 'true', 'late startup status cannot overwrite a newer toggle')
    await click(button('doubao'))
    assert.equal(button('doubao').getAttribute('aria-pressed'), 'true')
    await emit(state('deepseek', 2))
    assert.equal(button('deepseek').getAttribute('aria-pressed'), 'false', 'native X clears expansion/glow')
    assert.equal(button('doubao').getAttribute('aria-pressed'), 'true', 'site state does not leak to another site')
    await emit({ ...state('deepseek', 3, true), phase: 'error', error: 'page_process_stopped' })
    assert.equal(button('deepseek').getAttribute('aria-pressed'), 'true', 'error and actual visibility are separate facts')
    assert.match(button('deepseek').title, /加载失败/)
    await emit(state('deepseek', 4, true, false))
    assert.equal(button('deepseek').getAttribute('aria-pressed'), 'false', 'minimize/hide clears glow without pretending window was destroyed')
    await emit(state('deepseek', 3, true))
    assert.equal(button('deepseek').getAttribute('aria-pressed'), 'false', 'older revision is ignored')
    deferToggle = true
    await click(button('deepseek'))
    assert.equal(button('deepseek').getAttribute('aria-pressed'), 'false', 'a click intent never becomes optimistic visibility')
    await emit(state('deepseek', 5, true))
    await React.act(async () => { resolveToggle(state('deepseek', 4, true, false)); await Promise.resolve() })
    assert.equal(button('deepseek').getAttribute('aria-pressed'), 'true', 'late toggle response cannot overwrite newer native event')
    await emit(state('doubao', 2))
    assert.equal(button('doubao').getAttribute('aria-pressed'), 'false')
    for (const [, payload] of calls.filter(([name]) => name !== 'subscribe')) assert.ok(['deepseek', 'doubao'].includes(payload.provider))
    assert.doesNotMatch(dom.window.document.body.textContent, /选择文件交给网页|保存网页文字|模型目录|已登录/)
    await React.act(async () => { root.unmount() })
    assert.equal(unsubscriptions, 1)
    dom.window.dshDesktop = { aiWeb: {
      status: async () => ({ ...state('deepseek'), revision: undefined }),
      toggle: async () => ({ ...state('deepseek', 0, true), revision: undefined }),
    } }
    root = createRoot(dom.window.document.getElementById('root'))
    await React.act(async () => { root.render(React.createElement(exports.AIWebRail)) })
    assert.equal(button('deepseek').disabled, false)
    assert.equal(button('doubao').disabled, true, 'legacy desktop16 must not advertise unsupported Doubao')
    assert.match(button('doubao').title, /更新桌面版本/)
    await click(button('deepseek'))
    assert.equal(button('deepseek').getAttribute('aria-pressed'), 'true')
    await React.act(async () => { root.unmount() })
    delete dom.window.dshDesktop
    root = createRoot(dom.window.document.getElementById('root'))
    await React.act(async () => { root.render(React.createElement(exports.AIWebRail)) })
    assert.equal(button('deepseek').disabled, true)
    assert.equal(button('doubao').disabled, true)
    await React.act(async () => { root.unmount() })
    const entry = await readFile(new URL('../client.js', import.meta.url), 'utf8')
    assert.match(entry, /state\.AIWebRail \? h\(state\.AIWebRail\)/)
    assert.doesNotMatch(entry, /state\.ModelDirectoryRail \? h\(state\.ModelDirectoryRail\)/)
  } finally {
    dom.window.close()
    if (previous.window === undefined) delete globalThis.window; else globalThis.window = previous.window
    if (previous.document === undefined) delete globalThis.document; else globalThis.document = previous.document
    if (previous.act === undefined) delete globalThis.IS_REACT_ACT_ENVIRONMENT; else globalThis.IS_REACT_ACT_ENVIRONMENT = previous.act
  }
})
