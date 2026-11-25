import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
const base = join(resolve(process.env.DSH_PREFIX), 'node_modules/@deepseek-ai');
const load = name => import(pathToFileURL(join(base, name, 'lib/index.js')));
const { Context } = await load('cordis');
const { AgentRegistry } = await load('dsh-agent');
const { Session } = await load('dsh-session');
const { createScope } = await load('dsh-scope');
const { LocalFileSystem } = await load('dsh-fs-local');
const { WorkingDirectoryService } = await load('dsh-working-directory');
const { LocalFileReferenceService } = await load('dsh-file-reference-local');

async function fixture(t) {
  const root = await fs.mkdtemp(join(tmpdir(), 'file-search-owner-'));
  await fs.writeFile(join(root, 'needle.txt'), 'fixture');
  const ctx = new Context();
  t.after(async () => { await ctx.fiber.dispose(); await fs.rm(root, { recursive: true, force: true }); });
  // Fixed projection and unused prompt registration are context boundaries;
  // actual WorkingDirectory, filesystem, registry and file search run below.
  ctx.provide('sessionProjections', { async register() { return { stateOf() { return root; } }; } });
  ctx.provide('systemPrompt', { context() {}, getContextOrder() { return 1; } });
  await ctx.plugin(LocalFileSystem, { cwd: root }).await();
  await ctx.plugin(WorkingDirectoryService, { defaultDirectory: root }).await();
  await ctx.plugin(AgentRegistry).await();
  const session = Session.create('file-search-owner');
  const agent = { id: session.id, session, ctx };
  const detach = ctx.agents.enter(agent);
  t.after(detach);
  const plugin = ctx.plugin(LocalFileReferenceService);
  await plugin.await();
  return { ctx, agent, plugin, service: ctx.fileReferences };
}

function pauseStat(t, ctx, error) {
  let entered, release;
  const started = new Promise(resolve => { entered = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const original = ctx.fs.stat;
  t.mock.method(ctx.fs, 'stat', async function(...args) {
    const result = await original.apply(this, args);
    entered(); await gate;
    if (error) throw error;
    return result;
  });
  return { started, release };
}
const signal = () => new AbortController().signal;

for (const warm of [false, true]) {
  test(`retired provider cannot recreate ${warm ? 'an existing' : 'a first'} search after ensure; replacement remains live`, async t => {
    const { ctx, agent, plugin, service } = await fixture(t);
    let previous;
    if (warm) {
      assert.equal((await service.list(agent, 'needle', signal()))[0].path, 'needle.txt');
      previous = service.searches.get(agent).search;
    }
    const gate = pauseStat(t, ctx);
    const listing = service.list(agent, 'needle', signal());
    await gate.started;
    await plugin.dispose();
    assert.equal(service.searches.size, 0);
    if (previous) assert.equal(previous.disposed, true);
    assert.equal(ctx.agents.get(agent.id), agent, 'Agent lifetime has not ended');
    const replacement = ctx.plugin(LocalFileReferenceService);
    await replacement.await();
    const next = ctx.fileReferences;
    assert.notEqual(next, service);
    gate.release();
    const result = await listing;
    const healthy = await next.list(agent, 'needle', signal());
    assert.equal(healthy[0].path, 'needle.txt');
    assert.equal(next.searches.size, 1);
    t.diagnostic(`retired-searches=${service.searches.size} replacement-searches=${next.searches.size}`);
    assert.equal(service.searches.size, 0);
    assert.deepEqual(result, []);
  });
}

test('ensure filesystem failure is not swallowed by retirement', async t => {
  const { ctx, agent, plugin, service } = await fixture(t);
  const error = Object.assign(new Error('SYNTHETIC_STAT_EIO'), { code: 'EIO' });
  const gate = pauseStat(t, ctx, error);
  const listing = service.list(agent, 'needle', signal());
  const rejected = assert.rejects(listing, actual => actual === error);
  await gate.started;
  await plugin.dispose();
  gate.release(); await rejected;
  assert.equal(service.searches.size, 0);
});

test('caller cancellation during real ensure keeps its original reason after retirement', async t => {
  const { ctx, agent, plugin, service } = await fixture(t);
  const gate = pauseStat(t, ctx);
  const controller = new AbortController();
  const error = new Error('SYNTHETIC_CALLER_CANCEL');
  const listing = service.list(agent, 'needle', controller.signal);
  const rejected = assert.rejects(listing, actual => actual === error);
  await gate.started;
  await plugin.dispose();
  controller.abort(error);
  gate.release(); await rejected;
  assert.equal(service.searches.size, 0);
});

test('Agent scope disposal before announced detach does not report a prompt cleanup failure', async t => {
  const { ctx, service } = await fixture(t);
  const session = Session.create('file-search-scope-owner');
  const scope = createScope(ctx, {});
  const agent = { id: session.id, session, ctx: scope.ctx };
  const detach = ctx.agents.enter(agent);
  t.after(async () => { await scope.dispose(); detach(); });
  const warnings = [];
  ctx.logger.exporter({ export(message) {
    if (message.type === 'warn') warnings.push(message.args.map(String).join(' '));
  } });
  await ctx.agents.announce(agent, 'create');
  const prompt = service.promptFibers.get(agent);
  assert.ok(prompt, 'the announced Agent owns a real injected prompt fiber');
  assert.notEqual(prompt.uid, null);

  // AgentLoop teardown closes the actual scope before detaching its announced entry.
  await scope.dispose();
  assert.equal(prompt.uid, null, 'the parent scope already disposed the prompt fiber');
  assert.equal(ctx.agents.get(agent.id), agent);
  assert.equal(service.promptFibers.get(agent), prompt);
  detach();
  await Promise.all([...service.promptDisposals]);

  assert.equal(ctx.agents.get(agent.id), undefined);
  assert.equal(service.promptFibers.has(agent), false);
  assert.equal(service.promptDisposals.size, 0);
  assert.deepEqual(warnings, []);
});
