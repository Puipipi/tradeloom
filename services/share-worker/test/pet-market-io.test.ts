import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mirrorAsset, readBounded, upstream } from '../src/pet-market-io';
import { makeEnv } from './fakes';
import { FixedStream, PetBucket, sha } from './pet-market-fakes';

const base = 'https://example.com/catalog/';
function setup() {
  const dl = new PetBucket();
  const { env } = makeEnv({ DL: dl as unknown as R2Bucket });
  const bytes = new TextEncoder().encode('a small synthetic payload');
  const asset = { url: `/market/pets/demo/1.0.0/${sha(bytes)}.zip`, size: bytes.length, sha256: sha(bytes) };
  return { dl, env, bytes, asset };
}
beforeEach(() => vi.stubGlobal('FixedLengthStream', FixedStream));
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it('streams a verified artifact and reuses its R2 checksum without another download', async () => {
  const { env, dl, bytes, asset } = setup();
  const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(bytes));
  await mirrorAsset(env, base, asset, 'application/zip');
  expect(dl.objects.get(asset.url.slice(1))?.bytes).toEqual(bytes);
  expect(dl.objects.get(asset.url.slice(1))?.cacheControl).toBe('public, max-age=300');
  expect(fetch.mock.calls[0]).toEqual([base + asset.url.slice('/market/'.length), expect.objectContaining({ redirect: 'manual' })]);
  await mirrorAsset(env, base, asset, 'application/zip');
  expect(fetch).toHaveBeenCalledTimes(1);
});

it.each(['short', 'long', 'digest'])('does not commit a %s mismatching artifact', async (kind) => {
  const { env, dl, bytes, asset } = setup();
  const sent = kind === 'short' ? bytes.slice(1) : kind === 'long' ? new Uint8Array(bytes.length + 1) : new Uint8Array(bytes.length);
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(sent));
  await expect(mirrorAsset(env, base, asset, 'application/zip')).rejects.toThrow();
  expect(dl.objects.size).toBe(0);
});

it.each(['999999999999999999999999', '-1', 'nope', '0', '99'])('rejects bad declared length %s before pulling', async length => {
  const { env, dl, asset } = setup();
  const cancel = vi.fn(), pull = vi.fn();
  const body = new ReadableStream({ pull, cancel }, { highWaterMark: 0 });
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(body, { headers: { 'Content-Length': length } }));
  await expect(mirrorAsset(env, base, asset, 'application/zip')).rejects.toThrow('upstream-size');
  expect(pull).not.toHaveBeenCalled();
  expect(cancel).toHaveBeenCalledOnce();
  expect(dl.objects.size).toBe(0);
});

it.each([302, 404, 503])('cancels rejected upstream %i and never follows redirects', async status => {
  const cancel = vi.fn(), pull = vi.fn();
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(new ReadableStream({ pull, cancel }, { highWaterMark: 0 }), { status }));
  await expect(upstream(base, 'pets.json', 2000)).rejects.toThrow('upstream-http');
  expect(cancel).toHaveBeenCalledOnce();
  expect(pull).not.toHaveBeenCalled();
});

it.each(['https://evil.example/x', '//evil.example/x', '../pets.json', 'x/%2e%2e/y', 'a?token=x'])('does not fetch an unsafe path %s', async path => {
  const fetch = vi.spyOn(globalThis, 'fetch');
  await expect(upstream(base, path, 100)).rejects.toThrow('invalid-path');
  expect(fetch).not.toHaveBeenCalled();
});

it('cancels upstream after R2 fails before consuming a backpressured stream', async () => {
  const { env, dl, asset } = setup();
  const cancel = vi.fn();
  const body = new ReadableStream({ pull(controller) { controller.enqueue(new Uint8Array([1])); }, cancel }, { highWaterMark: 0 });
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(body));
  vi.spyOn(dl, 'put').mockRejectedValue(new Error('synthetic R2 failure'));
  await expect(mirrorAsset(env, base, asset, 'application/zip')).rejects.toThrow('synthetic R2 failure');
  await vi.waitFor(() => expect(cancel).toHaveBeenCalledOnce());
});

it('settles a competing create-once put even when R2 never reads its body', async () => {
  const { env, dl, asset, bytes } = setup();
  const cancel = vi.fn();
  const body = new ReadableStream({ pull(controller) { controller.enqueue(new Uint8Array([1])); }, cancel }, { highWaterMark: 0 });
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(body));
  vi.spyOn(dl, 'put').mockImplementation(async (key) => {
    dl.objects.set(key, { bytes, uploaded: new Date(), customMetadata: {} });
    return null;
  });
  await mirrorAsset(env, base, asset, 'application/zip');
  await vi.waitFor(() => expect(cancel).toHaveBeenCalledOnce());
});

it('rejects a tampered existing artifact instead of overwriting it', async () => {
  const { env, dl, asset } = setup();
  await dl.put(asset.url.slice(1), new Uint8Array(asset.size));
  const fetch = vi.spyOn(globalThis, 'fetch');
  await expect(mirrorAsset(env, base, asset, 'application/zip')).rejects.toThrow('stored-integrity');
  expect(fetch).not.toHaveBeenCalled();
});

it('validates adapter JSON and fingerprint before storing any bytes', async () => {
  const { env, dl } = setup();
  const bytes = new TextEncoder().encode('{"adapter":1,"moc":"wrong"}');
  const asset = { url: `/market/adapters/${'a'.repeat(64)}/${sha(bytes)}.json`, sha256: sha(bytes), size: bytes.length };
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(bytes));
  await expect(mirrorAsset(env, base, asset, 'application/json', () => false)).rejects.toThrow('invalid-adapter');
  expect(dl.objects.size).toBe(0);
});

it('bounds a chunked JSON body and cancels without masking its original failure', async () => {
  const cancel = vi.fn(() => Promise.reject(new Error('cancel failed')));
  const body = new ReadableStream({ pull(c) { c.enqueue(new Uint8Array(101)); }, cancel }, { highWaterMark: 0 });
  await expect(readBounded(body, 100)).rejects.toThrow('body-too-large');
  expect(cancel).toHaveBeenCalledOnce();
});
