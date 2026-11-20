import { createHash, randomBytes } from 'node:crypto'
import { spawn, execFileSync } from 'node:child_process'
import { open, lstat, mkdir, readFile, readdir, realpath, writeFile, copyFile, appendFile, rename, stat } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'
import {
  buildChildEnvironment, chooseAddress, createNativeBridgeKey, ensureOwnedDirectory, ensureOwnedHome, getDefaultPaths,
  launcherPipeName, networkCandidates, reserveNamedPipe, startOwnedChild,
} from './core.mjs'
import { initializeFreshPluginProfile, installFreshPluginSeed } from './plugin-seed.mjs'

export const INSTALLED_PROFILE_BUNDLES = ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', '@tradeloom/dsh-business-shell']
export const DATA_ROOT_MARKER = '.tradeloom-data-root-owned'
export const DATA_ROOT_MARKER_CONTENT = 'tradeloom-app-data-v1\n'
export const POSTGRES_MARKER = '.tradeloom-postgres-owned'
export const POSTGRES_MARKER_CONTENT = 'tradeloom-postgres-data-v1\n'
export const POSTGRES_PORT = 55432
export const DJANGO_PORT = 3090
export const DSH_PORT = 3088
export function validatePackagedPorts(value = { host: DSH_PORT, django: DJANGO_PORT, postgres: POSTGRES_PORT }) {
  if (!value || Object.keys(value).sort().join(',') !== 'django,host,postgres' || Object.values(value).some(n => !Number.isInteger(n) || n < 1 || n > 65535) || new Set(Object.values(value)).size !== 3) throw new TypeError('invalid packaged port tuple')
  return Object.freeze({ ...value })
}
export function parsePackagedPortFlags(argv) {
  const names = { '--tradeloom-host-port': 'host', '--tradeloom-django-port': 'django', '--tradeloom-postgres-port': 'postgres' }
  const result = {}
  for (let i = 0; i < argv.length; i++) {
    if (!Object.hasOwn(names, argv[i])) { if (String(argv[i]).startsWith('--tradeloom-') && String(argv[i]).includes('-port')) throw new TypeError('invalid packaged port flag'); continue }
    const key = names[argv[i]], raw = argv[++i]
    if (key in result || !/^[1-9][0-9]*$/.test(raw ?? '')) throw new TypeError('invalid packaged port flag')
    result[key] = Number(raw)
  }
  return Object.keys(result).length ? validatePackagedPorts(result) : validatePackagedPorts()
}
async function verifyOwnedPostgresListener(data, port, fs, deps) {
  const pidFile = path.join(data, 'postmaster.pid')
  const stat = await fs.lstat(pidFile)
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('owned PostgreSQL identity file invalid')
  const lines = (await fs.readFile(pidFile, 'utf8')).split(/\r?\n/)
  const pid = Number(lines[0]); const recordedPort = Number(lines[3])
  if (!Number.isInteger(pid) || pid <= 0 || recordedPort !== port || path.resolve(lines[1] ?? '').toLowerCase() !== path.resolve(data).toLowerCase()) throw new Error('owned PostgreSQL identity mismatch')
  const check = deps.listenerOwner ?? ((requestedPort) => {
    const systemRoot = process.env.SystemRoot || 'C:/Windows'
    const out = execFileSync(path.join(systemRoot, 'System32', 'netstat.exe'), ['-ano', '-p', 'tcp'], { encoding: 'utf8', windowsHide: true })
    return out.split(/\r?\n/).some(line => { const fields = line.trim().split(/\s+/); return fields[0] === 'TCP' && fields[1] === `127.0.0.1:${requestedPort}` && fields[3] === 'LISTENING' && Number(fields[4]) === pid })
  })
  if (!(await check(port, pid))) throw new Error('owned PostgreSQL listener identity mismatch')
}
export const BUSINESS_SHELL_INVENTORY_FILE = '.tradeloom-business-shell-inventory.json'
export const LEGACY_BUSINESS_SHELL_SHA256 = 'b86ae8b432b6a9cfb28582673d1867b0bfa7f39b8d9cd65c29f3ed692fb3766f'
export const WINDOWS_LEGACY_PATH_LIMIT = 259

// Windows 未启用 LongPathsEnabled 时，超过 259 字符的文件既不能被 Python 的
// FileFinder 找到（表现为 ImportError: ... (unknown location)），也不能被
// fs.readFile 读到（表现为 ENOENT）。发行包里的 Python 依赖树最深相对路径约
// 109 字符，因此安装根目录长度直接决定运行时是否可用，这里在启动阶段显式拦下。
export async function assertInstallPathBudget({ root, fs = { readdir }, platform = process.platform, limit = WINDOWS_LEGACY_PATH_LIMIT }) {
  if (platform !== 'win32') return 0
  const absolute = path.resolve(root)
  let visited = 0
  const pending = [absolute]
  while (pending.length) {
    const directory = pending.pop()
    const entries = await fs.readdir(directory, { withFileTypes: true })
    for (const entry of entries) {
      visited += 1
      const child = path.join(directory, entry.name)
      if (child.length > limit) {
        throw new Error('安装路径过长：' + child + ' 共 ' + child.length + ' 字符，超过 Windows 未启用长路径支持时的 '
          + limit + ' 字符上限。请把织贸助手解压/安装到更短的目录（例如 D:\\Tradeloom），'
          + '安装根目录合计不超过 ' + (limit - (child.length - absolute.length)) + ' 字符。')
      }
      if (entry.isDirectory()) pending.push(child)
    }
  }
  return visited
}

const requiredPostgresEntrypoints = ['postgres', 'pg_ctl', 'initdb', 'psql', 'createdb']

function safeRelative(value, label) {
  if (typeof value !== 'string' || !value || path.posix.isAbsolute(value) || value.includes('\\') || value.includes(':') || value.includes('\0')
    || value.split('/').some(part => !part || part === '.' || part === '..')) throw new Error(label + ' 必须是安全的相对资源路径。')
  return value
}

function digestInventory(files) {
  const canonical = [...files].sort((a, b) => a.path.localeCompare(b.path, 'en'))
    .map(item => item.path + '\0' + item.bytes + '\0' + item.sha256 + '\n').join('')
  return createHash('sha256').update(canonical, 'utf8').digest('hex')
}

function isInside(root, target) {
  const relative = path.relative(path.resolve(root), path.resolve(target))
  return relative === '' || (relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative))
}

export function validateInstalledManifest(manifest) {
  if (manifest?.schemaVersion !== 2 || manifest.deploymentMode !== 'packaged') throw new Error('安装版仅支持 packaged schemaVersion 2 manifest。')
  if (manifest.sourceBuild?.shellMode !== undefined && manifest.sourceBuild.shellMode !== 'source') throw new Error('packaged manifest shellMode 无效。')
  if (!manifest.sourceBuild?.lock?.upstream || !manifest.sourceBuild.lock.patches
    || !/^[a-f0-9]{64}$/.test(manifest.sourceBuild.appMainSha256 ?? '')) throw new Error('packaged manifest 缺少 source build identity/hash。')
  const fixedPaths = [
    [manifest.runtime?.root, 'resources/runtime/primary-runtime'],
    [manifest.runtime?.python, 'resources/runtime/primary-runtime/dependencies/python/python.exe'],
    [manifest.resources?.business?.root, 'resources/tradeloom/backend'],
    [manifest.resources?.businessShell?.root, 'resources/tradeloom/business-shell'],
    [manifest.resources?.pythonDependencies?.root, 'resources/tradeloom/python-packages'],
    [manifest.resources?.postgresql?.root, 'resources/tradeloom/postgresql/pgsql'],
  ]
  if (fixedPaths.some(([actual, expected]) => actual !== expected)) throw new Error('packaged manifest resource roots 不符合固定安装布局。')
  const hasArtifactNode = manifest.runtime?.node !== undefined || manifest.runtime?.nodeSha256 !== undefined
  if (hasArtifactNode && (manifest.runtime?.node !== 'resources/runtime/primary-runtime/dependencies/node/bin/node.exe'
    || !/^[a-f0-9]{64}$/.test(manifest.runtime?.nodeSha256 ?? ''))) {
    throw new Error('packaged manifest runtime Node 路径或 SHA256 无效。')
  }
  const validator = manifest.sourceBuild.lock.nativeArtifactValidator
  const hasValidator = validator !== undefined
  if (hasValidator !== hasArtifactNode || (hasValidator && (!validator || typeof validator !== 'object' || Array.isArray(validator)
    || Object.keys(validator).sort().join(',') !== 'nodeRelativePath,nodeSha256,receiptSha256'
    || validator.nodeRelativePath !== 'apps/desktop/.desktop-build/targets/win-x64/runtime/primary-runtime/dependencies/node/bin/node.exe'
    || !/^[a-f0-9]{64}$/.test(validator.nodeSha256 ?? '') || !/^[a-f0-9]{64}$/.test(validator.receiptSha256 ?? '')
    || validator.nodeSha256 !== manifest.runtime.nodeSha256))) {
    throw new Error('packaged manifest runtime Node validator 配置不匹配。')
  }
  if (manifest.runtime?.version !== '3.12.14' || manifest.runtime?.providedBy !== 'official-electron-builder') throw new Error('packaged manifest 缺少官方 Python primary runtime。')
  for (const item of [manifest.resources.business, manifest.resources.businessShell, manifest.resources.pythonDependencies, manifest.resources.postgresql]) {
    if (!Number.isSafeInteger(item.fileCount) || item.fileCount < 1 || !Number.isSafeInteger(item.bytes) || item.bytes < 1 || !/^[a-f0-9]{64}$/.test(item.sha256 ?? '')) {
      throw new Error('packaged manifest 缺少资源文件数、字节数或 SHA256。')
    }
  }
  if (manifest.resources.engineRecovery !== undefined) {
    const item = manifest.resources.engineRecovery
    if (!item || Object.keys(item).sort().join(',') !== 'bytes,fileCount,root,sha256'
      || item.root !== 'resources/tradeloom/engine-recovery-tools' || !Number.isSafeInteger(item.fileCount) || item.fileCount < 1
      || !Number.isSafeInteger(item.bytes) || item.bytes < 1 || !/^[a-f0-9]{64}$/.test(item.sha256 ?? '')) throw new Error('packaged manifest engine recovery identity 无效。')
  }
  if (manifest.resources.pythonDependencies.version !== '3.12.14' || manifest.resources.postgresql.version !== '17.11') throw new Error('packaged manifest Python/PostgreSQL 版本不受支持。')
  if (!Array.isArray(manifest.resources.business.files) || !Array.isArray(manifest.resources.postgresql.entrypoints)) throw new Error('packaged manifest 缺少业务 allowlist 或 PostgreSQL entrypoints。')
  const businessNames = new Set(manifest.resources.business.files.map(item => safeRelative(item.path, '业务文件')))
  for (const required of ['manage.py', 'requirements-workbench.txt', 'config/settings.py', 'workbench/__init__.py']) {
    if (!businessNames.has(required)) throw new Error('业务 allowlist 缺少必需文件：' + required)
  }
  for (const item of manifest.resources.business.files) {
    if (!Number.isSafeInteger(item.bytes) || item.bytes < 0 || !/^[a-f0-9]{64}$/.test(item.sha256 ?? '')
      || item.path.split('/').some(part => ['.git', '.venv', '__pycache__', 'tests', 'uploads'].includes(part.toLowerCase()) || part.toLowerCase().startsWith('.env'))) {
      throw new Error('业务 allowlist 含无效或禁止文件：' + item.path)
    }
  }
  const entrypointNames = new Set(manifest.resources.postgresql.entrypoints.map(item => item.name))
  if (requiredPostgresEntrypoints.some(name => !entrypointNames.has(name))) throw new Error('PostgreSQL manifest 缺少必要 entrypoint hash。')
  for (const item of manifest.resources.postgresql.entrypoints) {
    safeRelative(item.path, 'PostgreSQL entrypoint')
    if (!/^[a-f0-9]{64}$/i.test(item.sha256 ?? '') || item.version !== 'postgres (PostgreSQL) 17.11' && !String(item.version ?? '').includes('17.11')) {
      throw new Error('PostgreSQL entrypoint manifest 无效：' + item.name)
    }
  }
  return manifest
}

function resolvePackagedPath(resourcesPath, value, label) {
  safeRelative(value, label)
  if (!value.startsWith('resources/')) throw new Error(label + ' 必须以 resources/ 开头。')
  const target = path.resolve(resourcesPath, ...value.slice('resources/'.length).split('/'))
  if (!isInside(resourcesPath, target)) throw new Error(label + ' 越出 Electron resources 根目录。')
  return target
}

async function assertOrdinaryPath(root, target, fs = { lstat, realpath }) {
  const resolvedRoot = path.resolve(root)
  const resolvedTarget = path.resolve(target)
  if (!isInside(resolvedRoot, resolvedTarget)) throw new Error('安装资源路径越出受控目录。')
  const relative = path.relative(resolvedRoot, resolvedTarget)
  let current = resolvedRoot
  const rootInfo = await fs.lstat(current)
  if (rootInfo.isSymbolicLink()) throw new Error('安装资源根目录不能是链接。')
  for (const part of relative ? relative.split(path.sep) : []) {
    current = path.join(current, part)
    const info = await fs.lstat(current)
    if (info.isSymbolicLink()) throw new Error('安装资源路径不能包含链接：' + current)
  }
  const info = await fs.lstat(resolvedTarget)
  if (!info.isFile() && !info.isDirectory()) throw new Error('安装资源必须是普通文件或目录：' + resolvedTarget)
  return info
}

export async function acquireElectronSingleInstanceLock({ app, root, userDataPath, fs = { lstat, mkdir } } = {}) {
  if (typeof root !== 'string' || !path.isAbsolute(root) || typeof userDataPath !== 'string' || !path.isAbsolute(userDataPath)) throw new TypeError('invalid Electron userData path')
  const rootPath = path.resolve(root)
  const targetPath = path.resolve(userDataPath)
  if (!isInside(rootPath, targetPath)) throw new Error('Electron userData path escaped the owned LOCALAPPDATA root.')
  const rootInfo = await fs.lstat(rootPath)
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw new Error('owned LOCALAPPDATA root is not an ordinary directory.')
  let current = rootPath
  for (const part of path.relative(rootPath, targetPath).split(path.sep).filter(Boolean)) {
    current = path.join(current, part)
    let info
    try { info = await fs.lstat(current) }
    catch (error) {
      if (error.code !== 'ENOENT') throw error
      try { await fs.mkdir(current) }
      catch (mkdirError) { if (mkdirError.code !== 'EEXIST') throw mkdirError }
      info = await fs.lstat(current)
    }
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Electron userData path contains a non-ordinary directory.')
  }
  app.setPath('userData', targetPath)
  const locked = app.requestSingleInstanceLock()
  if (typeof locked !== 'boolean') throw new TypeError('Electron single-instance lock did not return a boolean.')
  return locked
}

async function resolveOwnedStartupObservationPath(requested, dataRoot, logsRoot, platform, fs) {
  if (typeof requested !== 'string' || !requested) return undefined
  const resolve = platform === 'win32' ? path.win32.resolve : path.resolve
  const target = resolve(logsRoot, 'desktop-startup-observation.jsonl')
  const requestedPath = resolve(requested)
  const same = platform === 'win32'
    ? requestedPath.toLowerCase() === target.toLowerCase()
    : requestedPath === target
  if (!same) return undefined
  try {
    await assertOrdinaryPath(dataRoot, logsRoot, fs)
    const directoryInfo = await fs.lstat(logsRoot)
    if (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink()) return undefined
    let fileInfo
    try { fileInfo = await fs.lstat(target) } catch (error) { if (error.code !== 'ENOENT') return undefined }
    if (fileInfo && (!fileInfo.isFile() || fileInfo.isSymbolicLink())) return undefined
    return target
  } catch {
    return undefined
  }
}

async function verifyBusinessFiles(manifest, backendRoot, fs) {
  const records = []
  for (const item of manifest.resources.business.files) {
    const name = safeRelative(item.path, '业务文件')
    const full = path.resolve(backendRoot, ...name.split('/'))
    await assertOrdinaryPath(backendRoot, full, fs)
    const bytes = await fs.readFile(full)
    const digest = createHash('sha256').update(bytes).digest('hex')
    if (bytes.length !== item.bytes || digest !== item.sha256) throw new Error('安装业务文件 hash 不匹配：' + name)
    records.push({ path: name, bytes: bytes.length, sha256: digest })
  }
  if (records.length !== manifest.resources.business.fileCount || records.reduce((sum, item) => sum + item.bytes, 0) !== manifest.resources.business.bytes
    || digestInventory(records) !== manifest.resources.business.sha256) throw new Error('安装业务资源树摘要不匹配。')
}

async function inventoryOrdinaryFiles(root, prefix = '', fs = { lstat, readdir, readFile }) {
  const records = []
  for (const entry of await fs.readdir(root, { withFileTypes: true })) {
    const relative = prefix ? prefix + '/' + entry.name : entry.name
    const full = path.join(root, entry.name)
    const info = await fs.lstat(full)
    if (info.isSymbolicLink()) throw new Error('安装资源树不能包含链接：' + relative)
    if (info.isDirectory()) records.push(...await inventoryOrdinaryFiles(full, relative, fs))
    else if (info.isFile()) {
      const bytes = await fs.readFile(full)
      records.push({ path: relative, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') })
    } else throw new Error('安装资源树含非普通文件：' + relative)
  }
  return records
}

async function verifyResourceTree(root, prefix, metadata, fs, label) {
  await assertOrdinaryPath(path.dirname(root), root, fs)
  const records = await inventoryOrdinaryFiles(root, prefix, fs)
  if (records.length !== metadata.fileCount || records.reduce((sum, item) => sum + item.bytes, 0) !== metadata.bytes
    || digestInventory(records) !== metadata.sha256) throw new Error(label + ' 实际文件树摘要不匹配。')
}

async function verifyBusinessShell(manifest, shellRoot, fs) {
  await assertOrdinaryPath(shellRoot, path.join(shellRoot, 'package.json'), fs)
  const packageManifest = JSON.parse(await fs.readFile(path.join(shellRoot, 'package.json'), 'utf8'))
  if (packageManifest.name !== '@tradeloom/dsh-business-shell' || packageManifest.version !== manifest.resources.businessShell.version || !Array.isArray(packageManifest.files)) {
    throw new Error('安装 business-shell package identity 不匹配。')
  }
  const names = ['package.json', ...packageManifest.files.map(name => safeRelative(name, 'business-shell 文件'))]
  const records = []
  for (const name of names) {
    const full = path.resolve(shellRoot, ...name.split('/'))
    await assertOrdinaryPath(shellRoot, full, fs)
    const bytes = await fs.readFile(full)
    records.push({ path: name, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') })
  }
  if (records.length !== manifest.resources.businessShell.fileCount || records.reduce((sum, item) => sum + item.bytes, 0) !== manifest.resources.businessShell.bytes
    || digestInventory(records) !== manifest.resources.businessShell.sha256) throw new Error('安装 business-shell 文件摘要不匹配。')
  const actual = await inventoryOrdinaryFiles(shellRoot, '', fs)
  if (actual.length !== records.length || digestInventory(actual) !== digestInventory(records)) throw new Error('安装 business-shell 文件树含未列文件。')
  return { packageManifest, files: names, records }
}

async function copyBusinessShell(shellRoot, destination, verified, fs) {
  const profileRoot = path.resolve(destination, '..', '..', '..')
  const packageParent = path.dirname(destination)
  const recordPath = path.join(profileRoot, BUSINESS_SHELL_INVENTORY_FILE)
  const expectedHash = digestInventory(verified.records)
  const expectedBytes = verified.records.reduce((sum, item) => sum + item.bytes, 0)
  const expectedRecord = { schemaVersion: 1, packageName: '@tradeloom/dsh-business-shell', inventorySha256: expectedHash,
    fileCount: verified.records.length, bytes: expectedBytes }
  const nonce = randomBytes(12).toString('hex')
  const stagePath = path.join(packageParent, '.tradeloom-business-shell-stage-' + nonce)
  const backupPath = path.join(packageParent, '.tradeloom-business-shell-backup-' + nonce)
  const failedPath = path.join(packageParent, '.tradeloom-business-shell-failed-' + nonce)
  const recordTempPath = path.join(profileRoot, '.tradeloom-business-shell-inventory-stage-' + nonce + '.tmp')
  const recordBackupPath = path.join(profileRoot, '.tradeloom-business-shell-inventory-backup-' + nonce + '.json')
  const recordFailedPath = path.join(profileRoot, '.tradeloom-business-shell-inventory-failed-' + nonce + '.json')
  await assertOrdinaryPath(profileRoot, profileRoot, fs)
  await ensureOrdinaryDirectoryTree(profileRoot, packageParent, fs)
  await assertOrdinaryPath(profileRoot, packageParent, fs)

  let recordInfo
  try { recordInfo = await fs.lstat(recordPath) } catch (error) { if (error.code !== 'ENOENT') throw error }
  if (recordInfo && (recordInfo.isSymbolicLink() || !recordInfo.isFile())) throw new Error('profile business-shell inventory 不是普通文件。')
  let priorRecord
  if (recordInfo) {
    try { priorRecord = JSON.parse(await fs.readFile(recordPath, 'utf8')) } catch { throw new Error('profile business-shell inventory 格式无效；拒绝覆盖。') }
    if (priorRecord?.schemaVersion !== 1 || priorRecord.packageName !== '@tradeloom/dsh-business-shell'
      || !/^[a-f0-9]{64}$/.test(priorRecord.inventorySha256 ?? '')
      || !Number.isSafeInteger(priorRecord.fileCount) || priorRecord.fileCount < 1
      || !Number.isSafeInteger(priorRecord.bytes) || priorRecord.bytes < 1) throw new Error('profile business-shell inventory 身份无效；拒绝覆盖。')
  }

  let destinationInfo
  try { destinationInfo = await fs.lstat(destination) } catch (error) { if (error.code !== 'ENOENT') throw error }
  if (destinationInfo && (destinationInfo.isSymbolicLink() || !destinationInfo.isDirectory())) throw new Error('profile business-shell 目标不是普通目录；拒绝覆盖。')
  if (!destinationInfo) {
    const backupNames = (await fs.readdir(packageParent)).filter(name => name.startsWith('.tradeloom-business-shell-backup-'))
    const recoverable = []
    for (const name of backupNames) {
      const candidate = path.join(packageParent, name)
      const info = await fs.lstat(candidate)
      if (info.isSymbolicLink() || !info.isDirectory()) throw new Error('profile business-shell 恢复备份不是普通目录；拒绝接管。')
      const records = await inventoryOrdinaryFiles(candidate, '', fs)
      const digest = digestInventory(records)
      if ((priorRecord && digest === priorRecord.inventorySha256) || digest === expectedHash
        || (!priorRecord && records.length === 11 && digest === LEGACY_BUSINESS_SHELL_SHA256)) recoverable.push(candidate)
    }
    if (recoverable.length === 1) {
      await fs.rename(recoverable[0], destination)
      destinationInfo = await fs.lstat(destination)
    } else if (recordInfo || backupNames.length) {
      throw new Error('profile business-shell inventory/bundle 不完整，且没有唯一匹配的受信恢复备份；拒绝覆盖。')
    }
  }

  let currentHash
  if (destinationInfo) {
    await assertOrdinaryPath(profileRoot, destination, fs)
    const currentRecords = await inventoryOrdinaryFiles(destination, '', fs)
    const packageManifest = JSON.parse(await fs.readFile(path.join(destination, 'package.json'), 'utf8'))
    if (packageManifest.name !== '@tradeloom/dsh-business-shell') throw new Error('已有 profile business-shell package identity 不匹配；拒绝覆盖。')
    currentHash = digestInventory(currentRecords)
    const registeredHash = priorRecord?.inventorySha256
    const knownLegacy = !priorRecord && currentRecords.length === 11 && currentHash === LEGACY_BUSINESS_SHELL_SHA256
    if (currentHash !== expectedHash && currentHash !== registeredHash && !knownLegacy) {
      throw new Error('已有 profile business-shell 与登记摘要不一致；拒绝覆盖。')
    }
    if (currentHash === expectedHash) {
      if (registeredHash === expectedHash && priorRecord.fileCount === expectedRecord.fileCount && priorRecord.bytes === expectedRecord.bytes) return
      await writeBusinessShellInventory(recordPath, expectedRecord, recordTempPath, recordBackupPath, fs)
      return
    }
  }

  await fs.mkdir(stagePath)
  for (const name of verified.files) {
    const target = path.join(stagePath, ...name.split('/'))
    await ensureOrdinaryDirectoryTree(profileRoot, path.dirname(target), fs)
    await fs.copyFile(path.join(shellRoot, ...name.split('/')), target, 0)
  }
  const stagedRecords = await inventoryOrdinaryFiles(stagePath, '', fs)
  if (stagedRecords.length !== expectedRecord.fileCount || digestInventory(stagedRecords) !== expectedHash) throw new Error('profile business-shell staging 摘要不匹配。')
  await fs.writeFile(recordTempPath, JSON.stringify(expectedRecord) + '\n', { flag: 'wx', mode: 0o600 })

  let oldBundleMoved = false
  let newBundleInstalled = false
  let oldRecordMoved = false
  let newRecordInstalled = false
  try {
    if (destinationInfo) { await fs.rename(destination, backupPath); oldBundleMoved = true }
    await fs.rename(stagePath, destination)
    newBundleInstalled = true
    if (recordInfo) { await fs.rename(recordPath, recordBackupPath); oldRecordMoved = true }
    await fs.rename(recordTempPath, recordPath)
    newRecordInstalled = true
  } catch (error) {
    const rollbackErrors = []
    try { if (newRecordInstalled) await fs.rename(recordPath, recordFailedPath) } catch (rollbackError) { rollbackErrors.push(rollbackError) }
    try { if (oldRecordMoved) await fs.rename(recordBackupPath, recordPath) } catch (rollbackError) { rollbackErrors.push(rollbackError) }
    try { if (newBundleInstalled) await fs.rename(destination, failedPath) } catch (rollbackError) { rollbackErrors.push(rollbackError) }
    try { if (oldBundleMoved) await fs.rename(backupPath, destination) } catch (rollbackError) { rollbackErrors.push(rollbackError) }
    if (rollbackErrors.length) throw new AggregateError([error, ...rollbackErrors], 'profile business-shell 更新失败且回滚未完全完成；保留现场供重试恢复。')
    throw error
  }
}

async function writeBusinessShellInventory(recordPath, record, tempPath, backupPath, fs) {
  await fs.writeFile(tempPath, JSON.stringify(record) + '\n', { flag: 'wx', mode: 0o600 })
  let oldMoved = false
  try {
    let existing
    try { existing = await fs.lstat(recordPath) } catch (error) { if (error.code !== 'ENOENT') throw error }
    if (existing) { await fs.rename(recordPath, backupPath); oldMoved = true }
    await fs.rename(tempPath, recordPath)
  } catch (error) {
    try { if (oldMoved) await fs.rename(backupPath, recordPath) } catch (rollbackError) {
      throw new AggregateError([error, rollbackError], 'profile business-shell inventory 更新失败且回滚未完成。')
    }
    throw error
  }
}

async function ensureOrdinaryDirectoryTree(root, target, fs) {
  const resolvedRoot = path.resolve(root)
  const resolvedTarget = path.resolve(target)
  if (!isInside(resolvedRoot, resolvedTarget)) throw new Error('profile business-shell 目标越出专属 profile。')
  let current = resolvedRoot
  const relative = path.relative(resolvedRoot, resolvedTarget)
  for (const part of relative ? relative.split(path.sep) : []) {
    current = path.join(current, part)
    try { await fs.mkdir(current) } catch (error) { if (error.code !== 'EEXIST') throw error }
    const info = await fs.lstat(current)
    if (info.isSymbolicLink() || !info.isDirectory()) throw new Error('profile business-shell 路径不是普通目录：' + current)
  }
}

async function readPassword(postgresRoot, dataDir, fs, generatePassword) {
  const passwordPath = path.join(postgresRoot, 'password')
  let info
  try { info = await fs.lstat(passwordPath) } catch (error) { if (error.code !== 'ENOENT') throw error }
  const initialized = await fs.lstat(path.join(dataDir, 'PG_VERSION')).then(info => info.isFile() && !info.isSymbolicLink(), error => {
    if (error.code === 'ENOENT') return false
    throw error
  })
  if (info) {
    if (!info.isFile() || info.isSymbolicLink()) throw new Error('PostgreSQL password 文件必须是普通文件。')
    const password = (await fs.readFile(passwordPath, 'utf8')).trim()
    if (!password || /[\r\n]/.test(password)) throw new Error('PostgreSQL password 文件格式无效。')
    return { password, passwordPath, initialized }
  } else if (initialized) {
    throw new Error('已有 owned PostgreSQL data 缺少专属 password 文件；拒绝重置或覆盖数据库。')
  }
  const password = generatePassword()
  await fs.writeFile(passwordPath, password + '\n', { flag: 'wx', mode: 0o600 })
  return { password, passwordPath, initialized }
}

async function verifyOwnedDataDirectory(postgresRoot, dataDir, fs) {
  await assertOrdinaryPath(postgresRoot, dataDir, fs)
  const versionPath = path.join(dataDir, 'PG_VERSION')
  const hasVersion = await fs.lstat(versionPath).then(info => info.isFile() && !info.isSymbolicLink(), error => {
    if (error.code === 'ENOENT') return false
    throw error
  })
  if (hasVersion && (await fs.readFile(versionPath, 'utf8')).trim() !== '17') throw new Error('owned PostgreSQL data 不是版本 17；拒绝改写。')
  if (!hasVersion && (await fs.readdir(dataDir)).length) throw new Error('PostgreSQL data 目录不为空但缺少 PG_VERSION；拒绝清理或重新初始化。')
  return hasVersion
}

async function runControllerFile(command, args, { cwd, env, logPath, spawnProcess = spawn, openFile = open }) {
  const log = await openFile(logPath, 'a')
  let child
  try {
    child = spawnProcess(command, args, { cwd, env, windowsHide: true, stdio: ['ignore', log.fd, log.fd] })
    const result = await new Promise(resolve => {
      child.once('error', error => resolve({ code: null, signal: null, error }))
      child.once('exit', (code, signal) => resolve({ code, signal }))
    })
    if (result.error) throw result.error
    return result
  } finally {
    await log.close()
  }
}

async function runCommandFile(command, args, { cwd, env, logPath, spawnProcess = spawn }) {
  const child = spawnProcess(command, args, { cwd, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
  let stdout = ''
  let stderr = ''
  const streamsClosed = Promise.all([child.stdout, child.stderr].filter(Boolean).map(stream => new Promise(resolve => stream.once('close', resolve))))
  child.stdout?.setEncoding('utf8')
  child.stderr?.setEncoding('utf8')
  child.stdout?.on('data', chunk => { stdout += chunk })
  child.stderr?.on('data', chunk => { stderr += chunk })
  const result = await new Promise(resolve => {
    child.once('error', error => resolve({ code: null, signal: null, error, stdout: '', stderr: '' }))
    child.once('exit', (code, signal) => resolve({ code, signal, stdout, stderr }))
  })
  if (!result.error) {
    await streamsClosed
    result.stdout = stdout
    result.stderr = stderr
  }
  if (logPath && (result.stdout || result.stderr)) {
    const password = env?.TRADELOOM_DB_PASSWORD || env?.PGPASSWORD
    const sanitize = text => {
      let output = text
      if (password) output = output.split(password).join('[database password redacted]')
      return output.replace(/Bearer\s+[^\s,;]+/gi, 'Bearer [redacted]')
        .replace(/\b(?:sk-[A-Za-z0-9_-]{8,}|[A-Za-z0-9_-]{32,})\b/g, '[secret redacted]')
    }
    const lines = [result.stdout && `stdout: ${sanitize(result.stdout)}`, result.stderr && `stderr: ${sanitize(result.stderr)}`].filter(Boolean)
    await appendFile(logPath, lines.join('\n').replace(/\r?\n/g, '\n') + (lines.length ? '\n' : ''), 'utf8')
  }
  return result
}

async function initializeOfficialProfile(appPath, profileDir, bundles) {
  const anchor = path.join(appPath, 'dsh', 'node_modules', '__tradeloom_resolver__.cjs')
  const requireFromDsh = createRequire(anchor)
  const resolved = requireFromDsh.resolve('@deepseek-ai/dsh-app-boot')
  const dshRoot = path.resolve(appPath, 'dsh', 'node_modules')
  if (!isInside(dshRoot, resolved)) throw new Error('official app-boot public entry 越出 packaged DSH node_modules。')
  const appBoot = await import(pathToFileURL(resolved).href)
  if (typeof appBoot.initProfile !== 'function') throw new Error('packaged official app-boot public entry 未导出 initProfile。')
  return appBoot.initProfile(profileDir, bundles)
}

function pythonRunArgs(pythonPath, backendRoot, packagesRoot, managePath, djangoArgs) {
  const spec = JSON.stringify({ backend: backendRoot, packages: packagesRoot, manage: managePath, args: djangoArgs })
  const runner = "import json,runpy,sys; spec=json.loads(sys.argv[1]); sys.path.insert(0,spec['packages']); sys.path.insert(0,spec['backend']); sys.argv=[spec['manage'],*spec['args']]; runpy.run_path(spec['manage'],run_name='__main__')"
  return ['-I', '-B', '-c', runner, spec]
}

function makeDjangoEnv(isolated, host, password, paths, nativeBridgeKey, ports, artifactNode) {
  return {
    ...isolated,
    TRADELOOM_NATIVE_BRIDGE_KEY: nativeBridgeKey,
    TRADELOOM_DSH_EMBED: '1',
    TRADELOOM_DSH_ALLOWED_HOSTS: host,
    TRADELOOM_DSH_CSRF_TRUSTED_ORIGINS: new URL('http://' + host + ':' + ports.host).origin,
    TRADELOOM_DB_NAME: 'tradeloom',
    TRADELOOM_DB_USER: 'tradeloom',
    TRADELOOM_DB_HOST: '127.0.0.1',
    TRADELOOM_DB_PORT: String(ports.postgres),
    TRADELOOM_DB_PASSWORD: password,
    TRADELOOM_MEDIA_ROOT: path.join(paths.dataRoot, 'media'),
    TRADELOOM_ARTIFACT_ROOT: path.join(paths.dataRoot, 'artifacts'),
    ...(artifactNode ? { TRADELOOM_ARTIFACT_NODE: artifactNode.path, TRADELOOM_ARTIFACT_NODE_SHA256: artifactNode.sha256 } : {}),
  }
}

async function waitForListener(host, port, record, timeoutMs, delay, connect) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const early = await Promise.race([record.exited.then(result => ({ result })), delay(80).then(() => null)])
    if (early) throw new Error('Django 提前退出（exit=' + (early.result.code ?? 'null') + '）。')
    if (await connect(host, port)) return
    await delay(250)
  }
  throw new Error('Django 未在 ' + timeoutMs / 1000 + ' 秒内监听 127.0.0.1:' + port + '。')
}

export async function bootstrapInstalledDesktop({ env = process.env, processEnv = process.env, appPath, resourcesPath, platform = process.platform, deps = {}, ports: requestedPorts } = {}) {
  const requestedStartupObservationPath = processEnv.DSH_DESKTOP_STARTUP_LOG_PATH
  const ports = validatePackagedPorts(requestedPorts)
  const fs = deps.fs ?? { lstat, readFile, writeFile, readdir, mkdir, realpath, stat, copyFile, rename }
  const pathsFactory = deps.getDefaultPaths ?? getDefaultPaths
  const ownDirectory = deps.ensureOwnedDirectory ?? ensureOwnedDirectory
  const ownHome = deps.ensureOwnedHome ?? ensureOwnedHome
  const makeChildEnvironment = deps.buildChildEnvironment ?? buildChildEnvironment
  const manifestRoot = path.join(resourcesPath, 'tradeloom')
  const markerPath = path.join(manifestRoot, '.tradeloom-bootstrap-owned')
  await assertOrdinaryPath(resourcesPath, manifestRoot, fs)
  await assertOrdinaryPath(manifestRoot, markerPath, fs)
  const marker = await fs.readFile(markerPath, 'utf8')
  if (marker !== 'tradeloom-bootstrap-v1\n') throw new Error('installed resources ownership marker 无效。')
  const manifestPath = path.join(manifestRoot, 'deployment.json')
  await assertOrdinaryPath(manifestRoot, manifestPath, fs)
  const rawManifest = validateInstalledManifest(JSON.parse(await fs.readFile(manifestPath, 'utf8')))
  if (rawManifest.resources.engineRecovery) await verifyResourceTree(
    resolvePackagedPath(resourcesPath, rawManifest.resources.engineRecovery.root, 'engine recovery'),
    '', rawManifest.resources.engineRecovery, fs, 'Engine recovery resources')
  const manifest = { ...rawManifest,
    runtimeRoot: resolvePackagedPath(resourcesPath, rawManifest.runtime.root, 'primary runtime'),
    python: resolvePackagedPath(resourcesPath, rawManifest.runtime.python, 'primary Python'),
    artifactNode: rawManifest.runtime.node === undefined ? undefined : resolvePackagedPath(resourcesPath, rawManifest.runtime.node, 'primary runtime Node'),
    backend: resolvePackagedPath(resourcesPath, rawManifest.resources.business.root, 'business backend'),
    shell: resolvePackagedPath(resourcesPath, rawManifest.resources.businessShell.root, 'business-shell'),
    packages: resolvePackagedPath(resourcesPath, rawManifest.resources.pythonDependencies.root, 'Python packages'),
    postgresRoot: resolvePackagedPath(resourcesPath, rawManifest.resources.postgresql.root, 'PostgreSQL'),
  }
  const actualMain = path.join(appPath, 'lib', 'main.js')
  await assertOrdinaryPath(appPath, actualMain, fs)
  if (createHash('sha256').update(await fs.readFile(actualMain)).digest('hex') !== manifest.sourceBuild.appMainSha256) throw new Error('安装版 Electron main.js 与 packaged manifest SHA256 不匹配。')
  await verifyBusinessFiles(manifest, manifest.backend, fs)
  const verifiedShell = await verifyBusinessShell(manifest, manifest.shell, fs)
  await assertOrdinaryPath(resourcesPath, manifest.python, fs)
  await assertOrdinaryPath(resourcesPath, manifest.runtimeRoot, fs)
  if (manifest.artifactNode) {
    await assertOrdinaryPath(resourcesPath, manifest.artifactNode, fs)
    const nodeInfo = await fs.lstat(manifest.artifactNode)
    if (!nodeInfo.isFile() || nodeInfo.isSymbolicLink()) throw new Error('安装版 runtime Node 必须是普通文件。')
    const nodeSha256 = createHash('sha256').update(await fs.readFile(manifest.artifactNode)).digest('hex')
    if (nodeSha256 !== rawManifest.runtime.nodeSha256) throw new Error('安装版 runtime Node SHA256 不匹配。')
  }
  await assertOrdinaryPath(resourcesPath, manifest.packages, fs)
  await assertOrdinaryPath(resourcesPath, manifest.postgresRoot, fs)
  if (platform === 'win32') {
    await assertInstallPathBudget({ root: manifest.runtimeRoot, platform })
    await assertInstallPathBudget({ root: manifest.packages, platform })
  }
  await verifyResourceTree(manifest.packages, '', rawManifest.resources.pythonDependencies, fs, 'Python dependencies')
  await verifyResourceTree(manifest.postgresRoot, 'pgsql', rawManifest.resources.postgresql, fs, 'PostgreSQL')
  const pgPaths = Object.fromEntries(requiredPostgresEntrypoints.map(name => {
    const entry = manifest.resources.postgresql.entrypoints.find(item => item.name === name)
    const relative = safeRelative(entry.path, 'PostgreSQL entrypoint')
    return [name, path.resolve(path.dirname(manifest.postgresRoot), ...relative.split('/'))]
  }))
  for (const [name, file] of Object.entries(pgPaths)) {
    await assertOrdinaryPath(path.dirname(manifest.postgresRoot), file, fs)
    const entry = manifest.resources.postgresql.entrypoints.find(item => item.name === name)
    if (createHash('sha256').update(await fs.readFile(file)).digest('hex') !== entry.sha256.toLowerCase()) throw new Error('PostgreSQL entrypoint hash mismatch：' + name)
  }
  if (platform !== 'win32') throw new Error('安装版 PostgreSQL desktop bootstrap 仅支持 Windows。')
  const initialPaths = pathsFactory(env)
  const canonicalRoot = initialPaths.explicitDataRoot
    ? await ownDirectory(initialPaths.dataRoot, DATA_ROOT_MARKER, DATA_ROOT_MARKER_CONTENT)
    : undefined
  const canonicalHome = await ownHome(initialPaths.home)
  const root = canonicalRoot ?? path.dirname(canonicalHome)
  const [initialIdentity, canonicalIdentity] = await Promise.all([
    fs.stat(initialPaths.dataRoot, { bigint: true }), fs.stat(root, { bigint: true }),
  ])
  if (!initialIdentity.isDirectory() || !canonicalIdentity.isDirectory() || initialIdentity.dev === 0n || initialIdentity.ino === 0n
    || initialIdentity.dev !== canonicalIdentity.dev || initialIdentity.ino !== canonicalIdentity.ino) throw new Error('packaged data root identity mismatch')
  const paths = { ...pathsFactory({ ...env, TRADELOOM_DATA_ROOT: root }), explicitDataRoot: initialPaths.explicitDataRoot, home: canonicalHome }
  const agentsHome = await ownDirectory(paths.agentsHome, '.tradeloom-agents-owned', 'tradeloom-agents-home-v1\n')
  const workspace = await ownDirectory(paths.workspace, '.tradeloom-workspace-owned', 'tradeloom-workspace-v1\n')
  const logs = await ownDirectory(paths.logs, '.tradeloom-logs-owned', 'tradeloom-logs-v1\n')
  const startupObservationPath = await resolveOwnedStartupObservationPath(requestedStartupObservationPath, root, logs, platform, fs)
  const media = await ownDirectory(path.join(paths.dataRoot, 'media'), '.tradeloom-media-owned', 'tradeloom-media-v1\n')
  const artifacts = await ownDirectory(path.join(paths.dataRoot, 'artifacts'), '.tradeloom-artifacts-owned', 'tradeloom-artifacts-v1\n')
  for (const directory of [paths.appData, paths.localAppData, paths.xdgCache, paths.xdgConfig, paths.xdgData]) {
    await ownDirectory(directory, '.tradeloom-fallback-owned', 'tradeloom-fallback-v1\n')
  }
  const isolated = makeChildEnvironment(env, { ...paths, agentsHome }, {
    DSH_WORKSPACE: workspace, TRADELOOM_DSH_WORKSPACE: workspace,
    TRADELOOM_DSH_APP_HOME: paths.home, TEMP: paths.localAppData, TMP: paths.localAppData,
  })
  const nativeBridgeKey = (deps.createNativeBridgeKey ?? createNativeBridgeKey)()
  if (!/^[a-f0-9]{64}$/.test(nativeBridgeKey)) throw new TypeError('Native bridge key generator returned an invalid key.')
  delete isolated.PGPASSWORD
  for (const [name, expected] of Object.entries({ DSH_HOME: paths.home, DSH_AGENTS_HOME: agentsHome, DSH_WORKSPACE: workspace,
    TRADELOOM_DSH_APP_HOME: paths.home, LOCALAPPDATA: paths.localAppData })) {
    if (path.resolve(isolated[name] ?? '').toLowerCase() !== path.resolve(expected).toLowerCase()) throw new Error('无法确认安装版独立运行目录：' + name)
  }
  for (const name of Object.keys(processEnv)) delete processEnv[name]
  Object.assign(processEnv, isolated, { DSH_DESKTOP_OPEN_DEVTOOLS: '0', TRADELOOM_NATIVE_BRIDGE_KEY: nativeBridgeKey })
  if (startupObservationPath) processEnv.DSH_DESKTOP_STARTUP_LOG_PATH = startupObservationPath
  const userDataPath = path.join(paths.localAppData, 'TradeLoom', 'desktop', 'user-data')
  if (deps.acquireSingleInstanceLock) {
    const locked = await deps.acquireSingleInstanceLock(userDataPath, paths.localAppData)
    if (locked === false) return { kind: 'existing-owner' }
    if (locked !== true) throw new TypeError('Electron single-instance lock did not return a boolean.')
  }
  const candidates = (deps.networkCandidates ?? networkCandidates)(await deps.readNetworkAdapters())
  const requested = await deps.chooseNetworkAddress(candidates)
  const host = (deps.chooseAddress ?? chooseAddress)(candidates, requested)
  try {
    await (deps.assertPortsAvailable ?? (async () => {}))([[host, ports.host], ['127.0.0.1', ports.django]])
  } catch {
    throw new Error('桌面服务端口 ' + ports.host + ' 或 ' + ports.django + ' 被其他进程占用；织贸助手不会终止该进程。')
  }
  processEnv.TRADELOOM_DSH_BIND_HOST = host
  processEnv.TRADELOOM_DSH_BIND_PORT = String(ports.host)
  processEnv.DSH_DESKTOP_BIND_HOST = host
  processEnv.DSH_DESKTOP_BIND_PORT = String(ports.host)
  processEnv.TRADELOOM_DJANGO_PORT = String(ports.django)
  const shellDestination = path.join(paths.home, 'profiles', 'desktop', 'node_modules', '@tradeloom', 'dsh-business-shell')
  const profileDir = path.dirname(path.dirname(path.dirname(shellDestination)))
  const lockAddress = (deps.launcherPipeName ?? launcherPipeName)(paths.home, platform)
  let lockServer, django, postgresActive = false, postgresStartedHere = false, quitting = false, quitPromise
  const postgresRoot = path.join(paths.dataRoot, 'postgres')
  const postgresData = path.join(postgresRoot, 'data')
  const pgCtl = path.join(path.dirname(pgPaths.pg_ctl), 'pg_ctl.exe')
  const initdb = path.join(path.dirname(pgPaths.initdb), 'initdb.exe')
  const psql = path.join(path.dirname(pgPaths.psql), 'psql.exe')
  const createdb = path.join(path.dirname(pgPaths.createdb), 'createdb.exe')
  const controller = deps.runControllerFile ?? runControllerFile
  const runFile = deps.runFile ?? runCommandFile
  const connect = deps.connect
  const delay = deps.delay
  const cleanup = async ({ stopPostgres = postgresActive } = {}) => {
    if (quitting && quitPromise) return quitPromise
    quitting = true
    quitPromise = (async () => {
      const errors = []
      try { await django?.stop() } catch (error) { errors.push(error) }
      if (stopPostgres && postgresActive) {
        try {
          const result = await controller(pgCtl, ['stop', '-D', postgresData, '-m', 'fast', '-w', '-t', '30'], { cwd: paths.workspace, env: isolated, logPath: path.join(logs, 'postgres-controller.log') })
          if (result.code !== 0) throw new Error('pg_ctl stop failed (' + result.code + ').')
          postgresActive = false
        } catch (error) { errors.push(error) }
      }
      try { if (lockServer?.listening) await new Promise(resolve => lockServer.close(resolve)) } catch (error) { errors.push(error) }
      if (errors.length) throw new AggregateError(errors, '停止织贸助手专属服务失败。')
    })()
    return quitPromise
  }

  try {
    const serverFactory = deps.reserveNamedPipe ?? reserveNamedPipe
    lockServer = await serverFactory(lockAddress)
    const profileManifestPath = path.join(profileDir, 'package.json')
    const profileInfo = await fs.lstat(profileDir).then(info => info, error => {
      if (error.code === 'ENOENT') return null
      throw error
    })
    if (!profileInfo) {
      const profilesDir = path.dirname(profileDir)
      await fs.mkdir(profilesDir, { recursive: true })
      await assertOrdinaryPath(paths.home, profilesDir, fs)
      await initializeFreshPluginProfile({
        appPath,
        profileDir,
        resourcesPath,
        bundles: INSTALLED_PROFILE_BUNDLES,
        fs,
        initializeOfficialProfile: deps.initializeProfile ?? initializeOfficialProfile,
        seedProfile: deps.seedFreshPluginProfile ?? installFreshPluginSeed,
      })
    }
    else if (profileInfo.isSymbolicLink() || !profileInfo.isDirectory()) throw new Error('已有 desktop profile 不是普通目录；拒绝接管。')
    await assertOrdinaryPath(paths.home, profileDir, fs)
    await assertOrdinaryPath(path.dirname(path.dirname(profileDir)), profileManifestPath, fs)
    const profileManifest = JSON.parse(await fs.readFile(profileManifestPath, 'utf8'))
    if (!INSTALLED_PROFILE_BUNDLES.every((name, index) => profileManifest.dsh?.profile?.bundles?.[index] === name)) throw new Error('官方 initProfile 未生成完整 desktop profile bundle 顺序。')
    await copyBusinessShell(manifest.shell, shellDestination, verifiedShell, fs)

    await ownDirectory(postgresRoot, POSTGRES_MARKER, POSTGRES_MARKER_CONTENT)
    let dataExists = true
    try { await fs.lstat(postgresData) } catch (error) { if (error.code === 'ENOENT') dataExists = false; else throw error }
    if (!dataExists) await fs.mkdir(postgresData)
    const initialized = await verifyOwnedDataDirectory(postgresRoot, postgresData, fs)
    const secret = await readPassword(postgresRoot, postgresData, fs, deps.generatePassword ?? (() => randomBytes(32).toString('base64url')))
    const dbEnv = { ...isolated, PGPASSWORD: secret.password }
    const status = await controller(pgCtl, ['status', '-D', postgresData], { cwd: paths.workspace, env: isolated, logPath: path.join(logs, 'postgres-controller.log') })
    if (status.error) throw status.error
    if (status.code === 0) {
      await verifyOwnedPostgresListener(postgresData, ports.postgres, fs, deps)
      postgresActive = true
      if (!(await connect('127.0.0.1', ports.postgres))) throw new Error('owned PostgreSQL 未监听 127.0.0.1:' + ports.postgres + '。')
    } else {
      try { await (deps.assertPortsAvailable ?? (async () => {}))([['127.0.0.1', ports.postgres]]) }
      catch { throw new Error('数据库端口 ' + ports.postgres + ' 被其他进程占用；织贸助手不会终止该进程。') }
      if (!initialized) {
        const entries = await fs.readdir(postgresData)
        if (entries.length) throw new Error('PostgreSQL data 目录不是空目录；拒绝初始化或清空。')
        const init = await runFile(initdb, ['-D', postgresData, '-U', 'tradeloom', '-A', 'scram-sha-256', '--encoding=UTF8', '--locale=C', '--pwfile', secret.passwordPath],
          { cwd: paths.workspace, env: isolated, logPath: path.join(logs, 'postgres-initdb.log') })
        if (init.error || init.code !== 0) throw new Error('PostgreSQL initdb 失败（exit=' + (init.code ?? 'null') + '）。')
        if ((await fs.readFile(path.join(postgresData, 'PG_VERSION'), 'utf8')).trim() !== '17') throw new Error('PostgreSQL initdb 未生成版本 17 data。')
      }
      postgresActive = true
      postgresStartedHere = true
      const start = await controller(pgCtl, ['start', '-D', postgresData, '-o', '-h 127.0.0.1 -p ' + ports.postgres, '-w', '-t', '45'],
        { cwd: paths.workspace, env: isolated, logPath: path.join(logs, 'postgres-controller.log') })
      if (start.error || start.code !== 0) throw new Error('owned PostgreSQL 启动失败（exit=' + (start.code ?? 'null') + '）。')
    }
    const dbCheck = await runFile(psql, ['-h', '127.0.0.1', '-p', String(ports.postgres), '-U', 'tradeloom', '-d', 'postgres', '-tAc', "SELECT 1 FROM pg_database WHERE datname = 'tradeloom'"],
      { cwd: paths.workspace, env: dbEnv, logPath: path.join(logs, 'postgres-check.log') })
    if (dbCheck.error || dbCheck.code !== 0) throw new Error('owned PostgreSQL connection check failed (' + (dbCheck.code ?? 'null') + ').')
    if (String(dbCheck.stdout ?? '').trim() !== '1') {
      const created = await runFile(createdb, ['-h', '127.0.0.1', '-p', String(ports.postgres), '-U', 'tradeloom', 'tradeloom'],
        { cwd: paths.workspace, env: dbEnv, logPath: path.join(logs, 'postgres-createdb.log') })
      if (created.error || created.code !== 0) throw new Error('owned PostgreSQL tradeloom database creation failed (' + (created.code ?? 'null') + ').')
    }

    const djangoEnv = makeDjangoEnv(isolated, host, secret.password, { ...paths, media, artifacts }, nativeBridgeKey, ports,
      manifest.artifactNode ? { path: manifest.artifactNode, sha256: rawManifest.runtime.nodeSha256 } : undefined)
    const runPython = async djangoArgs => {
      const result = await runFile(manifest.python, pythonRunArgs(manifest.python, manifest.backend, manifest.packages, path.join(manifest.backend, 'manage.py'), djangoArgs),
        { cwd: workspace, env: djangoEnv, logPath: path.join(logs, 'django-startup.log') })
      if (result.error || result.code !== 0) throw new Error('Django ' + djangoArgs[0] + ' 失败（exit=' + (result.code ?? 'null') + '）。')
    }
    await runPython(['migrate', '--noinput'])
    const djangoArgs = pythonRunArgs(manifest.python, manifest.backend, manifest.packages, path.join(manifest.backend, 'manage.py'), ['runserver', '--noreload', '127.0.0.1:' + ports.django])
    django = (deps.startOwnedChild ?? startOwnedChild)(manifest.python, djangoArgs, { cwd: workspace, env: djangoEnv, logPath: path.join(logs, 'django-startup.log'), logLabel: 'Django' })
    await django.spawned
    await waitForListener('127.0.0.1', ports.django, django, deps.readyTimeoutMs ?? 60_000, delay, connect)
    await deps.installQuitHandler(async () => cleanup())
    if (manifest.sourceBuild.shellMode === 'source') processEnv.TRADELOOM_SOURCE_SHELL_CANDIDATE = '1'
    await deps.importMain()
    const ready = Promise.resolve().then(() => deps.waitForDesktopReady(host, ports.host, deps.readyTimeoutMs ?? 60_000)).catch(async error => {
      await cleanup().catch(() => {})
      throw error
    })
    return { packaged: true, paths: { ...paths, agentsHome, workspace, logs, media, artifacts, postgresRoot, postgresData }, hostAddress: host, ready, stop: cleanup }
  } catch (error) {
    await cleanup({ stopPostgres: postgresStartedHere }).catch(() => {})
    throw error
  }
}

export { digestInventory, verifyResourceTree, resolvePackagedPath, runCommandFile, runControllerFile, pythonRunArgs }
