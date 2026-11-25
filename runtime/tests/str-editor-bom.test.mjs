import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
const prefix = process.env.DSH_TEST_PREFIX ?? process.env.DSH_PREFIX;
const cases = [
  ['BOM replacement', '\uFEFFalpha\n中文\n', {command:'str_replace',old_str:'alpha',new_str:'beta'}, '\uFEFFbeta\n中文\n'],
  ['BOM insertion', '\uFEFFalpha\n中文\n', {command:'insert',insert_line:1,new_str:'beta'}, '\uFEFFalpha\nbeta\n中文\n'],
  ['plain replacement', 'alpha\n中文\n', {command:'str_replace',old_str:'alpha',new_str:'beta'}, 'beta\n中文\n'],
  ['plain insertion', 'alpha\n中文\n', {command:'insert',insert_line:1,new_str:'beta'}, 'alpha\nbeta\n中文\n'],
  ['double BOM replacement', '\uFEFF\uFEFFalpha\n', {command:'str_replace',old_str:'alpha',new_str:'beta'}, '\uFEFF\uFEFFbeta\n'],
  ['double BOM insertion', '\uFEFF\uFEFFalpha\n', {command:'insert',insert_line:1,new_str:'beta'}, '\uFEFF\uFEFFalpha\nbeta\n'],
  ['explicit FEFF replacement remains content', '\uFEFFalpha\n', {command:'str_replace',old_str:'alpha',new_str:'\uFEFFbeta'}, '\uFEFF\uFEFFbeta\n'],
  ['explicit FEFF insertion without original BOM', 'alpha\n', {command:'insert',insert_line:0,new_str:'\uFEFFbeta'}, '\uFEFFbeta\nalpha\n'],
  ['CRLF is not an LF-only verbatim match', '\uFEFFalpha\r\n中文\r\n', {command:'str_replace',old_str:'alpha\n中文',new_str:'beta'}, '\uFEFFalpha\r\n中文\r\n', true],
];
for (const [name, before, args, expected, failure = false] of cases) {
  test(name, {skip: !prefix}, async () => {
    const require = createRequire(join(resolve(prefix), 'package.json'));
    const load = name => import(pathToFileURL(require.resolve('@deepseek-ai/' + name)));
    const [{Context}, {SystemPrompt}, {ToolRuntime}, {LocalFileSystem}, editor, native] =
      await Promise.all(['cordis','dsh-system-prompt','dsh-tools','dsh-fs-local','dsh-tool-str-replace-editor','dsh-tool-executor-native'].map(load));
    const root = await mkdtemp(join(tmpdir(), 'own-editor-bom-'));
    const path = join(root, 'ordinary.txt');
    const ctx = new Context();
    try {
      await ctx.plugin(SystemPrompt, {});
      await ctx.plugin(ToolRuntime, {});
      await ctx.plugin(native);
      await ctx.plugin(LocalFileSystem, {cwd: root});
      await ctx.plugin(editor, {});
      await writeFile(path, before, 'utf8');
      const batch = await ctx.tools.execute({
        calls: [{id:'ordinary-edit',name:'str_replace_editor',arguments:JSON.stringify({...args,path})}],
        signal: new AbortController().signal,
      });
      const result = batch.results[0].result;
      assert.equal(result.isError, failure, JSON.stringify(result));
      if (failure) assert.match(result.content[0].text, /did not appear verbatim/);
      assert.deepEqual(await readFile(path), Buffer.from(expected), name);
    } finally {
      await ctx.fiber.dispose();
      await rm(root, {recursive:true,force:true});
    }
  });
}
