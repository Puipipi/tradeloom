export const name = 'own-hmr-selection-fixture';
export const inject = ['pluginManager', 'hmr', 'appReady', 'appExit'];
export function apply(ctx) {
  ctx.effect(() => ctx.appReady.onReady(() => { void run(ctx); }));
}
async function run(ctx) {
  const origin = process.env.OWN_REGISTRY;
  const scenario = process.env.SCENARIO;
  const name = 'own-selection-bundle';
  const result = { hmr: !!ctx.hmr };
  try {
    result.initial = (await ctx.pluginManager.listBundles()).find(item => item.name === name);
    const update = ctx.pluginManager.updateBundle(name, '2.0.0', { registry: origin });
    await (await fetch(origin+'/wait-check')).text();
    if (['disable-during-check', 'enable-during-check', 'restore-disabled'].includes(scenario)) {
      result.toggle = await ctx.pluginManager.setBundleEnabled(name, scenario === 'enable-during-check');
      result.afterToggle = (await ctx.pluginManager.listBundles()).find(item => item.name === name);
    }
    await (await fetch(origin+'/release-check')).text();
    result.update = await update;
    result.final = (await ctx.pluginManager.listBundles()).find(item => item.name === name);
  } catch (error) { result.error = { message: error.message, stack: error.stack }; }
  await (await fetch(origin+'/done', { method: 'POST', body: JSON.stringify(result) })).text();
  ctx.appExit(result.error ? 1 : 0);
}
