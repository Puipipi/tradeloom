import { requestBusinessJson, trustedBusinessAuthority } from './business-tools.js'
import { isIPv4 } from 'node:net'

const PATH = '/api/canvas-workflow-runs'
const MAX_SNAPSHOT_BYTES = 2 * 1024 * 1024
const MAX_OWNERSHIP_BODY_BYTES = MAX_SNAPSHOT_BYTES + 16 * 1024
const OWNER_PROTOCOL = 'canvas-run-owner/v1'
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const WORKFLOW_ID = /^[a-z0-9][a-z0-9_-]{0,47}$/
const ERRORS = new Set(['run_not_found', 'revision_conflict', 'active_run_or_revision_conflict',
  'native_bridge_required', 'invalid_snapshot', 'snapshot_too_large', 'invalid_owner_request',
  'invalid_owner_action', 'invalid_owner_proof', 'invalid_owner_namespace', 'invalid_owner_epoch',
  'invalid_recovery_cursor', 'owner_namespace_unavailable', 'owner_fenced', 'owner_conflict',
  'legacy_unmanaged', 'recovery_response_too_large', 'invalid_revision', 'active_workflow_conflict'])

export class WorkflowRunPersistenceError extends Error {
  constructor(code, status = 0) {
    super(`Workflow run persistence: ${code}`)
    this.name = 'WorkflowRunPersistenceError'
    this.code = code
    this.status = status
  }
}

function validId(id) {
  if (typeof id !== 'string' || !UUID.test(id)) throw new WorkflowRunPersistenceError('invalid_run_id')
}

function validToken(token) {
  if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(token)) {
    throw new WorkflowRunPersistenceError('invalid_owner_proof')
  }
  const decoded = Buffer.from(token, 'base64url')
  if (decoded.byteLength !== 32 || decoded.toString('base64url') !== token) {
    throw new WorkflowRunPersistenceError('invalid_owner_proof')
  }
}

function validOwnerEpoch(epoch) {
  if (typeof epoch !== 'string' || !/^[1-9][0-9]{0,18}$/.test(epoch)) {
    throw new WorkflowRunPersistenceError('invalid_owner_epoch')
  }
  if (BigInt(epoch) > 9223372036854775807n) throw new WorkflowRunPersistenceError('invalid_owner_epoch')
}

function requireUuid(value, code) {
  if (typeof value !== 'string' || !UUID.test(value)) throw new WorkflowRunPersistenceError(code)
}

function validateOwnerResponse(value, { namespaceId, runId, ownerId, requireEpoch = false } = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || value.protocol !== OWNER_PROTOCOL || Object.hasOwn(value, 'ownerToken')
    || Object.hasOwn(value, 'ownerTokenHash')) {
    throw new WorkflowRunPersistenceError('invalid_run_store_response')
  }
  if (namespaceId !== undefined && value.namespaceId !== namespaceId) throw new WorkflowRunPersistenceError('invalid_run_store_response')
  if (runId !== undefined && value.runId !== runId) throw new WorkflowRunPersistenceError('invalid_run_store_response')
  if (ownerId !== undefined && value.ownerId !== ownerId) throw new WorkflowRunPersistenceError('invalid_run_store_response')
  if (requireEpoch || value.ownerEpoch !== undefined) validOwnerEpoch(value.ownerEpoch)
  if (value.snapshot !== undefined && (value.snapshot?.id !== runId
    || !Number.isSafeInteger(value.snapshot.revision) || value.snapshot.revision < 1)) {
    throw new WorkflowRunPersistenceError('invalid_run_store_response')
  }
  return value
}

// Only trusted Host composition may supply this pairing; tool/HTTP input never reaches it.
export function pairedBusinessAuthority(webServer, pairedHost) {
  const { host, port } = pairedHost
  const octets = typeof host === 'string' && isIPv4(host) ? host.split('.').map(Number) : []
  const permittedHost = host === '127.0.0.1' || octets[0] === 10
    || (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31)
    || (octets[0] === 192 && octets[1] === 168)
  if (!permittedHost || !Number.isInteger(port) || port < 1 || port > 65535
    || webServer?.protocol !== 'http:' || webServer.host !== host || webServer.port !== port) {
    throw new Error('TradeLoom paired Host authority is unavailable')
  }
  const origin = webServer.getOrigin?.()
  const canonicalOrigin = new URL(`http://${host}:${port}`).origin
  const parsed = typeof origin === 'string' ? new URL(origin) : undefined
  if (!parsed || origin !== canonicalOrigin || parsed.origin !== origin || parsed.pathname !== '/'
    || parsed.search || parsed.hash || parsed.username || parsed.password) {
    throw new Error('TradeLoom paired Host origin is unavailable')
  }
  return { host, origin: canonicalOrigin, hostHeader: `${host}:${port}` }
}

/** Paired Host-to-Django storage. No browser cookie, local fallback, or history eviction. */
export function createPostgresWorkflowRunStore(options) {
  const pairedHost = options.pairedHost === undefined ? undefined : { ...options.pairedHost }
  async function call(method, query = '', body, { signal, maxResponseBytes = MAX_SNAPSHOT_BYTES } = {}) {
    const nativeBridgeKey = options.nativeBridgeKey ?? process.env.TRADELOOM_NATIVE_BRIDGE_KEY
    if (!/^[a-f0-9]{64}$/.test(nativeBridgeKey ?? '')) throw new WorkflowRunPersistenceError('native_bridge_unavailable')
    let trusted
    try { trusted = pairedHost === undefined ? trustedBusinessAuthority(options.webServer) : pairedBusinessAuthority(options.webServer, pairedHost) }
    catch { throw new WorkflowRunPersistenceError('trusted_business_authority_unavailable') }
    let response
    try {
      response = await requestBusinessJson({
        path: PATH + query, method, body, authority: trusted, nativeBridgeKey,
        signal,
        ...(options.port === undefined ? {} : { port: options.port }),
        ...(options.request === undefined ? {} : { request: options.request }),
        maxResponseBytes,
      })
    } catch { throw new WorkflowRunPersistenceError('run_store_unavailable') }
    let value
    try { value = JSON.parse(response.raw) }
    catch { throw new WorkflowRunPersistenceError('invalid_run_store_response', response.status) }
    if (response.status < 200 || response.status >= 300) {
      const code = value?.error_code ?? value?.error
      throw new WorkflowRunPersistenceError(ERRORS.has(code) ? code : 'run_store_unavailable', response.status)
    }
    return value
  }

  return {
    async get(id) {
      validId(id)
      let value
      try { value = await call('GET', `?id=${id}`, undefined, { maxResponseBytes: MAX_OWNERSHIP_BODY_BYTES }) }
      catch (error) {
        if (error.code === 'run_not_found' && error.status === 404) return null
        throw error
      }
      if (value?.snapshot?.id !== id) throw new WorkflowRunPersistenceError('invalid_run_store_response')
      return value.snapshot
    },
    async list({ workflowId, activeOnly = false } = {}) {
      if (workflowId !== undefined && (typeof workflowId !== 'string' || !WORKFLOW_ID.test(workflowId))) {
        throw new WorkflowRunPersistenceError('invalid_workflow_id')
      }
      const query = new URLSearchParams()
      if (workflowId !== undefined) query.set('workflow', workflowId)
      if (activeOnly) query.set('active', '1')
      const value = await call('GET', query.size ? `?${query}` : '', undefined,
        { maxResponseBytes: MAX_OWNERSHIP_BODY_BYTES })
      if (!Array.isArray(value?.runs)) throw new WorkflowRunPersistenceError('invalid_run_store_response')
      return value.runs
    },
    async save(snapshot, expectedRevision, capability, { signal } = {}) {
      if (!capability) throw new WorkflowRunPersistenceError('owner_capability_required')
      return this.saveOwned(capability, snapshot, expectedRevision, { signal })
    },
    async getOwnershipNamespace({ signal } = {}) {
      const value = await call('GET', '?action=owner_namespace', undefined,
        { signal, maxResponseBytes: MAX_OWNERSHIP_BODY_BYTES })
      if (value?.protocol !== OWNER_PROTOCOL || !UUID.test(value.namespaceId ?? '')
        || !Number.isSafeInteger(value.leaseTtlMs) || value.leaseTtlMs < 1
        || !Number.isSafeInteger(value.renewAfterMs) || value.renewAfterMs < 1
        || value.maxDomainEnvelopeBytes !== MAX_SNAPSHOT_BYTES
        || value.maxResponseBytes !== MAX_OWNERSHIP_BODY_BYTES
        || typeof value.recoveryCursor !== 'string' || value.recoveryCursor.length === 0) {
        throw new WorkflowRunPersistenceError('invalid_run_store_response')
      }
      return {
        namespaceId: value.namespaceId,
        leaseTtlMs: value.leaseTtlMs,
        renewAfterMs: value.renewAfterMs,
        maxDomainEnvelopeBytes: value.maxDomainEnvelopeBytes,
        maxResponseBytes: value.maxResponseBytes,
        recoveryCursor: value.recoveryCursor,
      }
    },
    async getOwnershipState(runId, namespaceId, { signal } = {}) {
      validId(runId)
      requireUuid(namespaceId, 'invalid_owner_namespace')
      const query = new URLSearchParams({ action: 'owner_run', id: runId, namespaceId })
      const value = await call('GET', `?${query}`, undefined,
        { signal, maxResponseBytes: MAX_OWNERSHIP_BODY_BYTES })
      const result = validateOwnerResponse(value, { namespaceId, runId })
      if (typeof result.managed !== 'boolean' || !Number.isSafeInteger(result.revision)
        || !['running', 'waiting', 'done', 'failed', 'cancelled', 'interrupted'].includes(result.status)) {
        throw new WorkflowRunPersistenceError('invalid_run_store_response')
      }
      if (result.managed) {
        requireUuid(result.ownerId, 'invalid_run_store_response')
        validOwnerEpoch(result.ownerEpoch)
        if (typeof result.active !== 'boolean' || typeof result.released !== 'boolean'
          || typeof result.fenced !== 'boolean') throw new WorkflowRunPersistenceError('invalid_run_store_response')
      }
      return result.managed
        ? { managed: true, namespaceId, runId, ownerId: result.ownerId, ownerEpoch: result.ownerEpoch,
          leaseExpiresAt: result.leaseExpiresAt, active: result.active, released: result.released,
          fenced: result.fenced, revision: result.revision, status: result.status }
        : { managed: false, namespaceId, runId, revision: result.revision, status: result.status }
    },
    async createOwned({ namespaceId, runId, ownerId, ownerToken, snapshot, signal }) {
      requireUuid(namespaceId, 'invalid_owner_namespace')
      validId(runId)
      requireUuid(ownerId, 'invalid_owner_proof')
      validToken(ownerToken)
      if (snapshot?.id !== runId || snapshot?.revision !== 1) throw new WorkflowRunPersistenceError('invalid_snapshot')
      const body = { protocol: OWNER_PROTOCOL, action: 'create_owned', namespaceId, runId, ownerId, ownerToken, snapshot }
      if (Buffer.byteLength(JSON.stringify(body), 'utf8') > MAX_OWNERSHIP_BODY_BYTES) {
        throw new WorkflowRunPersistenceError('recovery_response_too_large', 413)
      }
      const value = await call('POST', '', body, { signal, maxResponseBytes: MAX_OWNERSHIP_BODY_BYTES })
      const result = validateOwnerResponse(value, { namespaceId, runId, ownerId, requireEpoch: true })
      if (!result.snapshot || typeof result.alreadyAdvanced !== 'boolean' || typeof result.leaseExpiresAt !== 'string') {
        throw new WorkflowRunPersistenceError('invalid_run_store_response')
      }
      if (result.ownerEpoch !== '1' || (!result.alreadyAdvanced && (result.snapshot.revision !== 1
        || JSON.stringify(result.snapshot) !== JSON.stringify(snapshot)))) {
        throw new WorkflowRunPersistenceError('invalid_run_store_response')
      }
      return { namespaceId, runId, ownerId, ownerEpoch: result.ownerEpoch,
        leaseExpiresAt: result.leaseExpiresAt, snapshot: result.snapshot, alreadyAdvanced: result.alreadyAdvanced }
    },
    async saveOwned(capability, snapshot, expectedRevision, { signal } = {}) {
      validId(snapshot?.id)
      if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0 || snapshot.revision !== expectedRevision + 1) {
        throw new WorkflowRunPersistenceError('invalid_revision')
      }
      const proof = validateCapability(capability)
      if (snapshot.id !== proof.runId) throw new WorkflowRunPersistenceError('invalid_snapshot')
      if (Buffer.byteLength(JSON.stringify({ snapshot, expectedRevision }), 'utf8') > MAX_SNAPSHOT_BYTES) {
        throw new WorkflowRunPersistenceError('snapshot_too_large')
      }
      const body = { protocol: OWNER_PROTOCOL, action: 'save_owned', ...proof, expectedRevision, snapshot }
      if (Buffer.byteLength(JSON.stringify(body), 'utf8') > MAX_OWNERSHIP_BODY_BYTES) {
        throw new WorkflowRunPersistenceError('recovery_response_too_large', 413)
      }
      const value = await call('POST', '', body, { signal, maxResponseBytes: MAX_OWNERSHIP_BODY_BYTES })
      const result = validateOwnerResponse(value, { namespaceId: proof.namespaceId, runId: proof.runId,
        ownerId: proof.ownerId, requireEpoch: true })
      if (result.ownerEpoch !== proof.ownerEpoch || result.snapshot?.id !== snapshot.id
        || result.snapshot.revision !== snapshot.revision) {
        throw new WorkflowRunPersistenceError('invalid_run_store_response')
      }
      return result.snapshot
    },
    async renewOwned(capability, { signal } = {}) {
      const proof = validateCapability(capability)
      const value = await call('POST', '', { protocol: OWNER_PROTOCOL, action: 'renew_owned', ...proof },
        { signal, maxResponseBytes: MAX_OWNERSHIP_BODY_BYTES })
      const result = validateOwnerResponse(value, { namespaceId: proof.namespaceId, runId: proof.runId,
        ownerId: proof.ownerId, requireEpoch: true })
      if (result.ownerEpoch !== proof.ownerEpoch || typeof result.leaseExpiresAt !== 'string') {
        throw new WorkflowRunPersistenceError('invalid_run_store_response')
      }
      return { ownerEpoch: result.ownerEpoch, leaseExpiresAt: result.leaseExpiresAt }
    },
    async releaseOwned(capability, { signal } = {}) {
      const proof = validateCapability(capability)
      const value = await call('POST', '', { protocol: OWNER_PROTOCOL, action: 'release_owned', ...proof },
        { signal, maxResponseBytes: MAX_OWNERSHIP_BODY_BYTES })
      const result = validateOwnerResponse(value, { requireEpoch: true })
      if (result.released !== true || result.ownerEpoch !== proof.ownerEpoch) {
        throw new WorkflowRunPersistenceError('invalid_run_store_response')
      }
      return { released: true, ownerEpoch: result.ownerEpoch }
    },
    async claimResumed({ namespaceId, runId, expectedRevision, expectedOwnerEpoch, ownerId, ownerToken, signal }) {
      requireUuid(namespaceId, 'invalid_owner_namespace')
      validId(runId)
      requireUuid(ownerId, 'invalid_owner_proof')
      validOwnerEpoch(expectedOwnerEpoch)
      validToken(ownerToken)
      if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) throw new WorkflowRunPersistenceError('invalid_revision')
      const body = { protocol: OWNER_PROTOCOL, action: 'claim_resumed', namespaceId, runId,
        expectedRevision, expectedOwnerEpoch, ownerId, ownerToken }
      const value = await call('POST', '', body, { signal, maxResponseBytes: MAX_OWNERSHIP_BODY_BYTES })
      const result = validateOwnerResponse(value, { namespaceId, runId, ownerId, requireEpoch: true })
      if (!result.snapshot || typeof result.leaseExpiresAt !== 'string') throw new WorkflowRunPersistenceError('invalid_run_store_response')
      return { namespaceId, runId, ownerId, ownerEpoch: result.ownerEpoch,
        leaseExpiresAt: result.leaseExpiresAt, snapshot: result.snapshot }
    },
    async recoverExpired(namespaceId, cursor, { signal } = {}) {
      requireUuid(namespaceId, 'invalid_owner_namespace')
      if (typeof cursor !== 'string' || cursor.length === 0) throw new WorkflowRunPersistenceError('invalid_recovery_cursor')
      const body = { protocol: OWNER_PROTOCOL, action: 'recover_expired', namespaceId, cursor }
      const value = await call('POST', '', body, { signal, maxResponseBytes: MAX_OWNERSHIP_BODY_BYTES })
      if (value?.protocol !== OWNER_PROTOCOL || value.namespaceId !== namespaceId
        || !(value.nextCursor === null || typeof value.nextCursor === 'string')
        || typeof value.complete !== 'boolean') throw new WorkflowRunPersistenceError('invalid_run_store_response')
      if (value.item !== null && (!value.item || !['recovered', 'unmanaged'].includes(value.item.kind))) {
        throw new WorkflowRunPersistenceError('invalid_run_store_response')
      }
      if (value.item?.kind === 'recovered') {
        validId(value.item.snapshot?.id)
        validOwnerEpoch(value.item.previousOwnerEpoch)
        validOwnerEpoch(value.item.newOwnerEpoch)
      }
      return { namespaceId, item: value.item, nextCursor: value.nextCursor, complete: value.complete }
    },
  }
}

function validateCapability(capability) {
  if (!capability || typeof capability !== 'object') throw new WorkflowRunPersistenceError('owner_capability_required')
  requireUuid(capability.namespaceId, 'invalid_owner_namespace')
  validId(capability.runId)
  requireUuid(capability.ownerId, 'invalid_owner_proof')
  validOwnerEpoch(capability.ownerEpoch)
  validToken(capability.ownerToken)
  return {
    namespaceId: capability.namespaceId,
    runId: capability.runId,
    ownerId: capability.ownerId,
    ownerEpoch: capability.ownerEpoch,
    ownerToken: capability.ownerToken,
  }
}
