import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';

const prefix = process.env.DSH_TEST_PREFIX ?? process.env.DSH_PREFIX;
const require = createRequire(join(resolve(prefix), 'package.json'));
const load = name => import(pathToFileURL(require.resolve('@deepseek-ai/' + name)));
const [{ Context }, { SystemPrompt }, { ToolRuntime }, { LocalFileSystem }, api, native] =
  await Promise.all(['cordis', 'dsh-system-prompt', 'dsh-tools', 'dsh-fs-local',
    'dsh-tool-fs', 'dsh-tool-executor-native'].map(load));
const marker = '... (line truncated to 2000 chars)';

async function fixture(t, mode, maxBytes = 50 * 1024) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-read-cr-'));
  const path = join(root, 'sample.txt');
  const ctx = new Context();
  t.after(async () => {
    await ctx.fiber.dispose();
    await rm(root, { recursive: true, force: true });
  });
  await ctx.plugin(SystemPrompt, {});
  await ctx.plugin(ToolRuntime, {});
  await ctx.plugin(native);
  await ctx.plugin(LocalFileSystem, { cwd: root });
  await ctx.plugin({
    inject: ['tools', 'fs', 'systemPrompt'],
    apply(scope) {
      api.apply(scope, {
        read: true,
        readLimit: 2000,
        readMaxLineLength: 2000,
        readMaxBytes: maxBytes,
        readStreamMinSize: mode === 'stream' ? 1 : 10 * 1024 * 1024,
      });
    },
  });
  return async (text, args = {}) => {
    await writeFile(path, text, 'utf8');
    const batch = await ctx.tools.execute({
      calls: [{ id: 'read-boundary', name: 'read',
        arguments: JSON.stringify({ file_path: path, ...args }) }],
      signal: new AbortController().signal,
    });
    const result = batch.results[0].result;
    assert.notEqual(result.isError, true);
    return result;
  };
}

for (const mode of ['whole', 'stream']) {
  const cases = [
    ['internal CR with tail', 'a'.repeat(2000) + '\rtail', 'a'.repeat(2000) + marker],
    ['internal CR one trailing unit', 'a'.repeat(2000) + '\rx', 'a'.repeat(2000) + marker],
    ['capped buffer ends CR', 'a'.repeat(2001) + '\rtail', 'a'.repeat(2000) + marker],
    ['actual CRLF exact', 'a'.repeat(2000) + '\r\n', 'a'.repeat(2000)],
    ['actual EOF CR exact', 'a'.repeat(2000) + '\r', 'a'.repeat(2000)],
    ['exact EOF', 'a'.repeat(2000), 'a'.repeat(2000)],
    ['internal CR inside retained prefix', 'a'.repeat(1999) + '\rxtail', 'a'.repeat(1999) + '\r' + marker],
  ];
  for (const [label, input, expected] of cases) {
    test(`${mode}: ${label}`, async t => {
      const read = await fixture(t, mode);
      const result = await read(input);
      assert.deepEqual(result.meta.lines, [{ number: 1, text: expected }]);
      assert.equal(result.meta.totalLines, 1);
      assert.ok(result.content[0].text.includes(`1: ${expected}`));
    });
  }
  test(`${mode}: offset and exact byte cap preserve truncation marker`, async t => {
    const expected = 'a'.repeat(2000) + marker;
    const read = await fixture(t, mode, Buffer.byteLength(expected));
    const result = await read('skip\r\n' + 'a'.repeat(2000) + '\rtail\r\nnext', { offset: 2 });
    assert.deepEqual(result.meta.lines, [{ number: 2, text: expected }]);
    assert.equal(result.meta.totalLines, 3);
    assert.ok(result.content[0].text.includes('Use offset=3 to continue.'));
  });
  test(`${mode}: insufficient byte cap excludes entire marked line`, async t => {
    const expected = 'a'.repeat(2000) + marker;
    const read = await fixture(t, mode, Buffer.byteLength(expected) - 1);
    const result = await read('a'.repeat(2000) + '\rtail');
    assert.deepEqual(result.meta.lines, []);
    assert.equal(result.meta.totalLines, 1);
    assert.ok(result.content[0].text.includes('Output capped.'));
  });
}
