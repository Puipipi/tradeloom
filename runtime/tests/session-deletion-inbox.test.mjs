// Refs #687: real AgentLoop teardown, approval notification and JSONL deletion fence.
// DSH_PREFIX=<patched isolated prefix> node --test runtime/tests/session-deletion-inbox.test.mjs
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
const { ApprovalService } = await load('dsh-user-approval');
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-deletion-inbox-'));
  const ctx = new Context();
  const forks = [];
  t.after(async () => { for (const fork of forks.reverse()) await fork.dispose(); await ctx.fiber.dispose(); await rm(root, { recursive: true, force: true }); });
  for (const plugin of [SessionProjectionRegistry, SessionStore, AgentRegistry]) { const fork = ctx.plugin(plugin); forks.push(fork); await fork.await(); }
  await applyPersistence(ctx, { root, compression: 'none', listConcurrency: 1 });
  let modelCalls = 0;
  ctx.provide('llm', { prepareCall() { modelCalls++; throw Error('Unexpected model execution'); } });
  ctx.provide('tools', {});
  ctx.provide('systemPrompt', { variable() {}, context() {}, getContextOrder() { return 0; } });
  const loop = ctx.plugin(AgentLoop, { agents: [], maxParallelToolCalls: 1 }); forks.push(loop); await loop.await();
  const approval = ctx.plugin(ApprovalService, { policy: 'never' }); forks.push(approval); await approval.await();
  return { ctx, root, get modelCalls() { return modelCalls; } };
}

const message = () => createUserMessage({ content: [{ type: 'text', text: 'synthetic queued input' }], source: { kind: 'user' } });
async function create(f, id) { return (await f.ctx.agentLoop.createAgent(f.ctx, { sessionId: id })).agent; }
function remove(f, id, beforeDispose = async () => {}) {
  return f.ctx.sessionPersistence.dshGoDeletion.delete(id, {
    validate: async (sessionId) => {
      const activity = await f.ctx.waterfall('workspace/session-activity', { sessionId }, () => Promise.resolve([]));
      assert.deepEqual(activity, []);
      await beforeDispose();
    },
    dispose: (_id, opts) => f.ctx.agentLoop.dshGoDisposeForDeletion(_id, opts),
    inspectTasks: async () => false,
    cleanup: async () => {},
  });
}

test('idle policy notification is discarded by real teardown and permanent deletion completes', async t => {
  const f = await fixture(t), id = 'idle-policy';
  const agent = await create(f, id);
  f.ctx.approval.setPolicy(agent, 'ask');
  assert.equal(agent.phase.kind, 'idle');
  assert.equal(agent.inbox.hasPending, true);
  assert.equal(agent.inbox.nextStep[0].source.kind, 'user-approval');
  await remove(f, id);
  assert.equal(agent.inbox.hasPending, false);
  assert.equal(f.ctx.sessionPersistence.dshGoDeletion.deleted(id), true);
  assert.equal(f.ctx.agents.get(id), undefined);
  assert.equal(f.ctx.sessions.get(id), undefined);
  assert.equal(f.ctx.sessionPersistence.tracker.writers.has(id), false);
  assert.equal(f.modelCalls, 0);
});

test('permanent deletion cascades to the chat subagent sessions', async t => {
  const f = await fixture(t), parent = 'cascade-parent', child = 'cascade-child';
  await create(f, parent);
  const { agent: childAgent } = await f.ctx.agentLoop.createAgent(f.ctx, {
    sessionId: child,
    meta: { origin: 'subagent', parentSession: parent, delegationDepth: 1 },
  });
  assert.equal(childAgent.session.header.origin, 'subagent');
  // A freshly created session materialises on its first append or flush; deletion only
  // finds physical artifacts, so make the whole tree durable before deleting the chat.
  await f.ctx.sessionPersistence.flush();
  await remove(f, parent);
  assert.equal(f.ctx.sessionPersistence.dshGoDeletion.deleted(parent), true);
  assert.equal(f.ctx.sessionPersistence.dshGoDeletion.deleted(child), true);
  for (const id of [parent, child]) {
    assert.equal(f.ctx.agents.get(id), undefined);
    assert.equal(f.ctx.sessions.get(id), undefined);
    assert.equal(f.ctx.sessionPersistence.tracker.writers.has(id), false);
  }
});

test('an active subagent refuses the whole tree before the chat is disposed', async t => {
  const f = await fixture(t), parent = 'cascade-blocked-parent', child = 'cascade-blocked-child';
  await create(f, parent);
  const { agent: childAgent } = await f.ctx.agentLoop.createAgent(f.ctx, {
    sessionId: child,
    meta: { origin: 'subagent', parentSession: parent, delegationDepth: 1 },
  });
  await f.ctx.sessionPersistence.flush();
  const release = Promise.withResolvers();
  const work = childAgent.runMaintenance(() => release.promise);
  try {
    await assert.rejects(remove(f, parent), { code: 'session-active' });
    for (const id of [parent, child]) {
      assert.equal(f.ctx.sessionPersistence.dshGoDeletion.deleted(id), false);
      assert.notEqual(f.ctx.agents.get(id), undefined, 'no agent in the tree is torn down by a refused cascade');
    }
  } finally { release.resolve(); await work; }
  // The whole tree stayed usable: an idle retry cascades as usual.
  await remove(f, parent);
  for (const id of [parent, child]) assert.equal(f.ctx.sessionPersistence.dshGoDeletion.deleted(id), true);
});

test('pending fence rejects input before disposal and late microtasks cannot restart retired driver', async t => {
  const f = await fixture(t), id = 'retirement-race';
  const agent = await create(f, id);
  agent.inject(message());
  const entered = Promise.withResolvers(), release = Promise.withResolvers();
  t.after(() => release.resolve());
  agent.ctx.effect(() => async () => { entered.resolve(); await release.promise; }, 'deletion inbox test gate');
  const deletion = remove(f, id, async () => {
    assert.equal(agent.dshGoDeleting, undefined);
    assert.throws(() => agent.inject(message()), { name: 'SessionPersistenceNotFoundError' });
    assert.throws(() => agent.wakeDriver(), { name: 'SessionPersistenceNotFoundError' });
  });
  // Own a rejection immediately even when baseline rejects before reaching the gate.
  const settled = deletion.then(() => 'deleted', error => { throw error; });
  await Promise.race([entered.promise, settled]);
  try {
    assert.equal(agent.dshGoDeleting, true);
    assert.equal(agent.inbox.hasPending, false);
    await Promise.resolve();
    for (const action of [() => agent.followup(message()), () => agent.steer(message()),
      () => agent.inject(message()), () => agent.wakeDriver(), () => agent.runMaintenance(async () => {})]) {
      assert.throws(action, /session is being deleted/);
    }
    assert.equal(agent.phase.kind, 'idle');
    assert.equal(f.modelCalls, 0);
  } finally { release.resolve(); }
  await settled;
  assert.equal(f.ctx.sessionPersistence.dshGoDeletion.deleted(id), true);
});

test('maintenance remains undeletable even though public status is idle and inbox is pending', async t => {
  const f = await fixture(t), id = 'maintenance-active';
  const agent = await create(f, id);
  agent.inject(message());
  const release = Promise.withResolvers();
  const work = agent.runMaintenance(() => release.promise);
  try {
    assert.equal(agent.status, 'idle');
    assert.equal(agent.phase.kind, 'maintenance');
    await assert.rejects(remove(f, id), { code: 'session-active' });
    assert.equal(agent.dshGoDeleting, undefined);
    assert.equal(agent.inbox.hasPending, true);
    assert.equal(f.ctx.sessionPersistence.dshGoDeletion.deleted(id), false);
  } finally { release.resolve(); await work; }
  await remove(f, id);
  assert.equal(f.modelCalls, 0);
});
