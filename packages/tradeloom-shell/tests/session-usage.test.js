import assert from 'node:assert/strict'
import test from 'node:test'
import { createSessionUsageController } from '../session-usage.js'
import { createSessionUsageController as createSessionUsagePackageExport } from '@tradeloom/dsh-business-shell/session-usage'

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

function agent(id, sessionId = id) { return { id, session: { id: sessionId } } }

function harness({ reader, agents = [agent('agent-a', 'session-a')] } = {}) {
  const liveAgents = new Map(agents.map(item => [item.id, item]))
  const services = { sessionController: reader }
  const ctx = { agents: { get: id => liveAgents.get(id) }, get: key => services[key] }
  return { ctx, agents: liveAgents, services }
}

const stats = {
  turns: 0, steps: 2, llmMs: 0, toolMs: 3, ttftMs: 0, ttftSteps: 0, decodeMs: 0, decodeTokens: 0,
}
const usage = { uncachedInputTokens: 0, outputTokens: 4, cacheReadTokens: 0, cacheWriteTokens: 1 }

test('package subpath exports the same controller implementation', () => {
  assert.equal(createSessionUsagePackageExport, createSessionUsageController)
})

test('projects only known sequenced values, preserving real zeroes and the exact target cut', async t => {
  const agentA = agent('agent-a', 'session-a')
  const reader = { async projections(request) {
    assert.deepEqual(request, { sessionId: 'session-a' })
    return { kind: 'sequenced', asOfSeq: 9, values: {
      sessionStats: stats,
      tokenUsage: usage,
      contextPressure: { pressureTokens: 0, projectedTokens: 7, contextWindow: 64_000, privateExtra: 99 },
      contextBreakdown: { systemTokens: 0, toolsTokens: 12, messageTokens: 0 },
      cost: { cents: 100 },
      messages: 42,
    } }
  } }
  const controller = createSessionUsageController({ ctx: harness({ reader, agents: [agentA] }).ctx })
  t.after(() => controller.dispose())
  const binding = controller.bindAgent(agentA.id)

  const result = await controller.readUsage({ binding })

  assert.deepEqual(result, {
    status: 'available',
    target: { agentId: 'agent-a', sessionId: 'session-a', generation: binding.generation },
    asOfSeq: 9,
    projections: { sessionStats: stats, tokenUsage: usage,
      contextPressure: { pressureTokens: 0, projectedTokens: 7, contextWindow: 64_000 },
      contextBreakdown: { systemTokens: 0, toolsTokens: 12, messageTokens: 0 } },
    unknownProjections: ['tradeloomCompactionStats'],
  })
  assert.equal(JSON.stringify(result).includes('cents'), false)
  assert.equal(JSON.stringify(result).includes('privateExtra'), false)
})

test('preserves the SDK empty-log sequence cursor of -1', async t => {
  const a = agent('agent-a', 'session-a')
  const reader = { async projections() { return { kind: 'sequenced', asOfSeq: -1, values: {} } } }
  const controller = createSessionUsageController({ ctx: harness({ reader, agents: [a] }).ctx })
  t.after(() => controller.dispose())
  const result = await controller.readUsage({ binding: controller.bindAgent(a.id) })
  assert.equal(result.status, 'available')
  assert.equal(result.asOfSeq, -1)
  assert.deepEqual(result.unknownProjections, ['sessionStats', 'tokenUsage', 'contextPressure', 'contextBreakdown', 'tradeloomCompactionStats'])
})

test('projects compaction counters only when the projection is registered and validated', async t => {
  const a = agent('agent-a', 'session-a')
  let response = { kind: 'sequenced', asOfSeq: 2, values: {
    tradeloomCompactionStats: { attempts: 1, summaryApplied: 1, completed: 0, failed: 0, inflight: 1 },
  } }
  const controller = createSessionUsageController({ ctx: harness({ reader: { async projections() { return response } }, agents: [a] }).ctx })
  t.after(() => controller.dispose())
  const binding = controller.bindAgent(a.id)
  let result = await controller.readUsage({ binding })
  assert.deepEqual(result.projections.compactionStats, {
    attempts: 1, summaryApplied: 1, completed: 0, failed: 0, inflight: 1,
  })
  assert.deepEqual(result.unknownProjections, ['sessionStats', 'tokenUsage', 'contextPressure', 'contextBreakdown'])

  response = { kind: 'sequenced', asOfSeq: 3, values: {
    tradeloomCompactionStats: { attempts: 1, summaryApplied: 1, completed: 1, failed: 0, inflight: 0, untrusted: true },
  } }
  result = await controller.readUsage({ binding })
  assert.deepEqual(result.projections.compactionStats, {
    attempts: 1, summaryApplied: 1, completed: 1, failed: 0, inflight: 0,
  })
  assert.equal(Object.hasOwn(result.projections.compactionStats, 'untrusted'), false)
})

test('missing, migration-required, unavailable and read failure remain distinct', async t => {
  const a = agent('agent-a', 'session-a')
  const reader = { projections: async () => null }
  const h = harness({ reader, agents: [a] })
  const controller = createSessionUsageController({ ctx: h.ctx })
  t.after(() => controller.dispose())
  const binding = controller.bindAgent(a.id)
  assert.deepEqual(await controller.readUsage({ binding }), {
    status: 'missing', target: { agentId: 'agent-a', sessionId: 'session-a', generation: binding.generation },
  })

  reader.projections = async () => ({ kind: 'migration-required', values: { sessionStats: stats, tokenUsage: usage } })
  assert.deepEqual(await controller.readUsage({ binding }), {
    status: 'migration_required',
    unknownProjections: ['sessionStats', 'tokenUsage', 'contextPressure', 'contextBreakdown', 'tradeloomCompactionStats'],
    target: { agentId: 'agent-a', sessionId: 'session-a', generation: binding.generation },
  })

  reader.projections = async () => ({ kind: 'sequenced', asOfSeq: 10, values: { unrelatedFutureProjection: { secret: 'omit' } } })
  assert.deepEqual(await controller.readUsage({ binding }), {
    status: 'available', target: { agentId: 'agent-a', sessionId: 'session-a', generation: binding.generation },
    asOfSeq: 10, projections: {},
    unknownProjections: ['sessionStats', 'tokenUsage', 'contextPressure', 'contextBreakdown', 'tradeloomCompactionStats'],
  })

  h.services.sessionController = undefined
  await assert.rejects(controller.readUsage({ binding }), { code: 'session_usage_unavailable' })
  h.services.sessionController = { async projections() { throw new Error('do not expose provider details') } }
  await assert.rejects(controller.readUsage({ binding }), error => {
    assert.equal(error.code, 'session_usage_read_failed')
    assert.equal(error.message, 'session_usage_read_failed')
    return true
  })
})

test('rejects stale recording-time targets and agent replacement without reading another session', async t => {
  const a = agent('agent-a', 'session-a')
  const b = agent('agent-b', 'session-b')
  let reads = 0
  const reader = { async projections({ sessionId }) { reads++; return { kind: 'sequenced', asOfSeq: 0, values: {} } } }
  const h = harness({ reader, agents: [a, b] })
  const controller = createSessionUsageController({ ctx: h.ctx })
  t.after(() => controller.dispose())
  const capturedA = controller.bindAgent(a.id)
  const bindingB = controller.bindAgent(b.id)
  await assert.rejects(controller.readUsage({ binding: capturedA }), { code: 'session_usage_target_changed' })
  assert.equal(reads, 0)

  h.agents.set(b.id, agent(b.id, b.session.id))
  await assert.rejects(controller.readUsage({ binding: bindingB }), { code: 'session_usage_target_changed' })
  assert.equal(reads, 0)
})

test('late projection read is rejected if target or SessionController source changes', async t => {
  const a = agent('agent-a', 'session-a')
  const gate = deferred()
  const started = deferred()
  let reads = 0
  const reader = { projections() { reads++; started.resolve(); return gate.promise } }
  const h = harness({ reader, agents: [a] })
  const controller = createSessionUsageController({ ctx: h.ctx })
  t.after(async () => { gate.resolve(null); await controller.dispose() })
  const binding = controller.bindAgent(a.id)
  const pending = controller.readUsage({ binding })
  await started.promise
  h.services.sessionController = { async projections() { throw new Error('replacement must not be called') } }
  gate.resolve({ kind: 'sequenced', asOfSeq: 1, values: { tokenUsage: usage } })
  await assert.rejects(pending, { code: 'session_usage_source_changed' })
  assert.equal(reads, 1)
})

test('cancel returns promptly but dispose joins a reader that ignores abort', async () => {
  const a = agent('agent-a', 'session-a')
  const gate = deferred()
  const started = deferred()
  let receivedSignal
  const reader = { projections(_request, signal) { receivedSignal = signal; started.resolve(); return gate.promise } }
  const h = harness({ reader, agents: [a] })
  const controller = createSessionUsageController({ ctx: h.ctx })
  const binding = controller.bindAgent(a.id)
  const pending = controller.readUsage({ binding })
  await started.promise
  assert.deepEqual(controller.cancel(), { status: 'cancelling' })
  await assert.rejects(pending, { code: 'session_usage_cancelled' })
  assert.equal(receivedSignal.aborted, true)
  let disposed = false
  const disposing = controller.dispose().then(() => { disposed = true })
  await Promise.resolve()
  assert.equal(disposed, false)
  gate.resolve(null)
  await disposing
  assert.equal(disposed, true)
  assert.throws(() => controller.bindAgent(a.id), { code: 'session_usage_closed' })
})

test('rejects malformed known projection values and invalid sequence cuts', async t => {
  const a = agent('agent-a', 'session-a')
  let value = { kind: 'sequenced', asOfSeq: 1, values: { tokenUsage: { ...usage, outputTokens: -1 } } }
  const controller = createSessionUsageController({ ctx: harness({ reader: { async projections() { return value } }, agents: [a] }).ctx })
  t.after(() => controller.dispose())
  const binding = controller.bindAgent(a.id)
  await assert.rejects(controller.readUsage({ binding }), { code: 'session_usage_projection_invalid' })
  value = { kind: 'sequenced', asOfSeq: 2, values: {
    sessionStats: { ...stats, turns: 0.5 }, tokenUsage: usage,
    contextPressure: {}, contextBreakdown: { systemTokens: 0, toolsTokens: 0, messageTokens: 0 },
  } }
  await assert.rejects(controller.readUsage({ binding }), { code: 'session_usage_projection_invalid' })
  value = { kind: 'sequenced', asOfSeq: -2, values: {} }
  await assert.rejects(controller.readUsage({ binding }), { code: 'session_usage_projection_invalid' })
})
