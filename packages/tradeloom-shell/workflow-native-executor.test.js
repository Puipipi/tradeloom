import test from 'node:test'
import assert from 'node:assert/strict'
import { createWorkflowNativeExecutor } from './workflow-native-executor.js'

function deferred() {
  let resolve
  let reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

function harness(toolExecute, { timeoutMs = 80, interrupt } = {}) {
  const listeners = new Map()
  const parent = {
    id: 'agent-native-1',
    session: { id: 'session-native-1' },
  }
  parent.ctx = {
    on(name, callback, options) {
      const rows = listeners.get(name) ?? new Set()
      const row = { callback, scope: parent, options }
      rows.add(row)
      listeners.set(name, rows)
      return () => rows.delete(row)
    },
  }
  const emits = {
    start(info, carrier = parent) {
      for (const row of listeners.get('subagent/start') ?? []) {
        if (row.options?.global || row.scope === carrier) row.callback(info)
      }
    },
    end(info, carrier = parent) {
      for (const row of listeners.get('subagent/end') ?? []) {
        if (row.options?.global || row.scope === carrier) row.callback(info)
      }
    },
    count(name) { return listeners.get(name)?.size ?? 0 },
  }
  const calls = { tools: 0, interrupts: [], bindings: [], dispatchSignal: null, toolDefinition: { parameters: { type: 'object', properties: { agent_preset: { type: 'string', enum: ['tradeloom-product'] } } } } }
  const ctx = {
    agents: { get: id => id === parent.id ? parent : undefined },
    tools: {
      get: (name, scope) => name === 'subagent' && scope === parent ? calls.toolDefinition : undefined,
      execute: async request => {
        calls.tools++
        calls.dispatchSignal = request.signal
        assert.equal(request.name, 'subagent')
        assert.equal(request.agent, parent)
        assert.ok(request.signal instanceof AbortSignal)
        assert.deepEqual(Object.keys(request.arguments).sort(), calls.expectedArgumentKeys ?? ['agent_preset', 'description', 'prompt'])
        assert.equal(request.arguments.agent_preset, 'tradeloom-product')
        return toolExecute({ request, emits, parent, calls })
      },
    },
    subagents: {
      interrupt(id, authority) {
        calls.interrupts.push({ id, authority })
        return interrupt?.(id, authority)
      },
    },
  }
  const fixedBinding = {
    authorized: true,
    requestId: 'request-1',
    agentId: parent.id,
    sessionId: parent.session.id,
    workflowRunId: 'workflow-run-1',
    nodeId: 'node-1',
    attempt: 1,
    bindingRevision: 'binding-r1',
    definitionRevision: 'definition-r1',
    prompt: 'Do a bounded task',
    agentPreset: 'tradeloom-product',
  }
  const bindings = new Map([
    ['request-1', fixedBinding],
    ['request-2', { ...fixedBinding, requestId: 'request-2' }],
  ])
  const executor = createWorkflowNativeExecutor(ctx, {
    resolveBinding: async (request, exec) => {
      calls.bindings.push(request)
      assert.equal(exec.agent, parent)
      return [...bindings.values()].find(binding => binding.attempt === request.attempt) ?? bindings.get('request-1')
    },
    timeoutMs,
    createCallId: () => 'fixture-call-id',
  })
  const request = (overrides = {}) => ({
    requestId: 'request-1',
    bindingRevision: 'binding-r1',
    definitionRevision: 'definition-r1',
    workflowRunId: 'workflow-run-1',
    nodeId: 'node-1',
    attempt: 1,
    prompt: 'Do a bounded task',
    ...overrides,
  })
  const defaultExec = { agent: parent, signal: new AbortController().signal }
  return {
    executor,
    request,
    exec: defaultExec,
    execWith: signal => ({ agent: parent, signal }),
    emits,
    parent,
    calls,
    fixedBinding,
    bindings,
  }
}

const start = { runId: 'run-1', provider: 'spawn', id: 'child-1', local: true }
const end = { ...start, stopReason: 'completed', lastAssistantMessage: [{ type: 'text', text: 'finished' }] }
const ack = { isError: false, value: { kind: 'activation', subagentId: start.id }, content: [] }

test('trusted assembled prompt and official provider/model pair are dispatched without changing lifecycle', async () => {
  const h = harness(async ({ request, emits }) => {
    assert.equal(request.arguments.prompt, 'Do a bounded task\nPersisted upstream data')
    assert.equal(request.arguments.provider, 'reviewed-provider'); assert.equal(request.arguments.model, 'reviewed-model')
    emits.start(start); emits.end(end); return ack
  })
  h.fixedBinding.instruction = h.fixedBinding.prompt
  h.fixedBinding.prompt += '\nPersisted upstream data'
  h.fixedBinding.modelRequest = { provider: 'reviewed-provider', model: 'reviewed-model' }
  h.calls.toolDefinition.parameters.properties.provider = { type: 'string' }
  h.calls.toolDefinition.parameters.properties.model = { type: 'string' }
  h.calls.expectedArgumentKeys = ['agent_preset', 'description', 'model', 'prompt', 'provider']
  assert.equal((await h.executor.run(h.request(), h.exec)).status, 'completed')
})
test('model selection without the public provider/model schema is rejected before dispatch', async () => {
  const h = harness(() => assert.fail('must not dispatch unsupported model'))
  h.fixedBinding.modelRequest = { provider: 'reviewed-provider', model: 'reviewed-model' }
  await assert.rejects(h.executor.run(h.request(), h.exec), { code: 'unsupported_model_selection' })
  assert.equal(h.calls.tools, 0)
})
test('same attempt cannot be replayed with a different persisted model pair', async () => {
  const h = harness(async ({ emits }) => { emits.start(start); emits.end(end); return ack })
  h.fixedBinding.modelRequest = { provider: 'reviewed-provider', model: 'reviewed-model' }
  h.calls.toolDefinition.parameters.properties.provider = { type: 'string' }
  h.calls.toolDefinition.parameters.properties.model = { type: 'string' }
  h.calls.expectedArgumentKeys = ['agent_preset', 'description', 'model', 'prompt', 'provider']
  await h.executor.run(h.request(), h.exec)
  h.fixedBinding.modelRequest.model = 'different-model'
  await assert.rejects(h.executor.run(h.request(), h.exec), { code: 'IDEMPOTENCY_CONFLICT' })
  assert.equal(h.calls.tools, 1)
})

test('waits for a matching terminal event and returns its output with provenance', async () => {
  const h = harness(({ emits }) => {
    emits.start(start)
    setImmediate(() => emits.end(end))
    return ack
  })
  const result = await h.executor.run(h.request(), h.exec)
  assert.equal(result.status, 'completed')
  assert.equal(result.provider, 'spawn')
  assert.equal(result.model, 'unknown')
  assert.equal(result.artifactSource, 'unknown')
  assert.equal(result.requestId, 'request-1')
  assert.equal(result.workflowRunId, 'workflow-run-1')
  assert.equal(result.nodeId, 'node-1')
  assert.equal(result.attempt, 1)
  assert.equal(result.bindingRevision, 'binding-r1')
  assert.equal(result.definitionRevision, 'definition-r1')
  assert.equal(result.parentAgentId, 'agent-native-1')
  assert.equal(result.sessionId, 'session-native-1')
  assert.equal(result.toolCallId, 'fixture-call-id')
  assert.equal(result.childId, 'child-1')
  assert.equal(result.nativeRunId, 'run-1')
  assert.equal(result.terminalSource, 'subagent/end')
  assert.equal(Object.hasOwn(result, 'runId'), false)
  assert.deepEqual(result.output, end.lastAssistantMessage)
  assert.equal(h.emits.count('subagent/start'), 0)
  assert.equal(h.emits.count('subagent/end'), 0)
})

test('passes the owned combined signal from ToolRuntime execution context', async () => {
  const h = harness(({ request, emits }) => {
    emits.start(start)
    emits.end(end)
    return ack
  })
  await h.executor.run(h.request(), h.exec)
  assert.notEqual(h.calls.dispatchSignal, h.exec.signal)
  assert.equal(h.calls.dispatchSignal.aborted, false)
})

test('accepts end emitted before ToolRuntime acknowledgement', async () => {
  const h = harness(({ emits }) => {
    emits.start(start)
    emits.end(end)
    return ack
  })
  assert.equal((await h.executor.run(h.request(), h.exec)).status, 'completed')
})

test('ignores wrong parent, child, and run lifecycle events', async () => {
  const h = harness(({ emits }) => {
    const otherParent = { id: 'agent-native-2' }
    emits.start(start, otherParent)
    emits.end(end, otherParent)
    emits.start({ ...start, id: 'other-child' })
    emits.end({ ...end, id: 'other-child' })
    emits.start(start)
    emits.end({ ...end, runId: 'other-run' })
    setImmediate(() => emits.end(end))
    return ack
  })
  assert.equal((await h.executor.run(h.request(), h.exec)).nativeRunId, start.runId)
})

test('cancellation interrupts only the acknowledged child and waits for teardown', async () => {
  const controller = new AbortController()
  const h = harness(({ emits }) => {
    emits.start(start)
    setTimeout(() => controller.abort(), 5)
    setTimeout(() => emits.end({ ...end, stopReason: 'aborted' }), 20)
    return ack
  })
  const result = await h.executor.run(h.request(), h.execWith(controller.signal))
  assert.equal(result.status, 'interrupted')
  assert.equal(result.stopReason, 'aborted')
  assert.equal(h.calls.dispatchSignal.aborted, true)
  assert.deepEqual(h.calls.interrupts, [{ id: start.id, authority: { kind: 'ancestor', agent: h.parent } }])
})

test('cancellation before acknowledgement never interrupts an uncorrelated sibling', async () => {
  const controller = new AbortController()
  const h = harness(({ emits }) => {
    setImmediate(() => {
      emits.start({ ...start, id: 'sibling-child' })
      controller.abort()
      setTimeout(() => emits.end({ ...end, id: 'sibling-child' }), 5)
    })
    return new Promise(resolve => setTimeout(() => resolve({ isError: true, error: { code: 'ABORTED' } }), 10))
  })
  const result = await h.executor.run(h.request(), h.execWith(controller.signal))
  assert.equal(result.status, 'unknown')
  assert.equal(result.errorCategory, 'NATIVE_EXECUTION_ABORTED_BEFORE_ACK')
  await new Promise(resolve => setTimeout(resolve, 15))
  assert.deepEqual(h.calls.interrupts, [])
})

test('does not interrupt a child whose terminal event arrived before acknowledgement', async () => {
  const controller = new AbortController()
  const h = harness(({ emits }) => {
    emits.start(start)
    emits.end(end)
    controller.abort()
    return ack
  })
  const result = await h.executor.run(h.request(), h.execWith(controller.signal))
  assert.equal(result.status, 'unknown')
  assert.equal(result.errorCategory, 'NATIVE_EXECUTION_ABORTED_BEFORE_ACK')
  assert.deepEqual(h.calls.interrupts, [])
})

test('preserves ToolRuntime guard failure category and never fabricates a child', async () => {
  const h = harness(() => ({ isError: true, error: { message: 'denied', info: { code: 'TOOL_POLICY_DENIED' } }, content: [] }))
  const result = await h.executor.run(h.request(), h.exec)
  assert.equal(result.status, 'tool_error')
  assert.equal(result.errorCategory, 'TOOL_POLICY_DENIED')
  assert.equal(result.childId, null)
  assert.deepEqual(result.artifacts, [])
})

test('waits for matching terminal teardown within the overall attempt deadline', async () => {
  const controller = new AbortController()
  const h = harness(({ emits }) => {
    emits.start(start)
    setTimeout(() => emits.end(end), 25)
    return ack
  }, { timeoutMs: 60 })
  const result = await h.executor.run(h.request(), h.execWith(controller.signal))
  assert.equal(result.status, 'completed')
})

test('terminal timeout retains only proven child/native ids and marks terminal source unknown', async () => {
  const h = harness(({ emits }) => { emits.start(start); return ack }, { timeoutMs: 25 })
  const result = await h.executor.run(h.request(), h.exec)
  assert.equal(result.status, 'unknown')
  assert.equal(result.requestId, 'request-1')
  assert.equal(result.workflowRunId, 'workflow-run-1')
  assert.equal(result.attempt, 1)
  assert.equal(result.toolCallId, 'fixture-call-id')
  assert.equal(result.childId, start.id)
  assert.equal(result.nativeRunId, start.runId)
  assert.equal(result.terminalSource, 'unknown')
})

test('a dispatch that never settles returns at deadline and cannot spawn again for the same attempt', async () => {
  const never = new Promise(() => {})
  const h = harness(() => never, { timeoutMs: 30 })
  const began = Date.now()
  const first = await h.executor.run(h.request(), h.exec)
  const elapsed = Date.now() - began
  const replay = await h.executor.run(h.request(), h.exec)
  assert.ok(elapsed < 500, `deadline took ${elapsed}ms`)
  assert.equal(first.status, 'unknown')
  assert.equal(first.errorCategory, 'NATIVE_EXECUTION_TIMEOUT')
  assert.deepEqual(replay, first)
  assert.equal(h.calls.tools, 1)
  assert.equal(h.calls.dispatchSignal.aborted, true)
})

test('a late activation after deadline is interrupted and its scoped listener drains', async () => {
  const dispatch = deferred()
  const nextStart = { runId: 'run-2', provider: 'spawn', id: 'child-2', local: true }
  const nextEnd = { ...nextStart, stopReason: 'completed' }
  const nextAck = { isError: false, value: { kind: 'activation', subagentId: nextStart.id }, content: [] }
  const h = harness(({ emits, calls }) => {
    if (calls.tools === 1) return dispatch.promise
    emits.start(nextStart)
    emits.end(nextEnd)
    return nextAck
  }, { timeoutMs: 25 })
  const firstInput = h.request()
  const result = await h.executor.run(firstInput, h.exec)
  assert.equal(result.status, 'unknown')
  assert.equal(result.childId, null)
  assert.deepEqual(await h.executor.run(firstInput, h.exec), result)
  assert.equal(h.calls.tools, 1)
  h.bindings.set('request-2', { ...h.fixedBinding, requestId: 'request-2', attempt: 2 })
  const secondResult = await h.executor.run(h.request({ attempt: 2, requestId: 'request-2' }), h.exec)
  assert.equal(secondResult.status, 'completed')
  assert.equal(secondResult.childId, nextStart.id)
  assert.equal(h.calls.tools, 2)
  h.emits.start(start)
  dispatch.resolve(ack)
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(h.calls.interrupts, [{ id: start.id, authority: { kind: 'ancestor', agent: h.parent } }])
  h.emits.end({ ...end, stopReason: 'aborted' })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(h.emits.count('subagent/start'), 0)
  assert.equal(h.emits.count('subagent/end'), 0)
  assert.equal(h.calls.tools, 2)
})

test('asynchronous interrupt rejection is observed while lifecycle end remains authoritative', async () => {
  const controller = new AbortController()
  const h = harness(({ emits }) => {
    emits.start(start)
    setTimeout(() => controller.abort(), 5)
    setTimeout(() => emits.end({ ...end, stopReason: 'aborted' }), 20)
    return ack
  }, { interrupt: () => Promise.reject(new Error('late interrupt rejection')) })
  const result = await h.executor.run(h.request(), h.execWith(controller.signal))
  assert.equal(result.status, 'interrupted')
  assert.equal(result.stopReason, 'aborted')
})

test('deduplicates by exact parent plus workflow run/node/attempt', async () => {
  const h = harness(({ emits }) => { emits.start(start); emits.end(end); return ack })
  const first = await h.executor.run(h.request(), h.exec)
  const replay = await h.executor.run(h.request(), h.exec)
  assert.deepEqual(replay, first)
  assert.equal(h.calls.tools, 1)
  h.bindings.set('request-1', { ...h.fixedBinding, requestId: 'request-2' })
  await assert.rejects(
    h.executor.run(h.request({ requestId: 'request-2' }), h.exec),
    error => error.code === 'IDEMPOTENCY_CONFLICT',
  )
})

test('rejects stale or mismatched Host binding and exact parent identity', async () => {
  const h = harness(() => ack)
  await assert.rejects(
    h.executor.run(h.request({ bindingRevision: 'stale-binding' }), h.exec),
    error => error.code === 'NATIVE_BINDING_REVISION_MISMATCH',
  )
  h.fixedBinding.agentId = 'other-agent'
  await assert.rejects(h.executor.run(h.request(), h.exec), error => error.code === 'NATIVE_BINDING_PARENT_MISMATCH')
  h.fixedBinding.agentId = h.parent.id
  const impostor = { ...h.parent }
  await assert.rejects(h.executor.run(h.request(), { agent: impostor, signal: new AbortController().signal }), error => error.code === 'NATIVE_PARENT_UNAVAILABLE')
})

test('rejects a parent whose public Session.id no longer matches the trusted binding', async () => {
  const h = harness(() => ack)
  h.parent.session.id = 'other-session'
  await assert.rejects(h.executor.run(h.request(), h.exec), error => error.code === 'NATIVE_PARENT_UNAVAILABLE')
})

test('requires ToolRuntime exec.agent and exec.signal and rejects payload signal', async () => {
  const h = harness(() => ack)
  await assert.rejects(h.executor.run(h.request()), error => error.code === 'NATIVE_PARENT_UNAVAILABLE')
  await assert.rejects(h.executor.run(h.request(), { agent: h.parent }), error => error.code === 'NATIVE_SIGNAL_UNAVAILABLE')
  await assert.rejects(h.executor.run(h.request({ signal: new AbortController().signal }), h.exec), error => error.code === 'INVALID_NATIVE_REQUEST')
  assert.equal(h.calls.tools, 0)
})

test('requires the Host resolver record to confirm every persisted run/node input field', async () => {
  const h = harness(() => ack)
  const mismatchCases = [
    [{ workflowRunId: 'forged-run' }, { workflowRunId: 'workflow-run-1' }],
    [{ nodeId: 'forged-node' }, { nodeId: 'node-1' }],
    [{ attempt: 4 }, { attempt: 1 }],
    [{ prompt: 'forged prompt' }, { prompt: 'Do a bounded task' }],
  ]
  for (const [inputChanges, bindingChanges] of mismatchCases) {
    const record = { ...h.fixedBinding, ...bindingChanges }
    h.bindings.set('request-1', record)
    await assert.rejects(
      h.executor.run(h.request(inputChanges), h.exec),
      error => error.code === 'NATIVE_BINDING_MISMATCH',
    )
  }
  h.bindings.set('request-1', { ...h.fixedBinding, authorized: false })
  await assert.rejects(h.executor.run(h.request(), h.exec), error => error.code === 'NATIVE_BINDING_UNAVAILABLE')
  assert.equal(h.calls.tools, 0)
  assert.deepEqual(h.calls.bindings[0], {
    workflowRunId: 'forged-run',
    nodeId: 'node-1',
    attempt: 1,
    bindingRevision: 'binding-r1',
    definitionRevision: 'definition-r1',
  })
})

test('checks role/session binding revision independently of workflow definition revision', async () => {
  const h = harness(() => ack)
  h.bindings.set('request-1', {
    ...h.fixedBinding,
    bindingRevision: 'binding-r2',
    definitionRevision: 'definition-r1',
  })
  await assert.rejects(
    h.executor.run(h.request(), h.exec),
    error => error.code === 'NATIVE_BINDING_REVISION_MISMATCH',
  )
  assert.equal(h.calls.tools, 0)
})

test('checks workflow definition revision independently of role/session binding revision', async () => {
  const h = harness(() => ack)
  h.bindings.set('request-1', {
    ...h.fixedBinding,
    bindingRevision: 'binding-r1',
    definitionRevision: 'definition-r2',
  })
  await assert.rejects(
    h.executor.run(h.request(), h.exec),
    error => error.code === 'NATIVE_DEFINITION_REVISION_MISMATCH',
  )
  assert.equal(h.calls.tools, 0)
})

test('executor factory cannot run without an explicitly supplied Host resolver', () => {
  assert.throws(() => createWorkflowNativeExecutor({
    agents: { get() {} },
    tools: { get() {}, execute() {} },
  }), /trusted Host binding resolver is required/)
})

for (const [label, parameters] of [
  ['missing schema', undefined],
  ['non-object schema', { type: 'array', properties: { agent_preset: { type: 'string', enum: ['tradeloom-product'] } } }],
  ['missing preset schema', { type: 'object', properties: {} }],
  ['non-string preset', { type: 'object', properties: { agent_preset: { type: 'number', enum: ['tradeloom-product'] } } }],
  ['missing enum', { type: 'object', properties: { agent_preset: { type: 'string' } } }],
  ['not allowlisted', { type: 'object', properties: { agent_preset: { type: 'string', enum: ['other-preset'] } } }],
]) {
  test(`rejects ${label} before dispatch`, async () => {
    const h = harness(() => ack)
    h.calls.toolDefinition = { parameters }
    await assert.rejects(h.executor.run(h.request(), h.exec), { code: 'NATIVE_PRESET_NOT_ALLOWED' })
    assert.equal(h.calls.tools, 0)
  })
}

test('requires an authoritative resolved preset before dispatch', async () => {
  const h = harness(() => ack)
  delete h.fixedBinding.agentPreset
  await assert.rejects(h.executor.run(h.request(), h.exec), { code: 'NATIVE_BINDING_UNAVAILABLE' })
  assert.equal(h.calls.tools, 0)
})
