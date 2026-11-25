// Actual public JSONL create/flush/append; controlled errors after real temp-file I/O.
// DSH_PREFIX=/private/patched/prefix node --test runtime/tests/materialize-temp.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
if (!process.env.DSH_PREFIX) throw Error('Set DSH_PREFIX to the locked, patched JSONL candidate');
const base = join(resolve(process.env.DSH_PREFIX), 'node_modules/@deepseek-ai');
const load = name => import(pathToFileURL(join(base, name, 'lib/index.js')));
const { Context } = await load('cordis');
const { Session } = await load('dsh-session');
const { createUserMessage } = await load('dsh-llm');
const { apply } = await load('dsh-session-persistence-jsonl');
async function fixture(t) {
  const root = await fs.mkdtemp(join(tmpdir(), 'dsh-materialize-'));
  const ctx = new Context();
  t.after(async () => { await ctx.fiber.dispose(); await fs.rm(root, { recursive: true, force: true }); });
  await apply(ctx, { root, compression: 'none', listConcurrency: 1 });
  const id = 'materialize-fixture';
  const session = Session.create(id);
  session.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'only once' }], source: { kind: 'user', rpcId: 'fixture-request' } }), { surfaceOp: 'append' });
  const handle = await ctx.sessionPersistence.create(session.header);
  const directory = join(root, '_no-cwd', id);
  await fs.mkdir(directory, { recursive: true });
  const foreign = join(directory, 'session.v4.jsonl.000000000000.tmp');
  await fs.writeFile(foreign, 'unrelated previous temporary');
  const sentinel = await fs.readFile(foreign);
  return { ctx, root, id, handle, directory, foreign, sentinel, events: session.snapshotEvents() };
}
function inject(t, f, { stage = 'sync', closeFailure = false, cleanupFailure = false } = {}) {
  const originalOpen = fs.open, originalRm = fs.rm;
  const primary = Object.assign(Error(`controlled ${stage} EIO`), { code: 'EIO' });
  const closing = Object.assign(Error('controlled close EIO'), { code: 'EIO' });
  const cleanup = Object.assign(Error('controlled cleanup EIO'), { code: 'EIO' });
  const state = { path: undefined, opened: 0, closed: 0, removals: [], faulted: false };
  fs.open = async function (path, flags, ...args) {
    const target = String(path);
    const matches = target.startsWith(join(f.directory, 'session.v4.jsonl.')) && target.endsWith('.tmp') && flags === 'wx' && !state.faulted;
    if (matches && stage === 'open') { state.faulted = true; throw primary; }
    const handle = await originalOpen.call(this, path, flags, ...args);
    if (!matches) return handle;
    state.path = target; state.opened++;
    const write = handle.writeFile.bind(handle), sync = handle.sync.bind(handle), close = handle.close.bind(handle);
    handle.writeFile = async content => {
      if (stage === 'write') {
        await write(Buffer.from(content).subarray(0, 5));
        assert.equal((await fs.stat(target)).size, 5);
        state.faulted = true;
        throw primary;
      }
      return write(content);
    };
    handle.sync = async () => {
      if (stage === 'sync') {
        assert((await fs.stat(target)).size > 0, 'real file bytes exist before injected sync error');
        state.faulted = true;
        throw primary;
      }
      return sync();
    };
    handle.close = async () => {
      await close(); state.closed++;
      if (closeFailure) { state.faulted = true; throw closing; }
    };
    return handle;
  };
  fs.rm = async function (path, ...args) {
    if (String(path) === state.path) {
      state.removals.push(String(path));
      if (cleanupFailure) throw cleanup;
    }
    return originalRm.call(this, path, ...args);
  };
  syncBuiltinESMExports();
  const restore = () => { fs.open = originalOpen; fs.rm = originalRm; syncBuiltinESMExports(); };
  t.after(restore);
  return { state, primary, closing, cleanup, restore };
}
for (const stage of ['write', 'sync']) test(`${stage} failure removes only the owned temp and same handle can retry`, async t => {
  const f = await fixture(t), fault = inject(t, f, { stage });
  const persist = () => stage === 'write' ? f.handle.flush() : f.handle.append(f.events);
  await assert.rejects(persist(), error => error === fault.primary);
  assert.equal(fault.state.opened, 1); assert.equal(fault.state.closed, 1);
  assert.deepEqual(fault.state.removals, [fault.state.path]);
  assert.deepEqual(await fs.readFile(f.foreign), f.sentinel);
  assert(!(await fs.readdir(f.directory)).includes('session.v4.jsonl'));
  await persist();
  const read = await f.handle.read();
  assert.equal(read.events.length, stage === 'write' ? 0 : 1);
  assert.deepEqual((await fs.readdir(f.directory)).filter(name => name.endsWith('.tmp')), ['session.v4.jsonl.000000000000.tmp']);
  await f.handle.close();
});
test('a simultaneous close failure keeps the existing close-error precedence while cleaning its temp', async t => {
  const f = await fixture(t), fault = inject(t, f, { stage: 'sync', closeFailure: true });
  await assert.rejects(f.handle.flush(), error => error === fault.closing);
  assert.equal(fault.state.closed, 1);
  assert.deepEqual(fault.state.removals, [fault.state.path]);
  assert.deepEqual(await fs.readFile(f.foreign), f.sentinel);
});
for (const closeFailure of [false, true]) test(`cleanup failure preserves ${closeFailure ? 'close' : 'sync'} failure as the first aggregate cause`, async t => {
  const f = await fixture(t), fault = inject(t, f, { closeFailure, cleanupFailure: true });
  await assert.rejects(f.handle.flush(), error => {
    assert(error instanceof AggregateError);
    assert.deepEqual(error.errors, [closeFailure ? fault.closing : fault.primary, fault.cleanup]);
    return true;
  });
  assert.equal(fault.state.closed, 1);
  assert.equal(fault.state.removals.length, 1);
  assert((await fs.stat(fault.state.path)).size > 0, 'failed cleanup is not claimed to have removed the file');
  assert.deepEqual(await fs.readFile(f.foreign), f.sentinel);
  fault.restore();
});
test('failure to acquire the exclusive temp does not run cleanup for an unowned path', async t => {
  const f = await fixture(t), fault = inject(t, f, { stage: 'open' });
  await assert.rejects(f.handle.flush(), error => error === fault.primary);
  assert.equal(fault.state.opened, 0);
  assert.deepEqual(fault.state.removals, []);
  assert.deepEqual(await fs.readFile(f.foreign), f.sentinel);
  await f.handle.flush();
  await f.handle.close();
});

for (const code of ['EACCES', 'EPERM']) test(code + ': first publish falls back under ownership and preserves competing logs', async t => {
  const f = await fixture(t);
  const other = new Context();
  t.after(() => other.fiber.dispose());
  await apply(other, { root: f.root, compression: 'none', listConcurrency: 1 });
  const contender = await other.sessionPersistence.create(f.handle.header);
  const originalLink = fs.link;
  fs.link = async () => { throw Object.assign(Error('controlled app-domain link denial'), { code }); };
  syncBuiltinESMExports();
  t.after(() => { fs.link = originalLink; syncBuiltinESMExports(); });
  await f.handle.append(f.events);
  const path = join(f.directory, 'session.v4.jsonl');
  const committed = await fs.readFile(path);
  await assert.rejects(contender.flush(), { name: 'SessionAlreadyOwnedError' });
  await f.handle.close();
  await assert.rejects(contender.flush(), /a log already exists on disk/);
  await contender.close();
  assert.deepEqual(await fs.readFile(path), committed);
  const reader = await other.sessionPersistence.open(f.id, 'read');
  assert.deepEqual((await reader.read()).events, f.events);
  await reader.close();
  assert.deepEqual(await fs.readFile(f.foreign), f.sentinel);
  assert.deepEqual((await fs.readdir(f.directory)).filter(name => name.endsWith('.tmp')), ['session.v4.jsonl.000000000000.tmp']);
});

test('ordinary first publish keeps link and never calls rename', async t => {
  const f = await fixture(t);
  const originalLink = fs.link, originalRename = fs.rename;
  let links = 0, renames = 0;
  fs.link = async (...args) => { links++; return originalLink(...args); };
  fs.rename = async (...args) => { renames++; return originalRename(...args); };
  syncBuiltinESMExports();
  t.after(() => { fs.link = originalLink; fs.rename = originalRename; syncBuiltinESMExports(); });
  await f.handle.append(f.events);
  assert.equal(links, 1);
  assert.equal(renames, 0);
  await f.handle.close();
});

for (const collision of ['EEXIST', 'EACCES']) test(collision + ': publication cannot replace an already present target', async t => {
  const f = await fixture(t);
  const path = join(f.directory, 'session.v4.jsonl'), foreign = Buffer.from('another publication');
  const originalLink = fs.link, originalRename = fs.rename;
  let renames = 0;
  fs.link = async (...args) => {
    // Place a real competing entry after the backend's initial absence check.
    await fs.writeFile(path, foreign, { flag: 'wx' });
    if (collision === 'EACCES') throw Object.assign(Error('controlled link denial'), { code: collision });
    return originalLink(...args);
  };
  fs.rename = async (...args) => { renames++; return originalRename(...args); };
  syncBuiltinESMExports();
  t.after(() => { fs.link = originalLink; fs.rename = originalRename; syncBuiltinESMExports(); });
  await assert.rejects(f.handle.flush(), { code: collision });
  assert.equal(renames, 0);
  assert.deepEqual(await fs.readFile(path), foreign);
  assert.deepEqual((await fs.readdir(f.directory)).filter(name => name.endsWith('.tmp')), ['session.v4.jsonl.000000000000.tmp']);
  await f.handle.close();
});

test('an ENOSPC publication error is not converted into a rename attempt', async t => {
  const f = await fixture(t);
  const originalLink = fs.link, originalRename = fs.rename;
  const failure = Object.assign(Error('controlled link ENOSPC'), { code: 'ENOSPC' });
  let renames = 0;
  fs.link = async () => { throw failure; };
  fs.rename = async (...args) => { renames++; return originalRename(...args); };
  syncBuiltinESMExports();
  const restore = () => { fs.link = originalLink; fs.rename = originalRename; syncBuiltinESMExports(); };
  t.after(restore);
  await assert.rejects(f.handle.flush(), error => error === failure);
  assert.equal(renames, 0);
  assert(!(await fs.readdir(f.directory)).includes('session.v4.jsonl'));
  restore();
  await f.handle.flush();
  await f.handle.close();
});
