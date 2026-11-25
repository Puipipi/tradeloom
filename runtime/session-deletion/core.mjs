// Bundled JSONL-only lifecycle seam. Locks and tombstones live beside the log root,
// never in cwd. Lock inodes and tombstones are permanent; IDs cannot be reused.
import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { link, lstat, mkdir, open, readdir, realpath, rename, rm } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const failure = (code, message = code) => Object.assign(new Error(message), { code });
const key = (id) => createHash('sha256').update(id).digest('hex');

export function createDeletionSeam(storage, { acquire, parseGeneration, notFound }) {
  const root = resolve(storage.root);
  const control = join(root, '.dsh-go-lifecycle');
  const pending = new Set();
  const draining = new Map();
  const context = new AsyncLocalStorage();
  const slot = (id) => join(control, key(id));
  const marker = (id) => join(slot(id), 'deleted.json');
  const deleted = (id) => {
    try { statSync(marker(id)); return true; }
    catch (error) { if (error.code === 'ENOENT') return false; throw error; }
  };
  const assertAdmit = (id) => {
    if (pending.has(id) || deleted(id)) throw notFound(id);
  };
  // Only the already-owned handle may finish its buffered writes during teardown.
  const assertPersist = (id, header) => {
    const writer = draining.get(id);
    if (writer !== undefined && writer.header === header && storage.tracker.writers.get(id) === writer && !deleted(id)) return;
    assertAdmit(id);
  };
  const assertParent = (header) => {
    if (header.origin === 'subagent' && header.parentSession !== undefined) assertAdmit(header.parentSession);
  };
  const mutation = async (operation) => {
    const inherited = context.getStore();
    if (inherited?.active) {
      const child = Promise.resolve().then(operation);
      inherited.children.add(child);
      child.then(() => inherited.children.delete(child), () => inherited.children.delete(child));
      return child;
    }
    let lock;
    for (let attempt = 0; ; attempt++) {
      try { lock = await acquire(join(control, '_mutations'), 'dsh-go-mutations'); break; }
      catch (error) {
        if (error?.name !== 'SessionAlreadyOwnedError' || attempt >= 500) throw error;
        await delay(20);
      }
    }
    const token = { active: true, children: new Set() };
    try {
      return await context.run(token, async () => {
        try { return await operation(); }
        finally { while (token.children.size) await Promise.allSettled([...token.children]); }
      });
    } finally { token.active = false; await lock.release(); }
  };
  const syncDir = async (path) => {
    const handle = await open(path, 'r');
    try { await handle.sync(); } finally { await handle.close(); }
  };
  const syncMarkerDirectories = async (id) => {
    await syncDir(slot(id));
    await syncDir(control);
    await syncDir(root);
    await syncDir(dirname(root));
  };
  const writeMarker = async (id, dir) => {
    await mkdir(slot(id), { recursive: true, mode: 0o700 });
    const temporary = join(slot(id), `.${randomUUID()}.tmp`);
    try {
      const handle = await open(temporary, 'wx', 0o600);
      try {
        await handle.writeFile(JSON.stringify({ version: 1, directory: relative(root, dir) }));
        await handle.sync();
      } finally { await handle.close(); }
      await link(temporary, marker(id));
    } finally { await rm(temporary, { force: true }); }
    await syncMarkerDirectories(id);
  };
  const savedDirectory = (id) => {
    const record = JSON.parse(readFileSync(marker(id), 'utf8'));
    const rel = record.directory;
    if (record.version !== 1 || typeof rel !== 'string' || isAbsolute(rel)
      || rel.split(/[\\/]/).includes('..') || rel.split(/[\\/]/).length !== 2) throw failure('failed');
    return resolve(root, rel);
  };
  const cascadeFile = (id) => join(slot(id), 'cascade.json');
  const savedCascade = (id) => {
    let text;
    try { text = readFileSync(cascadeFile(id), 'utf8'); }
    catch (error) { if (error.code === 'ENOENT') return []; throw error; }
    const record = JSON.parse(text);
    if (record.version !== 1 || record.sessionId !== id || !Array.isArray(record.children)) throw failure('failed');
    const seen = new Set([id]);
    for (const child of record.children) {
      if (typeof child?.id !== 'string' || !child.id || seen.has(child.id) || !seen.has(child.parentSession)) throw failure('failed');
      seen.add(child.id);
    }
    return record.children;
  };
  const saveCascade = async (id, children) => {
    const temporary = join(slot(id), `.${randomUUID()}.tmp`);
    try {
      const handle = await open(temporary, 'wx', 0o600);
      try {
        await handle.writeFile(JSON.stringify({ version: 1, sessionId: id, children }));
        await handle.sync();
      } finally { await handle.close(); }
      await rename(temporary, cascadeFile(id));
    } finally { await rm(temporary, { force: true }); }
    await syncMarkerDirectories(id);
  };
  const safeDirectory = async (dir) => {
    // A configured root may itself be a symlink; child/project symlinks are not admitted.
    const canonicalRoot = await realpath(root);
    if (await realpath(dir) !== join(canonicalRoot, relative(root, dir))) throw failure('failed', 'Symlink session directory.');
  };
  const logFiles = async (dir) => {
    const files = [];
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const generation = parseGeneration(entry.name, 'none') !== undefined || parseGeneration(entry.name, 'zstd') !== undefined;
      const temporary = /^session(?:\.v[1-9][0-9]*)?\.jsonl(?:\.zstd)?\.[a-f0-9]+\.tmp$/.test(entry.name)
        || /^session\.migration\.[a-f0-9]{16}\.jsonl(?:\.zstd)?\.tmp$/.test(entry.name);
      if (!generation && !temporary) continue;
      const path = join(dir, entry.name);
      if (!(await lstat(path)).isFile()) throw failure('failed', 'Unexpected log artifact type.');
      files.push(path);
    }
    return files;
  };
  const isSubagent = (header) => header.origin === 'subagent' || (header.delegationDepth ?? 0) > 0;
  // Delete one stored session that is already fenced: no agent, no pending input.
  // A descendant must still belong to the parent recorded by this deletion.
  const deleteOne = async (id, hooks, parentSession) => {
    const retry = deleted(id);
    let identity;
    let artifact;
    let claimed = false;
    try {
      if (storage.ctx.get('sessions')?.get(id) !== undefined) throw failure('writer-held');
      storage.tracker.claimWrite(id);
      claimed = true;
      identity = await acquire(slot(id), id);
      let dir;
      if (retry) dir = savedDirectory(id);
      else {
        const selected = await storage.findLog(id);
        if (selected === undefined) throw failure('not-found');
        dir = dirname(selected.currentPath);
      }
      await safeDirectory(dir);
      artifact = await acquire(dir, id);
      await mutation(async () => {
        if (!retry) {
          // Re-read under both leases and the shared mutation fence. Migration reads are
          // observation-only; no old generation is ever resumed or published by delete.
          const metadata = await storage.readGenerationHeader(await storage.findLog(id), id);
          if (metadata === undefined) throw failure('failed');
          if (parentSession === undefined) {
            if (isSubagent(metadata.header)) throw failure('session-related');
          } else if (metadata.header.origin !== 'subagent' || metadata.header.parentSession !== parentSession) {
            throw failure('session-related');
          }
          // Descendants are removed before their parent; a child here means another
          // writer raced the planned tree, so the tree this call planned is incomplete.
          const corpus = await storage.list();
          if (corpus.some(({ header }) => header.origin === 'subagent' && header.parentSession === id)) throw failure('session-related');
          if (await hooks.inspectTasks?.(id)) throw failure('session-related');
          const goal = (await storage.requireStoredLog(id)).events.filter((event) => event.type === 'goal/change').at(-1)?.data?.goal;
          if (goal?.phase === 'active') throw failure('session-active');
        }
        const files = await logFiles(dir);
        if (!retry) await writeMarker(id, dir); // Durable point of no return; retry completes cleanup.
        else await syncMarkerDirectories(id); // A previous attempt may have failed after linking the marker.
        storage.coldLogMemo.delete(id);
        storage.migrationPreparations.get(id)?.controller.abort();
        storage.migrationPreparations.delete(id);
        for (const path of files) await rm(path, { force: true });
        await syncDir(dir);
      });
      // Workspace cleanup can wait for a stop provider that needs the mutation lease.
      await hooks.cleanup?.(id);
      storage.ctx.emit('dsh-go/session-deleted', id);
    } finally {
      try { await artifact?.release(); }
      finally {
        try { await identity?.release(); }
        finally { if (claimed) storage.tracker.releaseClaim(id); }
      }
    }
  };
  return {
    version: 2, pending, deleted, assertAdmit, assertParent, withMutation: mutation,
    // Global identity lease closes the alternate-cwd create race; the original directory
    // lease also excludes older runtime writers. Neither inode is ever unlinked.
    async acquireWriter(id, dir, header) {
      assertPersist(id, header);
      const identity = await acquire(slot(id), id);
      let artifact;
      try {
        assertPersist(id, header);
        artifact = await acquire(dir, id);
        assertPersist(id, header);
        return { async release() { try { await artifact.release(); } finally { await identity.release(); } } };
      } catch (error) {
        try { await artifact?.release(); } finally { await identity.release(); }
        throw error;
      }
    },
    async cacheWrite(id, operation) {
      return mutation(async () => { if (!deleted(id)) return operation(); });
    },
    async materialize(header, operation) {
      return mutation(async () => { assertPersist(header.id, header); assertParent(header); return operation(); });
    },
    async delete(id, hooks) {
      if (pending.has(id)) throw failure('writer-held');
      pending.add(id); // Synchronous fence precedes the first await and every prompt admission.
      // The requested session plus every subagent session under it, parents before leaves.
      const nodes = [id];
      let operation;
      try {
        // The per-session leases below do not span siblings or storage instances.
        // Keep one owner of this parent's retry record until all cleanup completes.
        operation = await acquire(join(slot(id), 'deletion'), 'dsh-go-deletion');
        const children = savedCascade(id);
        const retry = deleted(id);
        const live = storage.ctx.get('sessions')?.list() ?? [];
        const corpus = [...await storage.list(), ...live.map((session) => ({ header: session.header }))];
        const headers = new Map(corpus.map(({ header }) => [header.id, header]));
        for (const child of children) {
          if (deleted(child.id)) continue;
          const current = headers.get(child.id);
          if (current?.origin !== 'subagent' || current.parentSession !== child.parentSession) throw failure('session-related');
        }
        if (!retry) {
          const target = headers.get(id);
          if (target !== undefined && isSubagent(target)) throw failure('session-related');
          // Subagent sessions belong to the chat that started them: deleting the chat
          // removes the whole tree instead of refusing forever. The fence above already
          // stops new members from being admitted while the tree is collected.
          const parents = [id, ...children.map((child) => child.id)];
          const seen = new Set(parents);
          for (const parent of parents) {
            for (const header of headers.values()) {
              if (header.origin !== 'subagent' || header.parentSession !== parent || seen.has(header.id)) continue;
              seen.add(header.id);
              children.push({ id: header.id, parentSession: parent });
              parents.push(header.id);
            }
          }
        }
        for (const child of children) {
          if (pending.has(child.id)) throw failure('writer-held');
          pending.add(child.id);
          nodes.push(child.id);
        }
        // Tombstoned members only need cleanup; surviving members still need every
        // activity/task check, including after a restart or a previous failed cleanup.
        const surviving = nodes.filter((node) => !deleted(node));
        for (const node of surviving) {
          const writer = storage.tracker.writers.get(node);
          if (writer) draining.set(node, writer);
        }
        for (const node of surviving) if (await hooks.inspectTasks?.(node)) throw failure('session-related');
        for (const node of surviving) await hooks.validate?.(node);
        // Save the verified tree before the first child can disappear from list().
        // A failure keeps it for an explicit retry; full cleanup removes it below.
        if (children.length) await saveCascade(id, children);
        for (const node of [...surviving].reverse()) await hooks.dispose?.(node, { cascade: node !== id });
        for (const node of nodes) draining.delete(node);
        // Fenced and disposed; leaves go first so each parent's remaining-children
        // recheck holds by construction, and the requested chat is tombstoned last.
        for (const child of [...children].reverse()) await deleteOne(child.id, hooks, child.parentSession);
        await deleteOne(id, hooks);
        if (children.length) {
          await rm(cascadeFile(id));
          await syncDir(slot(id));
        }
      } finally {
        try { await operation?.release(); }
        finally { for (const node of nodes) { draining.delete(node); pending.delete(node); } }
      }
    },
  };
}
