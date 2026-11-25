// Real SessionStore forks, JSONL codecs, files and native writer leases.
// All sessions are synthetic; no Host, model calls or user data are involved.
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { syncBuiltinESMExports } from 'node:module';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

if (!process.env.DSH_PREFIX) throw new Error('Set DSH_PREFIX to the locked patched runtime');
const base = join(resolve(process.env.DSH_PREFIX), 'node_modules/@deepseek-ai');
const load = (name, file = 'lib/index.js') => import(pathToFileURL(join(base, name, file)));
const { Context } = await load('cordis');
const { SessionStore } = await load('dsh-session');
const { apply: jsonl } = await load('dsh-session-persistence-jsonl');
const { establishCatalogChild, subagentCatalogProjectionDefinition: catalog } =
  await load('dsh-subagent', 'lib/types/catalog.js');
const { teamProjectionDefinition: team } = await load('dsh-experimental-agent-team', 'lib/types/projection.js');

const hooks = () => ({ validate: async () => {}, dispose: async () => {}, inspectTasks: async () => false, cleanup: async () => {} });
const related = error => error.code === 'session-related';
function record(session, kind, child) {
  if (kind === 'catalog') establishCatalogChild(session, child.header, { mode: 'continuable', label: 'Synthetic child' });
  else session.append('team/task', { version: 2, teamId: session.id, task: {
    id: 'synthetic-task', revision: 1, subject: 'Synthetic task', description: '',
    status: 'completed', blockedBy: [], writeScopes: [],
  } });
}
function projection(session, definition) {
  const state = session.snapshotEvents().reduce(definition.apply, definition.init(session.header, session.inheritedEventCount));
  return definition.wire.view(state);
}

async function fixture(t, { kind = 'catalog', compression = 'none', own = false, realChild = false } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-delete-inherited-'));
  const builder = new Context();
  let ctx = new Context();
  const handles = new Set();
  t.after(async () => {
    for (const handle of handles) await handle.close();
    await ctx.fiber.dispose(); await builder.fiber.dispose();
    await rm(root, { recursive: true, force: true });
  });
  await builder.plugin(SessionStore);
  await jsonl(ctx, { root, compression });
  const source = builder.sessions.create('synthetic-source');
  const child = builder.sessions.create('synthetic-child', {
    meta: { origin: 'subagent', parentSession: source.id, delegationDepth: 1 },
  });
  record(source, kind, child);
  const fork = builder.sessions.fork(source, undefined, 'synthetic-fork');
  assert.equal(fork.header.isSeeded, true);
  assert.equal(fork.header.origin, undefined);
  assert.equal(fork.inheritedEventCount, source.seq);
  const inheritedView = projection(fork, kind === 'catalog' ? catalog : team);
  assert.deepEqual(kind === 'catalog' ? inheritedView : inheritedView.tasks, []);
  const originalView = projection(source, kind === 'catalog' ? catalog : team);
  assert.equal((kind === 'catalog' ? originalView : originalView.tasks).length, 1);
  if (own) record(fork, kind, child);
  const sessions = [source, child, fork];
  if (realChild) sessions.push(builder.sessions.create('synthetic-fork-child', {
    meta: { origin: 'subagent', parentSession: fork.id, delegationDepth: 1 },
  }));
  for (const session of sessions) {
    const writer = await ctx.sessionPersistence.create(session.header, { inheritedEventCount: session.inheritedEventCount });
    try { await writer.append(session.snapshotEvents()); await writer.flush(); }
    finally { await writer.close(); }
  }
  const paths = new Map(), originals = new Map();
  for (const session of sessions) {
    const path = (await ctx.sessionPersistence.findLog(session.id)).currentPath;
    paths.set(session.id, path); originals.set(session.id, await readFile(path));
  }
  return {
    root, source, child, fork, paths, originals,
    get storage() { return ctx.sessionPersistence; },
    async unchanged(ids = sessions.map(session => session.id)) {
      for (const id of ids) assert.deepEqual(await readFile(paths.get(id)), originals.get(id), id);
    },
    async reopen() {
      await ctx.fiber.dispose(); ctx = new Context(); await jsonl(ctx, { root, compression });
    },
    async openWriter() {
      const writer = await ctx.sessionPersistence.open(fork.id, 'write'); handles.add(writer); return writer;
    },
    async closeWriter(writer) { await writer.close(); handles.delete(writer); },
  };
}

for (const compression of ['none', 'zstd']) for (const kind of ['catalog', 'team']) {
  test(`${compression}: inherited ${kind} does not make an ordinary fork own its source's work`, async t => {
    const f = await fixture(t, { kind, compression });
    await f.storage.dshGoDeletion.delete(f.fork.id, hooks());
    assert.equal(f.storage.dshGoDeletion.deleted(f.fork.id), true);
    await assert.rejects(readFile(f.paths.get(f.fork.id)), { code: 'ENOENT' });
    await f.unchanged([f.source.id, f.child.id]);
    await f.reopen();
    assert.equal(await f.storage.stat(f.fork.id), undefined);
    await assert.rejects(f.storage.open(f.fork.id, 'write'), { name: 'SessionPersistenceNotFoundError' });
    await f.unchanged([f.source.id, f.child.id]);
    for (const id of [f.source.id, f.child.id]) {
      const reader = await f.storage.open(id, 'read');
      try { assert.equal(reader.header.id, id); await reader.read(); }
      finally { await reader.close(); }
    }
    // A subagent session is still not deletable on its own...
    await assert.rejects(f.storage.dshGoDeletion.delete(f.child.id, hooks()), related);
    assert.equal(f.storage.dshGoDeletion.deleted(f.child.id), false);
    // ...but the source's own catalog/team history no longer blocks the chat, and
    // deleting the source takes its persisted subagent session with it.
    await f.storage.dshGoDeletion.delete(f.source.id, hooks());
    for (const id of [f.source.id, f.child.id]) {
      assert.equal(f.storage.dshGoDeletion.deleted(id), true, id);
      await assert.rejects(readFile(f.paths.get(id)), { code: 'ENOENT' });
    }
  });
}
for (const kind of ['catalog', 'team']) {
  test(`a fork's own ${kind} no longer blocks deletion`, async t => {
    const f = await fixture(t, { kind, own: true });
    await f.storage.dshGoDeletion.delete(f.fork.id, hooks());
    assert.equal(f.storage.dshGoDeletion.deleted(f.fork.id), true);
    await assert.rejects(readFile(f.paths.get(f.fork.id)), { code: 'ENOENT' });
    await f.unchanged([f.source.id, f.child.id]);
  });
}
test('a persisted child is deleted together with its fork', async t => {
  const f = await fixture(t, { realChild: true });
  await f.storage.dshGoDeletion.delete(f.fork.id, hooks());
  for (const id of [f.fork.id, 'synthetic-fork-child']) {
    assert.equal(f.storage.dshGoDeletion.deleted(id), true, id);
    await assert.rejects(readFile(f.paths.get(id)), { code: 'ENOENT' });
  }
  await f.unchanged([f.source.id, f.child.id]);
});
for (const compression of ['none', 'zstd']) {
  test(`${compression}: reopening after a child cleanup failure still retries that child's cleanup`, async t => {
    const f = await fixture(t, { compression, realChild: true });
    const childId = 'synthetic-fork-child';
    const cleanups = [];
    await assert.rejects(f.storage.dshGoDeletion.delete(f.fork.id, {
      ...hooks(),
      cleanup: async id => { cleanups.push(id); throw new Error('derived state unavailable'); },
    }), /derived state unavailable/);
    assert.equal(f.storage.dshGoDeletion.deleted(childId), true);
    assert.equal(f.storage.dshGoDeletion.deleted(f.fork.id), false);
    await assert.rejects(readFile(f.paths.get(childId)), { code: 'ENOENT' });
    await f.unchanged([f.source.id, f.child.id, f.fork.id]);

    await f.reopen();
    assert.equal(await f.storage.stat(childId), undefined);
    await f.storage.dshGoDeletion.delete(f.fork.id, {
      ...hooks(), cleanup: async id => { cleanups.push(id); },
    });
    assert.deepEqual(cleanups, [childId, childId, f.fork.id]);
    assert.equal(f.storage.dshGoDeletion.deleted(f.fork.id), true);
    await assert.rejects(readFile(f.paths.get(f.fork.id)), { code: 'ENOENT' });
    await f.unchanged([f.source.id, f.child.id]);
  });
}
test('a second storage instance cannot overtake a parent deletion during child cleanup', async t => {
  const f = await fixture(t, { realChild: true });
  const peer = new Context();
  await jsonl(peer, { root: f.root, compression: 'none' });
  let enter, release;
  const entered = new Promise(resolve => { enter = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const deleting = f.storage.dshGoDeletion.delete(f.fork.id, {
    ...hooks(), cleanup: async id => { if (id === 'synthetic-fork-child') { enter(); await gate; } },
  });
  try {
    await entered;
    assert.equal(await peer.sessionPersistence.stat('synthetic-fork-child'), undefined);
    await assert.rejects(peer.sessionPersistence.dshGoDeletion.delete(f.fork.id, hooks()), { name: 'SessionAlreadyOwnedError' });
    assert.equal(f.storage.dshGoDeletion.deleted(f.fork.id), false);
    await f.unchanged([f.source.id, f.child.id, f.fork.id]);
  } finally {
    release();
    try { await deleting; } finally { await peer.fiber.dispose(); }
  }
  assert.equal(f.storage.dshGoDeletion.deleted(f.fork.id), true);
  await f.unchanged([f.source.id, f.child.id]);
});
for (const point of ['file', 'directory']) {
  test(`cascade ${point} sync failure leaves every log intact and a reopened retry completes`, async t => {
    const f = await fixture(t, { realChild: true });
    const slot = join(f.root, '.dsh-go-lifecycle', createHash('sha256').update(f.fork.id).digest('hex'));
    const originalOpen = fs.open;
    const fault = Object.assign(new Error(`controlled cascade ${point} sync failure`), { code: 'EIO' });
    let fail = true;
    fs.open = async function (path, ...args) {
      const handle = await originalOpen.call(this, path, ...args);
      const selected = point === 'file'
        ? String(path).startsWith(`${slot}/.`) && String(path).endsWith('.tmp')
        : String(path) === slot;
      if (selected) {
        const originalSync = handle.sync.bind(handle);
        handle.sync = async () => {
          if (fail) { fail = false; throw fault; }
          return originalSync();
        };
      }
      return handle;
    };
    syncBuiltinESMExports();
    try {
      await assert.rejects(f.storage.dshGoDeletion.delete(f.fork.id, hooks()), error => error === fault);
    } finally { fs.open = originalOpen; syncBuiltinESMExports(); }
    await f.unchanged();
    for (const id of [f.fork.id, 'synthetic-fork-child']) {
      assert.equal(f.storage.dshGoDeletion.deleted(id), false);
      assert.equal(f.storage.dshGoDeletion.pending.has(id), false);
    }
    await f.reopen();
    await f.storage.dshGoDeletion.delete(f.fork.id, hooks());
    for (const id of [f.fork.id, 'synthetic-fork-child']) {
      assert.equal(f.storage.dshGoDeletion.deleted(id), true);
      await assert.rejects(readFile(f.paths.get(id)), { code: 'ENOENT' });
    }
    await f.unchanged([f.source.id, f.child.id]);
  });
}
test('the schedule inspection gate still blocks an otherwise independent fork', async t => {
  const f = await fixture(t);
  await assert.rejects(f.storage.dshGoDeletion.delete(f.fork.id, { ...hooks(), inspectTasks: async () => true }), related);
  assert.equal(f.storage.dshGoDeletion.deleted(f.fork.id), false);
  await f.unchanged();
});
test('a real native writer lease prevents deletion without changing any log', async t => {
  const f = await fixture(t);
  const writer = await f.openWriter();
  try {
    await assert.rejects(f.storage.dshGoDeletion.delete(f.fork.id, hooks()), { name: 'SessionAlreadyOwnedError' });
    assert.equal(f.storage.dshGoDeletion.deleted(f.fork.id), false);
    await f.unchanged();
  } finally { await f.closeWriter(writer); }
});
test('an invalid persisted inherited marker is refused before a tombstone or removal', async t => {
  const f = await fixture(t);
  const path = f.paths.get(f.fork.id);
  const rows = (await readFile(path, 'utf8')).trimEnd().split('\n').map(line => JSON.parse(line));
  const marker = rows.find(row => row.type === 'session/end-seed');
  assert(marker); marker.data.inherited = 'invalid';
  const invalid = Buffer.from(rows.map(row => JSON.stringify(row)).join('\n') + '\n');
  await writeFile(path, invalid);
  await assert.rejects(f.storage.dshGoDeletion.delete(f.fork.id, hooks()), { name: 'SessionPersistenceCorruptionError' });
  assert.equal(f.storage.dshGoDeletion.deleted(f.fork.id), false);
  assert.deepEqual(await readFile(path), invalid);
  await f.unchanged([f.source.id, f.child.id]);
});
