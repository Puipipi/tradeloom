import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm, mkdir, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
const base = join(resolve(process.env.DSH_PREFIX), 'node_modules/@deepseek-ai');
const load = name => import(pathToFileURL(join(base, name, 'lib/index.js')));
const { Context } = await load('cordis');
const { SessionStore } = await load('dsh-session');
const { SqliteSessionQueryEngine } = await load('dsh-session-query-sqlite');
async function fixture(t, { blocked = false, openAt = 'first-search' } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'query-open-retry-'));
  const parent = join(root, 'index'), path = join(parent, 'search.db');
  if (blocked) await writeFile(parent, 'fixture blocker');
  else await mkdir(parent);
  const ctx = new Context();
  t.after(async () => { await ctx.fiber.dispose(); await rm(root, { recursive: true, force: true }); });
  await ctx.plugin(SessionStore);
  await ctx.plugin(SqliteSessionQueryEngine, { path, openAt });
  return { ctx, query: ctx.sessionQuery, root, parent, path };
}
const empty = result => assert.deepEqual(result, { items: [] });
const failed = error => error.code === 'SESSION_QUERY_INDEX_FAILED';
async function repair(parent) { await rm(parent); await mkdir(parent); }

test('a real failed first open retries only after the caller repairs the directory and searches again', async t => {
  const f = await fixture(t, { blocked: true });
  let first;
  await assert.rejects(f.query.searchSessions({ query: 'fixture' }), error => {
    first = error;
    assert.equal(error.code, 'SESSION_QUERY_INDEX_FAILED');
    assert.equal(error.cause.code, 'EEXIST');
    return true;
  });
  assert.equal(await readFile(f.parent, 'utf8'), 'fixture blocker');
  await repair(f.parent);
  empty(await f.query.searchSessions({ query: 'fixture' }));
  assert.ok((await stat(f.path)).isFile());
  assert.equal(first.cause.code, 'EEXIST');
});

test('foreign SQLite data stays refused and unchanged until the caller explicitly removes it', async t => {
  const f = await fixture(t);
  const db = new DatabaseSync(f.path);
  db.exec("PRAGMA application_id = 123; CREATE TABLE sentinel(value TEXT); INSERT INTO sentinel VALUES ('keep');");
  db.close();
  const before = await readFile(f.path);
  for (let i = 0; i < 2; i++) {
    await assert.rejects(f.query.searchSessions({ query: 'fixture' }), error => failed(error) && /belongs to another application/.test(error.cause.message));
    assert.deepEqual(await readFile(f.path), before);
  }
  await rm(f.path);
  empty(await f.query.searchSessions({ query: 'fixture' }));
});

test('successful initialization is reused by later searches', async t => {
  const f = await fixture(t);
  const open = f.query._open;
  let opens = 0;
  t.mock.method(f.query, '_open', function (...args) { opens++; return open.apply(this, args); });
  empty(await f.query.searchSessions({ query: 'first' }));
  empty(await f.query.searchSessions({ query: 'second' }));
  assert.equal(opens, 1);
});

test('an aborted waiter does not clear a still pending successful owner open', async t => {
  const f = await fixture(t), entered = Promise.withResolvers(), release = Promise.withResolvers();
  const open = f.query._open;
  let opens = 0;
  // Complete the real SQLite open, then hold its completion; no fake database or I/O error.
  t.mock.method(f.query, '_open', async function (...args) {
    opens++;
    await open.apply(this, args);
    entered.resolve();
    await release.promise;
  });
  const controller = new AbortController();
  const first = f.query.searchSessions({ query: 'first' }, { signal: controller.signal });
  const rejected = assert.rejects(first, error => error.code === 'SESSION_QUERY_ABORTED');
  try {
    await entered.promise;
    controller.abort();
    await rejected;
    const second = f.query.searchSessions({ query: 'second' });
    release.resolve();
    empty(await second);
    assert.equal(opens, 1);
  } finally { release.resolve(); }
});

test('close after a failed initialization prevents reopening a repaired path', async t => {
  const f = await fixture(t, { blocked: true });
  await assert.rejects(f.query.searchSessions({ query: 'first' }), failed);
  await f.query.close();
  await repair(f.parent);
  await assert.rejects(f.query.searchSessions({ query: 'second' }), error => failed(error) && error.message === 'session-search SQLite index is closed');
  await assert.rejects(stat(f.path), error => error.code === 'ENOENT');
});

test('never mode refuses search before opening or normalizing the request', async t => {
  const f = await fixture(t, { blocked: true, openAt: 'never' });
  await assert.rejects(f.query.searchSessions({ query: null }), error => error.code === 'SESSION_QUERY_SEARCH_DISABLED');
  assert.equal(await readFile(f.parent, 'utf8'), 'fixture blocker');
});
