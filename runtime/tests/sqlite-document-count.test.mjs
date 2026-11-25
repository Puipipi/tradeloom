import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';

async function fixture(t, cold = false) {
  const prefix = process.env.DSH_TEST_PREFIX ?? process.env.DSH_PREFIX;
  if (!prefix) { t.skip('set DSH_TEST_PREFIX or DSH_PREFIX to a prepared runtime'); return; }
  const load = name => import(pathToFileURL(join(resolve(prefix), 'node_modules/@deepseek-ai', name, 'lib/index.js')));
  const [{ Context }, { Session, SessionStore }, { SqliteSessionQueryEngine }, { createUserMessage }, jsonl] =
    await Promise.all(['cordis', 'dsh-session', 'dsh-session-query-sqlite', 'dsh-llm', 'dsh-session-persistence-jsonl'].map(load));
  const root = await mkdtemp(join(tmpdir(), 'sqlite-document-count-'));
  const ctx = new Context();
  t.after(async () => { await ctx.fiber.dispose(); await rm(root, { recursive: true, force: true }); });
  await ctx.plugin(SessionStore);
  if (cold) await jsonl.apply(ctx, { root, compression: 'none', listConcurrency: 1 });
  await ctx.plugin(SqliteSessionQueryEngine, { path: ':memory:', openAt: 'first-search' });
  const session = cold ? Session.create('count-fixture') : ctx.sessions.create('count-fixture');
  async function seed(texts) {
    for (const text of texts) session.append('user/message', createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }), { surfaceOp: 'append' });
    if (cold) {
      const handle = await ctx.sessionPersistence.create(session.header);
      try { await handle.append(session.snapshotEvents()); } finally { await handle.close(); }
      assert.equal(ctx.sessions.get(session.id), undefined);
    }
  }
  return { ctx, session, seed };
}
for (const cold of [false, true]) {
  const label = cold ? 'cold JSONL' : 'live';
  test(`${label}: document indexing counts without a full character array`, async t => {
    const f = await fixture(t, cold); if (!f) return;
    const text = 'ordinary 中文🙂 content '.repeat(8192);
    await f.seed([text]);
    let fullCharacterArrays = 0;
    const original = Array.from;
    t.mock.method(Array, 'from', function (value, ...rest) {
      if (typeof value === 'string' && value === text.trim()) fullCharacterArrays++;
      return Reflect.apply(original, this, [value, ...rest]);
    });
    assert.deepEqual(await f.ctx.sessionQuery.searchSessions({ query: 'nomatchfixture' }), { items: [] });
    assert.equal(fullCharacterArrays, 0, 'counting must not materialize a document-sized character array');
  });
  test(`${label}: Unicode document lengths preserve ranking and every page`, async t => {
    const f = await fixture(t, cold); if (!f) return;
    const tails = ['ASCII', '中文', '🙂', 'a🙂b', '\ud800', '\udfff', '\ud800a\udfff', 'e\u0301', '👩‍💻', 'a\0b', 'a\ufdd0b', 'a\ufdd1b'];
    await f.seed(tails.map(tail => `needleexact ${tail}`));
    const expected = f.session.snapshotEvents().map(event => ({ seq: event.seq, time: event.time,
      length: Array.from(event.data.content[0].text.replaceAll('\0', '�').replaceAll('\ufdd0', '�').replaceAll('\ufdd1', '�')).length }))
      .sort((a, b) => a.length - b.length || b.time - a.time || b.seq - a.seq).map(row => row.seq);
    const actual = []; let cursor;
    do {
      const page = await f.ctx.sessionQuery.searchEvents({ sessionId: f.session.id, query: 'needleexact', limit: 3, ...(cursor === undefined ? {} : { cursor }) });
      actual.push(...page.items.map(item => item.seq)); cursor = page.nextCursor;
    } while (cursor !== undefined);
    assert.deepEqual(actual, expected);
    assert.equal(new Set(actual).size, tails.length);
  });
}
