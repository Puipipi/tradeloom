import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { fork, execFile } from 'node:child_process';
import { once } from 'node:events';
import { promisify } from 'node:util';
import { mkdtemp, readFile, writeFile, stat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const { withFileLock } = await import(pathToFileURL(join(resolve(process.env.DSH_PREFIX),
  'node_modules/@deepseek-ai/dsh-atomic-write/lib/index.js')));
const execute = promisify(execFile);
const worker = fileURLToPath(new URL('./fixtures/atomic-claim-worker.mjs', import.meta.url));
const linux = { skip: process.platform !== 'linux' ? 'real RLIMIT_FSIZE/SIGXFSZ requires Linux' : false };

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'atomic-claim-write-failure-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return join(directory, 'data.json');
}

async function hold(t, filename, mode) {
  const child = fork(worker, [mode, filename], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk; });
  const exited = once(child, 'exit');
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await exited;
  });
  const gate = await Promise.race([
    once(child, 'message').then(([value]) => value),
    exited.then(() => { throw new Error(`holder exited before gate: ${stderr}`); }),
  ]);
  assert.equal(gate.type, mode === 'hold-main' ? 'main-held' : 'claim-held');
  return { child, exited, stderr: () => stderr };
}

async function killHolder(holder) {
  holder.child.kill('SIGKILL');
  const [code, signal] = await holder.exited;
  assert.equal(code, null);
  assert.equal(signal, 'SIGKILL');
  assert.equal(holder.stderr(), '');
  assert.throws(() => process.kill(holder.child.pid, 0), { code: 'ESRCH' });
}

async function deadLock(t, filename) {
  const holder = await hold(t, filename, 'hold-main');
  const record = await readFile(`${filename}.lock`, 'utf8');
  assert.equal(record, `${holder.child.pid}\n`);
  await killHolder(holder);
  const claim = `${filename}.lock.takeover-${createHash('sha256').update(record).digest('hex').slice(0, 16)}`;
  return { record, claim };
}

async function limitedWriter(filename) {
  const { stdout, stderr } = await execute('bash', ['-c', 'ulimit -S -f 0; exec "$@"', '_',
    process.execPath, worker, 'fail-claim', filename], { env: process.env });
  assert.equal(stderr, '');
  return JSON.parse(stdout);
}

test('EFBIG writing a newly acquired claim removes only that claim and retains the dead lock', linux, async t => {
  const filename = await fixture(t), { record, claim } = await deadLock(t, filename);
  const result = await limitedWriter(filename);
  assert.equal(result.error.code, 'EFBIG');
  assert.equal(result.operations, 0);
  assert.equal(await readFile(`${filename}.lock`, 'utf8'), record);
  const observed = await stat(claim).then(value => ({ size: value.size }), error => ({ code: error.code }));
  t.diagnostic(`kernel=${result.error.code} claim=${JSON.stringify(observed)}`);
  assert.deepEqual(observed, { code: 'ENOENT' });
});

test('a later unlimited writer can recover after actual claim write failure', linux, async t => {
  const filename = await fixture(t), { claim } = await deadLock(t, filename);
  assert.equal((await limitedWriter(filename)).error.code, 'EFBIG');
  let operations = 0;
  assert.equal(await withFileLock(filename, () => { operations++; return 42; }, { waitMs: 0 }), 42);
  assert.equal(operations, 1);
  await assert.rejects(stat(claim), { code: 'ENOENT' });
  await assert.rejects(stat(`${filename}.lock`), { code: 'ENOENT' });
});

test('a live claimant keeps its existing claim and the old lock while another contender is refused', async t => {
  const filename = await fixture(t), { record, claim } = await deadLock(t, filename);
  const holder = await hold(t, filename, 'hold-claim');
  const before = await readFile(claim, 'utf8');
  assert.equal(before, `${holder.child.pid}\n`);
  let operations = 0;
  await assert.rejects(withFileLock(filename, () => { operations++; }, { waitMs: 0 }), /timed out waiting for the writer lock/);
  assert.equal(operations, 0);
  assert.equal(await readFile(claim, 'utf8'), before);
  assert.equal(await readFile(`${filename}.lock`, 'utf8'), record);
});

test('a previously killed claimant is still not automatically reclaimed', async t => {
  const filename = await fixture(t), { record, claim } = await deadLock(t, filename);
  const holder = await hold(t, filename, 'hold-claim');
  const before = await readFile(claim, 'utf8');
  assert.equal(before, `${holder.child.pid}\n`);
  await killHolder(holder);
  let operations = 0;
  for (let attempt = 0; attempt < 2; attempt++) {
    await assert.rejects(withFileLock(filename, () => { operations++; }, { waitMs: 0 }), /timed out waiting for the writer lock/);
  }
  assert.equal(operations, 0);
  assert.equal(await readFile(claim, 'utf8'), before);
  assert.equal(await readFile(`${filename}.lock`, 'utf8'), record);
});

test('an existing empty legacy claim is not deleted by an unsuccessful exclusive open', async t => {
  const filename = await fixture(t), { record, claim } = await deadLock(t, filename);
  await writeFile(claim, '', { flag: 'wx' });
  await assert.rejects(withFileLock(filename, () => assert.fail('must not acquire'), { waitMs: 0 }), /timed out waiting for the writer lock/);
  assert.equal(await readFile(claim, 'utf8'), '');
  assert.equal(await readFile(`${filename}.lock`, 'utf8'), record);
});

test('normal dead-holder takeover preserves result, mode, release, and the operation error identity', async t => {
  const filename = await fixture(t), { claim } = await deadLock(t, filename);
  const error = new Error('operation rejected');
  await assert.rejects(withFileLock(filename, async () => {
    assert.equal(await readFile(`${filename}.lock`, 'utf8'), `${process.pid}\n`);
    assert.equal((await stat(`${filename}.lock`)).mode & 0o777, 0o600);
    throw error;
  }, { waitMs: 0 }), value => value === error);
  await assert.rejects(stat(claim), { code: 'ENOENT' });
  await assert.rejects(stat(`${filename}.lock`), { code: 'ENOENT' });
  assert.equal(await withFileLock(filename, () => 7, { waitMs: 0 }), 7);
});

test('a live main lock never enters claim acquisition', async t => {
  const filename = await fixture(t);
  const holder = await hold(t, filename, 'hold-main');
  const before = await readFile(`${filename}.lock`, 'utf8');
  assert.equal(before, `${holder.child.pid}\n`);
  await assert.rejects(withFileLock(filename, () => assert.fail('must not acquire'), { waitMs: 0 }), /timed out waiting for the writer lock/);
  assert.equal(await readFile(`${filename}.lock`, 'utf8'), before);
});
