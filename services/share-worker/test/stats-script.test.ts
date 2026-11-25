// scripts/stats.sh and scripts/github-downloads.sh against fakes: a local
// stand-in for the Analytics Engine SQL API with made-up rows, and the fake gh.
import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const worker = resolve(__dirname, '..');
const fakes = join(worker, 'test/publish-fakes');
const dir = mkdtempSync(join(tmpdir(), 'dshgo-stats-'));
const TOKEN = 'fake-analytics-token-' + Math.random().toString(36).slice(2);
writeFileSync(join(dir, 'token'), TOKEN + '\n', { mode: 0o600 });
// Made up: the public wrangler.jsonc only has a placeholder, and the machine's own
// ~/keys/dshgo-cloudflare-account-id must not leak into the test.
const ACCOUNT = '0123456789abcdef0123456789abcdef';

function sh(script: string, args: string[], env: Record<string, string> = {}): Promise<{ code: number; out: string }> {
  const clean = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(CF_|GH_|CLOUDFLARE|STATS_)/.test(k)));
  return new Promise((done) => {
    execFile(join(worker, 'scripts', script), args, { cwd: worker, env: { ...clean, CF_ACCOUNT_ID: ACCOUNT, ...env }, timeout: 60_000 }, (error, stdout, stderr) =>
      done({ code: error ? (typeof error.code === 'number' ? error.code : 1) : 0, out: stdout + stderr }),
    );
  });
}
const squash = (s: string) => s.replace(/[ \t]+/g, ' ');

// ── Made-up rows, shaped like the SQL API's answers (UInt64 as strings) ──
const dl = (day: string, route: string, country: string, device: string, n: number) => ({ day, route, version: '0.9.8', country, device, n: String(n) });
const ROWS: Record<string, unknown[]> = {
  dshgo_downloads: [
    dl('2026-11-05', 'cn', 'CN', 'a', 2), dl('2026-11-05', 'cn', 'CN', 'b', 1), dl('2026-11-05', 'global', 'US', 'c', 1), dl('2026-11-05', 'github', 'HK', 'd', 1),
    dl('2026-11-06', 'cn', 'CN', 'e', 1), dl('2026-11-06', 'global', 'CN', 'e', 1),
    dl('2026-10-01', 'cn', 'CN', 'old', 5), // before the window
  ],
  dshgo_checks: [
    { day: '2026-11-05', device: 'x', app: '', abi: '', n: '2' },
    { day: '2026-11-05', device: 'y', app: '', abi: '', n: '1' },
    { day: '2026-11-05', device: 'z', app: '0.9.9+10301000', abi: 'arm64-v8a', n: '1' },
    { day: '2026-11-06', device: 'x2', app: '', abi: '', n: '1' },
  ],
  dshgo_usage: [],
};
const use = (day: string, device: string, turns: number, over: Record<string, unknown> = {}) => ({
  day, device, app: '0.9.9', abi: 'arm64-v8a', maker: 'vivo', lang: 'zh', engine: 'proot', build: 10301000, sdk: 34, turns, voice: 1, phone: 0, share: 0, gen: 0, plugins: 2, ...over,
});
ROWS.dshgo_usage = [
  use('2026-10-10', 'u5', 1), // seen before: not new on 10-28
  use('2026-10-28', 'u1', 5), use('2026-10-28', 'u1', 8), // a repeat: once, the larger counts
  use('2026-10-28', 'u2', 1, { maker: 'xiaomi', engine: 'direct' }),
  use('2026-10-28', 'u3', 0, { abi: 'x86_64', lang: 'en' }),
  use('2026-10-28', 'u4', 2, { maker: 'huawei' }),
  use('2026-10-28', 'u5', 3),
  use('2026-10-28', 'u6', 4), use('2026-10-28', 'u6', 6, { app: '0.9.10', build: 11020000 }), // updated that day
  use('2026-11-04', 'u1', 7), use('2026-11-04', 'u2', 2, { maker: 'xiaomi', engine: 'direct' }),
  // v3: the tavern, the room, calls and tokens; a repeat keeps the larger counts.
  use('2026-11-05', 'u1', 1, { v: 3, tavern: 4, room: 1, calls: 0, tok_in: 12000, tok_out: 800 }),
  use('2026-11-05', 'u1', 1, { v: 3, tavern: 5, room: 1, calls: 0, tok_in: 15000, tok_out: 900 }),
  use('2026-11-05', 'u2', 0, { maker: 'xiaomi', engine: 'direct', v: 3, tavern: 0, room: 2, calls: 1, tok_in: 0, tok_out: 0 }),
];

let server: Server;
let api = '';
const seen: { path: string; auth: string; sql: string }[] = [];
let failWith = 0;

beforeAll(async () => {
  server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      seen.push({ path: req.url ?? '', auth: req.headers.authorization ?? '', sql: body });
      if (failWith) {
        res.writeHead(failWith).end('boom');
        return;
      }
      const table = /FROM (\w+)/.exec(body)?.[1] ?? '';
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ meta: [], data: ROWS[table] ?? [], rows: (ROWS[table] ?? []).length }));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  api = `http://127.0.0.1:${(server.address() as { port: number }).port}/client/v4`;
});

afterAll(() => new Promise<void>((r) => server.close(() => r())));

describe('stats.sh', () => {
  it('--dry-run prints the SQL and runs nothing', async () => {
    const trapped = mkdtempSync(join(tmpdir(), 'dshgo-trap-'));
    symlinkSync(join(fakes, 'forbidden'), join(trapped, 'curl'));
    const log = join(trapped, 'log');
    writeFileSync(log, '');
    const { code, out } = await sh('stats.sh', ['--dry-run', '--days', '7'], { PATH: `${trapped}:${process.env.PATH}`, FAKE_LOG: log });
    expect(code).toBe(0);
    expect(out).toContain(`POST https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/analytics_engine/sql`);
    for (const table of ['dshgo_downloads', 'dshgo_checks', 'dshgo_usage']) expect(out).toContain(`FROM ${table}`);
    expect(out).toContain("INTERVAL '8' DAY");
    expect(out).toContain("INTERVAL '29' DAY");
    expect(out).toContain('SUM(_sample_interval) AS n');
    expect(readFileSync(log, 'utf8')).toBe('');
  });

  it('reports downloads, near-daily-active and the app stats from the rows', async () => {
    seen.length = 0;
    const { code, out } = await sh('stats.sh', ['--days', '14'], { CF_TOKEN_FILE: join(dir, 'token'), CF_API_BASE: api, STATS_TODAY: '2026-11-06' });
    expect(code, out).toBe(0);
    expect(seen).toHaveLength(3);
    expect(seen.every((s) => s.path === `/client/v4/accounts/${ACCOUNT}/analytics_engine/sql` && s.auth === `Bearer ${TOKEN}`)).toBe(true);
    expect(out).not.toContain(TOKEN);
    const text = squash(out);
    expect(text).toContain('DSH Go 统计 · 2026-10-24 – 2026-11-06（UTC+8）');
    // Downloads: clicks, people (distinct codes), per route, before the window left out.
    expect(text).toContain('2026-11-05 5 4 3 1 1 0.9.8×5');
    expect(text).toContain('2026-11-06 2 1 1 1 0 0.9.8×2');
    expect(text).toContain('合计 7 4 2 1');
    expect(text).toContain('国家/地区：CN 71% · US 14% · HK 14%');
    // Update checks: distinct devices, checks, versions by device.
    expect(text).toContain('2026-11-05 3 4 未上报 67% · 0.9.9+10301000 33%');
    expect(text).toContain('2026-11-06 1 1 未上报 100%');
    // App: a device once a day, the larger counts; u5 isn't new on 10-28.
    expect(text).toContain('2026-10-28 6 20 6 0 0 0 12');
    expect(text).toContain('2026-11-04 2 9 2 0 0 0 4');
    expect(text).toContain('2026-10-28 5 2 40%');
    // v3: installs that used each, and how often; tokens in, out, per install with any.
    expect(text).toContain('2026-11-05 2 1 5 2 3 1 1');
    expect(text).toContain('2026-11-05 1 15,000 900 15,000 900');
    expect(text).toContain('分布（窗口内 6 个安装，各取最近一次上报）');
    expect(text).toContain('版本：0.9.9 83% · 0.9.10 17%');
    expect(text).toContain('厂商：vivo 67% · xiaomi 17% · huawei 17%');
    expect(text).toContain('运行方式：proot 83% · direct 17%');
    expect(text).toContain('ABI：arm64-v8a 83% · x86_64 17%');
  });

  it('says what went wrong, and needs the token file', async () => {
    failWith = 400;
    const failed = await sh('stats.sh', [], { CF_TOKEN_FILE: join(dir, 'token'), CF_API_BASE: api });
    failWith = 0;
    expect(failed.code).toBe(1);
    expect(failed.out).toContain('downloads: HTTP 400: boom');
    expect(failed.out).not.toContain(TOKEN);
    const none = await sh('stats.sh', [], { CF_API_BASE: api });
    expect(none.code).toBe(1);
    expect(none.out).toContain('CF_TOKEN_FILE');
  });
});

describe('github-downloads.sh', () => {
  it('lists GitHub\'s download counts per asset', async () => {
    const pages = join(dir, 'releases.json');
    const asset = (name: string, download_count: number) => ({ name, download_count, size: 1 });
    writeFileSync(pages, JSON.stringify([
      { tag_name: 'v0.9.8', published_at: '2026-10-30T02:00:00Z', draft: false, prerelease: false, assets: [asset('dsh-go-0.9.8-arm64.apk', 1234), asset('update.json', 5678), asset('dsh-go-0.9.8-x64.apk', 12)] },
      { tag_name: 'v0.9.9', published_at: null, draft: true, prerelease: false, assets: [asset('dsh-go-0.9.9-arm64.apk', 0)] },
    ]) + JSON.stringify([
      { tag_name: 'v0.9.0', published_at: '2026-10-25T02:00:00Z', draft: false, prerelease: false, assets: [asset('dsh-go-0.9.0-arm64.apk', 300)] },
    ]));
    const log = join(dir, 'gh.log');
    writeFileSync(log, '');
    const { code, out } = await sh('github-downloads.sh', [], { PATH: `${fakes}:${process.env.PATH}`, FAKE_GH_API: pages, FAKE_LOG: log });
    expect(code, out).toBe(0);
    const text = squash(out);
    expect(text).toContain('v0.9.8 2026-10-30 dsh-go-0.9.8-arm64.apk 1234');
    expect(text).toContain('v0.9.8 2026-10-30 update.json 5678');
    expect(text).toContain('v0.9.0 2026-10-25 dsh-go-0.9.0-arm64.apk 300');
    expect(text).not.toContain('v0.9.9');
    expect(text).toContain('APKs in all 1546');
    expect(readFileSync(log, 'utf8')).toBe('gh api --paginate repos/ccch1mneyyy/dsh-go/releases?per_page=100\n');
    const dry = await sh('github-downloads.sh', ['--dry-run'], { PATH: `${fakes}:${process.env.PATH}`, FAKE_LOG: log });
    expect(dry.out).toContain('dry run: gh api --paginate repos/ccch1mneyyy/dsh-go/releases?per_page=100');
  });
});
