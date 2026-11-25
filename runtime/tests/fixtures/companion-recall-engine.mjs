// Shared real-engine fixture. DSH_PREFIX names the verified, patched package
// prefix. Network is blocked: the actual direct DeepSeek adapter sees only the
// controlled fetch endpoint below. The public controller resolver and the
// permission-preset selection getter are explicit controlled Host boundaries.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createCompanionStore } from '../../bridge/dsh-go-bridge/lib/companion/store.js';
import { createRecallCoordinator } from '../../bridge/dsh-go-bridge/lib/companion/recall.js';
import { createRecallMarkers } from '../../bridge/dsh-go-bridge/lib/companion/recall-markers.js';
import { createRecallContexts } from '../../bridge/dsh-go-bridge/lib/companion/recall-context.js';
import { createCompanionPromptContext } from '../../bridge/dsh-go-bridge/lib/companion/prompt-context.js';
import { companionFullDefault, companionFullRules } from '../../bridge/dsh-go-bridge/lib/companion/full-persona.js';

const FULL_PRESET = 'dsh-go-companion-full';
const personaText = companionFullDefault;
const personaRules = companionFullRules;

const loaded = new Map();
let environmentOwner;

export async function loadEngine(prefix = process.env.DSH_PREFIX) {
  if (!prefix) throw new Error('Set DSH_PREFIX to the verified C902 runtime prefix');
  prefix = resolve(prefix);
  if (!loaded.has(prefix)) loaded.set(prefix, (async () => {
    const base = join(prefix, 'node_modules', '@deepseek-ai');
    const load = (name) => import(pathToFileURL(join(base, name, 'lib/index.js')).href);
    const [boot, cordis, session, agent, loop, presets, prompt, llm, deepseek, tools, native] = await Promise.all([
      load('dsh-app-boot'), load('cordis'), load('dsh-session'), load('dsh-agent'), load('dsh-agent-loop'),
      load('dsh-agent-preset-registry'), load('dsh-system-prompt'), load('dsh-llm'),
      load('dsh-llm-deepseek'), load('dsh-tools'), load('dsh-tool-executor-native'),
    ]);
    return { prefix, base, load, boot, cordis, session, agent, loop, presets, prompt, llm, deepseek, tools, native };
  })());
  return loaded.get(prefix);
}

export function sseResponse(events, { status = 200, headers = {} } = {}) {
  const text = events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join('');
  return new Response(text, { status, headers: { 'content-type': 'text/event-stream', ...headers } });
}

export function textResponse(text = 'Synthetic fixture reply', { model = 'c750-fixture-model' } = {}) {
  return sseResponse([
    { type: 'message_start', message: { id: 'synthetic-message', type: 'message', role: 'assistant', model,
      content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 5, output_tokens: 0 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 3 } },
    { type: 'message_stop' },
  ]);
}

export async function createFixture({ prefix, home: existingHome, keepHome = false,
  transport, configureLlm, resolveAgent, permission = 'workspace-write', withRecall = true,
  now = Date.now, deepseekOptions = {}, deepseekDependencies = {}, rootExecutor = 'native' } = {}) {
  // One Host owns DSH_HOME in a process. Tests of independent Hosts use child
  // processes, rather than pretending a mutable process-global home is scoped.
  if (environmentOwner) throw new Error('Independent recall Hosts require independent fixture processes');
  const home = existingHome ?? await mkdtemp(join(tmpdir(), 'dsh-go-recall-engine-'));
  await mkdir(home, { recursive: true });
  const token = {};
  environmentOwner = token;
  const previousHome = process.env.DSH_HOME;
  const originalFetch = globalThis.fetch;
  process.env.DSH_HOME = home;
  const endpoint = new URL(`https://c750-${randomUUID()}.invalid/anthropic`);
  const requests = [], resolutions = [];
  const permissionState = { value: permission };
  let ctx, coordinator, adapter, closed = false;
  const contexts = createRecallContexts();
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
    if (url.origin !== endpoint.origin) throw new Error('Network disabled outside the synthetic recall fixture endpoint');
    init.signal?.throwIfAborted();
    const request = { url, init, rawBody: init.body,
      body: typeof init.body === 'string' ? JSON.parse(init.body) : init.body,
      sessionId: new Headers(init.headers).get('x-deepseek-harness-session-id') };
    requests.push(request);
    if (transport) return transport(request, requests.length);
    if (url.pathname.endsWith('/messages')) return textResponse();
    throw new Error('Synthetic transport has no handler for this endpoint');
  };
  const restore = () => {
    globalThis.fetch = originalFetch;
    if (previousHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previousHome;
    if (environmentOwner === token) environmentOwner = undefined;
  };
  try {
    const engine = await loadEngine(prefix);
    const entry = (id, name, config = {}) => ({ id,
      name: pathToFileURL(join(engine.base, name, 'lib/index.js')).href, config });
    const main = join(home, 'fixture-main.json');
    await writeFile(main, JSON.stringify([
      entry('sessions', 'dsh-session'), entry('projections', 'dsh-session-projection'),
      entry('agents', 'dsh-agent'), entry('presets', 'dsh-agent-preset-registry', { default: FULL_PRESET }),
      entry('prompt', 'dsh-system-prompt', { includeHarnessIdentity: true, includeRuntimeContext: true }),
      entry('llm', 'dsh-llm'), entry('tools', 'dsh-tools'),
      entry('native', rootExecutor === 'ptc' ? 'dsh-tool-executor-ptc' : 'dsh-tool-executor-native'),
      entry('loop', 'dsh-agent-loop', { agents: [] }),
    ]));
    ctx = await engine.boot.boot('dsh', main, [], (host) => {
      host.provide('profileContext', { dir: home, installAnchor: join(engine.base, 'dsh-session/package.json') });
      host.provide('permissionPresets', { current: () => permissionState.value });
      if (rootExecutor === 'ptc') host.provide('ptcRuntime', {
        language: 'typescript',
        async evaluate() { throw new Error('This fixture must never execute a program'); },
      });
    });
    const pctx = ctx;
    const route = { provider: 'c750-direct-deepseek', model: 'c750-fixture-model', reasoningEffort: 'off', maxTokens: 128 };
    const providerOptions = engine.deepseek.resolveAdapterOptions({
      baseURL: endpoint.href, thinking: 'disabled', maxTokens: 128, defaultContextWindow: 8192,
      models: [{ id: route.model, inputModalities: ['text'], maxTokens: 128, contextWindow: 8192 }],
      streamIdleTimeoutMs: 5000, retryPolicy: { mode: 'normal', maxRetries: 0,
        backoff: { initialDelayMs: 1, maxDelayMs: 1, jitterRatio: 0 } }, ...deepseekOptions,
    });
    const provider = new engine.deepseek.DeepSeekAdapter({
      options: () => providerOptions,
      resolveAuth: async () => ({ headers: { authorization: 'Bearer synthetic-not-a-credential' } }),
      prepareExtensions: async () => ({ fields: {}, accept: async () => {} }),
      onExtensionsOmitted() {}, onExtensionsUnaccepted() {},
      resolveUserId: () => 'synthetic-recall-user', ...deepseekDependencies,
    });
    ctx.llm.registerAdapter([route.provider], provider);
    await configureLlm?.({ ctx, engine, provider, route, providerOptions, requests });
    const controller = {
      async resolveAgent(id) {
        resolutions.push(id);
        const agent = ctx.agents.get(id);
        if (resolveAgent) return resolveAgent(id, { agent, ctx });
        return agent ? { agent } : { error: { code: 'session/not-found', message: 'Synthetic fixture session is not active' } };
      },
      createSession() { throw new Error('Recall binding must not mint another session'); },
    };
    ctx.provide('sessionController', controller);
    const store = createCompanionStore({ filePath: join(home, 'companion', 'state.json'), now });
    const markers = createRecallMarkers({ directory: join(home, 'companion', 'recall-sessions') });
    const ready = Promise.withResolvers();
    const promptContext = createCompanionPromptContext({ now,
      isCurrent: agent => ctx.agents.get(agent.id) === agent && ctx.agentPresets.presetForSession(agent.session) === FULL_PRESET,
      allowMemory: agent => coordinator?.allowsQueryContext(agent) === true,
    });
    ctx.provide('dshGoCompanionContext', promptContext);
    // Mirror production bridge hooks; events are dispatched by the actual
    // pinned Inbox and Session, not generated by a replacement algorithm.
    ctx.on('agent/inbox/claimed', ({ agent, message, turn }) => {
      if (ctx.agentPresets.presetForSession(agent.session) === FULL_PRESET) promptContext.claim(agent, message, turn);
    });
    ctx.on('agent/inbox/discarded', ({ agent, message }) => promptContext.discard(agent, message));
    ctx.on('session/event', (session, event) => {
      if (event.type === 'user/message') promptContext.commit(session, event.data, event.time);
      if (event.type === 'turn/end') promptContext.end(session);
    });
    ctx.on('agent/disposed', ({ agent }) => promptContext.retire(agent));
    ctx.effect(() => () => promptContext.clear(), 'c905-fixture.context');
    coordinator = createRecallCoordinator({ store, markers, adapter: ready.promise, promptContext });
    coordinator.registerContext = contexts.registerContext;
    ctx.provide('dshGoCompanionRecall', coordinator);
    ctx.effect(() => () => { coordinator.dispose(); contexts.dispose(); }, 'c902-fixture.recall');
    if (withRecall) {
      const module = await import('../../bridge/dsh-go-bridge/lib/companion/recall-engine.js');
      adapter = await module.createRecallEngineAdapter(ctx, { contexts });
      ctx.provide('dshGoCompanionRecallEngine', adapter);
    }
    ready.resolve(adapter);
    const contextUrl = new URL('../../bridge/dsh-go-bridge/lib/companion/full-context.js', import.meta.url).href;
    // C905's production preset replaces dsh-persona with this provider. Mount
    // that same provider once: it owns the prefix, fixed suffix and context.
    const fullPlugins = () => [{ id: 'companion-full-context', name: contextUrl }];
    const registerFull = () => ctx.agentPresets.register({ id: FULL_PRESET, plugins: fullPlugins() });
    let unregisterFull = await registerFull();
    await ctx.agentPresets.register({ id: 'ordinary', plugins: [] });
    ctx.systemPrompt.context({ name: 'fixture:real-runtime-context', order: 115, required: true,
      interpolate: false, text: 'SYNTHETIC_RUNTIME_CONTEXT' });

    const createAgent = (id, { preset = FULL_PRESET, seed, meta, inheritedEventCount, setup, options = route } = {}) =>
      ctx.agents.create({ sessionId: id, agentOptions: options,
        meta: { cwd: home, agentPreset: preset, ...meta },
        ...(seed === undefined ? {} : { seed }),
        ...(inheritedEventCount === undefined ? {} : { inheritedEventCount }),
        setup: async (agentCtx, agent) => {
          await ctx.agentPresets.mount(agentCtx, preset);
          return setup?.(agentCtx, agent);
        },
      });
    const bindInput = async (sessionId, overrides = {}) => {
      const snapshot = await store.getSnapshot();
      return { v: 1, operationId: randomUUID(), storeId: snapshot.storeId.toLowerCase(),
        expectedMemoryRevision: snapshot.memoryRevision, sessionId, consumerId: randomUUID(),
        consent: 'confirmed-recency-v1', ...overrides };
    };
    const input = (text) => engine.llm.createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text }] });
    return {
      home, endpoint, ctx, pctx, engine, store, markers, coordinator, adapter, contexts, provider, route, promptContext,
      requests, resolutions, controller, permissionState, providerOptions, personaText, personaRules, fullPlugins, input, createAgent,
      bindInput, bind: async (sessionId, overrides) => coordinator.bind(await bindInput(sessionId, overrides)),
      async saveMemory(text, overrides = {}) {
        const snapshot = await store.getSnapshot();
        return coordinator.mutateMemory('upsertMemory', { storeId: snapshot.storeId, expectedRevision: snapshot.revision,
          memory: { id: randomUUID(), kind: 'preference', text, keywords: [], pinned: false,
            source: { kind: 'manual' }, expiresAt: null, ...overrides } });
      },
      assemble: (agent) => ctx.systemPrompt.assemble(engine.agent.assembleContextFor(agent)),
      renderPrompt: engine.prompt.renderPrompt,
      async switchPreset(agent, preset) {
        await ctx.agentPresets.recompose(agent.ctx, preset);
        agent.session.append('agent-preset/selected', { agentPreset: preset });
      },
      async replaceFull(plugins = []) {
        await unregisterFull();
        unregisterFull = await ctx.agentPresets.register({ id: FULL_PRESET, plugins });
      },
      async send(agent, text) { agent.followup(input(text)); await agent.whenIdle(); },
      async dispose() {
        if (closed) return;
        closed = true;
        try { coordinator.dispose(); await ctx.fiber.dispose(); }
        finally { restore(); if (!keepHome) await rm(home, { recursive: true, force: true }); }
      },
    };
  } catch (error) {
    try { coordinator?.dispose(); await ctx?.fiber.dispose(); } finally {
      restore(); if (!keepHome) await rm(home, { recursive: true, force: true });
    }
    throw error;
  }
}

export function requestSystemText(request) {
  const system = request.body?.system ?? [];
  return typeof system === 'string' ? system : system.filter((block) => block.type === 'text').map((block) => block.text).join('\n\n');
}

export function assertNoRealNetwork(fixture) {
  assert(fixture.requests.every((request) => request.url.origin === fixture.endpoint.origin));
}
