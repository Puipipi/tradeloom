// The app's anonymous usage report (0.9.9 on; the person can turn it off):
//
//   POST /api/usage/v1   application/json, at most 2 KB, exactly these fields:
//   {"v":1,"iid":"<random 128-bit base64url>","day":"YYYY-MM-DD","app":"0.9.9",
//    "build":10301000,"sdk":34,"abi":"arm64-v8a","maker":"vivo","lang":"zh",
//    "engine":"direct|proot|none",
//    "counts":{"turns":0,"voice":0,"phone":0,"share":0,"gen":0,"plugins":0}}
//
//   v2 (1.0.15 on) is the same with "v":2 and two more fields: "model"
//   (Build.MODEL, "v2405a") and "rom" (the maker's system and its version,
//   "originos 5.0"). Both are taken on this same path; a phone whose v2 is
//   refused with a 400 sends its v1 body again.
//
//   v3 (1.0.17 on) is v2 with "v":3 and five more keys in "counts": "tavern"
//   (messages sent in the tavern), "room" (times the companion room was
//   opened), "call" (voice calls started), "tok_in" and "tok_out" (input and
//   output tokens that model replies reported that day; a channel that
//   reports none adds nothing, nothing is estimated). A phone whose v3 is
//   refused with a 400 sends v2, and if that is refused too, v1.
//   → 204; 400 {error, field} for anything else; 413, 415, 429.
//
// Nothing about the sender is kept: no IP (it only keys the per-minute limit,
// which forgets it within the minute), and the install id only as
// HMAC(USAGE_SECRET, iid) — enough to count devices per day and see who
// comes back, not to recover the id. One point per report goes to the
// dshgo_usage dataset; a device's repeats on the same day are dropped here
// when this isolate has seen them, and always by scripts/stats.sh.
// Without USAGE_SECRET or the dshgo_usage dataset the endpoint is 404, which
// the app takes as "not collecting": it stops sending for the day.

import { json, readCapped } from './api';
import type { Env } from './env';
import { burstAllowed, clientKey } from './limits';
import { addDays, hmacHex, statsDay, writeStat } from './stats';

export const MAX_BODY = 2048;

/** Per-day ceilings: anything above is a bug or a forgery. */
export const COUNT_LIMITS = { turns: 5000, voice: 2000, phone: 2000, share: 1000, gen: 1000, plugins: 500 } as const;
/** v3's further counts. Tokens run high: a long chat sends its whole context with every call. */
export const COUNT_LIMITS_V3 = { tavern: 5000, room: 1000, call: 500, tok_in: 2_000_000_000, tok_out: 200_000_000 } as const;
const ALL_LIMITS = { ...COUNT_LIMITS, ...COUNT_LIMITS_V3 };
type CountKey = keyof typeof ALL_LIMITS;
const COUNT_KEYS = Object.keys(COUNT_LIMITS) as CountKey[];
const COUNT_KEYS_V3 = [...COUNT_KEYS, ...(Object.keys(COUNT_LIMITS_V3) as CountKey[])];
const FIELDS = ['v', 'iid', 'day', 'app', 'build', 'sdk', 'abi', 'maker', 'lang', 'engine', 'counts'] as const;
const FIELDS_V2 = [...FIELDS, 'model', 'rom'] as const;
/** maker, model and rom: what usageMaker() on the phone leaves. */
const DEVICE_TEXT = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,31}$/;
const ABIS = ['arm64-v8a', 'armeabi-v7a', 'x86_64', 'x86'];
const ENGINES = ['direct', 'proot', 'none'];

export interface UsageReport {
  /** The contract: 1, 2 or 3. */
  v: number;
  iid: string;
  day: string;
  app: string;
  build: number;
  sdk: number;
  abi: string;
  maker: string;
  /** v2 on; empty for a v1 report. */
  model: string;
  rom: string;
  lang: string;
  engine: string;
  /** v3's counts are 0 in an older report. */
  counts: Record<CountKey, number>;
}

class Invalid extends Error {
  constructor(readonly code: string, readonly field: string) {
    super(`${code}: ${field}`);
  }
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

function only(obj: Record<string, unknown>, keys: readonly string[], prefix: string): void {
  for (const k of Object.keys(obj)) if (!keys.includes(k)) throw new Invalid('unknown_field', prefix + k);
  for (const k of keys) if (!(k in obj)) throw new Invalid('missing_field', prefix + k);
}

function int(v: unknown, field: string, min: number, max: number): number {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < min || v > max) throw new Invalid('invalid', field);
  return v;
}

function str(v: unknown, field: string, pattern: RegExp): string {
  if (typeof v !== 'string' || !pattern.test(v)) throw new Invalid('invalid', field);
  return v;
}

/** The report, or an Invalid naming the first field that's wrong. */
export function validateReport(body: unknown, now = Date.now()): UsageReport {
  if (!isObject(body)) throw new Invalid('invalid', 'body');
  if (body.v !== 1 && body.v !== 2 && body.v !== 3) throw new Invalid('invalid', 'v');
  const v = body.v;
  only(body, v === 1 ? FIELDS : FIELDS_V2, '');
  // 16 random bytes in base64url: 22 characters (the last one carries 2 bits);
  // a padded "==" form is taken too and stored the same.
  const iid = str(body.iid, 'iid', /^[A-Za-z0-9_-]{21}[AQgw](?:==)?$/).slice(0, 22);
  const day = str(body.day, 'day', /^\d{4}-\d{2}-\d{2}$/);
  // A real date in the last 8 days (UTC+8), or tomorrow for phones ahead of it.
  const today = statsDay(now);
  const at = Date.parse(`${day}T00:00:00Z`);
  if (!Number.isFinite(at) || new Date(at).toISOString().slice(0, 10) !== day) throw new Invalid('invalid', 'day');
  if (day < addDays(today, -7) || day > addDays(today, 1)) throw new Invalid('invalid', 'day');
  const app = str(body.app, 'app', /^\d{1,3}\.\d{1,3}\.\d{1,3}(?:-[0-9A-Za-z.]{1,20})?$/);
  const build = int(body.build, 'build', 1, 2_100_000_000);
  const sdk = int(body.sdk, 'sdk', 26, 60);
  const abi = str(body.abi, 'abi', /^[a-z0-9_-]{1,16}$/);
  if (!ABIS.includes(abi)) throw new Invalid('invalid', 'abi');
  const maker = str(body.maker, 'maker', DEVICE_TEXT).trim().toLowerCase();
  const model = v === 1 ? '' : str(body.model, 'model', DEVICE_TEXT).trim().toLowerCase();
  const rom = v === 1 ? '' : str(body.rom, 'rom', DEVICE_TEXT).trim().toLowerCase();
  const lang = str(body.lang, 'lang', /^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})?$/);
  const engine = str(body.engine, 'engine', /^[a-z]{1,8}$/);
  if (!ENGINES.includes(engine)) throw new Invalid('invalid', 'engine');
  if (!isObject(body.counts)) throw new Invalid('invalid', 'counts');
  const keys = v === 3 ? COUNT_KEYS_V3 : COUNT_KEYS;
  only(body.counts, keys, 'counts.');
  const counts = Object.fromEntries(COUNT_KEYS_V3.map((k) => [k, 0])) as UsageReport['counts'];
  for (const k of keys) counts[k] = int(body.counts[k], `counts.${k}`, 0, ALL_LIMITS[k]);
  return { v, iid, day, app, build, sdk, abi, maker, model, rom, lang, engine, counts };
}

// Repeats this isolate has already written: (day, hashed iid). Bounded.
const seen = new Set<string>();

/** For tests. */
export function resetUsageMemo(): void {
  seen.clear();
}

const noContent = () => new Response(null, { status: 204, headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });

export async function usage(request: Request, env: Env, now = Date.now()): Promise<Response> {
  if (request.method !== 'POST') return json(405, { error: 'method_not_allowed' }, { Allow: 'POST' });
  if (!env.USAGE_SECRET || !env.USAGE) return json(404, { error: 'not_found' });
  if (!(await burstAllowed(env.USAGE_LIMIT, `usage:${clientKey(request)}`))) return json(429, { error: 'too_many_requests' }, { 'Retry-After': '60' });
  if (!/^application\/json\s*(;|$)/i.test(request.headers.get('Content-Type') ?? '')) return json(415, { error: 'unsupported_media_type' });
  const declared = Number(request.headers.get('Content-Length') ?? '0');
  if (declared > MAX_BODY) return json(413, { error: 'too_large' });
  const bytes = await readCapped(request, MAX_BODY);
  if (!bytes) return json(413, { error: 'too_large' });

  let report: UsageReport;
  try {
    report = validateReport(JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes)), now);
  } catch (e) {
    if (e instanceof Invalid) return json(400, { error: e.code, field: e.field });
    return json(400, { error: 'bad_json' });
  }

  const device = await hmacHex(env.USAGE_SECRET, `iid\n${report.iid}`, 16);
  const key = `${report.day}:${device}`;
  if (seen.has(key)) return noContent();
  if (seen.size >= 50_000) seen.clear();
  seen.add(key);
  const c = report.counts;
  // dshgo_usage: blob1 day, blob2 device, blob3 app, blob4 abi, blob5 maker,
  // blob6 lang, blob7 engine, blob8 model, blob9 rom (empty before v2);
  // double1 build, double2 sdk, double3..8 counts, double9 the contract
  // (1–3), double10..14 v3's counts (0 before v3).
  writeStat(env.USAGE, {
    indexes: [device],
    blobs: [report.day, device, report.app, report.abi, report.maker, report.lang, report.engine, report.model, report.rom],
    doubles: [
      report.build, report.sdk, c.turns, c.voice, c.phone, c.share, c.gen, c.plugins,
      report.v, c.tavern, c.room, c.call, c.tok_in, c.tok_out,
    ],
  });
  return noContent();
}
