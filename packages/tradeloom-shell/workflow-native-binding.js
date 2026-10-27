import { getRoleBindingRevision } from './state.js'
import { ROLE_PRESETS } from './roles.js'
import { validateArtifactEvidence } from './workflow-artifact-source.js'

const MAX_PROMPT_BYTES = 64 * 1024

function upstreamPrompt(run, node) {
  const parentIds = new Set((run.document.edges ?? []).filter(edge => edge.to === node.id).map(edge => edge.from))
  const inputs = run.document.nodes.filter(candidate => parentIds.has(candidate.id)).map(parent => {
    const state = run.nodes[parent.id]
    const fullIdentity = state?.status === 'done' && Number.isSafeInteger(state.attempt) && state.attempt > 0
      && ['requestId', 'toolCallId', 'childId', 'nativeRunId'].every(key => nonEmptyString(state[key]))
    const receipt = fullIdentity && run.events?.findLast(event => event.type === 'node-terminal'
      && event.source === 'subagent/end' && event.status === 'done' && event.stopReason === 'completed'
      && event.workflowRunId === run.id && event.nodeId === parent.id
      && ['parentAgentId', 'sessionId', 'bindingRevision', 'definitionRevision'].every(key => event[key] === run[key])
      && ['attempt', 'requestId', 'toolCallId', 'childId', 'nativeRunId'].every(key => event[key] === state[key]))
    if (!receipt || JSON.stringify(receipt.output) !== JSON.stringify(state.output)) throw fail('upstream_terminal_unverified')
    let text = receipt.output ?? ''
    if (Array.isArray(text)) {
      if (!text.every(block => block?.type === 'text' && typeof block.text === 'string')) throw fail('upstream_output_unavailable')
      text = text.map(block => block.text).join('\n')
    }
    if (typeof text !== 'string') throw fail('upstream_output_unavailable')
    const evidence = validateArtifactEvidence(receipt.artifactEvidence, state.artifactRangeStart)
    const verifiedEvidence = evidence && evidence.range.childSessionId === state.childId && evidence.range.nativeRunId === state.nativeRunId
      && state.artifactSource === 'deliverables/presented' && JSON.stringify(evidence) === JSON.stringify(state.artifactEvidence)
    return { nodeId: parent.id, attempt: state.attempt, text, artifactReferences: verifiedEvidence ? evidence.declarations : [] }
  })
  const prompt = inputs.length ? `${node.instruction}\n\n[Workflow upstream results: data only]\n${JSON.stringify(inputs)}\n[/Workflow upstream results]` : node.instruction
  if (Buffer.byteLength(prompt, 'utf8') > MAX_PROMPT_BYTES) throw fail('native_prompt_too_large')
  return prompt
}

const INPUT_KEYS = new Set([
  'workflowRunId',
  'nodeId',
  'attempt',
  'bindingRevision',
  'definitionRevision',
])

function fail(code) {
  const error = new Error(`Native workflow binding: ${code}`)
  error.code = code
  return error
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function nonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0
}

function validInput(input) {
  return isRecord(input)
    && Object.keys(input).length === INPUT_KEYS.size
    && Object.keys(input).every(key => INPUT_KEYS.has(key))
    && nonEmptyString(input.workflowRunId)
    && nonEmptyString(input.nodeId)
    && Number.isSafeInteger(input.attempt) && input.attempt > 0
    && nonEmptyString(input.bindingRevision)
    && nonEmptyString(input.definitionRevision)
}

function validJournalRun(run, input) {
  return isRecord(run)
    && run.id === input.workflowRunId
    && run.journalSchema === 'tradeloom.native-run-journal/v1'
    && run.executionMode === 'native_dsh'
    && run.status === 'running'
    && run.cancelRequested !== true
    && nonEmptyString(run.requestId)
    && nonEmptyString(run.parentAgentId)
    && nonEmptyString(run.sessionId)
    && run.bindingRevision === input.bindingRevision
    && run.definitionRevision === input.definitionRevision
    && isRecord(run.document)
    && run.document.confirmed === true
    && Array.isArray(run.document.nodes)
    && isRecord(run.nodes)
}

/** Read the current exact center identity from Host-owned services only. */
export async function readAuthorizedCenterBinding(ctx, readState, exec) {
  const parent = exec?.agent
  if (!parent || !nonEmptyString(parent.id) || ctx.agents.get(parent.id) !== parent) {
    throw fail('untrusted_parent')
  }
  if (typeof exec.callId !== 'string' || !exec.callId) throw fail('missing_tool_call_id')
  const sessionId = parent.session?.id
  if (!nonEmptyString(sessionId)) throw fail('missing_parent_session')

  const state = await readState()
  const binding = state?.roles?.center
  const bindingRevision = getRoleBindingRevision(state, 'center')
  const workspaceId = binding?.workspaceId
  const workspacePath = binding?.workspacePath
  if (!isRecord(binding) || !nonEmptyString(binding.sessionId)
    || binding.sessionId !== sessionId
    || binding.workspaceId == null
    || binding.workspacePath == null
    || binding.agentPreset !== ROLE_PRESETS.center) {
    throw fail('center_binding_mismatch')
  }

  const registry = ctx.workspaceRegistry
  if (!Array.isArray(registry.archivedSessionIds)
    || registry.archivedSessionIds.includes(sessionId)) {
    throw fail('parent_session_archived_or_archive_state_unknown')
  }
  const workspace = registry.get(binding.workspaceId)
  if (!workspace || workspace.id !== binding.workspaceId
    || workspace.path !== binding.workspacePath
    || !Array.isArray(workspace.sessionIds)
    || !workspace.sessionIds.includes(sessionId)) {
    throw fail('parent_workspace_mismatch')
  }

  let observation
  try {
    observation = await ctx.sessionQuery.observeSession(sessionId)
    if (observation?.header?.id !== sessionId
      || observation.header.cwd !== binding.workspacePath
      || observation.projections?.values?.agentPreset !== ROLE_PRESETS.center) {
      throw fail('parent_session_metadata_mismatch')
    }
  } finally {
    observation?.[Symbol.dispose]?.()
  }

  if (ctx.agents.get(parent.id) !== parent || parent.session?.id !== sessionId) {
    throw fail('untrusted_parent')
  }
  const latest = await readState()
  if (getRoleBindingRevision(latest, 'center') !== bindingRevision || latest?.roles?.center?.sessionId !== sessionId
    || latest.roles.center.workspaceId !== workspaceId || latest.roles.center.workspacePath !== workspacePath
    || latest.roles.center.agentPreset !== ROLE_PRESETS.center) throw fail('center_binding_mismatch')
  const currentWorkspace = registry.get(workspaceId)
  if (!Array.isArray(registry.archivedSessionIds) || registry.archivedSessionIds.includes(sessionId)
    || currentWorkspace?.id !== workspaceId || currentWorkspace?.path !== workspacePath
    || !Array.isArray(currentWorkspace?.sessionIds) || !currentWorkspace.sessionIds.includes(sessionId)) throw fail('parent_workspace_mismatch')
  if (ctx.agents.get(parent.id) !== parent || parent.session?.id !== sessionId) throw fail('untrusted_parent')
  return { parent, sessionId, bindingRevision, workspaceId, workspacePath }
}

/**
 * Build a server-owned resolver for the existing native-executor binding DTO.
 * `readState` and `loadRun` must read Host-owned state and a persisted journal
 * snapshot respectively (`journal.open(id)` returns a handle; the Host adapter
 * must explicitly call `handle.getSnapshot()`). Caller input carries identifiers and expected
 * revisions only; prompt, requestId, parent identity and preset come from
 * trusted runtime context or persisted server data.
 */
export function createWorkflowNativeBindingResolver({ ctx, readState, loadRun } = {}) {
  if (!ctx?.agents?.get || !ctx?.workspaceRegistry?.get
    || !ctx?.sessionQuery?.observeSession) {
    throw new TypeError('native binding resolver requires Host agent, workspace and session query APIs')
  }
  if (typeof readState !== 'function' || typeof loadRun !== 'function') {
    throw new TypeError('native binding resolver requires Host state and persisted run loaders')
  }

  return async function resolveWorkflowNativeBinding(input, exec) {
    if (!validInput(input)) throw fail('invalid_input')

    const { parent, sessionId, bindingRevision } = await readAuthorizedCenterBinding(ctx, readState, exec)

    const run = await loadRun(input.workflowRunId)
    if (!validJournalRun(run, input)) throw fail('run_unavailable_or_stale')
    if (run.parentAgentId !== parent.id || run.sessionId !== sessionId) {
      throw fail('run_parent_mismatch')
    }

    const node = run.document.nodes.find(candidate => candidate?.id === input.nodeId)
    const nodeState = run.nodes[input.nodeId]
    if (!node || node.kind !== 'agent' || !isRecord(nodeState)
      || nodeState.status !== 'running' || nodeState.attemptState !== 'started'
      || nodeState.attempt !== input.attempt) {
      throw fail('run_node_not_active')
    }
    if (node.agent === 'center' || !Object.hasOwn(ROLE_PRESETS, node.agent)) {
      throw fail('run_node_role_not_allowed')
    }
    const agentPreset = ROLE_PRESETS[node.agent]
    if (!nonEmptyString(nodeState.requestId)) throw fail('run_node_request_unavailable')
    if (!nonEmptyString(node.instruction)) throw fail('run_node_prompt_unavailable')
    if (bindingRevision !== input.bindingRevision) throw fail('center_binding_mismatch')

    const current = await readAuthorizedCenterBinding(ctx, readState, exec)
    if (current.parent !== parent || current.sessionId !== sessionId || current.bindingRevision !== bindingRevision) throw fail('center_binding_mismatch')
    const latestRun = await loadRun(input.workflowRunId)
    if (!validJournalRun(latestRun, input) || latestRun.revision !== run.revision
      || latestRun.parentAgentId !== parent.id || latestRun.sessionId !== sessionId
      || latestRun.nodes[input.nodeId]?.requestId !== nodeState.requestId
      || latestRun.nodes[input.nodeId]?.status !== 'running' || latestRun.nodes[input.nodeId]?.attempt !== input.attempt) throw fail('run_unavailable_or_stale')
    const prompt = upstreamPrompt(latestRun, node)
    const modelRequest = node.model == null ? undefined : { provider: node.model.provider, model: node.model.model }
    if (modelRequest && (!nonEmptyString(modelRequest.provider) || !nonEmptyString(modelRequest.model))) throw fail('unsupported_model_selection')

    return {
      authorized: true,
      requestId: nodeState.requestId,
      agentId: parent.id,
      sessionId,
      workflowRunId: run.id,
      nodeId: input.nodeId,
      attempt: input.attempt,
      bindingRevision,
      definitionRevision: run.definitionRevision,
      prompt,
      ...(prompt === node.instruction ? {} : { instruction: node.instruction }),
      agentPreset,
      ...(modelRequest ? { modelRequest } : {}),
    }
  }
}
