// A bounded private receipt for an ordered, partially verified asset sweep.
// This key is never a publication or download authorization point.
import type { Env } from './env';
import { type CatalogKind, record } from './pet-catalog';
import { digest, PetMarketError, readBounded } from './pet-market-io';
import { PET_MARKET_PROFILE } from './generated/pet-market-profile';

// Each asset uses at most four R2 operations (HEAD, PUT, winner HEAD, JSON
// GET). Two partitions therefore use at most 768 asset operations per cron;
// publication/checkpoint bookkeeping and plugin writes leave ample room below
// the Free plan's 1000 internal-operation limit, including a failed transfer.
export const STAGE_ASSETS = 96;
const STAGE_CAP = 4096;
export const stageKey = (kind: CatalogKind) => `market/_staging-v1/${kind}.json`;
interface StageIdentity {
  kind: CatalogKind; candidate: string; source: string; base: string | null; profile: string; total: number;
}
interface Receipt extends StageIdentity { stage: 1; cursor: number; nonce: string }
export interface Stage { identity: StageIdentity; cursor: number; etag: string | null }
const hashed = (v: unknown) => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
const same = (a: StageIdentity, b: StageIdentity) => a.kind === b.kind && a.candidate === b.candidate &&
  a.source === b.source && a.base === b.base && a.profile === b.profile && a.total === b.total;

function receipt(bytes: Uint8Array): Receipt {
  let value: unknown;
  try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes)); }
  catch { throw new PetMarketError('invalid-stage'); }
  const fields = ['stage', 'kind', 'candidate', 'source', 'base', 'profile', 'total', 'cursor', 'nonce'];
  if (!record(value) || Object.keys(value).length !== fields.length || Object.keys(value).some(k => !fields.includes(k)) ||
      value.stage !== 1 || !['pets', 'adapters'].includes(String(value.kind)) ||
      !hashed(value.candidate) || !hashed(value.source) || !hashed(value.profile) ||
      !(value.base === null || typeof value.base === 'string' && value.base.length > 0 && value.base.length <= 256) ||
      typeof value.total !== 'number' || !Number.isSafeInteger(value.total) || value.total < 0 || value.total > 3000 ||
      typeof value.cursor !== 'number' || !Number.isSafeInteger(value.cursor) || value.cursor < 0 || value.cursor > value.total ||
      typeof value.nonce !== 'string' || !/^[a-f0-9-]{36}$/.test(value.nonce))
    throw new PetMarketError('invalid-stage');
  return value as unknown as Receipt;
}

export async function resumeStage(env: Env, kind: CatalogKind, text: string, source: string,
  base: string | null, total: number): Promise<Stage> {
  const encode = new TextEncoder();
  const identity: StageIdentity = { kind, candidate: await digest(encode.encode(text)),
    source: await digest(encode.encode(source)), base, profile: PET_MARKET_PROFILE, total };
  const object = await env.DL.get(stageKey(kind));
  if (!object) return { identity, cursor: 0, etag: null };
  if (object.size > STAGE_CAP) {
    void object.body.cancel().catch(() => {});
    throw new PetMarketError('invalid-stage');
  }
  const bytes = await readBounded(object.body, STAGE_CAP);
  if (bytes.length !== object.size) throw new PetMarketError('invalid-stage');
  const prior = receipt(bytes);
  return { identity, cursor: same(prior, identity) ? prior.cursor : 0, etag: object.httpEtag };
}

export async function saveStage(env: Env, stage: Stage, cursor: number): Promise<void> {
  // A fresh nonce changes the content ETag even when a completed receipt is
  // claimed again. Two writers starting from one ETag cannot both win its CAS.
  const value: Receipt = { stage: 1, ...stage.identity, cursor, nonce: crypto.randomUUID() };
  const result = await env.DL.put(stageKey(stage.identity.kind), JSON.stringify(value), {
    onlyIf: new Headers(stage.etag ? { 'If-Match': stage.etag } : { 'If-None-Match': '*' }),
    httpMetadata: { contentType: 'application/json; charset=utf-8', cacheControl: 'no-store' },
  });
  if (!result) throw new PetMarketError('stage-conflict');
  stage.etag = result.httpEtag;
  stage.cursor = cursor;
}
