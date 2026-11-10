import { randomUUID } from 'node:crypto'

const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
const OPERATION_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
const sharedTasks = new Map()
const fallbackTasks = new WeakMap()

function codedError(code) { return Object.assign(new Error(code), { code }) }
function clone(value) { return JSON.parse(JSON.stringify(value)) }

function requiredMethod(target, name) {
  if (!target || typeof target[name] !== 'function') throw codedError('scene_rotation_sdk_unavailable')
  return target[name].bind(target)
}

function taskKey(ownerKey, operationId) {
  return typeof ownerKey === 'string' ? `${ownerKey.length}:${ownerKey}${operationId}` : operationId
}

function getTask(ownerKey, operationId) {
  const key = taskKey(ownerKey, operationId)
  if (typeof ownerKey === 'string') return sharedTasks.get(key)
  return fallbackTasks.get(ownerKey)?.get(key)
}

function setTask(ownerKey, operationId, entry) {
  const key = taskKey(ownerKey, operationId)
  if (typeof ownerKey === 'string') sharedTasks.set(key, entry)
  else {
    let tasks = fallbackTasks.get(ownerKey)
    if (!tasks) { tasks = new Map(); fallbackTasks.set(ownerKey, tasks) }
    tasks.set(key, entry)
  }
  return key
}

function taskFingerprint(value) {
  return JSON.stringify([value.recoverOperationId, value.operationId, value.sceneId, value.oldSessionId, value.plannedSessionId,
    value.bindingRevision, value.profileRevision, value.handoffRevision, value.archiveOld,
    value.workspaceId, value.cwd, value.agentPreset])
}

function releaseTask(ownerKey, operationId, entry) {
  const key = taskKey(ownerKey, operationId)
  const map = typeof ownerKey === 'string' ? sharedTasks : fallbackTasks.get(ownerKey)
  if (!map) return
  if (map.get(key) === entry) map.delete(key)
}

function assertSessionInfo(info, expected) {
  if (!info || info.sessionId !== expected.sessionId || info.archived === true
    || typeof info.cwd !== 'string' || info.cwd !== expected.cwd
    || !Number.isSafeInteger(info.turnCount) || info.turnCount !== 0
    || !Number.isSafeInteger(info.userMessageCount) || info.userMessageCount !== 0) {
    throw codedError('scene_rotation_session_mismatch')
  }
  if (expected.agentPreset !== null && info.agentPreset !== expected.agentPreset) throw codedError('scene_rotation_session_mismatch')
}

function workspaceContains(info, workspaceId) {
  return Array.isArray(info.workspaceIds) && info.workspaceIds.includes(workspaceId)
}

/**
 * A trusted Host/controller-only rotation coordinator. Preview tokens are
 * memory-only; persistence begins only after execute() accepts one.
 */
export function createSceneRotationController(options = {}) {
  const { sceneMemory, adapter } = options
  if (!sceneMemory || typeof sceneMemory.getRotationSnapshot !== 'function'
    || typeof sceneMemory.beginRotation !== 'function' || typeof sceneMemory.getRotationOperation !== 'function'
    || typeof sceneMemory.abandonRotation !== 'function') {
    throw codedError('scene_memory_unavailable')
  }
  for (const method of ['newSessionId', 'inspectSession', 'createSession', 'flushSession', 'attachSession', 'archiveSession', 'isArchived']) {
    requiredMethod(adapter, method)
  }
  const now = typeof options.now === 'function' ? options.now : () => new Date().toISOString()
  const ttlMs = options.previewTtlMs ?? 5 * 60_000
  if (!Number.isSafeInteger(ttlMs) || ttlMs < 1 || ttlMs > 60 * 60_000) throw codedError('invalid_arguments')
  const previews = new Map()
  const ownTasks = new Set()
  let disposed = false
  const sharedOwnerKey = sceneMemory.rotationOwnerKey ?? sceneMemory

  async function preview(sceneId, input = {}) {
    if (disposed) throw codedError('scene_rotation_closed')
    if (!input || Object.keys(input).some(key => !['archiveOld', 'recoverOperationId'].includes(key))
      || typeof input.archiveOld !== 'boolean'
      || (input.recoverOperationId !== undefined && (typeof input.recoverOperationId !== 'string' || !OPERATION_ID.test(input.recoverOperationId)))) {
      throw codedError('invalid_arguments')
    }
    const snapshot = await sceneMemory.getRotationSnapshot(sceneId)
    if (snapshot.oldSessionId === null || snapshot.handoff === null) throw codedError('scene_rotation_not_ready')
    const old = await adapter.inspectSession(snapshot.oldSessionId)
    if (!old || old.sessionId !== snapshot.oldSessionId || old.archived === true || typeof old.cwd !== 'string' || !old.cwd) {
      throw codedError('scene_rotation_old_session_unavailable')
    }
    const workspaceIds = Array.isArray(old.workspaceIds) ? [...new Set(old.workspaceIds)] : []
    if (workspaceIds.some(id => typeof id !== 'string') || workspaceIds.length > 1) throw codedError('scene_rotation_workspace_ambiguous')
    const workspaceId = workspaceIds[0] ?? null
    const agentPreset = typeof old.agentPreset === 'string' && old.agentPreset.length > 0 ? old.agentPreset : null
    let operationId
    let plannedSessionId
    if (input.recoverOperationId !== undefined) {
      const operation = await sceneMemory.getRotationOperation(input.recoverOperationId)
      if (!operation || operation.phase !== 'needs_review' || operation.oldSessionId !== snapshot.oldSessionId
        || operation.createdSessionId !== operation.plannedSessionId) throw codedError('scene_rotation_state_conflict')
      operationId = operation.operationId
      plannedSessionId = operation.plannedSessionId
    } else {
      operationId = `rotation-${randomUUID()}`
      plannedSessionId = await adapter.newSessionId()
    }
    if (typeof operationId !== 'string' || !OPERATION_ID.test(operationId)
      || typeof plannedSessionId !== 'string' || !SESSION_ID.test(plannedSessionId)) throw codedError('scene_rotation_sdk_unavailable')
    const exists = await adapter.inspectSession(plannedSessionId)
    if (input.recoverOperationId === undefined && exists) throw codedError('scene_rotation_id_collision')
    const previewId = randomUUID()
    const expiresAt = Date.now() + ttlMs
    const value = {
      previewId,
      operationId,
      sceneId,
      oldSessionId: snapshot.oldSessionId,
      plannedSessionId,
      bindingRevision: snapshot.bindingRevision,
      profileRevision: snapshot.profileRevision,
      handoffRevision: snapshot.handoffRevision,
      handoff: snapshot.handoff,
      profile: snapshot.profile,
      archiveOld: input.archiveOld,
      workspaceId,
      cwd: old.cwd,
      agentPreset,
      recoverOperationId: input.recoverOperationId ?? null,
      expiresAt: new Date(expiresAt).toISOString(),
    }
    previews.set(previewId, { value, expiresAt, started: false })
    return clone(value)
  }

  function cancel(previewId) {
    const entry = previews.get(previewId)
    if (!entry || entry.started) return false
    previews.delete(previewId)
    return true
  }

  async function execute(previewId) {
    if (disposed) throw codedError('scene_rotation_closed')
    const entry = previews.get(previewId)
    if (!entry) throw codedError('scene_rotation_preview_expired')
    if (entry.started) {
      const existing = getTask(sharedOwnerKey, entry.value.operationId)
      return existing ? await existing.promise : await sceneMemory.getRotationOperation(entry.value.operationId)
    }
    if (entry.expiresAt <= Date.now()) throw codedError('scene_rotation_preview_expired')
    const { value } = entry
    const fingerprint = taskFingerprint(value)
    const inFlight = getTask(sharedOwnerKey, value.operationId)
    if (inFlight) {
      if (inFlight.intentFingerprint !== fingerprint) throw codedError('scene_rotation_in_progress')
      entry.started = true
      return await inFlight.promise
    }
    entry.started = true
    const task = (async () => {
      if (value.recoverOperationId) {
        const operation = await sceneMemory.rebaseRotation({
          operationId: value.operationId,
          bindingRevision: value.bindingRevision,
          profileRevision: value.profileRevision,
          handoffRevision: value.handoffRevision,
          archiveOld: value.archiveOld,
        })
        return await runOperation(operation.operationId)
      }
      await sceneMemory.beginRotation({
        sceneId: value.sceneId,
        operationId: value.operationId,
        oldSessionId: value.oldSessionId,
        plannedSessionId: value.plannedSessionId,
        bindingRevision: value.bindingRevision,
        profileRevision: value.profileRevision,
        handoffRevision: value.handoffRevision,
        archiveOld: value.archiveOld,
        workspaceId: value.workspaceId,
        cwd: value.cwd,
        agentPreset: value.agentPreset,
      })
      return await runOperation(value.operationId)
    })()
    const taskEntry = { promise: task, intentFingerprint: fingerprint, kind: 'rotation' }
    setTask(sharedOwnerKey, value.operationId, taskEntry)
    ownTasks.add(task)
    task.then(
      () => { releaseTask(sharedOwnerKey, value.operationId, taskEntry); ownTasks.delete(task) },
      () => { releaseTask(sharedOwnerKey, value.operationId, taskEntry); ownTasks.delete(task) },
    )
    return await task
  }

  async function runOperation(operationId) {
    let operation = await sceneMemory.getRotationOperation(operationId)
    if (!operation) throw codedError('scene_rotation_not_found')
    if (operation.phase === 'complete' || operation.phase === 'needs_review' || operation.phase === 'abandoned') return operation
    try {
      if (operation.phase === 'planned') {
        let info = await adapter.inspectSession(operation.plannedSessionId)
        if (!info) {
          try {
            const result = await adapter.createSession({
              sessionId: operation.plannedSessionId,
              workspaceId: operation.workspaceId,
              cwd: operation.cwd,
              agentPreset: operation.agentPreset,
            })
            if (typeof result?.sessionId === 'string') {
              operation = await sceneMemory.recordRotationCreated(operationId, result.sessionId)
            } else {
              // A malformed/empty response does not prove that the SDK failed
              // to create the planned identity. Resolve it only by exact lookup.
              info = await adapter.inspectSession(operation.plannedSessionId)
              operation = await sceneMemory.recordRotationCreated(operationId,
                info?.sessionId === operation.plannedSessionId ? operation.plannedSessionId : null)
            }
          } catch {
            // A rejected/uncertain SDK response is resolved only by looking up
            // the exact persisted ID; it is never matched by title or list order.
            info = await adapter.inspectSession(operation.plannedSessionId)
            if (!info) return await sceneMemory.markRotationFailure(operationId, 'planned', 'scene_rotation_create_failed')
            operation = await sceneMemory.recordRotationCreated(operationId, operation.plannedSessionId)
          }
          if (operation.phase === 'needs_review') return operation
        } else {
          operation = await sceneMemory.recordRotationCreated(operationId, operation.plannedSessionId)
        }
        if (operation.phase === 'needs_review') return operation
      }
      operation = await sceneMemory.getRotationOperation(operationId)
      if (operation.phase === 'session_created') {
        await ensureDurableSession(operation)
        operation = await sceneMemory.markRotationDurable(operationId)
      }
      if (operation.phase === 'durable') {
        operation = await sceneMemory.commitRotation(operationId)
        if (operation.phase === 'needs_review') return operation
      }
      if (operation.phase === 'archive_pending') {
        if (!await adapter.isArchived(operation.oldSessionId)) {
          await adapter.archiveSession(operation.oldSessionId)
        }
        if (!await adapter.isArchived(operation.oldSessionId)) {
          return await sceneMemory.markRotationFailure(operationId, 'archive_pending', 'scene_rotation_archive_failed')
        }
        operation = await sceneMemory.completeRotation(operationId)
      }
      return operation
    } catch (failure) {
      operation = await sceneMemory.getRotationOperation(operationId)
      const code = failure?.code === 'scene_rotation_session_mismatch' ? 'scene_rotation_session_mismatch'
        : failure?.code === 'scene_rotation_workspace_mismatch' ? 'scene_rotation_workspace_mismatch'
          : failure?.code === 'scene_rotation_session_not_durable' ? 'scene_rotation_session_not_durable'
            : operation?.phase === 'archive_pending' ? 'scene_rotation_archive_failed'
              : 'scene_rotation_create_failed'
      return await sceneMemory.markRotationFailure(operationId, operation.phase, code)
    }
  }

  async function ensureDurableSession(operation) {
    let info = await adapter.inspectSession(operation.plannedSessionId)
    if (!info) throw codedError('scene_rotation_session_not_durable')
    assertSessionInfo(info, { sessionId: operation.plannedSessionId, cwd: operation.cwd, agentPreset: operation.agentPreset })
    if (operation.workspaceId !== null && !workspaceContains(info, operation.workspaceId)) {
      try { await adapter.attachSession(operation.workspaceId, operation.plannedSessionId) } catch {
        throw codedError('scene_rotation_workspace_mismatch')
      }
      info = await adapter.inspectSession(operation.plannedSessionId)
      if (!info || !workspaceContains(info, operation.workspaceId)) throw codedError('scene_rotation_workspace_mismatch')
      assertSessionInfo(info, { sessionId: operation.plannedSessionId, cwd: operation.cwd, agentPreset: operation.agentPreset })
    }
    if (operation.workspaceId === null && Array.isArray(info.workspaceIds) && info.workspaceIds.length > 0) {
      throw codedError('scene_rotation_workspace_mismatch')
    }
    try { await adapter.flushSession(operation.plannedSessionId) } catch {
      throw codedError('scene_rotation_session_not_durable')
    }
    info = await adapter.inspectSession(operation.plannedSessionId)
    if (!info) throw codedError('scene_rotation_session_not_durable')
    assertSessionInfo(info, { sessionId: operation.plannedSessionId, cwd: operation.cwd, agentPreset: operation.agentPreset })
    if (operation.workspaceId !== null && !workspaceContains(info, operation.workspaceId)) throw codedError('scene_rotation_workspace_mismatch')
  }

  async function resume(operationId) {
    if (disposed) throw codedError('scene_rotation_closed')
    const inFlight = getTask(sharedOwnerKey, operationId)
    if (inFlight) return await inFlight.promise
    const task = Promise.resolve().then(async () => {
      const operation = await sceneMemory.getRotationOperation(operationId)
      if (!operation) throw codedError('scene_rotation_not_found')
      if (operation.phase === 'complete' || operation.phase === 'needs_review' || operation.phase === 'abandoned') return operation
      return await runOperation(operationId)
    })
    const taskEntry = { promise: task, intentFingerprint: null, kind: 'resume' }
    setTask(sharedOwnerKey, operationId, taskEntry)
    ownTasks.add(task)
    task.then(
      () => { releaseTask(sharedOwnerKey, operationId, taskEntry); ownTasks.delete(task) },
      () => { releaseTask(sharedOwnerKey, operationId, taskEntry); ownTasks.delete(task) },
    )
    return await task
  }

  async function abandon(operationId) {
    if (disposed) throw codedError('scene_rotation_closed')
    if (typeof operationId !== 'string' || !OPERATION_ID.test(operationId)) throw codedError('invalid_arguments')
    const inFlight = getTask(sharedOwnerKey, operationId)
    if (inFlight) {
      if (inFlight.kind === 'abandon') return await inFlight.promise
      throw codedError('scene_rotation_in_progress')
    }
    // Reserve this operation key before the asynchronous store transaction so
    // resume/execute cannot slip between the liveness check and terminal write.
    const task = Promise.resolve().then(() => sceneMemory.abandonRotation(operationId))
    const taskEntry = { promise: task, intentFingerprint: null, kind: 'abandon' }
    setTask(sharedOwnerKey, operationId, taskEntry)
    ownTasks.add(task)
    task.then(
      () => { releaseTask(sharedOwnerKey, operationId, taskEntry); ownTasks.delete(task) },
      () => { releaseTask(sharedOwnerKey, operationId, taskEntry); ownTasks.delete(task) },
    )
    return await task
  }

  async function getOperation(operationId) { return await sceneMemory.getRotationOperation(operationId) }

  async function dispose() {
    if (disposed) return
    disposed = true
    await Promise.allSettled([...ownTasks])
  }

  return Object.freeze({ preview, cancel, execute, resume, abandon, getOperation, dispose })
}

/**
 * Adapter over the rep12 public local SDK services. It never starts an AgentLoop
 * or writes a user message; SessionController creates a blank session only.
 */
export function createSdkSceneRotationAdapter(ctx) {
  const sessionController = ctx?.sessionController ?? ctx?.get?.('sessionController')
  const sessions = ctx?.sessions
  const sessionPersistence = ctx?.sessionPersistence ?? ctx?.get?.('sessionPersistence')
  const sessionQuery = ctx?.sessionQuery
  const workspaceRegistry = ctx?.workspaceRegistry
  requiredMethod(sessionController, 'create')
  requiredMethod(sessions, 'get')
  requiredMethod(sessions, 'flush')
  requiredMethod(sessionPersistence, 'stat')
  requiredMethod(sessionPersistence, 'flush')
  requiredMethod(sessionQuery, 'observeSession')
  requiredMethod(workspaceRegistry, 'list')
  requiredMethod(workspaceRegistry, 'get')
  requiredMethod(workspaceRegistry, 'archiveSession')

  async function inspectSession(sessionId) {
    const snapshot = await sessionPersistence.stat(sessionId)
    if (!snapshot) return null
    let observation
    try { observation = await sessionQuery.observeSession(sessionId) } catch (failure) {
      if (failure?.code === 'SESSION_QUERY_SESSION_NOT_FOUND') return null
      throw failure
    }
    try {
      const header = observation.header
      const events = Array.isArray(observation.events) ? observation.events : []
      const workspaces = workspaceRegistry.list().filter(workspace => workspace.sessionIds.includes(sessionId))
      const liveAgent = ctx.agents?.get?.(sessionId)
      let agentPreset = typeof header.agentPreset === 'string' ? header.agentPreset : null
      if (liveAgent?.session?.header?.agentPreset && typeof liveAgent.session.header.agentPreset === 'string') {
        agentPreset = liveAgent.session.header.agentPreset
      }
      const selectedPreset = [...events].reverse().find(event => event.type === 'agent-preset/selected')?.data?.agentPreset
      if (typeof selectedPreset === 'string') agentPreset = selectedPreset
      return {
        sessionId,
        cwd: typeof header.cwd === 'string' ? header.cwd : '',
        agentPreset,
        workspaceIds: workspaces.map(workspace => workspace.id),
        archived: workspaceRegistry.archivedSessionIds.includes(sessionId),
        turnCount: events.filter(event => event.type === 'turn/start').length,
        userMessageCount: events.filter(event => event.type === 'user/message').length,
      }
    } finally {
      observation[Symbol.dispose]?.()
    }
  }

  return Object.freeze({
    newSessionId: () => `session-${randomUUID()}`,
    inspectSession,
    async createSession({ sessionId, workspaceId, cwd, agentPreset }) {
      const result = await sessionController.create({
        sessionId,
        ...(workspaceId !== null ? { workspaceId } : { cwd }),
        ...(agentPreset !== null ? { agentPreset } : {}),
      })
      return { sessionId: result?.sessionId }
    },
    async flushSession(sessionId) {
      const live = sessions.get(sessionId)
      if (live) await sessions.flush(live)
      await sessionPersistence.flush()
      const snapshot = await sessionPersistence.stat(sessionId)
      if (!snapshot) throw codedError('scene_rotation_session_not_durable')
    },
    async attachSession(workspaceId, sessionId) {
      const workspace = workspaceRegistry.get(workspaceId)
      if (!workspace) throw codedError('scene_rotation_workspace_mismatch')
      await workspace.attachSession(sessionId)
    },
    async archiveSession(sessionId) {
      await workspaceRegistry.archiveSession(sessionId, { stopActivity: false })
    },
    async isArchived(sessionId) { return workspaceRegistry.archivedSessionIds.includes(sessionId) },
  })
}

export const SCENE_ROTATION_ERROR_CODES = Object.freeze([
  'scene_rotation_closed', 'scene_rotation_preview_expired', 'scene_rotation_not_ready', 'scene_rotation_not_found',
  'scene_rotation_in_progress', 'scene_rotation_state_conflict', 'scene_rotation_stale_preview',
  'scene_rotation_idempotency_conflict', 'scene_rotation_session_conflict', 'scene_rotation_old_session_unavailable',
  'scene_rotation_workspace_ambiguous', 'scene_rotation_id_collision', 'scene_rotation_sdk_unavailable',
  'scene_rotation_create_failed', 'scene_rotation_create_unavailable', 'scene_rotation_session_mismatch',
  'scene_rotation_session_not_durable', 'scene_rotation_workspace_mismatch', 'scene_rotation_binding_conflict',
  'scene_rotation_session_unverified', 'scene_rotation_archive_failed', 'scene_rotation_session_reserved',
])
