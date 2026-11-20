import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'
import { createHash } from 'node:crypto'
import { pathToFileURL } from 'node:url'

const root = process.env.TL_UI_SOURCE_ROOT ? pathToFileURL(process.env.TL_UI_SOURCE_ROOT.replace(/[\\/]$/, '') + '/') : new URL('../', import.meta.url)
const descriptor = { kind: 'role', surface: 'chat', sceneId: 'synthetic-scene', panelId: 'synthetic-panel', roleId: 'center', sessionId: 'synthetic-session', bindingRevision: '4', generation: 2 }

// Controlled React hooks and DOM only; execute real production modules. No
// actual storage, device, website, model request or GUI acceptance is claimed.
async function mount(file, options = {}) {
  const expected = options.expected ?? descriptor
  let definition, current = { ...expected }, cursor = 0, callback
  const states = [], refs = [], effects = [], pending = [], releases = [], slots = [], intents = new Set(), flushResults = []
  const React = {
    Fragment: Symbol.for('fragment'), createElement(type, props, ...children) { return { type, props: { ...props, children } } },
    useState(initial) { const i = cursor++; if (!(i in states)) states[i] = initial; return [states[i], value => { states[i] = typeof value === 'function' ? value(states[i]) : value }] },
    useRef(initial) { const i = cursor++; if (!(i in refs)) refs[i] = { current: initial }; return refs[i] },
    useEffect(effect, deps) { const i = cursor++, old = effects[i]; if (!old || deps === undefined || deps.some((value, n) => value !== old[n])) { effects[i] = deps; pending.push(effect) } },
  }
  const source = await readFile(new URL(file, root), 'utf8')
  vm.runInNewContext(source, { window: { __ModuleLoader__: { load(value) { definition = value } } }, AbortController, TextEncoder, crypto: globalThis.crypto, console, setTimeout, clearTimeout }, { filename: file })
  const exports = definition.factory(name => name === 'react' ? React : assert.fail('unexpected dependency: ' + name))
  const ctx = { slots: { inject(_name, register) { return register() }, register(options, Component) { slots.push({ options, Component }); return () => {} } } }
  const bridge = { nativeSurfaceDescriptor: async () => current, onNativeSurfaceChanged() { return () => {} },
    onNativeUtilityRequested(listener) { intents.add(listener); return () => intents.delete(listener) },
    onSceneDraftFlushRequested(listener) { callback = listener; return () => { callback = undefined } },
    sceneDraftFlushResult: async receipt => { flushResults.push(receipt) }, ...options.bridge }
  const stop = await exports.register(ctx, { ...expected }, bridge)
  let saves = 0, rejectSave = false
  const props = { sessionId: options.slotSession ?? expected.sessionId, locked: false, inputActions: { persistDraft() {}, async persistDraftVerified(sessionId) { saves++; if (rejectSave) throw Error('controlled persistence failure'); return { persisted: true, sessionId, draftRevision: 1 } } } }
  function render(slot) { cursor = 0; let node = slot.Component(props); while (node && typeof node.type === 'function') node = node.type(node.props); return node }
  const nodes = slots.map(render)
  for (const effect of pending.splice(0)) { const release = effect(); if (typeof release === 'function') releases.push(release) }
  return { slots, nodes, flushResults, get saves() { return saves }, failSave() { rejectSave = true },
    async flush() { assert.equal(typeof callback, 'function'); await callback({ descriptor: { ...expected }, requestId: 'synthetic-flush' }) },
    change(value) { current = value }, render() { return slots.map(render) }, get subscriptions() { return intents.size },
    async receive(intent) { for (const listener of intents) listener(intent); for (let n = 0; n < 12; n++) await Promise.resolve() },
    async dispose() { for (const release of releases.reverse()) release(); if (typeof stop === 'function') await stop(); assert.equal(intents.size, 0) } }
}
function visible(node) { if (node == null || node === false) return []; if (Array.isArray(node)) return node.flatMap(visible); if (node.type === Symbol.for('fragment')) return visible(node.props.children); return [node] }

test('own extensions add zero default DOM and retain the actual native composer', async () => {
  for (const file of ['client.scene-memory.js', 'client.scene-drafts.js', 'client.session-audio.js', 'client.mcp-runtime.js', 'client.webai-files.js']) {
    const view = await mount(file)
    assert.deepEqual(view.nodes.flatMap(visible), [], file)
    for (const slot of view.slots) assert.equal(slot.options.name, 'conversation.composer.dock', 'headless consumer remains in its real embedded scope')
    await view.dispose()
  }
  const native = await readFile(new URL('client.source-native.js', root), 'utf8')
  assert.ok(native.includes("renderFactorySlot('conversation.content',{variant:'embedded',phase:'active',hero:false})"))
  assert.ok(native.includes('h(SessionProvider,'))
  new vm.Script(native)
})

test('real slot session mismatch and stale full binding reject UI intents; subscriptions dispose', async () => {
  for (const file of ['client.scene-memory.js', 'client.session-audio.js', 'client.webai-files.js']) {
    const mismatch = await mount(file, { slotSession: 'other-session' }); assert.equal(mismatch.subscriptions, 0); await mismatch.dispose()
    const view = await mount(file); assert.equal(view.subscriptions, 1)
    view.change({ ...descriptor, bindingRevision: '5' })
    for (const action of ['scene-memory', 'task-directory', 'session-speech']) await view.receive({ action, descriptor })
    assert.deepEqual(view.render().flatMap(visible), []); await view.dispose()
  }
})

test('headless checked draft flush acknowledges only confirmed persistence', async () => {
  const view = await mount('client.scene-drafts.js'); assert.deepEqual(view.nodes.flatMap(visible), [])
  await view.flush(); assert.equal(view.saves, 1); assert.equal(view.flushResults.at(-1).saved, true)
  view.failSave(); await view.flush(); assert.equal(view.flushResults.at(-1).saved, false); await view.dispose()
})

const integration = process.env.TL_SEVEN_DESKTOP_INPUTS && process.env.TL_SEVEN_SDK_RUNTIME && process.env.TL_SEVEN_TEST_ROOT
test('actual source-entry/header menu/parent bridge/preload/controller/guest checked action are connected', {
  skip: integration ? false : 'explicit pinned desktop/rc2 SDK and owned synthetic root required; not GUI acceptance',
}, async t => {
  const { sourceRoleIdentity: createSourceRoleProducer } = await import(new URL('tests/fixtures/source-role-identity.mjs', root))
  const producer = await createSourceRoleProducer(t), expected = await producer.descriptor()
  await producer.bridge.nativeSurfaceMounted(expected)
  const inputs = JSON.parse(await readFile(process.env.TL_SEVEN_DESKTOP_INPUTS, 'utf8'))
  async function source(row) { const data = await readFile(row.path); assert.equal(data.length, row.bytes); assert.equal(createHash('sha256').update(data).digest('hex'), row.sha256); return data.toString('utf8') }
  const parentPreload = await source(inputs.uiRelay.parentPreload), parentCode = await source(inputs.uiRelay.parentBridge), menuCode = await source(inputs.uiRelay.parentMenu), html = await source(inputs.uiRelay.sourceEntry)
  for (const script of ['business-bridge.js', 'renderer.js', 'panel-interactions.js']) assert.ok(html.includes(`src="replica-ui/${script}"`))
  const parentEvent = { sender: producer.primary.webContents, senderFrame: producer.primary.webContents.mainFrame }
  let app
  const invocationErrors = []
  vm.runInNewContext(parentPreload, { require(name) { assert.equal(name, 'electron'); return { contextBridge: { exposeInMainWorld(name, value) { assert.equal(name, 'app'); app = value } }, ipcRenderer: { invoke: async (channel, ...args) => { try { return await producer.handlers.get(channel)(parentEvent, ...args) } catch (error) { invocationErrors.push({ name: error.name, message: error.message }); throw error } } } } } })
  const guestPreload = await source(inputs.preload), a = guestPreload.indexOf('onNativeUtilityRequested(listener) {'), b = guestPreload.indexOf('\nonNativeSurfaceChanged(listener)', a)
  assert.ok(a > 0 && b > a)
  const guestListener = new Function('electron', `return ({${guestPreload.slice(a, b)}})` )({ ipcRenderer: producer.view().webContents.renderer })
  const child = await mount('client.scene-memory.js', { expected, bridge: { ...producer.bridge, ...guestListener } }); t.after(() => child.dispose())
  assert.deepEqual(child.nodes.flatMap(visible), [])
  const panel = { isConnected: true, dataset: { panelId: 'synthetic-visible-panel' }, closest() { return {} }, querySelector() { return null } }
  const record = { panel, content: { isConnected: true }, created: true, target: { sceneId: producer.sceneId, panelId: producer.panelId }, revision: 1, uiSceneId: 'synthetic-ui' }, state = { roleRecord: record, sceneId: record.uiSceneId, sceneRevision: 1 }
  const section = (code, begin, finish) => { const a = code.indexOf(begin), b = code.indexOf(finish, a + begin.length); assert.ok(a >= 0 && b > a, begin); return code.slice(a, b) }
  const bridgeFunctions = section(parentCode, '  function isCurrentRole(record)', '\n  function nativePaneVisible') + section(parentCode, '  function panelMenuCapabilities(panel)', '\n  async function requestNativeUtility') + section(parentCode, '  async function requestNativeUtility(panel, action)', '\n  async function requestPanelPlacement')
  const business = new Function('state', 'app', bridgeFunctions + ';return {panelMenuCapabilities,requestNativeUtility}')(state, app)
  const menuFunctions = section(menuCode, '  const ACTIONS = [', '\n  const states =') + '\n' + section(menuCode, '  function closeMenu()', '\n  function onOutsideMenu') + '\n' + section(menuCode, '  function activateMenuEntry(', '\n  function setFullscreenButton') + '\n' + section(menuCode, '  function onContextMenu(', '\n  function onExistingExpandClick')
  class Element {
    constructor(tag) { this.tag = tag; this.children = []; this.handlers = {}; this.style = {}; this.offsetHeight = 100; this.offsetWidth = 100 }
    append(child) { this.children.push(child) } setAttribute() {} addEventListener(type, fn) { this.handlers[type] = fn }
    getBoundingClientRect() { return { left: 10, right: 20, bottom: 20 } } querySelector() { return this.children.find(child => child.tag === 'button') }
    focus() {} showPopover() {} hidePopover() {} remove() { this.removed = true }
  }
  const body = new Element('body'), document = { body, createElement: tag => new Element(tag), addEventListener() {}, removeEventListener() {}, querySelectorAll: () => body.children.filter(item => !item.removed) }
  let delivery
  const observedBusiness = { ...business, requestNativeUtility(...args) { delivery = business.requestNativeUtility(...args); return delivery } }
  const notices = [], window = { businessBridge: observedBusiness, innerWidth: 1000, innerHeight: 800, addEventListener() {}, removeEventListener() {} }
  const menu = new Function('window', 'document', 'sceneKeyFor', 'restoreEntries', 'announce', `let menu;const onOutsideMenu=()=>{},onMenuKey=()=>{};${menuFunctions};return {onContextMenu}`)(window, document, () => record.uiSceneId, () => [], message => notices.push(message))
  const header = { closest: name => name === '.panel' ? panel : null, setAttribute() {} }
  menu.onContextMenu({ target: { closest: name => name === '.panel-header' ? header : null }, clientX: 10, clientY: 10, preventDefault() {}, stopPropagation() {} })
  const items = body.children.at(-1).children
  for (const label of ['场景记忆', '任务目录', '回复朗读控制']) assert.ok(items.some(item => item.textContent === label))
  items.find(item => item.textContent === '场景记忆').handlers.click()
  assert.ok(delivery instanceof Promise)
  const deliveredResult = await delivery
  await new Promise(setImmediate)
  t.diagnostic(JSON.stringify({ deliveredResult, invocationErrors, notices, deliveredPackets: producer.view().webContents.messages.filter(item => item.channel === 'dsh-desktop:native-utility-request').length }))
  assert.ok(visible(child.render()).some(node => node.type === 'dialog'), 'actual parent menu click reaches the actual guest action')
  const delivered = producer.view().webContents.messages.filter(item => item.channel === 'dsh-desktop:native-utility-request')
  assert.equal(delivered.length, 1); assert.equal(delivered[0].args[0].descriptor.roleId, expected.roleId); assert.equal(notices.length, 0)
  const invoke = producer.handlers.get('source-shell:nativeUtility'), request = { sceneId: producer.sceneId, panelId: producer.panelId, action: 'scene-memory' }
  await assert.rejects(invoke({ ...parentEvent, senderFrame: { ...parentEvent.senderFrame } }, request), /rejected sender/)
  await assert.rejects(invoke(parentEvent, { ...request, roleId: 'forged' }), /invalid native utility/)
  await assert.rejects(invoke(parentEvent, { ...request, panelId: 'wrong-panel' }), /target unavailable/)
  await producer.rotateSameSession(); await assert.rejects(invoke(parentEvent, request), /target unavailable/)
  assert.equal(producer.view().webContents.messages.filter(item => item.channel === 'dsh-desktop:native-utility-request').length, 1)
})
