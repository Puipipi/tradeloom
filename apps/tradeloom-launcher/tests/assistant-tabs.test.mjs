import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { runInNewContext } from 'node:vm'
import { createSourceShellController } from '../stage5-source06/asar/lib/tradeloom-source-shell/source-shell-controller.mjs'

const adapterPath = new URL('../stage5-source06/asar/renderer/source-shell/replica-ui/replica-adapter.js', import.meta.url)
const interactionsPath = new URL('../stage5-source06/asar/renderer/source-shell/replica-ui/panel-interactions.js', import.meta.url)

function extractFunction(source, start, end, name, context) {
  const from = source.indexOf(start), to = source.indexOf(end, from)
  assert.ok(from >= 0 && to > from, `${name} source boundary exists`)
  runInNewContext(`${source.slice(from, to)}\nglobalThis.__fn = ${name}`, context)
  return context.__fn
}

class FakeElement {
  constructor(tagName) { this.tagName = tagName; this.children = []; this.attributes = {}; this.listeners = {}; this.textContent = '' }
  setAttribute(name, value) { this.attributes[name] = value }
  append(...children) { this.children.push(...children) }
  replaceChildren(...children) { this.children = children }
  addEventListener(name, callback) { this.listeners[name] = callback }
}

class FakeWebContents extends EventEmitter {
  static nextId = 1
  constructor(url) { super(); this.id = FakeWebContents.nextId++; this.mainFrame = { url }; this.dead = false; this.sent = [] }
  isDestroyed() { return this.dead }
  setWindowOpenHandler(handler) { this.windowOpenHandler = handler }
  setZoomFactor() {}
  getZoomFactor() { return 1 }
  send(channel, ...args) { this.sent.push({ channel, args }) }
  loadURL(url) { this.mainFrame = { url }; return Promise.resolve() }
  destroy() { if (this.dead) return; this.dead = true; this.emit('destroyed') }
}

class FakeWindow extends EventEmitter {
  static instances = []
  constructor() {
    super(); this.id = FakeWebContents.nextId++; this.dead = false
    this.focusCount = 0; this.showCount = 0; FakeWindow.instances.push(this)
    this.webContents = new FakeWebContents('dsh-app://app/source-shell/renderer/source-entry.html')
    this.contentView = { addChildView() {}, removeChildView() {} }
  }
  isDestroyed() { return this.dead }
  getContentBounds() { return { x: 0, y: 0, width: 1280, height: 800 } }
  setTitleBarOverlay() {}
  show() { this.showCount++ }
  showInactive() { this.showCount++ }
  hide() { this.hidden = true }
  focus() { this.focusCount++ }
  destroy() { if (this.dead) return; this.dead = true; this.webContents.destroy(); this.emit('closed') }
  close() { this.destroy() }
}

class FakeWebContentsView {
  static instances = []
  constructor() {
    this.visible = false; this.bounds = { x: 0, y: 0, width: 640, height: 480 }
    this.webContents = new FakeWebContents('about:blank'); FakeWebContentsView.instances.push(this)
  }
  setVisible(value) { this.visible = value }
  setBounds(value) { this.bounds = value }
  getBounds() { return this.bounds }
}

async function createHarness({ workflow = false, erpNext = false, assistantPresets = [], createAssistantSession, openErpNextWorkbench } = {}) {
  FakeWebContentsView.instances.length = 0
  FakeWindow.instances.length = 0
  const handlers = new Map(), main = new FakeWindow()
  const scenes = [
    { id: 'products', roleId: 'product', panels: [{ id: 'product-chat', type: 'native-chat', roleId: 'product' }] },
    { id: 'delivery', roleId: 'delivery', panels: [{ id: 'delivery-chat', type: 'native-chat', roleId: 'delivery' }] },
    { id: 'center', roleId: 'center', panels: [{ id: 'center-chat', type: 'native-chat', roleId: 'center' }] },
  ]
  if (workflow) scenes.push({ id: 'agent-center', panels: [{ id: 'business-main', type: 'canvas' }] })
  if (erpNext) scenes.push({ id: 'erpnext', panels: [{ id: 'business-main', type: 'erpnext-status' }] })
  const config = { scenes, roles: scenes.filter(scene => scene.roleId).map(scene => ({ id: scene.roleId, label: `${scene.roleId} 助手` })), ...(workflow ? { businessRoutes: { '/agent-center': { sceneId: 'agent-center', panelId: 'business-main' } } } : {}) }
  const controller = createSourceShellController({
    BrowserWindow: FakeWindow, WebContentsView: FakeWebContentsView,
    ipcMain: { handle(channel, handler) { handlers.set(channel, handler) }, removeHandler(channel) { handlers.delete(channel) } },
    appPreload: 'fixture-app-preload.cjs', sourcePreload: 'fixture-source-preload.cjs', ownedPartition: 'persist:assistant-tabs-test',
    getConfig: async () => config,
    openErpNextWorkbench: openErpNextWorkbench ?? (async () => ({ opened: true })),
    listAssistantPresets: async () => assistantPresets,
    createAssistantSession: createAssistantSession ?? (async () => ({ sessionId: 'preset-session', bindingRevision: '0' })),
    resolveBinding: async ({ sceneId, panelId }) => ({
      sceneId, panelId, roleId: scenes.find(scene => scene.id === sceneId)?.panels.find(panel => panel.id === panelId)?.roleId,
      bindingStatus: 'bound', sessionId: `${sceneId}:${panelId}:session`, bindingRevision: '1',
    }),
    installProtocol: async () => {}, primaryWindow: main,
    resolveNativeTheme: () => 'light', subscribeNativeTheme: () => () => {},
    saveConfig: async () => {}, loadUiScale: async () => 1, saveUiScale: async () => {},
    loadSceneOrder: async () => ({ saved: false, ids: [] }), saveSceneOrder: async () => {},
    writeUi18Diagnostic: async () => {},
  })
  const started = controller.start()
  await new Promise(resolveTurn => setImmediate(resolveTurn))
  const mainEvent = { sender: main.webContents, senderFrame: main.webContents.mainFrame }
  const paintReady = handlers.get('source-shell:initialPaintReady')
  assert.equal(typeof paintReady, 'function')
  for (const stage of ['caption', 'scene', 'theme', 'layout', 'paint']) await paintReady(mainEvent, { status: 'progress', stage })
  await paintReady(mainEvent, { status: 'ready' })
  await started
  return { controller, handlers, main, mainEvent, destroy: () => controller.destroy() }
}

test('scene-less assistant preset creates a lazy native surface marked for exact-session retention', async t => {
  const harness = await createHarness({ assistantPresets: [{ id: 'qa-only-custom', name: 'QA 自定义助手' }] })
  t.after(harness.destroy)
  const choices = await harness.handlers.get('source-shell:assistantTabCatalog')(harness.mainEvent, 'delivery', 'delivery-chat')
  const target = choices.find(choice => choice.label === 'QA 自定义助手')
  assert.ok(target, 'preset without a scene-bound role is available in the assistant picker')
  const created = await harness.handlers.get('source-shell:create')(harness.mainEvent, 'delivery', target.panelId)
  assert.notEqual(created.status, 'owned-elsewhere')
  const view = FakeWebContentsView.instances.at(-1)
  const descriptor = harness.controller.nativeDescriptor(view.webContents, view.webContents.mainFrame)
  assert.equal(descriptor.assistantPreset, true)
  assert.equal(descriptor.sessionId, 'preset-session')
  assert.equal(descriptor.sceneId, 'delivery', 'the view keeps its current UI seat')
  assert.equal(descriptor.panelId, target.panelId)
})

test('ERPNext workbench opens only through trusted status lookup and repeated scene opens focus its window', async t => {
  const requests = []
  const harness = await createHarness({ erpNext: true, openErpNextWorkbench: async (...args) => { requests.push(args); return { opened: true } } })
  t.after(harness.destroy)
  const setActiveScene = harness.handlers.get('source-shell:setActiveScene')
  const openWorkbench = harness.handlers.get('source-shell:openErpNextWorkbench')
  const detach = harness.handlers.get('source-shell:detach')
  await setActiveScene(harness.mainEvent, 'erpnext')
  await openWorkbench(harness.mainEvent)
  assert.deepEqual(requests, [[]], 'the trusted Main operation receives no renderer URL')
  await setActiveScene(harness.mainEvent, 'products')
  await assert.rejects(openWorkbench(harness.mainEvent), /owner rejected/u, 'a non ERP active scene cannot open ERPNext')

  await setActiveScene(harness.mainEvent, 'erpnext')
  await detach(harness.mainEvent, 'erpnext')
  const child = FakeWindow.instances.at(-1)
  const childEvent = { sender: child.webContents, senderFrame: child.webContents.mainFrame }
  await openWorkbench(childEvent)
  assert.deepEqual(requests, [[], []])
  const focusBefore = child.focusCount
  assert.equal((await detach(harness.mainEvent, 'erpnext')).status, 'focused')
  assert.ok(child.focusCount > focusBefore, 'repeated launch focuses the existing ERPNext window')
})

test('scene-memory origin uses the verified configured binding seat while retaining the physical guest identity', async () => {
  const mainSource = await readFile(new URL('../stage5-source06/asar/lib/main.js', import.meta.url), 'utf8')
  const start = mainSource.indexOf('ipcMain.handle(DESKTOP_IPC.sceneMemoryOriginGrant, async (event, request) => {')
  const end = mainSource.indexOf('\n\tipcMain.handle(DESKTOP_IPC.', start)
  assert.ok(start >= 0 && end > start, 'production Main origin-grant handler exists')
  let handler, issued
  const frame = { url: 'dsh-app://app/' }
  const sender = { id: 90, mainFrame: frame, isDestroyed: () => false }
  const guest = { scope: 'role', generation: 4, sceneId: 'delivery', panelId: 'assistant-tab:delivery-chat:center',
    bindingSceneId: 'center', bindingPanelId: 'center-chat', sessionId: 'center-session', bindingRevision: '7' }
  const context = {
    ipcMain: { handle(_channel, fn) { handler = fn } },
    DESKTOP_IPC: { sceneMemoryOriginGrant: 'dsh-desktop:scene-memory-origin-grant' },
    assertDesktopSender() {}, sourceMode: true, sourceController: { resolveGuest: () => guest }, mainWindow: undefined,
    backend: { host: { issueSceneMemoryOriginGrant: async request => { issued = request; return { token: 'fixture' } } } },
    Buffer, Uint8Array, Number, Array, Object, Promise, Error,
    observeStartup() {},
  }
  runInNewContext(`(() => { ${mainSource.slice(start, end)} })()`, context)
  const request = { endpoint: 'session/list', httpMethod: 'POST', bodyBytes: new Uint8Array([1]) }
  assert.deepEqual(await handler({ sender, senderFrame: frame }, request), { token: 'fixture' })
  assert.equal(issued.source.sceneId, 'center')
  assert.equal(issued.source.panelId, 'center-chat')
  assert.equal(issued.source.sessionId, 'center-session')
})

test('custom assistant origin grants use only the selected live session and ordinary DSH authentication', async () => {
  const mainSource = await readFile(new URL('../stage5-source06/asar/lib/main.js', import.meta.url), 'utf8')
  const start = mainSource.indexOf('\tconst assistantPresetRequestTargets =')
  const end = mainSource.indexOf('\n\tipcMain.handle(DESKTOP_IPC.boot', start)
  assert.ok(start >= 0 && end > start, 'preset origin handler source exists')
  let handler, checked, guest
  const frame = { url: 'dsh-app://app/' }
  const sender = { id: 90, mainFrame: frame, isDestroyed: () => false }
  guest = { scope: 'role', generation: 8, sceneId: 'delivery', panelId: 'assistant-tab:delivery-chat:qa', sessionId: 'qa-session', assistantPreset: true, assistantPresetId: 'qa-custom' }
  const context = {
    ipcMain: { handle(_channel, fn) { handler = fn } },
    DESKTOP_IPC: { sceneMemoryOriginGrant: 'dsh-desktop:scene-memory-origin-grant' },
    assertDesktopSender() {}, sourceMode: true, sourceController: { resolveGuest: () => guest }, mainWindow: undefined,
    sourceRequest: async (path, body) => { checked = { path, body }; return { authorized: true } },
    backend: { host: {} }, Buffer, Uint8Array, Number, Array, Object, Promise, Error,
    observeStartup() {},
  }
  runInNewContext(`(() => { ${mainSource.slice(start, end)} })()`, context)
  const call = async (endpoint, payload) => handler({ sender, senderFrame: frame }, {
    endpoint, httpMethod: 'POST', bodyBytes: Buffer.from(JSON.stringify({ type: 'client-request', rpcId: 'qa', method: endpoint, payload })),
  })
  assert.equal(await call('session/follow', { address: { kind: 'session', sessionId: 'qa-session' }, assistantStream: true }), null)
  assert.equal(checked.path, '/tradeloom/assistant-presets/session-access')
  assert.equal(checked.body.presetId, 'qa-custom')
  assert.equal(checked.body.sessionId, 'qa-session')
  await assert.rejects(call('session/list', {}), /not bound to its selected session/)
  await assert.rejects(call('session/prompt', { sessionId: 'other-session', content: [{ type: 'text', text: 'x' }] }), /not bound to its selected session/)
  assert.equal(checked.body.sessionId, 'qa-session', 'rejected targets never reach the Host proof route')
})

test('assistant tabs resolve available roles and return the same session to each scene fixed panel', async t => {
  const harness = await createHarness()
  t.after(harness.destroy)
  const { controller, handlers, mainEvent } = harness
  const catalog = handlers.get('source-shell:assistantTabCatalog')
  const create = handlers.get('source-shell:create')
  const setVisible = handlers.get('source-shell:visible')
  const status = handlers.get('source-shell:status')
  assert.equal(typeof catalog, 'function')
  assert.equal(typeof create, 'function')

  for (const host of [
    { sceneId: 'products', panelId: 'product-chat', roleId: 'product' },
    { sceneId: 'delivery', panelId: 'delivery-chat', roleId: 'delivery' },
  ]) {
    const choices = await catalog(mainEvent, host.sceneId, host.panelId)
    assert.ok(choices.some(choice => choice.roleId === 'center'), 'right-click menu has the bound center assistant available')
    assert.ok(!choices.some(choice => choice.roleId === host.roleId), 'the current fixed assistant is not offered as a duplicate')
    const centerTab = choices.find(choice => choice.roleId === 'center')

    await create(mainEvent, host.sceneId, host.panelId)
    const ownFixed = controller.nativeDescriptor(FakeWebContentsView.instances.at(-1).webContents, FakeWebContentsView.instances.at(-1).webContents.mainFrame)
    assert.equal(ownFixed.roleId, host.roleId, 'scene fixed assistant mounts in its original panel')
    const ownFixedView = FakeWebContentsView.instances.at(-1)
    controller.nativeMounted(ownFixedView.webContents, ownFixedView.webContents.mainFrame, ownFixed)

    const tabResult = await create(mainEvent, host.sceneId, centerTab.panelId)
    assert.notEqual(tabResult.status, 'owned-elsewhere', 'new tab can take the bound assistant surface')
    const tabView = FakeWebContentsView.instances.find(view => controller.nativeDescriptor(view.webContents, view.webContents.mainFrame)?.roleId === 'center')
    assert.ok(tabView, 'new tab owns a real native assistant view')
    const tabDescriptor = controller.nativeDescriptor(tabView.webContents, tabView.webContents.mainFrame)
    assert.equal(tabDescriptor.sceneId, 'center', 'the guest receives its real configured scene identity')
    assert.equal(tabDescriptor.panelId, 'center-chat', 'the guest receives its real configured panel identity')
    const ownerIdentity = controller.resolveGuest(tabView.webContents, tabView.webContents.mainFrame)
    assert.equal(ownerIdentity.bindingSceneId, 'center', 'origin authority resolves the configured role binding seat')
    assert.equal(ownerIdentity.bindingPanelId, 'center-chat')
    const firstSession = tabDescriptor.sessionId
    controller.nativeMounted(tabView.webContents, tabView.webContents.mainFrame, tabDescriptor)
    assert.ok(harness.main.webContents.sent.some(event => event.channel === 'source-shell:status-event'
      && event.args[0]?.panelId === centerTab.panelId && event.args[0]?.status === 'context-mounted'),
    'Host mounted acknowledgement resolves to the dynamic UI control surface')
    const retainedFixed = controller.nativeDescriptor(ownFixedView.webContents, ownFixedView.webContents.mainFrame)
    assert.equal(retainedFixed.roleId, host.roleId, 'the original product or delivery assistant keeps its exact role')
    assert.equal(retainedFixed.sessionId, ownFixed.sessionId, 'adding a tab does not replace the fixed assistant session')
    assert.equal((await status(mainEvent, host.sceneId, host.panelId)).status, 'context-mounted', 'the fixed assistant remains usable while the added tab is selected')

    await setVisible(mainEvent, host.sceneId, centerTab.panelId, false)
    await create(mainEvent, 'center', 'center-chat')
    const fixedDescriptor = controller.nativeDescriptor(tabView.webContents, tabView.webContents.mainFrame)
    assert.equal(fixedDescriptor.sceneId, 'center', 'switching scenes returns the same conversation to its built-in assistant')
    assert.equal(fixedDescriptor.panelId, 'center-chat')
    assert.equal(fixedDescriptor.sessionId, firstSession, 'the existing conversation is retained')
    controller.nativeMounted(tabView.webContents, tabView.webContents.mainFrame, fixedDescriptor)
    assert.equal((await status(mainEvent, 'center', 'center-chat')).status, 'context-mounted', 'the built-in center assistant remains usable')

    await setVisible(mainEvent, 'center', 'center-chat', false)
    const reacquire = await create(mainEvent, host.sceneId, centerTab.panelId)
    assert.notEqual(reacquire.status, 'owned-elsewhere', 'selecting the added tab can reclaim the hidden session')
    const returnedDescriptor = controller.nativeDescriptor(tabView.webContents, tabView.webContents.mainFrame)
    assert.equal(returnedDescriptor.sceneId, 'center', 'reacquired guest identity remains the real configured scene')
    assert.equal(returnedDescriptor.panelId, 'center-chat', 'reacquired guest identity remains the real configured panel')
    assert.equal(returnedDescriptor.sessionId, firstSession)
    controller.nativeMounted(tabView.webContents, tabView.webContents.mainFrame, returnedDescriptor)
    assert.equal((await status(mainEvent, host.sceneId, centerTab.panelId)).status, 'context-mounted', 'the selected tab again controls the existing session')
    await setVisible(mainEvent, host.sceneId, centerTab.panelId, false)
    const stillAvailable = await catalog(mainEvent, host.sceneId, host.panelId)
    assert.ok(stillAvailable.some(choice => choice.roleId === 'center'), 'closing the tab leaves its assistant configuration available')
    assert.notEqual((await create(mainEvent, host.sceneId, centerTab.panelId)).status, 'owned-elsewhere', 'reopening the removed tab uses the retained conversation')
    assert.equal(controller.nativeDescriptor(tabView.webContents, tabView.webContents.mainFrame).sessionId, firstSession)
  }
})

test('workflow title bridge accepts the current account-scoped guest and only dispatches enabled fixed actions', async t => {
  const harness = await createHarness({ workflow: true })
  t.after(harness.destroy)
  const { controller, handlers, mainEvent, main } = harness
  await handlers.get('source-shell:accountCreate')(mainEvent)
  const mount = handlers.get('source-shell:workflowCanvasMount')
  const visible = handlers.get('source-shell:workflowCanvasVisible')
  const publish = handlers.get('source-shell:workflowCanvasToolbarState')
  const action = handlers.get('source-shell:workflowCanvasToolbarAction')
  assert.equal(typeof mount, 'function')
  const mounted = await mount(mainEvent)
  const guestView = FakeWebContentsView.instances.at(-1)
  const guest = guestView.webContents
  const descriptor = controller.nativeDescriptor(guest, guest.mainFrame)
  assert.equal(descriptor.kind, 'scene-component')
  assert.equal(descriptor.sceneId, 'agent-center')
  assert.equal(descriptor.panelId, 'business-main')
  assert.ok(Number.isSafeInteger(descriptor.accountGeneration), 'fixture uses the account-scoped descriptor shape from an active account')
  controller.nativeMounted(guest, guest.mainFrame, descriptor)
  await visible(mainEvent, true)
  assert.deepEqual(await publish({ sender: guest, senderFrame: guest.mainFrame }, {
    descriptor, canStart: true, canRefresh: true,
  }), { accepted: true, available: true })
  const status = main.webContents.sent.findLast(entry => entry.channel === 'source-shell:workflow-canvas-status')
  assert.deepEqual(status.args[0].toolbar, { canStart: true, canRefresh: true })
  assert.ok(guest.sent.some(entry => entry.channel === 'source-shell:workflow-canvas-toolbar-dock-state'
    && entry.args[0]?.available === true), 'guest receives the real docked header acknowledgement')
  assert.deepEqual(await handlers.get('source-shell:workflowCanvasStatus')(mainEvent), {
    status: 'context-mounted', visible: true, placement: 'docked', componentKey: 'workflow-canvas-native',
    sceneId: 'agent-center', panelId: 'business-main', toolbar: { canStart: true, canRefresh: true },
  })
  assert.deepEqual(await action(mainEvent, 'start'), { delivered: true })
  assert.equal(guest.sent.at(-1).channel, 'source-shell:workflow-canvas-toolbar-action')
  assert.equal(guest.sent.at(-1).args[0].action, 'start')
  await publish({ sender: guest, senderFrame: guest.mainFrame }, { descriptor, canStart: false, canRefresh: false })
  assert.throws(() => action(mainEvent, 'start'), /rejected/, 'disabled guest capability cannot be dispatched by the host')
  await publish({ sender: guest, senderFrame: guest.mainFrame }, { descriptor, canStart: true, canRefresh: true })
  assert.throws(() => action(mainEvent, 'execute'), /rejected/)
  assert.throws(() => publish({ sender: guest, senderFrame: { url: guest.mainFrame.url } }, {
    descriptor, canStart: true, canRefresh: true,
  }), /stale workflow canvas toolbar state/)
  await handlers.get('source-shell:workflowCanvasPopOut')(mainEvent)
  assert.equal(guest.sent.at(-1).args[0].available, false, 'popped out guest switches back to local header actions')
  await handlers.get('source-shell:workflowCanvasReturnToDock')(mainEvent)
  assert.equal(guest.sent.at(-1).args[0].available, true, 'returning guest restores the dock acknowledgement')
})

test('assistant tab UI keeps fixed tabs open and closes only the selected label', async () => {
  const source = await readFile(adapterPath, 'utf8')
  const controls = new FakeElement('div')
  const header = { inserted: undefined, querySelector: () => controls, insertBefore(element) { this.inserted = element } }
  const document = { createElement: tagName => new FakeElement(tagName) }
  const renderAssistantTabBar = extractFunction(source,
    '  function renderAssistantTabBar(group) {', '  function selectAssistantTab(group, roleId) {',
    'renderAssistantTabBar', { document })
  const group = {
    key: 'products\u0000product-chat', fixedRoleId: 'product', activeRoleId: 'center', fixedLabel: '商品助手',
    fixedRecord: { panel: { querySelector: () => header } },
    tabs: new Map([['center', { roleId: 'center', label: '中心助手' }], ['delivery', { roleId: 'delivery', label: '交付助手' }]]),
  }
  renderAssistantTabBar(group)
  assert.equal(header.inserted.children.length, 3, 'the fixed assistant and both added assistants render as tabs')
  assert.equal(header.inserted.children[0].children.length, 1, 'the built-in 商品助手 has no close button')
  assert.equal(header.inserted.children[1].children.length, 2, 'an added assistant has its own close button')

  const state = { assistantTabGroups: new Map([[group.key, group]]), roleSurfaces: new Map() }
  const closedRecord = { sceneId: 'products', panelId: 'assistant-tab:product-chat:center', assistantTabGroupKey: group.key, assistantTabRoleId: 'center' }
  state.roleSurfaces.set('products\u0000assistant-tab:product-chat:center', closedRecord)
  const selected = []
  const closeAssistantTab = extractFunction(source,
    '  function closeAssistantTab(group, roleId) {', '  async function ensureAssistantTabSurface(group, tab) {',
    'closeAssistantTab', {
      state, renderAssistantTabBar: () => {}, selectAssistantTab: (_group, roleId) => selected.push(roleId),
      roleSurfaceKey: (sceneId, panelId) => `${sceneId}\u0000${panelId}`, syncRoleSurface: () => {},
    })
  closeAssistantTab(group, 'center')
  assert.equal(group.tabs.has('center'), false, 'closing removes the added tab label')
  assert.equal(group.activeRoleId, 'delivery', 'closing the selected tab activates a remaining assistant')
  assert.deepEqual(selected, ['delivery'])
  assert.equal(group.fixedRoleId, 'product', 'the scene fixed role remains available')
  assert.equal(state.roleSurfaces.get('products\u0000assistant-tab:product-chat:center'), closedRecord,
    'closing does not delete the session surface')

  let reopenedRole
  const addAssistantRoleTab = extractFunction(source,
    '  function addAssistantRoleTab(group, option) {', '  async function openAssistantTabChooser(panel) {',
    'addAssistantRoleTab', { selectAssistantTab: (_group, roleId) => { reopenedRole = roleId } })
  addAssistantRoleTab(group, { roleId: 'center', panelId: 'assistant-tab:product-chat:center', label: '中心助手' })
  assert.equal(reopenedRole, 'center', 'the same retained assistant can be added again')
})

test('AI assistant right-click menu routes to the assistant chooser', async () => {
  const source = await readFile(interactionsPath, 'utf8')
  assert.match(source, /if \(panel\?\.classList\.contains\('panel-chat'\)\) entries\.unshift\(\{ label: '添加助手'/,
    'assistant panels add 添加助手 to their existing panel menu')
  const panel = { id: 'assistant-panel' }
  const header = { closest: selector => selector === '.panel' ? panel : null }
  const target = { closest: selector => selector === '.panel-header' ? header : null }
  let opened
  const onContextMenu = extractFunction(source,
    '  function onContextMenu(event) {', '  function onExistingExpandClick(event) {',
    'onContextMenu', { openMenu: (...args) => { opened = args } })
  const event = { target, clientX: 70, clientY: 80, preventDefault() { this.defaultPrevented = true }, stopPropagation() { this.stopped = true } }
  onContextMenu(event)
  assert.equal(event.defaultPrevented, true)
  assert.equal(event.stopped, true)
  assert.equal(opened[1], panel, 'right-clicking the assistant header opens its panel menu')

  const ownerPanel = {}
  let chooserPanel
  const activateMenuEntry = extractFunction(source,
    '  function activateMenuEntry(entry, item) {', '  function openMenu(anchor, panel, options = {}) {',
    'activateMenuEntry', { window: { businessBridge: { openAssistantTabChooser: panel => { chooserPanel = panel } } }, menu: { panel: ownerPanel }, closeMenu() {}, announce() {} })
  activateMenuEntry({ label: '添加助手' }, { getBoundingClientRect: () => ({}) })
  assert.equal(chooserPanel, ownerPanel, 'the menu routes to the existing panel-owned assistant chooser')
})


test('workflow node auxiliary window preserves hidden drafts and retires with its canvas owner', async t => {
  const harness = await createHarness({ workflow: true })
  t.after(harness.destroy)
  const { controller, handlers, mainEvent, main } = harness
  await handlers.get('source-shell:workflowCanvasMount')(mainEvent)
  const view = FakeWebContentsView.instances.at(-1), contents = view.webContents
  controller.nativeMounted(contents, contents.mainFrame, controller.nativeDescriptor(contents, contents.mainFrame))
  const open = contents.windowOpenHandler
  const request = { url: 'about:blank', frameName: 'tradeloom-workflow-node-editor' }
  assert.equal(open(request).action, 'deny', 'hidden canvas cannot open a window')
  await handlers.get('source-shell:workflowCanvasVisible')(mainEvent, true)
  assert.equal(open({ ...request, url: 'https://example.com' }).action, 'deny')
  assert.equal(open({ ...request, frameName: 'other' }).action, 'deny')
  const allowed = open(request)
  assert.equal(allowed.action, 'allow')
  assert.equal(allowed.overrideBrowserWindowOptions.parent, main)
  assert.equal(allowed.overrideBrowserWindowOptions.modal, false)
  const child = new FakeWindow()
  contents.emit('did-create-window', child, request)
  assert.equal(child.webContents.windowOpenHandler(request).action, 'deny')
  await handlers.get('source-shell:workflowCanvasVisible')(mainEvent, false)
  assert.equal(child.isDestroyed(), false, 'temporary native occlusion preserves the editor draft')
  assert.equal(child.hidden, true)
  await handlers.get('source-shell:workflowCanvasVisible')(mainEvent, true)
  assert.ok(child.showCount > 0)
  open(request)
  const second = new FakeWindow()
  contents.emit('did-create-window', second, request)
  await handlers.get('source-shell:workflowCanvasPopOut')(mainEvent)
  assert.equal(second.isDestroyed(), true, 'canvas owner migration retires the prior auxiliary window')
  assert.equal(open(request).action, 'allow', 'detached canvas keeps the same bounded capability')
  const third = new FakeWindow()
  contents.emit('did-create-window', third, request)
  harness.destroy()
  assert.equal(third.isDestroyed(), true)
  assert.equal(open(request).action, 'deny', 'disposed canvas no longer authorizes windows')
})
