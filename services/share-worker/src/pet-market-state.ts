// One durable CAS object is the publication point: the public catalogue and
// every successfully published identity/version binding advance together.
import type { Env } from './env';
import {
  type Catalog, type CatalogKind, type PetEntry, type AdapterEntry, INDEX_CAP,
  ZIP_CAP, PREVIEW_CAP, ADAPTER_CAP, entries, entryId, record, validatePetCatalog,
  validPetId, validMoc, validVersion, validAsset,
} from './pet-catalog';
import { PetMarketError, readBounded, type MarketAsset } from './pet-market-io';

export const PUBLICATION_CAP = 8 * 1024 * 1024;
export const RELEASE_LIMIT = 10_000;
export const publicationKey = (kind: CatalogKind) => `market/_publication-v1/${kind}.json`;
interface PetBinding { id: string; version: string; artifact: MarketAsset; preview: { png: MarketAsset; gif: MarketAsset } }
interface AdapterBinding { moc: string; version: string; artifact: MarketAsset }
export type ReleaseBinding = PetBinding | AdapterBinding;
export interface CatalogText { text: string; catalog: Catalog }
export interface Publication extends CatalogText { etag: string; releases: ReleaseBinding[] }
const exactFields = (v: object, fields: string[]) => Object.keys(v).length === fields.length && Object.keys(v).every(k => fields.includes(k));
const assetCopy = (value: MarketAsset): MarketAsset => ({ url: value.url, sha256: value.sha256, size: value.size });
export function releaseBinding(entry: PetEntry | AdapterEntry): ReleaseBinding {
  return 'id' in entry
    ? { id: entry.id, version: entry.version, artifact: assetCopy(entry), preview: { png: assetCopy(entry.preview.png), gif: assetCopy(entry.preview.gif) } }
    : { moc: entry.moc, version: entry.version, artifact: assetCopy(entry) };
}
const bindingKey = (value: ReleaseBinding) => `${'id' in value ? value.id : value.moc}@${value.version}`;
const identity = (value: ReleaseBinding) => {
  const resources = 'id' in value ? [value.artifact, value.preview.png, value.preview.gif] : [value.artifact];
  return JSON.stringify(resources.map(a => [a.url, a.sha256, a.size]));
};
function validBinding(value: unknown, kind: CatalogKind): value is ReleaseBinding {
  if (!record(value) || !validVersion(value.version)) return false;
  const asset = (v: unknown, prefix: string, extension: string, cap: number) =>
    record(v) && exactFields(v, ['url', 'sha256', 'size']) && validAsset(v, prefix, extension, cap);
  if (kind === 'pets') {
    if (!exactFields(value, ['id', 'version', 'artifact', 'preview']) || !validPetId(value.id) ||
        !record(value.preview) || !exactFields(value.preview, ['png', 'gif'])) return false;
    const prefix = `/market/pets/${value.id}/${value.version}/`;
    return asset(value.artifact, prefix, 'zip', ZIP_CAP) && asset(value.preview.png, prefix, 'png', PREVIEW_CAP) &&
      asset(value.preview.gif, prefix, 'gif', PREVIEW_CAP);
  }
  return exactFields(value, ['moc', 'version', 'artifact']) && validMoc(value.moc) &&
    asset(value.artifact, `/market/adapters/${value.moc}/`, 'json', ADAPTER_CAP);
}
function json(bytes: Uint8Array): unknown {
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes)); }
  catch { throw new PetMarketError('invalid-json'); }
}
export function parseCatalog(bytes: Uint8Array, kind: CatalogKind): CatalogText {
  let text: string;
  try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes); }
  catch { throw new PetMarketError('invalid-json'); }
  if (bytes.byteLength > INDEX_CAP) throw new PetMarketError('catalog-too-large');
  const catalog = json(bytes);
  if (!validatePetCatalog(catalog, kind)) throw new PetMarketError('invalid-catalog');
  return { text, catalog };
}
function parsePublication(bytes: Uint8Array, kind: CatalogKind, etag: string): Publication {
  const state = json(bytes);
  if (!record(state) || !exactFields(state, ['publication', 'kind', 'catalogText', 'releases']) ||
      state.publication !== 1 || state.kind !== kind || typeof state.catalogText !== 'string' ||
      !Array.isArray(state.releases) || state.releases.length > RELEASE_LIMIT)
    throw new PetMarketError('invalid-publication');
  const current = parseCatalog(new TextEncoder().encode(state.catalogText), kind);
  const history = new Map<string, ReleaseBinding>();
  for (const release of state.releases) {
    if (!validBinding(release, kind) || history.has(bindingKey(release))) throw new PetMarketError('invalid-release-history');
    history.set(bindingKey(release), release);
  }
  // A public row without the same durable binding is never usable, even on a
  // reader path. There is no reconstruction from the current row alone.
  for (const entry of entries(current.catalog)) {
    const release = history.get(`${entryId(entry)}@${entry.version}`);
    if (!release || identity(release) !== identity(releaseBinding(entry))) throw new PetMarketError('unbound-catalog');
  }
  return { ...current, etag, releases: [...history.values()] };
}
interface Verified { publication: Publication; size: number }
interface ReadSlot { verified?: Verified; pending?: Promise<Publication | null> }
// Two bounded envelopes per live Env, not a TTL authority cache. Every caller
// checks R2's current ETag. Waiters also do their own conditional read after
// the single in-flight body validation, so an intervening withdrawal is seen.
const verified = new WeakMap<Env, Map<CatalogKind, ReadSlot>>();
async function readCurrentPublication(env: Env, kind: CatalogKind, slot: ReadSlot): Promise<Publication | null> {
  const cached = slot.verified;
  const object = cached
    ? await env.DL.get(publicationKey(kind), { onlyIf: new Headers({ 'If-None-Match': cached.publication.etag }) })
    : await env.DL.get(publicationKey(kind));
  if (!object) {
    slot.verified = undefined;
    // R1's bare catalogue cannot prove earlier version bindings. Do not turn
    // its current entries into a fabricated complete history. Operators must
    // stop old publishers, resolve their in-flight/unknown writes, and restore
    // a verified full history or start a truly new namespace. A negative read
    // below cannot rule out an old bare-key PUT that has not committed yet;
    // this cross-key migration prerequisite is operational, not a CAS claim.
    if (await env.DL.head(`market/${kind}.json`)) throw new PetMarketError('history-migration-required');
    return null;
  }
  // An unmet R2 GET precondition returns metadata, not a 304/body. Only the
  // exact already-validated representation can use that result as authority.
  const body = (object as R2ObjectBody).body;
  if (!body) {
    if (!cached || object.httpEtag !== cached.publication.etag || object.size !== cached.size)
      throw new PetMarketError('publication-condition');
    return cached.publication;
  }
  if (object.size > PUBLICATION_CAP) {
    void body.cancel().catch(() => {});
    throw new PetMarketError('stored-publication-too-large');
  }
  const bytes = await readBounded(body, PUBLICATION_CAP);
  if (bytes.length !== object.size) throw new PetMarketError('stored-publication-size');
  const publication = parsePublication(bytes, kind, object.httpEtag);
  slot.verified = { publication, size: bytes.length };
  return publication;
}
export async function loadPublication(env: Env, kind: CatalogKind): Promise<Publication | null> {
  let kinds = verified.get(env);
  if (!kinds) verified.set(env, kinds = new Map());
  let slot = kinds.get(kind);
  if (!slot) kinds.set(kind, slot = {});
  while (slot.pending) await slot.pending;
  const current = slot;
  const pending = readCurrentPublication(env, kind, current).catch(error => {
    // Missing, unavailable and invalid current state can never authorize from
    // an old envelope. The separate public stale view remains browse-only.
    current.verified = undefined;
    throw error;
  });
  current.pending = pending;
  try { return await pending; }
  finally { if (current.pending === pending) current.pending = undefined; }
}
export function nextPublication(previous: Publication | null, candidate: CatalogText, kind: CatalogKind): string {
  const releases = previous ? [...previous.releases] : [];
  const known = new Map(releases.map(value => [bindingKey(value), value]));
  for (const entry of entries(candidate.catalog)) {
    const binding = releaseBinding(entry), key = bindingKey(binding), existing = known.get(key);
    if (existing && identity(existing) !== identity(binding)) throw new PetMarketError('version-rewritten');
    if (!existing) { releases.push(binding); known.set(key, binding); }
  }
  if (releases.length > RELEASE_LIMIT) throw new PetMarketError('release-history-full');
  // No pruning on upgrade, withdrawal, fallback or an absent current identity.
  const text = JSON.stringify({ publication: 1, kind, catalogText: candidate.text, releases });
  if (new TextEncoder().encode(text).byteLength > PUBLICATION_CAP) throw new PetMarketError('publication-too-large');
  return text;
}
