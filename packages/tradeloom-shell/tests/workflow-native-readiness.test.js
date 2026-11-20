import test from 'node:test'
import assert from 'node:assert/strict'
import { createNativeWorkflowReadiness, runWhenNativeWorkflowReady } from '../workflow-native-readiness.js'

test('an initial request waits for the actual composition to attach, without dispatching a pending recovery', async () => {
  const gate = createNativeWorkflowReadiness(), ctx = { get: () => gate }
  let calls = 0, finish
  const pending = runWhenNativeWorkflowReady(ctx, undefined, () => ++calls)
  await Promise.resolve(); assert.equal(calls, 0)
  gate.attach({ recover: () => new Promise(resolve => { finish = resolve }) })
  await Promise.resolve(); assert.equal(calls, 0)
  finish({ ready: true }); assert.equal(await pending, 1)
  gate.close()
})

test('a resolved promise without the service ready result is not readiness', async () => {
  const gate = createNativeWorkflowReadiness()
  gate.attach({ async recover() {} })
  await assert.rejects(gate.wait(), { code: 'native_workflow_unavailable' })
  assert.equal(gate.state, 'failed')
})

test('startup recovery is shared by UI/tools and never replays on each call', async () => {
  const gate = createNativeWorkflowReadiness()
  const ctx = { get: () => gate }
  let finish, recoveries = 0, calls = 0
  const detach = gate.attach({ recover: () => { recoveries++; return new Promise(resolve => { finish = resolve }) } })
  const first = runWhenNativeWorkflowReady(ctx, undefined, () => ++calls)
  const second = runWhenNativeWorkflowReady(ctx, undefined, () => ++calls)
  await Promise.resolve()
  assert.equal(gate.state, 'pending')
  assert.equal(calls, 0)
  finish({ ready: true })
  assert.deepEqual(await Promise.all([first, second]), [1, 2])
  assert.equal(recoveries, 1)
  detach()
  await assert.rejects(runWhenNativeWorkflowReady(ctx, undefined, () => ++calls), { code: 'native_workflow_unavailable' })
  assert.equal(calls, 2)
})

test('failed recovery, replacement, abort and Host close stay fail-closed', async () => {
  const gate = createNativeWorkflowReadiness()
  const ctx = { get: () => gate }
  let resolve
  const detach = gate.attach({ recover: () => new Promise(done => { resolve = done }) })
  assert.throws(() => gate.attach({ recover() {} }), { code: 'recovery_owner_conflict' })
  const controller = new AbortController()
  const cancelled = runWhenNativeWorkflowReady(ctx, controller.signal, () => assert.fail('aborted operation ran'))
  controller.abort()
  await assert.rejects(cancelled, { code: 'operation_aborted' })
  await Promise.resolve()
  detach()
  resolve()
  await assert.rejects(runWhenNativeWorkflowReady(ctx, undefined, () => assert.fail('detached recovery ran')), { code: 'native_workflow_unavailable' })
  gate.attach({ async recover() { throw new Error('storage failed') } })
  await assert.rejects(runWhenNativeWorkflowReady(ctx, undefined, () => assert.fail('failed recovery ran')), { code: 'native_workflow_unavailable' })
  gate.close()
  assert.equal(gate.state, 'closed')
  assert.throws(() => gate.attach({ recover() {} }), { code: 'service_closed' })
})
