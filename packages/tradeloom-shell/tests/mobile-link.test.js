import assert from 'node:assert/strict'
import test from 'node:test'
import { apply, createMobileLinkHandler } from '../host.js'

function response() {
  return {
    headers: {}, statusCode: 200, body: '',
    setHeader(name, value) { this.headers[name.toLowerCase()] = value },
    end(value = '') { this.body = value },
  }
}

function context(overrides = {}) {
  const calls = { authenticated: [], rejected: 0 }
  return {
    calls,
    connection: {
      requestRejection() { calls.rejected++; return undefined },
      authenticatedUrl(origin) { calls.authenticated.push(origin); return `${origin}/?auth=FIXTURE_ONLY` },
    },
    webServer: { protocol: 'http:', host: '192.168.1.23', port: 3088, ...overrides.webServer },
  }
}

function request(method = 'GET', headers = {}) {
  return { method, headers, resume() { this.resumed = true } }
}

test('native request guard rejects before authenticatedUrl is called', async () => {
  const ctx = context()
  ctx.connection.requestRejection = () => 401
  const res = response()
  await createMobileLinkHandler(ctx)(request(), res)
  assert.equal(res.statusCode, 401)
  assert.equal(ctx.calls.authenticated.length, 0)
})

test('link uses configured private bind host, ignores request Host, and returns a no-store root launch URL', async () => {
  const ctx = context()
  const res = response()
  await createMobileLinkHandler(ctx)(request('GET', { host: 'attacker.example:3088' }), res)
  assert.equal(ctx.calls.authenticated[0], 'http://192.168.1.23:3088')
  assert.deepEqual(JSON.parse(res.body), { url: 'http://192.168.1.23:3088/?auth=FIXTURE_ONLY' })
  assert.equal(new URL(JSON.parse(res.body).url).pathname, '/')
  assert.notEqual(new URL(JSON.parse(res.body).url).pathname, '/connect')
  assert.equal(res.headers['cache-control'], 'no-store')
})

test('non-private or non-mobile bind configuration returns a fixed error without minting a link', async () => {
  for (const webServer of [
    { host: '8.8.8.8' },
    { host: '192.168.1.23', port: 3090 },
    { host: '0.0.0.0' },
  ]) {
    const ctx = context({ webServer })
    const res = response()
    await createMobileLinkHandler(ctx)(request(), res)
    assert.equal(res.statusCode, 503)
    assert.deepEqual(JSON.parse(res.body), { error: 'mobile-link-unavailable' })
    assert.equal(ctx.calls.authenticated.length, 0)
  }
})

test('apply registers and disposes the exact protected mobile-link endpoint', () => {
  const routes = []
  let dispose
  apply({
    tools: {}, agents: { get() { return undefined } },
    on() {},
    connection: { requestRejection() { return undefined } },
    webServer: { register(route) { routes.push(route); return () => { route.disposed = true } } },
    effect(install) { dispose = install() },
  })
  const route = routes.find(item => item.path === '/tradeloom/mobile-link')
  assert.deepEqual([route.kind, route.path], ['exact', '/tradeloom/mobile-link'])
  dispose()
  assert.equal(route.disposed, true)
})
