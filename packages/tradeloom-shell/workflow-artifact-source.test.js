import test from 'node:test'
import assert from 'node:assert/strict'
import { validateArtifactEvidence, validateArtifactRangeStart } from './workflow-artifact-source.js'
import { createWorkflowNativeExecutor } from './workflow-native-executor.js'

const start = { childSessionId: 'child', nativeRunId: 'run', startInclusive: 4 }
const evidence = () => ({ schema: 'tradeloom.presented-evidence/v1', range: { ...start, endExclusive: 9 }, declarations: [
  { sourceSessionSeq: 4, fileIndex: 0, presentCallId: 'present-call', sourceTurn: 1, path: 'C:/output.txt' },
] })
test('half-open seq bounds accept start and last event, never before start or end', () => {
  assert.ok(validateArtifactRangeStart(start))
  for (const seq of [4, 8]) { const value = evidence(); value.declarations[0].sourceSessionSeq = seq; assert.ok(validateArtifactEvidence(value, start)) }
  for (const seq of [3, 9]) { const value = evidence(); value.declarations[0].sourceSessionSeq = seq; assert.equal(validateArtifactEvidence(value, start), null) }
})
test('strict evidence rejects identity, unknown fields, duplicate coordinates and excessive data', () => {
  for (const change of [v => v.range.childSessionId = 'other', v => v.range.nativeRunId = 'other', v => v.extra = true,
    v => v.declarations.push({ ...v.declarations[0], path: 'C:/another.txt' }), v => v.declarations[0].path = 'x'.repeat(4097),
    v => v.declarations[0].sourceTurn = -1]) {
    const value = evidence(); change(value); assert.equal(validateArtifactEvidence(value, start), null)
  }
  assert.equal(validateArtifactEvidence(evidence(), undefined), null)
})
test('same path across distinct source coordinates is not a shared artifact identity or immutable-byte claim', () => {
  const value = evidence()
  value.declarations.push({ ...value.declarations[0], sourceSessionSeq: 5, presentCallId: 'second-present' })
  const validated = validateArtifactEvidence(value, start)
  assert.equal(validated.declarations.length, 2)
  value.declarations[0].path = 'C:/changed-after-observation.txt'
  assert.equal(validated.declarations[0].path, 'C:/output.txt')
  assert.equal(validated.declarations[0].version, undefined)
  assert.equal(validated.declarations[0].hash, undefined)
  assert.equal(validated.declarations[0].created, undefined)
})

async function captureRun({ unavailable = false, subscribeFailure = false, wrongSource = false, malformed = false, duplicate = false, before = false, overflow = false, ackFailure = false, startSeq = 4 } = {}) {
  const lifecycle = new Map(), sourceListeners = new Set()
  const parent = { id: 'parent', session: { id: 'parent-session' }, ctx: { on(name, fn) {
    lifecycle.set(name, fn); return () => lifecycle.delete(name)
  } } }
  const session = { id: 'child', seq: startSeq }
  const child = { id: 'child', session, ctx: { on(name, fn) { if (subscribeFailure) throw new Error('unavailable'); assert.equal(name, 'session/event'); sourceListeners.add(fn); return () => sourceListeners.delete(fn) } } }
  const ack = []
  const info = { id: 'child', runId: 'epoch-1', local: true, provider: 'spawn' }
  const binding = { authorized: true, requestId: 'request', agentId: parent.id, sessionId: parent.session.id,
    workflowRunId: 'workflow-run', nodeId: 'node', attempt: 1, bindingRevision: '1', definitionRevision: 'definition', prompt: 'task', agentPreset: 'tradeloom-product' }
  const ctx = { agents: { get: id => id === parent.id ? parent : id === child.id && !unavailable ? child : undefined },
    tools: { get: () => ({ parameters: { type: 'object', properties: { agent_preset: { type: 'string', enum: ['tradeloom-product'] } } } }),
      async execute() {
        lifecycle.get('subagent/start')(info)
        const deliver = (seq, source = session) => {
          session.seq = seq + 1
          const event = { seq, type: 'deliverables/presented', data: { turn: 1, callId: 'present', files: [{ path: 'C:/current.txt' }] } }
          if (malformed) event.data.files[0].path = null
          for (const fn of sourceListeners) fn(source, event)
        }
        if (before) deliver(startSeq - 1)
        else {
          deliver(startSeq, wrongSource ? { ...session } : session)
          if (duplicate) deliver(startSeq)
          if (overflow) for (let i = 1; i <= 64; i++) deliver(startSeq + i)
        }
        session.seq = startSeq + (overflow ? 70 : 5)
        lifecycle.get('subagent/end')({ ...info, stopReason: 'completed', lastAssistantMessage: [{ type: 'text', text: 'not an artifact path' }] })
        // Fast terminal before official tool acknowledgement.
        return { isError: false, value: { kind: 'activation', subagentId: info.id }, content: [] }
      } }, subagents: { interrupt() {} } }
  const executor = createWorkflowNativeExecutor(ctx, { resolveBinding: async () => binding, timeoutMs: 500,
    createCallId: () => 'spawn-call', recordChildAck: async (_binding, value) => { ack.push(value); if (ackFailure) throw new Error('ack unavailable') } })
  const result = await executor.run({ requestId: binding.requestId, bindingRevision: binding.bindingRevision, definitionRevision: binding.definitionRevision,
    workflowRunId: binding.workflowRunId, nodeId: binding.nodeId, attempt: 1, prompt: binding.prompt }, { agent: parent, signal: new AbortController().signal })
  assert.equal(sourceListeners.size, 0)
  return { result, ack }
}

test('executor captures fast present/end before ack and exact half-open range, including empty history', async () => {
  for (const startSeq of [0, 4]) {
    const { result, ack } = await captureRun({ startSeq })
    assert.equal(result.status, 'completed')
    assert.deepEqual(ack[0].artifactRangeStart, { childSessionId: 'child', nativeRunId: 'epoch-1', startInclusive: startSeq })
    assert.equal(result.artifactEvidence.range.endExclusive, startSeq + 5)
    assert.equal(result.artifactEvidence.declarations[0].sourceSessionSeq, startSeq)
    assert.equal(result.artifactEvidence.declarations[0].path, 'C:/current.txt')
  }
})
test('capture absent or invalid never changes successful execution into terminal failure', async () => {
  for (const options of [{ unavailable: true }, { subscribeFailure: true }, { malformed: true }, { duplicate: true }, { before: true }, { overflow: true }]) {
    const { result } = await captureRun(options)
    assert.equal(result.status, 'completed')
    assert.equal(result.artifactEvidence, undefined)
  }
  const { result } = await captureRun({ wrongSource: true })
  assert.deepEqual(result.artifactEvidence.declarations, [])
})
test('ack failure does not publish buffered source evidence', async () => {
  const { result } = await captureRun({ ackFailure: true })
  assert.equal(result.status, 'unknown')
  assert.equal(result.artifactEvidence, undefined)
})
