import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import worker from '../src/index';
import { ALPHABET, ID_LENGTH, TIERS, newId, objectKey, parseTtl, tierOfId } from '../src/ids';
import { clientKey, uploadQuota } from '../src/limits';
import { makeEnv, serve, workerFirst } from './fakes';

const ORIGIN = 'https://go.dshtui.com';

function blob(size = 64): Uint8Array {
  const b = new Uint8Array(size);
  b.set([0x44, 0x53, 0x47, 0x31]);
  for (let i = 4; i < size; i++) b[i] = (i * 31) & 0xff;
  return b;
}

function post(body: BodyInit | null, { ttl, type = 'application/octet-stream', ip = '203.0.113.7', headers = {} }: { ttl?: string; type?: string | null; ip?: string; headers?: Record<string, string> } = {}) {
  const h = new Headers({ 'CF-Connecting-IP': ip, ...headers });
  if (type !== null) h.set('Content-Type', type);
  return new Request(`${ORIGIN}/api/v1/c${ttl === undefined ? '' : `?ttl=${ttl}`}`, { method: 'POST', body, headers: h, duplex: 'half' } as RequestInit);
}

const get = (path: string, headers: Record<string, string> = {}) =>
  new Request(ORIGIN + path, { headers: { 'CF-Connecting-IP': '198.51.100.1', ...headers } });

const del = (id: string, headers: Record<string, string>) =>
  new Request(`${ORIGIN}/api/v1/c/${id}`, { method: 'DELETE', headers: { 'CF-Connecting-IP': '198.51.100.1', ...headers } });

async function uploadOne(ctx: ReturnType<typeof makeEnv>, ttl?: string, bytes = blob()) {
  const res = await worker.fetch(post(bytes, { ttl }), ctx.env);
  expect(res.status).toBe(201);
  return (await res.json()) as { id: string; deleteToken: string; expiresAt: string | null };
}

describe('ids', () => {
  it('encodes the tier in the first character', () => {
    for (const tier of TIERS) {
      for (let i = 0; i < 200; i++) {
        const id = newId(tier.ttl);
        expect(id).toMatch(new RegExp(`^[0-9A-Za-z]{${ID_LENGTH}}$`));
        expect(tierOfId(id)?.ttl).toBe(tier.ttl);
        expect(objectKey(id)).toBe(tier.prefix + id);
      }
    }
  });

  it('covers the whole alphabet with no overlap', () => {
    const owners = [...ALPHABET].map((c) => TIERS.filter((t) => tierOfId(c + '000000000')?.ttl === t.ttl).length);
    expect(owners.every((n) => n === 1)).toBe(true);
  });

  it('uses every first character of a tier', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 2000; i++) seen.add(newId('forever')[0]!);
    expect(seen.size).toBe(22);
  });

  it('rejects ids that are not ours', () => {
    for (const bad of ['', 'abc', 'abcdefghij1', 'abcdefghi_', '../../etc/x', 'ÄbcdefghiJ']) expect(objectKey(bad)).toBeNull();
  });

  it('parses ttl with a 30d default', () => {
    expect(parseTtl(null)).toBe('30d');
    expect(parseTtl('')).toBe('30d');
    expect(parseTtl('7d')).toBe('7d');
    expect(parseTtl('forever')).toBe('forever');
    expect(parseTtl('1y')).toBeNull();
  });
});

describe('clientKey', () => {
  const key = (ip: string) => clientKey(new Request(ORIGIN, { headers: { 'CF-Connecting-IP': ip } }));
  it('keys IPv4 by address and IPv6 by /64', () => {
    expect(key('203.0.113.9')).toBe('203.0.113.9');
    expect(key('2001:db8:1:2:aaaa::1')).toBe('2001:db8:1:2::/64');
    expect(key('2001:0db8:0001:0002:ffff:ffff:ffff:ffff')).toBe('2001:db8:1:2::/64');
    expect(key('2001:db8::1')).toBe('2001:db8:0:0::/64');
    expect(clientKey(new Request(ORIGIN))).toBe('unknown');
  });
});

describe('upload', () => {
  it('stores the blob under its tier and returns the delete token', async () => {
    const ctx = makeEnv();
    const before = Date.now();
    const out = await uploadOne(ctx);
    expect(tierOfId(out.id)?.ttl).toBe('30d');
    expect(out.deleteToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const expires = Date.parse(out.expiresAt!);
    expect(expires - before).toBeGreaterThanOrEqual(30 * 86_400_000 - 1000);
    expect(expires - before).toBeLessThanOrEqual(30 * 86_400_000 + 5000);
    const stored = ctx.bucket.objects.get('30d/' + out.id)!;
    expect(stored.bytes).toEqual(blob());
    expect(stored.contentType).toBe('application/octet-stream');
    expect(stored.customMetadata.dt).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(stored.customMetadata)).not.toContain(out.deleteToken);
  });

  it('honours 7d and forever', async () => {
    const ctx = makeEnv();
    const week = await uploadOne(ctx, '7d');
    expect(ctx.bucket.objects.has('7d/' + week.id)).toBe(true);
    const keep = await uploadOne(ctx, 'forever');
    expect(keep.expiresAt).toBeNull();
    expect(ctx.bucket.objects.has('keep/' + keep.id)).toBe(true);
  });

  it('rejects what is not a DSG1 blob', async () => {
    const ctx = makeEnv();
    const bad = blob();
    bad[0] = 0x7b;
    expect((await worker.fetch(post(bad), ctx.env)).status).toBe(400);
    expect((await worker.fetch(post(blob(31)), ctx.env)).status).toBe(400);
    expect((await worker.fetch(post(blob(), { type: 'application/json' }), ctx.env)).status).toBe(415);
    expect((await worker.fetch(post(blob(), { type: null }), ctx.env)).status).toBe(415);
    expect((await worker.fetch(post(blob(), { type: 'application/octet-stream; charset=binary' }), ctx.env)).status).toBe(201);
    expect((await worker.fetch(post(blob(), { ttl: '1y' }), ctx.env)).status).toBe(400);
    expect(ctx.bucket.objects.size).toBe(1);
  });

  it('caps the size, declared or streamed', async () => {
    const ctx = makeEnv();
    const big = blob(1024 * 1024 + 1);
    expect((await worker.fetch(post(big), ctx.env)).status).toBe(413);
    const stream = new Blob([big]).stream();
    const res = await worker.fetch(post(stream), ctx.env);
    expect(res.status).toBe(413);
    expect((await worker.fetch(post(blob(1024 * 1024)), ctx.env)).status).toBe(201);
  });

  it('limits bursts per client', async () => {
    const ctx = makeEnv();
    ctx.uploadBurst.allow = 2;
    expect((await worker.fetch(post(blob()), ctx.env)).status).toBe(201);
    expect((await worker.fetch(post(blob()), ctx.env)).status).toBe(201);
    const third = await worker.fetch(post(blob()), ctx.env);
    expect(third.status).toBe(429);
    expect(third.headers.get('Retry-After')).toBe('60');
    expect((await worker.fetch(post(blob(), { ip: '203.0.113.8' }), ctx.env)).status).toBe(201);
  });

  it('allows 20 uploads an hour per client', async () => {
    const ctx = makeEnv();
    for (let i = 0; i < 20; i++) expect((await worker.fetch(post(blob()), ctx.env)).status).toBe(201);
    const over = await worker.fetch(post(blob()), ctx.env);
    expect(over.status).toBe(429);
    const retry = Number(over.headers.get('Retry-After'));
    expect(retry).toBeGreaterThan(0);
    expect(retry).toBeLessThanOrEqual(3600);
    expect((await worker.fetch(post(blob(), { ip: '2001:db8:9::1' }), ctx.env)).status).toBe(201);
    expect([...ctx.kv.values.keys()].join()).not.toContain('203.0.113.7');
  });

  for (const storage of ['available', 'missing', 'failing']) {
    it(`pauses uploads at zero even when quota storage is ${storage}`, async () => {
      const ctx = makeEnv({ UPLOADS_PER_HOUR: '0' });
      if (storage === 'missing') ctx.env.QUOTA = undefined;
      if (storage === 'failing') ctx.kv.failReads = ctx.kv.failWrites = true;
      let writes = 0;
      const put = ctx.bucket.put.bind(ctx.bucket);
      ctx.bucket.put = async (...args) => { writes++; return put(...args); };
      const response = await worker.fetch(post(blob()), ctx.env);
      expect(response.status).toBe(429);
      expect(await response.json()).toEqual({ error: 'rate_limited' });
      expect(Number(response.headers.get('Retry-After'))).toBeGreaterThan(0);
      expect(writes).toBe(0);
      expect(ctx.kv.values.size).toBe(0);
    });
  }

  it('keeps reads and authorized deletion available while uploads are paused', async () => {
    const ctx = makeEnv();
    const link = await uploadOne(ctx, 'forever');
    ctx.env.UPLOADS_PER_HOUR = '0';
    expect((await worker.fetch(post(blob()), ctx.env)).status).toBe(429);
    const response = await worker.fetch(get(`/api/v1/c/${link.id}`), ctx.env);
    expect(response.status).toBe(200);
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(blob());
    expect((await worker.fetch(del(link.id, { Authorization: `Bearer ${link.deleteToken}` }), ctx.env)).status).toBe(204);
  });

  it('preserves existing default and invalid quota configuration behavior', async () => {
    for (const setting of [undefined, '', '  ', 'not-a-number']) {
      const ctx = makeEnv({ UPLOADS_PER_HOUR: setting });
      ctx.kv.get = async () => '19';
      expect((await uploadQuota(ctx.env, 'synthetic', 0)).allowed, String(setting)).toBe(true);
      ctx.kv.get = async () => '20';
      expect((await uploadQuota(ctx.env, 'synthetic', 0)).allowed, String(setting)).toBe(false);
    }
    const negative = makeEnv({ UPLOADS_PER_HOUR: '-1' });
    expect((await uploadQuota(negative.env, 'synthetic', 0)).allowed).toBe(false);
    const infinite = makeEnv({ UPLOADS_PER_HOUR: 'Infinity' });
    infinite.kv.get = async () => '20';
    expect((await uploadQuota(infinite.env, 'synthetic', 0)).allowed).toBe(true);
  });

  it('does not count rejected uploads', async () => {
    const ctx = makeEnv({ UPLOADS_PER_HOUR: '1' });
    expect((await worker.fetch(post(blob(8)), ctx.env)).status).toBe(400);
    expect((await worker.fetch(post(blob()), ctx.env)).status).toBe(201);
    expect((await worker.fetch(post(blob()), ctx.env)).status).toBe(429);
  });

  it('fails open when the counters are unavailable', async () => {
    const ctx = makeEnv({ UPLOADS_PER_HOUR: '1' });
    ctx.kv.failReads = true;
    ctx.kv.failWrites = true;
    expect((await worker.fetch(post(blob()), ctx.env)).status).toBe(201);
    expect((await worker.fetch(post(blob()), ctx.env)).status).toBe(201);
    const bare = makeEnv({ QUOTA: undefined, UPLOAD_BURST: undefined, READ_LIMIT: undefined });
    expect((await worker.fetch(post(blob()), bare.env)).status).toBe(201);
  });
});

describe('read', () => {
  it('returns the ciphertext as an opaque download', async () => {
    const ctx = makeEnv();
    const { id } = await uploadOne(ctx, '7d');
    const res = await worker.fetch(get(`/api/v1/c/${id}`), ctx.env);
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('application/octet-stream');
    expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(res.headers.get('Content-Disposition')).toContain('attachment');
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    expect(res.headers.get('Content-Security-Policy')).toContain('sandbox');
    expect(res.headers.get('Access-Control-Allow-Origin')).toBeNull();
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(blob());
  });

  it('404s unknown, malformed and expired ids', async () => {
    const ctx = makeEnv();
    expect((await worker.fetch(get('/api/v1/c/eZZZZZZZZZ'), ctx.env)).status).toBe(404);
    expect((await worker.fetch(get('/api/v1/c/..%2F..%2Fx'), ctx.env)).status).toBe(404);
    expect((await worker.fetch(get('/api/v1/c/short'), ctx.env)).status).toBe(404);
    ctx.bucket.now = () => new Date(Date.now() - 7 * 86_400_000 - 1000);
    const { id } = await uploadOne(ctx, '7d');
    expect((await worker.fetch(get(`/api/v1/c/${id}`), ctx.env)).status).toBe(404);
    ctx.bucket.now = () => new Date(Date.now() - 400 * 86_400_000);
    const keep = await uploadOne(ctx, 'forever');
    expect((await worker.fetch(get(`/api/v1/c/${keep.id}`), ctx.env)).status).toBe(200);
  });

  it('limits reads per client, loosely', async () => {
    const ctx = makeEnv();
    const { id } = await uploadOne(ctx);
    ctx.readLimit.allow = 3;
    for (let i = 0; i < 3; i++) expect((await worker.fetch(get(`/api/v1/c/${id}`), ctx.env)).status).toBe(200);
    expect((await worker.fetch(get(`/api/v1/c/${id}`), ctx.env)).status).toBe(429);
  });
});

describe('delete', () => {
  it('limits invalid admin headers before reading R2 metadata', async () => {
    for (const config of [{}, { ADMIN_KEY: undefined }, { ADMIN_KEY: 'short' }]) {
      for (const header of ['', 'wrong-admin-key']) {
        const ctx = makeEnv(config);
        const link = await uploadOne(ctx);
        ctx.readLimit.allow = 0;
        let heads = 0;
        const head = ctx.bucket.head.bind(ctx.bucket);
        ctx.bucket.head = async (key) => { heads++; return head(key); };
        const res = await worker.fetch(del(link.id, { 'X-Admin-Key': header }), ctx.env);
        expect(res.status).toBe(429);
        expect(await res.json()).toEqual({ error: 'rate_limited' });
        expect(res.headers.get('Retry-After')).toBe('60');
        expect(ctx.readLimit.keys).toEqual(['198.51.100.1']);
        expect(heads).toBe(0);
        expect(ctx.bucket.objects.size).toBe(1);
      }
    }
  });

  it('keeps invalid admin priority over a valid owner token when quota is available', async () => {
    const ctx = makeEnv();
    const link = await uploadOne(ctx);
    const headers = { 'X-Admin-Key': 'wrong', Authorization: `Bearer ${link.deleteToken}` };
    const res = await worker.fetch(del(link.id, headers), ctx.env);
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'forbidden' });
    expect(ctx.readLimit.keys).toEqual(['198.51.100.1']);
    expect(ctx.bucket.objects.size).toBe(1);
    expect((await worker.fetch(del('eZZZZZZZZZ', headers), ctx.env)).status).toBe(404);
  });

  it('exempts authenticated admins without calling the limiter or quota KV', async () => {
    const ctx = makeEnv();
    const link = await uploadOne(ctx);
    ctx.readLimit.allow = 0;
    let kvReads = 0;
    ctx.kv.get = async () => { kvReads++; throw new Error('unused'); };
    const headers = { 'X-Admin-Key': ctx.env.ADMIN_KEY! };
    expect((await worker.fetch(del(link.id, headers), ctx.env)).status).toBe(204);
    expect((await worker.fetch(del(link.id, headers), ctx.env)).status).toBe(404);
    expect(ctx.readLimit.keys).toEqual([]);
    expect(kvReads).toBe(0);
  });

  it('retains missing credentials and owner-token rate limiting', async () => {
    const ctx = makeEnv();
    const link = await uploadOne(ctx);
    ctx.readLimit.allow = 0;
    const missing = await worker.fetch(del(link.id, {}), ctx.env);
    expect(missing.status).toBe(401);
    expect(await missing.json()).toEqual({ error: 'unauthorized' });
    expect(ctx.readLimit.keys).toEqual([]);
    expect((await worker.fetch(del(link.id, { Authorization: `Bearer ${link.deleteToken}` }), ctx.env)).status).toBe(429);
    expect(ctx.bucket.objects.size).toBe(1);
  });

  it('needs the link\'s own token', async () => {
    const ctx = makeEnv();
    const a = await uploadOne(ctx);
    const b = await uploadOne(ctx);
    expect((await worker.fetch(del(a.id, {}), ctx.env)).status).toBe(401);
    expect((await worker.fetch(del(a.id, { Authorization: `Bearer ${b.deleteToken}` }), ctx.env)).status).toBe(403);
    expect((await worker.fetch(del(a.id, { Authorization: 'Bearer short' }), ctx.env)).status).toBe(401);
    const ok = await worker.fetch(del(a.id, { Authorization: `Bearer ${a.deleteToken}` }), ctx.env);
    expect(ok.status).toBe(204);
    expect((await worker.fetch(get(`/api/v1/c/${a.id}`), ctx.env)).status).toBe(404);
    expect((await worker.fetch(del(a.id, { Authorization: `Bearer ${a.deleteToken}` }), ctx.env)).status).toBe(404);
    expect((await worker.fetch(get(`/api/v1/c/${b.id}`), ctx.env)).status).toBe(200);
  });

  it('lets the admin key remove any link', async () => {
    const ctx = makeEnv();
    const a = await uploadOne(ctx, 'forever');
    expect((await worker.fetch(del(a.id, { 'X-Admin-Key': 'wrong-key-wrong-key-wrong-key-wrong' }), ctx.env)).status).toBe(403);
    expect((await worker.fetch(del(a.id, { 'X-Admin-Key': ctx.env.ADMIN_KEY }), ctx.env)).status).toBe(204);
    expect(ctx.bucket.objects.size).toBe(0);
  });

  it('refuses admin deletes when no key is set', async () => {
    const ctx = makeEnv({ ADMIN_KEY: undefined });
    const a = await uploadOne(ctx);
    expect((await worker.fetch(del(a.id, { 'X-Admin-Key': '' }), ctx.env)).status).toBe(403);
    const weak = makeEnv({ ADMIN_KEY: 'short' });
    const b = await uploadOne(weak);
    expect((await worker.fetch(del(b.id, { 'X-Admin-Key': 'short' }), weak.env)).status).toBe(403);
  });
});

describe('pages', () => {
  // The site is files served without the Worker; the Worker runs first only
  // for its own routes and the files it hides.
  it('runs the Worker first only for its routes', () => {
    for (const p of ['/api/v1/c', '/api/usage/v1', '/api/github/stars', '/c/Ab3dE5gH9k', '/market/index.json', '/market',
      '/p/@scope/plugin', '/beta', '/beta/update.json', '/download', '/download/get', '/share', '/c.html', '/index.html']) {
      expect(workerFirst(p), p).toBe(true);
    }
    for (const p of ['/', '/app.js', '/assets/dsh-go.svg', '/share/', '/share/index.html', '/share/share.js', '/robots.txt', '/favicon.svg']) {
      expect(workerFirst(p), p).toBe(false);
    }
  });

  it('serves the viewer for /c/<id> with a strict policy', async () => {
    const ctx = makeEnv();
    const res = await serve(get('/c/Ab3dE5gH9k'), ctx.env);
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toContain('text/html');
    const csp = res.headers.get('Content-Security-Policy')!;
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("connect-src 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toMatch(/script-src 'sha256-/);
    expect(res.headers.get('X-Frame-Options')).toBe('DENY');
    expect(res.headers.get('Referrer-Policy')).toBe('no-referrer');
    expect(await res.text()).toContain('dv-root');
    expect((await serve(get('/c/Ab3dE5gH9k/'), ctx.env)).status).toBe(200);
  });

  it('serves the landing page under /share/', async () => {
    const ctx = makeEnv();
    expect((await serve(get('/share'), ctx.env)).status).toBe(301);
    const page = await serve(get('/share/'), ctx.env);
    expect(page.status).toBe(200);
    expect(page.headers.get('Content-Security-Policy')).toContain("frame-ancestors 'none'");
    expect(page.headers.get('X-Robots-Tag')).toBe('noindex');
    expect(await page.text()).toContain('share.js');
    const js = await serve(get('/share/share.js'), ctx.env);
    expect(js.status).toBe(200);
    expect(js.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(js.headers.get('Cache-Control')).toBe('public, max-age=3600');
    expect((await serve(get('/share/viewer.js'), ctx.env)).status).toBe(200);
  });

  it('404s everything else', async () => {
    const ctx = makeEnv();
    for (const p of ['/c.html', '/c/', '/c/a_b', '/nope', '/share/nope.html', '/api/v2/c', '/api/v1/c/x/y',
      '/index.html', '/home/', '/home/index.html', '/home/app.js', '/assets/', '/assets/nope.webp', '/assets/features/']) {
      expect((await serve(get(p), ctx.env)).status, p).toBe(404);
    }
    expect((await serve(new Request(`${ORIGIN}/c/Ab3dE5gH9k`, { method: 'POST' }), ctx.env)).status).toBe(405);
    expect((await serve(new Request(`${ORIGIN}/app.js`, { method: 'POST' }), ctx.env)).status).toBe(405);
    expect((await serve(get('/api/v1/c'), ctx.env)).status).toBe(405);
    expect((await serve(get('/robots.txt'), ctx.env)).status).toBe(200);
  });
});

describe('home page', () => {
  const site = (name: string) => readFileSync(new URL(`../../../site/home/dist/${name}`, import.meta.url), 'utf8');

  it('is served at / with its own policy, indexable', async () => {
    const ctx = makeEnv();
    for (const method of ['GET', 'HEAD']) {
      const res = await serve(new Request(`${ORIGIN}/`, { method }), ctx.env);
      expect(res.status).toBe(200);
      expect(res.headers.get('Content-Type')).toContain('text/html');
      expect(res.headers.get('Content-Security-Policy')).toBe(
        "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; style-src-elem 'self'; " +
          "style-src-attr 'unsafe-inline'; img-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
      );
      expect(res.headers.get('X-Frame-Options')).toBe('DENY');
      expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff');
      expect(res.headers.get('Referrer-Policy')).toBe('no-referrer');
      expect(res.headers.get('Strict-Transport-Security')).toBe('max-age=31536000');
      expect(res.headers.get('Cache-Control')).toBe('no-cache');
      expect(res.headers.has('X-Robots-Tag')).toBe(false);
    }
    const body = await (await serve(get('/?from=qr'), ctx.env)).text();
    expect(body).toContain('<title>DSH Go · 万物皆插件，随身而行</title>');
    expect(body).toContain('<link rel="canonical" href="https://go.dshtui.com/">');
    expect(body).toContain('<script src="app.js" defer></script>');
  });

  it('serves its files at their own paths with types and a cache header', async () => {
    const ctx = makeEnv();
    for (const [path, type] of [
      ['/assets/features/01-local-engine.webp', 'image/webp'],
      ['/assets/author/download-qr-v2.png', 'image/png'],
      ['/assets/dsh-go.svg', 'image/svg+xml'],
      ['/app.js', 'text/javascript'],
      ['/site-config.js', 'text/javascript'],
      ['/styles.css', 'text/css'],
    ]) {
      const res = await serve(get(path!), ctx.env);
      expect(res.status, path).toBe(200);
      expect(res.headers.get('Content-Type'), path).toContain(type);
      expect(res.headers.get('Cache-Control'), path).toBe('public, max-age=3600');
      expect(res.headers.get('X-Content-Type-Options'), path).toBe('nosniff');
      expect(res.headers.has('X-Robots-Tag'), path).toBe(false);
    }
  });

  it('loads only what its policy allows, and every file it names is there', async () => {
    const page = site('index.html');
    // No inline scripts or handlers (script-src 'self'), no <style> blocks
    // (style-src-elem 'self'), nothing from another origin (img-src 'self').
    expect(page).not.toMatch(/<script(?![^>]*\ssrc=)[^>]*>/i);
    expect(page).not.toMatch(/\son[a-z]+\s*=/i);
    expect(page).not.toMatch(/<style[\s>]/i);
    // Every resource the page pulls in stays on this origin. Plain <a href>
    // links may point anywhere: they are navigations, not loads, and the CSP
    // does not govern where a click goes. The footer's friend links live there.
    const refs = [
      ...[...page.matchAll(/<(?:script|img)\b[^>]*\ssrc="([^"#][^"]*)"/gi)].map((m) => m[1]!),
      ...[...page.matchAll(/<link\b[^>]*\srel="(?:stylesheet|icon|apple-touch-icon)"[^>]*\shref="([^"#][^"]*)"/gi)].map((m) => m[1]!),
    ];
    expect(refs.filter((u) => /^[a-z]+:|^\/\//i.test(u))).toEqual([]);
    expect(page).toContain('href="https://dshtui.com/"');
    expect(page).toContain('href="https://github.com/ccch1mneyyy/dsh-TUI"');
    const images = [...site('site-config.js').matchAll(/(?:avatar|qrImage):\s*"([^"]+)"/g)].map((m) => m[1]!);
    expect(images).toEqual(['assets/dsh-go.svg', 'assets/author/download-qr-v2.png']);
    const ctx = makeEnv();
    for (const ref of new Set([...refs, ...images])) {
      expect((await serve(get('/' + ref), ctx.env)).status, ref).toBe(200);
    }
  });

  it('is the only thing robots.txt lets crawlers fetch', async () => {
    const ctx = makeEnv();
    const lines = (await (await serve(get('/robots.txt'), ctx.env)).text()).trim().split('\n');
    expect(lines.slice(0, 2)).toEqual(['User-agent: *', 'Allow: /$']);
    expect(lines).toContain('Allow: /app.js$');
    expect(lines).toContain('Allow: /assets/features/01-local-engine.webp$');
    expect(lines.at(-1)).toBe('Disallow: /');
    expect(lines.filter((l) => /^Allow: \/(?:share|c|beta|download|api|home)\b/.test(l))).toEqual([]);
  });

  it('leaves the other routes alone', async () => {
    const ctx = makeEnv();
    const viewer = await serve(get('/c/Ab3dE5gH9k'), ctx.env);
    expect(viewer.status).toBe(200);
    expect(viewer.headers.get('X-Robots-Tag')).toBe('noindex');
    expect(viewer.headers.get('Content-Security-Policy')).toMatch(/script-src 'sha256-/);
    expect((await serve(get('/share/'), ctx.env)).status).toBe(200);
    expect((await serve(get('/favicon.svg'), ctx.env)).status).toBe(200);
    expect((await serve(get('/update.json'), ctx.env)).status).toBe(404);
    expect((await serve(new Request(`${ORIGIN}/`, { method: 'POST' }), ctx.env)).status).toBe(405);
  });
});
