#!/usr/bin/env node
// Local smoke test: starts `wrangler dev` (workerd with local R2, KV and rate
// limits; nothing touches Cloudflare) and runs scripts/e2e.mjs against it.
//
//   npm run smoke

import { spawn, spawnSync } from 'node:child_process';
import { createHash, createHmac } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { run } from './e2e.mjs';

const worker = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const port = 8700 + Math.floor(Math.random() * 200);
const state = mkdtempSync(join(process.env.SMOKE_TMP ?? tmpdir(), 'dshgo-share-'));
const adminKey = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64url');
const keyFile = join(state, 'admin-key');
writeFileSync(keyFile, adminKey, { mode: 0o600 });

// A tiny beta build in local R2, one access key and one channel token in local KV.
const betaSecret = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64url');
const accessKey = 'dsh-sm9ke234';
const channelToken = 'dshc_' + Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64url');
const apk = Uint8Array.from({ length: 300_000 }, (_, i) => (i * 31 + 7) & 0xff);
const apkSha = createHash('sha256').update(apk).digest('hex');
const APK_PATH = '/beta/9.9.9/dsh-go-9.9.9-arm64.apk';
const release = {
  schema: 1, version: '9.9.9+1', tag: 'v9.9.9', notes: '- smoke', notesByLocale: { zh: '- 冒烟', en: '- smoke' },
  assets: { arm64: { name: 'dsh-go-9.9.9-arm64.apk', size: apk.length, sha256: apkSha, url: `http://127.0.0.1:${port}${APK_PATH}` } },
};
writeFileSync(join(state, 'app.apk'), apk);
writeFileSync(join(state, 'update.json'), JSON.stringify(release));
const local = { cwd: worker, env: { ...process.env, CLOUDFLARE_API_TOKEN: '', WRANGLER_SEND_METRICS: 'false' }, encoding: 'utf8' };
function seed(args) {
  const res = spawnSync('npx', ['wrangler', ...args, '--local', '--persist-to', join(state, 'persist')], local);
  if (res.status !== 0) {
    console.error(`smoke: seeding failed: ${args.slice(0, 3).join(' ')}\n${res.stderr}`);
    process.exit(1);
  }
}
for (const [key, file] of [['beta/9.9.9/dsh-go-9.9.9-arm64.apk', 'app.apk'], ['beta/update.json', 'update.json'], ['releases/update.json', 'update.json']]) {
  seed(['r2', 'object', 'put', `dshgo-share/${key}`, '--file', join(state, file)]);
}
const keyId = createHmac('sha256', betaSecret).update(`key\n${accessKey}`).digest('hex');
const chanId = createHash('sha256').update(channelToken).digest('hex');
seed(['kv', 'key', 'put', `beta:key:${keyId}`, JSON.stringify({ label: 'smoke' }), '--binding', 'QUOTA']);
seed(['kv', 'key', 'put', `beta:chan:${chanId}`, JSON.stringify({ label: 'smoke-app' }), '--binding', 'QUOTA']);

const dev = spawn(
  'npx',
  ['wrangler', 'dev', '--local', '--ip', '127.0.0.1', '--port', String(port), '--persist-to', join(state, 'persist'),
    '--var', `ADMIN_KEY:${adminKey}`, '--var', `BETA_SECRET:${betaSecret}`, '--var', `USAGE_SECRET:${betaSecret}x`,
    // The beta checks below are for the access-key mode (public mode: test/download.test.ts).
    '--var', 'DOWNLOAD_ACCESS:key', '--show-interactive-dev-session=false'],
  { cwd: worker, env: { ...process.env, CLOUDFLARE_API_TOKEN: '', WRANGLER_SEND_METRICS: 'false' }, stdio: ['ignore', 'pipe', 'pipe'] },
);
let output = '';
dev.stdout.on('data', (d) => (output += d));
dev.stderr.on('data', (d) => (output += d));

function stop(code) {
  dev.kill('SIGTERM');
  rmSync(state, { recursive: true, force: true });
  process.exit(code);
}

const base = `http://127.0.0.1:${port}`;
const deadline = Date.now() + 90_000;
for (;;) {
  if (dev.exitCode !== null || Date.now() > deadline) {
    console.error('smoke: wrangler dev did not start\n' + output);
    stop(1);
  }
  try {
    const res = await fetch(`${base}/robots.txt`);
    if (res.ok) break;
  } catch {}
  await new Promise((r) => setTimeout(r, 500));
}

try {
  await run(base, { adminKey });
  // The local rate limiter: 5 uploads a minute from one client.
  const blob = new Uint8Array(64);
  blob.set([0x44, 0x53, 0x47, 0x31]);
  const statuses = [];
  for (let i = 0; i < 6; i++) {
    const res = await fetch(`${base}/api/v1/c?ttl=7d`, { method: 'POST', body: blob, headers: { 'Content-Type': 'application/octet-stream' } });
    statuses.push(res.status);
  }
  console.log(`ok - burst limit: ${statuses.join(' ')}`);

  // Beta: page, unlock, signed download with resume, channel token, old mirror gone.
  const page = await fetch(`${base}/beta`);
  if (page.status !== 200 || !(await page.text()).includes('获取安装包')) throw new Error(`/beta: ${page.status}`);
  const unlock = (key, ip) => fetch(`${base}/beta/api/unlock`, { method: 'POST', body: JSON.stringify({ key }), headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': ip } });
  const wrong = await unlock('dsh-zzzzzzzz', '192.0.2.1');
  if (wrong.status !== 403) throw new Error(`wrong key: ${wrong.status}`);
  const ok = await unlock(' DSH-SM9KE234 ', '192.0.2.2');
  const grant = await ok.json();
  if (ok.status !== 200 || grant.sha256 !== apkSha || grant.notes.zh !== '- 冒烟') throw new Error(`unlock: ${ok.status} ${JSON.stringify(grant)}`);
  const file = await fetch(base + grant.url);
  const got = new Uint8Array(await file.arrayBuffer());
  if (file.status !== 200 || file.headers.get('content-type') !== 'application/vnd.android.package-archive' || createHash('sha256').update(got).digest('hex') !== apkSha) {
    throw new Error(`signed download: ${file.status}`);
  }
  const part = await fetch(base + grant.url, { headers: { Range: 'bytes=299990-' } });
  const tail = new Uint8Array(await part.arrayBuffer());
  if (part.status !== 206 || part.headers.get('content-range') !== `bytes 299990-299999/${apk.length}` || tail.length !== 10 || tail.some((b, i) => b !== apk[299990 + i])) {
    throw new Error(`range: ${part.status} ${part.headers.get('content-range')} ${tail.length}`);
  }
  if ((await fetch(base + APK_PATH)).status !== 401) throw new Error('unsigned download allowed');
  if ((await fetch(`${base}/beta/update.json`)).status !== 401) throw new Error('update.json without a token');
  const feed = await fetch(`${base}/beta/update.json`, { headers: { Authorization: `Bearer ${channelToken}` } });
  if (feed.status !== 200 || (await feed.json()).version !== '9.9.9+1') throw new Error(`update.json: ${feed.status}`);
  const appGet = await fetch(base + APK_PATH, { headers: { Authorization: `Bearer ${channelToken}`, Range: 'bytes=0-9' } });
  if (appGet.status !== 206) throw new Error(`channel download: ${appGet.status}`);
  const guesses = [];
  for (let i = 0; i < 6; i++) guesses.push((await unlock(`dsh-zzzzzzz${'abcdef'[i]}`, '192.0.2.9')).status);
  const afterBlock = (await unlock(' DSH-SM9KE234 ', '192.0.2.9')).status;
  if (guesses.join(' ') !== '403 403 403 403 403 429' || afterBlock !== 429) throw new Error(`wrong-key limit: ${guesses.join(' ')} then ${afterBlock}`);
  for (const p of ['/download', '/update.json', '/download/9.9.9/dsh-go-9.9.9-arm64.apk']) {
    if ((await fetch(base + p, { redirect: 'manual' })).status !== 404) throw new Error(`${p} is back`);
  }
  console.log(`ok - beta: page, wrong key 403, 5 wrong then 429, unlock, signed APK ${got.length} bytes (sha256 ok), resume 206, channel 401/200, old mirror 404`);
  // The app's usage report: counted (wrangler dev has the Analytics Engine datasets).
  const day = new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10);
  const usage = (body) => fetch(`${base}/api/usage/v1`, { method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '192.0.2.40' } });
  const good = { v: 1, iid: 'smokesmokesmokesmoke0A', day, app: '0.9.9', build: 10301000, sdk: 34, abi: 'arm64-v8a', maker: 'vivo', lang: 'zh', engine: 'proot', counts: { turns: 1, voice: 0, phone: 0, share: 0, gen: 0, plugins: 0 } };
  const sent = await usage(good);
  if (sent.status !== 204) throw new Error(`usage: ${sent.status}`);
  if (output.includes('stats write failed') || output.includes('unhandled')) throw new Error('a stats write failed');
  console.log('ok - usage report: 204; nothing failed');
  if (!statuses.includes(429)) throw new Error('the upload burst limit never kicked in');
  console.log('smoke: all passed');
  stop(0);
} catch (e) {
  console.error('smoke: FAILED', e?.message ?? e, '\n--- wrangler output ---\n' + output.slice(-4000));
  stop(1);
}
