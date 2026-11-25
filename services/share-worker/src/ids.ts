// Link ids and expiry tiers.
//
// An id is 10 base62 characters. Its first character also says how long the
// link lives, so a read finds the object without an index: the alphabet is cut
// into three runs, one per tier, and the object sits under that tier's prefix
// in R2, where a lifecycle rule deletes it on time.

export const ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
export const ID_LENGTH = 10;

export type Ttl = '7d' | '30d' | 'forever';

interface Tier {
  ttl: Ttl;
  /** R2 key prefix; the lifecycle rules match these. */
  prefix: string;
  /** Lifetime in days, null for no expiry. */
  days: number | null;
  /** First-character run [from, to) in [ALPHABET]. */
  from: number;
  to: number;
}

export const TIERS: readonly Tier[] = [
  { ttl: '7d', prefix: '7d/', days: 7, from: 0, to: 20 }, // 0-9 A-J
  { ttl: '30d', prefix: '30d/', days: 30, from: 20, to: 40 }, // K-Z a-d
  { ttl: 'forever', prefix: 'keep/', days: null, from: 40, to: 62 }, // e-z
];

export const DEFAULT_TTL: Ttl = '30d';

const ID_PATTERN = new RegExp(`^[0-9A-Za-z]{${ID_LENGTH}}$`);

export function parseTtl(value: string | null): Ttl | null {
  if (value === null || value === '') return DEFAULT_TTL;
  return TIERS.some((t) => t.ttl === value) ? (value as Ttl) : null;
}

export function tierOfTtl(ttl: Ttl): Tier {
  return TIERS.find((t) => t.ttl === ttl)!;
}

/** The tier an id belongs to, or null when it isn't one of ours. */
export function tierOfId(id: string): Tier | null {
  if (!ID_PATTERN.test(id)) return null;
  const at = ALPHABET.indexOf(id[0]!);
  return TIERS.find((t) => at >= t.from && at < t.to) ?? null;
}

export function objectKey(id: string): string | null {
  const tier = tierOfId(id);
  return tier ? tier.prefix + id : null;
}

export function newId(ttl: Ttl): string {
  const tier = tierOfTtl(ttl);
  // Consume a fresh block within this ID, instead of discarding it after each character.
  const buf = new Uint8Array(16);
  let at = buf.length;
  function randomBelow(n: number): number {
    const limit = 256 - (256 % n);
    for (;;) {
      if (at === buf.length) {
        crypto.getRandomValues(buf);
        at = 0;
      }
      const b = buf[at++]!;
      if (b < limit) return b % n;
    }
  }
  let id = ALPHABET[tier.from + randomBelow(tier.to - tier.from)]!;
  while (id.length < ID_LENGTH) id += ALPHABET[randomBelow(ALPHABET.length)]!;
  return id;
}

/** When an object uploaded at [uploaded] stops being served; null for never. */
export function expiresAt(tier: Tier, uploaded: Date): Date | null {
  return tier.days === null ? null : new Date(uploaded.getTime() + tier.days * 86_400_000);
}
