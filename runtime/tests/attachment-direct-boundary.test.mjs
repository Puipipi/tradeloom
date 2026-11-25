// Real directory permissions and the public file attachment API; no injected errno.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, parse, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createPaths } from '../direct/paths.mjs';

const direct = Symbol.for('dsh.go.direct');
const permissions = { skip: process.platform === 'win32' || process.getuid?.() === 0
  ? 'requires non-root POSIX DAC permissions' : false };
const bytes = Buffer.from('attachment content after an installed-root barrier');
let loaded;
async function createStore(home, contexts) {
  if (!loaded) {
    const prefix = process.env.DSH_TEST_PREFIX ?? process.env.DSH_PREFIX;
    if (!prefix) throw new Error('Set DSH_TEST_PREFIX or DSH_PREFIX to a patched runtime');
    const load = name => import(pathToFileURL(join(resolve(prefix), 'node_modules/@deepseek-ai', name, 'lib/index.js')));
    loaded = Promise.all([load('cordis'), load('dsh-attachment-local')]);
  }
  const [{ Context }, { LocalAttachmentStore }] = await loaded;
  const ctx = new Context();
  contexts.push(ctx);
  await ctx.plugin(LocalAttachmentStore, { dshHome: home }).await();
  return ctx.attachments;
}

async function fixture(t, { mounted = false, enabled = true } = {}) {
  const temporary = await fs.mkdtemp(join(tmpdir(), 'attachment-direct-boundary-'));
  const outside = join(temporary, 'traversable-only');
  const rootfs = join(outside, 'rootfs');
  const external = join(outside, 'rootfs-external');
  const home = mounted ? join(external, '.dsh') : join(rootfs, 'root', 'new-parent', '.dsh');
  const previous = globalThis[direct], restricted = [], contexts = [];
  t.after(async () => {
    t.mock.restoreAll(); syncBuiltinESMExports();
    for (const path of restricted) await fs.chmod(path, 0o700);
    for (const ctx of contexts) await ctx.fiber.dispose();
    if (previous === undefined) delete globalThis[direct]; else globalThis[direct] = previous;
    await fs.rm(temporary, { recursive: true, force: true });
  });
  await fs.mkdir(rootfs, { recursive: true });
  if (mounted) await fs.mkdir(external);
  // The app establishes this barrier before publishing its installed version.
  // Create DSH_HOME below it only later, during the first actual save.
  for (const path of [rootfs, outside, temporary, dirname(temporary)]) {
    const handle = await fs.open(path, 'r');
    try { await handle.sync(); } finally { await handle.close(); }
  }
  if (enabled) globalThis[direct] = Object.freeze(createPaths(rootfs,
    mounted ? [{ host: external, guest: external }] : []));
  else delete globalThis[direct];
  async function restrict(path) { await fs.chmod(path, 0o111); restricted.push(path); }
  await restrict(outside);
  const store = await createStore(home, contexts);
  const save = () => store.saveFile({ data: bytes, name: 'saved.bin' });
  const read = async ref => {
    const chunks = [];
    for await (const chunk of store.readFileStream(ref)) chunks.push(chunk);
    return Buffer.concat(chunks);
  };
  return { rootfs, outside, home, restrict, save, read };
}

function traceStorage(t) {
  const opened = [], synced = [], failed = [], original = fs.open;
  t.mock.method(fs, 'open', async (path, ...args) => {
    opened.push(String(path));
    let handle;
    try { handle = await original(path, ...args); }
    catch (error) { failed.push({ path: String(path), code: error.code }); throw error; }
    const sync = handle.sync.bind(handle);
    handle.sync = async () => { await sync(); synced.push(String(path)); };
    return handle;
  });
  syncBuiltinESMExports();
  return { opened, synced, failed };
}

test('a first Direct attachment syncs new home ancestors through rootfs without opening its unreadable parent', permissions, async t => {
  const f = await fixture(t), trace = traceStorage(t);
  const ref = await f.save();
  assert.deepEqual(await f.read(ref), bytes);
  assert.deepEqual(trace.synced.slice(0, 3), [dirname(f.home), dirname(dirname(f.home)), f.rootfs]);
  assert.equal(trace.opened.includes(f.outside), false);
  assert.deepEqual(trace.failed, []);
});

test('a failed Direct home barrier is not cached and a later attachment save can retry', permissions, async t => {
  const f = await fixture(t), trace = traceStorage(t);
  const inside = dirname(f.home);
  await fs.mkdir(f.home, { recursive: true });
  await f.restrict(inside);
  await assert.rejects(f.save(), error => error.code === 'ATTACHMENT_WRITE_FAILED' && error.cause?.code === 'EACCES');
  assert.deepEqual(trace.failed, [{ path: inside, code: 'EACCES' }]);
  await assert.rejects(fs.stat(join(f.home, 'attachments')), { code: 'ENOENT' });
  await fs.chmod(inside, 0o700);
  assert.deepEqual(await f.read(await f.save()), bytes);
  assert.ok(trace.synced.includes(f.rootfs));
  assert.equal(trace.opened.includes(f.outside), false);
});

test('without Direct an attachment still requires the full ancestor barrier', permissions, async t => {
  const f = await fixture(t, { enabled: false }), trace = traceStorage(t);
  await assert.rejects(f.save(), error => error.code === 'ATTACHMENT_WRITE_FAILED' && error.cause?.code === 'EACCES');
  assert.deepEqual(trace.failed, [{ path: f.outside, code: 'EACCES' }]);
  await fs.chmod(f.outside, 0o700);
  assert.deepEqual(await f.read(await f.save()), bytes);
  assert.ok(trace.synced.includes(parse(f.home).root));
});

test('a Direct external home with a rootfs name prefix retains the full ancestor barrier', permissions, async t => {
  const f = await fixture(t, { mounted: true }), trace = traceStorage(t);
  await assert.rejects(f.save(), error => error.code === 'ATTACHMENT_WRITE_FAILED' && error.cause?.code === 'EACCES');
  assert.deepEqual(trace.failed, [{ path: f.outside, code: 'EACCES' }]);
  await fs.chmod(f.outside, 0o700);
  assert.deepEqual(await f.read(await f.save()), bytes);
  assert.ok(trace.synced.includes(parse(f.home).root));
  assert.equal(trace.synced.includes(f.rootfs), false);
});
