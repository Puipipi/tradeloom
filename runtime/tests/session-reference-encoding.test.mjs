import { test } from 'node:test';
import assert from 'node:assert/strict';
import { load, fixture, encodedDuring, preparedData } from '../tools/session-reference-fixture.mjs';

const api = await load(process.env.DSH_PREFIX);
function setup(t, texts, budget = 4096) {
  const f = fixture(api, texts, budget);
  t.after(() => f.ctx.fiber.dispose());
  return f;
}
function jsonBytes(value) {
  return Buffer.byteLength(JSON.stringify(value).replaceAll('<', '\\u003c'), 'utf8');
}

for (const [name, text, repeated, copies] of [
  ['ASCII', 'a'.repeat(262144), 'a'.repeat(3916), 2],
  ['BMP', '数'.repeat(87381), '数'.repeat(1305), 1],
  ['supplementary', '😀'.repeat(65536), '😀'.repeat(979), 1],
]) {
  test(`real reference prepare encodes ${name} once per truncation search, preserving exact output`, async t => {
    const f = setup(t, [text]);
    const sample = await encodedDuring(text, f.prepare);
    const data = preparedData(sample.result);
    assert.deepEqual(data, [{
      sessionId: 'reference-source', label: 'source', cwd: '/reference-fixture', capturedThroughSeq: 0,
      conversation: [{ role: 'user', text: `${repeated}\n[… omitted 258228 UTF-8 bytes …]` }],
    }]);
    assert.ok(jsonBytes(data[0]) <= 4096);
    assert.deepEqual(sample.result.additionalContext.source.references, [{
      sessionId: 'reference-source', label: 'source', capturedFormatVersion: 4, capturedThroughSeq: 0,
      compacted: false, originalMessages: 1, retainedMessages: 1, omittedMessages: 0,
      omittedBytes: 258228, truncated: true, inputIndex: 0,
    }]);
    assert.equal((await f.query.readSurface(f.source.id)).events[0].data.content[0].text, text);
    t.diagnostic(JSON.stringify({ name, calls: sample.calls, encodedBytes: sample.bytes }));
    // ASCII takes two outer searches because the notice's newline expands in JSON.
    // The optimization only shares bytes within each existing binary search.
    assert.equal(sample.calls, copies);
    assert.equal(sample.bytes, Buffer.byteLength(text) * copies);
  });
}

test('BOM, lone surrogates and multibyte cut points keep original text and omission facts', async t => {
  const cases = [
    [`\ufeff\ud800X${'中😀'.repeat(4000)}Y\udc00`, `\ufffdX${'中😀'.repeat(59)}😀${'中😀'.repeat(59)}Y\ufffd\n[… omitted 27170 UTF-8 bytes …]`, 27170, 1017],
    [`\ufeff${'a'.repeat(16384)}\ud800`, `${'a'.repeat(840)}\ufffd\n[… omitted 15544 UTF-8 bytes …]`, 15544, 1022],
  ];
  for (const [text, expected, omitted, bytes] of cases) {
    const f = setup(t, [text], 1024);
    const result = await f.prepare();
    const data = preparedData(result)[0];
    assert.equal(data.conversation[0].text, expected);
    assert.equal(jsonBytes(data), bytes);
    assert.equal(result.additionalContext.source.references[0].omittedBytes, omitted);
    assert.equal((await f.query.readSurface(f.source.id)).events[0].data.content[0].text, text);
  }
});

test('short previews and whole-message eviction perform no truncation encoding', async t => {
  const first = 'drop'.repeat(4096);
  const second = 'old'.repeat(4096);
  const f = setup(t, [first, second, 'small'], 512);
  const sample = await encodedDuring(first, f.prepare);
  const data = preparedData(sample.result)[0];
  assert.deepEqual(data.conversation, [{ role: 'user', text: 'small' }]);
  const stats = sample.result.additionalContext.source.references[0];
  assert.equal(stats.omittedMessages, 2);
  assert.equal(stats.omittedBytes, Buffer.byteLength(first) + Buffer.byteLength(second));
  assert.equal(sample.calls, 0);
  const intact = setup(t, ['short 😀'], 512);
  const plain = await encodedDuring('short 😀', intact.prepare);
  assert.equal(plain.calls, 0);
  assert.equal(plain.result.additionalContext.source.references[0].truncated, false);
  assert.deepEqual(preparedData(plain.result)[0].conversation, [{ role: 'user', text: 'short 😀' }]);
});

test('escaped source and notice-too-small behavior are unchanged', async t => {
  const text = '\"<\n'.repeat(4000);
  const f = setup(t, [text], 4096);
  const result = await f.prepare();
  assert.deepEqual(preparedData(result)[0].conversation, [{ role: 'user', text: '' }]);
  const stats = result.additionalContext.source.references[0];
  assert.equal(stats.omittedBytes, 12000);
  assert.equal(stats.truncated, true);
  assert.equal((await f.query.readSurface(f.source.id)).events[0].data.content[0].text, text);
});

test('fixed metadata exceeding a one-byte budget still rejects without publishing context', async t => {
  const f = setup(t, ['a'.repeat(1000)], 1);
  await assert.rejects(f.prepare(), error => error instanceof api.SessionReferenceError && error.code === 'SESSION_REFERENCE_BUDGET_EXCEEDED');
  assert.deepEqual((await f.query.readSurface(f.target.id)).events, []);
});
