// Real pinned Inbox/Session/AgentLoop with the production context, recall,
// store, marker and HTTP code. Model transport and owner admission are the
// same explicitly controlled boundaries as the C902 integration fixture.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createServer, request as httpRequest } from 'node:http';
import { createCompanionRoutes } from '../bridge/dsh-go-bridge/lib/companion/routes.js';
import { createFixture, requestSystemText } from './fixtures/companion-recall-engine.mjs';

const integration = (name, run) => test(name, {
  skip: !process.env.DSH_PREFIX, concurrency: false, timeout: 15000,
}, run);
async function fixture(t) {
  let clock = Date.now();
  const f = await createFixture({ now: () => clock });
  t.after(() => f.dispose());
  const { agent } = await f.createAgent('CONTEXT');
  const message = (rpcId, text = '  真人逐字原话\n') => f.engine.llm.createUserMessage({
    source: { kind: 'user', rpcId }, content: [{ type: 'text', text }],
  });
  const body = (requestId, extra = {}) => ({ v: 1, sessionId: agent.id, requestId,
    instanceId: f.promptContext.info(agent).instanceId, events: [], ...extra });
  const event = id => ({ id, kind: 'pet', at: clock, detail: '摸了摸头' });
  return { ...f, agent, message, body, event, now: () => clock, setTime: value => { clock = value; } };
}

integration('actual Inbox same-turn steer clears the overnight gap after actual human Session commit', async t => {
  const f = await fixture(t), s = f.promptContext, { agent } = f;
  s.prepare(agent, f.body('morning'), [], f.now() - 20 * 3600000);
  const first = f.message('morning');
  agent.inbox.append('next-turn', first); agent.inbox.claim('next-turn', 1);
  assert.match(s.render(agent), /"idleSinceHumanMinutes":1200/);
  const committed = agent.session.append('user/message', first, { surfaceOp: 'append' });
  f.setTime(committed.time + 60000);
  agent.inbox.append('next-step', f.message('steer'));
  agent.inbox.claim('next-step', 1);
  assert.doesNotMatch(s.render(agent), /idleSinceHumanMinutes/);
});

integration('actual non-RPC owner steer clears same-turn idle and the previous query context', async t => {
  const f = await fixture(t), s = f.promptContext, { agent } = f;
  s.prepare(agent, f.body('morning'), [{ text: 'PREVIOUS_RPC_QUERY', expiresAt: null }], f.now() - 20 * 3600000);
  const first = f.message('morning');
  agent.inbox.append('next-turn', first); agent.inbox.claim('next-turn', 1);
  assert.match(s.render(agent), /"idleSinceHumanMinutes":1200/);
  assert.match(s.render(agent), /PREVIOUS_RPC_QUERY/);
  const committed = agent.session.append('user/message', first, { surfaceOp: 'append' });
  f.setTime(committed.time + 60000);
  const followup = f.engine.llm.createUserMessage({ source: { kind: 'user' },
    content: [{ type: 'text', text: '  真人通过非 RPC 入口继续说话\n' }] });
  agent.inbox.append('next-step', followup); agent.inbox.claim('next-step', 1);
  assert.equal(s.render(agent), '');
  assert.equal(Object.hasOwn(followup.source, 'rpcId'), false);
});

integration('actual Inbox edit preserves request-bound event and retrieval despite discarded old occurrence', async t => {
  const f = await fixture(t), s = f.promptContext, { agent } = f;
  s.prepare(agent, f.body('edit', { events: [f.event('pet-edit')] }), [{ text: 'QUERY_EDIT', expiresAt: null }]);
  const original = f.message('edit'); agent.inbox.append('next-turn', original);
  agent.inbox.replace(original.id, Object.freeze({ ...original, content: [{ type: 'text', text: '  编辑后的原话  ' }] }));
  const [line] = agent.inbox.claim('next-turn', 1);
  assert.equal(line.source.rpcId, 'edit'); assert.equal(line.content[0].text, '  编辑后的原话  ');
  assert.match(s.render(agent), /pet-edit/); assert.match(s.render(agent), /QUERY_EDIT/);
});

integration('actual queue to steer and identical POST preserve the original context lease', async t => {
  const f = await fixture(t), s = f.promptContext, { agent } = f;
  const body = f.body('move', { events: [f.event('pet-steer')] });
  s.prepare(agent, body, [{ text: 'QUERY_STEER', expiresAt: null }]);
  const line = f.message('move'); agent.inbox.append('next-turn', line);
  agent.inbox.remove(line.id); agent.inbox.append('next-step', line);
  assert.equal(s.prepare(agent, body).supported, true);
  agent.inbox.claim('next-step', 1);
  assert.match(s.render(agent), /pet-steer/); assert.match(s.render(agent), /QUERY_STEER/);
});

integration('actual takeOut and delayed putBack use a fresh message id with the same rpcId', async t => {
  const f = await fixture(t), s = f.promptContext, { agent } = f;
  s.prepare(agent, f.body('send-now', { events: [f.event('pet-send-now')] }), [{ text: 'QUERY_SEND_NOW', expiresAt: null }]);
  const line = f.message('send-now'); agent.inbox.append('next-turn', line); agent.inbox.remove(line.id);
  await new Promise(resolve => setImmediate(resolve));
  f.setTime(f.now() + 2000);
  const replay = f.message('send-now'); assert.notEqual(replay.id, line.id);
  agent.inbox.append('next-turn', replay); agent.inbox.claim('next-turn', 2);
  assert.match(s.render(agent), /pet-send-now/); assert.match(s.render(agent), /QUERY_SEND_NOW/);
});

integration('actual removal never attaches the parked sidecar to an unrelated prompt', async t => {
  const f = await fixture(t), s = f.promptContext, { agent } = f;
  s.prepare(agent, f.body('remove', { events: [f.event('canceled-event')] }), [{ text: 'CANCELED_QUERY', expiresAt: null }]);
  const line = f.message('remove'); agent.inbox.append('next-turn', line); agent.inbox.remove(line.id);
  agent.inbox.append('next-turn', f.message('unrelated')); agent.inbox.claim('next-turn', 1);
  assert.equal(s.render(agent), '');
});

async function http(t, f, store = f.store) {
  const ctx = { get(name) {
    if (name === 'connection') return { admit: () => ({ peer: { principal: { kind: 'owner' } } }) };
    return f.ctx.get(name);
  } };
  const routes = createCompanionRoutes({ ctx, store, recall: f.coordinator, promptContext: f.promptContext,
    send(res, status, data) { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(data)); },
  });
  const server = createServer((req, res) => { void routes.handle(req, res, new URL(req.url, 'http://fixture').pathname); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  return body => new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = httpRequest({ host: '127.0.0.1', port: server.address().port,
      path: '/dsh-go/v1/companion/prompt-context', method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) },
    }, res => {
      const chunks = []; res.on('data', value => chunks.push(value));
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) }));
    });
    req.on('error', reject); req.end(data);
  });
}

integration('query await across memory change and bind keeps profile/events but only C902 memory reaches actual request', async t => {
  const f = await fixture(t), { agent } = f;
  await f.saveMemory('OLD_QUERY', { keywords: ['tea'] });
  const read = Promise.withResolvers(), release = Promise.withResolvers();
  let queryReads = 0;
  const request = await http(t, f, { ...f.store, async getContext(input) {
    queryReads++;
    const snapshot = await f.store.getContext(input);
    read.resolve(); await release.promise; return snapshot;
  } });
  const body = f.body('await', { query: 'tea', events: [f.event('pet-await')],
    profile: { persona: 'SYNTHETIC_PROFILE', name: 'NAME_ONCE', callMe: '', moves: '' }, expectedProfileRevision: 0 });
  const posting = request(body); await read.promise;
  const old = await f.store.getSnapshot();
  await f.coordinator.mutateMemory('clearMemories', { storeId: old.storeId, expectedRevision: old.revision });
  await f.saveMemory('AUTO_CURRENT');
  const binding = await f.bind(agent.id);
  assert.equal(binding.status, 'ready');
  release.resolve();
  const ack = await posting;
  assert.equal(ack.status, 200); assert.equal(ack.body.profileAccepted, true);
  assert.equal(ack.body.memoryMode, 'automatic');
  assert.equal(f.promptContext.profile(agent).name, 'NAME_ONCE');
  assert.equal((await request(body)).status, 200);
  assert.equal(queryReads, 1, 'the automatic lane never starts another query sidecar read');
  agent.followup(f.message('await')); await agent.whenIdle();
  assert.equal(f.requests.length, 1);
  const wire = JSON.stringify(f.requests[0].body), system = requestSystemText(f.requests[0]);
  assert.doesNotMatch(wire, /OLD_QUERY/); assert.match(wire, /pet-await/);
  assert.match(system, /AUTO_CURRENT/);
  assert.equal((system.match(/<companion_memory v="1">/g) ?? []).length, 1);
  assert.equal((system.match(/NAME_ONCE/g) ?? []).length, 1);
  const humans = [];
  for (let seq = 0; seq < agent.session.seq; seq++) {
    const e = agent.session.eventAt(seq);
    if (e.type === 'user/message' && e.data.source?.kind === 'user') humans.push(e.data);
  }
  assert.equal(humans.length, 1);
  assert.equal(humans[0].source.rpcId, 'await');
  assert.equal(humans[0].content[0].text, '  真人逐字原话\n');
  await f.coordinator.revoke({ v: 1, operationId: randomUUID(), bindingId: binding.bindingId, reason: 'user-off' });
  assert.equal(f.promptContext.info(agent).memoryMode, 'automatic', 'revoke cannot reopen old query memory');
  const next = f.body('after-revoke', { query: 'tea', events: [f.event('pet-after-revoke')] });
  assert.equal((await request(next)).status, 200); assert.equal(queryReads, 1);
  f.promptContext.claim(agent, f.message('after-revoke'), 2);
  assert.match(f.promptContext.render(agent), /pet-after-revoke/);
  assert.doesNotMatch(f.promptContext.render(agent), /OLD_QUERY|AUTO_CURRENT/);
});

integration('bind clears pending/current query memory and a failed publication cannot restore it', async t => {
  const f = await fixture(t), { agent } = f, s = f.promptContext;
  const body = f.body('old', { events: [f.event('pet-old')],
    profile: { persona: 'RETAIN_PROFILE', name: '', callMe: '', moves: '' }, expectedProfileRevision: 0 });
  s.prepare(agent, body, [{ text: 'OLD_CURRENT', expiresAt: null }]);
  // Direct context claim models a cached current slot; the actual binding
  // still independently proves a clean real Session and empty real Inbox.
  s.claim(agent, f.message('old'), 1); assert.match(s.render(agent), /OLD_CURRENT/);
  f.markers.write = async () => { throw new Error('synthetic marker publication failure'); };
  await assert.rejects(f.bind(agent.id));
  assert.equal(s.info(agent).memoryMode, 'automatic');
  assert.equal(s.profile(agent).persona, 'RETAIN_PROFILE');
  assert.doesNotMatch(s.render(agent), /OLD_CURRENT/); assert.match(s.render(agent), /pet-old/);
  s.prepare(agent, body, [{ text: 'OLD_RETRY', expiresAt: null }]);
  s.claim(agent, f.message('old'), 2);
  assert.doesNotMatch(s.render(agent), /OLD_CURRENT|OLD_RETRY/); assert.match(s.render(agent), /pet-old/);
});

integration('mutation starts by invalidating query awaits/current even when memory CAS rejects', async t => {
  const f = await fixture(t), { agent } = f, s = f.promptContext;
  s.prepare(agent, f.body('current'), [{ text: 'STALE_CURRENT', expiresAt: null }]);
  s.claim(agent, f.message('current'), 1);
  const oldTicket = s.captureMemory(agent), snap = await f.store.getSnapshot();
  await assert.rejects(f.coordinator.mutateMemory('clearMemories', {
    storeId: snap.storeId, expectedRevision: snap.revision + 1,
  }));
  assert.doesNotMatch(s.render(agent), /STALE_CURRENT/);
  s.prepare(agent, f.body('late'), [{ text: 'STALE_AWAIT', expiresAt: null }], undefined, oldTicket);
  s.claim(agent, f.message('late'), 2);
  assert.doesNotMatch(s.render(agent), /STALE_AWAIT/);
});

integration('same-id replacement Session and new bridge policy never copy old sidecars or reopen marked query lane', async t => {
  const f = await fixture(t), { agent } = f, s = f.promptContext;
  const oldSession = agent.session;
  s.prepare(agent, f.body('old', { events: [f.event('old-event')] }), [{ text: 'OLD_QUERY', expiresAt: null }]);
  const oldTicket = s.captureMemory(agent);
  await f.bind(agent.id);
  agent.session = f.engine.session.Session.create(agent.id);
  agent.session.append('agent-preset/selected', { agentPreset: 'dsh-go-companion-full' });
  try {
    assert.equal(f.coordinator.allowsQueryContext(agent), false);
    assert.equal(s.info(agent).memoryMode, 'automatic');
    assert.equal(s.profile(agent), undefined);
    assert.throws(() => s.prepare(agent, f.body('late'), [], undefined, oldTicket),
      e => e.code === 'companion/session-unavailable');
    s.claim(agent, f.message('old'), 1);
    assert.equal(s.render(agent), '');
    s.commit(oldSession, f.message('old'), f.now()); s.end(oldSession);
    assert.equal(s.render(agent), '');
  } finally { agent.session = oldSession; }
});
