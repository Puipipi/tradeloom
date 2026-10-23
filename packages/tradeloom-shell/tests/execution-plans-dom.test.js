import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import test from 'node:test'

const domRoot = process.env.TRADELOOM_DOM_TEST_ROOT
if (!domRoot) throw new Error('TRADELOOM_DOM_TEST_ROOT must point to the existing external jsdom runtime')
const { JSDOM } = await import(pathToFileURL(join(domRoot, 'node_modules', 'jsdom', 'lib', 'api.js')).href)
const moduleSource = await readFile(new URL('../../../workbench/static/workbench/execution-plans.js', import.meta.url), 'utf8')
const stylesSource = await readFile(new URL('../../../workbench/static/workbench/styles.css', import.meta.url), 'utf8')

const reqId = 'a'.repeat(32)
const revisionId = 'b'.repeat(32)
const evidenceId = 'c'.repeat(32)
const candidateId = 'd'.repeat(32)

function deferred() {
  let resolve
  const promise = new Promise(done => { resolve = done })
  return { promise, resolve }
}

function response(status, body) {
  return { ok: status >= 200 && status < 300, status, headers: { get: () => 'application/json' }, async json() { return body } }
}

async function fixture(fetchImpl) {
  const dom = new JSDOM(`<!doctype html><meta name="csrf-token" content="csrf"><section data-testid="intake-workbench"></section>
    <section data-testid="execution-plan-workbench" data-plan-collection-url="/api/production-requirements/__REQUIREMENT__/execution-plan-revisions">
      <div data-testid="execution-plan-content"></div></section>`, { runScripts: 'outside-only', url: 'http://localhost/business/artifacts' })
  dom.window.fetch = fetchImpl
  dom.window.eval(moduleSource)
  return dom
}

function emit(dom, overrides = {}) {
  const detail = { phase: 'viewed', candidateId, requirementId: reqId,
    revision: { id: revisionId, revision: 4, status: 'confirmed', fields: { description: 'confirmed requirement' },
      source_refs: { description: [{ id: evidenceId, field_key: 'description', kind: 'source_record', summary: '<img src=x onerror=alert(1)>', sheet_index: 1, coordinate: 'A1' }] } },
    dirty: false, saving: false, ...overrides }
  dom.window.document.querySelector('[data-testid="intake-workbench"]').dispatchEvent(new dom.window.CustomEvent('tradeloom:requirement-context', { detail }))
}

const tick = () => new Promise(resolve => setTimeout(resolve, 0))

test('unconfirmed and dirty requirement contexts cannot save; blank material quantity stays null and explicit zero stays text', async () => {
  const posts = []
  const dom = await fixture(async (_url, options = {}) => {
    if (options.method === 'POST') {
      posts.push(JSON.parse(options.body))
      return response(201, { plan: { revision: posts.length } })
    }
    return response(200, { latest_revision: posts.length, revisions: [], next_offset: null })
  })
  emit(dom, { revision: { id: revisionId, revision: 4, status: 'needs_confirmation', source_refs: {} } })
  await tick()
  assert.equal(dom.window.document.querySelector('[data-plan-save]'), null)
  emit(dom)
  await tick()
  dom.window.document.querySelector('button').click() // Refresh is harmless.
  await tick()
  let add = [...dom.window.document.querySelectorAll('button')].find(item => item.textContent === '添加物料提议')
  add.click()
  const save = [...dom.window.document.querySelectorAll('button')].find(item => item.textContent === '追加保存计划草稿')
  assert.equal(save.disabled, false, 'an explicitly added proposal may be saved with null fields')
  const description = dom.window.document.querySelector('textarea')
  description.value = 'manual estimate'
  description.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
  const qty = [...dom.window.document.querySelectorAll('input')].find(item => item.placeholder === '预计用量（可留空）')
  assert.equal(qty.value, '')
  dom.window.document.querySelector('input[type=checkbox]').checked = true
  dom.window.document.querySelector('input[type=checkbox]').dispatchEvent(new dom.window.Event('change', { bubbles: true }))
  assert.equal(dom.window.document.querySelectorAll('img').length, 0, 'source text is rendered as text, never HTML')
  const stateTarget = dom.window.document.querySelector('[data-testid="intake-workbench"]')
  stateTarget.dispatchEvent(new dom.window.CustomEvent('tradeloom:requirement-context', { detail: { phase: 'state', dirty: true, saving: false } }))
  assert.equal(save.disabled, true)
  stateTarget.dispatchEvent(new dom.window.CustomEvent('tradeloom:requirement-context', { detail: { phase: 'state', dirty: false, saving: false } }))
  await tick()
  const saveAgain = [...dom.window.document.querySelectorAll('button')].find(item => item.textContent === '追加保存计划草稿')
  assert.equal(saveAgain.disabled, false)
  saveAgain.click(); await tick()
  assert.equal(posts[0].materials[0].proposal.quantity, null)
  assert.equal(posts[0].requirement_refs[0].evidence_ids[0], evidenceId)
  add = [...dom.window.document.querySelectorAll('button')].find(item => item.textContent === '添加物料提议')
  add.click()
  const secondQuantity = [...dom.window.document.querySelectorAll('input')].find(item => item.placeholder === '预计用量（可留空）')
  secondQuantity.value = '0'; secondQuantity.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
  const saveZero = [...dom.window.document.querySelectorAll('button')].find(item => item.textContent === '追加保存计划草稿')
  saveZero.click(); await tick(); await tick()
  assert.equal(posts[1].materials[0].proposal.quantity, '0')
  dom.window.close()
})

test('execution plan selectors use the existing light and dark theme tokens', () => {
  const block = stylesSource.slice(stylesSource.indexOf('.execution-plan-history-row,'), stylesSource.indexOf('.execution-plan-history-row p,'))
  const light = stylesSource.slice(stylesSource.indexOf(':root {'), stylesSource.indexOf('html[data-color-scheme="dark"]'))
  const dark = stylesSource.slice(stylesSource.indexOf('html[data-color-scheme="dark"] {'), stylesSource.indexOf('\n}', stylesSource.indexOf('html[data-color-scheme="dark"] {')))
  assert.match(block, /var\(--line\)/)
  assert.match(block, /var\(--surface-soft\)/)
  assert.match(block, /border-radius: 8px/)
  assert.doesNotMatch(block, /--wb-(?:border|surface|radius)/)
  for (const theme of [light, dark]) {
    assert.match(theme, /--line:/)
    assert.match(theme, /--surface-soft:/)
  }
})

test('late history response for another exact requirement cannot replace the selected requirement history', async () => {
  const first = deferred()
  let count = 0
  const dom = await fixture(async url => {
    count++
    if (url.includes(reqId)) return first.promise
    return response(200, { latest_revision: 0, revisions: [], next_offset: null })
  })
  emit(dom)
  emit(dom, { candidateId: 'e'.repeat(32), requirementId: 'f'.repeat(32), revision: { id: '9'.repeat(32), revision: 8, status: 'confirmed', source_refs: {} } })
  await tick()
  first.resolve(response(200, { latest_revision: 0, revisions: [{ id: 'late', revision: 99, materials: [], operations: [], is_latest: true }], next_offset: null }))
  await tick(); await tick()
  assert.equal(count, 2)
  assert.equal(dom.window.document.body.textContent.includes('版本 99'), false)
  assert.equal(dom.window.document.body.textContent.includes('版本 8'), true)
  dom.window.close()
})

test('history is filtered by the exact requirement revision and exposes saved rows read-only', async () => {
  const requests = []
  const plan = { id: '8'.repeat(32), revision: 1, is_latest: true, materials: [{ proposal: { description: 'saved material', quantity: '2', unit: 'kg' } }], operations: [], requirement_refs: [],
    requirement_revision: { source_refs: {} } }
  const dom = await fixture(async url => {
    requests.push(url)
    return response(200, { latest_revision: 1, revisions: [plan], next_offset: null })
  })
  emit(dom); await tick()
  assert.match(requests[0], new RegExp(`requirement_revision_id=${revisionId}`))
  assert.equal(dom.window.document.body.textContent.includes('saved material'), true)
  const historyRow = dom.window.document.querySelector('.execution-plan-history-row')
  assert.ok(historyRow)
  assert.equal(historyRow.querySelector('input,textarea,select,button'), null)
  dom.window.close()
})

test('same-context history refreshes ignore older responses so saves use the newest lineage revision', async () => {
  const older = deferred()
  let gets = 0
  let posted
  const dom = await fixture(async (_url, options = {}) => {
    if (options.method === 'POST') { posted = JSON.parse(options.body); return response(201, { plan: { revision: 6 } }) }
    gets++
    if (gets === 1) return older.promise
    return response(200, { latest_revision: 5, revisions: [], next_offset: null })
  })
  emit(dom); await tick()
  dom.window.document.querySelector('button').click() // A newer refresh starts in the same context.
  await tick()
  older.resolve(response(200, { latest_revision: 2, revisions: [], next_offset: null }))
  await tick(); await tick()
  ;[...dom.window.document.querySelectorAll('button')].find(item => item.textContent === '添加物料提议').click()
  dom.window.document.querySelector('[data-plan-save]').click(); await tick(); await tick()
  assert.equal(posted.expected_revision, 5)
  dom.window.close()
})

test('409 keeps entered values and network retry reuses the idempotency key', async () => {
  const posts = []
  let fail = true
  const dom = await fixture(async (_url, options = {}) => {
    if (options.method === 'POST') {
      posts.push({ key: options.headers['Idempotency-Key'], body: options.body })
      if (fail) { fail = false; return response(503, { error_code: 'unavailable' }) }
      return response(409, { error_code: 'stale_execution_plan' })
    }
    return response(200, { latest_revision: 0, revisions: [], next_offset: null })
  })
  emit(dom); await tick()
  const add = [...dom.window.document.querySelectorAll('button')].find(item => item.textContent === '添加工序提议')
  add.click()
  const description = dom.window.document.querySelector('textarea'); description.value = 'keep this'; description.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
  const submit = [...dom.window.document.querySelectorAll('button')].find(item => item.textContent === '追加保存计划草稿')
  submit.click(); await tick(); await tick()
  const retry = [...dom.window.document.querySelectorAll('button')].find(item => item.textContent === '追加保存计划草稿')
  retry.click(); await tick(); await tick()
  assert.equal(posts.length, 2)
  assert.equal(posts[0].key, posts[1].key)
  assert.equal(posts[0].body, posts[1].body)
  assert.equal(dom.window.document.querySelector('textarea')?.value, 'keep this')
  assert.equal(dom.window.document.body.textContent.includes('输入仍保留'), true)
  assert.ok([...dom.window.document.querySelectorAll('button')].some(item => item.textContent === '重新读取计划'))
  dom.window.close()
})

test('invalid operation sequence stays explicit and is rejected before a lossy JSON conversion', async () => {
  let postCount = 0
  const dom = await fixture(async (_url, options = {}) => {
    if (options.method === 'POST') { postCount++; return response(201, { plan: { revision: 1 } }) }
    return response(200, { latest_revision: 0, revisions: [], next_offset: null })
  })
  emit(dom); await tick()
  ;[...dom.window.document.querySelectorAll('button')].find(item => item.textContent === '添加工序提议').click()
  const sequence = dom.window.document.querySelector('input[placeholder="顺序（可留空）"]')
  sequence.value = '0'; sequence.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
  dom.window.document.querySelector('[data-plan-save]').click(); await tick()
  assert.equal(postCount, 0)
  assert.equal(sequence.value, '0')
  assert.match(dom.window.document.body.textContent, /正整数/)
  dom.window.close()
})

test('saving freezes plan inputs until a delayed POST resolves', async () => {
  const historyPending = deferred()
  const pending = deferred()
  let postCount = 0
  let gets = 0
  const dom = await fixture(async (_url, options = {}) => {
    if (options.method === 'POST') { postCount++; return pending.promise }
    gets++
    if (gets === 1) return historyPending.promise
    return response(200, { latest_revision: 0, revisions: [], next_offset: null })
  })
  emit(dom); await tick()
  ;[...dom.window.document.querySelectorAll('button')].find(item => item.textContent === '添加物料提议').click()
  const description = dom.window.document.querySelector('textarea'); description.value = 'pending value'; description.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
  dom.window.document.querySelector('[data-plan-save]').click()
  assert.equal(postCount, 1)
  assert.equal(description.disabled, true)
  historyPending.resolve(response(200, { latest_revision: 0, revisions: [], next_offset: null })); await tick(); await tick()
  assert.equal(dom.window.document.querySelector('textarea').disabled, true, 'a late history render cannot unlock in-flight edits')
  assert.equal([...dom.window.document.querySelectorAll('button')].find(item => item.textContent === '添加物料提议').disabled, true)
  pending.resolve(response(201, { plan: { revision: 1 } })); await tick(); await tick()
  assert.equal(dom.window.document.querySelector('textarea'), null)
  assert.match(dom.window.document.body.textContent, /已追加保存计划版本 1/)
  dom.window.close()
})
