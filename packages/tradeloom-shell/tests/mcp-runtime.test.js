import assert from 'node:assert/strict'
import test from 'node:test'
import { createMcpRuntimeController } from '@tradeloom/dsh-business-shell/mcp-runtime'

function deferred() {
  let resolve
  const promise = new Promise(yes => { resolve = yes })
  return { promise, resolve }
}

function agent(id, sessionId = id) { return { id, session: { id: sessionId } } }

function makeHandle(instanceId, overrides = {}) {
  const listeners = new Set()
  let state = { serverName: 'docs', instanceId, phase: 'connected', enabled: true,
    connected: true, connectedAt: 10, syncGeneration: 2, registeredToolCount: 1,
    registeredTools: { status: 'known', tools: [{ publicName: 'mcp__docs__ping', visible: true }] }, lastErrorCode: null,
    ...overrides }
  const calls = []
  return {
    instanceId,
    calls,
    snapshot: () => state,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener) },
    publish(next) { state = { ...state, ...next }; for (const listener of [...listeners]) listener() },
    async restart() { calls.push('restart'); state = { ...state, phase: 'connected' }; for (const listener of listeners) listener(); return state },
    async enable() { calls.push('enable'); state = { ...state, enabled: true }; return state },
    async disable() { calls.push('disable'); state = { ...state, enabled: false }; return state },
  }
}

function registryHarness({ agent: currentAgent = agent('agent-a'), initialHandle } = {}) {
  const agents = new Map([[currentAgent.id, currentAgent]])
  let runtime = makeRegistry(initialHandle)
  const ctx = { agents: { get: id => agents.get(id) }, get: key => key === 'mcpRuntime' ? runtime : undefined }
  return { ctx, agents, replaceRuntime(next) { runtime = next }, runtime: () => runtime }
}

function makeRegistry(initialHandle) {
  const handles = new Map()
  if (initialHandle) handles.set('docs', initialHandle)
  const listeners = new Set()
  return {
    get(agentTarget, serverName) { return agentTarget?.id === 'agent-a' ? handles.get(serverName) : undefined },
    list(agentTarget) { return agentTarget?.id === 'agent-a' ? [...handles].map(([serverName, handle]) => ({ serverName, handle })) : [] },
    subscribe(agentTarget, serverName, listener) {
      const handle = this.get(agentTarget, serverName)
      if (!handle) return () => {}
      const off = handle.subscribe(listener)
      listeners.add(listener)
      return () => { listeners.delete(listener); off() }
    },
    replace(serverName, handle) { handles.set(serverName, handle); for (const listener of [...listeners]) listener() },
    handle(serverName) { return handles.get(serverName) },
  }
}

test('reads only the scoped registered handle and keeps saved config unknown', () => {
  const handle = makeHandle('instance-a')
  const h = registryHarness({ initialHandle: handle })
  const controller = createMcpRuntimeController({ ctx: h.ctx })
  try {
    const binding = controller.bindAgent('agent-a')
    assert.deepEqual(controller.read({ binding, serverName: 'docs' }), {
      status: 'available',
      target: { agentId: 'agent-a', sessionId: 'agent-a', generation: binding.generation },
      serverName: 'docs',
      savedConfiguration: { status: 'unknown' },
      scopeTools: { status: 'registered', syncGeneration: 2, registeredToolCount: 1, visibleToolCount: 1,
        tools: [{ publicName: 'mcp__docs__ping', visible: true }] },
      runtime: { instanceId: 'instance-a', phase: 'connected', enabled: true, connected: true,
        connectedAt: 10, syncGeneration: 2, registeredToolCount: 1,
        registeredTools: { status: 'known', registeredToolCount: 1, visibleToolCount: 1,
          tools: [{ publicName: 'mcp__docs__ping', visible: true }] }, lastErrorCode: null },
    })
    handle.publish({ phase: 'reconnecting', connected: false, lastErrorCode: 'connection_lost' })
    const disconnected = controller.read({ binding, serverName: 'docs' })
    assert.equal(disconnected.runtime.connected, false)
    assert.equal(disconnected.scopeTools.registeredToolCount, 1)
  } finally { controller.dispose() }
})

test('groups effective live servers with saved-only catalog entries and owned child-tool visibility', () => {
  const runtime = makeHandle('instance-a', { registeredToolCount: 2, registeredTools: { status: 'known', tools: [
    { publicName: 'mcp__docs__ping', visible: true },
    { publicName: 'mcp__docs__shadowed', visible: false },
  ] } })
  const h = registryHarness({ initialHandle: runtime })
  const controller = createMcpRuntimeController({
    ctx: h.ctx,
    readSavedConfigurationCatalog: () => ({ status: 'known', servers: [
      { serverName: 'docs', enabled: true }, { serverName: 'saved-only', enabled: false },
    ] }),
  })
  const binding = controller.bindAgent('agent-a')
  const grouped = controller.list({ binding })
  assert.equal(grouped.session.status, 'available')
  assert.equal(grouped.savedConfiguration.status, 'known')
  assert.equal(grouped.runtimeRegistry.status, 'available')
  assert.deepEqual(grouped.servers.map(row => row.serverName), ['docs', 'saved-only'])
  assert.deepEqual(grouped.servers[0].scopeTools.tools, [
    { publicName: 'mcp__docs__ping', visible: true },
    { publicName: 'mcp__docs__shadowed', visible: false },
  ])
  assert.equal(grouped.servers[0].scopeTools.registeredToolCount, 2)
  assert.equal(grouped.servers[0].scopeTools.visibleToolCount, 1)
  assert.deepEqual(grouped.servers[1], {
    serverName: 'saved-only', savedConfiguration: { status: 'saved', enabled: false },
    runtime: null, scopeTools: { status: 'not_registered', registeredToolCount: 0, visibleToolCount: 0, tools: [] },
  })
  controller.dispose()
})

test('list keeps runtime data separate when the saved catalog is unknown and registry is missing', () => {
  const a = agent('agent-a')
  let callbackReads = 0
  const controller = createMcpRuntimeController({
    ctx: { agents: { get: id => id === a.id ? a : undefined }, get: () => undefined },
    readSavedConfigurationCatalog: () => ({ status: 'unknown' }),
    readSavedConfiguration: () => { callbackReads += 1; return { status: 'saved', enabled: true } },
  })
  const binding = controller.bindAgent(a.id)
  const grouped = controller.list({ binding })
  assert.equal(grouped.session.status, 'available')
  assert.equal(grouped.savedConfiguration.status, 'unknown')
  assert.equal(grouped.runtimeRegistry.status, 'unavailable')
  assert.deepEqual(grouped.servers, [])
  assert.equal(callbackReads, 0)
  controller.dispose()
})

test('distinguishes an unavailable registry from a server not registered in this scope', () => {
  const a = agent('agent-a')
  const missing = createMcpRuntimeController({ ctx: { agents: { get: id => id === a.id ? a : undefined }, get: () => undefined } })
  const binding = missing.bindAgent(a.id)
  assert.deepEqual(missing.read({ binding, serverName: 'docs' }), {
    status: 'unavailable', code: 'registry_unavailable', target: { agentId: 'agent-a', sessionId: 'agent-a', generation: binding.generation },
  })
  missing.dispose()

  const h = registryHarness()
  const controller = createMcpRuntimeController({ ctx: h.ctx })
  const target = controller.bindAgent('agent-a')
  assert.equal(controller.read({ binding: target, serverName: 'docs' }).status, 'not_registered')
  assert.equal(controller.read({ binding: target, serverName: 'docs' }).savedConfiguration.status, 'unknown')
  controller.dispose()
})

test('projects only an explicit saved-configuration status and leaves raw config out', () => {
  const h = registryHarness()
  const controller = createMcpRuntimeController({ ctx: h.ctx, readSavedConfiguration: () => ({
    status: 'saved', enabled: false, command: 'must-not-project', headers: { token: 'must-not-project' },
  }) })
  const binding = controller.bindAgent('agent-a')
  assert.deepEqual(controller.read({ binding, serverName: 'docs' }).savedConfiguration, { status: 'saved', enabled: false })
  controller.dispose()
})

test('refuses all controls without an explicit trusted authorizer', async () => {
  const handle = makeHandle('instance-a')
  const h = registryHarness({ initialHandle: handle })
  const controller = createMcpRuntimeController({ ctx: h.ctx })
  const binding = controller.bindAgent('agent-a')
  await assert.rejects(controller.control({ binding, serverName: 'docs', instanceId: 'instance-a', action: 'restart' }), { code: 'mcp_runtime_forbidden' })
  assert.deepEqual(handle.calls, [])
  controller.dispose()
})

test('requires literal authorization and rechecks service and instance identity before control', async t => {
  const handle = makeHandle('instance-a')
  const h = registryHarness({ initialHandle: handle })
  const wait = deferred()
  const controller = createMcpRuntimeController({ ctx: h.ctx, authorizeControl: () => wait.promise })
  t.after(() => controller.dispose())
  const binding = controller.bindAgent('agent-a')
  const pending = controller.control({ binding, serverName: 'docs', instanceId: 'instance-a', action: 'restart' })
  h.replaceRuntime(makeRegistry(makeHandle('instance-b')))
  wait.resolve(true)
  await assert.rejects(pending, { code: 'mcp_runtime_registry_changed' })
  assert.deepEqual(handle.calls, [])

  const denied = createMcpRuntimeController({ ctx: h.ctx, authorizeControl: async () => ({ allowed: true }) })
  const deniedBinding = denied.bindAgent('agent-a')
  await assert.rejects(denied.control({ binding: deniedBinding, serverName: 'docs', instanceId: 'instance-b', action: 'disable' }), { code: 'mcp_runtime_forbidden' })
  assert.deepEqual(h.runtime().handle('docs').calls, [])
  denied.dispose()
})

test('a control based on an older observed instance cannot operate its replacement', async () => {
  const first = makeHandle('instance-a')
  const h = registryHarness({ initialHandle: first })
  const controller = createMcpRuntimeController({ ctx: h.ctx, authorizeControl: async () => true })
  const binding = controller.bindAgent('agent-a')
  h.runtime().replace('docs', makeHandle('instance-b'))
  await assert.rejects(controller.control({ binding, serverName: 'docs', instanceId: 'instance-a', action: 'restart' }),
    { code: 'mcp_runtime_instance_changed' })
  assert.deepEqual(h.runtime().handle('docs').calls, [])
  controller.dispose()
})

test('observed Agent/session replacement and invalid names are rejected', async () => {
  const a = agent('agent-a', 'session-a')
  const h = registryHarness({ agent: a, initialHandle: makeHandle('instance-a') })
  const controller = createMcpRuntimeController({ ctx: h.ctx, authorizeControl: async () => true })
  const binding = controller.bindAgent(a.id)
  h.agents.set(a.id, { ...a, session: { id: 'session-b' } })
  assert.throws(() => controller.read({ binding, serverName: 'docs' }), { code: 'mcp_runtime_target_changed' })
  assert.throws(() => controller.read({ binding, serverName: '../arbitrary' }), { code: 'mcp_runtime_invalid_arguments' })
  await assert.rejects(controller.control({ binding, serverName: 'docs', instanceId: 'instance-a', action: 'restart' }), { code: 'mcp_runtime_target_changed' })
  controller.dispose()
})

test('subscriptions track the current instance but never expose a retired handle', async t => {
  const first = makeHandle('instance-a')
  const h = registryHarness({ initialHandle: first })
  const controller = createMcpRuntimeController({ ctx: h.ctx })
  t.after(() => controller.dispose())
  const binding = controller.bindAgent('agent-a')
  const received = []
  const unsubscribe = controller.subscribe({ binding, serverName: 'docs', listener: value => received.push(value) })
  first.publish({ phase: 'reconnecting', connected: false })
  const second = makeHandle('instance-b')
  h.runtime().replace('docs', second)
  first.publish({ phase: 'connected', connected: true })
  assert.equal(received.some(value => value?.runtime?.instanceId === 'instance-b'), true)
  assert.equal(received.some(value => value?.runtime?.instanceId === 'instance-a' && value?.runtime?.connected === true), false)
  const beforeDispose = received.length
  controller.dispose()
  second.publish({ phase: 'reconnecting', connected: false })
  assert.equal(received.length, beforeDispose)
  unsubscribe()
})
