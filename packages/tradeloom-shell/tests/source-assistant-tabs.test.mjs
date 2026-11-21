import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const sourceRoot = resolve(root, 'apps/tradeloom-launcher/stage5-source06/asar/renderer/source-shell')
const bridgeSource = readFileSync(resolve(sourceRoot, 'replica-ui/business-bridge.js'), 'utf8')
const entrySource = readFileSync(resolve(sourceRoot, 'source-entry.html'), 'utf8')

function helperSource(start, end) {
  const from = bridgeSource.indexOf(start)
  const to = bridgeSource.indexOf(end, from)
  assert.ok(from >= 0 && to > from, `${start} must exist in the deployed bridge`)
  return bridgeSource.slice(from, to)
}

class Element {
  constructor(tag = 'div') {
    this.tagName = tag
    this.children = []
    this.dataset = {}
    this.attributes = new Map()
    this.handlers = new Map()
    this.style = {}
    this.isConnected = true
    this.hidden = false
    this.textContent = ''
    this.className = ''
    this.offsetHeight = 30
    this.offsetWidth = 140
  }
  setAttribute(name, value) { this.attributes.set(name, String(value)) }
  getAttribute(name) { return this.attributes.get(name) }
  addEventListener(name, fn) { this.handlers.set(name, fn) }
  append(...nodes) { this.children.push(...nodes) }
  replaceChildren(...nodes) { this.children = nodes }
  remove() { this.isConnected = false }
  contains(target) { return target === this || this.children.some(child => child.contains?.(target)) }
  showPopover() {}
  hidePopover() {}
  focus() { this.focused = true }
  getBoundingClientRect() { return { left: 20, top: 30, right: 300, bottom: 60, width: 280, height: 30 } }
  click() { return this.handlers.get('click')?.({ stopPropagation() {}, preventDefault() {} }) }
}

function fixtureApi() {
  const calls = []
  const api = {
    async assistantTabCatalog(sceneId, panelId) {
      calls.push(['catalog', sceneId, panelId])
      const roleId = sceneId === 'product-scene' ? 'delivery' : 'product'
      return [{ roleId, panelId: `assistant-tab:${panelId}:${roleId}`, label: roleId === 'delivery' ? '交付助手' : '商品助手' }]
    },
    async setVisible(sceneId, panelId, visible) { calls.push(['visible', sceneId, panelId, visible]); return true },
    async create(sceneId, panelId) { calls.push(['create', sceneId, panelId]); return { status: 'context-mounted', placement: 'docked' } },
    async status(sceneId, panelId) { calls.push(['status', sceneId, panelId]); return { status: 'context-mounted', placement: 'docked' } },
  }
  return { api, calls }
}

for (const scenario of [
  { sceneId: 'product-scene', panelId: 'product-chat', fixedRole: 'product', fixedLabel: '商品助手', addedRole: 'delivery', addedLabel: '交付助手' },
  { sceneId: 'delivery-scene', panelId: 'delivery-chat', fixedRole: 'delivery', fixedLabel: '交付助手', addedRole: 'product', addedLabel: '商品助手' },
]) {
  test(`${scenario.sceneId} assistant fixed tab survives add, switch, and close`, async () => {
    const panel = new Element('section')
    const header = new Element('header')
    const controls = new Element('div')
    header.querySelector = selector => selector === '.panel-controls' ? controls : null
    header.insertBefore = (node, before) => {
      const index = before ? header.children.indexOf(before) : -1
      header.children.splice(index < 0 ? header.children.length : index, 0, node)
      node.isConnected = true
    }
    panel.querySelector = selector => selector === '.panel-header' ? header : null
    const note = new Element('div')
    const interactionCalls = []
    const record = { panel, content: new Element('main'), note, revision: 1, uiSceneId: scenario.sceneId,
      created: true, status: 'context-mounted', visible: true, placement: 'docked', syncRevision: 0,
      target: { sceneId: scenario.sceneId, panelId: scenario.panelId, roleId: scenario.fixedRole } }
    const { api, calls } = fixtureApi()
    const body = new Element('body')
    const document = { body, createElement: tag => new Element(tag), querySelectorAll: () => [] }
    const context = {
      document, window: { innerHeight: 700, innerWidth: 1000,
        sourcePanelInteractions: {
          adoptMenu: menu => interactionCalls.push(['adopt', menu]),
          dismissMenu: menu => { interactionCalls.push(['dismiss', menu]); menu.remove() },
        } }, app: { harnessSurface: api },
      state: { roleRecord: record, sceneTransitionPending: false, tearingDown: false,
        config: { raw: { roles: [{ id: scenario.fixedRole, label: scenario.fixedLabel }] } } },
      isCurrentRole: candidate => candidate === record && !candidate.disposed,
      syncRole: async candidate => { calls.push(['sync', candidate.target.panelId]); candidate.visible = true },
      onRoleStatus(value) {
        record.status = value.status
        record.placement = value.placement || 'docked'
        if (value.status === 'context-mounted') note.hidden = true
      },
    }
    const helpers = helperSource('  function renderAssistantTabBar(record) {', '  function openSceneRotation(panel) {')
    const funcs = vm.runInNewContext(`${helpers}\n({renderAssistantTabBar, selectAssistantTab, closeAssistantTab, openAssistantTabChooser, initializeAssistantTabs})`, context)
    funcs.initializeAssistantTabs(record, scenario.fixedRole, record.target)
    const group = record.assistantTabs
    assert.equal(group.fixedLabel, scenario.fixedLabel)
    assert.equal(group.activeRoleId, scenario.fixedRole)
    assert.equal(group.bar.children.length, 1)
    assert.equal(group.bar.children[0].textContent, scenario.fixedLabel)

    await funcs.openAssistantTabChooser(panel)
    const menu = body.children[0]
    assert.equal(menu.getAttribute('aria-label'), '添加助手')
    assert.equal(menu.children[0].textContent, scenario.addedLabel)
    assert.deepEqual(interactionCalls.map(([action]) => action), ['adopt'])
    await menu.children[0].click()
    assert.deepEqual(interactionCalls.map(([action]) => action), ['adopt', 'dismiss'])
    assert.equal(group.tabs.has(scenario.addedRole), true)
    assert.equal(group.activeRoleId, scenario.addedRole)
    assert.equal(record.status, 'context-mounted')
    assert.equal(group.bar.children[0].textContent, scenario.fixedLabel, 'fixed helper remains first and has no close button')
    assert.equal(group.bar.children.filter(node => node.className === 'business-assistant-tab-close').length, 1)

    await funcs.selectAssistantTab(record, scenario.fixedRole)
    assert.equal(group.activeRoleId, scenario.fixedRole)
    assert.equal(record.target.panelId, scenario.panelId)
    await funcs.selectAssistantTab(record, scenario.addedRole)
    assert.equal(group.activeRoleId, scenario.addedRole)
    const alias = `assistant-tab:${scenario.panelId}:${scenario.addedRole}`
    assert.ok(calls.some(call => call[0] === 'create' && call[2] === alias))

    await funcs.closeAssistantTab(record, scenario.addedRole)
    assert.equal(group.tabs.has(scenario.addedRole), false)
    assert.equal(group.activeRoleId, scenario.fixedRole)
    assert.equal(record.target.panelId, scenario.panelId)
    assert.equal(group.bar.children[0].textContent, scenario.fixedLabel)
    assert.ok(calls.some(call => call[0] === 'visible' && call[2] === alias && call[3] === false))
    assert.equal(calls.some(call => call[0] === 'delete-session'), false, 'closing a tab does not remove its existing session')
  })
}

test('production source entry loads the business bridge that owns assistant tabs', () => {
  assert.match(entrySource, /<script src="replica-ui\/business-bridge\.js"><\/script>/)
  assert.doesNotMatch(entrySource, /<script[^>]+replica-adapter\.js/)
  assert.match(readFileSync(resolve(sourceRoot, 'replica-ui/renderer.js'), 'utf8'), /window\.businessBridge\.renderRolePanel\(panel, content\)/)
  const interactions = readFileSync(resolve(sourceRoot, 'replica-ui/panel-interactions.js'), 'utf8')
  assert.match(interactions, /businessBridge\?\.openAssistantTabChooser/)
  assert.match(interactions, /openChooser\(ownerPanel\)/)
  assert.match(interactions, /panel\?\.classList\.contains\('panel-chat'\)\) entries\.unshift\(\{ label: '添加助手'/)
})

test('right-click Add Assistant invokes the chooser on its own panel', () => {
  const interactions = readFileSync(resolve(sourceRoot, 'replica-ui/panel-interactions.js'), 'utf8')
  const start = interactions.indexOf('  function activateMenuEntry(entry, item) {')
  const end = interactions.indexOf('  function openMenu(anchor, panel, options = {}) {', start)
  assert.ok(start >= 0 && end > start, 'the production menu action remains testable')
  const panel = {}
  const opened = []
  const context = { window: { businessBridge: { openAssistantTabChooser: value => { opened.push(value) } } },
    announce() {}, runLayoutPreset() {}, document: { getElementById: () => null } }
  const entry = vm.runInNewContext(`let menu = { panel: panelValue }; function closeMenu() { menu = null }\n${interactions.slice(start, end)}\nactivateMenuEntry`,
    { ...context, panelValue: panel })
  entry({ label: '添加助手', explanation: '在当前助手区域打开另一个已绑定助手。' }, { getBoundingClientRect() { return {} } })
  assert.deepEqual(opened, [panel])
})

test('empty or failed catalog keeps visible chooser and reports failures in the panel', async () => {
  const body = new Element('body')
  const panel = new Element('section')
  const bar = new Element('div')
  const note = new Element('div')
  const record = { panel, content: new Element('main'), note, revision: 1, uiSceneId: 'product-scene', disposed: false,
    assistantTabs: { sceneId: 'product-scene', hostPanelId: 'product-chat', fixedRoleId: 'product', fixedLabel: '商品助手',
      fixedTarget: { sceneId: 'product-scene', panelId: 'product-chat', roleId: 'product' }, activeRoleId: 'product',
      tabs: new Map(), switchGeneration: 0, chooserGeneration: 0, bar } }
  const { api } = fixtureApi()
  api.assistantTabCatalog = async () => []
  const context = { document: { body, createElement: tag => new Element(tag) },
    window: { innerHeight: 700, innerWidth: 1000 }, app: { harnessSurface: api },
    state: { roleRecord: record, sceneTransitionPending: false, tearingDown: false },
    isCurrentRole: candidate => candidate === record && !candidate.disposed,
  }
  const helpers = helperSource('  function renderAssistantTabBar(record) {', '  function openSceneRotation(panel) {')
  const openChooser = vm.runInNewContext(`${helpers}\nopenAssistantTabChooser`, context)
  await openChooser(panel)
  assert.equal(body.children[0].children[0].textContent, '没有其他可用助手')
  assert.equal(body.children[0].getAttribute('aria-label'), '添加助手')

  api.assistantTabCatalog = async () => { throw new Error('catalog unavailable') }
  await openChooser(panel)
  assert.equal(note.textContent, '可用助手清单暂不可用。')
  assert.equal(note.hidden, false)
})

test('real assistant chooser survives adoption and closes on outside click or Escape', async () => {
  const interactionSource = readFileSync(resolve(sourceRoot, 'replica-ui/panel-interactions.js'), 'utf8')
  const start = interactionSource.indexOf('  function closeMenu(preserveElement) {')
  const end = interactionSource.indexOf('  function restoreEntries(', start)
  assert.ok(start >= 0 && end > start, 'the production menu lifecycle remains reusable')
  const body = new Element('body')
  const listeners = new Set()
  const document = {
    body,
    createElement: tag => new Element(tag),
    querySelectorAll: selector => selector === '.pi-menu'
      ? body.children.filter(node => node.isConnected && node.className.split(/\s+/).includes('pi-menu')) : [],
    addEventListener: (name, fn) => listeners.add(`${name}:${fn.name}`),
    removeEventListener: (name, fn) => listeners.delete(`${name}:${fn.name}`),
  }
  const window = { innerHeight: 700, innerWidth: 1000, addEventListener() {}, removeEventListener() {} }
  const interactionContext = { document, window }
  const menuApi = vm.runInNewContext(`let menu = null\n${interactionSource.slice(start, end)}\n({adoptMenu, onOutsideMenu, onMenuKey})`, interactionContext)
  window.sourcePanelInteractions = menuApi

  const panel = new Element('section')
  const note = new Element('div')
  const bar = new Element('div')
  const record = { panel, content: new Element('main'), note, revision: 1, uiSceneId: 'product-scene', disposed: false,
    assistantTabs: { sceneId: 'product-scene', hostPanelId: 'product-chat', fixedRoleId: 'product', fixedLabel: '商品助手',
      fixedTarget: { sceneId: 'product-scene', panelId: 'product-chat', roleId: 'product' }, activeRoleId: 'product',
      tabs: new Map(), switchGeneration: 0, chooserGeneration: 0, bar } }
  const api = { assistantTabCatalog: async () => [] }
  const bridgeContext = { document, window, app: { harnessSurface: api },
    state: { roleRecord: record, sceneTransitionPending: false, tearingDown: false },
    isCurrentRole: candidate => candidate === record && !candidate.disposed }
  const helpers = helperSource('  function renderAssistantTabBar(record) {', '  function openSceneRotation(panel) {')
  const openChooser = vm.runInNewContext(`${helpers}\nopenAssistantTabChooser`, bridgeContext)

  await openChooser(panel)
  const first = document.querySelectorAll('.pi-menu')[0]
  assert.ok(first?.isConnected, 'adoptMenu must preserve the newly appended chooser')
  assert.equal(listeners.size, 3)
  menuApi.onOutsideMenu({ target: {} })
  assert.equal(first.isConnected, false)
  assert.equal(listeners.size, 0)

  await openChooser(panel)
  const second = document.querySelectorAll('.pi-menu')[0]
  assert.ok(second?.isConnected)
  let prevented = false
  menuApi.onMenuKey({ key: 'Escape', preventDefault() { prevented = true } })
  assert.equal(prevented, true)
  assert.equal(second.isConnected, false)
  assert.equal(bar.focused, true)
  assert.equal(listeners.size, 0)
})
