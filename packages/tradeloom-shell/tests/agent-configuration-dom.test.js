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
  const dom = new JSDOM('<!doctype html><html><body><div id="frame"><div data-shell-top></div><main id="workspace"><div id="root"></div></main><aside id="workspace-prior-inert" inert></aside><div data-shell-bottom></div><div data-shell-overlay></div></div></body></html>', {
    url: 'http://desktop.local/', pretendToBeVisual: true,
  })
  dom.window.HTMLElement.prototype.showPopover = function () { this.setAttribute('data-test-top-layer-open', '') }
  dom.window.HTMLElement.prototype.hidePopover = function () { this.removeAttribute('data-test-top-layer-open') }
  const hostRect = (left, top, width, height) => ({ left, top, right: left + width, bottom: top + height, width, height, x: left, y: top, toJSON() { return this } })
  dom.window.document.getElementById('workspace-prior-inert').setAttribute('inert', 'original')
  dom.window.document.getElementById('frame').getBoundingClientRect = () => hostRect(0, 0, 1000, 800)
  dom.window.document.querySelector('[data-shell-top]').getBoundingClientRect = () => hostRect(0, 0, 1000, 60)
  dom.window.document.querySelector('[data-shell-bottom]').getBoundingClientRect = () => hostRect(0, 760, 1000, 40)
  dom.window.HTMLElement.prototype.getClientRects = () => [hostRect(0, 0, 10, 10)]
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
    const catalogListeners = new Set()
    let catalogSubscribeCalls = 0
    let catalogUnsubscribeCalls = 0
    const usageListeners = new Set()
    const usageListenersBySession = new Map()
    const pressureFaces = new Map()
    let lateScopeAvailable = false
    const createPressureFace = (sessionId, initialValue) => {
      let value = initialValue
      const listeners = new Set()
      const face = {
        getSnapshot() { return value },
        get subscriberCount() { return listeners.size },
        subscribe(listener) {
          listeners.add(listener)
          usageListeners.add(listener)
          const sessionListeners = usageListenersBySession.get(sessionId) ?? new Set()
          sessionListeners.add(listener)
          usageListenersBySession.set(sessionId, sessionListeners)
          return () => { listeners.delete(listener); usageListeners.delete(listener); sessionListeners.delete(listener) }
        },
        setValue(next) { value = next; for (const listener of [...listeners]) listener() },
      }
      pressureFaces.set(sessionId, face)
      return face
    }
    createPressureFace('dom-primary', { projectedTokens: 0, contextWindow: 128000 })
    const initialLateFace = createPressureFace('dom-not-listed', { projectedTokens: 100, contextWindow: 200 })
    let usageRetains = 0
    let usageCreates = 0
    let usageHistoryReads = 0
    let sessionCatalog = {
      phase: 'ready',
      ids: ['dom-primary', 'dom-subagent', 'dom-other'],
      byId: {
        'dom-primary': { id: 'dom-primary', displayTitle: '场景会话', title: '场景会话', updatedAt: 0, running: false, blank: false, retainedBy: {} },
        'dom-subagent': { id: 'dom-subagent', displayTitle: '子助手会话', title: '子助手会话', parentId: 'dom-primary', origin: 'subagent', updatedAt: 0, running: false, blank: false, retainedBy: {} },
        'dom-other': { id: 'dom-other', displayTitle: '其他会话', title: '其他会话', updatedAt: 0, running: false, blank: false, retainedBy: {} },
      },
      projectionsBySession: {
        'dom-subagent': { values: { contextPressure: { projectedTokens: 539000, contextWindow: 100000 } }, state: 'ready', error: null },
        'dom-other': { values: {}, state: 'ready', error: null },
      },
    }
    dom.window.__ModuleLoader__ = { load(value) { entryRegistration = value } }
    runInNewContext(entrySource, { window: dom.window, document: dom.window.document, fetch: (...args) => fetch(...args) })
    dom.window.__ModuleLoader__ = { load(value) { chunkRegistration = value } }
    runInNewContext(chunkSource, { window: dom.window, document: dom.window.document, fetch: (...args) => fetch(...args) })

    let resolveSave
    const writes = []
    let skillInvocation = { modelInvocable: true, userInvocable: false }
    const capabilities = role => ({
      role, status: 'ready',
      tools: { status: 'available', items: [{ name: 'synthetic-tool-' + 'long-name-'.repeat(12) }] },
      skills: { status: 'available', items: [{ name: 'synthetic-skill', description: 'A role-scoped capability summary.', source: 'runtime', invocation: skillInvocation }] },
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
      if (url === '/tradeloom/scenes') return { ok: true, async json() { return { ...config, roles: publicRoleMetadata(), businessOrigin: 'http://desktop.local', sessionBindings: { center: 'dom-primary', 'user-profile': 'dom-primary', product: 'dom-not-listed' } } } }
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
      layout: { selectPanel() {} }, uiWorkspace: { openSession() {} }, sessions: {
        list: {
          getSnapshot() { return sessionCatalog },
          subscribe(listener) { catalogSubscribeCalls++; catalogListeners.add(listener); return () => { catalogUnsubscribeCalls++; catalogListeners.delete(listener) } },
        },
        scope(sessionId) { return sessionId === 'dom-primary' || (sessionId === 'dom-not-listed' && lateScopeAvailable) ? { sessionId } : undefined },
        sessionOf(scoped) { return { projections: { faceOf(key) {
          assert.equal(key, 'contextPressure')
          return pressureFaces.get(scoped.sessionId)
        } } } },
        retain() { usageRetains++ }, create() { usageCreates++; return Promise.resolve('unexpected-created') },
        refreshProjections() { usageHistoryReads++; return Promise.resolve() }, search() { usageHistoryReads++; return Promise.resolve({ ok: true, items: [], hasMore: false }) },
      },
      modelDirectories: {}, remote: { session: {}, pluginInventory: { list: async () => ({ ok: true, value: { entries: [{ entryId: 'concurrency-fixture', moduleName: '@fixture/modal-concurrency', enabled: true, fiberPhase: 'active' }], agentPresets: [] } }) } }, theme: { getTheme: () => ({ active: { colorScheme: 'light' } }) },
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
    assert.equal(capabilityPanel.getAttribute('aria-modal'), 'true', 'capabilities are a workspace modal')
    const capabilityMask = capabilityPanel.closest('.tl-workspace-modal-backdrop')
    assert.equal(capabilityMask.parentElement, dom.window.document.body, 'capability modal uses the real body portal')
    assert.equal(capabilityMask.style.backdropFilter, 'blur(3px)', 'the workspace mask lightly blurs only the covered workspace')
    assert.deepEqual([capabilityMask.style.top, capabilityMask.style.height], ['60px', '700px'], 'capability mask follows measured workspace bounds')
    assert.equal(dom.window.document.getElementById('workspace').hasAttribute('inert'), true, 'covered workspace content is inert')
    assert.ok(capabilityPanel)
    assert.equal(capabilityPanel.style.position, 'relative', 'capabilities are placed within a workspace modal')
    assert.ok(capabilityPanel.style.width.includes('100%'), 'modal width is bounded by the available workspace')
    assert.ok(capabilityPanel.style.maxHeight.includes('100%'), 'modal height is bounded by the available workspace')
    assert.equal(dom.window.document.activeElement.getAttribute('aria-label'), '关闭助手能力与配置', 'opening moves focus to a stable panel control')
    assert.equal(capabilityPanel.getAttribute('aria-labelledby'), 'tl-agent-capabilities-title')
    assert.equal(capabilityPanel.querySelector('.tl-agent-capabilities-header').contains(capabilityPanel.querySelector('button[aria-label="关闭助手能力与配置"]')), true)
    assert.equal(capabilityPanel.querySelector('.tl-agent-capabilities-body').style.minHeight, '0px')
    assert.match(capabilityPanel.className, /tl-shell-top is-light/, 'the portal reuses the existing light semantic theme scope')
    assert.equal(dom.window.getComputedStyle(capabilityPanel).fontFamily, 'var(--tl-font-family)',
      'the panel consumes the shell typography token instead of a local font override')
    assert.match(dom.window.document.documentElement.style.getPropertyValue('--tl-font-family'), /Segoe UI/,
      'the shell publishes the concrete body face through its shared typography token')
    assert.equal(dom.window.getComputedStyle(capabilityPanel.querySelector('button')).borderRadius, 'var(--tl-corner-radius)', 'portal buttons use the density-aware shared shell radius token')
    assert.match(capabilityPanel.querySelector('.tl-agent-capabilities-header').textContent, /Skill 1 · 工具 1 · MCP 已返回 0/,
      'the fixed header preserves a returned zero MCP count')
    assert.ok(capabilityPanel.querySelector('.tl-agent-capabilities-header button[title="重新读取当前助手能力"]'),
      'refresh remains in the fixed header while the capability body scrolls')
    const skillCard = capabilityPanel.querySelector('.tl-capability-skill-card')
    assert.ok(skillCard, 'available Skills use compact selectable capability cards')
    assert.equal(skillCard.getAttribute('aria-pressed'), 'false')
    assert.match(skillCard.textContent, /synthetic-skill.*A role-scoped capability summary.*来源 · runtime.*模型调用 可用.*用户调用 不可用/s)
    const reloadSkill = async invocation => {
      skillInvocation = invocation
      await act(async () => {
        capabilityPanel.querySelector('button[title="重新读取当前助手能力"]').click()
        await new Promise(resolve => setImmediate(resolve))
      })
      return capabilityPanel.querySelector('.tl-capability-skill-card')
    }
    for (const invocation of [undefined, null, { modelInvocable: 'true', userInvocable: 0 }]) {
      const unknown = await reloadSkill(invocation)
      assert.match(unknown.textContent, /模型调用 未知.*用户调用 未知/s, 'missing or malformed availability is not an explicit denial')
      assert.equal(unknown.querySelectorAll('.is-available').length, 0, 'unknown permissions never gain available styling')
    }
    assert.match((await reloadSkill({ modelInvocable: false, userInvocable: true })).textContent, /模型调用 不可用.*用户调用 可用/s)
    await reloadSkill({ modelInvocable: true, userInvocable: false })
    await act(async () => { capabilityPanel.querySelector('.tl-capability-skill-card').click() })
    assert.equal(capabilityPanel.querySelector('.tl-capability-skill-card').getAttribute('aria-pressed'), 'true',
      'selecting a capability applies the accessible selected outline state')
    const agentStyle = dom.window.document.querySelector('style[data-tradeloom-agent-style]')?.textContent ?? ''
    const navigationStyle = dom.window.document.querySelector('style[data-tradeloom-nav-style]')?.textContent ?? ''
    const dockviewSource = await readFile(new URL('../vendor/dockview.css', import.meta.url), 'utf8')
    assert.match(dockviewSource, /\.dv-split-view-container \.dv-sash-container \.dv-sash\s*\{[^}]*z-index:\s*99/s,
      'the pinned Dockview splitter handle occupies z-index 99 within its view tree')
    assert.match(navigationStyle, /--tl-shell-overlay-z:\s*1100/, 'the shell defines one fixed-overlay layer above Dockview handles')
    assert.match(agentStyle, /\.tl-agent-capabilities\s*\{\s*z-index:\s*var\(--tl-shell-overlay-z,\s*1100\)/,
      'the body-portal capability dialog uses the shared shell overlay layer instead of sitting below the splitter')
    assert.equal(dom.window.document.documentElement.style.getPropertyValue('--tl-ui-scale'), '1',
      'the default interface density publishes the reference scale used by shell portals')
    assert.match(agentStyle, /\.tl-agent-directory button, \.tl-agent-capabilities button\s*\{[^}]*min-height:\s*var\(--tl-control-height\)[^}]*padding:\s*var\(--tl-space-2\) var\(--tl-space-3\)/s,
      'agent directory and capability actions scale their actual control boxes and padding')
    assert.match(agentStyle, /\.tl-agent-capabilities-header\s*\{[^}]*min-height:\s*calc\(42px \* var\(--tl-ui-scale, 1\)\)/s,
      'capability header geometry follows interface size')
    assert.match(agentStyle, /\.tl-agent-capabilities \.tl-capability-skill-card\s*\{[^}]*min-height:\s*calc\(84px \* var\(--tl-ui-scale,1\)\)[^}]*padding:\s*var\(--tl-space-2\) var\(--tl-space-3\)/s,
      'skill card dimensions and inner spacing follow interface size')
    assert.doesNotMatch(agentStyle, /font-size:\s*(?:9|10|11|12)px/,
      'capability details inherit body or compact typography instead of fixed tiny text')
    assert.match(navigationStyle, /\.tl-shell-tools-menu button\s*\{[^}]*min-height:\s*var\(--tl-control-height\)[^}]*padding:\s*var\(--tl-space-2\) var\(--tl-space-3\)/s,
      'tools menu buttons scale their clickable box and padding with interface size')
    assert.match(navigationStyle, /\.tl-mobile-link-panel button\s*\{[^}]*min-height:\s*var\(--tl-control-height\)[^}]*padding:\s*var\(--tl-space-2\) var\(--tl-space-3\)/s,
      'mobile-link controls use the same dynamic control geometry')
    await act(async () => { dom.window.document.querySelector('button[aria-label="打开工具菜单"]').click() })
    await act(async () => {
      const item = button('界面大小')
      item.addEventListener('click', () => item.remove(), { once: true })
      item.click()
    })
    const fontPanel = dom.window.document.querySelector('.tl-font-size-panel')
    assert.ok(fontPanel)
    assert.equal(fontPanel.getAttribute('popover'), 'manual', 'font size uses the native top-layer popover')
    assert.equal(fontPanel.hasAttribute('data-tl-topbar-popover-open'), true, 'the modal stack owns the open font-size popover')
    assert.match(fontPanel.style.width, /320px \* var\(--tl-ui-scale, 1\)/,
      'the interface-size popover width grows with the selected density')
    assert.equal(fontPanel.querySelector('input[type="range"]').value, '14')
    let motionPreferenceEvent
    const motionPreferenceListener = event => { motionPreferenceEvent = event.detail?.value }
    dom.window.addEventListener('tradeloom:workbench-motion-preference-change', motionPreferenceListener)
    await act(async () => { dom.window.document.querySelector('button[aria-label="打开工具菜单"]').click() })
    await act(async () => {
      const item = button('工作台动效')
      item.addEventListener('click', () => item.remove(), { once: true })
      item.click()
    })
    const motionPanel = dom.window.document.querySelector('.tl-motion-preference-panel')
    assert.ok(motionPanel, 'the motion preference panel stays open when its menu item is removed during bubbling')
    assert.equal(motionPanel.getAttribute('popover'), 'manual', 'motion preference uses the native top-layer popover')
    assert.equal(motionPanel.hasAttribute('data-tl-topbar-popover-open'), true, 'the modal stack owns the open motion popover')
    assert.equal(motionPanel.querySelector('input[value="system"]').checked, true,
      'workbench motion defaults to following the operating system')
    await act(async () => { motionPanel.querySelector('input[value="on"]').click() })
    assert.equal(dom.window.localStorage.getItem('tradeloom.workbench.motion'), 'on')
    assert.equal(dom.window.document.documentElement.dataset.tlWorkbenchMotion, 'on')
    assert.equal(motionPreferenceEvent, 'on', 'an explicit motion change notifies already-open popout panes')
    await act(async () => { motionPanel.querySelector('input[value="system"]').click() })
    assert.equal(dom.window.localStorage.getItem('tradeloom.workbench.motion'), 'system')
    assert.equal(dom.window.document.documentElement.dataset.tlWorkbenchMotion, 'system')
    dom.window.removeEventListener('tradeloom:workbench-motion-preference-change', motionPreferenceListener)
    await act(async () => { dom.window.document.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })) })
    assert.ok(dom.window.document.querySelector('.tl-agent-capabilities'),
      'the first Escape preserves the workspace modal while its top-layer popup is open')
    assert.equal(dom.window.document.querySelector('.tl-motion-preference-panel'), null,
      'the first Escape closes the top-layer motion popup')
    assert.equal(dom.window.document.getElementById('workspace').hasAttribute('inert'), true,
      'dismissing the popup leaves the modal inert lock held')
    await act(async () => { dom.window.document.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })) })
    assert.equal(dom.window.document.querySelector('.tl-agent-capabilities'), null,
      'a second Escape closes the workspace modal after its top-layer popup')
    assert.equal(dom.window.document.getElementById('workspace').getAttribute('inert'), null,
      'closing the last modal restores the prior non-inert workspace state')
    const retainCallsBeforeUsage = usageRetains
    const createCallsBeforeUsage = usageCreates
    const historyCallsBeforeUsage = usageHistoryReads
    const catalogSubscriptionsBeforeUsage = catalogSubscribeCalls
    const catalogUnsubscriptionsBeforeUsage = catalogUnsubscribeCalls
    const catalogListenersBeforeUsage = catalogListeners.size
    await act(async () => { dom.window.document.querySelector('button[aria-label="打开工具菜单"]').click() })
    await act(async () => {
      const item = button('会话用量')
      item.addEventListener('click', () => item.remove(), { once: true })
      item.click()
    })
    const usagePanel = dom.window.document.querySelector('.tl-session-usage-panel')
    assert.ok(usagePanel)
    assert.match(usagePanel.style.width, /440px \* var\(--tl-ui-scale, 1\)/,
      'the global session list popover width follows the selected density')
    assert.equal(usagePanel.querySelectorAll('[role="listitem"]').length, 3,
      'the actual React DOM renders one two-line item for each Host catalog id')
    assert.equal(usagePanel.querySelector('header').textContent, '会话上下文共 3 条×', 'usage header reports the native session-context label, exact count, and close control')
    const groups = [...usagePanel.querySelectorAll('details.tl-session-usage-group')]
    assert.deepEqual(groups.map(group => [`${group.querySelector('.tl-session-usage-group-heading > span').textContent} · ${group.querySelector('.tl-session-usage-count').textContent}`, group.open]), [
      ['场景会话 · 1 条', false], ['助手会话 · 1 条', true], ['其他会话 · 1 条', true],
    ], 'the reference popover uses three metadata-driven, collapsible groups with compact summaries')
    assert.equal(groups[0].querySelector('.tl-session-usage-group-heading > span').title, '已绑定到工作场景的会话',
      'the collapsed scenario group preserves its metadata description on the heading')
    await act(async () => { groups[0].querySelector('summary').click() })
    assert.equal(groups[0].open, true, 'the initially collapsed group can be expanded')
    assert.match(usagePanel.querySelector('.tl-session-usage-footer p').textContent, /^上下文数值来自原生 contextPressure 最近投影/,
      'the usage explanation identifies the native context-pressure projection')
    assert.match(usagePanel.textContent, /539%/)
    const zeroUsageRow = usagePanel.querySelector('[data-session-id="dom-primary"]')
    assert.equal(zeroUsageRow.querySelector('[data-usage-value="used"]').textContent, '0', 'a real zero stays distinct from missing usage')
    assert.equal(zeroUsageRow.querySelector('[data-usage-value="capacity"]').textContent, '12.8万', 'the native context-window capacity is shown separately')
    const unknownUsageRow = usagePanel.querySelector('[data-session-id="dom-other"]')
    assert.equal(unknownUsageRow.querySelector('[data-usage-value="used"]').textContent, '未知', 'missing usage remains explicitly unknown')
    assert.equal(usagePanel.querySelector('.tl-session-usage-footer summary').textContent, '轮数 / 压缩 / 成本：未知 口径', 'unsupported cumulative metrics remain unknown')
    assert.match(usagePanel.textContent, /角色绑定尚未由目录确认/)
    assert.equal(usagePanel.querySelectorAll('.tl-session-usage-group')[0].open, true,
      'a catalog rerender preserves the user-selected disclosure state')
    const helperRow = usagePanel.querySelector('[data-session-id="dom-subagent"]')
    assert.equal(helperRow.dataset.usageTone, 'danger')
    assert.equal(helperRow.querySelectorAll('strong').length, 1, 'catalog entries render as compact list rows rather than large cards or a grid')
    assert.deepEqual([...helperRow.children].map(node => node.className), ['tl-session-usage-row', 'tl-session-usage-detail', 'tl-session-usage-meter'],
      'each session remains a compact summary with separated details and a usage meter')
    assert.equal(helperRow.style.borderTop, '', 'rows do not add separators absent from the reference')
    assert.equal(helperRow.querySelector('.tl-session-usage-dot').className, 'tl-session-usage-dot',
      'the colored status dot uses the density-aware shared style')
    assert.match(dom.window.document.querySelector('style[data-tradeloom-nav-style]').textContent,
      /\.tl-session-usage-dot\s*\{[^}]*width:\.3em; height:\.3em/s,
      'the status dot scales with the compact shell font size')
    assert.match(dom.window.document.querySelector('style[data-tradeloom-nav-style]').textContent,
      /\.tl-session-usage-group\[open\] > summary \.tl-session-usage-caret\s*\{\s*transform:\s*rotate\(90deg\);/,
      'the visible caret rotates with the disclosure state')
    assert.match(dom.window.document.querySelector('style[data-tradeloom-nav-style]').textContent,
      /\.tl-session-usage-group > summary::-webkit-details-marker \{\s*display:\s*none;?\s*\}/,
      'the explicit caret replaces browser marker rendering consistently')
    assert.ok(catalogListeners.size >= 1, 'the open panel subscribes to catalog changes')
    assert.equal(usageListeners.size, 1, 'only the already loaded bound role session gets a context-pressure subscription')
    assert.equal(usageRetains, retainCallsBeforeUsage)
    assert.equal(usageCreates, createCallsBeforeUsage)
    assert.equal(usageHistoryReads, historyCallsBeforeUsage, 'the panel does not open sessions, refresh projections, or read history')
    assert.equal(usageListenersBySession.get('dom-not-listed')?.size ?? 0, 0,
      'a bound but not-yet-retained session is not scoped or subscribed prematurely')
    await act(async () => {
      lateScopeAvailable = true
      for (const listener of [...catalogListeners]) listener()
    })
    assert.equal(usageListenersBySession.get('dom-not-listed')?.size, 1,
      'a catalog notification reconciles an existing binding whose pane has just become scopeable')
    assert.equal(usageListenersBySession.get('dom-primary')?.size, 1,
      'reconciliation leaves exactly one subscription on the already loaded face')
    const beforeLatePressureUpdate = Number(usagePanel.dataset.revision)
    await act(async () => { initialLateFace.setValue({ projectedTokens: 175, contextWindow: 200 }) })
    assert.ok(Number(usagePanel.dataset.revision) > beforeLatePressureUpdate,
      'the newly subscribed face can refresh its live usage after the catalog reconciliation')
    const replacementLateFace = createPressureFace('dom-not-listed', { projectedTokens: 180, contextWindow: 200 })
    await act(async () => { for (const listener of [...catalogListeners]) listener() })
    assert.equal(usageListenersBySession.get('dom-not-listed')?.size, 1,
      'repeated catalog notifications do not duplicate a subscription to the same live face')
    assert.equal(initialLateFace.subscriberCount, 0, 'replacing a face cleans up its old listener')
    assert.equal(replacementLateFace.subscriberCount, 1, 'the replacement face is subscribed once')
    lateScopeAvailable = false
    await act(async () => { for (const listener of [...catalogListeners]) listener() })
    assert.equal(usageListenersBySession.get('dom-not-listed')?.size, 0,
      'a face that disappears from scope is unsubscribed during reconciliation')
    assert.equal(replacementLateFace.subscriberCount, 0, 'disappearing scope releases the replacement face too')
    assert.equal(usageListenersBySession.get('dom-primary')?.size, 1)
    await act(async () => {
      sessionCatalog = { phase: 'pending', ids: [], byId: {}, projectionsBySession: {} }
      for (const listener of [...catalogListeners]) listener()
    })
    assert.match(usagePanel.textContent, /正在读取已有会话目录/)
    assert.doesNotMatch(usagePanel.textContent, /会话目录中暂无记录/,
      'pending empty ids do not masquerade as a confirmed empty catalog')
    assert.match(usagePanel.querySelector('header').textContent, /共 0 条/)
    await act(async () => {
      sessionCatalog = { phase: 'ready', ids: [], byId: {}, projectionsBySession: {} }
      for (const listener of [...catalogListeners]) listener()
    })
    assert.match(usagePanel.textContent, /会话目录中暂无记录/,
      'an empty catalog message is shown only after the public list phase is ready')
    await act(async () => {
      sessionCatalog = {
        phase: 'ready',
        ids: ['dom-primary', 'dom-subagent', 'dom-other'],
        byId: {
          'dom-primary': { id: 'dom-primary', displayTitle: '场景会话', title: '场景会话', updatedAt: 0, running: false, blank: false, retainedBy: {} },
          'dom-subagent': { id: 'dom-subagent', displayTitle: '子助手会话', title: '子助手会话', parentId: 'dom-primary', origin: 'subagent', updatedAt: 0, running: false, blank: false, retainedBy: {} },
          'dom-other': { id: 'dom-other', displayTitle: '其他会话', title: '其他会话', updatedAt: 0, running: false, blank: false, retainedBy: {} },
        },
        projectionsBySession: {
          'dom-subagent': { values: { contextPressure: { projectedTokens: 539000, contextWindow: 100000 } }, state: 'ready', error: null },
          'dom-other': { values: {}, state: 'ready', error: null },
        },
      }
      for (const listener of [...catalogListeners]) listener()
    })
    await act(async () => { dom.window.document.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })) })
    assert.equal(dom.window.document.querySelector('.tl-session-usage-panel'), null)
    assert.equal(dom.window.document.querySelector('.tl-session-usage-footer'), null,
      'the explanatory footer is scoped to the open popover')
    await act(async () => { await new Promise(resolve => setImmediate(resolve)) })
    assert.equal(catalogListeners.size, catalogListenersBeforeUsage, 'closing the real dialog releases its catalog subscription without disturbing other owners')
    assert.equal(catalogSubscribeCalls - catalogSubscriptionsBeforeUsage, 1)
    assert.equal(catalogUnsubscribeCalls - catalogUnsubscriptionsBeforeUsage, 1,
      'the dialog invokes its own catalog cleanup exactly once')
    assert.equal(usageListeners.size, 0, 'closing the real dialog releases loaded-session subscriptions')
    await act(async () => { button('查看 MCP 与 Skill 能力').click() })
    capabilityPanel = dom.window.document.querySelector('.tl-agent-capabilities')
    assert.ok(capabilityPanel, 'the usage dialog can close with Escape without preventing later capability use')
    assert.match(agentStyle, /tl-capability-skill-grid\s*\{[^}]*grid-template-columns/s, 'Skill cards form a responsive multi-column grid')
    assert.match(agentStyle, /@media \(max-width: 520px\)[^{]*\{\s*\.tl-capability-skill-grid\s*\{\s*grid-template-columns: minmax\(0, 1fr\)/s,
      'narrow windows switch capability cards to one column')
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
    assert.equal(capabilityPanel.getAttribute('aria-modal'), 'true')
    assert.ok(capabilityPanel.closest('.tl-workspace-modal-backdrop'), 'capabilities render inside a workspace mask')
    await act(async () => {
      Object.defineProperty(dom.window, 'innerWidth', { value: 1280, configurable: true })
      selectorRect = { left: 900, top: 100, right: 940, bottom: 130, width: 40, height: 30 }
      dom.window.dispatchEvent(new dom.window.Event('resize'))
    })
    capabilityPanel = dom.window.document.querySelector('.tl-agent-capabilities')
    assert.equal(capabilityPanel.style.position, 'relative', 'capabilities are centered inside their workspace modal')
    await act(async () => {
      selectorRect = { left: 900, top: 200, right: 940, bottom: 230, width: 40, height: 30 }
      dom.window.dispatchEvent(new dom.window.Event('scroll'))
    })
    capabilityPanel = dom.window.document.querySelector('.tl-agent-capabilities')
    assert.equal(capabilityPanel.style.position, 'relative', 'scrolling does not turn the modal into an anchored popover')
    await act(async () => {
      Object.assign(visualViewport, { width: 250, height: 200, offsetLeft: 50, offsetTop: 30 })
      selectorRect = { left: 260, top: 180, right: 300, bottom: 200, width: 40, height: 20 }
      visualViewport.dispatchEvent(new dom.window.Event('resize'))
    })
    capabilityPanel = dom.window.document.querySelector('.tl-agent-capabilities')
    assert.equal(capabilityPanel.style.position, 'relative', 'visual viewport changes retain modal positioning')
    await act(async () => {
      Object.assign(visualViewport, { width: 400, height: 300, offsetLeft: 0, offsetTop: 120 })
      selectorRect = { left: 80, top: 78, right: 110, bottom: 108, width: 30, height: 30 }
      visualViewport.dispatchEvent(new dom.window.Event('resize'))
    })
    capabilityPanel = dom.window.document.querySelector('.tl-agent-capabilities')
    assert.ok(capabilityPanel.style.maxHeight.includes('100%'), 'the modal remains scroll-bounded by the workspace')
    await act(async () => {
      dom.window.document.activeElement.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    })
    assert.equal(dom.window.document.querySelector('.tl-agent-capabilities'), null, 'Escape closes the modal')
    assert.equal(dom.window.document.activeElement, selector, 'closing returns focus to the still-mounted Agent selector')
    assert.equal(dom.window.document.getElementById('workspace').hasAttribute('inert'), false, 'closing restores covered workspace interactivity')
    assert.equal(dom.window.document.getElementById('workspace-prior-inert').getAttribute('inert'), 'original', 'closing restores the branch prior inert value exactly')
    const openBothModals = async () => {
      await act(async () => { button('查看 MCP 与 Skill 能力').click(); await new Promise(resolve => setImmediate(resolve)) })
      await act(async () => { dom.window.document.querySelector('button[aria-label="打开工具菜单"]').click(); await new Promise(resolve => setImmediate(resolve)) })
      const capabilityDialog = dom.window.document.querySelector('.tl-agent-capabilities')
      assert.equal(dom.window.document.querySelector('#tl-shell-tools-menu')?.getAttribute('popover'), 'manual', 'the tools menu remains in the browser top layer above the capability modal')
      await act(async () => { capabilityDialog.querySelector('.tl-agent-capabilities-header h3').dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })); await new Promise(resolve => setImmediate(resolve)) })
      assert.equal(dom.window.document.querySelector('#tl-shell-tools-menu'), null, 'a click in a modal dismisses the top-layer tools menu')
      assert.ok(dom.window.document.querySelector('.tl-agent-capabilities'), 'dismissing the tools menu preserves the modal')
      await act(async () => { dom.window.document.querySelector('button[aria-label="打开工具菜单"]').click(); await new Promise(resolve => setImmediate(resolve)) })
      await act(async () => { button('插件管理').click(); await new Promise(resolve => setImmediate(resolve)) })
      assert.equal(dom.window.document.querySelectorAll('.tl-workspace-modal-backdrop').length, 2)
      assert.equal(dom.window.document.getElementById('workspace').hasAttribute('inert'), true)
    }
    await openBothModals()
    await act(async () => { dom.window.document.querySelector('button[aria-label="关闭助手能力与配置"]').click(); await new Promise(resolve => setImmediate(resolve)) })
    assert.ok(dom.window.document.querySelector('.tl-plugin-inventory-panel'), 'closing the older modal leaves the newer modal mounted')
    assert.equal(dom.window.document.getElementById('workspace').hasAttribute('inert'), true, 'closing one of two modals does not release the shared inert lock')
    await act(async () => { dom.window.document.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })) })
    assert.equal(dom.window.document.querySelectorAll('[role="dialog"]').length, 0, 'one Escape closes only the remaining top modal')
    assert.equal(dom.window.document.getElementById('workspace').hasAttribute('inert'), false, 'the final modal close restores workspace interactivity')
    assert.equal(dom.window.document.getElementById('workspace-prior-inert').getAttribute('inert'), 'original', 'nested close preserves the original inert attribute value')
    await openBothModals()
    await act(async () => { dom.window.document.querySelector('button[aria-label="关闭插件概览"]').click(); await new Promise(resolve => setImmediate(resolve)) })
    assert.ok(dom.window.document.querySelector('.tl-agent-capabilities'), 'closing the newer modal leaves the older modal mounted')
    assert.equal(dom.window.document.getElementById('workspace').hasAttribute('inert'), true, 'closing the newer modal keeps covered workspace inert')
    await act(async () => { dom.window.document.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })) })
    assert.equal(dom.window.document.querySelectorAll('[role="dialog"]').length, 0, 'one Escape closes only the remaining capability modal')
    assert.equal(dom.window.document.getElementById('workspace').hasAttribute('inert'), false)
    assert.equal(dom.window.document.getElementById('workspace-prior-inert').getAttribute('inert'), 'original')
    await openBothModals()
    await act(async () => { dom.window.document.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })) })
    assert.ok(dom.window.document.querySelector('.tl-agent-capabilities'), 'Escape leaves the lower capability modal open')
    assert.equal(dom.window.document.querySelector('.tl-plugin-inventory-panel'), null, 'Escape closes only the top plugin modal')
    assert.equal(dom.window.document.getElementById('workspace').hasAttribute('inert'), true, 'Escape keeps workspace inert while a lower modal remains')
    await act(async () => { dom.window.document.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })) })
    assert.equal(dom.window.document.querySelector('.tl-agent-capabilities'), null, 'the next Escape closes the remaining capability modal')
    assert.equal(dom.window.document.getElementById('workspace').hasAttribute('inert'), false, 'the final Escape restores workspace interactivity')
    assert.equal(dom.window.document.getElementById('workspace-prior-inert').getAttribute('inert'), 'original')
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
