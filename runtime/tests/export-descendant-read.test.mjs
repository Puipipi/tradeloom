import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { resolve, join } from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
const prefix = resolve(process.env.DSH_PREFIX);
const load = (name, root = prefix) => import(pathToFileURL(join(root, 'node_modules/@deepseek-ai', name, 'lib/index.js')));
const current = await load('dsh-session-log-export');
const prior = process.env.DSH_BASE_PREFIX ? await load('dsh-session-log-export', resolve(process.env.DSH_BASE_PREFIX)) : undefined;
const require = createRequire(join(prefix, 'node_modules/@deepseek-ai/dsh-session-log-export/package.json'));
const { unzipSync, strFromU8 } = require('fflate');
function fixture(children, n, { failure, real } = {}) {
  const ids = ['root', ...Array.from({ length: children }, (_, i) => `child-${i}`)];
  const image = {
    attachmentId: 'own-image', mediaType: 'image/png', bytes: 4, width: 1, height: 1,
  };
  const file = {
    attachmentId: 'sha256:abcdef', name: '中文🙂.txt', mediaType: 'text/plain', bytes: 4,
  };
  const logs = new Map(ids.map(id => [id, {
    header: { id, version: 4, createdAt: 1, isSeeded: false },
    events: Array.from({ length: n }, (_, i) => ({
      type: 'user/message', seq: i, time: 1,
      data: {
        content: [
          { type: 'text', text: `中文🙂 ${i}` },
          { type: 'image', attachment: image },
          { type: 'file', attachment: file },
        ],
      },
    })),
  }]));
  const counts = { opens: 0, closes: 0, images: 0, files: 0, flush: [], order: [] };
  const persistence = {
    async open(id, ...args) {
      counts.opens++;
      counts.order.push(`open:${id}`);
      const h = real ? await real.open(id, ...args) : {
        header: logs.get(id).header,
        async read() {
          if (id === failure) throw new Error('own-read-failure');
          return { events: logs.get(id).events };
        },
        async close() {},
      };
      return {
        header: h.header,
        read: (...a) => h.read(...a),
        async close() {
          counts.closes++;
          await h.close();
        },
      };
    },
  };
  const deps = {
    sessionPersistence: persistence,
    sessionQuery: {
      async traceSession() {
        return {
          descendants: ids.slice(1).map(id => ({
            session: { header: { id } }, descendants: [],
          })),
        };
      },
    },
    sessions: {
      get: id => ({ id }),
      async flush(s) {
        counts.flush.push(s.id);
        counts.order.push(`flush:${s.id}`);
      },
    },
    attachments: {
      async readImage() {
        counts.images++;
        return { data: Uint8Array.of(1, 2, 3, 4) };
      },
      async *readFileStream() {
        counts.files++;
        yield Uint8Array.of(5, 6, 7, 8);
      },
    },
  };
  return { ids, logs, counts, deps };
}

async function route(api, f) {
  const routes = new Map();
  api.apply({
    get: n => f.deps[n],
    effect: fn => fn(),
    commands: { register: () => () => {} },
    connection: { fetch: { register: r => routes.set(r.path, r) } },
  }, { compressionLevel: 0 });
  const response = await routes.get('/api/session.export').fetch(new Request(
    'http://own-test/api/session.export?sessionId=root&includeDescendants=true',
  ));
  assert.equal(response.status, 200);
  return new Uint8Array(await response.arrayBuffer());
}

for (const [children, n] of [[0, 1], [2, 2], [2, 1000]])
  test(`public export ${children} descendants x ${n} events: same archive, no descendant reparse`, async (t) => {
    t.mock.timers.enable({ apis: ['Date'], now: 1700000000000 });
    const f = fixture(children, n), parse = JSON.parse;
    let eventParses = 0;
    JSON.parse = function (s, ...a) {
      if (typeof s === 'string' && s.startsWith('{"type":"user/message"'))
        eventParses++;
      return Reflect.apply(parse, JSON, [s, ...a]);
    };
    let bytes;
    try {
      bytes = await route(current, f);
    } finally {
      JSON.parse = parse;
    }
    const entries = unzipSync(bytes);
    assert.equal(Object.keys(entries).length, children + 3);
    assert.equal(f.counts.opens, children + 1);
    assert.equal(f.counts.closes, children + 1);
    assert.equal(f.counts.images, 1);
    assert.equal(f.counts.files, 1);
    assert.deepEqual(f.counts.flush, f.ids);
    assert.deepEqual(f.counts.order, f.ids.flatMap(id => [`flush:${id}`, `open:${id}`]));
    for (const id of f.ids) {
      const path = id === 'root' ? current.SESSION_LOG_FILENAME : `subagents/${id}/${current.SESSION_LOG_FILENAME}`;
      assert.equal(strFromU8(entries[path]), current.serializeSessionLog(f.logs.get(id).header, f.logs.get(id).events));
    }
    if (prior) {
      const original = await route(prior, fixture(children, n));
      assert.deepEqual(bytes, original, 'entire ZIP bytes including order match baseline');
    }
    console.log(JSON.stringify({
      children, eventsPerSession: n, eventParses, zipBytes: bytes.length, ...f.counts
    }));
    assert.equal(eventParses, n, 'only compatible root text needs parsing');
  });

test('descendant read failure closes handle and rejects archive without attachment reads', async () => {
  const f = fixture(1, 2, { failure: 'child-0' });
  await assert.rejects(route(current, f), /own-read-failure/);
  assert.equal(f.counts.opens, 2);
  assert.equal(f.counts.closes, 2);
  assert.equal(f.counts.images + f.counts.files, 0);
});

test('public text reader still closes on serialization error', async () => {
  let closed = 0;
  const cycle = {};
  cycle.self = cycle;
  await assert.rejects(current.readSessionLogText({
    async open() {
      return {
        header: {},
        async read() {
          return { events: [cycle] };
        },
        async close() {
          closed++;
        },
      };
    },
  }, 'own'), TypeError);
  assert.equal(closed, 1);
});

test('real JSONL persistence and Session events export root and child through registered route', async (t) => {
  const { Context } = await load('cordis'),
    { Session } = await load('dsh-session'),
    { createUserMessage } = await load('dsh-llm'),
    { apply } = await load('dsh-session-persistence-jsonl');
  const dir = await mkdtemp(join(tmpdir(), 'export-read-'));
  const ctx = new Context();
  t.after(async () => {
    await ctx.fiber.dispose();
    await rm(dir, { recursive: true, force: true });
  });
  await apply(ctx, {
    root: dir, compression: 'none', listConcurrency: 1
  });
  for (const id of ['root', 'child-0']) {
    const s = Session.create(id);
    s.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'real 中文🙂' }],
      source: { kind: 'user', rpcId: `own-${id}` },
    }), { surfaceOp: 'append' });
    const h = await ctx.sessionPersistence.create(s.header);
    try {
      await h.append(s.snapshotEvents());
      await h.flush();
    } finally {
      await h.close();
    }
  }
  const f = fixture(1, 1, { real: ctx.sessionPersistence });
  const bytes = await route(current, f), entries = unzipSync(bytes);
  assert.equal(Object.keys(entries).length, 2);
  assert.equal(f.counts.opens, 2);
  assert.equal(f.counts.closes, 2);
  for (const data of Object.values(entries))
    assert.match(strFromU8(data), /real 中文🙂/);
});

test('declared carriers retain JSON attachment names, last-ref wins and opaque payloads stay opaque', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 1700000000000 });
  function make() {
    const f = fixture(1, 1);
    const old = f.logs.get('child-0').events[0].data.content;
    const blocks = [
      { ...old[1], attachment: { ...old[1].attachment, name: 'last image 中文🙂' } },
      old[2],
      { ...old[2], attachment: { ...old[2].attachment, name: 'second.txt' } },
    ];
    const values = [
      { type: 'tool/result', data: { message: { content: blocks } } },
      { type: 'assistant/message', data: { message: { content: blocks }, stream: [{ type: 'chunk', chunk: { type: 'block-end', block: blocks[0] } }] } },
      { type: 'agent/inbox/spliced', data: { inserted: [{ content: blocks }] } },
      { type: 'compaction/summary', data: { summary: blocks, rawOutput: blocks } },
      { type: 'plugin:own/opaque', data: { content: [{ type: 'image', attachment: { ...blocks[0].attachment, attachmentId: 'must-not-read' } }] } },
    ];
    f.logs.get('child-0').events = values.map((e, i) => ({
      ...e, seq: i, time: 1
    }));
    return f;
  }
  const f = make();
  const read = f.deps.attachments.readImage;
  let imageRef;
  f.deps.attachments.readImage = async (ref) => {
    imageRef = ref;
    return read(ref);
  };
  const bytes = await route(current, f);
  assert.equal(imageRef.name, 'last image 中文🙂');
  assert.equal(f.counts.images, 1);
  assert.equal(f.counts.files, 2);
  const names = Object.keys(unzipSync(bytes));
  assert.ok(names.some(n => n.endsWith('/second.txt')));
  assert.ok(names.some(n => n.endsWith('/中文🙂.txt')));
  if (prior)
    assert.deepEqual(bytes, await route(prior, make()));
});
