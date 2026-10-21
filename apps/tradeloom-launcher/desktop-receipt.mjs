import { createHash } from 'node:crypto'
import { lstat, readFile, realpath } from 'node:fs/promises'
import path from 'node:path'
import { runtimeMarkerContents, trustedReleaseRoot, validateOwnedRuntime } from './prepare-profile.mjs'

export const desktopReceiptName = '.tradeloom-desktop-build-receipt.json'
export const desktopReceiptFiles = ['apps/desktop/lib/main.js', 'apps/desktop-host/lib/index.js']

export function expectedPatchSetDigest(patches) {
  return createHash('sha256').update(JSON.stringify(Object.entries(patches).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0))).digest('hex')
}

async function assertOrdinaryPath(runtime, target) {
  const relative = path.relative(runtime, target)
  if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('compiled desktop target 越出受控 runtime。')
  const parts = relative.split(path.sep)
  let current = runtime
  for (const part of parts) {
    current = path.join(current, part)
    const info = await lstat(current)
    if (info.isSymbolicLink()) throw new Error(`compiled desktop 路径含链接祖先：${current}`)
    if (current !== target && !info.isDirectory()) throw new Error(`compiled desktop 祖先不是普通目录：${current}`)
  }
}

export async function verifyDesktopBuildReceipt(runtimePath, lock, releaseRoot = trustedReleaseRoot) {
  const runtime = await validateOwnedRuntime(runtimePath, releaseRoot)
  const receiptPath = path.join(runtime, desktopReceiptName)
  const info = await lstat(receiptPath).catch(error => {
    if (error.code === 'ENOENT') throw new Error('桌面构建凭证缺失；拒绝启动未经本补丁集构建的 Electron release。')
    throw error
  })
  if (!info.isFile() || info.isSymbolicLink()) throw new Error('桌面构建凭证必须是普通文件。')
  const receipt = JSON.parse(await readFile(receiptPath, 'utf8'))
  if (receipt.schemaVersion !== 1 || receipt.sourceCommit !== lock.upstream.commit
    || receipt.runtimeMarker !== runtimeMarkerContents
    || receipt.patchSetSha256 !== expectedPatchSetDigest(lock.patches)) {
    throw new Error('桌面构建凭证与当前 pinned source/patch lock 不匹配。')
  }
  for (const relative of desktopReceiptFiles) {
    const expected = receipt.compiledFiles?.[relative]
    if (!/^[0-9a-f]{64}$/i.test(expected ?? '')) throw new Error(`桌面构建凭证缺少 compiled hash：${relative}`)
    const file = path.join(runtime, relative)
    await assertOrdinaryPath(runtime, file)
    const fileInfo = await lstat(file)
    if (!fileInfo.isFile() || fileInfo.isSymbolicLink()) throw new Error(`compiled desktop target 不是普通文件：${relative}`)
    const actual = createHash('sha256').update(await readFile(file)).digest('hex')
    if (actual !== expected.toLowerCase()) throw new Error(`compiled desktop hash 与构建凭证不匹配：${relative}`)
  }
  if (await realpath(runtime) !== runtime) throw new Error('desktop runtime realpath 不匹配。')
  return receipt
}
