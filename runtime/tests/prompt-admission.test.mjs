// Real pinned controller/attachment/inbox/loop methods, controlled storage and model boundaries.
// DSH_PREFIX=/private/patched/prefix node --test runtime/tests/prompt-admission.test.mjs
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createDeletionSeam } from '../session-deletion/core.mjs';
if (!process.env.DSH_PREFIX) throw Error('Set DSH_PREFIX to a private patched candidate');
const prefix = resolve(process.env.DSH_PREFIX);
const base = join(prefix, 'node_modules/@deepseek-ai');
const temporary = mkdtempSync(join(tmpdir(), 'dsh-prompt-admission-'));
after(() => rmSync(temporary, { recursive: true, force: true }));
symlinkSync(join(prefix, 'node_modules'), join(temporary, 'node_modules'), 'dir');
const load = name => import(pathToFileURL(join(base, name, 'lib/index.js')));
async function expose(name, exports) {
  const file = join(temporary, `${name}.mjs`);
  // Append private exports to the entire actual module; do not copy its algorithm.
  writeFileSync(file, readFileSync(join(base, name, 'lib/index.js'), 'utf8') + `\nexport { ${exports} };\n`);
  return import(pathToFileURL(file));
}
const { Context } = await load('cordis');
const { Session } = await load('dsh-session');
const { AttachmentStore } = await load('dsh-attachment');
const { createUserMessage } = await load('dsh-llm');
const { SessionProjectionRegistry } = await load('dsh-session-projection');
const { AgentLoop, ReactLoopInbox, ReactLoopAgent, inboxProjectionDefinition, RuntimeContextProjection, SystemPromptProjection } = await expose('dsh-agent-loop', 'ReactLoopInbox, ReactLoopAgent, inboxProjectionDefinition, RuntimeContextProjection, SystemPromptProjection');
const { SessionCommandController, ApiSessionAgentController } = await expose('dsh-api-session-controller', 'SessionCommandController, ApiSessionAgentController');
symlinkSync(join(base, 'dsh-session-persistence-jsonl/lib/dsh-go-deletion.mjs'), join(temporary, 'dsh-go-deletion.mjs'));
const { SessionWriteLease } = await expose('dsh-session-persistence-jsonl', 'SessionWriteLease');
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4//8/AAX+Av6nNYGEAAAAAElFTkSuQmCC';
function deferred() {
  let resolve;
  const promise = new Promise(yes => { resolve = yes; });
  return { promise, resolve };
}
async function fixture(t, { failFirst = false } = {}) {
  const ctx = new Context();
  t.after(() => ctx.fiber.dispose());
  const projections = new SessionProjectionRegistry(ctx);
  const projection = await projections.register(inboxProjectionDefinition);
  const session = Session.create('concurrent-prompt');
  const dispatch = { emit() {}, waterfall: async (_type, _args, fallback) => fallback() };
  const inbox = new ReactLoopInbox(projection.readerFor(session), session, dispatch);
  // Use actual send/followup/steer/step methods; scheduler waking and model I/O are controlled.
  const agent = Object.assign(Object.create(ReactLoopAgent.prototype), {
    id: session.id, session, inbox, dispatch,
    phase: { kind: 'maintenance', abort: new AbortController() },
    options: {},
    model: { current: () => ({ provider: 'fixture', model: 'image' }) },
    wakeDriver() {},
    loopCtx: {
      get() {}, systemPrompt: { refreshContext: assembly => assembly },
      llm: { async prepareCall(config) { return { config }; } },
    },
    runtimeContext: new RuntimeContextProjection(ctx, session),
    systemPrompt: new SystemPromptProjection(session),
    buildRequest() { throw Error('controlled stop before model stream'); },
  });
  const started = deferred(), gate = deferred();
  const counts = { admissions: 0, bindings: 0 };
  class Store extends AttachmentStore {
    async saveImages(inputs) {
      counts.admissions++;
      assert.equal(inputs[0].mediaType, 'image/png');
      assert.equal(Buffer.from(inputs[0].data).subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
      if (counts.admissions === 1) {
        started.resolve();
        await gate.promise;
        if (failFirst) throw Error('controlled image storage failure');
      }
      return inputs.map(input => ({ attachmentId: 'fixture-png', mediaType: 'image/png', bytes: input.data.length, width: 1, height: 1 }));
    }
  }
  const host = {
    typert: { lookups: { configure() {} }, contexts: { configureHost() {} } },
    agents: { get: id => id === agent.id ? agent : undefined },
    attachments: new Store(ctx),
    llm: { async resolveModelInfo() { return { inputModalities: ['text', 'image'] }; } },
    fileUploads: {
      resolve() { throw Error('unexpected receipt'); },
      bindPrompt() { counts.bindings++; return { commit() {}, [Symbol.dispose]() {} }; },
    },
  };
  const agents = new ApiSessionAgentController(host);
  const controller = new SessionCommandController(host, agents, '/fixture');
  const submit = (requestId, mode = 'followup') => controller.prompt({
    sessionId: session.id, requestId, mode,
    content: [{ type: 'image', mediaType: 'image/png', data: png }],
  }, { kind: 'user', rpcId: requestId });
  async function overlap(secondId = 'same-id', mode = 'followup') {
    const first = submit('same-id', mode);
    // Attach immediately, including when a storage failure is expected.
    const firstResult = first.then(value => ({ value }), error => ({ error }));
    await started.promise;
    const firstTail = agents.imageAdmissionChains.get(agent);
    const second = submit(secondId, mode);
    for (let i = 0; i < 12; i++) await Promise.resolve();
    assert.notEqual(agents.imageAdmissionChains.get(agent), firstTail, 'second request actually joined the real image queue');
    assert.equal(counts.admissions, 1);
    assert.equal(inbox.nextTurn.length + inbox.nextStep.length, 0);
    gate.resolve();
    return { first: await firstResult, second: await second };
  }
  async function commitPending() {
    let turn = 0;
    while (inbox.hasPending) {
      agent.phase = { kind: 'running', turn: ++turn, step: 0, abort: new AbortController() };
      const messages = inbox.claim('next-turn', turn);
      await assert.rejects(agent.step({ messages, selection: { provider: 'fixture', model: 'image' }, assembly: { sections: [], contexts: [], variables: {}, tools: [] } }), /controlled stop before model stream/);
    }
    return session.snapshotEvents().filter(event => event.type === 'user/message' && event.data.source.kind === 'user');
  }
  return { overlap, submit, inbox, session, counts, commitPending, agent, host, controller };
}
for (const mode of ['followup', 'steer']) test(`overlapping ${mode} image retries commit one business input`, async t => {
  const f = await fixture(t);
  const results = await f.overlap('same-id', mode);
  assert.deepEqual(results, { first: { value: { accepted: true } }, second: { accepted: true } });
  assert.equal(f.inbox.nextTurn.length + f.inbox.nextStep.length, 1);
  assert.equal(f.counts.bindings, 1);
  assert.equal(f.counts.admissions, 2, 'late commit check does not promise storage deduplication');
  const inserted = f.session.snapshotEvents().filter(event => event.type === 'agent/inbox/spliced').flatMap(event => event.data.inserted);
  assert.equal(inserted.length, 1);
  const messages = await f.commitPending();
  assert.equal(messages.length, 1);
  assert.equal(messages[0].data.source.rpcId, 'same-id');
  assert.deepEqual(await f.submit('same-id', mode), { accepted: true });
  assert.equal(f.counts.admissions, 2, 'durable message still satisfies the existing early dedup check');
});
test('different request IDs remain distinct after overlapping admission', async t => {
  const f = await fixture(t);
  assert.deepEqual(await f.overlap('different-id'), { first: { value: { accepted: true } }, second: { accepted: true } });
  assert.equal(f.counts.bindings, 2);
  assert.equal(f.inbox.nextTurn.length, 2);
  assert.deepEqual((await f.commitPending()).map(event => event.data.source.rpcId), ['same-id', 'different-id']);
});
test('failed first storage admission does not suppress a queued same-ID retry', async t => {
  const f = await fixture(t, { failFirst: true });
  const result = await f.overlap();
  assert(result.first.error);
  assert.deepEqual(result.second, { accepted: true });
  assert.equal(f.counts.bindings, 1);
  assert.equal(f.inbox.nextTurn.length, 1);
  assert.equal((await f.commitPending()).length, 1);
});

test('a refused deletion cannot drop a queued prompt moved to steering', async t => {
  const f = await fixture(t);
  const root = mkdtempSync(join(temporary, 'queue-deletion-'));
  const entered = deferred(), release = deferred();
  const acquired = [];
  const storage = {
    root, tracker: { writers: new Map() },
    ctx: { get: name => name === 'sessions' ? { list: () => [f.session] } : undefined },
    async list() { entered.resolve(); await release.promise; return [{ header: f.session.header }]; },
  };
  const seam = createDeletionSeam(storage, {
    acquire: async (dir, id) => {
      const lease = await SessionWriteLease.acquire(dir, id);
      acquired.push({ dir, id });
      return lease;
    },
    parseGeneration: () => undefined,
    notFound: id => Object.assign(new Error(`fenced ${id}`), { code: 'not-found' }),
  });
  storage.dshGoDeletion = seam;
  f.host.get = f.agent.loopCtx.get = name => name === 'sessionPersistence' ? storage : undefined;
  f.agent.phase = { kind: 'running', abort: new AbortController() };
  const message = createUserMessage({ content: [{ type: 'text', text: 'synthetic queued input' }], source: { kind: 'user' } });
  f.inbox.append('next-turn', message);
  const before = f.session.snapshotEvents();
  const deleting = seam.delete(f.agent.id, {
    dispose: (id, options) => AgentLoop.prototype.dshGoDisposeForDeletion.call({ runtime: { ctx: f.host } }, id, options),
  });
  const refused = assert.rejects(deleting, { code: 'session-active' });
  await entered.promise;
  const move = () => f.controller.updateQueue({ sessionId: f.agent.id, itemId: message.id, action: { kind: 'steer' } });
  try {
    assert.equal(acquired.length, 1, 'deletion owns its operation lease before listing');
    await assert.rejects(move(), { code: 'not-found' });
    assert.deepEqual(f.inbox.nextTurn.map(item => item.id), [message.id]);
    assert.deepEqual(f.inbox.nextStep, []);
    assert.deepEqual(f.session.snapshotEvents(), before, 'refused move must not append a cancellation');
  } finally {
    release.resolve();
    await refused;
  }
  assert.equal(seam.pending.size, 0);
  assert.equal(seam.deleted(f.agent.id), false);
  const released = await SessionWriteLease.acquire(acquired[0].dir, acquired[0].id);
  await released.release();
  assert.deepEqual(await move(), { accepted: true });
  assert.deepEqual(f.inbox.nextTurn, []);
  assert.deepEqual(f.inbox.nextStep.map(item => item.id), [message.id]);
});
