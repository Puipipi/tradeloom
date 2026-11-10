import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { Readable } from 'node:stream'
import test from 'node:test'
import { createListenerIdentityHandler, LISTENER_IDENTITY_ROUTE } from '@tradeloom/dsh-business-shell/listener-identity'

function response() {
  const emitter = new EventEmitter()
  return Object.assign(emitter, {
    statusCode: 200,
    headers: {},
    writableEnded: false,
    destroyed: false,
    setHeader(key, value) { this.headers[key.toLowerCase()] = value },
    end(body = '') { this.body = String(body); this.writableEnded = true },
  })
}

function request(method = 'GET', url = LISTENER_IDENTITY_ROUTE) {
  const req = Readable.from([])
  req.method = method
  req.url = url
  req.headers = {}
  req.aborted = false
  return req
}

async function invoke(handler, method, url) {
  const res = response()
  await handler.handle(request(method, url), res)
  return { status: res.statusCode, headers: res.headers, body: res.body ? JSON.parse(res.body) : null }
}

function context(rejection = undefined) {
  return {
    connection: { requestRejection: () => rejection },
    webServer: { protocol: 'http:', host: '127.0.0.1', port: 3088, getOrigin: () => 'http://127.0.0.1:3088' },
  }
}

test('listener identity route uses only trusted port and preserves paired auth status', async () => {
  const ctx = context()
  const calls = []
  const handler = createListenerIdentityHandler(ctx, {
    port: 43121,
    collectListenerIdentity: async options => {
      calls.push(options)
      return {
        listener: {
          status: 'observed', port: 43121, addresses: ['127.0.0.1'], candidatePids: [17], pid: 17,
          executablePath: 'C:\\owned\\listener.exe', createdAt: '2026-10-31T00:00:00.000Z',
          sha256: 'a'.repeat(64), fileVersion: '1.2.3', productVersion: '1.2.3', errorCode: null,
        },
        firewall: { status: 'observed', rules: [], errorCode: null },
      }
    },
  })
  const result = await invoke(handler, 'GET')
  assert.equal(result.status, 200)
  assert.equal(result.body.listener.port, 43121)
  assert.equal(calls.length, 1)
  assert.deepEqual(Object.keys(calls[0]).sort(), ['port', 'signal'])
  assert.equal((await invoke(handler, 'GET', `${LISTENER_IDENTITY_ROUTE}?pid=17`)).status, 400)
  ctx.connection.requestRejection = () => 401
  assert.equal((await invoke(handler, 'GET')).status, 401)
  handler.dispose()
})

test('listener identity route rejects methods, bad trusted ports, unsafe collector data and service replacement', async () => {
  assert.throws(() => createListenerIdentityHandler(context(), { port: 0 }), /invalid listener port/)
  const methodHandler = createListenerIdentityHandler(context(), { port: 43122, collectListenerIdentity: async () => { throw new Error('must not run') } })
  assert.equal((await invoke(methodHandler, 'POST')).status, 405)
  methodHandler.dispose()

  const bad = createListenerIdentityHandler(context(), {
    port: 43122,
    collectListenerIdentity: async () => ({ listener: { status: 'observed', pid: 3, commandLine: 'secret' }, firewall: { status: 'observed', rules: [] } }),
  })
  const invalid = await invoke(bad, 'GET')
  assert.equal(invalid.status, 503)
  assert.equal(invalid.body.error.code, 'listener_identity_unavailable')
  bad.dispose()

  const ctx = context()
  let finish
  const pending = createListenerIdentityHandler(ctx, {
    port: 43123,
    collectListenerIdentity: () => new Promise(resolve => { finish = resolve }),
  })
  const result = invoke(pending, 'GET')
  await new Promise(resolve => setImmediate(resolve))
  ctx.webServer = { ...ctx.webServer }
  finish({ listener: { status: 'not_listening', port: 43123, addresses: [], candidatePids: [], pid: null, executablePath: null, createdAt: null, sha256: null, fileVersion: null, productVersion: null, errorCode: null }, firewall: { status: 'not_checked', rules: [], errorCode: null } })
  const replaced = await result
  assert.equal(replaced.status, 503)
  assert.equal(replaced.body.error.code, 'host_unavailable')
  pending.dispose()
})

test('collector distinguishes stable observation states without leaking raw process data', async () => {
  const observations = [
    [{ listener: { status: 'not_listening', port: 43124, addresses: [], candidatePids: [], pid: null, executablePath: null, createdAt: null, sha256: null, fileVersion: null, productVersion: null, errorCode: null }, firewall: { status: 'not_checked', rules: [], errorCode: null } }, 'not_listening'],
    [{ listener: { status: 'ambiguous', port: 43124, addresses: ['127.0.0.1', '::1'], candidatePids: [7, 8], pid: null, executablePath: null, createdAt: null, sha256: null, fileVersion: null, productVersion: null, errorCode: 'multiple_owners' }, firewall: { status: 'not_checked', rules: [], errorCode: null } }, 'ambiguous'],
    [{ listener: { status: 'unknown', port: 43124, addresses: [], candidatePids: [], pid: null, executablePath: null, createdAt: null, sha256: null, fileVersion: null, productVersion: null, errorCode: 'identity_changed' }, firewall: { status: 'unknown', rules: [], errorCode: 'identity_changed' } }, 'unknown'],
  ]
  for (const [dto, status] of observations) {
    const handler = createListenerIdentityHandler(context(), { port: 43124, collectListenerIdentity: async () => dto })
    const result = await invoke(handler, 'GET')
    assert.equal(result.status, 200)
    assert.equal(result.body.listener.status, status)
    assert.equal(JSON.stringify(result.body).includes('commandLine'), false)
    handler.dispose()
  }
})

test('real Windows collector identifies only this test-owned loopback listener', { skip: process.platform !== 'win32' }, async t => {
  const { createServer } = await import('node:net')
  const { createHash } = await import('node:crypto')
  const { readFile } = await import('node:fs/promises')
  const { collectWindowsListenerIdentity } = await import('@tradeloom/dsh-business-shell/listener-identity')
  const server = createServer()
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  let listening = true
  t.after(async () => { if (listening) await new Promise(resolve => server.close(resolve)) })
  const address = server.address()
  assert.ok(address && typeof address === 'object')
  const handler = createListenerIdentityHandler(context(), { port: address.port })
  const response = await invoke(handler, 'GET')
  handler.dispose()
  assert.equal(response.status, 200)
  const result = response.body
  assert.equal(result.listener.status, 'observed')
  assert.equal(result.listener.port, address.port)
  assert.equal(result.listener.pid, process.pid)
  assert.ok(result.listener.addresses.includes('127.0.0.1'))
  assert.equal(result.listener.executablePath.toLowerCase(), process.execPath.toLowerCase())
  assert.equal(result.listener.sha256, createHash('sha256').update(await readFile(process.execPath)).digest('hex'))
  assert.ok(Number.isFinite(Date.parse(result.listener.createdAt)))
  assert.equal(result.firewall.status === 'observed' || result.firewall.status === 'unknown', true)
  if (result.firewall.status === 'unknown') assert.equal(result.firewall.errorCode, 'firewall_query_failed')
  t.diagnostic(JSON.stringify({
    listener: {
      status: result.listener.status,
      port: result.listener.port,
      address: result.listener.addresses[0],
      pid: result.listener.pid,
      executablePath: result.listener.executablePath,
      createdAt: result.listener.createdAt,
      sha256: result.listener.sha256,
      fileVersion: result.listener.fileVersion,
      productVersion: result.listener.productVersion,
    },
    firewall: { status: result.firewall.status, ruleCount: result.firewall.rules.length, errorCode: result.firewall.errorCode },
  }))
  await new Promise(resolve => server.close(resolve))
  listening = false
  const closed = await collectWindowsListenerIdentity({ port: address.port })
  assert.equal(closed.listener.status, 'not_listening')
  assert.equal(closed.listener.errorCode, null)
  assert.equal(closed.firewall.status, 'not_checked')
})

test('owned Windows helper cancellation and timeout wait for child close and keep typed outcomes', { skip: process.platform !== 'win32' }, async t => {
  const { createServer } = await import('node:net')
  const { collectWindowsListenerIdentity } = await import('@tradeloom/dsh-business-shell/listener-identity')
  const server = createServer()
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  t.after(async () => await new Promise(resolve => server.close(resolve)))
  const port = server.address().port
  const controller = new AbortController()
  const cancelled = collectWindowsListenerIdentity({ port, signal: controller.signal })
  const cancelTimer = setTimeout(() => controller.abort(), 100)
  await assert.rejects(cancelled, error => error.code === 'listener_identity_cancelled')
  clearTimeout(cancelTimer)
  await assert.rejects(
    collectWindowsListenerIdentity({ port, timeoutMs: 1 }),
    error => error.code === 'listener_identity_timeout',
  )
})
