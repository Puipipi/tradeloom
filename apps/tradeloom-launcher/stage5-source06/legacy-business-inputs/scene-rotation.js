import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { ROLE_IDS, ROLE_PRESETS } from './roles.js'
import { createStateStore, getRoleBindingRevision, replaceRoleBinding, roleWorkspacePath } from './state.js'
import { resolveSceneConfiguration } from './scene-layout.js'

export const SCENE_ROTATION_PREVIEW_ROUTE = '/tradeloom/scene-rotation/preview'
export const SCENE_ROTATION_CONFIRM_ROUTE = '/tradeloom/scene-rotation/confirm'
export const SCENE_ROTATION_STATUS_ROUTE = '/tradeloom/scene-rotation/status'
export const SCENE_ROTATION_RESUME_ROUTE = '/tradeloom/scene-rotation/resume'
export const SCENE_ROTATION_CANCEL_ROUTE = '/tradeloom/scene-rotation/cancel'
export const SCENE_ROTATION_ABANDON_ROUTE = '/tradeloom/scene-rotation/abandon'

const PREVIEW_TTL_MS = 120_000
const MAX_BODY_BYTES = 8 * 1024
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/

class SceneRotationError extends Error {
  constructor(code, status = 409) { super(code); this.code = code; this.status = status }
}

function isRecord(value) { return value !== null && typeof value === 'object' && !Array.isArray(value) }
function clone(value) { return JSON.parse(JSON.stringify(value)) }
function json(res, status, value) {
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(JSON.stringify(value))
}

async function readBody(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.byteLength
    if (size > MAX_BODY_BYTES) { req.resume(); return null }
    chunks.push(chunk)
  }
  return Buffer.concat(chunks).toString('utf8')
}

async function readInput(req, allowedKeys) {
  let text
  try { text = await readBody(req) } catch { throw new SceneRotationError('request-body-unavailable', 400) }
  if (text === null) throw new SceneRotationError('request-too-large', 413)
  let value
  try { value = JSON.parse(text) } catch { throw new SceneRotationError('invalid-json', 400) }
  if (!isRecord(value) || Object.keys(value).some(key => !allowedKeys.includes(key))) {
    throw new SceneRotationError('invalid-request', 400)
  }
  return value
}

function roleForPanel(scene, panel) {
  const role = panel?.roleId ?? scene?.roleId
  if (!ROLE_IDS.includes(role)) throw new SceneRotationError('rotation-binding-unavailable', 503)
  return role
}

function bindingSnapshot(state, role) {
  const binding = state.roles?.[role]
  if (!isRecord(binding) || typeof binding.sessionId !== 'string' || !ID.test(binding.sessionId)
    || typeof binding.workspaceId !== 'string' || !binding.workspaceId
    || typeof binding.workspacePath !== 'string' || !binding.workspacePath
    || binding.agentPreset !== ROLE_PRESETS[role]) throw new SceneRotationError('rotation-binding-unavailable', 503)
  return {
    sessionId: binding.sessionId,
    workspaceId: binding.workspaceId,
    workspacePath: binding.workspacePath,
    agentPreset: binding.agentPreset,
    bindingRevision: getRoleBindingRevision(state, role),
  }
}

function sceneWriteRevision(state, sceneId) {
  const value = state.sceneMemories?.[sceneId]?.writeRevision ?? 0
  if (!Number.isSafeInteger(value) || value < 0) throw new SceneRotationError('scene-memory-write-revision-invalid', 503)
  return value
}

function sceneProjection(config, sceneId, panelId) {
  const scene = config.scenes.find(item => item.id === sceneId)
  const panel = scene?.panels.find(item => item.id === panelId)
  if (!scene || !panel) throw new SceneRotationError('rotation-target-not-found', 404)
  if (!['native-chat', 'native-workspace'].includes(panel.type)) throw new SceneRotationError('rotation-target-unsupported', 409)
  const roleId = roleForPanel(scene, panel)
  const impactPanels = []
  for (const itemScene of config.scenes) {
    for (const itemPanel of itemScene.panels) {
      if (['native-chat', 'native-workspace'].includes(itemPanel.type)
        && (itemPanel.roleId ?? itemScene.roleId) === roleId) {
        impactPanels.push({ sceneId: itemScene.id, panelId: itemPanel.id })
      }
    }
  }
  impactPanels.sort((left, right) => left.sceneId.localeCompare(right.sceneId) || left.panelId.localeCompare(right.panelId))
  return { scene, panel, roleId, impactPanels }
}

export function createSceneRotationHandlers(ctx, dependencies = {}) {
  const storeFactory = dependencies.createStateStore ?? createStateStore
  const workspacePathForRole = dependencies.roleWorkspacePath ?? roleWorkspacePath
  const readScenes = dependencies.readScenes ?? (() => readFile(new URL('./scenes.json', import.meta.url), 'utf8'))
  const readIdentityUnderLock = dependencies.readManagedConfigurationIdentityUnderLock
  const withConfigurationLock = dependencies.withManagedConfigurationLock
  const currentHostEpoch = dependencies.getHostEpoch
  const ensureDurable = dependencies.ensureDurableRoleSession
  const reconcileCreatedSession = dependencies.reconcileCreatedSession
  if ([readIdentityUnderLock, withConfigurationLock, currentHostEpoch, ensureDurable, reconcileCreatedSession]
    .some(value => typeof value !== 'function')) throw new SceneRotationError('rotation-unavailable', 503)

  const previews = new Map()
  const consumedPreviews = new Map()
  const confirmationFlights = new Map()
  const inFlight = new Set()
  let disposed = false
  const assertOpen = () => { if (disposed) throw new SceneRotationError('rotation-unavailable', 503) }
  const store = async () => await storeFactory()
  const scenes = async () => resolveSceneConfiguration(JSON.parse(await readScenes()), await (await store()).read())
  const prunePreviews = now => {
    for (const [token, preview] of previews) if (preview.expiresAt <= now) previews.delete(token)
    for (const [token, preview] of consumedPreviews) if (preview.expiresAt <= now) consumedPreviews.delete(token)
  }
  const assertTargetCurrent = async operation => {
    let target
    try { target = sceneProjection(await scenes(), operation.sceneId, operation.panelId) }
    catch { throw new SceneRotationError('rotation-stale-target', 409) }
    if (target.roleId !== operation.roleId
      || JSON.stringify(target.impactPanels) !== JSON.stringify(operation.impactPanels)) {
      throw new SceneRotationError('rotation-stale-target', 409)
    }
    return target
  }
  const assertOperationRunnable = async (operationId, expectedStatus) => {
    assertOpen()
    const current = (await (await store()).read()).sceneRotationOperations?.[operationId]
    if (!current) throw new SceneRotationError('rotation-operation-not-found', 404)
    if (current.status === 'abandoned') throw new SceneRotationError('rotation-abandoned', 409)
    if (expectedStatus && current.status !== expectedStatus) throw new SceneRotationError('rotation-operation-changed', 409)
    return clone(current)
  }
  const authorized = req => {
    const rejection = ctx.connection.requestRejection(req)
    if (rejection !== undefined) throw new SceneRotationError('request-rejected', rejection)
    assertOpen()
  }
  const bindOperation = async operation => {
    const role = operation.roleId
    const result = await withConfigurationLock(role, async () => {
      await assertTargetCurrent(operation)
      const configIdentity = await readIdentityUnderLock(role)
      assertOpen()
      if (configIdentity.managedConfigurationSequence !== operation.profileRevision.managedConfigurationSequence
        || configIdentity.roleManagedConfigDigest !== operation.profileRevision.roleManagedConfigDigest) {
        throw new SceneRotationError('rotation-stale-profile', 409)
      }
      const stateStore = await store()
      return await stateStore.transact(state => {
        const current = state.sceneRotationOperations?.[operation.operationId]
        if (!current) throw new SceneRotationError('rotation-operation-not-found', 404)
        if (current.status === 'abandoned') throw new SceneRotationError('rotation-abandoned', 409)
        if (current.status !== 'durable' && !['bound', 'completed', 'archive_pending'].includes(current.status)) {
          throw new SceneRotationError('rotation-operation-changed', 409)
        }
        if (current.status === 'bound' || current.status === 'completed' || current.status === 'archive_pending') {
          return { replayed: true, state: clone(current) }
        }
        const binding = bindingSnapshot(state, role)
        const writeRevision = sceneWriteRevision(state, operation.sceneId)
        if (binding.sessionId !== operation.expectedSessionId
          || binding.bindingRevision !== operation.roleBindingRevision
          || writeRevision !== operation.profileRevision.sceneMemoryWriteRevision) {
          current.status = 'outcome_unknown'
          current.updatedAt = Date.now()
          return { error: 'rotation-stale-binding' }
        }
        if (current.status !== 'durable') return { error: 'rotation-session-not-durable' }
        const bindingRevision = replaceRoleBinding(state, role, {
          sessionId: current.newSessionId,
          workspaceId: current.workspaceId,
          workspacePath: current.workspacePath,
          agentPreset: ROLE_PRESETS[role],
        })
        current.bindingRevisionAfter = bindingRevision
        current.status = current.archiveOld ? 'bound' : 'completed'
        current.updatedAt = Date.now()
        delete state.pendingSceneRotationByRole?.[role]
        return { replayed: false, state: clone(current) }
      }, { compareBeforeRename: true, readback: true, validateCommit: assertOpen })
    })
    if (result?.error) throw new SceneRotationError(result.error, 409)
    return result
  }
  const runArchive = async operation => {
    if (!operation.archiveOld || ['completed', 'archived'].includes(operation.status)) return operation
    const stateBeforeArchive = await (await store()).read()
    const currentBinding = bindingSnapshot(stateBeforeArchive, operation.roleId)
    if (currentBinding.sessionId !== operation.newSessionId
      || currentBinding.bindingRevision !== operation.bindingRevisionAfter) {
      throw new SceneRotationError('rotation-binding-changed', 409)
    }
    if (!Array.isArray(ctx.workspaceRegistry.archivedSessionIds)) throw new SceneRotationError('rotation-archive-state-unavailable', 503)
    if (ctx.workspaceRegistry.archivedSessionIds.includes(operation.expectedSessionId)) {
      const stateStore = await store()
      return await stateStore.transact(state => {
        const current = state.sceneRotationOperations?.[operation.operationId]
        if (!current || !['bound', 'archive_pending'].includes(current.status)) throw new SceneRotationError('rotation-operation-changed', 409)
        current.status = 'completed'
        current.archiveStatus = 'archived'
        current.updatedAt = Date.now()
        return clone(current)
      }, { compareBeforeRename: true, readback: true, validateCommit: assertOpen })
    }
    if (typeof ctx.workspaceRegistry.archiveSession !== 'function') throw new SceneRotationError('rotation-archive-unavailable', 503)
    try {
      assertOpen()
      await ctx.workspaceRegistry.archiveSession(operation.expectedSessionId, { stopActivity: false })
    } catch {
      assertOpen()
      const stateStore = await store()
      return await stateStore.transact(state => {
        const current = state.sceneRotationOperations?.[operation.operationId]
        if (!current || !['bound', 'archive_pending'].includes(current.status)) throw new SceneRotationError('rotation-operation-changed', 409)
        current.status = 'archive_pending'
        current.archiveStatus = 'pending'
        current.updatedAt = Date.now()
        return clone(current)
      }, { compareBeforeRename: true, readback: true, validateCommit: assertOpen })
    }
    assertOpen()
    const stateStore = await store()
    return await stateStore.transact(state => {
      const current = state.sceneRotationOperations?.[operation.operationId]
      if (!current || !['bound', 'archive_pending'].includes(current.status)) throw new SceneRotationError('rotation-operation-changed', 409)
      current.status = 'completed'
      current.archiveStatus = 'archived'
      current.updatedAt = Date.now()
      return clone(current)
    }, { compareBeforeRename: true, readback: true, validateCommit: assertOpen })
  }
  const continueOperation = async operation => {
    assertOpen()
    const latest = (await (await store()).read()).sceneRotationOperations?.[operation.operationId]
    if (!latest) throw new SceneRotationError('rotation-operation-not-found', 404)
    operation = clone(latest)
    if (operation.status === 'abandoned') throw new SceneRotationError('rotation-abandoned', 409)
    await assertTargetCurrent(operation)
    operation = await assertOperationRunnable(operation.operationId)
    if (operation.status === 'completed') {
      const state = await (await store()).read()
      if (state.roles?.[operation.roleId]?.sessionId !== operation.newSessionId) throw new SceneRotationError('rotation-binding-changed', 409)
      return operation
    }
    if (['bound', 'archive_pending'].includes(operation.status)) return await runArchive(operation)
    if (operation.status === 'creating') {
      const recovered = await reconcileCreatedSession(operation,
        () => assertOperationRunnable(operation.operationId, 'creating'))
      if (!recovered) throw new SceneRotationError('rotation-outcome-unknown', 409)
      await assertOperationRunnable(operation.operationId, 'creating')
      const stateStore = await store()
      assertOpen()
      operation = await stateStore.transact(state => {
        const current = state.sceneRotationOperations?.[operation.operationId]
        if (!current || current.status !== 'creating' || current.createStarted !== true) {
          throw new SceneRotationError('rotation-operation-changed', 409)
        }
        current.status = 'created'
        current.recoveredAfterRestart = true
        current.updatedAt = Date.now()
        return clone(current)
      }, { compareBeforeRename: true, readback: true, validateCommit: assertOpen })
    }
    if (operation.status === 'created') {
      await assertOperationRunnable(operation.operationId, 'created')
      const workspace = ctx.workspaceRegistry.get(operation.workspaceId)
      if (!workspace || workspace.path !== operation.workspacePath) throw new SceneRotationError('rotation-outcome-unknown', 409)
      const stillCurrent = await ensureDurable(ctx, operation.newSessionId, workspace, operation.workspacePath, ROLE_PRESETS[operation.roleId], false)
      if (!stillCurrent()) throw new SceneRotationError('rotation-session-not-durable', 409)
      const stateStore = await store()
      operation = await stateStore.transact(state => {
        const current = state.sceneRotationOperations?.[operation.operationId]
        if (!current || current.status !== 'created') throw new SceneRotationError('rotation-operation-changed', 409)
        current.status = 'durable'
        current.updatedAt = Date.now()
        return clone(current)
      }, { compareBeforeRename: true, readback: true, validateCommit: assertOpen })
    }
    if (operation.status === 'planned') {
      assertOpen()
      const role = operation.roleId
      const workspacePath = await workspacePathForRole(role)
      let workspace = ctx.workspaceRegistry.list().find(item => item.path === workspacePath)
      if (!workspace) {
        await assertOperationRunnable(operation.operationId, 'planned')
        workspace = await ctx.workspaceRegistry.create(workspacePath, `TradeLoom ${role}`)
      }
      workspace = ctx.workspaceRegistry.get(workspace.id)
      if (!workspace || workspace.path !== workspacePath) throw new SceneRotationError('rotation-workspace-unavailable', 503)
      const stateStore = await store()
      assertOpen()
      operation = await stateStore.transact(state => {
        const current = state.sceneRotationOperations?.[operation.operationId]
        if (!current || current.status !== 'planned' || current.createStarted !== false) {
          throw new SceneRotationError('rotation-outcome-unknown', 409)
        }
        current.workspaceId = workspace.id
        current.workspacePath = workspacePath
        current.createStarted = true
        current.status = 'creating'
        current.updatedAt = Date.now()
        return clone(current)
      }, { compareBeforeRename: true, readback: true, validateCommit: assertOpen })
      await assertOperationRunnable(operation.operationId, 'creating')
      let created
      try {
        created = await ctx.sessionController.create({
          workspaceId: workspace.id, agentPreset: ROLE_PRESETS[role], sessionId: operation.newSessionId,
        })
      } catch { throw new SceneRotationError('rotation-outcome-unknown', 503) }
      assertOpen()
      if (created?.sessionId !== operation.newSessionId || created?.agentPreset !== ROLE_PRESETS[role]) {
        throw new SceneRotationError('rotation-outcome-unknown', 409)
      }
      operation = await stateStore.transact(state => {
        const current = state.sceneRotationOperations?.[operation.operationId]
        if (!current || current.status !== 'creating') throw new SceneRotationError('rotation-operation-changed', 409)
        current.status = 'created'
        current.createdAt = Date.now()
        return clone(current)
      }, { compareBeforeRename: true, readback: true, validateCommit: assertOpen })
      return await continueOperation(operation)
    }
    if (operation.status === 'durable') {
      assertOpen()
      const bound = await bindOperation(operation)
      return await runArchive(bound.state)
    }
    throw new SceneRotationError('rotation-outcome-unknown', 409)
  }
  const handle = async (req, res, { method, keys, run }) => {
    const task = (async () => {
      try {
        authorized(req)
        if (req.method !== method) { res.statusCode = 405; res.setHeader('allow', 'POST'); res.end(); return }
        const input = await readInput(req, keys)
        const value = await run(input)
        json(res, 200, value)
      } catch (error) {
        json(res, error.status ?? 503, { error: error.code ?? 'rotation-unavailable' })
      }
    })()
    inFlight.add(task)
    try { await task } finally { inFlight.delete(task) }
  }
  const preview = (req, res) => handle(req, res, { method: 'POST', keys: ['sceneId', 'panelId', 'archiveOld'], run: async input => {
    if (typeof input.sceneId !== 'string' || !ID.test(input.sceneId) || typeof input.panelId !== 'string' || !ID.test(input.panelId)
      || (Object.hasOwn(input, 'archiveOld') && typeof input.archiveOld !== 'boolean')) throw new SceneRotationError('invalid-request', 400)
    const config = await scenes()
    const target = sceneProjection(config, input.sceneId, input.panelId)
    return await withConfigurationLock(target.roleId, async () => {
      const identity = await readIdentityUnderLock(target.roleId)
      const state = await (await store()).read()
      const pendingId = state.pendingSceneRotationByRole?.[target.roleId]
      const pending = typeof pendingId === 'string' ? state.sceneRotationOperations?.[pendingId] : undefined
      if (pending) return { pendingOperation: {
        operationId: pending.operationId, sceneId: pending.sceneId, panelId: pending.panelId,
        roleId: pending.roleId, status: pending.status, sessionId: pending.newSessionId,
      } }
      const binding = bindingSnapshot(state, target.roleId)
      const recoverableArchiveOperations = Object.values(state.sceneRotationOperations ?? {}).filter(operation =>
        operation?.roleId === target.roleId
        && operation.archiveOld === true
        && ['bound', 'archive_pending'].includes(operation.status)
        && operation.newSessionId === binding.sessionId
        && operation.bindingRevisionAfter === binding.bindingRevision)
      if (recoverableArchiveOperations.length > 1) throw new SceneRotationError('rotation-recovery-ambiguous', 409)
      if (recoverableArchiveOperations.length === 1) {
        const operation = recoverableArchiveOperations[0]
        return { pendingOperation: {
          operationId: operation.operationId, sceneId: operation.sceneId, panelId: operation.panelId,
          roleId: operation.roleId, status: operation.status, sessionId: operation.newSessionId,
        } }
      }
      const archivedSessionIds = ctx.workspaceRegistry.archivedSessionIds
      const workspace = ctx.workspaceRegistry.get(binding.workspaceId)
      if (!Array.isArray(archivedSessionIds) || archivedSessionIds.includes(binding.sessionId)
        || !workspace || workspace.path !== binding.workspacePath
        || binding.workspacePath !== await workspacePathForRole(target.roleId)) {
        throw new SceneRotationError('rotation-binding-unavailable', 503)
      }
      const oldSessionCurrent = await ensureDurable(ctx, binding.sessionId, workspace, binding.workspacePath, binding.agentPreset, false)
      if (!oldSessionCurrent()) throw new SceneRotationError('rotation-binding-unavailable', 503)
      const writeRevision = sceneWriteRevision(state, target.scene.id)
      const createdAt = Date.now()
      prunePreviews(createdAt)
      const previewToken = randomUUID()
      const operationId = randomUUID()
      const hostEpoch = currentHostEpoch()
      const record = Object.freeze({
        previewToken, operationId, sceneId: target.scene.id, panelId: target.panel.id, roleId: target.roleId,
        expectedSessionId: binding.sessionId, roleBindingRevision: binding.bindingRevision, hostEpoch,
        profileRevision: Object.freeze({
          managedConfigurationSequence: identity.managedConfigurationSequence,
          roleManagedConfigDigest: identity.roleManagedConfigDigest,
          sceneMemoryWriteRevision: writeRevision,
        }),
        handoffRevision: Object.freeze({ sceneMemoryWriteRevision: writeRevision }),
        impactPanels: Object.freeze(target.impactPanels.map(item => Object.freeze(item))),
        archiveOld: input.archiveOld === true, createdAt, expiresAt: createdAt + PREVIEW_TTL_MS,
      })
      previews.set(previewToken, record)
      return {
        previewToken, operationId, sceneId: record.sceneId, panelId: record.panelId, roleId: record.roleId,
        expectedSessionId: record.expectedSessionId, roleBindingRevision: record.roleBindingRevision,
        hostEpoch: record.hostEpoch, profileRevision: record.profileRevision, handoffRevision: record.handoffRevision,
        impactPanels: record.impactPanels, impactScope: 'current-config-visible-panels',
        impactMessage: '轮换此角色会话，同角色面板同步受影响。',
        archiveOld: record.archiveOld, expiresAt: record.expiresAt,
      }
    })
  } })
  const confirm = (req, res) => handle(req, res, { method: 'POST', keys: ['previewToken'], run: async input => {
    if (typeof input.previewToken !== 'string' || !ID.test(input.previewToken)) throw new SceneRotationError('invalid-request', 400)
    const ongoing = confirmationFlights.get(input.previewToken)
    if (ongoing) return await ongoing
    const used = consumedPreviews.get(input.previewToken)
    if (used) {
      const prior = (await (await store()).read()).sceneRotationOperations?.[used.operationId]
      if (prior) return { operationId: prior.operationId, roleId: prior.roleId, sessionId: prior.newSessionId,
        status: prior.status, archiveStatus: prior.archiveStatus ?? null, replayed: true }
      throw new SceneRotationError('rotation-preview-expired', 409)
    }
    const previewRecord = previews.get(input.previewToken)
    if (!previewRecord || previewRecord.expiresAt <= Date.now()) throw new SceneRotationError('rotation-preview-expired', 409)
    previews.delete(input.previewToken)
    consumedPreviews.set(input.previewToken, { operationId: previewRecord.operationId, expiresAt: previewRecord.expiresAt })
    const confirmation = (async () => {
      const { previewToken: _requestToken, ...capturedTarget } = previewRecord
      const operation = {
        ...capturedTarget,
        newSessionId: `session-${previewRecord.operationId}`,
        status: 'planned', createStarted: false, createdAt: Date.now(), updatedAt: Date.now(),
      }
      await withConfigurationLock(operation.roleId, async () => {
        await assertTargetCurrent(operation)
        const identity = await readIdentityUnderLock(operation.roleId)
        assertOpen()
        if (currentHostEpoch() !== operation.hostEpoch
          || identity.managedConfigurationSequence !== operation.profileRevision.managedConfigurationSequence
          || identity.roleManagedConfigDigest !== operation.profileRevision.roleManagedConfigDigest) throw new SceneRotationError('rotation-stale-preview', 409)
        const stateStore = await store()
        await stateStore.transact(state => {
          const currentBinding = bindingSnapshot(state, operation.roleId)
          if (currentBinding.sessionId !== operation.expectedSessionId
            || currentBinding.bindingRevision !== operation.roleBindingRevision
            || sceneWriteRevision(state, operation.sceneId) !== operation.profileRevision.sceneMemoryWriteRevision) {
            throw new SceneRotationError('rotation-stale-preview', 409)
          }
          state.sceneRotationOperations ??= {}
          state.pendingSceneRotationByRole ??= {}
          if (state.pendingSceneRotationByRole[operation.roleId] || state.pendingSessionCreateByRole?.[operation.roleId]) {
            throw new SceneRotationError('rotation-in-progress', 409)
          }
          state.sceneRotationOperations[operation.operationId] = clone(operation)
          state.pendingSceneRotationByRole[operation.roleId] = operation.operationId
        }, { compareBeforeRename: true, readback: true, validateCommit: assertOpen })
      })
      const result = await continueOperation(operation)
      return { operationId: operation.operationId, roleId: operation.roleId, sessionId: result.newSessionId,
        status: result.status, archiveStatus: result.archiveStatus ?? null }
    })()
    confirmationFlights.set(input.previewToken, confirmation)
    try { return await confirmation } finally { confirmationFlights.delete(input.previewToken) }
  } })
  const lookup = async input => {
    if (typeof input.operationId !== 'string' || !ID.test(input.operationId)) throw new SceneRotationError('invalid-request', 400)
    const state = await (await store()).read()
    const operation = state.sceneRotationOperations?.[input.operationId]
    if (!operation) throw new SceneRotationError('rotation-operation-not-found', 404)
    return operation
  }
  const status = (req, res) => handle(req, res, { method: 'POST', keys: ['operationId'], run: async input => {
    const operation = await lookup(input)
    return { operationId: operation.operationId, roleId: operation.roleId, status: operation.status,
      sessionId: operation.newSessionId, archiveStatus: operation.archiveStatus ?? null }
  } })
  const resume = (req, res) => handle(req, res, { method: 'POST', keys: ['operationId'], run: async input => {
    const operation = await lookup(input)
    const result = await continueOperation(operation)
    return { operationId: result.operationId, roleId: result.roleId, status: result.status,
      sessionId: result.newSessionId, archiveStatus: result.archiveStatus ?? null }
  } })
  const cancel = (req, res) => handle(req, res, { method: 'POST', keys: ['previewToken'], run: async input => {
    if (typeof input.previewToken !== 'string' || !ID.test(input.previewToken)) throw new SceneRotationError('invalid-request', 400)
    const preview = previews.get(input.previewToken)
    if (preview && preview.expiresAt > Date.now()) {
      previews.delete(input.previewToken)
      return { cancelled: true, operationId: preview.operationId }
    }
    const consumed = consumedPreviews.get(input.previewToken)
    if (!consumed) throw new SceneRotationError('rotation-preview-expired', 409)
    const operation = (await (await store()).read()).sceneRotationOperations?.[consumed.operationId]
    return { cancelled: false, operationId: consumed.operationId, status: operation?.status ?? 'confirming' }
  } })
  const abandon = (req, res) => handle(req, res, { method: 'POST', keys: ['operationId'], run: async input => {
    if (typeof input.operationId !== 'string' || !ID.test(input.operationId)) throw new SceneRotationError('invalid-request', 400)
    const stateStore = await store()
    const outcome = await stateStore.transact(state => {
      const operation = state.sceneRotationOperations?.[input.operationId]
      if (!operation) return { error: 'rotation-operation-not-found', status: 404 }
      if (['bound', 'completed', 'archive_pending'].includes(operation.status)) {
        return { alreadyBound: true, status: operation.status, sessionId: operation.newSessionId }
      }
      const binding = state.roles?.[operation.roleId]
      if (binding?.sessionId === operation.newSessionId) {
        return { alreadyBound: true, status: operation.status, sessionId: operation.newSessionId }
      }
      const pointerOwned = state.pendingSceneRotationByRole?.[operation.roleId] === operation.operationId
      const bindingChanged = binding?.sessionId !== operation.expectedSessionId
        || getRoleBindingRevision(state, operation.roleId) !== operation.roleBindingRevision
      if (bindingChanged && !pointerOwned) {
        return { error: 'rotation-binding-changed', status: 409 }
      }
      const wasCreateStarted = operation.createStarted === true
      operation.abandonedFromStatus = operation.status
      operation.status = 'abandoned'
      operation.abandonRequestedAt = Date.now()
      operation.externalEffectStatus = wasCreateStarted ? 'unknown-or-created' : 'not-started'
      if (pointerOwned) delete state.pendingSceneRotationByRole[operation.roleId]
      return { abandoned: true, status: operation.status, externalEffectStatus: operation.externalEffectStatus,
        pendingReleased: pointerOwned, bindingChanged, sessionId: operation.newSessionId }
    }, { compareBeforeRename: true, readback: true, validateCommit: assertOpen })
    if (outcome.error) throw new SceneRotationError(outcome.error, outcome.status)
    return outcome
  } })

  return Object.freeze({
    preview, confirm, status, resume, cancel, abandon,
    async dispose() {
      disposed = true
      previews.clear()
      await Promise.allSettled([...inFlight])
    },
  })
}
