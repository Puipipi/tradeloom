// Real pinned, patched engine; only the HTTP peer, file bytes/upload cache and
// explicitly identified Host fixture boundaries are synthetic. No model network.
import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { createFixture, loadEngine, textResponse, sseResponse, requestSystemText } from './fixtures/companion-recall-engine.mjs';

const enabled = Boolean(process.env.DSH_PREFIX);
const integration = (name, body) => test(name, { skip: !enabled, concurrency: false, timeout: 15000 }, body);
const deferred = () => Promise.withResolvers();
async function fixture(t, options) {
  const f = await createFixture(options);
  t.after(() => f.dispose());
  return f;
}
function observeAdmissions(f) {
  const preparations = [], admissions = [];
  const prepare = f.coordinator.prepare, admit = f.coordinator.admit;
  f.coordinator.prepare = async (input) => {
    const value = await prepare(input);
    preparations.push({ input, value });
    return value;
  };
  f.coordinator.admit = async (input) => {
    const permit = await admit(input);
    admissions.push({ input, permit });
    return permit;
  };
  return { preparations, admissions };
}
async function boundAgent(f, id = randomUUID()) {
  await f.saveMemory('Confirmed preference: {user.name} stays literal.');
  const handle = await f.createAgent(id);
  const binding = await f.bind(id);
  assert.equal(binding.status, 'ready');
  return { ...handle, binding };
}
function eventsOf(f, session) {
  // Test-only detached read. Production recall uses Session's maintained taint
  // and SessionProjectionRegistry, never new synchronous log snapshot reads.
  return session.snapshotEvents(f.engine.session.SessionLogOffset(0));
}
function toolReply(name = 'fixture_probe') {
  return sseResponse([
    { type: 'message_start', message: { id: 'tool-message', type: 'message', role: 'assistant',
      model: 'c750-fixture-model', content: [], stop_reason: null, usage: { input_tokens: 5, output_tokens: 0 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'fixture-call', name, input: {} } },
    { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{}' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 3 } },
    { type: 'message_stop' },
  ]);
}
function registerTool(f, run) {
  return f.ctx.tools.register({ name: 'fixture_probe', description: 'Synthetic local test tool',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    execute: async (...args) => { await run(...args); return 'Synthetic tool completed'; },
  });
}
const imageRef = Object.freeze({ attachmentId: `sha256:${'a'.repeat(64)}`, mediaType: 'image/png',
  bytes: 8, width: 1, height: 1, name: 'fixture.png' });
function imageMessage(f) {
  return f.engine.llm.createUserMessage({ source: { kind: 'user' }, content: [
    { type: 'text', text: 'Read the synthetic image.' }, { type: 'image', attachment: imageRef },
  ] });
}
function imageDependencies({ invalidated } = {}) {
  const uploads = [], invalidations = [];
  const files = {
    async ensureUploaded(version) {
      uploads.push(version.variantId);
      return { record: { fileId: `file-${uploads.length}` } };
    },
    async invalidate(values) { invalidations.push(values); await invalidated?.(); },
  };
  const attachments = { async readImageRequest(ref) {
    return { attachment: ref, variantId: 'synthetic-variant', bytes: 8, width: 1, height: 1,
      mediaType: 'image/png', hasAlpha: false, data: Buffer.from('fixture!') };
  } };
  return { uploads, invalidations, deepseekDependencies: { resolveFiles: () => files,
    resolveAttachments: () => attachments }, deepseekOptions: {
    models: [{ id: 'c750-fixture-model', inputModalities: ['text', 'image'], maxTokens: 128, contextWindow: 8192 }],
  } };
}

integration('actual full loop adds one literal section per user turn, fixed rules last and ordinary scope isolated', async (t) => {
  const f = await fixture(t);
  const observed = observeAdmissions(f);
  const { agent } = await boundAgent(f, 'bound-main');
  assert(!f.renderPrompt(await f.assemble(agent)).includes('Confirmed preference:'));
  await f.send(agent, 'First real user turn');
  await f.send(agent, 'Second real user turn');
  assert.equal(f.requests.length, 2);
  for (const request of f.requests) {
    const prompt = requestSystemText(request);
    assert.equal(prompt.split('Confirmed preference:').length - 1, 1);
    assert(prompt.includes('{user.name} stays literal.'));
    assert(prompt.endsWith(f.personaRules));
  }
  assert.equal(observed.preparations.length, 2);
  assert.notEqual(observed.preparations[0].input.turnId, observed.preparations[1].input.turnId);
  assert.equal(observed.admissions.length, 4); // logical + physical, for each turn
  assert.equal(new Set(observed.admissions.map(({ permit }) => permit.attemptId)).size, 4);
  assert(observed.admissions.every(({ input }) => input.agent === agent && input.scope === agent));
  const ordinary = await f.createAgent('ordinary-main', { preset: 'ordinary' });
  await f.send(ordinary.agent, 'Ordinary user turn');
  assert.equal(f.requests.length, 3);
  assert(!requestSystemText(f.requests[2]).includes('Confirmed preference:'));
});

integration('actual LlmRuntime image-to-text clone retains the main request origin', async (t) => {
  const f = await fixture(t);
  const { agent } = await boundAgent(f, 'projected-main');
  agent.followup(imageMessage(f));
  await agent.whenIdle();
  assert.equal(f.requests.length, 1);
  assert(JSON.stringify(f.requests[0].body.messages).includes('image omitted because this model accepts text only'));
  assert(requestSystemText(f.requests[0]).includes('Confirmed preference:'));
});

integration('actual ReactLoop retry and next tool step each obtain fresh admission', async (t) => {
  let bodies = 0;
  const f = await fixture(t, { transport: (_request, count) => count === 1
    ? new Response(JSON.stringify({ error: { type: 'rate_limit_error', message: 'Synthetic retry' } }), { status: 429 })
    : count === 2 ? toolReply() : textResponse() });
  registerTool(f, () => { bodies++; });
  let retryDecisions = 0;
  f.ctx.on('agent/request-error', (_event, next) => retryDecisions++ === 0 ? { kind: 'retry' } : next());
  const observed = observeAdmissions(f);
  const { agent } = await boundAgent(f, 'retry-step');
  await f.send(agent, 'Use the synthetic tool.');
  assert.equal(f.requests.length, 3);
  assert.equal(bodies, 1);
  assert.equal(retryDecisions, 1);
  assert.equal(observed.admissions.length, 6);
  assert.equal(observed.preparations.length, 2);
  const [first, retry, nextStep] = [0, 2, 4].map((i) => observed.admissions[i].input);
  assert.equal(first.stamp, retry.stamp);
  assert.notEqual(first.stamp, nextStep.stamp);
  assert.equal(first.turnId, nextStep.turnId);
  assert.notEqual(first.stepId, nextStep.stepId);
});

integration('actual direct DeepSeek stale-file retry crosses the physical gate twice', async (t) => {
  const images = imageDependencies();
  const f = await fixture(t, { ...images, transport: (_request, count) => count === 1
    ? new Response(JSON.stringify({ error: { type: 'invalid_request_error', message: 'file_id file-1 expired' } }), { status: 400 })
    : textResponse() });
  const observed = observeAdmissions(f);
  const { agent } = await boundAgent(f, 'file-retry');
  agent.followup(imageMessage(f));
  await agent.whenIdle();
  assert.equal(f.requests.length, 2);
  assert.equal(images.uploads.length, 2);
  assert.equal(images.invalidations.length, 1);
  assert.equal(observed.admissions.length, 3); // one logical, two actual POSTs
  assert.equal(observed.preparations.length, 1);
  assert.equal(new Set(observed.admissions.map(({ permit }) => permit.attemptId)).size, 3);
  assert(observed.admissions.every(({ input }) => input.stamp === observed.preparations[0].value.stamp));
});

integration('retirement during actual stale-file retry prevents another model POST', async (t) => {
  const reached = deferred(), release = deferred();
  const images = imageDependencies({ invalidated: async () => { reached.resolve(); await release.promise; } });
  const f = await fixture(t, { ...images, transport: () => new Response(JSON.stringify({
    error: { type: 'invalid_request_error', message: 'file_id file-1 expired' },
  }), { status: 400 }) });
  t.after(() => release.resolve());
  const { agent } = await boundAgent(f, 'retire-file-retry');
  agent.followup(imageMessage(f));
  await reached.promise;
  f.coordinator.retireAgent(agent, 'test-retirement');
  release.resolve();
  await agent.whenIdle();
  assert.equal(f.requests.length, 1);
  assert.throws(() => agent.wakeDriver(), /recall|continue/i);
});

integration('final tool-body guard rejects retired work after a waiting execute wrapper, without relying on cancellation', async (t) => {
  const f = await fixture(t);
  const { agent } = await boundAgent(f, 'late-tool');
  await f.send(agent, 'Establish an admitted physical permit.');
  let bodies = 0, policyCalls = 0;
  registerTool(f, () => { bodies++; });
  const reached = deferred(), release = deferred();
  t.after(() => release.resolve());
  f.ctx.on('tools/pre-execute', (_exec, next) => { policyCalls++; return next(); });
  f.ctx.on('tools/execute', async (exec, next) => {
    if (exec.agent === agent) { reached.resolve(); await release.promise; }
    return next();
  });
  const signal = new AbortController().signal;
  const pending = f.ctx.tools.execute({ agent, calls: [{ type: 'tool-call', id: 'late-call', name: 'fixture_probe', arguments: {} }], signal });
  await reached.promise;
  f.coordinator.retireAgent(agent, 'test-retirement');
  release.resolve();
  const result = await pending;
  assert.equal(signal.aborted, false);
  assert.equal(bodies, 0);
  assert.equal(policyCalls, 1);
  assert(JSON.stringify(result).match(/recall|continue|retired/i));
  const ordinary = await f.createAgent('ordinary-tool', { preset: 'ordinary' });
  await f.ctx.tools.execute({ agent: ordinary.agent, calls: [{ type: 'tool-call', id: 'ordinary-call', name: 'fixture_probe', arguments: {} }], signal });
  assert.equal(bodies, 1);
  assert.equal(policyCalls, 2);
});

integration('actual patched input recovery keeps an unadmitted claimed input and marker gates every wake', async (t) => {
  const f = await fixture(t);
  const { agent } = await boundAgent(f, 'recover-input');
  const reached = deferred(), release = deferred();
  t.after(() => release.resolve());
  f.ctx.on('agent/pre-step', async (event, next) => {
    if (event.agent === agent) { reached.resolve(); await release.promise; }
    return next();
  });
  const message = f.input('Preserve this unadmitted input.');
  agent.followup(message);
  await reached.promise;
  assert.equal(agent.inbox.claimed.length, 1);
  await f.saveMemory('A memory change retires the generation.');
  release.resolve();
  await agent.whenIdle();
  assert.equal(f.requests.length, 0);
  assert.equal(agent.inbox.claimed.length, 0);
  assert.equal(agent.inbox.nextTurn.length, 1);
  assert.equal(agent.inbox.nextTurn[0].id, message.id);
  assert(!eventsOf(f, agent.session).some((event) => event.type === 'user/message' && event.data.id === message.id));
  assert.throws(() => agent.wakeDriver(), /recall|continue/i);
  assert.throws(() => agent.followup(f.input('Do not add new work.')), /recall|continue/i);
  assert.equal(agent.inbox.nextTurn.length, 1);
});

integration('goal-sourced automatic followup is preserved and retires instead of masquerading as a user turn', async (t) => {
  const f = await fixture(t);
  const { agent } = await boundAgent(f, 'goal-input');
  const message = f.engine.llm.createUserMessage({ source: { kind: 'goal' }, content: [{ type: 'text', text: 'Synthetic automatic goal round' }] });
  agent.followup(message);
  await agent.whenIdle();
  assert.equal(f.requests.length, 0);
  assert.equal(agent.inbox.nextTurn[0]?.id, message.id);
  assert.throws(() => agent.wakeDriver(), /recall|continue/i);
});

integration('title helper denies marked source before preparation/logging; ordinary source still executes', async (t) => {
  const f = await fixture(t);
  const { agent } = await boundAgent(f, 'title-source');
  const { executeSessionTitleLlm } = await f.engine.load('dsh-session-title-llm');
  const config = { provider: f.route.provider, model: f.route.model, timeoutMs: 1000, maxInputBytes: 4096, maxOutputTokens: 128 };
  const prepared = { input: 'A synthetic title input', system: 'Write a title.', messageSeqs: [1], selectReasoningEffort: () => 'off' };
  const request = (session) => ({ session, route: f.route, signal: new AbortController().signal });
  await assert.rejects(executeSessionTitleLlm(f.ctx, config, request(agent.session), 'fixture', prepared), { code: 'COMPANION_RECALL_AUXILIARY_BLOCKED' });
  assert.equal(f.requests.length, 0);
  assert(!eventsOf(f, agent.session).some((event) => event.type === 'session/title-llm-request'));
  const ordinary = await f.createAgent('ordinary-title', { preset: 'ordinary' });
  await executeSessionTitleLlm(f.ctx, config, request(ordinary.agent.session), 'fixture', prepared);
  assert.equal(f.requests.length, 1);
  assert(eventsOf(f, ordinary.agent.session).some((event) => event.type === 'session/title-llm-request'));
});

integration('initializeAgent recall refusal closes an already acquired writer through its actual cleanup block', async () => {
  const engine = await loadEngine();
  let closeCalls = 0, untrackCalls = 0;
  const ctx = { get() {} };
  const loop = { runtime: { ctx }, ownership: { signal: new AbortController().signal,
    track: () => () => { untrackCalls++; }, isActive: () => true } };
  await assert.rejects(engine.loop.AgentLoop.prototype.initializeAgent.call(loop, ctx, {
    session: { id: 'writer-cleanup', dshGoRecallHistory: true }, agentOptions: {}, source: 'resume',
    stored: { handle: { async close() { closeCalls++; } } },
  }), { code: 'COMPANION_RECALL_RETIRED' });
  assert.equal(closeCalls, 1);
  assert.equal(untrackCalls, 1);
});

integration('actual manual and automatic compaction deny marked summaries while ordinary compaction still runs', async (t) => {
  const f = await fixture(t);
  const { agent } = await boundAgent(f, 'compaction-source');
  await f.send(agent, 'A completed conversation to compact.');
  // Only pricing is controlled. Session surfaces, range/pairing validation,
  // maintenance, transaction markers, summarizer and model transport are real.
  const meter = {
    measure(session) { const nodes = session.surface.nodes.map((seq) => ({ seq, tokens: 1024, heuristicTokens: 1024 }));
      return { nodes, totalTokens: nodes.length * 1024 }; },
    estimateMessage: () => 1,
  };
  f.ctx.provide('tokenMeter', meter);
  const { BasicCompactionEngine } = await f.engine.load('dsh-compaction-basic');
  const compaction = new BasicCompactionEngine(f.ctx, { auto: true, thresholdRatio: 0.1,
    headroomTokens: 1, retainTokens: 0, maxTokens: 128 });
  await assert.rejects(compaction.compactNow(agent, new AbortController().signal),
    (error) => error.code === 'summary' && error.cause?.code === 'COMPANION_RECALL_AUXILIARY_BLOCKED');
  assert.equal(f.requests.length, 1);
  assert(eventsOf(f, agent.session).some((event) => event.type === 'compaction/end'));
  await f.send(agent, 'The pressure hook may fail its summary and continue this user turn.');
  assert.equal(f.requests.length, 2);
  assert(eventsOf(f, agent.session).filter((event) => event.type === 'compaction/end').length >= 2);
  const ordinary = await f.createAgent('ordinary-compaction', { preset: 'ordinary' });
  await f.send(ordinary.agent, 'A normal conversation may still be summarized.');
  const before = f.requests.length;
  const result = await compaction.compactNow(ordinary.agent, new AbortController().signal);
  assert(result);
  assert.equal(f.requests.length, before + 1);
});

integration('actual fork provider and copied marker seeds are quarantined; plain spawn starts without recall', async (t) => {
  const f = await fixture(t);
  const { agent } = await boundAgent(f, 'fork-source');
  await f.send(agent, 'Remembered parent conversation.');
  let fork, spawn;
  const forkModule = await f.engine.load('dsh-subagent-fork-in-process');
  const spawnModule = await f.engine.load('dsh-subagent-spawn-in-process');
  forkModule.apply({ subagents: { registerProvider(value) { fork = value; } } }, { providerName: 'fork' });
  spawnModule.apply({ subagents: { registerProvider(value) { spawn = value; } } }, { providerName: 'spawn' });
  assert.equal(fork.inheritsParentContext, true);
  assert.throws(() => fork.prepareContinuable({ parent: agent }), /recall|continue/i);
  const seed = eventsOf(f, agent.session);
  assert(seed.some((event) => event.type === f.engine.llm.dshGoRecall.historyType && event.data.sessionId === agent.id));
  await assert.rejects(f.createAgent('copied-new-identity', { seed }), /recall|continue/i);
  assert.equal(f.ctx.agents.get('copied-new-identity'), undefined);
  const detached = f.engine.session.Session.create('passive-copy', seed);
  assert.equal(detached.dshGoRecallHistory, true);
  assert(detached.deriveMessages().length > 0); // passive history remains viewable
  assert.equal(spawn.inheritsParentContext, false);
  const spawnOptions = await spawn.prepareContinuable({ parent: agent });
  assert.deepEqual(spawnOptions, {});
  const child = await f.createAgent('plain-spawn-child', spawnOptions);
  await f.send(child.agent, 'Only the explicit child input.');
  assert(!requestSystemText(f.requests.at(-1)).includes('Confirmed preference:'));
  assert.equal(child.agent.session.dshGoRecallHistory, false);
});

integration('generic LlmRuntime auxiliary calls keep canonical-history provenance without an initiator', async (t) => {
  const f = await fixture(t);
  const { agent } = await boundAgent(f, 'auxiliary-origin');
  await f.send(agent, 'A completed source conversation.');
  const messages = agent.session.deriveMessages();
  assert.throws(() => f.ctx.llm.stream({ ...f.route, messages,
    signal: new AbortController().signal }), { code: 'COMPANION_RECALL_AUXILIARY_BLOCKED' });
  await assert.rejects(f.ctx.agents.withInitiator(agent, () => f.ctx.llm.prepareCall(f.route,
    new AbortController().signal)), { code: 'COMPANION_RECALL_AUXILIARY_BLOCKED' });
  assert.equal(f.requests.length, 1);
});

integration('absent coordinator fallback blocks sidecar before open and history-only cold resume closes its writer', async (t) => {
  const f = await fixture(t);
  const { agent } = await boundAgent(f, 'cold-fallback');
  const ctx = { get() {} }, ownerCtx = { effect: () => async () => {}, fiber: { assertActive() {} } };
  let opens = 0, closes = 0, appends = 0;
  const loop = { runtime: { ctx }, ownership: { signal: new AbortController().signal,
    trackWrapper() {}, isActive: () => true } };
  const persistence = { async open() { opens++; return { async read() { return { events: eventsOf(f, agent.session) }; },
    async append() { appends++; }, async close() { closes++; } }; } };
  assert.throws(() => f.engine.loop.AgentLoop.prototype.resumeWith.call(loop, ownerCtx, persistence,
    { resumeSessionId: agent.id }), { code: 'COMPANION_RECALL_RETIRED' });
  assert.equal(opens, 0);
  // Different copied ID has no sidecar. The actual read discovers the log marker
  // before interrupted-turn closers or Session publication and still closes.
  await assert.rejects(f.engine.loop.AgentLoop.prototype.resumeWith.call(loop, ownerCtx, persistence,
    { resumeSessionId: 'different-copied-cold-id' }), { code: 'COMPANION_RECALL_RETIRED' });
  assert.equal(opens, 1);
  assert.equal(closes, 1);
  assert.equal(appends, 0);
});

integration('real JSONL cold resume refuses recalled history, releases its writer and still resumes an ordinary session', async (t) => {
  const f = await fixture(t);
  const { apply } = await f.engine.load('dsh-session-persistence-jsonl');
  await apply(f.ctx, { root: join(f.home, 'jsonl'), compression: 'none', listConcurrency: 1 });
  const recalled = f.engine.session.Session.create('jsonl-recalled-cold');
  f.engine.session.appendPluginRecord(recalled, f.engine.llm.dshGoRecall.historyType,
    { v: 1, sessionId: 'older-origin-id', storeId: randomUUID() });
  const ordinary = f.engine.session.Session.create('jsonl-ordinary-cold');
  for (const session of [recalled, ordinary]) {
    const writer = await f.ctx.sessionPersistence.create(session.header);
    try { await writer.append(eventsOf(f, session)); await writer.flush(); }
    finally { await writer.close(); }
  }
  const resume = (id) => f.ctx.agents.resume({ resumeSessionId: id, agentOptions: f.route,
    setup: async (agentCtx) => { await f.ctx.agentPresets.mount(agentCtx, 'ordinary'); } });
  await assert.rejects(resume(recalled.id), /recall|continue/i);
  assert.equal(f.ctx.agents.get(recalled.id), undefined);
  assert.equal(f.ctx.sessions.get(recalled.id), undefined);
  const reader = await f.ctx.sessionPersistence.open(recalled.id, 'read');
  let restored;
  try { restored = await reader.read(); }
  finally { await reader.close(); }
  assert.equal(restored.events.filter((event) => event.type === f.engine.llm.dshGoRecall.historyType).length, 1);
  // This is a real POSIX writer lock, not the controlled close counter case.
  const writerAgain = await f.ctx.sessionPersistence.open(recalled.id, 'write');
  await writerAgain.close();
  assert.equal(f.requests.length, 0);
  const handle = await resume(ordinary.id);
  await f.send(handle.agent, 'An ordinary restored session may continue.');
  assert.equal(f.requests.length, 1);
  assert(!requestSystemText(f.requests[0]).includes('Confirmed preference:'));
});
