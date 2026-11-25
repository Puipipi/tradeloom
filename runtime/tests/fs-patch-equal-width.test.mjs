import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const prefix = process.env.DSH_TEST_PREFIX ?? process.env.DSH_PREFIX;
const options = { skip: !prefix && 'prepared DSH prefix required' };
let modulePromise;
function api() {
  if (!modulePromise) {
    const require = createRequire(resolve(prefix, 'package.json'));
    modulePromise = import(pathToFileURL(require.resolve('@deepseek-ai/dsh-fs-patch')));
  }
  return modulePromise;
}
async function check(before, body, after) {
  const { parsePatch, applyHunks } = await api();
  const [operation] = parsePatch(`*** Begin Patch\n*** Update File: own.txt\n${body}\n*** End Patch`);
  const saved = structuredClone(operation.hunks);
  assert.deepEqual(applyHunks(before, operation.hunks), { ok: true, after });
  assert.deepEqual(operation.hunks, saved);
}

test('equal width replacement preserves Unicode content', options, async () => {
  await check('a\n中文🙂\nc\n', '-中文🙂\n+新🙂', 'a\n新🙂\nc\n');
});
test('several separated equal width hunks retain intervening lines', options, async () => {
  await check('a\nb\nc\nd\ne\n', '-a\n+A\n@@\n-c\n+C\n@@\n-e\n+E', 'A\nb\nC\nd\nE\n');
});
test('unequal insertion and equal replacement preserve offsets', options, async () => {
  await check('a\nb\nc\nd\n', '-a\n+A\n+A2\n@@\n-c\n+C', 'A\nA2\nb\nC\nd\n');
});
test('unequal deletion and equal replacement preserve offsets', options, async () => {
  await check('a\nb\nc\nd\n', '-a\n-b\n+A\n@@\n-d\n+D', 'A\nc\nD\n');
});
test('EOF overlap shortens the tail before equal width refill', options, async () => {
  await check('a\nb\nc\nd\n', '-b\n-c\n-d\n+B\n+C\n+D\n*** End of File\n@@\n-c\n-d\n+X\n*** End of File', 'a\nB\nC\nD\n');
});
test('same start EOF deletion then equal refill keeps stable reverse order', options, async () => {
  await check('a\nb\nc\nd\n', '-b\n-c\n-d\n+B\n+C\n+D\n*** End of File\n@@\n-b\n-c\n-d\n+X\n*** End of File', 'a\nB\nC\nD\n');
});
test('same position empty-old insertions retain patch order', options, async () => {
  await check('a\n', '+first\n@@\n+second', 'a\nfirst\nsecond\n');
});
test('trailing empty pattern retry uses trimmed actual replacement lengths', options, async () => {
  await check('a\nb\n', '-b\n+B\n ', 'a\nB\n');
});
test('EOF backtracking and ordinary later hunk preserve reverse reconstruction', options, async () => {
  await check('a\nb\nc\n', '-c\n+C\n@@\n-b\n-c\n+B\n+C2\n*** End of File', 'a\nB\nC2\n');
});
test('empty and no-hunk reconstruction keeps original terminal LF rules', options, async () => {
  const { applyHunks } = await api();
  for (const [before, after] of [['', ''], ['a', 'a\n'], ['a\n', 'a\n'], ['a\n\n', 'a\n']]) {
    assert.deepEqual(applyHunks(before, []), { ok: true, after });
  }
});
test('unmatched hunk reports structured failure without changing caller inputs', options, async () => {
  const { parsePatch, applyHunks } = await api();
  const [operation] = parsePatch('*** Begin Patch\n*** Update File: own.txt\n-missing\n+new\n*** End Patch');
  const saved = structuredClone(operation.hunks);
  assert.deepEqual(applyHunks('a\n', operation.hunks), {
    ok: false,
    failure: { hunkLineNumber: 3, stage: 'oldLines', searchStart: 0, pattern: ['missing'] },
  });
  assert.deepEqual(operation.hunks, saved);
});
