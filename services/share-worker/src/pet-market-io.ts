// Bounded, same-publication-root transfers for the pet/adapter catalog.
// Native R2 checksum verification keeps ZIPs out of the Worker's JS heap.
import type { Env } from './env';
import { ADAPTER_CAP } from './pet-catalog';

export interface MarketAsset {
  url: string;
  sha256: string;
  size: number;
}

const FAILURE_CODES = [
  'invalid-path', 'upstream-http', 'upstream-size', 'upstream-empty', 'body-too-large',
  'invalid-adapter-size', 'asset-integrity', 'invalid-adapter', 'stored-json-missing', 'stored-integrity', 'asset-race',
  'invalid-json', 'catalog-too-large', 'invalid-catalog', 'invalid-publication', 'invalid-release-history',
  'unbound-catalog', 'history-migration-required', 'stored-publication-too-large', 'stored-publication-size',
  'publication-condition', 'version-rewritten', 'release-history-full', 'publication-too-large',
  'future-catalog', 'catalog-rollback', 'withdrawal-rollback', 'missing-withdrawal', 'blocked-version-rollback',
  'stage-budget', 'invalid-stage', 'stage-conflict', 'publication-conflict',
] as const;
export class PetMarketError extends Error {
  constructor(readonly code: typeof FAILURE_CODES[number]) { super(code); }
}
export const failureCode = (error: unknown): string => error instanceof PetMarketError && FAILURE_CODES.includes(error.code)
  ? error.code : 'storage-or-network';

export const hex = (bytes: ArrayBuffer) => Array.from(new Uint8Array(bytes), b => b.toString(16).padStart(2, '0')).join('');
export const digest = async (bytes: Uint8Array) => hex(await crypto.subtle.digest('SHA-256', bytes));

/** Never await cancellation: a tee sibling may still own the underlying source. */
const cancel = (body: ReadableStream | null) => { void body?.cancel().catch(() => {}); };

export async function upstream(base: string, relative: string, cap: number, size?: number): Promise<Response> {
  // Callers construct these paths after validating the catalog; this is also a
  // second guard against accidental external URLs, traversal and URL encoding.
  if (!/^[A-Za-z0-9._+/-]+$/.test(relative) || relative.startsWith('/') || relative.split('/').includes('..'))
    throw new PetMarketError('invalid-path');
  const response = await fetch(base + relative, {
    redirect: 'manual', signal: AbortSignal.timeout(30_000),
    headers: { Accept: 'application/octet-stream', 'User-Agent': 'dshgo-share (+https://go.dshtui.com)' },
  });
  const length = response.headers.get('Content-Length');
  if (response.status !== 200) {
    cancel(response.body);
    throw new PetMarketError('upstream-http');
  }
  if (length !== null && (!/^\d+$/.test(length) || !Number.isSafeInteger(Number(length)) || Number(length) > cap ||
      (size !== undefined && Number(length) !== size))) {
    cancel(response.body);
    throw new PetMarketError('upstream-size');
  }
  if (!response.body) throw new PetMarketError('upstream-empty');
  return response;
}

export async function readBounded(stream: ReadableStream, cap: number): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > cap) throw new PetMarketError('body-too-large');
      chunks.push(value);
    }
  } catch (error) {
    void reader.cancel().catch(() => {});
    throw error;
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  return bytes;
}

export function storedAsset(object: R2Object | null, asset: MarketAsset): boolean {
  return !!object && object.size === asset.size && !!object.checksums?.sha256 && hex(object.checksums.sha256) === asset.sha256;
}

// Migrated JSON may not carry R2's native SHA. Its bounded actual bytes still
// have to pass checkJson; an explicitly supplied, wrong native SHA is never
// treated as absent. Opaque ZIP/preview objects keep requiring a native SHA.
function storedJsonMetadata(object: R2Object | null, asset: MarketAsset): boolean {
  return !!object && object.size === asset.size &&
    (!object.checksums?.sha256 || hex(object.checksums.sha256) === asset.sha256);
}

function jsonSize(asset: MarketAsset): void {
  if (!Number.isSafeInteger(asset.size) || asset.size < 1 || asset.size > ADAPTER_CAP)
    throw new PetMarketError('invalid-adapter-size');
}

async function checkJson(bytes: Uint8Array, asset: MarketAsset, validateJson: (value: unknown) => boolean): Promise<void> {
  if (bytes.length !== asset.size || await digest(bytes) !== asset.sha256) throw new PetMarketError('asset-integrity');
  let value: unknown;
  try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes)); }
  catch { throw new PetMarketError('invalid-adapter'); }
  if (!validateJson(value)) throw new PetMarketError('invalid-adapter');
}

export interface StoredJson { bytes: Uint8Array; etag: string; uploaded: Date }

/** Existing objects can predate the current adapter profile. A native checksum
 *  proves their bytes, not their present semantics. Read and check the bounded
 *  complete JSON on every reuse/authorization; return the same verified bytes
 *  for serving so a later GET cannot substitute an unchecked representation.
 */
export async function readStoredJson(env: Env, asset: MarketAsset,
  validateJson: (value: unknown) => boolean): Promise<StoredJson> {
  jsonSize(asset);
  const object = await env.DL.get(asset.url.slice(1));
  if (!object) throw new PetMarketError('stored-json-missing');
  if (!storedJsonMetadata(object, asset)) {
    cancel(object.body);
    throw new PetMarketError('stored-integrity');
  }
  const bytes = await readBounded(object.body, asset.size);
  await checkJson(bytes, asset, validateJson);
  return { bytes, etag: object.httpEtag, uploaded: object.uploaded };
}

/** Publish an immutable file once. A competing put cannot replace its bytes.
 *  R2 verifies sha256 before commit; FixedLengthStream rejects both a short
 *  and an oversized body, including a missing or dishonest Content-Length.
 *  JSON adapters are validated before upload, so they use the bounded buffer.
 */
export async function mirrorAsset(env: Env, base: string, asset: MarketAsset, type: string,
  validateJson?: (value: unknown) => boolean, beforeTransfer?: (size: number) => void): Promise<void> {
  if (validateJson) jsonSize(asset);
  const key = asset.url.slice(1);
  const previous = await env.DL.head(key);
  if (previous) {
    if (!(validateJson ? storedJsonMetadata(previous, asset) : storedAsset(previous, asset)))
      throw new PetMarketError('stored-integrity');
    if (validateJson) await readStoredJson(env, asset, validateJson);
    return;
  }
  beforeTransfer?.(asset.size);
  const response = await upstream(base, asset.url.slice('/market/'.length), asset.size, asset.size);
  const options: R2PutOptions = {
    onlyIf: new Headers({ 'If-None-Match': '*' }),
    sha256: Uint8Array.from(asset.sha256.match(/../g)!, b => parseInt(b, 16)).buffer,
    httpMetadata: { contentType: type, cacheControl: 'public, max-age=300' },
  };
  let result: R2Object | null;
  if (validateJson) {
    const bytes = await readBounded(response.body!, asset.size);
    await checkJson(bytes, asset, validateJson);
    result = await env.DL.put(key, bytes, options);
  } else {
    const length = new FixedLengthStream(asset.size);
    const reader = response.body!.getReader();
    const writer = length.writable.getWriter();
    let ended = false;
    const stop = () => {
      if (ended) return;
      // Cancel through the owned reader even if a write is backpressured.
      // pipeTo(signal) alone can wait for that pending write before canceling.
      void reader.cancel().catch(() => {});
      void writer.abort().catch(() => {});
      cancel(length.readable);
    };
    const pump = (async () => {
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          await writer.write(value);
        }
        await writer.close();
      } catch (error) { stop(); throw error; }
      finally { ended = true; reader.releaseLock(); writer.releaseLock(); }
    })();
    // Attach immediately: stream failure may win the race with R2.put.
    void pump.catch(() => {});
    try {
      result = await env.DL.put(key, length.readable, options);
      if (!result) stop();
      else await pump;
    } finally {
      // On a rejected conditional put the readable might never be consumed.
      // Aborting the pump cancels upstream and settles its rejected promise.
      stop();
    }
  }
  if (!result) {
    const winner = await env.DL.head(key);
    if (!(validateJson ? storedJsonMetadata(winner, asset) : storedAsset(winner, asset)))
      throw new PetMarketError('asset-race');
    if (validateJson) await readStoredJson(env, asset, validateJson);
  }
}
