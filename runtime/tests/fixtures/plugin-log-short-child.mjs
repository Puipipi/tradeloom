import { mkdtemp, writeFile, readFile, rm, mkdir, readdir, readlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
process.on('SIGXFSZ', () => {});
const prefix = resolve(process.env.DSH_PREFIX);
const entry = process.argv[2];
const dir = await mkdtemp(join(tmpdir(), 'plugin-log-short-'));
let ctx;
try {
  await writeFile(join(dir, 'package.json'), JSON.stringify({ name: 'own-profile', version: '1.0.0', dependencies: {}, dsh: { profile: { bundles: [] } } }));
  const bundle = join(dir, 'own-bundle');
  await mkdir(bundle);
  const manifest = { name: 'own-short-log', version: '1.0.0', dsh: { bundle: { patch: 'cordis.patch.yml' } } };
  await writeFile(join(bundle, 'package.json'), JSON.stringify(manifest));
  await writeFile(join(bundle, 'cordis.patch.yml'), '[]');
  const script = join(dir, 'own-manager.mjs');
  // The configured, local package manager performs only these temporary file writes.
  await writeFile(script, `import {writeSync,readFileSync,writeFileSync,mkdirSync} from 'node:fs';import{join}from'node:path';
const dir=process.cwd();const p=JSON.parse(readFileSync(join(dir,'package.json'),'utf8'));p.dependencies={'own-short-log':'file:'+${JSON.stringify(bundle)}};writeFileSync(join(dir,'package.json'),JSON.stringify(p));mkdirSync(join(dir,'node_modules/own-short-log'),{recursive:true});writeFileSync(join(dir,'node_modules/own-short-log/package.json'),${JSON.stringify(JSON.stringify(manifest))});writeFileSync(join(dir,'node_modules/own-short-log/cordis.patch.yml'),'[]');writeSync(1,Buffer.alloc(8192,65));`);
  const profile = { name: 'own', dir, home: dir, cwd: dir, patchPath: join(dir, 'cordis.patch.yml'), overlays: [], telemetryDisabledEnv: '1', installAnchor: join(prefix, 'package.json'), startedBundles: [], packageManager: { command: process.execPath, args: [script] } };
  let output = '', result, change, error;
  try {
    if (entry === 'service') {
      const main = join(dir, 'main.json');
      await writeFile(main, JSON.stringify([{ id: 'manager', name: pathToFileURL(join(prefix, 'node_modules/@deepseek-ai/dsh-plugin-manager/lib/index.js')).href, config: { registry: 'https://fixture.invalid', fallbackRegistries: [] } }]));
      const { boot } = await import(pathToFileURL(join(prefix, 'node_modules/@deepseek-ai/dsh-app-boot/lib/index.js')));
      ctx = await boot('dsh', main, [], c => c.provide('profileContext', profile));
      ctx.on('plugin-manager/install-log', event => output += event.text);
      change = await ctx.pluginManager.installBundle(bundle, { enabled: false });
      result = change.packageResult;
    } else {
      const { runPluginCommand } = await import(pathToFileURL(join(prefix, 'node_modules/@deepseek-ai/dsh-plugin-manager/lib/types/operations.js')));
      result = await runPluginCommand({ ...profile, profile: profile.name }, ['--version'], { ...profile.packageManager, execution: 'service', outputBytes: 16384, onOutput: text => output += text, activateNewBundles: false });
    }
  } catch (e) { error = { code: e.code, message: e.message }; }
  await ctx?.fiber.dispose();
  ctx = undefined;
  const logsRoot = join(dir, '.plugin-manager/logs');
  const logs = await readdir(logsRoot);
  const logPath = result?.logPath ?? join(logsRoot, logs.find(name => name.startsWith('operation-')), 'pnpm.log');
  const disk = await readFile(logPath);
  const ownOpenLogFds = [];
  for (const fd of await readdir('/proc/self/fd')) {
    const target = await readlink('/proc/self/fd/' + fd).catch(() => '');
    if (target.startsWith(dir + '/') && target.endsWith('.log')) ownOpenLogFds.push(fd);
  }
  console.log(JSON.stringify({ entry, application: change?.application, managementError: change?.error, error, hasPackageResult: !!result,
    packageExit: result?.exitCode, returnedBytes: result ? Buffer.byteLength(result.output) : undefined,
    eventBytes: Buffer.byteLength(output), diskBytes: disk.length, diskExact: disk.equals(Buffer.alloc(8192, 65)), truncated: result?.truncated,
    ownOpenLogFds, installedModuleRemains: await readFile(join(dir, 'node_modules/own-short-log/package.json'), 'utf8').then(() => true, () => false) }));
} finally {
  await ctx?.fiber.dispose();
  await rm(dir, { recursive: true, force: true });
}
