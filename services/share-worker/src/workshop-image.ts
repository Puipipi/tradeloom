// Preview policy only: this does not change which companion packages upload.
// PNG uses the existing complete decoder. JPEG/WebP are bounded structural
// checks; the browser still has to decode them and may reject their bitstream.
// JPEG: ITU-T T.81 Annex B, https://www.w3.org/Graphics/JPEG/itu-t81.pdf
// WebP: https://developers.google.com/speed/webp/docs/riff_container
// VP8: RFC6386 section 9.1; VP8L: Google's lossless bitstream specification.
import { PET_LIMITS } from './generated/workshop-data';
import { requireWorkshop as need, WorkshopError } from './workshop-common';
import { validatePng } from './workshop-png';

export interface PreviewInfo {
  mediaType: 'image/png' | 'image/jpeg' | 'image/webp';
  width: number; height: number; validation: 'full-png' | 'structure-only';
}
export const isPreviewImage = (path: string) => /\.(png|jpe?g|webp)$/i.test(path);
function dimensions(width: number, height: number): void {
  need(width > 0 && height > 0 && width <= PET_LIMITS.sheetSide && height <= PET_LIMITS.sheetSide &&
    width * height * 4 <= PET_LIMITS.sheetDecodedBytes, 'preview_dimensions');
}
export function previewImage(bytes: Uint8Array, path: string): PreviewInfo {
  need(bytes.length > 0 && bytes.length <= PET_LIMITS.sheetBytes, 'preview_size');
  if (/\.png$/i.test(path)) {
    // validatePng checks CRC, metadata, the complete compressed stream and all
    // pixels; it also rejects acTL/fcTL/fdAT rather than showing an APNG frame.
    const { width, height } = validatePng(bytes);
    return { mediaType: 'image/png', width, height, validation: 'full-png' };
  }
  const size = /\.jpe?g$/i.test(path) ? jpeg(bytes) : /\.webp$/i.test(path) ? webp(bytes) : null;
  need(size, 'preview_unsupported'); dimensions(size.width, size.height);
  return { mediaType: /\.webp$/i.test(path) ? 'image/webp' : 'image/jpeg', ...size, validation: 'structure-only' };
}

function jpeg(bytes: Uint8Array): { width: number; height: number } {
  need(bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8, 'preview_format');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.length);
  let at = 2, frame: { width: number; height: number } | undefined, frameMarker = 0, scan = false, sawScan = false;
  const components = new Set<number>();
  while (at < bytes.length) {
    // Entropy bytes are not decoded. Scan through byte stuffing/restart
    // markers to the next marker, then check every segment's declared span.
    if (scan && bytes[at] !== 0xff) { at++; continue; }
    need(bytes[at++] === 0xff, 'preview_format');
    while (at < bytes.length && bytes[at] === 0xff) at++;
    need(at < bytes.length, 'preview_format'); const marker = bytes[at++]!;
    if (scan && (marker === 0 || marker >= 0xd0 && marker <= 0xd7)) continue;
    scan = false;
    if (marker === 0xd9) {
      need(frame && sawScan && at === bytes.length, 'preview_format'); return frame;
    }
    need(marker !== 0xd8 && marker !== 0 && !(marker >= 0xd0 && marker <= 0xd7), 'preview_format');
    // The preview supports ordinary 8-bit Huffman sequential/progressive JPEG,
    // not hierarchical/lossless/arithmetic modes or deferred-height DNL.
    need([0xc0, 0xc1, 0xc2, 0xc4, 0xda, 0xdb, 0xdd, 0xfe].includes(marker) ||
      marker >= 0xe0 && marker <= 0xef, 'preview_unsupported');
    need(at + 2 <= bytes.length, 'preview_format');
    const length = view.getUint16(at), end = at + length;
    need(length >= 2 && end <= bytes.length, 'preview_format');
    if (marker === 0xc0 || marker === 0xc1 || marker === 0xc2) {
      need(!frame && length >= 11, 'preview_format');
      const count = bytes[at + 7]!;
      need(bytes[at + 2] === 8 && count >= 1 && count <= 4 && length === 8 + count * 3, 'preview_unsupported');
      frame = { width: view.getUint16(at + 5), height: view.getUint16(at + 3) }; dimensions(frame.width, frame.height); frameMarker = marker;
      for (let i = 0; i < count; i++) {
        const offset = at + 8 + i * 3, component = bytes[offset]!, sampling = bytes[offset + 1]!;
        need(!components.has(component) && sampling >> 4 >= 1 && sampling >> 4 <= 4 &&
          (sampling & 15) >= 1 && (sampling & 15) <= 4 && bytes[offset + 2]! <= 3, 'preview_format');
        components.add(component);
      }
    } else if (marker === 0xda) {
      const count = bytes[at + 2]!;
      need(frame && count >= 1 && count <= components.size && length === 6 + count * 2, 'preview_format');
      const selected = new Set<number>();
      for (let i = 0; i < count; i++) {
        const component = bytes[at + 3 + i * 2]!, table = bytes[at + 4 + i * 2]!;
        need(components.has(component) && !selected.has(component) && table >> 4 <= 3 && (table & 15) <= 3, 'preview_format'); selected.add(component);
      }
      const first = bytes[end - 3]!, last = bytes[end - 2]!, approximation = bytes[end - 1]!;
      need(frameMarker === 0xc2 ? first <= last && last <= 63 && approximation >> 4 <= 13 && (approximation & 15) <= 13 :
        first === 0 && last === 63 && approximation === 0, 'preview_format');
      sawScan = true; scan = true;
    } else if (marker === 0xdd) need(length === 4, 'preview_format');
    at = end;
  }
  throw new WorkshopError('preview_format');
}

function webp(bytes: Uint8Array): { width: number; height: number } {
  const fourcc = (at: number) => String.fromCharCode(...bytes.subarray(at, at + 4));
  need(bytes.length >= 20 && fourcc(0) === 'RIFF' && fourcc(8) === 'WEBP', 'preview_format');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.length);
  need(view.getUint32(4, true) === bytes.length - 8, 'preview_format');
  const uint24 = (at: number) => bytes[at]! | bytes[at + 1]! << 8 | bytes[at + 2]! << 16;
  let at = 12, flags: number | undefined, canvas: { width: number; height: number } | undefined;
  let image: { width: number; height: number } | undefined, encoding = '', alpha = false, profile = false, exif = false, xmp = false;
  while (at < bytes.length) {
    need(at + 8 <= bytes.length, 'preview_format');
    const type = fourcc(at), length = view.getUint32(at + 4, true), start = at + 8, end = start + length;
    need(end + (length & 1) <= bytes.length && (!(length & 1) || bytes[end] === 0), 'preview_format');
    need(type !== 'ANIM' && type !== 'ANMF', 'preview_animated');
    if (type === 'VP8X') {
      need(at === 12 && flags === undefined && length === 10, 'preview_format'); flags = bytes[start]!;
      need(!(flags & 2), 'preview_animated');
      need(!(flags & 0xc1) && uint24(start + 1) === 0, 'preview_unsupported');
      canvas = { width: uint24(start + 4) + 1, height: uint24(start + 7) + 1 }; dimensions(canvas.width, canvas.height);
    } else if (type === 'VP8 ' || type === 'VP8L') {
      need(!image, 'preview_format'); encoding = type;
      if (type === 'VP8 ') {
        need(length > 10 && !(bytes[start]! & 1) && (bytes[start]! >> 1 & 7) <= 3 && (bytes[start]! & 16) !== 0 &&
          bytes[start + 3] === 0x9d && bytes[start + 4] === 0x01 && bytes[start + 5] === 0x2a, 'preview_format');
        const partition = uint24(start) >>> 5;
        need(partition > 0 && partition <= length - 10, 'preview_format');
        // WebP uses the key-frame dimensions directly; scaled VP8 video is
        // outside this still-image preview policy.
        need(!(view.getUint16(start + 6, true) & 0xc000) && !(view.getUint16(start + 8, true) & 0xc000), 'preview_unsupported');
        image = { width: view.getUint16(start + 6, true), height: view.getUint16(start + 8, true) };
      } else {
        need(!alpha && length > 5 && bytes[start] === 0x2f, 'preview_format');
        const bits = view.getUint32(start + 1, true); need(bits >>> 29 === 0, 'preview_unsupported');
        image = { width: (bits & 0x3fff) + 1, height: (bits >>> 14 & 0x3fff) + 1 };
      }
      dimensions(image.width, image.height);
    } else if (type === 'ALPH') {
      need(flags !== undefined && (flags & 16) !== 0 && !image && !alpha && length > 1, 'preview_format');
      need((bytes[start]! & 0xc0) === 0 && (bytes[start]! >> 4 & 3) <= 1 && (bytes[start]! & 3) <= 1, 'preview_unsupported');
      if ((bytes[start]! & 3) === 0) need(canvas && length === 1 + canvas.width * canvas.height, 'preview_format');
      alpha = true;
    } else if (type === 'ICCP') {
      need(flags !== undefined && !image && !alpha && !profile && length > 0, 'preview_format'); profile = true;
    } else if (type === 'EXIF') {
      need(flags !== undefined && !exif && length > 0, 'preview_format'); exif = true;
    } else if (type === 'XMP ') {
      need(flags !== undefined && !xmp && length > 0, 'preview_format'); xmp = true;
    } else throw new WorkshopError('preview_unsupported');
    at = end + (length & 1);
  }
  need(image && at === bytes.length, 'preview_format');
  if (canvas) {
    need(canvas.width === image.width && canvas.height === image.height, 'preview_dimensions');
    need(!!(flags! & 32) === profile && !!(flags! & 8) === exif && !!(flags! & 4) === xmp &&
      (!(flags! & 16) || alpha || encoding === 'VP8L'), 'preview_format');
  }
  return image;
}
