import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { checkAbort, fail } from './errors.js';

// Parse bounded ISO BMFF metadata, never trust a URL extension or a provider's dimensions.
// This verifies container structure and the video track, not complete pixel decoding.
function boxes(bytes, start = 0, end = bytes.length) {
  const result = [];
  for (let at = start; at < end;) {
    if (at + 8 > end) fail('response');
    let size = bytes.readUInt32BE(at), header = 8;
    if (size === 1) {
      if (at + 16 > end) fail('response');
      size = Number(bytes.readBigUInt64BE(at + 8)); header = 16;
    }
    if (size === 0) size = end - at;
    if (!Number.isSafeInteger(size) || size < header || at + size > end) fail('response');
    result.push({ type: bytes.toString('ascii', at + 4, at + 8), data: bytes.subarray(at + header, at + size) });
    at += size;
    if (result.length > 4096) fail('response');
  }
  return result;
}
const child = (bytes, type) => boxes(bytes).find(box => box.type === type)?.data;
export async function inspectVideo(path, signal) {
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size < 32) fail('response');
    let at = 0, moov, ftyp = false, mdat = false, count = 0;
    while (at < info.size) {
      checkAbort(signal);
      if (++count > 4096 || at + 8 > info.size) fail('response');
      const header = Buffer.alloc(16);
      const { bytesRead } = await handle.read(header, 0, Math.min(16, info.size - at), at);
      if (bytesRead < 8) fail('response');
      let size = header.readUInt32BE(0), offset = 8;
      if (size === 1) { if (bytesRead < 16) fail('response'); size = Number(header.readBigUInt64BE(8)); offset = 16; }
      if (size === 0) size = info.size - at;
      if (!Number.isSafeInteger(size) || size < offset || at + size > info.size) fail('response');
      const type = header.toString('ascii', 4, 8);
      if (type === 'ftyp') ftyp = size >= 16;
      if (type === 'mdat') mdat = size > offset;
      if (type === 'moov') {
        if (moov || size > 4 * 1024 * 1024) fail('response');
        moov = Buffer.alloc(size - offset);
        if ((await handle.read(moov, 0, moov.length, at + offset)).bytesRead !== moov.length) fail('response');
      }
      at += size;
    }
    if (!ftyp || !mdat || !moov) fail('response');
    const tracks = boxes(moov).filter(box => box.type === 'trak');
    for (const track of tracks) {
      const mdia = child(track.data, 'mdia');
      if (!mdia) continue;
      const hdlr = child(mdia, 'hdlr');
      if (!hdlr || hdlr.length < 12 || hdlr.toString('ascii', 8, 12) !== 'vide') continue;
      const tkhd = child(track.data, 'tkhd'), mdhd = child(mdia, 'mdhd');
      if (!tkhd || tkhd.length < 84 || !mdhd || mdhd.length < 24) fail('response');
      const width = tkhd.readUInt32BE(tkhd.length - 8) / 65536, height = tkhd.readUInt32BE(tkhd.length - 4) / 65536;
      const long = mdhd[0] === 1;
      if (long && mdhd.length < 36) fail('response');
      const timescale = mdhd.readUInt32BE(long ? 20 : 12);
      const ticks = long ? Number(mdhd.readBigUInt64BE(24)) : mdhd.readUInt32BE(16);
      const duration = ticks / timescale;
      if (![width, height].every(v => Number.isInteger(v) && v > 0 && v <= 16384)
        || !Number.isFinite(duration) || duration <= 0 || duration > 3600) fail('response');
      const minf = child(mdia, 'minf'), stbl = minf && child(minf, 'stbl'), stsd = stbl && child(stbl, 'stsd');
      if (!stsd || stsd.length < 16) fail('response');
      const codec = stsd.toString('ascii', 12, 16);
      if (!['avc1', 'avc3', 'hvc1', 'hev1', 'av01', 'vp09'].includes(codec)) fail('response');
      return { mime: 'video/mp4', extension: 'mp4', width, height, duration, codec: ({ avc1: 'h264', avc3: 'h264', hvc1: 'hevc', hev1: 'hevc', av01: 'av1', vp09: 'vp9' })[codec] };
    }
    fail('response');
  } finally { await handle.close(); }
}
