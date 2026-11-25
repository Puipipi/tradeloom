// Counting downloads, update checks and the app's usage reports, and what is
// (not) kept: src/stats.ts, src/usage.ts.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import worker from '../src/index';
import { CHANNEL_PREFIX, channelId, resetChannelMemo } from '../src/beta-auth';
import { resetBetaCache } from '../src/beta';
import type { Env } from '../src/env';
import { addDays, deviceCode, hmacHex, nextDayStart, parseUpdaterAgent, resetStatsMemo, statsDay } from '../src/stats';
import { COUNT_LIMITS, COUNT_LIMITS_V3, resetUsageMemo, validateReport } from '../src/usage';
import { FakeCache, makeCtx, makeEnv } from './fakes';

const ORIGIN = 'https://go.dshtui.com';
// Keep requests, per-day keys, and expected dates on the same test day.
const testNow = Date.parse('2026-10-30T04:00:00Z');
const VERSION = '0.9.8';
const APK = `dsh-go-${VERSION}-arm64.apk`;
const CN = 'https://dshgo-cn.oss-cn-hongkong.aliyuncs.com/';
const TOKEN = 'dshc_' + 'A'.repeat(43);
const IP = '203.0.113.77';
const IP6 = '2001:db8:abcd:12:1111:2222:3333:4444';
const USAGE_SECRET = 'usage-secret-0123456789abcdef0123456789abcdef';
const UA = 'Mozilla/5.0 (Linux; Android 14; V2309A) AppleWebKit/537.36 Chrome/126 Mobile Safari/537.36';

const manifest = {
  schema: 1,
  version: `${VERSION}+10301000`,
  publishedAt: '2026-10-30T02:00:00Z',
  notesByLocale: { zh: '- 说明', en: '- notes' },
  routes: ['global', 'cn', 'github'],
  assets: { arm64: { name: APK, size: 10, sha256: 'ab'.repeat(32) } },
};

beforeEach(() => {
  vi.spyOn(Date, 'now').mockReturnValue(testNow);
  resetBetaCache();
  resetChannelMemo();
  resetStatsMemo();
  resetUsageMemo();
  (globalThis as { caches?: unknown }).caches = { default: new FakeCache() };
});

afterEach(() => {
  vi.restoreAllMocks();
  delete (globalThis as { caches?: unknown }).caches;
});

async function setup(vars: Partial<Env> = {}) {
  const ctx = makeEnv({ BETA_SECRET: 'beta-secret-0123456789abcdef0123456789', CN_BASE_URL: CN, DOWNLOAD_ACCESS: 'public', USAGE_SECRET, ...vars });
  const put = (key: string, bytes: Uint8Array) => ctx.bucket.objects.set(key, { bytes, uploaded: new Date(), customMetadata: {} });
  put('beta/update.json', new TextEncoder().encode(JSON.stringify(manifest)));
  put(`beta/${VERSION}/${APK}`, new Uint8Array(10));
  ctx.kv.values.set(CHANNEL_PREFIX + (await channelId(TOKEN)), JSON.stringify({ label: 'app-1' }));
  return ctx;
}

function req(path: string, init: { method?: string; headers?: Record<string, string>; body?: string; ip?: string; country?: string } = {}) {
  const r = new Request(ORIGIN + path, {
    method: init.method ?? 'GET',
    headers: { 'CF-Connecting-IP': init.ip ?? IP, 'User-Agent': UA, ...init.headers },
    body: init.body,
  });
  if (init.country) Object.defineProperty(r, 'cf', { value: { country: init.country } });
  return r;
}

/** Runs the request and whatever it left for after the response. */
async function run(env: Env, request: Request) {
  const { ctx, settle } = makeCtx();
  const res = await worker.fetch(request, env, ctx);
  await settle();
  return res;
}

describe('download buttons', () => {
  it('count the click, then redirect to the route', async () => {
    const { env, downloads } = await setup();
    const expected = { cn: `${CN}${VERSION}/${APK}`, global: `/download/${VERSION}/${APK}`, github: `https://github.com/ccch1mneyyy/dsh-go/releases/download/v${VERSION}/${APK}` };
    for (const [via, location] of Object.entries(expected)) {
      const res = await run(env, req(`/download/get?via=${via}&v=${VERSION}`, { country: 'CN' }));
      expect(res.status, via).toBe(302);
      expect(res.headers.get('Location')).toBe(location);
      expect(res.headers.get('Cache-Control')).toBe('no-store');
    }
    expect(downloads.points.map((p) => p.blobs.slice(0, 4))).toEqual(
      ['cn', 'global', 'github'].map((via) => [statsDay(), via, VERSION, 'CN']),
    );
    // One device, one code (same IP and browser, same day).
    const codes = new Set(downloads.points.map((p) => p.blobs[4]));
    expect(codes.size).toBe(1);
    expect([...codes][0]).toMatch(/^[0-9a-f]{16}$/);
    expect(downloads.points.map((p) => p.indexes[0])).toEqual(['cn', 'global', 'github']);
    expect(downloads.points.every((p) => p.doubles[0] === 1)).toBe(true);
  });

  it("don't count HEAD, stale or made-up links, or floods — but still redirect", async () => {
    const { env, downloads, readLimit } = await setup();
    const head = await run(env, req(`/download/get?via=cn&v=${VERSION}`, { method: 'HEAD' }));
    expect(head.status).toBe(302);
    expect(head.headers.get('Location')).toBe(`${CN}${VERSION}/${APK}`);
    const stale = await run(env, req('/download/get?via=cn&v=0.9.7'));
    expect(stale.headers.get('Location')).toBe('/download?via=cn');
    expect((await run(env, req(`/download/get?via=ftp&v=${VERSION}`))).headers.get('Location')).toBe('/download');
    expect((await run(env, req(`/download/get?via=%22%3E%3Cx&v=${VERSION}`))).headers.get('Location')).toBe('/download');
    expect((await run(env, req('/download/get'))).headers.get('Location')).toBe('/download');
    expect(downloads.points).toHaveLength(0);

    readLimit.allow = 1;
    for (let i = 0; i < 3; i++) expect((await run(env, req(`/download/get?via=global&v=${VERSION}`))).status).toBe(302);
    expect(downloads.points).toHaveLength(1);
    expect(readLimit.keys).toContain(`dlc:${IP}`);
  });

  it('a route that isn\'t offered sends you back to the page', async () => {
    const { env, downloads } = await setup({ CN_BASE_URL: '' });
    expect((await run(env, req(`/download/get?via=cn&v=${VERSION}`))).headers.get('Location')).toBe('/download?via=cn');
    expect(downloads.points).toHaveLength(0);
  });

  it('are 404 in key mode, like the rest of /download', async () => {
    const { env, downloads } = await setup({ DOWNLOAD_ACCESS: 'key' });
    expect((await run(env, req(`/download/get?via=global&v=${VERSION}`))).status).toBe(404);
    expect(downloads.points).toHaveLength(0);
  });

  it('count without a device code when the salt is out of reach', async () => {
    const { env, downloads, salts } = await setup();
    salts.fail = true;
    expect((await run(env, req(`/download/get?via=global&v=${VERSION}`))).status).toBe(302);
    expect(downloads.points[0]!.blobs[4]).toBe('');
  });
});

describe('update checks', () => {
  const check = (headers: Record<string, string> = {}, method = 'GET') =>
    req('/beta/update.json', { method, headers: { Authorization: `Bearer ${TOKEN}`, 'User-Agent': 'dsh-app-updater', ...headers }, country: 'US' });

  it('count what the channel answers, once per request', async () => {
    const { env, checks } = await setup();
    expect((await run(env, check())).status).toBe(200);
    expect((await run(env, check())).status).toBe(200);
    expect(checks.points).toHaveLength(2);
    const [a, b] = checks.points;
    expect(a!.blobs).toEqual([statsDay(), a!.blobs[1], '', '', 'US']);
    expect(a!.blobs[1]).toMatch(/^[0-9a-f]{16}$/);
    expect(b!.blobs[1]).toBe(a!.blobs[1]);
    expect(a!.indexes).toEqual([a!.blobs[1]]);
  });

  it('take the app version and ABI from the User-Agent when it has them', async () => {
    const { env, checks } = await setup();
    await run(env, check({ 'User-Agent': 'dsh-app-updater/0.9.9+10301000 (arm64-v8a)' }));
    expect(checks.points[0]!.blobs.slice(2, 4)).toEqual(['0.9.9+10301000', 'arm64-v8a']);
    expect(parseUpdaterAgent('dsh-app-updater/0.9.9 (mips)')).toEqual({ app: '0.9.9', abi: '' });
    expect(parseUpdaterAgent('curl/8')).toEqual({ app: '', abi: '' });
  });

  it("don't count refused, HEAD or other requests", async () => {
    const { env, checks } = await setup();
    expect((await run(env, req('/beta/update.json'))).status).toBe(401);
    expect((await run(env, check({ Authorization: 'Bearer dshc_' + 'B'.repeat(43) }))).status).toBe(401);
    expect((await run(env, check({}, 'HEAD'))).status).toBe(200);
    expect((await run(env, req(`/beta/${VERSION}/${APK}`, { headers: { Authorization: `Bearer ${TOKEN}` } }))).status).toBe(200);
    expect(checks.points).toHaveLength(0);
  });
});

describe('daily device codes', () => {
  it('stay the same through a day, change with the day, and differ by IP and browser', async () => {
    const { env, salts } = await setup();
    let now = Date.parse('2026-10-30T01:00:00Z');
    salts.now = () => now;
    const code = (ip: string, ua = UA) => deviceCode(env, req('/', { ip, headers: { 'User-Agent': ua } }), now);
    const morning = await code(IP);
    now += 10 * 3600_000;
    expect(await code(IP)).toBe(morning);
    expect(await code('203.0.113.78')).not.toBe(morning);
    expect(await code(IP, 'dsh-app-updater')).not.toBe(morning);
    // IPv6: the /64, like the rate limits.
    expect(await code(IP6)).toBe(await code('2001:db8:abcd:12:9999::1'));
    // 2026-10-31 in UTC+8 starts at 16:00 UTC: a new salt, a new code.
    now = Date.parse('2026-10-30T16:00:01Z');
    const next = await code(IP);
    expect(next).not.toBe(morning);
    expect(next).toMatch(/^[0-9a-f]{16}$/);
    expect(salts.calls).toBe(2);
  });

  it("the salt is random, kept for the day only, and deleted after", async () => {
    const { env, salts } = await setup();
    let now = Date.parse('2026-10-30T01:00:00Z');
    salts.now = () => now;
    await deviceCode(env, req('/'), now);
    const { salt, storage } = salts.objects.get('salt')!;
    const first = (storage.data.get('salt') as { day: string; salt: string });
    expect(first.day).toBe('2026-10-30');
    expect(first.salt).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(storage.alarm).toBe(nextDayStart(now));
    expect(new Date(storage.alarm!).toISOString()).toBe('2026-10-30T16:00:00.000Z');
    // The alarm, a little early: kept; at the day's end: gone.
    now = storage.alarm! - 1000;
    await salt.alarm();
    expect(storage.data.size).toBe(1);
    now = storage.alarm!;
    await salt.alarm();
    expect(storage.data.size).toBe(0);
    // A fresh one the next day, not yesterday's.
    resetStatsMemo();
    await deviceCode(env, req('/'), now);
    expect((storage.data.get('salt') as { salt: string }).salt).not.toBe(first.salt);
  });
});

// ── The app's usage report ───────────────────────────────────────────────

const IID = 'q1w2e3r4t5y6u7i8o9p0aQ';
const today = statsDay(testNow);
function report(over: Record<string, unknown> = {}) {
  return {
    v: 1, iid: IID, day: today, app: '0.9.9', build: 10301000, sdk: 34, abi: 'arm64-v8a', maker: 'vivo', lang: 'zh', engine: 'proot',
    counts: { turns: 12, voice: 1, phone: 0, share: 2, gen: 0, plugins: 3 },
    ...over,
  };
}
const post = (body: unknown, init: { ip?: string; headers?: Record<string, string>; raw?: string } = {}) =>
  req('/api/usage/v1', {
    method: 'POST',
    ip: init.ip,
    body: init.raw ?? JSON.stringify(body),
    headers: { 'Content-Type': 'application/json', ...init.headers },
  });

describe('usage reports', () => {
  it('are stored with the install id hashed, and answered 204', async () => {
    const { env, usage } = await setup();
    const res = await run(env, post(report()));
    expect(res.status).toBe(204);
    expect(await res.text()).toBe('');
    expect(usage.points).toHaveLength(1);
    const device = await hmacHex(USAGE_SECRET, `iid\n${IID}`, 16);
    expect(device).toMatch(/^[0-9a-f]{32}$/);
    expect(usage.points[0]).toEqual({
      indexes: [device],
      blobs: [today, device, '0.9.9', 'arm64-v8a', 'vivo', 'zh', 'proot', '', ''],
      doubles: [10301000, 34, 12, 1, 0, 2, 0, 3, 1, 0, 0, 0, 0, 0],
    });
  });

  it('take v3 with the tavern, the room, calls and tokens', async () => {
    const { env, usage } = await setup();
    const counts = { turns: 12, voice: 1, phone: 0, share: 2, gen: 0, plugins: 3, tavern: 7, room: 2, call: 1, tok_in: 1_234_567, tok_out: 8_910 };
    const res = await run(env, post(report({ v: 3, model: 'V2405A', rom: 'originos 5.0', counts })));
    expect(res.status).toBe(204);
    expect(usage.points[0].blobs.slice(7)).toEqual(['v2405a', 'originos 5.0']);
    expect(usage.points[0].doubles).toEqual([10301000, 34, 12, 1, 0, 2, 0, 3, 3, 7, 2, 1, 1_234_567, 8_910]);
  });

  it('take exactly the counts of v3, and v3 counts only in v3', async () => {
    const { env, usage } = await setup();
    const base = { turns: 1, voice: 0, phone: 0, share: 0, gen: 0, plugins: 0 };
    const extra = { tavern: 0, room: 0, call: 0, tok_in: 0, tok_out: 0 };
    const v3 = (counts: Record<string, unknown>) => report({ v: 3, model: 'pjz110', rom: 'coloros v15.0.0', counts });
    const bad: [Record<string, unknown>, string, string][] = [
      [v3(base), 'missing_field', 'counts.tavern'],
      [v3({ ...base, ...extra, tokens: 1 }), 'unknown_field', 'counts.tokens'],
      [v3({ ...base, ...extra, tok_in: -1 }), 'invalid', 'counts.tok_in'],
      [v3({ ...base, ...extra, tok_in: 1.5 }), 'invalid', 'counts.tok_in'],
      [v3({ ...base, ...extra, tok_in: COUNT_LIMITS_V3.tok_in + 1 }), 'invalid', 'counts.tok_in'],
      [v3({ ...base, ...extra, tok_out: COUNT_LIMITS_V3.tok_out + 1 }), 'invalid', 'counts.tok_out'],
      [v3({ ...base, ...extra, call: COUNT_LIMITS_V3.call + 1 }), 'invalid', 'counts.call'],
      [report({ v: 3, counts: { ...base, ...extra } }), 'missing_field', 'model'],
      [report({ v: 2, model: 'pjz110', rom: 'coloros v15.0.0', counts: { ...base, ...extra } }), 'unknown_field', 'counts.tavern'],
      [report({ counts: { ...base, tavern: 1 } }), 'unknown_field', 'counts.tavern'],
    ];
    for (const [body, error, field] of bad) {
      const res = await run(env, post(body));
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect(await res.json()).toEqual({ error, field });
    }
    expect(usage.points).toHaveLength(0);
    expect((await run(env, post(v3({ ...base, ...COUNT_LIMITS_V3 })))).status).toBe(204);
    expect(usage.points).toHaveLength(1);
  });

  it('take v2 with the model and system, stored in lower case', async () => {
    const { env, usage } = await setup();
    const res = await run(env, post(report({ v: 2, model: 'V2405A', rom: 'originos 5.0' })));
    expect(res.status).toBe(204);
    expect(usage.points[0].blobs.slice(7)).toEqual(['v2405a', 'originos 5.0']);
  });

  it('take exactly the fields of v2', async () => {
    const { env, usage } = await setup();
    const v2 = (over: Record<string, unknown>) => report({ v: 2, model: 'pjz110', rom: 'coloros v15.0.0', ...over });
    const bad: [Record<string, unknown>, string, string][] = [
      [report({ v: 2 }), 'missing_field', 'model'],
      [report({ v: 2, model: 'pjz110' }), 'missing_field', 'rom'],
      [report({ model: 'pjz110' }), 'unknown_field', 'model'],
      [v2({ extra: 1 }), 'unknown_field', 'extra'],
      [v2({ model: '' }), 'invalid', 'model'],
      [v2({ model: 'x'.repeat(33) }), 'invalid', 'model'],
      [v2({ rom: '<b>' }), 'invalid', 'rom'],
      [v2({ rom: 5 }), 'invalid', 'rom'],
    ];
    for (const [body, error, field] of bad) {
      const res = await run(env, post(body));
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect(await res.json()).toEqual({ error, field });
    }
    expect(usage.points).toHaveLength(0);
  });

  it('count a device once a day', async () => {
    const { env, usage } = await setup();
    expect((await run(env, post(report()))).status).toBe(204);
    expect((await run(env, post(report({ counts: { turns: 20, voice: 1, phone: 0, share: 2, gen: 0, plugins: 3 } })))).status).toBe(204);
    // Padded base64url is the same install.
    expect((await run(env, post(report({ iid: `${IID}==` })))).status).toBe(204);
    expect(usage.points).toHaveLength(1);
    expect((await run(env, post(report({ day: addDays(today, -1) })))).status).toBe(204);
    expect((await run(env, post(report({ iid: 'z'.repeat(21) + 'A' })))).status).toBe(204);
    expect(usage.points).toHaveLength(3);
  });

  it('take exactly the fields of v1', async () => {
    const { env, usage } = await setup();
    const bad: [Record<string, unknown>, string, string][] = [
      [{ extra: 1 }, 'unknown_field', 'extra'],
      [{ ip: '1.2.3.4' }, 'unknown_field', 'ip'],
      [{ counts: { turns: 1, voice: 0, phone: 0, share: 0, gen: 0, plugins: 0, chats: 1 } }, 'unknown_field', 'counts.chats'],
      [{ counts: { turns: 1, voice: 0, phone: 0, share: 0, gen: 0 } }, 'missing_field', 'counts.plugins'],
      [{ v: 4 }, 'invalid', 'v'],
      [{ v: '1' }, 'invalid', 'v'],
      [{ iid: 'short' }, 'invalid', 'iid'],
      [{ iid: 'q1w2e3r4t5y6u7i8o9p0aB' }, 'invalid', 'iid'],
      [{ iid: 42 }, 'invalid', 'iid'],
      [{ app: '0.9' }, 'invalid', 'app'],
      [{ app: '0.9.9+10301000' }, 'invalid', 'app'],
      [{ build: 1.5 }, 'invalid', 'build'],
      [{ build: '10301000' }, 'invalid', 'build'],
      [{ build: 0 }, 'invalid', 'build'],
      [{ sdk: 25 }, 'invalid', 'sdk'],
      [{ sdk: 99 }, 'invalid', 'sdk'],
      [{ abi: 'mips' }, 'invalid', 'abi'],
      [{ maker: '' }, 'invalid', 'maker'],
      [{ maker: 'x'.repeat(33) }, 'invalid', 'maker'],
      [{ maker: '<script>' }, 'invalid', 'maker'],
      [{ lang: 'Chinese' }, 'invalid', 'lang'],
      [{ engine: 'termux' }, 'invalid', 'engine'],
      [{ counts: [1, 2] }, 'invalid', 'counts'],
      [{ counts: { turns: -1, voice: 0, phone: 0, share: 0, gen: 0, plugins: 0 } }, 'invalid', 'counts.turns'],
      [{ counts: { turns: COUNT_LIMITS.turns + 1, voice: 0, phone: 0, share: 0, gen: 0, plugins: 0 } }, 'invalid', 'counts.turns'],
      [{ counts: { turns: 0, voice: 0, phone: 0, share: 0, gen: 0, plugins: 1e9 } }, 'invalid', 'counts.plugins'],
    ];
    for (const [over, error, field] of bad) {
      const res = await run(env, post(report(over)));
      expect(res.status, JSON.stringify(over)).toBe(400);
      expect(await res.json()).toEqual({ error, field });
    }
    const { iid: _, ...noIid } = report();
    expect(await (await run(env, post(noIid))).json()).toEqual({ error: 'missing_field', field: 'iid' });
    for (const raw of ['not json', '[]', 'null', '"x"', '{"v":1,']) {
      expect((await run(env, post(null, { raw }))).status, raw).toBe(400);
    }
    expect(usage.points).toHaveLength(0);
  });

  it('take days from the last week (UTC+8), or tomorrow for phones ahead', () => {
    const now = Date.parse('2026-10-30T04:00:00Z'); // 12:00 on the 30th in UTC+8
    const day = (d: string) => () => validateReport(report({ day: d }), now);
    for (const ok of ['2026-10-30', '2026-10-23', '2026-10-31']) expect(day(ok)).not.toThrow();
    for (const bad of ['2026-10-22', '2026-11-01', '2026-02-30', '2026-13-01', '2026-1-30', '30-10-2026']) expect(day(bad), bad).toThrow();
  });

  it('stay small, JSON and POST', async () => {
    const { env, usage } = await setup();
    const big = JSON.stringify(report()).replace('"proot"', `"proot"${' '.repeat(2100)}`);
    expect((await run(env, post(null, { raw: big }))).status).toBe(413);
    expect((await run(env, post(null, { raw: big, headers: { 'Content-Length': '0' } }))).status).toBe(413);
    expect((await run(env, post(report(), { headers: { 'Content-Length': '4096' } }))).status).toBe(413);
    expect((await run(env, post(report(), { headers: { 'Content-Type': 'text/plain' } }))).status).toBe(415);
    expect((await run(env, req('/api/usage/v1'))).status).toBe(405);
    expect(usage.points).toHaveLength(0);
    // Exactly at the limit is fine.
    const padded = JSON.stringify(report());
    expect((await run(env, post(null, { raw: padded + ' '.repeat(2048 - padded.length) }))).status).toBe(204);
  });

  it('are limited per client per minute', async () => {
    const { env, usage, usageLimit } = await setup();
    usageLimit.allow = 3;
    const statuses = [];
    for (let i = 0; i < 5; i++) statuses.push((await run(env, post(report({ iid: `${'abcde'[i]}`.repeat(21) + 'A' })))).status);
    expect(statuses).toEqual([204, 204, 204, 429, 429]);
    expect(usage.points).toHaveLength(3);
    expect((await run(env, post(report({ iid: 'k'.repeat(21) + 'A' }), { ip: '198.51.100.20' }))).status).toBe(204);
  });

  it('are 404 without the secret', async () => {
    const { env, usage } = await setup({ USAGE_SECRET: undefined });
    expect((await run(env, post(report()))).status).toBe(404);
    expect(usage.points).toHaveLength(0);
  });

  it('are 404 without the dataset', async () => {
    const { env } = await setup({ USAGE: undefined });
    expect((await run(env, post(report()))).status).toBe(404);
  });
});

describe('without Analytics Engine', () => {
  it('downloads and update checks work and count nothing', async () => {
    const { env, salts } = await setup({ DOWNLOADS: undefined, CHECKS: undefined, USAGE: undefined });
    const button = await run(env, req(`/download/get?via=github&v=${VERSION}`));
    expect(button.status).toBe(302);
    expect(button.headers.get('Location')).toBe(`https://github.com/ccch1mneyyy/dsh-go/releases/download/v${VERSION}/${APK}`);
    const feed = await run(env, req('/beta/update.json', { headers: { Authorization: `Bearer ${TOKEN}` } }));
    expect(feed.status).toBe(200);
    expect((await run(env, req('/download'))).status).toBe(200);
    expect(salts.calls).toBe(0);
  });
});

describe('what is kept', () => {
  it('never an IP, an install id or a User-Agent', async () => {
    const { env, downloads, checks, usage, salts, kv } = await setup();
    for (const ip of [IP, IP6]) {
      await run(env, req(`/download/get?via=cn&v=${VERSION}`, { ip, country: 'CN' }));
      await run(env, req('/beta/update.json', { ip, headers: { Authorization: `Bearer ${TOKEN}` } }));
      await run(env, post(report(), { ip }));
    }
    const kept = JSON.stringify([downloads.points, checks.points, usage.points, [...salts.objects.values()].map((o) => [...o.storage.data]), [...kv.values]]);
    expect(downloads.points.length + checks.points.length + usage.points.length).toBe(5);
    for (const secret of [IP, IP6, '2001:db8:abcd:12', IID, UA, 'V2309A']) expect(kept, secret).not.toContain(secret);
  });
});
