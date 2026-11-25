// Real published services and disk locks in an isolated Loader profile.
// Registry discovery and pnpm are explicit offline peers. This is not an
// Android/App or default dsh web end-to-end run.
import assert from 'node:assert/strict';
import { AsyncLocalStorage, createHook } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

assert(process.env.DSH_PREFIX, 'DSH_PREFIX must name a prepared runtime');
const prefix = resolve(process.env.DSH_PREFIX);
const scenario = process.env.SCENARIO ?? 'install-save';
assert(['install-save','ordinary-contention','no-hmr'].includes(scenario));
const moduleFile = name => join(prefix, 'node_modules/@deepseek-ai', name, 'lib/index.js');
const { boot, readProfilePatches } = await import(pathToFileURL(moduleFile('dsh-app-boot')));
const { ConfigEditor } = await import(pathToFileURL(moduleFile('dsh-config-editor')));
const { PluginManager } = await import(pathToFileURL(moduleFile('dsh-plugin-manager')));
const { default: Hmr } = await import(pathToFileURL(moduleFile('dsh-hmr')));
const { writeFileAtomic } = await import(pathToFileURL(moduleFile('dsh-atomic-write')));
const root = await mkdtemp(join(tmpdir(), 'config-lock-order-'));
const requests = new AsyncLocalStorage();
const original = value => value?.[Symbol.for('cordis.original')] ?? value;
const ioEntered = Promise.withResolvers(), releaseIO = Promise.withResolvers(), lockWait = Promise.withResolvers();
const events = [], observedHmr = new Set();
const started = performance.now();
let ctx, hmr, installation, save, enteredAuthorizer = false, waitObserved = false;
const mark = (event, extra = {}) => events.push({ event, ms: +(performance.now() - started).toFixed(3),
  request: requests.getStore() ?? null, hmrStore: hmr?.executing.getStore() ?? null, ...extra });
const hook = createHook({ init(_id, type) {
  const request = requests.getStore();
  if (request === undefined) return;
  if (hmr?.executing.getStore() === true && !observedHmr.has(request)) {
    observedHmr.add(request); mark('hmr-enter', { resourceType: type });
  }
  if (request === 'save-B' && type === 'Timeout' && !enteredAuthorizer && !waitObserved) {
    const stack = new Error().stack ?? '';
    if (!stack.includes('withFileLock') || !stack.includes('/dsh-atomic-write/')) return;
    waitObserved = true; mark('profile-lock-retry', {source:'dsh-atomic-write/withFileLock'}); lockWait.resolve();
  }
} });
try {
  const dir = join(root, 'profile'), home = join(root, 'home');
  await mkdir(dir); await mkdir(home);
  const main = join(dir, 'cordis.yml'), patchPath = join(dir, 'cordis.patch.yml');
  const manifestPath = join(dir, 'package.json');
  const bName = 'own-lock-b', aName = 'own-lock-a';
  const bDir = join(dir, 'node_modules', bName);
  await mkdir(bDir, { recursive: true });
  const schema = pathToFileURL(join(prefix, 'node_modules/@deepseek-ai/schemastery/lib/index.mjs')).href;
  await writeFile(join(bDir, 'package.json'), JSON.stringify({ name:bName, version:'1.0.0', type:'module',
    exports:{'.':'./index.mjs','./package.json':'./package.json'}, dsh:{bundle:{patch:'./cordis.patch.yml'}} }));
  await writeFile(join(bDir, 'index.mjs'), `import z from ${JSON.stringify(schema)};\nexport const name='lock-b';\nexport const Config=z.object({count:z.number().default(0)});\nexport function apply() {}\n`);
  await writeFile(join(bDir, 'cordis.patch.yml'), JSON.stringify([{insert:[{id:'b',name:bName,config:{count:0}}]}]));
  await writeFile(manifestPath, JSON.stringify({name:'own-profile',private:true,dependencies:{[bName]:'1.0.0'},dsh:{profile:{bundles:[bName]}}}));
  const rows = [{insert:[
    {id:'timer',name:pathToFileURL(moduleFile('cordis-plugin-timer')).href},
    ...(scenario === 'no-hmr' ? [] : [{id:'hmr',name:pathToFileURL(moduleFile('dsh-hmr')).href,config:{root:[]}}]),
    {id:'manager',name:pathToFileURL(moduleFile('dsh-plugin-manager')).href},
    {id:'editor',name:pathToFileURL(moduleFile('dsh-config-editor')).href},
  ]}];
  await writeFile(main, '[]\n'); await writeFile(patchPath, JSON.stringify(rows));
  const profile = {dir,home,installAnchor:join(prefix,'node_modules/@deepseek-ai/dsh/package.json'),patchPath,
    overlays:[],startedBundles:[bName],telemetryDisabledEnv:'1',packageManager:{command:'pnpm',env:{}}};
  const readyCallbacks = new Set();
  ctx = await boot('dsh', main, readProfilePatches('dsh', profile), async context => {
    context.provide('profileContext', profile);
    context.provide('appReady', {onReady(callback) {
      readyCallbacks.add(callback); return () => readyCallbacks.delete(callback);
    }});
  });
  const editor = original(ctx.configEditor), manager = original(ctx.pluginManager);
  hmr = original(ctx.hmr);
  for (const callback of readyCallbacks) callback();
  await hmr?.applicationReady;
  assert.equal(Object.getPrototypeOf(editor), ConfigEditor.prototype);
  assert.equal(Object.getPrototypeOf(manager), PluginManager.prototype);
  if (scenario === 'no-hmr') assert.equal(hmr, undefined);
  else assert.equal(Object.getPrototypeOf(hmr), Hmr.prototype);
  assert.equal(original(editor.ownerContext.get('hmr')), hmr);
  assert.equal(original(manager.ownerContext.get('hmr')), hmr);
  assert.equal(editor.ownerContext.profileContext.dir, manager.profile.dir);
  const entry = editor.entries().find(row => row.options.id === 'b');
  assert.equal(entry?.fiber?.state, 2);
  const fiber = entry.fiber, runtime = fiber.runtime;
  const layer = editor.configuration().find(row => row.entry === entry);
  let bTransitionsBeforeSave = 0;
  ctx.on('internal/status', value => {if (value === fiber && !enteredAuthorizer) bTransitionsBeforeSave++;});
  // Only the external package-run boundary is controlled. The real manager
  // discovers the installed bundle and executes change/configure/reload.
  manager.registries = async () => ({registry:null,resolved:null,fallbackRegistries:[]});
  manager.runPnpm = async args => {
    assert.deepEqual(args, ['add', `${aName}@1.0.0`]);
    assert.equal(await readFile(manifestPath + '.lock', 'utf8'), `${process.pid}\n`);
    mark('package-peer-enter');
    const aDir = join(dir, 'node_modules', aName);
    await mkdir(aDir, {recursive:true});
    await writeFile(join(aDir, 'package.json'), JSON.stringify({name:aName,version:'1.0.0',type:'module',
      exports:{'.':'./index.mjs','./package.json':'./package.json'},dsh:{bundle:{patch:'./cordis.patch.yml'}}}));
    await writeFile(join(aDir, 'index.mjs'), "export const name='lock-a';\nexport function apply() {}\n");
    await writeFile(join(aDir, 'cordis.patch.yml'), JSON.stringify([{insert:[{id:'a',name:aName}]}]));
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    manifest.dependencies[aName] = '1.0.0';
    await writeFileAtomic(manifestPath, JSON.stringify(manifest), {mode:0o600});
    mark('package-files-written');
    ioEntered.resolve(); await releaseIO.promise;
    mark('package-peer-return');
    return {exitCode:0,output:''};
  };
  ctx.on('plugin-manager/install-state', state => {if (state.phase === 'applying') mark('install-applying');});
  hook.enable();
  installation = requests.run('install-A', () => {
    mark('request-start');
    return manager.installBundle(`${aName}@1.0.0`, {requestId:'lock-order'}).then(value => {mark('install-settled',{application:value.application}); return value;});
  });
  await Promise.race([ioEntered.promise, installation.then(value => {throw Error('install settled before package peer: '+JSON.stringify(value));})]);
  save = requests.run('save-B', () => {
    mark('request-start');
    return editor.edit(entry, (raw, inherited) => {
      enteredAuthorizer = true; mark('save-authorizer');
      assert.equal(entry.fiber, fiber, 'unrelated A must retain B fiber before authorization');
      assert.equal(entry.fiber.runtime, runtime, 'unrelated A must retain B runtime');
      assert.equal(bTransitionsBeforeSave, 0, 'unrelated A must not restart B');
      assert.deepEqual(raw, {count:0});
      assert.deepEqual(inherited, layer.inherited);
      assert.deepEqual(editor.configuration().find(row => row.entry === entry)?.override, layer.override);
      return {...raw,count:1};
    }).then(() => {mark('save-settled',{ok:true}); return {ok:true};}, error => {
      mark('save-settled',{ok:false,error:error.message}); return {ok:false,error:error.message};
    });
  });
  await Promise.race([lockWait.promise, save.then(value => {throw Error('save settled before observing profile contention: '+JSON.stringify(value));})]);
  if (scenario === 'ordinary-contention') await save;
  releaseIO.resolve();
  const [installed, saved] = await Promise.all([installation, save]);
  await assert.rejects(readFile(manifestPath + '.lock'), {code:'ENOENT'});
  const aActive = [...ctx.loader.entries()].find(row => row.options.id === 'a')?.fiber?.state === 2;
  if (hmr) assert.equal(aActive, true, 'installation must activate an actual unrelated A entry');
  if (!enteredAuthorizer) {
    assert.equal(entry.fiber, fiber, 'installation alone must retain B fiber');
    assert.equal(entry.fiber.runtime, runtime);
    assert.equal(bTransitionsBeforeSave, 0);
    assert.deepEqual(entry.options.config, {count:0});
    const unchanged = editor.configuration().find(row => row.entry === entry);
    assert.deepEqual(unchanged?.inherited, layer.inherited);
    assert.deepEqual(unchanged?.override, layer.override);
  }
  const result = {scenario,scope:'actual services, Loader and disk; offline package-run peer; no App/HTTP/real pnpm',
    hmrPresent:hmr !== undefined,sameHmrOriginal:hmr !== undefined,sameProfile:true,aActive,bTransitionsBeforeSave,enteredAuthorizer,
    installed,saved,finalCount:entry.options.config.count,
    persistedCount:editor.configuration().find(row => row.entry === entry)?.override.count,
    modules:Object.fromEntries(await Promise.all(['dsh-config-editor','dsh-plugin-manager','dsh-hmr','dsh-atomic-write'].map(async name => [name,createHash('sha256').update(await readFile(moduleFile(name))).digest('hex')]))),events};
  console.log(JSON.stringify(result,null,2));
  const waiting = events.find(row => row.event === 'profile-lock-retry');
  const applying = events.find(row => row.event === 'install-applying');
  assert.equal(installed.application, scenario === 'no-hmr' ? 'restart-required' : 'applied');
  if (scenario === 'ordinary-contention') {
    assert.equal(saved.ok, false, 'a package operation still active beyond the existing deadline remains a conflict');
    assert.match(saved.error, /timed out waiting for the writer lock/);
    assert.equal(enteredAuthorizer, false);
    assert.equal(result.finalCount, 0);
    assert(applying.ms > events.find(row => row.event === 'save-settled').ms);
  } else {
    const saveStarted = events.find(row => row.event === 'request-start' && row.request === 'save-B');
    assert(applying && applying.ms - saveStarted.ms < 1000, 'package peer finished and installation reached HMR within the existing 2 s deadline');
    assert.equal(saved.ok, true, 'save must not time out behind an install whose only remaining gate is its own HMR transaction');
    assert.equal(waiting.hmrStore, null, 'waiting for the profile lock must leave HMR available');
    assert.equal(result.finalCount, 1);
    assert.equal(result.persistedCount, 1);
  }
} finally {
  releaseIO.resolve();
  await Promise.allSettled([installation, save]);
  hook.disable();
  try { await ctx?.fiber.dispose(); }
  finally { await rm(root, {recursive:true,force:true}); }
}
