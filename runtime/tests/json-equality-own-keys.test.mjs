import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';

let loaded;
async function api() {
  if (!loaded) {
    const prefix = process.env.DSH_TEST_PREFIX ?? process.env.DSH_PREFIX;
    if (!prefix) throw new Error('Set DSH_TEST_PREFIX or DSH_PREFIX to the prepared runtime');
    loaded = import(pathToFileURL(join(resolve(prefix), 'node_modules/@deepseek-ai/dsh-util-values/lib/index.js')));
  }
  return loaded;
}

const cases = [
  ['different own document fields', '{"__proto__":{}}', '{"ordinary":1}', false],
  ['same own special field', '{"__proto__":{"label":"中文🙂"}}', '{"__proto__":{"label":"中文🙂"}}', true],
  ['nested documents retain own keys', '{"doc":{"__proto__":{}}}', '{"doc":{"ordinary":1}}', false],
  ['array documents retain own keys', '[{"__proto__":{}}]', '[{"ordinary":1}]', false],
  ['object insertion order is irrelevant', '{"a":1,"__proto__":{},"b":[true,null]}', '{"b":[true,null],"__proto__":{},"a":1}', true],
  ['array order remains meaningful', '[1,2]', '[2,1]', false],
  ['nested equal arrays', '[null,{"constructor":"text","__proto__":{}},["中文🙂",false]]', '[null,{"__proto__":{},"constructor":"text"},["中文🙂",false]]', true],
];
for (const [name, leftText, rightText, expected] of cases) {
  test(`public JSON equality: ${name}`, async () => {
    const { deepEqualJson, isJsonValue } = await api();
    const left = JSON.parse(leftText);
    const right = JSON.parse(rightText);
    assert.equal(isJsonValue(left), true);
    assert.equal(isJsonValue(right), true);
    const before = [JSON.stringify(left), JSON.stringify(right)];
    assert.equal(deepEqualJson(left, right), expected, 'forward equality');
    assert.equal(deepEqualJson(right, left), expected, 'reverse equality');
    assert.deepEqual([JSON.stringify(left), JSON.stringify(right)], before, 'inputs unchanged');
  });
}

test('public JSON equality: ordinary primitive and container controls', async () => {
  const { deepEqualJson, isJsonValue } = await api();
  for (const [leftText, rightText, expected] of [
    ['null', 'null', true], ['null', '{}', false],
    ['1', '1', true], ['1', '"1"', false],
    ['true', 'false', false], ['"中文🙂"', '"中文🙂"', true],
    ['[]', '{}', false], ['{}', '{}', true], ['[1]', '[1,2]', false],
  ]) {
    const left = JSON.parse(leftText);
    const right = JSON.parse(rightText);
    assert.equal(isJsonValue(left), true);
    assert.equal(isJsonValue(right), true);
    assert.equal(deepEqualJson(left, right), expected);
    assert.equal(deepEqualJson(right, left), expected);
  }
});
