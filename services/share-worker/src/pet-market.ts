import type { Env } from './env';
import { COMMON, matchesEtag, parseHttpDate, parseRange, serveObject, validators, type Ctx } from './files';
import { marketSource } from './market';
import {
  type Catalog, type CatalogKind, type PetEntry, type AdapterEntry, INDEX_CAP,
  entries, entryId, revoked, validateAdapter, withdrawalKey,
} from './pet-catalog';
import { failureCode, mirrorAsset, PetMarketError, readBounded, readStoredJson, upstream, type MarketAsset, type StoredJson } from './pet-market-io';
import { loadPublication, nextPublication, parseCatalog, publicationKey } from './pet-market-state';
import { resumeStage, saveStage, STAGE_ASSETS } from './pet-market-stage';

interface Snapshot { text: string; catalog: Catalog; etag: string }
const memory = new WeakMap<Env, Map<CatalogKind, Snapshot>>();
const headers = {
  ...COMMON, 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*',
  'Access-Control-Expose-Headers': 'ETag, Content-Length, Content-Range, X-Market-Stale',
};
const failure = (status: number, code: string, head = false) => new Response(head ? null : JSON.stringify({ error: code }), {
  status, headers: { ...headers, 'Cache-Control': 'no-store', ...(status === 503 ? { 'Retry-After': '60' } : {}) },
});

function remember(env: Env, kind: CatalogKind, value: Snapshot): void {
  let saved = memory.get(env);
  if (!saved) memory.set(env, saved = new Map());
  // Only the public view is cached; readers never authorize from cached history.
  saved.set(kind, { text: value.text, catalog: value.catalog, etag: value.etag });
}
function assets(entry: PetEntry | AdapterEntry): [MarketAsset, string][] {
  return 'id' in entry ? [[entry, 'application/zip'], [entry.preview.png, 'image/png'], [entry.preview.gif, 'image/gif']]
    : [[entry, 'application/json; charset=utf-8']];
}
function assertForward(previous: Snapshot | null, candidate: { text: string; catalog: Catalog }): void {
  const timestamp = Date.parse(candidate.catalog.generatedAt);
  if (timestamp > Date.now() + 120_000) throw new PetMarketError('future-catalog');
  if (!previous) return;
  const oldTime = Date.parse(previous.catalog.generatedAt);
  if (timestamp < oldTime || timestamp === oldTime && candidate.text !== previous.text)
    throw new PetMarketError('catalog-rollback');
  const withdrawn = new Set(candidate.catalog.withdrawn.map(withdrawalKey));
  if (previous.catalog.withdrawn.some(w => !withdrawn.has(withdrawalKey(w))))
    throw new PetMarketError('withdrawal-rollback');
  const next = new Map(entries(candidate.catalog).map(e => [entryId(e), e]));
  for (const old of entries(previous.catalog)) {
    const row = next.get(entryId(old));
    if (!row && !revoked(candidate.catalog, entryId(old), old.version)) throw new PetMarketError('missing-withdrawal');
    if ('id' in old) for (const blocked of old.blockedVersions) {
      if (!('blockedVersions' in (row ?? {})) || !(row as PetEntry).blockedVersions.includes(blocked)) {
        if (!revoked(candidate.catalog, old.id, blocked)) throw new PetMarketError('blocked-version-rollback');
      }
    }
  }
}

function transferBudget(): (size: number) => void {
  let transfers = 0, bytes = 0;
  return size => {
    // Resumable staging across cron runs, shared across both catalogs. The
    // scheduled run also needs two plugin and two companion index fetches.
    if (transfers >= 24 || bytes + size > 256 * 1024 * 1024) throw new PetMarketError('stage-budget');
    transfers++; bytes += size;
  };
}
/** One envelope is one R2 compare-and-swap: catalogue + lifetime release
 *  bindings commit together. Staging failures or CAS losers create no history.
 *  Verified, unlisted resources may remain. No second public index is written;
 *  the HTTP route projects the authoritative envelope. No upstream reader fetch.
 */
export async function publishPetCatalog(env: Env, kind: CatalogKind, budget = transferBudget()): Promise<void> {
  const base = marketSource(env);
  const response = await upstream(base, `${kind}.json`, INDEX_CAP);
  const candidate = parseCatalog(await readBounded(response.body!, INDEX_CAP), kind);
  const previous = await loadPublication(env, kind);
  assertForward(previous, candidate);
  const unchanged = previous?.text === candidate.text;
  const stateText = nextPublication(previous, candidate, kind);
  // Preserve the validated catalogue order: exact candidate bytes and the
  // build-generated validation profile bind the durable cursor to this list.
  const pending = entries(candidate.catalog).flatMap(entry => assets(entry).map(([asset, type]) => ({ entry, asset, type })));
  const stage = await resumeStage(env, kind, candidate.text, base, previous?.etag ?? null, pending.length);
  let cursor = stage.cursor;
  try {
    const stop = Math.min(cursor + STAGE_ASSETS, pending.length);
    for (; cursor < stop; cursor++) {
      const { entry, asset, type } = pending[cursor]!;
      // Unchanged and metadata-only pet catalogues also verify presence and
      // repair missing ZIPs/previews. JSON always receives current validation.
      await mirrorAsset(env, base, asset, type, 'moc' in entry ? v => validateAdapter(v, entry.moc) : undefined, budget);
    }
    if (cursor < pending.length) throw new PetMarketError('stage-budget');
  } catch (error) {
    if (error instanceof PetMarketError && error.code === 'stage-budget') await saveStage(env, stage, cursor);
    throw error;
  }
  // A checkpoint CAS loser cannot publish. Reset completed unchanged sweeps
  // so the next cron really rechecks missing objects; changed publications
  // invalidate their completed checkpoint by advancing the base ETag.
  if (stage.etag !== null) await saveStage(env, stage, unchanged ? 0 : cursor);
  if (unchanged) return;
  const result = await env.DL.put(publicationKey(kind), stateText, {
    onlyIf: new Headers(previous ? { 'If-Match': previous.etag } : { 'If-None-Match': '*' }),
    httpMetadata: { contentType: 'application/json; charset=utf-8', cacheControl: 'no-store' },
  });
  if (!result) throw new PetMarketError('publication-conflict');
  remember(env, kind, { ...candidate, etag: result.httpEtag });
}
export async function publishPetMarket(env: Env): Promise<void> {
  const budget = transferBudget();
  const failures: string[] = [];
  for (const kind of ['pets', 'adapters'] as const) {
    try { await publishPetCatalog(env, kind, budget); }
    catch (error) {
      // Do not log upstream response bodies, URLs, or exception messages.
      const code = failureCode(error);
      failures.push(`${kind}=${code}`);
      console.error('pet market publish failed', kind, code);
    }
  }
  // stage-budget means a durably saved, incomplete sweep. It is deliberately
  // reported to Cron as deferred failure, never as completed publication.
  if (failures.length) throw new Error(`pet-market-publish-failed:${failures.join(';')}`);
}

export function isPetMarketPath(path: string): boolean {
  return path === '/market/pets.json' || path === '/market/adapters.json' ||
    path.startsWith('/market/pets/') || path.startsWith('/market/adapters/');
}
function jsonResponse(request: Request, text: string, etag: string, stale: boolean): Response {
  const match = matchesEtag(request.headers.get('If-None-Match'), etag);
  return new Response(request.method === 'HEAD' || match ? null : text, {
    status: match ? 304 : 200,
    headers: { ...headers, ETag: etag, 'Cache-Control': stale ? 'public, max-age=60' : 'public, max-age=300',
      'X-Market-Stale': String(stale), ...(stale ? { Warning: '110 - "Response is stale"' } : {}) },
  });
}

/** Adapters fit in the bounded JSON buffer. Serve precisely the bytes just
 *  verified, including for conditional/HEAD/Range requests; never re-read a
 *  different R2 body after granting the current-profile authorization.
 */
function adapterResponse(request: Request, value: StoredJson): Response {
  const h = new Headers({ ...headers, ETag: value.etag, 'Last-Modified': value.uploaded.toUTCString(),
    'Cache-Control': 'public, max-age=300', 'Accept-Ranges': 'bytes', 'X-Cache': 'MISS' });
  const conditions = validators(request);
  const tags = conditions?.get('If-None-Match') ?? null;
  const modified = conditions?.get('If-Modified-Since') ?? null;
  const date = parseHttpDate(modified);
  const match = tags !== null
    ? matchesEtag(tags, value.etag)
    : date !== null && Math.floor(value.uploaded.getTime() / 1000) * 1000 <= date;
  if (match) return new Response(null, { status: 304, headers: h });
  const head = request.method === 'HEAD', size = value.bytes.length;
  const range = head ? null : parseRange(request.headers.get('Range'));
  if (range) {
    const start = 'suffix' in range ? Math.max(0, size - range.suffix) : range.offset ?? 0;
    const end = 'suffix' in range || range.length === undefined ? size - 1 : Math.min(size - 1, start + range.length - 1);
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start >= size || end < start) {
      const response = failure(416, 'range_not_satisfiable');
      response.headers.set('Content-Range', `bytes */${size}`);
      return response;
    }
    h.set('Content-Range', `bytes ${start}-${end}/${size}`);
    h.set('Content-Length', String(end - start + 1));
    return new Response(value.bytes.slice(start, end + 1), { status: 206, headers: h });
  }
  h.set('Content-Length', String(size));
  return new Response(head ? null : value.bytes, { status: 200, headers: h });
}

/** Only listed current artifacts are served by the fallback host. CDN hard
 *  removal additionally needs object deletion and cache purge; the index's
 *  withdrawal ledger is authoritative for the App's install/update gate.
 */
export async function petMarket(request: Request, env: Env, ctx: Ctx): Promise<Response> {
  const path = new URL(request.url).pathname, head = request.method === 'HEAD';
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: {
    ...headers, 'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
    'Access-Control-Allow-Headers': 'If-None-Match, If-Modified-Since, Range', 'Access-Control-Max-Age': '300',
  } });
  if (!['GET', 'HEAD'].includes(request.method)) return new Response(null, { status: 405, headers: { ...headers, Allow: 'GET, HEAD, OPTIONS' } });
  const kind: CatalogKind = path.startsWith('/market/pets') ? 'pets' : 'adapters';
  const isIndex = path === `/market/${kind}.json`;
  const lookup = /^\/market\/adapters\/([a-f0-9]{64})\.json$/.exec(path);
  const petFile = /^\/market\/pets\/([a-z0-9-]{1,40})\/([^/]{1,80})\/[a-f0-9]{64}\.(zip|png|gif)$/.exec(path);
  const adapterFile = /^\/market\/adapters\/([a-f0-9]{64})\/[a-f0-9]{64}\.json$/.exec(path);
  if (!isIndex && !lookup && !petFile && !adapterFile) return failure(404, 'not_found', head);
  let value: Snapshot | null, stale = false;
  try {
    value = await loadPublication(env, kind);
    if (value) remember(env, kind, value);
    else memory.get(env)?.delete(kind);
  } catch {
    value = memory.get(env)?.get(kind) ?? null;
    stale = true;
    if (!value) return failure(503, 'catalog_unavailable', head);
  }
  if (!value) return failure(404, 'not_published', head);
  if (isIndex) return jsonResponse(request, value.text, value.etag, stale);
  // Stale data remains browseable, but cannot authorize an install or adapter.
  if (stale) return failure(503, 'catalog_unavailable', head);
  const catalog = value.catalog;
  if (lookup) {
    const entry = entries(catalog).find(e => entryId(e) === lookup[1]);
    if (!entry) return failure(revoked(catalog, lookup[1]!) ? 410 : 404, revoked(catalog, lookup[1]!) ? 'withdrawn' : 'not_found', head);
    try { await readStoredJson(env, entry, v => validateAdapter(v, lookup[1]!)); }
    catch { return failure(503, 'artifact_unavailable', head); }
    return jsonResponse(request, JSON.stringify(entry), value.etag, false);
  }
  if (petFile && revoked(catalog, petFile[1]!, petFile[2])) return failure(410, 'withdrawn', head);
  let matched: [MarketAsset, string] | undefined;
  for (const entry of entries(catalog)) {
    matched = assets(entry).find(([asset]) => asset.url === path);
    if (matched) break;
  }
  if (!matched) return failure(404, 'not_found', head);
  if (adapterFile) {
    try { return adapterResponse(request, await readStoredJson(env, matched[0], v => validateAdapter(v, adapterFile[1]!))); }
    catch { return failure(503, 'artifact_unavailable', head); }
  }
  let result: Response;
  try {
    result = await serveObject(request, { ...env, BUCKET: env.DL }, ctx, {
      key: path.slice(1), name: path.slice(path.lastIndexOf('/') + 1), cacheControl: 'public, max-age=300',
    });
  } catch { return failure(503, 'artifact_unavailable', head); }
  if (result.status === 404) return failure(503, 'artifact_unavailable', head);
  const h = new Headers(result.headers);
  h.set('Content-Type', matched[1]);
  h.set('Access-Control-Allow-Origin', '*');
  h.set('Access-Control-Expose-Headers', headers['Access-Control-Expose-Headers']);
  if (matched[1].startsWith('image/')) h.delete('Content-Disposition');
  return new Response(result.body, { status: result.status, headers: h });
}
