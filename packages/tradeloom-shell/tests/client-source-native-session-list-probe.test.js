import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { runInNewContext } from 'node:vm'
import test from 'node:test'
import { createGatewayFixture } from '../../../apps/tradeloom-launcher/tests/session-list-failure-phase.test.mjs'

const sourcePath = resolve(process.cwd(), 'packages/tradeloom-shell/client.source-native.js')
const descriptor = { kind: 'role', roleId: 'fixture-role', bindingRevision: '1', sceneId: 'fixture-scene', panelId: 'fixture-panel', sessionId: 'fixture-session-id', surface: 'files', generation: 7 }
const turn = () => new Promise(resolveTurn => setTimeout(resolveTurn, 0))
const deferred = () => {
  let resolvePromise, rejectPromise
  const promise = new Promise((resolveValue, rejectValue) => { resolvePromise = resolveValue; rejectPromise = rejectValue })
  return { promise, resolve: resolvePromise, reject: rejectPromise }
}

export async function mountSourceNative({ refresh = async () => {}, onRefresh, remoteList = async () => ({ ok: true, value: { items: [] } }), catalogPhase = 'pending', catalogIds = [], gatewayApi, initialDescriptor = descriptor } = {}) {
  let definition, Component
  const effects = [], cleanups = [], messages = [], stateUpdates = [], refs = []
  let retainCount = 0, remoteListCount = 0
  const React = {
    Fragment: 'fragment',
    createElement: (...args) => ({ args }),
    useState: initial => [initial, value => stateUpdates.push(value)],
    useRef: current => { const ref = { current }; refs.push(ref); return ref },
    useCallback: fn => fn,
    useSyncExternalStore: (_subscribe, getSnapshot) => getSnapshot(),
    useEffect: effect => effects.push(effect)
  }
  const sandbox = {
    window: { __ModuleLoader__: { load: value => { definition = value } } },
    console: { info: (...parts) => messages.push(parts.map(String).join(' ')) },
    AbortController
  }
  runInNewContext(await readFile(sourcePath, 'utf8'), sandbox, { filename: sourcePath })
  assert.equal(typeof definition?.factory, 'function')
  const api = definition.factory(name => {
    if (name === 'react') return React
    if (name === '@deepseek-ai/dsh-api-gateway/client') return gatewayApi
    assert.fail(`unexpected ModuleLoader dependency: ${name}`)
  })
  const snapshot = { ids: catalogIds, byId: {}, phase: catalogPhase, projectionsBySession: {} }
  const ctx = {
    slots: {
      inject: (_slot, callback) => callback(),
      register: (definition, component) => { if (definition.name === 'tradeloom.role.surface') Component = component; return component },
      registerFactory: () => () => {},
      snapshot: () => [],
      subscribeFactory: () => () => {},
      getFactoryVersion: () => 0,
      hostFace: () => ({ subscribeFactory: () => () => {}, getFactoryVersion: () => 0, factoryOf: () => undefined })
    },
    layout: { selectPanel: () => {} },
    sessions: {
      list: { getSnapshot: () => snapshot, subscribe: () => () => {} },
      refresh: async (...args) => { await refresh(...args); await onRefresh?.(snapshot); return snapshot },
      retain: () => {
        retainCount++
        if (snapshot.phase === 'ready') return { ready: Promise.resolve(), release() {} }
        throw new Error('retain must not run while catalog is pending')
      }
    },
    get: name => name === 'connection'
      ? { generation: { getSnapshot: () => 1, subscribe: () => () => {} }, interactions: 'answer' }
      : undefined,
    remote: { session: { list: (...args) => { remoteListCount++; return remoteList(...args) } } }
  }
  const bridge = {
      nativeSurfaceDescriptor: async () => initialDescriptor,
    onNativeSurfaceChanged: () => () => {},
    nativeSurfaceMounted: async () => {}
  }
  api.register(ctx, initialDescriptor, bridge)
  assert.equal(typeof Component, 'function')
  Component({ SessionProvider: () => null, renderFactorySlot: () => null })
  for (const effect of effects) {
    const cleanup = effect()
    if (typeof cleanup === 'function') cleanups.push(cleanup)
  }
  return {
    messages,
    refs,
    stateUpdates,
    get remoteListCount() { return remoteListCount },
    get retainCount() { return retainCount },
    cleanup: () => { for (const fn of cleanups.reverse()) fn() }
  }
}

test('real SourceNative effect runs one non-blocking independent list probe after a pending refresh', async () => {
  const gate = deferred()
  const mounted = await mountSourceNative({ remoteList: () => gate.promise })
  await turn()
  assert.equal(mounted.remoteListCount, 1, 'the pending post-retry path starts exactly one independent request')
  assert.ok(mounted.messages.some(message => message.includes('catalog-not-ready')), 'the original catalog phase remains unchanged')
  assert.ok(mounted.messages.some(message => message.includes('terminal-error')), 'the original terminal failure still occurs without waiting')
  assert.equal(mounted.retainCount, 0, 'pending catalog never reaches retain')
  assert.ok(mounted.stateUpdates.some(value => value?.phase === 'error'), 'the original UI error remains visible')
  assert.equal(mounted.stateUpdates.some(value => value?.phase === 'ready'), false, 'the probe never manufactures ready state')
  const probeCount = mounted.messages.filter(message => message.includes('TL-ROLE-GUEST-LIST-PROBE|')).length
  mounted.cleanup()
  gate.resolve({ ok: true, value: { items: [{ sessionId: 'private-fixture-id' }] } })
  await turn()
  assert.equal(mounted.messages.filter(message => message.includes('TL-ROLE-GUEST-LIST-PROBE|')).length, probeCount,
    'completion after cleanup is ignored')
})

test('SourceNative retries a pending catalog once and keeps the original retain path when it becomes ready', async () => {
  let refreshCount = 0
  const mounted = await mountSourceNative({
    refresh: async () => { refreshCount++ },
    onRefresh: snapshot => { if (refreshCount === 2) { snapshot.phase = 'ready'; snapshot.ids = [descriptor.sessionId] } }
  })
  await turn()
  await turn()
  assert.equal(refreshCount, 2, 'a pending catalog gets exactly one bounded refresh retry')
  assert.equal(mounted.retainCount, 1, 'retain runs only after the refreshed catalog reports ready')
  assert.ok(mounted.stateUpdates.some(value => value?.phase === 'ready' && value?.sessionId === descriptor.sessionId))
  assert.equal(mounted.remoteListCount, 0, 'a successful retry does not take the error diagnostic path')
  mounted.cleanup()
})

test('SourceNative preserves terminal error and diagnostic when the bounded retry remains pending', async () => {
  let refreshCount = 0
  const mounted = await mountSourceNative({ refresh: async () => { refreshCount++ } })
  await turn()
  await turn()
  assert.equal(refreshCount, 2, 'the retry is bounded to one additional refresh')
  assert.equal(mounted.retainCount, 0, 'a still-pending catalog never reaches retain')
  assert.equal(mounted.remoteListCount, 1, 'existing independent diagnostic still runs after the retry fails')
  assert.ok(mounted.messages.some(message => message.includes('catalog-not-ready')))
  assert.ok(mounted.messages.some(message => message.includes('terminal-error')))
  assert.ok(mounted.stateUpdates.some(value => value?.phase === 'error'))
  mounted.cleanup()
})

test('SourceNative reports the phase from the same Gateway factory error object', async () => {
  const rpcError = new Error('fixture gateway call rejection')
  const gateway = await createGatewayFixture({ rpcCall: async () => { throw rpcError } })
  const mounted = await mountSourceNative({
    gatewayApi: gateway.api,
    remoteList: async () => (await gateway.invokeList()).result
  })
  await turn()
  await turn()
  const probe = mounted.messages.find(message => message.startsWith('TL-ROLE-GUEST-LIST-PROBE|'))
  assert.equal(mounted.remoteListCount, 1, 'diagnostic still makes one independent request')
  assert.equal(probe, `TL-ROLE-GUEST-LIST-PROBE|guest-list-after-refresh-v2|result-error|gateway/internal|rpc-call|files|${descriptor.generation}`)
  assert.equal(mounted.retainCount, 0, 'phase reporting does not alter catalog ownership')
  mounted.cleanup()
})

test('SourceNative leaves cross-factory and cloned Gateway errors unclassified', async () => {
  const producer = await createGatewayFixture({ rpcCall: async () => { throw new Error('private carrier fixture') } })
  const otherFactory = await createGatewayFixture()
  const crossFactory = await mountSourceNative({
    gatewayApi: otherFactory.api,
    remoteList: async () => (await producer.invokeList()).result
  })
  await turn()
  const crossFactoryProbe = crossFactory.messages.find(message => message.startsWith('TL-ROLE-GUEST-LIST-PROBE|'))
  assert.ok(crossFactoryProbe?.includes('|gateway/internal|unclassified|'))
  assert.equal(crossFactory.remoteListCount, 1)
  crossFactory.cleanup()

  const cloneFactory = await createGatewayFixture({ rpcCall: async () => { throw new Error('private carrier fixture') } })
  const cloned = await mountSourceNative({
    gatewayApi: cloneFactory.api,
    remoteList: async () => {
      const result = (await cloneFactory.invokeList()).result
      return result.ok ? result : { ...result, error: { ...result.error } }
    }
  })
  await turn()
  const clonedProbe = cloned.messages.find(message => message.startsWith('TL-ROLE-GUEST-LIST-PROBE|'))
  assert.ok(clonedProbe?.includes('|gateway/internal|unclassified|'))
  assert.equal(cloned.remoteListCount, 1)
  cloned.cleanup()
})

test('ready catalog keeps the original retain path and does not probe', async () => {
  let refreshCount = 0
  const mounted = await mountSourceNative({
    catalogPhase: 'ready',
    catalogIds: [descriptor.sessionId],
    refresh: async () => { refreshCount++ }
  })
  await turn()
  assert.equal(refreshCount, 0, 'the already-ready catalog does not refresh')
  assert.equal(mounted.remoteListCount, 0, 'the independent diagnostic is only used for a non-ready catalog')
  assert.equal(mounted.retainCount, 1, 'the existing retain path is preserved')
  assert.ok(mounted.stateUpdates.some(value => value?.phase === 'ready' && value?.sessionId === descriptor.sessionId),
    'the original session readiness path reaches ready')
  assert.equal(mounted.messages.some(message => message.includes('TL-ROLE-GUEST-LIST-PROBE|')), false)
  mounted.cleanup()
})

test('real SourceNative effect classifies result and thrown errors without logging their payload', async () => {
  const cases = [
    { remoteList: async () => ({ ok: true, value: { items: [{ sessionId: 'private-fixture-id' }] } }), outcome: 'ok', code: 'none', reasonHint: 'none' },
    { remoteList: async () => ({ ok: false, error: { isDSHRemoteError: true, code: 'FIXTURE_REMOTE_CODE', message: 'private fixture text' } }), outcome: 'result-error', code: 'FIXTURE_REMOTE_CODE', reasonHint: 'unclassified' },
    { remoteList: async () => ({ ok: false, error: { isDSHRemoteError: true, code: 'gateway/internal', message: 'client api: Remote method PRIVATE_METHOD is no longer mounted' } }), outcome: 'result-error', code: 'gateway/internal', reasonHint: 'unclassified' },
    { remoteList: async () => ({ ok: false, error: { isDSHRemoteError: true, code: 'gateway/internal', message: 'client api: PRIVATE_ENDPOINT failed: private fixture text' } }), outcome: 'result-error', code: 'gateway/internal', reasonHint: 'unclassified' },
    { remoteList: async () => ({ ok: false, error: { isDSHRemoteError: true, code: 'gateway/internal', message: 'different internal error private fixture text' } }), outcome: 'result-error', code: 'gateway/internal', reasonHint: 'unclassified' },
    { remoteList: async () => ({ ok: false, error: { isDSHRemoteError: true, code: 'gateway/internal', message: 17 } }), outcome: 'result-error', code: 'gateway/internal', reasonHint: 'unclassified' },
    { remoteList: async () => ({ ok: false, error: { isDSHRemoteError: false, code: 'gateway/internal', message: 'client api: PRIVATE_ENDPOINT failed: private fixture text' } }), outcome: 'result-error', code: 'unknown', reasonHint: 'unclassified' },
    { remoteList: async () => { throw { isDSHRemoteError: true, code: 'FIXTURE_THROW_CODE', message: 'private fixture text' } }, outcome: 'throw', code: 'FIXTURE_THROW_CODE', reasonHint: 'unclassified' },
    { remoteList: async () => { throw { isDSHRemoteError: true, code: 'gateway/cancelled', message: 'client api: Remote method PRIVATE_METHOD is no longer mounted' } }, outcome: 'throw', code: 'gateway/cancelled', reasonHint: 'unclassified' },
    { remoteList: async () => ({ ok: false, error: { isDSHRemoteError: true, code: 'bad|code' } }), outcome: 'result-error', code: 'unknown', reasonHint: 'unclassified' },
    { remoteList: async () => ({ ok: false, error: { isDSHRemoteError: true, code: 'gateway//internal' } }), outcome: 'result-error', code: 'unknown', reasonHint: 'unclassified' },
    { remoteList: async () => ({ ok: false, error: { isDSHRemoteError: true, code: '/gateway/internal' } }), outcome: 'result-error', code: 'unknown', reasonHint: 'unclassified' },
    { remoteList: async () => ({ ok: false, error: { isDSHRemoteError: true, code: 'gateway/internal/' } }), outcome: 'result-error', code: 'unknown', reasonHint: 'unclassified' },
    { remoteList: async () => ({ ok: false, error: { isDSHRemoteError: true, code: 'bad code with spaces' } }), outcome: 'result-error', code: 'unknown', reasonHint: 'unclassified' },
    { remoteList: async () => ({ ok: false, error: { isDSHRemoteError: true, code: 'gateway/internal\n' } }), outcome: 'result-error', code: 'unknown', reasonHint: 'unclassified' },
    { remoteList: async () => ({ ok: false, error: { isDSHRemoteError: true, code: 'gateway/internal\r\n' } }), outcome: 'result-error', code: 'unknown', reasonHint: 'unclassified' },
    { remoteList: async () => ({ ok: false, error: { isDSHRemoteError: true, code: 'a'.repeat(63) + '/b' } }), outcome: 'result-error', code: 'unknown', reasonHint: 'unclassified' },
    { remoteList: async () => ({ ok: false, error: { isDSHRemoteError: true, code: 'none' } }), outcome: 'result-error', code: 'unknown', reasonHint: 'unclassified' },
    { remoteList: async () => ({ ok: false, error: { isDSHRemoteError: true, code: 'a'.repeat(62) + '/b' } }), outcome: 'result-error', code: 'a'.repeat(62) + '/b', reasonHint: 'unclassified' },
    { remoteList: async () => ({ ok: false, error: { code: 'FIXTURE_UNBRANDED_CODE', message: 'client api: session.list failed: private fixture text' } }), outcome: 'result-error', code: 'unknown', reasonHint: 'unclassified' },
    { remoteList: async () => ({ ok: false, error: { code: 'gateway/internal', message: 'client api: PRIVATE_ENDPOINT failed: private fixture text' } }), outcome: 'result-error', code: 'unknown', reasonHint: 'unclassified' }
  ]
  for (const entry of cases) {
    const mounted = await mountSourceNative(entry)
    await turn()
    const probe = mounted.messages.find(message => message.includes('TL-ROLE-GUEST-LIST-PROBE|'))
    assert.ok(probe, 'probe event is emitted for the independent request result')
    assert.deepEqual(probe.split('|'), ['TL-ROLE-GUEST-LIST-PROBE', 'guest-list-after-refresh-v2', entry.outcome, entry.code, entry.reasonHint, 'files', '7'])
    assert.ok(!probe.includes('private fixture text'))
    assert.ok(!probe.includes('PRIVATE_METHOD'))
    assert.ok(!probe.includes('PRIVATE_ENDPOINT'))
    assert.ok(!probe.includes('fixture-session-id'))
    assert.equal(mounted.retainCount, 0)
    mounted.cleanup()
  }
})

test('cleanup before refresh settles prevents probe dispatch', async () => {
  const refreshGate = deferred()
  const mounted = await mountSourceNative({ refresh: () => refreshGate.promise })
  mounted.cleanup()
  refreshGate.resolve()
  await turn()
  assert.equal(mounted.remoteListCount, 0)
  assert.equal(mounted.messages.some(message => message.includes('TL-ROLE-GUEST-LIST-PROBE|')), false)
})

test('descriptor change discards a late independent probe result', async () => {
  const gate = deferred()
  const mounted = await mountSourceNative({ remoteList: () => gate.promise })
  await turn()
  assert.equal(mounted.remoteListCount, 1)
  mounted.refs[0].current = { ...descriptor, generation: 8 }
  gate.resolve({ ok: true, value: { items: [] } })
  await turn()
  assert.equal(mounted.messages.some(message => message.includes('TL-ROLE-GUEST-LIST-PROBE|')), false)
  mounted.cleanup()
})
