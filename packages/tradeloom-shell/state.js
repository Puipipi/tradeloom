import { createHash, randomUUID } from 'node:crypto'
import { lstat, mkdir, open, readFile, realpath, rename, readdir, unlink } from 'node:fs/promises'
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { ROLE_IDS } from './roles.js'

export const HOME_MARKER = '.tradeloom-owned'
export const HOME_MARKER_VALUE = 'tradeloom-dsh-apphome-v1\n'
export { ROLE_IDS } from './roles.js'

const initialState = () => ({ version: 1, roles: {}, roleBindingRevisions: Object.fromEntries(ROLE_IDS.map(role => [role, '0'])), budgets: {}, sessionCreateOperations: {}, pendingSessionCreateByRole: {}, userProfile: { displayName: '演示资料（待配置）', notes: '' }, sceneWorkbench: null, dockLayouts: { version: 2, scenes: {} } })
const samePath = (left, right) => resolve(left).toLocaleLowerCase('en-US') === resolve(right).toLocaleLowerCase('en-US')
const writeQueues = new Map()
const restorePreviews = new Map()
const ROLE_BINDING_REVISION = /^(?:0|[1-9][0-9]{0,63})$/
const SNAPSHOT_SCOPE = 'tradeloom-state/config-layout-v1'
const SNAPSHOT_SECTIONS = Object.freeze(['userProfile', 'sceneWorkbench', 'dockLayouts'])
const SNAPSHOT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const SCENE_PROFILE_SNAPSHOT_SCENE_ID = /^[a-z][a-z0-9-]{0,63}$/
const SCENE_MEMORY_FILE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const SNAPSHOT_FORMAT_VERSION = 1
const RESTORE_PREVIEW_TTL_MS = 5 * 60 * 1000

function codedError(code, message) {
  const error = new Error(message)
  error.code = code
  return error
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value))
}

function snapshotPayload(state) {
  const presentSections = SNAPSHOT_SECTIONS.filter(section => Object.hasOwn(state, section))
  const payload = Object.fromEntries(presentSections.map(section => [section, cloneJson(state[section])]))
  validateSnapshotPayload(presentSections, payload)
  return { sections: [...SNAPSHOT_SECTIONS], presentSections, payload }
}

function validateSnapshotPayload(presentSections, payload) {
  if (!Array.isArray(presentSections) || !isRecord(payload)
    || presentSections.some((section, index) => !SNAPSHOT_SECTIONS.includes(section)
      || (index > 0 && SNAPSHOT_SECTIONS.indexOf(presentSections[index - 1]) >= SNAPSHOT_SECTIONS.indexOf(section)))
    || Object.keys(payload).length !== presentSections.length
    || presentSections.some(section => !Object.hasOwn(payload, section))) {
    throw codedError('snapshot_invalid', 'snapshot payload has an unsupported shape')
  }
  if (Object.hasOwn(payload, 'userProfile') && !isRecord(payload.userProfile)) {
    throw codedError('snapshot_invalid', 'snapshot userProfile has an unsupported shape')
  }
  if (Object.hasOwn(payload, 'sceneWorkbench') && payload.sceneWorkbench !== null && !isRecord(payload.sceneWorkbench)) {
    throw codedError('snapshot_invalid', 'snapshot sceneWorkbench has an unsupported shape')
  }
  if (Object.hasOwn(payload, 'dockLayouts')) {
    const layout = payload.dockLayouts
    if (!isRecord(layout) || layout.version !== 2 || !isRecord(layout.scenes)) {
      throw codedError('snapshot_invalid', 'snapshot dockLayouts has an unsupported shape')
    }
  }
}

function snapshotPayloadBytes(scopeParts) {
  return JSON.stringify({ scope: SNAPSHOT_SCOPE, ...scopeParts })
}

function snapshotPayloadSha256(scopeParts) {
  return createHash('sha256').update(snapshotPayloadBytes(scopeParts), 'utf8').digest('hex')
}

function snapshotRecordPayload(record) {
  return {
    sections: record.sections,
    presentSections: record.presentSections,
    payload: record.payload,
  }
}

function validateSnapshotRecord(record, expectedId) {
  const expectedKeys = ['formatVersion', 'snapshotId', 'createdAt', 'kind', 'scope', 'sections', 'presentSections', 'payload', 'payloadSha256', 'sourceSnapshotId']
  if (!isRecord(record) || Object.keys(record).length !== expectedKeys.length
    || expectedKeys.some(key => !Object.hasOwn(record, key))) {
    throw codedError('snapshot_invalid', 'snapshot envelope has an unsupported shape')
  }
  if (record.formatVersion !== SNAPSHOT_FORMAT_VERSION || typeof record.snapshotId !== 'string' || !SNAPSHOT_ID.test(record.snapshotId)
    || (expectedId !== undefined && record.snapshotId !== expectedId)
    || !['capture', 'pre-restore-backup'].includes(record.kind)
    || record.scope !== SNAPSHOT_SCOPE
    || typeof record.createdAt !== 'string'
    || Number.isNaN(Date.parse(record.createdAt))
    || !isCanonicalTimestamp(record.createdAt)
    || (record.kind === 'capture' && record.sourceSnapshotId !== null)
    || (record.kind === 'pre-restore-backup' && (typeof record.sourceSnapshotId !== 'string' || !SNAPSHOT_ID.test(record.sourceSnapshotId)))
    || typeof record.payloadSha256 !== 'string' || !/^[0-9a-f]{64}$/.test(record.payloadSha256)) {
    throw codedError('snapshot_invalid', 'snapshot metadata is invalid')
  }
  if (JSON.stringify(record.sections) !== JSON.stringify(SNAPSHOT_SECTIONS)) {
    throw codedError('snapshot_invalid', 'snapshot scope is unsupported')
  }
  validateSnapshotPayload(record.presentSections, record.payload)
  if (snapshotPayloadSha256(snapshotRecordPayload(record)) !== record.payloadSha256) {
    throw codedError('snapshot_checksum_mismatch', 'snapshot checksum does not match its payload')
  }
  return record
}

function isCanonicalTimestamp(value) {
  try { return new Date(value).toISOString() === value } catch { return false }
}

function snapshotMetadata(record, status = 'valid') {
  return {
    snapshotId: record.snapshotId,
    createdAt: record.createdAt,
    kind: record.kind,
    scope: record.scope,
    sections: [...record.sections],
    payloadSha256: record.payloadSha256,
    sourceSnapshotId: record.sourceSnapshotId,
    status,
  }
}

function roleBindingTuple(binding) {
  if (!binding || typeof binding !== 'object' || Array.isArray(binding)
    || typeof binding.sessionId !== 'string' || binding.sessionId.length === 0) return null
  return JSON.stringify([
    binding.sessionId,
    binding.workspaceId ?? null,
    binding.workspacePath ?? null,
    binding.agentPreset ?? null,
  ])
}

function initialRoleBindingRevision(binding) {
  return roleBindingTuple(binding) === null ? '0' : '1'
}

function normalizedRoleBindingRevisions(state) {
  const stored = state.roleBindingRevisions
  if (stored !== undefined && (stored === null || typeof stored !== 'object' || Array.isArray(stored))) {
    throw new Error('TradeLoom state file has an invalid role binding revision map')
  }
  return Object.fromEntries(ROLE_IDS.map(role => {
    if (stored === undefined) return [role, initialRoleBindingRevision(state.roles?.[role])]
    if (!Object.hasOwn(stored, role) || typeof stored[role] !== 'string' || !ROLE_BINDING_REVISION.test(stored[role])) {
      throw new Error('TradeLoom state file has an invalid role binding revision')
    }
    const revision = stored[role]
    return [role, revision === '0' && roleBindingTuple(state.roles?.[role]) !== null ? '1' : revision]
  }))
}

function nextRoleBindingRevision(revision) {
  const next = (BigInt(revision) + 1n).toString()
  if (!ROLE_BINDING_REVISION.test(next)) throw new Error('TradeLoom role binding revision is exhausted')
  return next
}

function stripRoleBindingRevisionFields(state) {
  for (const role of ROLE_IDS) {
    const binding = state.roles?.[role]
    if (binding && typeof binding === 'object' && !Array.isArray(binding)) delete binding.bindingRevision
  }
}

/** Read the stable persisted revision, or the deterministic legacy seed for an unmigrated state. */
export function getRoleBindingRevision(state, role) {
  if (!ROLE_IDS.includes(role)) throw new Error('unknown TradeLoom role')
  const revision = state?.roleBindingRevisions?.[role]
  if (typeof revision === 'string' && ROLE_BINDING_REVISION.test(revision)) {
    return revision === '0' && roleBindingTuple(state?.roles?.[role]) !== null ? '1' : revision
  }
  return initialRoleBindingRevision(state?.roles?.[role])
}

/** Replace one Host-owned role binding and return its transaction-local revision. */
export function replaceRoleBinding(state, role, binding) {
  if (!ROLE_IDS.includes(role)) throw new Error('unknown TradeLoom role')
  if (!binding || typeof binding !== 'object' || Array.isArray(binding)) throw new Error('invalid TradeLoom role binding')
  const revisions = normalizedRoleBindingRevisions(state)
  const previousTuple = roleBindingTuple(state.roles?.[role])
  const replacement = {
    sessionId: binding.sessionId,
    workspaceId: binding.workspaceId ?? null,
    workspacePath: binding.workspacePath ?? null,
    agentPreset: binding.agentPreset ?? null,
  }
  const changed = previousTuple !== roleBindingTuple(replacement)
  const revision = changed ? nextRoleBindingRevision(revisions[role]) : revisions[role]
  state.roles[role] = replacement
  state.roleBindingRevisions = { ...revisions, [role]: revision }
  return revision
}

async function assertNoLinks(path, stopAt) {
  const target = resolve(path)
  const stop = resolve(stopAt)
  const rel = relative(stop, target)
  if (rel.startsWith(`..${sep}`) || rel === '..' || isAbsolute(rel)) throw new Error('path is outside the configured TradeLoom DSH_HOME')
  let cursor = target
  while (true) {
    const info = await lstat(cursor).catch(() => undefined)
    if (info?.isSymbolicLink()) throw new Error('reparse points are not allowed below the configured TradeLoom DSH_HOME')
    if (cursor === stop || cursor === parse(cursor).root) break
    cursor = dirname(cursor)
  }
}

export async function resolveOwnedHome(env = process.env) {
  const configured = env.TRADELOOM_DSH_APP_HOME
  const dshHome = env.DSH_HOME
  if (typeof configured !== 'string' || configured.length === 0 || !isAbsolute(configured)
    || typeof dshHome !== 'string' || dshHome.length === 0 || !isAbsolute(dshHome)) {
    throw new Error('TradeLoom state is disabled: explicit TRADELOOM_DSH_APP_HOME and DSH_HOME are required')
  }
  if (!samePath(configured, dshHome)) throw new Error('TradeLoom state is disabled: configured app home must equal DSH_HOME')
  const home = resolve(configured)
  await assertNoLinks(home, dirname(home))
  const canonical = await realpath(home).catch(() => undefined)
  if (canonical === undefined || !samePath(canonical, home)) throw new Error('TradeLoom state is disabled: DSH_HOME is missing or resolves through a reparse point')
  const markerPath = join(home, HOME_MARKER)
  await assertNoLinks(markerPath, home)
  const marker = await readFile(markerPath, 'utf8').catch(() => '')
  if (marker !== HOME_MARKER_VALUE) throw new Error('TradeLoom state is disabled: app-owned DSH_HOME marker is missing or invalid')
  await assertNoLinks(home, home)
  return home
}

export async function roleWorkspacePath(role, env = process.env) {
  if (!ROLE_IDS.includes(role)) throw new Error('unknown TradeLoom role')
  const home = await resolveOwnedHome(env)
  const parent = join(home, 'tradeloom-workspaces')
  const target = join(parent, role)
  await assertNoLinks(parent, home)
  await assertNoLinks(target, home)
  await mkdir(target, { recursive: true })
  await assertNoLinks(target, home)
  return target
}

/** Resolve a role workspace without creating it; used by read-only configuration previews. */
export async function roleWorkspacePathReadOnly(role, env = process.env) {
  if (!ROLE_IDS.includes(role)) throw new Error('unknown TradeLoom role')
  const home = await resolveOwnedHome(env)
  const parent = join(home, 'tradeloom-workspaces')
  const target = join(parent, role)
  await assertNoLinks(parent, home)
  await assertNoLinks(target, home)
  return target
}

export async function createStateStore(options = {}) {
  const env = options.env ?? process.env
  const testHooks = options._testHooks ?? Object.create(null)
  const home = await resolveOwnedHome(env)
  const directory = join(home, 'tradeloom-state')
  await assertNoLinks(directory, home)
  await mkdir(directory, { recursive: true })
  await assertNoLinks(directory, home)
  const statePath = join(directory, 'state.json')
  const snapshotDirectory = join(directory, 'snapshots')
  const sceneProfileSnapshotDirectory = join(snapshotDirectory, 'scene-profile')
  const sceneMemorySnapshotDirectory = join(snapshotDirectory, 'scene-memory')
  const sceneMemoryMigrationBackupDirectory = join(directory, 'scene-memory-migration-backups')

  async function ensureSnapshotDirectory() {
    await assertNoLinks(snapshotDirectory, home)
    await mkdir(snapshotDirectory, { recursive: true })
    await assertNoLinks(snapshotDirectory, home)
  }

  async function ensureSceneProfileSnapshotDirectory(sceneId) {
    if (typeof sceneId !== 'string' || !SCENE_PROFILE_SNAPSHOT_SCENE_ID.test(sceneId)) {
      throw codedError('scene_profile_snapshot_invalid', 'scene profile snapshot scene id is invalid')
    }
    const sceneDirectory = join(sceneProfileSnapshotDirectory, sceneId)
    await assertNoLinks(sceneProfileSnapshotDirectory, home)
    await mkdir(sceneProfileSnapshotDirectory, { recursive: true })
    await assertNoLinks(sceneProfileSnapshotDirectory, home)
    await assertNoLinks(sceneDirectory, home)
    await mkdir(sceneDirectory, { recursive: true })
    await assertNoLinks(sceneDirectory, home)
    return sceneDirectory
  }

  function sceneProfileSnapshotPath(sceneId, snapshotId) {
    if (typeof sceneId !== 'string' || !SCENE_PROFILE_SNAPSHOT_SCENE_ID.test(sceneId)
      || typeof snapshotId !== 'string' || !SNAPSHOT_ID.test(snapshotId)) {
      throw codedError('scene_profile_snapshot_invalid', 'scene profile snapshot identity is invalid')
    }
    return join(sceneProfileSnapshotDirectory, sceneId, `${snapshotId}.json`)
  }

  async function writeSceneProfileSnapshotFile(sceneId, snapshotId, record, kind) {
    if (!['capture', 'pre-restore-backup'].includes(kind)) {
      throw codedError('scene_profile_snapshot_invalid', 'scene profile snapshot kind is invalid')
    }
    await ensureSceneProfileSnapshotDirectory(sceneId)
    const target = sceneProfileSnapshotPath(sceneId, snapshotId)
    await assertNoLinks(target, home)
    const exists = await lstat(target).then(() => true, error => error?.code === 'ENOENT' ? false : Promise.reject(error))
    if (exists) throw codedError('scene_profile_snapshot_exists', 'scene profile snapshot already exists')
    await atomicWrite(target, `${JSON.stringify(record, null, 2)}\n`, `scene-profile-${kind}`)
  }

  async function readSceneProfileSnapshotFile(sceneId, snapshotId) {
    const target = sceneProfileSnapshotPath(sceneId, snapshotId)
    await assertNoLinks(target, home)
    let text
    try { text = await readFile(target, 'utf8') } catch (error) {
      if (error?.code === 'ENOENT') throw codedError('scene_profile_snapshot_not_found', 'scene profile snapshot was not found')
      throw codedError('scene_profile_snapshot_unavailable', 'scene profile snapshot could not be read')
    }
    try { return JSON.parse(text) } catch {
      throw codedError('scene_profile_snapshot_invalid', 'scene profile snapshot JSON is invalid')
    }
  }

  async function listSceneProfileSnapshotFiles(sceneId) {
    if (typeof sceneId !== 'string' || !SCENE_PROFILE_SNAPSHOT_SCENE_ID.test(sceneId)) {
      throw codedError('scene_profile_snapshot_invalid', 'scene profile snapshot scene id is invalid')
    }
    const sceneDirectory = join(sceneProfileSnapshotDirectory, sceneId)
    try {
      await assertNoLinks(sceneDirectory, home)
      const entries = await readdir(sceneDirectory, { withFileTypes: true })
      return entries.filter(entry => entry.isFile() && entry.name.endsWith('.json'))
        .map(entry => entry.name.slice(0, -5)).filter(id => SNAPSHOT_ID.test(id))
    } catch (error) {
      if (error?.code === 'ENOENT') return []
      throw codedError('scene_profile_snapshot_unavailable', 'scene profile snapshots could not be listed')
    }
  }

  function sceneMemorySnapshotPath(sceneId, snapshotId, migration = false) {
    if (typeof snapshotId !== 'string' || !SCENE_MEMORY_FILE_ID.test(snapshotId)
      || (!migration && (typeof sceneId !== 'string' || !SCENE_PROFILE_SNAPSHOT_SCENE_ID.test(sceneId)))) {
      throw codedError('scene_memory_snapshot_invalid', 'scene memory snapshot identity is invalid')
    }
    return migration
      ? join(sceneMemoryMigrationBackupDirectory, `${snapshotId}.json`)
      : join(sceneMemorySnapshotDirectory, sceneId, `${snapshotId}.json`)
  }

  async function ensureSceneMemorySnapshotDirectory(sceneId, migration = false) {
    if (!migration && (typeof sceneId !== 'string' || !SCENE_PROFILE_SNAPSHOT_SCENE_ID.test(sceneId))) {
      throw codedError('scene_memory_snapshot_invalid', 'scene memory snapshot scene id is invalid')
    }
    const base = migration ? sceneMemoryMigrationBackupDirectory : join(sceneMemorySnapshotDirectory, sceneId)
    await assertNoLinks(sceneMemorySnapshotDirectory, home)
    await mkdir(sceneMemorySnapshotDirectory, { recursive: true })
    await assertNoLinks(sceneMemorySnapshotDirectory, home)
    await assertNoLinks(base, home)
    await mkdir(base, { recursive: true })
    await assertNoLinks(base, home)
    return base
  }

  async function writeSceneMemorySnapshotFile(sceneId, snapshotId, record, kind, migration = false) {
    if (!['capture', 'pre-restore-backup', 'migration-backup'].includes(kind)
      || (migration !== (kind === 'migration-backup'))) {
      throw codedError('scene_memory_snapshot_invalid', 'scene memory snapshot kind is invalid')
    }
    await ensureSceneMemorySnapshotDirectory(sceneId, migration)
    const target = sceneMemorySnapshotPath(sceneId, snapshotId, migration)
    await assertNoLinks(target, home)
    const exists = await lstat(target).then(() => true, failure => failure?.code === 'ENOENT' ? false : Promise.reject(failure))
    if (exists) throw codedError('scene_memory_snapshot_exists', 'scene memory snapshot already exists')
    await atomicWrite(target, `${JSON.stringify(record, null, 2)}\n`, `scene-memory-${kind}`)
  }

  async function readSceneMemorySnapshotFile(sceneId, snapshotId, migration = false) {
    const target = sceneMemorySnapshotPath(sceneId, snapshotId, migration)
    await assertNoLinks(target, home)
    let text
    try { text = await readFile(target, 'utf8') } catch (failure) {
      if (failure?.code === 'ENOENT') throw codedError('scene_memory_snapshot_not_found', 'scene memory snapshot was not found')
      throw codedError('scene_memory_snapshot_unavailable', 'scene memory snapshot could not be read')
    }
    try { return JSON.parse(text) } catch {
      throw codedError('scene_memory_snapshot_invalid', 'scene memory snapshot JSON is invalid')
    }
  }

  async function listSceneMemorySnapshotFiles(sceneId, migration = false) {
    if (!migration && (typeof sceneId !== 'string' || !SCENE_PROFILE_SNAPSHOT_SCENE_ID.test(sceneId))) {
      throw codedError('scene_memory_snapshot_invalid', 'scene memory snapshot scene id is invalid')
    }
    const directory = migration ? sceneMemoryMigrationBackupDirectory : join(sceneMemorySnapshotDirectory, sceneId)
    try {
      await assertNoLinks(directory, home)
      const entries = await readdir(directory, { withFileTypes: true })
      return entries.filter(entry => entry.isFile() && entry.name.endsWith('.json'))
        .map(entry => entry.name.slice(0, -5)).filter(id => SCENE_MEMORY_FILE_ID.test(id))
    } catch (failure) {
      if (failure?.code === 'ENOENT') return []
      throw codedError('scene_memory_snapshot_unavailable', 'scene memory snapshots could not be listed')
    }
  }

  async function atomicWrite(target, text, kind) {
    const temporary = join(dirname(target), `.${parse(target).name}-${randomUUID()}.tmp`)
    await assertNoLinks(temporary, home)
    const handle = await open(temporary, 'wx', 0o600)
    try {
      await handle.writeFile(text, 'utf8')
      await handle.sync()
    } finally { await handle.close() }
    try {
      const renameFile = typeof testHooks.rename === 'function' ? testHooks.rename : rename
      if (process.platform === 'win32') {
        const retryDelays = [20, 50, 100]
        let initialRenameError
        for (let attempt = 0; ; attempt += 1) {
          try {
            await renameFile(temporary, target, kind)
            break
          } catch (error) {
            if (!['EPERM', 'EBUSY'].includes(error?.code)) throw error
            initialRenameError ??= error
            if (attempt >= retryDelays.length) throw initialRenameError
            await delay(retryDelays[attempt])
          }
        }
      } else {
        await renameFile(temporary, target, kind)
      }
      if (typeof testHooks.afterSnapshotWrite === 'function' && kind !== 'state') {
        await testHooks.afterSnapshotWrite({ kind, path: target })
      }
    } catch (error) {
      await unlink(temporary).catch(() => {})
      throw error
    }
  }

  async function read() {
    await assertNoLinks(statePath, home)
    const text = await readFile(statePath, 'utf8').catch(error => error?.code === 'ENOENT' ? null : Promise.reject(error))
    if (text === null) return initialState()
    const value = JSON.parse(text)
    if (value?.version !== 1 || typeof value.roles !== 'object' || typeof value.budgets !== 'object') {
      throw new Error('TradeLoom state file has an unsupported or corrupt format')
    }
    if (value.dockLayouts === undefined) value.dockLayouts = { version: 2, scenes: {} }
    stripRoleBindingRevisionFields(value)
    value.roleBindingRevisions = normalizedRoleBindingRevisions(value)
    return value
  }

  const queueKey = resolve(statePath).toLocaleLowerCase('en-US')

  async function transact(mutator) {
    const previous = writeQueues.get(queueKey) ?? Promise.resolve()
    let release
    const gate = new Promise(resolveGate => { release = resolveGate })
    const tail = previous.then(() => gate)
    writeQueues.set(queueKey, tail)
    await previous
    try {
      const state = await read()
      const previousTuples = Object.fromEntries(ROLE_IDS.map(role => [role, roleBindingTuple(state.roles?.[role])]))
      const previousRevisions = { ...state.roleBindingRevisions }
      const result = await mutator(state)
      stripRoleBindingRevisionFields(state)
      state.roleBindingRevisions = Object.fromEntries(ROLE_IDS.map(role => [
        role,
        previousTuples[role] === roleBindingTuple(state.roles?.[role])
          ? previousRevisions[role]
          : nextRoleBindingRevision(previousRevisions[role]),
      ]))
      await atomicWrite(statePath, `${JSON.stringify(state, null, 2)}\n`, 'state')
      return result
    } finally {
      release()
      if (writeQueues.get(queueKey) === tail) writeQueues.delete(queueKey)
    }
  }

  async function readSnapshotRecord(snapshotId) {
    if (typeof snapshotId !== 'string' || !SNAPSHOT_ID.test(snapshotId)) {
      throw codedError('snapshot_id_invalid', 'snapshot id is invalid')
    }
    const path = join(snapshotDirectory, `${snapshotId}.json`)
    let text
    try {
      await assertNoLinks(path, home)
      text = await readFile(path, 'utf8')
    } catch (error) {
      if (error?.code === 'ENOENT') throw codedError('snapshot_not_found', 'snapshot was not found')
      throw codedError('snapshot_unavailable', 'snapshot could not be read')
    }
    let record
    try { record = JSON.parse(text) } catch (error) {
      throw codedError('snapshot_invalid', 'snapshot JSON is invalid')
    }
    return validateSnapshotRecord(record, snapshotId)
  }

  async function writeSnapshotRecord(record) {
    const path = join(snapshotDirectory, `${record.snapshotId}.json`)
    try {
      await ensureSnapshotDirectory()
      await assertNoLinks(path, home)
      await atomicWrite(path, `${JSON.stringify(record, null, 2)}\n`, record.kind)
    } catch (error) {
      throw codedError(record.kind === 'pre-restore-backup' ? 'backup_write_failed' : 'snapshot_write_failed', 'snapshot record could not be written')
    }
    try {
      const stored = await readSnapshotRecord(record.snapshotId)
      if (stored.payloadSha256 !== record.payloadSha256) throw codedError('snapshot_checksum_mismatch', 'stored snapshot checksum changed')
      return stored
    } catch (error) {
      throw codedError(record.kind === 'pre-restore-backup' ? 'backup_verification_failed' : 'snapshot_verification_failed', 'stored snapshot could not be verified')
    }
  }

  function makeSnapshotRecord(state, { kind = 'capture', sourceSnapshotId = null, snapshotId = randomUUID() } = {}) {
    const payload = snapshotPayload(state)
    const record = {
      formatVersion: SNAPSHOT_FORMAT_VERSION,
      snapshotId,
      createdAt: new Date().toISOString(),
      kind,
      scope: SNAPSHOT_SCOPE,
      ...payload,
      payloadSha256: snapshotPayloadSha256(payload),
      sourceSnapshotId,
    }
    return validateSnapshotRecord(record, snapshotId)
  }

  async function captureSnapshot(request = {}) {
    if (!isRecord(request) || Object.keys(request).some(key => key !== 'scope')
      || (request.scope !== undefined && request.scope !== SNAPSHOT_SCOPE)) {
      throw codedError('snapshot_scope_unsupported', 'only the configuration and layout state scope is supported')
    }
    let state
    try { state = await read() } catch { throw codedError('state_unavailable', 'current state could not be read') }
    const record = makeSnapshotRecord(state)
    await writeSnapshotRecord(record)
    return snapshotMetadata(record)
  }

  async function listSnapshots() {
    let entries
    try {
      await assertNoLinks(snapshotDirectory, home)
      entries = await readdir(snapshotDirectory, { withFileTypes: true })
    } catch (error) {
      if (error?.code === 'ENOENT') return []
      throw codedError('snapshot_unavailable', 'snapshot list could not be read', error)
    }
    const ids = entries.filter(entry => entry.isFile() && entry.name.endsWith('.json'))
      .map(entry => entry.name.slice(0, -5)).filter(id => SNAPSHOT_ID.test(id))
    const records = []
    for (const id of ids) {
      try { records.push(snapshotMetadata(await readSnapshotRecord(id))) } catch (error) {
        records.push({ snapshotId: id, status: 'invalid', errorCode: error?.code ?? 'snapshot_unavailable' })
      }
    }
    return records.sort((left, right) => (right.createdAt ?? '').localeCompare(left.createdAt ?? '') || left.snapshotId.localeCompare(right.snapshotId))
  }

  async function exportSnapshot(snapshotId) {
    return cloneJson(await readSnapshotRecord(snapshotId))
  }

  function expireRestorePreviews(now = Date.now()) {
    for (const [id, preview] of restorePreviews) {
      if (preview.expiresAt <= now) restorePreviews.delete(id)
    }
  }

  async function previewRestore(snapshotId) {
    const record = await readSnapshotRecord(snapshotId)
    let state
    try { state = await read() } catch { throw codedError('state_unavailable', 'current state could not be read') }
    const current = snapshotPayload(state)
    const changedSections = SNAPSHOT_SECTIONS.filter(section => {
      const currentHas = current.presentSections.includes(section)
      const targetHas = record.presentSections.includes(section)
      return currentHas !== targetHas || (currentHas && JSON.stringify(current.payload[section]) !== JSON.stringify(record.payload[section]))
    })
    expireRestorePreviews()
    const previewId = randomUUID()
    const expiresAt = Date.now() + RESTORE_PREVIEW_TTL_MS
    restorePreviews.set(previewId, {
      statePath: resolve(statePath).toLocaleLowerCase('en-US'),
      snapshotId,
      snapshotSha256: record.payloadSha256,
      currentScopeSha256: snapshotPayloadSha256(current),
      expiresAt,
      changedSections: [...changedSections],
    })
    return {
      previewId,
      snapshotId,
      snapshotSha256: record.payloadSha256,
      scope: SNAPSHOT_SCOPE,
      changedSections,
      expiresAt: new Date(expiresAt).toISOString(),
    }
  }

  function cancelRestorePreview(previewId) {
    const preview = restorePreviews.get(previewId)
    if (!preview || preview.statePath !== resolve(statePath).toLocaleLowerCase('en-US') || preview.applying) return false
    return restorePreviews.delete(previewId)
  }

  async function restoreSnapshot(previewId) {
    const key = resolve(statePath).toLocaleLowerCase('en-US')
    const preview = restorePreviews.get(previewId)
    if (!preview || preview.statePath !== key) {
      throw codedError('restore_preview_unavailable', 'restore preview is unavailable or belongs to another state store')
    }
    if (preview.expiresAt <= Date.now() || preview.applying) {
      restorePreviews.delete(previewId)
      throw codedError('restore_preview_unavailable', 'restore preview is unavailable, expired, or already being applied')
    }
    preview.applying = true
    let stateMutationReady = false
    try {
      return await transact(async state => {
        const current = snapshotPayload(state)
        if (snapshotPayloadSha256(current) !== preview.currentScopeSha256) {
          throw codedError('restore_preview_stale', 'configuration or layout state changed after preview')
        }
        const target = await readSnapshotRecord(preview.snapshotId)
        if (target.payloadSha256 !== preview.snapshotSha256) {
          throw codedError('restore_snapshot_changed', 'snapshot changed after preview')
        }
        const backup = makeSnapshotRecord(state, { kind: 'pre-restore-backup', sourceSnapshotId: target.snapshotId })
        const verifiedBackup = await writeSnapshotRecord(backup)
        for (const section of SNAPSHOT_SECTIONS) {
          if (target.presentSections.includes(section)) state[section] = cloneJson(target.payload[section])
          else delete state[section]
        }
        stateMutationReady = true
        return {
          snapshot: snapshotMetadata(target),
          backup: snapshotMetadata(verifiedBackup),
          changedSections: [...preview.changedSections],
        }
      })
    } catch (error) {
      if (stateMutationReady) throw codedError('state_commit_failed', 'restored state could not be committed', error)
      if (error?.code === 'restore_preview_stale' || error?.code === 'restore_snapshot_changed'
        || error?.code?.startsWith('snapshot_') || error?.code?.startsWith('backup_')) throw error
      throw codedError('state_unavailable', 'current state could not be restored')
    } finally {
      restorePreviews.delete(previewId)
    }
  }

  return Object.freeze({
    async read() { return await read() },
    async transact(mutator) { return await transact(mutator) },
    async captureSnapshot(request) { return await captureSnapshot(request) },
    async listSnapshots() { return await listSnapshots() },
    async exportSnapshot(snapshotId) { return await exportSnapshot(snapshotId) },
    async previewRestore(snapshotId) { return await previewRestore(snapshotId) },
    cancelRestorePreview(previewId) { return cancelRestorePreview(previewId) },
    async restoreSnapshot(previewId) { return await restoreSnapshot(previewId) },
    sceneProfileSnapshotFiles: Object.freeze({
      async write(sceneId, snapshotId, record, kind) { return await writeSceneProfileSnapshotFile(sceneId, snapshotId, record, kind) },
      async read(sceneId, snapshotId) { return await readSceneProfileSnapshotFile(sceneId, snapshotId) },
      async list(sceneId) { return await listSceneProfileSnapshotFiles(sceneId) },
    }),
    sceneMemorySnapshotFiles: Object.freeze({
      async write(sceneId, snapshotId, record, kind) { return await writeSceneMemorySnapshotFile(sceneId, snapshotId, record, kind) },
      async read(sceneId, snapshotId) { return await readSceneMemorySnapshotFile(sceneId, snapshotId) },
      async list(sceneId) { return await listSceneMemorySnapshotFiles(sceneId) },
      async writeMigrationBackup(snapshotId, record) { return await writeSceneMemorySnapshotFile(null, snapshotId, record, 'migration-backup', true) },
      async readMigrationBackup(snapshotId) { return await readSceneMemorySnapshotFile(null, snapshotId, true) },
      async listMigrationBackups() { return await listSceneMemorySnapshotFiles(null, true) },
    }),
    paths: Object.freeze({ home, statePath }),
  })
}
