import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { Readable } from 'node:stream'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'

const envFor = home => ({ DSH_HOME: home, TRADELOOM_DSH_APP_HOME: home })
const now = () => new Date('2026-10-30T04:00:00.000Z')
const ids = (() => { let n = 0; return () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}` })()

async function homeFixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'tl-o11-diagnostics-'))
  const home = join(root, 'home')
  await mkdir(home)
  const { HOME_MARKER_VALUE } = await import('../state.js')
  await writeFile(join(home, '.tradeloom-owned'), HOME_MARKER_VALUE)
  const roleDir = join(home, 'tradeloom-state')
  await mkdir(roleDir)
  const roleState = join(roleDir, 'state.json')
  const roleBytes = Buffer.from('{"roles":{"center":{"sessionId":"fixture"}}}\n')
  await writeFile(roleState, roleBytes)
  t.after(async () => await rm(root, { recursive: true, force: true }))
  return { root, home, roleState, roleBytes, env: envFor(home) }
}

function response() {
  const emitter = new EventEmitter()
  return Object.assign(emitter, {
    statusCode: 200,
    headers: {},
    writableEnded: false,
    destroyed: false,
    setHeader(key, value) { this.headers[key.toLowerCase()] = value },
    end(body = '') { this.body = String(body); this.writableEnded = true },
  })
}

function request(method = 'GET', body, url = '/tradeloom/diagnostics') {
  const bytes = body === undefined ? [] : [Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))]
  const req = Readable.from(bytes)
  req.method = method
  req.url = url
  req.headers = {}
  req.aborted = false
  return req
}

async function invoke(handler, method = 'GET', body, url) {
  const res = response()
  await handler.handle(request(method, body, url), res)
  return { status: res.statusCode, headers: res.headers, body: res.body ? JSON.parse(res.body) : null }
}

function health(status = 200, dbStatus = 'ok', dbCode = null) {
  const degraded = status === 503
  return JSON.stringify({
    status: degraded ? 'degraded' : 'ok',
    dependencies: {
      database: { status: dbStatus, ...(dbCode ? { code: dbCode } : {}), ...(dbStatus === 'ok' ? { scope: 'SELECT 1' } : {}) },
      intent_config: { status: degraded ? 'degraded' : 'ok', ...(degraded ? { code: 'invalid' } : {}) },
      runtime: { status: degraded ? 'degraded' : 'ok', ...(degraded ? { code: 'unavailable' } : {}), ...(degraded ? {} : { scope: 'local_health_check_only' }) },
      external_provider: { status: 'not_checked' },
      agentarts: { status: 'not_configured' },
    },
  })
}

function handlerFor(fixture, sendHealth = async () => ({ status: 200, raw: health() }), createStore) {
  const ctx = {
    connection: { requestRejection: () => undefined },
    webServer: { protocol: 'http:', host: '10.22.33.44', port: 3088, getOrigin: () => 'http://10.22.33.44:3088' },
  }
  return import('@tradeloom/dsh-business-shell/diagnostics-http').then(({ createDiagnosticsHandler }) => ({
    ctx,
    handler: createDiagnosticsHandler(ctx, {
      createDiagnosticsStore: createStore,
      storeOptions: { env: fixture.env },
      requestBusinessJson: sendHealth,
      now,
      idFactory: ids,
      timeoutMs: 15_000,
    }),
  }))
}

test('real file store keeps role state untouched and persists check/todo safely', async t => {
  const fixture = await homeFixture(t)
  const seen = []
  let healthResult = { status: 503, raw: health(503, 'degraded', 'unavailable') }
  const { handler } = await handlerFor(fixture, async options => {
    seen.push(options)
    return healthResult
  })
  const initial = await invoke(handler)
  assert.equal(initial.status, 200)
  assert.equal(initial.body.snapshotState, 'never_checked')
  assert.equal(initial.body.todosState, 'available')
  assert.deepEqual(initial.body.todos, [])

  const checked = await invoke(handler, 'POST', { action: 'recheck' })
  assert.equal(checked.status, 200)
  assert.equal(checked.body.outcome, 'checked')
  assert.equal(checked.body.sourceHttpStatus, 503)
  assert.equal(checked.body.snapshot.checks.find(row => row.checkKey === 'database').checkedAt, null)
  assert.equal(checked.body.snapshot.checks.find(row => row.checkKey === 'external_provider').status, 'not_checked')
  assert.deepEqual(Object.keys(seen[0]).sort(), ['authority', 'maxResponseBytes', 'method', 'path', 'signal', 'timeoutMs'].sort())
  assert.equal(seen[0].path, '/api/health')
  assert.equal(seen[0].method, 'GET')
  assert.equal(seen[0].timeoutMs, 15_000)
  assert.equal((await invoke(handler, 'POST', {
    action: 'toTodo', checkId: checked.body.checkId, sourceKey: 'workbench.local:external_provider',
  })).body.error.code, 'source_not_actionable')

  const input = { action: 'toTodo', checkId: checked.body.checkId, sourceKey: 'workbench.local:database' }
  const created = await invoke(handler, 'POST', input)
  const duplicate = await invoke(handler, 'POST', input)
  assert.equal(created.status, 201)
  assert.equal(duplicate.status, 200)
  assert.equal(duplicate.body.created, false)
  assert.equal(created.body.todo.todoId, duplicate.body.todo.todoId)
  assert.equal(created.body.todo.recipient, null)
  assert.equal(created.body.todo.session, null)
  assert.deepEqual(Object.keys(created.body.todo.firstEvidence).sort(), [
    'checkId', 'sourceKey', 'status', 'code', 'sourceHttpStatus', 'requestedAt', 'receivedAt', 'sourceScope', 'evidence',
  ].sort())
  assert.equal((await invoke(handler, 'POST', input)).body.todo.firstEvidence.checkId, checked.body.checkId)

  const secondFailure = await invoke(handler, 'POST', { action: 'recheck' })
  assert.equal(secondFailure.body.snapshot.status, 'degraded')
  healthResult = { status: 200, raw: health() }
  const recovered = await invoke(handler, 'POST', { action: 'recheck' })
  assert.equal(recovered.body.snapshot.status, 'ok')

  const restarted = await handlerFor(fixture)
  const loaded = await invoke(restarted.handler)
  assert.equal(loaded.body.snapshotState, 'available')
  assert.equal(loaded.body.snapshot.status, 'ok')
  assert.equal(loaded.body.todos.length, 1)
  assert.equal(loaded.body.todos[0].todoId, created.body.todo.todoId)
  assert.equal(loaded.body.todos[0].firstEvidence.checkId, checked.body.checkId)
  assert.equal(loaded.body.todos[0].latestEvidence.checkId, secondFailure.body.checkId)
  assert.deepEqual(await readFile(fixture.roleState), fixture.roleBytes)
  assert.equal(existsSync(join(fixture.home, 'tradeloom-state', 'diagnostics.json')), false)
  restarted.handler.dispose()
  handler.dispose()
})

test('source errors clear the current snapshot, keep HTTP status, and never create a todo', async t => {
  const fixture = await homeFixture(t)
  let source = async () => ({ status: 200, raw: health() })
  const { handler } = await handlerFor(fixture, options => source(options))
  const good = await invoke(handler, 'POST', { action: 'recheck' })
  assert.equal(good.body.snapshotState, 'available')
  source = async () => ({ status: 403, raw: '<html>blocked</html>' })
  const failed = await invoke(handler, 'POST', { action: 'recheck' })
  assert.equal(failed.body.outcome, 'read_error')
  assert.equal(failed.body.sourceHttpStatus, 403)
  assert.equal(failed.body.snapshot, null)
  assert.equal(JSON.stringify(failed.body).includes('blocked'), false)
  const current = await invoke(handler)
  assert.equal(current.body.snapshotState, 'read_error')
  assert.equal(current.body.snapshot, null)
  assert.equal(current.body.snapshotReadErrorCode, 'source_read_error')
  assert.equal((await invoke(handler, 'POST', { action: 'toTodo', checkId: good.body.checkId, sourceKey: 'workbench.local:database' })).body.error.code, 'stale_check')
  assert.equal((await invoke(handler, 'POST', { action: 'toTodo', checkId: failed.body.checkId, sourceKey: 'workbench.local:external_provider' })).body.error.code, 'stale_check')
  source = async () => { throw Object.assign(new Error('private timeout'), { code: 'tool_timeout' }) }
  const timeout = await invoke(handler, 'POST', { action: 'recheck' })
  assert.equal(timeout.body.outcome, 'read_error')
  assert.equal(timeout.body.sourceHttpStatus, null)
  assert.equal(JSON.stringify(timeout.body).includes('private timeout'), false)
  assert.equal((await invoke(handler)).body.snapshot, null)
  handler.dispose()
})

test('strict route, auth, and request shapes reject caller-controlled sources', async t => {
  const fixture = await homeFixture(t)
  const { handler, ctx } = await handlerFor(fixture)
  for (const [method, body] of [
    ['POST', { action: 'recheck', url: 'http://attacker.invalid' }],
    ['POST', { action: 'toTodo', checkId: ids(), sourceKey: 'workbench.local:database', evidence: {} }],
    ['POST', { action: 'other' }],
  ]) assert.equal((await invoke(handler, method, body)).status, 400)
  assert.equal((await invoke(handler, 'GET', undefined, '/tradeloom/diagnostics?url=x')).body.error.code, 'invalid_request')
  ctx.connection.requestRejection = () => 403
  assert.equal((await invoke(handler)).status, 403)
  handler.dispose()
})

test('source payload requires all five dependency rows and only preserves known stable codes', async t => {
  const fixture = await homeFixture(t)
  let raw = health()
  let status = 200
  const { handler } = await handlerFor(fixture, async () => ({ status, raw }))
  const incomplete = JSON.parse(raw)
  delete incomplete.dependencies.agentarts
  raw = JSON.stringify(incomplete)
  const invalid = await invoke(handler, 'POST', { action: 'recheck' })
  assert.equal(invalid.body.outcome, 'read_error')
  assert.equal(invalid.body.snapshot, null)

  const unknownCode = JSON.parse(health(503, 'degraded', 'unavailable'))
  unknownCode.dependencies.database.code = 'credential_exposed'
  status = 503
  raw = JSON.stringify(unknownCode)
  const checked = await invoke(handler, 'POST', { action: 'recheck' })
  const database = checked.body.snapshot.checks.find(row => row.checkKey === 'database')
  assert.equal(database.status, 'degraded')
  assert.equal(database.code, null)
  assert.equal(JSON.stringify(checked.body).includes('credential_exposed'), false)
  assert.equal((await invoke(handler, 'POST', {
    action: 'toTodo', checkId: checked.body.checkId, sourceKey: 'workbench.local:database',
  })).body.error.code, 'source_not_actionable')
  handler.dispose()
})

test('corrupt diagnostics storage is distinct from a valid empty document', async t => {
  const fixture = await homeFixture(t)
  await mkdir(join(fixture.home, 'tradeloom-diagnostics'))
  await writeFile(join(fixture.home, 'tradeloom-diagnostics', 'state.json'), '{broken')
  const { handler } = await handlerFor(fixture)
  const result = await invoke(handler)
  assert.equal(result.status, 200)
  assert.equal(result.body.snapshotState, 'read_error')
  assert.equal(result.body.todosState, 'read_error')
  assert.equal(result.body.snapshotReadErrorCode, 'storage_unavailable')
  assert.equal(result.body.todosReadErrorCode, 'storage_unavailable')
  assert.equal(result.body.snapshot, null)
  assert.deepEqual(result.body.todos, [])
  handler.dispose()
})

test('GET reports snapshot and todo storage corruption independently without rewriting either', async t => {
  const snapshotFixture = await homeFixture(t)
  const first = await handlerFor(snapshotFixture, async () => ({ status: 503, raw: health(503, 'degraded', 'unavailable') }))
  const checked = await invoke(first.handler, 'POST', { action: 'recheck' })
  await invoke(first.handler, 'POST', { action: 'toTodo', checkId: checked.body.checkId, sourceKey: 'workbench.local:database' })
  const statePath = join(snapshotFixture.home, 'tradeloom-diagnostics', 'state.json')
  const beforeSnapshotCorruption = JSON.parse(await readFile(statePath, 'utf8'))
  beforeSnapshotCorruption.snapshot.checks = []
  await writeFile(statePath, JSON.stringify(beforeSnapshotCorruption))
  const corruptedSnapshotBytes = await readFile(statePath)
  const partialSnapshot = await invoke(first.handler)
  assert.equal(partialSnapshot.body.snapshotState, 'read_error')
  assert.equal(partialSnapshot.body.snapshotReadErrorCode, 'storage_unavailable')
  assert.equal(partialSnapshot.body.todosState, 'available')
  assert.equal(partialSnapshot.body.todos.length, 1)
  assert.deepEqual(await readFile(statePath), corruptedSnapshotBytes)
  beforeSnapshotCorruption.latestAttemptId = 'corrupt-attempt-marker'
  await writeFile(statePath, JSON.stringify(beforeSnapshotCorruption))
  const corruptedAttemptBytes = await readFile(statePath)
  const partialAttempt = await invoke(first.handler)
  assert.equal(partialAttempt.body.snapshotState, 'read_error')
  assert.equal(partialAttempt.body.todosState, 'available')
  assert.equal(partialAttempt.body.todos.length, 1)
  assert.deepEqual(await readFile(statePath), corruptedAttemptBytes)
  first.handler.dispose()

  const todoFixture = await homeFixture(t)
  const second = await handlerFor(todoFixture)
  await invoke(second.handler, 'POST', { action: 'recheck' })
  const todoPath = join(todoFixture.home, 'tradeloom-diagnostics', 'state.json')
  const beforeTodoCorruption = JSON.parse(await readFile(todoPath, 'utf8'))
  beforeTodoCorruption.todos = [{ malformed: true }]
  await writeFile(todoPath, JSON.stringify(beforeTodoCorruption))
  const corruptedTodoBytes = await readFile(todoPath)
  const partialTodos = await invoke(second.handler)
  assert.equal(partialTodos.body.snapshotState, 'available')
  assert.equal(partialTodos.body.todosState, 'read_error')
  assert.equal(partialTodos.body.todosReadErrorCode, 'storage_unavailable')
  assert.deepEqual(partialTodos.body.todos, [])
  assert.deepEqual(await readFile(todoPath), corruptedTodoBytes)
  second.handler.dispose()
})

test('dispose and Host identity replacement prevent late source results from becoming current', async t => {
  const fixture = await homeFixture(t)
  let signal
  let rejectSource
  const { handler, ctx: actualCtx } = await handlerFor(fixture, options => {
    signal = options.signal
    return new Promise((_resolve, reject) => {
      rejectSource = reject
      signal.addEventListener('abort', () => reject(Object.assign(new Error('cancelled'), { code: 'tool_cancelled' })), { once: true })
    })
  })
  const pending = invoke(handler, 'POST', { action: 'recheck' })
  while (!signal) await new Promise(resolve => setTimeout(resolve, 1))
  actualCtx.connection = { requestRejection: () => undefined }
  rejectSource(Object.assign(new Error('late'), { code: 'tool_cancelled' }))
  const replaced = await pending
  assert.equal(replaced.status, 503)
  assert.equal(replaced.body.error.code, 'host_unavailable')
  handler.dispose()

  const store = await import('@tradeloom/dsh-business-shell/diagnostics-store')
  const document = await (await store.createDiagnosticsStore({ env: fixture.env })).read()
  assert.equal(document.snapshotState, 'never_checked')

  let abortSignal
  const aborted = await handlerFor(fixture, ({ signal }) => new Promise((_resolve, reject) => {
    abortSignal = signal
    signal.addEventListener('abort', () => reject(Object.assign(new Error('cancelled'), { code: 'tool_cancelled' })), { once: true })
  }))
  const cancelled = invoke(aborted.handler, 'POST', { action: 'recheck' })
  while (!abortSignal) await new Promise(resolve => setTimeout(resolve, 1))
  aborted.handler.dispose()
  await cancelled
  const afterAbort = await (await store.createDiagnosticsStore({ env: fixture.env })).read()
  assert.equal(afterAbort.snapshotState, 'never_checked')
})

test('Host authorization revoked during the source request prevents snapshot commit', async t => {
  const fixture = await homeFixture(t)
  let resolveSource
  let started = false
  const { handler, ctx } = await handlerFor(fixture, () => new Promise(resolve => {
    started = true
    resolveSource = resolve
  }))
  const pending = invoke(handler, 'POST', { action: 'recheck' })
  while (!started) await new Promise(resolve => setTimeout(resolve, 1))
  ctx.connection.requestRejection = () => 403
  resolveSource({ status: 503, raw: health(503, 'degraded', 'unavailable') })
  const result = await pending
  assert.equal(result.status, 403)
  assert.equal(result.body.error.code, 'forbidden')
  const store = await import('@tradeloom/dsh-business-shell/diagnostics-store')
  assert.equal((await (await store.createDiagnosticsStore({ env: fixture.env })).read()).snapshotState, 'never_checked')
  handler.dispose()
})

test('Host authorization revoked while owned store is being initialized prevents any source request', async t => {
  const fixture = await homeFixture(t)
  let resolveStore
  let storeFactoryStarted = false
  let sourceCalls = 0
  const actualStore = await import('@tradeloom/dsh-business-shell/diagnostics-store')
  const { handler, ctx } = await handlerFor(fixture, async () => {
    sourceCalls += 1
    return { status: 200, raw: health() }
  }, async options => {
    storeFactoryStarted = true
    return await new Promise(resolve => { resolveStore = resolve })
  })
  const pending = invoke(handler, 'POST', { action: 'recheck' })
  while (!storeFactoryStarted) await new Promise(resolve => setTimeout(resolve, 1))
  ctx.connection.requestRejection = () => 403
  resolveStore(await actualStore.createDiagnosticsStore({ env: fixture.env }))
  const result = await pending
  assert.equal(result.status, 403)
  assert.equal(result.body.error.code, 'forbidden')
  assert.equal(sourceCalls, 0)
  const stored = await (await actualStore.createDiagnosticsStore({ env: fixture.env })).read()
  assert.equal(stored.latestAttemptId, null)
  handler.dispose()
})

test('an aborted newer attempt leaves the last committed snapshot actionable', async t => {
  const fixture = await homeFixture(t)
  let calls = 0
  let pendingSignal
  const { handler } = await handlerFor(fixture, ({ signal }) => {
    calls += 1
    if (calls === 1) return Promise.resolve({ status: 503, raw: health(503, 'degraded', 'unavailable') })
    pendingSignal = signal
    return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true }))
  })
  const committed = await invoke(handler, 'POST', { action: 'recheck' })
  const req = request('POST', { action: 'recheck' })
  const res = response()
  const unfinished = handler.handle(req, res)
  while (!pendingSignal) await new Promise(resolve => setTimeout(resolve, 1))
  req.emit('aborted')
  await unfinished
  const todo = await invoke(handler, 'POST', {
    action: 'toTodo', checkId: committed.body.checkId, sourceKey: 'workbench.local:database',
  })
  assert.equal(todo.status, 201)
  assert.equal(todo.body.todo.firstEvidence.checkId, committed.body.checkId)
  handler.dispose()
})

test('late older health response cannot overwrite the latest check', async t => {
  const fixture = await homeFixture(t)
  const pending = []
  const { handler } = await handlerFor(fixture, () => new Promise(resolve => pending.push(resolve)))
  const older = invoke(handler, 'POST', { action: 'recheck' })
  while (pending.length < 1) await new Promise(resolve => setTimeout(resolve, 1))
  const newer = invoke(handler, 'POST', { action: 'recheck' })
  while (pending.length < 2) await new Promise(resolve => setTimeout(resolve, 1))
  pending[1]({ status: 200, raw: health() })
  const newest = await newer
  pending[0]({ status: 503, raw: health(503, 'degraded', 'unavailable') })
  const stale = await older
  assert.equal(newest.body.outcome, 'checked')
  assert.equal(stale.status, 409)
  assert.equal(stale.body.error.code, 'check_superseded')
  const current = await invoke(handler)
  assert.equal(current.body.snapshot.checkId, newest.body.checkId)
  assert.equal(current.body.snapshot.status, 'ok')
  handler.dispose()
})

test('current package exports both diagnostics modules', async () => {
  const store = await import('@tradeloom/dsh-business-shell/diagnostics-store')
  const http = await import('@tradeloom/dsh-business-shell/diagnostics-http')
  assert.equal(typeof store.createDiagnosticsStore, 'function')
  assert.equal(typeof http.createDiagnosticsHandler, 'function')
  const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
  for (const file of ['diagnostics-store.js', 'diagnostics-http.js']) {
    assert.ok(packageJson.files.includes(file))
    assert.ok(existsSync(join(import.meta.dirname, '..', file)))
  }
})
