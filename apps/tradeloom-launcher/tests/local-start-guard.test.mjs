import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { launcherPipeName, reserveNamedPipe } from '../core.mjs'
import { withLocalStartGuard } from '../local-start-guard.mjs'

const TEST_TIMEOUT_MS = 5000
const boundedTest = (name, fn) => test(name, { timeout: TEST_TIMEOUT_MS }, fn)

async function removeSyntheticRoot(root) {
  const tempRoot = path.resolve(os.tmpdir())
  const resolved = path.resolve(root)
  const relative = path.relative(tempRoot, resolved)
  if (!path.basename(resolved).startsWith('tradeloom-local-start-') || !relative || relative === '..'
    || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error('Refusing to remove a path outside the synthetic local-start test root.')
  }
  await rm(resolved, { recursive: true, force: true })
}

async function createHome(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'tradeloom-local-start-'))
  t.after(() => removeSyntheticRoot(root))
  return path.join(root, 'harness-home')
}

function closeServer(server) {
  return new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
}

boundedTest('an occupied launcher pipe is already-running and leaves startup state untouched', async t => {
  const home = await createHome(t)
  const server = await reserveNamedPipe(launcherPipeName(home))
  let acceptedConnections = 0
  server.on('connection', () => { acceptedConnections += 1 })
  t.after(() => closeServer(server))
  const stateFile = path.join(path.dirname(home), 'evidence-state.json')
  await writeFile(stateFile, '{"owner":"active"}\n')
  let callbackCalled = false

  const result = await withLocalStartGuard(home, async () => {
    callbackCalled = true
    await writeFile(stateFile, '{"owner":"duplicate"}\n')
  })

  assert.equal(result.status, 'already-running')
  assert.equal(callbackCalled, false)
  assert.equal(await readFile(stateFile, 'utf8'), '{"owner":"active"}\n')
  assert.equal(acceptedConnections, 0)
})

boundedTest('concurrent starts delegate once and hold the startup reservation through callback settlement', async t => {
  const home = await createHome(t)
  let finishCallback
  const callbackFinished = new Promise(resolve => { finishCallback = resolve })
  t.after(() => finishCallback())
  let markCallbackStarted
  const callbackStarted = new Promise(resolve => { markCallbackStarted = resolve })
  let calls = 0
  const first = withLocalStartGuard(home, async () => {
    calls += 1
    markCallbackStarted()
    await callbackFinished
    return 'lifecycle result'
  })

  await callbackStarted
  const second = await withLocalStartGuard(home, async () => { calls += 1 })
  assert.equal(second.status, 'already-starting')
  assert.equal(calls, 1)
  finishCallback()
  assert.deepEqual(await first, { status: 'started', value: 'lifecycle result' })

  const afterSettlement = await withLocalStartGuard(home, async () => 'next lifecycle')
  assert.deepEqual(afterSettlement, { status: 'started', value: 'next lifecycle' })
})

boundedTest('callback failure releases the startup reservation and propagates the error', async t => {
  const home = await createHome(t)
  const failure = new Error('synthetic startup failure')
  await assert.rejects(withLocalStartGuard(home, async () => { throw failure }), error => error === failure)
  assert.deepEqual(await withLocalStartGuard(home, async () => 'retried'), { status: 'started', value: 'retried' })
})

boundedTest('an absent launcher delegates and returns the callback result', async t => {
  const home = await createHome(t)
  let calls = 0
  const result = await withLocalStartGuard(home, async () => {
    calls += 1
    return 'started'
  })
  assert.deepEqual(result, { status: 'started', value: 'started' })
  assert.equal(calls, 1)
})

boundedTest('invalid home errors propagate unchanged', async () => {
  await assert.rejects(withLocalStartGuard(null, async () => {}), TypeError)
})

boundedTest('unexpected startup named-pipe errors propagate unchanged', async t => {
  const home = await createHome(t)
  const failure = Object.assign(new Error('synthetic pipe permission failure'), { code: 'EACCES' })
  const createServer = net.createServer
  net.createServer = () => {
    const server = new EventEmitter()
    server.listen = () => { queueMicrotask(() => server.emit('error', failure)); return server }
    server.close = () => server
    return server
  }
  try {
    await assert.rejects(withLocalStartGuard(home, async () => {}), error => error === failure)
  } finally {
    net.createServer = createServer
  }
})

boundedTest('unexpected launcher-probe errors propagate and release the startup reservation', async t => {
  const home = await createHome(t)
  const failure = Object.assign(new Error('synthetic launcher probe failure'), { code: 'EACCES' })
  const createServer = net.createServer
  let created = 0
  let closed = 0
  net.createServer = () => {
    const server = new EventEmitter()
    created += 1
    const isProbe = created === 2
    server.listen = (_address, callback) => {
      if (isProbe) queueMicrotask(() => server.emit('error', failure))
      else queueMicrotask(callback)
      return server
    }
    server.close = callback => { closed += 1; queueMicrotask(callback); return server }
    return server
  }
  let callbackCalled = false
  try {
    await assert.rejects(withLocalStartGuard(home, async () => { callbackCalled = true }), error => error === failure)
    assert.equal(callbackCalled, false)
    assert.equal(created, 2)
    assert.equal(closed, 1)
  } finally {
    net.createServer = createServer
  }
})
