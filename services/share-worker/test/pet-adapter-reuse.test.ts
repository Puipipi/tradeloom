import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ADAPTER_CAP, validateAdapter } from '../src/pet-catalog';
import { parseHttpDate } from '../src/files';
import { mirrorAsset, readStoredJson } from '../src/pet-market-io';
import { petMarket, publishPetCatalog } from '../src/pet-market';
import { publicationKey, releaseBinding } from '../src/pet-market-state';
import { makeCtx, makeEnv } from './fakes';
import { PetBucket, sha } from './pet-market-fakes';

// Exact state captured by the independent review of frozen R2 worker
// 90e002c7... from its successful, invalid cached-object publication.
// Original artifact: 129 bytes / 8b6ad61213784208a54962d0b0177878c9157313af30dbb3beca43a6486d5345.
const captured = readFileSync(new URL('./fixtures/pet-market-legacy-adapter-publication.json', import.meta.url));
const moc = '1'.repeat(64), encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
const request = (path: string, method = 'GET', headers: Record<string,string> = {}) => new Request('https://go.example' + path, { method, headers });
const publication = publicationKey('adapters');

function setup(valid = false) {
  const dl = new PetBucket(), legacy = JSON.parse(captured.toString());
  const catalog = JSON.parse(legacy.catalogText), row = catalog.adapters[0];
  const body = encode({ adapter: 1, moc, params: { [valid ? 'ParamEyeLOpen' : 'eye']: { id: 'ExistingModelEye' } } });
  Object.assign(row, { url: `/market/adapters/${moc}/${sha(body)}.json`, sha256: sha(body), size: body.length });
  const { env } = makeEnv({ DL: dl as unknown as R2Bucket, MARKET_SOURCE_URL: 'https://upstream.example/catalog/' });
  const feed = vi.spyOn(globalThis, 'fetch').mockImplementation(async input => {
    const relative = String(input).slice(env.MARKET_SOURCE_URL!.length);
    if (relative === 'adapters.json') return Response.json(catalog);
    if ('/market/' + relative === row.url) return new Response(body);
    return new Response(null, { status: 404 });
  });
  const stage = () => dl.put(row.url.slice(1), body);
  const restore = () => dl.put(publication, valid
    ? JSON.stringify({ publication: 1, kind: 'adapters', catalogText: JSON.stringify(catalog), releases: [releaseBinding(row)] })
    : captured);
  return { dl, env, catalog, row, body, feed, stage, restore, ...makeCtx() };
}
beforeEach(() => vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-11-08T01:00:00.000Z')));
afterEach(() => vi.restoreAllMocks());

it.each(['fresh', 'cached', 'previous-current', 'same-catalogue-no-op'])('rejects the captured legacy profile through the %s publication path', async path => {
  const c = setup();
  expect(c.row.sha256).toBe('8b6ad61213784208a54962d0b0177878c9157313af30dbb3beca43a6486d5345');
  expect(c.body.length).toBe(129);
  if (path !== 'fresh') await c.stage();
  if (path === 'previous-current' || path === 'same-catalogue-no-op') await c.restore();
  if (path === 'previous-current') {
    c.catalog.generatedAt = '2026-11-08T00:02:00.000Z'; c.row.minApp = '1.0.14';
  }
  const before = c.dl.objects.get(publication)?.bytes.slice(), writes = c.dl.writes.length;
  await expect(publishPetCatalog(c.env, 'adapters')).rejects.toThrow('invalid-adapter');
  expect(c.dl.objects.get(publication)?.bytes).toEqual(before);
  expect(c.dl.writes.length).toBe(writes);
  expect(c.feed).toHaveBeenCalledTimes(path === 'fresh' ? 2 : 1);
});

it('revalidates valid cached, previous-current and identical-catalogue adapters without downloading again', async () => {
  const c = setup(true); await c.stage();
  const get = vi.spyOn(c.dl, 'get');
  await publishPetCatalog(c.env, 'adapters');
  const history = JSON.parse(new TextDecoder().decode(c.dl.objects.get(publication)!.bytes)).releases;
  c.catalog.generatedAt = '2026-11-08T00:02:00.000Z'; c.row.minApp = '1.0.14';
  await publishPetCatalog(c.env, 'adapters');
  const before = c.dl.objects.get(publication)!.bytes.slice(), writes = c.dl.writes.length;
  await publishPetCatalog(c.env, 'adapters');
  expect(c.dl.objects.get(publication)!.bytes).toEqual(before);
  expect(c.dl.writes.length).toBe(writes);
  expect(JSON.parse(new TextDecoder().decode(before)).releases).toEqual(history);
  expect(get.mock.calls.filter(([key]) => key === c.row.url.slice(1))).toHaveLength(3);
  expect(c.feed.mock.calls.every(([url]) => String(url).endsWith('/adapters.json'))).toBe(true);
});

it('allows only index browsing for a captured old-profile publication, never lookup/download/HEAD/304 authorization', async () => {
  const c = setup(); await c.stage(); await c.restore();
  const index = await petMarket(request('/market/adapters.json'), c.env, c.ctx);
  expect(index.status).toBe(200); expect(index.headers.get('X-Market-Stale')).toBe('false');
  for (const path of [`/market/adapters/${moc}.json`, c.row.url]) {
    for (const [method, conditions] of [['GET',{}], ['HEAD',{}], ['GET',{'If-None-Match':'*'}]] as const) {
      const response = await petMarket(request(path, method, conditions), c.env, c.ctx);
      expect(response.status).toBe(503); expect(response.headers.get('Cache-Control')).toBe('no-store');
      expect(response.headers.get('Retry-After')).toBe('60');
      if (method === 'HEAD') expect(await response.text()).toBe('');
      else expect(await response.json()).toEqual({ error: 'artifact_unavailable' });
    }
  }
  expect(c.feed).not.toHaveBeenCalled();
});

it.each(['missing', 'read-error', 'metadata-size', 'body-short', 'body-long', 'body-hash'])('fails closed on reused adapter %s despite a matching native HEAD checksum', async fault => {
  const c = setup(true); await c.stage(); await c.restore();
  const get = c.dl.get.bind(c.dl), cancelled = vi.fn();
  vi.spyOn(c.dl, 'get').mockImplementation(async (key, options) => {
    if (key !== c.row.url.slice(1)) return get(key, options);
    if (fault === 'missing') return null;
    if (fault === 'read-error') throw new Error('Synthetic stored JSON read failure');
    const object = await get(key, options);
    if (!object) throw new Error('Fixture missing');
    const raw = fault === 'body-short' ? c.body.slice(1) : fault === 'body-long'
      ? new Uint8Array(c.body.length + 1) : fault === 'body-hash' ? new Uint8Array(c.body.length) : c.body;
    return { ...object, size: fault === 'metadata-size' ? ADAPTER_CAP + 1 : object.size,
      body: new ReadableStream({ start(controller) {
        controller.enqueue(raw);
        if (fault !== 'metadata-size' && fault !== 'body-long') controller.close();
      }, cancel: cancelled }) } as any;
  });
  await expect(mirrorAsset(c.env, c.env.MARKET_SOURCE_URL!, c.row, 'application/json', v => validateAdapter(v, moc))).rejects.toThrow();
  for (const path of [`/market/adapters/${moc}.json`, c.row.url])
    expect((await petMarket(request(path, 'GET', { 'If-None-Match':'*' }), c.env, c.ctx)).status).toBe(503);
  expect(c.feed).not.toHaveBeenCalled();
  if (fault === 'metadata-size' || fault === 'body-long') expect(cancelled).toHaveBeenCalled();
});

it('rejects an out-of-budget adapter before reading its stored body', async () => {
  const c = setup(true), get = vi.spyOn(c.dl, 'get');
  await expect(readStoredJson(c.env, {...c.row, size: ADAPTER_CAP + 1}, () => true)).rejects.toThrow('invalid-adapter-size');
  expect(get).not.toHaveBeenCalled();
});

it.each(['head', 'get', 'both'])('accepts missing native SHA in %s only after actual-byte and current-profile verification', async missing => {
  const c = setup(true); await c.stage();
  const head = c.dl.head.bind(c.dl), get = c.dl.get.bind(c.dl);
  vi.spyOn(c.dl, 'head').mockImplementation(async key => {
    const value = await head(key);
    return value && key === c.row.url.slice(1) && missing !== 'get' ? { ...value, checksums: {} } as any : value;
  });
  vi.spyOn(c.dl, 'get').mockImplementation(async (key, options) => {
    const value = await get(key, options);
    return value && key === c.row.url.slice(1) && missing !== 'head' ? { ...value, checksums: {} } as any : value;
  });
  await expect(publishPetCatalog(c.env, 'adapters')).resolves.toBeUndefined();
  expect((await petMarket(request(c.row.url), c.env, c.ctx)).status).toBe(200);
  // A present wrong checksum still overrides valid actual bytes.
  vi.mocked(c.dl.head).mockImplementation(async key => {
    const value = await head(key);
    return value && key === c.row.url.slice(1) ? { ...value, checksums: { sha256: new Uint8Array(32).buffer } } : value;
  });
  await expect(publishPetCatalog(c.env, 'adapters')).rejects.toThrow('stored-integrity');
});

it('never accepts the old invalid profile merely because native checksums are absent', async () => {
  const c = setup(); await c.stage();
  const head = c.dl.head.bind(c.dl), get = c.dl.get.bind(c.dl);
  vi.spyOn(c.dl, 'head').mockImplementation(async key => {
    const value = await head(key); return value ? { ...value, checksums: {} } as any : value;
  });
  vi.spyOn(c.dl, 'get').mockImplementation(async (key, options) => {
    const value = await get(key, options); return value ? { ...value, checksums: {} } as any : value;
  });
  await expect(publishPetCatalog(c.env, 'adapters')).rejects.toThrow('invalid-adapter');
  expect(c.dl.objects.has(publication)).toBe(false);
});

it('verifies an actual competing JSON winner whose native checksum is absent', async () => {
  const c = setup(true), put = c.dl.put.bind(c.dl), head = c.dl.head.bind(c.dl), get = c.dl.get.bind(c.dl);
  vi.spyOn(c.dl, 'put').mockImplementation(async (key, value, options) => {
    const result = await put(key, value, options);
    return key === c.row.url.slice(1) ? null : result;
  });
  vi.spyOn(c.dl, 'head').mockImplementation(async key => {
    const value = await head(key); return value && key === c.row.url.slice(1) ? { ...value, checksums: {} } as any : value;
  });
  const reads = vi.spyOn(c.dl, 'get').mockImplementation(async (key, options) => {
    const value = await get(key, options); return value && key === c.row.url.slice(1) ? { ...value, checksums: {} } as any : value;
  });
  await publishPetCatalog(c.env, 'adapters');
  expect(reads.mock.calls.filter(([key]) => key === c.row.url.slice(1))).toHaveLength(1);
});

it('rechecks a competing create-once adapter winner instead of trusting its HEAD alone', async () => {
  const c = setup(true), put = c.dl.put.bind(c.dl), get = c.dl.get.bind(c.dl);
  vi.spyOn(c.dl, 'put').mockImplementation(async (key, value, options) => {
    await put(key, value, options); return null; // A matching object won while this put lost.
  });
  vi.spyOn(c.dl, 'get').mockImplementation(async (key, options) => {
    if (key === c.row.url.slice(1)) throw new Error('Cannot verify competing JSON');
    return get(key, options);
  });
  await expect(publishPetCatalog(c.env, 'adapters')).rejects.toThrow('Cannot verify competing JSON');
  expect(c.dl.objects.has(publication)).toBe(false);
});

it('serves exactly the fully verified adapter buffer with existing conditional and range semantics', async () => {
  const c = setup(true); await c.stage(); await c.restore();
  const get = vi.spyOn(c.dl, 'get');
  const first = await petMarket(request(c.row.url), c.env, c.ctx), etag = first.headers.get('ETag')!;
  const future = new Date(Date.parse(first.headers.get('Last-Modified')!) + 60_000).toUTCString();
  expect(first.status).toBe(200); expect(new Uint8Array(await first.arrayBuffer())).toEqual(c.body);
  expect(get.mock.calls.filter(([key]) => key === c.row.url.slice(1))).toHaveLength(1);
  const cases: [string,Record<string,string>,number,Uint8Array|undefined][] = [
    ['HEAD',{Range:'bytes=5-10'},200,undefined],
    ['GET',{Range:'bytes=5-10'},206,c.body.slice(5,11)],
    ['GET',{Range:'bytes=-5'},206,c.body.slice(-5)],
    ['GET',{Range:`bytes=${c.body.length}-`},416,undefined],
    ['GET',{Range:'bytes=-0'},416,undefined],
    ['GET',{Range:'bytes=10-5'},200,c.body],
    ['GET',{'If-None-Match':etag},304,undefined],
    ['GET',{'If-None-Match':`, "quoted,comma", W/${etag}, ,`},304,undefined],
    ['GET',{'If-None-Match':`invalid, ${etag}`,'If-Modified-Since':future},200,c.body],
    ['GET',{'If-None-Match':'"nonmatching"','If-Modified-Since':future},200,c.body],
    ['GET',{'If-Modified-Since':future},304,undefined],
    ['GET',{'If-Modified-Since':'Thu, 01 Jan 1970 00:00:00 GMT'},200,c.body],
    ['GET',{'If-Match':'"ignored-non-cache-precondition"'},200,c.body],
  ];
  for (const [method, conditions, status, body] of cases) {
    const response = await petMarket(request(c.row.url, method, conditions), c.env, c.ctx);
    expect(response.status, JSON.stringify(conditions)).toBe(status);
    if (body) expect(new Uint8Array(await response.arrayBuffer())).toEqual(body);
    else if (status !== 416) expect(await response.text()).toBe('');
    if (status === 416) {
      expect(response.headers.get('Content-Range')).toBe(`bytes */${c.body.length}`);
      expect(response.headers.get('Cache-Control')).toBe('no-store');
    }
  }
  expect((await petMarket(request(`/market/adapters/${moc}.json`), c.env, c.ctx)).status).toBe(200);
  expect(c.feed).not.toHaveBeenCalled();
});

it.each(['index', 'lookup', 'file'])('compares complete quoted ETag tokens for %s responses', async kind => {
  const c = setup(true); await c.stage(); await c.restore();
  const path = kind === 'index' ? '/market/adapters.json' : kind === 'lookup' ? `/market/adapters/${moc}.json` : c.row.url;
  const original = await petMarket(request(path), c.env, c.ctx);
  const etag = original.headers.get('ETag')!, body = await original.text();
  for (const value of ['"unrelated,*,opaque-tag"', '"*,opaque-tag"', '"opaque-tag,*"', '"*"', 'W/"*"',
    `malformed, ${etag}`, `${etag}, malformed`, `*, ${etag}`, `\u00a0${etag}`, `${etag}\u00a0`]) {
    const response = await petMarket(request(path, 'GET', {
      'If-None-Match': value, 'If-Modified-Since': 'Sat, 01 Jan 2050 00:00:00 GMT',
    }), c.env, c.ctx);
    expect(response.status, value).toBe(200); expect(await response.text()).toBe(body);
  }
  for (const value of ['*', etag, `W/${etag}`, `"unrelated,*,opaque-tag", ${etag}`, `, , W/${etag}, "other,tag", ,`]) {
    const response = await petMarket(request(path, 'GET', { 'If-None-Match': value }), c.env, c.ctx);
    expect(response.status, value).toBe(304); expect(await response.text()).toBe('');
  }
});

it('accepts all three HTTP-date formats but ignores non-HTTP dates and impossible calendar values', async () => {
  const c = setup(true); await c.stage(); await c.restore();
  c.dl.objects.get(c.row.url.slice(1))!.uploaded = new Date('2026-11-08T00:00:00.000Z');
  const accepted = ['Mon, 09 Nov 2026 00:00:00 GMT', 'Monday, 09-Nov-26 00:00:00 GMT', 'Mon Nov  9 00:00:00 2026'];
  const ignored = ['2026-11-09T00:00:00Z', '9999', 'mon, 09 Nov 2026 00:00:00 GMT',
    'Mon, 09 Nov 2026 00:00:00 UTC', 'Mon, 09 Nov 2026 00:00:00 gmt', 'Tue, 09 Nov 2026 00:00:00 GMT',
    'Tue, 31 Feb 2026 00:00:00 GMT', 'Mon, 09 Nov 2026 24:00:00 GMT', 'Mon, 09 Nov 2026 00:60:00 GMT',
    'Mon, 09 Nov 2026 00:00:61 GMT', accepted[0] + ', ' + accepted[0], '\u00a0' + accepted[0]];
  for (const value of accepted) {
    const response = await petMarket(request(c.row.url, 'GET', {'If-Modified-Since':value}), c.env, c.ctx);
    expect(response.status, value).toBe(304); expect(await response.text()).toBe('');
  }
  for (const value of ignored) {
    const response = await petMarket(request(c.row.url, 'GET', {'If-Modified-Since':value}), c.env, c.ctx);
    expect(response.status, value).toBe(200); expect(new Uint8Array(await response.arrayBuffer())).toEqual(c.body);
  }
});

it('applies the RFC 850 future-50-year interpretation before checking weekday and preserves a leap second', () => {
  const now = Date.parse('2026-11-08T01:00:00.000Z');
  expect(parseHttpDate('Sunday, 06-Nov-94 08:49:37 GMT', now)).toBe(Date.parse('1994-11-06T08:49:37Z'));
  const atLimit = new Date('2076-11-08T01:00:00Z'), past = new Date('1976-11-08T01:00:01Z');
  const names = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
  expect(parseHttpDate(`${names[atLimit.getUTCDay()]}, 08-Nov-76 01:00:00 GMT`, now)).toBe(atLimit.getTime());
  expect(parseHttpDate(`${names[past.getUTCDay()]}, 08-Nov-76 01:00:01 GMT`, now)).toBe(past.getTime());
  expect(parseHttpDate('Sat, 31 Dec 2016 23:59:60 GMT', now)).toBe(Date.parse('2017-01-01T00:00:00Z'));
});
