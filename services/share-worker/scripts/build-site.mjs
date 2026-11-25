#!/usr/bin/env node
// Builds public/, the Worker's static assets, from the site pages: the files
// and the headers each is served with (public/_headers). Cloudflare serves
// them without running the Worker (wrangler.jsonc assets); the Worker only
// serves the viewer, with the headers this writes to src/generated/pages.ts.
// A page's CSP is its own <meta> policy plus frame-ancestors (which a <meta>
// policy can't carry). Runs before every `wrangler dev` / `wrangler deploy`.
//
// Input (made by app/tool/make_replay_viewer.py):
//   site/build/share/c.html       the hosted viewer → public/c.html (the Worker serves it at /c/<id>)
//   site/build/share/*            the landing page  → public/share/* (at /share/)
// Input (static, in the repo):
//   site/home/dist/*              the home page     → public/* (index.html at /, its
//                                 files at their own paths: /app.js, /assets/…)
//
// SITE_BUILD=<dir> points at another build (tests use a fixture).

import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writePetMarketProfile } from './build-pet-market-profile.mjs';
import { writeWorkshopData } from './build-workshop-data.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const worker = resolve(here, '..');
const repo = resolve(worker, '../..');
const source = resolve(process.env.SITE_BUILD ?? join(repo, 'site/build/share'));
const home = join(repo, 'site/home/dist');
const out = join(worker, 'public');

const LANDING = ['index.html', 'share.js', 'viewer.js', 'viewer.css', 'favicon.svg', 'apple-touch-icon.png'];

function fail(message) {
  console.error(`build-site: ${message}`);
  process.exit(1);
}

if (!existsSync(join(source, 'c.html'))) {
  fail(`${source}/c.html is missing: run python3 app/tool/make_replay_viewer.py first`);
}
for (const name of LANDING) if (!existsSync(join(source, name))) fail(`${source}/${name} is missing`);
if (!existsSync(join(home, 'index.html'))) fail(`${home}/index.html is missing`);

/** The policy in a page's <meta http-equiv="Content-Security-Policy">. */
function metaCsp(file) {
  const html = readFileSync(file, 'utf8');
  const tag = /<meta\s+http-equiv=["']Content-Security-Policy["']\s+content=(["'])(.*?)\1\s*\/?>/is.exec(html);
  if (!tag) fail(`${file} has no CSP <meta>`);
  const policy = tag[2].replace(/\s+/g, ' ').trim();
  if (!/default-src 'none'/.test(policy)) fail(`${file}: CSP must start from default-src 'none'`);
  if (/script-src[^;]*'unsafe-(inline|eval)'/.test(policy)) fail(`${file}: CSP allows unsafe scripts`);
  return policy.replace(/;?\s*$/, '') + "; frame-ancestors 'none'";
}

const viewerCsp = metaCsp(join(source, 'c.html'));
if (!/connect-src[^;]*'self'/.test(viewerCsp)) fail("c.html must allow connect-src 'self' (it fetches /api/v1/c/<id>)");

const COMMON = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Robots-Tag': 'noindex',
  'Strict-Transport-Security': 'max-age=31536000',
};
const FILE = { ...COMMON, 'Cache-Control': 'public, max-age=3600' };
const page = (csp) => ({
  ...COMMON,
  'X-Frame-Options': 'DENY',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
  'Cache-Control': 'no-cache',
  'Content-Security-Policy': csp,
});
/** Only the home page and its files may be indexed (robots.txt says the same). */
const indexable = ({ 'X-Robots-Tag': _, ...headers }) => headers;

/** The home page's files as served: /app.js, /assets/…; dot files are left out. */
const homeFiles = readdirSync(home, { recursive: true, withFileTypes: true })
  .filter((e) => e.isFile() && !e.name.startsWith('.') && e.name !== 'index.html')
  .map((e) => '/' + relative(home, join(e.parentPath, e.name)).split(sep).join('/'))
  .sort();

/** Request path → headers, for every file served as is. */
const served = {
  '/': indexable(page(metaCsp(join(home, 'index.html')))),
  ...Object.fromEntries(homeFiles.map((p) => [p, indexable(p.endsWith('.html') ? page(metaCsp(join(home, p))) : FILE)])),
  '/share/': page(metaCsp(join(source, 'index.html'))),
  ...Object.fromEntries(LANDING.map((name) => [`/share/${name}`, name === 'index.html' ? page(metaCsp(join(source, name))) : FILE])),
  '/favicon.svg': FILE,
  '/robots.txt': FILE,
};
// Cloudflare's limits for _headers.
if (Object.keys(served).length > 100) fail(`${Object.keys(served).length} files: public/_headers takes 100 rules`);

rmSync(out, { recursive: true, force: true });
mkdirSync(join(out, 'share'), { recursive: true });
cpSync(join(source, 'c.html'), join(out, 'c.html'));
for (const name of LANDING) cpSync(join(source, name), join(out, 'share', name));
cpSync(join(source, 'favicon.svg'), join(out, 'favicon.svg'));
// Search engines may index the home page and its files; nothing else.
writeFileSync(
  join(out, 'robots.txt'),
  ['User-agent: *', 'Allow: /$', ...homeFiles.map((p) => `Allow: ${p}$`), 'Disallow: /', ''].join('\n'),
);
for (const path of homeFiles) if (existsSync(join(out, path))) fail(`site/home/dist${path} would hide public${path}`);
cpSync(home, out, { recursive: true, filter: (from) => !basename(from).startsWith('.') });
writeFileSync(
  join(out, '_headers'),
  Object.entries(served)
    .map(([path, headers]) => [path, ...Object.entries(headers).map(([k, v]) => `  ${k}: ${v}`)].join('\n'))
    .join('\n') + '\n',
);
// The pages at directory paths; /index.html and /c.html go to the Worker (404).
writeFileSync(join(out, '_redirects'), '/ /index.html 200\n/share/ /share/index.html 200\n');

mkdirSync(join(worker, 'src/generated'), { recursive: true });
writeFileSync(
  join(worker, 'src/generated/pages.ts'),
  '// GENERATED by scripts/build-site.mjs. Do not edit.\n' +
    `/** The viewer's headers (public/c.html at /c/<id>). */\n` +
    `export const VIEWER_HEADERS: Record<string, string> = ${JSON.stringify(page(viewerCsp), null, 2)};\n`,
);

writeWorkshopData(worker);
writePetMarketProfile(worker);
console.log(`build-site: ${Object.keys(served).length} paths from ${source} and ${home} → public/`);
