import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, writeFile, stat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const { withFileLock } = await import(pathToFileURL(join(resolve(process.env.DSH_PREFIX),
  'node_modules/@deepseek-ai/dsh-atomic-write/lib/index.js')));
const execute = promisify(execFile);
const child = fileURLToPath(new URL('./fixtures/atomic-lock-file-limit.mjs', import.meta.url));
const linux = { skip: process.platform !== 'linux' ? 'real RLIMIT_FSIZE/SIGXFSZ fixture requires Linux' : false };

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'atomic-lock-write-failure-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return join(root, 'data.json');
}

async function limitedWriter(filename) {
  // Positional arguments avoid interpolation; stdout stays a pipe so RLIMIT_FSIZE
  // cannot prevent the child from reporting its actual filesystem result.
  const { stdout, stderr } = await execute('bash', ['-c', 'ulimit -S -f 0; exec "$@"', '_',
    process.execPath, child, filename], { env: process.env });
  assert.equal(stderr, '');
  return JSON.parse(stdout);
}

test('real EFBIG while writing the acquired lock leaves no empty lock', linux, async t => {
  const filename = await fixture(t), result = await limitedWriter(filename);
  assert.equal(result.error.code, 'EFBIG');
  assert.equal(result.operations, 0);
  t.diagnostic(`kernel write failure: error=${result.error.code} lock=${JSON.stringify(result.lock ?? result.lockError)}`);
  assert.equal(result.lockError, 'ENOENT');
  await assert.rejects(stat(`${filename}.lock`), { code: 'ENOENT' });
});

test('a fresh caller can acquire after the actual failed writer exits', linux, async t => {
  const filename = await fixture(t), result = await limitedWriter(filename);
  assert.equal(result.error.code, 'EFBIG');
  let operations = 0;
  const value = await withFileLock(filename, () => { operations++; return 'recovered'; }, { waitMs: 0 });
  assert.equal(value, 'recovered');
  assert.equal(operations, 1);
  await assert.rejects(stat(`${filename}.lock`), { code: 'ENOENT' });
});

test('a size-limited contender does not remove another live writer lock', linux, async t => {
  const filename = await fixture(t);
  await withFileLock(filename, async () => {
    const before = await readFile(`${filename}.lock`, 'utf8');
    assert.equal(before, `${process.pid}\n`);
    const result = await limitedWriter(filename);
    assert.equal(result.operations, 0);
    assert.match(result.error.message, /timed out waiting for the writer lock/);
    assert.equal(result.lock.record, before);
    assert.equal(await readFile(`${filename}.lock`, 'utf8'), before);
  });
  await assert.rejects(stat(`${filename}.lock`), { code: 'ENOENT' });
});

test('an already-existing malformed legacy lock is still refused and preserved', async t => {
  const filename = await fixture(t);
  await writeFile(`${filename}.lock`, '');
  let operations = 0;
  await assert.rejects(withFileLock(filename, () => { operations++; }, { waitMs: 0 }), /timed out waiting for the writer lock/);
  assert.equal(operations, 0);
  assert.equal(await readFile(`${filename}.lock`, 'utf8'), '');
});

test('successful acquisition and operation rejection retain their cleanup contract', async t => {
  const filename = await fixture(t);
  assert.equal(await withFileLock(filename, () => 42), 42);
  const sentinel = new Error('operation failed');
  await assert.rejects(withFileLock(filename, () => { throw sentinel; }), error => error === sentinel);
  await assert.rejects(stat(`${filename}.lock`), { code: 'ENOENT' });
  assert.equal(await withFileLock(filename, () => 43), 43);
});
