import net from 'node:net'
import { access, appendFile, lstat, mkdir, readFile, writeFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  assertPortsAvailable, buildChildEnvironment, buildDesktopChildEnvironment, buildDjangoChildEnvironment, buildNativeBridgeChildEnvironment, chooseAddress, ensureOwnedDirectory,
  ensureOwnedHome, getDefaultPaths, launcherPipeName, networkCandidates, requestStop, reserveNamedPipe, serveStopRequest, startOwnedChild, startTransaction,
} from './core.mjs'
import { assertNoReparseAncestors, prepareProfile, sameDirectoryIdentity } from './prepare-profile.mjs'
import { assertDesktopDevelopmentProjectReady, assertTradeLoomDesktopAppIdentity, verifyDesktopBuildReceipt, resolveNativeArtifactValidator, loadDesktopBuildLock } from './desktop-receipt.mjs'
import { choosePayloadAddress, DEFAULT_RUNTIME_CANDIDATE } from './candidate-payload.mjs'
import { loadErpNextConfigFile } from './erpnext-config.mjs'
import { knownPreviousRuntimeIdentity, validateKnownPreviousRuntime } from './known-previous-runtime.mjs'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const workspaceRoot = path.dirname(repoRoot)
const releaseName = DEFAULT_RUNTIME_CANDIDATE
const releaseRoot = path.join(workspaceRoot, 'workspace', 'runtime', 'tradeloom-harness', 'releases')
const runtimePath = path.join(releaseRoot, releaseName)
const NODE = process.execPath
const DATA_ROOT_MARKER = '.tradeloom-data-root-owned'
const DATA_ROOT_MARKER_CONTENT = 'tradeloom-app-data-v1\n'
const INTAKE_ROOT_MARKER = '.tradeloom-intake-owned'
const INTAKE_ROOT_MARKER_CONTENT = 'tradeloom-private-intake-v1\n'
let activePipeServer
let finishRunning
let ownedFailureLogDir

function parse(args) {
  const options = { action: args[0] ?? 'start', mode: 'desktop' }
  for (let i = 1; i < args.length; i += 1) {
    if (args[i] === '--host') options.host = args[++i]
    else if (args[i] === '--mode') options.mode = args[++i]
    else if (args[i] === '--runtime') { options.runtime = args[++i]; options.runtimeExplicit = true }
    else if (args[i] === '--previous-runtime') options.previousRuntime = args[++i]
    else if (args[i] === '--desktop-build-lock') {
      const value = args[i + 1]
      if (options.desktopBuildLockPath !== undefined || typeof value !== 'string' || !path.isAbsolute(value)) throw new Error('--desktop-build-lock 必须是唯一的绝对文件路径。')
      options.desktopBuildLockPath = path.resolve(value); i += 1
    }
    else if (args[i] === '--data-root') options.dataRoot = args[++i]
    else if (args[i] === '--bundle-source') {
      const value = args[i + 1]
      if (options.bundleSource !== undefined || typeof value !== 'string' || !path.isAbsolute(value)) {
        throw new Error('--bundle-source 必须是唯一且非空的绝对目录路径。')
      }
      options.bundleSource = path.resolve(value)
      i += 1
    }
    else if (args[i] === '--erpnext-config-file') {
      const value = args[i + 1]
      if (options.erpNextConfigFile !== undefined || typeof value !== 'string' || !value.trim() || value.startsWith('--')) {
        throw new Error('ERPNext 配置参数必须提供一个非空文件路径。')
      }
      options.erpNextConfigFile = value
      i += 1
    }
    else if (args[i] === '--candidates') options.candidates = JSON.parse(Buffer.from(args[++i], 'base64').toString('utf8'))
  }
  return options
}

async function waitForListener(host, port, childRecord, timeoutMs = 60_000) {
  const expires = Date.now() + timeoutMs
  while (Date.now() < expires) {
    const earlyExit = await Promise.race([childRecord.exited.then(value => ({ exit: value })), new Promise(resolve => setTimeout(() => resolve(null), 80))])
    if (earlyExit) throw new Error(earlyExit.exit.error
      ? `子服务启动失败：${earlyExit.exit.error.message}`
      : `子服务提前退出（exit=${earlyExit.exit.code ?? 'null'}）。`)
    const connected = await new Promise(resolve => {
      const socket = net.createConnection({ host, port })
      socket.once('connect', () => { socket.destroy(); resolve(true) })
      socket.once('error', () => { socket.destroy(); resolve(false) })
    })
    if (connected) return
    await new Promise(resolve => setTimeout(resolve, 250))
  }
  throw new Error(`子服务未在 ${timeoutMs / 1000} 秒内开始监听 ${host}:${port}。`)
}

async function writeFailure(logDir, error) {
  if (!ownedFailureLogDir || path.resolve(ownedFailureLogDir) !== path.resolve(logDir)) {
    process.stderr.write(`织贸助手尚未启动：${String(error?.message ?? error)}\n尚未验证专属日志目录，因此没有写入日志。\n`)
    return
  }
  try {
    await ensureOwnedDirectory(logDir, '.tradeloom-logs-owned', 'tradeloom-logs-v1\n')
    await mkdir(logDir, { recursive: true })
    const log = path.join(logDir, `startup-${new Date().toISOString().replaceAll(':', '-')}.log`)
    await appendFile(log, `[${new Date().toISOString()}] 启动失败：${String(error?.message ?? error)}\n`)
    process.stderr.write(`织贸助手尚未启动。请查看本机日志：${log}\n`)
  } catch (loggingError) {
    process.stderr.write(`织贸助手尚未启动：${String(error?.message ?? error)}\n专属日志写入失败：${String(loggingError?.message ?? loggingError)}\n`)
  }
}

async function assertExistingOwnedDataRoot(dataRoot) {
  const info = await lstat(dataRoot).catch(error => {
    if (error.code === 'ENOENT') throw new Error('runtime 迁移必须使用已存在的 owned DataRoot。')
    throw error
  })
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('runtime 迁移 DataRoot 必须是普通 owned 目录。')
  await assertNoReparseAncestors(path.join(dataRoot, DATA_ROOT_MARKER), dataRoot)
  const markerPath = path.join(dataRoot, DATA_ROOT_MARKER)
  const markerInfo = await lstat(markerPath).catch(error => {
    if (error.code === 'ENOENT') throw new Error('runtime 迁移 DataRoot 缺少 ownership marker。')
    throw error
  })
  if (!markerInfo.isFile() || markerInfo.isSymbolicLink()
    || await readFile(markerPath, 'utf8') !== DATA_ROOT_MARKER_CONTENT) {
    throw new Error('runtime 迁移 DataRoot ownership marker 无效。')
  }
}

async function readDesktopMigrationRecord(home, previousRuntime, identity) {
  const recordPath = path.join(home, 'tradeloom-launcher-desktop.json')
  await assertNoReparseAncestors(recordPath, home)
  const info = await lstat(recordPath).catch(error => {
    if (error.code === 'ENOENT') throw new Error('runtime 迁移缺少既有 desktop profile binding record。')
    throw error
  })
  if (!info.isFile() || info.isSymbolicLink()) throw new Error('runtime 迁移 desktop profile record 必须是普通文件。')
  const record = JSON.parse(await readFile(recordPath, 'utf8'))
  if (record.schema !== 1 || record.profile !== 'desktop' || record.packageName !== '@tradeloom/dsh-business-shell'
    || typeof record.runtime !== 'string' || !path.isAbsolute(record.runtime)
    || !(await sameDirectoryIdentity(record.runtime, previousRuntime))
    || typeof record.bundleHash !== 'string' || record.bundleHash.toLowerCase() !== identity.bundleHash) {
    throw new Error('既有 desktop profile record 不匹配已知 runtime/bundle；拒绝迁移。')
  }
  return record
}

async function start(options) {
  if (!['web', 'desktop'].includes(options.mode)) throw new Error('启动模式只支持 desktop 或 web。')
  const paths = getDefaultPaths()
  if (options.erpNextConfigFile !== undefined && !paths.explicitDataRoot) {
    throw new Error('ERPNext 私密配置仅支持已明确指定的 owned DataRoot。')
  }
  if (paths.explicitDataRoot) {
    await ensureOwnedDirectory(paths.dataRoot, DATA_ROOT_MARKER, DATA_ROOT_MARKER_CONTENT)
  }
  await ensureOwnedDirectory(path.join(paths.dataRoot, 'private', 'intake'), INTAKE_ROOT_MARKER, INTAKE_ROOT_MARKER_CONTENT)
  const erpNextEnvironment = options.erpNextConfigFile
    ? await loadErpNextConfigFile(options.erpNextConfigFile, paths.dataRoot)
    : {}
  const home = await ensureOwnedHome(paths.home)
  const server = await reserveNamedPipe(launcherPipeName(home))
  activePipeServer = server
  let stopHandler
  server.on('connection', socket => {
    if (stopHandler) stopHandler(socket)
    else socket.end('织贸助手正在准备，请稍后重试。\n')
  })
  const agentsHome = await ensureOwnedDirectory(paths.agentsHome, '.tradeloom-agents-owned', 'tradeloom-agents-home-v1\n')
  const workspace = await ensureOwnedDirectory(paths.workspace, '.tradeloom-workspace-owned', 'tradeloom-workspace-v1\n')
  const logs = await ensureOwnedDirectory(paths.logs, '.tradeloom-logs-owned', 'tradeloom-logs-v1\n')
  ownedFailureLogDir = logs
  for (const directory of [paths.appData, paths.localAppData, paths.xdgCache, paths.xdgConfig, paths.xdgData]) {
    await ensureOwnedDirectory(directory, '.tradeloom-fallback-owned', 'tradeloom-fallback-v1\n')
  }
  const appHome = options.runtime ?? runtimePath
  const host = options.candidates === undefined ? chooseAddress([], options.host) : choosePayloadAddress(options.candidates, options.host)
  await assertPortsAvailable([[host, 3088], ['127.0.0.1', 3090]])
  let nativeArtifactValidator = { available: false, reason: 'not_desktop' }
  if (options.mode === 'desktop') {
    const lock = options.desktopBuildLock ?? JSON.parse(await readFile(path.join(repoRoot, 'integrations', 'dsh', 'patches', 'patches.lock.json'), 'utf8'))
    await verifyDesktopBuildReceipt(appHome, lock)
    nativeArtifactValidator = await resolveNativeArtifactValidator(appHome, lock)
    if (!nativeArtifactValidator.available) console.warn(`原生产物验证不可用：${nativeArtifactValidator.reason}`)
    await assertDesktopDevelopmentProjectReady(appHome)
    await assertTradeLoomDesktopAppIdentity(appHome)
  }
  await access(paths.python).catch(() => { throw new Error('未找到织贸助手专用 Python 环境；请先完成受控运行时准备。') })
  if (options.mode === 'desktop') {
    const electron = path.join(appHome, 'apps', 'desktop', 'node_modules', 'electron', 'dist', 'electron.exe')
    const desktopEntry = path.join(appHome, 'apps', 'desktop')
    await access(desktopEntry).catch(() => { throw new Error('桌面运行文件不完整；请先完成受控运行时准备。') })
    await access(electron).catch(() => { throw new Error('桌面 Electron 二进制尚未准备；请先完成受控运行时准备。') })
  }
  const prepared = await prepareProfile({ runtimePath: appHome, home, agentsHome, workspace, mode: options.mode,
    ...(options.bundleSource ? { source: options.bundleSource } : {}),
  })
  const envPaths = { ...paths, home, agentsHome }
  const { key: nativeBridgeKey, env: safeBase } = buildNativeBridgeChildEnvironment(process.env, envPaths, {
    TRADELOOM_DSH_APP_HOME: home,
  })
  const dshEnv = { ...safeBase }
  delete dshEnv.TRADELOOM_DB_PASSWORD
  const dbPassword = process.env.TRADELOOM_DB_PASSWORD
  const djangoEnv = {
    ...buildDjangoChildEnvironment(process.env, envPaths, { TRADELOOM_DSH_APP_HOME: home }),
    TRADELOOM_DSH_EMBED: '1',
    TRADELOOM_DSH_ALLOWED_HOSTS: host,
    TRADELOOM_DSH_CSRF_TRUSTED_ORIGINS: `http://${host}:3088`,
    TRADELOOM_NATIVE_BRIDGE_KEY: nativeBridgeKey,
    ...(nativeArtifactValidator.available ? { TRADELOOM_ARTIFACT_NODE: nativeArtifactValidator.nodePath, TRADELOOM_ARTIFACT_NODE_SHA256: nativeArtifactValidator.nodeSha256 } : {}),
    TRADELOOM_DB_NAME: 'tradeloom_dev',
    TRADELOOM_DB_HOST: '127.0.0.1',
    TRADELOOM_DB_PORT: '55432',
    ...(dbPassword === undefined ? {} : { TRADELOOM_DB_PASSWORD: dbPassword }),
    ...erpNextEnvironment,
  }
  const startDjango = async () => {
      const record = startOwnedChild(paths.python,
        [path.join(repoRoot, 'manage.py'), 'runserver', '127.0.0.1:3090', '--noreload'],
        { cwd: workspace, env: djangoEnv, logPath: path.join(logs, 'django-startup.log'), logLabel: 'Django' })
      record.ready = waitForListener('127.0.0.1', 3090, record)
      return record
  }
  const startDsh = async () => {
    if (options.mode === 'desktop') {
      const electron = path.join(prepared.runtime, 'apps', 'desktop', 'node_modules', 'electron', 'dist', 'electron.exe')
      const desktopEntry = path.join(prepared.runtime, 'apps', 'desktop')
      const primaryRuntimeDir = path.join(desktopEntry, '.desktop-build', 'targets', 'win-x64', 'runtime', 'primary-runtime')
      await access(primaryRuntimeDir).catch(() => { throw new Error('桌面 Primary Runtime 尚未准备；请先完成受控运行时准备。') })
      const desktopEnv = buildDesktopChildEnvironment(process.env, envPaths, { runtimePath: prepared.runtime, host, port: 3088, nativeBridgeKey })
      const record = startOwnedChild(electron, [desktopEntry],
        { cwd: workspace, env: desktopEnv, logPath: path.join(logs, 'dsh-desktop.log'), logLabel: 'DSH Desktop', windowsHide: false })
      record.ready = waitForListener(host, 3088, record)
      return record
    }
      const record = startOwnedChild(NODE,
        [prepared.cli, '--profile', 'tradeloom', '--host', host, '--port', '3088'],
        { cwd: workspace, env: dshEnv, logPath: path.join(logs, 'dsh-startup.log'), logLabel: 'DSH' })
      record.ready = waitForListener(host, 3088, record)
      return record
  }
  const handles = await startTransaction([startDjango, startDsh])
  let stopping = false
  let stopPromise
  const stopAll = () => {
    if (!stopPromise) {
      stopping = true
      stopPromise = Promise.allSettled(handles.slice().reverse().map(handle => handle.stop()))
    }
    return stopPromise
  }
  stopHandler = socket => {
    serveStopRequest(socket, stopAll, () => {
      server.close(() => finishRunning?.())
      activePipeServer = undefined
      process.exitCode = 0
    })
  }
  process.stdout.write(`${options.mode === 'desktop' ? '织贸助手桌面端已启动，局域网访问地址：' : '织贸助手网页端已启动：'} http://${host}:3088\n按 Ctrl+C 或双击 stop-tradeloom.ps1 可停止。\n`)
  await new Promise(resolve => {
    finishRunning = resolve
    for (const record of handles) record.exited.then(async result => {
      if (server.listening && !stopping) {
        stopping = true
        await writeFailure(logs, new Error(`受管服务提前结束（exit=${result.code ?? 'null'}）。`))
        await stopAll()
        server.close(resolve)
      }
    })
    process.once('SIGINT', async () => {
      await stopAll()
      server.close(() => resolve())
    })
    process.once('SIGTERM', async () => {
      await stopAll()
      server.close(() => resolve())
    })
  })
}

const options = parse(process.argv.slice(2))
if (options.dataRoot) process.env.TRADELOOM_DATA_ROOT = options.dataRoot
const paths = getDefaultPaths()
if (options.previousRuntime !== undefined && options.action !== 'sync-dev-bundle') {
  process.stderr.write('--previous-runtime 仅支持显式 sync-dev-bundle 迁移。\n')
  process.exitCode = 1
} else
if (options.action === 'stop') {
  try { process.stdout.write(`${await requestStop(paths.home)}\n`) }
  catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1 }
} else {
  try {
    if (options.desktopBuildLockPath !== undefined) {
      if (options.mode !== 'desktop' || !['start', 'sync-dev-bundle'].includes(options.action)) throw new Error('--desktop-build-lock 仅支持 desktop 启动或同步。')
      options.desktopBuildLock = await loadDesktopBuildLock(options.desktopBuildLockPath)
    }
    if (options.action === 'sync-dev-bundle') {
      if (!['web', 'desktop'].includes(options.mode)) throw new Error('启动模式只支持 desktop 或 web。')
      const { syncDevBundleExclusive } = await import('./sync-dev-bundle.mjs')
      const migration = options.previousRuntime !== undefined
      let previousRuntimePath
      if (migration) {
        if (options.mode !== 'desktop') throw new Error('--previous-runtime 仅支持 desktop profile。')
        if (!options.runtimeExplicit || !paths.explicitDataRoot) throw new Error('runtime 迁移必须显式指定 --runtime 和已存在的 --data-root。')
        if (typeof options.runtime !== 'string' || !path.isAbsolute(options.runtime)) throw new Error('--runtime 必须是绝对路径。')
        if (typeof options.previousRuntime !== 'string' || !options.previousRuntime.trim()) throw new Error('--previous-runtime 必须是非空绝对路径。')
        const targetPath = path.resolve(options.runtime)
        if (!path.isAbsolute(options.runtime) || path.basename(targetPath).toLowerCase() !== DEFAULT_RUNTIME_CANDIDATE.toLowerCase()) {
          throw new Error(`runtime 迁移目标必须是 pinned ${DEFAULT_RUNTIME_CANDIDATE}。`)
        }
        await assertExistingOwnedDataRoot(paths.dataRoot)
        const lock = options.desktopBuildLock ?? JSON.parse(await readFile(path.join(repoRoot, 'integrations', 'dsh', 'patches', 'patches.lock.json'), 'utf8'))
        await verifyDesktopBuildReceipt(targetPath, lock)
        await assertDesktopDevelopmentProjectReady(targetPath)
        await assertTradeLoomDesktopAppIdentity(targetPath)
        const previousIdentity = knownPreviousRuntimeIdentity(options.previousRuntime)
        if (!previousIdentity) throw new Error('迁移来源必须是已知且固定的 TradeLoom runtime。')
        previousRuntimePath = await validateKnownPreviousRuntime(options.previousRuntime)
        await readDesktopMigrationRecord(paths.home, previousRuntimePath, previousIdentity)
      } else if (paths.explicitDataRoot) {
        await ensureOwnedDirectory(paths.dataRoot, DATA_ROOT_MARKER, DATA_ROOT_MARKER_CONTENT)
      }
      const result = await syncDevBundleExclusive({
        runtimePath: options.runtime ?? runtimePath,
        ...(migration ? { previousRuntimePath, validatePreviousRuntime: validateKnownPreviousRuntime,
          expectedPreviousBundleHash: knownPreviousRuntimeIdentity(options.previousRuntime).bundleHash } : {}),
        home: paths.home, mode: options.mode,
        ...(options.bundleSource ? { source: options.bundleSource } : {}),
      })
      process.stdout.write(`TradeLoom ${options.mode} 开发 bundle 已同步；SHA-256 ${result.bundleHash}。\n`)
    } else if (options.action === 'start') await start(options)
    else throw new Error(`未知启动器操作：${options.action}`)
  }
  catch (error) {
    if (activePipeServer) { activePipeServer.close(); activePipeServer = undefined }
    await writeFailure(paths.logs, error)
    process.exitCode = 1
  }
}
