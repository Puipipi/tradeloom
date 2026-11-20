import { createHash, randomUUID } from 'node:crypto'
import { projectSceneMemoryGraph, resolveSceneGraphTarget } from './scene-memory-graph.js'

export const SCENE_MEMORY_ROUTE = '/tradeloom/scene-memory'
const SCENE_MEMORY_ENDPOINT = SCENE_MEMORY_ROUTE.slice(1)
const MAX_MEMORY_TEXT_CHARS = 12_000
const MAX_JOURNAL_ENTRIES = 10_000
const fail = code => Object.assign(new Error(code), { code })
const record = value => value && typeof value === 'object' && !Array.isArray(value)
const revision = value => Number.isSafeInteger(value) && value >= 0
const text = value => typeof value === 'string' && value.trim().length > 0 && value.length <= MAX_MEMORY_TEXT_CHARS
const own = (value, keys) => record(value) && Object.keys(value).every(key => keys.includes(key))

/** This is the structured view of the existing sceneMemories value, not a
 * second memory database. Unknown top-level fields survive every mutation. */
export function sceneMemoryDocument(value) {
  if (value === null) return { profile: { revision: 0, responsibility: '', assetRefs: [], primarySkill: null }, handoff: null, handoffRevision: 0, progress: [], decisions: [] }
  if (!record(value) || !record(value.profile) || !revision(value.profile.revision)
    || typeof value.profile.responsibility !== 'string' || value.profile.responsibility.length > MAX_MEMORY_TEXT_CHARS
    || !Array.isArray(value.profile.assetRefs) || value.profile.assetRefs.length > 500
    || value.profile.assetRefs.some(ref => !record(ref) || typeof ref.kind !== 'string' || typeof ref.id !== 'string' || (ref.label !== undefined && typeof ref.label !== 'string'))
    || (value.profile.primarySkill !== null && typeof value.profile.primarySkill !== 'string')
    || !revision(value.handoffRevision) || !Array.isArray(value.progress) || !Array.isArray(value.decisions)
    || value.progress.length > MAX_JOURNAL_ENTRIES || value.decisions.length > MAX_JOURNAL_ENTRIES) throw fail('scene_memory_schema_unsupported')
  for (const row of [...value.progress, ...value.decisions]) {
    if (!record(row) || !text(row.text) || typeof row.entryId !== 'string' || !row.entryId
      || typeof row.sourceSessionId !== 'string' || typeof row.createdAt !== 'string') throw fail('scene_memory_schema_unsupported')
  }
  if (value.handoff !== null && (!record(value.handoff) || !text(value.handoff.text)
    || !revision(value.handoff.revision) || typeof value.handoff.sourceSessionId !== 'string'
    || typeof value.handoff.updatedAt !== 'string' || typeof value.handoff.operationId !== 'string')) throw fail('scene_memory_schema_unsupported')
  return structuredClone(value)
}

export function createSceneMemoryCatalog(authority, { now = () => new Date().toISOString() } = {}) {
  if (typeof authority?.transactSceneMemory !== 'function' || typeof authority?.updateSceneMemory !== 'function') throw new TypeError('Scene catalog requires the live execution-origin authority')
  return Object.freeze({
    async execute(origin, input) {
      if (!own(input, ['id', 'action', 'query', 'nodeId', 'expectedTarget', 'expectedRevision', 'text'])
        || !['catalog', 'graph', 'resolve', 'handoff', 'progress', 'decision'].includes(input.action)) throw fail('invalid_arguments')
      // No renderer scene/session field is accepted. Main's captured immutable
      // operation supplies the complete current owner to the existing store.
      const sceneId = origin.sceneId
      const context = { sessionId: origin.sessionId, sceneId, bindingRevision: origin.bindingRevision }
      if (['catalog', 'graph', 'resolve'].includes(input.action)) {
        const snapshot = await authority.transactSceneMemory(origin, 'snapshot', sceneId)
        const scene = sceneMemoryDocument(snapshot.value)
        if (input.action === 'resolve') return resolveSceneGraphTarget({ ...context, roleId: origin.roleId, scene, nodeId: input.nodeId, expectedTarget: input.expectedTarget })
        const graph = projectSceneMemoryGraph({ ...context, scene, query: input.query ?? {} })
        return { revision: snapshot.revision, catalog: { ...context, profile: scene.profile, handoff: scene.handoff,
          progressCount: scene.progress.length, decisionCount: scene.decisions.length }, graph }
      }
      if (!revision(input.expectedRevision) || !text(input.text)) throw fail('invalid_arguments')
      return authority.updateSceneMemory(origin, sceneId, input.expectedRevision, previous => {
        const value = sceneMemoryDocument(previous)
        const at = now()
        if (input.action === 'handoff') {
          if (value.handoffRevision === Number.MAX_SAFE_INTEGER) throw fail('scene_memory_revision_conflict')
          value.handoffRevision++
          value.handoff = { revision: value.handoffRevision, text: input.text, sourceSessionId: origin.sessionId,
            updatedAt: at, operationId: origin.operationId }
        } else {
          const rows = input.action === 'progress' ? value.progress : value.decisions
          if (rows.length >= MAX_JOURNAL_ENTRIES) throw fail('scene_memory_limit_reached')
          rows.push({ entryId: randomUUID(), text: input.text, sourceSessionId: origin.sessionId, createdAt: at })
        }
        return value
      })
    },
  })
}

/** The existing authenticated connection and Main-issued body-bound grant are
 * both mandatory. A scene id supplied in JSON can never select another owner. */
export function createSceneMemoryHandler(ctx, authority) {
  const catalog = createSceneMemoryCatalog(authority)
  return async (req, res) => {
    const respond = (status, body) => { res.statusCode = status; res.setHeader('content-type', 'application/json; charset=utf-8'); res.setHeader('cache-control', 'no-store'); res.end(JSON.stringify(body)) }
    const rejected = ctx.connection.requestRejection(req)
    if (rejected !== undefined) return respond(rejected, { ok: false, error_code: 'request_forbidden' })
    if (req.method !== 'POST') return respond(405, { ok: false, error_code: 'method_not_allowed' })
    try {
      const chunks = []; let size = 0
      for await (const chunk of req) { const bytes = Buffer.from(chunk); size += bytes.length; if (size > 32_768) throw fail('invalid_arguments'); chunks.push(bytes) }
      const bytes = Buffer.concat(chunks), input = JSON.parse(bytes.toString('utf8'))
      if (typeof input.id !== 'string' || !/^[a-f0-9-]{36}$/.test(input.id)) throw fail('invalid_arguments')
      const origin = await authority.verifyRequest({ token: req.headers['x-tradeloom-origin'], endpoint: SCENE_MEMORY_ENDPOINT, routePath: SCENE_MEMORY_ENDPOINT,
        httpMethod: 'POST', method: SCENE_MEMORY_ENDPOINT,
        rpcId: input.id, bodyBytes: bytes, bodyDigest: createHash('sha256').update(bytes).digest('hex'), peerId: 'desktop-scene-memory', peerPrincipal: 'owner' })
      const result = await authority.withVerifiedRequestOrigin(origin, () => catalog.execute(origin, input))
      respond(200, { ok: true, result })
    } catch (error) {
      const known = new Set(['invalid_arguments', 'scene_memory_schema_unsupported', 'scene_memory_revision_conflict', 'scene_memory_limit_reached', 'scene_graph_cursor_invalid', 'scene_graph_snapshot_changed', 'scene_graph_node_not_found', 'scene_graph_target_changed', 'legacy_migration_required', 'stale_role_binding', 'session_not_live', 'operation_revoked', 'operation_expired'])
      respond(409, { ok: false, error_code: known.has(error?.code) ? error.code : 'scene_memory_unavailable' })
    }
  }
}
