// Real released-v3 codec, JSONL migration publisher, filesystem and native writer locks.
// Filesystem link/cleanup failures are controlled; no synthetic migration implementation.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { basename, dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { zstdCompressSync } from 'node:zlib';

if (!process.env.DSH_PREFIX) throw new Error('Set DSH_PREFIX to the locked patched runtime with its native system package');
const base = join(resolve(process.env.DSH_PREFIX), 'node_modules/@deepseek-ai');
const load = name => import(pathToFileURL(join(base, name, 'lib/index.js')));
const { Context } = await load('cordis');
const { Session } = await load('dsh-session');
const { createUserMessage } = await load('dsh-llm');
const { releasedV3SessionFormatCodec } = await load('dsh-session-format-v2-to-v3');
const { apply } = await load('dsh-session-persistence-jsonl');

const hooks = () => ({ validate: async () => {}, dispose: async () => {}, inspectTasks: async () => false, cleanup: async () => {} });
const message = 'historical transcript retained by the actual migration publisher';

async function fixture(t, compression, applyRuntime = apply) {
  const root = await fs.mkdtemp(join(tmpdir(), 'dsh-delete-migration-stage-'));
  const ctx = new Context();
  const handles = new Set();
  t.after(async () => {
    const fixtureFailures = [];
    const cleanup = async (stage, action) => {
      try { await action(); }
      catch (error) { fixtureFailures.push({ stage, error: String(error) }); }
    };
    await cleanup('restore mocks', () => t.mock.restoreAll());
    await cleanup('restore built-in exports', () => syncBuiltinESMExports());
    for (const handle of handles) await cleanup('close writer', () => handle.close());
    await cleanup('dispose context', () => ctx.fiber.dispose());
    await cleanup('remove fixture', () => fs.rm(root, { recursive: true, force: true }));
    // Node can retain the body failure over an after-hook error; report both explicitly.
    t.diagnostic(`fixtureFailures=${JSON.stringify(fixtureFailures)}`);
    assert.deepEqual(fixtureFailures, [], 'fixture cleanup must succeed');
  });
  const id = 'migration-stage-fixture';
  const session = Session.create(id);
  session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: message }],
    source: { kind: 'user', rpcId: 'historical-request' },
  }), { surfaceOp: 'append' });
  const header = { ...session.header, version: 3, delegationDepth: 0 };
  const headerBytes = Buffer.from(`${JSON.stringify(releasedV3SessionFormatCodec.encodeHeader(header, 0))}\n`);
  const eventBytes = Buffer.from(session.snapshotEvents()
    .map(event => JSON.stringify(releasedV3SessionFormatCodec.encodeEvent(event))).join('\n') + '\n');
  // The real Zstandard reader requires an independent, complete header frame.
  const original = compression === 'zstd'
    ? Buffer.concat([zstdCompressSync(headerBytes), zstdCompressSync(eventBytes)])
    : Buffer.concat([headerBytes, eventBytes]);
  const directory = join(root, '_no-cwd', id);
  const suffix = compression === 'zstd' ? '.jsonl.zstd' : '.jsonl';
  const source = join(directory, `session.v3${suffix}`);
  const current = join(directory, `session.v4${suffix}`);
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(source, original);
  await applyRuntime(ctx, { root, compression, listConcurrency: 1 });
  const storage = ctx.sessionPersistence;
  const openWriter = async () => {
    const handle = await storage.open(id, 'write');
    handles.add(handle);
    assert.equal(handle.header.version, 4);
    assert.ok(JSON.stringify((await handle.read()).events).includes(message));
    return handle;
  };
  const closeWriter = async handle => { await handle.close(); handles.delete(handle); };
  return { root, ctx, id, directory, source, current, original, storage, openWriter, closeWriter };
}

async function leaveCommittedStage(t, f) {
  const originalRm = fs.rm;
  const fault = Object.assign(new Error('controlled committed migration-stage unlink EIO'), { code: 'EIO' });
  const attempted = [];
  t.mock.method(fs, 'rm', async (path, ...args) => {
    const target = String(path);
    if (dirname(target) === f.directory && basename(target).startsWith('session.migration.')) {
      attempted.push(target);
      throw fault;
    }
    return originalRm(path, ...args);
  });
  syncBuiltinESMExports();
  let writer;
  try { writer = await f.openWriter(); }
  finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
  assert.equal(attempted.length, 1, 'the actual publisher attempts committed-stage cleanup once');
  const stage = attempted[0];
  assert.match(basename(stage), /^session\.migration\.[a-f0-9]{16}\.jsonl(?:\.zstd)?\.tmp$/);
  const bytes = await fs.readFile(stage);
  assert.deepEqual(bytes, await fs.readFile(f.current), 'the leftover is the actual committed transcript');
  const stageStat = await fs.stat(stage);
  const currentStat = await fs.stat(f.current);
  assert.equal(stageStat.dev, currentStat.dev);
  assert.equal(stageStat.ino, currentStat.ino, 'POSIX publication leaves a hard link when cleanup fails');
  assert.deepEqual(await fs.readFile(f.source), f.original);
  return { writer, stage, bytes };
}

async function absent(path, message) {
  await assert.rejects(fs.lstat(path), error => error.code === 'ENOENT', message);
}

for (const compression of ['none', 'zstd']) {
  test(`${compression}: historical write open survives an app-domain hard-link refusal`, { skip: process.platform === 'win32' }, async t => {
    const originalLink = fs.link;
    let denied = 0;
    // The bundled migration runtime captures link when the module is initialized.
    // Isolate that captured dependency; restore global fs before using the backend.
    fs.link = async () => {
      denied++;
      throw Object.assign(new Error('controlled migration link EACCES'), { code: 'EACCES' });
    };
    let applyDenied;
    try {
      syncBuiltinESMExports();
      ({ apply: applyDenied } = await import(pathToFileURL(join(base, 'dsh-session-persistence-jsonl/lib/index.js')).href
        + `?migration-link-refusal=${compression}`));
    } finally { fs.link = originalLink; syncBuiltinESMExports(); }
    const f = await fixture(t, compression, applyDenied);
    const writer = await f.openWriter();
    await f.closeWriter(writer);
    assert.equal(denied, 1, 'the actual historical publisher reached the refused link');
    assert.deepEqual(await fs.readFile(f.source), f.original);
    assert.equal((await fs.readdir(f.directory)).some(name => name.startsWith('session.migration.')), false);
    const reopened = await f.openWriter();
    await f.closeWriter(reopened);
    assert.equal(denied, 1, 'a later writer reads the committed current generation');
  });

  test(`${compression}: permanent deletion removes the real committed migration stage`, async t => {
    const f = await fixture(t, compression);
    const { writer, stage } = await leaveCommittedStage(t, f);
    await f.closeWriter(writer);
    const preserved = ['notes.md', `${basename(stage)}.keep`, 'session.migration.not-hex.jsonl.tmp'];
    for (const name of preserved) await fs.writeFile(join(f.directory, name), `keep ${name}\n`);
    await f.storage.dshGoDeletion.delete(f.id, hooks());
    assert.equal(f.storage.dshGoDeletion.deleted(f.id), true);
    await absent(f.source);
    await absent(f.current);
    await absent(stage, 'permanent deletion must remove the committed migration stage');
    for (const name of preserved) assert.equal(await fs.readFile(join(f.directory, name), 'utf8'), `keep ${name}\n`);
    assert.equal(await f.storage.stat(f.id), undefined);
    await assert.rejects(f.storage.open(f.id, 'write'), { name: 'SessionPersistenceNotFoundError' });
  });

  test(`${compression}: ordinary migration and deletion retain their behavior`, async t => {
    const f = await fixture(t, compression);
    const writer = await f.openWriter();
    await f.closeWriter(writer);
    assert.equal((await fs.readdir(f.directory)).some(name => name.startsWith('session.migration.')), false);
    assert.deepEqual(await fs.readFile(f.source), f.original);
    await f.storage.dshGoDeletion.delete(f.id, hooks());
    assert.equal(f.storage.dshGoDeletion.deleted(f.id), true);
    await absent(f.source);
    await absent(f.current);
  });

  test(`${compression}: a live writer prevents deletion of its committed stage and logs`, async t => {
    const f = await fixture(t, compression);
    const { writer, stage, bytes } = await leaveCommittedStage(t, f);
    await assert.rejects(f.storage.dshGoDeletion.delete(f.id, hooks()), { name: 'SessionAlreadyOwnedError' });
    assert.equal(f.storage.dshGoDeletion.deleted(f.id), false);
    assert.equal(f.storage.dshGoDeletion.pending.has(f.id), false);
    assert.deepEqual(await fs.readFile(f.source), f.original);
    assert.deepEqual(await fs.readFile(f.current), bytes);
    assert.deepEqual(await fs.readFile(stage), bytes);
    await f.closeWriter(writer);
  });

  test(`${compression}: a symlink at a real migration-stage name is refused before the tombstone`, async t => {
    const f = await fixture(t, compression);
    const { writer, stage, bytes } = await leaveCommittedStage(t, f);
    await f.closeWriter(writer);
    const outside = join(f.root, 'outside-log-directory.txt');
    await fs.writeFile(outside, 'unrelated file must survive\n');
    await fs.rm(stage);
    await fs.symlink(outside, stage);
    await assert.rejects(f.storage.dshGoDeletion.delete(f.id, hooks()), error => error.code === 'failed',
      'a migration-stage symlink must block deletion before the tombstone');
    assert.equal(f.storage.dshGoDeletion.deleted(f.id), false);
    assert.equal(f.storage.dshGoDeletion.pending.has(f.id), false);
    assert.deepEqual(await fs.readFile(f.source), f.original);
    assert.deepEqual(await fs.readFile(f.current), bytes);
    assert.equal((await fs.lstat(stage)).isSymbolicLink(), true);
    assert.equal(await fs.readFile(outside, 'utf8'), 'unrelated file must survive\n');
  });
}
