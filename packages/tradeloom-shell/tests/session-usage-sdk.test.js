import assert from 'node:assert/strict'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import test from 'node:test'
import { createSessionUsageController } from '@tradeloom/dsh-business-shell/session-usage'
import { registerSessionCompactionStatsProjection, SESSION_COMPACTION_STATS_KEY, SESSION_COMPACTION_STATS_STATE_VERSION } from '@tradeloom/dsh-business-shell/session-compaction-stats'

const sdkRoot = process.env.TRADELOOM_REP12_SDK_ROOT

async function sdkModule(relativePath) {
  return await import(pathToFileURL(join(sdkRoot, relativePath)).href)
}

test('rep12 SessionController.projections reads real SessionStore and registered stats/token projections', {
  skip: sdkRoot ? false : 'set TRADELOOM_REP12_SDK_ROOT to run the pinned rep12 SDK integration',
}, async t => {
  const [cordis, llmModule, sessionModule, projectionModule, statsModule, meterModule, controllerModule, zodModule] = await Promise.all([
    sdkModule('vendor/cordis/lib/index.js'),
    sdkModule('packages/llm/llm/lib/index.js'),
    sdkModule('packages/core/session/lib/index.js'),
    sdkModule('packages/session/session-projection/lib/index.js'),
    sdkModule('packages/session/session-stats/lib/index.js'),
    sdkModule('packages/llm/token-meter/lib/index.js'),
    sdkModule('packages/api/session-controller/lib/index.js'),
    sdkModule('node_modules/zod/index.js'),
  ])
  const ctx = new cordis.Context()
  await ctx.plugin(sessionModule.default)
  await ctx.plugin(projectionModule.default)
  await ctx.plugin(statsModule)
  await ctx.plugin(meterModule.default)

  const session = ctx.sessions.create('session-usage-rep12')

  // Exercise the actual public SessionController.projections method against
  // the real in-memory stores and projection plugins. The fixture bypasses
  // unrelated Remote/Host constructor dependencies; there is no transport.
  const controllerSurface = {
    ctx,
    liveProjections: controllerModule.SessionController.prototype.liveProjections,
  }
  const reader = {
    projections: controllerModule.SessionController.prototype.projections.bind(controllerSurface),
  }
  ctx.provide('sessionController', reader)
  const agent = { id: session.id, session }
  ctx.provide('agents', { get: id => id === agent.id ? agent : undefined })
  const consumer = createSessionUsageController({ ctx })
  t.after(async () => {
    await consumer.dispose()
    await ctx.fiber.dispose()
  })

  const binding = consumer.bindAgent(agent.id)
  const empty = await consumer.readUsage({ binding })
  assert.equal(empty.status, 'available')
  assert.equal(empty.asOfSeq, -1)
  assert.deepEqual(empty.projections.sessionStats, {
    turns: 0, steps: 0, llmMs: 0, toolMs: 0, ttftMs: 0, ttftSteps: 0, decodeMs: 0, decodeTokens: 0,
  })

  const compactionEvents = []
  compactionEvents.push(session.append('user/message', llmModule.createUserMessage({
    content: [{ type: 'text', text: 'fixture source one' }], source: { kind: 'user' },
  }), { surfaceOp: 'append' }))
  compactionEvents.push(session.append('user/message', llmModule.createUserMessage({
    content: [{ type: 'text', text: 'fixture source two' }], source: { kind: 'user' },
  }), { surfaceOp: 'append' }))
  const start = session.append('compaction/start', { compactionId: 'f13-fixture-compaction', turn: null })
  compactionEvents.push(start)
  const summaryEvent = session.append('compaction/summary', {
    compactionId: start.data.compactionId,
    summary: [{ type: 'text', text: 'fixture summary content must not persist in counters' }],
    shadowedRange: { start: 0, end: 1 }, shadowedSeqs: [0, 1], shadowedTokenCount: 8,
    provider: 'fixture', model: 'fixture',
  })
  compactionEvents.push(summaryEvent)
  const beforeLateRegister = await consumer.readUsage({ binding })
  assert.equal(beforeLateRegister.unknownProjections.includes('tradeloomCompactionStats'), true)
  const unregisterCompaction = registerSessionCompactionStatsProjection(ctx, { z: zodModule.z })
  let compactionRegistered = true
  t.after(() => { if (compactionRegistered) unregisterCompaction() })
  const afterLateRegister = await consumer.readUsage({ binding })
  assert.deepEqual(afterLateRegister.projections.compactionStats, {
    attempts: 1, summaryApplied: 0, completed: 0, failed: 0, inflight: 1,
  })
  assert.equal(afterLateRegister.unknownProjections.includes('tradeloomCompactionStats'), false)

  const checkpointBeforeReplacement = ctx.sessionProjections.checkpoint(session)
  const replacementEvent = session.append('user/message', llmModule.createUserMessage({
    content: [{ type: 'text', text: 'fixture replacement' }], source: { kind: 'user' },
  }), {
    surfaceOp: { op: 'replace', startSeq: 0, endSeq: 1 },
    sourceEventSeqs: [start.seq, summaryEvent.seq, 0, 1],
  })
  compactionEvents.push(replacementEvent)
  const tail = ctx.sessionProjections.restore(checkpointBeforeReplacement, [replacementEvent], replacementEvent.seq, session.header, 0)
  assert.deepEqual(tail.snapshot.values[SESSION_COMPACTION_STATS_KEY], {
    attempts: 1, summaryApplied: 1, completed: 0, failed: 0, inflight: 1,
  })
  compactionEvents.push(session.append('compaction/end', { compactionId: start.data.compactionId, turn: null }))
  const afterEnd = await consumer.readUsage({ binding })
  assert.deepEqual(afterEnd.projections.compactionStats, {
    attempts: 1, summaryApplied: 1, completed: 1, failed: 0, inflight: 0,
  })

  const checkpoint = ctx.sessionProjections.checkpoint(session)
  const stale = { ...checkpoint, [SESSION_COMPACTION_STATS_KEY]: {
    ...checkpoint[SESSION_COMPACTION_STATS_KEY], ver: SESSION_COMPACTION_STATS_STATE_VERSION - 1, val: { stale: true },
  } }
  const cold = ctx.sessionProjections.restore(stale, compactionEvents, 0, session.header, 0)
  assert.deepEqual(cold.snapshot.values[SESSION_COMPACTION_STATS_KEY], {
    attempts: 1, summaryApplied: 1, completed: 1, failed: 0, inflight: 0,
  })
  assert.equal(JSON.stringify(cold.checkpoint[SESSION_COMPACTION_STATS_KEY]).includes('fixture summary content'), false)

  session.append('turn/start', { turn: 1 })
  session.append('step/start', { turn: 1, step: 1 })
  const reportedUsage = { inputTokens: 19, outputTokens: 7, cacheReadTokens: 3, cacheWriteTokens: 2 }
  session.append('assistant/message', {
    stream: [{ type: 'chunk', time: 0, chunk: { type: 'usage', usage: reportedUsage } }],
    turn: 1,
    step: 1,
    message: llmModule.createMessage({
      role: 'assistant',
      content: [{ type: 'text', text: 'synthetic local fixture' }],
      source: { kind: 'model', provider: 'mock', model: 'mock' },
    }),
    usage: reportedUsage,
  }, { surfaceOp: 'append' })
  session.append('step/end', { turn: 1, step: 1 })
  session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  const result = await consumer.readUsage({ binding })
  assert.equal(result.status, 'available')
  assert.equal(result.target.sessionId, session.id)
  assert.equal(result.asOfSeq, session.seq - 1)
  assert.equal(result.projections.sessionStats.turns, 1)
  assert.equal(result.projections.sessionStats.steps, 1)
  assert.ok(result.projections.sessionStats.llmMs >= 0)
  assert.deepEqual(result.projections.tokenUsage, {
    uncachedInputTokens: 19, outputTokens: 7, cacheReadTokens: 3, cacheWriteTokens: 2,
  })
  assert.ok(Object.hasOwn(result.projections, 'contextPressure'))
  assert.ok(Object.hasOwn(result.projections, 'contextBreakdown'))
  assert.deepEqual(result.unknownProjections, [])

  unregisterCompaction()
  compactionRegistered = false
  const afterUnmount = await consumer.readUsage({ binding })
  assert.equal(afterUnmount.unknownProjections.includes('tradeloomCompactionStats'), true)
})
