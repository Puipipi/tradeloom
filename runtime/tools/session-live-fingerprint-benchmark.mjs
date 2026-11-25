// Public Cordis services with own synthetic sessions; warm searches only.
import assert from 'node:assert/strict';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
const prefix = resolve(process.env.DSH_PREFIX);
const load = name => import(pathToFileURL(join(prefix, 'node_modules/@deepseek-ai', name, 'lib/index.js')));
const { Context } = await load('cordis');
const { SessionStore } = await load('dsh-session');
const { SqliteSessionQueryEngine } = await load('dsh-session-query-sqlite');
const { createUserMessage } = await load('dsh-llm');
for (const [count, events] of [[1, 1], [1, 1000], [20, 100], [100, 100]]) {
  const ctx = new Context();
  try {
    await ctx.plugin(SessionStore);
    await ctx.plugin(SqliteSessionQueryEngine, { path: ':memory:', openAt: 'first-search' });
    for (let i = 0; i < count; i++) {
      const session = ctx.sessions.create(`ordinary-${i}`, { meta: { cwd: '/own-workspace' } });
      for (let j = 0; j < events; j++) session.append('user/message', createUserMessage({
        content: [{ type: 'text', text: `needle ordinary 中文😀 ${j}` }],
        source: { kind: 'user', rpcId: `prompt-${i}-${j}` },
      }), { surfaceOp: 'append' });
    }
    const request = { query: 'needle', limit: 20 };
    const first = await ctx.sessionQuery.searchSessions(request);
    assert.equal(first.items.length, Math.min(count, 20));
    for (let i = 0; i < 3; i++) assert.deepEqual(await ctx.sessionQuery.searchSessions(request), first);
    const elapsed = [];
    for (let i = 0; i < 7; i++) {
      const start = performance.now();
      const result = await ctx.sessionQuery.searchSessions(request);
      elapsed.push(performance.now() - start);
      assert.deepEqual(result, first);
    }
    elapsed.sort((a, b) => a-b);
    console.log(JSON.stringify({ count, eventsPerSession: events, totalEvents: count*events, warmup:3, samples:7, medianMs:elapsed[3], minMs:elapsed[0], maxMs:elapsed[6], returned:first.items.length, sampleMs:elapsed }));
  } finally { await ctx.fiber.dispose(); }
}
