import { createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { verifiedWorkflowParent } from './workflow-local-nodes.js'

const SOURCE = 'dsh-user-questions'
export const REVIEW_APPROVE = '批准'
export const REVIEW_REJECT = '拒绝'
const fail = code => Object.assign(new Error(`Workflow review: ${code}`), { code })
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const nonEmpty = value => typeof value === 'string' && value.trim().length > 0
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/

function parents(run, nodeId) {
  const ids = new Set(run.document.edges.filter(edge => edge.to === nodeId).map(edge => edge.from))
  return run.document.nodes.filter(node => ids.has(node.id))
}

function fingerprint(value) {
  return createHash('sha256').update(JSON.stringify(value), 'utf8').digest('hex')
}

function reviewContext(run, node) {
  if (node?.kind !== 'review') throw fail('unsupported_node_kind')
  const upstream = parents(run, node.id).map(parent => verifiedWorkflowParentForReview(run, parent))
  return { instruction: node.instruction ?? '', upstream,
    output: upstream.map(item => item.text).join('\n') }
}

function contextFingerprint(nodeId, context) {
  return fingerprint({ nodeId, instruction: context.instruction, upstream: context.upstream })
}

export function formatWorkflowReviewDetail(request) {
  return [request.instruction ? `审核要求：\n${request.instruction}` : '请审核以下工作流结果。',
    ...request.upstream.map(item => `上游节点「${item.nodeId}」：\n${item.text}`)].join('\n\n')
}

export function createWorkflowReviewRequest(run, node, questionId, requestedAt) {
  if (!record(run) || !record(node) || node.kind !== 'review' || !UUID.test(questionId ?? '')
    || typeof requestedAt !== 'string' || !Number.isFinite(Date.parse(requestedAt))) throw fail('review_request_invalid')
  const context = reviewContext(run, node)
  const request = {
    source: SOURCE, questionId, requestFingerprint: contextFingerprint(node.id, context), requestedAt,
    workflowRunId: run.id, workflowId: run.workflowId, nodeId: node.id,
    parentAgentId: run.parentAgentId, sessionId: run.sessionId,
    bindingRevision: run.bindingRevision, definitionRevision: run.definitionRevision,
    instruction: context.instruction, upstream: context.upstream,
    options: [REVIEW_APPROVE, REVIEW_REJECT],
  }
  return {
    request,
    question: {
      id: questionId,
      header: '工作流审核',
      question: node.title,
      detail: formatWorkflowReviewDetail(request),
      options: [
        { label: REVIEW_APPROVE, description: '批准并继续工作流' },
        { label: REVIEW_REJECT, description: '拒绝并停止后续节点' },
      ],
    },
  }
}

export function validateWorkflowReviewState(run, node) {
  const nodeState = run.nodes?.[node?.id]
  const state = nodeState?.reviewState
  if (!record(state) || !['waiting', 'deferred', 'interrupted', 'approved', 'rejected', 'failed'].includes(state.status)
    || nodeState.attempt !== 0 || ['requestId', 'toolCallId', 'childId', 'nativeRunId'].some(key => nodeState[key] !== null)
    || nodeState.artifactSource !== 'unknown' || !Array.isArray(nodeState.artifacts) || nodeState.artifacts.length !== 0
    || Object.hasOwn(nodeState, 'artifactEvidence') || Object.hasOwn(nodeState, 'artifactRangeStart')
    || Object.hasOwn(nodeState, 'localReceipt')
    || !record(state.request) || state.request.source !== SOURCE
    || state.request.workflowRunId !== run.id || state.request.workflowId !== run.workflowId
    || state.request.nodeId !== node.id || state.request.parentAgentId !== run.parentAgentId
    || state.request.sessionId !== run.sessionId || state.request.bindingRevision !== run.bindingRevision
    || state.request.definitionRevision !== run.definitionRevision || !UUID.test(state.request.questionId ?? '')
    || typeof state.request.requestedAt !== 'string' || !Number.isFinite(Date.parse(state.request.requestedAt))) {
    throw fail('review_receipt_invalid')
  }
  const context = reviewContext(run, node)
  if (state.request.instruction !== context.instruction || !isDeepStrictEqual(state.request.upstream, context.upstream)
    || state.request.requestFingerprint !== contextFingerprint(node.id, context)
    || !isDeepStrictEqual(state.request.options, [REVIEW_APPROVE, REVIEW_REJECT])) throw fail('review_receipt_invalid')
  if (state.status === 'approved' || state.status === 'rejected') {
    const receipt = state.receipt
    const decision = state.status === 'approved' ? 'approved' : 'rejected'
    const selected = decision === 'approved' ? REVIEW_APPROVE : REVIEW_REJECT
    if (!record(receipt) || receipt.source !== SOURCE || receipt.decision !== decision
      || receipt.questionId !== state.request.questionId || receipt.requestFingerprint !== state.request.requestFingerprint
      || receipt.workflowRunId !== run.id || receipt.workflowId !== run.workflowId || receipt.nodeId !== node.id
      || receipt.parentAgentId !== run.parentAgentId || receipt.sessionId !== run.sessionId
      || receipt.bindingRevision !== run.bindingRevision || receipt.definitionRevision !== run.definitionRevision
      || receipt.selected !== selected || receipt.requestedAt !== state.request.requestedAt
      || typeof receipt.answeredAt !== 'string' || !Number.isFinite(Date.parse(receipt.answeredAt))
      || !isDeepStrictEqual(receipt.upstream, context.upstream)
      || receipt.output !== (decision === 'approved' ? context.output : '')
      || receipt.attempt !== 0 || ['requestId', 'toolCallId', 'childId', 'nativeRunId'].some(key => receipt[key] !== null)) {
      throw fail('review_receipt_invalid')
    }
    const expectedNodeStatus = state.status === 'approved' ? 'done' : 'failed'
    if (nodeState.status !== expectedNodeStatus || nodeState.attemptState !== `review-${state.status}`
      || nodeState.output !== receipt.output || nodeState.error !== (state.status === 'approved' ? '' : 'review_rejected')) throw fail('review_receipt_invalid')
    const event = run.events?.findLast(row => row.type === 'review-node-terminal' && row.source === SOURCE
      && row.workflowRunId === run.id && row.nodeId === node.id && row.status === decision
      && row.questionId === receipt.questionId && row.requestFingerprint === receipt.requestFingerprint
      && isDeepStrictEqual(row.reviewReceipt, receipt))
    if (!event) throw fail('review_receipt_invalid')
    return { state, receipt, context }
  }
  const eventType = state.status === 'waiting' ? 'review-node-waiting'
    : state.status === 'deferred' ? 'review-node-deferred'
      : state.status === 'interrupted' ? 'review-node-interrupted' : 'review-node-error'
  const event = run.events?.findLast(row => row.type === eventType && row.source === SOURCE
    && row.workflowRunId === run.id && row.nodeId === node.id && row.questionId === state.request.questionId
    && row.requestFingerprint === state.request.requestFingerprint
    && (state.status === 'waiting' || row.errorCategory === state.error)
    && isDeepStrictEqual(row.reviewRequest, state.request))
  if (!event) throw fail('review_receipt_invalid')
  const expectedNodeStatus = state.status === 'interrupted' ? 'interrupted' : state.status === 'failed' ? 'failed' : 'waiting'
  const allowedError = state.status === 'interrupted' ? ['operation_aborted', 'PROCESS_RESTARTED', 'OWNER_LEASE_EXPIRED']
    : state.status === 'failed' ? ['review_context_stale'] : state.status === 'deferred' ? ['review_unavailable', 'review_answer_invalid'] : ['']
  if (nodeState.status !== expectedNodeStatus || nodeState.attemptState !== `review-${state.status}`
    || !allowedError.includes(state.error) || nodeState.error !== state.error || nodeState.output !== '') throw fail('review_receipt_invalid')
  return { state, receipt: null, context }
}

export function validateWorkflowReviewReceipt(run, node) {
  const { state, receipt } = validateWorkflowReviewState(run, node)
  if (state.status !== 'approved' && state.status !== 'rejected') throw fail('review_receipt_invalid')
  return receipt
}

export function verifiedReviewOutput(run, node) {
  const { state, receipt } = validateWorkflowReviewState(run, node)
  if (state.status !== 'approved' || !receipt) throw fail('upstream_review_unverified')
  return { nodeId: node.id, kind: 'review', source: SOURCE, text: receipt.output, artifactReferences: [] }
}

export function verifiedWorkflowParentForReview(run, node) {
  return node?.kind === 'review' ? verifiedReviewOutput(run, node)
    : verifiedWorkflowParent(run, node, { verifyReviewParent: verifiedReviewOutput })
}

/** One-use in-process proof channel; JSON/tool arguments cannot construct a decision. */
export function createWorkflowReviewDecisionChannel() {
  const issued = new WeakMap()
  return Object.freeze({
    issue(answer, request, answeredAt) {
      if (!record(answer) || Object.keys(answer).some(key => key !== 'answers')
        || !Array.isArray(answer.answers) || answer.answers.length !== 1 || !record(answer.answers[0])) return null
      const row = answer.answers[0]
      if (Object.keys(row).some(key => !['id', 'selected', 'custom'].includes(key))
        || row.id !== request.questionId || !Array.isArray(row.selected) || row.selected.length !== 1
        || row.custom !== undefined && row.custom !== '' || ![REVIEW_APPROVE, REVIEW_REJECT].includes(row.selected[0])) return null
      const decision = row.selected[0] === REVIEW_APPROVE ? 'approved' : 'rejected'
      const proof = Object.freeze(Object.create(null))
      issued.set(proof, { decision, selected: row.selected[0], request: structuredClone(request), answeredAt })
      return proof
    },
    consume(proof, expected) {
      if (!proof || (typeof proof !== 'object' && typeof proof !== 'function')) throw fail('review_decision_untrusted')
      const value = issued.get(proof)
      if (!value) throw fail('review_decision_untrusted')
      issued.delete(proof)
      const request = value.request
      for (const key of ['workflowRunId', 'workflowId', 'nodeId', 'parentAgentId', 'sessionId', 'bindingRevision', 'definitionRevision', 'questionId', 'requestFingerprint']) {
        const requestKey = key === 'questionId' || key === 'requestFingerprint' ? key : key
        if (request[requestKey] !== expected[requestKey]) throw fail('review_request_stale')
      }
      return { ...value, request }
    },
  })
}
