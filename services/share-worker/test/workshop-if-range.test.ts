// Small original synthetic archive; no real model, account, credential or load.
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { workshop } from '../src/workshop';
import { assetUrl } from '../src/workshop-common';
import { makeCtx, makeEnv } from './fakes';
import { PetBucket } from './pet-market-fakes';
import { metaFor, pet } from './workshop-fixtures';

beforeEach(() => {
  vi.spyOn(globalThis, 'fetch').mockImplementation(async () => Response.json({ id: 42, login: 'synthetic-user' }));
});
afterEach(() => vi.restoreAllMocks());

async function published() {
  const bucket = new PetBucket();
  // HTTP Last-Modified has seconds, while R2 uploaded can have milliseconds.
  bucket.now = () => new Date('2026-11-11T00:00:00.789Z');
  const { env } = makeEnv({ BUCKET: bucket as unknown as R2Bucket }), bytes = pet(), meta = metaFor(bytes);
  const call = (path: string, method = 'GET', body?: object | Uint8Array, admin = false, headers = {}) => workshop(new Request('https://workshop.invalid' + path, {
    method, headers: { Authorization: 'Bearer synthetic_github_token', 'X-Workshop-Account-Origin': 'https://github.com', ...(admin ? { 'X-Admin-Key': env.ADMIN_KEY! } : {}),
      ...(body ? { 'Content-Type': body instanceof Uint8Array ? 'application/zip' : 'application/json' } : {}), ...headers },
    ...(body ? { body: body instanceof Uint8Array ? body : JSON.stringify(body) } : {}),
  }), env, makeCtx().ctx);
  const api = '/api/workshop/v1';
  const creation = await call(api + '/submissions', 'POST', { ...meta, requestId: 'if_range_synthetic_request' });
  expect(creation.status).toBe(201);
  const { submission } = await creation.json() as any;
  expect((await call(`${api}/submissions/${submission.submissionId}/archive`, 'PUT', bytes)).status).toBe(200);
  expect((await call(`${api}/admin/submissions/${submission.submissionId}/review`, 'POST', { decision: 'approve', reason: 'Synthetic review' }, true)).status).toBe(200);
  const path = assetUrl(meta), response = await call(path);
  expect(Buffer.from(await response.arrayBuffer())).toEqual(bytes);
  return { bytes, tag: response.headers.get('ETag')!, modified: response.headers.get('Last-Modified')!,
    get: (headers: Record<string, string>) => call(path, 'GET', undefined, false, headers) };
}

it.each([[-60, 200], [0, 206], [60, 200]])('If-Range date %i seconds from Last-Modified returns %i', async (seconds, status) => {
  const f = await published(), date = new Date(Date.parse(f.modified) + seconds! * 1000).toUTCString();
  const response = await f.get({ Range: 'bytes=2-7', 'If-Range': date });
  expect(response.status).toBe(status);
  expect(Buffer.from(await response.arrayBuffer())).toEqual(status === 206 ? f.bytes.subarray(2, 8) : f.bytes);
  expect(response.headers.get('Content-Range')).toBe(status === 206 ? `bytes 2-7/${f.bytes.length}` : null);
});
it('keeps the exact strong ETag range match', async () => {
  const f = await published(), response = await f.get({ Range: 'bytes=2-7', 'If-Range': f.tag });
  expect(response.status).toBe(206);
  expect(Buffer.from(await response.arrayBuffer())).toEqual(f.bytes.subarray(2, 8));
});
it('does not use a weak ETag as an If-Range match', async () => {
  const f = await published(), response = await f.get({ Range: 'bytes=2-7', 'If-Range': `W/${f.tag}` });
  expect(response.status).toBe(200);
  expect(Buffer.from(await response.arrayBuffer())).toEqual(f.bytes);
});
it.each(['later date', 'weak ETag'])('ignores If-Range without Range (%s)', async kind => {
  const f = await published(), value = kind === 'later date' ? new Date(Date.parse(f.modified) + 60_000).toUTCString() : `W/${f.tag}`;
  const response = await f.get({ 'If-Range': value });
  expect(response.status).toBe(200);
  expect(Buffer.from(await response.arrayBuffer())).toEqual(f.bytes);
  expect(response.headers.get('Content-Range')).toBeNull();
});
