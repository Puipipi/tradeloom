import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const prefix = process.env.DSH_TEST_PREFIX ?? process.env.DSH_PREFIX;
const options = { skip: !prefix && 'prepared DSH prefix required' };
let modulePromise;
function api() {
  modulePromise ??= import(pathToFileURL(resolve(prefix,
    'node_modules/@earendil-works/pi-ai/dist/api/anthropic-messages.js')));
  return modulePromise;
}

// Real pi-ai + Anthropic SDK request construction, captured before transport.
// Every request receives a fixed local error: no network or provider validation.
async function body({ baseUrl = 'https://api.anthropic.com', id = 'claude-opus-5-5',
  compat, reasoning = 'medium' } = {}) {
  const { streamSimple } = await api();
  const captures = [];
  const result = await streamSimple({
    id, name: 'Synthetic request capture', api: 'anthropic-messages', provider: 'custom-fixture', baseUrl,
    input: ['text'], reasoning: true, contextWindow: 262144, maxTokens: 32768,
    thinkingLevelMap: { low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh', max: 'max' },
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    ...(compat ? { compat } : {}),
  }, {
    messages: [{ role: 'user', content: 'Synthetic hello.', timestamp: 0 }],
  }, {
    apiKey: 'synthetic-not-a-real-key', maxRetries: 0, maxTokens: 2048, reasoning,
    thinkingBudgets: { medium: 8192 }, temperature: 0.5,
    fetch: async (input, init) => {
      const text = init?.body ?? (input instanceof Request ? await input.text() : undefined);
      const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
      captures.push({ body: JSON.parse(text), beta: headers.get('anthropic-beta') ?? '' });
      return new Response(JSON.stringify({ type: 'error', error: {
        type: 'invalid_request_error', message: 'synthetic local capture',
      } }), { status: 400, headers: { 'content-type': 'application/json' } });
    },
  }).result();
  assert.equal(result.stopReason, 'error');
  assert.equal(captures.length, 1);
  return captures[0];
}

for (const reasoning of ['low', 'medium', 'high', 'xhigh', 'max']) {
  test(`official Opus 5.5 custom route uses adaptive ${reasoning}`, options, async () => {
    const { body: request, beta } = await body({ reasoning });
    assert.equal(request.thinking.type, 'adaptive');
    assert.equal(request.output_config.effort, reasoning);
    assert(!Object.hasOwn(request.thinking, 'budget_tokens'));
    assert(!Object.hasOwn(request, 'temperature'));
    assert.equal(request.max_tokens, 2048);
    assert.equal(request.model, 'claude-opus-5-5');
    assert.equal(request.messages[0].content[0].text, 'Synthetic hello.');
    assert(!beta.includes('interleaved-thinking-2025-05-14'));
  });
}

for (const [name, request, expected] of [
  ['trailing slash', { baseUrl: 'https://api.anthropic.com/' }, 'adaptive'],
  ['case-insensitive hostname', { baseUrl: 'https://API.ANTHROPIC.COM' }, 'adaptive'],
  ['explicit default HTTPS port', { baseUrl: 'https://api.anthropic.com:443' }, 'adaptive'],
  ['older model', { id: 'claude-opus-4-5' }, 'enabled'],
  ['similarly named model', { id: 'custom-claude-opus-5-5' }, 'enabled'],
  ['unknown future model', { id: 'claude-opus-6' }, 'enabled'],
  ['other provider', { baseUrl: 'https://example.invalid' }, 'enabled'],
  ['hostname suffix lookalike', { baseUrl: 'https://api.anthropic.com.example.invalid' }, 'enabled'],
  ['official host only in path', { baseUrl: 'https://example.invalid/api.anthropic.com' }, 'enabled'],
  ['other official path', { baseUrl: 'https://api.anthropic.com/gateway' }, 'enabled'],
  ['query outside automatic scope', { baseUrl: 'https://api.anthropic.com/?synthetic=1' }, 'enabled'],
  ['nondefault port', { baseUrl: 'https://api.anthropic.com:8443' }, 'enabled'],
  ['HTTP outside automatic scope', { baseUrl: 'http://api.anthropic.com' }, 'enabled'],
  ['explicit opt out', { compat: { forceAdaptiveThinking: false } }, 'enabled'],
  ['explicit opt in on a proxy', { baseUrl: 'https://example.invalid', compat: { forceAdaptiveThinking: true } }, 'adaptive'],
]) {
  test(`adaptive default boundary: ${name}`, options, async () => {
    const { body: outgoing } = await body(request);
    assert.equal(outgoing.thinking.type, expected);
    if (expected === 'enabled') {
      assert.equal(outgoing.thinking.budget_tokens, 8192);
      assert(!Object.hasOwn(outgoing, 'output_config'));
    } else {
      assert.equal(outgoing.output_config.effort, 'medium');
      assert(!Object.hasOwn(outgoing.thinking, 'budget_tokens'));
    }
  });
}

test('does not silently reinterpret an off request as adaptive thinking', options, async () => {
  // This configuration is still unsupported by Opus 5.5, which always thinks.
  // The narrow enabled-format fix does not change off semantics or claim it works.
  const { body: outgoing } = await body({ reasoning: null });
  assert.deepEqual(outgoing.thinking, { type: 'disabled' });
  assert(!Object.hasOwn(outgoing, 'output_config'));
});

for (const effort of ['low', 'medium', 'high']) {
  test(`native form effort shape reaches adaptive ${effort} through the public adapter`, options, async () => {
    const { Config, apply } = await import(pathToFileURL(resolve(prefix,
      'node_modules/@deepseek-ai/dsh-llm-pi-ai/lib/index.js')));
    let adapter;
    apply({
      fiber: { entry: { options: { id: 'llm-pi-ai' } } }, inject() {}, on() {},
      get: name => name === 'credentials' ? {
        resolve: async () => ({ value: 'synthetic-not-a-real-key' }), readRecord: async () => undefined,
      } : undefined,
      waterfall: (_name, _request, headers) => headers,
      llm: {
        registerAdapter(_routes, value) { adapter = value; return { replace() {} }; },
        registerConfigurableProviders: () => ({ replace() {} }), registerModelDiscovery() {},
      },
      logger: { warn() {}, error() {} },
    }, Config({ providers: { 'custom-synthetic': {
      apiKeyEnv: 'SYNTHETIC_TEST_API_KEY', api: 'anthropic-messages', baseURL: 'https://api.anthropic.com',
      models: [{ id: 'claude-opus-5-5', reasoningEfforts: { off: null, low: 'low', medium: 'medium', high: 'high' } }],
    } } }));
    assert(adapter);
    const captures = [], original = globalThis.fetch;
    globalThis.fetch = async (input, init) => {
      const request = new Request(input, init);
      assert.equal(request.url, 'https://api.anthropic.com/v1/messages?beta=true');
      captures.push(await request.json());
      return new Response(JSON.stringify({ type: 'error', error: {
        type: 'invalid_request_error', message: 'synthetic local capture',
      } }), { status: 400, headers: { 'content-type': 'application/json' } });
    };
    try {
      const chunks = await Array.fromAsync(adapter.stream({
        provider: 'custom-synthetic', model: 'claude-opus-5-5', reasoningEffort: effort,
        tools: [], messages: [{ role: 'user', content: [{ type: 'text', text: 'Synthetic hello.' }] }],
      }));
      assert.equal(chunks.at(-1).reason.kind, 'error');
      assert.match(chunks.at(-1).reason.failure.message, /synthetic local capture/);
      assert.equal(captures.length, 1);
      assert.equal(captures[0].thinking.type, 'adaptive');
      assert.equal(captures[0].output_config.effort, effort);
      assert(!Object.hasOwn(captures[0].thinking, 'budget_tokens'));
    } finally { globalThis.fetch = original; }
  });
}
