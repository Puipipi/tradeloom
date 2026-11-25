// Real locked batch/pipeline/MCP client, shared stdio connection, and real Agents.
// PTC's program runtime is a fixture that invokes the actual production SDK binding.
// DSH_PREFIX=<prepared patched prefix> node --test runtime/tests/phone-caller-context.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

if (!process.env.DSH_PREFIX) throw new Error('Set DSH_PREFIX to the prepared patched runtime');
const base = join(resolve(process.env.DSH_PREFIX), 'node_modules/@deepseek-ai');
const load = name => import(pathToFileURL(join(base, name, 'lib/index.js')));
const { Context } = await load('cordis');
const { NativeToolExecutor } = await load('dsh-tool-executor-native');
const { PtcExecutor } = await load('dsh-tool-executor-ptc');
let serial = 0;

async function fixture(t, { enabled = true, supported = true, lifecycle = false, reconnect = false, extra = [], toolCallTimeoutMs } = {}) {
  const ctx = new Context();
  t.after(() => ctx.fiber.dispose());
  for (const name of ['dsh-session', 'dsh-session-projection', 'dsh-agent', 'dsh-llm',
    'dsh-tools', 'dsh-system-prompt', 'dsh-mcp-resources']) await ctx.plugin((await load(name)).default);
  await ctx.plugin((await load('dsh-agent-loop')).AgentLoop, { agents: [] });
  await ctx.plugin(await load('dsh-mcp-client'), {
    serverName: 'phone', transport: 'stdio', command: process.execPath,
    args: [fileURLToPath(new URL('./fixtures/phone-caller-mcp.mjs', import.meta.url)), lifecycle ? 'lifecycle' : supported ? 'supported' : 'legacy', ...extra],
    dshGoPhoneCaller: enabled, failOnStartupError: true,
    ...(toolCallTimeoutMs === undefined ? {} : { toolCallTimeoutMs }),
    reconnect: reconnect ? { enabled: true, initialDelayMs: 10, maxDelayMs: 50, maxAttempts: 100 } : { enabled: false },
  });
  const native = new NativeToolExecutor(ctx);
  const create = async () => (await ctx.agents.create({ sessionId: `phone-caller-${++serial}` })).agent;
  const run = async (agent, turn = 1, args = {}, log = true, executor = native) => {
    const id = `phone-call-${++serial}`;
    const ptc = executor !== native;
    const batch = await executor.execute({
      calls: [{ id, name: ptc ? 'run_code' : 'mcp__phone__screen', arguments: JSON.stringify(
        ptc ? { code: 'fixture invokes the SDK binding', description: 'Caller propagation fixture' } : args) }],
      ...(agent === undefined ? {} : { agent }),
      ...(log ? { log: { turn, step: 1 } } : {}), signal: new AbortController().signal,
    });
    const result = batch.results[0].result;
    assert.equal(result.isError, false, JSON.stringify(result));
    const value = ptc ? result.value.result : result.value;
    return { id, ...JSON.parse(value.content[0].text) };
  };
  // An unowned query of the peer's records; undefined while no connection can answer.
  const probe = async () => { try { return await run(undefined, 1, {}, false); } catch { return undefined; } };
  return { ctx, create, run, native, probe };
}

async function until(read, done, what) {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const value = await read();
    if (value !== undefined && done(value)) return value;
    if (Date.now() > deadline) assert.fail(`timed out waiting for ${what}`);
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

function marker(t) {
  const dir = mkdtempSync(join(tmpdir(), 'phone-run-end-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return join(dir, 'first-end');
}

test('shared MCP client keeps two Agents and each turn separate, arguments cannot replace caller', async t => {
  const f = await fixture(t), a = await f.create(), b = await f.create();
  const forged = { sessionId: b.session.id, phoneCaller: { sessionId: b.session.id, runId: 'forged' } };
  const [one, other] = await Promise.all([f.run(a, 1, forged), f.run(b)]);
  assert.equal(one.caller.sessionId, a.session.id);
  assert.equal(other.caller.sessionId, b.session.id);
  assert.notEqual(one.caller.runId, other.caller.runId);
  assert.equal(one.caller.callId, one.id);
  assert.deepEqual(one.args, forged);
  const same = await f.run(a, 1), next = await f.run(a, 2);
  assert.equal(same.caller.runId, one.caller.runId);
  assert.notEqual(next.caller.runId, one.caller.runId);
});

test('a delayed call keeps its admitted turn while a later turn completes', async t => {
  const f = await fixture(t), a = await f.create();
  const entered = Promise.withResolvers(), release = Promise.withResolvers();
  const prepare = f.native.pipeline.prepare.bind(f.native.pipeline);
  let first = true;
  f.native.pipeline.prepare = async input => {
    if (first) { first = false; entered.resolve(); await release.promise; }
    return prepare(input);
  };
  const old = f.run(a, 1);
  await entered.promise;
  try {
    const next = await f.run(a, 2);
    release.resolve();
    const previous = await old;
    assert.notEqual(previous.caller.runId, next.caller.runId);
    assert.equal((await f.run(a, 1)).caller.runId, previous.caller.runId);
  } finally { release.resolve(); }
});

test('PTC inherits the outer caller through the real nested binding, with its own cancellation signal', async t => {
  const f = await fixture(t), a = await f.create();
  f.ctx.provide('workingDirectory', { ensure: async () => process.cwd() });
  f.ctx.provide('ptcRuntime', {
    language: 'typescript', programFormat: 'function-body',
    resolve: request => request,
    async run(request) {
      const value = await request.bindings[0].functions.mcp__phone__screen({
        phoneCaller: { sessionId: 'forged', runId: 'forged' },
      });
      return { logs: [], value };
    },
    release() {},
  });
  const native = await f.run(a, 1);
  const ptc = await f.run(a, 1, {}, true, new PtcExecutor(f.ctx));
  assert.equal(ptc.caller.sessionId, a.session.id);
  assert.equal(ptc.caller.runId, native.caller.runId);
  assert.equal(ptc.caller.callId, `${ptc.id}:ptc:1`);
});

test('no host Agent/log, no opt-in, or old server capability preserves legacy wire', async t => {
  const f = await fixture(t), a = await f.create();
  assert.equal((await f.run(a, 1, {}, false)).caller, null);
  assert.equal((await f.run(undefined, 1, {}, false)).caller, null);
  for (const options of [{ enabled: false }, { supported: false }]) {
    const old = await fixture(t, options);
    assert.equal((await old.run(await old.create())).caller, null);
  }
});


test('actual session end reaches managed MCP as a private ACK request with captured identity', async t => {
  const f = await fixture(t, { lifecycle: true });
  const a = await f.create(), b = await f.create();
  const first = await f.run(a, 1), second = await f.run(b, 4);
  assert.equal(first.caller.runLifecycle, 1);
  assert.equal(second.caller.runLifecycle, 1);
  a.session.append('turn/end', { turn: 1, reason: { kind: 'completed' } });
  // The real Session event and MCP transport are async. Barrier through the peer's
  // tool handler observes recorded requests; an unowned query cannot manufacture a run.
  let ends;
  const deadline = Date.now() + 5_000;
  do {
    ends = (await f.run(undefined, 1, {}, false)).ends;
    if (ends.length === 0) await new Promise(resolve => setTimeout(resolve, 5));
  } while (ends.length === 0 && Date.now() < deadline);
  assert.deepEqual(ends, [{ v: 1, sessionId: a.session.id, runId: first.caller.runId, completion: 'completed' }]);
  a.session.append('turn/end', { turn: 1, reason: { kind: 'error', message: 'must not leak' } });
  b.session.append('turn/end', { turn: 4, reason: { kind: 'aborted', reason: 'must not leak' } });
  do {
    ends = (await f.run(undefined, 1, {}, false)).ends;
    if (ends.length < 2) await new Promise(resolve => setTimeout(resolve, 5));
  } while (ends.length < 2 && Date.now() < deadline);
  assert.deepEqual(ends, [
    { v: 1, sessionId: a.session.id, runId: first.caller.runId, completion: 'completed' },
    { v: 1, sessionId: b.session.id, runId: second.caller.runId, completion: 'other' },
  ]);
});

// Native keys a run by launch, not connection, so a replacement relay connection reaches the same task.
test('an end whose calls used a retired connection reaches the replacement connection', async t => {
  const f = await fixture(t, { lifecycle: true, reconnect: true }), a = await f.create();
  const call = await f.run(a, 1);
  const retired = await f.run(undefined, 1, { exit: true }, false);
  assert.equal(retired.pid, call.pid);
  await until(f.probe, value => value.pid !== retired.pid, 'a replacement connection');
  a.session.append('turn/end', { turn: 1, reason: { kind: 'completed' } });
  const { ends } = await until(f.probe, value => value.ends.length > 0, 'the end on the replacement');
  assert.deepEqual(ends, [{ v: 1, sessionId: a.session.id, runId: call.caller.runId, completion: 'completed' }]);
});

test('an end lost before its ACK is kept and delivered once on the next connection', async t => {
  const f = await fixture(t, { lifecycle: true, reconnect: true, extra: [`--first-end=exit:${marker(t)}`] });
  const a = await f.create(), call = await f.run(a, 1);
  a.session.append('turn/end', { turn: 1, reason: { kind: 'aborted', reason: 'must not leak' } });
  const delivered = await until(f.probe, value => value.ends.length > 0, 'the retained end');
  assert.notEqual(delivered.pid, call.pid);
  const expected = [{ v: 1, sessionId: a.session.id, runId: call.caller.runId, completion: 'other' }];
  assert.deepEqual(delivered.ends, expected);
  await f.run(a, 2); // A later phone call flushes only ends that are still unacknowledged.
  a.session.append('turn/end', { turn: 1, reason: { kind: 'completed' } });
  assert.deepEqual((await f.probe()).ends, expected);
});

test('a dropped end is retried on the same live connection without another owned call', async t => {
  const f = await fixture(t, { lifecycle: true, reconnect: false, toolCallTimeoutMs: 5_000,
    extra: [`--first-end=drop:${marker(t)}`] });
  const a = await f.create(), first = await f.run(a, 1);
  // Only the host timer is virtual. The child peer and stdio are real; unowned probes
  // cannot invoke onPhoneCall or flush retained ends.
  const realSetTimeout = globalThis.setTimeout, realClearTimeout = globalThis.clearTimeout;
  const probe = async () => {
    let watchdog;
    try {
      return await Promise.race([f.probe(), new Promise((_, reject) => {
        watchdog = realSetTimeout(() => reject(new Error('real stdio probe stalled')), 10_000);
      })]);
    } finally { realClearTimeout(watchdog); }
  };
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const barrier = async done => {
    const deadline = Date.now() + 10_000;
    for (;;) {
      const value = await probe();
      if (value !== undefined && done(value)) return value;
      if (Date.now() >= deadline) assert.fail('stdio barrier did not observe the expected end state');
    }
  };
  try {
    a.session.append('turn/end', { turn: 1, reason: { kind: 'completed' } });
    const expected = { v: 1, sessionId: a.session.id, runId: first.caller.runId, completion: 'completed' };
    const dropped = await barrier(value => value.dropped.length === 1);
    assert.equal(dropped.pid, first.pid);
    assert.deepEqual(dropped.dropped, [expected]);
    assert.deepEqual(dropped.ends, []);
    t.mock.timers.tick(5_000); // Actual SDK RequestTimeout, not a simulated request rejection.
    await probe(); // Drain the rejection microtask before advancing the retry delay.
    t.mock.timers.tick(1_000);
    const delivered = await barrier(value => value.ends.length === 1);
    assert.equal(delivered.pid, first.pid);
    assert.deepEqual(delivered.ends, [expected]);
    t.mock.timers.tick(6_000);
    const acked = await probe();
    assert.deepEqual(acked.ends, [expected], 'ACK must retire the retry, not duplicate the end');
    assert.deepEqual(acked.dropped, [expected]);
  } finally {
    t.mock.timers.reset();
  }
});

test('disposing a plugin cancels its pending same-connection end retry', async t => {
  const f = await fixture(t, { lifecycle: true, toolCallTimeoutMs: 5_000,
    extra: [`--first-end=drop:${marker(t)}`] });
  const a = await f.create();
  await f.run(a, 1);
  const realSetTimeout = globalThis.setTimeout, realClearTimeout = globalThis.clearTimeout;
  const bounded = async promise => {
    let watchdog;
    try {
      return await Promise.race([promise, new Promise((_, reject) => {
        watchdog = realSetTimeout(() => reject(new Error('real stdio/disposal stalled')), 10_000);
      })]);
    } finally { realClearTimeout(watchdog); }
  };
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const fakeSetTimeout = globalThis.setTimeout, fakeClearTimeout = globalThis.clearTimeout;
  const retries = [], cleared = new Set();
  const set = t.mock.method(globalThis, 'setTimeout', (callback, ms, ...args) => {
    const handle = fakeSetTimeout(callback, ms, ...args);
    if (ms === 1_000) retries.push(handle);
    return handle;
  });
  const clear = t.mock.method(globalThis, 'clearTimeout', handle => {
    cleared.add(handle);
    return fakeClearTimeout(handle);
  });
  try {
    a.session.append('turn/end', { turn: 1, reason: { kind: 'completed' } });
    const deadline = Date.now() + 10_000;
    for (;;) {
      const value = await bounded(f.probe());
      if (value?.dropped.length === 1) break;
      if (Date.now() >= deadline) assert.fail('peer did not receive the first end');
    }
    t.mock.timers.tick(5_000);
    await bounded(f.probe());
    assert.equal(retries.length, 1, 'one plugin retry timer after actual SDK timeout');
    await bounded(f.ctx.fiber.dispose());
    assert.equal(cleared.has(retries[0]), true, 'dispose must cancel the actual retry timer');
    t.mock.timers.tick(1_000);
    assert.equal(retries.length, 1, 'disposed retry must not schedule another wakeup');
  } finally {
    set.mock.restore(); clear.mock.restore();
    t.mock.timers.reset();
  }
});

test('a peer refusal is final and later ends still flow', async t => {
  const f = await fixture(t, { lifecycle: true, extra: [`--first-end=refuse:${marker(t)}`] });
  const a = await f.create(), b = await f.create();
  const first = await f.run(a, 1), second = await f.run(b, 1);
  a.session.append('turn/end', { turn: 1, reason: { kind: 'completed' } });
  await until(f.probe, value => value.refused.length > 0, 'the refusal');
  await f.run(b, 1); // Would re-send a retained end ahead of this call.
  b.session.append('turn/end', { turn: 1, reason: { kind: 'completed' } });
  const { ends, refused } = await until(f.probe, value => value.ends.length > 0, 'the later end');
  assert.deepEqual(refused, [{ v: 1, sessionId: a.session.id, runId: first.caller.runId, completion: 'completed' }]);
  assert.deepEqual(ends, [{ v: 1, sessionId: b.session.id, runId: second.caller.runId, completion: 'completed' }]);
});

for (const options of [{ enabled: false, lifecycle: true }, { lifecycle: false }, { supported: false }]) {
  test(`private end is not sent without opt-in and lifecycle negotiation: ${JSON.stringify(options)}`, async t => {
    const f = await fixture(t, options), a = await f.create();
    const call = await f.run(a, 1);
    assert.equal(call.caller?.runLifecycle, undefined);
    a.session.append('turn/end', { turn: 1, reason: { kind: 'completed' } });
    assert.deepEqual((await f.run(undefined, 1, {}, false)).ends, []);
  });
}
