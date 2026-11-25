import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
const exec = promisify(execFile);
const prefix = resolve(process.env.DSH_PREFIX);
const pnpm = resolve(process.env.PNPM_BIN);

const root = await mkdtemp(join(tmpdir(), 'own-update-selection-'));
const name = 'own-selection-bundle';
const scenario = process.env.SCENARIO ?? 'disable-during-check';
const initialEnabled = !['disabled-control', 'enable-during-check', 'unsupported-disabled'].includes(scenario);
let child;
const finished = Promise.withResolvers();
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
    await writeFile(join(pkg, 'cordis.patch.yml'), scenario === 'restore-disabled' && version === '2.0.0' ? ': [broken' : '[]\n');
    const archive = join(base, 'package.tgz');
    await exec('tar', ['-czf', archive, '-C', base, 'package']);
    archives.set(version, await readFile(archive));
  }
  let held = false;
  let origin;
  server = createServer(async (req, res) => {
    if (req.url === '/wait-check') { await entered.promise; res.end('CHECKING'); return; }
    if (req.url === '/release-check') { release.resolve(); res.end('RELEASED'); return; }
    if (req.url === '/done') {
      const chunks = []; for await (const chunk of req) chunks.push(chunk);
      finished.resolve(JSON.parse(Buffer.concat(chunks).toString()));
      res.end('DONE'); return;
    }
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
  const fixture = join(root, 'fixture.mjs');
  await writeFile(fixture, await readFile(new URL('./plugin-update-hmr-driver.mjs', import.meta.url)));
  const rows = [{ insert: [
    { id: 'manager', name: pathToFileURL(join(prefix, 'node_modules/@deepseek-ai/dsh-plugin-manager/lib/index.js')).href, config: { pnpmCommand: pnpm, inspectTimeoutMs: 30000 } },
    { id: 'timer', name: pathToFileURL(join(prefix, 'node_modules/@deepseek-ai/cordis-plugin-timer/lib/index.js')).href },
    { id: 'hmr', name: pathToFileURL(join(prefix, 'node_modules/@deepseek-ai/dsh-hmr/lib/index.js')).href, config: { root: [] } },
    { id: 'own-fixture', name: pathToFileURL(fixture).href },
  ] }];
  await writeFile(main, '[]\n');
  await writeFile(patchPath, JSON.stringify(rows));
  const env = Object.fromEntries(['PATH','LANG','LC_ALL','TMPDIR'].filter(key => process.env[key]).map(key => [key, process.env[key]]));
  Object.assign(env, { HOME: home, DSH_HOME: home, DSH_TELEMETRY_DISABLED: '1', SCENARIO: scenario, OWN_REGISTRY: origin });
  child = spawn(process.execPath, [join(prefix, 'node_modules/@deepseek-ai/dsh/lib/bin.js'), 'web', '--no-open'], { cwd: dir, env, stdio: ['ignore','pipe','pipe'] });
  let output = '';
  child.stdout.on('data', chunk => output += chunk);
  child.stderr.on('data', chunk => output += chunk);
  const exited = once(child, 'close');
  watchdog = setTimeout(() => child.kill('SIGKILL'), 50000);
  const result = await Promise.race([finished.promise, exited.then(() => { throw Error('Host exited early: '+output.replace(/token=[\w-]+/g, 'token=[REDACTED]')); })]);
  const exit = await exited;
  clearTimeout(watchdog);
  console.log(JSON.stringify({ scenario, requests, result, exit, hostOutput: output.replace(/token=[\w-]+/g, 'token=[REDACTED]') }, null, 2));
  assert.equal(result.error, undefined);
  assert.equal(result.hmr, true);
  assert.equal(result.update.result.application, scenario === 'restore-disabled' ? 'failed' : 'applied');
  if (scenario === 'restore-disabled') assert.equal(result.update.restore.application, 'applied');
  assert.equal(result.final.version, scenario === 'restore-disabled' ? '1.0.0' : '2.0.0');
  assert.equal(result.final.enabled, ['disable-during-check', 'restore-disabled'].includes(scenario) ? false : scenario === 'enable-during-check' ? true : initialEnabled);

} finally {
  clearTimeout(watchdog);
  release.resolve();
  if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  if (server) {
    server.closeAllConnections();
    await new Promise(done => server.close(done));
  }
  await rm(root, { recursive: true, force: true });
}
