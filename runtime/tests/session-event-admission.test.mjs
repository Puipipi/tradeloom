// Real locked Session, publication, validator and JSONL backend. Synthetic data only.
// DSH_PREFIX=/path/to/patched-prefix node --test runtime/tests/session-event-admission.test.mjs
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';

if (!process.env.DSH_PREFIX) throw new Error('Set DSH_PREFIX to a private locked runtime prefix');
const base = join(resolve(process.env.DSH_PREFIX), 'node_modules/@deepseek-ai');
const load = name => import(pathToFileURL(join(base, name, 'lib/index.js')));
const { Context } = await load('cordis');
const { Session, SessionStore, appendPluginRecord } = await load('dsh-session');
const { validateStoredEvents } = await load('dsh-session-persistence');
const { apply } = await load('dsh-session-persistence-jsonl');
const { createUserMessage } = await load('dsh-llm');

function message(session, text) {
  return session.append('user/message', createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: 'user', rpcId: `synthetic-${text}` },
  }), { surfaceOp: 'append' });
}

for (const marker of [undefined, false, true]) {
  test(`unknown append rejects before publication, including ignorable=${marker}`, async t => {
    const ctx = new Context();
    const store = new SessionStore(ctx);
    const session = store.prepare('synthetic-admission');
    const detach = store.enter(session);
    t.after(async () => { detach(); await ctx.fiber.dispose(); });
    store.announce(session);
    const published = [];
    ctx.on('session/event', (owner, event) => published.push({ owner, event }));
    message(session, 'before');
    const previous = session.snapshotEvents();
    const options = marker === undefined ? undefined : { ignorable: marker };
    assert.throws(
      () => session.append('permissionRules/decision', { synthetic: 'SYNTHETIC_PAYLOAD' }, options),
      error => error instanceof TypeError && /appendPluginRecord/.test(error.message)
        && !error.message.includes('SYNTHETIC_PAYLOAD'),
    );
    assert.equal(session.snapshotEvents(), previous, 'rejected input does not invalidate the snapshot');
    assert.deepEqual(published.map(row => row.event.seq), [0], 'no rejected event is published');
    assert(published.every(row => row.owner === session));
    const next = message(session, 'after');
    assert.equal(next.seq, 1, 'rejection consumes no sequence number');
    assert.deepEqual(published.map(row => row.event.seq), [0, 1]);
    assert.equal(validateStoredEvents(session.header, [...session.snapshotEvents()]).length, 2);
  });
}

test('known core event and surface metadata retain their normal path', () => {
  const session = Session.create('synthetic-known');
  const start = session.append('turn/start', { turnId: 'synthetic-turn' });
  const user = message(session, 'known');
  assert.deepEqual([start.seq, user.seq], [0, 1]);
  assert.equal(user.surfaceOp, 'append');
  assert.equal(Object.hasOwn(user, 'ignorable'), false);
  assert.equal(validateStoredEvents(session.header, [...session.snapshotEvents()]).length, 2);
});

test('plugin record API keeps its explicit ignorable envelope and data snapshot', () => {
  const session = Session.create('synthetic-plugin');
  const data = { audit: ['synthetic'] };
  assert.equal(appendPluginRecord(session, 'plugin:synthetic/audit', data), 0);
  data.audit.push('caller mutation');
  const [event] = session.snapshotEvents();
  assert.equal(event.ignorable, true);
  assert.deepEqual(event.data, { audit: ['synthetic'] });
  assert.equal(Object.hasOwn(event, 'surfaceOp'), false);
  assert.equal(validateStoredEvents(session.header, [...session.snapshotEvents()]).length, 1);
});

test('reader still refuses unknown required history and preserves ignorable history', () => {
  const session = Session.create('synthetic-reader');
  const event = { type: 'future/required', seq: 0, time: 1700000000000, data: { synthetic: true } };
  assert.throws(() => validateStoredEvents(session.header, [event]), {
    name: 'SessionFormatUnsupportedError',
  });
  const marked = { ...event, ignorable: true };
  assert.deepEqual(validateStoredEvents(session.header, [marked]), [marked]);
});

for (const compression of ['none', 'zstd']) {
  test(`${compression}: rejected append cannot poison a real flushed and reopened log`, async t => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-admission-'));
    const ctx = new Context();
    let writer;
    t.after(async () => {
      await writer?.close();
      await ctx.fiber.dispose();
      await rm(root, { recursive: true, force: true });
    });
    await apply(ctx, { root, compression, listConcurrency: 1 });
    const session = Session.create(`synthetic-${compression}`);
    message(session, 'before');
    writer = await ctx.sessionPersistence.create(session.header);
    await writer.append(session.snapshotEvents());
    assert.throws(() => session.append('permissionRules/decision', { synthetic: true }, { ignorable: true }), TypeError);
    appendPluginRecord(session, 'plugin:synthetic/audit', { synthetic: true });
    message(session, 'after');
    await writer.append(session.snapshotEvents().slice(1));
    await writer.flush();
    await writer.close();
    const reader = await ctx.sessionPersistence.open(session.id, 'read');
    try {
      const restored = (await reader.read()).events;
      assert.deepEqual(restored, session.snapshotEvents());
      assert.deepEqual(restored.map(event => event.seq), [0, 1, 2]);
      assert.equal(restored[1].ignorable, true);
    } finally {
      await reader.close();
    }
  });
}
