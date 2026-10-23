import path from 'node:path'
import { createHash } from 'node:crypto'
import { buildNativeBridgeChildEnvironment, createNativeBridgeKey, NATIVE_BRIDGE_ENV } from './core.mjs'

export const BOOTSTRAP_MARKER = '.tradeloom-bootstrap-owned'
export const BOOTSTRAP_MARKER_CONTENT = 'tradeloom-bootstrap-v1\n'
export const MANIFEST_NAME = 'deployment.json'

// Electron emits will-quit only after app.quit() has finished its cancellable close path:
// https://www.electronjs.org/docs/latest/api/app/#event-will-quit
// Keep owned-service shutdown here so an upstream before-quit confirmation can be canceled safely.
export function installDeferredQuitCleanup(app, stopOwnedServices, reportError = error => console.error(error)) {
  let stopping = false
  let stopped = false
  app.on('will-quit', event => {
    if (stopped) return
    event.preventDefault()
    if (stopping) return
    stopping = true
    void Promise.resolve()
      .then(stopOwnedServices)
      .catch(error => {
        try { reportError(error) } catch {}
      })
      .then(() => {
        stopped = true
        app.quit()
      })
  })
}

function isPrivateIPv4(value) {
  const parts = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(value ?? '')
  if (!parts || parts.slice(1).some(part => Number(part) > 255)) return false
  const [a, b] = parts.slice(1).map(Number)
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
}

export function lockName(home, platform = process.platform) {
  const digest = createHash('sha256').update(path.resolve(home).toLowerCase()).digest('hex').slice(0, 24)
  return platform === 'win32' ? `\\\\.\\pipe\\tradeloom-launcher-${digest}` : path.join(home, `.tradeloom-bootstrap-${digest}.sock`)
}

function assertWithin(root, target, label) {
  const relative = path.relative(root, target)
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`${label} 必须位于受控 TradeLoom staging 目录内。`)
  }
}

function resolveProductPath(root, value, name) {
  if (typeof value !== 'string' || value.trim() === '' || path.isAbsolute(value)) {
    throw new Error(`部署资料缺少受控相对路径：${name}。`)
  }
  const target = path.resolve(root, value)
  assertWithin(path.resolve(root), target, name)
  return target
}

async function assertOrdinaryStagedFile(root, target, label, fs) {
  assertWithin(root, target, label)
  const relative = path.relative(root, target)
  let current = root
  for (const part of relative.split(path.sep)) {
    current = path.join(current, part)
    const info = await fs.lstat(current)
    if (info.isSymbolicLink()) throw new Error(`${label} 路径含 reparse/link：${current}`)
    const isTarget = current.toLowerCase() === target.toLowerCase()
    if (isTarget ? !info.isFile() : !info.isDirectory()) throw new Error(`${label} 路径类型无效：${current}`)
  }
}

async function assertAppMain(appPath, expectedHash, fs) {
  const root = path.resolve(appPath)
  const target = path.join(root, 'lib', 'main.js')
  const asarBoundary = path.extname(root).toLowerCase() === '.asar'
  const physicalEnd = asarBoundary ? path.dirname(root) : root
  let current = path.parse(physicalEnd).root
  for (const part of path.relative(current, physicalEnd).split(path.sep).filter(Boolean)) {
    current = path.join(current, part)
    const info = await fs.lstat(current)
    if (info.isSymbolicLink()) throw new Error(`实际 Electron main 路径含 reparse/link：${current}`)
    if (!info.isDirectory()) throw new Error(`实际 Electron main 物理祖先不是普通目录：${current}`)
  }
  if (asarBoundary) {
    const archiveInfo = await fs.lstat(root)
    if (archiveInfo.isSymbolicLink() || !archiveInfo.isFile()) {
      throw new Error(`Electron app.asar 必须是普通文件且物理祖先无 reparse：${root}`)
    }
  } else {
    const rootInfo = await fs.lstat(root)
    if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory()) throw new Error(`实际 Electron appPath 不是普通目录：${root}`)
  }
  current = root
  for (const part of ['lib', 'main.js']) {
    current = path.join(current, part)
    const info = await fs.lstat(current)
    if (info.isSymbolicLink()) throw new Error(`实际 Electron main 路径含 reparse/link：${current}`)
    const isTarget = part === 'main.js'
    if (isTarget ? !info.isFile() : !info.isDirectory()) throw new Error(`实际 Electron main 路径类型无效：${current}`)
  }
  const actual = createHash('sha256').update(await fs.readFile(target)).digest('hex')
  if (actual !== expectedHash) throw new Error('实际 appPath/lib/main.js 与受控部署 SHA256 不匹配。')
}

async function assertOwnedDesktopProfile(home, expectedBundles, fs) {
  const manifestPath = path.join(home, 'profiles', 'desktop', 'package.json')
  let current = home
  for (const part of ['profiles', 'desktop', 'package.json']) {
    current = path.join(current, part)
    const info = await fs.lstat(current)
    if (info.isSymbolicLink()) throw new Error(`desktop profile 路径含 reparse/link：${current}`)
    const isFile = part === 'package.json'
    if (isFile ? !info.isFile() : !info.isDirectory()) throw new Error(`desktop profile 路径类型无效：${current}`)
  }
  const profileManifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'))
  const bundles = profileManifest?.dsh?.profile?.bundles
  if (!Array.isArray(bundles) || bundles.length !== expectedBundles.length
    || expectedBundles.some((name, index) => bundles[index] !== name)) {
    throw new Error('独立 desktop profile bundle 与受控部署不匹配；拒绝回退到其他 profile。')
  }
}

async function ensureDesktopProfile(home, runtime, bundles, deps) {
  const profileDir = path.join(home, 'profiles', 'desktop')
  const manifestPath = path.join(profileDir, 'package.json')
  let current = home
  for (const part of ['profiles', 'desktop']) {
    current = path.join(current, part)
    try {
      const info = await deps.fs.lstat(current)
      if (info.isSymbolicLink() || !info.isDirectory()) throw new Error(`desktop profile 路径不是普通目录：${current}`)
    } catch (error) {
      if (error.code === 'ENOENT') break
      throw error
    }
  }
  try {
    await deps.fs.lstat(manifestPath)
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
    if (typeof deps.initializeProfile !== 'function') throw new Error('独立 desktop profile 尚未初始化，且缺少官方 profile 初始化入口。')
    await deps.initializeProfile(profileDir, bundles, runtime)
  }
}

async function readOwnedManifest({ resourcesPath, fs }) {
  const root = path.resolve(resourcesPath, 'tradeloom')
  const markerPath = path.join(root, BOOTSTRAP_MARKER)
  const manifestPath = path.join(root, MANIFEST_NAME)
  let ancestor = root
  while (true) {
    const info = await fs.lstat(ancestor)
    if (info.isSymbolicLink()) throw new Error(`bootstrap resources 祖先不能是 reparse/link：${ancestor}`)
    const parent = path.dirname(ancestor)
    if (parent === ancestor) break
    ancestor = parent
  }
  for (const target of [root, markerPath, manifestPath]) {
    const info = await fs.lstat(target)
    if (info.isSymbolicLink()) throw new Error(`部署资料路径不能包含链接：${target}`)
  }
  const markerInfo = await fs.lstat(markerPath)
  if (!markerInfo.isFile() || await fs.readFile(markerPath, 'utf8') !== BOOTSTRAP_MARKER_CONTENT) {
    throw new Error('resources 中缺少有效的 TradeLoom bootstrap ownership marker。')
  }
  if (!(await fs.lstat(root)).isDirectory()) throw new Error('bootstrap resources 目录类型无效。')
  const manifestInfo = await fs.lstat(manifestPath)
  if (!manifestInfo.isFile()) throw new Error('bootstrap manifest 必须是普通文件。')
  return { root, manifest: JSON.parse(await fs.readFile(manifestPath, 'utf8')) }
}

export function validateManifest(manifest, productRoot, workspace) {
  if (manifest?.schemaVersion !== 1) throw new Error('bootstrap manifest schemaVersion 不受支持。')
  const releases = path.join(productRoot, 'runtime', 'releases')
  const runtime = resolveProductPath(productRoot, manifest.runtime, 'runtime')
  const python = resolveProductPath(productRoot, manifest.python, 'python')
  const manage = resolveProductPath(productRoot, manifest.manage, 'manage')
  if (manifest.cwd !== 'workspace') throw new Error('Django cwd 必须使用固定 workspace 标识。')
  const cwd = path.resolve(workspace)
  if (path.dirname(runtime).toLowerCase() !== releases.toLowerCase()) throw new Error('runtime 必须是 LOCALAPPDATA/TradeLoom/runtime/releases 下的单版本目录。')
  assertWithin(productRoot, python, '专用 Python')
  assertWithin(productRoot, manage, 'Django manage.py')
  if (!isPrivateIPv4(manifest.hostAddress)) throw new Error('bootstrap manifest 缺少有效的局域网私有 IPv4 选择。')
  if (!/^[a-f0-9]{64}$/.test(manifest.appMainSha256 ?? '')) throw new Error('bootstrap manifest 缺少实际 Electron main SHA256。')
  if (!manifest.lock || typeof manifest.lock !== 'object' || !manifest.lock.upstream || !manifest.lock.patches) {
    throw new Error('bootstrap manifest 缺少 receipt 校验所需的 pinned patch lock。')
  }
  return { ...manifest, runtime, python, manage, cwd, releaseRoot: releases }
}

function setProcessEnvironment(target, next) {
  for (const key of Object.keys(target)) delete target[key]
  Object.assign(target, next)
}

async function waitForListener(host, port, record, timeoutMs, delay, connect) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const early = await Promise.race([record.exited.then(result => ({ result })), delay(80).then(() => null)])
    if (early) throw new Error(`Django 提前退出（exit=${early.result.code ?? 'null'}）。`)
    if (await connect(host, port)) return
    await delay(250)
  }
  throw new Error(`Django 未在 ${timeoutMs / 1000} 秒内监听 127.0.0.1:${port}。`)
}

/** Testable startup flow. The desktop main module is imported only after isolation and receipt checks. */
export async function bootstrapDesktop({ env, processEnv, appPath, resourcesPath, platform = process.platform, deps }) {
  const dbPassword = env.TRADELOOM_DB_PASSWORD
  const managed = env.TRADELOOM_EXTERNAL_SUPERVISOR === '1'
  const inheritedLocalAppData = env.LOCALAPPDATA
  if (typeof inheritedLocalAppData !== 'string' || !path.isAbsolute(inheritedLocalAppData)) {
    throw new Error('Windows LOCALAPPDATA 不可用；拒绝回退到默认 DSH home。')
  }
  const localAppData = managed ? path.dirname(path.dirname(path.resolve(inheritedLocalAppData))) : path.resolve(inheritedLocalAppData)
  if (managed && (path.basename(path.dirname(path.resolve(inheritedLocalAppData))).toLowerCase() !== 'tradeloom'
    || path.basename(path.resolve(inheritedLocalAppData)).toLowerCase() !== 'local-appdata')) {
    throw new Error('受管启动器提供的 LOCALAPPDATA 不符合 TradeLoom fallback 布局。')
  }
  const paths = deps.getDefaultPaths({ LOCALAPPDATA: localAppData })
  const productRoot = path.join(localAppData, 'TradeLoom')
  if (managed && path.resolve(inheritedLocalAppData).toLowerCase() !== path.resolve(paths.localAppData).toLowerCase()) {
    throw new Error('受管启动器的 fallback LOCALAPPDATA 与专属 home 不匹配。')
  }
  if (managed && path.resolve(env.DSH_HOME ?? '').toLowerCase() !== path.resolve(paths.home).toLowerCase()) {
    throw new Error('受管启动器未设置 TradeLoom 专属 DSH_HOME。')
  }
  if (managed && (path.resolve(env.DSH_AGENTS_HOME ?? '').toLowerCase() !== path.resolve(paths.agentsHome).toLowerCase()
    || path.resolve(env.TRADELOOM_DSH_APP_HOME ?? '').toLowerCase() !== path.resolve(paths.home).toLowerCase())) {
    throw new Error('受管启动器未设置 TradeLoom 专属 agents/home。')
  }
  await deps.ensureOwnedHome(paths.home)
  const agentsHome = await deps.ensureOwnedDirectory(paths.agentsHome, '.tradeloom-agents-owned', 'tradeloom-agents-home-v1\n')
  const workspace = await deps.ensureOwnedDirectory(paths.workspace, '.tradeloom-workspace-owned', 'tradeloom-workspace-v1\n')
  const logs = await deps.ensureOwnedDirectory(paths.logs, '.tradeloom-logs-owned', 'tradeloom-logs-v1\n')
  for (const directory of [paths.appData, paths.localAppData, paths.xdgCache, paths.xdgConfig, paths.xdgData]) {
    await deps.ensureOwnedDirectory(directory, '.tradeloom-fallback-owned', 'tradeloom-fallback-v1\n')
  }

  const bridgeKeyFactory = managed
    ? () => env[NATIVE_BRIDGE_ENV]
    : deps.createNativeBridgeKey ?? createNativeBridgeKey
  const { key: nativeBridgeKey, env: isolated } = buildNativeBridgeChildEnvironment(env, { ...paths, agentsHome }, {
    DSH_WORKSPACE: workspace,
    TRADELOOM_DSH_WORKSPACE: workspace,
    TEMP: paths.localAppData,
    TMP: paths.localAppData,
  }, bridgeKeyFactory, deps.buildChildEnvironment)
  for (const [name, expected] of Object.entries({ DSH_HOME: paths.home, DSH_AGENTS_HOME: agentsHome,
    DSH_WORKSPACE: workspace, TRADELOOM_DSH_APP_HOME: paths.home, LOCALAPPDATA: paths.localAppData })) {
    if (path.resolve(isolated[name] ?? '').toLowerCase() !== path.resolve(expected).toLowerCase()) {
      throw new Error(`无法确认独立运行目录环境变量：${name}。`)
    }
  }
  setProcessEnvironment(processEnv, isolated)

  const { root: bootstrapRoot, manifest: rawManifest } = await readOwnedManifest({ resourcesPath, fs: deps.fs })
  const deployment = validateManifest(rawManifest, productRoot, workspace)
  const runtimePath = managed
    ? path.resolve(appPath, '..', '..')
    : deployment.runtime
  const releaseRoot = managed ? deps.managedReleaseRoot : deployment.releaseRoot
  let lockServer
  let django
  let quitting = false
  try {
    if (!managed) lockServer = await deps.reserveNamedPipe(lockName(paths.home, platform))
    const verifiedReceipt = await deps.verifyReceipt(runtimePath, deployment.lock, releaseRoot)
    await ensureDesktopProfile(paths.home, runtimePath, deps.profileBundles, deps)
    await assertOwnedDesktopProfile(paths.home, deps.profileBundles, deps.fs)
    const expectedAppMainHash = managed
      ? verifiedReceipt?.compiledFiles?.['apps/desktop/lib/main.js']
      : deployment.appMainSha256
    if (!/^[a-f0-9]{64}$/.test(expectedAppMainHash ?? '')) throw new Error('bootstrap manifest/receipt 缺少实际 Electron main SHA256。')
    await assertAppMain(appPath, expectedAppMainHash, deps.fs)
    await deps.changeCwd(workspace)
    if (managed) {
      await deps.importMain()
      return { managed: true, paths, runtimePath, workspace }
    }

    const currentAddresses = new Set(Object.values(deps.networkInterfaces()).flatMap(items =>
      (items ?? []).filter(item => item.family === 'IPv4' && !item.internal).map(item => item.address)))
    if (!currentAddresses.has(deployment.hostAddress)) throw new Error('manifest 中的局域网地址当前未绑定；请重新完成受控部署。')
    processEnv.TRADELOOM_DSH_BIND_HOST = deployment.hostAddress
    processEnv.TRADELOOM_DSH_BIND_PORT = '3088'
    await assertOrdinaryStagedFile(productRoot, deployment.python, '专用 Python', deps.fs)
    await assertOrdinaryStagedFile(productRoot, deployment.manage, 'Django manage.py', deps.fs)

    await deps.assertPortsAvailable([[deployment.hostAddress, 3088], ['127.0.0.1', 3090]])
    const djangoEnv = { ...isolated, TRADELOOM_DSH_EMBED: '1', TRADELOOM_DSH_ALLOWED_HOSTS: deployment.hostAddress,
      TRADELOOM_DSH_CSRF_TRUSTED_ORIGINS: `http://${deployment.hostAddress}:3088`,
      TRADELOOM_DB_NAME: 'tradeloom_dev', TRADELOOM_DB_HOST: '127.0.0.1', TRADELOOM_DB_PORT: '55432',
      ...(dbPassword === undefined ? {} : { TRADELOOM_DB_PASSWORD: dbPassword }) }
    django = deps.startOwnedChild(deployment.python, [deployment.manage, 'runserver', '127.0.0.1:3090', '--noreload'], {
      cwd: workspace, env: djangoEnv, logPath: path.join(logs, 'django-startup.log'), logLabel: 'Django',
    })
    await django.spawned
    await waitForListener('127.0.0.1', 3090, django, deps.readyTimeoutMs ?? 60_000, deps.delay, deps.connect)
    await deps.installQuitHandler(async () => {
      if (quitting) return
      quitting = true
      await django?.stop()
      lockServer?.close()
    })
    await deps.importMain()
    const ready = Promise.resolve()
      .then(() => deps.waitForDesktopReady(deployment.hostAddress, 3088, deps.readyTimeoutMs ?? 60_000))
      .catch(async error => {
        await Promise.allSettled([django?.stop(), lockServer?.close()])
        throw error
      })
    return { managed: false, paths, runtimePath, workspace, hostAddress: deployment.hostAddress, ready }
  } catch (error) {
    await Promise.allSettled([django?.stop(), lockServer?.close()])
    throw error
  }
}

export { isPrivateIPv4 }
