import { ROLE_IDS, ROLE_PRESETS } from './roles.js'
import { createStateStore } from './state.js'

export const SKILLS_OPEN_ROUTE = '/tradeloom/skills/open'
const MAX_BODY = 4096 // Same limit as the existing shell Host's small JSON requests.
function json(res, status, body) { res.statusCode = status; res.setHeader('content-type', 'application/json; charset=utf-8'); res.end(JSON.stringify(body)) }
function identity(skill) { return JSON.stringify([skill.name, skill.provider, skill.source, skill.path ?? null, skill.resourceBase ?? null]) }
export function createSkillsOpenHandler(ctx, dependencies = {}) {
  return async (req, res) => {
    const rejection = ctx.connection.requestRejection(req)
    res.setHeader('cache-control', 'no-store')
    if (rejection !== undefined) { res.statusCode = rejection; res.end(); return }
    if (req.method !== 'POST') { res.statusCode = 405; res.setHeader('allow', 'POST'); res.end(); return }
    const abort = new AbortController()
    const onAborted = () => abort.abort()
    const onClose = () => { if (!res.writableFinished) abort.abort() }
    req.once('aborted', onAborted); res.once('close', onClose)
    if (req.aborted) abort.abort()
    try {
      const origin = req.headers?.origin
      if (typeof origin !== 'string' || origin === 'null' || origin !== ctx.webServer.getOrigin() || req.headers?.['sec-fetch-site'] === 'cross-site') return json(res, 403, { error: 'forbidden' })
      if (typeof req.url !== 'string' || req.url !== SKILLS_OPEN_ROUTE) return json(res, 400, { error: 'invalid-query' })
      if (String(req.headers?.['content-type'] ?? '').split(';', 1)[0].trim().toLowerCase() !== 'application/json') return json(res, 415, { error: 'unsupported-media-type' })
      let size = 0; const chunks = []
      for await (const part of req) { abort.signal.throwIfAborted(); const chunk = Buffer.isBuffer(part) ? part : Buffer.from(part); size += chunk.length; if (size > MAX_BODY) return json(res, 413, { error: 'request-too-large' }); chunks.push(chunk) }
      abort.signal.throwIfAborted()
      let input
      try { input = JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { return json(res, 400, { error: 'invalid-json' }) }
      if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).sort().join(',') !== 'expectedSessionId,name,role,target' || !ROLE_IDS.includes(input.role) || typeof input.expectedSessionId !== 'string' || !input.expectedSessionId || typeof input.name !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(input.name) || !['body', 'directory'].includes(input.target)) return json(res, 400, { error: 'invalid-request' })
      const store = await (dependencies.createStateStore ?? createStateStore)()
      const initialBinding = (await store.read())?.roles?.[input.role]
      const first = initialBinding && structuredClone(initialBinding)
      if (!first?.sessionId || first.sessionId !== input.expectedSessionId || first.agentPreset !== ROLE_PRESETS[input.role]) return json(res, 409, { error: 'stale-binding' })
      const agent = ctx.agents?.get(first.sessionId)
      const presets = ctx.get?.('agentPresets'); const skills = ctx.get?.('skills')
      if (!agent || agent.session?.id !== first.sessionId || typeof agent.session?.header?.cwd !== 'string' || !presets || !skills || await presets.composedPreset(agent.ctx) !== ROLE_PRESETS[input.role]) return json(res, 503, { error: 'skill-unavailable' })
      const cwd = agent.session.header.cwd
      const options = { cwd, scope: agent, signal: abort.signal }
      const snapshot = await skills.snapshot(options)
      if (!snapshot?.complete || !Array.isArray(snapshot.skills)) return json(res, 503, { error: 'skill-unavailable' })
      const summary = snapshot.skills.find(skill => skill.name === input.name && skill.invocation?.userInvocable === true)
      if (!summary) return json(res, 404, { error: 'skill-not-found' })
      const loaded = await skills.get(input.name, options)
      if (!loaded || loaded.invocation?.userInvocable !== true || identity(loaded) !== identity(summary)) return json(res, 409, { error: 'skill-changed' })
      if (typeof skills.resolveOpenTarget !== 'function') return json(res, 503, { error: 'skill-unavailable' })
      const path = await skills.resolveOpenTarget(input.name, input.target, options)
      if (path === undefined) return json(res, 422, { error: 'target-unavailable' })
      if (typeof path !== 'string' || !path) return json(res, 422, { error: 'target-unavailable' })
      abort.signal.throwIfAborted()
      const controller = ctx.sessionController
      if (!controller?.canOpenWorkspacePath?.()) return json(res, 503, { error: 'desktop-unavailable' })
      const desktop = controller.workspaceDesktop?.()
      if (!desktop?.available || typeof desktop.name !== 'string' || !desktop.name) return json(res, 503, { error: 'desktop-unavailable' })
      try {
        const mapped = ctx.fs?.processPathFromHostPath(path)
        if (mapped === undefined || ctx.fs.processPath(await ctx.fs.resolve(mapped, { signal: abort.signal })) !== path) return json(res, 422, { error: 'target-unavailable' })
      } catch {
        abort.signal.throwIfAborted()
        return json(res, 422, { error: 'target-unavailable' })
      }
      abort.signal.throwIfAborted()
      if (ctx.agents?.get(first.sessionId) !== agent || agent.session?.id !== first.sessionId || agent.session?.header?.cwd !== cwd || await presets.composedPreset(agent.ctx) !== ROLE_PRESETS[input.role]) return json(res, 409, { error: 'stale-binding' })
      const current = (await store.read())?.roles?.[input.role]
      if (JSON.stringify(current) !== JSON.stringify(first) || ctx.agents?.get(first.sessionId) !== agent || agent.session?.id !== first.sessionId || agent.session?.header?.cwd !== cwd) return json(res, 409, { error: 'stale-binding' })
      abort.signal.throwIfAborted()
      try { await controller.openWorkspacePath({ path }, abort.signal) } catch { return json(res, 502, { error: 'open-failed' }) }
      return json(res, 200, { status: 'handed-off', role: input.role, sessionId: first.sessionId, name: input.name, target: input.target, desktop: { name: desktop.name } })
    } catch { return json(res, 503, { error: 'skill-unavailable' }) }
    finally { req.removeListener('aborted', onAborted); res.removeListener('close', onClose) }
  }
}
export function registerSkillsOpen(ctx) { return ctx.webServer.register({ kind: 'exact', path: SKILLS_OPEN_ROUTE, handler: createSkillsOpenHandler(ctx) }) }
