// The pet publication tests exercise R2 checksum/CAS and exact stream length.
// This stand-in models those contracts; it is not a Cloudflare deployment.
import { createHash } from 'node:crypto';
import { FakeBucket } from './fakes';

export const sha = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');

export class FixedStream extends TransformStream<Uint8Array, Uint8Array> {
  constructor(length: number) {
    let count = 0;
    super({
      transform(chunk, controller) {
        count += chunk.byteLength;
        if (count > length) throw new Error('length overrun');
        controller.enqueue(chunk);
      },
      flush() { if (count !== length) throw new Error('length underrun'); },
    });
  }
}

export class PetBucket extends FakeBucket {
  writes: string[] = [];
  async head(key: string) {
    const value = await super.head(key);
    const entry = this.objects.get(key);
    return value && entry ? { ...value, httpEtag: `"${sha(entry.bytes)}"`,
      checksums: { sha256: new Uint8Array(Buffer.from(sha(entry.bytes), 'hex')).buffer } } : null;
  }
  async get(key: string, options?: any) {
    const value = await super.get(key, options);
    const entry = this.objects.get(key);
    if (!value || !entry) return null;
    const hash = sha(entry.bytes), httpEtag = `"${hash}"`;
    const metadata = { key: value.key, size: value.size, uploaded: value.uploaded,
      customMetadata: value.customMetadata, etag: hash, httpEtag,
      checksums: { sha256: new Uint8Array(Buffer.from(hash, 'hex')).buffer } };
    // R2 conditional GET returns metadata WITHOUT body when a condition fails.
    const noneMatch = options?.onlyIf instanceof Headers ? options.onlyIf.get('If-None-Match')
      : options?.onlyIf?.etagDoesNotMatch;
    if (noneMatch === httpEtag || noneMatch === hash || noneMatch === '*') {
      void value.body.cancel().catch(() => {});
      return metadata;
    }
    return { ...value, ...metadata };
  }
  async put(key: string, value: any, options: any = {}) {
    const bytes = value instanceof ReadableStream ? new Uint8Array(await new Response(value).arrayBuffer())
      : typeof value === 'string' ? new TextEncoder().encode(value) : new Uint8Array(value);
    if (options.sha256) {
      const expected = typeof options.sha256 === 'string' ? options.sha256 : Buffer.from(options.sha256).toString('hex');
      if (sha(bytes) !== expected) throw new Error('R2 checksum mismatch');
    }
    const previous = this.objects.get(key);
    const match = options.onlyIf?.get('If-Match');
    if (match && (!previous || match !== `"${sha(previous.bytes)}"`)) return null;
    if (options.onlyIf?.get('If-None-Match') === '*' && previous) return null;
    const result = await super.put(key, bytes, options);
    if (result) this.writes.push(key);
    return result ? await this.head(key) : null;
  }
}
