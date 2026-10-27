import test from 'node:test'
import assert from 'node:assert/strict'
import { pathToFileURL } from 'node:url'
import { createWorkflowNativeUiGate } from '../workflow-native-ui-gate.js'

// Real SDK AgentLoop/Agent/ToolRuntime; synthetic authenticated-handler origin.
// No GUI, human interaction proof, provider, prompt, turn, Host or network.
const runtime = 'C:/Users/23825/Desktop/ICT/workspace/runtime/tradeloom-harness/releases/0.2.1-rc.3-tradeloom-desktop-18'
const load = p => import(pathToFileURL(`${runtime}/${p}`).href)
const [{ Context }, kit] = await Promise.all([load('vendor/cordis/lib/index.js'), load('packages/test-support/agent-loop-testkit/lib/index.js')])
async function fixture(t) {
  const ctx = new Context()
  t.after(() => ctx.fiber.dispose())
  await kit.mountAgentLoopTestDependencies(ctx)
  const loop = await kit.mountAgentLoopTestHarness(ctx)
  const agent = await loop.create('ui-gate-agent')
  const other = await loop.create('ui-gate-other')
  assert.equal(ctx.agents.get(agent.id), agent)
  const gate = createWorkflowNativeUiGate(ctx)
  t.after(() => gate.dispose())
  const controller = new AbortController()
  let current = true, body = 0, behavior = exec => { gate.consume(exec); return true }
  ctx.tools.register({ name: 'gate_test', description: 'offline origin proof',
    parameters: { type: 'object', properties: { confirm: { type: 'boolean' }, data: { type: 'object' } } },
    output: { schema: { type: 'boolean' }, render: (_a, v) => [{ type: 'text', text: String(v) }] },
    execute(_args, exec) { body++; return behavior(exec) },
  })
  const args = { confirm: true, data: { b: 2, a: 1 } }
  const input = { agent, name: 'gate_test', callId: 'not-an-authority-prefix', arguments: args, signal: controller.signal,
    isCurrent: () => current && ctx.agents.get(agent.id) === agent, taskLease: Object.freeze({ opaque: true }) }
  const execute = (overrides = {}) => ctx.tools.execute({ ...input, ...overrides })
  return { ctx, gate, agent, other, input, execute, controller, setCurrent: v => { current = v }, setBehavior: fn => { behavior = fn }, calls: () => body }
}
test('actual SDK body shares observed identity, canonical args and opaque witness lifetime', async t => {
  const f = await fixture(t)
  let witness, captured
  f.setBehavior(exec => {
    captured = exec
    assert.throws(() => f.gate.consume({ ...exec }), /ui_origin_required/)
    witness = f.gate.consume(exec)
    assert.equal(f.gate.assertCurrent(witness, exec).taskLease, f.input.taskLease)
    assert.throws(() => f.gate.consume(exec), /ui_origin_required/)
    return true
  })
  const result = await f.gate.withPending(f.input, () => f.execute({ arguments: { data: { a: 1, b: 2 }, confirm: true } }))
  assert.equal(result.isError, false)
  assert.equal(result.value, true)
  assert.throws(() => f.gate.assertCurrent(witness, captured), /ui_origin_required/)
})
test('model confirm and guessed exact callId without pending grant are denied', async t => {
  const f = await fixture(t)
  const result = await f.execute()
  assert.equal(result.isError, true)
})
for (const [name, change] of [
  ['different agent', f => ({ agent: f.other })],
  ['different arguments', () => ({ arguments: { confirm: false } })],
  ['different callId', () => ({ callId: 'guessed-prefix' })],
]) test(name, async t => {
  const f = await fixture(t)
  const result = await f.gate.withPending(f.input, () => f.execute(change(f)))
  assert.equal(result.isError, true)
})
test('duplicate pending rejected and concurrent execution cannot consume twice', async t => {
  const f = await fixture(t)
  await f.gate.withPending(f.input, async () => {
    await assert.rejects(f.gate.withPending(f.input, () => true), /ui_origin_required/)
    const a = await f.execute(); const b = await f.execute()
    assert.equal(a.isError, false); assert.equal(b.isError, true)
  })
})
for (const reason of ['abort', 'current', 'dispose']) test(`${reason} revokes pending before tool body`, async t => {
  const f = await fixture(t)
  await f.gate.withPending(f.input, async () => {
    if (reason === 'abort') f.controller.abort()
    if (reason === 'current') f.setCurrent(false)
    if (reason === 'dispose') f.gate.dispose()
    assert.equal((await f.execute()).isError, true)
  })
})
test('throwing handler finally closes pending and late dispatch denied', async t => {
  const f = await fixture(t)
  await assert.rejects(f.gate.withPending(f.input, () => { throw new Error('fixture') }), /fixture/)
  assert.equal((await f.execute()).isError, true)
})
test('abort/current change after consumption revokes witness within live outer', async t => {
  const f = await fixture(t)
  f.setBehavior(exec => {
    const witness = f.gate.consume(exec)
    f.setCurrent(false)
    assert.throws(() => f.gate.assertCurrent(witness, exec), /ui_origin_required/)
    return true
  })
  assert.equal((await f.gate.withPending(f.input, () => f.execute())).value, true)
})
test('abort after consumption revokes exact witness and copied witness never accepted', async t => {
  const f = await fixture(t)
  f.setBehavior(exec => {
    const witness = f.gate.consume(exec)
    assert.throws(() => f.gate.assertCurrent({ ...witness }, exec), /ui_origin_required/)
    f.controller.abort()
    assert.throws(() => f.gate.assertCurrent(witness, exec), /ui_origin_required/)
    return true
  })
  assert.equal((await f.gate.withPending(f.input, () => f.execute())).isError, true)
})
test('explicit distinct instances do not share grants', async t => {
  const f = await fixture(t)
  const other = createWorkflowNativeUiGate(f.ctx)
  t.after(() => other.dispose())
  f.setBehavior(exec => { other.consume(exec); return true })
  assert.equal((await f.gate.withPending(f.input, () => f.execute())).isError, true)
})
