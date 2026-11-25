import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';

const exec = promisify(execFile);
const prefix = resolve(process.env.DSH_PREFIX);
const pnpm = resolve(process.env.PNPM_BIN);
const scenario = process.env.SCENARIO;
const { boot } = await import(pathToFileURL(join(
  prefix, 'node_modules/@deepseek-ai/dsh-app-boot/lib/index.js',
)));
const root = await mkdtemp(join(tmpdir(), 'own-update-precondition-'));
const name = 'own-precondition-bundle';
const entered = Promise.withResolvers();
const release = Promise.withResolvers();
const requests = [];
const facts = [];
let ctx;
let server;
let watchdog;
let update;

try {
  const home = join(root, 'home');
  const dir = join(home, 'profiles/web');
  await mkdir(dir, { recursive: true });
  const archives = new Map();
  const manifests = {};
  for (const version of ['1.0.0', '2.0.0', '3.0.0']) {
    const base = join(root, version);
    const pkg = join(base, 'package');
    await mkdir(pkg, { recursive: true });
    const manifest = {
      name, version, type: 'module',
      exports: { '.': './index.mjs', './package.json': './package.json' },
      dsh: { bundle: { patch: './cordis.patch.yml' } },
    };
    if (scenario === 'incompatible-target' && version === '2.0.0') {
      manifest.engines = { dsh: '>=999.0.0' };
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
  server = createServer(async (request, response) => {
    requests.push(request.url);
    if (request.url.startsWith('/tar/')) {
      const bytes = archives.get(request.url.slice(5));
      if (!bytes) {
        response.writeHead(404);
        response.end();
        return;
      }
      response.writeHead(200, {
        'content-type': 'application/octet-stream', 'content-length': bytes.length,
      });
      response.end(bytes);
      return;
    }
    if (request.url !== `/${name}`) {
      response.writeHead(404);
      response.end();
      return;
    }
    if (!held && scenario !== 'explicit-downgrade') {
      held = true;
      entered.resolve();
      await release.promise;
    }
    const versions = Object.fromEntries(Object.entries(manifests).map(([version, manifest]) => [
      version, { ...manifest, dist: { tarball: `${origin}/tar/${version}` } },
    ]));
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ name, 'dist-tags': { latest: '3.0.0' }, versions }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  origin = `http://127.0.0.1:${server.address().port}`;
  const initialVersion = scenario === 'explicit-downgrade' ? '3.0.0' : '1.0.0';
  const pkg = join(dir, 'node_modules', name);
  await mkdir(pkg, { recursive: true });
  for (const file of ['package.json', 'index.mjs', 'cordis.patch.yml']) {
    await writeFile(join(pkg, file), await readFile(join(root, `${initialVersion}/package`, file)));
  }
  await writeFile(join(dir, 'package.json'), JSON.stringify({
    name: 'own-profile', private: true, dependencies: { [name]: initialVersion },
    dsh: { profile: { bundles: [name] } },
  }));
  await writeFile(join(dir, '.npmrc'), [
    `registry=${origin}`, `store-dir=${join(root, 'store')}`, 'update-notifier=false', '',
  ].join('\n'));
  const patchPath = join(dir, 'cordis.patch.yml');
  const main = join(dir, 'cordis.yml');
  const rows = [{ insert: [{
    id: 'manager',
    name: pathToFileURL(join(prefix, 'node_modules/@deepseek-ai/dsh-plugin-manager/lib/index.js')).href,
    config: { pnpmCommand: pnpm, inspectTimeoutMs: 30000 },
  }] }];
  await writeFile(main, '[]\n');
  await writeFile(patchPath, JSON.stringify(rows));
  ctx = await boot('dsh', main, rows, async context => context.provide('profileContext', {
    dir, home, installAnchor: join(prefix, 'node_modules/@deepseek-ai/dsh/package.json'),
    patchPath, overlays: [], startedBundles: [], telemetryDisabledEnv: '1',
    packageManager: { command: pnpm, env: { HOME: home, npm_config_registry: origin, CI: 'true' } },
  }));
  const observe = async (stage, result) => {
    const bundle = (await ctx.pluginManager.listBundles()).find(item => item.name === name);
    const manifest = JSON.parse(await readFile(join(dir, 'package.json'), 'utf8'));
    const fact = { stage, result, bundle, manifest };
    facts.push(fact);
    return fact;
  };
  await observe('initial');
  watchdog = setTimeout(() => {
    release.resolve();
    server.closeAllConnections();
  }, 35000);
  let result;
  let beforeFiles;
  if (scenario === 'explicit-downgrade') {
    result = await ctx.pluginManager.installBundle(`${name}@2.0.0`, {
      registry: origin, saveExact: true, enabled: false,
    });
  } else {
    update = ctx.pluginManager.updateBundle(name, '2.0.0', { registry: origin });
    await entered.promise;
    if (scenario === 'newer-install') {
      const newer = await ctx.pluginManager.installBundle(`${name}@3.0.0`, {
        registry: origin, saveExact: true, enabled: false,
      });
      assert.equal(newer.packageResult?.exitCode, 0);
      const current = await observe('newer-installed', newer);
      assert.equal(current.bundle.version, '3.0.0');
    } else if (scenario === 'removed') {
      const removed = await ctx.pluginManager.removeBundle(name);
      assert.equal(removed.packageResult?.exitCode, 0);
      const current = await observe('removed', removed);
      assert.equal(Object.hasOwn(current.manifest.dependencies ?? {}, name), false);
    }
    beforeFiles = await Promise.all(['package.json', 'pnpm-lock.yaml'].map(async file => {
      try { return await readFile(join(dir, file), 'utf8'); }
      catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    }));
    release.resolve();
    result = (await update).result;
  }
  clearTimeout(watchdog);
  const final = await observe('finished', result);
  console.log(JSON.stringify({ scenario, requests, facts }, null, 2));
  if (scenario === 'newer-install' || scenario === 'removed') {
    assert.equal(result.application, 'failed');
    assert.equal(result.error?.code, 'operation-error');
    assert.match(result.error.diagnostic, /changed while checking/);
    assert.equal(result.changed, false);
    assert.equal(result.packageResult, undefined, 'stale update must not start pnpm installation');
    const afterFiles = await Promise.all(['package.json', 'pnpm-lock.yaml'].map(async file => {
      try { return await readFile(join(dir, file), 'utf8'); }
      catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    }));
    assert.deepEqual(afterFiles, beforeFiles);
    if (scenario === 'newer-install') assert.equal(final.bundle.version, '3.0.0');
    else assert.equal(Object.hasOwn(final.manifest.dependencies ?? {}, name), false);
    assert.equal(requests.includes('/tar/2.0.0'), false);
  } else if (scenario === 'incompatible-target') {
    assert.equal(result.application, 'failed');
    assert.equal(result.error?.code, 'incompatible-version');
    assert.equal(result.changed, false);
    assert.equal(result.packageResult, undefined);
    assert.equal(final.bundle.version, '1.0.0');
    assert.equal(final.manifest.dependencies[name], '1.0.0');
    assert.equal(requests.includes('/tar/2.0.0'), false);
  } else {
    assert.equal(result.packageResult?.exitCode, 0);
    assert.equal(result.application, 'restart-required');
    assert.equal(final.bundle.version, '2.0.0');
    assert.equal(final.manifest.dependencies[name], '2.0.0');
  }
} finally {
  clearTimeout(watchdog);
  release.resolve();
  await ctx?.fiber.dispose();
  if (update) await update.catch(() => {});
  if (server) {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
  await rm(root, { recursive: true, force: true });
}
