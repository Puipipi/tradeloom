import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { EventEmitter } from 'node:events'
import path from 'node:path'
import { sourceRoleIdentity } from './fixtures/source-role-identity.mjs'

const capability = '--tradeloom-account-parent-caption'
const root = process.env.TL_NATIVE_CAPTION_DESKTOP_ROOT
const pin = data => ({ bytes: data.length, sha256: createHash('sha256').update(data).digest('hex') })
const recipe = JSON.parse(await readFile(new URL('../../../apps/tradeloom-launcher/dsh-upgrades/0.2.2-rc.2/desktop-recipe.json', import.meta.url), 'utf8'))
async function actual(entry) {
  assert.ok(root, 'explicit pinned final desktop postimages required')
  const bytes = await readFile(path.join(root, entry))
  assert.deepEqual(pin(bytes), recipe.finalOverlay.postimages[entry])
  return bytes.toString('utf8').replace(/\r\n/g, '\n')
}

async function accountCreator() {
  const source = await actual('lib/tradeloom-source-shell/source-shell-controller.mjs')
  const begin = source.indexOf("      bind('accountCreate',async event=>{"), end = source.indexOf("      bind('accountBounds'", begin)
  const assertBegin = source.indexOf('  const assertWindow = event => {'), assertEnd = source.indexOf('  const assertThemeWindow', assertBegin)
  assert.ok(begin > 0 && end > begin && assertBegin > 0 && assertEnd > assertBegin)
  const created = [], main = new EventEmitter()
  main.webContents = { mainFrame: { url: 'controlled-source-document' } }
  main.contentView = { children: [], addChildView(view) { this.children.push(view) } }
  class Contents extends EventEmitter {
    constructor() { super(); this.mainFrame = { url: 'about:blank' } }
    setZoomFactor() {}
    async loadURL(url) { this.mainFrame.url = url; this.emit('did-finish-load') }
    destroy() { this.emit('destroyed') }
  }
  class View {
    constructor(options) { this.options = options; this.webContents = new Contents(); created.push(this) }
    setVisible(value) { this.visible = value }
  }
  // Actual sender/frame map fence and actual accountCreate callback execute.
  // Electron, document loading, notification persistence and the outer window
  // are controlled; this is not a real native-window or GUI acceptance test.
  const factory = new Function('main', 'WebContentsView', `
    const windows=new Map([['main',main]]),rolePopouts=new Map(),SOURCE_URL='controlled-source-document',ACCOUNT_URL='controlled-account-document';
    let accountPopout,account,accountCreating,generation=0;
    const appPreload='controlled-app-preload',ownedPartition='persist:controlled-account',uiScale=1;
    const focusedGuests=new Map(),handlers=new Map(),bind=(name,fn)=>handlers.set(name,fn);
    const updateOwnership=()=>{},attachAccountShortcuts=undefined,emitAccount=()=>{},revokeAccount=()=>{},accountStatusValue=item=>({kind:item.kind,generation:item.generation});
    ${source.slice(assertBegin, assertEnd)}
    ${source.slice(begin, end)}
    return {handlers,account:()=>account};
  `)(main, View)
  const event = { sender: main.webContents, senderFrame: main.webContents.mainFrame }
  return { ...factory, event, created, main }
}

async function appearance(argv, pageReportedKind) {
  const source = await actual('lib/preload-app.cjs')
  const begin = source.indexOf('function syncWindowsAppearance() {'), end = source.indexOf('\n//#endregion', begin)
  assert.ok(begin > 0 && end > begin)
  const events = new Map(), properties = new Map(), sent = [], observers = []
  const portal = { identity: 'existing-native-body-portal', style: {} }
  const document = {
    readyState: 'loading',
    documentElement: { lang: 'zh-CN', dataset: { pageReportedKind }, style: { setProperty: (name, value) => properties.set(name, value) } },
    body: { children: [portal], append(node) { this.children.push(node) } },
    head: { addEventListener() {}, removeEventListener() {} },
    createElement(tag) {
      if (tag === 'canvas') return { getContext: () => ({ clearRect() {}, fillRect() {}, getImageData: () => ({ data: [0, 0, 0, 255] }) }) }
      const node = { style: {}, remove() { document.body.children.splice(document.body.children.indexOf(node), 1) } }
      return node
    },
  }
  const window = { addEventListener: (name, fn) => events.set(name, fn) }
  let menus = 0, updates = 0, disposals = 0
  class Observer { constructor(fn) { this.fn = fn; observers.push(this) } observe() {} disconnect() {} }
  const run = new Function('document', 'window', 'process', 'installWindowsMenu', 'MutationObserver', 'getComputedStyle', 'electron', 'DESKTOP_IPC', `${source.slice(begin, end)};syncWindowsAppearance();`)
  run(document, window, { platform: 'win32', argv }, () => { menus++; return { update() { updates++ }, dispose() { disposals++ } } }, Observer,
    () => ({ backgroundColor: '#000000', color: '#ffffff' }), { ipcRenderer: { send: (...args) => sent.push(args) } }, { windowsAppearance: 'appearance' })
  const beforeReady = { marker: Object.hasOwn(document.documentElement.dataset, 'windowsTitlebar'), clearance: properties.get('--dsh-windows-titlebar-height') }
  events.get('DOMContentLoaded')?.()
  return { document, properties, portal, beforeReady, sent, observers, events, counts: () => ({ menus, updates, disposals }) }
}

test('actual Main account creation owns early caption capability; its preload adds no inner row or 40px clearance', async () => {
  const f = await accountCreator()
  await assert.rejects(f.handlers.get('accountCreate')({ sender: {}, senderFrame: { url: 'controlled-source-document' } }), /rejected sender/)
  assert.equal(f.created.length, 0)
  await f.handlers.get('accountCreate')(f.event)
  assert.equal(f.account().kind, 'account')
  const preferences = f.created[0].options.webPreferences
  assert.ok(preferences.additionalArguments?.includes(capability), 'real Main account constructor must supply the capability')
  assert.equal(preferences.preload, 'controlled-app-preload')
  assert.equal(preferences.contextIsolation, true); assert.equal(preferences.sandbox, true); assert.equal(preferences.nodeIntegration, false)
  const a = await appearance(preferences.additionalArguments)
  assert.deepEqual(a.beforeReady, { marker: false, clearance: undefined }, 'no first-paint inner caption clearance')
  assert.equal(Object.hasOwn(a.document.documentElement.dataset, 'windowsTitlebar'), false)
  assert.equal(a.properties.has('--dsh-windows-titlebar-height'), false)
  assert.equal(a.counts().menus, 0)
  assert.equal(a.document.body.children[0], a.portal); assert.deepEqual(a.portal.style, {})
  assert.equal(a.sent.length, 1, 'outer caption palette/locale observation is retained')
  a.document.documentElement.lang = 'en'; a.observers[0].fn()
  assert.equal(a.sent.at(-1)[1], 'en')
  a.events.get('pagehide')(); assert.equal(a.document.body.children.length, 1); assert.equal(a.counts().disposals, 0)
  assert.equal(f.main.contentView.children[0], f.created[0], 'existing account view and outer window remain owned')
})

test('non-account preload retains original caption/menu even if page claims account; body portals are untouched', async () => {
  const a = await appearance([], 'account')
  assert.deepEqual(a.beforeReady, { marker: true, clearance: '40px' })
  assert.equal(a.counts().menus, 1); assert.equal(a.counts().updates, 1)
  assert.equal(a.document.body.children[0], a.portal); assert.deepEqual(a.portal.style, {})
  a.events.get('pagehide')(); assert.equal(a.counts().disposals, 1); assert.equal(a.document.body.children.length, 1)
})

test('actual trusted role create and pop-out retain the parent-caption capability without replacing the native view', async t => {
  const f = await sourceRoleIdentity(t)
  const view = f.view(), preferences = view.options.webPreferences
  assert.ok(preferences.additionalArguments?.includes(capability), 'actual owner-checked role constructor must supply the capability')
  assert.equal(preferences.preload, 'controlled-app-preload')
  assert.equal(preferences.partition, 'persist:controlled')
  assert.equal(preferences.contextIsolation, true); assert.equal(preferences.sandbox, true); assert.equal(preferences.nodeIntegration, false)
  const event = { sender: f.primary.webContents, senderFrame: f.primary.webContents.mainFrame }
  await assert.rejects(f.handlers.get('source-shell:rolePopOut')({ sender: {}, senderFrame: {} }, f.sceneId, f.panelId), /rejected sender/)
  const before = await f.descriptor()
  await f.handlers.get('source-shell:rolePopOut')(event, f.sceneId, f.panelId)
  assert.equal(f.view(), view, 'pop-out rehomes the existing native view instead of creating a different guest')
  assert.equal(view.options.webPreferences, preferences)
  assert.deepEqual(await f.descriptor(), before, 'rehome keeps the complete role binding identity')
  const a = await appearance(preferences.additionalArguments)
  assert.deepEqual(a.beforeReady, { marker: false, clearance: undefined })
  assert.equal(a.counts().menus, 0); assert.equal(a.document.body.children[0], a.portal)
  assert.deepEqual(a.portal.style, {}); assert.equal(a.sent.length, 1)
  a.events.get('pagehide')()
})
