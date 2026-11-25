import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import worker from '../src/index';
import {
  CHANNEL_PREFIX,
  KEY_PREFIX,
  channelId,
  keyId,
  linkSignature,
  normalizeKey,
  resetChannelMemo,
  safeEqual,
  signLink,
  type Grant,
} from '../src/beta-auth';
import { resetBetaCache } from '../src/beta';
import { parseRange } from '../src/files';
import { FakeCache, makeCtx, makeEnv, serve } from './fakes';

const ORIGIN = 'https://go.dshtui.com';
const SECRET = 'test-beta-secret-0123456789abcdef0123456789abcdef';
const VERSION = '0.9.1';
const APK = `dsh-go-${VERSION}-arm64.apk`;
const APK_PATH = `/beta/${VERSION}/${APK}`;
const apkBytes = Uint8Array.from({ length: 5000 }, (_, i) => (i * 7) & 0xff);
const SHA = 'ab'.repeat(32);
const KEY = 'dsh-k7m3x9qp';
const TOKEN = 'dshc_' + 'A'.repeat(43);

const manifest = {
  schema: 1,
  version: `${VERSION}+10252108`,
  tag: `v${VERSION}`,
  publishedAt: '2026-10-25T13:11:04Z',
  notes: '### 中文\n\n- 中文说明\n\n### English\n\n- English notes',
  notesByLocale: { zh: '- 中文说明', en: '- English notes' },
  page: `${ORIGIN}/beta`,
  assets: { arm64: { name: APK, size: apkBytes.length, sha256: SHA, url: `${ORIGIN}${APK_PATH}` } },
};

let cache: FakeCache;

beforeEach(() => {
  resetBetaCache();
  resetChannelMemo();
  cache = new FakeCache();
  (globalThis as { caches?: unknown }).caches = { default: cache };
});

afterEach(() => {
  delete (globalThis as { caches?: unknown }).caches;
});

async function seeded(options: { publish?: boolean } = {}) {
  const ctx = makeEnv({ BETA_SECRET: SECRET });
  const put = (key: string, bytes: Uint8Array) =>
    ctx.bucket.objects.set(key, { bytes, uploaded: new Date('2026-10-25T08:00:00Z'), customMetadata: {} });
  if (options.publish ?? true) {
    put(`beta/${VERSION}/${APK}`, apkBytes);
    put(`beta/${VERSION}/update.json`, new TextEncoder().encode(JSON.stringify(manifest)));
    put('beta/update.json', new TextEncoder().encode(JSON.stringify(manifest)));
  }
  const grantKey = async (key: string, grant: Grant) =>
    ctx.kv.values.set(KEY_PREFIX + (await keyId(SECRET, normalizeKey(key)!)), JSON.stringify(grant));
  const grantChannel = async (token: string, grant: Grant) =>
    ctx.kv.values.set(CHANNEL_PREFIX + (await channelId(token)), JSON.stringify(grant));
  await grantKey(KEY, { label: 'beta-1', created: '2026-10-25T00:00:00Z', expires: null });
  await grantChannel(TOKEN, { label: 'app-1' });
  return { ...ctx, put, grantKey, grantChannel };
}

const req = (path: string, init: { headers?: Record<string, string>; method?: string; body?: string; ip?: string } = {}) =>
  new Request(ORIGIN + path, {
    method: init.method ?? 'GET',
    headers: { 'CF-Connecting-IP': init.ip ?? '198.51.100.9', ...init.headers },
    body: init.body,
  });

const unlockReq = (key: unknown, ip?: string) =>
  req('/beta/api/unlock', { method: 'POST', body: JSON.stringify({ key }), headers: { 'Content-Type': 'application/json' }, ip });

type Env = Awaited<ReturnType<typeof seeded>>['env'];
const fetchWorker = (env: Env, request: Request) => worker.fetch(request, env, makeCtx().ctx);
const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

describe('the page', () => {
  it('is a quiet, unindexed page with the key form', async () => {
    const { env } = await seeded();
    const res = await fetchWorker(env, req('/beta'));
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('text/html; charset=utf-8');
    expect(res.headers.get('X-Robots-Tag')).toBe('noindex, nofollow');
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    expect(res.headers.get('Content-Security-Policy')).toContain("script-src 'self'");
    expect(res.headers.get('Content-Security-Policy')).toContain("frame-ancestors 'none'");
    const html = await res.text();
    expect(html).toContain('<meta name="robots" content="noindex, nofollow">');
    expect(html).toContain('获取安装包');
    expect(html).toContain('<script src="/beta/beta.js">');
    expect(html).not.toMatch(/github|dshtui|r2|worker/i);

    const slash = await fetchWorker(env, req('/beta/'));
    expect(slash.status).toBe(301);
    expect(slash.headers.get('Location')).toBe('/beta');
    const script = await fetchWorker(env, req('/beta/beta.js'));
    expect(script.headers.get('Content-Type')).toBe('text/javascript; charset=utf-8');
    expect(await script.text()).toContain('/beta/api/unlock');
  });

  it('in WeChat or QQ it says to open the page in a browser instead', async () => {
    const { env } = await seeded();
    for (const ua of ['Mozilla/5.0 (Linux; Android 14) MicroMessenger/8.0.50', 'Mozilla/5.0 (Linux; Android 14) MQQBrowser/6.2 QQ/9.0.80']) {
      const html = await (await fetchWorker(env, req('/beta', { headers: { 'User-Agent': ua } }))).text();
      expect(html).toContain('在浏览器打开');
      expect(html).not.toContain('<form');
    }
    const browser = await (await fetchWorker(env, req('/beta', { headers: { 'User-Agent': 'Mozilla/5.0 (Linux; Android 14) MQQBrowser/14.2 Mobile' } }))).text();
    expect(browser).toContain('<form');
  });

  it('is not there without the secret', async () => {
    const { env } = makeEnv();
    expect((await fetchWorker(env, req('/beta'))).status).toBe(404);
    expect((await fetchWorker(env, unlockReq(KEY))).status).toBe(404);
  });
});

describe('access keys', () => {
  it('the right key gets the build and a signed link that downloads it', async () => {
    const { env } = await seeded();
    const res = await fetchWorker(env, unlockReq(KEY));
    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    const body = (await res.json()) as Record<string, unknown> & { notes: { zh: string; en: string }; url: string; expiresAt: number };
    expect(body).toMatchObject({ version: VERSION, build: '10252108', name: APK, size: apkBytes.length, sha256: SHA, publishedAt: manifest.publishedAt });
    expect(body.notes).toEqual({ zh: '- 中文说明', en: '- English notes' });
    expect(body.url).toMatch(new RegExp(`^${APK_PATH}\\?exp=\\d+&sig=[A-Za-z0-9_-]{22}$`));
    expect(body.expiresAt - Date.now()).toBeGreaterThan(9 * 60_000);
    expect(body.expiresAt - Date.now()).toBeLessThanOrEqual(10 * 60_000);

    const file = await fetchWorker(env, req(body.url));
    expect(file.status).toBe(200);
    expect(file.headers.get('Content-Type')).toBe('application/vnd.android.package-archive');
    expect(file.headers.get('Content-Disposition')).toBe(`attachment; filename="${APK}"`);
    expect(file.headers.get('Accept-Ranges')).toBe('bytes');
    expect(file.headers.get('Cache-Control')).toBe('private, no-store');
    expect(new Uint8Array(await file.arrayBuffer())).toEqual(apkBytes);
  });

  it('takes the key however it was typed', async () => {
    const { env } = await seeded();
    for (const typed of [' DSH-K7M3X9QP ', 'ｄｓｈ－ｋ７ｍ３ｘ９ｑｐ', 'k7m3x9qp', 'k7m3 x9qp', 'dsh—k7m3-x9qp', 'dshk7m3x9qp']) {
      expect((await fetchWorker(env, unlockReq(typed, `203.0.113.${typed.length}`))).status, typed).toBe(200);
    }
    expect(normalizeKey('dsh-k7m3x9q0')).toBeNull();
    expect(normalizeKey('dsh-k7m3x9qpp')).toBeNull();
    expect(normalizeKey(42)).toBeNull();
  });

  it('wrong, revoked and expired keys all get the same answer', async () => {
    const { env, grantKey } = await seeded();
    await grantKey('dsh-aaaabbbb', { label: 'qq-群', revoked: true });
    await grantKey('dsh-ccccdddd', { label: 'wechat-群', expires: '2026-01-01T00:00:00Z' });
    await grantKey('dsh-eeeeffff', { label: 'later', expires: '2999-01-01T00:00:00Z' });
    const answers = [];
    for (const [i, key] of ['dsh-zzzzzzzz', 'dsh-aaaabbbb', 'dsh-ccccdddd', 'not a key', ''].entries()) {
      const res = await fetchWorker(env, unlockReq(key, `192.0.2.${i}`));
      answers.push([res.status, await res.text()]);
    }
    expect(new Set(answers.map((a) => JSON.stringify(a)))).toEqual(new Set([JSON.stringify([403, '{"error":"invalid_key"}'])]));
    expect((await fetchWorker(env, unlockReq('dsh-eeeeffff'))).status).toBe(200);
  });

  it('five wrong keys, then ten minutes of 429 — even for the right key', async () => {
    const { env, guards } = await seeded();
    let now = Date.parse('2026-10-25T14:00:00Z');
    guards.now = () => now;
    const statuses = [];
    for (let i = 0; i < 6; i++) statuses.push((await fetchWorker(env, unlockReq(`dsh-wrong${'abcdef'[i]}xy`))).status);
    expect(statuses).toEqual([403, 403, 403, 403, 403, 429]);
    const blocked = await fetchWorker(env, unlockReq(KEY));
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get('Retry-After')).toBe('600');
    // One object per client, named by a hash: never the IP.
    expect(guards.objects.size).toBe(1);
    const [name, { storage }] = [...guards.objects.entries()][0]!;
    expect(name).toMatch(/^[0-9a-f]{32}$/);
    expect(storage.alarm).toBe(now + 600_000);
    // Someone else is fine; right keys never count.
    expect((await fetchWorker(env, unlockReq(KEY, '203.0.113.50'))).status).toBe(200);
    for (let i = 0; i < 8; i++) expect((await fetchWorker(env, unlockReq(KEY, '203.0.113.51'))).status).toBe(200);
    // Guessing on while blocked doesn't extend it; ten minutes later it's lifted.
    now += 9 * 60_000;
    expect((await fetchWorker(env, unlockReq('dsh-zzzzzzzz'))).status).toBe(429);
    now += 61_000;
    expect((await fetchWorker(env, unlockReq(KEY))).status).toBe(200);
    expect((await fetchWorker(env, unlockReq('dsh-zzzzzzzz'))).status).toBe(403);
  });

  it('slow guessing is counted too; the alarm clears the object afterwards', async () => {
    const { env, guards } = await seeded();
    let now = Date.parse('2026-10-25T14:00:00Z');
    guards.now = () => now;
    const statuses = [];
    for (let i = 0; i < 6; i++) {
      statuses.push((await fetchWorker(env, unlockReq('dsh-zzzzzzzz'))).status);
      now += 5 * 60_000;
    }
    expect(statuses).toEqual([403, 403, 403, 403, 403, 429]);
    const { guard, storage } = [...guards.objects.values()][0]!;
    now += 11 * 60_000;
    await guard.alarm();
    expect(storage.data.size).toBe(0);
    // A pause longer than the window starts over.
    for (let i = 0; i < 5; i++) expect((await fetchWorker(env, unlockReq('dsh-zzzzzzzz'))).status).toBe(403);
    now += 11 * 60_000;
    expect((await fetchWorker(env, unlockReq('dsh-zzzzzzzz'))).status).toBe(403);
  });

  it('a guard outage never locks anyone out', async () => {
    const { env, guards } = await seeded();
    guards.fail = true;
    for (let i = 0; i < 7; i++) expect((await fetchWorker(env, unlockReq('dsh-zzzzzzzz'))).status).toBe(403);
    expect((await fetchWorker(env, unlockReq(KEY))).status).toBe(200);
  });

  it('says so when nothing is published', async () => {
    const { env } = await seeded({ publish: false });
    const res = await fetchWorker(env, unlockReq(KEY));
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'no_release' });
  });

  it('only POST unlocks, and bodies stay small', async () => {
    const { env } = await seeded();
    expect((await fetchWorker(env, req('/beta/api/unlock'))).status).toBe(405);
    expect((await fetchWorker(env, req('/beta', { method: 'POST' }))).status).toBe(405);
    const big = req('/beta/api/unlock', { method: 'POST', body: JSON.stringify({ key: KEY, pad: 'x'.repeat(2000) }) });
    expect((await fetchWorker(env, big)).status).toBe(403);
  });
});

describe('signed links', () => {
  it('expire, and only open their own file', async () => {
    const { env, put } = await seeded();
    put(`beta/${VERSION}/other.apk`, apkBytes);
    const old = await signLink(SECRET, APK_PATH, Date.now() - 11 * 60_000);
    expect((await fetchWorker(env, req(old.url))).status).toBe(403);

    const fresh = await signLink(SECRET, APK_PATH);
    const query = fresh.url.split('?')[1]!;
    expect((await fetchWorker(env, req(`/beta/${VERSION}/other.apk?${query}`))).status).toBe(403);
    expect((await fetchWorker(env, req(fresh.url.replace(/sig=.{4}/, 'sig=AAAA')))).status).toBe(403);
    const otherSecret = await signLink('another-secret-0123456789abcdef0123', APK_PATH);
    expect((await fetchWorker(env, req(otherSecret.url))).status).toBe(403);
    // A far-future expiry wasn't made by us, whatever the signature.
    const exp = Math.floor(Date.now() / 1000) + 86400;
    const forged = `${APK_PATH}?exp=${exp}&sig=${await linkSignature(SECRET, APK_PATH, exp)}`;
    expect((await fetchWorker(env, req(forged))).status).toBe(403);
    expect((await fetchWorker(env, req(APK_PATH))).status).toBe(401);
    expect((await fetchWorker(env, req(fresh.url))).status).toBe(200);
  });

  it('resume with Range, from R2 and then from the edge copy', async () => {
    const { env, bucket } = await seeded();
    const { url } = await signLink(SECRET, APK_PATH);
    const tail = await fetchWorker(env, req(url, { headers: { Range: 'bytes=4990-' } }));
    expect(tail.status).toBe(206);
    expect(tail.headers.get('Content-Range')).toBe(`bytes 4990-4999/${apkBytes.length}`);
    expect(tail.headers.get('Content-Length')).toBe('10');
    expect(new Uint8Array(await tail.arrayBuffer())).toEqual(apkBytes.slice(4990));
    const mid = await fetchWorker(env, req(url, { headers: { Range: 'bytes=10-19' } }));
    expect(mid.headers.get('Content-Range')).toBe(`bytes 10-19/${apkBytes.length}`);
    const suffix = await fetchWorker(env, req(url, { headers: { Range: 'bytes=-5' } }));
    expect(suffix.headers.get('Content-Range')).toBe(`bytes 4995-4999/${apkBytes.length}`);
    const past = await fetchWorker(env, req(url, { headers: { Range: 'bytes=5000-' } }));
    expect(past.status).toBe(416);
    expect(cache.puts).toBe(0);

    const first = makeCtx();
    const full = await worker.fetch(req(url), env, first.ctx);
    expect(full.headers.get('X-Cache')).toBe('MISS');
    await full.arrayBuffer();
    await first.settle();
    expect(cache.puts).toBe(1);
    expect([...cache.entries.keys()]).toEqual([`${ORIGIN}/__edge/beta/${VERSION}/${APK}`]);

    const gets = bucket.gets.length;
    const resumed = await fetchWorker(env, req(url, { headers: { Range: 'bytes=4000-' } }));
    expect(resumed.status).toBe(206);
    expect(resumed.headers.get('X-Cache')).toBe('HIT');
    expect(resumed.headers.get('Cache-Control')).toBe('private, no-store');
    expect(new Uint8Array(await resumed.arrayBuffer())).toEqual(apkBytes.slice(4000));
    expect(bucket.gets.length).toBe(gets);

    // The edge copy is never reachable on its own.
    expect((await fetchWorker(env, req(`/__edge/beta/${VERSION}/${APK}`))).status).toBe(404);
    expect((await fetchWorker(env, req(APK_PATH))).status).toBe(401);
  });

  it('HEAD gives the size', async () => {
    const { env } = await seeded();
    const { url } = await signLink(SECRET, APK_PATH);
    const res = await fetchWorker(env, req(url, { method: 'HEAD' }));
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Length')).toBe(String(apkBytes.length));
    expect(await res.text()).toBe('');
  });
});

describe('the app channel', () => {
  it('update.json needs a live channel token', async () => {
    const { env, grantChannel } = await seeded();
    const none = await fetchWorker(env, req('/beta/update.json'));
    expect(none.status).toBe(401);
    expect(none.headers.get('WWW-Authenticate')).toContain('Bearer');
    expect((await fetchWorker(env, req('/beta/update.json', { headers: bearer('dshc_' + 'B'.repeat(43)) }))).status).toBe(401);
    expect((await fetchWorker(env, req('/beta/update.json', { headers: bearer(KEY) }))).status).toBe(401);
    const revoked = 'dshc_' + 'C'.repeat(43);
    await grantChannel(revoked, { label: 'old', revoked: true });
    expect((await fetchWorker(env, req('/beta/update.json', { headers: bearer(revoked) }))).status).toBe(401);
    // A signature buys a file, not the manifest.
    const { url } = await signLink(SECRET, '/beta/update.json');
    expect((await fetchWorker(env, req(url))).status).toBe(401);

    const res = await fetchWorker(env, req('/beta/update.json', { headers: bearer(TOKEN) }));
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('application/json; charset=utf-8');
    expect(res.headers.get('Cache-Control')).toBe('private, no-store');
    expect(((await res.json()) as typeof manifest).assets.arm64.url).toBe(`${ORIGIN}${APK_PATH}`);
  });

  it('downloads with the token, resuming with Range', async () => {
    const { env } = await seeded();
    const full = await fetchWorker(env, req(APK_PATH, { headers: bearer(TOKEN) }));
    expect(full.status).toBe(200);
    expect(new Uint8Array(await full.arrayBuffer())).toEqual(apkBytes);
    const part = await fetchWorker(env, req(APK_PATH, { headers: { ...bearer(TOKEN), Range: 'bytes=100-' } }));
    expect(part.status).toBe(206);
    expect(new Uint8Array(await part.arrayBuffer())).toEqual(apkBytes.slice(100));
    expect((await fetchWorker(env, req(`/beta/${VERSION}/missing.apk`, { headers: bearer(TOKEN) }))).status).toBe(404);
    expect((await fetchWorker(env, req('/beta/0.9.1/..%2Fupdate.json', { headers: bearer(TOKEN) }))).status).toBe(404);
    expect((await fetchWorker(env, req('/beta/a/b/c', { headers: bearer(TOKEN) }))).status).toBe(404);
  });
});

describe('the old public mirror', () => {
  it('stays 404 even with its files back in R2', async () => {
    const { env, put } = await seeded();
    put('releases/update.json', new TextEncoder().encode(JSON.stringify(manifest)));
    put(`releases/${VERSION}/${APK}`, apkBytes);
    for (const p of ['/download', '/download/', `/download/${VERSION}/${APK}`, '/update.json', '/download?flavor=arm64']) {
      expect((await fetchWorker(env, req(p))).status, p).toBe(404);
      expect((await fetchWorker(env, req(p, { headers: bearer(TOKEN) }))).status, p).toBe(404);
    }
  });

  it('leaves the share routes alone', async () => {
    const { env } = await seeded();
    expect((await serve(req('/share/'), env)).status).toBe(200);
    expect((await fetchWorker(env, req('/c/Ab3dE5gH9k'))).status).toBe(200);
    expect((await fetchWorker(env, req('/betas'))).status).toBe(404);
  });
});

describe('helpers', () => {
  it('parses single byte ranges only', () => {
    expect(parseRange('bytes=0-')).toEqual({ offset: 0 });
    expect(parseRange('bytes=5-9')).toEqual({ offset: 5, length: 5 });
    expect(parseRange('bytes=-3')).toEqual({ suffix: 3 });
    expect(parseRange('bytes=9-5')).toBeNull();
    expect(parseRange('bytes=0-1,3-4')).toBeNull();
    expect(parseRange('items=0-1')).toBeNull();
    expect(parseRange(null)).toBeNull();
  });

  it('compares in constant time and exactly', () => {
    expect(safeEqual('abc', 'abc')).toBe(true);
    expect(safeEqual('abc', 'abd')).toBe(false);
    expect(safeEqual('abc', 'abcd')).toBe(false);
    expect(safeEqual('', '')).toBe(true);
  });

  it('hashes keys with the secret, not plainly', async () => {
    const a = await keyId(SECRET, KEY);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(await keyId('another-secret', KEY)).not.toBe(a);
  });
});
