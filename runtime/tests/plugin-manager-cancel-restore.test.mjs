import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const prefix = resolve(process.env.DSH_PREFIX);
const { PluginManager } = await import(pathToFileURL(join(prefix, 'node_modules/@deepseek-ai/dsh-plugin-manager/lib/index.js')));

// The manager's install/change/cancel/read/restore methods are real. Only the
// surrounding context, registry discovery and package-manager run are peers.
// No package-manager process, signal delivery or network request is needed.
async function fixture(t, { abortDiagnostic = false, failStop = false } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'plugin-cancel-restore-'));
  const pending = [];
  let manager;
  t.after(async () => {
    manager?.abort.abort();
    await Promise.allSettled(pending);
    await rm(dir, { recursive: true, force: true });
  });
  const manifest = join(dir, 'package.json');
  const lockfile = join(dir, 'pnpm-lock.yaml');
  const originalManifest = JSON.stringify({ name: 'test-profile', version: '1.0.0', dependencies: {}, dsh: { profile: { bundles: [] } } }) + '\n';
  const originalLockfile = "lockfileVersion: '9.0'\n";
  const changedManifest = JSON.stringify({ name: 'test-profile', version: '1.0.0', dependencies: { 'fixture-package': '1.0.0' }, dsh: { profile: { bundles: [] } } }) + '\n';
  await writeFile(manifest, originalManifest);
  await writeFile(lockfile, originalLockfile);
  const entered = Promise.withResolvers();
  const facts = { runs: 0, stops: 0, releases: 0 };
  const stopError = new Error('fixture: package stop unconfirmed');
  manager = Object.assign(Object.create(PluginManager.prototype), {
    profile: { dir, name: 'test', home: dir, cwd: dir, installAnchor: join(prefix, 'package.json') },
    abort: new AbortController(),
    installs: new Map(),
    packageOperations: new Set(),
    lockWaitMs: 1000,
    outputBytes: 4096,
    ownerContext: { get: () => undefined, emit() {}, async parallel() {} },
    async registries() { return { registry: null, resolved: null, fallbackRegistries: [] }; },
    async runPnpm(args, signal, requestId, runs) {
      assert.deepEqual(args, ['add', 'fixture-package@1.0.0']);
      assert.equal(requestId, 'restore-test');
      facts.runs++;
      // This explicit run peer tests outer stop/restore ordering, not
      // ownedRunGuard or actual process groups.
      const run = {
        failure: undefined,
        async stop() {
          facts.stops++;
          if (failStop) { run.failure = stopError; throw stopError; }
        },
        async release() { facts.releases++; },
      };
      runs.push(run);
      await writeFile(manifest, changedManifest);
      await writeFile(lockfile, 'changed by package-manager peer\n');
      const lifetime = AbortSignal.any([signal, manager.abort.signal]);
      const stopped = lifetime.aborted ? Promise.resolve() : new Promise(resolve => lifetime.addEventListener('abort', resolve, { once: true }));
      entered.resolve();
      await stopped;
      if (abortDiagnostic) throw new Error('fixture: package-manager abort diagnostic');
      return { exitCode: 0, output: '' };
    },
  });
  const start = () => {
    const installation = manager.installBundle('fixture-package@1.0.0', { requestId: 'restore-test' });
    pending.push(installation);
    installation.catch(() => {});
    return installation;
  };
  const waitForRun = installation => Promise.race([
    entered.promise,
    installation.then(() => { throw new Error('installation settled before reaching the run peer'); }),
  ]);
  const cancel = () => manager.cancelInstall('restore-test').then(value => ({ value }), error => ({ error }));
  return { manager, manifest, lockfile, originalManifest, originalLockfile, changedManifest, facts, stopError, start, waitForRun, cancel };
}

test('cancel rejects when the real lockfile restoration fails after a confirmed stop', { timeout: 10000 }, async t => {
  const f = await fixture(t);
  const installation = f.start();
  await f.waitForRun(installation);
  // The actual snapshot already contains both original files. Change only
  // this test's restoration target so real atomic rename must fail.
  await rm(f.lockfile);
  await mkdir(f.lockfile);
  const [result, receipt] = await Promise.all([installation, f.cancel()]);
  assert.equal(result.application, 'failed');
  assert.ok(receipt.error instanceof Error, 'must not acknowledge restored files');
  assert.equal(receipt.error.syscall, 'rename');
  assert.equal(receipt.error.dest, f.lockfile);
  assert.equal(receipt.error.message, result.error.diagnostic);
  assert.equal(await readFile(f.manifest, 'utf8'), f.originalManifest);
  assert.equal((await stat(f.lockfile)).isDirectory(), true, 'the second original file was not restored');
  assert.deepEqual(f.facts, { runs: 1, stops: 1, releases: 1 });
  assert.equal(f.manager.installs.size, 0);
});

test('a package abort diagnostic still permits cancellation after successful restoration', { timeout: 10000 }, async t => {
  const f = await fixture(t, { abortDiagnostic: true });
  const installation = f.start();
  await f.waitForRun(installation);
  const [result, receipt] = await Promise.all([installation, f.cancel()]);
  assert.equal(result.application, 'failed', 'the existing operation-error folding is unchanged');
  assert.deepEqual(receipt, { value: { status: 'cancelled' } });
  assert.equal(await readFile(f.manifest, 'utf8'), f.originalManifest);
  assert.equal(await readFile(f.lockfile, 'utf8'), f.originalLockfile);
  assert.deepEqual(f.facts, { runs: 1, stops: 1, releases: 1 });
});

test('an unconfirmed stop still prevents restoration and is returned by cancellation', { timeout: 10000 }, async t => {
  const f = await fixture(t, { failStop: true });
  const installation = f.start();
  await f.waitForRun(installation);
  const [result, receipt] = await Promise.all([installation, f.cancel()]);
  assert.equal(result.application, 'failed');
  assert.equal(receipt.error, f.stopError);
  assert.equal(await readFile(f.manifest, 'utf8'), f.changedManifest);
  assert.equal(await readFile(f.lockfile, 'utf8'), 'changed by package-manager peer\n');
  assert.deepEqual(f.facts, { runs: 1, stops: 1, releases: 0 });
});

test('cancellation before the operation starts needs no fictitious restoration', { timeout: 10000 }, async t => {
  const f = await fixture(t);
  const installation = f.start();
  const [result, receipt] = await Promise.all([installation, f.cancel()]);
  assert.equal(result.application, 'cancelled');
  assert.deepEqual(receipt, { value: { status: 'cancelled' } });
  assert.equal(await readFile(f.manifest, 'utf8'), f.originalManifest);
  assert.equal(await readFile(f.lockfile, 'utf8'), f.originalLockfile);
  assert.deepEqual(f.facts, { runs: 0, stops: 0, releases: 0 });
});
