// Public real JSON backend/domain, temporary files, actual POSIX permission failures.
// DSH_PREFIX=<isolated patched prefix> node --test 2108-storage-postpublish.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, chmod, open, rename, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
if (!process.env.DSH_PREFIX) throw Error('Set DSH_PREFIX to an isolated actual runtime prefix');
const prefix = resolve(process.env.DSH_PREFIX);
const load = name => import(pathToFileURL(join(prefix, 'node_modules/@deepseek-ai', name, 'lib/index.js')));
const { JsonStorageBackend } = await load('dsh-storage-json');
const { Storage } = await load('dsh-storage');
const { Context } = await load('cordis');
const json = await load('dsh-storage-json');
const domain = await load('dsh-storage-domain');
const { z } = createRequire(join(prefix, 'package.json'))('zod');
const skip = process.platform === 'win32' || process.getuid?.() === 0
  ? 'Requires ordinary non-root POSIX user; no permission emulation or privilege changes' : false;
const descriptor = layout => ({ name: 'uncertain', version: 1, layout, tables: ['rows'], hasGlobal: false });
const parentFor = (root, layout) => layout === 'single' ? root : join(root, 'uncertain', 'rows');
const fileFor = (root, layout) => layout === 'single' ? join(root, 'uncertain.json') : join(parentFor(root, layout), 'a.json');

async function proveNoRead(t, parent) {
  await chmod(parent, 0o300);
  const from = join(parent, 'permission_probe'), to = join(parent, 'permission_probe_moved');
  const handle = await open(from, 'wx', 0o600);
  try { await handle.writeFile('probe'); await handle.sync(); } finally { await handle.close(); }
  await rename(from, to);
  assert.equal(await readFile(to, 'utf8'), 'probe');
  await rm(to);
  try {
    const directory = await open(parent, 'r');
    await directory.close();
    t.skip('Actual directory read permission remains available; boundary not exercised');
    return false;
  } catch (error) {
    assert.equal(error.code, 'EACCES');
    return true;
  }
}
async function uncertain(operation, publishedPath) {
  const result = await operation.then(() => ({ ok: true }), error => ({ error }));
  assert.equal(result.ok, undefined, 'publication completion must reject');
  // Establish actual rename effects before the expected baseline failure on classification.
  assert.match(await readFile(publishedPath, 'utf8'), /"n": 2/);
  assert.equal(result.error?.code, 'unknown-state', 'published bytes confirmed; failure must quarantine the handle');
  assert.equal(result.error.cause?.code, 'EACCES');
  return result.error;
}

for (const layout of ['single', 'per-record']) {
  test(`real ${layout} unit rejects after published replacement and reopens actual bytes`, { skip }, async t => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-2108-unit-'));
    const backend = new JsonStorageBackend(root);
    const parent = parentFor(root, layout);
    t.after(async () => { await chmod(parent, 0o700); await backend.close(); await rm(root, { recursive: true, force: true }); });
    const unit = await backend.kv.open(descriptor(layout));
    await unit.putRecord('rows', 'a', { n: 1 });
    assert.deepEqual((await unit.loadAll()).tables.rows.a, { n: 1 });
    if (!await proveNoRead(t, parent)) return;
    const error = await uncertain(unit.putRecord('rows', 'a', { n: 2 }), fileFor(root, layout));
    assert.match(await readFile(fileFor(root, layout), 'utf8'), /"n": 2/);
    await assert.rejects(unit.loadAll(), candidate => candidate === error);
    await assert.rejects(unit.putRecord('rows', 'b', { n: 3 }), candidate => candidate === error);
    await chmod(parent, 0o700);
    await unit.close();
    const recovered = await backend.kv.open(descriptor(layout));
    assert.deepEqual((await recovered.loadAll()).tables.rows, { a: { n: 2 } });
  });

  test(`real ${layout} domain rejects queued write and reads after uncertain publication`, { skip }, async t => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-2108-domain-'));
    const ctx = new Context();
    const parent = parentFor(root, layout);
    t.after(async () => { await chmod(parent, 0o700); await ctx.fiber.dispose(); await rm(root, { recursive: true, force: true }); });
    await ctx.plugin(Storage).await();
    await ctx.plugin(json, { root }).await();
    await ctx.plugin(domain, { backend: 'json' }).await();
    const spec = domain.defineDomain({ name: 'uncertain', version: 1, layout,
      tables: { rows: { valueSchema: z.object({ n: z.number() }) } } });
    const value = await ctx.storageDomain.open(spec);
    await value.table('rows').put('a', { n: 1 });
    if (!await proveNoRead(t, parent)) return;
    // Both submissions precede the first queued operation's asynchronous publish completion.
    const first = value.table('rows').put('a', { n: 2 });
    const queued = value.table('rows').put('b', { n: 3 });
    const queuedResult = queued.then(() => ({ ok: true }), error => ({ error }));
    const error = await uncertain(first, fileFor(root, layout));
    assert.equal((await queuedResult).error, error);
    assert.throws(() => value.table('rows').get('a'), candidate => candidate === error);
    assert.match(await readFile(fileFor(root, layout), 'utf8'), /"n": 2/);
    await chmod(parent, 0o700);
    await value.close();
    const recovered = await ctx.storageDomain.open(spec);
    assert.deepEqual([...recovered.table('rows').entries()], [['a', { n: 2 }]]);
  });
}

test('ordinary prepublication permission failure remains retryable', { skip }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-2108-prepublish-'));
  const backend = new JsonStorageBackend(root);
  t.after(async () => { await chmod(root, 0o700); await backend.close(); await rm(root, { recursive: true, force: true }); });
  const unit = await backend.kv.open(descriptor('single'));
  await unit.putRecord('rows', 'a', { n: 1 });
  await chmod(root, 0o500);
  let denied = false;
  try { const h = await open(join(root, 'permission_probe'), 'wx'); await h.close(); }
  catch (error) { assert.equal(error.code, 'EACCES'); denied = true; }
  if (!denied) { t.skip('Actual directory write permission remains available'); return; }
  await assert.rejects(unit.putRecord('rows', 'a', { n: 2 }), error => error.code === 'EACCES');
  assert.deepEqual((await unit.loadAll()).tables.rows.a, { n: 1 });
  await chmod(root, 0o700);
  await unit.putRecord('rows', 'a', { n: 3 });
  assert.deepEqual((await unit.loadAll()).tables.rows.a, { n: 3 });
});
