import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const base = join(resolve(process.env.DSH_PREFIX), 'node_modules/@deepseek-ai');
const { boot } = await import(pathToFileURL(join(base, 'dsh-app-boot/lib/index.js')));

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'loader-remove-'));
  let ctx;
  t.after(async () => { await ctx?.fiber.dispose(); await rm(root, { recursive: true, force: true }); });
  const main = join(root, 'main.json'), nested = join(root, 'nested.json'), sibling = join(root, 'sibling.json');
  const module = pathToFileURL(join(root, 'plugin.mjs')).href;
  await writeFile(new URL(module), `export function apply(ctx, config) {
    ctx.fixtureState.live.add(config.label);
    ctx.effect(() => () => { ctx.fixtureState.live.delete(config.label); ctx.fixtureState.closed.push(config.label); });
  }\n`);
  const row = (id, label = id) => ({ id, name: module, config: { label } });
  await writeFile(sibling, JSON.stringify([row('same', 'sibling')]));
  await writeFile(nested, JSON.stringify([row('same', 'nested'), row('keep', 'nested-keep')]));
  await writeFile(main, JSON.stringify([
    row('same', 'outer'),
    { id: 'sibling', name: pathToFileURL(join(base, 'cordis-plugin-include/lib/index.js')).href, config: { path: pathToFileURL(sibling).href } },
    { id: 'nested', name: pathToFileURL(join(base, 'cordis-plugin-include/lib/index.js')).href, config: { path: pathToFileURL(nested).href } },
    { id: 'group', name: 'cordis:group', group: true, config: [row('group-child')] },
  ]));
  const state = { live: new Set(), closed: [] };
  ctx = await boot('dsh', main, [], c => c.provide('fixtureState', state));
  await ctx.loader.create(row('same', 'root'));
  await ctx.loader.await();
  assert.equal(state.live.size, 6);
  return { ctx, state, main, nested, sibling, row };
}

for (const [id, label, fileKey] of [
  ['include:same', 'outer', 'main'],
  ['include:nested:same', 'nested', 'nested'],
  ['include:group-child', 'group-child', 'main'],
]) {
  test(`remove(${id}) stops only the resolved owner and persists its parent`, async t => {
    const f = await fixture(t);
    const entry = f.ctx.loader.resolve(id), fiber = entry.fiber;
    const otherFile = fileKey === 'main' ? f.nested : f.main;
    const originalOther = await readFile(otherFile, 'utf8');
    assert.equal(f.ctx.loader.remove(id), undefined, 'remove retains its synchronous API');
    await fiber.await();
    await entry.parent.tree.flush();
    t.diagnostic(`removed=${id} close-count=${f.state.closed.filter(x => x === label).length} live=${f.state.live.size}`);
    assert.equal(f.state.live.has(label), false);
    assert.deepEqual(f.state.closed, [label]);
    assert.equal(f.state.live.has('root'), true);
    assert.equal(f.state.live.has('sibling'), true);
    assert.equal(f.ctx.loader.resolve('same').options.config.label, 'root');
    assert.equal(f.ctx.loader.resolve('include:sibling:same').options.config.label, 'sibling');
    assert.throws(() => f.ctx.loader.resolve(id), /cannot resolve entry/);
    assert.equal(entry.parent.data.includes(entry.options), false);
    const persisted = JSON.parse(await readFile(f[fileKey], 'utf8'));
    const persistedRows = id === 'include:group-child' ? persisted.find(x => x.id === 'group').config : persisted;
    assert.equal(persistedRows.some(x => x.id === entry.options.id), false);
    assert.equal(await readFile(otherFile, 'utf8'), originalOther);
    if (label === 'nested') assert.equal(f.ctx.loader.resolve('include:same').options.config.label, 'outer');
    if (label === 'outer') assert.equal(f.ctx.loader.resolve('include:nested:same').options.config.label, 'nested');
  });
}

test('root and owning-subtree local IDs retain deletion and missing IDs do not mutate', async t => {
  const f = await fixture(t);
  const rootId = await f.ctx.loader.create(f.row('root-entry'));
  await f.ctx.loader.await();
  const rootFiber = f.ctx.loader.resolve(rootId).fiber;
  f.ctx.loader.remove(rootId);
  await rootFiber.await();
  assert.equal(f.state.live.has('root-entry'), false);
  const nested = f.ctx.loader.resolve('include:nested:same');
  nested.parent.tree.remove('same');
  await nested.fiber?.await();
  await nested.parent.tree.flush();
  assert.equal(f.state.live.has('nested'), false);
  assert.equal(f.state.live.has('outer'), true);
  const before = await readFile(f.main, 'utf8');
  assert.throws(() => f.ctx.loader.remove('include:missing'), /cannot resolve entry/);
  assert.throws(() => f.ctx.loader.remove('missing:same'), /cannot resolve entry/);
  assert.equal(await readFile(f.main, 'utf8'), before);
});

test('a nested create return value round-trips through root resolve and remove', async t => {
  const f = await fixture(t);
  const tree = f.ctx.loader.resolve('include:nested').subtree;
  const id = await tree.create(f.row('created'));
  await tree.await();
  assert.equal(id, 'include:nested:created');
  const entry = f.ctx.loader.resolve(id), fiber = entry.fiber;
  assert.equal(f.state.live.has('created'), true);
  f.ctx.loader.remove(id);
  await fiber.await();
  await tree.flush();
  assert.equal(f.state.live.has('created'), false);
  assert.throws(() => f.ctx.loader.resolve(id), /cannot resolve entry/);
  assert.throws(() => f.ctx.loader.remove(id), /cannot resolve entry/);
  assert.equal(JSON.parse(await readFile(f.nested, 'utf8')).some(row => row.id === 'created'), false);
});
