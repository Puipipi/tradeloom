// The public download page, for when anyone may download (DOWNLOAD_ACCESS=public):
//
//   GET /download                     the page: the latest build on every route, no key
//   GET /download/get?via=&v=         a download button: counted (src/stats.ts), then 302
//                                     to the route's real URL; HEAD isn't counted
//   GET /download/<version>/<file>    the APK or SHA256SUMS from R2: edge copy, Range,
//                                     cacheable by browsers. The Global route's file until
//                                     a release is on the public bucket (DL_BASE_URL);
//                                     kept for the links already out there
//
// The files are the beta channel's (R2 beta/<version>/), put there by
// scripts/publish-release.sh. With the default DOWNLOAD_ACCESS=key all of
// /download is 404, as it has been since the old public mirror was retired,
// and the page is /beta behind an access key. The app's channel (/beta/update.json,
// token downloads) and signed links work the same either way.

import { type Build, FILE, VERSION, edgeKey, inAppBrowser, latestBuild } from './beta';
import { type Mode, pageResponse, pickLang, publicPage } from './download-page';
import type { Env } from './env';
import { COMMON, type Ctx, plain, serveObject } from './files';
import { burstAllowed, clientKey } from './limits';
import { type Route, countryOf, dlUrl, pickRoute, routesFor } from './routes';
import { countDownload } from './stats';

/** DOWNLOAD_ACCESS: "public" opens /download; anything else keeps the key. */
export function accessMode(env: Env): Mode {
  return env.DOWNLOAD_ACCESS?.trim().toLowerCase() === 'public' ? 'public' : 'key';
}

export function isDownloadPath(path: string): boolean {
  return path === '/download' || path.startsWith('/download/');
}

const FILE_PATH = /^\/download\/([^/]+)\/([^/]+)$/;

/** APKs never change under a version (publish-release.sh refuses), so
 *  browsers may keep them; SHA256SUMS is small, an hour is plenty. */
export const PUBLIC_APK_CACHE = 'public, max-age=31536000, immutable';
export const PUBLIC_SUMS_CACHE = 'public, max-age=3600';

/** The Global route's file: on the public bucket (no Worker in between) when it's there. */
const globalUrl = (env: Env, build: Build) =>
  dlUrl(env, build) ?? `/download/${encodeURIComponent(build.version)}/${encodeURIComponent(build.name)}`;
const getUrl = (route: Route, version: string) => `/download/get?via=${route.id}&v=${encodeURIComponent(version)}`;

function found(location: string): Response {
  return new Response(null, { status: 302, headers: { ...COMMON, Location: location, 'Cache-Control': 'no-store' } });
}

/** A download button: count the click, then send it where the file is. Only
 *  the latest build's offered routes; anything else goes back to the page,
 *  uncounted (a page left open across a release, a made-up link). */
async function get(request: Request, env: Env, ctx: Ctx, url: URL): Promise<Response> {
  const via = url.searchParams.get('via');
  const build = await latestBuild(env, ctx);
  const route = build && url.searchParams.get('v') === build.version ? routesFor(env, build, globalUrl(env, build)).find((r) => r.id === via) : undefined;
  if (!build || !route) return found(via && /^(cn|global|github)$/.test(via) ? `/download?via=${via}` : '/download');
  // HEAD (publish-release.sh checking the links) and floods aren't counted;
  // the redirect happens either way.
  if (request.method === 'GET' && (await burstAllowed(env.READ_LIMIT, `dlc:${clientKey(request)}`))) {
    ctx.waitUntil(countDownload(env, request, route.id, build.version));
  }
  return found(route.url);
}

export async function download(request: Request, env: Env, ctx: Ctx): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;
  if (request.method !== 'GET' && request.method !== 'HEAD') return plain(405, 'Method not allowed', { Allow: 'GET, HEAD' });

  if (path === '/download') {
    const inApp = inAppBrowser(request);
    const build = inApp ? null : await latestBuild(env, ctx);
    let card = null;
    if (build) {
      // The buttons go through /download/get, which counts and redirects.
      const routes = routesFor(env, build, globalUrl(env, build)).map((r) => ({ id: r.id, url: getUrl(r, build.version) }));
      card = { build, routes, selected: pickRoute(routes, countryOf(request), url.searchParams.get('via')) };
    }
    return pageResponse(request, publicPage(pickLang(request), inApp, card));
  }
  if (path === '/download/get') return get(request, env, ctx, url);
  if (path === '/download/') {
    return new Response(null, { status: 301, headers: { ...COMMON, Location: `/download${url.search}`, 'Cache-Control': 'no-store' } });
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
  const apk = name.endsWith('.apk');
  if (!VERSION.test(version) || !FILE.test(name) || !(apk || name === 'SHA256SUMS')) return plain(404, 'Not found');
  if (!(await burstAllowed(env.READ_LIMIT, `dl:${clientKey(request)}`))) return plain(429, 'Too many requests', { 'Retry-After': '60' });
  return serveObject(request, env, ctx, {
    key: `beta/${version}/${name}`,
    name,
    cacheControl: apk ? PUBLIC_APK_CACHE : PUBLIC_SUMS_CACHE,
    edgeKey: apk ? edgeKey(url.origin, version, name) : undefined,
  });
}
