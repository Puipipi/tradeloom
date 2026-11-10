import { randomUUID } from 'node:crypto'
import { open, readFile, rename, unlink, mkdir, lstat } from 'node:fs/promises'
import { join, resolve, relative, isAbsolute, dirname, parse, sep } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { resolveOwnedHome } from './state.js'

const SOURCE_KEYS = Object.freeze(['database', 'intent_config', 'runtime', 'external_provider', 'agentarts'])
const CHECK_STATES = new Set(['ok', 'degraded', 'not_checked', 'not_configured', 'unknown'])
const READ_STATES = new Set(['never_checked', 'available', 'read_error'])
const SAFE_CODES = new Set(['invalid', 'unavailable'])
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const queues = new Map()

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

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const timestamp = value => typeof value === 'string' && Number.isFinite(Date.parse(value))
const exact = (value, keys) => object(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key))
const sourceKey = key => `workbench.local:${key}`
const safeScope = (key, scope) => scope === null || (key === 'database' && scope === 'SELECT 1')
  || (key === 'runtime' && scope === 'local_health_check_only')

function initialDocument() {
  return {
    version: 1,
    snapshotState: 'never_checked',
    snapshot: null,
    snapshotReadErrorCode: null,
    latestAttemptId: null,
    todos: [],
  }
}

function validEvidence(value, expectedSourceKey) {
  const keys = ['checkId', 'sourceKey', 'status', 'code', 'sourceHttpStatus', 'requestedAt', 'receivedAt', 'sourceScope', 'evidence']
  if (!exact(value, keys) || !UUID.test(value.checkId ?? '') || value.sourceKey !== expectedSourceKey
    || value.status !== 'degraded' || !SAFE_CODES.has(value.code)
    || value.sourceHttpStatus !== 503 || !timestamp(value.requestedAt) || !timestamp(value.receivedAt)
    || value.sourceScope !== 'workbench.local') return false
  return value.evidence === null || (object(value.evidence)
    && Object.keys(value.evidence).every(key => ['scope', 'status'].includes(key))
    && Object.hasOwn(value.evidence, 'status') && value.evidence.status === 'degraded'
    && safeScope(expectedSourceKey.slice('workbench.local:'.length), value.evidence.scope))
}

function validSnapshot(value) {
  const keys = ['checkId', 'sourceScope', 'checked', 'status', 'requestedAt', 'startedAt', 'receivedAt', 'sourceHttpStatus', 'checks']
  if (!exact(value, keys) || !UUID.test(value.checkId ?? '') || value.sourceScope !== 'workbench.local'
    || value.checked !== true || !['ok', 'degraded'].includes(value.status)
    || !timestamp(value.requestedAt) || !timestamp(value.startedAt) || !timestamp(value.receivedAt)
    || ![200, 503].includes(value.sourceHttpStatus) || !Array.isArray(value.checks) || value.checks.length !== SOURCE_KEYS.length) return false
  const seen = new Set()
  let hasDegraded = false
  for (const check of value.checks) {
    const keys = ['checkKey', 'sourceKey', 'status', 'code', 'evidence', 'checkedAt']
    if (!exact(check, keys) || !SOURCE_KEYS.includes(check.checkKey) || check.sourceKey !== sourceKey(check.checkKey)
      || !CHECK_STATES.has(check.status) || seen.has(check.checkKey)
      || (check.code !== null && (check.status !== 'degraded' || !SAFE_CODES.has(check.code)))
      || (check.checkedAt !== null && !timestamp(check.checkedAt))) return false
    if (check.evidence !== null && (!object(check.evidence)
      || Object.keys(check.evidence).some(key => !['scope', 'status'].includes(key))
      || check.evidence.status !== check.status
      || !safeScope(check.checkKey, check.evidence.scope))) return false
    if (['not_checked', 'not_configured'].includes(check.status) && check.checkedAt !== null) return false
    if (check.status === 'degraded') hasDegraded = true
    seen.add(check.checkKey)
  }
  return seen.size === SOURCE_KEYS.length
    && ((value.sourceHttpStatus === 200 && value.status === 'ok' && !hasDegraded)
      || (value.sourceHttpStatus === 503 && value.status === 'degraded' && hasDegraded))
}

function validateDocument(value) {
  const keys = ['version', 'snapshotState', 'snapshot', 'snapshotReadErrorCode', 'latestAttemptId', 'todos']
  if (!exact(value, keys) || value.version !== 1 || !READ_STATES.has(value.snapshotState)
    || (value.latestAttemptId !== null && !UUID.test(value.latestAttemptId)) || !Array.isArray(value.todos)) {
    throw new Error('diagnostics_store_corrupt')
  }
  if (value.snapshotState === 'available') {
    if (!validSnapshot(value.snapshot) || value.snapshotReadErrorCode !== null) throw new Error('diagnostics_store_corrupt')
  } else if (value.snapshot !== null) throw new Error('diagnostics_store_corrupt')
  if (value.snapshotState === 'never_checked' && value.snapshotReadErrorCode !== null) throw new Error('diagnostics_store_corrupt')
  if (value.snapshotState === 'read_error' && value.snapshotReadErrorCode !== 'source_read_error') throw new Error('diagnostics_store_corrupt')

  const todoIds = new Set()
  const todoSources = new Set()
  for (const todo of value.todos) {
    const keys = ['todoId', 'sourceKey', 'firstEvidence', 'latestEvidence', 'recipient', 'session', 'createdAt', 'updatedAt']
    const allowedSource = SOURCE_KEYS.some(key => sourceKey(key) === todo?.sourceKey)
    if (!exact(todo, keys) || !UUID.test(todo.todoId ?? '') || !allowedSource
      || !validEvidence(todo.firstEvidence, todo.sourceKey) || !validEvidence(todo.latestEvidence, todo.sourceKey)
      || todo.recipient !== null || todo.session !== null || !timestamp(todo.createdAt) || !timestamp(todo.updatedAt)
      || todoIds.has(todo.todoId) || todoSources.has(todo.sourceKey)) throw new Error('diagnostics_store_corrupt')
    todoIds.add(todo.todoId)
    todoSources.add(todo.sourceKey)
  }
  return value
}

async function readFileDocument(path, home) {
  await assertNoLinks(path, home)
  const text = await readFile(path, 'utf8').catch(error => error?.code === 'ENOENT' ? null : Promise.reject(error))
  if (text === null) return initialDocument()
  let parsed
  try { parsed = JSON.parse(text) } catch { throw new Error('diagnostics_store_corrupt') }
  return validateDocument(parsed)
}

function validateTodos(todos) {
  if (!Array.isArray(todos)) throw new Error('diagnostics_store_corrupt')
  const todoIds = new Set()
  const todoSources = new Set()
  for (const todo of todos) {
    const keys = ['todoId', 'sourceKey', 'firstEvidence', 'latestEvidence', 'recipient', 'session', 'createdAt', 'updatedAt']
    const allowedSource = SOURCE_KEYS.some(key => sourceKey(key) === todo?.sourceKey)
    if (!exact(todo, keys) || !UUID.test(todo.todoId ?? '') || !allowedSource
      || !validEvidence(todo.firstEvidence, todo.sourceKey) || !validEvidence(todo.latestEvidence, todo.sourceKey)
      || todo.recipient !== null || todo.session !== null || !timestamp(todo.createdAt) || !timestamp(todo.updatedAt)
      || todoIds.has(todo.todoId) || todoSources.has(todo.sourceKey)) throw new Error('diagnostics_store_corrupt')
    todoIds.add(todo.todoId)
    todoSources.add(todo.sourceKey)
  }
  return todos
}

async function readProjectedDocument(path, home) {
  await assertNoLinks(path, home)
  const text = await readFile(path, 'utf8').catch(error => error?.code === 'ENOENT' ? null : Promise.reject(error))
  if (text === null) return { ...initialDocument(), todosState: 'available', todosReadErrorCode: null }
  let parsed
  try { parsed = JSON.parse(text) } catch { throw new Error('diagnostics_store_corrupt') }
  const rootKeys = ['version', 'snapshotState', 'snapshot', 'snapshotReadErrorCode', 'latestAttemptId', 'todos']
  if (!exact(parsed, rootKeys) || parsed.version !== 1) throw new Error('diagnostics_store_corrupt')

  let snapshotState = parsed.snapshotState
  let snapshot = parsed.snapshot
  let snapshotReadErrorCode = parsed.snapshotReadErrorCode
  try {
    if (parsed.latestAttemptId !== null && !UUID.test(parsed.latestAttemptId)) throw new Error('diagnostics_store_corrupt')
    if (!READ_STATES.has(snapshotState)) throw new Error('diagnostics_store_corrupt')
    if (snapshotState === 'available') {
      if (!validSnapshot(snapshot) || snapshotReadErrorCode !== null) throw new Error('diagnostics_store_corrupt')
    } else if (snapshot !== null) throw new Error('diagnostics_store_corrupt')
    if (snapshotState === 'never_checked' && snapshotReadErrorCode !== null) throw new Error('diagnostics_store_corrupt')
    if (snapshotState === 'read_error' && snapshotReadErrorCode !== 'source_read_error') throw new Error('diagnostics_store_corrupt')
  } catch {
    snapshotState = 'read_error'
    snapshot = null
    snapshotReadErrorCode = 'storage_unavailable'
  }

  let todos = parsed.todos
  let todosState = 'available'
  let todosReadErrorCode = null
  try { validateTodos(todos) } catch {
    todos = []
    todosState = 'read_error'
    todosReadErrorCode = 'storage_unavailable'
  }
  return {
    ...parsed,
    snapshotState,
    snapshot,
    snapshotReadErrorCode,
    todos,
    todosState,
    todosReadErrorCode,
  }
}

async function writeAtomic(path, directory, home, document, beforeCommit) {
  const temporary = join(directory, `.diagnostics-${randomUUID()}.tmp`)
  await assertNoLinks(temporary, home)
  let handle
  try {
    handle = await open(temporary, 'wx', 0o600)
    await handle.writeFile(`${JSON.stringify(document, null, 2)}\n`, 'utf8')
    await handle.sync()
    await handle.close()
    handle = undefined
    if (typeof beforeCommit === 'function' && !beforeCommit()) return false
    if (process.platform === 'win32') {
      const retryDelays = [20, 50, 100]
      let initialRenameError
      for (let attempt = 0; ; attempt += 1) {
        if (typeof beforeCommit === 'function' && !beforeCommit()) return false
        try {
          await rename(temporary, path)
          break
        } catch (error) {
          if (!['EPERM', 'EBUSY'].includes(error?.code)) throw error
          initialRenameError ??= error
          if (attempt >= retryDelays.length) throw initialRenameError
          await delay(retryDelays[attempt])
        }
      }
    } else {
      await rename(temporary, path)
    }
    return true
  } finally {
    if (handle) await handle.close().catch(() => {})
    await unlink(temporary).catch(error => { if (error?.code !== 'ENOENT') throw error })
  }
}

/** Separate host-owned diagnostic JSON under the already validated DSH home. */
export async function createDiagnosticsStore(options = {}) {
  const home = await (options.resolveOwnedHome ?? resolveOwnedHome)(options.env ?? process.env)
  const directory = join(home, 'tradeloom-diagnostics')
  await assertNoLinks(directory, home)
  await mkdir(directory, { recursive: true })
  await assertNoLinks(directory, home)
  const path = join(directory, 'state.json')
  const queueKey = resolve(path).toLocaleLowerCase('en-US')

  return Object.freeze({
    async read() {
      return await readProjectedDocument(path, home)
    },
    async transact(mutator, options = {}) {
      const previous = queues.get(queueKey) ?? Promise.resolve()
      let release
      const gate = new Promise(resolveGate => { release = resolveGate })
      const tail = previous.then(() => gate)
      queues.set(queueKey, tail)
      await previous
      try {
        const document = await readFileDocument(path, home)
        if (typeof options.beforeCommit === 'function' && !options.beforeCommit()) return { committed: false }
        const value = await mutator(document)
        if (value === false) return { committed: false, value }
        validateDocument(document)
        if (typeof options.beforeCommit === 'function' && !options.beforeCommit()) return { committed: false }
        const written = await writeAtomic(path, directory, home, document, options.beforeCommit)
        if (!written) return { committed: false, value }
        return { committed: true, value }
      } finally {
        release()
        if (queues.get(queueKey) === tail) queues.delete(queueKey)
      }
    },
  })
}
