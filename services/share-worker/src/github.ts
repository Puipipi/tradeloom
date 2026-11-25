// The repository's star count for the home page: GET /api/github/stars →
// {"stars": 123}.
//
// GitHub is asked from here, never from the visitor's browser: visitors' IPs
// don't reach GitHub and the page needs no connect-src beyond 'self'. Each
// colo keeps the answer in the edge cache and asks GitHub again after
// 10 minutes (after a minute when GitHub failed); until then, and whenever
// GitHub fails, it serves the last count. Never counted: 503, and the page
// shows the bubble without a number.
//
// Unauthenticated, GitHub allows 60 requests an hour per IP, and Workers share
// egress IPs; the optional GITHUB_TOKEN secret (any token, no scopes needed)
// raises that to 5000 an hour.

import { json } from './api';
import type { Env } from './env';
import type { Ctx } from './files';
import { GITHUB_REPO } from './routes';

export const STARS_FRESH_MS = 10 * 60_000;
export const STARS_RETRY_MS = 60_000;
/** How long the edge keeps the last count, served while GitHub fails. */
const KEEP_S = 30 * 86_400;
/** Not reachable from outside: /__edge/ is 404 (src/index.ts). */
const EDGE_KEY = '/__edge/github/stars';

interface Entry {
  stars: number | null;
  /** When to ask GitHub again (ms). */
  next: number;
}

async function ask(env: Env): Promise<number | null> {
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'dshgo-share (+https://go.dshtui.com)',
    'X-GitHub-Api-Version': '2022-11-28',
  };
  if (env.GITHUB_TOKEN) headers.Authorization = `Bearer ${env.GITHUB_TOKEN}`;
  try {
    const res = await fetch(`https://api.github.com/repos/${GITHUB_REPO}`, { headers, signal: AbortSignal.timeout(5000) });
    if (!res.ok) {
      void res.body?.cancel().catch(() => {});
      console.error('github stars', res.status);
      return null;
    }
    const stars = ((await res.json()) as { stargazers_count?: unknown }).stargazers_count;
    return typeof stars === 'number' && Number.isInteger(stars) && stars >= 0 ? stars : null;
  } catch (e) {
    console.error('github stars', e instanceof Error ? e.message : String(e));
    return null;
  }
}

// Share only the decoded count, never a request-owned Response or stream.
// Authorization belongs to the binding, so different configured tokens stay separate.
const pending = new Map<string, Promise<number | null>>();

function refresh(env: Env, ctx: Ctx): Promise<number | null> {
  const key = env.GITHUB_TOKEN ?? '';
  const existing = pending.get(key);
  if (existing) return existing;
  const task = ask(env).finally(() => {
    if (pending.get(key) === task) pending.delete(key);
  });
  pending.set(key, task);
  // Keep the originating request's I/O alive if its client disconnects while
  // another request is awaiting the count. ask retains its existing 5s timeout.
  ctx.waitUntil(task);
  return task;
}

export async function githubStars(request: Request, env: Env, ctx: Ctx, now = Date.now()): Promise<Response> {
  if (request.method !== 'GET') return json(405, { error: 'method_not_allowed' }, { Allow: 'GET' });
  const cache = typeof caches !== 'undefined' ? caches.default : null;
  const key = new Request(new URL(EDGE_KEY, request.url));
  const hit = await cache?.match(key);
  let entry = hit ? ((await hit.json()) as Entry) : null;
  if (!entry || now >= entry.next) {
    const stars = await refresh(env, ctx);
    entry = stars === null ? { stars: entry?.stars ?? null, next: now + STARS_RETRY_MS } : { stars, next: now + STARS_FRESH_MS };
    if (cache) {
      const body = new Response(JSON.stringify(entry), { headers: { 'Content-Type': 'application/json', 'Cache-Control': `max-age=${KEEP_S}` } });
      ctx.waitUntil(cache.put(key, body).catch(() => {}));
    }
  }
  if (entry.stars === null) return json(503, { error: 'unavailable' }, { 'Retry-After': '60' });
  return json(200, { stars: entry.stars }, { 'Cache-Control': 'public, max-age=600' });
}
