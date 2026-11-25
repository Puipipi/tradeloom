// Local workerd execution, not a deployed Worker or a real Cloudflare bucket.
// Runs the actual generated bundle against the App's existing PNG vectors and
// catches differences between Node's zlib and Workers' node:zlib implementation.
import { readFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { expect, it } from 'vitest';
import { chunk, metaFor, pet } from './workshop-fixtures';

it('enforces full PNG/ZIP/DEFLATE bounds inside local workerd', async () => {
  const bundle = await build({ stdin: { contents: `
    import { validatePack } from './src/workshop-pack';
    import { validatePng } from './src/workshop-png';
    import { inflate } from './src/workshop-archive';
    export default { async fetch(request) {
      try {
        const bytes = new Uint8Array(await request.arrayBuffer());
        const path = new URL(request.url).pathname;
        const result = path === '/pack' ? validatePack(bytes, JSON.parse(decodeURIComponent(request.headers.get('X-Synthetic-Metadata'))), 6)
          : path === '/deflate' ? inflate(bytes, 3).length : validatePng(bytes);
        return Response.json({ok:true,result});
      } catch(e) { return Response.json({ok:false,code:e.code ?? 'unknown'}); }
    } };`, resolveDir: fileURLToPath(new URL('../', import.meta.url)), loader: 'ts' },
    bundle: true, write: false, format: 'esm', platform: 'browser', target: 'es2022', external: ['node:zlib'] });
  const runtime = new Miniflare(convertV4MiniflareOptions({ modules: true, compatibilityDate: '2026-10-01', compatibilityFlags: ['nodejs_compat'], script: bundle.outputFiles[0]!.text }));
  try {
    const corpus = JSON.parse(readFileSync(new URL('../../../app/test/pets/fixtures/pet-png-v2.json', import.meta.url), 'utf8'));
    for (const c of corpus.cases) {
      const response = await runtime.dispatchFetch('https://workshop.invalid/png', { method: 'POST', body: Buffer.from(c.base64, 'base64') });
      expect((await response.json() as any).ok, c.name).toBe(c.accepted);
    }
    // A normal, legal image at the decoded-pixel ceiling. This is one actual
    // successful input, not a proof of whole-process/concurrent memory bounds.
    const header = Buffer.alloc(13); header.writeUInt32BE(2048); header.writeUInt32BE(2048, 4); header[8] = 16; header[9] = 6;
    const rawSize = (2048 * 8 + 1) * 2048;
    const largePng = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', deflateSync(Buffer.alloc(rawSize))), chunk('IEND', Buffer.alloc(0))]);
    const large = await runtime.dispatchFetch('https://workshop.invalid/png', { method: 'POST', body: largePng });
    expect(await large.json()).toMatchObject({ ok: true, result: { width: 2048, height: 2048, pixels: 4194304, rgbaSum: 0 } });
    const bytes = pet();
    const accepted = await runtime.dispatchFetch('https://workshop.invalid/pack', { method: 'POST', body: bytes, headers: { 'X-Synthetic-Metadata': encodeURIComponent(JSON.stringify(metaFor(bytes))) } });
    expect(await accepted.json()).toMatchObject({ ok: true, result: { files: 2, sheets: 1 } });
    // Stored final deflate block for "abc", then otherwise harmless garbage:
    // Workers must report the consumed compressed bytes so our EOF gate fires.
    const exact = await runtime.dispatchFetch('https://workshop.invalid/deflate', { method: 'POST', body: Buffer.from([1, 3, 0, 252, 255, 97, 98, 99]) });
    expect(await exact.json()).toMatchObject({ ok: true, result: 3 });
    const truncated = await runtime.dispatchFetch('https://workshop.invalid/deflate', { method: 'POST', body: Buffer.from([0, 3, 0, 252, 255, 97, 98, 99]) });
    expect(await truncated.json()).toMatchObject({ ok: false, code: 'inflate_invalid' });
    const trailing = await runtime.dispatchFetch('https://workshop.invalid/deflate', { method: 'POST', body: Buffer.from([1, 3, 0, 252, 255, 97, 98, 99, 42]) });
    expect(await trailing.json()).toMatchObject({ ok: false, code: 'inflate_trailing' });
    const oversized = await runtime.dispatchFetch('https://workshop.invalid/deflate', { method: 'POST', body: Buffer.from([1, 4, 0, 251, 255, 97, 98, 99, 100]) });
    expect(await oversized.json()).toMatchObject({ ok: false, code: 'inflate_invalid' });
  } finally { await runtime.dispose(); }
}, 30000);
