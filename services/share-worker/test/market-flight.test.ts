import { afterEach, expect, it, vi } from 'vitest';
import worker from '../src/index';
import { makeCtx, makeEnv } from './fakes';

let sequence = 0;
const index = JSON.stringify({ format: 1, title: 'Synthetic', plugins: [] });
const sidecar = JSON.stringify({ schema: 1, generatedAt: '2026-11-05T00:00:00Z', plugins: {} });
const setup = () => ({ ...makeEnv({ MARKET_SOURCE_URL: `https://example.com/flight-${sequence++}/` }), ...makeCtx() });
const read = (c: ReturnType<typeof setup>, path = 'index.json') =>
  worker.fetch(new Request('https://go.dshtui.com/market/' + path), c.env, c.ctx);
function gate() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}
function upstream(g: ReturnType<typeof gate>) {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async input => {
    await g.promise;
    return new Response(String(input).endsWith('index.json') ? index : sidecar);
  });
}
afterEach(() => vi.restoreAllMocks());

it.each(['cold', 'expired'])('20 overlapping %s routes share one validated upstream pair', async state => {
  const c = setup(), g = gate(), fetch = upstream(g);
  if (state === 'expired') {
    await c.kv.put('market:v1:' + c.env.MARKET_SOURCE_URL,
      JSON.stringify({ at: Date.now() - 600_001, index, sidecar }));
  }
  const reads = Array.from({ length: 20 }, (_, i) => read(c, i % 2 ? 'dsh-go.json' : 'index.json'));
  await vi.waitFor(() => expect(fetch.mock.calls.length).toBeGreaterThanOrEqual(2));
  // All request KV reads have completed, but neither upstream body is released.
  await new Promise(resolve => setTimeout(resolve, 0));
  const calls = fetch.mock.calls.length;
  g.release();
  const responses = await Promise.all(reads);
  for (let i = 0; i < responses.length; i++) {
    expect(responses[i]!.status).toBe(200);
    expect(responses[i]!.headers.get('x-market-stale')).toBe('false');
    expect(await responses[i]!.text()).toBe(i % 2 ? sidecar : index);
  }
  console.log(JSON.stringify({ state, requests: 20, upstreamFetches: calls }));
  expect(calls).toBe(2);
});

it('failed shared refresh serves caller stale data, then retries successfully', async () => {
  const c = setup(), g = gate();
  await c.kv.put('market:v1:' + c.env.MARKET_SOURCE_URL,
    JSON.stringify({ at: Date.now() - 600_001, index, sidecar }));
  vi.spyOn(console, 'error').mockImplementation(() => {});
  const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => { await g.promise; throw new Error('synthetic'); });
  const reads = [read(c), read(c)];
  await vi.waitFor(() => expect(fetch.mock.calls.length).toBeGreaterThanOrEqual(2));
  g.release();
  for (const response of await Promise.all(reads)) {
    expect(response.status).toBe(200);
    expect(response.headers.get('x-market-stale')).toBe('true');
    expect(await response.text()).toBe(index);
  }
  expect(fetch).toHaveBeenCalledTimes(2);
  fetch.mockImplementation(async input => new Response(String(input).endsWith('index.json') ? index : sidecar));
  expect((await read(c)).headers.get('x-market-stale')).toBe('false');
  expect(fetch).toHaveBeenCalledTimes(4);
});

it('separates different environments even with the same source', async () => {
  const a = setup(), b = setup(), g = gate(), fetch = upstream(g);
  b.env.MARKET_SOURCE_URL = a.env.MARKET_SOURCE_URL;
  const reads = [read(a), read(b)];
  await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(4));
  g.release();
  expect((await Promise.all(reads)).map(r => r.status)).toEqual([200, 200]);
});

it('separates different sources on a reused environment', async () => {
  const c = setup(), g = gate(), fetch = upstream(g);
  const first = read(c);
  await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
  c.env.MARKET_SOURCE_URL += 'other/';
  const second = read(c);
  await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(4));
  g.release();
  expect((await Promise.all([first, second])).map(r => r.status)).toEqual([200, 200]);
});

it('registers originating work before completion and does not share request Responses', async () => {
  const c = setup(), g = gate(), fetch = upstream(g);
  const waitUntil = vi.spyOn(c.ctx, 'waitUntil');
  const first = read(c), second = read(c);
  await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
  expect(waitUntil).toHaveBeenCalledTimes(1);
  let settled = false;
  const lifetime = c.settle().then(() => { settled = true; });
  await Promise.resolve();
  expect(settled).toBe(false);
  g.release();
  const [a, b] = await Promise.all([first, second]);
  expect(a).not.toBe(b);
  expect(await a.text()).toBe(index);
  expect(await b.text()).toBe(index);
  await lifetime;
  expect(settled).toBe(true);
});

it('keeps each request KV freshness check while another refresh is pending', async () => {
  const c = setup(), g = gate(), fetch = upstream(g);
  const first = read(c);
  await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
  const newer = JSON.stringify({ format: 1, title: 'New KV', plugins: [] });
  await c.kv.put('market:v1:' + c.env.MARKET_SOURCE_URL,
    JSON.stringify({ at: Date.now(), index: newer, sidecar }));
  const second = await read(c);
  expect(await second.text()).toBe(newer);
  expect(fetch).toHaveBeenCalledTimes(2);
  g.release();
  expect(await (await first).text()).toBe(index);
});

it('clears invalid catalog failures without caching them and permits a fresh attempt', async () => {
  const c = setup(), g = gate();
  vi.spyOn(console, 'error').mockImplementation(() => {});
  const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
    await g.promise;
    return new Response('{}');
  });
  const reads = [read(c), read(c)];
  await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
  g.release();
  expect((await Promise.all(reads)).map(r => r.status)).toEqual([503, 503]);
  await c.settle();
  fetch.mockImplementation(async input => new Response(String(input).endsWith('index.json') ? index : sidecar));
  expect((await read(c)).status).toBe(200);
  expect(fetch).toHaveBeenCalledTimes(4);
});
