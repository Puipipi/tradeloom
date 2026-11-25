import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepareImageStore } from '../src/storage.js';
import { createStreamStager } from '../src/stream-staging.js';

// Actual downloader and storage transaction; only loopback and workspace policy
// are controlled. No provider, media decoder, guest, or third-party package runs.
const DATA = Buffer.alloc(512, 65);
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'media-download-handoff-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const cwd = join(root, 'work');
  await mkdir(cwd);
  await writeFile(join(cwd, 'keep.txt'), 'existing content');
  const controller = new AbortController();
  let authorize;
  const policy = { cwd, workspaceRoot: cwd, mode: 'workspace-write' };
  const store = await prepareImageStore({
    authorizeWorkspace: () => authorize ? authorize({ ...policy }) : { ...policy },
    hostStateDir: join(root, 'state'), signal: controller.signal,
    rid: 'm_' + randomUUID(), date: '2026-11-10',
  });
  const sockets = new Set();
  const server = createServer((_req, res) => {
    res.writeHead(200, { 'content-length': DATA.length });
    res.end(DATA);
  });
  server.on('connection', socket => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise(done => server.close(done));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const stage = createStreamStager({ allowLoopback: true });
  const download = (ownDownload = store.ownDownload) => stage(
    `http://127.0.0.1:${server.address().port}/own-video`,
    { directory: store.stagingDirectory, signal: controller.signal, maxBytes: 1024, ownDownload },
  );
  async function rolledBack() {
    assert.equal(await store.abort(), true);
    await assert.rejects(readdir(store.stagingDirectory), { code: 'ENOENT' });
    assert.equal(await readFile(join(cwd, 'keep.txt'), 'utf8'), 'existing content');
  }
  return { store, controller, download, rolledBack, setAuthorize(value) { authorize = value; } };
}

test('successful download belongs to the transaction before its receipt returns', async t => {
  const f = await fixture(t);
  const receipt = await f.download();
  assert.equal(receipt.bytes, DATA.length);
  assert.deepEqual(await readFile(receipt.path), DATA);
  await f.rolledBack();
});

test('cancellation after download but before claim removes the downloader-owned file', async t => {
  const f = await fixture(t);
  await assert.rejects(f.download(async receipt => {
    assert.deepEqual(await readFile(receipt.path), DATA);
    f.controller.abort();
    await f.store.ownDownload(receipt);
  }), { code: 'cancelled' });
  await f.rolledBack();
});

test('cancellation during the actual policy await cleans a rejected claim', async t => {
  const f = await fixture(t);
  const entered = Promise.withResolvers(), release = Promise.withResolvers();
  t.after(() => release.resolve());
  f.setAuthorize(async policy => {
    entered.resolve(true);
    await release.promise;
    return policy;
  });
  const pending = f.download();
  // A missing handoff must fail promptly, rather than leave the test gate pending.
  assert.equal(await Promise.race([entered.promise, pending.then(() => false)]), true);
  const rejected = assert.rejects(pending, { code: 'cancelled' });
  f.controller.abort();
  release.resolve();
  await rejected;
  await f.rolledBack();
});

for (const mode of ['read-only', 'policy-error']) {
  test(`${mode} during handoff preserves the policy failure and cleans the private file`, async t => {
    const f = await fixture(t);
    f.setAuthorize(policy => {
      if (mode === 'policy-error') throw new Error('workspace policy unavailable');
      return { ...policy, mode };
    });
    await assert.rejects(f.download(), { code: 'permission' });
    await f.rolledBack();
  });
}

test('cancellation after claim lets transaction rollback accept an already removed download', async t => {
  const f = await fixture(t);
  let claimed = false;
  await assert.rejects(f.download(async receipt => {
    await f.store.ownDownload(receipt);
    claimed = true;
    f.controller.abort();
  }), { code: 'cancelled' });
  assert.equal(claimed, true);
  await f.rolledBack();
});

test('failed handoff removes only its download and leaves unrelated staging content', async t => {
  const f = await fixture(t);
  const unrelated = join(f.store.stagingDirectory, 'keep.txt');
  await writeFile(unrelated, 'foreign content');
  f.setAuthorize(policy => ({ ...policy, mode: 'read-only' }));
  await assert.rejects(f.download(), { code: 'permission' });
  assert.deepEqual(await readdir(f.store.stagingDirectory), ['keep.txt']);
  assert.equal(await f.store.abort(), false, 'unowned content must not be recursively removed');
  assert.equal(await readFile(unrelated, 'utf8'), 'foreign content');
});
