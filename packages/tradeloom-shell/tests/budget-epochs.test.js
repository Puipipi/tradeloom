import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { apply, BUDGET_LIMITS } from '../policy.js'
import { HOME_MARKER, HOME_MARKER_VALUE, createStateStore } from '../state.js'
import { ROLE_PRESETS } from '../roles.js'

async function fixture(t) {
  const home = await mkdtemp(join(tmpdir(), 'dsh-budget-epoch-'))
  await writeFile(join(home, HOME_MARKER), HOME_MARKER_VALUE, 'utf8')
  const env = { TRADELOOM_DSH_APP_HOME: home, DSH_HOME: home }
  let storesCreated = 0
  const createStore = () => { storesCreated++; return createStateStore({ env }) }
  t.after(async () => await rm(home, { recursive: true, force: true }))
  return { home, createStore, storeCalls: () => storesCreated }
}

function mockAgent(id, { preset = ROLE_PRESETS.center, parentSession, delegationDepth = 0 } = {}) {
  const scopedHooks = new Map()
  const scopedHookOptions = new Map()
  return {
    id,
    session: { header: { agentPreset: preset, parentSession, delegationDepth } },
    ctx: { on(name, callback, options) { scopedHooks.set(name, callback); scopedHookOptions.set(name, options ?? {}) } },
    scopedHooks,
    scopedHookOptions,
    cancellations: [],
    cancel(...args) { this.cancellations.push(args) },
  }
}

function install(createStore, agents = new Map()) {
  const hooks = new Map()
  const options = new Map()
  apply({ agents: { get: id => agents.get(id) }, on(name, callback, hookOptions) {
    hooks.set(name, callback)
    options.set(name, hookOptions ?? {})
  } }, { createStateStore: createStore })
  hooks.agents = agents
  hooks.options = options
  return hooks
}

function created(hooks, agent) {
  hooks.agents.set(agent.id, agent)
  hooks.get('agent/created')({ agent })
}

function dispatchStart(hooks, parent, info) {
  for (const agent of hooks.agents.values()) {
    const listener = agent.scopedHooks.get('subagent/start')
    if (!listener) continue
    if (agent.id === parent.id || agent.scopedHookOptions.get('subagent/start')?.global === true) listener(info)
  }
}

async function preStep(hooks, agent, turn, messages) {
  hooks.agents.set(agent.id, agent)
  let passed = false
  const result = await hooks.get('agent/pre-step')({ agent, turn, step: 1, messages }, async () => {
    passed = true
    return { kind: 'enter', messages }
  })
  return { passed, result }
}

async function tool(hooks, agent, name) {
  let passed = false
  const result = await hooks.get('tools/pre-execute')({ name, callId: `${agent.id}-${name}`, rootCallId: 'root', agent }, async () => {
    passed = true
    return null
  })
  return { passed, result }
}

const user = rpcId => ({ id: `msg-${rpcId}`, source: { kind: 'user', rpcId } })
const relay = senderSessionId => ({ id: `relay-${senderSessionId}`, source: { kind: 'agent-message', form: 'relay', senderSessionId } })
const settled = senderSessionId => ({ id: `settled-${senderSessionId}`, source: { kind: 'subagent-settled', form: 'notice', summary: 'finished', senderSessionId } })

test('a stable center session receives an independent four-delegation bucket for each human RPC', async t => {
  const { createStore } = await fixture(t)
  const hooks = install(createStore)
  const center = mockAgent('stable-center')

  for (const rpcId of ['request-a', 'request-b', 'request-c']) {
    const step = await preStep(hooks, center, rpcId.charCodeAt(8), [user(rpcId)])
    assert.equal(step.passed, true)
    for (let attempt = 0; attempt < 2; attempt++) assert.equal((await tool(hooks, center, 'subagent')).passed, true)
  }

  const state = await (await createStore()).read()
  const rows = Object.entries(state.budgets).filter(([key]) => key.startsWith('["human-rpc"'))
  assert.equal(rows.length, 3)
  assert.deepEqual(rows.map(([, row]) => row.delegations), [2, 2, 2])
  assert.equal(Object.hasOwn(state.budgets, center.id), false)
})

test('the fifth failed-or-successful delegation is counted, natively cancelled, and remains exhausted after restart', async t => {
  const { createStore } = await fixture(t)
  let hooks = install(createStore)
  const center = mockAgent('center-restart')
  await preStep(hooks, center, 1, [user('same-rpc')])

  for (let attempt = 0; attempt < 5; attempt++) {
    const result = await tool(hooks, center, 'subagent')
    assert.equal(result.passed, attempt < 4)
    if (attempt === 4) assert.match(result.result.reason, /delegations budget \(4\) is exhausted/)
  }
  assert.deepEqual(center.cancellations, [[{ kind: 'hook', reason: 'execution budget exhausted' }, { keepInbox: true }]])

  hooks = install(createStore)
  await preStep(hooks, center, 2, [user('same-rpc')])
  const afterRestart = await tool(hooks, center, 'subagent')
  assert.equal(afterRestart.passed, false)
  const state = await (await createStore()).read()
  const row = Object.values(state.budgets).find(value => value.delegations === 6)
  assert.ok(row)
})

test('the seventeenth message attempt is counted and cancelled through the native hook', async t => {
  const { createStore } = await fixture(t)
  const hooks = install(createStore)
  const center = mockAgent('center-messages')
  await preStep(hooks, center, 1, [user('message-rpc')])

  for (let attempt = 0; attempt < 17; attempt++) {
    const result = await tool(hooks, center, 'send_message')
    assert.equal(result.passed, attempt < 16)
    if (attempt === 16) assert.match(result.result.reason, /messages budget \(16\) is exhausted/)
  }
  const state = await (await createStore()).read()
  assert.equal(Object.values(state.budgets).find(value => value.messages === 17)?.messages, 17)
  assert.equal(center.cancellations.length, 1)
})

test('a downstream hook failure still consumes the pre-execution attempt', async t => {
  const { createStore } = await fixture(t)
  const hooks = install(createStore)
  const center = mockAgent('center-failed-attempt')
  await preStep(hooks, center, 1, [user('failed-rpc')])
  await assert.rejects(hooks.get('tools/pre-execute')({
    name: 'subagent', callId: 'failed-call', rootCallId: 'root', agent: center,
  }, async () => { throw new Error('downstream failure') }), /downstream failure/)

  const state = await (await createStore()).read()
  const row = Object.values(state.budgets).find(value => value.delegations === 1)
  assert.ok(row)
})

test('child ownership survives restart and delayed relay or settlement stays on its original request bucket', async t => {
  const { createStore } = await fixture(t)
  let hooks = install(createStore)
  const center = mockAgent('center-lineage')
  await preStep(hooks, center, 1, [user('old-task')])
  created(hooks, center)
  const child = mockAgent('child-old', { preset: ROLE_PRESETS.product, parentSession: center.id, delegationDepth: 1 })
  created(hooks, child)
  dispatchStart(hooks, center, { runId: 'run-1', provider: 'spawn', id: 'child-old', local: true })

  await preStep(hooks, center, 2, [user('new-task')])
  hooks = install(createStore, hooks.agents)
  await preStep(hooks, center, 3, [relay('child-old'), settled('child-old')])
  assert.equal((await tool(hooks, center, 'send_message')).passed, true)

  const state = await (await createStore()).read()
  const oldScope = JSON.stringify(['human-rpc', center.id, 'old-task'])
  const newScope = JSON.stringify(['human-rpc', center.id, 'new-task'])
  assert.equal(state.budgets[oldScope].messages, 1)
  assert.equal(state.budgets[newScope]?.messages ?? 0, 0)
  assert.deepEqual(state.budgetScopes.sessions['child-old'], [oldScope])
})

test('a disposed child retains only its last attribution until the following settlement is inserted', async t => {
  const { createStore } = await fixture(t)
  const hooks = install(createStore)
  const center = mockAgent('dispose-settlement-center')
  await preStep(hooks, center, 1, [user('dispose-settlement-rpc')])
  created(hooks, center)
  const child = mockAgent('dispose-settlement-child', { preset: ROLE_PRESETS.product, parentSession: center.id, delegationDepth: 1 })
  created(hooks, child)
  dispatchStart(hooks, center, { runId: 'dispose-settlement-run', provider: 'spawn', id: child.id, local: true })
  await preStep(hooks, child, 1, [relay(center.id)])

  hooks.get('agent/disposed')({ agent: child })
  const finalNotice = settled(child.id)
  void center.scopedHooks.get('agent/inbox/inserted')({ message: finalNotice })
  assert.equal((await preStep(hooks, center, 2, [finalNotice])).passed, true)
  assert.equal((await tool(hooks, center, 'send_message')).passed, true)

  const state = await (await createStore()).read()
  assert.equal(state.budgets[JSON.stringify(['human-rpc', center.id, 'dispose-settlement-rpc'])].messages, 1)
  assert.equal(state.budgetScopes.messages[center.id], undefined)
})

test('settlement after a child switches from request A to request B is attributed to B', async t => {
  const { createStore } = await fixture(t)
  const hooks = install(createStore)
  const centerA = mockAgent('settlement-center-a')
  const centerB = mockAgent('settlement-center-b')
  await preStep(hooks, centerA, 1, [user('settlement-rpc-a')])
  await preStep(hooks, centerB, 1, [user('settlement-rpc-b')])
  created(hooks, centerA)
  created(hooks, centerB)
  const child = mockAgent('settlement-child-switch', { preset: ROLE_PRESETS.product, parentSession: centerA.id, delegationDepth: 1 })
  created(hooks, child)
  dispatchStart(hooks, centerA, { runId: 'settlement-switch-run', provider: 'spawn', id: child.id, local: true })
  await preStep(hooks, child, 1, [relay(centerA.id)])
  void child.scopedHooks.get('agent/inbox/inserted')({ message: relay(centerB.id) })
  await preStep(hooks, child, 2, [relay(centerB.id)])

  hooks.get('agent/disposed')({ agent: child })
  const finalNotice = settled(child.id)
  void centerB.scopedHooks.get('agent/inbox/inserted')({ message: finalNotice })
  assert.equal((await preStep(hooks, centerB, 2, [finalNotice])).passed, true)
  assert.equal((await tool(hooks, centerB, 'send_message')).passed, true)

  const state = await (await createStore()).read()
  assert.equal(state.budgets[JSON.stringify(['human-rpc', centerB.id, 'settlement-rpc-b'])].messages, 1)
  assert.equal(state.budgets[JSON.stringify(['human-rpc', centerA.id, 'settlement-rpc-a'])]?.messages ?? 0, 0)
})

test('an already inserted A settlement keeps its A snapshot after the child moves to B', async t => {
  const { createStore } = await fixture(t)
  const hooks = install(createStore)
  const centerA = mockAgent('snapshot-center-a')
  const centerB = mockAgent('snapshot-center-b')
  await preStep(hooks, centerA, 1, [user('snapshot-rpc-a')])
  await preStep(hooks, centerB, 1, [user('snapshot-rpc-b')])
  created(hooks, centerA)
  created(hooks, centerB)
  const child = mockAgent('snapshot-child', { preset: ROLE_PRESETS.product, parentSession: centerA.id, delegationDepth: 1 })
  created(hooks, child)
  dispatchStart(hooks, centerA, { runId: 'snapshot-run', provider: 'spawn', id: child.id, local: true })
  await preStep(hooks, child, 1, [relay(centerA.id)])

  const oldNotice = settled(child.id)
  void centerA.scopedHooks.get('agent/inbox/inserted')({ message: oldNotice })
  void child.scopedHooks.get('agent/inbox/inserted')({ message: relay(centerB.id) })
  await preStep(hooks, child, 2, [relay(centerB.id)])
  assert.equal((await preStep(hooks, centerA, 2, [oldNotice])).passed, true)
  assert.equal((await tool(hooks, centerA, 'send_message')).passed, true)

  const state = await (await createStore()).read()
  assert.equal(state.budgets[JSON.stringify(['human-rpc', centerA.id, 'snapshot-rpc-a'])].messages, 1)
  assert.equal(state.budgets[JSON.stringify(['human-rpc', centerB.id, 'snapshot-rpc-b'])]?.messages ?? 0, 0)
})

test('a cold-resumed child session uses the new request while retaining attribution history', async t => {
  const { createStore } = await fixture(t)
  const hooks = install(createStore)
  const center = mockAgent('center-reused-child')
  await preStep(hooks, center, 1, [user('request-one')])
  created(hooks, center)
  const child = mockAgent('same-child', { preset: ROLE_PRESETS.product, parentSession: center.id, delegationDepth: 1 })
  created(hooks, child)
  dispatchStart(hooks, center, { runId: 'run-one', provider: 'spawn', id: 'same-child', local: true })

  // The pinned runtime cold-resumes the durable child session: id stays stable while runId changes.
  await preStep(hooks, center, 2, [user('request-two')])
  dispatchStart(hooks, center, { runId: 'run-two', provider: 'resume', id: 'same-child', local: true })
  const followup = relay(center.id)
  void child.scopedHooks.get('agent/inbox/inserted')({ message: followup })
  await preStep(hooks, child, 1, [followup])
  assert.equal((await tool(hooks, child, 'send_message')).passed, true)

  const state = await (await createStore()).read()
  assert.equal(state.budgetScopes.conflicts['same-child'], undefined)
  assert.deepEqual(state.budgetScopes.sessions['same-child'], [JSON.stringify(['human-rpc', center.id, 'request-two'])])
  assert.deepEqual(state.budgetScopes.histories['same-child'], [
    JSON.stringify(['human-rpc', center.id, 'request-one']),
    JSON.stringify(['human-rpc', center.id, 'request-two']),
  ])
  assert.equal(state.budgets[JSON.stringify(['human-rpc', center.id, 'request-two'])].messages, 1)
})

test('a child started during an unowned parent turn receives a persistent deny marker', async t => {
  const { createStore } = await fixture(t)
  const hooks = install(createStore)
  const center = mockAgent('center-unowned-start')
  await preStep(hooks, center, 1, [user('partial'), relay('unknown-child')])
  created(hooks, center)
  const child = mockAgent('child-unowned', { preset: ROLE_PRESETS.product, parentSession: center.id, delegationDepth: 1 })
  created(hooks, child)
  dispatchStart(hooks, center, { runId: 'run-unowned', provider: 'spawn', id: 'child-unowned', local: true })
  await preStep(hooks, child, 1, [user('cannot-claim-parent-request')])
  assert.equal((await tool(hooks, child, 'send_message')).passed, false)
  const state = await (await createStore()).read()
  assert.equal(state.budgetScopes.conflicts['child-unowned'], true)
  assert.equal(state.budgetScopes.sessions['child-unowned'], undefined)
})

test('the child first step joins start-event attribution without awaiting emit listeners', async t => {
  const { createStore } = await fixture(t)
  const hooks = install(createStore)
  const center = mockAgent('center-start-race')
  await preStep(hooks, center, 1, [user('start-race-rpc')])
  created(hooks, center)
  const child = mockAgent('child-start-race', { preset: ROLE_PRESETS.product, parentSession: center.id, delegationDepth: 1 })
  created(hooks, child)
  // Native @mode emit dispatch is synchronous and does not await listener promises.
  dispatchStart(hooks, center, { runId: 'run-start-race', provider: 'spawn', id: 'child-start-race', local: true })
  const firstStep = await preStep(hooks, child, 1, [relay(center.id)])
  assert.equal(firstStep.passed, true)
  assert.equal((await tool(hooks, child, 'send_message')).passed, true)
  const state = await (await createStore()).read()
  assert.deepEqual(state.budgetScopes.sessions[child.id], [JSON.stringify(['human-rpc', center.id, 'start-race-rpc'])])
})

test('the initial child inbox snapshot waits for the non-awaited start mapping to persist', async t => {
  const { createStore: createRealStore } = await fixture(t)
  let holdFactory = false
  let releaseFirstFactory
  let markFirstFactoryStarted
  const firstFactoryStarted = new Promise(resolve => { markFirstFactoryStarted = resolve })
  const firstFactoryGate = new Promise(resolve => { releaseFirstFactory = resolve })
  let gatedFactoryCalls = 0
  let directReads = 0
  const createStore = async () => {
    const store = await createRealStore()
    if (!holdFactory) return store
    gatedFactoryCalls++
    if (gatedFactoryCalls === 1) {
      markFirstFactoryStarted()
      await firstFactoryGate
    }
    return {
      ...store,
      async read() {
        directReads++
        return await store.read()
      },
      async transact(mutator) { return await store.transact(mutator) },
    }
  }
  const hooks = install(createStore)
  const center = mockAgent('center-initial-inbox')
  const child = mockAgent('child-initial-inbox', { preset: ROLE_PRESETS.product, parentSession: center.id, delegationDepth: 1 })
  await preStep(hooks, center, 1, [user('initial-inbox-rpc')])
  created(hooks, center)
  created(hooks, child)
  holdFactory = true

  // Pinned startLocal queues this exact source shape after synchronous start emit returns.
  dispatchStart(hooks, center, { runId: 'run-initial-inbox', provider: 'spawn', id: child.id, local: true })
  const initialMessage = { id: 'initial-child-message', source: { kind: 'user' } }
  void child.scopedHooks.get('agent/inbox/inserted')({ message: initialMessage })
  await firstFactoryStarted
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(gatedFactoryCalls, 1)
  assert.equal(directReads, 0)

  releaseFirstFactory()
  const firstStep = await preStep(hooks, child, 1, [initialMessage])
  assert.equal(firstStep.passed, true)
  assert.equal((await tool(hooks, child, 'send_message')).passed, true)
  const state = await (await createRealStore()).read()
  assert.deepEqual(state.budgetScopes.messages[child.id], undefined)
  assert.deepEqual(state.budgetScopes.sessions[child.id], [JSON.stringify(['human-rpc', center.id, 'initial-inbox-rpc'])])
})

test('an already-inboxed old child reply keeps its insertion-time bucket after a newer follow-up', async t => {
  const { createStore } = await fixture(t)
  const hooks = install(createStore)
  const center = mockAgent('center-inbox-snapshot')
  const child = mockAgent('child-inbox-snapshot', { preset: ROLE_PRESETS.product, parentSession: center.id, delegationDepth: 1 })
  created(hooks, center)
  created(hooks, child)

  await preStep(hooks, center, 1, [user('old-request')])
  dispatchStart(hooks, center, { runId: 'run-old', provider: 'spawn', id: child.id, local: true })
  await preStep(hooks, child, 1, [relay(center.id)])
  const delayedOldReply = { id: 'delayed-old-reply', source: { kind: 'agent-message', form: 'relay', senderSessionId: child.id } }
  void center.scopedHooks.get('agent/inbox/inserted')({ message: delayedOldReply })

  await preStep(hooks, center, 2, [user('new-request')])
  assert.equal((await tool(hooks, center, 'send_message')).passed, true)
  const newFollowup = { id: 'new-followup', source: { kind: 'agent-message', form: 'relay', senderSessionId: center.id } }
  void child.scopedHooks.get('agent/inbox/inserted')({ message: newFollowup })
  await preStep(hooks, child, 2, [newFollowup])

  const restartedHooks = install(createStore, hooks.agents)
  await preStep(restartedHooks, center, 3, [delayedOldReply])
  assert.equal((await tool(restartedHooks, center, 'send_message')).passed, true)
  const state = await (await createStore()).read()
  assert.equal(state.budgets[JSON.stringify(['human-rpc', center.id, 'old-request'])].messages, 1)
  assert.equal(state.budgets[JSON.stringify(['human-rpc', center.id, 'new-request'])].messages, 1)
  assert.equal(state.budgetScopes.messages[center.id], undefined)
  assert.equal(state.budgetScopes.messages[child.id], undefined)
})

test('mixed human and delayed-child messages debit both scopes; unknown automatic attribution fails closed', async t => {
  const { createStore } = await fixture(t)
  const hooks = install(createStore)
  const center = mockAgent('center-mixed')
  await preStep(hooks, center, 1, [user('old')])
  created(hooks, center)
  const mixedChild = mockAgent('child-mixed', { preset: ROLE_PRESETS.product, parentSession: center.id, delegationDepth: 1 })
  created(hooks, mixedChild)
  dispatchStart(hooks, center, { runId: 'run-m', provider: 'spawn', id: 'child-mixed', local: true })
  await preStep(hooks, center, 2, [user('new')])

  const mixed = await preStep(hooks, center, 3, [user('new'), settled('child-mixed')])
  assert.equal(mixed.passed, true)
  assert.equal((await tool(hooks, center, 'send_message')).passed, true)
  const state = await (await createStore()).read()
  assert.equal(state.budgets[JSON.stringify(['human-rpc', center.id, 'old'])].messages, 1)
  assert.equal(state.budgets[JSON.stringify(['human-rpc', center.id, 'new'])].messages, 1)

  const unmappedChild = mockAgent('new-unmapped-child', {
    preset: ROLE_PRESETS.product, parentSession: center.id, delegationDepth: 1,
  })
  const unowned = await preStep(hooks, unmappedChild, 1, [relay('missing-sender')])
  assert.equal(unowned.passed, true)
  assert.equal((await tool(hooks, unmappedChild, 'send_message')).passed, false)
})

test('role, depth, and unrelated tools preserve their existing gates', async t => {
  const { createStore } = await fixture(t)
  const hooks = install(createStore)
  const expert = mockAgent('expert', { preset: ROLE_PRESETS.product, parentSession: 'center', delegationDepth: 1 })
  await preStep(hooks, expert, 1, [user('expert-input')])
  assert.equal((await tool(hooks, expert, 'subagent')).result.reason, 'Only the TradeLoom center session may delegate.')
  assert.equal((await tool(hooks, expert, 'read_file')).passed, true)

  const tooDeep = mockAgent('too-deep', { preset: ROLE_PRESETS.product, parentSession: 'center', delegationDepth: 2 })
  await preStep(hooks, tooDeep, 1, [user('deep-input')])
  assert.equal((await tool(hooks, tooDeep, 'send_message')).result.reason, 'TradeLoom delegation is limited to direct expert sessions.')
  assert.deepEqual(BUDGET_LIMITS, { delegations: 4, messages: 16 })
})

test('the real state file retains legacy budget history and serializes new attribution fields', async t => {
  const { home, createStore } = await fixture(t)
  const store = await createStore()
  await store.transact(state => { state.budgets['legacy-center'] = { delegations: 3, messages: 7 } })
  const hooks = install(createStore)
  const center = mockAgent('persisted-center')
  await preStep(hooks, center, 1, [user('persisted-rpc')])
  await tool(hooks, center, 'subagent')
  const disk = JSON.parse(await readFile(join(home, 'tradeloom-state', 'state.json'), 'utf8'))
  assert.deepEqual(disk.budgets['legacy-center'], { delegations: 3, messages: 7 })
  assert.ok(disk.budgetScopes.sessions[center.id])
})

test('root budget hooks are global and foreign presets pass through without reading TradeLoom state', async t => {
  const { createStore, storeCalls } = await fixture(t)
  const hooks = install(createStore)
  for (const event of ['agent/pre-step', 'agent/created', 'tools/pre-execute', 'agent/disposed']) {
    assert.equal(hooks.options.get(event)?.global, true, `${event} must observe the Host-wide Agent lifecycle`)
  }
  const foreign = mockAgent('foreign-preset', { preset: 'preset-standard' })
  const step = await preStep(hooks, foreign, 1, [user('foreign-rpc')])
  assert.equal(step.passed, true)
  assert.equal((await tool(hooks, foreign, 'send_message')).passed, true)
  assert.equal(storeCalls(), 0)
})

test('global starts inherit only from the agent named by the registered child parentSession', async t => {
  const { createStore } = await fixture(t)
  const hooks = install(createStore)
  const centerA = mockAgent('center-a')
  const centerB = mockAgent('center-b')
  const child = mockAgent('child-of-a', { preset: ROLE_PRESETS.product, parentSession: centerA.id, delegationDepth: 1 })
  created(hooks, centerA)
  created(hooks, centerB)
  created(hooks, child)
  assert.equal(child.scopedHookOptions.get('subagent/start')?.global, true)
  await preStep(hooks, centerA, 1, [user('rpc-a')])
  await preStep(hooks, centerB, 1, [user('rpc-b')])

  dispatchStart(hooks, centerA, { runId: 'run-a', provider: 'spawn', id: child.id, local: true })
  await preStep(hooks, child, 1, [relay(centerA.id)])
  assert.equal((await tool(hooks, child, 'send_message')).passed, true)
  const state = await (await createStore()).read()
  assert.equal(state.budgets[JSON.stringify(['human-rpc', centerA.id, 'rpc-a'])].messages, 1)
  assert.equal(state.budgets[JSON.stringify(['human-rpc', centerB.id, 'rpc-b'])]?.messages ?? 0, 0)
  assert.deepEqual(state.budgetScopes.sessions[child.id], [JSON.stringify(['human-rpc', centerA.id, 'rpc-a'])])
})

test('disposing an older Agent with a reused id does not forget the live Agent mapping', async t => {
  const { createStore } = await fixture(t)
  const hooks = install(createStore)
  const receiver = mockAgent('dispose-receiver')
  const oldAgent = mockAgent('reused-agent-id', { preset: ROLE_PRESETS.product, parentSession: receiver.id, delegationDepth: 1 })
  const liveAgent = mockAgent('reused-agent-id', { preset: ROLE_PRESETS.product, parentSession: receiver.id, delegationDepth: 1 })
  created(hooks, receiver)
  created(hooks, oldAgent)
  await preStep(hooks, oldAgent, 1, [user('old-live-id-rpc')])
  created(hooks, liveAgent)
  await preStep(hooks, liveAgent, 2, [user('current-live-id-rpc')])

  hooks.get('agent/disposed')({ agent: oldAgent })
  const inserted = relay(liveAgent.id)
  void receiver.scopedHooks.get('agent/inbox/inserted')({ message: inserted })
  await preStep(hooks, receiver, 1, [inserted])
  assert.equal((await tool(hooks, receiver, 'send_message')).passed, true)
  const state = await (await createStore()).read()
  assert.equal(state.budgets[JSON.stringify(['human-rpc', liveAgent.id, 'current-live-id-rpc'])].messages, 1)
  assert.equal(state.budgets[JSON.stringify(['human-rpc', liveAgent.id, 'old-live-id-rpc'])]?.messages ?? 0, 0)
})
