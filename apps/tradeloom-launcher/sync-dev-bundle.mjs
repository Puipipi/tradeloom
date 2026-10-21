import { cp, lstat, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { ensureOwnedHome, launcherPipeName, reserveNamedPipe } from './core.mjs'
import { assertNoReparseAncestors, hashTree, packageName, profileBundles, sourcePackage, validateOwnedRuntime } from './prepare-profile.mjs'

async function readOrdinaryFile(file, label) {
  const info = await lstat(file)
  if (!info.isFile() || info.isSymbolicLink()) throw new Error(`${label} 必须是普通文件。`)
  return readFile(file, 'utf8')
}

async function assertBundleDir(dir, root, files) {
  await assertNoReparseAncestors(dir, root)
  const info = await lstat(dir)
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`拒绝非普通自有 bundle 目录：${dir}`)
  return hashTree(dir, files)
}

async function bundleFilesAtDestination(dir, root) {
  await assertBundleDir(dir, root, ['package.json'])
  const manifest = JSON.parse(await readOrdinaryFile(path.join(dir, 'package.json'), '自有 bundle package.json'))
  if (manifest.name !== packageName || !Array.isArray(manifest.files)) throw new Error(`自有 bundle package identity 无效：${dir}`)
  const files = ['package.json', ...manifest.files]
  if (files.some(file => typeof file !== 'string' || !file || path.posix.isAbsolute(file) || file.includes('\\')
    || file.split('/').some(part => !part || part === '.' || part === '..')) || new Set(files).size !== files.length) {
    throw new Error(`自有 bundle files 清单无效：${dir}`)
  }
  return files
}

async function copyBundle(source, stage, files, expectedHash) {
  await cp(source, stage, {
    recursive: true,
    errorOnExist: true,
    force: false,
    filter: entry => {
      const rel = path.relative(source, entry).replaceAll('\\', '/')
      return rel === '' || rel === 'package.json' || files.some(file => rel === file || rel.startsWith(`${file}/`) || file.startsWith(`${rel}/`))
    },
  })
  if (await hashTree(stage, files) !== expectedHash) throw new Error('bundle staging hash mismatch。')
}

/**
 * Explicitly synchronize only the TradeLoom bundle copies for an existing, owned profile.
 * `validateRuntime` is injectable so filesystem transaction tests can use isolated fixtures.
 */
export async function syncDevBundle({
  runtimePath,
  home,
  mode = 'web',
  validateRuntime = validateOwnedRuntime,
  source = sourcePackage,
  transactionId = `${process.pid}-${Date.now()}`,
  beforeRecordCommit,
}) {
  if (!['web', 'desktop'].includes(mode)) throw new Error('启动模式只支持 web 或 desktop。')
  const runtime = await validateRuntime(runtimePath)
  const homePath = await ensureOwnedHome(home)
  const profileName = mode === 'desktop' ? 'desktop' : 'tradeloom'
  const profileDir = path.join(homePath, 'profiles', profileName)
  const profileManifestPath = path.join(profileDir, 'package.json')
  await assertNoReparseAncestors(profileDir, homePath)
  const profileInfo = await lstat(profileDir)
  if (!profileInfo.isDirectory() || profileInfo.isSymbolicLink()) throw new Error(`拒绝非普通 ${profileName} profile 目录。`)
  const profileManifest = JSON.parse(await readOrdinaryFile(profileManifestPath, 'profile package.json'))
  const bundles = profileManifest.dsh?.profile?.bundles
  if (!Array.isArray(bundles) || profileBundles.some((name, index) => bundles[index] !== name)) {
    throw new Error(`已有 ${profileName} profile 不符合织贸助手完整 bundle 顺序；拒绝同步。`)
  }

  const manifest = JSON.parse(await readOrdinaryFile(path.join(source, 'package.json'), 'TradeLoom bundle manifest'))
  if (manifest.name !== packageName || !Array.isArray(manifest.files)) throw new Error('TradeLoom bundle package identity 无效。')
  const files = ['package.json', ...manifest.files]
  if (files.some(file => typeof file !== 'string' || !file || path.posix.isAbsolute(file) || file.includes('\\')
    || file.split('/').some(part => !part || part === '.' || part === '..')) || new Set(files).size !== files.length) {
    throw new Error('TradeLoom bundle files 清单无效。')
  }
  const sourceHash = await hashTree(source, files)
  const runtimeDest = path.join(runtime, 'node_modules', ...packageName.split('/'))
  const profileDest = path.join(profileDir, 'node_modules', ...packageName.split('/'))
  const recordPath = path.join(homePath, `tradeloom-launcher-${profileName}.json`)
  const record = JSON.parse(await readOrdinaryFile(recordPath, 'TradeLoom runtime/profile record'))
  if (record.schema !== 1 || record.packageName !== packageName || record.profile !== profileName
    || path.resolve(record.runtime).toLowerCase() !== path.resolve(runtime).toLowerCase()
    || !/^[0-9a-f]{64}$/i.test(record.bundleHash ?? '')) {
    throw new Error('TradeLoom 本地 runtime/profile 记录与所选自有 profile 不匹配；拒绝同步。')
  }

  const priorHash = record.bundleHash.toLowerCase()
  const allowedHashes = new Set([priorHash, sourceHash])
  for (const [destination, root] of [[runtimeDest, runtime], [profileDest, profileDir]]) {
    const destinationFiles = await bundleFilesAtDestination(destination, root)
    const actual = await assertBundleDir(destination, root, destinationFiles)
    if (!allowedHashes.has(actual.toLowerCase())) {
      throw new Error(`自有 bundle 既非记录版本也非当前源码版本；拒绝覆盖：${destination}`)
    }
  }
  const nextRecord = { schema: 1, runtime: path.resolve(runtime), packageName, bundleHash: sourceHash, profile: profileName }
  if (JSON.stringify(record) === JSON.stringify(nextRecord)) return { runtime, profileDir, bundleHash: sourceHash, changed: false }

  await assertNoReparseAncestors(runtimeDest, runtime)
  await assertNoReparseAncestors(profileDest, profileDir)
  const runtimeStage = path.join(path.dirname(runtimeDest), `.tradeloom-bundle-stage-${transactionId}`)
  const profileStage = path.join(path.dirname(profileDest), `.tradeloom-bundle-stage-${transactionId}`)
  const recordStage = path.join(homePath, `.tradeloom-profile-record-stage-${transactionId}`)
  const runtimeBackup = `${runtimeDest}.backup-${transactionId}`
  const profileBackup = `${profileDest}.backup-${transactionId}`
  const recordBackup = `${recordPath}.backup-${transactionId}`
  for (const pathToCheck of [runtimeStage, profileStage, recordStage, runtimeBackup, profileBackup, recordBackup]) {
    try { await lstat(pathToCheck); throw new Error(`同步事务路径已存在，拒绝覆盖：${pathToCheck}`) }
    catch (error) { if (error.code !== 'ENOENT') throw error }
  }
  await mkdir(path.dirname(runtimeDest), { recursive: true })
  await mkdir(path.dirname(profileDest), { recursive: true })
  let runtimeBackedUp = false
  let profileBackedUp = false
  let recordBackedUp = false
  let runtimeInstalled = false
  let profileInstalled = false
  let recordInstalled = false
  try {
    await copyBundle(source, runtimeStage, files, sourceHash)
    await copyBundle(source, profileStage, files, sourceHash)
    await writeFile(recordStage, `${JSON.stringify(nextRecord, null, 2)}\n`, { flag: 'wx' })

    await rename(runtimeDest, runtimeBackup); runtimeBackedUp = true
    await rename(profileDest, profileBackup); profileBackedUp = true
    await rename(runtimeStage, runtimeDest); runtimeInstalled = true
    await rename(profileStage, profileDest); profileInstalled = true
    if (beforeRecordCommit) await beforeRecordCommit()
    await rename(recordPath, recordBackup); recordBackedUp = true
    await rename(recordStage, recordPath); recordInstalled = true
  } catch (error) {
    if (recordInstalled) await rm(recordPath, { force: true }).catch(() => {})
    if (recordBackedUp) await rename(recordBackup, recordPath).catch(() => {})
    if (runtimeInstalled) await rm(runtimeDest, { recursive: true, force: true }).catch(() => {})
    if (profileInstalled) await rm(profileDest, { recursive: true, force: true }).catch(() => {})
    if (runtimeBackedUp) await rename(runtimeBackup, runtimeDest).catch(() => {})
    if (profileBackedUp) await rename(profileBackup, profileDest).catch(() => {})
    throw error
  } finally {
    await Promise.all([
      rm(runtimeStage, { recursive: true, force: true }),
      rm(profileStage, { recursive: true, force: true }),
      rm(recordStage, { force: true }),
    ])
  }
  await Promise.all([
    rm(runtimeBackup, { recursive: true, force: true }).catch(() => {}),
    rm(profileBackup, { recursive: true, force: true }).catch(() => {}),
    rm(recordBackup, { force: true }).catch(() => {}),
  ])
  return { runtime, profileDir, bundleHash: sourceHash, changed: true }
}

export async function syncDevBundleExclusive(options, { reserve = reserveNamedPipe, synchronize = syncDevBundle } = {}) {
  const home = await ensureOwnedHome(options.home)
  const lock = await reserve(launcherPipeName(home))
  try { return await synchronize({ ...options, home }) }
  finally { await new Promise(resolve => lock.close(resolve)) }
}
