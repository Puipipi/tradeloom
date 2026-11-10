import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { createWorkflowNativeService } from '../workflow-native-service.js'
import { ROLE_PRESETS } from '../roles.js'
import { createPostgresWorkflowDefinitionStore } from '../workflow-definition-postgres.js'
import { createConfirmedWorkflowDefinition } from '../workflow-definition.js'
import { createWorkflowRunJournal } from '../workflow-run-journal.js'
import { createWorkflowReviewRequest } from '../workflow-review.js'

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
function fixture({ mode = 'complete', failCreate = false, failAfterSave = false, outcomes = {}, outputs = {}, output = 'done', withTaskAuthority = false } = {}) {
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
  const dispatchPrompts = []
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
        dispatchPrompts.push(request.arguments.prompt)
        assert.equal([...rows.values()].filter(row => row.nodes[node.id].attemptState === 'started').length, 1)
        const behavior = outcomes[node.id] ?? mode
        if (behavior === 'denied') return { isError: true, error: { info: { code: 'TOOL_POLICY_DENIED' } }, content: [] }
        const occurrence = dispatchNodes.filter(id => id === node.id).length
        const suffix = occurrence === 1 ? '' : `-${occurrence}`
        const child = node.id === 'task' && occurrence === 1 ? start : { ...start, id: `child-${node.id}${suffix}`, runId: `native-${node.id}${suffix}` }
        activeChildren.set(child.id, child)
        emit('subagent/start', child)
        if (behavior === 'complete' || behavior === 'failed') emit('subagent/end', { ...end, ...child,
          lastAssistantMessage: [{ type: 'text', text: outputs[node.id] ?? output }],
          ...(behavior === 'failed' ? { stopReason: 'failed' } : {}) })
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
  const taskAuthority = withTaskAuthority ? {
    bindTask() { return { signal: new AbortController().signal } },
    releaseTask() {},
    executeTask(_task, input) { return ctx.tools.execute(input) },
  } : undefined
  const options = { ctx, readState: async () => state, definitionStore: { async get(id) { return id === document.id ? clone(document) : null } }, runStore, timeoutMs: 120,
    ...(taskAuthority ? { taskAuthority } : {}) }
  const service = createWorkflowNativeService(options)
  const exec = { agent: parent, callId: 'submit-call', signal: new AbortController().signal }
  return { service, options, exec, rows, writes, document, state, ctx, parent, parentScope, hostScope, interrupts, dispatchNodes, dispatchPrompts,
    get dispatches() { return dispatches }, end: () => emit('subagent/end', end) }
}

test('native service runs input and output controls around one verified agent attempt', async () => {
  const f = fixture({ outputs: { task: 'verified AI result' } })
  f.document.nodes = [
    { id: 'input', kind: 'input', title: 'Input', instruction: 'Exact caller-provided workflow input' },
    { id: 'task', kind: 'agent', agent: 'product', title: 'Task', instruction: 'Process the input' },
    { id: 'output', kind: 'output', title: 'Output', instruction: 'This text is not the output source' },
  ]
  f.document.edges = [{ from: 'input', to: 'task' }, { from: 'task', to: 'output' }]

  const prepared = await f.service.prepare({ workflowId: 'workflow' }, f.exec)
  assert.equal(prepared.eligible, true)
  assert.equal(prepared.graph.nodeCount, 3)
  assert.deepEqual(prepared.graph.roleIds, ['product'])
  assert.deepEqual(prepared.graph.nodes.map(node => node.kind ?? 'agent'), ['input', 'agent', 'output'])
  const submitted = await f.service.submit({ workflowId: 'workflow' }, f.exec)
  const drainResult = await f.service.drain()

  const run = f.rows.get(submitted.runId)
  assert.equal(run.status, 'done', JSON.stringify({ drainResult, nodes: run.nodes, events: run.events.slice(-5) }))
  assert.equal(f.dispatches, 1)
  assert.deepEqual(f.dispatchNodes, ['task'])
  assert.match(f.dispatchPrompts[0], /Exact caller-provided workflow input/)
  assert.equal(run.nodes.input.output, 'Exact caller-provided workflow input')
  assert.equal(run.nodes.input.attempt, 0)
  assert.equal(run.nodes.input.requestId, null)
  assert.equal(run.nodes.input.childId, null)
  assert.equal(run.nodes.task.status, 'done')
  assert.equal(run.nodes.output.output, 'verified AI result')
  assert.equal(run.nodes.output.attempt, 0)
  assert.equal(run.nodes.output.requestId, null)
  assert.equal(run.nodes.output.toolCallId, null)
  assert.equal(run.nodes.output.childId, null)
  const localEvents = run.events.filter(event => event.source === 'workflow/local')
  assert.deepEqual(localEvents.map(event => [event.nodeId, event.type, event.attempt, event.requestId, event.childId]), [
    ['input', 'local-node-terminal', 0, null, null],
    ['output', 'local-node-terminal', 0, null, null],
  ])
})

test('input-only definitions are not eligible for native workflow execution', async () => {
  const f = fixture()
  f.document.nodes = [{ id: 'input', kind: 'input', title: 'Input', instruction: 'Only local text' }]
  f.document.edges = []
  await assert.rejects(f.service.prepare({ workflowId: 'workflow' }, f.exec), { code: 'unsupported_workflow_graph' })
  await assert.rejects(f.service.submit({ workflowId: 'workflow' }, f.exec), { code: 'unsupported_workflow_graph' })
  assert.equal(f.rows.size, 0)
  assert.equal(f.dispatches, 0)
})

test('review definitions require the Host user-questions service before a run is created', async () => {
  const f = fixture()
  f.document.nodes = [
    { id: 'task', kind: 'agent', agent: 'product', title: 'Task', instruction: 'Produce a result' },
    { id: 'review', kind: 'review', title: 'Review', instruction: 'Confirm the result' },
  ]
  f.document.edges = [{ from: 'task', to: 'review' }]
  f.ctx.userQuestions = undefined
  await assert.rejects(f.service.prepare({ workflowId: 'workflow' }, f.exec), { code: 'review_unavailable' })
  await assert.rejects(f.service.submit({ workflowId: 'workflow' }, f.exec), { code: 'review_unavailable' })
  assert.equal(f.rows.size, 0)
  assert.equal(f.dispatches, 0)
})

test('pre-ask definition or binding change fails and settles the persisted review node without asking', async t => {
  for (const change of ['binding', 'definition']) await t.test(change, async () => {
    const f = fixture()
    f.document.nodes = [
      { id: 'review', kind: 'review', title: 'Review', instruction: 'Approve or reject' },
      { id: 'task', kind: 'agent', agent: 'product', title: 'Task', instruction: 'Continue after review' },
    ]
    f.document.edges = [{ from: 'review', to: 'task' }]
    let asks = 0
    f.ctx.userQuestions = { async ask() { asks++; return { answers: [] } } }

    const submitted = await f.service.submit({ workflowId: 'workflow' }, f.exec)
    if (change === 'binding') f.state.roleBindingRevisions.center = '8'
    else f.document.nodes[0].instruction = 'Changed before the question was sent'
    await f.service.drain()

    const run = await f.options.runStore.get(submitted.runId)
    assert.equal(asks, 0)
    assert.equal(run.status, 'failed')
    assert.equal(run.nodes.review.status, 'failed')
    assert.equal(run.nodes.review.reviewState.status, 'failed')
    assert.equal(run.nodes.review.error, 'review_context_stale')
    assert.equal(run.nodes.task.status, 'skipped')
    assert.equal(f.dispatches, 0)
  })
})

test('review revalidates definition and binding after SDK answer with and without task authority', async t => {
  for (const withTaskAuthority of [false, true]) {
    for (const change of ['binding', 'definition']) {
      await t.test(`${withTaskAuthority ? 'task authority' : 'direct factory'} / ${change}`, async () => {
        const f = fixture({ withTaskAuthority })
        f.document.nodes = [
          { id: 'task', kind: 'agent', agent: 'product', title: 'Task', instruction: 'Produce a result' },
          { id: 'review', kind: 'review', title: 'Review', instruction: 'Check the result' },
          { id: 'output', kind: 'output', title: 'Output', instruction: 'Not output source' },
        ]
        f.document.edges = [{ from: 'task', to: 'review' }, { from: 'review', to: 'output' }]
        let resolveAnswer
        let requested
        const asked = new Promise(resolve => { requested = resolve })
        f.ctx.userQuestions = { ask({ questions, agent, signal }) {
          assert.equal(agent, f.parent)
          assert.equal(signal.aborted, false)
          requested(questions[0])
          return new Promise(resolve => { resolveAnswer = resolve })
        } }
        const submitted = await f.service.submit({ workflowId: 'workflow' }, f.exec)
        const question = await Promise.race([asked, new Promise((_, reject) => setTimeout(() => reject(new Error('review ask timeout')), 3000))])
        assert.equal(question.header, '工作流审核')
        assert.match(question.detail, /审核要求：/)
        assert.match(question.detail, /上游节点「task」/)
        assert.match(question.detail, /verified|done/)
        if (change === 'binding') f.state.roleBindingRevisions.center = '8'
        else f.document.nodes.find(node => node.id === 'task').instruction = 'Changed after review request'
        resolveAnswer({ answers: [{ id: question.id, selected: ['批准'], custom: '' }] })
        const drained = await Promise.race([f.service.drain(), new Promise((_, reject) => setTimeout(() => reject(new Error('review drain timeout')), 3000))])
        assert.equal(drained.length, 1)
        const run = f.rows.get(submitted.runId)
        assert.equal(run.status, 'failed', JSON.stringify({ status: run.status, nodes: run.nodes, events: run.events.slice(-8) }))
        assert.equal(run.nodes.review.status, 'failed')
        assert.equal(run.nodes.review.error, 'review_context_stale')
        assert.equal(run.nodes.output.status, 'skipped')
        assert.equal(run.nodes.output.output, '')
        assert.equal(f.dispatches, 1)
        assert.equal(run.nodes.review.reviewState.status, 'failed')
      })
    }
  }
})

test('review decision records exact SDK choice and never creates native identity', async () => {
  const f = fixture({ output: 'Verified parent result' })
  f.document.nodes = [
    { id: 'task', kind: 'agent', agent: 'product', title: 'Task', instruction: 'Produce a result' },
    { id: 'review', kind: 'review', title: 'Review', instruction: 'Check the result' },
    { id: 'output', kind: 'output', title: 'Output', instruction: 'Ignored' },
  ]
  f.document.edges = [{ from: 'task', to: 'review' }, { from: 'review', to: 'output' }]
  let captured
  f.ctx.userQuestions = { async ask(input) {
    captured = input
    return { answers: [{ id: input.questions[0].id, selected: ['批准'], custom: undefined }] }
  } }
  const submitted = await f.service.submit({ workflowId: 'workflow' }, f.exec)
  const drained = await f.service.drain()
  const run = f.rows.get(submitted.runId)
  assert.equal(drained[0].error, null, JSON.stringify({ drained, review: run.nodes.review, events: run.events.slice(-5) }))
  assert.equal(captured.agent, f.parent)
  assert.equal(captured.questions[0].options.length, 2)
  assert.equal(captured.questions[0].options[0].label, '批准')
  assert.equal(captured.questions[0].options[1].label, '拒绝')
  assert.equal(run.status, 'done', JSON.stringify({ status: run.status, nodes: run.nodes, events: run.events.slice(-8), drained }))
  assert.equal(run.nodes.review.status, 'done')
  assert.equal(run.nodes.review.attempt, 0)
  assert.equal(run.nodes.review.output, 'Verified parent result')
  for (const key of ['requestId', 'toolCallId', 'childId', 'nativeRunId']) assert.equal(run.nodes.review[key], null)
  assert.deepEqual(run.nodes.review.artifacts, [])
  assert.equal(run.nodes.review.artifactSource, 'unknown')
  assert.equal(run.nodes.output.output, 'Verified parent result')
  const receipt = run.nodes.review.reviewState.receipt
  assert.equal(receipt.source, 'dsh-user-questions')
  assert.equal(receipt.decision, 'approved')
  assert.equal(receipt.attempt, 0)
  assert.deepEqual(run.events.filter(event => event.source === 'dsh-user-questions').map(event => event.type), [
    'review-node-waiting', 'review-node-terminal',
  ])
})

test('late review answer cannot revive a terminal run; interrupted review requires explicit resume', async () => {
  const f = fixture()
  f.document.nodes = [
    { id: 'task', kind: 'agent', agent: 'product', title: 'Task', instruction: 'Produce a result' },
    { id: 'review', kind: 'review', title: 'Review', instruction: 'Approve or reject' },
  ]
  f.document.edges = [{ from: 'task', to: 'review' }]
  let resolveAnswer
  let askStarted
  const asked = new Promise(resolve => { askStarted = resolve })
  f.ctx.userQuestions = { ask({ questions }) {
    askStarted(questions[0])
    return new Promise(resolve => { resolveAnswer = resolve })
  } }
  const submitted = await f.service.submit({ workflowId: 'workflow' }, f.exec)
  const question = await Promise.race([asked, new Promise((_, reject) => setTimeout(() => reject(new Error('review ask timeout')), 3000))])
  const journal = createWorkflowRunJournal({ store: f.options.runStore })
  const handle = await journal.open(submitted.runId)
  const failed = await handle.failReview({ nodeId: 'review', questionId: question.id })
  assert.equal(failed.status, 'failed')
  const terminalRevision = failed.revision
  resolveAnswer({ answers: [{ id: question.id, selected: ['批准'] }] })
  await f.service.drain()
  const afterLateAnswer = await f.options.runStore.get(submitted.runId)
  assert.equal(afterLateAnswer.status, 'failed')
  assert.equal(afterLateAnswer.revision, terminalRevision)
  assert.equal(afterLateAnswer.nodes.review.reviewState.status, 'failed')
  assert.equal(f.dispatches, 1)

  const g = fixture()
  g.document.nodes = [
    { id: 'review', kind: 'review', title: 'Review', instruction: 'Approve or reject' },
    { id: 'task', kind: 'agent', agent: 'product', title: 'Task', instruction: 'Continue after review' },
  ]
  g.document.edges = [{ from: 'review', to: 'task' }]
  const gJournal = createWorkflowRunJournal({ store: g.options.runStore })
  const runId = '30000000-0000-4000-8000-000000000003'
  const created = await gJournal.create({ workflowId: 'workflow', document: g.document, workflowRunId: runId,
    requestId: 'review-resume-test', parentAgentId: g.parent.id, sessionId: g.parent.session.id, bindingRevision: '7' })
  const request1 = createWorkflowReviewRequest(created.getSnapshot(), g.document.nodes[0], '30000000-0000-4000-8000-000000000004', new Date().toISOString()).request
  await created.beginReview({ nodeId: 'review', request: request1, bindingRevision: '7', definitionRevision: created.getSnapshot().definitionRevision })
  await created.interruptReview({ nodeId: 'review', questionId: request1.questionId })
  const request2 = createWorkflowReviewRequest(created.getSnapshot(), g.document.nodes[0], '30000000-0000-4000-8000-000000000005', new Date().toISOString()).request
  await assert.rejects(created.beginReview({ nodeId: 'review', request: request2, bindingRevision: '7',
    definitionRevision: created.getSnapshot().definitionRevision }), { code: 'resume_confirmation_required' })
})

test('review rejects only the explicit reject option and blocks descendants', async () => {
  const f = fixture()
  f.document.nodes = [
    { id: 'task', kind: 'agent', agent: 'product', title: 'Task', instruction: 'Produce a result' },
    { id: 'review', kind: 'review', title: 'Review', instruction: 'Approve or reject' },
    { id: 'output', kind: 'output', title: 'Output', instruction: 'Ignored' },
  ]
  f.document.edges = [{ from: 'task', to: 'review' }, { from: 'review', to: 'output' }]
  let asks = 0
  f.ctx.userQuestions = { async ask({ questions }) {
    asks++
    return { answers: [{ id: questions[0].id, selected: ['拒绝'] }] }
  } }
  const submitted = await f.service.submit({ workflowId: 'workflow' }, f.exec)
  await f.service.drain()
  const run = await f.options.runStore.get(submitted.runId)
  assert.equal(asks, 1)
  assert.equal(run.status, 'failed')
  assert.equal(run.nodes.review.reviewState.status, 'rejected')
  assert.equal(run.nodes.review.error, 'review_rejected')
  assert.equal(run.nodes.output.status, 'skipped')
  assert.equal(run.nodes.output.output, '')
  assert.equal(f.dispatches, 1)
})

test('custom text, custom-only answers and wrong question IDs defer instead of approving', async t => {
  const invalidAnswers = [
    ['selected choice with custom approval text', question => ({ answers: [{ id: question.id, selected: ['批准'], custom: '批准' }] })],
    ['custom-only approval text', question => ({ answers: [{ id: question.id, selected: [], custom: '批准' }] })],
    ['answer for a different question', question => ({ answers: [{ id: `${question.id}-other`, selected: ['批准'] }] })],
  ]
  for (const [label, answer] of invalidAnswers) await t.test(label, async () => {
    const f = fixture()
    f.document.nodes = [
      { id: 'task', kind: 'agent', agent: 'product', title: 'Task', instruction: 'Produce a result' },
      { id: 'review', kind: 'review', title: 'Review', instruction: 'Approve or reject' },
      { id: 'output', kind: 'output', title: 'Output', instruction: 'Ignored' },
    ]
    f.document.edges = [{ from: 'task', to: 'review' }, { from: 'review', to: 'output' }]
    f.ctx.userQuestions = { async ask({ questions }) { return answer(questions[0]) } }
    const submitted = await f.service.submit({ workflowId: 'workflow' }, f.exec)
    await f.service.drain()
    const run = await f.options.runStore.get(submitted.runId)
    assert.equal(run.status, 'waiting')
    assert.equal(run.nodes.review.reviewState.status, 'deferred')
    assert.equal(run.nodes.review.error, 'review_answer_invalid')
    assert.equal(run.nodes.output.status, 'pending')
    assert.equal(f.dispatches, 1)
  })
})

test('NO_PROVIDER resumes from persisted review state with a fresh question and no repeat child', async () => {
  const f = fixture()
  f.document.nodes = [
    { id: 'task', kind: 'agent', agent: 'product', title: 'Task', instruction: 'Produce a result' },
    { id: 'review', kind: 'review', title: 'Review', instruction: 'Approve or reject' },
    { id: 'output', kind: 'output', title: 'Output', instruction: 'Ignored' },
  ]
  f.document.edges = [{ from: 'task', to: 'review' }, { from: 'review', to: 'output' }]
  const questionIds = []
  f.ctx.userQuestions = { async ask({ questions }) {
    questionIds.push(questions[0].id)
    if (questionIds.length === 1) throw Object.assign(new Error('no fixture answerer'), { code: 'NO_PROVIDER' })
    return { answers: [{ id: questions[0].id, selected: ['批准'] }] }
  } }
  const submitted = await f.service.submit({ workflowId: 'workflow' }, f.exec)
  await f.service.drain()
  const first = await f.options.runStore.get(submitted.runId)
  assert.equal(first.status, 'waiting')
  assert.equal(first.nodes.review.reviewState.status, 'deferred')
  assert.equal(first.nodes.review.error, 'review_unavailable')
  assert.equal(first.nodes.output.status, 'pending')

  f.service.dispose()
  const reopened = createWorkflowNativeService(f.options)
  try {
    const plan = await reopened.prepare_resume({ runId: submitted.runId }, f.exec)
    assert.equal(plan.eligible, true)
    assert.deepEqual(plan.eligibleNodeIds, ['review', 'output'])
    assert.deepEqual(plan.completedNodeIds, ['task'])
    await reopened.resume(resumeInput(plan), { ...f.exec, callId: 'review-resume-call' })
    await reopened.drain()
    const run = await f.options.runStore.get(submitted.runId)
    assert.equal(run.status, 'done')
    assert.equal(run.nodes.task.attempt, 1)
    assert.equal(run.nodes.review.reviewState.status, 'approved')
    assert.equal(run.nodes.output.status, 'done')
    assert.equal(questionIds.length, 2)
    assert.notEqual(questionIds[0], questionIds[1])
    assert.equal(f.dispatches, 1)
  } finally { reopened.dispose() }
})

test('review cancellation waits for an answerer that ignores AbortSignal and ignores late approval', async () => {
  const f = fixture()
  f.document.nodes = [
    { id: 'task', kind: 'agent', agent: 'product', title: 'Task', instruction: 'Produce a result' },
    { id: 'review', kind: 'review', title: 'Review', instruction: 'Approve or reject' },
    { id: 'output', kind: 'output', title: 'Output', instruction: 'Ignored' },
  ]
  f.document.edges = [{ from: 'task', to: 'review' }, { from: 'review', to: 'output' }]
  let resolveAnswer
  let requested
  const asked = new Promise(resolve => { requested = resolve })
  f.ctx.userQuestions = { ask({ questions, signal }) {
    requested({ question: questions[0], signal })
    return new Promise(resolve => { resolveAnswer = resolve })
  } }
  const submitted = await f.service.submit({ workflowId: 'workflow' }, f.exec)
  const { question, signal } = await Promise.race([asked, new Promise((_, reject) => setTimeout(() => reject(new Error('review ask timeout')), 3000))])
  assert.equal(signal.aborted, false)
  const cancellation = await f.service.cancel({ runId: submitted.runId }, { ...f.exec, callId: 'cancel-review-call' })
  assert.equal(cancellation.aborted, true)
  assert.equal(signal.aborted, true)
  let drained = false
  const drainPromise = f.service.drain().then(() => { drained = true })
  await new Promise(resolve => setTimeout(resolve, 25))
  assert.equal(drained, false, 'service must retain and join a provider promise that ignores its signal')
  resolveAnswer({ answers: [{ id: question.id, selected: ['批准'] }] })
  await drainPromise
  const run = await f.options.runStore.get(submitted.runId)
  assert.equal(run.status, 'interrupted')
  assert.equal(run.nodes.review.reviewState.status, 'interrupted')
  assert.equal(run.nodes.output.status, 'pending')
  assert.equal(run.events.some(event => event.type === 'review-node-terminal'), false)
  assert.equal(f.dispatches, 1)
})

test('mixed fan-in follows definition order and passes local output into the next agent', async () => {
  const f = fixture({ outputs: { a: 'A result', b: 'B result' } })
  f.document.nodes = [
    { id: 'input', kind: 'input', title: 'Input', instruction: '' },
    { id: 'a', kind: 'agent', agent: 'product', title: 'A', instruction: 'First step' },
    { id: 'b', kind: 'agent', agent: 'product', title: 'B', instruction: 'Second step' },
    { id: 'merge', kind: 'output', title: 'Merge', instruction: 'Ignored' },
    { id: 'last', kind: 'agent', agent: 'product', title: 'Last', instruction: 'Use merged result' },
  ]
  f.document.edges = [{ from: 'input', to: 'a' }, { from: 'a', to: 'merge' }, { from: 'b', to: 'merge' },
    { from: 'input', to: 'b' }, { from: 'merge', to: 'last' }]
  const submitted = await f.service.submit({ workflowId: 'workflow' }, f.exec)
  const drainResult = await f.service.drain()
  const run = f.rows.get(submitted.runId)
  assert.equal(run.status, 'done', JSON.stringify({ drainResult, nodes: run.nodes, events: run.events.slice(-8), dispatchPrompts: f.dispatchPrompts }))
  assert.deepEqual(f.dispatchNodes, ['a', 'b', 'last'])
  assert.equal(run.nodes.input.output, '')
  assert.equal(run.nodes.merge.output, 'A result\nB result')
  const promptJsonText = JSON.stringify(['A result', 'B result'].join(String.fromCharCode(10))).slice(1, -1)
  assert.ok(f.dispatchPrompts[2].includes(promptJsonText), f.dispatchPrompts[2])
  assert.equal(run.events.filter(event => event.source === 'workflow/local' && event.type === 'local-node-terminal').length, 2)
  assert.equal(run.events.filter(event => event.type === 'attempt-started').length, 3)
})

test('failed agent upstream blocks local output without dispatching descendants', async () => {
  const f = fixture({ outcomes: { task: 'failed' } })
  f.document.nodes = [
    { id: 'input', kind: 'input', title: 'Input', instruction: 'Provided text' },
    { id: 'task', kind: 'agent', agent: 'product', title: 'Task', instruction: 'Fail this step' },
    { id: 'output', kind: 'output', title: 'Output', instruction: 'Ignored' },
    { id: 'next', kind: 'agent', agent: 'product', title: 'Next', instruction: 'Must not run' },
  ]
  f.document.edges = [{ from: 'input', to: 'task' }, { from: 'task', to: 'output' }, { from: 'output', to: 'next' }]
  const submitted = await f.service.submit({ workflowId: 'workflow' }, f.exec)
  await f.service.drain()
  const run = f.rows.get(submitted.runId)
  assert.equal(run.status, 'failed')
  assert.equal(run.nodes.input.status, 'done')
  assert.equal(run.nodes.task.status, 'failed')
  assert.equal(run.nodes.output.status, 'skipped')
  assert.equal(run.nodes.output.output, '')
  assert.equal(run.nodes.next.status, 'skipped')
  assert.deepEqual(f.dispatchNodes, ['task'])
  assert.equal(run.events.some(event => event.nodeId === 'output' && event.type === 'local-node-terminal'), false)
})

test('local calculation failure is persisted with a fixed local error and no false output', async () => {
  const f = fixture({ outputs: { task: [{ type: 'tool-call', name: 'secret-tool' }] } })
  f.document.nodes = [
    { id: 'task', kind: 'agent', agent: 'product', title: 'Task', instruction: 'Return only user text' },
    { id: 'output', kind: 'output', title: 'Output', instruction: '' },
  ]
  f.document.edges = [{ from: 'task', to: 'output' }]
  const submitted = await f.service.submit({ workflowId: 'workflow' }, f.exec)
  const drainResult = await f.service.drain()
  const run = f.rows.get(submitted.runId)
  assert.equal(run.status, 'failed', JSON.stringify({ drainResult, nodes: run.nodes }))
  assert.equal(run.nodes.output.status, 'failed')
  assert.equal(run.nodes.output.error, 'upstream_output_unavailable')
  assert.equal(run.nodes.output.output, '')
  assert.equal(run.nodes.output.attempt, 0)
  assert.equal(run.nodes.output.childId, null)
  const event = run.events.find(row => row.type === 'local-node-error' && row.nodeId === 'output')
  assert.equal(event.source, 'workflow/local')
  assert.equal(event.requestId, null)
  assert.equal(event.output, undefined)
  assert.equal(f.dispatches, 1)
})

test('cancel and resume keep completed local nodes and do not create another local receipt', async () => {
  const outcomes = { task: 'manual' }
  const f = fixture({ outcomes })
  f.document.nodes = [
    { id: 'input', kind: 'input', title: 'Input', instruction: 'Retained local text' },
    { id: 'task', kind: 'agent', agent: 'product', title: 'Task', instruction: 'Continue after resume' },
    { id: 'output', kind: 'output', title: 'Output', instruction: '' },
  ]
  f.document.edges = [{ from: 'input', to: 'task' }, { from: 'task', to: 'output' }]
  const submitted = await f.service.submit({ workflowId: 'workflow' }, f.exec)
  await nodeStarted(f, 'task')
  await f.service.cancel({ runId: submitted.runId }, { ...f.exec, callId: 'cancel-mixed' })
  await f.service.drain()
  assert.equal(f.rows.get(submitted.runId).nodes.input.status, 'done')
  assert.equal(f.rows.get(submitted.runId).nodes.output.status, 'pending')
  outcomes.task = 'complete'
  const plan = await f.service.prepare_resume({ runId: submitted.runId }, f.exec)
  const resumed = await f.service.resume(resumeInput(plan), f.exec)
  assert.equal(resumed.scheduled, true)
  await f.service.drain()
  const run = f.rows.get(submitted.runId)
  assert.equal(run.status, 'done')
  assert.equal(run.nodes.input.output, 'Retained local text')
  assert.equal(run.nodes.output.output, 'done')
  assert.equal(run.events.filter(event => event.source === 'workflow/local' && event.type === 'local-node-terminal' && event.nodeId === 'input').length, 1)
  assert.equal(run.events.filter(event => event.source === 'workflow/local' && event.type === 'local-node-terminal' && event.nodeId === 'output').length, 1)
  assert.deepEqual(f.dispatchNodes, ['task', 'task'])
})

test('startup recovery completes a pending output without a new SDK dispatch after its agent is done', async () => {
  const f = fixture()
  f.document.nodes = [
    { id: 'input', kind: 'input', title: 'Input', instruction: 'Persisted before restart' },
    { id: 'task', kind: 'agent', agent: 'product', title: 'Task', instruction: 'Use persisted input' },
    { id: 'output', kind: 'output', title: 'Output', instruction: '' },
  ]
  f.document.edges = [{ from: 'input', to: 'task' }, { from: 'task', to: 'output' }]
  const document = createConfirmedWorkflowDefinition(f.document)
  const journal = createWorkflowRunJournal({ store: f.options.runStore })
  const handle = await journal.create({ document: document.document, definitionRevision: document.definitionRevision,
    workflowRunId: '51447f40-84b1-4bc1-a99e-8bcdd73bcaaa', workflowId: f.document.id,
    requestId: 'startup-run-request', parentAgentId: f.parent.id, sessionId: f.parent.session.id, bindingRevision: '7' })
  await handle.executeLocalNode({ nodeId: 'input', bindingRevision: '7', definitionRevision: document.definitionRevision })
  assert.equal(handle.getSnapshot().nodes.input.status, 'done')
  const identity = { requestId: 'attempt-before-restart', workflowRunId: handle.getSnapshot().id, nodeId: 'task', attempt: 1,
    bindingRevision: '7', definitionRevision: document.definitionRevision, parentAgentId: f.parent.id,
    sessionId: f.parent.session.id, toolCallId: 'tool-call-before-restart', childId: 'child-before-restart', nativeRunId: 'native-before-restart' }
  await handle.executeAttempt({ nodeId: 'task', attempt: 1, requestId: identity.requestId, bindingRevision: '7',
    definitionRevision: document.definitionRevision }, async attempt => {
    await attempt.recordChildAck({ toolCallId: identity.toolCallId, childId: identity.childId, nativeRunId: identity.nativeRunId })
    return { ...identity, status: 'completed', terminalSource: 'subagent/end', stopReason: 'completed',
      output: [{ type: 'text', text: 'Persisted agent result' }] }
  })
  assert.equal(handle.getSnapshot().nodes.task.status, 'done')
  assert.equal(handle.getSnapshot().nodes.output.status, 'pending')
  const recovered = await journal.recoverInterruptedRuns()
  assert.deepEqual(recovered.recovered.map(row => row.id), [handle.getSnapshot().id])
  assert.deepEqual(recovered.unmanaged, [])
  const interruptedRevision = recovered.recovered[0].revision
  await assert.rejects(handle.executeLocalNode({ nodeId: 'output', bindingRevision: '7', definitionRevision: document.definitionRevision }),
    { code: 'resume_confirmation_required' })
  assert.equal(handle.getSnapshot().status, 'interrupted')
  assert.equal(handle.getSnapshot().revision, interruptedRevision)
  assert.equal(handle.getSnapshot().nodes.output.status, 'pending')

  const plan = await f.service.prepare_resume({ runId: handle.getSnapshot().id }, f.exec)
  const resumed = await f.service.resume(resumeInput(plan), f.exec)
  assert.equal(resumed.scheduled, true)
  await f.service.drain()
  const run = await f.options.runStore.get(handle.getSnapshot().id)
  assert.equal(run.status, 'done')
  assert.equal(run.nodes.input.output, 'Persisted before restart')
  assert.equal(run.nodes.task.status, 'done')
  assert.equal(run.nodes.output.output, 'Persisted agent result')
  assert.equal(run.events.filter(event => event.type === 'local-node-terminal' && event.nodeId === 'input').length, 1)
  assert.equal(run.events.filter(event => event.type === 'local-node-terminal' && event.nodeId === 'output').length, 1)
  assert.equal(f.dispatches, 0)
  assert.equal(run.events.filter(event => event.type === 'attempt-started' && event.nodeId === 'task').length, 1)
})

test('terminal runs never complete pending local nodes, while completed local reads remain idempotent', async () => {
  const f = fixture()
  f.document.nodes = [
    { id: 'input', kind: 'input', title: 'Input', instruction: 'Already completed' },
    { id: 'task', kind: 'agent', agent: 'product', title: 'Task', instruction: 'Pending agent' },
    { id: 'output', kind: 'output', title: 'Output', instruction: '' },
  ]
  f.document.edges = [{ from: 'input', to: 'task' }, { from: 'task', to: 'output' }]
  const document = createConfirmedWorkflowDefinition(f.document)
  const journal = createWorkflowRunJournal({ store: f.options.runStore })
  const handle = await journal.create({ document: document.document, definitionRevision: document.definitionRevision,
    workflowRunId: '7a661b9b-c61d-4427-a55a-026fd9161244', workflowId: f.document.id,
    requestId: 'terminal-local-request', parentAgentId: f.parent.id, sessionId: f.parent.session.id, bindingRevision: '7' })
  await handle.executeLocalNode({ nodeId: 'input', bindingRevision: '7', definitionRevision: document.definitionRevision })
  const stored = f.rows.get(handle.getSnapshot().id)
  for (const status of ['done', 'failed', 'cancelled']) {
    const terminal = clone(stored)
    terminal.revision++
    terminal.status = status
    f.rows.set(terminal.id, terminal)
    const terminalHandle = await journal.open(terminal.id)
    const before = terminalHandle.getSnapshot()
    const reused = await terminalHandle.executeLocalNode({ nodeId: 'input', bindingRevision: '7', definitionRevision: document.definitionRevision })
    assert.equal(reused.revision, before.revision)
    assert.equal(reused.status, status)
    await assert.rejects(terminalHandle.executeLocalNode({ nodeId: 'output', bindingRevision: '7', definitionRevision: document.definitionRevision }),
      { code: 'run_is_terminal' })
    assert.deepEqual(f.rows.get(terminal.id), terminal)
  }
  assert.equal(f.dispatches, 0)
})
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
  ['external', d => { d.nodes = [{ id: 'task', kind: 'external', title: 'External', platform: 'service' }] }, 'unsupported_workflow_graph'],
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
  const snapshot = f.rows.get(first.runId)
  assert.equal(snapshot.status, 'interrupted')
  assert.equal(snapshot.nodes.task.status, 'pending')
  assert.equal(snapshot.nodes.task.attempt, 0)
  const reopened = createWorkflowNativeService(f.options)
  const prepared = await reopened.prepare_resume({ runId: first.runId }, f.exec)
  assert.equal(prepared.eligible, true)
  assert.deepEqual(prepared.eligibleNodeIds, ['task'])
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
  const snapshot = f.rows.get(result.runId)
  assert.equal(snapshot.status, 'interrupted')
  assert.equal(snapshot.nodes.task.status, 'pending')
  assert.equal(snapshot.nodes.task.attempt, 0)
  const prepared = await f.service.prepare_resume({ runId: result.runId }, f.exec)
  assert.equal(prepared.eligible, true)
  assert.deepEqual(prepared.eligibleNodeIds, ['task'])
  assert.notEqual(f.rows.get(result.runId).status, 'cancelled')
})

test('Host unload before a resumed node starts preserves completed work and remains resumable', async () => {
  const f = fixture({ outcomes: { task: 'manual' } })
  f.document.nodes = [
    { id: 'input', kind: 'input', title: 'Input', instruction: 'Keep this completed input' },
    { id: 'task', kind: 'agent', agent: 'product', title: 'Task', instruction: 'Resume this task' },
    { id: 'output', kind: 'output', title: 'Output', instruction: '' },
  ]
  f.document.edges = [{ from: 'input', to: 'task' }, { from: 'task', to: 'output' }]
  const submitted = await f.service.submit({ workflowId: 'workflow' }, f.exec)
  await nodeStarted(f, 'task')
  await f.service.cancel({ runId: submitted.runId }, { ...f.exec, callId: 'cancel-before-resume' })
  await f.service.drain()

  const plan = await f.service.prepare_resume({ runId: submitted.runId }, f.exec)
  assert.equal(plan.eligible, true)
  assert.deepEqual(plan.completedNodeIds, ['input'])
  const resumed = await f.service.resume(resumeInput(plan), { ...f.exec, callId: 'resume-before-host-unload' })
  assert.equal(resumed.scheduled, true)
  f.hostScope.dispose()
  await f.service.drain()

  const snapshot = f.rows.get(submitted.runId)
  assert.equal(snapshot.status, 'interrupted')
  assert.equal(snapshot.cancelRequested, false)
  assert.equal(snapshot.nodes.input.status, 'done')
  assert.equal(snapshot.nodes.task.status, 'pending')
  assert.equal(snapshot.nodes.task.attempt, 1)
  assert.equal(snapshot.nodes.task.attemptState, 'interrupted')
  assert.equal(snapshot.nodes.output.status, 'pending')
  assert.equal(f.dispatches, 1)

  const reopened = createWorkflowNativeService(f.options)
  const nextPlan = await reopened.prepare_resume({ runId: submitted.runId }, f.exec)
  assert.equal(nextPlan.eligible, true)
  assert.deepEqual(nextPlan.completedNodeIds, ['input'])
  assert.deepEqual(nextPlan.eligibleNodeIds, ['task', 'output'])
  assert.equal(f.dispatches, 1)
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

test('native service consumes the paired definition adapter and rejects a changed persisted definition', async () => {
  const f = fixture()
  const webServer = { protocol: 'http:', host: '127.0.0.1', port: 33188, getOrigin: () => 'http://127.0.0.1:33188' }
  const bridgeKey = 'f'.repeat(64)
  let persisted = { ...createConfirmedWorkflowDefinition(f.document), revision: 1, updatedAt: '2026-10-31T02:00:00+00:00' }
  const requests = []
  const request = (transport, receive) => {
    const chunks = []
    const upstream = new EventEmitter()
    upstream.write = chunk => chunks.push(Buffer.from(chunk))
    upstream.destroy = error => { if (error) upstream.emit('error', error) }
    upstream.end = () => {
      const input = { ...transport, body: chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : null }
      requests.push(input)
      const response = new EventEmitter()
      response.statusCode = 200
      response.headers = {}
      response.end = value => { response.emit('data', Buffer.from(value)); response.emit('end') }
      receive(response)
      assert.equal(input.method, 'GET')
      assert.equal(input.path, '/api/canvas-workflow-definitions?id=workflow')
      response.end(JSON.stringify({ workflowId: 'workflow', revision: persisted.revision,
        definitionRevision: persisted.definitionRevision, document: persisted.document,
        deleted: false, updatedAt: persisted.updatedAt }))
    }
    return upstream
  }
  const definitionStore = createPostgresWorkflowDefinitionStore({ webServer, pairedHost: { host: webServer.host, port: webServer.port },
    nativeBridgeKey: bridgeKey, request, port: 33190 })
  const service = createWorkflowNativeService({ ...f.options, definitionStore })
  const prepared = await service.prepare({ workflowId: 'workflow' }, f.exec)
  assert.equal(prepared.eligible, true)
  assert.equal(prepared.definitionRevision, persisted.definitionRevision)

  const edited = createConfirmedWorkflowDefinition({ ...persisted.document, title: 'Edited after prepare' })
  persisted = { ...edited, revision: 2, updatedAt: '2026-10-31T02:01:00+00:00' }
  await assert.rejects(service.submit({ workflowId: 'workflow', expectedDefinitionRevision: prepared.definitionRevision,
    expectedBindingRevision: prepared.bindingRevision }, { ...f.exec, callId: 'stale-paired-definition' }),
  { code: 'definition_revision_mismatch' })
  assert.equal(f.rows.size, 0)
  assert.equal(f.dispatches, 0)
  assert.ok(requests.length >= 2)
  assert.ok(requests.every(item => item.headers['x-tradeloom-native-bridge'] === bridgeKey
    && item.headers.cookie === undefined && item.headers['x-csrftoken'] === undefined))
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
