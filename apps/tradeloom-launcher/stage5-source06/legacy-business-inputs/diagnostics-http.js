import { randomUUID } from 'node:crypto'
import { trustedBusinessAuthority, requestBusinessJson } from './business-tools.js'
import { createDiagnosticsStore } from './diagnostics-store.js'

export const DIAGNOSTICS_ROUTE = '/tradeloom/diagnostics'
const HEALTH_PATH = '/api/health'
const SOURCE_TIMEOUT_MS = 15_000
const MAX_HEALTH_BYTES = 128 * 1024
const MAX_BODY_BYTES = 4096
const CHECK_KEYS = Object.freeze(['database', 'intent_config', 'runtime', 'external_provider', 'agentarts'])
const STATUSES = new Set(['ok', 'degraded', 'not_checked', 'not_configured', 'unknown'])
const SAFE_CODES = new Set(['invalid', 'unavailable'])
const ORIGINAL = Symbol.for('cordis.original')

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const exact = (value, keys) => object(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key))
const fixedSourceKey = key => `workbench.local:${key}`

function serviceIdentity(service) {
  try {
    const original = service?.[ORIGINAL]
    return original === undefined ? service : original
  } catch {
    return service
  }
}

function json(res, status, value) {
  if (!res || res.destroyed || res.writableEnded) return false
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(JSON.stringify(value))
  return true
}

function errorResponse(res, status, code) {
  return json(res, status, { ok: false, error: { code } })
}

function rejectionStatus(ctx, req) {
  try {
    if (typeof ctx.connection?.requestRejection !== 'function') return 403
    const rejection = ctx.connection.requestRejection(req)
    if (rejection === undefined) return null
    return Number.isInteger(rejection) && rejection >= 400 && rejection <= 599 ? rejection : 403
  } catch {
    return 403
  }
}

function routeUrlIsFixed(req) {
  if (typeof req.url !== 'string') return false
  try {
    const parsed = new URL(req.url, 'http://localhost')
    return parsed.origin === 'http://localhost' && parsed.pathname === DIAGNOSTICS_ROUTE && !parsed.search && !parsed.hash
  } catch {
    return false
  }
}

async function readBody(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.byteLength
    if (size > MAX_BODY_BYTES) {
      req.resume?.()
      return null
    }
    chunks.push(chunk)
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { return null }
}

function requestLifetime(req, res, activeRequests) {
  const controller = new AbortController()
  const onAbort = () => controller.abort()
  const onClose = () => { if (!res.writableEnded) controller.abort() }
  req.once?.('aborted', onAbort)
  res.once?.('close', onClose)
  if (req.aborted) controller.abort()
  activeRequests.add(controller)
  return {
    signal: controller.signal,
    dispose() {
      req.removeListener?.('aborted', onAbort)
      res.removeListener?.('close', onClose)
      activeRequests.delete(controller)
    },
  }
}

function toIso(value) {
  const date = value instanceof Date ? value : new Date(value)
  if (!Number.isFinite(date.getTime())) throw new Error('diagnostics_clock_invalid')
  return date.toISOString()
}

function safeSourceStatus(value) {
  return typeof value === 'string' && STATUSES.has(value) ? value : null
}

function safeSourceCode(value, status) {
  return status === 'degraded' && SAFE_CODES.has(value) ? value : null
}

function safeEvidence(key, row, status) {
  if (!['ok', 'degraded'].includes(status)) return null
  const allowedScope = key === 'database' ? 'SELECT 1'
    : key === 'runtime' ? 'local_health_check_only'
      : null
  const scope = allowedScope && row?.scope === allowedScope ? allowedScope : null
  return { scope, status }
}

function checkedSnapshot(status, raw, ids, times) {
  if (![200, 503].includes(status) || typeof raw !== 'string') return null
  let payload
  try { payload = JSON.parse(raw) } catch { return null }
  if (!object(payload) || !object(payload.dependencies)
    || Object.keys(payload.dependencies).length !== CHECK_KEYS.length
    || CHECK_KEYS.some(key => !Object.hasOwn(payload.dependencies, key)
      || !object(payload.dependencies[key])
      || safeSourceStatus(payload.dependencies[key].status) === null)
    || (status === 200 && payload.status !== 'ok')
    || (status === 503 && payload.status !== 'degraded')) return null

  const checks = CHECK_KEYS.map(checkKey => {
    const row = payload.dependencies[checkKey]
    const sourceStatus = object(row) ? safeSourceStatus(row.status) : 'unknown'
    return {
      checkKey,
      sourceKey: fixedSourceKey(checkKey),
      status: sourceStatus,
      code: object(row) ? safeSourceCode(row.code, sourceStatus) : null,
      evidence: object(row) ? safeEvidence(checkKey, row, sourceStatus) : null,
      checkedAt: null,
    }
  })
  const hasDegraded = checks.some(check => check.status === 'degraded')
  if ((status === 200 && hasDegraded) || (status === 503 && !hasDegraded)) return null
  return {
    checkId: ids.checkId,
    sourceScope: 'workbench.local',
    checked: true,
    status: payload.status,
    requestedAt: times.requestedAt,
    startedAt: times.startedAt,
    receivedAt: times.receivedAt,
    sourceHttpStatus: status,
    checks,
  }
}

function emptyReadError(code) {
  return {
    ok: true,
    snapshotState: 'read_error',
    snapshot: null,
    todosState: 'read_error',
    todos: [],
    snapshotReadErrorCode: code,
    todosReadErrorCode: code,
  }
}

export function createDiagnosticsHandler(ctx, dependencies = {}) {
  const storeFactory = dependencies.createDiagnosticsStore ?? createDiagnosticsStore
  const sendHealth = dependencies.requestBusinessJson ?? requestBusinessJson
  const authorityResolver = dependencies.authorityResolver ?? trustedBusinessAuthority
  const clock = dependencies.now ?? (() => new Date())
  const idFactory = dependencies.idFactory ?? randomUUID
  const timeoutMs = dependencies.timeoutMs ?? SOURCE_TIMEOUT_MS
  const initialConnection = serviceIdentity(ctx?.connection)
  const initialWebServer = serviceIdentity(ctx?.webServer)
  const activeRequests = new Set()
  let disposed = false
  let storePromise

  function isContextCurrent() {
    return !disposed && initialConnection !== undefined && initialConnection !== null
      && initialWebServer !== undefined && initialWebServer !== null
      && serviceIdentity(ctx?.connection) === initialConnection
      && serviceIdentity(ctx?.webServer) === initialWebServer
  }

  function currentFailure(req, res, signal) {
    if (signal?.aborted) return 'aborted'
    if (!isContextCurrent()) return 'host_unavailable'
    const rejection = rejectionStatus(ctx, req)
    if (rejection !== null) return `http_${rejection}`
    if (res.destroyed || res.writableEnded) return 'aborted'
    return null
  }

  function sendCurrentFailure(req, res, signal) {
    const failure = currentFailure(req, res, signal)
    if (failure === 'aborted') return false
    if (failure === 'host_unavailable') { errorResponse(res, 503, 'host_unavailable'); return false }
    if (failure?.startsWith('http_')) { errorResponse(res, Number(failure.slice(5)), 'forbidden'); return false }
    return true
  }

  async function getStore() {
    if (!storePromise) {
      storePromise = Promise.resolve().then(() => storeFactory(dependencies.storeOptions))
    }
    try { return await storePromise } catch (error) { storePromise = undefined; throw error }
  }

  async function handleGet(req, res, lifetime) {
    const { signal } = lifetime
    if (!sendCurrentFailure(req, res, signal)) return
    let value
    try {
      const store = await getStore()
      value = await store.read()
    } catch {
      if (!sendCurrentFailure(req, res, signal)) return
      json(res, 200, {
        ...emptyReadError('storage_unavailable'),
        observedAt: toIso(clock()),
      })
      return
    }
    if (!sendCurrentFailure(req, res, signal)) return
    const body = {
      ok: true,
      snapshotState: value.snapshotState,
      snapshot: value.snapshot,
      todosState: value.todosState,
      todos: value.todos,
      snapshotReadErrorCode: value.snapshotReadErrorCode,
      todosReadErrorCode: value.todosReadErrorCode,
      observedAt: toIso(clock()),
    }
    json(res, 200, body)
  }

  async function commitReadError(store, checkId, code, guard) {
    return await store.transact(document => {
      if (document.latestAttemptId !== checkId) return false
      document.snapshotState = 'read_error'
      document.snapshot = null
      document.snapshotReadErrorCode = code
      return true
    }, { beforeCommit: guard })
  }

  function sourceErrorBody(checkId, times, sourceHttpStatus) {
    return {
      ok: true,
      outcome: 'read_error',
      checkId,
      checked: false,
      snapshotState: 'read_error',
      snapshot: null,
      requestedAt: times.requestedAt,
      startedAt: times.startedAt,
      receivedAt: times.receivedAt,
      finishedAt: toIso(clock()),
      sourceHttpStatus,
      error: { code: 'source_read_error' },
    }
  }

  async function handleRecheck(req, res, lifetime) {
    const { signal } = lifetime
    if (!sendCurrentFailure(req, res, signal)) return
    const checkId = idFactory()
    const times = { requestedAt: toIso(clock()), startedAt: null, receivedAt: null }
    let store
    try {
      store = await getStore()
      const began = await store.transact(document => {
        document.latestAttemptId = checkId
        return true
      }, { beforeCommit: () => currentFailure(req, res, signal) === null })
      if (!began.committed) { sendCurrentFailure(req, res, signal); return }
    } catch {
      if (sendCurrentFailure(req, res, signal)) errorResponse(res, 503, 'storage_unavailable')
      return
    }
    if (!sendCurrentFailure(req, res, signal)) return

    times.startedAt = toIso(clock())
    let response
    try {
      const authority = authorityResolver(ctx.webServer)
      response = await sendHealth({
        path: HEALTH_PATH,
        method: 'GET',
        authority,
        signal,
        timeoutMs,
        maxResponseBytes: MAX_HEALTH_BYTES,
      })
      times.receivedAt = toIso(clock())
    } catch {
      if (signal.aborted) return
    }

    if (!sendCurrentFailure(req, res, signal)) return
    const sourceHttpStatus = Number.isInteger(response?.status) ? response.status : null
    const snapshot = checkedSnapshot(sourceHttpStatus, response?.raw, { checkId }, times)
    const guard = () => currentFailure(req, res, signal) === null
    if (!snapshot) {
      const body = sourceErrorBody(checkId, times, sourceHttpStatus)
      let outcome
      try { outcome = await commitReadError(store, checkId, 'source_read_error', guard) }
      catch {
        if (sendCurrentFailure(req, res, signal)) errorResponse(res, 503, 'storage_unavailable')
        return
      }
      if (!outcome.committed || outcome.value !== true) {
        if (sendCurrentFailure(req, res, signal)) errorResponse(res, 409, 'check_superseded')
        return
      }
      if (!sendCurrentFailure(req, res, signal)) return
      json(res, 200, body)
      return
    }

    let outcome
    try {
      outcome = await store.transact(document => {
        if (document.latestAttemptId !== checkId) return false
        document.snapshotState = 'available'
        document.snapshot = snapshot
        document.snapshotReadErrorCode = null
        if (snapshot.status === 'degraded') {
          for (const check of snapshot.checks) {
            if (check.status !== 'degraded' || !check.code) continue
            const todo = document.todos.find(item => item.sourceKey === check.sourceKey)
            if (!todo || todo.latestEvidence.checkId === snapshot.checkId) continue
            todo.latestEvidence = {
              checkId: snapshot.checkId,
              sourceKey: check.sourceKey,
              status: check.status,
              code: check.code,
              sourceHttpStatus: snapshot.sourceHttpStatus,
              requestedAt: snapshot.requestedAt,
              receivedAt: snapshot.receivedAt,
              sourceScope: snapshot.sourceScope,
              evidence: check.evidence,
            }
            todo.updatedAt = snapshot.receivedAt
          }
        }
        return true
      }, { beforeCommit: guard })
    } catch {
      if (sendCurrentFailure(req, res, signal)) errorResponse(res, 503, 'storage_unavailable')
      return
    }
    if (!outcome.committed || outcome.value !== true) {
      if (sendCurrentFailure(req, res, signal)) errorResponse(res, 409, 'check_superseded')
      return
    }
    if (!sendCurrentFailure(req, res, signal)) return
    json(res, 200, {
      ok: true,
      outcome: 'checked',
      checkId,
      checked: true,
      requestedAt: times.requestedAt,
      startedAt: times.startedAt,
      receivedAt: times.receivedAt,
      finishedAt: toIso(clock()),
      sourceHttpStatus,
      snapshotState: 'available',
      snapshot,
      error: null,
    })
  }

  async function handleToTodo(req, res, lifetime, input) {
    if (!sendCurrentFailure(req, res, lifetime.signal)) return
    let store
    try { store = await getStore() } catch {
      if (sendCurrentFailure(req, res, lifetime.signal)) errorResponse(res, 503, 'storage_unavailable')
      return
    }
    if (!sendCurrentFailure(req, res, lifetime.signal)) return
    const now = toIso(clock())
    let outcome
    try {
      outcome = await store.transact(document => {
        if (document.snapshotState !== 'available' || document.snapshot?.checkId !== input.checkId) return { error: 'stale_check' }
        const check = document.snapshot.checks.find(item => item.sourceKey === input.sourceKey)
        if (!check || check.status !== 'degraded' || !check.code) return { error: 'source_not_actionable' }
        const evidence = {
          checkId: document.snapshot.checkId,
          sourceKey: check.sourceKey,
          status: check.status,
          code: check.code,
          sourceHttpStatus: document.snapshot.sourceHttpStatus,
          requestedAt: document.snapshot.requestedAt,
          receivedAt: document.snapshot.receivedAt,
          sourceScope: document.snapshot.sourceScope,
          evidence: check.evidence,
        }
        let todo = document.todos.find(item => item.sourceKey === check.sourceKey)
        if (!todo) {
          todo = {
            todoId: idFactory(), sourceKey: check.sourceKey,
            firstEvidence: evidence, latestEvidence: evidence,
            recipient: null, session: null, createdAt: now, updatedAt: now,
          }
          document.todos.push(todo)
          return { todo: structuredClone(todo), created: true }
        }
        if (todo.latestEvidence.checkId !== evidence.checkId) {
          todo.latestEvidence = evidence
          todo.updatedAt = now
        }
        return { todo: structuredClone(todo), created: false }
      }, { beforeCommit: () => currentFailure(req, res, lifetime.signal) === null })
    } catch {
      if (sendCurrentFailure(req, res, lifetime.signal)) errorResponse(res, 503, 'storage_unavailable')
      return
    }
    if (!outcome.committed) { sendCurrentFailure(req, res, lifetime.signal); return }
    if (!sendCurrentFailure(req, res, lifetime.signal)) return
    const result = outcome.value
    if (result?.error === 'stale_check') { errorResponse(res, 409, result.error); return }
    if (result?.error === 'source_not_actionable') { errorResponse(res, 409, result.error); return }
    json(res, result.created ? 201 : 200, { ok: true, created: result.created, todo: result.todo })
  }

  async function handle(req, res) {
    const initialFailure = currentFailure(req, res)
    if (initialFailure === 'host_unavailable') { errorResponse(res, 503, 'host_unavailable'); return }
    if (initialFailure?.startsWith('http_')) { errorResponse(res, Number(initialFailure.slice(5)), 'forbidden'); return }
    if (!routeUrlIsFixed(req)) { errorResponse(res, 400, 'invalid_request'); return }
    const method = String(req.method ?? '').toUpperCase()
    if (method !== 'GET' && method !== 'POST') {
      res.statusCode = 405
      res.setHeader('allow', 'GET, POST')
      res.end()
      return
    }
    const lifetime = requestLifetime(req, res, activeRequests)
    try {
      if (method === 'GET') { await handleGet(req, res, lifetime); return }
      let input
      try { input = await readBody(req) } catch { input = null }
      if (!sendCurrentFailure(req, res, lifetime.signal)) return
      if (!object(input)) { errorResponse(res, 400, 'invalid_request'); return }
      if (input.action === 'recheck' && exact(input, ['action'])) {
        await handleRecheck(req, res, lifetime)
        return
      }
      if (input.action === 'toTodo' && exact(input, ['action', 'checkId', 'sourceKey'])
        && typeof input.checkId === 'string' && typeof input.sourceKey === 'string') {
        await handleToTodo(req, res, lifetime, input)
        return
      }
      errorResponse(res, 400, 'invalid_request')
    } catch {
      if (sendCurrentFailure(req, res, lifetime.signal)) errorResponse(res, 503, 'storage_unavailable')
    } finally {
      lifetime.dispose()
    }
  }

  return Object.freeze({
    handle,
    dispose() {
      disposed = true
      for (const controller of activeRequests) controller.abort()
    },
  })
}
