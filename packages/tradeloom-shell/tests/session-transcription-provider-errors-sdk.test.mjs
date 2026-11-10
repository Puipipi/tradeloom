import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import test from 'node:test'
import { createSessionTranscriptionController } from '@tradeloom/dsh-business-shell/session-transcription'

const sdkRoot = process.env.TRADELOOM_REP12_SDK_ROOT
const overlayRoot = process.env.TRADELOOM_N02_SDK_OVERLAY_ROOT
const ownedRoot = process.env.TRADELOOM_N02_OWNED_TEST_ROOT
const fixtureRoot = fileURLToPath(new URL('../../../recovery-20261029/n02-speech-provider-errors-20261031/testing/fixtures/', import.meta.url))

async function importAt(path) { return await import(pathToFileURL(path).href) }
async function sdkModule(relativePath) { return await importAt(join(sdkRoot, relativePath)) }
async function overlayModule(relativePath) { return await importAt(join(overlayRoot, relativePath)) }

async function waitFor(predicate) {
  const deadline = Date.now() + 5_000
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('owned SDK fixture did not settle')
    await new Promise(resolve => setTimeout(resolve, 5))
  }
}

function makeWave() {
  const bytes = Buffer.alloc(46)
  bytes.write('RIFF', 0, 'ascii'); bytes.writeUInt32LE(38, 4); bytes.write('WAVE', 8, 'ascii')
  bytes.write('fmt ', 12, 'ascii'); bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20)
  bytes.writeUInt16LE(1, 22); bytes.writeUInt32LE(16000, 24); bytes.writeUInt32LE(32000, 28)
  bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34); bytes.write('data', 36, 'ascii')
  bytes.writeUInt32LE(2, 40); bytes.writeInt16LE(0, 44)
  return bytes.toString('base64')
}

function config(dataRoot, workerPath) {
  return {
    providerId: 'owned-sensevoice', dataRoot, modelDirectory: join(dataRoot, 'model'),
    vadModelPath: join(dataRoot, 'vad.onnx'), precision: 'int8', modelOrigins: [],
    modelProbeTimeoutMs: 100, threads: 1, segmentSeconds: 1, vadThreshold: 0.5,
    minSpeechSeconds: 0.1, minSilenceSeconds: 0.1, vadOnsetPaddingSeconds: 0,
    maxAudioBytes: 4096, prepareTimeoutMs: 3000, inferenceTimeoutMs: 2000,
    idleTimeoutMs: 0, maxPending: 2, graceMs: 1000, maxLogBytes: 4096,
    maxResponseBytes: 4096, progressIntervalMs: 1,
    workerPath,
  }
}

async function startWorkerHarness(behavior) {
  const [{ Context }, { LocalSubprocessRuntime }, speechCore, { SenseVoiceWorker }] = await Promise.all([
    sdkModule('vendor/cordis/lib/index.js'),
    sdkModule('packages/subprocess/subprocess-local/lib/index.js'),
    overlayModule('packages/experimental/core/lib/index.js'),
    overlayModule('packages/experimental/sensevoice/lib/recognizer.js'),
  ])
  const root = await import('node:fs/promises').then(({ mkdtemp }) => mkdtemp(join(resolve(ownedRoot), `worker-${behavior}-`)))
  const ctx = new Context()
  await ctx.plugin(LocalSubprocessRuntime)
  await ctx.plugin(speechCore.default, { defaultProvider: `owned-${behavior}`, language: 'en' })
  const workerPath = join(fixtureRoot, 'worker-controlled-http.mjs')
  const workerConfig = config(root, workerPath)
  if (behavior === 'disconnect-hold') workerConfig.inferenceTimeoutMs = 150
  const worker = new SenseVoiceWorker(ctx, workerConfig)
  worker.config.fixtureBehavior = behavior
  worker.runtime = { worker: workerPath, model: join(root, 'fixture-model'), tokens: join(root, 'fixture-tokens'), vad: join(root, 'fixture-vad') }
  const speech = ctx.get('speechToText')
  const providerDisposer = speech.register({
    info: { id: `owned-${behavior}`, name: 'Owned controlled worker', location: 'host-local', languages: ['en'] },
    preparation: worker,
    transcribe: (input, signal) => worker.transcribe(input, signal),
  })
  const agent = { id: `agent-${behavior}`, session: { id: `session-${behavior}` }, messages: [] }
  ctx.provide('agents', { get: id => id === agent.id ? agent : undefined })
  const controller = createSessionTranscriptionController({ ctx })
  const binding = await controller.bindAgent(agent.id)
  worker.prepare()
  await waitFor(() => worker.snapshot().phase === 'ready')
  return {
    root, ctx, speechCore, speech, worker, providerDisposer, agent, controller, binding,
    dispose: async () => { await controller.dispose(); await providerDisposer(); await ctx.fiber.dispose() },
  }
}

test('patched rep12 SDK reports an actual owned worker exit through backend and speech API contracts', {
  skip: sdkRoot && overlayRoot && ownedRoot ? false : 'set pinned SDK, overlay, and owned test roots to run the isolated integration',
}, async t => {
  const marker = await readFile(join(resolve(ownedRoot), '.n02-speech-provider-errors-owned'), 'utf8')
  assert.equal(marker.trim(), 'tradeloom-n02-speech-provider-errors-v1')
  const [{ Context }, { LocalSubprocessRuntime }, speechCore, { SenseVoiceWorker }, speechApi] = await Promise.all([
    sdkModule('vendor/cordis/lib/index.js'),
    sdkModule('packages/subprocess/subprocess-local/lib/index.js'),
    overlayModule('packages/experimental/core/lib/index.js'),
    overlayModule('packages/experimental/sensevoice/lib/recognizer.js'),
    overlayModule('packages/experimental/api/src/index.ts'),
  ])

  // The three edited packages must resolve the same newly built core module identity.
  const expectedCore = resolve(join(overlayRoot, 'packages/experimental/core/lib/index.js'))
  const senseRequire = createRequire(pathToFileURL(join(overlayRoot, 'packages/experimental/sensevoice/lib/recognizer.js')))
  const apiRequire = createRequire(pathToFileURL(join(overlayRoot, 'packages/experimental/api/lib/index.js')))
  assert.equal(resolve(senseRequire.resolve('@deepseek-ai/dsh-experimental-speech-to-text')), expectedCore)
  assert.equal(resolve(apiRequire.resolve('@deepseek-ai/dsh-experimental-speech-to-text')), expectedCore)

  const runRoot = await import('node:fs/promises').then(({ mkdtemp }) => mkdtemp(join(resolve(ownedRoot), 'real-worker-')))
  const ctx = new Context()
  const originalFetch = globalThis.fetch
  let providerDisposer
  let controller
  let fetchRejectOrder
  let processOutcomeOrder
  let eventOrder = 0
  try {
    await ctx.plugin(LocalSubprocessRuntime)
    await ctx.plugin(speechCore.default, { defaultProvider: 'owned-sensevoice', language: 'en' })
    const workerPath = join(fixtureRoot, 'worker-crash-after-ready.mjs')
    const worker = new SenseVoiceWorker(ctx, config(runRoot, workerPath))
    // Only the worker executable is substituted: process ownership, readiness framing, HTTP
    // request, exitCode capture, provider registry and typed SDK errors are real rep12 code.
    worker.runtime = { worker: workerPath, model: join(runRoot, 'fixture-model'), tokens: join(runRoot, 'fixture-tokens'), vad: join(runRoot, 'fixture-vad') }
    const speech = ctx.get('speechToText')
    providerDisposer = speech.register({
      info: { id: 'owned-sensevoice', name: 'Owned worker fixture', location: 'host-local', languages: ['en'] },
      preparation: worker,
      transcribe: (input, signal) => worker.transcribe(input, signal),
    })
    const agent = { id: 'owned-agent', session: { id: 'owned-session' }, messages: [] }
    ctx.provide('agents', { get: id => id === agent.id ? agent : undefined })
    controller = createSessionTranscriptionController({ ctx })
    const binding = await controller.bindAgent(agent.id)
    worker.prepare()
    await waitFor(() => worker.snapshot().phase === 'ready')
    globalThis.fetch = async (...args) => {
      try { return await originalFetch(...args) }
      catch (error) { fetchRejectOrder = ++eventOrder; throw error }
    }
    const processOutcome = worker.worker.handle.done.then(
      outcome => { processOutcomeOrder = ++eventOrder; return { kind: 'resolved', exitCode: outcome.exitCode, signal: outcome.signal } },
      error => ({ kind: 'rejected', errorName: error?.constructor?.name ?? 'unknown' }),
    )

    const workerFailure = await controller.transcribe({ binding, audio: Uint8Array.of(1, 2), language: 'en' }).then(() => null, error => error)
    assert.ok(workerFailure)
    await assert.rejects(Promise.reject(workerFailure), error => {
      assert.equal(error.code, 'session_transcription_worker_exited')
      assert.deepEqual(error.providerFailure, { code: 'worker-exited', exitCode: 17, signal: null })
      assert.equal(JSON.stringify(error).includes('DSH_SPEECH_TOKEN'), false)
      return true
    })
    assert.ok(fetchRejectOrder > 0)
    assert.ok(processOutcomeOrder > fetchRejectOrder, 'the child exit outcome must arrive after the request rejection')
    assert.deepEqual(await processOutcome, { kind: 'resolved', exitCode: 17, signal: null })
    await waitFor(() => worker.snapshot().phase === 'failed')
    assert.deepEqual(worker.snapshot().failure, { code: 'worker-exited', exitCode: 17, signal: null })
    assert.deepEqual(agent.messages, [])

    // Exercise the patched speech API projection using the same real Core service and error class.
    const apiProvider = {
      info: { id: 'api-typed', name: 'Typed failure fixture', location: 'host-local', languages: ['en'] },
      async transcribe() { throw new speechCore.SpeechProviderFailure({ code: 'worker-exited', exitCode: 17, signal: null }) },
    }
    const disposeApiProvider = speech.register(apiProvider)
    t.after(disposeApiProvider)
    const apiService = Object.create(speechApi.default.prototype)
    apiService.ctx = { speechToText: speech }
    apiService.config = { maxAudioBytes: 4096, maxDurationSeconds: 2 }
    await assert.rejects(apiService.transcribe({ audioBase64: makeWave(), providerId: 'api-typed', language: 'en' }, new AbortController().signal), error => {
      assert.equal(error.code, 'speech/transcription-failed')
      assert.equal(error.details.reason, 'Speech worker exited unexpectedly')
      assert.equal(error.details.code, 'worker-exited')
      assert.equal(error.details.exitCode, 17)
      assert.equal(error.details.signal, null)
      return true
    })
    const legacyError = Object.assign(new Error('ordinary provider failure'), {
      name: 'SpeechProviderFailure', code: 'worker-exited', exitCode: 17, signal: null,
    })
    const legacyDisposer = speech.register({
      info: { id: 'api-legacy', name: 'Legacy failure fixture', location: 'host-local', languages: ['en'] },
      async transcribe() { throw legacyError },
    })
    try {
      await assert.rejects(apiService.transcribe({ audioBase64: makeWave(), providerId: 'api-legacy', language: 'en' }, new AbortController().signal), error => {
        assert.equal(error.code, 'speech/transcription-failed')
        assert.deepEqual(error.details, { reason: 'ordinary provider failure' })
        return true
      })
    } finally { await legacyDisposer() }
  } finally {
    globalThis.fetch = originalFetch
    await controller?.dispose()
    await providerDisposer?.()
    await ctx.fiber.dispose()
  }
})

test('HTTP error response on a live worker remains generic and idle disposal is not a worker failure', {
  skip: sdkRoot && overlayRoot && ownedRoot ? false : 'set pinned SDK, overlay, and owned test roots to run the isolated integration',
}, async () => {
  const harness = await startWorkerHarness('http500')
  try {
    await assert.rejects(harness.controller.transcribe({ binding: harness.binding, audio: Uint8Array.of(1, 2), language: 'en' }), {
      code: 'session_transcription_failed',
    })
    assert.equal(harness.worker.snapshot().failure, undefined)
    assert.notEqual(harness.worker.snapshot().failure?.code, 'worker-exited')
  } finally { await harness.dispose() }

  const idle = await startWorkerHarness('hold')
  try {
    await idle.worker.dispose()
    assert.equal(idle.worker.snapshot().failure, undefined)
  } finally { await idle.dispose() }

  const disconnected = await startWorkerHarness('disconnect-hold')
  try {
    const inferenceStartedAt = performance.now()
    let fetchRejectedAt
    let workerSettledAt
    let workerWasLiveAtFetchRejection = false
    const originalFetch = globalThis.fetch
    globalThis.fetch = async (...args) => {
      try { return await originalFetch(...args) }
      catch (error) {
        fetchRejectedAt = performance.now()
        workerWasLiveAtFetchRejection = workerSettledAt === undefined
        throw error
      }
    }
    const outcome = disconnected.worker.worker.handle.done.then(
      value => { workerSettledAt = performance.now(); return { kind: 'resolved', exitCode: value.exitCode, signal: value.signal } },
      error => { workerSettledAt = performance.now(); return { kind: 'rejected', errorName: error?.constructor?.name ?? 'unknown' } },
    )
    try {
      const request = disconnected.controller.transcribe({
        binding: disconnected.binding, audio: Uint8Array.of(9, 8), language: 'en',
      })
      await assert.rejects(request, { code: 'session_transcription_failed' })
      assert.ok(fetchRejectedAt !== undefined)
      assert.equal(workerWasLiveAtFetchRejection, true, 'the fixture drops the socket while its child remains alive')
      assert.ok(fetchRejectedAt - inferenceStartedAt < 100, 'the socket failure must precede the 150ms inference deadline')
      assert.ok(performance.now() - inferenceStartedAt >= 120, 'the request remains bounded by the configured inference deadline')
      assert.equal(disconnected.worker.snapshot().failure, undefined, 'a timeout is not a worker-exited observation')
      assert.equal(disconnected.worker.snapshot().phase, 'standby')
      assert.equal(disconnected.worker.worker, undefined, 'the owned worker is stopped and joined after timeout')
      const ended = await outcome
      assert.equal(ended.kind, 'resolved')
      assert.ok(workerSettledAt >= inferenceStartedAt + 120)
    } finally { globalThis.fetch = originalFetch }
  } finally { await disconnected.dispose() }
})

test('explicit cancellation of a live worker remains cancellation and joins without typed worker failure', {
  skip: sdkRoot && overlayRoot && ownedRoot ? false : 'set pinned SDK, overlay, and owned test roots to run the isolated integration',
}, async () => {
  const harness = await startWorkerHarness('hold')
  try {
    const request = harness.controller.transcribe({ binding: harness.binding, audio: Uint8Array.of(3, 4), language: 'en' })
    await waitFor(() => existsSync(join(harness.root, 'request-seen')))
    assert.deepEqual(await harness.controller.cancel(), { status: 'cancelling' })
    await assert.rejects(request, { code: 'session_transcription_cancelled' })
    await waitFor(() => !harness.controller.getInFlight())
    assert.equal(harness.worker.snapshot().failure, undefined)
    assert.deepEqual(harness.agent.messages, [])
  } finally { await harness.dispose() }
})

test('rep12 SenseVoice inspection exposes only an explicit missing-model failure without downloading', {
  skip: sdkRoot && overlayRoot && ownedRoot ? false : 'set pinned SDK, overlay, and owned test roots to run the isolated integration',
}, async () => {
  const marker = await readFile(join(resolve(ownedRoot), '.n02-speech-provider-errors-owned'), 'utf8')
  assert.equal(marker.trim(), 'tradeloom-n02-speech-provider-errors-v1')
  const [{ Context }, { LocalSubprocessRuntime }, speechCore, { SenseVoiceWorker }] = await Promise.all([
    sdkModule('vendor/cordis/lib/index.js'),
    sdkModule('packages/subprocess/subprocess-local/lib/index.js'),
    overlayModule('packages/experimental/core/lib/index.js'),
    overlayModule('packages/experimental/sensevoice/lib/recognizer.js'),
  ])
  const root = await import('node:fs/promises').then(({ mkdtemp }) => mkdtemp(join(resolve(ownedRoot), 'missing-model-')))
  const ctx = new Context()
  let controller
  let providerDisposer
  try {
    await ctx.plugin(LocalSubprocessRuntime)
    await ctx.plugin(speechCore.default, { defaultProvider: 'missing-sensevoice', language: 'en' })
    const missing = config(root, join(fixtureRoot, 'worker-exit-before-ready.mjs'))
    missing.modelDirectory = join(root, 'absent-model-directory')
    missing.vadModelPath = join(root, 'absent-vad.onnx')
    const worker = new SenseVoiceWorker(ctx, missing)
    const speech = ctx.get('speechToText')
    providerDisposer = speech.register({
      info: { id: 'missing-sensevoice', name: 'Missing model fixture', location: 'host-local', languages: ['en'] },
      preparation: worker,
      transcribe: (input, signal) => worker.transcribe(input, signal),
    })
    worker.inspect()
    await waitFor(() => worker.snapshot().failure?.code === 'model-unavailable')
    assert.deepEqual(worker.snapshot().failure, { code: 'model-unavailable' })
    assert.equal(await import('node:fs/promises').then(({ access }) => access(join(root, 'absent-model-directory')).then(() => true, () => false)), false)
    assert.equal(await import('node:fs/promises').then(({ access }) => access(join(root, 'absent-vad.onnx')).then(() => true, () => false)), false)
    const agent = { id: 'missing-agent', session: { id: 'missing-session' } }
    ctx.provide('agents', { get: id => id === agent.id ? agent : undefined })
    controller = createSessionTranscriptionController({ ctx })
    const binding = await controller.bindAgent(agent.id)
    assert.deepEqual(controller.getReadiness(), {
      status: 'not_ready', providerId: 'missing-sensevoice', phase: 'unprepared', failure: { code: 'model-unavailable' },
    })
    await assert.rejects(controller.transcribe({ binding, audio: Uint8Array.of(1), providerId: 'missing-sensevoice' }), {
      code: 'session_transcription_model_unavailable',
    })
  } finally {
    await controller?.dispose()
    await providerDisposer?.()
    await ctx.fiber.dispose()
  }
})
