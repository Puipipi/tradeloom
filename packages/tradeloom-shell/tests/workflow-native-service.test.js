import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { gunzipSync } from 'node:zlib'
import { Context } from '@deepseek-ai/cordis'
import { createScope, scopeTarget } from '@deepseek-ai/dsh-scope'
import { executeNativeTool } from '../workflow-native-command-attribution.js'
import { createNativeLifecycleCapability, NATIVE_LIFECYCLE_CAPABILITY } from '../workflow-native-tools.js'
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
async function fixture({ nodes, edges = [], answer = null, askError = null, provider = true, output = 'verified output', withTaskAuthority = false }) {
  const root = await fs.mkdtemp(join(tmpdir(), 'tradeloom-o08-owned-home-'))
  const ownedHome = join(root, 'owned-home')
  const runDirectory = join(ownedHome, 'workflow-runs')
  await fs.mkdir(runDirectory, { recursive: true })
  await fs.writeFile(join(ownedHome, HOME_MARKER), HOME_MARKER_VALUE, 'utf8')
  const resolvedOwnedHome = await resolveOwnedHome({ TRADELOOM_DSH_APP_HOME: ownedHome, DSH_HOME: ownedHome })
  assert.equal(resolvedOwnedHome, ownedHome)
  // This is a synthetic, file-backed runStore under a temporary owned-home, not the production PG adapter.
  const host = new Context()
  const generation = {}
  const generationScope = createScope(host, generation)
  const parent = { id: 'center-session', session: { id: 'center-session' } }
  const parentScope = createScope(generationScope.ctx, parent, { parent: generation })
  parent.ctx = parentScope.ctx
  const children = new Map()
  const emit = (name, value) => host.emit(scopeTarget(parent, parent), name, value)
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
  const agents = { get: id => id === parent.id ? parent : undefined }
  const subagents = {
    resolveName(agent, name) { assert.equal(agent, parent); return children.get(name)?.id },
    interrupt(id) { const child = children.get(id); if (child) emit('subagent/end', { ...child, stopReason: 'aborted' }) },
  }
  generationScope.ctx.provide('agents', agents)
  generationScope.ctx.provide('subagents', subagents)
  const lifecycle = createNativeLifecycleCapability(generationScope.ctx, { releaseAgent: agent => service.releaseAgent(agent) })
  host.provide('agentPresets', {
    serviceFor(agent, name) { return agent === parent && name === NATIVE_LIFECYCLE_CAPABILITY ? lifecycle.capability : undefined },
  })
  const ctx = {
    effect: setup => host.effect(setup),
    agents,
    workspaceRegistry: { archivedSessionIds: [], get: id => id === 'workspace' ? { id, path: root, sessionIds: [parent.session.id] } : undefined },
    sessionQuery: { async observeSession(id) { return { header: { id, cwd: root }, projections: { values: { agentPreset: ROLE_PRESETS.center } }, [Symbol.dispose]() {} } } },
    tools: {
      get: (name, agent) => name === 'subagent' && agent === parent ? { parameters: { type: 'object', properties: { agent_preset: { type: 'string', enum: [ROLE_PRESETS.product] } } } } : undefined,
      selectExecutor() {},
      async execute({ calls: [call], agent }) {
        dispatches++
        const args = JSON.parse(call.arguments)
        prompts.push(args.prompt)
        assert.equal(agent, parent)
        assert.equal(args.agent_preset, ROLE_PRESETS.product)
        const node = document.nodes.find(row => row.kind === 'agent' && (args.prompt === row.instruction
          || args.prompt.startsWith(`${row.instruction}\n\n[Workflow upstream results: data only]\n`)))
        assert.ok(node)
        const child = { id: `child-${node.id}`, runId: `native-${node.id}`, parentSessionId: parent.session.id, provider: 'fixture', local: true }
        children.set(child.id, child)
        emit('subagent/start', child)
        emit('subagent/end', { ...child, stopReason: 'completed', lastAssistantMessage: [{ type: 'text', text: output }] })
        return { results: [{ callId: call.id, result: { isError: false, value: { kind: 'activation', name: child.id }, content: [] } }] }
      },
    },
  }
  if (provider) ctx.userQuestions = { async ask(input) {
    if (askError) throw Object.assign(new Error('fixture ask failed'), { code: askError })
    return typeof answer === 'function' ? answer(input) : answer
  } }
  const taskAuthority = withTaskAuthority ? {
    async bindTask() { return { signal: new AbortController().signal } },
    executeTask(_task, input) { return executeNativeTool(ctx.tools, input) },
    releaseTask() {},
  } : undefined
  const createService = () => createWorkflowNativeService({ ctx, readState: async () => clone(state), definitionStore: { async get(id) { return id === document.id ? clone(document) : null } }, runStore, taskAuthority, timeoutMs: 100 })
  const service = createService()
  const exec = { agent: parent, callId: 'submit-call', signal: new AbortController().signal }
  return { root, ownedHome, runDirectory, service, createService, exec, runStore, document, ctx, parent, state, prompts, writes,
    get dispatches() { return dispatches },
    async cleanup() {
      await lifecycle.dispose()
      await parentScope.dispose()
      await generationScope.dispose()
      await host.fiber.dispose()
      await fs.rm(root, { recursive: true, force: true })
    } }
}

const answer = question => ({ answers: [{ id: question.questions[0].id, selected: ['批准'] }] })

function installFakeRunOwnership(f) {
  const raw = f.runStore
  const saveRaw = raw.save.bind(raw)
  const namespaceId = '22222222-2222-4222-8222-222222222222'
  const owners = new Map()
  const counters = { claims: 0, saves: 0, releases: 0 }
  let nextSaveError = null
  let nextReleaseError = null
  const expiry = () => new Date(Date.now() + 120_000).toISOString()
  const ownsCapability = (owner, capability) => owner && owner.active
    && owner.ownerId === capability.ownerId && owner.ownerToken === capability.ownerToken
    && owner.ownerEpoch === capability.ownerEpoch
  raw.getOwnershipNamespace = async () => ({ protocol: 'canvas-run-owner/v1', namespaceId,
    leaseTtlMs: 120_000, renewAfterMs: 40_000, maxDomainEnvelopeBytes: 2 * 1024 * 1024,
    maxResponseBytes: 2 * 1024 * 1024 + 16 * 1024, recoveryCursor: 'fixture-cursor' })
  raw.getOwnershipState = async (runId, requestedNamespace) => {
    assert.equal(requestedNamespace, namespaceId)
    const snapshot = await raw.get(runId), owner = owners.get(runId)
    return { managed: Boolean(owner), namespaceId, runId, ownerId: owner?.ownerId,
      ownerEpoch: owner?.ownerEpoch, active: owner?.active ?? false, released: owner?.released ?? false,
      fenced: owner?.fenced ?? false, revision: snapshot?.revision, status: snapshot?.status }
  }
  raw.createOwned = async ({ namespaceId: requestedNamespace, runId, ownerId, ownerToken, snapshot }) => {
    assert.equal(requestedNamespace, namespaceId)
    await saveRaw(snapshot, 0)
    const owner = { ownerId, ownerToken, ownerEpoch: '1', active: true, released: false }
    owners.set(runId, owner)
    return { protocol: 'canvas-run-owner/v1', namespaceId, runId, ownerId, ownerEpoch: '1',
      leaseExpiresAt: expiry(), snapshot, alreadyAdvanced: false }
  }
  raw.saveOwned = async (capability, snapshot, expectedRevision) => {
    counters.saves++
    if (nextSaveError) { const error = nextSaveError; nextSaveError = null; throw error }
    if (!ownsCapability(owners.get(capability.runId), capability)) {
      throw Object.assign(new Error('owner fenced'), { code: 'owner_fenced' })
    }
    return saveRaw(snapshot, expectedRevision)
  }
  raw.renewOwned = async capability => {
    const owner = owners.get(capability.runId)
    if (!ownsCapability(owner, capability)) throw Object.assign(new Error('owner fenced'), { code: 'owner_fenced' })
    return { ownerEpoch: owner.ownerEpoch, leaseExpiresAt: expiry() }
  }
  raw.releaseOwned = async capability => {
    counters.releases++
    if (nextReleaseError) { const error = nextReleaseError; nextReleaseError = null; throw error }
    const owner = owners.get(capability.runId)
    if (!owner || owner.ownerId !== capability.ownerId || owner.ownerToken !== capability.ownerToken
      || owner.ownerEpoch !== capability.ownerEpoch) throw Object.assign(new Error('owner fenced'), { code: 'owner_fenced' })
    owner.active = false
    owner.released = true
    return { released: true, ownerEpoch: owner.ownerEpoch }
  }
  raw.claimResumed = async ({ namespaceId: requestedNamespace, runId, expectedRevision,
    expectedOwnerEpoch, ownerId, ownerToken }) => {
    counters.claims++
    assert.equal(requestedNamespace, namespaceId)
    const owner = owners.get(runId), snapshot = await raw.get(runId)
    assert.ok(owner)
    assert.equal(snapshot.revision, expectedRevision)
    assert.equal(owner.ownerEpoch, expectedOwnerEpoch)
    assert.equal(owner.active, false)
    const next = { ownerId, ownerToken, ownerEpoch: String(Number(owner.ownerEpoch) + 1), active: true, released: false }
    owners.set(runId, next)
    return { protocol: 'canvas-run-owner/v1', namespaceId, runId, ownerId, ownerEpoch: next.ownerEpoch,
      leaseExpiresAt: expiry(), snapshot }
  }
  raw.recoverExpired = async (_requestedNamespace, cursor) => ({ namespaceId, item: null, nextCursor: cursor, complete: true })
  return { owners, counters,
    failNextSave(error = Object.assign(new Error('fixture mutation failed'), { code: 'fixture_mutation_failed' })) { nextSaveError = error },
    failNextRelease(error = Object.assign(new Error('fixture release failed'), { code: 'fixture_release_failed' })) { nextReleaseError = error } }
}

test('lost create responses retry the frozen request and never schedule an advanced row twice', async () => {
  for (const advancedBeforeRetry of [false, true]) {
    const f = await fixture({ nodes: [
      { id: 'task', kind: 'agent', agent: 'product', title: 'Task', instruction: 'Run once' },
    ] })
    const raw = f.runStore
    const saveRaw = raw.save.bind(raw)
    const namespaceId = '22222222-2222-4222-8222-222222222222'
    const frozenRequests = []
    let createCalls = 0, releases = 0
    raw.getOwnershipNamespace = async () => ({ protocol: 'canvas-run-owner/v1', namespaceId,
      leaseTtlMs: 120_000, renewAfterMs: 40_000, maxDomainEnvelopeBytes: 2 * 1024 * 1024,
      maxResponseBytes: 2 * 1024 * 1024 + 16 * 1024, recoveryCursor: 'fixture-cursor' })
    raw.getOwnershipState = async () => ({ managed: false })
    raw.recoverExpired = async (_namespace, cursor) => ({ namespaceId, item: null, nextCursor: cursor, complete: true })
    raw.claimResumed = async () => { throw new Error('claimResumed is not used in create reconciliation') }
    raw.createOwned = async request => {
      frozenRequests.push(JSON.stringify(request))
      createCalls++
      if (createCalls === 1) {
        await saveRaw(request.snapshot, 0)
        if (advancedBeforeRetry) {
          await saveRaw({ ...request.snapshot, revision: 2, status: 'interrupted' }, 1)
        }
        throw Object.assign(new Error('response lost after server commit'), { code: 'network_error' })
      }
      const current = await raw.get(request.runId)
      return { protocol: 'canvas-run-owner/v1', namespaceId, runId: request.runId,
        ownerId: request.ownerId, ownerEpoch: '1',
        leaseExpiresAt: new Date(Date.now() + 120_000).toISOString(), snapshot: current,
        alreadyAdvanced: advancedBeforeRetry }
    }
    raw.saveOwned = (_capability, snapshot, expectedRevision) => saveRaw(snapshot, expectedRevision)
    raw.renewOwned = async () => ({ leaseExpiresAt: new Date(Date.now() + 120_000).toISOString(), ownerEpoch: '1' })
    raw.releaseOwned = async capability => { releases++; return { released: true, ownerEpoch: capability.ownerEpoch } }
    const service = f.createService()
    try {
      if (advancedBeforeRetry) {
        await assert.rejects(service.submit({ workflowId: 'workflow' }, { ...f.exec, callId: 'lost-create-advanced' }), error => {
          assert.equal(error.code, 'run_create_persistence_failed')
          assert.equal(error.cause?.code, 'run_create_reconciled')
          return true
        })
        const stored = await raw.get([...await fs.readdir(f.runDirectory)].find(name => name.endsWith('.json')).slice(0, -5))
        assert.equal(stored.revision, 2)
        assert.equal(stored.status, 'interrupted')
        assert.equal(f.dispatches, 0)
      } else {
        const submitted = await service.submit({ workflowId: 'workflow' }, { ...f.exec, callId: 'lost-create-unadvanced' })
        assert.equal(submitted.scheduled, true)
        const drained = await service.drain()
        assert.equal(drained.length, 1)
        assert.equal(drained[0].error, null)
        assert.equal((await raw.get(submitted.runId)).status, 'done')
        assert.equal(f.dispatches, 1)
      }
      assert.equal(createCalls, 2)
      assert.equal(frozenRequests[0], frozenRequests[1])
      assert.equal(releases, 1)
    } finally {
      service.dispose()
      f.service.dispose()
      await service.drain()
      await f.cleanup()
    }
  }
})

test('failed lease renewal aborts local workflow progression without claiming external work stopped', async () => {
  let resolveAnswer, questionEntered, renewEntered, rejectRenew
  const enteredQuestion = new Promise(resolve => { questionEntered = resolve })
  const enteredRenewal = new Promise(resolve => { renewEntered = resolve })
  const renewalResult = new Promise((_, reject) => { rejectRenew = reject })
  let question
  const f = await fixture({ nodes: [
    { id: 'before', kind: 'agent', agent: 'product', title: 'Before review', instruction: 'Run first' },
    { id: 'review', kind: 'review', title: 'Review', instruction: 'Confirm' },
    { id: 'after', kind: 'agent', agent: 'product', title: 'After review', instruction: 'Run second' },
  ], edges: [{ from: 'before', to: 'review' }, { from: 'review', to: 'after' }], answer: input => {
    question = input
    questionEntered()
    return new Promise(resolve => { resolveAnswer = resolve })
  } })
  const raw = f.runStore
  const saveRaw = raw.save.bind(raw)
  const namespaceId = '22222222-2222-4222-8222-222222222222'
  raw.getOwnershipNamespace = async () => ({ protocol: 'canvas-run-owner/v1', namespaceId,
    leaseTtlMs: 120_000, renewAfterMs: 50, maxDomainEnvelopeBytes: 2 * 1024 * 1024,
    maxResponseBytes: 2 * 1024 * 1024 + 16 * 1024, recoveryCursor: 'fixture-cursor' })
  raw.getOwnershipState = async () => ({ managed: false })
  raw.recoverExpired = async (_namespace, cursor) => ({ namespaceId, item: null, nextCursor: cursor, complete: true })
  raw.claimResumed = async () => { throw new Error('claimResumed is not used in renewal loss') }
  raw.createOwned = async ({ runId, ownerId, ownerToken, snapshot }) => {
    await saveRaw(snapshot, 0)
    return { protocol: 'canvas-run-owner/v1', namespaceId, runId, ownerId, ownerEpoch: '1',
      leaseExpiresAt: new Date(Date.now() + 120_000).toISOString(), snapshot, alreadyAdvanced: false }
  }
  let saveOwnedCalls = 0
  raw.saveOwned = (capability, snapshot, expectedRevision) => {
    saveOwnedCalls++
    return saveRaw(snapshot, expectedRevision)
  }
  raw.renewOwned = async () => { renewEntered(); return renewalResult }
  raw.releaseOwned = async capability => ({ released: true, ownerEpoch: capability.ownerEpoch })
  const service = f.createService()
  try {
    await service.submit({ workflowId: 'workflow' }, { ...f.exec, callId: 'renewal-loss' })
    await Promise.race([enteredQuestion, new Promise((_, reject) => setTimeout(() => reject(new Error('review was not reached')), 2000))])
    await Promise.race([enteredRenewal, new Promise((_, reject) => setTimeout(() => reject(new Error('renewal was not attempted')), 2000))])
    rejectRenew(Object.assign(new Error('lease expired'), { code: 'owner_fenced' }))
    await new Promise(resolve => setImmediate(resolve))
    const saveCallsAtLeaseLoss = saveOwnedCalls
    resolveAnswer(answer(question))
    const drained = await service.drain()
    assert.equal(drained.length, 1)
    assert.equal(drained[0].error, 'store_write_failed')
    assert.equal(saveOwnedCalls, saveCallsAtLeaseLoss)
    assert.equal(f.dispatches, 1)
    const stored = await raw.get((await fs.readdir(f.runDirectory)).find(name => name.endsWith('.json')).slice(0, -5))
    assert.equal(stored.nodes.review.reviewState.status, 'waiting')
    assert.equal(stored.status, 'waiting')
  } finally {
    resolveAnswer?.(answer(question))
    service.dispose()
    f.service.dispose()
    await service.drain()
    await f.cleanup()
  }
})

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

test('journal accepts OWNER_LEASE_EXPIRED only as an interrupted review cause with intact request evidence', async t => {
  let resolveAnswer, questionEntered, questionInput
  const entered = new Promise(resolve => { questionEntered = resolve })
  const pendingAnswer = new Promise(resolve => { resolveAnswer = resolve })
  const f = await fixture({ nodes: [
    { id: 'task', kind: 'agent', agent: 'product', title: 'Task', instruction: 'Produce a result' },
    { id: 'review', kind: 'review', title: 'Review', instruction: 'Confirm the result' },
  ], edges: [{ from: 'task', to: 'review' }], answer: question => {
    questionInput = question
    questionEntered()
    return pendingAnswer
  } })
  t.after(async () => {
    resolveAnswer(answer(questionInput))
    f.service.dispose()
    await f.service.drain()
    await f.cleanup()
  })

  const submitted = await f.service.submit({ workflowId: 'workflow' }, f.exec)
  await Promise.race([entered, new Promise((_, reject) => setTimeout(() => reject(new Error('review was not reached')), 2000))])
  const waiting = await f.runStore.get(submitted.runId)
  assert.equal(waiting.nodes.review.reviewState.status, 'waiting')
  const recovered = await createWorkflowRunJournal({ store: f.runStore }).recoverInterruptedRuns()
  assert.equal(recovered.recovered.length, 1)
  const snapshot = clone(await f.runStore.get(submitted.runId))
  assert.equal(snapshot.nodes.review.reviewState.error, 'PROCESS_RESTARTED')
  const reviewEvent = snapshot.events.findLast(event => event.type === 'review-node-interrupted')
  assert.ok(reviewEvent)
  snapshot.nodes.review.error = 'OWNER_LEASE_EXPIRED'
  snapshot.nodes.review.reviewState.error = 'OWNER_LEASE_EXPIRED'
  reviewEvent.errorCategory = 'OWNER_LEASE_EXPIRED'
  const runEvent = snapshot.events.findLast(event => event.type === 'run-interrupted')
  runEvent.errorCategory = 'OWNER_LEASE_EXPIRED'
  await f.runStore.writeRaw(snapshot)

  const journal = createWorkflowRunJournal({ store: f.runStore })
  const opened = await journal.open(submitted.runId)
  assert.equal(opened.getSnapshot().nodes.review.reviewState.error, 'OWNER_LEASE_EXPIRED')
  assert.equal(opened.getSnapshot().nodes.review.reviewState.receipt, null)
  assert.equal(opened.getSnapshot().nodes.review.reviewState.request.questionId,
    waiting.nodes.review.reviewState.request.questionId)
  assert.equal((await opened.inspectResume()).eligible, true)

  const invalidCases = [
    ['missing interrupted event', value => { value.events = value.events.filter(event => event !== value.events.findLast(row => row.type === 'review-node-interrupted')) }],
    ['wrong fingerprint', value => { value.events.findLast(event => event.type === 'review-node-interrupted').requestFingerprint = 'forged' }],
    ['wrong request context', value => { value.events.findLast(event => event.type === 'review-node-interrupted').reviewRequest.bindingRevision = 'forged' }],
    ['wrong event source', value => { value.events.findLast(event => event.type === 'review-node-interrupted').source = 'ownership-recovery' }],
    ['forged cause', value => {
      value.nodes.review.error = 'OTHER_INTERRUPTION'
      value.nodes.review.reviewState.error = 'OTHER_INTERRUPTION'
      value.events.findLast(event => event.type === 'review-node-interrupted').errorCategory = 'OTHER_INTERRUPTION'
    }],
  ]
  for (const [label, mutate] of invalidCases) {
    const invalid = clone(snapshot)
    mutate(invalid)
    await f.runStore.writeRaw(invalid)
    await assert.rejects(journal.open(submitted.runId), { code: 'invalid_review_node_receipt' }, label)
  }
  const waitingWithLeaseCause = clone(waiting)
  waitingWithLeaseCause.nodes.review.error = 'OWNER_LEASE_EXPIRED'
  waitingWithLeaseCause.nodes.review.reviewState.error = 'OWNER_LEASE_EXPIRED'
  await f.runStore.writeRaw(waitingWithLeaseCause)
  await assert.rejects(journal.open(submitted.runId), { code: 'invalid_review_node_receipt' },
    'lease-expiry cause is only valid in the interrupted review state')
  await f.runStore.writeRaw(snapshot)
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

test('a delayed old review callback keeps its captured lease proof after a new service claims the run', async t => {
  const questions = []
  const services = []
  const f = await fixture({ nodes: [
    { id: 'task', kind: 'agent', agent: 'product', title: 'Task', instruction: 'Produce a result' },
    { id: 'review', kind: 'review', title: 'Review', instruction: 'Confirm it' },
  ], edges: [{ from: 'task', to: 'review' }], answer: question => new Promise(resolve => questions.push({ question, resolve })) })
  t.after(async () => {
    releaseStaleRead?.()
    for (const pending of questions) pending.resolve(answer(pending.question))
    for (const service of services) service.dispose()
    await Promise.all(services.map(service => service.drain()))
    await f.cleanup()
  })

  const raw = f.runStore
  const namespaceId = '22222222-2222-4222-8222-222222222222'
  const owners = new Map()
  const writes = []
  let holdGetRunId = null, releaseStaleRead
  let markStaleRead
  const staleReadCaptured = new Promise(resolve => { markStaleRead = resolve })
  const staleReadGate = new Promise(resolve => { releaseStaleRead = resolve })
  const getRaw = raw.get.bind(raw)
  raw.get = async runId => {
    const snapshot = await getRaw(runId)
    if (runId === holdGetRunId) {
      holdGetRunId = null
      const captured = clone(snapshot)
      markStaleRead(captured)
      await staleReadGate
      return captured
    }
    return snapshot
  }
  raw.getOwnershipNamespace = async () => ({ namespaceId, leaseTtlMs: 120_000, renewAfterMs: 40_000,
    maxDomainEnvelopeBytes: 2 * 1024 * 1024, maxResponseBytes: 2 * 1024 * 1024 + 16 * 1024,
    recoveryCursor: 'fixture-cursor' })
  raw.getOwnershipState = async (runId, requestedNamespace) => {
    assert.equal(requestedNamespace, namespaceId)
    const snapshot = await raw.get(runId), owner = owners.get(runId)
    return { managed: Boolean(owner), namespaceId, runId, ownerId: owner?.ownerId, ownerEpoch: owner?.ownerEpoch,
      active: owner?.active ?? false, released: owner?.released ?? false, fenced: false,
      revision: snapshot.revision, status: snapshot.status }
  }
  raw.createOwned = async ({ namespaceId: requestedNamespace, runId, ownerId, ownerToken, snapshot }) => {
    assert.equal(requestedNamespace, namespaceId)
    await raw.save(snapshot, 0)
    owners.set(runId, { ownerId, ownerToken, ownerEpoch: '1', active: true, released: false })
    return { namespaceId, runId, ownerId, ownerEpoch: '1', leaseExpiresAt: new Date(Date.now() + 120_000).toISOString(), snapshot, alreadyAdvanced: false }
  }
  raw.saveOwned = async (capability, snapshot, expectedRevision) => {
    const owner = owners.get(capability.runId)
    const accepted = owner?.active && owner.ownerId === capability.ownerId
      && owner.ownerEpoch === capability.ownerEpoch && owner.ownerToken === capability.ownerToken
    writes.push({ epoch: capability.ownerEpoch, accepted })
    if (!accepted) throw Object.assign(new Error('owner fenced'), { code: 'owner_fenced' })
    return raw.save(snapshot, expectedRevision)
  }
  raw.renewOwned = async capability => {
    const owner = owners.get(capability.runId)
    if (!owner?.active || owner.ownerEpoch !== capability.ownerEpoch || owner.ownerToken !== capability.ownerToken) {
      throw Object.assign(new Error('owner fenced'), { code: 'owner_fenced' })
    }
    return { ownerEpoch: owner.ownerEpoch, leaseExpiresAt: new Date(Date.now() + 120_000).toISOString() }
  }
  raw.releaseOwned = async capability => {
    const owner = owners.get(capability.runId)
    if (!owner || owner.ownerEpoch !== capability.ownerEpoch || owner.ownerToken !== capability.ownerToken) {
      throw Object.assign(new Error('owner fenced'), { code: 'owner_fenced' })
    }
    owner.active = false
    owner.released = true
    return { released: true, ownerEpoch: owner.ownerEpoch }
  }
  raw.claimResumed = async ({ namespaceId: requestedNamespace, runId, expectedRevision, expectedOwnerEpoch, ownerId, ownerToken }) => {
    const owner = owners.get(runId), snapshot = await raw.get(runId)
    assert.equal(requestedNamespace, namespaceId)
    assert.equal(snapshot.revision, expectedRevision)
    assert.equal(owner.ownerEpoch, expectedOwnerEpoch)
    assert.equal(owner.active, false)
    const next = { ownerId, ownerToken, ownerEpoch: String(Number(owner.ownerEpoch) + 1), active: true, released: false }
    owners.set(runId, next)
    return { namespaceId, runId, ownerId, ownerEpoch: next.ownerEpoch,
      leaseExpiresAt: new Date(Date.now() + 120_000).toISOString(), snapshot }
  }
  raw.recoverExpired = async (_namespace, cursor) => ({ namespaceId, item: null, nextCursor: cursor, complete: true })

  const firstService = f.createService()
  services.push(firstService)
  const submitted = await firstService.submit({ workflowId: 'workflow' }, f.exec)
  await Promise.race([new Promise(resolve => {
    const poll = () => questions.length >= 1 ? resolve() : setTimeout(poll, 5)
    poll()
  }), new Promise((_, reject) => setTimeout(() => reject(new Error('first review provider was not reached')), 2000))])
  const beforeFence = await raw.get(submitted.runId)
  assert.equal(beforeFence.nodes.review.reviewState.status, 'waiting')

  holdGetRunId = submitted.runId
  questions[0].resolve(answer(questions[0].question))
  await staleReadCaptured
  owners.get(submitted.runId).active = false
  const recovered = await createWorkflowRunJournal({ store: raw }).recoverInterruptedRuns()
  assert.equal(recovered.recovered.length, 1)
  const restartedService = f.createService()
  services.push(restartedService)
  const prepared = await restartedService.prepare_resume({ runId: submitted.runId }, f.exec)
  const resumed = await restartedService.resume({ runId: submitted.runId,
    expectedRunRevision: prepared.expectedRunRevision, expectedDefinitionRevision: prepared.definitionRevision,
    expectedBindingRevision: prepared.bindingRevision, resumePlanHash: prepared.resumePlanHash, confirm: true },
  { ...f.exec, callId: 'new-service-resume' })
  assert.equal(resumed.scheduled, true)
  await Promise.race([new Promise(resolve => {
    const poll = () => questions.length >= 2 ? resolve() : setTimeout(poll, 5)
    poll()
  }), new Promise((_, reject) => setTimeout(() => reject(new Error('new review provider was not reached')), 2000))])
  assert.equal(owners.get(submitted.runId).ownerEpoch, '2')

  releaseStaleRead()
  await Promise.race([firstService.drain(), new Promise((_, reject) => setTimeout(() => reject(new Error(
    `old service did not drain: ${JSON.stringify(writes)}`)), 2000))])
  assert.equal(writes.some(row => row.epoch === '1' && !row.accepted), true, JSON.stringify(writes))
  const afterOldCallback = await raw.get(submitted.runId)
  assert.equal(afterOldCallback.nodes.review.reviewState.status, 'waiting')
  assert.equal(writes.some(row => row.epoch === '1' && row.accepted), true)
  assert.equal(writes.filter(row => row.epoch === '1' && !row.accepted).length, 1)
  assert.equal(owners.get(submitted.runId).ownerEpoch, '2')

  questions[1].resolve(answer(questions[1].question))
  await restartedService.drain()
  await firstService.drain()
  assert.equal((await raw.get(submitted.runId)).status, 'done')
  const takeoverWrite = writes.findIndex(row => row.epoch === '2' && row.accepted)
  assert.ok(takeoverWrite >= 0)
  assert.equal(writes.slice(takeoverWrite).some(row => row.epoch === '1' && row.accepted), false)

  const secondRun = await restartedService.submit({ workflowId: 'workflow' }, { ...f.exec, callId: 'cancel-after-recovery' })
  await Promise.race([new Promise(resolve => {
    const poll = () => questions.length >= 3 ? resolve() : setTimeout(poll, 5)
    poll()
  }), new Promise((_, reject) => setTimeout(() => reject(new Error('cancellation review provider was not reached')), 2000))])
  owners.get(secondRun.runId).active = false
  const secondRecovery = await createWorkflowRunJournal({ store: raw }).recoverInterruptedRuns()
  assert.equal(secondRecovery.recovered.length, 1)
  const cancelService = f.createService()
  services.push(cancelService)
  const cancellation = await cancelService.cancel({ runId: secondRun.runId }, f.exec)
  assert.equal(cancellation.reason, 'not_active_in_service')
  const cancelledSnapshot = await raw.get(secondRun.runId)
  assert.equal(cancelledSnapshot.cancelRequested, true)
  assert.equal(owners.get(secondRun.runId).ownerEpoch, '2')
})

test('cancel returns terminal states without claiming or writing an owner lease', async () => {
  for (const terminalStatus of ['done', 'failed', 'cancelled']) {
    const nodes = [{ id: 'task', kind: 'agent', agent: 'product', title: 'Task', instruction: 'Finish once' }]
    const edges = []
    let answerDecision = null
    if (terminalStatus === 'failed') {
      nodes.push({ id: 'review', kind: 'review', title: 'Review', instruction: 'Reject the result' })
      edges.push({ from: 'task', to: 'review' })
      answerDecision = question => ({ answers: [{ id: question.questions[0].id, selected: ['拒绝'] }] })
    }
    const f = await fixture({ nodes, edges, answer: answerDecision })
    const ownership = installFakeRunOwnership(f)
    const service = f.createService()
    try {
      const submitted = await service.submit({ workflowId: 'workflow' }, { ...f.exec, callId: `terminal-${terminalStatus}` })
      await service.drain()
      const stored = await f.runStore.get(submitted.runId)
      if (terminalStatus === 'cancelled') {
        await f.runStore.writeRaw({ ...stored, status: 'cancelled' })
      } else {
        assert.equal(stored.status, terminalStatus)
      }
      const before = await f.runStore.get(submitted.runId)
      const saveCount = ownership.counters.saves
      const releaseCount = ownership.counters.releases
      const result = await service.cancel({ runId: submitted.runId }, { ...f.exec, callId: `cancel-${terminalStatus}` })
      assert.equal(result.reason, 'already_terminal')
      assert.equal(result.status, terminalStatus)
      assert.equal(ownership.counters.claims, 0, `${terminalStatus} must not claim a new lease`)
      assert.equal(ownership.counters.saves, saveCount, `${terminalStatus} must not persist a cancel write`)
      assert.equal(ownership.counters.releases, releaseCount, `${terminalStatus} has no new lease to release`)
      assert.deepEqual(await f.runStore.get(submitted.runId), before)
    } finally {
      service.dispose()
      await service.drain()
      await f.cleanup()
    }
  }
})

test('cancel releases only its newly claimed lease on reused or failed mutations and surfaces release errors', async () => {
  let question, resolveAnswer, enteredQuestionResolve
  const enteredQuestion = new Promise(resolve => { enteredQuestionResolve = resolve })
  const f = await fixture({ nodes: [
    { id: 'task', kind: 'agent', agent: 'product', title: 'Task', instruction: 'Wait for review' },
    { id: 'review', kind: 'review', title: 'Review', instruction: 'Confirm it' },
  ], edges: [{ from: 'task', to: 'review' }], answer: input => {
    question = input
    enteredQuestionResolve()
    return new Promise(resolve => { resolveAnswer = resolve })
  } })
  const ownership = installFakeRunOwnership(f)
  const firstService = f.createService()
  const secondService = f.createService()
  const sameCancelExec = { ...f.exec, callId: 'reused-cancel-operation' }
  try {
    const submitted = await firstService.submit({ workflowId: 'workflow' }, f.exec)
    await Promise.race([enteredQuestion, new Promise((_, reject) => setTimeout(() => reject(new Error('review was not reached')), 2000))])
    const ownerBefore = ownership.owners.get(submitted.runId)
    const cancelActive = await firstService.cancel({ runId: submitted.runId }, sameCancelExec)
    assert.equal(cancelActive.reason, 'abort_requested')
    assert.equal(ownership.counters.releases, 0, 'active execution retains its own lease until its task finishes')
    resolveAnswer(answer(question))
    await firstService.drain()
    assert.equal(ownership.owners.get(submitted.runId).active, false)
    assert.ok(ownerBefore)

    const interrupted = await f.runStore.get(submitted.runId)
    assert.equal(interrupted.status, 'interrupted')
    assert.equal(interrupted.cancelRequested, true)
    const releaseCount = ownership.counters.releases
    const reused = await secondService.cancel({ runId: submitted.runId }, sameCancelExec)
    assert.equal(reused.reused, true)
    assert.equal(reused.reason, 'already_requested')
    assert.equal(ownership.counters.releases, releaseCount + 1, 'a reused cancel must release the lease it just claimed')
    assert.equal(ownership.owners.get(submitted.runId).active, false)

    ownership.failNextRelease()
    await assert.rejects(secondService.cancel({ runId: submitted.runId }, sameCancelExec), { code: 'fixture_release_failed' })
    assert.equal(ownership.owners.get(submitted.runId).active, true, 'failed release must remain observable as active')

    let mutationQuestion, resolveMutationAnswer, mutationEnteredResolve
    const mutationEntered = new Promise(resolve => { mutationEnteredResolve = resolve })
    const fMutation = await fixture({ nodes: [
      { id: 'task', kind: 'agent', agent: 'product', title: 'Task', instruction: 'Wait for recovery' },
      { id: 'review', kind: 'review', title: 'Review', instruction: 'Confirm it' },
    ], edges: [{ from: 'task', to: 'review' }], answer: input => {
      mutationQuestion = input
      mutationEnteredResolve()
      return new Promise(resolve => { resolveMutationAnswer = resolve })
    } })
    const mutationOwnership = installFakeRunOwnership(fMutation)
    const ownerService = fMutation.createService()
    const cancelService = fMutation.createService()
    try {
      const mutationRun = await ownerService.submit({ workflowId: 'workflow' }, fMutation.exec)
      await Promise.race([mutationEntered, new Promise((_, reject) => setTimeout(() => reject(new Error('mutation review was not reached')), 2000))])
      ownerService.dispose()
      resolveMutationAnswer(answer(mutationQuestion))
      await ownerService.drain()
      const ownerSnapshot = await fMutation.runStore.get(mutationRun.runId)
      assert.equal(ownerSnapshot.status, 'interrupted')
      assert.notEqual(ownerSnapshot.cancelRequested, true)
      mutationOwnership.failNextSave()
      const releaseBeforeFailure = mutationOwnership.counters.releases
      await assert.rejects(cancelService.cancel({ runId: mutationRun.runId }, { ...fMutation.exec, callId: 'cancel-write-fails' }), error => {
        assert.equal(error.code, 'store_write_failed')
        assert.equal(error.cause.code, 'fixture_mutation_failed')
        return true
      })
      assert.equal(mutationOwnership.counters.releases, releaseBeforeFailure + 1)
      assert.equal(mutationOwnership.owners.get(mutationRun.runId).active, false)
    } finally {
      ownerService.dispose()
      cancelService.dispose()
      await Promise.all([ownerService.drain(), cancelService.drain()])
      await fMutation.cleanup()
    }
  } finally {
    resolveAnswer?.(answer(question))
    firstService.dispose()
    secondService.dispose()
    await Promise.all([firstService.drain(), secondService.drain()])
    await f.cleanup()
  }
})
