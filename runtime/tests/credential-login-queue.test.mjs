// Synthetic built-in API-key login; actual Cordis/authorization/local store, no network.
// DSH_PREFIX=<isolated actual prefix> node --test credential-login-queue.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
if (!process.env.DSH_PREFIX) throw Error('Set DSH_PREFIX to an isolated actual prefix');
const prefix = resolve(process.env.DSH_PREFIX);
const load = name => import(pathToFileURL(join(prefix, 'node_modules/@deepseek-ai', name, 'lib/index.js')));
const { Context } = await load('cordis');
const { LocalCredentialProvider, parseCredentialsDocument } = await load('dsh-credentials-local');
const { AuthorizationService } = await load('dsh-authorization');
const { LlmRuntime } = await load('dsh-llm');
const pi = await load('dsh-llm-pi-ai');
const gate = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };

for (const cancel of [false, true]) test(`builtin API-key login ${cancel ? 'cancelled while queued never writes later' : 'queued normally commits'}`, async t => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-2117-login-'));
  const path = join(root, 'synthetic.yaml');
  const ctx = new Context();
  const entered = gate(), release = gate(), queued = gate();
  t.after(async () => { release.resolve(); t.mock.restoreAll(); await ctx.fiber.dispose(); await rm(root, { recursive: true, force: true }); });
  await ctx.plugin(LocalCredentialProvider, { path, watch: false }).await();
  await ctx.plugin(AuthorizationService).await();
  await ctx.plugin(LlmRuntime).await();
  await ctx.plugin(pi, { providers: {} }).await();
  const provider = ctx.credentials;
  const key = pi.recordKeyFor('deepseek');
  assert.ok(ctx.authorization.describe(key)?.methods.some(m => m.id === 'api-key'), 'real built-in flow registered');
  await provider.modifyRecord(key, async () => ({ kind: 'api-key', key: 'synthetic-old' }));
  let updated = 0;
  const unwatch = ctx.on('credentials/record-updated', observed => { if (observed === key) updated++; });
  t.after(unwatch);
  // An admitted actual mutation holds the real document lock and the provider queue.
  const holding = provider.modifyRecord('synthetic/hold', async () => { entered.resolve(); await release.promise; return undefined; });
  await Promise.race([entered.promise, holding.then(() => { throw Error('hold ended before entering mutation'); })]);
  const enqueue = provider.enqueue;
  // Observation only: delegate unchanged to the actual queue before exposing the barrier.
  t.mock.method(provider, 'enqueue', function(work) { const result = enqueue.call(this, work); queued.resolve(); return result; });
  let prompts = 0;
  const running = ctx.authorization.begin({ key, method: 'api-key', interaction: {
    notify() {},
    async prompt(request) { prompts++; assert.equal(request.kind, 'secret'); return 'synthetic-new'; },
  } });
  const outcome = running.then(value => ({ value }), error => ({ error }));
  await Promise.race([queued.promise, outcome.then(result => { throw result.error ?? Error('login settled before its store mutation queued'); })]);
  assert.equal(prompts, 1, 'real built-in prompt completed before the blocked store submission');
  assert.equal(updated, 0);
  if (cancel) {
    ctx.authorization.cancel(key);
    const result = await outcome;
    assert.equal(result.error, undefined);
    assert.deepEqual(result.value, { status: 'cancelled' });
  }
  t.mock.restoreAll();
  release.resolve();
  await holding;
  // Real later mutation is a complete queue/lock drain barrier, not a time delay.
  await provider.modifyRecord('synthetic/drain', async () => undefined);
  const result = await outcome;
  assert.equal(result.error, undefined);
  assert.equal(result.value.status, cancel ? 'cancelled' : 'authorized');
  const disk = parseCredentialsDocument(await readFile(path, 'utf8'), path);
  assert.equal(disk.records.get(key)?.key, cancel ? 'synthetic-old' : 'synthetic-new');
  assert.equal((await provider.readRecord(key))?.key, cancel ? 'synthetic-old' : 'synthetic-new');
  assert.equal(updated, cancel ? 0 : 1, 'no late update after the cancelled attempt settled and queue drained');
});
