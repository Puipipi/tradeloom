import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepareImageStore } from '../src/storage.js';

const RID = 'm_01234567-89ab-4cde-8012-3456789abcde';
const DATE = '2026-10-28';
const DATA = Buffer.from([1, 2, 3, 4]);

async function filesBelow(path) {
  const all = [];
  let entries;
  try { entries = await readdir(path, { withFileTypes: true }); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  for (const entry of entries) {
    const child = join(path, entry.name);
    if (entry.isDirectory()) all.push(...await filesBelow(child));
    else all.push(child);
  }
  return all;
}

async function setup(t, authorize) {
  const root = await mkdtemp(join(tmpdir(), 'media-storage-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const cwd = join(root, 'work');
  const hostStateDir = join(root, 'state');
  await mkdir(cwd);
  const indexPath = join(hostStateDir, 'works', DATE, RID + '.json');
  const policy = { cwd, workspaceRoot: cwd, mode: 'workspace-write' };
  const store = await prepareImageStore({
    authorizeWorkspace: async () => authorize ? authorize({ ...policy }, indexPath) : { ...policy },
    hostStateDir, signal: new AbortController().signal, rid: RID, date: DATE,
  });
  const path = await store.stage(DATA, 'png');
  const meta = { v: 1, rid: RID, kind: 'image', status: 'done',
    items: [{ path, mime: 'image/png', width: 1, height: 1, bytes: DATA.length }],
    request: { provider: 'mock', model: 'mock', label: 'Mock', n: 1, refs: 0 }, prompt: 'test' };
  return { cwd, hostStateDir, indexPath, store, path, meta, policy };
}

test('an existing foreign image filename is preserved during rollback', async t => {
  const f = await setup(t);
  await writeFile(f.path, 'foreign');
  await assert.rejects(f.store.commit(f.meta, { sessionId: 's', createdAt: DATE }));
  assert.equal(await f.store.abort(), true);
  assert.equal(await readFile(f.path, 'utf8'), 'foreign');
  assert.deepEqual(await filesBelow(f.cwd), [f.path]);
  assert.deepEqual(await filesBelow(f.hostStateDir), []);
});

test('a foreign index survives rollback while newly published originals are removed', async t => {
  const f = await setup(t);
  await writeFile(f.indexPath, 'foreign-index');
  await assert.rejects(f.store.commit(f.meta, { sessionId: 's', createdAt: DATE }));
  assert.equal(await f.store.abort(), true);
  assert.equal(await readFile(f.indexPath, 'utf8'), 'foreign-index');
  assert.deepEqual(await filesBelow(f.cwd), []);
});

test('permission revoked after index publication prevents accepting the work', async t => {
  let sawPublishedIndex = false;
  const f = await setup(t, async (policy, indexPath) => {
    try {
      await readFile(indexPath);
      sawPublishedIndex = true;
      return { ...policy, mode: 'read-only' };
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      return policy;
    }
  });
  await assert.rejects(f.store.commit(f.meta, { sessionId: 's', createdAt: DATE }), { code: 'permission' });
  assert.equal(sawPublishedIndex, true);
  assert.equal(await f.store.abort(), true);
  assert.deepEqual(await filesBelow(f.cwd), []);
  assert.deepEqual(await filesBelow(f.hostStateDir), []);
});

test('an accepted index and original survive later abort requests', async t => {
  const f = await setup(t);
  const accepted = await f.store.commit(f.meta, { sessionId: 's', createdAt: DATE });
  assert.equal(accepted.indexPath, f.indexPath);
  assert.equal(await f.store.abort(), true);
  assert.deepEqual(await readFile(f.path), DATA);
  assert.deepEqual(JSON.parse(await readFile(f.indexPath, 'utf8')).media, f.meta);
});
