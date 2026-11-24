import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { runInNewContext } from 'node:vm'
import { EventEmitter } from 'node:events'

const asar = new URL('../../../apps/tradeloom-launcher/stage5-source06/asar/', import.meta.url)
const tick = () => new Promise(resolve => setImmediate(resolve))
const slice = (source, first, last) => {
  const begin = source.indexOf(first), end = source.indexOf(last, begin)
  assert.ok(begin >= 0 && end > begin)
  return source.slice(begin, end)
}

test('assistant window accepts only its exact main frame and replaces a different role', async () => {
  const source = await readFile(new URL('lib/tradeloom-source-shell/source-shell-controller.mjs', asar), 'utf8')
  const children = []
  class BrowserWindow extends EventEmitter {
    constructor(options) {
      super()
      this.options = options
      this.webContents = new EventEmitter()
      this.webContents.mainFrame = {}
      this.webContents.setWindowOpenHandler = fn => { this.popup = fn }
      this.webContents.loadURL = url => {
        this.webContents.mainFrame.url = url
        return new Promise(resolve => { this.complete = resolve })
      }
      children.push(this)
    }
    isDestroyed() { return this.destroyed === true }
    destroy() { this.destroyed = true; this.emit('closed') }
    show() { this.shown = true }
    focus() { this.focused = true }
  }
  const sourceURL = 'dsh-app://app/source-shell/renderer/source-entry.html'
  const main = { webContents: { mainFrame: { url: sourceURL } } }
  const event = (window, frame = window.webContents.mainFrame) => ({ sender: window.webContents, senderFrame: frame })
  const context = { BrowserWindow, main, windows: new Map([['main', main]]), rolePopouts: new Map(),
    accountPopout: undefined, closed: false, hasNativeModal: () => false, sourcePreload: 'fixture',
    config: { roles: [{ id: 'center' }, { id: 'product' }], scenes: [{ id: 'runs', roleId: 'center' }, { id: 'products', roleId: 'product' }] },
  }
  runInNewContext(slice(source, 'const SOURCE_URL', 'const SCENE_COMPONENT_URL')
    + slice(source, '  const assertWindow', '  const assertThemeWindow')
    + slice(source, '  const scene = id', '  const normalizeOrder'), context)
  const old = context.openAssistantCapabilities(event(main), 'runs')
  const newer = context.openAssistantCapabilities(event(main), 'products')
  const [first, second] = children
  assert.equal(first.destroyed, true)
  first.complete(); await old
  assert.equal(first.shown, undefined)
  second.complete(); await newer
  assert.equal(second.shown, true)
  assert.equal(second.options.parent, main)
  assert.equal(second.options.webPreferences.sandbox, true)
  assert.equal(second.popup().action, 'deny')
  assert.equal(context.assistantCapabilitiesContext(event(second)).role, 'product')
  assert.throws(() => context.assistantCapabilitiesContext(event(first)), /sender rejected/)
  assert.throws(() => context.assistantCapabilitiesContext(event(second, { ...second.webContents.mainFrame })), /sender rejected/)
  await assert.rejects(context.openAssistantCapabilities(event(second), 'runs'), /rejected sender/)
  await context.openAssistantCapabilities(event(main), 'products')
  assert.equal(children.length, 2)
  assert.equal(second.focused, true)
  second.destroy()
  assert.throws(() => context.assistantCapabilitiesContext(event(second)), /sender rejected/)
})

test('assistant details show only the current selection and ignore stale or closed results', async () => {
  const source = await readFile(new URL('renderer/source-shell/replica-ui/renderer.js', asar), 'utf8')
  const requests = []
  const windowListeners = new Map()
  function node(tag, ...children) {
    return { tag, children, isConnected: true, attrs: {}, setAttribute(key, value) { this.attrs[key] = value },
      append(child) { this.children.push(child) }, replaceChildren(...values) { this.children = values },
      addEventListener(_event, action) { this.click = action } }
  }
  const context = { el: (tag, _classes, ...children) => node(tag, ...children),
    make: (tag, _classes, text) => node(tag, text), agentDataError: () => '读取失败',
    document: { documentElement: { dataset: {}, style: {} } },
    window: { addEventListener(name, fn) { windowListeners.set(name, fn) },
      removeEventListener(name, fn) { if (windowListeners.get(name) === fn) windowListeners.delete(name) },
      businessBridge: { readAssistantCapabilities: () => new Promise(resolve => requests.push(resolve)),
        whenInitialThemeReady: async () => ({ preference: 'system', colorScheme: 'dark' }) } },
  }
  runInNewContext(slice(source, 'function mountAssistantCapabilities', 'const UI_SCALE_KEY'), context)
  const root = node('body')
  context.mountAssistantCapabilities(root)
  await tick()
  assert.equal(context.document.documentElement.dataset.theme, 'dark', 'initial workbench theme is applied to the popout')
  assert.equal(context.document.documentElement.style.colorScheme, 'dark')
  windowListeners.get('business-theme-state')({ detail: { preference: 'system', colorScheme: 'light' } })
  assert.equal(context.document.documentElement.dataset.theme, 'light', 'live system theme changes update the popout')
  const [sidebar, detail] = root.children[0].children
  const [reload, list] = sidebar.children
  assert.equal(list.children.length, 0)
  const result = (role, items) => ({ ok: true, value: { role, capabilities: { status: 'ready', skills: { items } },
    configuration: { revision: 'test', mcpServers: [], deniedTools: [], skill: {} } } })
  reload.click()
  requests[0](result('stale-role', [])); await tick()
  assert.equal(list.children.length, 0)
  requests[1](result('product', [{ name: 'test-skill', description: '现有摘要', source: 'custom' }])); await tick()
  assert.match(JSON.stringify(detail), /product/)
  const skill = list.children.at(-1).children.at(-1)
  skill.click()
  assert.match(JSON.stringify(detail), /现有摘要/)
  assert.doesNotMatch(JSON.stringify(detail), /当前配置|stale-role/)
  assert.equal(skill.attrs['aria-current'], 'true')
  reload.click()
  requests[2]({ ok: false }); await tick()
  assert.match(JSON.stringify(detail), /读取失败/)
  reload.click()
  detail.isConnected = false
  requests[3](result('closed-role', [])); await tick()
  assert.equal(list.children.length, 0)
  assert.doesNotMatch(JSON.stringify(detail), /closed-role/)
  windowListeners.get('pagehide')()
  assert.equal(windowListeners.has('business-theme-state'), false, 'closed capability window releases its theme listener')
})

test('assistant capabilities uses the guarded native snapshot and follows live system theme changes', async () => {
  const source = await readFile(new URL('renderer/source-shell/replica-ui/renderer.js', asar), 'utf8')
  let nativeListener, nativeOff = 0, snapshots = 0
  const windowListeners = new Map()
  function node(tag, ...children) {
    return { tag, children, isConnected: true, setAttribute() {}, append(child) { this.children.push(child) },
      replaceChildren(...values) { this.children = values }, addEventListener() {} }
  }
  const document = { documentElement: { dataset: {}, style: {} } }
  const context = { el: (tag, _classes, ...children) => node(tag, ...children), make: (tag, _classes, text) => node(tag, text),
    agentDataError: () => '读取失败', document,
    window: { addEventListener(name, fn) { windowListeners.set(name, fn) },
      removeEventListener(name, fn) { if (windowListeners.get(name) === fn) windowListeners.delete(name) },
      app: { sourceTheme: { async getSnapshot() { snapshots++; return { preference: 'system', colorScheme: 'light' } },
        onChanged(fn) { nativeListener = fn; return () => { nativeOff++; nativeListener = undefined } } },
        businessBridge: { readAssistantCapabilities: async () => ({ ok: false }) } } },
  }
  runInNewContext(slice(source, 'function mountAssistantCapabilities', 'const UI_SCALE_KEY'), context)
  context.mountAssistantCapabilities(node('body'))
  await tick()
  assert.equal(snapshots, 1)
  assert.equal(document.documentElement.dataset.theme, 'light', 'light theme is read directly before the workbench bridge starts')
  assert.equal(document.documentElement.style.colorScheme, 'light')
  nativeListener({ preference: 'system', colorScheme: 'dark' })
  assert.equal(document.documentElement.dataset.theme, 'dark', 'system theme inherits its live native scheme')
  windowListeners.get('pagehide')()
  assert.equal(nativeOff, 1)
})

test('only the live AssistantCapabilities main frame is authorized for its theme snapshot', async () => {
  const source = await readFile(new URL('lib/tradeloom-source-shell/source-shell-controller.mjs', asar), 'utf8')
  const guard = slice(source, '  function assertAssistantCapabilitiesThemeWindow', '  const normalizeOrder')
  assert.match(guard, /event\.senderFrame !== event\.sender\.mainFrame/)
  assert.match(guard, /event\.senderFrame\?\.url !== ASSISTANT_CAPABILITIES_URL/)
  const sender = {}, frame = { url: 'dsh-app://app/source-shell/renderer/source-entry.html?component=assistant-capabilities-native' }
  const auxiliary = { webContents: { mainFrame: frame }, isDestroyed: () => false }
  const context = { assistantCapabilitiesWindow: { window: auxiliary }, ASSISTANT_CAPABILITIES_URL: frame.url }
  runInNewContext(`${guard};globalThis.guard=assertAssistantCapabilitiesThemeWindow`, context)
  assert.equal(context.guard({ sender: auxiliary.webContents, senderFrame: frame }), auxiliary)
  assert.throws(() => context.guard({ sender: auxiliary.webContents, senderFrame: { ...frame } }), /theme sender rejected/)
  assert.throws(() => context.guard({ sender: {}, senderFrame: frame }), /theme sender rejected/)
  auxiliary.isDestroyed = () => true
  assert.throws(() => context.guard({ sender: auxiliary.webContents, senderFrame: frame }), /theme sender rejected/)
  auxiliary.isDestroyed = () => false
  const endpoint = source.slice(source.indexOf("bind('themeSnapshot'"), source.indexOf("bind('themePreference'"))
  assert.match(endpoint, /assertAssistantCapabilitiesThemeWindow/)
  const themeSnapshot = { preference: 'light', colorScheme: 'light' }
  const readTheme = new Function('controller', 'assertAssistantCapabilitiesThemeWindow', 'assertThemeWindow', 'sourceThemeSnapshot', `let handler;const bind=(_name,fn)=>{handler=fn};${endpoint};return handler`)(
    { resolveGuest: () => undefined }, event => context.guard(event), event => { throw Error('wrong source theme owner') }, themeSnapshot)
  assert.equal(readTheme({ sender: auxiliary.webContents, senderFrame: frame }), themeSnapshot)
  assert.throws(() => readTheme({ sender: {}, senderFrame: frame }), /wrong source theme owner/)
  const preference = source.slice(source.indexOf("bind('themePreference'"), source.indexOf("bind('themePreferenceResult'"))
  assert.doesNotMatch(preference, /assertAssistantCapabilitiesThemeWindow/)
})

test('native theme publication includes the live capabilities window and skips a destroyed instance', async () => {
  const source = await readFile(new URL('lib/tradeloom-source-shell/source-shell-controller.mjs', asar), 'utf8')
  const publisher = slice(source, '  const publishCanonicalTheme = () =>', '  const scaledRect')
  const messages = []
  const main = { isDestroyed: () => false, webContents: { isDestroyed: () => false, send: (channel, value) => messages.push({ channel, value }) } }
  const live = { isDestroyed: () => false, webContents: { isDestroyed: () => false, send: (channel, value) => messages.push({ channel, value }) } }
  const stale = { isDestroyed: () => true, webContents: { isDestroyed: () => false, send: () => assert.fail('destroyed window must not receive events') } }
  const snapshot = { preference: 'light', colorScheme: 'light', palette: { header: '#ffffff', text: '#000000' } }
  const context = { closed: false, sourceThemeMaterials: {}, canonicalThemeSnapshot: () => snapshot,
    main, account: undefined, accountSidebar: undefined, sceneComponent: undefined, erpNextStatusComponent: undefined,
    views: new Map(), windows: new Map([['main', main]]), rolePopouts: new Map(), componentPopouts: new Map(), accountPopout: undefined,
    assistantCapabilitiesWindow: { window: live }, nativeCaptionWindows: new Set(), process: { platform: 'linux' },
    ui18Diagnostic() {}, ui18AccountFields: () => ({}) }
  runInNewContext(`${publisher};globalThis.publish=publishCanonicalTheme`, context)
  context.publish()
  assert.deepEqual(messages.map(value => value.channel), ['source-shell:theme-event', 'source-shell:theme-event'])
  assert.equal(messages[1].value.colorScheme, 'light')
  context.assistantCapabilitiesWindow = { window: stale }
  messages.length = 0
  context.publish()
  assert.deepEqual(messages.map(value => value.channel), ['source-shell:theme-event'])
})

test('assistant capability palette uses inherited colors with readable secondary text in both themes', async () => {
  const css = await readFile(new URL('renderer/source-shell/replica-ui/style.css', asar), 'utf8')
  const palette = await readFile(new URL('renderer/source-shell/replica-ui/palette.css', asar), 'utf8')
  assert.match(css, /\.assistant-capability-window \.capability-empty\{color:var\(--text-2\)\}/)
  assert.match(css, /\.assistant-capability-window \.capability-action\{color:var\(--text-2\)\}/)
  assert.match(palette, /html\[data-theme="light"\]/)
  assert.match(palette, /--text-2:var\(--tl-palette-light-text-2\)/)
  assert.match(palette, /--text-2:var\(--tl-palette-dark-text-2\)/)
})
