import { describe, expect, it, vi } from 'vitest';
import type { Env } from '../src/env';
import { metadata, text, validMeta } from '../src/workshop-common';
import { loadState } from '../src/workshop-state';

const baseMeta = {
  kind: 'pet', id: 'cat', version: '1.0.0', minApp: '1.0.0',
  title: { zh: '小猫', en: 'Cat' }, author: 'Author', license: 'CC0-1.0',
  source: 'https://source.example/cat', sha256: 'a'.repeat(64), size: 4,
  rightsConfirmed: true,
};

describe('shared text nonblankness agrees with Dart VM trim', () => {
  const cases = [
    { name: 'empty', value: '', accepted: false },
    { name: 'space', value: ' ', accepted: false },
    { name: 'no-break space', value: '\u00a0', accepted: false },
    { name: 'next line', value: '\u0085', accepted: false },
    { name: 'mixed blank characters', value: ' \u0085\u00a0', accepted: false },
    { name: 'BOM and next line', value: '\ufeff\u0085', accepted: false },
    { name: 'visible title', value: '示例', accepted: true },
    { name: 'visible text surrounded by next line', value: '\u0085示例\u0085', accepted: true },
  ];
  for (const sample of cases) {
    it(sample.name, () => {
      expect(text(sample.value, 120)).toBe(sample.accepted);
      expect(text(sample.value, 2000)).toBe(sample.accepted);
      expect(validMeta({ ...baseMeta, title: { ...baseMeta.title, zh: sample.value } })).toBe(sample.accepted);
      expect(validMeta({ ...baseMeta, title: { ...baseMeta.title, en: sample.value } })).toBe(sample.accepted);
      expect(validMeta({ ...baseMeta, author: sample.value })).toBe(sample.accepted);
    });
  }

  it('rejects blank metadata while retaining every character of nonblank text', () => {
    expect(() => metadata({ ...baseMeta, author: '\u0085' })).toThrow('bad_metadata');
    const original = '\u0085示例\u0085';
    const value = { ...baseMeta, title: { zh: original, en: original }, author: original };
    expect(metadata(value)).toEqual(value);
  });

  it('rejects an incompatible saved draft without rewriting the stored state', async () => {
    const at = '2026-11-11T00:00:00.000Z';
    const draft = {
      submissionId: 'b'.repeat(32),
      owner: { accountOrigin: 'https://github.com', accountId: 42, username: 'Author' },
      metadata: baseMeta, status: 'draft', createdAt: at, updatedAt: at,
    };
    const state = {
      schema: 1, revision: 1, updatedAt: at, submissions: [draft],
      releases: [], current: [], withdrawn: [], reports: [], audit: [],
    };
    const put = vi.fn();
    let bytes = new TextEncoder().encode(JSON.stringify(state));
    const env = { BUCKET: {
      get: async () => ({ size: bytes.length, httpEtag: '"saved"', body: new Response(bytes).body }),
      put,
    } } as unknown as Env;
    await expect(loadState(env)).resolves.toMatchObject({ state: { submissions: [{ metadata: baseMeta }] } });

    draft.metadata = { ...baseMeta, title: { ...baseMeta.title, zh: '\u0085' } };
    bytes = new TextEncoder().encode(JSON.stringify(state));
    const original = bytes.slice();
    await expect(loadState(env)).rejects.toMatchObject({ code: 'state_invalid', status: 503 });
    expect(put).not.toHaveBeenCalled();
    expect(bytes).toEqual(original);
  });
});
