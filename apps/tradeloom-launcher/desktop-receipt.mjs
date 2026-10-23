import { createHash } from 'node:crypto'
import { lstat, readFile } from 'node:fs/promises'
import path from 'node:path'
import { runtimeMarkerContents, trustedReleaseRoot, validateOwnedRuntime } from './prepare-profile.mjs'

export const desktopReceiptName = '.tradeloom-desktop-build-receipt.json'
export const desktopReceiptFiles = ['apps/desktop/lib/main.js', 'apps/desktop-host/lib/index.js']
export const desktopDevelopmentDescriptor = 'apps/desktop/.desktop-build/development/project/desktop-runtime.json'
export const desktopAppManifest = 'apps/desktop/package.json'
export const desktopAppId = 'cn.tradeloom.workbench'

export function expectedPatchSetDigest(patches) {
  return createHash('sha256').update(JSON.stringify(Object.entries(patches).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0))).digest('hex')
}

/** Ensure source-mode Electron reads the TradeLoom identity from its real app manifest. */
export async function assertTradeLoomDesktopAppIdentity(runtimePath) {
  const runtime = path.resolve(runtimePath)
  const manifestPath = path.join(runtime, ...desktopAppManifest.split('/'))
  try {
    await assertOrdinaryPath(runtime, manifestPath)
  } catch (error) {
    if (error.code === 'ENOENT') throw new Error('桌面应用身份缺失；请先应用织贸助手品牌补丁。')
    throw error
  }
  const info = await lstat(manifestPath)
  if (!info.isFile() || info.isSymbolicLink()) throw new Error('桌面应用清单必须是普通文件。')
  let manifest
  try { manifest = JSON.parse(await readFile(manifestPath, 'utf8')) }
  catch { throw new Error('桌面应用清单无效；请先应用织贸助手品牌补丁。') }
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest) || manifest.dshDesktopAppId !== desktopAppId) {
    throw new Error('桌面应用身份与织贸助手不匹配；请先应用织贸助手品牌补丁。')
  }
  return manifestPath
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

/** Check the upstream development project descriptor required by the source-mode desktop host. */
export async function assertDesktopDevelopmentProjectReady(runtimePath) {
  const runtime = path.resolve(runtimePath)
  const descriptorPath = path.join(runtime, ...desktopDevelopmentDescriptor.split('/'))
  try {
    await assertOrdinaryPath(runtime, descriptorPath)
  } catch (error) {
    if (error.code === 'ENOENT') {
      throw new Error('桌面开发 project 尚未准备（缺少 desktop-runtime.json）；请先单独执行上游 prepareDevelopmentProject。')
    }
    throw error
  }
  const info = await lstat(descriptorPath)
  if (!info.isFile() || info.isSymbolicLink()) throw new Error('桌面开发 project descriptor 必须是普通文件。')
  let descriptor
  try { descriptor = JSON.parse(await readFile(descriptorPath, 'utf8')) }
  catch { throw new Error('桌面开发 project descriptor 无法读取；请重新执行上游 prepareDevelopmentProject。') }
  if (!descriptor || typeof descriptor !== 'object' || Array.isArray(descriptor)
    || descriptor.schemaVersion !== 1 || typeof descriptor.platform !== 'string' || typeof descriptor.arch !== 'string'
    || !descriptor.release || typeof descriptor.release !== 'object' || Array.isArray(descriptor.release)
    || typeof descriptor.release.version !== 'string' || typeof descriptor.release.nodeVersion !== 'string'
    || typeof descriptor.release.pnpmVersion !== 'string' || !Array.isArray(descriptor.sharedPackages)
    || !Array.isArray(descriptor.files)) {
    throw new Error('桌面开发 project descriptor 格式无效；请重新执行上游 prepareDevelopmentProject。')
  }
  return descriptorPath
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
  await validateOwnedRuntime(runtime, releaseRoot)
  return receipt
}
