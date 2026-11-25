import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';

let loaded;
async function api() {
  if (!loaded) {
    const prefix = process.env.DSH_TEST_PREFIX ?? process.env.DSH_PREFIX;
    if (!prefix) throw new Error('Set DSH_TEST_PREFIX or DSH_PREFIX to a prepared runtime');
    const load = name => import(pathToFileURL(join(resolve(prefix), 'node_modules/@deepseek-ai', name, 'lib/index.js')));
    loaded = Promise.all(['cordis', 'dsh-session', 'dsh-session-projection', 'dsh-token-meter',
      'dsh-compaction-tool-result-pruner', 'dsh-llm'].map(load))
      .then(parts => Object.assign({}, ...parts));
  }
  return loaded;
}
async function withService(config, run) {
  const a = await api();
  const ctx = new a.Context();
  try {
    await ctx.plugin(a.SessionStore);
    await ctx.plugin(a.SessionProjectionRegistry);
    await ctx.plugin(a.TokenMeter);
    await ctx.plugin(a.ToolResultPruner, config);
    await run(ctx, a);
  } finally {
    await ctx.fiber.dispose();
  }
}

test('public count preserves code points including unpaired UTF16 units', async () => {
  const { codePointLength } = await api();
  for (const text of ['', 'ASCII', '中文', '🙂', 'a🙂b', '\ud800', '\udfff',
    '\ud800a\udfff', '\ud800\ud800\udfff', '\udfff\ud800\udfff', 'e\u0301', '👩‍💻']) {
    assert.equal(codePointLength(text), Array.from(text).length, JSON.stringify(text));
  }
});

test('within-threshold and exact-threshold content remains unchanged', async () => {
  await withService({ thresholdChars: 64, headChars: 4, tailChars: 3 }, ctx => {
    for (const text of ['', '中文🙂', '🙂'.repeat(64)]) {
      const content = [{ type: 'text', text }];
      const before = structuredClone(content);
      assert.equal(ctx.toolResultPruner.pruneContent(content), null);
      assert.deepEqual(content, before);
    }
  });
});

test('rich block order and cross-block head/tail remain exact', async () => {
  await withService({ thresholdChars: 64, headChars: 4, tailChars: 3 }, (ctx, { PRUNE_MARKER }) => {
    const rich = { type: 'reasoning', text: 'non-text block preserved' };
    const content = [
      { type: 'text', text: 'ab🙂' }, rich,
      { type: 'text', text: 'c' + 'x'.repeat(80) },
      { type: 'text', text: '中🙂尾' },
    ];
    const before = structuredClone(content);
    assert.deepEqual(ctx.toolResultPruner.pruneContent(content), [
      { type: 'text', text: 'ab🙂' }, rich,
      { type: 'text', text: 'c' + PRUNE_MARKER },
      { type: 'text', text: '中🙂尾' },
    ]);
    assert.deepEqual(content, before);
  });
});

test('zero retained head and tail still emits the original marker', async () => {
  const { PRUNE_MARKER } = await api();
  await withService({ thresholdChars: Array.from(PRUNE_MARKER).length, headChars: 0, tailChars: 0 }, ctx => {
    assert.deepEqual(ctx.toolResultPruner.pruneContent([{ type: 'text', text: '🙂'.repeat(100) }]),
      [{ type: 'text', text: PRUNE_MARKER }]);
  });
});

test('real Session pruning preserves log, price, stats and converges on second pass', async () => {
  await withService({}, (ctx, { createToolResultMessage, PRUNE_MARKER }) => {
    const session = ctx.sessions.create('own-prune', { meta: { cwd: '/own-workspace' } });
    const text = 'ordinary 中文🙂 '.repeat(1000);
    const message = createToolResultMessage({ callId: 'own-call', content: [{ type: 'text', text }], isError: false });
    const original = session.append('tool/result', { turn: 0, step: 0, message }, { surfaceOp: 'append' });
    const points = Array.from(text);
    const kept = points.slice(0, 4096).join('') + PRUNE_MARKER + points.slice(-1024).join('');
    const charsAfter = Array.from(kept).length;
    assert.deepEqual(ctx.toolResultPruner.pruneSession(session), {
      pruned: [{ originalSeq: 0, replacementSeq: 2, callId: 'own-call', charsBefore: points.length, charsAfter }],
      charsRemoved: points.length - charsAfter,
    });
    assert.deepEqual(session.eventAt(0), original);
    assert.equal(session.eventAt(0).data.message.content[0].text, text);
    assert.deepEqual(session.eventAt(1).data, {
      shadowedRange: { start: 0, end: 0 }, shadowedSeqs: [0],
      shadowedTokenCount: ctx.tokenMeter.estimateMessage(message),
    });
    const replacement = session.eventAt(2);
    assert.equal(replacement.type, 'tool/result');
    assert.deepEqual(replacement.sourceEventSeqs, [0]);
    assert.deepEqual(replacement.data.message.content, [{ type: 'text', text: kept }]);
    const snapshot = session.snapshotEvents();
    assert.deepEqual(ctx.toolResultPruner.pruneSession(session), { pruned: [], charsRemoved: 0 });
    assert.deepEqual(session.snapshotEvents(), snapshot);
  });
});
