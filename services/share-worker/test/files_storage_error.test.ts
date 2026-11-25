// Real Worker routing with R2 binding fault injection. The numeric suffixes
// follow the R2 Workers API error contract; this is not a live R2 outage test.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import worker from '../src/index';
import { CHANNEL_PREFIX, channelId, resetChannelMemo } from '../src/beta-auth';
import { FakeCache, makeCtx, makeEnv } from './fakes';

const ORIGIN = 'https://go.dshtui.com';
const VERSION = '1.0.10';
const NAME = `dsh-go-${VERSION}-arm64.apk`;
const KEY = `beta/${VERSION}/${NAME}`;
const BYTES = Uint8Array.from({ length: 32 }, (_, i) => i);
const TOKEN = 'dshc_' + 'A'.repeat(43);

function fixture() {
  const data = makeEnv({
    DOWNLOAD_ACCESS: 'public',
    BETA_SECRET: 'test-beta-secret-0123456789abcdef0123456789abcdef',
  });
  data.bucket.objects.set(KEY, {
    bytes: BYTES,
    uploaded: new Date('2026-11-01T00:00:00Z'),
    customMetadata: {},
  });
  return data;
}

function request(path: string, headers: Record<string, string> = {}) {
  return new Request(ORIGIN + path, { headers: { 'CF-Connecting-IP': '198.51.100.9', ...headers } });
}

beforeEach(() => {
  resetChannelMemo();
  (globalThis as { caches?: unknown }).caches = { default: new FakeCache() };
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  delete (globalThis as { caches?: unknown }).caches;
});

describe('download storage failures', () => {
  it.each([
    [undefined, '10001'],
    [undefined, '10043'],
    ['bytes=8-', '10001'],
    ['bytes=8-', '10043'],
  ])('keeps range=%s R2 service error %s out of the 416 reset path', async (range, code) => {
    const { env, bucket } = fixture();
    const error = new Error(`get: Storage service failed. (${code})`);
    const get = vi.spyOn(bucket, 'get').mockRejectedValueOnce(error);
    const head = vi.spyOn(bucket, 'head');

    const response = await worker.fetch(
      request(`/download/${VERSION}/${NAME}`, range ? { Range: range } : {}),
      env,
      makeCtx().ctx,
    );

    expect(response.status).toBe(500);
    expect(response.headers.get('Content-Range')).toBeNull();
    expect(await response.json()).toEqual({ error: 'internal' });
    expect(get).toHaveBeenCalledWith(KEY, range ? { range: { offset: 8 } } : {});
    expect(head).not.toHaveBeenCalled();
    expect(console.error).toHaveBeenCalledWith('unhandled', error.message);
  });

  it('preserves the same error distinction on the authorized app channel', async () => {
    const { env, bucket, kv } = fixture();
    kv.values.set(CHANNEL_PREFIX + (await channelId(TOKEN)), JSON.stringify({ label: 'app-test' }));
    const error = new Error('get: Storage service is temporarily unavailable. (10043)');
    vi.spyOn(bucket, 'get').mockRejectedValueOnce(error);

    const response = await worker.fetch(
      request(`/beta/${VERSION}/${NAME}`, { Authorization: `Bearer ${TOKEN}`, Range: 'bytes=8-' }),
      env,
      makeCtx().ctx,
    );

    expect(response.status).toBe(500);
    expect(response.headers.get('Content-Range')).toBeNull();
    expect(await response.json()).toEqual({ error: 'internal' });
    expect(console.error).toHaveBeenCalledWith('unhandled', error.message);
  });

  it('still serves a satisfiable range without losing its offset', async () => {
    const { env } = fixture();
    const response = await worker.fetch(request(`/download/${VERSION}/${NAME}`, { Range: 'bytes=8-' }), env, makeCtx().ctx);

    expect(response.status).toBe(206);
    expect(response.headers.get('Content-Range')).toBe('bytes 8-31/32');
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(BYTES.slice(8));
  });

  it('still returns 416 and the size for the R2 InvalidRange code', async () => {
    const { env, bucket } = fixture();
    const head = vi.spyOn(bucket, 'head');
    const response = await worker.fetch(request(`/download/${VERSION}/${NAME}`, { Range: 'bytes=32-' }), env, makeCtx().ctx);

    expect(response.status).toBe(416);
    expect(response.headers.get('Content-Range')).toBe('bytes */32');
    expect(head).toHaveBeenCalledWith(KEY);
    expect(console.error).not.toHaveBeenCalled();
  });

  it('still returns 404 if the object disappears after InvalidRange', async () => {
    const { env, bucket } = fixture();
    const get = bucket.get.bind(bucket);
    vi.spyOn(bucket, 'get').mockImplementationOnce(async (key, options) => {
      try {
        return await get(key, options);
      } catch (error) {
        bucket.objects.delete(key);
        throw error;
      }
    });
    const response = await worker.fetch(request(`/download/${VERSION}/${NAME}`, { Range: 'bytes=32-' }), env, makeCtx().ctx);

    expect(response.status).toBe(404);
    expect(response.headers.get('Content-Range')).toBeNull();
    expect(console.error).not.toHaveBeenCalled();
  });
});
