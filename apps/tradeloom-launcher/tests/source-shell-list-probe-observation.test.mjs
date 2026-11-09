import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { readFile } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import { resolve } from 'node:path'
import { runInNewContext } from 'node:vm'
import test from 'node:test'
import { createSourceShellController } from '../accepted-runtime/lib/tradeloom-source-shell/source-shell-controller.mjs'

const repo = resolve(process.cwd())
const mainPath = resolve(repo, 'apps/tradeloom-launcher/accepted-runtime/lib/main.js')
const readBlock = (source, startMarker, endMarker) => {
  const start = source.indexOf(startMarker)
  const end = source.indexOf(endMarker, start)
  assert.ok(start >= 0 && end > start, 'required production function boundary exists')
  return source.slice(start, end)
}
const wireMessage = ({ tag = 'guest-list-after-refresh-v1', outcome = 'result-error', code = 'FIXTURE_REMOTE_CODE', surface = 'chat', generation = 7 } = {}) =>
  'TL-ROLE-GUEST-LIST-PROBE|' + tag + '|' + outcome + '|' + code + '|' + surface + '|' + generation

class FakeWebContents extends EventEmitter {
  static nextId = 1
  constructor(url) {
    super()
    this.id = FakeWebContents.nextId++
    this.mainFrame = { url }
    this.dead = false
    this.sent = []
  }
  isDestroyed() { return this.dead }
  setZoomFactor() {}
  send(channel, ...args) { this.sent.push({ channel, args }) }
  loadURL(url) { this.mainFrame = { url }; return Promise.resolve() }
  destroy() { if (this.dead) return; this.dead = true; this.emit('destroyed') }
}

class FakeWindow extends EventEmitter {
  constructor(url = 'dsh-app://app/source-shell/renderer/source-entry.html') {
    super()
    this.id = FakeWebContents.nextId++
    this.dead = false
    this.webContents = new FakeWebContents(url)
    this.contentView = { addChildView() {}, removeChildView() {} }
  }
  isDestroyed() { return this.dead }
  getContentBounds() { return { x: 0, y: 0, width: 1200, height: 800 } }
  setTitleBarOverlay() {}
  show() {}
  focus() {}
  destroy() { if (this.dead) return; this.dead = true; this.webContents.destroy(); this.emit('closed') }
  close() { this.destroy() }
}

class FakeWebContentsView {
  static instances = []
  constructor() {
    this.visible = false
    this.bounds = { x: 0, y: 0, width: 640, height: 480 }
    this.webContents = new FakeWebContents('about:blank')
    FakeWebContentsView.instances.push(this)
  }
  setVisible(value) { this.visible = value }
  setBounds(value) { this.bounds = value }
  getBounds() { return this.bounds }
}

async function createMainObserver(records) {
  const mainSource = await readFile(mainPath, 'utf8')
  const constants = readBlock(mainSource, 'const STAGES = [', 'const SOURCE_FAILURE_OPERATIONS =')
  const observerSource = readBlock(mainSource, 'function createStartupObservation(path, append =', 'const observeStartup = createStartupObservation')
  const sandbox = {
    isAbsolute,
    process: { pid: 789 },
    appendFileSync: () => {}
  }
  runInNewContext(constants + '\n' + observerSource + '\nglobalThis.__makeObserver = createStartupObservation', sandbox, { filename: mainPath })
  return sandbox.__makeObserver('D:\\owned\\desktop-startup-observation.jsonl', (_path, line) => records.push(JSON.parse(line)))
}

test('actual SourceShellController console listener forwards only current guest probe to the Main allowlist', async t => {
  FakeWebContentsView.instances.length = 0
  const records = []
  const observe = await createMainObserver(records)
  const observedPhases = []
  const handlers = new Map()
  const main = new FakeWindow()
  const config = { scenes: [{ id: 'fixture-scene', panels: [{ id: 'fixture-panel', type: 'native-chat' }] }] }
  const controller = createSourceShellController({
    BrowserWindow: FakeWindow,
    WebContentsView: FakeWebContentsView,
    ipcMain: {
      handle(channel, handler) { handlers.set(channel, handler) },
      removeHandler(channel) { handlers.delete(channel) }
    },
    appPreload: 'fixture-app-preload.cjs',
    sourcePreload: 'fixture-source-preload.cjs',
    ownedPartition: 'persist:fixture-owned',
    getConfig: async () => config,
    resolveBinding: async ({ sceneId, panelId }) => ({
      sceneId, panelId, bindingStatus: 'bound', sessionId: 'fixture-session', bindingRevision: 'fixture-revision'
    }),
    installProtocol: async () => {},
    primaryWindow: main,
    loadUiScale: async () => 1,
    saveUiScale: async () => {},
    loadSceneOrder: async () => ({ saved: false, ids: [] }),
    saveSceneOrder: async () => {},
    writeUi18Diagnostic: async () => {},
    observePhase: fields => { observedPhases.push(fields); observe('source-shell', 'phase', fields) }
  })
  t.after(() => controller.destroy())
  const started = controller.start()
  await new Promise(resolveTurn => setTimeout(resolveTurn, 0))
  const paintReady = handlers.get('source-shell:initialPaintReady')
  assert.equal(typeof paintReady, 'function')
  const mainEvent = { sender: main.webContents, senderFrame: main.webContents.mainFrame }
  for (const stage of ['caption', 'scene', 'theme', 'layout', 'paint']) {
    await paintReady(mainEvent, { status: 'progress', stage })
  }
  await paintReady(mainEvent, { status: 'ready' })
  await started
  const createHandler = handlers.get('source-shell:create')
  assert.equal(typeof createHandler, 'function')
  await createHandler({ sender: main.webContents, senderFrame: main.webContents.mainFrame }, 'fixture-scene', 'fixture-panel')
  const guestView = FakeWebContentsView.instances.at(-1)
  assert.ok(guestView)
  const guestContents = guestView.webContents
  const send = (message, frame = guestContents.mainFrame) => guestContents.emit('console-message', { message, frame })
  const guestDescriptor = controller.nativeDescriptor(guestContents, guestContents.mainFrame)
  assert.ok(guestDescriptor)
  const validWire = wireMessage({ surface: guestDescriptor.surface, generation: guestDescriptor.generation })

  const statusEventsBefore = main.webContents.sent.filter(event => event.channel === 'source-shell:status-event').length
  send(validWire)
  const probePhases = observedPhases.filter(fields => fields.phase === 'list-probe')
  assert.equal(probePhases.length, 1, 'actual controller listener accepts the current guest main-frame message')
  assert.deepEqual(probePhases[0], {
    operation: 'role-guest', phase: 'list-probe', surface: guestDescriptor.surface,
    probeTag: 'guest-list-after-refresh-v1', outcome: 'result-error', code: 'FIXTURE_REMOTE_CODE'
  })
  const accepted = records.filter(record => record.phase === 'list-probe')
  assert.equal(accepted.length, 1, 'current guest main-frame probe reaches the actual Main startup observer')
  assert.deepEqual(
    Object.fromEntries(['probeTag', 'outcome', 'code'].map(key => [key, accepted[0][key]])),
    { probeTag: 'guest-list-after-refresh-v1', outcome: 'result-error', code: 'FIXTURE_REMOTE_CODE' }
  )
  assert.equal('sessionId' in accepted[0], false)
  assert.equal('message' in accepted[0], false)
  assert.equal('items' in accepted[0], false)
  observe('source-shell', 'phase', {
    operation: 'role-guest', phase: 'list-probe', surface: guestDescriptor.surface,
    probeTag: 'guest-list-after-refresh-v1', outcome: 'ok', code: 'none',
    sessionId: 'private-fixture-id', title: 'private fixture title', cwd: 'C:\\private-fixture',
    url: 'https://private.invalid/', credentials: 'never-log', message: 'private fixture text', details: { private: true }, items: ['private']
  })
  const sanitized = records.at(-1)
  assert.equal(sanitized.outcome, 'ok')
  assert.equal(sanitized.code, 'none')
  for (const forbidden of ['sessionId', 'title', 'cwd', 'url', 'credentials', 'message', 'details', 'items', 'count', 'name', 'elapsed']) {
    assert.equal(forbidden in sanitized, false, 'Main discards forbidden field ' + forbidden)
  }
  assert.equal(main.webContents.sent.filter(event => event.channel === 'source-shell:status-event').length, statusEventsBefore,
    'diagnostic is not emitted as a UI status change')

  const beforeRejects = records.length
  send(validWire, {})
  send(wireMessage({ generation: guestDescriptor.generation + 1, surface: guestDescriptor.surface }))
  send(wireMessage({ surface: guestDescriptor.surface === 'chat' ? 'files' : 'chat', generation: guestDescriptor.generation }))
  send(wireMessage({ tag: 'unexpected', surface: guestDescriptor.surface, generation: guestDescriptor.generation }))
  send(wireMessage({ code: 'bad code', surface: guestDescriptor.surface, generation: guestDescriptor.generation }))
  send(wireMessage({ outcome: 'ok', code: 'FIXTURE_REMOTE_CODE', surface: guestDescriptor.surface, generation: guestDescriptor.generation }))
  send(validWire + 'x'.repeat(200))
  assert.equal(records.length, beforeRejects, 'subframe, stale generation, wrong surface/tag/code, ok-with-code, and oversized messages are rejected')

  send(validWire)
  assert.equal(records.filter(record => record.phase === 'list-probe').length, 3, 'well-formed event remains observable')
  guestContents.destroy()
  send(validWire)
  assert.equal(records.filter(record => record.phase === 'list-probe').length, 3, 'destroyed/revoked guest seat is rejected')
  await controller.destroy()
  send(validWire)
  assert.equal(records.filter(record => record.phase === 'list-probe').length, 3, 'events after controller close are ignored')
})
