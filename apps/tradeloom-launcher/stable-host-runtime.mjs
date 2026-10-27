import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { copyFile, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { isDeepStrictEqual } from 'node:util'
import { ensureOwnedDirectory, getDefaultPaths } from './core.mjs'
import { verifyDesktopBuildReceipt } from './desktop-receipt.mjs'
import { trustedReleaseRoot, validateOwnedRuntime } from './prepare-profile.mjs'

const moduleRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const lockPath = path.join(moduleRoot, 'integrations/dsh/patches/patches.lock.json')
const stableRootName = 'stable-host-runtime'
const stableRootMarker = '.tradeloom-stable-host-owned'
const stableRootMarkerContents = 'tradeloom-stable-host-runtime-v1\n'
const enginesDirectoryName = 'engines'
const enginesMarker = '.tradeloom-stable-engines-owned'
const enginesMarkerContents = 'tradeloom-stable-host-engines-v1\n'
const engineManifestName = '.tradeloom-engine-manifest.json'
const engineMarkerName = '.tradeloom-engine-owned'
const engineMarkerContents = 'tradeloom-stable-electron-engine-v1\n'
const stagePrefix = '.electron-stage-'

function sameCanonical(left, right) {
  const a = path.resolve(left)
  const b = path.resolve(right)
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b
}

function assertWithin(root, target, label) {
  const relative = path.relative(root, target)
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`${label} 越出受控目录。`)
  }
  return relative
}

async function assertOrdinaryDirectory(root, target) {
  const relative = assertWithin(root, target, 'Electron 路径')
  let current = root
  for (const part of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, part)
    const info = await lstat(current)
    if (info.isSymbolicLink()) throw new Error(`Electron 路径包含链接/reparse point：${current}`)
    if (!info.isDirectory()) throw new Error(`Electron 路径祖先不是普通目录：${current}`)
  }
  if (!sameCanonical(await realpath(target), target)) throw new Error('Electron dist realpath 不匹配。')
}

async function assertOrdinaryAncestors(target, stopAt) {
  let current = path.resolve(target)
  const stop = path.resolve(stopAt)
  while (true) {
    try {
      const info = await lstat(current)
      if (info.isSymbolicLink()) throw new Error(`拒绝 stable engine 链接/reparse 路径：${current}`)
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
    }
    if (sameCanonical(current, stop)) return
    const parent = path.dirname(current)
    if (sameCanonical(parent, current)) throw new Error('stable engine 路径没有到达受控根目录。')
    current = parent
  }
}

function safeRelativePath(relative) {
  if (typeof relative !== 'string' || !relative || relative.startsWith('/') || relative.includes('\\') || relative.includes(':')
    || relative.split('/').some(part => !part || part === '.' || part === '..' || part.includes('\0'))) {
    throw new Error(`Electron dist 包含无效相对路径：${relative}`)
  }
  return relative
}

async function hashFile(file) {
  const hash = createHash('sha256')
  let bytes = 0
  await new Promise((resolve, reject) => {
    const stream = createReadStream(file)
    stream.on('data', chunk => { bytes += chunk.length; hash.update(chunk) })
    stream.once('error', reject)
    stream.once('end', resolve)
  })
  return { bytes, sha256: hash.digest('hex') }
}

async function walkOrdinaryFiles(root, prefix = '') {
  const result = []
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const relative = safeRelativePath(prefix ? `${prefix}/${entry.name}` : entry.name)
    const fullPath = path.join(root, entry.name)
    const info = await lstat(fullPath)
    if (info.isSymbolicLink()) throw new Error(`Electron dist 包含链接/reparse point：${relative}`)
    if (info.isDirectory()) result.push(...await walkOrdinaryFiles(fullPath, relative))
    else if (info.isFile()) result.push({ path: relative, fullPath })
    else throw new Error(`Electron dist 包含非普通文件：${relative}`)
  }
  return result
}

function engineDigest(files) {
  const canonical = [...files].sort((a, b) => a.path.localeCompare(b.path, 'en'))
    .map(item => `${item.path}\0${item.bytes}\0${item.sha256}\n`).join('')
  return createHash('sha256').update(canonical, 'utf8').digest('hex')
}

async function inventoryTree(root, { excludeMetadata = false } = {}) {
  const actual = await walkOrdinaryFiles(root)
  const files = []
  for (const item of actual) {
    if (excludeMetadata && (item.path === engineManifestName || item.path === engineMarkerName)) continue
    files.push({ path: item.path, ...(await hashFile(item.fullPath)) })
  }
  return files.sort((a, b) => a.path.localeCompare(b.path, 'en'))
}

function expectedEngineManifest(files) {
  return { schemaVersion: 1, engineSha256: engineDigest(files), files }
}

async function verifyExistingEngine(destination, expected) {
  const info = await lstat(destination).catch(error => {
    if (error.code === 'ENOENT') return null
    throw error
  })
  if (!info) return false
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('稳定 Electron 版本目录不是普通目录。')
  const marker = path.join(destination, engineMarkerName)
  const markerInfo = await lstat(marker)
  if (!markerInfo.isFile() || markerInfo.isSymbolicLink() || await readFile(marker, 'utf8') !== engineMarkerContents) {
    throw new Error('稳定 Electron 版本目录缺少有效 ownership marker。')
  }
  const manifestFile = path.join(destination, engineManifestName)
  const manifestInfo = await lstat(manifestFile)
  if (!manifestInfo.isFile() || manifestInfo.isSymbolicLink()) throw new Error('稳定 Electron manifest 不是普通文件。')
  let manifest
  try { manifest = JSON.parse(await readFile(manifestFile, 'utf8')) }
  catch { throw new Error('稳定 Electron manifest 无效。') }
  if (!isDeepStrictEqual(manifest, expected)) throw new Error('稳定 Electron engine 与候选版本 manifest 不一致。')
  const actual = await inventoryTree(destination, { excludeMetadata: true })
  if (!isDeepStrictEqual(actual, expected.files) || engineDigest(actual) !== expected.engineSha256) {
    throw new Error('稳定 Electron engine 文件与 manifest 不匹配。')
  }
  if (!actual.some(item => item.path.toLowerCase() === 'electron.exe')) throw new Error('稳定 Electron engine 缺少 electron.exe。')
  return true
}

async function verifyCandidateReceipt(runtime, validatedReceipt, releaseRoot) {
  const lock = JSON.parse(await readFile(lockPath, 'utf8'))
  const actualReceipt = await verifyDesktopBuildReceipt(runtime, lock, releaseRoot)
  if (!isDeepStrictEqual(validatedReceipt, actualReceipt)) throw new Error('传入的 validated receipt 与候选 runtime 当前 receipt 不一致。')
  return actualReceipt
}

async function prepareCandidateInventory(runtime) {
  const resolved = await resolveCandidateElectronDist(runtime)
  const { dist } = resolved
  const files = await inventoryTree(dist)
  if (!files.length || !files.some(item => item.path.toLowerCase() === 'electron.exe')) {
    throw new Error('候选 Electron dist 缺少 electron.exe 或文件为空。')
  }
  return { ...resolved, manifest: expectedEngineManifest(files) }
}

async function assertOrdinaryFile(root, target) {
  const relative = assertWithin(root, target, 'Electron package manifest 路径')
  let current = root
  const parts = relative.split(path.sep)
  for (let index = 0; index < parts.length; index += 1) {
    current = path.join(current, parts[index])
    const info = await lstat(current)
    if (info.isSymbolicLink()) throw new Error(`Electron package manifest 路径包含链接/reparse point：${current}`)
    if (index < parts.length - 1 && !info.isDirectory()) throw new Error('Electron package manifest 祖先不是普通目录。')
    if (index === parts.length - 1 && !info.isFile()) throw new Error('Electron package.json 不是普通文件。')
  }
}

async function resolveCandidateElectronDist(runtime) {
  const desktopNodeModules = path.join(runtime, 'apps', 'desktop', 'node_modules')
  await assertOrdinaryDirectory(runtime, desktopNodeModules)
  const electronEntry = path.join(desktopNodeModules, 'electron')
  const entryInfo = await lstat(electronEntry).catch(error => {
    if (error.code === 'ENOENT') throw new Error('候选 runtime 缺少固定 Electron package 入口。')
    throw error
  })
  if (!entryInfo.isDirectory() && !entryInfo.isSymbolicLink()) throw new Error('固定 Electron package 入口不是目录或受控链接。')

  const packageRoot = entryInfo.isSymbolicLink() ? await realpath(electronEntry) : electronEntry
  assertWithin(runtime, packageRoot, 'Electron package canonical target')
  if (entryInfo.isSymbolicLink()) {
    const relativePackage = path.relative(runtime, packageRoot).replaceAll('\\', '/')
    if (!/^node_modules\/\.pnpm\/electron@[^/]+\/node_modules\/electron$/i.test(relativePackage)) {
      throw new Error('Electron package link 未解析到候选 runtime 内的 pnpm electron package。')
    }
  }
  await assertOrdinaryDirectory(runtime, packageRoot)

  const packageManifestPath = path.join(packageRoot, 'package.json')
  await assertOrdinaryFile(runtime, packageManifestPath)
  let packageManifest
  try { packageManifest = JSON.parse(await readFile(packageManifestPath, 'utf8')) }
  catch { throw new Error('候选 Electron package.json 无效。') }
  if (!packageManifest || typeof packageManifest !== 'object' || Array.isArray(packageManifest)
    || packageManifest.name !== 'electron' || typeof packageManifest.version !== 'string' || packageManifest.version.length === 0) {
    throw new Error('固定 Electron package 入口身份不匹配。')
  }

  const dist = path.join(packageRoot, 'dist')
  await assertOrdinaryDirectory(runtime, dist)
  return { dist, packageRoot, packageVersion: packageManifest.version }
}

async function copyIntoStage(sourceRoot, stage, files, copyFileImpl) {
  for (const item of files) {
    const target = path.join(stage, ...item.path.split('/'))
    const relativeParent = path.relative(stage, path.dirname(target))
    if (relativeParent.startsWith('..') || path.isAbsolute(relativeParent)) throw new Error('Electron stage 路径越界。')
    await mkdir(path.dirname(target), { recursive: true })
    const source = path.join(sourceRoot, ...item.path.split('/'))
    const sourceInfo = await lstat(source)
    if (!sourceInfo.isFile() || sourceInfo.isSymbolicLink()) throw new Error(`Electron 源文件在复制前发生变化：${item.path}`)
    await copyFileImpl(source, target)
    const copied = await hashFile(target)
    if (!isDeepStrictEqual(copied, { bytes: item.bytes, sha256: item.sha256 })) throw new Error(`Electron stage 文件校验失败：${item.path}`)
  }
}

async function cleanupStage(stage, enginesRoot) {
  if (!stage) return
  const relative = assertWithin(enginesRoot, path.resolve(stage), 'Electron stage 清理路径')
  if (!relative.startsWith(stagePrefix) || relative.includes(path.sep)) throw new Error('拒绝清理非本次创建的 Electron stage。')
  const info = await lstat(stage).catch(error => error.code === 'ENOENT' ? null : Promise.reject(error))
  if (info?.isSymbolicLink() || (info && !info.isDirectory())) throw new Error('拒绝清理非普通 Electron stage。')
  if (info) await rm(stage, { recursive: true, force: false })
}

async function ensureStableOwnedDirectory(target, marker, contents) {
  try { return await ensureOwnedDirectory(target, marker, contents) }
  catch (error) {
    if (error.code !== 'EEXIST') throw error
    return ensureOwnedDirectory(target, marker, contents)
  }
}

/**
 * Prepare a byte-verified Electron engine copy under the app-owned stable root.
 * This function does not launch Electron or change process state.
 */
export async function prepareStableHostRuntime({ candidateRuntime, validatedReceipt, managedRoot, env = process.env, releaseRoot = trustedReleaseRoot,
  copyFileImpl = copyFile } = {}) {
  if (typeof candidateRuntime !== 'string' || !path.isAbsolute(candidateRuntime)) throw new Error('candidateRuntime 必须是 launcher 提供的绝对 runtime 路径。')
  if (typeof managedRoot !== 'string' || !path.isAbsolute(managedRoot)) throw new Error('managedRoot 必须是 launcher 提供的绝对路径。')
  if (typeof copyFileImpl !== 'function') throw new TypeError('copyFileImpl 必须是文件复制函数。')

  const plan = await inspectCandidatePlan(candidateRuntime, validatedReceipt, releaseRoot)
  const { runtime, receipt, dist, packageRoot, packageVersion, manifest } = plan
  const paths = getDefaultPaths(env)
  const expectedManagedRoot = path.join(paths.dataRoot, stableRootName)
  if (!sameCanonical(managedRoot, expectedManagedRoot)) throw new Error('managedRoot 必须是 TradeLoom app-owned stable-host-runtime 目录。')

  const ownedRoot = await ensureStableOwnedDirectory(expectedManagedRoot, stableRootMarker, stableRootMarkerContents)
  const enginesRoot = await ensureStableOwnedDirectory(path.join(ownedRoot, enginesDirectoryName), enginesMarker, enginesMarkerContents)
  const versionRoot = path.join(enginesRoot, manifest.engineSha256)
  await assertOrdinaryAncestors(versionRoot, enginesRoot)
  if (await verifyExistingEngine(versionRoot, manifest)) {
    return {
      electronExe: path.join(versionRoot, 'electron.exe'),
      engineManifest: path.join(versionRoot, engineManifestName),
      engineSha256: manifest.engineSha256,
      files: manifest.files,
      electronPackageVersion: packageVersion,
      candidateElectronPackage: path.relative(runtime, packageRoot).replaceAll('\\', '/'),
      candidateRuntime: runtime,
      candidateReceipt: receipt,
    }
  }

  const stage = await mkdtemp(path.join(enginesRoot, stagePrefix))
  try {
    await copyIntoStage(dist, stage, manifest.files, copyFileImpl)
    const stagedFiles = await inventoryTree(stage)
    if (!isDeepStrictEqual(stagedFiles, manifest.files) || engineDigest(stagedFiles) !== manifest.engineSha256) {
      throw new Error('Electron stage 完整性校验失败。')
    }
    await writeFile(path.join(stage, engineManifestName), `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx' })
    await writeFile(path.join(stage, engineMarkerName), engineMarkerContents, { flag: 'wx' })
    await assertOrdinaryAncestors(stage, enginesRoot)
    try {
      await rename(stage, versionRoot)
    } catch (error) {
      if (!['EEXIST', 'ENOTEMPTY'].includes(error.code) || !await verifyExistingEngine(versionRoot, manifest)) throw error
    }
  } finally {
    await cleanupStage(stage, enginesRoot)
  }

  if (!await verifyExistingEngine(versionRoot, manifest)) throw new Error('Electron engine 发布后未落盘。')
  return {
    electronExe: path.join(versionRoot, 'electron.exe'),
    engineManifest: path.join(versionRoot, engineManifestName),
    engineSha256: manifest.engineSha256,
    files: manifest.files,
    electronPackageVersion: packageVersion,
    candidateElectronPackage: path.relative(runtime, packageRoot).replaceAll('\\', '/'),
    candidateRuntime: runtime,
    candidateReceipt: receipt,
  }
}

async function inspectCandidatePlan(candidateRuntime, validatedReceipt, releaseRoot) {
  if (typeof candidateRuntime !== 'string' || !path.isAbsolute(candidateRuntime)) throw new Error('candidateRuntime 必须是 launcher 提供的绝对 runtime 路径。')
  const runtime = await validateOwnedRuntime(candidateRuntime, releaseRoot)
  if (!sameCanonical(runtime, candidateRuntime)) throw new Error('candidateRuntime 必须使用 canonical runtime 路径。')
  const receipt = await verifyCandidateReceipt(runtime, validatedReceipt, releaseRoot)
  const { dist, packageRoot, packageVersion, manifest } = await prepareCandidateInventory(runtime)
  return { runtime, receipt, dist, packageRoot, packageVersion, manifest }
}

/** Read-only plan inspection. It validates and hashes the candidate without creating or copying anything. */
export async function inspectStableHostRuntimePlan({ candidateRuntime, validatedReceipt, releaseRoot = trustedReleaseRoot } = {}) {
  const { runtime, receipt, packageRoot, packageVersion, dist, manifest } = await inspectCandidatePlan(candidateRuntime, validatedReceipt, releaseRoot)
  return {
    sourceCommit: receipt.sourceCommit,
    electronPackageVersion: packageVersion,
    electronPackageRelative: path.relative(runtime, packageRoot).replaceAll('\\', '/'),
    electronDistRelative: path.relative(runtime, dist).replaceAll('\\', '/'),
    electronExeRelative: path.posix.join(path.relative(runtime, dist).replaceAll('\\', '/'), 'electron.exe'),
    engineSha256: manifest.engineSha256,
    fileCount: manifest.files.length,
    totalBytes: manifest.files.reduce((total, item) => total + item.bytes, 0),
    files: manifest.files,
  }
}

export const stableHostRuntimePaths = Object.freeze({ stableRootName, enginesDirectoryName, engineManifestName })
