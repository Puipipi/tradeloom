import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { countCheck, countDownload, deviceCode, resetStatsMemo, statsDay } from '../src/stats';
import { makeEnv } from './fakes';

const NOW = Date.parse('2026-11-04T04:00:00Z');
const DAY = 86400000;
const request = () => new Request('https://stats.example/download/get', { headers: {
  'CF-Connecting-IP': '203.0.113.9', 'User-Agent': 'dsh-app-updater/1.0.10 (arm64-v8a)',
} });
const gate = () => Promise.withResolvers<void>();
beforeEach(() => resetStatsMemo());
afterEach(() => { vi.restoreAllMocks(); resetStatsMemo(); });

async function seeded() {
  const f = makeEnv();
  f.salts.now = () => NOW;
  // Existing DO salt, cold isolate memo: no pretend DO input-gate concurrency.
  const expected = await deviceCode(f.env, request(), NOW);
  resetStatsMemo();
  f.salts.calls = 0;
  return { ...f, expected };
}

describe('daily statistics key in-flight ownership', () => {
  it('20 real download/check operations share one fetch/import and keep every sign/point', async () => {
    const f = await seeded(), release = gate();
    const get = f.salts.get.bind(f.salts);
    vi.spyOn(f.salts, 'get').mockImplementation(id => {
      const stub = get(id);
      return { fetch: async () => { await release.promise; return stub.fetch(); } };
    });
    const imports = vi.spyOn(crypto.subtle, 'importKey');
    const signs = vi.spyOn(crypto.subtle, 'sign');
    const operations = Array.from({ length: 20 }, (_, i) => i % 2
      ? countCheck(f.env, request(), NOW)
      : countDownload(f.env, request(), 'global', '1.0.10', NOW));
    try {
      release.resolve();
      await Promise.all(operations);
      expect(f.downloads.points).toHaveLength(10);
      expect(f.checks.points).toHaveLength(10);
      expect(f.downloads.points.every(p => JSON.stringify(p) === JSON.stringify({
        indexes: ['global'], blobs: [statsDay(NOW), 'global', '1.0.10', 'XX', f.expected], doubles: [1],
      }))).toBe(true);
      expect(f.checks.points.every(p => JSON.stringify(p) === JSON.stringify({
        indexes: [f.expected], blobs: [statsDay(NOW), f.expected, '1.0.10', 'arm64-v8a', 'XX'], doubles: [1],
      }))).toBe(true);
      expect(signs).toHaveBeenCalledTimes(20);
      expect({ fetches: f.salts.calls, imports: imports.mock.calls.length }).toEqual({ fetches: 1, imports: 1 });
    } finally { release.resolve(); await Promise.allSettled(operations); }
  });

  it('completed same-day memo still avoids later fetch/import while signing each request', async () => {
    const f = await seeded();
    const imports = vi.spyOn(crypto.subtle, 'importKey'), signs = vi.spyOn(crypto.subtle, 'sign');
    for (let i = 0; i < 10; i++) expect(await deviceCode(f.env, request(), NOW)).toBe(f.expected);
    expect(f.salts.calls).toBe(1);
    expect(imports).toHaveBeenCalledTimes(1);
    expect(signs).toHaveBeenCalledTimes(10);
  });

  it('five concurrent failed fetches share the failure and a later call can retry', async () => {
    const f = await seeded();
    f.salts.fail = true;
    expect(await Promise.all(Array.from({ length: 5 }, () => deviceCode(f.env, request(), NOW)))).toEqual(Array(5).fill(''));
    const failedCalls = f.salts.calls;
    f.salts.fail = false;
    expect(await deviceCode(f.env, request(), NOW)).toBe(f.expected);
    expect(f.salts.calls - failedCalls).toBe(1);
    expect(failedCalls).toBe(1);
  });

  it('an invalid returned day is not cached and a corrected response is retried', async () => {
    const f = makeEnv();
    f.salts.now = () => NOW - DAY;
    expect(await Promise.all(Array.from({ length: 5 }, () => deviceCode(f.env, request(), NOW)))).toEqual(Array(5).fill(''));
    const invalidCalls = f.salts.calls;
    f.salts.now = () => NOW;
    expect(await deviceCode(f.env, request(), NOW)).toMatch(/^[0-9a-f]{16}$/);
    expect(f.salts.calls - invalidCalls).toBe(1);
    expect(invalidCalls).toBe(1);
  });

  it('an old day finishing after the new day cannot replace its completed key', async () => {
    const f = await seeded(), ready = gate(), release = gate();
    const get = f.salts.get.bind(f.salts);
    let sequence = 0;
    vi.spyOn(f.salts, 'get').mockImplementation(id => {
      const stub = get(id), number = ++sequence;
      return { fetch: async () => {
        const response = await stub.fetch();
        if (number === 1) { ready.resolve(); await release.promise; }
        return response;
      } };
    });
    const old = deviceCode(f.env, request(), NOW);
    try {
      await ready.promise;
      f.salts.now = () => NOW + DAY;
      const current = await deviceCode(f.env, request(), NOW + DAY);
      expect(current).toMatch(/^[0-9a-f]{16}$/);
      release.resolve();
      expect(await old).toBe(f.expected);
      expect(await deviceCode(f.env, request(), NOW + DAY)).toBe(current);
      expect(f.salts.calls).toBe(2);
    } finally { release.resolve(); await old; }
  });

  it('old completion cannot clear a newer still-pending day', async () => {
    const f = await seeded(), oldReady = gate(), oldRelease = gate(), newReady = gate(), newRelease = gate();
    const get = f.salts.get.bind(f.salts);
    let sequence = 0;
    vi.spyOn(f.salts, 'get').mockImplementation(id => {
      const stub = get(id), number = ++sequence;
      return { fetch: async () => {
        const response = await stub.fetch();
        if (number === 1) { oldReady.resolve(); await oldRelease.promise; }
        else { newReady.resolve(); await newRelease.promise; }
        return response;
      } };
    });
    const old = deviceCode(f.env, request(), NOW);
    let current: Promise<string> | undefined, follower: Promise<string> | undefined;
    try {
      await oldReady.promise;
      f.salts.now = () => NOW + DAY;
      current = deviceCode(f.env, request(), NOW + DAY);
      await newReady.promise;
      oldRelease.resolve();
      expect(await old).toBe(f.expected);
      follower = deviceCode(f.env, request(), NOW + DAY);
      newRelease.resolve();
      expect(await follower).toBe(await current);
      expect(f.salts.calls).toBe(2);
    } finally { oldRelease.resolve(); newRelease.resolve(); await Promise.allSettled([old, current, follower]); }
  });

  it('reset detaches an old pending task and followers join the replacement', async () => {
    const f = await seeded(), firstReady = gate(), release = gate();
    const get = f.salts.get.bind(f.salts);
    let sequence = 0;
    vi.spyOn(f.salts, 'get').mockImplementation(id => {
      const stub = get(id), number = ++sequence;
      return { fetch: async () => {
        const response = await stub.fetch();
        if (number === 1) firstReady.resolve();
        await release.promise;
        return response;
      } };
    });
    const first = deviceCode(f.env, request(), NOW);
    let second: Promise<string> | undefined, third: Promise<string> | undefined;
    try {
      await firstReady.promise;
      resetStatsMemo();
      second = deviceCode(f.env, request(), NOW);
      third = deviceCode(f.env, request(), NOW);
      release.resolve();
      expect(await Promise.all([first, second, third])).toEqual(Array(3).fill(f.expected));
      expect(f.salts.calls).toBe(2);
    } finally { release.resolve(); await Promise.allSettled([first, second, third]); }
  });

  it('missing binding or datasets keeps the existing no-I/O behavior', async () => {
    const f = makeEnv({ STATS_SALT: undefined, DOWNLOADS: undefined, CHECKS: undefined });
    expect(await deviceCode(f.env, request(), NOW)).toBe('');
    await countDownload(f.env, request(), 'global', '1.0.10', NOW);
    await countCheck(f.env, request(), NOW);
    expect(f.salts.calls).toBe(0);
  });
});
