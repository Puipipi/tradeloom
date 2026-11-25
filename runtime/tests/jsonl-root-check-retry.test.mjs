// Real rc4 backend and temporary files; only the filesystem error boundary is controlled.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
const base = join(resolve(process.env.DSH_PREFIX), 'node_modules/@deepseek-ai');
const load = name => import(pathToFileURL(join(base, name, 'lib/index.js')));
const { Context } = await load('cordis');
const { Session } = await load('dsh-session');
const { apply } = await load('dsh-session-persistence-jsonl');

async function fixture(t, compression = 'none') {
  const root = await fs.mkdtemp(join(tmpdir(), 'jsonl-root-check-'));
  const ctx = new Context();
  await apply(ctx, { root, compression, listConcurrency: 1 });
  t.after(async () => {
    t.mock.restoreAll(); syncBuiltinESMExports();
    await ctx.fiber.dispose();
    await fs.rm(root, { recursive: true, force: true });
  });
  return { root, ctx, backend: ctx.sessionPersistence };
}
function rootReads(t, root, callback) {
  const original = fs.readdir;
  let calls = 0;
  t.mock.method(fs, 'readdir', async (path, ...args) => {
    if (String(path) === root) { calls++; await callback(calls); }
    return original(path, ...args);
  });
  syncBuiltinESMExports();
  return () => calls;
}
const ioFailure = label => Object.assign(new Error(label), { code: 'EIO' });

for (const compression of ['none', 'zstd']) {
  test(`${compression}: one failed root scan does not poison a later explicit create`, async t => {
    const { root, backend } = await fixture(t, compression);
    const error = ioFailure('SYNTHETIC_INITIAL_SCAN');
    rootReads(t, root, count => { if (count === 1) throw error; });
    const header = Session.create('root-scan').header;
    await assert.rejects(backend.create(header), actual => actual === error);
    assert.deepEqual(await fs.readdir(root), [], 'failed scan must not materialize a session');
    const handle = await backend.create(header);
    await handle.flush();
    await handle.close();
    const reopened = await backend.open(header.id, 'read');
    assert.equal(reopened.header.id, header.id);
    assert.deepEqual((await reopened.read()).events, []);
    await reopened.close();
  });
}

test('each failed explicit operation propagates its own current I/O error', async t => {
  const { root, backend } = await fixture(t);
  const errors = [ioFailure('SYNTHETIC_FIRST'), ioFailure('SYNTHETIC_SECOND')];
  const count = rootReads(t, root, n => { throw errors[Math.min(n - 1, 1)]; });
  const id = Session.create('failed-stat').id;
  await assert.rejects(backend.stat(id), error => error === errors[0]);
  await assert.rejects(backend.stat(id), error => error === errors[1]);
  assert.equal(count(), 2);
});

test('successful root validation remains memoized for pending-session stat', async t => {
  const { root, backend } = await fixture(t);
  const count = rootReads(t, root, () => {});
  const header = Session.create('pending-stat').header;
  const handle = await backend.create(header);
  const before = count();
  for (let i = 0; i < 5; i++) assert.equal((await backend.stat(header.id)).header.id, header.id);
  assert.equal(count(), before, 'successful scan is not repeated');
  await handle.close();
});

test('concurrent callers share the failed scan and a later caller can retry', async t => {
  const { root, backend } = await fixture(t);
  let release, entered;
  const started = new Promise(resolve => { entered = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const error = ioFailure('SYNTHETIC_SHARED_SCAN');
  const count = rootReads(t, root, async n => { if (n === 1) { entered(); await gate; throw error; } });
  const first = backend.stat(Session.create('first-stat').id);
  const second = backend.stat(Session.create('second-stat').id);
  const observed = Promise.allSettled([first, second]);
  await started;
  assert.equal(count(), 1);
  release();
  for (const result of await observed) { assert.equal(result.status, 'rejected'); assert.equal(result.reason, error); }
  assert.equal(count(), 1, 'no automatic retry for either failed operation');
  assert.equal(await backend.stat(Session.create('later-stat').id), undefined);
  assert.ok(count() > 1, 'later explicit request really retries filesystem checks');
});


test('persistent opposite-encoding artifacts still reject every explicit check', async t => {
  const { root, backend: writer, ctx: writerCtx } = await fixture(t, 'zstd');
  const header = Session.create('opposite-encoding').header;
  const handle = await writer.create(header);
  await handle.flush(); await handle.close(); await writerCtx.fiber.dispose();
  const ctx = new Context();
  await apply(ctx, { root, compression: 'none', listConcurrency: 1 });
  t.after(() => ctx.fiber.dispose());
  const path = join(root, '_no-cwd', header.id, 'session.v4.jsonl.zstd');
  const before = await fs.readFile(path);
  for (let i = 0; i < 2; i++) await assert.rejects(ctx.sessionPersistence.stat(header.id), /configured for compression/);
  assert.deepEqual(await fs.readFile(path), before, 'refusal neither removes nor converts the opposite artifact');
});
