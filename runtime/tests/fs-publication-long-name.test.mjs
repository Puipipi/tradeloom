// Public provider calls with names that the actual filesystem accepts.
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

const require = createRequire(join(resolve(process.env.DSH_TEST_PREFIX ?? process.cwd()), 'package.json'));
const { Context } = await import(pathToFileURL(require.resolve('@deepseek-ai/cordis')));
const { LocalFileSystem } = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-fs-local')));

for (const [label, name] of [
  ['255-byte ASCII name', 'a'.repeat(251) + '.txt'],
  ['243-byte UTF-8 name', '文'.repeat(80) + '.md'],
]) {
  for (const operation of ['create', 'replace', 'edit', 'move']) {
    test(`${operation} accepts a filesystem-supported ${label}`, async t => {
      const directory = await mkdtemp(join(tmpdir(), 'dsh-fs-name-'));
      const ctx = new Context();
      t.after(async () => {
        await ctx.fiber.dispose();
        await rm(directory, { recursive: true, force: true });
      });
      await ctx.plugin(LocalFileSystem, { cwd: directory });
      const targetPath = join(directory, name);
      // Establish that the requested leaf itself is valid on this filesystem.
      await writeFile(targetPath, 'before\n');
      const target = await ctx.fs.resolve(name);
      if (operation === 'create') {
        await rm(targetPath);
        const result = await ctx.fs.writeText(target, 'after\n', { kind: 'createIfAbsent' });
        assert.equal(result.operation, 'create');
      } else if (operation === 'replace') {
        const result = await ctx.fs.writeText(target, 'after\n', {
          kind: 'replaceIfVersion', version: (await ctx.fs.stat(target)).version,
        });
        assert.equal(result.operation, 'update');
      } else if (operation === 'edit') {
        await ctx.fs.editText(target, {
          oldString: 'before', newString: 'after', replaceAll: false,
        }, { version: (await ctx.fs.stat(target)).version });
      } else {
        await rm(targetPath);
        const source = await ctx.fs.resolve('source.txt');
        await writeFile(source.targetKey, 'after\n');
        const result = await ctx.fs.moveFile(source, target, {
          expectedSource: { version: (await ctx.fs.stat(source)).version },
          expectedDestination: { kind: 'createIfAbsent' },
        });
        assert.equal(result.sourceDeleted, true);
        await assert.rejects(readFile(source.targetKey), { code: 'ENOENT' });
      }
      assert.equal(await readFile(targetPath, 'utf8'), 'after\n');
      assert.deepEqual(await readdir(directory), [name]);
    });
  }
}
