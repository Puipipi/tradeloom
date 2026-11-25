// Wrong access keys, counted per client.
//
// One Durable Object per client (named by a hash of its IP, never the IP):
// a single-threaded, strongly consistent counter. The Rate Limiting bindings
// are approximate per location and let 15 wrong keys in a row through in
// production; KV caches reads for up to a minute, so a counter there never
// gets past 1. This doesn't have either problem.
//
// A client gets FAIL_LIMIT wrong keys; each restarts a BLOCK_SECONDS window.
// The next wrong key blocks it for BLOCK_SECONDS. An alarm clears the object
// once both have run out, so nothing is kept for long.

import type { Env } from './env';

export const FAIL_LIMIT = 5;
export const BLOCK_SECONDS = 10 * 60;

interface Counter {
  count: number;
  /** ms; the count resets after this. */
  resetAt: number;
  /** ms; 0 = not blocked. */
  blockedUntil: number;
}

export interface GuardAnswer {
  count: number;
  blocked: boolean;
}

/** The Durable Object (bound as BETA_GUARD). POST /check, POST /fail. */
export class BetaGuard {
  constructor(
    private readonly state: DurableObjectState,
    _env?: unknown,
  ) {}

  /** For tests. */
  now = () => Date.now();

  async fetch(request: Request): Promise<Response> {
    const action = new URL(request.url).pathname;
    if (request.method !== 'POST' || (action !== '/check' && action !== '/fail')) return new Response(null, { status: 404 });
    const now = this.now();
    let c = (await this.state.storage.get<Counter>('c')) ?? { count: 0, resetAt: 0, blockedUntil: 0 };
    if (c.resetAt <= now && c.blockedUntil <= now) c = { count: 0, resetAt: 0, blockedUntil: 0 };
    if (action === '/fail' && c.blockedUntil <= now) {
      c.count += 1;
      c.resetAt = now + BLOCK_SECONDS * 1000;
      if (c.count > FAIL_LIMIT) c.blockedUntil = now + BLOCK_SECONDS * 1000;
      await this.state.storage.put('c', c);
      await this.state.storage.setAlarm(Math.max(c.resetAt, c.blockedUntil));
    }
    const answer: GuardAnswer = { count: c.count, blocked: c.blockedUntil > now };
    return Response.json(answer);
  }

  async alarm(): Promise<void> {
    const c = await this.state.storage.get<Counter>('c');
    const now = this.now();
    if (c && Math.max(c.resetAt, c.blockedUntil) > now) {
      await this.state.storage.setAlarm(Math.max(c.resetAt, c.blockedUntil));
      return;
    }
    await this.state.storage.deleteAll();
  }
}

async function clientName(ip: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`beta-guard\n${ip}`));
  return [...new Uint8Array(digest).slice(0, 16)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Asks the client's guard; null when there's no binding or it failed (fail open). */
export async function guard(env: Env, ip: string, action: 'check' | 'fail'): Promise<GuardAnswer | null> {
  const ns = env.BETA_GUARD;
  if (!ns) return null;
  try {
    const stub = ns.get(ns.idFromName(await clientName(ip)));
    const res = await stub.fetch(`https://guard/${action}`, { method: 'POST' });
    if (!res.ok) return null;
    return (await res.json()) as GuardAnswer;
  } catch (e) {
    console.error('beta guard failed', e instanceof Error ? e.message : String(e));
    return null;
  }
}
