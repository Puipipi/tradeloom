import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { CatalogKind } from '../src/pet-catalog';
import { petMarket, publishPetCatalog, publishPetMarket } from '../src/pet-market';
import { PUBLICATION_CAP, RELEASE_LIMIT, publicationKey, releaseBinding } from '../src/pet-market-state';
import { makeCtx, makeEnv } from './fakes';
import { FixedStream, PetBucket, sha } from './pet-market-fakes';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/pet-market-builder.json', import.meta.url), 'utf8'));
const now = Date.parse('2026-11-08T01:00:00.000Z');
const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
const request = (path: string) => new Request('https://go.example' + path);
const rawState = (dl: PetBucket, kind: CatalogKind) => dl.objects.get(publicationKey(kind))?.bytes;
const state = (dl: PetBucket, kind: CatalogKind) => JSON.parse(new TextDecoder().decode(rawState(dl, kind)!));
const publicCatalog = (dl: PetBucket, kind: CatalogKind) => JSON.parse(state(dl, kind).catalogText);
function setup() {
  const dl = new PetBucket(), docs = structuredClone(fixture);
  docs.adapters.adapters = [docs.adapters.adapters[0]];
  const { env } = makeEnv({ DL: dl as unknown as R2Bucket, MARKET_SOURCE_URL: 'https://upstream.example/catalog/' });
  const feed = vi.spyOn(globalThis, 'fetch').mockImplementation(async input => {
    const relative = String(input).slice(env.MARKET_SOURCE_URL!.length);
    if (relative === 'pets.json') return Response.json(docs.pets);
    if (relative === 'adapters.json') return Response.json(docs.adapters);
    const content = docs.files['/market/' + relative];
    return content ? new Response(new Uint8Array(Buffer.from(content, 'base64'))) : new Response(null, { status: 404 });
  });
  return { dl, docs, env, feed, ...makeCtx() };
}
// This suite treats ZIP/preview bytes as opaque resources, as the Worker does.
// Real Python-generated ZIP/PNG/GIF conformance is covered by cross-runtime tests.
function version(c: ReturnType<typeof setup>, kind: CatalogKind, ver: string, minute: number, changed?: 'artifact' | 'png' | 'gif', label = 'changed') {
  const row = structuredClone(fixture[kind][kind][0]);
  row.version = ver;
  const define = (original: any, extension: string, change: boolean) => {
    const content = Buffer.from(fixture.files[original.url], 'base64');
    const raw = change ? Buffer.concat([content, Buffer.from(label)]) : content;
    const prefix = kind === 'pets' ? `/market/pets/${row.id}/${ver}/` : `/market/adapters/${row.moc}/`;
    const asset = { url: prefix + sha(raw) + '.' + extension, sha256: sha(raw), size: raw.length };
    c.docs.files[asset.url] = raw.toString('base64');
    return asset;
  };
  if (kind === 'pets') {
    Object.assign(row, define(row, 'zip', changed === 'artifact'));
    for (const media of ['png', 'gif']) row.preview[media] = define(row.preview[media], media, changed === media);
  } else {
    const raw = bytes({ adapter: 1, moc: row.moc, notes: changed ? label : ver === '1.0.0' ? 'original' : 'second' });
    Object.assign(row, { url: `/market/adapters/${row.moc}/${sha(raw)}.json`, sha256: sha(raw), size: raw.length });
    c.docs.files[row.url] = Buffer.from(raw).toString('base64');
  }
  c.docs[kind][kind] = [row];
  c.docs[kind].generatedAt = new Date(Date.parse('2026-11-08T00:00:00.000Z') + minute * 60_000).toISOString();
  return row;
}
function withdraw(c: ReturnType<typeof setup>, kind: CatalogKind, ver: string) {
  const row = c.docs[kind][kind][0], key = kind === 'pets' ? 'id' : 'moc';
  c.docs[kind].withdrawn = [{ [key]: row[key], version: ver, reason: 'Synthetic withdrawal' }];
}
beforeEach(() => {
  vi.stubGlobal('FixedLengthStream', FixedStream);
  vi.spyOn(Date, 'now').mockReturnValue(now);
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it.each(['pets', 'adapters'] as const)('retains %s historical bindings through module reload and permits exact A to B to A rollback', async kind => {
  const c = setup(), original = version(c, kind, '1.0.0', 1);
  await publishPetCatalog(c.env, kind);
  const second = version(c, kind, '2.0.0', 2);
  await publishPetCatalog(c.env, kind);
  vi.resetModules();
  const restarted = await import('../src/pet-market');
  const { env } = makeEnv({ DL: c.dl as unknown as R2Bucket, MARKET_SOURCE_URL: c.env.MARKET_SOURCE_URL });
  version(c, kind, '1.0.0', 3); withdraw(c, kind, '2.0.0');
  await restarted.publishPetCatalog(env, kind);
  expect(publicCatalog(c.dl, kind)[kind][0]).toEqual(original);
  expect(state(c.dl, kind).releases).toEqual([releaseBinding(original), releaseBinding(second)]);
  const response = await restarted.petMarket(request(`/market/${kind}.json`), env, c.ctx);
  expect(await response.json()).toEqual(c.docs[kind]);
  expect(c.dl.objects.has(`market/${kind}.json`)).toBe(false); // No unsafe second index write.
});

it.each([
  ['adapters', 'artifact'], ['pets', 'artifact'], ['pets', 'png'], ['pets', 'gif'],
] as const)('rejects historical %s %s rebinding after upgrade and withdrawal', async (kind, asset) => {
  const c = setup();
  version(c, kind, '1.0.0', 1); await publishPetCatalog(c.env, kind);
  version(c, kind, '2.0.0', 2); await publishPetCatalog(c.env, kind);
  const before = rawState(c.dl, kind)!.slice();
  vi.resetModules();
  const restarted = await import('../src/pet-market');
  const { env } = makeEnv({ DL: c.dl as unknown as R2Bucket, MARKET_SOURCE_URL: c.env.MARKET_SOURCE_URL });
  version(c, kind, '1.0.0', 3, asset); withdraw(c, kind, '2.0.0');
  c.feed.mockClear();
  await expect(restarted.publishPetCatalog(env, kind)).rejects.toThrow('version-rewritten');
  expect(rawState(c.dl, kind)).toEqual(before);
  expect(c.feed).toHaveBeenCalledTimes(1); // Rejected before staging rewritten resources.
  expect(publicCatalog(c.dl, kind)[kind][0].version).toBe('2.0.0');
});

it('keeps binding history after an identity is completely withdrawn from the current catalogue', async () => {
  const c = setup(), row = version(c, 'adapters', '1.0.0', 1);
  await publishPetCatalog(c.env, 'adapters');
  withdraw(c, 'adapters', '1.0.0');
  c.docs.adapters.adapters = [];
  c.docs.adapters.generatedAt = '2026-11-08T00:02:00.000Z';
  await publishPetCatalog(c.env, 'adapters');
  expect(state(c.dl, 'adapters').releases).toEqual([releaseBinding(row)]);
  expect(publicCatalog(c.dl, 'adapters').adapters).toEqual([]);
});

it.each(['pets', 'adapters'] as const)('fails closed on a legacy bare %s catalogue instead of fabricating history', async kind => {
  const c = setup(), legacy = JSON.stringify(c.docs[kind]);
  await c.dl.put(`market/${kind}.json`, legacy);
  await expect(publishPetCatalog(c.env, kind)).rejects.toThrow('history-migration-required');
  expect(rawState(c.dl, kind)).toBeUndefined();
  expect(new TextDecoder().decode(c.dl.objects.get(`market/${kind}.json`)!.bytes)).toBe(legacy);
  expect((await petMarket(request(`/market/${kind}.json`), c.env, c.ctx)).status).toBe(503);
  expect(c.dl.writes).toEqual([`market/${kind}.json`]);
});

it('requires the full restored state for a trusted legacy migration and still rejects an older rewrite', async () => {
  const c = setup();
  version(c, 'adapters', '1.0.0', 1); await publishPetCatalog(c.env, 'adapters');
  version(c, 'adapters', '2.0.0', 2); await publishPetCatalog(c.env, 'adapters');
  // Operator-provided restoration of the complete, previously committed
  // history; this test does not infer earlier releases from the current row.
  const restored = rawState(c.dl, 'adapters')!.slice(), dl = new PetBucket();
  await dl.put('market/adapters.json', state(c.dl, 'adapters').catalogText);
  await dl.put(publicationKey('adapters'), restored, { onlyIf: new Headers({ 'If-None-Match': '*' }) });
  const { env } = makeEnv({ DL: dl as unknown as R2Bucket, MARKET_SOURCE_URL: c.env.MARKET_SOURCE_URL });
  version(c, 'adapters', '1.0.0', 3, 'artifact'); withdraw(c, 'adapters', '2.0.0');
  await expect(publishPetCatalog(env, 'adapters')).rejects.toThrow('version-rewritten');
  expect(rawState(dl, 'adapters')).toEqual(restored);
});

it('staging failure creates neither current catalogue nor a supposedly published binding', async () => {
  const c = setup(), first = version(c, 'pets', '1.0.0', 1);
  const omitted = c.docs.files[first.preview.png.url]; delete c.docs.files[first.preview.png.url];
  await expect(publishPetCatalog(c.env, 'pets')).rejects.toThrow('upstream-http');
  expect(rawState(c.dl, 'pets')).toBeUndefined();
  expect(c.dl.objects.has(first.url.slice(1))).toBe(true); // Verified staging only.
  c.docs.files[first.preview.png.url] = omitted;
  const winner = version(c, 'pets', '1.0.0', 2, 'artifact', 'first actual publication');
  await publishPetCatalog(c.env, 'pets');
  expect(state(c.dl, 'pets').releases).toEqual([releaseBinding(winner)]);
});

it.each(['get', 'legacy-head', 'put'] as const)('does not publish when initial state %s fails', async operation => {
  const c = setup(); version(c, 'adapters', '1.0.0', 1);
  if (operation === 'get') vi.spyOn(c.dl, 'get').mockRejectedValue(new Error('state read failure'));
  if (operation === 'legacy-head') {
    const head = c.dl.head.bind(c.dl);
    vi.spyOn(c.dl, 'head').mockImplementation(key => key === 'market/adapters.json' ? Promise.reject(new Error('legacy read failure')) : head(key));
  }
  if (operation === 'put') {
    const put = c.dl.put.bind(c.dl);
    vi.spyOn(c.dl, 'put').mockImplementation((key, value, options) => key === publicationKey('adapters') ? Promise.reject(new Error('state create failure')) : put(key, value, options));
  }
  await expect(publishPetCatalog(c.env, 'adapters')).rejects.toThrow(/failure/);
  expect(rawState(c.dl, 'adapters')).toBeUndefined();
  expect(c.dl.objects.has('market/adapters.json')).toBe(false);
});

it.each(['get', 'put'] as const)('a state %s failure cannot use in-memory history to publish an update', async operation => {
  const c = setup(); version(c, 'adapters', '1.0.0', 1); await publishPetCatalog(c.env, 'adapters');
  const before = rawState(c.dl, 'adapters')!.slice();
  version(c, 'adapters', '2.0.0', 2);
  if (operation === 'get') vi.spyOn(c.dl, 'get').mockRejectedValue(new Error('state read failure'));
  else {
    const put = c.dl.put.bind(c.dl);
    vi.spyOn(c.dl, 'put').mockImplementation((key, value, options) => key === publicationKey('adapters') ? Promise.reject(new Error('state update failure')) : put(key, value, options));
  }
  await expect(publishPetCatalog(c.env, 'adapters')).rejects.toThrow(/failure/);
  expect(rawState(c.dl, 'adapters')).toEqual(before);
});

it('a committed CAS with lost acknowledgement still has one complete binding and retries cannot rewrite it', async () => {
  const c = setup(), first = version(c, 'adapters', '1.0.0', 1), put = c.dl.put.bind(c.dl);
  const intercepted = vi.spyOn(c.dl, 'put').mockImplementation(async (key, value, options) => {
    const result = await put(key, value, options);
    if (key === publicationKey('adapters')) throw new Error('acknowledgement lost after commit');
    return result;
  });
  await expect(publishPetCatalog(c.env, 'adapters')).rejects.toThrow('acknowledgement lost');
  intercepted.mockRestore();
  expect(state(c.dl, 'adapters').releases).toEqual([releaseBinding(first)]);
  const { env } = makeEnv({ DL: c.dl as unknown as R2Bucket, MARKET_SOURCE_URL: c.env.MARKET_SOURCE_URL });
  await publishPetCatalog(env, 'adapters');
  version(c, 'adapters', '1.0.0', 2, 'artifact');
  await expect(publishPetCatalog(env, 'adapters')).rejects.toThrow('version-rewritten');
});

it.each([false, true])('CAS competition preserves only the winning version binding (existing=%s)', async existing => {
  const c = setup();
  if (existing) { version(c, 'adapters', '0.9.0', 0); await publishPetCatalog(c.env, 'adapters'); }
  const first = version(c, 'adapters', '1.0.0', 1, 'artifact', 'loser A');
  const held = Promise.withResolvers<void>(), ready = Promise.withResolvers<void>(), put = c.dl.put.bind(c.dl);
  let wait = true;
  vi.spyOn(c.dl, 'put').mockImplementation(async (key, value, options) => {
    if (key === publicationKey('adapters') && wait) { wait = false; ready.resolve(); await held.promise; }
    return put(key, value, options);
  });
  const pending = publishPetCatalog(c.env, 'adapters');
  // Observe the eventual rejection immediately so the probe itself cannot emit
  // an unhandled rejection while the winning publisher runs.
  const losing = expect(pending).rejects.toThrow('publication-conflict');
  await ready.promise;
  const winner = version(c, 'adapters', '1.0.0', 2, 'artifact', 'winner B');
  await publishPetCatalog(c.env, 'adapters');
  held.resolve(); await losing;
  const committed = state(c.dl, 'adapters');
  expect(publicCatalog(c.dl, 'adapters').adapters[0]).toEqual(winner);
  expect(committed.releases.at(-1)).toEqual(releaseBinding(winner));
  expect(committed.releases.some((r: any) => r.artifact.sha256 === first.sha256)).toBe(false);
  expect(c.dl.objects.has(first.url.slice(1))).toBe(true); // Losing staged object is not a publication.
  version(c, 'adapters', '1.0.0', 3, 'artifact', 'loser A');
  const { env } = makeEnv({ DL: c.dl as unknown as R2Bucket, MARKET_SOURCE_URL: c.env.MARKET_SOURCE_URL });
  await expect(publishPetCatalog(env, 'adapters')).rejects.toThrow('version-rewritten');
});

it('an earlier unknown PUT cannot overwrite a winner that commits after a negative read', async () => {
  const c = setup(), first = version(c, 'adapters', '1.0.0', 1, 'artifact', 'unknown A');
  const put = c.dl.put.bind(c.dl);
  let delayed: (() => ReturnType<typeof put>) | undefined;
  const intercepted = vi.spyOn(c.dl, 'put').mockImplementation(async (key, value, options) => {
    if (key === publicationKey('adapters') && !delayed) {
      // Caller has lost the result, but the storage operation can still commit.
      // Keep its original condition; evaluate it only at actual commit time.
      delayed = () => put(key, value, options);
      throw new Error('unknown outcome; operation still in flight');
    }
    return put(key, value, options);
  });
  await expect(publishPetCatalog(c.env, 'adapters')).rejects.toThrow('unknown outcome');
  expect(await c.dl.get(publicationKey('adapters'))).toBeNull();
  const winner = version(c, 'adapters', '1.0.0', 2, 'artifact', 'winner B');
  await publishPetCatalog(c.env, 'adapters');
  expect(await delayed!()).toBeNull(); // The late A still uses If-None-Match: *.
  intercepted.mockRestore();
  expect(state(c.dl, 'adapters').releases).toEqual([releaseBinding(winner)]);
  expect(publicCatalog(c.dl, 'adapters').adapters[0]).toEqual(winner);
  expect(c.dl.objects.has(first.url.slice(1))).toBe(true); // Unlisted staging is allowed.
  const { env } = makeEnv({ DL: c.dl as unknown as R2Bucket, MARKET_SOURCE_URL: c.env.MARKET_SOURCE_URL });
  version(c, 'adapters', '1.0.0', 3, 'artifact', 'unknown A');
  await expect(publishPetCatalog(env, 'adapters')).rejects.toThrow('version-rewritten');
});

it.each(['bare', 'missing-current', 'duplicate', 'wrong-resource', 'wrong-kind', 'unknown-field'] as const)('rejects corrupt persistent history: %s', async corruption => {
  const c = setup(); version(c, 'adapters', '1.0.0', 1); await publishPetCatalog(c.env, 'adapters');
  const invalid = state(c.dl, 'adapters');
  if (corruption === 'missing-current') invalid.releases = [];
  if (corruption === 'duplicate') invalid.releases.push(invalid.releases[0]);
  if (corruption === 'wrong-resource') invalid.releases[0].artifact.size++;
  if (corruption === 'wrong-kind') invalid.kind = 'pets';
  if (corruption === 'unknown-field') invalid.releases[0].unreviewed = true;
  const raw = JSON.stringify(corruption === 'bare' ? c.docs.adapters : invalid);
  await c.dl.put(publicationKey('adapters'), raw);
  const { env } = makeEnv({ DL: c.dl as unknown as R2Bucket, MARKET_SOURCE_URL: c.env.MARKET_SOURCE_URL });
  version(c, 'adapters', '2.0.0', 2);
  await expect(publishPetCatalog(env, 'adapters')).rejects.toThrow();
  expect((await petMarket(request('/market/adapters.json'), env, c.ctx)).status).toBe(503);
  expect(new TextDecoder().decode(rawState(c.dl, 'adapters')!)).toBe(raw);
});

it('bounded history is never evicted to make room for a new version', async () => {
  const c = setup(), row = version(c, 'adapters', '1.0.0', 1);
  await publishPetCatalog(c.env, 'adapters');
  const full = state(c.dl, 'adapters');
  for (let i = 1; i < RELEASE_LIMIT; i++) full.releases.push({ ...releaseBinding(row), version: `0.0.${i}` });
  await c.dl.put(publicationKey('adapters'), JSON.stringify(full));
  const before = rawState(c.dl, 'adapters')!.slice();
  version(c, 'adapters', '2.0.0', 2);
  await expect(publishPetCatalog(c.env, 'adapters')).rejects.toThrow('release-history-full');
  expect(sha(rawState(c.dl, 'adapters')!)).toBe(sha(before));
  version(c, 'adapters', '1.0.0', 3);
  await publishPetCatalog(c.env, 'adapters'); // Existing binding still usable at the limit.
  expect(state(c.dl, 'adapters').releases).toHaveLength(RELEASE_LIMIT);
});

it('a candidate exceeding the envelope byte cap fails without discarding any existing history', async () => {
  const c = setup(), current = version(c, 'pets', '1.0.0', 1);
  await publishPetCatalog(c.env, 'pets');
  const full = state(c.dl, 'pets'), id = 'a'.repeat(40);
  let size = Buffer.byteLength(JSON.stringify(full));
  for (let i = 1; i < RELEASE_LIMIT; i++) {
    const ver = '1' + String(i).padStart(75, '0') + '.0.0';
    const resource = (a: any, extension: string) => ({ ...a, url: `/market/pets/${id}/${ver}/${a.sha256}.${extension}` });
    const binding = { id, version: ver, artifact: resource(releaseBinding(current).artifact, 'zip'),
      preview: { png: resource(current.preview.png, 'png'), gif: resource(current.preview.gif, 'gif') } };
    const added = Buffer.byteLength(JSON.stringify(binding)) + 1;
    if (size + added > PUBLICATION_CAP - 256) break;
    full.releases.push(binding); size += added;
  }
  const raw = JSON.stringify(full);
  expect(Buffer.byteLength(raw)).toBe(size);
  expect(size).toBeLessThan(PUBLICATION_CAP); expect(size).toBeGreaterThan(PUBLICATION_CAP - 2000);
  expect(full.releases.length).toBeLessThan(RELEASE_LIMIT);
  await c.dl.put(publicationKey('pets'), raw);
  c.docs.pets.pets[0].source = 'https://example.org/' + 'x'.repeat(2000);
  c.docs.pets.generatedAt = '2026-11-08T00:02:00.000Z';
  await expect(publishPetCatalog(c.env, 'pets')).rejects.toThrow('publication-too-large');
  expect(sha(rawState(c.dl, 'pets')!)).toBe(sha(raw));
});

it('oversized stored envelopes fail closed before body parsing', async () => {
  const c = setup();
  await c.dl.put(publicationKey('adapters'), ' '.repeat(PUBLICATION_CAP + 1));
  await expect(publishPetCatalog(c.env, 'adapters')).rejects.toThrow('stored-publication-too-large');
  expect((await petMarket(request('/market/adapters.json'), c.env, c.ctx)).status).toBe(503);
});

it('source failure and R2 failure have different stale semantics; TTL is not source freshness', async () => {
  const c = setup(), row = version(c, 'adapters', '1.0.0', 1);
  await publishPetCatalog(c.env, 'adapters');
  c.feed.mockImplementation(async () => new Response(null, { status: 503 }));
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(Date, 'now').mockReturnValue(now + 86_400_000);
  await expect(publishPetMarket(c.env)).rejects.toThrow('pet-market-publish-failed:pets=upstream-http;adapters=upstream-http');
  const healthy = await petMarket(request('/market/adapters.json'), c.env, c.ctx);
  expect(healthy.status).toBe(200); expect(healthy.headers.get('X-Market-Stale')).toBe('false');
  expect(healthy.headers.get('Warning')).toBeNull(); expect(healthy.headers.get('Cache-Control')).toBe('public, max-age=300');
  expect((await petMarket(request(`/market/adapters/${row.moc}.json`), c.env, c.ctx)).status).toBe(200);
  expect((await petMarket(request(row.url), c.env, c.ctx)).status).toBe(200);
  vi.spyOn(c.dl, 'get').mockRejectedValue(new Error('R2 outage'));
  const stale = await petMarket(request('/market/adapters.json'), c.env, c.ctx);
  expect(stale.status).toBe(200); expect(stale.headers.get('X-Market-Stale')).toBe('true');
  expect(stale.headers.get('Warning')).toBe('110 - "Response is stale"');
  expect(stale.headers.get('Cache-Control')).toBe('public, max-age=60');
  for (const path of [row.url, `/market/adapters/${row.moc}.json`])
    expect((await petMarket(request(path), c.env, c.ctx)).status).toBe(503);
  const { env } = makeEnv({ DL: c.dl as unknown as R2Bucket, MARKET_SOURCE_URL: c.env.MARKET_SOURCE_URL });
  expect((await petMarket(request('/market/adapters.json'), env, c.ctx)).status).toBe(503);
});
