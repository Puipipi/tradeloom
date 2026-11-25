import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const base = join(resolve(process.env.DSH_PREFIX), 'node_modules/@deepseek-ai');
const load = name => import(pathToFileURL(join(base, name, 'lib/index.js')));
const { Context } = await load('cordis');
const { SystemPrompt } = await load('dsh-system-prompt');
const { ToolRuntime } = await load('dsh-tools');
const { ToolExecutionPipeline } = await import(pathToFileURL(join(base, 'dsh-tools/lib/pipeline.js')));
const { applyGrepTool } = await load('dsh-tool-fs-search');
const { ItemRetainer, TextRetainer } = await load('dsh-output-retention');
const { LocalSpillStore } = await load('dsh-spill-local');

async function fixture(t, maxMatches = 250, maxLineBytes = 128) {
  const ctx = new Context();
  await ctx.plugin(SystemPrompt, {});
  await ctx.plugin(ToolRuntime, {});
  await ctx.plugin({ inject: ['systemPrompt', 'tools'], apply(ctx) {
    applyGrepTool(ctx, { maxMatches, maxLineBytes, maxMetaBytes: 1e7, timeoutMs: 30000 });
  } });
  t.after(() => ctx.fiber.dispose());
  return { ctx, tool: ctx.tools.get('grep') };
}

function observe(t) {
  const counts = { previews: 0, items: 0 };
  const textPush = TextRetainer.prototype.push, itemPush = ItemRetainer.prototype.push;
  t.mock.method(TextRetainer.prototype, 'push', function (...args) {
    counts.previews++;
    return textPush.apply(this, args);
  });
  t.mock.method(ItemRetainer.prototype, 'push', function (...args) {
    counts.items++;
    return itemPush.apply(this, args);
  });
  return counts;
}

const rows = count => Object.freeze(Array.from({ length: count }, (_, i) => Object.freeze({
  path: 'fixture.txt', lineNumber: i + 1, line: `needle-${i}`,
})));
const body = matches => matches.map(m => `Line ${m.lineNumber}: ${m.line}`).join('\n');

for (const count of [0, 1, 200, 250, 2000, 10000]) {
  test(`registered grep render and metadata retain exact prefix for ${count} matches`, async t => {
    const { tool } = await fixture(t), matches = rows(count), counts = observe(t);
    const snapshot = JSON.stringify(matches), kept = matches.slice(0, 250);
    const rendered = tool.output.render({}, { matches });
    const header = count > 250 ? `Found 250 of ${count} matches` : `Found ${count} ${count === 1 ? 'match' : 'matches'}`;
    const footer = count > 250 ? '\n\n(The complete result could not be saved; narrow pattern, path, or include to see more.)' : '';
    assert.deepEqual(rendered, [{ type: 'text', text: count === 0 ? 'No matches found' : `${header}\n\nfixture.txt\n${body(kept)}${footer}` }]);
    const renderCounts = { ...counts };
    counts.previews = counts.items = 0;
    const meta = tool.output.presentationMeta({}, { matches });
    assert.deepEqual(meta, {
      shape: 'matches', total: count, truncated: count > 250,
      files: count === 0 ? [] : [{ path: 'fixture.txt', matches: kept.map(({ lineNumber, line }) => ({ lineNumber, line })) }],
    });
    assert.equal(JSON.stringify(matches), snapshot);
    t.diagnostic(JSON.stringify({ count, render: renderCounts, metadata: counts }));
    assert.equal(renderCounts.items, count);
    assert.equal(counts.items, count);
    assert.equal(renderCounts.previews, Math.min(count, 250));
    assert.equal(counts.previews, Math.min(count, 250));
  });
}

test('UTF-8 previews preserve file order and canonical values', async t => {
  const { tool } = await fixture(t, 3, 7);
  const matches = Object.freeze([
    Object.freeze({ path: 'b', lineNumber: 4, line: '你好🙂tail' }),
    Object.freeze({ path: 'a', lineNumber: 9, line: 'short' }),
    Object.freeze({ path: 'b', lineNumber: 5, line: '🙂🙂' }),
    Object.freeze({ path: 'c', lineNumber: 1, line: 'discard' }),
  ]);
  const before = JSON.stringify(matches);
  assert.deepEqual(tool.output.presentationMeta({}, { matches }), {
    shape: 'matches', total: 4, truncated: true,
    files: [
      { path: 'b', matches: [{ lineNumber: 4, line: '你好 (line truncated)' }, { lineNumber: 5, line: '🙂 (line truncated)' }] },
      { path: 'a', matches: [{ lineNumber: 9, line: 'short' }] },
    ],
  });
  assert.equal(tool.output.render({}, { matches })[0].text,
    'Found 3 of 4 matches\n\nb\nLine 4: 你好 (line truncated)\nLine 5: 🙂 (line truncated)\n\na\nLine 9: short\n\n(The complete result could not be saved; narrow pattern, path, or include to see more.)');
  assert.equal(JSON.stringify(matches), before);
});

test('actual post-execute spill saves every previewed match while inline stays capped', async t => {
  const { ctx } = await fixture(t, 2, 7);
  const root = await mkdtemp(join(tmpdir(), 'grep-retention-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await ctx.plugin(LocalSpillStore, { root, cleanupPeriodDays: 0 });
  const saveText = ctx.spillStore.saveText.bind(ctx.spillStore);
  let saved;
  t.mock.method(ctx.spillStore, 'saveText', async input => saved = await saveText(input));
  const matches = Object.freeze(Array.from({ length: 8 }, (_, i) => Object.freeze({
    path: 'all.txt', lineNumber: i + 1, line: '你好🙂tail',
  })));
  const counts = observe(t), before = JSON.stringify(matches);
  const definition = ctx.tools.get('grep');
  const pipeline = new ToolExecutionPipeline(ctx, { get: () => ({ ...definition, execute: () => ({ matches }) }) });
  const prepared = await pipeline.prepare({
    name: 'grep', arguments: { pattern: 'needle' }, callId: 'fixture-call',
    signal: new AbortController().signal, agent: { session: { header: { id: 'fixture-session' } } },
  });
  assert.equal(prepared.kind, 'dispatch');
  const result = await pipeline.complete(prepared.exec, await pipeline.dispatch(prepared.exec));
  assert.ok(saved);
  assert.equal(await readFile(saved.locator, 'utf8'),
    `Found 8 matches\n\nall.txt\n${matches.map(m => `Line ${m.lineNumber}: 你好 (line truncated)`).join('\n')}`);
  assert.ok(result.content[0].text.startsWith('Found 2 of 8 matches\n\nall.txt\nLine 1: 你好 (line truncated)\nLine 2: 你好 (line truncated)\n\n('));
  assert.ok(result.content[0].text.includes(saved.locator));
  assert.deepEqual(result.value.matches, matches);
  assert.equal(JSON.stringify(matches), before);
  t.diagnostic(JSON.stringify({ spill: counts }));
  assert.equal(counts.items, 8 * 3);
  assert.equal(counts.previews, 2 + 2 + 8 + 2);
});
