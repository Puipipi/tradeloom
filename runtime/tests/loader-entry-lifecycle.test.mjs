import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const prefix = process.env.DSH_TEST_PREFIX ?? process.env.DSH_PREFIX;
const options = { skip: !prefix && 'prepared DSH prefix required' };
let modules;
function api() {
  return modules ??= (async () => {
    const require = createRequire(resolve(prefix, 'package.json'));
    const load = name => import(pathToFileURL(require.resolve(`@deepseek-ai/${name}`)));
    const [{ Context }, { Loader }] = await Promise.all([load('cordis'), load('cordis-plugin-loader')]);
    return { Context, Loader, timer: pathToFileURL(require.resolve('@deepseek-ai/cordis-plugin-timer')).href };
  })();
}
async function fixture(t) {
  const { Context, Loader, timer } = await api();
  const ctx = new Context();
  t.after(() => ctx.fiber.dispose());
  const owner = ctx.plugin(Loader);
  await owner;
  return { ctx, loader: ctx.loader, timer, owner };
}
function pausePatchContext(t, ctx, name) {
  const entered = Promise.withResolvers();
  const gate = Promise.withResolvers();
  let blocked = false;
  const detach = ctx.on('loader/patch-context', async (entry, next) => {
    if (!blocked && entry.options.name === name) {
      blocked = true;
      entered.resolve(entry);
      await gate.promise;
    }
    return next();
  });
  t.after(() => { gate.resolve(); detach(); });
  return { entered: entered.promise, release: () => gate.resolve() };
}
// create's public type omits id. Capture the actual Entry through its public event;
// after create returns its promise, ensureId/update have assigned the generated id.
function startEntry(ctx, loader, name) {
  let entry;
  const detach = ctx.on('loader/entry-init', current => { entry = current; });
  let creating;
  try { creating = loader.create({ name }); } finally { detach(); }
  assert.ok(entry);
  const id = entry.options.id;
  assert.equal(typeof id, 'string');
  assert.equal(loader.resolve(id), entry);
  return { entry, id, creating };
}
async function settled(entry, creating) {
  await creating;
  await entry.fiber?.await();
}

test('disable during the real dynamic import prevents publication and patch-context work', options, async t => {
  const { ctx, loader, timer } = await fixture(t);
  let patched = 0;
  ctx.on('loader/patch-context', (entry, next) => { if (entry.options.name === timer) patched++; return next(); });
  const { creating, entry, id } = startEntry(ctx, loader, timer);
  assert.equal(entry.fiber, undefined, 'dynamic import has not returned a fiber');
  await loader.update(id, { disabled: true });
  await settled(entry, creating);
  assert.equal(entry.disabled, true);
  assert.equal(Boolean(ctx.get('timer')), false);
  assert.equal(entry.fiber, undefined);
  assert.equal(patched, 0);
});

test('disable during an awaited public patch-context hook prevents late publication', options, async t => {
  const { ctx, loader, timer } = await fixture(t);
  const gate = pausePatchContext(t, ctx, timer);
  const { creating, entry, id } = startEntry(ctx, loader, timer);
  assert.equal(await gate.entered, entry);
  await loader.update(id, { disabled: true });
  assert.equal(entry.fiber, undefined);
  assert.equal(Boolean(ctx.get('timer')), false);
  gate.release();
  await settled(entry, creating);
  assert.equal(entry.disabled, true);
  assert.equal(Boolean(ctx.get('timer')), false);
  assert.equal(entry.fiber, undefined);
});

test('remove during initialization prevents the retired entry from publishing', options, async t => {
  const { ctx, loader, timer } = await fixture(t);
  const gate = pausePatchContext(t, ctx, timer);
  const { creating, entry, id } = startEntry(ctx, loader, timer);
  assert.equal(await gate.entered, entry);
  loader.remove(id);
  assert.throws(() => loader.resolve(id));
  gate.release();
  await settled(entry, creating);
  assert.equal(entry.fiber, undefined);
  assert.equal(Boolean(ctx.get('timer')), false);
});

test('same-id replacement keeps only the new official plugin owner', options, async t => {
  const { ctx, loader, timer } = await fixture(t);
  const gate = pausePatchContext(t, ctx, timer);
  const { creating: oldCreating, entry: oldEntry, id } = startEntry(ctx, loader, timer);
  assert.equal(await gate.entered, oldEntry);
  loader.remove(id);
  // Configuration reload accepts explicit ids through the public EntryOptions[] type.
  await loader.root.update([{ id, name: timer }]);
  const current = loader.resolve(id);
  assert.notEqual(current, oldEntry);
  await current.fiber.await();
  assert.ok(ctx.get('timer'));
  gate.release();
  await settled(oldEntry, oldCreating);
  assert.equal(loader.resolve(id), current);
  assert.equal(oldEntry.fiber, undefined);
  await loader.update(id, { disabled: true });
  assert.equal(Boolean(ctx.get('timer')), false, 'disabling the current owner leaves no retired timer service');
});

test('same Entry disabled then re-enabled before completion remains valid', options, async t => {
  const { ctx, loader, timer } = await fixture(t);
  const gate = pausePatchContext(t, ctx, timer);
  const { creating, entry, id } = startEntry(ctx, loader, timer);
  assert.equal(await gate.entered, entry);
  await loader.update(id, { disabled: true });
  const enabling = loader.update(id, { disabled: false });
  gate.release();
  await Promise.all([creating, enabling]);
  await entry.fiber.await();
  assert.equal(loader.resolve(id), entry);
  assert.equal(entry.disabled, false);
  assert.ok(ctx.get('timer'));
  await loader.update(id, { disabled: true });
  assert.equal(Boolean(ctx.get('timer')), false);
});


test('disposing the actual Loader owner rejects late initialization without publishing a service', options, async t => {
  const { ctx, loader, timer, owner } = await fixture(t);
  const gate = pausePatchContext(t, ctx, timer);
  const { creating, entry } = startEntry(ctx, loader, timer);
  const outcome = creating.then(() => ({ ok: true }), error => ({ error }));
  assert.equal(await gate.entered, entry);
  await owner.dispose();
  gate.release();
  const result = await outcome;
  assert.equal(result.error?.code, 'INACTIVE_EFFECT');
  assert.equal(entry.fiber, undefined);
  assert.equal(Boolean(ctx.get('timer')), false);
});
