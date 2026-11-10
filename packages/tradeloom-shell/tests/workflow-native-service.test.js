import test from 'node:test'
import assert from 'node:assert/strict'
import { createWorkflowNativeService } from '../workflow-native-service.js'
import { ROLE_PRESETS } from '../roles.js'

// Faithful Host/CAS fixtures, not real Host registration, PostgreSQL or LLM execution.
const clone = value => structuredClone(value)
function scope() {
  const disposers = new Set()
  return {
    effect(setup) {
      const cleanup = setup()
      let active = true
      const release = () => { if (!active) return; active = false; disposers.delete(release); cleanup() }
      disposers.add(release)
      return release
    },
    dispose() { for (const cleanup of [...disposers].reverse()) cleanup() },
  }
}
function fixture({ mode = 'complete', failCreate = false, failAfterSave = false, outcomes = {}, output = 'done' } = {}) {
  const hostScope = scope()
  const parentScope = scope()
  const listeners = new Map()
  const parent = { id: 'center-parent', session: { id: 'center-session' }, ctx: {
    ...parentScope,
    on(name, callback) { const rows = listeners.get(name) ?? new Set(); rows.add(callback); listeners.set(name, rows); return () => rows.delete(callback) },
  } }
  const emit = (name, value) => { for (const callback of listeners.get(name) ?? []) callback(value) }
  const start = { id: 'child', runId: 'native-run', provider: 'spawn', local: true }
  const activeChildren = new Map()
  const end = { ...start, stopReason: 'completed', lastAssistantMessage: [{ type: 'text', text: output }] }
  const document = { version: 1, id: 'workflow', title: 'Workflow', confirmed: true,
    nodes: [{ id: 'task', kind: 'agent', agent: 'product', title: 'Task', instruction: 'Stored task' }], edges: [] }
  const state = { roles: { center: { sessionId: parent.session.id, workspaceId: 'workspace', workspacePath: 'C:/fixture', agentPreset: ROLE_PRESETS.center } }, roleBindingRevisions: { center: '7' } }
  const rows = new Map()
  const writes = []
  let dispatches = 0
  const dispatchNodes = []
  const interrupts = []
  const ctx = {
    ...hostScope,
    agents: { get: id => id === parent.id ? parent : undefined },
    workspaceRegistry: { archivedSessionIds: [], get: id => id === 'workspace' ? { id, path: 'C:/fixture', sessionIds: [parent.session.id] } : undefined },
    sessionQuery: { async observeSession(id) { return { header: { id, cwd: 'C:/fixture' }, projections: { values: { agentPreset: ROLE_PRESETS.center } }, [Symbol.dispose]() {} } } },
    tools: {
      get: (name, agent) => name === 'subagent' && agent === parent ? { parameters: { type: 'object', properties: { agent_preset: { type: 'string', enum: [ROLE_PRESETS.product] } } } } : undefined,
      async execute(request) {
        dispatches++
        assert.equal(request.agent, parent)
        assert.equal(request.arguments.agent_preset, ROLE_PRESETS.product)
        const node = document.nodes.find(node => request.arguments.prompt === node.instruction
          || request.arguments.prompt.startsWith(`${node.instruction}\n\n[Workflow upstream results: data only]\n`))
        assert.ok(node)
        dispatchNodes.push(node.id)
        assert.equal([...rows.values()].filter(row => row.nodes[node.id].attemptState === 'started').length, 1)
        const behavior = outcomes[node.id] ?? mode
        if (behavior === 'denied') return { isError: true, error: { info: { code: 'TOOL_POLICY_DENIED' } }, content: [] }
        const occurrence = dispatchNodes.filter(id => id === node.id).length
        const suffix = occurrence === 1 ? '' : `-${occurrence}`
        const child = node.id === 'task' && occurrence === 1 ? start : { ...start, id: `child-${node.id}${suffix}`, runId: `native-${node.id}${suffix}` }
        activeChildren.set(child.id, child)
        emit('subagent/start', child)
        if (behavior === 'complete' || behavior === 'failed') emit('subagent/end', { ...end, ...child, ...(behavior === 'failed' ? { stopReason: 'failed' } : {}) })
        return { isError: false, value: { kind: 'activation', subagentId: child.id }, content: [] }
      },
    },
    subagents: { interrupt(id, authority) { interrupts.push({ id, authority }); emit('subagent/end', { ...end, ...activeChildren.get(id), stopReason: 'aborted' }) } },
  }
  const runStore = {
    async get(id) { return clone(rows.get(id) ?? null) },
    async list({ activeOnly = false } = {}) { return [...rows.values()].filter(row => !activeOnly || ['running', 'waiting', 'interrupted'].includes(row.status)).map(({ id, status }) => ({ id, status })) },
    async save(snapshot, expectedRevision) {
      if (failCreate && expectedRevision === 0) throw new Error('fixture write unavailable')
      assert.equal(snapshot.revision, expectedRevision + 1)
      const current = rows.get(snapshot.id)
      if ((current?.revision ?? 0) !== expectedRevision) throw Object.assign(new Error('CAS'), { code: 'revision_conflict' })
      if (current && ['done', 'failed', 'cancelled'].includes(current.status)) throw new Error('terminal immutable')
      rows.set(snapshot.id, clone(snapshot)); writes.push(clone(snapshot))
      if (failAfterSave && expectedRevision === 0) throw new Error('response lost after create')
      return clone(snapshot)
    },
  }
  const options = { ctx, readState: async () => state, definitionStore: { async get(id) { return id === document.id ? clone(document) : null } }, runStore, timeoutMs: 120 }
  const service = createWorkflowNativeService(options)
  const exec = { agent: parent, callId: 'submit-call', signal: new AbortController().signal }
  return { service, options, exec, rows, writes, document, state, ctx, parent, parentScope, hostScope, interrupts, dispatchNodes,
    get dispatches() { return dispatches }, end: () => emit('subagent/end', end) }
}
async function started(f) {
  for (let i = 0; i < 30; i++) {
    if (f.dispatches && [...f.rows.values()][0].nodes.task.attemptState === 'acknowledged') return
    await new Promise(resolve => setImmediate(resolve))
  }
  assert.fail('child did not reach persisted acknowledgement')
}

function dag(f, { independent = true } = {}) {
  f.document.nodes = ['a', 'b', 'c', ...(independent ? ['d'] : [])].map(id => ({ id, kind: 'agent', agent: 'product', title: id, instruction: `Stored ${id}` }))
  f.document.edges = [{ from: 'a', to: 'b' }, { from: 'b', to: 'c' }]
}
async function nodeStarted(f, id) {
  for (let i = 0; i < 50; i++) {
    if ([...f.rows.values()][0]?.nodes[id]?.attemptState === 'acknowledged') return
    await new Promise(resolve => setImmediate(resolve))
  }
  assert.fail('fixture node did not acknowledge')
}
const resumeInput = plan => ({ runId: plan.runId, expectedRunRevision: plan.expectedRunRevision,
  expectedDefinitionRevision: plan.definitionRevision, expectedBindingRevision: plan.bindingRevision,
  resumePlanHash: plan.resumePlanHash, confirm: true })
test('cancel persists before interrupt; manual resume skips done nodes and same operation never dispatches twice', async () => {
  const outcomes = { b: 'manual' }; const f = fixture({ outcomes }); dag(f, { independent: false })
  const submitted = await f.service.submit({ workflowId: 'workflow' }, f.exec)
  await nodeStarted(f, 'b')
  const interrupt = f.ctx.subagents.interrupt
  f.ctx.subagents.interrupt = (id, authority) => {
    assert.equal(f.rows.get(submitted.runId).cancelRequested, true)
    return interrupt(id, authority)
  }
  await f.service.cancel({ runId: submitted.runId }, { ...f.exec, callId: 'cancel-one' })
  await f.service.drain()
  const plan = await f.service.prepare_resume({ runId: submitted.runId }, f.exec)
  assert.equal(plan.eligible, true); assert.deepEqual(plan.completedNodeIds, ['a'])
  outcomes.b = 'complete'
  const input = resumeInput(plan), exec = { ...f.exec, callId: 'resume-one' }
  const accepted = await f.service.resume(input, exec)
  assert.equal(accepted.reused, false)
  await f.service.drain()
  assert.deepEqual(f.dispatchNodes, ['a', 'b', 'b', 'c'])
  assert.equal(f.rows.get(submitted.runId).nodes.b.attempt, 2)
  assert.equal(f.rows.get(submitted.runId).status, 'done')
  assert.equal((await f.service.resume(input, exec)).reused, true)
  assert.deepEqual(f.dispatchNodes, ['a', 'b', 'b', 'c'])
  await assert.rejects(f.service.resume({ ...input, expectedRunRevision: input.expectedRunRevision + 1 }, exec), { code: 'operation_conflict' })
})
test('unknown side effects or ack without durable end blocks resume and never creates a child', async () => {
  const f = fixture({ outcomes: { a: 'denied' } }); dag(f)
  const submitted = await f.service.submit({ workflowId: 'workflow' }, f.exec); await f.service.drain()
  const plan = await f.service.prepare_resume({ runId: submitted.runId }, f.exec)
  assert.equal(plan.eligible, false)
  await assert.rejects(f.service.resume(resumeInput(plan), { ...f.exec, callId: 'unsafe-resume' }), { code: 'resume_blocked' })
  assert.deepEqual(f.dispatchNodes, ['a'])
})
async function cancelledUnstarted() {
  const f = fixture()
  const submitted = await f.service.submit({ workflowId: 'workflow' }, f.exec)
  await f.service.cancel({ runId: submitted.runId }, { ...f.exec, callId: 'cancel-unstarted' }); await f.service.drain()
  return { f, plan: await f.service.prepare_resume({ runId: submitted.runId }, f.exec) }
}
test('resume claim response loss is persisted but never auto-scheduled or resent', async () => {
  const { f, plan } = await cancelledUnstarted()
  const save = f.options.runStore.save
  f.options.runStore.save = async (row, revision) => {
    const result = await save(row, revision)
    if (row.events.at(-1)?.type === 'resume-claimed') throw new Error('fixture response lost after committed claim')
    return result
  }
  const input = resumeInput(plan), exec = { ...f.exec, callId: 'resume-lost-response' }
  assert.equal((await f.service.resume(input, exec)).reused, true)
  assert.equal(f.dispatches, 0)
  await f.service.recover()
  assert.equal((await f.service.resume(input, exec)).reused, true)
  assert.equal(f.dispatches, 0)
})
test('failure before resume claim commit leaves no operation and zero dispatch', async () => {
  const { f, plan } = await cancelledUnstarted()
  const save = f.options.runStore.save
  f.options.runStore.save = async (row, revision) => {
    if (row.events.at(-1)?.type === 'resume-claimed') throw new Error('fixture write failed before claim')
    return save(row, revision)
  }
  await assert.rejects(f.service.resume(resumeInput(plan), { ...f.exec, callId: 'resume-never-committed' }), { code: 'store_write_failed' })
  assert.equal(f.dispatches, 0)
  assert.equal(f.rows.get(plan.runId).events.some(event => event.type === 'resume-claimed'), false)
})
test('same resume operation across two services CAS claims once and dispatches once', async () => {
  const { f, plan } = await cancelledUnstarted(); const other = createWorkflowNativeService(f.options)
  const exec = { ...f.exec, callId: 'same-resume-cas' }, input = resumeInput(plan)
  const values = await Promise.all([f.service.resume(input, exec), other.resume(input, exec)])
  await Promise.all([f.service.drain(), other.drain()])
  assert.equal(values.filter(value => value.reused === false).length, 1)
  assert.equal(f.dispatches, 1)
  assert.equal(f.rows.get(plan.runId).events.filter(event => event.type === 'resume-claimed').length, 1)
})
test('different concurrent resume operations have one CAS winner and no duplicate child', async () => {
  const { f, plan } = await cancelledUnstarted(); const other = createWorkflowNativeService(f.options)
  const results = await Promise.allSettled([
    f.service.resume(resumeInput(plan), { ...f.exec, callId: 'resume-cas-one' }),
    other.resume(resumeInput(plan), { ...f.exec, callId: 'resume-cas-two' }),
  ])
  await Promise.all([f.service.drain(), other.drain()])
  assert.equal(results.filter(value => value.status === 'fulfilled').length, 1)
  assert.equal(f.dispatches, 1)
})
test('resume plan hash is stable for the same snapshot with object keys returned in another order', async () => {
  const { f, plan } = await cancelledUnstarted()
  const get = f.options.runStore.get
  f.options.runStore.get = async id => {
    const row = await get(id)
    row.nodes = Object.fromEntries(Object.entries(row.nodes).reverse().map(([id, node]) => [id, Object.fromEntries(Object.entries(node).reverse())]))
    return row
  }
  await f.service.resume(resumeInput(plan), { ...f.exec, callId: 'ordered-resume' }); await f.service.drain()
  assert.equal(f.dispatches, 1)
})
test('permission revoked while resume claim is committed prevents the child side effect', async () => {
  const { f, plan } = await cancelledUnstarted(); const save = f.options.runStore.save
  f.options.runStore.save = async (row, revision) => {
    const result = await save(row, revision)
    if (row.events.at(-1)?.type === 'resume-claimed') f.state.roleBindingRevisions.center = '8'
    return result
  }
  await f.service.resume(resumeInput(plan), { ...f.exec, callId: 'revoked-during-claim' }); await f.service.drain()
  assert.equal(f.dispatches, 0)
})
test('binding changed during final definition await is rejected before the resume claim', async () => {
  const { f, plan } = await cancelledUnstarted(); const get = f.options.definitionStore.get
  let reads = 0
  f.options.definitionStore.get = async id => {
    const value = await get(id)
    if (++reads === 2) f.state.roleBindingRevisions.center = '8'
    return value
  }
  await assert.rejects(f.service.resume(resumeInput(plan), { ...f.exec, callId: 'changed-before-claim' }), { code: 'binding_revision_mismatch' })
  assert.equal(f.rows.get(plan.runId).events.some(event => event.type === 'resume-claimed'), false)
  assert.equal(f.dispatches, 0)
})
test('prepare_resume rechecks ownership of the run refreshed during inspection', async () => {
  const { f, plan } = await cancelledUnstarted(); const get = f.options.runStore.get
  let reads = 0
  f.options.runStore.get = async id => {
    if (++reads === 2) {
      const row = f.rows.get(id); row.revision++; row.parentAgentId = 'another-owned-parent'
    }
    return get(id)
  }
  await assert.rejects(f.service.prepare_resume({ runId: plan.runId }, f.exec), { code: 'run_parent_mismatch' })
  assert.equal(f.dispatches, 0)
})
test('permission or definition changes after prepared resume cannot claim or dispatch', async () => {
  for (const kind of ['binding', 'definition', 'agent']) {
    const { f, plan } = await cancelledUnstarted()
    if (kind === 'binding') f.state.roleBindingRevisions.center = '8'
    if (kind === 'definition') f.document.title = 'New definition'
    if (kind === 'agent') f.ctx.agents.get = () => ({ ...f.parent })
    await assert.rejects(f.service.resume(resumeInput(plan), { ...f.exec, callId: 'stale-resume' }))
    assert.equal(f.dispatches, 0)
    assert.equal(f.rows.get(plan.runId).events.some(event => event.type === 'resume-claimed'), false)
  }
})
test('cancel persistence failure never interrupts its child or invents an intent receipt', async () => {
  const f = fixture({ mode: 'manual' })
  const submitted = await f.service.submit({ workflowId: 'workflow' }, f.exec); await started(f)
  const save = f.options.runStore.save
  f.options.runStore.save = async (row, revision) => {
    if (row.events.at(-1)?.type === 'cancel-requested') throw new Error('fixture cancel commit failure')
    return save(row, revision)
  }
  await assert.rejects(f.service.cancel({ runId: submitted.runId }, { ...f.exec, callId: 'failed-cancel' }), { code: 'store_write_failed' })
  assert.equal(f.interrupts.length, 0)
  assert.notEqual(f.rows.get(submitted.runId).cancelRequested, true)
  f.end(); await f.service.drain()
})
test('cancel response loss can replay the committed intent to interrupt once without a second write', async () => {
  const f = fixture({ mode: 'manual' }); const submitted = await f.service.submit({ workflowId: 'workflow' }, f.exec); await started(f)
  const save = f.options.runStore.save; let lost = false
  f.options.runStore.save = async (row, revision) => {
    const value = await save(row, revision)
    if (!lost && row.events.at(-1)?.type === 'cancel-requested') { lost = true; throw new Error('fixture lost cancel response') }
    return value
  }
  const exec = { ...f.exec, callId: 'replayed-cancel' }
  await assert.rejects(f.service.cancel({ runId: submitted.runId }, exec), { code: 'store_write_failed' })
  assert.equal(f.rows.get(submitted.runId).cancelRequested, true); assert.equal(f.interrupts.length, 0)
  const replay = await f.service.cancel({ runId: submitted.runId }, exec)
  assert.equal(replay.aborted, true)
  await f.service.drain()
  assert.equal(f.interrupts.length, 1)
  assert.equal(f.rows.get(submitted.runId).events.filter(event => event.type === 'cancel-requested').length, 1)
})
test('replaying an old cancel after explicit resume never aborts the new activation', async () => {
  const f = fixture({ mode: 'manual' }); const submitted = await f.service.submit({ workflowId: 'workflow' }, f.exec); await started(f)
  const oldCancel = { ...f.exec, callId: 'old-cancel-generation' }
  await f.service.cancel({ runId: submitted.runId }, oldCancel); await f.service.drain()
  const plan = await f.service.prepare_resume({ runId: submitted.runId }, f.exec)
  await f.service.resume(resumeInput(plan), { ...f.exec, callId: 'new-resume-generation' }); await started(f)
  const oldReplay = await f.service.cancel({ runId: submitted.runId }, oldCancel)
  assert.equal(oldReplay.aborted, false); assert.equal(f.interrupts.length, 1)
  await f.service.cancel({ runId: submitted.runId }, { ...f.exec, callId: 'fresh-cancel-generation' }); await f.service.drain()
  assert.deepEqual(f.interrupts.map(item => item.id), ['child', 'child-task-2'])
})
test('agent DAG dispatch is serial and persists each predecessor terminal before downstream starts', async () => {
  const f = fixture(); dag(f, { independent: false })
  const queued = await f.service.submit({ workflowId: 'workflow' }, f.exec)
  await f.service.drain()
  assert.deepEqual(f.dispatchNodes, ['a', 'b', 'c'])
  const stored = f.rows.get(queued.runId)
  assert.equal(stored.status, 'done')
  for (const [before, after] of [['a', 'b'], ['b', 'c']]) {
    assert.ok(f.writes.findIndex(row => row.nodes[before].status === 'done') < f.writes.findIndex(row => row.nodes[after].status === 'running'))
  }
})
test('failed ancestor persists skipped descendants and continues an independent branch to failed run', async () => {
  const f = fixture({ outcomes: { a: 'failed' } }); dag(f)
  const queued = await f.service.submit({ workflowId: 'workflow' }, f.exec)
  await f.service.drain()
  const saved = f.rows.get(queued.runId)
  assert.deepEqual(f.dispatchNodes, ['a', 'd'])
  assert.equal(saved.nodes.b.status, 'skipped'); assert.equal(saved.nodes.c.status, 'skipped')
  assert.deepEqual(saved.nodes.b.blockedBy, ['a']); assert.deepEqual(saved.nodes.c.blockedBy, ['b'])
  assert.equal(saved.status, 'failed')
})
test('unknown node pauses independent and dependent branches without fabricating skips', async () => {
  const f = fixture({ outcomes: { a: 'denied' } }); dag(f)
  const queued = await f.service.submit({ workflowId: 'workflow' }, f.exec)
  await f.service.drain()
  const saved = f.rows.get(queued.runId)
  assert.deepEqual(f.dispatchNodes, ['a'])
  assert.equal(saved.status, 'interrupted')
  assert.equal(saved.nodes.d.status, 'pending'); assert.equal(saved.nodes.b.status, 'pending')
})
test('DAG rechecks definition and binding between nodes and never dispatches after changed authority', async () => {
  for (const change of ['definition', 'binding']) {
    const f = fixture(); dag(f, { independent: false })
    const save = f.options.runStore.save
    f.options.runStore.save = async (row, expected) => {
      const result = await save(row, expected)
      if (row.nodes.a.status === 'done') {
        if (change === 'definition') f.document.nodes[1].instruction = 'Changed prompt'
        else f.state.roleBindingRevisions.center = '8'
      }
      return result
    }
    await f.service.submit({ workflowId: 'workflow' }, f.exec); await f.service.drain()
    assert.deepEqual(f.dispatchNodes, ['a'])
  }
})
test('concurrent same-operation services CAS creates one DAG and dispatches each node once', async () => {
  const f = fixture(); dag(f, { independent: false })
  const other = createWorkflowNativeService(f.options)
  const submitted = await Promise.all([f.service.submit({ workflowId: 'workflow' }, f.exec), other.submit({ workflowId: 'workflow' }, f.exec)])
  await Promise.all([f.service.drain(), other.drain()])
  assert.equal(submitted[0].runId, submitted[1].runId)
  assert.deepEqual(f.dispatchNodes, ['a', 'b', 'c'])
})
test('DAG join cannot start before both predecessors are durably terminal', async () => {
  const f = fixture(); dag(f, { independent: false })
  f.document.edges = [{ from: 'a', to: 'c' }, { from: 'b', to: 'c' }]
  const save = f.options.runStore.save
  f.options.runStore.save = async (row, expected) => {
    if (row.nodes.c.status === 'running') {
      assert.equal(f.rows.get(row.id).nodes.a.status, 'done')
      assert.equal(f.rows.get(row.id).nodes.b.status, 'done')
    }
    return save(row, expected)
  }
  await f.service.submit({ workflowId: 'workflow' }, f.exec); await f.service.drain()
  assert.deepEqual(f.dispatchNodes, ['a', 'b', 'c'])
})
test('DAG second-node CAS failure dispatches no second child', async () => {
  const f = fixture(); dag(f, { independent: false })
  const save = f.options.runStore.save
  f.options.runStore.save = async (row, expected) => {
    if (row.nodes.b.attemptState === 'started') throw Object.assign(new Error('fixture CAS failure'), { code: 'revision_conflict' })
    return save(row, expected)
  }
  const queued = await f.service.submit({ workflowId: 'workflow' }, f.exec)
  const drained = await f.service.drain()
  assert.deepEqual(f.dispatchNodes, ['a'])
  assert.equal(f.rows.get(queued.runId).nodes.b.status, 'pending')
  assert.equal(drained[0].error, 'store_write_failed')
})
test('DAG ack persistence failure interrupts only its exact child and pauses all branches', async () => {
  const f = fixture({ outcomes: { a: 'manual' } }); dag(f)
  const save = f.options.runStore.save
  f.options.runStore.save = async (row, expected) => {
    if (row.events.at(-1)?.type === 'child-ack') throw new Error('fixture ack disk failure')
    return save(row, expected)
  }
  await f.service.submit({ workflowId: 'workflow' }, f.exec); await f.service.drain()
  assert.deepEqual(f.dispatchNodes, ['a'])
  assert.deepEqual(f.interrupts, [{ id: 'child-a', authority: { kind: 'ancestor', agent: f.parent } }])
})
test('prepare checks every DAG preset before any persistence or dispatch', async () => {
  const f = fixture(); dag(f)
  f.document.nodes[1].agent = 'delivery'
  await assert.rejects(f.service.prepare({ workflowId: 'workflow' }, f.exec), { code: 'NATIVE_PRESET_NOT_ALLOWED' })
  await assert.rejects(f.service.submit({ workflowId: 'workflow' }, f.exec), { code: 'NATIVE_PRESET_NOT_ALLOWED' })
  assert.equal(f.rows.size, 0); assert.equal(f.dispatches, 0)
})
test('explicit model is eligible only when actual public subagent schema accepts both fields', async () => {
  const f = fixture()
  f.document.nodes[0].model = { provider: 'reviewed-provider', model: 'reviewed-model' }
  await assert.rejects(f.service.prepare({ workflowId: 'workflow' }, f.exec), { code: 'unsupported_model_selection' })
  f.ctx.tools.get = () => ({ parameters: { type: 'object', properties: {
    agent_preset: { type: 'string', enum: [ROLE_PRESETS.product] }, provider: { type: 'string' }, model: { type: 'string' },
  } } })
  const prepared = await f.service.prepare({ workflowId: 'workflow' }, f.exec)
  assert.equal(prepared.eligible, true)
  assert.equal(f.dispatches, 0)
})
test('prepare rejects definition changed during asynchronous center observation', async () => {
  const f = fixture(); const observe = f.ctx.sessionQuery.observeSession
  let observations = 0
  f.ctx.sessionQuery.observeSession = async id => {
    const value = await observe(id)
    if (++observations === 2) f.document.title = 'Changed during prepare await'
    return value
  }
  await assert.rejects(f.service.prepare({ workflowId: 'workflow' }, f.exec), { code: 'definition_revision_mismatch' })
  assert.equal(f.dispatches, 0)
})
test('complete oversized upstream output rejects the downstream attempt with zero child dispatch', async () => {
  const f = fixture({ output: 'x'.repeat(65536) }); dag(f, { independent: false })
  const queued = await f.service.submit({ workflowId: 'workflow' }, f.exec); await f.service.drain()
  assert.deepEqual(f.dispatchNodes, ['a'])
  const run = f.rows.get(queued.runId)
  assert.equal(run.nodes.b.error, 'native_prompt_too_large')
  assert.equal(run.nodes.b.childId, null); assert.equal(run.nodes.c.status, 'pending')
})

test('submit returns queued before dispatch, owns background signal and persists real module terminal', async () => {
  const f = fixture({ mode: 'manual' })
  const caller = new AbortController()
  const queued = await f.service.submit({ workflowId: 'workflow' }, { ...f.exec, signal: caller.signal })
  assert.equal(queued.queued, true)
  assert.equal(f.dispatches, 0)
  caller.abort() // ordinary tool-turn completion/cancellation does not own the run
  await started(f)
  assert.equal(f.interrupts.length, 0)
  f.end()
  await f.service.drain()
  const snapshot = await f.service.get({ runId: queued.runId }, f.exec)
  assert.equal(snapshot.status, 'done')
  assert.notEqual(snapshot.requestId, snapshot.nodes.task.requestId)
  assert.equal(snapshot.nodes.task.childId, 'child')
  assert.equal((await f.service.list({}, f.exec)).length, 1)
  assert.equal((await f.service.list({ workflowId: 'workflow', activeOnly: false }, f.exec)).length, 1)
  assert.deepEqual(await f.service.list({ workflowId: 'other-flow' }, f.exec), [])
  await assert.rejects(f.service.list({ workflowId: '../forged' }, f.exec), { code: 'invalid_input' })
})

test('create write failure prevents every dispatch', async () => {
  const f = fixture({ failCreate: true })
  await assert.rejects(f.service.submit({ workflowId: 'workflow' }, f.exec), { code: 'run_create_persistence_failed' })
  assert.equal(f.dispatches, 0)
  assert.equal(f.rows.size, 0)
})

for (const [name, change, code] of [
  ['non-agent', d => { d.nodes[0] = { id: 'review', kind: 'review', title: 'Review' } }, 'unsupported_workflow_graph'],
  ['explicit-model', d => { d.nodes[0].model = { provider: 'fixture', model: 'fixture' } }, 'unsupported_model_selection'],
  ['edges', d => { d.edges = [{ from: 'task', to: 'task' }] }, 'unsupported_workflow_graph'],
  ['review', d => { d.nodes = [{ id: 'task', kind: 'review', title: 'Review' }] }, 'unsupported_workflow_graph'],
  ['unconfirmed', d => { d.confirmed = false }, 'workflow_not_confirmed'],
  ['center role', d => { d.nodes[0].agent = 'center' }, 'run_node_role_not_allowed'],
]) {
  test(`${name} rejects before persistence or dispatch`, async () => {
    const f = fixture(); change(f.document)
    await assert.rejects(f.service.submit({ workflowId: 'workflow' }, f.exec), { code })
    assert.equal(f.rows.size, 0); assert.equal(f.dispatches, 0)
  })
}

test('payload identities and unsupported preset schema cannot reach persistence', async () => {
  const f = fixture()
  await assert.rejects(f.service.submit({ workflowId: 'workflow', requestId: 'forged' }, f.exec), { code: 'invalid_input' })
  f.ctx.tools.get = () => ({ parameters: { type: 'object', properties: {} } })
  await assert.rejects(f.service.submit({ workflowId: 'workflow' }, f.exec), { code: 'NATIVE_PRESET_NOT_ALLOWED' })
  assert.equal(f.rows.size, 0); assert.equal(f.dispatches, 0)
})

for (const owner of ['parent', 'host', 'cancel']) {
  test(`${owner} disposal/cancel aborts only the owned run and persists observed interruption`, async () => {
    const f = fixture({ mode: 'manual' })
    const queued = await f.service.submit({ workflowId: 'workflow' }, f.exec)
    await started(f)
    if (owner === 'parent') f.parentScope.dispose()
    if (owner === 'host') f.hostScope.dispose()
    if (owner === 'cancel') assert.equal((await f.service.cancel({ runId: queued.runId }, f.exec)).reason, 'abort_requested')
    await f.service.drain()
    assert.deepEqual(f.interrupts, [{ id: 'child', authority: { kind: 'ancestor', agent: f.parent } }])
    assert.equal(f.rows.get(queued.runId).nodes.task.status, 'interrupted')
    assert.notEqual(f.rows.get(queued.runId).status, 'cancelled')
  })
}

test('cancel before the queued task starts reports abort only and never spawns', async () => {
  const f = fixture()
  const queued = await f.service.submit({ workflowId: 'workflow' }, f.exec)
  assert.equal((await f.service.cancel({ runId: queued.runId }, f.exec)).reason, 'abort_requested')
  await f.service.drain()
  assert.equal(f.dispatches, 0)
  assert.equal(f.rows.get(queued.runId).nodes.task.status, 'pending')
  assert.equal(f.rows.get(queued.runId).nodes.task.attempt, 0)
  assert.equal(f.rows.get(queued.runId).cancelRequested, true)
  assert.equal(f.rows.get(queued.runId).status, 'interrupted')
})

test('wrong center and replacement Agent cannot submit, read, list or cancel', async () => {
  const f = fixture()
  const queued = await f.service.submit({ workflowId: 'workflow' }, f.exec)
  await f.service.drain()
  const bad = { ...f.exec, agent: { ...f.parent } }
  for (const [method, input] of [['submit', { workflowId: 'workflow' }], ['get', { runId: queued.runId }], ['list', {}], ['cancel', { runId: queued.runId }]]) {
    await assert.rejects(f.service[method](input, bad), { code: 'untrusted_parent' })
  }
  f.state.roles.center.sessionId = 'different-center'
  await assert.rejects(f.service.get({ runId: queued.runId }, f.exec), { code: 'center_binding_mismatch' })
})

for (const change of ['definition', 'binding', 'archive', 'agent']) {
  test(`${change} changes after submit prevent dispatch`, async () => {
    const f = fixture()
    const queued = await f.service.submit({ workflowId: 'workflow' }, f.exec)
    if (change === 'definition') f.document.nodes[0].instruction = 'changed task'
    if (change === 'binding') f.state.roleBindingRevisions.center = '8'
    if (change === 'archive') f.ctx.workspaceRegistry.archivedSessionIds.push(f.parent.session.id)
    if (change === 'agent') f.ctx.agents.get = () => undefined
    await f.service.drain()
    assert.equal(f.dispatches, 0)
    assert.equal(f.rows.get(queued.runId).nodes.task.status, 'unknown')
  })
}

test('same trusted call is persistently idempotent under concurrency, terminal replay and service recreation', async () => {
  const f = fixture()
  const results = await Promise.all(Array.from({ length: 8 }, () => f.service.submit({ workflowId: 'workflow' }, f.exec)))
  assert.equal(new Set(results.map(result => result.runId)).size, 1)
  assert.equal(results.filter(result => result.scheduled).length, 1)
  await f.service.drain()
  assert.equal(f.dispatches, 1)
  const duplicate = await f.service.submit({ workflowId: 'workflow' }, f.exec)
  assert.deepEqual(duplicate, { runId: results[0].runId, status: 'done', queued: false, scheduled: false, reused: true })
  const rebuilt = createWorkflowNativeService(f.options)
  assert.equal((await rebuilt.submit({ workflowId: 'workflow' }, f.exec)).scheduled, false)
  assert.equal(f.dispatches, 1)
  f.document.title = 'new definition'
  await assert.rejects(rebuilt.submit({ workflowId: 'workflow' }, f.exec), { code: 'submission_identity_conflict' })
})

test('persisted create response loss is reused without guessing liveness; explicit recovery never dispatches', async () => {
  const f = fixture({ failAfterSave: true })
  const reused = await f.service.submit({ workflowId: 'workflow' }, f.exec)
  assert.equal(reused.scheduled, false)
  assert.equal(reused.reused, true)
  assert.equal(f.dispatches, 0)
  const rebuilt = createWorkflowNativeService(f.options)
  assert.equal((await rebuilt.cancel({ runId: reused.runId }, f.exec)).reason, 'not_active_in_service')
  const outcome = await rebuilt.recover()
  assert.equal(outcome.recovered.length, 0) // Cancel already persisted interrupted; recovery must not rewrite it.
  assert.equal(f.rows.get(reused.runId).status, 'interrupted')
  assert.equal((await rebuilt.submit({ workflowId: 'workflow' }, f.exec)).scheduled, false)
  assert.equal(f.dispatches, 0)
})

test('terminal cancel is read-only and policy rejection remains unknown with its category', async () => {
  const f = fixture({ mode: 'denied' })
  const queued = await f.service.submit({ workflowId: 'workflow' }, f.exec)
  await f.service.drain()
  assert.equal(f.rows.get(queued.runId).nodes.task.status, 'unknown')
  assert.equal(f.rows.get(queued.runId).nodes.task.error, 'TOOL_POLICY_DENIED')
  const complete = fixture()
  const done = await complete.service.submit({ workflowId: 'workflow' }, complete.exec)
  await complete.service.drain()
  const before = complete.writes.length
  assert.equal((await complete.service.cancel({ runId: done.runId }, complete.exec)).reason, 'already_terminal')
  assert.equal(complete.writes.length, before)
})


test('a distinct trusted tool call creates a new manual submission', async () => {
  const f = fixture()
  const first = await f.service.submit({ workflowId: 'workflow' }, f.exec)
  await f.service.drain()
  const second = await f.service.submit({ workflowId: 'workflow' }, { ...f.exec, callId: 'another-trusted-call' })
  await f.service.drain()
  assert.notEqual(first.runId, second.runId)
  assert.equal(f.rows.size, 2)
  assert.equal(f.dispatches, 2)
})

test('a shared generation service enforces each current exact parent and hides another parent history', async () => {
  const f = fixture()
  const first = await f.service.submit({ workflowId: 'workflow' }, f.exec)
  await f.service.drain()
  const otherParent = { id: 'other-parent', session: { id: 'other-session' }, ctx: scope() }
  f.ctx.agents.get = id => id === otherParent.id ? otherParent : id === f.parent.id ? f.parent : undefined
  f.ctx.workspaceRegistry.get = id => id === 'workspace' ? { id, path: 'C:/fixture', sessionIds: [f.parent.session.id, otherParent.session.id] } : undefined
  f.state.roles.center.sessionId = otherParent.session.id
  f.state.roleBindingRevisions.center = '8'
  const otherExec = { agent: otherParent, callId: 'other-read' }
  await assert.rejects(f.service.get({ runId: first.runId }, otherExec), { code: 'run_parent_mismatch' })
  await assert.rejects(f.service.cancel({ runId: first.runId }, otherExec), { code: 'run_parent_mismatch' })
  assert.deepEqual(await f.service.list({}, otherExec), [])
  await assert.rejects(f.service.submit({ workflowId: 'workflow' }, f.exec), { code: 'center_binding_mismatch' })
  assert.equal(f.dispatches, 1)
})

test('service reconstruction alone never recovers or redispatches another instance live run', async () => {
  const f = fixture({ mode: 'manual' })
  const first = await f.service.submit({ workflowId: 'workflow' }, f.exec)
  await started(f)
  const rebuilt = createWorkflowNativeService(f.options)
  assert.equal(f.rows.get(first.runId).nodes.task.attemptState, 'acknowledged')
  assert.equal((await rebuilt.submit({ workflowId: 'workflow' }, f.exec)).scheduled, false)
  assert.equal((await rebuilt.cancel({ runId: first.runId }, f.exec)).reason, 'not_active_in_service')
  assert.equal(f.dispatches, 1)
  await f.service.cancel({ runId: first.runId }, f.exec)
  await f.service.drain()
})

test('Host unload before queue starts blocks future submits without calling parent.cancel', async () => {
  const f = fixture()
  f.parent.cancel = () => assert.fail('service must not replace or invoke parent.cancel')
  const first = await f.service.submit({ workflowId: 'workflow' }, f.exec)
  f.hostScope.dispose()
  await f.service.drain()
  assert.equal(f.dispatches, 0)
  assert.equal(f.rows.get(first.runId).nodes.task.status, 'unknown')
  await assert.rejects(f.service.submit({ workflowId: 'workflow' }, { ...f.exec, callId: 'later' }), { code: 'service_closed' })
})


test('aborted submission and cancellation during async definition/store reads never persist or spawn', async () => {
  for (const phase of ['already-aborted', 'definition-read', 'store-read']) {
    const f = fixture()
    const controller = new AbortController()
    if (phase === 'already-aborted') controller.abort()
    if (phase === 'definition-read') {
      const get = f.options.definitionStore.get
      f.options.definitionStore.get = async id => { const value = await get(id); controller.abort(); return value }
    }
    if (phase === 'store-read') {
      const get = f.options.runStore.get
      f.options.runStore.get = async id => { const value = await get(id); controller.abort(); return value }
    }
    await assert.rejects(f.service.submit({ workflowId: 'workflow' }, { ...f.exec, signal: controller.signal }), { code: 'ABORTED_BEFORE_NATIVE_SUBMIT' })
    assert.equal(f.rows.size, 0)
    assert.equal(f.dispatches, 0)
  }
})

test('abort during durable create retains the run but owns an aborted observation task with zero spawn', async () => {
  const f = fixture()
  const controller = new AbortController()
  const save = f.options.runStore.save
  f.options.runStore.save = async (snapshot, expectedRevision) => {
    const result = await save(snapshot, expectedRevision)
    if (expectedRevision === 0) controller.abort()
    return result
  }
  const result = await f.service.submit({ workflowId: 'workflow' }, { ...f.exec, signal: controller.signal })
  assert.equal(result.queued, true)
  await f.service.drain()
  assert.equal(f.rows.size, 1)
  assert.equal(f.dispatches, 0)
  assert.equal(f.rows.get(result.runId).nodes.task.status, 'unknown')
  assert.notEqual(f.rows.get(result.runId).status, 'cancelled')
})

test('explicit Host-only dispose shares closed/owned-abort semantics with generation cleanup', async () => {
  const f = fixture({ mode: 'manual' })
  const result = await f.service.submit({ workflowId: 'workflow' }, f.exec)
  await started(f)
  assert.equal(f.service.dispose(), undefined)
  await f.service.drain()
  assert.equal(f.rows.get(result.runId).nodes.task.status, 'interrupted')
  await assert.rejects(f.service.submit({ workflowId: 'workflow' }, f.exec), { code: 'service_closed' })
})


test('prepare returns authoritative single-node eligibility and optional submit revisions reject stale before persistence', async () => {
  const f = fixture()
  const prepared = await f.service.prepare({ workflowId: 'workflow' }, f.exec)
  assert.equal(prepared.eligible, true)
  assert.equal(prepared.executionMode, 'native_dsh')
  assert.equal(prepared.confirmed, true)
  assert.deepEqual(prepared.center, { roleId: 'center', sessionId: f.parent.session.id, workspaceId: 'workspace', archiveState: 'unarchived' })
  assert.deepEqual(prepared.node, { id: 'task', roleId: 'product', agentPreset: ROLE_PRESETS.product })
  await assert.rejects(f.service.submit({ workflowId: 'workflow', expectedDefinitionRevision: 'sha256:stale' }, f.exec), { code: 'definition_revision_mismatch' })
  await assert.rejects(f.service.submit({ workflowId: 'workflow', expectedBindingRevision: '6' }, f.exec), { code: 'binding_revision_mismatch' })
  assert.equal(f.rows.size, 0)
  assert.equal(f.dispatches, 0)
  const result = await f.service.submit({ workflowId: 'workflow', expectedDefinitionRevision: prepared.definitionRevision, expectedBindingRevision: prepared.bindingRevision }, f.exec)
  await f.service.drain()
  assert.equal(f.rows.get(result.runId).status, 'done')
})

test('expected definition revisions are rechecked after an asynchronous store read before create', async () => {
  const f = fixture()
  const prepared = await f.service.prepare({ workflowId: 'workflow' }, f.exec)
  const get = f.options.runStore.get
  f.options.runStore.get = async id => { const value = await get(id); f.document.title = 'Changed while reading'; return value }
  await assert.rejects(f.service.submit({ workflowId: 'workflow', expectedDefinitionRevision: prepared.definitionRevision, expectedBindingRevision: prepared.bindingRevision }, f.exec), { code: 'definition_revision_mismatch' })
  assert.equal(f.rows.size, 0)
  assert.equal(f.dispatches, 0)
})


test('binding changes during the final definition read are rejected before any create', async () => {
  const f = fixture()
  const p = await f.service.prepare({ workflowId: 'workflow' }, f.exec)
  const get = f.options.definitionStore.get
  let reads = 0
  f.options.definitionStore.get = async id => { const value = await get(id); if (++reads === 2) f.state.roleBindingRevisions.center = '8'; return value }
  await assert.rejects(f.service.submit({ workflowId: 'workflow', expectedDefinitionRevision: p.definitionRevision, expectedBindingRevision: p.bindingRevision }, f.exec), { code: 'binding_revision_mismatch' })
  assert.equal(f.rows.size, 0)
  assert.equal(f.dispatches, 0)
})
