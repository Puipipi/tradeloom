import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { readFile } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import { resolve } from 'node:path'
import { runInNewContext } from 'node:vm'
import test from 'node:test'
import { createSourceShellController } from '../accepted-runtime/lib/tradeloom-source-shell/source-shell-controller.mjs'
import { mountSourceNative } from '../../../packages/tradeloom-shell/tests/client-source-native-session-list-probe.test.js'
import { createGatewayFixture } from './session-list-failure-phase.test.mjs'

const repo = resolve(process.cwd())
const mainPath = resolve(repo, 'apps/tradeloom-launcher/accepted-runtime/lib/main.js')
const readBlock = (source, startMarker, endMarker) => {
  const start = source.indexOf(startMarker)
  const end = source.indexOf(endMarker, start)
  assert.ok(start >= 0 && end > start, 'required production function boundary exists')
  return source.slice(start, end)
}
const wireMessage = ({ tag = 'guest-list-after-refresh-v1', outcome = 'result-error', code = 'gateway/internal', reasonHint = 'unclassified', surface = 'chat', generation = 7 } = {}) =>
  ['TL-ROLE-GUEST-LIST-PROBE', tag, outcome, code, ...(tag === 'guest-list-after-refresh-v2' ? [reasonHint] : []), surface, generation].join('|')

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

async function createMainObserver(records, append = (_path, line) => records.push(JSON.parse(line))) {
  const mainSource = await readFile(mainPath, 'utf8')
  const constants = readBlock(mainSource, 'const STAGES = [', 'const SOURCE_FAILURE_OPERATIONS =')
  const observerSource = readBlock(mainSource, 'function createStartupObservation(path, append =', 'const observeStartup = createStartupObservation')
  const sandbox = {
    isAbsolute,
    process: { pid: 789 },
    appendFileSync: () => {}
  }
  runInNewContext(constants + '\n' + observerSource + '\nglobalThis.__makeObserver = createStartupObservation', sandbox, { filename: mainPath })
  return sandbox.__makeObserver('D:\\owned\\desktop-startup-observation.jsonl', append)
}

async function createMainHostWrapper(host) {
  const mainSource = await readFile(mainPath, 'utf8')
  const wrapperSource = readBlock(mainSource, 'const wrapper = {', '\n\t\thostWrapper = wrapper;')
  const sandbox = { host }
  runInNewContext(wrapperSource + '\nglobalThis.__wrapper = wrapper', sandbox, { filename: mainPath })
  return sandbox.__wrapper
}

async function createOriginGrantCase({
  observe,
  records,
  guest,
  hostCall,
  mainWindow = null,
  sourceMode = true,
  senderCheck,
  resolveGuest,
  append
}) {
  const mainSource = await readFile(mainPath, 'utf8')
  const registration = readBlock(
    mainSource,
    'ipcMain.handle(DESKTOP_IPC.sceneMemoryOriginGrant, async (event, request) => {',
    '\n\t});'
  )
  const frame = { url: 'fixture://owned-main' }
  const sender = { id: 91, mainFrame: frame, isDestroyed: () => false }
  const sourceGuest = guest ?? {
    scope: 'role', generation: 4, sceneId: 'fixture-scene', panelId: 'fixture-panel',
    sessionId: 'fixture-session-secret', bindingRevision: 'fixture-revision'
  }
  const captured = []
  const observer = observe ?? await createMainObserver(records ?? captured, append)
  const guestResolver = resolveGuest ?? ((currentSender, currentFrame) =>
    currentSender === sender && currentFrame === sender.mainFrame ? sourceGuest : undefined)
  let handler
  const sandbox = {
    DESKTOP_IPC: { sceneMemoryOriginGrant: 'fixture:scene-memory-origin-grant' },
    ipcMain: { handle(channel, callback) { assert.equal(channel, 'fixture:scene-memory-origin-grant'); handler = callback } },
    assertDesktopSender: senderCheck ?? ((event, allowed) => {
      if (!allowed.includes('app') || event.sender !== sender) throw new Error('fixture sender rejected')
    }),
    sourceMode,
    sourceController: { resolveGuest: guestResolver },
    mainWindow,
    backend: { host: { issueSceneMemoryOriginGrant: hostCall } },
    observeStartup: observer,
    Buffer,
    Uint8Array
  }
  runInNewContext(registration + '\n\t});', sandbox, { filename: mainPath })
  assert.equal(typeof handler, 'function', 'actual Main handler is captured')
  return { handler, sender, frame, guest: sourceGuest }
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
    probeTag: 'guest-list-after-refresh-v1', outcome: 'result-error', code: 'gateway/internal'
  })
  const accepted = records.filter(record => record.phase === 'list-probe')
  assert.equal(accepted.length, 1, 'current guest main-frame probe reaches the actual Main startup observer')
  assert.deepEqual(
    Object.fromEntries(['probeTag', 'outcome', 'code'].map(key => [key, accepted[0][key]])),
    { probeTag: 'guest-list-after-refresh-v1', outcome: 'result-error', code: 'gateway/internal' }
  )
  assert.equal('reasonHint' in accepted[0], false, 'legacy v1 does not receive a fabricated reason')
  send(wireMessage({ tag: 'guest-list-after-refresh-v2', reasonHint: 'withdrawn-prefix', surface: guestDescriptor.surface, generation: guestDescriptor.generation }))
  const v2Accepted = records.filter(record => record.phase === 'list-probe')
  assert.equal(v2Accepted.length, 2, 'the current guest probe v2 reaches Main while v1 remains supported')
  assert.deepEqual(
    Object.fromEntries(['probeTag', 'outcome', 'code', 'reasonHint'].map(key => [key, v2Accepted[1][key]])),
    { probeTag: 'guest-list-after-refresh-v2', outcome: 'result-error', code: 'gateway/internal', reasonHint: 'withdrawn-prefix' }
  )
  const beforeInvalidV2 = v2Accepted.length
  send(wireMessage({ tag: 'guest-list-after-refresh-v2', code: 'FIXTURE_CODE', reasonHint: 'carrier-prefix', surface: guestDescriptor.surface, generation: guestDescriptor.generation }))
  send(wireMessage({ tag: 'guest-list-after-refresh-v2', code: 'gateway/internal', reasonHint: 'none', surface: guestDescriptor.surface, generation: guestDescriptor.generation }))
  send(wireMessage({ tag: 'guest-list-after-refresh-v2', outcome: 'ok', code: 'none', reasonHint: 'unclassified', surface: guestDescriptor.surface, generation: guestDescriptor.generation }))
  send(wireMessage({ tag: 'guest-list-after-refresh-v2', reasonHint: 'invented', surface: guestDescriptor.surface, generation: guestDescriptor.generation }))
  assert.equal(records.filter(record => record.phase === 'list-probe').length, beforeInvalidV2, 'invalid v2 reason/code pairs are rejected')
  const beforeInvalidMain = records.length
  observe('source-shell', 'phase', {
    operation: 'role-guest', phase: 'list-probe', surface: guestDescriptor.surface,
    probeTag: 'guest-list-after-refresh-v2', outcome: 'result-error', code: 'FIXTURE_CODE', reasonHint: 'carrier-prefix'
  })
  observe('source-shell', 'phase', {
    operation: 'role-guest', phase: 'list-probe', surface: guestDescriptor.surface,
    probeTag: 'guest-list-after-refresh-v2', outcome: 'result-error', code: 'gateway/internal', reasonHint: 'none'
  })
  observe('source-shell', 'phase', {
    operation: 'role-guest', phase: 'list-probe', surface: guestDescriptor.surface,
    probeTag: 'guest-list-after-refresh-v2', outcome: 'ok', code: 'none', reasonHint: 'unclassified'
  })
  observe('source-shell', 'phase', {
    operation: 'role-guest', phase: 'list-probe', surface: guestDescriptor.surface,
    probeTag: 'guest-list-after-refresh-v2', outcome: 'result-error', code: 'FIXTURE_CODE', reasonHint: 'rpc-call'
  })
  observe('source-shell', 'phase', {
    operation: 'role-guest', phase: 'list-probe', surface: guestDescriptor.surface,
    probeTag: 'guest-list-after-refresh-v2', outcome: 'result-error', code: 'gateway/internal', reasonHint: 'none'
  })
  observe('source-shell', 'phase', {
    operation: 'role-guest', phase: 'list-probe', surface: guestDescriptor.surface,
    probeTag: 'guest-list-after-refresh-v2', outcome: 'ok', code: 'none', reasonHint: 'result-decode'
  })
  observe('source-shell', 'phase', {
    operation: 'role-guest', phase: 'list-probe', surface: guestDescriptor.surface,
    probeTag: 'guest-list-after-refresh-v2', outcome: 'result-error', code: 'FIXTURE_CODE', reasonHint: 'invented'
  })
  assert.equal(records.length, beforeInvalidMain, 'Main rejects invalid v2 reason/code pairs')
  send(wireMessage({ code: 'gateway/cancelled', surface: guestDescriptor.surface, generation: guestDescriptor.generation }))
  const slashAccepted = records.filter(record => record.phase === 'list-probe')
  assert.equal(slashAccepted.length, 3, 'second SDK namespaced code also reaches Main')
  assert.equal(slashAccepted[2].code, 'gateway/cancelled')
  const maxCode = 'a'.repeat(62) + '/b'
  send(wireMessage({ code: maxCode, surface: guestDescriptor.surface, generation: guestDescriptor.generation }))
  const boundedAccepted = records.filter(record => record.phase === 'list-probe')
  assert.equal(boundedAccepted.length, 4, '64-character namespaced code remains within the accepted bound')
  assert.equal(boundedAccepted[3].code, maxCode)
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
  send(wireMessage({ tag: 'guest-list-after-refresh-v2', reasonHint: 'unclassified', generation: guestDescriptor.generation + 1, surface: guestDescriptor.surface }))
  send(wireMessage({ tag: 'guest-list-after-refresh-v2', reasonHint: 'rpc-call', generation: guestDescriptor.generation + 1, surface: guestDescriptor.surface }))
  send(wireMessage({ tag: 'guest-list-after-refresh-v2', reasonHint: 'unclassified', surface: guestDescriptor.surface }, {}))
  send(wireMessage({ tag: 'guest-list-after-refresh-v2', reasonHint: 'result-decode', surface: guestDescriptor.surface }, {}))
  send(wireMessage({ surface: guestDescriptor.surface === 'chat' ? 'files' : 'chat', generation: guestDescriptor.generation }))
  send(wireMessage({ tag: 'unexpected', surface: guestDescriptor.surface, generation: guestDescriptor.generation }))
  for (const code of ['bad|code', 'a//b', '/a/b', 'a/b/', 'a'.repeat(63) + '/b', 'a/b\n', 'a/b\r\n', 'none']) {
    send(wireMessage({ code, surface: guestDescriptor.surface, generation: guestDescriptor.generation }))
  }
  send(wireMessage({ outcome: 'ok', code: 'FIXTURE_REMOTE_CODE', surface: guestDescriptor.surface, generation: guestDescriptor.generation }))
  send(validWire + 'x'.repeat(200))
  assert.equal(records.length, beforeRejects, 'subframe, stale generation, wrong surface/tag/code, ok-with-code, and oversized messages are rejected')

  send(validWire)
  assert.equal(records.filter(record => record.phase === 'list-probe').length, beforeRejects + 1, 'well-formed event remains observable')

  const beforeActualPhases = records.filter(record => record.phase === 'list-probe').length
  const rpcGateway = await createGatewayFixture({ rpcCall: async () => { throw new Error('private RPC fixture') } })
  const rpcSource = await mountSourceNative({
    initialDescriptor: guestDescriptor,
    gatewayApi: rpcGateway.api,
    remoteList: async () => (await rpcGateway.invokeList()).result
  })
  await new Promise(resolveTurn => setTimeout(resolveTurn, 0))
  await new Promise(resolveTurn => setTimeout(resolveTurn, 0))
  const rpcWire = rpcSource.messages.find(message => message.startsWith('TL-ROLE-GUEST-LIST-PROBE|'))
  assert.ok(rpcWire?.includes('|result-error|gateway/internal|rpc-call|'), 'actual SourceNative emits the Gateway call phase')
  send(rpcWire)
  const decodeGateway = await createGatewayFixture({ rpcCall: async () => ({ ok: true, value: { items: [] } }) })
  const decodeSource = await mountSourceNative({
    initialDescriptor: guestDescriptor,
    gatewayApi: decodeGateway.api,
    remoteList: async () => (await decodeGateway.invokeList({ decode: () => { throw new Error('private decode fixture') } })).result
  })
  await new Promise(resolveTurn => setTimeout(resolveTurn, 0))
  await new Promise(resolveTurn => setTimeout(resolveTurn, 0))
  const decodeWire = decodeSource.messages.find(message => message.startsWith('TL-ROLE-GUEST-LIST-PROBE|'))
  assert.ok(decodeWire?.includes('|result-error|gateway/internal|result-decode|'), 'actual SourceNative emits the strict decode phase')
  send(decodeWire)
  rpcSource.cleanup()
  decodeSource.cleanup()
  const actualPhaseRecords = records.filter(record => record.phase === 'list-probe').slice(beforeActualPhases)
  assert.deepEqual(actualPhaseRecords.map(record => record.reasonHint), ['rpc-call', 'result-decode'],
    'actual SourceNative phase messages pass the real guest console listener and Main allowlist')
  for (const record of actualPhaseRecords) {
    assert.equal(record.code, 'gateway/internal')
    assert.equal(record.probeTag, 'guest-list-after-refresh-v2')
    assert.equal('message' in record, false)
    assert.equal('details' in record, false)
  }
  send(wireMessage({ tag: 'guest-list-after-refresh-v2', outcome: 'result-error', code: 'FIXTURE_CODE', reasonHint: 'rpc-call', surface: guestDescriptor.surface, generation: guestDescriptor.generation }))
  send(wireMessage({ tag: 'guest-list-after-refresh-v2', outcome: 'ok', code: 'none', reasonHint: 'rpc-call', surface: guestDescriptor.surface, generation: guestDescriptor.generation }))
  const beforeInvalidPhasePair = records.filter(record => record.phase === 'list-probe').length
  assert.equal(beforeInvalidPhasePair, beforeActualPhases + 2, 'wrong-code and ok-with-phase pairs stay rejected')
  guestContents.destroy()
  send(validWire)
  assert.equal(records.filter(record => record.phase === 'list-probe').length, beforeRejects + 3, 'destroyed/revoked guest seat is rejected')
  await controller.destroy()
  send(validWire)
  assert.equal(records.filter(record => record.phase === 'list-probe').length, beforeRejects + 3, 'events after controller close are ignored')
})
test('actual Main scene-memory grant records bounded outcomes without changing results', async t => {
  const makeRequest = (endpoint = 'session/list', bodyBytes = new Uint8Array([1, 2, 3])) => ({
    endpoint, httpMethod: 'POST', bodyBytes
  })
  const getRows = records => records.filter(record => record.operation === 'origin-grant')

  await t.test('actual backend Host wrapper forwards the grant call unchanged', async () => {
    const grantRequest = { endpoint: 'session/list', httpMethod: 'POST', bodyBytesBase64: 'AQID', source: { scope: 'role', generation: 4 } }
    const grant = { token: 'fixture-host-grant', expiresAt: 123, hostEpoch: 'fixture-epoch' }
    const originalError = new Error('fixture host rejection')
    const received = []
    const receivers = []
    let rejected = false
    const host = {
      async issueSceneMemoryOriginGrant(request) {
        received.push(request)
        receivers.push(this)
        if (rejected) throw originalError
        return grant
      }
    }
    const wrapper = await createMainHostWrapper(host)
    assert.equal(typeof wrapper.issueSceneMemoryOriginGrant, 'function', 'production backend wrapper exposes the Host grant method')
    const result = await wrapper.issueSceneMemoryOriginGrant(grantRequest)
    assert.equal(received.length, 1)
    assert.equal(received[0], grantRequest, 'the exact request object is forwarded')
    assert.equal(receivers[0], host, 'the underlying Host remains the method receiver')
    assert.equal(result, grant, 'the exact grant object is returned')
    rejected = true
    await assert.rejects(wrapper.issueSceneMemoryOriginGrant(grantRequest), error => error === originalError)
    assert.equal(received.length, 2, 'one underlying call occurs per wrapper call')
    assert.equal(received[1], grantRequest)
    assert.equal(receivers[1], host)
  })

  await t.test('session/list grant returns the same object and emits only bounded records', async () => {
    const records = []
    let hostCalls = 0
    const grant = { token: 'fixture-token-secret', expiresAt: 123, hostEpoch: 'fixture-host' }
    const fixture = await createOriginGrantCase({
      records,
      hostCall: async request => { hostCalls += 1; assert.equal(request.endpoint, 'session/list'); return grant }
    })
    const result = await fixture.handler({ sender: fixture.sender, senderFrame: fixture.frame }, makeRequest())
    assert.equal(result, grant)
    assert.equal(hostCalls, 1)
    const rows = getRows(records)
    assert.equal(rows.length, 2)
    assert.deepEqual(rows.map(row => row.result), ['entered', 'grant'])
    assert.deepEqual(rows.map(row => row.endpointClass), ['session-list', 'session-list'])
    const serialized = JSON.stringify(rows)
    for (const secret of ['fixture-token-secret', 'fixture-session-secret', 'fixture-panel', 'session/list']) {
      assert.equal(serialized.includes(secret), false, `sensitive value omitted: ${secret}`)
    }
  })

  await t.test('null mode preserves null and records terminal null', async () => {
    const records = []
    let hostCalls = 0
    const fixture = await createOriginGrantCase({ records, sourceMode: false, hostCall: async () => { hostCalls += 1 } })
    const result = await fixture.handler({ sender: fixture.sender, senderFrame: fixture.frame }, makeRequest())
    assert.equal(result, null)
    assert.equal(hostCalls, 0)
    const rows = getRows(records)
    assert.equal(rows.length, 2)
    assert.deepEqual(rows.map(row => row.result), ['entered', 'null'])
  })

  await t.test('request rejection before endpoint classification emits one unclassified terminal row', async () => {
    const records = []
    const fixture = await createOriginGrantCase({ records, hostCall: async () => assert.fail('Host must not be called') })
    const rejection = fixture.handler({ sender: fixture.sender, senderFrame: fixture.frame }, makeRequest('session/list', new Uint8Array()))
    await assert.rejects(rejection, error => error.message === 'scene-memory origin: invalid grant request')
    const rows = getRows(records)
    assert.equal(rows.length, 1)
    assert.deepEqual({ endpointClass: rows[0].endpointClass, result: rows[0].result }, { endpointClass: 'other', result: 'error' })
  })

  await t.test('sender rejection preserves the same error and does not read endpoint', async () => {
    const records = []
    const senderError = new Error('fixture sender rejection')
    let endpointReads = 0
    const fixture = await createOriginGrantCase({
      records,
      senderCheck: () => { throw senderError },
      hostCall: async () => assert.fail('Host must not be called')
    })
    const request = {
      get endpoint() { endpointReads += 1; return 'session/list' },
      httpMethod: 'POST', bodyBytes: new Uint8Array([1])
    }
    await assert.rejects(
      fixture.handler({ sender: fixture.sender, senderFrame: fixture.frame }, request),
      actual => actual === senderError
    )
    assert.equal(endpointReads, 0)
    const rows = getRows(records)
    assert.equal(rows.length, 1)
    assert.deepEqual({ endpointClass: rows[0].endpointClass, phase: rows[0].phase, result: rows[0].result },
      { endpointClass: 'other', phase: 'sender', result: 'error' })
  })

  await t.test('allowlisted Host code is recorded without changing error identity', async () => {
    const records = []
    const error = Object.assign(new Error('do not serialize'), { code: 'stale_role_binding' })
    const fixture = await createOriginGrantCase({ records, hostCall: async () => { throw error } })
    await assert.rejects(
      fixture.handler({ sender: fixture.sender, senderFrame: fixture.frame }, makeRequest()),
      actual => actual === error
    )
    const rows = getRows(records)
    assert.equal(rows.length, 2)
    assert.equal(rows[1].code, 'stale_role_binding')
    assert.equal(JSON.stringify(rows).includes('do not serialize'), false)
  })

  await t.test('Host error identity is preserved and unknown code is not serialized', async () => {
    const records = []
    const error = Object.assign(new Error('fixture-secret-error-message'), { code: 'fixture-secret-code' })
    const fixture = await createOriginGrantCase({ records, hostCall: async () => { throw error } })
    await assert.rejects(
      fixture.handler({ sender: fixture.sender, senderFrame: fixture.frame }, makeRequest()),
      actual => actual === error
    )
    const rows = getRows(records)
    assert.equal(rows.length, 2)
    assert.equal(rows[1].result, 'error')
    assert.equal(rows[1].code, 'unknown')
    const serialized = JSON.stringify(rows)
    assert.equal(serialized.includes('fixture-secret-error-message'), false)
    assert.equal(serialized.includes('fixture-secret-code'), false)
  })

  await t.test('recheck failure is recorded after await and its original error is rethrown', async () => {
    const records = []
    let resolutions = 0
    const changed = {
      scope: 'role', generation: 5, sceneId: 'fixture-scene', panelId: 'fixture-panel',
      sessionId: 'fixture-session-secret', bindingRevision: 'fixture-revision'
    }
    const fixture = await createOriginGrantCase({
      records,
      hostCall: async () => ({ token: 'fixture-token-secret', expiresAt: 123, hostEpoch: 'fixture-host' }),
      resolveGuest: () => (++resolutions === 1 ? {
        scope: 'role', generation: 4, sceneId: 'fixture-scene', panelId: 'fixture-panel',
        sessionId: 'fixture-session-secret', bindingRevision: 'fixture-revision'
      } : changed)
    })
    await assert.rejects(
      fixture.handler({ sender: fixture.sender, senderFrame: fixture.frame }, makeRequest()),
      error => error.message === 'scene-memory origin: role guest changed while grant was pending'
    )
    assert.equal(resolutions, 2)
    const rows = getRows(records)
    assert.equal(rows.length, 2)
    assert.equal(rows[1].result, 'error')
    assert.equal(rows[1].phase, 'recheck')
  })

  await t.test('observer append failure does not change the returned grant', async () => {
    let hostCalls = 0
    const grant = { token: 'fixture-token-secret', expiresAt: 123, hostEpoch: 'fixture-host' }
    const fixture = await createOriginGrantCase({
      records: [],
      append: () => { throw new Error('observer fixture failure') },
      hostCall: async () => { hostCalls += 1; return grant }
    })
    const result = await fixture.handler({ sender: fixture.sender, senderFrame: fixture.frame }, makeRequest('session/list'))
    assert.equal(result, grant)
    assert.equal(hostCalls, 1)
  })

  await t.test('a directly throwing observer does not change null or Host error', async () => {
    const observe = () => { throw new Error('observer fixture failure') }
    const nullFixture = await createOriginGrantCase({
      records: [], observe, sourceMode: false,
      hostCall: async () => assert.fail('Host must not be called')
    })
    assert.equal(await nullFixture.handler(
      { sender: nullFixture.sender, senderFrame: nullFixture.frame }, makeRequest()
    ), null)

    const hostError = Object.assign(new Error('private provider failure'), { code: 'stale_role_binding' })
    const errorFixture = await createOriginGrantCase({ records: [], observe, hostCall: async () => { throw hostError } })
    await assert.rejects(
      errorFixture.handler({ sender: errorFixture.sender, senderFrame: errorFixture.frame }, makeRequest()),
      actual => actual === hostError
    )
  })

  await t.test('non-list endpoints are only classified as other', async () => {
    const records = []
    const grant = { token: 'fixture-token-secret', expiresAt: 123, hostEpoch: 'fixture-host' }
    const fixture = await createOriginGrantCase({ records, hostCall: async () => grant })
    assert.equal(await fixture.handler({ sender: fixture.sender, senderFrame: fixture.frame }, makeRequest('account/list')), grant)
    const rows = getRows(records)
    assert.equal(rows.length, 2)
    assert.deepEqual(rows.map(row => row.endpointClass), ['other', 'other'])
    assert.equal(JSON.stringify(rows).includes('account/list'), false)
  })
})
