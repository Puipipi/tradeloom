import { createHostWebAiTransport } from './host.mjs'

export const NATIVE_WEB_AI_TOOLS = Object.freeze({
  list: 'tradeloom_webai_targets',
  ask: 'tradeloom_webai_ask',
})

const unavailable = code => Object.assign(new Error(code), { code })
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const cordisOriginal = Symbol.for('cordis.original')
// Cordis 4.0.5 publicly exports `symbols.original` for context service proxies.
function serviceIdentity(value) {
  try { return value?.[cordisOriginal] ?? value } catch { return value }
}

function readTarget(value, targetId) {
  if (!object(value) || value.targetId !== targetId || !Number.isSafeInteger(value.generation) || value.generation < 1
    || typeof value.providerId !== 'string' || !value.providerId
    || typeof value.windowId !== 'string' || !value.windowId
    || typeof value.conversationId !== 'string' || !value.conversationId
    || value.available !== true) return undefined
  return Object.freeze({
    targetId: value.targetId, generation: value.generation, providerId: value.providerId,
    windowId: value.windowId, conversationId: value.conversationId, available: true,
  })
}

function sameTarget(left, right) {
  return left !== undefined && right !== undefined
    && left.targetId === right.targetId && left.generation === right.generation
    && left.providerId === right.providerId && left.windowId === right.windowId
    && left.conversationId === right.conversationId && left.available === right.available
}

function workspaceMembership(registry, sessionId) {
  if (!registry || typeof registry.list !== 'function') return null
  let rows
  try { rows = registry.list() } catch { return null }
  if (!Array.isArray(rows)) return null
  const workspace = rows.find(row => typeof row?.id === 'string'
    && typeof row?.path === 'string' && Array.isArray(row.sessionIds) && row.sessionIds.includes(sessionId))
  return workspace ? Object.freeze({ workspaceId: workspace.id, path: workspace.path, includesSession: true }) : null
}

function sameWorkspace(left, right) {
  return left === null ? right === null : right !== null
    && left.workspaceId === right.workspaceId && left.path === right.path
    && left.includesSession === right.includesSession
}

/**
 * Host-only consumer of real SDK ToolRun contexts and the Main target registry.
 * `authorizeTarget` must explicitly return true for each `list` or `ask` action;
 * absent policy is unavailable and never grants all current targets.
 */
export function createNativeWebAiAuthorization(ctx, {
  ToolRuntime, scopeOf, getTarget, listTargets, authorizeTarget,
} = {}) {
  if (!ctx || typeof scopeOf !== 'function' || typeof getTarget !== 'function'
    || typeof listTargets !== 'function' || typeof authorizeTarget !== 'function'
    || typeof ctx.tools?.register !== 'function' || !ToolRuntime || !(ctx.tools instanceof ToolRuntime)) {
    return Object.freeze({ available: false, reason: 'TARGET_AUTHORIZATION_UNAVAILABLE', dispose: () => {} })
  }

  const liveExecutions = new WeakSet()
  let closed = false
  const removeExecutionHook = ctx.on('tools/execute', async (exec, next) => {
    liveExecutions.add(exec)
    try { return await next() }
    finally { liveExecutions.delete(exec) }
  })

  function sessionState(exec, expectedTool) {
    if (closed || !exec || typeof exec !== 'object' || !liveExecutions.has(exec)
      || exec.name !== expectedTool || !exec.signal || exec.signal.aborted) {
      throw unavailable('NATIVE_EXEC_UNAVAILABLE')
    }
    const agent = exec.agent
    const session = agent?.session
    if (!agent || !session || typeof agent.id !== 'string' || !agent.id
      || typeof session.id !== 'string' || !session.id
      || ctx.agents?.get?.(agent.id) !== agent
      || ctx.sessions?.get?.(session.id) !== session
      || scopeOf(agent.ctx) !== agent) throw unavailable('NATIVE_SESSION_UNAVAILABLE')

    let fs
    let workingDirectory
    try {
      fs = agent.ctx.get('fs')
      workingDirectory = agent.ctx.get('workingDirectory')
    } catch { throw unavailable('NATIVE_WORKSPACE_UNAVAILABLE') }
    if (!fs || typeof fs.resolve !== 'function' || !workingDirectory
      || typeof workingDirectory.ensure !== 'function' || typeof workingDirectory.get !== 'function') {
      throw unavailable('NATIVE_WORKSPACE_UNAVAILABLE')
    }
    let cwd
    try { cwd = workingDirectory.get(session) } catch { throw unavailable('NATIVE_WORKSPACE_UNAVAILABLE') }
    if (typeof cwd !== 'string' || !cwd) throw unavailable('NATIVE_WORKSPACE_UNAVAILABLE')
    const workspaceRegistry = ctx.get?.('workspaceRegistry')
    return Object.freeze({ exec, agent, session, fs, fsIdentity: serviceIdentity(fs),
      workingDirectory, workingDirectoryIdentity: serviceIdentity(workingDirectory), cwd,
      workspaceMembership: workspaceMembership(workspaceRegistry, session.id), workspaceRegistry })
  }

  function stateIsCurrent(state, expectedTool) {
    try {
      if (closed || !liveExecutions.has(state.exec) || state.exec.signal.aborted
        || state.exec.name !== expectedTool || state.exec.agent !== state.agent
        || state.agent.session !== state.session || ctx.agents.get(state.agent.id) !== state.agent
        || ctx.sessions.get(state.session.id) !== state.session || scopeOf(state.agent.ctx) !== state.agent
        || serviceIdentity(state.agent.ctx.get('fs')) !== state.fsIdentity
        || serviceIdentity(state.agent.ctx.get('workingDirectory')) !== state.workingDirectoryIdentity
        || state.workingDirectory.get(state.session) !== state.cwd) return false
      const currentRegistry = ctx.get?.('workspaceRegistry')
      return workspaceMembership(currentRegistry, state.session.id) !== null
        ? sameWorkspace(state.workspaceMembership, workspaceMembership(currentRegistry, state.session.id))
        : state.workspaceMembership === null
    } catch { return false }
  }

  async function prepareCaller(exec, expectedTool) {
    const initial = sessionState(exec, expectedTool)
    const validatedCwd = await initial.workingDirectory.ensure(initial.agent, exec.signal)
    const afterEnsure = sessionState(exec, expectedTool)
    if (afterEnsure.agent !== initial.agent || afterEnsure.session !== initial.session
      || afterEnsure.fsIdentity !== initial.fsIdentity
      || afterEnsure.workingDirectoryIdentity !== initial.workingDirectoryIdentity
      || afterEnsure.cwd !== validatedCwd
      || !sameWorkspace(initial.workspaceMembership, afterEnsure.workspaceMembership)) {
      throw unavailable('NATIVE_SESSION_CHANGED')
    }
    if (!stateIsCurrent(afterEnsure, expectedTool)) {
      throw unavailable('NATIVE_SESSION_CHANGED')
    }
    return afterEnsure
  }

  async function currentTarget(targetId, expected) {
    let raw
    try { raw = await getTarget(targetId) } catch { throw unavailable('TARGET_AUTHORIZATION_UNAVAILABLE') }
    const current = readTarget(raw, targetId)
    if (!current || expected && !sameTarget(expected, current)) throw unavailable('TARGET_CHANGED')
    return current
  }

  async function authorize(action, caller, target) {
    if (closed) throw unavailable('NATIVE_AUTH_DENIED')
    let allowed
    try {
      allowed = await authorizeTarget({
        action,
        caller: Object.freeze({
          exec: caller.exec, agent: caller.agent, session: caller.session, fs: caller.fs,
          workingDirectory: caller.workingDirectory, workingDirectoryPath: caller.cwd,
          workspaceMembership: caller.workspaceMembership,
        }),
        target,
      })
    } catch { throw unavailable('TARGET_AUTHORIZATION_UNAVAILABLE') }
    if (allowed !== true) return false
    if (!stateIsCurrent(caller, caller.exec.name)) throw unavailable('NATIVE_SESSION_CHANGED')
    await currentTarget(target.targetId, target)
    return true
  }

  async function listAuthorizedTargets({ exec } = {}) {
    const caller = await prepareCaller(exec, NATIVE_WEB_AI_TOOLS.list)
    let rows
    try { rows = await listTargets() } catch { throw unavailable('TARGET_REGISTRY_UNAVAILABLE') }
    if (rows instanceof Map) rows = [...rows.values()]
    if (!Array.isArray(rows)) throw unavailable('TARGET_REGISTRY_UNAVAILABLE')
    const authorized = []
    for (const row of rows) {
      if (!object(row) || typeof row.targetId !== 'string' || !row.targetId) continue
      const target = readTarget(row, row.targetId)
      if (!target) continue
      if (await authorize('list', caller, target)) {
        authorized.push({ targetId: target.targetId, generation: target.generation, conversationId: target.conversationId })
      }
      if (!stateIsCurrent(caller, NATIVE_WEB_AI_TOOLS.list)) throw unavailable('NATIVE_SESSION_CHANGED')
    }
    return authorized
  }

  async function authorizeNativeToolRun({ exec, targetId } = {}) {
    sessionState(exec, NATIVE_WEB_AI_TOOLS.ask)
    if (exec.arguments?.withFiles === true) throw unavailable('FILES_POLICY_UNAVAILABLE')
    const caller = await prepareCaller(exec, NATIVE_WEB_AI_TOOLS.ask)
    if (typeof targetId !== 'string' || !targetId) throw unavailable('TARGET_UNAVAILABLE')
    const target = await currentTarget(targetId)
    if (!await authorize('ask', caller, target)) throw unavailable('TARGET_AUTHORIZATION_DENIED')
    if (!stateIsCurrent(caller, NATIVE_WEB_AI_TOOLS.ask)) throw unavailable('NATIVE_SESSION_CHANGED')
    return Object.freeze({
      exec, targetId, providerId: target.providerId, conversationId: target.conversationId,
      isCurrent: () => stateIsCurrent(caller, NATIVE_WEB_AI_TOOLS.ask)
        && currentTargetSync(targetId, target),
    })
  }

  function currentTargetSync(targetId, expected) {
    try {
      const raw = getTarget(targetId)
      if (raw && typeof raw.then === 'function') return false
      return sameTarget(expected, readTarget(raw, targetId))
    } catch { return false }
  }

  return Object.freeze({ available: true, authorizeNativeToolRun, listAuthorizedTargets,
    dispose() { if (closed) return; closed = true; removeExecutionHook?.() } })
}

/**
 * Deferred optional Host install. Missing key, SDK services, or explicit target
 * policy leaves the feature unavailable without failing the Host load. `withFiles`
 * is intentionally not wired to any runtimeFiles/file-tools authority here.
 */
export function mountOptionalWebAiHost(ctx, {
  getNativeBridgeKey, loadRuntimeSdk, authorizeTarget, onStatus = () => {},
} = {}) {
  let closed = false
  let status = Object.freeze({ available: false, reason: 'HOST_DEPENDENCIES_PENDING' })
  let transport
  let authorization
  let injectionFiber
  let resolveReady
  const ready = new Promise(resolve => { resolveReady = resolve })
  const publish = next => {
    status = Object.freeze(next)
    try { onStatus(status) } catch {}
    resolveReady(status)
  }

  const dispose = async () => {
    if (closed) return
    closed = true
    try { await transport?.dispose?.() } catch {}
    try { authorization?.dispose?.() } catch {}
    try { await injectionFiber?.dispose?.() } catch {}
    publish({ available: false, reason: 'HOST_CLOSED' })
  }

  if (typeof ctx?.inject !== 'function' || typeof ctx?.effect !== 'function') {
    publish({ available: false, reason: 'HOST_DEPENDENCIES_UNAVAILABLE' })
    return Object.freeze({ ready, get status() { return status }, get transport() { return transport }, dispose })
  }
  injectionFiber = ctx.inject(['connection', 'tools', 'agents', 'sessions', 'workingDirectory'], async hostCtx => {
    if (closed) return
    if (typeof getNativeBridgeKey !== 'function' || typeof authorizeTarget !== 'function') {
      publish({ available: false, reason: typeof authorizeTarget !== 'function' ? 'TARGET_AUTHORIZATION_UNAVAILABLE' : 'NATIVE_BRIDGE_KEY_UNAVAILABLE' })
      return
    }
    let key
    try { key = await getNativeBridgeKey() } catch { key = undefined }
    if (typeof key !== 'string' || key.length < 16) {
      publish({ available: false, reason: 'NATIVE_BRIDGE_KEY_UNAVAILABLE' })
      return
    }
    if (typeof loadRuntimeSdk !== 'function') {
      publish({ available: false, reason: 'NATIVE_RUNTIME_UNAVAILABLE' })
      return
    }
    let sdk
    try { sdk = await loadRuntimeSdk() } catch {
      publish({ available: false, reason: 'NATIVE_RUNTIME_UNAVAILABLE' })
      return
    }
    if (closed) return
    if (hostCtx.tools.get(NATIVE_WEB_AI_TOOLS.list) !== undefined
      || hostCtx.tools.get(NATIVE_WEB_AI_TOOLS.ask) !== undefined) {
      publish({ available: false, reason: 'NATIVE_TOOL_CONFLICT' })
      return
    }
    let createdTransport
    authorization = createNativeWebAiAuthorization(hostCtx, {
      ToolRuntime: sdk?.ToolRuntime,
      scopeOf: sdk?.scopeOf,
      getTarget: targetId => createdTransport?.targets?.get(targetId),
      listTargets: () => createdTransport ? [...createdTransport.targets.values()] : [],
      authorizeTarget,
    })
    if (!authorization.available) {
      publish({ available: false, reason: authorization.reason })
      authorization.dispose()
      authorization = undefined
      return
    }
    try {
      createdTransport = createHostWebAiTransport({
        ctx: hostCtx,
        nativeBridgeKey: key,
        authorizeNativeToolRun: authorization.authorizeNativeToolRun,
        listAuthorizedTargets: authorization.listAuthorizedTargets,
        runtimeFiles: undefined,
        createFileTools: undefined,
        createToolEnvelope: undefined,
        toolManifest: undefined,
      })
      if (!createdTransport.available) {
        authorization.dispose(); authorization = undefined
        publish({ available: false, reason: 'NATIVE_BRIDGE_UNAVAILABLE' })
        return
      }
      transport = createdTransport
      publish({ available: true, reason: undefined })
    } catch {
      try { await createdTransport?.dispose?.() } catch {}
      try { authorization?.dispose?.() } catch {}
      authorization = undefined
      publish({ available: false, reason: 'NATIVE_BRIDGE_UNAVAILABLE' })
    }
  })
  Promise.resolve(injectionFiber).catch(() => publish({ available: false, reason: 'HOST_DEPENDENCIES_UNAVAILABLE' }))
  ctx.effect(() => dispose)
  return Object.freeze({ ready, get status() { return status }, get transport() { return transport }, dispose })
}
