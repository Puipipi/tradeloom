const SERVER_NAME = /^[A-Za-z0-9_-]{1,32}$/
const CONTROL_ACTIONS = new Set(['restart', 'enable', 'disable'])
const SAFE_PHASES = new Set(['connecting', 'connected', 'reconnecting', 'disconnected', 'reconnect_exhausted', 'closing', 'disabled', 'closed', 'closure_unconfirmed'])
const SAFE_ERROR_CODES = new Set(['connection_failed', 'connection_lost', 'closure_unconfirmed', 'reconnect_exhausted'])

function failure(code, message = code) {
  return Object.assign(new Error(message), { code })
}

function validHandle(handle) {
  return Boolean(handle && typeof handle.instanceId === 'string' && handle.instanceId
    && typeof handle.snapshot === 'function' && typeof handle.subscribe === 'function'
    && typeof handle.restart === 'function' && typeof handle.enable === 'function'
    && typeof handle.disable === 'function')
}

function projectRegisteredTools(value) {
  if (!value || !['known', 'unknown'].includes(value.status) || !Array.isArray(value.tools)) {
    return Object.freeze({ status: 'unknown', registeredToolCount: null, visibleToolCount: null, tools: Object.freeze([]) })
  }
  const tools = []
  const seen = new Set()
  for (const tool of value.tools) {
    if (!tool || typeof tool.publicName !== 'string' || !tool.publicName || seen.has(tool.publicName)
      || ![true, false, null].includes(tool.visible)) {
      return Object.freeze({ status: 'unknown', registeredToolCount: null, visibleToolCount: null, tools: Object.freeze([]) })
    }
    seen.add(tool.publicName)
    tools.push(Object.freeze({ publicName: tool.publicName, visible: tool.visible }))
  }
  tools.sort((left, right) => left.publicName.localeCompare(right.publicName))
  const status = value.status === 'known' && tools.every(tool => tool.visible !== null) ? 'known' : 'unknown'
  return Object.freeze({ status, registeredToolCount: tools.length,
    visibleToolCount: status === 'known' ? tools.filter(tool => tool.visible).length : null,
    tools: Object.freeze(tools) })
}

function projectHandle(handle, serverName, viewingScope) {
  let snapshot
  try { snapshot = handle.snapshot(viewingScope) } catch { return null }
  if (!snapshot || snapshot.instanceId !== handle.instanceId || snapshot.serverName !== serverName) return null
  const safePhase = SAFE_PHASES.has(snapshot.phase) ? snapshot.phase : 'unknown'
  return Object.freeze({
    instanceId: handle.instanceId,
    phase: safePhase,
    enabled: snapshot.enabled === true,
    connected: snapshot.connected === true && safePhase === 'connected' && snapshot.enabled === true,
    connectedAt: safePhase === 'connected' && Number.isFinite(snapshot.connectedAt) ? snapshot.connectedAt : null,
    syncGeneration: Number.isSafeInteger(snapshot.syncGeneration) && snapshot.syncGeneration >= 0 ? snapshot.syncGeneration : null,
    registeredToolCount: Number.isSafeInteger(snapshot.registeredToolCount) && snapshot.registeredToolCount >= 0 ? snapshot.registeredToolCount : null,
    registeredTools: projectRegisteredTools(snapshot.registeredTools),
    lastErrorCode: SAFE_ERROR_CODES.has(snapshot.lastErrorCode) ? snapshot.lastErrorCode : null,
  })
}

/** Create the SDK-backed, scope-aware registry used by mcp-client lifecycle hooks. */
export function createMcpRuntimeRegistry({ ctx, ScopedLayers, NamedEntries }) {
  if (!ctx || typeof ctx.provide !== 'function' || typeof ScopedLayers !== 'function'
    || typeof NamedEntries !== 'function') {
    throw failure('mcp_runtime_dependencies_unavailable')
  }
  const listeners = new Set()
  const emit = () => {
    for (const listener of [...listeners]) {
      try { listener() } catch { /* observers cannot block service teardown */ }
    }
  }
  const layers = new ScopedLayers(
    () => ({ entries: new NamedEntries(name => failure('mcp_runtime_duplicate_registration', `Duplicate MCP runtime: ${name}`)), isEmpty() { return this.entries.isEmpty() } }),
    emit,
  )
  let closed = false
  let closePromise
  const registry = Object.freeze({
    register(context, serverName, handle) {
      if (closed) throw failure('mcp_runtime_registry_closed')
      if (!SERVER_NAME.test(serverName) || !validHandle(handle)) throw failure('mcp_runtime_invalid_registration')
      return layers.effect(context, layer => layer.entries.insert(serverName, handle), { label: `mcp-runtime:${serverName}` })
    },
    get(agent, serverName) {
      if (closed || !agent || !SERVER_NAME.test(serverName)) return undefined
      // The SDK Agent is itself the opaque ScopeKey accepted by ScopedLayers.
      const effective = layers.merge(agent, layer => layer.entries)
      return effective.get(serverName)
    },
    list(agent) {
      if (closed || !agent) return undefined
      const effective = layers.merge(agent, layer => layer.entries)
      return Object.freeze([...effective.entries()]
        .filter(([serverName, handle]) => SERVER_NAME.test(serverName) && validHandle(handle))
        .map(([serverName, handle]) => Object.freeze({ serverName, handle }))
        .sort((left, right) => left.serverName.localeCompare(right.serverName)))
    },
    subscribe(agent, serverName, listener) {
      if (closed || !agent || !SERVER_NAME.test(serverName) || typeof listener !== 'function') return () => {}
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    status() { return Object.freeze({ status: closed ? 'closed' : 'ready' }) },
    close() {
      if (closePromise) return closePromise
      closed = true
      emit()
      listeners.clear()
      try { closePromise = Promise.resolve(unprovide()) }
      catch { closePromise = Promise.resolve() }
      return closePromise
    },
  })
  const unprovide = ctx.provide('mcpRuntime', registry)
  return registry
}

/** Bind read/control calls to one live Agent and its current session. */
function projectSavedConfiguration(reader, agent, serverName) {
  if (typeof reader !== 'function') return Object.freeze({ status: 'unknown' })
  let value
  try { value = reader(agent, serverName) } catch { return Object.freeze({ status: 'unknown' }) }
  if (value?.status === 'not_configured') return Object.freeze({ status: 'not_configured' })
  if (value?.status === 'saved' && typeof value.enabled === 'boolean') {
    return Object.freeze({ status: 'saved', enabled: value.enabled })
  }
  return Object.freeze({ status: 'unknown' })
}

function projectSavedCatalog(reader, agent) {
  if (typeof reader !== 'function') return Object.freeze({ status: 'unknown', servers: Object.freeze([]) })
  let value
  try { value = reader(agent) } catch { return Object.freeze({ status: 'unknown', servers: Object.freeze([]) }) }
  if (value?.status === 'not_configured') return Object.freeze({ status: 'not_configured', servers: Object.freeze([]) })
  if (value?.status !== 'known' || !Array.isArray(value.servers)) return Object.freeze({ status: 'unknown', servers: Object.freeze([]) })
  const servers = []
  const seen = new Set()
  for (const server of value.servers) {
    if (!server || typeof server.serverName !== 'string' || !SERVER_NAME.test(server.serverName)
      || seen.has(server.serverName) || (server.enabled !== true && server.enabled !== false && server.enabled !== null)) {
      return Object.freeze({ status: 'unknown', servers: Object.freeze([]) })
    }
    seen.add(server.serverName)
    servers.push(Object.freeze({ serverName: server.serverName, enabled: server.enabled }))
  }
  servers.sort((left, right) => left.serverName.localeCompare(right.serverName))
  return Object.freeze({ status: 'known', serverNames: Object.freeze(servers.map(server => server.serverName)), servers: Object.freeze(servers) })
}

function savedForServer(catalog, reader, agent, serverName) {
  if (catalog.status === 'not_configured') return Object.freeze({ status: 'not_configured' })
  if (catalog.status === 'known') {
    const saved = catalog.servers.find(server => server.serverName === serverName)
    return saved
      ? Object.freeze({ status: 'saved', enabled: saved.enabled })
      : Object.freeze({ status: 'not_configured' })
  }
  return projectSavedConfiguration(reader, agent, serverName)
}

export function createMcpRuntimeController({ ctx, authorizeControl, readSavedConfiguration, readSavedConfigurationCatalog } = {}) {
  if (!ctx || typeof ctx.get !== 'function' || typeof ctx.agents?.get !== 'function') {
    throw failure('mcp_runtime_host_unavailable')
  }
  let generation = 0
  let current = null
  let disposed = false
  const subscriptions = new Set()

  function service() {
    if (disposed) throw failure('mcp_runtime_closed')
    let value
    try { value = ctx.get('mcpRuntime') } catch { value = undefined }
    if (!value || typeof value.get !== 'function' || typeof value.subscribe !== 'function') {
      throw failure('registry_unavailable')
    }
    if (typeof value.status === 'function') {
      let state
      try { state = value.status() } catch { throw failure('registry_unavailable') }
      if (state?.status !== 'ready') throw failure(state?.status === 'closed' ? 'registry_closed' : 'registry_unavailable')
    }
    return value
  }

  function currentAgent(binding) {
    if (disposed) throw failure('mcp_runtime_closed')
    if (!binding || !current || binding.generation !== current.generation || binding.agentId !== current.agentId
      || binding.sessionId !== current.sessionId) throw failure('mcp_runtime_target_changed')
    let live
    try { live = ctx.agents.get(current.agentId) } catch { live = undefined }
    if (live !== current.agent || live?.session !== current.session || live?.session?.id !== current.sessionId) {
      throw failure('mcp_runtime_target_changed')
    }
    return live
  }

  function handleFor(binding, serverName) {
    if (typeof serverName !== 'string' || !SERVER_NAME.test(serverName)) throw failure('mcp_runtime_invalid_arguments')
    const agent = currentAgent(binding)
    const runtime = service()
    let handle
    try { handle = runtime.get(agent, serverName) } catch { throw failure('registry_unavailable') }
    return { agent, runtime, handle }
  }

  function readWith(binding, serverName, capturedRuntime, capturedHandle) {
    const { agent, runtime, handle } = handleFor(binding, serverName)
    if (capturedRuntime && runtime !== capturedRuntime) throw failure('mcp_runtime_registry_changed')
    if (capturedHandle && (handle !== capturedHandle || handle?.instanceId !== capturedHandle.instanceId)) {
      throw failure('mcp_runtime_instance_changed')
    }
    const target = Object.freeze({ agentId: agent.id, sessionId: agent.session.id, generation: binding.generation })
    const savedCatalog = projectSavedCatalog(readSavedConfigurationCatalog, agent)
    const savedConfiguration = savedForServer(savedCatalog, readSavedConfiguration, agent, serverName)
    if (!handle) return Object.freeze({ status: 'not_registered', target, serverName,
      savedConfiguration, scopeTools: Object.freeze({ status: 'unknown' }), runtime: null })
    if (!validHandle(handle)) throw failure('mcp_runtime_handle_unavailable')
    const projected = projectHandle(handle, serverName, agent)
    if (!projected) throw failure('mcp_runtime_snapshot_unavailable')
    const registeredTools = projected.registeredTools
    return Object.freeze({ status: 'available', target, serverName,
      savedConfiguration,
      scopeTools: Object.freeze({ status: 'registered', syncGeneration: projected.syncGeneration,
        registeredToolCount: registeredTools.registeredToolCount ?? projected.registeredToolCount,
        visibleToolCount: registeredTools.visibleToolCount, tools: registeredTools.tools }),
      runtime: projected })
  }

  function listWith(binding) {
    const agent = currentAgent(binding)
    const target = Object.freeze({ agentId: agent.id, sessionId: agent.session.id, generation: binding.generation })
    const savedConfiguration = projectSavedCatalog(readSavedConfigurationCatalog, agent)
    let runtime
    let runtimeRegistry
    try {
      runtime = service()
      if (typeof runtime.list !== 'function') {
        runtimeRegistry = Object.freeze({ status: 'unknown', code: 'registry_not_enumerable' })
      } else {
        const entries = runtime.list(agent)
        if (!Array.isArray(entries)) throw failure('registry_unavailable')
        runtimeRegistry = Object.freeze({ status: 'available' })
        const handles = new Map()
        for (const entry of entries) {
          if (!entry || typeof entry.serverName !== 'string' || !SERVER_NAME.test(entry.serverName)
            || !validHandle(entry.handle) || handles.has(entry.serverName)) throw failure('registry_unavailable')
          handles.set(entry.serverName, entry.handle)
        }
        runtime = handles
      }
    } catch (error) {
      runtime = new Map()
      runtimeRegistry = Object.freeze({ status: 'unavailable', code: error?.code === 'registry_closed' ? 'registry_closed' : 'registry_unavailable' })
    }
    const names = new Set(savedConfiguration.servers.map(server => server.serverName))
    if (runtime instanceof Map) for (const serverName of runtime.keys()) names.add(serverName)
    const servers = [...names].sort((left, right) => left.localeCompare(right)).map(serverName => {
      const saved = savedForServer(savedConfiguration, readSavedConfiguration, agent, serverName)
      const handle = runtime instanceof Map ? runtime.get(serverName) : undefined
      if (!handle) return Object.freeze({ serverName, savedConfiguration: saved, runtime: null,
        scopeTools: Object.freeze({ status: runtimeRegistry.status === 'available' ? 'not_registered' : 'unknown',
          registeredToolCount: runtimeRegistry.status === 'available' ? 0 : null,
          visibleToolCount: runtimeRegistry.status === 'available' ? 0 : null, tools: Object.freeze([]) }) })
      const projected = projectHandle(handle, serverName, agent)
      if (!projected) return Object.freeze({ serverName, savedConfiguration: saved, runtime: null,
        scopeTools: Object.freeze({ status: 'unknown', registeredToolCount: null, visibleToolCount: null, tools: Object.freeze([]) }) })
      return Object.freeze({ serverName, savedConfiguration: saved, runtime: projected,
        scopeTools: Object.freeze({ status: 'registered', syncGeneration: projected.syncGeneration,
          registeredToolCount: projected.registeredTools.registeredToolCount ?? projected.registeredToolCount,
          visibleToolCount: projected.registeredTools.visibleToolCount,
          tools: projected.registeredTools.tools }) })
    })
    return Object.freeze({ status: 'available', session: Object.freeze({ status: 'available', target }),
      savedConfiguration, runtimeRegistry, servers: Object.freeze(servers) })
  }

  return Object.freeze({
    bindAgent(agentId) {
      if (disposed) throw failure('mcp_runtime_closed')
      if (typeof agentId !== 'string' || !agentId) throw failure('mcp_runtime_invalid_arguments')
      let agent
      try { agent = ctx.agents.get(agentId) } catch { agent = undefined }
      if (!agent || typeof agent.session?.id !== 'string' || !agent.session.id) throw failure('mcp_runtime_target_unavailable')
      generation += 1
      for (const unsubscribe of [...subscriptions]) unsubscribe()
      current = { agentId, agent, session: agent.session, sessionId: agent.session.id, generation }
      return Object.freeze({ agentId, sessionId: agent.session.id, generation })
    },
    read({ binding, serverName }) {
      try { return readWith(binding, serverName) }
      catch (error) {
        if (!['registry_unavailable', 'registry_closed'].includes(error?.code)) throw error
        const agent = currentAgent(binding)
        return Object.freeze({ status: 'unavailable', code: error.code,
          target: Object.freeze({ agentId: agent.id, sessionId: agent.session.id, generation: binding.generation }) })
      }
    },
    list({ binding }) {
      return listWith(binding)
    },
    async control({ binding, serverName, instanceId, action }) {
      if (!CONTROL_ACTIONS.has(action) || typeof instanceId !== 'string' || !instanceId) throw failure('mcp_runtime_invalid_arguments')
      const before = handleFor(binding, serverName)
      if (!validHandle(before.handle)) throw failure(before.handle ? 'mcp_runtime_handle_unavailable' : 'mcp_runtime_not_registered')
      if (before.handle.instanceId !== instanceId) throw failure('mcp_runtime_instance_changed')
      if (typeof authorizeControl !== 'function') throw failure('mcp_runtime_forbidden')
      let allowed
      try { allowed = await authorizeControl(Object.freeze({ action, serverName, target: Object.freeze({ agentId: before.agent.id,
        sessionId: before.agent.session.id, generation: binding.generation }), instanceId })) }
      catch { throw failure('mcp_runtime_forbidden') }
      if (allowed !== true) throw failure('mcp_runtime_forbidden')
      const after = handleFor(binding, serverName)
      if (after.runtime !== before.runtime) throw failure('mcp_runtime_registry_changed')
      if (after.handle !== before.handle || after.handle?.instanceId !== before.handle.instanceId) throw failure('mcp_runtime_instance_changed')
      try { await before.handle[action]() } catch { throw failure('mcp_runtime_control_failed') }
      return Object.freeze({ status: 'applied', action, snapshot: readWith(binding, serverName, before.runtime, before.handle) })
    },
    subscribe({ binding, serverName, listener }) {
      if (typeof listener !== 'function') throw failure('mcp_runtime_invalid_arguments')
      const initial = handleFor(binding, serverName)
      let active = true
      let currentHandle = initial.handle
      let offHandle = currentHandle?.subscribe?.(notify) ?? (() => {})
      const offRegistry = initial.runtime.subscribe(initial.agent, serverName, replace)
      function notify() {
        if (!active) return
        try { currentAgent(binding); const next = readWith(binding, serverName, initial.runtime, currentHandle); listener(next) }
        catch (error) { listener(Object.freeze({ status: 'unavailable', code: error.code ?? 'mcp_runtime_unavailable' })) }
      }
      function replace() {
        if (!active) return
        try {
          const now = handleFor(binding, serverName)
          if (now.runtime !== initial.runtime) return
          const next = now.handle
          if (next === currentHandle) return
          offHandle()
          currentHandle = next
          offHandle = currentHandle?.subscribe?.(notify) ?? (() => {})
          notify()
        } catch (error) { listener(Object.freeze({ status: 'unavailable', code: error.code ?? 'mcp_runtime_unavailable' })) }
      }
      const unsubscribe = () => {
        if (!active) return
        active = false
        subscriptions.delete(unsubscribe)
        offRegistry()
        offHandle()
      }
      subscriptions.add(unsubscribe)
      return unsubscribe
    },
    dispose() {
      if (disposed) return
      disposed = true
      for (const unsubscribe of [...subscriptions]) unsubscribe()
      current = null
    },
  })
}
