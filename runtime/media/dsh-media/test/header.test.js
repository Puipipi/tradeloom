import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  parseGenerationMessage, formatGenerationMessage, GenerationHeaderError,
} from '../src/header.js';

// The App-owned v1 golden is the shared authority, not a second edited copy.
// In a repository checkout this path is stable; standalone validation must stage
// the exact supplied App fixture at the same repository-relative location.
const cases = JSON.parse(readFileSync(new URL(
  '../../../../app/test/media/fixtures/header_grammar_v1.json', import.meta.url,
), 'utf8'));
for (const entry of cases.valid) {
  test('shared header valid: ' + entry.id, () => {
    assert.deepEqual(parseGenerationMessage(entry.text), entry.expected);
    const formatted = formatGenerationMessage(entry.expected);
    assert.deepEqual(parseGenerationMessage(formatted), entry.expected);
    if (entry.canonical !== false) assert.equal(formatted, entry.text);
  });
}
for (const entry of cases.plain) {
  test('shared header plain: ' + entry.id, () => {
    assert.equal(parseGenerationMessage(entry.text), null);
  });
}
for (const entry of cases.invalid) {
  test('shared header invalid: ' + entry.id, () => {
    assert.throws(() => parseGenerationMessage(entry.text),
      error => error instanceof GenerationHeaderError && error.code === entry.code);
  });
}
for (const entry of cases.format) {
  test('shared header format: ' + entry.id, () => {
    assert.equal(formatGenerationMessage(entry.value), entry.text);
    assert.deepEqual(parseGenerationMessage(entry.text), entry.value);
  });
}
for (const entry of cases.formatRejects) {
  test('shared header format reject: ' + entry.id, () => {
    assert.throws(() => formatGenerationMessage(entry.value),
      error => error instanceof GenerationHeaderError && error.code === entry.code);
  });
}
// cases.titles belongs to the App title display path, not this plugin parser.
test('unpaired surrogate is rejected before UTF-8 replacement', () => {
  assert.throws(() => parseGenerationMessage('〔生成图像〕\n' + String.fromCharCode(0xd800)),
    { code: 'invalid_message' });
});
test('formatter preserves all 384 optional-field and quality combinations', () => {
  let combinations = 0;
  for (const kind of ['image', 'video']) {
    for (const aspect of [undefined, '1:1', '3:4', '16:9']) {
      for (const count of [undefined, 1, 2, 4]) {
        for (const quality of [undefined, ...(kind === 'image' ? ['low', 'high', '2k'] : ['480p', '720p', '1080p'])]) {
        for (const model of [undefined, { label: '模型' }, { label: 'Model', serviceId: 'office', id: 'a/b:1' }]) {
          const value = {
            kind, prompt: '描述\n下一行',
            ...(aspect ? { aspect } : {}),
            ...(count ? kind === 'image' ? { n: count } : { seconds: count } : {}),
            ...(quality ? { quality } : {}),
            ...(model ? { model } : {}),
          };
          assert.deepEqual(parseGenerationMessage(formatGenerationMessage(value)), value);
          combinations += 1;
        }
      }
    }
  }
  }
  assert.equal(combinations, 384);
});
test('formatter does not silently ignore a field belonging to another kind', () => {
  assert.throws(() => formatGenerationMessage({ kind: 'image', prompt: 'x', seconds: 5 }),
    { code: 'invalid_order' });
  assert.throws(() => formatGenerationMessage({ kind: 'video', prompt: 'x', n: 2 }),
    { code: 'invalid_order' });
  assert.throws(() => formatGenerationMessage({ kind: 'image', prompt: 'x', n: '2' }),
    { code: 'invalid_count' });
  assert.throws(() => formatGenerationMessage({
    kind: 'image', prompt: 'x', model: { label: 'Model', serviceId: 'office' },
  }), { code: 'invalid_model' });
});
test('header syntax is not a provider-capability claim', () => {
  const parsed = parseGenerationMessage('〔生成图像 · 3:4 · 质量=unsupported · Unknown〕\n猫');
  assert.equal(parsed.quality, 'unsupported');
  assert.deepEqual(parsed.model, { label: 'Unknown' });
  // Catalog resolution and the tool's server-side parameter validation must reject it.
});


// §4.6.1 requires the label itself to classify as a model. The shared 119
// examples do not yet exercise these marked-label cases; do not edit that
// App-owned fixture locally to make it appear that it covered them.
for (const label of ['1.5p', '-3:4', '1.5 张', '+1秒', '+1P', '-2K', '-0.5:2', '1:1.5']) {
  test('reserved-shape label cannot be hidden by an identity marker: ' + label, () => {
    for (const kind of ['image', 'video']) {
      const word = kind === 'image' ? '生成图像' : '生成视频';
      assert.throws(() => parseGenerationMessage('〔' + word + ' · ' + label + '〈office/model〉〕\n猫'),
        { code: 'invalid_model' });
      assert.throws(() => formatGenerationMessage({ kind, prompt: '猫',
        model: { label, serviceId: 'office', id: 'model' } }), { code: 'invalid_model' });
    }
  });
}
test('ordinary model labels containing parameter-like fragments still round trip', () => {
  for (const label of ['Image 1.5p', 'aspect -3:4', 'model.p', 'v1.5p']) {
    const value = { kind: 'image', prompt: '猫', model: { label, serviceId: 'office', id: 'model' } };
    assert.deepEqual(parseGenerationMessage(formatGenerationMessage(value)), value);
  }
});
