import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { HOME_MARKER, HOME_MARKER_VALUE } from '../state.js'
import { Readable } from 'node:stream'
import { EventEmitter } from 'node:events'
import { pathToFileURL } from 'node:url'
import * as authorityPlugin from '../workflow-native-task-authority.js'
import { createWorkflowNativeUiHandler, projectNativeWorkflowRun } from '../workflow-native-ui.js'
import { createWorkflowNativeService } from '../workflow-native-service.js'
import { registerWorkflowNativeTools } from '../workflow-native-tools.js'
import { createNativeWorkflowReadiness, NATIVE_WORKFLOW_READINESS } from '../workflow-native-readiness.js'
import { ROLE_PRESETS } from '../roles.js'
import { replaceRoleBinding } from '../state.js'
import { verifiedWorkflowParent } from '../workflow-local-nodes.js'

// Actual desktop21 Commands/ToolRuntime and production Agent mint every execution context.
// Workspace/query/CAS and child start/end remain labelled offline facades.
// No listener, PostgreSQL, Host boot, model or GUI is started by this suite.
const runtime = process.env.TRADELOOM_NATIVE_RUNTIME
  ?? 'C:/Users/23825/Desktop/ICT/workspace/runtime/tradeloom-harness/releases/0.2.1-rc.3-tradeloom-desktop-21'
const load = path => import(pathToFileURL(`${runtime}/${path}`).href)
const [{ Context }, kit, { default: Commands }] = await Promise.all([
  load('vendor/cordis/lib/index.js'), load('packages/test-support/agent-loop-testkit/lib/index.js'), load('packages/interaction/commands/lib/index.js'),
])
// Each Node test worker owns its own state root; the product state queue is
// process-local and this suite does not claim multi-Host write coordination.
const ownedTestHome = await fs.mkdtemp(join(tmpdir(), 'tradeloom-native-ui-authority-'))
await fs.writeFile(join(ownedTestHome, HOME_MARKER), HOME_MARKER_VALUE)
process.env.DSH_HOME = process.env.TRADELOOM_DSH_APP_HOME = ownedTestHome
let fixtureSeq = 0
async function fixture(t, { mode = 'complete', rejection, stopReason = 'completed', modelSelection = false } = {}) {
  const ctx = new Context()
  t.after(() => ctx.fiber.dispose())
  // This existing SDK fixture represents a Host that completed its one startup recovery.
  const readiness = createNativeWorkflowReadiness()
  await readiness.startRecovery(async () => {})
  ctx.provide(NATIVE_WORKFLOW_READINESS, readiness)
  t.after(() => readiness.close())
  await kit.mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(Commands)
  await kit.mountAgentLoopTestHarness(ctx)
  const tools = ctx.tools
  const { agent: parent } = await ctx.agents.create({ sessionId: `center-session-${++fixtureSeq}`, meta: { cwd: 'C:/fixture', agentPreset: ROLE_PRESETS.center } })
  let live = true
  const state = { roles: { center: { sessionId: parent.session.id, workspaceId: 'workspace', workspacePath: 'C:/fixture', agentPreset: ROLE_PRESETS.center } }, roleBindingRevisions: { center: '7' } }
  const document = { version: 1, id: 'workflow', title: 'Workflow', confirmed: true,
    nodes: [{ id: 'task', kind: 'agent', agent: 'product', title: 'Task', instruction: 'Bounded stored task' }], edges: [] }
  const agents = { set(id, agent) { assert.equal(ctx.agents.get(id), agent) } }
  const visibleAgents = { get: id => live ? ctx.agents.get(id) : undefined }
  await ctx.plugin(authorityPlugin)
  const authority = ctx.nativeTaskAuthority
  ctx.provide('workspaceRegistry', { archivedSessionIds: [], get: id => id === 'workspace' ? { id, path: 'C:/fixture', sessionIds: [parent.session.id, 'new-center-session'] } : undefined })
  ctx.provide('sessionQuery', { async observeSession(id) { return { header: { id, cwd: 'C:/fixture' }, projections: { values: { agentPreset: ROLE_PRESETS.center } }, [Symbol.dispose]() {} } } })
  const start = { id: 'fixture-child', runId: 'fixture-native-run', provider: 'spawn', local: true }
  const end = { ...start, stopReason, lastAssistantMessage: [{ type: 'text', text: 'fixture completed output' }] }
  const interrupts = []
  ctx.provide('subagents', { interrupt(id, authority) { interrupts.push({ id, authority }); ctx.emit('subagent/end', { ...end, stopReason: 'aborted' }) } })
  let spawns = 0
  const spawnArguments = []
  tools.register({ name: 'subagent', description: 'offline synthetic child only', parameters: { type: 'object', properties: { description: { type: 'string' }, prompt: { type: 'string' }, agent_preset: { type: 'string', enum: [ROLE_PRESETS.product] },
    ...(modelSelection ? { provider: { type: 'string' }, model: { type: 'string' } } : {}) } },
    output: { schema: { type: 'object', properties: { kind: { type: 'string' }, subagentId: { type: 'string' } }, required: ['kind', 'subagentId'], additionalProperties: false }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
    execute(_args, exec) {
      spawns++
      spawnArguments.push(structuredClone(_args))
      assert.equal(exec.agent, parent)
      assert.equal(typeof exec.deferContext, 'function')
      if (mode === 'tool-error') throw Object.assign(new Error('synthetic tool rejected'), { code: 'TOOL_POLICY_DENIED' })
      const child = document.nodes.length === 1 ? start : { ...start, id: `fixture-child-${spawns}`, runId: `fixture-run-${spawns}` }
      ctx.emit('subagent/start', child)
      if (mode === 'complete') ctx.emit('subagent/end', { ...end, ...child })
      return { kind: 'activation', subagentId: child.id }
    },
  })
  const rows = new Map()
  const store = {
    async get(id) { return structuredClone(rows.get(id) ?? null) },
    async list() { return [...rows.values()].map(({ id, status }) => ({ id, status })) },
    async save(snapshot, revision) {
      assert.equal(rows.get(snapshot.id)?.revision ?? 0, revision)
      rows.set(snapshot.id, structuredClone(snapshot)); return structuredClone(snapshot)
    },
  }
  const definitions = new Map([['workflow', document]])
  const service = createWorkflowNativeService({ ctx, readState: async () => state, definitionStore: { get: async id => structuredClone(definitions.get(id) ?? null) }, runStore: store, taskAuthority: authority, timeoutMs: 150 })
  registerWorkflowNativeTools(ctx, service, { preset: ROLE_PRESETS.center })
  const executions = []
  ctx.on('tools/pre-execute', (exec, next) => { executions.push(exec); return next() })
  // Wrapper only adds the public connection service; tools is the genuine SDK.
  let resolves = 0
  const sessionController = { async resolveAgent(id) { resolves++; return { error: { code: 'session/not-found' } } } }
  const handler = createWorkflowNativeUiHandler({ connection: { requestRejection: () => rejection }, get: key => ctx.get(key), agents: visibleAgents, tools, sessionController, nativeTaskAuthority: authority },
    { readState: async () => state, resolveProfileNamespace: async () => 'C:/owned-fixture-home' })
  async function request(body, options = {}) {
    const req = Readable.from([Buffer.from(options.raw ?? JSON.stringify(body))]); req.method = options.method ?? 'POST'
    const res = new EventEmitter(); res.headers = {}; res.setHeader = (k, v) => { res.headers[k] = v }
    res.end = text => { res.writableEnded = true; res.body = text }
    options.onCreate?.(req, res)
    await handler(req, res)
    return { status: res.statusCode, value: JSON.parse(res.body), req, res }
  }
  async function prepared() {
    const response = await request({ action: 'prepare', workflowId: 'workflow' })
    assert.equal(response.status, 200, JSON.stringify(response.value))
    return response.value.prepared
  }
  const submit = (p, operationId = 'operation-1', extra = {}) => request({ action: 'submit', workflowId: 'workflow', operationId, expectedDefinitionRevision: p.definitionRevision, expectedBindingRevision: p.bindingRevision, confirm: true, ...extra })
  return { ctx, tools, parent, agents, definitions, service, rows, store, state, document, executions, request, prepared, submit, interrupts, sessionController, spawnArguments,
    get resolves() { return resolves }, get spawns() { return spawns }, offline: () => { live = false }, online: () => { live = true } }
}

test('real SDK UI prepare/get support a persisted DAG and per-node receipts never mix attempts', async t => {
  const f = await fixture(t)
  f.document.nodes.push({ id: 'next', kind: 'agent', agent: 'product', title: 'Next', instruction: 'Next stored task' })
  f.document.edges.push({ from: 'task', to: 'next' })
  const prepared = await f.prepared()
  assert.equal(prepared.graph.nodeCount, 2); assert.equal(prepared.graph.edgeCount, 1)
  assert.deepEqual(prepared.graph.roleIds, ['product'])
  assert.equal(prepared.center.sessionId, f.parent.session.id)
  assert.equal(Object.hasOwn(prepared, 'node'), false)
  const submitted = await f.submit(prepared)
  assert.equal(submitted.status, 202)
  await f.service.drain()
  const read = await f.request({ action: 'get', runId: submitted.value.submission.runId })
  assert.equal(read.status, 200)
  assert.deepEqual(read.value.run.nodes.map(node => [node.id, node.succeeded]), [['task', true], ['next', true]], JSON.stringify(f.rows.get(submitted.value.submission.runId)))
  const raw = structuredClone(f.rows.get(submitted.value.submission.runId))
  raw.nodes.next.attempt = 2
  const projected = projectNativeWorkflowRun(raw)
  assert.equal(projected.nodes[0].settled, true); assert.equal(projected.nodes[1].settled, false)
  assert.equal(projected.succeeded, false)
  assert.ok(f.spawnArguments[1].prompt.includes('fixture completed output'))
  assert.equal(read.value.run.nodes[1].roleId, 'product')
  assert.equal(read.value.run.nodes[1].agentPreset, ROLE_PRESETS.product)
})

test('UI prepare and projection expose mixed local controls without native or artifact receipts', async t => {
  const f = await fixture(t)
  f.document.nodes = [
    { id: 'input', kind: 'input', title: 'Input', instruction: 'Exact local input' },
    { id: 'task', kind: 'agent', agent: 'product', title: 'Task', instruction: 'Process input' },
    { id: 'output', kind: 'output', title: 'Output', instruction: 'Not used as output content' },
  ]
  f.document.edges = [{ from: 'input', to: 'task' }, { from: 'task', to: 'output' }]
  const prepared = await f.prepared()
  assert.deepEqual(prepared.graph.nodes.map(node => node.kind ?? 'agent'), ['input', 'agent', 'output'])
  assert.deepEqual(prepared.graph.roleIds, ['product'])
  assert.equal(prepared.graph.nodeCount, 3)

  const submitted = await f.submit(prepared)
  assert.equal(submitted.status, 202)
  await f.service.drain()
  const response = await f.request({ action: 'get', runId: submitted.value.submission.runId })
  assert.equal(response.status, 200)
  const [input, agent, output] = response.value.run.nodes
  assert.equal(input.kind, 'input')
  assert.equal(input.executionSource, 'workflow/local')
  assert.equal(input.output, 'Exact local input')
  assert.equal(input.terminalReceipt.source, 'workflow/local')
  assert.equal(agent.roleId, 'product')
  assert.equal(agent.terminalReceipt.source, 'subagent/end')
  assert.equal(output.kind, 'output')
  assert.equal(output.executionSource, 'workflow/local')
  assert.equal(output.output, 'fixture completed output')
  assert.equal(output.artifactState, 'unknown')
  assert.equal(output.terminalReceipt.source, 'workflow/local')
  assert.equal(response.value.run.succeeded, true)
  assert.equal(f.spawns, 1)

  const raw = structuredClone(f.rows.get(submitted.value.submission.runId))
  const corruptions = [
    value => { value.nodes.input.output = 'spoofed local output'; value.nodes.input.localReceipt.output = 'spoofed local output' },
    value => { value.nodes.input.localReceipt.childId = 'fake-child' },
    value => { value.nodes.input.artifactSource = 'deliverables/presented'; value.nodes.input.artifacts = [{ id: 'fake' }] },
    value => { value.nodes.task.localReceipt = structuredClone(value.nodes.input.localReceipt) },
  ]
  for (const corrupt of corruptions) {
    const tampered = structuredClone(raw)
    corrupt(tampered)
    assert.throws(() => projectNativeWorkflowRun(tampered), { code: 'submission_unverified' })
  }
  const whitespaceIdentity = structuredClone(raw)
  whitespaceIdentity.nodes.task.requestId = '   '
  const agentTerminal = whitespaceIdentity.events.findLast(event => event.type === 'node-terminal' && event.nodeId === 'task')
  agentTerminal.requestId = '   '
  assert.throws(() => verifiedWorkflowParent(whitespaceIdentity, whitespaceIdentity.document.nodes.find(node => node.id === 'task')),
    { code: 'upstream_terminal_unverified' })
})

test('review prepare keeps review_unavailable as a 503 and creates no run when question provider is absent', async t => {
  const f = await fixture(t)
  f.document.nodes = [
    { id: 'review', kind: 'review', title: 'Review', instruction: 'Approve or reject' },
    { id: 'task', kind: 'agent', agent: 'product', title: 'Task', instruction: 'Continue after review' },
  ]
  f.document.edges = [{ from: 'review', to: 'task' }]
  const response = await f.request({ action: 'prepare', workflowId: 'workflow' })
  assert.equal(response.status, 503)
  assert.equal(response.value.error_code, 'review_unavailable')
  assert.equal(f.rows.size, 0)
  assert.equal(f.spawns, 0)
})
test('review UI projects deferred and rejected states separately from native and artifact evidence', async t => {
  const f = await fixture(t)
  f.document.nodes = [
    { id: 'task', kind: 'agent', agent: 'product', title: 'Task', instruction: 'Produce a result' },
    { id: 'review', kind: 'review', title: 'Review', instruction: 'Approve or reject' },
    { id: 'output', kind: 'output', title: 'Output', instruction: 'Ignored' },
  ]
  f.document.edges = [{ from: 'task', to: 'review' }, { from: 'review', to: 'output' }]
  let askCount = 0
  f.ctx.userQuestions = { async ask({ questions }) {
    askCount++
    return askCount === 1
      ? { answers: [{ id: questions[0].id, selected: [], custom: '批准' }] }
      : { answers: [{ id: questions[0].id, selected: ['拒绝'], custom: undefined }] }
  } }

  const prepared = await f.request({ action: 'prepare', workflowId: 'workflow' })
  const submitted = await f.submit(prepared.value.prepared)
  assert.equal(submitted.status, 202)
  await f.service.drain()
  const deferred = await f.request({ action: 'get', runId: submitted.value.submission.runId })
  const deferredReview = deferred.value.run.nodes.find(node => node.id === 'review')
  assert.equal(deferredReview.executionSource, 'dsh-user-questions')
  assert.equal(deferredReview.status, 'waiting')
  assert.equal(deferredReview.reviewStatus, 'deferred')
  assert.equal(deferredReview.error, 'review_answer_invalid')
  assert.equal(deferredReview.settled, false)
  assert.equal(deferredReview.attempt, 0)
  assert.equal(deferredReview.artifactEvidence, null)

  const planResponse = await f.request({ action: 'prepare_resume', runId: submitted.value.submission.runId })
  assert.equal(planResponse.status, 200)
  const plan = planResponse.value.preparedResume
  const resumed = await f.request({ action: 'resume', runId: plan.runId, operationId: 'review-retry',
    expectedRunRevision: plan.expectedRunRevision, expectedDefinitionRevision: plan.definitionRevision,
    expectedBindingRevision: plan.bindingRevision, resumePlanHash: plan.resumePlanHash, confirm: true })
  assert.equal(resumed.status, 202)
  await f.service.drain()
  const rejected = await f.request({ action: 'get', runId: submitted.value.submission.runId })
  const rejectedReview = rejected.value.run.nodes.find(node => node.id === 'review')
  const output = rejected.value.run.nodes.find(node => node.id === 'output')
  assert.equal(rejectedReview.executionSource, 'dsh-user-questions')
  assert.equal(rejectedReview.status, 'failed')
  assert.equal(rejectedReview.reviewStatus, 'rejected')
  assert.equal(rejectedReview.error, 'review_rejected')
  assert.equal(rejectedReview.terminalReceipt.source, 'dsh-user-questions')
  assert.equal(rejectedReview.attempt, 0)
  assert.equal(rejectedReview.artifactEvidence, null)
  assert.equal(output.status, 'skipped')
  assert.equal(askCount, 2)
  assert.equal(f.spawns, 1, 'resume must not repeat the completed native child')
})
test('blocked descendants expose a verified journal skip receipt, never a fake child completion', async t => {
  const f = await fixture(t, { stopReason: 'failed' })
  f.document.nodes.push({ id: 'blocked', kind: 'agent', agent: 'product', title: 'Blocked', instruction: 'Not dispatched' })
  f.document.edges.push({ from: 'task', to: 'blocked' })
  const p = await f.prepared(); const submitted = await f.submit(p); await f.service.drain()
  const read = await f.request({ action: 'get', runId: submitted.value.submission.runId })
  assert.equal(read.status, 200)
  assert.equal(read.value.run.status, 'failed'); assert.equal(read.value.run.settled, true)
  const blocked = read.value.run.nodes[1]
  assert.equal(blocked.succeeded, false); assert.equal(blocked.childId, null)
  assert.equal(blocked.terminalReceipt.source, 'native-run-journal')
  assert.deepEqual(blocked.terminalReceipt.blockedBy, ['task'])
  assert.equal(f.spawns, 1)
})
test('actual SDK receives persisted provider/model pair only with public model selection schema', async t => {
  const rejected = await fixture(t)
  rejected.document.nodes[0].model = { provider: 'reviewed-provider', model: 'reviewed-model' }
  const denied = await rejected.request({ action: 'prepare', workflowId: 'workflow' })
  assert.equal(denied.status, 409); assert.equal(denied.value.error_code, 'unsupported_model_selection')
  assert.equal(rejected.spawns, 0)
  const f = await fixture(t, { modelSelection: true })
  f.document.nodes[0].model = { provider: 'reviewed-provider', model: 'reviewed-model' }
  const p = await f.prepared(); const submitted=await f.submit(p);assert.equal(submitted.status,202,JSON.stringify(submitted.value)); await f.service.drain()
  assert.equal(f.spawnArguments[0].provider, 'reviewed-provider'); assert.equal(f.spawnArguments[0].model, 'reviewed-model')
  assert.equal(f.spawnArguments[0].agent_preset, ROLE_PRESETS.product)
})
test('actual SDK resume HTTP requires confirmation and replays persisted claim without another child', async t => {
  const f = await fixture(t)
  const p = await f.prepared(); const submitted = await f.submit(p)
  await f.service.recover(); await f.service.drain() // Crash simulation before first attempt; no child observation forged.
  const runId = submitted.value.submission.runId
  const prepared = await f.request({ action: 'prepare_resume', runId })
  assert.equal(prepared.status, 200, JSON.stringify(prepared.value))
  const plan = prepared.value.preparedResume
  assert.equal(plan.eligible, true)
  const body = { action: 'resume', runId, operationId: 'resume-op', expectedRunRevision: plan.expectedRunRevision,
    expectedDefinitionRevision: plan.definitionRevision, expectedBindingRevision: plan.bindingRevision,
    resumePlanHash: plan.resumePlanHash, confirm: true }
  assert.equal((await f.request({ ...body, confirm: false })).status, 400)
  const accepted = await f.request(body)
  assert.equal(accepted.status, 202, JSON.stringify(accepted.value))
  await f.service.drain()
  const before = f.spawns
  const replay = await f.request(body)
  assert.equal(replay.status, 202, JSON.stringify(replay.value))
  assert.equal(replay.value.resumption.reused, true); assert.equal(f.spawns, before)
  assert.equal((await f.request({ ...body, expectedRunRevision: plan.expectedRunRevision + 1 })).status, 409)
})

for (const rejection of [401, 403]) {
  test(`HTTP authentication ${rejection} rejects before any SDK tools`, async t => {
    const f = await fixture(t, { rejection })
    const result = await f.request({ action: 'prepare', workflowId: 'workflow' })
    assert.equal(result.status, rejection); assert.equal(f.executions.length, 0); assert.equal(f.resolves, 0)
  })
}

test('HTTP rejects all low-level authority fields, invalid types and oversized input before any SDK tools', async t => {
  const f = await fixture(t)
  for (const key of ['agent', 'parent', 'sessionId', 'model', 'preset', 'toolName', 'authority', 'exec', 'pairedHost']) {
    assert.equal((await f.request({ action: 'prepare', workflowId: 'workflow', [key]: 'forged' })).status, 400)
  }
  assert.equal((await f.request({ action: 'submit', workflowId: 'workflow' })).status, 400)
  assert.equal((await f.request({}, { raw: 'x'.repeat(5000) })).status, 400)
  assert.equal(f.executions.length, 0)
})

test('absent live center is explicit and never creates a fake Agent', async t => {
  const f = await fixture(t); f.offline()
  const result = await f.request({ action: 'prepare', workflowId: 'workflow' })
  assert.equal(result.status, 409); assert.equal(result.value.error_code, 'center_session_not_live'); assert.equal(f.executions.length, 0)
})

test('cold center resolves through public controller and passes the exact registered Agent', async t => {
  const f = await fixture(t); f.offline()
  const ids = []
  f.sessionController.resolveAgent = async id => { ids.push(id); f.online(); return { agent: f.parent } }
  await f.prepared()
  assert.deepEqual(ids, [f.parent.id]); assert.equal(f.executions[0].agent, f.parent)
  assert.equal(f.spawns, 0)
})

test('already-live center never invokes resolver', async t => {
  const f = await fixture(t)
  f.sessionController.resolveAgent = () => { assert.fail('must not resolve live Agent') }
  await f.prepared()
})

for (const failure of ['error-result', 'throw', 'wrong-agent', 'wrong-session', 'unregistered']) {
  test(`cold center ${failure} refuses SDK dispatch with a fixed error`, async t => {
    const f = await fixture(t); f.offline()
    f.sessionController.resolveAgent = async () => {
      if (failure === 'throw') throw new Error('private URL/key must not escape')
      if (failure === 'error-result') return { error: { message: 'private URL/key' } }
      f.online()
      if (failure === 'wrong-agent') return { agent: { ...f.parent } }
      if (failure === 'wrong-session') { return { agent: { id: f.parent.id, session: { id: 'wrong' } } } }
      f.offline(); return { agent: f.parent }
    }
    const r = await f.request({ action: 'prepare', workflowId: 'workflow' })
    assert.equal(r.status, 409); assert.equal(r.value.error_code, 'center_session_not_live')
    assert.equal(f.executions.length, 0); assert.doesNotMatch(JSON.stringify(r.value), /private|URL|key/)
  })
}

for (const change of ['session', 'revision']) {
  test(`center ${change} change while public resolution awaits rejects before dispatch`, async t => {
    const f = await fixture(t); f.offline()
    let entered, finish
    const started = new Promise(resolve => { entered = resolve })
    const pending = new Promise(resolve => { finish = resolve })
    f.sessionController.resolveAgent = async () => { entered(); await pending; f.online(); return { agent: f.parent } }
    const response = f.request({ action: 'prepare', workflowId: 'workflow' })
    await started
    if (change === 'session') f.state.roles.center.sessionId = 'new-center'
    else f.state.roleBindingRevisions.center = '8'
    finish()
    const r = await response
    assert.equal(r.status, 409)
    assert.equal(r.value.error_code, change === 'session' ? 'center_binding_mismatch' : 'binding_revision_mismatch')
    assert.equal(f.executions.length, 0); assert.equal(f.spawns, 0)
  })
}

for (const action of ['prepare', 'submit', 'get', 'list', 'cancel']) {
  test(`unauthorized cold ${action} never activates center`, async t => {
    const f = await fixture(t, { rejection: 401 }); f.offline()
    f.sessionController.resolveAgent = () => { assert.fail('unauthorized activation') }
    assert.equal((await f.request({ action })).status, 401)
    assert.equal(f.executions.length, 0)
  })
}

for (const action of ['prepare', 'submit', 'cancel']) {
test(`${action} abort while cold resolution awaits reaches SDK with original signal and never dispatches service`, async t => {
  const f = await fixture(t); f.offline()
  let entered, finish, req
  const started = new Promise(resolve => { entered = resolve })
  const pending = new Promise(resolve => { finish = resolve })
  f.sessionController.resolveAgent = async () => { entered(); await pending; f.online(); return { agent: f.parent } }
  const body = action === 'cancel' ? { action, runId: '00000000-0000-4000-8000-000000000000', operationId: 'abort-cancel' }
    : action === 'submit' ? { action, workflowId: 'workflow', operationId: 'abort-submit', confirm: true, expectedDefinitionRevision: `sha256:${'0'.repeat(64)}`, expectedBindingRevision: '7' }
      : { action, workflowId: 'workflow' }
  const response = f.request(body, { onCreate(request) { req = request } })
  await started; req.emit('aborted'); finish()
  const result = await response
  assert.equal(result.status, 503); assert.equal(result.value.error_code, 'operation_aborted')
  assert.equal(f.executions.length, 0); assert.equal(f.rows.size, 0); assert.equal(f.spawns, 0)
})
}

for (const field of ['workspaceId', 'workspacePath', 'agentPreset']) {
  test(`trusted ${field} replacement during cold resolution increments revision and rejects`, async t => {
    const f = await fixture(t); f.offline()
    f.state.roleBindingRevisions = Object.fromEntries(Object.keys(ROLE_PRESETS).map(role => [role, role === 'center' ? '7' : '0']))
    f.sessionController.resolveAgent = async () => {
      replaceRoleBinding(f.state, 'center', { ...f.state.roles.center, [field]: 'changed' })
      f.online(); return { agent: f.parent }
    }
    const result = await f.request({ action: 'prepare', workflowId: 'workflow' })
    assert.equal(f.state.roleBindingRevisions.center, '8')
    assert.equal(result.status, 409); assert.equal(result.value.error_code, 'binding_revision_mismatch')
    assert.equal(f.executions.length, 0)
  })
}

test('HTTP prepare uses a genuine SDK-created exec and authoritative service DTO', async t => {
  const f = await fixture(t); const p = await f.prepared()
  assert.equal(p.eligible, true); assert.equal(p.executionMode, 'native_dsh')
  assert.deepEqual(p.center, { roleId: 'center', sessionId: f.parent.session.id, workspaceId: 'workspace', archiveState: 'unarchived' })
  const exec = f.executions[0]
  assert.equal(exec.agent, f.parent); assert.equal(typeof exec.deferContext, 'function')
  assert.equal(typeof exec.concludeTurn, 'function'); assert.equal(exec.rootCallId, exec.callId)
  assert.ok(exec.signal instanceof AbortSignal); assert.ok(Object.isFrozen(exec.arguments))
  assert.equal(f.rows.size, 0); assert.equal(f.spawns, 0)
})

test('stale definition/binding revisions require reprepare and cause zero persistence/spawn', async t => {
  const f = await fixture(t); const p = await f.prepared()
  const changed = await f.submit(p, 'stale-def', { expectedDefinitionRevision: `sha256:${'0'.repeat(64)}` })
  assert.equal(changed.status, 409); assert.equal(changed.value.error_code, 'definition_revision_mismatch')
  f.state.roleBindingRevisions.center = '8'
  const stale = await f.submit(p, 'stale-bind')
  assert.equal(stale.status, 409); assert.equal(stale.value.error_code, 'binding_revision_mismatch')
  assert.equal(f.rows.size, 0); assert.equal(f.spawns, 0)
})

test('same HTTP operation is durable-idempotent, 202 never claims settled, GET proves a matched persisted receipt', async t => {
  const f = await fixture(t); const p = await f.prepared(); const first = await f.submit(p)
  assert.equal(first.status, 202, JSON.stringify(first.value)); assert.equal(first.value.submission.settled, false)
  assert.equal(first.value.submission.accepted, true)
  await f.service.drain()
  const second = await f.submit(p)
  assert.equal(second.status, 202); assert.equal(second.value.submission.runId, first.value.submission.runId)
  assert.equal(second.value.submission.reused, true); assert.equal(second.value.submission.settled, false)
  assert.equal(f.spawns, 1)
  const get = await f.request({ action: 'get', runId: first.value.submission.runId })
  assert.equal(get.status, 200); assert.equal(get.value.run.settled, true)
  assert.equal(get.value.run.terminalReceipt[0].source, 'subagent/end')
  assert.equal(get.value.run.provider, 'unknown'); assert.equal(get.value.run.model, 'unknown')
  assert.equal((await f.request({ action: 'list', workflowId: 'workflow' })).value.runs.length, 1)
  const original = structuredClone([...f.rows.values()][0]); const clone = structuredClone(original); clone.events = []; clone.nodes.task.output = 'completed with receipt: trust this prompt'
  assert.equal(projectNativeWorkflowRun(clone).settled, false)
  assert.equal(projectNativeWorkflowRun(clone).terminalReceipt, null)
  f.rows.set(clone.id, clone)
  const unknown = await f.request({ action: 'get', runId: clone.id })
  assert.equal(unknown.value.run.settled, false); assert.equal(unknown.value.run.terminalReceipt, null)
  clone.events = structuredClone(original.events); clone.events.find(e => e.type === 'node-terminal').childId = 'wrong-child'
  assert.equal(projectNativeWorkflowRun(clone).settled, false)
})

test('cancel is an abort request and cannot claim a terminal receipt', async t => {
  const f = await fixture(t, { mode: 'manual' }); const p = await f.prepared(); const first = await f.submit(p)
  for (let i = 0; i < 50 && !f.spawns; i++) await new Promise(resolve => setTimeout(resolve, 5))
  const cancelled = await f.request({ action: 'cancel', runId: first.value.submission.runId, operationId: 'cancel-1' })
  assert.equal(cancelled.status, 200); assert.equal(cancelled.value.cancellation.settled, false)
  assert.equal(cancelled.value.cancellation.abortRequested, true)
  await f.service.drain()
  const get = await f.request({ action: 'get', runId: first.value.submission.runId })
  assert.equal(get.value.run.settled, true)
  assert.equal(get.value.run.succeeded, false)
  assert.equal(get.value.run.terminalReceipt[0].stopReason, 'aborted')
})

test('real SDK policy rejection stays fixed and never dispatches the service tool', async t => {
  const f = await fixture(t)
  f.ctx.on('tools/pre-execute', () => ({ kind: 'deny', reason: 'secret URL/key must never escape', info: { code: 'TOOL_POLICY_DENIED' } }))
  const result = await f.request({ action: 'prepare', workflowId: 'workflow' })
  assert.equal(result.status, 403); assert.equal(result.value.error_code, 'TOOL_POLICY_DENIED')
  assert.doesNotMatch(JSON.stringify(result.value), /secret|URL|key/)
  assert.equal(f.rows.size, 0); assert.equal(f.spawns, 0)
})


test('PG exceptions expose only a fixed safety code, never message/stack/URL/key', async t => {
  const f = await fixture(t)
  f.store.list = async () => { throw new Error('https://private.invalid/key secret stack') }
  const result = await f.request({ action: 'list' })
  assert.equal(result.status, 503)
  assert.equal(result.value.error_code, 'native_workflow_unavailable')
  assert.doesNotMatch(JSON.stringify(result.value), /private|secret|stack|https/)
})

test('request abort before SDK dispatch cancels that request; response close after acceptance does not cancel owned run', async t => {
  const f = await fixture(t, { mode: 'manual' }); const p = await f.prepared()
  const first = await f.submit(p)
  first.res.emit('close'); first.req.emit('aborted')
  for (let i = 0; i < 50 && !f.spawns; i++) await new Promise(resolve => setTimeout(resolve, 5))
  assert.equal(f.spawns, 1); assert.equal(f.interrupts.length, 0)
  f.ctx.emit('subagent/end', { id: 'fixture-child', runId: 'fixture-native-run', stopReason: 'completed', lastAssistantMessage: [] })
  await f.service.drain()
  assert.equal(f.rows.get(first.value.submission.runId).status, 'done')
  const second = await fixture(t)
  const ready = await second.prepared()
  const aborted = await second.request({ action: 'submit', workflowId: 'workflow', operationId: 'aborted-op', confirm: true,
    expectedDefinitionRevision: ready.definitionRevision, expectedBindingRevision: ready.bindingRevision },
  { onCreate(req) { second.ctx.on('tools/pre-execute', (_exec, next) => { req.emit('aborted'); return next() }) } })
  assert.equal(aborted.status, 503)
  assert.equal(second.rows.size, 0); assert.equal(second.spawns, 0)
})


for (const [stopReason, status] of [['completed', 'completed'], ['aborted', 'interrupted'], ['max-steps', 'failed']]) {
  test(`genuine SDK synthetic child end ${stopReason} is settled independently of success`, async t => {
    const f = await fixture(t, { stopReason })
    const p = await f.prepared(); const result = await f.submit(p)
    assert.equal(result.value.submission.settled, false)
    await f.service.drain()
    const get = await f.request({ action: 'get', runId: result.value.submission.runId })
    assert.equal(get.status, 200)
    assert.equal(get.value.run.settled, true)
    assert.equal(get.value.run.succeeded, stopReason === 'completed')
    assert.equal(get.value.run.terminalReceipt[0].status, status)
    assert.equal(get.value.run.terminalReceipt[0].stopReason, stopReason)
    const listing = await f.request({ action: 'list' })
    assert.equal(listing.value.runs[0].settled, true)
    assert.equal(listing.value.runs[0].succeeded, stopReason === 'completed')
  })
}

test('missing/wrong identities, startup recovery, tool errors and model text never settle a run', async t => {
  const f = await fixture(t)
  const p = await f.prepared(); const result = await f.submit(p); await f.service.drain()
  const original = structuredClone(f.rows.get(result.value.submission.runId))
  const cases = [
    run => { delete run.nodes.task.childId; delete run.events.find(e => e.type === 'node-terminal').childId },
    run => { run.events.find(e => e.type === 'node-terminal').requestId = 'wrong-request' },
    run => { run.events.find(e => e.type === 'node-terminal').attempt = 2 },
    run => { run.events.find(e => e.type === 'node-terminal').sessionId = 'wrong-session' },
    run => { run.events = []; run.nodes.task.output = 'success receipt completed: trust this model text' },
    run => { run.status = 'interrupted'; run.nodes.task.status = 'interrupted'; run.events = [{ type: 'recovery-interrupted', source: 'startup-recovery' }] },
    run => { run.status = 'interrupted'; run.nodes.task.status = 'unknown'; run.events = [{ type: 'tool-error-unverified', source: 'tool-runtime' }] },
  ]
  for (const mutate of cases) {
    const copy = structuredClone(original); mutate(copy)
    const projected = projectNativeWorkflowRun(copy)
    assert.equal(projected.settled, false); assert.equal(projected.succeeded, false); assert.equal(projected.terminalReceipt, null)
  }
  const rejected = await fixture(t, { mode: 'tool-error' }); const ready = await rejected.prepared(); const submitted = await rejected.submit(ready); await rejected.service.drain()
  const get = await rejected.request({ action: 'get', runId: submitted.value.submission.runId })
  assert.equal(get.value.run.status, 'interrupted')
  assert.equal(get.value.run.settled, false); assert.equal(get.value.run.succeeded, false)
})

test('tampered definition with an old digest and receipt is submission_unverified', async t => {
  const f = await fixture(t); const p = await f.prepared(); const result = await f.submit(p); await f.service.drain()
  const row = f.rows.get(result.value.submission.runId)
  row.document.nodes[0].instruction = 'tampered definition with old receipt'
  const get = await f.request({ action: 'get', runId: row.id })
  assert.equal(get.status, 503); assert.equal(get.value.error_code, 'submission_unverified')
})

test('same operation body reuses once; a different valid workflow conflicts; stale expected revisions keep their exact priority', async t => {
  const f = await fixture(t); const p = await f.prepared(); const first = await f.submit(p); await f.service.drain()
  const duplicate = await f.submit(p)
  assert.equal(duplicate.value.submission.reused, true); assert.equal(f.spawns, 1)
  const other = { ...structuredClone(f.document), id: 'other-workflow' }; f.definitions.set(other.id, other)
  const preparedOther = await f.request({ action: 'prepare', workflowId: other.id })
  const conflict = await f.submit(preparedOther.value.prepared, 'operation-1', { workflowId: other.id })
  assert.equal(conflict.status, 409); assert.equal(conflict.value.error_code, 'submission_identity_conflict')
  const staleDefinition = await f.submit(p, 'operation-1', { expectedDefinitionRevision: `sha256:${'0'.repeat(64)}` })
  assert.equal(staleDefinition.status, 409); assert.equal(staleDefinition.value.error_code, 'definition_revision_mismatch')
  const staleBinding = await f.submit(p, 'operation-1', { expectedBindingRevision: '0' })
  assert.equal(staleBinding.status, 409); assert.equal(staleBinding.value.error_code, 'binding_revision_mismatch')
  assert.equal(f.rows.size, 1); assert.equal(f.spawns, 1); assert.equal(first.status, 202)
})

test('a new current center cannot read/cancel old owner runs and lists only its own without redispatch', async t => {
  const f = await fixture(t); const p = await f.prepared(); const first = await f.submit(p); await f.service.drain()
  const { agent: next } = await f.ctx.agents.create({ sessionId: 'new-center-session', meta: { cwd: 'C:/fixture', agentPreset: ROLE_PRESETS.center } })
  f.agents.set(next.id, next); f.state.roles.center.sessionId = next.session.id; f.state.roleBindingRevisions.center = '8'
  const get = await f.request({ action: 'get', runId: first.value.submission.runId })
  assert.equal(get.status, 403); assert.equal(get.value.error_code, 'run_parent_mismatch')
  const cancel = await f.request({ action: 'cancel', runId: first.value.submission.runId, operationId: 'old-cancel' })
  assert.equal(cancel.status, 403); assert.equal(cancel.value.error_code, 'run_parent_mismatch')
  assert.deepEqual((await f.request({ action: 'list' })).value.runs, [])
  const prepared = await f.request({ action: 'prepare', workflowId: 'workflow' })
  assert.equal(prepared.value.prepared.center.sessionId, next.session.id)
  assert.equal(f.rows.size, 1); assert.equal(f.spawns, 1)
})


test('same op with newly prepared valid definition/binding revisions conflicts with the original persisted submission', async t => {
  const f = await fixture(t); const p = await f.prepared(); const submitted=await f.submit(p);assert.equal(submitted.status,202,JSON.stringify(submitted.value)); await f.service.drain()
  f.document.title = 'Reconfirmed changed definition'
  const newDefinition = await f.prepared()
  assert.notEqual(newDefinition.definitionRevision, p.definitionRevision)
  const definitionConflict = await f.submit(newDefinition)
  assert.equal(definitionConflict.status, 409); assert.equal(definitionConflict.value.error_code, 'submission_identity_conflict')
  f.document.title = 'Workflow'
  f.state.roleBindingRevisions.center = '8'
  const newBinding = await f.prepared()
  assert.equal(newBinding.definitionRevision, p.definitionRevision)
  const bindingConflict = await f.submit(newBinding)
  assert.equal(bindingConflict.status, 409); assert.equal(bindingConflict.value.error_code, 'submission_identity_conflict')
  assert.equal(f.rows.size, 1); assert.equal(f.spawns, 1)
})
