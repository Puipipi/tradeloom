import { constants } from 'node:fs';
import { mkdir, realpath, lstat, open, rename, unlink, rmdir } from 'node:fs/promises';
import { isAbsolute, join, relative, sep, dirname } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { MediaError, checkAbort, fail } from './errors.js';

function under(root, path) {
  const rel = relative(root, path);
  return rel === '' || (rel !== '..' && !rel.startsWith('..' + sep) && !isAbsolute(rel));
}

async function directory(path) {
  try { await mkdir(path, { mode: 0o700 }); }
  catch (error) { if (error?.code !== 'EEXIST') throw error; }
  const info = await lstat(path, { bigint: true });
  if (!info.isDirectory() || info.isSymbolicLink()) fail('permission');
  return info;
}

function sameFile(a, b) {
  return typeof a?.ino === 'bigint' && a.ino !== 0n
    && typeof b?.ino === 'bigint' && a.dev === b.dev && a.ino === b.ino;
}

async function removeOwned(entry) {
  try {
    const current = await lstat(entry.path, { bigint: true });
    if (!current.isFile() || current.isSymbolicLink() || !sameFile(current, entry.identity)) {
      return false;
    }
    await unlink(entry.path);
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return true;
    throw error;
  }
}

// Host scheduling and request identities exclude another publisher of this name.
// Preserve refusal of an existing target; this is not atomic no-replace against
// an external process that writes between the check and rename.
async function requireAbsent(path) {
  try { await lstat(path); }
  catch (error) { if (error?.code === 'ENOENT') return; throw error; }
  fail('storage');
}

async function syncDirectory(path) {
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | (constants.O_DIRECTORY ?? 0));
    await handle.sync();
  } catch (error) {
    if (['EINVAL', 'ENOTSUP', 'EOPNOTSUPP'].includes(error?.code)
      || (process.platform === 'win32' && ['EPERM', 'EISDIR'].includes(error?.code))) {
      fail('unsupported_backend');
    }
    throw error;
  } finally {
    await handle?.close();
  }
}

async function writeNew(path, bytes, signal, onCreated) {
  checkAbort(signal);
  const handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
  // Record creation BEFORE stat. An identity-read failure must remain visible
  // to rollback; never delete an object whose ownership cannot be established.
  const entry = { path, identity: undefined };
  let failure;
  try {
    onCreated?.(entry);
    entry.identity = await handle.stat({ bigint: true });
    await handle.writeFile(bytes, { signal });
    checkAbort(signal);
    await handle.sync();
  } catch (error) {
    failure = error;
  } finally {
    try { await handle.close(); } catch (error) { failure ??= error; }
  }
  if (failure) {
    if (!entry.identity) throw new MediaError('cleanup_failed');
    await removeOwned(entry).catch(() => {});
    throw failure;
  }
  return entry;
}

/**
 * Host-local raw-byte transaction.
 * Canonical checks match the trusted-path threat model of fs-sandbox. They
 * narrow, but do not eliminate, an ancestor replacement between check/syscall.
 * This is NOT a kernel sandbox or an atomic transaction across two directories.
 */
export async function prepareImageStore({
  authorizeWorkspace, hostStateDir, signal, rid, date, publicationSuffix,
}) {
  if (!/^m_[a-f0-9-]{36}$/.test(rid) || !/^\d{4}-\d{2}-\d{2}$/.test(date)
    || typeof authorizeWorkspace !== 'function'
    || typeof hostStateDir !== 'string' || !isAbsolute(hostStateDir)) {
    fail('invalid_request');
  }
  if (publicationSuffix !== undefined && !/^[a-f0-9-]{36}$/.test(publicationSuffix)) fail('invalid_request');
  const fileStem = rid + (publicationSuffix ? '-' + publicationSuffix : '');
  checkAbort(signal);
  let initial;
  try { initial = await authorizeWorkspace(); }
  catch { fail('permission'); }
  if (!initial || !isAbsolute(initial.cwd ?? '') || !isAbsolute(initial.workspaceRoot ?? '')) {
    fail('unsupported_backend');
  }
  const cwd = await realpath(initial.cwd);
  const generated = join(cwd, 'generated');
  const dated = join(generated, date);
  const stagedDir = join(dated, '.' + rid + '-' + randomUUID() + '.pending');
  const staged = [];
  const downloads = [];
  const published = [];
  let indexPublished;
  let committed = false;
  let stagedIdentity;
  let stageCreated = false;
  let indexDir;
  const indexDirectories = [];
  const indexSyncParents = [];

  async function guard({ includeStage = true } = {}) {
    checkAbort(signal);
    let current;
    try { current = await authorizeWorkspace(); }
    catch { fail('permission'); }
    if (!current || !['workspace-write', 'danger-full-access'].includes(current.mode)) {
      fail('permission');
    }
    if (!isAbsolute(current.cwd ?? '') || !isAbsolute(current.workspaceRoot ?? '')) {
      fail('unsupported_backend');
    }
    if (await realpath(current.cwd) !== cwd) fail('permission');
    const root = await realpath(current.workspaceRoot);
    if (current.mode === 'workspace-write' && !under(root, cwd)) fail('permission');
    for (const path of [generated, dated, ...(includeStage ? [stagedDir] : [])]) {
      try {
        const info = await lstat(path, { bigint: true });
        if (!info.isDirectory() || info.isSymbolicLink()
          || await realpath(path) !== path || !under(cwd, path)) fail('permission');
        if (path === stagedDir && stagedIdentity && !sameFile(info, stagedIdentity)) {
          fail('permission');
        }
      } catch (error) {
        if (error?.code === 'ENOENT' && !includeStage) continue;
        throw error;
      }
    }
    for (const entry of indexDirectories) {
      const info = await lstat(entry.path, { bigint: true });
      if (!info.isDirectory() || info.isSymbolicLink()
        || !sameFile(info, entry.identity) || await realpath(entry.path) !== entry.path) {
        fail('storage');
      }
    }
    checkAbort(signal);
    return { cwd: current.cwd, workspaceRoot: current.workspaceRoot, mode: current.mode };
  }

  // No filesystem writes and no billable request precede the first policy check.
  await guard({ includeStage: false });
  await directory(generated);
  await guard({ includeStage: false });
  await directory(dated);
  await guard({ includeStage: false });
  try {
    await mkdir(stagedDir, { mode: 0o700 });
    stageCreated = true;
    stagedIdentity = await lstat(stagedDir, { bigint: true });
    await guard();
    // Verify the private index destination before starting a billable request.
    const firstCreated = await mkdir(hostStateDir, { recursive: true, mode: 0o700 });
    const stateInfo = await lstat(hostStateDir, { bigint: true });
    if (!stateInfo.isDirectory() || stateInfo.isSymbolicLink()) fail('storage');
    const state = await realpath(hostStateDir);
    indexDirectories.push({ path: state, identity: stateInfo });
    const syncStop = firstCreated ? dirname(await realpath(firstCreated)) : state;
    for (let path = state; ; path = dirname(path)) {
      indexSyncParents.push(path);
      if (path === syncStop) break;
      if (dirname(path) === path) fail('storage');
    }
    const works = join(state, 'works');
    indexDirectories.push({ path: works, identity: await directory(works) });
    indexDir = join(works, date);
    indexDirectories.push({ path: indexDir, identity: await directory(indexDir) });
    await guard();
    // Probe directory-sync support BEFORE any provider call, and persist the
    // newly created parent chain. Unsupported backends fail closed.
    for (const path of [dated, generated, cwd, indexDir, works, ...indexSyncParents]) {
      await syncDirectory(path);
    }
    await guard();
  }
  catch (error) {
    if (!await rollback()) throw new MediaError('cleanup_failed');
    throw error;
  }

  async function rollback() {
    // Remove and sync the public index FIRST. If it cannot be removed, keep
    // every referenced image; reporting cleanup failure is safer than a dangling work.
    if (indexPublished) {
      try {
        if (!await removeOwned(indexPublished)) return false;
        await syncDirectory(indexDir);
        indexPublished = undefined;
      } catch { return false; }
    }
    const failures = [];
    for (const entry of [...published, ...staged, ...downloads].reverse()) {
      try {
        if (!await removeOwned(entry)) failures.push(entry.path);
      } catch { failures.push(entry.path); }
    }
    if (stageCreated) {
      try {
        const info = await lstat(stagedDir, { bigint: true });
        if (!stagedIdentity || !info.isDirectory() || info.isSymbolicLink()
          || !sameFile(info, stagedIdentity)) failures.push(stagedDir);
        else await rmdir(stagedDir);
      } catch (error) {
        if (error?.code !== 'ENOENT') failures.push(stagedDir);
      }
    }
    if (published.length > 0) {
      try { await syncDirectory(dated); } catch { failures.push(dated); }
    }
    return failures.length === 0;
  }

  return {
    cwd,
    stagingDirectory: stagedDir,
    outputPath(slot, extension) { return join(dated, fileStem + '-' + slot + '.' + extension); },
    async ownDownload(receipt) {
      await guard();
      if (dirname(receipt.path) !== stagedDir) fail('invalid_request');
      const identity = await lstat(receipt.path, { bigint: true });
      if (!identity.isFile() || identity.isSymbolicLink()) fail('storage');
      downloads.push({ path: receipt.path, identity });
    },
    async stageDownloaded(receipt, extension) {
      if (committed || extension !== 'mp4' || receipt?.kind !== 'private-download'
        || dirname(receipt.path) !== stagedDir || !/^[a-f0-9]{64}$/.test(receipt.sha256)) fail('invalid_request');
      await guard();
      const handle = await open(receipt.path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      let identity;
      try {
        identity = await handle.stat({ bigint: true });
        if (!identity.isFile() || Number(identity.size) !== receipt.bytes) fail('storage');
        const hash = createHash('sha256');
        for await (const chunk of handle.createReadStream({ autoClose: false })) { checkAbort(signal); hash.update(chunk); }
        if (hash.digest('hex') !== receipt.sha256) fail('storage');
        await guard();
        if (!sameFile(await lstat(receipt.path, { bigint: true }), identity)) fail('storage');
        const slot = staged.length + 1;
        const path = join(stagedDir, String(slot) + '.mp4');
        await requireAbsent(path);
        await rename(receipt.path, path);
        staged.push({ path, identity, contentDigest: { bytes: receipt.bytes, sha256: receipt.sha256 } });
        await syncDirectory(stagedDir);
        await guard();
        return join(dated, fileStem + '-' + slot + '.mp4');
      } finally { await handle.close(); }
    },
    async recheck() { await guard(); },
    async stage(bytes, extension) {
      if (committed || !['png', 'jpg', 'webp', 'gif'].includes(extension)) {
        fail('invalid_request');
      }
      // Own the exact bytes before any await: later caller mutation cannot change
      // either the written original or its private content evidence.
      if (!(bytes instanceof Uint8Array)) fail('invalid_request');
      const snapshot = Buffer.from(bytes);
      const sha256 = createHash('sha256').update(snapshot).digest('hex');
      await guard();
      const slot = staged.length + 1;
      const temporaryPath = join(stagedDir, String(slot) + '.' + extension);
      const entry = await writeNew(temporaryPath, snapshot, signal, entry => staged.push(entry));
      entry.contentDigest = { bytes: snapshot.length, sha256 };
      await guard();
      return join(dated, fileStem + '-' + slot + '.' + extension);
    },
    async commit(meta, { sessionId, createdAt }) {
      if (committed || !meta?.items || meta.items.length !== staged.length
        || staged.length === 0 || staged.length > 4) fail('invalid_request');
      await guard();
      // A private, one-record-per-request index avoids concurrent JSONL append
      // corruption. It contains no API keys or temporary provider URLs.
      for (let i = 0; i < staged.length; i += 1) {
        await guard();
        const target = meta.items[i].path;
        const expected = join(dated, fileStem + '-' + (i + 1) + '.'
          + staged[i].path.split('.').at(-1));
        if (target !== expected) fail('invalid_request');
        await requireAbsent(target);
        await rename(staged[i].path, target);
        published.push({ path: target, identity: staged[i].identity });
        await guard();
      }
      // Persist both the move out of staging and the published names before the index.
      await syncDirectory(stagedDir);
      await syncDirectory(dated);
      await guard();
      const record = {
        schemaVersion: 1, rid, sessionId, createdAt, cwd, media: meta,
        // Optional private evidence. Never added to the external media v1 value.
        contentDigests: meta.items.map((_item, i) => ({ ...staged[i].contentDigest })),
      };
      const bytes = Buffer.from(JSON.stringify(record) + '\n', 'utf8');
      // Keep the historical record-size gate unchanged; bounded private
      // digest evidence receives separate headroom, not public meta capacity.
      const legacyBytes = Buffer.byteLength(JSON.stringify({ ...record, contentDigests: undefined }) + '\n');
      if (legacyBytes > 16384 || bytes.length > 17408) fail('metadata');
      const temporaryIndex = join(indexDir, '.' + rid + '.' + randomUUID() + '.tmp');
      const index = await writeNew(temporaryIndex, bytes, signal, entry => staged.push(entry));
      await guard();
      if (await realpath(indexDir) !== indexDir) fail('storage');
      const finalIndex = join(indexDir, rid + '.json');
      await requireAbsent(finalIndex);
      await rename(index.path, finalIndex);
      indexPublished = { path: finalIndex, identity: index.identity };
      await syncDirectory(indexDir);
      const acceptedPolicy = await guard();
      // All filesystem awaits precede this final authorization snapshot.
      // There is no intervening filesystem await before the acceptance point.
      let finalPolicy;
      try { finalPolicy = await authorizeWorkspace(); }
      catch { fail('permission'); }
      if (!finalPolicy || finalPolicy.cwd !== acceptedPolicy.cwd
        || finalPolicy.workspaceRoot !== acceptedPolicy.workspaceRoot
        || finalPolicy.mode !== acceptedPolicy.mode) fail('permission');
      checkAbort(signal);
      committed = true;
      // Publication is complete. Cleanup errors cannot erase an accepted work.
      for (const entry of staged) await removeOwned(entry).catch(() => {});
      await rmdir(stagedDir).catch(() => {});
      return { indexPath: finalIndex };
    },
    async abort() {
      if (committed) return true;
      return rollback();
    },
  };
}
