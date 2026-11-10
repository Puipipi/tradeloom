import { createHash, randomUUID } from 'node:crypto'
import { resolve } from 'node:path'
import { projectSceneMemoryGraph, resolveSceneGraphTarget } from './scene-memory-graph.js'

export const SCENE_MEMORY_SCOPE = 'tradeloom-scene-memory/v1'
export const SCENE_PROFILE_SNAPSHOT_SCOPE = 'tradeloom-scene-profile/v1'

const SCENE_ID = /^[a-z][a-z0-9-]{0,63}$/
const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
const OPERATION_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
const ROTATION_PHASES = new Set(['planned', 'session_created', 'durable', 'needs_review', 'archive_pending', 'complete', 'abandoned'])
const ROTATION_ERROR_CODES = new Set([
  'scene_rotation_create_failed', 'scene_rotation_create_unavailable', 'scene_rotation_session_mismatch',
  'scene_rotation_session_not_durable', 'scene_rotation_workspace_mismatch', 'scene_rotation_stale_preview',
  'scene_rotation_binding_conflict', 'scene_rotation_session_unverified', 'scene_rotation_archive_failed',
])
const REF_KINDS = new Set(['business-route', 'artifact', 'skill'])
const MAX_ASSET_REFS = 50
const DEFAULT_PAGE_SIZE = 25
const MAX_PAGE_SIZE = 100
const PROFILE_SNAPSHOT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const PROFILE_SNAPSHOT_SECTIONS = Object.freeze(['scene.profile'])
const PROFILE_SNAPSHOT_FORMAT_VERSION = 1
const PROFILE_RESTORE_PREVIEW_TTL_MS = 5 * 60 * 1000
const profileRestorePreviews = new Map()

function error(code) {
  return Object.assign(new Error(code), { code })
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function clone(value) {
  return JSON.parse(JSON.stringify(value))
}

function sceneProfileSnapshotDigest(scopeParts) {
  return createHash('sha256').update(JSON.stringify({ scope: SCENE_PROFILE_SNAPSHOT_SCOPE, ...scopeParts }), 'utf8').digest('hex')
}

function canonicalTimestamp(value) {
  try { return typeof value === 'string' && new Date(value).toISOString() === value } catch { return false }
}

function exactKeys(value, keys) {
  return isRecord(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key))
}

function boundedText(value, max, allowEmpty = false) {
  return typeof value === 'string' && value.length <= max && (allowEmpty || value.trim().length > 0)
}

function emptyScene() {
  return {
    profile: { revision: 0, responsibility: null, assetRefs: [], primarySkill: null },
    handoff: null,
    progress: [],
    decisions: [],
    operations: {},
    bindingRevision: 0,
    rotations: {},
  }
}

function emptyMemory() {
  return { version: 1, scenes: {}, sessionScenes: {} }
}

function validateProfile(profile) {
  if (!exactKeys(profile, ['revision', 'responsibility', 'assetRefs', 'primarySkill'])
    || !Number.isSafeInteger(profile.revision) || profile.revision < 0
    || (profile.responsibility !== null && !boundedText(profile.responsibility, 4000, true))
    || (profile.primarySkill !== null && (typeof profile.primarySkill !== 'string' || profile.primarySkill.length > 128
      || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(profile.primarySkill)))
    || !Array.isArray(profile.assetRefs) || profile.assetRefs.length > MAX_ASSET_REFS) throw error('scene_memory_invalid')
  for (const ref of profile.assetRefs) {
    if (!isRecord(ref) || Object.keys(ref).some(key => !['kind', 'id', 'label'].includes(key))
      || !REF_KINDS.has(ref.kind) || !boundedText(ref.id, 256)
      || (ref.label !== undefined && !boundedText(ref.label, 240, true))) throw error('scene_memory_invalid')
  }
}

function validateScene(scene) {
  const legacyShape = exactKeys(scene, ['profile', 'handoff', 'progress', 'decisions', 'operations'])
  const rotationShape = exactKeys(scene, ['profile', 'handoff', 'progress', 'decisions', 'operations', 'bindingRevision', 'rotations'])
  if (!legacyShape && !rotationShape) throw error('scene_memory_invalid')
  // O03 state predates O04. A missing generation means the initial generation;
  // the next successful binding mutation persists the extended shape.
  if (legacyShape) {
    scene.bindingRevision = 0
    scene.rotations = {}
  }
  validateProfile(scene.profile)
  if (scene.handoff !== null && (!exactKeys(scene.handoff, ['revision', 'sourceSessionId', 'text', 'updatedAt', 'operationId'])
    || !Number.isSafeInteger(scene.handoff.revision) || scene.handoff.revision < 1
    || typeof scene.handoff.sourceSessionId !== 'string' || !SESSION_ID.test(scene.handoff.sourceSessionId)
    || !boundedText(scene.handoff.text, 8000)
    || typeof scene.handoff.updatedAt !== 'string' || Number.isNaN(Date.parse(scene.handoff.updatedAt))
    || typeof scene.handoff.operationId !== 'string' || !OPERATION_ID.test(scene.handoff.operationId))) throw error('scene_memory_invalid')
  for (const key of ['progress', 'decisions']) {
    if (!Array.isArray(scene[key])) throw error('scene_memory_invalid')
    const ids = new Set()
    for (const row of scene[key]) {
      if (!exactKeys(row, ['entryId', 'sourceSessionId', 'text', 'createdAt'])
        || typeof row.entryId !== 'string' || !OPERATION_ID.test(row.entryId) || ids.has(row.entryId)
        || typeof row.sourceSessionId !== 'string' || !SESSION_ID.test(row.sourceSessionId) || !boundedText(row.text, 4000)
        || typeof row.createdAt !== 'string' || Number.isNaN(Date.parse(row.createdAt))) throw error('scene_memory_invalid')
      ids.add(row.entryId)
    }
  }
  if (!isRecord(scene.operations)) throw error('scene_memory_invalid')
  for (const [id, operation] of Object.entries(scene.operations)) {
    if (!OPERATION_ID.test(id) || !exactKeys(operation, ['kind', 'fingerprint', 'revision', 'sourceSessionId'])
      || !['handoff'].includes(operation.kind) || typeof operation.fingerprint !== 'string'
      || !Number.isSafeInteger(operation.revision) || operation.revision < 1
      || typeof operation.sourceSessionId !== 'string' || !SESSION_ID.test(operation.sourceSessionId)) throw error('scene_memory_invalid')
  }
  if (!Number.isSafeInteger(scene.bindingRevision) || scene.bindingRevision < 0 || !isRecord(scene.rotations)) throw error('scene_memory_invalid')
  for (const [id, operation] of Object.entries(scene.rotations)) {
    if (!OPERATION_ID.test(id) || !exactKeys(operation, [
      'operationId', 'fingerprint', 'intentRevision', 'phase', 'oldSessionId', 'plannedSessionId',
      'createdSessionId', 'expectedBindingRevision', 'expectedProfileRevision', 'expectedHandoffRevision',
      'archiveOld', 'workspaceId', 'cwd', 'agentPreset', 'errorCode', 'createdAt', 'updatedAt',
    ]) || operation.operationId !== id || typeof operation.fingerprint !== 'string'
      || !Number.isSafeInteger(operation.intentRevision) || operation.intentRevision < 1
      || !ROTATION_PHASES.has(operation.phase)
      || typeof operation.oldSessionId !== 'string' || !SESSION_ID.test(operation.oldSessionId)
      || typeof operation.plannedSessionId !== 'string' || !SESSION_ID.test(operation.plannedSessionId)
      || (operation.createdSessionId !== null && (typeof operation.createdSessionId !== 'string' || !SESSION_ID.test(operation.createdSessionId)))
      || !Number.isSafeInteger(operation.expectedBindingRevision) || operation.expectedBindingRevision < 0
      || !Number.isSafeInteger(operation.expectedProfileRevision) || operation.expectedProfileRevision < 0
      || !Number.isSafeInteger(operation.expectedHandoffRevision) || operation.expectedHandoffRevision < 0
      || typeof operation.archiveOld !== 'boolean'
      || (operation.workspaceId !== null && (typeof operation.workspaceId !== 'string' || operation.workspaceId.length > 256))
      || (operation.cwd !== null && (typeof operation.cwd !== 'string' || operation.cwd.length > 4096))
      || (operation.agentPreset !== null && (typeof operation.agentPreset !== 'string' || operation.agentPreset.length > 128))
      || (operation.errorCode !== null && !ROTATION_ERROR_CODES.has(operation.errorCode))
      || typeof operation.createdAt !== 'string' || Number.isNaN(Date.parse(operation.createdAt))
      || typeof operation.updatedAt !== 'string' || Number.isNaN(Date.parse(operation.updatedAt))) throw error('scene_memory_invalid')
  }
}

function validateMemory(value) {
  if (!exactKeys(value, ['version', 'scenes', 'sessionScenes']) || value.version !== 1
    || !isRecord(value.scenes) || !isRecord(value.sessionScenes)) throw error('scene_memory_invalid')
  for (const [sceneId, scene] of Object.entries(value.scenes)) {
    if (!SCENE_ID.test(sceneId)) throw error('scene_memory_invalid')
    validateScene(scene)
  }
  for (const [sessionId, sceneId] of Object.entries(value.sessionScenes)) {
    if (!SESSION_ID.test(sessionId) || typeof sceneId !== 'string' || !SCENE_ID.test(sceneId)
      || !Object.hasOwn(value.scenes, sceneId)) throw error('scene_memory_invalid')
  }
  const boundScenes = Object.values(value.sessionScenes)
  if (new Set(boundScenes).size !== boundScenes.length) throw error('scene_memory_invalid')
  return value
}

function sceneFrom(memory, sceneId) {
  return Object.hasOwn(memory.scenes, sceneId) ? memory.scenes[sceneId] : emptyScene()
}

function pageInput(input = {}) {
  if (!isRecord(input) || Object.keys(input).some(key => !['progressOffset', 'decisionOffset', 'pageSize'].includes(key))) {
    throw error('invalid_arguments')
  }
  const progressOffset = input.progressOffset ?? 0
  const decisionOffset = input.decisionOffset ?? 0
  const pageSize = input.pageSize ?? DEFAULT_PAGE_SIZE
  if (!Number.isSafeInteger(progressOffset) || progressOffset < 0
    || !Number.isSafeInteger(decisionOffset) || decisionOffset < 0
    || !Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > MAX_PAGE_SIZE) throw error('invalid_arguments')
  return { progressOffset, decisionOffset, pageSize }
}

function pageRows(rows, offset, pageSize) {
  const items = rows.slice(offset, offset + pageSize)
  const hasMore = offset + items.length < rows.length
  return {
    items: clone(items),
    page: { offset, total: rows.length, hasMore, nextOffset: hasMore ? offset + items.length : null },
  }
}

/**
 * Scene memory persisted inside the owned state transaction. Controller methods
 * configure metadata and bind verified live sessions; agent-facing methods only
 * derive the scene from the executing session index.
 */
export function createSceneMemoryStore(stateStore, options = {}) {
  if (!stateStore || typeof stateStore.read !== 'function' || typeof stateStore.transact !== 'function') {
    throw new TypeError('a TradeLoom owned state store is required')
  }
  const sceneIds = new Set(Array.isArray(options.sceneIds) ? options.sceneIds : [])
  const verifySession = options.verifySession
  const now = typeof options.now === 'function' ? options.now : () => new Date().toISOString()

  function requireSceneId(sceneId) {
    if (sceneIds.size === 0) throw error('scene_catalog_unavailable')
    if (typeof sceneId !== 'string' || !SCENE_ID.test(sceneId) || !sceneIds.has(sceneId)) throw error('scene_not_found')
  }

  function memoryOf(state) {
    if (state.sceneMemory === undefined) return emptyMemory()
    return validateMemory(state.sceneMemory)
  }

  function requireSession(sessionId) {
    if (typeof sessionId !== 'string' || !SESSION_ID.test(sessionId)) throw error('scene_session_unavailable')
  }

  async function resolveBound(state, sessionId) {
    requireSession(sessionId)
    const memory = memoryOf(state)
    const sceneId = Object.hasOwn(memory.sessionScenes, sessionId) ? memory.sessionScenes[sessionId] : undefined
    if (sceneId === undefined) throw error('scene_session_not_bound')
    requireSceneId(sceneId)
    return { memory, sceneId, scene: memory.scenes[sceneId] }
  }

  function profileInput(input) {
    if (!exactKeys(input, ['sceneId', 'expectedRevision', 'responsibility', 'assetRefs', 'primarySkill'])) throw error('invalid_arguments')
    if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0
      || (input.responsibility !== null && !boundedText(input.responsibility, 4000, true))
      || (input.primarySkill !== null && (typeof input.primarySkill !== 'string' || input.primarySkill.length > 128
        || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(input.primarySkill)))
      || !Array.isArray(input.assetRefs) || input.assetRefs.length > MAX_ASSET_REFS) throw error('invalid_arguments')
    const assetRefs = input.assetRefs.map(ref => {
      if (!isRecord(ref) || Object.keys(ref).some(key => !['kind', 'id', 'label'].includes(key))
        || !REF_KINDS.has(ref.kind) || !boundedText(ref.id, 256)
        || (ref.label !== undefined && !boundedText(ref.label, 240, true))) throw error('invalid_arguments')
      return { kind: ref.kind, id: ref.id, ...(ref.label === undefined ? {} : { label: ref.label }) }
    })
    if (input.expectedRevision >= Number.MAX_SAFE_INTEGER) throw error('scene_revision_conflict')
    return { revision: input.expectedRevision + 1, responsibility: input.responsibility, assetRefs, primarySkill: input.primarySkill }
  }

  async function configureScene(input) {
    if (!isRecord(input)) throw error('invalid_arguments')
    requireSceneId(input.sceneId)
    const profile = profileInput(input)
    return await stateStore.transact(state => {
      const memory = memoryOf(state)
      const scene = sceneFrom(memory, input.sceneId)
      if (scene.profile.revision !== input.expectedRevision) throw error('scene_revision_conflict')
      scene.profile = profile
      memory.scenes[input.sceneId] = scene
      state.sceneMemory = memory
      return { sceneId: input.sceneId, profile: clone(profile) }
    })
  }

  function profileSnapshotPayload(record) {
    return { sections: record.sections, presentSections: record.presentSections, payload: record.payload }
  }

  function validateProfileSnapshotRecord(record, expectedId, expectedSceneId) {
    const keys = ['formatVersion', 'snapshotId', 'createdAt', 'kind', 'scope', 'sections',
      'presentSections', 'payload', 'payloadSha256', 'sourceSnapshotId']
    if (!exactKeys(record, keys) || record.formatVersion !== PROFILE_SNAPSHOT_FORMAT_VERSION
      || typeof record.snapshotId !== 'string' || !PROFILE_SNAPSHOT_ID.test(record.snapshotId)
      || record.snapshotId !== expectedId || !canonicalTimestamp(record.createdAt)
      || !['capture', 'pre-restore-backup'].includes(record.kind)
      || record.scope !== SCENE_PROFILE_SNAPSHOT_SCOPE
      || JSON.stringify(record.sections) !== JSON.stringify(PROFILE_SNAPSHOT_SECTIONS)
      || JSON.stringify(record.presentSections) !== JSON.stringify(PROFILE_SNAPSHOT_SECTIONS)
      || !exactKeys(record.payload, ['sceneId', 'profile'])
      || typeof record.payload.sceneId !== 'string' || !SCENE_ID.test(record.payload.sceneId)
      || record.payload.sceneId !== expectedSceneId
      || typeof record.payloadSha256 !== 'string' || !/^[0-9a-f]{64}$/.test(record.payloadSha256)
      || (record.kind === 'capture' && record.sourceSnapshotId !== null)
      || (record.kind === 'pre-restore-backup' && (typeof record.sourceSnapshotId !== 'string'
        || !PROFILE_SNAPSHOT_ID.test(record.sourceSnapshotId)))) throw error('scene_profile_snapshot_invalid')
    try { validateProfile(record.payload.profile) } catch { throw error('scene_profile_snapshot_invalid') }
    if (sceneProfileSnapshotDigest(profileSnapshotPayload(record)) !== record.payloadSha256) {
      throw error('scene_profile_snapshot_checksum_mismatch')
    }
    return record
  }

  function makeProfileSnapshotRecord(sceneId, profile, { kind = 'capture', sourceSnapshotId = null, snapshotId = randomUUID() } = {}) {
    const payload = { sceneId, profile: clone(profile) }
    const parts = { sections: [...PROFILE_SNAPSHOT_SECTIONS], presentSections: [...PROFILE_SNAPSHOT_SECTIONS], payload }
    const record = {
      formatVersion: PROFILE_SNAPSHOT_FORMAT_VERSION,
      snapshotId,
      createdAt: now(),
      kind,
      scope: SCENE_PROFILE_SNAPSHOT_SCOPE,
      ...parts,
      payloadSha256: sceneProfileSnapshotDigest(parts),
      sourceSnapshotId,
    }
    return validateProfileSnapshotRecord(record, snapshotId, sceneId)
  }

  function profileSnapshotMetadata(record) {
    return {
      snapshotId: record.snapshotId, createdAt: record.createdAt, kind: record.kind,
      scope: record.scope, sceneId: record.payload.sceneId, payloadSha256: record.payloadSha256, status: 'valid',
    }
  }

  function profileSnapshotFiles() {
    if (!stateStore.sceneProfileSnapshotFiles || typeof stateStore.sceneProfileSnapshotFiles.write !== 'function'
      || typeof stateStore.sceneProfileSnapshotFiles.read !== 'function'
      || typeof stateStore.sceneProfileSnapshotFiles.list !== 'function') throw error('scene_profile_snapshot_unavailable')
    return stateStore.sceneProfileSnapshotFiles
  }

  async function readProfileSnapshotRecord(sceneId, snapshotId) {
    if (typeof snapshotId !== 'string' || !PROFILE_SNAPSHOT_ID.test(snapshotId)) throw error('scene_profile_snapshot_id_invalid')
    let record
    try { record = await profileSnapshotFiles().read(sceneId, snapshotId) } catch (failure) {
      if (failure?.code === 'scene_profile_snapshot_not_found') throw error('scene_profile_snapshot_not_found')
      if (failure?.code === 'scene_profile_snapshot_invalid' || failure?.code === 'scene_profile_snapshot_checksum_mismatch') {
        throw error(failure.code)
      }
      throw error('scene_profile_snapshot_unavailable')
    }
    return validateProfileSnapshotRecord(record, snapshotId, sceneId)
  }

  async function writeAndVerifyProfileSnapshot(record) {
    try {
      await profileSnapshotFiles().write(record.payload.sceneId, record.snapshotId, record, record.kind)
    } catch {
      throw error(record.kind === 'capture' ? 'scene_profile_snapshot_write_failed' : 'scene_profile_backup_write_failed')
    }
    try {
      const stored = await readProfileSnapshotRecord(record.payload.sceneId, record.snapshotId)
      if (stored.payloadSha256 !== record.payloadSha256 || JSON.stringify(stored) !== JSON.stringify(record)) {
        throw error('scene_profile_snapshot_checksum_mismatch')
      }
      return stored
    } catch {
      throw error(record.kind === 'capture' ? 'scene_profile_snapshot_verification_failed' : 'scene_profile_backup_verification_failed')
    }
  }

  function expireProfileRestorePreviews(at = Date.now()) {
    for (const [id, preview] of profileRestorePreviews) {
      if (preview.expiresAt <= at) profileRestorePreviews.delete(id)
    }
  }

  async function captureSceneProfileSnapshot(sceneId) {
    requireSceneId(sceneId)
    let state
    try { state = await stateStore.read() } catch { throw error('scene_profile_state_unavailable') }
    const memory = memoryOf(state)
    const scene = sceneFrom(memory, sceneId)
    const record = makeProfileSnapshotRecord(sceneId, scene.profile)
    const stored = await writeAndVerifyProfileSnapshot(record)
    return profileSnapshotMetadata(stored)
  }

  async function listSceneProfileSnapshots(sceneId) {
    requireSceneId(sceneId)
    let ids
    try { ids = await profileSnapshotFiles().list(sceneId) } catch { throw error('scene_profile_snapshot_unavailable') }
    const result = []
    for (const snapshotId of ids) {
      try { result.push(profileSnapshotMetadata(await readProfileSnapshotRecord(sceneId, snapshotId))) }
      catch (failure) { result.push({ snapshotId, status: 'invalid', errorCode: failure?.code ?? 'scene_profile_snapshot_unavailable' }) }
    }
    return result.sort((left, right) => (right.createdAt ?? '').localeCompare(left.createdAt ?? '')
      || left.snapshotId.localeCompare(right.snapshotId))
  }

  async function exportSceneProfileSnapshot(snapshotId, sceneId) {
    requireSceneId(sceneId)
    return clone(await readProfileSnapshotRecord(sceneId, snapshotId))
  }

  function profileChangedFields(current, target) {
    return ['responsibility', 'assetRefs', 'primarySkill'].filter(field => JSON.stringify(current[field]) !== JSON.stringify(target[field]))
  }

  async function previewSceneProfileRestore(snapshotId, sceneId) {
    requireSceneId(sceneId)
    const target = await readProfileSnapshotRecord(sceneId, snapshotId)
    let state
    try { state = await stateStore.read() } catch { throw error('scene_profile_state_unavailable') }
    const memory = memoryOf(state)
    const scene = sceneFrom(memory, sceneId)
    expireProfileRestorePreviews()
    const previewId = randomUUID()
    const expiresAt = Date.now() + PROFILE_RESTORE_PREVIEW_TTL_MS
    const statePath = typeof stateStore.paths?.statePath === 'string'
      ? resolve(stateStore.paths.statePath).toLocaleLowerCase('en-US') : stateStore
    profileRestorePreviews.set(previewId, {
      statePath, sceneId, snapshotId, snapshotSha256: target.payloadSha256,
      profileRevision: scene.profile.revision,
      profileSha256: sceneProfileSnapshotDigest({ profile: scene.profile }),
      bindingRevision: scene.bindingRevision,
      changedFields: profileChangedFields(scene.profile, target.payload.profile),
      expiresAt,
      applying: false,
    })
    return {
      previewId, snapshotId, sceneId, scope: SCENE_PROFILE_SNAPSHOT_SCOPE,
      sourceProfileRevision: target.payload.profile.revision,
      currentProfileRevision: scene.profile.revision,
      bindingRevision: scene.bindingRevision,
      changedFields: profileChangedFields(scene.profile, target.payload.profile),
      expiresAt: new Date(expiresAt).toISOString(),
    }
  }

  function cancelSceneProfileRestore(previewId, sceneId) {
    const preview = profileRestorePreviews.get(previewId)
    const statePath = typeof stateStore.paths?.statePath === 'string'
      ? resolve(stateStore.paths.statePath).toLocaleLowerCase('en-US') : stateStore
    if (!preview || preview.statePath !== statePath || preview.sceneId !== sceneId || preview.applying) return false
    return profileRestorePreviews.delete(previewId)
  }

  async function restoreSceneProfileSnapshot(previewId, sceneId) {
    requireSceneId(sceneId)
    expireProfileRestorePreviews()
    const statePath = typeof stateStore.paths?.statePath === 'string'
      ? resolve(stateStore.paths.statePath).toLocaleLowerCase('en-US') : stateStore
    const preview = profileRestorePreviews.get(previewId)
    if (!preview || preview.statePath !== statePath || preview.sceneId !== sceneId || preview.expiresAt <= Date.now()
      || preview.applying) throw error('scene_profile_restore_preview_unavailable')
    preview.applying = true
    let mutationReady = false
    try {
      return await stateStore.transact(async state => {
        const memory = memoryOf(state)
        const scene = sceneFrom(memory, sceneId)
        const activeRotation = Object.values(scene.rotations).some(operation => operation.phase !== 'complete' && operation.phase !== 'abandoned')
        if (activeRotation) throw error('scene_rotation_in_progress')
        if (scene.bindingRevision !== preview.bindingRevision || scene.profile.revision !== preview.profileRevision
          || sceneProfileSnapshotDigest({ profile: scene.profile }) !== preview.profileSha256) {
          throw error('scene_profile_restore_preview_stale')
        }
        const target = await readProfileSnapshotRecord(sceneId, preview.snapshotId)
        if (target.payloadSha256 !== preview.snapshotSha256) throw error('scene_profile_snapshot_changed')
        if (scene.profile.revision >= Number.MAX_SAFE_INTEGER) throw error('scene_profile_revision_conflict')

        const backup = makeProfileSnapshotRecord(sceneId, scene.profile, {
          kind: 'pre-restore-backup', sourceSnapshotId: target.snapshotId,
        })
        const verifiedBackup = await writeAndVerifyProfileSnapshot(backup)
        scene.profile = { ...clone(target.payload.profile), revision: scene.profile.revision + 1 }
        memory.scenes[sceneId] = scene
        state.sceneMemory = memory
        mutationReady = true
        return {
          status: 'restored', sceneId, profile: clone(scene.profile),
          snapshot: profileSnapshotMetadata(target), backup: profileSnapshotMetadata(verifiedBackup),
          changedFields: [...preview.changedFields],
        }
      })
    } catch (failure) {
      if (mutationReady) throw error('scene_profile_state_commit_failed')
      if (failure?.code === 'scene_rotation_in_progress' || failure?.code === 'scene_profile_restore_preview_stale'
        || failure?.code === 'scene_profile_snapshot_changed' || failure?.code === 'scene_profile_snapshot_checksum_mismatch'
        || failure?.code === 'scene_profile_snapshot_invalid' || failure?.code === 'scene_profile_snapshot_not_found'
        || failure?.code === 'scene_profile_snapshot_unavailable' || failure?.code === 'scene_profile_backup_write_failed'
        || failure?.code === 'scene_profile_backup_verification_failed' || failure?.code === 'scene_profile_revision_conflict') throw failure
      throw error('scene_profile_state_unavailable')
    } finally {
      profileRestorePreviews.delete(previewId)
    }
  }

  async function bindSession(input) {
    if (!exactKeys(input, ['sceneId', 'sessionId', 'expectedSessionId'])) throw error('invalid_arguments')
    requireSceneId(input.sceneId)
    requireSession(input.sessionId)
    if (input.expectedSessionId !== null && (typeof input.expectedSessionId !== 'string' || !SESSION_ID.test(input.expectedSessionId))) throw error('invalid_arguments')
    if (typeof verifySession !== 'function') throw error('scene_session_unverified')
    return await stateStore.transact(async state => {
      const memory = memoryOf(state)
      const scene = sceneFrom(memory, input.sceneId)
      if (Object.values(scene.rotations).some(operation => operation.phase !== 'complete' && operation.phase !== 'abandoned')) throw error('scene_rotation_in_progress')
      const currentSessionId = Object.entries(memory.sessionScenes).find(([, sceneId]) => sceneId === input.sceneId)?.[0] ?? null
      if (currentSessionId !== input.expectedSessionId) throw error('scene_binding_conflict')
      const existingSceneId = Object.hasOwn(memory.sessionScenes, input.sessionId) ? memory.sessionScenes[input.sessionId] : undefined
      if (existingSceneId !== undefined && existingSceneId !== input.sceneId) throw error('scene_session_conflict')
      if (Object.values(memory.scenes).some(candidate => Object.values(candidate.rotations).some(operation =>
        operation.phase === 'archive_pending' && operation.archiveOld && operation.oldSessionId === input.sessionId))) {
        throw error('scene_rotation_session_reserved')
      }
      if (await verifySession({ sceneId: input.sceneId, sessionId: input.sessionId }) !== true) throw error('scene_session_unverified')
      if (currentSessionId !== null && currentSessionId !== input.sessionId) delete memory.sessionScenes[currentSessionId]
      memory.sessionScenes[input.sessionId] = input.sceneId
      if (currentSessionId !== input.sessionId) {
        if (scene.bindingRevision >= Number.MAX_SAFE_INTEGER) throw error('scene_binding_conflict')
        scene.bindingRevision += 1
      }
      memory.scenes[input.sceneId] = scene
      state.sceneMemory = memory
      return { sceneId: input.sceneId, sessionId: input.sessionId, previousSessionId: currentSessionId }
    })
  }

  async function readForSession(sessionId, pageOptions = {}) {
    const page = pageInput(pageOptions)
    const state = await stateStore.read()
    const { sceneId, scene } = await resolveBound(state, sessionId)
    const progress = pageRows(scene.progress, page.progressOffset, page.pageSize)
    const decisions = pageRows(scene.decisions, page.decisionOffset, page.pageSize)
    return {
      sceneId,
      profile: clone(scene.profile),
      handoff: scene.handoff === null ? null : clone(scene.handoff),
      progress: progress.items,
      decisions: decisions.items,
      pagination: { pageSize: page.pageSize, progress: progress.page, decisions: decisions.page },
      handoffStatus: scene.handoff === null ? 'missing' : 'available',
      profileStatus: scene.profile.revision === 0 ? 'not_configured' : 'available',
      scope: SCENE_MEMORY_SCOPE,
      sessionId,
    }
  }

  async function updateHandoff(input) {
    if (!exactKeys(input, ['sessionId', 'operationId', 'expectedRevision', 'text'])) throw error('invalid_arguments')
    requireSession(input.sessionId)
    if (typeof input.operationId !== 'string' || !OPERATION_ID.test(input.operationId)
      || !Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0
      || !boundedText(input.text, 8000)) throw error('invalid_arguments')
    const fingerprint = JSON.stringify([input.sessionId, input.text])
    return await stateStore.transact(async state => {
      const { memory, sceneId, scene } = await resolveBound(state, input.sessionId)
      const previousOperation = Object.hasOwn(scene.operations, input.operationId) ? scene.operations[input.operationId] : undefined
      if (previousOperation) {
        if (previousOperation.kind === 'handoff' && previousOperation.fingerprint === fingerprint
          && previousOperation.sourceSessionId === input.sessionId) return { sceneId, revision: previousOperation.revision, replayed: true }
        throw error('scene_idempotency_conflict')
      }
      const revision = scene.handoff?.revision ?? 0
      if (revision !== input.expectedRevision) throw error('scene_revision_conflict')
      if (revision >= Number.MAX_SAFE_INTEGER) throw error('scene_revision_conflict')
      const nextRevision = revision + 1
      scene.handoff = { revision: nextRevision, sourceSessionId: input.sessionId, text: input.text, updatedAt: now(), operationId: input.operationId }
      scene.operations[input.operationId] = { kind: 'handoff', fingerprint, revision: nextRevision, sourceSessionId: input.sessionId }
      memory.scenes[sceneId] = scene
      state.sceneMemory = memory
      return { sceneId, revision: nextRevision, replayed: false }
    })
  }

  async function appendJournal(kind, input) {
    if (!['progress', 'decisions'].includes(kind) || !exactKeys(input, ['sessionId', 'entryId', 'text'])) throw error('invalid_arguments')
    requireSession(input.sessionId)
    if (typeof input.entryId !== 'string' || !OPERATION_ID.test(input.entryId) || !boundedText(input.text, 4000)) throw error('invalid_arguments')
    return await stateStore.transact(async state => {
      const { memory, sceneId, scene } = await resolveBound(state, input.sessionId)
      const rows = scene[kind]
      const previous = rows.find(row => row.entryId === input.entryId)
      if (previous) {
        if (previous.sourceSessionId === input.sessionId && previous.text === input.text) return { sceneId, entryId: input.entryId, replayed: true }
        throw error('scene_idempotency_conflict')
      }
      rows.push({ entryId: input.entryId, sourceSessionId: input.sessionId, text: input.text, createdAt: now() })
      memory.scenes[sceneId] = scene
      state.sceneMemory = memory
      return { sceneId, entryId: input.entryId, replayed: false }
    })
  }

  async function appendProgress(input) { return await appendJournal('progress', input) }
  async function appendDecision(input) { return await appendJournal('decisions', input) }

  function rotationSnapshotFrom(memory, sceneId) {
    const scene = sceneFrom(memory, sceneId)
    const currentSessionId = Object.entries(memory.sessionScenes).find(([, boundSceneId]) => boundSceneId === sceneId)?.[0] ?? null
    return {
      sceneId,
      oldSessionId: currentSessionId,
      bindingRevision: scene.bindingRevision,
      profileRevision: scene.profile.revision,
      handoffRevision: scene.handoff?.revision ?? 0,
      pendingOperationIds: Object.values(scene.rotations)
        .filter(operation => operation.phase !== 'complete' && operation.phase !== 'abandoned')
        .map(operation => operation.operationId)
        .sort(),
      handoff: scene.handoff === null ? null : clone(scene.handoff),
      profile: clone(scene.profile),
    }
  }

  async function getRotationSnapshot(sceneId) {
    requireSceneId(sceneId)
    const memory = memoryOf(await stateStore.read())
    return rotationSnapshotFrom(memory, sceneId)
  }

  async function readGraphForSession(sessionId, query = {}) {
    requireSession(sessionId)
    const state = await stateStore.read()
    const { sceneId, scene } = await resolveBound(state, sessionId)
    return projectSceneMemoryGraph({ sessionId, sceneId, bindingRevision: scene.bindingRevision, scene, query })
  }

  async function resolveGraphTarget(sessionId, input) {
    requireSession(sessionId)
    if (!exactKeys(input, ['nodeId', 'expectedTarget'])) throw error('invalid_arguments')
    const state = await stateStore.read()
    const { sceneId, scene } = await resolveBound(state, sessionId)
    return resolveSceneGraphTarget({ sessionId, sceneId, bindingRevision: scene.bindingRevision, scene,
      nodeId: input.nodeId, expectedTarget: input.expectedTarget })
  }

  function rotationInput(input) {
    if (!exactKeys(input, ['sceneId', 'operationId', 'oldSessionId', 'plannedSessionId', 'bindingRevision',
      'profileRevision', 'handoffRevision', 'archiveOld', 'workspaceId', 'cwd', 'agentPreset'])) throw error('invalid_arguments')
    requireSceneId(input.sceneId)
    requireSession(input.oldSessionId)
    requireSession(input.plannedSessionId)
    if (typeof input.operationId !== 'string' || !OPERATION_ID.test(input.operationId)
      || !Number.isSafeInteger(input.bindingRevision) || input.bindingRevision < 0
      || !Number.isSafeInteger(input.profileRevision) || input.profileRevision < 0
      || !Number.isSafeInteger(input.handoffRevision) || input.handoffRevision < 0
      || typeof input.archiveOld !== 'boolean'
      || (input.workspaceId !== null && (typeof input.workspaceId !== 'string' || input.workspaceId.length > 256))
      || (input.cwd !== null && (typeof input.cwd !== 'string' || input.cwd.length > 4096))
      || (input.agentPreset !== null && (typeof input.agentPreset !== 'string' || input.agentPreset.length > 128))) throw error('invalid_arguments')
    return input
  }

  function sameRotationSnapshot(snapshot, input) {
    return snapshot.oldSessionId === input.oldSessionId
      && snapshot.bindingRevision === input.bindingRevision
      && snapshot.profileRevision === input.profileRevision
      && snapshot.handoffRevision === input.handoffRevision
  }

  function rotationFingerprint(input) {
    return JSON.stringify([input.sceneId, input.oldSessionId, input.plannedSessionId, input.bindingRevision,
      input.profileRevision, input.handoffRevision, input.archiveOld, input.workspaceId, input.cwd, input.agentPreset])
  }

  async function beginRotation(rawInput) {
    const input = rotationInput(rawInput)
    return await stateStore.transact(state => {
      const memory = memoryOf(state)
      const scene = sceneFrom(memory, input.sceneId)
      const existing = Object.values(memory.scenes).flatMap(candidate => Object.values(candidate.rotations))
        .find(operation => operation.operationId === input.operationId)
      const fingerprint = rotationFingerprint(input)
      if (existing) {
        if (existing.fingerprint !== fingerprint) throw error('scene_rotation_idempotency_conflict')
        return clone(existing)
      }
      const snapshot = rotationSnapshotFrom(memory, input.sceneId)
      if (!sameRotationSnapshot(snapshot, input)) throw error('scene_rotation_stale_preview')
      if (snapshot.oldSessionId === null || snapshot.handoff === null) throw error('scene_rotation_not_ready')
      if (Object.values(scene.rotations).some(operation => operation.phase !== 'complete' && operation.phase !== 'abandoned')) throw error('scene_rotation_in_progress')
      if (Object.hasOwn(memory.sessionScenes, input.plannedSessionId)) throw error('scene_rotation_session_conflict')
      const operation = {
        operationId: input.operationId,
        fingerprint,
        intentRevision: 1,
        phase: 'planned',
        oldSessionId: input.oldSessionId,
        plannedSessionId: input.plannedSessionId,
        createdSessionId: null,
        expectedBindingRevision: input.bindingRevision,
        expectedProfileRevision: input.profileRevision,
        expectedHandoffRevision: input.handoffRevision,
        archiveOld: input.archiveOld,
        workspaceId: input.workspaceId,
        cwd: input.cwd,
        agentPreset: input.agentPreset,
        errorCode: null,
        createdAt: now(),
        updatedAt: now(),
      }
      scene.rotations[input.operationId] = operation
      memory.scenes[input.sceneId] = scene
      state.sceneMemory = memory
      return clone(operation)
    })
  }

  async function recordRotationCreated(operationId, returnedSessionId) {
    requireSession(operationId)
    if (returnedSessionId !== null) requireSession(returnedSessionId)
    return await stateStore.transact(state => {
      const memory = memoryOf(state)
      const found = findRotation(memory, operationId)
      if (!found) throw error('scene_rotation_not_found')
      const operation = found.operation
      if (operation.phase === 'abandoned') throw error('scene_rotation_state_conflict')
      if (operation.createdSessionId !== null) {
        if (operation.createdSessionId !== returnedSessionId) throw error('scene_rotation_idempotency_conflict')
        return clone(operation)
      }
      operation.createdSessionId = returnedSessionId
      operation.phase = returnedSessionId === operation.plannedSessionId ? 'session_created' : 'needs_review'
      operation.errorCode = returnedSessionId === operation.plannedSessionId ? null : 'scene_rotation_session_mismatch'
      operation.updatedAt = now()
      state.sceneMemory = memory
      return clone(operation)
    })
  }

  function findRotation(memory, operationId) {
    for (const [sceneId, scene] of Object.entries(memory.scenes)) {
      if (Object.hasOwn(scene.rotations, operationId)) return { sceneId, scene, operation: scene.rotations[operationId] }
    }
    return null
  }

  async function markRotationDurable(operationId) {
    return await stateStore.transact(state => {
      const memory = memoryOf(state)
      const found = findRotation(memory, operationId)
      if (!found) throw error('scene_rotation_not_found')
      if (found.operation.phase === 'durable' || found.operation.phase === 'archive_pending' || found.operation.phase === 'complete') return clone(found.operation)
      if (found.operation.phase !== 'session_created') throw error('scene_rotation_state_conflict')
      found.operation.phase = 'durable'
      found.operation.errorCode = null
      found.operation.updatedAt = now()
      state.sceneMemory = memory
      return clone(found.operation)
    })
  }

  async function commitRotation(operationId) {
    return await stateStore.transact(async state => {
      const memory = memoryOf(state)
      const found = findRotation(memory, operationId)
      if (!found) throw error('scene_rotation_not_found')
      const { sceneId, scene, operation } = found
      if (operation.phase === 'archive_pending' || operation.phase === 'complete') return clone(operation)
      if (operation.phase !== 'durable') throw error('scene_rotation_state_conflict')
      const snapshot = rotationSnapshotFrom(memory, sceneId)
      const sessionConflict = Object.hasOwn(memory.sessionScenes, operation.plannedSessionId)
        && memory.sessionScenes[operation.plannedSessionId] !== sceneId
      const verified = !sessionConflict && await verifySession?.({ sceneId, sessionId: operation.plannedSessionId }) === true
      if (!sameRotationSnapshot(snapshot, {
        oldSessionId: operation.oldSessionId,
        bindingRevision: operation.expectedBindingRevision,
        profileRevision: operation.expectedProfileRevision,
        handoffRevision: operation.expectedHandoffRevision,
      }) || sessionConflict || !verified || snapshot.handoff === null) {
        operation.phase = 'needs_review'
        operation.errorCode = sessionConflict ? 'scene_rotation_session_conflict'
          : !verified ? 'scene_rotation_session_unverified' : 'scene_rotation_stale_preview'
        operation.updatedAt = now()
        state.sceneMemory = memory
        return clone(operation)
      }
      if (scene.bindingRevision >= Number.MAX_SAFE_INTEGER) {
        operation.phase = 'needs_review'
        operation.errorCode = 'scene_rotation_stale_preview'
        operation.updatedAt = now()
        state.sceneMemory = memory
        return clone(operation)
      }
      delete memory.sessionScenes[operation.oldSessionId]
      memory.sessionScenes[operation.plannedSessionId] = sceneId
      scene.bindingRevision += 1
      operation.phase = operation.archiveOld ? 'archive_pending' : 'complete'
      operation.errorCode = null
      operation.updatedAt = now()
      memory.scenes[sceneId] = scene
      state.sceneMemory = memory
      return clone(operation)
    })
  }

  async function markRotationFailure(operationId, phase, code) {
    if (!ROTATION_ERROR_CODES.has(code)) code = 'scene_rotation_create_failed'
    if (!['planned', 'session_created', 'durable', 'archive_pending'].includes(phase)) throw error('invalid_arguments')
    return await stateStore.transact(state => {
      const memory = memoryOf(state)
      const found = findRotation(memory, operationId)
      if (!found) throw error('scene_rotation_not_found')
      if (found.operation.phase === 'abandoned') return clone(found.operation)
      if (found.operation.phase !== 'complete' && found.operation.phase !== 'needs_review') found.operation.phase = phase
      found.operation.errorCode = code
      found.operation.updatedAt = now()
      state.sceneMemory = memory
      return clone(found.operation)
    })
  }

  async function completeRotation(operationId) {
    return await stateStore.transact(state => {
      const memory = memoryOf(state)
      const found = findRotation(memory, operationId)
      if (!found) throw error('scene_rotation_not_found')
      if (found.operation.phase === 'complete') return clone(found.operation)
      if (found.operation.phase !== 'archive_pending' || !found.operation.archiveOld) throw error('scene_rotation_state_conflict')
      found.operation.phase = 'complete'
      found.operation.errorCode = null
      found.operation.updatedAt = now()
      state.sceneMemory = memory
      return clone(found.operation)
    })
  }

  async function abandonRotation(operationId) {
    requireSession(operationId)
    return await stateStore.transact(state => {
      const memory = memoryOf(state)
      const found = findRotation(memory, operationId)
      if (!found) throw error('scene_rotation_not_found')
      const operation = found.operation
      if (operation.phase === 'abandoned') return clone(operation)
      if (operation.phase === 'complete') throw error('scene_rotation_state_conflict')
      operation.phase = 'abandoned'
      operation.updatedAt = now()
      state.sceneMemory = memory
      return clone(operation)
    })
  }

  async function rebaseRotation(input) {
    if (!exactKeys(input, ['operationId', 'bindingRevision', 'profileRevision', 'handoffRevision', 'archiveOld'])) throw error('invalid_arguments')
    requireSession(input.operationId)
    if (!Number.isSafeInteger(input.bindingRevision) || input.bindingRevision < 0
      || !Number.isSafeInteger(input.profileRevision) || input.profileRevision < 0
      || !Number.isSafeInteger(input.handoffRevision) || input.handoffRevision < 0
      || typeof input.archiveOld !== 'boolean') throw error('invalid_arguments')
    return await stateStore.transact(state => {
      const memory = memoryOf(state)
      const found = findRotation(memory, input.operationId)
      if (!found) throw error('scene_rotation_not_found')
      const { sceneId, operation } = found
      if (operation.phase !== 'needs_review' || operation.createdSessionId !== operation.plannedSessionId) throw error('scene_rotation_state_conflict')
      const snapshot = rotationSnapshotFrom(memory, sceneId)
      if (snapshot.oldSessionId !== operation.oldSessionId || snapshot.bindingRevision !== input.bindingRevision
        || snapshot.profileRevision !== input.profileRevision || snapshot.handoffRevision !== input.handoffRevision) {
        throw error('scene_rotation_stale_preview')
      }
      operation.expectedBindingRevision = input.bindingRevision
      operation.expectedProfileRevision = input.profileRevision
      operation.expectedHandoffRevision = input.handoffRevision
      operation.archiveOld = input.archiveOld
      operation.intentRevision += 1
      operation.fingerprint = JSON.stringify([operation.operationId, operation.oldSessionId, operation.plannedSessionId,
        input.bindingRevision, input.profileRevision, input.handoffRevision, input.archiveOld])
      operation.phase = 'session_created'
      operation.errorCode = null
      operation.updatedAt = now()
      state.sceneMemory = memory
      return clone(operation)
    })
  }

  async function getRotationOperation(operationId) {
    requireSession(operationId)
    const memory = memoryOf(await stateStore.read())
    const found = findRotation(memory, operationId)
    return found ? clone(found.operation) : null
  }

  async function readConfiguredSkill(sessionId, skillService, execution) {
    const context = await readForSession(sessionId)
    const name = context.profile.primarySkill
    if (!name) return { status: 'not_configured', skill: null, content: null }
    if (!skillService || typeof skillService.snapshot !== 'function' || typeof skillService.get !== 'function') {
      return { status: 'unavailable', skill: name, content: null }
    }
    const agent = execution?.agent
    const cwd = agent?.session?.header?.cwd
    if (agent?.session?.id !== sessionId || typeof cwd !== 'string' || !cwd) return { status: 'unavailable', skill: name, content: null }
    if (execution?.signal?.aborted) throw error('tool_cancelled')
    const options = { scope: agent, cwd, signal: execution?.signal }
    const snapshot = await skillService.snapshot(options)
    const ensureCurrent = async () => {
      if (execution?.signal?.aborted) throw error('tool_cancelled')
      const current = await readForSession(sessionId)
      if (current.sceneId !== context.sceneId || current.profile.revision !== context.profile.revision
        || current.profile.primarySkill !== name) throw error('scene_binding_changed')
    }
    await ensureCurrent()
    if (!snapshot?.complete || !Array.isArray(snapshot.skills)) return { status: 'unavailable', skill: name, content: null }
    const summary = snapshot.skills.find(skill => skill?.name === name && skill.invocation?.modelInvocable === true)
    if (!summary) return { status: 'missing', skill: name, content: null }
    const loaded = await skillService.get(name, options)
    await ensureCurrent()
    if (!loaded || loaded.name !== name || loaded.invocation?.modelInvocable !== true
      || typeof loaded.content !== 'string' || !loaded.content.trim()) return { status: 'missing', skill: name, content: null }
    const skillIdentity = skill => JSON.stringify([skill.name, skill.provider, skill.source, skill.path ?? null, skill.resourceBase ?? null])
    if (skillIdentity(loaded) !== skillIdentity(summary)) throw error('scene_skill_changed')
    await ensureCurrent()
    return { status: 'available', skill: name, content: loaded.content }
  }

  const api = {
    configureScene,
    captureSceneProfileSnapshot,
    listSceneProfileSnapshots,
    exportSceneProfileSnapshot,
    previewSceneProfileRestore,
    cancelSceneProfileRestore,
    restoreSceneProfileSnapshot,
    bindSession,
    readForSession,
    readGraphForSession,
    resolveGraphTarget,
    updateHandoff,
    appendProgress,
    appendDecision,
    readConfiguredSkill,
    getRotationSnapshot,
    beginRotation,
    recordRotationCreated,
    markRotationDurable,
    commitRotation,
    markRotationFailure,
    completeRotation,
    abandonRotation,
    rebaseRotation,
    getRotationOperation,
  }
  // Internal coordinator identity only. It is non-enumerable and never enters
  // scene DTOs or business-tool output; separate wrappers for the same owned
  // state file share O04's in-flight operation map.
  const rotationOwnerKey = typeof stateStore.paths?.statePath === 'string'
    ? stateStore.paths.statePath.toLocaleLowerCase('en-US')
    : api
  Object.defineProperty(api, 'rotationOwnerKey', { value: rotationOwnerKey, enumerable: false })
  return Object.freeze(api)
}

export const SCENE_MEMORY_ERROR_CODES = Object.freeze([
  'invalid_arguments', 'scene_catalog_unavailable', 'scene_not_found', 'scene_memory_invalid',
  'scene_session_unavailable', 'scene_session_unverified', 'scene_binding_conflict', 'scene_session_conflict',
  'scene_session_not_bound', 'scene_revision_conflict', 'scene_idempotency_conflict',
  'scene_binding_changed', 'scene_skill_changed', 'tool_cancelled', 'scene_rotation_in_progress',
  'scene_rotation_session_reserved', 'scene_rotation_not_ready', 'scene_rotation_idempotency_conflict',
  'scene_rotation_session_conflict', 'scene_rotation_not_found', 'scene_rotation_state_conflict',
  'scene_rotation_stale_preview', 'scene_rotation_session_mismatch', 'scene_rotation_session_unverified',
  'scene_rotation_session_not_durable', 'scene_rotation_workspace_mismatch', 'scene_rotation_archive_failed',
  'scene_rotation_create_failed', 'scene_graph_cursor_invalid', 'scene_graph_snapshot_changed',
  'scene_graph_node_not_found', 'scene_graph_target_changed',
  'scene_profile_state_unavailable', 'scene_profile_snapshot_unavailable', 'scene_profile_snapshot_invalid',
  'scene_profile_snapshot_checksum_mismatch', 'scene_profile_snapshot_not_found', 'scene_profile_snapshot_id_invalid',
  'scene_profile_snapshot_write_failed', 'scene_profile_snapshot_verification_failed', 'scene_profile_backup_write_failed',
  'scene_profile_backup_verification_failed', 'scene_profile_restore_preview_unavailable', 'scene_profile_restore_preview_stale',
  'scene_profile_snapshot_changed', 'scene_profile_revision_conflict', 'scene_profile_state_commit_failed',
])
