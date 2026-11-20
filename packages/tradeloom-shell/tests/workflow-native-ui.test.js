import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { Readable } from 'node:stream'
import { createConfirmedWorkflowDefinition } from '../workflow-definition.js'
import { createWorkflowNativeUiHandler, projectNativeWorkflowRun } from '../workflow-native-ui.js'
import { ROLE_PRESETS } from '../roles.js'

const runId = '11111111-1111-4111-8111-111111111111'
function mixedRun() {
  const confirmed = createConfirmedWorkflowDefinition({ version: 1, id: 'workflow', title: 'Workflow', confirmed: true,
    nodes: [
      { id: 'task', kind: 'agent', agent: 'product', title: 'Task', instruction: 'Produce result' },
      { id: 'review', kind: 'review', title: 'Review', instruction: 'Confirm result' },
      { id: 'output', kind: 'output', title: 'Output', instruction: '' },
    ], edges: [{ from: 'task', to: 'review' }, { from: 'review', to: 'output' }] })
  const nodes = Object.fromEntries(confirmed.document.nodes.map(node => [node.id, {
    status: 'pending', output: '', error: '', attempt: 0, attemptState: 'none', requestId: null,
    toolCallId: null, childId: null, nativeRunId: null, artifacts: [], artifactSource: 'unknown',
    ...(node.kind === 'review' ? { reviewState: null } : {}),
  }]))
  return { journalSchema: 'tradeloom.native-run-journal/v1', executionMode: 'native_dsh', id: runId,
    workflowId: confirmed.document.id, title: confirmed.document.title, status: 'running', revision: 1,
    document: confirmed.document, definitionRevision: confirmed.definitionRevision, bindingRevision: '7',
    parentAgentId: 'center-session', sessionId: 'center-session', nodes, events: [] }
}

function requestContext(result) {
  const parent = { id: 'center-session', session: { id: 'center-session' } }
  const ctx = {
    agents: { get: id => id === parent.id ? parent : undefined },
    connection: { requestRejection: () => undefined },
    tools: {
      selectExecutor() {},
      async execute({ calls: [call] }) {
        return { results: [{ callId: call.id, result: { content: [], ...result } }] }
      },
    },
  }
  const readState = async () => ({ roles: { center: { sessionId: parent.session.id, workspaceId: 'workspace' } } })
  return { ctx, readState }
}
async function send(handler, body) {
  const req = Readable.from([JSON.stringify(body)])
  req.method = 'POST'; req.complete = true
  const res = new EventEmitter(); res.headers = {}
  res.setHeader = (key, value) => { res.headers[key] = value }
  res.end = value => { res.body = JSON.parse(value) }
  await handler(req, res)
  return res
}

test('UI projection preserves typed local/review states without native child identity', () => {
  const projected = projectNativeWorkflowRun(mixedRun())
  assert.deepEqual(projected.nodes.map(({ id, kind, executionSource }) => [id, kind, executionSource]), [
    ['task', undefined, undefined], ['review', 'review', 'dsh-user-questions'], ['output', 'output', 'workflow/local'],
  ])
  for (const node of projected.nodes.filter(row => row.kind !== 'agent')) {
    assert.equal(node.childId, null)
    assert.equal(node.nativeRunId, null)
    assert.equal(node.toolCallId, null)
    assert.equal(node.artifactEvidence, null)
  }
})

test('UI accepts the existing prepare action DTO for a mixed graph and preserves review error status mapping', async () => {
  const nodes = [
    { id: 'task', roleId: 'product', agentPreset: ROLE_PRESETS.product },
    { id: 'review', kind: 'review', executionMode: 'user-questions' },
    { id: 'output', kind: 'output', executionMode: 'local' },
  ]
  const dto = { workflowId: 'workflow', title: 'Workflow', eligible: true, executionMode: 'native_dsh', confirmed: true,
    definitionRevision: `sha256:${'b'.repeat(64)}`, bindingRevision: '7',
    center: { roleId: 'center', sessionId: 'center-session', workspaceId: 'workspace', archiveState: 'unarchived' },
    graph: { nodeCount: 3, edgeCount: 2, maxConcurrent: 1, roleIds: ['product'], nodes }, nodes }
  const ok = requestContext({ isError: false, value: { ok: true, data: JSON.stringify(dto) } })
  const accepted = await send(createWorkflowNativeUiHandler(ok.ctx, { readState: ok.readState }), { action: 'prepare', workflowId: 'workflow' })
  assert.equal(accepted.statusCode, 200)
  assert.equal(accepted.body.prepared.graph.nodes[1].executionMode, 'user-questions')
  assert.equal(accepted.body.prepared.graph.nodes[2].executionMode, 'local')

  const unavailable = requestContext({ isError: true, error: { info: { code: 'review_unavailable' } } })
  const rejected = await send(createWorkflowNativeUiHandler(unavailable.ctx, { readState: unavailable.readState }), { action: 'prepare', workflowId: 'workflow' })
  assert.equal(rejected.statusCode, 503)
  assert.equal(rejected.body.error_code, 'review_unavailable')

  const invalidAnswer = requestContext({ isError: true, error: { info: { code: 'review_answer_invalid' } } })
  const conflict = await send(createWorkflowNativeUiHandler(invalidAnswer.ctx, { readState: invalidAnswer.readState }), { action: 'prepare', workflowId: 'workflow' })
  assert.equal(conflict.statusCode, 409)
  assert.equal(conflict.body.error_code, 'review_answer_invalid')
})

test('UI rejects pending review state forged with child identity or artifact evidence', () => {
  for (const mutate of [node => { node.childId = 'forged-child' }, node => { node.artifactEvidence = {} }]) {
    const run = mixedRun()
    mutate(run.nodes.review)
    assert.throws(() => projectNativeWorkflowRun(run), { code: 'submission_unverified' })
  }
})
