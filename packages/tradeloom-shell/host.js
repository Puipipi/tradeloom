import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { isIPv4 } from 'node:net'
import { createStateStore, resolveOwnedHome, roleWorkspacePath, ROLE_IDS } from './state.js'
import { publicRoleMetadata, ROLE_PRESETS } from './roles.js'
import { normalizeSceneWorkbench, validateSceneConfig, validateSceneWorkbench } from './scene-layout.js'
import { normalizeDockLayouts, validateDockLayouts } from './dock-layout.js'
import { apply as applyBusinessProxy } from './proxy.js'
import { apply as applyBusinessPolicy } from './policy.js'
import { AGENT_CAPABILITIES_ROUTE, createAgentCapabilitiesHandler } from './capabilities.js'
import { AGENT_CONFIGURATION_ROUTE, createAgentConfigurationHandler } from './agent-configuration.js'
import { WORKFLOW_ROUTE, createWorkflowHandler } from './workflow-tools.js'

const ROUTE = '/tradeloom/session'
const NEW_SESSION_ROUTE = '/tradeloom/session/new'
const PROFILE_ROUTE = '/tradeloom/profile'
const MOBILE_LINK_ROUTE = '/tradeloom/mobile-link'
const SCENES_ROUTE = '/tradeloom/scenes'
const SCENE_LAYOUTS_ROUTE = '/tradeloom/scene-layouts'
const DOCK_LAYOUTS_ROUTE = '/tradeloom/dock-layouts'
export const name = '@tradeloom/dsh-business-shell'
export const inject = ['connection', 'webServer', 'workspaceRegistry', 'sessionController', 'sessionQuery', 'tools', 'agents']
const MAX_BODY = 4096
const MAX_DOCK_LAYOUT_BODY = 128 * 1024

function json(res, status, value) {
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(JSON.stringify(value))
}

async function readBody(req, maxBytes = MAX_BODY) {
  const parts = []
  let size = 0
  for await (const part of req) {
    size += part.byteLength
    if (size > maxBytes) { req.resume(); return null }
    parts.push(part)
  }
  return Buffer.concat(parts).toString('utf8')
}

function deterministicSessionId(role) {
  return `tl-${createHash('sha256').update(`tradeloom:${role}`).digest('hex').slice(0, 28)}`
}

export function createSessionHandler(ctx, dependencies = {}) {
  const storeFactory = dependencies.createStateStore ?? createStateStore
  const getHome = dependencies.resolveOwnedHome ?? resolveOwnedHome
  const getWorkspacePath = dependencies.roleWorkspacePath ?? roleWorkspacePath
  return async (req, res) => {
    const rejection = ctx.connection.requestRejection(req)
    if (rejection !== undefined) { res.statusCode = rejection; res.end(); return }
    if (req.method !== 'POST') { res.statusCode = 405; res.setHeader('allow', 'POST'); res.end(); return }
    const text = await readBody(req)
    if (text === null) { json(res, 413, { error: 'request-too-large' }); return }
    let input
    try { input = JSON.parse(text) } catch { json(res, 400, { error: 'invalid-json' }); return }
    if (!ROLE_IDS.includes(input?.role)) { json(res, 400, { error: 'unknown-role' }); return }

    try {
      await getHome()
      const store = await storeFactory()
      const sessionId = await store.transact(async state => {
        const existing = state.roles[input.role]
        if (existing?.sessionId) return existing.sessionId
        const workspacePath = await getWorkspacePath(input.role)
        let workspace = ctx.workspaceRegistry.list().find(item => item.path === workspacePath)
        if (workspace === undefined) workspace = await ctx.workspaceRegistry.create(workspacePath, `TradeLoom ${input.role}`)
        const preset = ROLE_PRESETS[input.role]
        const created = await ctx.sessionController.create({
          workspaceId: workspace.id,
          agentPreset: preset,
          sessionId: deterministicSessionId(input.role),
        })
        state.roles[input.role] = { workspaceId: workspace.id, workspacePath, sessionId: created.sessionId, agentPreset: preset }
        return created.sessionId
      })
      if (!sessionId) { json(res, 500, { error: 'session-not-created' }); return }
      json(res, 200, { role: input.role, sessionId })
    } catch (error) {
      ctx.logger?.error?.(`tradeloom-shell: session route failed: ${String(error)}`)
      json(res, 503, { error: 'tradeloom-home-unavailable' })
    }
  }
}

const CREATE_OPERATION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const sessionCreateFlights = new Map()

function validNewSessionInput(input) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)
    || Object.keys(input).length !== 3
    || !Object.hasOwn(input, 'role') || !Object.hasOwn(input, 'expectedSessionId') || !Object.hasOwn(input, 'operationId')
    || !ROLE_IDS.includes(input.role) || typeof input.operationId !== 'string' || !CREATE_OPERATION_ID.test(input.operationId)) return false
  return input.expectedSessionId === null
    || (typeof input.expectedSessionId === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(input.expectedSessionId))
}

function sessionCreateFailure(res, status, error, operationId) {
  json(res, status, { error, operationId })
}

async function observePendingSession(ctx, sessionId) {
  try {
    const observation = await ctx.sessionQuery.observeSession(sessionId)
    try {
      return { found: true, observation: {
        header: { id: observation?.header?.id, cwd: observation?.header?.cwd },
        projections: { values: {
          agentPreset: observation?.projections?.values?.agentPreset,
          turnBoundary: observation?.projections?.values?.turnBoundary,
        } },
        events: (observation?.events ?? []).map(event => ({ type: event.type })),
      } }
    }
    finally { observation?.[Symbol.dispose]?.() }
  } catch (error) {
    if (error?.code === 'SESSION_QUERY_SESSION_NOT_FOUND') return { found: false }
    throw error
  }
}

function isReusablePendingObservation(observation, operation, workspace, archivedSessionIds) {
  const boundary = observation?.projections?.values?.turnBoundary
  const blank = boundary === undefined
    || (boundary !== null && typeof boundary === 'object'
      && boundary.openTurnStartSeq === null && boundary.lastTurn === 0)
  return observation?.header?.id === operation.sessionId
    && observation.header.cwd === operation.workspacePath
    && observation.projections?.values?.agentPreset === operation.agentPreset
    && blank
    && workspace?.id === operation.workspaceId
    && Array.isArray(workspace.sessionIds)
    && workspace.sessionIds.includes(operation.sessionId)
    && Array.isArray(archivedSessionIds)
    && !archivedSessionIds.includes(operation.sessionId)
}

/** Create a new blank conversation without changing or deleting the previous session. */
export function createNewSessionHandler(ctx, dependencies = {}) {
  const storeFactory = dependencies.createStateStore ?? createStateStore
  const getHome = dependencies.resolveOwnedHome ?? resolveOwnedHome
  const getWorkspacePath = dependencies.roleWorkspacePath ?? roleWorkspacePath
  return async (req, res) => {
    const rejection = ctx.connection.requestRejection(req)
    if (rejection !== undefined) { res.statusCode = rejection; res.end(); return }
    if (req.method !== 'POST') { res.statusCode = 405; res.setHeader('allow', 'POST'); res.end(); return }
    let ownedHome
    try { ownedHome = await getHome() }
    catch { json(res, 503, { error: 'session-create-unavailable' }); return }
    let text
    try { text = await readBody(req) }
    catch { json(res, 400, { error: 'request-body-unavailable' }); return }
    if (text === null) { json(res, 413, { error: 'request-too-large' }); return }
    let input
    try { input = JSON.parse(text) } catch { json(res, 400, { error: 'invalid-json' }); return }
    if (!validNewSessionInput(input)) { json(res, 400, { error: 'invalid-new-session-request' }); return }
    const operationId = input.operationId.toLowerCase()
    const normalized = { ...input, operationId }
    const fingerprint = JSON.stringify([normalized.role, normalized.expectedSessionId])
    const flightKey = JSON.stringify([ownedHome, operationId])
    const active = sessionCreateFlights.get(flightKey)
    if (active) {
      if (active.fingerprint !== fingerprint) { sessionCreateFailure(res, 409, 'operation-id-conflict', operationId); return }
      const outcome = await active.promise
      json(res, outcome.status, outcome.body)
      return
    }

    const promise = (async () => {
      try {
        const store = await storeFactory()
        const role = normalized.role
        const preset = ROLE_PRESETS[role]
        const workspacePath = await getWorkspacePath(role)
        const sessionId = `session-${operationId}`
        const reserved = await store.transact(state => {
          state.sessionCreateOperations ??= {}
          state.pendingSessionCreateByRole ??= {}
          const currentOperation = state.sessionCreateOperations[operationId]
          if (currentOperation) {
            if (currentOperation.fingerprint !== fingerprint) return { error: 'operation-id-conflict', status: 409 }
            if (currentOperation.status === 'completed') return { completed: true, sessionId: currentOperation.sessionId }
            return { operation: currentOperation }
          }
          if (state.pendingSessionCreateByRole[role]) return { error: 'session-create-in-progress', status: 409 }
          const currentSessionId = state.roles[role]?.sessionId ?? null
          if (currentSessionId !== normalized.expectedSessionId) return { error: 'stale-session-binding', status: 409 }
          const operation = {
            operationId, fingerprint, role, expectedSessionId: normalized.expectedSessionId,
            sessionId, workspacePath, workspaceId: null, agentPreset: preset, status: 'prepared',
          }
          state.sessionCreateOperations[operationId] = operation
          state.pendingSessionCreateByRole[role] = operationId
          return { operation }
        })
        if (reserved.error) return { status: reserved.status, body: { error: reserved.error, operationId } }
        if (reserved.completed) return { status: 200, body: { role, sessionId: reserved.sessionId, operationId, replayed: true } }
        let operation = reserved.operation
        if (operation.status === 'outcome_unknown' || operation.status === 'created_unbound') {
          return { status: 409, body: { error: 'session-create-outcome-unknown', operationId } }
        }

        let workspace = ctx.workspaceRegistry.list().find(item => item.path === operation.workspacePath)
        if (workspace === undefined) workspace = await ctx.workspaceRegistry.create(operation.workspacePath, `TradeLoom ${role}`)
        workspace = ctx.workspaceRegistry.get(workspace.id)
        if (!workspace || workspace.path !== operation.workspacePath) {
          await store.transact(state => { const current = state.sessionCreateOperations[operationId]; if (current) current.status = 'outcome_unknown' })
          return { status: 409, body: { error: 'session-create-outcome-unknown', operationId } }
        }
        if (operation.workspaceId && operation.workspaceId !== workspace.id) {
          await store.transact(state => { const current = state.sessionCreateOperations[operationId]; if (current) current.status = 'outcome_unknown' })
          return { status: 409, body: { error: 'session-create-outcome-unknown', operationId } }
        }
        if (!operation.workspaceId) {
          await store.transact(state => {
            const current = state.sessionCreateOperations[operationId]
            if (current?.status === 'prepared' && current.workspaceId === null) current.workspaceId = workspace.id
          })
          operation = { ...operation, workspaceId: workspace.id }
        }

        let observed = await observePendingSession(ctx, operation.sessionId)
        if (observed.found) {
          if (!isReusablePendingObservation(observed.observation, operation, workspace, ctx.workspaceRegistry.archivedSessionIds)) {
            await store.transact(state => {
              const current = state.sessionCreateOperations[operationId]
              if (current) current.status = 'outcome_unknown'
            })
            return { status: 409, body: { error: 'session-create-outcome-unknown', operationId } }
          }
          if (operation.status !== 'attempted') {
            await store.transact(state => {
              const current = state.sessionCreateOperations[operationId]
              if (current) current.status = 'outcome_unknown'
            })
            return { status: 409, body: { error: 'session-create-outcome-unknown', operationId } }
          }
        } else {
          if (operation.status !== 'prepared') {
            return { status: 409, body: { error: 'session-create-outcome-unknown', operationId } }
          }
          const claimed = await store.transact(state => {
            const current = state.sessionCreateOperations[operationId]
            if (!current || current.status !== 'prepared'
              || state.pendingSessionCreateByRole[role] !== operationId
              || (state.roles[role]?.sessionId ?? null) !== normalized.expectedSessionId) return false
            current.status = 'attempted'
            return true
          })
          if (!claimed) return { status: 409, body: { error: 'session-create-outcome-unknown', operationId } }
          let created
          try {
            created = await ctx.sessionController.create({ workspaceId: workspace.id, agentPreset: preset, sessionId: operation.sessionId })
          } catch {
            return { status: 503, body: { error: 'session-create-outcome-unknown', operationId } }
          }
          if (created?.sessionId !== operation.sessionId || created?.agentPreset !== preset) {
            await store.transact(state => {
              const current = state.sessionCreateOperations[operationId]
              if (current) { current.status = 'outcome_unknown'; current.returnedSessionId = created?.sessionId ?? null }
            })
            return { status: 409, body: { error: 'session-create-outcome-unknown', operationId } }
          }
          workspace = ctx.workspaceRegistry.get(operation.workspaceId)
          if (!workspace) {
            await store.transact(state => {
              const current = state.sessionCreateOperations[operationId]
              if (current) current.status = 'outcome_unknown'
            })
            return { status: 409, body: { error: 'session-create-outcome-unknown', operationId } }
          }
          observed = await observePendingSession(ctx, operation.sessionId)
          if (!observed.found || !isReusablePendingObservation(observed.observation, operation, workspace, ctx.workspaceRegistry.archivedSessionIds)) {
            await store.transact(state => {
              const current = state.sessionCreateOperations[operationId]
              if (current) current.status = 'outcome_unknown'
            })
            return { status: 409, body: { error: 'session-create-outcome-unknown', operationId } }
          }
        }

        const result = await store.transact(state => {
          const current = state.sessionCreateOperations[operationId]
          if (!current || current.status === 'completed') return current?.status === 'completed'
            ? { ok: true, replayed: true, sessionId: current.sessionId }
            : { ok: false, error: 'session-create-outcome-unknown' }
          if (state.pendingSessionCreateByRole[role] !== operationId
            || (state.roles[role]?.sessionId ?? null) !== normalized.expectedSessionId) {
            current.status = 'created_unbound'
            delete state.pendingSessionCreateByRole[role]
            return { ok: false, error: 'stale-session-binding' }
          }
          state.roles[role] = { workspaceId: workspace.id, workspacePath, sessionId: operation.sessionId, agentPreset: preset }
          current.status = 'completed'
          delete state.pendingSessionCreateByRole[role]
          return { ok: true, replayed: false, sessionId: operation.sessionId }
        })
        return result.ok
          ? { status: result.replayed ? 200 : 201, body: { role, sessionId: result.sessionId, operationId, ...(result.replayed ? { replayed: true } : {}) } }
          : { status: 409, body: { error: result.error, operationId } }
      } catch (error) {
        ctx.logger?.error?.('tradeloom-shell: new session route failed (session-create-unavailable)')
        return { status: 503, body: { error: 'session-create-unavailable', operationId } }
      }
    })()
    sessionCreateFlights.set(flightKey, { fingerprint, promise })
    try {
      const outcome = await promise
      json(res, outcome.status, outcome.body)
    } finally {
      if (sessionCreateFlights.get(flightKey)?.promise === promise) sessionCreateFlights.delete(flightKey)
    }
  }
}

export function createProfileHandler(ctx, dependencies = {}) {
  const storeFactory = dependencies.createStateStore ?? createStateStore
  const getHome = dependencies.resolveOwnedHome ?? resolveOwnedHome
  return async (req, res) => {
    const rejection = ctx.connection.requestRejection(req)
    if (rejection !== undefined) { res.statusCode = rejection; res.end(); return }
    if (req.method === 'GET') {
      try {
        await getHome()
        const store = await storeFactory()
        const state = await store.read()
        json(res, 200, state.userProfile)
      } catch (error) {
        ctx.logger?.error?.(`tradeloom-shell: profile read failed: ${String(error)}`)
        json(res, 503, { error: 'tradeloom-home-unavailable' })
      }
      return
    }
    if (req.method !== 'POST') { res.statusCode = 405; res.setHeader('allow', 'GET, POST'); res.end(); return }
    const text = await readBody(req)
    if (text === null) { json(res, 413, { error: 'request-too-large' }); return }
    let input
    try { input = JSON.parse(text) } catch { json(res, 400, { error: 'invalid-json' }); return }
    if (typeof input?.displayName !== 'string' || typeof input?.notes !== 'string'
      || input.displayName.length > 120 || input.notes.length > 2000) {
      json(res, 400, { error: 'invalid-profile' })
      return
    }
    try {
      await getHome()
      const store = await storeFactory()
      const userProfile = await store.transact(state => {
        state.userProfile = { displayName: input.displayName, notes: input.notes }
        return state.userProfile
      })
      json(res, 200, userProfile)
    } catch (error) {
      ctx.logger?.error?.(`tradeloom-shell: profile update failed: ${String(error)}`)
      json(res, 503, { error: 'tradeloom-home-unavailable' })
    }
  }
}

export function createScenesHandler(ctx, dependencies = {}) {
  const readScenes = dependencies.readScenes ?? (() => readFile(new URL('./scenes.json', import.meta.url), 'utf8'))
  return async (req, res) => {
    const rejection = ctx.connection.requestRejection(req)
    if (rejection !== undefined) { res.statusCode = rejection; res.end(); return }
    if (req.method !== 'GET') { res.statusCode = 405; res.setHeader('allow', 'GET'); res.end(); return }
    try {
      const scenes = validateSceneConfig(JSON.parse(await readScenes()))
      const businessOrigin = ctx.webServer.getOrigin()
      json(res, 200, { ...scenes, businessOrigin, roles: publicRoleMetadata() })
    }
    catch (error) {
      ctx.logger?.error?.(`tradeloom-shell: scene config read failed: ${String(error)}`)
      json(res, 503, { error: 'scene-config-unavailable' })
    }
  }
}

export function createSceneLayoutsHandler(ctx, dependencies = {}) {
  const storeFactory = dependencies.createStateStore ?? createStateStore
  const readScenes = dependencies.readScenes ?? (() => readFile(new URL('./scenes.json', import.meta.url), 'utf8'))
  return async (req, res) => {
    const rejection = ctx.connection.requestRejection(req)
    if (rejection !== undefined) { res.statusCode = rejection; res.end(); return }
    if (req.method !== 'GET' && req.method !== 'PUT') { res.statusCode = 405; res.setHeader('allow', 'GET, PUT'); res.end(); return }
    try {
      const config = validateSceneConfig(JSON.parse(await readScenes()))
      const store = await storeFactory()
      if (req.method === 'GET') {
        const state = await store.read()
        const workbench = normalizeSceneWorkbench(config, state.sceneWorkbench)
        json(res, 200, workbench)
        return
      }
      const text = await readBody(req)
      if (text === null) { json(res, 413, { error: 'request-too-large' }); return }
      let input
      try { input = JSON.parse(text) } catch { json(res, 400, { error: 'invalid-json' }); return }
      let workbench
      try { workbench = validateSceneWorkbench(config, input) } catch { json(res, 400, { error: 'invalid-scene-layout' }); return }
      await store.transact(state => { state.sceneWorkbench = workbench })
      json(res, 200, workbench)
    } catch (error) {
      ctx.logger?.error?.(`tradeloom-shell: scene layout route failed: ${String(error)}`)
      json(res, 503, { error: 'scene-layout-unavailable' })
    }
  }
}

export function createDockLayoutsHandler(ctx, dependencies = {}) {
  const storeFactory = dependencies.createStateStore ?? createStateStore
  const readScenes = dependencies.readScenes ?? (() => readFile(new URL('./scenes.json', import.meta.url), 'utf8'))
  return async (req, res) => {
    const rejection = ctx.connection.requestRejection(req)
    if (rejection !== undefined) { res.statusCode = rejection; res.end(); return }
    if (req.method !== 'GET' && req.method !== 'PUT') { res.statusCode = 405; res.setHeader('allow', 'GET, PUT'); res.end(); return }
    try {
      const config = validateSceneConfig(JSON.parse(await readScenes()))
      const store = await storeFactory()
      if (req.method === 'GET') {
        const dockLayouts = await store.transact(state => {
          const normalized = normalizeDockLayouts(config, state.dockLayouts, state.sceneWorkbench?.layouts)
          state.dockLayouts = normalized
          return normalized
        })
        json(res, 200, dockLayouts)
        return
      }
      const text = await readBody(req, MAX_DOCK_LAYOUT_BODY)
      if (text === null) { json(res, 413, { error: 'request-too-large' }); return }
      let input
      try { input = JSON.parse(text) } catch { json(res, 400, { error: 'invalid-json' }); return }
      try {
        const current = await store.read()
        validateDockLayouts(config, input, {
          existingDockLayouts: current.dockLayouts,
          legacySceneLayouts: current.sceneWorkbench?.layouts,
        })
      } catch { json(res, 400, { error: 'invalid-dock-layout' }); return }
      const dockLayouts = await store.transact(state => {
        const normalized = validateDockLayouts(config, input, {
          existingDockLayouts: state.dockLayouts,
          legacySceneLayouts: state.sceneWorkbench?.layouts,
        })
        state.dockLayouts = normalized
        return normalized
      })
      json(res, 200, dockLayouts)
    } catch (error) {
      ctx.logger?.error?.(`tradeloom-shell: dock layout route failed: ${String(error)}`)
      json(res, 503, { error: 'dock-layout-unavailable' })
    }
  }
}

function privateIpv4(address) {
  if (typeof address !== 'string' || !isIPv4(address)) return false
  const octets = address.split('.').map(Number)
  return octets[0] === 10
    || (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31)
    || (octets[0] === 192 && octets[1] === 168)
}

export function createMobileLinkHandler(ctx) {
  return async (req, res) => {
    const rejection = ctx.connection.requestRejection(req)
    if (rejection !== undefined) { res.statusCode = rejection; res.end(); return }
    if (req.method !== 'GET') { res.statusCode = 405; res.setHeader('allow', 'GET'); res.end(); return }

    try {
      const { protocol, host, port } = ctx.webServer
      if ((protocol !== 'http:' && protocol !== 'https:') || !privateIpv4(host) || Number(port) !== 3088) {
        json(res, 503, { error: 'mobile-link-unavailable' })
        return
      }
      const origin = new URL(`${protocol}//${host}:${String(port)}`).origin
      const url = ctx.connection.authenticatedUrl(origin)
      if (typeof url !== 'string') throw new Error('invalid authenticated URL')
      json(res, 200, { url })
    } catch {
      json(res, 503, { error: 'mobile-link-unavailable' })
    }
  }
}

export function apply(ctx) {
  applyBusinessPolicy(ctx)
  applyBusinessProxy(ctx)
  ctx.effect(() => {
    const disposeSession = ctx.webServer.register({ kind: 'exact', path: ROUTE, handler: createSessionHandler(ctx) })
    const disposeNewSession = ctx.webServer.register({ kind: 'exact', path: NEW_SESSION_ROUTE, handler: createNewSessionHandler(ctx) })
    const disposeProfile = ctx.webServer.register({ kind: 'exact', path: PROFILE_ROUTE, handler: createProfileHandler(ctx) })
    const disposeMobileLink = ctx.webServer.register({ kind: 'exact', path: MOBILE_LINK_ROUTE, handler: createMobileLinkHandler(ctx) })
    const disposeScenes = ctx.webServer.register({ kind: 'exact', path: SCENES_ROUTE, handler: createScenesHandler(ctx) })
    const disposeSceneLayouts = ctx.webServer.register({ kind: 'exact', path: SCENE_LAYOUTS_ROUTE, handler: createSceneLayoutsHandler(ctx) })
    const disposeDockLayouts = ctx.webServer.register({ kind: 'exact', path: DOCK_LAYOUTS_ROUTE, handler: createDockLayoutsHandler(ctx) })
    const disposeAgentCapabilities = ctx.webServer.register({ kind: 'exact', path: AGENT_CAPABILITIES_ROUTE, handler: createAgentCapabilitiesHandler(ctx) })
    const disposeAgentConfiguration = ctx.webServer.register({ kind: 'exact', path: AGENT_CONFIGURATION_ROUTE, handler: createAgentConfigurationHandler(ctx) })
    const disposeWorkflows = ctx.webServer.register({ kind: 'exact', path: WORKFLOW_ROUTE, handler: createWorkflowHandler(ctx) })
    return () => { disposeSession(); disposeNewSession(); disposeProfile(); disposeMobileLink(); disposeScenes(); disposeSceneLayouts(); disposeDockLayouts(); disposeAgentCapabilities(); disposeAgentConfiguration(); disposeWorkflows() }
  }, 'tradeloom-shell: protected session and profile routes')
}

