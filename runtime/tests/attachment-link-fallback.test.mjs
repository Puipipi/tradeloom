// Public attachment storage with controlled link denial and real temporary-file I/O.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import nativeFs from 'node:fs';
import { createHash } from 'node:crypto';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

let loaded;
async function dependencies() {
  if (!loaded) {
    const prefix = process.env.DSH_TEST_PREFIX ?? process.env.DSH_PREFIX;
    if (!prefix) throw new Error('Set DSH_TEST_PREFIX or DSH_PREFIX to a patched runtime');
    const root = resolve(prefix);
    const load = name => import(pathToFileURL(join(root, 'node_modules/@deepseek-ai', name, 'lib/index.js')));
    loaded = Promise.all([load('cordis'), load('dsh-attachment-local')]).then(async ([{ Context }, { LocalAttachmentStore }]) => {
      const sharp = createRequire(join(root, 'package.json'))('sharp');
      const png = await sharp({ create: { width: 2, height: 2, channels: 3, background: { r: 100, g: 120, b: 140 } } }).png().toBuffer();
      return { Context, LocalAttachmentStore, png };
    });
  }
  return loaded;
}
const data = Buffer.from([0, 1, 2, 255, 128, 65, 10]);
const digest = createHash('sha256').update(data).digest('hex');
const failure = code => Object.assign(new Error(`controlled ${code}`), { code });

async function fixture(t) {
  const { Context, LocalAttachmentStore, png } = await dependencies();
  const home = await fs.mkdtemp(join(tmpdir(), 'attachment-no-link-'));
  const root = join(home, 'attachments', 'v1'), temporary = join(root, 'tmp');
  const contexts = [];
  t.after(async () => {
    t.mock.restoreAll(); syncBuiltinESMExports();
    try { for (const ctx of contexts) await ctx.fiber.dispose(); }
    finally { await fs.rm(home, { recursive: true, force: true }); }
  });
  const another = async () => {
    const ctx = new Context(); contexts.push(ctx);
    await ctx.plugin(LocalAttachmentStore, { dshHome: home }).await();
    return ctx.attachments;
  };
  const store = await another();
  await fs.mkdir(temporary, { recursive: true });
  await fs.writeFile(join(temporary, 'foreign'), 'unrelated temporary');
  return { root, store, another, png, temporary,
    object: join(root, 'file-objects', digest.slice(0, 2), digest),
    alias: name => join(root, 'files', digest.slice(0, 2), digest, name),
    async clean() {
      assert.deepEqual(await fs.readdir(temporary), ['foreign']);
      assert.equal(await fs.readFile(join(temporary, 'foreign'), 'utf8'), 'unrelated temporary');
    },
  };
}
function denyLinks(t, code) {
  t.mock.method(fs, 'link', async () => { throw failure(code); });
  syncBuiltinESMExports();
}
async function readFile(store, ref) {
  const chunks = [];
  for await (const chunk of store.readFileStream(ref)) chunks.push(chunk);
  return Buffer.concat(chunks);
}

for (const code of ['EACCES', 'EPERM']) test(`${code}: files, streams and normalized images publish without links`, async t => {
  const f = await fixture(t);
  denyLinks(t, code);
  const first = await f.store.saveFile({ data, name: 'first.bin' });
  const streamed = await f.store.saveFileStream({ name: 'stream.bin', data: (async function* () {
    yield data.subarray(0, 3); yield data.subarray(3);
  })() });
  assert.equal(first.attachmentId, streamed.attachmentId);
  assert.deepEqual(await readFile(f.store, first), data);
  assert.deepEqual(await readFile(f.store, streamed), data);
  assert.deepEqual(await fs.readFile(f.object), data, 'publishing an alias must retain the canonical object');
  assert.equal(await fs.realpath(f.alias('first.bin')), f.alias('first.bin'));
  assert.deepEqual(await f.store.saveFile({ data, name: 'first.bin' }), first, 'existing valid names deduplicate');
  const image = await f.store.saveImage({ data: f.png, mediaType: 'image/png' });
  assert.deepEqual(Buffer.from((await f.store.readImage(image)).data), f.png);
  if (process.platform !== 'win32') assert.equal((await fs.stat(f.alias('first.bin'))).mode & 0o777, 0o400);
  await f.clean();
});

test('ordinary publication still uses hard links without rename', async t => {
  const f = await fixture(t), link = fs.link, rename = fs.rename;
  let links = 0, renames = 0;
  t.mock.method(fs, 'link', async (...args) => { links++; return link(...args); });
  t.mock.method(fs, 'rename', async (...args) => { renames++; return rename(...args); });
  syncBuiltinESMExports();
  const ref = await f.store.saveFile({ data, name: 'ordinary.bin' });
  assert.equal(links, 2); assert.equal(renames, 0);
  assert.deepEqual(await readFile(f.store, ref), data);
  await f.clean();
});

test('independent stores may both observe absence before publishing identical content', { timeout: 5000 }, async t => {
  const f = await fixture(t), other = await f.another(), rename = fs.rename;
  const gates = new Map([f.object, f.alias('same.bin')].map(path => [path, { arrived: 0, ready: Promise.withResolvers() }]));
  t.after(() => { for (const gate of gates.values()) gate.ready.resolve(); });
  denyLinks(t, 'EACCES');
  t.mock.method(fs, 'rename', async (from, to) => {
    const gate = gates.get(String(to));
    if (gate) {
      if (++gate.arrived === 2) gate.ready.resolve();
      await gate.ready.promise;
    }
    return rename(from, to);
  });
  syncBuiltinESMExports();
  const refs = await Promise.all([f.store, other].map(store => store.saveFile({ data, name: 'same.bin' })));
  assert.deepEqual(refs[0], refs[1]);
  for (const gate of gates.values()) assert.equal(gate.arrived, 2);
  assert.deepEqual(await fs.readFile(f.object), data);
  assert.deepEqual(await readFile(other, refs[0]), data);
  await f.clean();
});

for (const kind of ['object', 'alias']) test(`an existing corrupt ${kind} is not replaced`, async t => {
  const f = await fixture(t);
  denyLinks(t, 'EACCES');
  if (kind === 'alias') await f.store.saveFile({ data, name: 'good.bin' });
  const target = kind === 'object' ? f.object : f.alias('bad.bin');
  await fs.mkdir(dirname(target), { recursive: true });
  await fs.writeFile(target, 'wrong bytes');
  await assert.rejects(f.store.saveFile({ data, name: 'bad.bin' }), { code: 'ATTACHMENT_CORRUPT' });
  assert.equal(await fs.readFile(target, 'utf8'), 'wrong bytes');
  if (kind === 'alias') assert.deepEqual(await fs.readFile(f.object), data);
  await f.clean();
});

for (const code of ['ENOSPC', 'EIO']) test(`${code} from link is not treated as unavailable hard links`, async t => {
  const f = await fixture(t), link = fs.link, rename = fs.rename;
  let fail = true, renames = 0;
  t.mock.method(fs, 'link', async (...args) => { if (fail) throw failure(code); return link(...args); });
  t.mock.method(fs, 'rename', async (...args) => { renames++; return rename(...args); });
  syncBuiltinESMExports();
  await assert.rejects(f.store.saveFile({ data, name: 'retry.bin' }), error => error.code === 'ATTACHMENT_WRITE_FAILED' && error.cause?.code === code);
  assert.equal(renames, 0); await f.clean();
  fail = false;
  const ref = await f.store.saveFile({ data, name: 'retry.bin' });
  assert.deepEqual(await readFile(f.store, ref), data);
  await f.clean();
});

test('failure before alias staging leaves no open source stream and can retry', async t => {
  const f = await fixture(t), open = fs.open, createReadStream = nativeFs.createReadStream;
  const streams = [];
  let injected = false;
  denyLinks(t, 'EACCES');
  t.mock.method(nativeFs, 'createReadStream', (path, ...args) => {
    const stream = createReadStream(path, ...args);
    if (String(path) === f.object) streams.push(stream);
    return stream;
  });
  t.mock.method(fs, 'open', async (path, ...args) => {
    if (!injected && String(path).startsWith(f.temporary + sep) && await fs.stat(f.object).then(() => true, () => false)) {
      injected = true;
      throw failure('ENOSPC');
    }
    return open(path, ...args);
  });
  syncBuiltinESMExports();
  try {
    await assert.rejects(f.store.saveFile({ data, name: 'retry.bin' }), error => error.code === 'ATTACHMENT_WRITE_FAILED' && error.cause?.code === 'ENOSPC');
    assert.equal(injected, true);
    await new Promise(resolve => setImmediate(resolve));
    assert.ok(streams.every(stream => stream.destroyed), 'failed staging must not leave an unconsumed source open');
    assert.deepEqual(await fs.readFile(f.object), data);
    await assert.rejects(fs.stat(f.alias('retry.bin')), { code: 'ENOENT' });
    await f.clean();
    const ref = await f.store.saveFile({ data, name: 'retry.bin' });
    assert.deepEqual(await readFile(f.store, ref), data);
    await f.clean();
  } finally {
    await Promise.all(streams.filter(stream => !stream.closed).map(stream => new Promise(resolve => {
      stream.once('close', resolve); stream.destroy();
    })));
  }
});

test('partial alias-copy failure preserves its source and a later save recovers', async t => {
  const f = await fixture(t), open = fs.open;
  let injected = false;
  denyLinks(t, 'EACCES');
  t.mock.method(fs, 'open', async (path, ...args) => {
    const handle = await open(path, ...args);
    if (!injected && String(path).startsWith(f.temporary + sep) && await fs.stat(f.object).then(() => true, () => false)) {
      injected = true;
      const write = handle.writeFile.bind(handle);
      handle.writeFile = async chunk => { await write(chunk.subarray(0, 2)); throw failure('ENOSPC'); };
    }
    return handle;
  });
  syncBuiltinESMExports();
  await assert.rejects(f.store.saveFile({ data, name: 'retry.bin' }), error => error.code === 'ATTACHMENT_WRITE_FAILED' && error.cause?.code === 'ENOSPC');
  assert.equal(injected, true);
  assert.deepEqual(await fs.readFile(f.object), data);
  await assert.rejects(fs.stat(f.alias('retry.bin')), { code: 'ENOENT' });
  await f.clean();
  const ref = await f.store.saveFile({ data, name: 'retry.bin' });
  assert.deepEqual(await readFile(f.store, ref), data);
  await f.clean();
});

test('failed alias rename cleans only its stage and can retry', async t => {
  const f = await fixture(t), rename = fs.rename;
  let injected = false;
  denyLinks(t, 'EPERM');
  t.mock.method(fs, 'rename', async (from, to) => {
    if (!injected && String(to) === f.alias('retry.bin')) { injected = true; throw failure('ENOSPC'); }
    return rename(from, to);
  });
  syncBuiltinESMExports();
  await assert.rejects(f.store.saveFile({ data, name: 'retry.bin' }), error => error.code === 'ATTACHMENT_WRITE_FAILED' && error.cause?.code === 'ENOSPC');
  assert.equal(injected, true);
  assert.deepEqual(await fs.readFile(f.object), data);
  await assert.rejects(fs.stat(f.alias('retry.bin')), { code: 'ENOENT' });
  await f.clean();
  const ref = await f.store.saveFile({ data, name: 'retry.bin' });
  assert.deepEqual(await readFile(f.store, ref), data);
  await f.clean();
});
