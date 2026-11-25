import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './support/native-feed-fixture.mjs';

function setup(t) {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1000000 });
  const f = fixture();
  t.after(() => f.close());
  return f;
}
function flush(t) { t.mock.timers.tick(250); }
function serializations(t, action) {
  const original = JSON.stringify;
  let count = 0;
  const spy = t.mock.method(JSON, 'stringify', function(...args) { count++; return Reflect.apply(original, this, args); });
  try { action(); } finally { spy.mock.restore(); }
  return count;
}

test('idle feed updates data and revision without serializing an unsent patch', async t => {
  const f = setup(t);
  f.emit({ n: 1, nested: { keep: 'k' } }); flush(t);
  const old = f.feed.rev;
  f.feed.pin(); f.feed.unpin(); // GET view releases its pin without a stream subscriber.
  f.emit({ n: 2, nested: { keep: 'k' } });
  assert.equal(serializations(t, () => flush(t)), 0, 'no receiver requires no patch JSON round-trip');
  assert.notEqual(f.feed.rev, old);
  assert.equal(f.feed.seq, 2);
  assert.deepEqual(f.feed.data, { n: 2, nested: { keep: 'k' } });
  const got = [];
  f.feed.attach({ id: 'late', send: m => got.push(m) }, old);
  assert.deepEqual(got, [{ t: 'data', sub: 'late', rev: f.feed.rev, data: f.feed.data }]);
});

test('subscribed feed preserves patch, base, payload and serialization', t => {
  const f = setup(t), got = [];
  f.feed.attach({ id: 's', send: m => got.push(m) });
  f.emit({ n: 1, remove: true }); flush(t);
  const base = f.feed.rev;
  f.emit({ n: 2 });
  assert.equal(serializations(t, () => flush(t)), 1);
  assert.deepEqual(got[1], { t: 'patch', sub: 's', rev: f.feed.rev, base, merge: { remove: null, n: 2 } });
});

test('first-data waiters resolve before idle exit and current revision subscribes with sync', async t => {
  const f = setup(t);
  const first = f.feed.waitFirst(1000);
  f.emit({ n: 1 }); flush(t);
  await first;
  assert.equal(f.feed.waiters.length, 0);
  const rev = f.feed.rev, got = [];
  f.feed.attach({ id: 's', send: m => got.push(m) }, rev);
  assert.deepEqual(got, [{ t: 'sync', sub: 's', rev }]);
  f.emit({ n: 1 }); flush(t);
  assert.equal(f.feed.rev, rev);
  assert.equal(got.length, 1);
});

test('subscription set at flush time determines whether a patch has a receiver', t => {
  const f = setup(t), got = [];
  const sub = { id: 's', send: m => got.push(m) };
  f.emit({ n: 0 }); flush(t);
  f.feed.attach(sub);
  f.emit({ n: 1 });
  f.feed.detach(sub);
  assert.equal(serializations(t, () => flush(t)), 0);
  f.emit({ n: 2 });
  f.feed.attach(sub);
  const base = f.feed.rev;
  assert.equal(serializations(t, () => flush(t)), 1);
  assert.deepEqual(got.at(-1), { t: 'patch', sub: 's', rev: f.feed.rev, base, merge: { n: 2 } });
});

test('idle null transitions and burst coalescing preserve latest state', t => {
  const f = setup(t);
  f.emit({ n: 0 }); flush(t);
  f.emit(null); flush(t);
  assert.equal(f.feed.data, null);
  assert.equal(f.feed.seq, 2);
  f.emit({ n: 1 }); f.emit({ n: 2 }); flush(t);
  assert.deepEqual(f.feed.data, { n: 2 });
  assert.equal(f.feed.seq, 3);
  const got = [];
  f.feed.attach({ id: 's', send: m => got.push(m) });
  assert.deepEqual(got[0].data, { n: 2 });
});

test('idle optimization retains linger cancellation and late callbacks stay stopped', async t => {
  const f = setup(t);
  await Promise.resolve(); // producer hands its synchronous cancel back through call().
  f.feed.pin(); f.emit({ n: 0 }); flush(t); f.feed.unpin();
  f.emit({ n: 1 }); flush(t);
  t.mock.timers.tick(30000);
  assert.equal(f.feed.stopped, true);
  assert.equal(f.cancels, 1);
  const rev = f.feed.rev;
  f.emit({ n: 2 }); flush(t);
  assert.equal(f.feed.rev, rev);
  assert.deepEqual(f.feed.data, { n: 1 });
});
