import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { execFile } from 'node:child_process'
import { setTimeout as delay } from 'node:timers/promises'
import { pathToFileURL } from 'node:url'
import { app, dialog } from 'electron'
import { installDeferredQuitCleanup } from './bootstrap-core.mjs'
import {
  assertPortsAvailable, buildChildEnvironment, chooseAddress, ensureOwnedDirectory, ensureOwnedHome,
  getDefaultPaths, launcherPipeName, networkCandidates, reserveNamedPipe, startOwnedChild,
} from './core.mjs'

const execFileAsync = promisify(execFile)

function connect(host, port) {
  return new Promise(resolve => {
    const socket = net.createConnection({ host, port })
    socket.once('connect', () => { socket.destroy(); resolve(true) })
    socket.once('error', () => { socket.destroy(); resolve(false) })
  })
}

async function waitForDesktopReady(host, port, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await connect(host, port)) return
    await delay(250)
  }
  throw new Error(`DSH Desktop 未在 ${timeoutMs / 1000} 秒内监听 ${host}:${port}。`)
}

async function readWindowsNetworkAdapters() {
  const script = String.raw`$ErrorActionPreference = 'Stop'
$items = @(
  foreach ($adapter in @(Get-NetAdapter -Physical | Where-Object { $_.Status -eq 'Up' -and $_.HardwareInterface })) {
    $kind = if ([int]$adapter.InterfaceType -eq 71 -or $adapter.PhysicalMediaType -match '802\.11') { 'wifi' }
      elseif ([int]$adapter.InterfaceType -eq 6 -or $adapter.PhysicalMediaType -eq '802.3' -or $adapter.MediaType -eq '802.3') { 'ethernet' }
      else { $null }
    if ($null -eq $kind) { continue }
    $addresses = @(
      Get-NetIPAddress -InterfaceIndex $adapter.ifIndex -AddressFamily IPv4 -ErrorAction SilentlyContinue |
        Where-Object { $_.AddressState -eq 'Preferred' } |
        ForEach-Object { [pscustomobject]@{ addressFamily = 'IPv4'; address = $_.IPAddress } }
    )
    [pscustomobject]@{ name = $adapter.Name; interfaceDescription = $adapter.InterfaceDescription; kind = $kind; status = 'Up'; hardwareInterface = $true; addresses = $addresses }
  }
)
$json = ConvertTo-Json -InputObject @($items) -Compress -Depth 5
[Console]::Out.Write($json)`
  const childEnv = { ...process.env }
  delete childEnv.PSModulePath
  const { stdout } = await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, maxBuffer: 1024 * 1024, env: childEnv })
  const value = stdout.trim()
  if (!value) return []
  const parsed = JSON.parse(value)
  return Array.isArray(parsed) ? parsed : [parsed]
}

async function chooseNetworkAddress(candidates) {
  if (!candidates.length) return chooseAddress(candidates)
  if (candidates.length === 1) return candidates[0].address
  const buttons = candidates.map(item => `${item.kind === 'wifi' ? 'Wi-Fi' : '以太网'} · ${item.name} · ${item.address}`)
  buttons.push('取消')
  const result = await dialog.showMessageBox({
    type: 'question', title: '织贸助手', message: '请选择本次桌面服务使用的局域网网卡。',
    detail: '只有当前活动物理 Wi-Fi 或以太网的私有 IPv4 地址会开放给局域网客户端。',
    buttons, defaultId: 0, cancelId: buttons.length - 1, noLink: true,
  })
  if (result.response < 0 || result.response >= candidates.length) throw new Error('已取消局域网网卡选择；服务未启动。')
  return chooseAddress(candidates, candidates[result.response].address)
}

function installInstalledQuitHandler(stopOwnedServices) {
  installDeferredQuitCleanup(app, stopOwnedServices, error => {
    console.error(`织贸助手退出清理失败：${error instanceof Error ? error.message : String(error)}`)
  })
}

function installSourceQuitHandler(stopOwnedServices) {
  let stopping = false
  app.on('before-quit', event => {
    if (stopping) return
    event.preventDefault()
    stopping = true
    void stopOwnedServices().finally(() => app.quit())
  })
}

async function runPackagedBootstrap() {
  const { bootstrapInstalledDesktop, parsePackagedPortFlags } = await import('./installed-bootstrap.mjs')
  const ports = parsePackagedPortFlags(process.argv.slice(1))
  const startup = await bootstrapInstalledDesktop({
    env: process.env, processEnv: process.env, appPath: app.getAppPath(), resourcesPath: process.resourcesPath, platform: process.platform, ports,
    deps: {
      fs: await import('node:fs/promises'), getDefaultPaths, ensureOwnedDirectory, ensureOwnedHome, buildChildEnvironment,
      launcherPipeName, reserveNamedPipe, startOwnedChild, assertPortsAvailable,
      networkCandidates, chooseAddress, readNetworkAdapters: readWindowsNetworkAdapters, chooseNetworkAddress,
      delay, connect, readyTimeoutMs: 60_000, installQuitHandler: installInstalledQuitHandler,
      waitForDesktopReady, importMain: () => import('../main.js'),
    },
  })
  void startup.ready.catch(error => {
    console.error(`织贸助手桌面服务启动失败：${error instanceof Error ? error.message : String(error)}`)
    app.exit(1)
  })
}

async function runSourceBootstrap() {
  const [{ verifyDesktopBuildReceipt }, { bootstrapDesktop }, { profileBundles, trustedReleaseRoot }] = await Promise.all([
    import('./desktop-receipt.mjs'), import('./bootstrap-core.mjs'), import('./prepare-profile.mjs'),
  ])
  const startup = await bootstrapDesktop({
    env: process.env, processEnv: process.env, appPath: app.getAppPath(), resourcesPath: process.resourcesPath, platform: process.platform,
    deps: {
      fs: await import('node:fs/promises'), getDefaultPaths,
      changeCwd: directory => process.chdir(directory), ensureOwnedHome, ensureOwnedDirectory, buildChildEnvironment,
      reserveNamedPipe, assertPortsAvailable, startOwnedChild,
      verifyReceipt: (runtime, lock, releaseRoot) => verifyDesktopBuildReceipt(runtime, lock, releaseRoot),
      managedReleaseRoot: trustedReleaseRoot, profileBundles,
      initializeProfile: async (profileDir, bundles, runtime) => {
        const bootModule = pathToFileURL(path.join(runtime, 'packages/boot/app-boot/lib/index.js')).href
        const { initProfile } = await import(bootModule)
        if (typeof initProfile !== 'function') throw new Error('pinned app-boot 没有导出官方 initProfile。')
        return initProfile(profileDir, bundles)
      },
      networkInterfaces: () => os.networkInterfaces(), delay, connect, readyTimeoutMs: 60_000, installQuitHandler: installSourceQuitHandler,
      waitForDesktopReady, importMain: () => import('../main.js'),
    },
  })
  if (startup.ready) void startup.ready.catch(error => {
    console.error(`织贸助手桌面服务启动失败：${error instanceof Error ? error.message : String(error)}`)
    app.exit(1)
  })
}

try {
  if (app.isPackaged) await runPackagedBootstrap()
  else await runSourceBootstrap()
} catch (error) {
  console.error(`织贸助手启动失败：${error instanceof Error ? error.message : String(error)}`)
  app.exit(1)
}
