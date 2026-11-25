// Actual services, Commands, AgentLoop factory and JSONL close/resume; no model calls.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
if (!process.env.DSH_PREFIX) throw Error('Set DSH_PREFIX to an isolated runtime prefix');
const load = name => import(pathToFileURL(join(resolve(process.env.DSH_PREFIX), 'node_modules/@deepseek-ai', name, 'lib/index.js')));
const { Context } = await load('cordis');
const { apply: persistence } = await load('dsh-session-persistence-jsonl');
let serial = 0;
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-plan-restore-'));
  const live = new Set();
  t.after(async () => {
    for (const close of live) await close();
    await rm(root, { recursive: true, force: true });
  });
  const id = `plan-restore-${++serial}`;
  async function open(resume = false) {
    const ctx = new Context();
    const forks = [];
    let owner;
    async function close() {
      if (!live.delete(close)) return;
      try { if (owner) await owner.dispose(); }
      finally {
        for (const fork of forks.reverse()) await fork.dispose();
        await ctx.fiber.dispose();
      }
    }
    live.add(close);
    for (const name of ['dsh-session-projection', 'dsh-session', 'dsh-agent', 'dsh-llm', 'dsh-tools', 'dsh-system-prompt', 'dsh-commands']) {
      const fork = ctx.plugin((await load(name)).default);
      forks.push(fork); await fork.await();
    }
    await persistence(ctx, { root, compression: 'none', listConcurrency: 1 });
    const loop = ctx.plugin((await load('dsh-agent-loop')).AgentLoop, { agents: [] });
    forks.push(loop); await loop.await();
    const plan = ctx.plugin((await load('dsh-plan-mode')).PlanModeController, { section: 'Plan fixture guidance.' });
    forks.push(plan); await plan.await();
    owner = resume ? await ctx.agentLoop.resume(ctx, { resumeSessionId: id }) : await ctx.agents.create({ sessionId: id });
    const agent = owner.agent;
    return { ctx, agent, close,
      command: line => ctx.commands.execute(agent, line, [], new AbortController().signal),
      flush: () => ctx.sessions.flush(agent.session),
    };
  }
  return { open };
}
// Seed only the public lifecycle events; never start the model driver. This gives
// the real turn-boundary projection an open turn while actual Commands run.
function begin(f, active) {
  f.agent.session.append('plan/mode', { active });
  f.agent.session.append('turn/start', { turn: 1 });
}
function end(f) { f.agent.session.append('turn/end', { turn: 1, reason: { kind: 'aborted' } }); }
const modes = f => f.agent.session.snapshotEvents().filter(e => e.type === 'plan/mode');
async function boundary(f, { aborted = false, rejected = false } = {}) {
  const abort = new AbortController();
  if (aborted) abort.abort();
  return f.ctx.waterfall('agent/pre-step', { agent: f.agent, signal: abort.signal, messages: [] },
    async () => rejected ? { kind: 'reject' } : { kind: 'enter', messages: [] });
}

for (const active of [false, true]) test(`successful queued ${!active} restores through JSONL and applies once`, async t => {
  const f = await fixture(t);
  const first = await f.open(); begin(first, active);
  const command = await first.command(active ? '/plan off' : '/plan');
  assert.equal(command.result.kind, 'success');
  assert.deepEqual(first.ctx.planMode.get(first.agent), { active, pending: !active });
  end(first); await first.flush(); await first.close();
  const second = await f.open(true);
  assert.deepEqual(second.ctx.planMode.get(second.agent), { active, pending: !active });
  assert.equal(second.ctx.planMode.selectedActive(second.agent.session), !active);
  const count = modes(second).length;
  await boundary(second, { aborted: true });
  await boundary(second, { rejected: true });
  assert.equal(modes(second).length, count);
  await boundary(second);
  assert.deepEqual(second.ctx.planMode.get(second.agent), { active: !active });
  assert.equal(modes(second).length, count + 1);
  await boundary(second);
  assert.equal(modes(second).length, count + 1);
  await second.flush(); await second.close();
  const third = await f.open(true);
  assert.deepEqual(third.ctx.planMode.get(third.agent), { active: !active });
});

for (const kind of ['running', 'error']) test(`${kind} command is not a successful selection on resume`, async t => {
  const f = await fixture(t); const first = await f.open(); begin(first, false);
  first.agent.session.append('command/run', { commandId: 'historical-plan', name: 'plan', args: '', source: { kind: 'user' } });
  if (kind === 'error') first.agent.session.append('command/done', { commandId: 'historical-plan', kind: 'error', text: 'Command did not succeed.' });
  end(first); await first.flush(); await first.close();
  const second = await f.open(true);
  assert.deepEqual(second.ctx.planMode.get(second.agent), { active: false });
  assert.equal(second.ctx.planMode.selectedActive(second.agent.session), false);
  const count = modes(second).length;
  await boundary(second);
  assert.equal(modes(second).length, count);
});

test('idle opposite selection clears the persisted wanted before another reopen', async t => {
  const f = await fixture(t); const first = await f.open(); begin(first, false);
  await first.command('/plan'); end(first); await first.flush(); await first.close();
  const second = await f.open(true);
  assert.equal(second.ctx.planMode.set(second.agent, false), 'cancelled');
  assert.deepEqual(second.ctx.planMode.get(second.agent), { active: false });
  await second.flush(); await second.close();
  const third = await f.open(true);
  assert.deepEqual(third.ctx.planMode.get(third.agent), { active: false });
});

test('new in-memory selection wins and clears older durable wanted at the boundary', async t => {
  const f = await fixture(t); const first = await f.open(); begin(first, false);
  await first.command('/plan'); end(first); await first.flush(); await first.close();
  const second = await f.open(true);
  second.agent.session.append('turn/start', { turn: 2 });
  assert.equal(second.ctx.planMode.set(second.agent, false), 'cancelled');
  assert.deepEqual(second.ctx.planMode.get(second.agent), { active: false, pending: false });
  assert.equal(second.ctx.planMode.selectedActive(second.agent.session), false);
  await boundary(second);
  assert.deepEqual(second.ctx.planMode.get(second.agent), { active: false });
  second.agent.session.append('turn/end', { turn: 2, reason: { kind: 'aborted' } });
  await second.flush(); await second.close();
  const third = await f.open(true);
  assert.deepEqual(third.ctx.planMode.get(third.agent), { active: false });
});

test('sequential on/off choices and no pending keep the same-instance boundary behavior', async t => {
  const f = await fixture(t); const first = await f.open(); begin(first, false);
  assert.deepEqual(first.ctx.planMode.get(first.agent), { active: false });
  await first.command('/plan'); await first.command('/plan off');
  assert.equal(first.ctx.planMode.selectedActive(first.agent.session), false);
  await boundary(first);
  assert.deepEqual(first.ctx.planMode.get(first.agent), { active: false });
  await first.command('/plan'); await boundary(first);
  assert.deepEqual(first.ctx.planMode.get(first.agent), { active: true });
  end(first);
});
