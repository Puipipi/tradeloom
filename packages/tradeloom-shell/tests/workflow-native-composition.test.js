import test from 'node:test'
import assert from 'node:assert/strict'
import { createWorkflowRunJournal } from '../workflow-run-journal.js'
import { createWorkflowNativeBindingResolver } from '../workflow-native-binding.js'
import { createWorkflowNativeExecutor } from '../workflow-native-executor.js'
import { createConfirmedWorkflowDefinition } from '../workflow-definition.js'
import { ROLE_PRESETS } from '../roles.js'

// Real module composition; CAS storage, Host services and lifecycle are fixtures.
// This does not exercise PostgreSQL, Host registration, LLMs or live preset registration/policy.
const RUN = '11111111-1111-4111-8111-111111111111'
async function fixture({ failAck = false, fastEnd = true, hangAck = false, role = 'product', parameters = { type: 'object', properties: { agent_preset: { type: 'string', enum: Object.entries(ROLE_PRESETS).filter(([key]) => key !== 'center').map(([, value]) => value) } } } } = {}) {
  const rows = new Map()
  const order = []
  const store = {
    async get(id) { return structuredClone(rows.get(id) ?? null) },
    async list() { return [...rows.values()].map(({ id, status }) => ({ id, status })) },
    async save(snapshot, expectedRevision) {
      assert.equal(rows.get(snapshot.id)?.revision ?? 0, expectedRevision)
      if (failAck && snapshot.events.at(-1)?.type === 'child-ack') {
        throw Object.assign(new Error('fixture disk failure'), { code: 'DISK_UNAVAILABLE' })
      }
      rows.set(snapshot.id, structuredClone(snapshot))
      order.push(snapshot.events.at(-1)?.type)
      return structuredClone(snapshot)
    },
  }
  const journal = createWorkflowRunJournal({ store, createRunId: () => RUN })
  const listeners = new Map()
  const parent = { id: 'parent', session: { id: 'session' }, ctx: {
    on(name, callback) {
      const set = listeners.get(name) ?? new Set()
      set.add(callback); listeners.set(name, set)
      return () => set.delete(callback)
    },
  } }
  const emit = (name, info) => { for (const callback of listeners.get(name) ?? []) callback(info) }
  const start = { id: 'child', runId: 'native-run', provider: 'spawn', local: true }
  const end = { ...start, stopReason: 'completed', lastAssistantMessage: [{ type: 'text', text: 'done' }] }
  const state = { roles: { center: { sessionId: 'session', workspaceId: 'workspace', workspacePath: 'C:/fixture', agentPreset: ROLE_PRESETS.center } }, roleBindingRevisions: { center: '7' } }
  let dispatches = 0
  const interrupts = []
  const ctx = {
    agents: { get: id => id === parent.id ? parent : undefined },
    workspaceRegistry: { archivedSessionIds: [], get: id => id === 'workspace' ? { id, path: 'C:/fixture', sessionIds: ['session'] } : undefined },
    sessionQuery: { async observeSession(id) { return { header: { id, cwd: 'C:/fixture' }, projections: { values: { agentPreset: ROLE_PRESETS.center } }, [Symbol.dispose]() {} } } },
    tools: {
      get: (name, agent) => name === 'subagent' && agent === parent ? { parameters } : undefined,
      async execute(request) {
        dispatches++
        assert.equal(request.agent, parent)
        assert.deepEqual(request.arguments, { description: 'Run workflow task', prompt: 'Persisted prompt', agent_preset: ROLE_PRESETS[role] })
        assert.equal(rows.get(RUN).nodes.task.attemptState, 'started')
        emit('subagent/start', start)
        if (fastEnd) emit('subagent/end', end)
        return { isError: false, value: { kind: 'activation', subagentId: start.id }, content: [] }
      },
    },
    subagents: { interrupt(id, authority) {
      interrupts.push({ id, authority })
      emit('subagent/end', { ...end, stopReason: 'aborted' })
    } },
  }
  const definition = createConfirmedWorkflowDefinition({ version: 1, id: 'flow', title: 'Flow', confirmed: true, nodes: [{ id: 'task', kind: 'agent', agent: role, title: 'Task', instruction: 'Persisted prompt' }], edges: [] })
  const handle = await journal.create({
    ...definition,
    requestId: 'run-create-request', parentAgentId: parent.id, sessionId: 'session', bindingRevision: '7', definitionRevision: definition.definitionRevision,
  })
  const resolveBinding = createWorkflowNativeBindingResolver({ ctx, readState: async () => state,
    loadRun: async id => { const loaded = await journal.open(id); return loaded?.getSnapshot() },
  })
  let observation
  async function run(inputChanges = {}, execChanges = {}) {
    return handle.executeAttempt({ nodeId: 'task', attempt: 1, requestId: 'node-attempt-request', bindingRevision: '7', definitionRevision: definition.definitionRevision }, async attempt => {
      // This executor owns this immutable attempt closure; no global currentAttempt.
      const executor = createWorkflowNativeExecutor(ctx, { resolveBinding, timeoutMs: 100,
        createCallId: () => 'child-tool-call',
        recordChildAck: async (binding, ack) => {
          assert.equal(binding.requestId, attempt.requestId)
          assert.equal(binding.workflowRunId, attempt.workflowRunId)
          assert.equal(binding.nodeId, attempt.nodeId)
          assert.equal(binding.attempt, attempt.attempt)
          if (hangAck) return new Promise(() => {})
          await attempt.recordChildAck(ack)
          order.push('ack-hook-returned')
          if (!fastEnd) emit('subagent/end', end)
        },
      })
      observation = await executor.run({ requestId: attempt.requestId, workflowRunId: attempt.workflowRunId, nodeId: attempt.nodeId,
        attempt: attempt.attempt, bindingRevision: attempt.bindingRevision, definitionRevision: attempt.definitionRevision, prompt: 'Persisted prompt', ...inputChanges },
      { agent: parent, callId: 'trusted-parent-tool-call', signal: new AbortController().signal, ...execChanges })
      return observation
    })
  }
  return { run, parent, state, rows, order, interrupts, get dispatches() { return dispatches }, get observation() { return observation } }
}

for (const fastEnd of [true, false]) {
  test(`journal → snapshot resolver → executor → journal persists ack before terminal (fastEnd=${fastEnd})`, async () => {
    const f = await fixture({ fastEnd })
    const result = await f.run()
    assert.equal(result.observation.status, 'completed')
    const snapshot = f.rows.get(RUN)
    assert.equal(snapshot.status, 'done')
    assert.equal(snapshot.requestId, 'run-create-request')
    assert.equal(snapshot.nodes.task.requestId, 'node-attempt-request')
    assert.equal(snapshot.nodes.task.toolCallId, 'child-tool-call')
    assert.equal(snapshot.nodes.task.childId, 'child')
    assert.equal(snapshot.nodes.task.nativeRunId, 'native-run')
    assert.ok(f.order.indexOf('child-ack') < f.order.indexOf('ack-hook-returned'))
    assert.ok(f.order.indexOf('ack-hook-returned') < f.order.indexOf('node-terminal'))
    assert.equal(f.dispatches, 1)
  })
}

for (const [name, change, exec, code] of [
  ['wrong parent', {}, { agent: { id: 'parent', session: { id: 'session' } } }, 'NATIVE_PARENT_UNAVAILABLE'],
  ['stale binding', { bindingRevision: '6' }, {}, 'run_unavailable_or_stale'],
  ['wrong attempt', { attempt: 2 }, {}, 'run_node_not_active'],
]) {
  test(`${name} prevents dispatch through real module composition`, async () => {
    const f = await fixture()
    await assert.rejects(f.run(change, exec), { code })
    assert.equal(f.dispatches, 0)
  })
}

for (const fastEnd of [true, false]) {
  test(`ack store failure retains original category and owned child semantics (fastEnd=${fastEnd})`, async () => {
    const f = await fixture({ failAck: true, fastEnd })
    await assert.rejects(f.run(), { code: 'journal_unavailable_after_store_failure' })
    assert.equal(f.dispatches, 1)
    assert.equal(f.observation.status, 'unknown')
    assert.equal(f.observation.errorCategory, 'store_write_failed')
    assert.equal(f.observation.errorStage, 'child-ack-persistence')
    assert.equal(f.rows.get(RUN).nodes.task.attemptState, 'started')
    assert.equal(f.interrupts.length, fastEnd ? 0 : 1)
    if (!fastEnd) assert.deepEqual(f.interrupts[0], { id: 'child', authority: { kind: 'ancestor', agent: f.parent } })
  })
}

test('a hanging Host ack writer remains bounded and interrupts only its owned child', async () => {
  const f = await fixture({ hangAck: true, fastEnd: false })
  const result = await f.run()
  assert.equal(result.observation.status, 'unknown')
  assert.equal(result.observation.errorCategory, 'NATIVE_EXECUTION_TIMEOUT')
  assert.equal(result.snapshot.nodes.task.attemptState, 'unknown')
  assert.equal(f.dispatches, 1)
  assert.equal(f.interrupts.length, 1)
})

for (const role of ['market', 'quote', 'delivery', 'user-profile']) {
  test(`persisted ${role} role is explicitly dispatched through real composition`, async () => {
    const f = await fixture({ role })
    assert.equal((await f.run()).observation.status, 'completed')
    assert.equal(f.dispatches, 1)
  })
}

test('persisted center node is rejected without spawning', async () => {
  const f = await fixture({ role: 'center' })
  await assert.rejects(f.run(), { code: 'run_node_role_not_allowed' })
  assert.equal(f.dispatches, 0)
})

for (const [name, parameters] of [
  ['missing property', { type: 'object', properties: {} }],
  ['missing enum', { type: 'object', properties: { agent_preset: { type: 'string' } } }],
  ['disallowed enum', { type: 'object', properties: { agent_preset: { type: 'string', enum: ['tradeloom-market-placeholder'] } } }],
]) {
  test(`${name} rejects before spawn in real composition`, async () => {
    const f = await fixture({ parameters })
    await assert.rejects(f.run(), { code: 'NATIVE_PRESET_NOT_ALLOWED' })
    assert.equal(f.dispatches, 0)
  })
}
