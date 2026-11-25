import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, realpath, readdir, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Config, CREDENTIAL_SLOTS, catalogModel } from '../src/config.js';
import { createWorkspaceAuthorizer, installMedia } from '../src/index.js';
import { MediaError } from '../src/errors.js';
import { createHttpTransport } from '../src/http.js';
import { createBudgetLedger } from '../src/budget-ledger.js';

function deferred() {
  let resolve;
  const promise = new Promise(yes => { resolve = yes; });
  return { promise, resolve };
}

const service = overrides => ({
  id: 'office', enabled: true, keyRef: CREDENTIAL_SLOTS[0], ...overrides,
});

function mockResult(request) {
  return {
    meta: {
      v: 1, rid: 'unit-test-only', kind: 'image', status: 'done',
      items: [{ path: '/unit-test-only.png', mime: 'image/png', width: 1, height: 1, bytes: 1 }],
      request: { provider: request.service.provider, model: request.model.id, label: request.model.label, n: request.n },
      prompt: request.prompt,
    },
    text: 'mock core result; no image file or provider call was made',
  };
}

async function fixture(t, { raw = {}, configured = [], generate, describe, engineOptions, approve } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-media-wiring-'));
  const workspace = join(directory, 'workspace');
  await mkdir(workspace);
  const home = join(directory, 'host-home');
  let parsed = Config(raw);
  const config = {
    dshHome: home,
    services: { get: () => parsed.services.get() },
    defaults: { get: () => parsed.defaults.get() },
    limits: { get: () => parsed.limits.get() },
    budget: { get: () => parsed.budget.get() },
  };
  const registered = new Map();
  const prompts = new Map();
  const listeners = new Map();
  const effects = [];
  const present = new Set(configured);
  const describeRefs = [];
  const resolveRefs = [];
  let mode = 'workspace-write';
  let cwd = workspace;
  let active = true;
  let policyReads = 0;
  const assertActive = () => { if (!active) throw new Error('fixture disposed'); };
  const session = { id: 'session-A', header: { cwd: workspace } };
  const agent = { session, ctx: { fiber: { assertActive } } };
  const ctx = {
    fiber: { assertActive },
    effect(callback) {
      const dispose = callback();
      effects.push(dispose);
      return dispose;
    },
    on(event, callback) {
      const entries = listeners.get(event) ?? [];
      entries.push(callback);
      listeners.set(event, entries);
      return () => listeners.set(event, entries.filter(item => item !== callback));
    },
    jobs: { events: { subscribe() { return () => {}; } } },
    approval: { request: approve ?? (async () => 'allowed-once') },
    tools: {
      register(definition) {
        assert.equal(registered.has(definition.name), false);
        registered.set(definition.name, definition);
        return () => {
          if (registered.get(definition.name) === definition) registered.delete(definition.name);
        };
      },
    },
    systemPrompt: {
      section(section) {
        assert.equal(prompts.has(section.name), false);
        prompts.set(section.name, section);
        return () => {
          if (prompts.get(section.name) === section) prompts.delete(section.name);
        };
      },
    },
    credentials: {
      async describe(ref) {
        describeRefs.push(String(ref));
        if (describe) return describe(ref);
        return { configured: present.has(String(ref)), writable: true };
      },
      async resolve(ref) {
        resolveRefs.push(String(ref));
        return present.has(String(ref)) ? { value: 'unit-test-key', source: 'fixture' } : undefined;
      },
    },
    sandboxPolicy: {
      resolve({ session: input }) {
        assert.equal(input, session);
        policyReads += 1;
        return { mode, workspaceRoot: workspace };
      },
    },
    workingDirectory: {
      async ensure(input, signal) {
        assert.equal(input, agent);
        signal.throwIfAborted();
        return cwd;
      },
      get(input) { assert.equal(input, session); return cwd; },
    },
    fs: {
      async resolve(path, { signal } = {}) {
        signal?.throwIfAborted();
        const canonical = await realpath(path);
        return { targetKey: canonical, displayPath: canonical };
      },
      processPath: target => target.targetKey,
      processPathFromHostPath: path => resolve(path),
    },
  };
  // Any command registration is outside M0.
  Object.defineProperty(ctx, 'commands', { get() { throw new Error('unexpected command access'); } });
  const installed = installMedia(ctx, config, engineOptions === undefined
    ? { generate: generate ?? (async request => mockResult(request)) }
    : { engineOptions });
  let cleaned = false;
  async function cleanup() {
    if (cleaned) return;
    cleaned = true;
    await installed.dispose();
    for (const dispose of effects.reverse()) await dispose();
    active = false;
    await rm(directory, { recursive: true, force: true });
  }
  t.after(cleanup);
  return {
    ctx, agent, session, installed, workspace, home, registered, prompts, present,
    describeRefs, resolveRefs, cleanup,
    setRaw(value) { parsed = Config(value); },
    setMode(value) { mode = value; },
    setCwd(value) { cwd = value; },
    policyReads: () => policyReads,
    emit(event, ...args) { for (const callback of listeners.get(event) ?? []) callback(...args); },
    exec() { return { callId: 'unit-call', name: 'generate_image', agent, signal: new AbortController().signal }; },
  };
}

test('no services, disabled services, or missing credentials do not register a tool or prompt', async t => {
  for (const [raw, configured] of [
    [{}, [CREDENTIAL_SLOTS[0]]],
    [{ services: [service({ enabled: false })] }, [CREDENTIAL_SLOTS[0]]],
    [{ services: [service()] }, []],
  ]) {
    const f = await fixture(t, { raw, configured });
    await f.installed.ready;
    assert.equal(f.registered.size, 0);
    assert.equal(f.prompts.size, 0);
    assert.deepEqual(f.resolveRefs, []);
    await f.cleanup();
  }
});

test('credential changes register and immediately retire capabilities without resolving a secret', async t => {
  const f = await fixture(t, { raw: { services: [service()] } });
  await f.installed.ready;
  assert.equal(f.registered.size, 0);
  f.present.add(CREDENTIAL_SLOTS[0]);
  f.emit('credentials/reference-updated', CREDENTIAL_SLOTS[0]);
  await f.installed.settled();
  assert.ok(f.registered.has('generate_image'));
  assert.equal(f.prompts.size, 1);
  assert.deepEqual(f.resolveRefs, []);
  const prompt = f.prompts.get('dsh-media').text;
  assert.ok(prompt.includes('"serviceId":"office"'));
  assert.ok(prompt.includes('"modelId":"gpt-image-2.5-flare"'));
  assert.ok(prompt.includes('"label":"GPT Image 2.5 Flare"'));
  assert.equal(prompt.includes(CREDENTIAL_SLOTS[0]), false);
  assert.equal(prompt.includes('https://api.openai.com'), false);
  f.present.delete(CREDENTIAL_SLOTS[0]);
  f.emit('credentials/reference-updated', CREDENTIAL_SLOTS[0]);
  assert.equal(f.registered.size, 0);
  assert.equal(f.prompts.size, 0);
  await f.installed.settled();
  assert.equal(f.registered.size, 0);
});

test('late credential description cannot resurrect configuration that was removed', async t => {
  const gate = deferred();
  const f = await fixture(t, {
    raw: { services: [service()] },
    describe: () => gate.promise,
  });
  try {
    f.setRaw({});
    f.emit('loader/volatile-update', [['services']]);
    await f.installed.settled();
    assert.equal(f.registered.size, 0);
    gate.resolve({ configured: true, writable: true });
    await f.installed.ready;
    assert.equal(f.registered.size, 0);
  } finally {
    gate.resolve({ configured: false, writable: true });
    await f.installed.ready;
  }
});

test('disposal retires a pending setup before its description resolves', async t => {
  const gate = deferred();
  const f = await fixture(t, {
    raw: { services: [service()] },
    describe: () => gate.promise,
  });
  try {
    await f.installed.dispose();
    gate.resolve({ configured: true, writable: true });
    await f.installed.ready;
    assert.equal(f.registered.size, 0);
    assert.equal(f.prompts.size, 0);
  } finally {
    gate.resolve({ configured: false, writable: true });
    await f.installed.ready;
  }
});

test('chosen service identity and credential stay bound; output exposes only media meta and text', async t => {
  let captured;
  let seenContext;
  const f = await fixture(t, {
    raw: { services: [
      service(),
      service({ id: 'studio', keyRef: CREDENTIAL_SLOTS[1], models: 'gpt-image-2' }),
    ] },
    configured: [CREDENTIAL_SLOTS[0], CREDENTIAL_SLOTS[1]],
    async generate(request, context) {
      captured = request;
      seenContext = { hostStateDir: context.hostStateDir, sessionId: context.sessionId };
      assert.equal(await context.resolveCredential(), 'unit-test-key');
      const authorization = await context.authorizeWorkspace();
      assert.equal(authorization.mode, 'workspace-write');
      assert.equal(authorization.cwd, await realpath(f.workspace));
      return mockResult(request);
    },
  });
  await f.installed.ready;
  const definition = f.registered.get('generate_image');
  const args = { prompt: '原始描述\n保留第二行', serviceId: 'studio', modelId: 'gpt-image-2', aspect: '1:1', n: 1 };
  const result = await definition.execute(args, f.exec());
  assert.equal(captured.prompt, args.prompt);
  assert.equal(captured.service.id, 'studio');
  assert.equal(captured.model.id, 'gpt-image-2');
  assert.deepEqual(f.resolveRefs, [CREDENTIAL_SLOTS[1]]);
  assert.equal(Object.hasOwn(captured.service, 'keyRef'), false);
  assert.equal(JSON.stringify(captured).includes('unit-test-key'), false);
  assert.deepEqual(seenContext, {
    hostStateDir: join(f.home, 'media', 'dsh-media'), sessionId: 'session-A',
  });
  assert.deepEqual(definition.output.render(args, result), [{ type: 'text', text: result.text }]);
  assert.deepEqual(definition.output.presentationMeta(args, result), { 'dsh-go/media': result.meta });
  assert.equal(JSON.stringify(result).includes('unit-test-key'), false);
  assert.ok(f.policyReads() > 1);
});

test('unselected services, extra fields, Unicode byte overflow and mismatched aspect fail before core', async t => {
  let called = 0;
  const f = await fixture(t, {
    raw: { services: [service()], defaults: { serviceId: 'missing' } },
    configured: [CREDENTIAL_SLOTS[0]],
    generate: async request => { called += 1; return mockResult(request); },
  });
  await f.installed.ready;
  const tool = f.registered.get('generate_image');
  for (const args of [
    { prompt: 'cat' },
    { prompt: 'cat', serviceId: 'office', apiKey: 'not-accepted' },
    { prompt: 'cat', serviceId: 'office', baseUrl: 'https://elsewhere.test' },
    { prompt: '猫'.repeat(1366), serviceId: 'office' },
    { prompt: 'cat', serviceId: 'office', aspect: '1:1', size: '1536x1024' },
    { prompt: 'cat', serviceId: 'office', modelId: 'gpt-image-2' },
  ]) await assert.rejects(() => tool.execute(args, f.exec()));
  assert.equal(called, 0);
  assert.deepEqual(f.resolveRefs, []);
});

test('retiring a configured service aborts and drains a running call', async t => {
  const started = deferred();
  const unblock = deferred();
  let signal;
  const f = await fixture(t, {
    raw: { services: [service()] }, configured: [CREDENTIAL_SLOTS[0]],
    async generate(_request, context) {
      signal = context.signal;
      started.resolve();
      await unblock.promise;
      if (signal.aborted) throw new MediaError('cancelled');
      throw new Error('test must abort this call');
    },
  });
  await f.installed.ready;
  const operation = f.registered.get('generate_image').execute({ prompt: 'cat' }, f.exec());
  // Attach the rejection observer before causing cancellation.
  const rejected = assert.rejects(operation, error => error.code === 'cancelled');
  try {
    await started.promise;
    f.setRaw({ services: [service({ enabled: false })] });
    f.emit('loader/volatile-update', [['services']]);
    assert.equal(signal.aborted, true);
    assert.equal(f.registered.size, 0);
    unblock.resolve();
    await rejected;
    await f.installed.settled();
  } finally {
    unblock.resolve();
    await Promise.allSettled([operation]);
  }
});

for (const submitted of [false, true]) {
  test(`settings refresh ${submitted ? 'after POST preserves submission_unknown' : 'before submission remains cancelled'}`, { timeout: 10000 }, async t => {
    // Real installMedia, admission, engine, HTTP and disk; ctx and the incoming
    // volatile notification are fixtures. The server never invents a receipt.
    const received = deferred(), approval = deferred(), approved = deferred(), closed = deferred();
    const wires = [];
    const server = createServer(async (request, _response) => {
      const chunks = [];
      for await (const bytes of request) chunks.push(bytes);
      wires.push({ method: request.method, path: request.url, body: JSON.parse(Buffer.concat(chunks)) });
      received.resolve();
    });
    server.on('connection', socket => socket.once('close', () => closed.resolve()));
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const origin = `http://127.0.0.1:${server.address().port}`;
    const local = createHttpTransport({ allowLoopback: true });
    const raw = { services: [service({ models: 'gpt-image-2' })], budget: { dailyCny: '20', unknownPriceHoldCny: '20' } };
    let approvals = 0;
    let f;
    try {
      f = await fixture(t, {
        raw, configured: [CREDENTIAL_SLOTS[0]],
        approve() {
          approvals++;
          approval.resolve();
          return submitted ? 'allowed-once' : approved.promise;
        },
        engineOptions: { transport(url, options) {
          assert.equal(new URL(url).origin, 'https://api.openai.com');
          return local(origin + new URL(url).pathname, options);
        } },
      });
      await f.installed.ready;
      const exec = f.exec();
      const outcome = f.registered.get('generate_image').execute({ prompt: 'a blue circle' }, exec)
        .then(() => assert.fail('refresh must abort the operation'), error => error);
      await Promise.race([(submitted ? received : approval).promise, outcome.then(error => { throw error; })]);
      assert.equal(exec.signal.aborted, false);
      if (submitted) {
        assert.equal(wires.length, 1);
        assert.equal(wires[0].method, 'POST');
        assert.equal(wires[0].path, '/v1/images/generations');
        assert.equal(wires[0].body.model, 'gpt-image-2');
      }
      f.setRaw({ ...raw, budget: { ...raw.budget, dailyCny: '40' } });
      f.emit('loader/volatile-update', [['budget']]);
      approved.resolve('allowed-once');
      const error = await outcome;
      assert.equal(exec.signal.aborted, false);
      await f.installed.settled();
      assert.ok(f.registered.has('generate_image'));
      assert.equal(approvals, 1);
      assert.equal(wires.length, submitted ? 1 : 0);
      const ledger = await createBudgetLedger(join(f.home, 'media', 'dsh-media', 'budget')).snapshot();
      assert.equal(ledger.requests.length, submitted ? 1 : 0);
      if (submitted) {
        await closed.promise;
        const record = ledger.requests[0];
        assert.equal(record.state, 'submission_unknown');
        assert.equal(record.estimateMicros, 20_000_000);
        assert.equal(record.providerTaskId, undefined);
        assert.deepEqual(await readdir(join(f.workspace, 'generated', record.outputDate)), []);
      }
      assert.equal(error.code, submitted ? 'submission_unknown' : 'cancelled');
    } finally {
      approved.resolve('allowed-once');
      await f?.cleanup();
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    }
  });
}

test('authorization rechecks the real session policy on every invocation', async t => {
  const f = await fixture(t);
  await f.installed.ready;
  const exec = f.exec();
  const authorize = createWorkspaceAuthorizer(f.ctx, exec, exec.signal);
  assert.equal((await authorize()).mode, 'workspace-write');
  f.setMode('read-only');
  await assert.rejects(authorize, error => error.code === 'permission');
});

test('an unmapped backend is rejected without inferring support from a class name', async t => {
  const f = await fixture(t);
  await f.installed.ready;
  f.ctx.fs.processPathFromHostPath = () => undefined;
  const exec = f.exec();
  const authorize = createWorkspaceAuthorizer(f.ctx, exec, exec.signal);
  await assert.rejects(authorize, error => error.code === 'unsupported_backend');
});

test('a policy change across a filesystem await rejects authorization', async t => {
  const f = await fixture(t);
  await f.installed.ready;
  const gate = deferred();
  const reached = deferred();
  const original = f.ctx.fs.resolve;
  let first = true;
  f.ctx.fs.resolve = async (...args) => {
    if (first) {
      first = false;
      reached.resolve();
      await gate.promise;
    }
    return original(...args);
  };
  const exec = f.exec();
  const pending = createWorkspaceAuthorizer(f.ctx, exec, exec.signal)();
  const rejected = assert.rejects(pending, error => error.code === 'permission');
  try {
    await reached.promise;
    f.setMode('read-only');
    gate.resolve();
    await rejected;
  } finally {
    gate.resolve();
    await Promise.allSettled([pending]);
  }
});

test('an agent rebound across working-directory await cannot acquire the new session', async t => {
  const f = await fixture(t);
  await f.installed.ready;
  const gate = deferred();
  f.ctx.workingDirectory.ensure = () => gate.promise;
  const exec = f.exec();
  const pending = createWorkspaceAuthorizer(f.ctx, exec, exec.signal)();
  const rejected = assert.rejects(pending, error => error.code === 'permission');
  try {
    f.agent.session = { id: 'session-B', header: { cwd: f.workspace } };
    gate.resolve(f.workspace);
    await rejected;
  } finally {
    gate.resolve(f.workspace);
    await Promise.allSettled([pending]);
  }
});

test('unrelated credential updates do not cancel or replace a configured image tool', async t => {
  const f = await fixture(t, {
    raw: { services: [service()] }, configured: [CREDENTIAL_SLOTS[0]],
  });
  await f.installed.ready;
  const tool = f.registered.get('generate_image');
  f.emit('credentials/reference-updated', 'UNRELATED_LLM_KEY');
  await f.installed.settled();
  assert.equal(f.registered.get('generate_image'), tool);
});

test('workspace-write refuses a current directory outside the session workspace', async t => {
  const f = await fixture(t);
  await f.installed.ready;
  const outside = join(f.home, 'outside');
  await mkdir(outside, { recursive: true });
  f.setCwd(outside);
  const exec = f.exec();
  const authorize = createWorkspaceAuthorizer(f.ctx, exec, exec.signal);
  await assert.rejects(authorize, error => error.code === 'permission');
});

test('Gemini-only setup registers a usable schema and the documented compatible request', async t => {
  let captured;
  const f = await fixture(t, {
    raw: { services: [service({
      id: 'gemini', provider: 'google',
      baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
      profile: 'openai-compatible', responseFormat: 'b64_json',
      models: 'gemini-2.5-flash-image', keyRef: CREDENTIAL_SLOTS[1],
    })] },
    configured: [CREDENTIAL_SLOTS[1]],
    async generate(request, context) {
      captured = request;
      assert.equal(await context.resolveCredential(), 'unit-test-key');
      assert.equal((await context.authorizeWorkspace()).mode, 'workspace-write');
      return mockResult(request);
    },
  });
  await f.installed.ready;
  assert.equal(f.registered.size, 1);
  const tool = f.registered.get('generate_image');
  const properties = tool.parameters.properties;
  assert.deepEqual(properties.n.enum, [1]);
  assert.deepEqual(properties.modelId.enum, ['gemini-2.5-flash-image']);
  for (const field of ['aspect', 'size', 'quality']) {
    assert.equal(Object.hasOwn(properties, field), false);
  }
  assert.equal(tool.parameters.additionalProperties, false);
  const result = await tool.execute({ prompt: 'A simple blue circle', n: 1 }, f.exec());
  assert.deepEqual(captured, {
    prompt: 'A simple blue circle', n: 1, refs: [],
    service: {
      id: 'gemini', provider: 'google',
      baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
      profile: 'openai-compatible', responseFormat: 'b64_json',
    },
    model: catalogModel('gemini-2.5-flash-image'),
  });
  assert.deepEqual(f.resolveRefs, [CREDENTIAL_SLOTS[1]]);
  assert.equal(result.meta.request.model, 'gemini-2.5-flash-image');
  const prompt = f.prompts.get('dsh-media').text;
  assert.ok(prompt.includes('"serviceId":"gemini"'));
  assert.ok(prompt.includes('"modelId":"gemini-2.5-flash-image"'));
  assert.equal(prompt.includes('generativelanguage.googleapis.com'), false);
  assert.equal(prompt.includes(CREDENTIAL_SLOTS[1]), false);
});

test('mixed-service schema does not grant Gemini unverified count or optional parameters', async t => {
  let called = 0;
  const f = await fixture(t, {
    raw: { services: [
      service(),
      service({
        id: 'gemini', provider: 'google',
        baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
        profile: 'openai-compatible', responseFormat: 'b64_json',
        models: 'gemini-2.5-flash-image', keyRef: CREDENTIAL_SLOTS[1],
      }),
    ] },
    configured: [CREDENTIAL_SLOTS[0], CREDENTIAL_SLOTS[1]],
    generate: async request => { called += 1; return mockResult(request); },
  });
  await f.installed.ready;
  const tool = f.registered.get('generate_image');
  // OpenAI still contributes these optional arguments to the union schema.
  assert.ok(tool.parameters.properties.aspect.enum.includes('1:1'));
  for (const extra of [
    { n: 2 }, { aspect: '1:1' }, { size: '1024x1024' }, { quality: 'high' },
    { response_format: 'b64_json' }, { extra_body: { aspect_ratio: '1:1' } },
    { modelId: 'gpt-image-2.5-flare' },
  ]) {
    await assert.rejects(() => tool.execute({
      prompt: 'A simple blue circle', serviceId: 'gemini', ...extra,
    }, f.exec()));
  }
  assert.equal(called, 0);
  assert.deepEqual(f.resolveRefs, []);
});

test('registered video tool routes around an image default without applying the image model', async t => {
  const captured = [];
  const f = await fixture(t, {
    raw: { services: [service({ models: 'gpt-image-2' }), service({ id: 'video', provider: 'ark', profile: 'ark-video', baseUrl: 'https://ark.cn-beijing.volces.com', models: 'doubao-seedance-2-5-260628' })],
      defaults: { serviceId: 'office', modelId: 'gpt-image-2' } },
    configured: [CREDENTIAL_SLOTS[0]],
    generate: async request => { captured.push(request); return mockResult(request); },
  });
  const hooks = [];
  f.ctx.jobs = {
    start(spec) { const id = 'media-unit-' + hooks.length; hooks.push(spec.run({ id, updateProgress() {}, append() {} })); return id; },
    get() { return {}; },
  };
  await f.installed.ready;
  const tool = f.registered.get('generate_video'); assert.ok(tool);
  await tool.execute({ prompt: '猫' }, f.exec());
  await tool.execute({ prompt: '猫', serviceId: 'video' }, f.exec());
  await Promise.all(hooks.map(hook => hook.done));
  assert.equal(captured.length, 2);
  for (const request of captured) { assert.equal(request.service.id, 'video'); assert.equal(request.model.id, 'doubao-seedance-2-5-260628'); }
  await assert.rejects(() => tool.execute({ prompt: '猫', serviceId: 'office' }, f.exec()));
});

test('registered video tool follows the per-kind video default over the legacy image default', async t => {
  const captured = [];
  const f = await fixture(t, {
    raw: { services: [
      service({ models: 'gpt-image-2' }),
      service({ id: 'video', provider: 'ark', profile: 'ark-video', baseUrl: 'https://ark.cn-beijing.volces.com', models: 'doubao-seedance-2-5-260628' }),
    ], defaults: {
      serviceId: 'office', modelId: 'gpt-image-2',
      videoServiceId: 'video', videoModelId: 'doubao-seedance-2-5-260628',
    } },
    configured: [CREDENTIAL_SLOTS[0]],
    generate: async request => { captured.push(request); return mockResult(request); },
  });
  const hooks = [];
  f.ctx.jobs = {
    start(spec) { const id = 'media-unit-' + hooks.length; hooks.push(spec.run({ id, updateProgress() {}, append() {} })); return id; },
    get() { return {}; },
  };
  await f.installed.ready;
  const tool = f.registered.get('generate_video');
  assert.ok(tool);
  await tool.execute({ prompt: '猫' }, f.exec());
  await Promise.all(hooks.map(hook => hook.done));
  assert.equal(captured.length, 1);
  assert.equal(captured[0].service.id, 'video');
  assert.equal(captured[0].model.id, 'doubao-seedance-2-5-260628');
});
