import { createHash } from 'node:crypto'
import { cp, mkdir, readFile, writeFile, lstat, realpath, rename, rm, stat } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { ensureOwnedDirectory, ensureOwnedHome } from './core.mjs'

export const sourcePackage = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../packages/tradeloom-shell')
export const packageName = '@tradeloom/dsh-business-shell'
const profileName = 'tradeloom'
export const profileBundles = ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', packageName]
const pinnedCommit = '687f282e8625c6b8d11ff58211a90524be2e4317'
export const runtimeMarkerName = '.tradeloom-runtime-owned'
export const runtimeMarkerContents = `tradeloom-dsh-runtime-v1\n${pinnedCommit}\n`
const workspaceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
export const trustedReleaseRoot = path.join(workspaceRoot, 'workspace', 'runtime', 'tradeloom-harness', 'releases')

export async function assertNoReparseAncestors(target, stopAt) {
  let current = path.resolve(target)
  const stop = path.resolve(stopAt)
  while (true) {
    try {
      const info = await lstat(current)
      if (info.isSymbolicLink()) throw new Error(`拒绝 runtime 链接路径：${current}`)
    } catch (error) { if (error.code !== 'ENOENT') throw error }
    if (current.toLowerCase() === stop.toLowerCase()) break
    const parent = path.dirname(current)
    const relative = path.relative(stop, current)
    if (parent === current || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      throw new Error('runtime 路径不在固定 TradeLoom releases 根目录下。')
    }
    current = parent
  }
}

export async function sameDirectoryIdentity(left, right, statFn = stat) {
  if (path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase()) return true
  let leftInfo
  let rightInfo
  try {
    ;[leftInfo, rightInfo] = await Promise.all([
      statFn(left, { bigint: true }), statFn(right, { bigint: true }),
    ])
  } catch (error) {
    if (['ENOENT', 'ENOTDIR', 'EACCES', 'EPERM'].includes(error.code)) return false
    throw error
  }
  return leftInfo.isDirectory() && rightInfo.isDirectory()
    && leftInfo.dev !== 0n && leftInfo.ino !== 0n
    && leftInfo.dev === rightInfo.dev && leftInfo.ino === rightInfo.ino
}

export async function validateOwnedRuntime(runtimePath, releaseRoot = trustedReleaseRoot) {
  if (!path.isAbsolute(runtimePath) || !path.isAbsolute(releaseRoot)) throw new Error('runtime/release 路径必须是绝对路径。')
  const root = path.resolve(releaseRoot)
  const runtime = path.resolve(runtimePath)
  if (!(await sameDirectoryIdentity(path.dirname(runtime), root)) || path.basename(runtime) === '') {
    throw new Error('runtime 必须是固定 TradeLoom releases 根下的单版本目录。')
  }
  await assertNoReparseAncestors(root, path.parse(root).root)
  await assertNoReparseAncestors(runtime, path.parse(runtime).root)
  const runtimeInfo = await lstat(runtime)
  if (!runtimeInfo.isDirectory() || runtimeInfo.isSymbolicLink()) throw new Error('runtime 必须是普通目录。')
  const marker = path.join(runtime, runtimeMarkerName)
  const markerInfo = await lstat(marker).catch(error => {
    if (error.code === 'ENOENT') throw new Error('runtime 缺少普通 TradeLoom ownership marker。')
    throw error
  })
  if (!markerInfo.isFile() || markerInfo.isSymbolicLink()) throw new Error('runtime 缺少普通 TradeLoom ownership marker。')
  if (await readFile(marker, 'utf8') !== runtimeMarkerContents) throw new Error('runtime ownership marker 或 pinned commit 不匹配。')
  const resolvedRuntime = await realpath(runtime)
  if (!(await sameDirectoryIdentity(resolvedRuntime, runtime))
    || !(await sameDirectoryIdentity(path.dirname(resolvedRuntime), root))) {
    throw new Error('runtime realpath 不匹配。')
  }
  return runtime
}

export async function hashTree(dir, files) {
  const hash = createHash('sha256')
  for (const file of [...files].sort()) {
    hash.update(file.replaceAll('\\', '/')).update('\0').update(await readFile(path.join(dir, file)))
  }
  return hash.digest('hex')
}

export async function bundleDestinationIsCurrent(destination, expectedHash, files) {
  let info
  try { info = await lstat(destination) }
  catch (error) { if (error.code === 'ENOENT') return false; throw error }
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('织贸助手 bundle destination 必须是普通目录。')
  const actual = await hashTree(destination, files)
  if (actual !== expectedHash) throw new Error('织贸助手 bundle 已存在且内容不匹配；拒绝覆盖版本化 runtime 文件。')
  return true
}

async function ensureExactBundleCopy(source, destination, files, expectedHash, scopeRoot) {
  if (await bundleDestinationIsCurrent(destination, expectedHash, files)) return
  await assertNoReparseAncestors(destination, scopeRoot)
  await mkdir(path.dirname(destination), { recursive: true })
  await assertNoReparseAncestors(destination, scopeRoot)
  const stage = path.join(path.dirname(destination), `.tradeloom-bundle-${process.pid}-${Date.now()}`)
  try {
    await cp(source, stage, { recursive: true, errorOnExist: true, force: false, filter: entry => {
      const rel = path.relative(source, entry).replaceAll('\\', '/')
      return rel === '' || rel === 'package.json' || files.some(file => rel === file || rel.startsWith(`${file}/`) || file.startsWith(`${rel}/`))
    } })
    if (await hashTree(stage, files) !== expectedHash) throw new Error('织贸助手 bundle staging hash mismatch。')
    await assertNoReparseAncestors(stage, scopeRoot)
    await rename(stage, destination)
    if (!await bundleDestinationIsCurrent(destination, expectedHash, files)) throw new Error('织贸助手 bundle copy was not materialized.')
  } catch (failure) {
    await rm(stage, { recursive: true, force: true }).catch(() => {})
    throw failure
  }
}

export async function prepareProfile({ runtimePath, home, agentsHome, workspace, mode = 'web', validateRuntimeFn = validateOwnedRuntime, source = sourcePackage, requirePinnedCommit = true }) {
  if (!['web', 'desktop'].includes(mode)) throw new Error('启动模式只支持 web 或 desktop。')
  const profileName = mode === 'desktop' ? 'desktop' : 'tradeloom'
  const runtime = await validateRuntimeFn(runtimePath)
  const destination = path.join(runtime, 'node_modules', '@tradeloom', 'dsh-business-shell')
  await assertNoReparseAncestors(destination, runtime)
  const requestedHome = path.resolve(home)
  const profileDir = path.join(requestedHome, 'profiles', profileName)
  await assertNoReparseAncestors(path.join(requestedHome, 'profiles'), requestedHome)
  await assertNoReparseAncestors(profileDir, requestedHome)
  if (requirePinnedCommit) {
    const commit = execFileSync('git', ['-C', runtime, 'rev-parse', 'HEAD'], { encoding: 'utf8', windowsHide: true }).trim()
    if (commit !== pinnedCommit) throw new Error(`runtime 上游版本不匹配（expected ${pinnedCommit}）。`)
  }
  const homePath = await ensureOwnedHome(home)
  const agentPath = await ensureOwnedDirectory(agentsHome, '.tradeloom-agents-owned', 'tradeloom-agents-home-v1\n')
  const workspacePath = await ensureOwnedDirectory(workspace, '.tradeloom-workspace-owned', 'tradeloom-workspace-v1\n')

  const cliPackage = path.join(runtime, 'apps', 'cli', 'package.json')
  const cli = path.join(runtime, 'apps', 'cli', 'lib', 'bin.js')
  const bootPackage = path.join(runtime, 'packages', 'boot', 'app-boot', 'package.json')
  const bootEntry = path.join(runtime, 'packages', 'boot', 'app-boot', 'lib', 'index.js')
  for (const file of [cliPackage, cli, bootPackage, bootEntry]) await lstat(file)

  const manifest = JSON.parse(await readFile(path.join(source, 'package.json'), 'utf8'))
  const packageHash = await hashTree(source, ['package.json', ...manifest.files])
  const bundleFiles = ['package.json', ...manifest.files]
  await ensureExactBundleCopy(source, destination, bundleFiles, packageHash, runtime)
  const bundleHash = await hashTree(destination, ['package.json', ...manifest.files])

  const record = { schema: 1, runtime: await realpath(runtime), packageName, bundleHash, profile: profileName }
  const recordPath = path.join(homePath, `tradeloom-launcher-${profileName}.json`)
  let recordExists = false
  try {
    const info = await lstat(recordPath)
    if (!info.isFile() || info.isSymbolicLink()) throw new Error('拒绝非普通织贸助手 runtime/profile 记录。')
    const existing = JSON.parse(await readFile(recordPath, 'utf8'))
    if (JSON.stringify(existing) !== JSON.stringify(record)) throw new Error('织贸助手本地 runtime/profile 记录与当前选择不一致。')
    recordExists = true
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }

  const appBoot = await import(pathToFileURL(bootEntry).href)
  const profileManifestPath = path.join(profileDir, 'package.json')
  try {
    const profileInfo = await lstat(profileDir)
    if (!profileInfo.isDirectory() || profileInfo.isSymbolicLink()) throw new Error(`拒绝非普通 ${profileName} profile 目录。`)
    try {
      const manifestInfo = await lstat(profileManifestPath)
      if (!manifestInfo.isFile() || manifestInfo.isSymbolicLink()) throw new Error(`拒绝非普通 ${profileName} profile package.json。`)
    }
    catch (error) {
      if (error.code === 'ENOENT') throw new Error(`已有 ${profileName} profile 缺少 package.json；拒绝接管目录。`)
      throw error
    }
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
    await mkdir(path.dirname(profileDir), { recursive: true })
    appBoot.initProfile(profileDir, profileBundles)
  }
  const profile = JSON.parse(await readFile(profileManifestPath, 'utf8'))
  const bundles = profile.dsh?.profile?.bundles
  if (!Array.isArray(bundles) || profileBundles.some((name, index) => bundles[index] !== name)) {
    throw new Error(`已有 ${profileName} profile 不符合织贸助手完整 bundle 顺序；拒绝继续启动。`)
  }
  const profileBundleDestination = path.join(profileDir, 'node_modules', ...packageName.split('/'))
  await assertNoReparseAncestors(profileBundleDestination, profileDir)
  await ensureExactBundleCopy(destination, profileBundleDestination, bundleFiles, bundleHash, profileDir)

  if (!recordExists) {
    await writeFile(recordPath, `${JSON.stringify(record, null, 2)}\n`, { flag: 'wx' })
  }
  return { runtime, cli, profileDir, home: homePath, agentsHome: agentPath, workspace: workspacePath, packageName, bundleHash }
}
