import test from 'node:test';
import assert from 'node:assert/strict';
import fs, { chmod, mkdir, mkdtemp, open, readdir, rm } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, parse } from 'node:path';
import { createPaths } from '../../../direct/paths.mjs';
import { createBudgetLedger } from '../src/budget-ledger.js';

// Exercise real DAC failures. Root bypasses mode bits; Windows has no
// equivalent POSIX directory read/search permission contract.
const permissions = { skip: process.platform === 'win32' || process.getuid?.() === 0
  ? 'requires non-root POSIX DAC permissions' : false };
const direct = Symbol.for('dsh.go.direct');

async function fixture(t, position = 'inside') {
  const temporary = await mkdtemp(join(tmpdir(), 'budget-direct-boundary-'));
  const outside = join(temporary, 'traversable-only');
  const rootfs = join(outside, 'rootfs');
  const directory = position === 'root' ? rootfs
    : position === 'external' ? join(outside, 'external-state', 'budget')
    : position === 'sibling' ? join(outside, 'rootfs-copy', 'budget')
    : join(rootfs, 'root', '.dsh', 'media', 'dsh-media', 'budget');
  const previous = globalThis[direct], restricted = [];
  t.after(async () => {
    if (previous === undefined) delete globalThis[direct]; else globalThis[direct] = previous;
    for (const path of restricted) await chmod(path, 0o700);
    await rm(temporary, { recursive: true, force: true });
  });
  await mkdir(rootfs, { recursive: true, mode: 0o700 });
  // Model the installer's established rootfs barrier before creating any
  // ledger ancestors. A workspace/cwd has no corresponding guarantee.
  for (let path = rootfs; ; path = dirname(path)) {
    const handle = await open(path, 'r');
    try { await handle.sync(); } finally { await handle.close(); }
    if (dirname(path) === path) break;
  }
  if (position === 'external' || position === 'sibling') {
    await mkdir(dirname(directory), { recursive: true, mode: 0o700 });
  }
  globalThis[direct] = Object.freeze(createPaths(rootfs,
    position === 'external' ? [{ host: dirname(directory), guest: '/mnt/state' }] : []));
  async function restrict(path) { await chmod(path, 0o111); restricted.push(path); }
  await restrict(outside);
  return { outside, rootfs, directory, restrict, ledger: createBudgetLedger(directory) };
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

test('Direct budget syncs every new private ancestor through rootfs without opening its unreadable parent', permissions, async t => {
  const f = await fixture(t), trace = traceStorage(t);
  const state = await f.ledger.snapshot();
  assert.deepEqual(state.requests, []);
  const expected = [f.directory, join(f.rootfs, 'root', '.dsh', 'media', 'dsh-media'),
    join(f.rootfs, 'root', '.dsh', 'media'), join(f.rootfs, 'root', '.dsh'), join(f.rootfs, 'root'), f.rootfs];
  assert.deepEqual(trace.synced.slice(0, expected.length), expected);
  assert.equal(trace.opened.includes(f.outside), false);
  assert.ok(trace.failed.every(error => error.code === 'ENOENT'));
  assert.deepEqual((await readdir(f.directory)).sort(), ['initialized-v1.json', 'ledger-v1.json']);
});

test('an unreadable ancestor inside Direct rootfs still rejects before initialization and allows retry', permissions, async t => {
  const f = await fixture(t), trace = traceStorage(t);
  // A previous creator left the full directory chain, but no durable ledger.
  await mkdir(f.directory, { recursive: true, mode: 0o700 });
  const inside = join(f.rootfs, 'root', '.dsh');
  await f.restrict(inside);
  await assert.rejects(f.ledger.snapshot(), { code: 'durability_unavailable' });
  assert.deepEqual(trace.failed, [{ path: inside, code: 'EACCES' }]);
  assert.deepEqual(await readdir(f.directory), []);
  await chmod(inside, 0o700);
  assert.equal((await f.ledger.snapshot()).v, 1);
  assert.ok(trace.synced.includes(f.rootfs));
  assert.equal(trace.opened.includes(f.outside), false);
});

test('without Direct the budget retains the full ancestor barrier and recovers when permissions return', permissions, async t => {
  const f = await fixture(t), trace = traceStorage(t);
  delete globalThis[direct];
  await assert.rejects(f.ledger.snapshot(), { code: 'durability_unavailable' });
  assert.deepEqual(trace.failed, [{ path: f.outside, code: 'EACCES' }]);
  assert.deepEqual(await readdir(f.directory), []);
  await chmod(f.outside, 0o700);
  assert.equal((await f.ledger.snapshot()).v, 1);
  assert.ok(trace.synced.includes(parse(f.directory).root));
});

for (const position of ['external', 'sibling']) {
  test(`a Direct ${position} budget retains the full barrier outside the physical rootfs`, permissions, async t => {
    const f = await fixture(t, position), trace = traceStorage(t);
    await assert.rejects(f.ledger.snapshot(), { code: 'durability_unavailable' });
    assert.deepEqual(trace.failed, [{ path: f.outside, code: 'EACCES' }]);
    assert.deepEqual(await readdir(f.directory), []);
    await chmod(f.outside, 0o700);
    assert.equal((await f.ledger.snapshot()).v, 1);
    assert.ok(trace.synced.includes(parse(f.directory).root));
    assert.equal(trace.synced.includes(f.rootfs), false);
  });
}

test('a budget located at Direct rootfs still syncs that directory before stopping', permissions, async t => {
  const f = await fixture(t, 'root'), trace = traceStorage(t);
  assert.equal((await f.ledger.snapshot()).v, 1);
  assert.equal(trace.synced[0], f.rootfs);
  assert.equal(trace.opened.includes(f.outside), false);
  assert.ok(trace.failed.every(error => error.code === 'ENOENT'));
});
