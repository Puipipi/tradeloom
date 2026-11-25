// The download page: DSH Go, the latest build and the routes it can be
// fetched from (docs/design/share-links.md §14).
//
//  - key mode, /beta: an access key in; /beta/api/unlock answers with the
//    release card rendered here, and beta.js puts it on the page.
//  - public mode, /download: the release card straight away.
//
// Rendered on the server in the visitor's language (?lang=, else
// Accept-Language). Routes switch with radio buttons and CSS, so the public
// page runs no script at all. Self-contained: no site build needed.

import type { Build } from './beta';
import { COMMON } from './files';
import type { Route, RouteId } from './routes';

export type Lang = 'zh' | 'en';
export type Mode = 'key' | 'public';

interface Text {
  htmlLang: string;
  title: Record<Mode, string>;
  tag: Record<Mode, string>;
  slogan: string;
  /** Two phrases, each kept on one line where it fits. */
  pitch: [string, string];
  key: string;
  unlock: string;
  checking: string;
  invalid: string;
  busy: string;
  empty: string;
  none: string;
  offline: string;
  routes: string;
  route: Record<RouteId, string>;
  caption: Record<RouteId, string>;
  download: string;
  version: string;
  size: string;
  date: string;
  same: string;
  install: string;
  steps: string[];
  notes: string;
  openInBrowser: string;
  footer: string;
  /** What is counted and what isn't (docs/design/share-links.md §15). */
  privacy: string;
  other: { lang: Lang; label: string };
}

const TEXT: Record<Lang, Text> = {
  zh: {
    htmlLang: 'zh-CN',
    title: { key: 'DSH Go 内测', public: '下载 DSH Go' },
    tag: { key: '内测', public: '公测' },
    slogan: '随时随刻，想go就Go！',
    pitch: ['手机上直接跑 DeepSeek Harness，', '也能遥控电脑上的那一个。'],
    key: '密钥',
    unlock: '获取安装包',
    checking: '正在验证…',
    invalid: '密钥无效',
    busy: '尝试太频繁，请过几分钟再试',
    empty: '请输入密钥',
    none: '暂时没有可下载的版本',
    offline: '网络不通，请重试',
    routes: '下载线路',
    route: { cn: '国内线路', global: '海外线路', github: 'GitHub' },
    caption: { cn: '香港节点，国内直连更快', global: 'Cloudflare 全球加速', github: 'GitHub Releases，国内可能较慢' },
    download: '下载安装包',
    version: '版本',
    size: '大小',
    date: '发布日期',
    same: '各线路相同',
    install: '安装',
    steps: ['下载完成后，点开安装包', '按提示允许浏览器「安装未知应用」', '需要 Android 8.0 或以上'],
    notes: '更新内容',
    openInBrowser: '点右上角 ···，选「在浏览器打开」',
    footer: '社区作品，非 DeepSeek 官方应用',
    privacy:
      '隐私：我们只统计下载和更新检查的次数（含线路、版本、国家/地区），设备数用每天更换、无法还原的哈希估算。' +
      'App 的匿名使用统计只含版本、系统及厂商系统版本、厂商和机型、语言、运行方式、各功能使用次数和模型回复报告的 token 数，以随机安装编号区分设备，可在 App 里关闭。' +
      '这些统计记录里没有 IP，也不收集账号、对话和文件。',
    other: { lang: 'en', label: 'English' },
  },
  en: {
    htmlLang: 'en',
    title: { key: 'DSH Go beta', public: 'Download DSH Go' },
    tag: { key: 'Beta', public: 'Public beta' },
    slogan: 'Anytime, anywhere. Just Go!',
    pitch: ['Run DeepSeek Harness on your phone,', 'or drive the one on your computer.'],
    key: 'Access key',
    unlock: 'Get the app',
    checking: 'Checking…',
    invalid: "That key doesn't work",
    busy: 'Too many tries. Try again in a few minutes.',
    empty: 'Enter your access key',
    none: 'Nothing to download yet',
    offline: "Couldn't connect. Try again.",
    routes: 'Download from',
    route: { cn: 'China', global: 'Global', github: 'GitHub' },
    caption: { cn: 'Hong Kong, fastest from mainland China', global: 'Cloudflare, fast worldwide', github: 'Straight from GitHub Releases' },
    download: 'Download APK',
    version: 'Version',
    size: 'Size',
    date: 'Released',
    same: 'same on every route',
    install: 'Install',
    steps: ['Open the APK once it has downloaded', 'If asked, allow your browser to install unknown apps', 'Needs Android 8.0 or later'],
    notes: "What's new",
    openInBrowser: 'Tap ··· at the top right and open this page in your browser',
    footer: 'A community project. Not an official DeepSeek app.',
    privacy:
      'Privacy: we count downloads and update checks (with route, version and country) and estimate device numbers ' +
      'with a one-way hash that changes daily. The app\'s anonymous usage stats hold only its version, Android version, ' +
      'maker, model, the maker\'s system version, language, engine mode, feature counts and the token counts model replies report, tell devices apart by a random install ID, and can be turned ' +
      'off in the app. These records hold no IP addresses, and we never collect accounts, chats or files.',
    other: { lang: 'zh', label: '中文' },
  },
};

/** ?lang=zh|en, else the browser's first language: Chinese for zh-*, English
 *  for anything else, Chinese when it doesn't say. */
export function pickLang(request: Request): Lang {
  const asked = new URL(request.url).searchParams.get('lang');
  if (asked === 'zh' || asked === 'en') return asked;
  const first = (request.headers.get('Accept-Language') ?? '').split(',')[0]!.trim();
  return !first || first === '*' || /^zh\b/i.test(first) ? 'zh' : 'en';
}

export function asLang(value: unknown): Lang | null {
  return value === 'zh' || value === 'en' ? value : null;
}

// ── Pieces ───────────────────────────────────────────────────────────────

const ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ESCAPES[c]!);
}

const ICON = '<img class="icon" src="/share/apple-touch-icon.png" alt="" width="80" height="80">';

const DOWN =
  '<svg class="down" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 4.5v10.5m0 0-4.25-4.25M12 15l4.25-4.25M5.5 19.5h13" ' +
  'fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>';

function hero(t: Text, mode: Mode): string {
  return `
  <header class="hero">
    ${ICON}
    <h1>DSH Go<span class="tag">${t.tag[mode]}</span></h1>
    <p class="slogan">${t.slogan}</p>
    <p class="pitch">${t.pitch.map((p) => `<span>${p}</span>`).join(t.htmlLang === 'en' ? ' ' : '')}</p>
  </header>`;
}

function megabytes(bytes: number): string {
  return `${(bytes / 1048576).toFixed(1)} MB`;
}

/** YYYY-MM-DD in UTC+8, where releases are made. */
function day(iso: string | null): string {
  const at = iso ? Date.parse(iso) : NaN;
  return Number.isFinite(at) ? new Date(at + 8 * 3600_000).toISOString().slice(0, 10) : '';
}

/** Release notes as the changelog writes them: "- item", "### Heading" or
 *  "**Heading**" on its own line, paragraphs, **bold**. Everything escaped. */
export function renderNotes(md: string): string {
  const inline = (text: string) =>
    text
      .split(/\*\*(.+?)\*\*/)
      .map((part, i) => (i % 2 ? `<strong>${escapeHtml(part)}</strong>` : escapeHtml(part)))
      .join('');
  let html = '';
  let inList = false;
  const close = () => {
    if (inList) html += '</ul>';
    inList = false;
  };
  for (const raw of md.split('\n')) {
    const line = raw.trim();
    if (!line) {
      close();
      continue;
    }
    const item = /^[-*]\s+(.*)$/.exec(line);
    const head = /^#{1,6}\s+(.*)$/.exec(line) ?? /^\*\*([^*]+)\*\*$/.exec(line);
    if (item) {
      if (!inList) html += '<ul>';
      inList = true;
      html += `<li>${inline(item[1]!)}</li>`;
    } else if (head) {
      close();
      html += `<h3>${escapeHtml(head[1]!)}</h3>`;
    } else {
      close();
      html += `<p>${inline(line)}</p>`;
    }
  }
  close();
  return html;
}

function routePicker(t: Text, routes: readonly Route[], selected: RouteId): string {
  const n = routes.length;
  const radios = routes
    .map((r, i) => `<input class="sr" type="radio" name="via" id="via-${i}" value="${r.id}"${r.id === selected ? ' checked' : ''}>`)
    .join('');
  const labels = routes.map((r, i) => `<label for="via-${i}">${t.route[r.id]}</label>`).join('');
  const panes = routes
    .map((r, i) => {
      // Our own file: a download. Elsewhere: no referrer. /download/get redirects.
      const attr = /^\/(beta|download)\/[^?]+\.apk(\?|$)/.test(r.url) ? ' download' : r.url.startsWith('/') ? '' : ' rel="noreferrer"';
      return `
      <div class="pane p${i}">
        <a class="btn primary" href="${escapeHtml(r.url)}" data-route="${r.id}"${attr}>${DOWN}<span>${t.download}</span></a>
        <p class="caption">${t.caption[r.id]}</p>
      </div>`;
    })
    .join('');
  return `
    <fieldset class="routes n${n}">
      <legend class="sr">${t.routes}</legend>
      ${n > 1 ? `${radios}\n      <div class="seg">${labels}</div>` : ''}${panes}
    </fieldset>`;
}

export interface CardData {
  build: Build;
  routes: readonly Route[];
  selected: RouteId;
}

/** The release: routes and download button, facts, install steps, notes. */
export function releaseCard(lang: Lang, data: CardData): string {
  const t = TEXT[lang];
  const { build } = data;
  const notes = renderNotes(build.notes[lang]);
  const steps = t.steps.map((s) => `<li>${s}</li>`).join('');
  return `
  <section class="card release">${routePicker(t, data.routes, data.selected)}
    <ul class="facts">
      <li><span>${t.version}</span><span>${escapeHtml(build.version)}${build.build ? ` (${build.build})` : ''}</span></li>
      <li><span>${t.size}</span><span>${megabytes(build.size)}</span></li>
      ${build.publishedAt ? `<li><span>${t.date}</span><span>${day(build.publishedAt)}</span></li>` : ''}
      <li class="hash"><span>SHA-256${data.routes.length > 1 ? `<small>${t.same}</small>` : ''}</span><code>${escapeHtml(build.sha256)}</code></li>
    </ul>
    <div class="install">
      <h2>${t.install}</h2>
      <ol class="steps">${steps}</ol>
    </div>
  </section>${
    notes
      ? `
  <section class="card notes">
    <h2>${t.notes}</h2>
    ${notes}
  </section>`
      : ''
  }`;
}

function page(lang: Lang, mode: Mode, body: string, options: { script?: boolean; inApp?: boolean } = {}): string {
  const t = TEXT[lang];
  const self = mode === 'public' ? '/download' : '/beta';
  return `<!doctype html>
<html lang="${t.htmlLang}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="referrer" content="no-referrer">
<meta name="robots" content="noindex, nofollow">
<meta name="color-scheme" content="light dark">
<meta name="format-detection" content="telephone=no">
<title>${t.title[mode]}</title>
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="apple-touch-icon" href="/share/apple-touch-icon.png">
<style>${STYLE}</style>
</head>
<body>
${options.inApp ? '<div class="arrow" aria-hidden="true">↗</div>\n' : ''}<main>${hero(t, mode)}
${body}
  <footer class="foot">
    <p class="privacy">${t.privacy}</p>
    <p class="line">
      <span>${t.footer}</span>
      <a href="${self}?lang=${t.other.lang}" hreflang="${t.other.lang}" lang="${TEXT[t.other.lang].htmlLang}">${t.other.label}</a>
    </p>
  </footer>
</main>${options.script ? '\n<script src="/beta/beta.js"></script>' : ''}
</body>
</html>
`;
}

function hint(text: string): string {
  return `
  <section class="card">
    <p class="hint">${text}</p>
  </section>`;
}

/** /beta: the key form; the release card replaces it once a key works. */
export function lockPage(lang: Lang, inApp: boolean): string {
  const t = TEXT[lang];
  if (inApp) return page(lang, 'key', hint(t.openInBrowser), { inApp });
  const messages = (['checking', 'unlock', 'invalid', 'busy', 'empty', 'none', 'offline'] as const)
    .map((k) => ` data-${k}="${escapeHtml(t[k])}"`)
    .join('');
  const body = `
  <section class="card" id="lock">
    <form id="form" autocomplete="off" novalidate data-lang="${lang}"${messages}>
      <label class="sr" for="key">${t.key}</label>
      <input id="key" name="key" type="text" maxlength="40" placeholder="${t.key}"
        autocomplete="off" autocapitalize="none" autocorrect="off" spellcheck="false" enterkeyhint="go" aria-describedby="error">
      <p class="error" id="error" role="alert" hidden></p>
      <button class="btn primary" id="submit" type="submit">${t.unlock}</button>
    </form>
  </section>
  <div id="release" hidden></div>`;
  return page(lang, 'key', body, { script: true });
}

/** /download: the release, or a hint in WeChat / QQ, or "nothing yet". */
export function publicPage(lang: Lang, inApp: boolean, data: CardData | null): string {
  const t = TEXT[lang];
  if (inApp) return page(lang, 'public', hint(t.openInBrowser), { inApp });
  return page(lang, 'public', data ? releaseCard(lang, data) : hint(t.none));
}

export const PAGE_CSP =
  "default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; img-src 'self'; connect-src 'self'; " +
  "base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

export const PAGE_HEADERS: Record<string, string> = {
  ...COMMON,
  'Content-Type': 'text/html; charset=utf-8',
  'Cache-Control': 'no-store',
  'Content-Security-Policy': PAGE_CSP,
  'X-Frame-Options': 'DENY',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
};

export function pageResponse(request: Request, html: string): Response {
  return new Response(request.method === 'HEAD' ? null : html, { headers: PAGE_HEADERS });
}

const STYLE = `
:root {
  --bg: #eef0f5; --card: #ffffff; --ink: #161a22; --ink-2: #4a5160; --ink-3: #8a90a0;
  --line: rgba(20, 24, 34, 0.08); --field: #f1f3f8; --primary: #4d6bfe; --on-primary: #ffffff;
  --tile: rgba(77, 107, 254, 0.1); --focus: rgba(77, 107, 254, 0.24); --danger: #c0392b; --danger-ring: rgba(192, 57, 43, 0.16);
  --glow: rgba(77, 107, 254, 0.16); --shadow: 0 8px 28px rgba(22, 26, 34, 0.06); --btn-shadow: 0 6px 18px rgba(77, 107, 254, 0.28);
  --icon-shadow: 0 12px 32px rgba(64, 90, 173, 0.3); --thumb: #ffffff; --thumb-shadow: 0 1px 3px rgba(22, 26, 34, 0.12);
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #12151c; --card: #1d212b; --ink: #eef0f5; --ink-2: #b6bccb; --ink-3: #7c8396;
    --line: rgba(255, 255, 255, 0.08); --field: #161a22; --primary: #8ea2ff; --on-primary: #10131a;
    --tile: rgba(142, 162, 255, 0.14); --focus: rgba(142, 162, 255, 0.28); --danger: #ff8a7a; --danger-ring: rgba(255, 138, 122, 0.2);
    --glow: rgba(142, 162, 255, 0.12); --shadow: 0 8px 28px rgba(0, 0, 0, 0.24); --btn-shadow: 0 6px 18px rgba(0, 0, 0, 0.3);
    --icon-shadow: 0 12px 32px rgba(0, 0, 0, 0.4); --thumb: #2a2f3b; --thumb-shadow: 0 1px 3px rgba(0, 0, 0, 0.4);
  }
}
* { box-sizing: border-box; }
html { background: var(--bg); color: var(--ink); -webkit-text-size-adjust: 100%; }
body {
  margin: 0; min-height: 100vh; display: flex; justify-content: center;
  font: 15px/1.55 -apple-system, BlinkMacSystemFont, "PingFang SC", "Noto Sans CJK SC", "Microsoft YaHei", sans-serif;
  padding: max(40px, env(safe-area-inset-top)) 16px max(28px, env(safe-area-inset-bottom));
  background: radial-gradient(720px 400px at 50% -140px, var(--glow), transparent 72%) no-repeat, var(--bg);
}
main { width: 100%; max-width: 440px; }
.sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; margin: 0; }
[hidden] { display: none !important; }

.hero { text-align: center; margin: 0 0 24px; }
.icon { display: block; width: 80px; height: 80px; margin: 0 auto 16px; border-radius: 20px; box-shadow: var(--icon-shadow); }
h1 { margin: 0; font-size: 28px; line-height: 1.2; font-weight: 700; letter-spacing: -0.01em; display: inline-flex; align-items: center; gap: 8px; }
.tag { font-size: 12px; line-height: 1; font-weight: 600; letter-spacing: 0.02em; padding: 5px 8px; border-radius: 999px; background: var(--tile); color: var(--primary); }
.slogan { margin: 8px 0 0; font-size: 17px; font-weight: 600; color: var(--ink-2); letter-spacing: 0.02em; }
.pitch { margin: 6px 0 0; font-size: 13px; color: var(--ink-3); }
.pitch span { display: inline-block; }

.card { background: var(--card); border-radius: 28px; padding: 20px; box-shadow: var(--shadow); border: 0.5px solid var(--line); }
.card + .card { margin-top: 12px; }
h2 { margin: 0 0 8px; font-size: 13px; font-weight: 600; color: var(--ink-3); }

.btn {
  display: flex; align-items: center; justify-content: center; gap: 8px; width: 100%; height: 52px; margin: 0;
  border: 0; border-radius: 999px; font-family: inherit; font-size: 17px; font-weight: 600; line-height: 1; text-decoration: none; cursor: pointer;
  -webkit-tap-highlight-color: transparent; transition: transform 0.12s ease, filter 0.12s ease;
}
.btn.primary { background: var(--primary); color: var(--on-primary); box-shadow: var(--btn-shadow); }
.btn:active { transform: scale(0.985); filter: brightness(0.96); }
.btn:focus { outline: none; }
.btn:focus-visible { box-shadow: 0 0 0 4px var(--focus); }
.btn[disabled], .btn[aria-disabled="true"] { opacity: 0.6; cursor: default; }
.down { width: 20px; height: 20px; flex: none; }

form { margin: 0; }
input {
  display: block; width: 100%; height: 52px; padding: 0 16px; border-radius: 16px;
  border: 1px solid var(--line); background: var(--field); color: var(--ink); text-align: center;
  font: 500 18px/1 ui-monospace, "JetBrains Mono", Menlo, monospace; letter-spacing: 0.06em;
  outline: none; -webkit-appearance: none; appearance: none;
}
input::placeholder { font-family: -apple-system, BlinkMacSystemFont, "PingFang SC", "Noto Sans CJK SC", sans-serif; font-weight: 400; letter-spacing: 0; color: var(--ink-3); }
input:focus { border-color: var(--primary); box-shadow: 0 0 0 4px var(--focus); }
input[aria-invalid="true"] { border-color: var(--danger); }
input[aria-invalid="true"]:focus { box-shadow: 0 0 0 4px var(--danger-ring); }
.error { color: var(--danger); font-size: 13px; margin: 8px 0 0; text-align: center; }
form .btn { margin-top: 12px; }

.routes { border: 0; margin: 0; padding: 0; min-width: 0; }
.seg { position: relative; display: grid; grid-auto-flow: column; grid-auto-columns: 1fr; padding: 4px; margin: 0 0 16px; border-radius: 999px; background: var(--field); border: 0.5px solid var(--line); }
.seg::before {
  content: ""; position: absolute; top: 4px; bottom: 4px; left: 4px; width: calc((100% - 8px) / var(--n, 1));
  border-radius: 999px; background: var(--thumb); box-shadow: var(--thumb-shadow); transition: transform 0.22s cubic-bezier(0.3, 0.7, 0.2, 1);
}
.n2 .seg { --n: 2; }
.n3 .seg { --n: 3; }
.seg label {
  position: relative; display: flex; align-items: center; justify-content: center; height: 36px; padding: 0 6px;
  font-size: 14px; font-weight: 600; color: var(--ink-3); border-radius: 999px; cursor: pointer; white-space: nowrap;
  -webkit-tap-highlight-color: transparent; transition: color 0.15s ease;
}
#via-1:checked ~ .seg::before { transform: translateX(100%); }
#via-2:checked ~ .seg::before { transform: translateX(200%); }
#via-0:checked ~ .seg label[for="via-0"], #via-1:checked ~ .seg label[for="via-1"], #via-2:checked ~ .seg label[for="via-2"] { color: var(--ink); }
#via-0:focus-visible ~ .seg label[for="via-0"], #via-1:focus-visible ~ .seg label[for="via-1"], #via-2:focus-visible ~ .seg label[for="via-2"] { box-shadow: 0 0 0 3px var(--focus); }
.pane { display: none; }
.n1 .pane, #via-0:checked ~ .p0, #via-1:checked ~ .p1, #via-2:checked ~ .p2 { display: block; }
.caption { margin: 10px 0 0; text-align: center; font-size: 13px; color: var(--ink-3); }

.facts { margin: 18px 0 0; padding: 0; list-style: none; border-top: 0.5px solid var(--line); }
.facts li { display: flex; justify-content: space-between; align-items: baseline; gap: 16px; padding: 12px 0; border-bottom: 0.5px solid var(--line); }
.facts li > span:first-child { color: var(--ink-2); flex: none; }
.facts li > span:last-child { text-align: right; overflow-wrap: anywhere; font-variant-numeric: tabular-nums; }
.facts li.hash { display: block; }
.facts small { margin-left: 8px; font-size: 12px; color: var(--ink-3); }
.facts code { display: block; margin-top: 4px; font: 12px/1.6 ui-monospace, "JetBrains Mono", Menlo, monospace; color: var(--ink-3); word-break: break-all; -webkit-user-select: all; user-select: all; }

.install { margin-top: 18px; }
.steps { margin: 0; padding: 0; list-style: none; counter-reset: step; }
.steps li { position: relative; padding: 4px 0 4px 32px; color: var(--ink-2); counter-increment: step; }
.steps li::before {
  content: counter(step); position: absolute; left: 0; top: 5px; width: 22px; height: 22px; border-radius: 50%;
  display: flex; align-items: center; justify-content: center; font-size: 12px; font-weight: 700; background: var(--tile); color: var(--primary);
}

.notes { font-size: 14px; line-height: 1.6; }
.notes h3 { font-size: 14px; font-weight: 600; margin: 14px 0 4px; }
.notes ul { margin: 0; padding: 0 0 0 1.1em; color: var(--ink-2); }
.notes li { margin: 6px 0; padding-left: 2px; }
.notes p { margin: 6px 0; color: var(--ink-2); }

.hint { text-align: center; font-size: 16px; margin: 8px 0; }
.arrow { position: fixed; top: 8px; right: 20px; font-size: 28px; line-height: 1; color: var(--ink-3); }

.foot { margin: 24px 4px 0; text-align: center; font-size: 12px; line-height: 1.6; color: var(--ink-3); }
.foot p { margin: 0; }
.privacy { max-width: 36em; margin: 0 auto 10px !important; text-wrap: pretty; }
.line { display: flex; flex-wrap: wrap; justify-content: center; gap: 4px 12px; }
.foot a { color: var(--ink-2); text-decoration: none; border-bottom: 0.5px solid var(--line); }
.foot a:hover { color: var(--ink); }

@media (min-width: 720px) {
  body { padding-top: max(72px, env(safe-area-inset-top)); }
  main { max-width: 460px; }
  .icon { width: 96px; height: 96px; border-radius: 24px; margin-bottom: 20px; }
  h1 { font-size: 34px; }
  .slogan { font-size: 18px; }
  .hero { margin-bottom: 28px; }
  .card { padding: 24px; }
}
@media (prefers-reduced-motion: no-preference) {
  .hero, .card { animation: in 0.28s ease-out both; }
  .card { animation-delay: 0.04s; }
  @keyframes in { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: none; } }
}
@media (prefers-reduced-motion: reduce) {
  .seg::before, .btn, .seg label { transition: none; }
}
`;

/** beta.js: the key form on /beta. The card comes rendered from the server. */
export const PAGE_SCRIPT = `'use strict';
(function () {
  var form = document.getElementById('form');
  if (!form) return;
  var d = form.dataset;
  var input = document.getElementById('key');
  var error = document.getElementById('error');
  var submit = document.getElementById('submit');
  var lock = document.getElementById('lock');
  var release = document.getElementById('release');
  var key = '';
  var expiresAt = 0;

  function showError(text) {
    error.textContent = text;
    error.hidden = !text;
    input.setAttribute('aria-invalid', text ? 'true' : 'false');
  }
  function failure(status) { return status === 429 ? d.busy : status === 404 ? d.none : d.invalid; }
  function unlock() {
    return fetch('/beta/api/unlock', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: key, lang: d.lang }),
      cache: 'no-store',
      credentials: 'omit'
    }).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (body) { return { status: res.status, body: body }; });
    });
  }
  function show(body) {
    expiresAt = body.expiresAt;
    release.innerHTML = body.card;
    lock.hidden = true;
    release.hidden = false;
    var checked = release.querySelector('input[name="via"]:checked');
    var button = release.querySelector(checked ? '.p' + checked.id.slice(4) + ' .btn' : '.pane .btn');
    if (button) button.focus({ preventScroll: true });
  }

  form.addEventListener('submit', function (e) {
    e.preventDefault();
    key = input.value.trim();
    if (!key) { showError(d.empty); input.focus(); return; }
    showError('');
    submit.disabled = true;
    submit.textContent = d.checking;
    unlock().then(function (r) {
      if (r.status === 200 && r.body && r.body.card) return show(r.body);
      showError(failure(r.status));
      input.focus();
      input.select();
    }, function () {
      showError(d.offline);
    }).then(function () {
      submit.disabled = false;
      submit.textContent = d.unlock;
    });
  });
  input.addEventListener('input', function () { if (!error.hidden) showError(''); });

  // The Global route is a signed link that lasts ten minutes: past that,
  // fetch a fresh one with the same key.
  release.addEventListener('click', function (e) {
    var link = e.target.closest ? e.target.closest('a[data-route="global"]') : null;
    if (!link || Date.now() < expiresAt - 60000) return;
    e.preventDefault();
    if (link.getAttribute('aria-disabled') === 'true') return;
    link.setAttribute('aria-disabled', 'true');
    unlock().then(function (r) {
      if (r.status === 200 && r.body && r.body.url) {
        expiresAt = r.body.expiresAt;
        link.href = r.body.url;
        location.href = r.body.url;
      } else {
        release.hidden = true;
        lock.hidden = false;
        showError(failure(r.status));
      }
    }, function () {}).then(function () { link.removeAttribute('aria-disabled'); });
  });
})();
`;
