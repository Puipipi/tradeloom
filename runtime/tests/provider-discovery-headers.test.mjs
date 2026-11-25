// Real pinned Typert codecs, LlmRuntime, pi-ai plugin and loopback HTTP only.
// DSH_PREFIX=<private patched prefix> node --test runtime/tests/provider-discovery-headers.test.mjs
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';

if (!process.env.DSH_PREFIX) throw Error('Set DSH_PREFIX to the pinned test prefix');
const base = join(resolve(process.env.DSH_PREFIX), 'node_modules/@deepseek-ai');
const load = (pkg, file = 'lib/index.js') => import(pathToFileURL(join(base, pkg, file)));
const { TYPERT } = await load('dsh-llm', 'lib/typert.host.js');
const { TYPERT_REMOTE } = await load('dsh-llm', 'lib/typert.remote-client.js');
const { LlmRuntime, attributionHeaders } = await load('dsh-llm');
const { apply, Config } = await load('dsh-llm-pi-ai');
const { SettingsForms } = await load('dsh-settings');
const descriptor = TYPERT.invocations.find(item => item.method === 'discoverModels');
const route = 'custom-header-fixture';

async function fixture(t, { headers = {}, api = 'openai-completions', requiredHeader } = {}) {
  const received = [];
  const server = createServer(async (request, response) => {
    const body = Buffer.concat(await Array.fromAsync(request)).toString('utf8');
    received.push({ path: request.url, headers: request.headers, body });
    if (requiredHeader && request.headers['x-opencode-session'] !== requiredHeader) {
      response.writeHead(403).end();
    } else if (request.url.startsWith('/v1/models')) {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ data: [{ id: 'fixture-model', name: 'Fixture Model' }] }));
    } else if (request.url === '/v1/chat/completions') {
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      for (const choice of [{ delta: { role: 'assistant', content: 'ok' }, finish_reason: null },
        { delta: {}, finish_reason: 'stop' }]) {
        response.write(`data: ${JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk', created: 1,
          model: 'fixture-model', choices: [{ index: 0, ...choice }] })}\n\n`);
      }
      response.end('data: [DONE]\n\n');
    } else {
      response.writeHead(404).end();
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
  const baseURL = `http://127.0.0.1:${server.address().port}/v1`;
  let profiles = {
    [route]: { api, baseURL, headers, apiKeyEnv: 'FIXTURE_API_KEY', models: [{ id: 'fixture-model' }] },
  };
  const service = Object.create(LlmRuntime.prototype);
  service.discoveries = new Map();
  let adapter;
  const ctx = {
    fiber: { entry: { options: { id: 'llm-pi-ai' } } },
    inject() {},
    on() { return () => {}; },
    get(name) { return name === 'credentials' ? { resolve: async () => ({ value: 'fixture-key' }) } : undefined; },
    waterfall(_name, _request, value) { return value; },
    logger: { warn() {}, error(error) { throw error; } },
    llm: {
      registerConfigurableProviders() { return { replace() {} }; },
      registerModelDiscovery(namespace, discover) { service.discoveries.set(namespace, discover); },
      registerAdapter(_routes, value) { adapter = value; return { replace() {} }; },
    },
  };
  apply(ctx, { providers: { get: () => profiles } });
  return { baseURL, get profiles() { return profiles; }, setProfiles(value) { profiles = value; },
    received, adapter, discoveries: service.discoveries,
    discover(request) {
      const decoded = descriptor.input().create().parse({ settingsNs: 'llm-pi-ai', request });
      return service.remoteDiscoverModels(decoded.settingsNs, decoded.request, new AbortController().signal);
    },
  };
}

test('Host and remote client normal and strict codecs carry draft headers', () => {
  const args = { settingsNs: 'llm-pi-ai', request: { baseURL: 'http://127.0.0.1/v1',
    headers: [{ name: 'x-opencode-session', value: 'synthetic-route' }, { name: 'x-empty', value: '' }] } };
  for (const method of [descriptor, TYPERT_REMOTE.methods['llm/discoverModels']]) {
    for (const strict of [false, true]) {
      assert.deepEqual(method.input({ strict }).create().parse(args), args);
      assert.equal(method.input({ strict }).jsonSchemaError, undefined);
      assert.equal(method.input({ strict }).jsonSchema.properties.request.properties.headers.type, 'array');
      assert.throws(() => method.input({ strict }).create().parse({ ...args, request: {
        ...args.request, headers: [{ name: 'x-number', value: 42 }],
      } }));
    }
  }
});

test('header-aware Remote capability delegates through the same real HTTP adapter', async t => {
  const f = await fixture(t, { requiredHeader: 'named-entry' });
  const method = TYPERT_REMOTE.methods['llm/discoverModelsWithHeaders'];
  assert(method, 'older Hosts have no header-aware entry point');
  const hostMethod = TYPERT.invocations.find(item => item.method === 'discoverModelsWithHeaders');
  assert(hostMethod);
  const args = { settingsNs: 'llm-pi-ai', request: { baseURL: f.baseURL, apiKey: 'draft-key',
    headers: [{ name: 'x-opencode-session', value: 'named-entry' }] } };
  for (const item of [method, hostMethod]) {
    assert.deepEqual(item.input({ strict: true }).create().parse(args), args);
    assert.equal(item.input({ strict: true }).jsonSchemaError, undefined);
  }
  const service = Object.create(LlmRuntime.prototype);
  service.discoveries = f.discoveries;
  const result = await service.remoteDiscoverModelsWithHeaders('llm-pi-ai', args.request, new AbortController().signal);
  assert.equal(result[0].id, 'fixture-model');
  assert.equal(f.received[0].headers['x-opencode-session'], 'named-entry');
});

test('bundled browser Remote assembly retains the typed headers and tool schema', async () => {
  let module;
  const require = createRequire(join(base, 'dsh-api-remotes/package.json'));
  runInNewContext(readFileSync(join(base, 'dsh-api-remotes/lib/client.js'), 'utf8'), {
    window: { __ModuleLoader__: { load(entry) { module = entry.factory(require); } } },
  });
  const contributions = [];
  const dispose = await module.apply({ remote: { async $mount(value) { contributions.push(value); return () => {}; } } });
  const method = contributions.flatMap(value => Object.entries(value.methods))
    .find(([key]) => key === 'llm/discoverModelsWithHeaders')?.[1];
  assert(method, 'the browser bundle includes the new Host capability');
  const args = { settingsNs: 'llm-pi-ai', request: { headers: [{ name: '__proto__', value: 'ordinary-header' }] } };
  for (const strict of [false, true]) {
    assert.deepEqual(method.input({ strict }).create().parse(args), args);
    assert.equal(method.input({ strict }).jsonSchemaError, undefined);
  }
  await dispose();
});

test('new draft reaches a real gateway that requires its request header', async t => {
  const f = await fixture(t, { requiredHeader: 'draft-route' });
  const result = await f.discover({ baseURL: f.baseURL, apiKey: 'draft-key',
    headers: [{ name: 'x-opencode-session', value: 'draft-route' }] });
  assert.equal(result[0].id, 'fixture-model');
  assert.equal(f.received[0].headers['x-opencode-session'], 'draft-route');
  assert.equal(f.received[0].headers.authorization, 'Bearer draft-key');
  assert.deepEqual(f.profiles[route].headers, {}, 'a discovery request does not persist its draft');
});

test('omitted headers preserve the stored profile and credential', async t => {
  const f = await fixture(t, { headers: { 'x-opencode-session': 'stored-route' }, requiredHeader: 'stored-route' });
  await f.discover({ provider: route, baseURL: f.baseURL });
  assert.equal(f.received[0].headers['x-opencode-session'], 'stored-route');
  assert.equal(f.received[0].headers.authorization, 'Bearer fixture-key');
});

test('actual settings mutation replaces or clears headers; unset restores the inherited layer', async t => {
  const f = await fixture(t, { headers: { 'x-inherited': 'base' } });
  const inherited = { providers: structuredClone(f.profiles) };
  const entry = { id: 'llm-entry', options: { id: 'llm-pi-ai', config: structuredClone(inherited) } };
  entry.fiber = { uid: 1, state: 2, runtime: { Config }, ctx: {} };
  const update = value => {
    entry.options.config = structuredClone(value);
    entry.fiber.effectiveConfig = entry.fiber.config = Config(structuredClone(value));
    f.setProfiles(entry.fiber.config.providers.get());
  };
  update(inherited);
  const editor = {
    entries: () => [entry],
    configuration: () => [{ entry, inherited, override: entry.options.config }],
    async edit(target, change) {
      assert.equal(target, entry);
      update(change(structuredClone(entry.options.config), structuredClone(inherited)));
    },
  };
  const settings = Object.create(SettingsForms.prototype);
  Object.assign(settings, { ownerContext: { configEditor: editor, emit() {} },
    revisions: new Map(), presentations: new Map() });
  const headersPath = ['providers', route, 'headers'];
  const revision = () => settings.describe().find(item => item.ns === 'llm-pi-ai').revision;
  await settings.mutate('llm-pi-ai', [{ op: 'set', path: headersPath, value: { 'x-saved': 'next' } }], revision());
  await f.discover({ provider: route, baseURL: f.baseURL });
  assert.equal(f.received[0].headers['x-saved'], 'next');
  assert.equal(f.received[0].headers['x-inherited'], undefined);
  await settings.mutate('llm-pi-ai', [{ op: 'set', path: headersPath, value: {} }], revision());
  assert.deepEqual(entry.options.config.providers[route].headers, {});
  await f.discover({ provider: route, baseURL: f.baseURL });
  assert.equal(f.received[1].headers['x-saved'], undefined);
  assert.equal(f.received[1].headers['x-inherited'], undefined);
  await settings.mutate('llm-pi-ai', [{ op: 'unset', path: headersPath }], revision());
  await f.discover({ provider: route, baseURL: f.baseURL });
  assert.equal(f.received[2].headers['x-inherited'], 'base');
});

test('explicit draft headers replace stored keys and an empty list clears them for this request', async t => {
  const f = await fixture(t, { headers: { 'x-old': 'old', 'x-opencode-session': 'stored-route' } });
  await f.discover({ provider: route, baseURL: f.baseURL, headers: [{ name: 'x-new', value: 'next' }] });
  assert.equal(f.received[0].headers['x-new'], 'next');
  assert.equal(f.received[0].headers['x-old'], undefined);
  assert.equal(f.received[0].headers['x-opencode-session'], undefined);
  await f.discover({ provider: route, baseURL: f.baseURL, headers: [] });
  assert.equal(f.received[1].headers['x-old'], undefined);
  assert.equal(f.received[1].headers['x-opencode-session'], undefined);
  assert.deepEqual(f.profiles[route].headers, { 'x-old': 'old', 'x-opencode-session': 'stored-route' });
});

for (const api of ['openai-completions', 'openai-responses', 'anthropic-messages']) {
  test(`${api} retains controlled auth, version and attribution precedence`, async t => {
    const f = await fixture(t);
    await f.discover({ baseURL: f.baseURL, api, apiKey: 'draft-key', headers: [
      { name: 'x-custom', value: 'visible' }, { name: 'authorization', value: 'ignored-bearer' },
      { name: 'x-api-key', value: 'ignored-key' }, { name: 'anthropic-version', value: 'ignored-version' },
      { name: 'user-agent', value: 'ignored-agent' }, { name: 'accept', value: 'ignored-accept' },
    ] });
    const sent = f.received[0].headers;
    assert.equal(sent['x-custom'], 'visible');
    assert.equal(sent.accept, 'application/json');
    assert.equal(sent['user-agent'], attributionHeaders()['user-agent']);
    if (api === 'anthropic-messages') {
      assert.equal(sent['x-api-key'], 'draft-key');
      assert.equal(sent['anthropic-version'], '2023-06-01');
    } else {
      assert.equal(sent.authorization, 'Bearer draft-key');
    }
  });
}

test('stored custom headers reach actual inference and attribution still wins', async t => {
  const f = await fixture(t, { headers: { 'x-opencode-session': 'saved-route', 'user-agent': 'ignored-agent' },
    requiredHeader: 'saved-route' });
  const chunks = await Array.fromAsync(f.adapter.stream({ provider: route, model: 'fixture-model',
    tools: [], messages: [{ role: 'user', content: [{ type: 'text', text: 'synthetic prompt' }] }] }));
  assert.equal(chunks.at(-1).reason.kind, 'stop');
  const sent = f.received.find(item => item.path === '/v1/chat/completions');
  assert(sent);
  assert.equal(sent.headers['x-opencode-session'], 'saved-route');
  assert.equal(sent.headers['user-agent'], attributionHeaders()['user-agent']);
  assert.equal(sent.headers.authorization, 'Bearer fixture-key');
});

test('malformed draft header fails before network and does not echo its value', async t => {
  const f = await fixture(t);
  await assert.rejects(f.discover({ baseURL: f.baseURL, apiKey: 'draft-key',
    headers: [{ name: 'x-route', value: 'synthetic\nprivate-value' }] }), error =>
    error.code === 'llm/model-discovery-rejected' && !error.message.includes('private-value'));
  assert.equal(f.received.length, 0);
});
