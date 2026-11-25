// Where a build can be downloaded from, and which of those a visitor gets
// first (docs/design/share-links.md §14「下载线路」):
//
//   cn      the Hong Kong bucket (CN_BASE_URL), fast from mainland China
//   global  Cloudflare, fast everywhere else: the public bucket at DL_BASE_URL
//           (dl.dshtui.com/download/<version>/<file>) when the release is
//           there, else R2 through this Worker
//   github  the release on GitHub (github.com/<repo>/releases/download/v<version>/<file>)
//
// A route is offered only when the release went up there (the manifest's
// `routes`, written by scripts/publish-release.sh after it downloaded the
// files back) and, for cn, when CN_BASE_URL is set. global is always there;
// `dl` in `routes` says its files are on the public bucket too.

import type { Env } from './env';

export type RouteId = 'cn' | 'global' | 'github';

/** Page order. */
export const ROUTE_IDS: readonly RouteId[] = ['cn', 'global', 'github'];

export interface Route {
  id: RouteId;
  url: string;
}

/** The public repository the GitHub route points at (docs/release.md). */
export const GITHUB_REPO = 'ccch1mneyyy/dsh-go';

/** `<base>/` of a bucket's public URL, or null when it isn't configured (or isn't https). */
function baseUrl(value: string | undefined): string | null {
  const raw = value?.trim();
  if (!raw) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && (url.hostname === '127.0.0.1' || url.hostname === 'localhost'))) return null;
  if (url.search || url.hash || url.username || url.password) return null;
  return url.toString().replace(/\/*$/, '/');
}

/** `<base>/` for the China route, or null when it isn't configured. */
export function cnBase(env: Env): string | null {
  return baseUrl(env.CN_BASE_URL);
}

/** The routes in a manifest's `routes`; anything else is dropped. global is implied. */
export function parseRoutes(value: unknown): RouteId[] {
  const listed = Array.isArray(value) ? value : [];
  return ROUTE_IDS.filter((id) => id === 'global' || listed.includes(id));
}

const path = (version: string, name: string) => `${encodeURIComponent(version)}/${encodeURIComponent(name)}`;

export function githubUrl(version: string, name: string): string {
  return `https://github.com/${GITHUB_REPO}/releases/download/v${path(version, name)}`;
}

/** The file on the public download bucket, when the release went up there and DL_BASE_URL is set. */
export function dlUrl(env: Env, build: { version: string; name: string; onDl: boolean }): string | null {
  const base = build.onDl ? baseUrl(env.DL_BASE_URL) : null;
  return base && `${base}download/${path(build.version, build.name)}`;
}

/** The routes to offer for [name] of [version]; [global] is the Global route's URL for it (src/download.ts). */
export function routesFor(env: Env, build: { version: string; name: string; routeIds: readonly RouteId[] }, global: string): Route[] {
  const routes: Route[] = [];
  for (const id of ROUTE_IDS) {
    if (id === 'global') routes.push({ id, url: global });
    else if (!build.routeIds.includes(id)) continue;
    else if (id === 'cn') {
      const base = cnBase(env);
      if (base) routes.push({ id, url: base + path(build.version, build.name) });
    } else routes.push({ id, url: githubUrl(build.version, build.name) });
  }
  return routes;
}

/** Two-letter country code Cloudflare puts on the request, upper case; null when absent. */
export function countryOf(request: Request): string | null {
  const country = (request as { cf?: { country?: unknown } }).cf?.country;
  return typeof country === 'string' && /^[A-Za-z]{2}$/.test(country) ? country.toUpperCase() : null;
}

/** `?via=` when it names an offered route; else cn for mainland China (when
 *  offered); else global. */
export function pickRoute(routes: readonly Route[], country: string | null, requested?: string | null): RouteId {
  const has = (id: string | null | undefined): id is RouteId => !!id && routes.some((r) => r.id === id);
  if (has(requested)) return requested;
  if (country === 'CN' && has('cn')) return 'cn';
  return 'global';
}
