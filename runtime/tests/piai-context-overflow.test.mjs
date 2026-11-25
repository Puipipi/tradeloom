import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const prefix = process.env.DSH_TEST_PREFIX ?? process.env.DSH_PREFIX;
const options = { skip: !prefix && 'prepared DSH prefix required' };
let modulePromise;
function overflow() {
  modulePromise ??= import(pathToFileURL(resolve(prefix,
    'node_modules/@earendil-works/pi-ai/dist/utils/overflow.js')));
  return modulePromise;
}

const parameterLimit = 'max_tokens exceeds the limit of 65536';
const http400 = code => '400 ' + JSON.stringify({ error: {
  message: parameterLimit, type: 'invalid_request_error', param: 'max_tokens', code,
} });
const errorMessage = text => ({
  role: 'assistant', api: 'openai-completions', provider: 'custom-fixture', model: 'fixture', content: [],
  usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  stopReason: 'error', errorMessage: text, timestamp: 0,
});

for (const [name, text, expected] of [
  ['max_tokens parameter limit is not context overflow', parameterLimit, false],
  ['HTTP 400 max_tokens rejection is not context overflow', http400(null), false],
  ['Copilot prompt token count retains context overflow',
    'prompt token count of 70000 exceeds the limit of 65536', true],
  ['Copilot grouped prompt token counts retain context overflow',
    'prompt token count of 70,000 exceeds the limit of 65,536', true],
  ['explicit context_length_exceeded stays context overflow', http400('context_length_exceeded'), true],
]) {
  test(name, options, async () => {
    const { isContextOverflow } = await overflow();
    assert.equal(isContextOverflow(errorMessage(text), 131072), expected);
  });
}
