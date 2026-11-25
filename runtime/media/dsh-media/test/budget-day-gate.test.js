import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { withFileLock } from '@deepseek-ai/dsh-atomic-write';
import { createBudgetLedger } from '../src/budget-ledger.js';

const beforeShanghaiMidnight = Date.parse('2026-10-28T15:59:59Z');
const afterShanghaiMidnight = Date.parse('2026-10-28T16:00:01Z');
const mismatch = { code: 'reservation_day_mismatch' };
function reservation(estimateMicros = 20_000_000) {
  return { rid: 'm_' + randomUUID(), estimateMicros, request: {
    sessionId: 'day-gate-review', serviceId: 'review-service', modelId: 'review-model',
    profile: 'review-only', region: 'cn-beijing', baseUrl: 'https://example.test/api',
    keyRef: 'REVIEW_KEY_REF', cwd: '/review/workspace', workspaceRoot: '/review/workspace',
    paramsHash: 'a'.repeat(64),
  } };
}
async function fixture(t, initial = beforeShanghaiMidnight) {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-budget-day-gate-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let clock = initial;
  const ledger = createBudgetLedger(directory, { clock: () => clock });
  return { directory, ledger, setClock: value => { clock = value; },
    bytes: () => readFile(join(directory, 'ledger-v1.json')) };
}

test('old unsent reservation cannot cross today gate or mutate the ledger', async t => {
  const f = await fixture(t);
  const oldInput = reservation();
  const old = (await f.ledger.reserve(oldInput)).record;
  f.setClock(afterShanghaiMidnight);
  const current = (await f.ledger.reserve(reservation())).record;
  assert.equal((await f.ledger.beginSubmission(current.rid, current.identity)).started, true);
  const before = await f.bytes();
  await assert.rejects(f.ledger.beginSubmission(old.rid, old.identity), mismatch);
  assert.deepEqual(await f.bytes(), before);
  const replay = await f.ledger.reserve(oldInput);
  assert.equal(replay.created, false);
  assert.equal(replay.record.day, '2026-10-28');
  assert.equal(replay.record.state, 'reserved');
  assert.equal((await f.ledger.releaseUnsent(old.rid, old.identity)).state, 'released');
  await assert.rejects(f.ledger.reserve(reservation(1)), { code: 'budget_exceeded' });
});

test('a writer actually blocked before midnight samples the day after acquiring the lock', { timeout: 10000 }, async t => {
  const f = await fixture(t);
  const record = (await f.ledger.reserve(reservation())).record;
  const before = await f.bytes();
  let held;
  const acquired = new Promise(resolve => { held = resolve; });
  let release;
  const blocker = new Promise(resolve => { release = resolve; });
  const holding = withFileLock(join(f.directory, 'ledger-v1.json'), async () => {
    held();
    await blocker;
  });
  t.after(release);
  await acquired;
  const child = fork(fileURLToPath(new URL('./fixtures/day-gate-worker.mjs', import.meta.url)),
    [f.directory, JSON.stringify(record), String(beforeShanghaiMidnight)], { silent: true });
  t.after(() => child.kill('SIGKILL'));
  let stderr = '';
  child.stderr.on('data', data => { stderr += data; });
  const message = type => new Promise((resolve, reject) => {
    const receive = value => {
      if (value?.type !== type) return;
      child.off('message', receive);
      resolve(value);
    };
    child.on('message', receive);
    child.once('error', reject);
  });
  const blocked = message('blocked');
  const advanced = message('advanced');
  const outcome = message('outcome');
  const closed = new Promise(resolve => child.once('close', (code, signal) => resolve({ code, signal })));
  await blocked; // Observed a real EEXIST from the active writer lock.
  child.send({ type: 'clock', value: afterShanghaiMidnight });
  await advanced;
  release();
  await holding;
  assert.deepEqual(await outcome, { type: 'outcome', code: 'reservation_day_mismatch' });
  assert.deepEqual(await closed, { code: 0, signal: null }, stderr);
  assert.deepEqual(await f.bytes(), before);
});

test('cross-day unknown state stays nonrepeatable and can still receive settlement', async t => {
  const f = await fixture(t);
  const record = (await f.ledger.reserve(reservation())).record;
  assert.equal((await f.ledger.beginSubmission(record.rid, record.identity)).started, true);
  f.setClock(afterShanghaiMidnight);
  const before = await f.bytes();
  const replay = await f.ledger.beginSubmission(record.rid, record.identity);
  assert.equal(replay.started, false);
  assert.equal(replay.record.state, 'submission_unknown');
  assert.deepEqual(await f.bytes(), before);
  await assert.rejects(f.ledger.releaseUnsent(record.rid, record.identity), { code: 'submission_may_have_happened' });
  const settled = await f.ledger.settle(record.rid, record.identity, { chargeMicros: 20_000_000, basis: 'estimate' });
  assert.equal(settled.day, '2026-10-28');
  assert.equal(settled.state, 'settled');
});

test('UTC midnight within one Shanghai day does not invalidate a reservation', async t => {
  const f = await fixture(t, Date.parse('2026-10-28T23:59:59Z'));
  const record = (await f.ledger.reserve(reservation())).record;
  f.setClock(Date.parse('2026-10-29T00:00:01Z'));
  const result = await f.ledger.beginSubmission(record.rid, record.identity);
  assert.equal(result.started, true);
  assert.equal(result.record.day, '2026-10-29');
});

test('clock moving to an earlier Shanghai date also fails closed', async t => {
  const f = await fixture(t, afterShanghaiMidnight);
  const record = (await f.ledger.reserve(reservation())).record;
  f.setClock(beforeShanghaiMidnight);
  const before = await f.bytes();
  await assert.rejects(f.ledger.beginSubmission(record.rid, record.identity), mismatch);
  assert.deepEqual(await f.bytes(), before);
});
