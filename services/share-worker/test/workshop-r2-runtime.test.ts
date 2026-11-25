// Native local workerd/R2 API behavior. outboundService stands in for api.github.com;
// no real key, external request, Cloudflare account or deployed bucket is used.
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { Miniflare, Response as MiniflareResponse, convertV4MiniflareOptions } from 'miniflare';
import { expect, it } from 'vitest';
import { assetUrl } from '../src/workshop-common';
import { metaFor, pet } from './workshop-fixtures';

it('completes review and withdrawal with local native R2 checksum/CAS/Range', async () => {
  const bundle = await build({ entryPoints: [fileURLToPath(new URL('../src/index.ts', import.meta.url))], bundle: true, write: false,
    format: 'esm', platform: 'browser', target: 'es2022', external: ['node:zlib', 'cloudflare:workers'] });
  const calls: string[] = []; let redirectAccount = false;
  const runtime = new Miniflare(convertV4MiniflareOptions({ modules: true, compatibilityDate: '2026-10-01', compatibilityFlags: ['nodejs_compat'],
    script: bundle.outputFiles[0]!.text, r2Buckets: ['BUCKET', 'DL'], bindings: { ADMIN_KEY: 'synthetic-admin-key-0123456789abcdef' },
    outboundService: async request => {
      calls.push(request.url); expect(request.url).toBe('https://api.github.com/user');
      expect(request.headers.get('Authorization')).toBe('Bearer synthetic_github_token');
      if (redirectAccount) return new MiniflareResponse(null, { status: 302, headers: { Location: 'https://redirected.invalid/' } });
      return new MiniflareResponse(JSON.stringify({ id: 42, login: 'synthetic-user' }));
    },
  }));
  const call = (path: string, method = 'GET', body?: object | Uint8Array, admin = false, extra = {}) => runtime.dispatchFetch('https://workshop.invalid' + path, {
    method, headers: { Authorization: 'Bearer synthetic_github_token', 'X-Workshop-Account-Origin': 'https://github.com', ...(body ? { 'Content-Type': body instanceof Uint8Array ? 'application/zip' : 'application/json' } : {}),
      ...(admin ? { 'X-Admin-Key': 'synthetic-admin-key-0123456789abcdef' } : {}), ...extra }, ...(body ? { body: body instanceof Uint8Array ? body : JSON.stringify(body) } : {}),
  });
  try {
    const bytes = pet(), meta = metaFor(bytes), base = '/api/workshop/v1';
    const creation = await call(base + '/submissions', 'POST', { ...meta, requestId: 'synthetic_native_r2_request' }); expect(creation.status, await creation.clone().text()).toBe(201);
    const { submission } = await creation.json() as any, sid = submission.submissionId;
    const uploaded = await call(`${base}/submissions/${sid}/archive`, 'PUT', bytes); expect(uploaded.status).toBe(200);
    expect((await call(assetUrl(meta))).status).toBe(404);
    const approved = await call(`${base}/admin/submissions/${sid}/review`, 'POST', { decision: 'approve', reason: 'Synthetic native review' }, true);
    expect(approved.status).toBe(200);
    const range = await call(assetUrl(meta), 'GET', undefined, false, { Range: 'bytes=2-7' }); expect(range.status).toBe(206);
    expect(Buffer.from(await range.arrayBuffer())).toEqual(bytes.subarray(2, 8));
    const response = await call(assetUrl(meta)), tag = response.headers.get('ETag')!;
    expect(Buffer.from(await response.arrayBuffer())).toEqual(bytes);
    expect((await call(assetUrl(meta), 'HEAD', undefined, false, { 'If-None-Match': tag })).status).toBe(304);
    const withdrawn = await call(`${base}/submissions/${sid}/withdraw`, 'POST', { reason: 'Synthetic native withdrawal' }); expect(withdrawn.status).toBe(200);
    expect((await call(assetUrl(meta), 'GET', undefined, false, { Range: 'bytes=2-', 'If-None-Match': tag })).status).toBe(404);
    expect(calls).toHaveLength(3);
    redirectAccount = true; const redirected = await call(base + '/submissions');
    expect(redirected.status).toBe(503); expect(await redirected.json()).toEqual({ error: 'workshop_account_unavailable' });
    expect(calls).toHaveLength(4); expect(calls.every(url => url === 'https://api.github.com/user')).toBe(true);
  } finally { await runtime.dispose(); }
}, 30000);
