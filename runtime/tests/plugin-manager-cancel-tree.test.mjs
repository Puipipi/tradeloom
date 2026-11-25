// Exact service-source helpers; process/record operations are explicit unit seams.
// This file does not claim to run a Host or terminate a real process.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import vm from 'node:vm';

const modulePath = process.env.PLUGIN_MANAGER_MODULE
  ?? (process.env.DSH_PREFIX && join(process.env.DSH_PREFIX, 'node_modules/@deepseek-ai/dsh-plugin-manager/lib/index.js'));
if (!modulePath) throw Error('Set DSH_PREFIX or PLUGIN_MANAGER_MODULE to the candidate service module');
const source = readFileSync(modulePath, 'utf8');
const start = source.indexOf('//#region lib/types/run-tree.js');
const end = source.indexOf('//#endregion', start);
assert(start >= 0 && end > start);
const segment = source.slice(start, end);

function fixture({cooperative = false, killWorks = true, live = true, probeError, signalError, pid = 12345} = {}) {
  const state = {live, record: undefined, signals: [], probes: 0, removals: 0};
  const context = vm.createContext({
    Error, Promise, performance, setTimeout,
    process: {platform: 'linux', kill() { throw Error('Unexpected real process operation in unit fixture'); }},
    runRecordPath: dir => dir + '/run.json',
    optionalFile: () => state.record,
    recordRun: async (_, tree) => { if (tree.pid !== undefined) state.record = JSON.stringify(tree) + '\n'; },
    rm: async () => { state.removals++; state.record = undefined; },
  });
  const api = new vm.Script(segment + '\n({treeAlive, ownedRunGuard, ownedStopFailure, stopOwnedRuns})').runInContext(context);
  const internals = {
    waitMs: 0,
    alive(target) {
      assert.equal(target, -pid); state.probes++;
      if (probeError) throw Object.assign(Error('Synthetic probe error'), {code: probeError});
      if (!state.live) throw Object.assign(Error('Synthetic absent group'), {code: 'ESRCH'});
      return true;
    },
    kill(target, signal) {
      assert.equal(target, -pid); state.signals.push(signal);
      if (signalError) throw Object.assign(Error('Synthetic signal error'), {code: signalError});
      if (signal === 'SIGTERM' && cooperative || signal === 'SIGKILL' && killWorks) state.live = false;
      return true;
    },
  };
  const abort = new AbortController();
  const guard = api.ownedRunGuard('/synthetic-owned-profile', {pid, grouped: true}, abort.signal, internals);
  return {api, guard, abort, state, internals};
}

test('ESRCH confirms absence once; later calls never probe a reused numeric PID', async () => {
  const f = fixture({live: false});
  await f.guard.stop(); const probes = f.state.probes;
  f.state.live = true;
  await f.guard.stop(); await f.guard.release();
  assert.equal(f.guard.confirmedGone, true); assert.equal(f.state.probes, probes); assert.deepEqual(f.state.signals, []);
});

test('observed normal group exit is sticky before a later cancellation', async () => {
  const f = fixture({live: false}); assert.equal(f.guard.observe(), true);
  const probes = f.state.probes; f.state.live = true; f.abort.abort(); await f.guard.stop();
  assert.equal(f.state.probes, probes); assert.deepEqual(f.state.signals, []); await f.guard.release();
});

for (const code of ['EPERM', 'EIO']) test(`probe ${code} is not evidence of disappearance`, async () => {
  const f = fixture({probeError: code}); await f.guard.record();
  const initial = f.state.record;
  await assert.rejects(f.guard.stop(), /cannot confirm/);
  await assert.rejects(f.guard.failed, error => error === f.guard.failure);
  await assert.rejects(f.guard.release(), error => error === f.guard.failure);
  assert.equal(f.guard.confirmedGone, false); assert.equal(f.state.record, initial); assert.equal(f.state.removals, 0);
});

test('cooperative group is confirmed after TERM without escalation', async () => {
  const f = fixture({cooperative: true}); await f.guard.record(); await f.guard.stop(); await f.guard.release();
  assert.deepEqual(f.state.signals, ['SIGTERM']); assert.equal(f.guard.confirmedGone, true); assert.equal(f.state.removals, 1);
});

test('TERM-resistant group requires KILL and a subsequent absence probe', async () => {
  const f = fixture(); await f.guard.record();
  const first = f.guard.stop(); assert.equal(f.guard.stop(), first); await first;
  assert.deepEqual(f.state.signals, ['SIGTERM', 'SIGKILL']); assert.equal(f.guard.confirmedGone, true);
  await f.guard.release(); await f.guard.release(); assert.equal(f.state.removals, 1);
});

test('successful signal calls with a still-present group fail and preserve the record', async () => {
  const f = fixture({killWorks: false}); await f.guard.record(); const original = f.state.record;
  await assert.rejects(f.guard.stop(), /cannot confirm/);
  await assert.rejects(f.guard.failed, error => error === f.guard.failure);
  await assert.rejects(f.guard.release(), /cannot confirm/);
  assert.deepEqual(f.state.signals, ['SIGTERM', 'SIGKILL']); assert.equal(f.state.record, original); assert.equal(f.state.removals, 0);
});

test('signal EPERM remains a failure even when the parent may have exited', async () => {
  const f = fixture({signalError: 'EPERM'}); await assert.rejects(f.guard.stop(), /cannot confirm/);
  assert.equal(f.guard.confirmedGone, false); assert.deepEqual(f.state.signals, ['SIGTERM']); f.guard.detach();
});

test('signal ESRCH is positive absence evidence, not a reason to escalate', async () => {
  const f = fixture({signalError: 'ESRCH'}); await f.guard.stop();
  assert.equal(f.guard.confirmedGone, true); assert.deepEqual(f.state.signals, ['SIGTERM']); f.guard.detach();
});

test('primary release cannot erase a different repair record', async () => {
  const f = fixture({live: false}); await f.guard.record(); await f.guard.stop();
  f.state.record = JSON.stringify({pid: 54321, grouped: true}) + '\n'; const repair = f.state.record;
  await f.guard.release(); assert.equal(f.state.record, repair); assert.equal(f.state.removals, 0);
});

test('failure deferred is pending at spawn and observes a later abort', async () => {
  const f = fixture({killWorks: false});
  assert.equal(await Promise.race([f.guard.failed, Promise.resolve('parent-control')]), 'parent-control');
  f.abort.abort(); await assert.rejects(f.guard.failed, /cannot confirm/);
  assert.equal(f.guard.failure instanceof Error, true); f.guard.detach();
});

test('normal release does not signal a background group or later reuse its identity', async () => {
  const f = fixture(); await f.guard.record(); await f.guard.release();
  assert.equal(f.state.live, true); assert.deepEqual(f.state.signals, []);
  f.abort.abort(); assert.deepEqual(f.state.signals, []);
  await assert.rejects(f.guard.stop(), /cannot confirm/); assert.equal(f.state.probes, 0);
});

test('one stop failure does not prevent stopping another owned group', async () => {
  const failed = fixture({killWorks: false}); const other = fixture({cooperative: true});
  await assert.rejects(failed.api.stopOwnedRuns([failed.guard, other.guard]), error => error === failed.guard.failure);
  assert.equal(other.guard.confirmedGone, true); assert.deepEqual(other.state.signals, ['SIGTERM']);
  failed.guard.detach(); other.guard.detach();
});

test('spawn failure with no PID never targets zero or the current process group', async () => {
  const f = fixture();
  const guard = f.api.ownedRunGuard('/synthetic', {pid: undefined, grouped: true}, undefined, f.internals);
  await guard.stop(); assert.equal(guard.confirmedGone, true); assert.equal(f.state.probes, 0); assert.deepEqual(f.state.signals, []);
  assert.throws(() => f.api.ownedRunGuard('/synthetic', {pid: 0, grouped: true}), /Invalid owned/);
  assert.throws(() => f.api.ownedRunGuard('/synthetic', {pid: 1, grouped: false}), /Invalid owned/); f.guard.detach();
});
