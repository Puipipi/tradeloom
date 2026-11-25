import { createHmac } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import worker from '../src/index';
import type { Env } from '../src/env';
import { hmacHex, resetStatsMemo } from '../src/stats';
import { resetUsageMemo } from '../src/usage';
import { makeCtx, makeEnv } from './fakes';
const A = 'synthetic-usage-secret-A-0123456789', B = 'synthetic-usage-secret-B-0123456789';
const NOW = Date.parse('2026-11-05T00:00:00Z');
function iid(n: number): string { const bytes = Buffer.alloc(16); bytes.writeUInt32BE(n); return bytes.toString('base64url'); }
const expected = (secret: string, n: number) => createHmac('sha256', secret).update(`iid\n${iid(n)}`).digest('hex').slice(0, 32);
async function post(env: Env, n: number, day = '2026-11-05') {
  return worker.fetch(new Request('https://go.dshtui.com/api/usage/v1', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '203.0.113.1' },
    body: JSON.stringify({ v: 1, iid: iid(n), day, app: '1.0.10', build: 1, sdk: 34, abi: 'arm64-v8a', maker: 'test', lang: 'zh', engine: 'proot',
      counts: { turns: 1, voice: 0, phone: 0, share: 0, gen: 0, plugins: 0 } }),
  }), env, makeCtx());
}
beforeEach(() => { resetStatsMemo(); resetUsageMemo(); vi.spyOn(Date, 'now').mockReturnValue(NOW); });
afterEach(() => { vi.restoreAllMocks(); resetStatsMemo(); resetUsageMemo(); });
describe('usage completed HMAC imports', () => {
  it('100 sequential real HTTP reports preserve all hashes/signs with one import', async () => {
    const { env, usage } = makeEnv({ USAGE_SECRET: A });
    const imports = vi.spyOn(crypto.subtle, 'importKey'), signs = vi.spyOn(crypto.subtle, 'sign');
    for (let n = 0; n < 100; n++) expect((await post(env, n)).status).toBe(204);
    expect(usage.points.map(p => p.blobs[1])).toEqual(Array.from({ length: 100 }, (_, n) => expected(A, n)));
    expect(signs).toHaveBeenCalledTimes(100); expect(imports).toHaveBeenCalledTimes(1);
  });
  it('duplicate and different-day reports still deduplicate by day/device', async () => {
    const { env, usage } = makeEnv({ USAGE_SECRET: A }); const imports = vi.spyOn(crypto.subtle, 'importKey');
    for (const day of ['2026-11-05', '2026-11-05', '2026-11-04']) expect((await post(env, 1, day)).status).toBe(204);
    expect(usage.points.map(p => p.blobs.slice(0, 2))).toEqual([['2026-11-05', expected(A, 1)], ['2026-11-04', expected(A, 1)]]);
    expect(imports).toHaveBeenCalledTimes(1);
  });
  it('uses the exact binding secret through A/B/A rotation', async () => {
    const a = makeEnv({ USAGE_SECRET: A }), b = makeEnv({ USAGE_SECRET: B }); const imports = vi.spyOn(crypto.subtle, 'importKey');
    expect((await post(a.env, 1)).status).toBe(204); expect((await post(b.env, 1)).status).toBe(204); expect((await post(a.env, 2)).status).toBe(204);
    expect(a.usage.points.map(p => p.blobs[1])).toEqual([expected(A, 1), expected(A, 2)]);
    expect(b.usage.points.map(p => p.blobs[1])).toEqual([expected(B, 1)]); expect(imports).toHaveBeenCalledTimes(3);
  });
  it('does not retain or share pending imports across eight cold requests', async () => {
    const { env, usage } = makeEnv({ USAGE_SECRET: A });
    const real = crypto.subtle.importKey.bind(crypto.subtle), gate = Promise.withResolvers<void>(), entered = Promise.withResolvers<void>(); let count = 0;
    vi.spyOn(crypto.subtle, 'importKey').mockImplementation(async (...args) => { if (++count === 8) entered.resolve(); await gate.promise; return real(...args); });
    const requests = Array.from({ length: 8 }, (_, n) => post(env, n));
    try {
      await entered.promise; gate.resolve(); expect((await Promise.all(requests)).map(r => r.status)).toEqual(Array(8).fill(204)); expect(count).toBe(8);
      expect(usage.points.map(p => p.blobs[1]).sort()).toEqual(Array.from({ length: 8 }, (_, n) => expected(A, n)).sort());
    } finally { gate.resolve(); await Promise.allSettled(requests); }
  });
  it('a late A import never causes B to use A', async () => {
    const a = makeEnv({ USAGE_SECRET: A }), b = makeEnv({ USAGE_SECRET: B });
    const real = crypto.subtle.importKey.bind(crypto.subtle), gate = Promise.withResolvers<void>(), entered = Promise.withResolvers<void>(); let count = 0;
    vi.spyOn(crypto.subtle, 'importKey').mockImplementation(async (...args) => { if (++count === 1) { entered.resolve(); await gate.promise; } return real(...args); });
    const late = post(a.env, 1);
    try {
      await entered.promise; expect((await post(b.env, 1)).status).toBe(204); gate.resolve(); expect((await late).status).toBe(204);
      expect((await post(b.env, 2)).status).toBe(204); expect(a.usage.points[0]!.blobs[1]).toBe(expected(A, 1));
      expect(b.usage.points.map(p => p.blobs[1])).toEqual([expected(B, 1), expected(B, 2)]); expect(count).toBe(3);
    } finally { gate.resolve(); await Promise.allSettled([late]); }
  });
  it('a failed rotated import is not cached and never falls back to the old key', async () => {
    const a = makeEnv({ USAGE_SECRET: A }), b = makeEnv({ USAGE_SECRET: B }); expect((await post(a.env, 1)).status).toBe(204);
    const real = crypto.subtle.importKey.bind(crypto.subtle);
    const imports = vi.spyOn(crypto.subtle, 'importKey').mockRejectedValueOnce(new Error('synthetic import failure')).mockImplementation(real);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect((await post(b.env, 1)).status).toBe(500); expect(b.usage.points).toHaveLength(0);
    expect((await post(b.env, 1)).status).toBe(204); expect(b.usage.points[0]!.blobs[1]).toBe(expected(B, 1)); expect(imports).toHaveBeenCalledTimes(2);
  });
  it('CryptoKey callers neither reimport nor replace the usage-secret slot', async () => {
    const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(B), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const imports = vi.spyOn(crypto.subtle, 'importKey');
    expect(await hmacHex(A, `iid\n${iid(1)}`, 16)).toBe(expected(A, 1)); expect(await hmacHex(key, `iid\n${iid(2)}`, 16)).toBe(expected(B, 2));
    expect(await hmacHex(A, `iid\n${iid(3)}`, 16)).toBe(expected(A, 3)); expect(imports).toHaveBeenCalledTimes(1);
  });
});
