// Real rc1 AgentLoop factory, SessionStore publication and JSONL live-feed durability.
// DSH_PREFIX=<patched isolated prefix> node --test runtime/tests/input-recovery-lifecycle.test.mjs
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
if (!process.env.DSH_PREFIX) throw Error('Set DSH_PREFIX to an isolated patched runtime');
const load = name => import(pathToFileURL(join(resolve(process.env.DSH_PREFIX), 'node_modules/@deepseek-ai', name, 'lib/index.js')));
const { Context } = await load('cordis');
const { Session, SessionStore } = await load('dsh-session');
const { SessionProjectionRegistry } = await load('dsh-session-projection');
const { AgentRegistry } = await load('dsh-agent');
const { AgentLoop } = await load('dsh-agent-loop');
const { apply: applyPersistence } = await load('dsh-session-persistence-jsonl');
const { createUserMessage } = await load('dsh-llm');
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-input-lifecycle-'));
  const ctx = new Context();
  const forks = [];
  t.after(async () => { for (const fork of forks.reverse()) await fork.dispose(); await ctx.fiber.dispose(); await rm(root, { recursive: true, force: true }); });
  for (const plugin of [SessionProjectionRegistry, SessionStore, AgentRegistry]) { const fork = ctx.plugin(plugin); forks.push(fork); await fork.await(); }
  await applyPersistence(ctx, { root, compression: 'none', listConcurrency: 1 });
  let modelCalls = 0;
  ctx.provide('llm', { prepareCall() { modelCalls++; throw Error('Unexpected model execution'); } });
  ctx.provide('tools', {});
  ctx.provide('systemPrompt', { variable() {} });
  const loop = ctx.plugin(AgentLoop, { agents: [], maxParallelToolCalls: 1 }); forks.push(loop); await loop.await();
  return { ctx, root, get modelCalls() { return modelCalls; } };
}
function seed(id = 'cold-input') {
  const session = Session.create(id);
  const message = createUserMessage({ content: [{ type: 'text', text: 'Held across cold restore' }], source: { kind: 'user', rpcId: 'held-request' } });
  session.append('agent/inbox/spliced', { target: 'next-turn', start: 0, inserted: [message] });
  session.append('turn/start', { turn: 1 });
  session.append('agent/inbox/spliced', { target: 'next-turn', start: 0, removedCount: 1, inserted: [] });
  session.append('turn/end', { turn: 1, reason: { kind: 'error', error: { code: 'UNKNOWN', message: 'Historical synthetic failure' } } });
  return { session, message };
}
async function storedEvents(ctx, id) {
  const reader = await ctx.sessionPersistence.open(id, 'read');
  try { return (await reader.read()).events; } finally { await reader.close(); }
}

for (const operation of ['create', 'resume']) test(`factory ${operation} recovery is flushed after Session publication and before Agent publication`, async t => {
  const f = await fixture(t);
  const { session, message } = seed();
  let observed = 0;
  f.ctx.on('agent/created', async ({ agent }) => {
    observed++;
    assert.deepEqual(agent.inbox.nextTurn, observed === 1 ? [message] : []);
    assert.deepEqual(await storedEvents(f.ctx, agent.id), agent.session.snapshotEvents(), 'no unflushed recovery splice reaches Agent publication');
  });
  if (operation === 'resume') {
    const writer = await f.ctx.sessionPersistence.create(session.header);
    await writer.append(session.snapshotEvents()); await writer.flush(); await writer.close();
  }
  const first = operation === 'resume'
    ? await f.ctx.agentLoop.resume(f.ctx, { resumeSessionId: session.id })
    : await f.ctx.agentLoop.createAgent(f.ctx, { sessionId: session.id, seed: session.snapshotEvents() });
  assert.deepEqual(first.agent.inbox.nextTurn, [message]);
  assert.equal(first.agent.status, 'idle');
  assert.equal(f.modelCalls, 0);
  const once = first.agent.session.snapshotEvents();
  assert.equal(once.filter(event => event.type === 'agent/inbox/spliced' && event.data.inserted.some(value => value.id === message.id)).length, 2, 'initial enqueue plus one recovery');
  await first.dispose();
  const resumed = await f.ctx.agentLoop.resume(f.ctx, { resumeSessionId: session.id });
  assert.deepEqual(resumed.agent.inbox.nextTurn, [], 'explicit ready-agent disposal cancels pending input');
  assert.equal(resumed.agent.session.snapshotEvents().filter(event => event.type === 'agent/inbox/spliced' && event.data.inserted.some(value => value.id === message.id)).length, 2, 'reattachment cannot append duplicate recovery');
  assert.equal(observed, 2);
  assert.equal(f.modelCalls, 0);
  await resumed.dispose();
});

test('recovery flush rejection prevents Agent publication, releases ownership and permits explicit resume', async t => {
  const f = await fixture(t);
  const { session, message } = seed('flush-failure');
  let observed = 0;
  f.ctx.on('agent/created', () => { observed++; });
  const releaseFailure = f.ctx.on('session/flush', () => { throw Error('Synthetic recovery flush failure'); });
  await assert.rejects(f.ctx.agentLoop.createAgent(f.ctx, { sessionId: session.id, seed: session.snapshotEvents() }), /Synthetic recovery flush failure/);
  assert.equal(observed, 0);
  assert.equal(f.ctx.agents.get(session.id), undefined);
  assert.equal(f.ctx.sessions.get(session.id), undefined);
  assert.equal(f.ctx.sessionPersistence.tracker.writers.has(session.id), false);
  releaseFailure();
  const resumed = await f.ctx.agentLoop.resume(f.ctx, { resumeSessionId: session.id });
  assert.deepEqual(resumed.agent.inbox.nextTurn, [message]);
  assert.equal(observed, 1);
  assert.equal(f.modelCalls, 0);
  await resumed.dispose();
});


test('caller cancellation during the recovery checkpoint prevents Agent publication without losing durable input', async t => {
  const f = await fixture(t);
  const { session, message } = seed('cancel-recovery');
  const entered = Promise.withResolvers(), release = Promise.withResolvers();
  const stopGate = f.ctx.on('session/flush', async () => { entered.resolve(); await release.promise; });
  let published = 0;
  f.ctx.on('agent/created', () => { published++; });
  const abort = new AbortController();
  const pending = f.ctx.agentLoop.createAgent(f.ctx, { sessionId: session.id, seed: session.snapshotEvents(), signal: abort.signal });
  const rejected = assert.rejects(pending, /Synthetic cancel during recovery/);
  await entered.promise;
  abort.abort(Error('Synthetic cancel during recovery'));
  release.resolve();
  await rejected;
  assert.equal(published, 0);
  assert.equal(f.ctx.agents.get(session.id), undefined);
  assert.equal(f.ctx.sessions.get(session.id), undefined);
  assert.equal(f.ctx.sessionPersistence.tracker.writers.has(session.id), false);
  stopGate();
  const resumed = await f.ctx.agentLoop.resume(f.ctx, { resumeSessionId: session.id });
  assert.deepEqual(resumed.agent.inbox.nextTurn, [message]);
  assert.equal(published, 1);
  assert.equal(f.modelCalls, 0);
  await resumed.dispose();
});
