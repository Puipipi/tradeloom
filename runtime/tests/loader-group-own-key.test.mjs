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

for (const id of ['ordinary', 'constructor', 'toString']) {
  test(`public group config creates, updates and removes own entry ${id}`, options, async () => {
    const { Context, Loader, timer } = await api();
    const builtin = Object.prototype[id];
    const originalId = typeof builtin === 'function' ? Object.getOwnPropertyDescriptor(builtin, 'id') : undefined;
    const ctx = new Context();
    try {
      await ctx.plugin(Loader);
      await ctx.loader.root.update([{ id, name: timer }]);
      const entry = ctx.loader.resolve(id);
      await entry.fiber.await();
      assert.ok(ctx.get('timer'), 'a legitimate own-key entry starts the official service');
      await ctx.loader.root.update([{ id, name: timer, disabled: true }]);
      assert.equal(ctx.loader.resolve(id), entry);
      assert.equal(Boolean(ctx.get('timer')), false);
      await ctx.loader.root.update([{ id, name: timer, disabled: false }]);
      await entry.fiber.await();
      assert.ok(ctx.get('timer'));
      await ctx.loader.root.update([]);
      assert.throws(() => ctx.loader.resolve(id), 'deleted config entry must leave the tree');
      assert.equal(Boolean(ctx.get('timer')), false, 'removed official service must be unloaded');
      if (typeof builtin === 'function') assert.deepEqual(Object.getOwnPropertyDescriptor(builtin, 'id'), originalId);
    } finally {
      await ctx.fiber.dispose();
      // The baseline bug may assign id to an inherited builtin function. Restore
      // its exact descriptor in this isolated test process, even after a failure.
      if (typeof builtin === 'function') {
        if (originalId) Object.defineProperty(builtin, 'id', originalId);
        else delete builtin.id;
      }
    }
  });
}
