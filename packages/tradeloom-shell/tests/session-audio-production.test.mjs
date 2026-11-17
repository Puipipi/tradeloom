import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { randomUUID } from 'node:crypto'
import { createSessionAudioHandler } from '../session-speech.js'

test('real rc2 Agent events reach the authenticated audio consumer only after completed final; stop joins controlled synthesis', async t => {
  assert.ok(process.env.TL_SEVEN_SDK_RUNTIME, 'explicit installed rc2 SDK is mandatory')
  const require = createRequire(pathToFileURL(join(process.env.TL_SEVEN_SDK_RUNTIME, 'package.json')))
  assert.equal(require('./package.json').version, '0.2.2-rc.2')
  const { Context } = require('@deepseek-ai/cordis'), { AgentLoop } = require('@deepseek-ai/dsh-agent-loop')
  const ctx = new Context()
  ctx.provide('llm', { async prepareCall() { throw Error('No model permitted in this controlled test') } })
  for (const [pkg, exportName] of [['dsh-session', 'SessionStore'], ['dsh-session-projection', 'SessionProjectionRegistry'], ['dsh-agent', 'AgentRegistry'], ['dsh-system-prompt', 'SystemPrompt'], ['dsh-tools', 'ToolsService']]) await ctx.plugin(require('@deepseek-ai/' + pkg)[exportName])
  await ctx.plugin(require('@deepseek-ai/dsh-tool-executor-native'))
  await ctx.plugin(AgentLoop, { agents: [], maxParallelToolCalls: 1 })
  const agent = await ctx.agentLoop.create('synthetic-audio', {}, { agentPreset: 'tradeloom-center' })
  ctx.provide('connection', { requestRejection: () => undefined })
  const source = { guestId: 1, generation: 1, sceneId: 'one', panelId: 'chat', roleId: 'center', sessionId: agent.id,
    workspaceId: 'synthetic-workspace', workspacePath: 'synthetic-no-files', agentPreset: 'tradeloom-center', bindingRevision: '1' }
  let state = { roles: { center: { sessionId: agent.id, workspaceId: source.workspaceId, workspacePath: source.workspacePath, agentPreset: source.agentPreset } }, roleBindingRevisions: { center: '1' } }
  const authority = { verifyRequest: async request => { assert.equal(request.endpoint, 'tradeloom/session-audio'); assert.equal(request.bodyDigest.length, 64); return {} },
    withVerifiedRequestOrigin: (_origin, action) => action(), sourceForOrigin: () => source,
    retainOriginWork: () => randomUUID(), captureQueuedOrigin: origin => origin, releaseOriginWork: async () => {} }
  const spoken = []; let disposed = 0
  const handler = createSessionAudioHandler(ctx, authority, { createStateStore: async () => ({ read: async () => state }),
    createProvider: () => ({ async synthesize(text) { spoken.push(text); return { mimeType: 'audio/wav', bytes: new Uint8Array([1, 2]), format: { encoding: 'pcm', channels: 1, sampleRate: 16000, bitsPerSample: 16, durationSeconds: 1 } } }, async dispose() { disposed++ } }) })
  t.after(async () => { await handler.dispose(); await ctx.fiber.dispose() })
  async function call(action, lease, extra = {}) {
    const req = Readable.from([Buffer.from(JSON.stringify({ id: randomUUID(), action, ...(lease ? { lease } : {}), ...extra }))])
    req.method = 'POST'; req.headers = { 'x-tradeloom-origin': 'controlled-proof' }
    let value; const res = { statusCode: 200, writableEnded: false, setHeader() {}, end(bytes) { this.writableEnded = true; value = JSON.parse(bytes) } }
    await handler.handle(req, res); return { status: res.statusCode, ...value }
  }
  const start = await call('start'); assert.equal(start.status, 200)
  // Append through the actual SDK log; emitting disconnected seq numbers
  // bypasses its projection/publication contract and is not a real producer.
  const emit = event => agent.session.append(event.type, event.data, event.type === 'assistant/message' ? { surfaceOp: 'append' } : undefined)
  emit({ type: 'turn/start', data: { turn: 1 }, seq: 1 })
  emit({ type: 'assistant/message', data: { turn: 1, step: 1, seq: 1, message: { content: [{ type: 'text', text: 'synthetic final' }] } }, seq: 2 })
  await Promise.resolve(); assert.deepEqual(spoken, [])
  emit({ type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } }, seq: 3 })
  for (let attempt = 0; attempt < 20 && !spoken.length; attempt++) await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(spoken, ['synthetic final'])
  const poll = await call('poll', start.result.lease); assert.equal(poll.status, 200); assert.equal(poll.result.audio.mimeType, 'audio/wav')
  await call('stop', start.result.lease); assert.equal(disposed, 1)
  const denied = await call('start', undefined, { text: 'renderer may not choose speech text' }); assert.equal(denied.status, 409)
  state = { ...state, roleBindingRevisions: { center: '2' } }
  assert.equal((await call('start')).status, 409)
})
