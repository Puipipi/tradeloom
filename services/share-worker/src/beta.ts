// Beta builds behind an access key:
//
//   GET  /beta                      the page: key in, the release card out (src/download-page.ts)
//   POST /beta/api/unlock           {key, lang?} → the latest build, its routes, a signed link (10 min)
//   GET  /beta/<version>/<file>     ?exp&sig (signed link), or Authorization: Bearer <channel token>
//   GET  /beta/update.json          the app's update manifest; channel token only
//
// With DOWNLOAD_ACCESS=public the page moves to /download (src/download.ts)
// and /beta redirects there; the rest stays as it is.
//
// R2: beta/update.json (latest; goes up last), beta/<version>/<file>.
// Written by scripts/publish-release.sh; grants by scripts/beta-keys.sh.
// Without BETA_SECRET everything here is 404 (apart from that redirect).

import type { Env } from './env';
import { readCapped } from './api';
import { channelAuthorized, grantActive, linkAuthorized, lookupKey, signLink } from './beta-auth';
import { guard } from './beta-guard';
import { PAGE_SCRIPT, asLang, lockPage, pageResponse, pickLang, releaseCard } from './download-page';
import { accessMode } from './download';
import { COMMON, type Ctx, plain, serveObject } from './files';
import { burstAllowed, clientKey } from './limits';
import { type RouteId, countryOf, parseRoutes, pickRoute, routesFor } from './routes';
import { countCheck } from './stats';

export const BETA_PREFIX = 'beta/';
export const BETA_MANIFEST = `${BETA_PREFIX}update.json`;

export const VERSION = /^[0-9][0-9A-Za-z.-]{0,39}$/;
export const FILE = /^[0-9A-Za-z][0-9A-Za-z._+-]{0,119}$/;
const FILE_PATH = /^\/beta\/([^/]+)\/([^/]+)$/;
const NO_STORE = 'private, no-store';

/** Edge copies live under this path of our own origin. Requests there reach
 *  the Worker (a custom domain runs it before any cache) and get 404; the copy
 *  is only looked up after an access check. /download (public mode) shares it. */
const EDGE_PATH = '/__edge/beta/';

export function edgeKey(origin: string, version: string, name: string): string {
  return `${origin}${EDGE_PATH}${version}/${name}`;
}

export function isBetaPath(path: string): boolean {
  return path === '/beta' || path.startsWith('/beta/');
}

function json(status: number, body: unknown, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...COMMON,
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'Cross-Origin-Resource-Policy': 'same-origin',
      ...extra,
    },
  });
}

/** WeChat and QQ's in-app browsers don't download APKs. */
export function inAppBrowser(request: Request): boolean {
  return /MicroMessenger|\sQQ\//i.test(request.headers.get('User-Agent') ?? '');
}

// ── The latest build ─────────────────────────────────────────────────────

interface Manifest {
  version?: unknown;
  publishedAt?: unknown;
  notes?: unknown;
  notesByLocale?: { zh?: unknown; en?: unknown };
  assets?: Record<string, { name?: unknown; size?: unknown; sha256?: unknown }>;
  /** Where publish-release.sh put the files besides R2 (and checked them). */
  routes?: unknown;
}

export interface Build {
  version: string;
  build: string | null;
  name: string;
  size: number;
  sha256: string;
  publishedAt: string | null;
  notes: { zh: string; en: string };
  /** Routes the files are on (src/routes.ts); always includes global. */
  routeIds: RouteId[];
  /** On the public download bucket too (`dl` in `routes`). */
  onDl: boolean;
}

interface LatestEntry {
  memo?: { at: number; build: Build | null };
  pending?: Promise<Build | null>;
}
let latest = new WeakMap<R2Bucket, LatestEntry>();

/** For tests. */
export function resetBetaCache(): void {
  latest = new WeakMap();
}

/** The arm64 build in beta/update.json; null when nothing is published. */
export async function latestBuild(env: Env, ctx: Ctx, now = Date.now()): Promise<Build | null> {
  let entry = latest.get(env.BUCKET);
  if (!entry) { entry = {}; latest.set(env.BUCKET, entry); }
  if (entry.memo && now - entry.memo.at < 30_000) return entry.memo.build;
  if (entry.pending) return entry.pending;
  const owner = entry;
  const task = (async () => {
    let build: Build | null = null;
    try {
      const object = await env.BUCKET.get(BETA_MANIFEST);
      if (object) build = toBuild(JSON.parse(await object.text()) as Manifest);
    } catch {
      build = null;
    }
    // Preserve the existing 30s memo, including a missing/unreadable release.
    owner.memo = { at: now, build };
    return build;
  })().finally(() => { if (owner.pending === task) delete owner.pending; });
  owner.pending = task;
  // Only the decoded Build crosses requests; retain the initiating R2 read.
  ctx.waitUntil(task);
  return task;
}

function toBuild(m: Manifest): Build | null {
  const full = typeof m.version === 'string' ? m.version : '';
  const [version, code] = full.split('+');
  const asset = m.assets?.arm64;
  const name = typeof asset?.name === 'string' ? asset.name : '';
  const size = typeof asset?.size === 'number' ? asset.size : NaN;
  const sha256 = typeof asset?.sha256 === 'string' ? asset.sha256.toLowerCase() : '';
  if (!version || !VERSION.test(version) || !FILE.test(name) || !Number.isFinite(size) || !/^[0-9a-f]{64}$/.test(sha256)) return null;
  const text = (v: unknown) => (typeof v === 'string' ? v : '');
  const all = text(m.notes);
  return {
    version,
    build: code && /^\d+$/.test(code) ? code : null,
    name,
    size,
    sha256,
    publishedAt: typeof m.publishedAt === 'string' ? m.publishedAt : null,
    notes: { zh: text(m.notesByLocale?.zh) || all, en: text(m.notesByLocale?.en) || all },
    routeIds: parseRoutes(m.routes),
    onDl: Array.isArray(m.routes) && m.routes.includes('dl'),
  };
}

// ── Routes ───────────────────────────────────────────────────────────────

async function readBody(request: Request): Promise<{ key?: unknown; lang?: unknown }> {
  // A 1024-code-unit UTF-8 body fits below this bound, including its optional BOM.
  const bytes = await readCapped(request, 4096).catch(() => null);
  if (!bytes) return {};
  const text = new TextDecoder().decode(bytes);
  if (text.length > 1024) return {};
  try {
    const body = JSON.parse(text) as unknown;
    return typeof body === 'object' && body !== null ? body : {};
  } catch {
    return {};
  }
}

async function unlock(request: Request, env: Env, ctx: Ctx): Promise<Response> {
  const ip = clientKey(request);
  if (!(await burstAllowed(env.READ_LIMIT, `beta-unlock:${ip}`))) return json(429, { error: 'too_many_attempts' }, { 'Retry-After': '60' });
  const busy = () => json(429, { error: 'too_many_attempts' }, { 'Retry-After': '600' });
  if ((await guard(env, ip, 'check'))?.blocked) return busy();

  const body = await readBody(request);
  const grant = await lookupKey(env, body.key ?? null);
  if (!grantActive(grant)) {
    // Five wrong keys, then ten minutes of nothing (src/beta-guard.ts).
    const counted = await guard(env, ip, 'fail');
    console.log('beta wrong key', counted?.count ?? 'uncounted');
    if (counted?.blocked) return busy();
    // Unknown, revoked and expired keys all read the same.
    return json(403, { error: 'invalid_key' });
  }

  const build = await latestBuild(env, ctx);
  if (!build) return json(404, { error: 'no_release' });
  const link = await signLink(env.BETA_SECRET!, `/beta/${build.version}/${build.name}`);
  const routes = routesFor(env, build, link.url);
  const selected = pickRoute(routes, countryOf(request));
  const card = releaseCard(asLang(body.lang) ?? pickLang(request), { build, routes, selected });
  console.log('beta unlock', grant!.label, build.version);
  return json(200, { ...build, url: link.url, expiresAt: link.expiresAt, routes, selected, card });
}

function unauthorized(): Response {
  return plain(401, 'Unauthorized', { 'WWW-Authenticate': 'Bearer realm="dsh-go beta"' });
}

export async function beta(request: Request, env: Env, ctx: Ctx): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method;
  // Old links to the page (group notices) go to the public one. 302: the
  // switch can be turned back.
  if ((path === '/beta' || path === '/beta/') && accessMode(env) === 'public' && (method === 'GET' || method === 'HEAD')) {
    return new Response(null, { status: 302, headers: { ...COMMON, Location: `/download${url.search}`, 'Cache-Control': 'no-store' } });
  }
  if (!env.BETA_SECRET) return plain(404, 'Not found');

  if (path === '/beta/api/unlock') {
    return method === 'POST' ? unlock(request, env, ctx) : json(405, { error: 'method_not_allowed' }, { Allow: 'POST' });
  }
  if (method !== 'GET' && method !== 'HEAD') return plain(405, 'Method not allowed', { Allow: 'GET, HEAD' });

  if (path === '/beta') return pageResponse(request, lockPage(pickLang(request), inAppBrowser(request)));
  if (path === '/beta/') return new Response(null, { status: 301, headers: { ...COMMON, Location: '/beta', 'Cache-Control': 'no-store' } });
  if (path === '/beta/beta.js') {
    return new Response(method === 'HEAD' ? null : PAGE_SCRIPT, {
      headers: { ...COMMON, 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-cache' },
    });
  }

  if (!(await burstAllowed(env.READ_LIMIT, `beta:${clientKey(request)}`))) return plain(429, 'Too many requests', { 'Retry-After': '60' });

  if (path === '/beta/update.json') {
    if (!(await channelAuthorized(env, request))) return unauthorized();
    // An installed app checking for updates: the near-daily-active count.
    if (method === 'GET') ctx.waitUntil(countCheck(env, request));
    return serveObject(request, env, ctx, { key: BETA_MANIFEST, name: 'update.json', cacheControl: NO_STORE });
  }

  const m = FILE_PATH.exec(path);
  if (!m) return plain(404, 'Not found');
  let version: string;
  let name: string;
  try {
    version = decodeURIComponent(m[1]!);
    name = decodeURIComponent(m[2]!);
  } catch {
    return plain(404, 'Not found');
  }
  if (!VERSION.test(version) || !FILE.test(name)) return plain(404, 'Not found');
  const signed = url.searchParams.has('sig');
  const allowed = signed ? await linkAuthorized(env, url) : await channelAuthorized(env, request);
  if (!allowed) return signed ? plain(403, '链接已过期，请回到 /beta 重新获取。\nThis link has expired.\n') : unauthorized();
  return serveObject(request, env, ctx, {
    key: `${BETA_PREFIX}${version}/${name}`,
    name,
    cacheControl: NO_STORE,
    // update.json in a version directory could be rewritten; APKs never are.
    edgeKey: name.endsWith('.apk') ? edgeKey(url.origin, version, name) : undefined,
  });
}
