import test from 'node:test';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const base = join(resolve(process.env.DSH_PREFIX), 'node_modules/@deepseek-ai');
const { Context } = await import(pathToFileURL(join(base, 'cordis/lib/index.js')));
const { LocalJobRegistry } = await import(pathToFileURL(join(base, 'dsh-jobs-local/lib/index.js')));

async function registry(t, config = {}) {
  const ctx = new Context();
  await ctx.plugin(LocalJobRegistry, config);
  ctx.jobs.attachController('ring-test');
  t.after(() => ctx.fiber.dispose());
  return ctx.jobs;
}

function start(jobs, chunks) {
  const completion = Promise.withResolvers();
  let producer;
  const id = jobs.start({ kind: 'fixture', label: 'Ring fixture', run(handle) {
    producer = handle;
    for (const chunk of chunks) handle.append(chunk.text, chunk.options);
    return { done: completion.promise, cancel: () => completion.resolve({ status: 'killed' }) };
  } });
  return { id, producer, async finish() {
    completion.resolve({ status: 'completed', result: { ok: true } });
    await jobs.wait(id, 1000);
  } };
}

const ascii = count => Array.from({ length: count }, (_, index) => ({
  text: String(index).padStart(15, '0') + '\n', options: { channel: index % 2 ? 'stderr' : 'stdout' },
}));

for (const count of [200, 2000, 10000]) {
  test(`terminal read batches head eviction for ${count} real producer chunks`, async t => {
    const jobs = await registry(t), chunks = ascii(count), job = start(jobs, chunks);
    await job.finish();
    const ring = jobs.store.get(job.id).ring, array = ring.chunks;
    const shift = array.shift, copyWithin = array.copyWithin;
    let shifts = 0, copies = 0;
    array.shift = function (...args) { shifts++; return shift.apply(this, args); };
    array.copyWithin = function (...args) { copies++; return copyWithin.apply(this, args); };
    let first;
    try { first = jobs.read(job.id); }
    finally { delete array.shift; delete array.copyWithin; }
    const kept = Math.min(count, 1024), dropped = count - kept;
    t.diagnostic(`chunks=${count} dropped=${dropped} shift=${shifts} bulk-copy=${copies} kept=${ring.chunks.length}`);
    assert.equal(shifts, dropped === 1 ? 1 : 0);
    assert.equal(copies, dropped > 1 ? 1 : 0);
    assert.equal(ring.chunks, array, 'the array identity is retained');
    assert.deepEqual(first.chunks.map(row => row.text), chunks.map(row => row.text));
    assert.deepEqual(first.result, { ok: true });
    assert.equal(first.lossy, false);
    assert.equal(first.job.output.earliest, dropped * 16);
    const resumed = jobs.readAt(job.id, 0);
    assert.equal(resumed.lossy, dropped > 0);
    assert.equal(resumed.next, count * 16);
    assert.deepEqual(resumed.chunks.map(row => row.text), chunks.slice(dropped).map(row => row.text));
    assert.deepEqual(resumed.chunks.map(row => row.channel), chunks.slice(dropped).map(row => row.options.channel));
    assert.deepEqual(jobs.read(job.id).chunks, []);
  });
}

test('ordinary single-chunk eviction retains the shift path and byte offsets', async t => {
  const jobs = await registry(t, { retainBytes: 64, settledRetainBytes: 32 });
  const job = start(jobs, ascii(4)), ring = jobs.store.get(job.id).ring;
  const shift = ring.chunks.shift, copyWithin = ring.chunks.copyWithin;
  let shifts = 0, copies = 0;
  ring.chunks.shift = function (...args) { shifts++; return shift.apply(this, args); };
  ring.chunks.copyWithin = function (...args) { copies++; return copyWithin.apply(this, args); };
  try { job.producer.append('000000000000004\n', { gapBefore: true }); }
  finally { delete ring.chunks.shift; delete ring.chunks.copyWithin; }
  assert.equal(shifts, 1);
  assert.equal(copies, 0);
  const read = jobs.readAt(job.id, 0);
  assert.equal(read.lossy, true);
  assert.equal(read.chunks[0].at, 16);
  assert.equal(read.chunks.at(-1).gapBefore, true);
  await job.finish();
});

test('bulk eviction followed by oversized UTF-8 tail keeps whole characters and gap semantics', async t => {
  const jobs = await registry(t, { retainBytes: 128, settledRetainBytes: 5 });
  const job = start(jobs, [
    { text: 'a' }, { text: 'b' }, { text: 'c' }, { text: '你好🙂', options: { channel: 'stderr' } },
  ]);
  await job.finish();
  const first = jobs.read(job.id);
  assert.deepEqual(first.chunks.map(row => row.text), ['a', 'b', 'c', '你好🙂']);
  const tail = jobs.readAt(job.id, 0);
  assert.equal(tail.lossy, true);
  assert.equal(tail.next, 13);
  assert.deepEqual(tail.chunks, [{ at: 9, text: '🙂', channel: 'stderr', gapBefore: true }]);
  assert.equal(first.chunks.at(-1).text, '你好🙂', 'previous wire chunks stay detached');
});

test('empty and exactly capped output do not add an eviction or change the resume boundary', async t => {
  const jobs = await registry(t, { retainBytes: 64, settledRetainBytes: 16 });
  for (const chunks of [[], ascii(1)]) {
    const job = start(jobs, chunks);
    await job.finish();
    const first = jobs.read(job.id);
    assert.equal(first.lossy, false);
    assert.equal(first.job.output.earliest, 0);
    assert.equal(jobs.readAt(job.id, first.job.output.total).lossy, false);
  }
});

test('optional benchmark of real terminal read and single-eviction append', { skip: process.env.DSH_JOB_RING_BENCH !== '1' }, async t => {
  const jobs = await registry(t);
  for (const count of [200, 2000, 10000, 32000]) {
    const chunks = count === 32000
      ? Array.from({ length: count }, (_, index) => ({ text: String(index).padStart(7, '0') + '\n' }))
      : ascii(count);
    const samples = [];
    for (let round = 0; round < 15; round++) {
      const job = start(jobs, chunks);
      await job.finish();
      const before = performance.now();
      const result = jobs.read(job.id);
      const elapsed = performance.now() - before;
      assert.equal(result.chunks.length, count);
      jobs.remove(job.id);
      if (round >= 5) samples.push(elapsed);
    }
    t.diagnostic(JSON.stringify({ scenario: 'terminal-read', count, samples }));
  }
  const live = await registry(t, { retainBytes: 4096, settledRetainBytes: 1024 });
  const job = start(live, ascii(256)), samples = [];
  for (let round = 0; round < 15; round++) {
    const before = performance.now();
    for (let index = 0; index < 1000; index++) job.producer.append('0123456789abcde\n');
    const elapsed = performance.now() - before;
    if (round >= 5) samples.push(elapsed);
  }
  await job.finish();
  t.diagnostic(JSON.stringify({ scenario: 'single-eviction-append-1000', count: 256, samples }));
});
