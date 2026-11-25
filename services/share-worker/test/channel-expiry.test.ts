import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import worker from '../src/index';
import { CHANNEL_PREFIX, channelAuthorized, channelId, resetChannelMemo, signLink, type Grant } from '../src/beta-auth';
import { resetBetaCache } from '../src/beta';
import { FakeCache, makeCtx, makeEnv } from './fakes';

const NOW = Date.parse('2026-11-04T11:00:00Z');
const ORIGIN = 'https://go.dshtui.com';
const SECRET = 'synthetic-channel-expiry-secret-0123456789abcdef';
const TOKEN = 'dshc_' + 'A'.repeat(43);
const APK_PATH = '/beta/1.0.10/dsh-go-1.0.10-arm64.apk';
const request = (token = TOKEN, path = '/beta/update.json', method = 'GET', range?: string) =>
  new Request(ORIGIN + path, {
    method,
    headers: { Authorization: `Bearer ${token}`, ...(range ? { Range: range } : {}) },
  });

let cache: FakeCache;
beforeEach(() => {
  resetChannelMemo();
  resetBetaCache();
  vi.spyOn(Date, 'now').mockReturnValue(NOW);
  cache = new FakeCache();
  vi.stubGlobal('caches', { default: cache });
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function setup(grant: Grant, token = TOKEN) {
  const state = makeEnv({ BETA_SECRET: SECRET, CHECKS: undefined, DOWNLOADS: undefined });
  const key = CHANNEL_PREFIX + await channelId(token);
  state.kv.values.set(key, JSON.stringify(grant));
  const reads = vi.spyOn(state.kv, 'get');
  return { ...state, key, reads, check: (now: number) => channelAuthorized(state.env, request(token), now) };
}

describe('known channel grant expiry inside the original memo window', () => {
  it('rejects at the exact known deadline without another KV read', async () => {
    const s = await setup({ label: 'short', expires: new Date(NOW + 5000).toISOString() });
    const decisions = [];
    for (const now of [NOW, NOW + 4999, NOW + 5000, NOW + 59999]) decisions.push(await s.check(now));
    expect(s.reads).toHaveBeenCalledTimes(1);
    expect(decisions).toEqual([true, true, false, false]);
  });

  it('preserves missing, null and empty expiry as non-expiring grants', async () => {
    for (const [i, expires] of [undefined, null, ''].entries()) {
      const s = await setup({ label: 'permanent', expires }, 'dshc_' + String(i).repeat(43));
      expect(await s.check(NOW)).toBe(true);
      expect(await s.check(NOW + 59999)).toBe(true);
      expect(s.reads).toHaveBeenCalledTimes(1);
    }
  });

  it('keeps invalid, already expired and revoked grants rejected', async () => {
    const grants: Grant[] = [
      { label: 'bad', expires: 'not-an-iso-time' },
      { label: 'expired', expires: new Date(NOW).toISOString() },
      { label: 'revoked', revoked: true, expires: new Date(NOW + 100000).toISOString() },
    ];
    for (const [i, grant] of grants.entries()) {
      const s = await setup(grant, 'dshc_' + String(i).repeat(43));
      expect(await s.check(NOW)).toBe(false);
      s.kv.values.set(s.key, JSON.stringify({ label: 'new grant' }));
      expect(await s.check(NOW + 59999)).toBe(false);
      expect(s.reads).toHaveBeenCalledTimes(1);
      expect(await s.check(NOW + 60000)).toBe(true);
      expect(s.reads).toHaveBeenCalledTimes(2);
    }
  });

  it('adopts an extension only at the original 60-second KV refresh', async () => {
    const s = await setup({ label: 'short', expires: new Date(NOW + 5000).toISOString() });
    expect(await s.check(NOW)).toBe(true);
    s.kv.values.set(s.key, JSON.stringify({ label: 'extended', expires: new Date(NOW + 120000).toISOString() }));
    expect(await s.check(NOW + 5000)).toBe(false);
    expect(await s.check(NOW + 59999)).toBe(false);
    expect(s.reads).toHaveBeenCalledTimes(1);
    expect(await s.check(NOW + 60000)).toBe(true);
    expect(s.reads).toHaveBeenCalledTimes(2);
  });

  it('does not shorten the original memo window for unseen KV revocation', async () => {
    const s = await setup({ label: 'long', expires: new Date(NOW + 3600000).toISOString() });
    expect(await s.check(NOW)).toBe(true);
    s.kv.values.set(s.key, JSON.stringify({ label: 'revoked', revoked: true }));
    expect(await s.check(NOW + 59999)).toBe(true);
    expect(s.reads).toHaveBeenCalledTimes(1);
    expect(await s.check(NOW + 60000)).toBe(false);
    expect(s.reads).toHaveBeenCalledTimes(2);
  });

  it('keeps deadlines separate for different tokens', async () => {
    const s = await setup({ label: 'short', expires: new Date(NOW + 5000).toISOString() });
    const other = 'dshc_' + 'B'.repeat(43);
    s.kv.values.set(CHANNEL_PREFIX + await channelId(other), JSON.stringify({ label: 'permanent' }));
    expect(await s.check(NOW)).toBe(true);
    expect(await channelAuthorized(s.env, request(other), NOW)).toBe(true);
    expect(await s.check(NOW + 5000)).toBe(false);
    expect(await channelAuthorized(s.env, request(other), NOW + 5000)).toBe(true);
    expect(s.reads).toHaveBeenCalledTimes(2);
  });

  it('rejects fresh manifest and cached APK range requests, but preserves an already-started body and independent signed links', async () => {
    const s = await setup({ label: 'short', expires: new Date(NOW + 5000).toISOString() });
    const bytes = Uint8Array.from({ length: 128 }, (_, i) => i);
    s.bucket.objects.set('beta/update.json', { bytes: new TextEncoder().encode('{"schema":1}'), uploaded: new Date(NOW), customMetadata: {} });
    s.bucket.objects.set(APK_PATH.slice(1), { bytes, uploaded: new Date(NOW), customMetadata: {} });
    const ctx = makeCtx();
    const manifest = await worker.fetch(request(), s.env, ctx.ctx);
    expect(manifest.status).toBe(200);
    await manifest.arrayBuffer();
    const started = await worker.fetch(request(TOKEN, APK_PATH), s.env, ctx.ctx);
    expect(started.status).toBe(200);
    await ctx.settle();
    expect(cache.entries.size).toBe(1);
    const bucketReads = s.bucket.gets.length;
    const cacheRead = vi.spyOn(cache, 'match');
    vi.mocked(Date.now).mockReturnValue(NOW + 5000);
    expect((await worker.fetch(request(TOKEN, '/beta/update.json', 'HEAD'), s.env, ctx.ctx)).status).toBe(401);
    expect((await worker.fetch(request(TOKEN, APK_PATH, 'GET', 'bytes=64-'), s.env, ctx.ctx)).status).toBe(401);
    expect(s.reads).toHaveBeenCalledTimes(1);
    expect(s.bucket.gets.length).toBe(bucketReads);
    expect(cacheRead).not.toHaveBeenCalled();
    expect(new Uint8Array(await started.arrayBuffer())).toEqual(bytes);
    const signed = await signLink(SECRET, APK_PATH, NOW);
    const response = await worker.fetch(new Request(ORIGIN + signed.url), s.env, ctx.ctx);
    expect(response.status).toBe(200);
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes);
  });
});
