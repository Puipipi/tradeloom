import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const prefix = process.env.DSH_TEST_PREFIX ?? process.env.DSH_PREFIX;
const options = { skip: !prefix && 'prepared DSH prefix required' };
let modulePromise;
function api() {
  if (!modulePromise) {
    modulePromise = import(pathToFileURL(resolve(prefix, 'node_modules/@earendil-works/pi-ai/dist/api/openai-completions.js')));
  }
  return modulePromise;
}

// Exercise the public pi-ai stream and the real OpenAI SDK request builder.
// The documented fetch seam records the outgoing body and returns a fixed error;
// no network, model response, provider-side validation, or payload rewriting.
async function body(baseUrl, compat) {
  const { stream } = await api();
  const captures = [];
  const result = await stream({
    id: 'request-capture-only', name: 'Request capture only',
    api: 'openai-completions', provider: 'custom', baseUrl,
    input: ['text'], reasoning: true, contextWindow: 8192, maxTokens: 1024,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    ...(compat ? { compat } : {}),
  }, {
    messages: [
      { role: 'system', content: 'Keep the existing instruction role.', timestamp: 0 },
      { role: 'user', content: 'Capture only.', timestamp: 0 },
    ],
  }, {
    apiKey: 'synthetic-not-a-real-key', maxRetries: 0, maxTokens: 16,
    reasoningEffort: 'medium',
    fetch: async (input, init) => {
      const method = init?.method ?? (input instanceof Request ? input.method : 'GET');
      const text = init?.body ?? (input instanceof Request ? await input.text() : undefined);
      captures.push({ method, body: JSON.parse(text) });
      return new Response(JSON.stringify({ error: { message: 'controlled transport capture', type: 'invalid_request_error' } }), {
        status: 400, headers: { 'content-type': 'application/json' },
      });
    },
  }).result();
  assert.equal(result.stopReason, 'error');
  assert.equal(captures.length, 1);
  assert.equal(captures[0].method, 'POST');
  return captures[0].body;
}
const golden = {
  model: 'request-capture-only',
  messages: [
    { role: 'developer', content: 'Keep the existing instruction role.' },
    { role: 'user', content: 'Capture only.' },
  ],
  stream: true, stream_options: { include_usage: true },
  max_completion_tokens: 16, reasoning_effort: 'medium',
};
const google = 'https://generativelanguage.googleapis.com/v1beta/openai/';
for (const [name, url, compat, store] of [
  ['Google official endpoint', google, undefined, false],
  ['Google without trailing slash', google.slice(0, -1), undefined, false],
  ['Google explicit default port and case-insensitive host', 'https://GENERATIVELANGUAGE.googleapis.com:443/v1beta/openai/', undefined, false],
  ['standard OpenAI', 'https://api.openai.com/v1', undefined, true],
  ['other host', 'https://example.invalid/v1', undefined, true],
  ['hostname suffix lookalike', 'https://generativelanguage.googleapis.com.example.invalid/v1beta/openai/', undefined, true],
  ['hostname text only in path and query', 'https://example.invalid/generativelanguage.googleapis.com/v1beta/openai/?host=generativelanguage.googleapis.com', undefined, true],
  ['hostname text only in userinfo', 'https://generativelanguage.googleapis.com@example.invalid/v1beta/openai/', undefined, true],
  ['other Google service', 'https://storage.googleapis.com/v1beta/openai/', undefined, true],
  ['other Google path', 'https://generativelanguage.googleapis.com/v1beta/', undefined, true],
  ['nondefault port', 'https://generativelanguage.googleapis.com:8443/v1beta/openai/', undefined, true],
  ['HTTP outside automatic scope', 'http://generativelanguage.googleapis.com/v1beta/openai/', undefined, true],
  ['explicit Google supportsStore true', google, { supportsStore: true }, true],
  ['explicit Google supportsStore false', google, { supportsStore: false }, false],
  ['explicit OpenAI supportsStore false', 'https://api.openai.com/v1', { supportsStore: false }, false],
]) {
  test(`store compatibility: ${name}`, options, async () => {
    assert.deepEqual(await body(url, compat), store ? { ...golden, store: false } : golden);
  });
}
