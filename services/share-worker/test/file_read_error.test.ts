import { afterEach, describe, expect, it, vi } from 'vitest';
import worker from '../src/index';
import { makeCtx, makeEnv } from './fakes';

const path = '/download/0.9.8/dsh-go-0.9.8-arm64.apk';
const key = 'beta/0.9.8/dsh-go-0.9.8-arm64.apk';

function setup() {
  const { env, bucket } = makeEnv({ DOWNLOAD_ACCESS: 'public' });
  bucket.objects.set(key, { bytes: new Uint8Array([1, 2, 3]), uploaded: new Date('2026-10-30T04:00:00Z'), customMetadata: {} });
  const { ctx } = makeCtx();
  const request = (headers?: HeadersInit) => worker.fetch(new Request('https://go.dshtui.com' + path, { headers }), env, ctx);
  return { bucket, request };
}

afterEach(() => vi.restoreAllMocks());

describe('download object read failures', () => {
  it('keeps an ordinary storage read failure as a server error, without probing Range metadata', async () => {
    const { bucket, request } = setup();
    vi.spyOn(bucket, 'get').mockRejectedValue(new Error('synthetic storage unavailable'));
    const head = vi.spyOn(bucket, 'head');
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const response = await request();
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: 'internal' });
    expect(response.headers.get('content-range')).toBeNull();
    expect(head).not.toHaveBeenCalled();
  });
  it('keeps a successful complete download unchanged', async () => {
    const { request } = setup();
    const response = await request();
    expect(response.status).toBe(200);
    expect([...new Uint8Array(await response.arrayBuffer())]).toEqual([1, 2, 3]);
  });
  it('keeps a satisfiable range as partial content', async () => {
    const { request } = setup();
    const response = await request({ Range: 'bytes=1-' });
    expect(response.status).toBe(206);
    expect(response.headers.get('content-range')).toBe('bytes 1-2/3');
    expect([...new Uint8Array(await response.arrayBuffer())]).toEqual([2, 3]);
  });
  it('keeps a range beyond the object as 416', async () => {
    const { request } = setup();
    const response = await request({ Range: 'bytes=3-' });
    expect(response.status).toBe(416);
    expect(response.headers.get('content-range')).toBe('bytes */3');
  });
});
