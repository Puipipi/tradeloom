import { afterEach, describe, expect, it, vi } from 'vitest';

import { ALPHABET, ID_LENGTH, TIERS, newId, objectKey, tierOfId } from '../src/ids';
import worker from '../src/index';
import { makeEnv } from './fakes';

afterEach(() => vi.restoreAllMocks());

// Only the entropy boundary is controlled; all ID and upload code is real.
function entropy(fill: (bytes: Uint8Array, call: number) => void) {
  let calls = 0;
  return vi.spyOn(crypto, 'getRandomValues').mockImplementation((array) => {
    expect(array).toBeInstanceOf(Uint8Array);
    fill(array as Uint8Array, ++calls);
    return array;
  });
}

function uploadRequest() {
  const bytes = new Uint8Array(64);
  bytes.set([0x44, 0x53, 0x47, 0x31]);
  return new Request('https://go.dshtui.com/api/v1/c?ttl=7d', {
    method: 'POST', body: bytes,
    headers: { 'Content-Type': 'application/octet-stream', 'CF-Connecting-IP': '203.0.113.9' },
  });
}

describe('ID entropy consumption', () => {
  it.each(TIERS)('fills one local block for an accepted $ttl ID', (tier) => {
    const random = entropy((bytes) => bytes.fill(0));
    for (let i = 0; i < 100; i++) {
      const id = newId(tier.ttl);
      expect(id).toBe(ALPHABET[tier.from] + '0'.repeat(ID_LENGTH - 1));
      expect(objectKey(id)).toBe(tier.prefix + id);
    }
    const allocated = random.mock.calls.reduce((sum, [a]) => sum + a!.byteLength, 0);
    console.log(JSON.stringify({ tier: tier.ttl, ids: 100, calls: random.mock.calls.length, bytes: allocated }));
    expect(random).toHaveBeenCalledTimes(100);
    expect(allocated).toBe(1600);
  });

  it('preserves every accepted first-byte residue for all tiers', () => {
    let value = 0;
    entropy((bytes) => bytes.fill(value));
    for (const tier of TIERS) {
      const n = tier.to - tier.from;
      const limit = 256 - 256 % n;
      const counts = Array(n).fill(0);
      for (value = 0; value < limit; value++) {
        const id = newId(tier.ttl);
        expect(id[0]).toBe(ALPHABET[tier.from + value % n]);
        expect(tierOfId(id)?.ttl).toBe(tier.ttl);
        counts[ALPHABET.indexOf(id[0]!) - tier.from]++;
      }
      expect(counts).toEqual(Array(n).fill(limit / n));
    }
  });

  it('discards a full rejected first-byte block and refills', () => {
    for (const tier of TIERS) {
      const n = tier.to - tier.from;
      const limit = 256 - 256 % n;
      const random = entropy((bytes, call) => bytes.fill(call === 1 ? limit : limit - 1));
      const id = newId(tier.ttl);
      expect(id).toBe(ALPHABET[tier.to - 1] + ALPHABET[(limit - 1) % 62]!.repeat(9));
      expect(random.mock.calls.length).toBeGreaterThanOrEqual(2);
      random.mockRestore();
    }
  });

  it('keeps all 62 tail residues balanced and rejects 248 through 255', () => {
    const counts = Array(62).fill(0);
    for (let value = 0; value < 256; value++) {
      const random = entropy((bytes, call) => {
        bytes.fill(value < 248 || call === 1 ? value : 0);
        if (call === 1) bytes[0] = 0; // A valid first character; remaining bytes test the tail.
      });
      const id = newId('7d');
      const expected = value < 248 ? value % 62 : 0;
      expect(id).toBe('0' + ALPHABET[expected]!.repeat(9));
      if (value < 248) counts[expected]++;
      random.mockRestore();
    }
    expect(counts).toEqual(Array(62).fill(4));
  });

  it('propagates entropy failures, including a refill, without retaining a pool', () => {
    const failure = new Error('entropy unavailable');
    const rejectsSame = (run: () => string) => {
      let caught: unknown;
      try { run(); } catch (e) { caught = e; }
      expect(caught).toBe(failure);
    };
    const first = entropy(() => { throw failure; });
    rejectsSame(() => newId('7d'));
    first.mockRestore();
    const refill = entropy((bytes, call) => {
      if (call > 1) throw failure;
      bytes.fill(255);
    });
    rejectsSame(() => newId('forever'));
    expect(refill).toHaveBeenCalledTimes(2);
    refill.mockRestore();
    const healthy = entropy((bytes) => bytes.fill(1));
    expect(newId('7d')).toBe('1'.repeat(10));
    expect(healthy.mock.calls.length).toBeGreaterThan(0);
  });

  it('measures real WebCrypto calls while preserving ID shape and tier', () => {
    const random = vi.spyOn(crypto, 'getRandomValues'); // Delegates to actual Node WebCrypto.
    for (const tier of TIERS) {
      for (let i = 0; i < 100; i++) {
        const id = newId(tier.ttl);
        expect(id).toMatch(/^[0-9A-Za-z]{10}$/);
        expect(tierOfId(id)?.ttl).toBe(tier.ttl);
      }
    }
    console.log(JSON.stringify({ realCryptoIds: 300, calls: random.mock.calls.length,
      bytes: random.mock.calls.reduce((sum, [a]) => sum + a!.byteLength, 0) }));
    // No probabilistic bound on rejection counts, and no statistical randomness claim.
  });

  it('uploads through Worker.fetch with an independent deletion token and collision retry', async () => {
    const ctx = makeEnv();
    const random = vi.spyOn(crypto, 'getRandomValues');
    const head = vi.spyOn(ctx.bucket, 'head');
    const put = vi.spyOn(ctx.bucket, 'put').mockResolvedValueOnce(null);
    const res = await worker.fetch(uploadRequest(), ctx.env);
    expect(res.status).toBe(201);
    const out = await res.json() as { id: string; deleteToken: string };
    expect(head).not.toHaveBeenCalled();
    expect(put).toHaveBeenCalledTimes(2);
    expect(put.mock.calls.every(([, , options]) => options.onlyIf?.get('If-None-Match') === '*')).toBe(true);
    expect(tierOfId(out.id)?.ttl).toBe('7d');
    expect(out.deleteToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(random.mock.calls.filter(([a]) => a!.byteLength === 32)).toHaveLength(1);
    expect(ctx.bucket.objects.size).toBe(1);
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(out.deleteToken));
    const hash = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
    expect(ctx.bucket.objects.get('7d/' + out.id)?.customMetadata.dt).toBe(hash);
    console.log(JSON.stringify({ uploadHeads: head.mock.calls.length, uploadPuts: put.mock.calls.length,
      idEntropyCalls: random.mock.calls.filter(([a]) => a!.byteLength === 16).length, deleteEntropyCalls: 1 }));
  });

  it('still stops after four occupied IDs without storing a new object', async () => {
    const ctx = makeEnv();
    const head = vi.spyOn(ctx.bucket, 'head');
    const put = vi.spyOn(ctx.bucket, 'put').mockResolvedValue(null);
    const res = await worker.fetch(uploadRequest(), ctx.env);
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'try_again' });
    expect(head).not.toHaveBeenCalled();
    expect(put).toHaveBeenCalledTimes(4);
    expect(put.mock.calls.every(([, , options]) => options.onlyIf?.get('If-None-Match') === '*')).toBe(true);
    expect(ctx.bucket.objects.size).toBe(0);
  });
});
