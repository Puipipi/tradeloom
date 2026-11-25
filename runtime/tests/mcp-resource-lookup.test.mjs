import test from 'node:test';
import assert from 'node:assert/strict';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
const base = join(resolve(process.env.DSH_PREFIX), 'node_modules/@deepseek-ai');
const load = name => import(pathToFileURL(join(base, name, 'lib/index.js')));
const { Context } = await load('cordis');
const { NamedEntries, bindScopeParent, createScope, scopeOf } = await load('dsh-scope');
let serial = 0;
async function fixture(t) {
  const ctx = new Context();
  t.after(() => ctx.fiber.dispose());
  for (const name of ['dsh-session', 'dsh-session-projection', 'dsh-agent', 'dsh-llm', 'dsh-tools', 'dsh-system-prompt', 'dsh-mcp-resources']) await ctx.plugin((await load(name)).default);
  await ctx.plugin(await load('dsh-tool-executor-native'));
  await ctx.plugin((await load('dsh-agent-loop')).AgentLoop, { agents: [] });
  const create = async () => (await ctx.agents.create({ sessionId: `mcp-lookup-${++serial}` })).agent;
  const agent = await create();
  let resourceOwner;
  await ctx.inject(['mcpResources'], inner => { resourceOwner = inner; });
  const providers = new WeakSet(), seen = [];
  const register = (owner, server, label, error) => {
    const provider = { async request(request, exec) {
      seen.push({ label, request, exec });
      if (error) throw error;
      return { label, ...request };
    } };
    providers.add(provider);
    const registration = owner === ctx ? resourceOwner : createScope(resourceOwner, scopeOf(owner)).ctx;
    return registration.mcpResources.register(server, provider);
  };
  const run = async (server, caller = agent, name = 'list_mcp_resources', extra = {}) => {
    const batch = await ctx.tools.execute({ calls: [{ id: `mcp-call-${++serial}`, name, arguments: JSON.stringify({ server, ...extra }) }], agent: caller, signal: new AbortController().signal });
    return batch.results[0].result;
  };
  return { ctx, agent, create, providers, seen, register, run };
}
async function counted(f, operation) {
  const original = NamedEntries.prototype.entries;
  let entries = 0;
  NamedEntries.prototype.entries = function* () {
    for (const row of original.call(this)) {
      if (f.providers.has(row[1])) entries++;
      yield row;
    }
  };
  try { return { result: await operation(), entries }; }
  finally { NamedEntries.prototype.entries = original; }
}

for (const count of [0, 1, 200, 2000]) test(`real resource tool avoids materializing ${count} unrelated server rows`, async t => {
  const f = await fixture(t);
  for (let i = 0; i < count; i++) f.register(f.ctx, `server-${i}`, `provider-${i}`);
  const observed = await counted(f, () => f.run(`server-${count - 1}`));
  if (count === 0) { assert.equal(observed.result.isError, true); assert.equal(f.seen.length, 0); }
  else {
    assert.equal(observed.result.isError, false);
    assert.deepEqual(observed.result.value, { label: `provider-${count - 1}`, method: 'resources/list' });
    assert.equal(f.seen.length, 1);
    assert.equal(f.seen[0].exec.agent, f.agent);
  }
  t.diagnostic(`registered=${count} provider-entries-materialized=${observed.entries}`);
  assert.equal(observed.entries, 0);
});

test('nearest scope wins, siblings stay isolated, and disposal or replacement changes the next request', async t => {
  const f = await fixture(t), parent = await f.create(), sibling = await f.create();
  bindScopeParent(f.agent, parent);
  f.register(f.ctx, 'shared', 'global');
  const removeParent = f.register(parent.ctx, 'shared', 'parent');
  const removeChild = f.register(f.agent.ctx, 'shared', 'child');
  f.register(sibling.ctx, 'private', 'sibling');
  assert.equal((await f.run('shared')).value.label, 'child');
  assert.equal((await f.run('shared', parent)).value.label, 'parent');
  assert.equal((await f.run('shared', sibling)).value.label, 'global');
  const unseen = await f.run('private');
  assert.equal(unseen.isError, true);
  assert.match(unseen.error.message, /unavailable in this agent's scope/);
  assert.equal(f.seen.length, 3);
  await removeChild();
  assert.equal((await f.run('shared')).value.label, 'parent');
  await removeParent();
  assert.equal((await f.run('shared')).value.label, 'global');
  f.register(f.agent.ctx, 'shared', 'replacement');
  assert.equal((await f.run('shared')).value.label, 'replacement');
});

test('resource methods preserve cursor, URI, caller and provider failure without fallback', async t => {
  const f = await fixture(t);
  f.register(f.ctx, 'server', 'global');
  const failure = new Error('fixture provider failed');
  const remove = f.register(f.agent.ctx, 'server', 'local-failing', failure);
  const bad = await f.run('server');
  assert.equal(bad.isError, true);
  assert.match(bad.error.message, /fixture provider failed/);
  assert.deepEqual(f.seen.map(x => x.label), ['local-failing']);
  await remove();
  const templates = await f.run('server', f.agent, 'list_mcp_resource_templates', { cursor: 'exact-cursor' });
  assert.deepEqual(templates.value, { label: 'global', method: 'resources/templates/list', cursor: 'exact-cursor' });
  const read = await f.run('server', f.agent, 'read_mcp_resource', { uri: 'fixture://document' });
  assert.deepEqual(read.value, { label: 'global', method: 'resources/read', uri: 'fixture://document' });
  assert.ok(f.seen.every(x => x.exec.agent === f.agent && x.exec.signal instanceof AbortSignal));
});

test('duplicate registration still rejects without replacing the first provider', async t => {
  const f = await fixture(t);
  f.register(f.ctx, 'same', 'first');
  assert.throws(() => f.register(f.ctx, 'same', 'second'), /already registered/);
  assert.equal((await f.run('same')).value.label, 'first');
});
