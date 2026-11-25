// Diagnostic only: lawful elapsed time can invalidate a test's fixed-time
// expectation. This does not assert a Worker defect or a historical failure.
import { afterEach, describe, expect, it, vi } from 'vitest';
import worker from '../src/index';
import { resetBetaCache } from '../src/beta';
import { resetChannelMemo } from '../src/beta-auth';
import { resetStatsMemo, statsDay } from '../src/stats';
import { resetUsageMemo } from '../src/usage';
import { FakeCache, makeCtx, makeEnv } from './fakes';

const ORIGIN = 'https://go.dshtui.com';
const initialCaches = Object.getOwnPropertyDescriptor(globalThis, 'caches');

afterEach(() => {
  vi.restoreAllMocks();
  if (initialCaches) Object.defineProperty(globalThis, 'caches', initialCaches);
  else delete (globalThis as { caches?: unknown }).caches;
  resetBetaCache();
  resetChannelMemo();
  resetStatsMemo();
  resetUsageMemo();
});

async function run(env: ReturnType<typeof makeEnv>['env'], path: string) {
  const { ctx, settle } = makeCtx();
  const response = await worker.fetch(new Request(ORIGIN + path, {
    headers: { 'CF-Connecting-IP': '203.0.113.77', 'User-Agent': 'clock-boundary-diagnostic' },
  }), env, ctx);
  await settle();
  return response;
}

function catalog() {
  return {
    index: { format: 1, title: { en: 'DSH Go' }, plugins: [
      { name: '@scope/plugin', versions: [{ version: '1.2.3', source: { type: 'npm' } }] },
    ] },
    sidecar: { schema: 1, generatedAt: '2026-10-30T00:00:00Z', plugins: {
      '@scope/plugin': {
        version: '1.2.3', tier: 'community', title: { zh: '搜索', en: 'Search' },
        summary: { zh: '搜索网页', en: 'Search the web' },
        risk: { level: 'medium', flags: ['network', 'shell'] },
        integrity: 'sha512-' + 'A'.repeat(86) + '==', checkedAt: '2026-10-30T00:00:00Z',
        blockedVersions: [], dshGo: { adapted: false, features: [] }, screenshots: [],
      },
    } },
  };
}

describe('market test reference-time boundary', () => {
  for (const [elapsed, maxAge] of [[540000, 60], [541000, 59]] as const) {
    it(`after ${elapsed}ms the real response has max-age=${maxAge}`, async () => {
      const t0 = Date.parse('2026-10-30T04:00:00Z');
      const clock = vi.spyOn(Date, 'now').mockReturnValue(t0);
      const pair = catalog();
      const upstream = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) =>
        Response.json(String(input).endsWith('index.json') ? pair.index : pair.sidecar));
      // Separate source URLs prevent the real module's memory snapshot crossing cases.
      const { env } = makeEnv({ MARKET_SOURCE_URL: `https://example.com/clock-diagnostic-${elapsed}/` });
      const first = await run(env, '/market/index.json');
      expect(first.status).toBe(200);
      expect(first.headers.get('cache-control')).toBe('public, max-age=600');
      expect(upstream).toHaveBeenCalledTimes(2);
      clock.mockReturnValue(t0 + elapsed); // one controlled, forward-only time change
      const second = await run(env, '/market/index.json');
      expect(second.status).toBe(200);
      expect(upstream).toHaveBeenCalledTimes(2);
      expect(second.headers.get('cache-control')).toBe(`public, max-age=${maxAge}`);
      if (elapsed === 541000) expect(second.headers.get('cache-control')).not.toBe('public, max-age=60');
    });
  }
});

describe('download test day-reference boundary', () => {
  for (const crossing of [false, true]) {
    it(`records request dates with midnight crossing=${crossing}`, async () => {
      resetBetaCache();
      resetChannelMemo();
      resetStatsMemo();
      resetUsageMemo();
      (globalThis as { caches?: unknown }).caches = { default: new FakeCache() };
      const t0 = Date.parse(crossing ? '2026-10-30T15:59:59.999Z' : '2026-10-30T04:00:00.000Z');
      const clock = vi.spyOn(Date, 'now').mockReturnValue(t0);
      const { env, bucket, downloads } = makeEnv({
        DOWNLOAD_ACCESS: 'public', CN_BASE_URL: 'https://dshgo-cn.oss-cn-hongkong.aliyuncs.com/',
      });
      const manifest = {
        schema: 1, version: '0.9.8+10301000', publishedAt: '2026-10-30T02:00:00Z',
        notesByLocale: { zh: '- 说明', en: '- notes' }, routes: ['global', 'cn', 'github'],
        assets: { arm64: { name: 'dsh-go-0.9.8-arm64.apk', size: 10, sha256: 'ab'.repeat(32) } },
      };
      bucket.objects.set('beta/update.json', {
        bytes: new TextEncoder().encode(JSON.stringify(manifest)), uploaded: new Date(t0), customMetadata: {},
      });
      const routes = ['cn', 'global', 'github'];
      expect((await run(env, '/download/get?via=cn&v=0.9.8')).status).toBe(302);
      expect(downloads.points).toHaveLength(1); // real waitUntil work has settled
      clock.mockReturnValue(t0 + 1); // no wall-clock sleep or production interval change
      for (const route of routes.slice(1)) {
        expect((await run(env, `/download/get?via=${route}&v=0.9.8`)).status).toBe(302);
      }
      expect(downloads.points).toHaveLength(3);
      expect(downloads.points.map((point) => point.blobs[1])).toEqual(routes);
      const dates = downloads.points.map((point) => point.blobs[0]);
      const expected = crossing
        ? ['2026-10-30', '2026-10-31', '2026-10-31']
        : ['2026-10-30', '2026-10-30', '2026-10-30'];
      expect(dates).toEqual(expected);
      const originalTestExpectation = routes.map(() => statsDay());
      if (crossing) expect(dates).not.toEqual(originalTestExpectation);
      else expect(dates).toEqual(originalTestExpectation);
      // No assertion about different random salts or HMAC collision probability.
    });
  }
});
