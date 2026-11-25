import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const base = join(resolve(process.env.DSH_PREFIX), 'node_modules/@deepseek-ai');
const { Context } = await import(pathToFileURL(join(base, 'cordis/lib/index.js')));
const { boot } = await import(pathToFileURL(join(base, 'dsh-app-boot/lib/index.js')));

function context(t) {
  const ctx = new Context();
  t.after(() => ctx.fiber.dispose());
  return ctx;
}

test('successful synchronous cleanup stays synchronous and LIFO', t => {
  const ctx = context(t), order = [];
  const dispose = ctx.effect(function* () {
    yield () => { order.push('first'); };
    yield () => { order.push('last'); };
  });
  assert.equal(dispose(), undefined);
  assert.deepEqual(order, ['last', 'first']);
  assert.equal(dispose(), undefined);
  assert.deepEqual(order, ['last', 'first'], 'cleanup must not repeat');
});

test('successful async cleanup resolves after every cleanup, LIFO', async t => {
  const ctx = context(t), order = [];
  const dispose = ctx.effect(function* () {
    yield () => { order.push('first'); };
    yield async () => { await Promise.resolve(); order.push('middle'); };
    yield async () => { order.push('last'); };
  });
  const pending = dispose();
  assert.equal(typeof pending.then, 'function');
  assert.equal(await pending, undefined);
  assert.deepEqual(order, ['last', 'middle', 'first']);
  assert.equal(dispose(), undefined);
});

test('a throwing cleanup does not skip the ones yielded before it', t => {
  const ctx = context(t), order = [], later = new Error('later failure');
  const dispose = ctx.effect(function* () {
    yield () => { order.push('first'); };
    yield () => { order.push('middle'); throw later; };
    yield () => { order.push('last'); throw undefined; };
  });
  let threw = false;
  try { dispose(); } catch (error) { threw = true; assert.equal(error, undefined); }
  assert.equal(threw, true, 'even an undefined thrown value stays a synchronous throw');
  assert.deepEqual(order, ['last', 'middle', 'first']);
  assert.equal(dispose(), undefined);
  assert.deepEqual(order, ['last', 'middle', 'first']);
});

test('an async rejection is awaited before the remaining cleanup and keeps its error', async t => {
  const ctx = context(t), order = [], first = new Error('first failure'), later = new Error('later failure');
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const dispose = ctx.effect(function* () {
    yield () => { order.push('first'); };
    yield () => { order.push('middle'); throw later; };
    yield async () => { order.push('last-start'); await gate; order.push('last-end'); throw first; };
  });
  const pending = dispose();
  assert.equal(typeof pending.then, 'function');
  const rejected = assert.rejects(pending, error => error === first);
  try {
    await Promise.resolve();
    assert.deepEqual(order, ['last-start'], 'earlier cleanup waits for the pending one');
  } finally { release(); }
  await rejected;
  assert.deepEqual(order, ['last-start', 'last-end', 'middle', 'first']);
  assert.equal(dispose(), undefined);
});

test('an earlier synchronous error survives a later rejecting thenable', async t => {
  const ctx = context(t), order = [], first = new Error('sync first'), later = new Error('thenable later');
  const dispose = ctx.effect(function* () {
    yield () => { order.push('first'); };
    yield () => ({ then(resolve, reject) { order.push('middle'); reject(later); } });
    yield () => { order.push('last'); throw first; };
  });
  const pending = dispose();
  assert.equal(typeof pending.then, 'function');
  await assert.rejects(pending, error => error === first);
  assert.deepEqual(order, ['last', 'middle', 'first']);
});

// A plugin's grouped effect whose last cleanup rejects: removing the plugin
// must still run the earlier cleanup (here standing in for a tool registration).
test('removing a plugin runs every grouped cleanup when one rejects', async t => {
  const root = await mkdtemp(join(tmpdir(), 'effect-dispose-'));
  let ctx;
  t.after(async () => { await ctx?.fiber.dispose(); await rm(root, { recursive: true, force: true }); });
  const module = pathToFileURL(join(root, 'plugin.mjs')).href;
  await writeFile(new URL(module), `export function apply(ctx) {
    ctx.effect(function* () {
      ctx.fixtureState.live.add('tool');
      yield () => { ctx.fixtureState.live.delete('tool'); };
      yield async () => { throw new Error('cleanup rejected'); };
    });
  }\n`);
  const main = join(root, 'main.json');
  await writeFile(main, JSON.stringify([{ id: 'plugin', name: module, config: {} }]));
  const state = { live: new Set() };
  ctx = await boot('dsh', main, [], c => c.provide('fixtureState', state));
  await ctx.loader.await();
  assert.equal(state.live.has('tool'), true);
  const fiber = ctx.loader.resolve('include:plugin').fiber;
  ctx.loader.remove('include:plugin');
  await fiber.await();
  assert.equal(state.live.has('tool'), false, 'the earlier cleanup ran');
});
