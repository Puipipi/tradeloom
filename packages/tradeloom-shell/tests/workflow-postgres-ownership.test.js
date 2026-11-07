import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import test from 'node:test'

import { createPostgresWorkflowRunStore } from '../workflow-postgres.js'

const host = Object.freeze({
  protocol: 'http:',
  host: '127.0.0.1',
  port: 3088,
  getOrigin: () => 'http://127.0.0.1:3088',
})
const pairedHost = Object.freeze({ host: '127.0.0.1', port: 3088 })
const bridgeKey = 'a'.repeat(64)
const namespaceId = 'e2d18490-5985-4c42-bcf5-0fdbeb234679'
const runId = '6c018cca-af98-4d63-9960-3ef29f3b4e7b'
const ownerId = 'a7a00e35-aad0-44b2-95c5-342c622836c7'
const token = Buffer.alloc(32, 1).toString('base64url')

function transport(responseValue, status = 200) {
  const requests = []
  const request = (options, callback) => {
    const req = new EventEmitter()
    let payload = ''
    req.write = chunk => { payload += chunk.toString('utf8') }
    req.end = () => {
      requests.push({ ...options, body: payload ? JSON.parse(payload) : undefined })
      const response = new EventEmitter()
      response.statusCode = status
      response.headers = {}
      callback(response)
      queueMicrotask(() => {
        response.emit('data', Buffer.from(JSON.stringify(responseValue), 'utf8'))
        response.emit('end')
      })
      return response
    }
    req.destroy = error => { if (error) queueMicrotask(() => req.emit('error', error)) }
    return req
  }
  return { request, requests }
}

function storeWith(responseValue, status) {
  const network = transport(responseValue, status)
  return {
    network,
    store: createPostgresWorkflowRunStore({
      webServer: host,
      pairedHost,
      nativeBridgeKey: bridgeKey,
      request: network.request,
    }),
  }
}

test('fetches the server namespace through paired authenticated GET and validates protocol metadata', async () => {
  const cursor = 'signed-cursor-fixture'
  const { store, network } = storeWith({
    protocol: 'canvas-run-owner/v1',
    namespaceId,
    leaseTtlMs: 120000,
    renewAfterMs: 40000,
    maxDomainEnvelopeBytes: 2097152,
    maxResponseBytes: 2113536,
    recoveryCursor: cursor,
  })

  const descriptor = await store.getOwnershipNamespace()

  assert.equal(descriptor.namespaceId, namespaceId)
  assert.equal(descriptor.recoveryCursor, cursor)
  assert.equal(network.requests.length, 1)
  assert.equal(network.requests[0].method, 'GET')
  assert.equal(network.requests[0].path, '/api/canvas-workflow-runs?action=owner_namespace')
  assert.equal(network.requests[0].headers['x-tradeloom-native-bridge'], bridgeKey)
})

test('createOwned sends the frozen run identity and never trusts a caller fingerprint', async () => {
  const snapshot = {
    id: runId,
    workflowId: 'test-flow',
    revision: 1,
    status: 'running',
    executionMode: 'native_dsh',
    title: 'synthetic',
    nodes: {},
    document: { id: 'test-flow', version: 1, nodes: [] },
  }
  const { store, network } = storeWith({
    protocol: 'canvas-run-owner/v1', namespaceId, runId, ownerId, ownerEpoch: '1',
    leaseExpiresAt: '2026-11-07T00:02:00Z', snapshot, alreadyAdvanced: false,
  }, 201)

  const response = await store.createOwned({ namespaceId, runId, ownerId, ownerToken: token, snapshot })

  assert.equal(response.ownerEpoch, '1')
  assert.equal(network.requests[0].method, 'POST')
  assert.equal(network.requests[0].body.action, 'create_owned')
  assert.equal(network.requests[0].body.protocol, 'canvas-run-owner/v1')
  assert.equal(network.requests[0].body.ownerToken, token)
  assert.equal(Object.hasOwn(network.requests[0].body, 'initialFingerprint'), false)
  assert.equal(JSON.stringify(response).includes(token), false)
})
