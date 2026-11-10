import { spawn } from 'node:child_process'
import { access } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { isAbsolute, join } from 'node:path'
import { isIP } from 'node:net'

export const LISTENER_IDENTITY_ROUTE = '/tradeloom/diagnostics/listener-identity'
const ORIGINAL = Symbol.for('cordis.original')
const MAX_OUTPUT_BYTES = 128 * 1024
const COLLECTOR_TIMEOUT_MS = 15_000
const SCRIPT_PATH = fileURLToPath(new URL('./listener-identity.ps1', import.meta.url))
const LISTENER_CODES = new Set([
  'invalid_request', 'tcp_query_failed', 'multiple_owners', 'process_query_failed', 'process_unavailable',
  'executable_unavailable', 'executable_hash_failed', 'process_identity_incomplete', 'identity_changed',
])
const FIREWALL_CODES = new Set(['firewall_query_failed', 'identity_changed'])
const RULE_FIELDS = Object.freeze(['name', 'enabled', 'direction', 'action', 'profile', 'policyStoreSourceType', 'policyStoreSource'])

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const exact = (value, keys) => object(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key))
const safeString = value => value === null || typeof value === 'string'

function failure(code) {
  return Object.assign(new Error(code), { code })
}

function serviceIdentity(service) {
  try {
    const original = service?.[ORIGINAL]
    return original === undefined ? service : original
  } catch {
    return service
  }
}

function windowsSystemRoot() {
  const root = process.env.SystemRoot ?? process.env.WINDIR
  if (typeof root !== 'string' || !isAbsolute(root)) throw failure('listener_identity_unavailable')
  return root
}

function powershellPath() {
  return join(windowsSystemRoot(), 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
}

function validateRule(rule) {
  return exact(rule, RULE_FIELDS) && RULE_FIELDS.every(key => typeof rule[key] === 'string'
    && rule[key].length <= 1024 && !/[\x00-\x1f\x7f]/.test(rule[key]))
}

function validateObservation(value, expectedPort) {
  if (!exact(value, ['listener', 'firewall'])) return null
  const listener = value.listener
  const firewall = value.firewall
  const listenerKeys = ['status', 'port', 'addresses', 'candidatePids', 'pid', 'executablePath', 'createdAt', 'sha256', 'fileVersion', 'productVersion', 'errorCode']
  const firewallKeys = ['status', 'rules', 'errorCode']
  if (!exact(listener, listenerKeys) || !exact(firewall, firewallKeys)) return null
  if (!['observed', 'not_listening', 'unknown', 'ambiguous'].includes(listener.status)
    || listener.port !== expectedPort
    || !Array.isArray(listener.addresses) || listener.addresses.some(item => typeof item !== 'string' || item.length > 64 || !isIP(item.split('%', 1)[0]))
    || !Array.isArray(listener.candidatePids) || listener.candidatePids.some(item => !Number.isSafeInteger(item) || item < 1)
    || (listener.pid !== null && (!Number.isSafeInteger(listener.pid) || listener.pid < 1))
    || !safeString(listener.executablePath) || (listener.executablePath !== null && (listener.executablePath.length > 32768 || /[\x00-\x1f\x7f]/.test(listener.executablePath)))
    || !safeString(listener.createdAt) || (listener.createdAt !== null && (listener.createdAt.length > 64 || !Number.isFinite(Date.parse(listener.createdAt))))
    || !safeString(listener.sha256) || !safeString(listener.fileVersion) || !safeString(listener.productVersion)
    || !safeString(listener.errorCode) || (listener.errorCode !== null && !LISTENER_CODES.has(listener.errorCode))) return null
  if ([listener.fileVersion, listener.productVersion].some(item => item !== null && (item.length > 128 || /[\x00-\x1f\x7f]/.test(item)))) return null
  if (listener.sha256 !== null && !/^[a-f0-9]{64}$/i.test(listener.sha256)) return null
  if (!['observed', 'unknown', 'not_checked'].includes(firewall.status)
    || !Array.isArray(firewall.rules) || !firewall.rules.every(validateRule) || !safeString(firewall.errorCode)
    || (firewall.errorCode !== null && !FIREWALL_CODES.has(firewall.errorCode))) return null
  if (firewall.status !== 'observed' && firewall.rules.length !== 0) return null
  if (firewall.status === 'observed' && firewall.errorCode !== null) return null
  if (firewall.status === 'unknown' && firewall.errorCode === null) return null
  if (firewall.status === 'not_checked' && firewall.errorCode !== null) return null
  if (listener.status === 'observed' && (listener.pid === null || listener.executablePath === null
    || listener.createdAt === null || listener.sha256 === null || listener.errorCode !== null
    || listener.addresses.length === 0 || listener.candidatePids.length !== 1 || listener.candidatePids[0] !== listener.pid
    || firewall.status === 'not_checked')) return null
  if (listener.status === 'not_listening' && (listener.pid !== null || listener.executablePath !== null
    || listener.createdAt !== null || listener.sha256 !== null || listener.fileVersion !== null || listener.productVersion !== null
    || listener.errorCode !== null || listener.addresses.length !== 0 || listener.candidatePids.length !== 0
    || firewall.status !== 'not_checked')) return null
  if (listener.status === 'ambiguous' && (listener.pid !== null || listener.executablePath !== null
    || listener.createdAt !== null || listener.sha256 !== null || listener.fileVersion !== null || listener.productVersion !== null
    || listener.errorCode !== 'multiple_owners' || listener.candidatePids.length < 2 || firewall.status !== 'not_checked')) return null
  if (listener.status === 'unknown' && (listener.pid !== null || listener.executablePath !== null
    || listener.createdAt !== null || listener.sha256 !== null || listener.fileVersion !== null || listener.productVersion !== null
    || listener.errorCode === null)) return null
  return structuredClone(value)
}

export async function collectWindowsListenerIdentity({ port, signal, timeoutMs = COLLECTOR_TIMEOUT_MS } = {}) {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw failure('listener_identity_unavailable')
  if (process.platform !== 'win32') throw failure('listener_identity_unavailable')
  const executable = powershellPath()
  await access(executable).catch(() => { throw failure('listener_identity_unavailable') })
  await access(SCRIPT_PATH).catch(() => { throw failure('listener_identity_unavailable') })
  if (signal?.aborted) throw failure('listener_identity_cancelled')

  return await new Promise((resolve, reject) => {
    let child
    let settled = false
    let outputBytes = 0
    const stdout = []
    let timer
    let stopCode = null
    const settle = (error, value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      if (error) reject(error)
      else resolve(value)
    }
    const kill = code => {
      if (settled) return
      stopCode ??= code
      if (child && child.exitCode === null && child.signalCode === null) child.kill()
    }
    const onAbort = () => kill('listener_identity_cancelled')
    try {
      child = spawn(executable, ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', SCRIPT_PATH], {
        shell: false,
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'ignore'],
        env: {
          SystemRoot: process.env.SystemRoot,
          WINDIR: process.env.WINDIR,
          PATH: process.env.PATH,
          TEMP: process.env.TEMP,
          TMP: process.env.TMP,
          PSModulePath: join(windowsSystemRoot(), 'System32', 'WindowsPowerShell', 'v1.0', 'Modules'),
        },
      })
    } catch {
      settle(failure('listener_identity_unavailable'))
      return
    }
    child.stdout.on('data', chunk => {
      outputBytes += chunk.byteLength
      if (outputBytes > MAX_OUTPUT_BYTES) {
        kill('listener_identity_invalid_response')
        return
      }
      stdout.push(chunk)
    })
    child.on('error', () => settle(failure('listener_identity_unavailable')))
    child.on('close', code => {
      if (settled) return
      if (stopCode) { settle(failure(stopCode)); return }
      if (code !== 0) { settle(failure('listener_identity_unavailable')); return }
      let parsed
      try { parsed = JSON.parse(Buffer.concat(stdout).toString('utf8')) } catch { settle(failure('listener_identity_invalid_response')); return }
      const observation = validateObservation(parsed, port)
      if (!observation) { settle(failure('listener_identity_invalid_response')); return }
      settle(null, observation)
    })
    signal?.addEventListener('abort', onAbort, { once: true })
    if (signal?.aborted) { onAbort(); return }
    timer = setTimeout(() => kill('listener_identity_timeout'), timeoutMs)
    child.stdin.on('error', () => {})
    child.stdin.end(JSON.stringify({ port }))
  })
}

function routeIsExact(req) {
  if (typeof req.url !== 'string') return false
  try {
    const parsed = new URL(req.url, 'http://localhost')
    return parsed.origin === 'http://localhost' && parsed.pathname === LISTENER_IDENTITY_ROUTE
      && !parsed.search && !parsed.hash
  } catch { return false }
}

function sendJson(res, status, body) {
  if (!res || res.destroyed || res.writableEnded) return false
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.setHeader('x-content-type-options', 'nosniff')
  res.end(JSON.stringify(body))
  return true
}

function requestLifetime(req, res, active) {
  const controller = new AbortController()
  const onAbort = () => controller.abort()
  const onClose = () => { if (!res.writableEnded) controller.abort() }
  req.once?.('aborted', onAbort)
  res.once?.('close', onClose)
  if (req.aborted) controller.abort()
  active.add(controller)
  return {
    signal: controller.signal,
    dispose() {
      req.removeListener?.('aborted', onAbort)
      res.removeListener?.('close', onClose)
      active.delete(controller)
    },
  }
}

export function createListenerIdentityHandler(ctx, dependencies = {}) {
  const port = dependencies.port
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new TypeError('invalid listener port')
  const collect = dependencies.collectListenerIdentity ?? collectWindowsListenerIdentity
  const initialConnection = serviceIdentity(ctx?.connection)
  const initialWebServer = serviceIdentity(ctx?.webServer)
  const active = new Set()
  const inFlight = new Set()
  let disposed = false

  const contextCurrent = () => !disposed && initialConnection != null && initialWebServer != null
    && serviceIdentity(ctx?.connection) === initialConnection
    && serviceIdentity(ctx?.webServer) === initialWebServer

  function requestRejection(req) {
    try {
      if (typeof ctx.connection?.requestRejection !== 'function') return 403
      const result = ctx.connection.requestRejection(req)
      return result === undefined ? null : Number.isInteger(result) && result >= 400 && result <= 599 ? result : 403
    } catch { return 403 }
  }

  async function handle(req, res) {
    if (!contextCurrent()) { sendJson(res, 503, { ok: false, error: { code: 'host_unavailable' } }); return }
    const rejection = requestRejection(req)
    if (rejection !== null) { sendJson(res, rejection, { ok: false, error: { code: 'forbidden' } }); return }
    if (!routeIsExact(req)) { sendJson(res, 400, { ok: false, error: { code: 'invalid_request' } }); return }
    if (String(req.method ?? '').toUpperCase() !== 'GET') {
      res.statusCode = 405
      res.setHeader('allow', 'GET')
      res.end()
      return
    }
    const lifetime = requestLifetime(req, res, active)
    let resolveDone
    const done = new Promise(resolve => { resolveDone = resolve })
    inFlight.add(done)
    try {
      const raw = await collect({ port, signal: lifetime.signal })
      if (lifetime.signal.aborted) return
      if (!contextCurrent()) { sendJson(res, 503, { ok: false, error: { code: 'host_unavailable' } }); return }
      const afterRejection = requestRejection(req)
      if (afterRejection !== null) { sendJson(res, afterRejection, { ok: false, error: { code: 'forbidden' } }); return }
      const result = validateObservation(raw, port)
      if (!result) { sendJson(res, 503, { ok: false, error: { code: 'listener_identity_unavailable' } }); return }
      sendJson(res, 200, { ok: true, ...result })
    } catch (error) {
      if (lifetime.signal.aborted || res.destroyed || res.writableEnded) return
      if (!contextCurrent()) { sendJson(res, 503, { ok: false, error: { code: 'host_unavailable' } }); return }
      const rejected = requestRejection(req)
      if (rejected !== null) { sendJson(res, rejected, { ok: false, error: { code: 'forbidden' } }); return }
      const code = ['listener_identity_cancelled', 'listener_identity_timeout'].includes(error?.code)
        ? error.code : 'listener_identity_unavailable'
      sendJson(res, code === 'listener_identity_timeout' ? 504 : code === 'listener_identity_cancelled' ? 503 : 503, { ok: false, error: { code } })
    } finally {
      lifetime.dispose()
      inFlight.delete(done)
      resolveDone()
    }
  }

  return Object.freeze({
    handle,
    dispose() {
      disposed = true
      for (const controller of active) controller.abort()
      return Promise.all([...inFlight])
    },
  })
}
