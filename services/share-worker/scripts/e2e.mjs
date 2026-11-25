#!/usr/bin/env node
// End-to-end check against a running dshgo-share (local `wrangler dev` or the
// live domain):
//
//   upload a sample ciphertext → fetch it → decrypt with WebCrypto (here and
//   with site/share/viewer.js) → /c/<id> serves the viewer → /share/ is up →
//   / is the home page → delete with the token → the blob is 404.
//
//   node scripts/e2e.mjs https://go.dshtui.com
//   node scripts/e2e.mjs http://127.0.0.1:8787 --admin-key-file <file>   (also checks admin delete)

import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync, gzipSync } from 'node:zlib';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '../../..');

const b64url = (bytes) => Buffer.from(bytes).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

/** A conversation file: the app-written fixture when present, else a tiny one. */
export function sampleFile() {
  const fixture = join(repo, 'app/test/replay/fixtures/timeline.json');
  if (existsSync(fixture)) return JSON.parse(readFileSync(fixture, 'utf8')).file;
  return JSON.stringify({ dshgo: 2, kind: 'conversation', name: 'e2e', code: 'e2e' });
}

export async function seal(text, rawKey) {
  const key = await crypto.subtle.importKey('raw', rawKey, { name: 'AES-GCM' }, false, ['encrypt']);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, gzipSync(Buffer.from(text, 'utf8'))));
  const out = new Uint8Array(16 + ct.length);
  out.set([0x44, 0x53, 0x47, 0x31]);
  out.set(iv, 4);
  out.set(ct, 16);
  return out;
}

export async function open(bytes, rawKey) {
  assert.deepEqual([...bytes.slice(0, 4)], [0x44, 0x53, 0x47, 0x31]);
  const key = await crypto.subtle.importKey('raw', rawKey, { name: 'AES-GCM' }, false, ['decrypt']);
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: bytes.slice(4, 16) }, key, bytes.slice(16));
  return gunzipSync(Buffer.from(plain)).toString('utf8');
}

export async function run(base, { adminKey = null, log = console.log } = {}) {
  base = base.replace(/\/+$/, '');
  const step = (name) => log(`ok - ${name}`);
  const text = sampleFile();
  const rawKey = crypto.getRandomValues(new Uint8Array(32));
  const blob = await seal(text, rawKey);
  const post = (body, ttl = '7d', type = 'application/octet-stream') =>
    fetch(`${base}/api/v1/c?ttl=${ttl}`, { method: 'POST', body, headers: { 'Content-Type': type } });

  const bad = new Uint8Array(blob);
  bad[0] = 0x7b;
  assert.equal((await post(bad)).status, 400, 'bad magic');
  assert.equal((await post(blob, '7d', 'text/html')).status, 415, 'bad content type');
  step('refuses a blob that is not DSG1 or not octet-stream');

  const res = await post(blob);
  assert.equal(res.status, 201, `upload: ${res.status} ${await res.clone().text()}`);
  const { id, deleteToken, expiresAt } = await res.json();
  assert.match(id, /^[0-9A-J][0-9A-Za-z]{9}$/, 'a 7d id');
  assert.ok(deleteToken && expiresAt);
  const days = (Date.parse(expiresAt) - Date.now()) / 86_400_000;
  assert.ok(days > 6.9 && days < 7.1, `expires in ${days} days`);
  step(`upload → ${id} (expires ${expiresAt})`);

  const got = await fetch(`${base}/api/v1/c/${id}`);
  assert.equal(got.status, 200);
  assert.equal(got.headers.get('content-type'), 'application/octet-stream');
  assert.equal(got.headers.get('x-content-type-options'), 'nosniff');
  const bytes = new Uint8Array(await got.arrayBuffer());
  assert.deepEqual(bytes, blob);
  step(`fetch: ${bytes.length} bytes, octet-stream + nosniff`);

  assert.equal(await open(bytes, rawKey), text);
  step('decrypt with node WebCrypto');

  const viewerPath = join(repo, 'site/share/viewer.js');
  if (existsSync(viewerPath)) {
    await import(viewerPath);
    const V = globalThis.DshgoViewer;
    if (V?.decryptHosted) {
      assert.equal(await V.decryptHosted(bytes.buffer, b64url(rawKey)), text);
      const opened = await V.openFile(await V.decryptHosted(bytes.buffer, b64url(rawKey)));
      step(`decrypt + open with the share page's viewer.js: 「${opened.conversation.title}」, ${opened.conversation.entries.length} entries`);
    }
  }

  const page = await fetch(`${base}/c/${id}`);
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-type') ?? '', /text\/html/);
  const csp = page.headers.get('content-security-policy') ?? '';
  assert.match(csp, /default-src 'none'/);
  assert.match(csp, /connect-src 'self'/);
  assert.match(csp, /frame-ancestors 'none'/);
  assert.match(await page.text(), /dv-root/);
  step('/c/<id> serves the viewer with a strict CSP');

  const landing = await fetch(`${base}/share/`);
  assert.equal(landing.status, 200);
  assert.match(await landing.text(), /share\.js/);
  assert.equal((await fetch(`${base}/share/share.js`)).status, 200);
  step('/share/ is up');

  const home = await fetch(`${base}/`);
  assert.equal(home.status, 200);
  const homeCsp = home.headers.get('content-security-policy') ?? '';
  assert.match(homeCsp, /default-src 'none'/);
  assert.match(homeCsp, /frame-ancestors 'none'/);
  assert.doesNotMatch(homeCsp, /unsafe-eval/);
  assert.match(await home.text(), /<title>DSH Go/);
  const shot = await fetch(`${base}/assets/features/01-local-engine.webp`);
  assert.equal(shot.status, 200);
  assert.equal(shot.headers.get('content-type'), 'image/webp');
  assert.equal(shot.headers.get('cache-control'), 'public, max-age=3600');
  await shot.arrayBuffer();
  assert.match((await fetch(`${base}/app.js`)).headers.get('content-type') ?? '', /javascript/);
  step('/ is the home page, with its own CSP; its files are served at their own paths');

  const wrong = await fetch(`${base}/api/v1/c/${id}`, { method: 'DELETE', headers: { Authorization: `Bearer ${b64url(rawKey)}` } });
  assert.equal(wrong.status, 403);
  const del = await fetch(`${base}/api/v1/c/${id}`, { method: 'DELETE', headers: { Authorization: `Bearer ${deleteToken}` } });
  assert.equal(del.status, 204);
  assert.equal((await fetch(`${base}/api/v1/c/${id}`)).status, 404);
  step('delete with the token → 404');

  if (adminKey) {
    const res2 = await post(blob, 'forever');
    assert.equal(res2.status, 201);
    const second = await res2.json();
    assert.equal(second.expiresAt, null);
    const admin = await fetch(`${base}/api/v1/c/${second.id}`, { method: 'DELETE', headers: { 'X-Admin-Key': adminKey } });
    assert.equal(admin.status, 204);
    assert.equal((await fetch(`${base}/api/v1/c/${second.id}`)).status, 404);
    step('admin delete → 404');
  }
  return { id };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const base = process.argv[2];
  if (!base) {
    console.error('usage: node scripts/e2e.mjs <base-url> [--admin-key-file <file>]');
    process.exit(2);
  }
  const at = process.argv.indexOf('--admin-key-file');
  const adminKey = at > 0 ? readFileSync(process.argv[at + 1], 'utf8').trim() : null;
  run(base, { adminKey }).then(
    () => console.log('e2e: all passed'),
    (e) => {
      console.error('e2e: FAILED', e?.message ?? e);
      process.exit(1);
    },
  );
}
