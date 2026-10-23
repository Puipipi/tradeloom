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

test('manual source selection creates an evidence record, includes it in a new plan, and shows frozen history', async () => {
  const candidate = { id: '1'.repeat(32), candidate_type: 'commercial_source', mapping_revision: 3,
    source_display_name: 'quote.xlsx', fields: { unit_price: [{ state: 'present', type: 'decimal', value: '0' }] },
    provenance: { unit_price: [{ snapshot_id: '2'.repeat(32), source_sha256: 'a'.repeat(64), sheet_index: 1, coordinate: 'B4' }] } }
  const requests = []
  let savedPlan
  const dom = await fixture(async (url, options = {}) => {
    requests.push({ url, options })
    if (options.method === 'POST' && url.includes('/evidence')) {
      return response(201, { evidence: { id: '3'.repeat(32), kind: 'source_record' } })
    }
    if (options.method === 'POST') {
      const body = JSON.parse(options.body)
      savedPlan = { id: '4'.repeat(32), revision: 1, is_latest: true, ...body,
        materials: body.materials.map(item => ({ ...item, supporting_sources: [{ candidate_id: candidate.id,
          candidate_type: candidate.candidate_type, source_display_name: candidate.source_display_name, source_id: '6'.repeat(32),
          source_sha256: candidate.provenance.unit_price[0].source_sha256, snapshot_id: candidate.provenance.unit_price[0].snapshot_id,
          mapping_revision: candidate.mapping_revision, field_key: 'unit_price', evidence_id: '3'.repeat(32),
          evidence_status: 'unverified', sheet_index: 1, coordinate: 'B4',
          typed_value: { state: 'present', type: 'decimal', value: '0' }, value_refs: [{ cell_id: '5'.repeat(32) }] }] })),
        requirement_revision: { source_refs: {} } }
      return response(201, { plan: { revision: 1 } })
    }
    if (url.includes('/api/intake/candidates?')) {
      const pageTwo = { ...candidate, id: '7'.repeat(32), source_display_name: 'quote-page-two.xlsx' }
      return response(200, { candidates: url.includes('offset=20') ? [pageTwo] : [candidate],
        next_offset: url.includes('candidate_type=commercial_source') && !url.includes('offset=20') ? 20 : null })
    }
    if (savedPlan) return response(200, { latest_revision: 1, revisions: [savedPlan], next_offset: null })
    return response(200, { latest_revision: 0, revisions: [], next_offset: null })
  })
  emit(dom); await tick()
  ;[...dom.window.document.querySelectorAll('button')].find(item => item.textContent === '添加物料提议').click()
  let picker = dom.window.document.querySelector('.execution-plan-source-picker')
  picker.open = true
  picker.dispatchEvent(new dom.window.Event('toggle'))
  await tick(); await tick(); await tick()
  let selects = picker.querySelectorAll('select')
  selects[0].value = '__more__'; selects[0].dispatchEvent(new dom.window.Event('change', { bubbles: true }))
  await tick(); await tick(); await tick()
  assert.ok([...selects[0].options].some(option => option.textContent.includes('quote-page-two.xlsx')))
  assert.ok(requests.some(item => item.url.includes('offset=20')))
  selects[0].value = candidate.id; selects[0].dispatchEvent(new dom.window.Event('change', { bubbles: true }))
  selects[1].value = 'unit_price'; selects[1].dispatchEvent(new dom.window.Event('change', { bubbles: true }))
  selects[2].value = `${'2'.repeat(32)}|1|B4`; selects[2].dispatchEvent(new dom.window.Event('change', { bubbles: true }))
  await tick(); await tick()
  const evidenceRequest = requests.find(item => item.options.method === 'POST' && item.url.includes('/evidence'))
  assert.ok(evidenceRequest)
  assert.deepEqual(JSON.parse(evidenceRequest.options.body), { schema_version: 1, kind: 'source_record', field_key: 'unit_price',
    snapshot_id: '2'.repeat(32), sheet_index: 1, coordinate: 'B4' })
  const submit = [...dom.window.document.querySelectorAll('button')].find(item => item.textContent === '追加保存计划草稿')
  submit.click(); await tick(); await tick(); await tick()
  const planRequest = requests.find(item => item.options.method === 'POST' && !item.url.includes('/evidence'))
  const body = JSON.parse(planRequest.options.body)
  assert.deepEqual(body.materials[0].supporting_source_inputs, [{ candidate_id: candidate.id, field_key: 'unit_price', evidence_ids: ['3'.repeat(32)] }])
  assert.match(dom.window.document.body.textContent, /来源参考·未核实：quote\.xlsx/)
  assert.match(dom.window.document.body.textContent, /采购\/报价参考/)
  assert.match(dom.window.document.body.textContent, /工作表 1!B4/)
  assert.doesNotMatch(dom.window.document.body.textContent, /commercial_source|unit_price/)
  const downloadLink = dom.window.document.querySelector('.execution-plan-history-row a')
  assert.equal(downloadLink?.getAttribute('href'), `/api/intake/sources/${'6'.repeat(32)}/download`)
  dom.window.close()
})

test('source creation freezes picker controls and a late source response cannot attach after requirement switch', async () => {
  const pendingEvidence = deferred()
  const candidate = { id: '1'.repeat(32), candidate_type: 'labor_analysis', mapping_revision: 1,
    source_display_name: 'labor.xlsx', fields: { process: [{ state: 'present', type: 'text', value: 'sewing' }] },
    provenance: { process: [{ snapshot_id: '2'.repeat(32), source_sha256: 'a'.repeat(64), sheet_index: 1, coordinate: 'A1' }] } }
  let evidenceStarted
  const started = new Promise(resolve => { evidenceStarted = resolve })
  const dom = await fixture(async (url, options = {}) => {
    if (options.method === 'POST' && url.includes('/evidence')) { evidenceStarted(); return pendingEvidence.promise }
    if (url.includes('/api/intake/candidates?')) return response(200, { candidates: [candidate], next_offset: null })
    return response(200, { latest_revision: 0, revisions: [], next_offset: null })
  })
  emit(dom); await tick()
  ;[...dom.window.document.querySelectorAll('button')].find(item => item.textContent === '添加工序提议').click()
  let picker = dom.window.document.querySelector('.execution-plan-source-picker')
  picker.open = true; picker.dispatchEvent(new dom.window.Event('toggle'))
  await tick(); await tick(); await tick()
  let selects = picker.querySelectorAll('select')
  selects[0].value = candidate.id; selects[0].dispatchEvent(new dom.window.Event('change', { bubbles: true }))
  selects[1].value = 'process'; selects[1].dispatchEvent(new dom.window.Event('change', { bubbles: true }))
  selects[2].value = `${'2'.repeat(32)}|1|A1`; selects[2].dispatchEvent(new dom.window.Event('change', { bubbles: true }))
  await started
  assert.equal(selects[0].disabled, true)
  assert.equal(selects[1].disabled, true)
  assert.equal(selects[2].disabled, true)
  emit(dom, { candidateId: 'e'.repeat(32), requirementId: 'f'.repeat(32), revision: { id: '9'.repeat(32), revision: 8, status: 'confirmed', source_refs: {} } })
  pendingEvidence.resolve(response(201, { evidence: { id: '3'.repeat(32) } }))
  await tick(); await tick()
  assert.equal(dom.window.document.body.textContent.includes('labor.xlsx'), false)
  dom.window.close()
})

test('each source picker advances from its own page cursor when pickers load in interleaved order', async () => {
  const delayedLabor = deferred()
  let laborZeroCount = 0
  const requested = []
  const dom = await fixture(async url => {
    requested.push(url)
    const params = new URL(url, 'http://localhost').searchParams
    const type = params.get('candidate_type')
    const offset = Number(params.get('offset'))
    if (type === 'labor_analysis' && offset === 0 && ++laborZeroCount === 2) return delayedLabor.promise
    const next_offset = type === 'commercial_source' ? offset + 20 : offset + 20
    if (!url.includes('/api/intake/candidates?')) return response(200, { latest_revision: 0, revisions: [], next_offset: null })
    return response(200, { candidates: [{ id: `${offset}`.padStart(32, '0'), candidate_type: type, mapping_revision: 1,
      source_display_name: `${type}-${offset}.xlsx`, fields: { unit_price: [] }, provenance: {} }], next_offset })
  })
  emit(dom); await tick()
  ;[...dom.window.document.querySelectorAll('button')].find(item => item.textContent === '添加物料提议').click()
  ;[...dom.window.document.querySelectorAll('button')].find(item => item.textContent === '添加物料提议').click()
  const pickers = dom.window.document.querySelectorAll('.execution-plan-source-picker')
  pickers[0].open = true; pickers[0].dispatchEvent(new dom.window.Event('toggle'))
  await tick(); await tick(); await tick()
  const firstSelect = pickers[0].querySelector('select')
  for (let page = 0; page < 2; page++) {
    firstSelect.value = '__more__'; firstSelect.dispatchEvent(new dom.window.Event('change'))
    await tick(); await tick()
  }
  assert.ok(requested.includes('/api/intake/candidates?candidate_type=commercial_source&offset=40&limit=20'))
  pickers[1].open = true; pickers[1].dispatchEvent(new dom.window.Event('toggle'))
  await tick(); await tick() // The second picker has loaded its first commercial page and awaits labor.
  firstSelect.value = '__more__'; firstSelect.dispatchEvent(new dom.window.Event('change'))
  await tick(); await tick()
  delayedLabor.resolve(response(200, { candidates: [], next_offset: 20 }))
  await tick(); await tick()
  const secondSelect = pickers[1].querySelector('select')
  secondSelect.value = '__more__'; secondSelect.dispatchEvent(new dom.window.Event('change'))
  await tick(); await tick(); await tick()
  const secondPickerCommercialOffsets = requested.filter(url => url.includes('candidate_type=commercial_source')).map(url => new URL(url, 'http://localhost').searchParams.get('offset'))
  assert.deepEqual(secondPickerCommercialOffsets.slice(-1), ['20'], 'picker two should page from its own offset 20, not picker one offset 40')
  dom.window.close()
})

test('a failed candidate type can be retried while the successful type remains selectable', async () => {
  let laborFails = true
  const commercial = { id: '1'.repeat(32), candidate_type: 'commercial_source', mapping_revision: 1,
    source_display_name: 'quote.xlsx', fields: { unit_price: [] }, provenance: {} }
  const dom = await fixture(async url => {
    if (url.includes('candidate_type=labor_analysis') && laborFails) { laborFails = false; throw new TypeError('temporary read failure') }
    if (url.includes('/api/intake/candidates?')) return response(200, { candidates: url.includes('commercial_source') ? [commercial] : [], next_offset: null })
    return response(200, { latest_revision: 0, revisions: [], next_offset: null })
  })
  emit(dom); await tick()
  ;[...dom.window.document.querySelectorAll('button')].find(item => item.textContent === '添加物料提议').click()
  const picker = dom.window.document.querySelector('.execution-plan-source-picker')
  picker.open = true; picker.dispatchEvent(new dom.window.Event('toggle'))
  await tick(); await tick(); await tick()
  const candidateSelect = picker.querySelector('select')
  assert.ok([...candidateSelect.options].some(option => option.value === commercial.id), 'successful source type is available immediately')
  picker.open = false; picker.dispatchEvent(new dom.window.Event('toggle'))
  picker.open = true; picker.dispatchEvent(new dom.window.Event('toggle'))
  await tick(); await tick(); await tick()
  assert.ok([...candidateSelect.options].some(option => option.value === commercial.id))
  assert.equal(candidateSelect.disabled, false)
  dom.window.close()
})

test('late candidate pages cannot re-enable picker controls during plan save', async () => {
  const candidates = deferred()
  const saved = deferred()
  const candidateStarted = new Promise(resolve => { candidates.started = resolve })
  let saveStarted
  const saveRequestStarted = new Promise(resolve => { saveStarted = resolve })
  const dom = await fixture(async (url, options = {}) => {
    if (options.method === 'POST') { saveStarted(); return saved.promise }
    if (url.includes('/api/intake/candidates?')) { candidates.started(); return candidates.promise }
    return response(200, { latest_revision: 0, revisions: [], next_offset: null })
  })
  emit(dom); await tick()
  ;[...dom.window.document.querySelectorAll('button')].find(item => item.textContent === '添加物料提议').click()
  const picker = dom.window.document.querySelector('.execution-plan-source-picker')
  picker.open = true; picker.dispatchEvent(new dom.window.Event('toggle'))
  await candidateStarted
  ;[...dom.window.document.querySelectorAll('button')].find(item => item.textContent === '追加保存计划草稿').click()
  await saveRequestStarted
  candidates.resolve(response(200, { candidates: [], next_offset: null }))
  await tick(); await tick(); await tick()
  assert.ok([...picker.querySelectorAll('select')].every(control => control.disabled), 'picker remains frozen while the plan POST is pending')
  saved.resolve(response(201, { plan: { revision: 1 } }))
  await tick(); await tick()
  dom.window.close()
})

test('selected source cell stays exact, its reference can be removed, and evidence retries reuse one key', async () => {
  const candidate = { id: '1'.repeat(32), candidate_type: 'commercial_source', mapping_revision: 2,
    source_display_name: 'two-cells.xlsx', fields: { unit_price: [
      { state: 'present', type: 'decimal', value: '3' }, { state: 'present', type: 'decimal', value: '4' }] },
    provenance: { unit_price: [
      { snapshot_id: '2'.repeat(32), source_sha256: 'a'.repeat(64), sheet_index: 1, coordinate: 'B1' },
      { snapshot_id: '2'.repeat(32), source_sha256: 'a'.repeat(64), sheet_index: 1, coordinate: 'B2' }] } }
  const evidenceRequests = []
  let failOnce = true
  let savedPlan
  const dom = await fixture(async (url, options = {}) => {
    if (options.method === 'POST' && url.includes('/evidence')) {
      evidenceRequests.push({ key: options.headers['Idempotency-Key'], body: JSON.parse(options.body) })
      if (failOnce) { failOnce = false; throw new TypeError('synthetic network loss') }
      return response(201, { evidence: { id: '3'.repeat(32), kind: 'source_record' } })
    }
    if (options.method === 'POST') {
      const body = JSON.parse(options.body)
      savedPlan = { id: '4'.repeat(32), revision: 1, is_latest: true,
        materials: body.materials.map(item => ({ ...item, supporting_sources: [{ candidate_id: candidate.id,
          candidate_type: candidate.candidate_type, source_display_name: candidate.source_display_name, source_id: '5'.repeat(32),
          source_sha256: 'a'.repeat(64), snapshot_id: '2'.repeat(32), mapping_revision: 2, field_key: 'unit_price',
          evidence_id: '3'.repeat(32), evidence_status: 'unverified', sheet_index: 1, coordinate: 'B2',
          typed_value: { state: 'present', type: 'decimal', value: '4' }, value_refs: [{ cell_id: '6'.repeat(32) }] }] })),
        operations: [], requirement_refs: [], requirement_revision: { source_refs: {} } }
      return response(201, { plan: { revision: 1 } })
    }
    if (url.includes('/api/intake/candidates?')) return response(200, { candidates: [candidate], next_offset: null })
    if (savedPlan) return response(200, { latest_revision: 1, revisions: [savedPlan], next_offset: null })
    return response(200, { latest_revision: 0, revisions: [], next_offset: null })
  })
  emit(dom); await tick()
  ;[...dom.window.document.querySelectorAll('button')].find(item => item.textContent === '添加物料提议').click()
  const description = dom.window.document.querySelector('textarea')
  description.value = 'retain proposal'; description.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
  let picker = dom.window.document.querySelector('.execution-plan-source-picker')
  picker.open = true; picker.dispatchEvent(new dom.window.Event('toggle'))
  await tick(); await tick(); await tick()
  let selects = picker.querySelectorAll('select')
  selects[0].value = candidate.id; selects[0].dispatchEvent(new dom.window.Event('change', { bubbles: true }))
  selects[1].value = 'unit_price'; selects[1].dispatchEvent(new dom.window.Event('change', { bubbles: true }))
  selects[2].value = `${'2'.repeat(32)}|1|B2`; selects[2].dispatchEvent(new dom.window.Event('change', { bubbles: true }))
  await tick(); await tick()
  assert.equal(dom.window.document.querySelector('.execution-plan-source-linked').textContent, '', 'a failed request remains unassociated')
  selects[2].dispatchEvent(new dom.window.Event('change', { bubbles: true }))
  await tick(); await tick()
  assert.equal(evidenceRequests.length, 2)
  assert.equal(evidenceRequests[0].key, evidenceRequests[1].key)
  assert.match(dom.window.document.querySelector('.execution-plan-source-linked').textContent, /工作表 1!B2/)
  const remove = dom.window.document.querySelector('.execution-plan-source-linked button')
  assert.ok(remove, 'a staged reference can be removed by itself')
  remove.click()
  assert.equal(dom.window.document.querySelector('textarea').value, 'retain proposal')
  assert.equal(dom.window.document.querySelector('.execution-plan-source-linked').textContent, '')
  // Recreate the same selection. The successful evidence record should be reused, not duplicated.
  picker = dom.window.document.querySelector('.execution-plan-source-picker')
  picker.open = true; picker.dispatchEvent(new dom.window.Event('toggle'))
  await tick(); await tick(); await tick()
  selects = picker.querySelectorAll('select')
  selects[0].value = candidate.id; selects[0].dispatchEvent(new dom.window.Event('change', { bubbles: true }))
  selects[1].value = 'unit_price'; selects[1].dispatchEvent(new dom.window.Event('change', { bubbles: true }))
  selects[2].value = `${'2'.repeat(32)}|1|B2`; selects[2].dispatchEvent(new dom.window.Event('change', { bubbles: true }))
  await tick(); await tick()
  assert.equal(evidenceRequests.length, 2)
  assert.match(dom.window.document.querySelector('.execution-plan-source-linked').textContent, /工作表 1!B2/)
  dom.window.document.querySelector('[data-plan-save]').click(); await tick(); await tick(); await tick()
  const planPost = dom.window.document.querySelector('.execution-plan-history-row')
  assert.match(planPost.textContent, /工作表 1!B2/)
  assert.doesNotMatch(planPost.textContent, /工作表 1!B1/)
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
