import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rename, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

let loaded;
async function api() {
  if (!loaded) {
    const prefix = process.env.DSH_TEST_PREFIX ?? process.env.DSH_PREFIX;
    if (!prefix) throw new Error('Set DSH_TEST_PREFIX or DSH_PREFIX to a prepared runtime');
    const load = name => import(pathToFileURL(join(resolve(prefix), 'node_modules/@deepseek-ai', name, 'lib/index.js')));
    loaded = Promise.all(['cordis', 'dsh-attachment-local', 'dsh-attachment'].map(load))
      .then(parts => Object.assign({}, ...parts));
  }
  return loaded;
}
async function fixture(t, conflict) {
  const a = await api();
  const home = await mkdtemp(join(tmpdir(), 'own-staging-contract-'));
  const ctx = new a.Context();
  t.after(async () => {
    try { await ctx.fiber.dispose(); }
    finally { await rm(home, { recursive: true, force: true }); }
  });
  let obstacle;
  if (conflict) {
    obstacle = join(home, ...conflict);
    await mkdir(dirname(obstacle), { recursive: true });
    await writeFile(obstacle, 'own original file');
  }
  await ctx.plugin(a.LocalAttachmentStore, { dshHome: home });
  assert.ok(ctx.attachments, 'service mounts before public storage calls');
  return { ...a, ctx, home, obstacle };
}
async function readExact(store, ref) {
  const chunks = [];
  for await (const chunk of store.readFileStream(ref)) chunks.push(chunk);
  return Buffer.concat(chunks);
}
const bytes = Buffer.from([0, 1, 255, 128, 65, 10]);

for (const conflict of [['attachments'], ['attachments', 'v1'], ['attachments', 'v1', 'tmp']]) {
  test(`public file admission classifies existing file at ${conflict.join('/')}`, async t => {
    const { ctx, home, obstacle, AttachmentError, admitEncodedFile } = await fixture(t, conflict);
    const failures = [];
    const operations = [
      () => ctx.attachments.saveFile({ data: bytes, name: 'own.bin' }),
      () => admitEncodedFile(ctx.attachments, { data: bytes.toString('base64'), name: 'own.bin' }),
    ];
    for (const operation of operations) {
      try { await operation(); assert.fail('conflict must reject'); }
      catch (error) { failures.push(error); }
      assert.equal(await readFile(obstacle, 'utf8'), 'own original file');
    }
    await rename(obstacle, join(home, 'preserved-original'));
    const recovered = await admitEncodedFile(ctx.attachments, { data: bytes.toString('base64'), name: 'own.bin' });
    assert.deepEqual(await readExact(ctx.attachments, recovered), bytes);
    assert.equal(await readFile(join(home, 'preserved-original'), 'utf8'), 'own original file');
    for (const error of failures) {
      assert.equal(error instanceof AttachmentError, true, `received ${error.constructor.name}/${error.code}`);
      assert.equal(error.code, 'ATTACHMENT_WRITE_FAILED');
      assert.ok(['EEXIST', 'ENOTDIR'].includes(error.cause?.code));
    }
  });
}

test('normal binary and streamed files retain exact bytes and no temporary file', async t => {
  const { ctx, home } = await fixture(t);
  const ordinary = await ctx.attachments.saveFile({ data: bytes, name: 'own.bin' });
  const streamed = await ctx.attachments.saveFileStream({
    name: 'stream.bin',
    data: (async function* () { yield bytes.subarray(0, 2); yield bytes.subarray(2); })(),
  });
  assert.deepEqual(await readExact(ctx.attachments, ordinary), bytes);
  assert.deepEqual(await readExact(ctx.attachments, streamed), bytes);
  assert.equal(ordinary.attachmentId, streamed.attachmentId);
  assert.deepEqual(await readdir(join(home, 'attachments', 'v1', 'tmp')), []);
});

test('pre-cancelled public stream preserves exact reason and temporary cleanup', async t => {
  const { ctx, home } = await fixture(t);
  const reason = new Error('own caller cancelled');
  const controller = new AbortController();
  controller.abort(reason);
  await assert.rejects(ctx.attachments.saveFileStream({
    name: 'cancelled.bin', signal: controller.signal,
    data: (async function* () { yield bytes; })(),
  }), error => error === reason);
  assert.deepEqual(await readdir(join(home, 'attachments', 'v1', 'tmp')), []);
});
