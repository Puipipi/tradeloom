import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import test from 'node:test'
import { createAgentCapabilitiesHandler } from '../capabilities.js'
import { registerBusinessTools } from '../business-tools.js'

function req(url = '/tradeloom/agent-capabilities?role=product', method = 'GET') {
  const request = Readable.from([])
  request.url = url
  request.method = method
  return request
}

function res() {
  return {
    headers: {}, statusCode: 200, body: '',
    setHeader(name, value) { this.headers[name] = value },
    end(value = '') { this.body = value },
  }
}

function context({ state, agent, skills, presets, schemas = [], rejected } = {}) {
  const calls = { rejection: 0, state: 0, getAgent: [], schemas: [], skillSnapshot: [], inventory: 0 }
  const ctx = {
    connection: { requestRejection() { calls.rejection++; return rejected } },
    agents: { get(id) { calls.getAgent.push(id); return agent } },
    tools: { schemas(scope) { calls.schemas.push(scope); return schemas } },
    get(name) {
      if (name === 'skills') return skills
      if (name === 'agentPresets') return presets
      return undefined
    },
  }
  return {
    calls,
    ctx,
    dependencies: { createStateStore: async () => ({ read: async () => { calls.state++; return state } }) },
  }
}

test('capability route authenticates before state access and rejects arbitrary session selectors', async () => {
  const setup = context({ rejected: 401 })
  const handler = createAgentCapabilitiesHandler(setup.ctx, setup.dependencies)
  const denied = res()
  await handler(req(), denied)
  assert.equal(denied.statusCode, 401)
  assert.equal(setup.calls.state, 0)

  const open = context({ state: { roles: {} } })
  const openHandler = createAgentCapabilitiesHandler(open.ctx, open.dependencies)
  const arbitrary = res()
  await openHandler(req('/tradeloom/agent-capabilities?role=product&sessionId=attacker'), arbitrary)
  assert.equal(arbitrary.statusCode, 400)
  assert.equal(JSON.parse(arbitrary.body).error, 'invalid-query')
  assert.equal(open.calls.state, 0)
})

test('unknown role and unbound role never look up or resume a client-selected session', async () => {
  const setup = context({ state: { roles: {} } })
  const handler = createAgentCapabilitiesHandler(setup.ctx, setup.dependencies)
  for (const role of ['other', 'constructor', 'toString', '__proto__']) {
    const unknown = res()
    await handler(req(`/tradeloom/agent-capabilities?role=${encodeURIComponent(role)}`), unknown)
    assert.equal(unknown.statusCode, 400)
  }
  const unbound = res()
  await handler(req(), unbound)
  assert.equal(unbound.statusCode, 200)
  const body = JSON.parse(unbound.body)
  assert.equal(body.status, 'not_bound')
  assert.equal(body.tools, null)
  assert.equal(body.skills, null)
  assert.equal(setup.calls.getAgent.length, 0)
  assert.equal(setup.calls.schemas.length, 0)
})

test('only the matching live Agent and live preset are projected and scoped tools/skills are redacted', async () => {
  let resumeCalls = 0
  const live = { id: 'session-product', ctx: { marker: 'product-context' }, session: { id: 'session-product', header: { cwd: '/secret/workspace' } }, resume() { resumeCalls++ } }
  const skills = {
    async snapshot(options) {
      setup.calls.skillSnapshot.push(options)
      return { complete: true, skills: [{
        name: 'safe-skill', description: 'A safe summary', path: '/secret/path', whenToUse: 'private',
        source: 'project-dsh', invocation: { modelInvocable: true, userInvocable: false },
        resourceBase: '/secret/resource', metadata: { token: 'secret' },
      }] }
    },
  }
  const presets = { composedPreset(agentContext) {
    assert.equal(agentContext, live.ctx)
    return 'tradeloom-product'
  }, async compositionInventory() {
    setup.calls.inventory++
    return [{ id: 'tradeloom-product', rows: [
      { moduleName: '@deepseek-ai/dsh-mcp-client', enabled: true },
      { moduleName: 'private-plugin', enabled: true },
    ] }]
  } }
  const setup = context({
    state: { roles: { product: { sessionId: 'session-product', agentPreset: 'tradeloom-product' } } },
    agent: live, skills, presets,
    schemas: [{ name: 'read_products', description: 'ignored detail', parameters: { type: 'object' } }, { name: 'mcp__demo__search', description: 'ignored' }],
  })
  const handler = createAgentCapabilitiesHandler(setup.ctx, setup.dependencies)
  const response = res()
  await handler(req(), response)
  assert.equal(response.statusCode, 200)
  assert.equal(response.headers['cache-control'], 'no-store')
  const body = JSON.parse(response.body)
  assert.equal(body.status, 'ready')
  assert.deepEqual(body.tools.items, [{ name: 'read_products' }, { name: 'mcp__demo__search' }])
  assert.equal(body.tools.truncated, false)
  assert.deepEqual(body.skills.items, [{
    name: 'safe-skill', description: 'A safe summary', source: 'project-dsh',
    invocation: { modelInvocable: true, userInvocable: false },
  }])
  assert.equal(body.skills.complete, true)
  assert.equal(body.mcp.status, 'visible_tool')
  assert.deepEqual(body.mcp.visibleTools, ['mcp__demo__search'])
  assert.deepEqual(setup.calls.getAgent, ['session-product'])
  assert.equal(resumeCalls, 0, 'capability reads use the live Agent and never resume a session')
  assert.deepEqual(setup.calls.schemas, [live])
  assert.deepEqual(setup.calls.skillSnapshot, [{ scope: live, cwd: '/secret/workspace' }])
  assert.equal(setup.calls.inventory, 1)
  const serialized = JSON.stringify(body)
  for (const forbidden of ['session-product', '/secret', 'whenToUse', 'resourceBase', 'metadata', 'private-plugin', 'token']) {
    assert.equal(serialized.includes(forbidden), false, `response omits ${forbidden}`)
  }
})

test('preset mismatch, stale live session and unavailable optional services fail closed', async () => {
  const cases = [
    { state: { roles: { product: { sessionId: 's', agentPreset: 'tradeloom-center' } } }, agent: { id: 's', session: { id: 's' } }, expected: 'not_bound' },
    { state: { roles: { product: { sessionId: 's', agentPreset: 'tradeloom-product' } } }, agent: { id: 'other', session: { id: 'other' } }, expected: 'not_bound' },
    { state: { roles: { product: { sessionId: 's', agentPreset: 'tradeloom-product' } } }, agent: { id: 's', session: { id: 'other' } }, expected: 'not_bound' },
  ]
  for (const item of cases) {
    const setup = context(item)
    const response = res()
    await createAgentCapabilitiesHandler(setup.ctx, setup.dependencies)(req(), response)
    assert.equal(JSON.parse(response.body).status, item.expected)
    assert.deepEqual(setup.calls.schemas, [])
  }

  const live = { id: 's', session: { id: 's', header: { cwd: '/safe' } } }
  const unavailable = context({
    state: { roles: { product: { sessionId: 's', agentPreset: 'tradeloom-product' } } }, agent: live,
    schemas: [], skills: undefined, presets: { composedPreset: () => 'tradeloom-product' },
  })
  const response = res()
  await createAgentCapabilitiesHandler(unavailable.ctx, unavailable.dependencies)(req(), response)
  const body = JSON.parse(response.body)
  assert.equal(body.status, 'ready')
  assert.equal(body.skills.status, 'unavailable')
  assert.equal(body.skills.items, null)
  assert.equal(body.mcp.status, 'unavailable')
  assert.equal(body.mcp.visibleTools, null)
})

test('live preset mismatch fails closed and unbound MCP declaration stays distinct from session capability', async () => {
  const live = { id: 's', session: { id: 's', header: { cwd: '/safe' } }, ctx: { marker: 'live-context' } }
  let composedContext
  const presets = {
    composedPreset(ctx) { composedContext = ctx; return 'tradeloom-center' },
    async compositionInventory() {
      return [{ id: 'tradeloom-product', rows: [{ moduleName: '@deepseek-ai/dsh-mcp-client', enabled: true }] }]
    },
  }
  const setup = context({
    state: { roles: { product: { sessionId: 's', agentPreset: 'tradeloom-product' } } },
    agent: live, presets, schemas: [{ name: 'mcp__other-role__search' }],
  })
  const response = res()
  await createAgentCapabilitiesHandler(setup.ctx, setup.dependencies)(req(), response)
  const body = JSON.parse(response.body)
  assert.equal(composedContext, live.ctx, 'the authoritative live preset check receives the live Agent Context')
  assert.equal(body.status, 'not_bound', 'a session whose preset changed cannot be labelled as the stored role')
  assert.equal(body.tools, null)
  assert.equal(body.skills, null)
  assert.deepEqual(body.mcp, { status: 'declared_only', visibleTools: null })
  assert.deepEqual(setup.calls.schemas, [], 'mismatched live scope tools are never projected')

  const noBinding = context({
    state: { roles: {} },
    presets,
  })
  const unboundResponse = res()
  await createAgentCapabilitiesHandler(noBinding.ctx, noBinding.dependencies)(req(), unboundResponse)
  const unboundBody = JSON.parse(unboundResponse.body)
  assert.equal(unboundBody.status, 'not_bound')
  assert.deepEqual(unboundBody.mcp, { status: 'declared_only', visibleTools: null })
  assert.equal(unboundBody.tools, null)
  assert.equal(unboundBody.skills, null)
})

test('the existing per-agent capability view discovers intake tools from the registered product preset', async () => {
  const live = { id: 'session-product', session: { id: 'session-product', header: { cwd: '/safe' } }, ctx: {} }
  const definitions = new Map()
  const webServer = { protocol: 'http:', host: '192.168.1.23', port: 3088, getOrigin: () => 'http://192.168.1.23:3088' }
  registerBusinessTools({
    webServer,
    tools: { register(definition) { definitions.set(definition.name, definition); return () => definitions.delete(definition.name) } },
  }, { preset: 'tradeloom-product' })
  const setup = context({
    state: { roles: { product: { sessionId: live.id, agentPreset: 'tradeloom-product' } } },
    agent: live,
    presets: { composedPreset: () => 'tradeloom-product', async compositionInventory() { return [] } },
  })
  setup.ctx.tools.schemas = scope => {
    setup.calls.schemas.push(scope)
    return [...definitions.values()]
  }
  const response = res()
  await createAgentCapabilitiesHandler(setup.ctx, setup.dependencies)(req(), response)
  const body = JSON.parse(response.body)
  assert.equal(body.status, 'ready')
  assert.ok(body.tools.items.some(item => item.name === 'tradeloom_intake_sources'))
  assert.ok(body.tools.items.some(item => item.name === 'tradeloom_intake_candidate'))
  assert.deepEqual(setup.calls.schemas, [live])
})

test('capability visibility discovers the execution plan reader only from center or delivery tool schemas', async () => {
  const live = { id: 'session-delivery', session: { id: 'session-delivery', header: { cwd: '/safe' } }, ctx: {} }
  const definitions = new Map()
  registerBusinessTools({
    webServer: { protocol: 'http:', host: '192.168.1.23', port: 3088, getOrigin: () => 'http://192.168.1.23:3088' },
    tools: { register(definition) { definitions.set(definition.name, definition); return () => definitions.delete(definition.name) } },
  }, { preset: 'tradeloom-delivery' })
  const setup = context({
    state: { roles: { delivery: { sessionId: live.id, agentPreset: 'tradeloom-delivery' } } },
    agent: live,
    presets: { composedPreset: () => 'tradeloom-delivery', async compositionInventory() { return [] } },
  })
  setup.ctx.tools.schemas = scope => { setup.calls.schemas.push(scope); return [...definitions.values()] }
  const response = res()
  await createAgentCapabilitiesHandler(setup.ctx, setup.dependencies)(req('/tradeloom/agent-capabilities?role=delivery'), response)
  const body = JSON.parse(response.body)
  assert.ok(body.tools.items.some(item => item.name === 'tradeloom_read_execution_plan'))
  assert.deepEqual(setup.calls.schemas, [live])
})

test('bounded capability summaries mark truncation without hiding visible MCP tools', async () => {
  const live = { id: 'session-product', session: { id: 'session-product', header: { cwd: '/safe' } } }
  const setup = context({
    state: { roles: { product: { sessionId: 'session-product', agentPreset: 'tradeloom-product' } } },
    agent: live, presets: { composedPreset: () => 'tradeloom-product' },
    schemas: [...Array.from({ length: 205 }, (_, index) => ({ name: `tool_${index}` })), { name: 'mcp__visible__search' }],
  })
  setup.ctx.get = name => name === 'skills' ? { async snapshot() {
    return { complete: true, skills: Array.from({ length: 101 }, (_, index) => ({ name: `skill_${index}`, source: 'runtime' })) }
  } } : name === 'agentPresets' ? { composedPreset: () => 'tradeloom-product' } : undefined
  const response = res()
  await createAgentCapabilitiesHandler(setup.ctx, setup.dependencies)(req(), response)
  const body = JSON.parse(response.body)
  assert.equal(body.tools.truncated, true)
  assert.equal(body.tools.total, 206)
  assert.equal(body.mcp.status, 'visible_tool')
  assert.deepEqual(body.mcp.visibleTools, ['mcp__visible__search'])
  assert.equal(body.skills.truncated, true)
  assert.equal(body.skills.total, 101)
  assert.equal(body.skills.complete, false)
})

test('method is GET-only and state failures return a safe code without exception details', async () => {
  const setup = context({})
  const handler = createAgentCapabilitiesHandler(setup.ctx, {
    createStateStore: async () => ({ read: async () => { throw new Error('secret /private/path') } }),
  })
  const method = res()
  await handler(req('/tradeloom/agent-capabilities?role=product', 'POST'), method)
  assert.equal(method.statusCode, 405)
  assert.equal(method.headers.allow, 'GET')
  const failed = res()
  await handler(req(), failed)
  assert.equal(failed.statusCode, 503)
  assert.deepEqual(JSON.parse(failed.body), { error: 'capability-state-unavailable' })
})


test('skill invocation projection preserves booleans and treats missing or malformed flags as unknown', async () => {
  const live = { id: 's', ctx: {}, session: { id: 's', header: { cwd: '/synthetic-owned' } } }
  const skills = [
    { name: 'missing-policy' },
    { name: 'partial-policy', invocation: { modelInvocable: true } },
    { name: 'malformed-policy', invocation: { modelInvocable: 'false', userInvocable: 0 } },
    { name: 'explicit-policy', invocation: { modelInvocable: false, userInvocable: true } },
    { name: 'explicit-disabled', invocation: { modelInvocable: false, userInvocable: false } },
  ]
  const setup = context({ state: { roles: { product: { sessionId: 's', agentPreset: 'tradeloom-product' } } }, agent: live,
    skills: { snapshot: async () => ({ skills, complete: true }) }, presets: { composedPreset: () => 'tradeloom-product' } })
  const response = res()
  await createAgentCapabilitiesHandler(setup.ctx, setup.dependencies)(req(), response)
  assert.equal(response.statusCode, 200)
  assert.deepEqual(JSON.parse(response.body).skills.items.map(item => item.invocation), [
    { modelInvocable: null, userInvocable: null },
    { modelInvocable: true, userInvocable: null },
    { modelInvocable: null, userInvocable: null },
    { modelInvocable: false, userInvocable: true },
    { modelInvocable: false, userInvocable: false },
  ])
})
