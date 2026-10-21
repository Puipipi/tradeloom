import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { createServer, request as httpRequest } from 'node:http'
import test from 'node:test'
import { apply, createBusinessProxyHandler, BUSINESS_PROXY_ROUTES } from '../proxy.js'

function send(server, options, body = '') {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port: server.address().port, ...options }, res => {
      const chunks = []
      res.on('data', chunk => chunks.push(chunk))
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }))
    })
    req.on('error', reject)
    req.end(body)
  })
}

function sendChunks(server, options, chunks) {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port: server.address().port, ...options }, res => {
      const received = []
      res.on('data', chunk => received.push(chunk))
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(received) }))
    })
    req.on('error', reject)
    for (const chunk of chunks) req.write(chunk)
    req.end()
  })
}

test('business proxy registers only four fixed prefixes and leaves native DSH API routes alone', async t => {
  const registrations = []
  apply({
    connection: { requestRejection: () => undefined },
    webServer: { register(route) { registrations.push(route); return () => {} } },
    effect(install) { install() },
  })
  assert.deepEqual(registrations.map(route => [route.kind, route.path]), BUSINESS_PROXY_ROUTES.map(({ path }) => ['prefix', path]))
  assert.deepEqual(BUSINESS_PROXY_ROUTES.map(({ path }) => path), ['/business', '/business-api', '/business-static', '/business-media'])
  assert.equal(BUSINESS_PROXY_ROUTES.some(route => route.path === '/api' || route.path === '/connect'), false)
})

test('registered prefixes match the pinned DSH WebServer contract', { skip: !process.env.TRADELOOM_DSH_WEBSERVER_LIBRARY }, async () => {
  const library = process.env.TRADELOOM_DSH_WEBSERVER_LIBRARY.replaceAll('\\', '/')
  const { WebServer } = await import(new URL(`file:///${library}`))
  const registrations = []
  apply({
    connection: { requestRejection: () => undefined },
    webServer: { register(route) { registrations.push(route); return () => {} } },
    effect(install) { install() },
  })
  const prefixTable = new Map(registrations.map(route => [route.path, route]))
  const match = pathname => WebServer.prototype.match.call({ exact: new Map(), prefixes: prefixTable }, pathname)
  for (const root of ['/business', '/business-api', '/business-static', '/business-media']) {
    assert.ok(match(root), `official WebServer did not match exact prefix ${root}`)
    assert.ok(match(`${root}/nested/path`), `official WebServer did not match child path ${root}`)
  }
  assert.equal(match('/business-extra'), undefined)
  assert.equal(match('/api/remote.mux'), undefined)
  assert.equal(match('/connect'), undefined)
})

test('four aliases stream request and response bytes, preserve download headers, and translate redirects', async t => {
  const upstreamRequests = []
  const upstream = createServer((req, res) => {
    upstreamRequests.push({ method: req.method, url: req.url, headers: req.headers })
    const chunks = []
    req.on('data', chunk => chunks.push(chunk))
    req.on('end', () => {
      if (req.url.startsWith('/uploads/')) {
        res.writeHead(206, {
          'content-type': 'application/octet-stream',
          'content-disposition': 'attachment; filename="sample.bin"',
          'content-range': 'bytes 0-3/8',
          etag: 'W/"sample-v1"',
          'set-cookie': ['csrftoken=django-token; Path=/; SameSite=Lax', 'sessionid=must-not-escape; Path=/'],
        })
        res.write(Buffer.from([0, 1]))
        res.end(Buffer.from([2, 3]))
      } else if (req.url === '/home?tab=one') {
        res.writeHead(302, { location: '/workflow-tasks/wf-1?from=home' })
        res.end()
      } else {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ url: req.url, body: Buffer.concat(chunks).toString('base64') }))
      }
    })
  })
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise(resolve => upstream.close(resolve)))

  const routes = []
  const ctx = { connection: { requestRejection: req => req.headers.cookie?.includes('dsh=ok') ? undefined : 401 } }
  apply({ ...ctx, webServer: { register(route) { routes.push(route); return () => {} } }, effect(install) { install() } }, { upstreamPort: upstream.address().port })
  const dsh = createServer((req, res) => {
    const pathname = new URL(req.url, 'http://dsh.invalid').pathname
    const route = routes.find(item => pathname === item.path || pathname.startsWith(`${item.path}/`))
    if (!route) { res.statusCode = 404; res.end('native'); return }
    route.handler(req, res)
  })
  await new Promise(resolve => dsh.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise(resolve => dsh.close(resolve)))

  const cases = [
    ['/business/home?tab=one', '/home?tab=one'],
    ['/business-api/workflow-tasks?limit=2', '/api/workflow-tasks?limit=2'],
    ['/business-static/workbench/app.js?v=3', '/static/workbench/app.js?v=3'],
    ['/business-media/private/report.bin?download=1', '/uploads/private/report.bin?download=1'],
  ]
  const page = await send(dsh, { path: cases[0][0], headers: { cookie: 'dsh=ok' } })
  assert.equal(page.status, 302)
  assert.equal(page.headers.location, '/business/workflow-tasks/wf-1?from=home')
  for (const [alias] of cases.slice(1, 3)) {
    const result = await send(dsh, { path: alias, headers: { cookie: 'dsh=ok' } })
    assert.equal(result.status, 200)
  }
  const payload = Buffer.from('multipart-boundary-and-bytes')
  const upload = await send(dsh, {
    path: '/business-api/workflow-tasks/wf-1/reviews/r-1/image?mode=replace', method: 'POST',
    headers: { host: '127.0.0.1:3088', cookie: 'dsh=ok; csrftoken=csrf-secret', origin: 'http://127.0.0.1:3088', 'x-csrftoken': 'csrf-secret', 'x-forwarded-proto': 'https', 'content-type': 'multipart/form-data; boundary=----test', 'content-length': String(payload.length) },
  }, payload)
  assert.equal(upload.status, 200)
  assert.deepEqual(JSON.parse(upload.body), { url: '/api/workflow-tasks/wf-1/reviews/r-1/image?mode=replace', body: payload.toString('base64') })
  const post = upstreamRequests.at(-1)
  assert.equal(post.headers.host, '127.0.0.1:3088')
  assert.equal(post.headers.origin, 'http://127.0.0.1:3088')
  assert.equal(post.headers['x-forwarded-proto'], 'http')
  assert.equal(post.headers.cookie, 'csrftoken=csrf-secret')

  const download = await send(dsh, { path: cases[3][0], headers: { cookie: 'dsh=ok; csrftoken=csrf-secret', range: 'bytes=0-3', 'if-none-match': 'W/"sample-v1"' } })
  assert.equal(download.status, 206)
  assert.deepEqual(download.body, Buffer.from([0, 1, 2, 3]))
  assert.equal(download.headers['content-disposition'], 'attachment; filename="sample.bin"')
  assert.equal(download.headers['content-range'], 'bytes 0-3/8')
  assert.equal(download.headers.etag, 'W/"sample-v1"')
  assert.deepEqual(download.headers['set-cookie'], ['csrftoken=django-token; Path=/; SameSite=Lax'])

  const native = await send(dsh, { path: '/api/remote.mux', headers: { cookie: 'dsh=ok' } })
  assert.equal(native.body.toString(), 'native')
  const lookalike = await send(dsh, { path: '/business-extra/home', headers: { cookie: 'dsh=ok' } })
  assert.equal(lookalike.body.toString(), 'native')
  const exactAlias = await send(dsh, { path: '/business-api?check=exact', headers: { cookie: 'dsh=ok' } })
  assert.equal(exactAlias.status, 200)
  assert.equal(JSON.parse(exactAlias.body).url, '/api/?check=exact')
})

test('unauthorized requests stop before body consumption or upstream access', async () => {
  let consumed = false
  let upstreamCalls = 0
  const ctx = { connection: { requestRejection: () => 403 } }
  const handler = createBusinessProxyHandler(ctx, 'business-api', { upstreamPort: 9, request: () => { upstreamCalls++; throw new Error('must not connect') } })
  const req = { method: 'POST', url: '/business-api/workflow-tasks', headers: {}, pipe() { consumed = true } }
  const res = { headers: {}, setHeader(name, value) { this.headers[name] = value }, end() { this.ended = true } }
  await handler(req, res)
  assert.equal(res.statusCode, 403)
  assert.equal(res.ended, true)
  assert.equal(consumed, false)
  assert.equal(upstreamCalls, 0)
})

test('streamed JSON requests get a precise Content-Length before reaching Django', async t => {
  const expectedBody = Buffer.from(JSON.stringify({ name: '涤纶（演示验收）' }), 'utf8')
  const received = []
  const upstream = createServer((req, res) => {
    const chunks = []
    req.on('data', chunk => chunks.push(chunk))
    req.on('end', () => {
      received.push({ headers: req.headers, body: Buffer.concat(chunks) })
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end('{}')
    })
  })
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise(resolve => upstream.close(resolve)))

  const ctx = { connection: { requestRejection: () => undefined } }
  const handler = createBusinessProxyHandler(ctx, 'business-api', { upstreamPort: upstream.address().port })
  const dsh = createServer(handler)
  await new Promise(resolve => dsh.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise(resolve => dsh.close(resolve)))

  for (const method of ['POST', 'PATCH']) {
    const response = await sendChunks(dsh, { path: '/business-api/products/p-1', method, headers: { 'content-type': 'application/json; charset=utf-8' } }, [expectedBody.subarray(0, 8), expectedBody.subarray(8)])
    assert.equal(response.status, 200)
    assert.equal(received.at(-1).headers['content-length'], String(expectedBody.length))
    assert.equal(received.at(-1).headers['transfer-encoding'], undefined)
    assert.deepEqual(received.at(-1).body, expectedBody)

    const structuredJson = await sendChunks(dsh, { path: '/business-api/products/p-1', method, headers: { 'content-type': 'application/problem+json' } }, [expectedBody])
    assert.equal(structuredJson.status, 200)
    assert.equal(received.at(-1).headers['content-length'], String(expectedBody.length))
    assert.deepEqual(received.at(-1).body, expectedBody)
  }
})

test('oversized JSON is rejected before upstream and chunked multipart stays streaming', async t => {
  const upstreamRequests = []
  const upstream = createServer((req, res) => {
    const chunks = []
    req.on('data', chunk => chunks.push(chunk))
    req.on('end', () => {
      upstreamRequests.push({ headers: req.headers, body: Buffer.concat(chunks) })
      res.writeHead(200)
      res.end('ok')
    })
  })
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise(resolve => upstream.close(resolve)))
  const handler = createBusinessProxyHandler({ connection: { requestRejection: () => undefined } }, 'business-api', { upstreamPort: upstream.address().port })
  const dsh = createServer(handler)
  await new Promise(resolve => dsh.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise(resolve => dsh.close(resolve)))

  const tooLarge = await sendChunks(dsh, { path: '/business-api/products/p-1', method: 'PATCH', headers: { 'content-type': 'application/json' } }, [Buffer.alloc(2_621_441, 0x61)])
  assert.equal(tooLarge.status, 413)
  assert.equal(upstreamRequests.length, 0)

  const multipartBody = Buffer.from('----boundary\r\nname="file"\r\n\r\nplain fixture\r\n----boundary--', 'utf8')
  const multipart = await sendChunks(dsh, { path: '/business-api/products/p-1/image', method: 'POST', headers: { 'content-type': 'multipart/form-data; boundary=fixture' } }, [multipartBody.subarray(0, 10), multipartBody.subarray(10)])
  assert.equal(multipart.status, 200)
  assert.equal(upstreamRequests[0].headers['content-length'], undefined)
  assert.equal(upstreamRequests[0].headers['transfer-encoding'], 'chunked')
  assert.deepEqual(upstreamRequests[0].body, multipartBody)
})

test('aborted streamed JSON is not forwarded partially', async () => {
  const request = new EventEmitter()
  Object.assign(request, { method: 'PATCH', url: '/business-api/products/p-1', headers: { 'content-type': 'application/json' }, socket: {} })
  const response = { headersSent: false, destroyed: false, setHeader() {}, end() { this.ended = true } }
  let upstreamCalls = 0
  const handler = createBusinessProxyHandler({ connection: { requestRejection: () => undefined } }, 'business-api', { request() { upstreamCalls++; throw new Error('must not forward partial JSON') } })
  handler(request, response)
  request.emit('data', Buffer.from('{"name":'))
  request.emit('aborted')
  assert.equal(upstreamCalls, 0)
  assert.equal(response.statusCode, 400)
  assert.equal(response.ended, true)
})
