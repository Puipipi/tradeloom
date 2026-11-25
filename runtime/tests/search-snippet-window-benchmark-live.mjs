import assert from 'node:assert/strict';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
const configuredPrefix = process.env.DSH_TEST_PREFIX ?? process.env.DSH_PREFIX;
if (!configuredPrefix) throw new Error('Set DSH_TEST_PREFIX or DSH_PREFIX to a prepared runtime prefix');
const prefix = resolve(configuredPrefix);
const load = name => import(pathToFileURL(join(prefix, 'node_modules/@deepseek-ai', name, 'lib/index.js')));
const { Context } = await load('cordis');
const { SessionStore } = await load('dsh-session');
const { SqliteSessionQueryEngine } = await load('dsh-session-query-sqlite');
const { createUserMessage } = await load('dsh-llm');
const unit = 'ordinary text 中文🙂 \t\n';
const needle = ' needleexact ';
function filler(bytes) {
  const count = Math.floor(bytes / Buffer.byteLength(unit));
  return unit.repeat(count) + 'a'.repeat(bytes - count * Buffer.byteLength(unit));
}
function document(bytes, position) {
  const rest = bytes - Buffer.byteLength(needle);
  const before = position === 'front' ? 0 : position === 'late' ? rest : Math.floor(rest / 2);
  return filler(before) + needle + filler(rest - before);
}
for (const bytes of [64, 1048576, 8388608]) {
  for (const position of ['front', 'middle', 'late']) {
    const ctx = new Context();
    try {
      await ctx.plugin(SessionStore);
      await ctx.plugin(SqliteSessionQueryEngine, { path: ':memory:', openAt: 'first-search', snippetChars: 240 });
      const session = ctx.sessions.create('snippet', { meta: { cwd: '/own-workspace', createdAt: 1 } });
      const text = document(bytes, position);
      assert.equal(Buffer.byteLength(text), bytes);
      session.append('user/message', createUserMessage({
        content: [{ type: 'text', text }], source: { kind: 'user', rpcId: 'one' },
      }), { surfaceOp: 'append' });
      const request = { query: 'needleexact', limit: 1 };
      const warmStart = performance.now();
      const first = await ctx.sessionQuery.searchSessions(request);
      const warmMs = performance.now() - warmStart;
      assert.equal(first.items.length, 1);
      assert.ok(Array.from(first.items[0].bestMatch.snippet).length <= 240);
      const times = [];
      for (let i = 0; i < 3; i++) {
        const start = performance.now();
        const result = await ctx.sessionQuery.searchSessions(request);
        times.push(performance.now() - start);
        assert.deepEqual(result, first);
      }
      // Public event-search correctness control, outside every timed interval.
      const eventPage = await ctx.sessionQuery.searchEvents({ sessionId: session.id, ...request });
      assert.equal(eventPage.items.length, 1);
      assert.deepEqual(eventPage.items[0], first.items[0].bestMatch);
      console.log(JSON.stringify({ prefix, bytes, position, warmMs, times, result: first, eventPage }));
    } finally {
      await ctx.fiber.dispose();
    }
  }
}
