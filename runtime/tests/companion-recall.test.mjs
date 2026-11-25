import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { once } from 'node:events';
import * as fs from 'node:fs';
import * as io from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createCompanionStore } from '../bridge/dsh-go-bridge/lib/companion/store.js';
import { createRecallCoordinator } from '../bridge/dsh-go-bridge/lib/companion/recall.js';
import { createRecallMarkers, RECALL_MARKER_SCHEMA } from '../bridge/dsh-go-bridge/lib/companion/recall-markers.js';
import { validateBind, validateRevoke } from '../bridge/dsh-go-bridge/lib/companion/recall-schema.js';
import { createCompanionRoutes } from '../bridge/dsh-go-bridge/lib/companion/routes.js';
import { formatRecallSection, normalizeRecallText, RECALL_SELECTOR, selectRecallContext } from '../bridge/dsh-go-bridge/lib/companion/recall-selector.js';

// These fixtures exercise the real store/selector/coordinator/marker/HTTP code.
// Agent lifecycle/provider certification is a controlled adapter boundary here;
// the separate companion-recall-engine suite covers actual pinned engine paths.
const uuid = (number) => `00000000-0000-4000-8000-${number.toString(16).padStart(12, '0')}`;
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const code = (expected) => (error) => error?.code === `companion/${expected}`;
const version = (snapshot) => ({ storeId: snapshot.storeId, expectedRevision: snapshot.revision });
const item = (id = 1, overrides = {}) => ({ id: uuid(id), kind: 'preference', text: `Confirmed ${id}`,
  keywords: [], pinned: false, source: { kind: 'manual' }, expiresAt: null, ...overrides });
const stored = (id, overrides = {}) => ({ ...item(id), createdAt: 1, updatedAt: 1, ...overrides });
const sectionData = (text) => JSON.parse(text.split('\n')[2]);
const prep = (agent, turnId = 1, stepId = 1) => ({ agent, scope: agent, turnId, stepId, messages: [{ role: 'user', content: 'synthetic' }] });

async function fixture(t, options = {}) {
  const home = await io.mkdtemp(join(tmpdir(), 'dsh-go-recall-'));
  const directory = join(home, 'recall-sessions');
  const clock = { at: 1000 };
  const state = { readHook: undefined, readError: false, transform: undefined, stop: undefined,
    supported: true, reads: 0, stops: [], marks: [], agents: new Map() };
  const baseStore = createCompanionStore({ filePath: join(home, 'state.json'), now: () => clock.at });
  const store = { ...baseStore,
    async getRecallContext() {
      state.reads++;
      await state.readHook?.();
      if (state.readError) throw new Error('SYNTHETIC_PRIVATE_STORE /secret/path');
      const result = await baseStore.getRecallContext();
      return state.transform ? state.transform(result) : result;
    },
  };
  function agent(id = 'A') {
    const actual = { id, session: { id, clean: true }, live: true, full: true, supported: true };
    state.agents.set(id, actual);
    return actual;
  }
  const first = agent();
  const adapter = {
    version: 1,
    capability(actual) { return { supported: state.supported && (!actual || actual.agent.supported), reason: 'unsupported-provider' }; },
    async resolveTarget(sessionId) {
      const actual = state.agents.get(sessionId);
      if (!actual) throw new Error('SYNTHETIC_PRIVATE_SESSION');
      return { agent: actual, scope: actual };
    },
    isCurrent({ agent: actual, scope }) { return actual === scope && actual?.live && actual?.full && state.agents.get(actual.id) === actual; },
    isClean({ agent: actual }) { return actual.session.clean; },
    markBound(actual) { state.marks.push(actual); actual.agent.session.clean = false; },
    stop(actual) { state.stops.push(actual); return state.stop?.(actual); },
  };
  const markers = options.markers ?? createRecallMarkers({ directory });
  const coordinator = createRecallCoordinator({ store, adapter, markers, ...options.coordinator });
  t.after(async () => { coordinator.dispose(); await io.rm(home, { recursive: true, force: true }); });
  const initial = await baseStore.getSnapshot();
  const bindInput = async (sessionId = 'A', overrides = {}) => ({ v: 1, operationId: randomUUID(),
    storeId: (await baseStore.getSnapshot()).storeId.toLowerCase(),
    expectedMemoryRevision: (await baseStore.getSnapshot()).memoryRevision,
    sessionId, consumerId: randomUUID(), consent: RECALL_SELECTOR, ...overrides });
  const bind = async (sessionId = 'A', overrides = {}) => coordinator.bind(await bindInput(sessionId, overrides));
  const save = async (memory) => baseStore.upsertMemory({ ...version(await baseStore.getSnapshot()), memory });
  return { home, directory, clock, state, baseStore, store, adapter, markers, coordinator, initial,
    agent, first, bindInput, bind, save };
}

test('confirmed selector enforces expiry, source/schema, pinned/recency/UUID order and detached records', () => {
  const records = [stored(7, { updatedAt: 9 }), stored(5, { pinned: true, updatedAt: 8 }),
    stored(3, { pinned: true, updatedAt: 8 }), stored(2, { expiresAt: 10 }),
    stored(4, { source: { kind: 'model-extracted' } }), stored(6, { text: 'bad\vcontrol' }),
    stored(8, { text: ' \t\u3000 ' }), item(9), { ...item(10), createdAt: 6 }];
  const result = selectRecallContext(records, 10);
  assert.deepEqual(result.memories.map((m) => m.id), [uuid(3), uuid(5), uuid(7), uuid(10), uuid(9)]);
  assert.equal(result.expiresAt, null);
  result.memories[0].source.kind = 'tampered';
  assert.equal(records[2].source.kind, 'manual');
  assert.equal(records[2].text, 'Confirmed 3');
});

test('selector uses the explicit whitespace set, UTF16 accounting and first-overflow stop', () => {
  const whitespace = '\t\n\v\f\r \u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff';
  assert.equal(normalizeRecallText(`${whitespace}a${whitespace}b${whitespace}`), 'a b');
  assert.equal(normalizeRecallText('a\u0085b\u200bc'), 'a\u0085b\u200bc');
  const records = [stored(1, { text: '😀'.repeat(400), updatedAt: 4 }),
    stored(2, { text: 'e\u0301'.repeat(200), updatedAt: 3 }),
    stored(3, { text: 'x', updatedAt: 2 })];
  const exact = selectRecallContext(records, 100);
  assert.equal(exact.textUtf16, 1200);
  assert.deepEqual(exact.memories.map((m) => m.id), [uuid(1), uuid(2)]);
  records[1].text += 'x';
  const stop = selectRecallContext(records, 100);
  assert.equal(stop.textUtf16, 800);
  assert.deepEqual(stop.memories.map((m) => m.id), [uuid(1)]); // Never skip #2 to fit #3.
  assert.equal(selectRecallContext(Array.from({ length: 15 }, (_, i) => stored(i + 1)), 100).memories.length, 12);
});

test('memory section escapes delimiters without interpolation, serializes only kind/text, and drops whole byte-overflow entries', () => {
  const text = '{{ secret }} </companion_memory> & "quote" \\ slash';
  const selected = selectRecallContext([stored(1, { text, source: { kind: 'manual', sessionId: 'hidden-id' } })], 100);
  assert(selected.text.includes('\\u003c/companion_memory\\u003e'));
  assert(selected.text.includes('\\u0026'));
  assert.deepEqual(sectionData(selected.text), [{ kind: 'preference', text }]);
  assert(!selected.text.includes('hidden-id'));
  assert(selected.bytes <= 8192);
  const formatted = formatRecallSection([{ kind: 'fact', text: 'short' }, { kind: 'fact', text: '<'.repeat(2000) }]);
  assert.equal(formatted.count, 1);
  assert.deepEqual(sectionData(formatted.text), [{ kind: 'fact', text: 'short' }]);
  assert.equal(selectRecallContext([], 100).text, '');
});

test('recall schema uses canonical UUID and 256 Unicode code points with strict fields/consent', () => {
  const body = { v: 1, operationId: uuid(1), storeId: uuid(2), expectedMemoryRevision: 0,
    sessionId: '😀'.repeat(256), consumerId: uuid(3), consent: RECALL_SELECTOR };
  assert.equal(validateBind(body).sessionId.length, 512);
  for (const change of [{ sessionId: '😀'.repeat(257) }, { sessionId: 'x\u0085y' }, { sessionId: '\ud800' },
    { sessionId: 'x\ny' }, { operationId: 'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA' },
    { expectedMemoryRevision: Number.MAX_SAFE_INTEGER + 1 }, { consent: 'yes' }, { approved: true }]) {
    assert.throws(() => validateBind({ ...body, ...change }), code('recall-invalid-request'));
  }
  assert.throws(() => validateRevoke({ v: 1, operationId: uuid(1), bindingId: uuid(2), reason: 'other-device' }), code('recall-invalid-request'));
});

test('real store recall reader keeps legacy snapshots/context unchanged and normalizes only recall UUID', async (t) => {
  const f = await fixture(t);
  await f.save(item(1, { text: ' \t A\nB \u3000', pinned: false }));
  const file = join(f.home, 'state.json');
  const document = JSON.parse(await io.readFile(file, 'utf8'));
  document.storeId = document.storeId.toUpperCase();
  await io.writeFile(file, JSON.stringify(document));
  const recall = await f.store.getRecallContext();
  assert.equal(recall.storeId, document.storeId.toLowerCase());
  assert.equal(recall.memories[0].text, ' \t A\nB \u3000');
  assert.equal(sectionData(recall.text)[0].text, 'A B');
  assert.equal((await f.baseStore.getContext({})).memories.length, 0);
  const snapshot = await f.baseStore.getSnapshot();
  assert.equal(snapshot.capabilities.automaticRecall, false);
  assert.equal(snapshot.storeId, document.storeId);
  assert.equal((await f.bind()).storeId, document.storeId.toLowerCase());
});

test('explicit bind is scoped to exact Agent, host and provider; tokens cannot be forged or reused across steps', async (t) => {
  const f = await fixture(t), other = await fixture(t);
  await f.save(item(1, { text: 'ONLY_A_SYNTHETIC' }));
  await other.save(item(2, { text: 'ONLY_B_SYNTHETIC' }));
  const a = await f.bind(), b = await other.bind();
  assert.notEqual(a.bridgeEpoch, b.bridgeEpoch);
  const pa = await f.coordinator.prepare(prep(f.first));
  const pb = await other.coordinator.prepare(prep(other.first));
  assert(pa.section.text.includes('ONLY_A_SYNTHETIC') && !pa.section.text.includes('ONLY_B_SYNTHETIC'));
  assert(pb.section.text.includes('ONLY_B_SYNTHETIC') && !pb.section.text.includes('ONLY_A_SYNTHETIC'));
  assert.equal(pa.section.interpolate, false);
  const unbound = f.agent('ordinary');
  assert.equal(await f.coordinator.prepare(prep(unbound)), undefined);
  assert.doesNotThrow(() => f.coordinator.guardTool({ agent: unbound, scope: unbound }));
  await assert.rejects(f.coordinator.prepare({ ...prep(f.first), scope: {} }), code('recall-retired'));
  await assert.rejects(f.coordinator.admit({ ...prep(f.first), stamp: { ...pa.stamp }, attemptId: 1 }), code('recall-retired'));
  await assert.rejects(other.coordinator.admit({ ...prep(other.first), stamp: pa.stamp, attemptId: 1 }), code('recall-retired'));
  const permit = await f.coordinator.admit({ ...prep(f.first), stamp: pa.stamp, attemptId: 1 });
  assert(Object.isFrozen(permit));
  assert.doesNotThrow(() => f.coordinator.guardTool({ agent: f.first, scope: f.first, permit }));
  assert.throws(() => f.coordinator.guardTool({ agent: f.first, scope: {}, permit }), code('recall-retired'));
  await assert.rejects(f.coordinator.admit({ ...prep(f.first), stamp: pa.stamp, attemptId: 1 }), code('recall-retired'));
  await f.coordinator.prepare(prep(f.first, 1, 2));
  assert.throws(() => f.coordinator.guardTool({ agent: f.first, scope: f.first, permit }), code('recall-retired'));
  await assert.rejects(f.coordinator.admit({ ...prep(f.first), stamp: pa.stamp, attemptId: 2 }), code('recall-retired'));
});

test('unsupported provider, unclean history, invalid full scope and store/revision mismatch never bind', async (t) => {
  const f = await fixture(t);
  f.first.supported = false;
  assert.equal((await f.coordinator.capability()).supported, true); // Host coverage is not target coverage.
  await assert.rejects(f.bind(), code('recall-adapter-unavailable'));
  f.first.supported = true; f.first.session.clean = false;
  await assert.rejects(f.bind(), code('recall-session-not-clean'));
  f.first.session.clean = true; f.first.full = false;
  await assert.rejects(f.bind(), code('recall-adapter-unavailable'));
  f.first.full = true;
  await assert.rejects(f.bind('A', { storeId: uuid(999) }), code('recall-store-changed'));
  await assert.rejects(f.bind('A', { expectedMemoryRevision: 1 }), code('recall-memory-conflict'));
  assert.equal(f.markers.readSync('A'), null);
  f.state.supported = false;
  assert.deepEqual(await f.coordinator.capability(), { v: 1, supported: false, reason: 'unsupported-provider',
    selectorVersion: RECALL_SELECTOR, maxItems: 12, textUtf16Budget: 1200, busy: false, activeBindingId: null });
});

test('one-store busy, current-status idempotency and permanent retired-session quarantine', async (t) => {
  const f = await fixture(t);
  f.agent('B');
  const input = await f.bindInput();
  const a = await f.coordinator.bind(input);
  assert.equal((await f.coordinator.bind({ ...input })).bindingId, a.bindingId);
  assert.equal((await f.coordinator.capability()).activeBindingId, a.bindingId);
  await assert.rejects(f.bind('B'), code('recall-binding-busy'));
  await assert.rejects(f.coordinator.bind({ ...input, consumerId: randomUUID() }), code('recall-operation-conflict'));
  const revoke = { v: 1, operationId: randomUUID(), bindingId: a.bindingId, reason: 'user-off' };
  const stopped = await f.coordinator.revoke(revoke);
  assert.equal(stopped.status, 'retired'); assert(stopped.recallEpoch > a.recallEpoch);
  assert.equal((await f.coordinator.revoke(revoke)).status, 'retired');
  assert.equal((await f.coordinator.bind(input)).status, 'retired');
  await assert.rejects(f.bind(), code('recall-session-not-clean'));
  assert.equal((await f.bind('B')).status, 'ready');
  assert.throws(() => f.coordinator.guardSession({ sessionId: 'A', agent: f.first, operation: 'wake' }), code('recall-retired'));
});

test('operation and binding retention are bounded without evicting retired identities or the revoke slot', async (t) => {
  const f = await fixture(t, { coordinator: { maxBindings: 2, maxOperations: 4 } });
  const input = await f.bindInput();
  const a = await f.coordinator.bind(input);
  await f.coordinator.revoke({ v: 1, operationId: randomUUID(), bindingId: a.bindingId, reason: 'user-off' });
  f.agent('B');
  const b = await f.bind('B');
  await assert.rejects(f.coordinator.revoke({ v: 1, operationId: randomUUID(), bindingId: a.bindingId, reason: 'user-off' }), code('recall-capacity'));
  assert.equal((await f.coordinator.revoke({ v: 1, operationId: randomUUID(), bindingId: b.bindingId, reason: 'user-off' })).status, 'retired');
  assert.equal((await f.coordinator.bind(input)).status, 'retired');
  f.agent('C');
  await assert.rejects(f.bind('C'), code('recall-capacity'));
});

for (const outcome of ['conflict', 'no-op', 'delete-missing', 'io-failure', 'invalid-body']) {
  test(`memory mutation retires before existing store CAS even on ${outcome}`, async (t) => {
    const f = await fixture(t);
    const memory = item(1);
    const saved = await f.save(memory);
    const bound = await f.bind();
    const prepared = await f.coordinator.prepare(prep(f.first));
    const permit = await f.coordinator.admit({ ...prep(f.first), stamp: prepared.stamp, attemptId: 1 });
    const old = f.store.upsertMemory;
    let invoked = false;
    f.store.upsertMemory = (body) => {
      invoked = true;
      assert.throws(() => f.coordinator.guardTool({ agent: f.first, scope: f.first, permit }), code('recall-retired'));
      if (outcome === 'io-failure') throw new Error('SYNTHETIC_PRIVATE_IO');
      return old(body);
    };
    const request = outcome === 'delete-missing'
      ? f.coordinator.mutateMemory('deleteMemory', { ...version(saved), id: uuid(99) })
      : f.coordinator.mutateMemory('upsertMemory', outcome === 'invalid-body' ? {} : {
        ...version(saved), expectedRevision: outcome === 'conflict' ? saved.revision - 1 : saved.revision, memory,
      });
    if (['conflict', 'io-failure', 'invalid-body'].includes(outcome)) await assert.rejects(request);
    else await request;
    assert.equal(invoked, outcome !== 'delete-missing');
    assert.equal((await f.coordinator.status(bound.bindingId)).status, 'retired');
    assert.equal((await f.baseStore.getSnapshot()).memoryRevision, saved.memoryRevision);
    await assert.rejects(f.coordinator.admit({ ...prep(f.first), stamp: prepared.stamp, attemptId: 2 }), code('recall-retired'));
  });
}

test('pet state event changes general revision without retiring memory binding; clear does retire', async (t) => {
  const f = await fixture(t);
  const a = await f.bind();
  const snapshot = await f.baseStore.getSnapshot();
  const event = await f.store.event({ ...version(snapshot), type: 'pet' });
  assert.equal(event.memoryRevision, snapshot.memoryRevision);
  assert.equal((await f.coordinator.status(a.bindingId)).status, 'ready');
  const result = await f.coordinator.mutateMemory('clearMemories', version(event));
  assert.equal(result.deletedCount, 0);
  assert.equal((await f.coordinator.status(a.bindingId)).status, 'retired');
});

test('retirement during a pending turn read discards its result; queued capability cannot capture undefined', async (t) => {
  const f = await fixture(t);
  const a = await f.bind();
  const entered = deferred(), release = deferred();
  f.state.readHook = async () => { entered.resolve(); await release.promise; };
  const pending = f.coordinator.prepare(prep(f.first));
  const rejected = assert.rejects(pending, code('recall-retired'));
  await entered.promise;
  const capability = f.coordinator.capability();
  f.coordinator.retireAgent(f.first, 'agent-changed');
  release.resolve();
  await rejected;
  assert.equal((await capability).busy, false);
  assert.equal((await f.coordinator.status(a.bindingId)).status, 'retired');
});

test('retire/write and attempt admission have one order; stop drain never holds the gate', async (t) => {
  const f = await fixture(t);
  await f.save(item(1));
  const a = await f.bind();
  const entered = deferred(), release = deferred(), stopRelease = deferred();
  f.state.stop = () => stopRelease.promise;
  f.state.readHook = async () => { entered.resolve(); await release.promise; };
  const pending = f.coordinator.prepare(prep(f.first));
  await entered.promise;
  const snapshot = await f.baseStore.getSnapshot();
  const mutation = f.coordinator.mutateMemory('clearMemories', version(snapshot));
  release.resolve();
  const prepared = await pending;
  await mutation; // Must not wait for engine.stop's never-yet-resolved drain.
  assert.equal((await f.coordinator.status(a.bindingId)).status, 'retired');
  await assert.rejects(f.coordinator.admit({ ...prep(f.first), stamp: prepared.stamp, attemptId: 1 }), code('recall-retired'));
  assert.equal(f.state.stops.length, 1);
  stopRelease.resolve();
});

test('identity, provider, store and read failure are rechecked after awaits before admission', async (t) => {
  for (const failure of ['agent', 'session', 'provider', 'read', 'store']) {
    const f = await fixture(t);
    const a = await f.bind();
    const prepared = await f.coordinator.prepare(prep(f.first));
    const entered = deferred(), release = deferred();
    f.state.readHook = async () => { entered.resolve(); await release.promise; };
    const request = f.coordinator.admit({ ...prep(f.first), stamp: prepared.stamp, attemptId: 1 });
    const rejected = assert.rejects(request);
    await entered.promise;
    if (failure === 'agent') f.agent('A');
    if (failure === 'session') f.first.session = { id: 'A', clean: false };
    if (failure === 'provider') f.first.supported = false;
    if (failure === 'read') f.state.readError = true;
    if (failure === 'store') f.state.transform = (context) => ({ ...context, storeId: uuid(321) });
    release.resolve(); await rejected;
    assert.equal((await f.coordinator.status(a.bindingId)).status, 'retired');
  }
});

test('earliest prepared-memory expiry accumulates across later turns, with no revival after clock rollback', async (t) => {
  const f = await fixture(t);
  await f.save(item(1, { expiresAt: 5000 }));
  const a = await f.bind();
  const one = await f.coordinator.prepare(prep(f.first, 1));
  assert.equal(one.stamp.expiresAt, 5000);
  // Controlled store response changes the next selection while retaining its
  // version. It tests accumulator semantics independently of selector ordering.
  f.state.transform = (context) => ({ ...context, expiresAt: null, text: '', memories: [] });
  const two = await f.coordinator.prepare(prep(f.first, 2));
  assert.equal(two.stamp.expiresAt, 5000);
  assert.equal(two.section, undefined);
  f.clock.at = 5000;
  assert.equal((await f.coordinator.status(a.bindingId)).reason, 'expired');
  f.clock.at = 1000;
  assert.equal((await f.coordinator.status(a.bindingId)).status, 'retired');
  await assert.rejects(f.coordinator.prepare(prep(f.first, 3)), code('recall-retired'));
});

test('marker is durable before markBound; restart/fork and copied history do not inherit authorization', async (t) => {
  const f = await fixture(t);
  f.adapter.markBound = ({ sessionId, storeId }) => {
    assert.equal(f.markers.readSync(sessionId).storeId, storeId);
    f.first.session.clean = false;
  };
  const input = await f.bindInput();
  const a = await f.coordinator.bind(input);
  const path = join(f.directory, `${createHash('sha256').update('A').digest('hex')}.json`);
  const metadata = JSON.parse(await io.readFile(path, 'utf8'));
  assert.deepEqual(metadata, { schema: RECALL_MARKER_SCHEMA, v: 1, sessionId: 'A', storeId: a.storeId, protocol: RECALL_SELECTOR });
  assert.throws(() => f.coordinator.guardSession({ sessionId: 'A', agent: f.first, operation: 'fork' }), code('recall-retired'));
  assert.throws(() => f.coordinator.guardSession({ sessionId: 'new-child', operation: 'create', recallHistory: true }), code('recall-retired'));
  assert.doesNotThrow(() => f.coordinator.guardSession({ sessionId: 'plain-child', operation: 'create' }));
  f.coordinator.dispose();
  const restarted = createRecallCoordinator({ store: f.store, adapter: f.adapter, markers: createRecallMarkers({ directory: f.directory }) });
  t.after(() => restarted.dispose());
  assert.notEqual(restarted.bridgeEpoch, a.bridgeEpoch);
  assert.throws(() => restarted.guardSession({ sessionId: 'A', agent: f.first, operation: 'resume' }), code('recall-retired'));
  await assert.rejects(restarted.bind(input), code('recall-session-not-clean'));
  await assert.rejects(restarted.status(a.bindingId), code('recall-binding-not-found'));
});

test('marker write failure, corruption and post-publication binding failure cannot become ready', async (t) => {
  const f = await fixture(t);
  const failing = createRecallMarkers({ directory: join(f.home, 'failing'), io: { ...io, link: async () => { throw new Error('ENOSPC /private'); } } });
  assert.equal(await failing.available(), false);
  await assert.rejects(failing.write('A', f.initial.storeId), code('recall-tag-unavailable'));
  const linkedDirectory = join(f.home, 'linked-but-unconfirmed');
  const afterLink = createRecallMarkers({ directory: linkedDirectory, io: { ...io,
    async open(path, flags, mode) {
      const handle = await io.open(path, flags, mode);
      return path === linkedDirectory && flags === 'r'
        ? { sync: async () => { throw new Error('synthetic directory fsync failure'); }, close: () => handle.close() }
        : handle;
    },
  } });
  await assert.rejects(afterLink.write('A', f.initial.storeId), code('recall-tag-unavailable'));
  assert.equal(afterLink.readSync('A').storeId, f.initial.storeId); // Published failure stays quarantined.
  f.adapter.markBound = () => { throw new Error('synthetic append failed'); };
  await assert.rejects(f.bind(), code('recall-adapter-unavailable'));
  assert(f.markers.readSync('A'));
  assert.equal((await f.coordinator.capability()).busy, false);
  assert.throws(() => f.coordinator.guardSession({ sessionId: 'A', agent: f.first, operation: 'wake' }), code('recall-retired'));
  const path = join(f.directory, `${createHash('sha256').update('A').digest('hex')}.json`);
  await io.writeFile(path, '{bad');
  assert.throws(() => f.coordinator.guardSession({ sessionId: 'A', agent: f.first, operation: 'resume' }), code('recall-tag-unavailable'));
  const wrong = { schema: RECALL_MARKER_SCHEMA, v: 1, sessionId: 'B', storeId: f.initial.storeId, protocol: RECALL_SELECTOR };
  await io.writeFile(path, JSON.stringify(wrong));
  assert.throws(() => f.markers.readSync('A'), code('recall-tag-unavailable'));
});

test('bind rechecks identity after marker await and after synchronous append listeners', async (t) => {
  for (const change of ['pending-write', 'append-agent', 'append-session', 'append-dispose', 'append-marker', 'append-async']) {
    const f = await fixture(t);
    const entered = deferred(), release = deferred();
    if (change === 'pending-write') {
      const write = f.markers.write;
      f.markers.write = async (...args) => { await write(...args); entered.resolve(); await release.promise; };
    } else {
      f.adapter.markBound = () => {
        if (change === 'append-agent') f.first.live = false;
        if (change === 'append-session') f.first.session = { id: 'A', clean: true };
        if (change === 'append-dispose') f.coordinator.dispose();
        if (change === 'append-marker') {
          const path = join(f.directory, `${createHash('sha256').update('A').digest('hex')}.json`);
          fs.writeFileSync(path, '{bad');
        }
        if (change === 'append-async') return Promise.reject(new Error('invalid async adapter contract'));
      };
    }
    const request = f.bind();
    const rejected = assert.rejects(request);
    if (change === 'pending-write') { await entered.promise; f.agent('A'); release.resolve(); }
    await rejected;
    assert.equal((await f.coordinator.capability()).busy, false);
    assert.throws(() => f.coordinator.guardSession({ sessionId: 'A', agent: f.first, operation: 'wake' }));
  }
});

test('capability rechecks disposal after its asynchronous marker probe', async (t) => {
  const entered = deferred(), release = deferred();
  const f = await fixture(t, { markers: {
    readSync() { return null; }, write() { throw new Error('unused'); },
    async available() { entered.resolve(); await release.promise; return true; },
  } });
  const pending = f.coordinator.capability();
  await entered.promise;
  f.coordinator.dispose();
  release.resolve();
  assert.equal((await pending).supported, false);
});

test('marker ENOENT after observation, symlink, oversize and malformed UTF8 are read errors, not absence', async (t) => {
  const f = await fixture(t);
  const vanished = createRecallMarkers({ directory: f.directory, syncIO: { ...fs,
    lstatSync: () => ({ isFile: () => true }),
    openSync: () => { throw Object.assign(new Error(), { code: 'ENOENT' }); },
  } });
  assert.throws(() => vanished.readSync('A'), code('recall-tag-unavailable'));
  assert.equal(f.markers.readSync('A'), null);
  await io.mkdir(f.directory);
  const path = join(f.directory, `${createHash('sha256').update('A').digest('hex')}.json`);
  await io.symlink(join(f.home, 'absent'), path);
  assert.throws(() => f.markers.readSync('A'), code('recall-tag-unavailable'));
  await io.unlink(path);
  await io.writeFile(path, Buffer.alloc(4097));
  assert.throws(() => f.markers.readSync('A'), code('recall-tag-unavailable'));
  await io.writeFile(path, Buffer.from([0xff]));
  assert.throws(() => f.markers.readSync('A'), code('recall-tag-unavailable'));
});

test('corrupt marker for an unrelated session does not retire another active Agent', async (t) => {
  const f = await fixture(t);
  const a = await f.bind();
  const path = join(f.directory, `${createHash('sha256').update('B').digest('hex')}.json`);
  await io.writeFile(path, '{bad');
  assert.throws(() => f.coordinator.guardSession({ sessionId: 'B', operation: 'resume' }), code('recall-tag-unavailable'));
  assert.equal((await f.coordinator.status(a.bindingId)).status, 'ready');
});

async function httpFixture(t, f) {
  const routes = createCompanionRoutes({ store: f.store, recall: f.coordinator,
    send(res, status, body) { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); },
  });
  const server = createServer((req, res) => { void routes.handle(req, res, new URL(req.url, 'http://test.invalid').pathname); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); });
  return async (path, { method = 'GET', body, contentType = 'application/json' } = {}) => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/dsh-go/v1/companion${path}`, {
      method, headers: { 'content-type': contentType }, ...(body === undefined ? {} : {
        body: typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body),
      }),
    });
    return { status: response.status, body: await response.json() };
  };
}

test('HTTP recall lifecycle uses one store, exact envelope, strict bodies and prefixed non-disclosing errors', async (t) => {
  const f = await fixture(t);
  const request = await httpFixture(t, f);
  const capability = await request('/recall');
  assert.equal(capability.body.supported, true);
  const input = await f.bindInput();
  const bound = await request('/recall/bind', { method: 'POST', body: input });
  assert.equal(bound.status, 200); assert.equal(bound.body.status, 'ready');
  const status = await request(`/recall/bindings/${bound.body.bindingId}`);
  assert.deepEqual(status.body, bound.body);
  const malformed = [
    ['/recall/bind', { method: 'GET' }, 405],
    ['/recall/bind', { method: 'POST', body: input, contentType: 'text/plain' }, 415],
    ['/recall/bind', { method: 'POST', body: '{"v":1,"v":1}' }, 400],
    ['/recall/bind', { method: 'POST', body: Buffer.from([0xff]) }, 400],
    ['/recall/bind', { method: 'POST', body: ' '.repeat(16 * 1024 + 1) }, 413],
    ['/recall/bind', { method: 'POST', body: { ...input, approved: true } }, 400],
    ['/recall/unknown', {}, 404], ['/recall/bindings/not-a-uuid', {}, 400],
  ];
  for (const [path, options, expected] of malformed) {
    const result = await request(path, options);
    assert.equal(result.status, expected);
    assert(result.body.error.code.startsWith('companion/recall-'));
    assert(!JSON.stringify(result.body).includes(f.home));
  }
  const snapshot = await f.baseStore.getSnapshot();
  const mutation = await request('/memories', { method: 'POST', body: { ...version(snapshot), memory: item(9) } });
  assert.equal(mutation.status, 200);
  assert.equal((await request(`/recall/bindings/${bound.body.bindingId}`)).body.status, 'retired');
  assert.equal((await f.store.getRecallContext()).memories[0].id, uuid(9));
  f.state.supported = false;
  const off = await request('/recall/revoke', { method: 'POST', body: {
    v: 1, operationId: randomUUID(), bindingId: bound.body.bindingId, reason: 'user-off',
  } });
  assert.equal(off.body.status, 'retired');
  assert.equal((await request('/recall')).body.supported, false);
});
