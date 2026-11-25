import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
const exec = promisify(execFile);
const prefix = resolve(process.env.DSH_PREFIX);
const pnpm = resolve(process.env.PNPM_BIN);
const { boot } = await import(pathToFileURL(join(prefix, 'node_modules/@deepseek-ai/dsh-app-boot/lib/index.js')));
const root = await mkdtemp(join(tmpdir(), 'own-update-selection-'));
const name = 'own-selection-bundle';
const scenario = process.env.SCENARIO ?? 'disable-during-check';
const initialEnabled = !['disabled-control', 'enable-during-check', 'unsupported-disabled'].includes(scenario);
let ctx;
let server;
let watchdog;
const entered = Promise.withResolvers();
const release = Promise.withResolvers();
const requests = [];
const facts = [];
try {
  const home = join(root, 'home');
  const dir = join(home, 'profiles/web');
  await mkdir(dir, { recursive: true });
  const archives = new Map();
  const manifests = {};
  for (const version of ['1.0.0', '2.0.0']) {
    const base = join(root, version);
    const pkg = join(base, 'package');
    await mkdir(pkg, { recursive: true });
    const manifest = {
      name, version, type: 'module',
      exports: { '.': './index.mjs', './package.json': './package.json' },
      dsh: { bundle: { patch: './cordis.patch.yml' } },
    };
    if (version === '2.0.0' && scenario.startsWith('unsupported-')) {
      manifest.dsh.bundle.platforms = [process.platform === 'darwin' ? 'linux' : 'darwin'];
    }
    manifests[version] = manifest;
    await writeFile(join(pkg, 'package.json'), JSON.stringify(manifest));
    await writeFile(join(pkg, 'index.mjs'), 'export function apply() {}\n');
    await writeFile(join(pkg, 'cordis.patch.yml'), '[]\n');
    const archive = join(base, 'package.tgz');
    await exec('tar', ['-czf', archive, '-C', base, 'package']);
    archives.set(version, await readFile(archive));
  }
  let held = false;
  let origin;
  server = createServer(async (req, res) => {
    requests.push(req.url);
    if (req.url.startsWith('/tar/')) {
      const bytes = archives.get(req.url.slice(5));
      if (!bytes) {
        res.writeHead(404);
        res.end();
        return;
      }
      res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': bytes.length });
      res.end(bytes);
      return;
    }
    if (req.url !== '/'+name) {
      res.writeHead(404);
      res.end();
      return;
    }
    if (!held) {
      held = true;
      entered.resolve();
      await release.promise;
    }
    const versions = Object.fromEntries(Object.entries(manifests).map(([version, manifest]) => [version, { ...manifest, dist: { tarball: origin+'/tar/'+version } }]));
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ name, 'dist-tags': { latest: '2.0.0' }, versions }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  origin = `http://127.0.0.1:${server.address().port}`;
  const pkg = join(dir, 'node_modules', name);
  await mkdir(pkg, { recursive: true });
  for (const file of ['package.json','index.mjs','cordis.patch.yml']) await writeFile(join(pkg, file), await readFile(join(root, '1.0.0/package', file)));
  await writeFile(join(dir, 'package.json'), JSON.stringify({ name: 'own-profile', private: true, dependencies: { [name]: '1.0.0' }, dsh: { profile: { bundles: initialEnabled ? [name] : [] } } }));
  await writeFile(join(dir, '.npmrc'), `registry=${origin}\nstore-dir=${join(root, 'store')}\nupdate-notifier=false\n`);
  const patchPath = join(dir, 'cordis.patch.yml');
  const main = join(dir, 'cordis.yml');
  const rows = [{ insert: [{ id: 'manager', name: pathToFileURL(join(prefix, 'node_modules/@deepseek-ai/dsh-plugin-manager/lib/index.js')).href, config: { pnpmCommand: pnpm, inspectTimeoutMs: 30000 } }] }];
  await writeFile(main, '[]\n');
  await writeFile(patchPath, JSON.stringify(rows));
  ctx = await boot('dsh', main, rows, async c => c.provide('profileContext', { dir, home, installAnchor: join(prefix, 'node_modules/@deepseek-ai/dsh/package.json'), patchPath, overlays: [], startedBundles: [], telemetryDisabledEnv: '1', packageManager: { command: pnpm, env: { HOME: home, npm_config_registry: origin, CI: 'true' } } }));
  const initial = (await ctx.pluginManager.listBundles()).find(item => item.name === name);
  facts.push({ stage: 'initial', value: initial });
  assert.equal(initial.enabled, initialEnabled);
  const update = ctx.pluginManager.updateBundle(name, '2.0.0', { registry: origin });
  watchdog = setTimeout(() => {
    entered.reject(Error('Own registry gate timed out'));
    release.resolve();
    server.closeAllConnections();
  }, 35000);
  await Promise.race([entered.promise, update.then(() => { throw Error('Update ended before registry gate'); })]);
  if (['disable-during-check', 'enable-during-check'].includes(scenario)) {
    const desiredEnabled = scenario === 'enable-during-check';
    const disable = await ctx.pluginManager.setBundleEnabled(name, desiredEnabled);
    facts.push({ stage: 'selection-changed-during-registry-check', result: disable, manifest: JSON.parse(await readFile(join(dir, 'package.json'), 'utf8')) });
    assert.equal(disable.application, 'restart-required');
    assert.equal(disable.changed, true);
  }
  release.resolve();
  const updated = await update;
  clearTimeout(watchdog);
  facts.push({ stage: 'update-completed', result: updated, manifest: JSON.parse(await readFile(join(dir, 'package.json'), 'utf8')), bundle: (await ctx.pluginManager.listBundles()).find(item => item.name === name) });
  console.log(JSON.stringify({ scenario, requests, facts }, null, 2));
  assert.equal(updated.result.packageResult?.exitCode, 0, 'real pnpm installation succeeded');
  assert.equal(updated.result.application, scenario === 'unsupported-enabled' ? 'failed' : 'restart-required');
  assert.equal(facts.at(-1).bundle.enabled, scenario === 'disable-during-check' ? false : scenario === 'enable-during-check' ? true : initialEnabled, 'update preserves selection after a completed explicit disable, or the unchanged selection');
} finally {
  clearTimeout(watchdog);
  release.resolve();
  await ctx?.fiber.dispose();
  if (server) {
    server.closeAllConnections();
    await new Promise(done => server.close(done));
  }
  await rm(root, { recursive: true, force: true });
}
