import assert from 'node:assert/strict'
import { pathToFileURL } from 'node:url'
import { join } from 'node:path'
import test from 'node:test'
import { createSessionSpeechController } from '../session-speech.js'

const sdkRoot = process.env.TRADELOOM_REP12_SDK_ROOT

async function sdkModule(relativePath) {
  return await import(pathToFileURL(join(sdkRoot, relativePath)).href)
}

async function packageModule(packagePath, name) {
  const { createRequire } = await import('node:module')
  const require = createRequire(pathToFileURL(join(sdkRoot, packagePath, '__session_speech_test__.cjs')))
  return await import(pathToFileURL(require.resolve(name)).href)
}

function deferred() {
  let resolve
  const promise = new Promise(yes => { resolve = yes })
  return { promise, resolve }
}

function pcmWave() {
  const bytes = Buffer.alloc(46)
  bytes.write('RIFF', 0, 'ascii'); bytes.writeUInt32LE(38, 4); bytes.write('WAVE', 8, 'ascii')
  bytes.write('fmt ', 12, 'ascii'); bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20)
  bytes.writeUInt16LE(1, 22); bytes.writeUInt32LE(16000, 24); bytes.writeUInt32LE(32000, 28)
  bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34); bytes.write('data', 36, 'ascii')
  bytes.writeUInt32LE(2, 40)
  return { mimeType: 'audio/wav', format: { encoding: 'pcm', channels: 1, sampleRate: 16000, bitsPerSample: 16, durationSeconds: 1 / 16000 }, bytes }
}

test('rep12 Cordis AgentLoop final session event is consumed without an external model', {
  skip: sdkRoot ? false : 'set TRADELOOM_REP12_SDK_ROOT to run the pinned rep12 SDK integration',
}, async t => {
  const [{ Context }, llm, testkit, adapterModule] = await Promise.all([
    sdkModule('vendor/cordis/lib/index.js'),
    packageModule('packages/llm/llm', '@deepseek-ai/dsh-llm'),
    packageModule('packages/test-support/agent-loop-testkit', '@deepseek-ai/dsh-agent-loop-testkit'),
    sdkModule('packages/core/agent-loop/tests/mock-adapter.ts'),
  ])
  const ctx = new Context()
  let controller
  try {
    await testkit.mountAgentLoopTestDependencies(ctx)
    const harness = await testkit.mountAgentLoopTestHarness(ctx)
    const adapter = new adapterModule.MockAdapter([adapterModule.textResponse('A local SDK final reply.')])
    ctx.llm.registerAdapter(['mock'], adapter)
    const agent = await harness.create('session-speech-sdk', { provider: 'mock', model: 'mock' })
    const delivered = deferred()
    controller = createSessionSpeechController({
      ctx,
      provider: { async synthesize() { return pcmWave() } },
      onAudio: dto => delivered.resolve(dto),
    })
    const binding = await controller.bindAgent(agent.id)
    agent.followup(llm.createUserMessage({
      content: [{ type: 'text', text: 'Synthetic input for the local SDK test.' }],
      source: { kind: 'user' },
    }))
    await agent.whenIdle()
    const dto = await delivered.promise
    assert.equal(dto.sessionId, agent.session.id)
    assert.equal(dto.generation, binding.generation)
    assert.equal(dto.turn, 1)
    assert.ok(dto.seq > 0)
    assert.equal(adapter.requests.length, 1)
    assert.equal(adapter.requests[0].messages.some(message => JSON.stringify(message).includes('Synthetic input for the local SDK test.')), true)
  } finally {
    await controller?.dispose()
    await ctx.fiber.dispose()
  }
})
