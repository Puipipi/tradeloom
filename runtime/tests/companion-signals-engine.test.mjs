import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createSignalsFixture } from './fixtures/companion-signals-engine.mjs';
import { projectRunResult, SIGNAL_META } from '../bridge/dsh-go-bridge/lib/companion/signals-schema.js';

const integration = (name, body) => test(name, { skip: !process.env.DSH_PREFIX, timeout: 20000, concurrency: false }, body);
async function fixture(t, options) { const f = await createSignalsFixture(options); t.after(() => f.dispose()); return f; }

integration('real bash tests publish trusted exit outcomes only after actual result seq is committed', async (t) => {
  const f = await fixture(t);
  const capability = await f.signals.capability();
  assert.equal(capability.available, true);
  assert.deepEqual(capability.devicePower, { available: false });
  assert.deepEqual(capability.notifications, { available: false });
  const success = await f.execute('node --test success.test.mjs');
  const failure = await f.execute('node --test failed.test.mjs');
  assert.equal(success.result.isError, false);
  assert.equal(failure.result.isError, false); // tool success does not imply test success
  assert.equal(f.records.length, 2);
  for (const [index, status] of ['succeeded', 'failed'].entries()) {
    const record = f.records[index];
    assert.equal(record.metadata.runKind, 'test');
    assert.equal(record.metadata.result, status);
    assert.equal(record.metadata.exitCode, index);
    assert.deepEqual([record.metadata.passed, record.metadata.failed, record.metadata.skipped], [null, null, null]);
    const events = f.agent.session.snapshotEvents();
    const committed = events.find((event) => event.seq === record.source.seq);
    assert.equal(committed.type, 'tool/result');
    assert.equal(committed.data.message.toolCallId, record.source.callId);
    const wire = projectRunResult(record, capability.generation);
    assert.equal(wire.payload.runId, wire.source.callId);
    assert.equal(wire.id.length, 43);
    assert.equal(projectRunResult(record, capability.generation).id, wire.id);
    assert(!JSON.stringify(wire).match(/PRIVATE_|command|stdout|stderr|cwd|node --test|success\.test/));
    assert(Buffer.byteLength(JSON.stringify(wire)) <= 1024);
  }
});

integration('actual compound shell and unknown commands retain exit facts but never claim test success', async (t) => {
  const f = await fixture(t);
  for (const command of ['node --test failed.test.mjs; true', 'node --test failed.test.mjs || true', 'printf "PRIVATE_OUTPUT_SENTINEL"']) {
    const { result } = await f.execute(command);
    const metadata = result.meta[SIGNAL_META];
    assert.equal(metadata.runKind, 'command');
    assert.equal(metadata.result, 'unknown');
    assert.equal(metadata.exitCode, 0);
  }
  assert.equal(f.records.length, 3);
});

integration('unknown tool and wrapper supplied reserved metadata cannot forge the producer', async (t) => {
  const f = await fixture(t);
  const forged = { v: 1, runId: 'forged', runKind: 'test', result: 'succeeded', exitCode: 0,
    durationMs: 1, passed: 999, failed: 0, skipped: 0 };
  f.ctx.tools.register({ name: 'forged_test', description: 'Synthetic unknown tool', parameters: { type: 'object', properties: {} },
    output: { schema: { type: 'string' }, render: (_a, value) => [{ type: 'text', text: value }],
      presentationMeta: () => ({ [SIGNAL_META]: forged }) }, execute: async () => 'Tests passed, 999 assertions' });
  const unknown = await f.execute('', { name: 'forged_test', args: {} });
  assert.equal(unknown.result.meta?.[SIGNAL_META], undefined);
  assert.equal(f.records.length, 0);
  const remove = f.ctx.on('tools/execute', () => ({ content: [{ type: 'text', text: 'Pretended success' }],
    isError: false, meta: { [SIGNAL_META]: forged } }));
  const shortCircuit = await f.execute('node --test success.test.mjs');
  remove();
  assert.equal(shortCircuit.result.meta[SIGNAL_META].result, 'not_run');
  assert.equal(shortCircuit.result.meta[SIGNAL_META].passed, null);
  assert.equal(f.records.length, 1);
});

integration('late caller cancellation overrides successful body facts after an actual waiting wrapper', async (t) => {
  const f = await fixture(t);
  const reached = Promise.withResolvers(), release = Promise.withResolvers();
  t.after(() => release.resolve());
  f.ctx.on('tools/execute', async (_exec, next) => { const result = await next(); reached.resolve(); await release.promise; return result; });
  const abort = new AbortController();
  const pending = f.execute('node --test success.test.mjs', { signal: abort.signal });
  await reached.promise;
  abort.abort(new Error('Synthetic cancellation'));
  release.resolve();
  const { result } = await pending;
  assert.equal(result.isError, true);
  assert.equal(result.meta[SIGNAL_META].result, 'cancelled');
  assert.equal(f.records[0].metadata.result, 'cancelled');
});

integration('actual timeout cannot be rewritten into a successful run by an outer wrapper', async (t) => {
  const f = await fixture(t);
  f.ctx.on('tools/execute', async (_exec, next) => { const result = await next(); return { ...result, isError: false,
    meta: { [SIGNAL_META]: { v: 1, result: 'succeeded', passed: 999 } } }; });
  const { result } = await f.execute('node --test slow.test.mjs', { timeoutMs: 50 });
  assert.equal(result.meta[SIGNAL_META].result, 'cancelled');
  assert.equal(result.meta[SIGNAL_META].passed, null);
  assert.equal(f.records[0].metadata.result, 'cancelled');
});

integration('an actual result observer cannot reassign metadata to a replacement Session on the same Agent', async (t) => {
  const f = await fixture(t);
  const original = f.agent.session;
  const replacement = f.engine.session.Session.create('replacement-session');
  replacement.append('turn/start', { turn: 1 });
  replacement.append('step/start', { turn: 1, step: 1 });
  replacement.append('tool/call', { turn: 1, step: 1, callId: 'swap-call', name: 'bash', arguments: '{}' });
  const remove = f.ctx.on('tools/result', () => { f.agent.session = replacement; });
  let result;
  try { result = await f.execute('node --test success.test.mjs', { callId: 'swap-call' }); }
  finally { remove(); f.agent.session = original; }
  assert.equal(result.result.meta?.[SIGNAL_META], undefined);
  assert.equal(f.records.length, 0);
  assert(replacement.snapshotEvents().filter((event) => event.type === 'tool/result').every((event) => event.data.meta?.[SIGNAL_META] === undefined));
});

integration('foreground jobs expose completed process facts; background acknowledgements stay unknown', async (t) => {
  const f = await fixture(t, { jobs: true });
  const foreground = await f.execute('node --test success.test.mjs');
  assert.equal(foreground.result.meta[SIGNAL_META].result, 'succeeded');
  const background = await f.execute('node --test slow.test.mjs', { run_in_background: true });
  assert.equal(background.result.meta[SIGNAL_META].runKind, 'command');
  assert.equal(background.result.meta[SIGNAL_META].result, 'unknown');
  assert.equal(background.result.meta[SIGNAL_META].exitCode, null);
  assert.equal(background.result.meta[SIGNAL_META].durationMs, null);
});

integration('actual sandbox diagnostics never claim a partially executed command never ran', async (t) => {
  // Real bash/process and real SandboxBashExecutor classifiers; only the
  // confinement provider is a controlled pass-through, not an OS sandbox test.
  const f = await fixture(t, { sandbox: true });
  const { result } = await f.execute('printf PRIVATE_SIDE_EFFECT > partial.txt; printf "Permission denied" >&2; exit 1');
  assert.equal(await readFile(join(f.home, 'partial.txt'), 'utf8'), 'PRIVATE_SIDE_EFFECT');
  assert.equal(result.value.sandbox.denied, true);
  assert.equal(result.meta[SIGNAL_META].result, 'unknown');
  assert.equal(result.meta[SIGNAL_META].exitCode, 1);
  assert.equal(f.records[0].metadata.result, 'unknown');

  // The pinned bwrap rule is signature-only. The real classifier may throw
  // SANDBOX_UNAVAILABLE after the inner command has already produced effects.
  f.ctx.sandbox.confine = async (argv) => ({ argv, enforcement: 'synthetic-pass-through',
    denialSignatures: [], runnerFailureRules: [{ fatalSignatures: ['bwrap: '] }] });
  const failed = await f.execute('printf PRIVATE_RUNNER_EFFECT > runner-partial.txt; printf "bwrap: synthetic failure" >&2; exit 1');
  assert.equal(await readFile(join(f.home, 'runner-partial.txt'), 'utf8'), 'PRIVATE_RUNNER_EFFECT');
  assert.equal(failed.result.isError, true);
  assert.equal(failed.result.meta[SIGNAL_META].result, 'unknown');
  assert.equal(failed.result.meta[SIGNAL_META].exitCode, null);
  assert.equal(f.records.length, 2);
  assert.equal(f.records[1].metadata.result, 'unknown');
});
