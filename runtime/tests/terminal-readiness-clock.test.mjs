import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createReadinessFixture } from '../tools/terminal-readiness-clock-fixture.mjs';

const prefix = process.env.DSH_PREFIX;
const pending = { settled: false, waitReason: null };
const idle = { settled: true, waitReason: 'inferred_idle' };
const stdin = { settled: true, waitReason: 'stdin_read' };
const timeout = { settled: true, waitReason: 'timeout' };
const waitingChild = { processGroupId: 22, inputWaiting: true };

// Each test owns its clocks, actual backend session and Cordis owner. File tests
// stay serial; these are controlled SubprocessTerminalHandle contract cases.
test('terminal readiness clock: C1 normal silence settles at 3000ms', { concurrency: false }, async t => {
  const f = await createReadinessFixture(t, prefix, 'C1');
  const op = await f.start('sleep 10', undefined);
  await f.emit('working\n');
  await f.advance(2950);
  assert.deepEqual(f.snapshot(op, 'silence-2950'), pending);
  await f.advance(50);
  assert.deepEqual(f.snapshot(op, 'silence-3000'), idle);
});

test('terminal readiness clock: R1 forward wall jump cannot end silence early', { concurrency: false }, async t => {
  const f = await createReadinessFixture(t, prefix, 'R1');
  const op = await f.start('sleep 10', undefined);
  await f.emit('working\n');
  f.jumpWall(10000);
  await f.advance(50);
  assert.deepEqual(f.snapshot(op, 'silence-50'), pending); // A: inferred_idle at 50ms.
  await f.advance(2950);
  assert.deepEqual(f.snapshot(op, 'silence-3000'), idle);
});

test('terminal readiness clock: R2 backward wall jump cannot prolong silence', { concurrency: false }, async t => {
  const f = await createReadinessFixture(t, prefix, 'R2');
  const op = await f.start('sleep 10', undefined);
  await f.emit('working\n');
  f.jumpWall(-10000);
  await f.advance(3000);
  assert.deepEqual(f.snapshot(op, 'silence-3000'), idle); // A: public done still pending.
});

test('terminal readiness clock: R3 forward wall jump preserves the 150ms exact readiness gate', { concurrency: false }, async t => {
  const f = await createReadinessFixture(t, prefix, 'R3');
  const op = await f.start('cat', waitingChild);
  f.jumpWall(1000); // Crosses the 150ms readiness gate, below the separate 3000ms silence tier.
  await f.advance(50);
  assert.deepEqual(f.snapshot(op, 'exact-50'), pending); // A: stdin_read at 50ms.
  await f.advance(100);
  assert.deepEqual(f.snapshot(op, 'exact-150'), stdin);
});

test('terminal readiness clock: R4 backward wall jump preserves the 150ms exact readiness gate', { concurrency: false }, async t => {
  const f = await createReadinessFixture(t, prefix, 'R4');
  const op = await f.start('cat', waitingChild);
  f.jumpWall(-1000);
  await f.advance(150);
  assert.deepEqual(f.snapshot(op, 'exact-150'), stdin); // A: public done still pending.
});

test('terminal readiness clock: R5 complete prompt survives a following wall rollback', { concurrency: false }, async t => {
  const f = await createReadinessFixture(t, prefix, 'R5');
  const op = await f.start('true', { processGroupId: 11, inputWaiting: true });
  await f.emit('\x1b]133;D;0\x07dsh> ');
  f.jumpWall(-1000);
  await f.advance(50);
  assert.deepEqual(f.snapshot(op, 'prompt-50'), stdin); // A: prompt idleFor is negative.
});

test('terminal readiness clock: C2 hard timeout still bounds a partial prompt', { concurrency: false }, async t => {
  const f = await createReadinessFixture(t, prefix, 'C2', { timeoutMs: 1000 });
  const op = await f.start('sleep 10', undefined);
  await f.emit('\x1b]133;D;0\x07ds');
  f.jumpWall(-10000);
  await f.advance(999);
  assert.deepEqual(f.snapshot(op, 'timeout-999', false), pending);
  await f.advance(1);
  assert.deepEqual(f.snapshot(op, 'timeout-1000', false), timeout);
});
