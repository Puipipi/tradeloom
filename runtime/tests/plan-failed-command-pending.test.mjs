// Actual services, Commands, AgentLoop factory and JSONL close/resume; no model calls.
import test from 'node:test';
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
if (!process.env.DSH_PREFIX) throw Error('Set DSH_PREFIX to an isolated runtime prefix');
const load = name => import(pathToFileURL(join(resolve(process.env.DSH_PREFIX), 'node_modules/@deepseek-ai', name, 'lib/index.js')));
const { Context } = await load('cordis');
const sharp = createRequire(join(resolve(process.env.DSH_PREFIX), 'package.json'))('sharp');
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
    const attachments = ctx.plugin((await load('dsh-attachment-local')).LocalAttachmentStore, { dshHome: root });
    forks.push(attachments); await attachments.await();
    const loop = ctx.plugin((await load('dsh-agent-loop')).AgentLoop, { agents: [] });
    forks.push(loop); await loop.await();
    const plan = ctx.plugin((await load('dsh-plan-mode')).PlanModeController, { section: 'Plan fixture guidance.' });
    forks.push(plan); await plan.await();
    owner = resume ? await ctx.agentLoop.resume(ctx, { resumeSessionId: id }) : await ctx.agents.create({ sessionId: id });
    const agent = owner.agent;
    return { ctx, agent, close,
      command: (line, files = []) => ctx.commands.execute(agent, line, files, new AbortController().signal),
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

async function rejectedOffWithImage(t, f) {
  const png = await sharp({ create: { width: 2, height: 2, channels: 3, background: { r: 100, g: 120, b: 140 } } }).png().toBuffer();
  const saved = [];
  const original = f.ctx.attachments.saveImages.bind(f.ctx.attachments);
  // Observe actual successful storage; never replace admission or file I/O.
  const spy = t.mock.method(f.ctx.attachments, 'saveImages', async inputs => {
    const refs = await original(inputs); saved.push(...refs); return refs;
  });
  let result;
  try {
    result = await f.command('/plan off', [{ type: 'image', mediaType: 'image/png', data: png.toString('base64'), name: 'synthetic.png' }]);
  } finally { spy.mock.restore(); }
  assert.equal(result.result.kind, 'error');
  assert.equal(result.result.text, 'Attachments cannot accompany /plan off.');
  assert.equal(saved.length, 1, 'valid image reached the real attachment store before the handler rejection');
  assert.deepEqual(Buffer.from((await f.ctx.attachments.readImage(saved[0])).data), png);
  return result;
}

for (const active of [false, true]) test(`failed later command preserves successful queued ${!active} through reopen`, async t => {
  const f = await fixture(t); const first = await f.open(); begin(first, active);
  assert.equal((await first.command(active ? '/plan off' : '/plan')).result.kind, 'success');
  assert.equal(first.ctx.planMode.planState(first.agent.session).wanted, !active);
  await rejectedOffWithImage(t, first);
  assert.deepEqual(first.ctx.planMode.get(first.agent), { active, pending: !active });
  assert.equal(first.ctx.planMode.planState(first.agent.session).wanted, !active);
  assert.equal(first.ctx.planMode.planState(first.agent.session).running, null);
  end(first); await first.flush(); await first.close();
  const second = await f.open(true);
  assert.deepEqual(second.ctx.planMode.get(second.agent), { active, pending: !active });
  await boundary(second);
  assert.deepEqual(second.ctx.planMode.get(second.agent), { active: !active });
});

test('failure without prior wanted stays empty; a successful opposite selection still clears wanted', async t => {
  const f = await fixture(t); const first = await f.open(); begin(first, false);
  await rejectedOffWithImage(t, first);
  assert.equal(first.ctx.planMode.planState(first.agent.session).wanted, null);
  assert.deepEqual(first.ctx.planMode.get(first.agent), { active: false });
  await first.command('/plan');
  assert.equal(first.ctx.planMode.planState(first.agent.session).wanted, true);
  assert.equal((await first.command('/plan off')).result.kind, 'success');
  assert.equal(first.ctx.planMode.planState(first.agent.session).wanted, null);
  await boundary(first);
  assert.deepEqual(first.ctx.planMode.get(first.agent), { active: false });
  end(first);
});

test('version 4 checkpoint is ignored and the real registry refolds successful selection before failed command', async t => {
  const f = await fixture(t); const first = await f.open(); begin(first, false);
  await first.command('/plan'); await rejectedOffWithImage(t, first); end(first);
  const session = first.agent.session;
  const registry = first.ctx.sessionProjections;
  const old = registry.checkpoint(session);
  // Exact old fold result at this cut; no live projection state is mutated.
  old.plan = { ...old.plan, ver: 4, val: { ...old.plan.val, wanted: null } };
  assert.equal(registry.restoreFloor(old), 0);
  const result = registry.restore(old, session.snapshotEvents(), 0, session.header, session.inheritedEventCount);
  assert.equal(result.checkpoint.plan.ver, 5);
  assert.equal(result.checkpoint.plan.val.wanted, true);
  assert.deepEqual(result.snapshot.values.plan, { active: false, pending: true });
});
