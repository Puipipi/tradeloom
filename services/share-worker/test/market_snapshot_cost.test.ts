import { afterEach, expect, it, vi } from 'vitest';
import worker from '../src/index';
import { makeCtx, makeEnv } from './fakes';

const now = Date.UTC(2026, 10, 4, 10);
let sequence = 0;

function documents(count = 128, title = 'original') {
  const plugins: Record<string, unknown> = {};
  const rows = [];
  for (let i = 0; i < count; i++) {
    const name = `@scope/plugin-${i}`;
    rows.push({ name, versions: [{ version: '1.2.3', source: { type: 'npm' } }] });
    plugins[name] = {
      version: '1.2.3', tier: 'community', title: { en: title }, summary: { en: 'Synthetic test plugin' },
      risk: { level: 'low', flags: [] }, integrity: 'sha512-' + 'A'.repeat(86) + '==',
      checkedAt: '2026-10-30T00:00:00Z', blockedVersions: [], dshGo: { adapted: true, features: [] }, screenshots: [],
    };
  }
  return {
    index: JSON.stringify({ format: 1, title: 'Test catalog', plugins: rows }),
    sidecar: JSON.stringify({ schema: 1, generatedAt: '2026-10-30T00:00:00Z', plugins }),
  };
}

function setup() {
  vi.spyOn(Date, 'now').mockReturnValue(now);
  const bindings = makeEnv({ MARKET_SOURCE_URL: `https://example.com/snapshot-cost-${sequence++}/` });
  return { ...bindings, ...makeCtx(), key: 'market:v1:' + bindings.env.MARKET_SOURCE_URL };
}

function upstream(d: ReturnType<typeof documents>) {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async input =>
    new Response(String(input).endsWith('index.json') ? d.index : d.sidecar),
  );
}

const read = (c: ReturnType<typeof setup>, file = 'index.json') =>
  worker.fetch(new Request('https://go.dshtui.com/market/' + file), c.env, c.ctx);

async function prime(c: ReturnType<typeof setup>, d: ReturnType<typeof documents>) {
  const response = await read(c);
  expect(response.status).toBe(200);
  expect(await response.text()).toBe(d.index);
}

afterEach(() => vi.restoreAllMocks());

it('100 warm routes keep KV freshness checks without reparsing an identical catalog', async () => {
  const c = setup(), d = documents(), fetch = upstream(d);
  await prime(c, d);
  const get = vi.spyOn(c.kv, 'get');
  const parse = vi.spyOn(JSON, 'parse');
  for (let i = 0; i < 100; i++) {
    const response = await read(c, i % 2 ? 'dsh-go.json' : 'index.json');
    expect(response.status).toBe(200);
    expect(response.headers.get('x-market-stale')).toBe('false');
    expect(response.headers.get('cache-control')).toBe('public, max-age=600');
    expect(await response.text()).toBe(i % 2 ? d.sidecar : d.index);
  }
  const indexParses = parse.mock.calls.filter(([text]) => text === d.index).length;
  const sidecarParses = parse.mock.calls.filter(([text]) => text === d.sidecar).length;
  const outerParses = parse.mock.calls.filter(([text]) => text === c.kv.values.get(c.key)).length;
  console.log(JSON.stringify({ scenario: 'warm-identical', requests: 100, plugins: 128,
    indexBytes: Buffer.byteLength(d.index), sidecarBytes: Buffer.byteLength(d.sidecar),
    kvGets: get.mock.calls.length, outerParses, indexParses, sidecarParses }));
  expect(get).toHaveBeenCalledTimes(100);
  expect(outerParses).toBe(100);
  expect(fetch).toHaveBeenCalledTimes(2);
  expect(indexParses).toBe(0);
  expect(sidecarParses).toBe(0);
});

it.each([-1, 0])('keeps memory when a different valid KV catalog has at offset %i', async delta => {
  const c = setup(), original = documents(2), other = documents(3, 'must not replace');
  upstream(original);
  await prime(c, original);
  await c.kv.put(c.key, JSON.stringify({ at: now + delta, ...other }));
  const parse = vi.spyOn(JSON, 'parse');
  const response = await read(c, 'dsh-go.json');
  expect(await response.text()).toBe(original.sidecar);
  expect(parse.mock.calls.filter(([text]) => text === other.index || text === other.sidecar)).toHaveLength(0);
});

it('adopts a valid newer KV catalog immediately and continues to validate later KV reads', async () => {
  const c = setup(), original = documents(2), newer = documents(3, 'newer');
  const fetch = upstream(original);
  await prime(c, original);
  await c.kv.put(c.key, JSON.stringify({ at: now + 1, ...newer }));
  const parse = vi.spyOn(JSON, 'parse');
  for (let i = 0; i < 2; i++) expect(await (await read(c, 'dsh-go.json')).text()).toBe(newer.sidecar);
  expect(parse.mock.calls.filter(([text]) => text === newer.index)).toHaveLength(2);
  expect(parse.mock.calls.filter(([text]) => text === newer.sidecar)).toHaveLength(2);
  expect(fetch).toHaveBeenCalledTimes(2);
});

it('does not skip full validation for a newer malformed or oversized snapshot', async () => {
  const c = setup(), original = documents(2);
  upstream(original);
  await prime(c, original);
  const invalid = [
    { at: now + 1, index: '{broken', sidecar: original.sidecar },
    { at: now + 1, index: original.index, sidecar: '{}' },
    { at: now + 1, index: original.index, sidecar: ' '.repeat(2 * 1024 * 1024 + 1) },
    { at: now + 60_001, ...documents(3, 'too far in future') },
  ];
  for (const value of invalid) {
    await c.kv.put(c.key, JSON.stringify(value));
    expect(await (await read(c, 'dsh-go.json')).text()).toBe(original.sidecar);
  }
  await c.kv.put(c.key, '{"at":1e999,"index":"{}","sidecar":"{}"}');
  expect(await (await read(c, 'dsh-go.json')).text()).toBe(original.sidecar);
});

it('validates every KV-only hit when the isolate has no remembered catalog', async () => {
  const c = setup(), d = documents(2);
  await c.kv.put(c.key, JSON.stringify({ at: now, ...d }));
  const fetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('must not fetch'));
  const parse = vi.spyOn(JSON, 'parse');
  for (let i = 0; i < 2; i++) expect(await (await read(c)).text()).toBe(d.index);
  expect(parse.mock.calls.filter(([text]) => text === d.index)).toHaveLength(2);
  expect(parse.mock.calls.filter(([text]) => text === d.sidecar)).toHaveLength(2);
  expect(fetch).not.toHaveBeenCalled();
});

it('retains stale fallback, refresh attempts and expiry headers after an older KV read', async () => {
  const c = setup(), d = documents(2), fetch = upstream(d);
  await prime(c, d);
  await c.kv.put(c.key, JSON.stringify({ at: now - 1, ...documents(3, 'old') }));
  vi.mocked(Date.now).mockReturnValue(now + 600_001);
  fetch.mockRejectedValue(new Error('synthetic upstream outage'));
  vi.spyOn(console, 'error').mockImplementation(() => {});
  const response = await read(c);
  expect(await response.text()).toBe(d.index);
  expect(response.headers.get('x-market-stale')).toBe('true');
  expect(response.headers.get('warning')).toBe('110 - "Response is stale"');
  expect(response.headers.get('cache-control')).toBe('public, max-age=60');
  expect(fetch).toHaveBeenCalledTimes(4);
});

it('rejects invalid KV without remembered data and never adopts nonnumeric timestamps', async () => {
  const c = setup(), d = documents(2);
  const fetch = upstream(d);
  await prime(c, d);
  for (const at of [null, '9999999999999', {}, []]) {
    await c.kv.put(c.key, JSON.stringify({ at, ...documents(3, 'invalid timestamp') }));
    expect(await (await read(c)).text()).toBe(d.index);
  }
  const empty = setup();
  await empty.kv.put(empty.key, JSON.stringify({ at: now, index: '{}', sidecar: '{}' }));
  fetch.mockRejectedValue(new Error('synthetic upstream outage'));
  vi.spyOn(console, 'error').mockImplementation(() => {});
  expect((await read(empty)).status).toBe(503);
});
