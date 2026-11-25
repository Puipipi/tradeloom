import { createHash } from 'node:crypto';

const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const unknown = () => ({ status: 'unknown' });

/**
 * Query optional content evidence from a trusted private index record.
 * The caller owns safe index loading and session/workspace authorization; a
 * model-provided record is never provenance. This function reads no paths and
 * does not migrate or bless historical files whose index has no digest.
 */
export function queryGeneratedDigest(index, { sessionId, rid, path } = {}) {
  if (!record(index) || index.schemaVersion !== 1 || typeof sessionId !== 'string' || !sessionId
    || typeof rid !== 'string' || !/^m_[a-f0-9-]{36}$/.test(rid) || typeof path !== 'string' || !path
    || index.sessionId !== sessionId || index.rid !== rid
    || !record(index.media) || index.media.v !== 1 || index.media.rid !== rid
    || index.media.kind !== 'image' || index.media.status !== 'done'
    || !Array.isArray(index.media.items) || index.media.items.length < 1 || index.media.items.length > 4
    || !Array.isArray(index.contentDigests) || index.contentDigests.length !== index.media.items.length) return unknown();
  const paths = new Set();
  for (let i = 0; i < index.media.items.length; i++) {
    const item = index.media.items[i], evidence = index.contentDigests[i];
    if (!record(item) || typeof item.path !== 'string' || paths.has(item.path)
      || !Number.isSafeInteger(item.bytes) || item.bytes <= 0
      || !record(evidence) || evidence.bytes !== item.bytes
      || typeof evidence.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(evidence.sha256)) return unknown();
    paths.add(item.path);
  }
  const position = index.media.items.findIndex(item => item.path === path);
  const evidence = index.contentDigests[position];
  return evidence ? { status: 'available', bytes: evidence.bytes, sha256: evidence.sha256 } : unknown();
}

/** Verify already-captured bytes, never re-open a mutable path. Not upload authorization. */
export function verifyGeneratedDigest(index, selector, bytes) {
  const expected = queryGeneratedDigest(index, selector);
  if (expected.status !== 'available' || !(bytes instanceof Uint8Array)) return unknown();
  return { status: bytes.byteLength === expected.bytes
    && createHash('sha256').update(bytes).digest('hex') === expected.sha256 ? 'match' : 'mismatch' };
}
