import test from 'node:test';
import assert from 'node:assert/strict';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const base = join(resolve(process.env.DSH_PREFIX), 'node_modules/@deepseek-ai');
const { TextRetainer } = await import(pathToFileURL(join(base, 'dsh-output-retention/lib/index.js')));
const { previewLine } = await import(pathToFileURL(join(base, 'dsh-tool-fs-search/lib/index.js')));
const complete = text => ({ text, truncated: false, omittedBytes: { kind: 'none' } });

function copies(t) {
  const counter = { bytes: 0, calls: 0 }, set = Uint8Array.prototype.set;
  t.mock.method(Uint8Array.prototype, 'set', function (source, offset) {
    counter.bytes += source.length;
    counter.calls++;
    return set.call(this, source, offset);
  });
  return counter;
}

for (const kind of ['head', 'tail']) for (const size of [1, 2000, 32768]) {
  test(`${kind} complete ${size}-byte text does not copy the assembled bytes again`, t => {
    const input = new Uint8Array(size).fill(65), retainer = new TextRetainer({ kind, maxBytes: size });
    const midpoint = Math.floor(size / 2);
    retainer.push(input.subarray(0, midpoint));
    retainer.push(input.subarray(midpoint));
    const counter = copies(t), result = retainer.finish();
    assert.deepEqual(result, complete('A'.repeat(size)));
    assert.deepEqual(input, new Uint8Array(size).fill(65));
    t.diagnostic(JSON.stringify({ kind, size, ...counter }));
    assert.equal(counter.bytes, size);
  });
}

test('real grep previewLine avoids only the redundant complete-line copy', t => {
  const counter = copies(t);
  assert.equal(previewLine('你好🙂', 64), '你好🙂');
  const completeBytes = counter.bytes;
  counter.bytes = counter.calls = 0;
  assert.equal(previewLine('你好🙂', 7), '你好 (line truncated)');
  t.diagnostic(JSON.stringify({ completeBytes, truncatedBytes: counter.bytes }));
  assert.equal(counter.bytes, 7, 'truncated prefix still copies and trims as before');
  assert.equal(completeBytes, 10);
});

test('both nonempty ends decode together across a UTF-8 codepoint and BOM', t => {
  const cases = [
    { bytes: new TextEncoder().encode('A🙂B'), headBytes: 3, tailBytes: 3, text: 'A🙂B' },
    { bytes: new TextEncoder().encode('A🙂B'), headBytes: 3, tailBytes: 8, text: 'A🙂B', copied: 15 },
    { bytes: new Uint8Array([0xef, 0xbb, 0xbf, 65]), headBytes: 1, tailBytes: 3, text: 'A' },
  ];
  const counter = copies(t);
  for (const entry of cases) {
    const r = new TextRetainer({ kind: 'headTail', headBytes: entry.headBytes, tailBytes: entry.tailBytes });
    for (const byte of entry.bytes) r.push(new Uint8Array([byte]));
    counter.bytes = counter.calls = 0;
    assert.deepEqual(r.finish(), complete(entry.text));
    assert.equal(counter.bytes, entry.copied ?? 2 * entry.bytes.length, 'both real ends still concatenate');
  }
});

test('single ends retain BOM decoding, malformed bytes, and per-chunk surrogate encoding', () => {
  for (const kind of ['head', 'tail']) {
    const bom = new TextRetainer({ kind, maxBytes: 64 });
    for (const byte of [0xef, 0xbb, 0xbf, 65]) bom.push(new Uint8Array([byte]));
    assert.deepEqual(bom.finish(), complete('A'));
    const malformed = new TextRetainer({ kind, maxBytes: 64 });
    malformed.push(new Uint8Array([65, 0xe2, 0x28, 0xa1]));
    assert.deepEqual(malformed.finish(), complete('A�(�'));
    const surrogate = new TextRetainer({ kind, maxBytes: 64 });
    surrogate.push('\ud83d');
    surrogate.push('\ude42');
    assert.deepEqual(surrogate.finish(), complete('��'));
  }
});

test('empty and effectively single-ended headTail retain exact omission and copy work', t => {
  const counter = copies(t);
  for (const strategy of [
    { kind: 'head', maxBytes: 0 }, { kind: 'tail', maxBytes: 0 },
    { kind: 'headTail', headBytes: 0, tailBytes: 0 },
  ]) assert.deepEqual(new TextRetainer(strategy).finish(), complete(''));
  const r = new TextRetainer({ kind: 'headTail', headBytes: 8, tailBytes: 8 });
  r.push('abc');
  counter.bytes = counter.calls = 0;
  assert.deepEqual(r.finish(), complete('abc'));
  t.diagnostic(JSON.stringify({ headTailEmptySuffixBytes: counter.bytes }));
  assert.equal(counter.bytes, 6, 'original suffix accumulation still copies its 3 bytes');
  const zero = new TextRetainer({ kind: 'head', maxBytes: 0 });
  zero.push('x');
  assert.deepEqual(zero.finish(), { text: '', truncated: true, omittedBytes: { kind: 'exact', count: 1 } });
});

test('truncated ends preserve cuts and an offset suffix without extra concatenation', t => {
  const counter = copies(t);
  for (const [strategy, text, omitted, copied] of [
    [{ kind: 'head', maxBytes: 5 }, 'A🙂', 1, 5],
    [{ kind: 'tail', maxBytes: 5 }, '🙂B', 1, 5],
    [{ kind: 'headTail', headBytes: 2, tailBytes: 2 }, 'AB', 4, 4],
  ]) {
    const r = new TextRetainer(strategy);
    r.push('A🙂B');
    counter.bytes = counter.calls = 0;
    assert.deepEqual(r.finish(), { text, truncated: true, omittedBytes: { kind: 'exact', count: omitted } });
    assert.equal(counter.bytes, copied);
  }
});

test('finish is repeatable and later appends do not change earlier strings', () => {
  for (const kind of ['head', 'tail']) {
    const r = new TextRetainer({ kind, maxBytes: 64 });
    r.push('one');
    const first = r.finish();
    assert.deepEqual(r.finish(), first);
    r.push('🙂');
    assert.deepEqual(r.finish(), complete('one🙂'));
    assert.deepEqual(first, complete('one'));
  }
});
