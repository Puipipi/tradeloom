import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const prefix = resolve(process.env.DSH_PREFIX), base = join(prefix, 'node_modules/@deepseek-ai');
const { boot, PluginPackages } = await import(pathToFileURL(join(base, 'dsh-app-boot/lib/index.js')));
const manager = process.env.DSH_MANAGER_MODULE ?? join(base, 'dsh-plugin-manager/lib/index.js');

async function fixture(t, count = 2, secondBase = false) {
  const root = await mkdtemp(join(tmpdir(), 'metadata-inventory-'));
  let ctx;
  t.after(async () => {
    await ctx?.fiber.dispose();
    await rm(root, { recursive: true, force: true });
  });
  const home = join(root, 'home'), dir = join(home, 'profiles/web'), pkg = join(dir, 'node_modules/synthetic-meta-bundle');
  await mkdir(join(pkg, 'locale'), { recursive: true });
  await writeFile(join(pkg, 'package.json'), JSON.stringify({
    name: 'synthetic-meta-bundle',
    version: '1.0.0',
    type: 'module',
    exports: { '.': './index.mjs', './package.json': './package.json', './locale/*': './locale/*' },
    dsh: { bundle: { patch: './cordis.patch.yml' } },
  }));
  await writeFile(join(pkg, 'index.mjs'), 'export function apply(){}');
  const locale = join(pkg, 'locale/en.json');
  await writeFile(locale, JSON.stringify({ meta: { title: 'First' } }));
  const entries = Array.from({ length: count }, (_, i) => ({
    id: 'meta-' + i, name: 'synthetic-meta-bundle', disabled: true,
  }));
  await writeFile(join(pkg, 'cordis.patch.yml'), JSON.stringify([{ insert: entries }]));
  const dependencies = { 'synthetic-meta-bundle': 'file:' + pkg }, bundles = ['synthetic-meta-bundle'];
  if (secondBase) {
    const other = join(dir, 'node_modules/synthetic-second-bundle');
    await mkdir(other);
    await writeFile(join(other, 'package.json'), JSON.stringify({
      name: 'synthetic-second-bundle', version: '1.0.0', dsh: { bundle: { patch: './cordis.patch.yml' } },
    }));
    await writeFile(join(other, 'cordis.patch.yml'), JSON.stringify([
      { insert: entries.map(e => ({ ...e, id: 'second-' + e.id })) },
    ]));
    dependencies['synthetic-second-bundle'] = 'file:' + other;
    bundles.push('synthetic-second-bundle');
  }
  await writeFile(join(dir, 'package.json'), JSON.stringify({
    name: 'fixture-profile', dependencies, dsh: { profile: { bundles } },
  }));
  const main = join(dir, 'cordis.yml'), patchPath = join(dir, 'cordis.patch.yml');
  await writeFile(main, '[]');
  const rows = [{ insert: [
    { id: 'manager', name: pathToFileURL(manager).href },
    ...(secondBase ? [] : entries),
  ] }];
  await writeFile(patchPath, JSON.stringify(rows));
  ctx = await boot('dsh', main, rows, async c => {
    await c.plugin(PluginPackages);
    c.provide('profileContext', {
      dir, home, installAnchor: join(base, 'dsh/package.json'), patchPath,
      overlays: [], startedBundles: [], telemetryDisabledEnv: '1',
    });
  });
  return { ctx, locale, entries, pkg };
}

function observe(ctx, transform) {
  const service = ctx.pluginPackages, original = service.metaOf;
  let calls = 0;
  service.metaOf = function(name, base) {
    const value = original.call(this, name, base);
    if (name === 'synthetic-meta-bundle') {
      calls++;
      return transform ? transform(value, calls) : value;
    }
    return value;
  };
  return { count: () => calls, restore: () => { service.metaOf = original; } };
}

async function own(ctx) {
  const result = await ctx.pluginManager.listBundles();
  const bundle = result.find(x => x.name === 'synthetic-meta-bundle');
  assert(bundle);
  assert.equal(bundle.error, undefined);
  return bundle;
}

test('repeated successful row metadata is read once, and the next inventory reads changed locale', async t => {
  const { ctx, locale } = await fixture(t);
  const spy = observe(ctx);
  t.after(spy.restore);
  const first = await own(ctx);
  assert.equal(first.rows.length, 2);
  assert(first.rows.every(r => r.meta.title.en === 'First'));
  assert.equal(spy.count(), 1);
  await writeFile(locale, JSON.stringify({ meta: { title: 'Second' } }));
  const second = await own(ctx);
  assert(second.rows.every(r => r.meta.title.en === 'Second'));
  assert.equal(spy.count(), 2);
  assert.deepEqual(
    first.rows.map(r => ({ rowId: r.rowId, moduleName: r.moduleName, entryId: r.entryId })),
    second.rows.map(r => ({ rowId: r.rowId, moduleName: r.moduleName, entryId: r.entryId })),
  );
});

test('a one-row inventory preserves its metadata and performs one read', async t => {
  const { ctx } = await fixture(t, 1);
  const spy = observe(ctx);
  t.after(spy.restore);
  const b = await own(ctx);
  assert.equal(b.rows.length, 1);
  assert.equal(b.rows[0].meta.title.en, 'First');
  assert.equal(spy.count(), 1);
});

test('malformed locale errors are not memoized and a later request sees repair', async t => {
  const { ctx, locale } = await fixture(t);
  await writeFile(locale, '{');
  const spy = observe(ctx);
  t.after(spy.restore);
  const first = await own(ctx);
  assert(first.rows.every(r => typeof r.meta.error === 'string'));
  assert.equal(spy.count(), 2);
  await writeFile(locale, JSON.stringify({ meta: { title: 'Repaired' } }));
  const second = await own(ctx);
  assert(second.rows.every(r => r.meta.title.en === 'Repaired'));
  assert.equal(spy.count(), 3);
});

test('undefined metadata is retried for the next row, and direct declaredRows retains uncached reads', async t => {
  const { ctx } = await fixture(t);
  const spy = observe(ctx, (value, n) => n === 1 ? undefined : value);
  t.after(spy.restore);
  const first = await own(ctx);
  assert.equal(first.rows[0].meta, undefined);
  assert.equal(first.rows[1].meta.title.en, 'First');
  assert.equal(spy.count(), 2);
  const direct = ctx.pluginManager.declaredRows('synthetic-meta-bundle', {
    dsh: { bundle: { patch: './cordis.patch.yml' } },
  });
  assert(direct.rows.every(r => r.meta.title.en === 'First'));
  assert.equal(spy.count(), 4);
});

test('same module under two real bundle bases has independent metadata reads', async t => {
  const { ctx } = await fixture(t, 2, true);
  const spy = observe(ctx);
  t.after(spy.restore);
  const all = await ctx.pluginManager.listBundles();
  for (const name of ['synthetic-meta-bundle', 'synthetic-second-bundle']) {
    const b = all.find(x => x.name === name);
    assert.equal(b.error, undefined);
    assert.equal(b.rows.length, 2);
    assert(b.rows.every(r => r.meta.title.en === 'First'));
  }
  assert.equal(spy.count(), 2);
});

test('metadata retaining display text after an icon failure is not memoized', async t => {
  const { ctx, pkg } = await fixture(t);
  const manifestPath = join(pkg, 'package.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  manifest.icon = '../outside.svg';
  await writeFile(manifestPath, JSON.stringify(manifest));
  const spy = observe(ctx);
  t.after(spy.restore);
  const b = await own(ctx);
  assert(b.rows.every(r => r.meta.title.en === 'First' && typeof r.meta.error === 'string'));
  assert.equal(spy.count(), 2);
});
