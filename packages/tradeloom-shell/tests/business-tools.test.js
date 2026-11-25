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
  const { webServer = TRUSTED_WEB_SERVER, preset = 'tradeloom-center', ...toolDependencies } = dependencies
  registerBusinessTools({
    webServer,
    tools: { register(definition) { definitions.set(definition.name, definition); return () => definitions.delete(definition.name) } },
  }, { preset }, { ...toolDependencies, port: server.address().port })
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
    'tradeloom_workflow_files', 'tradeloom_scene_memory_read', 'tradeloom_scene_memory_write',
    'tradeloom_read_products', 'tradeloom_read_workflow_task', 'tradeloom_read_deliverables',
    'tradeloom_preview_workflow_intent', 'tradeloom_dispatch_workflow_subtask',
    'tradeloom_begin_native_workflow_assignment', 'tradeloom_bind_native_workflow_expert',
    'tradeloom_intake_sources', 'tradeloom_narrative_sources', 'tradeloom_narrative_excerpt',
    'tradeloom_intake_candidates', 'tradeloom_intake_candidate', 'tradeloom_read_execution_plan',
    'tradeloom_erpnext_status', 'tradeloom_erpnext_list', 'tradeloom_erpnext_detail',
    'tradeloom_erpnext_create_quotation_draft', 'tradeloom_erpnext_update_quotation_draft',
    'tradeloom_erpnext_read_quotation_draft_operation',
    'tradeloom_erpnext_create_po_draft', 'tradeloom_erpnext_update_po_draft',
    'tradeloom_erpnext_read_po_draft_operation',
    'tradeloom_dispatch_create', 'tradeloom_dispatch_list', 'tradeloom_dispatch_claim', 'tradeloom_dispatch_receipt',
  ])
  for (const definition of tools.values()) {
    assert.equal(typeof definition.execute, 'function')
    assert.equal(typeof definition.output.render, 'function')
    assert.equal(definition.output.schema.additionalProperties, false)
  }
  const module = await import('../business-tools.js')
  assert.equal('default' in module, false)
  assert.deepEqual(module.inject, ['tools', 'webServer', 'agents', 'sceneMemoryOriginAuthority', 'workflowFileAuthority'])
  assert.equal(typeof module.apply, 'function')
  const toolsLibrary = process.env.TRADELOOM_DSH_TOOLS_LIBRARY
  if (toolsLibrary) {
    const { ToolRuntime, assertSupportedJsonSchema } = await import(new URL(`file:///${toolsLibrary.replaceAll('\\', '/')}`))
    const registrations = []
    const runtime = { ctx: {}, layers: { effect(_ctx, install) { return install({ tools: { insert(name, definition) { registrations.push({ name, definition }); return () => {} } } }) } } }
    for (const definition of tools.values()) {
      assertSupportedJsonSchema(definition.output.schema)
      if (definition.name.startsWith('tradeloom_erpnext_') || definition.name.startsWith('tradeloom_intake_') || definition.name.startsWith('tradeloom_narrative_') || ['tradeloom_read_execution_plan', 'tradeloom_read_order_followup', 'tradeloom_workflow_files'].includes(definition.name)) {
        assertSupportedJsonSchema(definition.parameters)
        assert.equal(definition.parameters.type, 'object', `${definition.name} wire parameters must have an object root`)
      }
      assert.equal(typeof ToolRuntime.prototype.register.call(runtime, definition), 'function')
    }
    assert.equal(registrations.length, 29)
  }
})

test('preset configuration limits registered tools to the center, product, and delivery sets', () => {
  const expected = {
    'tradeloom-center': [
      'tradeloom_workflow_files', 'tradeloom_scene_memory_read', 'tradeloom_scene_memory_write',
      'tradeloom_read_products', 'tradeloom_read_workflow_task', 'tradeloom_read_deliverables',
      'tradeloom_preview_workflow_intent', 'tradeloom_dispatch_workflow_subtask',
      'tradeloom_begin_native_workflow_assignment', 'tradeloom_bind_native_workflow_expert',
      'tradeloom_intake_sources', 'tradeloom_narrative_sources', 'tradeloom_narrative_excerpt',
      'tradeloom_intake_candidates', 'tradeloom_intake_candidate', 'tradeloom_read_execution_plan',
      'tradeloom_erpnext_status', 'tradeloom_erpnext_list', 'tradeloom_erpnext_detail',
      'tradeloom_erpnext_create_quotation_draft', 'tradeloom_erpnext_update_quotation_draft',
      'tradeloom_erpnext_read_quotation_draft_operation',
      'tradeloom_erpnext_create_po_draft', 'tradeloom_erpnext_update_po_draft',
      'tradeloom_erpnext_read_po_draft_operation',
      'tradeloom_dispatch_create', 'tradeloom_dispatch_list', 'tradeloom_dispatch_claim', 'tradeloom_dispatch_receipt',
    ],
    'tradeloom-product': ['tradeloom_scene_memory_read', 'tradeloom_scene_memory_write', 'tradeloom_read_products', 'tradeloom_read_workflow_task', 'tradeloom_submit_native_workflow_advice', 'tradeloom_intake_sources', 'tradeloom_intake_candidates', 'tradeloom_intake_candidate', 'tradeloom_erpnext_status', 'tradeloom_erpnext_list', 'tradeloom_erpnext_detail', 'tradeloom_dispatch_create', 'tradeloom_dispatch_list', 'tradeloom_dispatch_claim', 'tradeloom_dispatch_receipt'],
    'tradeloom-delivery': ['tradeloom_scene_memory_read', 'tradeloom_scene_memory_write', 'tradeloom_read_workflow_task', 'tradeloom_read_deliverables', 'tradeloom_submit_native_workflow_advice', 'tradeloom_intake_sources', 'tradeloom_intake_candidates', 'tradeloom_intake_candidate', 'tradeloom_read_execution_plan', 'tradeloom_erpnext_status', 'tradeloom_erpnext_list', 'tradeloom_erpnext_detail', 'tradeloom_dispatch_create', 'tradeloom_dispatch_list', 'tradeloom_dispatch_claim', 'tradeloom_dispatch_receipt'],
    'tradeloom-order-production': ['tradeloom_read_order_followup'],
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

test('order follow-up reader is read-only, exact-keyed, bounded, and restricted to the order-production role', async t => {
  const { requests, tools } = await fixture(t, async (record, res) => {
    if (record.path === '/') return defaultHandler(record, res)
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ ok: true, order: {
      schema_version: 'order-followup.v1', order_key: 'SO-1', inquiries: [], requirements: { status: 'missing', records: [] },
      purchase_plans: { status: 'missing', records: [] },
      material_receipts: { status: 'missing', records: [] }, production_handoff: { status: 'missing', records: [] },
      shipment_payments: { status: 'missing', records: [] },
      erpnext: { status: 'not_configured', supported_doctypes: ['Sales Order'], unsupported_doctypes: ['Work Order'], records: [] },
    } }))
  }, { preset: 'tradeloom-order-production' })
  const reader = tools.get('tradeloom_read_order_followup')
  assert.equal(reader.parameters.additionalProperties, false)
  assert.deepEqual(reader.parameters.required, ['order_key'])
  assert.equal((await reader.execute({ order_key: 'SO-1', extra: true }, agent('tradeloom-order-production'))).error_code, 'invalid_arguments')
  assert.equal((await reader.execute({ order_key: ' SO-1' }, agent('tradeloom-order-production'))).error_code, 'invalid_arguments')
  assert.equal(requests.length, 0)
  assert.equal((await reader.execute({ order_key: 'SO-1' }, agent('tradeloom-product'))).error_code, 'role_not_authorized')
  assert.equal(requests.length, 0)
  const allowed = await reader.execute({ order_key: 'SO-1' }, agent('tradeloom-order-production'))
  assert.equal(allowed.ok, true)
  assert.equal(requests.length, 1)
  assert.equal(requests[0].method, 'GET')
  assert.equal(requests[0].path, '/api/orders?order_key=SO-1')
  assert.equal(allowed.business_ui_url, '/business/orders?order_key=SO-1')
})

test('execution plan reader is bounded, read-only, role-gated before HTTP, and projects exact source refs only', async t => {
  const id = 'a'.repeat(32)
  const responseDto = {
    ok: true,
    plan: { id, requirement_revision_id: 'b'.repeat(32), revision: 2, status: 'draft',
      requirement_refs: [{ field_key: 'description', evidence_ids: ['c'.repeat(32)] }],
      materials: [{ item_ref: null, resolution: 'unresolved', proposal: { description: 'M'.repeat(700), quantity: '0', unit: 'U'.repeat(100), expected_date: null }, supporting_requirement_inputs: [] }],
      operations: [{ operation_ref: null, resolution: 'unresolved', proposal: { description: 'cut', sequence: 1 }, supporting_requirement_inputs: [] }] },
    requirement_revision: { id: 'b'.repeat(32), revision: 7, status: 'confirmed', fields: { description: 'F'.repeat(700) },
      source_refs: { description: [{ id: 'c'.repeat(32), field_key: 'description', kind: 'source_record', status: 'unverified', snapshot_id: 'd'.repeat(32), sheet_index: 1, coordinate: 'A1', summary: 'S'.repeat(200), path: 'secret/path', filename: 'secret.xlsx' }, { id: 'invalid-evidence-id', field_key: 'description' }] } },
    latest_revision: 2, is_latest: true, actual: { status: 'missing', quantity: 999 }, path: 'private/path', raw_body: 'drop-me',
  }
  const { requests, tools } = await fixture(t, async (record, res) => {
    if (record.path === '/') return defaultHandler(record, res)
    res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(responseDto))
  })
  const reader = tools.get('tradeloom_read_execution_plan')
  assert.equal(reader.parameters.additionalProperties, false)
  assert.equal(reader.parameters.required.includes('plan_revision_id'), true)
  assert.equal(reader.parameters.additionalProperties, false)
  const invalid = await reader.execute({ plan_revision_id: id, extra: true }, agent())
  assert.equal(invalid.error_code, 'invalid_arguments')
  assert.equal(requests.length, 0)
  assert.equal((await reader.execute({ plan_revision_id: 'not-a-plan' }, agent())).error_code, 'invalid_arguments')
  assert.equal(requests.length, 0)
  const denied = await reader.execute({ plan_revision_id: id }, agent('tradeloom-product'))
  assert.equal(denied.error_code, 'role_not_authorized')
  assert.equal(requests.length, 0)
  const allowed = await reader.execute({ plan_revision_id: id }, agent('tradeloom-center'))
  assert.equal(allowed.ok, true)
  assert.equal(requests.length, 1)
  assert.equal(requests[0].method, 'GET')
  assert.equal(requests[0].path, `/api/execution-plans/${id}`)
  const projected = dataOf(allowed)
  assert.equal(projected.requirement.source_refs.description[0].coordinate, 'A1')
  assert.equal(projected.plan.materials[0].proposal.quantity, '0')
  assert.deepEqual(projected.plan.actual, { status: 'missing' })
  assert.equal(projected.truncated, true, 'every bounded text cut or malformed evidence ID must be visible')
  assert.equal(projected.plan.materials[0].proposal.description.length, 500)
  assert.equal(projected.plan.materials[0].proposal.unit.length, 80)
  assert.equal(projected.requirement.fields.description.length, 500)
  assert.equal(projected.requirement.source_refs.description[0].summary.length, 160)
  assert.deepEqual(projected.plan.requirement_refs[0].evidence_ids, ['c'.repeat(32)])
  const serialized = JSON.stringify(projected)
  for (const secret of ['secret/path', 'secret.xlsx', 'private/path', 'drop-me', '999']) assert.equal(serialized.includes(secret), false)
  const deliveryFixture = await fixture(t, async (record, res) => {
    if (record.path === '/') return defaultHandler(record, res)
    res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(responseDto))
  }, { preset: 'tradeloom-delivery' })
  const delivery = await deliveryFixture.tools.get('tradeloom_read_execution_plan').execute({ plan_revision_id: id }, agent('tradeloom-delivery'))
  assert.equal(delivery.ok, true)
  assert.equal(deliveryFixture.requests[0].method, 'GET')
})

test('Quotation draft tools are center-only and derive authority from the live execution preset', async t => {
  const registered = preset => {
    const tools = new Map()
    registerBusinessTools({ webServer: TRUSTED_WEB_SERVER, tools: { register(definition) { tools.set(definition.name, definition); return () => {} } } }, { preset })
    return tools
  }
  const center = registered('tradeloom-center')
  const product = registered('tradeloom-product')
  const delivery = registered('tradeloom-delivery')
  const names = [
    'tradeloom_erpnext_create_quotation_draft',
    'tradeloom_erpnext_update_quotation_draft',
    'tradeloom_erpnext_read_quotation_draft_operation',
  ]
  for (const name of names) {
    assert.equal(typeof center.get(name)?.execute, 'function')
    assert.equal(product.has(name), false)
    assert.equal(delivery.has(name), false)
  }
  const { requests } = await fixture(t)
  const payload = { company: 'Demo Company', party_name: 'Customer-1', transaction_date: '2026-10-21', currency: 'USD', items: [{ item_code: 'ITEM-1', qty: '1', rate: '5', uom: 'Nos' }] }
  const validArgs = {
    tradeloom_erpnext_create_quotation_draft: { idempotency_key: 'key-1', payload },
    tradeloom_erpnext_update_quotation_draft: { target_operation_id: 'a'.repeat(32), idempotency_key: 'key-2', expected_modified: '2026-10-21 12:00:00', payload },
    tradeloom_erpnext_read_quotation_draft_operation: { operation_id: 'a'.repeat(32) },
  }
  for (const name of names) {
    const definition = center.get(name)
    assert.equal(definition.parameters.type, 'object')
    assert.equal(definition.parameters.additionalProperties, false)
    const denied = await definition.execute(validArgs[name], agent('tradeloom-product'))
    assert.equal(denied.error_code, 'role_not_authorized')
  }
  assert.deepEqual(requests, [])
})

test('Quotation draft tools reject text beyond the documented field limits before making a Django request', async t => {
  const { requests, tools } = await fixture(t)
  const create = tools.get('tradeloom_erpnext_create_quotation_draft')
  const schemaProperties = create.parameters.properties.payload.properties
  const schemaLimits = {
    company: 140, party_name: 140, transaction_date: 10, valid_till: 10, currency: 3,
    item_code: 140, qty: 32, rate: 32, uom: 140,
  }
  for (const [field, maxLength] of Object.entries(schemaLimits)) {
    const property = ['item_code', 'qty', 'rate', 'uom'].includes(field)
      ? schemaProperties.items.items.properties[field] : schemaProperties[field]
    assert.match(property.description, new RegExp(`最多${maxLength}个字符`), `${field} documents its maximum length`)
  }
  const validPayload = {
    company: 'Demo Company', party_name: 'Customer-1', transaction_date: '2026-10-21', currency: 'USD',
    items: [{ item_code: 'ITEM-1', qty: '1', rate: '5', uom: 'Nos' }],
  }
  const cases = [
    ['company', 141], ['party_name', 141], ['transaction_date', 11], ['currency', 4],
    ['item_code', 141], ['qty', 33], ['rate', 33], ['uom', 141],
  ]
  for (const [field, length] of cases) {
    const payload = structuredClone(validPayload)
    if (['item_code', 'qty', 'rate', 'uom'].includes(field)) payload.items[0][field] = 'x'.repeat(length)
    else payload[field] = 'x'.repeat(length)
    const result = await create.execute({ idempotency_key: `too-long-${field}`, payload }, agent())
    assert.equal(requests.length, 0, `${field} over its limit must be rejected before Django`)
    assert.equal(result.error_code, 'invalid_arguments', `${field} over its limit must be rejected`)
  }
  assert.deepEqual(requests, [], 'invalid text must not fetch CSRF or call Django')
})

test('Quotation create and update tools use fixed same-origin CSRF paths, preserve idempotency, and never claim unknown as success', async t => {
  const payload = {
    company: 'Demo Company', party_name: 'Customer-1', transaction_date: '2026-10-21',
    currency: 'USD', items: [{ item_code: 'ITEM-1', qty: '2', rate: '5.25', uom: 'Nos' }],
  }
  const calls = []
  const { requests, tools } = await fixture(t, async (record, response) => {
    calls.push(record)
    if (record.method === 'POST' && record.path === '/api/erpnext/quotation-drafts') {
      response.writeHead(202, { 'content-type': 'application/json' })
      response.end(JSON.stringify({
        ok: true, operation_id: 'a'.repeat(32), action: 'create', doctype: 'Quotation', status: 'outcome_unknown',
        source: 'local_workbench', workflow_id: null, target_operation_id: null, remote_name: null, remote_modified: null,
        payload_sha256: 'b'.repeat(64), error_code: 'unavailable', receipt: null, remote_current: null,
        remote_error_code: 'unavailable', secret: 'must-not-reach-tool',
      }))
      return
    }
    if (record.method === 'GET' && record.path === `/api/erpnext/quotation-drafts/${'a'.repeat(32)}`) {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({
        ok: true, operation_id: 'a'.repeat(32), action: 'create', doctype: 'Quotation', status: 'succeeded',
        source: 'local_workbench', workflow_id: null, target_operation_id: null, remote_name: 'QTN-1',
        remote_modified: '2026-10-21 12:00:00.000000', payload_sha256: 'b'.repeat(64), error_code: '',
        receipt: { doctype: 'Quotation', data: { name: 'QTN-1', modified: '2026-10-21 12:00:00.000000',
          docstatus: 0, quotation_to: 'Customer', company: 'Demo Company', party_name: 'Customer-1',
          transaction_date: '2026-10-21', currency: 'USD', items: [{ item_code: 'ITEM-1', qty: '2', rate: '5.25', uom: 'Nos' }] },
          external_ref: { system: 'erpnext', instance_id: 'local', doctype: 'Quotation', name: 'QTN-1', modified: '2026-10-21 12:00:00.000000' }, truncated_children: [] },
        remote_current: { doctype: 'Quotation', data: { name: 'QTN-1', modified: '2026-10-21 12:00:00.000000',
          docstatus: 0, quotation_to: 'Customer', company: 'Demo Company', party_name: 'Customer-1',
          transaction_date: '2026-10-21', currency: 'USD', items: [{ item_code: 'ITEM-1', qty: '2', rate: '5.25', uom: 'Nos' }] },
          external_ref: { system: 'erpnext', instance_id: 'local', doctype: 'Quotation', name: 'QTN-1', modified: '2026-10-21 12:00:00.000000' }, truncated_children: [] },
        remote_error_code: '', unexpected: 'must-not-reach-tool',
      }))
      return
    }
    if (record.method === 'PUT' && record.path === `/api/erpnext/quotation-drafts/${'a'.repeat(32)}`) {
      response.writeHead(409, { 'content-type': 'application/json' })
      response.end(JSON.stringify({
        ok: false, operation_id: 'c'.repeat(32), action: 'update', doctype: 'Quotation', status: 'conflict',
        source: 'local_workbench', workflow_id: null, target_operation_id: 'a'.repeat(32), remote_name: 'QTN-1',
        remote_modified: '2026-10-21 12:00:00.000000', payload_sha256: 'd'.repeat(64), error_code: 'conflict',
        receipt: null, remote_current: null, remote_error_code: '',
      }))
      return
    }
    await defaultHandler(record, response)
  })
  const create = tools.get('tradeloom_erpnext_create_quotation_draft')
  const update = tools.get('tradeloom_erpnext_update_quotation_draft')
  const read = tools.get('tradeloom_erpnext_read_quotation_draft_operation')
  const idempotencyKey = 'ui-create-operation-1'
  const pending = await create.execute({ idempotency_key: idempotencyKey, payload }, agent())
  assert.equal(pending.ok, false)
  assert.equal(pending.error_code, 'operation_outcome_unknown')
  assert.equal(dataOf(pending).status, 'outcome_unknown')
  assert.equal(dataOf(pending).operation_id, 'a'.repeat(32))
  assert.equal(JSON.stringify(pending).includes('must-not-reach-tool'), false)
  assert.deepEqual(requests.map(item => [item.method, item.path]), [['GET', '/'], ['POST', '/api/erpnext/quotation-drafts']])
  assert.equal(JSON.parse(requests[1].body).idempotency_key, idempotencyKey)
  assert.deepEqual(JSON.parse(requests[1].body).payload, payload)
  assert.equal('role' in JSON.parse(requests[1].body), false)
  assert.equal('actor' in JSON.parse(requests[1].body), false)
  assert.equal(requests[1].headers.cookie, `csrftoken=${CSRF_TOKEN}`)
  assert.equal(requests[1].headers['x-csrftoken'], CSRF_TOKEN)
  assert.equal(requests[1].headers.authorization, undefined)

  const succeeded = await read.execute({ operation_id: 'a'.repeat(32) }, agent())
  assert.equal(succeeded.ok, true)
  assert.equal(dataOf(succeeded).status, 'succeeded')
  assert.equal(dataOf(succeeded).remote_current.data.docstatus, 0)
  assert.equal(JSON.stringify(succeeded).includes('must-not-reach-tool'), false)

  const conflicted = await update.execute({
    target_operation_id: 'a'.repeat(32), idempotency_key: 'ui-update-operation-1',
    expected_modified: '2026-10-21 12:00:00.000000', payload,
  }, agent())
  assert.equal(conflicted.ok, false)
  assert.equal(conflicted.error_code, 'operation_conflict')
  assert.equal(dataOf(conflicted).status, 'conflict')
  assert.deepEqual(requests.map(item => [item.method, item.path]), [
    ['GET', '/'], ['POST', '/api/erpnext/quotation-drafts'],
    ['GET', `/api/erpnext/quotation-drafts/${'a'.repeat(32)}`],
    ['GET', '/'], ['PUT', `/api/erpnext/quotation-drafts/${'a'.repeat(32)}`],
  ])
  const put = requests.at(-1)
  assert.deepEqual(JSON.parse(put.body), {
    idempotency_key: 'ui-update-operation-1', expected_modified: '2026-10-21 12:00:00.000000', payload,
  })
  assert.equal(put.headers.cookie, `csrftoken=${CSRF_TOKEN}`)
  assert.equal(put.headers['x-csrftoken'], CSRF_TOKEN)
})

test('ERPNext tools use closed arguments, fixed Django paths, and project bounded DTOs', async t => {
  const { requests, tools } = await fixture(t)
  const listTool = tools.get('tradeloom_erpnext_list')
  assert.deepEqual(listTool.parameters.required, ['doctype'])
  assert.deepEqual(listTool.parameters.properties.doctype.enum, [
    'Item', 'Customer', 'Supplier', 'Warehouse', 'Bin', 'Sales Order', 'Purchase Order', 'Stock Entry',
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

  for (const name of [
    'tradeloom_erpnext_status', 'tradeloom_erpnext_list', 'tradeloom_erpnext_detail',
    'tradeloom_erpnext_create_quotation_draft', 'tradeloom_erpnext_update_quotation_draft',
    'tradeloom_erpnext_read_quotation_draft_operation',
  ]) {
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

test('intake tools use fixed paged GET paths and project bounded source metadata only', async t => {
  const sourceId = 'a'.repeat(32)
  const snapshotId = 'b'.repeat(32)
  const sha256 = 'c'.repeat(64)
  const { requests, tools } = await fixture(t, async (record, response) => {
    if (record.path === '/api/intake/sources?offset=2&limit=1') {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ ok: true, sources: [{
        id: sourceId, sha256, byte_size: 4096, display_name: 'private-customer-contract.xlsx',
        original_name: 'C:\\private\\customer.xlsx', storage_key: 'secret-storage-key', received_at: '2026-10-22T08:00:00Z',
        snapshots: [{ id: snapshotId, parser_version: 'xlsx-ooxml-v2', status: 'ready', sheet_count: 2, cell_count: 12, error_code: '' }],
      }], next_offset: 3 }))
      return
    }
    await defaultHandler(record, response)
  })
  const tool = tools.get('tradeloom_intake_sources')
  assert.equal(tool.parameters.type, 'object')
  assert.equal(tool.parameters.additionalProperties, false)
  assert.deepEqual(Object.keys(tool.parameters.properties).sort(), ['limit', 'offset'])
  const result = await tool.execute({ offset: 2, limit: 1 }, agent())
  assert.equal(result.ok, true)
  assert.deepEqual(requests.map(request => request.path), ['/api/intake/sources?offset=2&limit=1'])
  assert.deepEqual(dataOf(result), {
    sources: [{
      id: sourceId, sha256, byte_size: 4096, received_at: '2026-10-22T08:00:00Z',
      snapshots: [{ id: snapshotId, parser_version: 'xlsx-ooxml-v2', status: 'ready', sheet_count: 2, cell_count: 12, error_code: '' }],
      snapshots_truncated: false,
    }],
    next_offset: 3,
    truncated: true,
  })
  const serialized = JSON.stringify(result)
  assert.equal(serialized.includes('private-customer-contract.xlsx'), false)
  assert.equal(serialized.includes('C:\\private'), false)
  assert.equal(serialized.includes('secret-storage-key'), false)
})

test('intake candidate tool returns only finite candidate fields and source coordinates', async t => {
  const candidateId = 'd'.repeat(32)
  const sourceId = 'a'.repeat(32)
  const snapshotId = 'b'.repeat(32)
  const sha256 = 'c'.repeat(64)
  const longValue = 'x'.repeat(300)
  const longReason = '<img src=x> operator note' + 'r'.repeat(600)
  const { requests, tools } = await fixture(t, async (record, response) => {
    if (record.path === `/api/intake/candidates/${candidateId}`) {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ ok: true, candidate: {
        id: candidateId, mapping_id: 'e'.repeat(32), source_sha256: sha256,
        candidate_type: 'product_identity', schema_version: 1, status: 'unconfirmed',
        fields: {
          style_number: [{ state: 'present', type: 'text', value: longValue }],
          width: [{ state: 'empty', type: 'decimal', value: null }],
          secret_field: [{ state: 'present', type: 'text', value: 'must-not-reach-model' }],
        },
        semantics: { product_identity: 'candidate_only', private_semantic: 'must-not-reach-model' },
        provenance: { style_number: [{ source_id: sourceId, source_sha256: sha256, snapshot_id: snapshotId,
          sheet_index: 1, sheet_title: 'private customer name', coordinate: 'A1', formula_status: 'literal', error_code: '' }] },
      }, links: [{ id: 'a'.repeat(32), left_candidate_id: candidateId, right_candidate_id: 'f'.repeat(32), decision: 'suggested',
        actor: 'local_workbench', created_at: '2026-10-22T03:00:00Z',
        evidence: { reason: longReason, secret: 'must-not-reach-model' } }] }))
      return
    }
    await defaultHandler(record, response)
  })
  const tool = tools.get('tradeloom_intake_candidate')
  assert.equal(tool.parameters.type, 'object')
  assert.equal(tool.parameters.additionalProperties, false)
  assert.deepEqual(tool.parameters.required, ['candidate_id', 'candidate_type'])
  assert.deepEqual(tool.parameters.properties.candidate_type.enum, [
    'product_identity', 'commercial_source', 'production_instruction', 'labor_analysis',
  ])
  const result = await tool.execute({ candidate_id: candidateId, candidate_type: 'product_identity' }, agent())
  assert.equal(result.ok, true)
  assert.deepEqual(requests.map(request => request.path), [`/api/intake/candidates/${candidateId}`])
  const data = dataOf(result)
  assert.equal(data.candidate_id, candidateId)
  assert.equal(data.source_sha256, sha256)
  assert.equal(data.fields.style_number.values[0].value.length, 160)
  assert.equal(data.fields.style_number.values[0].value_truncated, true)
  assert.equal(data.fields.width.values[0].state, 'empty')
  assert.equal(data.fields.width.values[0].value, null)
  assert.equal(data.fields.style_number.sources[0].coordinate, 'A1')
  assert.equal('sheet_title' in data.fields.style_number.sources[0], false)
  assert.deepEqual(data.links, [{ candidate_id: 'f'.repeat(32), decision: 'suggested',
    judgment_source: 'association_decision', reason: longReason.slice(0, 500), link_id: 'a'.repeat(32),
    actor: 'local_workbench', created_at: '2026-10-22T03:00:00Z' }])
  assert.equal(data.truncated, true)
  const serialized = JSON.stringify(result)
  assert.equal(serialized.includes('must-not-reach-model'), false)
  assert.equal(serialized.includes('private customer name'), false)
  assert.equal(serialized.includes('mapping_id'), false)
})

test('delivery can read source metadata and production instructions with safe source coordinates', async t => {
  const candidateId = 'd'.repeat(32)
  const sourceId = 'a'.repeat(32)
  const snapshotId = 'b'.repeat(32)
  const sha256 = 'c'.repeat(64)
  const { requests, tools } = await fixture(t, async (record, response) => {
    if (record.path === '/api/intake/sources?offset=0&limit=2') {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ ok: true, sources: [{
        id: sourceId, sha256, byte_size: 1024, received_at: '2026-10-22T08:00:00Z',
        snapshots: [{ id: snapshotId, parser_version: 'xlsx-v1', status: 'ready', sheet_count: 1, cell_count: 4 }],
      }], next_offset: null }))
      return
    }
    if (record.path === `/api/intake/candidates/${candidateId}`) {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ ok: true, candidate: {
        id: candidateId, mapping_id: 'e'.repeat(32), source_sha256: sha256,
        candidate_type: 'production_instruction', schema_version: 1, status: 'unconfirmed',
        fields: { description: [{ state: 'present', type: 'text', value: 'Synthetic instruction' }] },
        provenance: { description: [{ source_id: sourceId, source_sha256: sha256, snapshot_id: snapshotId,
          sheet_index: 1, coordinate: 'D4', formula_status: 'not_formula', error_code: '' }] },
      }, links: [] }))
      return
    }
    await defaultHandler(record, response)
  }, { preset: 'tradeloom-delivery' })

  const sources = tools.get('tradeloom_intake_sources')
  const candidate = tools.get('tradeloom_intake_candidate')
  assert.ok(sources)
  assert.ok(candidate)
  assert.match(sources.description, /read-only/i)
  assert.match(candidate.description, /delivery.*production_instruction/i)
  assert.equal((await sources.execute({ offset: 0, limit: 2 }, agent('tradeloom-delivery'))).ok, true)
  const result = await candidate.execute({ candidate_id: candidateId, candidate_type: 'production_instruction' }, agent('tradeloom-delivery'))
  assert.equal(result.ok, true)
  assert.equal(dataOf(result).candidate_type, 'production_instruction')
  assert.equal(dataOf(result).fields.description.sources[0].coordinate, 'D4')
  assert.deepEqual(requests.map(request => request.path), [
    '/api/intake/sources?offset=0&limit=2', `/api/intake/candidates/${candidateId}`,
  ])

  for (const candidateType of ['product_identity', 'commercial_source', 'labor_analysis']) {
    const denied = await candidate.execute({ candidate_id: candidateId, candidate_type: candidateType }, agent('tradeloom-delivery'))
    assert.equal(denied.error_code, 'role_not_authorized', `${candidateType} must be refused before HTTP`)
  }
  assert.equal(requests.length, 2)
})

test('delivery refuses a candidate response whose returned type falls outside its production-only boundary', async t => {
  const candidateId = 'd'.repeat(32)
  const sourceId = 'a'.repeat(32)
  const sha256 = 'c'.repeat(64)
  const marker = 'must-not-leak-from-spoofed-candidate-type'
  const { requests, tools } = await fixture(t, async (_record, response) => {
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ ok: true, candidate: {
      id: candidateId, mapping_id: 'e'.repeat(32), source_sha256: sha256,
      candidate_type: 'labor_analysis', schema_version: 1, status: 'unconfirmed',
      fields: { process: [{ state: 'present', type: 'text', value: marker }] },
      provenance: { process: [{ source_id: sourceId, source_sha256: sha256, snapshot_id: 'b'.repeat(32),
        sheet_index: 1, coordinate: 'B2', formula_status: 'not_formula', error_code: '' }] },
    }, links: [] }))
  }, { preset: 'tradeloom-delivery' })
  const result = await tools.get('tradeloom_intake_candidate').execute({
    candidate_id: candidateId, candidate_type: 'production_instruction',
  }, agent('tradeloom-delivery'))
  assert.equal(result.error_code, 'role_not_authorized')
  assert.equal(JSON.stringify(result).includes(marker), false)
  assert.deepEqual(requests.map(request => request.path), [`/api/intake/candidates/${candidateId}`])
})

test('intake candidate projection honors the server history preview marker at its bounded window', async t => {
  const candidateId = 'd'.repeat(32)
  const sourceId = 'a'.repeat(32)
  const sha256 = 'c'.repeat(64)
  const links = Array.from({ length: 20 }, (_, index) => ({
    id: index.toString(16).padStart(32, '0'),
    left_candidate_id: candidateId, right_candidate_id: index.toString(16).padStart(32, '0'),
    decision: index === 0 ? 'confirmed' : 'suggested', actor: 'local_workbench',
    created_at: `2026-10-22T03:${String(index).padStart(2, '0')}:00Z`,
    evidence: { reason: index === 0 ? 'latest association decision' : `older ${index}`, private_blob: 'must-not-reach-model' },
  }))
  const { tools } = await fixture(t, async (record, response) => {
    if (record.path === `/api/intake/candidates/${candidateId}`) {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ ok: true, candidate: {
        id: candidateId, mapping_id: 'e'.repeat(32), source_sha256: sha256,
        candidate_type: 'product_identity', schema_version: 1, status: 'unconfirmed',
        fields: { description: [{ state: 'present', type: 'text', value: 'Synthetic' }] },
        semantics: { product_identity: 'candidate_only' },
        provenance: { description: [{ source_id: sourceId, source_sha256: sha256, snapshot_id: 'b'.repeat(32),
          sheet_index: 1, coordinate: 'A1', formula_status: 'not_formula', error_code: '' }] },
      }, links, links_next_offset: 20 }))
      return
    }
    await defaultHandler(record, response)
  })
  const result = await tools.get('tradeloom_intake_candidate').execute({
    candidate_id: candidateId, candidate_type: 'product_identity',
  }, agent())
  const data = dataOf(result)
  assert.equal(data.links.length, 20)
  assert.equal(data.links[0].decision, 'confirmed')
  assert.equal(data.links[0].reason, 'latest association decision')
  assert.equal(data.links[0].link_id, '0'.repeat(32))
  assert.equal(data.links[19].reason, 'older 19')
  assert.equal(JSON.stringify(data).includes('private_blob'), false)
  assert.equal(data.truncated, true)
})

test('intake candidate projection flags a clipped association reason independently', async t => {
  const candidateId = 'd'.repeat(32)
  const sourceId = 'a'.repeat(32)
  const sha256 = 'c'.repeat(64)
  const longReason = 'r'.repeat(501)
  const { tools } = await fixture(t, async (_record, response) => {
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ ok: true, candidate: {
      id: candidateId, mapping_id: 'e'.repeat(32), source_sha256: sha256,
      candidate_type: 'product_identity', schema_version: 1, status: 'unconfirmed',
      fields: { description: [{ state: 'present', type: 'text', value: 'Synthetic' }] },
      semantics: { product_identity: 'candidate_only' },
      provenance: { description: [{ source_id: sourceId, source_sha256: sha256, snapshot_id: 'b'.repeat(32),
        sheet_index: 1, coordinate: 'A1', formula_status: 'not_formula', error_code: '' }] },
    }, links: [{ id: 'f'.repeat(32), left_candidate_id: candidateId, right_candidate_id: '1'.repeat(32),
      decision: 'suggested', evidence: { reason: longReason } }] }))
  })
  const result = await tools.get('tradeloom_intake_candidate').execute({
    candidate_id: candidateId, candidate_type: 'product_identity',
  }, agent())
  const data = dataOf(result)
  assert.equal(data.links[0].reason, longReason.slice(0, 500))
  assert.equal(data.truncated, true)
})

test('intake candidate projection flags clipped actor and timestamp metadata', async t => {
  const candidateId = 'd'.repeat(32)
  const sourceId = 'a'.repeat(32)
  const sha256 = 'c'.repeat(64)
  for (const [field, value] of [['actor', 'a'.repeat(33)], ['created_at', 't'.repeat(65)]]) {
    const { tools } = await fixture(t, async (_record, response) => {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ ok: true, candidate: {
        id: candidateId, mapping_id: 'e'.repeat(32), source_sha256: sha256,
        candidate_type: 'product_identity', schema_version: 1, status: 'unconfirmed',
        fields: { description: [{ state: 'present', type: 'text', value: 'Synthetic' }] },
        provenance: { description: [{ source_id: sourceId, source_sha256: sha256, snapshot_id: 'b'.repeat(32),
          sheet_index: 1, coordinate: 'A1', formula_status: 'not_formula', error_code: '' }] },
      }, links: [{ id: 'f'.repeat(32), left_candidate_id: candidateId, right_candidate_id: '1'.repeat(32),
        decision: 'suggested', actor: field === 'actor' ? value : 'short',
        created_at: field === 'created_at' ? value : '2026-10-22T03:00:00Z', evidence: { reason: 'short' } }] }))
    })
    const result = await tools.get('tradeloom_intake_candidate').execute({
      candidate_id: candidateId, candidate_type: 'product_identity',
    }, agent())
    const data = dataOf(result)
    assert.equal(data.links[0][field], value.slice(0, field === 'actor' ? 32 : 64))
    assert.equal(data.truncated, true, `${field} clipping must set the truncation flag`)
  }
})

test('intake tools reject malformed IDs, unbounded pages, extra keys, and non-product candidates for product role before HTTP', async t => {
  const { requests, tools } = await fixture(t, undefined, { preset: 'tradeloom-product' })
  const sources = tools.get('tradeloom_intake_sources')
  const candidate = tools.get('tradeloom_intake_candidate')
  assert.equal(sources.parameters.type, 'object')
  assert.equal(sources.parameters.additionalProperties, false)
  assert.equal((await sources.execute({ offset: -1 }, agent('tradeloom-product'))).error_code, 'invalid_arguments')
  assert.equal((await sources.execute({ limit: 101 }, agent('tradeloom-product'))).error_code, 'invalid_arguments')
  assert.equal((await sources.execute({ url: 'http://attacker.invalid' }, agent('tradeloom-product'))).error_code, 'invalid_arguments')
  assert.equal((await candidate.execute({ candidate_id: 'not-an-id', candidate_type: 'product_identity' }, agent('tradeloom-product'))).error_code, 'invalid_arguments')
  assert.equal((await candidate.execute({ candidate_id: 'a'.repeat(32), candidate_type: 'labor_analysis' }, agent('tradeloom-product'))).error_code, 'role_not_authorized')
  assert.equal((await candidate.execute({ candidate_id: 'a'.repeat(32), candidate_type: 'production_instruction' }, agent('tradeloom-product'))).error_code, 'role_not_authorized')
  assert.deepEqual(requests, [])
})

test('intake candidate preserves the missing-session error for valid arguments without an Agent session header', async t => {
  const { requests, tools } = await fixture(t)
  const candidate = tools.get('tradeloom_intake_candidate')
  const args = { candidate_id: 'a'.repeat(32), candidate_type: 'product_identity' }

  assert.equal((await candidate.execute(args)).error_code, 'agent_session_required')
  assert.equal((await candidate.execute(args, { agent: { session: {} } })).error_code, 'agent_session_required')
  assert.deepEqual(requests, [])
})

test('intake candidate directory is a closed, role-bounded read-only source for candidate IDs', async t => {
  const sourceId = 'a'.repeat(32)
  const sha256 = 'c'.repeat(64)
  const rows = ['product_identity', 'production_instruction', 'labor_analysis'].map((candidate_type, index) => ({
    id: `${index + 1}`.repeat(32), source_sha256: sha256, candidate_type, schema_version: 1, status: 'unconfirmed',
    mapping_id: 'e'.repeat(32), fields: { [candidate_type === 'product_identity' ? 'style_number' : candidate_type === 'labor_analysis' ? 'process' : 'description']: [{ state: 'present', type: 'text', value: 'PRIVATE-BODY' }] },
    provenance: { [candidate_type === 'product_identity' ? 'style_number' : candidate_type === 'labor_analysis' ? 'process' : 'description']: [{ source_id: sourceId, source_sha256: sha256, snapshot_id: 'b'.repeat(32),
      sheet_index: 1, coordinate: `A${index + 1}`, formula_status: 'not_formula', error_code: '' }] },
  }))
  const { requests, tools } = await fixture(t, async (record, response) => {
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ ok: true, candidates: rows, next_offset: 3 }))
  })
  const tool = tools.get('tradeloom_intake_candidates')
  assert.ok(tool, 'directory tool is registered')
  assert.equal(tool.parameters.type, 'object')
  assert.equal(tool.parameters.additionalProperties, false)
  assert.deepEqual(tool.parameters.required, [])

  const center = await tool.execute({ source_id: sourceId, offset: 2, limit: 3 }, agent('tradeloom-center'))
  assert.equal(center.ok, true)
  assert.deepEqual(dataOf(center).candidates.map(item => item.candidate_type), ['product_identity', 'production_instruction', 'labor_analysis'])
  assert.deepEqual(dataOf(center).candidates[0], {
    candidate_id: '1'.repeat(32), candidate_type: 'product_identity', source_sha256: sha256,
    source_ids: [sourceId], status: 'unconfirmed',
  })
  assert.equal(dataOf(center).next_offset, 3)
  assert.equal(dataOf(center).truncated, false)
  assert.equal(JSON.stringify(center).includes('PRIVATE-BODY'), false)
  assert.equal(JSON.stringify(center).includes('mapping_id'), false)
  assert.equal(requests[0].path, `/api/intake/candidates?source_id=${sourceId}&offset=2&limit=3`)

  const product = await tool.execute({ source_id: sourceId }, agent('tradeloom-product'))
  assert.equal(product.ok, true)
  assert.deepEqual(dataOf(product).candidates.map(item => item.candidate_type), ['product_identity'])
  assert.match(requests[1].path, /candidate_type=product_identity/)

  const delivery = await tool.execute({ source_id: sourceId }, agent('tradeloom-delivery'))
  assert.equal(delivery.ok, true)
  assert.deepEqual(dataOf(delivery).candidates.map(item => item.candidate_type), ['production_instruction'])
  assert.match(requests[2].path, /candidate_type=production_instruction/)
})

test('intake candidate directory refuses explicit role-incompatible filters and malformed arguments before HTTP', async t => {
  const { requests, tools } = await fixture(t)
  const tool = tools.get('tradeloom_intake_candidates')
  assert.ok(tool)
  for (const [args, preset] of [
    [{ candidate_type: 'bad_type' }, 'tradeloom-center'],
    [{ source_id: 'bad-id' }, 'tradeloom-center'],
    [{ source_id: ['a'.repeat(32)] }, 'tradeloom-center'],
    [{ offset: -1 }, 'tradeloom-center'],
    [{ limit: 51 }, 'tradeloom-center'],
    [{ url: 'http://attacker.invalid' }, 'tradeloom-center'],
  ]) assert.equal((await tool.execute(args, agent(preset))).error_code, 'invalid_arguments')
  assert.equal((await tool.execute({ candidate_type: 'commercial_source' }, agent('tradeloom-product'))).error_code, 'role_not_authorized')
  assert.equal((await tool.execute({ candidate_type: 'product_identity' }, agent('tradeloom-delivery'))).error_code, 'role_not_authorized')
  assert.deepEqual(requests, [])
  assert.equal((await tool.execute({})).error_code, 'agent_session_required')
  assert.deepEqual(requests, [])
})

test('intake candidate directory drops rows with a spoofed type and bounds unknown or invalid DTOs', async t => {
  const sourceId = 'a'.repeat(32)
  const sha256 = 'c'.repeat(64)
  const { requests, tools } = await fixture(t, async (_record, response) => {
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ ok: true, next_offset: null, candidates: [
      { id: '1'.repeat(32), candidate_type: 'production_instruction', source_sha256: sha256, schema_version: 1,
        status: 'unconfirmed', fields: { description: [{ state: 'present', value: 'DO-NOT-LEAK' }] },
        provenance: { description: [{ source_id: sourceId, source_sha256: sha256, snapshot_id: 'b'.repeat(32), sheet_index: 1, coordinate: 'A1' }] } },
      { id: '2'.repeat(32), candidate_type: 'product_identity', source_sha256: sha256, schema_version: 1,
        status: 'confirmed', fields: { description: [{ state: 'present', value: 'OK' }] },
        provenance: { description: [{ source_id: sourceId, source_sha256: sha256, snapshot_id: 'b'.repeat(32), sheet_index: 1, coordinate: 'A2' }] } },
      { id: 'malformed', candidate_type: 'product_identity', source_sha256: 'bad', schema_version: 1,
        status: 'unconfirmed', fields: {}, provenance: {} },
    ] }))
  }, { preset: 'tradeloom-product' })
  const tool = tools.get('tradeloom_intake_candidates')
  const result = await tool.execute({}, agent('tradeloom-product'))
  assert.equal(result.ok, true)
  assert.deepEqual(dataOf(result).candidates, [{ candidate_id: '2'.repeat(32), candidate_type: 'product_identity',
    source_sha256: sha256, source_ids: [sourceId], status: 'unknown' }])
  assert.equal(dataOf(result).truncated, true)
  assert.equal(JSON.stringify(result).includes('DO-NOT-LEAK'), false)
  assert.deepEqual(requests.map(request => request.path), ['/api/intake/candidates?candidate_type=product_identity&offset=0&limit=50'])
})

test('narrative source readers are center-only with closed bounded object schemas', async t => {
  const { requests, tools } = await fixture(t)
  const sources = tools.get('tradeloom_narrative_sources')
  const excerpt = tools.get('tradeloom_narrative_excerpt')
  assert.ok(sources, 'center has narrative source metadata reader')
  assert.ok(excerpt, 'center has bounded narrative excerpt reader')
  for (const tool of [sources, excerpt]) {
    assert.equal(tool.parameters.type, 'object')
    assert.equal(tool.parameters.additionalProperties, false)
  }
  assert.deepEqual(Object.keys(sources.parameters.properties).sort(), ['limit', 'offset'])
  assert.deepEqual(Object.keys(excerpt.parameters.properties).sort(), ['limit', 'offset', 'source_id'])
  assert.equal(excerpt.parameters.required.includes('source_id'), true)
  assert.match(sources.description, /尚未核实|不可作为正式规则/)
  assert.match(excerpt.description, /摘录|不.*规则/)
  assert.equal((await sources.execute({}, agent('tradeloom-product'))).error_code, 'role_not_authorized')
  assert.equal((await excerpt.execute({ source_id: 'a'.repeat(32) }, agent('tradeloom-delivery'))).error_code, 'role_not_authorized')
  assert.equal((await sources.execute({}, {})).error_code, 'agent_session_required')
  assert.equal(requests.length, 0, 'roles and missing sessions are rejected before HTTP')
  const product = await fixture(t, undefined, { preset: 'tradeloom-product' })
  assert.equal(product.tools.has('tradeloom_narrative_sources'), false)
  assert.equal(product.tools.has('tradeloom_narrative_excerpt'), false)
})

test('narrative readers use bounded GETs and project only approved metadata and excerpt lines', async t => {
  const sourceId = 'a'.repeat(32)
  const sha256 = 'b'.repeat(64)
  const { requests, tools } = await fixture(t, async (record, response) => {
    if (record.path === '/api/intake/narratives?offset=0&limit=20') {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ ok: true, narratives: [
        { id: sourceId, sha256, line_count: 12, display_name: 'private-name.txt', storage_key: 'secret-key', path: 'C:\\private',
          current_annotation: { revision: 3, source_kind: 'transcript_excerpt', recording_date: null,
            audio_review_status: 'operator_claimed_checked', content_status: 'unconfirmed', actor: 'private-actor', created_at: 'private-time', text: 'drop' } },
        { id: 'c'.repeat(32), sha256: 'd'.repeat(64), line_count: 0, current_annotation: null },
      ], next_offset: 20, backend_extra: 'drop' }))
      return
    }
    if (record.path === `/api/intake/narratives/${sourceId}/lines?offset=2&limit=5`) {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ ok: true, source: { id: sourceId, sha256, line_count: 12, storage_key: 'secret-key', current_annotation: null },
        lines: [{ line_number: 3, text: 'synthetic line', truncated: false }, { line_number: 4, text: 'x'.repeat(2000), truncated: true, extra: 'drop' }],
        next_offset: 7, raw: 'drop' }))
      return
    }
    await defaultHandler(record, response)
  })
  const sourceTool = tools.get('tradeloom_narrative_sources')
  const excerptTool = tools.get('tradeloom_narrative_excerpt')
  assert.ok(sourceTool, 'center reader is registered')
  const sources = await sourceTool.execute({}, agent())
  assert.equal(sources.ok, true)
  assert.deepEqual(requests.map(row => row.path), ['/api/intake/narratives?offset=0&limit=20'])
  assert.deepEqual(dataOf(sources), { narratives: [
    { id: sourceId, sha256, line_count: 12, current_annotation: {
      revision: 3, source_kind: 'transcript_excerpt', recording_date: null,
      audio_review_status: 'operator_claimed_checked', content_status: 'unconfirmed',
    } },
    { id: 'c'.repeat(32), sha256: 'd'.repeat(64), line_count: 0, current_annotation: null },
  ], next_offset: 20, truncated: true })
  const serialized = JSON.stringify(sources)
  for (const privateValue of ['private-name.txt', 'secret-key', 'C:\\private', 'private-actor', 'private-time', 'backend_extra', 'drop']) {
    assert.equal(serialized.includes(privateValue), false, `projection excludes ${privateValue}`)
  }
  const excerpt = await excerptTool.execute({ source_id: sourceId, offset: 2 }, agent())
  assert.equal(excerpt.ok, true)
  assert.equal(requests[1].path, `/api/intake/narratives/${sourceId}/lines?offset=2&limit=5`)
  assert.deepEqual(dataOf(excerpt), { source: { id: sourceId, sha256, current_annotation: null }, lines: [
    { line_number: 3, text: 'synthetic line', truncated: false }, { line_number: 4, text: 'x'.repeat(2000), truncated: true },
  ], next_offset: 7 })
})

test('narrative tools reject malformed IDs, extra arguments, and oversized pages before HTTP', async t => {
  const { requests, tools } = await fixture(t)
  const sources = tools.get('tradeloom_narrative_sources')
  const excerpt = tools.get('tradeloom_narrative_excerpt')
  assert.ok(sources, 'narrative tools are registered')
  const invalidCalls = [
    sources.execute({ offset: -1 }, agent()), sources.execute({ limit: 51 }, agent()),
    sources.execute({ unknown: true }, agent()), excerpt.execute({ source_id: 'bad-id' }, agent()),
    excerpt.execute({ source_id: 'a'.repeat(32), offset: -1 }, agent()),
    excerpt.execute({ source_id: 'a'.repeat(32), limit: 11 }, agent()),
    excerpt.execute({ source_id: 'a'.repeat(32), url: 'http://attacker.invalid' }, agent()),
    excerpt.execute({ source_id: ['a'.repeat(32)] }, agent()),
  ]
  for (const result of await Promise.all(invalidCalls)) assert.equal(result.error_code, 'invalid_arguments')
  assert.equal(requests.length, 0)
})

test('narrative excerpt rejects a mismatched source and backend pages or lines beyond contract bounds', async t => {
  const sourceId = 'a'.repeat(32)
  let body = { ok: true, source: { id: 'b'.repeat(32), sha256: 'c'.repeat(64), current_annotation: null },
    lines: [{ line_number: 1, text: 'synthetic', truncated: false }], next_offset: null }
  const { tools } = await fixture(t, async (_record, response) => {
    response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify(body))
  })
  const excerpt = tools.get('tradeloom_narrative_excerpt')
  assert.equal((await excerpt.execute({ source_id: sourceId }, agent())).error_code, 'invalid_narrative_dto')
  body = { ok: true, source: { id: sourceId, sha256: 'c'.repeat(64), current_annotation: null },
    lines: Array.from({ length: 6 }, (_, i) => ({ line_number: i + 1, text: 'synthetic', truncated: false })), next_offset: 6 }
  assert.equal((await excerpt.execute({ source_id: sourceId, limit: 5 }, agent())).error_code, 'invalid_narrative_dto')
  body.lines = [{ line_number: 1, text: 'x'.repeat(2001), truncated: true }]
  assert.equal((await excerpt.execute({ source_id: sourceId }, agent())).error_code, 'invalid_narrative_dto')
})
