import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import worker from '../src/index';
import { keyId, KEY_PREFIX } from '../src/beta-auth';
import { resetBetaCache } from '../src/beta';
import { makeCtx, makeEnv } from './fakes';

const SECRET = 'body-test-secret-0123456789abcdef0123456789abcdef';
const KEY = 'dsh-k7m3x9qp';
const encode = (text: string) => new TextEncoder().encode(text);

beforeEach(() => {
  resetBetaCache();
  vi.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

async function seeded() {
  const ctx = makeEnv({ BETA_SECRET: SECRET });
  ctx.kv.values.set(KEY_PREFIX + await keyId(SECRET, KEY), JSON.stringify({ label: 'body-test' }));
  ctx.bucket.objects.set('beta/update.json', {
    bytes: encode(JSON.stringify({ version: '1.0.10', assets: { arm64: {
      name: 'dsh-go-1.0.10-arm64.apk', size: 42, sha256: 'ab'.repeat(32),
    } } })), uploaded: new Date(), customMetadata: {},
  });
  return ctx;
}

function streamed(bytes: Uint8Array, chunkSize: number, cancelFailure?: Error) {
  let sent = 0;
  let cancels = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (sent === bytes.length) { controller.close(); return; }
      const end = Math.min(sent + chunkSize, bytes.length);
      controller.enqueue(bytes.slice(sent, end));
      sent = end;
    },
    cancel() { cancels++; if (cancelFailure) return Promise.reject(cancelFailure); },
  }, { highWaterMark: 0 });
  return { stream, sent: () => sent, cancels: () => cancels };
}

function request(body: BodyInit | null) {
  return new Request('https://go.dshtui.com/beta/api/unlock', {
    method: 'POST', body, headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '203.0.113.17' },
    duplex: 'half',
  } as RequestInit);
}

async function send(ctx: Awaited<ReturnType<typeof seeded>>, body: BodyInit | null) {
  return worker.fetch(request(body), ctx.env, makeCtx().ctx);
}

function padded(character: string, units: number) {
  const prefix = JSON.stringify({ key: KEY, pad: '' }).slice(0, -2);
  const suffix = '"}';
  const text = prefix + character.repeat(units - prefix.length - suffix.length) + suffix;
  expect(text.length).toBe(units);
  return text;
}

describe('beta unlock body read budget', () => {
  it.each([false, true])('stops reading an oversized finite stream (cancel rejects: %s)', async (rejectCancel) => {
    const ctx = await seeded();
    const bytes = encode(padded('a', 1024 * 1024));
    const source = streamed(bytes, 512, rejectCancel ? new Error('cancel refused') : undefined);
    const res = await send(ctx, source.stream);
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'invalid_key' });
    console.info(JSON.stringify({ totalBytes: bytes.length, deliveredBytes: source.sent(), cancels: source.cancels(), rejectCancel }));
    expect(source.sent()).toBe(4608); // First over-budget chunk, no HWM prefetch.
    expect(source.cancels()).toBe(1);
  });

  it('preserves the 1024-code-unit limit for ASCII and multibyte text, including a BOM', async () => {
    for (const character of ['a', '界']) {
      for (const bom of ['', '\uFEFF']) {
        const ctx = await seeded();
        const bytes = encode(bom + padded(character, 1024));
        const source = streamed(bytes, 7); // Also splits UTF-8 sequences across chunks.
        const res = await send(ctx, source.stream);
        expect(res.status).toBe(200);
        expect((await res.json() as { version: string }).version).toBe('1.0.10');
        expect(source.sent()).toBe(bytes.length);
        expect(source.cancels()).toBe(0);
      }
    }
  });

  it('still rejects 1025 decoded code units below the byte cap', async () => {
    const ctx = await seeded();
    const source = streamed(encode(padded('界', 1025)), 17);
    const res = await send(ctx, source.stream);
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'invalid_key' });
    expect(source.cancels()).toBe(0);
  });

  it('preserves replacement decoding and full-width key normalization', async () => {
    const ctx = await seeded();
    const prefix = encode('{"key":"ｄｓｈ－ｋ７ｍ３ｘ９ｑｐ","pad":"');
    const suffix = encode('"}');
    const bytes = new Uint8Array(prefix.length + 3 + suffix.length);
    bytes.set(prefix); bytes.set([0xe0, 0x80, 0x80], prefix.length); bytes.set(suffix, prefix.length + 3);
    const res = await send(ctx, streamed(bytes, 1).stream);
    expect(res.status).toBe(200);
  });

  it('keeps stream read errors on the existing invalid-key response path', async () => {
    const ctx = await seeded();
    const stream = new ReadableStream<Uint8Array>({ pull(controller) { controller.error(new Error('input failed')); } });
    const res = await send(ctx, stream);
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'invalid_key' });
  });

  it('does not read when the existing rate limiter denies first', async () => {
    const ctx = await seeded();
    ctx.readLimit.allow = 0;
    const source = streamed(encode(padded('a', 8192)), 512);
    const res = await send(ctx, source.stream);
    expect(res.status).toBe(429);
    expect(source.sent()).toBe(0);
    expect(source.cancels()).toBe(0);
  });

  it('does not claim to cap the size of an already-delivered upstream chunk', async () => {
    const ctx = await seeded();
    const bytes = encode(padded('a', 1024 * 1024));
    const source = streamed(bytes, bytes.length);
    const res = await send(ctx, source.stream);
    expect(res.status).toBe(403);
    expect(source.sent()).toBe(bytes.length);
  });
});
