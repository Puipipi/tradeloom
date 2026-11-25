import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { installMedia, Config } from '../src/index.js';

// Actual rc.1 service lifecycle; no GC timing, HTTP supplier or Android action.
const load = name => import(pathToFileURL(join(resolve(process.env.DSH_PREFIX), 'node_modules/@deepseek-ai', name, 'lib/index.js')));
const enabled = Boolean(process.env.DSH_PREFIX);
const value = { meta: { rid: 'synthetic-lifecycle-result', status: 'done' }, text: 'synthetic completed video' };
async function fixture(t, generate = async () => value) {
  const { Context } = await load('cordis');
  const { Session } = await load('dsh-session');
  const ctx = new Context();
  const home = await mkdtemp(join(tmpdir(), 'media-owner-lifecycle-'));
  t.after(async () => { await ctx.fiber.dispose(); await rm(home, { recursive: true, force: true }); });
  for (const [pkg, name] of [
    ['dsh-session-projection', 'SessionProjectionRegistry'], ['dsh-agent', 'AgentRegistry'],
    ['dsh-jobs-local', 'LocalJobRegistry'], ['dsh-system-prompt', 'SystemPrompt'], ['dsh-tools', 'ToolsService'],
  ]) await ctx.plugin((await load(pkg))[name]);
  ctx.jobs.attachController();
  ctx.provide('credentials', { describe: async () => ({ configured: true }) });
  let cache;
  const nativeSet = Map.prototype.set;
  // Observe the precise result map without substituting any Map behavior.
  t.mock.method(Map.prototype, 'set', function (key, entry) {
    if (entry?.session?.id?.startsWith('media-lifecycle-') && entry?.value?.meta) {
      if (cache) assert.equal(this, cache);
      cache = this;
    }
    return nativeSet.call(this, key, entry);
  });
  let mediaCtx;
  const provider = ctx.plugin({ name: 'synthetic-media-owner', inject: ['jobs', 'tools', 'credentials', 'systemPrompt'], apply(c) { mediaCtx = c; } });
  await provider.await();
  const installed = installMedia(mediaCtx, Config({ dshHome: home, services: [{
    id: 'video', enabled: true, keyRef: 'DSH_MEDIA_SLOT_1_API_KEY', provider: 'ark', profile: 'ark-video',
    baseUrl: 'https://ark.cn-beijing.volces.com', models: 'doubao-seedance-2-5-260628',
  }] }), { generate });
  await installed.ready;
  const tools = new Map(ctx.tools.definitions().map(tool => [tool.name, tool]));
  async function owner(suffix) {
    let ownerCtx;
    const fiber = ctx.plugin({ name: `synthetic-agent-${suffix}`, apply(c) { ownerCtx = c; } });
    await fiber.await();
    const session = Session.create(`media-lifecycle-${suffix}`);
    const agent = { id: session.id, session, ctx: ownerCtx };
    const detach = ctx.agents.enter(agent, undefined);
    ownerCtx.effect(() => detach);
    const exec = { agent, callId: `synthetic-call-${suffix}`, signal: new AbortController().signal };
    await tools.get('generate_video').execute({ prompt: 'synthetic video' }, exec);
    const job = ctx.jobs.list(session.id)[0];
    assert.ok(job);
    return { fiber, session, job, exec };
  }
  const read = owner => tools.get('get_media_result').execute({ job_id: owner.job.id }, owner.exec);
  const wait = owner => ctx.jobs.wait(owner.job.id, 1000, owner.session.id); // Immediate completion / watchdog only.
  return { ctx, provider, owner, read, wait, cache: () => cache, tools };
}

test('completed owner removal frees its media entry while another owner remains readable', { skip: !enabled }, async t => {
  const f = await fixture(t);
  const a = await f.owner('a'), b = await f.owner('b');
  await Promise.all([f.wait(a), f.wait(b)]);
  assert.deepEqual(await f.read(a), value);
  assert.equal(f.cache().size, 2);
  await a.fiber.dispose();
  assert.equal(f.ctx.jobs.list(a.session.id).length, 0);
  await assert.rejects(() => f.read(a));
  assert.equal(f.cache().has(a.job.id), false);
  assert.deepEqual(await f.read(b), value);
  assert.equal(f.cache().get(b.job.id).session, b.session);
  await b.fiber.dispose();
  assert.equal(f.cache().size, 0);
});

test('owner cancellation waits for producer before removed clears a late failed result', { skip: !enabled }, async t => {
  const cancelled = Promise.withResolvers(), release = Promise.withResolvers();
  t.after(() => release.resolve());
  const f = await fixture(t, async (_request, { signal }) => {
    await new Promise(resolve => { signal.addEventListener('abort', resolve, { once: true }); });
    cancelled.resolve();
    await release.promise;
    signal.throwIfAborted();
  });
  const a = await f.owner('cancelled');
  let finished = false;
  const disposing = a.fiber.dispose().then(() => { finished = true; });
  await cancelled.promise;
  assert.equal(finished, false);
  assert.equal(f.cache().has(a.job.id), true);
  release.resolve();
  await disposing;
  assert.equal(f.ctx.jobs.list(a.session.id).length, 0);
  await assert.rejects(() => f.read(a));
  assert.equal(f.cache().size, 0);
});

test('provider disposal drains a late producer and clears its cache even while jobs retain terminal records', { skip: !enabled }, async t => {
  const cancelled = Promise.withResolvers(), release = Promise.withResolvers();
  t.after(() => release.resolve());
  const f = await fixture(t, async (_request, { signal }) => {
    await new Promise(resolve => { signal.addEventListener('abort', resolve, { once: true }); });
    cancelled.resolve();
    await release.promise;
    signal.throwIfAborted();
  });
  const a = await f.owner('provider');
  let finished = false;
  const disposing = f.provider.dispose().then(() => { finished = true; });
  await cancelled.promise;
  assert.equal(finished, false);
  release.resolve();
  await disposing;
  await f.wait(a);
  assert.equal(f.ctx.jobs.list(a.session.id).length, 1);
  assert.equal(f.cache().size, 0);
  assert.equal(f.ctx.tools.definitions().some(tool => tool.name === 'generate_video'), false);
  await a.fiber.dispose();
  assert.equal(f.cache().size, 0);
});

test('normal job kill keeps the failure card until explicit terminal removal', { skip: !enabled }, async t => {
  const f = await fixture(t, async (_request, { signal }) => {
    await new Promise(resolve => { signal.addEventListener('abort', resolve, { once: true }); });
    signal.throwIfAborted();
  });
  const a = await f.owner('kill');
  f.ctx.jobs.kill(a.job.id, a.session.id, 'ordinary synthetic user cancellation');
  await f.wait(a);
  assert.equal(f.ctx.jobs.get(a.job.id, a.session.id).status, 'killed');
  assert.equal((await f.read(a)).meta.status, 'failed');
  assert.equal(f.cache().has(a.job.id), true);
  f.ctx.jobs.remove(a.job.id, a.session.id);
  assert.equal(f.cache().size, 0);
  await assert.rejects(() => f.read(a));
});
