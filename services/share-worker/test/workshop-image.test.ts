import { expect, it } from 'vitest';
import { previewImage } from '../src/workshop-image';
import { chunk, png } from './workshop-fixtures';
import { extendedWebp, jpeg, losslessWebp, lossyWebp, progressiveJpeg, webpChunk, webpFile } from './workshop-image-fixtures';

for (const [name, bytes, type] of [
  ['ordinary.jpg', jpeg, 'image/jpeg'], ['progressive.jpeg', progressiveJpeg, 'image/jpeg'],
  ['lossy.webp', lossyWebp, 'image/webp'], ['lossless.WEBP', losslessWebp, 'image/webp'],
] as const) it(`reports bounded structural dimensions for ${name}`, () => {
  expect(previewImage(bytes(), name)).toEqual({ mediaType: type, width: 2, height: 1, validation: 'structure-only' });
});
it('keeps the complete PNG decoder distinct from structural image checks', () => {
  expect(previewImage(png(), 'IMAGE.PNG')).toEqual({ mediaType: 'image/png', width: 1, height: 1, validation: 'full-png' });
});
it('rejects APNG control data instead of only validating its base frame', () => {
  const source = png(), animated = Buffer.concat([source.subarray(0, 33), chunk('acTL', Buffer.alloc(8)), source.subarray(33)]);
  expect(() => previewImage(animated, 'animated.png')).toThrowError('png_animated');
});
it('rejects truncated/trailing JPEG and a frame-free stream without decoding pixels', () => {
  const source = jpeg();
  for (const bytes of [source.subarray(0, -1), Buffer.concat([source, Buffer.from([0])]), Buffer.from([255, 216, 255, 217])]) {
    expect(() => previewImage(bytes, 'image.jpg')).toThrowError('preview_format');
  }
});
it('checks both the existing 4096 side limit and the 16MiB RGBA geometry limit', () => {
  // Only header policy is under test; these changed headers are not claimed
  // to match or validate the sample's compressed pixel data.
  const source = jpeg(), frame = source.indexOf(Buffer.from([255, 192])); expect(frame).toBeGreaterThan(0);
  const within = Buffer.from(source); within.writeUInt16BE(4096, frame + 7);
  expect(previewImage(within, 'wide.jpg').width).toBe(4096);
  const tooWide = Buffer.from(source); tooWide.writeUInt16BE(4097, frame + 7);
  expect(() => previewImage(tooWide, 'wide.jpg')).toThrowError('preview_dimensions');
  const tooMany = Buffer.from(source); tooMany.writeUInt16BE(2049, frame + 5); tooMany.writeUInt16BE(2049, frame + 7);
  expect(() => previewImage(tooMany, 'large.jpg')).toThrowError('preview_dimensions');
});
it('supports a static extended WebP with matching bounded canvas', () => {
  expect(previewImage(extendedWebp(), 'image.webp')).toMatchObject({ width: 2, height: 1, validation: 'structure-only' });
  const exif = webpChunk('EXIF', Buffer.from('Original fixture metadata'));
  expect(previewImage(extendedWebp(8, 2, 1, [exif]), 'image.webp').mediaType).toBe('image/webp');
});
it('refuses WebP animation flags and chunks even when one still frame is present', () => {
  for (const source of [extendedWebp(2), extendedWebp(0, 2, 1, [webpChunk('ANIM', Buffer.alloc(6))]),
    extendedWebp(0, 2, 1, [webpChunk('ANMF', Buffer.alloc(16))])]) {
    expect(() => previewImage(source, 'image.webp')).toThrowError('preview_animated');
  }
});
it('requires exact WebP chunk spans, zero padding, and one image', () => {
  const source = lossyWebp(), padded = Buffer.from(losslessWebp()); padded[padded.length - 1] = 1;
  for (const bytes of [source.subarray(0, -1), Buffer.concat([source, Buffer.from([0])]), padded,
    webpFile([source.subarray(12), source.subarray(12)])]) {
    expect(() => previewImage(bytes, 'image.webp')).toThrowError('preview_format');
  }
});
it('checks WebP canvas consistency and excludes unsupported extensions from preview only', () => {
  expect(() => previewImage(extendedWebp(0, 3, 1), 'image.webp')).toThrowError('preview_dimensions');
  expect(() => previewImage(extendedWebp(0, 2, 1, [webpChunk('ABCD', Buffer.from([0]))]), 'image.webp'))
    .toThrowError('preview_unsupported');
  expect(() => previewImage(png(), 'image.svg')).toThrowError('preview_unsupported');
  expect(() => previewImage(jpeg(), 'image.png')).toThrowError('png_header');
});
