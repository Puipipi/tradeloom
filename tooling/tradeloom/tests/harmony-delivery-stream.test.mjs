// Execute the actual script from the Dart ArkWeb caller with an in-memory response.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { setImmediate } from 'node:timers/promises';
import vm from 'node:vm';
import test from 'node:test';

const dart = readFileSync(new URL('../../../app/lib/ui/tradeloom/harmony_tradeloom_download.dart', import.meta.url), 'utf8');
const source = dart.match(/const _start = r'''([\s\S]+?)''';/)[1];
const origin = 'https://portal.example';
const path = '/enterprise/deliveries/' + 'a'.repeat(32) + '/' + 'b'.repeat(32) + '/download';
const url = origin + path;
const bytes = new Uint8Array(70 * 1024);
for (let i = 0; i < bytes.length; i++) bytes[i] = i % 256;

function harness({ page = '/enterprise/', fetcher } = {}) {
  const window = {};
  const requests = [];
  let reads = 0;
  const fetch = async (...args) => {
    requests.push(args);
    if (fetcher) return fetcher();
    return {
      status: 200, url,
      headers: new Headers({
        'content-type': 'application/json', 'content-length': String(bytes.length),
        'content-disposition': 'attachment; filename="quality_report.json"',
      }),
      body: { getReader: () => ({ read: async () => (++reads === 1 ? { value: bytes } : { done: true }) }) },
    };
  };
  const start = vm.runInNewContext(source, { window, location: { origin, pathname: page }, fetch, AbortController, btoa });
  return { window, requests, reads: () => reads, start: () => start('job', origin, path, 32 * 1024, 64 * 1024 * 1024) };
}

async function pull(job) {
  for (let i = 0; i < 6; i++) {
    const reply = job.next();
    if (reply.kind !== 'pending') return reply;
    await setImmediate();
  }
  assert.fail('read did not finish');
}

test('authenticated GET is pulled serially in bounded messages', async () => {
  const h = harness();
  assert.equal(h.start(), true);
  const job = h.window.job;
  const header = await pull(job);
  assert.equal(header.kind, 'header');
  assert.equal(Number(header.length), bytes.length);
  assert.equal(h.reads(), 0);
  const [target, options] = h.requests[0];
  assert.equal(h.requests.length, 1);
  assert.equal(target, url);
  assert.equal(options.credentials, 'same-origin');
  assert.equal(options.redirect, 'error');
  assert.equal(options.headers, undefined);
  const chunks = [];
  for (let i = 0; i < 3; i++) {
    const reply = await pull(job);
    assert.equal(reply.kind, 'chunk');
    const chunk = Buffer.from(reply.bytes, 'base64');
    assert.ok(chunk.length <= 32 * 1024);
    chunks.push(chunk);
    assert.equal(h.reads(), 1);
  }
  assert.equal((await pull(job)).kind, 'end');
  assert.deepEqual(Buffer.concat(chunks), Buffer.from(bytes));
  job.cancel();
  assert.equal(options.signal.aborted, true);
});

test('outside the enterprise document there is no network or download state', () => {
  const h = harness({ page: '/accounts/login/' });
  assert.equal(h.start(), false);
  assert.equal(h.window.job, undefined);
  assert.equal(h.requests.length, 0);
});

test('redirect and cancelled navigation abort the browser transfer', async () => {
  const rejected = harness({ fetcher: () => Promise.reject(new Error('blocked redirect')) });
  assert.equal(rejected.start(), true);
  assert.equal((await pull(rejected.window.job)).kind, 'error');
  assert.equal(rejected.requests[0][1].signal.aborted, true);
  const pending = harness({ fetcher: () => new Promise(() => {}) });
  assert.equal(pending.start(), true);
  pending.window.job.cancel();
  assert.equal(pending.requests[0][1].signal.aborted, true);
});
