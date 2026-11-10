import test from 'node:test'
import assert from 'node:assert/strict'
import { createToolSchemasHandler, registerToolSchemas, TOOL_SCHEMAS_ROUTE } from '../tool-schemas.js'

const globalTool = { name: 'global', description: 'description', parameters: { type: 'object', properties: { x: { type: 'string', enum: ['a'] } } }, deferLoading: true, execute() {} }
function call(ctx, { method = 'GET', url = TOOL_SCHEMAS_ROUTE } = {}) {
  const res = { headers: {}, setHeader(k, v) { this.headers[k] = v }, end(body) { this.body = body } }
  createToolSchemasHandler(ctx)({ method, url }, res)
  return res
}
function context(schemas = () => [globalTool], rejection) { return { connection: { requestRejection: () => rejection }, tools: { schemas } } }
test('global catalog uses no scope and preserves schema only', () => {
  let args
  const res = call(context((...a) => { args = a; return a.length ? [{ name: 'role' }] : [globalTool] }))
  assert.deepEqual(args, []); assert.equal(res.statusCode, 200)
  assert.deepEqual(JSON.parse(res.body), { scope: 'global', tools: [{ name: 'global', description: 'description', parameters: globalTool.parameters, deferLoading: true }] })
  assert.equal(res.headers['cache-control'], 'no-store')
})
test('admission and request validation never call catalog', () => {
  let calls = 0; const schemas = () => { calls++; return [] }
  for (const code of [401, 403]) { const res = call(context(schemas, code)); assert.equal(res.statusCode, code); assert.equal(res.headers['cache-control'], 'no-store') }
  const method = call(context(schemas), { method: 'POST' }); assert.equal(method.statusCode, 405); assert.equal(method.headers.allow, 'GET'); assert.equal(method.headers['cache-control'], 'no-store')
  assert.equal(call(context(schemas), { url: TOOL_SCHEMAS_ROUTE + '?role=x' }).statusCode, 400)
  assert.equal(call(context(schemas), { url: TOOL_SCHEMAS_ROUTE + '?' }).statusCode, 400)
  assert.equal(calls, 0)
})
test('empty and large catalogs stay complete', () => {
  assert.deepEqual(JSON.parse(call(context(() => [])).body), { scope: 'global', tools: [] })
  const tools = Array.from({ length: 250 }, (_, i) => ({ name: String(i) + 'n'.repeat(200), description: 'd'.repeat(700), parameters: { type: 'object', properties: { nested: { type: 'array', items: { enum: ['a', 'b'] } } } } }))
  const result = JSON.parse(call(context(() => tools)).body); assert.deepEqual(result.tools, tools); assert.ok(!('deferLoading' in result.tools[0]))
})
test('unavailable and unserializable catalogs fail safely', () => {
  const circular = {}; circular.self = circular
  for (const ctx of [context(() => { throw Error('secret/path') }), { connection: { requestRejection() {} } }, context(() => [{ name: 'x', description: '', parameters: circular }]), context(() => [{ name: 'x', description: '', parameters: { x: 1n } }])]) {
    const res = call(ctx); assert.equal(res.statusCode, 503); assert.deepEqual(JSON.parse(res.body), { error: 'tool-schemas-unavailable' }); assert.ok(!res.body.includes('secret'))
  }
})
test('registers exact route and returns disposer', () => {
  let route; const dispose = () => {}; const ctx = context(); ctx.webServer = { register(value) { route = value; return dispose } }
  assert.equal(registerToolSchemas(ctx), dispose); assert.equal(route.kind, 'exact'); assert.equal(route.path, TOOL_SCHEMAS_ROUTE); const res = { headers: {}, setHeader(k, v) { this.headers[k] = v }, end(body) { this.body = body } }; route.handler({ method: 'GET', url: TOOL_SCHEMAS_ROUTE }, res); assert.equal(res.statusCode, 200); assert.equal(JSON.parse(res.body).tools[0].name, 'global')
})
