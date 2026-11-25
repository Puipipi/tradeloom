import assert from 'node:assert/strict';
import { setImmediate as immediate } from 'node:timers/promises';
import { createHook } from 'node:async_hooks';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
const prefix = resolve(process.env.DSH_PREFIX);
const { boot } = await import(pathToFileURL(join(prefix, 'node_modules/@deepseek-ai/dsh-app-boot/lib/index.js')));
const { withFileLock } = await import(pathToFileURL(join(prefix, 'node_modules/@deepseek-ai/dsh-atomic-write/lib/index.js')));
const root = await mkdtemp(join(tmpdir(), 'own-manager-lock-'));
const release = Promise.withResolvers();
const acquired = Promise.withResolvers();
const timerEntered = Promise.withResolvers();
const scenario = process.env.SCENARIO ?? 'dispose-wait';
let ctx, holding, pending, outcome;
let armed = false;
let timer, timerId, destroyed = false, settled = false;
const hook = createHook({
  init(id, type, trigger, resource) {
    if (armed && type === 'Timeout') {
      assert.equal(timer, undefined, 'exactly one lock retry timer before disposal');
      timer = resource; timerId = id;
      timerEntered.resolve();
    }
  },
  destroy(id) { if (id === timerId) destroyed = true; },
});
try {
  const dir = join(root, 'profile'), home = join(root, 'home');
  await mkdir(dir); await mkdir(home);
  const pkg = join(dir, 'node_modules/own-not-selected');
  await mkdir(pkg, { recursive: true });
  await writeFile(join(pkg, 'package.json'), JSON.stringify({ name: 'own-not-selected', version: '1.0.0', type: 'module', dsh: { bundle: { patch: './cordis.patch.yml' } } }));
  await writeFile(join(pkg, 'cordis.patch.yml'), '[]\n');
  await writeFile(join(dir, 'package.json'), JSON.stringify({ name: 'own-profile', private: true, dependencies: { 'own-not-selected': '1.0.0' }, dsh: { profile: { bundles: [] } } }));
  const main = join(dir, 'cordis.yml'), patchPath = join(dir, 'cordis.patch.yml');
  const rows = [{ insert: [{ id: 'manager', name: pathToFileURL(join(prefix, 'node_modules/@deepseek-ai/dsh-plugin-manager/lib/index.js')).href }] }];
  await writeFile(main, '[]\n'); await writeFile(patchPath, JSON.stringify(rows));
  ctx = await boot('dsh', main, rows, async context => context.provide('profileContext', {
    dir, home, installAnchor: join(prefix, 'node_modules/@deepseek-ai/dsh/package.json'), patchPath,
    overlays: [], startedBundles: [], telemetryDisabledEnv: '1', packageManager: { command: 'pnpm', env: {} },
  }));
  const beforeManifest = await readFile(join(dir, 'package.json'), 'utf8');
  holding = withFileLock(join(dir, 'package.json'), async () => { acquired.resolve(); await release.promise; });
  await acquired.promise;
  hook.enable(); armed = true;
  pending = ctx.pluginManager.setBundleEnabled('own-not-selected', false).then(value => { outcome = { value }; }, error => { outcome = { error }; }).finally(() => { settled = true; });
  await timerEntered.promise;
  armed = false;
  if (scenario === 'normal-contention') {
    release.resolve();
    await holding;
    await pending;
    assert.equal(outcome.error, undefined);
    assert.equal(outcome.value.application, 'restart-required', JSON.stringify(outcome));
    console.log(JSON.stringify({ scenario, settled, application: outcome.value.application }));
  } else {
    await ctx.fiber.dispose();
    // Event-loop turn, not a deadline advance: lets native timer cancellation destroy hooks run.
    await immediate();
    assert.equal(await readFile(join(dir, 'package.json'), 'utf8'), beforeManifest);
    assert.equal(await readFile(join(dir, 'package.json.lock'), 'utf8'), `${process.pid}\n`);
    const facts = { scenario, ownerDisposed: true, pendingSettled: settled,
      nativeRetryHasRef: timer.hasRef(), nativeRetryDestroyed: destroyed,
      nativeRetryInActiveResources: process.getActiveResourcesInfo().includes('Timeout') };
    console.log(JSON.stringify(facts));
    if (scenario === 'dispose-error-after-release') {
      release.resolve();
      await holding;
      await pending;
      assert.equal(outcome.error?.name, 'AbortError');
    } else {
      assert.equal(destroyed, true, 'disposed owner must cancel its native lock retry timer');
      assert.equal(settled, true, 'lock wait must reject without acquiring the held lock');
      assert.equal(outcome.error?.name, 'AbortError');
    }
  }
} finally {
  armed = false; hook.disable();
  release.resolve();
  await holding;
  await pending?.catch(() => {});
  await ctx?.fiber.dispose();
  await rm(root, { recursive: true, force: true });
}
