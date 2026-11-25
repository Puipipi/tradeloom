import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import worker from '../src/index';
import { validateAdapter, validatePetCatalog } from '../src/pet-catalog';
import { publishPetCatalog, publishPetMarket } from '../src/pet-market';
import { publicationKey } from '../src/pet-market-state';
import { stageKey } from '../src/pet-market-stage';
import { makeCtx, makeEnv } from './fakes';
import { FixedStream, PetBucket, sha } from './pet-market-fakes';

// Actual output from the other repository's Python builder, including exact
// ZIP/PNG/GIF/adapter bytes. Independently produced synthetic test artwork.
const fixture = JSON.parse(readFileSync(new URL('./fixtures/pet-market-builder.json', import.meta.url), 'utf8'));
const now = Date.parse('2026-11-08T00:00:00Z');
const makeDocs = () => structuredClone(fixture);
const stored = (dl: PetBucket, kind: 'pets' | 'adapters') => new TextDecoder().decode(dl.objects.get(publicationKey(kind))!.bytes);
const text = (dl: PetBucket, key: string) => JSON.parse(stored(dl, key === 'market/pets.json' ? 'pets' : 'adapters')).catalogText;

function setup() {
  const dl = new PetBucket();
  const { env } = makeEnv({ DL: dl as unknown as R2Bucket, MARKET_SOURCE_URL: 'https://example.com/catalog/' });
  return { env, dl, ...makeCtx() };
}
function feed(docs = makeDocs()) {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async input => {
    const url = String(input), relative = url.slice('https://example.com/catalog/'.length);
    if (relative === 'pets.json') return Response.json(docs.pets);
    if (relative === 'adapters.json') return Response.json(docs.adapters);
    const encoded = docs.files['/market/' + relative];
    return encoded ? new Response(new Uint8Array(Buffer.from(encoded, 'base64'))) : new Response(null, { status: 404 });
  });
}
const request = (path: string, method = 'GET', headers?: Record<string, string>) => new Request('https://go.dshtui.com' + path, { method, headers });
beforeEach(() => {
  vi.stubGlobal('FixedLengthStream', FixedStream);
  vi.spyOn(Date, 'now').mockReturnValue(now);
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it('accepts real CI indexes, verifies every real artifact and publishes each index last', async () => {
  const c = setup(), docs = makeDocs(), fetch = feed(docs);
  expect(validatePetCatalog(docs.pets, 'pets')).toBe(true);
  expect(validatePetCatalog(docs.adapters, 'adapters')).toBe(true);
  for (const entry of docs.adapters.adapters) {
    const adapter = JSON.parse(Buffer.from(docs.files[entry.url], 'base64').toString('utf8'));
    expect(validateAdapter(adapter, entry.moc)).toBe(true);
  }
  await publishPetCatalog(c.env, 'pets');
  expect(c.dl.writes.at(-1)).toBe(publicationKey('pets'));
  await publishPetCatalog(c.env, 'adapters');
  expect(c.dl.writes.at(-1)).toBe(publicationKey('adapters'));
  expect(JSON.parse(text(c.dl, 'market/pets.json'))).toEqual(docs.pets);
  expect(JSON.parse(text(c.dl, 'market/adapters.json'))).toEqual(docs.adapters);
  for (const [path, encoded] of Object.entries(docs.files)) {
    expect(c.dl.objects.get(path.slice(1))?.bytes).toEqual(new Uint8Array(Buffer.from(encoded as string, 'base64')));
  }
  const calls = fetch.mock.calls.length;
  await publishPetMarket(c.env);
  expect(fetch.mock.calls.length).toBe(calls + 2); // Unchanged indexes reuse verified releases.
  expect(c.dl.writes.filter(p => p === publicationKey('pets'))).toHaveLength(1);
});

it('serves fallback index GET/HEAD/304 with CORS, without fetching upstream on reads', async () => {
  const c = setup(), f = feed();
  await publishPetCatalog(c.env, 'pets');
  f.mockClear();
  const r = await worker.fetch(request('/market/pets.json'), c.env, c.ctx);
  expect(r.status).toBe(200);
  expect(await r.json()).toEqual(fixture.pets);
  expect(r.headers.get('access-control-allow-origin')).toBe('*');
  expect(r.headers.get('x-market-stale')).toBe('false');
  const tag = r.headers.get('etag')!;
  const conditional = await worker.fetch(request('/market/pets.json', 'GET', { 'If-None-Match': `W/${tag}` }), c.env, c.ctx);
  expect(conditional.status).toBe(304);
  expect(await conditional.text()).toBe('');
  const head = await worker.fetch(request('/market/pets.json', 'HEAD'), c.env, c.ctx);
  expect(head.headers.get('etag')).toBe(tag);
  expect(await head.text()).toBe('');
  expect(f).not.toHaveBeenCalled();
});

it('serves only current listed downloads, correct preview types and resumed ZIP bytes', async () => {
  const c = setup(), docs = makeDocs(), f = feed(docs), p = docs.pets.pets[0];
  await publishPetCatalog(c.env, 'pets');
  f.mockClear();
  const full = await worker.fetch(request(p.url), c.env, c.ctx);
  expect(full.status).toBe(200);
  expect(full.headers.get('content-type')).toBe('application/zip');
  const range = await worker.fetch(request(p.url, 'GET', { Range: 'bytes=10-19' }), c.env, c.ctx);
  expect(range.status).toBe(206);
  expect(new Uint8Array(await range.arrayBuffer())).toEqual(new Uint8Array(Buffer.from(docs.files[p.url], 'base64')).slice(10, 20));
  for (const type of ['png', 'gif']) {
    const preview = await worker.fetch(request(p.preview[type].url), c.env, c.ctx);
    expect(preview.headers.get('content-type')).toBe('image/' + type);
    expect(preview.headers.has('content-disposition')).toBe(false);
  }
  expect((await worker.fetch(request(p.url.replace(p.sha256, 'f'.repeat(64))), c.env, c.ctx)).status).toBe(404);
  expect(f).not.toHaveBeenCalled();
});

it('looks up adapter metadata by moc before returning its immutable verified JSON', async () => {
  const c = setup(), docs = makeDocs(), f = feed(docs), a = docs.adapters.adapters[0];
  await publishPetCatalog(c.env, 'adapters');
  f.mockClear();
  const lookup = await worker.fetch(request(`/market/adapters/${a.moc}.json`), c.env, c.ctx);
  expect(await lookup.json()).toEqual(a);
  const artifact = await worker.fetch(request(a.url), c.env, c.ctx);
  expect(artifact.status).toBe(200);
  expect(validateAdapter(await artifact.json(), a.moc)).toBe(true);
  expect((await worker.fetch(request(`/market/adapters/${'f'.repeat(64)}.json`), c.env, c.ctx)).status).toBe(404);
  expect(f).not.toHaveBeenCalled();
});

it('retains the active index when a replacement artifact is corrupt', async () => {
  const c = setup(), docs = makeDocs(), f = feed(docs);
  await publishPetCatalog(c.env, 'pets');
  const before = text(c.dl, 'market/pets.json');
  const p = docs.pets.pets[0];
  docs.pets.generatedAt = '2026-11-07T19:01:00.000Z';
  p.version = '1.0.1';
  for (const asset of [p, p.preview.png, p.preview.gif]) {
    const previous = asset.url;
    asset.url = asset.url.replace('/1.0.0/', '/1.0.1/');
    docs.files[asset.url] = docs.files[previous];
  }
  docs.files[p.url] = Buffer.alloc(p.size).toString('base64');
  await expect(publishPetCatalog(c.env, 'pets')).rejects.toThrow();
  expect(text(c.dl, 'market/pets.json')).toBe(before);
  expect(f).toHaveBeenCalled();
});

it.each(['older', 'same-time-different', 'future'])('rejects a %s catalog before transferring assets', async kind => {
  const c = setup(), docs = makeDocs(), f = feed(docs);
  await publishPetCatalog(c.env, 'pets');
  const before = text(c.dl, 'market/pets.json');
  docs.pets.generatedAt = kind === 'older' ? '2026-11-07T18:59:00.000Z' : kind === 'future' ? '2027-01-01T00:00:00.000Z' : docs.pets.generatedAt;
  docs.pets.pets[0].title.en += ' changed';
  f.mockClear();
  await expect(publishPetCatalog(c.env, 'pets')).rejects.toThrow();
  expect(f).toHaveBeenCalledTimes(1);
  expect(text(c.dl, 'market/pets.json')).toBe(before);
});

it('a newer withdrawal wins a concurrent first publish and the late old index cannot overwrite it', async () => {
  const c = setup(), docs = makeDocs(), p = docs.pets.pets[0];
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const withdrawn = { schema: 1, generatedAt: '2026-11-07T19:02:00.000Z', pets: [], withdrawn: [{ id: p.id, version: p.version, reason: 'Synthetic withdrawal' }] };
  let indexCalls = 0, waiting = false;
  vi.spyOn(globalThis, 'fetch').mockImplementation(async input => {
    const url = String(input), relative = url.slice(c.env.MARKET_SOURCE_URL!.length);
    if (relative === 'pets.json') return Response.json(indexCalls++ === 0 ? docs.pets : withdrawn);
    if (relative.endsWith('.zip')) { waiting = true; await gate; }
    return new Response(new Uint8Array(Buffer.from(docs.files['/market/' + relative], 'base64')));
  });
  const old = publishPetCatalog(c.env, 'pets');
  await vi.waitFor(() => expect(waiting).toBe(true));
  await publishPetCatalog(c.env, 'pets');
  release();
  await expect(old).rejects.toThrow('publication-conflict');
  expect(JSON.parse(text(c.dl, 'market/pets.json'))).toEqual(withdrawn);
  expect((await worker.fetch(request(p.url), c.env, c.ctx)).status).toBe(410);
});

it('uses If-Match for updates and does not lose a newer index during a competing update', async () => {
  const c = setup(), docs = makeDocs(), f = feed(docs);
  await publishPetCatalog(c.env, 'pets');
  const old = stored(c.dl, 'pets');
  docs.pets.generatedAt = '2026-11-07T19:02:00.000Z';
  docs.pets.pets[0].title.en = 'Pending older label';
  const newer = structuredClone(docs.pets);
  newer.generatedAt = '2026-11-07T19:03:00.000Z';
  newer.pets[0].title.en = 'Winning newer label';
  const put = c.dl.put.bind(c.dl);
  vi.spyOn(c.dl, 'put').mockImplementation(async (key, value, options) => {
    if (key === publicationKey('pets')) {
      expect(options.onlyIf.get('If-Match')).toBe('"' + sha(old) + '"');
      await put(key, JSON.stringify({ ...JSON.parse(old), catalogText: JSON.stringify(newer) }));
    }
    return put(key, value, options);
  });
  await expect(publishPetCatalog(c.env, 'pets')).rejects.toThrow('publication-conflict');
  expect(JSON.parse(text(c.dl, 'market/pets.json'))).toEqual(newer);
  expect(f).toHaveBeenCalled();
});

it('requires withdrawals for removals and never accepts a withdrawal rollback', async () => {
  const c = setup(), docs = makeDocs(), p = docs.pets.pets[0];
  feed(docs);
  await publishPetCatalog(c.env, 'pets');
  docs.pets.generatedAt = '2026-11-07T19:01:00.000Z';
  docs.pets.pets = [];
  await expect(publishPetCatalog(c.env, 'pets')).rejects.toThrow('missing-withdrawal');
  docs.pets.withdrawn = [{ id: p.id, version: p.version, reason: 'Fixture removed' }];
  await publishPetCatalog(c.env, 'pets');
  docs.pets.generatedAt = '2026-11-07T19:02:00.000Z';
  docs.pets.withdrawn = [];
  await expect(publishPetCatalog(c.env, 'pets')).rejects.toThrow('withdrawal-rollback');
  expect((await worker.fetch(request(p.url), c.env, c.ctx)).status).toBe(410);
});

it('retains blocked versions when a listed pet updates', async () => {
  const c = setup(), docs = makeDocs();
  docs.pets.pets[0].blockedVersions = ['0.9.0'];
  feed(docs);
  await publishPetCatalog(c.env, 'pets');
  docs.pets.generatedAt = '2026-11-07T19:01:00.000Z';
  docs.pets.pets[0].blockedVersions = [];
  await expect(publishPetCatalog(c.env, 'pets')).rejects.toThrow('blocked-version-rollback');
});

it.each([1000, 1001])('aligns the market schema boundary for %i blocked versions', count => {
  const docs = makeDocs();
  docs.pets.pets[0].blockedVersions = Array.from({ length: count }, (_, i) => `0.0.${i}`);
  expect(validatePetCatalog(docs.pets, 'pets')).toBe(count === 1000);
});

it('rejects rewriting an already published version to different immutable bytes', async () => {
  const c = setup(), docs = makeDocs();
  feed(docs);
  await publishPetCatalog(c.env, 'pets');
  docs.pets.generatedAt = '2026-11-07T19:01:00.000Z';
  const p = docs.pets.pets[0];
  p.url = p.url.replace(p.sha256, 'b'.repeat(64));
  p.sha256 = 'b'.repeat(64);
  await expect(publishPetCatalog(c.env, 'pets')).rejects.toThrow('version-rewritten');
});

it('exposes a cached index as stale during R2 outage but does not authorize downloads', async () => {
  const c = setup(), docs = makeDocs();
  feed(docs);
  await publishPetCatalog(c.env, 'pets');
  await worker.fetch(request('/market/pets.json'), c.env, c.ctx);
  vi.spyOn(c.dl, 'get').mockRejectedValue(new Error('synthetic R2 outage'));
  const r = await worker.fetch(request('/market/pets.json'), c.env, c.ctx);
  expect(r.status).toBe(200);
  expect(r.headers.get('x-market-stale')).toBe('true');
  expect(await r.json()).toEqual(docs.pets);
  expect((await worker.fetch(request(docs.pets.pets[0].url), c.env, c.ctx)).status).toBe(503);
});

it('returns no-publish 404, outage 503, method 405 and no fetches on invalid paths', async () => {
  const c = setup(), f = vi.spyOn(globalThis, 'fetch');
  expect((await worker.fetch(request('/market/pets.json'), c.env, c.ctx)).status).toBe(404);
  expect((await worker.fetch(request('/market/pets.json', 'POST'), c.env, c.ctx)).status).toBe(405);
  expect((await worker.fetch(request('/market/pets.json', 'OPTIONS'), c.env, c.ctx)).status).toBe(204);
  for (const path of ['/market/pets/a/%252e/x.zip', '/market/adapters/ABC.json', '/market/pets/https%3A%2F%2Fevil'])
    expect((await worker.fetch(request(path), c.env, c.ctx)).status).toBe(404);
  vi.spyOn(c.dl, 'get').mockRejectedValue(new Error('outage'));
  expect((await worker.fetch(request('/market/adapters.json'), c.env, c.ctx)).status).toBe(503);
  expect(f).not.toHaveBeenCalled();
});

it('isolates a failed pets source from an otherwise valid adapter publication', async () => {
  const c = setup(), docs = makeDocs();
  docs.pets.pets[0].url = 'https://evil.example/nope.zip';
  feed(docs);
  const log = vi.spyOn(console, 'error').mockImplementation(() => {});
  await expect(publishPetMarket(c.env)).rejects.toThrow('pet-market-publish-failed:pets=invalid-catalog');
  expect(c.dl.objects.has(publicationKey('pets'))).toBe(false);
  expect(c.dl.objects.has(publicationKey('adapters'))).toBe(true);
  expect(log).toHaveBeenCalledWith('pet market publish failed', 'pets', 'invalid-catalog');
});

it.each([
  ['external ZIP URL', (p: any) => { p.url = 'https://evil.example/a.zip'; }],
  ['encoded URL', (p: any) => { p.url = p.url.replace('/pets/', '/pets/%2e%2e/'); }],
  ['wrong content-address', (p: any) => { p.sha256 = 'f'.repeat(64); }],
  ['overlong ID', (p: any) => { p.id = 'a'.repeat(41); }],
  ['normalization collision', (p: any) => { p.id = 'user-demo'; }],
  ['double hyphen', (p: any) => { p.id = 'demo--cat'; }],
  ['wrong version prerelease', (p: any) => { p.version = '1.0.0-01'; }],
  ['build version', (p: any) => { p.version = '1.0.0+local'; }],
  ['source credentials', (p: any) => { p.source = 'https://user:pass@example.com'; }],
  ['unknown risk flag', (p: any) => { p.risk.flags = ['data-only', 'invented']; }],
  ['array risk flag', (p: any) => { p.risk.flags = [['data-only'], 'maintainer-reviewed']; }],
  ['oversized preview', (p: any) => { p.preview.png.size = 4 * 1024 * 1024 + 1; }],
  ['zero ZIP size', (p: any) => { p.size = 0; }],
])('rejects %s metadata', (_, change) => {
  const docs = makeDocs();
  (change as (p: any) => void)(docs.pets.pets[0]);
  expect(validatePetCatalog(docs.pets, 'pets')).toBe(false);
});

it('rejects duplicate identities and a currently blocked/withdrawn version', () => {
  const docs = makeDocs(), p = docs.pets.pets[0];
  docs.pets.pets.push(p);
  expect(validatePetCatalog(docs.pets, 'pets')).toBe(false);
  docs.pets.pets.pop(); p.blockedVersions = [p.version];
  expect(validatePetCatalog(docs.pets, 'pets')).toBe(false);
  p.blockedVersions = [];
  docs.pets.withdrawn = [{ id: p.id, version: p.version, reason: 'Fixture' }];
  expect(validatePetCatalog(docs.pets, 'pets')).toBe(false);
});

it('does not accept code fields, wrong containers or out-of-contract adapter values', () => {
  const moc = 'a'.repeat(64);
  for (const invalid of [
    { adapter: 1, moc, script: 'alert(1)' }, { adapter: 1, moc, params: [] },
    { adapter: 1, moc, params: { x: { id: 'Eye', scale: 100.1 } } },
    { adapter: 1, moc, emotions: { x: { face: [] } } }, { adapter: 1, moc, actions: { x: { motion: 'yes', script: 'no' } } },
    { adapter: 1, moc, zones: [{ id: 'head', from: 0.5, to: 0.1 }] },
    { adapter: 1, moc, framing: { zoom: 0 } }, { adapter: 1, moc, toggles: { hide: 'x' } },
  ]) expect(validateAdapter(invalid, moc)).toBe(false);
  expect(validateAdapter({ adapter: 1, moc }, moc)).toBe(true);
});

it('stages a large initial feed across runs without exposing an incomplete index', async () => {
  const c = setup(), docs = makeDocs(), template = docs.adapters.adapters[0];
  docs.adapters.adapters = [];
  for (let n = 0; n < 25; n++) {
    const moc = n.toString(16).padStart(64, '0');
    const payload = Buffer.from(JSON.stringify({ adapter: 1, moc }));
    const entry = { ...template, moc, url: `/market/adapters/${moc}/${sha(payload)}.json`, sha256: sha(payload), size: payload.length };
    docs.adapters.adapters.push(entry);
    docs.files[entry.url] = payload.toString('base64');
  }
  const f = feed(docs);
  await expect(publishPetCatalog(c.env, 'adapters')).rejects.toThrow('stage-budget');
  expect(c.dl.objects.has(publicationKey('adapters'))).toBe(false);
  expect(c.dl.objects.size).toBe(25); // 24 verified resources plus their durable cursor.
  expect(JSON.parse(new TextDecoder().decode(c.dl.objects.get(stageKey('adapters'))!.bytes)).cursor).toBe(24);
  f.mockClear();
  await publishPetCatalog(c.env, 'adapters');
  expect(f).toHaveBeenCalledTimes(2); // One index, one remaining artifact.
  expect(c.dl.writes.at(-1)).toBe(publicationKey('adapters'));
});

it('reports an unexpectedly absent listed artifact as retriable 503', async () => {
  const c = setup(), docs = makeDocs(), p = docs.pets.pets[0];
  feed(docs);
  await publishPetCatalog(c.env, 'pets');
  await c.dl.delete(p.url.slice(1));
  const r = await worker.fetch(request(p.url), c.env, c.ctx);
  expect(r.status).toBe(503);
  expect(await r.json()).toEqual({ error: 'artifact_unavailable' });
});

it('cron keeps publishing plugins while independently publishing the pet partition', async () => {
  const c = setup(), docs = makeDocs();
  c.env.PET_MARKET_ENABLED = '1';
  const f = feed(docs), normal = f.getMockImplementation()!;
  f.mockImplementation(async (input, init) => {
    const url = String(input);
    if (url.endsWith('/index.json')) return Response.json({ format: 1, title: 'Fixture plugins', plugins: [] });
    if (url.endsWith('/dsh-go.json')) return Response.json({ schema: 1, generatedAt: docs.pets.generatedAt, plugins: {} });
    return normal(input, init);
  });
  await worker.scheduled({} as ScheduledController, c.env, c.ctx);
  for (const path of ['market/index.json', 'market/dsh-go.json', publicationKey('pets'), publicationKey('adapters')])
    expect(c.dl.objects.has(path)).toBe(true);
});
