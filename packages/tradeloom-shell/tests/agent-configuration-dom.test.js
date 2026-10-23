import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import test from 'node:test'
import { defaultSceneWorkbench } from '../scene-layout.js'
import { normalizeDockLayouts } from '../dock-layout.js'
import { publicRoleMetadata } from '../roles.js'

const nodeRequire = createRequire(import.meta.url)
const packageRoot = fileURLToPath(new URL('..', import.meta.url))

test('capability configuration uses real React and JSDOM for role editing, busy state, and safe save projection', async t => {
  const reactPath = process.env.TRADELOOM_REACT_LIBRARY
  const reactDomPath = process.env.TRADELOOM_REACT_SERVER_LIBRARY
  const domPath = process.env.TRADELOOM_DOM_MODULE
  if (!reactPath || !reactDomPath || !domPath) return t.skip('requires pinned React and external JSDOM paths')

  const { JSDOM } = nodeRequire(domPath)
  const React = nodeRequire(reactPath)
  const pinnedRequire = createRequire(reactDomPath)
  const { createRoot } = pinnedRequire('react-dom/client')
    const ReactDOM = pinnedRequire('react-dom')
  const testUtils = pinnedRequire('react-dom/test-utils')
  const act = React.act ?? testUtils.act
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    url: 'http://desktop.local/', pretendToBeVisual: true,
  })
  const previous = {
    window: globalThis.window, document: globalThis.document, navigator: globalThis.navigator,
    fetch: globalThis.fetch, actEnvironment: globalThis.IS_REACT_ACT_ENVIRONMENT,
  }
  globalThis.window = dom.window
  globalThis.document = dom.window.document
  Object.defineProperty(globalThis, 'navigator', { value: dom.window.navigator, configurable: true })
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  const visualViewport = new dom.window.EventTarget()
  Object.assign(visualViewport, { width: 0, height: 0, offsetLeft: 0, offsetTop: 0 })
  Object.defineProperty(dom.window, 'visualViewport', { configurable: true, value: visualViewport })

  let root
  let removeThemeListener
  try {
    const config = JSON.parse(await readFile(new URL('../scenes.json', import.meta.url), 'utf8'))
    const saved = defaultSceneWorkbench(config)
    const dockLayouts = normalizeDockLayouts(config, { version: 2, scenes: {} }, saved.layouts)
    const entrySource = await readFile(new URL('../client.js', import.meta.url), 'utf8')
    const chunkSource = await readFile(new URL('../client.scenes.js', import.meta.url), 'utf8')
    let entryRegistration
    let chunkRegistration
    let fetch
    dom.window.__ModuleLoader__ = { load(value) { entryRegistration = value } }
    runInNewContext(entrySource, { window: dom.window, document: dom.window.document, fetch: (...args) => fetch(...args) })
    dom.window.__ModuleLoader__ = { load(value) { chunkRegistration = value } }
    runInNewContext(chunkSource, { window: dom.window, document: dom.window.document, fetch: (...args) => fetch(...args) })

    let resolveSave
    const writes = []
    const capabilities = role => ({
      role, status: 'ready',
      tools: { status: 'available', items: [{ name: 'synthetic-tool-' + 'long-name-'.repeat(12) }] },
      skills: { status: 'available', items: [] },
      mcp: { status: 'not_configured', visibleTools: [] },
    })
    const configView = role => ({
      role, preset: `tradeloom-${role}`, revision: 'a'.repeat(64), editable: true,
      mcpServers: role === 'product' ? [{
        id: 'tradeloom-mcp-product', transport: 'streamable-http', serverName: 'product-server',
        url: 'http://127.0.0.1:3090/mcp',
        headers: { Authorization: { envName: 'SYNTHETIC_MCP_KEY', scheme: 'bearer', present: true } },
        toolCallTimeoutMs: 30000, failOnStartupError: false,
      }] : [],
      skill: { includeDefaultRoots: true, customSkillDirs: role === 'product' ? ['skills/nested'] : [] },
      deniedTools: [],
    })
    fetch = async (url, options = {}) => {
      if (url === '/tradeloom/scenes') return { ok: true, async json() { return { ...config, roles: publicRoleMetadata(), businessOrigin: 'http://desktop.local' } } }
      if (url === '/tradeloom/scene-layouts') return { ok: true, async json() { return saved } }
      if (url === '/tradeloom/dock-layouts') return { ok: true, async json() { return dockLayouts } }
      if (url.startsWith('/tradeloom/agent-capabilities?')) {
        const role = new URL(url, 'http://desktop.local').searchParams.get('role')
        return { ok: true, async json() { return capabilities(role) } }
      }
      if (url.startsWith('/tradeloom/agent-configuration?')) {
        const role = new URL(url, 'http://desktop.local').searchParams.get('role')
        if (options.method === 'PUT') {
          writes.push(JSON.parse(options.body))
          return await new Promise(resolve => { resolveSave = () => resolve({ ok: true, async json() {
            return { role, preset: `tradeloom-${role}`, revision: 'b'.repeat(64), appliedForNewAgents: true, currentSessionUnchanged: true }
          } }) })
        }
        return { ok: true, async json() { return configView(role) } }
      }
      if (url === '/tradeloom/session/new') return { ok: true, status: 201, async json() { return { role: 'product', sessionId: 'synthetic-new-session' } } }
      throw new Error(`unexpected synthetic request: ${url}`)
    }
    let topNavigation
    const slots = {
      inject(_name, callback) { callback() },
      register(spec, component) { if (spec.name === 'shell.top') topNavigation = component; return () => {} },
    }
    const clientRequire = name => {
      if (name === 'react') return React
      if (name === 'react-dom') return ReactDOM
      assert.fail(`unexpected client dependency: ${name}`)
    }
    clientRequire.async = async name => {
      assert.equal(name, './client.scenes.js')
      const sceneModule = chunkRegistration.factory(clientRequire)
      return sceneModule
    }
    const app = entryRegistration.factory(clientRequire)
    assert.equal(typeof app?.apply, 'function', `expected shell entry module, received ${entryRegistration.id}; app keys=${Object.keys(app ?? {}).join(',')}; registration keys=${Object.keys(entryRegistration ?? {}).join(',')}`)
    const ctx = {
      layout: { selectPanel() {} }, uiWorkspace: { openSession() {} }, sessions: { retain() {} },
      modelDirectories: {}, remote: { session: {} }, theme: { getTheme: () => ({ active: { colorScheme: 'light' } }) },
      on() {}, off() {}, effect() {}, slots,
    }
    await act(async () => { await app.apply(ctx) })
    assert.equal(typeof topNavigation, 'function', 'the actual shell registers the existing top slot')
    root = createRoot(dom.window.document.getElementById('root'))
    await act(async () => {
      root.render(React.createElement(topNavigation, { usePanelInfo: () => ({}) }))
      await new Promise(resolve => setImmediate(resolve))
    })

    const button = label => [...dom.window.document.querySelectorAll('button')].find(item => item.textContent.trim() === label)
    const choose = role => {
      const select = dom.window.document.querySelector('select[aria-label="选择要查看能力的助手"]')
      assert.ok(select)
      testUtils.Simulate.change(select, { target: { value: role } })
    }
    await act(async () => { dom.window.document.querySelector('summary[aria-label="选择助手"]').click() })
    const selector = dom.window.document.querySelector('summary[aria-label="选择助手"]')
    let selectorRect = { left: 370, top: 220, right: 400, bottom: 250, width: 30, height: 30 }
    selector.getBoundingClientRect = () => selectorRect
    Object.defineProperty(dom.window, 'innerWidth', { value: 400, configurable: true })
    Object.defineProperty(dom.window, 'innerHeight', { value: 300, configurable: true })
    await act(async () => { button('查看 MCP 与 Skill 能力').click() })
    let capabilityPanel = dom.window.document.querySelector('.tl-agent-capabilities')
    assert.ok(capabilityPanel)
    assert.equal(capabilityPanel.style.position, 'fixed')
    assert.equal(capabilityPanel.style.width, '384px', '400px viewport keeps 8px gutters on both sides')
    assert.equal(capabilityPanel.style.left, '8px', 'an anchor near the right edge cannot push the panel outside the viewport')
    assert.equal(capabilityPanel.style.top, '8px', 'a short viewport places the panel above the anchor when that side has more room')
    assert.equal(capabilityPanel.style.maxHeight, '204px', 'the panel scroll region is capped to the available space above the anchor')
    assert.equal(dom.window.document.activeElement.getAttribute('aria-label'), '关闭助手能力与配置', 'opening moves focus to a stable panel control')
    assert.equal(capabilityPanel.getAttribute('aria-labelledby'), 'tl-agent-capabilities-title')
    assert.equal(capabilityPanel.querySelector('.tl-agent-capabilities-header').contains(capabilityPanel.querySelector('button[aria-label="关闭助手能力与配置"]')), true)
    assert.equal(capabilityPanel.querySelector('.tl-agent-capabilities-body').style.minHeight, '0px')
    assert.match(capabilityPanel.className, /tl-shell-top is-light/, 'the portal reuses the existing light semantic theme scope')
    assert.match(dom.window.getComputedStyle(capabilityPanel).fontFamily, /Segoe UI/)
    assert.equal(dom.window.getComputedStyle(capabilityPanel.querySelector('button')).borderRadius, '5px', 'portal buttons retain the shared shell control styling')
    const longTool = capabilityPanel.querySelector('li')
    assert.match(longTool.textContent, /synthetic-tool/)
    assert.equal(dom.window.getComputedStyle(longTool).overflowWrap, 'anywhere', 'long capability names wrap within the panel')
    await act(async () => {
      Object.defineProperty(dom.window, 'innerWidth', { value: 520, configurable: true })
      Object.defineProperty(dom.window, 'innerHeight', { value: 823, configurable: true })
      selectorRect = { left: 450, top: 50, right: 490, bottom: 80, width: 40, height: 30 }
      dom.window.dispatchEvent(new dom.window.Event('resize'))
    })
    capabilityPanel = dom.window.document.querySelector('.tl-agent-capabilities')
    assert.equal(capabilityPanel.style.width, '504px')
    assert.equal(capabilityPanel.style.left, '8px')
    assert.equal(capabilityPanel.style.top, '88px')
    assert.equal(capabilityPanel.style.maxHeight, '680px')
    await act(async () => {
      Object.defineProperty(dom.window, 'innerWidth', { value: 1280, configurable: true })
      selectorRect = { left: 900, top: 100, right: 940, bottom: 130, width: 40, height: 30 }
      dom.window.dispatchEvent(new dom.window.Event('resize'))
    })
    capabilityPanel = dom.window.document.querySelector('.tl-agent-capabilities')
    assert.equal(capabilityPanel.style.width, '720px', 'desktop panel width remains bounded')
    assert.equal(capabilityPanel.style.left, '552px', 'desktop placement clamps to the right viewport gutter')
    await act(async () => {
      selectorRect = { left: 900, top: 200, right: 940, bottom: 230, width: 40, height: 30 }
      dom.window.dispatchEvent(new dom.window.Event('scroll'))
    })
    capabilityPanel = dom.window.document.querySelector('.tl-agent-capabilities')
    assert.equal(capabilityPanel.style.top, '238px', 'scrolling remeasures the anchor instead of leaving a stale position')
    await act(async () => {
      Object.assign(visualViewport, { width: 250, height: 200, offsetLeft: 50, offsetTop: 30 })
      selectorRect = { left: 260, top: 180, right: 300, bottom: 200, width: 40, height: 20 }
      visualViewport.dispatchEvent(new dom.window.Event('resize'))
    })
    capabilityPanel = dom.window.document.querySelector('.tl-agent-capabilities')
    assert.equal(capabilityPanel.style.width, '234px', 'a smaller visual viewport bounds the panel width')
    assert.equal(capabilityPanel.style.left, '58px', 'visual viewport offset is respected in fixed-position coordinates')
    assert.equal(capabilityPanel.style.top, '38px')
    assert.equal(capabilityPanel.style.maxHeight, '134px')
    await act(async () => {
      Object.assign(visualViewport, { width: 400, height: 300, offsetLeft: 0, offsetTop: 120 })
      selectorRect = { left: 80, top: 78, right: 110, bottom: 108, width: 30, height: 30 }
      visualViewport.dispatchEvent(new dom.window.Event('resize'))
    })
    capabilityPanel = dom.window.document.querySelector('.tl-agent-capabilities')
    assert.equal(capabilityPanel.style.maxHeight, '284px', 'a trigger outside the visual viewport cannot grow the overlay beyond its height')
    assert.equal(capabilityPanel.style.top, '128px')
    assert.ok(Number.parseFloat(capabilityPanel.style.top) + Number.parseFloat(capabilityPanel.style.maxHeight) <= 412,
      'the panel remains within the visual viewport bottom gutter even when the trigger scrolled out of view')
    await act(async () => {
      dom.window.document.activeElement.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    })
    assert.equal(dom.window.document.querySelector('.tl-agent-capabilities'), null, 'Escape closes the open non-modal panel')
    assert.equal(dom.window.document.activeElement, selector, 'closing returns focus to the still-mounted Agent selector')
    await act(async () => { selector.click() })
    await act(async () => { button('查看 MCP 与 Skill 能力').click() })
    await act(async () => { choose('product'); await new Promise(resolve => setImmediate(resolve)) })
    await act(async () => { button('已保存配置').click() })
    await act(async () => { await new Promise(resolve => setImmediate(resolve)) })

    const server = dom.window.document.querySelector('.tl-config-server')
    assert.ok(server, 'the MCP server is shown in the selected role editor')
    assert.equal(server.open, false, 'server details start collapsed to keep the panel compact')
    const envName = dom.window.document.querySelector('input[aria-label="环境变量名 1"]')
    assert.equal(envName.value, 'SYNTHETIC_MCP_KEY')
    assert.doesNotMatch(dom.window.document.body.textContent, /secret-value|resolved-value/i)
    const skillDirectories = dom.window.document.querySelector('textarea')
    assert.equal(skillDirectories.value, 'skills/nested')
    testUtils.Simulate.keyDown(skillDirectories, { key: 'x', bubbles: true })
    assert.ok(dom.window.document.querySelector('.tl-agent-capabilities'), 'ordinary editor keystrokes do not dismiss the panel')
    await act(async () => { choose('center'); await new Promise(resolve => setImmediate(resolve)) })
    assert.equal(dom.window.document.querySelector('textarea').value, '')
    await act(async () => { choose('product'); await new Promise(resolve => setImmediate(resolve)) })
    assert.equal(dom.window.document.querySelector('textarea').value, 'skills/nested', 'switching roles keeps each raw Skill draft in its own editor')
    const roleSkillDirectories = dom.window.document.querySelector('textarea')
    await act(async () => { testUtils.Simulate.change(roleSkillDirectories, { target: { value: 'skills/nested\nskills/synthetic' } }) })
    await act(async () => { const save = button('保存默认配置'); save.click(); save.click() })
    assert.equal(writes.length, 1, `saving submits exactly one configuration update; buttons=${[...dom.window.document.querySelectorAll('button')].map(item => `${item.textContent.trim()}:${item.disabled}`).join('|')}; status=${dom.window.document.body.textContent.slice(-160)}`)
    assert.equal(dom.window.document.querySelector('input[aria-label="环境变量名 1"]').disabled, true, 'inputs are locked during an in-flight write')
    assert.deepEqual(writes[0].skill.customSkillDirs, ['skills/nested', 'skills/synthetic'])
    assert.equal('present' in writes[0].mcpServers[0].headers.Authorization, false)
    assert.equal(writes[0].mcpServers[0].headers.Authorization.envName, 'SYNTHETIC_MCP_KEY')
    await act(async () => { resolveSave() })
    assert.match(dom.window.document.body.textContent, /已保存为新会话默认配置/)
  } finally {
    if (root) await act(async () => { root.unmount() })
    removeThemeListener?.()
    dom.window.close()
    if (previous.window === undefined) delete globalThis.window; else globalThis.window = previous.window
    if (previous.document === undefined) delete globalThis.document; else globalThis.document = previous.document
    if (previous.fetch === undefined) delete globalThis.fetch; else globalThis.fetch = previous.fetch
    if (previous.navigator === undefined) delete globalThis.navigator
    else Object.defineProperty(globalThis, 'navigator', { value: previous.navigator, configurable: true })
    if (previous.actEnvironment === undefined) delete globalThis.IS_REACT_ACT_ENVIRONMENT
    else globalThis.IS_REACT_ACT_ENVIRONMENT = previous.actEnvironment
  }
})
