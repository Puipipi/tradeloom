import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { gunzipSync } from 'node:zlib'
import { createWorkflowNativeService } from '../workflow-native-service.js'
import { createWorkflowRunJournal } from '../workflow-run-journal.js'
import { createWorkflowReviewDecisionChannel } from '../workflow-review.js'
import { verifiedReviewOutput } from '../workflow-review.js'
import { verifiedWorkflowParent } from '../workflow-local-nodes.js'
import { createWorkflowNativeBindingResolver } from '../workflow-native-binding.js'
import { HOME_MARKER, HOME_MARKER_VALUE, resolveOwnedHome } from '../state.js'
import { createConfirmedWorkflowDefinition } from '../workflow-definition.js'
import { ROLE_PRESETS } from '../roles.js'

const clone = value => structuredClone(value)
const LEGACY_AGENT_FIXTURE_GZIP = 'H4sIAAAAAAAACu1X227bOBD9FWOepVaSZTvWW5AFFgW2QJHs0xbBgibHNhuJdMmh08DwvxcUJdpJvEkap+i2jWDIJoeXmXMOh+MNfNLOKFZf8CU2DCogwwTWWjdvFCO5xtQ4lXaD3q5zSEAKqCDvnrR9lf510jf7BxK41uZqXuvrd35OjQvGb1LfhgRIUo1QwV9t74AtUNHgj9M/IQH8gtyR1Oq9Fn5I8ORfYZeQgCVGzkIFxikl1QISMLiWVmoF1bi1G0JxSlBBkRXjNM/TbPJ3llXt502WZf9AAnOppF2GccrVdQJCc9egIqg2wLWaS9OggIqMwwQEWm7kitpdwPsoFmih+riBudENVLBixk9OgDRUwJeyFrC97OC6HbrSopvbRu0nGy0cpx7duJZUlozj3bYf2lE4COaBdrRyftSVVH5WWCyBRgus+6hW2sowfQNfoCqzBG7813bHwIew2zb5T39CNHfdOdOKpHI48AgMos/f4E1xcsCdswid1c5w39Uw5Vj9sGjWaIIG8m1EeNMjWW12uhFaISTQoddzcw9UNEabwDUjwmZFUOXx9wUx8o4Qmkaq1jeDnx1a2pd6WDPt53tt6PqM1XU7yDfSCFuL8buI9s4Q1H/uVGvsTmW0MkNyzjh5PV3umhc9dE5dKX2tYNvtcAuK3RGKaDw5csb9wrU/B+Jw9CGOh4LvdXU39r7/YOi98cmRbw96Z92skd6tAOWpl1JwARWh2SFs0Xph7du6LkhgJpWQanEeMxBMwGcLn1680PcMdsmK0bialOPZSVaM+GSYT2YlZyWfTtlIZGI4GuIUR5PxuCjK+XxeFJPZVOBwxMazUV5Oi9nwpJx6gtaoKCQQ6wNTPt48AbpZYWA15QYZtcSwRxLhQ9D06btn4IlZ358+Pz6c+aih0PwhiB3F8b5uQwxRr6F5S6ahK6au+7foNx3afYaLyHAHadrddc9j+V5yOpLt3a21nzV+T7pDBaPN4XrlefQPI/1dYuVXr8R/L+Jf5nKOsmhXM06RbPDZAiijADzy6V7p8SqCn0EE1s3agvUtKrGfGLqC1JJenSOzLRpcN6saQ25v67EzRrjQ5qbPOI+Vr8+T2Ohlr5i7FeCxGoul3y8jsf/TBTN+qQvmlfanZZaj/v4cfbdcbr8CBXg2sf4RAAA='
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
async function fixture({ nodes, edges = [], answer = null, askError = null, provider = true, output = 'verified output', withTaskAuthority = false }) {
  const root = await fs.mkdtemp(join(tmpdir(), 'tradeloom-o08-owned-home-'))
  const ownedHome = join(root, 'owned-home')
  const runDirectory = join(ownedHome, 'workflow-runs')
  await fs.mkdir(runDirectory, { recursive: true })
  await fs.writeFile(join(ownedHome, HOME_MARKER), HOME_MARKER_VALUE, 'utf8')
  const resolvedOwnedHome = await resolveOwnedHome({ TRADELOOM_DSH_APP_HOME: ownedHome, DSH_HOME: ownedHome })
  assert.equal(resolvedOwnedHome, ownedHome)
  // This is a synthetic, file-backed runStore under a temporary owned-home, not the production PG adapter.
  const hostScope = scope(), parentScope = scope(), listeners = new Map(), children = new Map()
  const parent = { id: 'center-session', session: { id: 'center-session' }, ctx: {
    ...parentScope,
    on(name, callback) { const set = listeners.get(name) ?? new Set(); set.add(callback); listeners.set(name, set); return () => set.delete(callback) },
  } }
  const emit = (name, value) => { for (const callback of listeners.get(name) ?? []) callback(value) }
  const document = { version: 1, id: 'workflow', title: 'Workflow', confirmed: true, nodes: clone(nodes), edges: clone(edges) }
  const state = { roles: { center: { sessionId: parent.session.id, workspaceId: 'workspace', workspacePath: root, agentPreset: ROLE_PRESETS.center } }, roleBindingRevisions: { center: '7' } }
  let dispatches = 0
  const prompts = []
  const writes = []
  const filePath = id => join(runDirectory, `${id}.json`)
  const runStore = {
    pathFor: filePath,
    async get(id) { try { return JSON.parse(await fs.readFile(filePath(id), 'utf8')) } catch (error) { if (error.code === 'ENOENT') return null; throw error } },
    async list({ activeOnly = false } = {}) {
      const names = await fs.readdir(runDirectory)
      const rows = await Promise.all(names.filter(name => name.endsWith('.json')).map(name => this.get(name.slice(0, -5))))
      return rows.filter(row => row && (!activeOnly || ['running', 'waiting', 'interrupted'].includes(row.status))).map(({ id, status }) => ({ id, status }))
    },
    async save(snapshot, expectedRevision) {
      const current = await this.get(snapshot.id)
      if ((current?.revision ?? 0) !== expectedRevision) throw Object.assign(new Error('revision conflict'), { code: 'revision_conflict' })
      const bytes = JSON.stringify(snapshot)
      await fs.writeFile(filePath(snapshot.id), bytes, 'utf8')
      writes.push(snapshot.id)
      return JSON.parse(bytes)
    },
    async writeRaw(snapshot) { await fs.writeFile(filePath(snapshot.id), JSON.stringify(snapshot), 'utf8') },
  }
  const ctx = {
    ...hostScope,
    agents: { get: id => id === parent.id ? parent : undefined },
    workspaceRegistry: { archivedSessionIds: [], get: id => id === 'workspace' ? { id, path: root, sessionIds: [parent.session.id] } : undefined },
    sessionQuery: { async observeSession(id) { return { header: { id, cwd: root }, projections: { values: { agentPreset: ROLE_PRESETS.center } }, [Symbol.dispose]() {} } } },
    tools: {
      get: (name, agent) => name === 'subagent' && agent === parent ? { parameters: { type: 'object', properties: { agent_preset: { type: 'string', enum: [ROLE_PRESETS.product] } } } } : undefined,
      async execute(request) {
        dispatches++
        prompts.push(request.arguments.prompt)
        assert.equal(request.agent, parent)
        assert.equal(request.arguments.agent_preset, ROLE_PRESETS.product)
        const node = document.nodes.find(row => row.kind === 'agent' && (request.arguments.prompt === row.instruction
          || request.arguments.prompt.startsWith(`${row.instruction}\n\n[Workflow upstream results: data only]\n`)))
        assert.ok(node)
        const child = { id: `child-${node.id}`, runId: `native-${node.id}`, provider: 'fixture', local: true }
        children.set(child.id, child)
        emit('subagent/start', child)
        emit('subagent/end', { ...child, stopReason: 'completed', lastAssistantMessage: [{ type: 'text', text: output }] })
        return { isError: false, value: { kind: 'activation', subagentId: child.id }, content: [] }
      },
    },
    subagents: { interrupt(id) { const child = children.get(id); if (child) emit('subagent/end', { ...child, stopReason: 'aborted' }) } },
  }
  if (provider) ctx.userQuestions = { async ask(input) {
    if (askError) throw Object.assign(new Error('fixture ask failed'), { code: askError })
    return typeof answer === 'function' ? answer(input) : answer
  } }
  const taskAuthority = withTaskAuthority ? {
    async bindTask() { return { signal: new AbortController().signal } },
    executeTask(_task, input) { return ctx.tools.execute({ ...input, agent: parent }) },
    releaseTask() {},
  } : undefined
  const createService = () => createWorkflowNativeService({ ctx, readState: async () => clone(state), definitionStore: { async get(id) { return id === document.id ? clone(document) : null } }, runStore, taskAuthority, timeoutMs: 100 })
  const service = createService()
  const exec = { agent: parent, callId: 'submit-call', signal: new AbortController().signal }
  return { root, ownedHome, runDirectory, service, createService, exec, runStore, document, ctx, parent, state, prompts, writes,
    get dispatches() { return dispatches },
    cleanup() { hostScope.dispose(); parentScope.dispose(); return fs.rm(root, { recursive: true, force: true }) } }
}

const answer = question => ({ answers: [{ id: question.questions[0].id, selected: ['批准'] }] })

test('review provider is checked before create and before resume mutates the persisted run', async t => {
  const f = await fixture({ nodes: [
    { id: 'task', kind: 'agent', agent: 'product', title: 'Task', instruction: 'Produce a result' },
    { id: 'review', kind: 'review', title: 'Review', instruction: 'Confirm it' },
  ], edges: [{ from: 'task', to: 'review' }], provider: false })
  t.after(() => f.cleanup())
  await assert.rejects(f.service.prepare({ workflowId: 'workflow' }, f.exec), { code: 'review_unavailable' })
  await assert.rejects(f.service.submit({ workflowId: 'workflow' }, f.exec), { code: 'review_unavailable' })
  assert.equal((await fs.readdir(f.runDirectory)).length, 0)

  f.ctx.userQuestions = { async ask() { throw Object.assign(new Error('unavailable'), { code: 'ASK_UNAVAILABLE' }) } }
  const submitted = await f.service.submit({ workflowId: 'workflow' }, { ...f.exec, callId: 'defer-review' })
  await f.service.drain()
  const drained = await f.service.drain()
  const stored = await f.runStore.get(submitted.runId)
  assert.ok(stored, JSON.stringify({ submitted, drained, files: await fs.readdir(f.runDirectory) }))
  assert.equal(stored.nodes.review.reviewState.status, 'deferred')
  const rawBefore = await fs.readFile(f.runStore.pathFor(submitted.runId))
  delete f.ctx.userQuestions
  await assert.rejects(f.service.prepare_resume({ runId: submitted.runId }, f.exec), { code: 'review_unavailable' })
  await assert.rejects(f.service.resume({ runId: submitted.runId, expectedRunRevision: stored.revision,
    expectedDefinitionRevision: stored.definitionRevision, expectedBindingRevision: stored.bindingRevision,
    resumePlanHash: `sha256:${'a'.repeat(64)}`, confirm: true }, f.exec), { code: 'review_unavailable' })
  assert.deepEqual(await fs.readFile(f.runStore.pathFor(submitted.runId)), rawBefore)

  const previousQuestionId = stored.nodes.review.reviewState.request.questionId
  f.ctx.userQuestions = { async ask(question) { return answer(question) } }
  const prepared = await f.service.prepare_resume({ runId: submitted.runId }, f.exec)
  assert.equal(prepared.eligible, true)
  assert.ok(prepared.eligibleNodeIds.includes('review'))
  const resumeExec = { ...f.exec, callId: 'resume-deferred-review' }
  const resumeInput = { runId: submitted.runId, expectedRunRevision: prepared.expectedRunRevision,
    expectedDefinitionRevision: prepared.definitionRevision, expectedBindingRevision: prepared.bindingRevision,
    resumePlanHash: prepared.resumePlanHash, confirm: true }
  const staleBytes = await fs.readFile(f.runStore.pathFor(submitted.runId))
  await assert.rejects(f.service.resume({ ...resumeInput, expectedRunRevision: resumeInput.expectedRunRevision + 1 }, resumeExec), { code: 'resume_revision_conflict' })
  assert.deepEqual(await fs.readFile(f.runStore.pathFor(submitted.runId)), staleBytes)
  const resumed = await f.service.resume(resumeInput, resumeExec)
  assert.equal(resumed.scheduled, true)
  await f.service.drain()
  const finished = await f.runStore.get(submitted.runId)
  assert.equal(finished.status, 'done')
  assert.equal(f.dispatches, 1)
  assert.equal(finished.events.filter(event => event.type === 'review-node-waiting').length, 2)
  assert.notEqual(finished.nodes.review.reviewState.request.questionId, previousQuestionId)
  assert.deepEqual(finished.events.slice(0, stored.events.length), stored.events)
  const eventsBeforeReplay = finished.events.length
  const replay = await f.service.resume(resumeInput, resumeExec)
  assert.equal(replay.reused, true)
  assert.equal(f.dispatches, 1)
  assert.equal((await f.runStore.get(submitted.runId)).events.length, eventsBeforeReplay)
})

test('recovered waiting review resumes through a new service without replaying the completed agent', async t => {
  let answerEntered, resolveFirstAnswer, firstQuestionId
  const entered = new Promise(resolve => { answerEntered = resolve })
  const f = await fixture({ nodes: [
    { id: 'task', kind: 'agent', agent: 'product', title: 'Task', instruction: 'Produce a result' },
    { id: 'review', kind: 'review', title: 'Review', instruction: 'Confirm it' },
    { id: 'output', kind: 'output', title: 'Output', instruction: '' },
  ], edges: [{ from: 'task', to: 'review' }, { from: 'review', to: 'output' }], answer: question => {
    firstQuestionId = question.questions[0].id
    answerEntered()
    return new Promise(resolve => { resolveFirstAnswer = resolve })
  } })
  t.after(() => f.cleanup())
  const submitted = await f.service.submit({ workflowId: 'workflow' }, f.exec)
  await Promise.race([entered, new Promise((_, reject) => setTimeout(() => reject(new Error('review provider was not reached')), 2000))])
  const beforeRecovery = await f.runStore.get(submitted.runId)
  assert.equal(beforeRecovery.nodes.task.status, 'done')
  assert.equal(beforeRecovery.nodes.review.reviewState.status, 'waiting')
  const oldEvents = clone(beforeRecovery.events)
  const recovery = await createWorkflowRunJournal({ store: f.runStore }).recoverInterruptedRuns()
  assert.equal(recovery.recovered.length, 1)
  const interrupted = await f.runStore.get(submitted.runId)
  assert.equal(interrupted.nodes.review.reviewState.status, 'interrupted')
  assert.deepEqual(interrupted.events.slice(0, oldEvents.length), oldEvents)

  resolveFirstAnswer(answer({ questions: [{ id: firstQuestionId }] }))
  await f.service.drain()
  f.ctx.userQuestions = { async ask(question) { return answer(question) } }
  const restartedService = f.createService()
  const prepared = await restartedService.prepare_resume({ runId: submitted.runId }, f.exec)
  assert.equal(prepared.eligible, true)
  const resumeExec = { ...f.exec, callId: 'resume-recovered-review' }
  const resumeInput = { runId: submitted.runId, expectedRunRevision: prepared.expectedRunRevision,
    expectedDefinitionRevision: prepared.definitionRevision, expectedBindingRevision: prepared.bindingRevision,
    resumePlanHash: prepared.resumePlanHash, confirm: true }
  const rawBeforeStale = await fs.readFile(f.runStore.pathFor(submitted.runId))
  await assert.rejects(restartedService.resume({ ...resumeInput, expectedRunRevision: resumeInput.expectedRunRevision + 1 }, resumeExec), { code: 'resume_revision_conflict' })
  assert.deepEqual(await fs.readFile(f.runStore.pathFor(submitted.runId)), rawBeforeStale)
  const resumed = await restartedService.resume(resumeInput, resumeExec)
  assert.equal(resumed.scheduled, true)
  await restartedService.drain()
  const finished = await f.runStore.get(submitted.runId)
  assert.equal(finished.status, 'done')
  assert.equal(f.dispatches, 1)
  assert.equal(finished.events.filter(event => event.type === 'review-node-waiting').length, 2)
  assert.notEqual(finished.nodes.review.reviewState.request.questionId, firstQuestionId)
  assert.deepEqual(finished.events.slice(0, oldEvents.length), oldEvents)
  assert.equal(finished.nodes.output.output, 'verified output')
  const replay = await restartedService.resume(resumeInput, resumeExec)
  assert.equal(replay.reused, true)
  assert.equal((await f.runStore.get(submitted.runId)).events.length, finished.events.length)
})

test('input-agent-review-agent-output persists local/review receipts and verifies parent text in binding prompts', async t => {
  const f = await fixture({ nodes: [
    { id: 'input', kind: 'input', title: 'Input', instruction: 'Start from this text' },
    { id: 'task', kind: 'agent', agent: 'product', title: 'Task', instruction: 'Produce a result' },
    { id: 'review', kind: 'review', title: 'Review', instruction: 'Confirm the result' },
  { id: 'after-review', kind: 'agent', agent: 'product', title: 'After review', instruction: 'Use the approved result' },
    { id: 'output', kind: 'output', title: 'Output', instruction: '' },
], edges: [{ from: 'input', to: 'task' }, { from: 'task', to: 'review' }, { from: 'review', to: 'after-review' }, { from: 'after-review', to: 'output' }], answer })
  t.after(() => f.cleanup())
  const submitted = await f.service.submit({ workflowId: 'workflow' }, f.exec)
  const drained = await f.service.drain()
  assert.equal(drained[0].error, null, JSON.stringify({ drained, snapshot: await f.runStore.get(submitted.runId) }))
  const runPath = f.runStore.pathFor(submitted.runId)
  const persisted = JSON.parse(await fs.readFile(runPath, 'utf8'))
  assert.equal(persisted.status, 'done')
  assert.equal(f.dispatches, 2)
  assert.match(f.prompts[0], /Start from this text/)
  assert.match(f.prompts[1], /verified output/)
  assert.equal(persisted.nodes.output.output, 'verified output')
  assert.equal(persisted.nodes.output.localReceipt.attempt, 0)
  assert.equal(persisted.nodes.review.reviewState.receipt.source, 'dsh-user-questions')
  for (const id of ['review', 'output']) for (const key of ['requestId', 'toolCallId', 'childId', 'nativeRunId']) assert.equal(persisted.nodes[id][key], null)
  assert.deepEqual(persisted.nodes.review.artifacts, [])
  assert.equal(persisted.nodes.review.artifactSource, 'unknown')
  const inputNode = persisted.document.nodes.find(node => node.id === 'input')
  assert.equal(verifiedWorkflowParent(persisted, inputNode).text, 'Start from this text')
  const forgedLocal = clone(persisted)
  forgedLocal.nodes.input.localReceipt.output = 'forged input'
  assert.throws(() => verifiedWorkflowParent(forgedLocal, inputNode), { code: 'local_receipt_invalid' })
  const staleLocal = clone(persisted)
  staleLocal.bindingRevision = 'stale-binding'
  assert.throws(() => verifiedWorkflowParent(staleLocal, inputNode), { code: 'local_receipt_invalid' })
  const reviewNode = persisted.document.nodes.find(node => node.id === 'review')
  assert.equal(verifiedWorkflowParent(persisted, reviewNode, { verifyReviewParent: verifiedReviewOutput }).text, 'verified output')
  for (const identity of ['parentAgentId', 'sessionId', 'bindingRevision', 'definitionRevision']) {
    const stale = clone(persisted)
    stale[identity] = `${stale[identity]}-stale`
    assert.throws(() => verifiedWorkflowParent(stale, reviewNode, { verifyReviewParent: verifiedReviewOutput }), { code: 'review_receipt_invalid' })
  }
  const taskNode = persisted.document.nodes.find(node => node.id === 'task')
  assert.equal(verifiedWorkflowParent(persisted, taskNode).text, 'verified output')
  const untrustedArtifacts = clone(persisted)
  const taskEvent = untrustedArtifacts.events.findLast(event => event.type === 'node-terminal' && event.nodeId === 'task')
  taskEvent.artifactEvidence = { forged: true }
  untrustedArtifacts.nodes.task.artifactRangeStart = {}
  assert.deepEqual(verifiedWorkflowParent(untrustedArtifacts, taskNode).artifactReferences, [])
  const badParent = clone(persisted)
  badParent.events.findLast(event => event.type === 'node-terminal' && event.nodeId === 'task').sessionId = 'other-session'
  assert.throws(() => verifiedWorkflowParent(badParent, taskNode), { code: 'upstream_terminal_unverified' })
  const reopened = await createWorkflowRunJournal({ store: f.runStore }).open(submitted.runId)
  assert.deepEqual(reopened.getSnapshot(), persisted)

  async function bindingPrompt(run, nodeId) {
    run.status = 'running'
    run.finishedAt = null
    run.nodes[nodeId].status = 'running'
    run.nodes[nodeId].attemptState = 'started'
    run.nodes[nodeId].requestId = `attempt:${nodeId}:binding-test`
    run.nodes[nodeId].attempt = 1
    const resolver = createWorkflowNativeBindingResolver({ ctx: f.ctx, readState: async () => clone(f.state), loadRun: async () => clone(run) })
    return resolver({ workflowRunId: run.id, nodeId, attempt: 1, bindingRevision: run.bindingRevision,
      definitionRevision: run.definitionRevision }, { agent: f.parent, callId: `binding-${nodeId}` })
  }
  const inputParentRun = clone(persisted)
  assert.match((await bindingPrompt(inputParentRun, 'task')).prompt, /Start from this text/)
  const badInputReceipt = clone(persisted)
  badInputReceipt.nodes.input.localReceipt.output = 'tampered'
  await assert.rejects(bindingPrompt(badInputReceipt, 'task'), { code: 'local_receipt_invalid' })
  const reviewParentRun = clone(persisted)
  assert.match((await bindingPrompt(reviewParentRun, 'after-review')).prompt, /verified output/)
  const badReviewReceipt = clone(persisted)
  badReviewReceipt.nodes.review.reviewState.receipt.sessionId = 'other-session'
  await assert.rejects(bindingPrompt(badReviewReceipt, 'after-review'), { code: 'review_receipt_invalid' })
})

test('review rejection, invalid answer, abort and one-use decision proof persist distinct states', async t => {
  const makeNodes = () => [
    { id: 'task', kind: 'agent', agent: 'product', title: 'Task', instruction: 'Produce a result' },
    { id: 'review', kind: 'review', title: 'Review', instruction: 'Confirm the result' },
  ]
  const rejected = await fixture({ nodes: makeNodes(), edges: [{ from: 'task', to: 'review' }],
    answer: question => ({ answers: [{ id: question.questions[0].id, selected: ['拒绝'] }] }) })
  t.after(() => rejected.cleanup())
  const rejectedRun = await rejected.service.submit({ workflowId: 'workflow' }, rejected.exec)
  await rejected.service.drain()
  const rejectedSnapshot = await rejected.runStore.get(rejectedRun.runId)
  assert.equal(rejectedSnapshot.nodes.review.reviewState.status, 'rejected')
  assert.equal(rejectedSnapshot.nodes.review.error, 'review_rejected')

  const invalid = await fixture({ nodes: makeNodes(), edges: [{ from: 'task', to: 'review' }], answer: () => ({ answers: [] }) })
  t.after(() => invalid.cleanup())
  const invalidRun = await invalid.service.submit({ workflowId: 'workflow' }, invalid.exec)
  await invalid.service.drain()
  assert.equal((await invalid.runStore.get(invalidRun.runId)).nodes.review.reviewState.error, 'review_answer_invalid')

  const aborted = await fixture({ nodes: makeNodes(), edges: [{ from: 'task', to: 'review' }], askError: 'ASK_ABORTED' })
  t.after(() => aborted.cleanup())
  const abortedRun = await aborted.service.submit({ workflowId: 'workflow' }, aborted.exec)
  await aborted.service.drain()
  assert.equal((await aborted.runStore.get(abortedRun.runId)).nodes.review.reviewState.status, 'interrupted')

  const channel = createWorkflowReviewDecisionChannel()
  const request = { questionId: '9c6a0311-5328-43f2-a225-cd85eff8c96b', options: ['批准', '拒绝'] }
  const proof = channel.issue({ answers: [{ id: request.questionId, selected: ['批准'] }] }, request, new Date().toISOString())
  assert.ok(proof)
  assert.equal(channel.consume(proof, request).decision, 'approved')
  assert.throws(() => channel.consume(proof, request), { code: 'review_decision_untrusted' })
})

test('late answers after binding or definition changes become review_context_stale', async t => {
  for (const changed of ['binding', 'definition']) {
    let answerEntered, resolveAnswer, questionId
    const entered = new Promise(resolve => { answerEntered = resolve })
    const f = await fixture({ nodes: [
      { id: 'task', kind: 'agent', agent: 'product', title: 'Task', instruction: 'Produce a result' },
      { id: 'review', kind: 'review', title: 'Review', instruction: 'Confirm the result' },
    ], edges: [{ from: 'task', to: 'review' }], withTaskAuthority: true, answer: question => {
      questionId = question.questions[0].id
      answerEntered()
      return new Promise(resolve => { resolveAnswer = resolve })
    } })
    t.after(() => f.cleanup())
    const submitted = await f.service.submit({ workflowId: 'workflow' }, f.exec)
    await Promise.race([entered, new Promise((_, reject) => setTimeout(() => reject(new Error('review provider was not reached')), 2000))])
    if (changed === 'binding') f.state.roleBindingRevisions.center = '8'
    else f.document.nodes.find(node => node.id === 'review').instruction = 'Changed after question creation'
    resolveAnswer({ answers: [{ id: questionId, selected: ['批准'] }] })
    await f.service.drain()
    const snapshot = await f.runStore.get(submitted.runId)
    assert.equal(snapshot.nodes.review.reviewState.status, 'failed')
    assert.equal(snapshot.nodes.review.reviewState.error, 'review_context_stale')
  }
})

test('old 7e5 agent-only disk snapshot round-trips and recovers without changing its parent receipt; malformed local-shaped bytes are rejected untouched', async t => {
  const f = await fixture({ nodes: [
    { id: 'task', kind: 'agent', agent: 'product', title: 'Task', instruction: 'Fixture context only' },
  ] })
  t.after(() => f.cleanup())
  const legacyBytes = gunzipSync(Buffer.from(LEGACY_AGENT_FIXTURE_GZIP, 'base64'))
  assert.equal(createHash('sha256').update(legacyBytes).digest('hex'), 'c16d2f40e55e9248ae4de1066f12385aac2e2a8e50f5bd7cc8362388eadb2287')
  const legacy = JSON.parse(legacyBytes.toString('utf8'))
  assert.equal(legacy.journalSchema, 'tradeloom.native-run-journal/v1')
  assert.equal(legacy.status, 'running')
  assert.equal(legacy.nodes.parent.status, 'done')
  assert.equal(legacy.nodes.child.status, 'running')
  assert.equal(Object.hasOwn(legacy.nodes.parent, 'localReceipt'), false)
  assert.equal(Object.hasOwn(legacy.nodes.parent, 'reviewState'), false)
  await fs.writeFile(f.runStore.pathFor(legacy.id), legacyBytes)
  const rawBeforeOpen = await fs.readFile(f.runStore.pathFor(legacy.id))
  const journal = createWorkflowRunJournal({ store: f.runStore })
  const opened = await journal.open(legacy.id)
  assert.deepEqual(opened.getSnapshot(), legacy)
  assert.deepEqual(await fs.readFile(f.runStore.pathFor(legacy.id)), rawBeforeOpen)
  const parentReceipt = legacy.events.find(event => event.type === 'node-terminal' && event.source === 'subagent/end'
    && event.status === 'done' && event.nodeId === 'parent')
  assert.ok(parentReceipt)
  const recovered = await journal.recoverInterruptedRuns()
  assert.equal(recovered.recovered.length, 1)
  const after = await f.runStore.get(legacy.id)
  assert.equal(after.status, 'interrupted')
  assert.equal(after.revision, legacy.revision + 1)
  assert.deepEqual(after.events.slice(0, legacy.events.length), legacy.events)
  assert.deepEqual(after.nodes.parent, legacy.nodes.parent)
  assert.deepEqual(after.events.find(event => event.type === 'node-terminal' && event.source === 'subagent/end'
    && event.status === 'done' && event.nodeId === 'parent'), parentReceipt)
  assert.equal(after.nodes.child.status, 'interrupted')
  assert.equal(after.nodes.child.attemptState, 'interrupted')
  assert.equal(after.nodes.child.error, 'PROCESS_RESTARTED')
  assert.equal(after.nodes.child.requestId, legacy.nodes.child.requestId)
  assert.equal(after.nodes.child.toolCallId, legacy.nodes.child.toolCallId)
  assert.equal(after.nodes.child.childId, legacy.nodes.child.childId)
  assert.equal(after.nodes.child.nativeRunId, legacy.nodes.child.nativeRunId)
  assert.deepEqual(after.events.slice(legacy.events.length).map(event => [event.type, event.source]), [
    ['node-interrupted', 'startup-recovery'], ['run-interrupted', 'startup-recovery'],
  ])
  assert.equal(typeof after.finishedAt, 'string')
  assert.ok(Number.isFinite(Date.parse(after.finishedAt)))
  const comparable = value => {
    const copy = clone(value)
    delete copy.status; delete copy.revision; delete copy.finishedAt; delete copy.events
    for (const key of ['status', 'attemptState', 'error']) delete copy.nodes.child[key]
    return copy
  }
  assert.deepEqual(comparable(after), comparable(legacy))

  const invalid = clone(legacy)
  const invalidDefinition = createConfirmedWorkflowDefinition({ version: 1, id: 'legacy-input-flow', title: 'Legacy input flow', confirmed: true,
    nodes: [
      { id: 'input', kind: 'input', title: 'Input', instruction: 'Old data' },
      { id: 'task', kind: 'agent', agent: 'product', title: 'Task', instruction: 'Task' },
    ], edges: [{ from: 'input', to: 'task' }] })
  invalid.id = '22222222-2222-4222-8222-222222222222'
  invalid.workflowId = invalidDefinition.document.id
  invalid.title = invalidDefinition.document.title
  invalid.document = invalidDefinition.document
  invalid.definitionRevision = invalidDefinition.definitionRevision
  invalid.nodes = { input: clone(legacy.nodes.parent), task: clone(legacy.nodes.child) }
  invalid.nodes.input.status = 'done'
  invalid.nodes.input.attempt = 1
  invalid.nodes.input.requestId = 'legacy-input-attempt'
  invalid.nodes.input.toolCallId = 'legacy-input-tool'
  invalid.nodes.input.childId = 'legacy-input-child'
  invalid.nodes.input.nativeRunId = 'legacy-input-native'
  invalid.revision = 1
  invalid.status = 'running'
  const invalidRaw = Buffer.from(JSON.stringify(invalid))
  await f.runStore.writeRaw(invalid)
  const invalidRawBefore = await fs.readFile(f.runStore.pathFor(invalid.id))
  assert.deepEqual(invalidRawBefore, invalidRaw)
  await assert.rejects(journal.open(invalid.id), { code: 'invalid_local_node_state' })
  assert.deepEqual(await fs.readFile(f.runStore.pathFor(invalid.id)), invalidRawBefore)
})
