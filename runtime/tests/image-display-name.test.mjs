import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

let loaded;
async function dependencies() {
  if (!loaded) {
    const prefix = process.env.DSH_TEST_PREFIX ?? process.env.DSH_PREFIX;
    if (!prefix) throw new Error('Set DSH_TEST_PREFIX or DSH_PREFIX');
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

const cases = [
  ['pair crossing 255', 'a'.repeat(254) + '🙂tail', 'a'.repeat(254)],
  ['complete pair within 255', 'a'.repeat(253) + '🙂tail', 'a'.repeat(253) + '🙂'],
  ['ASCII over cap', 'a'.repeat(260), 'a'.repeat(255)],
  ['short Unicode', '图片🙂.png', '图片🙂.png'],
  ['basename controls and trim', 'folder/other\\ \u0000图片🙂\u007f.png\n ', '图片🙂.png'],
  ['undefined name omitted', undefined, undefined],
  ['empty sanitized name omitted', 'folder/\u0000\u007f \n ', undefined],
];

for (const [label, name, expected] of cases) {
  test(`public image save/read display name: ${label}`, async t => {
    const { Context, LocalAttachmentStore, png } = await dependencies();
    const home = await mkdtemp(join(tmpdir(), 'dsh-image-name-'));
    const ctx = new Context();
    t.after(async () => {
      try {
        await ctx.fiber.dispose();
      } finally {
        await rm(home, { recursive: true, force: true });
      }
    });
    await ctx.plugin(LocalAttachmentStore, { dshHome: home }).await();
    const input = { data: png, mediaType: 'image/png', ...(name === undefined ? {} : { name }) };
    const bytesBefore = Buffer.from(png);
    const ref = await ctx.attachments.saveImage(input);
    const read = await ctx.attachments.readImage(ref);
    assert.deepEqual(Buffer.from(read.data), bytesBefore);
    assert.deepEqual(png, bytesBefore);
    assert.equal(input.name, name);
    assert.equal(ref.width, 2);
    assert.equal(ref.height, 2);
    assert.equal(ref.bytes, png.byteLength);
    assert.equal(ref.name, expected);
    assert.equal(Object.hasOwn(ref, 'name'), expected !== undefined);
    assert.deepEqual(read.ref, ref);
    if (expected !== undefined) {
      assert.equal(ref.name.isWellFormed(), true);
      assert.ok(ref.name.length <= 255);
    }
  });
}
