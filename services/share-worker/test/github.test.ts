// The home page's star count (src/github.ts): GitHub asked from the Worker,
// kept in the edge cache, the last count served while GitHub fails.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import worker from '../src/index';
import { STARS_FRESH_MS, STARS_RETRY_MS, githubStars } from '../src/github';
import { FakeCache, makeCtx, makeEnv } from './fakes';

const ORIGIN = 'https://go.dshtui.com';
const T0 = Date.parse('2026-10-30T02:00:00Z');

let cache: FakeCache;
let github: ReturnType<typeof vi.fn>;
let answer: () => Response | Promise<Response>;

beforeEach(() => {
  cache = new FakeCache();
  (globalThis as { caches?: unknown }).caches = { default: cache };
  answer = () => Response.json({ full_name: 'ccch1mneyyy/dsh-go', stargazers_count: 1234 });
  github = vi.fn(async () => answer());
  vi.stubGlobal('fetch', github);
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  delete (globalThis as { caches?: unknown }).caches;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const get = (method = 'GET') => new Request(`${ORIGIN}/api/github/stars`, { method, headers: { 'CF-Connecting-IP': '198.51.100.1' } });

/** One request at [now], with its cache write settled. */
async function stars(now: number, env = makeEnv().env) {
  const { ctx, settle } = makeCtx();
  const res = await githubStars(get(), env, ctx, now);
  await settle();
  return { status: res.status, body: (await res.json()) as { stars?: number; error?: string }, res };
}

describe('GET /api/github/stars', () => {
  it('coalesces overlapping cold requests into one upstream read', async () => {
    const gate = Promise.withResolvers<void>();
    answer = async () => {
      await gate.promise;
      return Response.json({ stargazers_count: 1234 });
    };
    const env = makeEnv().env;
    const requests = Array.from({ length: 20 }, () => {
      const { ctx, settle } = makeCtx();
      return worker.fetch(get(), env, ctx).then(async (res) => {
        await settle();
        return { status: res.status, body: await res.json() };
      });
    });
    gate.resolve();
    expect(await Promise.all(requests)).toEqual(Array.from({ length: 20 }, () => ({ status: 200, body: { stars: 1234 } })));
    expect(github).toHaveBeenCalledTimes(1);
  });

  it('coalesces failed refreshes while every caller retains its stale count', async () => {
    await stars(T0);
    const gate = Promise.withResolvers<void>();
    answer = async () => {
      await gate.promise;
      return new Response('rate limited', { status: 403 });
    };
    const requests = Array.from({ length: 20 }, () => stars(T0 + STARS_FRESH_MS));
    gate.resolve();
    const results = await Promise.all(requests);
    expect(results.every((r) => r.status === 200 && r.body.stars === 1234)).toBe(true);
    expect(github).toHaveBeenCalledTimes(2); // one initial success, one failed refresh
    await stars(T0 + STARS_FRESH_MS + STARS_RETRY_MS - 1);
    expect(github).toHaveBeenCalledTimes(2);
  });

  it('does not share in-flight upstream authorization between different tokens', async () => {
    const gate = Promise.withResolvers<void>();
    answer = async () => {
      await gate.promise;
      return Response.json({ stargazers_count: 1234 });
    };
    const first = stars(T0, makeEnv({ GITHUB_TOKEN: 'first-test-token' }).env);
    const second = stars(T0, makeEnv({ GITHUB_TOKEN: 'second-test-token' }).env);
    gate.resolve();
    expect((await Promise.all([first, second])).map((r) => r.body)).toEqual([{ stars: 1234 }, { stars: 1234 }]);
    expect(github).toHaveBeenCalledTimes(2);
    const authorization = github.mock.calls.map((call) => new Headers((call as [string, RequestInit])[1].headers).get('Authorization'));
    expect(authorization).toEqual(['Bearer first-test-token', 'Bearer second-test-token']);
  });

  it('releases a failed in-flight read so the next uncached request can retry', async () => {
    delete (globalThis as { caches?: unknown }).caches;
    const gate = Promise.withResolvers<void>();
    answer = async () => {
      await gate.promise;
      throw new TypeError('network down');
    };
    const requests = Array.from({ length: 5 }, () => stars(T0));
    gate.resolve();
    expect((await Promise.all(requests)).every((r) => r.status === 503)).toBe(true);
    expect(github).toHaveBeenCalledTimes(1);
    answer = () => Response.json({ stargazers_count: 1240 });
    expect((await stars(T0 + 1)).body).toEqual({ stars: 1240 });
    expect(github).toHaveBeenCalledTimes(2);
  });

  it('asks GitHub from the Worker and answers {stars}', async () => {
    const { ctx, settle } = makeCtx();
    const res = await worker.fetch(get(), makeEnv().env, ctx);
    await settle();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ stars: 1234 });
    expect(res.headers.get('Content-Type')).toContain('application/json');
    expect(res.headers.get('Cache-Control')).toBe('public, max-age=600');
    expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(res.headers.has('Access-Control-Allow-Origin')).toBe(false);
    expect(github).toHaveBeenCalledTimes(1);
    const [url, init] = github.mock.calls[0]! as [string, RequestInit];
    expect(url).toBe('https://api.github.com/repos/ccch1mneyyy/dsh-go');
    const headers = new Headers(init.headers);
    expect(headers.get('User-Agent')).toMatch(/^dshgo-share/);
    expect(headers.get('Accept')).toBe('application/vnd.github+json');
    expect(headers.has('Authorization')).toBe(false);
    // Nothing about the visitor goes to GitHub.
    expect(JSON.stringify([...headers])).not.toContain('198.51.100.1');
  });

  it('sends GITHUB_TOKEN when it is set', async () => {
    await stars(T0, makeEnv({ GITHUB_TOKEN: 'github_pat_test' }).env);
    expect(new Headers((github.mock.calls[0]! as [string, RequestInit])[1].headers).get('Authorization')).toBe('Bearer github_pat_test');
  });

  it('asks again only after ten minutes', async () => {
    expect((await stars(T0)).body).toEqual({ stars: 1234 });
    answer = () => Response.json({ stargazers_count: 1240 });
    expect((await stars(T0 + STARS_FRESH_MS - 1)).body).toEqual({ stars: 1234 });
    expect(github).toHaveBeenCalledTimes(1);
    expect((await stars(T0 + STARS_FRESH_MS)).body).toEqual({ stars: 1240 });
    expect(github).toHaveBeenCalledTimes(2);
  });

  it('serves the last count while GitHub fails, and retries a minute later', async () => {
    await stars(T0);
    const later = T0 + STARS_FRESH_MS;
    for (const failure of [
      () => new Response('rate limited', { status: 403 }),
      () => Response.json({ message: 'no count here' }),
      () => Promise.reject(new TypeError('network down')),
    ]) {
      answer = failure;
      const calls = github.mock.calls.length;
      const at = later + (calls - 1) * STARS_RETRY_MS;
      const { status, body } = await stars(at);
      expect(status).toBe(200);
      expect(body).toEqual({ stars: 1234 });
      expect(github).toHaveBeenCalledTimes(calls + 1);
      // Within the minute, GitHub isn't asked again.
      await stars(at + STARS_RETRY_MS - 1);
      expect(github).toHaveBeenCalledTimes(calls + 1);
    }
    answer = () => Response.json({ stargazers_count: 1300 });
    expect((await stars(later + 3 * STARS_RETRY_MS)).body).toEqual({ stars: 1300 });
  });

  it('is 503 with no number when nothing was ever counted', async () => {
    answer = () => new Response('nope', { status: 500 });
    const { status, body, res } = await stars(T0);
    expect(status).toBe(503);
    expect(body).toEqual({ error: 'unavailable' });
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    answer = () => Response.json({ stargazers_count: 7 });
    expect((await stars(T0 + 1)).body).toEqual({ error: 'unavailable' });
    expect((await stars(T0 + STARS_RETRY_MS)).body).toEqual({ stars: 7 });
  });

  it('still answers without an edge cache', async () => {
    delete (globalThis as { caches?: unknown }).caches;
    expect((await stars(T0)).body).toEqual({ stars: 1234 });
  });

  it('takes GET only, and its cache entry is not reachable', async () => {
    const env = makeEnv().env;
    const res = await worker.fetch(get('POST'), env, makeCtx().ctx);
    expect(res.status).toBe(405);
    expect(res.headers.get('Allow')).toBe('GET');
    await stars(T0);
    expect(cache.entries.has(`${ORIGIN}/__edge/github/stars`)).toBe(true);
    expect((await worker.fetch(new Request(`${ORIGIN}/__edge/github/stars`), env, makeCtx().ctx)).status).toBe(404);
  });
});
