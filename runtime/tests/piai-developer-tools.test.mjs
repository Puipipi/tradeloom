import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
const prefix = path.resolve(process.env.DSH_PREFIX);
const require = createRequire(path.join(prefix, 'package.json'));
const pi = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-llm-pi-ai')));
const { PiAiAdapter } = pi;
// These two paths are the public import-only exports; require.resolve cannot resolve their import condition.
const { createProvider } = await import(pathToFileURL(path.join(prefix, 'node_modules/@earendil-works/pi-ai/dist/models.js')));
const { AssistantMessageEventStream } = await import(pathToFileURL(path.join(prefix, 'node_modules/@earendil-works/pi-ai/dist/utils/event-stream.js')));
const declaration = (name, description = name) => ({ name, description, parameters: { type: 'object', properties: {} } });
const addition = toolName => ({ type: 'tool-addition', toolName });
const developer = content => ({ role: 'developer', content });
function fixture() {
  const captured = [];
  const model = { id: 'fixture', name: 'Fixture', api: 'openai-completions', provider: 'fixture', baseUrl: 'http://unused.invalid', reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100000, maxTokens: 1000, compat: { supportsMidConvoSystemMessages: true, supportsMidConvoToolAdditions: true } };
  function stream(model, context) {
    captured.push(context);
    const result = new AssistantMessageEventStream();
    result.push({ type: 'done', reason: 'stop', message: { role: 'assistant', content: [{ type: 'text', text: 'fixture response' }], api: model.api, provider: model.provider, model: model.id, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: 'stop', timestamp: Date.now() } });
    return result;
  }
  const piProvider = createProvider({ id: 'fixture', auth: { apiKey: { name: 'Fixture', resolve: async () => ({ auth: { apiKey: 'fixture-only' }, source: 'fixture' }) } }, models: [model], api: { stream, streamSimple: stream } });
  const profile = { provider: 'fixture', displayName: 'Fixture', piProvider, modelErrors: new Map(), configuredMaxTokens: new Map(), streamIdleTimeoutMs: 60000, maxRequestImageBytes: 1000000, requestImagePixelBudget: 1000000, requestImageMaxBytes: 1000000, retryPolicy: {} };
  const profiles = new Map([['fixture', profile]]);
  const adapter = new PiAiAdapter({ profiles: () => profiles, resolveApiKey: async () => undefined, auth: {} });
  return { captured, async run(tools, messages) {
    const chunks = await Array.fromAsync(adapter.stream({ provider: 'fixture', model: 'fixture', tools, messages }));
    assert.equal(chunks.at(-1).reason.kind, 'stop');
    return captured.at(-1);
  } };
}
// Delegate the actual built-ins; only the caller's original declarations count.
// piTool creates detached declaration objects, so provider normalization does not count.
async function counted(tools, operation) {
  const find = Array.prototype.find, set = Map.prototype.set;
  const originalTools = new Set(tools);
  let predicates = 0, indexed = 0;
  Array.prototype.find = function (callback, thisArg) {
    return find.call(this, this === tools ? function (...args) { predicates++; return callback.apply(this, args); } : callback, thisArg);
  };
  Map.prototype.set = function (key, value) {
    if (originalTools.has(value) && key === value.name) indexed++;
    return set.call(this, key, value);
  };
  try { const result = await operation(); return { predicates, indexed, result }; }
  finally { Array.prototype.find = find; Map.prototype.set = set; }
}
for (const size of [64, 256]) test(`public adapter projects ${size} additions with one local index`, async t => {
  const tools = Array.from({ length: size }, (_, i) => declaration(`tool${i}`));
  const fixture_ = fixture();
  const names = tools.map(tool => tool.name).reverse();
  const observed = await counted(tools, () => fixture_.run(tools, [developer(names.map(addition))]));
  assert.deepEqual(observed.result.messages[1].toolsAdded, names.map(name => tools.find(tool => tool.name === name)));
  t.diagnostic(JSON.stringify({ size, predicates: observed.predicates, indexed: observed.indexed }));
  assert.equal(observed.predicates, size);
  assert.equal(observed.indexed, size - 1);
});
test('zero and single additions preserve no-index cost including first and last', async () => {
  const tools = Array.from({ length: 64 }, (_, i) => declaration(`tool${i}`));
  for (const [content, expected] of [[[{ type: 'text', text: 'note' }], 0], [[addition('tool0')], 1], [[addition('tool63')], 64]]) {
    const f = fixture(), observed = await counted(tools, () => f.run(tools, [developer(content)]));
    assert.equal(observed.predicates, expected); assert.equal(observed.indexed, 0);
  }
});
test('preserves duplicate first declaration, repeated additions, removal and text order', async () => {
  const tools = [declaration('a', 'first'), declaration('b'), declaration('a', 'second')];
  const copy = structuredClone(tools), f = fixture();
  const result = await f.run(tools, [developer([{ type: 'text', text: 'before' }, addition('a'), addition('b'), addition('a'), { type: 'tool-removal', toolName: 'b' }, { type: 'text', text: 'after' }])]);
  assert.deepEqual(result.messages[1], { role: 'system', timestamp: 0, content: [{ type: 'text', text: 'before' }, { type: 'text', text: 'after' }], toolsAdded: [tools[0], tools[1], tools[0]], toolsRemoved: [{ name: 'b' }] });
  assert.deepEqual(tools, copy);
});
test('missing first and later declarations reject before invoking provider', async () => {
  for (const names of [['missing', 'a'], ['a', 'missing', 'later']]) {
    const f = fixture();
    await assert.rejects(f.run([declaration('a')], [developer(names.map(addition))]), error => error.code === 'INVALID_REQUEST' && error.message === 'pi-ai tool update references undeclared tool "missing"');
    assert.equal(f.captured.length, 0);
  }
});
test('no cross-request cache and inactive declarations stay out of initial tools', async () => {
  const f = fixture(), tools = [declaration('a'), { ...declaration('b'), deferLoading: true }];
  const messages = [developer([addition('a'), addition('b')])];
  const first = await f.run(tools, messages);
  assert.deepEqual(first.messages[0].toolsAdded, [tools[0]]);
  tools[1] = { ...declaration('b', 'replacement'), deferLoading: true };
  const second = await f.run(tools, messages);
  assert.equal(second.messages[1].toolsAdded[1].description, 'replacement');
  assert.equal(first.messages[1].toolsAdded[1].description, 'b');
});
test('each developer update retains its own order and empty updates are omitted', async () => {
  const tools = [declaration('a'), declaration('b')], f = fixture();
  const result = await f.run(tools, [developer([]), developer([addition('a'), addition('b')]), { role: 'user', content: [{ type: 'text', text: 'continue' }] }, developer([addition('b'), addition('a')])]);
  assert.deepEqual(result.messages.slice(1).filter(m => m.toolsAdded).map(m => m.toolsAdded.map(t => t.name)), [['a', 'b'], ['b', 'a']]);
  assert.equal(result.messages.length, 4);
});
test('two early additions in 256 declarations never index the untouched suffix', async t => {
  const tools = Array.from({ length: 256 }, (_, i) => declaration(`tool${i}`));
  for (const second of [0, 1]) {
    const f = fixture();
    const observed = await counted(tools, () => f.run(tools, [developer([addition('tool0'), addition(`tool${second}`)])]));
    assert.deepEqual(observed.result.messages[1].toolsAdded, [tools[0], tools[second]]);
    t.diagnostic(JSON.stringify({ second, predicates: observed.predicates, indexed: observed.indexed }));
    assert.equal(observed.predicates, 1);
    assert.equal(observed.indexed, second + 1);
  }
});
test('unsupported earlier content keeps precedence over later missing declaration', async () => {
  const f = fixture();
  await assert.rejects(f.run([declaration('a')], [developer([addition('a'), { type: 'unsupported-fixture' }, addition('missing')])]), error => error.code === 'UNSUPPORTED_CONTENT' && error.message === 'pi-ai cannot represent developer content unsupported-fixture');
  assert.equal(f.captured.length, 0);
});

test('a partially indexed prefix can extend later and revisit its cached names', async () => {
  const tools = ['a', 'b', 'c', 'd'].map(name => declaration(name));
  const f = fixture(), names = ['d', 'b', 'a', 'c', 'd', 'b'];
  const result = await f.run(tools, [developer(names.map(addition))]);
  assert.deepEqual(result.messages[1].toolsAdded, names.map(name => tools.find(tool => tool.name === name)));
});


test('model discovery closes a rejected HTTP body before the next probe', { timeout: 5000 }, async t => {
  const { Context } = await import(pathToFileURL(require.resolve('@deepseek-ai/cordis')));
  const { LlmRuntime } = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-llm')));
  const ctx = new Context();
  const caller = new AbortController();
  let refused;
  const paths = [];
  const server = http.createServer((req, res) => {
    paths.push(req.url);
    if (req.url === '/models') {
      refused = res;
      res.writeHead(404, { 'content-type': 'text/html' });
      // A gateway can send the rejection headers before its body stalls.
      res.write('partial error body');
    } else {
      res.end(JSON.stringify({ data: [{ id: 'available-model' }] }));
    }
  });
  t.after(async () => {
    caller.abort();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await ctx.fiber.dispose();
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  await ctx.plugin(LlmRuntime).await();
  await ctx.plugin(pi, { providers: {} }).await();
  const baseURL = `http://127.0.0.1:${server.address().port}`;
  await assert.rejects(ctx.llm.remoteDiscoverModels('llm-pi-ai', { baseURL }, caller.signal),
    error => error.code === 'llm/model-discovery-rejected' && error.message === `${baseURL}/models answered 404`);
  // The App retries a bare endpoint's 404 at /v1; failure did not abort its owner.
  assert.deepEqual(await ctx.llm.remoteDiscoverModels('llm-pi-ai', { baseURL: `${baseURL}/v1` }, caller.signal),
    [{ id: 'available-model', name: 'available-model' }]);
  assert.equal(caller.signal.aborted, false);
  assert.deepEqual(paths, ['/models', '/v1/models']);
  if (!refused.destroyed) await once(refused, 'close', { signal: AbortSignal.timeout(1000) });
  assert.equal(refused.destroyed, true);
});
