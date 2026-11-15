import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { test } from 'node:test'
import { fork } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { runInNewContext } from 'node:vm'
import { createHash, webcrypto } from 'node:crypto'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createSurfaceOwner } from '../accepted-runtime/lib/tradeloom-source-shell/surface-owner.mjs'
import { installBrowserTransportAdapter } from '../production-origin/browser-transport-adapter.mjs'
import { registerBusinessTools } from '../../../packages/tradeloom-shell/business-tools.js'
import { createExecutionOriginAuthority } from '../../../packages/tradeloom-shell/execution-origin-authority.js'
import { apply as applyBusinessShellHost, createHostOriginAccessors, createSourceShellBindingHandler } from '../../../packages/tradeloom-shell/host.js'
import { createStateStore, getRoleBindingRevision, HOME_MARKER, HOME_MARKER_VALUE, replaceRoleBinding, roleWorkspacePath } from '../../../packages/tradeloom-shell/state.js'

const privateRoot = resolve(process.env.N01_PRIVATE_TEST_ROOT ?? '')
if (!process.env.N01_PRIVATE_TEST_ROOT || privateRoot === resolve('.')) throw new Error('N01_PRIVATE_TEST_ROOT must point inside the private checkpoint marker')

async function fixture(t, options = {}) {
  const root = await mkdtemp(join(privateRoot, 'origin-chain-test-'))
  const home = join(root, 'home')
  await mkdir(home)
  await writeFile(join(home, HOME_MARKER), HOME_MARKER_VALUE)
  const env = { ...process.env, TRADELOOM_DSH_APP_HOME: home, DSH_HOME: home }
  const stateStore = await createStateStore({ env })
  await stateStore.transact(state => {
    replaceRoleBinding(state, 'center', {
      sessionId: 'session-a', workspaceId: 'workspace-a', workspacePath: join(home, 'workspace-a'), agentPreset: 'tradeloom-center',
    })
  })
  t.after(async () => {
    const target = resolve(root)
    if (!target.startsWith(`${privateRoot}${sep}`)) throw new Error('refusing to clean a path outside N01 private marker')
    await rm(target, { recursive: true, force: true })
  })
  return { root, home, stateStore, env }
}

function issuer(home) {
  return {
    scope: 'role', guestId: 17, generation: 4, sceneId: 'scene-a', panelId: 'panel-a', roleId: 'center',
    sessionId: 'session-a', workspaceId: 'workspace-a', workspacePath: join(home, 'workspace-a'),
    agentPreset: 'tradeloom-center', bindingRevision: '1',
  }
}

async function claim(authority, home, endpoint = 'agent/send', body = Buffer.from('{"payload":{"text":"hello"}}'), rpcId = 'rpc-1') {
  const grant = await authority.registerGrant({ issuer: issuer(home), bodyBytes: body, endpoint, httpMethod: 'POST' })
  const origin = await authority.verifyRequest({
    token: grant.token, endpoint, httpMethod: 'POST', method: endpoint, rpcId, bodyBytes: body,
    bodyDigest: createHash('sha256').update(body).digest('hex'), peerId: 'browser-owner', peerPrincipal: 'owner',
  })
  return { grant, origin, body }
}

test('business consumer registers owner-bound tools and refuses missing proof without fallback', async () => {
  const registered = new Map()
  registerBusinessTools({ tools: { register(tool) { registered.set(tool.name, tool); return () => {} } } }, { preset: 'tradeloom-center' }, {
    sceneMemoryOriginAuthority: { async transactSceneMemory() { throw new Error('must not run without proof') } },
  })
  assert.ok(registered.has('tradeloom_scene_memory_read'))
  assert.ok(registered.has('tradeloom_scene_memory_write'))
  const result = await registered.get('tradeloom_scene_memory_read').execute({ scene_id: 'scene-a' }, { agent: { id: 'session-a' } })
  assert.equal(result.ok, false)
  assert.equal(result.error_code, 'scene_memory_origin_required')
})

test('Host lazy authority preserves first proofless RPC, driver, and ordinary tools before any grant', async t => {
  const f = await fixture(t)
  const authority = createExecutionOriginAuthority({ stateStore: f.stateStore, isSessionLive: () => true, isSessionDurable: async () => true })
  let resolved
  const access = createHostOriginAccessors(async () => authority, () => resolved)
  assert.equal(access.captureAtEnqueue(), undefined)
  assert.equal(await access.withProoflessRequestOrigin(async () => 'rpc-ok'), 'rpc-ok')
  assert.equal(await access.runDetachedDriver(async () => 'driver-ok'), 'driver-ok')
  const execAgent = { id: 'session-a' }
  const execSession = { id: 'session-a', active: true }
  const execToken = { id: 'tool-token' }
  const execArgs = { scene_id: 'scene-a' }
  const ordinaryExec = { name: 'ordinary-tool', agent: execAgent, session: execSession, token: execToken, args: execArgs }
  let deliveredExec
  assert.equal(await access.runToolExecution(ordinaryExec, exec => { deliveredExec = exec; return 'tool-ok' }), 'tool-ok')
  assert.strictEqual(deliveredExec, ordinaryExec)
  assert.strictEqual(deliveredExec.agent, execAgent)
  assert.strictEqual(deliveredExec.session, execSession)
  assert.strictEqual(deliveredExec.token, execToken)
  assert.strictEqual(deliveredExec.args, execArgs)
  assert.equal(access.currentRequestOrigin(), undefined)
  assert.equal(access.currentToolExecution(), undefined)
  assert.equal(access.isProoflessExternalRequest(), false)
  assert.throws(() => access.captureAtEnqueue({ operationId: 'unresolved-proof' }), { code: 'origin_authority_not_ready' })
  assert.throws(() => access.withVerifiedRequestOrigin({}, async () => 'must-not-run'), { code: 'origin_authority_not_ready' })
  resolved = authority
  assert.equal(access.captureAtEnqueue(), undefined)
  await authority.dispose()
})

const pinnedBrowserClientPath = process.env.N01_SDK_CLIENT_BROWSER_PATH
const pinnedPatchedConnectionPath = process.env.N01_SDK_PATCH_CONNECTION_PATH
test('actual SDK rpc.call relative path uses original default fetch and optional Main grant', { skip: !pinnedBrowserClientPath }, async () => {
  const source = await readFile(pinnedBrowserClientPath, 'utf8')
  let pluginDefinition
  const sandbox = {
    window: { __ModuleLoader__: { load(definition) { pluginDefinition = definition } } },
    location: new URL('http://app/'),
    Request, Headers, Response, URL,
    crypto: webcrypto,
    fetch: undefined,
    dshDesktopBoot: undefined,
  }
  sandbox.globalThis = sandbox
  const observed = []
  sandbox.fetch = async (input, init) => {
    observed.push({ input, init })
    const request = input instanceof Request ? input : new Request(new URL(input, sandbox.location.href), init)
    const envelope = JSON.parse(await request.clone().text())
    return new Response(JSON.stringify({ type: 'server-response', rpcId: envelope.rpcId, result: { ok: true, value: 'accepted' } }), {
      status: 200, headers: { 'content-type': 'application/json' },
    })
  }
  let grantMode = 'non-role'
  let releasePendingGrant
  let pendingGrantGate
  const grantRequests = []
  sandbox.dshDesktopBoot = { async issueSceneMemoryOriginGrant(request) {
    grantRequests.push(request)
    if (grantMode === 'error') throw Object.assign(new Error('unowned frame'), { code: 'unowned_guest' })
    if (grantMode === 'pending') { await pendingGrantGate; return { token: 'pending-single-grant' } }
    return grantMode === 'role' ? { token: 'single-use-opaque-grant' } : null
  } }
  runInNewContext(source, sandbox, { filename: pinnedBrowserClientPath })
  assert.equal(pluginDefinition?.id, '@deepseek-ai/dsh-client-connection')
  const plugin = pluginDefinition.factory(() => { throw new Error('unexpected SDK import') })
  const context = { provide(name, value) { this[name] = value } }
  const transport = { ownsHost: true, streamBaseUrl: 'http://127.0.0.1:43123' }
  let adapterNow = Date.now()
  sandbox.Date = { now: () => adapterNow }
  const restore = installBrowserTransportAdapter(transport, sandbox)
  plugin.installConnection(context, { transport })
  const signal = new AbortController().signal
  const plainResult = await context.connection.rpc.call('/api', 'agent/send', { text: 'plain' }, signal)
  assert.equal(plainResult.ok, true)
  assert.equal(plainResult.value, 'accepted')
  assert.equal(observed.length, 1)
  assert.equal(observed[0].input, 'api/agent/send')
  assert.equal(observed[0].init.method, 'POST')
  assert.equal(observed[0].init.signal, signal)
  assert.equal(grantRequests.length, 1)
  assert.equal(grantRequests[0].endpoint, 'agent/send')
  assert.equal(new TextDecoder().decode(grantRequests[0].bodyBytes), observed[0].init.body)

  const nestedResult = await context.connection.rpc.call('/api', 'example/$send', { text: 'nested-channel' }, signal)
  assert.equal(nestedResult.ok, true)
  assert.equal(observed[1].input, 'api/example/$send')
  assert.equal(grantRequests[1].endpoint, 'example/$send')
  const nestedEnvelope = JSON.parse(observed[1].init.body)
  assert.equal(nestedEnvelope.method, 'example/$send')

  const longEndpoint = 'long.' + 'x'.repeat(200)
  await context.connection.rpc.call('/api', longEndpoint, { text: 'long-valid-endpoint' }, signal)
  assert.equal(observed[2].input, `api/${longEndpoint}`)
  assert.equal(grantRequests[2].endpoint, longEndpoint)
  const beforeInvalid = { observed: observed.length, grants: grantRequests.length }
  await assert.rejects(context.connection.rpc.call('/api', 'bad//endpoint', {}, signal), /invalid RPC target/)
  await assert.rejects(context.connection.rpc.call('/api', 'bad/../endpoint', {}, signal), /invalid RPC target/)
  assert.equal(observed.length, beforeInvalid.observed)
  assert.equal(grantRequests.length, beforeInvalid.grants)

  grantMode = 'role'
  const ownedResult = await context.connection.rpc.call('/api', 'agent/send', { text: 'owned' }, signal)
  assert.equal(ownedResult.ok, true)
  assert.equal(ownedResult.value, 'accepted')
  const proofRequest = observed[3].input
  assert.ok(proofRequest instanceof Request)
  assert.equal(proofRequest.url, 'http://app/api/agent/send')
  assert.equal(proofRequest.method, 'POST')
  assert.equal(proofRequest.signal.aborted, false)
  assert.equal(proofRequest.headers.get('content-type'), 'application/json')
  assert.equal(proofRequest.headers.get('x-tradeloom-origin-grant'), 'single-use-opaque-grant')
  assert.deepEqual(Buffer.from(await proofRequest.clone().arrayBuffer()), Buffer.from(grantRequests[3].bodyBytes))
  const retryResponse = await transport.fetch(proofRequest.clone())
  assert.equal(retryResponse.status, 200)
  assert.equal(grantRequests.length, 4, 'same SDK request retry must reuse the original grant')
  const retryRequest = observed.at(-1).input
  assert.equal(retryRequest.headers.get('x-tradeloom-origin-grant'), proofRequest.headers.get('x-tradeloom-origin-grant'))
  assert.equal(retryRequest.url, proofRequest.url)
  assert.deepEqual(Buffer.from(await retryRequest.clone().arrayBuffer()), Buffer.from(await proofRequest.clone().arrayBuffer()))

  grantMode = 'error'
  const callCountBeforeReject = observed.length
  await assert.rejects(context.connection.rpc.call('/api', 'agent/send', { text: 'wrong-frame' }), { code: 'unowned_guest' })
  assert.equal(observed.length, callCountBeforeReject)
  grantMode = 'pending'
  pendingGrantGate = new Promise(resolveGrant => { releasePendingGrant = resolveGrant })
  const pendingBody = Buffer.from('{"method":"agent/send","rpcId":"pending-grant-rpc","payload":{"text":"single issuance"}}')
  const pendingRequest = new Request('http://app/api/agent/send', { method: 'POST', headers: { 'content-type': 'application/json' }, body: pendingBody })
  const grantCountBeforeConcurrent = grantRequests.length
  const concurrentA = transport.fetch(pendingRequest.clone())
  const concurrentB = transport.fetch(pendingRequest.clone())
  await new Promise(resolveTick => setTimeout(resolveTick, 0))
  assert.equal(grantRequests.length, grantCountBeforeConcurrent + 1)
  releasePendingGrant()
  const [concurrentResponseA, concurrentResponseB] = await Promise.all([concurrentA, concurrentB])
  assert.equal(concurrentResponseA.status, 200)
  assert.equal(concurrentResponseB.status, 200)
  assert.equal(grantRequests.length, grantCountBeforeConcurrent + 1)
  assert.equal(observed.at(-1).input.headers.get('x-tradeloom-origin-grant'), 'pending-single-grant')
  grantMode = 'role'
  let capacityError
  for (let index = 0; index < 260; index++) {
    const body = JSON.stringify({ method: 'agent/send', rpcId: `adapter-capacity-${index}`, payload: { index } })
    try {
      await transport.fetch(new Request('http://app/api/agent/send', { method: 'POST', headers: { 'content-type': 'application/json' }, body }))
    } catch (error) {
      capacityError = error
      break
    }
  }
  assert.equal(capacityError?.code, 'origin_replay_capacity', 'the bounded adapter cache refuses new origins while unexpired tombstones fill capacity')
  const grantsAtCapacity = grantRequests.length
  adapterNow += 31_000
  await assert.rejects(transport.fetch(proofRequest.clone()), { code: 'origin_replay_expired' }, 'the old request remains a tombstone after its replay window')
  await assert.rejects(transport.fetch(new Request('http://app/api/agent/send', { method: 'POST', body: '{"method":"agent/send","rpcId":"capacity-remains-full"}' })), { code: 'origin_replay_capacity' }, 'expired replay window does not evict its still-live tombstone to remint')
  assert.equal(grantRequests.length, grantsAtCapacity, 'expired retry and capacity rejection do not issue new grants')
  adapterNow += 5 * 60_000 - 31_000 + 1
  const grantsBeforeExpiredTombstoneRetry = grantRequests.length
  await assert.rejects(transport.fetch(proofRequest.clone()), { code: 'origin_replay_expired' }, 'an old proof-bearing Request cannot be reminted after its local tombstone expires')
  assert.equal(grantRequests.length, grantsBeforeExpiredTombstoneRetry, 'expired proof-bearing retry does not ask Main for a replacement grant')
  const afterTombstoneFresh = await transport.fetch(new Request('http://app/api/agent/send', { method: 'POST', body: '{"method":"agent/send","rpcId":"fresh-after-tombstone"}' }))
  assert.equal(afterTombstoneFresh.status, 200, 'a genuinely new proofless request still receives its own grant')
  assert.equal(grantRequests.length, grantsBeforeExpiredTombstoneRetry + 1)
  restore()
  assert.equal(Object.hasOwn(transport, 'fetch'), false)
})

test('origin replay reuses the same operation only for the exact grant-bound request', async t => {
  const f = await fixture(t)
  const authority = createExecutionOriginAuthority({ stateStore: f.stateStore, isSessionLive: () => true, isSessionDurable: async () => true })
  const body = Buffer.from('{"method":"agent/send","rpcId":"rpc-1","payload":{"text":"hello"}}')
  const grant = await authority.registerGrant({ issuer: issuer(f.home), bodyBytes: body, endpoint: 'agent/send', httpMethod: 'POST' })
  await assert.rejects(authority.verifyRequest({ token: grant.token, endpoint: 'agent/send', httpMethod: 'POST', method: 'agent/send', rpcId: 'rpc-1', bodyBytes: Buffer.from('tampered'), bodyDigest: createHash('sha256').update('tampered').digest('hex'), peerId: 'browser-owner', peerPrincipal: 'owner' }), { code: 'origin_proof_mismatch' })
  const origin = await authority.verifyRequest({ token: grant.token, endpoint: 'agent/send', httpMethod: 'POST', method: 'agent/send', rpcId: 'rpc-1', bodyBytes: body, bodyDigest: createHash('sha256').update(body).digest('hex'), peerId: 'browser-owner', peerPrincipal: 'owner' })
  assert.equal(authority.captureAtEnqueue(origin), origin)
  assert.equal(origin.hostEpoch, authority.hostEpoch)
  const replayed = await authority.verifyRequest({ token: grant.token, endpoint: 'agent/send', httpMethod: 'POST', method: 'agent/send', rpcId: 'rpc-1', bodyBytes: body, bodyDigest: createHash('sha256').update(body).digest('hex'), peerId: 'browser-owner', peerPrincipal: 'owner' })
  assert.equal(replayed, origin)
  await assert.rejects(authority.verifyRequest({ token: grant.token, endpoint: 'agent/send', routePath: 'other/agent/send', httpMethod: 'POST', method: 'agent/send', rpcId: 'rpc-1', bodyBytes: body, bodyDigest: createHash('sha256').update(body).digest('hex'), peerId: 'browser-owner', peerPrincipal: 'owner' }), { code: 'origin_proof_mismatch' })
  await assert.rejects(authority.verifyRequest({ token: grant.token, endpoint: 'agent/send', httpMethod: 'POST', method: 'agent/send', rpcId: 'rpc-1', bodyBytes: body, bodyDigest: createHash('sha256').update(body).digest('hex'), peerId: 'other-peer', peerPrincipal: 'owner' }), { code: 'origin_proof_mismatch' })
  const fakeParent = { agent: { id: 'session-a', session: {} }, token: 'fake', operationOrigin: origin }
  assert.throws(() => authority.inheritFromParentExecution(fakeParent), { code: 'active_parent_execution_required' })
  const nestedBody = Buffer.from('{"method":"example/$send","rpcId":"nested-1","payload":{}}')
  const nested = await authority.registerGrant({ issuer: issuer(f.home), bodyBytes: nestedBody, endpoint: 'example/$send', httpMethod: 'POST' })
  const nestedOrigin = await authority.verifyRequest({
    token: nested.token, endpoint: 'example/$send', routePath: 'example/$send', httpMethod: 'POST', method: 'example/$send', rpcId: 'nested-1',
    bodyBytes: nestedBody, bodyDigest: createHash('sha256').update(nestedBody).digest('hex'), peerId: 'browser-owner', peerPrincipal: 'owner',
  })
  assert.equal(nestedOrigin.method, 'example/$send')
  const mismatched = await authority.registerGrant({ issuer: issuer(f.home), bodyBytes: nestedBody, endpoint: 'other/$send', httpMethod: 'POST' })
  await assert.rejects(authority.verifyRequest({
    token: mismatched.token, endpoint: 'example/$send', routePath: 'example/$send', httpMethod: 'POST', method: 'example/$send', rpcId: 'nested-1',
    bodyBytes: nestedBody, bodyDigest: createHash('sha256').update(nestedBody).digest('hex'), peerId: 'browser-owner', peerPrincipal: 'owner',
  }), { code: 'origin_proof_mismatch' })
  const longEndpoint = 'long.' + 'x'.repeat(200)
  const longGrant = await authority.registerGrant({ issuer: issuer(f.home), bodyBytes: nestedBody, endpoint: longEndpoint, httpMethod: 'POST' })
  assert.equal(longGrant.token.length, 43)
  for (const invalidEndpoint of ['bad//path', 'bad/./path', 'bad/../path', 'bad/with space']) {
    await assert.rejects(authority.registerGrant({ issuer: issuer(f.home), bodyBytes: nestedBody, endpoint: invalidEndpoint, httpMethod: 'POST' }), { code: 'invalid_origin_grant_request' })
  }
})

test('actual SDK rpcFetchHandler executes once and replays exact bounded response for original grant', { skip: !pinnedPatchedConnectionPath }, async t => {
  const f = await fixture(t)
  const authority = createExecutionOriginAuthority({ stateStore: f.stateStore, isSessionLive: () => true, isSessionDurable: async () => true })
  const access = createHostOriginAccessors(async () => authority, () => authority)
  const source = await readFile(pinnedPatchedConnectionPath, 'utf8')
  const handlerStart = source.indexOf('function rpcFetchHandler(')
  const helperStart = source.indexOf('\nfunction invalidEnvelopeResponse', handlerStart)
  const endpointStart = source.indexOf('function endpointFromPath(', helperStart)
  const errorStart = source.indexOf('\nfunction errorResponse', endpointStart)
  assert.ok(handlerStart >= 0 && helperStart > handlerStart && endpointStart > helperStart && errorStart > endpointStart)
  const sandbox = {
    Buffer, TextDecoder, URL, Request, Response, Headers, createHash,
    ENDPOINT_SEGMENT_PATTERN: /^[A-Za-z0-9_$.-]+$/,
    clientRequestSchema: { safeParse(value) {
      return value && typeof value.method === 'string' && typeof value.rpcId === 'string'
        ? { success: true, data: value }
        : { success: false, error: { issues: [] } }
    } },
    fullResponse(rpcId, result) { return Response.json({ type: 'server-response', rpcId, result }) },
    errorResponse(rpcId, error) { return Response.json({ type: 'server-response', rpcId, result: { ok: false, error } }) },
    invalidEnvelopeResponse(body) { return Response.json({ type: 'server-response', rpcId: body?.rpcId ?? 'invalid', result: { ok: false, error: { code: 'gateway/bad-request' } } }) },
  }
  const productionSource = `${source.slice(handlerStart, helperStart)}\n${source.slice(endpointStart, errorStart)}\nthis.rpcFetchHandler = rpcFetchHandler;`
  runInNewContext(productionSource, sandbox, { filename: pinnedPatchedConnectionPath })
  const body = Buffer.from(JSON.stringify({ method: 'example/$send', rpcId: 'retry-rpc-1', payload: { text: 'same operation' } }))
  const grant = await authority.registerGrant({ issuer: issuer(f.home), bodyBytes: body, endpoint: 'example/$send', httpMethod: 'POST' })
  let calls = 0
  let entered
  const handlerEntered = new Promise(resolveEntered => { entered = resolveEntered })
  let release
  const hold = new Promise(resolveRelease => { release = resolveRelease })
  const origins = []
  const rpcHandler = sandbox.rpcFetchHandler('/api', async () => {
    calls++
    origins.push(access.currentRequestOrigin())
    if (calls === 1) { entered(); await hold }
    return { ok: true, value: 'one execution' }
  }, { get(name) { if (name !== 'sceneMemoryOriginAuthority') throw new Error('unexpected provider'); return access } })
  const makeRequest = () => new Request('http://dsh.internal/api/example/$send', {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-tradeloom-origin-grant': grant.token }, body,
  })
  const peer = { id: 'browser-owner', principal: { kind: 'owner' } }
  const firstPromise = rpcHandler.fetch(makeRequest(), peer)
  await handlerEntered
  const concurrentRetryPromise = rpcHandler.fetch(makeRequest(), peer)
  await new Promise(resolveTick => setTimeout(resolveTick, 0))
  release()
  const [first, concurrentRetry] = await Promise.all([firstPromise, concurrentRetryPromise])
  const replay = await rpcHandler.fetch(makeRequest(), peer)
  assert.equal(calls, 1)
  assert.equal(origins.length, 1)
  assert.equal((await first.clone().text()), await concurrentRetry.clone().text())
  assert.equal((await first.clone().text()), await replay.clone().text())
  assert.equal(first.status, 200)
  const reminted = await authority.registerGrant({ issuer: issuer(f.home), bodyBytes: body, endpoint: 'example/$send', httpMethod: 'POST' })
  const remintResponse = await rpcHandler.fetch(new Request('http://dsh.internal/api/example/$send', {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-tradeloom-origin-grant': reminted.token }, body,
  }), peer)
  assert.match(await remintResponse.text(), /origin_replay_remint_rejected/)
  assert.equal(calls, 1)
  await authority.dispose()
})

test('terminal pre-rename failure preserves state bytes and keeps the operation fail-closed', async t => {
  const f = await fixture(t)
  const failure = Object.assign(new Error('injected terminal pre-rename failure'), { code: 'fixture_precommit_failure' })
  let failTerminalCommit = false
  const faultStore = {
    ...f.stateStore,
    transact(mutator, options = {}) {
      if (!failTerminalCommit) return f.stateStore.transact(mutator, options)
      failTerminalCommit = false
      return f.stateStore.transact(mutator, { ...options, beforeRename: async () => { throw failure } })
    },
  }
  const authority = createExecutionOriginAuthority({ stateStore: faultStore, isSessionLive: () => true, isSessionDurable: async () => true })
  const { origin } = await claim(authority, f.home)
  const workId = authority.retainOriginWork(origin)
  const before = await readFile(f.stateStore.paths.statePath)
  failTerminalCommit = true
  await assert.rejects(authority.releaseOriginWork(origin, workId, 'fixture-terminal-failure'), error => error === failure)
  const after = await readFile(f.stateStore.paths.statePath)
  assert.deepEqual(after, before)
  assert.equal((await f.stateStore.read()).sceneMemoryOperations?.[origin.operationId]?.status, 'active')
  assert.throws(() => authority.captureAtEnqueue(origin), { code: 'operation_terminal_pending' })
  await assert.rejects(authority.transactSceneMemory(origin, 'write', 'scene-a', { mustNotCommit: true }), { code: 'operation_terminal_pending' })
  assert.equal(await authority.releaseOriginWork(origin, workId, 'retry-after-failure'), false)
  assert.deepEqual(await readFile(f.stateStore.paths.statePath), before)
  await authority.dispose()
})

test('cancel terminal failure clears queue bookkeeping without restoring write authority', async t => {
  const f = await fixture(t)
  let clockNow = Date.now()
  const failure = Object.assign(new Error('injected cancel pre-rename failure'), { code: 'fixture_cancel_precommit_failure' })
  let failCancelCommit = false
  const faultStore = {
    ...f.stateStore,
    transact(mutator, options = {}) {
      if (!failCancelCommit) return f.stateStore.transact(mutator, options)
      failCancelCommit = false
      return f.stateStore.transact(mutator, { ...options, beforeRename: async () => { throw failure } })
    },
  }
  const authority = createExecutionOriginAuthority({ stateStore: faultStore, isSessionLive: () => true, isSessionDurable: async () => true, now: () => clockNow })
  const { origin } = await claim(authority, f.home)
  const owner = {}
  const workId = authority.retainOriginWork(origin, { kind: 'queue', owner })
  const before = await readFile(f.stateStore.paths.statePath)
  failCancelCommit = true
  await assert.rejects(authority.cancelOrigin(origin, [workId], owner, 'fixture-cancel-failure'), error => error === failure)
  assert.deepEqual(await readFile(f.stateStore.paths.statePath), before)
  assert.equal((await f.stateStore.read()).sceneMemoryOperations?.[origin.operationId]?.status, 'active')
  assert.throws(() => authority.captureAtEnqueue(origin), { code: 'operation_terminal_pending' })
  await assert.rejects(authority.cancelOrigin(origin, [workId], owner, 'retry-cancel'), { code: 'invalid_operation_work' })
  clockNow += 5 * 60_000 + 1
  assert.throws(() => authority.captureAtEnqueue(origin), { code: 'operation_not_active' })
  const afterExpiredTerminalizing = await claim(authority, f.home, 'agent/send', Buffer.from('{"method":"agent/send","rpcId":"post-terminalizing-expiry"}'))
  assert.notEqual(afterExpiredTerminalizing.origin.operationId, origin.operationId)
  assert.equal((await f.stateStore.read()).sceneMemoryOperations?.[origin.operationId], undefined)
  await authority.dispose()
})

test('readback failure after rename reports committed unknown and keeps terminal result', async t => {
  const f = await fixture(t)
  const readbackFailure = new Error('injected state readback I/O failure')
  let failTerminalReadback = false
  const uncertainStore = {
    ...f.stateStore,
    transact(mutator, options = {}) {
      if (!failTerminalReadback) return f.stateStore.transact(mutator, options)
      failTerminalReadback = false
      return f.stateStore.transact(mutator, {
        ...options,
        afterRename: async () => { throw readbackFailure },
      })
    },
  }
  const authority = createExecutionOriginAuthority({ stateStore: uncertainStore, isSessionLive: () => true, isSessionDurable: async () => true })
  const { origin } = await claim(authority, f.home)
  const workId = authority.retainOriginWork(origin)
  const before = await readFile(f.stateStore.paths.statePath)
  failTerminalReadback = true
  await assert.rejects(authority.releaseOriginWork(origin, workId, 'fixture-readback-unknown'), error => {
    assert.equal(error.code, 'state_commit_unknown')
    assert.equal(error.committed, true)
    assert.equal(error.cause, readbackFailure)
    return true
  })
  const after = await readFile(f.stateStore.paths.statePath)
  assert.notDeepEqual(after, before)
  assert.equal((await f.stateStore.read()).sceneMemoryOperations?.[origin.operationId]?.status, 'terminal')
  assert.throws(() => authority.captureAtEnqueue(origin), { code: 'operation_terminal' })
  await authority.dispose()
})

test('aggregate replay response bytes become unavailable without re-execution and tombstone expiry frees the response budget', async t => {
  const f = await fixture(t)
  let clockNow = Date.now()
  const authority = createExecutionOriginAuthority({ stateStore: f.stateStore, isSessionLive: () => true, isSessionDurable: async () => true, now: () => clockNow, requestReplayWindowMs: 1000 })
  const first = await claim(authority, f.home, 'agent/send', Buffer.from('{"method":"agent/send","rpcId":"cached-five-megabytes"}'))
  let executions = 0
  const executeFirst = () => { executions++; return authority.claimRequestReplay(first.origin) }
  assert.equal(executeFirst().kind, 'execute')
  assert.equal(authority.completeRequestReplay(first.origin, {
    status: 200, statusText: 'OK', headers: [['content-type', 'application/json']],
    bodyBytes: Buffer.alloc(5 * 1024 * 1024, 0x61),
  }), true, 'the first response occupies five MiB of the shared eight-MiB budget')
  assert.equal(authority.claimRequestReplay(first.origin).kind, 'replay')

  const second = await claim(authority, f.home, 'agent/send', Buffer.from('{"method":"agent/send","rpcId":"aggregate-over-eight-megabytes"}'))
  executions++
  assert.equal(authority.claimRequestReplay(second.origin).kind, 'execute')
  const waitingRetry = authority.claimRequestReplay(second.origin)
  assert.equal(waitingRetry.kind, 'wait')
  assert.equal(authority.completeRequestReplay(second.origin, {
    status: 200, statusText: 'OK', headers: [['content-type', 'application/json']],
    bodyBytes: Buffer.alloc(4 * 1024 * 1024, 0x62),
  }), false, 'a legal four-MiB response is refused because five MiB is already cached')
  assert.deepEqual(await waitingRetry.response, { kind: 'unavailable' })
  assert.equal(authority.claimRequestReplay(second.origin).kind, 'unavailable')
  assert.equal(executions, 2, 'the second operation is not re-executed to recover its unavailable response')

  clockNow += 5 * 60_000 + 1
  const next = await claim(authority, f.home, 'agent/send', Buffer.from('{"method":"agent/send","rpcId":"after-response-tombstone-expiry"}'))
  assert.equal(authority.claimRequestReplay(next.origin).kind, 'execute')
  assert.equal(authority.completeRequestReplay(next.origin, {
    status: 200, statusText: 'OK', headers: [['content-type', 'application/json']], bodyBytes: Buffer.alloc(4 * 1024 * 1024, 0x63),
  }), true, 'five-minute tombstone cleanup subtracts the prior five-MiB cached result from the shared byte budget')
  const recovered = authority.claimRequestReplay(next.origin)
  assert.equal(recovered.kind, 'replay')
  assert.equal(recovered.response.bodyBytes.byteLength, 4 * 1024 * 1024)
  await authority.dispose()
})

test('pending grants and terminal operation state expire from memory and persisted operation metadata', async t => {
  const f = await fixture(t)
  let clockNow = Date.now()
  const authority = createExecutionOriginAuthority({ stateStore: f.stateStore, isSessionLive: () => true, isSessionDurable: async () => true, now: () => clockNow })
  const staleBody = Buffer.from('{"method":"agent/send","rpcId":"pending-ttl","payload":{}}')
  const staleGrant = await authority.registerGrant({ issuer: issuer(f.home), bodyBytes: staleBody, endpoint: 'agent/send', httpMethod: 'POST' })
  clockNow += 15_001
  await assert.rejects(authority.verifyRequest({
    token: staleGrant.token, endpoint: 'agent/send', httpMethod: 'POST', method: 'agent/send', rpcId: 'pending-ttl', bodyBytes: staleBody,
    bodyDigest: createHash('sha256').update(staleBody).digest('hex'), peerId: 'browser-owner', peerPrincipal: 'owner',
  }), { code: 'origin_proof_expired_or_reused' })
  const { origin } = await claim(authority, f.home, 'agent/send', Buffer.from('{"method":"agent/send","rpcId":"terminal-ttl","payload":{}}'))
  const workId = authority.retainOriginWork(origin)
  assert.equal(await authority.releaseOriginWork(origin, workId, 'terminal-ttl-test'), true)
  assert.equal((await f.stateStore.read()).sceneMemoryOperations?.[origin.operationId]?.status, 'terminal')
  clockNow += 5 * 60_000 + 1
  assert.throws(() => authority.captureAtEnqueue(origin), { code: 'operation_not_active' })
  const fresh = await claim(authority, f.home, 'agent/send', Buffer.from('{"method":"agent/send","rpcId":"post-terminal-ttl","payload":{}}'))
  assert.notEqual(fresh.origin.operationId, origin.operationId)
  const afterPrune = await f.stateStore.read()
  assert.equal(afterPrune.sceneMemoryOperations?.[origin.operationId], undefined)
  clockNow += 5 * 60_000 + 1
  assert.throws(() => authority.captureAtEnqueue(fresh.origin), { code: 'operation_not_active' })
  const afterActiveExpiry = await claim(authority, f.home, 'agent/send', Buffer.from('{"method":"agent/send","rpcId":"after-active-ttl","payload":{}}'))
  assert.equal((await f.stateStore.read()).sceneMemoryOperations?.[fresh.origin.operationId], undefined)
  await authority.revoke(afterActiveExpiry.origin)
  assert.equal((await f.stateStore.read()).sceneMemoryOperations?.[afterActiveExpiry.origin.operationId]?.status, 'revoked')
  clockNow += 5 * 60_000 + 1
  assert.throws(() => authority.captureAtEnqueue(afterActiveExpiry.origin), { code: 'operation_not_active' })
  const afterRevokedTtl = await claim(authority, f.home, 'agent/send', Buffer.from('{"method":"agent/send","rpcId":"after-revoked-ttl","payload":{}}'))
  assert.notEqual(afterRevokedTtl.origin.operationId, afterActiveExpiry.origin.operationId)
  assert.equal((await f.stateStore.read()).sceneMemoryOperations?.[afterActiveExpiry.origin.operationId], undefined)
  await authority.dispose()
})

test('actual SDK rpc.call through adapter retries one dropped response with one grant and one bridge execution', { skip: !pinnedPatchedConnectionPath || !pinnedBrowserClientPath }, async t => {
  const f = await fixture(t)
  let clockNow = Date.now()
  const authority = createExecutionOriginAuthority({ stateStore: f.stateStore, isSessionLive: () => true, isSessionDurable: async () => true, now: () => clockNow, requestReplayWindowMs: 500 })
  let waitCount = 0
  let resolveSecondWait
  const secondWaitStarted = new Promise(resolveWait => { resolveSecondWait = resolveWait })
  const observedAuthority = Object.create(authority)
  Object.defineProperty(observedAuthority, 'claimRequestReplay', { value: origin => {
    const claim = authority.claimRequestReplay(origin)
    if (claim.kind === 'wait' && ++waitCount === 2) resolveSecondWait()
    return claim
  } })
  const access = createHostOriginAccessors(async () => authority, () => observedAuthority)
  const connectionSource = await readFile(pinnedPatchedConnectionPath, 'utf8')
  const handlerStart = connectionSource.indexOf('function rpcFetchHandler(')
  const helperStart = connectionSource.indexOf('\nfunction invalidEnvelopeResponse', handlerStart)
  const endpointStart = connectionSource.indexOf('function endpointFromPath(', helperStart)
  const errorStart = connectionSource.indexOf('\nfunction errorResponse', endpointStart)
  assert.ok(handlerStart >= 0 && helperStart > handlerStart && endpointStart > helperStart && errorStart > endpointStart)
  const bridgeSandbox = {
    Buffer, TextDecoder, URL, Request, Response, Headers, createHash,
    ENDPOINT_SEGMENT_PATTERN: /^[A-Za-z0-9_$.-]+$/,
    clientRequestSchema: { safeParse(value) {
      return value && typeof value.method === 'string' && typeof value.rpcId === 'string'
        ? { success: true, data: value }
        : { success: false, error: { issues: [] } }
    } },
    fullResponse(rpcId, result) { return Response.json({ type: 'server-response', rpcId, result }) },
    errorResponse(rpcId, error) { return Response.json({ type: 'server-response', rpcId, result: { ok: false, error } }) },
    invalidEnvelopeResponse(body) { return Response.json({ type: 'server-response', rpcId: body?.rpcId ?? 'invalid', result: { ok: false, error: { code: 'gateway/bad-request' } } }) },
  }
  runInNewContext(`${connectionSource.slice(handlerStart, helperStart)}\n${connectionSource.slice(endpointStart, errorStart)}\nthis.rpcFetchHandler = rpcFetchHandler;`, bridgeSandbox, { filename: pinnedPatchedConnectionPath })

  const observedGrants = []
  let operationCalls = 0
  const operationIds = []
  let entered
  const handlerEntered = new Promise(resolveEntered => { entered = resolveEntered })
  let release
  const hold = new Promise(resolveRelease => { release = resolveRelease })
  let enteredSecond
  const secondHandlerEntered = new Promise(resolveEntered => { enteredSecond = resolveEntered })
  let releaseSecond
  const holdSecond = new Promise(resolveRelease => { releaseSecond = resolveRelease })
  let secondHandlerFinished = false
  const peer = { id: 'browser-owner', principal: { kind: 'owner' } }
  const rpcHandler = bridgeSandbox.rpcFetchHandler('/api', async () => {
    operationCalls++
    const origin = access.currentRequestOrigin()
    operationIds.push(origin.operationId)
    if (operationCalls === 1) { entered(); await hold }
    if (operationCalls === 2) { enteredSecond(); await holdSecond; secondHandlerFinished = true }
    return { ok: true, value: 'one bridge execution' }
  }, { get(name) { if (name !== 'sceneMemoryOriginAuthority') throw new Error('unexpected provider'); return access } })

  let dropFirstResponse = true
  let capturedRequest
  const browser = await readFile(pinnedBrowserClientPath, 'utf8')
  let pluginDefinition
  const grantRequests = []
  const sandbox = {
    window: { __ModuleLoader__: { load(definition) { pluginDefinition = definition } } },
    location: new URL('http://app/'), Request, Headers, Response, URL, crypto: webcrypto,
    fetch: async input => {
      const request = input instanceof Request ? input : new Request(new URL(input, 'http://app/'))
      capturedRequest = request.clone()
      const response = await rpcHandler.fetch(request, peer)
      if (dropFirstResponse) { dropFirstResponse = false; throw new Error('simulated response loss after Host execution') }
      return response
    },
    dshDesktopBoot: { async issueSceneMemoryOriginGrant(request) {
      const observed = { ...request, bodyBytes: Buffer.from(request.bodyBytes) }
      grantRequests.push(observed)
      const grant = await authority.registerGrant({ issuer: issuer(f.home), bodyBytes: request.bodyBytes, endpoint: request.endpoint, httpMethod: request.httpMethod })
      observed.token = grant.token
      return grant
    } },
  }
  sandbox.globalThis = sandbox
  runInNewContext(browser, sandbox, { filename: pinnedBrowserClientPath })
  assert.equal(pluginDefinition?.id, '@deepseek-ai/dsh-client-connection')
  const plugin = pluginDefinition.factory(() => { throw new Error('unexpected SDK import') })
  const context = { provide(name, value) { this[name] = value } }
  const transport = { ownsHost: true, streamBaseUrl: 'http://127.0.0.1:43123' }
  const restore = installBrowserTransportAdapter(transport, sandbox)
  plugin.installConnection(context, { transport })
  const firstSdkCall = context.connection.rpc.call('/api', 'example/$send', { text: 'retry this exact request' }, new AbortController().signal)
  await handlerEntered
  assert.ok(capturedRequest instanceof Request)
  assert.equal(capturedRequest.headers.get('x-tradeloom-origin-grant'), grantRequests[0].token)
  const retryResponsePromise = transport.fetch(capturedRequest.clone())
  await new Promise(resolveTick => setTimeout(resolveTick, 0))
  release()
  await assert.rejects(firstSdkCall, /simulated response loss after Host execution/)
  const [retryResponse, cachedReplay] = await Promise.all([retryResponsePromise, transport.fetch(capturedRequest.clone())])
  assert.equal(grantRequests.length, 1)
  assert.equal(operationCalls, 1)
  assert.ok(operationIds[0])
  assert.equal(retryResponse.status, 200)
  assert.equal(await retryResponse.clone().text(), await cachedReplay.clone().text())
  assert.equal(JSON.parse(await retryResponse.text()).result.value, 'one bridge execution')
  const expiringSdkCall = context.connection.rpc.call('/api', 'example/$send', { text: 'expire response replay while handler runs' }, new AbortController().signal)
  await secondHandlerEntered
  const expiringRetry = transport.fetch(capturedRequest.clone())
  await secondWaitStarted
  clockNow += 501
  const expiredRetryResponse = await expiringRetry
  assert.equal(secondHandlerFinished, false, 'retry wait must expire while the original handler is still held')
  assert.equal(JSON.parse(await expiredRetryResponse.text()).result.error.code, 'gateway/origin-replay-expired')
  releaseSecond()
  const originalResponse = await expiringSdkCall
  assert.equal(originalResponse.ok, true)
  assert.equal(secondHandlerFinished, true)
  assert.equal(operationCalls, 2)
  assert.notEqual(operationIds[1], operationIds[0])
  assert.equal(grantRequests.length, 2)
  restore()
  await authority.dispose()
})

test('read serializes without rewriting; first authorized write backs up exact legacy bytes and preserves unknown lineage', async t => {
  const f = await fixture(t)
  await f.stateStore.transact(state => {
    state.legacyUnknown = { kept: true }
    state.sceneMemory = { old: true, retained: 'legacy' }
    state.sceneMemoryLineage = { source: 'old', extra: 9 }
  })
  const authority = createExecutionOriginAuthority({ stateStore: f.stateStore, isSessionLive: () => true, isSessionDurable: async () => true })
  const rawBeforeClaim = await readFile(f.stateStore.paths.statePath)
  const { origin, body } = await claim(authority, f.home, 'agent/send', Buffer.from('{"method":"agent/send","rpcId":"rpc-1"}'))
  await claim(authority, f.home, 'agent/send', Buffer.from('{"method":"agent/send","rpcId":"rpc-2"}'))
  const beforeRead = await readFile(f.stateStore.paths.statePath)
  assert.equal(await authority.transactSceneMemory(origin, 'read', 'scene-a'), null)
  assert.deepEqual(await readFile(f.stateStore.paths.statePath), beforeRead)
  const backupDir = join(f.home, 'tradeloom-state', 'scene-memory-backups')
  const [claimBackup] = await readdir(backupDir)
  assert.ok(claimBackup.startsWith('legacy-'))
  assert.deepEqual(await readFile(join(backupDir, claimBackup)), rawBeforeClaim)

  await authority.transactSceneMemory(origin, 'write', 'scene-a', { newValue: 1, unknown: { keep: 'yes' } })
  const after = await f.stateStore.read()
  assert.deepEqual(after.legacyUnknown, { kept: true })
  assert.deepEqual(after.sceneMemory, { old: true, retained: 'legacy' })
  assert.deepEqual(after.sceneMemoryLineage, { source: 'old', extra: 9 })
  assert.deepEqual(after.sceneMemories['scene-a'].lineage, { source: 'old', extra: 9 })
  assert.deepEqual(after.sceneMemories['scene-a'].value, { newValue: 1, unknown: { keep: 'yes' } })
  assert.equal(after.sceneMemoryMigration.version, 1)
  const backupNames = await readdir(backupDir)
  assert.equal(backupNames.length, 1)
  assert.deepEqual(await readFile(join(backupDir, backupNames[0])), rawBeforeClaim)
  assert.ok(body.length > 0)
})

test('legacy backup preserves exact invalid UTF-8 bytes from the original state file', async t => {
  const f = await fixture(t)
  await f.stateStore.transact(state => {
    state.legacyUnknown = { kept: true }
    state.sceneMemory = { raw: 'placeholder' }
    state.sceneMemoryLineage = { source: 'legacy', unknownLineage: 7 }
  })
  const state = await f.stateStore.read()
  const json = Buffer.from(`${JSON.stringify(state, null, 2)}\n`)
  const marker = Buffer.from('"placeholder"')
  const index = json.indexOf(marker)
  assert.notEqual(index, -1)
  const rawBytes = Buffer.concat([json.subarray(0, index), Buffer.from([0x22, 0x78, 0xff, 0x79, 0x22]), json.subarray(index + marker.length)])
  await writeFile(f.stateStore.paths.statePath, rawBytes)
  assert.equal((await f.stateStore.read()).sceneMemory.raw, 'x\ufffdy')
  const beforeGrant = await readFile(f.stateStore.paths.statePath)
  const authority = createExecutionOriginAuthority({ stateStore: f.stateStore, isSessionLive: () => true, isSessionDurable: async () => true })
  const { origin } = await claim(authority, f.home)
  const [backupAfterClaim] = await readdir(join(f.home, 'tradeloom-state', 'scene-memory-backups'))
  assert.deepEqual(await readFile(join(f.home, 'tradeloom-state', 'scene-memory-backups', backupAfterClaim)), beforeGrant)
  const normalizedAfterClaim = await readFile(f.stateStore.paths.statePath)
  assert.notDeepEqual(normalizedAfterClaim, beforeGrant)
  assert.equal((await f.stateStore.read()).legacyUnknown.kept, true)
  await authority.transactSceneMemory(origin, 'write', 'scene-a', { accepted: true })
  const [backupName] = await readdir(join(f.home, 'tradeloom-state', 'scene-memory-backups'))
  assert.deepEqual(await readFile(join(f.home, 'tradeloom-state', 'scene-memory-backups', backupName)), rawBytes)
})

test('legacy preimage binding survives concurrent and expired claims, ignores unrelated backup, and rejects tampering', async t => {
  const f = await fixture(t)
  await f.stateStore.transact(state => {
    state.legacyUnknown = { retained: 'original' }
    state.sceneMemory = { old: true }
    state.sceneMemoryLineage = { owner: 'old' }
  })
  const unrelated = Buffer.from('unrelated backup')
  const unrelatedDigest = createHash('sha256').update(unrelated).digest('hex')
  await f.stateStore.writeImmutableBackup(`legacy-${unrelatedDigest}.json`, unrelated)
  const rawPreimage = await readFile(f.stateStore.paths.statePath)
  let now = 1_000
  const authority = createExecutionOriginAuthority({ stateStore: f.stateStore, now: () => now, isSessionLive: () => true, isSessionDurable: async () => true })
  const [first, second] = await Promise.all([claim(authority, f.home, 'agent/send', Buffer.from('{"payload":{"text":"hello"}}'), 'rpc-1'), claim(authority, f.home, 'agent/send', Buffer.from('{"payload":{"text":"hello"}}'), 'rpc-2')])
  const backupDir = join(f.home, 'tradeloom-state', 'scene-memory-backups')
  const rawDigest = createHash('sha256').update(rawPreimage).digest('hex')
  const boundName = `legacy-${rawDigest}.json`
  assert.deepEqual(await readFile(join(backupDir, boundName)), rawPreimage)
  assert.equal((await readdir(backupDir)).length, 2)
  now = Math.max(first.origin.activeUntil, second.origin.activeUntil) + 1
  await assert.rejects(authority.transactSceneMemory(first.origin, 'write', 'scene-a', { expired: true }), { code: 'operation_not_active' })
  const third = await claim(authority, f.home)
  await authority.transactSceneMemory(third.origin, 'write', 'scene-a', { kept: true })
  assert.equal((await readdir(backupDir)).length, 2)
  assert.deepEqual(await readFile(join(backupDir, boundName)), rawPreimage)
  assert.equal((await f.stateStore.read()).sceneMemoryMigration.version, 1)

  const g = await fixture(t)
  await g.stateStore.transact(state => {
    state.sceneMemory = { old: 'tamper-target' }
    state.sceneMemoryLineage = { owner: 'old' }
  })
  const tamperAuthority = createExecutionOriginAuthority({ stateStore: g.stateStore, isSessionLive: () => true, isSessionDurable: async () => true })
  const { origin } = await claim(tamperAuthority, g.home)
  const boundDir = join(g.home, 'tradeloom-state', 'scene-memory-backups')
  const [boundBackup] = await readdir(boundDir)
  await writeFile(join(boundDir, boundBackup), Buffer.from('tampered'))
  const beforeRejectedWrite = await readFile(g.stateStore.paths.statePath)
  await assert.rejects(tamperAuthority.transactSceneMemory(origin, 'write', 'scene-a', { mustNotCommit: true }), { code: 'legacy_backup_mismatch' })
  assert.deepEqual(await readFile(g.stateStore.paths.statePath), beforeRejectedWrite)
})

test('binding replacement and Host restart reject an already claimed operation', async t => {
  const f = await fixture(t)
  const first = createExecutionOriginAuthority({ stateStore: f.stateStore, isSessionLive: () => true, isSessionDurable: async () => true })
  const { origin } = await claim(first, f.home)
  await f.stateStore.transact(state => replaceRoleBinding(state, 'center', {
    sessionId: 'session-b', workspaceId: 'workspace-b', workspacePath: join(f.home, 'workspace-b'), agentPreset: 'tradeloom-center',
  }))
  await assert.rejects(first.transactSceneMemory(origin, 'write', 'scene-a', { blocked: true }), { code: 'stale_role_binding' })
  const restarted = createExecutionOriginAuthority({ stateStore: f.stateStore, isSessionLive: () => true, isSessionDurable: async () => true })
  await assert.rejects(restarted.transactSceneMemory(origin, 'write', 'scene-a', { blocked: true }), { code: 'operation_not_active' })
})

test('archive or expiry at the precommit barrier leaves old state bytes unchanged', async t => {
  const f = await fixture(t)
  let now = 1_000
  let live = true
  let archiveBarrierHit = false
  const authority = createExecutionOriginAuthority({
    stateStore: f.stateStore,
    now: () => now,
    isSessionLive: () => live,
    isSessionDurable: async () => true,
    onBeforeCommitAttempt: () => { archiveBarrierHit = true; live = false },
  })
  const { origin } = await claim(authority, f.home)
  const before = await readFile(f.stateStore.paths.statePath)
  await assert.rejects(authority.transactSceneMemory(origin, 'write', 'scene-a', { mustNotCommit: true }), { code: 'session_not_live' })
  assert.equal(archiveBarrierHit, true)
  assert.deepEqual(await readFile(f.stateStore.paths.statePath), before)
  live = true
  now = 1_000
  let expiryAt = Number.MAX_SAFE_INTEGER
  let expiryBarrierHit = false
  const nextAuthority = createExecutionOriginAuthority({
    stateStore: f.stateStore,
    now: () => now,
    isSessionLive: () => live,
    isSessionDurable: async () => true,
    onBeforeCommitAttempt: () => { expiryBarrierHit = true; now = expiryAt },
  })
  const { origin: expiring } = await claim(nextAuthority, f.home)
  expiryAt = expiring.activeUntil
  const beforeExpiry = await readFile(f.stateStore.paths.statePath)
  await assert.rejects(nextAuthority.transactSceneMemory(expiring, 'write', 'scene-a', { mustNotCommit: true }), { code: 'operation_expired' })
  assert.equal(expiryBarrierHit, true)
  assert.deepEqual(await readFile(f.stateStore.paths.statePath), beforeExpiry)
})

test('state commit gate is rechecked after the awaited precommit callback yields', async t => {
  const f = await fixture(t)
  const before = await readFile(f.stateStore.paths.statePath)
  let live = true
  let validationCount = 0
  let transitionQueued = false
  await assert.rejects(f.stateStore.transact(state => {
    state.commitRaceProbe = 'must-not-commit'
  }, {
    compareBeforeRename: true,
    readback: true,
    beforeCommitAttempt: async () => { await Promise.resolve() },
    validateCommit: () => {
      validationCount++
      if (!transitionQueued) {
        transitionQueued = true
        queueMicrotask(() => { live = false })
      }
      if (!live) throw Object.assign(new Error('commit gate closed during await-to-rename window'), { code: 'commit_gate_closed' })
    },
  }), { code: 'commit_gate_closed' })
  assert.equal(validationCount, 2, 'the sync validator runs again after the awaited precommit attempt resolves')
  assert.equal(live, false)
  assert.deepEqual(await readFile(f.stateStore.paths.statePath), before, 'the queued gate transition leaves original state bytes untouched')
})

const sdkNodeModules = process.env.N01_SDK_NODE_MODULES
test('actual SDK ToolRuntime projects origin and dispatches the real scene-memory consumer', { skip: !sdkNodeModules }, async t => {
  const importSdk = async (...parts) => await import(pathToFileURL(join(sdkNodeModules, ...parts)).href)
  const { Context } = await importSdk('@deepseek-ai', 'cordis', 'lib', 'index.js')
  const { ToolRuntime } = await importSdk('@deepseek-ai', 'dsh-tools', 'lib', 'index.js')
  const f = await fixture(t)
  const authority = createExecutionOriginAuthority({ stateStore: f.stateStore, isSessionLive: () => true, isSessionDurable: async () => true })
  const { origin } = await claim(authority, f.home)
  const ctx = new Context()
  ctx.provide('systemPrompt', { tools() {}, getSectionOrder() { return 1 }, section() {} })
  ctx.provide('sceneMemoryOriginAuthority', authority)
  const runtime = new ToolRuntime(ctx, { mode: 'native' })
  registerBusinessTools({ tools: runtime }, { preset: 'tradeloom-center' }, { sceneMemoryOriginAuthority: authority })
  const agent = { id: 'session-a', session: { id: 'session-a' }, ctx }
  const workId = authority.retainOriginWork(origin, { kind: 'queue', owner: agent })
  const created = runtime.createExecution({
    callId: 'sdk-tool-call-a', name: 'tradeloom_scene_memory_write',
    arguments: { scene_id: 'scene-a', value: { sdk: 'actual-runtime' } },
    signal: new AbortController().signal, agent, operationOrigin: origin, operationOriginWorkId: workId,
  })
  assert.equal(created.kind, 'ready')
  assert.equal(created.exec.operationOrigin, origin)
  const result = await runtime.dispatchToolBody(created.exec)
  assert.equal(result.isError, false)
  const stored = await authority.transactSceneMemory(origin, 'read', 'scene-a')
  assert.deepEqual(stored, { sdk: 'actual-runtime' })
  await authority.releaseOriginWork(origin, workId, 'runtime-focused-test-finished', agent)
  await authority.revoke(origin)
})

test('actual AgentLoop child setup captures an active parent execution after the handler ends', { skip: !sdkNodeModules }, async t => {
  const importSdk = async (...parts) => await import(pathToFileURL(join(sdkNodeModules, ...parts)).href)
  const [{ Context }, { SessionStore }, { AgentRegistry }, { SessionProjectionRegistry }, { SystemPrompt }, { AgentLoop }, { ToolRuntime }, { createUserMessage }] = await Promise.all([
    importSdk('@deepseek-ai', 'cordis', 'lib', 'index.js'),
    importSdk('@deepseek-ai', 'dsh-session', 'lib', 'index.js'),
    importSdk('@deepseek-ai', 'dsh-agent', 'lib', 'index.js'),
    importSdk('@deepseek-ai', 'dsh-session-projection', 'lib', 'index.js'),
    importSdk('@deepseek-ai', 'dsh-system-prompt', 'lib', 'index.js'),
    importSdk('@deepseek-ai', 'dsh-agent-loop', 'lib', 'index.js'),
    importSdk('@deepseek-ai', 'dsh-tools', 'lib', 'index.js'),
    importSdk('@deepseek-ai', 'dsh-llm', 'lib', 'index.js'),
  ])
  const f = await fixture(t)
  const authority = createExecutionOriginAuthority({ stateStore: f.stateStore, isSessionLive: () => true, isSessionDurable: async () => true })
  const { origin } = await claim(authority, f.home, 'agent/parent-tool', Buffer.from('{"method":"agent/parent-tool","rpcId":"parent-rpc"}'))
  const hostOriginAccessors = createHostOriginAccessors(async () => authority, () => authority)
  const workEvents = []
  const observedOriginAccessors = Object.create(hostOriginAccessors)
  Object.defineProperties(observedOriginAccessors, {
    retainOriginWork: { value: (origin, options) => {
      const workId = hostOriginAccessors.retainOriginWork(origin, options)
      workEvents.push({ kind: 'retain', operationId: origin.operationId, workId })
      return workId
    } },
    releaseOriginWork: { value: (origin, workId, reason, owner) => {
      workEvents.push({ kind: 'release', operationId: origin.operationId, workId, reason })
      return hostOriginAccessors.releaseOriginWork(origin, workId, reason, owner)
    } },
  })
  const ctx = new Context()
  ctx.provide('sceneMemoryOriginAuthority', observedOriginAccessors)
  ctx.provide('llm', { async *stream() { throw new Error('unexpected background model call') } })
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(SystemPrompt)
  const tools = new ToolRuntime(ctx, { mode: 'native' })
  registerBusinessTools({ tools }, { preset: 'tradeloom-center' }, { sceneMemoryOriginAuthority: observedOriginAccessors })
  await ctx.plugin(AgentLoop, { agents: [], maxParallelToolCalls: 1 })
  const loop = ctx.get('agentLoop')
  const rootCreateOrigin = (await claim(authority, f.home, 'agent/create', Buffer.from('{"method":"agent/create","rpcId":"root-create"}'))).origin
  const rootSetupStarted = Promise.withResolvers()
  const continueRootSetup = Promise.withResolvers()
  let rootCreatePromise
  let rootChildAgent
  let rootSetupOrigin
  let rootSetupWrite
  await hostOriginAccessors.withVerifiedRequestOrigin(rootCreateOrigin, async () => {
    rootCreatePromise = ctx.agents.create({
      sessionId: 'actual-root-created-session',
      setup: async (_childCtx, childAgent) => {
        rootChildAgent = childAgent
        rootSetupStarted.resolve()
        await continueRootSetup.promise
        rootSetupOrigin = authority.currentRequestOrigin()
        childAgent.send(createUserMessage('root created child first input'), 'next-turn', false)
        const rootMessage = childAgent.inbox.nextTurn[0]
        assert.deepEqual(rootSetupOrigin, rootCreateOrigin)
        assert.deepEqual(rootMessage?.operationOrigin, rootSetupOrigin, 'the created child queue must carry the captured request tuple')
        assert.equal(typeof rootMessage?.operationOriginWorkId, 'string')
        const rootExecution = tools.createExecution({
          callId: 'root-create-scene-memory', name: 'tradeloom_scene_memory_write',
          arguments: { scene_id: 'scene-a', value: { captured: 'request-create-after-ack' } },
          signal: new AbortController().signal, agent: childAgent,
          operationOrigin: rootMessage.operationOrigin, operationOriginWorkId: rootMessage.operationOriginWorkId,
        })
        assert.equal(rootExecution.kind, 'ready')
        rootSetupWrite = await tools.dispatchToolBody(rootExecution.exec)
      },
    })
    return { accepted: true }
  })
  await rootSetupStarted.promise
  assert.equal((await f.stateStore.read()).sceneMemoryOperations?.[rootCreateOrigin.operationId]?.status, 'active', 'root agents.create retains verified request ownership after handler ACK')
  continueRootSetup.resolve()
  const rootCreated = await rootCreatePromise
  assert.equal(rootSetupOrigin, rootCreateOrigin)
  assert.equal(rootSetupWrite.isError, false, JSON.stringify(rootSetupWrite))
  assert.deepEqual((await f.stateStore.read()).sceneMemories?.['scene-a']?.value, { captured: 'request-create-after-ack' })
  rootChildAgent.cancel(new Error('finish root-created setup queue'), { keepInbox: false })
  await rootChildAgent.whenIdle()
  assert.equal((await f.stateStore.read()).sceneMemoryOperations?.[rootCreateOrigin.operationId]?.status, 'terminal')
  await assert.rejects(authority.transactSceneMemory(rootCreateOrigin, 'write', 'scene-a', { late: true }), { code: 'operation_terminal' })
  let prooflessCreateOrigin = 'not-read'
  await ctx.agents.create({ sessionId: 'actual-proofless-root-create', setup: async () => { prooflessCreateOrigin = authority.currentRequestOrigin() } })
  assert.equal(prooflessCreateOrigin, undefined, 'a normal proofless create cannot capture an unrelated or latest operation')
  await assert.rejects(ctx.agents.create({ sessionId: 'actual-forged-origin-root-create', operationOrigin: rootCreateOrigin }), /operation origin is Host-owned/)
  const parentAgent = await loop.create('actual-parent-session', {})
  const childCancelErrors = []
  ctx.on('agent/error', event => { if (event?.agent === childAgentRef) childCancelErrors.push(event.error) })
  const setupStarted = Promise.withResolvers()
  const continueSetup = Promise.withResolvers()
  let childPromise
  let childOrigin
  let childOriginWorkId
  let childAgentRef
  let sceneWrite
  let childSetupError
  tools.register({
    name: 'spawn_actual_child', description: 'Create a child agent during a parent execution',
    parameters: { type: 'object', properties: {}, required: [], additionalProperties: false },
    output: { schema: { type: 'object', properties: { accepted: { type: 'boolean' } }, required: ['accepted'], additionalProperties: false }, render: () => [] },
    execute: async () => {
      childPromise = ctx.agents.create({
        sessionId: 'actual-child-session', parentAgent,
        setup: async (childCtx, childAgent) => {
          childAgentRef = childAgent
          setupStarted.resolve()
          await continueSetup.promise
          childAgent.send(createUserMessage('child first input'), 'next-turn', false)
          const inboxMessage = childAgent.inbox.nextTurn[0]
          childOrigin = inboxMessage?.operationOrigin
          childOriginWorkId = inboxMessage?.operationOriginWorkId
          const created = tools.createExecution({
            callId: 'actual-child-scene-memory', name: 'tradeloom_scene_memory_write',
            arguments: { scene_id: 'scene-a', value: { child: 'inherited-parent-origin' } },
            signal: new AbortController().signal, agent: childAgent, operationOrigin: childOrigin, operationOriginWorkId: childOriginWorkId,
          })
          assert.equal(created.kind, 'ready')
          sceneWrite = await tools.dispatchToolBody(created.exec)
        },
      }).catch(error => { childSetupError = error; throw error })
      return { accepted: true }
    },
  })
  await hostOriginAccessors.withVerifiedRequestOrigin(origin, async () => parentAgent.send(createUserMessage('parent execution that spawns a child'), 'next-turn', false))
  const parentQueueMessage = parentAgent.inbox.nextTurn[0]
  const parentCall = tools.createExecution({
    callId: 'actual-parent-spawn', name: 'spawn_actual_child', arguments: {},
    signal: new AbortController().signal, agent: parentAgent,
    operationOrigin: parentQueueMessage.operationOrigin, operationOriginWorkId: parentQueueMessage.operationOriginWorkId,
  })
  assert.equal(parentCall.kind, 'ready')
  const parentResult = await tools.dispatchToolBody(parentCall.exec)
  assert.equal(parentResult.isError, false)
  await setupStarted.promise
  assert.equal(authority.currentToolExecution(), undefined)
  assert.equal((await f.stateStore.read()).sceneMemoryOperations?.[origin.operationId]?.status, 'active', 'the retained child-setup work keeps the origin live after its parent tool ends')
  continueSetup.resolve()
  try { await childPromise } catch (error) { childSetupError ??= error }
  if (childSetupError) throw childSetupError
  assert.equal(childOrigin.operationId, origin.operationId)
  assert.equal(childOrigin.hostEpoch, origin.hostEpoch)
  assert.equal(sceneWrite.isError, false, JSON.stringify(sceneWrite))
  assert.deepEqual((await f.stateStore.read()).sceneMemories?.['scene-a']?.value, { child: 'inherited-parent-origin' })
  childAgentRef.cancel(new Error('finish child queued work'), { keepInbox: false })
  await childAgentRef.whenIdle()
  assert.equal((await f.stateStore.read()).sceneMemoryOperations?.[origin.operationId]?.status, 'terminal', JSON.stringify({ workEvents: workEvents.filter(event => event.operationId === origin.operationId), cancelErrors: childCancelErrors.map(error => ({ code: error?.code, message: error?.message, stack: error?.stack })) }))
  assert.ok(workEvents.some(event => event.kind === 'release' && event.operationId === origin.operationId && event.reason === 'child-setup-ended'))
  await assert.rejects(authority.transactSceneMemory(origin, 'write', 'scene-a', { late: true }), { code: 'operation_terminal' })
  parentAgent.cancel(new Error('cancel sibling queue after operation terminal'), { keepInbox: false })
  await parentAgent.whenIdle()
  const failedCreateOrigin = (await claim(authority, f.home, 'agent/parent-tool', Buffer.from('{"method":"agent/parent-tool","rpcId":"failed-child"}'))).origin
  await hostOriginAccessors.withVerifiedRequestOrigin(failedCreateOrigin, async () => parentAgent.send(createUserMessage('request a child that fails preparation'), 'next-turn', false))
  const failedCreateMessage = parentAgent.inbox.nextTurn[0]
  assert.equal(failedCreateMessage.operationOrigin?.operationId, failedCreateOrigin.operationId)
  assert.equal(typeof failedCreateMessage.operationOriginWorkId, 'string')
  let childCreateRejected = false
  let childCreateError
  tools.register({
    name: 'reject_duplicate_child', description: 'Exercise cleanup when child session preparation fails',
    parameters: { type: 'object', properties: {}, required: [], additionalProperties: false },
    output: { schema: { type: 'object', properties: { rejected: { type: 'boolean' } }, required: ['rejected'], additionalProperties: false }, render: () => [] },
    execute: async () => {
      try { await ctx.agents.create({ sessionId: 'actual-parent-session', parentAgent }); }
      catch (error) { childCreateRejected = true; childCreateError = error; return { rejected: true }; }
      return { rejected: false };
    },
  })
  const failedCreateCall = tools.createExecution({
    callId: 'actual-failed-child-create', name: 'reject_duplicate_child', arguments: {},
    signal: new AbortController().signal, agent: parentAgent,
    operationOrigin: failedCreateMessage.operationOrigin, operationOriginWorkId: failedCreateMessage.operationOriginWorkId,
  })
  assert.equal(failedCreateCall.kind, 'ready')
  const failedCreateResult = await tools.dispatchToolBody(failedCreateCall.exec)
  assert.equal(failedCreateResult.isError, false)
  assert.equal(childCreateRejected, true)
  assert.match(childCreateError?.message ?? '', /session "actual-parent-session" already exists/, 'the failure must originate from the actual synchronous SessionStore.prepare duplicate check')
  assert.ok(workEvents.some(event => event.kind === 'release' && event.operationId === failedCreateOrigin.operationId && event.reason === 'child-setup-ended'))
  assert.equal((await f.stateStore.read()).sceneMemoryOperations?.[failedCreateOrigin.operationId]?.status, 'active')
  parentAgent.cancel(new Error('finish failed-child queue work'), { keepInbox: false })
  await parentAgent.whenIdle()
  assert.equal((await f.stateStore.read()).sceneMemoryOperations?.[failedCreateOrigin.operationId]?.status, 'terminal', 'the failed child leaves no leaked setup work after its parent holder ends')
  await assert.rejects(authority.transactSceneMemory(failedCreateOrigin, 'write', 'scene-a', { late: true }), { code: 'operation_terminal' })
  await ctx.fiber.dispose()
})

test('actual AgentLoop driver separates A and B origins across multi-step turns', { timeout: 30000, skip: !sdkNodeModules }, async t => {
  const importSdk = async (...parts) => await import(pathToFileURL(join(sdkNodeModules, ...parts)).href)
  const [{ Context }, { SessionStore }, { AgentRegistry }, { SessionProjectionRegistry }, { SystemPrompt }, { AgentLoop }, { ToolRuntime }, { createUserMessage }] = await Promise.all([
    importSdk('@deepseek-ai', 'cordis', 'lib', 'index.js'),
    importSdk('@deepseek-ai', 'dsh-session', 'lib', 'index.js'),
    importSdk('@deepseek-ai', 'dsh-agent', 'lib', 'index.js'),
    importSdk('@deepseek-ai', 'dsh-session-projection', 'lib', 'index.js'),
    importSdk('@deepseek-ai', 'dsh-system-prompt', 'lib', 'index.js'),
    importSdk('@deepseek-ai', 'dsh-agent-loop', 'lib', 'index.js'),
    importSdk('@deepseek-ai', 'dsh-tools', 'lib', 'index.js'),
    importSdk('@deepseek-ai', 'dsh-llm', 'lib', 'index.js'),
  ])
  const f = await fixture(t)
  let clockNow = Date.now()
  let cancelCommitOperationId
  let holdCancelledCommit = false
  const cancelWriteStarted = Promise.withResolvers()
  const releaseCancelledWrite = Promise.withResolvers()
  const authority = createExecutionOriginAuthority({
    stateStore: f.stateStore, isSessionLive: () => true, isSessionDurable: async () => true, now: () => clockNow,
    onBeforeCommitAttempt: async ({ origin }) => {
      if (!holdCancelledCommit || origin.operationId !== cancelCommitOperationId) return
      holdCancelledCommit = false
      cancelWriteStarted.resolve()
      await releaseCancelledWrite.promise
    },
  })
  const a = await claim(authority, f.home, 'agent/send', Buffer.from('{"method":"agent/send","rpcId":"A"}'))
  const b = await claim(authority, f.home, 'agent/send', Buffer.from('{"method":"agent/send","rpcId":"B"}'))
  assert.notEqual(a.origin.operationId, b.origin.operationId)
  let driverStarts = 0
  const hostOriginAccessors = createHostOriginAccessors(async () => authority, () => authority)
  const observedAuthority = Object.create(hostOriginAccessors)
  Object.defineProperty(observedAuthority, 'runDetachedDriver', { value: callback => {
      driverStarts++
      return hostOriginAccessors.runDetachedDriver(callback)
  } })
  const firstStreamStarted = Promise.withResolvers()
  const releaseFirstStream = Promise.withResolvers()
  const prooflessStreamStarted = Promise.withResolvers()
  const releaseProoflessStream = Promise.withResolvers()
  const ambiguousBaseStreamStarted = Promise.withResolvers()
  const releaseAmbiguousBase = Promise.withResolvers()
  const expiredBaseStreamStarted = Promise.withResolvers()
  const releaseExpiredBase = Promise.withResolvers()
  const plainExpiredStreamStarted = Promise.withResolvers()
  const releasePlainExpired = Promise.withResolvers()
  const userMessage = text => createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })
  let ctx
  let disposed = false
  t.after(async () => {
    releaseFirstStream.resolve()
    releaseProoflessStream.resolve()
    releaseAmbiguousBase.resolve()
    releaseExpiredBase.resolve()
    releasePlainExpired.resolve()
    releaseCancelledWrite.resolve()
    if (ctx?.fiber && !disposed) await ctx.fiber.dispose()
  })
  let requestCount = 0
  const withTimeout = (promise, ms, message) => new Promise((resolvePromise, rejectPromise) => {
    const timer = setTimeout(() => rejectPromise(new Error(message)), ms)
    Promise.resolve(promise).then(value => { clearTimeout(timer); resolvePromise(value) }, error => { clearTimeout(timer); rejectPromise(error) })
  })
  const toolCall = (name, args) => ({ type: 'tool-call-delta', index: 0, id: `call-${requestCount}`, name, argumentsDelta: JSON.stringify(args) })
  const llm = {
    async prepareCall(config) {
      return { config, stream: () => (async function* () {
        requestCount++
        if (requestCount === 1) {
          firstStreamStarted.resolve()
          await releaseFirstStream.promise
          yield toolCall('n01_origin_probe', { label: 'A-first-step' })
        } else if (requestCount === 2) {
          yield toolCall('tradeloom_scene_memory_write', { scene_id: 'scene-a', value: { owner: 'A', step: 2 } })
        } else if (requestCount === 3) {
          yield { type: 'text-delta', index: 0, text: 'A completed after its scene-memory write' }
        } else if (requestCount === 4) {
          yield toolCall('n01_origin_probe', { label: 'B-first-step' })
        } else if (requestCount === 5) {
          yield { type: 'text-delta', index: 0, text: 'B completed on the same driver' }
        } else if (requestCount === 6) {
          prooflessStreamStarted.resolve()
          await releaseProoflessStream.promise
          yield toolCall('n01_origin_probe', { label: 'C-first-step' })
        } else if (requestCount === 7) {
          yield toolCall('tradeloom_scene_memory_write', { scene_id: 'scene-a', value: { owner: 'proofless-steer-inject-must-not-write' } })
        } else if (requestCount === 8) {
          yield { type: 'text-delta', index: 0, text: 'Ordinary chat continues after unowned scene-memory refusal' }
        } else if (requestCount === 9) {
          yield toolCall('tradeloom_scene_memory_write', { scene_id: 'scene-a', value: { owner: 'cancelled-D-must-not-commit' } })
        } else if (requestCount === 10) {
          yield toolCall('n01_origin_probe', { label: 'E-survives-cancelled-D' })
        } else if (requestCount === 11) {
          yield { type: 'text-delta', index: 0, text: 'E completed after D cancellation' }
        } else if (requestCount === 12) {
          yield { type: 'text-delta', index: 0, text: 'Ordinary proofless wake completed after the preserved E turn' }
        } else if (requestCount === 13) {
          ambiguousBaseStreamStarted.resolve()
          await releaseAmbiguousBase.promise
          yield { type: 'text-delta', index: 0, text: 'Base step continues while two verified inputs are queued' }
        } else if (requestCount === 14) {
          yield toolCall('tradeloom_scene_memory_write', { scene_id: 'scene-a', value: { owner: 'ambiguous-F-G-must-not-write' } })
        } else if (requestCount === 15) {
          yield { type: 'text-delta', index: 0, text: 'Ordinary chat continues after ambiguous scene-memory refusal' }
        } else if (requestCount === 16) {
          expiredBaseStreamStarted.resolve()
          await releaseExpiredBase.promise
          yield toolCall('tradeloom_scene_memory_write', { scene_id: 'scene-a', value: { owner: 'expired-A-must-not-write' } })
        } else if (requestCount === 17) {
          yield { type: 'text-delta', index: 0, text: 'Ordinary chat continues after expired A refusal' }
        } else if (requestCount === 18) {
          yield toolCall('n01_origin_probe', { label: 'B-after-A-expired' })
        } else if (requestCount === 19) {
          yield { type: 'text-delta', index: 0, text: 'B completed after A expired' }
        } else if (requestCount === 20) {
          plainExpiredStreamStarted.resolve()
          await releasePlainExpired.promise
          yield { type: 'text-delta', index: 0, text: 'Ordinary chat completes after its origin expires' }
        } else if (requestCount === 21) {
          yield toolCall('n01_origin_probe', { label: 'B-after-plain-expired-A' })
        } else if (requestCount === 22) {
          yield { type: 'text-delta', index: 0, text: 'B completes after plain expired A' }
        } else {
          throw new Error(`unexpected model request ${requestCount}`)
        }
        yield { type: 'finish', reason: { kind: 'stop' } }
      })() }
    },
  }
  ctx = new Context()
  ctx.provide('sceneMemoryOriginAuthority', observedAuthority)
  ctx.provide('llm', llm)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(SystemPrompt)
  const tools = new ToolRuntime(ctx, { mode: 'native' })
  registerBusinessTools({ tools }, { preset: 'tradeloom-center' }, { sceneMemoryOriginAuthority: observedAuthority })
  const probeOrigins = []
  tools.register({
    name: 'n01_origin_probe', description: 'Observe actual ToolRuntime execution origin',
    parameters: { type: 'object', properties: { label: { type: 'string' } }, required: ['label'], additionalProperties: false },
    output: { schema: { type: 'object', properties: { label: { type: 'string' } }, required: ['label'], additionalProperties: false }, render: () => [] },
    execute: async ({ label }) => {
      const exec = observedAuthority.currentToolExecution()
      probeOrigins.push({ label, operationId: exec?.operationOrigin?.operationId })
      return { label }
    },
  })
  await ctx.plugin(AgentLoop, { agents: [], maxParallelToolCalls: 1 })
  const agent = await ctx.get('agentLoop').create('n01-a-b-driver-session', { provider: 'n01-fixture', model: 'n01-fixture' })
  const driverErrors = []
  ctx.on('agent/error', event => { if (event?.agent === agent) driverErrors.push(event.error) })
  await hostOriginAccessors.withVerifiedRequestOrigin(a.origin, async () => agent.send(userMessage('request A'), 'next-turn', true))
  await withTimeout(firstStreamStarted.promise, 5000, `AgentLoop never reached its first model request (driverStarts=${driverStarts}, requestCount=${requestCount}): ${driverErrors.map(error => error?.stack ?? `${error?.code ?? ''} ${error?.message ?? error}`).join(' | ')}`)
  const queueWorkId = agent.operationOriginLedger?.workById.keys().next().value
  const queueSnapshot = Object.freeze({ ...a.origin })
  const foreignAgent = await ctx.get('agentLoop').create('n01-foreign-queue-owner', {})
  assert.equal(authority.captureQueuedOrigin(queueSnapshot, queueWorkId, agent), a.origin)
  assert.throws(() => authority.captureQueuedOrigin(queueSnapshot, 'unknown-work-id', agent), { code: 'invalid_operation_work' })
  assert.throws(() => authority.captureQueuedOrigin(queueSnapshot, queueWorkId, foreignAgent), { code: 'operation_work_owner_mismatch' })
  assert.throws(() => authority.captureQueuedOrigin({ ...queueSnapshot, bodyDigest: 'wrong-tuple' }, queueWorkId, agent), { code: 'operation_not_active' })
  assert.throws(() => authority.captureAtEnqueue(queueSnapshot), { code: 'operation_not_active' }, 'a serialized tuple without its registered queue work is not a general authority token')
  const ackState = await f.stateStore.read()
  assert.equal(ackState.sceneMemoryOperations?.[a.origin.operationId]?.status, 'active', 'RPC ACK must not terminalize queued background work')
  assert.equal(ackState.sceneMemories?.['scene-a'], undefined, 'background write has not run before the held model step')
  await hostOriginAccessors.withVerifiedRequestOrigin(b.origin, async () => agent.send(userMessage('request B'), 'next-turn', true))
  releaseFirstStream.resolve()
  await withTimeout(agent.whenIdle(), 10000, `AgentLoop driver did not become idle: ${driverErrors.map(error => `${error?.code ?? ''} ${error?.message ?? error}`).join(' | ')}`)
  assert.equal(requestCount, 5, JSON.stringify({
    driverErrors: driverErrors.map(error => ({ code: error?.code, message: error?.message, stack: error?.stack })),
    phase: agent.phase?.kind,
    inbox: { nextStep: agent.inbox?.nextStep?.length, nextTurn: agent.inbox?.nextTurn?.length, hasPending: agent.inbox?.hasPending },
    turnEnds: agent.session.snapshotEvents().filter(event => event.kind === 'turn/end').map(event => event.data?.reason),
  }))
  assert.equal(driverStarts, 1, 'A and B must run through one AgentLoop driver')
  assert.deepEqual(probeOrigins, [
    { label: 'A-first-step', operationId: a.origin.operationId },
    { label: 'B-first-step', operationId: b.origin.operationId },
  ])
  const afterAb = await f.stateStore.read()
  assert.deepEqual(afterAb.sceneMemories?.['scene-a']?.value, { owner: 'A', step: 2 }, 'distinct operations on one scene share the same scene store')
  assert.equal(afterAb.sceneMemoryOperations?.[a.origin.operationId]?.status, 'terminal')
  assert.equal(afterAb.sceneMemoryOperations?.[b.origin.operationId]?.status, 'terminal')
  await assert.rejects(authority.transactSceneMemory(a.origin, 'write', 'scene-a', { late: true }), { code: 'operation_terminal' })
  await assert.rejects(authority.transactSceneMemory(b.origin, 'write', 'scene-a', { late: true }), { code: 'operation_terminal' })
  const c = await claim(authority, f.home, 'agent/send', Buffer.from('{"method":"agent/send","rpcId":"C"}'))
  await hostOriginAccessors.withVerifiedRequestOrigin(c.origin, async () => agent.send(userMessage('request C'), 'next-turn', true))
  await withTimeout(prooflessStreamStarted.promise, 5000, 'AgentLoop did not start the mixed proofless steer/inject turn')
  await authority.withProoflessRequestOrigin(async () => {
    agent.steer(userMessage('proofless steer B'))
    agent.inject(userMessage('proofless inject B'))
  })
  releaseProoflessStream.resolve()
  await withTimeout(agent.whenIdle(), 10000, 'AgentLoop did not finish the mixed proofless steer/inject turn')
  assert.equal(requestCount, 8)
  assert.equal(driverStarts, 2, 'the second scenario must use one new driver after the prior A/B driver completed')
  assert.deepEqual(driverErrors, [], JSON.stringify(driverErrors.map(error => ({ code: error?.code, message: error?.message, stack: error?.stack }))))
  assert.deepEqual(probeOrigins[2], { label: 'C-first-step', operationId: c.origin.operationId })
  const mixedEvents = agent.session.snapshotEvents()
  const prooflessResult = mixedEvents.find(event => event.type === 'tool/result' && event.data?.message?.toolCallId === 'call-7')
  assert.ok(prooflessResult, JSON.stringify(mixedEvents.filter(event => event.type === 'tool/result').map(event => ({ callId: event.data?.callId, message: event.data?.message }))))
  assert.equal(prooflessResult.data.message.isError, false, 'the ordinary business-tool refusal remains a typed result, not a transport exception')
  const prooflessToolText = prooflessResult.data.message.content.find(item => item.type === 'text')?.text ?? ''
  assert.equal(JSON.parse(prooflessToolText).error_code, 'scene_memory_origin_required')
  assert.ok(mixedEvents.some(event => event.type === 'assistant/message' && JSON.stringify(event.data?.message?.content ?? []).includes('Ordinary chat continues after unowned scene-memory refusal')), 'the ordinary chat response after proofless SCM refusal is persisted in the actual session')
  const afterMixed = await f.stateStore.read()
  assert.deepEqual(afterMixed.sceneMemories?.['scene-a']?.value, { owner: 'A', step: 2 }, 'proofless steer/inject must not borrow C to write scene memory')
  assert.equal(afterMixed.sceneMemoryOperations?.[c.origin.operationId]?.status, 'terminal')
  await assert.rejects(authority.transactSceneMemory(c.origin, 'write', 'scene-a', { late: true }), { code: 'operation_terminal' })
  const d = await claim(authority, f.home, 'agent/send', Buffer.from('{"method":"agent/send","rpcId":"D"}'))
  const e = await claim(authority, f.home, 'agent/send', Buffer.from('{"method":"agent/send","rpcId":"E"}'))
  cancelCommitOperationId = d.origin.operationId
  holdCancelledCommit = true
  const sceneBeforeCancel = afterMixed.sceneMemories?.['scene-a']?.value
  await hostOriginAccessors.withVerifiedRequestOrigin(d.origin, async () => agent.send(userMessage('request D will be cancelled before scene-memory commit'), 'next-turn', true))
  await withTimeout(cancelWriteStarted.promise, 5000, `D did not reach the real precommit barrier (requests=${requestCount}; errors=${driverErrors.map(error => error?.stack ?? error).join('|')})`)
  await hostOriginAccessors.withVerifiedRequestOrigin(d.origin, async () => foreignAgent.send(userMessage('additional D holder stays pending on another agent'), 'next-turn', false))
  await hostOriginAccessors.withVerifiedRequestOrigin(e.origin, async () => agent.send(userMessage('E was queued before D cancellation'), 'next-turn', true))
  assert.ok(agent.inbox.nextTurn.some(message => message.content?.[0]?.text === 'E was queued before D cancellation'), 'E is already pending before cancellation')
  agent.cancel({ kind: 'user' }, { keepInbox: true })
  let dWasTerminalizing = false
  for (let attempt = 0; attempt < 40 && !dWasTerminalizing; attempt++) {
    await new Promise(resolvePromise => setTimeout(resolvePromise, 0))
    try { authority.captureAtEnqueue(d.origin) }
    catch (error) {
      if (['operation_not_active', 'operation_terminal_pending'].includes(error?.code)) dWasTerminalizing = true
      else throw error
    }
  }
  assert.equal(dWasTerminalizing, true, 'cancel must close D authority before the blocked state transaction resumes')
  releaseCancelledWrite.resolve()
  await withTimeout(agent.whenIdle(), 10000, `AgentLoop did not stop D after cancellation: ${driverErrors.map(error => `${error?.code ?? ''} ${error?.message ?? error}`).join(' | ')}`)
  assert.ok(agent.inbox.nextTurn.some(message => message.content?.[0]?.text === 'E was queued before D cancellation'), 'keepInbox:true leaves the original E message pending after D ends')
  await authority.withProoflessRequestOrigin(async () => agent.send(userMessage('ordinary chat wakes the preserved E message'), 'next-turn', true))
  await withTimeout(agent.whenIdle(), 10000, `AgentLoop did not process preserved E after a later ordinary request: ${driverErrors.map(error => `${error?.code ?? ''} ${error?.message ?? error}`).join(' | ')}`)
  assert.deepEqual(driverErrors, [], JSON.stringify(driverErrors.map(error => ({ code: error?.code, message: error?.message, stack: error?.stack }))))
  assert.equal(requestCount, 12, JSON.stringify({ requestCount, driverStarts, inbox: { nextStep: agent.inbox?.nextStep?.length, nextTurn: agent.inbox?.nextTurn?.length, hasPending: agent.inbox?.hasPending } }))
  assert.deepEqual(probeOrigins.at(-1), { label: 'E-survives-cancelled-D', operationId: e.origin.operationId })
  const eMessageEvents = agent.session.snapshotEvents().filter(event => event.type === 'user/message' && event.data?.content?.[0]?.text === 'E was queued before D cancellation')
  assert.equal(eMessageEvents.length, 1, 'the pre-cancel E message is consumed exactly once')
  const afterCancelledWrite = await f.stateStore.read()
  assert.deepEqual(afterCancelledWrite.sceneMemories?.['scene-a']?.value, sceneBeforeCancel, 'D cancellation prevents its precommit mutation while preserving earlier A data')
  assert.equal(afterCancelledWrite.sceneMemoryOperations?.[d.origin.operationId]?.status, 'terminal')
  assert.equal(afterCancelledWrite.sceneMemoryOperations?.[e.origin.operationId]?.status, 'terminal')
  const cancelledWriteResult = agent.session.snapshotEvents().find(event => event.type === 'tool/result' && event.data?.message?.toolCallId === 'call-9')
  assert.ok(cancelledWriteResult, 'the cancelled D scene-memory call returns through the real ToolRuntime/session result path')
  const cancelledWriteText = cancelledWriteResult.data.message.content.find(item => item.type === 'text')?.text ?? ''
  assert.equal(cancelledWriteResult.data.message.isError, true)
  assert.deepEqual(cancelledWriteResult.data.error, { name: 'AbortError', code: 'ABORTED' })
  assert.equal(cancelledWriteText, 'Error: tool call aborted', 'the actual SDK surfaces cancellation as its typed tool-abort result while state readback proves the pending write did not commit')
  await assert.rejects(authority.transactSceneMemory(d.origin, 'write', 'scene-a', { late: true }), { code: 'operation_terminal' })
  const fOwner = await claim(authority, f.home, 'agent/send', Buffer.from('{"method":"agent/send","rpcId":"F"}'))
  const gOwner = await claim(authority, f.home, 'agent/send', Buffer.from('{"method":"agent/send","rpcId":"G"}'))
  const sceneBeforeAmbiguous = afterCancelledWrite.sceneMemories?.['scene-a']?.value
  await authority.withProoflessRequestOrigin(async () => agent.send(userMessage('plain chat starts the turn before injected verified inputs'), 'next-turn', true))
  await withTimeout(ambiguousBaseStreamStarted.promise, 5000, `AgentLoop did not hold the base step before verified injections (requestCount=${requestCount})`)
  await hostOriginAccessors.withVerifiedRequestOrigin(fOwner.origin, async () => agent.steer(userMessage('verified F enters next step')))
  await hostOriginAccessors.withVerifiedRequestOrigin(gOwner.origin, async () => agent.inject(userMessage('verified G enters the same next step')))
  releaseAmbiguousBase.resolve()
  await withTimeout(agent.whenIdle(), 10000, `AgentLoop did not complete the mixed verified-origin step: ${driverErrors.map(error => `${error?.code ?? ''} ${error?.message ?? error}`).join(' | ')}`)
  assert.deepEqual(driverErrors, [], JSON.stringify(driverErrors.map(error => ({ code: error?.code, message: error?.message, stack: error?.stack }))))
  assert.equal(requestCount, 15, JSON.stringify({ requestCount, inbox: { nextStep: agent.inbox?.nextStep?.length, nextTurn: agent.inbox?.nextTurn?.length, hasPending: agent.inbox?.hasPending } }))
  const ambiguousResult = agent.session.snapshotEvents().find(event => event.type === 'tool/result' && event.data?.message?.toolCallId === 'call-14')
  assert.ok(ambiguousResult)
  const ambiguousText = ambiguousResult.data.message.content.find(item => item.type === 'text')?.text ?? ''
  assert.equal(JSON.parse(ambiguousText).error_code, 'ambiguous_operation_origin')
  assert.deepEqual((await f.stateStore.read()).sceneMemories?.['scene-a']?.value, sceneBeforeAmbiguous, 'a step carrying two verified origins cannot write under either owner')
  assert.equal((await f.stateStore.read()).sceneMemoryOperations?.[fOwner.origin.operationId]?.status, 'terminal')
  assert.equal((await f.stateStore.read()).sceneMemoryOperations?.[gOwner.origin.operationId]?.status, 'terminal')
  assert.ok(agent.session.snapshotEvents().some(event => event.type === 'assistant/message' && JSON.stringify(event.data?.message?.content ?? []).includes('Ordinary chat continues after ambiguous scene-memory refusal')))
  const expiredSceneBefore = (await f.stateStore.read()).sceneMemories?.['scene-a']?.value
  const expiredA = await claim(authority, f.home, 'agent/send', Buffer.from('{"method":"agent/send","rpcId":"expired-A"}'))
  const startsBeforeExpired = driverStarts
  await hostOriginAccessors.withVerifiedRequestOrigin(expiredA.origin, async () => agent.send(userMessage('A is held while its operation expires'), 'next-turn', true))
  await withTimeout(expiredBaseStreamStarted.promise, 5000, `AgentLoop did not hold the expiring A step (requestCount=${requestCount})`)
  clockNow = expiredA.origin.activeUntil + 1
  const freshB = await claim(authority, f.home, 'agent/send', Buffer.from('{"method":"agent/send","rpcId":"fresh-B-after-expiry"}'))
  await hostOriginAccessors.withVerifiedRequestOrigin(freshB.origin, async () => agent.send(userMessage('B remains authorized after A expires'), 'next-turn', true))
  releaseExpiredBase.resolve()
  await withTimeout(agent.whenIdle(), 10000, `AgentLoop stopped after expired A: ${driverErrors.map(error => error?.stack ?? error).join(' | ')}`)
  assert.deepEqual(driverErrors, [], JSON.stringify(driverErrors.map(error => ({ code: error?.code, message: error?.message, stack: error?.stack }))))
  assert.equal(requestCount, 19)
  assert.equal(driverStarts, startsBeforeExpired + 1, 'expired A and fresh B continue on one AgentLoop driver')
  assert.deepEqual(probeOrigins.at(-1), { label: 'B-after-A-expired', operationId: freshB.origin.operationId })
  const expiredWriteResult = agent.session.snapshotEvents().find(event => event.type === 'tool/result' && event.data?.message?.toolCallId === 'call-16')
  assert.ok(expiredWriteResult)
  assert.equal(expiredWriteResult.data.message.isError, true)
  assert.match(expiredWriteResult.data.message.content.find(item => item.type === 'text')?.text ?? '', /operation_not_active|operation_expired/)
  assert.deepEqual((await f.stateStore.read()).sceneMemories?.['scene-a']?.value, expiredSceneBefore, 'A expired before scene-memory commit and cannot block B or ordinary chat')
  assert.ok(agent.session.snapshotEvents().some(event => event.type === 'assistant/message' && JSON.stringify(event.data?.message?.content ?? []).includes('Ordinary chat continues after expired A refusal')))
  const plainExpiredA = await claim(authority, f.home, 'agent/send', Buffer.from('{"method":"agent/send","rpcId":"plain-expired-A"}'))
  const startsBeforePlainExpiry = driverStarts
  await hostOriginAccessors.withVerifiedRequestOrigin(plainExpiredA.origin, async () => agent.send(userMessage('A plain chat is held across expiry'), 'next-turn', true))
  await withTimeout(plainExpiredStreamStarted.promise, 5000, `AgentLoop did not hold plain expired A (requestCount=${requestCount}; errors=${driverErrors.map(error => error?.stack ?? error).join('|')})`)
  clockNow = plainExpiredA.origin.activeUntil - 1
  const freshCAfterPlainExpiry = await claim(authority, f.home, 'agent/send', Buffer.from('{"method":"agent/send","rpcId":"fresh-C-after-plain-expiry"}'))
  await hostOriginAccessors.withVerifiedRequestOrigin(freshCAfterPlainExpiry.origin, async () => agent.send(userMessage('B remains authorized after plain A expires'), 'next-turn', true))
  clockNow = plainExpiredA.origin.activeUntil + 1
  releasePlainExpired.resolve()
  await withTimeout(agent.whenIdle(), 10000, `AgentLoop stopped after plain expired A: ${driverErrors.map(error => error?.stack ?? error).join(' | ')}`)
  assert.deepEqual(driverErrors, [], JSON.stringify(driverErrors.map(error => ({ code: error?.code, message: error?.message, stack: error?.stack }))))
  assert.equal(requestCount, 22, JSON.stringify({ requestCount, driverStarts, inbox: { nextStep: agent.inbox?.nextStep?.length, nextTurn: agent.inbox?.nextTurn?.length, hasPending: agent.inbox?.hasPending } }))
  assert.equal(driverStarts, startsBeforePlainExpiry + 1, 'plain expired A and fresh C finish on one AgentLoop driver')
  assert.deepEqual(probeOrigins.at(-1), { label: 'B-after-plain-expired-A', operationId: freshCAfterPlainExpiry.origin.operationId })
  assert.ok(agent.session.snapshotEvents().some(event => event.type === 'assistant/message' && JSON.stringify(event.data?.message?.content ?? []).includes('Ordinary chat completes after its origin expires')))
  await ctx.fiber.dispose()
  disposed = true
})

test('bounded base64 grant bytes survive a real Node child-process IPC round trip', async t => {
  const root = await mkdtemp(join(privateRoot, 'origin-ipc-roundtrip-'))
  const target = resolve(root)
  if (!target.startsWith(`${privateRoot}${sep}`)) throw new Error('refusing to write IPC fixture outside N01 private marker')
  t.after(async () => await rm(target, { recursive: true, force: true }))
  const worker = join(root, 'worker.cjs')
  await writeFile(worker, `process.on('message', message => {\n  try {\n    if (message?.type !== 'scene-memory-origin-grant' || !Number.isSafeInteger(message.requestId)) throw Object.assign(new Error('invalid request'), { code: 'invalid_request' });\n    const encoded = message.request?.bodyBytesBase64;\n    if (typeof encoded !== 'string' || encoded.length > 4 * 1024 * 1024 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) throw Object.assign(new Error('invalid byte encoding'), { code: 'invalid_body_encoding' });\n    const bytes = Buffer.from(encoded, 'base64');\n    if (bytes.toString('base64') !== encoded) throw Object.assign(new Error('non-canonical byte encoding'), { code: 'invalid_body_encoding' });\n    process.send({ type: 'scene-memory-origin-grant', requestId: message.requestId, bodyBytesBase64: bytes.toString('base64') });\n  } catch (error) { process.send({ type: 'scene-memory-origin-grant', requestId: message?.requestId ?? -1, error: error.message, errorCode: error.code }); }\n});\n`)
  const child = fork(worker, [], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] })
  t.after(() => { if (!child.killed) child.kill() })
  const roundTrip = request => new Promise((resolvePromise, rejectPromise) => {
    const timer = setTimeout(() => rejectPromise(new Error('IPC response timed out')), 5_000)
    const onMessage = response => {
      if (response?.requestId !== request.requestId) return
      clearTimeout(timer)
      child.off('message', onMessage)
      resolvePromise(response)
    }
    child.on('message', onMessage)
    child.send(request, error => {
      if (!error) return
      clearTimeout(timer)
      child.off('message', onMessage)
      rejectPromise(error)
    })
  })
  const raw = Buffer.from([0, 0xff, 0x7b, 0x22, 0x78, 0x22, 0x3a, 0x31, 0x7d, 0x0a])
  const response = await roundTrip({ type: 'scene-memory-origin-grant', requestId: 31, request: { bodyBytesBase64: raw.toString('base64') } })
  assert.equal(response.type, 'scene-memory-origin-grant')
  assert.deepEqual(Buffer.from(response.bodyBytesBase64, 'base64'), raw)
  const rejected = await roundTrip({ type: 'scene-memory-origin-grant', requestId: 32, request: { bodyBytesBase64: '%%%=' } })
  assert.equal(rejected.errorCode, 'invalid_body_encoding')
})

test('actual Main grant handler and pinned Host SDK IPC listener preserve owner and bytes', { timeout: 30000 }, async t => {
  const root = await mkdtemp(join(privateRoot, 'origin-main-host-ipc-'))
  const target = resolve(root)
  if (!target.startsWith(`${privateRoot}${sep}`)) throw new Error('refusing to write Main/Host fixture outside N01 private marker')
  let child
  t.after(async () => {
    if (child && child.exitCode === null && child.signalCode === null && child.connected) child.send({ type: 'n01-test-shutdown' })
    if (child && child.exitCode === null && child.signalCode === null) await Promise.race([
      new Promise(resolvePromise => child.once('exit', resolvePromise)),
      new Promise(resolvePromise => setTimeout(resolvePromise, 2000)),
    ])
    if (child && child.exitCode === null && child.signalCode === null) child.kill()
    child?.unref()
    child?.channel?.unref()
    await rm(target, { recursive: true, force: true })
  })
  const repo = resolve(fileURLToPath(new URL('../../..', import.meta.url)))
  const mainPath = join(repo, 'apps/tradeloom-launcher/accepted-runtime/lib/main.js')
  const mainSource = await readFile(mainPath, 'utf8')
  const registrationStart = mainSource.indexOf('ipcMain.handle(DESKTOP_IPC.sceneMemoryOriginGrant, async (event, request) => {')
  const registrationEnd = mainSource.indexOf('\n\tipcMain.handle(DESKTOP_IPC.boot', registrationStart)
  assert.ok(registrationStart >= 0 && registrationEnd > registrationStart)
  const mainRegistration = mainSource.slice(registrationStart, registrationEnd).trim()
  let registeredMainHandler
  const mainContext = {
    ipcMain: { handle(channel, handler) { assert.equal(channel, 'dsh-desktop:scene-memory-origin-grant'); registeredMainHandler = handler } },
    DESKTOP_IPC: { sceneMemoryOriginGrant: 'dsh-desktop:scene-memory-origin-grant', boot: 'dsh-desktop:boot' },
    assertDesktopSender(event, kinds) { assert.equal(event.senderKind, 'app'); assert.deepEqual(Array.from(kinds), ['app']) },
    sourceMode: true, sourceController: undefined, mainWindow: undefined, backend: undefined,
    Buffer, Uint8Array, Number, Array, Object, Promise, Error,
  }
  runInNewContext(`(() => { ${mainRegistration}; })()`, mainContext)
  assert.equal(typeof registeredMainHandler, 'function')

  const mainClassStart = mainSource.indexOf('var DesktopHostProcess = class {')
  const methodStart = mainSource.indexOf('\tasync control(request, deadlineMs, deadlineMessage) {', mainClassStart)
  const methodEnd = mainSource.indexOf('\n\t/**\n\t* Request teardown', methodStart)
  const messageStart = mainSource.indexOf('\t\tchild.on("message", (message) => {', mainClassStart)
  const messageEnd = mainSource.indexOf('\n\t\tchild.once("error"', messageStart)
  assert.ok(mainClassStart >= 0 && methodStart >= 0 && methodEnd > methodStart && messageStart >= 0 && messageEnd > messageStart)
  const methods = runInNewContext(`new (class {${mainSource.slice(methodStart, methodEnd)}})`, { setTimeout, clearTimeout, Promise, Error, Number, String, Object })
  const responseHandler = mainSource.slice(messageStart, messageEnd).replace(/\n\t\t\}\);\s*$/, '\n\t\t});')
  const responseHandlerFactory = runInNewContext(`(function(child) { ${responseHandler} })`, {
    isDesktopHostEvent(message) { return Boolean(message && (message.type === 'n01-test-observation' || message.type === 'scene-memory-origin-grant')) },
    observeStartup() {}, DesktopHostFatalError: Error, Error, Number, String, Object, Promise, console,
  })

  const sdkNodeModules = process.env.N01_SDK_NODE_MODULES
  assert.ok(sdkNodeModules, 'explicit SDK execution copy path is required')
  const sdkHostPath = join(privateRoot, 'sdk-patch-work/dsh-desktop-host/lib/index.js')
  const sdkHostSource = await readFile(sdkHostPath, 'utf8')
  const decoderStart = sdkHostSource.indexOf('\tcontrol.registerSceneMemoryOriginGrant = async (request) => {')
  const decoderEnd = sdkHostSource.indexOf('\n\tcontrol.updateTasks', decoderStart)
  const listenerStart = sdkHostSource.indexOf('\tprocess.on("message", (message) => {')
  const listenerEnd = sdkHostSource.indexOf('\n\tprocess.once("disconnect"', listenerStart)
  assert.ok(decoderStart >= 0 && decoderEnd > decoderStart && listenerStart >= 0 && listenerEnd > listenerStart)
  const worker = join(root, 'host-ipc-worker.cjs')
  const workerSource = `
const control = {};
const stopping = undefined;
const send = message => new Promise((resolve, reject) => process.send(message, error => error ? reject(error) : resolve()));
const cancelNativeImports = () => {};
const finishNativeImport = () => {};
const stop = () => process.exit(0);
const ctx = { get(name) { if (name !== 'sceneMemoryOriginAuthority') throw new Error('unexpected provider'); return authority; } };
const authority = { async registerGrant(request) {
  process.send({ type: 'n01-test-observation', endpoint: request.endpoint, source: request.source, bodyBase64: request.bodyBytes.toString('base64') });
  if (process.env.N01_TEST_HOST_DELAY === '1') await new Promise(resolve => setTimeout(resolve, 100));
  return { token: 'opaque-host-token', expiresAt: 123456, hostEpoch: 'host-epoch-fixture' };
} };
process.on('message', message => {
  if (message?.type === 'scene-memory-origin-grant' && Number.isSafeInteger(message.requestId)) {
    process.send({ type: 'scene-memory-origin-grant', requestId: message.requestId + 10000, grant: { token: 'wrong-correlation', expiresAt: 123456, hostEpoch: 'wrong-epoch' } });
  }
});
process.on('uncaughtException', error => { console.error(error.stack || error); process.exit(1); });
process.on('unhandledRejection', error => { console.error(error?.stack || error); process.exit(1); });
process.on('message', message => { if (message?.type === 'n01-test-shutdown') process.exit(0); });
${sdkHostSource.slice(decoderStart, decoderEnd)}
${sdkHostSource.slice(listenerStart, listenerEnd)}
`
  await writeFile(worker, workerSource, { flag: 'wx' })
  child = fork(worker, [], { cwd: root, env: { ...process.env, N01_TEST_HOST_DELAY: '1' }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] })
  let workerOutput = ''
  child.stdout.setEncoding('utf8').on('data', chunk => { workerOutput += chunk })
  child.stderr.setEncoding('utf8').on('data', chunk => { workerOutput += chunk })
  const host = Object.assign(methods, { child, controlRequests: new Map(), nextControlId: 1, failureReported: false, stopping: false, fail(error) { throw error } })
  responseHandlerFactory.call(host, child)

  let guest = { scope: 'role', generation: 8, sceneId: 'scene-a', panelId: 'panel-a', sessionId: 'session-a', bindingRevision: '12' }
  const frame = { id: 'main-frame' }
  const sender = { id: 55, mainFrame: frame, isDestroyed: () => false }
  let resolveGuestCalls = 0
  const observations = []
  child.on('message', message => { if (message.type === 'n01-test-observation') observations.push(message) })
  const waitForObservation = count => observations.length >= count ? Promise.resolve() : new Promise((resolvePromise, rejectPromise) => {
    const timer = setTimeout(() => {
      child.off('message', handler)
      rejectPromise(new Error(`Host SDK worker did not reach observation ${count}; worker output: ${workerOutput}`))
    }, 3000)
    const handler = message => {
      if (message.type !== 'n01-test-observation' || observations.length < count) return
      clearTimeout(timer)
      child.off('message', handler)
      resolvePromise()
    }
    child.on('message', handler)
  })
  const sceneMemoryRequest = async (endpoint, bodyBytes) => {
    mainContext.sourceMode = true
    mainContext.sourceController = { resolveGuest(currentSender, currentFrame) {
      assert.equal(currentSender, sender)
      assert.equal(currentFrame, frame)
      resolveGuestCalls++
      return guest
    } }
    mainContext.mainWindow = undefined
    mainContext.backend = { host }
    return await registeredMainHandler({ senderKind: 'app', sender, senderFrame: frame }, { endpoint, httpMethod: 'POST', bodyBytes })
  }
  const bodyBytes = Buffer.from([0x00, 0xff, 0x7b, 0x22, 0x6f, 0x6b, 0x22, 0x3a, 0x31, 0x7d])
  const longEndpoint = 'long.' + 'x'.repeat(200)
  const grant = await sceneMemoryRequest(longEndpoint, bodyBytes)
  assert.equal(grant.token, 'opaque-host-token')
  assert.equal(observations.length, 1)
  assert.equal(observations[0].endpoint, longEndpoint)
  assert.equal(observations[0].source.guestId, sender.id)
  assert.equal(observations[0].source.generation, 8)
  assert.deepEqual(Buffer.from(observations[0].bodyBase64, 'base64'), bodyBytes)
  const callsBeforeInvalid = resolveGuestCalls
  await assert.rejects(sceneMemoryRequest('bad//endpoint', bodyBytes), /invalid grant request/)
  await assert.rejects(sceneMemoryRequest('bad/../endpoint', bodyBytes), /invalid grant request/)
  assert.equal(resolveGuestCalls, callsBeforeInvalid)
  const wrongFrameEvent = { senderKind: 'app', sender, senderFrame: { id: 'subframe' } }
  await assert.rejects(registeredMainHandler(wrongFrameEvent, { endpoint: 'safe/path', httpMethod: 'POST', bodyBytes }), /unowned frame/)

  mainContext.sourceController = { resolveGuest() { return { ...guest, scope: 'account' } } }
  assert.equal(await registeredMainHandler({ senderKind: 'app', sender, senderFrame: frame }, { endpoint: 'safe/path', httpMethod: 'POST', bodyBytes }), null)

  guest = { scope: 'role', generation: 8, sceneId: 'scene-a', panelId: 'panel-a', sessionId: 'session-a', bindingRevision: '12' }
  const frameRace = sceneMemoryRequest('race/frame', bodyBytes)
  await waitForObservation(2)
  sender.mainFrame = { id: 'replacement-frame' }
  await assert.rejects(frameRace, /role guest changed while grant was pending/)
  sender.mainFrame = frame

  const generationRace = sceneMemoryRequest('race/generation', bodyBytes)
  await waitForObservation(3)
  guest = { ...guest, generation: 9 }
  await assert.rejects(generationRace, /role guest changed while grant was pending/)
  guest = { ...guest, generation: 8 }

  const sessionRace = sceneMemoryRequest('race/session', bodyBytes)
  await waitForObservation(4)
  guest = { ...guest, sessionId: 'session-replaced' }
  await assert.rejects(sessionRace, /role guest changed while grant was pending/)
  guest = { ...guest, sessionId: 'session-a' }

  await assert.rejects(host.issueSceneMemoryOriginGrant({ endpoint: 'safe/path', httpMethod: 'POST', bodyBytesBase64: '%%%=' }), { code: 'invalid_request_body' })
})

test('actual Main grant through Host control and SDK gateway reaches AgentLoop scene-memory consumer', { timeout: 30000, skip: !pinnedBrowserClientPath || !pinnedPatchedConnectionPath || !sdkNodeModules }, async t => {
  const f = await fixture(t)
  const oldAppHome = process.env.TRADELOOM_DSH_APP_HOME
  const oldDshHome = process.env.DSH_HOME
  let ctx
  let restore
  let sceneMemoryOriginAuthority
  t.after(async () => {
    try {
      restore?.()
      if (ctx?.fiber) await ctx.fiber.dispose()
      if (sceneMemoryOriginAuthority?.dispose) await sceneMemoryOriginAuthority.dispose()
    } finally {
      if (oldAppHome === undefined) delete process.env.TRADELOOM_DSH_APP_HOME
      else process.env.TRADELOOM_DSH_APP_HOME = oldAppHome
      if (oldDshHome === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = oldDshHome
    }
  })
  process.env.TRADELOOM_DSH_APP_HOME = f.home
  process.env.DSH_HOME = f.home
  const workspacePath = await roleWorkspacePath('center', f.env)
  await f.stateStore.transact(state => replaceRoleBinding(state, 'center', {
    sessionId: 'session-a', workspaceId: 'workspace-a', workspacePath, agentPreset: 'tradeloom-center',
  }))
  const roleState = await f.stateStore.read()
  const expectedIssuer = { ...issuer(f.home), sceneId: 'center', panelId: 'native-chat', workspacePath, bindingRevision: getRoleBindingRevision(roleState, 'center') }
  const withTimeout = (promise, milliseconds, message) => new Promise((resolvePromise, rejectPromise) => {
    const timer = setTimeout(() => rejectPromise(new Error(message)), milliseconds)
    Promise.resolve(promise).then(value => { clearTimeout(timer); resolvePromise(value) }, error => { clearTimeout(timer); rejectPromise(error) })
  })
  const repo = resolve(fileURLToPath(new URL('../../..', import.meta.url)))
  const mainSource = await readFile(join(repo, 'apps/tradeloom-launcher/accepted-runtime/lib/main.js'), 'utf8')
  const senderGuardStart = mainSource.indexOf('function assertDesktopSender(event, hostnames) {')
  const senderGuardEnd = mainSource.indexOf('\n/** Register the fixed account-sidebar command boundary', senderGuardStart)
  assert.ok(senderGuardStart >= 0 && senderGuardEnd > senderGuardStart)
  const assertDesktopSender = runInNewContext(`(() => { ${mainSource.slice(senderGuardStart, senderGuardEnd)}; return assertDesktopSender })()`, { URL, Error })
  const mainRegistrationStart = mainSource.indexOf('ipcMain.handle(DESKTOP_IPC.sceneMemoryOriginGrant, async (event, request) => {')
  const mainRegistrationEnd = mainSource.indexOf('\n\tipcMain.handle(DESKTOP_IPC.boot', mainRegistrationStart)
  assert.ok(mainRegistrationStart >= 0 && mainRegistrationEnd > mainRegistrationStart)
  let mainHandler
  const sourceShellWindow = { frame: { url: 'dsh-app://app/source-shell/main.html' }, isDestroyed: () => false }
  const sourceOwner = createSurfaceOwner(sourceShellWindow)
  const sender = { id: expectedIssuer.guestId, mainFrame: { url: 'dsh-app://app/source-shell/renderer/scene-entry.html' }, isDestroyed: () => false }
  const frame = sender.mainFrame
  const roleView = { webContents: sender }
  const roleWrapper = { get frame() { return sender.mainFrame }, destroy() {} }
  sourceOwner.attach({ sceneId: expectedIssuer.sceneId, panelId: expectedIssuer.panelId, sessionId: expectedIssuer.sessionId, view: roleWrapper, partition: 'persist:n01-private-fixture' })
  const roleRecord = {
    failed: false, view: roleView, wrapper: roleWrapper, parent: sourceShellWindow,
    sceneId: expectedIssuer.sceneId, panelId: expectedIssuer.panelId, sessionId: expectedIssuer.sessionId,
    bindingRevision: expectedIssuer.bindingRevision, generation: expectedIssuer.generation,
  }
  const sourceControllerPath = join(repo, 'apps/tradeloom-launcher/accepted-runtime/lib/tradeloom-source-shell/source-shell-controller.mjs')
  const sourceControllerSource = await readFile(sourceControllerPath, 'utf8')
  const resolveGuestStart = sourceControllerSource.indexOf('    resolveGuest(contents,frame) {')
  const resolveGuestEnd = sourceControllerSource.indexOf('\n    isGuest(contents,frame)', resolveGuestStart)
  assert.ok(resolveGuestStart >= 0 && resolveGuestEnd > resolveGuestStart)
  const resolveGuest = runInNewContext(`({${sourceControllerSource.slice(resolveGuestStart, resolveGuestEnd)}}).resolveGuest`, {
    sceneComponent: undefined, erpNextStatusComponent: undefined, accountSidebar: undefined, account: undefined,
    componentDockOwner() { return undefined }, componentPopouts: new Map(), main: sourceShellWindow,
    views: new Map([[JSON.stringify([expectedIssuer.sceneId, expectedIssuer.panelId]), roleRecord]]),
    registry: sourceOwner, key: (sceneId, panelId) => JSON.stringify([sceneId, panelId]), rolePopouts: new Map(),
  }, { filename: sourceControllerPath })
  const sourceController = { resolveGuest }
  const resolvedRoleGuest = sourceController.resolveGuest(sender, frame)
  assert.equal(resolvedRoleGuest.window, sourceShellWindow)
  assert.equal(resolvedRoleGuest.view, roleView)
  assert.equal(resolvedRoleGuest.sceneId, expectedIssuer.sceneId)
  assert.equal(resolvedRoleGuest.panelId, expectedIssuer.panelId)
  assert.equal(resolvedRoleGuest.sessionId, expectedIssuer.sessionId)
  assert.equal(resolvedRoleGuest.bindingRevision, expectedIssuer.bindingRevision)
  assert.equal(resolvedRoleGuest.generation, expectedIssuer.generation)
  assert.equal(resolvedRoleGuest.scope, 'role')
  assert.equal(sourceController.resolveGuest({ id: sender.id, mainFrame: frame }, frame), undefined, 'same id with foreign contents is not an owned role guest')
  assert.equal(sourceController.resolveGuest(sender, { url: frame.url }), undefined, 'same URL with foreign frame identity is not an owned role guest')
  const mainContext = {
    ipcMain: { handle(channel, handler) { assert.equal(channel, 'dsh-desktop:scene-memory-origin-grant'); mainHandler = handler } },
    DESKTOP_IPC: { sceneMemoryOriginGrant: 'dsh-desktop:scene-memory-origin-grant', boot: 'dsh-desktop:boot' },
    assertDesktopSender,
    sourceMode: true,
    sourceController,
    mainWindow: undefined, backend: undefined, Buffer, Uint8Array, Number, Array, Object, Promise, Error,
  }
  runInNewContext(`(() => { ${mainSource.slice(mainRegistrationStart, mainRegistrationEnd).trim()}; })()`, mainContext)
  assert.equal(typeof mainHandler, 'function')
  await assert.rejects(mainHandler({ senderKind: 'app', sender, senderFrame: { url: 'dsh-app://attacker/source-shell/renderer/scene-entry.html' } }, {}), /rejected IPC from an unowned renderer/)

  const classStart = mainSource.indexOf('var DesktopHostProcess = class {')
  const controlStart = mainSource.indexOf('\tasync control(request, deadlineMs, deadlineMessage) {', classStart)
  const controlEnd = mainSource.indexOf('\n\t/**\n\t* Request teardown', controlStart)
  const messageStart = mainSource.indexOf('\t\tchild.on("message", (message) => {', classStart)
  const messageEnd = mainSource.indexOf('\n\t\tchild.once("error"', messageStart)
  assert.ok(classStart >= 0 && controlStart >= 0 && controlEnd > controlStart && messageStart >= 0 && messageEnd > messageStart)
  const mainMethods = runInNewContext(`new (class {${mainSource.slice(controlStart, controlEnd)}})`, { setTimeout, clearTimeout, Promise, Error, Number, String, Object })
  const mainMessageFactory = runInNewContext(`(function(child) { ${mainSource.slice(messageStart, messageEnd).replace(/\n\t\t\}\);\s*$/, '\n\t\t});')} })`, {
    isDesktopHostEvent(message) { return message?.type === 'scene-memory-origin-grant' },
    observeStartup() {}, DesktopHostFatalError: Error, Error, Number, String, Object, Promise, console,
  })

  const sdkHostSourcePath = join(privateRoot, 'sdk-patch-work/dsh-desktop-host/lib/index.js')
  const sdkHostSource = await readFile(sdkHostSourcePath, 'utf8')
  const hostControlStart = sdkHostSource.indexOf('\tcontrol.registerSceneMemoryOriginGrant = async (request) => {')
  const hostControlEnd = sdkHostSource.indexOf('\n\tcontrol.updateTasks', hostControlStart)
  const hostListenerStart = sdkHostSource.indexOf('\tprocess.on("message", (message) => {')
  const hostListenerEnd = sdkHostSource.indexOf('\n\tprocess.once("disconnect"', hostListenerStart)
  assert.ok(hostControlStart >= 0 && hostControlEnd > hostControlStart && hostListenerStart >= 0 && hostListenerEnd > hostListenerStart)

  const hostProcess = new EventEmitter()
  hostProcess.connected = true
  const child = new EventEmitter()
  child.connected = true
  hostProcess.send = (message, callback) => {
    setImmediate(() => { child.emit('message', JSON.parse(JSON.stringify(message))); callback?.(null) })
    return true
  }
  child.send = (message, callback) => {
    setImmediate(() => { hostProcess.emit('message', JSON.parse(JSON.stringify(message))); callback?.(null) })
    return true
  }
  hostProcess.disconnect = () => {}
  const control = {}
  const hostContext = { get(name) { assert.equal(name, 'sceneMemoryOriginAuthority'); return sceneMemoryOriginAuthority } }
  const hostSend = message => new Promise((resolvePromise, rejectPromise) => hostProcess.send(message, error => error ? rejectPromise(error) : resolvePromise()))
  const hostSandbox = {
    process: hostProcess, control, stopping: undefined, send: hostSend,
    cancelNativeImports() {}, finishNativeImport() {}, stop() {}, ctx: hostContext,
    Buffer, Number, Object, String, Promise, Error, setTimeout, clearTimeout, console,
  }
  runInNewContext(`${sdkHostSource.slice(hostControlStart, hostControlEnd)}\n${sdkHostSource.slice(hostListenerStart, hostListenerEnd)}`, hostSandbox, { filename: sdkHostSourcePath })
  const host = Object.assign(mainMethods, {
    child, controlRequests: new Map(), nextControlId: 1, failureReported: false, stopping: false,
    fail(error) { throw error },
  })
  mainMessageFactory.call(host, child)
  mainContext.backend = { host }

  const sdkRoot = process.env.N01_SDK_NODE_MODULES
  const importSdk = async (...parts) => await import(pathToFileURL(join(sdkRoot, ...parts)).href)
  const [{ Context }, { SessionStore }, { AgentRegistry }, { SessionProjectionRegistry }, { SystemPrompt }, { AgentLoop }, { ToolRuntime }, { createUserMessage }] = await Promise.all([
    importSdk('@deepseek-ai', 'cordis', 'lib', 'index.js'),
    importSdk('@deepseek-ai', 'dsh-session', 'lib', 'index.js'),
    importSdk('@deepseek-ai', 'dsh-agent', 'lib', 'index.js'),
    importSdk('@deepseek-ai', 'dsh-session-projection', 'lib', 'index.js'),
    importSdk('@deepseek-ai', 'dsh-system-prompt', 'lib', 'index.js'),
    importSdk('@deepseek-ai', 'dsh-agent-loop', 'lib', 'index.js'),
    importSdk('@deepseek-ai', 'dsh-tools', 'lib', 'index.js'),
    importSdk('@deepseek-ai', 'dsh-llm', 'lib', 'index.js'),
  ])
  const connectionModule = await importSdk('@deepseek-ai', 'dsh-client-connection', 'lib', 'index.js')
  let modelCalls = 0
  const llm = { async prepareCall(config) { return { config, stream: () => (async function* () {
    modelCalls++
    if (modelCalls === 1) yield { type: 'tool-call-delta', index: 0, id: 'call-main-host-consumer', name: 'tradeloom_scene_memory_write', argumentsDelta: JSON.stringify({ scene_id: 'center', value: { source: 'actual-sdk-main-host-chain' } }) }
    else if (modelCalls === 2) yield { type: 'text-delta', index: 0, text: 'The admitted scene-memory operation completed.' }
    else throw new Error(`unexpected model request ${modelCalls}`)
    yield { type: 'finish', reason: { kind: 'stop' } }
  })() } } }
  ctx = new Context()
  ctx.provide('llm', llm)
  const workspace = { id: 'workspace-a', path: workspacePath, sessionIds: ['session-a'] }
  ctx.provide('workspaceRegistry', {
    archivedSessionIds: [],
    get(id) { return id === workspace.id ? workspace : undefined },
    list() { return [workspace] },
  })
  const persistedSessions = new Map()
  const sessionPersistence = {
    identity: Object.freeze({ id: 'n01-session-persistence-fixture' }),
    async create(header) {
      if (persistedSessions.has(header.id)) throw new Error(`session "${header.id}" already exists`)
      const entry = { header: structuredClone(header), events: [] }
      persistedSessions.set(header.id, entry)
      let closed = false
      return {
        async append(events) { if (closed) throw new Error('fixture session handle is closed'); entry.events.push(...structuredClone(events)) },
        async flush() { if (closed) throw new Error('fixture session handle is closed') },
        async close() { closed = true },
      }
    },
    async flush() {},
    async stat(sessionId) { return persistedSessions.get(sessionId) },
  }
  ctx.provide('sessionPersistence', sessionPersistence)
  const webRoutes = new Map()
  ctx.provide('webServer', {
    protocol: 'http:', host: '127.0.0.1:43123',
    getOrigin() { return 'http://127.0.0.1:43123' },
    register(route) { webRoutes.set(route.path, route); return () => webRoutes.delete(route.path) },
  })
  ctx.provide('sessionController', {})
  ctx.provide('sessionQuery', {})
  const credentialRecords = new Map()
  ctx.provide('credentials', { async modifyRecord(key, update) {
    const current = credentialRecords.get(key)
    const replacement = await update(current)
    if (replacement !== undefined) credentialRecords.set(key, replacement)
    return credentialRecords.get(key)
  } })
  await ctx.plugin(connectionModule, { trustedHosts: [] })
  const connection = ctx.get('connection')
  const launchUrl = new URL(connection.authenticatedUrl('http://127.0.0.1:43123/'))
  let authResponse
  connection.authorizeIndex({ method: 'GET', url: `${launchUrl.pathname}${launchUrl.search}`, headers: { host: launchUrl.host } }, {
    writeHead(statusCode, headers) { authResponse = { statusCode, headers } }, end() {},
  })
  assert.equal(authResponse.statusCode, 303, 'actual BrowserAuth exchanges the process launch token for its signed cookie')
  const authCookie = authResponse.headers['set-cookie'].split(';', 1)[0]
  const admission = connection.admit({ method: 'POST', url: '/api/agent/send', headers: { host: '127.0.0.1:43123', origin: 'http://127.0.0.1:43123', cookie: authCookie } })
  assert.ok(admission.peer)
  assert.deepEqual(admission.peer.principal, { kind: 'owner' })
  assert.deepEqual(connection.admit({ method: 'POST', url: '/api/agent/send', headers: { host: '127.0.0.1:43123', origin: 'http://attacker.test', cookie: authCookie } }), { rejection: 403 }, 'actual HostConnectionService rejects a cross-origin request before RPC dispatch')
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(SystemPrompt)
  const tools = new ToolRuntime(ctx, { mode: 'native' })
  applyBusinessShellHost(ctx, {})
  sceneMemoryOriginAuthority = ctx.get('sceneMemoryOriginAuthority')
  assert.equal(typeof sceneMemoryOriginAuthority?.registerGrant, 'function')
  registerBusinessTools({ tools }, { preset: 'tradeloom-center' }, { sceneMemoryOriginAuthority })
  await ctx.plugin(AgentLoop, { agents: [], maxParallelToolCalls: 1 })
  const agent = await ctx.get('agentLoop').create('session-a', { provider: 'n01-fixture', model: 'n01-fixture' }, { cwd: workspacePath, agentPreset: 'tradeloom-center' })
  const bindingResolver = createSourceShellBindingHandler(ctx, {
    createStateStore: async () => f.stateStore,
  })
  const bindingRequest = {
    method: 'POST',
    url: '/tradeloom/source-shell/resolve-binding',
    headers: { host: '127.0.0.1:43123', origin: 'http://127.0.0.1:43123', cookie: authCookie },
    async *[Symbol.asyncIterator]() { yield Buffer.from(JSON.stringify({ sceneId: 'center', panelId: 'native-chat', expectedSessionId: 'session-a' })) },
  }
  const bindingResponse = { headers: {}, setHeader(name, value) { this.headers[name] = value }, end(value) { this.body = value } }
  await bindingResolver(bindingRequest, bindingResponse)
  assert.equal(bindingResponse.statusCode, 200, 'actual Host source-shell resolver admits the live role/scenes/workspace/session tuple')
  const resolvedBinding = JSON.parse(bindingResponse.body)
  assert.equal(resolvedBinding.sessionId, expectedIssuer.sessionId)
  assert.equal(resolvedBinding.bindingRevision, expectedIssuer.bindingRevision)
  let admittedOrigin
  const driverErrors = []
  ctx.on('agent/error', event => { if (event?.agent === agent) driverErrors.push(event.error) })
  const connectionService = ctx.get('connection')
  connectionService.rpc.intercept('/api', endpoint => endpoint === 'agent/send', async (endpoint, payload, _signal, peer) => {
    assert.equal(endpoint, 'agent/send')
    assert.equal(peer.id, admission.peer.id, 'the registered Host route admits the BrowserAuth owner peer for this Request')
    assert.deepEqual(peer.principal, { kind: 'owner' })
    admittedOrigin = sceneMemoryOriginAuthority.currentRequestOrigin()
    assert.equal(admittedOrigin?.sessionId, 'session-a')
    await agent.send(createUserMessage({ content: [{ type: 'text', text: payload.text }], source: { kind: 'user' } }), 'next-turn', true)
    return { ok: true, value: 'queued' }
  })
  const interceptorRecord = connectionService.interceptors.get('/api')
  const originalFetchHandler = interceptorRecord.fetchHandler.fetch
  let observedHostRequest
  interceptorRecord.fetchHandler.fetch = async (request, peer) => {
    observedHostRequest = { constructor: request?.constructor?.name, hasHeaders: request?.headers !== undefined, headersConstructor: request?.headers?.constructor?.name, grantHeader: request?.headers?.get?.('x-tradeloom-origin-grant') }
    return await originalFetchHandler(request, peer)
  }
  assert.ok(webRoutes.has('/api'), 'the real Connection plugin mounted its API route on the test web server')
  const apiRoute = webRoutes.get('/api')
  const routeFetch = async request => {
    const url = new URL(request.url)
    const headers = Object.fromEntries(request.headers.entries())
    headers.host = url.host
    headers.origin = headers.origin ?? url.origin
    // Native browser fetch supplies the BrowserAuth cookie for this same-origin request.
    headers.cookie = headers.cookie ?? authCookie
    const chunks = []
    const responseHeaders = {}
    const req = {
      method: request.method,
      url: `${url.pathname}${url.search}`,
      headers,
      readableEnded: false,
      destroyed: false,
      async *[Symbol.asyncIterator]() {
        const body = Buffer.from(await request.arrayBuffer())
        if (body.length) yield body
        this.readableEnded = true
      },
      destroy() { this.destroyed = true },
    }
    const responseDone = new Promise(resolveResponse => {
      const response = new EventEmitter()
      response.writableEnded = false
      response.destroyed = false
      response.writeHead = (statusCode, values = {}) => { response.statusCode = statusCode; Object.assign(responseHeaders, values) }
      response.write = chunk => { chunks.push(Buffer.from(chunk)); return true }
      response.end = chunk => {
        if (chunk !== undefined) chunks.push(Buffer.from(chunk))
        response.writableEnded = true
        resolveResponse(new Response(Buffer.concat(chunks), { status: response.statusCode ?? 200, headers: responseHeaders }))
      }
      apiRoute.handler(req, response).catch(error => resolveResponse(new Response(error?.stack ?? String(error), { status: 500 })))
    })
    const result = await responseDone
    routeFetch.lastResponse = { status: result.status, body: await result.clone().text(), observedHostRequest }
    return result
  }

  let pluginDefinition
  const browserSandbox = {
    window: { __ModuleLoader__: { load(definition) { pluginDefinition = definition } } },
    location: new URL('http://127.0.0.1:43123/'), Request, Headers, Response, URL, crypto: webcrypto,
    fetch: routeFetch,
    dshDesktopBoot: { issueSceneMemoryOriginGrant: async request => await mainHandler({ senderKind: 'app', sender, senderFrame: frame }, request) },
  }
  browserSandbox.globalThis = browserSandbox
  runInNewContext(await readFile(pinnedBrowserClientPath, 'utf8'), browserSandbox, { filename: pinnedBrowserClientPath })
  const plugin = pluginDefinition.factory(() => { throw new Error('unexpected SDK import') })
  const clientContext = { provide(name, value) { this[name] = value } }
  const transport = { ownsHost: true, streamBaseUrl: 'http://127.0.0.1:43123' }
  restore = installBrowserTransportAdapter(transport, browserSandbox)
  plugin.installConnection(clientContext, { transport })

  let result
  try {
    result = await clientContext.connection.rpc.call('/api', 'agent/send', { text: 'write through admitted origin' }, new AbortController().signal)
  } catch (error) {
    throw new Error(`${error.message}; actual registered route response=${JSON.stringify(routeFetch.lastResponse)}`, { cause: error })
  }
  assert.equal(result.ok, true)
  assert.equal(result.value, 'queued')
  await withTimeout(agent.whenIdle(), 10000, `AgentLoop did not consume Main-admitted origin: ${driverErrors.map(error => error?.stack ?? error).join('|')}`)
  assert.deepEqual(driverErrors, [])
  assert.equal(modelCalls, 2)
  const finalState = await f.stateStore.read()
  assert.deepEqual(finalState.sceneMemories?.center?.value, { source: 'actual-sdk-main-host-chain' })
  assert.equal(finalState.sceneMemoryOperations?.[admittedOrigin.operationId]?.status, 'terminal')
  assert.ok(agent.session.snapshotEvents().some(event => event.type === 'tool/result' && event.data?.message?.toolCallId === 'call-main-host-consumer'))
  assert.ok(agent.session.snapshotEvents().some(event => event.type === 'assistant/message' && JSON.stringify(event.data?.message?.content ?? []).includes('The admitted scene-memory operation completed.')))

  const mainEvent = { senderKind: 'app', sender, senderFrame: frame }
  const grantRequest = rpcId => ({ endpoint: 'agent/send', httpMethod: 'POST', bodyBytes: Buffer.from(JSON.stringify({ method: 'agent/send', rpcId, payload: {} })) })
  const persistedMemoryBeforeRechecks = (await f.stateStore.read()).sceneMemories?.center
  const originalHostGrant = control.registerSceneMemoryOriginGrant
  let resolveHostGrantStarted
  let releaseHostGrant
  const hostGrantStarted = new Promise(resolvePromise => { resolveHostGrantStarted = resolvePromise })
  const hostGrantRelease = new Promise(resolvePromise => { releaseHostGrant = resolvePromise })
  control.registerSceneMemoryOriginGrant = async request => {
    resolveHostGrantStarted()
    await hostGrantRelease
    return await originalHostGrant(request)
  }
  const priorGeneration = roleRecord.generation
  const pendingGenerationGrant = mainHandler(mainEvent, grantRequest('role-generation-changed-during-await'))
  await withTimeout(hostGrantStarted, 5000, 'Main did not reach the actual Host grant control before the generation flip')
  roleRecord.generation++
  releaseHostGrant()
  const generationError = await pendingGenerationGrant.then(() => undefined, error => error)
  control.registerSceneMemoryOriginGrant = originalHostGrant
  roleRecord.generation = priorGeneration
  assert.match(generationError?.message ?? '', /role guest changed while grant was pending/)
  assert.deepEqual((await f.stateStore.read()).sceneMemories?.center, persistedMemoryBeforeRechecks, 'a delayed grant cannot create a scene write after its owned guest generation changes')

  let resolveStaleBindingGrantStarted
  let releaseStaleBindingGrant
  const staleBindingStarted = new Promise(resolvePromise => { resolveStaleBindingGrantStarted = resolvePromise })
  const staleBindingRelease = new Promise(resolvePromise => { releaseStaleBindingGrant = resolvePromise })
  control.registerSceneMemoryOriginGrant = async request => {
    resolveStaleBindingGrantStarted()
    await staleBindingRelease
    return await originalHostGrant(request)
  }
  const roleBindingBeforeStale = (await f.stateStore.read()).roles.center
  const pendingStaleBindingGrant = mainHandler(mainEvent, grantRequest('role-binding-changed-during-await'))
  await withTimeout(staleBindingStarted, 5000, 'Main did not reach the actual Host grant control before the durable role binding change')
  await f.stateStore.transact(state => replaceRoleBinding(state, 'center', { ...roleBindingBeforeStale, sessionId: 'session-stale' }))
  releaseStaleBindingGrant()
  const staleBindingError = await pendingStaleBindingGrant.then(() => undefined, error => error)
  control.registerSceneMemoryOriginGrant = originalHostGrant
  assert.match(staleBindingError?.message ?? '', /stale binding/)
  assert.deepEqual((await f.stateStore.read()).sceneMemories?.center, persistedMemoryBeforeRechecks, 'Host refuses an issuer tuple after the durable role binding changes during the pending request')
  assert.equal(sourceOwner.revoke(expectedIssuer.sceneId, expectedIssuer.panelId), true)
  assert.equal(sourceController.resolveGuest(sender, frame), undefined, 'the actual source-owner registry revoke removes the role guest from the controller resolver')
  assert.equal(sourceOwner.revoke(expectedIssuer.sceneId, expectedIssuer.panelId), false)
})
