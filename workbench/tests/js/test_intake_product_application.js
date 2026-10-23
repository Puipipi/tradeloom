import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import test from 'node:test'

const require = createRequire(import.meta.url)
const jsdomPath = process.env.TRADELOOM_DOM_MODULE
if (!jsdomPath) throw new Error('TRADELOOM_DOM_MODULE must point to the existing external jsdom runtime')
const { JSDOM } = require(jsdomPath)
const source = await readFile(new URL('../../static/workbench/intake-product-application.js', import.meta.url), 'utf8')

function fixture(request, { applications = [], applicationsNextOffset = null } = {}) {
  const dom = new JSDOM('<!doctype html><html><body><section id="detail"></section></body></html>', {
    url: 'http://127.0.0.1:3088/business/artifacts', runScripts: 'outside-only',
  })
  dom.window.eval(source)
  const root = { dataset: {
    tasksUrl: '/api/tasks', productsUrl: '/api/product-library',
    candidateUrl: '/api/intake/candidates/__CANDIDATE__',
    candidateApplyUrl: '/api/intake/candidates/__CANDIDATE__/apply',
  } }
  const candidate = {
    id: 'a'.repeat(32), candidate_type: 'product_identity', mapping_id: 'b'.repeat(32),
    mapping_revision: 1, source_sha256: 'c'.repeat(64),
    fields: {
      style_number: [{ state: 'present', value: 'STYLE-1' }],
      description: [{ state: 'present', value: 'Synthetic sample' }],
      width: [{ state: 'present', value: '30' }], width_unit: [{ state: 'present', value: 'cm' }],
      roll_length: [{ state: 'present', value: '50' }], roll_length_unit: [{ state: 'present', value: 'm' }],
      color: [{ state: 'present', value: 'navy' }],
    },
  }
  const container = dom.window.document.querySelector('#detail')
  const ui = dom.window.TradeLoomIntakeProductApplication.attach({
    container, candidate, applications, applicationsNextOffset,
    root, request, keyFactory: (() => { let next = 0; return () => `apply-key-${++next}` })(),
  })
  return { dom, ui }
}

function submit(dom, form) {
  form.dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }))
}

async function settle() {
  await new Promise(resolve => setImmediate(resolve))
}

test('product application requires explicit target and click; failed same-body retry keeps its key', async () => {
  const posts = []
  let shouldFail = true
  const { dom, ui } = fixture(async (url, options = {}) => {
    if (url === '/api/tasks') return [{ id: 'd'.repeat(32), title: 'Synthetic task', status: 'draft' }]
    if (url.includes('/apply')) {
      posts.push({ url, options: { ...options }, body: JSON.parse(options.body) })
      if (shouldFail) { shouldFail = false; throw new Error('temporary network failure') }
      return { application: { version: 1, missing_fields: ['图片'] } }
    }
    throw new Error(`unexpected request ${url}`)
  })
  await settle()
  assert.equal(ui.taskSelect.value, '')
  assert.equal(ui.targetSelect.value, '')
  assert.equal(posts.length, 0)

  ui.taskSelect.value = 'd'.repeat(32)
  ui.taskSelect.dispatchEvent(new dom.window.Event('change', { bubbles: true }))
  ui.targetSelect.value = 'new'
  ui.targetSelect.dispatchEvent(new dom.window.Event('change', { bubbles: true }))
  ui.controls.get('sku').input.value = 'STYLE-1'
  ui.controls.get('sku').sourceSelect.querySelector('option[value="style_number"]').selected = true
  ui.controls.get('name').input.value = 'Synthetic sample'
  ui.controls.get('name').sourceSelect.querySelector('option[value="description"]').selected = true
  ui.controls.get('sku').input.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
  assert.equal(posts.length, 0, 'changing fields must never submit automatically')

  submit(dom, ui.form)
  await settle()
  assert.equal(posts.length, 1)
  assert.equal(posts[0].options.method, 'POST')
  assert.equal(posts[0].options.headers['Idempotency-Key'], 'apply-key-1')
  assert.equal(posts[0].body.target.task_id, 'd'.repeat(32))
  assert.equal(posts[0].body.target.product_id, null)
  assert.deepEqual(posts[0].body.fields.sku.source_fields, ['style_number'])
  assert.match(ui.status.textContent, /相同内容重试会复用幂等键/)

  submit(dom, ui.form)
  await settle()
  assert.equal(posts.length, 2)
  assert.equal(posts[1].options.headers['Idempotency-Key'], 'apply-key-1')
  assert.match(ui.status.textContent, /已保存待确认版本 v1；待补字段：图片/)
  dom.window.close()
})

test('editing a retry payload rotates the idempotency key and keeps candidate references distinct from manual entry', async () => {
  const posts = []
  const { dom, ui } = fixture(async (url, options = {}) => {
    if (url === '/api/tasks') return [{ id: 'd'.repeat(32), title: 'Synthetic task', status: 'draft' }]
    if (url.includes('/apply')) {
      posts.push({ key: options.headers['Idempotency-Key'], body: JSON.parse(options.body) })
      return { application: { version: 1, missing_fields: [] } }
    }
    throw new Error(`unexpected request ${url}`)
  })
  await settle()
  ui.taskSelect.value = 'd'.repeat(32)
  ui.taskSelect.dispatchEvent(new dom.window.Event('change', { bubbles: true }))
  ui.targetSelect.value = 'new'
  ui.targetSelect.dispatchEvent(new dom.window.Event('change', { bubbles: true }))
  for (const [field, value] of [['sku', 'STYLE-1'], ['name', 'Synthetic sample']]) {
    ui.controls.get(field).input.value = value
    ui.controls.get(field).sourceSelect.selectedOptions[0]?.setAttribute('selected', '')
  }
  ui.controls.get('sku').sourceSelect.querySelector('option[value="style_number"]').selected = true
  ui.controls.get('name').note.value = '人工核对后填写'
  submit(dom, ui.form)
  await settle()
  assert.equal(posts.length, 1)
  assert.equal(posts[0].body.fields.name.source_fields.length, 0)
  assert.equal(posts[0].body.fields.name.note, '人工核对后填写')
  assert.match(ui.status.textContent, /已保存待确认版本/)
  ui.controls.get('name').input.value = 'Updated sample'
  ui.controls.get('name').note.value = '改动后的人工核对'
  submit(dom, ui.form)
  await settle()
  assert.equal(posts.length, 2)
  assert.notEqual(posts[0].key, posts[1].key)
  dom.window.close()
})

test('existing product applies only changed fields against its latest immutable revision', async () => {
  const posts = []
  const taskId = 'd'.repeat(32)
  const productId = 'e'.repeat(32)
  const revisionId = 'f'.repeat(32)
  const { dom, ui } = fixture(async (url, options = {}) => {
    if (url === '/api/tasks') return [{ id: taskId, title: 'Existing task', status: 'awaiting_confirmation' }]
    if (url.includes('/api/product-library?')) return [{
      id: productId, task_id: taskId, sku: 'KEEP-SKU', name: 'Existing product', category: 'fabric',
      material: 'cotton', size: 'old size', color: 'red', latest_revision: { id: revisionId, version: 3 },
    }]
    if (url.includes('/apply')) {
      posts.push({ body: JSON.parse(options.body), key: options.headers['Idempotency-Key'] })
      return { status: 'succeeded', application: { product_id: productId, revision_id: '1'.repeat(32), version: 4, status: 'needs_review', missing_fields: [] } }
    }
    throw new Error(`unexpected request ${url}`)
  })
  await settle()
  ui.taskSelect.value = taskId
  ui.taskSelect.dispatchEvent(new dom.window.Event('change', { bubbles: true }))
  ui.targetSelect.value = 'existing'
  ui.targetSelect.dispatchEvent(new dom.window.Event('change', { bubbles: true }))
  await settle()
  ui.productSelect.value = productId
  ui.productSelect.dispatchEvent(new dom.window.Event('change', { bubbles: true }))
  ui.controls.get('color').input.value = 'navy'
  ui.controls.get('color').sourceSelect.querySelector('option[value="color"]').selected = true
  submit(dom, ui.form)
  await settle()

  assert.equal(posts.length, 1)
  assert.deepEqual(posts[0].body.target, { task_id: taskId, product_id: productId, expected_revision_id: revisionId })
  assert.deepEqual(Object.keys(posts[0].body.fields), ['color'])
  assert.equal(posts[0].body.fields.color.value, 'navy')
  assert.match(ui.status.textContent, /v4/)
  dom.window.close()
})

test('late product-list response for an old task cannot replace the current task selection', async () => {
  const taskA = 'a'.repeat(32)
  const taskB = 'b'.repeat(32)
  let finishA
  const { dom, ui } = fixture(async url => {
    if (url === '/api/tasks') return [
      { id: taskA, title: 'Task A', status: 'draft' },
      { id: taskB, title: 'Task B', status: 'draft' },
    ]
    if (url.includes(`batch_id=${taskA}`)) return new Promise(resolve => { finishA = resolve })
    if (url.includes(`batch_id=${taskB}`)) return [{ id: 'c'.repeat(32), sku: 'B-SKU', name: 'Task B product' }]
    throw new Error(`unexpected request ${url}`)
  })
  await settle()
  ui.taskSelect.value = taskA
  ui.taskSelect.dispatchEvent(new dom.window.Event('change', { bubbles: true }))
  ui.targetSelect.value = 'existing'
  ui.targetSelect.dispatchEvent(new dom.window.Event('change', { bubbles: true }))
  ui.taskSelect.value = taskB
  ui.taskSelect.dispatchEvent(new dom.window.Event('change', { bubbles: true }))
  await settle()
  assert.equal(ui.productSelect.options.length, 2)
  assert.match(ui.productSelect.options[1].textContent, /Task B product/)
  finishA([{ id: 'd'.repeat(32), sku: 'A-SKU', name: 'Stale Task A product' }])
  await settle()
  assert.equal(ui.productSelect.options.length, 2)
  assert.match(ui.productSelect.options[1].textContent, /Task B product/)
  dom.window.close()
})

test('real submit keeps pending unsaved, retries with the same key, and renders frozen field provenance', async () => {
  const posts = []
  let attempt = 0
  const { dom, ui } = fixture(async (url, options = {}) => {
    if (url === '/api/tasks') return [{ id: 'd'.repeat(32), title: 'Synthetic task', status: 'draft' }]
    if (url.includes('/apply')) {
      posts.push({ body: JSON.parse(options.body), headers: options.headers })
      attempt += 1
      if (attempt === 1) return { status: 'pending', operation_id: 'op-1' }
      return { status: 'succeeded', application }
    }
    throw new Error(`unexpected request ${url}`)
  })
  await settle()
  ui.taskSelect.value = 'd'.repeat(32)
  ui.taskSelect.dispatchEvent(new dom.window.Event('change', { bubbles: true }))
  ui.targetSelect.value = 'new'
  ui.targetSelect.dispatchEvent(new dom.window.Event('change', { bubbles: true }))
  ui.controls.get('sku').input.value = 'SKU-1'
  ui.controls.get('sku').note.value = '由审核者核对录入'
  ui.controls.get('name').input.value = '人工名称'
  ui.controls.get('name').note.value = '根据人工资料录入'
  submit(dom, ui.form)
  await settle()
  assert.match(ui.status.textContent, /处理中/)
  assert.doesNotMatch(ui.status.textContent, /已保存/)
  assert.equal(ui.receipts.querySelectorAll('[data-application-receipt]').length, 0)
  const application = {
    product_id: 'e'.repeat(32), revision_id: 'f'.repeat(32), version: 2, status: 'needs_review',
    missing_fields: ['材质', '图片'],
    source_refs: { intake_fields: {
      sku: { kind: 'candidate_reference', confirmed_value: 'SKU-1', note: '人工核对',
        sources: [{ field: 'style_number', sheet_title: '产品表', coordinate: 'B4', value: 'STYLE-1', formula_status: 'literal' }] },
      name: { kind: 'manual_entry', confirmed_value: '人工名称', note: '访谈核对后填写', sources: [] },
    } },
  }
  submit(dom, ui.form)
  await settle()
  assert.equal(posts.length, 2)
  assert.equal(posts[0].headers['Idempotency-Key'], posts[1].headers['Idempotency-Key'])
  assert.match(ui.status.textContent, /已保存待确认版本/)
  assert.match(ui.status.textContent, /待确认/)
  assert.match(ui.status.textContent, /材质、图片/)
  const details = ui.form.querySelector('details[data-application-receipt]')
  assert.ok(details)
  assert.match(details.textContent, /SKU-1/)
  assert.match(details.textContent, /B4/)
  assert.match(details.textContent, /人工核对/)
  assert.match(details.textContent, /人工填写/)
  dom.window.close()
})

test('confirmation form is collapsed by default and older saved receipts remain reachable', async () => {
  const older = { product_id: 'e'.repeat(32), revision_id: 'f'.repeat(32), version: 1,
    status: 'needs_review', missing_fields: [], source_refs: { intake_fields: {} } }
  const { dom, ui } = fixture(async url => {
    if (url === '/api/tasks') return []
    if (url.includes('applications_offset=20')) return { applications: [older], applications_next_offset: null }
    throw new Error(`unexpected request ${url}`)
  }, { applications: [older], applicationsNextOffset: 20 })
  const section = ui.form.closest('details[data-application-section]')
  assert.ok(section)
  assert.equal(section.open, false)
  assert.match(section.querySelector('summary').textContent, /人工确认入库/)
  assert.equal(ui.receipts.querySelectorAll('[data-application-receipt]').length, 1)
  assert.equal(ui.loadOlder.hidden, false)
  ui.loadOlder.click()
  await settle()
  assert.equal(ui.receipts.querySelectorAll('[data-application-receipt]').length, 2)
  assert.equal(ui.loadOlder.hidden, true)
  dom.window.close()
})
