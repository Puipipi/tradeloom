import assert from 'node:assert/strict'
import { pathToFileURL } from 'node:url'
import { join } from 'node:path'
import test from 'node:test'
import { createSessionTranscriptionController } from '@tradeloom/dsh-business-shell/session-transcription'

const sdkRoot = process.env.TRADELOOM_REP12_SDK_ROOT

async function sdkModule(relativePath) {
  return await import(pathToFileURL(join(sdkRoot, relativePath)).href)
}

function deferred() {
  let resolve
  const promise = new Promise(yes => { resolve = yes })
  return { promise, resolve }
}

async function waitFor(check) {
  const until = Date.now() + 2_000
  while (!check()) {
    if (Date.now() > until) throw new Error('condition did not settle')
    await new Promise(resolve => setTimeout(resolve, 5))
  }
}

test('rep12 SpeechToText service resolves and transcribes one explicit target without submitting a message', {
  skip: sdkRoot ? false : 'set TRADELOOM_REP12_SDK_ROOT to run the pinned rep12 SDK integration',
}, async t => {
  const [{ Context }, speechModule] = await Promise.all([
    sdkModule('vendor/cordis/lib/index.js'),
    sdkModule('packages/experimental/speech-to-text/lib/index.js'),
  ])
  const ctx = new Context()
  let serviceFiber
  let controller
  let removeProvider
  try {
    serviceFiber = ctx.plugin(speechModule.default, { defaultProvider: 'controlled-local', language: 'en' })
    await serviceFiber
    const speech = ctx.get('speechToText')
    const providerCalls = []
    const ignoredAbort = deferred()
    let settleSecond = false
    let secondStarted
    const secondStart = new Promise(resolve => { secondStarted = resolve })
    let secondSignal
    removeProvider = speech.register({
      info: { id: 'controlled-local', name: 'Controlled local test provider', location: 'host-local', languages: ['en'] },
      async transcribe(input, signal) {
        providerCalls.push({ byteLength: input.audio.byteLength, language: input.language })
        if (settleSecond) {
          secondSignal = signal
          secondStarted()
          return await ignoredAbort.promise // Deliberately ignores AbortSignal until the test releases it.
        }
        signal.throwIfAborted()
        return { text: 'Recognized in the controlled rep12 provider.', audioSeconds: 1.25, inferenceSeconds: 0.03 }
      },
    })
    const sent = []
    const agent = { id: 'rep12-agent', session: { id: 'rep12-session', header: { agentPreset: 'fixture-preset' } }, followup: value => sent.push(value) }
    ctx.provide('agents', { get: id => id === agent.id ? agent : undefined })
    controller = createSessionTranscriptionController({ ctx })
    const binding = await controller.bindAgent(agent.id)
    const audio = Uint8Array.of(0x52, 0x49, 0x46, 0x46)
    const result = await controller.transcribe({ binding, audio })

    assert.deepEqual(result, {
      agentId: 'rep12-agent', sessionId: 'rep12-session', generation: binding.generation,
      providerId: 'controlled-local', language: 'en',
      text: 'Recognized in the controlled rep12 provider.', audioSeconds: 1.25, inferenceSeconds: 0.03,
    })
    assert.deepEqual(providerCalls, [{ byteLength: 4, language: 'en' }])
    assert.deepEqual(sent, [])

    settleSecond = true
    const late = controller.transcribe({ binding, audio: Uint8Array.of(5, 6) })
    await secondStart
    await controller.cancel()
    await assert.rejects(late, { code: 'session_transcription_cancelled' })
    assert.equal(secondSignal.aborted, true)
    assert.equal(controller.getInFlight(), true)
    ignoredAbort.resolve({ text: 'late result', audioSeconds: 1, inferenceSeconds: 0.1 })
    await waitFor(() => !controller.getInFlight())
    assert.deepEqual(sent, [])
  } finally {
    await controller?.dispose()
    await removeProvider?.()
    await ctx.fiber.dispose()
  }
})
