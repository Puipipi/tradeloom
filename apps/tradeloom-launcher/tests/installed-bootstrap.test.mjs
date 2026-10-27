import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import os from 'node:os'
import path from 'node:path'
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { bootstrapInstalledDesktop, parsePackagedPortFlags, DATA_ROOT_MARKER, DATA_ROOT_MARKER_CONTENT, digestInventory, pythonRunArgs, runCommandFile, runControllerFile, validateInstalledManifest } from '../installed-bootstrap.mjs'
import { getDefaultPaths, OWNED_MARKER, OWNED_MARKER_CONTENT } from '../core.mjs'

const hash = value => createHash('sha256').update(value).digest('hex')

async function writeFileRecord(root, relative, content) {
  const full = path.join(root, ...relative.split('/'))
  await mkdir(path.dirname(full), { recursive: true })
  await writeFile(full, content)
  return { path: relative, bytes: Buffer.byteLength(content), sha256: hash(content) }
}

async function inventory(root, prefix = '') {
  const records = []
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const relative = prefix ? prefix + '/' + entry.name : entry.name
    const full = path.join(root, entry.name)
    if (entry.isDirectory()) records.push(...await inventory(full, relative))
    else {
      const bytes = await readFile(full)
      records.push({ path: relative, bytes: bytes.length, sha256: hash(bytes) })
    }
  }
  return records
}

async function installStage6ShellAsNewResource(f, stage6Root) {
  const stage6Manifest = JSON.parse(await readFile(path.join(stage6Root, 'package.json'), 'utf8'))
  await cp(stage6Root, f.shellRoot, { recursive: true })
  const legacyRecords = await inventory(f.shellRoot)
  assert.equal(legacyRecords.length, 11)
  assert.equal(digestInventory(legacyRecords), 'b86ae8b432b6a9cfb28582673d1867b0bfa7f39b8d9cd65c29f3ed692fb3766f')
  await writeFile(path.join(f.shellRoot, 'profile-tool.js'), await readFile(new URL('../../../packages/tradeloom-shell/profile-tool.js', import.meta.url)))
  const records = await inventory(f.shellRoot)
  assert.equal(records.length, 11)
  const names = ['package.json', ...stage6Manifest.files]
  const resourceRecords = records.filter(record => names.includes(record.path))
  assert.equal(resourceRecords.length, names.length)
  f.manifest.resources.businessShell = {
    ...f.manifest.resources.businessShell,
    version: stage6Manifest.version,
    fileCount: resourceRecords.length,
    bytes: resourceRecords.reduce((sum, item) => sum + item.bytes, 0),
    sha256: digestInventory(resourceRecords),
  }
  await writeFile(path.join(f.resourcesPath, 'tradeloom', 'deployment.json'), JSON.stringify(f.manifest))
  return { legacyRecords, resourceRecords }
}

async function seedExistingProfile(f, bundleRoot) {
  const home = path.join(f.privateData, 'harness-home')
  const profile = path.join(home, 'profiles', 'desktop')
  const bundle = path.join(profile, 'node_modules', '@tradeloom', 'dsh-business-shell')
  await mkdir(f.privateData, { recursive: true })
  await writeFile(path.join(f.privateData, DATA_ROOT_MARKER), DATA_ROOT_MARKER_CONTENT)
  await mkdir(home, { recursive: true })
  await writeFile(path.join(home, OWNED_MARKER), OWNED_MARKER_CONTENT)
  await mkdir(path.dirname(bundle), { recursive: true })
  await cp(bundleRoot, bundle, { recursive: true })
  await writeFile(path.join(profile, 'package.json'), JSON.stringify({ dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', '@tradeloom/dsh-business-shell'] } } }))
  await writeFile(path.join(profile, 'settings.json'), '{"theme":"fixture"}\n')
  await writeFile(path.join(profile, 'credentials.yaml'), 'fixture: opaque-value\n')
  await mkdir(path.join(profile, 'sessions'), { recursive: true })
  await writeFile(path.join(profile, 'sessions', 'session.jsonl'), '{"fixture":"session"}\n')
  await writeFile(path.join(profile, 'state.json'), '{"fixture":"state"}\n')
  return { home, profile, bundle }
}

async function hashPreservedProfileFiles(profile) {
  const files = ['package.json', 'settings.json', 'credentials.yaml', 'sessions/session.jsonl', 'state.json']
  return Object.fromEntries(await Promise.all(files.map(async relative => [relative, hash(await readFile(path.join(profile, ...relative.split('/'))))])))
}

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'tradeloom-installed-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const resourcesPath = path.join(root, 'resources')
  const appPath = path.join(root, 'app.asar')
  const privateData = path.join(root, 'private-data')
  const appMain = 'export const fixture = true\n'
  const mainPath = path.join(appPath, 'lib', 'main.js')
  await mkdir(path.dirname(mainPath), { recursive: true })
  await writeFile(mainPath, appMain)
  const backendRoot = path.join(resourcesPath, 'tradeloom', 'backend')
  const backendFiles = []
  for (const [name, content] of [
    ['manage.py', 'print("django fixture")\n'],
    ['requirements-workbench.txt', 'Django==5.2.18\n'],
    ['config/settings.py', 'SECRET_KEY = "fixture"\n'],
    ['workbench/__init__.py', ''],
    ['data/samples/sample.json', '{}\n'],
  ]) backendFiles.push(await writeFileRecord(backendRoot, name, content))

  const shellRoot = path.join(resourcesPath, 'tradeloom', 'business-shell')
  const shellPackage = JSON.stringify({ name: '@tradeloom/dsh-business-shell', version: '0.1.0', files: ['host.js'] })
  const shellFiles = [await writeFileRecord(shellRoot, 'package.json', shellPackage), await writeFileRecord(shellRoot, 'host.js', 'export default {}\n')]

  const pythonPath = path.join(resourcesPath, 'runtime', 'primary-runtime', 'dependencies', 'python', 'python.exe')
  const packagesRoot = path.join(resourcesPath, 'tradeloom', 'python-packages')
  await mkdir(path.dirname(pythonPath), { recursive: true })
  await writeFile(pythonPath, 'python fixture')
  await mkdir(packagesRoot, { recursive: true })
  const pythonFiles = [await writeFileRecord(packagesRoot, 'django.py', 'fixture')]

  const postgresRoot = path.join(resourcesPath, 'tradeloom', 'postgresql', 'pgsql')
  const entrypoints = []
  for (const name of ['postgres', 'pg_ctl', 'initdb', 'psql', 'createdb']) {
    const relative = `bin/${name}.exe`
    const record = await writeFileRecord(postgresRoot, relative, `${name} fixture`)
    entrypoints.push({ name, path: `pgsql/${relative}`, sha256: record.sha256, version: 'PostgreSQL 17.11' })
  }

  const resourcesRoot = path.join(resourcesPath, 'tradeloom')
  await writeFile(path.join(resourcesRoot, '.tradeloom-bootstrap-owned'), 'tradeloom-bootstrap-v1\n')
  const manifest = {
    schemaVersion: 2, deploymentMode: 'packaged',
    runtime: { root: 'resources/runtime/primary-runtime', python: 'resources/runtime/primary-runtime/dependencies/python/python.exe', version: '3.12.14', providedBy: 'official-electron-builder' },
    sourceBuild: { appMainSha256: hash(appMain), lock: { upstream: { commit: 'fixture' }, patches: { fixture: 'sha256' } } },
    resources: {
      business: { root: 'resources/tradeloom/backend', files: backendFiles, fileCount: backendFiles.length, bytes: backendFiles.reduce((sum, item) => sum + item.bytes, 0), sha256: digestInventory(backendFiles) },
      businessShell: { root: 'resources/tradeloom/business-shell', version: '0.1.0', fileCount: shellFiles.length, bytes: shellFiles.reduce((sum, item) => sum + item.bytes, 0), sha256: digestInventory(shellFiles) },
      pythonDependencies: { root: 'resources/tradeloom/python-packages', version: '3.12.14', fileCount: pythonFiles.length, bytes: pythonFiles.reduce((sum, item) => sum + item.bytes, 0), sha256: digestInventory(pythonFiles), distributions: [], licenses: [] },
      postgresql: { root: 'resources/tradeloom/postgresql/pgsql', version: '17.11', fileCount: entrypoints.length, bytes: entrypoints.reduce((sum, item) => sum + Buffer.byteLength(`${item.name} fixture`), 0), sha256: digestInventory(entrypoints.map(item => ({ path: item.path, bytes: Buffer.byteLength(`${item.name} fixture`), sha256: item.sha256 }))), licenses: [], entrypoints },
    },
  }
  // Tree hashes for Python and PostgreSQL are manifest metadata; startup verifies concrete executable hashes.
  await writeFile(path.join(resourcesRoot, 'deployment.json'), JSON.stringify(manifest))
  return { root, resourcesPath, appPath, privateData, manifest, shellRoot }
}

function runtimeDeps(state) {
  const networkAdapters = [{ name: 'Wi-Fi', kind: 'wifi', status: 'Up', hardwareInterface: true, addresses: [{ addressFamily: 'IPv4', address: '192.168.8.20' }] }]
  return {
    listenerOwner: async (port, pid) => port === 55432 && pid === 12345,
    createNativeBridgeKey: () => 'e'.repeat(64),
    getDefaultPaths: env => getDefaultPaths(env),
    readNetworkAdapters: async () => networkAdapters,
    chooseNetworkAddress: async candidates => candidates[0].address,
    assertPortsAvailable: async ports => {
      state.ports.push(...ports)
      if (state.foreignPostgres && ports.some(([, port]) => port === 55432)) throw new Error('EADDRINUSE')
    },
    reserveNamedPipe: async () => ({ listening: true, close(callback) { this.listening = false; callback?.() } }),
    initializeProfile: async (_app, profileDir, bundles) => {
      await mkdir(profileDir, { recursive: true })
      await writeFile(path.join(profileDir, 'package.json'), JSON.stringify({ dsh: { profile: { bundles } } }))
    },
    runControllerFile: async (_command, args, options) => {
      state.events.push(`pgctl:${args[0]}`)
      state.controllerBridgeKeys ??= []
      state.controllerBridgeKeys.push(options?.env?.TRADELOOM_NATIVE_BRIDGE_KEY)
      if (args[0] === 'status') return { code: state.pgActive ? 0 : 3 }
      if (args[0] === 'start') { state.pgActive = true; return { code: 0 } }
      if (args[0] === 'stop') { state.pgActive = false; return { code: 0 } }
      return { code: 0 }
    },
    runFile: async (command, args, options) => {
      state.helperBridgeKeys ??= []
      state.helperBridgeKeys.push({ command: path.basename(command).toLowerCase(), key: options?.env?.TRADELOOM_NATIVE_BRIDGE_KEY, args: [...args] })
      if (path.basename(command).toLowerCase() === 'initdb.exe') {
        const dataDir = args[args.indexOf('-D') + 1]
        await mkdir(dataDir, { recursive: true })
        await writeFile(path.join(dataDir, 'PG_VERSION'), '17\n')
        state.events.push('initdb')
        state.initdbArgs = args
        return { code: 0 }
      }
      if (path.basename(command).toLowerCase() === 'createdb.exe') {
        state.databaseExists = true
        state.events.push('createdb')
        return { code: 0 }
      }
      const commandArg = args.find(value => ['migrate', 'runserver', '-tAc'].includes(value))
      if (commandArg === '-tAc') { state.events.push('database-check'); return { code: 0, stdout: state.databaseExists ? '1' : '' } }
      const spec = args.at(-1)
      if (typeof spec === 'string' && spec.startsWith('{')) {
        const djangoArgs = JSON.parse(spec).args
        state.events.push('django:' + djangoArgs[0])
        if (djangoArgs[0] === 'migrate') {
          state.assertPasswordChildEnv = options.env.TRADELOOM_DB_PASSWORD === state.password && options.env.PGPASSWORD === undefined
          state.pythonArgs = args
          return { code: state.migrationCode }
        }
      }
      return { code: 0, stdout: '' }
    },
    startOwnedChild: (_command, args, options) => {
      const spec = JSON.parse(args.at(-1))
      state.events.push('django:' + spec.args[0])
      state.djangoEnv = options.env
      state.djangoBridgeKey = options.env.TRADELOOM_NATIVE_BRIDGE_KEY
      state.djangoArgs = args
      state.djangoLogPath = options.logPath
      state.assertDjangoEnv = options.env.TRADELOOM_MEDIA_ROOT === path.join(state.dataRoot, 'media') && options.env.TRADELOOM_ARTIFACT_ROOT === path.join(state.dataRoot, 'artifacts')
      return { spawned: Promise.resolve(), exited: new Promise(() => {}), stop: async () => { state.events.push('django:stop') } }
    },
    installQuitHandler: async stop => { state.quit = stop },
    connect: async (_host, port) => port === (state.djangoPort ?? 3090) ? true : state.pgActive,
    delay: async () => {},
    waitForDesktopReady: async () => { state.events.push('dsh:ready') },
    importMain: async () => { state.events.push('main:import') },
    generatePassword: () => state.password,
  }
}

test('packaged bootstrap validates schema 2, initializes isolated runtime in order, and materializes the shell package', async t => {
  const f = await fixture(t)
  const state = { events: [], ports: [], pgActive: false, databaseExists: false, migrationCode: 0, password: 'local-only-test-password', dataRoot: f.privateData }
  const env = { LOCALAPPDATA: path.join(f.root, 'local'), TRADELOOM_DATA_ROOT: f.privateData, DSH_HOME: 'ignored-personal-value', DSH_API_KEY: 'ignored-secret' }
  const processEnv = {}
  const startup = await bootstrapInstalledDesktop({ env, processEnv, appPath: f.appPath, resourcesPath: f.resourcesPath, platform: 'win32', deps: runtimeDeps(state) })
  await startup.ready
  assert.equal(startup.hostAddress, '192.168.8.20')
  assert.ok(state.ports.some(([host, port]) => host === '192.168.8.20' && port === 3088))
  assert.ok(state.ports.some(([host, port]) => host === '127.0.0.1' && port === 3090))
  assert.deepEqual(state.events.slice(0, 8), ['pgctl:status', 'initdb', 'pgctl:start', 'database-check', 'createdb', 'django:migrate', 'django:runserver', 'main:import'])
  assert.ok(state.initdbArgs.includes('scram-sha-256'))
  assert.ok(state.initdbArgs.includes('--encoding=UTF8'))
  assert.ok(state.initdbArgs.includes('--locale=C'))
  assert.ok(state.initdbArgs.includes('--pwfile'))
  assert.ok(!state.initdbArgs.includes(state.password))
  assert.equal(state.assertPasswordChildEnv, true)
  assert.ok(state.pythonArgs.includes('-I'))
  assert.ok(state.pythonArgs.includes('-B'))
  assert.match(state.pythonArgs[state.pythonArgs.indexOf('-c') + 1], /sys\.path\.insert/)
  assert.match(pythonRunArgs('python.exe', 'backend', 'packages', 'manage.py', ['migrate'])[3], /runpy\.run_path/)
  assert.equal(state.assertDjangoEnv, true)
  assert.equal(processEnv.DSH_HOME, startup.paths.home)
  assert.equal(processEnv.DSH_API_KEY, undefined)
  assert.equal(processEnv.TRADELOOM_NATIVE_BRIDGE_KEY, 'e'.repeat(64))
  assert.equal(state.djangoBridgeKey, processEnv.TRADELOOM_NATIVE_BRIDGE_KEY)
  assert.equal(JSON.stringify(state.djangoArgs).includes(state.djangoBridgeKey), false)
  assert.equal(state.djangoLogPath.includes(state.djangoBridgeKey), false)
  assert.ok(state.controllerBridgeKeys.every(key => key === undefined), 'PostgreSQL controller never receives the bridge key')
  assert.ok(state.helperBridgeKeys.filter(item => item.command !== 'python.exe').every(item => item.key === undefined), 'PostgreSQL helpers never receive the bridge key')
  assert.ok(state.helperBridgeKeys.filter(item => item.command === 'python.exe').every(item => item.key === state.djangoBridgeKey), 'only Django Python helpers receive the shared key')
  assert.equal(JSON.stringify(f.manifest).includes(state.djangoBridgeKey), false)
  const profileRoot = path.join(startup.paths.home, 'profiles', 'desktop')
  const installedShell = path.join(profileRoot, 'node_modules', '@tradeloom', 'dsh-business-shell')
  assert.equal(await readFile(path.join(installedShell, 'host.js'), 'utf8'), 'export default {}\n')
  const bundleInventory = JSON.parse(await readFile(path.join(profileRoot, '.tradeloom-business-shell-inventory.json'), 'utf8'))
  assert.equal(bundleInventory.packageName, '@tradeloom/dsh-business-shell')
  assert.equal(bundleInventory.inventorySha256, digestInventory(await inventory(installedShell)))
  assert.equal(await readFile(path.join(startup.paths.postgresRoot, 'password'), 'utf8'), state.password + '\n')
  await startup.stop()
  assert.equal(state.pgActive, false)
  assert.ok(state.events.includes('pgctl:stop'))
})

test('packaged bootstrap upgrades the exact stage6 profile bundle transactionally and rejects unknown edits', async t => {
  const legacyRoot = process.env.TRADELOOM_STAGE6_BUSINESS_SHELL
  if (!legacyRoot) return t.skip('requires the frozen stage6 business-shell payload to verify the exact p7 legacy inventory')
  const f = await fixture(t)
  const { resourceRecords } = await installStage6ShellAsNewResource(f, legacyRoot)
  const seeded = await seedExistingProfile(f, legacyRoot)
  const legacyRecords = await inventory(seeded.bundle)
  assert.equal(legacyRecords.length, 11)
  assert.equal(digestInventory(legacyRecords), 'b86ae8b432b6a9cfb28582673d1867b0bfa7f39b8d9cd65c29f3ed692fb3766f')
  const preservedBefore = await hashPreservedProfileFiles(seeded.profile)
  const profileRecord = path.join(seeded.profile, '.tradeloom-business-shell-inventory.json')
  const packageParent = path.dirname(seeded.bundle)
  const realFs = await import('node:fs/promises')
  let injectFailure = true
  const failingFs = {
    ...realFs,
    async rename(from, to) {
      if (injectFailure && to === seeded.bundle && path.basename(from).startsWith('.tradeloom-business-shell-stage-')) {
        injectFailure = false
        throw Object.assign(new Error('fixture rename fault'), { code: 'EIO' })
      }
      return realFs.rename(from, to)
    },
  }
  const env = { LOCALAPPDATA: path.join(f.root, 'local'), TRADELOOM_DATA_ROOT: f.privateData }
  const failedState = { events: [], ports: [], pgActive: false, databaseExists: false, migrationCode: 0, password: 'fixture-only', dataRoot: f.privateData }
  await assert.rejects(bootstrapInstalledDesktop({ env, processEnv: {}, appPath: f.appPath, resourcesPath: f.resourcesPath,
    platform: 'win32', deps: { ...runtimeDeps(failedState), fs: failingFs } }), /fixture rename fault/)
  assert.equal(digestInventory(await inventory(seeded.bundle)), 'b86ae8b432b6a9cfb28582673d1867b0bfa7f39b8d9cd65c29f3ed692fb3766f')
  await assert.rejects(readFile(profileRecord), { code: 'ENOENT' })
  assert.deepEqual(await hashPreservedProfileFiles(seeded.profile), preservedBefore)
  assert.ok(!failedState.events.includes('pgctl:status'), 'bundle failure must precede PostgreSQL startup')

  const state = { events: [], ports: [], pgActive: false, databaseExists: false, migrationCode: 0, password: 'fixture-only', dataRoot: f.privateData }
  const startup = await bootstrapInstalledDesktop({ env, processEnv: {}, appPath: f.appPath, resourcesPath: f.resourcesPath, platform: 'win32', deps: runtimeDeps(state) })
  await startup.ready
  const installedRecords = await inventory(seeded.bundle)
  const expectedHash = digestInventory(resourceRecords)
  assert.equal(digestInventory(installedRecords), expectedHash)
  assert.deepEqual(JSON.parse(await readFile(profileRecord, 'utf8')), {
    schemaVersion: 1,
    packageName: '@tradeloom/dsh-business-shell',
    inventorySha256: expectedHash,
    fileCount: resourceRecords.length,
    bytes: resourceRecords.reduce((sum, item) => sum + item.bytes, 0),
  })
  assert.deepEqual(await hashPreservedProfileFiles(seeded.profile), preservedBefore)
  const backups = (await readdir(packageParent)).filter(name => name.startsWith('.tradeloom-business-shell-backup-'))
  assert.equal(backups.length, 1)
  assert.equal(digestInventory(await inventory(path.join(packageParent, backups[0]))), 'b86ae8b432b6a9cfb28582673d1867b0bfa7f39b8d9cd65c29f3ed692fb3766f')
  await startup.stop()

  const repeatState = { events: [], ports: [], pgActive: false, databaseExists: false, migrationCode: 0, password: 'fixture-only', dataRoot: f.privateData }
  const repeated = await bootstrapInstalledDesktop({ env, processEnv: {}, appPath: f.appPath, resourcesPath: f.resourcesPath, platform: 'win32', deps: runtimeDeps(repeatState) })
  await repeated.ready
  assert.equal((await readdir(packageParent)).filter(name => name.startsWith('.tradeloom-business-shell-backup-')).length, 1)
  await repeated.stop()

  await writeFile(path.join(seeded.bundle, 'host.js'), 'user edit\n')
  const hostileState = { events: [], ports: [], pgActive: false, databaseExists: false, migrationCode: 0, password: 'fixture-only', dataRoot: f.privateData }
  await assert.rejects(bootstrapInstalledDesktop({ env, processEnv: {}, appPath: f.appPath, resourcesPath: f.resourcesPath,
    platform: 'win32', deps: runtimeDeps(hostileState) }), /profile business-shell.*(?:修改|不匹配|不一致|不受信)/)
  assert.equal(await readFile(path.join(seeded.bundle, 'host.js'), 'utf8'), 'user edit\n')
  assert.ok(!hostileState.events.includes('pgctl:status'))
})

test('packaged bootstrap detects a linked profile package manifest before reading it', async t => {
  const legacyRoot = process.env.TRADELOOM_STAGE6_BUSINESS_SHELL
  if (!legacyRoot) return t.skip('requires the frozen stage6 business-shell payload to verify the exact p7 legacy inventory')
  const f = await fixture(t)
  await installStage6ShellAsNewResource(f, legacyRoot)
  const seeded = await seedExistingProfile(f, legacyRoot)
  const manifestPath = path.join(seeded.bundle, 'package.json')
  const realFs = await import('node:fs/promises')
  let manifestRead = false
  const linkedFs = {
    ...realFs,
    async lstat(target, ...args) {
      if (path.resolve(target) === path.resolve(manifestPath)) return { isSymbolicLink: () => true }
      return realFs.lstat(target, ...args)
    },
    async readFile(target, ...args) {
      if (path.resolve(target) === path.resolve(manifestPath)) manifestRead = true
      return realFs.readFile(target, ...args)
    },
  }
  const state = { events: [], ports: [], pgActive: false, databaseExists: false, migrationCode: 0, password: 'fixture-only', dataRoot: f.privateData }
  await assert.rejects(bootstrapInstalledDesktop({ env: { LOCALAPPDATA: path.join(f.root, 'local'), TRADELOOM_DATA_ROOT: f.privateData },
    processEnv: {}, appPath: f.appPath, resourcesPath: f.resourcesPath, platform: 'win32', deps: { ...runtimeDeps(state), fs: linkedFs } }), /安装资源树不能包含链接/)
  assert.equal(manifestRead, false, 'must reject the linked package.json before reading through it')
  assert.ok(!state.events.includes('pgctl:status'))
})

test('packaged bootstrap resumes an interrupted legacy bundle swap from its exact owned backup', async t => {
  const legacyRoot = process.env.TRADELOOM_STAGE6_BUSINESS_SHELL
  if (!legacyRoot) return t.skip('requires the frozen stage6 business-shell payload to verify the exact p7 legacy inventory')
  const f = await fixture(t)
  const { resourceRecords } = await installStage6ShellAsNewResource(f, legacyRoot)
  const seeded = await seedExistingProfile(f, legacyRoot)
  const legacyRecords = await inventory(seeded.bundle)
  await writeFile(path.join(seeded.profile, '.tradeloom-business-shell-inventory.json'), JSON.stringify({
    schemaVersion: 1,
    packageName: '@tradeloom/dsh-business-shell',
    inventorySha256: digestInventory(legacyRecords),
    fileCount: legacyRecords.length,
    bytes: legacyRecords.reduce((sum, item) => sum + item.bytes, 0),
  }) + '\n')
  const backupPath = path.join(path.dirname(seeded.bundle), '.tradeloom-business-shell-backup-interrupted-fixture')
  const fs = await import('node:fs/promises')
  await fs.rename(seeded.bundle, backupPath)
  const state = { events: [], ports: [], pgActive: false, databaseExists: false, migrationCode: 0, password: 'fixture-only', dataRoot: f.privateData }
  const startup = await bootstrapInstalledDesktop({ env: { LOCALAPPDATA: path.join(f.root, 'local'), TRADELOOM_DATA_ROOT: f.privateData },
    processEnv: {}, appPath: f.appPath, resourcesPath: f.resourcesPath, platform: 'win32', deps: runtimeDeps(state) })
  await startup.ready
  assert.equal(digestInventory(await inventory(seeded.bundle)), digestInventory(resourceRecords))
  assert.ok(await fs.lstat(path.join(seeded.profile, '.tradeloom-business-shell-inventory.json')))
  assert.equal((await readdir(path.dirname(seeded.bundle))).filter(name => name.startsWith('.tradeloom-business-shell-backup-')).length, 1)
  await startup.stop()
})

test('packaged bootstrap rejects a recorded profile bundle missing without a trusted backup', async t => {
  const legacyRoot = process.env.TRADELOOM_STAGE6_BUSINESS_SHELL
  if (!legacyRoot) return t.skip('requires the frozen stage6 business-shell payload to verify the exact p7 legacy inventory')
  const f = await fixture(t)
  await installStage6ShellAsNewResource(f, legacyRoot)
  const seeded = await seedExistingProfile(f, legacyRoot)
  const legacyRecords = await inventory(seeded.bundle)
  const recordPath = path.join(seeded.profile, '.tradeloom-business-shell-inventory.json')
  await writeFile(recordPath, JSON.stringify({ schemaVersion: 1, packageName: '@tradeloom/dsh-business-shell',
    inventorySha256: digestInventory(legacyRecords), fileCount: legacyRecords.length,
    bytes: legacyRecords.reduce((sum, item) => sum + item.bytes, 0) }) + '\n')
  const displaced = path.join(path.dirname(seeded.bundle), '.unrecognized-business-shell-fixture')
  const fs = await import('node:fs/promises')
  await fs.rename(seeded.bundle, displaced)
  const state = { events: [], ports: [], pgActive: false, databaseExists: false, migrationCode: 0, password: 'fixture-only', dataRoot: f.privateData }
  await assert.rejects(bootstrapInstalledDesktop({ env: { LOCALAPPDATA: path.join(f.root, 'local'), TRADELOOM_DATA_ROOT: f.privateData },
    processEnv: {}, appPath: f.appPath, resourcesPath: f.resourcesPath, platform: 'win32', deps: runtimeDeps(state) }), /inventory\/bundle 不完整/)
  assert.equal(digestInventory(await inventory(displaced)), 'b86ae8b432b6a9cfb28582673d1867b0bfa7f39b8d9cd65c29f3ed692fb3766f')
  assert.ok(!state.events.includes('pgctl:status'))
})

test('packaged bootstrap reuses its existing owned cluster and preserves existing database files', async t => {
  const f = await fixture(t)
  const data = path.join(f.privateData, 'postgres', 'data')
  await mkdir(data, { recursive: true })
  await writeFile(path.join(f.privateData, '.tradeloom-data-root-owned'), 'tradeloom-app-data-v1\n')
  await writeFile(path.join(f.privateData, 'postgres', '.tradeloom-postgres-owned'), 'tradeloom-postgres-data-v1\n')
  await writeFile(path.join(f.privateData, 'postgres', 'password'), 'stable-local-password\n')
  await writeFile(path.join(data, 'PG_VERSION'), '17\n')
  await writeFile(path.join(data, 'fixture-user-data'), 'preserve')
  await writeFile(path.join(data, 'postmaster.pid'), `12345\n${data}\n0\n55432\n`)
  const state = { events: [], ports: [], pgActive: true, databaseExists: true, migrationCode: 0, password: 'stable-local-password', dataRoot: f.privateData }
  const startup = await bootstrapInstalledDesktop({ env: { LOCALAPPDATA: path.join(f.root, 'local'), TRADELOOM_DATA_ROOT: f.privateData }, processEnv: {},
    appPath: f.appPath, resourcesPath: f.resourcesPath, platform: 'win32', deps: runtimeDeps(state) })
  await startup.ready
  assert.ok(!state.events.includes('initdb'))
  assert.ok(!state.events.includes('pgctl:start'))
  assert.ok(!state.events.includes('createdb'))
  assert.equal(await readFile(path.join(data, 'fixture-user-data'), 'utf8'), 'preserve')
  assert.equal(await readFile(path.join(f.privateData, 'postgres', 'password'), 'utf8'), 'stable-local-password\n')
  await startup.stop()
})

test('packaged bootstrap reports a foreign PostgreSQL port without starting or stopping another process', async t => {
  const f = await fixture(t)
  const state = { events: [], ports: [], pgActive: false, databaseExists: false, foreignPostgres: true, migrationCode: 0, password: 'secret', dataRoot: f.privateData }
  await assert.rejects(bootstrapInstalledDesktop({ env: { LOCALAPPDATA: path.join(f.root, 'local') }, processEnv: {}, appPath: f.appPath,
    resourcesPath: f.resourcesPath, platform: 'win32', deps: runtimeDeps(state) }), /55432 被其他进程占用/)
  assert.ok(state.events.includes('pgctl:status'))
  assert.ok(!state.events.includes('pgctl:start'))
  assert.ok(!state.events.includes('pgctl:stop'))
  assert.ok(!state.events.includes('main:import'))
})

test('pg_ctl controller writes to a file and bootstrap waits for its actual exit', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'tradeloom-controller-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const logPath = path.join(root, 'controller.log')
  const start = Date.now()
  const result = await runControllerFile(process.execPath, ['-e', 'setTimeout(() => process.stdout.write("controller-finished"), 140)'],
    { cwd: root, env: process.env, logPath })
  assert.equal(result.code, 0)
  assert.ok(Date.now() - start >= 100)
  assert.match(await readFile(logPath, 'utf8'), /controller-finished/)
})

test('one-shot Python command logs diagnostics with database secrets redacted', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'tradeloom-command-log-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const logPath = path.join(root, 'startup.log')
  const password = 'local-db-password-abc'
  const result = await runCommandFile(process.execPath,
    ['-e', `console.log(${JSON.stringify(password)}); console.error('Bearer private-token')`],
    { cwd: root, env: { ...process.env, TRADELOOM_DB_PASSWORD: password }, logPath })
  assert.equal(result.code, 0)
  assert.equal(result.stdout.trim(), password)
  const log = await readFile(logPath, 'utf8')
  assert.ok(log.includes('[database password redacted]'))
  assert.ok(log.includes('Bearer [redacted]'))
  assert.ok(!log.includes(password))
  assert.ok(!log.includes('private-token'))
})

test('packaged bootstrap cleans up its PostgreSQL when Django migration fails and does not import Electron main', async t => {
  const f = await fixture(t)
  const state = { events: [], ports: [], pgActive: false, databaseExists: false, migrationCode: 2, password: 'local-only-test-password', dataRoot: f.privateData }
  await assert.rejects(bootstrapInstalledDesktop({ env: { LOCALAPPDATA: path.join(f.root, 'local'), TRADELOOM_DATA_ROOT: f.privateData }, processEnv: {},
    appPath: f.appPath, resourcesPath: f.resourcesPath, platform: 'win32', deps: runtimeDeps(state) }), /Django migrate 失败/)
  assert.equal(state.pgActive, false)
  assert.ok(state.events.includes('pgctl:stop'))
  assert.ok(!state.events.includes('main:import'))
})

test('installed bootstrap accepts only packaged schema 2 and verifies main module identity', async t => {
  const f = await fixture(t)
  const oldManifest = structuredClone(f.manifest)
  oldManifest.schemaVersion = 1
  assert.throws(() => validateInstalledManifest(oldManifest), /schemaVersion 2/)
  await writeFile(path.join(f.appPath, 'lib', 'main.js'), 'changed main\n')
  const state = { events: [], ports: [], pgActive: false, databaseExists: false, migrationCode: 0, password: 'secret', dataRoot: f.privateData }
  await assert.rejects(bootstrapInstalledDesktop({ env: { LOCALAPPDATA: path.join(f.root, 'local') }, processEnv: {}, appPath: f.appPath,
    resourcesPath: f.resourcesPath, platform: 'win32', deps: runtimeDeps(state) }), /SHA256 不匹配/)
})

test('packaged bootstrap rejects invalid or partial port tuples before touching resources', async () => {
  for (const ports of [{ host: 3088 }, { host: 1, django: 1, postgres: 2 }, { host: true, django: 2, postgres: 3 }, { host: 0, django: 2, postgres: 3 }]) {
    await assert.rejects(bootstrapInstalledDesktop({ ports, platform: 'win32', deps: {} }), /port/i)
  }
})


test('packaged port flags require all unique valid values', () => {
  assert.deepEqual(parsePackagedPortFlags([]), {host:3088,django:3090,postgres:55432})
  assert.deepEqual(parsePackagedPortFlags(['--tradeloom-host-port','43088','--tradeloom-django-port','43090','--tradeloom-postgres-port','45432']), {host:43088,django:43090,postgres:45432})
  for (const args of [['--tradeloom-host-port','1'],['--tradeloom-host-port','1','--tradeloom-host-port','2'],['--tradeloom-host-port','1','--tradeloom-django-port','1','--tradeloom-postgres-port','2']]) assert.throws(() => parsePackagedPortFlags(args), /port/i)
})

test('owned postgres mismatched port is rejected before any database connection', async t => {
  const f = await fixture(t), data = path.join(f.privateData,'postgres','data')
  await mkdir(data,{recursive:true})
  await writeFile(path.join(f.privateData,'.tradeloom-data-root-owned'),'tradeloom-app-data-v1\n')
  await writeFile(path.join(f.privateData,'postgres','.tradeloom-postgres-owned'),'tradeloom-postgres-data-v1\n')
  await writeFile(path.join(f.privateData,'postgres','password'),'local-only\n')
  await writeFile(path.join(data,'PG_VERSION'),'17\n')
  await writeFile(path.join(data,'postmaster.pid'),`12345\n${data}\n0\n55433\n`)
  const state={events:[],ports:[],pgActive:true,databaseExists:true,password:'local-only',dataRoot:f.privateData}
  await assert.rejects(bootstrapInstalledDesktop({env:{LOCALAPPDATA:path.join(f.root,'local'),TRADELOOM_DATA_ROOT:f.privateData},processEnv:{},appPath:f.appPath,resourcesPath:f.resourcesPath,platform:'win32',deps:runtimeDeps(state)}),/identity mismatch/)
  assert.ok(!state.events.includes('database-check')); assert.ok(!state.events.includes('pgctl:stop'))
})


test('packaged custom tuple reaches host, Django and owned PostgreSQL', async t => {
  const f=await fixture(t), state={events:[],ports:[],pgActive:false,databaseExists:false,migrationCode:0,password:'local-only',dataRoot:f.privateData,djangoPort:43090}, processEnv={}
  const ports={host:43088,django:43090,postgres:45432}
  const startup=await bootstrapInstalledDesktop({ports,env:{LOCALAPPDATA:path.join(f.root,'local'),TRADELOOM_DATA_ROOT:f.privateData},processEnv,appPath:f.appPath,resourcesPath:f.resourcesPath,platform:'win32',deps:runtimeDeps(state)})
  await startup.ready
  assert.equal(processEnv.TRADELOOM_DSH_BIND_PORT,'43088'); assert.equal(processEnv.TRADELOOM_DJANGO_PORT,'43090')
  assert.ok(state.ports.some(([host,port])=>host==='127.0.0.1' && port===45432))
  assert.ok(state.helperBridgeKeys.some(item=>item.command==='psql.exe' && item.args.includes('45432')))
  assert.ok(JSON.parse(state.djangoArgs.at(-1)).args.includes('127.0.0.1:43090'))
  assert.equal(state.djangoEnv.TRADELOOM_DB_PORT,'45432'); assert.equal(state.djangoEnv.TRADELOOM_DSH_CSRF_TRUSTED_ORIGINS,'http://192.168.8.20:43088')
  await startup.stop()
})


test('owned postgres rejects data path and listener PID mismatches without stopping services', async t => {
  for (const mismatch of ['data','listener']) {
    const f=await fixture(t), data=path.join(f.privateData,'postgres','data')
    await mkdir(data,{recursive:true}); await writeFile(path.join(f.privateData,'.tradeloom-data-root-owned'),'tradeloom-app-data-v1\n')
    await writeFile(path.join(f.privateData,'postgres','.tradeloom-postgres-owned'),'tradeloom-postgres-data-v1\n'); await writeFile(path.join(f.privateData,'postgres','password'),'local-only\n')
    await writeFile(path.join(data,'PG_VERSION'),'17\n'); await writeFile(path.join(data,'postmaster.pid'),`12345\n${mismatch === 'data' ? f.root : data}\n0\n55432\n`)
    const state={events:[],ports:[],pgActive:true,databaseExists:true,password:'local-only',dataRoot:f.privateData}; const deps=runtimeDeps(state)
    if(mismatch === 'listener') deps.listenerOwner=async()=>false
    await assert.rejects(bootstrapInstalledDesktop({env:{LOCALAPPDATA:path.join(f.root,'local'),TRADELOOM_DATA_ROOT:f.privateData},processEnv:{},appPath:f.appPath,resourcesPath:f.resourcesPath,platform:'win32',deps}),/identity mismatch/)
    assert.ok(!state.events.includes('database-check')); assert.ok(!state.events.includes('pgctl:stop'))
  }
})


test('owned postgres rejects a non-file identity without connecting or stopping', async t => {
  const f=await fixture(t), data=path.join(f.privateData,'postgres','data'); await mkdir(path.join(data,'postmaster.pid'),{recursive:true})
  await writeFile(path.join(f.privateData,'.tradeloom-data-root-owned'),'tradeloom-app-data-v1\n'); await writeFile(path.join(f.privateData,'postgres','.tradeloom-postgres-owned'),'tradeloom-postgres-data-v1\n')
  await writeFile(path.join(f.privateData,'postgres','password'),'local-only\n'); await writeFile(path.join(data,'PG_VERSION'),'17\n')
  const state={events:[],ports:[],pgActive:true,databaseExists:true,password:'local-only',dataRoot:f.privateData}
  await assert.rejects(bootstrapInstalledDesktop({env:{LOCALAPPDATA:path.join(f.root,'local'),TRADELOOM_DATA_ROOT:f.privateData},processEnv:{},appPath:f.appPath,resourcesPath:f.resourcesPath,platform:'win32',deps:runtimeDeps(state)}),/identity file invalid/)
  assert.ok(!state.events.includes('database-check')); assert.ok(!state.events.includes('pgctl:stop'))
})


test('packaged Host port 80 uses canonical CSRF origin', async t => {
 const f=await fixture(t), state={events:[],ports:[],pgActive:false,databaseExists:false,migrationCode:0,password:'local-only',dataRoot:f.privateData,djangoPort:43090}
 const startup=await bootstrapInstalledDesktop({ports:{host:80,django:43090,postgres:45432},env:{LOCALAPPDATA:path.join(f.root,'local'),TRADELOOM_DATA_ROOT:f.privateData},processEnv:{},appPath:f.appPath,resourcesPath:f.resourcesPath,platform:'win32',deps:runtimeDeps(state)})
 await startup.ready; assert.equal(state.djangoEnv.TRADELOOM_DSH_CSRF_TRUSTED_ORIGINS,'http://192.168.8.20'); await startup.stop()
})
