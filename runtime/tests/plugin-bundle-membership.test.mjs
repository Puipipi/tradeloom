import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
const base = join(resolve(process.env.DSH_PREFIX), 'node_modules/@deepseek-ai');
const { boot } = await import(pathToFileURL(join(base, 'dsh-app-boot/lib/index.js')));
const { OFFICIAL_ON_DEMAND_CATALOG } = await import(pathToFileURL(join(base, 'dsh-official-bundles/lib/index.js')));

async function fixture(t, count) {
  const root = await mkdtemp(join(tmpdir(), 'bundle-membership-'));
  let ctx;
  t.after(async () => { await ctx?.fiber.dispose(); await rm(root, { recursive: true, force: true }); });
  const home = join(root, 'home'), dir = join(home, 'profiles/web');
  await mkdir(dir, { recursive: true });
  const manifestPath = join(dir, 'package.json'), main = join(dir, 'cordis.yml'), patchPath = join(dir, 'cordis.patch.yml');
  const manifest = { name: 'fixture-profile', dependencies: {}, dsh: { profile: { bundles: [] } } };
  await writeFile(manifestPath, JSON.stringify(manifest));
  await writeFile(main, '[]\n');
  const rows = [{ insert: [{ id: 'manager', name: pathToFileURL(join(base, 'dsh-plugin-manager/lib/index.js')).href }] }];
  await writeFile(patchPath, JSON.stringify(rows));
  const profile = { dir, home, installAnchor: join(base, 'dsh/package.json'), patchPath, overlays: [], startedBundles: [], telemetryDisabledEnv: '1' };
  ctx = await boot('dsh', main, rows, async c => { c.provide('profileContext', profile); });
  const names = Array.from({ length: count }, (_, i) => `membership-fixture-${i}`);
  for (const name of names) {
    const target = join(dir, 'node_modules', name);
    await mkdir(target, { recursive: true });
    await writeFile(join(target, 'package.json'), JSON.stringify({ name, version: '1.0.0', dsh: { bundle: { patch: 'cordis.patch.yml' } } }));
    await writeFile(join(target, 'cordis.patch.yml'), '[]\n');
    manifest.dependencies[name] = '1.0.0';
  }
  manifest.dsh.profile.bundles = [...names];
  const save = () => writeFile(manifestPath, JSON.stringify(manifest));
  await save();
  return { ctx, names, manifest, save, manifestPath };
}

async function counted(manager, count) {
  const includes = Array.prototype.includes;
  let calls = 0, comparisons = 0;
  Array.prototype.includes = function(value, ...rest) {
    if (this.length === count && count > 0 && this[0] === 'membership-fixture-0' && typeof value === 'string') {
      calls++;
      const at = this.indexOf(value);
      comparisons += at < 0 ? this.length : at + 1;
    }
    return includes.call(this, value, ...rest);
  };
  try { return { rows: await manager.listBundles(), calls, comparisons }; }
  finally { Array.prototype.includes = includes; }
}

for (const count of [0, 1, 200, 2000]) {
  test(`public listBundles membership scans for ${count} installed and selected bundles`, async t => {
    const f = await fixture(t, count);
    const observed = await counted(f.ctx.pluginManager, count);
    const rows = observed.rows.filter(row => row.name.startsWith('membership-fixture-'));
    assert.deepEqual(rows.map(row => row.name), f.names);
    assert.ok(rows.every(row => row.installed && row.enabled && row.version === '1.0.0' && row.error === undefined));
    t.diagnostic(JSON.stringify({ count, total: observed.rows.length, calls: observed.calls, comparisons: observed.comparisons }));
    const installation = JSON.parse(await readFile(join(base, 'dsh/package.json'), 'utf8'));
    const candidates = new Set([...f.names, ...Object.keys(installation.dependencies ?? {}), ...OFFICIAL_ON_DEMAND_CATALOG.map(row => row.packageName)]);
    assert.equal(observed.calls, count === 1 ? candidates.size : 0);
  });
}

test('disk edits, repeated selections and missing bundles retain ordering and diagnostics', async t => {
  const f = await fixture(t, 3);
  f.manifest.dsh.profile.bundles = [f.names[2], f.names[0], f.names[2], 'membership-missing'];
  await f.save();
  const first = await f.ctx.pluginManager.listBundles();
  assert.deepEqual(first.slice(0, 4).map(row => row.name), [f.names[2], f.names[0], 'membership-missing', f.names[1]]);
  assert.equal(first.find(row => row.name === f.names[1]).enabled, false);
  assert.ok(first.find(row => row.name === 'membership-missing').error);
  delete f.manifest.dependencies[f.names[0]];
  f.manifest.dsh.profile.bundles = [];
  await f.save();
  const second = await f.ctx.pluginManager.listBundles();
  assert.equal(second.some(row => row.name === f.names[0]), false);
  assert.ok(second.filter(row => f.names.includes(row.name)).every(row => row.installed && !row.enabled));
});

test('own JSON __proto__ dependency remains installed and malformed JSON still throws first', async t => {
  const f = await fixture(t, 0);
  f.manifest.dependencies = JSON.parse('{"__proto__":"1.0.0"}');
  await f.save();
  const result = await f.ctx.pluginManager.listBundles();
  assert.equal(result.find(row => row.name === '__proto__').installed, true);
  await writeFile(f.manifestPath, '{');
  assert.throws(() => f.ctx.pluginManager.listBundles(), SyntaxError);
});

test('unvalidated JSON field shapes retain enumerable membership and string selection behavior', async t => {
  const f = await fixture(t, 1);
  f.manifest.dsh.profile.bundles = `x${f.names[0]}y`;
  await f.save();
  assert.equal((await f.ctx.pluginManager.listBundles()).find(row => row.name === f.names[0]).enabled, true);
  f.manifest.dependencies = [];
  f.manifest.dsh.profile.bundles = ['length'];
  await f.save();
  const row = (await f.ctx.pluginManager.listBundles()).find(row => row.name === 'length');
  assert.equal(row.installed, false);
  assert.equal(row.enabled, true);
});

test('non-string selection does not coerce to a dependency key', async t => {
  const f = await fixture(t, 0);
  f.manifest.dependencies = { '1': '1.0.0' };
  f.manifest.dsh.profile.bundles = [1];
  await f.save();
  const rows = await f.ctx.pluginManager.listBundles();
  assert.equal(rows.find(row => row.name === 1).installed, false);
  assert.equal(rows.find(row => row.name === '1').installed, true);
});
