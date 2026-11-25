import test from 'node:test';
import assert from 'node:assert/strict';
import { submission } from '../scripts/ci-entry.mjs';

const BASE = 'a'.repeat(40), HEAD = 'b'.repeat(40), OTHER = 'c'.repeat(40);
const ROOT = 'd'.repeat(40), DIRECTORY = 'e'.repeat(40), BLOB = 'f'.repeat(40);
const PATH = 'plugins/@scope__plugin.json';
const JSON_TEXT = JSON.stringify({ name: '@scope/plugin', version: '1.0.0' });
const input = {
  repository: { owner: 'maintainer', repo: 'market' },
  headRepository: { owner: 'contributor', repo: 'fork' },
  base: BASE,
  head: HEAD,
};
function fixture() {
  const calls = [];
  const data = {
    comparison: { files: [{ filename: PATH, status: 'modified', sha: BLOB }] },
    commit: { sha: HEAD, tree: { sha: ROOT } },
    root: { truncated: false, tree: [{ path: 'plugins', type: 'tree', mode: '040000', sha: DIRECTORY }] },
    directory: { truncated: false, tree: [{ path: '@scope__plugin.json', type: 'blob', mode: '100644', sha: BLOB }] },
    blob: { sha: BLOB, size: Buffer.byteLength(JSON_TEXT), encoding: 'base64', content: Buffer.from(JSON_TEXT).toString('base64') },
  };
  const result = (name, args, value) => { calls.push({ name, args }); return { data: value }; };
  const github = { rest: {
    pulls: { listFiles: () => { throw new Error('Must not read a moving PR diff'); } },
    repos: { compareCommitsWithBasehead: async (args) => {
      assert.deepEqual(args, { ...input.repository, basehead: `${BASE}...${HEAD}`, per_page: 1, page: 1 });
      return result('compare', args, data.comparison);
    } },
    git: {
      getCommit: async (args) => {
        assert.deepEqual(args, { ...input.headRepository, commit_sha: HEAD });
        return result('commit', args, data.commit);
      },
      getTree: async (args) => {
        assert.deepEqual({ owner: args.owner, repo: args.repo }, input.headRepository);
        assert([ROOT, DIRECTORY].includes(args.tree_sha));
        assert.equal(args.recursive, undefined);
        return result('tree', args, args.tree_sha === ROOT ? data.root : data.directory);
      },
      getBlob: async (args) => {
        assert.deepEqual(args, { ...input.headRepository, file_sha: BLOB });
        return result('blob', args, data.blob);
      },
    },
  } };
  return { github, data, calls };
}

test('submission reads a regular JSON blob from pinned base/head and the head tree', async () => {
  for (const status of ['added', 'modified']) for (const mode of ['100644', '100755']) {
    const f = fixture();
    f.data.comparison.files[0].status = status;
    f.data.directory.tree[0].mode = mode;
    const entry = await submission(f.github, input);
    assert.equal(entry.path, PATH);
    assert.equal(entry.bytes.toString(), JSON_TEXT);
    assert.deepEqual(f.calls.map((call) => call.name), ['compare', 'commit', 'tree', 'tree', 'blob']);
  }
});

test('a live ref moving away and back cannot replace the captured revision or its file list', async () => {
  const f = fixture();
  let liveHead = HEAD;
  const compare = f.github.rest.repos.compareCommitsWithBasehead;
  f.github.rest.repos.compareCommitsWithBasehead = async (args) => {
    liveHead = OTHER;
    return compare(args);
  };
  const tree = f.github.rest.git.getTree;
  f.github.rest.git.getTree = async (args) => { assert.equal(liveHead, OTHER); return tree(args); };
  const blob = f.github.rest.git.getBlob;
  f.github.rest.git.getBlob = async (args) => { liveHead = HEAD; return blob(args); };
  const entry = await submission(f.github, input);
  assert.equal(liveHead, HEAD);
  assert.equal(entry.bytes.toString(), JSON_TEXT);
  assert.equal(f.calls[0].args.basehead, `${BASE}...${HEAD}`);
  assert.equal(f.calls[1].args.commit_sha, HEAD);
});

test('only one added or modified plugin JSON is eligible', async () => {
  for (const files of [
    [], undefined,
    [{ filename: PATH, status: 'removed', sha: BLOB }],
    [{ filename: PATH, status: 'renamed', sha: BLOB }],
    [{ filename: '.github/workflows/check.yml', status: 'modified', sha: BLOB }],
    [{ filename: 'plugins/../policy.json', status: 'modified', sha: BLOB }],
    [{ filename: PATH, status: 'modified', sha: BLOB }, { filename: 'policy.json', status: 'modified', sha: BLOB }],
  ]) {
    const f = fixture();
    f.data.comparison.files = files;
    await assert.rejects(submission(f.github, input), /exactly one/);
    assert.deepEqual(f.calls.map((call) => call.name), ['compare']);
  }
});

test('non-regular tree entries are refused even when their blob contains valid JSON', async () => {
  for (const [type, mode] of [['blob', '120000'], ['commit', '160000'], ['tree', '040000']]) {
    const f = fixture();
    Object.assign(f.data.directory.tree[0], { type, mode });
    await assert.rejects(submission(f.github, input), /regular JSON file/);
    assert(!f.calls.some((call) => call.name === 'blob'));
  }
});

test('head, tree, comparison and blob identities must agree', async () => {
  for (const mutate of [
    (d) => { d.commit.sha = OTHER; },
    (d) => { d.root.truncated = true; },
    (d) => { d.root.tree[0].type = 'blob'; d.root.tree[0].mode = '120000'; },
    (d) => { d.directory.truncated = true; },
    (d) => { d.directory.tree[0].sha = OTHER; },
    (d) => { d.directory.tree[0].path = 'different.json'; },
    (d) => { d.blob.sha = OTHER; },
    (d) => { d.blob.size = 16385; },
    (d) => { d.blob.size++; },
    (d) => { d.blob.encoding = 'utf8'; },
  ]) {
    const f = fixture();
    mutate(f.data);
    await assert.rejects(submission(f.github, input));
  }
});

test('moving refs and malformed JSON are not accepted as immutable submissions', async () => {
  const f = fixture();
  await assert.rejects(submission(f.github, { ...input, base: 'main' }), /immutable/);
  await assert.rejects(submission(f.github, { ...input, head: 'feature' }), /immutable/);
  for (const bytes of [Buffer.from('{'), Buffer.from([0xff, 0x7b, 0x7d])]) {
    f.data.blob.content = bytes.toString('base64');
    f.data.blob.size = bytes.length;
    await assert.rejects(submission(f.github, input));
  }
});

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
const workflow = await readFile(new URL('../.github/workflows/check.yml', import.meta.url), 'utf8');
const entryStep = workflow.split('        id: entry\n')[1].split('\n      - run:')[0];
const entryScript = entryStep.split('          script: |\n')[1].split('\n').map((line) => line.slice(12)).join('\n');
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
async function runStep(f, { head = HEAD, baseFile = null } = {}) {
  const writes = [], statuses = [], outputs = {};
  f.github.rest.pulls.get = async () => ({ data: { head: { sha: head, repo: { owner: { login: 'contributor' }, name: 'fork' } } } });
  f.github.rest.repos.createCommitStatus = async (status) => statuses.push(status);
  const fs = {
    lstat: async () => { if (baseFile) return baseFile; throw Object.assign(new Error('missing'), { code: 'ENOENT' }); },
    writeFile: async (path, bytes) => writes.push({ path, text: bytes.toString() }),
  };
  await new AsyncFunction('github', 'context', 'core', 'require', 'process', entryScript)(
    f.github, { repo: input.repository }, { setOutput: (key, value) => { outputs[key] = value; } },
    (name) => { assert.equal(name, 'node:fs/promises'); return fs; },
    { cwd: () => fileURLToPath(new URL('../', import.meta.url)), env: { PR_NUMBER: '1', CHECKED_HEAD: HEAD, CHECKED_BASE: BASE } },
  );
  return { writes, statuses, outputs };
}
test('workflow passes the captured base/head and writes only the audited regular blob', async () => {
  assert.match(entryStep, /CHECKED_BASE: \$\{\{ steps\.resolve\.outputs\.base \}\}/);
  assert.match(entryStep, /CHECKED_HEAD: \$\{\{ steps\.resolve\.outputs\.head \}\}/);
  const f = fixture();
  const result = await runStep(f);
  assert.deepEqual(result.writes, [{ path: PATH, text: JSON_TEXT }]);
  assert.equal(result.statuses[0].sha, HEAD);
  assert.equal(result.outputs.eligible, 'true');
});
test('workflow refuses changed heads and non-regular base or head files before writing', async () => {
  await assert.rejects(runStep(fixture(), { head: OTHER }), /PR changed/);
  await assert.rejects(runStep(fixture(), { baseFile: { isFile: () => false } }), /regular file in base/);
  const f = fixture();
  f.data.directory.tree[0].mode = '120000';
  await assert.rejects(runStep(f), /regular JSON file at head/);
});
