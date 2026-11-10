import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createWebAiNativeBridge, WEB_AI_PROVIDER_ORIGINS } from './bridge.mjs'

const require = createRequire(import.meta.url)
const { createWebAiPreloadApi } = require('./preload.cjs')

class FakeContents extends EventEmitter {
  constructor(id, url) {
    super()
    this.id = id
    this.url = url
    this.sent = []
    this.destroyed = false
  }
  getURL() { return this.url }
  isDestroyed() { return this.destroyed }
  send(channel, payload) { this.sent.push({ channel, payload }) }
}

function makeAdapter({ inspect, ask, onConversationChange } = {}) {
  let onChange = onConversationChange
  return {
    inspect: inspect ?? (async () => ({ conversationId: 'conversation-1', draftText: '', attachmentCount: 0 })),
    ask: ask ?? (async request => observation(request)),
    onConversationChange(listener) { onChange = listener; return () => { onChange = undefined } },
    changeConversation(id) { onChange?.({ conversationId: id }) },
  }
}

function observation(request, extra = {}) {
  return {
    source: 'native-assistant-observation', role: 'assistant', isNew: true,
    conversationId: request.conversationId, taskNonce: request.taskNonce,
    requestId: request.requestId, messageId: `message-${request.requestId}`,
    content: 'done', complete: true, ...extra,
  }
}

function harness({ adapter, authorizeNativeToolRun, runtimeFiles, createFileTools, createToolEnvelope, toolManifest } = {}) {
  const owner = new FakeContents(101, 'dsh-app://app/source-shell/renderer/source-entry.html')
  const provider = new FakeContents(202, WEB_AI_PROVIDER_ORIGINS.deepseek + '/conversation/1')
  const exec = { signal: new AbortController().signal, live: true, webContents: provider }
  const bridge = createWebAiNativeBridge({
    authorizeNativeToolRun: authorizeNativeToolRun ?? (async ({ exec: value }) => ({
      exec: value, webContents: value.webContents ?? provider, isCurrent: () => value.live,
      fs: { resolve() {}, processPath() {}, stat() {} },
      getRoot: () => 'C:/isolated/workspace', getDeniedTools: () => ['shell.exec'],
    })),
    runtimeFiles, createFileTools, createToolEnvelope, toolManifest,
  })
  const attached = bridge.attachProvider({ providerId: 'deepseek', ownerWebContents: owner, webContents: provider, adapter })
  return { bridge, owner, provider, exec, targetId: attached.targetId }
}

test('attaches only allowed provider origin and authorizes status by exact owner object', () => {
  const owner = new FakeContents(1, 'dsh-app://app/')
  const provider = new FakeContents(2, 'https://evil.example/')
  const bridge = createWebAiNativeBridge()
  assert.throws(() => bridge.attachProvider({ providerId: 'deepseek', ownerWebContents: owner, webContents: provider, adapter: makeAdapter() }), /ORIGIN_NOT_ALLOWED/)

  const h = harness({ adapter: makeAdapter() })
  assert.equal(h.bridge.statusForOwner(h.owner, h.targetId).status.available, false)
  assert.equal(h.bridge.statusForOwner(h.owner, h.targetId).status.reason, 'CONVERSATION_UNAVAILABLE')
  assert.throws(() => h.bridge.attachProvider({
    providerId: 'deepseek', ownerWebContents: new FakeContents(111, 'dsh-app://app/'),
    webContents: h.provider, adapter: makeAdapter(),
  }), /ALREADY_ATTACHED/)
  assert.deepEqual(h.bridge.statusForOwner(new FakeContents(101, h.owner.getURL()), h.targetId), {
    ok: false, error: { code: 'FORBIDDEN' },
  })
})

test('IPC status handler rejects any sender except the exact attached owner', () => {
  const h = harness({ adapter: makeAdapter() })
  let registered
  const removed = []
  h.bridge.registerIpc({ handle: (channel, handler) => { registered = { channel, handler } }, removeHandler: channel => removed.push(channel) })
  assert.equal(registered.handler({ sender: new FakeContents(101, h.owner.getURL()) }, h.targetId).error.code, 'FORBIDDEN')
  assert.equal(registered.handler({ sender: h.owner }, h.targetId).ok, true)
  h.bridge.detachProvider(h.targetId, h.provider)
  registered.handler({ sender: h.owner }, h.targetId)
})

test('adapter absence and dirty draft fail closed; whitespace is still a draft', async () => {
  const noAdapter = harness()
  assert.equal(noAdapter.bridge.statusForOwner(noAdapter.owner, noAdapter.targetId).status.reason, 'ADAPTER_UNAVAILABLE')
  noAdapter.provider.emit('will-navigate')
  noAdapter.provider.url = WEB_AI_PROVIDER_ORIGINS.deepseek + '/conversation/2'
  noAdapter.provider.emit('did-navigate')
  assert.equal(noAdapter.bridge.statusForOwner(noAdapter.owner, noAdapter.targetId).status.reason, 'ADAPTER_UNAVAILABLE')

  const h = harness({ adapter: makeAdapter({ inspect: async () => ({ conversationId: 'conversation-1', draftText: ' ', attachmentCount: 0 }) }) })
  const result = await h.bridge.askFromNative({ exec: h.exec, providerId: 'deepseek', requestId: 'draft-1', prompt: 'hello' })
  assert.equal(result.error.code, 'DRAFT_PRESENT')
})

test('native ask requires exact complete final observation and preserves task identity', async () => {
  let seen
  const h = harness({ adapter: makeAdapter({ ask: async request => { seen = request; return observation(request) } }) })
  const result = await h.bridge.askFromNative({ exec: h.exec, providerId: 'deepseek', requestId: 'ask-1', prompt: 'hello' })
  assert.equal(result.ok, true)
  assert.equal(result.conversationId, 'conversation-1')
  assert.equal(seen.requestId, 'ask-1')
  assert.equal(seen.conversationId, 'conversation-1')
  assert.ok(seen.taskNonce)

  const bad = harness({ adapter: makeAdapter({ ask: async request => observation(request, { taskNonce: '' }) }) })
  const rejected = await bad.bridge.askFromNative({ exec: bad.exec, providerId: 'deepseek', requestId: 'ask-2', prompt: 'hello' })
  assert.equal(rejected.error.code, 'INCOMPLETE_RESPONSE')

  const reused = harness({ adapter: makeAdapter() })
  assert.equal((await reused.bridge.askFromNative({ exec: reused.exec, providerId: 'deepseek', requestId: 'same-id', prompt: 'hello' })).ok, true)
  const otherExec = { signal: new AbortController().signal, live: true }
  const deniedReuse = await reused.bridge.askFromNative({ exec: otherExec, providerId: 'deepseek', requestId: 'same-id', prompt: 'hello' })
  assert.equal(deniedReuse.error.code, 'REQUEST_ID_REUSED')
})

test('completed request cache does not cross detach and reattach', async () => {
  const h = harness({ adapter: makeAdapter() })
  assert.equal((await h.bridge.askFromNative({ exec: h.exec, providerId: 'deepseek', requestId: 'reused-after-detach', prompt: 'first' })).ok, true)
  h.bridge.detachProvider(h.targetId, h.provider)
  const attached = h.bridge.attachProvider({ providerId: 'deepseek', ownerWebContents: h.owner, webContents: h.provider, adapter: makeAdapter() })
  const result = await h.bridge.askFromNative({ exec: h.exec, providerId: 'deepseek', requestId: 'reused-after-detach', prompt: 'second' })
  assert.equal(result.ok, true)
  h.bridge.detachProvider(attached.targetId, h.provider)
})

test('live execution request retry is idempotent and stale settled records do not impose a lifetime cap', async () => {
  let methodCalls = 0
  let methodHarness
  const contexts = new WeakMap()
  methodHarness = harness({
    adapter: makeAdapter({ ask: async request => { methodCalls += 1; return observation(request) } }),
    authorizeNativeToolRun: async ({ exec }) => {
      let context = contexts.get(exec)
      if (!context) {
        context = { exec, webContents: methodHarness.provider, current: true, isCurrent() { return this.current } }
        contexts.set(exec, context)
      }
      return context
    },
  })
  const methodFirst = await methodHarness.bridge.askFromNative({
    exec: methodHarness.exec, providerId: 'deepseek', requestId: 'method-bound-retry', prompt: 'same',
  })
  const methodRetry = await methodHarness.bridge.askFromNative({
    exec: methodHarness.exec, providerId: 'deepseek', requestId: 'method-bound-retry', prompt: 'same',
  })
  assert.equal(methodFirst.ok, true)
  assert.deepEqual(methodRetry, methodFirst)
  assert.equal(methodCalls, 1)
  methodHarness.bridge.detachProvider(methodHarness.targetId, methodHarness.provider)

  let calls = 0
  const h = harness({ adapter: makeAdapter({ ask: async request => { calls += 1; return observation(request) } }) })
  const first = await h.bridge.askFromNative({ exec: h.exec, providerId: 'deepseek', requestId: 'live-retry', prompt: 'same' })
  const retry = await h.bridge.askFromNative({ exec: h.exec, providerId: 'deepseek', requestId: 'live-retry', prompt: 'same' })
  assert.equal(first.ok, true)
  assert.deepEqual(retry, first)
  assert.equal(calls, 1)

  for (let index = 0; index < 260; index += 1) {
    const exec = { signal: new AbortController().signal, live: true, webContents: h.provider }
    const result = await h.bridge.askFromNative({
      exec, providerId: 'deepseek', requestId: `completed-${index}`, prompt: 'next',
    })
    assert.equal(result.ok, true)
    exec.live = false
  }
  assert.equal(calls, 261)
  h.bridge.detachProvider(h.targetId, h.provider)
})

test('timed-out unsettled request stays recorded until its physical operation settles', async () => {
  let releaseFirst
  let calls = 0
  const h = harness({ adapter: makeAdapter({ ask: request => {
    calls += 1
    if (calls === 1) return new Promise(resolve => { releaseFirst = () => resolve(observation(request)) })
    return Promise.resolve(observation(request))
  } }) })
  const timedOut = await h.bridge.askFromNative({
    exec: h.exec, providerId: 'deepseek', requestId: 'deferred-retry', prompt: 'same', timeoutMs: 10,
  })
  assert.equal(timedOut.error.code, 'TIMEOUT')
  h.exec.live = false

  const blockedExec = { signal: new AbortController().signal, live: true, webContents: h.provider }
  const blocked = await h.bridge.askFromNative({
    exec: blockedExec, providerId: 'deepseek', requestId: 'deferred-retry', prompt: 'same', timeoutMs: 1000,
  })
  assert.equal(blocked.error.code, 'REQUEST_ID_REUSED')
  assert.equal(calls, 1)

  releaseFirst()
  await new Promise(resolve => setImmediate(resolve))
  const retryExec = { signal: new AbortController().signal, live: true, webContents: h.provider }
  const retried = await h.bridge.askFromNative({
    exec: retryExec, providerId: 'deepseek', requestId: 'deferred-retry', prompt: 'same', timeoutMs: 1000,
  })
  assert.equal(retried.ok, true)
  assert.equal(calls, 2)
  h.bridge.detachProvider(h.targetId, h.provider)
})

test('same numeric provider id on a different WebContents object is not the attached target', async () => {
  const h = harness({ adapter: makeAdapter() })
  const impostor = new FakeContents(h.provider.id, h.provider.getURL())
  h.exec.webContents = impostor
  const result = await h.bridge.askFromNative({ exec: h.exec, providerId: 'deepseek', requestId: 'same-number', prompt: 'hello' })
  assert.equal(result.error.code, 'PROVIDER_UNAVAILABLE')
})

test('pre-aborted native execution is rejected before provider work', async () => {
  let asked = false
  const h = harness({ adapter: makeAdapter({ ask: async request => { asked = true; return observation(request) } }) })
  const controller = new AbortController()
  controller.abort()
  const result = await h.bridge.askFromNative({ exec: { signal: controller.signal }, providerId: 'deepseek', requestId: 'abort-1', prompt: 'hello' })
  assert.equal(result.error.code, 'CANCELLED')
  assert.equal(asked, false)
})

test('missing live conversation is rejected before sending', async () => {
  let asked = false
  const h = harness({ adapter: makeAdapter({
    inspect: async () => ({ conversationId: '', draftText: '', attachmentCount: 0 }),
    ask: async request => { asked = true; return observation(request) },
  }) })
  const result = await h.bridge.askFromNative({ exec: h.exec, providerId: 'deepseek', requestId: 'no-conversation', prompt: 'hello' })
  assert.equal(result.error.code, 'CONVERSATION_UNAVAILABLE')
  assert.equal(asked, false)
})

test('timeout does not release physical target queue across detach and reattach', async () => {
  let resolveFirst
  let calls = 0
  let active = 0
  let maxActive = 0
  const firstAdapter = makeAdapter({ ask: request => {
    calls += 1; active += 1; maxActive = Math.max(maxActive, active)
    return new Promise(resolve => { resolveFirst = value => { active -= 1; resolve(value ?? observation(request)) } })
  } })
  const h = harness({
    adapter: firstAdapter,
    authorizeNativeToolRun: async ({ exec }) => ({ exec, webContents: exec.webContents, isCurrent: () => true }),
  })
  const first = await h.bridge.askFromNative({ exec: h.exec, providerId: 'deepseek', requestId: 'slow-1', prompt: 'first', timeoutMs: 10 })
  assert.equal(first.error.code, 'TIMEOUT')
  assert.equal(calls, 1)

  h.bridge.detachProvider(h.targetId, h.provider)
  const nextOwner = new FakeContents(303, 'dsh-app://app/source-shell/renderer/source-entry.html')
  const secondAdapter = makeAdapter({ ask: async request => {
    calls += 1; active += 1; maxActive = Math.max(maxActive, active)
    try { return observation(request) } finally { active -= 1 }
  } })
  const attached = h.bridge.attachProvider({ providerId: 'deepseek', ownerWebContents: nextOwner, webContents: h.provider, adapter: secondAdapter })
  const secondExec = { signal: new AbortController().signal, live: true, webContents: h.provider }
  const secondPromise = h.bridge.askFromNative({ exec: secondExec, providerId: 'deepseek', requestId: 'slow-2', prompt: 'second', timeoutMs: 1000 })
  await new Promise(resolve => setTimeout(resolve, 15))
  assert.equal(calls, 1)
  resolveFirst()
  const second = await secondPromise
  assert.equal(second.ok, true)
  assert.equal(calls, 2)
  assert.equal(maxActive, 1)
  h.bridge.detachProvider(attached.targetId, h.provider)
})

test('beginFileTask can return on exec cancellation while a prior detached target still owns the physical tail', async () => {
  let releaseFirst
  const firstAdapter = makeAdapter({ ask: request => new Promise(resolve => { releaseFirst = () => resolve(observation(request)) }) })
  const h = harness({
    adapter: firstAdapter,
    authorizeNativeToolRun: async ({ exec }) => ({ exec, webContents: exec.webContents, isCurrent: () => true }),
  })
  const first = h.bridge.askFromNative({ exec: h.exec, providerId: 'deepseek', requestId: 'tail-holder', prompt: 'hold', timeoutMs: 1000 })
  while (!releaseFirst) await new Promise(resolve => setImmediate(resolve))
  h.bridge.detachProvider(h.targetId, h.provider)

  const owner2 = new FakeContents(505, 'dsh-app://app/source-shell/renderer/source-entry.html')
  const attached = h.bridge.attachProvider({ providerId: 'deepseek', ownerWebContents: owner2, webContents: h.provider, adapter: makeAdapter() })
  const abort = new AbortController()
  const exec2 = { signal: abort.signal, webContents: h.provider }
  const begin = h.bridge.beginFileTask({ exec: exec2, providerId: 'deepseek' })
  await new Promise(resolve => setImmediate(resolve))
  abort.abort()
  assert.equal((await begin).error.code, 'CANCELLED')

  releaseFirst()
  assert.equal((await first).ok, false)
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(h.bridge.statusForOwner(owner2, attached.targetId).status.busy, false)
  h.bridge.detachProvider(attached.targetId, h.provider)
})

test('aborted queued request is cleaned up and never reaches provider after prior operation settles', async () => {
  let releaseFirst
  let calls = 0
  const adapter = makeAdapter({ ask: request => {
    calls += 1
    if (calls === 1) return new Promise(resolve => { releaseFirst = () => resolve(observation(request)) })
    return Promise.resolve(observation(request))
  } })
  const h = harness({ adapter })
  const firstPromise = h.bridge.askFromNative({ exec: h.exec, providerId: 'deepseek', requestId: 'queue-first', prompt: 'first', timeoutMs: 1000 })
  while (!releaseFirst) await new Promise(resolve => setImmediate(resolve))

  const abortController = new AbortController()
  const queued = h.bridge.askFromNative({ exec: h.exec, providerId: 'deepseek', requestId: 'queue-aborted', prompt: 'second', timeoutMs: 1000, signal: abortController.signal })
  abortController.abort()
  const canceled = await queued
  assert.equal(canceled.error.code, 'CANCELLED')
  releaseFirst()
  assert.equal((await firstPromise).ok, true)
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(calls, 1)
  assert.equal(h.bridge.statusForOwner(h.owner, h.targetId).status.busy, false)

  const next = await h.bridge.askFromNative({ exec: h.exec, providerId: 'deepseek', requestId: 'queue-next', prompt: 'third' })
  assert.equal(next.ok, true)
  assert.equal(calls, 2)
})

test('queued file-task preparation returns on native cancellation but retains physical tail', async () => {
  let releaseFirst
  let providerCalls = 0
  const firstAdapter = makeAdapter({ ask: request => {
    providerCalls += 1
    return new Promise(resolve => { releaseFirst = () => resolve(observation(request)) })
  } })
  const h = harness({
    adapter: firstAdapter,
    authorizeNativeToolRun: async ({ exec }) => ({
      exec, webContents: exec.webContents, isCurrent: () => true,
      fs: { resolve() {}, processPath() {}, stat() {} },
      getRoot: () => 'C:/isolated/workspace', getDeniedTools: () => [],
    }),
  })
  const first = h.bridge.askFromNative({ exec: h.exec, providerId: 'deepseek', requestId: 'file-tail-holder', prompt: 'hold', timeoutMs: 1000 })
  while (!releaseFirst) await new Promise(resolve => setImmediate(resolve))

  h.bridge.detachProvider(h.targetId, h.provider)
  const owner2 = new FakeContents(404, 'dsh-app://app/source-shell/renderer/source-entry.html')
  const provider2Adapter = makeAdapter()
  const attached = h.bridge.attachProvider({ providerId: 'deepseek', ownerWebContents: owner2, webContents: h.provider, adapter: provider2Adapter })
  const abort = new AbortController()
  const exec2 = { signal: abort.signal, webContents: h.provider }
  const begin = h.bridge.beginFileTask({ exec: exec2, providerId: 'deepseek' })
  await new Promise(resolve => setImmediate(resolve))
  abort.abort()
  assert.equal((await begin).error.code, 'CANCELLED')
  assert.equal(providerCalls, 1)

  releaseFirst()
  assert.equal((await first).ok, false)
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(h.bridge.statusForOwner(owner2, attached.targetId).status.busy, false)
  h.bridge.detachProvider(attached.targetId, h.provider)
})

test('provider destruction detaches target and invalidates in-flight work', async () => {
  let release
  const h = harness({ adapter: makeAdapter({ ask: request => new Promise(resolve => { release = () => resolve(observation(request)) }) }) })
  const request = h.bridge.askFromNative({ exec: h.exec, providerId: 'deepseek', requestId: 'destroy-1', prompt: 'hello', timeoutMs: 1000 })
  while (!release) await new Promise(resolve => setImmediate(resolve))
  h.provider.destroyed = true
  h.provider.emit('destroyed')
  release()
  assert.equal((await request).ok, false)
  assert.equal(h.bridge.statusForOwner(h.owner, h.targetId).error.code, 'FORBIDDEN')
})

test('owner transfer preserves an in-flight ask and file grant bound to the provider WebContents', async () => {
  let releaseAsk
  let askRequest
  let continued
  let grantBinding
  let taskBinding
  let runtimeRevokes = 0
  let envelopeRevokes = 0
  const grant = Object.freeze({ grant: true })
  const runtimeCapability = Object.freeze({ capability: true })
  const adapter = makeAdapter({ ask: request => new Promise(resolve => {
    askRequest = request
    releaseAsk = () => resolve(observation(request, { content: 'file tool result request' }))
  }) })
  adapter.continueWithToolResult = async request => {
    continued = request
    return observation({
      requestId: request.requestId,
      taskNonce: request.taskNonce,
      conversationId: request.conversationId,
    }, { messageId: 'owner-transfer-final', content: 'owner transfer preserved this reply' })
  }
  const runtimeFiles = {
    bind: async request => { assert.equal(request.exec, exec); return runtimeCapability },
    execute: async () => ({ ok: true, content: 'fixture result' }),
    revoke: value => { assert.equal(value, runtimeCapability); runtimeRevokes += 1 },
  }
  let exec
  const createFileTools = ({ createScopedExecutor }) => {
    let scoped
    return {
      issueGrant: async request => {
        grantBinding = request
        scoped = await createScopedExecutor({ root: request.root, ttlMs: 1000 })
        return grant
      },
      revoke: async value => { assert.equal(value, grant); await scoped.revoke() },
    }
  }
  const createToolEnvelope = ({ fileTools }) => ({
    issueTask: request => { taskBinding = request; return { task: true } },
    observeAssistantMessage: async (_capability, message) => message.content === 'file tool result request' ? ({
      status: 'completed', requestId: 'file-read-1',
      source: message.source, conversationId: message.conversationId, taskNonce: message.taskNonce,
    }) : ({ status: 'rejected', error: { code: 'INVALID_ENVELOPE' } }),
    revokeTask: () => { envelopeRevokes += 1; return fileTools.revoke(grant) },
  })
  const auth = async ({ exec: value }) => ({
    exec: value,
    webContents: value.webContents,
    isCurrent: () => value.live === true,
    fs: { resolve() {}, processPath() {}, stat() {} },
    getRoot: () => 'C:/isolated/workspace',
    getDeniedTools: () => ['shell.exec'],
  })
  const h = harness({
    adapter, authorizeNativeToolRun: auth, runtimeFiles, createFileTools,
    createToolEnvelope, toolManifest: { tools: [{ name: 'read' }] },
  })
  exec = h.exec
  const started = await h.bridge.beginFileTask({ exec, providerId: 'deepseek' })
  assert.equal(started.ok, true)
  assert.equal(grantBinding.windowId, String(h.provider.id))
  assert.equal(taskBinding.windowId, String(h.provider.id))

  const askPromise = h.bridge.askFromNative({
    exec, providerId: 'deepseek', requestId: 'transfer-request-1', prompt: 'Read the file.',
    fileTaskToken: started.fileTaskToken, timeoutMs: 1000,
  })
  while (!releaseAsk) await new Promise(resolve => setImmediate(resolve))
  const oldProgressCount = h.owner.sent.length
  const owner2 = new FakeContents(909, 'dsh-app://app/source-shell/renderer/source-entry.html')
  assert.equal(h.bridge.transferOwner({
    targetId: h.targetId,
    currentOwner: new FakeContents(h.owner.id, h.owner.getURL()),
    newOwner: owner2,
  }).error.code, 'FORBIDDEN')
  assert.deepEqual(h.bridge.transferOwner({ targetId: h.targetId, currentOwner: h.owner, newOwner: owner2 }), {
    ok: true, targetId: h.targetId,
  })
  assert.equal(h.bridge.statusForOwner(h.owner, h.targetId).error.code, 'FORBIDDEN')
  assert.equal(h.bridge.statusForOwner(owner2, h.targetId).status.available, true)

  releaseAsk()
  const result = await askPromise
  assert.equal(result.ok, true, JSON.stringify(result))
  assert.equal(result.text, 'owner transfer preserved this reply')
  assert.equal(askRequest.conversationId, 'conversation-1')
  assert.equal(askRequest.requestId, 'transfer-request-1')
  assert.equal(askRequest.taskNonce, started.taskNonce)
  assert.equal(continued.requestId, 'transfer-request-1')
  assert.equal(continued.conversationId, 'conversation-1')
  assert.equal(continued.taskNonce, started.taskNonce)
  assert.equal(h.owner.sent.length, oldProgressCount)
  assert.equal(owner2.sent.some(item => item.payload.phase === 'completed'), true)
  assert.equal(envelopeRevokes, 1)
  assert.equal(runtimeRevokes, 1)
  h.bridge.detachProvider(h.targetId, h.provider)
})

test('owner destruction only removes observation; an authorized ask still completes', async () => {
  let release
  const h = harness({ adapter: makeAdapter({ ask: request => new Promise(resolve => { release = () => resolve(observation(request)) }) }) })
  const pending = h.bridge.askFromNative({ exec: h.exec, providerId: 'deepseek', requestId: 'owner-close-1', prompt: 'hello', timeoutMs: 1000 })
  while (!release) await new Promise(resolve => setImmediate(resolve))
  const beforeClose = h.owner.sent.length
  h.owner.destroyed = true
  h.owner.emit('destroyed')
  assert.equal(h.bridge.statusForOwner(h.owner, h.targetId).error.code, 'FORBIDDEN')
  release()
  assert.equal((await pending).ok, true)
  assert.equal(h.owner.sent.length, beforeClose)
  h.bridge.detachProvider(h.targetId, h.provider)
})

test('conversation and native permission changes still invalidate in-flight work', async () => {
  let releaseConversation
  const conversationAdapter = makeAdapter({ ask: request => new Promise(resolve => { releaseConversation = () => resolve(observation(request)) }) })
  const conversationHarness = harness({ adapter: conversationAdapter })
  const conversationAsk = conversationHarness.bridge.askFromNative({
    exec: conversationHarness.exec, providerId: 'deepseek', requestId: 'conversation-change-1', prompt: 'hello', timeoutMs: 1000,
  })
  while (!releaseConversation) await new Promise(resolve => setImmediate(resolve))
  conversationAdapter.changeConversation('conversation-2')
  releaseConversation()
  assert.equal((await conversationAsk).ok, false)

  let releasePermission
  const permissionHarness = harness({ adapter: makeAdapter({ ask: request => new Promise(resolve => { releasePermission = () => resolve(observation(request)) }) }) })
  const permissionAsk = permissionHarness.bridge.askFromNative({
    exec: permissionHarness.exec, providerId: 'deepseek', requestId: 'permission-change-1', prompt: 'hello', timeoutMs: 1000,
  })
  while (!releasePermission) await new Promise(resolve => setImmediate(resolve))
  permissionHarness.exec.live = false
  releasePermission()
  assert.equal((await permissionAsk).error.code, 'TASK_NOT_CURRENT')
})

test('inspect result cannot overwrite conversation state after navigation while inspect is pending', async () => {
  let releaseInspect
  let inspectCalls = 0
  const adapter = makeAdapter({ inspect: async () => {
    inspectCalls += 1
    if (inspectCalls === 1) return new Promise(resolve => { releaseInspect = () => resolve({ conversationId: 'old-conversation', draftText: '', attachmentCount: 0 }) })
    return { conversationId: 'new-conversation', draftText: '', attachmentCount: 0 }
  }, ask: async request => observation(request) })
  const h = harness({ adapter })
  const execA = { signal: new AbortController().signal, live: true }
  const first = h.bridge.askFromNative({ exec: execA, providerId: 'deepseek', requestId: 'inspect-old', prompt: 'old', timeoutMs: 1000 })
  while (!releaseInspect) await new Promise(resolve => setImmediate(resolve))
  h.provider.emit('will-navigate')
  h.provider.url = WEB_AI_PROVIDER_ORIGINS.deepseek + '/conversation/2'
  h.provider.emit('did-navigate')
  releaseInspect()
  assert.equal((await first).ok, false)
  assert.equal(h.bridge.statusForOwner(h.owner, h.targetId).status.available, false)

  const execB = { signal: new AbortController().signal, live: true }
  const next = await h.bridge.askFromNative({ exec: execB, providerId: 'deepseek', requestId: 'inspect-new', prompt: 'new' })
  assert.equal(next.ok, true)
  assert.equal(next.conversationId, 'new-conversation')
  assert.equal(h.bridge.statusForOwner(h.owner, h.targetId).status.available, true)
})

test('async grant is revoked if provider navigates while grant is being created', async () => {
  let releaseGrant
  let revoked = 0
  const capability = { key: 'private-in-test' }
  const runtimeFiles = {
    bind: async request => { assert.equal(request.exec, execRef); return capability },
    execute: async () => ({ ok: true }),
    revoke: async value => { assert.equal(value, capability) },
  }
  let execRef
  const createFileTools = ({ createScopedExecutor }) => {
    let scoped
    return {
      issueGrant: async ({ root }) => {
        assert.equal(root, 'C:/isolated/workspace')
        scoped = await createScopedExecutor({ root, ttlMs: 1000 })
        return new Promise(resolve => { releaseGrant = resolve })
      },
      revoke: async () => { revoked += 1; await scoped.revoke() },
    }
  }
  const createToolEnvelope = () => ({ issueTask: () => ({}), observeAssistantMessage: async () => ({}), revokeTask() {} })
  const h = harness({ adapter: makeAdapter(), runtimeFiles, createFileTools, createToolEnvelope, toolManifest: { tools: [] } })
  execRef = h.exec
  const pending = h.bridge.beginFileTask({ exec: h.exec, providerId: 'deepseek' })
  for (let attempt = 0; attempt < 100 && !releaseGrant; attempt += 1) await new Promise(resolve => setTimeout(resolve, 1))
  assert.ok(releaseGrant, 'async issueGrant should begin after native runtime bind')
  h.provider.emit('will-navigate')
  h.provider.url = 'https://chat.deepseek.com/conversation/2'
  h.provider.emit('did-navigate')
  releaseGrant({ opaque: true })
  const result = await pending
  assert.equal(result.ok, false)
  assert.equal(revoked, 1)
})

test('file task composes injected runtime, grant, envelope, and manifest then revokes', async () => {
  const cap = {}
  const grant = { opaque: true }
  const calls = []
  const runtimeFiles = {
    bind: async request => { calls.push(['bind', request]); return cap },
    execute: async (value, request) => { calls.push(['execute', value, request]); return { ok: true } },
    revoke: async value => { calls.push(['runtimeRevoke', value]) },
  }
  const createFileTools = ({ createScopedExecutor }) => {
    let scoped
    return {
      issueGrant: async request => {
        calls.push(['issueGrant', request])
        scoped = await createScopedExecutor({ root: request.root, ttlMs: 1000 })
        return grant
      },
      revoke: async value => { calls.push(['grantRevoke', value]); await scoped.revoke() },
    }
  }
  const createToolEnvelope = ({ fileTools }) => ({
    issueTask: input => { calls.push(['issueTask', input]); return { capability: true } },
    observeAssistantMessage: async (_capability, value) => {
      calls.push(['observe', value])
      return { status: 'rejected', error: { code: 'INVALID_ENVELOPE' } }
    },
    revokeTask: () => { calls.push(['revokeTask']); return fileTools.revoke(grant) },
  })
  const adapter = makeAdapter({ ask: async request => observation(request) })
  const h = harness({ adapter, runtimeFiles, createFileTools, createToolEnvelope, toolManifest: { tools: [{ name: 'read' }] } })
  const started = await h.bridge.beginFileTask({ exec: h.exec, providerId: 'deepseek' })
  assert.equal(started.ok, true)
  assert.deepEqual(started.manifest, { tools: [{ name: 'read' }] })
  assert.equal(calls[0][0], 'issueGrant')
  assert.equal(calls[1][0], 'bind')
  assert.equal(calls[1][1].exec, h.exec)
  assert.equal(calls[1][1].getRoot(), 'C:/isolated/workspace')
  assert.deepEqual(calls[1][1].getDeniedTools(), ['shell.exec'])
  const answer = await h.bridge.askFromNative({ exec: h.exec, providerId: 'deepseek', requestId: 'file-1', prompt: 'summarize', fileTaskToken: started.fileTaskToken })
  assert.equal(answer.ok, true)
  assert.equal(calls.some(call => call[0] === 'observe'), true)
  assert.equal(calls.some(call => call[0] === 'revokeTask'), true)
  assert.equal(calls.some(call => call[0] === 'runtimeRevoke' && call[1] === cap), true)
})

test('shared WebAI factories compose through a fixture runtime read and final response', {
  skip: !process.env.TRADELOOM_WEB_AI_SHELL_ROOT,
}, async () => {
  const rootPath = resolve(process.env.TRADELOOM_WEB_AI_SHELL_ROOT)
  const fileToolsModule = await import(pathToFileURL(resolve(rootPath, 'webai-file-tools.js')).href)
  const envelopeModule = await import(pathToFileURL(resolve(rootPath, 'webai-tool-envelope.js')).href)
  const calls = []
  const fixtureRoot = 'C:/isolated/workspace'
  const fs = {
    resolve: async (value, options = {}) => {
      if (value === fixtureRoot) return fixtureRoot
      if (value === 'notes.txt' && options.cwd === fixtureRoot) return `${fixtureRoot}/notes.txt`
      throw Object.assign(new Error('fixture path rejected'), { code: 'ENOENT' })
    },
    processPath: value => value,
    stat: async value => value === fixtureRoot ? { type: 'directory' } : { type: 'file', size: 13 },
  }
  const capability = Object.freeze({ fixture: true })
  const runtimeFiles = {
    bind: async binding => {
      calls.push(['bind', binding])
      return capability
    },
    execute: async (value, request) => {
      assert.equal(value, capability)
      calls.push(['runtimeExecute', request])
      return { ok: true, content: 'fixture file text' }
    },
    revoke: value => { calls.push(['runtimeRevoke', value]) },
  }
  let finalObservation
  const adapter = makeAdapter({
    ask: async request => observation(request, {
      content: JSON.stringify({
        version: 1,
        kind: 'tradeloom-file-task',
        taskId: request.fileTask.taskId,
        requestId: 'tool-read-1',
        op: 'read',
        path: 'notes.txt',
      }),
    }),
  })
  adapter.continueWithToolResult = async request => {
    finalObservation = request
    return observation({
      requestId: request.requestId,
      taskNonce: request.taskNonce,
      conversationId: request.conversationId,
    }, { messageId: 'native-final-1', content: '已读取任务文件并完成。' })
  }
  const h = harness({
    adapter,
    runtimeFiles,
    createFileTools: fileToolsModule.createWebAiFileTools,
    createToolEnvelope: envelopeModule.createWebAiToolEnvelope,
    toolManifest: envelopeModule.WEB_AI_TOOL_MANIFEST,
    authorizeNativeToolRun: async ({ exec: value }) => ({
      exec: value,
      webContents: value.webContents,
      isCurrent: () => value.live === true,
      fs,
      getRoot: () => fixtureRoot,
      getDeniedTools: () => ['shell.exec'],
    }),
  })
  const started = await h.bridge.beginFileTask({ exec: h.exec, providerId: 'deepseek' })
  assert.equal(started.ok, true)
  assert.equal(started.manifest, envelopeModule.WEB_AI_TOOL_MANIFEST)
  assert.equal(calls[0][0], 'bind')
  assert.equal(calls[0][1].exec, h.exec)
  assert.equal(calls[0][1].root, fixtureRoot)
  assert.equal(calls[0][1].getRoot(), fixtureRoot)
  assert.deepEqual(calls[0][1].getDeniedTools(), ['shell.exec'])

  const result = await h.bridge.askFromNative({
    exec: h.exec, providerId: 'deepseek', requestId: 'native-read-1',
    prompt: 'Read the authorized notes file and summarize it.', fileTaskToken: started.fileTaskToken,
  })
  assert.equal(result.ok, true)
  assert.equal(result.conversationId, 'conversation-1')
  assert.equal(result.requestId, 'native-read-1')
  assert.equal(result.text, '已读取任务文件并完成。')
  assert.equal(calls.some(([name, request]) => name === 'runtimeExecute'
    && request.requestId === 'tool-read-1' && request.op === 'read' && request.path === 'notes.txt'), true)
  assert.equal(finalObservation.requestId, 'native-read-1')
  assert.equal(finalObservation.conversationId, 'conversation-1')
  assert.equal(finalObservation.taskNonce, started.taskNonce)
  assert.equal(finalObservation.result.status, 'completed')
  assert.deepEqual(finalObservation.result.result, { ok: true, content: 'fixture file text' })
  assert.equal(calls.some(([name, value]) => name === 'runtimeRevoke' && value === capability), true)
})

test('preload exports only owner status and sanitized progress subscription', async () => {
  const listeners = new Set()
  const ipc = {
    invoke: async (_channel, targetId) => ({ ok: true, status: { targetId } }),
    on: (_channel, fn) => listeners.add(fn),
    removeListener: (_channel, fn) => listeners.delete(fn),
  }
  const api = createWebAiPreloadApi(ipc)
  assert.deepEqual(Object.keys(api).sort(), ['getStatus', 'onProgress'])
  assert.equal((await api.getStatus('target-1')).status.targetId, 'target-1')
  let received
  const off = api.onProgress('target-1', value => { received = value })
  for (const listener of listeners) listener({}, { targetId: 'target-1', providerId: 'deepseek', phase: 'waiting', root: 'secret', grant: 'secret', exec: 'secret' })
  assert.deepEqual(received, { targetId: 'target-1', providerId: 'deepseek', phase: 'waiting' })
  off()
  assert.equal(listeners.size, 0)
})
