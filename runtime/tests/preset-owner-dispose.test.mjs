import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const base = join(resolve(process.env.DSH_PREFIX), 'node_modules/@deepseek-ai');
const { boot } = await import(pathToFileURL(join(base, 'dsh-app-boot/lib/index.js')));
const { createScope, scopeOf, scopeParentOf } = await import(pathToFileURL(join(base, 'dsh-scope/lib/index.js')));

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'preset-owner-'));
  let ctx;
  t.after(async () => { await ctx?.fiber.dispose(); await rm(root, { recursive: true, force: true }); });
  const main = join(root, 'main.json'), module = pathToFileURL(join(root, 'plugin.mjs')).href;
  await writeFile(new URL(module), `export const inject = ['fixtureState'];
export function apply(ctx) { ctx.fixtureState.live++; ctx.effect(() => () => { ctx.fixtureState.live--; ctx.fixtureState.closed++; }); }
`);
  const entry = (id, name, config) => ({ id, name: pathToFileURL(join(base, name, 'lib/index.js')).href, config });
  await writeFile(main, JSON.stringify([
    entry('agents', 'dsh-agent', {}),
    entry('projections', 'dsh-session-projection', {}),
    entry('presets', 'dsh-agent-preset-registry', { default: 'fixture' }),
  ]));
  const state = { live: 0, closed: 0 };
  ctx = await boot('dsh', main, [], c => c.provide('fixtureState', state));
  const presets = ctx.agentPresets;
  const unregister = await presets.register({ id: 'fixture', plugins: [{ id: 'held', name: module }] });
  assert.equal(state.live, 1);
  return { ctx, presets, unregister, state };
}

function pauseDiagnostic(t, presets) {
  const entered = Promise.withResolvers(), release = Promise.withResolvers();
  const diagnostic = presets.diagnostic;
  t.mock.method(presets, 'diagnostic', async function (...args) {
    const result = await diagnostic.apply(this, args);
    entered.resolve();
    await release.promise;
    return result;
  });
  return { entered: entered.promise, release: () => release.resolve() };
}

for (const keepLease of [false, true]) {
  test(`retired mount owner cannot retain a preset generation${keepLease ? ' beside a live lease' : ''}`, async t => {
    const { ctx, presets, unregister, state } = await fixture(t);
    const lease = keepLease ? await presets.acquireScope('fixture') : undefined;
    const scope = createScope(ctx, {}), gate = pauseDiagnostic(t, presets);
    const mount = presets.mount(scope.ctx, 'fixture');
    const rejected = assert.rejects(mount, /inactive|disposed|unloaded/i);
    await gate.entered;
    try { await scope.dispose(); }
    finally { gate.release(); }
    await rejected;
    await unregister();
    if (lease) {
      assert.equal(state.live, 1, 'the legitimate lease still owns the retired generation');
      assert.equal(presets.inspectCompositions().length, 1);
      await lease[Symbol.asyncDispose]();
      await lease[Symbol.asyncDispose]();
    }
    t.diagnostic(JSON.stringify({ live: state.live, closed: state.closed, retained: presets.inspectCompositions().length }));
    assert.equal(state.live, 0);
    assert.equal(state.closed, 1);
    assert.deepEqual(presets.inspectCompositions(), []);
    assert.equal(scopeParentOf(scopeOf(scope.ctx)), undefined);
  });
}

test('a live scope keeps its mounted preset until actual scope disposal', async t => {
  const { ctx, presets, unregister, state } = await fixture(t), scope = createScope(ctx, {});
  assert.deepEqual(await presets.mount(scope.ctx, 'fixture'), { id: 'fixture' });
  assert.deepEqual(await presets.mount(scope.ctx, 'fixture'), { id: 'fixture' });
  assert.ok(scopeParentOf(scopeOf(scope.ctx)));
  await unregister();
  assert.equal(state.live, 1);
  assert.equal(presets.inspectCompositions().length, 1);
  await scope.dispose();
  assert.equal(state.live, 0);
  assert.equal(state.closed, 1);
  assert.deepEqual(presets.inspectCompositions(), []);
});

test('a missing preset keeps the original error and does not bind the scope', async t => {
  const { ctx, presets, unregister, state } = await fixture(t), scope = createScope(ctx, {});
  await assert.rejects(presets.mount(scope.ctx, 'missing'), error => error.code === 'agent-preset/not-found');
  assert.equal(scopeParentOf(scopeOf(scope.ctx)), undefined);
  await unregister();
  assert.equal(state.live, 0);
  assert.equal(state.closed, 1);
  await scope.dispose();
});

test('releasing an unrelated scope does not block a replacement mount', async t => {
  const { ctx, presets, unregister, state } = await fixture(t);
  const retired = createScope(ctx, {});
  await retired.dispose();
  const replacement = createScope(ctx, {});
  assert.deepEqual(await presets.mount(replacement.ctx, 'fixture'), { id: 'fixture' });
  await unregister();
  assert.equal(state.live, 1);
  await replacement.dispose();
  assert.equal(state.closed, 1);
  assert.equal(state.live, 0);
});
