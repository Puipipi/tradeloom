// Node production emit -> coalescing timer -> Feed.#flush; oracle outside timed samples.
import assert from 'node:assert/strict';
import { mock } from 'node:test';
import { performance } from 'node:perf_hooks';
import { fixture } from '../tests/support/native-feed-fixture.mjs';

const [label, shape, subscribedText] = process.argv.slice(2);
const subscribed = subscribedText === '1';
const count = { tiny: 0, modest: 24, nearLimit: 400 }[shape];
assert.notEqual(count, undefined);
const rows = Array.from({ length: count }, (_, i) => ({ id: i, label: `usage-${i}`, input: 12, output: 34 }));
const values = [0, 1].map(n => ({ n, rows }));
const bytes = Buffer.byteLength(JSON.stringify(values[0]));
assert.ok(bytes <= 32768);
mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1000000 });
const f = fixture();
let last, sent = 0;
if (subscribed) f.feed.attach({ id: 's', send: msg => { last = msg; sent++; } });
let iteration = 0;
function update() { f.emit(values[iteration++ % 2]); mock.timers.tick(250); }
function oracle() {
  assert.deepEqual(f.feed.data, values[(iteration - 1) % 2]);
  assert.equal(f.feed.seq, iteration);
  assert.equal(f.feed.rev, `${f.feed.epoch}.${iteration}`);
  assert.equal(f.feed.waiters.length, 0);
  assert.equal(f.feed.stopped, false);
  if (subscribed) {
    assert.equal(sent, iteration);
    assert.equal(last.rev, f.feed.rev);
    assert.equal(last.base, `${f.feed.epoch}.${iteration - 1}`);
    assert.deepEqual(last.merge, { n: (iteration - 1) % 2 });
  } else { assert.equal(sent, 0); }
}
try {
  for (let i = 0; i < 200; i++) update();
  oracle();
  const batch = shape === 'tiny' ? 5000 : shape === 'modest' ? 1000 : 150;
  for (let sample = 0; sample < 11; sample++) {
    const start = performance.now();
    for (let i = 0; i < batch; i++) update();
    const elapsedMs = performance.now() - start;
    oracle();
    console.log(JSON.stringify({ label, shape, subscribed, rows: count, payloadBytes: bytes,
      sample, batch, elapsedMs, usPerUpdate: elapsedMs * 1000 / batch }));
  }
} finally { f.close(); mock.timers.reset(); }
