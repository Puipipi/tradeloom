import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';

const prefix = resolve(process.env.DSH_PREFIX);
const load = name => import(pathToFileURL(join(prefix, 'node_modules/@deepseek-ai', name, 'lib/index.js')));
const { Context } = await load('cordis');
const { SessionStore } = await load('dsh-session');
const { SqliteSessionQueryEngine } = await load('dsh-session-query-sqlite');
const { createUserMessage } = await load('dsh-llm');
const Jsonl = await load('dsh-session-persistence-jsonl');

async function fixture(t) {
  const ctx = new Context();
  t.after(() => ctx.fiber.dispose());
  await ctx.plugin(SessionStore);
  await ctx.plugin(SqliteSessionQueryEngine, { path: ':memory:', openAt: 'first-search' });
  return ctx;
}

function append(session, text) {
  return session.append('user/message', createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: 'user', rpcId: `${session.id}-${session.seq}` },
  }), { surfaceOp: 'append' });
}

function create(ctx, id, text) {
  const session = ctx.sessions.create(id, { meta: { cwd: '/own-workspace' } });
  append(session, text);
  return session;
}

async function countLiveObservation(operation) {
  const originalClone = globalThis.structuredClone;
  const originalStringify = JSON.stringify;
  let eventClones = 0;
  let fingerprintSerializations = 0;
  globalThis.structuredClone = function (...args) {
    if (args[0]?.type === 'user/message' && Number.isInteger(args[0]?.seq)) eventClones++;
    return Reflect.apply(originalClone, this, args);
  };
  JSON.stringify = function (...args) {
    const value = args[0];
    if (value?.header?.id === 'warm' && Array.isArray(value.events)) fingerprintSerializations++;
    return Reflect.apply(originalStringify, this, args);
  };
  try {
    return { result: await operation(), eventClones, fingerprintSerializations };
  } finally {
    globalThis.structuredClone = originalClone;
    JSON.stringify = originalStringify;
  }
}

test('warm public search retains results without recloning or reserializing events', async t => {
  const ctx = await fixture(t);
  const session = create(ctx, 'warm', 'needle zero');
  for (let i = 1; i < 64; i++) append(session, `needle ${i}`);
  const first = await countLiveObservation(() => ctx.sessionQuery.searchSessions({ query: 'needle' }));
  const warm = await countLiveObservation(() => ctx.sessionQuery.searchSessions({ query: 'needle' }));
  append(session, 'appendword needle fresh');
  const changed = await countLiveObservation(() => ctx.sessionQuery.searchSessions({ query: 'appendword' }));
  for (const [phase, observed] of [['first', first], ['warm', warm], ['append', changed]]) {
    t.diagnostic(`${phase}: event-clones=${observed.eventClones} fingerprint-serializations=${observed.fingerprintSerializations}`);
  }
  assert.deepEqual(warm.result, first.result);
  assert.equal(changed.result.items.length, 1);
  assert.equal(changed.result.items[0].header.id, 'warm');
  assert.equal(first.fingerprintSerializations, 1);
  assert.equal(changed.fingerprintSerializations, 1);
  assert.equal(warm.eventClones, 0);
  assert.equal(warm.fingerprintSerializations, 0);
});

test('append invalidates a prior cursor and makes the new text searchable', async t => {
  const ctx = await fixture(t);
  const a = create(ctx, 'append-a', 'needle first');
  create(ctx, 'append-b', 'needle second');
  const page = await ctx.sessionQuery.searchSessions({ query: 'needle', limit: 1 });
  assert.ok(page.nextCursor);
  append(a, 'newtoken needle fresh');
  await assert.rejects(
    ctx.sessionQuery.searchSessions({ query: 'needle', limit: 1, cursor: page.nextCursor }),
    error => error.code === 'SESSION_QUERY_STALE_CURSOR',
  );
  const found = await ctx.sessionQuery.searchSessions({ query: 'newtoken' });
  assert.equal(found.items.length, 1);
  assert.equal(found.items[0].header.id, a.id);
});

test('public detach and new Session with same id cannot reuse prior documents', async t => {
  const ctx = await fixture(t);
  const old = ctx.sessions.prepare('same-id', { meta: { cwd: '/own-workspace' } });
  const detach = ctx.sessions.enter(old);
  ctx.sessions.announce(old);
  append(old, 'oldtoken');
  assert.equal((await ctx.sessionQuery.searchSessions({ query: 'oldtoken' })).items.length, 1);
  detach();
  const next = create(ctx, 'same-id', 'newtoken');
  assert.notEqual(old, next);
  assert.equal((await ctx.sessionQuery.searchSessions({ query: 'oldtoken' })).items.length, 0);
  assert.equal((await ctx.sessionQuery.searchSessions({ query: 'newtoken' })).items.length, 1);
});

test('public caller abort does not poison a later successful observation', async t => {
  const ctx = await fixture(t);
  create(ctx, 'abort', 'needle');
  const controller = new AbortController();
  controller.abort(new Error('own caller stopped'));
  await assert.rejects(ctx.sessionQuery.searchSessions({ query: 'needle' }, { signal: controller.signal }),
    error => error.code === 'SESSION_QUERY_ABORTED');
  assert.equal((await ctx.sessionQuery.searchSessions({ query: 'needle' })).items.length, 1);
});

test('real persistence mount, materialization, and unmount retain fresh availability', async t => {
  const root = await mkdtemp(join(tmpdir(), 'query-observation-persist-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const ctx = await fixture(t);
  const session = create(ctx, 'persist', 'needle');
  const first = await ctx.sessionQuery.searchSessions({ query: 'needle' });
  assert.equal(first.items[0].persisted, false);
  const persistence = ctx.plugin(Jsonl, { root, compression: 'none' });
  await persistence;
  const handle = await ctx.sessionPersistence.create(session.header);
  await handle.flush();
  await handle.close();
  const stored = await ctx.sessionQuery.searchSessions({ query: 'needle' });
  assert.equal(stored.items[0].persisted, true);
  assert.equal(stored.items[0].live, true);
  await persistence.dispose();
  const detached = await ctx.sessionQuery.searchSessions({ query: 'needle' });
  assert.equal(detached.items[0].persisted, false);
  assert.equal(detached.items[0].live, true);
});

test('real image offload remains searchable through persistence and public restore', async t => {
  const root = await mkdtemp(join(tmpdir(), 'query-observation-image-'));
  const ctx = new Context();
  t.after(async () => {
    await ctx.fiber.dispose();
    await rm(root, { recursive: true, force: true });
  });
  const { default: LocalAttachmentStore } = await load('dsh-attachment-local');
  const { imageOffloadProjection } = await import(pathToFileURL(join(prefix,
    'node_modules/@deepseek-ai/dsh-compaction-image-offload/lib/types/projection.js')));
  await ctx.plugin(SessionStore);
  await ctx.plugin(LocalAttachmentStore, { dshHome: root });
  await ctx.plugin(Jsonl, { root: join(root, 'sessions'), compression: 'none' });
  await ctx.plugin(SqliteSessionQueryEngine, { path: ':memory:', openAt: 'first-search' });
  ctx.sessions.registerMessageProjection(imageOffloadProjection);
  const { createRequire } = await import('node:module');
  const sharp = createRequire(import.meta.url)(join(prefix, 'node_modules/sharp'));
  const png = await sharp({ create: {
    width: 2, height: 2, channels: 4, background: { r: 32, g: 64, b: 128, alpha: 1 },
  } }).png().toBuffer();
  const attachment = await ctx.attachments.saveImage({ data: png, mediaType: 'image/png', name: 'own.png' });
  const session = ctx.sessions.prepare('offload', { meta: { cwd: '/own-workspace' } });
  const detach = ctx.sessions.enter(session);
  ctx.sessions.announce(session);
  const user = session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: 'imageword needle' }, { type: 'image', attachment }],
    source: { kind: 'user', rpcId: 'own-image' },
  }), { surfaceOp: 'append' });
  const before = await ctx.sessionQuery.searchEvents({ sessionId: session.id, query: 'imageword' });
  assert.equal(before.items.length, 1);
  const offload = session.append('image/offload', { targets: [{ seq: user.seq, imageIndexes: [0] }] });
  assert.equal(session.deriveMessages()[0].content[1].offloaded, true);
  const warm = await ctx.sessionQuery.searchEvents({ sessionId: session.id, query: 'imageword' });
  assert.deepEqual(warm.items, before.items);
  assert.deepEqual(await ctx.sessionQuery.searchEvents({ sessionId: session.id, query: 'imageword' }), warm);
  // A rejected public append must not change the accepted image decision.
  assert.throws(() => session.append('image/offload', { targets: [{ seq: user.seq, imageIndexes: [0] }] }), /already offloaded/);
  assert.deepEqual(await ctx.sessionQuery.searchEvents({ sessionId: session.id, query: 'imageword' }), warm);
  const handle = await ctx.sessionPersistence.create(session.header);
  await handle.append([user, offload]);
  await handle.flush();
  const saved = await handle.read();
  const header = handle.header;
  const inheritedEventCount = handle.inheritedEventCount;
  await handle.close();
  detach();
  const cold = await ctx.sessionQuery.searchEvents({ sessionId: session.id, query: 'imageword' });
  assert.deepEqual(cold.items, warm.items);
  const restored = ctx.sessions.prepare(session.id, {
    seed: saved.events, meta: structuredClone(header),
    inheritedEventCount, eventState: saved.eventState,
  });
  ctx.sessions.enter(restored);
  ctx.sessions.announce(restored);
  assert.notEqual(restored, session);
  assert.equal(restored.deriveMessages()[0].content[1].offloaded, true);
  assert.deepEqual((await ctx.sessionQuery.searchEvents({ sessionId: session.id, query: 'imageword' })).items, warm.items);
  const actual = await ctx.attachments.readImage(attachment);
  assert.equal(actual.data.length, attachment.bytes);
});
