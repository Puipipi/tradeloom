import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, mkdir, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
const { WorkspaceFileSearch } = await import(pathToFileURL(join(resolve(process.env.DSH_PREFIX), 'node_modules/@deepseek-ai/dsh-file-reference-local/lib/index.js')));
const signal = new AbortController().signal;
async function fixture(t, paths) {
  const root = await mkdtemp(join(tmpdir(), 'file-query-cost-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (let offset = 0; offset < paths.length; offset += 100) {
    await Promise.all(paths.slice(offset, offset + 100).map(path => writeFile(join(root, path), '')));
  }
  const search = new WorkspaceFileSearch(root, { maxResults: 20, maxEntries: 50000, excludedDirectories: ['node_modules'] });
  t.after(() => search.dispose());
  return { root, search };
}
async function countLower(search, query) {
  const original = String.prototype.toLowerCase;
  let queryCalls = 0;
  String.prototype.toLowerCase = function() {
    if (String(this) === query) queryCalls++;
    return original.call(this);
  };
  try { return { result: await search.list(query, signal), count: () => queryCalls }; }
  finally { String.prototype.toLowerCase = original; }
}
for (const size of [200, 2000, 10000]) {
  test(`query normalization occurs once for ${size} real indexed files`, async t => {
    const paths = Array.from({ length: size }, (_, i) => `needle-${String(i).padStart(5, '0')}.txt`);
    const { search } = await fixture(t, paths);
    await search.list('warm-index', signal);
    const { result, count } = await countLower(search, 'NEEDLE');
    assert.deepEqual(result, paths.slice(0, 20).map(path => ({ path, kind: 'file' })));
    t.diagnostic(`files=${size} query-lowercase=${count()} returned=${result.length}`);
    assert.equal(count(), 1);
  });
}

test('empty directory listing keeps zero lowercasing, directory priority and lexical order', async t => {
  const { root, search } = await fixture(t, ['b.txt', 'a.txt', '.hidden.txt']);
  await mkdir(join(root, 'z-dir'));
  await mkdir(join(root, 'node_modules'));
  const { result, count } = await countLower(search, '');
  assert.equal(count(), 0);
  assert.deepEqual(result, [{ path: 'z-dir', kind: 'directory' }, { path: 'a.txt', kind: 'file' }, { path: 'b.txt', kind: 'file' }]);
});

test('Unicode case mapping, hidden paths, no matches and directory fragments keep results', async t => {
  const { root, search } = await fixture(t, ['Ångström.txt', 'İstanbul.txt', 'Σigma.txt', 'ß.txt', '.hidden.txt']);
  await mkdir(join(root, 'folder'));
  await writeFile(join(root, 'folder', 'Needle.txt'), '');
  for (const [query, expected] of [['ÅNG', 'Ångström.txt'], ['İS', 'İstanbul.txt'], ['ΣI', 'Σigma.txt'], ['.H', '.hidden.txt'], ['folder/NEE', 'folder/Needle.txt']]) {
    assert.deepEqual(await search.list(query, signal), [{ path: expected, kind: 'file' }]);
  }
  assert.deepEqual(await search.list('SS', signal), []);
  assert.deepEqual(await search.list('not-present', signal), []);
});

test('an empty index remains empty with at most one query normalization', async t => {
  const { search } = await fixture(t, []);
  const { result, count } = await countLower(search, 'NOPE');
  assert.deepEqual(result, []);
  t.diagnostic(`empty-index query-lowercase=${count()}`);
  assert.ok(count() <= 1);
});
