import { cp, mkdir, readFile, writeFile, lstat, realpath, readdir, copyFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import os from 'node:os'
import { ensureOwnedDirectory } from './core.mjs'
import { trustedReleaseRoot, validateOwnedRuntime } from './prepare-profile.mjs'
import { BOOTSTRAP_MARKER, BOOTSTRAP_MARKER_CONTENT, MANIFEST_NAME } from './bootstrap-core.mjs'
import { verifyDesktopBuildReceipt } from './desktop-receipt.mjs'

const sourceRoot = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(sourceRoot, '../..')
const lockPath = path.join(repoRoot, 'integrations/dsh/patches/patches.lock.json')
const stageMarkerName = '.tradeloom-desktop-stage-owned'
const stageMarkerContents = 'tradeloom-desktop-stage-v1\n'
const launcherFiles = ['bootstrap-entry.mjs', 'installed-bootstrap.mjs', 'bootstrap-core.mjs', 'receipt-writer.mjs', 'core.mjs', 'prepare-profile.mjs', 'desktop-receipt.mjs']
const blockedSourceSegments = new Set(['.git', '.venv', '.pytest_cache', '__pycache__', 'tests', 'test', 'uploads', 'runtime', 'node_modules'])

function safeManifestPath(value) {
  if (typeof value !== 'string' || !value || path.isAbsolute(value) || value.includes('\\') || value.split('/').some(part => !part || part === '.' || part === '..')) {
    throw new Error('payload 文件清单包含无效相对路径。')
  }
  return value
}

async function walkOrdinaryFiles(root, prefix = '') {
  const result = []
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const relative = prefix ? prefix + '/' + entry.name : entry.name
    const full = path.join(root, entry.name)
    const info = await lstat(full)
    if (info.isSymbolicLink()) throw new Error('资源输入不能包含链接：' + relative)
    if (info.isDirectory()) result.push(...await walkOrdinaryFiles(full, relative))
    else if (info.isFile()) result.push({ path: relative, fullPath: full, bytes: info.size })
    else throw new Error('资源输入包含非普通文件：' + relative)
  }
  return result
}

async function digestFile(filePath) {
  const bytes = await readFile(filePath)
  return { bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }
}

function digestInventory(files) {
  const canonical = [...files].sort((a, b) => a.path.localeCompare(b.path, 'en')).map(item => item.path + '\0' + item.bytes + '\0' + item.sha256 + '\n').join('')
  return createHash('sha256').update(canonical, 'utf8').digest('hex')
}

function digestManifestPaths(files) {
  const canonical = [...files].sort((a, b) => a.path.localeCompare(b.path, 'en')).map(item => item.path + '\0' + item.sha256 + '\n').join('')
  return createHash('sha256').update(canonical, 'utf8').digest('hex')
}

async function verifiedPayload({ stageRoot, payloadPath, scanPath = payloadPath, scanPrefix = '', manifestPath, filesManifestPath, kind, destination, filter = () => true }) {
  if (![payloadPath, scanPath, manifestPath, filesManifestPath].every(value => typeof value === 'string' && path.isAbsolute(value))) {
    throw new Error(kind + ' payload 必须提供显式绝对路径。')
  }
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
  const fileManifest = JSON.parse(await readFile(filesManifestPath, 'utf8'))
  const scanInfo = await lstat(scanPath)
  if (scanInfo.isSymbolicLink() || !scanInfo.isDirectory() || await realpath(scanPath) !== path.resolve(scanPath)) throw new Error(kind + ' payload 根目录必须是普通目录。')
  if (!Array.isArray(fileManifest) || fileManifest.length === 0) throw new Error(kind + ' payload 文件清单为空或格式无效。')
  const listed = new Map()
  for (const item of fileManifest) {
    const name = safeManifestPath(item.path)
    if (!Number.isSafeInteger(item.bytes) || item.bytes < 0 || !/^[a-f0-9]{64}$/.test(item.sha256) || listed.has(name)) throw new Error(kind + ' payload 文件清单记录无效：' + name)
    listed.set(name, item)
  }
  const actual = await walkOrdinaryFiles(scanPath, scanPrefix)
  if (actual.length !== listed.size || actual.some(item => !listed.has(item.path))) throw new Error(kind + ' payload 实际文件树与冻结清单不一致。')
  const staged = []
  for (const item of actual) {
    const expected = listed.get(item.path)
    const digest = await digestFile(item.fullPath)
    if (digest.bytes !== expected.bytes || digest.sha256 !== expected.sha256) throw new Error(kind + ' payload 文件摘要不匹配：' + item.path)
    if (!filter(item.path)) continue
    const target = path.join(destination, ...item.path.split('/'))
    await ensureStageDirectory(stageRoot, path.dirname(target))
    await assertStageOutputFile(target)
    await copyFile(item.fullPath, target)
    staged.push({ path: item.path, ...digest })
  }
  if (!staged.length) throw new Error(kind + ' payload 过滤后没有可部署文件。')
  return { manifest, files: staged, bytes: staged.reduce((sum, item) => sum + item.bytes, 0), sha256: digestInventory(staged) }
}

async function stageBusinessBundle(stageRoot, destination) {
  const entries = ['manage.py', 'requirements-workbench.txt', 'config', 'workbench', 'data/samples']
  const files = []
  for (const sourceName of entries) {
    const source = path.join(repoRoot, sourceName)
    const info = await lstat(source)
    if (info.isSymbolicLink()) throw new Error('业务资源输入不能包含链接：' + sourceName)
    if (info.isFile()) {
      const digest = await digestFile(source)
      const target = path.join(destination, sourceName)
      await ensureStageDirectory(stageRoot, path.dirname(target))
      await assertStageOutputFile(target)
      await copyFile(source, target)
      files.push({ path: sourceName, ...digest })
      continue
    }
    for (const item of await walkOrdinaryFiles(source)) {
      const segments = item.path.split('/')
      if (segments.some(part => blockedSourceSegments.has(part.toLowerCase()) || part.toLowerCase().startsWith('.env'))) continue
      const relative = sourceName + '/' + item.path
      const digest = await digestFile(item.fullPath)
      const target = path.join(destination, relative)
      await ensureStageDirectory(stageRoot, path.dirname(target))
      await assertStageOutputFile(target)
      await copyFile(item.fullPath, target)
      files.push({ path: relative, ...digest })
    }
  }
  if (!files.some(item => item.path === 'manage.py') || !files.some(item => item.path.startsWith('config/')) || !files.some(item => item.path.startsWith('workbench/'))) {
    throw new Error('业务资源 allowlist 缺少 manage.py、config 或 workbench。')
  }
  return { root: 'resources/tradeloom/backend', files, fileCount: files.length, bytes: files.reduce((sum, item) => sum + item.bytes, 0), sha256: digestInventory(files) }
}

async function stageBusinessShell(stageRoot, destination) {
  const source = path.join(repoRoot, 'packages/tradeloom-shell')
  const packageManifest = JSON.parse(await readFile(path.join(source, 'package.json'), 'utf8'))
  if (packageManifest.name !== '@tradeloom/dsh-business-shell' || !Array.isArray(packageManifest.files)) throw new Error('织贸助手 business-shell package manifest 无效。')
  const names = ['package.json', ...packageManifest.files.map(safeManifestPath)]
  const files = []
  for (const name of names) {
    const sourceFile = path.join(source, ...name.split('/'))
    const info = await lstat(sourceFile)
    if (!info.isFile() || info.isSymbolicLink()) throw new Error('织贸助手 business-shell 文件缺失或不是普通文件：' + name)
    const digest = await digestFile(sourceFile)
    const target = path.join(destination, ...name.split('/'))
    await ensureStageDirectory(stageRoot, path.dirname(target))
    await assertStageOutputFile(target)
    await copyFile(sourceFile, target)
    files.push({ path: name, ...digest })
  }
  return { root: 'resources/tradeloom/business-shell', name: packageManifest.name, version: packageManifest.version, fileCount: files.length,
    bytes: files.reduce((sum, item) => sum + item.bytes, 0), sha256: digestInventory(files) }
}

async function stagePackagedResources({ stageRoot, resourcesDestination, pythonPayloadRoot, pythonManifestPath, pythonFilesManifestPath, postgresPayloadRoot, postgresManifestPath, postgresFilesManifestPath }) {
  const businessDestination = path.join(resourcesDestination, 'backend')
  const pythonDestination = path.join(resourcesDestination, 'python-packages')
  const postgresDestination = path.join(resourcesDestination, 'postgresql')
  const shellDestination = path.join(resourcesDestination, 'business-shell')
  await ensureStageDirectory(stageRoot, businessDestination)
  await ensureStageDirectory(stageRoot, pythonDestination)
  await ensureStageDirectory(stageRoot, postgresDestination)
  await ensureStageDirectory(stageRoot, shellDestination)
  const business = await stageBusinessBundle(stageRoot, businessDestination)
  const businessShell = await stageBusinessShell(stageRoot, shellDestination)
  const python = await verifiedPayload({ stageRoot, payloadPath: path.join(pythonPayloadRoot ?? '', 'python-packages'), manifestPath: pythonManifestPath,
    filesManifestPath: pythonFilesManifestPath, kind: 'Python dependencies', destination: pythonDestination,
    filter: name => !name.split('/').includes('__pycache__') && !name.endsWith('.pyc') })
  const pythonMeta = python.manifest
  if (pythonMeta.schemaVersion !== 1 || pythonMeta.runtime?.platform !== 'win32' || pythonMeta.runtime?.arch !== 'x64' || pythonMeta.runtime?.pythonVersion !== '3.12.14'
    || pythonMeta.backendDependencies?.sitePackagesRelativePath !== 'python-packages') throw new Error('Python dependency manifest 不是已验证的 Windows x64 CPython 3.12.14 payload。')
  if (pythonMeta.backendDependencies.sourceRequirementsSha256 !== business.files.find(item => item.path === 'requirements-workbench.txt')?.sha256) {
    throw new Error('Python dependency manifest 与 staged requirements-workbench.txt 不匹配。')
  }
  const postgres = await verifiedPayload({ stageRoot, payloadPath: postgresPayloadRoot, scanPath: path.join(postgresPayloadRoot ?? '', 'pgsql'), scanPrefix: 'pgsql', manifestPath: postgresManifestPath,
    filesManifestPath: postgresFilesManifestPath, kind: 'PostgreSQL', destination: postgresDestination,
    filter: name => name.startsWith('pgsql/') })
  const postgresMeta = postgres.manifest
  if (postgresMeta.schemaVersion !== 1 || postgresMeta.product !== 'PostgreSQL' || postgresMeta.version !== '17.11' || postgresMeta.platform !== 'win32' || postgresMeta.arch !== 'x64'
    || postgresMeta.payload?.rootRelativePath !== 'pgsql') throw new Error('PostgreSQL manifest 不是已验证的 Windows x64 PostgreSQL 17.11 payload。')
  if (postgresMeta.payload.treeSha256 !== digestManifestPaths(postgres.files)) throw new Error('PostgreSQL payload tree SHA256 与文件清单不匹配。')
  const postgresFiles = new Map(postgres.files.map(item => [item.path, item.sha256]))
  if (!Array.isArray(postgresMeta.entrypoints) || postgresMeta.entrypoints.some(item => postgresFiles.get(item.path) !== item.sha256)) {
    throw new Error('PostgreSQL manifest entrypoint 摘要与文件清单不匹配。')
  }
  return {
    business,
    businessShell,
    primaryRuntime: { root: 'resources/runtime/primary-runtime', python: 'resources/runtime/primary-runtime/dependencies/python/python.exe', version: '3.12.14', providedBy: 'official-electron-builder' },
    pythonDependencies: { root: 'resources/tradeloom/python-packages', version: pythonMeta.runtime.pythonVersion, fileCount: python.files.length, bytes: python.bytes, sha256: python.sha256,
      distributions: pythonMeta.backendDependencies.distributions.map(({ name, version }) => ({ name, version })), licenses: pythonMeta.backendDependencies.licenseFiles ?? [] },
    postgresql: { root: 'resources/tradeloom/postgresql/pgsql', version: postgresMeta.version, fileCount: postgres.files.length, bytes: postgres.bytes, sha256: postgres.sha256,
      licenses: postgresMeta.payload.licenseFiles ?? [], entrypoints: postgresMeta.entrypoints },
  }
}

function requirePrivateIPv4(value, networkInterfaces) {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(value ?? '')
  if (!match || match.slice(1).some(part => Number(part) > 255)) throw new Error('部署资料必须指定当前活动物理网卡的私有 IPv4 地址。')
  const [a, b] = match.slice(1).map(Number)
  if (!(a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168))) throw new Error('部署地址不是 RFC1918 私有 IPv4。')
  const active = Object.values(networkInterfaces()).flatMap(items => items ?? []).some(item => item.family === 'IPv4' && !item.internal && item.address === value)
  if (!active) throw new Error('部署地址当前未绑定到本机网卡。')
}

async function ordinaryProductFile(root, value, label) {
  if (!value || !path.isAbsolute(value)) throw new Error(`${label} 必须使用 TradeLoom 产品目录下的绝对路径。`)
  const target = path.resolve(value)
  const relative = path.relative(root, target)
  if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error(`${label} 必须位于 LOCALAPPDATA/TradeLoom 内。`)
  const rootInfo = await lstat(root)
  if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory() || await realpath(root) !== path.resolve(root)) {
    throw new Error('LOCALAPPDATA/TradeLoom 必须是普通物理目录。')
  }
  let current = root
  for (const part of relative.split(path.sep)) {
    current = path.join(current, part)
    const info = await lstat(current)
    if (info.isSymbolicLink()) throw new Error(`${label} 路径包含链接：${current}`)
  }
  const info = await lstat(target)
  if (!info.isFile()) throw new Error(`${label} 必须是普通文件。`)
  return target
}

async function ensureStage(stageRoot) {
  await mkdir(path.dirname(stageRoot), { recursive: true })
  await ensureOwnedDirectory(stageRoot, stageMarkerName, stageMarkerContents)
  const marker = path.join(stageRoot, stageMarkerName)
  const markerInfo = await lstat(marker)
  if (markerInfo.isSymbolicLink() || !markerInfo.isFile() || await readFile(marker, 'utf8') !== stageMarkerContents) {
    throw new Error('桌面 stage ownership 标记无效；拒绝覆盖现有目录。')
  }
  if (await realpath(stageRoot) !== path.resolve(stageRoot)) throw new Error('桌面 stage realpath 不匹配。')
}

async function ensureStageDirectory(stageRoot, target) {
  const relative = path.relative(stageRoot, target)
  if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('stage 输出目录越出受控根目录。')
  let current = stageRoot
  for (const part of relative.split(path.sep)) {
    current = path.join(current, part)
    try {
      const info = await lstat(current)
      if (info.isSymbolicLink() || !info.isDirectory()) throw new Error(`stage 目录不是普通目录：${current}`)
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
      await mkdir(current)
    }
  }
}

async function assertStageOutputFile(target) {
  try {
    const info = await lstat(target)
    if (info.isSymbolicLink() || !info.isFile()) throw new Error(`stage 输出不是普通文件：${target}`)
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
}

export async function stageDesktop({ env = process.env, mode = 'source', runtimePath, pythonPath, managePath, hostAddress, stagePath, networkInterfaces = () => os.networkInterfaces(),
  pythonPayloadRoot, pythonManifestPath, pythonFilesManifestPath, postgresPayloadRoot, postgresManifestPath, postgresFilesManifestPath } = {}) {
  if (mode !== 'source' && mode !== 'packaged') throw new Error('桌面 stage mode 仅支持 source 或 packaged。')
  if (mode === 'source' && (!runtimePath || !pythonPath || !managePath || !hostAddress)) throw new Error('部署资料不完整；需要受控 runtime、专用 Python、Django manage.py 和所选局域网地址。')
  if (!runtimePath) throw new Error('部署资料缺少受控 runtime。')
  let productRoot, targetStage
  if (mode === 'source') {
    const localAppData = env.LOCALAPPDATA
    if (!localAppData || !path.isAbsolute(localAppData)) throw new Error('LOCALAPPDATA 不可用，不能生成桌面部署 stage。')
    productRoot = path.join(path.resolve(localAppData), 'TradeLoom')
    const expectedStage = path.join(productRoot, 'staging', 'desktop')
    targetStage = path.resolve(stagePath ?? env.TRADELOOM_DESKTOP_STAGE ?? expectedStage)
    if (targetStage.toLowerCase() !== expectedStage.toLowerCase()) throw new Error('TRADELOOM_DESKTOP_STAGE 必须是 LOCALAPPDATA/TradeLoom/staging/desktop。')
    if (!pythonPath || !managePath || !hostAddress) throw new Error('部署资料不完整；需要受控 runtime、专用 Python、Django manage.py 和所选局域网地址。')
  } else {
    if (typeof stagePath !== 'string' || !path.isAbsolute(stagePath)) throw new Error('packaged stage 必须提供显式绝对输出路径。')
    targetStage = path.resolve(stagePath)
  }
  const runtime = await validateOwnedRuntime(runtimePath, trustedReleaseRoot)
  let python, manage
  if (mode === 'source') {
    python = await ordinaryProductFile(productRoot, pythonPath, '专用 Python')
    manage = await ordinaryProductFile(productRoot, managePath, 'Django manage.py')
    requirePrivateIPv4(hostAddress, networkInterfaces)
  }
  const mainPath = path.join(runtime, 'apps/desktop/lib/main.js')
  const mainInfo = await lstat(mainPath)
  if (mainInfo.isSymbolicLink() || !mainInfo.isFile()) throw new Error('受控 runtime 缺少已编译的 desktop main.js。')
  const lock = JSON.parse(await readFile(lockPath, 'utf8'))
  const receipt = await verifyDesktopBuildReceipt(runtime, lock, trustedReleaseRoot)
  await ensureStage(targetStage)
  const launcherDestination = path.join(targetStage, 'launcher')
  const resourcesDestination = path.join(targetStage, 'resources', 'tradeloom')
  await ensureStageDirectory(targetStage, launcherDestination)
  await ensureStageDirectory(targetStage, resourcesDestination)
  for (const file of launcherFiles) {
    const destination = path.join(launcherDestination, file)
    await assertStageOutputFile(destination)
    await cp(path.join(sourceRoot, file), destination, { force: true, errorOnExist: false })
  }
  const manifest = mode === 'source' ? {
    schemaVersion: 1,
    runtime: path.posix.join('runtime', 'releases', path.basename(runtime)),
    python: path.relative(productRoot, python),
    manage: path.relative(productRoot, manage),
    cwd: 'workspace',
    hostAddress,
    appMainSha256: receipt.compiledFiles['apps/desktop/lib/main.js'],
    lock,
  } : {
    schemaVersion: 2,
    deploymentMode: 'packaged',
    runtime: { root: 'resources/runtime/primary-runtime', python: 'resources/runtime/primary-runtime/dependencies/python/python.exe', version: '3.12.14', providedBy: 'official-electron-builder' },
    sourceBuild: { appMainSha256: receipt.compiledFiles['apps/desktop/lib/main.js'], lock },
    resources: await stagePackagedResources({ stageRoot: targetStage, resourcesDestination, pythonPayloadRoot, pythonManifestPath, pythonFilesManifestPath,
      postgresPayloadRoot, postgresManifestPath, postgresFilesManifestPath }),
  }
  const markerPath = path.join(resourcesDestination, BOOTSTRAP_MARKER)
  const manifestPath = path.join(resourcesDestination, MANIFEST_NAME)
  await assertStageOutputFile(markerPath)
  await assertStageOutputFile(manifestPath)
  await writeFile(markerPath, BOOTSTRAP_MARKER_CONTENT, { flag: 'w' })
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'w' })
  return { stagePath: targetStage, launcherPath: launcherDestination, resourcesPath: path.join(targetStage, 'resources'), manifest }
}

async function main() {
  let options
  if (process.argv[2] === '--mode') {
    const allowed = new Set(['--mode', '--runtime-path', '--stage-path', '--python-payload-root', '--python-manifest', '--python-files-manifest', '--postgres-payload-root', '--postgres-manifest', '--postgres-files-manifest'])
    const values = {}
    for (let index = 2; index < process.argv.length; index += 2) {
      const key = process.argv[index]
      const value = process.argv[index + 1]
      if (!allowed.has(key) || !value || values[key]) throw new Error('packaged stage 参数无效或重复：' + key)
      values[key] = value
    }
    if (values['--mode'] !== 'packaged') throw new Error('--mode 命名参数仅支持 packaged。')
    options = { mode: 'packaged', runtimePath: values['--runtime-path'], stagePath: values['--stage-path'],
      pythonPayloadRoot: values['--python-payload-root'], pythonManifestPath: values['--python-manifest'], pythonFilesManifestPath: values['--python-files-manifest'],
      postgresPayloadRoot: values['--postgres-payload-root'], postgresManifestPath: values['--postgres-manifest'], postgresFilesManifestPath: values['--postgres-files-manifest'] }
  } else {
    options = { runtimePath: process.argv[2], pythonPath: process.argv[3], managePath: process.argv[4], hostAddress: process.argv[5] }
  }
  const result = await stageDesktop(options)
  process.stdout.write(`TradeLoom desktop stage 已生成：${result.stagePath}\n`)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { process.stderr.write(`无法生成桌面 stage：${error.message}\n`); process.exitCode = 1 })
}
