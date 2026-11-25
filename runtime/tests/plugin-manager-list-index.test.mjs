import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
const base = join(resolve(process.env.DSH_PREFIX), 'node_modules/@deepseek-ai');
const { boot } = await import(pathToFileURL(join(base, 'dsh-app-boot/lib/index.js')));

async function fixture(t, count) {
  const root = await mkdtemp(join(tmpdir(), 'plugin-list-index-'));
  let ctx;
  t.after(async () => { await ctx?.fiber.dispose(); await rm(root, { recursive: true, force: true }); });
  const home = join(root, 'home'), dir = join(home, 'profiles/web');
  await mkdir(dir, { recursive: true });
  const patchPath = join(dir, 'cordis.patch.yml'), main = join(dir, 'cordis.yml'), module = pathToFileURL(join(dir, 'plugin.mjs')).href;
  await writeFile(join(dir, 'package.json'), JSON.stringify({ name: 'fixture-profile', dependencies: {}, dsh: { profile: { bundles: [] } } }));
  await writeFile(main, '[]\n');
  await writeFile(new URL(module), 'export function apply() {}\n');
  const rows = [{ insert: [
    { id: 'manager', name: pathToFileURL(join(base, 'dsh-plugin-manager/lib/index.js')).href },
    ...Array.from({ length: count }, (_, i) => ({ id: `p${i}`, name: module, disabled: true })),
  ] }];
  await writeFile(patchPath, JSON.stringify(rows));
  const profile = { dir, home, installAnchor: join(base, 'dsh/package.json'), patchPath, overlays: [], startedBundles: [], telemetryDisabledEnv: '1' };
  ctx = await boot('dsh', main, rows, async c => { c.provide('profileContext', profile); });
  assert.ok(ctx.pluginManager);
  return { ctx, rows, patchPath, module };
}

for (const count of [1, 200, 2000]) {
  test(`listPlugins enumerates the live Loader twice for ${count} profile rows`, async t => {
    const { ctx } = await fixture(t, count);
    const original = ctx.loader.entries;
    let calls = 0, yielded = 0;
    ctx.loader.entries = function* (...args) {
      calls++;
      for (const entry of original.apply(this, args)) { yielded++; yield entry; }
    };
    let result;
    try { result = await ctx.pluginManager.listPlugins(); }
    finally { ctx.loader.entries = original; }
    const plugins = result.filter(row => row.patchId?.startsWith('p'));
    assert.equal(plugins.length, count);
    assert.deepEqual(plugins.map(row => row.patchId), Array.from({ length: count }, (_, i) => `p${i}`));
    assert.ok(plugins.every(row => row.enabled === false && row.fiberPhase === null));
    assert.equal(result.find(row => row.entryId.endsWith('manager')).readOnlyReason, 'management-required');
    t.diagnostic(`profile-rows=${count} output=${result.length} loader-calls=${calls} yielded=${yielded}`);
    assert.equal(calls, 2, 'inventory and current-addressability each read the Loader once');
  });
}

test('profile edits are visible on the next call without weakening name or ownership checks', async t => {
  const { ctx, rows, patchPath, module } = await fixture(t, 2);
  const before = await ctx.pluginManager.listPlugins();
  assert.deepEqual(before.filter(row => row.patchId).map(row => row.patchId), ['p0', 'p1']);
  rows[0].insert[1].name = `${module}.changed`;
  await writeFile(patchPath, JSON.stringify(rows));
  const changed = await ctx.pluginManager.listPlugins();
  const p0id = before.find(row => row.patchId === 'p0').entryId;
  assert.equal(changed.find(row => row.entryId === p0id).readOnlyReason, 'unaddressable');
  assert.equal(changed.find(row => row.patchId === 'p1').enabled, false);
  rows[0].insert[1].name = module;
  await writeFile(patchPath, JSON.stringify(rows));
  assert.equal((await ctx.pluginManager.listPlugins()).find(row => row.entryId === p0id).patchId, 'p0');
});

test('duplicate profile ids remain unaddressable without hiding other rows', async t => {
  const { ctx, rows, patchPath, module } = await fixture(t, 2);
  rows[0].insert.push({ id: 'group', name: 'cordis:group', group: true, config: [{ id: 'p0', name: module, disabled: true }] });
  await writeFile(patchPath, JSON.stringify(rows));
  const result = await ctx.pluginManager.listPlugins();
  assert.equal(result.find(row => row.entryId === 'include:p0').readOnlyReason, 'unaddressable');
  assert.equal(result.find(row => row.entryId === 'include:p1').patchId, 'p1');
});

test('live addressability is read after the real inventory preset await', async t => {
  const { ctx } = await fixture(t, 2);
  let entered, release;
  const started = new Promise(resolve => { entered = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  ctx.provide('agentPresets', { async compositionInventory() { entered(); await gate; return []; } });
  const listing = ctx.pluginManager.listPlugins();
  await started;
  const entry = ctx.loader.resolve('include:p0');
  entry.parent.tree.remove('p0');
  release();
  const result = await listing;
  assert.equal(result.find(row => row.entryId === 'include:p0').readOnlyReason, 'unaddressable');
  assert.equal(result.find(row => row.entryId === 'include:p1').patchId, 'p1');
  assert.equal((await ctx.pluginManager.listPlugins()).some(row => row.entryId === 'include:p0'), false);
});
