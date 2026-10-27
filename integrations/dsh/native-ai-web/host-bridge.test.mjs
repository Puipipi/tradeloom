import test from 'node:test'
import assert from 'node:assert/strict'
import { fork } from 'node:child_process'
import { once } from 'node:events'
import { EventEmitter } from 'node:events'
import { createHostAiWebBridge, createChildAiWebAskClient, childProcessChannel } from './host-bridge.ts'

const fixture = new URL('./host-bridge.child-fixture.mjs', import.meta.url)
const result = (provider, text) => ({
  provider, origin: `https://${provider === 'deepseek' ? 'chat.deepseek.com' : 'www.doubao.com'}`,
  turnId: `turn-${text}`, text, answerMessageId: `answer-${text}`, firstChunkAt: 1, completedAt: 2,
})
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
function fixtureMessage(child, fixtureName) {
  return new Promise((resolve, reject) => {
    const onMessage = message => {
      if (message?.fixture === fixtureName) { cleanup(); resolve(message) }
    }
    const onExit = code => { cleanup(); reject(new Error(`fixture exited before ${fixtureName}: ${code}`)) }
    const cleanup = () => { child.off('message', onMessage); child.off('exit', onExit) }
    child.on('message', onMessage); child.on('exit', onExit)
  })
}

function start(mode, ask) {
  const child = fork(fixture, [mode], { execArgv: ['--experimental-strip-types'], stdio: ['ignore', 'ignore', 'pipe', 'ipc'] })
  let stderr = ''
  child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk })
  const bridge = createHostAiWebBridge({
    channel: childProcessChannel(child),
    ask: async (provider, question, signal) => {
      if (question === 'cancel me' || question === 'exit pending') {
        await new Promise((resolve, reject) => {
          if (signal.aborted) { reject(Object.assign(new Error(), { code: 'cancelled' })); return }
          signal.addEventListener('abort', () => reject(Object.assign(new Error(), { code: 'cancelled' })), { once: true })
        })
      }
      return ask ? ask(provider, question, signal) : result(provider, question)
    },
  })
  return { child, bridge, stderr: () => stderr }
}

test('real child IPC correlates two simultaneous provider requests without cross-talk', async t => {
  const { child, bridge, stderr } = start('correlate', async (provider, question) => {
    await delay(question === 'slow request' ? 60 : 5)
    return result(provider, question)
  })
  t.after(() => { bridge.close(); child.kill() })
  const message = await fixtureMessage(child, 'correlate')
  assert.equal(stderr(), '')
  assert.deepEqual(message, { fixture: 'correlate', texts: ['slow request', 'fast request'] })
})

test('real child IPC cancellation aborts the parent request', async t => {
  const { child, bridge, stderr } = start('cancel')
  t.after(() => { bridge.close(); child.kill() })
  const message = await fixtureMessage(child, 'cancel')
  assert.equal(stderr(), '')
  assert.deepEqual(message, { fixture: 'cancel', result: 'cancelled' })
  assert.equal(bridge.pendingCount, 0)
})

test('child disconnect aborts and clears its owned pending work', async t => {
  const { child, bridge } = start('exit-pending')
  t.after(() => bridge.close())
  await fixtureMessage(child, 'pending')
  await once(child, 'exit')
  await delay(0)
  assert.equal(bridge.pendingCount, 0)
})

test('parent rejects non-exact or out-of-allowlist requests and ignores unrelated control messages', async () => {
  const bus = new EventEmitter()
  const outgoing = []
  let callCount = 0
  const channel = {
    subscribe(listener) { bus.on('message', listener); return () => bus.off('message', listener) },
    onDisconnect(listener) { bus.on('disconnect', listener); return () => bus.off('disconnect', listener) },
    send(message) { outgoing.push(message); return Promise.resolve(true) },
  }
  const bridge = createHostAiWebBridge({ channel, ask: async (provider, question) => { callCount++; return result(provider, question) } })
  bus.emit('message', { type: 'ready' })
  bus.emit('message', { type: 'ai-web-ask', requestId: 1, provider: 'doubao', question: 'x', url: 'https://example.invalid' })
  bus.emit('message', { type: 'ai-web-ask', requestId: 2, provider: 'arbitrary', question: 'x' })
  await delay(0)
  assert.equal(callCount, 0)
  assert.deepEqual(outgoing.map(message => [message.requestId, message.errorCode]), [[1, 'invalid-request'], [2, 'invalid-request']])
  bridge.close()
})

test('synchronous ask failure is contained and a later request succeeds', async () => {
  const bus = new EventEmitter()
  const outgoing = []
  const channel = {
    subscribe(listener) { bus.on('message', listener); return () => bus.off('message', listener) },
    onDisconnect(listener) { bus.on('disconnect', listener); return () => bus.off('disconnect', listener) },
    send(message) { outgoing.push(message); return Promise.resolve(true) },
  }
  const bridge = createHostAiWebBridge({
    channel,
    ask(provider, question) {
      if (question === 'throw') throw new Error('private error text')
      return Promise.resolve(result(provider, question))
    },
  })
  bus.emit('message', { type: 'ai-web-ask', requestId: 11, provider: 'deepseek', question: 'throw' })
  bus.emit('message', { type: 'ai-web-ask', requestId: 12, provider: 'doubao', question: 'recover' })
  await delay(0)
  assert.deepEqual(outgoing.map(message => [message.requestId, message.ok, message.errorCode]), [
    [11, false, 'adapter-failed'], [12, true, undefined],
  ])
  assert.equal(JSON.stringify(outgoing).includes('private error text'), false)
  bridge.close()
})

test('already-closed owner prevents subscription and ask execution', () => {
  const owner = new AbortController()
  owner.abort()
  let subscriptions = 0
  let asks = 0
  const bridge = createHostAiWebBridge({
    ownerClosed: owner.signal,
    channel: {
      subscribe() { subscriptions++; return () => undefined },
      onDisconnect() { subscriptions++; return () => undefined },
      send: async () => true,
    },
    ask: async () => { asks++; return result('deepseek', 'unexpected') },
  })
  assert.equal(subscriptions, 0)
  assert.equal(asks, 0)
  assert.equal(bridge.pendingCount, 0)
})

test('cancel wins against an adapter that later resolves successfully', async () => {
  const bus = new EventEmitter()
  const outgoing = []
  let complete
  const channel = {
    subscribe(listener) { bus.on('message', listener); return () => bus.off('message', listener) },
    onDisconnect(listener) { bus.on('disconnect', listener); return () => bus.off('disconnect', listener) },
    send(message) { outgoing.push(message); return Promise.resolve(true) },
  }
  const bridge = createHostAiWebBridge({ channel, ask: () => new Promise(resolve => { complete = resolve }) })
  bus.emit('message', { type: 'ai-web-ask', requestId: 13, provider: 'deepseek', question: 'race' })
  await delay(0)
  bus.emit('message', { type: 'ai-web-ask-cancel', requestId: 13 })
  await delay(0)
  complete(result('deepseek', 'late success'))
  await delay(0)
  assert.deepEqual(outgoing.map(message => [message.ok, message.errorCode]), [[false, 'cancelled']])
  bridge.close()
})

test('invalid child result cleans up abort listener and late duplicate cannot steal a later result', async () => {
  const bus = new EventEmitter()
  const sent = []
  const channel = {
    connected: true,
    send(message, callback) { sent.push(message); callback(null) },
    on: bus.on.bind(bus), off: bus.off.bind(bus),
  }
  const client = createChildAiWebAskClient(channel)
  const abort = new AbortController()
  const first = client.ask('deepseek', 'first', abort.signal)
  await delay(0)
  bus.emit('message', { type: 'ai-web-ask-result', requestId: 1, ok: true, result: { ...result('deepseek', 'bad'), origin: 'https://untrusted.example' } })
  await assert.rejects(first, /adapter-failed/)
  abort.abort()
  assert.deepEqual(sent.map(message => message.type), ['ai-web-ask'])
  bus.emit('message', { type: 'ai-web-ask-result', requestId: 1, ok: true, result: result('deepseek', 'late duplicate') })
  const second = client.ask('doubao', 'second')
  await delay(0)
  bus.emit('message', { type: 'ai-web-ask-result', requestId: 2, ok: true, result: result('doubao', 'second') })
  assert.equal((await second).text, 'second')
  client.close()
})

test('real IPC rejects a completed request ID replay without invoking ask again', async t => {
  let calls = 0
  const { child, bridge } = start('duplicate-completed', async (provider, question) => {
    calls++
    return result(provider, question)
  })
  t.after(() => { bridge.close(); child.kill() })
  const message = await fixtureMessage(child, 'duplicate-completed')
  assert.deepEqual(message, { fixture: 'duplicate-completed', firstOk: true, duplicateError: 'invalid-request' })
  assert.equal(calls, 1)
})

test('real IPC active duplicate settles once even when ask ignores abort and later succeeds', async t => {
  const { child, bridge } = start('duplicate-active', (provider, question) => new Promise(resolve => {
    setTimeout(() => resolve(result(provider, question)), 100)
  }))
  t.after(() => { bridge.close(); child.kill() })
  const message = await fixtureMessage(child, 'duplicate-active')
  assert.deepEqual(message, { fixture: 'duplicate-active', ok: false, errorCode: 'invalid-request', resultCount: 1 })
})

