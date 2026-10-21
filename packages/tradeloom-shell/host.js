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

const ROUTE = '/tradeloom/session'
const PROFILE_ROUTE = '/tradeloom/profile'
const MOBILE_LINK_ROUTE = '/tradeloom/mobile-link'
const SCENES_ROUTE = '/tradeloom/scenes'
const SCENE_LAYOUTS_ROUTE = '/tradeloom/scene-layouts'
const DOCK_LAYOUTS_ROUTE = '/tradeloom/dock-layouts'
export const name = '@tradeloom/dsh-business-shell'
export const inject = ['connection', 'webServer', 'workspaceRegistry', 'sessionController', 'tools', 'agents']
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
    const disposeProfile = ctx.webServer.register({ kind: 'exact', path: PROFILE_ROUTE, handler: createProfileHandler(ctx) })
    const disposeMobileLink = ctx.webServer.register({ kind: 'exact', path: MOBILE_LINK_ROUTE, handler: createMobileLinkHandler(ctx) })
    const disposeScenes = ctx.webServer.register({ kind: 'exact', path: SCENES_ROUTE, handler: createScenesHandler(ctx) })
    const disposeSceneLayouts = ctx.webServer.register({ kind: 'exact', path: SCENE_LAYOUTS_ROUTE, handler: createSceneLayoutsHandler(ctx) })
    const disposeDockLayouts = ctx.webServer.register({ kind: 'exact', path: DOCK_LAYOUTS_ROUTE, handler: createDockLayoutsHandler(ctx) })
    const disposeAgentCapabilities = ctx.webServer.register({ kind: 'exact', path: AGENT_CAPABILITIES_ROUTE, handler: createAgentCapabilitiesHandler(ctx) })
    return () => { disposeSession(); disposeProfile(); disposeMobileLink(); disposeScenes(); disposeSceneLayouts(); disposeDockLayouts(); disposeAgentCapabilities() }
  }, 'tradeloom-shell: protected session and profile routes')
}

