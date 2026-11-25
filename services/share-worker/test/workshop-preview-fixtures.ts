// Small original PNGs with independent expected RGBA pixels. The writer can
// exercise every accepted PNG color/depth pair, Adam7 and all five row filters.
import { deflateSync } from 'node:zlib';
import { crc32 } from '../src/workshop-archive';

export const PNG_FORMS = [[0, 1], [0, 2], [0, 4], [0, 8], [0, 16], [2, 8], [2, 16],
  [3, 1], [3, 2], [3, 4], [3, 8], [4, 8], [4, 16], [6, 8], [6, 16]] as const;
const ADAM7 = [[0, 0, 8, 8], [4, 0, 8, 8], [0, 4, 4, 8], [2, 0, 4, 4], [0, 2, 2, 4], [1, 0, 2, 2], [0, 1, 1, 2]] as const;
export function previewChunk(type: string, data: Uint8Array): Buffer {
  const output = Buffer.alloc(data.length + 12); output.writeUInt32BE(data.length); output.write(type, 4, 'ascii');
  output.set(data, 8); output.writeUInt32BE(crc32(output.subarray(4, 8 + data.length)), 8 + data.length); return output;
}
export function samplePng(color: number, depth: number, interlaced: boolean, filter = 0) {
  const width = 9, height = 7, channels = ({ 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 } as Record<number, number>)[color]!;
  const max = 2 ** depth - 1, palette = [[220, 10, 30], [2, 170, 90], [5, 40, 230], [250, 210, 3]].slice(0, color === 3 ? Math.min(4, 2 ** depth) : 4);
  const alphas = [255, 0, 127, 255], transparent = depth === 16 ? 0x1234 : max;
  const samples = (x: number, y: number): number[] => {
    if (color === 3) return [(x + 3 * y) % palette.length];
    const first = x === 0 && y === 0 ? transparent : x === 1 && y === 0 && depth === 16 ? transparent + 1 : (x * 311 + y * 719) % (max + 1);
    if (color === 0) return [first];
    if (color === 4) return [first, max - (x * 5 + y * 17) % (max + 1)];
    const rgb = [first, (first + 13) % (max + 1), (first + 29) % (max + 1)];
    return color === 6 ? [...rgb, max - (x * 5 + y * 17) % (max + 1)] : rgb;
  };
  const transparentRgb = samples(0, 0).slice(0, 3);
  const expected = new Uint8Array(width * height * 4), toByte = (n: number) => depth === 16 ? n >>> 8 : Math.round(n * 255 / max);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const s = samples(x, y); let rgba: number[];
    if (color === 3) rgba = [...palette[s[0]!]!, alphas[s[0]!]!];
    else if (color === 0 || color === 4) rgba = [toByte(s[0]!), toByte(s[0]!), toByte(s[0]!), color === 4 ? toByte(s[1]!) : s[0] === transparent ? 0 : 255];
    else rgba = [...s.slice(0, 3).map(toByte), color === 6 ? toByte(s[3]!) : s.slice(0, 3).every((n, i) => n === transparentRgb[i]) ? 0 : 255];
    expected.set(rgba, (y * width + x) * 4);
  }
  const rows: Buffer[] = [], bpp = Math.max(1, Math.ceil(channels * depth / 8));
  for (const [startX, startY, dx, dy] of interlaced ? ADAM7 : [[0, 0, 1, 1]] as const) {
    const passWidth = Math.max(0, Math.ceil((width - startX) / dx)), passHeight = Math.max(0, Math.ceil((height - startY) / dy));
    if (!passWidth || !passHeight) continue;
    let previous = Buffer.alloc(Math.ceil(passWidth * channels * depth / 8));
    for (let y = 0; y < passHeight; y++) {
      const row = Buffer.alloc(previous.length);
      for (let x = 0; x < passWidth; x++) for (const [c, sample] of samples(startX + x * dx, startY + y * dy).entries()) {
        const i = x * channels + c;
        if (depth === 16) row.writeUInt16BE(sample, i * 2);
        else if (depth === 8) row[i] = sample;
        else row[i * depth >> 3] |= sample << (8 - depth - i * depth % 8);
      }
      const filtered = Buffer.alloc(row.length + 1); filtered[0] = filter;
      for (let i = 0; i < row.length; i++) {
        const a = i < bpp ? 0 : row[i - bpp]!, b = previous[i]!, c = i < bpp ? 0 : previous[i - bpp]!;
        const p = a + b - c, distances = [Math.abs(p - a), Math.abs(p - b), Math.abs(p - c)];
        const predictor = filter === 0 ? 0 : filter === 1 ? a : filter === 2 ? b : filter === 3 ? Math.floor((a + b) / 2) : [a, b, c][distances.indexOf(Math.min(...distances))]!;
        filtered[i + 1] = (row[i]! - predictor) & 255;
      }
      rows.push(filtered); previous = row;
    }
  }
  const header = Buffer.alloc(13); header.writeUInt32BE(width); header.writeUInt32BE(height, 4); header[8] = depth; header[9] = color; header[12] = interlaced ? 1 : 0;
  const parts = [Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), previewChunk('IHDR', header)];
  if (color === 3) { parts.push(previewChunk('PLTE', Buffer.from(palette.flat()))); parts.push(previewChunk('tRNS', Buffer.from(alphas.slice(0, palette.length)))); }
  if (color === 0 || color === 2) {
    const values = color === 0 ? [transparent] : transparentRgb, data = Buffer.alloc(values.length * 2);
    values.forEach((n, i) => data.writeUInt16BE(n, i * 2)); parts.push(previewChunk('tRNS', data));
  }
  parts.push(previewChunk('IDAT', deflateSync(Buffer.concat(rows))), previewChunk('IEND', Buffer.alloc(0)));
  return { bytes: Buffer.concat(parts), width, height, expected };
}
export function expectedCrop(pixels: Uint8Array, imageWidth: number, x: number, y: number, width: number, height: number): Uint8Array {
  const output = new Uint8Array(width * height * 4);
  for (let row = 0; row < height; row++) output.set(pixels.subarray(((y + row) * imageWidth + x) * 4, ((y + row) * imageWidth + x + width) * 4), row * width * 4);
  return output;
}
