import test from 'node:test';
import assert from 'node:assert/strict';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
const base = join(resolve(process.env.DSH_PREFIX), 'node_modules/@deepseek-ai');
const load = name => import(pathToFileURL(join(base, name, 'lib/index.js')));
const { Context } = await load('cordis');
const { createUserMessage } = await load('dsh-llm');
const { agentEvents } = await load('dsh-agent');
let serial = 0;
function message(zone, source = {}) {
  return createUserMessage({ content: [{ type: 'text', text: 'fixture' }], source: { kind: 'user', rpcId: `fixture-${++serial}`, ...(zone === undefined ? {} : { clientTimeZone: zone }), ...source } });
}
async function fixture(t) {
  const ctx = new Context();
  t.after(() => ctx.fiber.dispose());
  for (const name of ['dsh-session', 'dsh-session-projection', 'dsh-agent', 'dsh-llm', 'dsh-tools', 'dsh-system-prompt']) {
    await ctx.plugin((await load(name)).default);
  }
  await ctx.plugin((await load('dsh-agent-loop')).AgentLoop, { agents: [] });
  await ctx.plugin(await load('dsh-time-context'), { timeZone: 'UTC', refreshIntervalMs: 0 });
  const { agent } = await ctx.agents.create({ sessionId: `fixture-${++serial}` });
  return { agent, async run(messages, turn = 1) {
    return agentEvents(ctx, agent).waterfall('agent/pre-step', { messages, turn, step: 1, signal: new AbortController().signal }, () => Promise.resolve({ kind: 'enter', messages }));
  } };
}
async function counted(operation) {
  const original = Intl.DateTimeFormat;
  let validation = 0, timestamp = 0;
  Intl.DateTimeFormat = new Proxy(original, { construct(target, args, newTarget) {
    if (args[1]?.timeZoneName === 'longOffset') timestamp++;
    else validation++;
    return Reflect.construct(target, args, newTarget);
  } });
  try { return { result: await operation(), counts: () => ({ validation, timestamp }) }; }
  finally { Intl.DateTimeFormat = original; }
}
const policy = result => result.messages.at(-1).content[0].text.split('\n')[1];
const resolved = zone => `Browser time zone for this request: ${zone}. Interpret otherwise-unqualified dates and times in this zone.`;
for (const size of [20, 200]) test(`actual pre-step validates ${size} repeated UTC messages only once`, async t => {
  const f = await fixture(t), messages = Array.from({ length: size }, () => message('UTC'));
  const original = structuredClone(messages);
  const observed = await counted(() => f.run(messages));
  assert.equal(policy(observed.result), resolved('UTC'));
  assert.deepEqual(observed.result.messages.slice(0, size), original);
  assert.equal(observed.result.messages.length, size + 1);
  t.diagnostic(JSON.stringify({ size, ...observed.counts() }));
  assert.deepEqual(observed.counts(), { validation: 1, timestamp: 0 });
});
test('zero and single valid zones retain their constructor costs and ignored sources stay ignored', async t => {
  const f = await fixture(t);
  const ignored = [message('invalid', { kind: 'fixture' }), message('invalid', { rpcId: 1 }), message(42), message(undefined)];
  for (const messages of [[], ignored]) {
    const observed = await counted(() => f.run(messages));
    assert.equal(policy(observed.result), 'Browser time zone for this request: unavailable. Ask the user to clarify otherwise-unqualified dates and times.');
    assert.deepEqual(observed.counts(), { validation: 0, timestamp: 0 });
  }
  const observed = await counted(() => f.run([message('UTC')]));
  assert.equal(policy(observed.result), resolved('UTC'));
  assert.deepEqual(observed.counts(), { validation: 1, timestamp: 0 });
});
test('mixed zones are sorted and deduplicated without choosing a request formatter', async t => {
  const f = await fixture(t);
  const observed = await counted(() => f.run(['UTC', 'Asia/Tokyo', 'UTC', 'Asia/Tokyo'].map(zone => message(zone))));
  assert.equal(policy(observed.result), 'Browser time zone for this request: mixed ["Asia/Tokyo","UTC"]. Ask the user to clarify otherwise-unqualified dates and times.');
  assert.deepEqual(observed.counts(), { validation: 2, timestamp: 0 });
});
test('valid duplicates do not conceal subsequent invalid, unsupported or noncanonical zones', async t => {
  const f = await fixture(t);
  for (const [zone, expected] of [[' UTC ', 'browser time zone must be canonical UTC or IANA Area/Location: " UTC "'], ['Unknown/Fixture', 'browser time zone is unsupported: "Unknown/Fixture"'], ['Etc/UTC', 'browser time zone must be canonical: "Etc/UTC"']]) {
    await assert.rejects(f.run([message('UTC'), message('UTC'), message(zone), message('later-invalid')]), error => error instanceof TypeError && error.message === expected);
  }
});
test('validation is per invocation while the existing timestamp formatter cache remains separate', async t => {
  const f = await fixture(t);
  for (const [zone, timestamp] of [['Asia/Tokyo', 1], ['Asia/Tokyo', 0], ['UTC', 0]]) {
    const observed = await counted(() => f.run([message(zone), message(zone)]));
    assert.equal(policy(observed.result), resolved(zone));
    assert.deepEqual(observed.counts(), { validation: 1, timestamp });
  }
});
test('entered and proposed messages in the current turn share validation but prior turns do not', async t => {
  const f = await fixture(t);
  f.agent.session.append('turn/start', { turn: 1 });
  f.agent.session.append('user/message', message('Asia/Tokyo'), { surfaceOp: 'append' });
  f.agent.session.append('turn/end', { turn: 1, reason: { kind: 'completed' } });
  f.agent.session.append('turn/start', { turn: 2 });
  f.agent.session.append('user/message', message('UTC'), { surfaceOp: 'append' });
  const observed = await counted(() => f.run([message('UTC')], 2));
  assert.equal(policy(observed.result), resolved('UTC'));
  assert.deepEqual(observed.counts(), { validation: 1, timestamp: 0 });
});
