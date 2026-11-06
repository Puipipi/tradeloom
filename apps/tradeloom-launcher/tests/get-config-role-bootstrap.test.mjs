import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { runInNewContext } from 'node:vm'

const mainPath = new URL('../accepted-runtime/lib/main.js', import.meta.url)
const source = await readFile(mainPath, 'utf8')
const startMarker = '/* source-shell: role bootstrap loader begin */'
const endMarker = '/* source-shell: role bootstrap loader end */'
const start = source.indexOf(startMarker)
const end = source.indexOf(endMarker, start)
assert.notEqual(start, -1, 'production role bootstrap loader start marker exists')
assert.notEqual(end, -1, 'production role bootstrap loader end marker exists')
const productionFactorySource = source.slice(start + startMarker.length, end)
const createLoader = runInNewContext(`${productionFactorySource}\ncreateSourceSceneConfigLoader`)

const baseConfig = () => ({
  roles: [{ id: 'center' }, { id: 'product' }, { id: 'unused' }],
  scenes: [
    { id: 'overview', roleId: 'center', panels: [
      { id: 'chat', type: 'native-chat' },
      { id: 'product-chat', type: 'native-chat', roleId: 'product' },
      { id: 'workspace', type: 'native-workspace', roleId: 'unused' },
      { id: 'business', type: 'business', roleId: 'unused' },
    ] },
    { id: 'other', roleId: 'center', panels: [{ id: 'chat', type: 'native-chat' }] },
  ],
  sessionBindings: {},
})

function setup(request, identity = { host: 'host-a', url: 'http://127.0.0.1:3088', cookie: 'opaque-a' }) {
  let currentIdentity = identity
  const fail = (message, code) => Object.assign(new Error(message), { code })
  return {
    load: createLoader(request, () => currentIdentity, fail),
    setIdentity(value) { currentIdentity = value },
  }
}

test('missing native-chat bindings POST once per unique configured role, then returns refreshed scenes', async () => {
  const calls = [], first = baseConfig(), refreshed = baseConfig()
  refreshed.sessionBindings = { center: 'session-center', product: 'session-product' }
  const h = setup(async (path, body) => {
    calls.push([path, body])
    if (path === '/tradeloom/scenes') return calls.filter(([item]) => item === path).length === 1 ? first : refreshed
    if (path === '/tradeloom/session') return { role: body.role, sessionId: `session-${body.role}` }
    throw new Error(`unexpected path ${path}`)
  })
  assert.equal(await h.load(), refreshed)
  assert.deepEqual(JSON.parse(JSON.stringify(calls)), [
    ['/tradeloom/scenes', null],
    ['/tradeloom/session', { role: 'center' }],
    ['/tradeloom/session', { role: 'product' }],
    ['/tradeloom/scenes', null],
  ])
})

test('existing native-chat bindings require no POST; non-native panels are ignored', async () => {
  const calls = [], config = baseConfig()
  config.sessionBindings = { center: 'session-center', product: 'session-product' }
  const h = setup(async (path, body) => { calls.push([path, body]); return config })
  assert.equal(await h.load(), config)
  assert.deepEqual(JSON.parse(JSON.stringify(calls)), [['/tradeloom/scenes', null]])
})

test('invalid native-chat role mapping fails closed before any session request', async () => {
  const calls = [], config = baseConfig()
  config.scenes[0].panels[0].roleId = 'not-configured'
  const h = setup(async (path, body) => { calls.push([path, body]); return config })
  await assert.rejects(h.load(), error => error.code === 'SCENE_ROLE_INVALID')
  assert.deepEqual(JSON.parse(JSON.stringify(calls)), [['/tradeloom/scenes', null]])
})

test('Host session rejection propagates and never returns the stale unbound config', async () => {
  const calls = [], config = baseConfig(), original = Object.assign(new Error('Host request failed'), { code: 'HOST_HTTP_ERROR', httpStatus: 503 })
  const h = setup(async (path, body) => {
    calls.push([path, body])
    if (path === '/tradeloom/scenes') return config
    throw original
  })
  await assert.rejects(h.load(), error => error === original)
  assert.deepEqual(JSON.parse(JSON.stringify(calls)), [['/tradeloom/scenes', null], ['/tradeloom/session', { role: 'center' }]])
})

test('successful POST without a published GET binding fails, then a later call can retry', async () => {
  const calls = [], unbound = baseConfig(), bound = baseConfig()
  bound.sessionBindings = { center: 'session-center', product: 'session-product' }
  let getCount = 0
  const h = setup(async (path, body) => {
    calls.push([path, body])
    if (path === '/tradeloom/scenes') {
      getCount++
      return getCount < 4 ? unbound : bound
    }
    if (path === '/tradeloom/session') return { role: body.role, sessionId: `session-${body.role}` }
    throw new Error(`unexpected path ${path}`)
  })
  await assert.rejects(h.load(), error => error.code === 'ROLE_BINDING_UNAVAILABLE')
  assert.equal(await h.load(), bound)
  assert.equal(calls.filter(([path]) => path === '/tradeloom/session').length, 4)
  assert.equal(calls.filter(([path]) => path === '/tradeloom/scenes').length, 4)
})

test('concurrent requests coalesce only for the same Host tuple', async () => {
  const gates = new Map(), calls = [], config = baseConfig()
  config.sessionBindings = { center: 'session-center', product: 'session-product' }
  const request = (path, body) => {
    calls.push([path, body])
    if (path !== '/tradeloom/scenes') return Promise.resolve({ role: body.role, sessionId: `session-${body.role}` })
    const key = currentIdentity.host
    if (!gates.has(key)) {
      let resolve
      const promise = new Promise(yes => { resolve = yes })
      gates.set(key, { promise, resolve })
    }
    return gates.get(key).promise
  }
  let currentIdentity = { host: 'host-a', url: 'http://a', cookie: 'cookie-a' }
  const fail = (message, code) => Object.assign(new Error(message), { code })
  const load = createLoader(request, () => currentIdentity, fail)
  const a1 = load(), a2 = load()
  currentIdentity = { host: 'host-b', url: 'http://b', cookie: 'cookie-b' }
  const b1 = load()
  assert.equal(calls.length, 2)
  assert.equal(calls[0][0], '/tradeloom/scenes')
  assert.equal(calls[1][0], '/tradeloom/scenes')
  gates.get('host-a').resolve(config)
  gates.get('host-b').resolve(config)
  await assert.rejects(Promise.all([a1, a2]), error => error.code === 'HOST_CHANGED')
  assert.equal(await b1, config)
  assert.equal(calls.filter(([path]) => path === '/tradeloom/scenes').length, 2)
})

test('Host identity change between GET and POST aborts without using the new Host', async () => {
  const calls = [], h = setup(async (path, body) => {
    calls.push([path, body])
    return baseConfig()
  })
  const pending = h.load()
  h.setIdentity({ host: 'host-b', url: 'http://b', cookie: 'cookie-b' })
  await assert.rejects(pending, error => error.code === 'HOST_CHANGED')
  assert.deepEqual(calls, [['/tradeloom/scenes', undefined]])
})
