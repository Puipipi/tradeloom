import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
const prefix = resolve(process.env.DSH_PREFIX);
const base = join(prefix, 'node_modules/@deepseek-ai');
const load = name => import(pathToFileURL(join(base, name, 'lib/index.js')));
const { z } = createRequire(join(prefix, 'package.json'))('zod');
const { Context } = await load('cordis');
const { Storage } = await load('dsh-storage');
const json = await load('dsh-storage-json');
const domain = await load('dsh-storage-domain');
const spec = domain.defineDomain({ name: 'owner_test', version: 1, tables: {} });

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'domain-owner-'));
  const ctx = new Context();
  t.after(async () => { await ctx.fiber.dispose(); await rm(root, { recursive: true, force: true }); });
  await ctx.plugin(Storage).await();
  await ctx.plugin(json, { root }).await();
  const plugin = ctx.plugin(domain, { backend: 'json' });
  await plugin.await();
  return { ctx, plugin, facility: ctx.storageDomain, backend: ctx.storage.backend.get('json') };
}

function gateUnit(t, backend, stage, error) {
  let entered, release, closes = 0;
  const started = new Promise(resolve => { entered = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const pause = async () => { entered(); await gate; if (error) throw error; };
  const open = backend.kv.open;
  t.mock.method(backend.kv, 'open', async descriptor => {
    const unit = await open(descriptor);
    const close = unit.close.bind(unit);
    t.mock.method(unit, 'close', async () => { closes++; return close(); });
    if (stage === 'open') await pause();
    else {
      const method = unit[stage].bind(unit);
      t.mock.method(unit, stage, async (...args) => { const value = await method(...args); await pause(); return value; });
    }
    return unit;
  });
  return { started, release, closes: () => closes };
}

for (const stage of ['open', 'loadAll', 'backupRecord']) {
  test(`disposed facility releases a real JSON unit returned after ${stage}`, async t => {
    const { ctx, plugin, facility, backend } = await fixture(t);
    let current = spec;
    if (stage === 'backupRecord') {
      current = domain.defineDomain({ name: 'owner_test', version: 1, layout: 'per-record', invalidRecords: 'backup-and-skip',
        tables: { rows: { valueSchema: z.object({ n: z.number() }) } } });
      const seed = await backend.kv.open(domain.descriptorOf(current));
      await seed.putRecord('rows', 'bad', { n: 'invalid-fixture' });
      await seed.close();
    }
    const unrelated = await backend.kv.open({ name: 'unrelated', version: 1, tables: [], hasGlobal: false });
    const gate = gateUnit(t, backend, stage);
    const outcome = facility.open(current).then(value => ({ value }), error => ({ error }));
    await gate.started;
    await plugin.dispose();
    assert.equal(facility.ctx.fiber.uid, null, 'explicit dispose completed');
    assert.equal(backend.closed, false, 'shared backend is still mounted');
    gate.release();
    const result = await outcome;
    const lateCloses = gate.closes();
    t.diagnostic(`stage=${stage} close=${lateCloses} retired-domains=${facility.domains.size} retained-unit=${backend.open.has(current.name)}`);
    // Keep the baseline failure finite and release only its returned handle.
    if (result.value) t.after(() => result.value.close());
    assert.equal(lateCloses, 1);
    assert.equal(facility.domains.size, 0);
    assert.equal(facility.reserved.size, 0);
    assert.equal(backend.open.has(current.name), false);
    assert.equal(backend.open.get('unrelated'), unrelated);
    assert.equal(result.error?.code, 'INACTIVE_EFFECT');
    const replacement = ctx.plugin(domain, { backend: 'json' });
    await replacement.await();
    const reopened = await ctx.storageDomain.open(current);
    await reopened.close();
    assert.equal(backend.open.has(current.name), false);
  });
}

test('explicit closeAll on an active facility still permits reopening', async t => {
  const { facility, backend } = await fixture(t);
  await facility.open(spec);
  await facility.closeAll();
  assert.equal(backend.open.size, 0);
  const next = await facility.open(spec);
  assert.equal(facility.get(spec.name), next);
  await next.close();
  assert.equal(facility.reserved.size, 0);
});

test('loadAll I/O failure after disposal closes its unit and retains the original error', async t => {
  const { plugin, facility, backend } = await fixture(t);
  const error = Object.assign(new Error('SYNTHETIC_LOAD_EIO'), { code: 'EIO' });
  const gate = gateUnit(t, backend, 'loadAll', error);
  const rejected = assert.rejects(facility.open(spec), actual => actual === error);
  await gate.started; await plugin.dispose(); gate.release(); await rejected;
  assert.equal(gate.closes(), 1);
  assert.equal(backend.open.size, 0);
  assert.equal(facility.reserved.size, 0);
});
