import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { createConfirmedWorkflowDefinition } from '../workflow-definition.js'
import { createPostgresWorkflowDefinitionStore } from '../workflow-definition-postgres.js'

const webServer = { protocol: 'http:', host: '127.0.0.1', port: 33188, getOrigin: () => 'http://127.0.0.1:33188' }
const pairedHost = { host: '127.0.0.1', port: 33188 }
const bridgeKey = 'e'.repeat(64)
const timestamp = '2026-10-31T02:00:00+00:00'

function workflow(id = 'seasonal-flow', { confirmed = true, title = 'Seasonal flow', nodes } = {}) {
  return {
    version: 1, id, title, source: 'manual', confirmed,
    nodes: nodes ?? [{ id: 'start', kind: 'input', title: 'Start' }, { id: 'finish', kind: 'output', title: 'Finish' }],
    edges: [{ from: 'start', to: 'finish' }],
  }
}

function activeRow(document, revision = 1) {
  const canonical = document.confirmed ? createConfirmedWorkflowDefinition(document) : { document, definitionRevision: null }
  return { workflowId: document.id, revision, definitionRevision: canonical.definitionRevision,
    document: canonical.document, deleted: false, updatedAt: timestamp }
}

function fixture(handler, overrides = {}) {
  const requests = []
  const request = (transport, receive) => {
    const chunks = []
    const upstream = new EventEmitter()
    upstream.write = chunk => chunks.push(Buffer.from(chunk))
    upstream.destroy = error => { if (error) upstream.emit('error', error) }
    upstream.end = () => {
      const input = { ...transport, body: chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : null }
      requests.push(input)
      const response = new EventEmitter()
      response.statusCode = 200
      response.headers = {}
      response.end = value => { if (value !== undefined) response.emit('data', Buffer.from(value)); response.emit('end') }
      receive(response)
      handler(input, response)
    }
    return upstream
  }
  const options = { webServer, pairedHost, nativeBridgeKey: bridgeKey, port: 33190, request, ...overrides }
  return { options, requests, store: createPostgresWorkflowDefinitionStore(options) }
}

function json(response, value, status = 200) {
  response.statusCode = status
  response.end(JSON.stringify(value))
}

test('definition adapter uses the paired private bridge and validates persisted DTOs', async () => {
  const rows = new Map()
  const { store, requests } = fixture((input, response) => {
    const url = new URL(input.path, 'http://fixture')
    if (input.method === 'GET' && url.searchParams.has('id')) {
      const row = rows.get(url.searchParams.get('id'))
      return row ? json(response, row) : json(response, { code: 'definition_not_found' }, 404)
    }
    if (input.method === 'GET') return json(response, { definitions: [...rows.values()].filter(row => !row.deleted),
      total: [...rows.values()].filter(row => !row.deleted).length, offset: 0, limit: 50, nextOffset: null })
    if (input.method === 'POST') {
      const expected = rows.get(input.body.document.id)?.revision ?? 0
      if (expected !== input.body.expectedRevision) return json(response, { code: 'revision_conflict' }, 409)
      const row = activeRow(input.body.document, expected + 1)
      rows.set(row.workflowId, row)
      return json(response, row, expected === 0 ? 201 : 200)
    }
    const row = rows.get(input.body.workflowId)
    if (!row || row.revision !== input.body.expectedRevision) return json(response, { code: 'revision_conflict' }, 409)
    if (!row.deleted) rows.set(row.workflowId, { ...row, revision: row.revision + 1, deleted: true,
      document: null, definitionRevision: null, updatedAt: timestamp })
    json(response, rows.get(row.workflowId))
  })

  assert.deepEqual(await store.getVersioned('seasonal-flow'), { document: null, revision: 0, definitionRevision: null, updatedAt: null })
  const draft = workflow('draft-flow', { confirmed: false })
  const draftSaved = await store.saveVersioned(draft, 0)
  assert.equal(draftSaved.definitionRevision, null)
  assert.equal(draftSaved.revision, 1)
  assert.equal((await store.get('draft-flow')).confirmed, false)

  const created = await store.saveVersioned(workflow(), 0)
  assert.equal(created.revision, 1)
  const confirmed = createConfirmedWorkflowDefinition(workflow())
  assert.equal(created.definitionRevision, confirmed.definitionRevision)
  assert.deepEqual(created.document, confirmed.document)
  const list = await store.listPage()
  assert.deepEqual(list.definitions.map(row => row.workflowId), ['draft-flow', 'seasonal-flow'])
  assert.equal(list.total, 2)
  assert.deepEqual(await store.get('seasonal-flow'), { ...confirmed.document, updatedAt: timestamp })

  const removed = await store.removeVersioned('seasonal-flow', 1)
  assert.equal(removed.revision, 2)
  assert.equal(removed.deleted, true)
  assert.equal(removed.document, null)
  assert.equal((await store.removeVersioned('seasonal-flow', 2)).revision, 2)
  assert.equal(await store.get('seasonal-flow'), null)
  assert.equal((await store.saveVersioned(workflow(), 2)).revision, 3)

  assert.ok(requests.every(request => request.hostname === '127.0.0.1' && request.port === 33190))
  assert.ok(requests.every(request => request.headers.host === '127.0.0.1:33188' && request.headers.origin === 'http://127.0.0.1:33188'))
  assert.ok(requests.every(request => request.headers['x-tradeloom-native-bridge'] === bridgeKey))
  assert.ok(requests.every(request => request.headers.cookie === undefined && request.headers['x-csrftoken'] === undefined))
  assert.ok(requests.every(request => request.path === '/api/canvas-workflow-definitions' || request.path.startsWith('/api/canvas-workflow-definitions?')))
})

test('list pages are explicit, validated, and bounded by requested page capacity', async () => {
  const largeNodes = [{ id: 'start', kind: 'input', title: 'Start' },
    ...Array.from({ length: 38 }, (_, index) => ({ id: `step-${index}`, kind: 'review', title: `Step ${index}`, instruction: 'x'.repeat(3900) })),
    { id: 'finish', kind: 'output', title: 'Finish' }]
  const docs = Array.from({ length: 10 }, (_, index) => activeRow(workflow(`large-${String(index).padStart(2, '0')}`, { nodes: largeNodes })))
  assert.ok(Buffer.byteLength(JSON.stringify({ definitions: docs, total: 25, offset: 0, limit: 10, nextOffset: 10 })) > 1024 * 1024)
  const { store } = fixture((_input, response) => json(response, { definitions: docs, total: 25, offset: 0, limit: 10, nextOffset: 10 }))
  const page = await store.listPage({ offset: 0, limit: 10 })
  assert.equal(page.definitions.length, 10)
  assert.equal(page.nextOffset, 10)
  const pastEnd = fixture((_input, response) => json(response, { definitions: [], total: 2, offset: 9, limit: 10, nextOffset: null }))
  assert.deepEqual(await pastEnd.store.listPage({ offset: 9, limit: 10 }), { definitions: [], total: 2, offset: 9, limit: 10, nextOffset: null })
  const serverOrder = [activeRow(workflow('zulu-flow')), activeRow(workflow('alpha-flow'))]
  const ordered = fixture((_input, response) => json(response, { definitions: serverOrder, total: 2, offset: 0, limit: 10, nextOffset: null }))
  assert.deepEqual((await ordered.store.listPage({ limit: 10 })).definitions.map(row => row.workflowId), ['zulu-flow', 'alpha-flow'])
  const prematureEnd = fixture((_input, response) => json(response, { definitions: serverOrder, total: 3, offset: 0, limit: 10, nextOffset: null }))
  await assert.rejects(prematureEnd.store.listPage({ limit: 10 }), { code: 'invalid_definition_store_response' })
})

test('stale writes, malformed DTOs, and unknown server bodies fail without retry or disclosure', async () => {
  let calls = 0
  const conflict = fixture((_input, response) => { calls++; json(response, { code: 'revision_conflict', detail: 'private response text' }, 409) })
  await assert.rejects(conflict.store.saveVersioned(workflow(), 5), error => error.code === 'revision_conflict'
    && error.status === 409 && !String(error).includes('private response text'))
  assert.equal(calls, 1)

  const malformed = fixture((_input, response) => json(response, { ...activeRow(workflow()), workflowId: 'other' }))
  await assert.rejects(malformed.store.getVersioned('seasonal-flow'), { code: 'invalid_definition_store_response' })
  const extra = fixture((_input, response) => json(response, { ...activeRow(workflow()), unexpected: 'field' }))
  await assert.rejects(extra.store.getVersioned('seasonal-flow'), { code: 'invalid_definition_store_response' })
  const wrongStatus = fixture((_input, response) => json(response, activeRow(workflow()), 201))
  await assert.rejects(wrongStatus.store.getVersioned('seasonal-flow'), { code: 'invalid_definition_store_response' })
  const wrongRevision = fixture((input, response) => json(response, { ...activeRow(input.body.document, 9) }, 201))
  await assert.rejects(wrongRevision.store.saveVersioned(workflow(), 0), { code: 'invalid_definition_store_response' })
  const unknown = fixture((_input, response) => { response.statusCode = 503; response.end('{"code":"server-secret","detail":"do not show"}') })
  await assert.rejects(unknown.store.getVersioned('seasonal-flow'), error => error.code === 'definition_store_unavailable'
    && !String(error).includes('server-secret') && !String(error).includes('do not show'))
  for (const code of [['native_bridge_required'], 'constructor', 'toString']) {
    const unknownShape = fixture((_input, response) => json(response, { code }, 403))
    await assert.rejects(unknownShape.store.getVersioned('seasonal-flow'), { code: 'definition_store_unavailable' })
  }
})

test('save snapshots caller input before its asynchronous transport settles', async () => {
  let captured
  let finish
  const request = (transport, receive) => {
    const chunks = []
    const upstream = new EventEmitter()
    upstream.write = chunk => chunks.push(Buffer.from(chunk))
    upstream.destroy = error => { if (error) upstream.emit('error', error) }
    upstream.end = () => {
      captured = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      finish = () => {
        const response = new EventEmitter()
        response.statusCode = 201
        response.headers = {}
        response.end = value => { response.emit('data', Buffer.from(value)); response.emit('end') }
        receive(response)
        json(response, activeRow(captured.document, 1), 201)
      }
    }
    return upstream
  }
  const { store } = fixture(() => {}, { request })
  const input = workflow()
  const pending = store.saveVersioned(input, 0)
  input.title = 'mutated after call'
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(captured.document.title, 'Seasonal flow')
  finish()
  const saved = await pending
  assert.equal(saved.document.title, 'Seasonal flow')
  assert.equal(saved.definitionRevision, createConfirmedWorkflowDefinition(saved.document).definitionRevision)
})

test('the adapter rejects missing trust and cancels the existing request without exposing private inputs', async () => {
  let calls = 0
  const request = () => { calls++; throw new Error('must not call') }
  const noKey = createPostgresWorkflowDefinitionStore({ webServer, pairedHost, nativeBridgeKey: '', request })
  await assert.rejects(noKey.getVersioned('seasonal-flow'), { code: 'native_bridge_unavailable' })
  const badId = createPostgresWorkflowDefinitionStore({ webServer, pairedHost, nativeBridgeKey: bridgeKey, request })
  await assert.rejects(badId.getVersioned('../secret'), { code: 'invalid_workflow_id' })
  assert.equal(calls, 0)

  let held
  const cancellable = createPostgresWorkflowDefinitionStore({ webServer, pairedHost, nativeBridgeKey: bridgeKey,
    request(_transport, _receive) { held = new EventEmitter(); held.destroy = error => held.emit('error', error); held.end = () => {}; return held } })
  const controller = new AbortController()
  const pending = cancellable.getVersioned('seasonal-flow', { signal: controller.signal })
  controller.abort()
  await assert.rejects(pending, { code: 'definition_store_cancelled' })
})

test('package metadata exports and bundles the definition client module', async () => {
  const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
  assert.equal(packageJson.exports['./workflow-definition-postgres'], './workflow-definition-postgres.js')
  assert.ok(packageJson.files.includes('workflow-definition-postgres.js'))
})
