import assert from 'node:assert/strict';
import http from 'node:http';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';

const prefix = resolve(process.env.DSH_PREFIX);
const { fetchBody, DetailFailure } = await import(pathToFileURL(join(
  prefix, 'node_modules/@deepseek-ai/dsh-plugin-detail/lib/index.js',
)));

// Observe the real Response's public iterator entry. The original fetch,
// Response, iterator and chunks are retained; no extra read advances the body.
async function fixture(t, { complete = false, maxBytes = 1024 } = {}) {
  const entered = Promise.withResolvers();
  const disconnected = Promise.withResolvers();
  const nativeFetch = globalThis.fetch;
  const originalTimeout = AbortSignal.timeout;
  const timeout = new AbortController();
  const caller = new AbortController();
  const lifetime = new AbortController();
  let response;
  let pending;
  let observations = 0;
  let timeoutCalls = 0;
  const server = http.createServer((_request, res) => {
    response = res;
    res.on('close', () => disconnected.resolve());
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.write('partial');
    if (complete) res.end(' complete');
  });
  t.after(async () => {
    caller.abort(new Error('fixture cleanup'));
    if (pending) await pending;
    globalThis.fetch = nativeFetch;
    AbortSignal.timeout = originalTimeout;
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  // Only the helper's deadline is controlled. No wall-clock wait, and no
  // replacement authorization, request, Response or business result.
  AbortSignal.timeout = milliseconds => {
    assert.equal(milliseconds, 30000);
    timeoutCalls++;
    return timeout.signal;
  };
  globalThis.fetch = async (...args) => {
    const result = await nativeFetch(...args);
    assert.ok(result.body);
    const originalIterator = result.body[Symbol.asyncIterator];
    result.body[Symbol.asyncIterator] = function (...iteratorArgs) {
      const iterator = Reflect.apply(originalIterator, this, iteratorArgs);
      observations++;
      entered.resolve();
      return iterator;
    };
    return result;
  };
  pending = fetchBody(`http://127.0.0.1:${server.address().port}/detail`, maxBytes,
    caller.signal, { lifetime: lifetime.signal, timeoutMs: 30000 })
    .then(value => ({ value }), error => ({ error }));
  await entered.promise;
  assert.equal(observations, 1);
  assert.equal(timeoutCalls, 1);
  return {
    caller, lifetime, timeout, pending,
    disconnected: disconnected.promise,
    disconnect: () => response.destroy(),
  };
}

for (const owner of ['caller', 'lifetime']) {
  test(`body cancellation preserves the ${owner}'s exact reason`, async t => {
    const f = await fixture(t);
    const reason = new Error(`own ${owner} cancellation`);
    f[owner].abort(reason);
    const { error } = await f.pending;
    await f.disconnected;
    assert.strictEqual(error, reason);
  });
}

test('a genuine body disconnect remains a network failure', async t => {
  const f = await fixture(t);
  f.disconnect();
  const { error } = await f.pending;
  await f.disconnected;
  assert.ok(error instanceof DetailFailure);
  assert.equal(error.reason, 'network');
  assert.ok(error.cause instanceof Error);
  assert.equal(f.caller.signal.aborted, false);
  assert.equal(f.lifetime.signal.aborted, false);
});

test('a controlled deadline during body reading remains a network failure', async t => {
  const f = await fixture(t);
  f.timeout.abort(new DOMException('fixture deadline', 'TimeoutError'));
  const { error } = await f.pending;
  await f.disconnected;
  assert.ok(error instanceof DetailFailure);
  assert.equal(error.reason, 'network');
  assert.equal(f.caller.signal.aborted, false);
  assert.equal(f.lifetime.signal.aborted, false);
});

test('a completed body retains its exact bytes', async t => {
  const f = await fixture(t, { complete: true });
  const { value, error } = await f.pending;
  assert.equal(error, undefined);
  assert.equal(value.ok, true);
  assert.deepEqual(value.bytes, Buffer.from('partial complete'));
});

test('a real over-limit body retains too-large and closes its response', async t => {
  const f = await fixture(t, { maxBytes: 3 });
  const { error } = await f.pending;
  await f.disconnected;
  assert.ok(error instanceof DetailFailure);
  assert.equal(error.reason, 'too-large');
  assert.equal(f.caller.signal.aborted, false);
  assert.equal(f.lifetime.signal.aborted, false);
});
