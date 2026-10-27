import test from 'node:test'
import assert from 'node:assert/strict'
import { registerWorkflowNativeTools, createWorkflowNativeToolComposition, apply, inject } from '../workflow-native-tools.js'
import { join } from 'node:path'
import { createPostgresWorkflowRunStore } from '../workflow-postgres.js'
import { registerWorkflowTools } from '../workflow-tools.js'

const RUN = '11111111-1111-4111-8111-111111111111'
function fixture() {
  const tools = [], calls = [], disposed = []
  const ctx = { tools: { register(tool) { tools.push(tool); return () => disposed.push(tool.name) } } }
  const service = Object.fromEntries(['submit', 'get', 'list', 'cancel', 'prepare', 'prepare_resume', 'resume'].map(method => [method, async (args, exec) => {
    calls.push({ method, args, exec }); return { method }
  }]))
  return { tools, calls, disposed, ctx, service }
}

test('center registers seven exact schemas and forwards actual execution context unchanged', async () => {
  const f = fixture()
  const dispose = registerWorkflowNativeTools(f.ctx, f.service, { preset: 'tradeloom-center' })
  assert.equal(f.tools.length, 7)
  const exec = { callId: 'trusted-call', agent: { id: 'trusted-agent' }, signal: new AbortController().signal }
  const resume = { runId: RUN, expectedRunRevision: 3, expectedDefinitionRevision: `sha256:${'a'.repeat(64)}`,
    expectedBindingRevision: '7', resumePlanHash: `sha256:${'b'.repeat(64)}`, confirm: true }
  const args = [{ workflowId: 'saved-flow' }, { runId: RUN }, { workflowId: 'saved-flow', activeOnly: true }, { runId: RUN }, { workflowId: 'saved-flow' }, { runId: RUN }, resume]
  for (const [index, tool] of f.tools.entries()) {
    assert.equal(tool.parameters.additionalProperties, false)
    assert.deepEqual(Object.keys(tool.parameters.properties), index === 0 ? ['workflowId', 'expectedDefinitionRevision', 'expectedBindingRevision'] : index === 2 ? ['workflowId', 'activeOnly'] : index === 4 ? ['workflowId'] : index === 6 ? Object.keys(resume) : ['runId'])
    const result = await tool.execute(args[index], exec)
    assert.equal(result.ok, true)
    assert.equal(typeof result.data, 'string')
    assert.equal(f.calls[index].exec, exec)
    assert.equal(f.calls[index].args, args[index])
    assert.equal(typeof tool.output.render(args[index], result)[0].text, 'string')
  }
  dispose(); dispose()
  assert.equal(f.disposed.length, 7)
  assert.deepEqual(inject, ['tools', 'agents', 'workspaceRegistry', 'sessionQuery', 'subagents', 'webServer', 'nativeTaskAuthority'])
})

test('non-center configuration registers nothing', () => {
  const f = fixture()
  registerWorkflowNativeTools(f.ctx, f.service, { preset: 'tradeloom-product' })()
  assert.equal(f.tools.length, 0)
})

test('runtime rejects extra authority and identity fields before calling service', async () => {
  const f = fixture()
  registerWorkflowNativeTools(f.ctx, f.service, { preset: 'tradeloom-center' })
  for (const tool of f.tools) {
    const base = /submit|prepare/.test(tool.name) ? { workflowId: 'flow' } : tool.name.endsWith('list') ? {} : { runId: RUN }
    for (const key of ['requestId', 'parent', 'preset', 'bindingRevision', 'definitionRevision', 'signal', 'authority', 'bridge', 'port', 'pairedHost']) {
      assert.equal((await tool.execute({ ...base, [key]: 'forged' }, {})).error_code, 'invalid_native_workflow_arguments')
    }
  }
  assert.equal(f.calls.length, 0)
  assert.equal((await f.tools[0].execute({}, {})).ok, false)
  assert.equal((await f.tools[1].execute({ runId: '../bad' }, {})).ok, false)
  assert.equal((await f.tools[2].execute({ activeOnly: 'true' }, {})).ok, false)
})

test('service errors do not disclose raw error text', async () => {
  const f = fixture()
  f.service.submit = async () => { throw new Error('secret diagnostic') }
  registerWorkflowNativeTools(f.ctx, f.service, { preset: 'tradeloom-center' })
  assert.deepEqual(await f.tools[0].execute({ workflowId: 'flow' }, {}), { ok: false, data: '{}', error_code: 'native_workflow_unavailable' })
})

test('submit documents graph limit and only fixed safe service codes are public', async () => {
  const f = fixture()
  let code = 'unsupported_workflow_graph'
  f.service.submit = async () => { throw Object.assign(new Error('private message and stack'), { code }) }
  registerWorkflowNativeTools(f.ctx, f.service, { preset: 'tradeloom-center' })
  assert.match(f.tools[0].description, /agent-only DAG for serial native execution/)
  for (const safe of ['unsupported_workflow_graph', 'workflow_not_found', 'workflow_not_confirmed', 'center_binding_mismatch', 'run_parent_mismatch', 'definition_revision_mismatch', 'binding_revision_mismatch', 'workflow_not_eligible', 'invalid_expected_revision', 'submission_identity_conflict', 'native_bridge_unavailable', 'service_closed', 'run_not_found', 'NATIVE_PRESET_NOT_ALLOWED']) {
    code = safe
    assert.deepEqual(await f.tools[0].execute({ workflowId: 'flow' }, {}), { ok: false, data: '{}', error_code: safe })
  }
  for (const unsafe of ['secret diagnostic', 'workflow_not_found\nprivate', '<script>secret</script>', { message: 'secret' }, null]) {
    code = unsafe
    assert.deepEqual(await f.tools[0].execute({ workflowId: 'flow' }, {}), { ok: false, data: '{}', error_code: 'native_workflow_unavailable' })
  }
})

test('partial registration failure unregisters already registered definitions', () => {
  const f = fixture()
  let count = 0
  f.ctx.tools.register = () => { if (++count === 3) throw new Error('registration failed'); return () => f.disposed.push(count) }
  assert.throws(() => registerWorkflowNativeTools(f.ctx, f.service, { preset: 'tradeloom-center' }))
  assert.equal(f.disposed.length, 2)
})

test('composition uses trusted factories, lazy owned home, paired port and no recovery', async () => {
  const f = fixture()
  const webServer = { host: '127.0.0.1', port: 33188 }
  f.ctx.webServer = webServer
  const env = { TRADELOOM_DJANGO_PORT: '33190' }
  const events = []
  let serviceOptions, pgOptions
  f.service.dispose = () => events.push('dispose')
  f.service.recover = () => { throw new Error('must not recover at preset apply') }
  const dispose = createWorkflowNativeToolComposition(f.ctx, { preset: 'tradeloom-center', pairedHost: { host: '127.0.0.1', port: 33188 } }, {
    env,
    resolveOwnedHome: async actual => { assert.equal(actual, env); events.push('home'); return 'C:/owned-profile' },
    createStateStore: async options => { assert.equal(options.env, env); return { read: async () => ({ owned: true }) } },
    createWorkflowStore: directory => { assert.equal(directory, join('C:/owned-profile', 'tradeloom-workflows')); return { get: async id => ({ id }) } },
    createPostgresWorkflowRunStore: options => { pgOptions = options; return { paired: true } },
    createWorkflowNativeService: options => { serviceOptions = options; return f.service },
  })
  assert.deepEqual(events, [])
  assert.deepEqual(pgOptions, { webServer, port: 33190, pairedHost: { host: '127.0.0.1', port: 33188 } })
  assert.equal(serviceOptions.ctx, f.ctx)
  assert.deepEqual(serviceOptions.runStore, { paired: true })
  assert.deepEqual(await serviceOptions.readState(), { owned: true })
  assert.deepEqual(await serviceOptions.definitionStore.get('saved'), { id: 'saved' })
  assert.deepEqual(events, ['home'])
  await dispose(); await dispose()
  assert.deepEqual(events, ['home', 'dispose'])
  assert.equal(f.disposed.length, 7)
})

test('composition validates trusted port before initialization and ignores non-center completely', () => {
  const f = fixture()
  const dependencies = { env: {}, createPostgresWorkflowRunStore() { throw new Error('must not initialize') } }
  for (const djangoPort of ['0', '1e3', '65536', 1.2, '', null]) {
    if (djangoPort === null) continue // null uses the documented nullish default.
    assert.throws(() => createWorkflowNativeToolComposition(f.ctx, { preset: 'tradeloom-center', djangoPort }, dependencies), /Invalid trusted Django port/)
  }
  createWorkflowNativeToolComposition(f.ctx, { preset: 'tradeloom-product' }, dependencies)()
  let effects = 0
  apply({ effect() { effects++ } }, { preset: 'tradeloom-product' })
  assert.equal(effects, 0)
})

test('composition defaults to exact trusted Host pair and copies explicit configuration', async () => {
  for (const explicit of [undefined, { host: '127.0.0.1', port: 9999 }]) {
    const f = fixture()
    f.ctx.webServer = { protocol: 'http:', host: '127.0.0.1', port: 33188, getOrigin: () => 'http://127.0.0.1:33188' }
    let options
    f.service.dispose = () => {}
    const cleanup = createWorkflowNativeToolComposition(f.ctx, { preset: 'tradeloom-center', ...(explicit === undefined ? {} : { pairedHost: explicit }) }, {
      env: {}, createPostgresWorkflowRunStore: value => { options = value; return {} },
      createWorkflowNativeService: () => f.service,
    })
    assert.equal(options.webServer, f.ctx.webServer)
    assert.deepEqual(options.pairedHost, explicit ?? { host: '127.0.0.1', port: 33188 })
    if (explicit) { assert.notEqual(options.pairedHost, explicit); explicit.port = 1; assert.equal(options.pairedHost.port, 9999) }
    await cleanup()
  }
})

test('explicit incorrect Host pair reaches real PG validation and never falls back', async () => {
  const f = fixture()
  f.ctx.webServer = { protocol: 'http:', host: '127.0.0.1', port: 33188, getOrigin: () => 'http://127.0.0.1:33188' }
  let store, requests = 0
  f.service.dispose = () => {}
  const cleanup = createWorkflowNativeToolComposition(f.ctx, { preset: 'tradeloom-center', pairedHost: { host: '127.0.0.1', port: 3088 } }, {
    env: {},
    createPostgresWorkflowRunStore: options => store = createPostgresWorkflowRunStore({ ...options, nativeBridgeKey: 'a'.repeat(64), request() { requests++; throw new Error('must not request') } }),
    createWorkflowNativeService: () => f.service,
  })
  await assert.rejects(store.list(), { code: 'trusted_business_authority_unavailable' })
  assert.equal(requests, 0)
  await cleanup()
})

test('submit expected revisions are optional comparisons with strict wire types', async () => {
  const f = fixture()
  registerWorkflowNativeTools(f.ctx, f.service, { preset: 'tradeloom-center' })
  const exec = { agent: {}, callId: 'real-context', signal: new AbortController().signal }
  const args = { workflowId: 'flow', expectedDefinitionRevision: `sha256:${'a'.repeat(64)}`, expectedBindingRevision: '7' }
  assert.equal((await f.tools[0].execute(args, exec)).ok, true)
  assert.equal(f.calls[0].args, args)
  assert.equal(f.calls[0].exec, exec)
  for (const bad of [null, 7, '', '01', '-1', '1'.repeat(65)]) {
    assert.equal((await f.tools[0].execute({ ...args, expectedBindingRevision: bad }, exec)).error_code, 'invalid_native_workflow_arguments')
  }
  for (const bad of [null, {}, 'sha256:a', 'a'.repeat(64)]) {
    assert.equal((await f.tools[0].execute({ ...args, expectedDefinitionRevision: bad }, exec)).error_code, 'invalid_native_workflow_arguments')
  }
  assert.equal((await f.tools[4].execute(args, exec)).error_code, 'invalid_native_workflow_arguments')
})

test('native registration coexists with old local mock tool without replacement', () => {
  const f = fixture()
  const old = registerWorkflowTools(f.ctx, {}, { preset: 'tradeloom-center' })
  const mockRun = f.tools.find(tool => tool.name === 'tradeloom_wf_run')
  const native = registerWorkflowNativeTools(f.ctx, f.service, { preset: 'tradeloom-center' })
  assert.equal(f.tools.filter(tool => tool.name === 'tradeloom_wf_run').length, 1)
  assert.equal(f.tools.find(tool => tool.name === 'tradeloom_wf_run'), mockRun)
  assert.match(mockRun.description, /local mock mode only/)
  native(); old()
})
