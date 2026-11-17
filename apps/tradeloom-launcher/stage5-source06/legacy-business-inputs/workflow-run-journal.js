import { randomUUID } from 'node:crypto'
import { createConfirmedWorkflowDefinition, verifyWorkflowDefinition } from './workflow-definition.js'
import { validateArtifactRangeStart, validateArtifactEvidence } from './workflow-artifact-source.js'
import { planReadyNodes } from './workflow-native-graph.js'
import { deriveWorkflowLocalReceipt, validateWorkflowLocalReceipt } from './workflow-local-nodes.js'
import { validateWorkflowReviewState, verifiedReviewOutput } from './workflow-review.js'

const MAX_SNAPSHOT_BYTES = 2 * 1024 * 1024
const MAX_NODE_COUNT = 40
const MAX_RECOVERY_ROWS = 100
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const WORKFLOW_ID = /^[a-z0-9][a-z0-9_-]{0,47}$/
const RUN_STATUSES = new Set(['running', 'waiting', 'done', 'failed', 'cancelled', 'interrupted'])
const EXECUTION_MODES = new Set(['native_dsh', 'local_mock', 'custom'])
const TERMINAL_SOURCES = new Set(['subagent/end', 'tool-runtime', 'unknown'])
const OBSERVATION_STATUSES = new Set(['completed', 'interrupted', 'failed', 'tool_error', 'tool_cancelled', 'unknown'])
const JOURNAL_SCHEMA = 'tradeloom.native-run-journal/v1'

export class WorkflowRunJournalError extends Error {
  constructor(code, cause) {
    super(`Workflow run journal: ${code}`, cause === undefined ? undefined : { cause })
    this.name = 'WorkflowRunJournalError'
    this.code = code
  }
}

function fail(code, cause) {
  return new WorkflowRunJournalError(code, cause)
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function copy(value) {
  return structuredClone(value)
}

function timestamp(now) {
  const value = now()
  const date = value instanceof Date ? value : new Date(value)
  if (!Number.isFinite(date.getTime())) throw fail('invalid_clock')
  return date.toISOString()
}

function nonEmptyString(value, max = 512) {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= max
}

function validateStore(store) {
  if (typeof store?.get !== 'function' || typeof store?.list !== 'function' || typeof store?.save !== 'function') {
    throw new TypeError('workflow run journal requires the paired get/list/save store')
  }
}

function normalizeDocument(input) {
  if (!isRecord(input)) throw fail('invalid_document')
  try { return createConfirmedWorkflowDefinition(input) } catch (error) {
    throw fail(error.code === 'workflow_not_confirmed' ? error.code : 'invalid_document', error)
  }
}

function validateCreateInput(input, createRunId) {
  if (!isRecord(input)) throw fail('invalid_create_input')
  const { document, definitionRevision } = normalizeDocument(input.document)
  if (input.definitionRevision !== undefined && input.definitionRevision !== definitionRevision) {
    throw fail('definition_revision_mismatch')
  }
  const workflowId = input.workflowId ?? document.id
  if (typeof workflowId !== 'string' || !WORKFLOW_ID.test(workflowId) || document.id !== workflowId) {
    throw fail('invalid_workflow_id')
  }
  const id = input.workflowRunId ?? createRunId()
  if (typeof id !== 'string' || !UUID.test(id)) throw fail('invalid_run_id')
  if (!nonEmptyString(input.requestId, 256)
    || !nonEmptyString(input.parentAgentId, 256)
    || !nonEmptyString(input.sessionId, 256)
    || !nonEmptyString(input.bindingRevision, 256)) {
    throw fail('invalid_run_binding')
  }
  return {
    id,
    workflowId,
    document,
    requestId: input.requestId,
    parentAgentId: input.parentAgentId,
    sessionId: input.sessionId,
    bindingRevision: input.bindingRevision,
    definitionRevision,
  }
}

function validateSnapshot(snapshot, { requireJournal = true } = {}) {
  if (!isRecord(snapshot) || typeof snapshot.id !== 'string' || !UUID.test(snapshot.id)
    || snapshot.journalSchema !== JOURNAL_SCHEMA || snapshot.executionMode !== 'native_dsh'
    || typeof snapshot.workflowId !== 'string' || !WORKFLOW_ID.test(snapshot.workflowId)
    || !RUN_STATUSES.has(snapshot.status) || !EXECUTION_MODES.has(snapshot.executionMode)
    || !Number.isSafeInteger(snapshot.revision) || snapshot.revision < 1
    || typeof snapshot.title !== 'string' || snapshot.title.length > 100
    || !isRecord(snapshot.document) || snapshot.document.id !== snapshot.workflowId
    || !isRecord(snapshot.nodes) || Object.keys(snapshot.nodes).length > MAX_NODE_COUNT
    || !Array.isArray(snapshot.events)) {
    throw fail('invalid_snapshot')
  }
  if (requireJournal && (!nonEmptyString(snapshot.requestId, 256)
    || !nonEmptyString(snapshot.parentAgentId, 256)
    || !nonEmptyString(snapshot.sessionId, 256)
    || !nonEmptyString(snapshot.bindingRevision, 256)
    || !nonEmptyString(snapshot.definitionRevision, 256))) {
    throw fail('invalid_journal_binding')
  }
  try { verifyWorkflowDefinition(snapshot.document, snapshot.definitionRevision) } catch (error) {
    throw fail('invalid_definition_snapshot', error)
  }
  for (const node of Object.values(snapshot.nodes)) {
    if (node?.artifactRangeStart !== undefined && (!validateArtifactRangeStart(node.artifactRangeStart)
      || node.artifactRangeStart.childSessionId !== node.childId || node.artifactRangeStart.nativeRunId !== node.nativeRunId)) throw fail('invalid_artifact_range')
    if (node?.artifactEvidence !== undefined && (!validateArtifactEvidence(node.artifactEvidence, node.artifactRangeStart)
      || node.artifactRangeStart.childSessionId !== node.childId || node.artifactRangeStart.nativeRunId !== node.nativeRunId
      || node.artifactSource !== 'deliverables/presented' || JSON.stringify(node.artifacts) !== JSON.stringify(node.artifactEvidence.declarations))) throw fail('invalid_artifact_evidence')
  }
  for (const definitionNode of snapshot.document.nodes) {
    const node = snapshot.nodes[definitionNode.id]
    if (definitionNode.kind === 'agent') {
      if (Object.hasOwn(node, 'localReceipt')) throw fail('invalid_local_node_receipt')
      continue
    }
    if (definitionNode.kind === 'review') {
      const emptyIdentity = ['requestId', 'toolCallId', 'childId', 'nativeRunId'].every(key => node[key] === null)
        && node.attempt === 0 && node.artifactSource === 'unknown' && Array.isArray(node.artifacts) && node.artifacts.length === 0
        && !Object.hasOwn(node, 'artifactEvidence') && !Object.hasOwn(node, 'artifactRangeStart')
        && !Object.hasOwn(node, 'localReceipt')
      if (!emptyIdentity) throw fail('invalid_review_node_state')
      if (node.reviewState === null || node.reviewState === undefined) {
        if (!['pending', 'skipped'].includes(node.status) || node.status === 'pending' && (node.output !== '' || node.error !== '')) throw fail('invalid_review_node_state')
        continue
      }
      let reviewed
      try { reviewed = validateWorkflowReviewState(snapshot, definitionNode) } catch (error) { throw fail('invalid_review_node_receipt', error) }
      const state = reviewed.state
      const expectedStatus = { waiting: 'waiting', deferred: 'waiting', interrupted: 'interrupted', approved: 'done', rejected: 'failed', failed: 'failed' }[state.status]
      if (node.status !== expectedStatus || node.attemptState !== `review-${state.status}`
        || state.status === 'approved' && (node.output !== reviewed.receipt.output || node.error !== '')
        || state.status === 'rejected' && (node.output !== '' || node.error !== 'review_rejected')
        || ['deferred', 'interrupted', 'failed'].includes(state.status) && node.error !== state.error) throw fail('invalid_review_node_state')
      continue
    }
    if (!['input', 'output'].includes(definitionNode.kind)) continue
    if (node.status !== 'done' && Object.hasOwn(node, 'localReceipt') || node.attempt !== 0
      || ['requestId', 'toolCallId', 'childId', 'nativeRunId'].some(key => node[key] !== null)
      || node.artifactSource !== 'unknown' || !Array.isArray(node.artifacts) || node.artifacts.length !== 0
      || Object.hasOwn(node, 'artifactEvidence') || Object.hasOwn(node, 'artifactRangeStart')) throw fail('invalid_local_node_state')
    if (node.status === 'done') {
      try { validateWorkflowLocalReceipt(snapshot, definitionNode, { verifyReviewParent: verifiedReviewOutput }) } catch (error) { throw fail('invalid_local_node_receipt', error) }
    } else if (node.status === 'failed') {
      const event = snapshot.events.findLast(row => row.type === 'local-node-error' && row.source === 'workflow/local'
        && row.workflowRunId === snapshot.id && row.nodeId === definitionNode.id && row.status === 'failed'
        && row.errorCategory === node.error && row.attempt === 0 && row.requestId === null
        && row.toolCallId === null && row.childId === null && row.nativeRunId === null
        && row.parentAgentId === snapshot.parentAgentId && row.sessionId === snapshot.sessionId
        && row.bindingRevision === snapshot.bindingRevision && row.definitionRevision === snapshot.definitionRevision)
      if (!event || !['upstream_terminal_unverified', 'upstream_output_unavailable', 'local_receipt_invalid', 'local_output_unavailable'].includes(node.error)) throw fail('invalid_local_node_error')
    } else if (node.status === 'pending') {
      if (node.output !== '' || node.error !== '') throw fail('invalid_local_node_state')
    } else if (node.status !== 'skipped') throw fail('invalid_local_node_state')
  }
  const body = JSON.stringify({ snapshot, expectedRevision: snapshot.revision - 1 })
  if (Buffer.byteLength(body, 'utf8') > MAX_SNAPSHOT_BYTES) throw fail('snapshot_too_large')
  return snapshot
}

function newNodeState(kind) {
  const state = {
    status: 'pending',
    output: '',
    error: '',
    attempt: 0,
    attemptState: 'none',
    requestId: null,
    toolCallId: null,
    childId: null,
    nativeRunId: null,
    artifacts: [],
    artifactSource: 'unknown',
  }
  if (kind === 'review') state.reviewState = null
  return state
}

function eventFor(snapshot, type, at, fields = {}) {
  return {
    sequence: snapshot.events.length + 1,
    type,
    at,
    requestId: Object.hasOwn(fields, 'requestId') ? fields.requestId : snapshot.requestId,
    workflowRunId: snapshot.id,
    nodeId: fields.nodeId ?? null,
    attempt: fields.attempt ?? null,
    bindingRevision: snapshot.bindingRevision,
    definitionRevision: snapshot.definitionRevision,
    parentAgentId: snapshot.parentAgentId,
    sessionId: snapshot.sessionId,
    toolCallId: fields.toolCallId ?? null,
    childId: fields.childId ?? null,
    nativeRunId: fields.nativeRunId ?? null,
    source: fields.source ?? 'native-run-journal',
    ...(fields.status === undefined ? {} : { status: fields.status }),
    ...(fields.stopReason === undefined ? {} : { stopReason: fields.stopReason }),
    ...(fields.errorCategory === undefined ? {} : { errorCategory: fields.errorCategory }),
    ...(type === 'node-blocked' && Array.isArray(fields.blockedBy) ? { blockedBy: [...fields.blockedBy] } : {}),
    ...(['cancel-requested', 'resume-claimed'].includes(type) ? {
      operationId: fields.operationId, operationFingerprint: fields.operationFingerprint,
      ...(type === 'resume-claimed' ? { nodeIds: [...fields.nodeIds] } : {}),
    } : {}),
    ...(fields.output === undefined ? {} : { output: fields.output }),
    ...(fields.identityMismatchFields === undefined ? {} : { identityMismatchFields: fields.identityMismatchFields }),
    ...(fields.artifactRangeStart === undefined ? {} : { artifactRangeStart: fields.artifactRangeStart }),
    ...(fields.artifactEvidence === undefined ? {} : { artifactEvidence: fields.artifactEvidence }),
    ...(fields.localReceipt === undefined ? {} : { localReceipt: fields.localReceipt }),
    ...(fields.reviewRequest === undefined ? {} : { reviewRequest: fields.reviewRequest }),
    ...(fields.reviewReceipt === undefined ? {} : { reviewReceipt: fields.reviewReceipt }),
    ...(fields.questionId === undefined ? {} : { questionId: fields.questionId }),
    ...(fields.requestFingerprint === undefined ? {} : { requestFingerprint: fields.requestFingerprint }),
    ...(fields.reportedIdentity === undefined ? {} : { reportedIdentity: fields.reportedIdentity }),
    artifacts: fields.artifactEvidence?.declarations ?? [],
    artifactSource: fields.artifactEvidence === undefined ? 'unknown' : 'deliverables/presented',
  }
}

function aggregateRun(snapshot, now) {
  const states = Object.values(snapshot.nodes).map(node => node.status)
  if ((snapshot.cancelRequested === true && !states.every(status => status === 'done'))
    || states.some(status => status === 'unknown' || status === 'interrupted')) {
    snapshot.status = 'interrupted'
    snapshot.finishedAt = now
  } else if (states.some(status => status === 'running' || status === 'waiting' || status === 'pending')) {
    snapshot.status = states.includes('waiting') ? 'waiting' : 'running'
    snapshot.finishedAt = null
  } else if (states.includes('failed')) {
    snapshot.status = 'failed'
    snapshot.finishedAt = now
  } else {
    snapshot.status = 'done'
    snapshot.finishedAt = now
  }
}

function operationEvent(snapshot, type, input) {
  if (!isRecord(input) || !nonEmptyString(input.operationId, 256) || !/^[a-f0-9]{64}$/.test(input.fingerprint ?? '')) throw fail('invalid_operation')
  const prior = snapshot.events.find(event => event.type === type && event.operationId === input.operationId)
  if (prior && (prior.source !== 'native-run-service' || prior.operationFingerprint !== input.fingerprint
    || ['parentAgentId', 'sessionId', 'bindingRevision', 'definitionRevision'].some(key => prior[key] !== snapshot[key]))) throw fail('operation_conflict')
  return prior
}

function resumeCandidates(snapshot) {
  const eligibleNodeIds = [], completedNodeIds = [], blocked = []
  if (!['interrupted', 'waiting'].includes(snapshot.status)) blocked.push({ nodeId: null, reason: 'run_not_interrupted' })
  for (const definitionNode of snapshot.document.nodes) {
    const node = snapshot.nodes[definitionNode.id]
    if (node.status === 'done') { completedNodeIds.push(definitionNode.id); continue }
    if (definitionNode.kind === 'review' && ['waiting', 'interrupted'].includes(node.status)
      && ['deferred', 'interrupted'].includes(node.reviewState?.status)
      && node.attempt === 0 && ['requestId', 'toolCallId', 'childId', 'nativeRunId'].every(key => node[key] === null)) {
      eligibleNodeIds.push(definitionNode.id); continue
    }
    if (node.status === 'pending' && node.attempt === 0 && node.attemptState === 'none'
      && ['requestId', 'toolCallId', 'childId', 'nativeRunId'].every(key => node[key] == null)) { eligibleNodeIds.push(definitionNode.id); continue }
    const ended = ['interrupted', 'pending'].includes(node.status) && node.attemptState === 'interrupted' && Number.isSafeInteger(node.attempt) && node.attempt > 0
      && ['requestId', 'toolCallId', 'childId', 'nativeRunId'].every(key => nonEmptyString(node[key]))
      && snapshot.events.some(event => event.source === 'subagent/end' && event.type === 'node-interrupted'
        && event.status === 'interrupted' && event.stopReason === 'aborted' && event.workflowRunId === snapshot.id && event.nodeId === definitionNode.id
        && ['parentAgentId', 'sessionId', 'bindingRevision', 'definitionRevision'].every(key => event[key] === snapshot[key])
        && ['attempt', 'requestId', 'toolCallId', 'childId', 'nativeRunId'].every(key => event[key] === node[key]))
    if (ended) eligibleNodeIds.push(definitionNode.id)
    else blocked.push({ nodeId: definitionNode.id, reason: 'child_terminal_unverified' })
  }
  return { eligible: eligibleNodeIds.length > 0 && blocked.length === 0, eligibleNodeIds, completedNodeIds, blocked }
}

function observationState(observation) {
  if (!isRecord(observation) || !OBSERVATION_STATUSES.has(observation.status)
    || !TERMINAL_SOURCES.has(observation.terminalSource)) {
    return { status: 'unknown', attemptState: 'unknown', eventType: 'attempt-unknown', errorCategory: 'INVALID_OBSERVATION' }
  }
  const hasChild = nonEmptyString(observation.childId, 256)
  const hasNativeRun = nonEmptyString(observation.nativeRunId, 256)
  if (observation.status === 'completed' || observation.status === 'interrupted' || observation.status === 'failed') {
    if (observation.terminalSource !== 'subagent/end' || !hasChild || !hasNativeRun) {
      return { status: 'unknown', attemptState: 'unknown', eventType: 'attempt-unknown', errorCategory: 'TERMINAL_PROOF_MISSING' }
    }
    return {
      status: observation.status === 'completed' ? 'done' : observation.status,
      attemptState: observation.status === 'interrupted' ? 'interrupted' : 'terminal',
      eventType: observation.status === 'completed' ? 'node-terminal' : observation.status === 'interrupted' ? 'node-interrupted' : 'node-error',
      errorCategory: observation.errorCategory ?? null,
    }
  }
  if (observation.status === 'tool_error' && observation.terminalSource === 'tool-runtime') {
    return { status: 'unknown', attemptState: 'unknown', eventType: 'tool-error-unverified', errorCategory: observation.errorCategory ?? 'TOOL_ERROR' }
  }
  return {
    status: 'unknown',
    attemptState: 'unknown',
    eventType: 'attempt-unknown',
    errorCategory: observation.errorCategory ?? (observation.status === 'tool_cancelled' ? 'TOOL_CANCELLED' : null),
  }
}

function makeRunHandle(store, initial, { now, reviewDecisionChannel }) {
  let snapshot = copy(initial)
  let tail = Promise.resolve()
  let poisoned = null

  function enqueue(operation) {
    const result = tail.then(async () => {
      if (poisoned) throw fail('journal_unavailable_after_store_failure', poisoned)
      return operation()
    })
    tail = result.catch(() => {})
    return result
  }

  async function commit(mutator) {
    try {
      const expectedRevision = snapshot.revision
      const next = copy(snapshot)
      const at = timestamp(now)
      mutator(next, at)
      next.revision = expectedRevision + 1
      validateSnapshot(next)
      const saved = await store.save(next, expectedRevision)
      if (!isRecord(saved) || saved.id !== next.id || saved.revision !== next.revision) {
        throw fail('invalid_store_save_response')
      }
      snapshot = copy(saved)
      return copy(snapshot)
    } catch (error) {
      poisoned = error
      if (error instanceof WorkflowRunJournalError) throw error
      throw fail('store_write_failed', error)
    }
  }

  async function refreshSnapshot() {
    try {
      const stored = await store.get(snapshot.id)
      if (!stored || stored.id !== snapshot.id) throw fail('run_missing_during_attempt')
      if (stored.revision < snapshot.revision) throw fail('store_revision_regressed')
      if (stored.revision > snapshot.revision) {
        if (stored.journalSchema !== JOURNAL_SCHEMA || stored.executionMode !== 'native_dsh') {
          throw fail('unsupported_journal_snapshot')
        }
        validateSnapshot(stored)
        snapshot = copy(stored)
      }
    } catch (error) {
      poisoned = error
      if (error instanceof WorkflowRunJournalError) throw error
      throw fail('store_read_failed', error)
    }
  }

  function assertCurrentAttempt(target, input) {
    const node = target.nodes[input.nodeId]
    return Boolean(node && node.attempt === input.attempt && node.requestId === input.requestId)
  }

  function identityMismatch(observation, input, target) {
    const expected = {
      requestId: input.requestId,
      workflowRunId: target.id,
      nodeId: input.nodeId,
      attempt: input.attempt,
      bindingRevision: target.bindingRevision,
      definitionRevision: target.definitionRevision,
      parentAgentId: target.parentAgentId,
      sessionId: target.sessionId,
    }
    const mismatches = Object.keys(expected).filter(key => observation?.[key] !== expected[key])
    const node = target.nodes[input.nodeId]
    if (node?.toolCallId !== null && node?.toolCallId !== undefined && observation?.toolCallId !== node.toolCallId) mismatches.push('toolCallId')
    if (node?.childId !== null && node?.childId !== undefined && observation?.childId !== node.childId) mismatches.push('childId')
    if (node?.nativeRunId !== null && node?.nativeRunId !== undefined && observation?.nativeRunId !== node.nativeRunId) mismatches.push('nativeRunId')
    return [...new Set(mismatches)]
  }

  function reportedIdentity(observation) {
    const fields = ['requestId', 'workflowRunId', 'nodeId', 'attempt', 'bindingRevision', 'definitionRevision', 'parentAgentId', 'sessionId', 'toolCallId', 'childId', 'nativeRunId']
    return Object.fromEntries(fields.filter(key => observation?.[key] !== undefined).map(key => [key,
      typeof observation[key] === 'string' && observation[key].length <= 512 || Number.isSafeInteger(observation[key])
        ? observation[key] : '[invalid]']))
  }

  async function persistLateResult(input, observation, errorCategory) {
    await refreshSnapshot()
    const terminalReason = terminalWriteBlockReason(snapshot, input)
    if (terminalReason) {
      return { snapshot: copy(snapshot), ignored: true, persisted: false, ignoreReason: terminalReason }
    }
    const persistedSnapshot = await commit((next, at) => {
      next.events.push(eventFor(next, 'late-attempt-result-ignored', at, {
        nodeId: input.nodeId,
        attempt: input.attempt,
        requestId: input.requestId,
        source: 'native-executor',
        status: 'unknown',
        errorCategory,
        reportedIdentity: reportedIdentity(observation),
      }))
    })
    return { snapshot: persistedSnapshot, ignored: true, persisted: true, ignoreReason: 'stale_attempt' }
  }

  function terminalWriteBlockReason(target, input) {
    if (['done', 'failed', 'cancelled'].includes(target.status)) return 'run_terminal'
    const node = target.nodes[input.nodeId]
    if (node && ['done', 'failed', 'skipped'].includes(node.status)) return 'node_attempt_terminal'
    return null
  }

  function assertAttempt(input) {
    if (!isRecord(input) || !nonEmptyString(input.nodeId, 48)
      || !Number.isSafeInteger(input.attempt) || input.attempt < 1
      || !nonEmptyString(input.requestId, 256)) throw fail('invalid_attempt')
    if (!Object.hasOwn(snapshot.nodes, input.nodeId)) throw fail('node_not_found')
    const definitionNode = snapshot.document.nodes.find(node => node.id === input.nodeId)
    if (definitionNode?.kind !== 'agent') throw fail('unsupported_node_kind')
    if (input.bindingRevision !== snapshot.bindingRevision) throw fail('binding_revision_mismatch')
    if (input.definitionRevision !== snapshot.definitionRevision) throw fail('definition_revision_mismatch')
    if (['done', 'failed', 'cancelled'].includes(snapshot.status)) throw fail('run_is_terminal')
    if (snapshot.cancelRequested === true) throw fail('run_cancel_requested')
    if (snapshot.status === 'interrupted' && snapshot.nodes[input.nodeId].status === 'pending'
      && snapshot.nodes[input.nodeId].attempt === 0 && input.confirmResume !== true) throw fail('resume_confirmation_required')
  }

  async function recordChildAck(input, ack) {
    assertAttempt(input)
    if (!isRecord(ack) || !nonEmptyString(ack.toolCallId, 256) || !nonEmptyString(ack.childId, 256)) {
      throw fail('invalid_child_ack')
    }
    const artifactRangeStart = ack.artifactRangeStart === undefined ? null : validateArtifactRangeStart(ack.artifactRangeStart)
    if (ack.artifactRangeStart !== undefined && (!artifactRangeStart || artifactRangeStart.childSessionId !== ack.childId
      || artifactRangeStart.nativeRunId !== ack.nativeRunId)) throw fail('invalid_artifact_range')
    return enqueue(async () => {
      assertAttempt(input)
      await refreshSnapshot()
      assertAttempt(input)
      const state = snapshot.nodes[input.nodeId]
      if (state.attempt !== input.attempt || state.requestId !== input.requestId) throw fail('stale_child_ack')
      const sameAttempt = snapshot.events.filter(event => event.nodeId === input.nodeId && event.attempt === input.attempt)
      const priorAck = [...sameAttempt].reverse().find(event => event.type === 'child-ack' || event.type === 'child-ack-late')
      if (priorAck) {
        if (priorAck.toolCallId === ack.toolCallId && priorAck.childId === ack.childId
          && priorAck.nativeRunId === (ack.nativeRunId ?? null)
          && JSON.stringify(priorAck.artifactRangeStart ?? null) === JSON.stringify(artifactRangeStart)) return copy(snapshot)
        throw fail('child_ack_conflict')
      }
      return commit((next, at) => {
      const node = next.nodes[input.nodeId]
      const late = node.attempt === input.attempt
        && (node.attemptState === 'unknown' || node.attemptState === 'interrupted' || node.status === 'interrupted')
      next.events.push(eventFor(next, late ? 'child-ack-late' : 'child-ack', at, {
        nodeId: input.nodeId,
        attempt: input.attempt,
        requestId: input.requestId,
        toolCallId: ack.toolCallId,
        childId: ack.childId,
        nativeRunId: ack.nativeRunId ?? null,
        ...(artifactRangeStart === null ? {} : { artifactRangeStart }),
        source: 'tool-runtime',
      }))
      node.toolCallId = ack.toolCallId
      node.childId = ack.childId
      node.nativeRunId = ack.nativeRunId ?? null
      if (artifactRangeStart !== null) node.artifactRangeStart = artifactRangeStart
      if (!late) node.attemptState = 'acknowledged'
      })
    })
  }

  async function executeAttempt(input, execute) {
    if (typeof execute !== 'function') throw fail('executor_callback_required')
    await enqueue(async () => {
      await refreshSnapshot()
      assertAttempt(input)
      const priorAttempt = snapshot.nodes[input.nodeId].attempt
      if (input.attempt !== priorAttempt + 1) throw fail('attempt_sequence_mismatch')
      if (priorAttempt > 0 && input.confirmNewAttempt !== true) throw fail('new_attempt_confirmation_required')
      const priorState = snapshot.nodes[input.nodeId]
      if (['running', 'waiting'].includes(priorState.status)
        || ['started', 'acknowledged'].includes(priorState.attemptState)) throw fail('attempt_still_active')
      if (snapshot.events.some(event => event.type === 'attempt-started'
        && event.nodeId === input.nodeId && event.attempt === input.attempt)) {
        throw fail('attempt_already_started')
      }
      return commit((next, at) => {
      const node = next.nodes[input.nodeId]
      node.status = 'running'
      node.attempt = input.attempt
      node.attemptState = 'started'
      node.requestId = input.requestId
      node.toolCallId = null
      node.childId = null
      node.nativeRunId = null
      node.output = ''
      node.error = ''
      node.artifacts = []
      node.artifactSource = 'unknown'
      delete node.artifactEvidence
      delete node.artifactRangeStart
      next.status = 'running'
      next.finishedAt = null
      next.events.push(eventFor(next, 'attempt-started', at, {
        nodeId: input.nodeId,
        attempt: input.attempt,
        requestId: input.requestId,
        source: 'native-executor',
        status: 'running',
      }))
      })
    })

    const context = Object.freeze({
      workflowRunId: snapshot.id,
      nodeId: input.nodeId,
      attempt: input.attempt,
      requestId: input.requestId,
      bindingRevision: snapshot.bindingRevision,
      definitionRevision: snapshot.definitionRevision,
      parentAgentId: snapshot.parentAgentId,
      sessionId: snapshot.sessionId,
      recordChildAck: ack => recordChildAck(input, ack),
    })

    let observation
    try {
      observation = await execute(context)
    } catch (error) {
      const errorCategory = nonEmptyString(error?.code, 128) ? error.code
        : nonEmptyString(error?.name, 128) ? error.name : 'EXECUTOR_ERROR'
      const errorMessage = nonEmptyString(error?.message, 1000) ? error.message : 'Native executor failed without a verified terminal result'
      const persistence = await enqueue(async () => {
        await refreshSnapshot()
        const terminalReason = terminalWriteBlockReason(snapshot, input)
        if (terminalReason) return { snapshot: copy(snapshot), ignored: true, persisted: false, ignoreReason: terminalReason }
        if (!assertCurrentAttempt(snapshot, input)) return persistLateResult(input, null, 'STALE_ATTEMPT_ERROR')
        const savedSnapshot = await commit((next, at) => {
        const node = next.nodes[input.nodeId]
        node.status = 'unknown'
        node.attemptState = 'unknown'
        node.error = errorCategory
        aggregateRun(next, at)
        next.events.push(eventFor(next, 'attempt-error', at, {
          nodeId: input.nodeId,
          attempt: input.attempt,
          requestId: input.requestId,
          toolCallId: node.toolCallId,
          childId: node.childId,
          nativeRunId: node.nativeRunId,
          source: 'native-executor',
          status: 'unknown',
          errorCategory,
          output: errorMessage,
        }))
        })
        return { snapshot: savedSnapshot, ignored: false, persisted: true, ignoreReason: null }
      })
      if (persistence.ignored) {
        const ignoredError = fail('attempt_result_ignored', error)
        ignoredError.journalOutcome = persistence
        throw ignoredError
      }
      throw error
    }

    const persisted = await enqueue(async () => {
      await refreshSnapshot()
      const terminalReason = terminalWriteBlockReason(snapshot, input)
      if (terminalReason) {
        return { snapshot: copy(snapshot), ignored: true, persisted: false, ignoreReason: terminalReason }
      }
      if (!assertCurrentAttempt(snapshot, input)) {
        return persistLateResult(input, observation, 'STALE_ATTEMPT_RESULT')
      }
      const mismatchFields = identityMismatch(observation, input, snapshot)
      const normalized = mismatchFields.length > 0
        ? { status: 'unknown', attemptState: 'unknown', eventType: 'attempt-identity-mismatch', errorCategory: 'IDENTITY_MISMATCH' }
        : observationState(observation)
      const savedSnapshot = await commit((next, at) => {
      const node = next.nodes[input.nodeId]
      node.status = normalized.status
      node.attemptState = normalized.attemptState
      node.requestId = input.requestId
      if (mismatchFields.length === 0) {
        node.toolCallId = observation?.toolCallId ?? node.toolCallId
        node.childId = observation?.childId ?? node.childId
        node.nativeRunId = observation?.nativeRunId ?? node.nativeRunId
        node.output = observation?.output ?? ''
      }
      node.error = normalized.errorCategory ?? ''
      // Declarations are not file-creation proof or immutable content copies.
      node.artifacts = []
      node.artifactSource = 'unknown'
      delete node.artifactEvidence
      const evidence = mismatchFields.length === 0 && observation?.terminalSource === 'subagent/end'
        ? validateArtifactEvidence(observation.artifactEvidence, node.artifactRangeStart) : null
      if (evidence && evidence.range.childSessionId === node.childId && evidence.range.nativeRunId === node.nativeRunId) {
        node.artifactEvidence = evidence
        node.artifacts = evidence.declarations
        node.artifactSource = 'deliverables/presented'
      }
      aggregateRun(next, at)
      next.events.push(eventFor(next, normalized.eventType, at, {
        nodeId: input.nodeId,
        attempt: input.attempt,
        requestId: input.requestId,
        toolCallId: node.toolCallId,
        childId: node.childId,
        nativeRunId: node.nativeRunId,
        source: mismatchFields.length > 0 ? 'identity-check'
          : observation?.terminalSource === 'subagent/end' ? 'subagent/end'
          : observation?.terminalSource === 'tool-runtime' ? 'tool-runtime' : 'unknown',
        status: normalized.status,
        stopReason: observation?.stopReason,
        errorCategory: normalized.errorCategory,
        output: node.output,
        ...(node.artifactEvidence === undefined ? {} : { artifactEvidence: node.artifactEvidence }),
        identityMismatchFields: mismatchFields.length > 0 ? mismatchFields : undefined,
        reportedIdentity: mismatchFields.length > 0 ? reportedIdentity(observation) : undefined,
      }))
      })
      return { snapshot: savedSnapshot, ignored: false, persisted: true, ignoreReason: null }
    })
    return { observation, ...persisted }
  }

  async function executeLocalNode(input) {
    return enqueue(async () => {
      await refreshSnapshot()
      if (!isRecord(input) || !nonEmptyString(input.nodeId, 48)) throw fail('invalid_local_node')
      if (input.bindingRevision !== snapshot.bindingRevision) throw fail('binding_revision_mismatch')
      if (input.definitionRevision !== snapshot.definitionRevision) throw fail('definition_revision_mismatch')
      const definitionNode = snapshot.document.nodes.find(node => node.id === input.nodeId)
      const node = snapshot.nodes[input.nodeId]
      if (!definitionNode || !['input', 'output'].includes(definitionNode.kind)) throw fail('unsupported_node_kind')
      if (['done', 'failed', 'cancelled'].includes(snapshot.status)) {
        if (['done', 'failed', 'skipped'].includes(node.status)) return copy(snapshot)
        throw fail('run_is_terminal')
      }
      if (node.status !== 'pending') return copy(snapshot)
      if (snapshot.status === 'interrupted') {
        if (snapshot.cancelRequested === true) return copy(snapshot)
        throw fail('resume_confirmation_required')
      }
      if (snapshot.cancelRequested || input.signal?.aborted) {
        return commit((next, at) => {
          next.status = 'interrupted'; next.finishedAt = at
          next.events.push(eventFor(next, 'local-node-interrupted', at, { nodeId: input.nodeId, attempt: 0,
            requestId: null, source: 'workflow/local', status: 'interrupted', errorCategory: 'operation_aborted' }))
        })
      }
      const plan = planReadyNodes(snapshot.document, snapshot)
      if (plan.readyNodeIds[0] !== input.nodeId) throw fail('local_node_not_ready')
      let receipt, errorCode = null
      try { receipt = deriveWorkflowLocalReceipt(snapshot, definitionNode, { verifyReviewParent: verifiedReviewOutput }) }
      catch (error) {
        errorCode = ['upstream_terminal_unverified', 'upstream_output_unavailable', 'local_receipt_invalid', 'local_output_unavailable'].includes(error?.code)
          ? error.code : 'local_output_unavailable'
      }
      if (input.signal?.aborted || snapshot.cancelRequested) {
        return commit((next, at) => {
          next.status = 'interrupted'; next.finishedAt = at
          next.events.push(eventFor(next, 'local-node-interrupted', at, { nodeId: input.nodeId, attempt: 0,
            requestId: null, source: 'workflow/local', status: 'interrupted', errorCategory: 'operation_aborted' }))
        })
      }
      return commit((next, at) => {
        const target = next.nodes[input.nodeId]
        target.attempt = 0
        target.attemptState = errorCode ? 'local-error' : 'local'
        target.requestId = null; target.toolCallId = null; target.childId = null; target.nativeRunId = null
        target.artifacts = []; target.artifactSource = 'unknown'
        delete target.artifactEvidence; delete target.artifactRangeStart; delete target.localReceipt
        if (errorCode) {
          target.status = 'failed'; target.error = errorCode; target.output = ''
          next.events.push(eventFor(next, 'local-node-error', at, { nodeId: input.nodeId, attempt: 0,
            requestId: null, source: 'workflow/local', status: 'failed', errorCategory: errorCode }))
        } else {
          target.status = 'done'; target.error = ''; target.output = receipt.output; target.localReceipt = receipt
          next.events.push(eventFor(next, 'local-node-terminal', at, { nodeId: input.nodeId, attempt: 0,
            requestId: null, source: 'workflow/local', status: 'done', output: receipt.output, localReceipt: receipt }))
        }
        aggregateRun(next, at)
      })
    })
  }

  async function beginReview(input) {
    return enqueue(async () => {
      await refreshSnapshot()
      const definitionNode = snapshot.document.nodes.find(node => node.id === input?.nodeId)
      const node = snapshot.nodes[input?.nodeId]
      if (!definitionNode || definitionNode.kind !== 'review' || !node) throw fail('unsupported_node_kind')
      if (['done', 'failed', 'cancelled'].includes(snapshot.status) || snapshot.cancelRequested) throw fail('run_is_terminal')
      if (snapshot.status === 'interrupted') throw fail('resume_confirmation_required')
      if (node.status !== 'pending' || node.reviewState !== null) throw fail('review_request_conflict')
      if (input.bindingRevision !== snapshot.bindingRevision) throw fail('binding_revision_mismatch')
      if (input.definitionRevision !== snapshot.definitionRevision) throw fail('definition_revision_mismatch')
      if (!isRecord(input.request) || input.request.nodeId !== definitionNode.id || input.request.workflowRunId !== snapshot.id
        || input.request.bindingRevision !== snapshot.bindingRevision || input.request.definitionRevision !== snapshot.definitionRevision) throw fail('invalid_review_request')
      if (planReadyNodes(snapshot.document, snapshot).readyNodeIds[0] !== definitionNode.id) throw fail('review_node_not_ready')
      return commit((next, at) => {
        const target = next.nodes[definitionNode.id]
        target.status = 'waiting'; target.attempt = 0; target.attemptState = 'review-waiting'
        target.requestId = null; target.toolCallId = null; target.childId = null; target.nativeRunId = null
        target.output = ''; target.error = ''; target.artifacts = []; target.artifactSource = 'unknown'
        target.reviewState = { status: 'waiting', request: copy(input.request), receipt: null, error: '' }
        next.status = 'waiting'; next.finishedAt = null
        next.events.push(eventFor(next, 'review-node-waiting', at, { source: 'dsh-user-questions', nodeId: definitionNode.id,
          questionId: input.request.questionId, requestFingerprint: input.request.requestFingerprint, reviewRequest: input.request }))
      })
    })
  }

  async function deferReview(input) {
    return enqueue(async () => {
      await refreshSnapshot()
      const node = snapshot.nodes[input?.nodeId]
      const current = node?.reviewState
      if (terminalWriteBlockReason(snapshot, input)) return copy(snapshot)
      if (!node || !current || current.request.questionId !== input.questionId || node.status !== 'waiting'
        || snapshot.cancelRequested || !['waiting', 'deferred'].includes(current.status)) return copy(snapshot)
      const error = input.error === 'review_answer_invalid' ? 'review_answer_invalid' : 'review_unavailable'
      return commit((next, at) => {
        const target = next.nodes[input.nodeId]
        target.status = 'waiting'; target.attemptState = 'review-deferred'; target.error = error
        target.reviewState = { ...target.reviewState, status: 'deferred', error }
        next.status = 'waiting'; next.finishedAt = null
        next.events.push(eventFor(next, 'review-node-deferred', at, { source: 'dsh-user-questions', nodeId: input.nodeId,
          questionId: input.questionId, requestFingerprint: current.request.requestFingerprint,
          reviewRequest: current.request, errorCategory: error }))
      })
    })
  }

  async function interruptReview(input) {
    return enqueue(async () => {
      await refreshSnapshot()
      const node = snapshot.nodes[input?.nodeId]
      const current = node?.reviewState
      if (terminalWriteBlockReason(snapshot, input)) return copy(snapshot)
      if (!node || !current || current.request.questionId !== input.questionId || node.status !== 'waiting'
        || !['waiting', 'deferred'].includes(current.status)) return copy(snapshot)
      return commit((next, at) => {
        const target = next.nodes[input.nodeId]
        target.status = 'interrupted'; target.attemptState = 'review-interrupted'; target.error = 'operation_aborted'
        target.reviewState = { ...target.reviewState, status: 'interrupted', error: 'operation_aborted' }
        next.status = 'interrupted'; next.finishedAt = at
        next.events.push(eventFor(next, 'review-node-interrupted', at, { source: 'dsh-user-questions', nodeId: input.nodeId,
          questionId: input.questionId, requestFingerprint: current.request.requestFingerprint,
          reviewRequest: current.request, errorCategory: 'operation_aborted' }))
      })
    })
  }

  async function failReview(input) {
    return enqueue(async () => {
      await refreshSnapshot()
      const node = snapshot.nodes[input?.nodeId]
      const current = node?.reviewState
      if (terminalWriteBlockReason(snapshot, input)) return copy(snapshot)
      if (!node || !current || current.request.questionId !== input.questionId || node.status !== 'waiting'
        || snapshot.cancelRequested || !['waiting', 'deferred'].includes(current.status)) return copy(snapshot)
      return commit((next, at) => {
        const target = next.nodes[input.nodeId]
        target.status = 'failed'; target.attemptState = 'review-failed'; target.error = 'review_context_stale'
        target.reviewState = { ...target.reviewState, status: 'failed', error: 'review_context_stale' }
        aggregateRun(next, at)
        next.events.push(eventFor(next, 'review-node-error', at, { source: 'dsh-user-questions', nodeId: input.nodeId,
          questionId: input.questionId, requestFingerprint: current.request.requestFingerprint,
          reviewRequest: current.request, errorCategory: 'review_context_stale' }))
      })
    })
  }

  async function completeReview(input, proof, decisionChannel) {
    return enqueue(async () => {
      await refreshSnapshot()
      const node = snapshot.nodes[input?.nodeId]
      const current = node?.reviewState
      if (!node || !current || current.request.questionId !== input.questionId || node.status !== 'waiting'
        || current.status !== 'waiting' || snapshot.status !== 'waiting' || snapshot.cancelRequested) throw fail('review_request_stale')
      const issued = decisionChannel?.consume(proof, current.request)
      if (!issued) throw fail('review_decision_untrusted')
      const request = current.request
      const receipt = { source: 'dsh-user-questions', decision: issued.decision, questionId: request.questionId,
        requestFingerprint: request.requestFingerprint, workflowRunId: snapshot.id, workflowId: snapshot.workflowId,
        nodeId: input.nodeId, parentAgentId: snapshot.parentAgentId, sessionId: snapshot.sessionId,
        bindingRevision: snapshot.bindingRevision, definitionRevision: snapshot.definitionRevision,
        selected: issued.selected, requestedAt: request.requestedAt, answeredAt: issued.answeredAt,
        upstream: copy(request.upstream), output: issued.decision === 'approved' ? request.upstream.map(row => row.text).join('\n') : '',
        attempt: 0, requestId: null, toolCallId: null, childId: null, nativeRunId: null }
      return commit((next, at) => {
        const target = next.nodes[input.nodeId]
        const approved = issued.decision === 'approved'
        target.status = approved ? 'done' : 'failed'; target.attempt = 0
        target.attemptState = approved ? 'review-approved' : 'review-rejected'
        target.output = receipt.output; target.error = approved ? '' : 'review_rejected'
        target.requestId = null; target.toolCallId = null; target.childId = null; target.nativeRunId = null
        target.artifacts = []; target.artifactSource = 'unknown'; delete target.artifactEvidence; delete target.artifactRangeStart
        target.reviewState = { status: issued.decision, request: copy(request), receipt, error: approved ? '' : 'review_rejected' }
        aggregateRun(next, at)
        next.events.push(eventFor(next, 'review-node-terminal', at, { source: 'dsh-user-questions', nodeId: input.nodeId,
          status: issued.decision, questionId: request.questionId, requestFingerprint: request.requestFingerprint,
          reviewReceipt: receipt }))
      })
    })
  }
  return Object.freeze({
    getSnapshot: () => copy(snapshot),
    async inspectResume() {
      return enqueue(async () => { await refreshSnapshot(); return copy(resumeCandidates(snapshot)) })
    },
    async requestCancel(input) {
      return enqueue(async () => {
        await refreshSnapshot()
        if (operationEvent(snapshot, 'cancel-requested', input)) return { snapshot: copy(snapshot), reused: true }
        if (['done', 'failed', 'cancelled'].includes(snapshot.status)) return { snapshot: copy(snapshot), reused: false, alreadyTerminal: true }
        const saved = await commit((next, at) => {
          next.cancelRequested = true
          next.status = 'interrupted'; next.finishedAt = at
          next.events.push(eventFor(next, 'cancel-requested', at, { source: 'native-run-service', operationId: input.operationId, operationFingerprint: input.fingerprint }))
        })
        return { snapshot: saved, reused: false }
      })
    },
    async claimResume(input) {
      return enqueue(async () => {
        await refreshSnapshot()
        const prior = operationEvent(snapshot, 'resume-claimed', input)
        if (prior) {
          if (JSON.stringify(prior.nodeIds) !== JSON.stringify(input.nodeIds)) throw fail('operation_conflict')
          return { snapshot: copy(snapshot), reused: true }
        }
        if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision !== snapshot.revision) throw fail('resume_revision_conflict')
        const plan = resumeCandidates(snapshot)
        if (!plan.eligible || JSON.stringify(input.nodeIds) !== JSON.stringify(plan.eligibleNodeIds)) throw fail('resume_blocked')
        const saved = await commit((next, at) => {
          for (const nodeId of plan.eligibleNodeIds) {
            const target = next.nodes[nodeId]
            target.status = 'pending'
            if (next.document.nodes.find(item => item.id === nodeId)?.kind === 'review') {
              target.reviewState = null; target.error = ''; target.output = ''; target.attemptState = 'none'
            }
          }
          next.status = 'running'; next.finishedAt = null; next.cancelRequested = false
          next.resumeOperationId = input.operationId
          next.events.push(eventFor(next, 'resume-claimed', at, { source: 'native-run-service', operationId: input.operationId,
            operationFingerprint: input.fingerprint, nodeIds: plan.eligibleNodeIds }))
        })
        return { snapshot: saved, reused: false }
      })
    },
    async settleBlockedNodes() {
      return enqueue(async () => {
        await refreshSnapshot()
        if (['done', 'failed', 'cancelled'].includes(snapshot.status)) return copy(snapshot)
        const { blockedNodes } = planReadyNodes(snapshot.document, snapshot)
        if (!blockedNodes.length) return copy(snapshot)
        return commit((next, at) => {
          for (const { nodeId, blockedBy } of blockedNodes) {
            const node = next.nodes[nodeId]
            node.status = 'skipped'
            node.error = 'UPSTREAM_FAILED'
            node.blockedBy = blockedBy
            next.events.push(eventFor(next, 'node-blocked', at, { nodeId, status: 'skipped',
              errorCategory: 'UPSTREAM_FAILED', blockedBy, source: 'native-run-journal' }))
          }
          aggregateRun(next, at)
        })
      })
    },
    executeLocalNode,
    beginReview,
    deferReview,
    interruptReview,
    failReview,
    completeReview: (input, proof) => completeReview(input, proof, reviewDecisionChannel),
    executeAttempt,
    recordChildAck,
    flush: () => tail,
  })
}

function createSnapshot(input, id, now) {
  const createdAt = timestamp(now)
  const nodes = Object.fromEntries(input.document.nodes.map(node => [node.id, newNodeState(node.kind)]))
  const snapshot = {
    journalSchema: JOURNAL_SCHEMA,
    id,
    workflowId: input.workflowId,
    title: input.document.title,
    executionMode: 'native_dsh',
    status: 'running',
    revision: 1,
    startedAt: createdAt,
    finishedAt: null,
    document: copy(input.document),
    nodes,
    requestId: input.requestId,
    parentAgentId: input.parentAgentId,
    sessionId: input.sessionId,
    bindingRevision: input.bindingRevision,
    definitionRevision: input.definitionRevision,
    events: [],
  }
  snapshot.events.push(eventFor(snapshot, 'run-created', createdAt, { source: 'native-run-journal' }))
  return validateSnapshot(snapshot)
}

function recoverSnapshot(snapshot, at) {
  const next = copy(snapshot)
  if (!Array.isArray(next.events)) next.events = []
  let changed = false
  for (const [nodeId, node] of Object.entries(next.nodes ?? {})) {
    if (!isRecord(node) || !['running', 'waiting'].includes(node.status)) continue
    const definitionNode = next.document.nodes.find(item => item.id === nodeId)
    if (definitionNode?.kind === 'review' && node.reviewState?.request) {
      const request = node.reviewState.request
      node.status = 'interrupted'; node.attemptState = 'review-interrupted'; node.error = 'PROCESS_RESTARTED'
      node.reviewState = { ...node.reviewState, status: 'interrupted', error: 'PROCESS_RESTARTED' }
      next.events.push(eventFor(next, 'review-node-interrupted', at, { nodeId, questionId: request.questionId,
        requestFingerprint: request.requestFingerprint, reviewRequest: request, source: 'dsh-user-questions',
        status: 'interrupted', errorCategory: 'PROCESS_RESTARTED' }))
      changed = true
      continue
    }
    node.status = 'interrupted'
    node.attemptState = 'interrupted'
    node.error = node.error || 'PROCESS_RESTARTED'
    next.events.push(eventFor(next, 'node-interrupted', at, {
      nodeId,
      attempt: Number.isSafeInteger(node.attempt) ? node.attempt : null,
      requestId: node.requestId ?? next.requestId,
      toolCallId: node.toolCallId,
      childId: node.childId,
      nativeRunId: node.nativeRunId,
      source: 'startup-recovery',
      status: 'interrupted',
      errorCategory: 'PROCESS_RESTARTED',
    }))
    changed = true
  }
  next.status = 'interrupted'
  next.finishedAt = at
  if (snapshot.status !== 'interrupted') {
    next.events.push(eventFor(next, 'run-interrupted', at, {
      source: 'startup-recovery',
      status: 'interrupted',
      errorCategory: 'PROCESS_RESTARTED',
    }))
  }
  return { snapshot: next, changed: changed || snapshot.status !== 'interrupted' }
}

export function createWorkflowRunJournal({ store, now = () => new Date(), createRunId = randomUUID, reviewDecisionChannel } = {}) {
  validateStore(store)
  if (typeof now !== 'function' || typeof createRunId !== 'function') throw new TypeError('now and createRunId must be functions')

  return Object.freeze({
    async create(input) {
      const normalized = validateCreateInput(input, createRunId)
      if (await store.get(normalized.id)) throw fail('run_id_already_exists')
      const snapshot = createSnapshot(normalized, normalized.id, now)
      let saved
      try { saved = await store.save(snapshot, 0) } catch (error) { throw fail('run_create_persistence_failed', error) }
      if (!isRecord(saved) || saved.id !== snapshot.id || saved.revision !== 1) throw fail('invalid_store_save_response')
      return makeRunHandle(store, saved, { now, reviewDecisionChannel })
    },

    async open(workflowRunId) {
      if (typeof workflowRunId !== 'string' || !UUID.test(workflowRunId)) throw fail('invalid_run_id')
      const snapshot = await store.get(workflowRunId)
      if (!snapshot) return null
      if (snapshot.journalSchema !== JOURNAL_SCHEMA || snapshot.executionMode !== 'native_dsh') {
        throw fail('unsupported_journal_snapshot')
      }
      validateSnapshot(snapshot)
      if (snapshot.id !== workflowRunId) throw fail('invalid_store_get_response')
      return makeRunHandle(store, snapshot, { now, reviewDecisionChannel })
    },

    async recoverInterruptedRuns() {
      const rows = await store.list({ activeOnly: true })
      if (!Array.isArray(rows)) throw fail('invalid_store_list_response')
      if (rows.length >= MAX_RECOVERY_ROWS) throw fail('recovery_page_limit')
      const recovered = []
      const unmanaged = []
      for (const row of rows) {
        if (!isRecord(row) || typeof row.id !== 'string' || !UUID.test(row.id)) throw fail('invalid_store_list_response')
        if (!['running', 'waiting', 'interrupted'].includes(row.status)) continue
        const snapshot = await store.get(row.id)
        if (!snapshot || snapshot.id !== row.id) throw fail('recovery_run_missing')
        if (snapshot.journalSchema !== JOURNAL_SCHEMA || snapshot.executionMode !== 'native_dsh') {
          unmanaged.push({ id: row.id, status: row.status, reason: 'unsupported_journal_or_execution_mode' })
          continue
        }
        validateSnapshot(snapshot)
        if (!['running', 'waiting', 'interrupted'].includes(snapshot.status)) continue
        const at = timestamp(now)
        const result = recoverSnapshot(snapshot, at)
        if (!result.changed) continue
        result.snapshot.revision = snapshot.revision + 1
        validateSnapshot(result.snapshot)
        let saved
        try { saved = await store.save(result.snapshot, snapshot.revision) }
        catch (error) { throw fail('recovery_persistence_failed', error) }
        if (!isRecord(saved) || saved.id !== snapshot.id || saved.revision !== snapshot.revision + 1) {
          throw fail('invalid_store_save_response')
        }
        recovered.push(copy(saved))
      }
      return { recovered, unmanaged }
    },
  })
}
