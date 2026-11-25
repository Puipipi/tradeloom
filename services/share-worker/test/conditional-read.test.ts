import { afterEach, expect, it, vi } from 'vitest';
import { Miniflare } from 'miniflare';
import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import worker from '../src/index';
import { makeCtx, makeEnv } from './fakes';

const key = 'beta/0.9.8/dsh-go-0.9.8-arm64.apk';
const url = 'https://go.dshtui.com/download/0.9.8/dsh-go-0.9.8-arm64.apk';
const runtimes: Miniflare[] = [];
async function setup() {
  const mf = new Miniflare({ telemetry: { enabled: false }, cf: false, workers: [{ config: {
    name: 'local', compatibilityDate: '2026-10-01',
    manifest: { mainModule: 'index.js', modules: { 'index.js': { type: 'esm', contents: 'export default {fetch(){return new Response("local");}}' } } },
    env: { BUCKET: { type: 'r2', name: 'synthetic' } } } }] });
  runtimes.push(mf);
  const c = { ...makeEnv({ DOWNLOAD_ACCESS: 'public' }), ...makeCtx() };
  const bucket = await mf.getR2Bucket('BUCKET', 'local');
  c.env.BUCKET = bucket as unknown as R2Bucket;
  const bytes = new Uint8Array(1024 * 1024);
  const meta = await bucket.put(key, bytes);
  return { ...c, bucket, etag: meta!.httpEtag, uploaded: meta!.uploaded, size: bytes.length,
    request: (headers: HeadersInit, method = 'GET') => worker.fetch(new Request(url, { method, headers }), c.env, c.ctx) };
}
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(runtimes.splice(0).map(mf => mf.dispose())); });

it('rejects a long invalid list in a bounded subprocess without backtracking', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'conditional-tags-'));
  try {
    const bundled = await build({ entryPoints: [resolve('src/index.ts')], bundle: true, platform: 'node', format: 'esm', write: false });
    writeFileSync(join(dir, 'worker.mjs'), bundled.outputFiles[0]!.text);
    writeFileSync(join(dir, 'probe.mjs'), `
      import worker from './worker.mjs';
      let gets = 0;
      const env = { DOWNLOAD_ACCESS: 'public', BUCKET: { async get(key, options) {
        gets++;
        if (options?.onlyIf) throw new Error('invalid list reached R2');
        return {body: new Response('abc').body, size: 3, httpEtag: '"test"', uploaded: new Date(0)};
      } } };
      const response = await worker.fetch(new Request('${url}', {
        headers: {'If-None-Match': ', '.repeat(10000) + 'junk'}
      }), env, {waitUntil() {}});
      if (response.status !== 200 || await response.text() !== 'abc' || gets !== 1) throw new Error('wrong response');
      console.log('linear-list-ok');
    `);
    expect(execFileSync(process.execPath, [join(dir, 'probe.mjs')], { encoding: 'utf8', timeout: 2000 }).trim()).toBe('linear-list-ok');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}, 10_000);

it.each(['GET', 'HEAD'])('cold %s recognizes the ETag it advertised', async method => {
  const c = await setup();
  const response = await c.request({ 'If-None-Match': c.etag }, method);
  const transferred = (await response.arrayBuffer()).byteLength;
  console.log(JSON.stringify({ method, bytes: c.size, transferred, status: response.status }));
  expect(response.status).toBe(304);
  expect(transferred).toBe(0);
  expect(response.headers.get('etag')).toBe(c.etag);
});

it.each(['weak', 'list', 'wildcard'])('honors %s entity tags without downloading the representation', async kind => {
  const c = await setup();
  const value = kind === 'weak' ? 'W/' + c.etag : kind === 'list' ? '"other,tag", W/' + c.etag : '*';
  expect((await c.request({ 'If-None-Match': value })).status).toBe(304);
});

it.each(['leading', 'trailing', 'multiple'])('accepts reasonable %s empty list members around a valid ETag', async kind => {
  const c = await setup();
  const value = kind === 'leading' ? ', ' + c.etag : kind === 'trailing' ? c.etag + ',' : ',, W/' + c.etag + ', ,';
  expect((await c.request({ 'If-None-Match': value })).status).toBe(304);
});

it('honors Last-Modified at HTTP second precision', async () => {
  const c = await setup();
  expect((await c.request({ 'If-Modified-Since': c.uploaded.toUTCString() })).status).toBe(304);
});

it('a nonmatching ETag takes precedence over a future modified-since date', async () => {
  const c = await setup();
  const response = await c.request({ 'If-None-Match': '"different"', 'If-Modified-Since': new Date(c.uploaded.getTime() + 60_000).toUTCString() });
  expect(response.status).toBe(200);
  expect((await response.arrayBuffer()).byteLength).toBe(c.size);
});

it('keeps invalid dates and invalid tag lists as ordinary full downloads', async () => {
  const c = await setup();
  for (const headers of [{ 'If-Modified-Since': 'not-a-date' }, { 'If-None-Match': 'junk ' + c.etag }]) {
    const response = await c.request(headers);
    expect(response.status).toBe(200);
    expect((await response.arrayBuffer()).byteLength).toBe(c.size);
  }
});

it('missing and inaccessible files do not become not-modified', async () => {
  const c = await setup();
  await c.bucket.delete(key);
  expect((await c.request({ 'If-None-Match': '*' })).status).toBe(404);
  c.env.DOWNLOAD_ACCESS = 'private';
  expect((await c.request({ 'If-None-Match': '*' })).status).toBe(404);
});

it.each(['bytes=10-', 'bytes=9999999-'])('matching validators take precedence over Range %s', async range => {
  const c = await setup();
  const response = await c.request({ 'If-None-Match': c.etag, Range: range });
  expect(response.status).toBe(304);
  expect(response.headers.get('content-range')).toBeNull();
  expect(response.headers.get('content-length')).toBeNull();
  expect((await response.arrayBuffer()).byteLength).toBe(0);
});

it('unmatched validators still return the requested byte range', async () => {
  const c = await setup();
  const response = await c.request({ 'If-None-Match': '"different"', Range: 'bytes=10-19' });
  expect(response.status).toBe(206);
  expect(response.headers.get('content-range')).toBe(`bytes 10-19/${c.size}`);
  expect((await response.arrayBuffer()).byteLength).toBe(10);
});

it('conditional HEAD cancels an unneeded R2 body and ignores Range', async () => {
  const c = await setup();
  const cancel = vi.fn();
  const original = c.env.BUCKET;
  c.env.BUCKET = { get: async (key: string, options: R2GetOptions) => {
    const result = await original.get(key, options);
    if (result && 'body' in result) {
      const originalCancel = result.body.cancel.bind(result.body);
      result.body.cancel = async reason => { cancel(); await originalCancel(reason); };
    }
    return result;
  } } as R2Bucket;
  const response = await c.request({ 'If-None-Match': '"different"', Range: 'bytes=9999999-' }, 'HEAD');
  expect(response.status).toBe(200);
  expect(response.headers.get('content-length')).toBe(String(c.size));
  expect((await response.arrayBuffer()).byteLength).toBe(0);
  expect(cancel).toHaveBeenCalledTimes(1);
});

it('does not interpret unrelated preconditions as cache-validation failures', async () => {
  const c = await setup();
  const response = await c.request({ 'If-Match': '"different"' });
  expect(response.status).toBe(200);
  expect((await response.arrayBuffer()).byteLength).toBe(c.size);
});
