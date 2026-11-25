// Minimal declarations for the documented Workers node:zlib surface. Keep the
// worker's global types independent of Node; no runtime package is bundled.
declare module 'node:zlib' {
  export function inflateSync(bytes: Uint8Array, options: { maxOutputLength: number }): Uint8Array;
  export function inflateRawSync(bytes: Uint8Array, options: { maxOutputLength: number; info: true }): { buffer: Uint8Array; engine: { bytesWritten: number } };
}
