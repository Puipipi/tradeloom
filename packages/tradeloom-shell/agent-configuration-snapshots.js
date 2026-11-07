import { createHash, randomUUID } from 'node:crypto'
import { lstat, mkdir, open, readFile, readdir, rename, unlink } from 'node:fs/promises'
import { dirname, join, parse, relative, resolve, sep } from 'node:path'
import { ROLE_IDS, ROLE_PRESETS } from './roles.js'
import { resolveOwnedHome } from './state.js'

export const AGENT_CONFIGURATION_SNAPSHOTS_ROUTE = '/tradeloom/agent-configuration/snapshots'
const FORMAT_VERSION = 1
const SNAPSHOT_SCOPE = Object.freeze(['mcpServers', 'skill', 'deniedTools'])
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const ENV_NAME = /^[A-Z_][A-Z0-9_]*$/

class SnapshotError extends Error {
  constructor(code, status = 400, details = {}) { super(code); this.code = code; this.status = status; Object.assign(this, details) }
}

function isRecord(value) { return value !== null && typeof value === 'object' && !Array.isArray(value) }
function exactKeys(value, keys) { return isRecord(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key)) }
function onlyKeys(value, keys) { return isRecord(value) && Object.keys(value).every(key => keys.includes(key)) }
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (isRecord(value)) return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`
  return JSON.stringify(value)
}
function digest(value) { return createHash('sha256').update(canonical(value)).digest('hex') }
function clone(value) { return JSON.parse(JSON.stringify(value)) }
function sendJson(res, status, value) {
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(JSON.stringify(value))
}
function coded(code, status = 409, details) { return new SnapshotError(code, status, details) }

function validateReference(value) {
  const persisted = exactKeys(value, ['envName', 'scheme'])
  const projected = exactKeys(value, ['envName', 'scheme', 'present']) && typeof value.present === 'boolean'
  if ((!persisted && !projected) || typeof value.envName !== 'string' || !ENV_NAME.test(value.envName)
    || !['raw', 'bearer'].includes(value.scheme)) throw coded('snapshot-invalid')
  return { envName: value.envName, scheme: value.scheme }
}

function validateStringMap(value, keyPattern, maxValue, { references = false, allowPresent = false } = {}) {
  if (!isRecord(value)) throw coded('snapshot-invalid')
  const result = Object.create(null)
  for (const [key, item] of Object.entries(value)) {
    if (!keyPattern.test(key)) throw coded('snapshot-invalid')
    if (references) result[key] = validateReference(item)
    else if (typeof item === 'string' && item.length <= maxValue) result[key] = item
    else throw coded('snapshot-invalid')
  }
  return result
}

function validateServer(server) {
  if (!isRecord(server) || typeof server.id !== 'string' || !/^tradeloom-mcp-[a-z0-9][a-z0-9-]{0,31}$/.test(server.id)
    || typeof server.serverName !== 'string' || !/^[A-Za-z0-9_-]{1,32}$/.test(server.serverName)
    || !Number.isInteger(server.toolCallTimeoutMs) || server.toolCallTimeoutMs < 1 || server.toolCallTimeoutMs > 600_000
    || typeof server.failOnStartupError !== 'boolean') throw coded('snapshot-invalid')
  const common = ['id', 'transport', 'serverName', 'toolCallTimeoutMs', 'failOnStartupError']
  if (server.transport === 'streamable-http') {
    if (!exactKeys(server, [...common, 'url', 'headers']) || typeof server.url !== 'string' || server.url.length > 2048) throw coded('snapshot-invalid')
    let url
    try { url = new URL(server.url) } catch { throw coded('snapshot-invalid') }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw coded('snapshot-invalid')
    return { ...server, headers: validateStringMap(server.headers, /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/, 0, { references: true }) }
  }
  if (server.transport === 'stdio') {
    if (!exactKeys(server, [...common, 'command', 'args', 'cwd', 'env']) || typeof server.command !== 'string'
      || !server.command.trim() || server.command.length > 1024 || typeof server.cwd !== 'string' || server.cwd.length > 1024
      || !Array.isArray(server.args) || server.args.length > 64
      || !server.args.every(value => typeof value === 'string' && value.length <= 4096)) throw coded('snapshot-invalid')
    return { ...server, args: [...server.args], env: validateStringMap(server.env, ENV_NAME, 0, { references: true }) }
  }
  throw coded('snapshot-invalid')
}

function managedProjection(value) {
  if (!onlyKeys(value, ['mcpServers', 'skill', 'deniedTools', 'editable', 'role', 'preset', 'revision'])
    || !Array.isArray(value.mcpServers) || !isRecord(value.skill) || !Array.isArray(value.deniedTools)) {
    throw coded('snapshot-invalid')
  }
  if (Object.hasOwn(value, 'editable') && value.editable !== true
    || Object.hasOwn(value, 'role') && typeof value.role !== 'string'
    || Object.hasOwn(value, 'preset') && typeof value.preset !== 'string'
    || Object.hasOwn(value, 'revision') && (typeof value.revision !== 'string' || !/^[a-f0-9]{64}$/.test(value.revision))) throw coded('snapshot-invalid')
  const servers = value.mcpServers.map(validateServer)
  if (!exactKeys(value.skill, ['includeDefaultRoots', 'customSkillDirs']) || typeof value.skill.includeDefaultRoots !== 'boolean'
    || !Array.isArray(value.skill.customSkillDirs) || value.skill.customSkillDirs.length > 32
    || !value.skill.customSkillDirs.every(path => typeof path === 'string' && path.length > 0 && path.length <= 256
      && !path.includes('\\') && !path.startsWith('/') && !/^[A-Za-z]:/.test(path)
      && path.split('/').every(segment => segment && segment !== '.' && segment !== '..'))) throw coded('snapshot-invalid')
  if (value.deniedTools.length > 200 || !value.deniedTools.every(name => typeof name === 'string' && name.length > 0 && name.length <= 160)
    || new Set(value.deniedTools).size !== value.deniedTools.length) throw coded('snapshot-invalid')
  if (new Set(servers.map(server => server.id)).size !== servers.length || new Set(servers.map(server => server.serverName)).size !== servers.length) {
    throw coded('snapshot-invalid')
  }
  return { mcpServers: servers, skill: { includeDefaultRoots: value.skill.includeDefaultRoots, customSkillDirs: [...value.skill.customSkillDirs] }, deniedTools: [...value.deniedTools] }
}

function snapshotPayload(record) {
  const { checksum, ...payload } = record
  return payload
}

function validateRecord(record, role, snapshotId) {
  const keys = ['formatVersion', 'snapshotId', 'createdAt', 'kind', 'role', 'preset', 'sourceRevision', 'scope', 'projection', 'checksum', 'sourceSnapshotId']
  if (!exactKeys(record, keys) || record.formatVersion !== FORMAT_VERSION || record.snapshotId !== snapshotId || !UUID.test(snapshotId)
    || !['capture', 'pre-restore-backup'].includes(record.kind) || record.role !== role || record.preset !== ROLE_PRESETS[role]
    || typeof record.createdAt !== 'string' || !Number.isFinite(Date.parse(record.createdAt))
    || typeof record.sourceRevision !== 'string' || !/^[a-f0-9]{64}$/.test(record.sourceRevision)
    || !Array.isArray(record.scope) || canonical(record.scope) !== canonical(SNAPSHOT_SCOPE)
    || typeof record.checksum !== 'string' || !/^[a-f0-9]{64}$/.test(record.checksum)
    || (record.kind === 'capture' && record.sourceSnapshotId !== null)
    || (record.kind === 'pre-restore-backup' && (typeof record.sourceSnapshotId !== 'string' || !UUID.test(record.sourceSnapshotId)))) {
    throw coded('snapshot-invalid')
  }
  const projection = managedProjection(record.projection)
  if (canonical(projection) !== canonical(record.projection) || digest(snapshotPayload(record)) !== record.checksum) {
    throw coded('snapshot-checksum-mismatch')
  }
  return record
}

function metadata(record) {
  return {
    snapshotId: record.snapshotId,
    kind: record.kind,
    role: record.role,
    preset: record.preset,
    sourceRevision: record.sourceRevision,
    createdAt: record.createdAt,
    scope: [...record.scope],
    checksum: record.checksum,
    ...(record.sourceSnapshotId ? { sourceSnapshotId: record.sourceSnapshotId } : {}),
  }
}

function inputFromProjection(projection, expectedRevision) {
  return {
    expectedRevision,
    mcpServers: projection.mcpServers.map(server => {
      const result = { ...server }
      delete result.present
      for (const key of ['env', 'headers']) {
        if (isRecord(result[key])) result[key] = Object.fromEntries(Object.entries(result[key]).map(([name, ref]) => [name, { envName: ref.envName, scheme: ref.scheme }]))
      }
      return result
    }),
    skill: clone(projection.skill),
    deniedTools: [...projection.deniedTools],
  }
}

async function assertOwnedPath(home, target) {
  const resolved = resolve(target)
  const rel = relative(home, resolved)
  if (rel === '..' || rel.startsWith(`..${sep}`) || parse(rel).root) throw coded('snapshot-unavailable', 503)
  let cursor = resolved
  while (true) {
    const info = await lstat(cursor).catch(error => error?.code === 'ENOENT' ? undefined : Promise.reject(error))
    if (info?.isSymbolicLink()) throw coded('snapshot-unavailable', 503)
    if (cursor === home || cursor === parse(cursor).root) break
    cursor = dirname(cursor)
  }
}

async function snapshotDirectory(home, role, create = false) {
  const base = join(home, 'tradeloom-agent-configuration-snapshots')
  const directory = join(base, role)
  await assertOwnedPath(home, base)
  if (create) await mkdir(base, { recursive: true })
  await assertOwnedPath(home, base)
  await assertOwnedPath(home, directory)
  if (create) await mkdir(directory, { recursive: true })
  await assertOwnedPath(home, directory)
  return directory
}

async function writeRecord(home, role, record, dependencies) {
  const directory = await snapshotDirectory(home, role, true)
  const target = join(directory, `${record.snapshotId}.json`)
  await assertOwnedPath(home, target)
  if (await lstat(target).then(() => true, error => error?.code === 'ENOENT' ? false : Promise.reject(error))) throw coded('snapshot-unavailable', 503)
  const temporary = join(directory, `.${record.snapshotId}-${randomUUID()}.tmp`)
  await assertOwnedPath(home, temporary)
  let handle
  try {
    handle = await open(temporary, 'wx', 0o600)
    await handle.writeFile(`${JSON.stringify(record, null, 2)}\n`, 'utf8')
    await handle.sync()
    await handle.close()
    handle = undefined
    const renameFile = typeof dependencies.snapshotHooks?.rename === 'function' ? dependencies.snapshotHooks.rename : rename
    await renameFile(temporary, target, record.kind)
    await dependencies.snapshotHooks?.afterSnapshotWrite?.({ kind: record.kind, path: target })
    const stored = await readRecord(home, role, record.snapshotId)
    if (stored.checksum !== record.checksum) throw coded('snapshot-checksum-mismatch')
    return stored
  } catch (error) {
    await handle?.close().catch(() => {})
    await unlink(temporary).catch(() => {})
    if (error instanceof SnapshotError) throw error
    throw coded(record.kind === 'pre-restore-backup' ? 'snapshot-backup-write-failed' : 'snapshot-write-failed', 503)
  }
}

async function readRecord(home, role, snapshotId) {
  if (!UUID.test(snapshotId)) throw coded('snapshot-id-invalid')
  const directory = await snapshotDirectory(home, role)
  const target = join(directory, `${snapshotId}.json`)
  await assertOwnedPath(home, target)
  let text
  try { text = await readFile(target, 'utf8') }
  catch (error) {
    if (error?.code === 'ENOENT') {
      for (const otherRole of ROLE_IDS) {
        if (otherRole === role) continue
        const otherDirectory = await snapshotDirectory(home, otherRole)
        const otherPath = join(otherDirectory, `${snapshotId}.json`)
        await assertOwnedPath(home, otherPath)
        if (await lstat(otherPath).then(() => true, failure => failure?.code === 'ENOENT' ? false : Promise.reject(failure))) {
          throw coded('snapshot-role-conflict')
        }
      }
      throw coded('snapshot-not-found', 404)
    }
    throw coded('snapshot-unavailable', 503)
  }
  let record
  try { record = JSON.parse(text) } catch { throw coded('snapshot-invalid') }
  return validateRecord(record, role, snapshotId)
}

function recordFor({ role, projection, sourceRevision, kind = 'capture', sourceSnapshotId = null }) {
  const payload = {
    formatVersion: FORMAT_VERSION,
    snapshotId: randomUUID(),
    createdAt: new Date().toISOString(),
    kind,
    role,
    preset: ROLE_PRESETS[role],
    sourceRevision,
    scope: [...SNAPSHOT_SCOPE],
    projection: managedProjection(projection),
    sourceSnapshotId,
  }
  return { ...payload, checksum: digest(payload) }
}

function route(req) {
  let url
  try { url = new URL(req.url, 'http://localhost') } catch { throw coded('invalid-query') }
  if (url.pathname !== AGENT_CONFIGURATION_SNAPSHOTS_ROUTE) throw coded('invalid-query')
  const entries = [...url.searchParams.entries()]
  if (req.method === 'POST' && entries.length === 0) return { role: undefined, snapshotId: null }
  const roleRows = entries.filter(([key]) => key === 'role')
  if (roleRows.length !== 1 || !ROLE_IDS.includes(roleRows[0][1])) throw coded('invalid-query')
  const allowed = entries.length === 1 && roleRows.length === 1
    || entries.length === 2 && roleRows.length === 1 && entries.some(([key, value]) => key === 'snapshotId' && UUID.test(value))
  if (!allowed) throw coded('invalid-query')
  return { role: roleRows[0][1], snapshotId: url.searchParams.get('snapshotId') }
}

async function parseBody(req) {
  let size = 0
  const chunks = []
  for await (const chunk of req) {
    size += chunk.byteLength
    if (size > 128 * 1024) { req.resume(); throw coded('request-too-large', 413) }
    chunks.push(chunk)
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { throw coded('invalid-json') }
}

function validateAction(body) {
  const invalidRequest = () => coded('invalid-request', 400)
  if (!isRecord(body) || typeof body.action !== 'string' || !ROLE_IDS.includes(body.role)) throw invalidRequest()
  const shapes = {
    capture: ['action', 'role'],
    preview: ['action', 'role', 'snapshotId'],
    cancel: ['action', 'role', 'previewId'],
    restore: ['action', 'role', 'previewId'],
  }
  const shape = Object.hasOwn(shapes, body.action) ? shapes[body.action] : undefined
  if (!shape || !exactKeys(body, shape)) throw invalidRequest()
  if (body.action === 'preview' && (typeof body.snapshotId !== 'string' || !UUID.test(body.snapshotId))) throw invalidRequest()
  if ((body.action === 'cancel' || body.action === 'restore') && (typeof body.previewId !== 'string' || !UUID.test(body.previewId))) throw invalidRequest()
  return body
}

function previewKey(home, role, id) { return `${resolve(home).toLocaleLowerCase('en-US')}\0${role}\0${id}` }

export function createAgentConfigurationSnapshotsHandler(ctx, dependencies = {}) {
  const controller = dependencies.snapshotOperations
  if (!controller || typeof controller.prepare !== 'function' || typeof controller.withRole !== 'function'
    || typeof controller.sameProviderIdentity !== 'function') {
    throw coded('snapshot-configuration-unavailable', 503)
  }
  const pendingPreviews = new Map()
  let disposed = false
  const assertHandlerOpen = () => {
    if (disposed) throw coded('snapshot-handler-closed', 503)
  }
  try {
    ctx.effect?.(() => () => {
      disposed = true
      pendingPreviews.clear()
    }, 'managed agent configuration snapshot cleanup')
  } catch { disposed = true }
  return async (req, res) => {
    try {
      const rejection = ctx.connection.requestRejection(req)
      if (rejection !== undefined) { res.statusCode = rejection; res.end(); return }
      assertHandlerOpen()
      if (req.method !== 'GET' && req.method !== 'POST') {
        res.statusCode = 405
        res.setHeader('allow', 'GET, POST')
        res.end()
        return
      }
      let parsedRoute
      try { parsedRoute = route(req) } catch (error) { sendJson(res, error.status ?? 400, { error: error.code ?? 'snapshot-unavailable' }); return }
      let role = parsedRoute.role
      const { snapshotId } = parsedRoute
      if (req.method === 'GET') {
        await controller.prepare(role)
        assertHandlerOpen()
        const home = await (dependencies.resolveOwnedHome ?? resolveOwnedHome)(dependencies.env ?? process.env)
        assertHandlerOpen()
        if (snapshotId) {
          const record = await readRecord(home, role, snapshotId)
          assertHandlerOpen()
          sendJson(res, 200, { snapshot: { ...metadata(record), projection: clone(record.projection) } })
          return
        }
        const directory = await snapshotDirectory(home, role)
        const entries = await readdir(directory, { withFileTypes: true }).catch(error => error?.code === 'ENOENT' ? [] : Promise.reject(error))
        const snapshots = []
        for (const entry of entries) {
          if (!entry.isFile() || !entry.name.endsWith('.json')) continue
          const id = entry.name.slice(0, -5)
          if (!UUID.test(id)) continue
          try { snapshots.push(metadata(await readRecord(home, role, id))) }
          catch (error) { snapshots.push({ snapshotId: id, status: 'invalid', errorCode: error.code ?? 'snapshot-unavailable' }) }
        }
        snapshots.sort((left, right) => (right.createdAt ?? '').localeCompare(left.createdAt ?? '') || left.snapshotId.localeCompare(right.snapshotId))
        sendJson(res, 200, { role, snapshots })
        return
      }
      const body = validateAction(await parseBody(req))
      role = body.role
      if (parsedRoute.role !== undefined && body.role !== parsedRoute.role) throw coded('invalid-request')
      const access = await controller.prepare(role)
      if (body.action === 'capture') {
        const result = await controller.withRole(role, async operations => {
          await operations.assertCurrent()
          assertHandlerOpen()
          const current = await operations.read()
          assertHandlerOpen()
          if (!current.editable) throw coded('unsupported-managed-config')
          const record = recordFor({ role, projection: current, sourceRevision: current.revision })
          await writeRecord(await (dependencies.resolveOwnedHome ?? resolveOwnedHome)(dependencies.env ?? process.env), role, record, dependencies)
          assertHandlerOpen()
          await operations.assertCurrent()
          assertHandlerOpen()
          return metadata(record)
        }, access)
        sendJson(res, 201, { snapshot: result })
        return
      }
      if (body.action === 'preview') {
        const home = await (dependencies.resolveOwnedHome ?? resolveOwnedHome)(dependencies.env ?? process.env)
        assertHandlerOpen()
        const record = await readRecord(home, role, body.snapshotId)
        assertHandlerOpen()
        const result = await controller.withRole(role, async operations => {
          await operations.assertCurrent()
          assertHandlerOpen()
          const current = await operations.read()
          assertHandlerOpen()
          if (!current.editable) throw coded('unsupported-managed-config')
          const preview = { previewId: randomUUID(), role, home, snapshotId: record.snapshotId, checksum: record.checksum, currentRevision: current.revision,
            currentProjection: managedProjection(current), providerIdentity: operations.providerIdentity }
          let applicable = true
          let reasons = []
          try {
            const validation = await operations.preview(inputFromProjection(record.projection, current.revision))
            preview.target = managedProjection(validation.target)
            preview.currentProjection = managedProjection(validation.current)
          } catch (error) {
            if (!['invalid-configuration', 'server-name-conflict', 'configuration-unavailable'].includes(error.code)) throw error
            applicable = false
            reasons = [error.code]
          }
          await operations.assertCurrent()
          assertHandlerOpen()
          preview.applicable = applicable
          preview.reasons = reasons
          preview.noOp = applicable && canonical(preview.currentProjection) === canonical(preview.target)
          pendingPreviews.set(previewKey(home, role, preview.previewId), preview)
          return { previewId: preview.previewId, role, snapshot: metadata(record), currentRevision: current.revision,
            current: preview.currentProjection, target: preview.target ?? null, applicable, reasons, noOp: preview.noOp }
        }, access)
        sendJson(res, 200, result)
        return
      }
      const home = await (dependencies.resolveOwnedHome ?? resolveOwnedHome)(dependencies.env ?? process.env)
      assertHandlerOpen()
      if (body.action === 'cancel') {
        const key = previewKey(home, role, body.previewId)
        const pending = pendingPreviews.get(key)
        if (!pending) throw coded('snapshot-preview-not-found', 404)
        pendingPreviews.delete(key)
        sendJson(res, 200, { cancelled: true, previewId: body.previewId })
        return
      }
      const key = previewKey(home, role, body.previewId)
      const pending = pendingPreviews.get(key)
      if (!pending) throw coded('snapshot-preview-not-found', 404)
      const restored = await controller.withRole(role, async operations => {
        if (!controller.sameProviderIdentity(operations.providerIdentity, pending.providerIdentity)) throw coded('snapshot-restore-stale')
        await operations.assertCurrent()
        assertHandlerOpen()
        const current = await operations.read()
        assertHandlerOpen()
        await operations.assertCurrent()
        assertHandlerOpen()
        if (!current.editable) throw coded('unsupported-managed-config')
        if (current.revision !== pending.currentRevision || canonical(managedProjection(current)) !== canonical(pending.currentProjection)) {
          throw coded('snapshot-restore-stale')
        }
        const record = await readRecord(home, role, pending.snapshotId)
        if (record.checksum !== pending.checksum) throw coded('snapshot-checksum-mismatch')
        if (!pending.applicable) throw coded('snapshot-not-applicable')
        if (pending.noOp) return { status: 'no-op', role, snapshot: metadata(record), backupSnapshotId: null,
          appliedForNewAgents: false, currentSessionUnchanged: true }
        await operations.assertCurrent()
        const backup = recordFor({ role, projection: current, sourceRevision: current.revision,
          kind: 'pre-restore-backup', sourceSnapshotId: record.snapshotId })
        await writeRecord(home, role, backup, dependencies)
        try {
          assertHandlerOpen()
          await operations.assertCurrent()
          assertHandlerOpen()
          const updated = await operations.update(inputFromProjection(pending.target, current.revision))
          assertHandlerOpen()
          return { status: 'restored', role, snapshot: metadata(record), backupSnapshotId: backup.snapshotId,
            revision: updated.revision, appliedForNewAgents: true, currentSessionUnchanged: true }
        } catch (error) {
          if (error && typeof error === 'object') error.backupSnapshotId = backup.snapshotId
          throw error
        }
      }, access)
      pendingPreviews.delete(key)
      sendJson(res, 200, restored)
    } catch (error) {
      const known = error instanceof SnapshotError || typeof error?.code === 'string'
      const code = known ? error.code : 'snapshot-unavailable'
      const status = known ? error.status ?? 503 : 503
      const backupSnapshotId = typeof error?.backupSnapshotId === 'string' ? error.backupSnapshotId : undefined
      const restoreStatus = error?.restoreStatus
        ?? (code === 'snapshot-restore-outcome-unknown' && backupSnapshotId ? 'unknown' : undefined)
        ?? (code === 'snapshot-restore-conflict' && backupSnapshotId ? 'conflict' : undefined)
      sendJson(res, status, { error: code, ...(restoreStatus ? { restoreStatus } : {}), ...(backupSnapshotId ? { backupSnapshotId } : {}) })
    }
  }
}
