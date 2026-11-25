import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { load, fixture, serializedDuring, preparedData } from '../tools/reference-drop-fixture.mjs';

const api = await load(process.env.DSH_PREFIX);
const rows = size => Array.from({ length: size }, (_, i) => `message-${String(i).padStart(4, '0')}:` + 'x'.repeat(256));
const jsonBytes = value => Buffer.byteLength(JSON.stringify(value).replaceAll('<', '\\u003c'), 'utf8');
function setup(t, texts, budget = 4096) {
  const f = fixture(api, texts, budget);
  t.after(() => f.ctx.fiber.dispose());
  return f;
}

for (const size of [1, 20, 200, 1000]) {
  test(`real prepare drops old messages from ${size} entries without reserializing the whole preview`, async t => {
    const texts = rows(size), f = setup(t, texts);
    const { result, counts } = await serializedDuring(f.prepare);
    const data = preparedData(result)[0], kept = Math.min(size, 13), dropped = size - kept;
    assert.deepEqual(data.conversation, texts.slice(-kept).map(text => ({ role: 'user', text })));
    assert.ok(jsonBytes(data) <= 4096);
    assert.equal(result.additionalContext.source.references[0].omittedMessages, dropped);
    assert.equal(result.additionalContext.source.references[0].omittedBytes, dropped * 269);
    assert.equal(data.capturedThroughSeq, size - 1);
    assert.deepEqual((await f.query.readSurface(f.source.id)).events.map(e => e.data.content[0].text), texts);
    t.diagnostic(JSON.stringify({ size, kept, dropped, ...counts }));
    assert.equal(counts.fullCalls, 1);
    assert.equal(counts.itemCalls, dropped);
  });
}

test('exact budget and one byte less keep correct suffix through JSON escaping and UTF-8', async t => {
  const texts = Array.from({ length: 8 }, (_, i) => `row-${i}:<\"\\\n\ufeff\ud800中😀${'z'.repeat(20)}`);
  const whole = setup(t, texts, 65536);
  const full = preparedData(await whole.prepare())[0];
  const expected = { ...full, conversation: full.conversation.slice(-2) };
  const cap = jsonBytes(expected);
  const exact = setup(t, texts, cap);
  assert.deepEqual(preparedData(await exact.prepare())[0], expected);
  const below = setup(t, texts, cap - 1);
  assert.deepEqual(preparedData(await below.prepare())[0].conversation, full.conversation.slice(-1));
});

test('checkpoints and newest message survive eviction; protected long entries still use original truncation', async t => {
  const texts = [{ checkpoint: true, text: 'keep checkpoint' }, 'old A'.repeat(40), 'old B'.repeat(40), 'newest'];
  const f = setup(t, texts, 256);
  const result = await f.prepare(), data = preparedData(result)[0];
  assert.deepEqual(data.conversation, [{ role: 'user', text: 'keep checkpoint' }, { role: 'user', text: 'newest' }]);
  const stats = result.additionalContext.source.references[0];
  assert.equal(stats.compacted, true);
  assert.equal(stats.omittedMessages, 2);
  assert.equal(stats.omittedBytes, 400);
  const protectedOnly = setup(t, [{ checkpoint: true, text: 'C'.repeat(1000) }, 'N'.repeat(1000)], 512);
  const short = await protectedOnly.prepare(), preview = preparedData(short)[0];
  assert.equal(preview.conversation.length, 2);
  assert.ok(jsonBytes(preview) <= 512);
  assert.equal(short.additionalContext.source.references[0].omittedMessages, 0);
  assert.equal(short.additionalContext.source.references[0].compacted, true);
  assert.equal(short.additionalContext.source.references[0].truncated, true);
});

test('actual full transcript spill retains every source message after inline eviction', async t => {
  const texts = Array.from({ length: 16 }, (_, i) => `full-${i}:` + '中😀'.repeat(30));
  const f = setup(t, texts, 512);
  const root = await mkdtemp(join(tmpdir(), 'reference-drop-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await f.ctx.plugin(api.LocalSpillStore, { root, cleanupPeriodDays: 0 });
  const save = f.ctx.spillStore.saveText.bind(f.ctx.spillStore);
  let saved;
  t.mock.method(f.ctx.spillStore, 'saveText', async request => saved = await save(request));
  const result = await f.prepare();
  assert.ok(saved);
  const transcript = await readFile(saved.locator, 'utf8');
  const decoded = transcript.split(/^### Message \d+: user\n/m).slice(1).map(section =>
    section.split('\n').filter(line => line.startsWith('"')).map(line => JSON.parse(line)).join(''));
  assert.deepEqual(decoded, texts);
  assert.ok(preparedData(result)[0].conversation.length < texts.length);
  assert.ok(result.additionalContext.content[0].text.includes(saved.locator));
  assert.deepEqual((await f.query.readSurface(f.source.id)).events.map(e => e.data.content[0].text), texts);
});

test('empty conversation and fixed metadata too large preserve their original outcomes', async t => {
  const empty = setup(t, [], 4096);
  const result = await empty.prepare();
  assert.deepEqual(preparedData(result)[0].conversation, []);
  assert.equal(result.additionalContext.source.references[0].truncated, false);
  const tiny = setup(t, ['small'], 1);
  await assert.rejects(tiny.prepare(), e => e instanceof api.SessionReferenceError && e.code === 'SESSION_REFERENCE_BUDGET_EXCEEDED');
});
