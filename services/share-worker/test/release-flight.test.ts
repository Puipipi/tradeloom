import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import worker from '../src/index';
import { resetBetaCache } from '../src/beta';
import { makeCtx, makeEnv } from './fakes';

const manifest = (version: string) => JSON.stringify({schema: 1, version: `${version}+123`, routes: ['global'], assets: {arm64: {name: `dsh-go-${version}-arm64.apk`, size: 10, sha256: 'ab'.repeat(32)}}});
let now = 1800000000000;
beforeEach(() => { now = 1800000000000; resetBetaCache(); vi.spyOn(Date, 'now').mockImplementation(() => now); });
afterEach(() => {vi.restoreAllMocks(); resetBetaCache();});
function fixture(version = '1.0.1') {
  const f = makeEnv({DOWNLOAD_ACCESS: 'public'});
  const seed = (text: string) => f.bucket.objects.set('beta/update.json', {bytes: new TextEncoder().encode(text), uploaded: new Date(), customMetadata: {}});
  seed(manifest(version));
  const get = vi.spyOn(f.bucket, 'get');
  const context = makeCtx();
  const waitUntil = vi.spyOn(context.ctx, 'waitUntil');
  const request = (env = f.env) => worker.fetch(new Request('https://go.dshtui.com/download'), env, context.ctx).then(async r => ({status: r.status, body: await r.text()}));
  return {...f, ...context, seed, get, request, waitUntil};
}
for (const expired of [false, true]) {
  it(`${expired ? 'expired' : 'cold'} public requests share one complete manifest read`, async () => {
    const f = fixture();
    if (expired) {await f.request(); now += 30001; f.seed(manifest('1.0.2')); f.get.mockClear();}
    const gate = Promise.withResolvers<void>();
    // Restore before binding the real implementation to avoid recursive spy calls.
    f.get.mockRestore();
    const read = f.bucket.get.bind(f.bucket);
    const get = vi.spyOn(f.bucket, 'get').mockImplementation(async (...args) => {await gate.promise; return read(...args);});
    const pending = Array.from({length:20}, () => f.request());
    gate.resolve();
    const responses = await Promise.all(pending);
    expect(responses.every(r => r.status === 200 && r.body.includes(expired ? '1.0.2' : '1.0.1'))).toBe(true);
    expect(get).toHaveBeenCalledTimes(1);
    await f.settle();
  });
}
it('warm memo retains the original 30s freshness boundary', async () => {
  const f = fixture(); await f.request(); f.seed(manifest('1.0.2')); now += 29999;
  expect((await f.request()).body).toContain('1.0.1'); expect(f.get).toHaveBeenCalledTimes(1);
  now++; expect((await f.request()).body).toContain('1.0.2'); expect(f.get).toHaveBeenCalledTimes(2);
});
it('different R2 bindings do not share pending results or completed memos', async () => {
  const a=fixture('1.0.1'), b=fixture('2.0.1');
  const first=await Promise.all([a.request(),b.request()]);
  expect(first[0].body).toContain('1.0.1');expect(first[1].body).toContain('2.0.1');
  expect((await a.request()).body).toContain('1.0.1');expect((await b.request()).body).toContain('2.0.1');
  expect(a.get).toHaveBeenCalledTimes(1);expect(b.get).toHaveBeenCalledTimes(1);
});
it('different Env objects with the same R2 binding share the decoded build', async () => {
  const f=fixture();const result=await Promise.all([f.request(),f.request({...f.env})]);
  expect(result[0].body).toBe(result[1].body);expect(f.get).toHaveBeenCalledTimes(1);
});
for (const mode of ['missing','invalid','exception']) {
  it(`${mode} preserves the existing 30s null memo and can refresh afterwards`, async () => {
    const f=fixture();
    if(mode==='missing')f.bucket.objects.delete('beta/update.json');
    if(mode==='invalid')f.seed('{');
    if(mode==='exception')f.get.mockRejectedValueOnce(new Error('synthetic R2 failure'));
    expect((await f.request()).status).toBe(200);
    f.seed(manifest('3.0.1'));
    expect((await f.request()).body).not.toContain('3.0.1');expect(f.get).toHaveBeenCalledTimes(1);
    now+=30000;expect((await f.request()).body).toContain('3.0.1');expect(f.get).toHaveBeenCalledTimes(2);
  });
}
it('origin waitUntil owns the pending R2 read until the whole body is decoded', async () => {
  const f=fixture();const body=Promise.withResolvers<string>();
  f.get.mockResolvedValue({text:()=>body.promise} as never);
  const pending=f.request();
  expect(f.waitUntil).toHaveBeenCalledTimes(1);
  let settled=false;const lifetime=f.waitUntil.mock.calls[0]![0].then(()=>{settled=true;});
  await Promise.resolve();expect(settled).toBe(false);
  body.resolve(manifest('4.0.1'));
  expect((await pending).body).toContain('4.0.1');await lifetime;expect(settled).toBe(true);
});
