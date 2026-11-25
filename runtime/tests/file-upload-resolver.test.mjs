// Real locked Host/public fileUploads API; no Agent or Connection stand-ins. Boots a Host, so the
// prefix must be built for this machine (runtime/.work/x86_64/dsh-prefix on an x86_64 host):
// DSH_TEST_PREFIX=/absolute/prefix node --test runtime/tests/file-upload-resolver.test.mjs
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const prefix = process.env.DSH_TEST_PREFIX ?? process.env.DSH_PREFIX;
assert.ok(prefix, 'set DSH_TEST_PREFIX to the locked, patched DSH npm prefix');
const require = createRequire(join(resolve(prefix), 'package.json'));
const cliPackage = require.resolve('@deepseek-ai/dsh/package.json');
assert.equal(JSON.parse(await readFile(cliPackage)).version, '0.2.2-rc.1');
const cli = join(dirname(cliPackage), 'lib/bin.js');
const observer = fileURLToPath(new URL('./file-upload-resolver-observer.mjs', import.meta.url));

test('public resolver disposal frees registration and an old disposer cannot clear a replacement', { timeout: 70_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'file-upload-resolver-'));
  const home = join(directory, 'home'), workspace = join(directory, 'workspace');
  await mkdir(home, { mode: 0o700 });
  await mkdir(workspace, { mode: 0o700 });
  const disabled = ['session-controller', 'session-title-llm', 'session-telemetry-otel',
    'desktop-product-telemetry', 'llm-pi-ai', 'llm-deepseek-account',
    'web-search-deepseek', 'web-deepseek-api', 'web-fetch-http', 'tool-web'];
  const patch = disabled.map(id => ({ id, disabled: true }));
  patch.push({ id: 'credentials', config: { path: join(home, '.credentials.yaml') } },
    { id: 'session-persistence-jsonl', config: { root: join(home, 'sessions'), compression: 'none' } },
    { insert: [{ id: 'file-upload-resolver-observer', name: observer }] });
  const patchPath = join(directory, 'profile.patch.json');
  await writeFile(patchPath, JSON.stringify(patch, null, 2));
  const env = Object.fromEntries(['PATH', 'LANG', 'LC_ALL', 'TMPDIR'].filter(key => process.env[key]).map(key => [key, process.env[key]]));
  Object.assign(env, { TZ: 'Asia/Shanghai', HOME: home, DSH_HOME: home, DSH_TELEMETRY_DISABLED: '1' });
  const argv = ['--import', observer, cli, '--profile', 'web', '--patch', patchPath,
    '--host', '127.0.0.1', '--port', '0', '--no-open'];
  const child = spawn(process.execPath, argv, { cwd: workspace, env, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  let stderr = '', forced = false;
  child.stdout.resume();
  child.stderr.on('data', bytes => { stderr += bytes; });
  const closed = once(child, 'close');
  const observed = new Promise(resolveResult => child.on('message', message => {
    if (message?.kind === 'resolver-result') resolveResult(message);
  }));
  // Failure protection only: no normal path waits for a timer.
  const protection = setTimeout(() => { forced = true; child.kill('SIGKILL'); }, 60_000);
  try {
    const result = await Promise.race([observed, closed.then(exit => {
      throw new Error('Host exited before the public registration result: ' + JSON.stringify(exit) + '\n' + stderr);
    })]);
    assert.equal(result.passed, true, JSON.stringify(result, null, 2));
    assert.deepEqual(result.steps, ['registered-A', 'duplicate-A-rejected', 'disposed-A',
      'registered-B', 'old-A-cannot-clear-B', 'registered-C-after-disposed-B']);
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    const exit = await closed;
    clearTimeout(protection);
    await rm(directory, { recursive: true, force: true });
    assert.equal(forced, false, 'Host cleanup must not require the failure deadline');
    assert.deepEqual(exit, [0, null], 'Host must shut down normally\n' + stderr);
  }
});
