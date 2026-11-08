import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { getRoleBindingRevision, ROLE_IDS } from './state.js'

const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const DEFAULT_OPERATION_STATUS_TTL_MS = 5 * 60_000
const cloneJson = value => {
  const encoded = JSON.stringify(value)
  if (encoded === undefined) throw new TypeError('scene-memory values must be JSON serializable')
  return JSON.parse(encoded)
}
const deepFreeze = value => {
  if (!isRecord(value) && !Array.isArray(value)) return value
  for (const child of Object.values(value)) deepFreeze(child)
  return Object.freeze(value)
}
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')

export class SceneMemoryOriginError extends Error {
  constructor(code, message = code) { super(message); this.name = 'SceneMemoryOriginError'; this.code = code }
}

function assertOriginTuple(origin, sceneId) {
  if (!isRecord(origin) || origin.scope !== 'role' || origin.sceneId !== sceneId
    || typeof origin.panelId !== 'string' || !origin.panelId
    || !ROLE_IDS.includes(origin.roleId)
    || typeof origin.sessionId !== 'string' || !origin.sessionId
    || typeof origin.workspaceId !== 'string' || !origin.workspaceId
    || typeof origin.workspacePath !== 'string' || !origin.workspacePath
    || typeof origin.agentPreset !== 'string' || !origin.agentPreset
    || typeof origin.bindingRevision !== 'string' || !/^(?:0|[1-9][0-9]{0,63})$/.test(origin.bindingRevision)
    || typeof origin.operationId !== 'string' || !origin.operationId
    || typeof origin.hostEpoch !== 'string' || !origin.hostEpoch) {
    throw new SceneMemoryOriginError('invalid_operation_origin')
  }
}

function assertCurrentBinding(state, origin) {
  const binding = state.roles?.[origin.roleId]
  if (!binding || binding.sessionId !== origin.sessionId || binding.workspaceId !== origin.workspaceId
    || binding.workspacePath !== origin.workspacePath || binding.agentPreset !== origin.agentPreset
    || getRoleBindingRevision(state, origin.roleId) !== origin.bindingRevision) {
    throw new SceneMemoryOriginError('stale_role_binding')
  }
  const operation = state.sceneMemoryOperations?.[origin.operationId]
  if (operation?.status === 'terminal') throw new SceneMemoryOriginError('operation_terminal')
  if (operation?.status !== 'active' || operation.hostEpoch !== origin.hostEpoch || operation.expiresAt !== origin.activeUntil) {
    throw new SceneMemoryOriginError('operation_revoked')
  }
}

function currentSceneRecord(state, sceneId) {
  const root = state.sceneMemories
  return isRecord(root) && isRecord(root[sceneId]) ? root[sceneId] : undefined
}

export function createSceneMemoryStore({ stateStore, isSessionLive, isSessionDurable, isOperationActive, onBeforeCommitAttempt = async () => {}, now = Date.now, operationStatusTtlMs = DEFAULT_OPERATION_STATUS_TTL_MS } = {}) {
  if (!stateStore || typeof stateStore.transact !== 'function' || typeof stateStore.read !== 'function'
    || typeof stateStore.writeImmutableBackup !== 'function' || typeof stateStore.verifyImmutableBackup !== 'function' || !stateStore.paths?.statePath) {
    throw new TypeError('scene memory requires the owned state transaction store')
  }
  if (typeof isSessionLive !== 'function' || typeof isSessionDurable !== 'function'
    || typeof isOperationActive !== 'function' || typeof onBeforeCommitAttempt !== 'function' || typeof now !== 'function'
    || !Number.isSafeInteger(operationStatusTtlMs) || operationStatusTtlMs < 1) {
    throw new TypeError('scene-memory requires trusted live/archive, durability, and active-operation resolvers')
  }

  async function transact(origin, sceneId, kind, action) {
    assertOriginTuple(origin, sceneId)
    let needsMigrationBackup = false
    let legacySnapshotDigest
    const assertLive = async currentState => {
      assertCurrentBinding(currentState, origin)
      if (!isOperationActive(origin)) throw new SceneMemoryOriginError('operation_revoked')
      if (!isSessionLive(origin) || !await isSessionDurable(origin)) throw new SceneMemoryOriginError('session_not_live')
      if (origin.activeUntil <= now()) throw new SceneMemoryOriginError('operation_expired')
      assertCurrentBinding(currentState, origin)
      if (!isOperationActive(origin)) throw new SceneMemoryOriginError('operation_revoked')
      if (!isSessionLive(origin)) throw new SceneMemoryOriginError('session_not_live')
    }
    return await stateStore.transact(async state => {
      await assertLive(state)
      if (kind === 'write' && state.sceneMemoryMigration?.version !== 1
        && (Object.hasOwn(state, 'sceneMemory') || Object.hasOwn(state, 'sceneMemoryLineage'))) needsMigrationBackup = true
      legacySnapshotDigest = state.sceneMemoryLegacyBackup?.sha256
      return await action(state)
    }, {
      readOnly: kind === 'read',
      compareBeforeRename: kind !== 'read',
      readback: kind !== 'read',
      beforeRename: async ({ previousBytes }) => {
        if (!needsMigrationBackup || !previousBytes) return
      if (typeof legacySnapshotDigest !== 'string') throw new SceneMemoryOriginError('legacy_backup_missing')
      const name = `legacy-${legacySnapshotDigest}.json`
      const verified = await stateStore.verifyImmutableBackup(name, legacySnapshotDigest).catch(cause => {
        throw new SceneMemoryOriginError('legacy_backup_mismatch', cause.message)
      })
      if (!verified.length || sha256(verified) !== legacySnapshotDigest) throw new SceneMemoryOriginError('legacy_backup_mismatch')
      return
      },
      beforeCommitAttempt: async () => {
        await onBeforeCommitAttempt(Object.freeze({ origin }))
        await assertLive(await stateStore.read())
      },
      validateCommit: () => {
        if (!isOperationActive(origin)) throw new SceneMemoryOriginError('operation_revoked')
        if (!isSessionLive(origin)) throw new SceneMemoryOriginError('session_not_live')
        if (origin.activeUntil <= now()) throw new SceneMemoryOriginError('operation_expired')
      },
    })
  }

  return Object.freeze({
    async read(origin, sceneId) {
      return await transact(origin, sceneId, 'read', state => {
        const record = currentSceneRecord(state, sceneId)
        return deepFreeze(cloneJson(record?.value ?? null))
      })
    },
    async write(origin, sceneId, value) {
      const detached = cloneJson(value)
      return await transact(origin, sceneId, 'write', state => {
        const previous = currentSceneRecord(state, sceneId)
        const memories = isRecord(state.sceneMemories) ? state.sceneMemories : {}
        if (state.sceneMemoryMigration?.version !== 1) {
          const legacyExists = Object.hasOwn(state, 'sceneMemory') || Object.hasOwn(state, 'sceneMemoryLineage')
          if (legacyExists) {
            const legacyRecord = isRecord(memories[sceneId]) ? memories[sceneId] : {}
            if (!Object.hasOwn(legacyRecord, 'value') && Object.hasOwn(state, 'sceneMemory')) legacyRecord.value = cloneJson(state.sceneMemory)
            if (!Object.hasOwn(legacyRecord, 'lineage') && Object.hasOwn(state, 'sceneMemoryLineage')) legacyRecord.lineage = cloneJson(state.sceneMemoryLineage)
            memories[sceneId] = legacyRecord
          }
          state.sceneMemoryMigration = { ...(isRecord(state.sceneMemoryMigration) ? state.sceneMemoryMigration : {}), version: 1 }
        }
        const current = isRecord(memories[sceneId]) ? memories[sceneId] : previous ?? {}
        memories[sceneId] = {
          ...current,
          value: detached,
          lineage: current.lineage ?? {
            operationId: origin.operationId,
            roleId: origin.roleId,
            sessionId: origin.sessionId,
            bindingRevision: origin.bindingRevision,
          },
        }
        state.sceneMemories = memories
        const operations = isRecord(state.sceneMemoryOperations) ? state.sceneMemoryOperations : {}
        operations[origin.operationId] = { status: 'active', hostEpoch: origin.hostEpoch, expiresAt: origin.activeUntil }
        state.sceneMemoryOperations = operations
        return deepFreeze(cloneJson(memories[sceneId].value))
      })
    },
    async revoke(origin) {
      assertOriginTuple(origin, origin?.sceneId)
      return await stateStore.transact(state => {
        const operations = isRecord(state.sceneMemoryOperations) ? state.sceneMemoryOperations : {}
        const current = operations[origin.operationId]
        if (!current || current.hostEpoch !== origin.hostEpoch) throw new SceneMemoryOriginError('operation_not_registered')
        const revokedAt = now()
        operations[origin.operationId] = { status: 'revoked', hostEpoch: origin.hostEpoch, revokedAt, expiresAt: revokedAt + operationStatusTtlMs }
        state.sceneMemoryOperations = operations
      }, { compareBeforeRename: true, readback: true })
    },
  })
}
