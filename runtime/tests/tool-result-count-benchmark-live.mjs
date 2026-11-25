// Manual benchmark, not a timing assertion: DSH_PREFIX=/absolute/prefix node this-file.mjs
import assert from 'node:assert/strict';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';

const prefixValue = process.env.DSH_TEST_PREFIX ?? process.env.DSH_PREFIX;
if (!prefixValue) throw new Error('Set DSH_TEST_PREFIX or DSH_PREFIX to a prepared runtime');
const prefix = resolve(prefixValue);
const load = name => import(pathToFileURL(join(prefix, 'node_modules/@deepseek-ai', name, 'lib/index.js')));
const { Context } = await load('cordis');
const { SessionStore } = await load('dsh-session');
const { SessionProjectionRegistry } = await load('dsh-session-projection');
const { TokenMeter } = await load('dsh-token-meter');
const { ToolResultPruner } = await load('dsh-compaction-tool-result-pruner');
const { createToolResultMessage } = await load('dsh-llm');

const cases = [
  { label: '1MiB', budget: 1024 * 1024, unit: 'ordinary 中文🙂 text\n' },
  { label: '8MiB', budget: 8 * 1024 * 1024, unit: 'ordinary 中文🙂 text\n' },
  { label: 'ASCII64KiB', budget: 64 * 1024, unit: 'ordinary text ' },
  { label: 'emoji64KiB', budget: 64 * 1024, unit: '🙂' },
];
const ctx = new Context();
try {
  await ctx.plugin(SessionStore);
  await ctx.plugin(SessionProjectionRegistry);
  await ctx.plugin(TokenMeter);
  await ctx.plugin(ToolResultPruner);
  for (const { label, budget, unit } of cases) {
    const text = unit.repeat(Math.floor(budget / Buffer.byteLength(unit)));
    const samplesMs = [];
    let expected;
    for (let index = 0; index < 4; index++) {
      const session = ctx.sessions.create(`sample-${label}-${index}`, { meta: { cwd: '/own-workspace' } });
      const message = createToolResultMessage({
        callId: 'own-call', content: [{ type: 'text', text }], isError: false,
      });
      session.append('tool/result', { turn: 0, step: 0, message }, { surfaceOp: 'append' });
      const start = performance.now();
      const result = ctx.toolResultPruner.pruneSession(session);
      const elapsed = performance.now() - start;
      assert.equal(result.pruned.length, 1);
      assert.equal(session.eventAt(1).type, 'compaction/prune');
      const current = session.deriveEventMessage(session.eventAt(result.pruned[0].replacementSeq));
      const stable = { result, content: current.content, shadowPrice: session.eventAt(1).data };
      if (expected) assert.deepEqual(stable, expected);
      else expected = stable;
      assert.equal(session.eventAt(0).data.message.content[0].text, text);
      if (index > 0) samplesMs.push(elapsed);
    }
    const sorted = [...samplesMs].sort((a, b) => a - b);
    console.log(JSON.stringify({
      label, bytes: Buffer.byteLength(text), warmup: 1, samplesMs,
      medianMs: sorted[1], result: expected,
    }));
  }
} finally {
  await ctx.fiber.dispose();
}
