import type { Env } from './env';
import { COMMON, type Ctx } from './files';
import { escapeHtml as esc, pickLang, PAGE_HEADERS } from './download-page';

const DEFAULT_SOURCE = 'https://ccch1mneyyy.github.io/dsh-go-market/';
const TTL = 600_000;
const MAX = 2 * 1024 * 1024;
const PACKAGE = /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/;
const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const FLAGS = ['install-scripts', 'native-code', 'shell', 'network', 'filesystem', 'obfuscated', 'not-adapted'];
type Text = Record<string, string>;
interface Plugin {
  version: string;
  tier: 'official' | 'community';
  title: Text;
  summary: Text;
  risk: { level: string; flags: string[] };
  integrity: string;
  checkedAt: string;
  blockedVersions: string[];
}
interface Sidecar {
  schema: 1;
  generatedAt: string;
  plugins: Record<string, Plugin>;
}
interface Snapshot {
  at: number;
  index: string;
  sidecar: string;
}
const memory = new Map<string, Snapshot>();
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const localized = (v: unknown): v is Text =>
  record(v) && typeof v.en === 'string' && Object.values(v).every((x) => typeof x === 'string');

export function validateCatalog(index: unknown, sidecar: unknown): sidecar is Sidecar {
  if (
    !record(index) ||
    index.format !== 1 ||
    !(typeof index.title === 'string' || localized(index.title)) ||
    !Array.isArray(index.plugins) ||
    !record(sidecar) ||
    sidecar.schema !== 1 ||
    !record(sidecar.plugins) ||
    typeof sidecar.generatedAt !== 'string' ||
    !Number.isFinite(Date.parse(sidecar.generatedAt))
  )
    return false;
  if (index.plugins.length !== Object.keys(sidecar.plugins).length || index.plugins.length > 10000) return false;
  const names = new Set<string>();
  for (const row of index.plugins) {
    if (
      !record(row) ||
      typeof row.name !== 'string' ||
      row.name.length > 214 ||
      !PACKAGE.test(row.name) ||
      names.has(row.name) ||
      !Array.isArray(row.versions) ||
      row.versions.length !== 1
    )
      return false;
    names.add(row.name);
    const p = sidecar.plugins[row.name];
    const version = row.versions[0];
    if (
      !record(p) ||
      !record(version) ||
      !record(version.source) ||
      version.source.type !== 'npm' ||
      typeof p.version !== 'string' ||
      !VERSION.test(p.version) ||
      version.version !== p.version ||
      !['official', 'community'].includes(String(p.tier)) ||
      !localized(p.title) ||
      !localized(p.summary) ||
      !record(p.dshGo) ||
      typeof p.dshGo.adapted !== 'boolean' ||
      !Array.isArray(p.dshGo.features) ||
      p.dshGo.features.some((f) => typeof f !== 'string') ||
      (p.dshGo.minApp !== undefined && (typeof p.dshGo.minApp !== 'string' || !VERSION.test(p.dshGo.minApp))) ||
      !Array.isArray(p.screenshots) ||
      p.screenshots.length > 4 ||
      p.screenshots.some((url) => typeof url !== 'string' || !url.startsWith('https://')) ||
      !record(p.risk) ||
      !['low', 'medium', 'high'].includes(String(p.risk.level)) ||
      !Array.isArray(p.risk.flags) ||
      p.risk.flags.some((f) => typeof f !== 'string' || !FLAGS.includes(f)) ||
      new Set(p.risk.flags).size !== p.risk.flags.length ||
      typeof p.integrity !== 'string' ||
      !/^sha512-[A-Za-z0-9+/]{86}==$/.test(p.integrity) ||
      typeof p.checkedAt !== 'string' ||
      !Number.isFinite(Date.parse(p.checkedAt)) ||
      !Array.isArray(p.blockedVersions) ||
      p.blockedVersions.some((v) => typeof v !== 'string' || !VERSION.test(v))
    )
      return false;
    const risk = p.risk as { level: string; flags: string[] };
    const level = risk.flags.some((f) => ['install-scripts', 'native-code'].includes(f))
      ? 'high'
      : risk.flags.some((f) => ['shell', 'filesystem', 'obfuscated'].includes(f))
        ? 'medium'
        : 'low';
    if (risk.level !== level) return false;
  }
  return true;
}
export function marketSource(env: Env): string {
  const url = new URL(env.MARKET_SOURCE_URL || DEFAULT_SOURCE);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash)
    throw new Error('invalid-market-source');
  return url.href.replace(/\/*$/, '/');
}
class MarketError extends Error {
  constructor(readonly reason: string, readonly status?: number) {
    super(reason);
  }
}
async function body(response: Response): Promise<string> {
  if (!response.ok) {
    // Initiate cancellation without waiting for a possible tee sibling.
    void response.body?.cancel().catch(() => {});
    throw new MarketError('upstream-http', response.status);
  }
  if (Number(response.headers.get('content-length')) > MAX) {
    void response.body?.cancel().catch(() => {});
    throw new MarketError('too-large');
  }
  const reader = response.body?.getReader();
  if (!reader) throw new MarketError('empty');
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > MAX) throw new MarketError('too-large');
      chunks.push(value);
    }
  } catch (e) {
    await reader.cancel();
    throw e;
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return new TextDecoder().decode(bytes);
}
function snapshot(value: unknown): value is Snapshot {
  if (
    !record(value) ||
    typeof value.at !== 'number' ||
    !Number.isFinite(value.at) ||
    value.at > Date.now() + 60_000 ||
    typeof value.index !== 'string' ||
    typeof value.sidecar !== 'string' ||
    value.index.length > MAX ||
    value.sidecar.length > MAX
  )
    return false;
  try {
    return validateCatalog(JSON.parse(value.index), JSON.parse(value.sidecar));
  } catch {
    return false;
  }
}
/** Why a refresh failed, without URLs, response bodies or upstream exception messages. */
function logFailure(what: string, e: unknown): void {
  const reason = e instanceof MarketError ? e.reason
    : e instanceof Error && ['TypeError', 'SyntaxError', 'AbortError', 'TimeoutError'].includes(e.name)
      ? e.name : 'Error';
  console.error(what, reason, e instanceof MarketError ? e.status ?? null : null);
}
/** Both files from [base], validated together. */
async function fetchCatalog(base: string): Promise<Snapshot> {
  const [index, sidecar] = await Promise.all(
    ['index.json', 'dsh-go.json'].map(async (file) =>
      body(await fetch(base + file, {
        headers: { Accept: 'application/json', 'User-Agent': 'dshgo-share (+https://go.dshtui.com)' },
        // workerd rejects 'error'; manual + body() rejects every 3xx without following it.
        redirect: 'manual',
        signal: AbortSignal.timeout(10_000),
      })),
    ),
  );
  if (!validateCatalog(JSON.parse(index!), JSON.parse(sidecar!))) throw new MarketError('invalid-catalog');
  return { at: Date.now(), index: index!, sidecar: sidecar! };
}
// Share only fully consumed, validated strings within the same environment.
// Each caller still checks its KV snapshot and owns its fallback and writes.
const refreshing = new WeakMap<Env, Map<string, Promise<Snapshot>>>();
function refresh(env: Env, base: string, ctx: Ctx): Promise<Snapshot> {
  let flights = refreshing.get(env);
  if (!flights) refreshing.set(env, flights = new Map());
  const existing = flights.get(base);
  if (existing) return existing;
  const task = fetchCatalog(base).finally(() => {
    if (flights.get(base) === task) flights.delete(base);
  });
  flights.set(base, task);
  // Keep the originating request's fetch/body reads alive for overlapping
  // callers if it disconnects. Both upstream fetches retain their 10s timeout.
  ctx.waitUntil(task.catch(() => {}));
  return task;
}
async function remember(env: Env, key: string, value: Snapshot): Promise<void> {
  if (memory.size > 4) memory.delete(memory.keys().next().value!);
  memory.set(key, value);
  try {
    await env.QUOTA?.put(key, JSON.stringify(value));
  } catch {
    /* current response remains available; old KV copy survives */
  }
}
async function catalog(env: Env, ctx: Ctx): Promise<{ value: Snapshot; stale: boolean }> {
  const base = marketSource(env),
    key = 'market:v1:' + base;
  let previous = memory.get(key);
  // KV intentionally has no expiry: keep the last valid snapshot through outages.
  try {
    const saved = await env.QUOTA?.get(key);
    if (saved) {
      const parsed: unknown = JSON.parse(saved);
      // Only a newer snapshot can replace the already validated memory entry.
      if (
        (!previous || (record(parsed) && typeof parsed.at === 'number' && parsed.at > previous.at)) &&
        snapshot(parsed)
      ) previous = parsed;
    }
  } catch {
    /* memory fallback */
  }
  if (previous && Date.now() - previous.at < TTL) return { value: previous, stale: false };
  try {
    const value = await refresh(env, base, ctx);
    await remember(env, key, value);
    return { value, stale: false };
  } catch (e) {
    logFailure('market refresh failed', e);
    if (previous) return { value: previous, stale: true };
    throw e;
  }
}
/** The cron (wrangler.jsonc, every 10 minutes): a fresh valid catalog onto
 *  the public bucket, market/index.json and market/dsh-go.json, where apps
 *  read it without the Worker (DL_BASE_URL, docs/design/plugin-market.md §3),
 *  and into the snapshot the /market/ routes serve. A failure leaves both as
 *  they were. */
export async function publishMarket(env: Env): Promise<void> {
  const base = marketSource(env);
  let value: Snapshot;
  try {
    value = await fetchCatalog(base);
  } catch (e) {
    logFailure('market publish failed', e);
    return;
  }
  const httpMetadata = { contentType: 'application/json; charset=utf-8', cacheControl: 'public, max-age=300' };
  await Promise.all([
    env.DL.put('market/index.json', value.index, { httpMetadata }),
    env.DL.put('market/dsh-go.json', value.sidecar, { httpMetadata }),
    remember(env, 'market:v1:' + base, value),
  ]);
}
export function isMarketPath(path: string): boolean {
  return path === '/market' || path.startsWith('/market/') || path === '/p' || path.startsWith('/p/');
}
export function packageFromPath(path: string): string | null {
  if (!path.startsWith('/p/')) return null;
  try {
    const name = decodeURIComponent(path.slice(3));
    return name.length <= 214 && PACKAGE.test(name) ? name : null;
  } catch {
    return null;
  }
}
const html = (status: number, text: string, head: boolean, headers: Record<string, string> = {}) =>
  new Response(head ? null : text, { status, headers: { ...PAGE_HEADERS, ...headers } });
export async function market(request: Request, env: Env, ctx: Ctx): Promise<Response> {
  const path = new URL(request.url).pathname,
    head = request.method === 'HEAD';
  if (!['GET', 'HEAD'].includes(request.method))
    return new Response(null, { status: 405, headers: { ...COMMON, Allow: 'GET, HEAD' } });
  const file = path === '/market/index.json' ? 'index' : path === '/market/dsh-go.json' ? 'sidecar' : null;
  const name = packageFromPath(path);
  if (!file && !name) return new Response(null, { status: 404, headers: COMMON });
  let result: Awaited<ReturnType<typeof catalog>>;
  try {
    result = await catalog(env, ctx);
  } catch {
    return html(
      503,
      '<!doctype html><title>DSH Go</title><p>插件市场暂不可用 / Plugin market unavailable</p><a href="/download">下载 DSH Go / Download</a>',
      head,
      { 'Cache-Control': 'no-store', 'Retry-After': '60' },
    );
  }
  const headers: Record<string, string> = {
    'Cache-Control': result.stale
      ? 'public, max-age=60'
      : `public, max-age=${Math.max(0, Math.ceil((TTL - (Date.now() - result.value.at)) / 1000))}`,
    'X-Market-Stale': String(result.stale),
  };
  if (result.stale) headers.Warning = '110 - "Response is stale"';
  if (file)
    return new Response(head ? null : result.value[file], {
      headers: {
        ...COMMON,
        ...headers,
        'Content-Type': 'application/json; charset=utf-8',
        'Access-Control-Allow-Origin': '*',
      },
    });
  const p = (JSON.parse(result.value.sidecar) as Sidecar).plugins[name!];
  if (!p)
    return html(
      404,
      '<!doctype html><title>DSH Go</title><p>未收录此插件 / Plugin not listed</p><a href="/download">DSH Go</a>',
      head,
      { 'Cache-Control': 'no-store' },
    );
  const lang = pickLang(request),
    zh = lang === 'zh',
    title = p.title[lang] || p.title.en,
    summary = p.summary[lang] || p.summary.en;
  const deep = 'dshgo://go.dshtui.com/p/' + encodeURIComponent(name!);
  const labels: Record<string, string> = zh
    ? {
        'install-scripts': '安装脚本',
        'native-code': '原生代码',
        shell: '执行命令',
        network: '网络请求',
        filesystem: '文件写入',
        obfuscated: '压缩或混淆',
        'not-adapted': '未适配原生界面',
      }
    : {};
  const page = `<!doctype html><html lang="${zh ? 'zh-CN' : 'en'}"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title!)} · DSH Go</title><meta name="description" content="${esc(summary!)}"><style>:root{color-scheme:light dark;font-family:system-ui,sans-serif;background:#f5f6f8;color:#20252c}body{margin:0;padding:32px 20px}main{max-width:560px;margin:6vh auto;padding:28px;border-radius:24px;background:#fff;box-shadow:0 8px 40px #1018200c}h1{font-size:28px;overflow-wrap:anywhere}p{line-height:1.65;overflow-wrap:anywhere}.brand{color:#697480}code{overflow-wrap:anywhere}.badge{display:inline-block;border-radius:16px;padding:5px 11px;background:#e9edf4;margin:4px 4px 4px 0}.medium{background:#fff0c7;color:#755300}.high{background:#ffe1df;color:#a1231c}a.btn{display:block;text-align:center;border-radius:14px;background:#2c68e8;color:white;padding:14px;text-decoration:none;margin:18px 0 10px}a{color:#2866d6}small{display:block;color:#697480;line-height:1.6}@media(prefers-color-scheme:dark){:root{background:#14171c;color:#eef1f5}main{background:#20252c}.brand,small{color:#b0bac7}.badge{background:#343e4d}.medium{background:#594716;color:#ffe39b}.high{background:#622b2b;color:#ffc7c3}a{color:#9abaff}}</style><main><a class="brand" href="/">DSH Go</a><h1>${esc(title!)}</h1><code>${esc(name!)}@${esc(p.version)}</code><p>${esc(summary!)}</p><span class="badge">${p.tier === 'official' ? (zh ? '官方' : 'Official') : zh ? '社区' : 'Community'}</span>${p.risk.flags.map((f) => `<span class="badge ${esc(p.risk.level)}">${esc(labels[f] || f)}</span>`).join('')}<p>${zh ? '自动检查发现的特征，不代表插件有恶意。' : 'Automated checks identify features; they do not imply malicious intent.'}</p>${result.stale ? `<p>${zh ? '当前展示最近成功缓存，审核信息可能已过期。' : 'Showing the last successful snapshot; audit data may be outdated.'}</p>` : ''}<a class="btn" href="${esc(deep)}">${zh ? '在 DSH Go 中打开' : 'Open in DSH Go'}</a><a href="/download">${zh ? '还没安装？下载 DSH Go' : 'Get DSH Go'}</a><p><small>${zh ? '安装前请在 App 内确认版本和风险。' : 'Review the version and risks in the app before installing.'}</small></p></main></html>`;
  return html(200, page, head, { ...headers, Vary: 'Accept-Language' });
}
