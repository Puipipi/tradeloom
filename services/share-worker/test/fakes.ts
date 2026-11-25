// In-memory stand-ins for the Worker's bindings (just what src/ uses).
import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { BetaGuard } from '../src/beta-guard';
import type { Env } from '../src/env';
import worker from '../src/index';
import { StatsSalt } from '../src/stats';

interface Stored {
  bytes: Uint8Array;
  uploaded: Date;
  customMetadata: Record<string, string>;
  contentType?: string;
  cacheControl?: string;
}

export class FakeBucket {
  objects = new Map<string, Stored>();
  now = () => new Date();

  gets: { key: string; range?: unknown }[] = [];

  async head(key: string) {
    const o = this.objects.get(key);
    return o
      ? { key, size: o.bytes.byteLength, uploaded: o.uploaded, customMetadata: o.customMetadata, httpEtag: `"${key.length}-${o.bytes.byteLength}"` }
      : null;
  }

  /** R2's range semantics: offset / length / suffix; past the end throws. */
  async get(key: string, options?: { range?: { offset?: number; length?: number; suffix?: number } }) {
    this.gets.push({ key, range: options?.range });
    const o = this.objects.get(key);
    if (!o) return null;
    let bytes = o.bytes;
    const r = options?.range;
    if (r) {
      if (r.suffix !== undefined) bytes = bytes.slice(Math.max(0, bytes.byteLength - r.suffix));
      else {
        const start = r.offset ?? 0;
        if (start >= o.bytes.byteLength) throw new Error('get: The requested range is not satisfiable. (10039)');
        bytes = bytes.slice(start, r.length !== undefined ? start + r.length : undefined);
      }
    }
    return {
      key,
      size: o.bytes.byteLength,
      uploaded: o.uploaded,
      customMetadata: o.customMetadata,
      httpEtag: `"${key.length}-${o.bytes.byteLength}"`,
      body: new Blob([bytes]).stream(),
      text: async () => new TextDecoder().decode(o.bytes),
    };
  }

  async put(key: string, value: Uint8Array | string, options: { onlyIf?: Headers; customMetadata?: Record<string, string>; httpMetadata?: { contentType?: string; cacheControl?: string } }) {
    // The create-once condition used by uploads; other R2 conditions are not modeled.
    if (options.onlyIf?.get('If-None-Match') === '*' && this.objects.has(key)) return null;
    const stored: Stored = {
      bytes: typeof value === 'string' ? new TextEncoder().encode(value) : new Uint8Array(value),
      uploaded: this.now(),
      customMetadata: options.customMetadata ?? {},
      contentType: options.httpMetadata?.contentType,
      cacheControl: options.httpMetadata?.cacheControl,
    };
    this.objects.set(key, stored);
    return { key, size: stored.bytes.byteLength, uploaded: stored.uploaded };
  }

  async delete(key: string) {
    this.objects.delete(key);
  }
}

export class FakeKv {
  values = new Map<string, string>();
  /** Options of every put, by key (expirationTtl…). */
  options = new Map<string, unknown>();
  failWrites = false;
  failReads = false;

  async get(key: string) {
    if (this.failReads) throw new Error('kv read');
    return this.values.get(key) ?? null;
  }

  async put(key: string, value: string, options?: unknown) {
    if (this.failWrites) throw new Error('kv write');
    this.values.set(key, value);
    this.options.set(key, options);
  }
}

export class FakeLimiter {
  constructor(public allow = Infinity) {}
  counts = new Map<string, number>();
  keys: string[] = [];

  async limit({ key }: { key: string }) {
    this.keys.push(key);
    const n = (this.counts.get(key) ?? 0) + 1;
    this.counts.set(key, n);
    return { success: n <= this.allow };
  }
}

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.txt': 'text/plain; charset=utf-8',
};

/** Workers Static Assets with html_handling "none": exact paths only. */
export const fakeAssets = {
  root: fileURLToPath(new URL('../public', import.meta.url)),
  async fetch(request: Request): Promise<Response> {
    const path = decodeURIComponent(new URL(request.url).pathname);
    if (path.includes('..') || path.endsWith('/')) return new Response('nope', { status: 404 });
    try {
      const bytes = await readFile(join(this.root, path));
      return new Response(bytes, { status: 200, headers: { 'Content-Type': TYPES[extname(path)] ?? 'application/octet-stream', ETag: '"x"' } });
    } catch {
      return new Response('nope', { status: 404 });
    }
  },
};

/** The config's `"run_worker_first"` and public/'s _redirects and _headers, read once. */
let site: { workerFirst: RegExp[]; rewrites: Map<string, string>; headers: Map<string, [string, string][]> } | undefined;
function readSite() {
  const jsonc = readFileSync(new URL('../wrangler.jsonc', import.meta.url), 'utf8')
    .replace(/"(?:\\.|[^"\\])*"|\/\/[^\n]*/g, (m) => (m.startsWith('"') ? m : ''))
    .replace(/,(\s*[}\]])/g, '$1');
  const patterns: string[] = JSON.parse(jsonc).assets.run_worker_first;
  const glob = (p: string) => new RegExp('^' + p.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$');
  const file = (name: string) => readFileSync(join(fakeAssets.root, name), 'utf8').split('\n').filter(Boolean);
  const headers = new Map<string, [string, string][]>();
  let rule: [string, string][] = [];
  for (const line of file('_headers')) {
    if (!line.startsWith(' ')) headers.set(line, (rule = []));
    else rule.push(line.trim().split(/: (.*)/).slice(0, 2) as [string, string]);
  }
  const rewrites = new Map(file('_redirects').map((l) => l.split(' ')).filter((r) => r[2] === '200').map((r) => [r[0]!, r[1]!]));
  return { workerFirst: patterns.map(glob), rewrites, headers };
}

const siteConfig = () => (site ??= readSite());

/** [path] goes to the Worker before any file is looked up (wrangler.jsonc). */
export function workerFirst(path: string): boolean {
  return siteConfig().workerFirst.some((re) => re.test(path));
}

/** Cloudflare in front of the Worker, as wrangler dev's asset server does
 *  it: a run_worker_first path goes to the Worker; else a rewrite from
 *  _redirects, then a file at the exact path is served with that path's
 *  _headers rule (405 to other methods); anything else goes to the Worker. */
export async function serve(request: Request, env: Env, ctx = makeCtx().ctx): Promise<Response> {
  const path = new URL(request.url).pathname;
  const { rewrites, headers: rules } = siteConfig();
  if (!workerFirst(path)) {
    const res = await fakeAssets.fetch(new Request(new URL(rewrites.get(path) ?? path, request.url)));
    if (res.ok) {
      const headers = new Headers(res.headers);
      for (const [k, v] of rules.get(path) ?? []) headers.set(k, v);
      if (request.method !== 'GET' && request.method !== 'HEAD') return new Response(null, { status: 405, headers });
      return new Response(request.method === 'HEAD' ? null : res.body, { status: 200, headers });
    }
  }
  return worker.fetch(request, env, ctx);
}

/** Durable Object storage: just what BetaGuard uses. */
export class FakeDoStorage {
  data = new Map<string, unknown>();
  alarm: number | null = null;
  async get<T>(key: string): Promise<T | undefined> {
    const v = this.data.get(key);
    return v === undefined ? undefined : (structuredClone(v) as T);
  }
  async put(key: string, value: unknown) {
    this.data.set(key, structuredClone(value));
  }
  async deleteAll() {
    this.data.clear();
  }
  async setAlarm(at: number) {
    this.alarm = at;
  }
}

/** BETA_GUARD: one real BetaGuard per name, over fake storage. */
export class FakeGuardNamespace {
  objects = new Map<string, { guard: BetaGuard; storage: FakeDoStorage }>();
  now = () => Date.now();
  fail = false;

  idFromName(name: string) {
    return name;
  }

  get(id: string) {
    return {
      fetch: async (url: string, init?: RequestInit) => {
        if (this.fail) throw new Error('durable object unavailable');
        let o = this.objects.get(id);
        if (!o) {
          const storage = new FakeDoStorage();
          const guard = new BetaGuard({ storage } as unknown as DurableObjectState);
          guard.now = () => this.now();
          o = { guard, storage };
          this.objects.set(id, o);
        }
        return o.guard.fetch(new Request(url, init));
      },
    };
  }
}

/** STATS_SALT: one real StatsSalt per name, over fake storage, on a settable clock. */
export class FakeSaltNamespace {
  objects = new Map<string, { salt: StatsSalt; storage: FakeDoStorage }>();
  now = () => Date.now();
  fail = false;
  calls = 0;

  idFromName(name: string) {
    return name;
  }

  get(id: string) {
    return {
      fetch: async () => {
        this.calls++;
        if (this.fail) throw new Error('durable object unavailable');
        let o = this.objects.get(id);
        if (!o) {
          const storage = new FakeDoStorage();
          const salt = new StatsSalt({ storage } as unknown as DurableObjectState);
          salt.now = () => this.now();
          o = { salt, storage };
          this.objects.set(id, o);
        }
        return o.salt.fetch();
      },
    };
  }
}

/** An Analytics Engine dataset: keeps every data point. */
export class FakeDataset {
  points: { indexes: string[]; blobs: string[]; doubles: number[] }[] = [];
  writeDataPoint(p: AnalyticsEngineDataPoint = {}) {
    this.points.push(structuredClone({ indexes: (p.indexes ?? []) as string[], blobs: (p.blobs ?? []) as string[], doubles: p.doubles ?? [] }));
  }
}

export function makeEnv(overrides: Partial<Env> = {}) {
  const bucket = new FakeBucket();
  const dl = new FakeBucket();
  const kv = new FakeKv();
  const uploadBurst = new FakeLimiter();
  const readLimit = new FakeLimiter();
  const guards = new FakeGuardNamespace();
  const salts = new FakeSaltNamespace();
  const downloads = new FakeDataset();
  const checks = new FakeDataset();
  const usage = new FakeDataset();
  const usageLimit = new FakeLimiter();
  const env = {
    ASSETS: fakeAssets,
    BUCKET: bucket as unknown as R2Bucket,
    DL: dl as unknown as R2Bucket,
    QUOTA: kv as unknown as KVNamespace,
    UPLOAD_BURST: uploadBurst,
    READ_LIMIT: readLimit,
    BETA_GUARD: guards as unknown as DurableObjectNamespace,
    STATS_SALT: salts as unknown as DurableObjectNamespace,
    DOWNLOADS: downloads,
    CHECKS: checks,
    USAGE: usage,
    USAGE_LIMIT: usageLimit,
    ADMIN_KEY: 'a'.repeat(20) + 'admin-key-for-tests-0123456789',
    UPLOADS_PER_HOUR: '20',
    MAX_BYTES: String(1024 * 1024),
    ...overrides,
  } satisfies Env;
  return { env, bucket, dl, kv, uploadBurst, readLimit, guards, salts, downloads, checks, usage, usageLimit };
}

/** caches.default: full responses keyed by URL; a Range lookup slices them. */
export class FakeCache {
  entries = new Map<string, { bytes: Uint8Array; headers: Headers }>();
  puts = 0;

  async match(request: Request): Promise<Response | undefined> {
    const hit = this.entries.get(request.url);
    if (!hit) return undefined;
    const range = /^bytes=(\d+)-$/.exec(request.headers.get('Range') ?? '');
    if (range) {
      const start = Number(range[1]);
      const h = new Headers(hit.headers);
      h.set('Content-Range', `bytes ${start}-${hit.bytes.byteLength - 1}/${hit.bytes.byteLength}`);
      h.set('Content-Length', String(hit.bytes.byteLength - start));
      return new Response(hit.bytes.slice(start), { status: 206, headers: h });
    }
    return new Response(hit.bytes, { status: 200, headers: new Headers(hit.headers) });
  }

  async put(request: Request, response: Response): Promise<void> {
    this.puts++;
    this.entries.set(request.url, { bytes: new Uint8Array(await response.arrayBuffer()), headers: new Headers(response.headers) });
  }
}

export function makeCtx() {
  const pending: Promise<unknown>[] = [];
  return {
    ctx: { waitUntil: (p: Promise<unknown>) => void pending.push(p), passThroughOnException: () => {} } as unknown as ExecutionContext,
    settle: () => Promise.all(pending),
  };
}
