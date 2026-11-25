export const name = 'own-hmr-precondition-fixture';
export const inject = ['pluginManager', 'hmr', 'appReady', 'appExit'];

export function apply(ctx) {
  ctx.effect(() => ctx.appReady.onReady(() => { void run(ctx); }));
}

async function run(ctx) {
  const origin = process.env.OWN_REGISTRY;
  const scenario = process.env.SCENARIO;
  const name = 'own-selection-bundle';
  const manager = ctx.pluginManager;
  const inventory = async () => (await manager.listBundles()).find(item => item.name === name);
  const control = async path => (await fetch(origin + path)).text();
  const result = { hmr: !!ctx.hmr };
  try {
    result.initial = await inventory();
    if (scenario === 'explicit-replace') {
      result.removeInitial = await manager.removeBundle(name);
      result.installNewer = await manager.installBundle(`${name}@3.0.0`, {
        registry: origin, enabled: true, saveExact: true,
      });
      result.afterNewer = await inventory();
      result.removeNewer = await manager.removeBundle(name);
      result.installOlder = await manager.installBundle(`${name}@2.0.0`, {
        registry: origin, enabled: true, saveExact: true,
      });
    } else {
      const update = manager.updateBundle(name, '2.0.0', { registry: origin });
      await control('/wait-check');
      if (scenario === 'newer-update') {
        result.newerUpdate = await manager.updateBundle(name, '3.0.0', { registry: origin });
        result.afterNewer = await inventory();
      } else if (scenario === 'removed') {
        result.removal = await manager.removeBundle(name);
        result.afterRemoval = await inventory();
      }
      await control('/release-check');
      result.update = await update;
    }
    result.final = await inventory();
  } catch (error) {
    result.error = { message: error.message, stack: error.stack };
  }
  await (await fetch(origin + '/done', {
    method: 'POST', body: JSON.stringify(result),
  })).text();
  ctx.appExit(result.error ? 1 : 0);
}
