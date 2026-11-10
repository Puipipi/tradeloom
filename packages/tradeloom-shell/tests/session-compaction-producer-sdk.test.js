import assert from 'node:assert/strict'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import test from 'node:test'
import { createSessionUsageController } from '@tradeloom/dsh-business-shell/session-usage'
import { registerSessionCompactionStatsProjection } from '@tradeloom/dsh-business-shell/session-compaction-stats'

const sdkRoot = process.env.TRADELOOM_REP12_SDK_ROOT

async function sdkModule(relativePath) {
  return await import(pathToFileURL(join(sdkRoot, relativePath)).href)
}

async function setup(t, sessionId) {
  const [cordis, llm, sessions, projection, tokenMeter, compaction, controller, zod] = await Promise.all([
    sdkModule('vendor/cordis/lib/index.js'),
    sdkModule('packages/llm/llm/lib/index.js'),
    sdkModule('packages/core/session/lib/index.js'),
    sdkModule('packages/session/session-projection/lib/index.js'),
    sdkModule('packages/llm/token-meter/lib/index.js'),
    sdkModule('packages/compaction/compaction-basic/lib/index.js'),
    sdkModule('packages/api/session-controller/lib/index.js'),
    sdkModule('node_modules/zod/index.js'),
  ])
  const ctx = new cordis.Context()
  await ctx.plugin(sessions.default)
  await ctx.plugin(projection.default)
  await ctx.plugin(tokenMeter.default)
  const unregister = registerSessionCompactionStatsProjection(ctx, { z: zod.z })
  const session = ctx.sessions.create(sessionId)
  const agent = { id: sessionId, session, options: {} }
  ctx.provide('agents', { get: id => id === agent.id ? agent : undefined })

  const controllerSurface = {
    ctx,
    liveProjections: controller.SessionController.prototype.liveProjections,
  }
  ctx.provide('sessionController', {
    projections: controller.SessionController.prototype.projections.bind(controllerSurface),
  })
  const usage = createSessionUsageController({ ctx })
  t.after(async () => {
    await usage.dispose()
    unregister()
    await ctx.fiber.dispose()
  })

  // Three closed turns plus one open turn are the official compaction fixture
  // shape. Only ordinary SDK events are appended here; the engine owns every
  // compaction lifecycle and surface replacement event asserted below.
  for (let turn = 1; turn <= 3; turn += 1) {
    session.append('turn/start', { turn })
    session.append('user/message', llm.createUserMessage({
      content: [{ type: 'text', text: `local producer source ${turn} ${'context '.repeat(32)}` }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    session.append('step/start', { turn, step: 1 })
    if (turn === 1) {
      session.append('request/header', {
        header: { config: { provider: 'fixture', model: 'fixture' } },
        reason: 'initial',
      })
    }
    session.append('assistant/message', {
      stream: [],
      turn,
      step: 1,
      message: llm.createMessage({
        role: 'assistant',
        content: [{ type: 'text', text: `local producer answer ${turn}` }],
        source: { kind: 'model', provider: 'fixture', model: 'fixture' },
      }),
    }, { surfaceOp: 'append' })
    session.append('step/end', { turn, step: 1 })
    session.append('turn/end', { turn, reason: { kind: 'completed' } })
  }
  session.append('turn/start', { turn: 4 })

  return { ctx, session, agent, usage, BasicCompactionEngine: compaction.default }
}

test('actual BasicCompactionEngine producer applies a summary and the projection sees the completed lifecycle', {
  skip: sdkRoot ? false : 'set TRADELOOM_REP12_SDK_ROOT to run the pinned rep12 SDK integration',
}, async t => {
  const { ctx, session, agent, usage, BasicCompactionEngine } = await setup(t, 'f13-producer-success')
  const summaryText = 'fixed local summarizer output'
  class FixedSummaryEngine extends BasicCompactionEngine {
    async summarize() {
      return { summary: [{ type: 'text', text: summaryText }], provider: 'fixture', model: 'fixture' }
    }
  }
  const engine = new FixedSummaryEngine(ctx, { auto: false })
  const before = [...session.surface.nodes]
  const result = await engine.compactRegion(before[0], before[3], agent)

  const events = session.snapshotEvents()
  const start = events.find(event => event.type === 'compaction/start')
  const summary = events.find(event => event.type === 'compaction/summary')
  const replacement = events.find(event => event.type === 'user/message' && event.surfaceOp?.op === 'replace')
  const end = events.find(event => event.type === 'compaction/end')
  assert.ok(start && summary && replacement && end)
  assert.ok(start.seq < summary.seq && summary.seq + 1 === replacement.seq && replacement.seq < end.seq)
  assert.equal(summary.data.compactionId, start.data.compactionId)
  assert.deepEqual(summary.data.shadowedRange, result.shadowedRange)
  assert.deepEqual(replacement.surfaceOp, {
    op: 'replace', startSeq: result.shadowedRange.start, endSeq: result.shadowedRange.end,
  })
  assert.ok(replacement.sourceEventSeqs.includes(start.seq))
  assert.ok(replacement.sourceEventSeqs.includes(summary.seq))
  assert.equal(session.deriveMessages()[0].content.some(block => block.type === 'text' && block.text.includes(summaryText)), true)

  const binding = usage.bindAgent(agent.id)
  const read = await usage.readUsage({ binding })
  assert.equal(read.status, 'available')
  assert.equal(read.target.sessionId, session.id)
  assert.deepEqual(read.projections.compactionStats, {
    attempts: 1, summaryApplied: 1, completed: 1, failed: 0, inflight: 0,
  })
  assert.equal(JSON.stringify(read.projections.compactionStats).includes(summaryText), false)
})

test('actual BasicCompactionEngine producer records a failed summary without replacing the surface or leaking raw error', {
  skip: sdkRoot ? false : 'set TRADELOOM_REP12_SDK_ROOT to run the pinned rep12 SDK integration',
}, async t => {
  const { ctx, session, agent, usage, BasicCompactionEngine } = await setup(t, 'f13-producer-failure')
  const failureText = 'fixture summarizer secret failure detail'
  class FailingSummaryEngine extends BasicCompactionEngine {
    async summarize() { throw new Error(failureText) }
  }
  const engine = new FailingSummaryEngine(ctx, { auto: false })
  const before = [...session.surface.nodes]
  const preexistingReplacements = session.snapshotEvents().filter(event => event.type === 'user/message' && event.surfaceOp?.op === 'replace').length
  await assert.rejects(engine.compactRegion(before[0], before[3], agent), error => {
    assert.match(error.message, /fixture summarizer secret failure detail/)
    return true
  })

  const events = session.snapshotEvents()
  const start = events.find(event => event.type === 'compaction/start')
  const summaries = events.filter(event => event.type === 'compaction/summary')
  const replacements = events.filter(event => event.type === 'user/message' && event.surfaceOp?.op === 'replace')
  const end = events.find(event => event.type === 'compaction/end')
  assert.ok(start && end)
  assert.equal(summaries.length, 0)
  assert.equal(replacements.length, preexistingReplacements)
  assert.deepEqual(session.surface.nodes, before)
  assert.ok(start.seq < end.seq)
  assert.equal(end.data.compactionId, start.data.compactionId)
  assert.equal(Object.hasOwn(end.data, 'error'), true)

  const binding = usage.bindAgent(agent.id)
  const read = await usage.readUsage({ binding })
  assert.equal(read.status, 'available')
  assert.deepEqual(read.projections.compactionStats, {
    attempts: 1, summaryApplied: 0, completed: 0, failed: 1, inflight: 0,
  })
  assert.equal(JSON.stringify(read.projections.compactionStats).includes(failureText), false)
  assert.equal(JSON.stringify(read.projections.compactionStats).includes('rawOutput'), false)
})
