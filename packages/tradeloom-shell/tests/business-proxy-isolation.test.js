import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import http from 'node:http'
import { createBusinessProxyHandler, BUSINESS_PROXY_ROUTES } from '../proxy.js'
import { apply as applyHost } from '../host.js'

function response() {
  return Object.assign(new EventEmitter(), { headers: {}, setHeader(k, v) { this.headers[k] = v }, end(body) { this.body = body; this.writableEnded = true } })
}
const ctx = rejection => ({ connection: { requestRejection: () => rejection } })
for (const route of BUSINESS_PROXY_ROUTES) for (const method of ['GET', 'POST']) {
  test(`disabled ${route.alias} ${method} returns explicit 503 without body or upstream access`, () => {
    let calls = 0
    const handler = createBusinessProxyHandler(ctx(), route.alias, { businessProxyEnabled: false, request() { calls++; throw new Error('network forbidden') } })
    const req = { method, url: route.path, headers: { 'content-type': 'application/json' }, on() { assert.fail('body must not be consumed') }, pipe() { assert.fail('body must not be piped') } }
    const res = response(); handler(req, res)
    assert.equal(res.statusCode, 503); assert.equal(res.headers['cache-control'], 'no-store'); assert.equal(calls, 0)
    if (route.alias === 'business') {
      assert.match(res.headers['content-type'], /text\/html/); assert.match(res.body, /业务服务未连接/); assert.match(res.body, /当前为隔离测试模式/)
      assert.doesNotMatch(res.body, /<script|https?:|src=|href=/i)
    } else assert.equal(JSON.parse(res.body).error, 'business_proxy_disabled')
  })
}
for (const rejection of [401, 403]) test(`disabled proxy preserves auth ${rejection} first`, () => {
  const handler = createBusinessProxyHandler(ctx(rejection), 'business', { businessProxyEnabled: false, request() { assert.fail('network') } })
  const res = response(); handler({}, res); assert.equal(res.statusCode, rejection); assert.equal(res.body, undefined)
})
test('default and explicit true preserve environment port priority and 3090 fallback', () => {
  const previous = process.env.TRADELOOM_DJANGO_PORT
  try {
    for (const enabled of [undefined, true]) for (const configured of [undefined, '33190']) {
      if (configured === undefined) delete process.env.TRADELOOM_DJANGO_PORT; else process.env.TRADELOOM_DJANGO_PORT = configured
      let options
      const handler = createBusinessProxyHandler(ctx(), 'business', { ...(enabled === undefined ? {} : { businessProxyEnabled: enabled }), request(value) { options = value; return Object.assign(new EventEmitter(), { end() {} }) } })
      handler({ method: 'GET', url: '/business', headers: {}, socket: {}, pipe(stream) { stream.end() } }, response())
      assert.equal(options.port, configured === undefined ? 3090 : 33190); assert.equal(options.hostname, '127.0.0.1')
    }
  } finally { if (previous === undefined) delete process.env.TRADELOOM_DJANGO_PORT; else process.env.TRADELOOM_DJANGO_PORT = previous }
})
test('invalid boolean is a fixed configuration error before any Host side effect', () => {
  for (const value of ['false', 0, null, {}, []]) {
    assert.throws(() => createBusinessProxyHandler(ctx(), 'business', { businessProxyEnabled: value }), /^TypeError: invalid_business_proxy_config$/)
    assert.throws(() => applyHost({}, { businessProxyEnabled: value }), /^TypeError: invalid_business_proxy_config$/)
  }
})
test('Host passes explicit false to all four registered proxies', () => {
  const routes = []
  const original = http.request
  http.request = () => { assert.fail('Host disabled proxy must not request upstream') }
  try {
  applyHost({ ...ctx(), tools: {}, agents: {}, workspaceRegistry: {}, sessionController: {},
    on() {}, effect(install) { install() }, webServer: { register(route) { routes.push(route); return () => {} } } }, { businessProxyEnabled: false })
  const proxies = routes.filter(route => route.kind === 'prefix')
  assert.equal(proxies.length, 4)
  for (const route of proxies) { const res = response(); route.handler({ method: 'GET' }, res); assert.equal(res.statusCode, 503) }
  } finally { http.request = original }
})
