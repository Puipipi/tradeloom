// Who may download beta builds:
//
//  - Access keys, for people (`dsh-` + 8 letters/digits, posted to a group).
//    KV `beta:key:<hmac>` → Grant; the HMAC is keyed with BETA_SECRET, so the
//    store alone doesn't give the keys away even though they are short.
//  - Channel tokens, compiled into the app (`dshc_…`, 32 random bytes), for
//    /beta/update.json and the in-app download. KV `beta:chan:<sha256>` → Grant.
//    Separate from the keys: rotating a group's key never cuts installed apps off.
//  - Signed links: what a key buys, a URL to one file valid for LINK_TTL.
//
// Grants are written by scripts/beta-keys.sh. Plaintext never reaches KV.
// Wrong keys are counted in src/beta-guard.ts.

import type { Env } from './env';

/** Letters and digits that can't be mistaken for one another (no 0 1 i l o). */
export const KEY_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';
const KEY_BODY = /^[abcdefghjkmnpqrstuvwxyz23456789]{8}$/;
const CHANNEL_TOKEN = /^dshc_[A-Za-z0-9_-]{32,64}$/;

/** How long a signed download link works. A download already running isn't cut off. */
export const LINK_TTL_SECONDS = 10 * 60;

export const KEY_PREFIX = 'beta:key:';
export const CHANNEL_PREFIX = 'beta:chan:';

export interface Grant {
  label: string;
  created?: string;
  /** ISO time; null or missing = never. */
  expires?: string | null;
  revoked?: boolean;
}

export function grantActive(grant: Grant | null, now = Date.now()): boolean {
  if (!grant || grant.revoked) return false;
  if (grant.expires) {
    const at = Date.parse(grant.expires);
    if (!Number.isFinite(at) || at <= now) return false;
  }
  return true;
}

/** `dsh-k7m3x9qp` from whatever was typed or pasted: full-width characters,
 *  capitals, spaces, other dashes, a missing or doubled prefix. Null when it
 *  can't be a key. */
export function normalizeKey(input: unknown): string | null {
  if (typeof input !== 'string' || input.length > 80) return null;
  const s = input
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\s​-‍⁠﻿]/g, '')
    .replace(/[‐-―−ー]/g, '-');
  for (const candidate of [s, s.replace(/^dsh-?/, '')]) {
    const body = candidate.replace(/-/g, '');
    if (KEY_BODY.test(body)) return `dsh-${body}`;
  }
  return null;
}

const encoder = new TextEncoder();

function hex(bytes: ArrayBuffer): string {
  return [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function base64url(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

const hmacKeys = new Map<string, Promise<CryptoKey>>();

function hmacKey(secret: string): Promise<CryptoKey> {
  let key = hmacKeys.get(secret);
  if (!key) {
    key = crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    hmacKeys.set(secret, key);
  }
  return key;
}

async function hmac(secret: string, message: string): Promise<ArrayBuffer> {
  return crypto.subtle.sign('HMAC', await hmacKey(secret), encoder.encode(message));
}

/** KV id of a normalized access key. scripts/beta-keys.sh computes the same. */
export async function keyId(secret: string, normalized: string): Promise<string> {
  return hex(await hmac(secret, `key\n${normalized}`));
}

/** KV id of a channel token: plain SHA-256 (the token is 256 random bits). */
export async function channelId(token: string): Promise<string> {
  return hex(await crypto.subtle.digest('SHA-256', encoder.encode(token)));
}

/** Same time whatever the strings hold. */
export function safeEqual(a: string, b: string): boolean {
  let diff = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++) diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return diff === 0;
}

async function readGrant(env: Env, kvKey: string): Promise<Grant | null> {
  if (!env.QUOTA) return null;
  try {
    const raw = await env.QUOTA.get(kvKey);
    if (!raw) return null;
    const grant = JSON.parse(raw) as Grant;
    return typeof grant === 'object' && grant !== null && typeof grant.label === 'string' ? grant : null;
  } catch {
    return null;
  }
}

/** The grant behind a typed key, or null (unknown, malformed). */
export async function lookupKey(env: Env, input: unknown): Promise<Grant | null> {
  const normalized = normalizeKey(input);
  if (!normalized || !env.BETA_SECRET) return null;
  return readGrant(env, KEY_PREFIX + (await keyId(env.BETA_SECRET, normalized)));
}

// Channel checks happen on every update check and download request: remember
// answers for a minute per isolate (KV itself is only eventually consistent).
const channelMemo = new Map<string, { ok: boolean; at: number; expiresAt: number | null }>();
const CHANNEL_MEMO_MS = 60_000;

/** For tests. */
export function resetChannelMemo(): void {
  channelMemo.clear();
}

/** True when the request carries `Authorization: Bearer <live channel token>`. */
export async function channelAuthorized(env: Env, request: Request, now = Date.now()): Promise<boolean> {
  const m = /^Bearer\s+(\S+)$/i.exec(request.headers.get('Authorization') ?? '');
  const token = m?.[1];
  if (!token || !CHANNEL_TOKEN.test(token)) return false;
  const id = await channelId(token);
  const memo = channelMemo.get(id);
  // The KV refresh window cannot extend an expiry we already know.
  if (memo && now - memo.at < CHANNEL_MEMO_MS) return memo.ok && (memo.expiresAt === null || now < memo.expiresAt);
  const grant = await readGrant(env, CHANNEL_PREFIX + id);
  const ok = grantActive(grant, now);
  if (channelMemo.size > 1000) channelMemo.clear();
  channelMemo.set(id, { ok, at: now, expiresAt: grant?.expires ? Date.parse(grant.expires) : null });
  return ok;
}

// ── Signed links ─────────────────────────────────────────────────────────

/** `sig` for a link to [path] (`/beta/<version>/<file>`) that works until [exp] (Unix seconds). */
export async function linkSignature(secret: string, path: string, exp: number): Promise<string> {
  return base64url(new Uint8Array(await hmac(secret, `dl\n${path}\n${exp}`)).slice(0, 16));
}

export async function signLink(secret: string, path: string, now = Date.now()): Promise<{ url: string; expiresAt: number }> {
  const exp = Math.floor(now / 1000) + LINK_TTL_SECONDS;
  const sig = await linkSignature(secret, path, exp);
  return { url: `${path}?exp=${exp}&sig=${sig}`, expiresAt: exp * 1000 };
}

/** True when the URL carries a valid, unexpired signature for its own path. */
export async function linkAuthorized(env: Env, url: URL, now = Date.now()): Promise<boolean> {
  const secret = env.BETA_SECRET;
  const exp = Number(url.searchParams.get('exp'));
  const sig = url.searchParams.get('sig') ?? '';
  if (!secret || !Number.isSafeInteger(exp) || !/^[A-Za-z0-9_-]{22}$/.test(sig)) return false;
  if (exp * 1000 <= now || exp * 1000 > now + (LINK_TTL_SECONDS + 60) * 1000) return false;
  return safeEqual(sig, await linkSignature(secret, url.pathname, exp));
}
