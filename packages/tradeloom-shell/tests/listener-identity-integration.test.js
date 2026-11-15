import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { readFile } from 'node:fs/promises'
import { apply as applyBusinessShell } from '../host.js'
import { createListenerIdentityHandler, registerListenerIdentityRoute } from '../listener-identity.js'

const LISTENER_ROUTE = '/tradeloom/diagnostics/listener-identity'

function makeContext({ port = undefined, rejection = 403, registrationFailure = null, disposerFailure = null } = {}) {
  const routes = new Map()
  const providers = new Map()
  const cleanups = []
  const disposerCalls = new Map()
  const effectRoutes = new Map()
  let currentEffectLabel
  const webServer = {
    port,
    register(route) {
      if (route.path === LISTENER_ROUTE && registrationFailure) throw registrationFailure
      routes.set(route.path, route)
        if (currentEffectLabel) {
          const paths = effectRoutes.get(currentEffectLabel) ?? []
          paths.push(route.path)
          effectRoutes.set(currentEffectLabel, paths)
        }
      let active = true
      return () => {
        if (!active) return
        active = false
        disposerCalls.set(route.path, (disposerCalls.get(route.path) ?? 0) + 1)
        if (route.path === LISTENER_ROUTE && disposerFailure) throw disposerFailure
        if (routes.get(route.path) === route) routes.delete(route.path)
      }
    },
  }
  const ctx = {
    connection: { requestRejection: () => rejection },
    webServer,
    workspaceRegistry: { archivedSessionIds: [], get: () => null },
    sessionController: {},
    sessionQuery: {},
    tools: { register: () => () => {} },
    agents: {},
    provide(name, value) { providers.set(name, value) },
    get(name) { return providers.get(name) },
    on: () => () => {},
    effect(callback, label) {
      const priorLabel = currentEffectLabel
      currentEffectLabel = label
      let cleanup
      try { cleanup = callback() } finally { currentEffectLabel = priorLabel }
      if (typeof cleanup === 'function') cleanups.push({ label, cleanup })
      return () => {}
    },
  }
  return { ctx, routes, cleanups, disposerCalls, effectRoutes }
}

function makeRequest(url = LISTENER_ROUTE, method = 'GET') {
  return Object.assign(new EventEmitter(), { url, method, aborted: false })
}

function makeResponse() {
  const res = Object.assign(new EventEmitter(), { destroyed: false, writableEnded: false, headers: {} })
  res.setHeader = (name, value) => { res.headers[name] = value }
  res.end = body => { res.body = body; res.writableEnded = true }
  return res
}

async function responseOf(handler, req = makeRequest()) {
  const res = makeResponse()
  await handler(req, res)
  return res
}

function observedNotListening(port) {
  return {
    listener: {
      status: 'not_listening', port, addresses: [], candidatePids: [], pid: null,
      executablePath: null, createdAt: null, sha256: null, fileVersion: null,
      productVersion: null, errorCode: null,
    },
    firewall: { status: 'not_checked', rules: [], errorCode: null },
  }
}

test('Host apply registers the exact read-only listener identity route', () => {
  const fixture = makeContext()
  applyBusinessShell(fixture.ctx)

  const route = fixture.routes.get(LISTENER_ROUTE)
  assert.ok(route, 'Host apply must register the listener identity endpoint')
  assert.equal(route.kind, 'exact')
  assert.equal(typeof route.handler, 'function')
})

test('Host route waits for a valid port, rejects changed services, and can bind in a new effect', async () => {
  const fixture = makeContext()
  applyBusinessShell(fixture.ctx)
  const route = fixture.routes.get(LISTENER_ROUTE)
  assert.ok(route)

  let res = await responseOf(route.handler)
  assert.equal(res.statusCode, 503)
  assert.equal(JSON.parse(res.body).error.code, 'host_unavailable')

  for (const invalidPort of [0, 65536, '3088']) {
    fixture.ctx.webServer.port = invalidPort
    res = await responseOf(route.handler)
    assert.equal(res.statusCode, 503)
    assert.equal(JSON.parse(res.body).error.code, 'host_unavailable')
  }

  fixture.ctx.webServer.port = 3088
  res = await responseOf(route.handler)
  assert.equal(res.statusCode, 403)
  assert.equal(JSON.parse(res.body).error.code, 'forbidden')

  fixture.ctx.webServer.port = 3089
  res = await responseOf(route.handler)
  assert.equal(res.statusCode, 503)
  assert.equal(JSON.parse(res.body).error.code, 'host_unavailable')

  fixture.ctx.webServer = { ...fixture.ctx.webServer, port: 3088 }
  res = await responseOf(route.handler)
  assert.equal(res.statusCode, 503)

  fixture.ctx.webServer = fixture.ctx.webServer
  fixture.ctx.webServer.port = 3088
  fixture.ctx.connection = { requestRejection: () => 403 }
  res = await responseOf(route.handler)
  assert.equal(res.statusCode, 503)

  const effectCleanup = fixture.cleanups.find(item => item.label === 'tradeloom-shell: protected session and profile routes')?.cleanup
  assert.equal(typeof effectCleanup, 'function')
  await effectCleanup()
  await effectCleanup()
  assert.equal(fixture.disposerCalls.get(LISTENER_ROUTE), 1)
  assert.equal(fixture.routes.has(LISTENER_ROUTE), false)

  const next = makeContext({ port: 3090 })
  applyBusinessShell(next.ctx)
  const nextRoute = next.routes.get(LISTENER_ROUTE)
  assert.ok(nextRoute)
  res = await responseOf(nextRoute.handler)
  assert.equal(res.statusCode, 403)
  const nextCleanup = next.cleanups.find(item => item.label === 'tradeloom-shell: protected session and profile routes')?.cleanup
  await nextCleanup()
})

test('Host preserves the exact webServer registration error', () => {
  const registrationFailure = new Error('fixed test registration failure')
  const fixture = makeContext({ registrationFailure })
  assert.throws(() => applyBusinessShell(fixture.ctx), error => error === registrationFailure)
})

test('Host stale route callback cannot create a handler after effect cleanup', async () => {
  const fixture = makeContext()
  applyBusinessShell(fixture.ctx)
  const route = fixture.routes.get(LISTENER_ROUTE)
  const cleanup = fixture.cleanups.find(item => item.label === 'tradeloom-shell: protected session and profile routes')?.cleanup
  assert.ok(route)
  await cleanup()

  fixture.ctx.webServer.port = 3088
  const res = await responseOf(route.handler)
  assert.equal(res.statusCode, 503)
  assert.equal(JSON.parse(res.body).error.code, 'host_unavailable')
})

test('Host accepts a replacement Cordis wrapper with the same original webServer identity', async () => {
  const fixture = makeContext()
  const originalService = {}
  fixture.ctx.webServer[Symbol.for('cordis.original')] = originalService
  applyBusinessShell(fixture.ctx)
  const route = fixture.routes.get(LISTENER_ROUTE)
  assert.ok(route)

  fixture.ctx.webServer.port = 3088
  let res = await responseOf(route.handler)
  assert.equal(res.statusCode, 403)

  fixture.ctx.webServer = { port: 3088, [Symbol.for('cordis.original')]: originalService }
  res = await responseOf(route.handler)
  assert.equal(res.statusCode, 403)

  fixture.ctx.webServer = { port: 3088, [Symbol.for('cordis.original')]: {} }
  res = await responseOf(route.handler)
  assert.equal(res.statusCode, 503)
  const cleanup = fixture.cleanups.find(item => item.label === 'tradeloom-shell: protected session and profile routes')?.cleanup
  await cleanup()
})

test('Host preserves route-unregister error while disposing the listener handler', async () => {
  const unregisterFailure = new Error('fixed test unregister failure')
  const fixture = makeContext({ port: 3088, disposerFailure: unregisterFailure })
  applyBusinessShell(fixture.ctx)
  const route = fixture.routes.get(LISTENER_ROUTE)
  const hostEffectLabel = 'tradeloom-shell: protected session and profile routes'
  const oldRoutePaths = (fixture.effectRoutes.get(hostEffectLabel) ?? []).filter(path => path !== LISTENER_ROUTE).slice(0, 2)
  const cleanup = fixture.cleanups.find(item => item.label === hostEffectLabel)?.cleanup
  assert.ok(route)
  assert.equal(oldRoutePaths.length, 2)
  let res = await responseOf(route.handler)
  assert.equal(res.statusCode, 403)

  await assert.rejects(cleanup(), error => error === unregisterFailure)
  for (const path of oldRoutePaths) {
    assert.equal(fixture.disposerCalls.get(path), 1)
    assert.equal(fixture.routes.has(path), false)
  }
  res = await responseOf(route.handler)
  assert.equal(res.statusCode, 503)
  assert.equal(JSON.parse(res.body).error.code, 'host_unavailable')
  assert.equal(fixture.disposerCalls.get(LISTENER_ROUTE), 1)
})

test('registered route waits for actual handler disposal after unregister throws', async () => {
  const unregisterFailure = new Error('fixed test unregister failure')
  let unregisterCalls = 0
  let resolveCollector
  let collectorSignal
  let abortEvents = 0
  const ctx = {
    connection: { requestRejection: () => undefined },
    webServer: {
      port: 3088,
      register({ path }) {
        assert.equal(path, LISTENER_ROUTE)
        return () => { unregisterCalls += 1; throw unregisterFailure }
      },
    },
  }
  const route = registerListenerIdentityRoute(ctx, {
    createHandler: (actualContext, { port }) => createListenerIdentityHandler(actualContext, {
      port,
      collectListenerIdentity: ({ signal }) => {
        collectorSignal = signal
        signal.addEventListener('abort', () => { abortEvents += 1 }, { once: true })
        return new Promise(resolve => { resolveCollector = resolve })
      },
    }),
  })

  const req = makeRequest()
  const res = makeResponse()
  const request = route.handle(req, res)
  assert.equal(typeof resolveCollector, 'function')
  let cleanupSettled = false
  const cleanup = route.dispose().catch(error => { cleanupSettled = true; throw error })
  assert.equal(collectorSignal.aborted, true)
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(cleanupSettled, false)
  assert.equal(unregisterCalls, 1)

  resolveCollector(observedNotListening(3088))
  await request
  await assert.rejects(cleanup, error => error === unregisterFailure)
  assert.equal(cleanupSettled, true)
  assert.equal(abortEvents, 1)
  assert.equal(res.writableEnded, false)
  await assert.rejects(route.dispose(), error => error === unregisterFailure)
  assert.equal(unregisterCalls, 1)
})

test('listener handler preserves paired authority, exact GET, and validated payload behavior', async () => {
  let rejection
  let collectCalls = 0
  const ctx = {
    connection: { requestRejection: () => rejection },
    webServer: { port: 3088 },
  }
  const handler = createListenerIdentityHandler(ctx, {
    port: 3088,
    collectListenerIdentity: async ({ port }) => {
      collectCalls += 1
      return observedNotListening(port)
    },
  })

  let res = await responseOf(handler.handle, makeRequest('/wrong'))
  assert.equal(res.statusCode, 400)
  res = await responseOf(handler.handle, makeRequest(LISTENER_ROUTE, 'POST'))
  assert.equal(res.statusCode, 405)
  assert.equal(res.headers.allow, 'GET')
  rejection = 403
  res = await responseOf(handler.handle)
  assert.equal(res.statusCode, 403)
  assert.equal(collectCalls, 0)

  rejection = undefined
  res = await responseOf(handler.handle)
  assert.equal(res.statusCode, 200)
  assert.deepEqual(JSON.parse(res.body), { ok: true, ...observedNotListening(3088) })
  assert.equal(collectCalls, 1)
  await handler.dispose()
})

test('listener handler rechecks paired authority after the collector resolves', async () => {
  let rejection
  let checks = 0
  let resolveCollector
  const ctx = {
    connection: { requestRejection: () => { checks += 1; return rejection } },
    webServer: { port: 3088 },
  }
  const handler = createListenerIdentityHandler(ctx, {
    port: 3088,
    collectListenerIdentity: () => new Promise(resolve => { resolveCollector = resolve }),
  })
  const req = makeRequest()
  const res = makeResponse()
  const request = handler.handle(req, res)
  assert.equal(checks, 1)
  rejection = 401
  resolveCollector(observedNotListening(3088))
  await request
  assert.equal(checks, 2)
  assert.equal(res.statusCode, 401)
  assert.equal(JSON.parse(res.body).error.code, 'forbidden')
  await handler.dispose()
})

test('listener handler rejects a service replacement while collection is pending', async () => {
  for (const replace of ['connection', 'webServer']) {
    const ctx = {
      connection: { requestRejection: () => undefined },
      webServer: { port: 3088 },
    }
    let resolveCollector
    const handler = createListenerIdentityHandler(ctx, {
      port: 3088,
      collectListenerIdentity: () => new Promise(resolve => { resolveCollector = resolve }),
    })
    const req = makeRequest()
    const res = makeResponse()
    const request = handler.handle(req, res)
    ctx[replace] = replace === 'connection'
      ? { requestRejection: () => undefined }
      : { port: 3088 }
    resolveCollector(observedNotListening(3088))
    await request
    assert.equal(res.statusCode, 503)
    assert.equal(JSON.parse(res.body).error.code, 'host_unavailable')
    await handler.dispose()
  }
})

test('listener handler rejects a port change on the same webServer while collection is pending', async () => {
  const ctx = {
    connection: { requestRejection: () => undefined },
    webServer: { port: 3088 },
  }
  let resolveCollector
  const handler = createListenerIdentityHandler(ctx, {
    port: 3088,
    collectListenerIdentity: () => new Promise(resolve => { resolveCollector = resolve }),
  })
  const req = makeRequest()
  const res = makeResponse()
  const request = handler.handle(req, res)
  ctx.webServer.port = 3089
  resolveCollector(observedNotListening(3088))
  await request
  assert.equal(res.statusCode, 503)
  assert.equal(JSON.parse(res.body).error.code, 'host_unavailable')
  assert.equal(res.body.includes('not_listening'), false)
  await handler.dispose()
})

test('listener disposal aborts and awaits an in-flight collector exactly once', async () => {
  const req = makeRequest()
  const res = makeResponse()
  let resolveCollector
  let collectorSignal
  let abortEvents = 0
  const handler = createListenerIdentityHandler({
    connection: { requestRejection: () => undefined },
    webServer: { port: 3088 },
  }, {
    port: 3088,
    collectListenerIdentity: ({ signal }) => {
      collectorSignal = signal
      signal.addEventListener('abort', () => { abortEvents += 1 }, { once: true })
      return new Promise(resolve => { resolveCollector = resolve })
    },
  })

  const request = handler.handle(req, res)
  assert.equal(typeof resolveCollector, 'function')
  const dispose = handler.dispose()
  assert.equal(collectorSignal.aborted, true)
  let disposeFinished = false
  dispose.then(() => { disposeFinished = true })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(disposeFinished, false)

  resolveCollector(observedNotListening(3088))
  await request
  await dispose
  await handler.dispose()
  assert.equal(disposeFinished, true)
  assert.equal(abortEvents, 1)
  assert.equal(res.writableEnded, false)
})

test('request abort and response close cancel the injected collector without a real process', async () => {
  for (const closeRequest of [
    ({ req }) => req.emit('aborted'),
    ({ res }) => res.emit('close'),
  ]) {
    const req = makeRequest()
    const res = makeResponse()
    let resolveCollector
    let collectorSignal
    const handler = createListenerIdentityHandler({
      connection: { requestRejection: () => undefined },
      webServer: { port: 3088 },
    }, {
      port: 3088,
      collectListenerIdentity: ({ signal }) => {
        collectorSignal = signal
        return new Promise(resolve => { resolveCollector = resolve })
      },
    })
    const request = handler.handle(req, res)
    closeRequest({ req, res })
    assert.equal(collectorSignal.aborted, true)
    resolveCollector(observedNotListening(3088))
    await request
    await handler.dispose()
    assert.equal(res.writableEnded, false)
  }
})

test('listener maps timeout and malformed collector output to bounded responses', async () => {
  const ctx = { connection: { requestRejection: () => undefined }, webServer: { port: 3088 } }
  const timeout = Object.assign(new Error('fixture'), { code: 'listener_identity_timeout' })
  const timeoutHandler = createListenerIdentityHandler(ctx, {
    port: 3088,
    collectListenerIdentity: async () => { throw timeout },
  })
  let res = await responseOf(timeoutHandler.handle)
  assert.equal(res.statusCode, 504)
  assert.equal(JSON.parse(res.body).error.code, 'listener_identity_timeout')
  await timeoutHandler.dispose()

  const invalidHandler = createListenerIdentityHandler(ctx, {
    port: 3088,
    collectListenerIdentity: async () => ({ listener: {}, firewall: {} }),
  })
  res = await responseOf(invalidHandler.handle)
  assert.equal(res.statusCode, 503)
  assert.equal(JSON.parse(res.body).error.code, 'listener_identity_unavailable')
  await invalidHandler.dispose()
})

test('package payload and subpath export include both listener source files', async () => {
  const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
  assert.equal(manifest.exports['./listener-identity'], './listener-identity.js')
  assert.ok(manifest.files.includes('listener-identity.js'))
  assert.ok(manifest.files.includes('listener-identity.ps1'))
})
