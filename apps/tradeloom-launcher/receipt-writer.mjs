import { createHash, randomUUID } from 'node:crypto'
import { lstat, readFile, writeFile, realpath, link, unlink } from 'node:fs/promises'
import path from 'node:path'

export const RECEIPT_NAME = '.tradeloom-desktop-build-receipt.json'
export const RECEIPT_FILES = [
  'apps/desktop/lib/main.js',
  'apps/desktop-host/lib/index.js',
]

export function patchSetDigest(patches) {
  return createHash('sha256')
    .update(JSON.stringify(Object.entries(patches).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)))
    .digest('hex')
}

async function hashOrdinaryFile(runtime, relative, fs) {
  const target = path.resolve(runtime, relative)
  const rel = path.relative(runtime, target)
  if (rel.startsWith('..') || path.isAbsolute(rel)) throw new Error(`receipt 文件越出 runtime：${relative}`)
  let current = runtime
  for (const part of rel.split(path.sep)) {
    current = path.join(current, part)
    const info = await fs.lstat(current)
    if (info.isSymbolicLink()) throw new Error(`receipt 路径含 reparse/link：${current}`)
    if (current !== target && !info.isDirectory()) throw new Error(`receipt 祖先不是普通目录：${current}`)
    if (current === target && !info.isFile()) throw new Error(`receipt 编译文件不是普通文件：${relative}`)
  }
  return createHash('sha256').update(await fs.readFile(target)).digest('hex')
}

/**
 * Create the existing v1 receipt after a separate builder reports its real work.
 * This is a local build record, not a signature or a way to certify unbuilt files.
 */
export async function writeDesktopBuildReceipt({
  runtimePath,
  releaseRoot,
  lock,
  buildEvidence,
  runtimeMarker,
  validateOwnedRuntime,
  fs = { lstat, readFile, writeFile, realpath, link, unlink },
}) {
  if (typeof validateOwnedRuntime !== 'function') throw new Error('必须使用产品的 owned runtime 校验器。')
  if (!buildEvidence || buildEvidence.patchesApplied !== true || buildEvidence.officialBuildExitCode !== 0
    || buildEvidence.sourceCommit !== lock?.upstream?.commit
    || buildEvidence.patchSetSha256 !== patchSetDigest(lock?.patches ?? {})
    || typeof buildEvidence.builder !== 'string' || buildEvidence.builder.trim() === '') {
    throw new Error('receipt 需要外部 builder 的 patch 应用、官方 build 成功及 pinned source 证据。')
  }
  const runtime = await validateOwnedRuntime(runtimePath, releaseRoot)
  if (await fs.realpath(runtime) !== path.resolve(runtime)) throw new Error('receipt runtime realpath 不匹配。')
  const compiledFiles = Object.create(null)
  for (const relative of RECEIPT_FILES) compiledFiles[relative] = await hashOrdinaryFile(runtime, relative, fs)
  const receipt = {
    schemaVersion: 1,
    sourceCommit: lock.upstream.commit,
    runtimeMarker,
    patchSetSha256: buildEvidence.patchSetSha256,
    compiledFiles,
    bootstrap: { schemaVersion: 1, buildEvidence: { ...buildEvidence } },
  }
  const destination = path.join(runtime, RECEIPT_NAME)
  const temporary = path.join(runtime, `${RECEIPT_NAME}.tmp-${process.pid}-${randomUUID()}`)
  try {
    await fs.writeFile(temporary, `${JSON.stringify(receipt, null, 2)}\n`, { flag: 'wx' })
    await fs.link(temporary, destination)
  } finally {
    await fs.unlink(temporary).catch(error => {
      if (error.code !== 'ENOENT') throw error
    })
  }
  return { path: destination, receipt }
}
