// Checks the web viewer's non-DOM half against the app:
//   - it opens a conversation file the app wrote (checksum, schema, pictures);
//   - its replay schedule equals the app's (app/test/replay/fixtures/timeline.json,
//     written by app/test/replay/replay_timeline_test.dart);
//   - it decrypts a hosted blob in the agreed format (DSG1 + IV + AES-GCM of gzip);
//   - broken or tampered input fails with the right short message.
//
//   node site/share/test/viewer_test.mjs

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { runInNewContext } from 'node:vm';

const here = dirname(fileURLToPath(import.meta.url));
await import(join(here, '..', 'viewer.js'));
const V = globalThis.DshgoViewer;
const fixture = JSON.parse(readFileSync(join(here, '..', '..', '..', 'app', 'test', 'replay', 'fixtures', 'timeline.json'), 'utf8'));

let passed = 0;
async function test(name, body) {
  await body();
  passed++;
  console.log('ok -', name);
}

await test('opens the file the app wrote', async () => {
  const { conversation, assets } = await V.openFile(fixture.file);
  assert.equal(conversation.title, '修复登录重复提交');
  assert.equal(conversation.model, 'deepseek-v4-pro');
  assert.equal(conversation.entries.length, 14);
  assert.deepEqual(conversation.entries.map((e) => e.type).slice(0, 4), ['turn', 'user', 'reply', 'tool']);
  const ids = Object.keys(assets);
  assert.equal(ids.length, 1);
  assert.ok(assets[ids[0]].startsWith('data:image/png;base64,'));
});

await test('replay schedule matches the app', async () => {
  const { conversation } = await V.openFile(fixture.file);
  const plan = V.timeline(conversation.entries);
  const want = fixture.timeline;
  assert.equal(plan.beats.length, want.beats.length);
  plan.beats.forEach((b, i) => {
    for (const [k, js] of [['start', 'start'], ['think', 'think'], ['end', 'end']]) {
      assert.ok(Math.abs(b[js] - want.beats[i][k]) < 1e-6, `beat ${i} ${k}: ${b[js]} vs ${want.beats[i][k]}`);
    }
  });
  assert.deepEqual(Object.keys(plan.turnEnds), Object.keys(want.turnEnds));
  for (const k of Object.keys(want.turnEnds)) assert.ok(Math.abs(plan.turnEnds[k] - want.turnEnds[k]) < 1e-6);
  assert.ok(Math.abs(plan.duration - want.duration) < 1e-6);
});

await test('a tampered file or picture is refused', async () => {
  const env = JSON.parse(fixture.file);
  const code = env.code;
  const flipped = code.slice(0, 10) + (code[10] === 'A' ? 'B' : 'A') + code.slice(11);
  await assert.rejects(V.openFile(JSON.stringify({ ...env, code: flipped })), /format/);
  const id = Object.keys(env.assets)[0];
  const swapped = { ...env, assets: { [id]: { ...env.assets[id], data: Buffer.from([1, 2, 3]).toString('base64') } } };
  const { assets } = await V.openFile(JSON.stringify(swapped));
  assert.deepEqual(assets, {});
  await assert.rejects(V.openFile('{"hello":1}'), /format/);
});

async function encrypt(text, rawKey) {
  const key = await crypto.subtle.importKey('raw', rawKey, { name: 'AES-GCM' }, false, ['encrypt']);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, gzipSync(Buffer.from(text, 'utf8'))));
  const out = new Uint8Array(4 + 12 + ct.length);
  out.set([0x44, 0x53, 0x47, 0x31]);
  out.set(iv, 4);
  out.set(ct, 16);
  return out;
}

const b64url = (bytes) => Buffer.from(bytes).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

await test('hosted links: fetch, decrypt with the key after #, open', async () => {
  const raw = crypto.getRandomValues(new Uint8Array(32));
  const blob = await encrypt(fixture.file, raw);
  assert.equal(await V.decryptHosted(blob.buffer, b64url(raw)), fixture.file);
  const seen = [];
  const fetchOk = async (url, init) => {
    seen.push([url, init.credentials]);
    return new Response(blob, { status: 200, headers: { 'Content-Type': 'application/octet-stream' } });
  };
  const opened = await V.openHosted('a1B2c3D4e5', b64url(raw), fetchOk);
  assert.deepEqual(seen, [['/api/v1/c/a1B2c3D4e5', 'omit']]);
  assert.equal(opened.conversation.entries.length, 14);
  assert.equal(opened.fileText, fixture.file);
  assert.equal(Object.keys(opened.assets).length, 1);
});

await test('hosted links: wrong key, missing blob, network, bad magic', async () => {
  const raw = crypto.getRandomValues(new Uint8Array(32));
  const blob = await encrypt(fixture.file, raw);
  const other = b64url(crypto.getRandomValues(new Uint8Array(32)));
  await assert.rejects(V.decryptHosted(blob.buffer, other), /key/);
  await assert.rejects(V.decryptHosted(blob.buffer, 'short'), /key|format/);
  const bad = blob.slice();
  bad[0] = 0x58;
  await assert.rejects(V.decryptHosted(bad.buffer, b64url(raw)), /format/);
  await assert.rejects(V.openHosted('a1B2c3D4e5', b64url(raw), async () => new Response('', { status: 404 })), /gone/);
  await assert.rejects(V.openHosted('a1B2c3D4e5', b64url(raw), async () => { throw new TypeError('offline'); }), /network/);
  assert.equal(V.errorText(new Error('gone')), '链接已过期或被删除');
  assert.equal(V.errorText(new Error('key')), '链接不完整');
});

await test('newer files ask for an update', async () => {
  const body = { v: 2, kind: 'conversation', schema: 2, title: 'x', start: '2026-10-24T00:00:00Z', entries: [] };
  await assert.rejects(Promise.resolve().then(() => V.readConversation(body)), /newer/);
  assert.equal(V.errorText(new Error('newer')), '需要更新 dsh-go 才能打开');
});


function conversation(overrides = {}) {
  return { v: 1, kind: 'conversation', schema: 1, title: 'Synthetic', start: '2026-10-24T00:00:00Z', entries: [], ...overrides };
}

await test('bounded conversation strings preserve Unicode pairs and their existing budgets', () => {
  for (const [field, max] of [['title', 120], ['model', 80], ['app', 40]]) {
    const split = 'a'.repeat(max - 2) + '😀x';
    const actual = V.readConversation(conversation({ [field]: '  ' + split + '  ' }))[field];
    assert.equal(actual, 'a'.repeat(max - 2) + '…', field);
    assert.ok(actual.isWellFormed(), field);
    assert.ok(actual.length <= max, field);
    assert.equal(V.readConversation(conversation({ [field]: 'a'.repeat(max - 2) + '😀' }))[field], 'a'.repeat(max - 2) + '😀');
    assert.equal(V.readConversation(conversation({ [field]: 'a'.repeat(max + 1) }))[field], 'a'.repeat(max - 1) + '…');
  }
  for (const [field, max] of [['text', 400000], ['source', 32]]) {
    const actual = V.readConversation(conversation({ entries: [{ type: 'user', [field]: 'a'.repeat(max - 1) + '😀x' }] })).entries[0][field];
    assert.equal(actual, 'a'.repeat(max - 1) + '…', field);
    assert.ok(actual.isWellFormed(), field);
    assert.ok(actual.length <= max + 1, field);
  }
  assert.equal(V.readConversation(conversation({ entries: [{ type: 'turn', end: 'a'.repeat(33) }] })).entries[0].end, 'a'.repeat(32) + '…');
});

await test('export filename keeps complete Unicode pairs after existing cleaning', () => {
  // Expose the actual private function only in this VM, without a product API change.
  const source = readFileSync(join(here, '..', 'viewer.js'), 'utf8');
  const anchor = 'root.DshgoViewer = {';
  assert.equal(source.split(anchor).length, 2);
  const context = {};
  runInNewContext(source.replace(anchor, anchor + '\n fileNameForTest: fileName,'), context);
  const fileName = context.DshgoViewer.fileNameForTest;
  assert.equal(fileName('a'.repeat(39) + '😀x'), 'a'.repeat(39) + '.dshgo');
  assert.equal(fileName('a'.repeat(38) + '😀x'), 'a'.repeat(38) + '😀.dshgo');
  assert.equal(fileName('a'.repeat(41)), 'a'.repeat(40) + '.dshgo');
  assert.equal(fileName(' / ' + 'a'.repeat(39) + '😀x'), 'a'.repeat(39) + '.dshgo');
  assert.equal(fileName(' /:*?"<>| '), '对话.dshgo');
  assert.ok(fileName('a'.repeat(39) + '😀x').isWellFormed());
});

console.log(`${passed} passed`);
