import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { createPostgresWorkflowRunStore } from '../workflow-postgres.js'

const webServer = { protocol: 'http:', host: '192.168.1.23', port: 3088, getOrigin: () => 'http://192.168.1.23:3088' }
const bridgeKey = 'e'.repeat(64)

async function fixture(_t, handler, overrides = {}) {
  const requests = []
  const request = (transport, receive) => {
    const chunks = []
    const upstream = new EventEmitter()
    upstream.write = chunk => chunks.push(chunk)
    upstream.destroy = error => { if (error) upstream.emit('error', error) }
    upstream.end = () => {
      const input = { method: transport.method, path: transport.path, headers: transport.headers,
        hostname: transport.hostname, port: transport.port,
        body: chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : null }
      requests.push(input)
      const response = new EventEmitter()
      response.statusCode = 200
      response.headers = {}
      response.setHeader = (name, value) => { response.headers[name.toLowerCase()] = value }
      response.end = value => { response.emit('data', Buffer.from(value)); response.emit('end') }
      receive(response)
      handler(input, response)
    }
    return upstream
  }
  const options = { webServer, nativeBridgeKey: bridgeKey, port: 3090, request, ...overrides }
  return { requests, options, store: createPostgresWorkflowRunStore(options) }
}

test('paired request contract sends CAS revision and reads persisted state through a fresh store instance', async t => {
  const rows = new Map()
  const { store, options, requests } = await fixture(t, (input, response) => {
    response.setHeader('content-type', 'application/json')
    if (input.method === 'POST') {
      assert.equal(input.body.expectedRevision, 0)
      rows.set(input.body.snapshot.id, input.body.snapshot)
      response.statusCode = 201
      response.end(JSON.stringify({ snapshot: input.body.snapshot }))
    } else response.end(JSON.stringify({ snapshot: rows.get(new URL(input.path, 'http://fixture').searchParams.get('id')) }))
  })
  const snapshot = { id: randomUUID(), workflowId: 'sample', revision: 1, status: 'running',
    executionMode: 'native_dsh', document: { id: 'sample' }, nodes: {}, title: 'Sample' }
  assert.deepEqual(await store.save(snapshot, 0), snapshot)
  assert.deepEqual(await createPostgresWorkflowRunStore(options).get(snapshot.id), snapshot)
  assert.equal(requests.length, 2)
  assert.equal(requests[0].headers['x-tradeloom-native-bridge'], bridgeKey)
  assert.equal(requests[0].headers.host, '192.168.1.23:3088')
  assert.equal(requests[0].headers.origin, 'http://192.168.1.23:3088')
  assert.equal(requests[0].headers.cookie, undefined)
  assert.equal(requests[0].hostname, '127.0.0.1')
  assert.equal(requests[0].port, 3090)
})

test('history query preserves workflow and active filters; missing run is null', async t => {
  const { store, requests } = await fixture(t, (input, response) => {
    if (input.path.includes('id=')) { response.statusCode = 404; response.end('{"error":"run_not_found"}') }
    else response.end('{"runs":[]}')
  })
  assert.deepEqual(await store.list({ workflowId: 'sample', activeOnly: true }), [])
  assert.equal(requests[0].path, '/api/canvas-workflow-runs?workflow=sample&active=1')
  assert.equal(await store.get(randomUUID()), null)
})

test('CAS conflict never becomes a successful local fallback or leaks server bodies', async t => {
  const { store } = await fixture(t, (_input, response) => {
    response.statusCode = 409
    response.end('{"error":"revision_conflict","private":"server-only-value"}')
  })
  await assert.rejects(store.get(randomUUID()), error => error.code === 'revision_conflict'
    && error.status === 409 && !String(error).includes('server-only-value'))
})

test('missing pairing and invalid run identity fail before any HTTP request', async () => {
  let calls = 0
  const request = () => { calls++; throw new Error('must not contact upstream') }
  const unpaired = createPostgresWorkflowRunStore({ webServer, nativeBridgeKey: '', request })
  await assert.rejects(unpaired.get(randomUUID()), { code: 'native_bridge_unavailable' })
  const paired = createPostgresWorkflowRunStore({ webServer, nativeBridgeKey: bridgeKey, request })
  await assert.rejects(paired.get('../private'), { code: 'invalid_run_id' })
  await assert.rejects(paired.list({ workflowId: '../private' }), { code: 'invalid_workflow_id' })
  assert.equal(calls, 0)
})

test('run snapshots above existing business tool limit are accepted within the explicit snapshot limit', async t => {
  const id = randomUUID()
  const snapshot = { id, workflowId: 'sample', revision: 1, status: 'done', output: 'a'.repeat(1100 * 1024) }
  const { store } = await fixture(t, (_input, response) => response.end(JSON.stringify({ snapshot })))
  assert.equal((await store.get(id)).output.length, snapshot.output.length)
})

const isolatedHost = { protocol: 'http:', host: '127.0.0.1', port: 33188, getOrigin: () => 'http://127.0.0.1:33188' }
const isolatedPair = { host: '127.0.0.1', port: 33188 }

test('default authority still rejects isolated loopback and ignores per-call pairing input', async t => {
  const { store, requests } = await fixture(t, (_input, response) => response.end('{"runs":[]}'), { webServer: isolatedHost })
  await assert.rejects(store.list({ pairedHost: isolatedPair }), { code: 'trusted_business_authority_unavailable' })
  assert.equal(requests.length, 0)
})

test('explicit isolated pairing sends canonical Host/Origin to existing loopback Django destination', async t => {
  const { store, requests } = await fixture(t, (_input, response) => response.end('{"runs":[]}'), {
    webServer: isolatedHost, pairedHost: isolatedPair, port: 33190, cookie: 'untrusted-cookie',
  })
  assert.deepEqual(await store.list(), [])
  assert.equal(requests.length, 1)
  const request = requests[0]
  assert.equal(request.hostname, '127.0.0.1')
  assert.equal(request.port, 33190)
  assert.equal(request.headers.host, '127.0.0.1:33188')
  assert.equal(request.headers.origin, 'http://127.0.0.1:33188')
  assert.equal(request.headers.cookie, undefined)
  assert.equal(request.headers['x-csrftoken'], undefined)
  assert.equal(request.headers['x-tradeloom-native-bridge'], bridgeKey)
})

test('explicit pairing rejects every authority mismatch before requesting', async t => {
  const cases = [
    { webServer: { ...isolatedHost, protocol: 'https:' } },
    { webServer: { ...isolatedHost, host: '192.168.1.23' } },
    { webServer: { ...isolatedHost, port: 33189 } },
    { webServer: { ...isolatedHost, port: '33188' } },
    { webServer: { ...isolatedHost, getOrigin: () => 'http://127.0.0.1:33189' } },
    { webServer: { ...isolatedHost, getOrigin: () => 'http://192.168.1.23:33188' } },
    ...['/', '/path', '?q=1', '#fragment'].map(part => ({ webServer: { ...isolatedHost, getOrigin: () => `http://127.0.0.1:33188${part}` } })),
    { webServer: { ...isolatedHost, getOrigin: () => 'http://user:pass@127.0.0.1:33188' } },
    { webServer: { ...isolatedHost, getOrigin: () => ' http://127.0.0.1:33188' } },
    { webServer: { ...isolatedHost, getOrigin: () => undefined } },
    { webServer: { ...isolatedHost, getOrigin: () => { throw new Error(bridgeKey) } } },
    ...['8.8.8.8', '0.0.0.0', 'localhost', '127.0.0.2', '::1', '169.254.1.1', '172.32.0.1', '192.169.1.1'].map(host => ({
      pairedHost: { host, port: 33188 }, webServer: { protocol: 'http:', host, port: 33188, getOrigin: () => `http://${host}:33188` },
    })),
    ...[0, 65536, -1, 33188.5, '33188', NaN].map(port => ({ pairedHost: { host: '127.0.0.1', port } })),
  ]
  for (const [index, change] of cases.entries()) {
    await t.test(`invalid authority ${index + 1}`, async () => {
      const { store, requests } = await fixture(t, (_input, response) => response.end('{"runs":[]}'), {
        webServer: isolatedHost, pairedHost: isolatedPair, ...change,
      })
      await assert.rejects(store.list(), error => error.code === 'trusted_business_authority_unavailable' && !String(error).includes(bridgeKey))
      assert.equal(requests.length, 0)
    })
  }
})

test('explicit private IPv4 pairing and canonical default port remain allowed without widening network target', async t => {
  for (const [host, port] of [['10.1.2.3', 80], ['172.16.0.1', 33188], ['172.31.255.254', 65535], ['192.168.2.3', 1]]) {
    const origin = new URL(`http://${host}:${port}`).origin
    const { store, requests } = await fixture(t, (_input, response) => response.end('{"runs":[]}'), {
      webServer: { protocol: 'http:', host, port, getOrigin: () => origin }, pairedHost: { host, port }, port: 33190,
    })
    assert.deepEqual(await store.list(), [])
    assert.equal(requests[0].headers.host, `${host}:${port}`)
    assert.equal(requests[0].headers.origin, origin)
    assert.equal(requests[0].hostname, '127.0.0.1')
    assert.equal(requests[0].port, 33190)
  }
})

test('snapshot size and CAS guards still reject before requesting', async t => {
  const { store, requests } = await fixture(t, (_input, response) => response.end('{}'))
  const snapshot = { id: randomUUID(), revision: 1 }
  await assert.rejects(store.save(snapshot, 1), { code: 'invalid_revision' })
  await assert.rejects(store.save({ ...snapshot, output: 'x'.repeat(2 * 1024 * 1024) }, 0), { code: 'snapshot_too_large' })
  assert.equal(requests.length, 0)
})
