import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

const prefix = process.env.DSH_TEST_PREFIX ?? process.env.DSH_PREFIX;
let modules;
async function fixture(t, text) {
  if (!modules) {
    const require = createRequire(resolve(prefix, 'package.json'));
    modules = Promise.all([
      import(pathToFileURL(require.resolve('@deepseek-ai/cordis'))),
      import(pathToFileURL(require.resolve('@deepseek-ai/dsh-fs-local'))),
    ]);
  }
  const [{ Context }, { LocalFileSystem }] = await modules;
  const root = await mkdtemp(join(tmpdir(), 'own-fs-line-style-'));
  const ctx = new Context();
  t.after(async () => {
    await ctx.fiber.dispose();
    await rm(root, { recursive: true, force: true });
  });
  await ctx.plugin(LocalFileSystem, { cwd: root });
  const target = await ctx.fs.resolve('source.txt');
  await writeFile(target.targetKey, text);
  return { fs: ctx.fs, target, expected: { version: (await ctx.fs.stat(target)).version } };
}
const normalized = value => value.replaceAll('\r\n', '\n');
const bytesEqual = (actual, expected) => assert.deepEqual(actual, Buffer.from(expected));
const options = { skip: !prefix && 'prepared DSH prefix required' };

for (const operation of ['edit', 'patch', 'move', 'move-patch']) {
  test(`long first line CRLF survives public ${operation}`, options, async t => {
    const first = 'a'.repeat(5000);
    const before = first + '\r\noriginal\r\ntail\r\n';
    const after = operation === 'move' ? before : before.replace('original', 'edited');
    const f = await fixture(t, before);
    const hunks = [{ lineNumber: 2, oldLines: ['original'], newLines: ['edited'], isEndOfFile: false }];
    if (operation.startsWith('move')) {
      const destination = await f.fs.resolve('destination.txt');
      const result = await f.fs.moveFile(f.target, destination, {
        expectedSource: f.expected,
        expectedDestination: { kind: 'createIfAbsent' },
        ...(operation === 'move-patch' ? { hunks } : {}),
      });
      bytesEqual(await readFile(destination.targetKey), after);
      assert.equal(result.sourceDeleted, true);
      await assert.rejects(readFile(f.target.targetKey), { code: 'ENOENT' });
      assert.equal(result.sourceBefore, normalized(before));
      assert.equal(result.destination.after, normalized(after));
    } else {
      const result = operation === 'edit'
        ? await f.fs.editText(f.target, { oldString: 'original', newString: 'edited', replaceAll: false }, f.expected)
        : await f.fs.patchText(f.target, hunks, f.expected);
      bytesEqual(await readFile(f.target.targetKey), after);
      assert.equal(result.before, normalized(before));
      assert.equal(result.after, normalized(after));
      assert.equal(result.version, (await f.fs.stat(f.target)).version);
    }
  });
}

for (const length of [4094, 4095, 4096]) {
  test(`CRLF first line boundary at ${length}`, options, async t => {
    const before = 'a'.repeat(length) + '\r\noriginal\r\n';
    const f = await fixture(t, before);
    await f.fs.editText(f.target, { oldString: 'original', newString: 'edited', replaceAll: false }, f.expected);
    bytesEqual(await readFile(f.target.targetKey), before.replace('original', 'edited'));
  });
}

for (const [name, before, expected] of [
  ['short CRLF', 'original\r\ntail\r\n', 'edited\r\ntail\r\n'],
  ['long LF', 'a'.repeat(5000) + '\noriginal\n', 'a'.repeat(5000) + '\nedited\n'],
  ['no newline', 'a'.repeat(5000) + 'original', 'a'.repeat(5000) + 'edited'],
  ['sample mixed CRLF majority', 'original\r\nb\r\nc\n', 'edited\r\nb\r\nc\r\n'],
  ['sample mixed tie stays LF', 'original\r\nb\n', 'edited\nb\n'],
]) {
  test(`${name} retains the existing policy`, options, async t => {
    const f = await fixture(t, before);
    const result = await f.fs.editText(f.target, { oldString: 'original', newString: 'edited', replaceAll: false }, f.expected);
    bytesEqual(await readFile(f.target.targetKey), expected);
    assert.equal(result.before, normalized(before));
    assert.equal(result.after, normalized(expected));
  });
}
