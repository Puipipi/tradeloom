// Wire contract shared with dsh-go-market's schema/pets-index.schema.json.
// This is metadata validation, not a model/probe or an image-content review.
import type { MarketAsset } from './pet-market-io';

export const INDEX_CAP = 2 * 1024 * 1024;
export const ZIP_CAP = 50 * 1024 * 1024;
export const PREVIEW_CAP = 4 * 1024 * 1024;
export const ADAPTER_CAP = 256 * 1024;
export type CatalogKind = 'pets' | 'adapters';
export interface Withdrawal { id?: string; moc?: string; version: string; reason: string }
interface Author { author: string; license: string; source: string; version: string; minApp: string }
export interface PetEntry extends MarketAsset, Author {
  id: string; title: { zh: string; en: string }; pixelArt: boolean;
  preview: { png: MarketAsset; gif: MarketAsset };
  risk: { level: 'low' | 'medium' | 'high'; flags: string[] };
  blockedVersions: string[];
}
export interface AdapterEntry extends MarketAsset, Author { moc: string }
export interface PetCatalog { schema: 1; generatedAt: string; pets: PetEntry[]; withdrawn: Withdrawal[] }
export interface AdapterCatalog { schema: 1; generatedAt: string; adapters: AdapterEntry[]; withdrawn: Withdrawal[] }
export type Catalog = PetCatalog | AdapterCatalog;
const HASH = /^[a-f0-9]{64}$/;
const ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const NUM = '(?:0|[1-9][0-9]*)';
const PRE = '(?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*)';
const VERSION = new RegExp(`^${NUM}\\.${NUM}\\.${NUM}(?:-${PRE}(?:\\.${PRE})*)?$`);
const LICENSES = new Set(['CC0-1.0', 'CC-BY-4.0', 'CC-BY-SA-4.0', 'MIT', 'Apache-2.0', 'BSD-2-Clause', 'BSD-3-Clause']);
export const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const fields = (v: object, allowed: string[]) => Object.keys(v).every(k => allowed.includes(k));
// Python 3.12 str.isspace (Unicode 15) is the producer's nonempty test.
const blank = /^[\u0009-\u000d\u001c-\u0020\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]*$/u;
const text = (v: unknown, max: number): v is string => typeof v === 'string' && !blank.test(v) && Array.from(v).length <= max && !/[\u0000-\u001f\ud800-\udfff]/u.test(v);
const hash = (v: unknown): v is string => typeof v === 'string' && HASH.test(v);
const id = (v: unknown): v is string => typeof v === 'string' && v.length <= 40 && ID.test(v) && !v.startsWith('user-');
const version = (v: unknown): v is string => typeof v === 'string' && v.length <= 80 && VERSION.test(v);
const finite = (v: unknown, min: number, max: number): v is number => typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max;
const integer = (v: unknown, max: number) => finite(v, 1, max) && Number.isSafeInteger(v);
const unique = (v: unknown, max: number, check: (x: unknown) => boolean): v is string[] =>
  Array.isArray(v) && v.length <= max && v.every(check) && new Set(v).size === v.length;

function asset(value: unknown, prefix: string, extension: string, cap: number): value is MarketAsset {
  return record(value) && hash(value.sha256) && integer(value.size, cap) && value.url === `${prefix}${value.sha256}.${extension}`;
}
function authored(v: Record<string, unknown>): boolean {
  if (!text(v.author, 256) || typeof v.license !== 'string' || !LICENSES.has(v.license) || !text(v.source, 2048) || !version(v.version) || !version(v.minApp)) return false;
  try { const url = new URL(v.source); return /^https:\/\/[^/\\]/.test(v.source) && url.protocol === 'https:' && !!url.hostname && !url.username && !url.password; }
  catch { return false; }
}
function instant(v: unknown): v is string {
  if (typeof v !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z$/.test(v) || !Number.isFinite(Date.parse(v))) return false;
  return new Date(v).toISOString() === (v.includes('.') ? v : v.replace('Z', '.000Z'));
}
function withdrawn(v: unknown, kind: CatalogKind): v is Withdrawal[] {
  if (!Array.isArray(v) || v.length > 4000) return false;
  const identity = kind === 'pets' ? 'id' : 'moc';
  const seen = new Set<string>();
  return v.every(row => {
    if (!record(row) || !fields(row, [identity, 'version', 'reason']) ||
        !(kind === 'pets' ? id(row.id) : hash(row.moc)) ||
        !version(row.version) || !text(row.reason, 1000)) return false;
    const key = `${row[identity]}@${row.version}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
export const withdrawalKey = (row: Withdrawal) => `${row.id ?? row.moc}@${row.version}`;
export const entries = (catalog: Catalog): (PetEntry | AdapterEntry)[] => 'pets' in catalog ? catalog.pets : catalog.adapters;
export const entryId = (entry: PetEntry | AdapterEntry) => 'id' in entry ? entry.id : entry.moc;
export const revoked = (catalog: Catalog, name: string, ver?: string) => catalog.withdrawn.some(w =>
  (w.id ?? w.moc) === name && (ver === undefined || w.version === ver));

export function validatePetCatalog(value: unknown, kind: CatalogKind): value is Catalog {
  if (!record(value) || !fields(value, ['schema', 'generatedAt', kind, 'withdrawn']) || value.schema !== 1 ||
      !instant(value.generatedAt) || !withdrawn(value.withdrawn, kind) ||
      !Array.isArray(value[kind]) || value[kind].length > 1000) return false;
  const seen = new Set<string>();
  for (const row of value[kind]) {
    if (!record(row) || !authored(row)) return false;
    const name = kind === 'pets' ? row.id : row.moc;
    if (typeof name !== 'string' || seen.has(name)) return false;
    seen.add(name);
    if (value.withdrawn.some(w => (w.id ?? w.moc) === name && w.version === row.version)) return false;
    if (kind === 'pets') {
      if (!fields(row, ['id', 'title', 'author', 'license', 'source', 'version', 'minApp', 'url', 'sha256', 'size',
        'preview', 'pixelArt', 'risk', 'blockedVersions']) || !id(row.id)) return false;
      const prefix = `/market/pets/${row.id}/${row.version}/`;
      if (!asset(row, prefix, 'zip', ZIP_CAP) || !record(row.title) || !fields(row.title, ['zh', 'en']) ||
          !text(row.title.zh, 120) || !text(row.title.en, 120) || typeof row.pixelArt !== 'boolean' ||
          !record(row.preview) || !fields(row.preview, ['png', 'gif']) ||
          !asset(row.preview.png, prefix, 'png', PREVIEW_CAP) || !fields(row.preview.png, ['url', 'sha256', 'size']) ||
          !asset(row.preview.gif, prefix, 'gif', PREVIEW_CAP) || !fields(row.preview.gif, ['url', 'sha256', 'size']) ||
          !record(row.risk) || !fields(row.risk, ['level', 'flags']) || row.risk.level !== 'low' ||
          !unique(row.risk.flags, 2, x => x === 'data-only' || x === 'maintainer-reviewed') || row.risk.flags.length !== 2 ||
          !unique(row.blockedVersions, 1000, version) || row.blockedVersions.includes(String(row.version))) return false;
    } else if (!fields(row, ['moc', 'author', 'license', 'source', 'version', 'minApp', 'url', 'sha256', 'size']) ||
      !hash(row.moc) || !asset(row, `/market/adapters/${row.moc}/`, 'json', ADAPTER_CAP)) return false;
  }
  return true;
}

// Publication profile for c76 companion_adapt.dart / stage.js, not the old
// C700 proposal's arbitrary semantic names or unimplemented toggles. This is
// structural validation: only a model probe can validate target IDs and ranges.
const PARAMS = new Set('ParamAngleX ParamAngleY ParamAngleZ ParamBodyAngleX ParamBodyAngleY ParamBodyAngleZ ParamBreath ParamEyeLOpen ParamEyeROpen ParamEyeBallX ParamEyeBallY ParamEyeSmile ParamMouthOpenY ParamMouthForm ParamBrowLY ParamBrowRY ParamBrowLAngle ParamBrowRAngle'.split(' '));
const EMOTIONS = new Set('calm happy shy sad angry surprised confused smug sleepy worried'.split(' '));
const ACTIONS = new Set('nod nodSmall shake tilt tiltLeft lookUp recoil duck sway stretch yawn wave'.split(' '));
const ZONES = new Set('head face body tail legs'.split(' '));
const parameter = (v: unknown): v is string => text(v, 160);
function table(v: unknown, check: (value: unknown, key: string) => boolean): boolean {
  return record(v) && Object.entries(v).every(([k, value]) => parameter(k) && check(value, k));
}
const identifiers = (v: unknown) => Array.isArray(v) && v.every(parameter);
export function validateAdapter(value: unknown, moc: string): boolean {
  if (!record(value) || !fields(value, ['adapter', 'moc', 'params', 'emotions', 'actions', 'zones', 'framing', 'tail', 'pose', 'notes']) ||
      value.adapter !== 1 || value.moc !== moc || !hash(value.moc)) return false;
  if (value.params !== undefined && !table(value.params, (v, k) => PARAMS.has(k) && record(v) && fields(v, ['id', 'scale', 'offset']) &&
      (parameter(v.id) || Array.isArray(v.id) && v.id.length > 0 && identifiers(v.id)) &&
      (v.scale === undefined || finite(v.scale, -1000, 1000) && v.scale !== 0) &&
      (v.offset === undefined || finite(v.offset, -1000, 1000)))) return false;
  if (value.emotions !== undefined && !table(value.emotions, (v, k) => EMOTIONS.has(k) && record(v) && fields(v, ['expression', 'face']) &&
      (v.expression === undefined || parameter(v.expression)) &&
      (v.face === undefined || table(v.face, n => finite(n, -1000, 1000))))) return false;
  if (value.actions !== undefined && !table(value.actions, (v, k) => ACTIONS.has(k) && record(v) && fields(v, ['motion']) && parameter(v.motion))) return false;
  if (value.zones !== undefined && (!Array.isArray(value.zones) || value.zones.some(z =>
    !record(z) || !fields(z, ['id', 'from', 'to', 'xFrom', 'xTo']) || typeof z.id !== 'string' || !ZONES.has(z.id) ||
    !finite(z.from, 0, 1) || !finite(z.to, 0, 1) || z.from >= z.to ||
    (z.xFrom !== undefined && !finite(z.xFrom, -1.5, 1.5)) || (z.xTo !== undefined && !finite(z.xTo, -1.5, 1.5)) ||
    (typeof z.xFrom === 'number' && typeof z.xTo === 'number' && z.xFrom >= z.xTo)))) return false;
  if (value.framing !== undefined && (!record(value.framing) || !fields(value.framing, ['zoom', 'y']) ||
      (value.framing.zoom !== undefined && !finite(value.framing.zoom, 0.3, 3)) ||
      (value.framing.y !== undefined && !finite(value.framing.y, -1, 1)))) return false;
  if (value.tail !== undefined && !identifiers(value.tail)) return false;
  if (value.pose !== undefined && !table(value.pose, n => finite(n, -1000, 1000))) return false;
  return value.notes === undefined || text(value.notes, 4000);
}

// The persistent publication ledger uses exactly the public resource grammar.
export { id as validPetId, hash as validMoc, version as validVersion, asset as validAsset };
