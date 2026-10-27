import { requestBusinessJson, trustedBusinessAuthority } from './business-tools.js'
import { isIPv4 } from 'node:net'

const PATH = '/api/canvas-workflow-runs'
const MAX_SNAPSHOT_BYTES = 2 * 1024 * 1024
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const WORKFLOW_ID = /^[a-z0-9][a-z0-9_-]{0,47}$/
const ERRORS = new Set(['run_not_found', 'revision_conflict', 'active_run_or_revision_conflict',
  'native_bridge_required', 'invalid_snapshot', 'snapshot_too_large'])

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
  async function call(method, query = '', body) {
    const nativeBridgeKey = options.nativeBridgeKey ?? process.env.TRADELOOM_NATIVE_BRIDGE_KEY
    if (!/^[a-f0-9]{64}$/.test(nativeBridgeKey ?? '')) throw new WorkflowRunPersistenceError('native_bridge_unavailable')
    let trusted
    try { trusted = pairedHost === undefined ? trustedBusinessAuthority(options.webServer) : pairedBusinessAuthority(options.webServer, pairedHost) }
    catch { throw new WorkflowRunPersistenceError('trusted_business_authority_unavailable') }
    let response
    try {
      response = await requestBusinessJson({
        path: PATH + query, method, body, authority: trusted, nativeBridgeKey,
        ...(options.port === undefined ? {} : { port: options.port }),
        ...(options.request === undefined ? {} : { request: options.request }),
        maxResponseBytes: MAX_SNAPSHOT_BYTES,
      })
    } catch { throw new WorkflowRunPersistenceError('run_store_unavailable') }
    let value
    try { value = JSON.parse(response.raw) }
    catch { throw new WorkflowRunPersistenceError('invalid_run_store_response', response.status) }
    if (response.status < 200 || response.status >= 300) {
      throw new WorkflowRunPersistenceError(ERRORS.has(value?.error) ? value.error : 'run_store_unavailable', response.status)
    }
    return value
  }

  return {
    async get(id) {
      validId(id)
      let value
      try { value = await call('GET', `?id=${id}`) }
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
      const value = await call('GET', query.size ? `?${query}` : '')
      if (!Array.isArray(value?.runs)) throw new WorkflowRunPersistenceError('invalid_run_store_response')
      return value.runs
    },
    async save(snapshot, expectedRevision) {
      validId(snapshot?.id)
      if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0 || snapshot.revision !== expectedRevision + 1) {
        throw new WorkflowRunPersistenceError('invalid_revision')
      }
      if (Buffer.byteLength(JSON.stringify({ snapshot, expectedRevision }), 'utf8') > MAX_SNAPSHOT_BYTES) {
        throw new WorkflowRunPersistenceError('snapshot_too_large')
      }
      const value = await call('POST', '', { snapshot, expectedRevision })
      if (value?.snapshot?.id !== snapshot.id || value.snapshot.revision !== snapshot.revision) {
        throw new WorkflowRunPersistenceError('invalid_run_store_response')
      }
      return value.snapshot
    },
  }
}
