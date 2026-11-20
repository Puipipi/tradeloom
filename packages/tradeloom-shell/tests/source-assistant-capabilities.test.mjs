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
  function node(tag, ...children) {
    return { tag, children, isConnected: true, attrs: {}, setAttribute(key, value) { this.attrs[key] = value },
      append(child) { this.children.push(child) }, replaceChildren(...values) { this.children = values },
      addEventListener(_event, action) { this.click = action } }
  }
  const context = { el: (tag, _classes, ...children) => node(tag, ...children),
    make: (tag, _classes, text) => node(tag, text), agentDataError: () => '读取失败',
    window: { businessBridge: { readAssistantCapabilities: () => new Promise(resolve => requests.push(resolve)) } },
  }
  runInNewContext(slice(source, 'function mountAssistantCapabilities', 'const UI_SCALE_KEY'), context)
  const root = node('body')
  context.mountAssistantCapabilities(root)
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
})
