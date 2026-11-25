import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

const bom = '\ufeff';
let modules;
async function fixture(t, text, config = {}) {
  if (!modules) {
    const require = createRequire(resolve(process.env.DSH_TEST_PREFIX ?? process.env.DSH_PREFIX, 'package.json'));
    modules = await Promise.all([
      import(pathToFileURL(require.resolve('@deepseek-ai/cordis'))),
      import(pathToFileURL(require.resolve('@deepseek-ai/dsh-fs-local'))),
    ]);
  }
  const [{ Context }, { LocalFileSystem }] = modules;
  const root = await mkdtemp(join(tmpdir(), 'dsh-fs-bom-'));
  const ctx = new Context();
  t.after(async () => { await ctx.fiber.dispose(); await rm(root, { recursive: true, force: true }); });
  await ctx.plugin(LocalFileSystem, { cwd: root, ...config });
  const fs = ctx.fs;
  const target = await fs.resolve('source.txt');
  await writeFile(target.targetKey, text, 'utf8');
  return { fs, target, read: () => readFile(target.targetKey), expected: { version: (await fs.stat(target)).version } };
}
const hunk = (oldLines, newLines) => [{ lineNumber: 1, oldLines, newLines, isEndOfFile: false }];
const bytes = (actual, expected) => assert.deepEqual(actual, Buffer.from(expected, 'utf8'));

for (const newline of ['\n', '\r\n']) test(`literal edit keeps a UTF-8 BOM with ${JSON.stringify(newline)}`, async t => {
  const f = await fixture(t, bom + `alpha${newline}中文🙂${newline}`);
  assert.equal(await f.fs.readText(f.target), `alpha${newline}中文🙂${newline}`);
  const result = await f.fs.editText(f.target, { oldString: 'alpha', newString: 'beta', replaceAll: false }, f.expected);
  bytes(await f.read(), bom + `beta${newline}中文🙂${newline}`);
  assert.equal(result.before, 'alpha\n中文🙂\n');
  assert.equal(result.after, 'beta\n中文🙂\n');
  assert.equal(result.version, (await f.fs.stat(f.target)).version);
});

test('replace-all preserves BOM while replacing every ordinary occurrence', async t => {
  const f = await fixture(t, bom + 'alpha\r\nalpha\r\n');
  const result = await f.fs.editText(f.target, { oldString: 'alpha', newString: '$&', replaceAll: true }, f.expected);
  bytes(await f.read(), bom + '$&\r\n$&\r\n');
  assert.equal(result.after, '$&\n$&\n');
});

test('removing the full logical text retains the original format marker', async t => {
  const f = await fixture(t, bom + 'alpha');
  const result = await f.fs.editText(f.target, { oldString: 'alpha', newString: '', replaceAll: false }, f.expected);
  bytes(await f.read(), bom);
  assert.equal(result.after, '');
});

test('a second leading FEFF stays part of the logical content', async t => {
  const f = await fixture(t, bom + bom + 'alpha');
  const result = await f.fs.editText(f.target, { oldString: 'alpha', newString: 'beta', replaceAll: false }, f.expected);
  bytes(await f.read(), bom + bom + 'beta');
  assert.equal(result.before, bom + 'alpha');
  assert.equal(result.after, bom + 'beta');
});

test('explicitly inserted FEFF content is not deduplicated against the BOM', async t => {
  const f = await fixture(t, bom + 'alpha');
  const result = await f.fs.editText(f.target, { oldString: 'alpha', newString: bom + 'beta', replaceAll: false }, f.expected);
  bytes(await f.read(), bom + bom + 'beta');
  assert.equal(result.after, bom + 'beta');
});

test('plain UTF-8 keeps no marker and preserves an interior FEFF', async t => {
  const f = await fixture(t, 'alpha\r\n中' + bom + '文\r\n');
  const result = await f.fs.editText(f.target, { oldString: 'alpha', newString: 'beta', replaceAll: false }, f.expected);
  bytes(await f.read(), 'beta\r\n中' + bom + '文\r\n');
  assert.equal(result.after, 'beta\n中' + bom + '文\n');
});

for (const newline of ['\n', '\r\n']) test(`patch first logical line keeps BOM and ${JSON.stringify(newline)}`, async t => {
  const f = await fixture(t, bom + `alpha${newline}中文🙂${newline}`);
  const result = await f.fs.patchText(f.target, hunk(['alpha'], ['beta']), f.expected);
  bytes(await f.read(), bom + `beta${newline}中文🙂${newline}`);
  assert.equal(result.before, 'alpha\n中文🙂\n');
  assert.equal(result.after, 'beta\n中文🙂\n');
});

test('patch a BOM-only file through the empty logical text', async t => {
  const f = await fixture(t, bom);
  const result = await f.fs.patchText(f.target, hunk([], ['中文🙂']), f.expected);
  bytes(await f.read(), bom + '中文🙂\n');
  assert.equal(result.before, '');
  assert.equal(result.after, '中文🙂\n');
});

for (const patched of [false, true]) test(`move ${patched ? 'with hunks' : 'without hunks'} preserves the source BOM`, async t => {
  const f = await fixture(t, bom + 'alpha\r\n中文🙂\r\n');
  const destination = await f.fs.resolve('destination.txt');
  const result = await f.fs.moveFile(f.target, destination, {
    expectedSource: f.expected, expectedDestination: { kind: 'createIfAbsent' },
    ...(patched ? { hunks: hunk(['alpha'], ['beta']) } : {}),
  });
  bytes(await readFile(destination.targetKey), bom + `${patched ? 'beta' : 'alpha'}\r\n中文🙂\r\n`);
  assert.equal(result.sourceDeleted, true);
  await assert.rejects(f.read(), { code: 'ENOENT' });
  assert.equal(result.sourceBefore, 'alpha\n中文🙂\n');
  assert.equal(result.destination.after, `${patched ? 'beta' : 'alpha'}\n中文🙂\n`);
});

test('move a plain source over a marked destination does not inherit its BOM', async t => {
  const f = await fixture(t, 'alpha\n');
  const destination = await f.fs.resolve('destination.txt');
  await writeFile(destination.targetKey, bom + 'old\n');
  const result = await f.fs.moveFile(f.target, destination, {
    expectedSource: f.expected,
    expectedDestination: { kind: 'replaceIfVersion', version: (await f.fs.stat(destination)).version },
  });
  bytes(await readFile(destination.targetKey), 'alpha\n');
  assert.equal(result.sourceDeleted, true);
  assert.equal(result.destination.before, 'old\n');
});

for (const cap of [4, 5]) test(`move keeps the existing logical diff budget at ${cap} bytes`, async t => {
  const f = await fixture(t, bom + 'abc\n', { diffBasisMaxBytes: cap });
  const destination = await f.fs.resolve('destination.txt');
  await writeFile(destination.targetKey, 'old\n');
  const result = await f.fs.moveFile(f.target, destination, { expectedSource: f.expected });
  assert.equal(result.destination.before, cap === 5 ? 'old\n' : null);
  assert.equal(result.destination.after, 'abc\n');
  assert.equal(result.sourceBefore, cap === 5 ? 'abc\n' : null);
  bytes(await readFile(destination.targetKey), bom + 'abc\n');
});

test('explicit whole-file write keeps the caller content rather than the old BOM', async t => {
  const f = await fixture(t, bom + 'alpha\r\n');
  await f.fs.writeText(f.target, 'beta\n', { kind: 'replaceIfVersion', version: f.expected.version });
  bytes(await f.read(), 'beta\n');
  await f.fs.writeText(f.target, bom + 'explicit\n');
  bytes(await f.read(), bom + 'explicit\n');
});

test('nonmatching edit and patch leave original BOM bytes unchanged', async t => {
  const original = bom + 'alpha\r\n';
  const f = await fixture(t, original);
  await assert.rejects(f.fs.editText(f.target, { oldString: 'missing', newString: 'x', replaceAll: false }, f.expected), { code: 'FS_EDIT_NOT_FOUND' });
  bytes(await f.read(), original);
  await assert.rejects(f.fs.patchText(f.target, hunk(['missing'], ['x']), f.expected), { code: 'FS_PATCH_MISMATCH' });
  bytes(await f.read(), original);
});

test('stale version refuses before changing either text or BOM', async t => {
  const f = await fixture(t, bom + 'alpha\r\n');
  const later = bom + 'alpha later\r\n';
  await writeFile(f.target.targetKey, later);
  await assert.rejects(f.fs.editText(f.target, { oldString: 'alpha', newString: 'beta', replaceAll: false }, f.expected), { code: 'FS_STALE_VERSION' });
  bytes(await f.read(), later);
});
