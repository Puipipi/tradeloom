import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';

let loaded;
async function api() {
  if (!loaded) {
    const prefix = process.env.DSH_TEST_PREFIX ?? process.env.DSH_PREFIX;
    if (!prefix) throw new Error('Set DSH_TEST_PREFIX or DSH_PREFIX');
    loaded = import(pathToFileURL(join(resolve(prefix), 'node_modules/@deepseek-ai/dsh-llm/lib/index.js')));
  }
  return loaded;
}

const cases = [
  ['ASCII above cap', 'a'.repeat(121), 'a'.repeat(119) + '…'],
  ['ASCII exactly cap', 'a'.repeat(120), 'a'.repeat(120)],
  ['short Unicode unchanged', '中文🙂简短', '中文🙂简短'],
  ['complete pair fits prefix', 'a'.repeat(117) + '🙂tail', 'a'.repeat(117) + '🙂…'],
  ['pair crossing prefix stays whole', 'a'.repeat(118) + '🙂tail', 'a'.repeat(118) + '…'],
  ['BMP Chinese above cap', '中'.repeat(121), '中'.repeat(119) + '…'],
];

for (const [name, input, expected] of cases) {
  test(`public boundContextSummary: ${name}`, async () => {
    const { boundContextSummary, CONTEXT_SUMMARY_MAX_CHARS } = await api();
    const before = input;
    assert.equal(CONTEXT_SUMMARY_MAX_CHARS, 120);
    const result = boundContextSummary(input);
    assert.equal(result, expected);
    assert.equal(result.isWellFormed(), true);
    assert.ok(result.length <= CONTEXT_SUMMARY_MAX_CHARS);
    assert.equal(input, before);
  });
}
