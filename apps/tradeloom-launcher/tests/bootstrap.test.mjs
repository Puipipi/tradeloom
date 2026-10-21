import test, { afterEach } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import os from 'node:os'
import { createHash } from 'node:crypto'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { bootstrapDesktop, BOOTSTRAP_MARKER, BOOTSTRAP_MARKER_CONTENT, lockName } from '../bootstrap-core.mjs'
import { writeDesktopBuildReceipt, patchSetDigest, RECEIPT_FILES } from '../receipt-writer.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const productRoot = path.resolve(here, '../../..')
const productLauncher = pathToFileURL(path.join(productRoot, 'apps/tradeloom-launcher/core.mjs')).href
const productPrepare = pathToFileURL(path.join(productRoot, 'apps/tradeloom-launcher/prepare-profile.mjs')).href
const productReceipt = pathToFileURL(path.join(productRoot, 'apps/tradeloom-launcher/desktop-receipt.mjs')).href
const coreApi = await import(productLauncher)
const prepareApi = await import(productPrepare)
const receiptApi = await import(productReceipt)
const evidenceRoot = path.join(productRoot, 'workspace', 'testing', 'evidence')
const temporaryRoots = new Set()

afterEach(async () => {
  await Promise.all([...temporaryRoots].map(root => rm(root, { recursive: true, force: true })))
  temporaryRoots.clear()
})

async function fixture() {
  await mkdir(evidenceRoot, { recursive: true })
  const root = await mkdtemp(path.join(evidenceRoot, 'bootstrap-test-'))
  temporaryRoots.add(root)
  const local = path.join(root, 'local')
  const paths = coreApi.getDefaultPaths({ LOCALAPPDATA: local })
  const product = path.join(local, 'TradeLoom')
  const workspace = paths.workspace
  const resourceRoot = path.join(root, 'resources', 'tradeloom')
  const releases = path.join(product, 'runtime', 'releases')
  const runtime = path.join(releases, 'fixture-1')
  const python = path.join(product, 'python-env', 'Scripts', 'python.exe')
  const manage = path.join(product, 'backend', 'manage.py')
  const lock = { upstream: { commit: 'fixture-commit' }, patches: { 'patch-a': 'sha256-a' } }
  const appMain = 'fixture app main module\n'
  const appPath = path.join(root, 'installed-app')
  await mkdir(path.join(appPath, 'lib'), { recursive: true })
  await writeFile(path.join(appPath, 'lib', 'main.js'), appMain)
  await mkdir(resourceRoot, { recursive: true })
  await writeFile(path.join(resourceRoot, BOOTSTRAP_MARKER), BOOTSTRAP_MARKER_CONTENT)
  await mkdir(path.dirname(python), { recursive: true })
  await mkdir(path.dirname(manage), { recursive: true })
  await writeFile(python, 'fixture executable placeholder')
  await writeFile(manage, '# fixture only; never executed')
  await mkdir(releases, { recursive: true })
  const manifest = { schemaVersion: 1, runtime: path.relative(product, runtime), python: path.relative(product, python),
    manage: path.relative(product, manage), cwd: 'workspace', hostAddress: '192.168.4.20',
    appMainSha256: createHash('sha256').update(appMain).digest('hex'), lock }
  await writeFile(path.join(resourceRoot, 'deployment.json'), JSON.stringify(manifest))
  return { root, local, paths, product, workspace, resourceRoot, releases, runtime, python, manage, appPath, appMain, lock, manifest }
}

function dependencies(fx, overrides = {}) {
  const calls = { imports: 0, receipt: 0, started: 0, stopped: 0, closed: 0, reads: [] }
  const deps = {
    fs: {
      lstat: async target => (await import('node:fs/promises')).lstat(target),
      readFile: async (target, ...args) => { calls.reads.push(path.resolve(target)); return readFile(target, ...args) },
    },
    getDefaultPaths: coreApi.getDefaultPaths,
    changeCwd: async directory => { calls.cwd = directory },
    ensureOwnedHome: async home => {
      await coreApi.ensureOwnedHome(home)
      const profile = path.join(home, 'profiles', 'desktop')
      await mkdir(profile, { recursive: true })
      await writeFile(path.join(profile, 'package.json'), JSON.stringify({ dsh: { profile: { bundles: prepareApi.profileBundles } } }))
    },
    ensureOwnedDirectory: coreApi.ensureOwnedDirectory,
    buildChildEnvironment: coreApi.buildChildEnvironment,
    reserveNamedPipe: async () => ({ close: async () => { calls.closed += 1 } }),
    assertPortsAvailable: async () => {},
    startOwnedChild: () => {
      calls.started += 1
      return { spawned: Promise.resolve(), exited: new Promise(() => {}), stop: async () => { calls.stopped += 1 } }
    },
    verifyReceipt: async () => { calls.receipt += 1; return { compiledFiles: { 'apps/desktop/lib/main.js': fx.manifest.appMainSha256 } } },
    profileBundles: prepareApi.profileBundles,
    managedReleaseRoot: fx.releases,
    networkInterfaces: () => ({ ethernet: [{ family: 'IPv4', address: fx.manifest.hostAddress, internal: false }] }),
    delay: async () => {},
    connect: async () => true,
    installQuitHandler: async () => {},
    waitForDesktopReady: async () => {},
    importMain: async () => { calls.imports += 1 },
    readyTimeoutMs: 25,
    ...overrides,
  }
  return { deps, calls }
}

test('managed entry isolates environment, validates receipt, and imports main without starting Django', async () => {
  const fx = await fixture()
  const runtimeApp = path.join(fx.runtime, 'apps', 'desktop')
  await mkdir(runtimeApp, { recursive: true })
  await mkdir(path.join(runtimeApp, 'lib'), { recursive: true })
  await writeFile(path.join(runtimeApp, 'lib', 'main.js'), fx.appMain)
  const env = { LOCALAPPDATA: fx.paths.localAppData, DSH_HOME: fx.paths.home, DSH_AGENTS_HOME: fx.paths.agentsHome,
    TRADELOOM_DSH_APP_HOME: fx.paths.home, DSH_API_KEY: 'sentinel', TRADELOOM_EXTERNAL_SUPERVISOR: '1' }
  const processEnv = { ...env }
  const { deps, calls } = dependencies(fx, { importMain: async () => {
    calls.imports += 1
    assert.equal(processEnv.DSH_HOME, fx.paths.home)
    assert.equal(processEnv.DSH_AGENTS_HOME, fx.paths.agentsHome)
    assert.equal(processEnv.DSH_WORKSPACE, fx.paths.workspace)
    assert.equal(processEnv.LOCALAPPDATA, fx.paths.localAppData)
    assert.equal(processEnv.DSH_API_KEY, undefined)
    assert.equal(calls.cwd, fx.workspace)
  } })
  const result = await bootstrapDesktop({ env, processEnv, appPath: runtimeApp, resourcesPath: path.dirname(fx.resourceRoot), platform: process.platform, deps })
  assert.equal(result.managed, true)
  assert.equal(calls.receipt, 1)
  assert.equal(calls.started, 0)
  assert.equal(calls.closed, 0)
  assert.equal(calls.imports, 1)
})

test('packaged first launch initializes the desktop profile through the supplied official initProfile adapter', async () => {
  const fx = await fixture()
  const initialized = []
  const { deps, calls } = dependencies(fx, {
    ensureOwnedHome: home => coreApi.ensureOwnedHome(home),
    initializeProfile: async (profileDir, bundles, runtime) => {
      initialized.push({ profileDir, bundles, runtime })
      await mkdir(profileDir, { recursive: true })
      await writeFile(path.join(profileDir, 'package.json'), JSON.stringify({ dsh: { profile: { bundles } } }))
    },
  })
  const startup = await bootstrapDesktop({ env: { LOCALAPPDATA: fx.local }, processEnv: { LOCALAPPDATA: fx.local },
    appPath: fx.appPath, resourcesPath: path.dirname(fx.resourceRoot), deps })
  await startup.ready
  assert.equal(initialized.length, 1)
  assert.equal(initialized[0].profileDir, path.join(fx.paths.home, 'profiles', 'desktop'))
  assert.deepEqual(initialized[0].bundles, prepareApi.profileBundles)
  assert.equal(initialized[0].runtime, fx.runtime)
  assert.equal(calls.imports, 1)
})

test('an environment manifest override is ignored and missing owned resources fail closed', async () => {
  const fx = await fixture()
  const foreign = path.join(fx.root, 'foreign-secret.json')
  await writeFile(foreign, JSON.stringify({ sentinel: 'must-not-be-read' }))
  await rm(path.join(fx.resourceRoot, 'deployment.json'))
  const env = { LOCALAPPDATA: fx.local, TRADELOOM_BOOTSTRAP_MANIFEST: foreign }
  const processEnv = { ...env }
  const { deps, calls } = dependencies(fx)
  await assert.rejects(bootstrapDesktop({ env, processEnv, appPath: fx.appPath, resourcesPath: path.dirname(fx.resourceRoot), deps }), /ENOENT/)
  assert.equal(calls.reads.includes(path.resolve(foreign)), false)
  assert.equal(calls.receipt, 0)
  assert.equal(calls.started, 0)
})

test('unmanaged startup rolls back its child and mutex when desktop readiness fails', async () => {
  const fx = await fixture()
  const env = { LOCALAPPDATA: fx.local }
  const processEnv = { ...env }
  const { deps, calls } = dependencies(fx, { waitForDesktopReady: async () => { throw new Error('synthetic desktop startup failure') } })
  const startup = await bootstrapDesktop({ env, processEnv, appPath: fx.appPath, resourcesPath: path.dirname(fx.resourceRoot), deps })
  await assert.rejects(startup.ready, /synthetic desktop startup failure/)
  assert.equal(calls.receipt, 1)
  assert.equal(calls.started, 1)
  assert.equal(calls.stopped, 1)
  assert.equal(calls.closed, 1)
})

test('bootstrap settles before app-ready Host readiness and exposes the deferred ready result', async () => {
  const fx = await fixture()
  let signalHostReady
  let appReady = false
  let hostReadyStarted = false
  const hostReady = new Promise(resolve => { signalHostReady = resolve })
  const { deps, calls } = dependencies(fx, {
    importMain: async () => { calls.imports += 1 },
    waitForDesktopReady: () => { hostReadyStarted = true; return hostReady },
  })
  const startup = await bootstrapDesktop({ env: { LOCALAPPDATA: fx.local }, processEnv: { LOCALAPPDATA: fx.local },
    appPath: fx.appPath, resourcesPath: path.dirname(fx.resourceRoot), deps })
  assert.equal(startup.ready instanceof Promise, true)
  assert.equal(hostReadyStarted, true)
  assert.equal(appReady, false)
  appReady = true // Simulate official main's app.whenReady().then(main) callback.
  signalHostReady()
  await startup.ready
  assert.equal(appReady, true)
  assert.equal(calls.imports, 1)
  assert.equal(calls.started, 1)
})

test('direct launch filters provider getters, preserves DB password, binds LAN host, changes cwd, and waits for spawn', async () => {
  const fx = await fixture()
  const env = { LOCALAPPDATA: fx.local, TRADELOOM_DB_PASSWORD: 'db-only-sentinel' }
  Object.defineProperty(env, 'ROUTER_PROVIDER_API_KEY', { enumerable: true, get() { throw new Error('provider secret read') } })
  const processEnv = { LOCALAPPDATA: fx.local }
  const { deps, calls } = dependencies(fx, {
    startOwnedChild: (_exe, _args, options) => {
      calls.started += 1
      assert.equal(options.env.TRADELOOM_DB_PASSWORD, 'db-only-sentinel')
      assert.equal(Object.hasOwn(options.env, 'ROUTER_PROVIDER_API_KEY'), false)
      return { spawned: Promise.resolve(), exited: new Promise(() => {}), stop: async () => { calls.stopped += 1 } }
    },
    importMain: async () => {
      calls.imports += 1
      assert.equal(processEnv.TRADELOOM_DSH_BIND_HOST, fx.manifest.hostAddress)
      assert.equal(processEnv.TRADELOOM_DSH_BIND_PORT, '3088')
      assert.equal(calls.cwd, fx.workspace)
    },
  })
  await bootstrapDesktop({ env, processEnv, appPath: fx.appPath, resourcesPath: path.dirname(fx.resourceRoot), deps })
  assert.equal(calls.started, 1)
  assert.equal(calls.imports, 1)
})

test('spawn rejection rolls back child and mutex without importing app main', async () => {
  const fx = await fixture()
  const processEnv = { LOCALAPPDATA: fx.local }
  const { deps, calls } = dependencies(fx, { startOwnedChild: () => ({
    spawned: Promise.reject(new Error('synthetic spawn failure')),
    exited: new Promise(() => {}), stop: async () => { calls.stopped += 1 },
  }) })
  await assert.rejects(bootstrapDesktop({ env: { LOCALAPPDATA: fx.local }, processEnv, appPath: fx.appPath,
    resourcesPath: path.dirname(fx.resourceRoot), deps }), /synthetic spawn failure/)
  assert.equal(calls.stopped, 1)
  assert.equal(calls.closed, 1)
  assert.equal(calls.imports, 0)
})

test('direct launch rejects a changed appPath main before starting Django', async () => {
  const fx = await fixture()
  await writeFile(path.join(fx.appPath, 'lib', 'main.js'), 'tampered app main')
  const { deps, calls } = dependencies(fx)
  await assert.rejects(bootstrapDesktop({ env: { LOCALAPPDATA: fx.local }, processEnv: { LOCALAPPDATA: fx.local },
    appPath: fx.appPath, resourcesPath: path.dirname(fx.resourceRoot), deps }), /appPath\/lib\/main.js.*SHA256/)
  assert.equal(calls.started, 0)
  assert.equal(calls.imports, 0)
})

test('packaged app.asar is accepted only as an ordinary archive with patched internal main access', async () => {
  const fx = await fixture()
  const appAsar = path.join(fx.root, 'resources', 'app.asar')
  await mkdir(path.dirname(appAsar), { recursive: true })
  await writeFile(appAsar, 'fixture archive placeholder')
  const virtualLib = path.join(appAsar, 'lib')
  const virtualMain = path.join(virtualLib, 'main.js')
  const { deps, calls } = dependencies(fx)
  const diskFs = deps.fs
  const virtualStat = { isSymbolicLink: () => false, isDirectory: () => true, isFile: () => false }
  const virtualFileStat = { isSymbolicLink: () => false, isDirectory: () => false, isFile: () => true }
  deps.fs = {
    ...diskFs,
    lstat: async target => {
      if (path.resolve(target) === path.resolve(virtualLib)) return virtualStat
      if (path.resolve(target) === path.resolve(virtualMain)) return virtualFileStat
      return diskFs.lstat(target)
    },
    readFile: async (target, ...args) => path.resolve(target) === path.resolve(virtualMain)
      ? fx.appMain
      : diskFs.readFile(target, ...args),
  }
  await bootstrapDesktop({ env: { LOCALAPPDATA: fx.local }, processEnv: { LOCALAPPDATA: fx.local },
    appPath: appAsar, resourcesPath: path.dirname(fx.resourceRoot), deps })
  assert.equal(calls.started, 1)
  assert.equal(calls.imports, 1)
})

test('an arbitrary regular-file appPath ancestor is still rejected', async () => {
  const fx = await fixture()
  const fakeBundle = path.join(fx.root, 'unexpected.bundle')
  await writeFile(fakeBundle, 'not an asar')
  const { deps, calls } = dependencies(fx)
  await assert.rejects(bootstrapDesktop({ env: { LOCALAPPDATA: fx.local }, processEnv: { LOCALAPPDATA: fx.local },
    appPath: fakeBundle, resourcesPath: path.dirname(fx.resourceRoot), deps }), /物理祖先不是普通目录/)
  assert.equal(calls.started, 0)
  assert.equal(calls.imports, 0)
})

test('named-pipe mutex rejects a second owner for the same isolated home', async () => {
  const server = await coreApi.reserveNamedPipe(lockName(path.join(os.tmpdir(), 'tradeloom-test-home'), process.platform))
  try {
    await assert.rejects(coreApi.reserveNamedPipe(lockName(path.join(os.tmpdir(), 'tradeloom-test-home'), process.platform)))
  } finally {
    await new Promise(resolve => server.close(resolve))
  }
})

test('owned services stop only after will-quit, once, and cleanup failures are reported', async () => {
  const { installDeferredQuitCleanup } = await import('../bootstrap-core.mjs')
  assert.equal(typeof installDeferredQuitCleanup, 'function')

  class FakeApp {
    listeners = new Map()
    quitCalls = 0
    exited = false
    on(name, listener) { this.listeners.set(name, [...(this.listeners.get(name) ?? []), listener]) }
    emit(name) {
      const event = { defaultPrevented: false, preventDefault() { this.defaultPrevented = true } }
      for (const listener of this.listeners.get(name) ?? []) listener(event)
      return event.defaultPrevented
    }
    quit() {
      this.quitCalls += 1
      if (!this.emit('will-quit')) this.exited = true
    }
  }

  const canceledApp = new FakeApp()
  let canceledCleanupCalls = 0
  canceledApp.on('before-quit', event => event.preventDefault())
  installDeferredQuitCleanup(canceledApp, async () => { canceledCleanupCalls += 1 })
  // The upstream before-quit confirmation can cancel without emitting will-quit.
  assert.equal(canceledApp.emit('before-quit'), true)
  assert.equal(canceledCleanupCalls, 0)
  assert.equal(canceledApp.exited, false)

  const app = new FakeApp()
  let finishCleanup
  let cleanupCalls = 0
  const errors = []
  installDeferredQuitCleanup(app, () => {
    cleanupCalls += 1
    return new Promise((_resolve, reject) => { finishCleanup = () => reject(new Error('cleanup failed')) })
  }, error => errors.push(error.message))

  assert.equal(app.emit('will-quit'), true)
  await Promise.resolve()
  assert.equal(cleanupCalls, 1)
  assert.equal(app.quitCalls, 0)
  assert.equal(app.emit('will-quit'), true)
  assert.equal(cleanupCalls, 1)
  finishCleanup()
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(errors[0], 'cleanup failed')
  assert.equal(cleanupCalls, 1)
  assert.equal(app.quitCalls, 1)
  assert.equal(app.exited, true)
})

test('approved will-quit waits for owned-service cleanup before allowing app.quit to finish', async () => {
  const { installDeferredQuitCleanup } = await import('../bootstrap-core.mjs')
  const calls = []
  let resolveCleanup
  const app = {
    listeners: [],
    quitCalls: 0,
    on(_name, listener) { this.listeners.push(listener) },
    emitWillQuit() {
      const event = { prevented: false, preventDefault() { this.prevented = true } }
      for (const listener of this.listeners) listener(event)
      return event.prevented
    },
    quit() { this.quitCalls += 1; if (!this.emitWillQuit()) calls.push('exit') },
  }
  installDeferredQuitCleanup(app, () => {
    calls.push('cleanup-start')
    return new Promise(resolve => { resolveCleanup = () => { calls.push('cleanup-end'); resolve() } })
  })

  assert.equal(app.emitWillQuit(), true)
  await Promise.resolve()
  assert.deepEqual(calls, ['cleanup-start'])
  assert.equal(app.quitCalls, 0)
  resolveCleanup()
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(calls, ['cleanup-start', 'cleanup-end', 'exit'])
  assert.equal(app.quitCalls, 1)
})

test('receipt writer refuses false build evidence and existing receipts; verifier detects tampering', async () => {
  const fx = await fixture()
  const pinnedCommit = prepareApi.runtimeMarkerContents.split('\n')[1]
  const marker = prepareApi.runtimeMarkerContents
  const lock = { upstream: { commit: pinnedCommit }, patches: { 'patch-a': 'sha256-a' } }
  const runtime = path.join(fx.releases, 'receipt-fixture')
  await mkdir(runtime, { recursive: true })
  await writeFile(path.join(runtime, prepareApi.runtimeMarkerName), marker)
  for (const relative of RECEIPT_FILES) {
    const file = path.join(runtime, relative)
    await mkdir(path.dirname(file), { recursive: true })
    await writeFile(file, `compiled fixture ${relative}`)
  }
  const buildEvidence = { patchesApplied: true, officialBuildExitCode: 0, sourceCommit: pinnedCommit,
    patchSetSha256: patchSetDigest(lock.patches), builder: 'fixture-builder' }
  const args = { runtimePath: runtime, releaseRoot: fx.releases, lock, buildEvidence, runtimeMarker: marker,
    validateOwnedRuntime: prepareApi.validateOwnedRuntime }
  await assert.rejects(writeDesktopBuildReceipt({ ...args, buildEvidence: { ...buildEvidence, officialBuildExitCode: 1 } }), /外部 builder/)
  await writeDesktopBuildReceipt(args)
  await receiptApi.verifyDesktopBuildReceipt(runtime, lock, fx.releases)
  await assert.rejects(writeDesktopBuildReceipt(args), error => error.code === 'EEXIST')
  await writeFile(path.join(runtime, RECEIPT_FILES[0]), 'tampered compiled entry')
  await assert.rejects(receiptApi.verifyDesktopBuildReceipt(runtime, lock, fx.releases), /hash 与构建凭证不匹配/)
})

test('receipt writer atomically links a complete receipt and cleans its private temporary file on collision', async () => {
  const fx = await fixture()
  const pinnedCommit = prepareApi.runtimeMarkerContents.split('\n')[1]
  const marker = prepareApi.runtimeMarkerContents
  const lock = { upstream: { commit: pinnedCommit }, patches: { 'patch-a': 'sha256-a' } }
  const runtime = path.join(fx.releases, 'atomic-receipt-fixture')
  await mkdir(runtime, { recursive: true })
  await writeFile(path.join(runtime, prepareApi.runtimeMarkerName), marker)
  for (const relative of RECEIPT_FILES) {
    const file = path.join(runtime, relative)
    await mkdir(path.dirname(file), { recursive: true })
    await writeFile(file, `compiled fixture ${relative}`)
  }
  const args = { runtimePath: runtime, releaseRoot: fx.releases, lock,
    buildEvidence: { patchesApplied: true, officialBuildExitCode: 0, sourceCommit: pinnedCommit,
      patchSetSha256: patchSetDigest(lock.patches), builder: 'atomic-fixture-builder' },
    runtimeMarker: marker, validateOwnedRuntime: prepareApi.validateOwnedRuntime }
  const written = await writeDesktopBuildReceipt(args)
  const destination = path.join(runtime, '.tradeloom-desktop-build-receipt.json')
  assert.equal(await readFile(destination, 'utf8'), `${JSON.stringify(written.receipt, null, 2)}\n`)
  await assert.rejects(writeDesktopBuildReceipt(args), error => error.code === 'EEXIST')
  const names = await (await import('node:fs/promises')).readdir(runtime)
  assert.equal(names.some(name => name.includes('.tmp-')), false)
})
