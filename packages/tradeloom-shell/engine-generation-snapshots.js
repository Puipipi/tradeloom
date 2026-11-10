import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { copyFile, lstat, mkdir, readdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { createReadStream } from 'node:fs'
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path'
import { resolveOwnedHome } from './state.js'

export const ENGINE_GENERATION_SNAPSHOT_SCOPE = 'tradeloom-engine-payload/v1'
export const ENGINE_GENERATION_SNAPSHOT_DIRECTORY = 'tradeloom-engine-generation-snapshots'

const FORMAT_VERSION = 1
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const SHA256 = /^[a-f0-9]{64}$/
const NAME = /^[^/\\\0]{1,255}$/
const RECORD_KEYS = [
  'formatVersion', 'snapshotId', 'createdAt', 'kind', 'generationId', 'runtimeVersion',
  'scope', 'activationRevision', 'entries', 'entryCount', 'fileCount', 'directoryCount',
  'totalBytes', 'checksum',
]

function coded(code, status = 409, details = {}, cause, rollbackCause) {
  const error = cause === undefined ? new Error(code) : new Error(code, { cause })
  error.code = code
  error.status = status
  for (const [key, value] of Object.entries(details)) {
    if (key !== 'cause' && key !== 'rollbackCause') error[key] = value
  }
  if (rollbackCause !== undefined) Object.defineProperty(error, 'rollbackCause', { value: rollbackCause, configurable: true })
  return error
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function exactKeys(value, keys) {
  return isRecord(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key))
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`
  }
  return JSON.stringify(value)
}

function digest(value) {
  return createHash('sha256').update(canonical(value), 'utf8').digest('hex')
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

function samePath(left, right) {
  const a = resolve(left)
  const b = resolve(right)
  return process.platform === 'win32' ? a.toLocaleLowerCase('en-US') === b.toLocaleLowerCase('en-US') : a === b
}

function isWithin(root, target) {
  const rel = relative(root, target)
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
}

function pathsOverlap(left, right) {
  return isWithin(left, right) || isWithin(right, left)
}

function validateRelativePath(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 4096 || value.includes('\\') || value.includes('\0')
    || value.startsWith('/') || /^[a-z]:/i.test(value)) throw coded('engine_generation_invalid', 503)
  const parts = value.split('/')
  if (parts.some(part => !NAME.test(part) || part === '.' || part === '..')) throw coded('engine_generation_invalid', 503)
  return parts
}

function normalizeEntries(entries) {
  if (!Array.isArray(entries) || entries.length === 0) throw coded('engine_generation_invalid', 503)
  const seen = new Set()
  const normalized = entries.map(entry => {
    if (!isRecord(entry) || typeof entry.path !== 'string') throw coded('engine_generation_invalid', 503)
    validateRelativePath(entry.path)
    if (seen.has(entry.path)) throw coded('engine_generation_invalid', 503)
    seen.add(entry.path)
    if (entry.type === 'directory') {
      if (!exactKeys(entry, ['path', 'type'])) throw coded('engine_generation_invalid', 503)
      return { path: entry.path, type: 'directory' }
    }
    if (entry.type === 'file') {
      if (!exactKeys(entry, ['path', 'type', 'size', 'sha256']) || !Number.isSafeInteger(entry.size) || entry.size < 0
        || typeof entry.sha256 !== 'string' || !SHA256.test(entry.sha256)) throw coded('engine_generation_invalid', 503)
      return { path: entry.path, type: 'file', size: entry.size, sha256: entry.sha256 }
    }
    throw coded('engine_generation_invalid', 503)
  }).sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0)
  const totalBytes = normalized.reduce((sum, entry) => sum + (entry.type === 'file' ? entry.size : 0), 0)
  if (!Number.isSafeInteger(totalBytes)) throw coded('engine_generation_invalid', 503)
  return normalized
}

function sameEntries(left, right) {
  return canonical(left) === canonical(right)
}

function validateGeneration(value) {
  const keys = ['generationId', 'runtimeVersion', 'scope', 'activationRevision', 'root', 'entries']
  if (!exactKeys(value, keys)
    || ![value.generationId, value.runtimeVersion, value.scope, value.activationRevision].every(item => typeof item === 'string' && item.length > 0 && item.length <= 512)
    || typeof value.root !== 'string' || !isAbsolute(value.root)) throw coded('engine_generation_invalid', 503)
  const entries = normalizeEntries(value.entries)
  return { ...value, root: resolve(value.root), entries }
}

function payloadOf(record) {
  const { checksum, ...payload } = record
  return payload
}

function validateRecord(value, snapshotId) {
  if (!exactKeys(value, RECORD_KEYS) || value.formatVersion !== FORMAT_VERSION || value.snapshotId !== snapshotId || !ID.test(snapshotId)
    || typeof value.createdAt !== 'string' || !Number.isFinite(Date.parse(value.createdAt))
    || new Date(value.createdAt).toISOString() !== value.createdAt
    || !['generation', 'pre-restore-backup'].includes(value.kind)
    || ![value.generationId, value.runtimeVersion, value.scope, value.activationRevision].every(item => typeof item === 'string' && item.length > 0 && item.length <= 512)
    || typeof value.checksum !== 'string' || !SHA256.test(value.checksum)) throw coded('engine_generation_snapshot_invalid')
  const entries = normalizeEntries(value.entries)
  const files = entries.filter(entry => entry.type === 'file').length
  const directories = entries.length - files
  const totalBytes = entries.reduce((sum, entry) => sum + (entry.type === 'file' ? entry.size : 0), 0)
  if (!sameEntries(entries, value.entries) || value.entryCount !== entries.length || value.fileCount !== files
    || value.directoryCount !== directories || value.totalBytes !== totalBytes || digest(payloadOf(value)) !== value.checksum) {
    throw coded('engine_generation_snapshot_checksum_mismatch')
  }
  return value
}

function publicSnapshot(record) {
  return {
    snapshotId: record.snapshotId,
    createdAt: record.createdAt,
    kind: record.kind,
    generationId: record.generationId,
    runtimeVersion: record.runtimeVersion,
    scope: record.scope,
    activationRevision: record.activationRevision,
    entryCount: record.entryCount,
    fileCount: record.fileCount,
    directoryCount: record.directoryCount,
    totalBytes: record.totalBytes,
    checksum: record.checksum,
  }
}

function publicGeneration(generation) {
  return {
    generationId: generation.generationId,
    runtimeVersion: generation.runtimeVersion,
    scope: generation.scope,
    activationRevision: generation.activationRevision,
    entryCount: generation.entries.length,
    fileCount: generation.entries.filter(entry => entry.type === 'file').length,
    directoryCount: generation.entries.filter(entry => entry.type === 'directory').length,
    totalBytes: generation.entries.reduce((sum, entry) => sum + (entry.type === 'file' ? entry.size : 0), 0),
    inventorySha256: digest(generation.entries),
  }
}

function generationFingerprint(generation) {
  return digest({ ...publicGeneration(generation), root: generation.root })
}

function payloadMatches(record, generation) {
  return record.generationId === generation.generationId
    && record.runtimeVersion === generation.runtimeVersion
    && record.scope === generation.scope
    && sameEntries(record.entries, generation.entries)
}

async function assertNoLinks(target, stopAt) {
  const absolute = resolve(target)
  const stop = resolve(stopAt)
  if (!isWithin(stop, absolute)) throw coded('engine_generation_unavailable', 503)
  let cursor = absolute
  while (true) {
    const info = await lstat(cursor).catch(error => error?.code === 'ENOENT' ? undefined : Promise.reject(error))
    if (info?.isSymbolicLink()) throw coded('engine_generation_unavailable', 503)
    if (cursor === stop || cursor === parse(cursor).root) break
    cursor = dirname(cursor)
  }
}

async function assertOrdinaryDirectory(target, stopAt) {
  await assertNoLinks(target, stopAt)
  const info = await lstat(target).catch(error => error?.code === 'ENOENT' ? undefined : Promise.reject(error))
  if (info && !info.isDirectory()) throw coded('engine_generation_unavailable', 503)
}

async function ensureOwnedDirectory(target, home) {
  await assertOrdinaryDirectory(target, home)
  await mkdir(target, { recursive: true })
  await assertOrdinaryDirectory(target, home)
}

async function hashFile(path) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest('hex')
}

async function scanTree(root) {
  const entries = []
  async function visit(directory, prefix) {
    const names = (await readdir(directory)).sort()
    for (const name of names) {
      if (!NAME.test(name) || name === '.' || name === '..') throw coded('engine_generation_inventory_mismatch')
      const relativePath = prefix ? `${prefix}/${name}` : name
      const absolutePath = join(directory, name)
      const info = await lstat(absolutePath)
      if (info.isSymbolicLink()) throw coded('engine_generation_inventory_mismatch')
      if (info.isDirectory()) {
        entries.push({ path: relativePath, type: 'directory' })
        await visit(absolutePath, relativePath)
      } else if (info.isFile()) {
        entries.push({ path: relativePath, type: 'file', size: info.size, sha256: await hashFile(absolutePath) })
      } else throw coded('engine_generation_inventory_mismatch')
    }
  }
  await visit(root, '')
  return normalizeEntries(entries)
}

function compareEntries(targetEntries, currentEntries) {
  const target = new Map(targetEntries.map(entry => [entry.path, entry]))
  const current = new Map(currentEntries.map(entry => [entry.path, entry]))
  const added = []
  const changed = []
  const removed = []
  for (const [path, entry] of target) {
    const present = current.get(path)
    if (!present) added.push(path)
    else if (canonical(entry) !== canonical(present)) changed.push(path)
  }
  for (const path of current.keys()) if (!target.has(path)) removed.push(path)
  return { added, changed, removed }
}

function sanitizeCode(error, fallback) {
  const code = error?.code
  return typeof code === 'string' && /^engine_[a-z0-9_]+$/.test(code) ? code : fallback
}

export function createEngineGenerationSnapshots(options = {}) {
  const env = options.env ?? process.env
  const getCurrentGeneration = options.getCurrentGeneration
  const activationAdapter = options.activationAdapter
  const hooks = options._testHooks ?? Object.create(null)
  let closed = false
  let mutationTail = Promise.resolve()
  const previews = new Map()

  function assertOpen() {
    if (closed) throw coded('engine_generation_service_closed', 503)
  }

  async function getHome() {
    try { return await resolveOwnedHome(env) } catch { throw coded('engine_generation_unavailable', 503) }
  }

  async function getSnapshotDirectory(home, { create = false } = {}) {
    const directory = join(home, ENGINE_GENERATION_SNAPSHOT_DIRECTORY)
    try {
      if (create) await ensureOwnedDirectory(directory, home)
      else await assertOrdinaryDirectory(directory, home)
      if (!create && !await lstat(directory).then(() => true, error => error?.code === 'ENOENT' ? false : Promise.reject(error))) return undefined
      return directory
    } catch (error) {
      if (error?.code === 'ENOENT' && !create) return undefined
      throw error?.code?.startsWith?.('engine_') ? error : coded('engine_generation_unavailable', 503)
    }
  }

  async function getGeneration() {
    if (typeof getCurrentGeneration !== 'function') throw coded('engine_generation_unavailable', 503)
    let raw
    try { raw = await getCurrentGeneration() } catch { throw coded('engine_generation_unavailable', 503) }
    let generation
    try { generation = validateGeneration(raw) } catch (error) { throw error?.code === 'engine_generation_invalid' ? error : coded('engine_generation_invalid', 503) }
    try {
      const home = await getHome()
      if (pathsOverlap(home, generation.root)) throw coded('engine_generation_source_overlap', 409)
      await assertOrdinaryDirectory(generation.root, parse(generation.root).root)
      const canonicalRoot = await realpath(generation.root)
      if (!samePath(canonicalRoot, generation.root)) throw coded('engine_generation_invalid', 503)
    } catch (error) {
      throw error?.code?.startsWith?.('engine_') ? error : coded('engine_generation_unavailable', 503)
    }
    const actualEntries = await scanTree(generation.root).catch(error => {
      throw error?.code === 'engine_generation_inventory_mismatch' ? error : coded('engine_generation_unavailable', 503)
    })
    if (!sameEntries(actualEntries, generation.entries)) throw coded('engine_generation_inventory_mismatch')
    return generation
  }

  async function resolveSnapshotLocation(home, snapshotId) {
    if (typeof snapshotId !== 'string' || !ID.test(snapshotId)) throw coded('engine_generation_snapshot_id_invalid', 400)
    const base = await getSnapshotDirectory(home)
    if (!base) throw coded('engine_generation_snapshot_not_found', 404)
    const directory = join(base, snapshotId)
    await assertOrdinaryDirectory(directory, home)
    return { base, directory, manifest: join(directory, 'manifest.json'), payload: join(directory, 'payload') }
  }

  async function readRecordAt(directory, snapshotId) {
    try {
      await assertOrdinaryDirectory(directory, (await getHome()))
      const manifestPath = join(directory, 'manifest.json')
      await assertNoLinks(manifestPath, await getHome())
      const info = await lstat(manifestPath)
      if (!info.isFile() || info.isSymbolicLink()) throw coded('engine_generation_snapshot_invalid')
      let parsed
      try { parsed = JSON.parse(await readFile(manifestPath, 'utf8')) } catch { throw coded('engine_generation_snapshot_invalid') }
      return validateRecord(parsed, snapshotId)
    } catch (error) {
      if (error?.code?.startsWith?.('engine_')) throw error
      if (error?.code === 'ENOENT') throw coded('engine_generation_snapshot_not_found', 404)
      throw coded('engine_generation_snapshot_unavailable', 503)
    }
  }

  async function verifyPayload(directory, record) {
    const payloadRoot = join(directory, 'payload')
    await assertOrdinaryDirectory(payloadRoot, await getHome())
    const actual = await scanTree(payloadRoot).catch(error => {
      throw error?.code === 'engine_generation_inventory_mismatch' ? coded('engine_generation_snapshot_checksum_mismatch') : coded('engine_generation_snapshot_unavailable', 503)
    })
    if (!sameEntries(actual, record.entries)) throw coded('engine_generation_snapshot_checksum_mismatch')
  }

  async function loadSnapshot(snapshotId, verify = true) {
    const home = await getHome()
    const location = await resolveSnapshotLocation(home, snapshotId)
    const record = await readRecordAt(location.directory, snapshotId)
    if (verify) await verifyPayload(location.directory, record)
    return { home, ...location, record }
  }

  async function safeRemoveOwnTemp(directory, home, prefix) {
    const absolute = resolve(directory)
    const base = join(home, ENGINE_GENERATION_SNAPSHOT_DIRECTORY)
    if (dirname(absolute) !== resolve(base) || !parse(absolute).base.startsWith(prefix)) return
    try {
      await assertOrdinaryDirectory(base, home)
      const canonicalBase = await realpath(base)
      if (!samePath(canonicalBase, resolve(base)) || !samePath(await realpath(dirname(absolute)), canonicalBase)) return
      await assertNoLinks(absolute, home)
      const info = await lstat(absolute).catch(error => error?.code === 'ENOENT' ? undefined : Promise.reject(error))
      if (info && (!info.isDirectory() || info.isSymbolicLink())) return
      await rm(absolute, { recursive: true, force: true })
    } catch {
      return
    }
  }

  async function writeSnapshot(generation, kind) {
    const home = await getHome()
    const directory = join(home, ENGINE_GENERATION_SNAPSHOT_DIRECTORY)
    if (pathsOverlap(directory, generation.root)) throw coded('engine_generation_source_overlap', 409)
    await ensureOwnedDirectory(directory, home)
    const observed = await scanTree(generation.root).catch(error => {
      throw error?.code === 'engine_generation_inventory_mismatch' ? error : coded('engine_generation_unavailable', 503)
    })
    if (!sameEntries(observed, generation.entries)) throw coded('engine_generation_inventory_mismatch')
    const snapshotId = randomUUID()
    const temp = join(directory, `.tmp-${snapshotId}`)
    const final = join(directory, snapshotId)
    await mkdir(temp, { recursive: false })
    try {
      const payloadRoot = join(temp, 'payload')
      await mkdir(payloadRoot)
      for (const entry of generation.entries.filter(item => item.type === 'directory')) {
        const target = join(payloadRoot, ...entry.path.split('/'))
        await mkdir(target, { recursive: true })
      }
      for (const entry of generation.entries.filter(item => item.type === 'file')) {
        const source = join(generation.root, ...entry.path.split('/'))
        const target = join(payloadRoot, ...entry.path.split('/'))
        await assertNoLinks(source, generation.root)
        const info = await lstat(source)
        if (!info.isFile() || info.isSymbolicLink() || info.size !== entry.size) throw coded('engine_generation_source_changed')
        await mkdir(dirname(target), { recursive: true })
        await copyFile(source, target, constants.COPYFILE_EXCL)
        const copied = await lstat(target)
        if (!copied.isFile() || copied.isSymbolicLink() || copied.size !== entry.size || await hashFile(target) !== entry.sha256) {
          throw coded('engine_generation_source_changed')
        }
      }
      const sourceAfter = await scanTree(generation.root)
      if (!sameEntries(sourceAfter, generation.entries)) throw coded('engine_generation_source_changed')
      const activeAfter = await getGeneration()
      if (generationFingerprint(activeAfter) !== generationFingerprint(generation)) throw coded('engine_generation_source_changed')
      const files = generation.entries.filter(entry => entry.type === 'file').length
      const directoryCount = generation.entries.length - files
      const payload = {
        formatVersion: FORMAT_VERSION,
        snapshotId,
        createdAt: new Date().toISOString(),
        kind,
        generationId: generation.generationId,
        runtimeVersion: generation.runtimeVersion,
        scope: generation.scope,
        activationRevision: generation.activationRevision,
        entries: generation.entries,
        entryCount: generation.entries.length,
        fileCount: files,
        directoryCount,
        totalBytes: generation.entries.reduce((sum, entry) => sum + (entry.type === 'file' ? entry.size : 0), 0),
      }
      const record = { ...payload, checksum: digest(payload) }
      const manifestPath = join(temp, 'manifest.json')
      const handle = await import('node:fs/promises').then(({ open }) => open(manifestPath, 'wx'))
      try {
        await handle.writeFile(`${JSON.stringify(record, null, 2)}\n`, 'utf8')
        await handle.sync()
      } finally { await handle.close() }
      validateRecord(JSON.parse(await readFile(manifestPath, 'utf8')), snapshotId)
      await verifyPayload(temp, record)
      await hooks.beforeSnapshotPublish?.({ kind, snapshotId })
      assertOpen()
      await rename(temp, final)
      const published = await readRecordAt(final, snapshotId)
      await verifyPayload(final, published)
      return published
    } catch (error) {
      await safeRemoveOwnTemp(temp, home, '.tmp-')
      if (await lstat(final).then(() => true, () => false)) await safeRemoveOwnTemp(final, home, snapshotId)
      if (error?.code?.startsWith?.('engine_')) throw error
      throw coded(kind === 'pre-restore-backup' ? 'engine_generation_backup_write_failed' : 'engine_generation_snapshot_write_failed', 503)
    }
  }

  async function readFileFromLoadedSnapshot(loaded, relativePath) {
    const parts = validateRelativePath(relativePath)
    const entry = loaded.record.entries.find(item => item.type === 'file' && item.path === relativePath)
    if (!entry) throw coded('engine_generation_snapshot_invalid')
    const target = join(loaded.payload, ...parts)
    await assertNoLinks(target, loaded.payload)
    const bytes = await readFile(target)
    if (bytes.length !== entry.size || sha256(bytes) !== entry.sha256) throw coded('engine_generation_snapshot_checksum_mismatch')
    return bytes
  }

  function enqueueMutation(callback) {
    assertOpen()
    const operation = mutationTail.then(() => {
      assertOpen()
      return callback()
    })
    mutationTail = operation.catch(() => {})
    return operation
  }

  async function assertPreviewCurrent(preview) {
    const current = await getGeneration()
    if (generationFingerprint(current) !== preview.currentFingerprint) throw coded('engine_generation_preview_stale')
    return current
  }

  async function captureKind(kind) {
    const generation = await getGeneration()
    return publicSnapshot(await writeSnapshot(generation, kind))
  }

  return Object.freeze({
    async capture() {
      return enqueueMutation(() => captureKind('generation'))
    },

    async list() {
      assertOpen()
      const home = await getHome()
      const directory = await getSnapshotDirectory(home)
      if (!directory) return { snapshots: [], invalid: [] }
      const snapshots = []
      const invalid = []
      for (const name of await readdir(directory)) {
        if (!ID.test(name)) continue
        const item = join(directory, name)
        try {
          await assertOrdinaryDirectory(item, home)
          snapshots.push(publicSnapshot(await readRecordAt(item, name)))
        } catch (error) {
          invalid.push({ snapshotId: name, status: 'invalid', errorCode: sanitizeCode(error, 'engine_generation_snapshot_invalid') })
        }
      }
      snapshots.sort((a, b) => a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : a.snapshotId < b.snapshotId ? -1 : 1)
      invalid.sort((a, b) => a.snapshotId < b.snapshotId ? -1 : 1)
      return { snapshots, invalid }
    },

    async export(snapshotId) {
      assertOpen()
      const { record } = await loadSnapshot(snapshotId, true)
      return { ...publicSnapshot(record), entries: record.entries.map(entry => ({ ...entry })) }
    },

    async previewRestore(snapshotId) {
      assertOpen()
      const { record } = await loadSnapshot(snapshotId, true)
      const current = await getGeneration()
      if (record.scope !== current.scope) throw coded('engine_generation_scope_mismatch')
      const previewId = randomUUID()
      const diff = compareEntries(record.entries, current.entries)
      const preview = {
        previewId,
        snapshot: publicSnapshot(record),
        current: publicGeneration(current),
        changes: diff,
        restorable: Boolean(activationAdapter && typeof activationAdapter.prepare === 'function'),
        unavailableCode: activationAdapter && typeof activationAdapter.prepare === 'function' ? null : 'engine_restore_unavailable',
      }
      previews.set(previewId, {
        status: 'pending',
        snapshotId,
        snapshotChecksum: record.checksum,
        currentFingerprint: generationFingerprint(current),
      })
      return preview
    },

    cancelRestorePreview(previewId) {
      assertOpen()
      const preview = previews.get(previewId)
      if (!preview || preview.status !== 'pending') return false
      previews.delete(previewId)
      return true
    },

    async restore(previewId) {
      assertOpen()
      const preview = previews.get(previewId)
      if (!preview || preview.status !== 'pending') throw coded('engine_generation_restore_preview_not_found', 404)
      preview.status = 'applying'
      try {
        return await enqueueMutation(async () => {
          assertOpen()
          if (!activationAdapter || typeof activationAdapter.prepare !== 'function') throw coded('engine_restore_unavailable', 503)
          const loadedTarget = await loadSnapshot(preview.snapshotId, true)
          if (loadedTarget.record.checksum !== preview.snapshotChecksum) throw coded('engine_generation_preview_stale')
          const current = await assertPreviewCurrent(preview)
          if (loadedTarget.record.scope !== current.scope) throw coded('engine_generation_scope_mismatch')
          const target = { ...publicSnapshot(loadedTarget.record), entries: loadedTarget.record.entries.map(entry => ({ ...entry })) }
          const backupRecord = await writeSnapshot(current, 'pre-restore-backup')
          const backup = { ...publicSnapshot(backupRecord), entries: backupRecord.entries.map(entry => ({ ...entry })) }
          let transaction
          let readSnapshotFile
          let commitStarted = false
          try {
            const currentAfterBackup = await assertPreviewCurrent(preview)
            assertOpen()
            const loadedBackup = await loadSnapshot(backup.snapshotId, true)
            const readable = new Map([[loadedTarget.record.snapshotId, loadedTarget], [loadedBackup.record.snapshotId, loadedBackup]])
            readSnapshotFile = async (snapshotId, relativePath) => {
              const loaded = readable.get(snapshotId)
              if (!loaded) throw coded('engine_generation_snapshot_id_invalid', 400)
              return readFileFromLoadedSnapshot(loaded, relativePath)
            }
            const prepared = await activationAdapter.prepare({
              targetSnapshot: target,
              backupSnapshot: backup,
              expectedCurrent: publicGeneration(currentAfterBackup),
              readSnapshotFile,
            })
            if (!prepared || typeof prepared.commit !== 'function' || typeof prepared.rollback !== 'function') {
              throw coded('engine_activation_unavailable', 503)
            }
            transaction = prepared
            const afterPrepare = await assertPreviewCurrent(preview)
            assertOpen()
            commitStarted = true
            await transaction.commit({ expectedCurrent: publicGeneration(afterPrepare) })
            const active = await getGeneration()
            if (!payloadMatches(loadedTarget.record, active)) {
              throw coded('engine_activation_readback_mismatch', 503)
            }
            return {
              status: 'restored',
              snapshot: publicSnapshot(loadedTarget.record),
              backupSnapshotId: backup.snapshotId,
              active: publicGeneration(active),
            }
          } catch (error) {
            if (error?.code === 'engine_restore_rollback_failed' || error?.code === 'engine_restore_state_unknown') throw error
            if (!transaction) {
              if (error?.code === 'engine_generation_preview_stale' || error?.code === 'engine_generation_service_closed') {
                throw coded(error.code, error.status ?? 409, { backupSnapshotId: backup.snapshotId }, error)
              }
              const activeNow = await getGeneration().catch(() => null)
              if (!activeNow) throw coded('engine_restore_state_unknown', 503, { backupSnapshotId: backup.snapshotId, failureCode: sanitizeCode(error, 'engine_activation_prepare_failed') }, error)
              if (!payloadMatches(backupRecord, activeNow)) throw coded('engine_restore_state_unknown', 503, { backupSnapshotId: backup.snapshotId, failureCode: sanitizeCode(error, 'engine_activation_prepare_failed') }, error)
              throw coded('engine_restore_failed', 503, { backupSnapshotId: backup.snapshotId, failureCode: sanitizeCode(error, 'engine_activation_prepare_failed') }, error)
            }
            let active
            try { active = await getGeneration() } catch { active = null }
            if (!commitStarted) {
              try {
                await transaction.rollback({ phase: 'prepared', expectedCurrent: active ? publicGeneration(active) : null, backupSnapshot: backup, readSnapshotFile })
              } catch (rollbackError) {
                throw coded('engine_restore_rollback_failed', 503, { backupSnapshotId: backup.snapshotId, failureCode: sanitizeCode(error, 'engine_activation_prepare_failed') }, error, rollbackError)
              }
              let afterPreparedRollback
              try { afterPreparedRollback = await getGeneration() } catch {
                throw coded('engine_restore_state_unknown', 503, { backupSnapshotId: backup.snapshotId, failureCode: sanitizeCode(error, 'engine_activation_prepare_failed') }, error)
              }
              if (!active || generationFingerprint(active) !== generationFingerprint(afterPreparedRollback)) {
                throw coded('engine_restore_state_unknown', 503, { backupSnapshotId: backup.snapshotId, failureCode: sanitizeCode(error, 'engine_activation_prepare_failed') }, error)
              }
              if (error?.code === 'engine_generation_preview_stale' || error?.code === 'engine_generation_service_closed') {
                throw coded(error.code, error.status ?? 409, { backupSnapshotId: backup.snapshotId }, error)
              }
              if (!payloadMatches(backupRecord, afterPreparedRollback)) throw coded('engine_restore_state_unknown', 503, { backupSnapshotId: backup.snapshotId, failureCode: sanitizeCode(error, 'engine_activation_prepare_failed') }, error)
              throw coded('engine_restore_failed', 503, { backupSnapshotId: backup.snapshotId, failureCode: sanitizeCode(error, 'engine_activation_prepare_failed') }, error)
            }
            if (active && payloadMatches(backupRecord, active)) {
              await rollbackAndFail(transaction, { backup, active, readSnapshotFile, failureCode: sanitizeCode(error, 'engine_activation_failed'), cause: error })
            }
            await rollbackAndFail(transaction, { backup, active, readSnapshotFile, failureCode: sanitizeCode(error, 'engine_activation_failed'), cause: error })
          }
        })
      } finally {
        previews.delete(previewId)
      }
    },

    async dispose() {
      if (closed) {
        await mutationTail
        return
      }
      closed = true
      previews.clear()
      await mutationTail
    },
  })

  async function rollbackAndFail(transaction, { backup, active, readSnapshotFile, failureCode, cause }) {
    try {
      await transaction.rollback({ phase: 'commit', expectedCurrent: active ? publicGeneration(active) : null, backupSnapshot: backup, readSnapshotFile })
    } catch (rollbackCause) {
      throw coded('engine_restore_rollback_failed', 503, { backupSnapshotId: backup.snapshotId, failureCode }, cause, rollbackCause)
    }
    let afterRollback
    try { afterRollback = await getGeneration() } catch {
      throw coded('engine_restore_state_unknown', 503, { backupSnapshotId: backup.snapshotId, failureCode }, cause)
    }
    if (!payloadMatches(backup, afterRollback)) {
      throw coded('engine_restore_state_unknown', 503, { backupSnapshotId: backup.snapshotId, failureCode }, cause)
    }
    throw coded('engine_restore_failed', 503, { backupSnapshotId: backup.snapshotId, failureCode }, cause)
  }
}
