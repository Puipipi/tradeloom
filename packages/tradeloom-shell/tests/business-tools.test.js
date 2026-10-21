import assert from 'node:assert/strict'
import http from 'node:http'
import { dirname, resolve } from 'node:path'
import test from 'node:test'
import { pathToFileURL } from 'node:url'
import { apply, registerBusinessTools } from '../business-tools.js'

const TRUSTED_WEB_SERVER = { protocol: 'http:', host: '192.168.1.23', port: 3088, getOrigin: () => 'http://192.168.1.23:3088' }
const NATIVE_TOKEN = 'native-auth-must-never-be-forwarded'
const CSRF_TOKEN = 'fixture-csrf-token'

async function fixture(t, handler = defaultHandler, dependencies = {}) {
  const requests = []
  const server = http.createServer(async (req, res) => {
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    const record = { method: req.method, path: req.url, headers: req.headers, body: Buffer.concat(chunks).toString('utf8') }
    requests.push(record)
    await handler(record, res)
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise(resolve => server.close(resolve)))
  const definitions = new Map()
  const { webServer = TRUSTED_WEB_SERVER, ...toolDependencies } = dependencies
  registerBusinessTools({
    webServer,
    tools: { register(definition) { definitions.set(definition.name, definition); return () => definitions.delete(definition.name) } },
  }, { preset: 'tradeloom-center' }, { ...toolDependencies, port: server.address().port })
  return { requests, tools: definitions }
}

async function defaultHandler(record, response) {
  if (record.method === 'GET' && record.path === '/') {
    response.writeHead(200, { 'set-cookie': [`csrftoken=${CSRF_TOKEN}; Path=/; SameSite=Lax`] })
    response.end('fixture')
    return
  }
  if (record.method !== 'GET' && (record.headers.cookie !== `csrftoken=${CSRF_TOKEN}` || record.headers['x-csrftoken'] !== CSRF_TOKEN)) {
    response.writeHead(403, { 'content-type': 'text/html' })
    response.end('<html>csrf rejected</html>')
    return
  }
  let payload = {}
  if (record.path === '/api/erpnext/status') payload = {
    configured: true, connected: true, status: 'connected', error_code: '',
  }
  else if (record.path.startsWith('/api/erpnext/records?')) payload = {
    doctype: 'Item',
    records: [{
      doctype: 'Item', data: { name: 'ITEM-1', item_code: 'ITEM-1', item_name: 'Demo item', secret_field: 'drop' },
      external_ref: { system: 'erpnext', instance_id: 'local', doctype: 'Item', name: 'ITEM-1', modified: 'm1' },
    }],
    next_offset: 20,
  }
  else if (record.path.startsWith('/api/erpnext/record?')) payload = {
    doctype: 'Purchase Order',
    data: { name: 'PO/2026 001', supplier: 'SUP-1', docstatus: 0, secret_field: 'drop' },
    external_ref: { system: 'erpnext', instance_id: 'local', doctype: 'Purchase Order', name: 'PO/2026 001', modified: null },
  }
  else if (record.path === '/api/workflow-intent/preview') payload = {
    status: 'ready', task_type: 'prepare_product_data', sources: [{ kind: 'batch', id: 'batch-1' }],
    prompt: { version: 'prompt-v1', sha256: 'p-hash' }, rules: { version: 'rules-v1', sha256: 'r-hash' },
    confirmation_token: 'signed-confirmation-secret',
  }
  else if (record.path.endsWith('/dispatch')) payload = {
    workflow_id: 'wf-1', subtask_id: 'sub-1', status: 'waiting_human',
    execution_mode: 'local_mock', planning_mode: 'simulated_rules', agentarts: 'not_configured',
    notice: '本地模拟执行',
    step: { id: 'step-1', key: 'workflow:wf-1:subtask:sub-1', status: 'waiting_human', attempt: 1 },
  }
  else if (record.path.startsWith('/api/product-library')) payload = [{
    id: 'product-1', task_id: 'batch-1', sku: 'SKU-1', name: 'Ribbon', material: 'silk',
    missing_fields: ['color'], batch: { id: 'batch-1', title: 'Batch', status: 'ready' },
    current_version: 2, revision_status: 'confirmed',
    latest_revision: { version: 2, status: 'confirmed', source: 'legacy_confirm', snapshot: { sku: 'SKU-1' }, updated_at: '2026-10-19' },
  }]
  else if (record.path === '/api/workflow-tasks/wf-1') payload = {
    id: 'wf-1', batch_id: 'batch-1', status: 'waiting_human', current_step: 'review', mode: 'local_mock', execution: 'simulated_rules',
    steps: [{ id: 'step-1', step_key: 'center_plan', status: 'completed', attempt: 1 }],
    subtasks: [{ id: 'sub-1', agent_role: 'product_profile', status: 'queued', retry_count: 0, depends_on: [] }],
    reviews: [{ id: 'review-1', review_key: 'source-check', status: 'pending', question: 'Confirm source?', source_refs: { product_id: 'product-1' } }],
    reviews_scope: 'business_facts',
    pending_review_count: 1, unresolved_review_count: 1,
    dispatch_target: { subtask_id: '', idempotency_key: '', blocked_reason: '存在待填写或待核验的人审事项，当前不能执行。' },
  }
  else if (record.path === '/api/workflow-tasks/wf-1/deliverables') payload = {
    workflow_task_id: 'wf-1', workflow_status: 'completed', current_step: 'delivery',
    delivery_review_summary: {
      scope: 'delivery_bundle', generation_step_id: 'step-1', event_id: 'event-1', decision: 'approve',
      reviewer: 'automated-demo-review (demo)', reviewed_at: '2026-10-21T10:00:00+08:00',
      artifact_version_ids: ['version-2'], note: 'must-not-reach-model', request_fingerprint: 'must-not-reach-model',
    },
    quality_checks: [{ filename: 'catalog.html', passed: true, bytes: 123, sha256: 'a'.repeat(64) }],
    artifacts: [{ id: 'artifact-1', artifact_type: 'catalog_html', current_version: 2, status: 'ready', versions: [
      { id: 'version-2', version: 2, status: 'approved', sha256: 'b'.repeat(64), source_product_versions: [{ product_id: 'product-1', version: 2 }], created_at: '2026-10-19' },
    ] }],
    quality_report: { internal_marker: 'must-not-reach-model' },
  }
  response.writeHead(200, { 'content-type': 'application/json' })
  response.end(JSON.stringify(payload))
}

function agent(preset = 'tradeloom-center') {
  return { agent: { session: { header: { agentPreset: preset } } } }
}

function dataOf(result) { return JSON.parse(result.data) }

test('registers bounded business tools with native ToolRuntime definitions and no default export', async () => {
  const tools = new Map()
  const ctx = { webServer: TRUSTED_WEB_SERVER, tools: { register(definition) { tools.set(definition.name, definition); return () => tools.delete(definition.name) } } }
  registerBusinessTools(ctx, { preset: 'tradeloom-center' })
  assert.deepEqual([...tools.keys()], [
    'tradeloom_read_products', 'tradeloom_read_workflow_task', 'tradeloom_read_deliverables',
    'tradeloom_preview_workflow_intent', 'tradeloom_dispatch_workflow_subtask',
    'tradeloom_erpnext_status', 'tradeloom_erpnext_list', 'tradeloom_erpnext_detail',
  ])
  for (const definition of tools.values()) {
    assert.equal(typeof definition.execute, 'function')
    assert.equal(typeof definition.output.render, 'function')
    assert.equal(definition.output.schema.additionalProperties, false)
  }
  const module = await import('../business-tools.js')
  assert.equal('default' in module, false)
  assert.deepEqual(module.inject, ['tools', 'webServer'])
  assert.equal(typeof module.apply, 'function')
  const toolsLibrary = process.env.TRADELOOM_DSH_TOOLS_LIBRARY
  if (toolsLibrary) {
    const { ToolRuntime, assertSupportedJsonSchema } = await import(new URL(`file:///${toolsLibrary.replaceAll('\\', '/')}`))
    const registrations = []
    const runtime = { ctx: {}, layers: { effect(_ctx, install) { return install({ tools: { insert(name, definition) { registrations.push({ name, definition }); return () => {} } } }) } } }
    for (const definition of tools.values()) {
      assertSupportedJsonSchema(definition.output.schema)
      if (definition.name.startsWith('tradeloom_erpnext_')) {
        assertSupportedJsonSchema(definition.parameters)
        assert.equal(definition.parameters.type, 'object', `${definition.name} wire parameters must have an object root`)
      }
      assert.equal(typeof ToolRuntime.prototype.register.call(runtime, definition), 'function')
    }
    assert.equal(registrations.length, 8)
  }
})

test('preset configuration limits registered tools to the center, product, and delivery sets', () => {
  const expected = {
    'tradeloom-center': [
      'tradeloom_read_products', 'tradeloom_read_workflow_task', 'tradeloom_read_deliverables',
      'tradeloom_preview_workflow_intent', 'tradeloom_dispatch_workflow_subtask',
      'tradeloom_erpnext_status', 'tradeloom_erpnext_list', 'tradeloom_erpnext_detail',
    ],
    'tradeloom-product': ['tradeloom_read_products', 'tradeloom_erpnext_status', 'tradeloom_erpnext_list', 'tradeloom_erpnext_detail'],
    'tradeloom-delivery': ['tradeloom_read_workflow_task', 'tradeloom_read_deliverables', 'tradeloom_erpnext_status', 'tradeloom_erpnext_list', 'tradeloom_erpnext_detail'],
  }
  for (const [preset, names] of Object.entries(expected)) {
    const registered = []
    apply({
      webServer: TRUSTED_WEB_SERVER,
      tools: { register(definition) { registered.push(definition.name); return () => {} } },
    }, { preset })
    assert.deepEqual(registered, names, preset)
  }
  const unknown = []
  apply({ tools: { register(definition) { unknown.push(definition.name); return () => {} } } }, { preset: 'tradeloom-unknown' })
  apply({ tools: { register(definition) { unknown.push(definition.name); return () => {} } } }, {})
  apply({ tools: { register(definition) { unknown.push(definition.name); return () => {} } } }, { preset: 'tradeloom-market-placeholder' })
  apply({ tools: { register(definition) { unknown.push(definition.name); return () => {} } } }, { preset: 'tradeloom-quote-placeholder' })
  apply({ tools: { register(definition) { unknown.push(definition.name); return () => {} } } }, { preset: 'tradeloom-user-profile-demo' })
  assert.deepEqual(unknown, [])
})

test('ERPNext tools use closed arguments, fixed Django paths, and project bounded DTOs', async t => {
  const { requests, tools } = await fixture(t)
  const listTool = tools.get('tradeloom_erpnext_list')
  assert.deepEqual(listTool.parameters.required, ['doctype'])
  assert.deepEqual(listTool.parameters.properties.doctype.enum, [
    'Item', 'Customer', 'Supplier', 'Warehouse', 'Bin', 'Sales Order', 'Purchase Order',
  ])
  assert.equal(listTool.parameters.additionalProperties, false)

  const listed = await listTool.execute({ doctype: 'Item', fields_json: '["item_code"]', filters_json: '{"item_group":"Ribbon"}', limit: 20, offset: 0 }, agent())
  assert.equal(listed.ok, true)
  assert.deepEqual(dataOf(listed), {
    doctype: 'Item',
    records: [{
      doctype: 'Item', data: { name: 'ITEM-1', item_code: 'ITEM-1', item_name: 'Demo item' }, truncated_children: [],
      external_ref: { system: 'erpnext', instance_id: 'local', doctype: 'Item', name: 'ITEM-1', modified: 'm1' },
    }],
    next_offset: 20,
  })
  const query = new URL(`http://fixture${requests[0].path}`).searchParams
  assert.equal(query.get('doctype'), 'Item')
  assert.equal(query.get('fields'), 'item_code')
  assert.equal(query.get('filters'), '{"item_group":"Ribbon"}')
  assert.equal(query.get('limit'), '20')
  assert.equal(query.get('offset'), '0')

  const detail = await tools.get('tradeloom_erpnext_detail').execute({ doctype: 'Purchase Order', name: 'PO/2026 001' }, agent())
  assert.equal(detail.ok, true)
  assert.deepEqual(dataOf(detail), {
    doctype: 'Purchase Order', data: { name: 'PO/2026 001', supplier: 'SUP-1', docstatus: 0 }, truncated_children: [],
    external_ref: { system: 'erpnext', instance_id: 'local', doctype: 'Purchase Order', name: 'PO/2026 001', modified: null },
  })
  assert.equal(new URL(`http://fixture${requests[1].path}`).searchParams.get('name'), 'PO/2026 001')
  assert.equal(requests.length, 2)
})

test('ERPNext detail rejects records without a nonempty name and matching external reference', async t => {
  const { tools } = await fixture(t, async (record, response) => {
    if (record.path === '/api/erpnext/record?doctype=Purchase+Order&name=PO-1') {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({
        doctype: 'Purchase Order', data: { supplier: 'SUP-1' },
        external_ref: { system: 'erpnext', instance_id: 'local', doctype: 'Purchase Order', modified: null },
      }))
      return
    }
    return defaultHandler(record, response)
  })

  const result = await tools.get('tradeloom_erpnext_detail').execute(
    { doctype: 'Purchase Order', name: 'PO-1' }, agent(),
  )
  assert.equal(result.error_code, 'invalid_erpnext_record_dto')
})

test('ERPNext detail reports child tables truncated at the projection limit', async t => {
  const items = Array.from({ length: 101 }, (_, index) => ({ item_code: `ITEM-${index}`, qty: 1 }))
  const { tools } = await fixture(t, async (record, response) => {
    if (record.path.startsWith('/api/erpnext/record?')) {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({
        doctype: 'Purchase Order', data: { name: 'PO-1', items },
        external_ref: { system: 'erpnext', instance_id: 'local', doctype: 'Purchase Order', name: 'PO-1', modified: null },
      }))
      return
    }
    return defaultHandler(record, response)
  })

  const result = await tools.get('tradeloom_erpnext_detail').execute(
    { doctype: 'Purchase Order', name: 'PO-1' }, agent(),
  )
  assert.equal(result.ok, true)
  assert.equal(dataOf(result).data.items.length, 100)
  assert.deepEqual(dataOf(result).truncated_children, ['items'])
})

test('ERPNext status tool reports only the fixed status DTO', async t => {
  const { requests, tools } = await fixture(t)
  const result = await tools.get('tradeloom_erpnext_status').execute({}, agent('tradeloom-product'))
  assert.equal(result.ok, true)
  assert.deepEqual(dataOf(result), { configured: true, connected: true, status: 'connected', error_code: '' })
  assert.equal(requests.length, 1)
  assert.equal(requests[0].path, '/api/erpnext/status')
})

test('ERPNext tools reject unsupported doctypes, free-form URLs, and unauthorized presets before HTTP', async t => {
  const { requests, tools } = await fixture(t)
  const denied = await tools.get('tradeloom_erpnext_detail').execute({ doctype: 'Item', name: 'ITEM-1' }, agent('tradeloom-unknown'))
  const badDoctype = await tools.get('tradeloom_erpnext_list').execute({ doctype: 'User' }, agent())
  const badArgs = await tools.get('tradeloom_erpnext_status').execute({ base_url: 'https://other.test' }, agent())
  const badFilterJson = await tools.get('tradeloom_erpnext_list').execute({ doctype: 'Item', filters_json: '[]' }, agent())
  assert.equal(denied.error_code, 'role_not_authorized')
  assert.equal(badDoctype.error_code, 'invalid_arguments')
  assert.equal(badArgs.error_code, 'invalid_arguments')
  assert.equal(badFilterJson.error_code, 'invalid_arguments')
  assert.equal(requests.length, 0)
})

test('ERPNext tools serialize object-root parameters in the pinned provider wire payload', async t => {
  const toolsLibrary = process.env.TRADELOOM_DSH_TOOLS_LIBRARY
  if (!toolsLibrary) return t.skip('requires the pinned compiled DSH tools library')

  const definitions = new Map()
  const { ToolRuntime } = await import(pathToFileURL(toolsLibrary).href)
  const runtime = {
    ctx: {},
    layers: { effect(_ctx, install) { return install({ tools: { insert(name, definition) { definitions.set(name, definition); return () => {} } } }) } },
  }
  registerBusinessTools({ webServer: TRUSTED_WEB_SERVER, tools: { register(definition) {
    return ToolRuntime.prototype.register.call(runtime, definition)
  } } }, { preset: 'tradeloom-center' })

  const packagesRoot = resolve(dirname(toolsLibrary), '../../../llm/llm-pi-ai/node_modules/@earendil-works/pi-ai/dist')
  const [{ stream }, { getBuiltinModels }, { normalizeContext }] = await Promise.all([
    import(pathToFileURL(resolve(packagesRoot, 'api/openai-completions.js')).href),
    import(pathToFileURL(resolve(packagesRoot, 'providers/all.js')).href),
    import(pathToFileURL(resolve(packagesRoot, 'utils/transcript.js')).href),
  ])
  const model = getBuiltinModels('deepseek').find(candidate => candidate.api === 'openai-completions')
  assert.ok(model)
  let wirePayload
  const events = stream(model, normalizeContext({
    systemPrompt: 'Test only.',
    tools: [...definitions.values()],
    messages: [{ role: 'user', content: 'List ERP records.' }],
  }), {
    apiKey: 'fixture-only-not-a-secret',
    fetch: async () => { throw new Error('wire inspection must stop before network dispatch') },
    onPayload(payload) { wirePayload = payload; throw new Error('captured before dispatch') },
  })
  for await (const _event of events) { /* drain the local provider serializer only */ }

  for (const name of ['tradeloom_erpnext_status', 'tradeloom_erpnext_list', 'tradeloom_erpnext_detail']) {
    const wireTool = wirePayload?.tools?.find(tool => tool.function?.name === name)
    assert.equal(wireTool?.function?.parameters?.type, 'object', JSON.stringify(wirePayload?.tools))
  }
})

test('preview uses fixed Django path, trusted LAN authority and CSRF; strips signed token and requests human confirmation', async t => {
  const { requests, tools } = await fixture(t)
  const result = await tools.get('tradeloom_preview_workflow_intent').execute(
    { batch_id: 'batch-1', user_goal: '整理商品资料' }, agent(),
  )
  assert.equal(result.ok, true)
  assert.equal(result.requires_human_confirmation, true)
  assert.equal(result.business_ui_url, 'http://192.168.1.23:3088/business/agent-center')
  assert.deepEqual(requests.map(item => [item.method, item.path]), [
    ['GET', '/'], ['POST', '/api/workflow-intent/preview'],
  ])
  const post = requests[1]
  assert.equal(post.headers.host, '192.168.1.23:3088')
  assert.equal(post.headers.origin, 'http://192.168.1.23:3088')
  assert.equal(post.headers.cookie, `csrftoken=${CSRF_TOKEN}`)
  assert.equal(post.headers['x-csrftoken'], CSRF_TOKEN)
  assert.equal(post.headers.authorization, undefined)
  assert.equal(post.body, JSON.stringify({ batch_id: 'batch-1', user_goal: '整理商品资料' }))
  assert.equal(JSON.stringify(result).includes('signed-confirmation-secret'), false)
  assert.equal(dataOf(result).prompt.version, 'prompt-v1')
  assert.equal(dataOf(result).rules.sha256, 'r-hash')
})

test('structured preview hands an allowlisted literal proposal to Agent Center without exposing its confirmation token', async t => {
  const { requests, tools } = await fixture(t)
  const proposal = {
    batch_id: 'batch-1',
    user_goal: 'Please prepare the approved English catalog.',
    task_type: 'generate_deliverables',
  }
  const result = await tools.get('tradeloom_preview_workflow_intent').execute(proposal, agent())

  assert.equal(result.ok, true)
  assert.equal(result.requires_human_confirmation, true)
  assert.deepEqual(JSON.parse(requests[1].body), proposal)
  const handoff = new URL(result.business_ui_url)
  assert.equal(handoff.origin, 'http://192.168.1.23:3088')
  assert.equal(handoff.pathname, '/business/agent-center')
  assert.equal(handoff.search, '')
  const fragment = new URLSearchParams(handoff.hash.slice(1))
  assert.deepEqual(JSON.parse(fragment.get('proposal')), { version: 1, ...proposal })
  assert.equal(JSON.stringify(result).includes('signed-confirmation-secret'), false)
})

test('structured proposal authority must match the live WebServer origin', async t => {
  const { requests, tools } = await fixture(t, defaultHandler, {
    webServer: { ...TRUSTED_WEB_SERVER, getOrigin: () => 'http://192.168.1.24:3088' },
  })
  const result = await tools.get('tradeloom_preview_workflow_intent').execute({
    batch_id: 'batch-1', user_goal: 'Prepare the approved sample catalog.', task_type: 'generate_deliverables',
  }, agent())
  assert.equal(result.ok, false)
  assert.equal(result.error_code, 'business_authority_unavailable')
  assert.deepEqual(requests, [])
})

test('product, workflow and deliverable reads keep source, version, readiness and review status while dropping large details', async t => {
  const { requests, tools } = await fixture(t)
  const product = await tools.get('tradeloom_read_products').execute({ batch_id: 'batch-1' }, agent('tradeloom-product'))
  const workflow = await tools.get('tradeloom_read_workflow_task').execute({ workflow_id: 'wf-1' }, agent('tradeloom-delivery'))
  const delivery = await tools.get('tradeloom_read_deliverables').execute({ workflow_id: 'wf-1' }, agent('tradeloom-delivery'))
  assert.deepEqual(requests.map(item => item.path), [
    '/api/product-library?batch_id=batch-1', '/api/workflow-tasks/wf-1', '/api/workflow-tasks/wf-1/deliverables',
  ])
  assert.equal(product.ok, true, JSON.stringify(product))
  assert.equal(dataOf(product)[0].missing_fields[0], 'color')
  assert.equal(dataOf(product)[0].latest_revision.source, 'legacy_confirm')
  assert.equal(dataOf(workflow).reviews[0].status, 'pending')
  assert.equal(dataOf(workflow).reviews_scope, 'business_facts')
  assert.equal(dataOf(workflow).pending_review_count, 1)
  assert.equal('dispatch_target' in dataOf(workflow), false, 'delivery experts do not receive center dispatch targets')
  assert.equal(dataOf(delivery).artifacts[0].versions[0].status, 'approved')
  assert.deepEqual(dataOf(delivery).delivery_review_summary, {
    scope: 'delivery_bundle', generation_step_id: 'step-1', event_id: 'event-1', decision: 'approve',
    reviewer: 'automated-demo-review (demo)', reviewed_at: '2026-10-21T10:00:00+08:00', artifact_version_ids: ['version-2'],
  })
  assert.equal(JSON.stringify(delivery).includes('must-not-reach-model'), false)
  assert.equal(requests[0].headers.authorization, undefined)
})

test('deliverables from older API responses project a null delivery review summary', async t => {
  const { tools } = await fixture(t, async (record, response) => {
    if (record.method === 'GET' && record.path === '/api/workflow-tasks/wf-1/deliverables') {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ workflow_task_id: 'wf-1', artifacts: [] }))
      return
    }
    await defaultHandler(record, response)
  })
  const result = await tools.get('tradeloom_read_deliverables').execute({ workflow_id: 'wf-1' }, agent('tradeloom-delivery'))
  assert.equal(result.ok, true)
  assert.equal(dataOf(result).delivery_review_summary, null)
})

test('dispatch reuses the saved subtask idempotency key and Django rejects/controls side effects', async t => {
  const { requests, tools } = await fixture(t, async (record, response) => {
    if (record.method === 'GET' && record.path === '/api/workflow-tasks/wf-1') {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ id: 'wf-1', dispatch_target: {
        subtask_id: 'sub-1', idempotency_key: 'workflow:wf-1:subtask:sub-1:resume:apply-7:prior:step-2:attempt:2', blocked_reason: '',
      } }))
      return
    }
    return defaultHandler(record, response)
  })
  const result = await tools.get('tradeloom_dispatch_workflow_subtask').execute(
    { workflow_id: 'wf-1', subtask_id: 'sub-1' }, agent(),
  )
  assert.equal(result.ok, true)
  assert.deepEqual(requests.map(item => [item.method, item.path]), [
    ['GET', '/api/workflow-tasks/wf-1'], ['GET', '/'], ['POST', '/api/workflow-tasks/wf-1/subtasks/sub-1/dispatch'],
  ])
  assert.deepEqual(JSON.parse(requests[2].body), { idempotency_key: 'workflow:wf-1:subtask:sub-1:resume:apply-7:prior:step-2:attempt:2' })
  assert.equal(requests[2].headers.host, '192.168.1.23:3088')
  assert.equal(requests[2].headers.origin, 'http://192.168.1.23:3088')
  assert.equal(requests[2].headers.cookie, `csrftoken=${CSRF_TOKEN}`)
  assert.equal(requests[2].headers.authorization, undefined)
  assert.equal(dataOf(result).status, 'waiting_human')
  assert.equal(dataOf(result).execution_mode, 'local_mock')
  assert.equal(dataOf(result).planning_mode, 'simulated_rules')
  assert.equal(result.business_ui_url, '/business/workflow-tasks/wf-1')
})

test('a server-reported human review block prevents dispatch and points to the existing review UI', async t => {
  const { requests, tools } = await fixture(t, async (record, response) => {
    if (record.path === '/api/workflow-tasks/wf-1') {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ dispatch_target: { subtask_id: '', idempotency_key: '', blocked_reason: '存在待填写或待核验的人审事项，当前不能执行。' } }))
      return
    }
    return defaultHandler(record, response)
  })
  const result = await tools.get('tradeloom_dispatch_workflow_subtask').execute(
    { workflow_id: 'wf-1', subtask_id: 'sub-1' }, agent(),
  )
  assert.equal(dataOf(result).status, 'blocked')
  assert.match(dataOf(result).blocked_reason, /人审/)
  assert.equal(result.business_ui_url, '/business/workflow-tasks/wf-1')
  assert.deepEqual(requests.map(item => item.path), ['/api/workflow-tasks/wf-1'])
})

test('role gates and closed input schemas refuse writes before opening HTTP connections', async t => {
  const { requests, tools } = await fixture(t)
  const denied = await tools.get('tradeloom_dispatch_workflow_subtask').execute(
    { workflow_id: 'wf-1', subtask_id: 'sub-1' }, agent('tradeloom-delivery'),
  )
  const unknownUrl = await tools.get('tradeloom_read_products').execute({ url: 'http://attacker.invalid' }, agent())
  assert.equal(denied.error_code, 'role_not_authorized')
  assert.equal(unknownUrl.error_code, 'invalid_arguments')
  assert.equal(requests.length, 0)
})

test('rejects a non-LAN configured authority and does not expose HTML or CSRF values on HTTP errors', async t => {
  const { requests, tools } = await fixture(t, async (record, response) => {
    if (record.path === '/') {
      response.writeHead(200, { 'set-cookie': [`csrftoken=${CSRF_TOKEN}; Path=/`] })
      response.end('fixture')
      return
    }
    response.writeHead(403, { 'content-type': 'text/html' })
    response.end(`<html>${CSRF_TOKEN} ${NATIVE_TOKEN}</html>`)
  })
  const blocked = await tools.get('tradeloom_read_workflow_task').execute({ workflow_id: 'wf-1' }, agent())
  assert.equal(blocked.error_code, 'django_http_403')
  assert.equal(JSON.stringify(blocked).includes(CSRF_TOKEN), false)
  assert.equal(JSON.stringify(blocked).includes(NATIVE_TOKEN), false)
  assert.equal(requests[0].headers.authorization, undefined)

  const definitions = new Map()
  registerBusinessTools({ webServer: { protocol: 'http:', host: '127.0.0.1', port: 3088 }, tools: { register(def) { definitions.set(def.name, def); return () => {} } } }, { preset: 'tradeloom-center' })
  const invalid = await definitions.get('tradeloom_read_workflow_task').execute({ workflow_id: 'wf-1' }, agent())
  assert.equal(invalid.error_code, 'business_authority_unavailable')
})

test('aborts the loopback request on native cancellation and enforces a bounded timeout', async t => {
  const handler = (_record, _response) => new Promise(() => {})
  const cancelledFixture = await fixture(t, handler)
  const controller = new AbortController()
  const cancelled = cancelledFixture.tools.get('tradeloom_read_workflow_task').execute(
    { workflow_id: 'wf-1' }, { ...agent(), signal: controller.signal },
  )
  setTimeout(() => controller.abort(), 15)
  assert.equal((await cancelled).error_code, 'tool_cancelled')

  const timedFixture = await fixture(t, handler, { timeoutMs: 20 })
  const timed = await timedFixture.tools.get('tradeloom_read_workflow_task').execute(
    { workflow_id: 'wf-1' }, agent(),
  )
  assert.equal(timed.error_code, 'django_timeout')
})
