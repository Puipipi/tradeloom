// The download routes (China / Global / GitHub), the DOWNLOAD_ACCESS switch,
// the public download bucket behind Global, and the public /download files
// (edge copy, Range, cache headers).
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import worker from '../src/index';
import { CHANNEL_PREFIX, KEY_PREFIX, channelId, keyId, normalizeKey, resetChannelMemo, signLink } from '../src/beta-auth';
import { resetBetaCache } from '../src/beta';
import { renderNotes } from '../src/download-page';
import type { Env } from '../src/env';
import { cnBase, parseRoutes, pickRoute, type Route } from '../src/routes';
import { FakeCache, makeCtx, makeEnv } from './fakes';

const ORIGIN = 'https://go.dshtui.com';
const SECRET = 'test-beta-secret-0123456789abcdef0123456789abcdef';
const VERSION = '0.9.8';
const APK = `dsh-go-${VERSION}-arm64.apk`;
const apkBytes = Uint8Array.from({ length: 6000 }, (_, i) => (i * 13 + 5) & 0xff);
const SHA = 'cd'.repeat(32);
const KEY = 'dsh-k7m3x9qp';
const TOKEN = 'dshc_' + 'A'.repeat(43);
const CN = 'https://dshgo-cn.oss-cn-hongkong.aliyuncs.com/';
const CN_URL = `${CN}${VERSION}/${APK}`;
const GITHUB_URL = `https://github.com/ccch1mneyyy/dsh-go/releases/download/v${VERSION}/${APK}`;
const DL = 'https://dl.dshtui.com/';
const DL_URL = `${DL}download/${VERSION}/${APK}`;

function manifest(routes: unknown = ['global', 'cn', 'github'], notes = { zh: '- 中文说明', en: '- English notes' }) {
  return {
    schema: 1,
    version: `${VERSION}+10301000`,
    tag: `v${VERSION}`,
    publishedAt: '2026-10-30T02:00:00Z',
    notes: '',
    notesByLocale: notes,
    page: `${ORIGIN}/beta`,
    routes,
    assets: { arm64: { name: APK, size: apkBytes.length, sha256: SHA, url: `${ORIGIN}/beta/${VERSION}/${APK}` } },
  };
}

let cache: FakeCache;

beforeEach(() => {
  resetBetaCache();
  resetChannelMemo();
  cache = new FakeCache();
  (globalThis as { caches?: unknown }).caches = { default: cache };
});

afterEach(() => {
  delete (globalThis as { caches?: unknown }).caches;
});

async function seeded(vars: Partial<Env> = {}, release: object | null = manifest()) {
  const ctx = makeEnv({ BETA_SECRET: SECRET, CN_BASE_URL: CN, ...vars });
  const put = (key: string, bytes: Uint8Array) =>
    ctx.bucket.objects.set(key, { bytes, uploaded: new Date('2026-10-30T02:00:00Z'), customMetadata: {} });
  put(`beta/${VERSION}/${APK}`, apkBytes);
  put(`beta/${VERSION}/SHA256SUMS`, new TextEncoder().encode(`${SHA}  ${APK}\n`));
  if (release) {
    put(`beta/${VERSION}/update.json`, new TextEncoder().encode(JSON.stringify(release)));
    put('beta/update.json', new TextEncoder().encode(JSON.stringify(release)));
  }
  ctx.kv.values.set(KEY_PREFIX + (await keyId(SECRET, normalizeKey(KEY)!)), JSON.stringify({ label: 'beta-1' }));
  ctx.kv.values.set(CHANNEL_PREFIX + (await channelId(TOKEN)), JSON.stringify({ label: 'app-1' }));
  return { ...ctx, put };
}

const pub = (vars: Partial<Env> = {}, release?: object | null) => seeded({ DOWNLOAD_ACCESS: 'public', ...vars }, release);

interface ReqInit {
  headers?: Record<string, string>;
  method?: string;
  body?: string;
  ip?: string;
  country?: string;
}

function req(path: string, init: ReqInit = {}): Request {
  const r = new Request(ORIGIN + path, {
    method: init.method ?? 'GET',
    headers: { 'CF-Connecting-IP': init.ip ?? '198.51.100.9', ...init.headers },
    body: init.body,
  });
  // What Cloudflare adds; undici's Request has no `cf`.
  if (init.country) Object.defineProperty(r, 'cf', { value: { country: init.country } });
  return r;
}

const unlockReq = (init: ReqInit & { lang?: string } = {}) =>
  req('/beta/api/unlock', { ...init, method: 'POST', body: JSON.stringify({ key: KEY, lang: init.lang }), headers: { 'Content-Type': 'application/json' } });

const fetchWorker = (env: Env, request: Request) => worker.fetch(request, env, makeCtx().ctx);

/** The route each radio stands for, and which one is checked. */
function picker(html: string) {
  const radios = [...html.matchAll(/<input class="sr" type="radio" name="via" id="via-(\d)" value="(\w+)"( checked)?>/g)];
  const links = [...html.matchAll(/<a class="btn primary" href="([^"]+)" data-route="(\w+)"/g)].map((m) => ({ id: m[2], url: m[1]!.replace(/&amp;/g, '&') }));
  return { ids: radios.map((m) => m[2]), checked: radios.find((m) => m[3])?.[2] ?? null, links };
}

describe('routes', () => {
  const routes: Route[] = [
    { id: 'cn', url: CN_URL },
    { id: 'global', url: '/x' },
    { id: 'github', url: GITHUB_URL },
  ];

  it('mainland China gets the China route, everyone else Global', () => {
    expect(pickRoute(routes, 'CN')).toBe('cn');
    for (const c of ['US', 'HK', 'TW', 'JP', null]) expect(pickRoute(routes, c)).toBe('global');
  });

  it('?via= wins when it names an offered route', () => {
    expect(pickRoute(routes, 'CN', 'github')).toBe('github');
    expect(pickRoute(routes, 'US', 'cn')).toBe('cn');
    expect(pickRoute(routes, 'CN', 'nope')).toBe('cn');
    const noCn = routes.filter((r) => r.id !== 'cn');
    expect(pickRoute(noCn, 'CN')).toBe('global');
    expect(pickRoute(noCn, 'US', 'cn')).toBe('global');
  });

  it('takes only https base URLs, with one trailing slash', () => {
    const base = (v?: string) => cnBase({ CN_BASE_URL: v } as Env);
    expect(base(undefined)).toBeNull();
    expect(base('  ')).toBeNull();
    expect(base('http://dl.example.com/')).toBeNull();
    expect(base('https://dl.example.com/x?y=1')).toBeNull();
    expect(base('not a url')).toBeNull();
    expect(base('https://dl.example.com')).toBe('https://dl.example.com/');
    expect(base('https://dl.example.com/dsh-go//')).toBe('https://dl.example.com/dsh-go/');
    expect(base('http://127.0.0.1:8080/hk')).toBe('http://127.0.0.1:8080/hk/');
  });

  it('a manifest lists where the files went; Global is always there', () => {
    expect(parseRoutes(undefined)).toEqual(['global']);
    expect(parseRoutes(['github', 'cn', 'nope'])).toEqual(['cn', 'global', 'github']);
    expect(parseRoutes('cn')).toEqual(['global']);
  });
});

describe('public page (DOWNLOAD_ACCESS=public)', () => {
  it('offers three routes with no key, China first from mainland China', async () => {
    const { env } = await pub();
    const res = await fetchWorker(env, req('/download', { country: 'CN' }));
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('text/html; charset=utf-8');
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    expect(res.headers.get('Content-Security-Policy')).toContain("frame-ancestors 'none'");
    const html = await res.text();
    expect(html).not.toContain('<form');
    expect(html).not.toContain('<script');
    const p = picker(html);
    expect(p.ids).toEqual(['cn', 'global', 'github']);
    expect(p.checked).toBe('cn');
    // Every button counts the click first (src/stats.ts, test/stats.test.ts).
    expect(p.links).toEqual([
      { id: 'cn', url: `/download/get?via=cn&v=${VERSION}` },
      { id: 'global', url: `/download/get?via=global&v=${VERSION}` },
      { id: 'github', url: `/download/get?via=github&v=${VERSION}` },
    ]);
    for (const { id, url } of p.links) {
      const hop = await fetchWorker(env, req(url, { method: 'HEAD' }));
      expect(hop.status).toBe(302);
      expect(hop.headers.get('Location')).toBe({ cn: CN_URL, global: `/download/${VERSION}/${APK}`, github: GITHUB_URL }[id!]);
    }
    // One SHA-256 and size for all of them; install steps; the disclaimer.
    expect(html.match(new RegExp(SHA, 'g'))).toHaveLength(1);
    expect(html).toContain('各线路相同');
    expect(html).toContain('0.0 MB');
    expect(html).toContain('Android 8.0');
    expect(html).toContain('安装未知应用');
    expect(html).toContain('社区作品，非 DeepSeek 官方应用');
    // What is counted, and what isn't (src/stats.ts, src/usage.ts).
    expect(html).toContain('隐私：我们只统计下载和更新检查的次数');
    expect(html).toContain('这些统计记录里没有 IP，也不收集账号、对话和文件');
    expect(html).toContain('可在 App 里关闭');
    expect(html).toContain('随时随刻，想go就Go！');
    expect(html).toContain('<li>中文说明</li>');
  });

  it('Global by default outside mainland China', async () => {
    const { env } = await pub();
    for (const country of ['US', 'HK', undefined]) {
      expect(picker(await (await fetchWorker(env, req('/download', { country }))).text()).checked, country).toBe('global');
    }
  });

  it('?via= picks the route; the page switches without a script', async () => {
    const { env } = await pub();
    expect(picker(await (await fetchWorker(env, req('/download?via=github', { country: 'CN' }))).text()).checked).toBe('github');
    expect(picker(await (await fetchWorker(env, req('/download?via=cn', { country: 'US' }))).text()).checked).toBe('cn');
    const html = await (await fetchWorker(env, req('/download?via=bogus', { country: 'US' }))).text();
    expect(picker(html).checked).toBe('global');
    // Radio buttons and labels: every route is one tap away.
    for (let i = 0; i < 3; i++) expect(html).toContain(`<label for="via-${i}">`);
  });

  it('hides the China route when it isn\'t configured, or the release isn\'t there', async () => {
    for (const [vars, release] of [
      [{ CN_BASE_URL: '' }, manifest()],
      [{ CN_BASE_URL: undefined }, manifest()],
      [{ CN_BASE_URL: 'http://not-https.example/' }, manifest()],
      [{}, manifest(['global', 'github'])],
    ] as const) {
      resetBetaCache();
      const { env } = await pub(vars, release);
      const p = picker(await (await fetchWorker(env, req('/download?via=cn', { country: 'CN' }))).text());
      expect(p.ids).toEqual(['global', 'github']);
      expect(p.checked).toBe('global');
    }
  });

  it('a release published before routes existed only offers Global, without a picker', async () => {
    const { env } = await pub({}, manifest(null));
    const html = await (await fetchWorker(env, req('/download', { country: 'CN' }))).text();
    const p = picker(html);
    expect(p.ids).toEqual([]);
    expect(p.links).toEqual([{ id: 'global', url: `/download/get?via=global&v=${VERSION}` }]);
    expect(html).not.toContain('各线路相同');
  });

  it('speaks the browser\'s language, or ?lang=', async () => {
    const { env } = await pub();
    const en = await (await fetchWorker(env, req('/download', { headers: { 'Accept-Language': 'en-GB,en;q=0.9' } }))).text();
    expect(en).toContain('<html lang="en">');
    expect(en).toContain('Download APK');
    expect(en).toContain('Not an official DeepSeek app');
    expect(en).toContain("These records hold no IP addresses, and we never collect accounts, chats or files.");
    expect(en).toContain('<li>English notes</li>');
    expect(en).toContain('href="/download?lang=zh"');
    const zh = await (await fetchWorker(env, req('/download?lang=zh', { headers: { 'Accept-Language': 'en' } }))).text();
    expect(zh).toContain('<html lang="zh-CN">');
    expect(zh).toContain('下载安装包');
  });

  it('says to open a browser inside WeChat / QQ, and when nothing is out yet', async () => {
    const { env } = await pub();
    const wechat = await (await fetchWorker(env, req('/download', { headers: { 'User-Agent': 'Mozilla/5.0 MicroMessenger/8.0.50' } }))).text();
    expect(wechat).toContain('在浏览器打开');
    expect(wechat).not.toContain('data-route');
    resetBetaCache();
    const empty = await pub({}, null);
    expect(await (await fetchWorker(empty.env, req('/download'))).text()).toContain('暂时没有可下载的版本');
  });

  it('old /beta links land on /download; the app channel and signed links carry on', async () => {
    const { env } = await pub();
    const old = await fetchWorker(env, req('/beta'));
    expect(old.status).toBe(302);
    expect(old.headers.get('Location')).toBe('/download');
    expect((await fetchWorker(env, req('/beta/?lang=en'))).headers.get('Location')).toBe('/download?lang=en');
    expect((await fetchWorker(env, req('/download/'))).headers.get('Location')).toBe('/download');

    expect((await fetchWorker(env, req('/beta/update.json'))).status).toBe(401);
    const feed = await fetchWorker(env, req('/beta/update.json', { headers: { Authorization: `Bearer ${TOKEN}` } }));
    expect(feed.status).toBe(200);
    expect(((await feed.json()) as { version: string }).version).toBe(`${VERSION}+10301000`);
    expect((await fetchWorker(env, req(`/beta/${VERSION}/${APK}`))).status).toBe(401);
    const { url } = await signLink(SECRET, `/beta/${VERSION}/${APK}`);
    expect((await fetchWorker(env, req(url))).status).toBe(200);
    expect((await fetchWorker(env, unlockReq())).status).toBe(200);
    // The retired mirror's manifest stays gone.
    expect((await fetchWorker(env, req('/update.json'))).status).toBe(404);
  });

  it('needs no secret', async () => {
    const { env } = await pub({ BETA_SECRET: undefined });
    expect((await fetchWorker(env, req('/download'))).status).toBe(200);
    expect((await fetchWorker(env, req(`/download/${VERSION}/${APK}`))).status).toBe(200);
    expect((await fetchWorker(env, req('/beta'))).status).toBe(302);
    expect((await fetchWorker(env, req('/beta/update.json'))).status).toBe(404);
  });

  it('only GET and HEAD', async () => {
    const { env } = await pub();
    expect((await fetchWorker(env, req('/download', { method: 'POST' }))).status).toBe(405);
    const head = await fetchWorker(env, req('/download', { method: 'HEAD' }));
    expect(head.status).toBe(200);
    expect(await head.text()).toBe('');
  });
});

describe('the public download bucket (DL_BASE_URL)', () => {
  const hop = async (env: Env, via: string) => (await fetchWorker(env, req(`/download/get?via=${via}&v=${VERSION}`, { method: 'HEAD' }))).headers.get('Location');

  it('Global sends the bytes from dl.dshtui.com once the release is there', async () => {
    const { env } = await pub({ DL_BASE_URL: DL }, manifest(['global', 'dl', 'cn', 'github']));
    const res = await fetchWorker(env, req('/download', { country: 'US' }));
    expect(res.status).toBe(200);
    const p = picker(await res.text());
    expect(p.ids).toEqual(['cn', 'global', 'github']);
    expect(p.checked).toBe('global');
    expect(p.links.find((l) => l.id === 'global')!.url).toBe(`/download/get?via=global&v=${VERSION}`);
    expect(await hop(env, 'global')).toBe(DL_URL);
    expect(await hop(env, 'cn')).toBe(CN_URL);
    expect(await hop(env, 'github')).toBe(GITHUB_URL);
    // Links already out there keep working.
    expect((await fetchWorker(env, req(`/download/${VERSION}/${APK}`))).status).toBe(200);
  });

  it('Global stays on this Worker for a release that isn\'t there, or with no bucket set', async () => {
    for (const [vars, routes] of [
      [{ DL_BASE_URL: DL }, ['global', 'cn', 'github']],
      [{ DL_BASE_URL: '' }, ['global', 'dl', 'cn', 'github']],
      [{ DL_BASE_URL: 'http://dl.example.com/' }, ['global', 'dl']],
    ] as const) {
      resetBetaCache();
      const { env } = await pub(vars, manifest(routes));
      expect(await hop(env, 'global')).toBe(`/download/${VERSION}/${APK}`);
    }
  });

  it('key mode keeps the signed link', async () => {
    const { env } = await seeded({ DL_BASE_URL: DL }, manifest(['global', 'dl', 'cn', 'github']));
    const body = (await (await fetchWorker(env, unlockReq({ country: 'US' }))).json()) as { url: string; routes: Route[] };
    expect(body.routes.find((r) => r.id === 'global')!.url).toBe(body.url);
    expect(body.url).toMatch(new RegExp(`^/beta/${VERSION}/${APK}\\?exp=`));
  });
});

describe('key mode (the default)', () => {
  it('keeps /download 404 and /beta behind the key', async () => {
    for (const vars of [{}, { DOWNLOAD_ACCESS: 'key' }, { DOWNLOAD_ACCESS: 'Public!' }]) {
      const { env } = await seeded(vars);
      for (const p of ['/download', '/download/', `/download/${VERSION}/${APK}`, `/download/${VERSION}/SHA256SUMS`]) {
        expect((await fetchWorker(env, req(p))).status, p).toBe(404);
      }
      const page = await fetchWorker(env, req('/beta'));
      expect(page.status).toBe(200);
      const html = await page.text();
      expect(html).toContain('<form');
      expect(html).not.toMatch(/github|dshtui|aliyuncs|r2|worker/i);
    }
  });

  it('unlocking returns the routes and the card, China first from mainland China', async () => {
    const { env } = await seeded();
    const res = await fetchWorker(env, unlockReq({ country: 'CN' }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { url: string; sha256: string; routes: Route[]; selected: string; card: string };
    expect(body.sha256).toBe(SHA);
    expect(body.routes).toEqual([
      { id: 'cn', url: CN_URL },
      { id: 'global', url: body.url },
      { id: 'github', url: GITHUB_URL },
    ]);
    expect(body.url).toMatch(new RegExp(`^/beta/${VERSION}/${APK}\\?exp=\\d+&sig=`));
    expect(body.selected).toBe('cn');
    const p = picker(body.card);
    expect(p.checked).toBe('cn');
    expect(p.links.map((l) => l.url)).toEqual([CN_URL, body.url, GITHUB_URL]);
    expect(body.card).toContain('<h2>安装</h2>');

    resetBetaCache();
    const abroad = (await (await fetchWorker(env, unlockReq({ country: 'US', lang: 'en' }))).json()) as { selected: string; card: string };
    expect(abroad.selected).toBe('global');
    expect(abroad.card).toContain('Download APK');
  });

  it('without the China route configured, unlocking leaves it out', async () => {
    const { env } = await seeded({ CN_BASE_URL: '' });
    const body = (await (await fetchWorker(env, unlockReq({ country: 'CN' }))).json()) as { routes: Route[]; selected: string };
    expect(body.routes.map((r) => r.id)).toEqual(['global', 'github']);
    expect(body.selected).toBe('global');
  });
});

describe('public files', () => {
  const FILE = `/download/${VERSION}/${APK}`;

  it('serve the APK with Range, from R2 and then from the edge copy', async () => {
    const { env, bucket } = await pub();
    const tail = await fetchWorker(env, req(FILE, { headers: { Range: 'bytes=5990-' } }));
    expect(tail.status).toBe(206);
    expect(tail.headers.get('Content-Range')).toBe(`bytes 5990-5999/${apkBytes.length}`);
    expect(tail.headers.get('Content-Length')).toBe('10');
    expect(new Uint8Array(await tail.arrayBuffer())).toEqual(apkBytes.slice(5990));
    expect((await fetchWorker(env, req(FILE, { headers: { Range: 'bytes=-4' } }))).headers.get('Content-Range')).toBe(`bytes 5996-5999/${apkBytes.length}`);
    const past = await fetchWorker(env, req(FILE, { headers: { Range: 'bytes=6000-' } }));
    expect(past.status).toBe(416);
    expect(past.headers.get('Content-Range')).toBe(`bytes */${apkBytes.length}`);
    expect(cache.puts).toBe(0);

    const first = makeCtx();
    const full = await worker.fetch(req(FILE), env, first.ctx);
    expect(full.status).toBe(200);
    expect(full.headers.get('X-Cache')).toBe('MISS');
    expect(full.headers.get('Accept-Ranges')).toBe('bytes');
    expect(full.headers.get('Content-Type')).toBe('application/vnd.android.package-archive');
    expect(full.headers.get('Content-Disposition')).toBe(`attachment; filename="${APK}"`);
    expect(full.headers.get('Content-Length')).toBe(String(apkBytes.length));
    expect(new Uint8Array(await full.arrayBuffer())).toEqual(apkBytes);
    await first.settle();
    // The same edge copy as the beta channel's: one per file, keyed internally.
    expect([...cache.entries.keys()]).toEqual([`${ORIGIN}/__edge/beta/${VERSION}/${APK}`]);

    const gets = bucket.gets.length;
    const resumed = await fetchWorker(env, req(FILE, { headers: { Range: 'bytes=1000-' } }));
    expect(resumed.status).toBe(206);
    expect(resumed.headers.get('X-Cache')).toBe('HIT');
    expect(new Uint8Array(await resumed.arrayBuffer())).toEqual(apkBytes.slice(1000));
    expect(bucket.gets.length).toBe(gets);
    expect((await fetchWorker(env, req(`/__edge/beta/${VERSION}/${APK}`))).status).toBe(404);
  });

  it('are cacheable by browsers, while the channel and signed links stay private on the same edge copy', async () => {
    const { env } = await pub();
    const first = makeCtx();
    const full = await worker.fetch(req(FILE), env, first.ctx);
    expect(full.headers.get('Cache-Control')).toBe('public, max-age=31536000, immutable');
    await full.arrayBuffer();
    await first.settle();
    const hit = await fetchWorker(env, req(FILE));
    expect(hit.headers.get('X-Cache')).toBe('HIT');
    expect(hit.headers.get('Cache-Control')).toBe('public, max-age=31536000, immutable');

    const app = await fetchWorker(env, req(`/beta/${VERSION}/${APK}`, { headers: { Authorization: `Bearer ${TOKEN}`, Range: 'bytes=10-' } }));
    expect(app.status).toBe(206);
    expect(app.headers.get('X-Cache')).toBe('HIT');
    expect(app.headers.get('Cache-Control')).toBe('private, no-store');
    const { url } = await signLink(SECRET, `/beta/${VERSION}/${APK}`);
    const signed = await fetchWorker(env, req(url));
    expect(signed.headers.get('Cache-Control')).toBe('private, no-store');
    expect((await fetchWorker(env, req(`/beta/${VERSION}/${APK}`))).status).toBe(401);
  });

  it('HEAD gives the size; SHA256SUMS is there too; nothing else is', async () => {
    const { env } = await pub();
    const head = await fetchWorker(env, req(FILE, { method: 'HEAD' }));
    expect(head.status).toBe(200);
    expect(head.headers.get('Content-Length')).toBe(String(apkBytes.length));
    const sums = await fetchWorker(env, req(`/download/${VERSION}/SHA256SUMS`));
    expect(sums.status).toBe(200);
    expect(sums.headers.get('Content-Type')).toBe('text/plain; charset=utf-8');
    expect(sums.headers.get('Cache-Control')).toBe('public, max-age=3600');
    expect(await sums.text()).toBe(`${SHA}  ${APK}\n`);
    for (const p of [
      `/download/${VERSION}/update.json`,
      `/download/${VERSION}/missing.apk`,
      `/download/${VERSION}/..%2Fupdate.json`,
      '/download/update.json',
      '/download/a/b/c',
      `/download/x${VERSION}/${APK}`,
    ]) {
      expect((await fetchWorker(env, req(p))).status, p).toBe(404);
    }
  });

  it('share the read limit per client', async () => {
    const { env, readLimit } = await pub();
    readLimit.allow = 2;
    const statuses = [];
    for (let i = 0; i < 3; i++) statuses.push((await fetchWorker(env, req(FILE, { headers: { Range: 'bytes=0-0' } }))).status);
    expect(statuses).toEqual([206, 206, 429]);
    expect(readLimit.keys[0]).toBe('dl:198.51.100.9');
    // The page itself isn't limited.
    expect((await fetchWorker(env, req('/download'))).status).toBe(200);
  });
});

describe('release notes', () => {
  it('render what the changelog uses, escaped', () => {
    expect(renderNotes('### 新功能\n- **宠物**：会动\n- a < b & "c"\n\n段落 <script>alert(1)</script>')).toBe(
      '<h3>新功能</h3><ul><li><strong>宠物</strong>：会动</li><li>a &lt; b &amp; &quot;c&quot;</li></ul><p>段落 &lt;script&gt;alert(1)&lt;/script&gt;</p>',
    );
    expect(renderNotes('')).toBe('');
  });
});
