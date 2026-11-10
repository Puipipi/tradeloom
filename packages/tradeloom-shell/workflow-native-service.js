import { createHash, randomUUID } from 'node:crypto'
import { ROLE_PRESETS } from './roles.js'
import { createConfirmedWorkflowDefinition } from './workflow-definition.js'
import { createWorkflowRunJournal } from './workflow-run-journal.js'
import { createWorkflowNativeBindingResolver, readAuthorizedCenterBinding } from './workflow-native-binding.js'
import { createWorkflowNativeExecutor } from './workflow-native-executor.js'
import { planReadyNodes } from './workflow-native-graph.js'

const TERMINAL = new Set(['done', 'failed', 'cancelled'])
const WORKFLOW_ID = /^[a-z0-9][a-z0-9_-]{0,47}$/
const RUN_ID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/
const fail = code => Object.assign(new Error(`Native workflow service: ${code}`), { code })
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value)
function only(input, key, pattern) {
  if (!record(input) || Object.keys(input).length !== 1 || !Object.hasOwn(input, key)
    || typeof input[key] !== 'string' || !pattern.test(input[key])) throw fail('invalid_input')
  return input[key]
}
function submitInput(input) {
  if (!record(input) || Object.keys(input).some(key => !['workflowId', 'expectedDefinitionRevision', 'expectedBindingRevision'].includes(key))) throw fail('invalid_input')
  const id = only({ workflowId: input.workflowId }, 'workflowId', WORKFLOW_ID)
  for (const key of ['expectedDefinitionRevision', 'expectedBindingRevision']) {
    if (Object.hasOwn(input, key) && (typeof input[key] !== 'string' || !input[key] || input[key].length > 256)) throw fail('invalid_input')
  }
  return id
}
function expectedRevisions(input, definitionRevision, bindingRevision) {
  if (input.expectedDefinitionRevision !== undefined && input.expectedDefinitionRevision !== definitionRevision) throw fail('definition_revision_mismatch')
  if (input.expectedBindingRevision !== undefined && input.expectedBindingRevision !== bindingRevision) throw fail('binding_revision_mismatch')
}
function agentNodes(document) {
  if (!document.nodes.length || document.nodes.some(node => node.kind !== 'agent')
    || document.edges.some(edge => edge.from === edge.to)) {
    throw fail('unsupported_workflow_graph')
  }
  for (const node of document.nodes) {
    if (node.agent === 'center' || !Object.hasOwn(ROLE_PRESETS, node.agent)) throw fail('run_node_role_not_allowed')
    if (typeof node.instruction !== 'string' || !node.instruction.trim()) throw fail('run_node_prompt_unavailable')
  }
  return document.nodes
}
function allowedTool(ctx, parent, preset, model = null) {
  const tool = ctx.tools.get('subagent', parent)
  const schema = tool?.parameters?.properties?.agent_preset
  if (!tool || tool.parameters?.type !== 'object' || schema?.type !== 'string'
    || !Array.isArray(schema.enum) || !schema.enum.includes(preset)) throw fail('NATIVE_PRESET_NOT_ALLOWED')
  if (model != null && ['provider', 'model'].some(key => {
    const property = tool.parameters.properties[key]
    return property?.type !== 'string' || (Array.isArray(property.enum) && !property.enum.includes(model[key]))
  })) throw fail('unsupported_model_selection')
}
export function submissionIdentity(sessionId, callId) {
  // Domain-separated SHA-256 truncation formatted for the journal UUID field.
  // This is a service-specific stable identifier, not standards UUIDv5.
  const hash = createHash('sha256').update('tradeloom.native-submit/v1\0')
    .update(JSON.stringify([sessionId, callId])).digest('hex')
  const hex = hash.slice(0, 32)
  return { runId: `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`, requestId: `submit:${hash}` }
}

function operationKey(action, auth, exec) {
  return createHash('sha256').update('tradeloom.native-operation/v1\0').update(JSON.stringify([action, auth.sessionId, exec.callId])).digest('hex')
}
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical)
  if (record(value)) return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]))
  return value
}
const fingerprint = value => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex')
function resumeInput(input) {
  const keys = ['runId', 'expectedRunRevision', 'expectedDefinitionRevision', 'expectedBindingRevision', 'resumePlanHash', 'confirm']
  if (!record(input) || Object.keys(input).length !== keys.length || keys.some(key => !Object.hasOwn(input, key))) throw fail('invalid_input')
  only({ runId: input.runId }, 'runId', RUN_ID)
  if (!Number.isSafeInteger(input.expectedRunRevision) || input.expectedRunRevision < 1 || input.confirm !== true
    || !/^sha256:[a-f0-9]{64}$/.test(input.resumePlanHash ?? '')
    || !/^sha256:[a-f0-9]{64}$/.test(input.expectedDefinitionRevision ?? '')
    || !/^(?:0|[1-9][0-9]{0,63})$/.test(input.expectedBindingRevision ?? '')) throw fail('invalid_input')
}
function resumeFingerprint(input) {
  return fingerprint(['resume', input.runId, input.expectedRunRevision, input.expectedDefinitionRevision, input.expectedBindingRevision, input.resumePlanHash, input.confirm])
}
function replayResume(snapshot, operationId, bodyFingerprint) {
  const event = snapshot.events.find(event => event.type === 'resume-claimed' && event.operationId === operationId)
  if (event && (event.source !== 'native-run-service' || event.operationFingerprint !== bodyFingerprint
    || ['parentAgentId', 'sessionId', 'bindingRevision', 'definitionRevision'].some(key => event[key] !== snapshot[key]))) throw fail('operation_conflict')
  return Boolean(event)
}

/** Host-owned composition only. This module does not register tools or routes.
 * definitionStore.get(id) returns the stored workflow document; runStore is the
 * paired get/list/save CAS store accepted by the journal (including PG adapters).
 * exec is used only for trusted parent identity and callId, never as the lifetime
 * signal of a background run. Normal submit-tool completion leaves work alive.
 */
export function createWorkflowNativeService({ ctx, readState, definitionStore, runStore, taskAuthority, timeoutMs = 120_000 } = {}) {
  if (typeof ctx?.effect !== 'function' || typeof ctx?.tools?.get !== 'function'
    || typeof ctx?.tools?.execute !== 'function' || typeof readState !== 'function'
    || typeof definitionStore?.get !== 'function') throw new TypeError('native service requires Host ownership and definition services')
  const journal = createWorkflowRunJournal({ store: runStore })
  const runs = new Map()
  let closed = false
  const stop = () => {
    closed = true
    for (const owned of runs.values()) owned.controller.abort(fail('host_unloaded'))
    // Never await an owned task from its own disposal path.
  }
  ctx.effect(() => stop)
  const authorize = exec => readAuthorizedCenterBinding(ctx, readState, exec)
  const owns = (snapshot, auth) => snapshot?.parentAgentId === auth.parent.id && snapshot?.sessionId === auth.sessionId
  const resolver = createWorkflowNativeBindingResolver({ ctx, readState,
    loadRun: async id => { const handle = await journal.open(id); return handle?.getSnapshot() },
  })
  async function definition(id) {
    const stored = await definitionStore.get(id)
    if (!stored) throw fail('workflow_not_found')
    if (Array.isArray(stored.nodes) && Array.isArray(stored.edges)) agentNodes(stored)
    const result = createConfirmedWorkflowDefinition(stored)
    if (result.document.id !== id) throw fail('workflow_identity_mismatch')
    agentNodes(result.document)
    return result
  }
  function sameSubmission(snapshot, expected) {
    if (!snapshot || snapshot.id !== expected.workflowRunId || snapshot.journalSchema !== 'tradeloom.native-run-journal/v1'
      || snapshot.executionMode !== 'native_dsh' || snapshot.workflowId !== expected.workflowId
      || snapshot.parentAgentId !== expected.parentAgentId || snapshot.sessionId !== expected.sessionId
      || snapshot.bindingRevision !== expected.bindingRevision || snapshot.definitionRevision !== expected.definitionRevision
      || snapshot.requestId !== expected.requestId) throw fail('submission_identity_conflict')
  }
  const existing = (snapshot, expected) => {
    sameSubmission(snapshot, expected)
    return { runId: snapshot.id, status: snapshot.status, queued: false, scheduled: false, reused: true }
  }
  const expectedTask = (runId, auth, snapshot) => ({ runId, identity: {
    workflowId: snapshot.workflowId, parentAgentId: auth.parent.id, sessionId: auth.sessionId,
    workspaceId: auth.workspaceId, definitionRevision: snapshot.definitionRevision, bindingRevision: auth.bindingRevision,
  } })
  const bindTask = (exec, runId, auth, snapshot, requireExisting = true) => taskAuthority
    ? taskAuthority.bindTask(exec, expectedTask(runId, auth, snapshot), { requireExisting }) : null
  const releaseTask = task => { if (task) taskAuthority.releaseTask(task) }
  async function revalidateTask(task, exec, auth, snapshot) {
    if (!task) return // Existing direct factory contract; installed composition supplies authority.
    if (closed || exec.signal.aborted || task.signal.aborted) throw fail('operation_aborted')
    const latest = await definition(snapshot.workflowId)
    const current = await authorize(exec)
    if (current.parent !== auth.parent || current.workspaceId !== auth.workspaceId
      || current.bindingRevision !== auth.bindingRevision) throw fail('binding_revision_mismatch')
    if (latest.definitionRevision !== snapshot.definitionRevision) throw fail('definition_revision_mismatch')
    if (closed || exec.signal.aborted || task.signal.aborted) throw fail('operation_aborted')
  }
  function schedule(handle, auth, callId, submissionAborted, resumeOperationId = null, task = null) {
    const controller = new AbortController()
    if (submissionAborted) controller.abort(fail('submission_aborted_during_create'))
    const abortTask = () => controller.abort(task.signal.reason)
    if (task) {
      task.signal.addEventListener('abort', abortTask, { once: true })
      if (task.signal.aborted) abortTask()
    }
    const owned = { controller, error: null, task: null }
    // Cordis effect registers a disposer returned by its immediate setup.
    const releaseParent = auth.parent.ctx.effect(() => () => controller.abort(fail('parent_disposed')))
    runs.set(handle.getSnapshot().id, owned)
    if (closed) controller.abort(fail('host_unloaded'))
    owned.task = new Promise(resolve => setImmediate(resolve)).then(async () => {
      while (true) {
        await handle.settleBlockedNodes()
        const snapshot = handle.getSnapshot()
        if (TERMINAL.has(snapshot.status) || snapshot.cancelRequested === true) return
        const plan = planReadyNodes(snapshot.document, snapshot)
        if (!plan.readyNodeIds.length) return
        if (controller.signal.aborted && Object.values(snapshot.nodes).some(node => node.attempt > 0)) return
        const node = agentNodes(snapshot.document).find(node => node.id === plan.readyNodeIds[0])
        const nextAttempt = snapshot.nodes[node.id].attempt + 1
        const attemptRequestId = resumeOperationId ? `resume:${fingerprint([snapshot.id, resumeOperationId, node.id, nextAttempt])}` : `attempt:${randomUUID()}`
        await handle.executeAttempt({ nodeId: node.id, attempt: nextAttempt, requestId: attemptRequestId,
          ...(resumeOperationId ? { confirmResume: true, confirmNewAttempt: true } : {}),
          bindingRevision: snapshot.bindingRevision, definitionRevision: snapshot.definitionRevision }, async attempt => {
          // Local executor dependency only; original SDK schema/get and registry
          // retain their receivers. No global ToolRuntime/provider replacement.
          const executorContext = task ? {
            agents: ctx.agents, subagents: ctx.subagents,
            tools: { get: (...args) => ctx.tools.get(...args),
              execute: input => taskAuthority.executeTask(task, input) },
          } : ctx
          const executor = createWorkflowNativeExecutor(executorContext, { timeoutMs,
            resolveBinding: async (input, trustedExec) => {
              const currentDefinition = await definition(snapshot.workflowId)
              if (currentDefinition.definitionRevision !== snapshot.definitionRevision) throw fail('definition_revision_mismatch')
              const binding = await resolver(input, trustedExec)
              const latestDefinition = await definition(snapshot.workflowId)
              if (latestDefinition.definitionRevision !== snapshot.definitionRevision) throw fail('definition_revision_mismatch')
              const current = await authorize(trustedExec)
              if (current.parent !== auth.parent || current.bindingRevision !== snapshot.bindingRevision) throw fail('center_binding_mismatch')
              return binding
            },
            recordChildAck: (binding, ack) => {
              if (binding.requestId !== attempt.requestId || binding.workflowRunId !== attempt.workflowRunId
                || binding.nodeId !== attempt.nodeId || binding.attempt !== attempt.attempt) throw fail('attempt_identity_mismatch')
              return attempt.recordChildAck(ack)
            },
          })
          return executor.run({ requestId: attempt.requestId, workflowRunId: attempt.workflowRunId,
            nodeId: attempt.nodeId, attempt: attempt.attempt, bindingRevision: attempt.bindingRevision,
            definitionRevision: attempt.definitionRevision, prompt: node.instruction },
          { agent: auth.parent, callId, signal: controller.signal })
        })
      }
    }).catch(error => { owned.error = error }).finally(() => {
      runs.delete(handle.getSnapshot().id)
      if (task) { task.signal.removeEventListener('abort', abortTask); releaseTask(task) }
      if (typeof releaseParent === 'function') releaseParent()
    })
  }
  async function resumePreparation(runId, exec) {
    if (closed) throw fail('service_closed')
    const auth = await authorize(exec)
    const handle = await journal.open(runId)
    if (!handle) throw fail('run_not_found')
    const snapshot = handle.getSnapshot()
    if (!owns(snapshot, auth)) throw fail('run_parent_mismatch')
    const confirmed = await definition(snapshot.workflowId)
    if (confirmed.definitionRevision !== snapshot.definitionRevision) throw fail('definition_revision_mismatch')
    if (snapshot.bindingRevision !== auth.bindingRevision) throw fail('binding_revision_mismatch')
    for (const node of agentNodes(confirmed.document)) allowedTool(ctx, auth.parent, ROLE_PRESETS[node.agent], node.model)
    const plan = await handle.inspectResume()
    const current = await authorize(exec)
    if (current.parent !== auth.parent || current.bindingRevision !== auth.bindingRevision) throw fail('binding_revision_mismatch')
    const latest = await definition(snapshot.workflowId)
    if (latest.definitionRevision !== snapshot.definitionRevision) throw fail('definition_revision_mismatch')
    const final = await authorize(exec)
    if (final.parent !== current.parent || final.bindingRevision !== current.bindingRevision) throw fail('binding_revision_mismatch')
    const stored = handle.getSnapshot()
    if (!owns(stored, final)) throw fail('run_parent_mismatch')
    if (stored.bindingRevision !== final.bindingRevision) throw fail('binding_revision_mismatch')
    if (stored.definitionRevision !== latest.definitionRevision) throw fail('definition_revision_mismatch')
    if (runs.has(runId)) { plan.eligible = false; plan.blocked.push({ nodeId: null, reason: 'run_active_in_service' }) }
    const resumePlanHash = `sha256:${fingerprint([stored.id, stored.revision, stored.parentAgentId, stored.sessionId,
      stored.bindingRevision, stored.definitionRevision, stored.status, stored.cancelRequested === true, stored.nodes, plan])}`
    return { auth: final, handle, plan, snapshot: stored, resumePlanHash }
  }
  return Object.freeze({
    async prepare_resume(input, exec) {
      const runId = only(input, 'runId', RUN_ID)
      const prepared = await resumePreparation(runId, exec)
      return { runId, expectedRunRevision: prepared.snapshot.revision, definitionRevision: prepared.snapshot.definitionRevision,
        bindingRevision: prepared.snapshot.bindingRevision, resumePlanHash: prepared.resumePlanHash, ...prepared.plan }
    },
    async resume(input, exec) {
      resumeInput(input)
      if (exec?.signal?.aborted) throw fail('operation_aborted')
      const prepared = await resumePreparation(input.runId, exec)
      const operationId = operationKey('resume', prepared.auth, exec), bodyFingerprint = resumeFingerprint(input)
      if (replayResume(prepared.snapshot, operationId, bodyFingerprint)) {
        const task = await bindTask(exec, input.runId, prepared.auth, prepared.snapshot)
        releaseTask(task)
        return { runId: input.runId, status: prepared.snapshot.status, reused: true, scheduled: false }
      }
      expectedRevisions(input, prepared.snapshot.definitionRevision, prepared.auth.bindingRevision)
      if (input.expectedRunRevision !== prepared.snapshot.revision) throw fail('resume_revision_conflict')
      if (input.resumePlanHash !== prepared.resumePlanHash) throw fail('resume_plan_conflict')
      if (!prepared.plan.eligible) throw fail('resume_blocked')
      if (closed || exec?.signal?.aborted) throw fail('operation_aborted')
      const task = await bindTask(exec, input.runId, prepared.auth, prepared.snapshot)
      let scheduled = false
      try {
        await revalidateTask(task, exec, prepared.auth, prepared.snapshot)
        let claimed
        try {
          claimed = await prepared.handle.claimResume({ operationId, fingerprint: bodyFingerprint,
            expectedRevision: input.expectedRunRevision, nodeIds: prepared.plan.eligibleNodeIds })
        } catch (error) {
          const current = await resumePreparation(input.runId, exec)
          if (replayResume(current.snapshot, operationId, bodyFingerprint)) return { runId: input.runId, status: current.snapshot.status, reused: true, scheduled: false }
          if (current.snapshot.revision !== input.expectedRunRevision) throw fail('resume_revision_conflict')
          throw error
        }
        if (claimed.reused) return { runId: input.runId, status: claimed.snapshot.status, reused: true, scheduled: false }
        if (closed || exec?.signal?.aborted) {
          await prepared.handle.requestCancel({ operationId: `aborted:${operationId}`, fingerprint: bodyFingerprint })
          throw fail('operation_aborted')
        }
        schedule(prepared.handle, prepared.auth, exec.callId, false, operationId, task)
        scheduled = true
        return { runId: input.runId, status: 'queued', reused: false, scheduled: true }
      } finally { if (!scheduled) releaseTask(task) }
    },
    async prepare(input, exec) {
      const workflowId = only(input, 'workflowId', WORKFLOW_ID)
      if (closed) throw fail('service_closed')
      const auth = await authorize(exec)
      const confirmed = await definition(workflowId)
      const nodes = agentNodes(confirmed.document)
      for (const node of nodes) allowedTool(ctx, auth.parent, ROLE_PRESETS[node.agent], node.model)
      const current = await authorize(exec)
      if (current.parent !== auth.parent || current.bindingRevision !== auth.bindingRevision) throw fail('binding_revision_mismatch')
      const latestDefinition = await definition(workflowId)
      if (latestDefinition.definitionRevision !== confirmed.definitionRevision) throw fail('definition_revision_mismatch')
      const final = await authorize(exec)
      if (final.parent !== current.parent || final.bindingRevision !== current.bindingRevision) throw fail('binding_revision_mismatch')
      return { workflowId, title: confirmed.document.title, eligible: true, executionMode: 'native_dsh', confirmed: true,
        definitionRevision: confirmed.definitionRevision, bindingRevision: final.bindingRevision,
        center: { roleId: 'center', sessionId: final.sessionId, workspaceId: final.workspaceId, archiveState: 'unarchived' },
        graph: { nodeCount: nodes.length, edgeCount: confirmed.document.edges.length, maxConcurrent: 1,
          roleIds: [...new Set(nodes.map(node => node.agent))],
          nodes: nodes.map(node => ({ id: node.id, roleId: node.agent, agentPreset: ROLE_PRESETS[node.agent] })) },
        ...(nodes.length === 1
          ? { node: { id: nodes[0].id, roleId: nodes[0].agent, agentPreset: ROLE_PRESETS[nodes[0].agent] } }
          : { nodes: nodes.map(node => ({ id: node.id, roleId: node.agent, agentPreset: ROLE_PRESETS[node.agent] })) }) }
    },
    async submit(input, exec) {
      const workflowId = submitInput(input)
      if (closed) throw fail('service_closed')
      if (exec?.signal?.aborted) throw fail('ABORTED_BEFORE_NATIVE_SUBMIT')
      const auth = await authorize(exec)
      if (typeof auth.parent.ctx?.effect !== 'function') throw fail('parent_ownership_unavailable')
      const confirmed = await definition(workflowId)
      if (exec?.signal?.aborted) throw fail('ABORTED_BEFORE_NATIVE_SUBMIT')
      for (const node of agentNodes(confirmed.document)) allowedTool(ctx, auth.parent, ROLE_PRESETS[node.agent], node.model)
      expectedRevisions(input, confirmed.definitionRevision, auth.bindingRevision)
      const identity = submissionIdentity(auth.sessionId, exec.callId)
      const expected = { workflowRunId: identity.runId, workflowId, document: confirmed.document,
        definitionRevision: confirmed.definitionRevision, requestId: identity.requestId,
        parentAgentId: auth.parent.id, sessionId: auth.sessionId, bindingRevision: auth.bindingRevision }
      const prior = await runStore.get(identity.runId)
      if (exec?.signal?.aborted) throw fail('ABORTED_BEFORE_NATIVE_SUBMIT')
      // Recheck the current parent/binding after asynchronous definition/store reads.
      const latestDefinition = await definition(workflowId)
      const current = await authorize(exec)
      if (current.parent !== auth.parent || current.bindingRevision !== auth.bindingRevision) throw fail('binding_revision_mismatch')
      expectedRevisions(input, latestDefinition.definitionRevision, current.bindingRevision)
      if (latestDefinition.definitionRevision !== confirmed.definitionRevision) throw fail('definition_revision_mismatch')
      if (closed) throw fail('service_closed')
      if (exec?.signal?.aborted) throw fail('ABORTED_BEFORE_NATIVE_SUBMIT')
      // The service, not renderer/Host prediction, owns this authoritative tuple.
      // Bind before run creation. An orphan uncharged binding after CAS failure
      // remains in the original budget ledger and is never silently rebound.
      if (prior) sameSubmission(prior, expected)
      const task = await bindTask(exec, identity.runId, current, expected, Boolean(prior))
      let scheduled = false
      try {
        await revalidateTask(task, exec, current, expected)
        if (prior) return existing(prior, expected)
        let handle
        try { handle = await journal.create(expected) } catch (error) {
          const stored = await runStore.get(identity.runId)
          if (stored) return existing(stored, expected)
          throw error
        }
        schedule(handle, auth, exec.callId, exec?.signal?.aborted === true, null, task)
        scheduled = true
        return { runId: identity.runId, status: 'queued', queued: true, scheduled: true, reused: false }
      } finally { if (!scheduled) releaseTask(task) }
    },
    async get(input, exec) {
      const id = only(input, 'runId', RUN_ID)
      const auth = await authorize(exec)
      const snapshot = await runStore.get(id)
      if (!snapshot) return null
      if (!owns(snapshot, auth)) throw fail('run_parent_mismatch')
      return snapshot
    },
    async list(input = {}, exec) {
      if (!record(input) || Object.keys(input).some(key => !['activeOnly', 'workflowId'].includes(key))
        || (Object.hasOwn(input, 'activeOnly') && typeof input.activeOnly !== 'boolean')
        || (Object.hasOwn(input, 'workflowId') && (typeof input.workflowId !== 'string' || !WORKFLOW_ID.test(input.workflowId)))) throw fail('invalid_input')
      const auth = await authorize(exec)
      const rows = await runStore.list({ activeOnly: input.activeOnly === true })
      const snapshots = await Promise.all(rows.map(row => runStore.get(row.id)))
      return snapshots.filter(snapshot => owns(snapshot, auth) && (!input.workflowId || snapshot.workflowId === input.workflowId))
    },
    async cancel(input, exec) {
      const id = only(input, 'runId', RUN_ID)
      const auth = await authorize(exec)
      const handle = await journal.open(id)
      const snapshot = handle?.getSnapshot()
      if (!snapshot) throw fail('run_not_found')
      if (!owns(snapshot, auth)) throw fail('run_parent_mismatch')
      if (snapshot.bindingRevision !== auth.bindingRevision) throw fail('binding_revision_mismatch')
      const current = await authorize(exec)
      if (current.parent !== auth.parent || current.bindingRevision !== auth.bindingRevision || exec?.signal?.aborted) throw fail('operation_aborted')
      const cancelled = await handle.requestCancel({ operationId: operationKey('cancel', auth, exec), fingerprint: fingerprint(['cancel', id]) })
      if (cancelled.alreadyTerminal) return { runId: id, status: snapshot.status, aborted: false, reason: 'already_terminal' }
      const owned = runs.get(id)
      if (cancelled.reused) {
        const abort = cancelled.snapshot.cancelRequested === true && owned && !owned.controller.signal.aborted
        if (abort) owned.controller.abort(fail('run_cancel_requested'))
        return { runId: id, status: cancelled.snapshot.status, aborted: Boolean(abort), reused: true,
          reason: abort ? 'abort_requested' : 'already_requested', intentPersisted: true }
      }
      if (!owned) return { runId: id, status: cancelled.snapshot.status, aborted: false, reason: 'not_active_in_service', intentPersisted: true }
      owned.controller.abort(fail('run_cancel_requested'))
      return { runId: id, status: cancelled.snapshot.status, aborted: true, reason: 'abort_requested', intentPersisted: true }
    },
    recover: () => journal.recoverInterruptedRuns(),
    dispose: stop,
    // Host-only observation for shutdown/acceptance; cleanup above never awaits it.
    async drain() {
      const pending = [...runs.entries()]
      await Promise.all(pending.map(([, owned]) => owned.task))
      return pending.map(([runId, owned]) => ({ runId, error: owned.error?.code ?? null }))
    },
  })
}
