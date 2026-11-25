import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { petMarket, publishPetCatalog, publishPetMarket } from '../src/pet-market';
import { publicationKey, releaseBinding } from '../src/pet-market-state';
import { stageKey, STAGE_ASSETS } from '../src/pet-market-stage';
import { makeCtx, makeEnv } from './fakes';
import { FixedStream, PetBucket, sha } from './pet-market-fakes';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/pet-market-builder.json', import.meta.url), 'utf8'));
const encode = (v: unknown) => new TextEncoder().encode(JSON.stringify(v));
const request = (path: string, method = 'GET', headers: Record<string, string> = {}) =>
  new Request('https://go.example' + path, { method, headers });
function setup(count = 1) {
  const dl = new PetBucket(), docs = structuredClone(fixture);
  const files = new Map<string, Uint8Array>(Object.entries(docs.files).map(([path, value]) => [path, new Uint8Array(Buffer.from(value as string, 'base64'))]));
  docs.adapters.adapters = Array.from({ length: count }, (_, index) => {
    const moc = (index + 1).toString(16).padStart(64, '0');
    const body = encode({ adapter: 1, moc, params: { ParamEyeLOpen: { id: 'ActualEye' } } });
    const row = { ...fixture.adapters.adapters[0], moc, url: `/market/adapters/${moc}/${sha(body)}.json`, sha256: sha(body), size: body.length };
    files.set(row.url, body); return row;
  });
  const { env } = makeEnv({ DL: dl as unknown as R2Bucket, MARKET_SOURCE_URL: 'https://source.example/catalog/' });
  const feed = vi.spyOn(globalThis, 'fetch').mockImplementation(async input => {
    const path = String(input).slice(env.MARKET_SOURCE_URL!.length);
    if (path === 'pets.json') return Response.json(docs.pets);
    if (path === 'adapters.json') return Response.json(docs.adapters);
    const body = files.get('/market/' + path);
    return body ? new Response(body.slice()) : new Response(null, { status: 404 });
  });
  return { dl, docs, files, env, feed, ...makeCtx() };
}
const stageAdapters = async (c: ReturnType<typeof setup>) => {
  for (const row of c.docs.adapters.adapters) await c.dl.put(row.url.slice(1), c.files.get(row.url)!);
};
const savedStage = (c: ReturnType<typeof setup>) => JSON.parse(new TextDecoder().decode(c.dl.objects.get(stageKey('adapters'))!.bytes));
beforeEach(() => {
  vi.stubGlobal('FixedLengthStream', FixedStream);
  vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-11-08T01:00:00.000Z'));
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it('reuses migrated valid JSON without native SHA only after verifying its bounded actual bytes', async () => {
  const c = setup(), row = c.docs.adapters.adapters[0];
  await c.dl.put(row.url.slice(1), c.files.get(row.url)!);
  const head = c.dl.head.bind(c.dl);
  vi.spyOn(c.dl, 'head').mockImplementation(async key => {
    const value = await head(key); return value && key === row.url.slice(1) ? { ...value, checksums: {} } as any : value;
  });
  await expect(publishPetCatalog(c.env, 'adapters')).resolves.toBeUndefined();
  expect(c.feed).toHaveBeenCalledTimes(1);
  expect(c.dl.gets.some(v => v.key === row.url.slice(1))).toBe(true);
});

it('an explicit wrong native SHA in the exact JSON GET fails closed even when actual JSON is valid', async () => {
  const c = setup(), row = c.docs.adapters.adapters[0];
  await publishPetCatalog(c.env, 'adapters');
  const get = c.dl.get.bind(c.dl);
  vi.spyOn(c.dl, 'get').mockImplementation(async (key, options) => {
    const value = await get(key, options);
    return value && key === row.url.slice(1) ? { ...value, checksums: { sha256: new Uint8Array(32).buffer } } as any : value;
  });
  expect((await petMarket(request(row.url), c.env, c.ctx)).status).toBe(503);
});

it.each([600, 1000])('finishes a %s-adapter directory across cold runs below the 1000 internal operation limit', async count => {
  const c = setup(count), counts = new Map<string, number>();
  await stageAdapters(c);
  let operations = 0;
  const counted = new Proxy(c.dl, { get(target, property) {
    const value = Reflect.get(target, property);
    if (!['get', 'put', 'head', 'delete'].includes(String(property))) return value;
    return async (...args: any[]) => {
      operations++;
      if (operations > 1000) throw new Error('synthetic R2 internal-operation ceiling');
      if (property === 'get' && String(args[0]).startsWith('market/adapters/'))
        counts.set(args[0], (counts.get(args[0]) ?? 0) + 1);
      return value.apply(target, args);
    };
  } });
  const perRun: number[] = [];
  for (let i = 0; i < 12 && !c.dl.objects.has(publicationKey('adapters')); i++) {
    operations = 0;
    vi.resetModules();
    const restarted = await import('../src/pet-market');
    const env = { ...c.env, DL: counted as unknown as R2Bucket };
    try { await restarted.publishPetCatalog(env, 'adapters'); }
    catch (error) { expect((error as { code?: string }).code).toBe('stage-budget'); }
    perRun.push(operations);
    expect(operations).toBeLessThan(900);
  }
  expect(c.dl.objects.has(publicationKey('adapters'))).toBe(true);
  expect(perRun.length).toBeGreaterThan(1);
  expect(counts.size).toBe(count);
  // Resumption must not spend every new run reading the first batch again.
  expect(Math.max(...counts.values())).toBe(1);
  expect(c.feed.mock.calls.every(([url]) => String(url).endsWith('/adapters.json'))).toBe(true);
});

it.each(['candidate', 'source', 'profile', 'base', 'total'])('starts a new sweep when the checkpoint %s identity changes', async change => {
  const c = setup(STAGE_ASSETS + 1);
  await stageAdapters(c);
  await expect(publishPetCatalog(c.env, 'adapters')).rejects.toThrow('stage-budget');
  const first = c.docs.adapters.adapters[0].url.slice(1);
  const readsBefore = c.dl.gets.filter(v => v.key === first).length;
  const checkpoint = savedStage(c);
  expect(checkpoint.cursor).toBe(STAGE_ASSETS);
  if (change === 'candidate') c.docs.adapters.generatedAt = '2026-11-08T00:02:00.000Z';
  if (change === 'source') c.env.MARKET_SOURCE_URL = 'https://different-source.example/catalog/';
  if (change === 'profile' || change === 'total') {
    if (change === 'profile') checkpoint.profile = '0'.repeat(64);
    else checkpoint.total--;
    await c.dl.put(stageKey('adapters'), encode(checkpoint));
  }
  if (change === 'base') {
    const old = { ...c.docs.adapters, generatedAt: '2026-11-07T00:00:00.000Z', adapters: [] };
    await c.dl.put(publicationKey('adapters'), encode({ publication: 1, kind: 'adapters', catalogText: JSON.stringify(old), releases: [] }));
  }
  const previous = c.dl.objects.get(publicationKey('adapters'))?.bytes.slice();
  // A wrongly reused cursor would validate only the last item and publish.
  await expect(publishPetCatalog(c.env, 'adapters')).rejects.toThrow('stage-budget');
  expect(c.dl.gets.filter(v => v.key === first)).toHaveLength(readsBefore + 1);
  expect(savedStage(c).cursor).toBe(STAGE_ASSETS);
  expect(c.dl.objects.get(publicationKey('adapters'))?.bytes).toEqual(previous);
});

it('allows only one of two concurrent final-batch checkpoint CAS writers to publish', async () => {
  const c = setup(STAGE_ASSETS + 1);
  await stageAdapters(c);
  await expect(publishPetCatalog(c.env, 'adapters')).rejects.toThrow('stage-budget');
  const get = c.dl.get.bind(c.dl), ready = Promise.withResolvers<void>();
  let reads = 0;
  vi.spyOn(c.dl, 'get').mockImplementation(async (key, options) => {
    const object = await get(key, options);
    if (key === stageKey('adapters')) {
      if (++reads === 2) ready.resolve();
      await ready.promise; // Both captured the same checkpoint ETag.
    }
    return object;
  });
  const results = await Promise.allSettled([
    publishPetCatalog({ ...c.env }, 'adapters'), publishPetCatalog({ ...c.env }, 'adapters'),
  ]);
  expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
  expect(results.filter(r => r.status === 'rejected').map(r => r.reason.code)).toEqual(['stage-conflict']);
  expect(c.dl.writes.filter(key => key === publicationKey('adapters'))).toHaveLength(1);
});

it.each(['read', 'write', 'invalid', 'oversized'])('does not publish with a %s checkpoint failure', async fault => {
  const c = setup(STAGE_ASSETS + 1);
  await stageAdapters(c);
  const key = stageKey('adapters');
  if (fault === 'read') {
    const get = c.dl.get.bind(c.dl);
    vi.spyOn(c.dl, 'get').mockImplementation(async (path, options) => {
      if (path === key) throw new Error('checkpoint read unavailable');
      return get(path, options);
    });
  } else if (fault === 'write') {
    const put = c.dl.put.bind(c.dl);
    vi.spyOn(c.dl, 'put').mockImplementation(async (path, value, options) => {
      if (path === key) throw new Error('checkpoint write unavailable');
      return put(path, value, options);
    });
  } else await c.dl.put(key, fault === 'invalid' ? '{"stage":1,"cursor":999999}' : ' '.repeat(4097));
  await expect(publishPetCatalog(c.env, 'adapters')).rejects.toThrow();
  expect(c.dl.objects.has(publicationKey('adapters'))).toBe(false);
});

it('does not advance a checkpoint or publication past a failed asset verification', async () => {
  const c = setup(STAGE_ASSETS + 1);
  await stageAdapters(c);
  await expect(publishPetCatalog(c.env, 'adapters')).rejects.toThrow('stage-budget');
  const before = c.dl.objects.get(stageKey('adapters'))!.bytes.slice();
  const last = c.docs.adapters.adapters.at(-1);
  await c.dl.put(last.url.slice(1), new Uint8Array(last.size));
  await expect(publishPetCatalog(c.env, 'adapters')).rejects.toThrow('stored-integrity');
  expect(c.dl.objects.get(stageKey('adapters'))!.bytes).toEqual(before);
  expect(c.dl.objects.has(publicationKey('adapters'))).toBe(false);
  await c.dl.put(last.url.slice(1), c.files.get(last.url)!);
  await publishPetCatalog(c.env, 'adapters');
  expect(c.dl.objects.has(publicationKey('adapters'))).toBe(true);
});

it('resets a completed unchanged sweep and repairs a later missing first asset', async () => {
  const c = setup(STAGE_ASSETS + 1);
  await stageAdapters(c);
  await expect(publishPetCatalog(c.env, 'adapters')).rejects.toThrow('stage-budget');
  await publishPetCatalog(c.env, 'adapters');
  const published = c.dl.objects.get(publicationKey('adapters'))!.bytes.slice();
  await expect(publishPetCatalog(c.env, 'adapters')).rejects.toThrow('stage-budget');
  await publishPetCatalog(c.env, 'adapters');
  expect(savedStage(c).cursor).toBe(0);
  const row = c.docs.adapters.adapters[0];
  c.dl.objects.delete(row.url.slice(1));
  await expect(publishPetCatalog(c.env, 'adapters')).rejects.toThrow('stage-budget');
  expect(c.dl.objects.get(row.url.slice(1))!.bytes).toEqual(c.files.get(row.url));
  expect(c.dl.objects.get(publicationKey('adapters'))!.bytes).toEqual(published);
});

it('fails closed on deletion after an earlier verified batch and repairs it in the next sweep', async () => {
  const c = setup(STAGE_ASSETS + 1);
  await stageAdapters(c);
  await expect(publishPetCatalog(c.env, 'adapters')).rejects.toThrow('stage-budget');
  const row = c.docs.adapters.adapters[0];
  c.dl.objects.delete(row.url.slice(1)); // Out-of-band deletion, after its verified batch.
  await publishPetCatalog(c.env, 'adapters'); // Publication is not a cross-key transaction.
  expect((await petMarket(request(row.url), c.env, c.ctx)).status).toBe(503);
  await expect(publishPetCatalog(c.env, 'adapters')).rejects.toThrow('stage-budget');
  expect((await petMarket(request(row.url), c.env, c.ctx)).status).toBe(200);
});

it.each(['identical', 'metadata-only'])('repairs missing pet ZIP and previews for a %s catalogue', async mode => {
  const c = setup(); await publishPetCatalog(c.env, 'pets');
  const row = c.docs.pets.pets[0], keys = [row.url, row.preview.png.url, row.preview.gif.url];
  for (const path of keys) c.dl.objects.delete(path.slice(1));
  if (mode === 'metadata-only') { c.docs.pets.generatedAt = '2026-11-08T00:02:00.000Z'; row.minApp = '1.0.14'; }
  await publishPetCatalog(c.env, 'pets');
  for (const path of keys) expect(c.dl.objects.has(path.slice(1)), path).toBe(true);
});

it('uses current conditional metadata to avoid repeatedly transferring a validated publication body', async () => {
  const c = setup(); await publishPetCatalog(c.env, 'adapters');
  const get = c.dl.get.bind(c.dl), key = publicationKey('adapters');
  let bodies = 0, checks = 0;
  vi.spyOn(c.dl, 'get').mockImplementation(async (path, options) => {
    const value = await get(path, options);
    if (path === key) { checks++; if (value && 'body' in value) bodies++; }
    return value;
  });
  const row = c.docs.adapters.adapters[0];
  await petMarket(request('/market/adapters.json'), c.env, c.ctx);
  const first = bodies;
  for (const req of [request(row.url, 'HEAD'), request(row.url, 'GET', { Range: 'bytes=0-3' }),
    request('/market/adapters.json', 'GET', { 'If-None-Match': '*' })])
    expect((await petMarket(req, c.env, c.ctx)).status).toBeLessThan(400);
  expect(checks).toBe(4);
  expect(bodies).toBe(first);
});

it('attempts both partitions and then rejects with only sanitized failure codes', async () => {
  const c = setup();
  const log = vi.spyOn(console, 'error').mockImplementation(() => {});
  c.feed.mockRejectedValue(new Error('secret upstream payload token=DO_NOT_EXPOSE'));
  await expect(publishPetMarket(c.env)).rejects.toThrow(/pet-market-publish-failed/);
  expect(c.feed.mock.calls.map(([url]) => String(url).split('/').at(-1))).toEqual(['pets.json', 'adapters.json']);
  expect(JSON.stringify(log.mock.calls)).not.toContain('DO_NOT_EXPOSE');
});

it('reports a durably deferred batch after trying both partitions, then succeeds on completion', async () => {
  const c = setup(STAGE_ASSETS + 1);
  await stageAdapters(c);
  vi.spyOn(console, 'error').mockImplementation(() => {});
  await expect(publishPetMarket(c.env)).rejects.toThrow('pet-market-publish-failed:adapters=stage-budget');
  expect(c.dl.objects.has(publicationKey('pets'))).toBe(true);
  expect(c.dl.objects.has(publicationKey('adapters'))).toBe(false);
  expect(savedStage(c).cursor).toBe(STAGE_ASSETS);
  await expect(publishPetMarket(c.env)).resolves.toBeUndefined();
  expect(c.dl.objects.has(publicationKey('adapters'))).toBe(true);
});

it('single-flights a large cold envelope while every concurrent request checks its current ETag', async () => {
  const c = setup(); await publishPetCatalog(c.env, 'adapters');
  const row = c.docs.adapters.adapters[0], key = publicationKey('adapters');
  const state = JSON.parse(new TextDecoder().decode(c.dl.objects.get(key)!.bytes));
  state.releases = Array.from({ length: 10_000 }, (_, i) => ({ ...releaseBinding(row), version: i ? `2.0.${i}` : row.version }));
  const bytes = encode(state);
  expect(bytes.length).toBeGreaterThan(3 * 1024 * 1024);
  await c.dl.put(key, bytes);
  const get = c.dl.get.bind(c.dl), cold = { ...c.env };
  let bodies = 0, checks = 0;
  vi.spyOn(c.dl, 'get').mockImplementation(async (path, options) => {
    const value = await get(path, options);
    if (path === key) { checks++; if (value && 'body' in value) bodies++; }
    return value;
  });
  const responses = await Promise.all(Array.from({ length: 16 }, (_, i) => petMarket(i % 3 === 0
    ? request('/market/adapters.json', 'HEAD') : i % 3 === 1 ? request(row.url, 'HEAD')
      : request(row.url, 'GET', { Range: 'bytes=0-3' }), cold, c.ctx)));
  expect(responses.every(response => response.status === 200 || response.status === 206)).toBe(true);
  expect(checks).toBe(16);
  expect(bodies).toBe(1);
});

it('a waiter performs a fresh conditional read and observes a withdrawal committed during the first body read', async () => {
  const c = setup(); await publishPetCatalog(c.env, 'adapters');
  const key = publicationKey('adapters'), row = c.docs.adapters.adapters[0];
  const original = c.dl.objects.get(key)!.bytes.slice(), get = c.dl.get.bind(c.dl);
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  let first = true;
  vi.spyOn(c.dl, 'get').mockImplementation(async (path, options) => {
    const object = await get(path, options);
    if (path !== key || !first || !object || !('body' in object)) return object;
    first = false;
    void object.body.cancel();
    entered.resolve();
    return { ...object, body: new ReadableStream({ async start(controller) {
      await release.promise; controller.enqueue(original); controller.close();
    } }) };
  });
  const cold = { ...c.env };
  const reader = petMarket(request('/market/adapters.json'), cold, c.ctx);
  await entered.promise;
  const waiter = petMarket(request(`/market/adapters/${row.moc}.json`), cold, c.ctx);
  const state = JSON.parse(new TextDecoder().decode(original));
  state.catalogText = JSON.stringify({ ...c.docs.adapters, generatedAt: '2026-11-08T00:02:00.000Z', adapters: [],
    withdrawn: [{ moc: row.moc, version: row.version, reason: 'Synthetic withdrawal' }] });
  await c.dl.put(key, encode(state));
  release.resolve();
  expect((await reader).status).toBe(200);
  expect((await waiter).status).toBe(410);
});

it.each(['missing', 'error', 'invalid', 'metadata-etag', 'metadata-size'])('never authorizes from cached history after current publication %s', async fault => {
  const c = setup(); await publishPetCatalog(c.env, 'adapters');
  const key = publicationKey('adapters'), row = c.docs.adapters.adapters[0];
  await petMarket(request('/market/adapters.json'), c.env, c.ctx);
  const original = c.dl.objects.get(key)!.bytes.slice(), get = c.dl.get.bind(c.dl);
  if (fault === 'missing') c.dl.objects.delete(key);
  else if (fault === 'invalid') await c.dl.put(key, encode({ publication: 1, kind: 'adapters', catalogText: JSON.stringify(c.docs.adapters), releases: [] }));
  const bad = vi.spyOn(c.dl, 'get').mockImplementation(async (path, options) => {
    if (path !== key) return get(path, options);
    if (fault === 'error') throw new Error('synthetic current publication read outage');
    const object = await get(path, options);
    return !object || !fault.startsWith('metadata-') ? object : { ...object,
      ...(fault === 'metadata-etag' ? { httpEtag: '"unexpected-current-etag"' } : { size: object.size + 1 }) };
  });
  expect((await petMarket(request(row.url, 'HEAD'), c.env, c.ctx)).status).toBe(fault === 'missing' ? 404 : 503);
  bad.mockRestore();
  await c.dl.put(key, original);
  // A fresh body is required even if the restored object has the old ETag.
  let reloaded = false;
  vi.spyOn(c.dl, 'get').mockImplementation(async (path, options) => {
    const object = await get(path, options);
    if (path === key) { expect(options?.onlyIf).toBeUndefined(); reloaded = !!object && 'body' in object; }
    return object;
  });
  expect((await petMarket(request(row.url, 'HEAD'), c.env, c.ctx)).status).toBe(200);
  expect(reloaded).toBe(true);
});
