import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { setTimeout as delay } from 'node:timers/promises'
import test from 'node:test'
import { createHostWebAiTransport } from '../webai-native-host.js'
import { createMainWebAiTransport } from '../../../candidates/webai-native-bridge/split/main.mjs'
import { WEB_AI_NATIVE_HEADER, WEB_AI_NATIVE_PATH } from '../webai-native-wire.js'

test('normal package exports resolve the adopted Host, authorization, and wire modules', async () => {
  const [host, authorization, wire] = await Promise.all([
    import('@tradeloom/dsh-business-shell/webai-native-host'),
    import('@tradeloom/dsh-business-shell/webai-native-authorization'),
    import('@tradeloom/dsh-business-shell/webai-native-wire'),
  ])
  assert.equal(host.createHostWebAiTransport, createHostWebAiTransport)
  assert.equal(typeof authorization.createNativeWebAiAuthorization, 'function')
  assert.equal(typeof authorization.mountOptionalWebAiHost, 'function')
  assert.equal(wire.WEB_AI_NATIVE_PATH, WEB_AI_NATIVE_PATH)
  const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
  for (const file of ['webai-native-host.js', 'webai-native-authorization.js', 'webai-native-wire.js']) {
    assert.ok(packageJson.files.includes(file), `${file} is included in the package file list`)
  }
})

const KEY = 'synthetic-native-bridge-key-for-tests'

function observation(request, content, messageId = `m-${request.requestId}`) {
  return {
    source: 'native-assistant-observation', role: 'assistant', isNew: true, complete: true,
    messageId, conversationId: request.conversationId, taskNonce: request.taskNonce,
    requestId: request.requestId, content,
  }
}

function targetObjects({ id = 11, providerId = 'deepseek', adapter } = {}) {
  const listeners = new Set()
  const owner = { id: 1, isDestroyed: () => false }
  const webContents = {
    id, url: providerId === 'deepseek' ? 'https://chat.deepseek.com/' : 'https://www.doubao.com/', getURL() { return this.url },
    isDestroyed: () => false,
    once(_event, listener) { this.destroyListener = listener },
    listeners: new Map(), on(event, listener) { this.listeners.set(event, listener) },
    removeListener(event, listener) { if (this.listeners.get(event) === listener) this.listeners.delete(event) },
  }
  const actualAdapter = adapter ?? {
    inspect: async () => ({ conversationId: 'conversation-1', draftText: '', attachmentCount: 0 }),
    onConversationChange(listener) { listeners.add(listener); return () => listeners.delete(listener) },
    async ask(request) {
      request.onProgress?.('started')
      return observation(request, 'done')
    },
  }
  return { owner, ownerWebContents: owner, webContents, adapter: actualAdapter, notify: value => { for (const listener of listeners) listener(value) } }
}

function context() {
  let route
  const tools = new Map()
  const ctx = {
    connection: { fetch: { register(value) { route = value; return async () => { route = undefined } } } },
    tools: { register(definition) { tools.set(definition.name, definition); return async () => tools.delete(definition.name) } },
    emit() {},
  }
  return { ctx, tools, get route() { return route } }
}

function makePair(options = {}) {
  const c = context()
  const calls = []
  const replayResults = []
  let didReplay = false
  const host = createHostWebAiTransport({
    ctx: c.ctx, nativeBridgeKey: KEY,
    authorizeNativeToolRun: options.authorizeNativeToolRun ?? (async ({ exec, targetId }) => ({
      exec, targetId, providerId: 'deepseek', windowId: '11', conversationId: 'conversation-1',
      isCurrent: () => !exec.signal.aborted, root: 'C:/temp/o07', getRoot: () => 'C:/temp/o07',
      getDeniedTools: () => [], fs: options.fs ?? { resolve: async path => ({ path }), processPath: target => target.path, stat: async () => ({ type: 'directory' }) },
    })),
    runtimeFiles: options.runtimeFiles, createFileTools: options.createFileTools,
    createToolEnvelope: options.createToolEnvelope, toolManifest: options.toolManifest ?? [],
  })
  const hostFetch = async (path, init) => {
    calls.push({ path, headers: new Headers(init.headers), body: init.body })
    const response = await c.route.fetch(new Request(`http://dsh.local${path}`, init))
    const message = typeof init.body === 'string' ? JSON.parse(init.body) : null
    if (options.replayAssistantOnce && !didReplay && message?.type === 'event' && message.kind === 'assistant') {
      didReplay = true
      const replayInit = { ...init }
      const duplicate = await c.route.fetch(new Request(`http://dsh.local${path}`, replayInit))
      replayResults.push({ status: duplicate.status, body: await duplicate.json() })
      const conflictMessage = { ...message, observation: { ...message.observation, content: `${message.observation.content} changed` } }
      const conflict = await c.route.fetch(new Request(`http://dsh.local${path}`, { ...init, body: JSON.stringify(conflictMessage) }))
      replayResults.push({ status: conflict.status, body: await conflict.json() })
    }
    return response
  }
  const main = createMainWebAiTransport({ nativeBridgeKey: KEY, hostFetch, publishProgress: options.publishProgress })
  return { ...c, host, main, calls, replayResults }
}

function exec(callId) {
  const controller = new AbortController()
  return { callId, token: `token-${callId}`, rootCallId: `root-${callId}`, parent: null, signal: controller.signal, controller }
}

async function startPump(main) {
  let stop = false
  const done = (async () => {
    while (!stop) {
      try { await main.pollOnce({ timeoutMs: 20 }) }
      catch (error) { if (!stop) throw error }
    }
  })()
  return async () => { stop = true; await main.dispose(); await done }
}

async function attach(main, overrides = {}) {
  const parts = targetObjects(overrides)
  const info = await main.attachTarget({ targetId: overrides.targetId ?? 'target-1', providerId: overrides.providerId ?? 'deepseek', ...parts })
  return { ...parts, info, targetId: overrides.targetId ?? 'target-1' }
}

async function post(route, message, { key = KEY, signal } = {}) {
  return route.fetch(new Request(`http://dsh.local${WEB_AI_NATIVE_PATH}`, {
    method: 'POST', headers: { 'content-type': 'application/json', [WEB_AI_NATIVE_HEADER]: key },
    body: typeof message === 'string' ? message : JSON.stringify(message), signal,
  }))
}

test('Fetch route is fixed, requires the private header, rejects malformed bodies, and cancels a long poll', async () => {
  const c = context()
  const host = createHostWebAiTransport({ ctx: c.ctx, nativeBridgeKey: KEY, authorizeNativeToolRun: async () => ({}) })
  assert.equal(c.route.path, WEB_AI_NATIVE_PATH)
  assert.deepEqual(c.route.methods, ['POST'])
  assert.equal(c.route.requestBody, 'buffered')
  assert.equal((await post(c.route, { type: 'hello', mainInstanceId: 'main-a' }, { key: 'wrong' })).status, 401)
  const wrongPath = await c.route.fetch(new Request('http://dsh.local/api/other', { method: 'POST', headers: { [WEB_AI_NATIVE_HEADER]: KEY }, body: '{}' }))
  assert.equal(wrongPath.status, 404)
  assert.equal((await post(c.route, '{')).status, 400)
  const hello = await post(c.route, { type: 'hello', mainInstanceId: 'main-a' })
  const { hostInstanceId } = await hello.json()
  const abort = new AbortController()
  const pending = post(c.route, { type: 'next', hostInstanceId, timeoutMs: 20_000 }, { signal: abort.signal })
  setTimeout(() => abort.abort(), 5)
  const response = await pending
  assert.equal((await response.json()).command, null)
  const retainedRoute = c.route
  await host.dispose()
  assert.equal((await post(retainedRoute, { type: 'hello', mainInstanceId: 'after-close' })).status, 503)
})

test('missing native key disables the Host endpoint and native tools without cookie fallback', async () => {
  const c = context()
  const host = createHostWebAiTransport({ ctx: c.ctx, nativeBridgeKey: '', authorizeNativeToolRun: async () => ({}) })
  assert.equal(host.available, false)
  assert.equal(c.route, undefined)
  assert.equal(c.tools.size, 0)
})

test('attach validates provider origin; every ask reinspects conversation and rejects any draft or attachment', async () => {
  const p = makePair()
  await p.main.start()
  const bad = targetObjects()
  bad.webContents.url = 'https://example.invalid/'
  await assert.rejects(p.main.attachTarget({ targetId: 'bad-target', providerId: 'deepseek', ...bad }), /PROVIDER_ORIGIN_DENIED/)
  let sends = 0
  const attached = await attach(p.main, { adapter: {
    inspect: async () => ({ conversationId: 'conversation-1', draftText: '  ', attachmentCount: 0 }),
    onConversationChange: () => () => {},
    async ask() { sends++; return {} },
  } })
  const stopPump = await startPump(p.main)
  try {
    await assert.rejects(p.tools.get('tradeloom_webai_ask').execute({ targetId: attached.targetId, prompt: 'hello' }, exec('draft-call')), /ADAPTER_UNAVAILABLE/)
    assert.equal(sends, 0)
    assert.equal(p.main.statusForOwner(attached.owner, attached.targetId).available, true)
    assert.equal(p.host.targets.get(attached.targetId).windowId, String(attached.webContents.id))
  } finally { await stopPump(); await p.host.dispose() }
})

test('late initial inspection cannot revive a target after navigation; trusted reinspection can', async () => {
  const p = makePair()
  await p.main.start()
  let resolveInitial
  let inspection = 0
  const parts = targetObjects({ adapter: {
    inspect: async () => {
      inspection++
      if (inspection === 1) return new Promise(resolve => { resolveInitial = resolve })
      return { conversationId: 'conversation-2', draftText: '', attachmentCount: 0 }
    },
    onConversationChange: () => () => {}, async ask() { return {} },
  } })
  const attaching = p.main.attachTarget({ targetId: 'nav-target', providerId: 'deepseek', ...parts })
  while (!resolveInitial) await delay(0)
  parts.webContents.listeners.get('did-start-navigation')?.({}, { isMainFrame: true })
  resolveInitial({ conversationId: 'stale-conversation', draftText: '', attachmentCount: 0 })
  const result = await attaching
  assert.equal(result.available, false)
  await parts.webContents.listeners.get('did-navigate')?.({}, { isMainFrame: true })
  assert.equal(p.main.statusForOwner(parts.owner, 'nav-target').conversationId, 'conversation-2')
  assert.equal(p.main.statusForOwner(parts.owner, 'nav-target').available, true)
  await p.main.dispose(); await p.host.dispose()
})

test('Host rejects missing real ToolRun identity and extra native tool arguments; remove-target clears registration', async () => {
  let asks = 0
  const p = makePair({ authorizeNativeToolRun: async ({ targetId }) => ({
    targetId, providerId: 'deepseek', conversationId: 'conversation-1',
    isCurrent: () => true,
  }) })
  await p.main.start()
  const attached = await attach(p.main, { adapter: {
    inspect: async () => ({ conversationId: 'conversation-1', draftText: '', attachmentCount: 0 }),
    onConversationChange: () => () => {}, async ask() { asks++; return {} },
  } })
  await assert.rejects(p.tools.get('tradeloom_webai_ask').execute({ targetId: attached.targetId, prompt: 'hello', extra: true }, exec('extra-call')), /INVALID_ARGUMENTS/)
  await assert.rejects(p.tools.get('tradeloom_webai_ask').execute({ targetId: attached.targetId, prompt: 'hello' }, exec('missing-exec-call')), /NATIVE_AUTH_DENIED/)
  assert.equal(asks, 0)
  assert.equal(await p.main.detachTarget(attached.targetId, attached.webContents), true)
  assert.equal(p.host.targets.has(attached.targetId), false)
  await p.main.dispose(); await p.host.dispose()
})

test('Main disposal removes only its target registrations and aborts its own pending long poll', async () => {
  let asks = 0
  const p = makePair()
  await p.main.start()
  const attached = await attach(p.main, { adapter: {
    inspect: async () => ({ conversationId: 'conversation-1', draftText: '', attachmentCount: 0 }),
    onConversationChange: () => () => {}, async ask() { asks++; return {} },
  } })
  assert.equal(p.host.targets.has(attached.targetId), true)
  const nextOwner = { id: 2, isDestroyed: () => false }
  assert.equal(p.main.transferOwner({ targetId: attached.targetId, currentOwner: attached.owner, newOwner: nextOwner }), true)
  assert.equal(p.main.statusForOwner(nextOwner, attached.targetId).available, true)
  assert.equal(p.host.targets.has(attached.targetId), true, 'observer transfer does not dispose the transport')
  const pendingNext = p.main.pollOnce({ timeoutMs: 20_000 })
  await delay(5)
  await p.main.dispose()
  assert.equal(await pendingNext, false)
  assert.equal(p.host.targets.has(attached.targetId), false)
  assert.equal(asks, 0, 'disposal must not dispatch page work')
  await p.host.dispose()
})

test('Host and Main exchange strict JSON DTOs; exec, key, root, and grants never cross the wire', async () => {
  const p = makePair()
  await p.main.start()
  const attached = await attach(p.main)
  assert.equal(attached.info.available, true)
  const stopPump = await startPump(p.main)
  try {
    const result = await p.tools.get('tradeloom_webai_ask').execute({ targetId: 'target-1', prompt: 'hello' }, exec('call-1'))
    assert.deepEqual(result, { answer: 'done', requestId: 'call-1' })
    assert.ok(p.calls.every(call => call.path === WEB_AI_NATIVE_PATH))
    assert.ok(p.calls.every(call => call.headers.get(WEB_AI_NATIVE_HEADER) === KEY))
    assert.ok(p.calls.every(call => !String(call.body).includes(KEY) && !String(call.body).includes('C:/temp/o07') && !String(call.body).includes('"exec"')))
  } finally { await stopPump(); await p.host.dispose() }
})

test('same target serializes physical asks through Host release; observer transfer does not change target authority', async () => {
  let releaseFirst
  const firstGate = new Promise(resolve => { releaseFirst = resolve })
  let starts = 0
  const adapter = {
    inspect: async () => ({ conversationId: 'conversation-1', draftText: '', attachmentCount: 0 }),
    onConversationChange: () => () => {},
    async ask(request) {
      starts++
      if (starts === 1) await firstGate
      return observation(request, `answer-${starts}`)
    },
  }
  const p = makePair()
  await p.main.start()
  const attached = await attach(p.main, { adapter })
  const stopPump = await startPump(p.main)
  try {
    const oldOwnerStatus = p.main.statusForOwner(attached.owner, attached.targetId)
    const first = p.tools.get('tradeloom_webai_ask').execute({ targetId: attached.targetId, prompt: 'one' }, exec('call-one'))
    await delay(20)
    const second = p.tools.get('tradeloom_webai_ask').execute({ targetId: attached.targetId, prompt: 'two' }, exec('call-two'))
    await delay(30)
    assert.equal(starts, 1)
    const newOwner = { id: 2, isDestroyed: () => false }
    assert.equal(p.main.transferOwner({ targetId: attached.targetId, currentOwner: attached.owner, newOwner }), true)
    assert.equal(p.main.statusForOwner(attached.owner, attached.targetId).available, false)
    assert.equal(p.main.statusForOwner(newOwner, attached.targetId).available, true)
    assert.equal(oldOwnerStatus.generation, p.main.statusForOwner(newOwner, attached.targetId).generation)
    assert.ok(p.tools.get('tradeloom_webai_ask').output?.schema)
    assert.equal(typeof p.tools.get('tradeloom_webai_ask').output?.render, 'function')
    releaseFirst()
    assert.deepEqual(await first, { answer: 'answer-1', requestId: 'call-one' })
    await delay(20)
    assert.equal(starts, 2)
    assert.deepEqual(await second, { answer: 'answer-2', requestId: 'call-two' })
  } finally { releaseFirst(); await stopPump(); await p.host.dispose() }
})

test('native requestId replay is idempotent for the same live exec; a changed payload is rejected', async () => {
  let starts = 0
  let release
  const gate = new Promise(resolve => { release = resolve })
  const adapter = {
    inspect: async () => ({ conversationId: 'conversation-1', draftText: '', attachmentCount: 0 }), onConversationChange: () => () => {},
    async ask(request) { starts++; await gate; return observation(request, 'once') },
  }
  const p = makePair()
  await p.main.start(); const attached = await attach(p.main, { adapter })
  const stopPump = await startPump(p.main)
  try {
    const tool = p.tools.get('tradeloom_webai_ask')
    const sameExec = exec('same-call')
    const first = tool.execute({ targetId: 'target-1', prompt: 'same' }, sameExec)
    await delay(15)
    const retry = tool.execute({ targetId: 'target-1', prompt: 'same' }, sameExec)
    await assert.rejects(tool.execute({ targetId: 'target-1', prompt: 'changed' }, sameExec), /REQUEST_ID_REUSED/)
    assert.equal(starts, 1)
    release()
    assert.deepEqual(await first, await retry)
    assert.equal(starts, 1)
  } finally { release(); await stopPump(); await p.host.dispose() }
})

test('native timeout returns to Host while an abort-ignoring adapter retains the physical tail until settle', async () => {
  let releaseFirst
  const firstGate = new Promise(resolve => { releaseFirst = resolve })
  let starts = 0
  const adapter = {
    inspect: async () => ({ conversationId: 'conversation-1', draftText: '', attachmentCount: 0 }), onConversationChange: () => () => {},
    async ask(request) {
      starts++
      if (starts === 1) await firstGate
      return observation(request, `answer-${starts}`)
    },
  }
  const p = makePair()
  await p.main.start(); const attached = await attach(p.main, { adapter })
  const stopPump = await startPump(p.main)
  try {
    const tool = p.tools.get('tradeloom_webai_ask')
    const timed = tool.execute({ targetId: 'target-1', prompt: 'wait', timeoutMs: 1000 }, exec('timeout-call'))
    await delay(35)
    await assert.rejects(timed, /TIMEOUT/)
    const next = tool.execute({ targetId: 'target-1', prompt: 'next' }, exec('next-call'))
    await delay(40)
    assert.equal(starts, 1)
    releaseFirst()
    assert.deepEqual(await next, { answer: 'answer-2', requestId: 'next-call' })
    assert.equal(starts, 2)
  } finally { releaseFirst(); await stopPump(); await p.host.dispose() }
})

test('Host epoch change re-registers targets but never resends an old native ask', async () => {
  const firstContext = context()
  let activeContext = firstContext
  let epochMismatchResponses = 0
  const authorizeNativeToolRun = async ({ exec: nativeExec, targetId }) => ({
    exec: nativeExec, targetId, providerId: 'deepseek', windowId: '11', conversationId: 'conversation-1',
    isCurrent: () => !nativeExec.signal.aborted, root: 'C:/temp/o07', getRoot: () => 'C:/temp/o07', getDeniedTools: () => [],
    fs: { resolve: async path => ({ path }), processPath: target => target.path, stat: async () => ({ type: 'directory' }) },
  })
  const host1 = createHostWebAiTransport({ ctx: firstContext.ctx, nativeBridgeKey: KEY, authorizeNativeToolRun })
  const hostFetch = async (path, init) => {
    const response = await activeContext.route.fetch(new Request(`http://dsh.local${path}`, init))
    if (response.status === 409) epochMismatchResponses++
    return response
  }
  const main = createMainWebAiTransport({ nativeBridgeKey: KEY, hostFetch })
  let release
  const gate = new Promise(resolve => { release = resolve })
  let starts = 0
  const adapter = {
    inspect: async () => ({ conversationId: 'conversation-1', draftText: '', attachmentCount: 0 }), onConversationChange: () => () => {},
    async ask(request) { starts++; await gate; return observation(request, 'old response') },
  }
  await main.start(); await attach(main, { adapter })
  const stopPump = await startPump(main)
  const oldAsk = firstContext.tools.get('tradeloom_webai_ask').execute({ targetId: 'target-1', prompt: 'once' }, exec('old-call'))
  await delay(30)
  const secondContext = context()
  const host2 = createHostWebAiTransport({ ctx: secondContext.ctx, nativeBridgeKey: KEY, authorizeNativeToolRun })
  activeContext = secondContext
  try {
    const oldEpoch = host1.hostInstanceId
    await main.pollOnce({ timeoutMs: 0 })
    await delay(10)
    assert.notEqual(main.targets.size, 0)
    assert.notEqual(host2.hostInstanceId, oldEpoch)
    assert.ok(epochMismatchResponses >= 1)
    await delay(30)
    assert.equal(starts, 1)
    release()
    await delay(30)
    assert.equal(starts, 1)
    await host1.dispose()
    await assert.rejects(oldAsk)
  } finally {
    release()
    await stopPump()
    await host1.dispose()
    await host2.dispose()
  }
})

test('withFiles composes shared filetools/envelope factories in Host and continues the same Main conversation', async () => {
  const fileToolsModule = await import('@tradeloom/dsh-business-shell/webai-file-tools')
  const envelopeModule = await import('@tradeloom/dsh-business-shell/webai-tool-envelope')
  const memory = new Map([['notes.txt', 'private note']])
  const calls = []
  const runtimeCapability = Object.freeze({ hostFixture: true })
  const runtimeFiles = {
    async bind(binding) { calls.push(['bind', binding]); return runtimeCapability },
    async execute(capability, request) {
      assert.equal(capability, runtimeCapability)
      calls.push(['execute', request])
      if (bindingDenied.includes(request.op)) return { ok: false, error: { code: 'TOOL_DENIED' } }
      if (request.path.startsWith('../') || request.path.startsWith('/')) return { ok: false, error: { code: 'INVALID_PATH' } }
      if (request.op === 'read') return memory.has(request.path) ? { ok: true, content: memory.get(request.path) } : { ok: false, error: { code: 'FS_NOT_FOUND' } }
      if (request.op === 'write_new') {
        if (memory.has(request.path)) return { ok: false, error: { code: 'ALREADY_EXISTS' } }
        memory.set(request.path, request.content); return { ok: true, created: true }
      }
      return { ok: false, error: { code: 'TOOL_DENIED' } }
    },
    revoke: capability => calls.push(['revoke', capability]),
  }
  let bindingDenied = []
  const fs = { resolve: async path => ({ path }), processPath: value => value.path, stat: async () => ({ type: 'directory' }) }
  const p = makePair({
    fs, runtimeFiles, createFileTools: fileToolsModule.createWebAiFileTools,
    createToolEnvelope: envelopeModule.createWebAiToolEnvelope, toolManifest: envelopeModule.WEB_AI_TOOL_MANIFEST,
    replayAssistantOnce: true,
    authorizeNativeToolRun: async ({ exec: nativeExec, targetId }) => ({
      exec: nativeExec, targetId, providerId: 'deepseek', windowId: '11', conversationId: 'conversation-1', root: 'C:/temp/o07',
      fs, getRoot: () => 'C:/temp/o07', isCurrent: () => !nativeExec.signal.aborted,
      getDeniedTools: () => bindingDenied,
    }),
  })
  let sequence = 0
  const adapter = {
    inspect: async () => ({ conversationId: 'conversation-1', draftText: '', attachmentCount: 0 }), onConversationChange: () => () => {},
    async ask(request) {
      if (request.prompt === 'wrong task id') return observation(request, JSON.stringify({ version: 1, kind: 'tradeloom-file-task', taskId: 'other-task', requestId: 'bad-read', op: 'read', path: 'notes.txt' }))
      assert.deepEqual(request.fileTask.manifest, envelopeModule.WEB_AI_TOOL_MANIFEST)
      return observation(request, JSON.stringify({ version: 1, kind: 'tradeloom-file-task', taskId: request.fileTask.taskId, requestId: 'file-read-1', op: 'read', path: 'notes.txt' }))
    },
    async continueWithToolResult(request) {
      calls.push(['continue', request])
      sequence++
      if (sequence === 1) return observation(request, JSON.stringify({ version: 1, kind: 'tradeloom-file-task', taskId: request.taskId, requestId: 'file-write-1', op: 'write_new', path: 'created.txt', content: 'new' }), 'message-write')
      return observation(request, 'read and write completed', 'message-final')
    },
  }
  await p.main.start(); const attached = await attach(p.main, { adapter })
  const stopPump = await startPump(p.main)
  try {
    const result = await p.tools.get('tradeloom_webai_ask').execute({ targetId: 'target-1', prompt: 'Read then write', withFiles: true }, exec('file-call'))
    assert.deepEqual(result, { answer: 'read and write completed', requestId: 'file-call' })
    const targetDto = p.calls.map(call => JSON.parse(call.body)).find(message => message.type === 'target')
    assert.equal(targetDto.windowId, String(attached.webContents.id))
    const askDto = p.calls.map(call => JSON.parse(call.body)).find(message => message.type === 'event')
    assert.ok(askDto)
    assert.equal(Object.hasOwn(askDto, 'exec'), false)
    assert.equal(Object.hasOwn(askDto, 'root'), false)
    for (let attempt = 0; attempt < 20 && p.host.jobs.size; attempt++) await delay(1)
    assert.equal(p.host.jobs.size, 0, 'Host job is retained until native end and Main physical settled')
    assert.equal(p.replayResults[0].status, 200)
    assert.equal(p.replayResults[0].body.duplicate, true)
    assert.equal(p.replayResults[1].status, 409)
    assert.equal(p.replayResults[1].body.error.code, 'MESSAGE_ID_CONFLICT')
    assert.equal(memory.get('created.txt'), 'new')
    assert.deepEqual(calls.filter(([kind]) => kind === 'execute').map(([, request]) => request.op), ['read', 'write_new'])
    assert.ok(calls.some(([kind]) => kind === 'bind' && kind === 'bind'))
    assert.equal(calls.filter(([kind]) => kind === 'revoke').length, 1)
    await assert.rejects(p.tools.get('tradeloom_webai_ask').execute({ targetId: 'target-1', prompt: 'wrong task id', withFiles: true }, exec('wrong-task-call')), /TASK_MISMATCH/)
    assert.deepEqual(calls.filter(([kind]) => kind === 'execute').map(([, request]) => request.op), ['read', 'write_new'], 'duplicate wire delivery and wrong task ID cause no extra file execution')
    assert.equal(calls.filter(([kind]) => kind === 'revoke').length, 2)
    const continuations = calls.filter(([kind, request]) => kind === 'continue' && request.requestId === 'file-call').map(([, request]) => request)
    assert.equal(continuations.length, 2)
    assert.ok(continuations.every(request => request.requestId === 'file-call' && request.taskNonce && request.conversationId === 'conversation-1'))
    assert.ok(!JSON.stringify(p.calls.map(call => call.body)).includes('C:/temp/o07'))
  } finally { await stopPump(); await p.host.dispose() }
})

