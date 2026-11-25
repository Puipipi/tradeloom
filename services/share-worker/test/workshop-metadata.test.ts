import { expect, it } from 'vitest';
import { metadata, validMeta } from '../src/workshop-common';

const base = {
  kind: 'pet', id: 'sample', version: '1.0.0', minApp: '1.0.0', title: { zh: '示例', en: 'Sample' },
  author: 'Author', license: 'CC0-1.0', source: 'https://source.example/sample',
  sha256: 'a'.repeat(64), size: 1, rightsConfirmed: true,
};

it('omits empty optional display fields while preserving the previous canonical metadata shape', () => {
  expect(metadata(base)).toEqual(base);
  expect(metadata({ ...base, description: '', tags: [] })).toEqual(base);
  expect(JSON.stringify(metadata({ ...base, tags: [], description: '' }))).toBe(JSON.stringify(metadata(base)));
});
it('retains raw description/tag values and tag order without retaining the caller array', () => {
  const tags = ['Cat', 'cat', 'é', 'e\u0301'], description = '  A small companion  ';
  const value = metadata({ ...base, description, tags });
  tags[0] = 'changed later';
  expect(value.description).toBe(description);
  expect(value.tags).toEqual(['Cat', 'cat', 'é', 'e\u0301']);
  expect(metadata({ tags: value.tags, description, ...base })).toEqual(value);
  expect(metadata({ ...base, tags: ['second', 'first'] }).tags).toEqual(['second', 'first']);
});
it('accepts the display code point bounds and rejects nonblank, type, count and exact-duplicate violations', () => {
  const tags = Array.from({ length: 8 }, (_, i) => String(i) + '猫'.repeat(31));
  expect(validMeta({ ...base, description: '🙂'.repeat(512), tags })).toBe(true);
  for (const fields of [
    { description: '🙂'.repeat(513) }, { description: ' \u0085' }, { description: null }, { description: 7 },
    { tags: ['猫'.repeat(33)] }, { tags: Array.from({ length: 9 }, (_, i) => String(i)) }, { tags: ['same', 'same'] },
    { tags: [''] }, { tags: [' \u0085'] }, { tags: [7] }, { tags: null }, { tags: 'tag' },
  ]) {
    expect(validMeta({ ...base, ...fields })).toBe(false);
    expect(() => metadata({ ...base, ...fields })).toThrowError('bad_metadata');
  }
});
