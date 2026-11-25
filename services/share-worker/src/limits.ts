// Per-client rate limits.
//
//  - Short bursts: Workers Rate Limiting bindings (60 s windows, per colo).
//  - Uploads per hour: a fixed-window counter in KV, because the bindings only
//    count over 10 or 60 seconds. KV is eventually consistent, so the hourly
//    cap is approximate across colos; a client normally stays on one.
//
// Counter failures fail open. An explicit zero hourly quota still pauses uploads.

import type { Env } from './env';

export interface RateLimiter {
  limit(options: { key: string }): Promise<{ success: boolean }>;
}

/** The client a limit applies to: the IPv4 address, or the /64 of an IPv6
 *  one (a single subscriber usually holds a whole /64). */
export function clientKey(request: Request): string {
  const ip = request.headers.get('CF-Connecting-IP')?.trim() || 'unknown';
  if (!ip.includes(':')) return ip;
  return expandV6(ip).slice(0, 4).join(':') + '::/64';
}

function expandV6(ip: string): string[] {
  const clean = ip.split('%')[0]!.toLowerCase();
  const [head, tail] = clean.includes('::') ? clean.split('::', 2) : [clean, null];
  const left = head ? head.split(':') : [];
  const right = tail ? tail.split(':') : [];
  const fill = tail === null ? [] : new Array(Math.max(0, 8 - left.length - right.length)).fill('0');
  return [...left, ...fill, ...right].map((g) => g.replace(/^0+(?=.)/, '') || '0');
}

export async function burstAllowed(limiter: RateLimiter | undefined, key: string): Promise<boolean> {
  if (!limiter) return true;
  try {
    return (await limiter.limit({ key })).success;
  } catch (e) {
    console.error('rate limit binding failed', e instanceof Error ? e.message : String(e));
    return true;
  }
}

async function hashKey(key: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode('dshgo-share:' + key));
  return [...new Uint8Array(digest).slice(0, 12)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export interface HourlyQuota {
  allowed: boolean;
  /** Seconds until the window resets (for Retry-After). */
  retryAfter: number;
  /** Records one upload in this window; call once the upload is stored. */
  commit(): Promise<void>;
}

export async function uploadQuota(env: Env, key: string, now = Date.now()): Promise<HourlyQuota> {
  const configured = Number(env.UPLOADS_PER_HOUR?.trim() || '20');
  const perHour = Number.isNaN(configured) ? 20 : configured;
  const hour = Math.floor(now / 3_600_000);
  const retryAfter = Math.max(1, Math.ceil(((hour + 1) * 3_600_000 - now) / 1000));
  if (perHour === 0) return { allowed: false, retryAfter, commit: async () => {} };
  const kv = env.QUOTA;
  if (!kv) return { allowed: true, retryAfter, commit: async () => {} };
  const kvKey = `up:${hour}:${await hashKey(key)}`;
  let count = 0;
  try {
    count = Number(await kv.get(kvKey)) || 0;
  } catch {
    count = 0;
  }
  return {
    allowed: count < perHour,
    retryAfter,
    commit: async () => {
      try {
        await kv.put(kvKey, String(count + 1), { expirationTtl: 2 * 3600 });
      } catch {
        // Over the KV write quota or a transient error: let it through.
      }
    },
  };
}
