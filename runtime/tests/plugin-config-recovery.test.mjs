// Real bridge handler and temporary profile bytes; the editor models the
// shipped HMR/profile lock and rollback contract. No DSH prefix is executed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { syncBuiltinESMExports } from 'node:module';
import { createPluginConfig } from '../bridge/dsh-go-bridge/lib/plugin-config.js';
import { withSources } from './plugin-config-source-fixture.mjs';

const base = '/dsh-go/v1/plugin-config';
const graph = { uid: 1, refs: {
  1: { type: 'object', dict: { count: 2, fail: 3 } },
  2: { type: 'number' }, 3: { type: 'boolean' },
} };

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function fixture(t, recovery = 'complete') {
  const entries = ['other', 'subject'].map((id) => {
    const config = { count: 0, fail: false };
    const schema = Object.assign((value) => value, { toJSON: () => structuredClone(graph) });
    return { options: { id, name: 'recovery-fixture-plugin', config },
      fiber: { state: 2, runtime: { Config: schema }, config: structuredClone(config) } };
  });
  const held = deferred(), release = deferred(), queued = deferred();
  t.after(() => release.resolve());
  let serial = Promise.resolve();
  const editor = {
    canWrite: () => true,
    entries: () => entries,
    configuration: () => entries.map((entry) => ({ entry, inherited: {}, override: entry.options.config })),
    edit(entry, change) {
      if (entry.options.id === 'subject') queued.resolve();
      const pending = serial.then(async () => {
        if (entry.options.id === 'other') {
          held.resolve();
          await release.promise;
        }
        // The real editor captures rollback state after acquiring its locks.
        const before = readFileSync(editor.documentPath, 'utf8');
        const raw = structuredClone(entry.options.config);
        const next = await change(structuredClone(raw), {});
        entry.options.config = next;
        entry.fiber.config = structuredClone(next);
        save();
        if (next.fail) {
          if (recovery !== 'file') writeFileSync(editor.documentPath, before);
          if (recovery !== 'entry') {
            entry.options.config = raw;
            entry.fiber.config = structuredClone(raw);
          } else {
            entry.fiber.state = 3;
          }
          throw new Error('fixture activation failed');
        }
      });
      serial = pending.catch(() => {});
      return pending;
    },
  };
  const ctx = { get: (name) => name === 'configEditor' ? editor
    : name === 'loader' ? { entries: () => entries } : undefined };
  const source = withSources(ctx, entries);
  editor.documentPath = join(source.root, 'profile.json');
  function save() {
    writeFileSync(editor.documentPath, JSON.stringify(entries.map((entry) => ({
      id: entry.options.id, config: entry.options.config,
    }))) + '\n');
  }
  save();
  const api = createPluginConfig(ctx, {
    send: (response, status, body) => Object.assign(response, { status, body }),
    readBody: async (request) => Buffer.from(JSON.stringify(request.input)),
  });
  async function request(id, method = 'GET', input) {
    const response = {};
    await api.handle({ method, input, headers: { 'content-type': 'application/json' } }, response, `${base}/${id}`);
    return response;
  }
  return { request, held, release, queued, editor, path: editor.documentPath,
    bytes: () => readFileSync(editor.documentPath),
    edit: (id, revision, field, value) => request(id, 'POST', {
      revision, ops: [{ op: 'set', path: [field], value }],
    }),
  };
}

test('queued edit compares recovery with the profile at its own transaction', { timeout: 5000 }, async (t) => {
  const f = fixture(t);
  const otherBefore = await f.request('other'), subjectBefore = await f.request('subject');
  const other = f.edit('other', otherBefore.body.revision, 'count', 1);
  await f.held.promise;
  const subject = f.edit('subject', subjectBefore.body.revision, 'fail', true);
  await f.queued.promise;
  f.release.resolve();
  const [otherResult, subjectResult] = await Promise.all([other, subject]);
  assert.equal(otherResult.status, 200);
  assert.equal(subjectResult.status, 409);
  assert.equal(subjectResult.body.error.code, 'apply-failed');
  assert.deepEqual(JSON.parse(f.bytes()), [
    { id: 'other', config: { count: 1, fail: false } },
    { id: 'subject', config: { count: 0, fail: false } },
  ]);
  const after = await f.request('subject');
  assert.equal(after.status, 200);
  assert.deepEqual(after.body.value, subjectBefore.body.value);
  assert.equal(after.body.revision, subjectBefore.body.revision);
});

test('an isolated failed edit with complete recovery still reports apply-failed', async (t) => {
  const f = fixture(t), before = await f.request('subject'), bytes = f.bytes();
  const result = await f.edit('subject', before.body.revision, 'fail', true);
  assert.equal(result.status, 409);
  assert.equal(result.body.error.code, 'apply-failed');
  assert.deepEqual(f.bytes(), bytes);
});

for (const code of ['ENOSPC', 'EFBIG']) {
  test(`a pre-change ${code} is unavailable and can retry after storage recovers`, async (t) => {
    const f = fixture(t), before = await f.request('subject'), bytes = f.bytes();
    const edit = f.editor.edit;
    // The real editor writes its profile lock before entering change(). These
    // filesystem failures reach the handler without accepting a new config.
    f.editor.edit = async () => { throw Object.assign(new Error('private storage failure'), { code }); };
    const failed = await f.edit('subject', before.body.revision, 'count', 1);
    assert.equal(failed.status, 503);
    assert.equal(failed.body.error.code, 'host-unavailable');
    assert.equal(JSON.stringify(failed).includes('private storage failure'), false);
    assert.deepEqual(f.bytes(), bytes);
    const after = await f.request('subject');
    assert.deepEqual(after.body.value, before.body.value);
    assert.equal(after.body.revision, before.body.revision);

    f.editor.edit = edit;
    const retry = await f.edit('subject', before.body.revision, 'count', 1);
    assert.equal(retry.status, 200);
    assert.equal(retry.body.value.count, 1);
  });
}

test('storage failure after change still verifies incomplete recovery', async (t) => {
  const f = fixture(t, 'file'), before = await f.request('subject'), bytes = f.bytes();
  const edit = f.editor.edit;
  f.editor.edit = async function (...args) {
    try { return await edit.apply(this, args); }
    catch (error) { error.code = 'ENOSPC'; throw error; }
  };
  const result = await f.edit('subject', before.body.revision, 'fail', true);
  assert.equal(result.status, 500);
  assert.equal(result.body.error.code, 'recovery-failed');
  assert.equal(f.bytes().equals(bytes), false);
});

for (const recovery of ['file', 'entry']) {
  test(`incomplete ${recovery} recovery still reports recovery-failed`, async (t) => {
    const f = fixture(t, recovery), before = await f.request('subject');
    const result = await f.edit('subject', before.body.revision, 'fail', true);
    assert.equal(result.status, 500);
    assert.equal(result.body.error.code, 'recovery-failed');
  });
}

test('a failed rollback baseline read remains host-unavailable without changing config', async (t) => {
  const f = fixture(t), before = await f.request('subject'), bytes = f.bytes();
  const original = fs.readFileSync;
  let injected = 0, result;
  fs.readFileSync = function (file, options) {
    // Surrounding editor loads use UTF-8; inject EIO only at the bridge's
    // Buffer snapshot. No files or revisions change during this request.
    if (file === f.path && options === undefined) {
      injected++;
      throw Object.assign(new Error('injected snapshot read failure'), { code: 'EIO' });
    }
    return original.apply(this, arguments);
  };
  syncBuiltinESMExports();
  try {
    result = await f.edit('subject', before.body.revision, 'count', 1);
  } finally {
    fs.readFileSync = original;
    syncBuiltinESMExports();
  }
  assert.equal(injected, 1);
  assert.equal(result.status, 503);
  assert.equal(result.body.error.code, 'host-unavailable');
  assert.deepEqual(f.bytes(), bytes);
  const after = await f.request('subject');
  assert.deepEqual(after.body.value, before.body.value);
  assert.equal(after.body.revision, before.body.revision);
});

for (const recovery of ['complete', 'file']) {
  test(`unreadable ${recovery} recovery cannot confirm the old configuration was restored`, async (t) => {
    const f = fixture(t, recovery), before = await f.request('subject'), bytes = f.bytes();
    const original = fs.readFileSync;
    let verificationReads = 0, injected = 0, result;
    fs.readFileSync = function (file, options) {
      // Only the bridge's second Buffer read: change was accepted and the
      // editor has already attempted rollback. The baseline read stays real.
      if (file === f.path && options === undefined && ++verificationReads === 2) {
        injected++;
        throw Object.assign(new Error('injected recovery verification failure'), { code: 'EIO' });
      }
      return original.apply(this, arguments);
    };
    syncBuiltinESMExports();
    try {
      result = await f.edit('subject', before.body.revision, 'fail', true);
    } finally {
      fs.readFileSync = original;
      syncBuiltinESMExports();
    }
    assert.equal(verificationReads, 2);
    assert.equal(injected, 1);
    assert.equal(result.status, 500);
    assert.equal(result.body.error.code, 'recovery-failed');
    assert.equal(f.bytes().equals(bytes), recovery === 'complete');
    if (recovery === 'complete') {
      // Once readable again, a normal GET and new revision permit an ordinary retry.
      const refreshed = await f.request('subject');
      assert.deepEqual(refreshed.body.value, before.body.value);
      const retry = await f.edit('subject', refreshed.body.revision, 'count', 1);
      assert.equal(retry.status, 200);
      assert.equal(retry.body.value.count, 1);
    }
  });
}
