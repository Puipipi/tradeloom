import test from 'node:test'
import assert from 'node:assert/strict'
import { createWorkflowNativeExecutor } from './workflow-native-executor.js'

test('same child successive activations isolate old epoch end and old Session events', async () => {
  // Offline lifecycle facade; no Host, model, filesystem artifact or listener.
  const lifecycle = new Map(), observers = new Set(), acknowledgements = []
  const parent = { id: 'parent', session: { id: 'parent' }, ctx: { on(name, callback) {
    lifecycle.set(name, callback); return () => lifecycle.delete(name)
  } } }
  const oldSession = { id: 'child', seq: 4 }
  const newSession = { id: 'child', seq: 10 }
  let epoch = 0, child
  const binding = { authorized: true, requestId: 'request', agentId: parent.id, sessionId: parent.session.id,
    workflowRunId: 'workflow-run', nodeId: 'node', attempt: 1, bindingRevision: '1', definitionRevision: 'definition',
    prompt: 'bounded task', agentPreset: 'tradeloom-product' }
  const ctx = { agents: { get: id => id === parent.id ? parent : id === 'child' ? child : undefined },
    tools: { get: () => ({ parameters: { type: 'object', properties: { agent_preset: { type: 'string', enum: ['tradeloom-product'] } } } }),
      async execute() {
        epoch++
        const session = epoch === 1 ? oldSession : newSession
        child = { id: 'child', session, ctx: { on(name, callback) {
          assert.equal(name, 'session/event'); observers.add(callback); return () => observers.delete(callback)
        } } }
        const info = { id: 'child', runId: `epoch-${epoch}`, provider: 'spawn', local: true }
        lifecycle.get('subagent/start')(info)
        const present = (source, seq, path) => {
          for (const callback of observers) callback(source, { seq, type: 'deliverables/presented',
            data: { turn: 1, callId: `present-${epoch}`, files: [{ path }] } })
        }
        if (epoch === 2) {
          lifecycle.get('subagent/end')({ ...info, runId: 'epoch-1', stopReason: 'completed' })
          present(oldSession, 4, 'C:/old-epoch.txt')
        }
        present(session, session.seq, epoch === 1 ? 'C:/first.txt' : 'C:/second.txt')
        session.seq++
        lifecycle.get('subagent/end')({ ...info, stopReason: 'completed' })
        return { isError: false, value: { kind: 'activation', subagentId: 'child' }, content: [] }
      } }, subagents: { interrupt() {} } }
  const executor = createWorkflowNativeExecutor(ctx, { resolveBinding: async () => binding, timeoutMs: 500,
    createCallId: () => `spawn-${epoch + 1}`, recordChildAck: async (_binding, ack) => { acknowledgements.push(ack) } })
  const input = { requestId: binding.requestId, bindingRevision: binding.bindingRevision, definitionRevision: binding.definitionRevision,
    workflowRunId: binding.workflowRunId, nodeId: binding.nodeId, attempt: 1, prompt: binding.prompt }
  const first = await executor.run(input, { agent: parent, signal: new AbortController().signal })
  assert.equal(observers.size, 0); assert.equal(lifecycle.size, 0)
  binding.requestId = 'request-2'; binding.attempt = 2
  const second = await executor.run({ ...input, requestId: binding.requestId, attempt: 2 }, { agent: parent, signal: new AbortController().signal })
  assert.equal(first.status, 'completed'); assert.equal(second.status, 'completed')
  assert.equal(first.artifactEvidence.range.nativeRunId, 'epoch-1')
  assert.deepEqual(second.artifactEvidence.range, { childSessionId: 'child', nativeRunId: 'epoch-2', startInclusive: 10, endExclusive: 11 })
  assert.deepEqual(second.artifactEvidence.declarations.map(item => item.path), ['C:/second.txt'])
  assert.equal(acknowledgements[1].artifactRangeStart.nativeRunId, 'epoch-2')
  assert.equal(observers.size, 0); assert.equal(lifecycle.size, 0)
})
