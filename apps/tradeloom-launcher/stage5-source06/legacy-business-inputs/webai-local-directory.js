import { opendir, lstat } from 'node:fs/promises'
import { isAbsolute, relative, resolve, sep } from 'node:path'

const MAX_ENTRIES = 201

function abortIfNeeded(signal) {
  if (signal?.aborted) {
    const error = new Error('Directory listing aborted')
    error.name = 'AbortError'
    error.code = 'ABORT_ERR'
    throw error
  }
}

/**
 * Make a bounded directory adapter for DSH LocalFileSystem only.
 * The target must already be resolved by that provider and contained by rootTarget.
 */
export function createLocalDirectoryLister(fs, LocalFileSystemClass) {
  if (typeof LocalFileSystemClass !== 'function' || !(fs instanceof LocalFileSystemClass) || typeof fs.processPath !== 'function' || typeof fs.contains !== 'function') {
    throw new TypeError('A DSH LocalFileSystem provider is required')
  }
  return async function listDirBounded(target, { rootTarget, rootPath, maxEntries, signal } = {}) {
    if (!Number.isSafeInteger(maxEntries) || maxEntries < 1 || maxEntries > MAX_ENTRIES) throw new TypeError('maxEntries is outside the supported bound')
    if (!rootTarget || !fs.contains(rootTarget, target)) throw Object.assign(new Error('Target is outside the granted root'), { code: 'INVALID_PATH' })
    abortIfNeeded(signal)
    rootPath ??= fs.processPath(rootTarget)
    const targetPath = fs.processPath(target)
    if (!isAbsolute(rootPath) || !isAbsolute(targetPath)) throw Object.assign(new Error('Provider returned a non-absolute local path'), { code: 'INVALID_PATH' })
    const rel = relative(resolve(rootPath), resolve(targetPath))
    if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw Object.assign(new Error('Target escaped the granted root'), { code: 'INVALID_PATH' })
    const targetInfo = await lstat(targetPath)
    if (targetInfo.isSymbolicLink()) throw Object.assign(new Error('Directory target is a symbolic link'), { code: 'INVALID_PATH' })
    if (!targetInfo.isDirectory()) throw Object.assign(new Error('Target is not a directory'), { code: 'FS_NOT_DIRECTORY' })

    const dir = await opendir(targetPath)
    const entries = []
    try {
      for await (const entry of dir) {
        abortIfNeeded(signal)
        let type = entry.isDirectory() ? 'directory' : entry.isFile() ? 'file' : entry.isSymbolicLink() ? 'symlink' : 'other'
        let size
        if (type === 'file') {
          // lstat preserves the entry identity and never follows a replaced symlink.
          const info = await lstat(resolve(targetPath, entry.name))
          if (info.isSymbolicLink()) type = 'symlink'
          else if (info.isFile()) size = info.size
          else type = info.isDirectory() ? 'directory' : 'other'
        }
        entries.push({ name: entry.name, type, ...(size === undefined ? {} : { size }) })
        if (entries.length >= maxEntries) break
      }
      abortIfNeeded(signal)
      return entries.sort((left, right) => left.name.localeCompare(right.name))
    } finally {
      await dir.close().catch(() => {})
    }
  }
}
