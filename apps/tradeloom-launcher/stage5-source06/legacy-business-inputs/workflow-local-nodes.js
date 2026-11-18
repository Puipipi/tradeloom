import { isDeepStrictEqual } from 'node:util'
import { validateArtifactEvidence } from './workflow-artifact-source.js'

const LOCAL_SOURCE = 'workflow/local'
const LOCAL_TERMINAL = 'local-node-terminal'
const fail = code => Object.assign(new Error(`Workflow local node: ${code}`), { code })
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const nonEmpty = value => typeof value === 'string' && value.trim().length > 0

export function validateNativeWorkflowGraph(document) {
  if (!Array.isArray(document?.nodes) || !Array.isArray(document?.edges)
    || !document.nodes.length || document.nodes.length > 40 || document.edges.length > 80
    || document.nodes.some(node => !['input', 'agent', 'review', 'output'].includes(node?.kind))
    || !document.nodes.some(node => node.kind === 'agent') || document.edges.some(edge => edge.from === edge.to)) {
    throw fail('unsupported_workflow_graph')
  }
  return document.nodes
}

function directParents(run, nodeId) {
  const ids = new Set(run.document.edges.filter(edge => edge.to === nodeId).map(edge => edge.from))
  return run.document.nodes.filter(node => ids.has(node.id))
}

function verifiedAgentOutput(run, definitionNode) {
  const state = run.nodes?.[definitionNode.id]
  const fullIdentity = state?.status === 'done' && Number.isSafeInteger(state.attempt) && state.attempt > 0
    && ['requestId', 'toolCallId', 'childId', 'nativeRunId'].every(key => nonEmpty(state[key]))
    && ['parentAgentId', 'sessionId', 'bindingRevision', 'definitionRevision'].every(key => nonEmpty(run[key]))
  const receipt = fullIdentity && run.events?.findLast(event => event.type === 'node-terminal'
    && event.source === 'subagent/end' && event.status === 'done' && event.stopReason === 'completed'
    && event.workflowRunId === run.id && event.nodeId === definitionNode.id
    && ['parentAgentId', 'sessionId', 'bindingRevision', 'definitionRevision'].every(key => event[key] === run[key])
    && ['attempt', 'requestId', 'toolCallId', 'childId', 'nativeRunId'].every(key => event[key] === state[key]))
  if (!receipt || !isDeepStrictEqual(receipt.output, state.output)) throw fail('upstream_terminal_unverified')
  let text = receipt.output ?? ''
  if (Array.isArray(text)) {
    if (!text.every(block => block?.type === 'text' && typeof block.text === 'string')) throw fail('upstream_output_unavailable')
    text = text.map(block => block.text).join('\n')
  }
  if (typeof text !== 'string') throw fail('upstream_output_unavailable')
  const evidence = validateArtifactEvidence(receipt.artifactEvidence, state.artifactRangeStart)
  const verifiedEvidence = evidence && evidence.range.childSessionId === state.childId && evidence.range.nativeRunId === state.nativeRunId
    && state.artifactSource === 'deliverables/presented' && isDeepStrictEqual(evidence, state.artifactEvidence)
  return { nodeId: definitionNode.id, kind: 'agent', source: 'subagent/end', text,
    artifactReferences: verifiedEvidence ? evidence.declarations : [] }
}

function verifyLocalReceipt(run, definitionNode, visited = new Set(), verifyReviewParent = null) {
  if (visited.has(definitionNode.id)) throw fail('local_receipt_invalid')
  visited.add(definitionNode.id)
  const state = run.nodes?.[definitionNode.id]
  if (!record(state) || state.status !== 'done' || state.attempt !== 0 || state.attemptState !== 'local'
    || ['requestId', 'toolCallId', 'childId', 'nativeRunId'].some(key => state[key] !== null)
    || state.artifactSource !== 'unknown' || !Array.isArray(state.artifacts) || state.artifacts.length !== 0
    || Object.hasOwn(state, 'artifactEvidence') || Object.hasOwn(state, 'artifactRangeStart')) throw fail('local_receipt_invalid')
  const receipt = state.localReceipt
  const expectedKeys = ['source', 'mode', 'workflowRunId', 'workflowId', 'nodeId', 'definitionRevision', 'bindingRevision', 'attempt',
    'requestId', 'toolCallId', 'childId', 'nativeRunId', 'upstream', 'output']
  if (!record(receipt) || Object.keys(receipt).length !== expectedKeys.length || expectedKeys.some(key => !Object.hasOwn(receipt, key))
    || receipt.source !== LOCAL_SOURCE || receipt.mode !== definitionNode.kind || receipt.workflowRunId !== run.id
    || receipt.workflowId !== run.workflowId || receipt.nodeId !== definitionNode.id
    || receipt.definitionRevision !== run.definitionRevision || receipt.bindingRevision !== run.bindingRevision
    || receipt.attempt !== 0 || receipt.requestId !== null || receipt.toolCallId !== null || receipt.childId !== null || receipt.nativeRunId !== null
    || !Array.isArray(receipt.upstream) || typeof receipt.output !== 'string' || state.output !== receipt.output) throw fail('local_receipt_invalid')
  const event = run.events?.findLast(row => row.type === LOCAL_TERMINAL && row.source === LOCAL_SOURCE
    && row.workflowRunId === run.id && row.nodeId === definitionNode.id)
  if (!event || event.status !== 'done' || event.attempt !== 0 || event.requestId !== null || event.toolCallId !== null
    || event.childId !== null || event.nativeRunId !== null || event.parentAgentId !== run.parentAgentId || event.sessionId !== run.sessionId
    || event.bindingRevision !== run.bindingRevision || event.definitionRevision !== run.definitionRevision
    || event.artifactSource !== 'unknown' || !Array.isArray(event.artifacts) || event.artifacts.length !== 0
    || !isDeepStrictEqual(event.localReceipt, receipt) || event.output !== receipt.output) throw fail('local_receipt_invalid')

  let expectedOutput, expectedUpstream
  if (definitionNode.kind === 'input') {
    expectedUpstream = []
    expectedOutput = definitionNode.instruction
  } else if (definitionNode.kind === 'output') {
    expectedUpstream = directParents(run, definitionNode.id).map(parent => {
      if (parent.kind === 'agent') return verifiedAgentOutput(run, parent)
      if (parent.kind === 'review') {
        if (typeof verifyReviewParent !== 'function') throw fail('upstream_terminal_unverified')
        return verifyReviewParent(run, parent)
      }
      const localReceipt = verifyLocalReceipt(run, parent, new Set(visited), verifyReviewParent)
      return { nodeId: parent.id, kind: parent.kind, source: LOCAL_SOURCE, text: localReceipt.output, artifactReferences: [] }
    })
    expectedOutput = expectedUpstream.map(parent => parent.text).join('\n')
  } else throw fail('local_receipt_invalid')
  if (!isDeepStrictEqual(receipt.upstream, expectedUpstream) || receipt.output !== expectedOutput) throw fail('local_receipt_invalid')
  return receipt
}

export function deriveWorkflowLocalReceipt(run, definitionNode, { verifyReviewParent = null } = {}) {
  if (!record(run) || !record(definitionNode) || !['input', 'output'].includes(definitionNode.kind)) throw fail('unsupported_node_kind')
  let upstream = [], output
  if (definitionNode.kind === 'input') output = definitionNode.instruction
  else {
    upstream = directParents(run, definitionNode.id).map(parent => parent.kind === 'agent'
      ? verifiedAgentOutput(run, parent)
      : parent.kind === 'review'
        ? (typeof verifyReviewParent === 'function' ? verifyReviewParent(run, parent) : (() => { throw fail('upstream_terminal_unverified') })())
        : { nodeId: parent.id, kind: parent.kind, source: LOCAL_SOURCE,
          text: verifyLocalReceipt(run, parent, new Set(), verifyReviewParent).output, artifactReferences: [] })
    output = upstream.map(parent => parent.text).join('\n')
  }
  if (typeof output !== 'string') throw fail('local_output_unavailable')
  return { source: LOCAL_SOURCE, mode: definitionNode.kind, workflowRunId: run.id, workflowId: run.workflowId,
    nodeId: definitionNode.id, definitionRevision: run.definitionRevision, bindingRevision: run.bindingRevision,
    attempt: 0, requestId: null, toolCallId: null, childId: null, nativeRunId: null, upstream, output }
}

export function validateWorkflowLocalReceipt(run, definitionNode, options = {}) {
  return verifyLocalReceipt(run, definitionNode, new Set(), options.verifyReviewParent ?? null)
}

/** Returns verified text and references for a direct graph parent only. */
export function verifiedWorkflowParent(run, definitionNode, { verifyReviewParent = null } = {}) {
  if (definitionNode.kind === 'agent') return verifiedAgentOutput(run, definitionNode)
  if (definitionNode.kind === 'review') {
    if (typeof verifyReviewParent !== 'function') throw fail('upstream_terminal_unverified')
    return verifyReviewParent(run, definitionNode)
  }
  const receipt = verifyLocalReceipt(run, definitionNode, new Set(), verifyReviewParent)
  return { nodeId: definitionNode.id, kind: definitionNode.kind, source: LOCAL_SOURCE, text: receipt.output, artifactReferences: [] }
}
