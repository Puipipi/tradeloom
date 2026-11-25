import { afterEach, expect, it, vi } from 'vitest';
import worker from '../src/index';
import { makeCtx, makeEnv } from './fakes';

let sequence = 0;
const index = JSON.stringify({ format: 1, title: 'Synthetic', plugins: [] });
const sidecar = JSON.stringify({ schema: 1, generatedAt: '2026-11-05T00:00:00Z', plugins: {} });
function setup(status: number, length?: number, rejectCancel = false, pendingCancel?: Promise<void>) {
  const c = { ...makeEnv({ MARKET_SOURCE_URL: `https://example.com/body-${sequence++}/` }), ...makeCtx() };
  const cancel = vi.fn(() => pendingCancel ?? (rejectCancel ? Promise.reject(new Error('synthetic cancel failure')) : undefined));
  const pull = vi.fn();
  const stream = new ReadableStream<Uint8Array>({ pull, cancel }, { highWaterMark: 0 });
  vi.spyOn(globalThis, 'fetch').mockImplementation(async input => String(input).endsWith('index.json')
    ? new Response(stream, { status, headers: length === undefined ? {} : { 'Content-Length': String(length) } })
    : new Response(sidecar));
  const log = vi.spyOn(console, 'error').mockImplementation(() => {});
  return { ...c, cancel, pull, log,
    request: () => worker.fetch(new Request('https://go.dshtui.com/market/index.json'), c.env, c.ctx) };
}
afterEach(() => vi.restoreAllMocks());

it.each([302, 503])('cancels the unused body of upstream HTTP %i without reading it', async status => {
  const c = setup(status);
  const response = await c.request();
  expect(response.status).toBe(503);
  expect(c.pull).not.toHaveBeenCalled();
  expect(c.cancel).toHaveBeenCalledTimes(1);
  expect(c.log).toHaveBeenCalledWith('market refresh failed', 'upstream-http', status);
});

it('cancels a declared oversized successful response before reading any chunks', async () => {
  const c = setup(200, 2 * 1024 * 1024 + 1);
  expect((await c.request()).status).toBe(503);
  expect(c.pull).not.toHaveBeenCalled();
  expect(c.cancel).toHaveBeenCalledTimes(1);
  expect(c.log).toHaveBeenCalledWith('market refresh failed', 'too-large', null);
});

it.each([503, 200])('a cancellation failure preserves the original rejection category for HTTP %i', async status => {
  const c = setup(status, status === 200 ? 2 * 1024 * 1024 + 1 : undefined, true);
  expect((await c.request()).status).toBe(503);
  expect(c.cancel).toHaveBeenCalledTimes(1);
  expect(c.log).toHaveBeenCalledWith('market refresh failed', status === 503 ? 'upstream-http' : 'too-large', status === 503 ? 503 : null);
});

it('initiates cancellation without making rejection wait for upstream cleanup', async () => {
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  const c = setup(503, undefined, false, pending);
  try {
    expect((await c.request()).status).toBe(503);
    expect(c.cancel).toHaveBeenCalledTimes(1);
  } finally {
    release();
    await pending;
  }
});

it('still serves the last valid snapshot after canceling a rejected refresh body', async () => {
  const c = setup(503);
  await c.kv.put('market:v1:' + c.env.MARKET_SOURCE_URL, JSON.stringify({ at: Date.now() - 600_001, index, sidecar }));
  const response = await c.request();
  expect(response.status).toBe(200);
  expect(response.headers.get('x-market-stale')).toBe('true');
  expect(await response.text()).toBe(index);
  expect(c.cancel).toHaveBeenCalledTimes(1);
});

it('fully consumes and validates a normal successful response', async () => {
  const c = { ...makeEnv({ MARKET_SOURCE_URL: `https://example.com/body-${sequence++}/` }), ...makeCtx() };
  const cancel = vi.fn();
  const pull = vi.fn((controller: ReadableStreamDefaultController<Uint8Array>) => {
    controller.enqueue(new TextEncoder().encode(index));
    controller.close();
  });
  vi.spyOn(globalThis, 'fetch').mockImplementation(async input => String(input).endsWith('index.json')
    ? new Response(new ReadableStream({ pull, cancel }, { highWaterMark: 0 })) : new Response(sidecar));
  const response = await worker.fetch(new Request('https://go.dshtui.com/market/index.json'), c.env, c.ctx);
  expect(response.status).toBe(200);
  expect(await response.text()).toBe(index);
  expect(pull).toHaveBeenCalledTimes(1);
  expect(cancel).not.toHaveBeenCalled();
});
