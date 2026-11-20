import { createHash, randomUUID } from 'node:crypto'
import { resolve } from 'node:path'
import { executeNativeTool } from './workflow-native-command-attribution.js'
import { createStateStore, getRoleBindingRevision, resolveOwnedHome } from './state.js'
import { submissionIdentity } from './workflow-native-service.js'
import { ROLE_PRESETS } from './roles.js'
import { NATIVE_WORKFLOW_RUN_ID, nativeWorkflowErrorStatus, projectNativeWorkflowRun, safeNativeWorkflowError } from './workflow-native-run-projection.js'

export { projectNativeWorkflowRun }
export const WORKFLOW_NATIVE_UI_ROUTE = '/tradeloom/workflows/native'
const MAX_BODY = 4096
const WORKFLOW = /^[a-z0-9][a-z0-9_-]{0,47}$/
const OPERATION = /^[A-Za-z0-9_-]{1,128}$/
const DEFINITION = /^sha256:[a-f0-9]{64}$/
const BINDING = /^(?:0|[1-9][0-9]{0,63})$/
const TOOL_NAMES = Object.freeze({ prepare: 'tradeloom_wf_native_prepare', submit: 'tradeloom_wf_native_submit', get: 'tradeloom_wf_native_get', list: 'tradeloom_wf_native_list', cancel: 'tradeloom_wf_native_cancel', prepare_resume: 'tradeloom_wf_native_prepare_resume', resume: 'tradeloom_wf_native_resume' })
const ACTIONS = Object.freeze({ prepare: ['workflowId'], submit: ['workflowId', 'operationId', 'expectedDefinitionRevision', 'expectedBindingRevision', 'confirm'], get: ['runId'], list: ['workflowId', 'activeOnly'], cancel: ['runId', 'operationId'], prepare_resume: ['runId'],
  resume: ['runId', 'operationId', 'expectedRunRevision', 'expectedDefinitionRevision', 'expectedBindingRevision', 'resumePlanHash', 'confirm'] })
const fail = code => Object.assign(new Error(code), { code })
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value)
function write(res, status, value) {
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(JSON.stringify(value))
}
function valid(body) {
  if (!record(body) || !Object.hasOwn(ACTIONS, body.action)) throw fail('invalid_input')
  const fields = ACTIONS[body.action]
  if (Object.keys(body).some(key => key !== 'action' && !fields.includes(key))) throw fail('invalid_input')
  const required = body.action === 'list' ? [] : fields
  if (required.some(key => !Object.hasOwn(body, key))) throw fail('invalid_input')
  for (const key of fields) {
    if (!Object.hasOwn(body, key)) continue
    const pattern = { workflowId: WORKFLOW, runId: NATIVE_WORKFLOW_RUN_ID, operationId: OPERATION, expectedDefinitionRevision: DEFINITION, expectedBindingRevision: BINDING, resumePlanHash: DEFINITION }[key]
    if (pattern ? typeof body[key] !== 'string' || !pattern.test(body[key]) : key === 'confirm' ? body[key] !== true
      : key === 'expectedRunRevision' ? !Number.isSafeInteger(body[key]) || body[key] < 1 : typeof body[key] !== 'boolean') throw fail('invalid_input')
  }
  return body
}
async function read(req) {
  let bytes = 0
  const chunks = []
  for await (const chunk of req) { bytes += Buffer.byteLength(chunk); if (bytes > MAX_BODY) throw fail('invalid_input'); chunks.push(Buffer.from(chunk)) }
  try { return valid(JSON.parse(Buffer.concat(chunks).toString('utf8'))) } catch { throw fail('invalid_input') }
}

function validPreparedGraph(value) {
  const validNode = node => typeof node?.id === 'string' && node.id && node.roleId !== 'center'
    && Object.hasOwn(ROLE_PRESETS, node.roleId) && node.agentPreset === ROLE_PRESETS[node.roleId]
  const validGraphNode = node => validNode(node) || (typeof node?.id === 'string' && node.id
    && ['input', 'output'].includes(node.kind) && node.executionMode === 'local'
    && Object.keys(node).length === 3 && Object.hasOwn(node, 'id') && Object.hasOwn(node, 'kind'))
    || (typeof node?.id === 'string' && node.id && node.kind === 'review' && node.executionMode === 'user-questions'
      && Object.keys(node).length === 3 && Object.hasOwn(node, 'id') && Object.hasOwn(node, 'kind'))
  const graph = value.graph
  if (!graph) return validNode(value.node) // Existing single-node prepared DTO remains readable.
  if (!record(graph) || !Array.isArray(graph.nodes) || graph.nodes.length < 1 || graph.nodes.length > 40
    || graph.nodeCount !== graph.nodes.length || !Number.isInteger(graph.edgeCount) || graph.edgeCount < 0 || graph.edgeCount > 80
    || graph.maxConcurrent !== 1 || graph.nodes.some(node => !validGraphNode(node))
    || new Set(graph.nodes.map(node => node.id)).size !== graph.nodeCount
    || !graph.nodes.some(validNode)
    || JSON.stringify(graph.roleIds) !== JSON.stringify([...new Set(graph.nodes.filter(validNode).map(node => node.roleId))])) return false
  return graph.nodeCount === 1 ? validNode(value.node) && JSON.stringify(value.node) === JSON.stringify(graph.nodes[0])
    : !Object.hasOwn(value, 'node') && JSON.stringify(value.nodes) === JSON.stringify(graph.nodes)
}

/** Browser arguments never become an Agent or ToolRunContext. Only ToolRuntime
 * constructs the actual exec passed to the registered native service tools. */
export function createNativeWorkflowAccess(ctx, dependencies = {}) {
  let state
  const readState = dependencies.readState ?? (async () => (await (state ??= createStateStore())).read())
  const taskAuthority = dependencies.getTaskAuthority ?? (() => ctx.nativeTaskAuthority)
  async function center() {
    const stored = await readState()
    const sessionId = stored?.roles?.center?.sessionId
    if (typeof sessionId !== 'string' || !sessionId) throw fail('center_session_not_live')
    let parent = ctx.agents.get(sessionId)
    if (parent === undefined) {
      const revision = getRoleBindingRevision(stored, 'center')
      let result
      try { result = await ctx.sessionController?.resolveAgent(sessionId) } catch { throw fail('center_session_not_live') }
      const current = await readState()
      if (current?.roles?.center?.sessionId !== sessionId) throw fail('center_binding_mismatch')
      if (getRoleBindingRevision(current, 'center') !== revision) throw fail('binding_revision_mismatch')
      if (!result || 'error' in result) throw fail('center_session_not_live')
      parent = result.agent
    }
    if (!parent || parent.id !== sessionId || parent.session?.id !== sessionId || ctx.agents.get(sessionId) !== parent) throw fail('center_session_not_live')
    return parent
  }
  async function tool(action, args, agent, signal, callId) {
    const request = { callId, name: TOOL_NAMES[action], arguments: args, agent, signal }
    let result
    if (action === 'submit' || action === 'resume') {
      const authority = taskAuthority()
      if (typeof authority?.runCommand !== 'function') throw fail('native_run_unavailable')
      const stored = await readState()
      const owner = stored?.roles?.center
      if (owner?.sessionId !== agent.session.id || typeof owner.workspaceId !== 'string') throw fail('center_binding_mismatch')
      const run = action === 'resume' ? await tool('get', { runId: args.runId }, agent, signal, randomUUID()) : null
      if (run && (run.parentAgentId !== agent.id || run.sessionId !== agent.session.id)) throw fail('run_parent_mismatch')
      const session = agent.session
      // Prediction only. The service re-derives and compares this full tuple
      // after actual definition/binding/owner authorization, before run writes.
      const intent = { ...request, runId: run?.id ?? submissionIdentity(session.id, callId).runId,
        identity: { workflowId: run?.workflowId ?? args.workflowId, parentAgentId: agent.id,
          sessionId: session.id, workspaceId: owner.workspaceId,
          definitionRevision: args.expectedDefinitionRevision, bindingRevision: args.expectedBindingRevision },
        isCurrent: () => ctx.agents.get(agent.id) === agent && agent.session === session }
      result = await authority.runCommand(intent)
    } else result = await executeNativeTool(ctx.tools, request)
    if (result?.isError) throw fail(safeNativeWorkflowError(result.error?.info?.code ?? result.error?.code))
    const value = result?.value
    if (!record(value) || value.ok !== true || typeof value.data !== 'string') throw fail(safeNativeWorkflowError(value?.error_code))
    try { return JSON.parse(value.data) } catch { throw fail('native_workflow_unavailable') }
  }
  return { center, tool }
}

export function createWorkflowNativeUiHandler(ctx, dependencies = {}) {
  const { center, tool } = createNativeWorkflowAccess(ctx, dependencies)
  const profileNamespace = dependencies.resolveProfileNamespace ?? resolveOwnedHome
  return async (req, res) => {
    const rejection = ctx.connection.requestRejection(req)
    if (rejection !== undefined) { write(res, rejection, { schemaVersion: 1, ok: false, executionMode: 'native_dsh', error_code: rejection === 401 ? 'authentication_required' : 'request_forbidden' }); return }
    if (req.method !== 'POST') { res.setHeader('allow', 'POST'); write(res, 405, { schemaVersion: 1, ok: false, executionMode: 'native_dsh', error_code: 'method_not_allowed' }); return }
    const controller = new AbortController()
    const abort = () => controller.abort()
    const closeRequest = () => { if (!req.complete && !req.readableEnded) abort() }
    const closeResponse = () => { if (!res.writableEnded) abort() }
    req.on?.('aborted', abort); req.on?.('close', closeRequest); res.on?.('close', closeResponse)
    let action
    try {
      const body = await read(req); action = body.action
      const parent = await center()
      let callId = randomUUID()
      if (body.operationId) {
        const home = await profileNamespace()
        if (typeof home !== 'string' || !home) throw fail('native_workflow_unavailable')
        callId = createHash('sha256').update('tradeloom.native-ui/v1\0').update(JSON.stringify([resolve(home).toLocaleLowerCase('en-US'), parent.session.id, action, body.operationId])).digest('hex')
      }
      const args = Object.fromEntries(ACTIONS[action].filter(key => key !== 'operationId' && (key !== 'confirm' || action === 'resume') && Object.hasOwn(body, key)).map(key => [key, body[key]]))
      const value = await tool(action, args, parent, controller.signal, callId)
      const envelope = { schemaVersion: 1, ok: true, executionMode: 'native_dsh', action }
      if (action === 'submit') {
        if (!NATIVE_WORKFLOW_RUN_ID.test(value?.runId ?? '')) throw fail('submission_unverified')
        const persisted = await tool('get', { runId: value.runId }, parent, controller.signal, randomUUID())
        if (!persisted || persisted.id !== value.runId || persisted.workflowId !== body.workflowId
          || persisted.sessionId !== parent.session.id || persisted.parentAgentId !== parent.id
          || persisted.definitionRevision !== body.expectedDefinitionRevision || persisted.bindingRevision !== body.expectedBindingRevision) throw fail('submission_unverified')
        projectNativeWorkflowRun(persisted)
        write(res, 202, { ...envelope, operationId: body.operationId, submission: { runId: value.runId, accepted: true, reused: value.reused === true, settled: false } })
      } else if (action === 'resume') {
        if (value?.runId !== body.runId) throw fail('submission_unverified')
        const persisted = await tool('get', { runId: body.runId }, parent, controller.signal, randomUUID())
        if (persisted?.definitionRevision !== body.expectedDefinitionRevision || persisted?.bindingRevision !== body.expectedBindingRevision
          || persisted?.parentAgentId !== parent.id || persisted?.sessionId !== parent.session.id) throw fail('submission_unverified')
        projectNativeWorkflowRun(persisted)
        write(res, 202, { ...envelope, operationId: body.operationId, resumption: { runId: body.runId, accepted: true, reused: value.reused === true, settled: false } })
      } else if (action === 'prepare_resume') {
        if (value?.runId !== body.runId || !Number.isSafeInteger(value.expectedRunRevision) || value.expectedRunRevision < 1
          || !DEFINITION.test(value.definitionRevision ?? '') || !DEFINITION.test(value.resumePlanHash ?? '') || !BINDING.test(value.bindingRevision ?? '')
          || typeof value.eligible !== 'boolean' || !Array.isArray(value.eligibleNodeIds) || !Array.isArray(value.completedNodeIds) || !Array.isArray(value.blocked)) throw fail('submission_unverified')
        write(res, 200, { ...envelope, preparedResume: value })
      } else if (action === 'prepare') {
        if (!record(value) || value.workflowId !== body.workflowId || value.eligible !== true || value.confirmed !== true
          || value.executionMode !== 'native_dsh' || !DEFINITION.test(value.definitionRevision ?? '') || !BINDING.test(value.bindingRevision ?? '')
          || value.center?.roleId !== 'center' || value.center.sessionId !== parent.session.id || value.center.archiveState !== 'unarchived'
          || typeof value.center.workspaceId !== 'string' || !validPreparedGraph(value)) throw fail('submission_unverified')
        write(res, 200, { ...envelope, prepared: value })
      } else if (action === 'get') {
        if (!value) throw fail('run_not_found')
        write(res, 200, { ...envelope, run: projectNativeWorkflowRun(value) })
      } else if (action === 'list') {
        if (!Array.isArray(value)) throw fail('native_workflow_unavailable')
        write(res, 200, { ...envelope, runs: value.map(projectNativeWorkflowRun) })
      } else {
        write(res, 200, { ...envelope, operationId: body.operationId, cancellation: { runId: body.runId, abortRequested: value?.aborted === true,
          intentPersisted: value?.intentPersisted === true,
          reason: ['already_terminal', 'not_active_in_service', 'abort_requested', 'already_requested'].includes(value?.reason) ? value.reason : 'unknown', settled: false } })
      }
    } catch (error) {
      const code = safeNativeWorkflowError(error?.code)
      write(res, nativeWorkflowErrorStatus(code), { schemaVersion: 1, ok: false, executionMode: 'native_dsh', ...(action ? { action } : {}), error_code: code })
    } finally {
      req.off?.('aborted', abort); req.off?.('close', closeRequest); res.off?.('close', closeResponse)
    }
  }
}
