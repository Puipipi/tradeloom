import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { readFile } from 'node:fs/promises'
import { Readable } from 'node:stream'
import { createNativeWorkflowReadiness, NATIVE_WORKFLOW_READINESS } from '../workflow-native-readiness.js'
import { registerWorkflowNativeTools } from '../workflow-native-tools.js'
import { createWorkflowNativeUiHandler } from '../workflow-native-ui.js'
import { ROLE_PRESETS } from '../roles.js'

const tick = () => new Promise(resolve => setImmediate(resolve))
function deferred() {
  let resolve, reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

function registeredTool(gate, onCall) {
  const tools = new Map()
  const ctx = {
    get(key) { return key === NATIVE_WORKFLOW_READINESS ? gate : undefined },
    tools: { register(definition) { tools.set(definition.name, definition); return () => tools.delete(definition.name) } },
  }
  const methods = ['submit', 'get', 'list', 'cancel', 'prepare', 'prepare_resume', 'resume']
  const service = Object.fromEntries(methods.map(method => [method, async () => { onCall(method); return { method } }]))
  registerWorkflowNativeTools(ctx, service, { preset: ROLE_PRESETS.center })
  return tools.get('tradeloom_wf_native_prepare')
}

function uiHandler(gate, onCall) {
  const sessionId = 'center-session'
  const parent = { id: sessionId, session: { id: sessionId } }
  const prepared = { workflowId: 'workflow', eligible: true, confirmed: true, executionMode: 'native_dsh',
    definitionRevision: `sha256:${'a'.repeat(64)}`, bindingRevision: '1',
    center: { roleId: 'center', sessionId, archiveState: 'unarchived', workspaceId: 'workspace' },
    node: { id: 'task', roleId: 'product', agentPreset: ROLE_PRESETS.product } }
  const ctx = {
    connection: { requestRejection: () => undefined },
    get(key) { return key === NATIVE_WORKFLOW_READINESS ? gate : undefined },
    agents: { get(id) { return id === sessionId ? parent : undefined } },
    tools: { async execute() { onCall(); return { value: { ok: true, data: JSON.stringify(prepared), error_code: '' } } } },
  }
  const handler = createWorkflowNativeUiHandler(ctx, { readState: async () => ({ roles: { center: { sessionId, workspaceId: 'workspace' } } }) })
  async function request(body, onCreate) {
    const req = Readable.from([Buffer.from(JSON.stringify(body))])
    req.method = 'POST'
    const res = new EventEmitter()
    res.setHeader = () => {}
    res.end = value => { res.writableEnded = true; res.body = value }
    onCreate?.(req, res)
    const pending = handler(req, res)
    return { req, res, pending, result: async () => { await pending; return { status: res.statusCode, value: JSON.parse(res.body) } } }
  }
  return { request }
}

test('package subpath exposes the Host-owned readiness factory', async () => {
  const exported = await import('@tradeloom/dsh-business-shell/workflow-native-readiness')
  assert.equal(exported.createNativeWorkflowReadiness, createNativeWorkflowReadiness)
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
  assert.equal(pkg.exports['./workflow-native-readiness'], './workflow-native-readiness.js')
  assert.ok(pkg.files.includes('workflow-native-readiness.js'))
})

test('registered native tool and HTTP UI wait on the same pending gate, then each execute once', async t => {
  const gate = createNativeWorkflowReadiness()
  t.after(() => gate.close())
  let toolCalls = 0
  let uiCalls = 0
  const tool = registeredTool(gate, () => { toolCalls++ })
  const ui = uiHandler(gate, () => { uiCalls++ })
  const uiRequest = await ui.request({ action: 'prepare', workflowId: 'workflow' })
  const toolRequest = tool.execute({ workflowId: 'workflow' }, {})
  await tick()
  assert.equal(gate.state, 'pending')
  assert.equal(toolCalls, 0)
  assert.equal(uiCalls, 0)

  await gate.startRecovery(async () => {})
  const [toolResult, uiResult] = await Promise.all([toolRequest, uiRequest.result()])
  assert.deepEqual(toolResult, { ok: true, data: JSON.stringify({ method: 'prepare' }), error_code: '' })
  assert.equal(uiResult.status, 200)
  assert.equal(toolCalls, 1)
  assert.equal(uiCalls, 1)
})

test('missing, failed, closed, and replaced readiness providers fail closed', async t => {
  let calls = 0
  const missingTool = registeredTool(undefined, () => { calls++ })
  assert.equal((await missingTool.execute({ workflowId: 'workflow' }, {})).error_code, 'native_workflow_unavailable')
  assert.equal(calls, 0)

  const failed = createNativeWorkflowReadiness()
  t.after(() => failed.close())
  await failed.startRecovery(async () => { throw new Error('private failure') })
  const failedTool = registeredTool(failed, () => { calls++ })
  assert.equal((await failedTool.execute({ workflowId: 'workflow' }, {})).error_code, 'native_workflow_unavailable')

  const closed = createNativeWorkflowReadiness()
  closed.close()
  const closedTool = registeredTool(closed, () => { calls++ })
  assert.equal((await closedTool.execute({ workflowId: 'workflow' }, {})).error_code, 'native_workflow_unavailable')

  const oldGate = createNativeWorkflowReadiness()
  const replacement = createNativeWorkflowReadiness()
  t.after(() => { oldGate.close(); replacement.close() })
  const recovering = deferred()
  let current = oldGate
  const tools = new Map()
  const ctx = { get(key) { return key === NATIVE_WORKFLOW_READINESS ? current : undefined },
    tools: { register(definition) { tools.set(definition.name, definition); return () => tools.delete(definition.name) } } }
  const methods = ['submit', 'get', 'list', 'cancel', 'prepare', 'prepare_resume', 'resume']
  const service = Object.fromEntries(methods.map(method => [method, async () => { calls++; return {} }]))
  registerWorkflowNativeTools(ctx, service, { preset: ROLE_PRESETS.center })
  const replacedCall = tools.get('tradeloom_wf_native_prepare').execute({ workflowId: 'workflow' }, {})
  const startup = oldGate.startRecovery(() => recovering.promise)
  await tick()
  await replacement.startRecovery(async () => {})
  current = replacement
  recovering.resolve()
  await startup
  assert.equal((await replacedCall).error_code, 'native_workflow_unavailable')
  assert.equal(calls, 0)
})

test('request abort cancels the UI wait and prevents the native tool from running', async t => {
  const gate = createNativeWorkflowReadiness()
  t.after(() => gate.close())
  let calls = 0
  const ui = uiHandler(gate, () => { calls++ })
  let req
  const pending = await ui.request({ action: 'prepare', workflowId: 'workflow' }, request => { req = request })
  await tick()
  req.emit('aborted')
  const result = await pending.result()
  assert.equal(result.status, 503)
  assert.equal(result.value.error_code, 'operation_aborted')
  assert.equal(calls, 0)
})

test('registered tool abort cancels only its wait and never calls the native service', async t => {
  const gate = createNativeWorkflowReadiness()
  t.after(() => gate.close())
  let calls = 0
  const tool = registeredTool(gate, () => { calls++ })
  const controller = new AbortController()
  const pending = tool.execute({ workflowId: 'workflow' }, { signal: controller.signal })
  await tick()
  controller.abort()
  const result = await pending
  assert.equal(result.error_code, 'operation_aborted')
  assert.equal(calls, 0)
})
