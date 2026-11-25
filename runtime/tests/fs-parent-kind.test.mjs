// DSH_TEST_PREFIX=/absolute/prepared-prefix node --test runtime/tests/fs-parent-kind.test.mjs
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';

const prefix = process.env.DSH_TEST_PREFIX ?? process.env.DSH_PREFIX;
let modules;
async function runtime() {
  modules ??= (async () => {
    const load = name => import(pathToFileURL(join(resolve(prefix), 'node_modules/@deepseek-ai', name, 'lib/index.js')));
    const [{ Context }, { LocalFileSystem }, { FsError }] = await Promise.all([
      load('cordis'), load('dsh-fs-local'), load('dsh-fs'),
    ]);
    return { Context, LocalFileSystem, FsError };
  })();
  return modules;
}

const text = 'ordinary 中文🙂\n';
const readers = [
  ['readText', (fs, target) => fs.readText(target)],
  ['streamText', async (fs, target) => {
    let result = '';
    for await (const chunk of await fs.streamText(target)) result += chunk;
    return result;
  }],
  ['readBytes', async (fs, target) => Buffer.from(await fs.readBytes(target, undefined, 128)).toString('utf8')],
  ['readByteRange', async (fs, target) => Buffer.from(await fs.readByteRange(target, { offset: 0, length: 128 })).toString('utf8')],
];

async function fixture(t) {
  if (!prefix) {
    t.skip('Set DSH_TEST_PREFIX or DSH_PREFIX to a prepared runtime prefix.');
    return undefined;
  }
  const { Context, LocalFileSystem, FsError } = await runtime();
  const root = await mkdtemp(join(tmpdir(), 'dsh-parent-kind-'));
  const ctx = new Context();
  t.after(async () => {
    try { await ctx.fiber.dispose(); }
    finally { await rm(root, { recursive: true, force: true }); }
  });
  await mkdir(join(root, 'parent'));
  await writeFile(join(root, 'parent', 'file.txt'), text);
  await ctx.plugin(LocalFileSystem, { cwd: root });
  const target = await ctx.fs.resolve('parent/file.txt');
  return { root, fs: ctx.fs, target, FsError };
}

for (const [name, read] of readers) {
  test(`${name}: resolved parent becoming a file is typed missing, then restores`, async t => {
    const f = await fixture(t);
    if (!f) return;
    const { fs, target, root, FsError } = f;
    assert.equal(await read(fs, target), text);
    await rename(join(root, 'parent'), join(root, 'saved-parent'));
    await writeFile(join(root, 'parent'), 'ordinary replacement');
    let failure;
    try { await read(fs, target); }
    catch (error) { failure = error; }
    assert.equal(await readFile(join(root, 'parent'), 'utf8'), 'ordinary replacement');
    assert.equal(await readFile(join(root, 'saved-parent', 'file.txt'), 'utf8'), text);
    await rm(join(root, 'parent'));
    await rename(join(root, 'saved-parent'), join(root, 'parent'));
    assert.equal(await read(fs, target), text, 'The same public target reads after normal restoration.');
    assert(failure instanceof FsError, `Expected FsError; got ${failure?.constructor.name}/${failure?.code}`);
    assert.equal(failure.code, 'FS_NOT_FOUND');
  });

  test(`${name}: existing ENOENT classification remains unchanged`, async t => {
    const f = await fixture(t);
    if (!f) return;
    await rm(join(f.root, 'parent', 'file.txt'));
    await assert.rejects(read(f.fs, f.target), error => error instanceof f.FsError && error.code === 'FS_NOT_FOUND');
  });

  test(`${name}: an actual directory remains not a regular file`, async t => {
    const f = await fixture(t);
    if (!f) return;
    const directory = await f.fs.resolve('parent');
    await assert.rejects(read(f.fs, directory), error => error instanceof f.FsError && error.code === 'FS_NOT_REGULAR_FILE');
  });
}
