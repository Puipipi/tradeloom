import { isDeepStrictEqual } from 'node:util'
import { validateArtifactRangeStart, validateArtifactEvidence } from './workflow-artifact-source.js'
import { verifyWorkflowDefinition } from './workflow-definition.js'
import { ROLE_PRESETS } from './roles.js'
import { validateWorkflowLocalReceipt } from './workflow-local-nodes.js'
import { formatWorkflowReviewDetail, validateWorkflowReviewState, verifiedReviewOutput } from './workflow-review.js'

export const NATIVE_WORKFLOW_RUN_ID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/
const ERRORS = new Map([
  ...['invalid_input', 'invalid_native_workflow_arguments'].map(code => [code, 400]),
  ...['center_session_not_live', 'center_binding_mismatch', 'binding_revision_mismatch', 'definition_revision_mismatch', 'submission_identity_conflict', 'unsupported_workflow_graph', 'workflow_not_found', 'workflow_not_confirmed', 'NATIVE_PRESET_NOT_ALLOWED', 'run_not_found', 'run_node_role_not_allowed', 'review_answer_invalid', 'review_context_stale', 'review_rejected', 'review_request_stale', 'resume_confirmation_required'].map(code => [code, 409]),
  ...['unsupported_model_selection', 'upstream_terminal_unverified', 'upstream_output_unavailable', 'native_prompt_too_large', 'UPSTREAM_FAILED'].map(code => [code, 409]),
  ...['resume_blocked', 'resume_plan_conflict', 'resume_revision_conflict', 'operation_conflict', 'run_cancel_requested'].map(code => [code, 409]),
  ...['run_parent_mismatch', 'untrusted_parent', 'TOOL_POLICY_DENIED', 'TOOL_GUARD_DENIED', 'UNKNOWN_TOOL'].map(code => [code, 403]),
  ...['native_run_unavailable', 'native_task_origin_required', 'ui_origin_required', 'native_bridge_unavailable', 'native_workflow_unavailable', 'run_store_unavailable', 'service_closed', 'ABORTED_BEFORE_NATIVE_SUBMIT', 'TOOL_CANCELLED', 'submission_unverified', 'review_unavailable'].map(code => [code, 503]),
  ['operation_aborted', 503],
])
const fail = code => Object.assign(new Error(code), { code })
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value)
export function safeNativeWorkflowError(code) {
  return ERRORS.has(code) ? code : 'native_workflow_unavailable'
}

export function nativeWorkflowErrorStatus(code) {
  return ERRORS.get(code) ?? 503
}

function projectArtifactEvidence(node, receipt) {
  if (!receipt || node.artifactSource !== 'deliverables/presented' || receipt.artifactSource !== 'deliverables/presented') return null
  const start = validateArtifactRangeStart(node.artifactRangeStart)
  if (!start || start.childSessionId !== node.childId || start.nativeRunId !== node.nativeRunId) return null
  const current = validateArtifactEvidence(node.artifactEvidence, start)
  const terminal = validateArtifactEvidence(receipt.artifactEvidence, start)
  if (!current || !terminal || !isDeepStrictEqual(current, terminal)
    || !isDeepStrictEqual(node.artifacts, current.declarations)
    || !isDeepStrictEqual(receipt.artifacts, terminal.declarations)) return null
  return current
}

/** A receipt is a persisted journal identity match, never text from the model. */
export function projectNativeWorkflowRun(run) {
  if (!record(run) || run.executionMode !== 'native_dsh' || run.journalSchema !== 'tradeloom.native-run-journal/v1'
    || !NATIVE_WORKFLOW_RUN_ID.test(run.id ?? '') || !record(run.nodes)) throw fail('submission_unverified')
  let definition
  try { definition = verifyWorkflowDefinition(run.document, run.definitionRevision).document } catch { throw fail('submission_unverified') }
  if (definition.id !== run.workflowId || definition.nodes.some(node => !['input', 'agent', 'review', 'output'].includes(node.kind)
    || node.kind === 'agent' && node.agent === 'center') || !definition.nodes.some(node => node.kind === 'agent')
    || Object.keys(run.nodes).length !== definition.nodes.length
    || definition.nodes.some(node => !Object.hasOwn(run.nodes, node.id))) throw fail('submission_unverified')
  const nodes = definition.nodes.map(definitionNode => {
    const { id, kind, agent: roleId } = definitionNode
    const node = run.nodes[id]
    if (!record(node)) throw fail('submission_unverified')
    if (kind === 'review') {
      if (node.attempt !== 0 || ['requestId', 'toolCallId', 'childId', 'nativeRunId'].some(key => node[key] !== null)
        || node.artifactSource !== 'unknown' || !Array.isArray(node.artifacts) || node.artifacts.length !== 0
        || Object.hasOwn(node, 'artifactEvidence') || Object.hasOwn(node, 'artifactRangeStart') || Object.hasOwn(node, 'localReceipt')) {
        throw fail('submission_unverified')
      }
      const state = node.reviewState
      if (node.status === 'pending' && state == null) return { id, kind, executionSource: 'dsh-user-questions', status: 'pending',
        reviewStatus: 'pending', attempt: 0, childId: null, nativeRunId: null, toolCallId: null, output: '', error: '',
        artifactState: 'unknown', artifactEvidence: null, settled: false, succeeded: false, terminalReceipt: null }
      if (node.status === 'skipped' && state == null) {
        const blocked = Array.isArray(node.blockedBy) && node.blockedBy.length > 0
          && run.events.findLast(event => event.type === 'node-blocked' && event.source === 'native-run-journal'
            && event.nodeId === id && event.workflowRunId === run.id && event.status === 'skipped'
            && event.errorCategory === 'UPSTREAM_FAILED' && JSON.stringify(event.blockedBy) === JSON.stringify(node.blockedBy)
            && node.blockedBy.every(parentId => definition.edges.some(edge => edge.from === parentId && edge.to === id)
              && ['failed', 'skipped'].includes(run.nodes[parentId]?.status)))
        if (!blocked) throw fail('submission_unverified')
        return { id, kind, executionSource: 'dsh-user-questions', status: 'skipped', reviewStatus: 'blocked',
          attempt: 0, childId: null, nativeRunId: null, toolCallId: null, output: '', error: 'UPSTREAM_FAILED',
          artifactState: 'unknown', artifactEvidence: null, settled: true, succeeded: false,
          terminalReceipt: { source: 'native-run-journal', status: 'skipped', workflowRunId: run.id, nodeId: id,
            sequence: blocked.sequence, blockedBy: [...node.blockedBy] } }
      }
      let reviewed
      try { reviewed = validateWorkflowReviewState(run, definitionNode) } catch { throw fail('submission_unverified') }
      if (['waiting', 'deferred'].includes(state.status)) return { id, kind, executionSource: 'dsh-user-questions',
        status: 'waiting', reviewStatus: state.status, questionId: state.request.questionId, question: definitionNode.title,
        detail: formatWorkflowReviewDetail(state.request),
        options: [...state.request.options], attempt: 0, childId: null, nativeRunId: null, toolCallId: null,
        output: '', error: state.status === 'deferred' ? state.error : '', artifactState: 'unknown', artifactEvidence: null,
        settled: false, succeeded: false, terminalReceipt: null }
      if (state.status === 'approved' || state.status === 'rejected') {
        const receipt = reviewed.receipt
        return { id, kind, executionSource: 'dsh-user-questions', status: state.status === 'approved' ? 'done' : 'failed',
          reviewStatus: state.status, questionId: receipt.questionId, attempt: 0, childId: null, nativeRunId: null,
          toolCallId: null, output: receipt.output, error: state.status === 'rejected' ? 'review_rejected' : '',
          artifactState: 'unknown', artifactEvidence: null, reviewReceipt: receipt, settled: true,
          succeeded: state.status === 'approved', terminalReceipt: { source: 'dsh-user-questions', status: state.status,
            workflowRunId: run.id, nodeId: id, questionId: receipt.questionId, attempt: 0 } }
      }
      if (state.status === 'interrupted') return { id, kind, executionSource: 'dsh-user-questions', status: 'interrupted',
        reviewStatus: 'interrupted', questionId: state.request.questionId, attempt: 0, childId: null, nativeRunId: null,
        toolCallId: null, output: '', error: state.error, artifactState: 'unknown', artifactEvidence: null,
        settled: true, succeeded: false, terminalReceipt: { source: 'dsh-user-questions', status: 'interrupted',
          workflowRunId: run.id, nodeId: id, questionId: state.request.questionId, attempt: 0 } }
      if (state.status === 'failed') return { id, kind, executionSource: 'dsh-user-questions', status: 'failed',
        reviewStatus: 'unavailable', attempt: 0, childId: null, nativeRunId: null, toolCallId: null, output: '',
        error: state.error, artifactState: 'unknown', artifactEvidence: null, settled: true, succeeded: false,
        terminalReceipt: { source: 'dsh-user-questions', status: 'failed', workflowRunId: run.id, nodeId: id,
          questionId: state.request.questionId, attempt: 0 } }
      throw fail('submission_unverified')
    }
    if (kind === 'input' || kind === 'output') {
      if (node.status === 'done') {
        let localReceipt
        try { localReceipt = validateWorkflowLocalReceipt(run, definitionNode, { verifyReviewParent: verifiedReviewOutput }) } catch { throw fail('submission_unverified') }
        const event = run.events.findLast(row => row.type === 'local-node-terminal' && row.source === 'workflow/local'
          && row.workflowRunId === run.id && row.nodeId === id && row.status === 'done')
        return { id, kind, executionSource: 'workflow/local', status: 'done', attempt: 0, attemptState: 'local',
          childId: null, nativeRunId: null, toolCallId: null, output: localReceipt.output, error: '', artifactState: 'unknown',
          artifactEvidence: null, localReceipt, settled: true, succeeded: true,
          terminalReceipt: { source: 'workflow/local', status: 'completed', workflowRunId: run.id, nodeId: id,
            attempt: 0, sequence: event.sequence } }
      }
      const localError = node.status === 'failed' && run.events.findLast(row => row.type === 'local-node-error'
        && row.source === 'workflow/local' && row.workflowRunId === run.id && row.nodeId === id
        && row.status === 'failed' && row.errorCategory === node.error && row.attempt === 0
        && ['upstream_terminal_unverified', 'upstream_output_unavailable', 'local_receipt_invalid', 'local_output_unavailable'].includes(row.errorCategory)
        && row.requestId === null && row.toolCallId === null && row.childId === null && row.nativeRunId === null
        && ['parentAgentId', 'sessionId', 'bindingRevision', 'definitionRevision'].every(key => row[key] === run[key]))
      const blocked = node.status === 'skipped' && node.attempt === 0 && node.childId == null
        && node.toolCallId == null && node.nativeRunId == null && Array.isArray(node.blockedBy) && node.blockedBy.length > 0
        && run.events.findLast(event => event.type === 'node-blocked' && event.source === 'native-run-journal'
          && event.nodeId === id && event.workflowRunId === run.id && event.status === 'skipped'
          && event.errorCategory === 'UPSTREAM_FAILED' && ['parentAgentId', 'sessionId', 'bindingRevision', 'definitionRevision'].every(key => event[key] === run[key])
          && JSON.stringify(event.blockedBy) === JSON.stringify(node.blockedBy)
          && node.blockedBy.every(parentId => definition.edges.some(edge => edge.from === parentId && edge.to === id)
            && ['failed', 'skipped'].includes(run.nodes[parentId]?.status)))
      if (node.status === 'failed' && !localError || node.status === 'skipped' && !blocked
        || !['pending', 'failed', 'skipped'].includes(node.status) || node.attempt !== 0
        || ['requestId', 'toolCallId', 'childId', 'nativeRunId'].some(key => node[key] !== null)
        || node.artifactSource !== 'unknown' || !Array.isArray(node.artifacts) || node.artifacts.length !== 0
        || Object.hasOwn(node, 'localReceipt') || Object.hasOwn(node, 'artifactEvidence') || Object.hasOwn(node, 'artifactRangeStart')) throw fail('submission_unverified')
      const receipt = localError ? { source: 'workflow/local', status: 'failed', reason: safeNativeWorkflowError(node.error),
        workflowRunId: run.id, nodeId: id, attempt: 0,
        sequence: localError.sequence } : blocked ? { source: 'native-run-journal', status: 'skipped', reason: 'UPSTREAM_FAILED',
          workflowRunId: run.id, nodeId: id, sequence: blocked.sequence, blockedBy: [...node.blockedBy] } : null
      return { id, kind, executionSource: 'workflow/local', status: node.status, attempt: 0, attemptState: node.attemptState,
        childId: null, nativeRunId: null, toolCallId: null, output: '', error: node.error ? safeNativeWorkflowError(node.error) : '',
        artifactState: 'unknown', artifactEvidence: null, settled: Boolean(localError || blocked), succeeded: false, terminalReceipt: receipt }
    }
    if (Object.hasOwn(node, 'localReceipt')) throw fail('submission_unverified')
    const fullIdentity = record(node) && ['requestId', 'toolCallId', 'childId', 'nativeRunId'].every(key => typeof node[key] === 'string' && node[key])
      && ['parentAgentId', 'sessionId', 'bindingRevision', 'definitionRevision'].every(key => typeof run[key] === 'string' && run[key])
      && Number.isSafeInteger(node.attempt) && node.attempt > 0
    const receipt = fullIdentity && (Array.isArray(run.events) ? run.events : []).findLast(event => {
      if (event.source !== 'subagent/end' || typeof event.stopReason !== 'string' || !event.stopReason) return false
      const expectedStatus = event.stopReason === 'completed' ? 'done' : event.stopReason === 'aborted' ? 'interrupted' : 'failed'
      const expectedEvent = expectedStatus === 'done' ? 'node-terminal' : expectedStatus === 'interrupted' ? 'node-interrupted' : 'node-error'
      return event.type === expectedEvent && event.status === expectedStatus && node.status === expectedStatus
        && event.workflowRunId === run.id && event.nodeId === id && event.attempt === node.attempt
        && event.requestId === node.requestId && event.parentAgentId === run.parentAgentId && event.sessionId === run.sessionId
        && event.bindingRevision === run.bindingRevision && event.definitionRevision === run.definitionRevision
        && event.toolCallId === node.toolCallId && event.childId === node.childId && event.nativeRunId === node.nativeRunId
    })
    const blocked = node.status === 'skipped' && node.attempt === 0 && node.childId == null
      && node.toolCallId == null && node.nativeRunId == null && Array.isArray(node.blockedBy) && node.blockedBy.length > 0
      && (Array.isArray(run.events) ? run.events : []).findLast(event => event.type === 'node-blocked'
        && event.source === 'native-run-journal' && event.nodeId === id && event.workflowRunId === run.id
        && event.status === 'skipped' && event.errorCategory === 'UPSTREAM_FAILED'
        && ['parentAgentId', 'sessionId', 'bindingRevision', 'definitionRevision'].every(key => event[key] === run[key])
        && JSON.stringify(event.blockedBy) === JSON.stringify(node.blockedBy)
        && node.blockedBy.every(parentId => definition.edges.some(edge => edge.from === parentId && edge.to === id)
          && ['failed', 'skipped'].includes(run.nodes[parentId]?.status)))
    const succeeded = Boolean(receipt && receipt.stopReason === 'completed' && node.status === 'done')
    const artifactEvidence = projectArtifactEvidence(node, receipt)
    return { id, roleId, agentPreset: ROLE_PRESETS[roleId], status: node.status, attempt: node.attempt, attemptState: node.attemptState,
      childId: node.childId ?? null, nativeRunId: node.nativeRunId ?? null, toolCallId: node.toolCallId ?? null,
      output: node.output ?? '', error: node.error ? safeNativeWorkflowError(node.error) : '',
      artifactState: artifactEvidence ? 'declared' : 'unknown', artifactEvidence,
      settled: Boolean(receipt || blocked), succeeded, terminalReceipt: receipt ? { source: 'subagent/end',
        status: receipt.stopReason === 'completed' ? 'completed' : receipt.stopReason === 'aborted' ? 'interrupted' : 'failed',
        stopReason: receipt.stopReason, workflowRunId: run.id, nodeId: id, attempt: node.attempt, toolCallId: node.toolCallId,
        childId: node.childId, nativeRunId: node.nativeRunId, sequence: receipt.sequence }
        : blocked ? { source: 'native-run-journal', status: 'skipped', reason: 'UPSTREAM_FAILED',
          workflowRunId: run.id, nodeId: id, sequence: blocked.sequence, blockedBy: [...node.blockedBy] } : null }
  })
  const settled = nodes.length > 0 && nodes.every(node => node.settled)
  return { id: run.id, workflowId: run.workflowId, status: run.status, revision: run.revision,
    cancelRequested: run.cancelRequested === true,
    executionMode: 'native_dsh', definitionRevision: run.definitionRevision, bindingRevision: run.bindingRevision,
    sessionId: run.sessionId, nodes, provider: 'unknown', model: 'unknown',
    settled, succeeded: settled && run.status === 'done' && nodes.every(node => node.succeeded),
    terminalReceipt: settled ? nodes.map(node => node.terminalReceipt) : null }
}
