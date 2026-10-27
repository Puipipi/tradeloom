import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { copyFile, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { ensureOwnedDirectory } from '../core.mjs'
import { writeDesktopBuildReceipt, patchSetDigest } from '../receipt-writer.mjs'
import { verifyDesktopBuildReceipt } from '../desktop-receipt.mjs'
import { runtimeMarkerContents, runtimeMarkerName, trustedReleaseRoot, validateOwnedRuntime } from '../prepare-profile.mjs'
import { prepareStableHostRuntime, stableHostRuntimePaths } from '../stable-host-runtime.mjs'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const lock = JSON.parse(await readFile(path.join(repoRoot, 'integrations/dsh/patches/patches.lock.json'), 'utf8'))

function within(parent, target) {
  const relative = path.relative(parent, target)
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
}

async function cleanupOwnedRuntime(runtime) {
  const resolved = path.resolve(runtime)
  if (path.dirname(resolved) !== path.resolve(trustedReleaseRoot) || !path.basename(resolved).startsWith('stable-host-fixture-')) {
    throw new Error('test cleanup refused an unexpected runtime path')
  }
  await rm(resolved, { recursive: true, force: true })
}

async function createCandidate(label, engineFiles, dataRoot, { pnpmElectronLink = false } = {}) {
  const runtime = path.join(trustedReleaseRoot, `stable-host-fixture-${label}-${randomUUID()}`)
  const desktopNodeModules = path.join(runtime, 'apps/desktop/node_modules')
  const packageRoot = pnpmElectronLink
    ? path.join(runtime, 'node_modules/.pnpm/electron@99.0.0_fixture/node_modules/electron')
    : path.join(desktopNodeModules, 'electron')
  const dist = path.join(packageRoot, 'dist')
  await mkdir(path.join(runtime, 'apps/desktop/lib'), { recursive: true })
  await mkdir(path.join(runtime, 'apps/desktop-host/lib'), { recursive: true })
  await mkdir(dist, { recursive: true })
  await writeFile(path.join(packageRoot, 'package.json'), JSON.stringify({ name: 'electron', version: '99.0.0-fixture' }), { flag: 'wx' })
  if (pnpmElectronLink) {
    await mkdir(desktopNodeModules, { recursive: true })
    await symlink(packageRoot, path.join(desktopNodeModules, 'electron'), 'junction')
  }
  await writeFile(path.join(runtime, runtimeMarkerName), runtimeMarkerContents, { flag: 'wx' })
  await writeFile(path.join(runtime, 'apps/desktop/lib/main.js'), 'fixture desktop main\n', { flag: 'wx' })
  await writeFile(path.join(runtime, 'apps/desktop-host/lib/index.js'), 'fixture desktop host\n', { flag: 'wx' })
  for (const [relative, contents] of Object.entries(engineFiles)) {
    const file = path.join(dist, ...relative.split('/'))
    await mkdir(path.dirname(file), { recursive: true })
    await writeFile(file, contents, { flag: 'wx' })
  }
  await writeDesktopBuildReceipt({
    runtimePath: runtime,
    releaseRoot: trustedReleaseRoot,
    lock,
    runtimeMarker: runtimeMarkerContents,
    validateOwnedRuntime,
    buildEvidence: {
      patchesApplied: true,
      officialBuildExitCode: 0,
      sourceCommit: lock.upstream.commit,
      patchSetSha256: patchSetDigest(lock.patches),
      builder: 'stable-host-controlled-fixture',
    },
  })
  const receipt = await verifyDesktopBuildReceipt(runtime, lock, trustedReleaseRoot)
  const managedRoot = path.join(dataRoot, stableHostRuntimePaths.stableRootName)
  return { runtime, dist, packageRoot, receipt, managedRoot }
}

async function createTestContext() {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'tradeloom-stable-host-'))
  const env = { LOCALAPPDATA: path.join(tempRoot, 'local') }
  const dataRoot = path.join(env.LOCALAPPDATA, 'TradeLoom')
  await mkdir(dataRoot, { recursive: true })
  const cleanup = async candidates => {
    for (const candidate of candidates) await cleanupOwnedRuntime(candidate.runtime)
    if (!within(path.dirname(tempRoot), tempRoot) || path.basename(tempRoot).startsWith('tradeloom-stable-host-') !== true) {
      throw new Error('test cleanup refused an unexpected temp root')
    }
    await rm(tempRoot, { recursive: true, force: true })
  }
  return { tempRoot, env, dataRoot, cleanup }
}

test('same Electron engine from two owned candidates returns the same stable executable path', async t => {
  const context = await createTestContext()
  const candidates = []
  t.after(() => context.cleanup(candidates))
  const files = { 'electron.exe': 'tiny electron fixture\n', 'resources/app.pak': 'same pak\n' }
  candidates.push(await createCandidate('a', files, context.dataRoot))
  candidates.push(await createCandidate('b', files, context.dataRoot))
  const first = await prepareStableHostRuntime({ candidateRuntime: candidates[0].runtime, validatedReceipt: candidates[0].receipt,
    managedRoot: candidates[0].managedRoot, env: context.env })
  const second = await prepareStableHostRuntime({ candidateRuntime: candidates[1].runtime, validatedReceipt: candidates[1].receipt,
    managedRoot: candidates[1].managedRoot, env: context.env })
  assert.equal(first.electronExe, second.electronExe)
  assert.equal(first.engineSha256, second.engineSha256)
  assert.equal(await readFile(first.electronExe, 'utf8'), files['electron.exe'])
  assert.deepEqual(await readFile(first.engineManifest, 'utf8').then(JSON.parse), { schemaVersion: 1, engineSha256: first.engineSha256, files: first.files })
})

test('different Electron bytes publish under a distinct explicit engine version path', async t => {
  const context = await createTestContext()
  const candidates = []
  t.after(() => context.cleanup(candidates))
  candidates.push(await createCandidate('old', { 'electron.exe': 'electron bytes v1\n' }, context.dataRoot))
  candidates.push(await createCandidate('new', { 'electron.exe': 'electron bytes v2\n' }, context.dataRoot))
  const result = await Promise.all(candidates.map(candidate => prepareStableHostRuntime({ candidateRuntime: candidate.runtime,
    validatedReceipt: candidate.receipt, managedRoot: candidate.managedRoot, env: context.env })))
  assert.notEqual(result[0].electronExe, result[1].electronExe)
  assert.notEqual(result[0].engineSha256, result[1].engineSha256)
})

test('corrupt cache, missing electron.exe, mismatched receipt, and foreign roots are rejected', async t => {
  const context = await createTestContext()
  const candidates = []
  t.after(() => context.cleanup(candidates))
  const good = await createCandidate('good', { 'electron.exe': 'trusted engine\n' }, context.dataRoot)
  const missing = await createCandidate('missing', { 'resources/app.pak': 'no exe\n' }, context.dataRoot)
  candidates.push(good, missing)
  const prepared = await prepareStableHostRuntime({ candidateRuntime: good.runtime, validatedReceipt: good.receipt,
    managedRoot: good.managedRoot, env: context.env })
  await writeFile(prepared.electronExe, 'tampered engine\n')
  await assert.rejects(prepareStableHostRuntime({ candidateRuntime: good.runtime, validatedReceipt: good.receipt,
    managedRoot: good.managedRoot, env: context.env }), /manifest 不匹配|文件与 manifest 不匹配/)
  await assert.rejects(prepareStableHostRuntime({ candidateRuntime: missing.runtime, validatedReceipt: missing.receipt,
    managedRoot: missing.managedRoot, env: context.env }), /缺少 electron\.exe/)
  await assert.rejects(prepareStableHostRuntime({ candidateRuntime: good.runtime, validatedReceipt: {},
    managedRoot: good.managedRoot, env: context.env }), /validated receipt/)
  await assert.rejects(prepareStableHostRuntime({ candidateRuntime: good.runtime, validatedReceipt: good.receipt,
    managedRoot: path.join(context.tempRoot, 'foreign'), env: context.env }), /app-owned stable-host-runtime/)
  await assert.rejects(prepareStableHostRuntime({ candidateRuntime: context.tempRoot, validatedReceipt: good.receipt,
    managedRoot: good.managedRoot, env: context.env }), /固定 TradeLoom releases 根下/)
})

test('Electron dist reparse entries are rejected', async t => {
  const context = await createTestContext()
  const candidates = []
  t.after(() => context.cleanup(candidates))
  const candidate = await createCandidate('linked', { 'electron.exe': 'fixture exe\n' }, context.dataRoot)
  candidates.push(candidate)
  const outside = path.join(context.tempRoot, 'outside')
  await mkdir(outside)
  await writeFile(path.join(outside, 'outside.dat'), 'outside')
  try { await symlink(outside, path.join(candidate.dist, 'linked-dir'), 'junction') }
  catch (error) {
    if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) return t.skip(`symlink fixture unavailable: ${error.code}`)
    throw error
  }
  await assert.rejects(prepareStableHostRuntime({ candidateRuntime: candidate.runtime, validatedReceipt: candidate.receipt,
    managedRoot: candidate.managedRoot, env: context.env }), /链接\/reparse point/)
})

test('a pnpm-style Electron package link resolves only within the approved runtime', async t => {
  const context = await createTestContext()
  const candidates = []
  t.after(() => context.cleanup(candidates))
  const linked = await createCandidate('pnpm-link', { 'electron.exe': 'managed link engine\n', 'resources/app.pak': 'fixture pak\n' },
    context.dataRoot, { pnpmElectronLink: true })
  candidates.push(linked)
  const stableRootInfo = await lstat(linked.managedRoot).then(() => 'exists', error => error.code === 'ENOENT' ? 'absent' : Promise.reject(error))
  assert.equal(stableRootInfo, 'absent')
  const plan = await import('../stable-host-runtime.mjs').then(module => module.inspectStableHostRuntimePlan({
    candidateRuntime: linked.runtime, validatedReceipt: linked.receipt,
  }))
  assert.equal(plan.electronPackageVersion, '99.0.0-fixture')
  assert.equal(plan.electronPackageRelative, 'node_modules/.pnpm/electron@99.0.0_fixture/node_modules/electron')
  assert.equal(plan.electronDistRelative.endsWith('/dist'), true)
  assert.equal(plan.fileCount, 2)
  assert.equal(plan.totalBytes, Buffer.byteLength('managed link engine\n') + Buffer.byteLength('fixture pak\n'))
  assert.match(plan.engineSha256, /^[a-f0-9]{64}$/)
  assert.equal(await lstat(linked.managedRoot).then(() => 'exists', error => error.code === 'ENOENT' ? 'absent' : Promise.reject(error)), 'absent')

  const prepared = await prepareStableHostRuntime({ candidateRuntime: linked.runtime, validatedReceipt: linked.receipt,
    managedRoot: linked.managedRoot, env: context.env })
  assert.equal(await readFile(prepared.electronExe, 'utf8'), 'managed link engine\n')
})

test('a fixed Electron package entry resolving outside the approved runtime is rejected', async t => {
  const context = await createTestContext()
  const candidates = []
  t.after(() => context.cleanup(candidates))
  const candidate = await createCandidate('external-link', { 'electron.exe': 'external engine\n' }, context.dataRoot)
  candidates.push(candidate)
  const externalPackage = path.join(context.tempRoot, 'foreign-electron')
  await rename(candidate.packageRoot, externalPackage)
  await symlink(externalPackage, candidate.packageRoot, 'junction')
  await assert.rejects(import('../stable-host-runtime.mjs').then(module => module.inspectStableHostRuntimePlan({
    candidateRuntime: candidate.runtime, validatedReceipt: candidate.receipt,
  })), /越出受控目录/)
})

test('failed file copy leaves no published engine or staging fragment', async t => {
  const context = await createTestContext()
  const candidates = []
  t.after(() => context.cleanup(candidates))
  const candidate = await createCandidate('copy-failure', { 'electron.exe': 'first file\n', 'resources/app.pak': 'second file\n' }, context.dataRoot)
  candidates.push(candidate)
  let copies = 0
  const failingCopy = async (source, target) => {
    copies += 1
    if (copies === 2) throw Object.assign(new Error('fixture copy failure'), { code: 'EIO' })
    return copyFile(source, target)
  }
  await assert.rejects(prepareStableHostRuntime({ candidateRuntime: candidate.runtime, validatedReceipt: candidate.receipt,
    managedRoot: candidate.managedRoot, env: context.env, copyFileImpl: failingCopy }), /fixture copy failure/)
  const enginesRoot = path.join(candidate.managedRoot, stableHostRuntimePaths.enginesDirectoryName)
  const entries = await readdir(enginesRoot)
  assert.equal(entries.some(name => /^[a-f0-9]{64}$/.test(name)), false)
  assert.equal(entries.some(name => name.startsWith('.electron-stage-')), false)
  assert.equal(await lstat(candidate.dist).then(info => info.isDirectory()), true)
  assert.equal(within(candidate.runtime, candidate.dist), true)
})
