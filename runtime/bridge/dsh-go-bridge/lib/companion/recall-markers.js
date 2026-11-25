import * as fs from 'node:fs';
import * as promises from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fields } from './schema.js';
import { canonicalUuid, recallError, validRecallSessionId } from './recall-schema.js';
import { RECALL_SELECTOR } from './recall-selector.js';

export const RECALL_MARKER_SCHEMA = 'dsh-go/companion-recall-session';
const MAX_BYTES = 4096;
const unavailable = () => recallError(503, 'tag-unavailable', 'Companion recall session marker is unavailable');

export function createRecallMarkers({ directory, io = promises, syncIO = fs } = {}) {
  const home = process.env.DSH_HOME?.trim() || join(homedir(), '.dsh');
  const root = resolve(directory ?? join(home, 'companion', 'recall-sessions'));
  let probe;
  const pathFor = (sessionId) => {
    if (typeof sessionId !== 'string') throw unavailable();
    return join(root, `${createHash('sha256').update(sessionId, 'utf8').digest('hex')}.json`);
  };
  function readSync(sessionId) {
    let fd;
    let observed = false;
    try {
      const path = pathFor(sessionId);
      // A symlink, directory, malformed document or read failure is never
      // absence. The fixed engine fallback also denies any existing marker.
      const entry = syncIO.lstatSync(path);
      observed = true;
      if (!entry.isFile()) throw unavailable();
      fd = syncIO.openSync(path, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
      const info = syncIO.fstatSync(fd);
      if (!info.isFile() || info.size > MAX_BYTES) throw unavailable();
      const data = Buffer.alloc(MAX_BYTES + 1);
      let size = 0;
      while (size < data.length) {
        const count = syncIO.readSync(fd, data, size, data.length - size, size);
        if (count === 0) break;
        size += count;
      }
      if (size > MAX_BYTES) throw unavailable();
      const doc = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(data.subarray(0, size)));
      if (!fields(doc, ['schema', 'v', 'sessionId', 'storeId', 'protocol']) || doc.schema !== RECALL_MARKER_SCHEMA
        || doc.v !== 1 || doc.sessionId !== sessionId || !validRecallSessionId(doc.sessionId)
        || !canonicalUuid(doc.storeId) || doc.protocol !== RECALL_SELECTOR) throw unavailable();
      return doc;
    } catch (error) {
      if (!observed && error?.code === 'ENOENT') return null;
      throw unavailable();
    } finally {
      if (fd !== undefined) try { syncIO.closeSync(fd); } catch {}
    }
  }
  async function syncDirectory() {
    const handle = await io.open(root, 'r');
    try { await handle.sync(); } finally { await handle.close(); }
  }
  async function publish(path, data) {
    const temporary = join(root, `.recall-${randomUUID()}.tmp`);
    let handle;
    try {
      await io.mkdir(root, { recursive: true, mode: 0o700 });
      handle = await io.open(temporary, 'wx', 0o600);
      await handle.writeFile(data, 'utf8');
      await handle.sync();
      await handle.close(); handle = undefined;
      // Markers are immutable: atomic link publication cannot overwrite a
      // marker that appeared concurrently. Temp and destination share a dir.
      await io.link(temporary, path);
      await syncDirectory();
    } catch { throw unavailable(); }
    finally {
      if (handle !== undefined) await handle.close().catch(() => {});
      await io.unlink(temporary).catch(() => {});
    }
  }
  return {
    readSync,
    async available() {
      if (probe !== undefined) return probe;
      const attempt = (async () => {
        const target = join(root, `.probe-${randomUUID()}.tmp`);
        try { await publish(target, '{}'); return true; }
        catch { return false; }
        finally { await io.unlink(target).catch(() => {}); }
      })();
      probe = attempt;
      const available = await attempt;
      // Share an in-flight probe and retain successful capability evidence,
      // but a temporary storage failure cannot disable recall for this epoch.
      if (!available && probe === attempt) probe = undefined;
      return available;
    },
    async write(sessionId, storeId) {
      if (!validRecallSessionId(sessionId) || !canonicalUuid(storeId)) throw unavailable();
      if (readSync(sessionId) !== null) throw recallError(409, 'session-not-clean', 'Use a new clean session for automatic recall');
      const data = JSON.stringify({ schema: RECALL_MARKER_SCHEMA, v: 1, sessionId, storeId, protocol: RECALL_SELECTOR });
      if (Buffer.byteLength(data) > MAX_BYTES) throw unavailable();
      await publish(pathFor(sessionId), data);
      const stored = readSync(sessionId);
      if (stored?.storeId !== storeId) throw unavailable();
    },
  };
}
