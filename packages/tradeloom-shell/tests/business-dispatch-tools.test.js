import assert from 'node:assert/strict'
import http from 'node:http'
import { once } from 'node:events'
import test from 'node:test'
import { registerBusinessTools } from '../business-tools.js'
import { ROLE_PRESETS } from '../roles.js'

const key = 'a'.repeat(64)

async function fixture() {
  const received = []
  const id = 'd'.repeat(32)
  const dto = (status, kind, body = {}) => ({
    id, kind, status,
    sender: body.actor ?? { agent_id: 'center-agent', session_id: 'center-session', agent_preset: ROLE_PRESETS.center },
    recipient: body.recipient ?? { agent_id: 'product-agent', session_id: 'product-session', agent_preset: ROLE_PRESETS.product },
    source: body.source ?? 'workflow:demo', requirement: body.requirement ?? 'Review.',
    delivery_result: { state: status }, receipt: null,
    created_at: '2026-10-30T00:00:00+00:00', updated_at: '2026-10-30T00:00:00+00:00',
    claimed_at: null, closed_at: null,
  })
  const server = http.createServer((request, response) => {
    const chunks = []
    request.on('data', chunk => chunks.push(chunk))
    request.on('end', () => {
      if (request.method === 'GET' && request.url === '/') {
        response.writeHead(200, { 'set-cookie': ['csrftoken=fixture-token; Path=/'] })
        response.end('ok')
        return
      }
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      received.push({ method: request.method, path: request.url, body, bridgeKey: request.headers['x-tradeloom-native-bridge'] })
      response.writeHead(200, { 'content-type': 'application/json' })
      if (request.url === '/api/dispatches') {
        response.end(JSON.stringify({ dispatch: dto('queued', body.kind, body), replayed: false }))
      } else if (request.url === '/api/dispatches/inbox') {
        response.end(JSON.stringify({ items: [], view: body.view, has_more: false, next_offset: null }))
      } else if (request.url.endsWith('/claim')) {
        response.end(JSON.stringify({ result: 'claimed', dispatch: dto('claimed', 'action'), replayed: false }))
      } else if (request.url.endsWith('/receipt')) {
        response.end(JSON.stringify({ dispatch: dto(body.status, 'action'), replayed: false }))
      } else {
        response.writeHead(404)
        response.end('{}')
      }
    })
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const target = {
    id: 'product-agent',
    session: { id: 'product-session', header: { agentPreset: ROLE_PRESETS.product } },
  }
  const registered = new Map()
  const ctx = {
    webServer: {},
    agents: { get: id => id === target.id ? target : undefined },
    tools: { register(definition) { registered.set(definition.name, definition); return () => registered.delete(definition.name) } },
  }
  const dispose = registerBusinessTools(ctx, { preset: ROLE_PRESETS.center }, {
    port: server.address().port,
    nativeBridgeKey: key,
    authorityResolver: () => ({ hostHeader: '192.168.10.2:3088', origin: 'http://192.168.10.2:3088' }),
  })
  const exec = {
    agent: { id: 'center-agent', session: { id: 'center-session', header: {
      agentPreset: ROLE_PRESETS.center, parentSession: null, delegationDepth: 0,
    } } },
  }
  return { ctx, registered, received, exec, target, server, dispose, id }
}

test('dispatch tools inject sender identity from the real execute context and resolve live recipient', async t => {
  const f = await fixture()
  t.after(async () => { f.dispose(); await new Promise(resolve => f.server.close(resolve)) })

  const create = f.registered.get('tradeloom_dispatch_create')
  assert.ok(create)
  assert.equal(create.parameters.additionalProperties, false)
  assert.deepEqual(create.parameters.required, ['idempotency_key', 'kind', 'recipient_agent_id', 'source', 'requirement'])
  assert.equal(f.registered.get('tradeloom_dispatch_list').parameters.additionalProperties, false)
  assert.deepEqual(f.registered.get('tradeloom_dispatch_list').parameters.required, ['view'])
  assert.deepEqual(f.registered.get('tradeloom_dispatch_claim').parameters.required, ['dispatch_id'])
  assert.deepEqual(f.registered.get('tradeloom_dispatch_receipt').parameters.required, ['dispatch_id', 'status', 'result'])
  const result = await create.execute({
    idempotency_key: 'key-1', kind: 'action', recipient_agent_id: 'product-agent',
    source: 'workflow:demo', requirement: 'Review the saved draft.',
  }, f.exec)
  assert.equal(result.ok, true, result.error_code)
  assert.deepEqual(f.received[0].body.actor, {
    agent_id: 'center-agent', session_id: 'center-session', agent_preset: ROLE_PRESETS.center,
  })
  assert.deepEqual(f.received[0].body.recipient, {
    agent_id: 'product-agent', session_id: 'product-session', agent_preset: ROLE_PRESETS.product,
  })
  assert.equal(f.received[0].bridgeKey, key)
  assert.equal(f.received[0].path, '/api/dispatches')
})

test('dispatch tools reject sender spoof fields, unknown recipients, and missing session identity', async t => {
  const f = await fixture()
  t.after(async () => { f.dispose(); await new Promise(resolve => f.server.close(resolve)) })
  const create = f.registered.get('tradeloom_dispatch_create')

  const extra = await create.execute({
    idempotency_key: 'key-1', kind: 'action', recipient_agent_id: 'product-agent',
    source: 'workflow:demo', requirement: 'Review.', sender_session_id: 'spoofed',
  }, f.exec)
  assert.equal(extra.error_code, 'invalid_arguments')
  const unknown = await create.execute({
    idempotency_key: 'key-1', kind: 'action', recipient_agent_id: 'missing-agent',
    source: 'workflow:demo', requirement: 'Review.',
  }, f.exec)
  assert.equal(unknown.error_code, 'dispatch_recipient_unavailable')
  const noSession = await create.execute({
    idempotency_key: 'key-1', kind: 'action', recipient_agent_id: 'product-agent',
    source: 'workflow:demo', requirement: 'Review.',
  }, { agent: { id: 'center-agent', session: { header: f.exec.agent.session.header } } })
  assert.equal(noSession.error_code, 'host_identity_unavailable')
  assert.equal(f.received.length, 0)
})

test('list, claim, and receipt tools use fixed routes and execute-context identity', async t => {
  const f = await fixture()
  t.after(async () => { f.dispose(); await new Promise(resolve => f.server.close(resolve)) })
  const list = f.registered.get('tradeloom_dispatch_list')
  const claim = f.registered.get('tradeloom_dispatch_claim')
  const receipt = f.registered.get('tradeloom_dispatch_receipt')
  assert.ok(list && claim && receipt)

  const listResult = await list.execute({ view: 'inbox' }, f.exec)
  assert.equal(listResult.ok, true, listResult.error_code)
  const claimResult = await claim.execute({ dispatch_id: f.id }, f.exec)
  assert.equal(claimResult.ok, true, claimResult.error_code)
  const receiptResult = await receipt.execute({ dispatch_id: f.id, status: 'completed', result: 'Done.' }, f.exec)
  assert.equal(receiptResult.ok, true, receiptResult.error_code)
  assert.deepEqual(f.received.map(item => item.path), [
    '/api/dispatches/inbox', `/api/dispatches/${f.id}/claim`, `/api/dispatches/${f.id}/receipt`,
  ])
  assert.ok(f.received.every(item => item.body.actor.session_id === 'center-session'))
})
