import { Miniflare } from 'miniflare';
import { afterEach, expect, it, vi } from 'vitest';
import worker from '../src/index';
import * as ids from '../src/ids';
import { makeCtx, makeEnv } from './fakes';

const runtimes: Miniflare[] = [];
const bytes = new Uint8Array(64);
bytes.set([0x44, 0x53, 0x47, 0x31]);
const oldBody = new Uint8Array([7, 8, 9]);
async function setup() {
  const mf = new Miniflare({ telemetry: { enabled: false }, cf: false, workers: [{ config: {
    name: 'local', compatibilityDate: '2026-10-01',
    manifest: { mainModule: 'index.js', modules: { 'index.js': { type: 'esm', contents: 'export default {fetch(){return new Response("local");}}' } } },
    env: { BUCKET: { type: 'r2', name: 'synthetic' } } } }] });
  runtimes.push(mf);
  const bucket = await mf.getR2Bucket('BUCKET', 'local');
  const c = { ...makeEnv(), ...makeCtx() };
  const head = vi.fn((key: string) => bucket.head(key));
  const put = vi.fn((key: string, body: Uint8Array, options: R2PutOptions) => bucket.put(key, body, options));
  c.env.BUCKET = { head, put } as unknown as R2Bucket;
  return { ...c, bucket, head, put,
    request: (ttl = '30d') => worker.fetch(new Request('https://go.dshtui.com/api/v1/c?ttl=' + ttl, {
      method: 'POST', headers: { 'Content-Type': 'application/octet-stream', 'CF-Connecting-IP': '203.0.113.7' }, body: bytes,
    }), c.env, c.ctx) };
}
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(runtimes.splice(0).map(mf => mf.dispose())); });

it('real R2 conditional put creates once and returns null for the competing write', async () => {
  const c = await setup();
  const onlyIf = new Headers({ 'If-None-Match': '*' });
  const results = await Promise.all([
    c.bucket.put('probe', 'first', { onlyIf, customMetadata: { owner: 'first' } }),
    c.bucket.put('probe', 'second', { onlyIf, customMetadata: { owner: 'second' } }),
  ]);
  expect(results.filter(x => x !== null)).toHaveLength(1);
  expect(results.filter(x => x === null)).toHaveLength(1);
  const winner = results[0] ? 'first' : 'second';
  const object = (await c.bucket.get('probe'))!;
  expect(await object.text()).toBe(winner);
  expect(object.customMetadata).toEqual({ owner: winner });
  expect(await c.bucket.put('probe', 'replacement', { onlyIf })).toBeNull();
  expect(await (await c.bucket.get('probe'))!.text()).toBe(winner);
});

it.each(['7d', '30d', 'forever'] as const)('uploads %s with one conditional put and no head, preserving metadata and quota', async ttl => {
  const c = await setup();
  const response = await c.request(ttl);
  expect(response.status).toBe(201);
  const out = await response.json() as { id: string; deleteToken: string; expiresAt: string | null };
  const key = ids.objectKey(out.id)!;
  const stored = (await c.bucket.get(key))!;
  expect(new Uint8Array(await stored.arrayBuffer())).toEqual(bytes);
  expect(stored.httpMetadata?.contentType).toBe('application/octet-stream');
  const hash = Buffer.from(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(out.deleteToken))).toString('hex');
  expect(stored.customMetadata?.dt).toBe(hash);
  expect(out.expiresAt).toBe(ids.expiresAt(ids.tierOfTtl(ttl), stored.uploaded)?.toISOString() ?? null);
  expect([...c.kv.values.entries()].filter(([key]) => key.startsWith('up:')).map(([, value]) => value)).toEqual(['1']);
  expect(c.head).not.toHaveBeenCalled();
  expect(c.put).toHaveBeenCalledTimes(1);
  expect((c.put.mock.calls[0]![2].onlyIf as Headers).get('If-None-Match')).toBe('*');
});

it('retries a synthetic random ID collision without replacing the existing body or delete metadata', async () => {
  const c = await setup();
  await c.bucket.put('30d/K000000000', oldBody, { customMetadata: { dt: 'existing' } });
  const id = vi.spyOn(ids, 'newId').mockReturnValueOnce('K000000000').mockReturnValue('K111111111');
  const response = await c.request();
  expect(response.status).toBe(201);
  expect((await response.json() as { id: string }).id).toBe('K111111111');
  const existing = (await c.bucket.get('30d/K000000000'))!;
  expect(new Uint8Array(await existing.arrayBuffer())).toEqual(oldBody);
  expect(existing.customMetadata).toEqual({ dt: 'existing' });
  expect(id).toHaveBeenCalledTimes(2);
  expect(c.head).not.toHaveBeenCalled();
  expect(c.put).toHaveBeenCalledTimes(2);
  expect([...c.kv.values.values()]).toEqual(['1']);
});

it('stops after four collisions without committing quota or touching the existing blob', async () => {
  const c = await setup();
  await c.bucket.put('30d/K000000000', oldBody, { customMetadata: { dt: 'existing' } });
  const id = vi.spyOn(ids, 'newId').mockReturnValue('K000000000');
  const response = await c.request();
  expect(response.status).toBe(503);
  expect(await response.json()).toEqual({ error: 'try_again' });
  expect(id).toHaveBeenCalledTimes(4);
  expect(c.put).toHaveBeenCalledTimes(4);
  expect(c.head).not.toHaveBeenCalled();
  expect([...c.kv.values.values()]).toEqual([]);
  expect(new Uint8Array(await (await c.bucket.get('30d/K000000000'))!.arrayBuffer())).toEqual(oldBody);
});

it('a competing commit between ID selection and put cannot be overwritten', async () => {
  const c = await setup();
  vi.spyOn(ids, 'newId').mockReturnValueOnce('K000000000').mockReturnValue('K111111111');
  c.put.mockImplementationOnce(async (key, body, options) => {
    await c.bucket.put(key, oldBody, { customMetadata: { dt: 'other-upload' } });
    return c.bucket.put(key, body, options);
  });
  const response = await c.request();
  expect(response.status).toBe(201);
  const result = await response.json() as { id: string };
  const existing = (await c.bucket.get('30d/K000000000'))!;
  expect(new Uint8Array(await existing.arrayBuffer())).toEqual(oldBody);
  expect(existing.customMetadata).toEqual({ dt: 'other-upload' });
  expect(result.id).toBe('K111111111');
  expect(c.put).toHaveBeenCalledTimes(2);
  expect([...c.kv.values.values()]).toEqual(['1']);
});

it('a storage exception is not treated as a collision or quota commit', async () => {
  const c = await setup();
  vi.spyOn(console, 'error').mockImplementation(() => {});
  const id = vi.spyOn(ids, 'newId').mockReturnValue('K000000000');
  c.put.mockRejectedValue(new Error('synthetic storage failure'));
  const response = await c.request();
  expect(response.status).toBe(500);
  expect(await response.json()).toEqual({ error: 'internal' });
  expect(id).toHaveBeenCalledTimes(1);
  expect(c.put).toHaveBeenCalledTimes(1);
  expect(c.head).not.toHaveBeenCalled();
  expect([...c.kv.values.values()]).toEqual([]);
});
