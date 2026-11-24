import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const sourceRoot = resolve(root, 'apps/tradeloom-launcher/stage5-source06/asar/renderer/source-shell')
const bridgeSource = readFileSync(resolve(sourceRoot, 'replica-ui/business-bridge.js'), 'utf8')
const controllerSource = readFileSync(resolve(sourceRoot, '../../lib/tradeloom-source-shell/source-shell-controller.mjs'), 'utf8')
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
    this.parentNode = null
  }
  setAttribute(name, value) { this.attributes.set(name, String(value)) }
  getAttribute(name) { return this.attributes.get(name) }
  removeAttribute(name) { this.attributes.delete(name) }
  addEventListener(name, fn) { this.handlers.set(name, fn) }
  append(...nodes) { for (const node of nodes) { node.parentNode = this; node.isConnected = this.isConnected; this.children.push(node) } }
  replaceChildren(...nodes) {
    for (const child of this.children) { child.parentNode = null; child.isConnected = false }
    this.children = []
    this.append(...nodes)
  }
  insertBefore(node, before) {
    const index = before ? this.children.indexOf(before) : -1
    node.parentNode = this
    node.isConnected = this.isConnected
    this.children.splice(index < 0 ? this.children.length : index, 0, node)
  }
  remove() {
    this.isConnected = false
    if (this.parentNode) this.parentNode.children = this.parentNode.children.filter(child => child !== this)
    this.parentNode = null
  }
  contains(target) { return target === this || this.children.some(child => child.contains?.(target)) }
  querySelector(selector) {
    const matches = node => selector.startsWith('.') ? node.className.split(/\s+/).includes(selector.slice(1))
      : selector === '.panel-header' ? node.className === 'panel-header'
        : selector === '.panel-content' ? node.className === 'panel-content'
          : false
    const visit = node => { for (const child of node.children) { if (matches(child)) return child; const nested = visit(child); if (nested) return nested } }
    return visit(this)
  }
  showPopover() {}
  hidePopover() {}
  focus() { this.focused = true }
  getBoundingClientRect() { return { left: 20, top: 30, right: 300, bottom: 60, width: 280, height: 30 } }
  get nextSibling() {
    if (!this.parentNode) return null
    return this.parentNode.children[this.parentNode.children.indexOf(this) + 1] ?? null
  }
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
  { sceneId: 'product-scene', panelId: 'product-chat', fixedRole: 'product', roleLabel: '商品专家', fixedLabel: '商品助手', addedRole: 'delivery', addedLabel: '交付助手' },
  { sceneId: 'delivery-scene', panelId: 'delivery-chat', fixedRole: 'delivery', roleLabel: '交付协同', fixedLabel: '交付助手', addedRole: 'product', addedLabel: '商品助手' },
]) {
  test(`${scenario.sceneId} assistant fixed tab survives add, switch, and close`, async () => {
    const panel = new Element('section')
    const header = new Element('header')
    header.className = 'panel-header'
    const title = new Element('strong')
    title.className = 'panel-title'
    title.textContent = scenario.fixedLabel
    const identity = new Element('div')
    identity.className = 'panel-identity'
    identity.append(title)
    const controls = new Element('div')
    controls.className = 'panel-controls'
    const componentTabs = new Element('div')
    componentTabs.className = 'pi-component-tabs'
    const componentTab = new Element('button')
    componentTab.textContent = scenario.fixedLabel
    componentTabs.append(componentTab)
    header.append(identity, componentTabs, controls)
    header.querySelector = selector => selector === '.panel-controls' ? controls : selector === '.panel-title' ? title
      : selector === '.pi-component-tabs' ? componentTabs : null
    const content = new Element('main')
    content.className = 'panel-content'
    panel.append(header, content)
    const note = new Element('div')
    const interactionCalls = []
    const record = { panel, content, note, revision: 1, uiSceneId: scenario.sceneId,
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
        config: { raw: { roles: [{ id: scenario.fixedRole, label: scenario.roleLabel }] } } },
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
    assert.equal(group.fixedLabel, scenario.fixedLabel, 'the fixed tab uses the actual component title when it differs from the configured role label')
    assert.equal(group.activeRoleId, scenario.fixedRole)
    assert.ok(group.row, 'the original assistant remains available as a fixed tab before any additions')
    assert.equal(group.row.parentNode, identity)
    assert.equal(identity.children.indexOf(group.row), identity.children.indexOf(title) + 1)
    assert.equal(group.row.dataset.assistantTitleDuplicate, 'true', 'the single full fixed tab label replaces an identical component title')
    assert.equal(group.row.dataset.assistantComponentDuplicate, 'true', 'a matching singleton component tab is suppressed as a duplicate')
    assert.equal(componentTabs.getAttribute('aria-hidden'), 'true')
    assert.equal(title.getAttribute('aria-hidden'), 'true')
    assert.equal(group.bar.children.length, 2)
    assert.equal(group.bar.children[0].dataset.assistantFixed, 'true')
    assert.equal(group.bar.children[0].children.length, 0, 'the fixed tab has no close control')
    assert.equal(group.bar.children[1].className, 'business-assistant-tabs-scroll')
    assert.equal(header.contains(title), true)

    const additionalComponent = new Element('button')
    additionalComponent.textContent = '其他组件'
    componentTabs.append(additionalComponent)
    funcs.renderAssistantTabBar(record)
    assert.equal(group.row.dataset.assistantComponentDuplicate, undefined, 'multiple component tabs remain available for switching')
    assert.equal(componentTabs.getAttribute('aria-hidden'), undefined)
    componentTabs.children.pop()
    funcs.renderAssistantTabBar(record)

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
    assert.equal(group.row.parentNode, identity)
    assert.equal(identity.children.indexOf(group.row), identity.children.indexOf(title) + 1,
      'assistant tabs share the component title row')
    assert.equal(header.contains(group.row), true)
    assert.equal(group.row.contains(group.bar), true)
    assert.equal(group.bar.children[0].textContent, scenario.fixedLabel, 'fixed helper remains first and has no close button')
    assert.equal(group.bar.children[0].dataset.assistantFixed, 'true')
    assert.equal(group.bar.children[1].children[1].className, 'business-assistant-tab-close')

    await funcs.selectAssistantTab(record, scenario.fixedRole)
    assert.equal(group.activeRoleId, scenario.fixedRole)
    assert.equal(record.target.panelId, scenario.panelId)
    await funcs.selectAssistantTab(record, scenario.addedRole)
    assert.equal(group.activeRoleId, scenario.addedRole)
    assert.equal(group.bar.children[1].children[0].dataset.assistantTabRole, scenario.addedRole,
      'the selected tab stays beside its close control in the dedicated row')
    assert.equal(group.bar.children[1].children[0].getAttribute('aria-selected'), 'true')
    const closeControl = group.bar.children[1].children[1]
    assert.equal(closeControl.type, 'button')
    assert.equal(closeControl.getAttribute('aria-label'), `关闭${scenario.addedLabel}`)
    const alias = `assistant-tab:${scenario.panelId}:${scenario.addedRole}`
    assert.ok(calls.some(call => call[0] === 'create' && call[2] === alias))

    await closeControl.click()
    assert.equal(group.tabs.has(scenario.addedRole), false)
    assert.equal(group.activeRoleId, scenario.fixedRole)
    assert.equal(record.target.panelId, scenario.panelId)
    assert.equal(group.row.hidden, false, 'the fixed assistant tab remains visible after closing additions')
    assert.equal(group.bar.children.length, 2)
    assert.equal(group.bar.children[0].dataset.assistantFixed, 'true')
    assert.equal(group.bar.children[1].children.length, 0)
    assert.equal(header.contains(title), true)
    assert.ok(calls.some(call => call[0] === 'visible' && call[2] === alias && call[3] === false))
    assert.equal(calls.some(call => call[0] === 'delete-session'), false, 'closing a tab does not remove its existing session')
  })
}

test('assistant tabs stay beside the component title and provide compact overflow controls', () => {
  const css = readFileSync(resolve(sourceRoot, 'replica-ui/business-bridge.css'), 'utf8')
  assert.match(css, /\.business-assistant-tab-row\s*\{[^}]*flex:1 1 0[^}]*min-width:0/)
  assert.match(css, /\.business-assistant-tab-row\[hidden\]\s*\{\s*display:none/)
  assert.match(css, /\.business-assistant-tabs\s*\{[^}]*width:100%[^}]*min-width:0/)
  assert.match(css, /\.business-assistant-tabs > button,\s*\.business-assistant-tab-current > button,\s*\.business-assistant-tab > button\s*\{[^}]*min-width:28px/)
  assert.match(css, /\.business-assistant-tabs > button\[data-assistant-fixed\]\s*\{[^}]*flex:0 0 auto/)
  assert.match(css, /\.business-assistant-tab-current\s*\{[^}]*flex:0 1 8em[^}]*min-width:24px/)
  assert.match(css, /\.business-assistant-tab-current > button\[role="tab"\]\s*\{[^}]*flex:1 1 0[^}]*min-width:0/)
  assert.match(css, /\.panel-header:has\(\.business-assistant-tab-row\[data-assistant-title-duplicate="true"\]\) \.panel-title\s*\{[^}]*display:none/)
  assert.match(css, /\.panel-header:has\(\.business-assistant-tab-row\[data-assistant-component-duplicate="true"\]\) \.pi-component-tabs\s*\{[^}]*display:none/)
  assert.match(css, /\.business-assistant-tab-close\s*\{[^}]*flex:0 0 24px !important[^}]*min-width:24px !important[^}]*width:24px[^}]*height:24px/)
  assert.match(css, /\.business-assistant-tabs-scroll\s*\{[^}]*min-width:0[^}]*overflow-x:auto/)
})

test('chooser drops blank, repeated role ids, and repeated panel ids before rendering', async () => {
  const body = new Element('body')
  const panel = new Element('section')
  const note = new Element('div')
  const record = { panel, content: new Element('main'), note, revision: 1, uiSceneId: 'product-scene', disposed: false,
    assistantTabs: { sceneId: 'product-scene', hostPanelId: 'product-chat', fixedRoleId: 'product', fixedLabel: '商品助手',
      fixedTarget: { sceneId: 'product-scene', panelId: 'product-chat', roleId: 'product' }, activeRoleId: 'product',
      tabs: new Map(), switchGeneration: 0, chooserGeneration: 0 } }
  const options = [
    { roleId: 'delivery', panelId: 'assistant-tab:product-chat:delivery', label: '交付助手' },
    { roleId: 'delivery', panelId: 'duplicate-role', label: '重复角色' },
    { roleId: 'custom', panelId: 'assistant-tab:product-chat:delivery', label: '重复面板' },
    { roleId: '  ', panelId: 'blank-role', label: '空标识' },
    { roleId: 'other', panelId: ' ', label: '空面板' },
  ]
  const context = { document: { body, createElement: tag => new Element(tag) },
    window: { innerHeight: 700, innerWidth: 1000 }, app: { harnessSurface: { assistantTabCatalog: async () => options } },
    state: { roleRecord: record, sceneTransitionPending: false, tearingDown: false },
    isCurrentRole: candidate => candidate === record && !candidate.disposed }
  const helpers = helperSource('  function renderAssistantTabBar(record) {', '  function openSceneRotation(panel) {')
  const openChooser = vm.runInNewContext(`${helpers}\nopenAssistantTabChooser`, context)
  await openChooser(panel)
  const menu = body.children[0]
  assert.equal(menu.children.length, 1)
  assert.equal(menu.children[0].textContent, '交付助手')
})

test('closing the selected added assistant moves to another added tab when one remains', async () => {
  const panel = new Element('section')
  const header = new Element('header')
  header.className = 'panel-header'
  const title = new Element('strong')
  title.className = 'panel-title'
  const controls = new Element('div')
  controls.className = 'panel-controls'
  header.append(title, controls)
  header.querySelector = selector => selector === '.panel-title' ? title : selector === '.panel-controls' ? controls : null
  const content = new Element('main')
  content.className = 'panel-content'
  panel.append(header, content)
  const note = new Element('div')
  const record = { panel, content, note, revision: 1, uiSceneId: 'product-scene', created: false,
    status: 'loading', visible: false, placement: 'docked', syncRevision: 0,
    target: { sceneId: 'product-scene', panelId: 'assistant-tab:product-chat:first', roleId: 'first' } }
  record.assistantTabs = { sceneId: 'product-scene', hostPanelId: 'product-chat', fixedRoleId: 'product', fixedLabel: '商品助手',
    fixedTarget: { sceneId: 'product-scene', panelId: 'product-chat', roleId: 'product' }, activeRoleId: 'first',
    tabs: new Map([
      ['first', { roleId: 'first', label: '第一个助手', target: record.target }],
      ['second', { roleId: 'second', label: '第二个助手', target: { sceneId: 'product-scene', panelId: 'assistant-tab:product-chat:second', roleId: 'second' } }],
    ]), switchGeneration: 0, chooserGeneration: 0 }
  const calls = []
  const context = { document: { createElement: tag => new Element(tag) }, window: {},
    app: { harnessSurface: { async setVisible(...args) { calls.push(['visible', ...args]) },
      async create(...args) { calls.push(['create', ...args]); return { status: 'unbound' } },
      async status(...args) { calls.push(['status', ...args]); return { status: 'unbound' } } } },
    state: { roleRecord: record, sceneTransitionPending: false, tearingDown: false },
    isCurrentRole: candidate => candidate === record && !candidate.disposed,
    onRoleStatus(value) { record.status = value.status } }
  const helpers = helperSource('  function renderAssistantTabBar(record) {', '  function openSceneRotation(panel) {')
  const closeAssistantTab = vm.runInNewContext(`${helpers}\ncloseAssistantTab`, context)
  await closeAssistantTab(record, 'first')
  assert.equal(record.assistantTabs.tabs.has('first'), false)
  assert.equal(record.assistantTabs.tabs.has('second'), true)
  assert.equal(record.assistantTabs.activeRoleId, 'second')
  assert.equal(record.target.panelId, 'assistant-tab:product-chat:second')
  assert.ok(calls.some(call => call[0] === 'create' && call[2] === 'assistant-tab:product-chat:second'))
  assert.equal(calls.some(call => call[0] === 'delete-session'), false)
})

test('production source entry loads the business bridge that owns assistant tabs', () => {
  const renderer = readFileSync(resolve(sourceRoot, 'replica-ui/renderer.js'), 'utf8')
  assert.match(entrySource, /<script src="replica-ui\/business-bridge\.js"><\/script>/)
  assert.doesNotMatch(entrySource, /<script[^>]+replica-adapter\.js/)
  assert.match(renderer, /window\.businessBridge\.renderRolePanel\(panel, content\)/)
  assert.match(renderer, /wrap\.append\(head, content\)/, 'the fixture follows the actual header/content sibling structure')
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

test('live catalog includes unique configured roles and available DSH presets using opaque targets', async () => {
  const start = controllerSource.indexOf("      bind('assistantTabCatalog', async (event, hostSceneId, hostPanelId) => {")
  const end = controllerSource.indexOf("\n      bind('create', async (event, sceneId, panelId) => {", start)
  assert.ok(start >= 0 && end > start, 'the production assistant catalog handler remains testable')
  let catalog
  const window = {}
  const scenes = [
    { id: 'product-scene', panels: [{ id: 'product-chat', type: 'native-chat', roleId: 'product' }] },
    { id: 'center-scene', panels: [{ id: 'center-chat', type: 'native-chat', roleId: 'center' }] },
    { id: 'custom-scene', panels: [{ id: 'custom-chat', type: 'native-chat', roleId: 'custom-reviewer' }] },
  ]
  const config = { roles: [
    { id: 'product', label: '商品助手' }, { id: 'center', label: '中心' },
    { id: 'delivery', label: '交付助手' }, { id: 'custom-reviewer', label: '自定义审核助手' }, { id: 'custom-reviewer', label: '重复项' },
  ], scenes }
  const context = { bind(name, handler) { assert.equal(name, 'assistantTabCatalog'); catalog = handler },
    assertWindow: () => window, scene: id => scenes.find(item => item.id === id),
    windows: new Map([['product-scene', window]]), hasNativeModal: () => false,
    configurationEpoch: 1, config, closed: false, assistantRoleTabTargets: new Map(),
    key: (sceneId, panelId) => `${sceneId}:${panelId}`,
    createHash,
    async listAssistantPresets() { return [{ id: 'qa-review-bot', name: 'QA Review' }, { id: 'qa-review-bot', name: 'duplicate' }] },
    async resolveBinding(target) { return { ...target, roleId: scenes.find(scene => scene.id === target.sceneId)
      .panels.find(panel => panel.id === target.panelId).roleId, bindingStatus: 'bound', sessionId: `session:${target.panelId}` } },
  }
  vm.runInNewContext(controllerSource.slice(start, end), context)
  const result = await catalog({}, 'product-scene', 'product-chat')
  assert.deepEqual([...result].map(item => [item.roleId, item.label]), [
    ['center', '中心'], ['delivery', '交付助手'], ['custom-reviewer', '自定义审核助手'],
    [`assistant-preset-${createHash('sha256').update('qa-review-bot').digest('hex').slice(0, 24)}`, 'QA Review'],
  ])
  assert.equal(new Set(result.map(item => item.roleId)).size, result.length)
  assert.equal(new Set(result.map(item => item.panelId)).size, result.length)
  assert.equal(context.assistantRoleTabTargets.size, 4)
  const qaTab = [...result].at(-1)
  assert.equal(JSON.stringify(qaTab).includes('qa-review-bot'), false)
  assert.deepEqual({ kind: context.assistantRoleTabTargets.get(`product-scene:${qaTab.panelId}`).kind,
    presetId: context.assistantRoleTabTargets.get(`product-scene:${qaTab.panelId}`).presetId },
  { kind: 'preset', presetId: 'qa-review-bot' })
})

test('configured role tabs remain available when the optional DSH preset roster fails', async () => {
  const start = controllerSource.indexOf("      bind('assistantTabCatalog', async (event, hostSceneId, hostPanelId) => {")
  const end = controllerSource.indexOf("\n      bind('create', async (event, sceneId, panelId) => {", start)
  assert.ok(start >= 0 && end > start)
  let catalog
  const window = {}, scenes = [{ id: 'product-scene', panels: [{ id: 'product-chat', type: 'native-chat', roleId: 'product' }] }]
  const context = { bind(name, handler) { assert.equal(name, 'assistantTabCatalog'); catalog = handler },
    assertWindow: () => window, scene: id => scenes.find(item => item.id === id), windows: new Map([['product-scene', window]]),
    hasNativeModal: () => false, configurationEpoch: 1, config: { roles: [
      { id: 'product', label: '商品助手' }, { id: 'custom-reviewer', label: '自定义审核助手' },
    ], scenes }, closed: false, assistantRoleTabTargets: new Map(), key: (sceneId, panelId) => `${sceneId}:${panelId}`, createHash,
    async listAssistantPresets() { throw new Error('optional roster unavailable') },
  }
  vm.runInNewContext(controllerSource.slice(start, end), context)
  const result = await catalog({}, 'product-scene', 'product-chat')
  assert.deepEqual([...result].map(item => [item.roleId, item.label]), [['custom-reviewer', '自定义审核助手']])
  assert.equal(context.assistantRoleTabTargets.size, 1)
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
  const header = new Element('header')
  header.className = 'panel-header'
  const content = new Element('main')
  content.className = 'panel-content'
  panel.append(header, content)
  const note = new Element('div')
  const record = { panel, content, note, revision: 1, uiSceneId: 'product-scene', disposed: false,
    assistantTabs: { sceneId: 'product-scene', hostPanelId: 'product-chat', fixedRoleId: 'product', fixedLabel: '商品助手',
      fixedTarget: { sceneId: 'product-scene', panelId: 'product-chat', roleId: 'product' }, activeRoleId: 'product',
      tabs: new Map(), switchGeneration: 0, chooserGeneration: 0 } }
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
  assert.equal(header.focused, true)
  assert.equal(listeners.size, 0)
})
