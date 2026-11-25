// Original 2x1 solid-color fixture pixels, encoded once with an already
// available Pillow. No decoder/library dependency is needed by the tests.
export const jpeg = () => Buffer.from('/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAABAAIDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwDm6KKK8U/TT//Z', 'base64');
export const progressiveJpeg = () => Buffer.from('/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wgARCAABAAIDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAX/xAAVAQEBAAAAAAAAAAAAAAAAAAAEBv/aAAwDAQACEAMQAAABmgVN/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABBQJ//8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAgBAwEBPwF//8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAgBAgEBPwF//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQAGPwJ//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPyF//9oADAMBAAIAAwAAABAH/8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAgBAwEBPxB//8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAgBAgEBPxB//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxB//9k=', 'base64');
export const lossyWebp = () => Buffer.from('UklGRjoAAABXRUJQVlA4IC4AAADwAQCdASoCAAEAAUAmJaACdLoB+AAETAAA/u/9w/153OdnP/voB70A96Af18AA', 'base64');
export const losslessWebp = () => Buffer.from('UklGRh4AAABXRUJQVlA4TBEAAAAvAQAAAAdQlFoXpf+BiOh/AAA=', 'base64');
export function webpChunk(type: string, data: Uint8Array) {
  const header = Buffer.alloc(8); header.write(type); header.writeUInt32LE(data.length, 4);
  return Buffer.concat([header, data, data.length & 1 ? Buffer.from([0]) : Buffer.alloc(0)]);
}
export function webpFile(chunks: Uint8Array[]) {
  const body = Buffer.concat(chunks), header = Buffer.alloc(12); header.write('RIFF'); header.writeUInt32LE(4 + body.length, 4); header.write('WEBP', 8);
  return Buffer.concat([header, body]);
}
export function extendedWebp(flags = 0, width = 2, height = 1, extra: Uint8Array[] = []) {
  const head = Buffer.alloc(10); head[0] = flags; head.writeUIntLE(width - 1, 4, 3); head.writeUIntLE(height - 1, 7, 3);
  return webpFile([webpChunk('VP8X', head), ...extra, lossyWebp().subarray(12)]);
}
