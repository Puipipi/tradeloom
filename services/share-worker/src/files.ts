// Serving a file from R2: Range (206) for resumed downloads, ETag /
// Last-Modified, and an edge copy (Cache API) for files that never change.
// Callers decide who may read; this only serves.

import type { Env } from './env';

/** Bigger than this isn't put in the edge cache (Cache API limit 512 MB). */
const CACHE_MAX_BYTES = 500 * 1024 * 1024;

/** What an edge copy is stored with, so the Cache API keeps it. */
const CACHED = 'public, max-age=31536000, immutable';

export const COMMON: Record<string, string> = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Robots-Tag': 'noindex, nofollow',
  'Strict-Transport-Security': 'max-age=31536000',
};

export interface Ctx {
  waitUntil(promise: Promise<unknown>): void;
}

export function plain(status: number, text: string, extra: Record<string, string> = {}): Response {
  return new Response(text, {
    status,
    headers: { ...COMMON, 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', ...extra },
  });
}

/** Content-Type and Content-Disposition for a release file. */
export function fileHeaders(name: string): Record<string, string> {
  const lower = name.toLowerCase();
  if (lower.endsWith('.apk')) {
    return {
      'Content-Type': 'application/vnd.android.package-archive',
      'Content-Disposition': `attachment; filename="${name}"`,
    };
  }
  if (lower.endsWith('.json')) return { 'Content-Type': 'application/json; charset=utf-8' };
  if (name === 'SHA256SUMS' || lower.endsWith('.txt')) return { 'Content-Type': 'text/plain; charset=utf-8' };
  return { 'Content-Type': 'application/octet-stream', 'Content-Disposition': `attachment; filename="${name}"` };
}

/** `Range: bytes=a-b | a- | -n` (one range); null for none or anything else. */
export function parseRange(header: string | null): R2Range | null {
  const m = header ? /^bytes=(\d*)-(\d*)$/.exec(header.trim()) : null;
  if (!m || (m[1] === '' && m[2] === '')) return null;
  if (m[1] === '') return { suffix: Number(m[2]) };
  const offset = Number(m[1]);
  if (m[2] === '') return { offset };
  const end = Number(m[2]);
  return end < offset ? null : { offset, length: end - offset + 1 };
}

const warming = new Set<string>();

/** Fills the edge cache with the whole file, off the request's path. */
async function warm(env: Env, key: string, cacheKey: string, headers: Headers): Promise<void> {
  if (warming.has(key)) return;
  warming.add(key);
  try {
    const object = await env.BUCKET.get(key);
    if (!object) return;
    const h = new Headers(headers);
    h.set('Content-Length', String(object.size));
    h.set('Cache-Control', CACHED);
    h.delete('X-Cache');
    await caches.default.put(new Request(cacheKey), new Response(object.body, { status: 200, headers: h }));
  } catch {
    // Next full download tries again.
  } finally {
    warming.delete(key);
  }
}

export interface ServeOptions {
  /** R2 key. */
  key: string;
  /** File name for the headers. */
  name: string;
  /** Sent to the client. */
  cacheControl: string;
  /** Keeps an edge copy under this URL (an internal one: callers check access
   *  before every lookup). Only for files that never change. */
  edgeKey?: string;
}

/** Syntax only. The cursor only advances, including through empty list members. */
function validTagList(value: string, tags?: string[]): boolean {
  if (value === '*') return true;
  let i = 0;
  let found = false;
  while (i < value.length) {
    while (value[i] === ' ' || value[i] === '\t' || value[i] === ',') i++;
    if (i === value.length) break;
    if (value.startsWith('W/', i)) i += 2;
    const start = i;
    if (value[i++] !== '"') return false;
    while (i < value.length && value[i] !== '"') {
      const c = value.charCodeAt(i++);
      if (!(c === 0x21 || c >= 0x23 && c <= 0x7e || c >= 0x80 && c <= 0xff)) return false;
    }
    if (i === value.length) return false;
    i++;
    tags?.push(value.slice(start, i));
    found = true;
    while (value[i] === ' ' || value[i] === '\t') i++;
    if (i < value.length && value[i] !== ',') return false;
  }
  return found;
}

/** Weak cache comparison of complete opaque tags. A comma or '*' inside one
 *  quoted tag is data, not a list separator or wildcard. Keep the same syntax
 *  parser used by R2 conditional reads; malformed lists never partially match.
 */
export function matchesEtag(value: string | null | undefined, etag: string): boolean {
  if (value == null) return false;
  const text = value.replace(/^[ \t]+|[ \t]+$/g, ''), tags: string[] = [];
  return validTagList(text, tags) && (text === '*' || tags.includes(etag.replace(/^W\//, '')));
}

/** RFC 9110 sections 5.6.7/13.1.3: HTTP-date has three wire formats, not the
 *  arbitrary ISO/year strings accepted by Date.parse. Calendar/weekday semantics
 *  follow RFC 5322 section 3.3; RFC 850's short year uses the future-50-year rule.
 *  Existing streamed R2 responses continue to use R2's condition evaluator.
 */
export function parseHttpDate(value: string | null, now = Date.now()): number | null {
  if (value === null) return null;
  const text = value.replace(/^[ \t]+|[ \t]+$/g, '');
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const longDays = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  let parts: string[], shortYear = false;
  let match = /^([A-Za-z]{3}), (\d{2}) ([A-Za-z]{3}) (\d{4}) (\d{2}):(\d{2}):(\d{2}) GMT$/.exec(text);
  if (match) parts = match.slice(1);
  else if ((match = /^([A-Za-z]+), (\d{2})-([A-Za-z]{3})-(\d{2}) (\d{2}):(\d{2}):(\d{2}) GMT$/.exec(text))) {
    if (!longDays.includes(match[1]!)) return null;
    parts = match.slice(1); parts[0] = parts[0]!.slice(0, 3); shortYear = true;
  } else if ((match = /^([A-Za-z]{3}) ([A-Za-z]{3}) ( \d|\d{2}) (\d{2}):(\d{2}):(\d{2}) (\d{4})$/.exec(text))) {
    parts = [match[1]!, match[3]!, match[2]!, match[7]!, match[4]!, match[5]!, match[6]!];
  } else return null;
  const weekday = days.indexOf(parts[0]!), day = Number(parts[1]), month = months.indexOf(parts[2]!);
  let year = Number(parts[3]);
  const hour = Number(parts[4]), minute = Number(parts[5]), second = Number(parts[6]);
  if (weekday < 0 || month < 0 || day < 1 || day > 31 || hour > 23 || minute > 59 || second > 60) return null;
  if (shortYear) {
    if (!Number.isFinite(now)) return null;
    const current = new Date(now), limit = new Date(now);
    year += Math.floor(current.getUTCFullYear() / 100) * 100;
    limit.setUTCFullYear(current.getUTCFullYear() + 50);
    const candidate = Date.UTC(year, month, day, hour, minute, Math.min(second, 59)) + (second === 60 ? 1000 : 0);
    if (candidate > limit.getTime()) year -= 100;
  }
  if (year < 1900) return null;
  const date = new Date(Date.UTC(year, month, day, hour, minute, Math.min(second, 59)));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month || date.getUTCDate() !== day || date.getUTCDay() !== weekday) return null;
  return date.getTime() + (second === 60 ? 1000 : 0);
}

/** Only cache validators: other preconditions must not become a 304. */
export function validators(request: Request): Headers | undefined {
  const headers = new Headers();
  const tag = request.headers.get('If-None-Match')?.replace(/^[ \t]+|[ \t]+$/g, '');
  if (tag !== undefined) {
    // R2 rejects malformed ETags. Ignore those as before; comparison itself
    // (including weak tags, quoted commas and empty list members) belongs to R2.
    if (!validTagList(tag)) return;
    headers.set('If-None-Match', tag);
  } else {
    const modified = request.headers.get('If-Modified-Since');
    if (!modified) return;
    headers.set('If-Modified-Since', modified);
  }
  return headers;
}

export async function serveObject(request: Request, env: Env, ctx: Ctx, options: ServeOptions): Promise<Response> {
  const { key, name, cacheControl, edgeKey } = options;
  const head = request.method === 'HEAD';
  const edge = edgeKey && typeof caches !== 'undefined' ? caches.default : null;

  if (edge && edgeKey && !head) {
    const lookup = new Headers();
    for (const h of ['Range', 'If-None-Match', 'If-Modified-Since']) {
      const v = request.headers.get(h);
      if (v) lookup.set(h, v);
    }
    const hit = await edge.match(new Request(edgeKey, { headers: lookup }));
    if (hit) {
      const res = new Response(hit.body, hit);
      res.headers.set('Cache-Control', cacheControl);
      res.headers.set('X-Cache', 'HIT');
      return res;
    }
  }

  const headers = new Headers({ ...COMMON, ...fileHeaders(name), 'Cache-Control': cacheControl, 'Accept-Ranges': 'bytes' });
  const onlyIf = validators(request);
  if (head && !onlyIf) {
    const object = await env.BUCKET.head(key);
    if (!object) return plain(404, 'Not found');
    headers.set('Content-Length', String(object.size));
    headers.set('ETag', object.httpEtag);
    headers.set('Last-Modified', object.uploaded.toUTCString());
    return new Response(null, { status: 200, headers });
  }

  const range = head ? null : parseRange(request.headers.get('Range'));
  let object: R2ObjectBody | R2Object | null;
  try {
    object = await env.BUCKET.get(key, { ...(range ? { range } : {}), ...(onlyIf ? { onlyIf } : {}) });
  } catch (error) {
    // Only R2 InvalidRange (10039) belongs to the 416/reset path.
    if (!range || !(error instanceof Error) || !error.message.endsWith('(10039)')) throw error;
    const meta = await env.BUCKET.head(key);
    if (!meta) return plain(404, 'Not found');
    return plain(416, 'Range not satisfiable', { 'Content-Range': `bytes */${meta.size}` });
  }
  if (!object) return plain(404, 'Not found');
  headers.set('ETag', object.httpEtag);
  headers.set('Last-Modified', object.uploaded.toUTCString());
  headers.set('X-Cache', 'MISS');

  if (!('body' in object)) return new Response(null, { status: 304, headers });
  if (head) {
    await object.body.cancel().catch(() => {});
    headers.set('Content-Length', String(object.size));
    return new Response(null, { status: 200, headers });
  }

  const size = object.size;
  if (range) {
    let start: number;
    let end: number;
    if ('suffix' in range) {
      start = Math.max(0, size - range.suffix);
      end = size - 1;
    } else {
      start = range.offset ?? 0;
      end = range.length !== undefined ? Math.min(size - 1, start + range.length - 1) : size - 1;
    }
    if (start >= size) {
      await object.body.cancel().catch(() => {});
      return plain(416, 'Range not satisfiable', { 'Content-Range': `bytes */${size}` });
    }
    headers.set('Content-Range', `bytes ${start}-${end}/${size}`);
    headers.set('Content-Length', String(end - start + 1));
    return new Response(object.body, { status: 206, headers });
  }

  headers.set('Content-Length', String(size));
  if (edge && edgeKey && size <= CACHE_MAX_BYTES) ctx.waitUntil(warm(env, key, edgeKey, headers));
  return new Response(object.body, { status: 200, headers });
}
