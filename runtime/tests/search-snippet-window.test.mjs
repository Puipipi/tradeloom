import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';

async function fixture(t, cap) {
  const prefix = process.env.DSH_TEST_PREFIX ?? process.env.DSH_PREFIX;
  if (!prefix) { t.skip('set DSH_TEST_PREFIX or DSH_PREFIX to a prepared runtime'); return; }
  const load = name => import(pathToFileURL(join(resolve(prefix), 'node_modules/@deepseek-ai', name, 'lib/index.js')));
  const { Context } = await load('cordis');
  const { SessionStore } = await load('dsh-session');
  const { SqliteSessionQueryEngine } = await load('dsh-session-query-sqlite');
  const { createUserMessage } = await load('dsh-llm');
  const ctx = new Context();
  t.after(() => ctx.fiber.dispose());
  await ctx.plugin(SessionStore);
  await ctx.plugin(SqliteSessionQueryEngine, { path: ':memory:', openAt: 'first-search', snippetChars: cap });
  return async (text, query = 'needleexact') => {
    const session = ctx.sessions.create('snippet-control', { meta: { cwd: '/own-workspace', createdAt: 1 } });
    session.append('user/message', createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }), { surfaceOp: 'append' });
    const result = await ctx.sessionQuery.searchEvents({ sessionId: session.id, query, limit: 1 });
    assert.equal(result.items.length, 1);
    const item = result.items[0];
    assert.equal(item.sessionId, session.id);
    assert.equal(item.seq, 0);
    assert.equal(item.type, 'user/message');
    assert.equal(item.surface, 'current');
    assert.ok(Array.from(item.snippet).length <= cap);
    return item.snippet;
  };
}
const texts = [
  'needleexact 中文🙂\t next ' + 'ordinary tail '.repeat(30),
  '前🙂 \n'.repeat(80) + ' needleexact ' + ' middle tail '.repeat(30),
  '前🙂 \n'.repeat(80) + ' needleexact \t\n',
];
const goldens = [
  {
    "cap": 1,
    "position": 0,
    "expected": "…"
  },
  {
    "cap": 1,
    "position": 1,
    "expected": "…"
  },
  {
    "cap": 1,
    "position": 2,
    "expected": "…"
  },
  {
    "cap": 2,
    "position": 0,
    "expected": "n…"
  },
  {
    "cap": 2,
    "position": 1,
    "expected": "…n"
  },
  {
    "cap": 2,
    "position": 2,
    "expected": "…n"
  },
  {
    "cap": 3,
    "position": 0,
    "expected": "ne…"
  },
  {
    "cap": 3,
    "position": 1,
    "expected": "…n…"
  },
  {
    "cap": 3,
    "position": 2,
    "expected": "…n…"
  },
  {
    "cap": 240,
    "position": 0,
    "expected": "needleexact 中文🙂 next ordinary tail ordinary tail ordinary tail ordinary tail ordinary tail ordinary tail ordinary tail ordinary tail ordinary tail ordinary tail ordinary tail ordinary tail ordinary tail ordinary tail ordinary tail ordinary…"
  },
  {
    "cap": 240,
    "position": 1,
    "expected": "…🙂 前🙂 前🙂 前🙂 前🙂 前🙂 前🙂 前🙂 前🙂 前🙂 前🙂 前🙂 前🙂 前🙂 前🙂 前🙂 前🙂 前🙂 前🙂 前🙂 前🙂 前🙂 前🙂 前🙂 前🙂 前🙂 前🙂 needleexact middle tail middle tail middle tail middle tail middle tail middle tail middle tail middle tail middle tail middle tail middle tail middle tail mi…"
  },
  {
    "cap": 240,
    "position": 2,
    "expected": "…前🙂 前🙂 前🙂 前🙂 前🙂 前🙂 前🙂 前🙂 前🙂 前🙂 前🙂 前🙂 前🙂 前🙂 前🙂 前🙂 前🙂 前🙂 前🙂 前🙂 前🙂 前🙂 前🙂 前🙂 前🙂 前🙂 前🙂 前🙂 前🙂 前🙂 前🙂 前🙂 前🙂 前🙂 前🙂 前🙂 前🙂 前🙂 前🙂 前🙂 前🙂 前🙂 前🙂 前🙂 前🙂 前🙂 前🙂 前🙂 前🙂 前🙂 前🙂 前🙂 前🙂 前🙂 前🙂 前🙂 前🙂 前🙂 前🙂 前🙂 前🙂 前🙂 前🙂 前🙂 前🙂 前🙂 前🙂 前🙂 前🙂 前🙂 前🙂 前🙂 前🙂 前🙂 前🙂 前🙂 needleexact"
  }
];
for (const { cap, position, expected } of goldens) {
  test(`original public snippet golden cap ${cap} position ${position}`, async t => {
    const search = await fixture(t, cap);
    if (search) assert.equal(await search(texts[position]), expected);
  });
}
for (const cap of [256, 2 ** 32, Number.MAX_SAFE_INTEGER, Number.MAX_VALUE]) {
  test(`short normalized content with large cap ${cap}`, async t => {
    const search = await fixture(t, cap);
    if (search) assert.equal(await search('  needleexact\t中文🙂\n  tail\u2003  '), 'needleexact 中文🙂 tail');
  });
}
test('cap one returns intact short content before ellipsis branch', async t => {
  const search = await fixture(t, 1);
  if (search) assert.equal(await search('  a  ', 'a'), 'a');
});
test('real trailing whitespace does not add an ellipsis to near-end text', async t => {
  const search = await fixture(t, 12);
  if (search) assert.equal(await search('前🙂 '.repeat(80) + 'needleexact\t\n\u2003'), '… 前🙂 needle…');
});
