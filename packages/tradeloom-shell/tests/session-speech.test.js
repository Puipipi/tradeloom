import assert from 'node:assert/strict'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createSessionSpeechController } from '../session-speech.js'
import { createWindowsSpeechProvider } from '../windows-speech-provider.js'

function deferred() {
  let resolve
  let reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

function makePcmWave() {
  const bytes = Buffer.alloc(46)
  bytes.write('RIFF', 0, 'ascii')
  bytes.writeUInt32LE(38, 4)
  bytes.write('WAVE', 8, 'ascii')
  bytes.write('fmt ', 12, 'ascii')
  bytes.writeUInt32LE(16, 16)
  bytes.writeUInt16LE(1, 20)
  bytes.writeUInt16LE(1, 22)
  bytes.writeUInt32LE(16000, 24)
  bytes.writeUInt32LE(32000, 28)
  bytes.writeUInt16LE(2, 32)
  bytes.writeUInt16LE(16, 34)
  bytes.write('data', 36, 'ascii')
  bytes.writeUInt32LE(2, 40)
  return {
    mimeType: 'audio/wav',
    format: { encoding: 'pcm', channels: 1, sampleRate: 16000, bitsPerSample: 16, durationSeconds: 2 / 32000 },
    bytes,
  }
}

function actor(id) {
  const handlers = new Map()
  const session = { id, header: { agentPreset: 'tradeloom-product' } }
  const agent = {
    id,
    session,
    ctx: { on(name, callback) { handlers.set(name, callback); return () => handlers.delete(name) } },
  }
  return { agent, session, handlers }
}

function host(agents) {
  const handlers = new Map()
  return {
    agents: { get: id => agents.get(id) },
    on(name, callback) { handlers.set(name, callback); return () => handlers.delete(name) },
    emit(name, value) { handlers.get(name)?.(value) },
    handlers,
  }
}

function emit(target, type, data, seq, session = target.session) {
  target.handlers.get('session/event')?.(session, { type, seq, time: seq, data })
}

function finalMessage(turn, seq, blocks, extras = {}) {
  return { turn, step: 1, message: { role: 'assistant', content: blocks }, ...extras, seq }
}

async function waitFor(check, label, timeoutMs = 3000) {
  const started = Date.now()
  while (!check()) {
    if (Date.now() - started > timeoutMs) throw new Error(`timed out waiting for ${label}`)
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}

test('only completed final text for the selected live session reaches the provider', async t => {
  const selected = actor('session-selected')
  const other = actor('session-other')
  const agents = new Map([[selected.agent.id, selected.agent], [other.agent.id, other.agent]])
  const ctx = host(agents)
  const calls = []
  const delivered = deferred()
  const errors = []
  const controller = createSessionSpeechController({
    ctx,
    provider: { async synthesize(text) { calls.push(text); return makePcmWave() } },
    onAudio: dto => delivered.resolve(dto),
    onError: error => errors.push(error),
  })
  t.after(() => controller.dispose())
  const bound = await controller.bindAgent(selected.agent.id)
  assert.equal(bound.status, 'bound')
  assert.equal(controller.getCurrentTarget().sessionId, selected.session.id)

  emit(selected, 'turn/start', { turn: 1 }, 1)
  emit(selected, 'assistant/message', finalMessage(1, 2, [
    { type: 'text', text: 'tool preamble' },
    { type: 'tool-call', id: 'call-1', name: 'example', arguments: '{}' },
  ]), 2)
  emit(selected, 'assistant/message', finalMessage(1, 3, [
    { type: 'reasoning', text: 'private reasoning must not be synthesized' },
    { type: 'text', text: 'The final answer.' },
  ]), 3)
  emit(selected, 'turn/start', { turn: 1 }, 4, other.session)
  emit(selected, 'assistant/message', finalMessage(1, 5, [{ type: 'text', text: 'wrong session' }]), 5, other.session)
  emit(selected, 'turn/end', { turn: 1, reason: { kind: 'completed' } }, 6, other.session)
  emit(selected, 'turn/end', { turn: 1, reason: { kind: 'completed' } }, 7)
  emit(selected, 'turn/end', { turn: 1, reason: { kind: 'completed' } }, 8)

  const dto = await delivered.promise
  assert.deepEqual(calls, ['The final answer.'])
  assert.equal(dto.sessionId, 'session-selected')
  assert.equal(dto.turn, 1)
  assert.equal(dto.seq, 3)
  assert.equal(dto.generation, bound.generation)
  assert.equal(dto.mimeType, 'audio/wav')

  emit(selected, 'turn/start', { turn: 2 }, 9)
  emit(selected, 'assistant/message', finalMessage(2, 10, [{ type: 'text', text: 'interrupted prefix' }], { interrupted: true }), 10)
  emit(selected, 'turn/end', { turn: 2, reason: { kind: 'completed' } }, 11)
  emit(selected, 'turn/start', { turn: 3 }, 12)
  emit(selected, 'assistant/message', finalMessage(3, 13, [{ type: 'text', text: 'cut off' }]), 13)
  emit(selected, 'turn/end', { turn: 3, reason: { kind: 'max-tokens' } }, 14)
  emit(selected, 'turn/start', { turn: 4 }, 15)
  emit(selected, 'turn/end', { turn: 4, reason: { kind: 'completed' } }, 16)
  emit(selected, 'turn/start', { turn: 5 }, 17)
  emit(selected, 'assistant/message', finalMessage(5, 18, [{ type: 'text', text: 'x'.repeat(12_001) }]), 18)
  emit(selected, 'turn/end', { turn: 5, reason: { kind: 'completed' } }, 19)
  assert.deepEqual(calls, ['The final answer.'])
  assert.deepEqual(errors.map(error => error.code), ['session_speech_text_too_long'])
})

test('queue is serialized and a duplicate session/turn event is synthesized only once', async t => {
  const selected = actor('session-queue')
  const ctx = host(new Map([[selected.agent.id, selected.agent]]))
  const calls = []
  const gates = [deferred(), deferred()]
  const starts = [deferred(), deferred()]
  const delivered = []
  const controller = createSessionSpeechController({
    ctx,
    provider: { synthesize(text) { const index = calls.push(text) - 1; starts[index].resolve(); return gates[index].promise } },
    onAudio: dto => delivered.push(dto.turn),
  })
  t.after(() => controller.dispose())
  await controller.bindAgent(selected.agent.id)
  emit(selected, 'turn/start', { turn: 1 }, 1)
  emit(selected, 'assistant/message', finalMessage(1, 2, [{ type: 'text', text: 'one' }]), 2)
  emit(selected, 'turn/end', { turn: 1, reason: { kind: 'completed' } }, 3)
  await starts[0].promise
  emit(selected, 'assistant/message', finalMessage(1, 4, [{ type: 'text', text: 'duplicate' }]), 4)
  emit(selected, 'turn/end', { turn: 1, reason: { kind: 'completed' } }, 5)
  emit(selected, 'turn/start', { turn: 2 }, 6)
  emit(selected, 'assistant/message', finalMessage(2, 7, [{ type: 'text', text: 'two' }]), 7)
  emit(selected, 'turn/end', { turn: 2, reason: { kind: 'completed' } }, 8)
  assert.deepEqual(calls, ['one'])
  gates[0].resolve(makePcmWave())
  await starts[1].promise
  assert.deepEqual(calls, ['one', 'two'])
  gates[1].resolve(makePcmWave())
  await waitFor(() => delivered.length === 2, 'second audio delivery')
  assert.deepEqual(delivered, [1, 2])
})

test('rebind aborts and joins ignored work before installing the next session; old queued audio is dropped', async t => {
  const first = actor('session-before-rebind')
  const second = actor('session-after-rebind')
  const agents = new Map([[first.agent.id, first.agent], [second.agent.id, second.agent]])
  const ctx = host(agents)
  const calls = []
  const firstGate = deferred()
  const firstStarted = deferred()
  let firstSignal
  const delivered = []
  const controller = createSessionSpeechController({
    ctx,
    provider: {
      synthesize(text, { signal }) {
        calls.push(text)
        if (calls.length === 1) { firstSignal = signal; firstStarted.resolve(); return firstGate.promise }
        return Promise.resolve(makePcmWave())
      },
    },
    onAudio: dto => delivered.push(dto),
  })
  t.after(() => controller.dispose())
  const oldBinding = await controller.bindAgent(first.agent.id)
  emit(first, 'turn/start', { turn: 1 }, 1)
  emit(first, 'assistant/message', finalMessage(1, 2, [{ type: 'text', text: 'old active' }]), 2)
  emit(first, 'turn/end', { turn: 1, reason: { kind: 'completed' } }, 3)
  await firstStarted.promise
  emit(first, 'turn/start', { turn: 2 }, 4)
  emit(first, 'assistant/message', finalMessage(2, 5, [{ type: 'text', text: 'old queued' }]), 5)
  emit(first, 'turn/end', { turn: 2, reason: { kind: 'completed' } }, 6)
  let rebound = false
  const rebinding = controller.bindAgent(second.agent.id).then(value => { rebound = true; return value })
  await Promise.resolve()
  assert.equal(firstSignal.aborted, true)
  assert.equal(rebound, false)
  firstGate.resolve(makePcmWave())
  const newBinding = await rebinding
  assert.ok(newBinding.generation > oldBinding.generation)
  assert.deepEqual(calls, ['old active'])
  assert.deepEqual(delivered, [])

  emit(first, 'turn/start', { turn: 3 }, 7)
  emit(first, 'assistant/message', finalMessage(3, 8, [{ type: 'text', text: 'must not leak' }]), 8)
  emit(first, 'turn/end', { turn: 3, reason: { kind: 'completed' } }, 9)
  emit(second, 'turn/start', { turn: 1 }, 10)
  emit(second, 'assistant/message', finalMessage(1, 11, [{ type: 'text', text: 'new session final' }]), 11)
  emit(second, 'turn/end', { turn: 1, reason: { kind: 'completed' } }, 12)
  await waitFor(() => delivered.length === 1, 'new session audio')
  assert.equal(delivered[0].sessionId, second.session.id)
  assert.equal(delivered[0].generation, newBinding.generation)
  assert.deepEqual(calls, ['old active', 'new session final'])
  await controller.stop()
  assert.equal(controller.getCurrentTarget(), null)
})

test('agent disposal detaches its event subscription and prevents later work', async t => {
  const selected = actor('session-dispose')
  const agents = new Map([[selected.agent.id, selected.agent]])
  const ctx = host(agents)
  const calls = []
  const controller = createSessionSpeechController({
    ctx, provider: { async synthesize(text) { calls.push(text); return makePcmWave() } }, onAudio: () => {},
  })
  t.after(() => controller.dispose())
  await controller.bindAgent(selected.agent.id)
  assert.equal(selected.handlers.has('session/event'), true)
  agents.delete(selected.agent.id)
  ctx.emit('agent/disposed', { agent: selected.agent })
  await waitFor(() => controller.getCurrentTarget() === null, 'agent disposal')
  assert.equal(selected.handlers.has('session/event'), false)
  emit(selected, 'turn/start', { turn: 1 }, 1)
  emit(selected, 'assistant/message', finalMessage(1, 2, [{ type: 'text', text: 'closed' }]), 2)
  emit(selected, 'turn/end', { turn: 1, reason: { kind: 'completed' } }, 3)
  assert.deepEqual(calls, [])
})

test('concurrent controller dispose calls join the same active synthesis and suppress its result', async () => {
  const selected = actor('session-dispose-join')
  const ctx = host(new Map([[selected.agent.id, selected.agent]]))
  const gate = deferred()
  const started = deferred()
  const delivered = []
  let signal
  const controller = createSessionSpeechController({
    ctx,
    provider: { synthesize(_text, options) { signal = options.signal; started.resolve(); return gate.promise } },
    onAudio: dto => delivered.push(dto),
  })
  await controller.bindAgent(selected.agent.id)
  emit(selected, 'turn/start', { turn: 1 }, 1)
  emit(selected, 'assistant/message', finalMessage(1, 2, [{ type: 'text', text: 'dispose while active' }]), 2)
  emit(selected, 'turn/end', { turn: 1, reason: { kind: 'completed' } }, 3)
  await started.promise
  const firstDispose = controller.dispose()
  const secondDispose = controller.dispose()
  assert.strictEqual(secondDispose, firstDispose)
  await waitFor(() => signal.aborted, 'active synthesis abort')
  assert.equal(signal.aborted, true)
  gate.resolve(makePcmWave())
  await Promise.all([firstDispose, secondDispose])
  assert.deepEqual(delivered, [])
  assert.equal(controller.getCurrentTarget(), null)
})

test('onAudio may reenter stop without awaiting the pump; stop synchronously drops queued turns', async t => {
  const selected = actor('session-delivery-stop')
  const ctx = host(new Map([[selected.agent.id, selected.agent]]))
  const calls = []
  let controller
  let stopResult
  controller = createSessionSpeechController({
    ctx,
    provider: { async synthesize(text) { calls.push(text); return makePcmWave() } },
    onAudio() { stopResult = controller.stop(); return stopResult },
  })
  t.after(() => controller.dispose())
  await controller.bindAgent(selected.agent.id)
  emit(selected, 'turn/start', { turn: 1 }, 1)
  emit(selected, 'assistant/message', finalMessage(1, 2, [{ type: 'text', text: 'first reply' }]), 2)
  emit(selected, 'turn/end', { turn: 1, reason: { kind: 'completed' } }, 3)
  emit(selected, 'turn/start', { turn: 2 }, 4)
  emit(selected, 'assistant/message', finalMessage(2, 5, [{ type: 'text', text: 'queued reply' }]), 5)
  emit(selected, 'turn/end', { turn: 2, reason: { kind: 'completed' } }, 6)
  await waitFor(() => stopResult !== undefined, 'onAudio reentrant stop')
  await stopResult
  assert.deepEqual(calls, ['first reply'])
  assert.equal(controller.getCurrentTarget(), null)
})

test('an asynchronous onAudio rejection is reported without blocking later final replies', async t => {
  const selected = actor('session-delivery-reject')
  const ctx = host(new Map([[selected.agent.id, selected.agent]]))
  const calls = []
  const errors = []
  let delivered = 0
  const controller = createSessionSpeechController({
    ctx,
    provider: { async synthesize(text) { calls.push(text); return makePcmWave() } },
    onAudio: async () => {
      delivered += 1
      if (delivered === 1) throw new Error('fixture rejection')
    },
    onError: error => errors.push(error.code),
  })
  t.after(() => controller.dispose())
  await controller.bindAgent(selected.agent.id)
  for (const [turn, seq, text] of [[1, 1, 'first'], [2, 4, 'second']]) {
    emit(selected, 'turn/start', { turn }, seq)
    emit(selected, 'assistant/message', finalMessage(turn, seq + 1, [{ type: 'text', text }]), seq + 1)
    emit(selected, 'turn/end', { turn, reason: { kind: 'completed' } }, seq + 2)
  }
  await waitFor(() => delivered === 2 && errors.length === 1, 'delivery rejection and next reply')
  assert.deepEqual(calls, ['first', 'second'])
  assert.deepEqual(errors, ['session_speech_delivery_failed'])
})

test('Windows System.Speech provider writes local WAV, cancels and joins only its child, then removes owned files', {
  skip: process.platform === 'win32' ? false : 'Windows System.Speech integration requires Windows',
}, async t => {
  const tempParent = await mkdtemp(join(tmpdir(), 'tradeloom-session-speech-test-中文-'))
  const provider = createWindowsSpeechProvider({ tempParent })
  t.after(async () => { await provider.dispose(); await rm(tempParent, { recursive: true, force: true }) })

  const [audio, concurrentAudio] = await Promise.all([
    provider.synthesize('This is a local speech synthesis test.'),
    provider.synthesize('Concurrent local speech synthesis test.'),
  ])
  for (const result of [audio, concurrentAudio]) {
    assert.equal(result.mimeType, 'audio/wav')
    assert.equal(result.format.encoding, 'pcm')
    assert.equal(result.format.channels, 1)
    assert.equal(result.format.sampleRate, 16000)
    assert.equal(result.format.bitsPerSample, 16)
    assert.ok(result.dataBytes > 0)
    assert.ok(result.bytes.byteLength > result.dataBytes)
  }
  assert.deepEqual(provider.diagnostics(), { started: 2, exited: 2, active: 0 })
  assert.equal((await readdir(tempParent)).filter(name => name.startsWith('tradeloom-session-speech-')).length, 1)

  const abort = new AbortController()
  const cancelled = provider.synthesize('Speech cancellation test. '.repeat(400), { signal: abort.signal })
  await waitFor(() => provider.diagnostics().started === 3, 'owned PowerShell child start')
  abort.abort()
  await assert.rejects(cancelled, { code: 'session_speech_cancelled' })
  assert.deepEqual(provider.diagnostics(), { started: 3, exited: 3, active: 0 })
  const dispose = provider.dispose()
  assert.strictEqual(provider.dispose(), dispose)
  await dispose
  assert.deepEqual(await readdir(tempParent), [])

  const disposingProvider = createWindowsSpeechProvider({ tempParent })
  const active = disposingProvider.synthesize('Dispose must terminate and join this child. '.repeat(200))
  const activeOutcome = active.then(() => null, error => error)
  await waitFor(() => disposingProvider.diagnostics().started === 1, 'provider dispose child start')
  const providerDispose = disposingProvider.dispose()
  assert.strictEqual(disposingProvider.dispose(), providerDispose)
  await providerDispose
  assert.equal((await activeOutcome)?.code, 'session_speech_cancelled')
  assert.deepEqual(disposingProvider.diagnostics(), { started: 1, exited: 1, active: 0 })
  assert.deepEqual(await readdir(tempParent), [])

  const unavailableVoice = createWindowsSpeechProvider({ tempParent, voice: `TradeLoom missing ${Date.now()}` })
  await assert.rejects(unavailableVoice.synthesize('Typed voice failure.'), { code: 'session_speech_voice_unavailable' })
  assert.deepEqual(unavailableVoice.diagnostics(), { started: 1, exited: 1, active: 0 })
  await unavailableVoice.dispose()
  assert.deepEqual(await readdir(tempParent), [])
})
