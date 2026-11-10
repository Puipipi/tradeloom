import assert from 'node:assert/strict'
import test from 'node:test'
import { createSessionTranscriptionController } from '@tradeloom/dsh-business-shell/session-transcription'

function deferred() {
  let resolve
  let reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

async function waitFor(check) {
  const until = Date.now() + 2_000
  while (!check()) {
    if (Date.now() > until) throw new Error('condition did not settle')
    await new Promise(resolve => setTimeout(resolve, 5))
  }
}

function makeAgent(id, sessionId = id) {
  return { id, session: { id: sessionId, header: { agentPreset: 'preset-a' } } }
}

function makeSpeechService(provider, { phase = 'ready', defaultProvider = provider.info.id } = {}) {
  const calls = { resolve: [], transcribe: [] }
  return {
    calls,
    snapshot() {
      return {
        providers: [{ ...provider.info, preparation: { phase } }],
        selection: { providerId: defaultProvider, language: 'en' },
      }
    },
    resolve(request) {
      calls.resolve.push(request)
      if (request.providerId && request.providerId !== provider.info.id) throw new Error('missing provider')
      if (!provider.info.languages.includes(request.language ?? 'en')) throw new Error('unsupported language')
      return { provider, audio: request.audio, language: request.language ?? 'en' }
    },
    async transcribe(spec, signal) {
      calls.transcribe.push({ spec, signal })
      return await provider.transcribe({ audio: spec.audio, language: spec.language }, signal)
    },
  }
}

function makeHarness({ agents, speechToText }) {
  const services = { speechToText }
  const ctx = {
    agents: { get: id => agents.get(id) },
    get: key => services[key],
  }
  return { ctx, agents, services }
}

const transcript = Object.freeze({ text: 'Recognized words.', audioSeconds: 2.5, inferenceSeconds: 0.4 })

test('transcribes only for the captured live binding and returns SDK transcript without session submission', async t => {
  const agent = makeAgent('agent-a', 'session-a')
  let messages = 0
  agent.followup = () => { messages++ }
  const provider = {
    info: { id: 'local', name: 'Local', location: 'host-local', languages: ['en'] },
    async transcribe() { return transcript },
  }
  const service = makeSpeechService(provider)
  const harness = makeHarness({ agents: new Map([[agent.id, agent]]), speechToText: service })
  const controller = createSessionTranscriptionController({ ctx: harness.ctx })
  t.after(() => controller.dispose())

  const binding = await controller.bindAgent(agent.id)
  const result = await controller.transcribe({ binding, audio: Uint8Array.of(1, 2, 3) })

  assert.deepEqual(result, {
    agentId: 'agent-a', sessionId: 'session-a', generation: binding.generation,
    providerId: 'local', language: 'en', ...transcript,
  })
  assert.equal(service.calls.resolve.length, 3) // initial pin, preflight, and postflight identity checks
  assert.equal(service.calls.transcribe.length, 1)
  assert.equal(messages, 0)
})

test('a recording captured for A is stale after binding B and never reaches the SDK', async t => {
  const a = makeAgent('agent-a', 'session-a')
  const b = makeAgent('agent-b', 'session-b')
  const provider = { info: { id: 'local', name: 'Local', location: 'host-local', languages: ['en'] }, async transcribe() { return transcript } }
  const service = makeSpeechService(provider)
  const harness = makeHarness({ agents: new Map([[a.id, a], [b.id, b]]), speechToText: service })
  const controller = createSessionTranscriptionController({ ctx: harness.ctx })
  t.after(() => controller.dispose())
  const captured = await controller.bindAgent(a.id)
  await controller.bindAgent(b.id)

  await assert.rejects(controller.transcribe({ binding: captured, audio: Uint8Array.of(1) }), { code: 'session_transcription_target_changed' })
  assert.equal(service.calls.resolve.length, 0)
  assert.equal(service.calls.transcribe.length, 0)
})

test('a replaced live Agent object invalidates its captured binding', async t => {
  const originalAgent = makeAgent('agent-a', 'session-a')
  const agents = new Map([[originalAgent.id, originalAgent]])
  const provider = { info: { id: 'local', name: 'Local', location: 'host-local', languages: ['en'] }, async transcribe() { return transcript } }
  const service = makeSpeechService(provider)
  const harness = makeHarness({ agents, speechToText: service })
  const controller = createSessionTranscriptionController({ ctx: harness.ctx })
  t.after(() => controller.dispose())
  const binding = await controller.bindAgent(originalAgent.id)
  agents.set(originalAgent.id, makeAgent(originalAgent.id, 'session-a'))

  await assert.rejects(controller.transcribe({ binding, audio: Uint8Array.of(1) }), { code: 'session_transcription_target_changed' })
  assert.equal(service.calls.resolve.length, 0)
})

test('late result after live Agent/session replacement is rejected', async t => {
  const agent = makeAgent('agent-a', 'session-a')
  const gate = deferred()
  const started = deferred()
  const provider = { info: { id: 'local', name: 'Local', location: 'host-local', languages: ['en'] }, transcribe() { started.resolve(); return gate.promise } }
  const service = makeSpeechService(provider)
  const harness = makeHarness({ agents: new Map([[agent.id, agent]]), speechToText: service })
  const controller = createSessionTranscriptionController({ ctx: harness.ctx })
  t.after(async () => { gate.resolve(transcript); await controller.dispose() })
  const binding = await controller.bindAgent(agent.id)
  const pending = controller.transcribe({ binding, audio: Uint8Array.of(1) })
  await started.promise
  agent.session = { id: 'session-replaced', header: { agentPreset: 'preset-a' } }
  gate.resolve(transcript)
  await assert.rejects(pending, { code: 'session_transcription_target_changed' })
})

test('rebind cancels the old caller and keeps the replacement busy until ignored work settles', async t => {
  const a = makeAgent('agent-a', 'session-a')
  const b = makeAgent('agent-b', 'session-b')
  const gate = deferred()
  const started = deferred()
  let signal
  let calls = 0
  const provider = {
    info: { id: 'local', name: 'Local', location: 'host-local', languages: ['en'] },
    transcribe(_input, receivedSignal) {
      calls++
      if (calls === 1) { signal = receivedSignal; started.resolve(); return gate.promise }
      return Promise.resolve({ ...transcript, text: 'new target only' })
    },
  }
  const service = makeSpeechService(provider)
  const harness = makeHarness({ agents: new Map([[a.id, a], [b.id, b]]), speechToText: service })
  const controller = createSessionTranscriptionController({ ctx: harness.ctx })
  t.after(async () => { gate.resolve(transcript); await controller.dispose() })
  const oldBinding = await controller.bindAgent(a.id)
  const oldCall = controller.transcribe({ binding: oldBinding, audio: Uint8Array.of(1) })
  await started.promise
  const newBinding = controller.bindAgent(b.id)

  await assert.rejects(oldCall, { code: 'session_transcription_target_changed' })
  assert.equal(signal.aborted, true)
  await assert.rejects(controller.transcribe({ binding: newBinding, audio: Uint8Array.of(2) }), { code: 'session_transcription_busy' })
  gate.resolve(transcript)
  await waitFor(() => !controller.getInFlight())
  const newResult = await controller.transcribe({ binding: newBinding, audio: Uint8Array.of(3) })
  assert.equal(newResult.sessionId, 'session-b')
  assert.equal(newResult.text, 'new target only')
  assert.equal(calls, 2)
})

test('cancellation returns promptly but keeps ignored-abort provider work busy until it settles', async t => {
  const agent = makeAgent('agent-a', 'session-a')
  const gate = deferred()
  const started = deferred()
  let signal
  const provider = {
    info: { id: 'local', name: 'Local', location: 'host-local', languages: ['en'] },
    transcribe(_input, receivedSignal) { signal = receivedSignal; started.resolve(); return gate.promise },
  }
  const service = makeSpeechService(provider)
  const harness = makeHarness({ agents: new Map([[agent.id, agent]]), speechToText: service })
  const controller = createSessionTranscriptionController({ ctx: harness.ctx })
  t.after(async () => { gate.resolve(transcript); await controller.dispose() })
  const binding = await controller.bindAgent(agent.id)
  const pending = controller.transcribe({ binding, audio: Uint8Array.of(1) })
  await started.promise

  await controller.cancel()
  assert.equal(signal.aborted, true)
  await assert.rejects(pending, { code: 'session_transcription_cancelled' })
  await assert.rejects(controller.transcribe({ binding, audio: Uint8Array.of(2) }), { code: 'session_transcription_busy' })
  gate.resolve(transcript)
  await waitFor(() => !controller.getInFlight())
  const retried = await controller.transcribe({ binding, audio: Uint8Array.of(3) })
  assert.equal(retried.text, transcript.text)
})

test('readiness is projected from SDK phases without inventing model failure codes', async t => {
  const agent = makeAgent('agent-a')
  const provider = { info: { id: 'local', name: 'Local', location: 'host-local', languages: ['en'] }, async transcribe() { return transcript } }
  const service = makeSpeechService(provider, { phase: 'unprepared' })
  const harness = makeHarness({ agents: new Map([[agent.id, agent]]), speechToText: service })
  const controller = createSessionTranscriptionController({ ctx: harness.ctx })
  t.after(() => controller.dispose())
  const binding = await controller.bindAgent(agent.id)

  const readiness = controller.getReadiness()
  assert.deepEqual(readiness, { status: 'not_ready', providerId: 'local', phase: 'unprepared' })
  await assert.rejects(controller.transcribe({ binding, audio: Uint8Array.of(1) }), { code: 'session_transcription_not_ready' })
  assert.equal(service.calls.transcribe.length, 0)
  service.snapshot = () => ({ providers: [{ ...provider.info, preparation: { phase: 'failed', message: 'do not surface' } }], selection: { providerId: 'local', language: 'en' } })
  assert.deepEqual(controller.getReadiness(), { status: 'not_ready', providerId: 'local', phase: 'failed' })
  await assert.rejects(controller.transcribe({ binding, audio: Uint8Array.of(1), language: 'fr' }), { code: 'session_transcription_not_ready' })
  service.snapshot = () => ({ providers: [{ ...provider.info, preparation: { phase: 'ready' } }], selection: { providerId: 'local', language: 'en' } })
  await assert.rejects(controller.transcribe({ binding, audio: Uint8Array.of(1), language: 'fr' }), { code: 'session_transcription_language_unsupported' })
  service.snapshot = () => ({ providers: [{ ...provider.info, preparation: { phase: 'checking' } }], selection: { providerId: 'local', language: 'en' } })
  assert.deepEqual(controller.getReadiness(), { status: 'not_ready', providerId: 'local', phase: 'checking' })
  service.snapshot = () => ({ providers: [{ ...provider.info, preparation: { phase: 'unknown-phase' } }], selection: { providerId: 'local', language: 'en' } })
  assert.deepEqual(controller.getReadiness(), { status: 'unknown', providerId: 'local', phase: 'unknown' })
})

test('typed SDK provider failures are mapped only after current target and service checks', async t => {
  const agent = makeAgent('agent-a', 'session-a')
  const providerFailure = Object.assign(new Error('safe typed worker failure'), { secretDiagnostic: 'must-not-leak' })
  const provider = { info: { id: 'local', name: 'Local', location: 'host-local', languages: ['en'] },
    async transcribe() { throw providerFailure } }
  const service = makeSpeechService(provider)
  service.describeProviderFailure = error => error === providerFailure
    ? { code: 'worker-exited', exitCode: 1, signal: null }
    : undefined
  const harness = makeHarness({ agents: new Map([[agent.id, agent]]), speechToText: service })
  const controller = createSessionTranscriptionController({ ctx: harness.ctx })
  t.after(() => controller.dispose())
  const binding = await controller.bindAgent(agent.id)

  await assert.rejects(controller.transcribe({ binding, audio: Uint8Array.of(1) }), error => {
    assert.equal(error.code, 'session_transcription_worker_exited')
    assert.deepEqual(error.providerFailure, { code: 'worker-exited', exitCode: 1, signal: null })
    assert.equal(JSON.stringify(error).includes('must-not-leak'), false)
    return true
  })
})

test('readiness projects only an explicit typed model failure and rejects before provider dispatch', async t => {
  const agent = makeAgent('agent-a', 'session-a')
  const provider = { info: { id: 'local', name: 'Local', location: 'host-local', languages: ['en'] }, async transcribe() { return transcript } }
  const service = makeSpeechService(provider)
  service.snapshot = () => ({
    providers: [{ ...provider.info, preparation: { phase: 'unprepared', failure: { code: 'model-unavailable' } } }],
    selection: { providerId: 'local', language: 'en' },
  })
  const harness = makeHarness({ agents: new Map([[agent.id, agent]]), speechToText: service })
  const controller = createSessionTranscriptionController({ ctx: harness.ctx })
  t.after(() => controller.dispose())
  const binding = await controller.bindAgent(agent.id)

  assert.deepEqual(controller.getReadiness(), {
    status: 'not_ready', providerId: 'local', phase: 'unprepared', failure: { code: 'model-unavailable' },
  })
  await assert.rejects(controller.transcribe({ binding, audio: Uint8Array.of(1) }), { code: 'session_transcription_model_unavailable' })
  assert.equal(service.calls.transcribe.length, 0)
})

test('service replacement during transcription prevents stale result delivery', async t => {
  const agent = makeAgent('agent-a')
  const gate = deferred()
  const started = deferred()
  const provider = { info: { id: 'local', name: 'Local', location: 'host-local', languages: ['en'] }, transcribe() { started.resolve(); return gate.promise } }
  const first = makeSpeechService(provider)
  const second = makeSpeechService(provider)
  const harness = makeHarness({ agents: new Map([[agent.id, agent]]), speechToText: first })
  const controller = createSessionTranscriptionController({ ctx: harness.ctx })
  t.after(async () => { gate.resolve(transcript); await controller.dispose() })
  const binding = await controller.bindAgent(agent.id)
  const pending = controller.transcribe({ binding, audio: Uint8Array.of(1) })
  await started.promise
  harness.services.speechToText = second
  gate.resolve(transcript)
  await assert.rejects(pending, { code: 'session_transcription_service_changed' })
})

test('provider replacement before the transcription microtask never calls either provider', async t => {
  const agent = makeAgent('agent-a')
  let replaced = false
  let firstCalls = 0
  let replacementCalls = 0
  const info = { id: 'local', name: 'Local', location: 'host-local', languages: ['en'] }
  const firstProvider = { info, async transcribe() { firstCalls++; return transcript } }
  const nextProvider = { info, async transcribe() { replacementCalls++; return transcript } }
  const service = {
    snapshot: () => ({ providers: [{ ...info, preparation: { phase: 'ready' } }], selection: { providerId: 'local', language: 'en' } }),
    resolve: request => ({ provider: replaced ? nextProvider : firstProvider, audio: request.audio, language: request.language ?? 'en' }),
    async transcribe(spec, signal) { return await spec.provider.transcribe({ audio: spec.audio, language: spec.language }, signal) },
  }
  const harness = makeHarness({ agents: new Map([[agent.id, agent]]), speechToText: service })
  const controller = createSessionTranscriptionController({ ctx: harness.ctx })
  t.after(() => controller.dispose())
  const binding = await controller.bindAgent(agent.id)
  const pending = controller.transcribe({ binding, audio: Uint8Array.of(1) })
  replaced = true

  await assert.rejects(pending, { code: 'session_transcription_service_changed' })
  assert.equal(firstCalls, 0)
  assert.equal(replacementCalls, 0)
})

test('missing service and unknown readiness fail closed without attempting transcription', async t => {
  const agent = makeAgent('agent-a')
  const harness = makeHarness({ agents: new Map([[agent.id, agent]]), speechToText: undefined })
  const controller = createSessionTranscriptionController({ ctx: harness.ctx })
  t.after(() => controller.dispose())
  const binding = await controller.bindAgent(agent.id)
  assert.deepEqual(controller.getReadiness(), { status: 'unavailable', phase: 'unknown' })
  await assert.rejects(controller.transcribe({ binding, audio: Uint8Array.of(1) }), { code: 'session_transcription_service_unavailable' })

  const provider = { info: { id: 'local', name: 'Local', location: 'host-local', languages: ['en'] }, async transcribe() { return transcript } }
  harness.services.speechToText = makeSpeechService(provider)
  harness.services.speechToText.snapshot = () => ({ providers: null })
  assert.deepEqual(controller.getReadiness(), { status: 'unknown', phase: 'unknown' })
  await assert.rejects(controller.transcribe({ binding, audio: Uint8Array.of(1) }), { code: 'session_transcription_readiness_unknown' })
})

test('dispose is terminal, aborts work, and joins the actual provider promise', async () => {
  const agent = makeAgent('agent-a')
  const gate = deferred()
  const started = deferred()
  let signal
  const provider = { info: { id: 'local', name: 'Local', location: 'host-local', languages: ['en'] },
    transcribe(_input, receivedSignal) { signal = receivedSignal; started.resolve(); return gate.promise } }
  const service = makeSpeechService(provider)
  const harness = makeHarness({ agents: new Map([[agent.id, agent]]), speechToText: service })
  const controller = createSessionTranscriptionController({ ctx: harness.ctx })
  const binding = await controller.bindAgent(agent.id)
  const pending = controller.transcribe({ binding, audio: Uint8Array.of(1) })
  await started.promise
  const firstDispose = controller.dispose()
  const secondDispose = controller.dispose()
  assert.strictEqual(secondDispose, firstDispose)
  await assert.rejects(pending, { code: 'session_transcription_cancelled' })
  assert.equal(signal.aborted, true)
  let disposed = false
  void firstDispose.then(() => { disposed = true })
  await Promise.resolve()
  assert.equal(disposed, false)
  gate.resolve(transcript)
  await firstDispose
  assert.equal(disposed, true)
  assert.throws(() => controller.bindAgent(agent.id), { code: 'session_transcription_closed' })
})
