// Exercise the real pinned npm provider, including its probe/guard/publication path.
// DSH_TEST_PREFIX=/path/to/dsh-prefix node --test --test-isolation=none runtime/tests/fs-create-exclusive.test.mjs
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile, open, link } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, test } from 'node:test';

const require = createRequire(join(resolve(process.env.DSH_TEST_PREFIX ?? process.cwd()), 'package.json'));
const { Context } = await import(pathToFileURL(require.resolve('@deepseek-ai/cordis')));
const { LocalFileSystem } = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-fs-local')));
const errno = (code) => Object.assign(new Error(`injected ${code}`), { code });
const unsupported = ['EACCES', 'EPERM', 'EXDEV', 'ENOTSUP', 'EMLINK'];
let directory;
let contexts;
let fs;

async function provider() {
  const ctx = new Context();
  contexts.push(ctx);
  await ctx.plugin(LocalFileSystem, { cwd: directory });
  return ctx.fs;
}

async function noStaging() {
  assert.deepEqual((await readdir(directory)).filter((name) => name.endsWith('.tmpdir')), []);
}

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'dsh-exclusive-'));
  contexts = [];
  fs = await provider();
});

afterEach(async () => {
  for (const ctx of contexts) await ctx.fiber.dispose();
  await rm(directory, { recursive: true, force: true });
});

for (const code of unsupported) {
  test(`creates UTF-8 text when hard links fail with ${code}`, async () => {
    fs.internals.linkFile = async () => { throw errno(code); };
    const target = await fs.resolve('new.txt');
    const outcome = await fs.writeText(target, 'hello 世界\r\n', { kind: 'createIfAbsent' });
    assert.equal(outcome.operation, 'create');
    assert.equal(await readFile(target.targetKey, 'utf8'), 'hello 世界\r\n');
    assert.equal((await stat(target.targetKey)).mode & 0o777, 0o600);
    await noStaging();
  });

  test(`preserves a competing creator after ${code}`, async () => {
    const target = await fs.resolve('new.txt');
    fs.internals.linkFile = async () => {
      await writeFile(target.targetKey, 'competitor', { flag: 'wx' });
      throw errno(code);
    };
    await assert.rejects(fs.writeText(target, 'ours', { kind: 'createIfAbsent' }), { code: 'FS_NOT_OBSERVED' });
    assert.equal(await readFile(target.targetKey, 'utf8'), 'competitor');
    await noStaging();
  });
}

test('existing targets fail before publication and retain their bytes', async () => {
  const target = await fs.resolve('existing.txt');
  await writeFile(target.targetKey, 'keep');
  fs.internals.linkFile = async () => { assert.fail('publication must not run'); };
  await assert.rejects(fs.writeText(target, 'ours', { kind: 'createIfAbsent' }), { code: 'FS_NOT_OBSERVED' });
  assert.equal(await readFile(target.targetKey, 'utf8'), 'keep');
});

test('a dangling symlink created after the probe is not followed or removed', async () => {
  const target = await fs.resolve('new.txt');
  const referent = join(directory, 'missing');
  fs.internals.linkFile = async () => {
    await symlink(referent, target.targetKey);
    throw errno('EPERM');
  };
  await assert.rejects(fs.writeText(target, 'ours', { kind: 'createIfAbsent' }), { code: 'FS_NOT_REGULAR_FILE' });
  await assert.rejects(readFile(referent), { code: 'ENOENT' });
  assert.ok((await readdir(directory)).includes('new.txt'));
  await noStaging();
});

test('a symlink created after the probe never overwrites its existing referent', async () => {
  const target = await fs.resolve('new.txt');
  const referent = join(directory, 'precious');
  await writeFile(referent, 'keep');
  fs.internals.linkFile = async () => {
    await symlink(referent, target.targetKey);
    throw errno('EPERM');
  };
  await assert.rejects(fs.writeText(target, 'ours', { kind: 'createIfAbsent' }), { code: 'FS_NOT_REGULAR_FILE' });
  assert.equal(await readFile(referent, 'utf8'), 'keep');
  await noStaging();
});

test('two independent providers racing to create have one winner', async () => {
  const other = await provider();
  let arrived = 0;
  let release;
  const barrier = new Promise((resolve) => { release = resolve; });
  const failLink = async () => {
    if (++arrived === 2) release();
    await barrier;
    throw errno('EPERM');
  };
  fs.internals.linkFile = other.internals.linkFile = failLink;
  const target = await fs.resolve('race.txt');
  const results = await Promise.allSettled([
    fs.writeText(target, 'one', { kind: 'createIfAbsent' }),
    other.writeText(target, 'two', { kind: 'createIfAbsent' }),
  ]);
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  assert.equal(results.find((result) => result.status === 'rejected').reason.code, 'FS_NOT_OBSERVED');
  assert.ok(['one', 'two'].includes(await readFile(target.targetKey, 'utf8')));
  await noStaging();
});

for (const code of ['EIO', 'ENOSPC', 'ENOENT', 'EEXIST', 'EOPNOTSUPP']) {
  test(`does not fall back for ${code}`, async () => {
    const failure = errno(code);
    fs.internals.linkFile = async () => { throw failure; };
    fs.internals.openPublicationFile = async () => { assert.fail('exclusive fallback must not run'); };
    const target = await fs.resolve('new.txt');
    await assert.rejects(fs.writeText(target, 'ours', { kind: 'createIfAbsent' }), {
      code: code === 'EEXIST' ? 'FS_NOT_OBSERVED' : 'FS_IO_ERROR', cause: failure,
    });
    await assert.rejects(stat(target.targetKey), { code: 'ENOENT' });
    await noStaging();
  });
}

test('exclusive creation still reports its own permission failure after link EACCES', async () => {
  const target = await fs.resolve('new.txt');
  const failure = errno('EACCES');
  let attempted = false;
  fs.internals.linkFile = async () => { throw errno('EACCES'); };
  fs.internals.openPublicationFile = async () => { attempted = true; throw failure; };
  await assert.rejects(fs.writeText(target, 'ours', { kind: 'createIfAbsent' }), {
    code: 'FS_IO_ERROR', cause: failure,
  });
  assert.equal(attempted, true);
  await assert.rejects(stat(target.targetKey), { code: 'ENOENT' });
  await noStaging();
});

test('abort between link failure and exclusive open does not create a target', async () => {
  const abort = new AbortController();
  fs.internals.linkFile = async () => {
    abort.abort();
    throw errno('EPERM');
  };
  const target = await fs.resolve('new.txt');
  await assert.rejects(fs.writeText(target, 'ours', { kind: 'createIfAbsent' }, abort.signal), { code: 'FS_ABORTED' });
  await assert.rejects(stat(target.targetKey), { code: 'ENOENT' });
  await noStaging();
});

test('partial write failure closes the descriptor, keeps the incomplete file, and rejects blind retry', async () => {
  const target = await fs.resolve('new.txt');
  const failure = errno('ENOSPC');
  let handle;
  fs.internals.linkFile = async () => { throw errno('EPERM'); };
  fs.internals.openPublicationFile = async (...args) => {
    handle = await open(...args);
    handle.writeFile = async () => {
      await handle.write('part');
      throw failure;
    };
    return handle;
  };
  await assert.rejects(fs.writeText(target, 'full content', { kind: 'createIfAbsent' }), {
    code: 'FS_IO_ERROR', cause: failure, message: /may be incomplete/,
  });
  assert.equal(handle.fd, -1);
  assert.equal(await readFile(target.targetKey, 'utf8'), 'part');
  await assert.rejects(fs.writeText(target, 'retry', { kind: 'createIfAbsent' }), { code: 'FS_NOT_OBSERVED' });
  await noStaging();
});

test('failure after another writer replaces the target never deletes that replacement', async () => {
  const target = await fs.resolve('new.txt');
  fs.internals.linkFile = async () => { throw errno('EPERM'); };
  fs.internals.openPublicationFile = async (...args) => {
    const handle = await open(...args);
    handle.writeFile = async () => {
      await handle.write('part');
      await rm(target.targetKey);
      await writeFile(target.targetKey, 'replacement', { flag: 'wx' });
      throw errno('EIO');
    };
    return handle;
  };
  await assert.rejects(fs.writeText(target, 'ours', { kind: 'createIfAbsent' }), { code: 'FS_IO_ERROR' });
  assert.equal(await readFile(target.targetKey, 'utf8'), 'replacement');
  await noStaging();
});

test('sync failure is reported even when all bytes have been written', async () => {
  const target = await fs.resolve('new.txt');
  const failure = errno('EIO');
  let handle;
  fs.internals.linkFile = async () => { throw errno('EPERM'); };
  fs.internals.openPublicationFile = async (...args) => {
    handle = await open(...args);
    handle.sync = async () => { throw failure; };
    return handle;
  };
  await assert.rejects(fs.writeText(target, 'ours', { kind: 'createIfAbsent' }), { code: 'FS_IO_ERROR', cause: failure });
  assert.equal(handle.fd, -1);
  assert.equal(await readFile(target.targetKey, 'utf8'), 'ours');
  await noStaging();
});

test('abort during the fallback reports FS_ABORTED and closes the created descriptor', async () => {
  const target = await fs.resolve('new.txt');
  const abort = new AbortController();
  let handle;
  fs.internals.linkFile = async () => { throw errno('EPERM'); };
  fs.internals.openPublicationFile = async (...args) => {
    handle = await open(...args);
    abort.abort();
    return handle;
  };
  await assert.rejects(fs.writeText(target, 'ours', { kind: 'createIfAbsent' }, abort.signal), {
    code: 'FS_ABORTED', message: /may be incomplete/,
  });
  assert.equal(handle.fd, -1);
  assert.equal(await readFile(target.targetKey, 'utf8'), '');
  await noStaging();
});

test('supported hard links retain the staged inode and bypass fallback', async () => {
  let sameInode = false;
  fs.internals.linkFile = async (source, target) => {
    await link(source, target);
    sameInode = (await stat(source)).ino === (await stat(target)).ino;
  };
  fs.internals.openPublicationFile = async () => { assert.fail('fallback must not run'); };
  const target = await fs.resolve('new.txt');
  await fs.writeText(target, 'ours', { kind: 'createIfAbsent' });
  assert.equal(sameInode, true);
  await noStaging();
});

test('unconditional replacement keeps the existing rename path', async () => {
  const target = await fs.resolve('existing.txt');
  await writeFile(target.targetKey, 'old');
  fs.internals.linkFile = async () => { assert.fail('guarded path must not run'); };
  const result = await fs.writeText(target, 'new');
  assert.equal(result.operation, 'update');
  assert.equal(await readFile(target.targetKey, 'utf8'), 'new');
  await noStaging();
});


test('a competing directory is preserved when hard links are unavailable', async () => {
  const target = await fs.resolve('directory');
  fs.internals.linkFile = async () => {
    await mkdir(target.targetKey);
    throw errno('EPERM');
  };
  await assert.rejects(fs.writeText(target, 'ours', { kind: 'createIfAbsent' }), { code: 'FS_NOT_REGULAR_FILE' });
  assert.equal((await stat(target.targetKey)).isDirectory(), true);
  await noStaging();
});

test('a close failure is reported and the descriptor is closed during cleanup', async () => {
  const target = await fs.resolve('new.txt');
  const failure = errno('EIO');
  let closes = 0;
  let closedFd = -2;
  fs.internals.linkFile = async () => { throw errno('EPERM'); };
  fs.internals.openPublicationFile = async (...args) => {
    const handle = await open(...args);
    const close = handle.close.bind(handle);
    handle.close = async () => {
      if (++closes === 1) throw failure;
      await close();
      closedFd = handle.fd;
    };
    return handle;
  };
  await assert.rejects(fs.writeText(target, 'ours', { kind: 'createIfAbsent' }), { code: 'FS_IO_ERROR', cause: failure });
  assert.equal(closes, 2);
  assert.equal(closedFd, -1);
  assert.equal(await readFile(target.targetKey, 'utf8'), 'ours');
  await noStaging();
});
