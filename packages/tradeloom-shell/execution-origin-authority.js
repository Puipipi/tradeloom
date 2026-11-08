import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { AsyncLocalStorage } from 'node:async_hooks'
import { getRoleBindingRevision, ROLE_IDS } from './state.js'
import { createSceneMemoryStore, SceneMemoryOriginError } from './scene-memory-store.js'

const PENDING_TTL_MS = 15_000
const ACTIVE_TTL_MS = 5 * 60_000
const TERMINAL_STATUS_TTL_MS = 5 * 60_000
const REQUEST_REPLAY_WINDOW_MS = 30_000
const MAX_REQUEST_REPLAY_RECORDS = 4096
const MAX_REQUEST_REPLAY_RESPONSE_BYTES = 8 * 1024 * 1024
const MAX_BODY_BYTES = 2 * 1024 * 1024
const ENDPOINT_SEGMENT_PATTERN = /^[A-Za-z0-9_$.-]+$/
const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const digest = bytes => createHash('sha256').update(bytes).digest('hex')
const freezeOrigin = value => Object.freeze({
  scope: 'role',
  sceneId: value.sceneId,
  panelId: value.panelId,
  roleId: value.roleId,
  sessionId: value.sessionId,
  workspaceId: value.workspaceId,
  workspacePath: value.workspacePath,
  agentPreset: value.agentPreset,
  bindingRevision: value.bindingRevision,
  operationId: value.operationId,
  hostEpoch: value.hostEpoch,
  method: value.method,
  rpcId: value.rpcId,
  bodyDigest: value.bodyDigest,
  peerId: value.peerId,
  peerPrincipal: value.peerPrincipal,
  activeUntil: value.activeUntil,
})

function assertIssuer(value) {
  if (!isRecord(value) || value.scope !== 'role'
    || typeof value.guestId !== 'number' || !Number.isSafeInteger(value.guestId)
    || typeof value.generation !== 'number' || !Number.isSafeInteger(value.generation) || value.generation < 0
    || typeof value.sceneId !== 'string' || !value.sceneId
    || typeof value.panelId !== 'string' || !value.panelId
    || !ROLE_IDS.includes(value.roleId)
    || typeof value.sessionId !== 'string' || !value.sessionId
    || typeof value.workspaceId !== 'string' || !value.workspaceId
    || typeof value.workspacePath !== 'string' || !value.workspacePath
    || typeof value.agentPreset !== 'string' || !value.agentPreset
    || typeof value.bindingRevision !== 'string' || !/^(?:0|[1-9][0-9]{0,63})$/.test(value.bindingRevision)) {
    throw new SceneMemoryOriginError('unowned_guest')
  }
}

function bodyBuffer(value) {
  if (Buffer.isBuffer(value)) return value
  if (value instanceof Uint8Array) return Buffer.from(value.buffer, value.byteOffset, value.byteLength)
  throw new SceneMemoryOriginError('invalid_request_body')
}

export function createExecutionOriginAuthority({ stateStore, isSessionLive, isSessionDurable, onBeforeCommitAttempt, now = Date.now, hostEpoch = randomUUID(), requestReplayWindowMs = REQUEST_REPLAY_WINDOW_MS } = {}) {
  if (!stateStore || typeof stateStore.transact !== 'function') throw new TypeError('execution origin requires the Host state store')
  if (typeof isSessionLive !== 'function' || typeof isSessionDurable !== 'function'
    || typeof now !== 'function' || typeof hostEpoch !== 'string' || !hostEpoch
    || !Number.isSafeInteger(requestReplayWindowMs) || requestReplayWindowMs < 1 || requestReplayWindowMs > REQUEST_REPLAY_WINDOW_MS) {
    throw new TypeError('execution origin requires Host lifecycle validation')
  }
  const pending = new Map()
  const consumedGrants = new Map()
  const requestReplayByKey = new Map()
  const requestReplayByOperation = new Map()
  let requestReplayResponseBytes = 0
  const active = new Map()
  const originWork = new Map()
  const activeToolExecutions = new WeakSet()
  const currentToolExecution = new AsyncLocalStorage()
  const currentRequestOrigin = new AsyncLocalStorage()
  const requestMode = new AsyncLocalStorage()
  const memory = createSceneMemoryStore({
    stateStore,
    isSessionLive,
    isSessionDurable,
    isOperationActive: origin => {
      const record = active.get(origin.operationId)
      return record?.status === 'active' && record.origin === origin
    },
    onBeforeCommitAttempt,
    now,
    operationStatusTtlMs: TERMINAL_STATUS_TTL_MS,
  })

  function sameOriginTuple(canonical, candidate) {
    if (!isRecord(candidate)) return false
    const canonicalKeys = Object.keys(canonical)
    const candidateKeys = Object.keys(candidate)
    return canonicalKeys.length === candidateKeys.length
      && canonicalKeys.every(key => Object.prototype.hasOwnProperty.call(candidate, key) && candidate[key] === canonical[key])
  }

  function requestReplayKey(grant, { routePath, endpoint, httpMethod, method, rpcId, peerId, peerPrincipal }) {
    return JSON.stringify([
      hostEpoch, grant.issuer.scope, grant.issuer.guestId, grant.issuer.generation,
      grant.issuer.sceneId, grant.issuer.panelId, grant.issuer.roleId, grant.issuer.sessionId,
      grant.issuer.workspaceId, grant.issuer.workspacePath, grant.issuer.agentPreset,
      grant.issuer.bindingRevision, routePath, endpoint, httpMethod, method, rpcId,
      grant.bodyDigest, peerId, peerPrincipal,
    ])
  }

  function pruneExpiredOperationMemory(current = now()) {
    for (const [operationId, record] of active) {
      if ((['terminal', 'revoked'].includes(record.status) && record.terminalExpiresAt <= current)
        || (!['terminal', 'revoked'].includes(record.status) && record.origin.activeUntil <= current)) {
        active.delete(operationId)
        originWork.delete(operationId)
      }
    }
  }

  function pruneRequestReplay() {
    const current = now()
    pruneExpiredOperationMemory(current)
    for (const [token, grant] of pending) if (grant.expiresAt <= current) pending.delete(token)
    for (const [key, entry] of requestReplayByKey) {
      if (entry.tombstoneUntil > current) continue
      requestReplayByKey.delete(key)
      requestReplayByOperation.delete(entry.origin.operationId)
      if (entry.responseBytes) requestReplayResponseBytes -= entry.responseBytes
      for (const [token, used] of consumedGrants) if (used.entry === entry) consumedGrants.delete(token)
    }
  }

  async function assertReplayCurrent(entry) {
    const origin = entry.origin
    if (entry.replayUntil <= now() || origin.activeUntil <= now()) throw new SceneMemoryOriginError('origin_replay_expired')
    await stateStore.transact(async state => {
      const binding = state.roles?.[origin.roleId]
      if (!binding || binding.sessionId !== origin.sessionId || binding.workspaceId !== origin.workspaceId
        || binding.workspacePath !== origin.workspacePath || binding.agentPreset !== origin.agentPreset
        || getRoleBindingRevision(state, origin.roleId) !== origin.bindingRevision) throw new SceneMemoryOriginError('stale_role_binding')
      if (!isSessionLive(origin) || !await isSessionDurable(origin)) throw new SceneMemoryOriginError('session_not_live')
    }, { readOnly: true })
  }

  function assertActive(origin) {
    pruneExpiredOperationMemory()
    if (!isRecord(origin) || typeof origin.operationId !== 'string') throw new SceneMemoryOriginError('missing_operation_origin')
    const record = active.get(origin.operationId)
    if (record?.status === 'terminal') throw new SceneMemoryOriginError('operation_terminal')
    if (record?.status === 'terminalizing') throw new SceneMemoryOriginError('operation_terminal_pending')
    if (!record || record.status !== 'active' || record.origin !== origin || record.origin.hostEpoch !== hostEpoch
      || record.origin.activeUntil <= now()) throw new SceneMemoryOriginError('operation_not_active')
    return record
  }

  function retainOriginWork(origin, { kind = 'request', owner } = {}) {
    const record = assertActive(origin)
    if (!['request', 'queue', 'child-setup'].includes(kind) || (kind === 'queue' && (!owner || typeof owner !== 'object'))) {
      throw new SceneMemoryOriginError('invalid_operation_work')
    }
    const workId = randomUUID()
    const work = originWork.get(record.origin.operationId) ?? new Map()
    work.set(workId, Object.freeze({ origin: record.origin, kind, ...(owner === undefined ? {} : { owner }) }))
    originWork.set(record.origin.operationId, work)
    return workId
  }

  function captureQueuedOrigin(origin, workId, owner) {
    const record = active.get(origin?.operationId)
    if (record?.status === 'terminal') throw new SceneMemoryOriginError('operation_terminal')
    if (record?.status === 'terminalizing') throw new SceneMemoryOriginError('operation_terminal_pending')
    if (!record || record.status !== 'active' || !sameOriginTuple(record.origin, origin)) throw new SceneMemoryOriginError('operation_not_active')
    const work = originWork.get(record.origin.operationId)?.get(workId)
    if (!work || work.origin !== record.origin || work.kind !== 'queue') throw new SceneMemoryOriginError('invalid_operation_work')
    if (work.owner !== owner) throw new SceneMemoryOriginError('operation_work_owner_mismatch')
    assertActive(record.origin)
    return record.origin
  }

  async function terminalizeOrigin(origin, reason) {
    const record = active.get(origin.operationId)
    if (record?.status === 'terminal') return false
    if (record?.status === 'terminalizing') {
      if (record.terminalPromise) return await record.terminalPromise
      if (record.terminalError) throw record.terminalError
      throw new SceneMemoryOriginError('operation_terminal_pending')
    }
    if (!record || record.origin !== origin || record.status !== 'active') throw new SceneMemoryOriginError('operation_not_active')
    const terminalAt = now()
    record.status = 'terminalizing'
    record.terminalPromise = stateStore.transact(state => {
      const operations = isRecord(state.sceneMemoryOperations) ? state.sceneMemoryOperations : {}
      const current = operations[origin.operationId]
      if (!current || current.hostEpoch !== hostEpoch) throw new SceneMemoryOriginError('operation_not_registered')
      if (current.status === 'terminal') return
      if (current.status !== 'active' || current.expiresAt !== origin.activeUntil) throw new SceneMemoryOriginError('operation_not_active')
      operations[origin.operationId] = {
        status: 'terminal', hostEpoch, terminalAt,
        expiresAt: terminalAt + TERMINAL_STATUS_TTL_MS,
        ...(typeof reason === 'string' && reason ? { terminalReason: reason.slice(0, 64) } : {}),
      }
      state.sceneMemoryOperations = operations
    }, { compareBeforeRename: true, readback: true }).then(() => {
      record.status = 'terminal'
      record.terminalExpiresAt = terminalAt + TERMINAL_STATUS_TTL_MS
      record.terminalError = undefined
      record.terminalPromise = undefined
      return true
    }, error => {
      if (error?.code === 'state_commit_unknown') {
        record.status = 'terminal'
        record.terminalExpiresAt = terminalAt + TERMINAL_STATUS_TTL_MS
        record.terminalError = undefined
        record.terminalPromise = undefined
      } else {
        record.status = 'terminalizing'
        record.terminalError = error
        record.terminalPromise = undefined
      }
      throw error
    })
    return await record.terminalPromise
  }

  async function releaseOriginWork(origin, workId, reason, owner) {
    if (typeof workId !== 'string' || !workId) throw new SceneMemoryOriginError('invalid_operation_work')
    pruneExpiredOperationMemory(now())
    const record = active.get(origin?.operationId)
    if (!record && typeof origin?.operationId === 'string' && Number.isFinite(origin?.activeUntil)
      && origin.activeUntil <= now() && !originWork.has(origin.operationId)) return false
    if (record?.status === 'terminal' || record?.status === 'terminalizing') return false
    if (!record || record.status !== 'active' || !sameOriginTuple(record.origin, origin)) throw new SceneMemoryOriginError('operation_not_active')
    const work = originWork.get(origin.operationId)
    const lease = work?.get(workId)
    if (!lease || lease.origin !== record.origin) throw new SceneMemoryOriginError('invalid_operation_work')
    if (lease.kind === 'queue' && lease.owner !== owner) throw new SceneMemoryOriginError('operation_work_owner_mismatch')
    if (lease.kind !== 'queue' && owner !== undefined) throw new SceneMemoryOriginError('operation_work_owner_mismatch')
    assertActive(record.origin)
    work.delete(workId)
    if (work.size > 0) return false
    originWork.delete(origin.operationId)
    return await terminalizeOrigin(record.origin, reason)
  }

  async function cancelOrigin(origin, workIds, owner, reason = 'cancelled') {
    const current = active.get(origin?.operationId)
    if (current?.status === 'terminal') return false
    if (!current || !sameOriginTuple(current.origin, origin)) throw new SceneMemoryOriginError('operation_not_active')
    const record = current
    if (!sameOriginTuple(record.origin, origin) || !Array.isArray(workIds) || workIds.length === 0
      || workIds.some(workId => typeof workId !== 'string' || !workId) || new Set(workIds).size !== workIds.length) {
      throw new SceneMemoryOriginError('invalid_operation_work')
    }
    const works = originWork.get(record.origin.operationId)
    let ownedWork = false
    for (const workId of workIds) {
      const lease = works?.get(workId)
      if (!lease || lease.origin !== record.origin) throw new SceneMemoryOriginError('invalid_operation_work')
      if (lease.kind !== 'queue' || lease.owner !== owner) throw new SceneMemoryOriginError('operation_work_owner_mismatch')
      ownedWork = true
    }
    if (!ownedWork) throw new SceneMemoryOriginError('invalid_operation_work')
    if (record.status === 'active') assertActive(record.origin)
    else if (record.status !== 'terminalizing') throw new SceneMemoryOriginError('operation_not_active')
    try { return await terminalizeOrigin(record.origin, reason) }
    finally { originWork.delete(record.origin.operationId) }
  }

  return Object.freeze({
    hostEpoch,
    async registerGrant({ issuer, bodyBytes, endpoint, httpMethod } = {}) {
      assertIssuer(issuer)
      const bytes = bodyBuffer(bodyBytes)
      if (bytes.byteLength === 0 || bytes.byteLength > MAX_BODY_BYTES
        || typeof endpoint !== 'string' || endpoint.split('/').some(segment => !segment || segment === '.' || segment === '..' || !ENDPOINT_SEGMENT_PATTERN.test(segment))
        || httpMethod !== 'POST') throw new SceneMemoryOriginError('invalid_origin_grant_request')
      const token = randomBytes(32).toString('base64url')
      const expiresAt = now() + PENDING_TTL_MS
      const grant = Object.freeze({
        token,
        issuer: Object.freeze({
          scope: 'role', guestId: issuer.guestId, generation: issuer.generation,
          sceneId: issuer.sceneId, panelId: issuer.panelId, roleId: issuer.roleId,
          sessionId: issuer.sessionId, workspaceId: issuer.workspaceId,
          workspacePath: issuer.workspacePath, agentPreset: issuer.agentPreset,
          bindingRevision: issuer.bindingRevision,
        }),
        endpoint,
        httpMethod,
        bodyDigest: digest(bytes),
        expiresAt,
      })
      await stateStore.transact(async state => {
        const binding = state.roles?.[issuer.roleId]
        if (!binding || binding.sessionId !== issuer.sessionId || binding.workspaceId !== issuer.workspaceId
          || binding.workspacePath !== issuer.workspacePath || binding.agentPreset !== issuer.agentPreset
          || getRoleBindingRevision(state, issuer.roleId) !== issuer.bindingRevision
          || !isSessionLive(issuer) || !await isSessionDurable(issuer)) {
          throw new SceneMemoryOriginError('stale_role_binding')
        }
      }, { readOnly: true })
      pending.set(token, grant)
      return Object.freeze({ token, expiresAt, hostEpoch })
    },

    async verifyRequest({ token, endpoint, routePath, httpMethod, method, rpcId, bodyBytes, bodyDigest, peerId, peerPrincipal } = {}) {
      if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(token)) throw new SceneMemoryOriginError('invalid_origin_proof')
      pruneRequestReplay()
      const usedGrant = consumedGrants.get(token)
      const grant = pending.get(token) ?? usedGrant?.grant
      if (!grant || (!usedGrant && grant.expiresAt <= now())) {
        pending.delete(token)
        throw new SceneMemoryOriginError('origin_proof_expired_or_reused')
      }
      const bytes = bodyBuffer(bodyBytes)
      const verifiedRoutePath = routePath ?? endpoint
      if (bytes.byteLength > MAX_BODY_BYTES || verifiedRoutePath !== grant.endpoint || httpMethod !== grant.httpMethod
        || typeof method !== 'string' || method !== endpoint
        || typeof rpcId !== 'string' || !rpcId || rpcId.length > 128
        || digest(bytes) !== grant.bodyDigest || bodyDigest !== grant.bodyDigest
        || typeof peerId !== 'string' || !peerId || peerPrincipal !== 'owner') throw new SceneMemoryOriginError('origin_proof_mismatch')
      const replayKey = requestReplayKey(grant, {
        routePath: verifiedRoutePath, endpoint, httpMethod, method, rpcId, peerId, peerPrincipal,
      })
      if (usedGrant) {
        if (usedGrant.key !== replayKey) throw new SceneMemoryOriginError('origin_proof_mismatch')
        await usedGrant.entry.readyPromise
        await assertReplayCurrent(usedGrant.entry)
        return usedGrant.entry.origin
      }
      const existingReplay = requestReplayByKey.get(replayKey)
      if (existingReplay) {
        pending.delete(token)
        throw new SceneMemoryOriginError('origin_replay_remint_rejected')
      }
      if (requestReplayByKey.size >= MAX_REQUEST_REPLAY_RECORDS) throw new SceneMemoryOriginError('origin_replay_capacity')
      pending.delete(token)
      const origin = freezeOrigin({
        ...grant.issuer,
        operationId: randomUUID(),
        hostEpoch,
        method,
        rpcId,
        bodyDigest: grant.bodyDigest,
        peerId,
        peerPrincipal,
        activeUntil: now() + ACTIVE_TTL_MS,
      })
      let readyResolve
      let readyReject
      const readyPromise = new Promise((resolveReady, rejectReady) => { readyResolve = resolveReady; readyReject = rejectReady })
      readyPromise.catch(() => {})
      const replayEntry = {
        key: replayKey,
        origin,
        replayUntil: now() + requestReplayWindowMs,
        tombstoneUntil: now() + TERMINAL_STATUS_TTL_MS,
        readyPromise,
        readyResolve,
        readyReject,
        claimed: false,
        response: undefined,
        responseBytes: 0,
        responseResolve: undefined,
        responsePromise: undefined,
      }
      replayEntry.responsePromise = new Promise(resolveResponse => { replayEntry.responseResolve = resolveResponse })
      replayEntry.responsePromise.catch(() => {})
      requestReplayByKey.set(replayKey, replayEntry)
      requestReplayByOperation.set(origin.operationId, replayEntry)
      consumedGrants.set(token, { grant, key: replayKey, entry: replayEntry })
      let preserveLegacyBytes = false
      let legacySnapshotDigest
      let legacySnapshotAlreadyBound = false
      const assertLiveBinding = async state => {
        const binding = state.roles?.[origin.roleId]
        if (!binding || binding.sessionId !== origin.sessionId || binding.workspaceId !== origin.workspaceId
          || binding.workspacePath !== origin.workspacePath || binding.agentPreset !== origin.agentPreset
          || getRoleBindingRevision(state, origin.roleId) !== origin.bindingRevision) {
          throw new SceneMemoryOriginError('stale_role_binding')
        }
        if (origin.activeUntil <= now() || !isSessionLive(origin) || !await isSessionDurable(origin)) throw new SceneMemoryOriginError('session_not_live')
        if (origin.activeUntil <= now() || !isSessionLive(origin)) throw new SceneMemoryOriginError('session_not_live')
      }
      try {
      await stateStore.transact(async state => {
        await assertLiveBinding(state)
        const operations = isRecord(state.sceneMemoryOperations) ? state.sceneMemoryOperations : {}
        for (const [id, operation] of Object.entries(operations)) {
          if (['active', 'terminal', 'revoked'].includes(operation?.status) && operation.expiresAt <= now()) delete operations[id]
        }
        operations[origin.operationId] = { status: 'active', hostEpoch, expiresAt: origin.activeUntil,
          ...(preserveLegacyBytes && legacySnapshotDigest ? { legacySnapshotDigest } : {}) }
        if (preserveLegacyBytes && legacySnapshotDigest && !state.sceneMemoryLegacyBackup) {
          state.sceneMemoryLegacyBackup = { version: 1, sha256: legacySnapshotDigest }
        }
        state.sceneMemoryOperations = operations
      }, {
        compareBeforeRename: true,
        readback: true,
        onSnapshot: ({ state, previousBytes }) => {
          preserveLegacyBytes = state.sceneMemoryMigration?.version !== 1
            && (Object.hasOwn(state, 'sceneMemory') || Object.hasOwn(state, 'sceneMemoryLineage'))
          const legacyBackup = state.sceneMemoryLegacyBackup
          if (legacyBackup !== undefined && (legacyBackup?.version !== 1 || typeof legacyBackup.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(legacyBackup.sha256))) {
            throw new SceneMemoryOriginError('legacy_backup_mismatch')
          }
          legacySnapshotAlreadyBound = legacyBackup !== undefined
          legacySnapshotDigest = preserveLegacyBytes && previousBytes
            ? (legacyBackup?.sha256 ?? digest(previousBytes))
            : undefined
        },
        beforeRename: async ({ previousBytes }) => {
          if (!preserveLegacyBytes || !previousBytes) return
          const name = `legacy-${legacySnapshotDigest}.json`
          if (legacySnapshotAlreadyBound) {
            await stateStore.verifyImmutableBackup(name, legacySnapshotDigest)
          } else {
            await stateStore.writeImmutableBackup(name, previousBytes)
          }
        },
        beforeCommitAttempt: async () => assertLiveBinding(await stateStore.read()),
        validateCommit: () => {
          if (origin.activeUntil <= now() || !isSessionLive(origin)) throw new SceneMemoryOriginError('session_not_live')
        },
      })
      } catch (error) {
        requestReplayByKey.delete(replayKey)
        requestReplayByOperation.delete(origin.operationId)
        consumedGrants.delete(token)
        replayEntry.readyReject(error)
        replayEntry.responseResolve({ kind: 'error', error })
        throw error
      }
      active.set(origin.operationId, { origin, status: 'active' })
      replayEntry.readyResolve()
      return origin
    },

    claimRequestReplay(origin) {
      const entry = requestReplayByOperation.get(origin?.operationId)
      if (!entry || entry.origin !== origin) throw new SceneMemoryOriginError('origin_replay_unknown')
      if (entry.replayUntil <= now()) throw new SceneMemoryOriginError('origin_replay_expired')
      if (!entry.claimed) {
        entry.claimed = true
        return Object.freeze({ kind: 'execute' })
      }
      if (entry.response !== undefined) {
        return entry.response.kind === 'cached'
          ? Object.freeze({ kind: 'replay', response: { ...entry.response.value, bodyBytes: Buffer.from(entry.response.value.bodyBytes) } })
          : Object.freeze({ kind: 'unavailable' })
      }
      const remaining = entry.replayUntil - now()
      if (remaining <= 0) throw new SceneMemoryOriginError('origin_replay_expired')
      let timer
      const expired = new Promise(resolveExpired => {
        timer = setTimeout(() => resolveExpired({ kind: 'expired' }), remaining)
      })
      const response = Promise.race([entry.responsePromise, expired]).finally(() => clearTimeout(timer))
      return Object.freeze({ kind: 'wait', response })
    },

    completeRequestReplay(origin, response) {
      const entry = requestReplayByOperation.get(origin?.operationId)
      if (!entry || entry.origin !== origin || !entry.claimed || entry.response !== undefined) throw new SceneMemoryOriginError('origin_replay_unknown')
      if (entry.replayUntil <= now()) {
        entry.response = { kind: 'unavailable' }
        entry.responseResolve({ kind: 'expired' })
        return false
      }
      const bytes = bodyBuffer(response?.bodyBytes)
      if (!Number.isInteger(response.status) || response.status < 100 || response.status > 599
        || !Array.isArray(response.headers) || bytes.byteLength > MAX_REQUEST_REPLAY_RESPONSE_BYTES) {
        entry.response = { kind: 'unavailable' }
        entry.responseResolve({ kind: 'unavailable' })
        return false
      }
      if (requestReplayResponseBytes + bytes.byteLength > MAX_REQUEST_REPLAY_RESPONSE_BYTES) {
        entry.response = { kind: 'unavailable' }
        entry.responseResolve({ kind: 'unavailable' })
        return false
      }
      const value = Object.freeze({
        status: response.status,
        statusText: typeof response.statusText === 'string' ? response.statusText : '',
        headers: Object.freeze(response.headers.map(([key, value]) => Object.freeze([String(key), String(value)]))),
        bodyBytes: Buffer.from(bytes),
      })
      entry.responseBytes = bytes.byteLength
      entry.response = { kind: 'cached', value }
      requestReplayResponseBytes += entry.responseBytes
      entry.responseResolve({ kind: 'cached', response: { ...value, bodyBytes: Buffer.from(value.bodyBytes) } })
      return true
    },

    captureAtEnqueue(origin) {
      if (origin === undefined) {
        const request = currentRequestOrigin.getStore()
        if (request === undefined) return undefined
        if (request.active !== true) throw new SceneMemoryOriginError('request_origin_expired')
        origin = request.origin
      }
      if (!origin) return undefined
      const record = assertActive(origin)
      return record.origin
    },

    withVerifiedRequestOrigin(origin, callback) {
      if (typeof callback !== 'function') throw new TypeError('verified request handler is required')
      const record = assertActive(origin)
      const mode = { kind: 'verified', active: true }
      const request = { origin: record.origin, active: true }
      const requestWorkId = retainOriginWork(record.origin)
      return requestMode.run(mode, () => currentRequestOrigin.run(request, async () => {
        try { return await callback() }
        finally {
          request.active = false
          mode.active = false
          await releaseOriginWork(record.origin, requestWorkId, 'request-handler-ended')
        }
      }))
    },

    withProoflessRequestOrigin(callback) {
      if (typeof callback !== 'function') throw new TypeError('proofless request handler is required')
      const mode = { kind: 'proofless', active: true }
      return requestMode.run(mode, async () => {
        try { return await callback() }
        finally { mode.active = false }
      })
    },

    isProoflessExternalRequest() {
      const mode = requestMode.getStore()
      return mode?.kind === 'proofless' && mode.active === true
    },

    runDetachedDriver(callback) {
      if (typeof callback !== 'function') throw new TypeError('AgentLoop driver callback is required')
      return requestMode.run({ kind: 'driver', active: true }, () => currentRequestOrigin.run(undefined, () => currentToolExecution.run(undefined, callback)))
    },

    currentRequestOrigin() {
      const request = currentRequestOrigin.getStore()
      if (request === undefined || request.active !== true) return undefined
      return assertActive(request.origin).origin
    },

    retainOriginWork,
    captureQueuedOrigin,
    releaseOriginWork,
    cancelOrigin,

    currentToolExecution() {
      const exec = currentToolExecution.getStore()
      return exec !== undefined && activeToolExecutions.has(exec) ? exec : undefined
    },

    inheritFromParentExecution(parentExec) {
      parentExec ??= currentToolExecution.getStore()
      if (!isRecord(parentExec) || !isRecord(parentExec.agent) || typeof parentExec.agent.id !== 'string'
        || !isRecord(parentExec.agent.session) || parentExec.agent.session.id !== parentExec.agent.id
        || typeof parentExec.token !== 'symbol'
        || !isRecord(parentExec.operationOrigin) || !activeToolExecutions.has(parentExec)) {
        throw new SceneMemoryOriginError('active_parent_execution_required')
      }
      return assertActive(parentExec.operationOrigin).origin
    },

    async runToolExecution(exec, callback) {
      if (typeof callback !== 'function') throw new TypeError('tool execution callback is required')
      if (!exec?.operationOrigin) return await callback(exec)
      if (typeof exec.operationOriginWorkId !== 'string') throw new SceneMemoryOriginError('invalid_operation_work')
      const canonicalOrigin = captureQueuedOrigin(exec.operationOrigin, exec.operationOriginWorkId, exec.agent)
      const verifiedExec = { ...exec, operationOrigin: canonicalOrigin }
      activeToolExecutions.add(verifiedExec)
      try { return await currentToolExecution.run(verifiedExec, () => callback(verifiedExec)) }
      finally { activeToolExecutions.delete(verifiedExec) }
    },

    async transactSceneMemory(origin, action, sceneId, value) {
      const record = assertActive(origin)
      if (action === 'read') return await memory.read(record.origin, sceneId)
      if (action === 'write') return await memory.write(record.origin, sceneId, value)
      throw new SceneMemoryOriginError('invalid_scene_memory_action')
    },

    async revoke(origin) {
      const record = assertActive(origin)
      record.status = 'revoking'
      try {
        await memory.revoke(record.origin)
        record.status = 'revoked'
        record.terminalExpiresAt = now() + TERMINAL_STATUS_TTL_MS
      } catch (error) {
        if (error?.code === 'state_commit_unknown') {
          record.status = 'revoked'
          record.terminalExpiresAt = now() + TERMINAL_STATUS_TTL_MS
        } else record.status = 'active'
        throw error
      }
    },

    dispose() {
      pending.clear()
      active.clear()
      originWork.clear()
    },
  })
}

export { SceneMemoryOriginError }
