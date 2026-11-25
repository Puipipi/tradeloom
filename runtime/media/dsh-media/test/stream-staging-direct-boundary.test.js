import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import fs, { chmod, mkdir, mkdtemp, open, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, parse } from 'node:path';
import { createPaths } from '../../../direct/paths.mjs';
import { prepareImageStore } from '../src/storage.js';
import { createStreamStager } from '../src/stream-staging.js';

// Real DAC errors, not injected errno values. Root bypasses these mode bits;
// Windows does not implement this POSIX directory-permission contract.
const permissions = { skip: process.platform === 'win32' || process.getuid?.() === 0
  ? 'requires non-root POSIX DAC permissions' : false };
const direct = Symbol.for('dsh.go.direct');
const bytes = Buffer.alloc(512, 65);

async function fixture(t, { mounted = false } = {}) {
  const temporary = await mkdtemp(join(tmpdir(), 'staging-direct-boundary-'));
  const outside = join(temporary, 'traversable-only');
  const rootfs = join(outside, 'rootfs');
  const cwd = mounted ? join(outside, 'rootfs-external', 'workspace') : join(rootfs, 'root', 'new-parent', 'workspace');
  const previous = globalThis[direct], restricted = [], sockets = new Set();
  let store, server, requests = 0;
  t.after(async () => {
    if (previous === undefined) delete globalThis[direct]; else globalThis[direct] = previous;
    for (const path of restricted) await chmod(path, 0o700);
    for (const socket of sockets) socket.destroy();
    if (server?.listening) await new Promise(done => server.close(done));
    if (store) assert.equal(await store.abort(), true);
    await rm(temporary, { recursive: true, force: true });
  });
  await mkdir(rootfs, { recursive: true });
  // Model the installed-root barrier before creating a new workspace below it.
  for (const path of [rootfs, outside, temporary, dirname(temporary)]) {
    const handle = await open(path, 'r');
    try { await handle.sync(); } finally { await handle.close(); }
  }
  globalThis[direct] = Object.freeze(createPaths(rootfs,
    mounted ? [{ host: cwd, guest: '/mnt/external' }] : []));
  await mkdir(cwd, { recursive: true });
  async function restrict(path) { await chmod(path, 0o111); restricted.push(path); }
  await restrict(outside);
  await writeFile(join(cwd, 'keep.txt'), 'existing content');
  store = await prepareImageStore({
    authorizeWorkspace: async () => ({ cwd, workspaceRoot: cwd, mode: 'workspace-write' }),
    hostStateDir: join(rootfs, 'root', '.dsh', 'media', 'dsh-media'),
    signal: new AbortController().signal, rid: 'm_' + randomUUID(), date: '2026-11-12',
  });
  server = createServer((_request, response) => { requests++; response.end(bytes); });
  server.on('connection', socket => {
    sockets.add(socket); socket.on('close', () => sockets.delete(socket));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const stage = createStreamStager({ allowLoopback: true });
  const download = () => stage(`http://127.0.0.1:${server.address().port}/own-video`, {
    directory: store.stagingDirectory, maxBytes: 1024, ownDownload: store.ownDownload,
  });
  return { outside, rootfs, cwd, store, restrict, download, requests: () => requests };
}

function traceStorage(t) {
  const opened = [], synced = [], failed = [], original = fs.open;
  const traced = t.mock.method(fs, 'open', async (path, ...args) => {
    opened.push(String(path));
    let handle;
    try { handle = await original(path, ...args); }
    catch (error) { failed.push({ path: String(path), code: error.code }); throw error; }
    const sync = handle.sync.bind(handle);
    handle.sync = async () => { await sync(); synced.push(String(path)); };
    return handle;
  });
  syncBuiltinESMExports();
  t.after(() => { traced.mock.restore(); syncBuiltinESMExports(); });
  return { opened, synced, failed };
}

test('Direct staging syncs every new workspace ancestor through rootfs without opening its unreadable parent', permissions, async t => {
  const f = await fixture(t), trace = traceStorage(t);
  const receipt = await f.download();
  assert.deepEqual(await readFile(receipt.path), bytes);
  assert.equal(f.requests(), 1);
  const expected = [f.store.stagingDirectory, dirname(f.store.stagingDirectory), join(f.cwd, 'generated'),
    f.cwd, join(f.rootfs, 'root', 'new-parent'), join(f.rootfs, 'root'), f.rootfs];
  assert.deepEqual(trace.synced.slice(0, expected.length), expected);
  assert.equal(trace.opened.includes(f.outside), false);
  assert.deepEqual(trace.failed, []);
  assert.equal(await readFile(join(f.cwd, 'keep.txt'), 'utf8'), 'existing content');
});

test('an unreadable ancestor inside Direct rootfs still rejects before GET and allows a later retry', permissions, async t => {
  const f = await fixture(t), trace = traceStorage(t);
  const inside = join(f.rootfs, 'root', 'new-parent');
  await f.restrict(inside);
  await assert.rejects(f.download(), { code: 'storage' });
  assert.deepEqual(trace.failed, [{ path: inside, code: 'EACCES' }]);
  assert.equal(f.requests(), 0);
  assert.deepEqual(await readdir(f.store.stagingDirectory), []);
  await chmod(inside, 0o700);
  assert.deepEqual(await readFile((await f.download()).path), bytes);
  assert.equal(f.requests(), 1);
  assert.ok(trace.synced.includes(f.rootfs));
});

test('without Direct the full ancestor barrier still rejects an unreadable parent and reaches filesystem root after repair', permissions, async t => {
  const f = await fixture(t), trace = traceStorage(t);
  delete globalThis[direct];
  await assert.rejects(f.download(), { code: 'storage' });
  assert.deepEqual(trace.failed, [{ path: f.outside, code: 'EACCES' }]);
  assert.equal(f.requests(), 0);
  assert.deepEqual(await readdir(f.store.stagingDirectory), []);
  await chmod(f.outside, 0o700);
  assert.deepEqual(await readFile((await f.download()).path), bytes);
  assert.equal(f.requests(), 1);
  assert.ok(trace.synced.includes(parse(f.cwd).root));
});

test('a Direct external mount retains the full ancestor barrier even with a rootfs name prefix', permissions, async t => {
  const f = await fixture(t, { mounted: true }), trace = traceStorage(t);
  await assert.rejects(f.download(), { code: 'storage' });
  assert.deepEqual(trace.failed, [{ path: f.outside, code: 'EACCES' }]);
  assert.equal(f.requests(), 0);
  assert.deepEqual(await readdir(f.store.stagingDirectory), []);
  await chmod(f.outside, 0o700);
  assert.deepEqual(await readFile((await f.download()).path), bytes);
  assert.equal(f.requests(), 1);
  assert.ok(trace.synced.includes(parse(f.cwd).root));
  assert.equal(trace.synced.includes(f.rootfs), false);
});
