// The same strict JSON, ZIP and Unicode alias boundary as PetPackValidator.
// Nothing from an archive is executed or extracted to a filesystem.
import { inflateRawSync, inflateSync } from 'node:zlib';
import { UNICODE_DATA } from './generated/workshop-data';
import { EXPANDED_CAP, UPLOAD_CAP, WorkshopError, requireWorkshop as need } from './workshop-common';

const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
export function strictJson(bytes: Uint8Array, cap = 262144, depthCap = 64): unknown {
  need(bytes.length <= cap, 'pack_size');
  need(!(bytes[0] === 239 && bytes[1] === 187 && bytes[2] === 191), 'json_bom');
  let source: string;
  try { source = decoder.decode(bytes); } catch { throw new WorkshopError('json_utf8'); }
  let at = 0;
  const whitespace = () => { while (/[\x20\t\n\r]/.test(source[at] ?? '\0')) at++; };
  const take = (c: string) => { whitespace(); if (source[at] !== c) return false; at++; return true; };
  function string(): string {
    whitespace(); need(source[at] === '"', 'json_syntax');
    const start = at++;
    while (at < source.length) {
      const c = source[at++];
      if (c === '\\') at++;
      else if (c === '"') {
        let value: string;
        try { value = JSON.parse(source.slice(start, at)); } catch { throw new WorkshopError('json_syntax'); }
        need(!/[\ud800-\udfff]/u.test(value), 'json_unicode');
        return value;
      }
    }
    throw new WorkshopError('json_syntax');
  }
  function value(depth: number): unknown {
    need(depth <= depthCap, 'json_depth'); whitespace();
    if (source[at] === '"') return string();
    if (take('{')) {
      const object: Record<string, unknown> = Object.create(null);
      if (take('}')) return object;
      do { need(depth + 1 <= depthCap, 'json_depth'); const key = string();
        need(!Object.hasOwn(object, key), 'json_duplicate_key'); need(take(':'), 'json_syntax'); object[key] = value(depth + 1);
      } while (take(','));
      need(take('}'), 'json_syntax'); return object;
    }
    if (take('[')) {
      const list: unknown[] = []; if (take(']')) return list;
      do { list.push(value(depth + 1)); } while (take(',')); need(take(']'), 'json_syntax'); return list;
    }
    for (const [name, result] of [['true', true], ['false', false], ['null', null]] as const) {
      if (source.startsWith(name, at)) { at += name.length; return result; }
    }
    const m = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/.exec(source.slice(at));
    need(m, 'json_syntax'); at += m[0].length; const n = Number(m[0]); need(Number.isFinite(n), 'json_number'); return n;
  }
  const result = value(0); whitespace(); need(at === source.length, 'json_syntax'); return result;
}

type Tables = [Record<string, number[]>, Record<string, number>, Record<string, number>, Record<string, number[]>];
let tables: Tables | undefined;
export function nameAlias(name: string): string {
  tables ??= JSON.parse(decoder.decode(inflateSync(Uint8Array.from(atob(UNICODE_DATA), c => c.charCodeAt(0)), { maxOutputLength: 200000 }))) as Tables;
  const [decomp, classes, combinations, folds] = tables;
  const decomposed: number[] = [];
  function decompose(cp: number): void {
    const syllable = cp - 0xac00;
    if (syllable >= 0 && syllable < 11172) {
      decomposed.push(0x1100 + Math.floor(syllable / 588), 0x1161 + Math.floor(syllable % 588 / 28));
      if (syllable % 28) decomposed.push(0x11a7 + syllable % 28);
    } else if (decomp[cp]) { for (const part of decomp[cp]!) decompose(part); }
    else decomposed.push(cp);
  }
  for (const c of name) decompose(c.codePointAt(0)!);
  const ordered: number[] = [], marks = new Map<number, number[]>();
  const flush = () => { for (const cc of [...marks.keys()].sort((a, b) => a - b)) for (const cp of marks.get(cc)!) ordered.push(cp); marks.clear(); };
  for (const cp of decomposed) { const cc = classes[cp] ?? 0; if (!cc) { flush(); ordered.push(cp); } else { if (!marks.has(cc)) marks.set(cc, []); marks.get(cc)!.push(cp); } }
  flush();
  const composed: number[] = []; let starter = -1, previousClass = 0;
  function compose(a: number, b: number): number | undefined {
    const l = a - 0x1100, v = b - 0x1161;
    if (l >= 0 && l < 19 && v >= 0 && v < 21) return 0xac00 + (l * 21 + v) * 28;
    const s = a - 0xac00, t = b - 0x11a7;
    if (s >= 0 && s < 11172 && s % 28 === 0 && t > 0 && t < 28) return a + t;
    return combinations[`${a},${b}`];
  }
  for (const cp of ordered) {
    const cc = classes[cp] ?? 0, replacement = starter >= 0 && (!previousClass || previousClass < cc) ? compose(composed[starter]!, cp) : undefined;
    if (replacement !== undefined) composed[starter] = replacement;
    else { if (!cc) starter = composed.length; composed.push(cp); previousClass = cc; }
  }
  return composed.map(cp => (folds[cp] ?? [cp]).map(n => String.fromCodePoint(n)).join('')).join('');
}

const crcTable = Uint32Array.from({ length: 256 }, (_, value) => {
  for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});
export function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff; for (const b of bytes) crc = crcTable[(crc ^ b) & 255]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
export function inflate(bytes: Uint8Array, cap: number): Uint8Array {
  try {
    const value = inflateRawSync(bytes, { maxOutputLength: Math.max(1, cap), info: true });
    need(value.buffer.length <= cap, 'inflate_size');
    need(value.engine.bytesWritten === bytes.length, 'inflate_trailing');
    return value.buffer;
  } catch (error) { if (error instanceof WorkshopError) throw error; throw new WorkshopError('inflate_invalid'); }
}
export function zlib(bytes: Uint8Array, cap: number): Uint8Array {
  need(bytes.length >= 6 && (bytes[0]! & 15) === 8 && bytes[0]! >> 4 <= 7 &&
    (bytes[0]! * 256 + bytes[1]!) % 31 === 0 && !(bytes[1]! & 32), 'zlib_header');
  const out = inflate(bytes.subarray(2, bytes.length - 4), cap);
  let a = 1, b = 0;
  for (let at = 0; at < out.length; at += 5552) {
    for (let i = at; i < Math.min(at + 5552, out.length); i++) { a += out[i]!; b += a; }
    a %= 65521; b %= 65521;
  }
  need(((b << 16 | a) >>> 0) === new DataView(bytes.buffer, bytes.byteOffset, bytes.length).getUint32(bytes.length - 4), 'zlib_adler');
  return out;
}

interface Member { name: string; start: number; packed: number; size: number; method: number; crc: number }
const cp437 = 'ÇüéâäàåçêëèïîìÄÅÉæÆôöòûùÿÖÜ¢£¥₧ƒáíóúñÑªº¿⌐¬½¼¡«»░▒▓│┤╡╢╖╕╣║╗╝╜╛┐└┴┬├─┼╞╟╚╔╩╦╠═╬╧╨╤╥╙╘╒╓╫╪┘┌█▄▌▐▀αßΓπΣσµτΦΘΩδ∞φε∩≡±≥≤⌠⌡÷≈°∙·√ⁿ²■ ';
export class WorkshopArchive {
  readonly files = new Map<string, Member>();
  readonly directories = new Set<string>();
  constructor(private readonly bytes: Uint8Array, entriesCap: number) {
    need(bytes.length >= 22 && bytes.length <= UPLOAD_CAP, 'archive_size');
    const data = new DataView(bytes.buffer, bytes.byteOffset, bytes.length);
    let end = bytes.length - 22;
    while (end >= Math.max(0, bytes.length - 65557) && (data.getUint32(end, true) !== 0x06054b50 || end + 22 + data.getUint16(end + 20, true) !== bytes.length)) end--;
    need(end >= 0 && end >= bytes.length - 65557, 'archive_directory');
    const count = data.getUint16(end + 10, true), centralSize = data.getUint32(end + 12, true), central = data.getUint32(end + 16, true);
    need(data.getUint16(end + 4, true) === 0 && data.getUint16(end + 6, true) === 0 && data.getUint16(end + 8, true) === count, 'archive_multidisk');
    need(count > 0 && count <= entriesCap, 'archive_entries');
    need(central + centralSize === end, 'archive_directory');
    let at = central, expanded = 0;
    const aliases = new Set<string>(), spans: { offset: number; end: number }[] = [];
    for (let i = 0; i < count; i++) {
      need(at + 46 <= end && data.getUint32(at, true) === 0x02014b50, 'archive_directory');
      const flags = data.getUint16(at + 8, true), method = data.getUint16(at + 10, true), crc = data.getUint32(at + 16, true);
      const packed = data.getUint32(at + 20, true), size = data.getUint32(at + 24, true), nameLength = data.getUint16(at + 28, true);
      const extra = data.getUint16(at + 30, true), comment = data.getUint16(at + 32, true), offset = data.getUint32(at + 42, true);
      need(at + 46 + nameLength + extra + comment <= end && data.getUint16(at + 34, true) === 0, 'archive_directory');
      const raw = bytes.subarray(at + 46, at + 46 + nameLength);
      let name: string;
      try { name = flags & 0x800 ? decoder.decode(raw) : Array.from(raw, b => b < 128 ? String.fromCharCode(b) : cp437[b - 128]!).join(''); }
      catch { throw new WorkshopError('archive_name'); }
      need(name.length > 0 && !name.startsWith('/') && !/[\\\0]/.test(name) &&
        name.replace(/\/+$/, '').split('/').every(p => p && p !== '.' && p !== '..' && !p.includes(':')), 'archive_path');
      const alias = nameAlias(name); need(!aliases.has(alias), 'archive_duplicate'); aliases.add(alias);
      const directory = name.endsWith('/'), type = data.getUint32(at + 38, true) >>> 16 & 0xf000;
      need(type === 0 || type === (directory ? 0x4000 : 0x8000), 'archive_type');
      need(!(flags & 0x61) && (method === 0 || method === 8), 'archive_encoding');
      need(size <= EXPANDED_CAP - expanded, 'archive_expanded_size'); expanded += size;
      need(offset + 30 <= central && data.getUint32(offset, true) === 0x04034b50, 'archive_header');
      const localName = data.getUint16(offset + 26, true), localExtra = data.getUint16(offset + 28, true), start = offset + 30 + localName + localExtra;
      need(data.getUint16(offset + 6, true) === flags && data.getUint16(offset + 8, true) === method &&
        localName === nameLength && start + packed <= central, 'archive_member_range');
      need(raw.every((b, n) => bytes[offset + 30 + n] === b), 'archive_local_name');
      spans.push({ offset, end: start + packed });
      if (!directory) this.files.set(name, { name, start, packed, size, method, crc });
      else {
        // A directory may not hide an unvalidated payload in an otherwise
        // clean public ZIP. Ordinary empty stored/deflated directories work.
        need(size === 0 && crc === 0, 'archive_directory_payload');
        const content = bytes.subarray(start, start + packed);
        need((method === 0 ? content : inflate(content, 0)).length === 0, 'archive_directory_payload');
        this.directories.add(name);
      }
      at += 46 + nameLength + extra + comment;
    }
    need(at === end, 'archive_directory'); spans.sort((a, b) => a.offset - b.offset);
    for (let i = 1; i < spans.length; i++) need(spans[i - 1]!.offset < spans[i]!.offset && spans[i - 1]!.end <= spans[i]!.offset, 'archive_overlap');
  }
  read(name: string, cap: number): Uint8Array {
    const file = this.files.get(name); need(file, 'archive_member_missing'); need(file.size <= cap, 'archive_member_size');
    const bytes = this.bytes.subarray(file.start, file.start + file.packed), out = file.method === 0 ? bytes : inflate(bytes, file.size);
    need(out.length === file.size, 'archive_member_size'); need(crc32(out) === file.crc, 'archive_member_crc'); return out;
  }
}
