import { test } from 'node:test';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { fixture } from './support/native-feed-fixture.mjs';

const WALL = 1000000;
const DATA0 = { t: 'data', data: { n: 0 } };
const PATCH1 = { t: 'patch', merge: { n: 1 } };

async function setup(t) {
  const clock = { mono: 0, wall: WALL };
  const steps = [], sends = [];
  let f, timeout;
  const requests = () => timeout?.mock.calls.map(call => call.arguments[1]) ?? [];
  t.after(async () => {
    try {
      await Promise.resolve(); // Let the real producer hand its cancel back through call().
      t.diagnostic(JSON.stringify({ case: t.name, steps, sends, timeoutRequests: requests() }));
    } finally {
      try { f?.close(); } finally { t.mock.reset(); }
    }
  });
  t.mock.timers.enable({ apis: ['setTimeout'], now: 0 });
  t.mock.method(Date, 'now', () => clock.wall);
  t.mock.method(performance, 'now', () => clock.mono);
  f = fixture();
  await Promise.resolve();
  f.feed.attach({ id: 'clock', send: message => sends.push({
    mono: clock.mono, wallOffset: clock.wall - WALL, message,
  }) });
  // Pass through to Node's public MockTimers. Registration's 300 ms timer predates this spy.
  timeout = t.mock.method(globalThis, 'setTimeout');
  return {
    emit(value) {
      steps.push({ op: 'emit', mono: clock.mono, wallOffset: clock.wall - WALL, value });
      f.emit(value);
    },
    advance(delta, wallOffset) {
      clock.mono += delta; clock.wall = WALL + wallOffset;
      steps.push({ op: 'advance', delta, mono: clock.mono, wallOffset });
      t.mock.timers.tick(delta);
    },
    // Preserve all event types; remove only routing and opaque revision fields from the oracle.
    events: () => sends.map(({ message: { sub, rev, base, ...event } }) => event),
    messages: () => sends.map(({ message }) => message),
    requests,
    get rev() { return f.feed.rev; },
  };
}

function first(f) {
  f.emit({ n: 0 });
  assert.deepEqual(f.events(), [], 'first emit must remain asynchronous');
  f.advance(0, 0);
  assert.deepEqual(f.events(), [DATA0], 'first data preparation');
  assert.equal(typeof f.rev, 'string');
  return f.rev;
}

function patch(f, base, n) {
  const message = f.messages().at(-1);
  assert.equal(message.t, 'patch');
  assert.equal(message.base, base);
  assert.notEqual(message.rev, base);
  assert.equal(f.rev, message.rev);
  assert.deepEqual(message.merge, { n });
}

test('R1 ordinary feed publishes after elapsed time despite wall rollback', async t => {
  const f = await setup(t), base = first(f);
  f.advance(300, 300); // Complete registration's unrelated changed timer before the correction.
  f.advance(700, -59000);
  f.emit({ n: 1 });
  assert.deepEqual(f.events(), [DATA0], 'R1 emit remains asynchronous');
  f.advance(0, -59000);
  assert.deepEqual(f.events(), [DATA0, PATCH1],
    'R1 semantic oracle: a wall rollback must not stall an elapsed ordinary feed window');
  assert.deepEqual(f.requests(), [0, 0]);
  patch(f, base, 1);
});

test('R2 ordinary feed retains its elapsed window after a forward wall correction', async t => {
  const f = await setup(t), base = first(f);
  f.advance(100, 60100);
  f.emit({ n: 1 });
  assert.deepEqual(f.events(), [DATA0], 'R2 emit remains asynchronous');
  f.advance(0, 60100);
  assert.deepEqual(f.events(), [DATA0],
    'R2 semantic oracle: a wall correction must not release an ordinary feed update before its elapsed window');
  assert.deepEqual(f.requests(), [0, 150]);
  f.advance(149, 60249);
  assert.deepEqual(f.events(), [DATA0]);
  f.advance(1, 60250);
  assert.deepEqual(f.events(), [DATA0, PATCH1]);
  patch(f, base, 1);
});

test('C1 ordinary feed keeps zero, asynchronous first, latest value and armed timer distinct', async t => {
  const f = await setup(t);
  f.emit({ n: 1 }); f.emit({ n: 2 });
  assert.deepEqual(f.requests(), [0]);
  assert.deepEqual(f.events(), []);
  f.advance(0, 0);
  const data = { t: 'data', data: { n: 2 } }, base = f.rev;
  assert.deepEqual(f.events(), [data]);
  f.emit({ n: 3 });
  assert.deepEqual(f.requests(), [0, 250], 'a real flush at mono zero starts a full window');
  f.advance(0, 0);
  assert.deepEqual(f.events(), [data]);
  f.advance(100, 100); f.emit({ n: 4 });
  assert.deepEqual(f.requests(), [0, 250], 'an armed timer is not rescheduled');
  f.advance(149, 249);
  assert.deepEqual(f.events(), [data]);
  f.advance(1, 250);
  assert.deepEqual(f.events(), [data, { t: 'patch', merge: { n: 4 } }]);
  patch(f, base, 4);
});

test('C2 ordinary feed rounds a positive fractional request up without a private scheduler', async t => {
  const f = await setup(t), base = first(f);
  f.advance(99.25, 99); f.emit({ n: 1 });
  // MockTimers retains fractional delays; inspect the actual public request, not a fake floor.
  assert.deepEqual(f.requests(), [0, 151]);
  assert.deepEqual(f.events(), [DATA0]);
  f.advance(150, 249);
  assert.deepEqual(f.events(), [DATA0]);
  f.advance(0.75, 250);
  assert.deepEqual(f.events(), [DATA0]);
  f.advance(0.25, 250);
  assert.deepEqual(f.events(), [DATA0, PATCH1]);
  patch(f, base, 1);
});

test('C3 ordinary feed duplicate flush consumes its window without changing the revision', async t => {
  const f = await setup(t), base = first(f);
  f.advance(100, 100); f.emit({ n: 0 });
  assert.deepEqual(f.requests(), [0, 150]);
  f.advance(150, 250);
  assert.deepEqual(f.events(), [DATA0]);
  assert.equal(f.rev, base);
  f.advance(100, 350); f.emit({ n: 1 });
  assert.deepEqual(f.requests(), [0, 150, 150], 'the duplicate flush owns the next window');
  f.advance(0, 350);
  assert.deepEqual(f.events(), [DATA0]);
  f.advance(149, 499);
  assert.deepEqual(f.events(), [DATA0]);
  f.advance(1, 500);
  assert.deepEqual(f.events(), [DATA0, PATCH1]);
  patch(f, base, 1);
});
