// Installed adapter entry, with real missing-object I/O and no provider traffic.
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

const prefix = process.env.DSH_TEST_PREFIX ?? process.env.DSH_PREFIX;
if (!prefix) throw new Error('Set DSH_TEST_PREFIX or DSH_PREFIX to a patched runtime');
const load = name => import(pathToFileURL(join(
  resolve(prefix), 'node_modules/@deepseek-ai', name, 'lib/index.js',
)));
const [
  { DeepSeekAdapter, resolveAdapterOptions },
  { AttachmentError },
  { LlmError },
  { readImageFile },
] = await Promise.all([
  load('dsh-llm-deepseek'), load('dsh-attachment'), load('dsh-llm'), load('dsh-attachment-local'),
]);

const image = Object.freeze({
  attachmentId: `sha256:${'a'.repeat(64)}`,
  mediaType: 'image/png', bytes: 1, width: 1, height: 1,
});

function fixture(t, read) {
  const calls = { reads: 0, auth: 0, fetch: 0 };
  t.mock.method(globalThis, 'fetch', async () => {
    calls.fetch++;
    throw new Error('Unexpected provider request');
  });
  const connection = resolveAdapterOptions({
    baseURL: 'https://attachment-fixture.invalid',
    models: [{ id: 'vision-fixture', inputModalities: ['text', 'image'] }],
  });
  const adapter = new DeepSeekAdapter({
    options: () => connection,
    // Only this service boundary is supplied; the missing-object case below
    // delegates to the installed attachment store's real filesystem reader.
    resolveAttachments: () => ({
      async readImageRequest(ref, _target, signal) {
        calls.reads++;
        return read(ref, signal);
      },
    }),
    resolveFiles: () => ({}), // Files operations wait for image preparation.
    resolveAuth: async () => {
      calls.auth++;
      throw new Error('Unexpected authentication');
    },
  });
  return {
    async consume() {
      for await (const _chunk of adapter.stream({
        provider: 'fixture', model: 'vision-fixture',
        messages: [{ role: 'user', content: [{ type: 'image', attachment: image }] }],
      })) assert.fail('Image preparation must fail before yielding provider output');
    },
    assertLocalFailure() {
      assert.deepEqual(calls, { reads: 1, auth: 0, fetch: 0 });
    },
  };
}

test('missing image object keeps its attachment diagnosis before auth or fetch', async t => {
  const root = await mkdtemp(join(tmpdir(), 'deepseek-missing-image-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'objects', 'aa'), { recursive: true });
  let original;
  const f = fixture(t, async (ref, signal) => {
    try { return await readImageFile(root, ref, signal); }
    catch (error) { original = error; throw error; }
  });
  await assert.rejects(f.consume(), error => {
    assert.ok(original instanceof AttachmentError);
    assert.equal(original.code, 'ATTACHMENT_NOT_FOUND');
    assert.equal(original.message, 'Attachment object is missing.');
    assert.ok(error instanceof LlmError);
    assert.equal(error.code, original.code);
    assert.equal(error.message, original.message);
    assert.equal(error.cause, original);
    assert.equal(error.failure.code, original.code);
    assert.equal(error.failure.message, original.message);
    return true;
  });
  f.assertLocalFailure();
});

test('an unrecognized preparation error keeps the existing TRANSPORT fallback', async t => {
  const original = new Error('Unclassified preparation failure');
  const f = fixture(t, async () => { throw original; });
  await assert.rejects(f.consume(), error => {
    assert.ok(error instanceof LlmError);
    assert.equal(error.code, 'TRANSPORT');
    assert.equal(error.message, 'DeepSeek Messages transport failed');
    assert.equal(error.cause, original);
    return true;
  });
  f.assertLocalFailure();
});

test('an existing LlmError wins even when its code also identifies an attachment error', async t => {
  const cause = new Error('Earlier cause');
  const original = new LlmError('Already classified', 'ATTACHMENT_NOT_FOUND', { cause });
  const failure = original.failure;
  const f = fixture(t, async () => { throw original; });
  await assert.rejects(f.consume(), error => {
    assert.equal(error, original);
    assert.equal(error.cause, cause);
    assert.equal(error.failure, failure);
    return true;
  });
  f.assertLocalFailure();
});
